// Round 223 — Bank statements in the Cost module (owner, 21 Oct 2026; mock-up
// "Bank statements — Monthly", claude/bank-statements-mockup-v1.md).
//
// Every account's statement (PDF read in the browser, or Excel / CSV) is kept
// line by line. Each line gets one treatment:
//
//   cost      added to a cost (or other income) head of the Profit & Loss —
//             on top of what the app already records for that head (owner:
//             a maintenance payment not in the app is categorised as
//             maintenance and adds to the maintenance cost).
//   omit      left out — the app already has this exact payment / receipt
//             (same amount, within 3 days: a supplier payment, payroll, a
//             contractor or maintenance payment, a fuel purchase, a customer
//             receipt …). Never left out just because of the KIND of payment.
//   check     the amount matches an app record but the dates are 4–15 days
//             apart — the user confirms (left out) or adds it to a cost.
//   own       a transfer between our own accounts.
//   loan      a loan EMI: split into interest (Finance cost) and principal
//             (reduces the loan) — interest = balance outstanding × rate ÷ 12.
//   tax       GST / TDS / income tax paid — not a cost.
//   asset     a fixed-asset purchase — Balance Sheet, not the P&L.
//   capital   money brought in / taken out by the owners.
//   personal  owner's personal — left out.
//   todo      not sorted yet.
//
// Sorting order: own transfer → loan (narration text) → an app record →
// the rules (remembered when the user ticks "always") → todo. A line the user
// set by hand is never re-sorted.
import { query, pool } from "../db.js";
import { isOwnTransfer } from "../routes/accountsLedger.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;

// Round 232 — gst: the GST % usually inside a payment under that head (owner,
// 22 Oct 2026: "the amount paid from bank includes GST, which is input tax").
// A cost line is counted WITHOUT that GST, like every other figure in the
// P&L; each line can change the rate, or say no input credit can be taken.
export const BANK_HEADS = [
  { key: "rm", label: "Raw material", gst: 18 },
  { key: "fuel", label: "Fuel", gst: 0 },
  { key: "repairs", label: "Repairs & maintenance", gst: 18 },
  { key: "salaries", label: "Salaries & wages", gst: 0 },
  { key: "contract_labour", label: "Contract labour & pump gangs", gst: 0 },
  { key: "hired_vehicles", label: "Hired vehicles & pumps", gst: 18 },
  { key: "power", label: "Plant power (electricity)", gst: 0 },
  { key: "admin_office", label: "Admin & office", gst: 18 },
  { key: "selling", label: "Selling & marketing", gst: 18 },
  { key: "rent_rates", label: "Rent & rates", gst: 18 },
  { key: "interest", label: "Finance cost (interest, bank charges)", gst: 0 },
  { key: "other_income", label: "Other income", income: true, gst: 0 },
];
export const GST_RATES = [0, 5, 12, 18, 28];
export const headGst = (head) => BANK_HEADS.find((h) => h.key === head)?.gst ?? 0;
// The cost part of a line and the input GST in it.
export function gstSplit(amount, pct, claim = true) {
  const a = Number(amount) || 0, p = Number(pct) || 0;
  if (!claim || !(p > 0)) return { net: Math.round(a * 100) / 100, gst: 0 };
  const net = Math.round((a * 100 / (100 + p)) * 100) / 100;
  return { net, gst: Math.round((a - net) * 100) / 100 };
}
// SQL for the cost part of a line (alias l).
export const NET_SQL = (col) => `CASE WHEN COALESCE(l.gst_claim, true) AND COALESCE(l.gst_pct, 0) > 0
  THEN ROUND(${col} * 100 / (100 + l.gst_pct), 2) ELSE ${col} END`;
export const ROUND232_SQL = `
ALTER TABLE cost_bank_lines ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5,2);
ALTER TABLE cost_bank_lines ADD COLUMN IF NOT EXISTS gst_claim BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE cost_bank_rules ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5,2);
ALTER TABLE cost_bank_rules ADD COLUMN IF NOT EXISTS gst_claim BOOLEAN NOT NULL DEFAULT true;
`;
// The two columns are also made on first use, so the P&L never reads bank
// costs from a database where /setup has not run yet.
let gstReady = null;
export function ensureBankGst() {
  if (!gstReady) gstReady = query(ROUND232_SQL).catch((e) => { gstReady = null; throw e; });
  return gstReady;
}
// Lines already given a cost head: the head's usual rate (once).
export function headGstCaseSql(col = "head") {
  return `CASE ${col} ${BANK_HEADS.map((h) => `WHEN '${h.key}' THEN ${h.gst}`).join(" ")} ELSE 0 END`;
}
export const HEAD_KEYS = new Set(BANK_HEADS.map((h) => h.key));
// Round 235 — pay: a payment to a party, posted into its ledger; cert: a
// vehicle certificate (road tax, insurance …) renewed in the compliance register.
export const TREATMENTS = ["todo", "check", "cost", "omit", "own", "loan", "tax", "asset", "capital", "personal", "pay", "cert"];

