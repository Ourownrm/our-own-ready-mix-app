// Round 259 (v10.91) — owner, 2 Nov 2026: "modify quotations logic for admin
// to add mix design without revising the quote."
//
// The Administrator can put a mix design on an approved / sent / accepted
// quotation without a revision, because the rate does not change:
//   * a grade line with no mix design gets the chosen one;
//   * a grade line that already has one gets another mix of the same grade at
//     the SAME quoted rate, as an extra line marked "added after approval".
// Added lines stay off the printed quotation (the customer's copy is the one
// that was sent); they print once the quotation is next revised.
// On an accepted quotation the site's price list follows at once.
import { query } from "../db.js";

export const ROUND259_SQL = `
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS added_after_approval BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS base_line_id INTEGER;
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS mix_added_by INTEGER REFERENCES users(id);
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS mix_added_at TIMESTAMPTZ;
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS mix_added_note VARCHAR(300);
`;

let ready = null;
export function ensureRound259() {
  if (!ready) ready = query(ROUND259_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound259(pool, log) {
  await pool.query(ROUND259_SQL);
  log?.push?.("Round 259: Administrator can add a mix design to an approved / accepted quotation without a revision.");
}
