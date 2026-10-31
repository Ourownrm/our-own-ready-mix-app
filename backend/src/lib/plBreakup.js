// Round 255 — Profit & Loss: what makes up each line (owner, 31 Oct 2026:
// "if October maintenance expenses is 5.3 lakhs, I should be able to see
// what contributed this 5.3 lakh").
//
// For one P&L line and period, every entry behind its figure, in groups by
// where it comes from — the same sources, the same arithmetic as the P&L
// (lib/costDashboard.js computeMonth). The groups add up to the line; if they
// ever don't, the difference is shown rather than hidden.
import { query } from "../db.js";
import {
  PL_LINES, periodMonths, periodLabel, newContext, monthCore, monthBounds, monthEntries, monthLabel,
} from "./costDashboard.js";
import { NET_SQL, ensureBankGst } from "./bankBook.js";
import { CL_CATEGORIES, CL_FACTOR } from "./cLedger.js";
import { PARTNER_DUP_SQL, ensurePartners } from "./partners.js";
import { ensureRound255 } from "./round255Schema.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const safe = (p) => p.then((r) => r.rows).catch((e) => { console.error("P&L breakup:", e.message); return []; });
const DAY = 86400000;
const ms = (d) => Date.parse(`${d}T00:00:00Z`);
const days = (a, b) => Math.round((ms(b) - ms(a)) / DAY) + 1;

const LINES = PL_LINES.filter((l) => l.key);
export const BREAKUP_KEYS = new Set(LINES.map((l) => l.key));

// A group: { key, label, note, columns, rows: [[cells…, amount]] , total }.
// The amount is always the last cell.
function group(key, label, columns, rows, note = null) {
  const total = r2(rows.reduce((t, r) => t + n0(r[r.length - 1]), 0));
  return { key, label, note, columns, rows: rows.map((r) => r.map((c, i) => (i === r.length - 1 ? r2(c) : c))), total };
}

// ------------------------------------------------------------ revenue ---
async function salesGroups(ym, key, core) {
  const { from, end } = monthBounds(ym);
  const t = core.tickets.filter((x) => x.invoice_id && n0(key === "concrete" ? x.concrete : key === "pumping" ? x.pumping : x.part_load));
  const meta = new Map((await safe(query(
    `SELECT dt.id, dt.ticket_number, COALESCE(i.billing_name, c.name) AS customer, s.name AS site
       FROM delivery_tickets dt JOIN customer_orders co ON co.id = dt.order_id JOIN customers c ON c.id = co.customer_id
       LEFT JOIN sites s ON s.id = co.site_id LEFT JOIN invoices i ON i.ticket_id = dt.id WHERE dt.id = ANY($1::int[])`, [t.map((x) => x.id)]))).map((r) => [r.id, r]));
  const v = (x) => (key === "concrete" ? x.concrete : key === "pumping" ? x.pumping : x.part_load);
  const inv = t.filter((x) => typeof x.invoice_id === "number" || /^\d+$/.test(String(x.invoice_id)));
  const cl = t.filter((x) => String(x.invoice_id).startsWith("c"));
  const row = (x) => [x.day, meta.get(x.id)?.ticket_number || "", meta.get(x.id)?.customer || "", meta.get(x.id)?.site || "", x.grade || "", r2(x.net), v(x)];
  const cols = ["Date", "Delivery note", "Customer", "Site", "Grade", "m³", "₹ (GST taken out)"];
  const out = [group("invoices", "Tax invoices", cols, inv.map(row).sort((a, b) => (a[0] < b[0] ? -1 : 1)), "Each invoice of the month, its GST taken out (× 100 / 118 when GST is on).")];
  if (cl.length) out.push(group("cledger", "Loads priced from C Ledger records (entered by hand before Round 255)", cols, cl.map(row)));
  if (key === "concrete") {
    const cn = await safe(query(
      `SELECT cn.cn_date::text AS day, cn.cn_no, c.name AS customer, dt.ticket_number, cn.base_amount
         FROM credit_notes cn JOIN customers c ON c.id = cn.customer_id JOIN invoices i ON i.id = cn.invoice_id JOIN delivery_tickets dt ON dt.id = i.ticket_id
        WHERE cn.status = 'approved' AND cn.cn_date BETWEEN $1::date AND $2::date ORDER BY cn.cn_date`, [from, end]));
    if (cn.length) out.push(group("cn", "Credit notes (minus)", ["Date", "Credit note", "Customer", "Against", "₹ (GST taken out)"],
      cn.map((c) => [c.day, c.cn_no, c.customer, c.ticket_number, -n0(c.base_amount)])));
  }
  return out;
}

