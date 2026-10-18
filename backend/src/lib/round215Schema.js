// Round 215 — the Maintenance module (built to the owner's mockup, v5, 18 Oct
// 2026; decisions in claude/maintenance-module-mockup-v1.md).
//
//   mnt_assets                 the equipment register — one row per vehicle /
//                              plant item, optionally linked to the existing
//                              trucks / pumps / equipment master row so its
//                              km, hours and m³ come from the data already kept
//   mnt_meter_readings         km / hour-meter readings typed in (manual or at
//                              a PM inspection)
//   mnt_pm_schedules           preventive schedules: trigger, checklist, tasks
//   mnt_pm_schedule_assets     which assets a schedule applies to, with that
//                              asset's last-done baseline
//   mnt_pm_inspections         a filled checklist; Not OK items and "other jobs"
//                              go onto ONE job card automatically
//   mnt_job_cards / mnt_jobs   job cards; each job is Inside or Outside
//   mnt_outside_repairs        estimate -> Administrator approval -> sent out ->
//                              returned + bill (a bill above the approved
//                              amount goes back to the Administrator)
//   mnt_store_items (+ _assets, _txns)   maintenance spares with "used for"
//                              and last purchase price, append-only ledger
//   mnt_part_requests          a part asked for on a job card
//   mnt_purchase_orders / mnt_po_lines / mnt_grvs / mnt_grv_lines
//   mnt_bills / mnt_payments   what is owed and what was paid
//
// Additive only. The seed (10 assets + 40 schedules) and the permission
// grants for roles that already exist run ONCE each (app_migration_marks).
import { SEED_ASSETS, SEED_SCHEDULES } from "./maintenanceSeed.js";
import { CATALOGUE } from "./permissionCatalogue.js";

