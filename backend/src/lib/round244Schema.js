// Round 244 (v10.76) — partners' loans to match the owner's own sheet
// ("Investment & Loan", 27 Oct 2026):
//   * a loan entry may carry its own "interest from" date (loans given before
//     November 2023 earn interest only from 1 Nov 2023);
//   * interest paid may be negative — a reversal of interest paid too early
//     (the sheet's October 2024 corrections);
//   * the sheet itself can be imported; the import keeps the sheet's own
//     totals so the page can show the app against the sheet.
export const ROUND244_SQL = `
ALTER TABLE cost_partner_txns ADD COLUMN IF NOT EXISTS interest_from DATE;
ALTER TABLE cost_partner_txns DROP CONSTRAINT IF EXISTS cost_partner_txns_amount_check;
ALTER TABLE cost_partner_txns ADD CONSTRAINT cost_partner_txns_amount_check CHECK (amount >= 0 OR kind = 'interest_paid');
ALTER TABLE cost_partner_uploads DROP CONSTRAINT IF EXISTS cost_partner_uploads_book_check;
ALTER TABLE cost_partner_uploads ADD CONSTRAINT cost_partner_uploads_book_check CHECK (book IN ('capital','loan','sheet'));
ALTER TABLE cost_partner_uploads ADD COLUMN IF NOT EXISTS sheet_check JSONB;
`;
export async function migrateRound244(pool, log) {
  await pool.query(ROUND244_SQL);
  log?.push?.("Round 244: partners' loans — interest-from date per entry, interest reversals, import of the Investment & Loan sheet.");
}