// -------------------------------------------------------- shared parts ---
// Typed in for the month (Cost → Profit & Loss → Enter the month's expenses).
function enteredGroup(core, key) {
  const e = core.entries?.[key];
  if (!e || !n0(e.amount)) return null;
  return group("entered", "Entered for the month", ["Entered by", "Note", "₹"], [[e.by || "", e.note || "", n0(e.amount)]]);
}

async function bankGroup(ym, key) {
  await ensureBankGst().catch(() => {});
  const partnersOk = await ensurePartners().then(() => true).catch(() => false);
  const income = key === "other_income";
  const rows = await safe(query(
    `SELECT l.txn_date::text AS day, a.bank, l.narration, l.debit, l.credit, ${NET_SQL("l.debit")} AS dr, ${NET_SQL("l.credit")} AS cr, l.gst_pct, l.gst_claim
       FROM cost_bank_lines l JOIN cost_bank_accounts a ON a.id = l.account_id
      WHERE l.treatment = 'cost' AND l.head = $2 AND to_char(l.txn_date, 'YYYY-MM') = $1
        ${partnersOk && key === "interest" ? `AND NOT (${PARTNER_DUP_SQL})` : ""}
      ORDER BY l.txn_date, l.id`, [ym, key]));
  const out = [];
  if (rows.length) {
    out.push(group("bank", "Bank statement lines given this head", ["Date", "Bank", "Narration", "Paid ₹", "GST inside", "₹ counted (without GST)"],
      rows.map((r) => [r.day, r.bank, String(r.narration || "").slice(0, 90), r2(n0(r.debit) || n0(r.credit)),
        n0(r.gst_pct) > 0 && r.gst_claim !== false ? `${n0(r.gst_pct)}%` : "—", income ? n0(r.cr) - n0(r.dr) : n0(r.dr) - n0(r.cr)])));
  }
  if (key === "interest") {
    const loans = await safe(query(
      `SELECT l.txn_date::text AS day, COALESCE(ln.name, a.bank) AS loan, l.debit, l.interest
         FROM cost_bank_lines l JOIN cost_bank_accounts a ON a.id = l.account_id LEFT JOIN cost_bank_loans ln ON ln.id = l.loan_id
        WHERE l.treatment = 'loan' AND to_char(l.txn_date, 'YYYY-MM') = $1 AND COALESCE(l.interest, 0) <> 0 ORDER BY l.txn_date`, [ym]));
    if (loans.length) out.push(group("loans", "Loan instalments — interest part", ["Date", "Loan", "Instalment ₹", "Interest ₹"],
      loans.map((r) => [r.day, r.loan, r2(r.debit), n0(r.interest)])));
  }
  return out;
}

