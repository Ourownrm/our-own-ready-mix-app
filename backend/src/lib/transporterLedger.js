// Round 200 — the transporter ledger: freight we owe each transporter, and
// what has been paid. Built the same way as the supplier ledger (Round 193,
// lib/supplierLedger.js) so the two read alike.
//
// THE RULES:
//   * A freight BILL is a receipt on an EX-FACTORY order that names a
//     transporter. On a delivered order the supplier carries the freight and
//     bills it to us inside the material bill, so the transporter is owed
//     nothing by us.
//   * The amount is the receipt's own freight (rate and basis as saved on the
//     receipt — per purchase unit, per kg, or per trip — on the ACCEPTED
//     quantity), plus the transporter's GST % if one is set on the master.
//   * Only receipts that count (rm_receipts_effective) are bills. One waiting
//     for a Manager or for Admin is "received, not billed" — shown, not owed.
//   * A load with no freight rate is listed so somebody fixes the rate; it
//     owes nothing until then.
//   * Payments are never deleted, only cancelled. Each payment (plus its TDS)
//     settles the oldest open freight first, so the ages stay right without
//     anyone allocating by hand.
//
// Money is handled in paise (integers), as in the supplier ledger.
import { query } from "../db.js";
import { computeFreightTotal, addDays, daysBetween } from "./supplierLedger.js";

export const TRANSPORTER_LEDGER_SQL = `
ALTER TABLE rm_transporters ADD COLUMN IF NOT EXISTS gstin VARCHAR(20);
ALTER TABLE rm_transporters ADD COLUMN IF NOT EXISTS pan VARCHAR(12);
ALTER TABLE rm_transporters ADD COLUMN IF NOT EXISTS credit_days INTEGER;
ALTER TABLE rm_transporters ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS rm_transporter_openings (
  transporter_id INTEGER PRIMARY KEY REFERENCES rm_transporters(id),
  as_on          DATE NOT NULL,
  direction      VARCHAR(8) NOT NULL CHECK (direction IN ('payable','advance')),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  remarks        TEXT,
  set_by         INTEGER REFERENCES users(id),
  set_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_transporter_payments (
  id             SERIAL PRIMARY KEY,
  transporter_id INTEGER NOT NULL REFERENCES rm_transporters(id),
  paid_on        DATE NOT NULL,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  tds_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  mode           VARCHAR(10) NOT NULL CHECK (mode IN ('neft','rtgs','cheque','upi','cash','other')),
  reference      VARCHAR(80),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at   TIMESTAMPTZ,
  cancelled_by   INTEGER REFERENCES users(id),
  cancel_reason  TEXT
);
CREATE INDEX IF NOT EXISTS rm_transporter_payments_t ON rm_transporter_payments (transporter_id, paid_on);
`;

export async function migrateTransporterLedger(pool, log) {
  await pool.query(TRANSPORTER_LEDGER_SQL);
  log.push("Schema migration applied (Round 200 — transporter ledger: freight owed, payments, opening balances).");
}

const p = (n) => Math.round(Number(n || 0) * 100);
const r = (n) => Math.round(n) / 100;

function freightOf(row, gstPct) {
  const base = computeFreightTotal(row.freight_rate, row.freight_basis, Number(row.accepted_qty), Number(row.accepted_qty_kg));
  return Math.round(base * (1 + Number(gstPct || 0) / 100) * 100) / 100;
}

