// Round 251 (v10.83) — owner, 30 Oct 2026: a B2C invoice (customer without a
// GSTIN) can be printed in the Tally format ("Sales_B2C_195_26-27.pdf"), with
// the Tally invoice number and the Tally boxes the app does not hold typed in
// at print time. Kept on the invoice so a reprint shows the same, and so a
// number used twice can be flagged.
export const ROUND251_SQL = `
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tally_invoice_no VARCHAR(40);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tally_details JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tally_printed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tally_printed_by INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS ix_invoices_tally_no ON invoices (lower(tally_invoice_no)) WHERE tally_invoice_no IS NOT NULL;
`;

let ready = null;
export function ensureRound251(q) {
  if (!ready) ready = q(ROUND251_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound251(pool, log) {
  await pool.query(ROUND251_SQL);
  log?.push?.("Round 251: Tally-format print for B2C invoices (Tally number and details on the invoice).");
}