async function cashGroups(ym, key) {
  await ensureRound255().catch(() => {});
  const { from, end } = monthBounds(ym);
  if (!CL_CATEGORIES.some((c) => c.key === key && !c.notCost)) return [];
  const [cl, pc] = await Promise.all([
    safe(query(
      `SELECT x.txn_date::text AS day, COALESCE(a.short_name, u.name) AS who, x.where_spent, x.amount, x.flagged
         FROM cl_expenses x JOIN users u ON u.id = x.holder_id LEFT JOIN cl_access a ON a.user_id = x.holder_id
        WHERE x.deleted_at IS NULL AND x.category = $3 AND x.txn_date BETWEEN $1::date AND $2::date ORDER BY x.txn_date, x.id`, [from, end, key])),
    safe(query(
      `SELECT v.txn_date::text AS day, b.name AS box, v.paid_to, v.purpose, v.amount, v.flagged
         FROM pc_vouchers v JOIN pc_boxes b ON b.id = v.box_id
        WHERE v.deleted_at IS NULL AND v.status = 'approved' AND v.kind IN ('expense','settle') AND v.category = $3
          AND v.txn_date BETWEEN $1::date AND $2::date ORDER BY v.txn_date, v.id`, [from, end, key])),
  ]);
  const cost = (amt, flagged) => n0(amt) * (flagged ? 1 : CL_FACTOR);
  const out = [];
  // The flag is shown as a flag only (owner: the C Ledger flag's meaning is
  // not written on screens); "₹ counted" is what the P&L takes.
  if (cl.length) out.push(group("cledger", "C Ledger cash expenses", ["Date", "Cash holder", "Where spent", "Paid ₹", "Flag", "₹ counted"],
    cl.map((x) => [x.day, x.who, x.where_spent, r2(x.amount), x.flagged ? "Flagged" : "", cost(x.amount, x.flagged)])));
  if (pc.length) out.push(group("petty", "Petty cash vouchers", ["Date", "Box", "Paid to", "Paid ₹", "Flag", "₹ counted"],
    pc.map((x) => [x.day, x.box, `${x.paid_to}${x.purpose ? ` · ${x.purpose}` : ""}`, r2(x.amount), x.flagged ? "Flagged" : "", cost(x.amount, x.flagged)])));
  return out;
}

// ------------------------------------------------------- app-made lines ---
function rmGroups(core) {
  return [group("consumed", "Raw material consumed at the plant", ["Material", "Consumed kg", "Rate ₹/kg", "₹"],
    core.rm.materials.filter((m) => Math.abs(m.consumed) > 0.005).map((m) => [m.name, r2(m.consumed_kg), m.rate == null ? "no rate" : Math.round(m.rate * 1000) / 1000, m.consumed]),
    "Plant consumption × the month's weighted-average landed rate (Material module).")];
}

async function fuelGroups(ym, core) {
  const { from, toEx } = monthBounds(ym);
  const rate = core.fuel.rate || 0;
  const issues = await safe(query(
    `SELECT (sr.issued_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
            COALESCE(t.truck_number, p.pump_code, e.name, sr.equipment_type::text, 'Other') AS unit,
            CASE WHEN COALESCE(fs.is_plant, false) THEN 'Plant tank' ELSE COALESCE(fs.name, 'Outside station') END AS station,
            sr.actual_quantity_issued AS litres, COALESCE(sr.fuel_cost, sr.actual_quantity_issued * $3) AS value
       FROM supply_requests sr
       LEFT JOIN trucks t ON t.id = sr.truck_id LEFT JOIN pumps p ON p.id = sr.pump_id LEFT JOIN equipment e ON e.id = sr.equipment_id
       LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
      WHERE sr.request_type = 'fuel' AND sr.status = 'issued' AND sr.actual_quantity_issued > 0
        AND sr.issued_at::date >= $1::date AND sr.issued_at::date < $2::date ORDER BY sr.issued_at`, [from, toEx, rate]));
  const out = [group("issues", "Diesel issued", ["Date", "Vehicle / machine", "From", "Litres", "₹"],
    issues.map((r) => [r.day, r.unit, r.station, r2(r.litres), n0(r.value)]), `Valued at the fill's own cost, else the diesel rate (₹${rate}/L).`)];
  if (n0(core.fuel.adj_value)) out.push(group("adj", "Tank stock adjusted down (net)", ["What", "Litres", "₹"],
    [["Net fall of the tank book on physical counts — belongs to no vehicle", r2(core.fuel.tank.adj_out), core.fuel.adj_value]]));
  if (n0(core.fuel.petrol?.value)) out.push(group("petrol", "Petrol", ["What", "Litres", "₹"], [["Petrol issued in the month", core.fuel.petrol.litres, core.fuel.petrol.value]]));
  return out;
}

function waterGroups(core) {
  const w = core.water || {};
  const rows = [];
  for (const b of w.purchases || []) rows.push([b.day || b.bought_on || "", `Bought — ${b.supplier || ""}${b.bill_no ? ` · ${b.bill_no}` : ""}`, r2(b.litres), n0(b.amount)]);
  if (n0(w.own_value)) rows.push(["", `Own water — ${n0(w.own_l).toLocaleString("en-IN")} L × ₹${w.own_rate_kl}/kL`, r2(w.own_l), n0(w.own_value)]);
  return [group("water", "Water used at the plant", ["Date", "What", "Litres", "₹"], rows, "Bills of water bought + (water used − bought) × own rate (Cost → Water).")];
}

