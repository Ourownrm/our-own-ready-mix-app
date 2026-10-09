// Round 200 — a receipt prepared WITHOUT a weighbridge ticket needs an
// Administrator's approval before it counts. Until then it is like a receipt
// waiting for a Manager (Round 158): saved, visible, flagged, but not stock and
// not a supplier bill. Linking a ticket to it later clears the need. A
// material that never crosses the weighbridge (an admixture drum, say) can be
// marked exempt on the material master.
//
// wb_approval: not_needed (has a ticket, exempt, or older than this round)
//              pending    (no ticket — waiting for Admin)
//              approved   (Admin accepted it without a ticket)
//              rejected   (Admin refused it — never counts; fix or delete it)
export const RECEIPT_WB_SQL = `
ALTER TABLE rm_materials ADD COLUMN IF NOT EXISTS wb_exempt BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS wb_approval VARCHAR(12) NOT NULL DEFAULT 'not_needed';
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS wb_reason TEXT;
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS wb_decided_by INTEGER REFERENCES users(id);
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS wb_decided_at TIMESTAMPTZ;
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS wb_note TEXT;
ALTER TABLE rm_receipts DROP CONSTRAINT IF EXISTS rm_receipts_wb_approval_check;
ALTER TABLE rm_receipts ADD CONSTRAINT rm_receipts_wb_approval_check CHECK (wb_approval IN ('not_needed','pending','approved','rejected'));
CREATE INDEX IF NOT EXISTS rm_receipts_wb_pending ON rm_receipts (wb_approval) WHERE wb_approval = 'pending';
-- Every stock, rate and ledger read goes through this view, so excluding the
-- unapproved ones here is what keeps them out of everything at once.
CREATE OR REPLACE VIEW rm_receipts_effective AS
  SELECT * FROM rm_receipts WHERE confirmation_status <> 'pending' AND wb_approval NOT IN ('pending','rejected');   -- receipts-raw: this IS the view's definition
`;

export async function migrateReceiptApproval(pool, log) {
  await pool.query(RECEIPT_WB_SQL);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM rm_receipts WHERE wb_approval = 'pending'`); // receipts-raw: counting the ones waiting
  log.push(`Schema migration applied (Round 200 — receipts without a weighbridge ticket need Admin approval). ${rows[0].n} waiting.`);
}
