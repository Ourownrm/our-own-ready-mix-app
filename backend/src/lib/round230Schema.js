// Round 230 (owner, 22 Oct 2026):
//   * Accounts — one customer / project entered twice: merge the duplicate
//     into the real one (lib/recordMerge.js), with an audit row per merge.
//   * HR — an advance for a pump gang as a whole. Raised, approved and paid
//     like a salary advance; the payment goes into the gang's contractor
//     ledger as an on-account payment, so the month's bill (GST / TDS on the
//     full amount) is unchanged and the advance comes off what is still due.
import { ROUND230_MERGE_SQL } from "./recordMerge.js";
import { ROUND232_SQL as BANK_GST_SQL, headGstCaseSql } from "./bankBook.js";

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

// Round 232 — repair: a customer / project that a merge kept, left switched
// off although the record merged into it was active (v10.62–10.63). Only the
// merges that ran under those versions; once.
export async function migrateRound232(pool, log) {
  // Bank lines: GST inside a payment. Lines already given a cost head take
  // the head's usual rate, once; they can be changed line by line.
  await pool.query(BANK_GST_SQL);
  const { rows: g } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r232_bank_gst'`);
  if (!g.length) {
    const r = await pool.query(`UPDATE cost_bank_lines SET gst_pct = ${headGstCaseSql()} WHERE treatment = 'cost' AND gst_pct IS NULL`);
    await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r232_bank_gst') ON CONFLICT DO NOTHING`);
    log?.push?.(`Round 232: ${r.rowCount} bank cost line(s) given their head's GST rate.`);
  }
  const { rows } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r232_merge_reactivate'`);
  if (rows.length) return;
  const c = await pool.query(
    `UPDATE customers t SET is_active = true
      WHERE COALESCE(t.is_active, true) = false AND t.merged_into_id IS NULL
        AND EXISTS (SELECT 1 FROM record_merges m JOIN customers f ON f.id = m.from_id
                     WHERE m.kind = 'customer' AND m.to_id = t.id AND f.merged_into_id = t.id)`);
  const s = await pool.query(
    `UPDATE sites t SET is_active = true
      WHERE COALESCE(t.is_active, true) = false AND t.merged_into_id IS NULL
        AND EXISTS (SELECT 1 FROM record_merges m JOIN sites f ON f.id = m.from_id
                     WHERE m.kind = 'site' AND m.to_id = t.id AND f.merged_into_id = t.id)`);
  await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r232_merge_reactivate') ON CONFLICT DO NOTHING`);
  log?.push?.(`Round 232: ${c.rowCount} merged customer(s) and ${s.rowCount} project(s) switched back on.`);
}

export async function migrateRound230(pool, log) {
  await pool.query(ROUND230_SQL);
  log?.push?.("Round 230: customer / project merge, pump gang advances.");
}
