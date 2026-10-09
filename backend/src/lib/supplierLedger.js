// Round 193 — the supplier ledger: what we owe each raw-material supplier.
//
// One place builds it, for the overview, one supplier's statement, the
// credit-limit check on a new order and the printed PDF, so the four can never
// disagree about a balance.
//
// THE RULES (the owner's, 8 Oct 2026):
//   * A bill is a RECEIPT, booked on the ACCEPTED quantity — accepted qty ×
//     order rate (+ freight when the supplier delivers) + GST at the order's
//     tax %. Whatever the supplier's invoice says, the shortfall is never owed,
//     so no debit note is needed. The amount is fixed on the receipt
//     (rm_receipts.bill_amount) when it is saved.
//   * A receipt still PENDING (weighed and supplier figures disagree, waiting
//     for a Manager; or, Round 200, no weighbridge ticket and waiting for
//     Admin) is not a bill yet — it is "received, not billed", valued at
//     its entered figure.
//   * A load weighed in at the weighbridge with NO receipt prepared is also
//     "received, not billed": we owe for it, it is just not in the books yet.
//     Valued at the supplier's open order rate for that material.
//   * Credit limit used = balance + everything received but not billed.
//     Going over it only WARNS (owner's decision) — nothing is blocked.
//   * Payments are never deleted, only cancelled. A payment settles the bills
//     it was allocated to; any part left unallocated settles the oldest open
//     bills when the ledger is read, so ages stay right without anyone having
//     to allocate by hand.
//
// Money is handled in paise (integers) inside this file, so a long running
// balance cannot drift by floating-point pennies.
import { query } from "../db.js";

// Weighbridge loads before this date are not looked at when a supplier has no
// opening balance — it is the day the weighbridge feed went live, and older
// tickets were never meant to be receipted through the app.
export const UNBILLED_FROM = "2026-09-01";

const p = (n) => Math.round(Number(n || 0) * 100);      // rupees -> paise
const r = (n) => Math.round(n) / 100;                   // paise -> rupees

export function computeFreightTotal(freightRate, freightBasis, acceptedQty, acceptedQtyKg) {
  if (!freightRate) return 0;
  if (freightBasis === "per_kg") return Number(freightRate) * Number(acceptedQtyKg);
  if (freightBasis === "per_trip") return Number(freightRate);
  return Number(freightRate) * Number(acceptedQty);
}

// What the supplier is owed for one receipt. Freight is the supplier's only on
// a delivered order; on ex-factory it is paid to the transporter.
export function receiptBillAmount({ scope, rate, taxPct, acceptedQty, acceptedQtyKg, freightRate, freightBasis }) {
  const freight = scope === "delivered" ? computeFreightTotal(freightRate, freightBasis, acceptedQty, acceptedQtyKg) : 0;
  const base = Number(acceptedQty) * Number(rate) + freight;
  return Math.round(base * (1 + Number(taxPct || 0) / 100) * 100) / 100;
}

// Pure date-string arithmetic on YYYY-MM-DD (no time of day, no timezone).
export function addDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return t.toISOString().slice(0, 10); // ist-ok: a calendar date built from UTC parts, no clock involved
}
export function daysBetween(fromYmd, toYmd) {
  const [a, b] = [fromYmd, toYmd].map((s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); });
  return Math.round((b - a) / 86400000);
}

