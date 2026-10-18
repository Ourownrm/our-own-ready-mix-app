// Round 215c — vehicle MODELS, and each vehicle as its own asset.
//
// The owner, 18 Oct 2026: the ten machines given for the schedule research
// are the TYPES of vehicle and equipment the plant runs, not the fleet —
// "Tata Signa" is three transit mixers, "Prima" two, and so on. So:
//
//   * mnt_models — one row per make / model (Tata Signa 2825.K, Tata Prima
//     2830.K, Ashok Leyland CE2820 …). The PM schedules are planned against
//     the MODEL (mnt_pm_schedule_models).
//   * mnt_assets — one row per actual vehicle or machine, identified by its
//     asset number and / or registration number, belonging to a model. It
//     gets every schedule of its model; when each was last done, what is due
//     and its job cards stay per vehicle (mnt_pm_schedule_assets is now only
//     the per-vehicle "last done" record).
//   * Store spares can also be "used for" a model (all Signas) besides one or
//     more vehicles, a machine type, or general (mnt_store_item_models).
//
// Migration (once, mark r215c_models): the ten seeded rows of Round 215 become
// the ten models with their schedules. A seeded row already in use — linked to
// a truck / pump / equipment record (Round 215 linked the single pump, loader
// and batching plant itself) or with readings, job cards or costs on it — stays
// as that model's first vehicle; the rest are removed, since they were never
// real vehicles. Spares "used for" a removed row move to its model.
export const ROUND215C_SQL = `
CREATE TABLE IF NOT EXISTS mnt_models (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(150) NOT NULL,
  asset_group  VARCHAR(40) NOT NULL DEFAULT 'Other',
  detail       TEXT,
  seed_key     VARCHAR(40) UNIQUE,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_models_name ON mnt_models (lower(name)) WHERE is_active;

ALTER TABLE mnt_assets ADD COLUMN IF NOT EXISTS model_id INTEGER REFERENCES mnt_models(id);
ALTER TABLE mnt_assets ADD COLUMN IF NOT EXISTS asset_no VARCHAR(30);
ALTER TABLE mnt_assets ADD COLUMN IF NOT EXISTS reg_no VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_assets_asset_no ON mnt_assets (lower(asset_no)) WHERE asset_no IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_assets_reg_no ON mnt_assets (lower(reg_no)) WHERE reg_no IS NOT NULL AND is_active;
CREATE INDEX IF NOT EXISTS idx_mnt_assets_model ON mnt_assets (model_id);

CREATE TABLE IF NOT EXISTS mnt_pm_schedule_models (
  schedule_id  INTEGER NOT NULL REFERENCES mnt_pm_schedules(id) ON DELETE CASCADE,
  model_id     INTEGER NOT NULL REFERENCES mnt_models(id),
  PRIMARY KEY (schedule_id, model_id)
);

CREATE TABLE IF NOT EXISTS mnt_store_item_models (
  item_id   INTEGER NOT NULL REFERENCES mnt_store_items(id) ON DELETE CASCADE,
  model_id  INTEGER NOT NULL REFERENCES mnt_models(id),
  PRIMARY KEY (item_id, model_id)
);
ALTER TABLE mnt_store_items DROP CONSTRAINT IF EXISTS mnt_store_items_used_for_type_check;
ALTER TABLE mnt_store_items ADD CONSTRAINT mnt_store_items_used_for_type_check
  CHECK (used_for_type IN ('asset','model','group','general'));
`;

/** "TM-03 · KL60F2213 — Tata Signa 2825.K" — what every screen shows. */
export function composeAssetName(assetNo, regNo, modelName, fallback = "") {
  const id = [assetNo, regNo].map((x) => (x ? String(x).trim() : "")).filter(Boolean).join(" · ");
  if (id && modelName) return `${id} — ${modelName}`;
  return id || modelName || fallback;
}

/** Re-derive the display name, type and make/model of vehicles from their model. */
export async function refreshAssetNames(q, { modelId = null, assetId = null } = {}) {
  const { rows } = await q(
    `SELECT a.id, a.asset_no, a.reg_no, a.name, m.name AS model_name, m.asset_group
       FROM mnt_assets a JOIN mnt_models m ON m.id = a.model_id
      WHERE ($1::int IS NULL OR a.model_id = $1) AND ($2::int IS NULL OR a.id = $2)`, [modelId, assetId]);
  for (const a of rows) {
    await q(`UPDATE mnt_assets SET name = $1, asset_group = $2, make_model = $3 WHERE id = $4`,
      [composeAssetName(a.asset_no, a.reg_no, a.model_name, a.name).slice(0, 150), a.asset_group, a.model_name, a.id]);
  }
}

