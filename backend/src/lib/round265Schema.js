// Round 265 (v10.97) — owner, 4 Nov 2026: the transit-mixer mileage used for a
// quotation's site-specific fuel is a fixed figure the Administrator sets in
// Fuel → Settings (default 2.5 km/L), not the fleet average from fills
// (which mixed in other vehicles and came out at 52 km/L).
import { query } from "../db.js";

export const ROUND265_SQL = `
ALTER TABLE fuel_settings ADD COLUMN IF NOT EXISTS tm_kmpl NUMERIC(6,2) NOT NULL DEFAULT 2.5;
`;

let ready = null;
export function ensureRound265() {
  if (!ready) ready = query(ROUND265_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound265(pool, log) {
  await pool.query(ROUND265_SQL);
  log?.push?.("Round 265: transit-mixer mileage for quotation fuel is set in Fuel → Settings (default 2.5 km/L).");
}

// The mileage the quotation fuel uses.
export async function mixerKmpl() {
  await ensureRound265().catch(() => {});
  const { rows } = await query(`SELECT tm_kmpl FROM fuel_settings WHERE id = 1`).catch(() => ({ rows: [] }));
  const v = Number(rows[0]?.tm_kmpl);
  return v > 0 ? v : 2.5;
}
