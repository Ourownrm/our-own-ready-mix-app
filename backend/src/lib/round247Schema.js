// Round 247 (v10.79) — Partners after the owner's sheet is in (28 Oct 2026:
// "'checked against your sheet' should disappear when [I] confirm the upload
// is correct … option to import my investment and loan sheet also to be
// removed, and further entries will be done in app only").
//   cost_partner_settings.sheet_closed_at / _by — set when the owner confirms
//   the imported sheet: the comparison and the sheet import go away; every
//   entry after that is typed in the app.
export const ROUND247_SQL = `
ALTER TABLE cost_partner_settings ADD COLUMN IF NOT EXISTS sheet_closed_at TIMESTAMPTZ;
ALTER TABLE cost_partner_settings ADD COLUMN IF NOT EXISTS sheet_closed_by INTEGER;
`;
export async function migrateRound247(pool, log) {
  await pool.query(ROUND247_SQL);
  log?.push?.("Round 247: partners — confirm the imported sheet and close the sheet import.");
}
