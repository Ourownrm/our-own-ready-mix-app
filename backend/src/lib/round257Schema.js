// Round 257 (v10.89) — owner, 31 Oct 2026: "Request fuel (petrol) option
// required to enable for individual users who has company allocated vehicle".
//   * A company vehicle (car / two-wheeler, or a pickup) is an equipment row;
//     the new equipment type 'company_vehicle' is for the cars and bikes.
//   * The Administrator allocates the vehicle to one user (vehicle_allocations;
//     one person per vehicle at a time, a person may have more than one).
//   * That user — whatever their role — can then request fuel for that vehicle
//     (petrol by default) from "My vehicle fuel", and confirm the outside fill,
//     through the same request → approval → fill flow as the drivers.
import { query } from "../db.js";

export const ROUND257_SQL = `
ALTER TYPE fuel_equipment_type ADD VALUE IF NOT EXISTS 'company_vehicle';

CREATE TABLE IF NOT EXISTS vehicle_allocations (
  id            SERIAL PRIMARY KEY,
  equipment_id  INTEGER NOT NULL REFERENCES equipment(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  allocated_by  INTEGER REFERENCES users(id),
  allocated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  ended_by      INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_alloc_active ON vehicle_allocations(equipment_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_vehicle_alloc_user ON vehicle_allocations(user_id) WHERE ended_at IS NULL;
`;

let ready = null;
export function ensureRound257() {
  if (!ready) ready = query(ROUND257_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound257(pool, log) {
  await pool.query(ROUND257_SQL);
  log?.push?.("Round 257: company vehicles allocated to a user — that user can request fuel (petrol) for it.");
}

// The vehicles allocated to this user now.
export async function myVehicles(userId) {
  await ensureRound257();
  const { rows } = await query(
    `SELECT e.id, e.name, e.equipment_type FROM vehicle_allocations a JOIN equipment e ON e.id = a.equipment_id
      WHERE a.user_id = $1 AND a.ended_at IS NULL AND COALESCE(e.is_active, true) ORDER BY e.name`, [userId]);
  return rows;
}
export async function isAllocatedTo(userId, equipmentId) {
  if (!equipmentId) return false;
  await ensureRound257();
  const { rows } = await query(
    `SELECT 1 FROM vehicle_allocations WHERE user_id = $1 AND equipment_id = $2 AND ended_at IS NULL`, [userId, Number(equipmentId)]);
  return rows.length > 0;
}
