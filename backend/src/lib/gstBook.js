// Round 236 (owner, 23 Oct 2026; mock-up "GST payable — Monthly"). GST on
// sales (output) less the GST paid on purchases that can be claimed (input
// tax credit) = the cash to pay with GSTR-3B. A working sheet for the CA, not
// a filing.
//
// Output — the tax invoices (rates are GST-inclusive, 18%: CGST 9 + SGST 9,
//   IGST 18 when the customer's GSTIN is from another state). Invoices with
//   GST switched off by the Accountant are counted apart, with no tax.
// Input — every purchase the app records with its GST:
//   raw material receipts (order GST %, supplier GSTIN, their invoice no.),
//   freight on ex-factory loads (transporter's GST %; none → reverse charge 5%),
//   maintenance GRVs (PO line GST %) and outside-repair bills (18% inside),
//   contractor bills (their GST), bank-statement cost lines (GST % per line),
//   C Ledger expenses flagged "with GST" (18% inside — C Ledger's own flag).
// The quiet flag (owner): every purchase starts WITHOUT the flag = the bill
//   has tax. The Accountant flags a bill that came without tax: no credit.
//   Receipts, maintenance bills and contractor bills carry `no_tax`; a bank
//   line uses its own "no input credit" tick. Nothing on the entry screens.
// GSTR-2B — the suppliers' filed invoices, uploaded each month. Credit is
//   claimed in the month its invoice is in 2B (or later, if 2B comes late);
//   until then it is held and carried. A month whose 2B is not uploaded claims
//   everything (marked as an estimate).
// Set-off (Rule 88A): IGST credit first against IGST, then CGST, then SGST;
//   CGST credit against CGST then IGST; SGST against SGST then IGST. What is
//   left is cash; unused credit carries to the next month.
import { query } from "../db.js";
import { MONTH_RE, monthBounds, addMonths, monthLabel } from "./costDashboard.js";
import { computeFreightTotal } from "./supplierLedger.js";
import { CL_CATEGORIES, CL_FACTOR } from "./cLedger.js";
import { BANK_HEADS } from "./bankBook.js";
import { istMonth } from "./istDate.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const GST_PCT = 18;

