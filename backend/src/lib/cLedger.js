// Round 224 — C Ledger (owner, 21 Oct 2026; mock-up claude/site-ledger-mockup-v1.md).
// The owner's separate "Site Ledger" phone app, brought into the Cost module:
// delivery records with split cash collections handed to cash holders, who
// accept or reject them, pass cash to each other or into the bank, and spend
// it on expenses.
//
// WHO SEES IT — the owner's rule: closed to EVERYONE, Administrator and Super
// Admin included, unless given by name. Four permissions per person, kept in
// cl_access and deliberately NOT in the role catalogue (Administrator holds
// every catalogue function, so a catalogue key would hand it to them):
//   entry         add / edit delivery records and collection lines, reassign
//                 a rejected collection, flag, change an expense's category
//                 (includes view_entries)
//   view_entries  delivery records, collections, balances due — read only
//   cash_holder   own wallet: accept / reject collections sent to them,
//                 transfer, deposit to bank, own expenses
//   view_txns     every cash holder's balance, transfers, deposits, expenses
// Only a Super Admin sets these (routes/cLedger.js, /access).
//
// INTO SALES AND COST — the owner's rules:
//   * No C Ledger line and no C Ledger mark anywhere in the Cost dashboard or
//     P&L. Amounts go straight into the existing heads.
//   * The flag decides tax, and the words "with / without GST" appear on no
//     screen: a FLAGGED sale counts as amount × 100 / 118, a not-flagged sale
//     in full; a FLAGGED expense counts as amount × 100 / 118, a not-flagged
//     one in full. Cash in hand always uses the full amount.
//   * Sales: a delivery record tied to its delivery note(s) SETS the sale value
//     of those notes (it replaces the invoice figure for them, so the load is
//     never counted twice). Round 227 (owner): a record with NO delivery note is
//     NOT counted in Sales — every delivery has a challan in the app, so an
//     unlinked record is only a collection (e.g. an old outstanding amount).
//   * Other income (Round 227 — scrap sale, used oil sale …): added to the P&L's
//     Other income for the month of its date, flag rule applied.
//   * Expenses: added to the head of their category for the month of their date.
//     "Supplier payment" is not a cost: the material is already costed through
//     the Raw Material receipts (Round 227).
//   * A collection line may be "Paid to bank" (Round 227): counted as collected,
//     in nobody's cash in hand, nothing to accept.
import { query } from "../db.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
export const CL_FACTOR = 100 / 118;

// Expense categories → the Cost dashboard's own head keys (lib/costDashboard.js).
export const CL_CATEGORIES = [
  { key: "fuel", label: "Fuel" },
  { key: "repairs", label: "Repairs & maintenance" },
  { key: "contract_labour", label: "Contract labour / pump gangs" },
  { key: "hired_vehicles", label: "Hired vehicles & pumps" },
  { key: "rm", label: "Raw material — bought for cash, not in receipts" },
  { key: "power", label: "Plant power" },
  { key: "salaries", label: "Salaries & wages" },
  { key: "admin_office", label: "Admin & office" },
  { key: "selling", label: "Selling & marketing" },
  { key: "rent_rates", label: "Rent & rates" },
  { key: "supplier_payment", label: "Supplier payment — not a cost", notCost: true },
  { key: "staff_advance", label: "Not a cost — staff advance", notCost: true },
  { key: "personal", label: "Not a cost — owner / personal", notCost: true },
  { key: "todo", label: "To categorise", notCost: true },
];
export const CL_CATEGORY_KEYS = new Set(CL_CATEGORIES.map((c) => c.key));
const COST_KEYS = new Set(CL_CATEGORIES.filter((c) => !c.notCost).map((c) => c.key));
// Round 227 — other income kinds.
export const CL_INCOME_KINDS = [
  { key: "scrap", label: "Scrap sale" },
  { key: "used_oil", label: "Used oil sale" },
  { key: "other", label: "Other income" },
];
export const CL_INCOME_KEYS = new Set(CL_INCOME_KINDS.map((k) => k.key));