async function load(ids) {
  const only = ids && ids.length ? ids : null;
  const [tr, openings, bills, waiting, payments] = await Promise.all([
    query(`SELECT * FROM rm_transporters WHERE ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY name`, [only]),
    query(`SELECT transporter_id, to_char(as_on, 'YYYY-MM-DD') AS as_on, direction, amount, remarks, set_at,
                  (SELECT name FROM users u WHERE u.id = o.set_by) AS set_by_name
           FROM rm_transporter_openings o WHERE ($1::int[] IS NULL OR transporter_id = ANY($1::int[]))`, [only]),
    query(
      `SELECT r.id, r.transporter_id, o.id AS order_id, to_char(r.received_date, 'YYYY-MM-DD') AS date,
              r.accepted_qty, r.accepted_qty_kg, r.freight_rate, r.freight_basis, r.vehicle_number, r.challan_number,
              COALESCE(src.purchase_unit, m.purchase_unit) AS unit, m.name AS material_name, s.name AS supplier_name
         FROM rm_receipts_effective r
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         JOIN rm_suppliers s ON s.id = o.supplier_id
         LEFT JOIN rm_material_sources src ON src.id = o.source_id
        WHERE o.scope = 'ex_factory' AND r.transporter_id IS NOT NULL
          AND ($1::int[] IS NULL OR r.transporter_id = ANY($1::int[]))
        ORDER BY r.received_date, r.id`, [only]),
    query(
      // receipts-raw: a receipt still waiting (Manager or Admin) is exactly what "received, not billed" shows
      `SELECT r.id, r.transporter_id, to_char(r.received_date, 'YYYY-MM-DD') AS date, r.accepted_qty, r.accepted_qty_kg,
              r.freight_rate, r.freight_basis, r.vehicle_number, r.confirmation_status, r.wb_approval,
              COALESCE(src.purchase_unit, m.purchase_unit) AS unit, m.name AS material_name, s.name AS supplier_name
         FROM rm_receipts r   -- receipts-raw: the waiting ones are the point here
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         JOIN rm_suppliers s ON s.id = o.supplier_id
         LEFT JOIN rm_material_sources src ON src.id = o.source_id
        WHERE o.scope = 'ex_factory' AND r.transporter_id IS NOT NULL
          AND (r.confirmation_status = 'pending' OR r.wb_approval = 'pending')
          AND ($1::int[] IS NULL OR r.transporter_id = ANY($1::int[]))`, [only]),
    query(
      `SELECT pm.id, pm.transporter_id, to_char(pm.paid_on, 'YYYY-MM-DD') AS paid_on, pm.amount, pm.tds_amount,
              pm.mode, pm.reference, pm.notes, pm.created_at, (SELECT name FROM users u WHERE u.id = pm.created_by) AS created_by_name
         FROM rm_transporter_payments pm
        WHERE pm.cancelled_at IS NULL AND ($1::int[] IS NULL OR pm.transporter_id = ANY($1::int[]))
        ORDER BY pm.paid_on, pm.id`, [only]),
  ]);
  return { tr: tr.rows, openings: openings.rows, bills: bills.rows, waiting: waiting.rows, payments: payments.rows };
}

function group(rows, key = "transporter_id") {
  const m = new Map();
  for (const row of rows) { if (!m.has(row[key])) m.set(row[key], []); m.get(row[key]).push(row); }
  return m;
}