async function repairsGroups(ym) {
  const { from, toEx } = monthBounds(ym);
  const [parts, outside, lub, tyres] = await Promise.all([
    safe(query(
      `SELECT t.created_at::date::text AS day, i.name AS item, ABS(t.qty_change) AS qty, i.unit, COALESCE(a.name, a2.name) AS asset, t.job_card_id, ABS(t.value) AS amt
         FROM mnt_store_txns t JOIN mnt_store_items i ON i.id = t.item_id
         LEFT JOIN mnt_job_cards j ON j.id = t.job_card_id LEFT JOIN mnt_assets a ON a.id = t.asset_id LEFT JOIN mnt_assets a2 ON a2.id = j.asset_id
        WHERE t.txn_type = 'issue' AND t.created_at::date >= $1::date AND t.created_at::date < $2::date ORDER BY t.created_at`, [from, toEx])),
    safe(query(
      `SELECT o.returned_at::date::text AS day, a.name AS asset, o.workshop, o.job_card_id, o.final_amount AS amt
         FROM mnt_outside_repairs o JOIN mnt_assets a ON a.id = o.asset_id
        WHERE o.final_amount IS NOT NULL AND o.returned_at::date >= $1::date AND o.returned_at::date < $2::date ORDER BY o.returned_at`, [from, toEx])),
    safe(query(
      `SELECT c.charged_at::date::text AS day, a.name AS asset, c.description, c.qty, c.unit, c.job_card_id, c.amount AS amt
         FROM mnt_card_charges c JOIN mnt_assets a ON a.id = c.asset_id
        WHERE c.amount IS NOT NULL AND c.charged_at::date >= $1::date AND c.charged_at::date < $2::date
          AND NOT (c.source_type = 'lubricant' AND EXISTS (SELECT 1 FROM supply_requests sr JOIN lubricant_types lt ON lt.id = sr.lubricant_type_id
                                                            WHERE sr.id = c.source_id AND lt.is_fuel))
        ORDER BY c.charged_at`, [from, toEx])),
    safe(query(
      `SELECT m.created_at::date::text AS day, a.name AS asset, 'Tyre ' || ty.serial || COALESCE(' · ' || ty.brand, '') AS what, ty.cost AS amt
         FROM mnt_tb_moves m JOIN mnt_tyres ty ON m.kind = 'tyre' AND ty.id = m.item_id LEFT JOIN mnt_assets a ON a.id = m.asset_id
        WHERE m.action = 'fit' AND ty.store_txn_id IS NULL AND ty.cost > 0
          AND m.id = (SELECT MIN(id) FROM mnt_tb_moves z WHERE z.kind = 'tyre' AND z.item_id = ty.id AND z.action = 'fit')
          AND m.created_at::date >= $1::date AND m.created_at::date < $2::date
       UNION ALL
       SELECT m.created_at::date::text, a.name, 'Battery ' || b.serial || COALESCE(' · ' || b.make, ''), b.cost
         FROM mnt_tb_moves m JOIN mnt_batteries b ON m.kind = 'battery' AND b.id = m.item_id LEFT JOIN mnt_assets a ON a.id = m.asset_id
        WHERE m.action = 'fit' AND b.store_txn_id IS NULL AND b.cost > 0
          AND m.id = (SELECT MIN(id) FROM mnt_tb_moves z WHERE z.kind = 'battery' AND z.item_id = b.id AND z.action = 'fit')
          AND m.created_at::date >= $1::date AND m.created_at::date < $2::date
       UNION ALL
       SELECT m.created_at::date::text, NULL, 'Retread', m.amount FROM mnt_tb_moves m
        WHERE m.kind = 'tyre' AND m.action = 'retread_back' AND m.amount > 0 AND m.created_at::date >= $1::date AND m.created_at::date < $2::date`, [from, toEx])),
  ]);
  const card = (id) => (id ? `JC-${id}` : "");
  return [
    group("parts", "Parts issued from the maintenance store", ["Date", "Part", "Qty", "Vehicle / machine", "Job card", "₹"],
      parts.map((r) => [r.day, r.item, `${r2(r.qty)} ${r.unit || ""}`.trim(), r.asset || "", card(r.job_card_id), n0(r.amt)])),
    group("outside", "Outside repairs (final bill, month returned)", ["Date", "Vehicle / machine", "Workshop", "Job card", "₹"],
      outside.map((r) => [r.day, r.asset, r.workshop || "", card(r.job_card_id), n0(r.amt)])),
    group("lubricant", "Lubricants on job cards", ["Date", "Vehicle / machine", "What", "Job card", "₹"],
      lub.map((r) => [r.day, r.asset, `${r.description}${r.qty ? ` · ${r2(r.qty)} ${r.unit || ""}` : ""}`, card(r.job_card_id), n0(r.amt)])),
    group("tyres", "Tyres & batteries (fitted, not from the store) and retreads", ["Date", "Vehicle / machine", "What", "₹"],
      tyres.map((r) => [r.day, r.asset || "", r.what, n0(r.amt)])),
  ].filter((g) => g.rows.length);
}