export const ROUND223_SQL = `
CREATE TABLE IF NOT EXISTS cost_bank_accounts (
  id          SERIAL PRIMARY KEY,
  bank        VARCHAR(80) NOT NULL,
  label       VARCHAR(80),
  number      VARCHAR(30) NOT NULL,
  kind        VARCHAR(10) NOT NULL DEFAULT 'current' CHECK (kind IN ('current','savings','cc','od')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_bank_acc_number ON cost_bank_accounts(number);

CREATE TABLE IF NOT EXISTS cost_bank_loans (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(100) NOT NULL,
  lender               VARCHAR(80),
  kind                 VARCHAR(10) NOT NULL DEFAULT 'term' CHECK (kind IN ('term','vehicle','other')),
  account_id           INTEGER REFERENCES cost_bank_accounts(id),
  match_text           VARCHAR(80),
  rate_pct             NUMERIC(6,3) NOT NULL CHECK (rate_pct >= 0),
  emi                  NUMERIC(14,2),
  opening_outstanding  NUMERIC(16,2) NOT NULL,
  opening_date         DATE NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  notes                VARCHAR(300),
  created_by           INTEGER REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cost_bank_uploads (
  id               SERIAL PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES cost_bank_accounts(id),
  file_name        VARCHAR(200),
  period_from      DATE,
  period_to        DATE,
  opening          NUMERIC(16,2),
  closing          NUMERIC(16,2),
  lines_read       INTEGER NOT NULL DEFAULT 0,
  lines_added      INTEGER NOT NULL DEFAULT 0,
  lines_duplicate  INTEGER NOT NULL DEFAULT 0,
  uploaded_by      INTEGER REFERENCES users(id),
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cost_bank_rules (
  id          SERIAL PRIMARY KEY,
  keyword     VARCHAR(80) NOT NULL,
  side        VARCHAR(6) NOT NULL DEFAULT 'debit' CHECK (side IN ('debit','credit','any')),
  treatment   VARCHAR(10) NOT NULL,
  head        VARCHAR(20),
  loan_id     INTEGER REFERENCES cost_bank_loans(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (keyword, side)
);

CREATE TABLE IF NOT EXISTS cost_bank_lines (
  id              SERIAL PRIMARY KEY,
  upload_id       INTEGER NOT NULL REFERENCES cost_bank_uploads(id),
  account_id      INTEGER NOT NULL REFERENCES cost_bank_accounts(id),
  txn_date        DATE NOT NULL,
  narration       TEXT,
  reference       VARCHAR(120),
  debit           NUMERIC(16,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(16,2) NOT NULL DEFAULT 0,
  balance         NUMERIC(16,2),
  seq             INTEGER NOT NULL DEFAULT 0,
  dedupe_key      VARCHAR(300) NOT NULL UNIQUE,
  treatment       VARCHAR(10) NOT NULL DEFAULT 'todo'
                  CHECK (treatment IN ('todo','check','cost','omit','own','loan','tax','asset','capital','personal')),
  head            VARCHAR(20),
  loan_id         INTEGER REFERENCES cost_bank_loans(id),
  interest        NUMERIC(16,2),
  principal       NUMERIC(16,2),
  interest_fixed  BOOLEAN NOT NULL DEFAULT false,
  match_kind      VARCHAR(20),
  match_id        INTEGER,
  why             VARCHAR(240),
  rule_id         INTEGER REFERENCES cost_bank_rules(id),
  manual          BOOLEAN NOT NULL DEFAULT false,
  note            VARCHAR(200),
  set_by          INTEGER REFERENCES users(id),
  set_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cost_bank_lines_date ON cost_bank_lines(txn_date);
CREATE INDEX IF NOT EXISTS idx_cost_bank_lines_acc ON cost_bank_lines(account_id, txn_date, seq);
CREATE INDEX IF NOT EXISTS idx_cost_bank_lines_loan ON cost_bank_lines(loan_id) WHERE loan_id IS NOT NULL;

INSERT INTO cost_bank_rules (keyword, side, treatment, head) VALUES
  ('GST', 'debit', 'tax', NULL), ('CBDT', 'debit', 'tax', NULL), ('TDS', 'debit', 'tax', NULL), ('ADVANCE TAX', 'debit', 'tax', NULL),
  ('CHGS', 'debit', 'cost', 'interest'), ('SMS CHARGES', 'debit', 'cost', 'interest'), ('INT.COLL', 'debit', 'cost', 'interest')
ON CONFLICT (keyword, side) DO NOTHING;
`;

export async function migrateRound223(pool, log) {
  await pool.query(ROUND223_SQL);
  // The accounts already printed on quotations become the first bank accounts.
  const { rows } = await pool.query(`SELECT bank_accounts FROM quotation_settings WHERE id = 1`).catch(() => ({ rows: [] }));
  let added = 0;
  for (const b of rows[0]?.bank_accounts || []) {
    const number = String(b.number || "").replace(/\s/g, "");
    if (!/^\d{6,20}$/.test(number)) continue;
    const r = await pool.query(
      `INSERT INTO cost_bank_accounts (bank, label, number) VALUES ($1, $2, $3) ON CONFLICT (number) DO NOTHING`,
      [String(b.bank || "Bank").replace(/[,.]+\s*$/, "").slice(0, 80), String(b.label || "").slice(0, 80) || null, number]);
    added += r.rowCount;
  }
  log?.push?.(`Round 223: bank statements in the Cost module${added ? ` (${added} bank account(s) from Quotation settings)` : ""}.`);
}