export const ROUND215_SQL = `
CREATE TABLE IF NOT EXISTS mnt_assets (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  asset_group   VARCHAR(40) NOT NULL DEFAULT 'Other',
  make_model    VARCHAR(200),
  year          INTEGER,
  detail        TEXT,
  truck_id      INTEGER REFERENCES trucks(id),
  pump_id       INTEGER REFERENCES pumps(id),
  equipment_id  INTEGER REFERENCES equipment(id),
  seed_key      VARCHAR(40) UNIQUE,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_assets_truck ON mnt_assets(truck_id) WHERE truck_id IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_assets_pump ON mnt_assets(pump_id) WHERE pump_id IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_assets_equipment ON mnt_assets(equipment_id) WHERE equipment_id IS NOT NULL AND is_active;

CREATE TABLE IF NOT EXISTS mnt_meter_readings (
  id          SERIAL PRIMARY KEY,
  asset_id    INTEGER NOT NULL REFERENCES mnt_assets(id),
  read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  km          NUMERIC(12,1),
  hours       NUMERIC(10,1),
  source      VARCHAR(20) NOT NULL DEFAULT 'manual',
  note        TEXT,
  entered_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_mnt_meter_readings_asset ON mnt_meter_readings(asset_id, read_at DESC);

CREATE TABLE IF NOT EXISTS mnt_pm_schedules (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  trigger_type  VARCHAR(10) NOT NULL CHECK (trigger_type IN ('day','week','month','km','hours','m3','once_km')),
  every         NUMERIC(12,2) NOT NULL CHECK (every > 0),
  or_months     INTEGER,
  or_days       INTEGER,
  or_hours      INTEGER,
  basis         VARCHAR(10) NOT NULL DEFAULT 'PRACTICE' CHECK (basis IN ('OEM','ENGINE','PRACTICE')),
  note          TEXT,
  sources       JSONB NOT NULL DEFAULT '[]',
  checklist     JSONB NOT NULL DEFAULT '[]',
  tasks         JSONB NOT NULL DEFAULT '[]',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  seed_key      VARCHAR(120) UNIQUE,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mnt_pm_schedule_assets (
  schedule_id     INTEGER NOT NULL REFERENCES mnt_pm_schedules(id) ON DELETE CASCADE,
  asset_id        INTEGER NOT NULL REFERENCES mnt_assets(id),
  last_done_date  DATE,
  last_done_km    NUMERIC(12,1),
  last_done_hours NUMERIC(10,1),
  PRIMARY KEY (schedule_id, asset_id)
);

CREATE TABLE IF NOT EXISTS mnt_job_cards (
  id              SERIAL PRIMARY KEY,
  asset_id        INTEGER NOT NULL REFERENCES mnt_assets(id),
  source          VARCHAR(20) NOT NULL DEFAULT 'manual',
  source_id       INTEGER,
  status          VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','work_done','closed','cancelled')),
  km              NUMERIC(12,1),
  notes           TEXT,
  opened_by       INTEGER REFERENCES users(id),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  work_done_by    INTEGER REFERENCES users(id),
  work_done_at    TIMESTAMPTZ,
  verified_by     INTEGER REFERENCES users(id),
  verified_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mnt_job_cards_asset ON mnt_job_cards(asset_id, status);

CREATE TABLE IF NOT EXISTS mnt_pm_inspections (
  id            SERIAL PRIMARY KEY,
  schedule_id   INTEGER NOT NULL REFERENCES mnt_pm_schedules(id),
  asset_id      INTEGER NOT NULL REFERENCES mnt_assets(id),
  km            NUMERIC(12,1),
  hours         NUMERIC(10,1),
  answers       JSONB NOT NULL DEFAULT '[]',
  other_jobs    JSONB NOT NULL DEFAULT '[]',
  tasks_done    JSONB NOT NULL DEFAULT '[]',
  remarks       TEXT,
  job_card_id   INTEGER REFERENCES mnt_job_cards(id),
  done_by       INTEGER REFERENCES users(id),
  done_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mnt_pm_inspections_asset ON mnt_pm_inspections(asset_id, done_at DESC);

CREATE TABLE IF NOT EXISTS mnt_outside_repairs (
  id                SERIAL PRIMARY KEY,
  job_card_id       INTEGER NOT NULL REFERENCES mnt_job_cards(id),
  asset_id          INTEGER NOT NULL REFERENCES mnt_assets(id),
  workshop          VARCHAR(150),
  estimate_amount   NUMERIC(12,2) NOT NULL,
  expected_days     INTEGER,
  advance_amount    NUMERIC(12,2),
  notes             TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'awaiting_approval'
                    CHECK (status IN ('awaiting_approval','approved','rejected','sent_out','bill_hold','billed','cancelled')),
  approved_amount   NUMERIC(12,2),
  admin_note        TEXT,
  approved_by       INTEGER REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  reject_reason     TEXT,
  sent_out_at       TIMESTAMPTZ,
  returned_at       TIMESTAMPTZ,
  bill_no           VARCHAR(60),
  bill_date         DATE,
  bill_amount       NUMERIC(12,2),
  final_amount      NUMERIC(12,2),
  bill_approved_by  INTEGER REFERENCES users(id),
  bill_approved_at  TIMESTAMPTZ,
  requested_by      INTEGER REFERENCES users(id),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mnt_outside_repairs_status ON mnt_outside_repairs(status);

CREATE TABLE IF NOT EXISTS mnt_jobs (
  id                 SERIAL PRIMARY KEY,
  job_card_id        INTEGER NOT NULL REFERENCES mnt_job_cards(id),
  description        TEXT NOT NULL,
  origin             VARCHAR(12) NOT NULL DEFAULT 'manual' CHECK (origin IN ('not_ok','other','complaint','manual')),
  kind               VARCHAR(8) NOT NULL DEFAULT 'inside' CHECK (kind IN ('inside','outside')),
  status             VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  outside_repair_id  INTEGER REFERENCES mnt_outside_repairs(id),
  urgency            VARCHAR(12),
  machine_stopped    BOOLEAN NOT NULL DEFAULT false,
  raised_by          INTEGER REFERENCES users(id),
  raised_role        VARCHAR(30),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_by            INTEGER REFERENCES users(id),
  done_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mnt_jobs_card ON mnt_jobs(job_card_id);
CREATE INDEX IF NOT EXISTS idx_mnt_jobs_raised_by ON mnt_jobs(raised_by, created_at DESC);

CREATE TABLE IF NOT EXISTS mnt_store_items (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(150) NOT NULL,
  part_no             VARCHAR(80),
  category            VARCHAR(40) NOT NULL DEFAULT 'Vehicle spares',
  unit                VARCHAR(20) NOT NULL DEFAULT 'Nos',
  used_for_type       VARCHAR(8) NOT NULL DEFAULT 'general' CHECK (used_for_type IN ('asset','group','general')),
  used_for_group      VARCHAR(40),
  reorder_level       NUMERIC(12,2),
  current_qty         NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_rate            NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_price          NUMERIC(12,2),
  prev_price          NUMERIC(12,2),
  last_supplier       VARCHAR(150),
  last_purchase_date  DATE,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mnt_store_item_assets (
  item_id   INTEGER NOT NULL REFERENCES mnt_store_items(id) ON DELETE CASCADE,
  asset_id  INTEGER NOT NULL REFERENCES mnt_assets(id),
  PRIMARY KEY (item_id, asset_id)
);
-- Append-only: every change to a spare's balance, whatever caused it.
CREATE TABLE IF NOT EXISTS mnt_store_txns (
  id             SERIAL PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES mnt_store_items(id),
  txn_type       VARCHAR(8) NOT NULL CHECK (txn_type IN ('receive','issue','adjust')),
  qty_change     NUMERIC(12,2) NOT NULL,
  balance_after  NUMERIC(12,2) NOT NULL,
  rate           NUMERIC(12,2),
  value          NUMERIC(14,2),
  job_card_id    INTEGER REFERENCES mnt_job_cards(id),
  asset_id       INTEGER REFERENCES mnt_assets(id),
  ref_type       VARCHAR(20),
  ref_id         INTEGER,
  note           TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mnt_store_txns_item ON mnt_store_txns(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mnt_store_txns_card ON mnt_store_txns(job_card_id) WHERE job_card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mnt_purchase_orders (
  id             SERIAL PRIMARY KEY,
  supplier_name  VARCHAR(150) NOT NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','received','cancelled')),
  credit_days    INTEGER NOT NULL DEFAULT 30,
  notes          TEXT,
  total          NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  reject_reason  TEXT
);

CREATE TABLE IF NOT EXISTS mnt_part_requests (
  id            SERIAL PRIMARY KEY,
  job_card_id   INTEGER NOT NULL REFERENCES mnt_job_cards(id),
  job_id        INTEGER REFERENCES mnt_jobs(id),
  item_id       INTEGER REFERENCES mnt_store_items(id),
  description   VARCHAR(200) NOT NULL,
  qty           NUMERIC(12,2) NOT NULL CHECK (qty > 0),
  status        VARCHAR(10) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','on_po','issued','cancelled')),
  po_line_id    INTEGER,
  issued_qty    NUMERIC(12,2),
  issue_value   NUMERIC(14,2),
  note          TEXT,
  requested_by  INTEGER REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by     INTEGER REFERENCES users(id),
  issued_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mnt_part_requests_status ON mnt_part_requests(status);

CREATE TABLE IF NOT EXISTS mnt_po_lines (
  id               SERIAL PRIMARY KEY,
  po_id            INTEGER NOT NULL REFERENCES mnt_purchase_orders(id) ON DELETE CASCADE,
  item_id          INTEGER NOT NULL REFERENCES mnt_store_items(id),
  qty              NUMERIC(12,2) NOT NULL CHECK (qty > 0),
  rate             NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  gst_pct          NUMERIC(5,2) NOT NULL DEFAULT 18,
  amount           NUMERIC(14,2) NOT NULL,
  job_card_id      INTEGER REFERENCES mnt_job_cards(id),
  part_request_id  INTEGER REFERENCES mnt_part_requests(id),
  received_qty     NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mnt_po_lines_po ON mnt_po_lines(po_id);

CREATE TABLE IF NOT EXISTS mnt_grvs (
  id           SERIAL PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES mnt_purchase_orders(id),
  grv_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  bill_no      VARCHAR(60),
  bill_date    DATE,
  bill_amount  NUMERIC(14,2),
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mnt_grv_lines (
  id           SERIAL PRIMARY KEY,
  grv_id       INTEGER NOT NULL REFERENCES mnt_grvs(id) ON DELETE CASCADE,
  po_line_id   INTEGER NOT NULL REFERENCES mnt_po_lines(id),
  qty          NUMERIC(12,2) NOT NULL CHECK (qty > 0),
  rate         NUMERIC(12,2) NOT NULL,
  value        NUMERIC(14,2) NOT NULL,
  job_card_id  INTEGER REFERENCES mnt_job_cards(id)
);

CREATE TABLE IF NOT EXISTS mnt_bills (
  id           SERIAL PRIMARY KEY,
  source_type  VARCHAR(16) NOT NULL CHECK (source_type IN ('grv','outside_repair')),
  source_id    INTEGER NOT NULL,
  payee        VARCHAR(150) NOT NULL,
  bill_no      VARCHAR(60),
  bill_date    DATE,
  amount       NUMERIC(14,2) NOT NULL,
  due_date     DATE,
  on_hold      BOOLEAN NOT NULL DEFAULT false,
  is_estimate  BOOLEAN NOT NULL DEFAULT false,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);
CREATE TABLE IF NOT EXISTS mnt_payments (
  id          SERIAL PRIMARY KEY,
  bill_id     INTEGER NOT NULL REFERENCES mnt_bills(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  tds         NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  mode        VARCHAR(20),
  reference   VARCHAR(100),
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mnt_payments_bill ON mnt_payments(bill_id);
`;