async function payrollGroups(ym, key) {
  const [lines, bills, gangMonths] = await Promise.all([
    safe(query(`SELECT e.name, e.emp_code, l.cost_to_company, l.calc, e.employment_type, e.contractor_id, r.status
                  FROM hr_payroll_lines l JOIN hr_payroll_runs r ON r.month = l.month JOIN hr_employees e ON e.id = l.employee_id
                 WHERE l.month = $1 ORDER BY e.emp_code`, [ym])),
    safe(query(`SELECT b.contractor_id, c.name, b.gangs_amount, b.individual_amount, b.status FROM hr_contractor_bills b JOIN hr_contractors c ON c.id = b.contractor_id
                 WHERE b.month = $1`, [ym])),
    safe(query(`SELECT gm.amount, g.name, g.contractor_id FROM hr_gang_months gm JOIN hr_gangs g ON g.id = gm.gang_id WHERE gm.month = $1`, [ym])),
  ]);
  const approved = new Set(bills.filter((b) => b.status === "approved").map((b) => b.contractor_id));
  if (key === "salaries") {
    const staff = lines.filter((l) => !(l.calc || {}).contract && l.employment_type !== "contract");
    return [group("payroll", `Staff payroll — ${staff[0]?.status === "locked" ? "locked" : "draft"}`, ["Code", "Employee", "Incentive ₹", "Trip ₹", "OT ₹", "Cost to company ₹"],
      staff.map((l) => { const c = l.calc || {}; return [l.emp_code, l.name, r2(c.incentive), r2(c.trip_allowance), r2(c.ot_amount), n0(l.cost_to_company)]; }),
      "Cost to company: pay + employer PF / ESI and provisions (HR → Payroll).")];
  }
  const out = [];
  const ab = bills.filter((b) => b.status === "approved");
  if (ab.length) out.push(group("bills", "Approved contractor bills", ["Contractor", "Pump gangs ₹", "Individual workers ₹", "₹"],
    ab.map((b) => [b.name, r2(b.gangs_amount), r2(b.individual_amount), n0(b.gangs_amount) + n0(b.individual_amount)])));
  const draft = lines.filter((l) => ((l.calc || {}).contract || l.employment_type === "contract") && !(l.contractor_id && approved.has(l.contractor_id)));
  if (draft.length) out.push(group("contract_payroll", "Contract workers from payroll (no approved bill yet)", ["Code", "Worker", "₹"],
    draft.map((l) => [l.emp_code, l.name, n0(l.cost_to_company)])));
  const gm = gangMonths.filter((g) => !approved.has(g.contractor_id));
  if (gm.length) out.push(group("gangs", "Pump gang months closed (no approved bill yet)", ["Gang", "₹"], gm.map((g) => [g.name, n0(g.amount)])));
  return out;
}

