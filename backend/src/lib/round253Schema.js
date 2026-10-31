// Round 253 (v10.85) — owner, 30 Oct 2026; mock-up "Cheques & Petty Cash"
// (Accounts → Cheques, Accounts → Petty cash).
//
// CHEQUES — a register, not a second ledger. Money still reaches the ledgers
// the way it does today: a cheque credit / debit on the bank statement is
// posted from Cost → Bank statements (customer receipt, supplier payment …).
// The register tracks each cheque from receipt to clearing:
//   received  in_hand → deposited → cleared
//             in_hand / deposited → bounced → re-presented (deposited) …
//             in_hand / bounced → returned (owner: "a PDC is returned and
//               instead they paid through bank transfer or cash") — the
//               payments that replaced it are recorded against it
//             in_hand → cancelled (entered by mistake)
//   issued    issued → cleared | cancelled (leaf void) | stopped
// A deposited / issued cheque is marked cleared on its own when an uploaded
// bank statement line carries its number and amount (matchCheques below).
// A bounce cancels the customer receipt that the cleared credit had posted.
//
// PETTY CASH — cash boxes with a fixed float (imprest). Owner: money comes in
// two ways, both recorded — a top-up REQUEST (holder asks, approver approves,
// then it is paid), or DIRECT — from a bank transfer, a self cheque, a cash
// withdrawal or from a C Ledger cash holder's cash. Vouchers spend it;
// approved expense vouchers go into the Cost dashboard head of their
// category (the same categories and flag rule as C Ledger), advances only
// once settled with what was spent.
import { query } from "../db.js";
import { CL_CATEGORIES, CL_FACTOR } from "./cLedger.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;