// ------------------------------------------------------------ helpers ---
const flat = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function keywordHit(narration, keyword) {
  const k = flat(keyword);
  if (!k) return false;
  return new RegExp(`(^|[^A-Z0-9])${esc(k)}([^A-Z0-9]|$)`).test(flat(narration));
}
const dayNum = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86400000;
function shiftDay(ymd, n) {
  const d = new Date((dayNum(ymd) + n) * 86400000);
  return d.toISOString().slice(0, 10); // ist-ok: a calendar date shifted in UTC, no clock time involved
}
const money = (v) => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function dedupeKey(accountId, r) {
  const amt = r2(n0(r.credit) - n0(r.debit)).toFixed(2);
  const bal = r.balance == null || r.balance === "" ? "" : r2(r.balance).toFixed(2);
  const narr = flat(r.narration).replace(/[^A-Z0-9]/g, "").slice(0, 60);
  return ["b1", accountId, r.date, amt, bal, narr].join("|").slice(0, 300);
}

// --------------------------------------------------- what the app has ---
// Payments and receipts the app already records, between two days.
async function appRecords(from, to) {
  const q = (sql, kind, label) => query(sql, [from, to]).then(({ rows }) => rows.map((r) => ({
    kind, id: r.id, day: r.day, amount: r2(r.amount), side: r.side || "debit", label: label(r) })))
    .catch((e) => { console.error(`bank: ${kind}`, e.message); return []; });
  const parts = await Promise.all([
    q(`SELECT p.id, p.paid_on::text AS day, p.amount, s.name FROM rm_supplier_payments p JOIN rm_suppliers s ON s.id = p.supplier_id
        WHERE p.cancelled_at IS NULL AND p.mode <> 'cash' AND p.paid_on BETWEEN $1::date AND $2::date`, "supplier", (r) => `Raw material payment — ${r.name} (Supplier ledger)`),
    q(`SELECT p.id, p.paid_on::text AS day, p.amount, t.name FROM rm_transporter_payments p JOIN rm_transporters t ON t.id = p.transporter_id
        WHERE p.cancelled_at IS NULL AND p.mode <> 'cash' AND p.paid_on BETWEEN $1::date AND $2::date`, "transporter", (r) => `Transporter payment — ${r.name} (Transporter ledger)`),
    q(`SELECT p.id, p.paid_on::text AS day, p.amount, c.name FROM hr_contractor_payments p JOIN hr_contractors c ON c.id = p.contractor_id
        WHERE p.mode <> 'cash' AND p.paid_on BETWEEN $1::date AND $2::date`, "contractor", (r) => `Contractor payment — ${r.name} (HR)`),
    q(`SELECT p.id, p.paid_on::text AS day, p.amount, b.payee AS name FROM mnt_payments p JOIN mnt_bills b ON b.id = p.bill_id
        WHERE p.paid_on BETWEEN $1::date AND $2::date`, "maintenance", (r) => `Maintenance payment${r.name ? ` — ${r.name}` : ""} (Maintenance → Payments)`),
    q(`SELECT (to_char(l.paid_on, 'YYYYMMDD'))::int AS id, l.paid_on::text AS day, SUM(l.paid_amount) AS amount, COUNT(*) AS n
         FROM hr_payroll_lines l WHERE l.paid_on BETWEEN $1::date AND $2::date AND l.paid_amount > 0 GROUP BY l.paid_on`,
      "payroll_day", (r) => `Salaries paid on ${r.day} — ${r.n} employee(s) (HR payroll)`),
    q(`SELECT a.id, a.given_on::text AS day, a.amount, e.name FROM hr_advances a JOIN hr_employees e ON e.id = a.employee_id
        WHERE a.given_on BETWEEN $1::date AND $2::date`, "advance", (r) => `Salary advance — ${r.name} (HR)`),
    q(`SELECT sp.id, (sp.received_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, sp.total_cost AS amount, sp.supplier_name AS name
         FROM store_stock_purchases sp WHERE sp.status = 'received' AND sp.total_cost > 0
          AND (sp.received_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date`, "store_purchase",
      (r) => `Store / fuel purchase${r.name ? ` — ${r.name}` : ""} (Fuel & Store)`),
    q(`SELECT sr.id, (sr.issued_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, sr.fuel_cost AS amount
         FROM supply_requests sr WHERE sr.request_type = 'fuel' AND sr.status = 'issued' AND sr.fuel_cost > 0
          AND (sr.issued_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date`, "fuel_fill", (r) => `Outside fuel fill FR-${r.id} (Fuel)`),
    q(`SELECT r.id, r.receipt_date::text AS day, r.amount, 'credit' AS side, c.name FROM customer_receipts r JOIN customers c ON c.id = r.customer_id
        WHERE r.cancelled_at IS NULL AND r.receipt_date BETWEEN $1::date AND $2::date`, "receipt", (r) => `Customer receipt — ${r.name} (Accounts)`),
    q(`SELECT p.id, p.payment_date::text AS day, p.amount, 'credit' AS side FROM payments p
        WHERE p.receipt_id IS NULL AND p.payment_date BETWEEN $1::date AND $2::date`, "payment", () => "Customer payment (Accounts)"),
  ]);
  return parts.flat();
}

