// Round 218 — the Cost module (owner, 20 Oct 2026; mock-up "Monthly Cost
// Dashboard", revised the same day for v10.49). Three pages:
//
//   Cost dashboard — where each m³ of sale goes: material, fuel, maintenance,
//                    manpower; raw material purchase vs consumption; recipe
//                    vs actual; grade-wise contribution; diesel; fuel by
//                    consumer; maintenance by vehicle; manpower.
//   Profit & Loss  — a month, a quarter or the year to date.
//   Balance Sheet  — as on a month end.
//
// Every figure the app already records is worked out here, LIVE, from the
// module that owns it, using that module's own rules, so the Cost pages can
// never disagree with the screens the figures come from:
//
//   Sales           tax invoices (one per delivery note). Rates are typed incl.
//                   GST, so the sale is total × 100 / 118 when GST is on the
//                   invoice, and the total itself when the Accountant switched
//                   GST off. Quantity = delivered m³ less what site QC
//                   rejected (lib/dashboardKpis.js's definition).
//   Raw material    plant consumption (load cells + operator entries +
//                   transfers; hand-keyed before the cutover) × that month's
//                   weighted-average landed rate — the Material module's
//                   own figures (routes/materialModule.js).
//   Fuel            Fuel module: tank issues at their cost, outside-station
//                   fills (bought and issued at once), adjustments down
//                   counted as issued (Round 217).
//   Maintenance     Maintenance module: parts issued, outside repairs at their
//                   final amount (month returned), lubricants on the
//                   general-works cards, tyres and batteries not bought
//                   through the store (month first fitted), retreads.
//   Manpower        HR payroll (cost to company) for staff; contract labour
//                   from the approved contractor bill, or, until it is
//                   approved, from payroll / the closed gang months.
//   Road tax and    certificate fees (Maintenance → Certificates) spread over
//   insurance       the days each certificate covers (owner, 20 Oct 2026:
//                   road tax is paid quarterly, insurance yearly). The part
//                   not yet used is prepaid on the Balance Sheet.
//
// What the app does NOT record — power bill, rent, depreciation, interest,
// tax, capital, loans, fixed assets, bank — is keyed in by Accounts
// (cost_month_entries / cost_balances, lib/round218Schema.js). A month line
// not entered counts as 0, and the P&L lists it by name so profit is never
// read as higher than it is.
//
// Per-m³ figures are on SALES quantity. All amounts exclude GST.
import { query } from "../db.js";
import { istMonth, istDay } from "./istDate.js";
import { consumptionByMaterialMonthRange, firstOfNextMonth, productionM3Range } from "./plantConsumption.js";
import { loadKept } from "./plantLoadReview.js";
import { buildLedgers } from "./supplierLedger.js";
import { buildTransporterLedgers } from "./transporterLedger.js";
import { AGE_GROUPS, ageGroup } from "./receivables.js";
import { tankSummary } from "../routes/fuelModule.js";
import { bookStockRows } from "../routes/materialModule.js";
import { bankHeadsMonth, bankBalancesOn } from "./bankBook.js";
import { clTicketSales, clOtherIncomeMonth, clExpenseHeadsMonth } from "./cLedger.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const GST_FACTOR = 100 / 118;

// ------------------------------------------------------------ months ----
export const MONTH_RE = /^\d{4}-\d{2}$/;
const pad = (x) => String(x).padStart(2, "0");

export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
export function monthBounds(ym) {
  const [y, m] = ym.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = `${ym}-01`;
  return { from, toEx: firstOfNextMonth(from), end: `${ym}-${pad(days)}`, days };
}
// Financial year April–March.
export function fyStart(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${m >= 4 ? y : y - 1}-04`;
}
export function monthsFrom(a, b) {
  const out = [];
  for (let ym = a; ym <= b; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}
export function monthLabel(ym, long = false) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-IN", { month: long ? "long" : "short", year: "numeric", timeZone: "UTC" });
}
function dayDiff(a, b) { // whole days from a to b (YYYY-MM-DD)
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function minDay(a, b) { return a < b ? a : b; }
function maxDay(a, b) { return a > b ? a : b; }

// --------------------------------------------------- what Accounts enters ---
export const PL_ENTERED = [
  { key: "other_income", label: "Other income", section: "revenue", hint: "scrap sale, interest received" },
  { key: "power", label: "Plant power (electricity)", section: "direct" },
  { key: "hired_vehicles", label: "Hired vehicles & pumps", section: "direct" },
  { key: "admin_office", label: "Admin & office", section: "overheads" },
  { key: "selling", label: "Selling & marketing", section: "overheads", hint: "sales incentive is in salaries" },
  { key: "rent_rates", label: "Rent & rates", section: "overheads" },
  { key: "depreciation", label: "Depreciation", section: "below", hint: "from the fixed-asset register" },
  { key: "interest", label: "Finance cost (interest)", section: "below", hint: "term & vehicle loans, cash credit" },
  { key: "tax", label: "Tax provision", section: "tax", hint: "on the month's profit before tax" },
];
export const PL_ENTERED_KEYS = new Set(PL_ENTERED.map((e) => e.key));

export const BS_ENTERED = [
  { key: "capital", label: "Capital", side: "liab", group: "owners" },
  { key: "retained_opening", label: "Retained profit at the start", side: "liab", group: "owners",
    hint: "profit kept up to this date — profit after it comes from the Profit & Loss" },
  { key: "term_loans", label: "Term & vehicle loans", side: "liab", group: "loans" },
  { key: "cash_credit", label: "Cash credit (bank overdraft)", side: "liab", group: "loans" },
  { key: "other_creditors", label: "Other creditors", side: "liab", group: "current", hint: "power, rent, services, fuel stations" },
  { key: "gst_tds_payable", label: "GST, TDS, PF/ESI payable", side: "liab", group: "current", hint: "incl. TDS on contractor bills" },
  { key: "fixed_assets", label: "Plant, transit mixers, pumps, buildings", side: "asset", group: "fixed",
    hint: "net of depreciation · fixed-asset register" },
  { key: "deposits_prepaid", label: "Deposits & other prepaid", side: "asset", group: "current" },
  { key: "gst_input", label: "GST input credit", side: "asset", group: "current" },
  { key: "cash_bank", label: "Cash & bank", side: "asset", group: "current", hint: "from bank reconciliation" },
];
export const BS_ENTERED_KEYS = new Set(BS_ENTERED.map((e) => e.key));

export async function monthEntries(ym) {
  const { rows } = await query(
    `SELECT e.line_key, e.amount, e.note, e.entered_at, u.name AS entered_by_name
       FROM cost_month_entries e LEFT JOIN users u ON u.id = e.entered_by WHERE e.month = $1`, [ym]);
  const out = {};
  for (const r of rows) out[r.line_key] = { amount: Number(r.amount), note: r.note, at: r.entered_at, by: r.entered_by_name };
  return out;
}

// The figure in force on a day: the latest entry on or before it.
export async function balancesOn(day) {
  const { rows } = await query(
    `SELECT DISTINCT ON (line_key) line_key, as_on::text AS as_on, amount, note
       FROM cost_balances WHERE as_on <= $1::date ORDER BY line_key, as_on DESC`, [day]);
  return Object.fromEntries(rows.map((r) => [r.line_key, { amount: Number(r.amount), as_on: r.as_on, note: r.note }]));
}

// ------------------------------------------------------- per-request book ---
// Everything read once per request: material rates, certificates, and a cache
// of each month already worked out.
export async function newContext() {
  const [rates, mats, certs, rateHist] = await Promise.all([
    query(`SELECT o.material_id, to_char(r.received_date, 'YYYY-MM') AS ym,
                  SUM(r.accepted_qty_kg * r.landed_rate_per_kg) AS v, SUM(r.accepted_qty_kg) AS q
             FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
            WHERE r.landed_rate_per_kg IS NOT NULL AND r.accepted_qty_kg > 0 GROUP BY 1, 2`),
    query(`SELECT id, name, category, mix_component, opening_stock_rate_per_kg, is_active FROM rm_materials`),
    query(`SELECT c.id, c.cert_type, c.label, c.fee, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to,
                  (c.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS made_on, c.status, a.name AS asset_name
             FROM mnt_certificates c LEFT JOIN mnt_assets a ON a.id = c.asset_id
            WHERE c.fee > 0 AND c.status <> 'retired'`)
      // Round 235 — a fee paid from a bank line counts from the day it was paid.
      .then((r) => query(`SELECT id, paid_on::text AS paid_on FROM mnt_certificates WHERE paid_on IS NOT NULL`)
        .then((p) => { const m = new Map(p.rows.map((x) => [x.id, x.paid_on])); for (const c of r.rows) if (m.has(c.id)) c.made_on = m.get(c.id); return r; })
        .catch(() => r))
      .catch(() => ({ rows: [] })),
    query(`SELECT rate_per_liter, (effective_from AT TIME ZONE 'Asia/Kolkata')::date::text AS from_day
             FROM fuel_rate_history ORDER BY effective_from`).catch(() => ({ rows: [] })),
  ]);
  const rateMap = new Map();
  for (const r of rates.rows) {
    if (!rateMap.has(r.material_id)) rateMap.set(r.material_id, new Map());
    if (Number(r.q) > 0) rateMap.get(r.material_id).set(r.ym, Number(r.v) / Number(r.q));
  }
  const matById = new Map(mats.rows.map((m) => [m.id, m]));
  const { rows: fuelItem } = await query(`SELECT rate_per_liter FROM store_stock_items WHERE item_type = 'fuel' ORDER BY id LIMIT 1`).catch(() => ({ rows: [] }));
  return {
    cache: new Map(),
    matById,
    // The Material module's rule: the month's own weighted average, else the
    // last earlier month's, else the material's opening rate.
    rmRate(materialId, ym) {
      const m = rateMap.get(materialId);
      if (m?.has(ym)) return m.get(ym);
      let cand = null;
      if (m) for (const k of [...m.keys()].sort()) { if (k <= ym) cand = m.get(k); else break; }
      if (cand != null) return cand;
      const mat = matById.get(materialId);
      return mat?.opening_stock_rate_per_kg != null ? Number(mat.opening_stock_rate_per_kg) : null;
    },
    certs: certs.rows.map((c) => {
      const start = c.valid_from && c.valid_from <= c.valid_to ? c.valid_from : minDay(c.made_on, c.valid_to);
      return { ...c, fee: Number(c.fee), start, days: dayDiff(start, c.valid_to) + 1 };
    }),
    dieselRate(day) {
      let rate = null;
      for (const r of rateHist.rows) if (r.from_day <= day) rate = Number(r.rate_per_liter);
      if (rate == null && rateHist.rows[0]) rate = Number(rateHist.rows[0].rate_per_liter);
      return rate ?? (fuelItem[0] ? Number(fuelItem[0].rate_per_liter) || null : null);
    },
  };
}

// --------------------------------------------------------------- sales ---
async function salesTickets(from, toEx) {
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_date::text AS day, dt.truck_id, dt.pump_id, co.pump_requirement::text AS pump_requirement,
            dt.loaded_quantity_m3 AS loaded, COALESCE(sq.rejected_quantity_m3, 0) AS rejected,
            g.name AS grade, COALESCE(md.id, std.id) AS md_id,
            COALESCE(md.design_ref_code, std.design_ref_code) AS design_ref, COALESCE(md.revision, std.revision) AS revision,
            COALESCE(md.mix_description, std.mix_description) AS mix_description,
            i.id AS invoice_id, i.concrete_amount, i.pumping_charge, i.part_load_charge, i.waiting_charge, i.total_amount, i.gst_applied
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       LEFT JOIN mix_grades g ON g.id = co.mix_grade_id
       LEFT JOIN mix_designs md ON md.id = co.resolved_mix_design_id
       LEFT JOIN LATERAL (SELECT d.* FROM mix_designs d WHERE md.id IS NULL AND d.mix_grade_id = co.mix_grade_id
                            AND d.is_standard_for_grade AND d.status = 'approved' ORDER BY d.id LIMIT 1) std ON true
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       LEFT JOIN invoices i ON i.ticket_id = dt.id
      WHERE dt.ticket_date >= $1::date AND dt.ticket_date < $2::date
        AND dt.status <> 'cancelled' AND dt.loaded_quantity_m3 IS NOT NULL`,
    [from, toEx]);
  return rows.map((r) => {
    const f = r.invoice_id && r.gst_applied !== false ? GST_FACTOR : 1;
    return {
      ...r,
      net: Math.max(0, n0(r.loaded) - n0(r.rejected)),
      rejected: n0(r.rejected),
      concrete: r.invoice_id ? n0(r.concrete_amount) * f : 0,
      pumping: r.invoice_id ? n0(r.pumping_charge) * f : 0,
      part_load: r.invoice_id ? (n0(r.part_load_charge) + n0(r.waiting_charge)) * f : 0,
      gross: r.invoice_id ? n0(r.total_amount) : 0,
      pumped: ["boom_pump", "line_pump"].includes(r.pump_requirement),
    };
  });
}

