// Round 270 (v11.02) — owner, 7 Nov 2026: "in vehicle certificate, together
// with road tax, we need to pay a Kerala Motor Transport Workers Welfare Fund
// Board contribution, I need an option for it."
//
// The contribution is recorded on the road-tax certificate it is paid with:
// its own amount and receipt number. The fee bill in Payments (and a bank
// payment posted to the certificate) is for road tax + contribution together,
// and the Cost Dashboard spreads both over the quarter, under Road tax.
import { query } from "../db.js";

export const ROUND270_SQL = `
ALTER TABLE mnt_certificates ADD COLUMN IF NOT EXISTS welfare_fund NUMERIC(12,2);
ALTER TABLE mnt_certificates ADD COLUMN IF NOT EXISTS welfare_receipt VARCHAR(100);
`;

export async function migrateRound270(pool, log) {
  await pool.query(ROUND270_SQL);
  log?.push?.("Round 270: road tax certificates carry the Motor Transport Workers Welfare Fund contribution.");
}

let ready = null;
export function ensureRound270() {
  if (!ready) ready = query(ROUND270_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