async function sortContext(lines) {
  if (!lines.length) return null;
  const days = lines.map((l) => l.txn_date).sort();
  const [records, claimed, rules, loans, accs, qs] = await Promise.all([
    appRecords(shiftDay(days[0], -16), shiftDay(days[days.length - 1], 16)),
    query(`SELECT match_kind, match_id, id FROM cost_bank_lines WHERE match_kind IS NOT NULL`),
    query(`SELECT * FROM cost_bank_rules ORDER BY length(keyword) DESC, id`),
    query(`SELECT id, name, match_text, account_id, emi, rate_pct, opening_outstanding, opening_date::text AS opening_date,
                  COALESCE(method, 'emi') AS method, principal_amt, COALESCE(match_amount, true) AS match_amount
             FROM cost_bank_loans WHERE is_active ORDER BY id`)
      .catch(() => query(`SELECT id, name, match_text, account_id FROM cost_bank_loans WHERE is_active ORDER BY id`)),
    query(`SELECT id, number FROM cost_bank_accounts`),
    query(`SELECT bank_accounts FROM quotation_settings WHERE id = 1`).catch(() => ({ rows: [] })),
  ]);
  const nums = new Set(accs.rows.map((a) => String(a.number).replace(/\D/g, "")).filter((x) => x.length >= 6));
  for (const b of qs.rows[0]?.bank_accounts || []) { const x = String(b.number || "").replace(/\D/g, ""); if (x.length >= 6) nums.add(x); }
  const taken = new Map(claimed.rows.map((c) => [`${c.match_kind}:${c.match_id}`, c.id]));
  // Round 239 — which loans already have an EMI in which month (lines not
  // being sorted now), so two loans with the same EMI get one each.
  const ids = lines.map((l) => l.id);
  const { rows: used } = await query(
    `SELECT DISTINCT loan_id, to_char(txn_date, 'YYYY-MM') AS ym FROM cost_bank_lines
      WHERE treatment = 'loan' AND loan_id IS NOT NULL AND NOT (id = ANY($1::int[]))`, [ids]).catch(() => ({ rows: [] }));
  return {
    records, taken, rules: rules.rows, loans: loans.rows.filter((l) => l.match_text), loansAll: loans.rows,
    loanMonths: new Set(used.map((u) => `${u.loan_id}:${u.ym}`)),
    own: { names: ["OUR OWN READY MIX", "OUR OWN READYMIX", "OUROWN READY MIX", "OUR OWN READY-MIX"], nums: [...nums] },
    accNums: accs.rows.map((a) => ({ id: a.id, num: String(a.number).replace(/\D/g, "") })),
  };
}

// Does this debit look like the loan's instalment? The same EMI (± ₹1); for
// a fixed-principal loan the principal plus up to about a month and a half's
// interest (at 10% at least, so a low net rate still fits). Only from the
// loan's account when one is set, and not before its start date.
function amountFits(l, amount, line) {
  if (line.txn_date < (l.opening_date || "")) return false;
  if (l.account_id && l.account_id !== line.account_id) return false;
  if (l.method === "fixed" && n0(l.principal_amt) > 0) {
    const maxInt = (n0(l.opening_outstanding) * Math.max(10, n0(l.rate_pct))) / 1200 * 1.5 + 100;
    return amount >= n0(l.principal_amt) - 1 && amount <= n0(l.principal_amt) + maxInt;
  }
  return n0(l.emi) > 0 && Math.abs(amount - n0(l.emi)) <= 1;
}

// The treatment the app suggests for one line.
function suggest(line, ctx) {
  const side = n0(line.debit) > 0 ? "debit" : "credit";
  const amount = side === "debit" ? n0(line.debit) : n0(line.credit);
  const narr = line.narration || "";
  // Our own name or another of our account numbers in the narration.
  const own = { ...ctx.own, nums: ctx.own.nums.filter((x) => !ctx.accNums.some((a) => a.id === line.account_id && a.num === x)) };
  if (isOwnTransfer(narr, own)) return { treatment: "own", why: "our own account in the narration" };
  // Round 240 — when the narration text fits more than one loan (two KFC
  // loans both "KFC …"), the one whose instalment the amount fits, then the
  // one without an instalment yet that month.
  if (side === "debit") {
    const ym = String(line.txn_date).slice(0, 7);
    let byText = ctx.loans.filter((l) => keywordHit(narr, l.match_text));
    if (byText.length > 1) {
      const fit = byText.filter((l) => amountFits(l, amount, line));
      if (fit.length) byText = fit;
    }
    if (byText.length) {
      const l = byText.find((x) => !ctx.loanMonths?.has(`${x.id}:${ym}`)) || byText[0];
      ctx.loanMonths?.add(`${l.id}:${ym}`);
      return { treatment: "loan", loan_id: l.id, why: `EMI — ${l.name} (“${l.match_text}”${byText.length > 1 ? `; ${byText.length} loans have this text` : ""})` };
    }
  }
  // An app record: same amount, closest date; within 3 days left out, 4–15 days to check.
  let best = null;
  for (const r of ctx.records) {
    if (r.side !== side || Math.abs(r.amount - amount) > 1) continue;
    const t = ctx.taken.get(`${r.kind}:${r.id}`);
    if (t && t !== line.id) continue;
    const d = Math.abs(dayNum(r.day) - dayNum(line.txn_date));
    if (d > 15) continue;
    if (!best || d < best.d) best = { r, d };
  }
  if (best) {
    const near = best.d <= 3;
    return { treatment: near ? "omit" : "check", match_kind: best.r.kind, match_id: best.r.id,
      why: near ? `${best.r.label} · ${best.r.day}` : `Possible match: ${best.r.label} · ${best.r.day} (${best.d} days apart)` };
  }
  // Round 239 — a loan's EMI found by its amount (the same EMI; for a fixed-
  // principal loan, the principal plus up to about a month and a half's
  // interest), from the account it is paid from when that is set. Two loans
  // with the same EMI: the one without an EMI yet that month.
  if (side === "debit") {
    const ym = String(line.txn_date).slice(0, 7);
    const cands = (ctx.loansAll || []).filter((l) => l.match_amount !== false && amountFits(l, amount, line));
    if (cands.length) {
      const pick = cands.find((l) => !ctx.loanMonths.has(`${l.id}:${ym}`)) || cands[0];
      ctx.loanMonths.add(`${pick.id}:${ym}`);
      return { treatment: "loan", loan_id: pick.id, why: `EMI — ${pick.name} (by the amount${cands.length > 1 ? `; ${cands.length} loans have this amount` : ""})` };
    }
  }
  for (const r of ctx.rules) {
    if (r.side !== "any" && r.side !== side) continue;
    if (!keywordHit(narr, r.keyword)) continue;
    return { treatment: r.treatment, head: r.head, loan_id: r.loan_id, rule_id: r.id, why: `rule: “${r.keyword}”`,
             gst_pct: r.gst_pct == null ? null : Number(r.gst_pct), gst_claim: r.gst_claim !== false };
  }
  return { treatment: "todo", why: null };
}