function trig(t) {
  if (t.type === "once_km") return { type: "once_km", every: t.at, or_days: t.or_days || null, or_months: null, or_hours: null };
  return { type: t.type, every: t.every || 1, or_months: t.or_months || null, or_days: t.or_days || null, or_hours: t.or_hours || null };
}

// One master row of a type that has exactly one active row is unambiguous —
// link it to the seeded asset. Trucks and pickups are never guessed: there
// are several, and the Administrator links them on the Equipment screen.
async function autoLink(pool) {
  const links = [];
  const one = async (sql, params) => {
    const { rows } = await pool.query(sql, params);
    return rows.length === 1 ? rows[0].id : null;
  };
  const pump = await one(`SELECT id FROM pumps WHERE is_active`);
  if (pump) {
    const r = await pool.query(`UPDATE mnt_assets SET pump_id = $1 WHERE seed_key = 'BP-2518' AND pump_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM mnt_assets WHERE pump_id = $1)`, [pump]);
    if (r.rowCount) links.push("boom placer → pump master");
  }
  for (const [type, key, label] of [["loader", "LD-3DX", "JCB 3DX → loader"], ["batching_plant", "PLANT-H1J", "batching plant → equipment"]]) {
    const id = await one(`SELECT id FROM equipment WHERE is_active AND equipment_type = $1`, [type]);
    if (!id) continue;
    const r = await pool.query(`UPDATE mnt_assets SET equipment_id = $1 WHERE seed_key = $2 AND equipment_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM mnt_assets WHERE equipment_id = $1)`, [id, key]);
    if (r.rowCount) links.push(label);
  }
  return links;
}