export const ROUND236_SQL = `
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS no_tax BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS no_tax_by INTEGER REFERENCES users(id);
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS no_tax_at TIMESTAMPTZ;
-- The view was made with SELECT *: made again so it carries the new columns.
CREATE OR REPLACE VIEW rm_receipts_effective AS
  SELECT * FROM rm_receipts WHERE confirmation_status <> 'pending' AND wb_approval NOT IN ('pending','rejected');   -- receipts-raw: this IS the view's definition
ALTER TABLE mnt_bills ADD COLUMN IF NOT EXISTS no_tax BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mnt_bills ADD COLUMN IF NOT EXISTS no_tax_by INTEGER REFERENCES users(id);
ALTER TABLE mnt_bills ADD COLUMN IF NOT EXISTS no_tax_at TIMESTAMPTZ;
ALTER TABLE hr_contractor_bills ADD COLUMN IF NOT EXISTS no_tax BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hr_contractor_bills ADD COLUMN IF NOT EXISTS no_tax_by INTEGER REFERENCES users(id);
ALTER TABLE hr_contractor_bills ADD COLUMN IF NOT EXISTS no_tax_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS gst_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  from_month  CHAR(7),
  our_state   CHAR(2) NOT NULL DEFAULT '32',
  open_igst   NUMERIC(14,2) NOT NULL DEFAULT 0,
  open_cgst   NUMERIC(14,2) NOT NULL DEFAULT 0,
  open_sgst   NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ
);
INSERT INTO gst_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS gst_2b_uploads (
  id           SERIAL PRIMARY KEY,
  period       CHAR(7) NOT NULL UNIQUE,
  file_name    VARCHAR(200),
  lines        INTEGER NOT NULL DEFAULT 0,
  uploaded_by  INTEGER REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gst_2b_lines (
  id          SERIAL PRIMARY KEY,
  upload_id   INTEGER NOT NULL REFERENCES gst_2b_uploads(id) ON DELETE CASCADE,
  period      CHAR(7) NOT NULL,
  gstin       VARCHAR(20) NOT NULL,
  trade_name  VARCHAR(200),
  inv_no      VARCHAR(60),
  inv_date    DATE,
  inv_value   NUMERIC(14,2),
  taxable     NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst        NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst        NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst        NUMERIC(14,2) NOT NULL DEFAULT 0,
  cess        NUMERIC(14,2) NOT NULL DEFAULT 0,
  rcm         BOOLEAN NOT NULL DEFAULT false,
  itc_ok      BOOLEAN NOT NULL DEFAULT true,
  kind        VARCHAR(6) NOT NULL DEFAULT 'inv' CHECK (kind IN ('inv','cn','dn')),
  ignored     BOOLEAN NOT NULL DEFAULT false,
  ignored_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_gst_2b_lines_period ON gst_2b_lines(period);
CREATE TABLE IF NOT EXISTS gst_challans (
  id          SERIAL PRIMARY KEY,
  month       CHAR(7) NOT NULL,
  cpin        VARCHAR(30),
  paid_on     DATE NOT NULL,
  igst        NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst        NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst        NUMERIC(14,2) NOT NULL DEFAULT 0,
  interest    NUMERIC(14,2) NOT NULL DEFAULT 0,
  late_fee    NUMERIC(14,2) NOT NULL DEFAULT 0,
  note        VARCHAR(200),
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gst_challans_month ON gst_challans(month) WHERE deleted_at IS NULL;
`;
let ready = null;
export function ensureRound236() {
  if (!ready) ready = query(ROUND236_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound236(pool, log) {
  await pool.query(ROUND236_SQL);
  log?.push?.("Round 236: GST payable — input credit, the no-tax flag on purchases, GSTR-2B, challans.");
}

// ------------------------------------------------------------ helpers ---
const stateOf = (gstin) => (/^\d{2}[A-Z0-9]{13}$/i.test(String(gstin || "").trim()) ? String(gstin).trim().slice(0, 2) : null);
// Invoice numbers compared without punctuation or padding zeros: INV/0001 = INV-1.
export const invKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(^|[A-Z])0+(?=\d)/g, "$1");
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
const ymOf = (d) => String(d || "").slice(0, 7);
const maxYm = (a, b) => (a > b ? a : b);
const dayNum = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86400000;
const inside = (amt, pct) => (pct > 0 ? r2(amt - (amt * 100) / (100 + pct)) : 0);  // tax inside a tax-inclusive amount

export async function gstSettings() {
  await ensureRound236();
  const { rows } = await query(`SELECT * FROM gst_settings WHERE id = 1`);
  const s = rows[0] || {};
  let from = s.from_month;
  if (!from) {
    const { rows: f } = await query(
      `SELECT to_char(MIN(dt.ticket_date), 'YYYY-MM') AS m FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id`).catch(() => ({ rows: [{}] }));
    from = f[0]?.m || istMonth();
  }
  return { from_month: from, from_set: !!s.from_month, our_state: s.our_state || "32",
    open: { igst: n0(s.open_igst), cgst: n0(s.open_cgst), sgst: n0(s.open_sgst) } };
}

// ----------------------------------------------------- output (sales) ---
async function outputRange(from, end, ourState) {
  const { rows } = await query(
    `SELECT to_char(dt.ticket_date, 'YYYY-MM') AS ym, i.total_amount, i.gst_applied, i.billing_gstin,
            i.concrete_amount, COALESCE(i.pumping_charge, 0) + COALESCE(i.part_load_charge, 0) + COALESCE(i.waiting_charge, 0) AS other,
            COALESCE(i.rejected_quantity_m3, 0) AS rej
       FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
      WHERE dt.ticket_date BETWEEN $1::date AND $2::date AND dt.status <> 'cancelled'`, [from, end]);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.ym)) by.set(r.ym, { invoices: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, total: 0, concrete_taxable: 0, other_taxable: 0,
      off: { n: 0, amount: 0 }, rejections: 0, inter: 0 });
    const m = by.get(r.ym);
    const total = n0(r.total_amount);
    if (n0(r.rej) > 0) m.rejections += 1;
    if (r.gst_applied === false) { m.off.n += 1; m.off.amount += total; continue; }
    m.invoices += 1;
    const base = (total * 100) / (100 + GST_PCT);
    const gst = total - base;
    m.taxable += base; m.total += total;
    const share = n0(r.concrete_amount) + n0(r.other) > 0 ? n0(r.concrete_amount) / (n0(r.concrete_amount) + n0(r.other)) : 1;
    m.concrete_taxable += base * share; m.other_taxable += base * (1 - share);
    const st = stateOf(r.billing_gstin);
    if (st && st !== ourState) { m.igst += gst; m.inter += 1; } else { m.cgst += gst / 2; m.sgst += gst / 2; }
  }
  for (const m of by.values()) for (const k of ["taxable", "igst", "cgst", "sgst", "total", "concrete_taxable", "other_taxable"]) m[k] = r2(m[k]);
  return by;
}