function salesSummary(tickets) {
  const s = { qty: 0, loads: tickets.length, invoiced_m3: 0, concrete: 0, pumping: 0, part_load: 0, gross: 0,
    pumped_m3: 0, rejected_m3: 0, held_loads: 0, held_m3: 0 };
  for (const t of tickets) {
    s.qty += t.net; s.rejected_m3 += t.rejected;
    if (t.pumped) s.pumped_m3 += t.net;
    if (t.invoice_id) { s.invoiced_m3 += t.net; s.concrete += t.concrete; s.pumping += t.pumping; s.part_load += t.part_load; s.gross += t.gross; }
    else { s.held_loads += 1; s.held_m3 += t.net; }
  }
  for (const k of Object.keys(s)) s[k] = r2(s[k]);
  s.realisation = s.invoiced_m3 > 0 ? r2(s.concrete / s.invoiced_m3) : null;
  return s;
}

// ------------------------------------------------------- raw material ---
async function rawMaterial(ym, ctx) {
  const { from, toEx } = monthBounds(ym);
  const [cons, purch] = await Promise.all([
    consumptionByMaterialMonthRange({ from, toExclusive: toEx }),
    query(`SELECT o.material_id, SUM(r.accepted_qty_kg) AS kg, SUM(r.accepted_qty_kg * COALESCE(r.landed_rate_per_kg, 0)) AS value
             FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
            WHERE r.received_date >= $1::date AND r.received_date < $2::date GROUP BY 1`, [from, toEx]),
  ]);
  const by = new Map();
  const row = (id) => {
    if (!by.has(id)) {
      const m = ctx.matById.get(id) || {};
      by.set(id, { material_id: id, name: m.name || `Material ${id}`, mix_component: m.mix_component || null,
        category: m.category || null, purchase_kg: 0, purchase: 0, consumed_kg: 0, consumed: 0, rate: ctx.rmRate(id, ym), no_rate: false });
    }
    return by.get(id);
  };
  for (const c of cons) {
    const r = row(c.material_id);
    r.consumed_kg += c.kg;
    if (r.rate == null) r.no_rate = true; else r.consumed += c.kg * r.rate;
  }
  for (const p of purch.rows) { const r = row(p.material_id); r.purchase_kg += n0(p.kg); r.purchase += n0(p.value); }
  const list = [...by.values()].filter((r) => Math.abs(r.consumed_kg) > 0.001 || r.purchase_kg > 0.001)
    .map((r) => ({ ...r, purchase: r2(r.purchase), consumed: r2(r.consumed), purchase_kg: r2(r.purchase_kg), consumed_kg: r2(r.consumed_kg) }))
    .sort((a, b) => b.consumed - a.consumed);
  return {
    materials: list,
    consumed: r2(list.reduce((t, r) => t + r.consumed, 0)),
    purchased: r2(list.reduce((t, r) => t + r.purchase, 0)),
    no_rate: list.filter((r) => r.no_rate).map((r) => r.name),
  };
}

// ---------------------------------------------------------------- fuel ---
const FUEL_KINDS = {
  truck: { label: "Transit mixers & trucks", order: 1 },
  pump: { label: "Concrete pumps", order: 2 },
  generator: { label: "DG set", order: 3 },
  batching_plant: { label: "Batching plant", order: 4 },
  loader: { label: "Loader", order: 5 },
  pickup_van: { label: "Pick-ups", order: 6 },
  other: { label: "Other machines", order: 7 },
};
async function fuelByConsumer(from, toEx, rate) {
  const { rows } = await query(
    `SELECT CASE WHEN sr.truck_id IS NOT NULL THEN 'truck' WHEN sr.pump_id IS NOT NULL THEN 'pump'
                 ELSE COALESCE(e.equipment_type::text, sr.equipment_type::text, 'other') END AS kind,
            SUM(sr.actual_quantity_issued) AS litres,
            SUM(COALESCE(sr.fuel_cost, sr.actual_quantity_issued * $3)) AS value,
            SUM(sr.actual_quantity_issued) FILTER (
              WHERE NOT COALESCE(fs.is_plant, false)
                AND NOT EXISTS (SELECT 1 FROM store_stock_transactions x WHERE x.reference_type = 'supply_request' AND x.reference_id = sr.id)
            ) AS outside_litres,
            COUNT(DISTINCT COALESCE(sr.truck_id, sr.pump_id, sr.equipment_id)) AS units
       FROM supply_requests sr
       LEFT JOIN equipment e ON e.id = sr.equipment_id
       LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
      WHERE sr.request_type = 'fuel' AND sr.status = 'issued' AND sr.actual_quantity_issued > 0
        AND sr.issued_at::date >= $1::date AND sr.issued_at::date < $2::date
      GROUP BY 1`,
    [from, toEx, rate || 0]);
  return rows.map((r) => ({ kind: FUEL_KINDS[r.kind] ? r.kind : "other", litres: n0(r.litres), value: n0(r.value),
    outside_litres: n0(r.outside_litres), units: Number(r.units) || 0 }));
}

async function fuelMonth(ym, ctx) {
  const { from, toEx, end } = monthBounds(ym);
  const rate = ctx.dieselRate(end);
  const [tank, consumers] = await Promise.all([tankSummary(from, end), fuelByConsumer(from, toEx, rate)]);
  const adjValue = r2(tank.adj_out * (rate || 0));
  const issuedValue = r2(consumers.reduce((t, c) => t + c.value, 0) + adjValue);
  return { tank, consumers, rate, adj_value: adjValue, issued_value: issuedValue,
    bought_value: r2(tank.purchased_value), issued_litres: r2(consumers.reduce((t, c) => t + c.litres, 0) + tank.adj_out) };
}

// --------------------------------------------------------- maintenance ---
const MNT_KINDS = { parts: "Parts issued", outside: "Outside repairs", lubricant: "Lubricants", tyres: "Tyres & batteries" };
async function maintenanceRows(from, toEx) {
  const { rows } = await query(
    `WITH x AS (
       SELECT COALESCE(t.asset_id, j.asset_id) AS asset_id, t.job_card_id, 'parts' AS kind, ABS(t.value) AS amt
         FROM mnt_store_txns t LEFT JOIN mnt_job_cards j ON j.id = t.job_card_id
        WHERE t.txn_type = 'issue' AND t.created_at::date >= $1::date AND t.created_at::date < $2::date
       UNION ALL
       SELECT o.asset_id, o.job_card_id, 'outside', o.final_amount FROM mnt_outside_repairs o
        WHERE o.final_amount IS NOT NULL AND o.returned_at::date >= $1::date AND o.returned_at::date < $2::date
       UNION ALL
       SELECT c.asset_id, c.job_card_id, 'lubricant', c.amount FROM mnt_card_charges c
        WHERE c.amount IS NOT NULL AND c.charged_at::date >= $1::date AND c.charged_at::date < $2::date
       UNION ALL
       SELECT m.asset_id, m.job_card_id, 'tyres', ty.cost FROM mnt_tb_moves m
         JOIN mnt_tyres ty ON m.kind = 'tyre' AND ty.id = m.item_id
        WHERE m.action = 'fit' AND ty.store_txn_id IS NULL AND ty.cost > 0
          AND m.id = (SELECT MIN(id) FROM mnt_tb_moves z WHERE z.kind = 'tyre' AND z.item_id = ty.id AND z.action = 'fit')
          AND m.created_at::date >= $1::date AND m.created_at::date < $2::date
       UNION ALL
       SELECT m.asset_id, m.job_card_id, 'tyres', b.cost FROM mnt_tb_moves m
         JOIN mnt_batteries b ON m.kind = 'battery' AND b.id = m.item_id
        WHERE m.action = 'fit' AND b.store_txn_id IS NULL AND b.cost > 0
          AND m.id = (SELECT MIN(id) FROM mnt_tb_moves z WHERE z.kind = 'battery' AND z.item_id = b.id AND z.action = 'fit')
          AND m.created_at::date >= $1::date AND m.created_at::date < $2::date
       UNION ALL
       SELECT NULL, NULL, 'tyres', m.amount FROM mnt_tb_moves m
        WHERE m.kind = 'tyre' AND m.action = 'retread_back' AND m.amount > 0
          AND m.created_at::date >= $1::date AND m.created_at::date < $2::date
     )
     SELECT x.asset_id, a.name AS asset_name, a.asset_group, a.truck_id, a.pump_id, mo.name AS model_name,
            x.kind, SUM(x.amt) AS amount, array_remove(array_agg(DISTINCT x.job_card_id), NULL) AS cards
       FROM x LEFT JOIN mnt_assets a ON a.id = x.asset_id LEFT JOIN mnt_models mo ON mo.id = a.model_id
      GROUP BY x.asset_id, a.name, a.asset_group, a.truck_id, a.pump_id, mo.name, x.kind`,
    [from, toEx]).catch((e) => { console.error("cost: maintenance", e.message); return { rows: [] }; });
  return rows.map((r) => ({ ...r, amount: n0(r.amount), cards: (r.cards || []).map(Number) }));
}
function maintenanceTotals(rows) {
  const t = { parts: 0, outside: 0, lubricant: 0, tyres: 0 };
  for (const r of rows) t[r.kind] += r.amount;
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  t.total = r2(t.parts + t.outside + t.lubricant + t.tyres);
  return t;
}

