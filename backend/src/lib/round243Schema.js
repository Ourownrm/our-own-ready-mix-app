// Round 243 (v10.75) — owner, 26 Oct 2026: "petrol is normally an outside
// fill". A fuel request now says which fuel: diesel (the default, everything
// before) or petrol. Petrol is filled at outside stations only — it never
// comes out of the plant diesel tank — and is kept out of the diesel
// analysis (tank, km per litre, fuel per m³), but counted in the fuel cost.
import { query } from "../db.js";

export const ROUND243_SQL = `
ALTER TABLE supply_requests ADD COLUMN IF NOT EXISTS fuel_kind VARCHAR(10) NOT NULL DEFAULT 'diesel';
ALTER TABLE supply_requests DROP CONSTRAINT IF EXISTS supply_requests_fuel_kind_check;
ALTER TABLE supply_requests ADD CONSTRAINT supply_requests_fuel_kind_check CHECK (fuel_kind IN ('diesel','petrol'));

-- Round 243 — a PM schedule on a vehicle / machine can be given to one person
-- (driver, plant operator, loader operator …) by the Manager or Plant In
-- Charge. It shows in that person's login; they confirm done or not done.
CREATE TABLE IF NOT EXISTS mnt_pm_assignees (
  schedule_id  INTEGER NOT NULL REFERENCES mnt_pm_schedules(id) ON DELETE CASCADE,
  asset_id     INTEGER NOT NULL REFERENCES mnt_assets(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  set_by       INTEGER REFERENCES users(id),
  set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, asset_id)
);
CREATE TABLE IF NOT EXISTS mnt_pm_confirmations (
  id           SERIAL PRIMARY KEY,
  schedule_id  INTEGER NOT NULL REFERENCES mnt_pm_schedules(id) ON DELETE CASCADE,
  asset_id     INTEGER NOT NULL REFERENCES mnt_assets(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  done         BOOLEAN NOT NULL,
  km           NUMERIC(12,1),
  hours        NUMERIC(10,1),
  note         VARCHAR(400),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mnt_pm_conf ON mnt_pm_confirmations (schedule_id, asset_id, at DESC);
`;
let ready = null;
export function ensureRound243() {
  if (!ready) ready = query(ROUND243_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound243(pool, log) {
  await pool.query(ROUND243_SQL);
  log?.push?.("Round 243: fuel requests carry diesel / petrol (petrol = outside fill); PM schedules can be assigned to a person who confirms done / not done.");
}