// ---------------------------------------------- input (purchases) ---
// One row per purchase: { key, src, group, id, day, ym, party, gstin, inv_no,
// taxable, gst, pct, no_tax, can_flag, reason }. gst = 0 rows are kept for the
// "no credit" lists.
async function inputItems(from, end) {
  const safe = (p) => p.then((r) => r.rows).catch((e) => { console.error("gst input:", e.message); return []; });
  const [rec, freight, grv, outside, contr, bank, cl, fuel] = await Promise.all([
    safe(query(
      `SELECT r.id, COALESCE(r.invoice_date, r.received_date)::text AS day, r.challan_number AS inv_no, r.bill_amount, r.no_tax,
              o.tax_pct, s.id AS party_id, s.name AS party, s.gstin, m.name AS material
         FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id JOIN rm_suppliers s ON s.id = o.supplier_id
         JOIN rm_materials m ON m.id = o.material_id
        WHERE COALESCE(r.invoice_date, r.received_date) BETWEEN $1::date AND $2::date AND r.bill_amount IS NOT NULL`, [from, end])),
    safe(query(
      `SELECT r.id, r.received_date::text AS day, r.challan_number AS inv_no, r.accepted_qty, r.accepted_qty_kg, r.freight_rate, r.freight_basis,
              t.id AS party_id, t.name AS party, t.gstin, COALESCE(t.gst_pct, 0) AS gst_pct
         FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id JOIN rm_transporters t ON t.id = r.transporter_id
        WHERE o.scope = 'ex_factory' AND r.received_date BETWEEN $1::date AND $2::date AND COALESCE(r.freight_rate, 0) > 0`, [from, end])),
    safe(query(
      `SELECT b.id, COALESCE(b.bill_date, g.grv_date)::text AS day, b.bill_no AS inv_no, b.payee AS party, b.no_tax, b.amount,
              (SELECT COALESCE(SUM(gl.value), 0) FROM mnt_grv_lines gl WHERE gl.grv_id = g.id) AS value,
              (SELECT COALESCE(SUM(gl.value * pl.gst_pct / (100 + pl.gst_pct)), 0) FROM mnt_grv_lines gl JOIN mnt_po_lines pl ON pl.id = gl.po_line_id WHERE gl.grv_id = g.id) AS gst
         FROM mnt_bills b JOIN mnt_grvs g ON g.id = b.source_id
        WHERE b.source_type = 'grv' AND COALESCE(b.bill_date, g.grv_date) BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT b.id, COALESCE(b.bill_date, (o.returned_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS day, COALESCE(b.bill_no, o.bill_no) AS inv_no,
              b.payee AS party, b.no_tax, b.amount, a.name AS asset
         FROM mnt_bills b JOIN mnt_outside_repairs o ON o.id = b.source_id JOIN mnt_assets a ON a.id = o.asset_id
        WHERE b.source_type = 'outside_repair' AND NOT b.is_estimate
          AND COALESCE(b.bill_date, (o.returned_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT b.id, COALESCE(b.their_invoice_date, (to_date(b.month || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date)::text AS day,
              b.their_invoice_no AS inv_no, b.taxable, b.gst_rate, b.gst_amount, b.no_tax, c.id AS party_id, c.name AS party, c.gstin
         FROM hr_contractor_bills b JOIN hr_contractors c ON c.id = b.contractor_id
        WHERE b.status = 'approved'
          AND COALESCE(b.their_invoice_date, (to_date(b.month || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date) BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT l.id, l.txn_date::text AS day, l.narration AS party, l.head, l.debit, l.gst_pct, l.gst_claim
         FROM cost_bank_lines l
        WHERE l.treatment = 'cost' AND l.debit > 0 AND l.head IS NOT NULL AND l.head <> 'other_income'
          AND l.txn_date BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT x.id, x.txn_date::text AS day, x.where_spent AS party, x.category, x.amount, x.flagged
         FROM cl_expenses x WHERE x.deleted_at IS NULL AND x.txn_date BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT to_char((sp.received_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM') AS ym, SUM(sp.total_cost) AS v, COUNT(*)::int AS n
         FROM store_stock_purchases sp WHERE sp.status = 'received' AND sp.total_cost > 0
          AND (sp.received_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date GROUP BY 1`, [from, end])),
  ]);
  const items = [];
  const push = (x) => items.push({ ...x, ym: ymOf(x.day), taxable: r2(x.taxable), gst: r2(x.gst) });
  for (const r of rec) {
    const amt = n0(r.bill_amount), pct = n0(r.tax_pct);
    const gst = r.no_tax ? 0 : inside(amt, pct);
    push({ key: `rec:${r.id}`, src: "receipt", group: `Raw material — ${r.material}`, id: r.id, day: r.day, party: r.party, party_id: r.party_id,
      gstin: r.gstin, inv_no: r.inv_no, taxable: amt - gst, gst, pct, no_tax: r.no_tax, can_flag: true,
      reason: r.no_tax ? "flagged" : pct > 0 ? null : "no GST on the order" });
  }
  for (const r of freight) {
    const base = computeFreightTotal(r.freight_rate, r.freight_basis, Number(r.accepted_qty), Number(r.accepted_qty_kg));
    const pct = n0(r.gst_pct);
    if (pct > 0) {
      push({ key: `frt:${r.id}`, src: "freight", group: "Freight — transporters charging GST", id: r.id, day: r.day, party: r.party, gstin: r.gstin,
        inv_no: null, taxable: base, gst: (base * pct) / 100, pct, no_tax: false, can_flag: false, reason: null });
    } else {
      push({ key: `rcm:${r.id}`, src: "rcm", group: "Reverse charge — GTA freight 5%", id: r.id, day: r.day, party: r.party, gstin: r.gstin,
        inv_no: null, taxable: base, gst: base * 0.05, pct: 5, no_tax: false, can_flag: false, reason: null, rcm: true });
    }
  }
  for (const r of grv) {
    const gst = r.no_tax ? 0 : n0(r.gst);
    push({ key: `mnt:${r.id}`, src: "mnt_bill", group: "Spares — maintenance GRVs against POs", id: r.id, day: r.day, party: r.party, gstin: null,
      inv_no: r.inv_no, taxable: n0(r.value) - gst, gst, pct: n0(r.value) > 0 ? r2((n0(r.gst) * 100) / (n0(r.value) - n0(r.gst))) : 0,
      no_tax: r.no_tax, can_flag: true, reason: r.no_tax ? "flagged" : null });
  }
  for (const r of outside) {
    const gst = r.no_tax ? 0 : inside(n0(r.amount), GST_PCT);
    push({ key: `mnt:${r.id}`, src: "mnt_bill", group: "Outside repairs (18% inside the bill)", id: r.id, day: r.day, party: `${r.party} · ${r.asset}`,
      gstin: null, inv_no: r.inv_no, taxable: n0(r.amount) - gst, gst, pct: GST_PCT, no_tax: r.no_tax, can_flag: true, reason: r.no_tax ? "flagged" : null });
  }
  for (const r of contr) {
    const gst = r.no_tax ? 0 : n0(r.gst_amount);
    push({ key: `con:${r.id}`, src: "contractor_bill", group: "Contract labour — contractor bills", id: r.id, day: r.day, party: r.party, party_id: r.party_id,
      gstin: r.gstin, inv_no: r.inv_no, taxable: n0(r.taxable), gst, pct: n0(r.gst_rate), no_tax: r.no_tax, can_flag: true,
      reason: r.no_tax ? "flagged" : gst > 0 ? null : "contractor not charging GST" });
  }
  const headLabel = (k) => BANK_HEADS.find((h) => h.key === k)?.label || k;
  for (const r of bank) {
    const pct = n0(r.gst_pct), claim = r.gst_claim !== false;
    const gst = claim ? inside(n0(r.debit), pct) : 0;
    push({ key: `bank:${r.id}`, src: "bank", group: "Other costs paid from the bank", id: r.id, day: r.day, party: `${headLabel(r.head)} · ${String(r.party || "").slice(0, 60)}`,
      gstin: null, inv_no: null, taxable: n0(r.debit) - gst, gst, pct, no_tax: !claim && pct > 0, can_flag: false,
      reason: !claim && pct > 0 ? "flagged" : pct > 0 ? null : "no GST on the line" });
  }
  const costCat = new Set(CL_CATEGORIES.filter((c) => !c.notCost).map((c) => c.key));
  for (const r of cl) {
    if (!costCat.has(r.category)) continue;
    const gst = r.flagged ? r2(n0(r.amount) * (1 - CL_FACTOR)) : 0;
    push({ key: `cl:${r.id}`, src: "cledger", group: "C Ledger — cash expenses with GST", id: r.id, day: r.day, party: r.party, gstin: null, inv_no: null,
      taxable: n0(r.amount) - gst, gst, pct: r.flagged ? GST_PCT : 0, no_tax: false, can_flag: false, reason: r.flagged ? null : "C Ledger — not flagged" });
  }
  const fuelBy = new Map(fuel.map((f) => [f.ym, { amount: r2(f.v), n: f.n }]));
  return { items, fuelBy };
}