// The ledger for each transporter as on `asOn` (YYYY-MM-DD).
export async function buildTransporterLedgers({ transporterIds = null, asOn }) {
  const d = await load(transporterIds);
  const openingBy = new Map(d.openings.map((o) => [o.transporter_id, o]));
  const billsBy = group(d.bills), waitingBy = group(d.waiting), paymentsBy = group(d.payments);
  const out = [];
  for (const t of d.tr) {
    const opening = openingBy.get(t.id) || null;
    const creditDays = t.credit_days == null ? 0 : Number(t.credit_days);
    const open = [];
    const noRate = [];
    if (opening && opening.direction === "payable" && Number(opening.amount) > 0) {
      open.push({ kind: "opening", id: 0, no: "Opening", date: opening.as_on, amount: p(opening.amount), detail: "Opening balance" });
    }
    let trips = 0, qtyKg = 0;
    for (const b of billsBy.get(t.id) || []) {
      if (b.date > asOn) continue;
      if (!b.freight_rate) { noRate.push({ id: b.id, date: b.date, material_name: b.material_name, vehicle: b.vehicle_number }); continue; }
      trips++; qtyKg += Number(b.accepted_qty_kg || 0);
      open.push({ kind: "receipt", id: b.id, no: `R-${String(b.id).padStart(4, "0")}`, date: b.date, amount: p(freightOf(b, t.gst_pct)), bill: b,
        detail: `${b.material_name} from ${b.supplier_name} · ${Number(b.accepted_qty)} ${b.unit}` });
    }
    open.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind === "opening" ? -1 : a.id - b.id)));
    for (const b of open) b.settled = 0;

    const pays = (paymentsBy.get(t.id) || []).filter((x) => x.paid_on <= asOn);
    let pool = pays.reduce((s, x) => s + p(x.amount) + p(x.tds_amount), 0);
    if (opening && opening.direction === "advance") pool += p(opening.amount);
    for (const b of open) {
      if (pool <= 0) break;
      const take = Math.min(pool, b.amount - b.settled);
      b.settled += take; pool -= take;
    }
    const openBills = open.filter((b) => b.amount - b.settled > 0).map((b) => {
      const due = addDays(b.date, b.kind === "opening" ? 0 : creditDays);
      const late = daysBetween(due, asOn);
      return { kind: b.kind, id: b.id, no: b.no, date: b.date, due_date: due, amount: r(b.amount), outstanding: r(b.amount - b.settled),
        days_late: late > 0 ? late : 0, overdue: late > 0, detail: b.detail, vehicle: b.bill?.vehicle_number || null };
    });

    const notBilled = (waitingBy.get(t.id) || []).map((w) => ({
      id: w.id, date: w.date, material_name: w.material_name, supplier_name: w.supplier_name, vehicle: w.vehicle_number,
      value: w.freight_rate ? freightOf(w, t.gst_pct) : null,
      note: [w.confirmation_status === "pending" ? "waiting for a Manager (quantity)" : null, w.wb_approval === "pending" ? "waiting for Admin (no weighbridge ticket)" : null].filter(Boolean).join("; "),
    }));

    const lines = [];
    if (opening && Number(opening.amount) > 0) {
      lines.push({ date: opening.as_on, type: "opening", text: opening.direction === "payable" ? "Opening balance — owed to transporter" : "Opening balance — advance paid",
        refs: opening.remarks || "", debit: opening.direction === "advance" ? p(opening.amount) : 0, credit: opening.direction === "payable" ? p(opening.amount) : 0 });
    }
    for (const b of open.filter((x) => x.kind === "receipt")) {
      const bl = b.bill;
      const basis = bl.freight_basis === "per_trip" ? "per trip" : bl.freight_basis === "per_kg" ? "/kg" : `/${bl.unit}`;
      lines.push({ date: b.date, type: "freight", ref_id: bl.id, text: `${b.no} · ${b.detail}`,
        refs: `₹${Number(bl.freight_rate).toLocaleString("en-IN")} ${basis}${Number(t.gst_pct) ? ` + GST ${Number(t.gst_pct)}%` : ""}${bl.vehicle_number ? ` · ${bl.vehicle_number}` : ""}`,
        debit: 0, credit: b.amount });
    }
    for (const pm of pays) {
      lines.push({ date: pm.paid_on, type: "payment", ref_id: pm.id,
        text: `${pm.mode.toUpperCase()}${pm.reference ? ` · ${pm.reference}` : ""}${Number(pm.tds_amount) ? ` · TDS ₹${Number(pm.tds_amount).toLocaleString("en-IN")}` : ""}`,
        refs: pm.notes || "", debit: p(pm.amount) + p(pm.tds_amount), credit: 0, payment: pm });
    }
    const order = { opening: 0, freight: 1, payment: 2 };
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : order[a.type] - order[b.type]));
    let bal = 0;
    for (const l of lines) { bal += l.credit - l.debit; l.balance = bal; }

    const freight = open.filter((b) => b.kind === "receipt").reduce((s, b) => s + b.amount, 0);
    const paid = pays.reduce((s, x) => s + p(x.amount) + p(x.tds_amount), 0);
    const overdue = openBills.filter((b) => b.overdue).reduce((s, b) => s + p(b.outstanding), 0);
    const lastPay = pays.length ? pays[pays.length - 1] : null;
    out.push({
      transporter: { id: t.id, name: t.name, phone: t.phone, gstin: t.gstin, pan: t.pan, is_active: t.is_active,
        credit_days: t.credit_days == null ? null : Number(t.credit_days), gst_pct: Number(t.gst_pct || 0) },
      opening: opening ? { ...opening, amount: Number(opening.amount) } : null,
      opening_signed: opening ? (opening.direction === "payable" ? 1 : -1) * Number(opening.amount) : 0,
      trips, qty_mt: Math.round(qtyKg / 10) / 100,
      freight: r(freight), paid: r(paid), balance: r(bal), overdue: r(overdue),
      oldest_overdue_days: openBills.filter((b) => b.overdue).reduce((m, b) => Math.max(m, b.days_late), 0),
      last_payment: lastPay ? { date: lastPay.paid_on, amount: Number(lastPay.amount) + Number(lastPay.tds_amount) } : null,
      not_billed: notBilled, not_billed_value: Math.round(notBilled.reduce((s, x) => s + (x.value || 0), 0) * 100) / 100,
      no_rate: noRate,
      open_bills: openBills,
      lines: lines.map((l) => ({ ...l, debit: r(l.debit), credit: r(l.credit), balance: r(l.balance) })),
    });
  }
  return out;
}