function certGroups(ym, key, ctx) {
  const { from, end } = monthBounds(ym);
  const want = key === "road_tax" ? (c) => c.cert_type === "road_tax" : key === "insurance" ? (c) => c.cert_type === "insurance"
    : (c) => c.cert_type !== "road_tax" && c.cert_type !== "insurance";
  const rows = [];
  for (const c of ctx.certs.filter(want)) {
    const a = c.start > from ? c.start : from, b = c.valid_to < end ? c.valid_to : end;
    if (a > b) continue;
    const d = days(a, b);
    rows.push([c.asset_name || "", c.label || c.cert_type, `${c.start} → ${c.valid_to}`, r2(c.fee), `${d} of ${c.days} days`, (c.fee * d) / c.days]);
  }
  return [group("certs", "Certificates — fee spread over the days each covers", ["Vehicle", "Certificate", "Covers", "Fee ₹", "Days in the month", "₹"], rows)];
}

async function otherIncomeGroups(ym) {
  const { from, end } = monthBounds(ym);
  const inc = await safe(query(
    `SELECT txn_date::text AS day, kind, source, amount, flagged FROM cl_incomes
      WHERE deleted_at IS NULL AND status <> 'rejected' AND txn_date BETWEEN $1::date AND $2::date ORDER BY txn_date, id`, [from, end]));
  if (!inc.length) return [];
  const K = { scrap: "Scrap sale", used_oil: "Used oil sale", other: "Other income" };
  return [group("cl_income", "C Ledger other income", ["Date", "What", "Received ₹", "₹ counted"],
    inc.map((i) => [i.day, `${K[i.kind] || i.kind} — ${i.source}`, r2(i.amount), n0(i.amount) * (i.flagged ? CL_FACTOR : 1)]))];
}

// ------------------------------------------------------------ the lot ---
async function monthGroups(ym, key, core, ctx) {
  const out = [];
  const push = (g) => { if (Array.isArray(g)) out.push(...g.filter(Boolean)); else if (g) out.push(g); };
  if (["concrete", "pumping", "part_load"].includes(key)) push(await salesGroups(ym, key, core));
  else if (key === "rm") push(rmGroups(core));
  else if (key === "fuel") push(await fuelGroups(ym, core));
  else if (key === "water") push(waterGroups(core));
  else if (key === "repairs") push(await repairsGroups(ym));
  else if (key === "salaries" || key === "contract_labour") push(await payrollGroups(ym, key));
  else if (["road_tax", "insurance", "other_certs"].includes(key)) push(certGroups(ym, key, ctx));
  if (key === "other_income") push(await otherIncomeGroups(ym));
  // Typed-in figures, bank lines and cash spent in the head, for every head that takes them.
  push(enteredGroup(core, key));
  push(await bankGroup(ym, key));
  push(await cashGroups(ym, key));
  if (key === "interest" && n0(core.partner_interest)) {
    push(group("partners", "Interest on partners' loans (as it accrues)", ["What", "₹"], [["Cost → Partners, at the loan rate from each loan's date", n0(core.partner_interest)]]));
  }
  return out;
}

export async function plBreakup(ym, key, { period = "month" } = {}) {
  if (!BREAKUP_KEYS.has(key)) throw Object.assign(new Error("No such line."), { status: 400 });
  const line = LINES.find((l) => l.key === key);
  const ctx = await newContext();
  const months = periodMonths(ym, period);
  const merged = new Map();
  let pl = 0;
  for (const m of months) {
    const core = await monthCore(m, ctx);
    pl += n0(core.amounts[key]);
    for (const g of await monthGroups(m, key, core, ctx)) {
      const id = g.key;
      const cur = merged.get(id);
      // Over several months the month goes in front of each row.
      const rows = months.length > 1 ? g.rows.map((r) => [monthLabel(m), ...r]) : g.rows;
      if (!cur) merged.set(id, { ...g, columns: months.length > 1 ? ["Month", ...g.columns] : g.columns, rows });
      else { cur.rows.push(...rows); cur.total = r2(cur.total + g.total); }
    }
  }
  const groups = [...merged.values()].filter((g) => g.rows.length || g.total);
  const sum = r2(groups.reduce((t, g) => t + g.total, 0));
  return {
    month: ym, period, months, label: periodLabel(months, period), key, line: line.label, hint: line.hint || null,
    pl: r2(pl), sum, difference: r2(pl - sum), groups,
  };
}