// ------------------------------------------------------------ GSTR-2B ---
async function twoB(fromYm, toYm) {
  const { rows } = await query(
    `SELECT l.*, l.inv_date::text AS inv_day FROM gst_2b_lines l WHERE l.period BETWEEN $1 AND $2 ORDER BY l.period, l.id`, [fromYm, toYm]);
  const { rows: ups } = await query(
    `SELECT u.period, u.file_name, u.lines, u.uploaded_at, us.name AS by_name FROM gst_2b_uploads u LEFT JOIN users us ON us.id = u.uploaded_by
      WHERE u.period BETWEEN $1 AND $2`, [fromYm, toYm]);
  return { lines: rows.map((l) => ({ ...l, tax: r2(n0(l.igst) + n0(l.cgst) + n0(l.sgst)), key: invKey(l.inv_no) })), uploads: ups };
}

// Match purchases to 2B lines, most certain first.
function match(items, lines) {
  const free = lines.filter((l) => l.kind === "inv" && !l.rcm && l.itc_ok);
  const used = new Set();
  const take = (item, l) => { used.add(l.id); item.match = { id: l.id, period: l.period, tax: l.tax, gstin: l.gstin, inv_no: l.inv_no, name: l.trade_name }; };
  const close = (a, b) => Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.01);
  const claimable = items.filter((i) => i.gst > 0 && !i.rcm);
  // 1 · same GSTIN and invoice number
  for (const i of claimable) {
    if (!i.gstin || !i.inv_no) continue;
    const k = invKey(i.inv_no), dk = digits(i.inv_no), g = String(i.gstin).toUpperCase();
    const l = free.find((x) => !used.has(x.id) && x.gstin.toUpperCase() === g && (x.key === k || (dk.length >= 3 && digits(x.inv_no) === dk)));
    if (l) take(i, l);
  }
  // 2 · same invoice number and about the same tax (no GSTIN in the app)
  for (const i of claimable) {
    if (i.match || !i.inv_no) continue;
    const k = invKey(i.inv_no);
    const l = free.find((x) => !used.has(x.id) && x.key === k && close(x.tax, i.gst));
    if (l) take(i, l);
  }
  // 3 · same GSTIN, about the same tax, within 20 days
  for (const i of claimable) {
    if (i.match || !i.gstin) continue;
    const g = String(i.gstin).toUpperCase();
    const l = free.find((x) => !used.has(x.id) && x.gstin.toUpperCase() === g && close(x.tax, i.gst) && x.inv_day && Math.abs(dayNum(x.inv_day) - dayNum(i.day)) <= 20);
    if (l) take(i, l);
  }
  // 4 · bank / C Ledger / no invoice: the same tax (₹1), within 20 days
  for (const i of claimable) {
    if (i.match) continue;
    const l = free.find((x) => !used.has(x.id) && Math.abs(x.tax - i.gst) <= 1 && x.inv_day && Math.abs(dayNum(x.inv_day) - dayNum(i.day)) <= 20);
    if (l) take(i, l);
  }
  return used;
}