export const ROUND253_SQL = `
CREATE TABLE IF NOT EXISTS cheque_books (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES cost_bank_accounts(id),
  first_no      INTEGER NOT NULL CHECK (first_no > 0),
  last_no       INTEGER NOT NULL,
  digits        SMALLINT NOT NULL DEFAULT 6,
  received_on   DATE,
  note          VARCHAR(200),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (last_no >= first_no AND last_no - first_no < 1000)
);

CREATE TABLE IF NOT EXISTS cheques (
  id                  SERIAL PRIMARY KEY,
  direction           VARCHAR(8) NOT NULL CHECK (direction IN ('received','issued')),
  cheque_no           VARCHAR(12) NOT NULL,
  cheque_date         DATE NOT NULL,
  amount              NUMERIC(14,2) CHECK (amount IS NULL OR amount > 0),
  status              VARCHAR(10) NOT NULL CHECK (status IN ('in_hand','deposited','cleared','bounced','returned','cancelled','issued','stopped')),
  -- received from a customer
  customer_id         INTEGER REFERENCES customers(id),
  drawn_on            VARCHAR(120),
  deposit_account_id  INTEGER REFERENCES cost_bank_accounts(id),
  received_on         DATE,
  -- issued by us
  account_id          INTEGER REFERENCES cost_bank_accounts(id),
  book_id             INTEGER REFERENCES cheque_books(id),
  payee_kind          VARCHAR(12) CHECK (payee_kind IS NULL OR payee_kind IN ('supplier','transporter','contractor','self','other')),
  payee_id            INTEGER,
  payee_name          VARCHAR(200),
  purpose             VARCHAR(300),
  -- the life of it
  deposited_on        DATE,
  slip_no             VARCHAR(40),
  presentations       SMALLINT NOT NULL DEFAULT 0,
  cleared_on          DATE,
  bank_line_id        INTEGER,
  receipt_id          INTEGER,
  bounced_on          DATE,
  bounce_reason       VARCHAR(200),
  bounce_charges      NUMERIC(10,2),
  notice_on           DATE,
  returned_on         DATE,
  return_note         VARCHAR(300),
  cancelled_on        DATE,
  cancel_reason       VARCHAR(300),
  photo               TEXT,
  remarks             VARCHAR(300),
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          INTEGER REFERENCES users(id),
  updated_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_cheques_status ON cheques(direction, status);
CREATE INDEX IF NOT EXISTS ix_cheques_customer ON cheques(customer_id);
CREATE INDEX IF NOT EXISTS ix_cheques_date ON cheques(cheque_date);
-- One leaf of our cheque book is one record, whatever became of it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cheques_issued_leaf ON cheques(account_id, cheque_no) WHERE direction = 'issued';
CREATE UNIQUE INDEX IF NOT EXISTS uq_cheques_bank_line ON cheques(bank_line_id) WHERE bank_line_id IS NOT NULL;
-- Lines a bounced cheque cleared on before — never matched to it again.
ALTER TABLE cheques ADD COLUMN IF NOT EXISTS old_bank_lines INTEGER[] NOT NULL DEFAULT '{}';

-- What paid instead of a returned cheque (cash or bank transfer).
CREATE TABLE IF NOT EXISTS cheque_replacements (
  id          SERIAL PRIMARY KEY,
  cheque_id   INTEGER NOT NULL REFERENCES cheques(id),
  mode        VARCHAR(14) NOT NULL CHECK (mode IN ('cash','bank_transfer')),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_on     DATE,
  reference   VARCHAR(80),
  receipt_id  INTEGER,
  posting     VARCHAR(8) NOT NULL DEFAULT 'later' CHECK (posting IN ('new','link','later','none')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_cheque_repl_cheque ON cheque_replacements(cheque_id);

CREATE TABLE IF NOT EXISTS cheque_events (
  id         SERIAL PRIMARY KEY,
  cheque_id  INTEGER NOT NULL REFERENCES cheques(id),
  action     VARCHAR(30) NOT NULL,
  detail     JSONB,
  done_by    INTEGER REFERENCES users(id),
  done_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cheque_events ON cheque_events(cheque_id);

-- ------------------------------------------------------------ petty cash --
CREATE TABLE IF NOT EXISTS pc_boxes (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(80) NOT NULL UNIQUE,
  holder_id        INTEGER REFERENCES users(id),
  approver_id      INTEGER REFERENCES users(id),
  float_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (float_amount >= 0),
  approval_limit   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (approval_limit >= 0),
  topup_below_pct  SMALLINT NOT NULL DEFAULT 25 CHECK (topup_below_pct BETWEEN 0 AND 100),
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ
);

-- Money into a box: by request (requested → approved → received) or direct
-- (received at once). source says where the cash came from.
CREATE TABLE IF NOT EXISTS pc_topups (
  id              SERIAL PRIMARY KEY,
  box_id          INTEGER NOT NULL REFERENCES pc_boxes(id),
  status          VARCHAR(10) NOT NULL CHECK (status IN ('requested','approved','rejected','cancelled','received')),
  direct          BOOLEAN NOT NULL DEFAULT false,
  request_amount  NUMERIC(12,2),
  request_note    VARCHAR(300),
  requested_by    INTEGER REFERENCES users(id),
  requested_at    TIMESTAMPTZ,
  decided_by      INTEGER REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  decision_note   VARCHAR(300),
  amount          NUMERIC(12,2) CHECK (amount IS NULL OR amount > 0),
  source          VARCHAR(16) CHECK (source IS NULL OR source IN ('bank_transfer','cheque','cash_withdrawal','cledger')),
  account_id      INTEGER REFERENCES cost_bank_accounts(id),
  reference       VARCHAR(80),
  cheque_id       INTEGER REFERENCES cheques(id),
  cl_holder_id    INTEGER REFERENCES users(id),
  cl_transfer_id  INTEGER,
  received_on     DATE,
  recorded_by     INTEGER REFERENCES users(id),
  recorded_at     TIMESTAMPTZ,
  cancel_reason   VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS ix_pc_topups_box ON pc_topups(box_id, status);

-- kind expense: cash spent; advance: cash given to someone to spend and
-- settle; settle: what an advance was spent on (the cash already left with
-- the advance — what came back is the advance's returned_amount).
CREATE TABLE IF NOT EXISTS pc_vouchers (
  id               SERIAL PRIMARY KEY,
  box_id           INTEGER NOT NULL REFERENCES pc_boxes(id),
  kind             VARCHAR(8) NOT NULL CHECK (kind IN ('expense','advance','settle')),
  txn_date         DATE NOT NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  paid_to          VARCHAR(150) NOT NULL,
  purpose          VARCHAR(300),
  category         VARCHAR(20),
  asset_id         INTEGER,
  bill             VARCHAR(6) NOT NULL DEFAULT 'none' CHECK (bill IN ('photo','slip','none')),
  bill_photo       TEXT,
  flagged          BOOLEAN NOT NULL DEFAULT false,
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by       INTEGER REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  decision_note    VARCHAR(300),
  advance_id       INTEGER REFERENCES pc_vouchers(id),
  settled_on       DATE,
  returned_amount  NUMERIC(12,2),
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TIMESTAMPTZ,
  deleted_by       INTEGER REFERENCES users(id),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_pc_vouchers_box ON pc_vouchers(box_id, txn_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_pc_vouchers_date ON pc_vouchers(txn_date) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pc_counts (
  id           SERIAL PRIMARY KEY,
  box_id       INTEGER NOT NULL REFERENCES pc_boxes(id),
  counted_on   DATE NOT NULL,
  notes        JSONB,
  counted      NUMERIC(12,2) NOT NULL,
  book         NUMERIC(12,2) NOT NULL,
  diff         NUMERIC(12,2) NOT NULL,
  reason       VARCHAR(300),
  counted_by   INTEGER REFERENCES users(id),
  counted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pc_log (
  id       SERIAL PRIMARY KEY,
  box_id   INTEGER,
  kind     VARCHAR(10) NOT NULL,
  ref_id   INTEGER,
  action   VARCHAR(30) NOT NULL,
  detail   JSONB,
  done_by  INTEGER REFERENCES users(id),
  done_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- C Ledger: a cash holder's cash handed into a petty cash box.
ALTER TABLE cl_transfers DROP CONSTRAINT IF EXISTS cl_transfers_kind_check;
ALTER TABLE cl_transfers ADD CONSTRAINT cl_transfers_kind_check CHECK (kind IN ('holder','bank','petty'));
`;