export async function migrateRound215(pool, log) {
  await pool.query(ROUND215_SQL);

  const notes = [];
  const { rows: seeded } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r215_mnt_seed'`);
  if (!seeded.length) {
    const ids = {};
    for (const a of SEED_ASSETS) {
      const { rows } = await pool.query(
        `INSERT INTO mnt_assets (name, asset_group, make_model, detail, seed_key)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (seed_key) DO UPDATE SET seed_key = EXCLUDED.seed_key
         RETURNING id`,
        [a.name, a.group, a.name.split("—").pop().trim(), a.detail, a.key]
      );
      ids[a.key] = rows[0].id;
      const year = /\b(19|20)\d{2}\b/.exec(a.detail || "");
      if (year) await pool.query(`UPDATE mnt_assets SET year = $1 WHERE id = $2 AND year IS NULL`, [Number(year[0]), rows[0].id]);
    }
    let n = 0;
    for (const s of SEED_SCHEDULES) {
      const t = trig(s.trigger);
      const key = `${s.asset.join("+")}|${s.name}`;
      const { rows } = await pool.query(
        `INSERT INTO mnt_pm_schedules (name, trigger_type, every, or_months, or_days, or_hours, basis, note, sources, checklist, tasks, seed_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
         ON CONFLICT (seed_key) DO NOTHING RETURNING id`,
        [s.name, t.type, t.every, t.or_months, t.or_days, t.or_hours, s.basis, s.note || null,
          JSON.stringify(s.sources || []), JSON.stringify(s.checklist || []), JSON.stringify(s.tasks || []), key]
      );
      if (!rows.length) continue;
      n += 1;
      for (const ak of s.asset) {
        if (!ids[ak]) continue;
        await pool.query(`INSERT INTO mnt_pm_schedule_assets (schedule_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [rows[0].id, ids[ak]]);
      }
    }
    const links = await autoLink(pool);
    await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r215_mnt_seed') ON CONFLICT DO NOTHING`);
    notes.push(`seeded ${Object.keys(ids).length} vehicle models and ${n} PM schedules${links.length ? `; linked ${links.join(", ")}` : ""}`);
  }

  // The new functions' defaults for roles that already had rows. The seeding
  // loop in setup.js only fills a role with NO rows (plant_in_charge, the
  // first time), so without this every existing role would start with the
  // module switched off. Once only, so a Super Admin's later "off" sticks.
  const { rows: granted } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r215_mnt_grants'`);
  if (!granted.length) {
    const rows = [];
    for (const c of CATALOGUE) {
      if (c.locked) continue;
      const isNew = c.key === "module.maintenance" || c.key.startsWith("mnt.");
      for (const [role, actions] of Object.entries(c.roles)) {
        if (role === "administrator" || role === "super_admin") continue;
        // Plant In Charge also gets the Plant Production and Fuel defaults it
        // inherits from the Plant Manager (copied in permissionCatalogue.js).
        if (!isNew && role !== "plant_in_charge") continue;
        for (const a of actions) rows.push([role, c.key, a]);
      }
    }
    if (rows.length) {
      await pool.query(
        `INSERT INTO role_default_permissions (role, permission_key, action)
         SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
         ON CONFLICT DO NOTHING`,
        [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])]
      );
    }
    await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r215_mnt_grants') ON CONFLICT DO NOTHING`);
    notes.push(`granted ${rows.length} default permission(s) for the Maintenance module and Plant In Charge`);
  }

  log.push(`Schema migration applied (Round 215 — Maintenance module${notes.length ? `: ${notes.join("; ")}` : ""}).`);
}