export async function migrateRound215c(pool, log) {
  await pool.query(ROUND215C_SQL);
  const { rows: done } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r215c_models'`);
  if (done.length) { log.push("Schema migration applied (Round 215c — vehicle models)."); return; }

  const c = await pool.connect();
  let models = 0, kept = 0, removed = 0;
  try {
    await c.query("BEGIN");
    const { rows: seeded } = await c.query(
      `SELECT a.*, t.truck_number, p.pump_code, e.name AS equipment_name
         FROM mnt_assets a LEFT JOIN trucks t ON t.id = a.truck_id LEFT JOIN pumps p ON p.id = a.pump_id
         LEFT JOIN equipment e ON e.id = a.equipment_id
        WHERE a.seed_key IS NOT NULL ORDER BY a.id`);
    for (const a of seeded) {
      const modelName = (a.make_model || a.name.split("—").pop()).trim();
      const m = await c.query(
        `INSERT INTO mnt_models (name, asset_group, detail, seed_key) VALUES ($1,$2,$3,$4)
         ON CONFLICT (seed_key) DO UPDATE SET seed_key = EXCLUDED.seed_key RETURNING id`,
        [modelName, a.asset_group, a.detail, a.seed_key]);
      const modelId = m.rows[0].id;
      models += 1;
      await c.query(
        `INSERT INTO mnt_pm_schedule_models (schedule_id, model_id)
         SELECT schedule_id, $1 FROM mnt_pm_schedule_assets WHERE asset_id = $2 ON CONFLICT DO NOTHING`, [modelId, a.id]);
      // Spares meant for this row are meant for its model.
      await c.query(
        `INSERT INTO mnt_store_item_models (item_id, model_id)
         SELECT item_id, $1 FROM mnt_store_item_assets WHERE asset_id = $2 ON CONFLICT DO NOTHING`, [modelId, a.id]);

      const { rows: used } = await c.query(
        `SELECT (EXISTS (SELECT 1 FROM mnt_meter_readings WHERE asset_id = $1)
              OR EXISTS (SELECT 1 FROM mnt_job_cards WHERE asset_id = $1)
              OR EXISTS (SELECT 1 FROM mnt_pm_inspections WHERE asset_id = $1)
              OR EXISTS (SELECT 1 FROM mnt_outside_repairs WHERE asset_id = $1)
              OR EXISTS (SELECT 1 FROM mnt_store_txns WHERE asset_id = $1)
              OR EXISTS (SELECT 1 FROM mnt_card_charges WHERE asset_id = $1)) AS used`, [a.id]);
      const linked = a.truck_id || a.pump_id || a.equipment_id;
      if (linked || used[0].used) {
        const reg = a.truck_number || a.pump_code || null;
        await c.query(`UPDATE mnt_assets SET model_id = $1, seed_key = NULL, reg_no = COALESCE(reg_no, $2) WHERE id = $3`, [modelId, reg, a.id]);
        await refreshAssetNames((t, p) => c.query(t, p), { assetId: a.id });
        kept += 1;
      } else {
        await c.query(`DELETE FROM mnt_pm_schedule_assets WHERE asset_id = $1`, [a.id]);
        await c.query(`DELETE FROM mnt_store_item_assets WHERE asset_id = $1`, [a.id]);
        await c.query(`DELETE FROM mnt_assets WHERE id = $1`, [a.id]);
        removed += 1;
      }
    }
    // Spares left with no vehicle, but now carrying a model, are "for that model".
    await c.query(
      `UPDATE mnt_store_items i SET used_for_type = 'model'
        WHERE i.used_for_type = 'asset'
          AND NOT EXISTS (SELECT 1 FROM mnt_store_item_assets x WHERE x.item_id = i.id)
          AND EXISTS (SELECT 1 FROM mnt_store_item_models x WHERE x.item_id = i.id)`);
    await c.query(`DELETE FROM mnt_store_item_models x USING mnt_store_items i WHERE i.id = x.item_id AND i.used_for_type <> 'model'`);
    await c.query(`INSERT INTO app_migration_marks (mark) VALUES ('r215c_models') ON CONFLICT DO NOTHING`);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  log.push(`Schema migration applied (Round 215c — vehicle models: ${models} model(s) with their PM schedules; ${kept} existing machine(s) kept as vehicles, ${removed} placeholder row(s) removed — add each vehicle on Maintenance → Equipment → "Add vehicles from the fleet").`);
}