// Everything the ledger needs, for one supplier or all of them.
async function load(supplierIds) {
  const only = supplierIds && supplierIds.length ? supplierIds : null;
  const [sup, openings, openingBills, bills, pendingReceipts, payments, allocs, tickets] = await Promise.all([
    query(
      `SELECT s.id, s.name, s.gstin, s.contact_person, s.phone, s.is_active, s.credit_days, s.credit_limit,
              (SELECT string_agg(DISTINCT m.name, ', ' ORDER BY m.name)
                 FROM rm_orders o JOIN rm_materials m ON m.id = o.material_id WHERE o.supplier_id = s.id) AS materials
         FROM rm_suppliers s
        WHERE ($1::int[] IS NULL OR s.id = ANY($1::int[]))
        ORDER BY s.name`, [only]),
    query(
      `SELECT supplier_id, to_char(as_on, 'YYYY-MM-DD') AS as_on, direction, remarks, set_at,
              (SELECT name FROM users u WHERE u.id = o.set_by) AS set_by_name
         FROM rm_supplier_openings o WHERE ($1::int[] IS NULL OR supplier_id = ANY($1::int[]))`, [only]),
    query(
      `SELECT id, supplier_id, bill_no, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, amount
         FROM rm_supplier_opening_bills WHERE ($1::int[] IS NULL OR supplier_id = ANY($1::int[]))
        ORDER BY bill_date, id`, [only]),
    query(
      `SELECT r.id, o.supplier_id, o.id AS order_id,
              to_char(COALESCE(r.invoice_date, r.received_date), 'YYYY-MM-DD') AS bill_date,
              to_char(r.received_date, 'YYYY-MM-DD') AS received_date,
              r.challan_number AS invoice_no, r.accepted_qty, r.supplier_qty, r.bill_amount, r.vehicle_number,
              COALESCE(src.purchase_unit, m.purchase_unit) AS unit, m.name AS material_name
         FROM rm_receipts_effective r
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         LEFT JOIN rm_material_sources src ON src.id = o.source_id
        WHERE ($1::int[] IS NULL OR o.supplier_id = ANY($1::int[]))
        ORDER BY COALESCE(r.invoice_date, r.received_date), r.id`, [only]),
    query(
      // receipts-raw: a pending receipt is exactly what this needs to see — received, not yet billed
      `SELECT r.id, o.supplier_id, to_char(r.received_date, 'YYYY-MM-DD') AS received_date,
              r.accepted_qty, r.supplier_qty, r.bill_amount, r.vehicle_number, r.challan_number AS invoice_no,
              r.confirmation_status, r.wb_approval,
              COALESCE(src.purchase_unit, m.purchase_unit) AS unit, m.name AS material_name
         FROM rm_receipts r   -- receipts-raw: pending receipts are the point — received, not billed yet
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         LEFT JOIN rm_material_sources src ON src.id = o.source_id
        WHERE (r.confirmation_status = 'pending' OR r.wb_approval = 'pending')
          AND ($1::int[] IS NULL OR o.supplier_id = ANY($1::int[]))`, [only]),
    query(
      `SELECT pm.id, pm.supplier_id, to_char(pm.paid_on, 'YYYY-MM-DD') AS paid_on, pm.amount, pm.tds_amount,
              pm.mode, pm.reference, pm.bank_account, pm.notes, pm.created_at,
              (SELECT name FROM users u WHERE u.id = pm.created_by) AS created_by_name
         FROM rm_supplier_payments pm
        WHERE pm.cancelled_at IS NULL AND ($1::int[] IS NULL OR pm.supplier_id = ANY($1::int[]))
        ORDER BY pm.paid_on, pm.id`, [only]),
    query(
      `SELECT a.payment_id, a.receipt_id, a.opening_bill_id, a.amount
         FROM rm_payment_allocations a
         JOIN rm_supplier_payments pm ON pm.id = a.payment_id
        WHERE pm.cancelled_at IS NULL AND ($1::int[] IS NULL OR pm.supplier_id = ANY($1::int[]))`, [only]),
    query(
      // A load on the weighbridge, matched to a supplier and material, that no
      // receipt has claimed. Valued at that supplier's latest approved, still
      // open order for the material (else its current rate, without GST).
      `SELECT wb.ticket_number, wb.supplier_id, wb.material_id, wb.net_weight_kg,
              to_char(COALESCE(wb.weighed_at AT TIME ZONE 'Asia/Kolkata', wb.ticket_date::timestamp), 'YYYY-MM-DD') AS weighed_on,
              COALESCE(v.registration, wb.raw_vehicle) AS vehicle, m.name AS material_name,
              ord.id AS order_id, ord.rate AS order_rate, ord.tax_pct,
              COALESCE(ord.kg_per_unit, m.kg_per_purchase_unit) AS kg_per_unit,
              COALESCE(ord.unit, m.purchase_unit) AS unit,
              rt.rate AS current_rate
         FROM weighbridge_tickets wb
         JOIN rm_materials m ON m.id = wb.material_id
         LEFT JOIN weighbridge_vehicles v ON v.id = wb.vehicle_id
         LEFT JOIN rm_receipts r ON r.weighbridge_ticket_id = wb.ticket_number   -- receipts-raw: claimed by ANY receipt, pending included
         LEFT JOIN rm_supplier_openings op ON op.supplier_id = wb.supplier_id
         LEFT JOIN LATERAL (
           SELECT o.id, o.rate, o.tax_pct,
                  COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit) AS kg_per_unit,
                  COALESCE(src.purchase_unit, m.purchase_unit) AS unit
             FROM rm_orders o LEFT JOIN rm_material_sources src ON src.id = o.source_id
            WHERE o.supplier_id = wb.supplier_id AND o.material_id = wb.material_id AND o.status = 'approved'
            ORDER BY o.approved_at DESC NULLS LAST, o.id DESC LIMIT 1
         ) ord ON true
         LEFT JOIN LATERAL (
           SELECT sr.rate FROM rm_supplier_rates sr
            WHERE sr.supplier_id = wb.supplier_id AND sr.material_id = wb.material_id AND sr.valid_to IS NULL AND sr.is_active
            ORDER BY sr.valid_from DESC LIMIT 1
         ) rt ON true
        WHERE wb.match_status = 'matched' AND r.id IS NULL
          AND wb.supplier_id IS NOT NULL AND wb.net_weight_kg IS NOT NULL AND wb.net_weight_kg > 0
          AND COALESCE(wb.purpose, '') NOT ILIKE '%invoic%'
          AND COALESCE((wb.weighed_at AT TIME ZONE 'Asia/Kolkata')::date, wb.ticket_date) >= COALESCE(op.as_on, $2::date)
          AND ($1::int[] IS NULL OR wb.supplier_id = ANY($1::int[]))
        ORDER BY wb.weighed_at NULLS LAST, wb.ticket_number`, [only, UNBILLED_FROM]),
  ]);
  return { sup: sup.rows, openings: openings.rows, openingBills: openingBills.rows, bills: bills.rows,
    pendingReceipts: pendingReceipts.rows, payments: payments.rows, allocs: allocs.rows, tickets: tickets.rows };
}