// Sort the lines given (ids) or every line not set by hand.
export async function autoSort({ ids = null, client = null } = {}) {
  await ensureBankGst();
  const db = client || { query };
  const { rows: lines } = await db.query(
    `SELECT id, account_id, txn_date::text AS txn_date, narration, debit, credit FROM cost_bank_lines
      WHERE NOT manual ${ids ? "AND id = ANY($1::int[])" : ""} ORDER BY txn_date, id`, ids ? [ids] : []);
  if (!lines.length) return { sorted: 0 };
  // Release this batch's own claims first, so a re-sort can move them.
  await db.query(`UPDATE cost_bank_lines SET match_kind = NULL, match_id = NULL WHERE id = ANY($1::int[])`, [lines.map((l) => l.id)]);
  const ctx = await sortContext(lines);
  const counts = {};
  for (const l of lines) {
    const s = suggest(l, ctx);
    if (s.match_kind) ctx.taken.set(`${s.match_kind}:${s.match_id}`, l.id);
    counts[s.treatment] = (counts[s.treatment] || 0) + 1;
    await db.query(
      `UPDATE cost_bank_lines SET treatment = $2::varchar, head = $3, loan_id = $4, match_kind = $5, match_id = $6, why = $7, rule_id = $8,
              interest = CASE WHEN $2::varchar = 'loan' THEN interest ELSE NULL END, principal = CASE WHEN $2::varchar = 'loan' THEN principal ELSE NULL END,
              gst_pct = $9, gst_claim = $10
        WHERE id = $1`,
      [l.id, s.treatment, s.head || null, s.loan_id || null, s.match_kind || null, s.match_id || null, s.why ? s.why.slice(0, 240) : null, s.rule_id || null,
       s.treatment === "cost" ? (s.gst_pct ?? headGst(s.head)) : null, s.treatment === "cost" ? s.gst_claim !== false : true]);
  }
  await recomputeLoans(db);
  return { sorted: lines.length, counts };
}

// --------------------------------------------------------------- loans ---
// Round 239 (owner, 25 Oct 2026 — the IndusInd, Shriram and KFC statements):
// two ways a loan is repaid —
//   emi    the same amount every month (IndusInd, Shriram). Interest on the
//          balance outstanding for the DAYS since the same date last month
//          (rate × days ÷ 365, as the lenders charge it — so February's is
//          smaller), or rate ÷ 12 if the loan is set so; principal = EMI −
//          interest.
//   fixed  a fixed principal every month plus that month's interest (KFC):
//          principal = the fixed instalment (spread over the month's debits
//          if paid in two), interest = the rest of what was paid — exact,
//          whatever rebate or subsidy the lender gave.
// Interest typed on an EMI line (from the lender's statement) always wins.
// A credit to the loan (a fresh disbursement) adds to the balance.
export const ROUND239_SQL = `
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS method VARCHAR(8) NOT NULL DEFAULT 'emi';
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS principal_amt NUMERIC(14,2);
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS interest_basis VARCHAR(8) NOT NULL DEFAULT 'days';
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS match_amount BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS loan_amount NUMERIC(16,2);
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS loan_no VARCHAR(40);
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS asset VARCHAR(100);
ALTER TABLE cost_bank_loans ADD COLUMN IF NOT EXISTS end_date DATE;
`;
export async function migrateRound239(pool, log) {
  await pool.query(ROUND239_SQL);
  await recomputeLoans({ query: (t, p) => pool.query(t, p) }).catch(() => {});
  log?.push?.("Round 239: loans — fixed-principal loans, interest by days, EMI found by amount.");
}
const dayN = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86400000;
// Days from the same date last month to this date (28–31) — the lender's
// interest period for a monthly instalment.
function monthDays(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)), d = Number(ymd.slice(8, 10));
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  const pd = Math.min(d, new Date(Date.UTC(py, pm, 0)).getUTCDate());
  return dayN(ymd) - Date.UTC(py, pm - 1, pd) / 86400000;
}
export function loanInterest(loan, out, ymd) {
  const rate = n0(loan.rate_pct);
  return loan.interest_basis === "month" ? r2((out * rate) / 1200) : r2((out * rate * monthDays(ymd)) / 36500);
}
export async function recomputeLoans(db = { query }) {
  const { rows: loans } = await db.query(
    `SELECT id, rate_pct, opening_outstanding, opening_date::text AS opening_date,
            COALESCE(method, 'emi') AS method, principal_amt, COALESCE(interest_basis, 'days') AS interest_basis FROM cost_bank_loans`)
    .catch(() => db.query(`SELECT id, rate_pct, opening_outstanding, opening_date::text AS opening_date, 'emi' AS method, NULL AS principal_amt, 'month' AS interest_basis FROM cost_bank_loans`));
  for (const loan of loans) {
    const { rows } = await db.query(
      `SELECT id, txn_date::text AS d, debit, credit, interest, interest_fixed FROM cost_bank_lines
        WHERE loan_id = $1 AND treatment = 'loan' ORDER BY txn_date, seq, id`, [loan.id]);
    let out = n0(loan.opening_outstanding);
    const prinUsed = new Map();   // fixed: principal already taken in each month
    for (const l of rows) {
      let interest, principal;
      if (l.d < loan.opening_date) { interest = 0; principal = 0; }
      else if (n0(l.debit) > 0) {
        const debit = n0(l.debit);
        if (l.interest_fixed && l.interest != null) {
          interest = Math.min(n0(l.interest), debit);
          principal = r2(debit - interest);
        } else if (loan.method === "fixed" && n0(loan.principal_amt) > 0) {
          const ym = l.d.slice(0, 7);
          const left = Math.max(0, Math.min(n0(loan.principal_amt) - (prinUsed.get(ym) || 0), out));
          principal = r2(Math.min(debit, left));
          prinUsed.set(ym, (prinUsed.get(ym) || 0) + principal);
          interest = r2(debit - principal);
        } else {
          interest = Math.min(loanInterest(loan, out, l.d), debit);
          principal = r2(debit - interest);
        }
        out = r2(out - principal);
      } else { interest = 0; principal = r2(-n0(l.credit)); out = r2(out + n0(l.credit)); }
      await db.query(`UPDATE cost_bank_lines SET interest = $2, principal = $3 WHERE id = $1`, [l.id, r2(interest), r2(principal)]);
    }
  }
}

