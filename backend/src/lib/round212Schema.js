// Round 212 — correcting payment entries in the customer ledger (owner,
// 16 Oct 2026): the Accountant can edit or delete a wrong receipt / payment.
//
//  * Nothing is lost: a deleted receipt is cancelled (kept, hidden from the
//    ledger), an old-style payment is removed — and every edit or delete is
//    written to customer_ledger_corrections with the values before and after,
//    who did it and why. The statement shows that log.
//  * customer_receipts.edited_at / edited_by mark a receipt that was changed.
export const ROUND212_SQL = `
CREATE TABLE IF NOT EXISTS customer_ledger_corrections (
  id           SERIAL PRIMARY KEY,
  entry_kind   VARCHAR(10) NOT NULL CHECK (entry_kind IN ('receipt','payment')),
  entry_id     INTEGER NOT NULL,
  customer_id  INTEGER REFERENCES customers(id),
  action       VARCHAR(10) NOT NULL CHECK (action IN ('edit','delete')),
  before_value JSONB,
  after_value  JSONB,
  reason       TEXT NOT NULL,
  done_by      INTEGER REFERENCES users(id),
  done_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_corrections_customer ON customer_ledger_corrections(customer_id, done_at);
ALTER TABLE customer_receipts ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE customer_receipts ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
`;

export async function migrateRound212(pool, log) {
  await pool.query(ROUND212_SQL);
  log.push("Schema migration applied (Round 212 — edit / delete payment entries in the customer ledger, with a corrections log).");
}