export const ROUND224_SQL = `
CREATE TABLE IF NOT EXISTS cl_access (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id),
  can_entry         BOOLEAN NOT NULL DEFAULT false,
  can_view_entries  BOOLEAN NOT NULL DEFAULT false,
  is_cash_holder    BOOLEAN NOT NULL DEFAULT false,
  can_view_txns     BOOLEAN NOT NULL DEFAULT false,
  short_name        VARCHAR(12),
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cl_access_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  before      JSONB,
  after       JSONB,
  changed_by  INTEGER REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cl_deliveries (
  id             SERIAL PRIMARY KEY,
  entry_date     DATE NOT NULL,
  customer_name  VARCHAR(200) NOT NULL,
  location       VARCHAR(200),
  customer_id    INTEGER REFERENCES customers(id),
  site_id        INTEGER REFERENCES sites(id),
  grade          VARCHAR(20),
  qty_m3         NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (qty_m3 >= 0),
  rate           NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  other_charges  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other_charges >= 0),
  sales_rep      VARCHAR(100),
  flagged        BOOLEAN NOT NULL DEFAULT false,
  note           TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TIMESTAMPTZ,
  deleted_by     INTEGER REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cl_deliveries_date ON cl_deliveries(entry_date) WHERE deleted_at IS NULL;
-- A delivery note belongs to at most one C Ledger record.
CREATE TABLE IF NOT EXISTS cl_delivery_tickets (
  delivery_id  INTEGER NOT NULL REFERENCES cl_deliveries(id),
  ticket_id    INTEGER NOT NULL REFERENCES delivery_tickets(id),
  PRIMARY KEY (delivery_id, ticket_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_delivery_ticket ON cl_delivery_tickets(ticket_id);
CREATE TABLE IF NOT EXISTS cl_collections (
  id             SERIAL PRIMARY KEY,
  delivery_id    INTEGER NOT NULL REFERENCES cl_deliveries(id),
  amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  holder_id      INTEGER NOT NULL REFERENCES users(id),
  mode           VARCHAR(10) NOT NULL DEFAULT 'cash' CHECK (mode IN ('cash','upi','cheque')),
  status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  reject_reason  TEXT,
  responded_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_collections_holder ON cl_collections(holder_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_collections_delivery ON cl_collections(delivery_id);
-- kind 'holder': cash passed to another cash holder (they accept or reject);
-- kind 'bank': cash put into the company's bank account (no acceptance).
CREATE TABLE IF NOT EXISTS cl_transfers (
  id            SERIAL PRIMARY KEY,
  txn_date      DATE NOT NULL,
  kind          VARCHAR(10) NOT NULL CHECK (kind IN ('holder','bank')),
  from_id       INTEGER NOT NULL REFERENCES users(id),
  to_id         INTEGER REFERENCES users(id),
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note          TEXT,
  status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  responded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cl_transfers_from ON cl_transfers(from_id);
CREATE INDEX IF NOT EXISTS idx_cl_transfers_to ON cl_transfers(to_id);
CREATE TABLE IF NOT EXISTS cl_expenses (
  id           SERIAL PRIMARY KEY,
  holder_id    INTEGER NOT NULL REFERENCES users(id),
  txn_date     DATE NOT NULL,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  where_spent  TEXT NOT NULL,
  category     VARCHAR(20) NOT NULL DEFAULT 'todo',
  flagged      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TIMESTAMPTZ,
  deleted_by   INTEGER REFERENCES users(id),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cl_expenses_date ON cl_expenses(txn_date) WHERE deleted_at IS NULL;
-- Every change, for the record.
CREATE TABLE IF NOT EXISTS cl_log (
  id         SERIAL PRIMARY KEY,
  kind       VARCHAR(12) NOT NULL,
  ref_id     INTEGER,
  action     VARCHAR(30) NOT NULL,
  detail     JSONB,
  done_by    INTEGER REFERENCES users(id),
  done_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrateRound224(pool, log) {
  await pool.query(ROUND224_SQL);
  log?.push?.("Round 224: C Ledger (Cost module).");
}

// Round 227 — "Paid to bank" collection lines (no cash holder, mode 'bank',
// accepted at once, the day it reached the bank), and other income.
export const ROUND227_SQL = `
ALTER TABLE cl_collections ALTER COLUMN holder_id DROP NOT NULL;
ALTER TABLE cl_collections DROP CONSTRAINT IF EXISTS cl_collections_mode_check;
ALTER TABLE cl_collections ADD CONSTRAINT cl_collections_mode_check CHECK (mode IN ('cash','upi','cheque','bank'));
ALTER TABLE cl_collections ADD COLUMN IF NOT EXISTS paid_on DATE;
-- received_by NULL = straight into the bank. Received by a cash holder: it is
-- in their cash once accepted (at once when they entered it themselves).
CREATE TABLE IF NOT EXISTS cl_incomes (
  id            SERIAL PRIMARY KEY,
  txn_date      DATE NOT NULL,
  kind          VARCHAR(12) NOT NULL DEFAULT 'other',
  source        TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  received_by   INTEGER REFERENCES users(id),
  status        VARCHAR(10) NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending','accepted','rejected')),
  reject_reason TEXT,
  responded_at  TIMESTAMPTZ,
  flagged       BOOLEAN NOT NULL DEFAULT false,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cl_incomes_date ON cl_incomes(txn_date) WHERE deleted_at IS NULL;
`;
export async function migrateRound227(pool, log) {
  await pool.query(ROUND227_SQL);
  log?.push?.("Round 227: C Ledger — paid to bank, other income.");
}

// ------------------------------------------------------------ access ---
const NONE = { entry: false, view_entries: false, cash_holder: false, view_txns: false, short_name: null };
export async function clAccess(userId) {
  if (!userId) return { ...NONE, any: false };
  const { rows } = await query(
    `SELECT a.*, u.is_active FROM cl_access a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1`, [userId]).catch(() => ({ rows: [] }));
  const a = rows[0];
  if (!a || !a.is_active) return { ...NONE, any: false };
  const out = {
    entry: a.can_entry, view_entries: a.can_entry || a.can_view_entries, cash_holder: a.is_cash_holder,
    view_txns: a.can_view_txns, short_name: a.short_name,
  };
  out.any = out.entry || out.view_entries || out.cash_holder || out.view_txns;
  return out;
}

// Middleware: passes when the person holds ANY of the named C Ledger rights.
export function requireCl(...rights) {
  return async (req, res, next) => {
    try {
      const a = await clAccess(req.user?.id);
      req.cl = a;
      if (rights.length === 0 ? a.any : rights.some((r) => a[r])) return next();
      return res.status(403).json({ error: "You don't have access to this." });
    } catch (err) { return next(err); }
  };
}

export async function clLog(client, kind, refId, action, detail, by) {
  await (client || { query }).query(
    `INSERT INTO cl_log (kind, ref_id, action, detail, done_by) VALUES ($1, $2, $3, $4, $5)`,
    [kind, refId, action, detail ? JSON.stringify(detail) : null, by]);
}

// --------------------------------------------------------- balances ---
// Cash in hand per holder: accepted collections + accepted transfers in −
// transfers out (pending ones too: the cash has left the sender) − bank
// deposits − expenses. Full amounts, flag or not.
export async function holderBalances(upToDay = null) {
  const d = upToDay;
  const { rows } = await query(
    `SELECT a.user_id AS id, u.name, COALESCE(a.short_name, u.name) AS short, u.is_active,
            COALESCE((SELECT SUM(c.amount) FROM cl_collections c JOIN cl_deliveries dl ON dl.id = c.delivery_id
                       WHERE c.holder_id = a.user_id AND c.status = 'accepted' AND dl.deleted_at IS NULL
                         AND ($1::date IS NULL OR dl.entry_date <= $1::date)), 0) AS collected,
            COALESCE((SELECT SUM(c.amount) FROM cl_collections c JOIN cl_deliveries dl ON dl.id = c.delivery_id
                       WHERE c.holder_id = a.user_id AND c.status = 'pending' AND dl.deleted_at IS NULL), 0) AS pending_collections,
            COALESCE((SELECT SUM(t.amount) FROM cl_transfers t WHERE t.to_id = a.user_id AND t.kind = 'holder'
                       AND t.status = 'accepted' AND t.deleted_at IS NULL AND ($1::date IS NULL OR t.txn_date <= $1::date)), 0) AS transfer_in,
            COALESCE((SELECT SUM(t.amount) FROM cl_transfers t WHERE t.to_id = a.user_id AND t.kind = 'holder'
                       AND t.status = 'pending' AND t.deleted_at IS NULL), 0) AS pending_in,
            COALESCE((SELECT SUM(t.amount) FROM cl_transfers t WHERE t.from_id = a.user_id AND t.kind = 'holder'
                       AND t.status <> 'rejected' AND t.deleted_at IS NULL AND ($1::date IS NULL OR t.txn_date <= $1::date)), 0) AS transfer_out,
            COALESCE((SELECT SUM(t.amount) FROM cl_transfers t WHERE t.from_id = a.user_id AND t.kind = 'bank'
                       AND t.deleted_at IS NULL AND ($1::date IS NULL OR t.txn_date <= $1::date)), 0) AS deposited,
            COALESCE((SELECT SUM(x.amount) FROM cl_expenses x WHERE x.holder_id = a.user_id AND x.deleted_at IS NULL
                       AND ($1::date IS NULL OR x.txn_date <= $1::date)), 0) AS expenses,
            COALESCE((SELECT SUM(i.amount) FROM cl_incomes i WHERE i.received_by = a.user_id AND i.status = 'accepted' AND i.deleted_at IS NULL
                       AND ($1::date IS NULL OR i.txn_date <= $1::date)), 0) AS income,
            COALESCE((SELECT SUM(i.amount) FROM cl_incomes i WHERE i.received_by = a.user_id AND i.status = 'pending' AND i.deleted_at IS NULL), 0) AS pending_income
       FROM cl_access a JOIN users u ON u.id = a.user_id
      WHERE a.is_cash_holder OR EXISTS (SELECT 1 FROM cl_collections c WHERE c.holder_id = a.user_id)
      ORDER BY COALESCE(a.short_name, u.name)`, [d]);
  return rows.map((r) => {
    const o = { id: r.id, name: r.name, short: r.short, is_active: r.is_active };
    for (const k of ["collected", "pending_collections", "transfer_in", "pending_in", "transfer_out", "deposited", "expenses", "income", "pending_income"]) o[k] = r2(r[k]);
    o.balance = r2(o.collected + o.income + o.transfer_in - o.transfer_out - o.deposited - o.expenses);
    o.awaiting = r2(o.pending_collections + o.pending_in + o.pending_income);
    return o;
  });
}

// ------------------------------------------------- into Sales and Cost ---
export function clDeliveryTotal(d) {
  return r2(n0(d.qty_m3) * n0(d.rate) + n0(d.other_charges));
}

// Sale value of the delivery notes tied to C Ledger records, keyed by
// ticket id. A record's amount is shared between its notes by loaded m³.
export async function clTicketSales(ticketIds) {
  const out = new Map();
  if (!ticketIds.length) return out;
  const { rows } = await query(
    `SELECT l.delivery_id, l.ticket_id, d.qty_m3, d.rate, d.other_charges, d.flagged,
            COALESCE(t.loaded_quantity_m3, 0) AS loaded,
            SUM(COALESCE(t.loaded_quantity_m3, 0)) OVER (PARTITION BY l.delivery_id) AS loaded_all,
            COUNT(*) OVER (PARTITION BY l.delivery_id) AS n
       FROM cl_delivery_tickets l
       JOIN cl_deliveries d ON d.id = l.delivery_id AND d.deleted_at IS NULL
       JOIN delivery_tickets t ON t.id = l.ticket_id
      WHERE l.delivery_id IN (SELECT delivery_id FROM cl_delivery_tickets WHERE ticket_id = ANY($1::int[]))`,
    [ticketIds]).catch(() => ({ rows: [] }));
  for (const r of rows) {
    const share = n0(r.loaded_all) > 0 ? n0(r.loaded) / n0(r.loaded_all) : 1 / Math.max(1, Number(r.n));
    const f = r.flagged ? CL_FACTOR : 1;
    out.set(r.ticket_id, {
      concrete: n0(r.qty_m3) * n0(r.rate) * share * f,
      pumping: n0(r.other_charges) * share * f,
      gross: (n0(r.qty_m3) * n0(r.rate) + n0(r.other_charges)) * share,
    });
  }
  return out;
}

// Round 227 — other income for a month (scrap, used oil …), flag rule applied.
export async function clOtherIncomeMonth(ym) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount * CASE WHEN flagged THEN $2::numeric ELSE 1 END), 0) AS v
       FROM cl_incomes WHERE deleted_at IS NULL AND status <> 'rejected' AND to_char(txn_date, 'YYYY-MM') = $1`,
    [ym, CL_FACTOR]).catch(() => ({ rows: [{ v: 0 }] }));
  return r2(rows[0].v);
}

// Expenses by Cost dashboard head for a month.
export async function clExpenseHeadsMonth(ym) {
  const { rows } = await query(
    `SELECT category, SUM(amount * CASE WHEN flagged THEN $2::numeric ELSE 1 END) AS v
       FROM cl_expenses WHERE deleted_at IS NULL AND to_char(txn_date, 'YYYY-MM') = $1 GROUP BY category`,
    [ym, CL_FACTOR]).catch(() => ({ rows: [] }));
  const out = {};
  for (const r of rows) if (COST_KEYS.has(r.category)) out[r.category] = r2(r.v);
  return out;
}