export async function loansSummary(day, ym = null) {
  const { rows } = await query(
    `SELECT l.*, l.opening_date::text AS opening_date, a.bank AS account_bank, a.number AS account_number,
            COALESCE((SELECT SUM(principal) FROM cost_bank_lines b WHERE b.loan_id = l.id AND b.treatment = 'loan'
                       AND b.txn_date >= l.opening_date AND b.txn_date <= $1::date), 0) AS repaid,
            (SELECT COUNT(*)::int FROM cost_bank_lines b WHERE b.loan_id = l.id AND b.treatment = 'loan') AS emis,
            (SELECT MAX(txn_date)::text FROM cost_bank_lines b WHERE b.loan_id = l.id AND b.treatment = 'loan') AS last_emi
       FROM cost_bank_loans l LEFT JOIN cost_bank_accounts a ON a.id = l.account_id ORDER BY l.is_active DESC, l.id`, [day]);
  let month = new Map();
  if (ym) {
    const { rows: m } = await query(
      `SELECT loan_id, SUM(debit) AS emi, SUM(interest) AS interest, SUM(principal) AS principal FROM cost_bank_lines
        WHERE treatment = 'loan' AND to_char(txn_date, 'YYYY-MM') = $1 GROUP BY loan_id`, [ym]);
    month = new Map(m.map((x) => [x.loan_id, x]));
  }
  return rows.map((l) => {
    const known = l.opening_date <= day;
    const outstanding = known ? r2(n0(l.opening_outstanding) - n0(l.repaid)) : null;
    const mm = month.get(l.id);
    const left = known && n0(l.emi) > 0 && n0(l.rate_pct) >= 0 ? emisLeft(outstanding, n0(l.rate_pct), n0(l.emi)) : null;
    return { id: l.id, name: l.name, lender: l.lender, kind: l.kind, account_id: l.account_id, account: l.account_bank ? `${l.account_bank} ••${String(l.account_number).slice(-4)}` : null,
      match_text: l.match_text, rate_pct: n0(l.rate_pct), emi: l.emi == null ? null : n0(l.emi), opening_outstanding: n0(l.opening_outstanding),
      opening_date: l.opening_date, is_active: l.is_active, notes: l.notes, outstanding, emis: l.emis, last_emi: l.last_emi,
      emis_left: (l.method === "fixed" && n0(l.principal_amt) > 0) ? (known ? Math.ceil(Math.max(0, outstanding) / n0(l.principal_amt)) : null) : left,
      method: l.method || "emi", principal_amt: l.principal_amt == null ? null : n0(l.principal_amt),
      interest_basis: l.interest_basis || "days", match_amount: l.match_amount !== false,
      month: mm ? { emi: r2(mm.emi), interest: r2(mm.interest), principal: r2(mm.principal) } : null };
  });
}
function emisLeft(out, rate, emi) {
  if (!(out > 0)) return 0;
  const i = rate / 1200;
  if (i === 0) return Math.ceil(out / emi);
  if (emi <= out * i) return null;   // EMI does not cover the interest
  return Math.ceil(-Math.log(1 - (out * i) / emi) / Math.log(1 + i));
}

