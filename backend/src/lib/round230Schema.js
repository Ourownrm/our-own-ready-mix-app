// Round 230 (owner, 22 Oct 2026):
//   * Accounts — one customer / project entered twice: merge the duplicate
//     into the real one (lib/recordMerge.js), with an audit row per merge.
//   * HR — an advance for a pump gang as a whole. Raised, approved and paid
//     like a salary advance; the payment goes into the gang's contractor
//     ledger as an on-account payment, so the month's bill (GST / TDS on the
//     full amount) is unchanged and the advance comes off what is still due.
import { ROUND230_MERGE_SQL } from "./recordMerge.js";

const ROUND230_SQL = `
${ROUND230_MERGE_SQL}
CREATE TABLE IF NOT EXISTS hr_gang_advances (
  id               SERIAL PRIMARY KEY,
  gang_id          INTEGER NOT NULL REFERENCES hr_gangs(id),
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  approved_amount  NUMERIC(12,2),
  recover_month    VARCHAR(7) NOT NULL,          -- the gang month (bill) it is against
  purpose          VARCHAR(500),
  status           VARCHAR(12) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'paid')),
  raised_by        INTEGER REFERENCES users(id),
  raised_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by       INTEGER REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  decision_note    VARCHAR(500),
  payment_id       INTEGER REFERENCES hr_contractor_payments(id),
  paid_to          VARCHAR(100)                  -- who in the gang took the cash (usually the leader)
);
CREATE INDEX IF NOT EXISTS idx_hr_gang_advances_gang ON hr_gang_advances (gang_id, recover_month);
CREATE INDEX IF NOT EXISTS idx_hr_gang_advances_open ON hr_gang_advances (status) WHERE status IN ('pending', 'approved');
`;

export async function migrateRound230(pool, log) {
  await pool.query(ROUND230_SQL);
  log?.push?.("Round 230: customer / project merge, pump gang advances.");
}