// ------------------------------------------------------------ manpower ---
async function manpower(ym) {
  const [lines, bills, gangMonths, gangs, deductions] = await Promise.all([
    query(`SELECT l.employee_id, l.cost_to_company, l.calc, r.status, e.employment_type, e.contractor_id
             FROM hr_payroll_lines l JOIN hr_payroll_runs r ON r.month = l.month JOIN hr_employees e ON e.id = l.employee_id
            WHERE l.month = $1`, [ym]).catch(() => ({ rows: [] })),
    query(`SELECT contractor_id, gangs_amount, individual_amount, status FROM hr_contractor_bills WHERE month = $1`, [ym]).catch(() => ({ rows: [] })),
    query(`SELECT gm.gang_id, gm.amount, g.contractor_id FROM hr_gang_months gm JOIN hr_gangs g ON g.id = gm.gang_id WHERE gm.month = $1`, [ym]).catch(() => ({ rows: [] })),
    query(`SELECT COUNT(DISTINCT g.id)::int AS n FROM hr_gangs g JOIN hr_gang_members m ON m.gang_id = g.id
            WHERE m.from_date <= ($1 || '-01')::date + interval '1 month' - interval '1 day' AND (m.to_date IS NULL OR m.to_date >= ($1 || '-01')::date)`, [ym]).catch(() => ({ rows: [{ n: 0 }] })),
    query(`SELECT COALESCE(SUM(days), 0) AS days FROM hr_gang_deductions WHERE month = $1`, [ym]).catch(() => ({ rows: [{ days: 0 }] })),
  ]);
  const billBy = new Map(bills.rows.map((b) => [b.contractor_id, b]));
  const m = { staff: 0, incentive: 0, trip: 0, overtime: 0, employer: 0, gangs: 0, contract: 0, staff_count: 0, contract_count: 0,
    payroll_status: lines.rows.length ? (lines.rows.every((l) => l.status === "locked") ? "locked" : "draft") : "none",
    gangs_active: gangs.rows[0]?.n || 0, gang_months_closed: gangMonths.rows.length,
    bills_approved: bills.rows.filter((b) => b.status === "approved").length, bills_draft: bills.rows.filter((b) => b.status !== "approved").length,
    deduction_days: n0(deductions.rows[0]?.days) };
  const approved = (cid) => billBy.get(cid)?.status === "approved";
  for (const l of lines.rows) {
    const c = l.calc || {};
    if (!c.contract && l.employment_type !== "contract") {
      m.staff += n0(l.cost_to_company); m.staff_count += 1;
      m.incentive += n0(c.incentive); m.trip += n0(c.trip_allowance); m.overtime += n0(c.ot_amount);
      m.employer += n0(c.pf_employer) + n0(c.esi_employer) + n0(c.bonus_provision) + n0(c.gratuity_provision);
    } else {
      m.contract_count += 1;
      if (!(l.contractor_id && approved(l.contractor_id))) m.contract += n0(l.cost_to_company);
    }
  }
  for (const b of bills.rows) {
    if (b.status !== "approved") continue;
    m.gangs += n0(b.gangs_amount);
    m.contract += n0(b.individual_amount);
  }
  for (const g of gangMonths.rows) if (!approved(g.contractor_id)) m.gangs += n0(g.amount);
  for (const k of ["staff", "incentive", "trip", "overtime", "employer", "gangs", "contract"]) m[k] = r2(m[k]);
  m.total = r2(m.staff + m.gangs + m.contract);
  return m;
}