// ------------------------------------------------ into the P&L / BS ---
// Amounts per head for a month: cost heads = debits − credits (a refund
// reduces the cost), other income = credits − debits; loan EMI interest goes
// to Finance cost.
export async function bankHeadsMonth(ym) {
  await ensureBankGst().catch(() => {});
  const { rows } = await query(
    // Round 232 — without the GST inside each payment.
    `SELECT l.head, SUM(${NET_SQL("l.debit")}) AS dr, SUM(${NET_SQL("l.credit")}) AS cr, COUNT(*)::int AS n,
            SUM(CASE WHEN l.debit > 0 THEN l.debit - ${NET_SQL("l.debit")} ELSE 0 END) AS gst_in
       FROM cost_bank_lines l
      WHERE l.treatment = 'cost' AND l.head IS NOT NULL AND to_char(l.txn_date, 'YYYY-MM') = $1 GROUP BY l.head`, [ym]).catch(() => ({ rows: [] }));
  const out = {}, count = {};
  let gstInput = 0;
  for (const r of rows) {
    const income = r.head === "other_income";
    out[r.head] = r2(income ? n0(r.cr) - n0(r.dr) : n0(r.dr) - n0(r.cr));
    count[r.head] = r.n;
    if (!income) gstInput += n0(r.gst_in);
  }
  const { rows: li } = await query(
    `SELECT COALESCE(SUM(interest), 0) AS i, COUNT(*)::int AS n FROM cost_bank_lines
      WHERE treatment = 'loan' AND to_char(txn_date, 'YYYY-MM') = $1`, [ym]).catch(() => ({ rows: [{ i: 0, n: 0 }] }));
  const loanInterest = r2(li[0].i);
  if (loanInterest) { out.interest = r2((out.interest || 0) + loanInterest); count.interest = (count.interest || 0) + li[0].n; }
  return { heads: out, count, loan_interest: loanInterest, gst_input: r2(gstInput) };
}

// Balance Sheet: loans from the loan list; cash credit from the CC / OD
// statements when they reach the day.
export async function bankBalancesOn(day) {
  const out = {};
  const { rows: loans } = await query(`SELECT COUNT(*)::int AS n FROM cost_bank_loans WHERE opening_date <= $1::date`, [day]).catch(() => ({ rows: [{ n: 0 }] }));
  if (loans[0].n) {
    const list = await loansSummary(day);
    out.term_loans = r2(list.reduce((t, l) => t + (l.outstanding || 0), 0));
  }
  const { rows: cc } = await query(
    `SELECT a.id,
            (SELECT MAX(period_to)::text FROM cost_bank_uploads u WHERE u.account_id = a.id) AS covered_to,
            (SELECT balance FROM cost_bank_lines b WHERE b.account_id = a.id AND b.txn_date <= $1::date AND b.balance IS NOT NULL
              ORDER BY b.txn_date DESC, b.seq DESC, b.id DESC LIMIT 1) AS balance
       FROM cost_bank_accounts a WHERE a.kind IN ('cc','od')`, [day]).catch(() => ({ rows: [] }));
  const ready = cc.filter((a) => a.covered_to && a.covered_to >= day && a.balance != null);
  if (cc.length && ready.length === cc.length) out.cash_credit = r2(ready.reduce((t, a) => t + Math.abs(n0(a.balance)), 0));
  return out;
}

export { money, shiftDay };