function group(rows, key = "supplier_id") {
  const m = new Map();
  for (const row of rows) { if (!m.has(row[key])) m.set(row[key], []); m.get(row[key]).push(row); }
  return m;
}

// The ledger for each supplier as on `asOn` (YYYY-MM-DD).
export async function buildLedgers({ supplierIds = null, asOn }) {
  const d = await load(supplierIds);
  const openingBy = new Map(d.openings.map((o) => [o.supplier_id, o]));
  const openingBillsBy = group(d.openingBills);
  const billsBy = group(d.bills);
  const pendingBy = group(d.pendingReceipts);
  const paymentsBy = group(d.payments);
  const ticketsBy = group(d.tickets);
  const allocByPayment = group(d.allocs, "payment_id");

  const out = [];
  for (const s of d.sup) {
    const opening = openingBy.get(s.id) || null;
    const creditDays = s.credit_days == null ? 0 : Number(s.credit_days);

    // ---- bills (opening bills + receipts), only up to asOn ----
    const open = [];
    if (opening && opening.direction === "payable") {
      for (const b of openingBillsBy.get(s.id) || []) {
        open.push({ kind: "opening", id: b.id, no: b.bill_no || "Opening", date: b.bill_date, amount: p(b.amount),
          detail: "Opening balance" });
      }
    }
    for (const b of billsBy.get(s.id) || []) {
      if (b.bill_date > asOn) continue;
      open.push({ kind: "receipt", id: b.id, no: b.invoice_no || `R-${String(b.id).padStart(4, "0")}`, date: b.bill_date,
        amount: p(b.bill_amount), receipt: b,
        detail: `${b.material_name} · ${Number(b.accepted_qty)} ${b.unit} accepted` +
          (Number(b.supplier_qty) !== Number(b.accepted_qty) ? ` (invoice ${Number(b.supplier_qty)})` : "") });
    }
    open.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind === "opening" ? -1 : 0)));
    const billByKey = new Map(open.map((b) => [`${b.kind}:${b.id}`, b]));
    for (const b of open) b.settled = 0;

    // ---- payments up to asOn, explicit allocations first ----
    const pays = (paymentsBy.get(s.id) || []).filter((x) => x.paid_on <= asOn);
    let unallocated = 0;
    for (const pm of pays) {
      const total = p(pm.amount) + p(pm.tds_amount);
      let used = 0;
      for (const a of allocByPayment.get(pm.id) || []) {
        const b = billByKey.get(a.receipt_id ? `receipt:${a.receipt_id}` : `opening:${a.opening_bill_id}`);
        if (!b) continue;
        const take = Math.min(p(a.amount), b.amount - b.settled);
        b.settled += take; used += take;
      }
      unallocated += total - used;
    }
    // An opening ADVANCE is money already with the supplier.
    let advanceOpening = 0;
    if (opening && opening.direction === "advance") {
      advanceOpening = (openingBillsBy.get(s.id) || []).reduce((t, b) => t + p(b.amount), 0);
      unallocated += advanceOpening;
    }
    // The rest settles the oldest open bills.
    for (const b of open) {
      if (unallocated <= 0) break;
      const take = Math.min(unallocated, b.amount - b.settled);
      b.settled += take; unallocated -= take;
    }

    const openBills = open.filter((b) => b.amount - b.settled > 0).map((b) => {
      const due = addDays(b.date, b.kind === "opening" ? 0 : creditDays);
      const outstanding = b.amount - b.settled;
      const late = daysBetween(due, asOn);
      return { kind: b.kind, id: b.id, no: b.no, date: b.date, due_date: due, amount: r(b.amount), settled: r(b.settled),
        outstanding: r(outstanding), days_late: late > 0 ? late : 0, overdue: late > 0, detail: b.detail };
    });

    // ---- received, not yet billed ----
    const notBilled = [];
    for (const pr of pendingBy.get(s.id) || []) {
      notBilled.push({ kind: "pending_receipt", id: pr.id, date: pr.received_date, vehicle: pr.vehicle_number,
        material_name: pr.material_name, qty: Number(pr.accepted_qty), unit: pr.unit, value: Number(pr.bill_amount || 0),
        note: [pr.confirmation_status === "pending" ? "receipt waiting for a Manager to confirm the quantity" : null,
          pr.wb_approval === "pending" ? "receipt with no weighbridge ticket, waiting for Admin" : null].filter(Boolean).join("; ") });
    }
    for (const t of ticketsBy.get(s.id) || []) {
      const kgPerUnit = Number(t.kg_per_unit) || 0;
      const qty = kgPerUnit ? Number(t.net_weight_kg) / kgPerUnit : null;
      let value = null; let basis = null;
      if (qty != null && t.order_rate != null) { value = qty * Number(t.order_rate) * (1 + Number(t.tax_pct || 0) / 100); basis = `PO-${String(t.order_id).padStart(4, "0")} rate`; }
      else if (qty != null && t.current_rate != null) { value = qty * Number(t.current_rate); basis = "current rate, before GST"; }
      notBilled.push({ kind: "weighbridge", id: t.ticket_number, date: t.weighed_on, vehicle: t.vehicle,
        material_name: t.material_name, net_kg: Number(t.net_weight_kg), qty: qty == null ? null : Math.round(qty * 100) / 100,
        unit: t.unit, value: value == null ? null : Math.round(value * 100) / 100, value_basis: basis,
        days_waiting: Math.max(0, daysBetween(t.weighed_on, asOn)), note: "weighed in, no receipt prepared" });
    }
    const notBilledValue = notBilled.reduce((t, x) => t + p(x.value), 0);

    // ---- the statement lines ----
    const lines = [];
    if (opening) {
      const amt = (openingBillsBy.get(s.id) || []).reduce((t, b) => t + p(b.amount), 0);
      lines.push({ date: opening.as_on, type: "opening", text: opening.direction === "payable" ? "Opening balance — owed to supplier" : "Opening balance — advance paid",
        refs: opening.remarks || "", debit: opening.direction === "advance" ? amt : 0, credit: opening.direction === "payable" ? amt : 0 });
    }
    for (const b of open.filter((x) => x.kind === "receipt")) {
      const rc = b.receipt;
      lines.push({ date: b.date, type: "bill", ref_id: rc.id, text: `${b.no} · ${b.detail}`,
        refs: `PO-${String(rc.order_id).padStart(4, "0")} · R-${String(rc.id).padStart(4, "0")}${rc.vehicle_number ? ` · ${rc.vehicle_number}` : ""}`,
        debit: 0, credit: b.amount });
    }
    for (const pm of pays) {
      const al = (allocByPayment.get(pm.id) || []).map((a) => {
        const b = billByKey.get(a.receipt_id ? `receipt:${a.receipt_id}` : `opening:${a.opening_bill_id}`);
        return b ? `${b.no} ₹${r(p(a.amount)).toLocaleString("en-IN")}` : null;
      }).filter(Boolean);
      lines.push({ date: pm.paid_on, type: "payment", ref_id: pm.id,
        text: `${pm.mode.toUpperCase()}${pm.reference ? ` · ${pm.reference}` : ""}${Number(pm.tds_amount) ? ` · TDS ₹${Number(pm.tds_amount).toLocaleString("en-IN")}` : ""}`,
        refs: al.length ? `Against ${al.join(" · ")}` : "Settles the oldest bills",
        debit: p(pm.amount) + p(pm.tds_amount), credit: 0, payment: pm });
    }
    const order = { opening: 0, bill: 1, payment: 2 };
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : order[a.type] - order[b.type]));
    let bal = 0;
    for (const l of lines) { bal += l.credit - l.debit; l.balance = bal; }

    const purchases = open.filter((b) => b.kind === "receipt").reduce((t, b) => t + b.amount, 0);
    const paid = pays.reduce((t, x) => t + p(x.amount) + p(x.tds_amount), 0);
    const overdue = openBills.filter((b) => b.overdue).reduce((t, b) => t + p(b.outstanding), 0);
    const due7 = openBills.filter((b) => !b.overdue && daysBetween(asOn, b.due_date) <= 7).reduce((t, b) => t + p(b.outstanding), 0);
    const lastPay = pays.length ? pays[pays.length - 1] : null;
    const limit = s.credit_limit == null ? null : p(s.credit_limit);
    const exposure = bal + notBilledValue;

    out.push({
      supplier: { id: s.id, name: s.name, gstin: s.gstin, contact_person: s.contact_person, phone: s.phone, is_active: s.is_active,
        credit_days: s.credit_days == null ? null : Number(s.credit_days), credit_limit: s.credit_limit == null ? null : Number(s.credit_limit),
        materials: s.materials || "" },
      opening: opening ? { ...opening, amount: r((openingBillsBy.get(s.id) || []).reduce((t, b) => t + p(b.amount), 0)),
        bills: (openingBillsBy.get(s.id) || []).map((b) => ({ ...b, amount: Number(b.amount) })) } : null,
      opening_signed: opening ? r((opening.direction === "payable" ? 1 : -1) * (openingBillsBy.get(s.id) || []).reduce((t, b) => t + p(b.amount), 0)) : 0,
      purchases: r(purchases), paid: r(paid), balance: r(bal),
      overdue: r(overdue), due_7_days: r(due7),
      oldest_overdue_days: openBills.filter((b) => b.overdue).reduce((m, b) => Math.max(m, b.days_late), 0),
      last_payment: lastPay ? { date: lastPay.paid_on, amount: Number(lastPay.amount) + Number(lastPay.tds_amount) } : null,
      not_billed: notBilled, not_billed_value: r(notBilledValue), not_billed_count: notBilled.length,
      exposure: r(exposure),
      limit_used_pct: limit ? Math.round((Math.max(exposure, 0) / limit) * 100) : null,
      over_limit: limit != null && exposure > limit, over_limit_by: limit != null && exposure > limit ? r(exposure - limit) : 0,
      open_bills: openBills,
      lines: lines.map((l) => ({ ...l, debit: r(l.debit), credit: r(l.credit), balance: r(l.balance) })),
    });
  }
  return out;
}

// The credit check a new order makes: balance + not billed + this order.
export async function creditCheck(supplierId, asOn, orderValue) {
  const [l] = await buildLedgers({ supplierIds: [Number(supplierId)], asOn });
  if (!l) return null;
  const limit = l.supplier.credit_limit;
  const after = l.exposure + Number(orderValue || 0);
  return {
    supplier_name: l.supplier.name, credit_limit: limit, balance: l.balance, not_billed: l.not_billed_value,
    order_value: Number(orderValue || 0), exposure_after: Math.round(after * 100) / 100,
    over_limit: limit != null && after > limit, over_by: limit != null && after > limit ? Math.round((after - limit) * 100) / 100 : 0,
    overdue: l.overdue,
  };
}