// --------------------------------------------- road tax and insurance ---
// A fee is spread evenly over the days its certificate covers.
function certBucket(c) { return c.cert_type === "road_tax" ? "road_tax" : c.cert_type === "insurance" ? "insurance" : "other_certs"; }
function certExpense(ctx, from, end) {
  const out = { road_tax: 0, insurance: 0, other_certs: 0 };
  for (const c of ctx.certs) {
    const a = maxDay(c.start, from), b = minDay(c.valid_to, end);
    if (a > b) continue;
    out[certBucket(c)] += (c.fee * (dayDiff(a, b) + 1)) / c.days;
  }
  for (const k of Object.keys(out)) out[k] = r2(out[k]);
  return out;
}
function certPrepaid(ctx, day) {
  let total = 0, count = 0;
  for (const c of ctx.certs) {
    if (c.made_on > day) continue;              // not paid / recorded yet
    if (c.valid_to <= day) continue;            // fully used
    const unusedFrom = maxDay(c.start, nextDayStr(day));
    const unused = dayDiff(unusedFrom, c.valid_to) + 1;
    if (unused <= 0) continue;
    total += (c.fee * Math.min(unused, c.days)) / c.days; count += 1;
  }
  return { amount: r2(total), count };
}
function nextDayStr(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// ----------------------------------------------------------- one month ---
// The P&L figures of one month, cached per request.
export function monthCore(ym, ctx) {
  if (!ctx.cache.has(ym)) ctx.cache.set(ym, computeMonth(ym, ctx));
  return ctx.cache.get(ym);
}
async function computeMonth(ym, ctx) {
  const { from, toEx, end } = monthBounds(ym);
  const [tickets, rm, fuel, mntRows, man, entries, bank, clIncome, clHeads] = await Promise.all([
    salesTickets(from, toEx), rawMaterial(ym, ctx), fuelMonth(ym, ctx), maintenanceRows(from, toEx), manpower(ym), monthEntries(ym),
    bankHeadsMonth(ym), clOtherIncomeMonth(ym), clExpenseHeadsMonth(ym),
  ]);
  // Round 224 — C Ledger. A delivery note tied to a C Ledger record takes its
  // sale value from that record (in place of the invoice, so it is counted
  // once). A record with no delivery note is not a sale (Round 227, owner: it
  // is only a collection). No separate line or mark anywhere (owner).
  const clSales = await clTicketSales(tickets.map((t) => t.id));
  for (const t of tickets) {
    const c = clSales.get(t.id);
    if (!c) continue;
    t.invoice_id = t.invoice_id || `c${t.id}`;
    t.concrete = c.concrete; t.pumping = c.pumping; t.part_load = 0; t.gross = c.gross;
  }
  const sales = salesSummary(tickets);
  const mnt = maintenanceTotals(mntRows);
  const certs = certExpense(ctx, from, end);
  const e = (k) => (entries[k] ? entries[k].amount : 0);
  const a = {
    concrete: sales.concrete, pumping: sales.pumping, part_load: sales.part_load, other_income: e("other_income"),
    rm: rm.consumed, fuel: fuel.issued_value, power: e("power"), repairs: mnt.total, hired_vehicles: e("hired_vehicles"),
    salaries: man.staff, contract_labour: r2(man.gangs + man.contract), admin_office: e("admin_office"), selling: e("selling"),
    road_tax: certs.road_tax, insurance: certs.insurance, other_certs: certs.other_certs, rent_rates: e("rent_rates"),
    depreciation: e("depreciation"), interest: e("interest"), tax: e("tax"),
  };
  // Round 223 — bank statement lines given a cost head are ADDED to that head
  // (a payment the app does not record, e.g. a repair paid outside a job card).
  for (const [k, v] of Object.entries(bank.heads)) if (k in a) a[k] = r2(a[k] + v);
  // Round 224 — C Ledger expenses, added straight into the head of their category.
  for (const [k, v] of Object.entries(clHeads)) if (k in a) a[k] = r2(a[k] + v);
  // Round 227 — C Ledger other income (scrap, used oil …).
  if (clIncome) a.other_income = r2(a.other_income + clIncome);
  return { ym, sales, tickets, rm, fuel, mntRows, mnt, man, certs, entries, bank: bank.heads, amounts: withTotals(a) };
}

export function withTotals(a) {
  const t = { ...a };
  t.revenue = r2(a.concrete + a.pumping + a.part_load + a.other_income);
  t.direct = r2(a.rm + a.fuel + a.power + a.repairs + a.hired_vehicles);
  t.gross = r2(t.revenue - t.direct);
  t.overheads = r2(a.salaries + a.contract_labour + a.admin_office + a.selling + a.road_tax + a.insurance + a.other_certs + a.rent_rates);
  t.ebitda = r2(t.gross - t.overheads);
  t.pbt = r2(t.ebitda - a.depreciation - a.interest);
  t.pat = r2(t.pbt - a.tax);
  return t;
}
function sumAmounts(list) {
  const out = {};
  for (const a of list) for (const [k, v] of Object.entries(a)) out[k] = r2((out[k] || 0) + v);
  return out;
}

// ======================================================== COST DASHBOARD ===
export async function costDashboard(ym) {
  const ctx = await newContext();
  const prev = addMonths(ym, -1);
  const [cur, pm] = await Promise.all([monthCore(ym, ctx), monthCore(prev, ctx)]);
  const { from, toEx } = monthBounds(ym);
  const qty = cur.sales.qty;
  const per = (v, q = qty) => (q > 0 ? Math.round(v / q) : null);
  const a = cur.amounts;

  // 6-month trend
  const trendMonths = monthsFrom(addMonths(ym, -5), ym);
  const trend = [];
  for (const m of trendMonths) {
    const c = await monthCore(m, ctx);
    const q = c.sales.qty;
    trend.push({ month: m, label: monthLabel(m).split(" ")[0], qty: q, realisation: c.sales.realisation,
      rm: per(c.amounts.rm, q), fuel: per(c.amounts.fuel, q), contribution: per(c.amounts.concrete - c.amounts.rm - c.amounts.fuel, q) });
  }

  // Raw material table, with last month's consumption ₹/m³ beside it.
  const prevBy = new Map(pm.rm.materials.map((r) => [r.material_id, r]));
  const rmRows = cur.rm.materials.map((r) => {
    const p = prevBy.get(r.material_id);
    return { ...r, purchase_m3: per(r.purchase), consumed_m3: per(r.consumed),
      prev_m3: p ? per(p.consumed, pm.sales.qty) : null, stock_change: r2(r.purchase - r.consumed) };
  });

  // Recipe vs actual: MCI370's design kg/m³ × batch size, against the load cells.
  const { rows: rva } = await query(
    `SELECT pm.material_id, SUM(pm.design_kg_per_m3 * pb.batch_qty_m3) AS recipe_kg, SUM(pm.actual_kg) AS actual_kg
       FROM plant_batch_materials pm JOIN plant_batches pb ON pb.id = pm.batch_id
      WHERE pb.batch_date >= $1::date AND pb.batch_date < $2::date AND pm.material_id IS NOT NULL
        AND pm.design_kg_per_m3 IS NOT NULL AND pm.actual_kg IS NOT NULL
      GROUP BY 1`, [from, toEx]).catch(() => ({ rows: [] }));
  const recipe = rva.map((r) => {
    const m = ctx.matById.get(r.material_id) || {};
    const rate = ctx.rmRate(r.material_id, ym);
    const diff = n0(r.actual_kg) - n0(r.recipe_kg);
    return { material_id: r.material_id, name: m.name || `Material ${r.material_id}`, recipe_kg: r2(r.recipe_kg), actual_kg: r2(r.actual_kg),
      diff_kg: r2(diff), diff_pct: n0(r.recipe_kg) > 0 ? r2((diff / n0(r.recipe_kg)) * 100) : null, impact: rate == null ? null : r2(diff * rate) };
  }).filter((r) => r.recipe_kg > 0).sort((x, y) => Math.abs(y.impact || 0) - Math.abs(x.impact || 0));

  // Grade-wise: each mix design's own recipe cost at this month's rates.
  const compRate = {};
  {
    const acc = {};
    for (const r of cur.rm.materials) {
      if (!r.mix_component || !(r.consumed_kg > 0) || r.rate == null) continue;
      acc[r.mix_component] = acc[r.mix_component] || { v: 0, q: 0 };
      acc[r.mix_component].v += r.consumed; acc[r.mix_component].q += r.consumed_kg;
    }
    for (const [k, v] of Object.entries(acc)) compRate[k] = v.v / v.q;
  }
  const mdIds = [...new Set(cur.tickets.map((t) => t.md_id).filter(Boolean))];
  const { rows: mds } = mdIds.length ? await query(
    `SELECT md.id, md.cement_kgm3, md.fly_ash_kgm3, md.fine_agg_kgm3, md.coarse_20mm_kgm3, md.coarse_12_5mm_kgm3,
            (SELECT SUM(x.qty_kgm3) FROM mix_design_admixtures x WHERE x.mix_design_id = md.id) AS admixture_kgm3
       FROM mix_designs md WHERE md.id = ANY($1::int[])`, [mdIds]) : { rows: [] };
  const recipeCost = new Map(mds.map((d) => {
    let c = 0, missing = false;
    for (const [comp, col] of [["cement", "cement_kgm3"], ["fly_ash", "fly_ash_kgm3"], ["fine_agg", "fine_agg_kgm3"],
      ["coarse_20mm", "coarse_20mm_kgm3"], ["coarse_12_5mm", "coarse_12_5mm_kgm3"], ["admixture", "admixture_kgm3"]]) {
      const kg = n0(d[col]);
      if (!kg) continue;
      if (compRate[comp] == null) missing = true; else c += kg * compRate[comp];
    }
    return [d.id, { cost: Math.round(c), missing }];
  }));
  const fuelPerM3 = per(a.fuel);
  const gmap = new Map();
  for (const t of cur.tickets) {
    const key = `${t.grade || "—"}|${t.md_id || ""}`;
    if (!gmap.has(key)) gmap.set(key, { grade: t.grade || "No grade", design: t.design_ref ? `${t.design_ref}${t.revision != null ? ` · rev ${t.revision}` : ""}` : "no mix design",
      description: t.mix_description || "", md_id: t.md_id, qty: 0, inv_qty: 0, amount: 0 });
    const g = gmap.get(key);
    g.qty += t.net;
    if (t.invoice_id) { g.inv_qty += t.net; g.amount += t.concrete; }
  }
  const grades = [...gmap.values()].map((g) => {
    const rate = g.inv_qty > 0 ? Math.round(g.amount / g.inv_qty) : null;
    const rc = g.md_id ? recipeCost.get(g.md_id) : null;
    const rmc = rc ? rc.cost : null;
    const con = rate != null && rmc != null && fuelPerM3 != null ? rate - rmc - fuelPerM3 : null;
    return { grade: g.grade, design: g.design, description: g.description, qty: r2(g.qty), mix: qty > 0 ? r2((g.qty / qty) * 100) : null,
      rate, rm: rmc, rm_partial: !!rc?.missing, fuel: fuelPerM3, contribution: con, margin: con != null && rate ? r2((con / rate) * 100) : null };
  }).sort((x, y) => (x.grade < y.grade ? -1 : x.grade > y.grade ? 1 : y.qty - x.qty));

  // Fuel by consumer, efficiency on each one's own driver.
  const loadsByTruck = cur.tickets.filter((t) => t.truck_id).length;
  const pumpedM3 = cur.sales.pumped_m3;
  const prod = await productionM3Range({ from, toExclusive: toEx }).catch(() => ({ total_m3: 0 }));
  const prevFuel = new Map(pm.fuel.consumers.map((c) => [c.kind, c]));
  const fuelRows = cur.fuel.consumers.sort((x, y) => FUEL_KINDS[x.kind].order - FUEL_KINDS[y.kind].order).map((c) => {
    let eff = null;
    if (c.kind === "truck" && loadsByTruck > 0) eff = { value: r2(c.litres / loadsByTruck), unit: "L / load", sub: `${loadsByTruck} loads` };
    else if (c.kind === "pump" && pumpedM3 > 0) eff = { value: r2(c.litres / pumpedM3), unit: "L / pumped m³", sub: `${pumpedM3} m³ pumped` };
    else if (["generator", "batching_plant", "loader"].includes(c.kind) && prod.total_m3 > 0) eff = { value: r2(c.litres / prod.total_m3), unit: "L / m³ made", sub: `${prod.total_m3} m³ made` };
    const p = prevFuel.get(c.kind);
    const nowM3 = qty > 0 ? c.value / qty : null, prevM3 = p && pm.sales.qty > 0 ? p.value / pm.sales.qty : null;
    return { kind: c.kind, label: FUEL_KINDS[c.kind].label, units: c.units, litres: r2(c.litres), outside_litres: r2(c.outside_litres),
      value: r2(c.value), per_m3: per(c.value), efficiency: eff,
      change_pct: nowM3 != null && prevM3 ? r2(((nowM3 - prevM3) / prevM3) * 100) : null };
  });
  if (cur.fuel.tank.adj_out > 0) fuelRows.push({ kind: "adjustment", label: "Stock adjustments, net down", units: 0, litres: cur.fuel.tank.adj_out,
    outside_litres: 0, value: cur.fuel.adj_value, per_m3: per(cur.fuel.adj_value), efficiency: null, change_pct: null, note: "physical count below book, net for the month · belongs to no vehicle" });
  const { rows: settingsRows } = await query(`SELECT capacity_l FROM fuel_settings WHERE id = 1`).catch(() => ({ rows: [] }));
  const { rows: openFills } = await query(
    `SELECT COUNT(*)::int AS n FROM supply_requests sr LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
      WHERE sr.request_type = 'fuel' AND sr.status = 'approved' AND NOT COALESCE(fs.is_plant, false)`).catch(() => ({ rows: [{ n: 0 }] }));

  // Maintenance by vehicle / machine, with this financial year beside it.
  const fy = monthBounds(fyStart(ym)).from;
  const fyRows = await maintenanceRows(fy, toEx);
  const fyBy = new Map();
  for (const r of fyRows) fyBy.set(r.asset_id, (fyBy.get(r.asset_id) || 0) + r.amount);
  const loadsByTruckId = new Map(), m3ByPump = new Map();
  for (const t of cur.tickets) {
    if (t.truck_id) loadsByTruckId.set(t.truck_id, (loadsByTruckId.get(t.truck_id) || 0) + 1);
    if (t.pump_id) m3ByPump.set(t.pump_id, (m3ByPump.get(t.pump_id) || 0) + t.net);
  }
  const vmap = new Map();
  for (const r of cur.mntRows) {
    const k = r.asset_id || 0;
    if (!vmap.has(k)) vmap.set(k, { asset_id: r.asset_id, name: r.asset_name || "Not tied to a vehicle", group: r.asset_group || "—",
      model: r.model_name || null, truck_id: r.truck_id, pump_id: r.pump_id, amount: 0, cardSet: new Set(), parts: 0, outside: 0, lubricant: 0, tyres: 0 });
    const v = vmap.get(k);
    v.amount += r.amount; v[r.kind] += r.amount;
    for (const c of r.cards) v.cardSet.add(c);
  }
  const vehicles = [...vmap.values()].map((v) => {
    let unit = null;
    if (v.truck_id && loadsByTruckId.get(v.truck_id)) unit = { value: Math.round(v.amount / loadsByTruckId.get(v.truck_id)), unit: "/ load" };
    else if (v.pump_id && m3ByPump.get(v.pump_id)) unit = { value: Math.round(v.amount / m3ByPump.get(v.pump_id)), unit: "/ pumped m³" };
    else if (v.group === "Plant" && qty > 0) unit = { value: Math.round(v.amount / qty), unit: "/ m³" };
    const { cardSet, ...rest } = v;
    return { ...rest, cards: cardSet.size, amount: r2(v.amount), parts: r2(v.parts), outside: r2(v.outside), lubricant: r2(v.lubricant), tyres: r2(v.tyres),
      per_unit: unit, fy: r2(fyBy.get(v.asset_id || null) || 0) };
  }).sort((x, y) => y.amount - x.amount);
  const fyTotal = r2(fyRows.reduce((t, r) => t + r.amount, 0));
  const { rows: mntOpen } = await query(
    `SELECT (SELECT COUNT(*)::int FROM mnt_job_cards WHERE status IN ('open','work_done') AND general_month IS NULL) AS open_cards,
            (SELECT COUNT(*)::int FROM mnt_outside_repairs WHERE status = 'bill_hold') AS bills_on_hold,
            (SELECT COUNT(*)::int FROM mnt_outside_repairs WHERE status = 'sent_out') AS at_workshop`).catch(() => ({ rows: [{}] }));

  // Operations that drive cost.
  const { rows: omitted } = await query(
    `SELECT COUNT(*)::int AS loads, COALESCE(SUM(pb.batch_qty_m3), 0) AS m3
       FROM plant_batches pb WHERE pb.batch_date >= $1::date AND pb.batch_date < $2::date AND NOT (${loadKept("pb.")})`, [from, toEx]).catch(() => ({ rows: [{ loads: 0, m3: 0 }] }));
  const cementKg = cur.rm.materials.filter((r) => r.mix_component === "cement").reduce((t, r) => t + r.consumed_kg, 0);
  const cementRecipe = recipe.filter((r) => ctx.matById.get(r.material_id)?.mix_component === "cement");
  const cementRecipeKg = cementRecipe.reduce((t, r) => t + r.recipe_kg, 0), cementActualKg = cementRecipe.reduce((t, r) => t + r.actual_kg, 0);

  const ops = {
    loads: cur.sales.loads, avg_load: cur.sales.loads ? r2(cur.sales.qty / cur.sales.loads) : null,
    prev_avg_load: pm.sales.loads ? r2(pm.sales.qty / pm.sales.loads) : null,
    pumped_m3: pumpedM3, pumped_pct: qty > 0 ? r2((pumpedM3 / qty) * 100) : null,
    rejected_m3: cur.sales.rejected_m3, rejected_pct: qty > 0 ? r2((cur.sales.rejected_m3 / (qty + cur.sales.rejected_m3)) * 100) : null,
    omitted_loads: omitted[0]?.loads || 0, omitted_m3: r2(omitted[0]?.m3),
    produced_m3: prod.total_m3,
    cement_per_m3: prod.total_m3 > 0 ? Math.round(cementKg / prod.total_m3) : null,
    cement_vs_recipe_pct: cementRecipeKg > 0 ? r2(((cementActualKg - cementRecipeKg) / cementRecipeKg) * 100) : null,
    held_loads: cur.sales.held_loads, held_m3: cur.sales.held_m3,
  };

  const contribution = r2(a.concrete - a.rm - a.fuel);
  const pcon = r2(pm.amounts.concrete - pm.amounts.rm - pm.amounts.fuel);
  return {
    month: ym, month_label: monthLabel(ym, true), prev_month: prev, prev_label: monthLabel(prev),
    is_current: ym === istMonth(), as_of: istDay(),
    sales: cur.sales, prev_sales: pm.sales,
    kpis: {
      qty, prev_qty: pm.sales.qty, sales: a.concrete, realisation: cur.sales.realisation, prev_realisation: pm.sales.realisation,
      rm_purchase: cur.rm.purchased, rm_consumed: a.rm, prev_rm_m3: per(pm.amounts.rm, pm.sales.qty),
      fuel_bought: cur.fuel.bought_value, fuel_issued: a.fuel, prev_fuel_m3: per(pm.amounts.fuel, pm.sales.qty),
      contribution, prev_contribution_m3: per(pcon, pm.sales.qty),
      maintenance: a.repairs, prev_maintenance: pm.amounts.repairs,
      manpower: r2(a.salaries + a.contract_labour), prev_manpower_m3: per(pm.amounts.salaries + pm.amounts.contract_labour, pm.sales.qty),
    },
    per_m3: { realisation: cur.sales.realisation, rm: per(a.rm), fuel: per(a.fuel), maintenance: per(a.repairs),
      manpower: per(a.salaries + a.contract_labour), contribution: per(contribution) },
    trend,
    raw_material: { rows: rmRows, purchased: cur.rm.purchased, consumed: cur.rm.consumed, no_rate: cur.rm.no_rate,
      prev_m3: per(pm.amounts.rm, pm.sales.qty) },
    recipe,
    grades,
    fuel: { tank: cur.fuel.tank, rate: cur.fuel.rate, issued_value: cur.fuel.issued_value, bought_value: cur.fuel.bought_value,
      issued_litres: cur.fuel.issued_litres, adj_value: cur.fuel.adj_value, capacity_l: settingsRows[0] ? n0(settingsRows[0].capacity_l) || null : null,
      open_outside_fills: openFills[0]?.n || 0, consumers: fuelRows,
      prev_per_m3: per(pm.amounts.fuel, pm.sales.qty) },
    maintenance: { totals: cur.mnt, kinds: MNT_KINDS, vehicles, fy_total: fyTotal, open: mntOpen[0] || {} },
    manpower: { ...cur.man, per_m3: per(cur.man.total), gangs_per_pumped_m3: pumpedM3 > 0 ? Math.round(cur.man.gangs / pumpedM3) : null },
    ops,
  };
}

// ======================================================== PROFIT & LOSS ===
const PL_LINES = [
  { head: "Revenue" },
  { key: "concrete", label: "Sale of concrete", src: "app", hint: "tax invoices, GST taken out" },
  { key: "pumping", label: "Pumping charges", src: "app", hint: "on the invoices, as decided per order" },
  { key: "part_load", label: "Part-load & waiting charges", src: "app", hint: "on the invoices" },
  { key: "other_income", label: "Other income", src: "entered" },
  { total: "revenue", label: "Total revenue", band: "soft" },
  { head: "Direct costs" },
  { key: "rm", label: "Raw material consumed", src: "app", hint: "plant consumption × weighted average rate", cost: true },
  { key: "fuel", label: "Fuel issued", src: "app", hint: "tank, outside fills, net stock adjustment down", cost: true },
  { key: "power", label: "Plant power (electricity)", src: "entered", cost: true },
  { key: "repairs", label: "Repairs & maintenance", src: "app", hint: "Maintenance job cards", cost: true },
  { key: "hired_vehicles", label: "Hired vehicles & pumps", src: "entered", cost: true },
  { total: "gross", label: "Gross margin", band: "soft" },
  { head: "Overheads" },
  { key: "salaries", label: "Salaries & wages", src: "app", hint: "HR payroll, cost to company", cost: true },
  { key: "contract_labour", label: "Contract labour", src: "app", hint: "pump gangs & contractors", cost: true },
  { key: "admin_office", label: "Admin & office", src: "entered", cost: true },
  { key: "selling", label: "Selling & marketing", src: "entered", cost: true, hint: "sales incentive is in salaries" },
  { key: "road_tax", label: "Road tax", src: "app", hint: "spread over the quarter it covers", cost: true },
  { key: "insurance", label: "Vehicle insurance", src: "app", hint: "spread over the policy year", cost: true },
  { key: "other_certs", label: "Other certificates & permits", src: "app", hint: "spread over their validity", cost: true, hideZero: true },
  { key: "rent_rates", label: "Rent & rates", src: "entered", cost: true },
  { total: "ebitda", label: "EBITDA (operating profit)", band: "green" },
  { key: "depreciation", label: "Depreciation", src: "entered", cost: true, hint: "from the fixed-asset register" },
  { key: "interest", label: "Finance cost (interest)", src: "entered", cost: true, hint: "term & vehicle loans, cash credit" },
  { total: "pbt", label: "Profit before tax", band: "soft" },
  { key: "tax", label: "Tax provision", src: "entered", cost: true },
  { total: "pat", label: "Profit after tax", band: "strong" },
];

function periodMonths(ym, period) {
  if (period === "ytd") return monthsFrom(fyStart(ym), ym);
  if (period === "quarter") {
    const fs = fyStart(ym);
    const idx = monthsFrom(fs, ym).length - 1;
    return monthsFrom(addMonths(fs, Math.floor(idx / 3) * 3), ym);
  }
  return [ym];
}
function periodLabel(months, period) {
  if (months.length === 1) return monthLabel(months[0], true);
  const a = monthLabel(months[0]).split(" ")[0], b = monthLabel(months[months.length - 1]);
  return `${period === "ytd" ? "Year to date " : ""}${a}–${b}`;
}

export async function profitLoss(ym, { period = "month", compare = "prev" } = {}) {
  const ctx = await newContext();
  const months = periodMonths(ym, period);
  const shift = compare === "last_year" || period === "ytd" ? -12 : -months.length;
  const cmpMonths = months.map((m) => addMonths(m, shift)).filter((m) => m >= "2020-01");
  const ytdMonths = monthsFrom(fyStart(ym), ym);
  const all = [...new Set([...months, ...cmpMonths, ...ytdMonths])];
  const cores = new Map();
  for (const m of all) cores.set(m, await monthCore(m, ctx));
  const sum = (ms) => sumAmounts(ms.map((m) => withTotals(cores.get(m).amounts)));
  const cur = withTotals(sum(months)), cmp = withTotals(sum(cmpMonths)), ytd = withTotals(sum(ytdMonths));
  const qty = r2(months.reduce((t, m) => t + cores.get(m).sales.qty, 0));
  const cmpQty = r2(cmpMonths.reduce((t, m) => t + cores.get(m).sales.qty, 0));
  const pumped = r2(months.reduce((t, m) => t + cores.get(m).sales.pumped_m3, 0));

  // Which Entered lines are missing, month by month.
  // A month before the app was in use (no sales, no payroll, nothing entered)
  // is not flagged — there is nothing to complete in it.
  const idle = (m) => { const c = cores.get(m); return !c.sales.loads && c.man.payroll_status === "none" && !Object.keys(c.entries).length; };
  const missing = [];
  for (const m of months) {
    if (idle(m)) continue;
    const ent = cores.get(m).entries;
    const bk = cores.get(m).bank || {};
    const miss = PL_ENTERED.filter((e) => !ent[e.key] && !bk[e.key]).map((e) => e.label);
    if (miss.length) missing.push({ month: m, label: monthLabel(m), lines: miss });
  }
  const flags = [];
  let held = { loads: 0, m3: 0 };
  for (const m of months) {
    const c = cores.get(m);
    held.loads += c.sales.held_loads; held.m3 += c.sales.held_m3;
    if (idle(m)) continue;
    if (c.man.payroll_status !== "locked") flags.push(`${monthLabel(m)} payroll ${c.man.payroll_status === "none" ? "not made yet" : "not locked yet"} — salaries may change`);
    if (c.man.bills_draft) flags.push(`${monthLabel(m)}: ${c.man.bills_draft} contractor bill(s) not approved — payroll figures used meanwhile`);
    const both = PL_ENTERED.filter((e) => c.entries[e.key] && c.bank?.[e.key]).map((e) => e.label);
    if (both.length) flags.push(`${monthLabel(m)}: ${both.join(", ")} — typed in AND from bank statements; both are counted — check it is not twice`);
    if (c.rm.no_rate.length) flags.push(`${monthLabel(m)}: no rate yet for ${c.rm.no_rate.join(", ")} — its consumption is not valued`);
  }
  const { rows: hold } = await query(`SELECT COUNT(*)::int AS n FROM mnt_outside_repairs WHERE status = 'bill_hold'`).catch(() => ({ rows: [{ n: 0 }] }));

  const per = (v) => (qty > 0 ? Math.round(v / qty) : null);
  const rows = [];
  for (const l of PL_LINES) {
    if (l.head) { rows.push({ kind: "head", label: l.head }); continue; }
    const key = l.key || l.total;
    if (l.hideZero && !cur[key] && !cmp[key] && !ytd[key]) continue;
    const v = cur[key] || 0, c = cmp[key] || 0;
    const fromBank = r2(months.reduce((t, m) => t + (cores.get(m).bank?.[key] || 0), 0));
    const lineMissing = l.src === "entered" && months.some((m) => !idle(m) && !cores.get(m).entries[key] && !cores.get(m).bank?.[key]);
    const change = c && !lineMissing ? r2(((v - c) / Math.abs(c)) * 100) : null;
    const better = change == null ? null : l.cost ? change < 0 : change > 0;
    rows.push({
      kind: l.total ? "total" : "line", key, label: l.label, band: l.band || null,
      src: l.src === "entered" && fromBank && !months.some((m) => cores.get(m).entries[key]) ? "bank" : l.src || null,
      hint: [l.hint, fromBank ? `incl. ₹${fromBank.toLocaleString("en-IN", { maximumFractionDigits: 0 })} from bank statements` : null].filter(Boolean).join(" · "),
      bank: fromBank || null,
      cur: v, per_m3: per(v), pct: cur.revenue ? r2((v / cur.revenue) * 100) : null, cmp: c, change, better: Math.abs(change ?? 0) < 0.05 ? null : better,
      ytd: ytd[key] || 0,
      missing: lineMissing,
    });
  }

  // Where each ₹ of revenue per m³ goes.
  const water = qty > 0 && cur.revenue > 0 ? [
    ["Raw material", cur.rm], ["Fuel", cur.fuel], ["Power, repairs, hire", cur.power + cur.repairs + cur.hired_vehicles],
    ["Salaries & contract labour", cur.salaries + cur.contract_labour],
    ["Other overheads", cur.admin_office + cur.selling + cur.road_tax + cur.insurance + cur.other_certs + cur.rent_rates],
    ["Depreciation & interest", cur.depreciation + cur.interest], ["Tax", cur.tax], ["Profit after tax", cur.pat],
  ].map(([label, v]) => ({ label, per_m3: Math.round(v / qty), pct: r2((v / cur.revenue) * 100) })) : [];

  // PAT for the six months to this one.
  const patMonths = monthsFrom(addMonths(ym, -5), ym);
  const pat = [];
  for (const m of patMonths) pat.push({ month: m, label: monthLabel(m).split(" ")[0], pat: withTotals((await monthCore(m, ctx)).amounts).pat });

  const fixed = cur.overheads + cur.depreciation + cur.interest;
  const gmPerM3 = qty > 0 ? cur.gross / qty : null;
  return {
    month: ym, period, compare, months, label: periodLabel(months, period),
    cmp_label: cmpMonths.length ? periodLabel(cmpMonths, period) : "—", ytd_label: periodLabel(ytdMonths, "ytd"),
    qty, cmp_qty: cmpQty, pumped_m3: pumped,
    totals: cur, cmp_totals: cmp, ytd_totals: ytd,
    kpis: {
      revenue: cur.revenue, revenue_m3: per(cur.revenue), revenue_change: cmp.revenue ? r2(((cur.revenue - cmp.revenue) / cmp.revenue) * 100) : null,
      gross: cur.gross, gross_pct: cur.revenue ? r2((cur.gross / cur.revenue) * 100) : null, gross_m3: per(cur.gross),
      ebitda: cur.ebitda, ebitda_pct: cur.revenue ? r2((cur.ebitda / cur.revenue) * 100) : null, ebitda_m3: per(cur.ebitda),
      cmp_ebitda_pct: cmp.revenue ? r2((cmp.ebitda / cmp.revenue) * 100) : null,
      pat: cur.pat, pat_pct: cur.revenue ? r2((cur.pat / cur.revenue) * 100) : null, pat_m3: per(cur.pat), cmp_pat: cmp.pat,
      breakeven_m3: gmPerM3 > 0 ? Math.round(fixed / gmPerM3 / months.length) : null, fixed_costs: r2(fixed / months.length),
    },
    rows, water, pat,
    status: { missing, flags, held_loads: held.loads, held_m3: r2(held.m3), bills_on_hold: hold[0]?.n || 0 },
  };
}

// ======================================================== BALANCE SHEET ===
// Customers' position on a day: what was billed and received up to it, set
// oldest first (the order lib/receivables.js sets money), aged from the
// delivery date in the owner's groups.
async function receivablesOn(day) {
  const [items, recd] = await Promise.all([
    query(`SELECT customer_id, as_of_date::text AS d, amount FROM customer_opening_balances WHERE as_of_date <= $1::date
           UNION ALL
           SELECT i.customer_id, dt.ticket_date::text, i.total_amount FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
            WHERE dt.ticket_date <= $1::date
           ORDER BY 1, 2`, [day]),
    query(`SELECT customer_id, SUM(amount) AS amt FROM (
             SELECT customer_id, amount FROM customer_receipts
              WHERE receipt_date <= $1::date AND (cancelled_at IS NULL OR (cancelled_at AT TIME ZONE 'Asia/Kolkata')::date > $1::date)
             UNION ALL
             SELECT COALESCE(i.customer_id, ob.customer_id), p.amount FROM payments p
               LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customer_opening_balances ob ON ob.id = p.opening_balance_id
              WHERE p.receipt_id IS NULL AND p.payment_date <= $1::date
           ) x WHERE customer_id IS NOT NULL GROUP BY 1`, [day]),
  ]);
  const paid = new Map(recd.rows.map((r) => [r.customer_id, n0(r.amt)]));
  const byCust = new Map();
  for (const it of items.rows) {
    if (!byCust.has(it.customer_id)) byCust.set(it.customer_id, []);
    byCust.get(it.customer_id).push(it);
  }
  const ages = Object.fromEntries(AGE_GROUPS.map((g) => [g.key, 0]));
  let owed = 0, advance = 0;
  const over30 = new Set();
  for (const cid of new Set([...byCust.keys(), ...paid.keys()])) {
    let left = paid.get(cid) || 0;
    for (const it of byCust.get(cid) || []) {
      let open = n0(it.amount);
      const use = Math.min(left, open);
      open -= use; left -= use;
      if (open > 0.01) {
        owed += open;
        const g = ageGroup(Math.max(0, dayDiff(it.d, day)));
        ages[g] += open;
        if (g === "d30p") over30.add(cid);
      }
    }
    if (left > 0.01) advance += left;
  }
  return {
    owed: r2(owed), advance: r2(advance), over30_customers: over30.size,
    ages: AGE_GROUPS.map((g) => ({ key: g.key, label: g.label, amount: r2(ages[g.key]) })),
  };
}

async function maintenancePayablesOn(day) {
  const { rows } = await query(
    `SELECT b.is_estimate, b.amount,
            COALESCE((SELECT SUM(p.amount + p.tds) FROM mnt_payments p WHERE p.bill_id = b.id AND p.paid_on <= $1::date), 0) AS paid
       FROM mnt_bills b WHERE COALESCE(b.bill_date, (b.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= $1::date`, [day]).catch(() => ({ rows: [] }));
  let payable = 0, advance = 0;
  for (const b of rows) {
    if (b.is_estimate) advance += n0(b.paid);
    else { const open = n0(b.amount) - n0(b.paid); if (open > 0) payable += open; else advance += -open; }
  }
  return { payable: r2(payable), advance: r2(advance) };
}

// A contractor's month is owed from the end of that month (the work was done),
// once its bill is approved — the same month the P&L counts it in.
async function contractorsOn(day) {
  const { rows } = await query(
    `SELECT c.id,
            COALESCE((SELECT SUM(net_payable) FROM hr_contractor_bills b WHERE b.contractor_id = c.id AND b.status = 'approved'
                       AND (b.month || '-01')::date + interval '1 month' - interval '1 day' <= $1::date), 0) AS billed,
            COALESCE((SELECT SUM(amount) FROM hr_contractor_payments p WHERE p.contractor_id = c.id AND p.paid_on <= $1::date), 0) AS paid
       FROM hr_contractors c`, [day]).catch(() => ({ rows: [] }));
  let payable = 0, advance = 0;
  for (const r of rows) { const b = n0(r.billed) - n0(r.paid); if (b > 0) payable += b; else advance += -b; }
  return { payable: r2(payable), advance: r2(advance) };
}

async function salariesOn(day) {
  const ym = day.slice(0, 7);
  const last = monthBounds(ym).end === day ? ym : addMonths(ym, -1);
  const [{ rows: pay }, { rows: adv }] = await Promise.all([
    query(`SELECT COALESCE(SUM(l.net_pay - CASE WHEN l.paid_on IS NOT NULL AND l.paid_on <= $2::date THEN COALESCE(l.paid_amount, 0) ELSE 0 END), 0) AS owed
             FROM hr_payroll_lines l JOIN hr_payroll_runs r ON r.month = l.month
            WHERE r.status = 'locked' AND l.month <= $1 AND l.net_pay > 0`, [last, day]).catch(() => ({ rows: [{ owed: 0 }] })),
    query(`SELECT COALESCE(SUM(amount), 0) AS amt FROM hr_advances WHERE given_on <= $1::date AND recover_month > $2`, [day, last]).catch(() => ({ rows: [{ amt: 0 }] })),
  ]);
  return { payable: r2(Math.max(0, n0(pay[0].owed))), advances: r2(adv[0].amt) };
}

// Raw material stock on a month end: today's book stock (the Material
// module's own figure) less what came in and went out after that month.
async function rmStockOn(ym, ctx) {
  const now = istMonth();
  const book = await bookStockRows();
  const after = ym < now ? addMonths(ym, 1) : null;
  const moveBy = new Map();
  if (after) {
    const from = `${after}-01`, toEx = firstOfNextMonth(`${now}-01`);
    const [cons, recv] = await Promise.all([
      consumptionByMaterialMonthRange({ from, toExclusive: toEx }),
      query(`SELECT o.material_id, SUM(r.accepted_qty_kg) AS kg FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
              WHERE r.received_date >= $1::date GROUP BY 1`, [from]),
    ]);
    for (const c of cons) moveBy.set(c.material_id, (moveBy.get(c.material_id) || 0) - c.kg);
    for (const r of recv.rows) moveBy.set(r.material_id, (moveBy.get(r.material_id) || 0) + n0(r.kg));
  }
  let value = 0;
  const unvalued = [];
  for (const m of book) {
    const kg = n0(m.base_kg) + n0(m.received_kg) - n0(m.consumed_kg) - (moveBy.get(m.id) || 0);
    if (Math.abs(kg) < 0.01) continue;
    const rate = ctx.rmRate(m.id, ym);
    if (rate == null) { unvalued.push(m.name); continue; }
    value += kg * rate;
  }
  return { value: r2(value), unvalued };
}

async function storesOn(day) {
  const [{ rows: mnt }, { rows: lub }, { rows: tyres }] = await Promise.all([
    query(`SELECT COALESCE(SUM(current_qty * avg_rate), 0)
                - COALESCE((SELECT SUM(SIGN(qty_change) * value) FROM mnt_store_txns WHERE created_at::date > $1::date), 0) AS v
             FROM mnt_store_items`, [day]).catch(() => ({ rows: [{ v: 0 }] })),
    query(`SELECT COALESCE(SUM((i.current_qty - COALESCE((SELECT SUM(t.qty_change) FROM store_stock_transactions t
                     WHERE t.stock_item_id = i.id AND t.created_at::date > $1::date), 0)) * COALESCE(i.rate_per_liter, 0)), 0) AS v
             FROM store_stock_items i WHERE i.item_type <> 'fuel'`, [day]).catch(() => ({ rows: [{ v: 0 }] })),
    query(`SELECT COALESCE((SELECT SUM(cost) FROM mnt_tyres WHERE status = 'in_store' AND store_txn_id IS NULL), 0)
                + COALESCE((SELECT SUM(cost) FROM mnt_batteries WHERE status = 'in_store' AND store_txn_id IS NULL), 0) AS v`).catch(() => ({ rows: [{ v: 0 }] })),
  ]);
  const isNow = day >= istDay();
  return { maintenance: r2(mnt[0].v), lubricants: r2(lub[0].v), tyres: isNow ? r2(tyres[0].v) : 0 };
}

async function sideBalances(ym, ctx) {
  const now = istMonth();
  const day = ym >= now ? istDay() : monthBounds(ym).end;
  const ent = await balancesOn(day);
  const E = (k) => (ent[k] ? ent[k].amount : 0);

  // Retained profit: the figure entered at a date, plus the P&L after it.
  const ro = ent.retained_opening;
  const startYm = ro ? addMonths(ro.as_on.slice(0, 7), monthBounds(ro.as_on.slice(0, 7)).end === ro.as_on ? 1 : 0) : fyStart(ym);
  let pat = 0, tax = 0;
  for (const m of startYm <= ym ? monthsFrom(startYm, ym) : []) {
    const t = withTotals((await monthCore(m, ctx)).amounts);
    pat += t.pat; tax += t.tax;
  }
  const [sup, trn, cust, mnt, con, sal, rmStock, stores, tank] = await Promise.all([
    buildLedgers({ asOn: day }).catch((e) => { console.error("cost: supplier ledger", e.message); return []; }),
    buildTransporterLedgers({ asOn: day }).catch((e) => { console.error("cost: transporter ledger", e.message); return []; }),
    receivablesOn(day), maintenancePayablesOn(day), contractorsOn(day), salariesOn(day), rmStockOn(ym, ctx), storesOn(day),
    tankSummary(day, day),
  ]);
  const pos = (list) => r2(list.reduce((t, l) => t + Math.max(0, n0(l.balance)), 0));
  const neg = (list) => r2(list.reduce((t, l) => t + Math.max(0, -n0(l.balance)), 0));
  const rate = ctx.dieselRate(day);
  const prepaid = certPrepaid(ctx, day);
  // Round 223 — loans from the loan list, cash credit from the CC statements.
  const bank = await bankBalancesOn(day).catch(() => ({}));
  return {
    day, ent, bank, retained: { opening: ro ? ro.amount : 0, opening_as_on: ro ? ro.as_on : null, pat: r2(pat), from: startYm },
    v: {
      capital: E("capital"), retained: r2((ro ? ro.amount : 0) + pat),
      term_loans: bank.term_loans ?? E("term_loans"), cash_credit: bank.cash_credit ?? E("cash_credit"),
      rm_suppliers: pos(sup), transporters: pos(trn), maintenance_creditors: mnt.payable, contractors: con.payable,
      other_creditors: E("other_creditors"), salaries_payable: sal.payable, customer_advances: cust.advance,
      gst_tds_payable: E("gst_tds_payable"), tax_provision: r2(tax),
      fixed_assets: E("fixed_assets"),
      rm_stock: rmStock.value, diesel: r2(tank.closing * (rate || 0)), stores: r2(stores.maintenance + stores.lubricants + stores.tyres),
      receivables: cust.owed,
      advances_paid: r2(neg(sup) + neg(trn) + mnt.advance + con.advance), salary_advances: sal.advances,
      prepaid_certs: prepaid.amount, deposits_prepaid: E("deposits_prepaid"), gst_input: E("gst_input"), cash_bank: E("cash_bank"),
    },
    detail: { cust, diesel_l: tank.closing, diesel_rate: rate, rm_unvalued: rmStock.unvalued, stores, prepaid_count: prepaid.count,
      sup_overdue: r2(sup.reduce((t, l) => t + n0(l.overdue), 0)), sup_oldest_late: sup.reduce((m, l) => Math.max(m, n0(l.oldest_overdue_days)), 0) },
  };
}

const BS_LAYOUT = {
  liab: [
    { head: "Owners’ funds" },
    { key: "capital", label: "Capital", src: "entered" },
    { key: "retained", label: "Retained profit", src: "app", hint: "entered figure + profit since, from the Profit & Loss" },
    { head: "Loans" },
    { key: "term_loans", label: "Term & vehicle loans", src: "entered" },
    { key: "cash_credit", label: "Cash credit (bank overdraft)", src: "entered" },
    { head: "Current liabilities" },
    { key: "rm_suppliers", label: "Raw-material suppliers", src: "app", hint: "Supplier Ledger" },
    { key: "transporters", label: "Transporters", src: "app", hint: "Transporter Ledger" },
    { key: "maintenance_creditors", label: "Maintenance suppliers & workshops", src: "app", hint: "Maintenance → Payments: GRV, outside repair and certificate bills" },
    { key: "contractors", label: "Labour contractors", src: "app", hint: "approved contractor bills less payments" },
    { key: "other_creditors", label: "Other creditors", src: "entered", hint: "power, rent, services, fuel stations" },
    { key: "salaries_payable", label: "Salaries & wages payable", src: "app", hint: "HR payroll — locked, not paid" },
    { key: "customer_advances", label: "Customer advances", src: "app", hint: "receipts not yet set against an invoice" },
    { key: "gst_tds_payable", label: "GST, TDS, PF/ESI payable", src: "entered", hint: "incl. TDS on contractor bills" },
    { key: "tax_provision", label: "Provision for tax", src: "app", hint: "from the Profit & Loss" },
  ],
  asset: [
    { head: "Fixed assets" },
    { key: "fixed_assets", label: "Plant, transit mixers, pumps, buildings", src: "entered", hint: "net of depreciation · vehicle list in Maintenance → Equipment" },
    { head: "Stock" },
    { key: "rm_stock", label: "Raw material", src: "app", hint: "book stock at weighted average rate" },
    { key: "diesel", label: "Diesel", src: "app", hint: "Fuel module tank, book stock" },
    { key: "stores", label: "Stores, spares & lubricants", src: "app", hint: "Maintenance store, lubricants, tyres & batteries in store" },
    { head: "Current assets" },
    { key: "receivables", label: "Customers (receivables)", src: "app", hint: "invoices and opening balances less receipts" },
    { key: "advances_paid", label: "Advances to suppliers & contractors", src: "app", hint: "ledgers paid ahead, workshop advances" },
    { key: "salary_advances", label: "Salary advances", src: "app", hint: "HR → Advances paid, not yet recovered" },
    { key: "prepaid_certs", label: "Prepaid road tax & insurance", src: "app", hint: "paid but not yet expensed · Maintenance → Certificates" },
    { key: "deposits_prepaid", label: "Deposits & other prepaid", src: "entered" },
    { key: "gst_input", label: "GST input credit", src: "entered" },
    { key: "cash_bank", label: "Cash & bank", src: "entered", hint: "from bank reconciliation" },
  ],
};
const CURRENT_LIAB = ["rm_suppliers", "transporters", "maintenance_creditors", "contractors", "other_creditors", "salaries_payable",
  "customer_advances", "gst_tds_payable", "tax_provision", "cash_credit"];
const CURRENT_ASSET = ["rm_stock", "diesel", "stores", "receivables", "advances_paid", "salary_advances", "prepaid_certs",
  "deposits_prepaid", "gst_input", "cash_bank"];

export async function balanceSheet(ym, { compare = "fy_start" } = {}) {
  const ctx = await newContext();
  const cmpYm = compare === "prev" ? addMonths(ym, -1) : addMonths(fyStart(ym), -1);
  const [now, then] = await Promise.all([sideBalances(ym, ctx), sideBalances(cmpYm, ctx)]);
  // Round 232 — input GST taken out of bank-statement costs this month: a
  // pointer for the GST input credit typed in (its balance also depends on
  // what was set off against GST on sales, which only the GST return has).
  const bankGst = await bankHeadsMonth(ym).then((b) => b.gst_input || 0).catch(() => 0);
  const side = (k) => {
    const rows = [];
    let tn = 0, tt = 0;
    for (const l of BS_LAYOUT[k]) {
      if (l.head) { rows.push({ kind: "head", label: l.head }); continue; }
      const a = now.v[l.key] || 0, b = then.v[l.key] || 0;
      tn += a; tt += b;
      const viaBank = now.bank?.[l.key] != null;
      rows.push({ kind: "line", key: l.key, label: l.label, src: viaBank ? "bank" : l.src,
        hint: viaBank ? (l.key === "term_loans" ? "Cost → Bank statements → Loans: balance less principal repaid" : "closing balance of the cash credit statements")
          : l.key === "gst_input" && bankGst ? `${l.hint ? `${l.hint} · ` : ""}₹${bankGst.toLocaleString("en-IN", { maximumFractionDigits: 0 })} input GST in this month's bank-statement costs`
          : l.hint || "",
        now: r2(a), then: r2(b), change: r2(a - b),
        missing: !viaBank && l.src === "entered" && !now.ent[l.key] });
    }
    return { rows, now: r2(tn), then: r2(tt) };
  };
  const liab = side("liab"), asset = side("asset");
  const diff = r2(asset.now - liab.now), diffThen = r2(asset.then - liab.then);
  if (Math.abs(diff) >= 0.01 || Math.abs(diffThen) >= 0.01) {
    const target = diff > 0 || (diff === 0 && diffThen > 0) ? liab : asset;
    const amt = (d) => (target === liab ? Math.max(0, d) : Math.max(0, -d));
    target.rows.push({ kind: "line", key: "unreconciled", label: "Not yet reconciled", src: "gap", hint: "the two sides do not agree — see what is missing",
      now: r2(amt(diff)), then: r2(amt(diffThen)), change: r2(amt(diff) - amt(diffThen)), gap: true });
    target.now = r2(target.now + amt(diff)); target.then = r2(target.then + amt(diffThen));
  }
  const v = now.v;
  const ca = CURRENT_ASSET.reduce((t, k) => t + (v[k] || 0), 0), cl = CURRENT_LIAB.reduce((t, k) => t + (v[k] || 0), 0);
  const netWorth = r2(v.capital + v.retained), loans = r2(v.term_loans + v.cash_credit);
  const trade = r2(v.rm_suppliers + v.transporters + v.maintenance_creditors + v.contractors + v.other_creditors);

  // Working capital cycle on this month's flows.
  const core = await monthCore(ym, ctx);
  const days = ym >= istMonth() ? Math.max(1, Number(istDay().slice(8, 10))) : monthBounds(ym).days;
  const salesPerDay = core.sales.gross / days, rmPerDay = core.rm.consumed / days, buyPerDay = core.rm.purchased / days;
  const recvDays = salesPerDay > 0 ? Math.round(v.receivables / salesPerDay) : null;
  const stockDays = rmPerDay > 0 ? Math.round(v.rm_stock / rmPerDay) : null;
  const payDays = buyPerDay > 0 ? Math.round(v.rm_suppliers / buyPerDay) : null;

  return {
    month: ym, as_on: now.day, compare, cmp_as_on: then.day,
    liabilities: liab, assets: asset, difference: diff, balanced: Math.abs(diff) < 0.01,
    kpis: {
      net_worth: netWorth, net_worth_change: r2(netWorth - (then.v.capital + then.v.retained)), loans,
      debt_to_worth: netWorth > 0 ? r2(loans / netWorth) : null, cash: v.cash_bank, cash_then: then.v.cash_bank,
      receivables: v.receivables, over30: r2(now.detail.cust.ages.find((g) => g.key === "d30p")?.amount),
      trade_payables: trade, current_ratio: cl > 0 ? r2(ca / cl) : null,
    },
    receivables: { ...now.detail.cust },
    payables: [
      { label: "Raw-material suppliers", src: "Supplier Ledger", amount: v.rm_suppliers },
      { label: "Transporters", src: "Transporter Ledger", amount: v.transporters },
      { label: "Maintenance suppliers & workshops", src: "Maintenance", amount: v.maintenance_creditors },
      { label: "Labour contractors", src: "contractor bills", amount: v.contractors },
      { label: "Salaries & wages not yet paid", src: "HR payroll", amount: v.salaries_payable },
      { label: "Other creditors", src: "entered", amount: v.other_creditors },
    ],
    supplier_overdue: now.detail.sup_overdue, supplier_oldest_late: now.detail.sup_oldest_late,
    working_capital: { receivable_days: recvDays, stock_days: stockDays, payable_days: payDays,
      cycle: recvDays != null && stockDays != null && payDays != null ? recvDays + stockDays - payDays : null,
      per_day_sales: r2(salesPerDay) },
    retained: now.retained,
    notes: [
      ...(now.detail.rm_unvalued.length ? [`No rate yet for ${now.detail.rm_unvalued.join(", ")} — its stock is not valued`] : []),
      ...(!now.ent.retained_opening ? ["Retained profit at the start has not been entered — profit is counted from the start of this financial year only"] : []),
    ],
    missing: BS_ENTERED.filter((e) => !now.ent[e.key] && now.bank?.[e.key] == null).map((e) => e.label),
  };
}

// ---------------------------------------------------- fuel, line by line ---
// Round 219 (owner, 20 Oct 2026: "better if I can click and see how this cost
// is calculated and its details"). Every entry behind the Diesel bought ·
// issued tile for one month, each with the value the dashboard gave it and
// why, so the totals can be checked one line at a time. Same rules as
// fuelMonth() above — nothing here may disagree with the tile.
export async function fuelDetail(ym) {
  const ctx = await newContext();
  const { from, toEx, end } = monthBounds(ym);
  const rate = ctx.dieselRate(end);
  const [core, receipts, issues, adjustments] = await Promise.all([
    monthCore(ym, ctx),
    query(
      `SELECT sp.id, sp.received_at, sp.supplier_name, sp.received_qty AS litres, sp.unit_cost AS rate, sp.total_cost AS value,
              u.name AS by_name
         FROM store_stock_purchases sp
         JOIN store_stock_items i ON i.id = sp.stock_item_id AND i.item_type = 'fuel'
         LEFT JOIN users u ON u.id = sp.received_by
        WHERE sp.status = 'received' AND sp.received_at::date >= $1::date AND sp.received_at::date < $2::date
        ORDER BY sp.received_at`, [from, toEx]),
    query(
      `SELECT sr.id, sr.issued_at, sr.actual_quantity_issued AS litres, sr.fuel_cost,
              COALESCE(t.truck_number, p.pump_code, e.name) AS unit,
              CASE WHEN sr.truck_id IS NOT NULL THEN 'truck' WHEN sr.pump_id IS NOT NULL THEN 'pump'
                   ELSE COALESCE(e.equipment_type::text, sr.equipment_type::text, 'other') END AS kind,
              fs.name AS station, COALESCE(fs.is_plant, false) AS is_plant,
              EXISTS (SELECT 1 FROM store_stock_transactions x WHERE x.reference_type = 'supply_request' AND x.reference_id = sr.id) AS from_tank,
              u.name AS by_name, sr.bill_ref
         FROM supply_requests sr
         LEFT JOIN trucks t ON t.id = sr.truck_id
         LEFT JOIN pumps p ON p.id = sr.pump_id
         LEFT JOIN equipment e ON e.id = sr.equipment_id
         LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
         LEFT JOIN users u ON u.id = sr.issued_by
        WHERE sr.request_type = 'fuel' AND sr.status = 'issued' AND sr.actual_quantity_issued > 0
          AND sr.issued_at::date >= $1::date AND sr.issued_at::date < $2::date
        ORDER BY sr.issued_at`, [from, toEx]),
    query(
      `SELECT x.id, x.created_at, x.qty_change, x.balance_after, x.note, u.name AS by_name, x.voided_at, x.original_qty_change
         FROM store_stock_transactions x
         JOIN store_stock_items i ON i.id = x.stock_item_id AND i.item_type = 'fuel'
         LEFT JOIN users u ON u.id = x.created_by
        WHERE x.txn_type = 'adjustment' AND x.created_at::date >= $1::date AND x.created_at::date < $2::date
        ORDER BY x.created_at, x.id`, [from, toEx]),
  ]);
  const f = core.fuel;
  const issueRows = issues.rows.map((r) => {
    const litres = n0(r.litres);
    const entered = r.fuel_cost != null;
    const value = entered ? n0(r.fuel_cost) : litres * (rate || 0);
    const outside = !r.from_tank && !r.is_plant;
    return {
      ref: `FR-${r.id}`, at: r.issued_at, unit: r.unit || "—", kind: FUEL_KINDS[r.kind] ? FUEL_KINDS[r.kind].label : FUEL_KINDS.other.label,
      where: outside ? (r.station || "Outside station") : "Plant tank", outside, litres: r2(litres), value: r2(value),
      rate: litres > 0 ? r2(value / litres) : null,
      basis: entered ? (outside ? "amount on the station bill" : "amount entered at issue") : `no amount entered — ${r2(litres)} L × ₹${rate ?? 0}`,
      by: r.by_name || null, bill_ref: r.bill_ref || null,
      // A rate far from the standing rate usually means the amount was keyed wrong.
      odd_rate: entered && rate && litres > 0 ? Math.abs(value / litres - rate) / rate > 0.25 : false,
    };
  });
  // Adjustments are taken net over the month (Round 219): only what is left
  // after the ups and downs cancel counts — net down as issued, net up as
  // stock added — so no single row carries a value of its own.
  const adjRows = adjustments.rows.map((r) => {
    const q = n0(r.qty_change);
    return {
      ref: `ADJ-${r.id}`, at: r.created_at, change: r2(q), before: r2(n0(r.balance_after) - q), after: r2(n0(r.balance_after)),
      note: r.note || null, by: r.by_name || null,
      voided: !!r.voided_at, entered: r.original_qty_change != null ? r2(n0(r.original_qty_change)) : null,
    };
  });
  const sum = (list, k) => r2(list.reduce((t, x) => t + n0(x[k]), 0));
  const tankIssues = issueRows.filter((r) => !r.outside);
  const outside = issueRows.filter((r) => r.outside);
  const recRows = receipts.rows.map((r) => ({ ref: `FPR-${r.id}`, at: r.received_at, supplier: r.supplier_name || "—",
    litres: r2(n0(r.litres)), rate: r.rate != null ? r2(n0(r.rate)) : null, value: r2(n0(r.value)), by: r.by_name || null }));
  return {
    month: ym, month_label: monthLabel(ym, true),
    rate, rate_basis: rate == null ? "no diesel rate set" : `standing diesel rate on ${end} (Fuel → Settings rate history)`,
    tile: { bought: f.bought_value, issued: f.issued_value },
    bought: {
      receipts: recRows, outside,
      total: f.bought_value,
      tank_value: sum(recRows, "value"), outside_value: sum(outside, "value"),
    },
    issued: {
      tank: tankIssues, outside, adjustments: adjRows,
      tank_value: sum(tankIssues, "value"), outside_value: sum(outside, "value"),
      adj_value: f.adj_value, adj_net: r2(adjRows.reduce((t, a) => t + a.change, 0)),
      adj_out_litres: f.tank.adj_out, adj_in_litres: f.tank.adj_in,
      adj_down_gross: r2(adjRows.filter((a) => a.change < 0).reduce((t, a) => t - a.change, 0)),
      adj_up_gross: r2(adjRows.filter((a) => a.change > 0).reduce((t, a) => t + a.change, 0)),
      total: f.issued_value,
    },
    tank: f.tank,
  };
}