// ------------------------------------------------- Round 239: Loans page ---
// Owner, 25 Oct 2026: "better to move loans into a new page and provide more
// insights about each loan". For every loan: the instalments found on the
// bank statements with the balance after each, what is left, the months with
// no instalment found, and the rest of the loan worked forward (each month's
// interest and principal until it closes, at today's rate and EMI).
const ymOf = (d) => d.slice(0, 7);
function addMonthsYmd(ymd, n) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)) - 1 + n, d = Number(ymd.slice(8, 10));
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
function fyStartOf(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}
export async function loansInsight(today) {
  const list = await loansSummary(today, ymOf(today));
  const { rows: raw } = await query(`SELECT id, loan_amount, loan_no, asset, end_date::text AS end_date FROM cost_bank_loans`).catch(() => ({ rows: [] }));
  const extra = new Map(raw.map((r) => [r.id, r]));
  const { rows: lines } = await query(
    `SELECT b.id, b.loan_id, b.txn_date::text AS d, b.debit, b.credit, b.interest, b.principal, b.interest_fixed, b.narration, a.bank, a.number
       FROM cost_bank_lines b LEFT JOIN cost_bank_accounts a ON a.id = b.account_id
      WHERE b.treatment = 'loan' AND b.loan_id IS NOT NULL ORDER BY b.txn_date, b.seq, b.id`);
  const fy = fyStartOf(today);
  const loans = list.map((l) => {
    const x = extra.get(l.id) || {};
    const mine = lines.filter((b) => b.loan_id === l.id);
    let bal = l.opening_outstanding;
    const history = mine.map((b) => {
      const before = b.d < l.opening_date;
      if (!before) bal = r2(bal - n0(b.principal));
      return { id: b.id, date: b.d, paid: r2(n0(b.debit) - n0(b.credit)), interest: before ? null : r2(b.interest), principal: before ? null : r2(b.principal),
        // a second payment in a month on a fixed-principal loan: all interest — worth checking it is this loan's
        extra: !before && l.method === "fixed" && n0(b.debit) > 0 && n0(b.principal) === 0,
        balance: before ? null : bal, typed: b.interest_fixed, before_start: before, account: b.bank ? `${b.bank} ••${String(b.number).slice(-4)}` : null };
    });
    const counted = history.filter((h) => !h.before_start);
    const sum = (arr, k) => r2(arr.reduce((t, h) => t + n0(h[k]), 0));
    const inFy = counted.filter((h) => h.date >= fy);
    // Months from the start to last month (and this month once its due day
    // has passed) with no instalment found on the uploaded statements.
    const dueDay = l.last_emi ? Number(l.last_emi.slice(8, 10)) : null;
    const missing = [];
    if (l.is_active && counted.length) {
      const seen = new Set(counted.map((h) => ymOf(h.date)));
      let m = addMonthsYmd(`${ymOf(l.opening_date)}-01`, 1);
      const limit = dueDay && Number(today.slice(8, 10)) > dueDay + 3 ? today : addMonthsYmd(`${ymOf(today)}-01`, -1);
      for (let i = 0; i < 240 && ymOf(m) <= ymOf(limit); i++) { if (!seen.has(ymOf(m))) missing.push(ymOf(m)); m = addMonthsYmd(m, 1); }
    }
    // The rest of the loan, worked forward from today's balance.
    const projection = [];
    let out = l.outstanding ?? l.opening_outstanding;
    let next = l.last_emi ? addMonthsYmd(l.last_emi, 1) : addMonthsYmd(l.opening_date, 1);
    while (next <= today) next = addMonthsYmd(next, 1);
    const fixedP = l.method === "fixed" && n0(l.principal_amt) > 0;
    const emi = n0(l.emi);
    // A fixed-principal loan's interest going forward: at the rate it has
    // actually cost lately (after any rebate / subsidy), from the last
    // instalment found; else the rate set on the loan.
    // Round 240 — what the loan actually cost in the latest month an
    // instalment was found: that month's interest (all its payments) on the
    // balance before it. Shown beside the rate; the loan is worked forward at
    // the rate entered (owner: "even after I updated the rate to 6.2% the
    // calculation is the same as for 10%").
    let effRate = null;
    const lastPrin = [...counted].reverse().find((h) => n0(h.principal) > 0);
    if (fixedP && lastPrin) {
      const ym = ymOf(lastPrin.date);
      const inMonth = counted.filter((h) => ymOf(h.date) === ym);
      const first = inMonth[0];
      const before = first.balance + n0(first.principal);
      const intM = inMonth.reduce((t, h) => t + n0(h.interest), 0);
      if (before > 0) effRate = r2((intM * 1200) / before);
    }
    const rateFwd = l;
    let stalled = false;
    for (let i = 0; i < 360 && out > 0.5 && l.is_active; i++) {
      const interest = loanInterest(rateFwd, out, next);
      let principal = fixedP ? Math.min(n0(l.principal_amt), out) : Math.min(emi - interest, out);
      if (!(principal > 0)) { stalled = true; break; }
      out = r2(out - principal);
      projection.push({ date: next, pay: r2(principal + interest), interest: r2(interest), principal: r2(principal), balance: out });
      next = addMonthsYmd(next, 1);
    }
    const nextDue = projection[0] ? projection[0].date : null;
    return { ...l, loan_amount: x.loan_amount == null ? null : n0(x.loan_amount), loan_no: x.loan_no || null, asset: x.asset || null, end_date: x.end_date || null,
      history, missing, projection, stalled: stalled || (!fixedP && !emi), effective_rate: effRate,
      totals: { paid: sum(counted, "paid"), interest: sum(counted, "interest"), principal: sum(counted, "principal"),
        fy_interest: sum(inFy, "interest"), fy_principal: sum(inFy, "principal"), fy_paid: sum(inFy, "paid") },
      ahead: { instalments: projection.length, interest: sum(projection, "interest"), paid: sum(projection, "pay"),
        closes: projection.length ? projection[projection.length - 1].date : null, next_due: nextDue, next_amount: projection[0] ? projection[0].pay : null },
      repaid_pct: x.loan_amount && n0(x.loan_amount) > 0 && l.outstanding != null ? r2((1 - l.outstanding / n0(x.loan_amount)) * 100) : null };
  });
  const active = loans.filter((l) => l.is_active);
  const out = active.reduce((t, l) => t + (l.outstanding || 0), 0);
  const nextYearEnd = addMonthsYmd(today, 12);
  return {
    today, fy_start: fy, loans,
    summary: {
      count: active.length, outstanding: r2(out),
      monthly: r2(active.reduce((t, l) => t + (l.ahead.next_amount || 0), 0)),
      weighted_rate: out > 0 ? r2(active.reduce((t, l) => t + (l.outstanding || 0) * l.rate_pct, 0) / out) : null,
      fy_interest: r2(loans.reduce((t, l) => t + l.totals.fy_interest, 0)), fy_principal: r2(loans.reduce((t, l) => t + l.totals.fy_principal, 0)),
      interest_ahead: r2(active.reduce((t, l) => t + l.ahead.interest, 0)),
      next12_principal: r2(active.reduce((t, l) => t + l.projection.filter((p) => p.date <= nextYearEnd).reduce((s2, p) => s2 + p.principal, 0), 0)),
      closing_12m: active.filter((l) => l.ahead.closes && l.ahead.closes <= nextYearEnd).map((l) => ({ name: l.name, closes: l.ahead.closes })),
      missing: active.filter((l) => l.missing.length).map((l) => ({ name: l.name, months: l.missing })),
    },
  };
}