// ----------------------------------------------------- the whole book ---
const ZERO = () => ({ igst: 0, cgst: 0, sgst: 0 });
function setOff(out, cred) {
  // out, cred: { igst, cgst, sgst }. Returns { used, cash, left } per head.
  const o = { ...out }, c = { ...cred };
  const used = { igst: ZERO(), cgst: ZERO(), sgst: ZERO() };   // used[creditHead][againstHead]
  const use = (from, to) => { const x = Math.min(c[from], o[to]); if (x > 0) { c[from] -= x; o[to] -= x; used[from][to] += x; } };
  use("igst", "igst");
  // IGST credit goes first (the law), split between CGST and SGST so it covers
  // what their own credit can't — that leaves the least to pay in cash.
  const gapC = Math.max(0, o.cgst - c.cgst), gapS = Math.max(0, o.sgst - c.sgst);
  const toC = Math.min(c.igst, gapC, Math.max(c.igst - gapS, c.igst * (gapC / ((gapC + gapS) || 1))));
  if (toC > 0) { c.igst -= toC; o.cgst -= toC; used.igst.cgst += toC; }
  use("igst", "sgst"); use("igst", "cgst");
  use("cgst", "cgst"); use("cgst", "igst");
  use("sgst", "sgst"); use("sgst", "igst");
  const rnd = (x) => ({ igst: r2(x.igst), cgst: r2(x.cgst), sgst: r2(x.sgst) });
  return { cash: rnd(o), left: rnd(c), used: { igst: rnd(used.igst), cgst: rnd(used.cgst), sgst: rnd(used.sgst) } };
}
const split = (gst, inter) => (inter ? { igst: gst, cgst: 0, sgst: 0 } : { igst: 0, cgst: gst / 2, sgst: gst / 2 });
const add = (a, b) => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst });

export async function gstMonth(ym) {
  await ensureRound236();
  const s = await gstSettings();
  const from = s.from_month <= ym ? s.from_month : ym;
  const fromDay = monthBounds(from).from, { end } = monthBounds(ym);
  const [outBy, inp, b2, challans, missing] = await Promise.all([
    outputRange(fromDay, end, s.our_state),
    inputItems(fromDay, end),
    twoB(addMonths(from, -1), ym),
    query(`SELECT c.*, c.paid_on::text AS paid_on, u.name AS by_name FROM gst_challans c LEFT JOIN users u ON u.id = c.created_by
            WHERE c.deleted_at IS NULL AND c.month BETWEEN $1 AND $2 ORDER BY c.paid_on, c.id`, [from, ym]),
    query(`SELECT COUNT(*)::int AS n FROM rm_suppliers WHERE is_active AND COALESCE(gstin, '') = ''`).catch(() => ({ rows: [{ n: 0 }] })),
  ]);
  const items = inp.items;
  const usedLines = match(items, b2.lines);
  const has2B = new Set(b2.uploads.map((u) => u.period));
  const inter = (i) => { const st = stateOf(i.gstin); return !!st && st !== s.our_state; };
  // When each purchase's credit is claimed.
  for (const i of items) {
    if (!(i.gst > 0)) { i.status = "none"; continue; }
    if (i.rcm) { i.claim_ym = i.ym; i.status = "rcm"; continue; }
    if (i.match) {
      i.claim_ym = maxYm(i.ym, i.match.period); i.status = "in2b";
      // Claimed as in 2B when the supplier filed less than the bill shows.
      if (i.match.tax < i.gst - 1) { i.short = r2(i.gst - i.match.tax); i.claim_gst = i.match.tax; }
      continue;
    }
    if (!has2B.has(i.ym)) { i.claim_ym = i.ym; i.status = "no2b"; continue; }
    i.claim_ym = null; i.status = "held";
  }

  // Month by month from the start month: credit claimed, set-off, carried.
  let carry = { ...s.open };
  const months = [];
  for (let m = from; m <= ym; m = addMonths(m, 1)) {
    const o = outBy.get(m) || { taxable: 0, igst: 0, cgst: 0, sgst: 0, invoices: 0, off: { n: 0, amount: 0 }, rejections: 0, inter: 0, concrete_taxable: 0, other_taxable: 0 };
    let cred = ZERO(), rcm = ZERO();
    for (const i of items) {
      if (i.claim_ym !== m) continue;
      const sp = split(i.claim_gst ?? i.gst, i.rcm ? false : inter(i));
      cred = add(cred, sp);
      if (i.rcm) rcm = add(rcm, sp);
    }
    const avail = add(carry, cred);
    const so = setOff({ igst: o.igst, cgst: o.cgst, sgst: o.sgst }, avail);
    // Reverse charge is paid in cash (it can't be set off) — and claimed back above.
    const cash = add(so.cash, rcm);
    months.push({ ym: m, output: o, credit_new: cred, carried_in: carry, rcm, setoff: so, cash: { igst: r2(cash.igst), cgst: r2(cash.cgst), sgst: r2(cash.sgst) } });
    carry = so.left;
  }
  const cur = months[months.length - 1];
  const prev = months.length > 1 ? months[months.length - 2] : null;

  // This month's purchases, the held ones (any month up to now), 2B not in the app.
  const mine = items.filter((i) => i.ym === ym);
  const groups = new Map();
  for (const i of [...mine, ...items.filter((x) => x.ym < ym && x.claim_ym === ym)]) {
    if (!(i.gst > 0)) continue;
    const g = groups.get(i.group) || { group: i.group, src: i.src, rates: new Set(), taxable: 0, gst: 0, in2b: 0, held: 0, claim: 0, n: 0, earlier: 0 };
    g.rates.add(i.pct); g.n += 1;
    if (i.ym === ym) { g.taxable += i.taxable; g.gst += i.gst; if (i.status === "held" || (i.claim_ym && i.claim_ym > ym)) g.held += i.gst; if (i.match) g.in2b += i.gst; }
    if (i.claim_ym === ym) { g.claim += i.claim_gst ?? i.gst; if (i.ym < ym) g.earlier += i.claim_gst ?? i.gst; }
    groups.set(i.group, g);
  }
  const heldAll = items.filter((i) => i.gst > 0 && i.ym <= ym && (i.status === "held" || (i.claim_ym && i.claim_ym > ym)));
  const bySupplier = new Map();
  for (const i of mine.filter((x) => x.gst > 0 && !x.rcm)) {
    const k = i.gstin || `name:${i.party}`;
    const g = bySupplier.get(k) || { party: i.party, gstin: i.gstin || null, n: 0, gst: 0, in2b: 0, held: 0 };
    g.n += 1; g.gst += i.gst; if (i.match) g.in2b += i.gst; if (i.status === "held" || (i.claim_ym && i.claim_ym > ym)) g.held += i.gst;
    bySupplier.set(k, g);
  }
  const notInApp = b2.lines.filter((l) => l.period === ym && !usedLines.has(l.id) && l.kind === "inv" && !l.rcm && l.itc_ok);
  const per = b2.lines.filter((l) => l.period === ym);
  const sumTax = (arr) => r2(arr.reduce((t, l) => t + l.tax, 0));
  const twoBNotes = { lines: per.length, total: sumTax(per.filter((l) => l.kind === "inv")),
    notes: sumTax(per.filter((l) => l.kind === "cn")) - sumTax(per.filter((l) => l.kind === "dn")),
    no_itc: sumTax(per.filter((l) => !l.itc_ok)), rcm: sumTax(per.filter((l) => l.rcm)) };
  const notCounted = (() => {
    const flagged = mine.filter((i) => i.reason === "flagged");
    const noGst = mine.filter((i) => i.reason && i.reason !== "flagged");
    const byReason = new Map();
    for (const i of noGst) { const g = byReason.get(i.reason) || { reason: i.reason, amount: 0, n: 0 }; g.amount += i.taxable; g.n += 1; byReason.set(i.reason, g); }
    return {
      flagged: { n: flagged.length, amount: r2(flagged.reduce((t, i) => t + i.taxable, 0)) },
      reasons: [...byReason.values()].map((g) => ({ ...g, amount: r2(g.amount) })),
      fuel: inp.fuelBy.get(ym) || { amount: 0, n: 0 },
    };
  })();
  const paid = challans.rows.filter((c) => c.month === ym).map((c) => ({ ...c, igst: n0(c.igst), cgst: n0(c.cgst), sgst: n0(c.sgst), interest: n0(c.interest), late_fee: n0(c.late_fee) }));
  const paidSum = paid.reduce((t, c) => add(t, c), ZERO());
  const rnd = (g) => ({ ...g, taxable: r2(g.taxable), gst: r2(g.gst), in2b: r2(g.in2b), held: r2(g.held), claim: r2(g.claim), earlier: r2(g.earlier) });
  const [y, mm] = ym.split("-").map(Number);
  const due = `${addMonths(ym, 1)}-20`;
  return {
    month: ym, label: monthLabel(ym, true), due_on: due, settings: s,
    has_2b: has2B.has(ym), uploads_2b: b2.uploads.map((u) => ({ ...u })).sort((a, b) => (a.period < b.period ? 1 : -1)),
    output: cur.output,
    input: {
      groups: [...groups.values()].map((g) => ({ ...rnd(g), rates: [...g.rates].sort((a, b) => a - b) })).sort((a, b) => b.gst - a.gst),
      total: r2(mine.filter((i) => i.gst > 0 && !i.rcm).reduce((t, i) => t + i.gst, 0)),
      claim: r2(cur.credit_new.igst + cur.credit_new.cgst + cur.credit_new.sgst),
      held: r2(heldAll.reduce((t, i) => t + i.gst, 0)),
      held_count: heldAll.length,
      held_parties: new Set(heldAll.map((i) => i.gstin || i.party)).size,
    },
    held: heldAll.map(itemOut).sort((a, b) => (a.day < b.day ? -1 : 1)),
    by_supplier: [...bySupplier.values()].map((g) => ({ ...g, gst: r2(g.gst), in2b: r2(g.in2b), held: r2(g.held) })).sort((a, b) => b.gst - a.gst),
    two_b: twoBNotes,
    not_in_app: notInApp.map((l) => ({ id: l.id, gstin: l.gstin, name: l.trade_name, inv_no: l.inv_no, inv_date: l.inv_day, taxable: n0(l.taxable), tax: l.tax, ignored: l.ignored })),
    not_counted: notCounted,
    purchases: mine.filter((i) => i.can_flag).map(itemOut).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    rcm: cur.rcm,
    carried_in: cur.carried_in, credit_new: cur.credit_new, setoff: cur.setoff, cash: cur.cash,
    carried_out: cur.setoff.left,
    prev: prev ? { ym: prev.ym, cash: prev.cash, left: prev.setoff.left } : null,
    challans: paid, paid: { igst: r2(paidSum.igst), cgst: r2(paidSum.cgst), sgst: r2(paidSum.sgst) },
    suppliers_without_gstin: missing.rows[0]?.n || 0,
    months: months.map((m) => ({ ym: m.ym, output: r2(m.output.igst + m.output.cgst + m.output.sgst), credit: r2(m.credit_new.igst + m.credit_new.cgst + m.credit_new.sgst),
      cash: r2(m.cash.igst + m.cash.cgst + m.cash.sgst), carried: r2(m.setoff.left.igst + m.setoff.left.cgst + m.setoff.left.sgst) })),
    year: y, mon: mm,
  };
}
function itemOut(i) {
  return { key: i.key, src: i.src, id: i.id, group: i.group, day: i.day, party: i.party, gstin: i.gstin || null, inv_no: i.inv_no || null,
    taxable: i.taxable, gst: i.gst, pct: i.pct, no_tax: !!i.no_tax, status: i.status, claim_ym: i.claim_ym || null,
    match: i.match ? { period: i.match.period, inv_no: i.match.inv_no, tax: i.match.tax } : null, short: i.short || 0 };
}

// For the Balance Sheet hints: credit carried and cash still due at a month end.
export async function gstPosition(ym) {
  try {
    const g = await gstMonth(ym);
    const due = r2(g.cash.igst + g.cash.cgst + g.cash.sgst - (g.paid.igst + g.paid.cgst + g.paid.sgst));
    return { credit: r2(g.carried_out.igst + g.carried_out.cgst + g.carried_out.sgst), held: g.input.held, due };
  } catch (e) { console.error("gst position:", e.message); return null; }
}

export { MONTH_RE };
