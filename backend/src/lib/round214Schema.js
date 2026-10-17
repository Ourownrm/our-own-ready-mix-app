// Round 214 — silo FIFO made complete (see lib/siloFifo.js).
//  * plant_fifo_settings: the date FIFO's opening layers sit at (1 Oct 2026,
//    owner, 16 Oct 2026 — the month the fly-ash brands went wrong).
//  * plant_silo_fills.is_opening: an opening layer (book stock at the start).
//  * plant_consumption_transfers.fifo_slot: an automatic split of a batch
//    that drew from two loads (rebuilt on every re-run; created_by is empty).
//  * plant_silo_overdraws: draws past a silo's recorded loads.
//  * plant_silo_contents: what is left in each refillable silo, per material.
import { fifoResolveSlot, seedOpeningLayers } from "./siloFifo.js";

export const ROUND214_SQL = `
CREATE TABLE IF NOT EXISTS plant_fifo_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  start_date  DATE NOT NULL,
  seeded_at   TIMESTAMPTZ,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO plant_fifo_settings (id, start_date) VALUES (1, '2026-10-01') ON CONFLICT (id) DO NOTHING;
ALTER TABLE plant_silo_fills ADD COLUMN IF NOT EXISTS is_opening BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE plant_consumption_transfers ADD COLUMN IF NOT EXISTS fifo_slot VARCHAR(20);
ALTER TABLE plant_consumption_transfers ALTER COLUMN created_by DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plant_consumption_transfers_fifo ON plant_consumption_transfers(fifo_slot) WHERE fifo_slot IS NOT NULL;
CREATE TABLE IF NOT EXISTS plant_silo_overdraws (
  id          SERIAL PRIMARY KEY,
  slot        VARCHAR(20) NOT NULL,
  on_date     DATE NOT NULL,
  material_id INTEGER REFERENCES rm_materials(id),
  kind        VARCHAR(14) NOT NULL CHECK (kind IN ('next_load','no_later_load')),
  qty_kg      NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plant_silo_overdraws_slot ON plant_silo_overdraws(slot, on_date);
-- What FIFO says is left in each refillable silo, per material (rebuilt on every re-run).
CREATE TABLE IF NOT EXISTS plant_silo_contents (
  slot        VARCHAR(20) NOT NULL,
  material_id INTEGER NOT NULL REFERENCES rm_materials(id),
  qty_kg      NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (slot, material_id)
);
`;

export async function migrateRound214(pool, log) {
  await pool.query(ROUND214_SQL);
  // Once: lay each refillable silo's opening stock at the start date, then
  // re-run FIFO over every refillable silo.
  const { rows: done } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r214_fifo_opening'`);
  let note = "";
  if (!done.length) {
    // Re-run first so consumption before the start is settled (book stock at
    // the start depends on it), lay the openings, then re-run from the start.
    const { rows: refill } = await pool.query(`SELECT slot FROM plant_silo_aliases WHERE is_refillable`);
    for (const r of refill) await fifoResolveSlot(r.slot);
    const seeded = await seedOpeningLayers(null);
    let changed = 0;
    for (const r of refill) changed += await fifoResolveSlot(r.slot);
    await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r214_fifo_opening') ON CONFLICT DO NOTHING`);
    note = `; opening layers from book stock at ${seeded.start}: ${seeded.placed.map((p) => `${p.name} ${Math.round(p.kg)} kg in ${p.slot}`).join(", ") || "none"}; ${changed} batch row(s) re-charged first-in-first-out — check them on Plant Production → Silos`;
  }
  log.push(`Schema migration applied (Round 214 — silo FIFO: opening layers, draws past recorded loads, batches split between loads${note}).`);
}