let ready = null;
export function ensureRound253() {
  if (!ready) ready = query(ROUND253_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound253(pool, log) {
  await pool.query(ROUND253_SQL);
  log?.push?.("Round 253: Accounts → Cheques (register, cheque books, returned PDC paid by bank / cash) and Petty cash (boxes, vouchers, top-ups by request or direct from bank / C Ledger).");
}

// ================================================================ cheques ===
export const RECEIVED_STATUS = ["in_hand", "deposited", "cleared", "bounced", "returned", "cancelled"];
export const ISSUED_STATUS = ["issued", "cleared", "cancelled", "stopped"];

// A cheque number as digits with the leading zeros taken off ("000123" → "123").
export const bareNo = (no) => String(no || "").replace(/\D/g, "").replace(/^0+/, "");

export async function chequeEvent(db, chequeId, action, detail, userId) {
  await db.query(`INSERT INTO cheque_events (cheque_id, action, detail, done_by) VALUES ($1, $2, $3, $4)`,
    [chequeId, action, detail ? JSON.stringify(detail) : null, userId || null]);
}

// Clear deposited / issued cheques from the uploaded bank statements: a line
// on the right side (credit for received, debit for issued), the same amount
// (± ₹1), the cheque's number in the narration or reference, not before the
// cheque date (or the day it was deposited), from the right account when one
// is known, and not already a line of another cheque. Also links the customer
// receipt a cleared cheque's line posted, and a bank-transfer payment that
// replaced a returned cheque to its receipt. Cheap — runs on every list.
export async function matchCheques(db = { query }) {
  await ensureRound253();
  const out = { cleared: 0, linked: 0 };
  const { rows: cands } = await db.query(
    `SELECT id, direction, cheque_no, amount, status, cheque_date::text AS cheque_date, deposited_on::text AS deposited_on,
            COALESCE(deposit_account_id, account_id) AS acc, old_bank_lines
       FROM cheques
      WHERE amount IS NOT NULL AND bank_line_id IS NULL
        AND ((direction = 'received' AND status IN ('in_hand','deposited','cleared')) OR (direction = 'issued' AND status IN ('issued','cleared')))`);
  for (const c of cands) {
    const no = bareNo(c.cheque_no);
    if (no.length < 3) continue;
    const credit = c.direction === "received";
    const after = c.deposited_on && c.deposited_on > c.cheque_date ? c.deposited_on : c.cheque_date;
    const { rows } = await db.query(
      `SELECT l.id, l.txn_date::text AS txn_date, l.post_kind, l.post_id FROM cost_bank_lines l
        WHERE ${credit ? "l.credit" : "l.debit"} BETWEEN $1::numeric - 1 AND $1::numeric + 1
          AND l.txn_date >= ($2::date - 2) AND l.txn_date <= ($2::date + 90)
          AND ($3::int IS NULL OR l.account_id = $3)
          AND (COALESCE(l.narration, '') || ' ' || COALESCE(l.reference, '')) ~ ('(^|[^0-9])0*' || $4 || '([^0-9]|$)')
          AND NOT EXISTS (SELECT 1 FROM cheques x WHERE x.bank_line_id = l.id)
          AND NOT (l.id = ANY($5::int[]))
        ORDER BY l.txn_date, l.id LIMIT 1`,
      [c.amount, after, c.acc || null, no, c.old_bank_lines || []]).catch(() => ({ rows: [] }));
    const l = rows[0];
    if (!l) continue;
    const receipt = credit && l.post_kind === "customer" ? l.post_id : null;
    if (c.status === "cleared") {
      await db.query(`UPDATE cheques SET bank_line_id = $2, receipt_id = COALESCE(receipt_id, $3) WHERE id = $1`, [c.id, l.id, receipt]);
      out.linked++;
    } else {
      // A cheque still marked "in hand" that the bank credited was deposited
      // without anyone marking it — the credit day stands in for that.
      await db.query(`UPDATE cheques SET status = 'cleared', cleared_on = $2, bank_line_id = $3, receipt_id = COALESCE(receipt_id, $4),
                             deposited_on = CASE WHEN direction = 'received' THEN COALESCE(deposited_on, $2::date) ELSE deposited_on END,
                             presentations = CASE WHEN direction = 'received' THEN GREATEST(presentations, 1) ELSE presentations END,
                             updated_at = now() WHERE id = $1`,
        [c.id, l.txn_date, l.id, receipt]);
      await chequeEvent(db, c.id, "cleared", { by: "bank statement", bank_line_id: l.id, date: l.txn_date }, null);
      out.cleared++;
    }
  }
  // A line posted to the customer AFTER the cheque was matched: pick up its receipt.
  await db.query(
    `UPDATE cheques c SET receipt_id = l.post_id FROM cost_bank_lines l
      WHERE c.bank_line_id = l.id AND c.direction = 'received' AND c.status = 'cleared' AND c.receipt_id IS NULL
        AND l.post_kind = 'customer' AND l.post_id IS NOT NULL`).catch(() => {});
  // Bank transfers that replaced a returned cheque: the receipt the bank
  // statement posted for that customer, same amount, on or after the return.
  const { rows: repl } = await db.query(
    `SELECT r.id, r.amount, COALESCE(r.paid_on, c.returned_on, c.cheque_date)::text AS since, c.customer_id
       FROM cheque_replacements r JOIN cheques c ON c.id = r.cheque_id
      WHERE r.removed_at IS NULL AND r.mode = 'bank_transfer' AND r.receipt_id IS NULL AND r.posting = 'later'`).catch(() => ({ rows: [] }));
  for (const r of repl) {
    const { rows } = await db.query(
      `SELECT cr.id, cr.receipt_date::text AS d FROM customer_receipts cr
        WHERE cr.customer_id = $1 AND cr.cancelled_at IS NULL AND cr.mode::text <> 'cash'
          AND cr.amount BETWEEN $2::numeric - 1 AND $2::numeric + 1 AND cr.receipt_date >= ($3::date - 3)
          AND NOT EXISTS (SELECT 1 FROM cheque_replacements x WHERE x.receipt_id = cr.id AND x.removed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM cheques x WHERE x.receipt_id = cr.id AND x.status = 'cleared')
        ORDER BY cr.receipt_date, cr.id LIMIT 1`, [r.customer_id, r.amount, r.since]).catch(() => ({ rows: [] }));
    if (!rows[0]) continue;
    await db.query(`UPDATE cheque_replacements SET receipt_id = $2, paid_on = COALESCE(paid_on, $3::date) WHERE id = $1`, [r.id, rows[0].id, rows[0].d]);
    out.linked++;
  }
  return out;
}

// ============================================================= petty cash ===
export const PC_COST_KEYS = new Set(CL_CATEGORIES.filter((c) => !c.notCost).map((c) => c.key));
// What a voucher can be booked to: the C Ledger categories that are a cost
// or "not a cost" (no party ledgers — a party is paid from the bank or C Ledger).
export const PC_CATEGORIES = CL_CATEGORIES.filter((c) => !c.party);
export const PC_CATEGORY_KEYS = new Set(PC_CATEGORIES.map((c) => c.key));

// Cash in each box by the book: top-ups received − vouchers (expense and
// advance, not rejected) + what came back from settled advances.
export async function boxBalances(db = { query }, boxId = null) {
  await ensureRound253();
  const { rows } = await db.query(
    `SELECT b.id,
            COALESCE((SELECT SUM(t.amount) FROM pc_topups t WHERE t.box_id = b.id AND t.status = 'received'), 0) AS topups,
            COALESCE((SELECT SUM(v.amount) FROM pc_vouchers v WHERE v.box_id = b.id AND v.deleted_at IS NULL
                       AND v.status <> 'rejected' AND v.kind IN ('expense','advance')), 0) AS paid_out,
            COALESCE((SELECT SUM(v.returned_amount) FROM pc_vouchers v WHERE v.box_id = b.id AND v.deleted_at IS NULL
                       AND v.kind = 'advance' AND v.settled_on IS NOT NULL AND v.status <> 'rejected'), 0) AS came_back
       FROM pc_boxes b WHERE ($1::int IS NULL OR b.id = $1)`, [boxId]);
  const out = new Map();
  for (const r of rows) out.set(r.id, { topups: r2(r.topups), paid_out: r2(r.paid_out), came_back: r2(r.came_back), balance: r2(n0(r.topups) - n0(r.paid_out) + n0(r.came_back)) });
  return out;
}

// Approved petty cash expenses by Cost dashboard head for a month, the C
// Ledger flag rule applied. Round 255: flagged = no tax (full amount); not
// flagged = tax inside (amount × 100 / 118).
export async function pettyHeadsMonth(ym) {
  const { ensureRound255 } = await import("./round255Schema.js");
  await ensureRound255().catch(() => {});
  const { rows } = await query(
    `SELECT category, SUM(amount * CASE WHEN flagged THEN 1 ELSE $2::numeric END) AS v
       FROM pc_vouchers WHERE deleted_at IS NULL AND status = 'approved' AND kind IN ('expense','settle')
        AND to_char(txn_date, 'YYYY-MM') = $1 GROUP BY category`, [ym, CL_FACTOR]).catch(() => ({ rows: [] }));
  const out = {};
  for (const r of rows) if (PC_COST_KEYS.has(r.category)) out[r.category] = r2(r.v);
  return out;
}
