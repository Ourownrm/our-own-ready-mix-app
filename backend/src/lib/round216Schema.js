// Round 216 — Maintenance module, part 2:
//   * Tyres & batteries, tracked by serial number: where each is fitted, how
//     far it has run, retreads, warranty and claims (mockup screen 10).
//   * Certificates & expiry for every vehicle and piece of equipment, with
//     renewal history, required types per machine type, reminders and fees in
//     Payments (mockup screen 11). Replaces Statutory Compliance — its assets
//     and documents are carried over once.
//   * Older screens retired into the module: markers on their tables record
//     which old record has been brought over to a job card or schedule.
import { CATALOGUE } from "./permissionCatalogue.js";

// Certificate types. The first eleven keys are the old Statutory Compliance
// document types, so carried-over documents keep their type.
export const CERT_TYPES = {
  insurance: "Insurance",
  fitness_certificate: "Fitness certificate",
  permit: "Permit",
  puc: "PUC",
  road_tax: "Road tax",
  registration_certificate: "Registration certificate",
  amc: "AMC",
  calibration_certificate: "Calibration certificate",
  inspection_certificate: "Inspection certificate",
  load_testing_certificate: "Load testing certificate",
  safety_certification: "Safety certification",
  legal_metrology: "Legal Metrology stamping",
  pressure_vessel: "Pressure vessel test",
  electrical_inspector: "Electrical inspector approval",
  fire_extinguisher: "Fire extinguisher refill",
  other: "Other",
};

// Which tyre positions a machine type has (the tyre map on screen 10).
export const TYRE_LAYOUTS = {
  "Transit mixer": ["FL", "FR", "R1-LO", "R1-LI", "R1-RI", "R1-RO", "R2-LO", "R2-LI", "R2-RI", "R2-RO", "SPARE"],
  "Boom pump": ["FL", "FR", "R1-LO", "R1-LI", "R1-RI", "R1-RO", "R2-LO", "R2-LI", "R2-RI", "R2-RO", "SPARE"],
  "Light truck": ["FL", "FR", "R-LO", "R-LI", "R-RI", "R-RO", "SPARE"],
  "Light vehicle": ["FL", "FR", "RL", "RR", "SPARE"],
  Loader: ["FL", "FR", "RL", "RR"],
  "Two-wheeler": ["F", "R"],
};
export const BATTERY_SLOTS = {
  "Transit mixer": ["B1", "B2"], "Boom pump": ["B1", "B2"], "Light truck": ["B1"], "Light vehicle": ["B1"],
  Loader: ["B1"], "Two-wheeler": ["B1"], Plant: ["B1"], Generator: ["B1", "B2"], Other: ["B1"],
};

export const ROUND216_SQL = `
-- Jobs remember what put them there (a breakdown report, an inspection
-- action item, an old repair point …) so closing the card can close that too.
ALTER TABLE mnt_jobs ADD COLUMN IF NOT EXISTS source_type VARCHAR(24);
ALTER TABLE mnt_jobs ADD COLUMN IF NOT EXISTS source_id INTEGER;

-- Which old record has been brought over into the module.
ALTER TABLE external_repairs ADD COLUMN IF NOT EXISTS moved_to_card INTEGER;
ALTER TABLE repair_action_points ADD COLUMN IF NOT EXISTS moved_to_card INTEGER;
ALTER TABLE inspection_action_items ADD COLUMN IF NOT EXISTS moved_to_card INTEGER;
ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS moved_to_card INTEGER;
ALTER TABLE maintenance_action_points ADD COLUMN IF NOT EXISTS moved_to_schedule INTEGER;

-- Tyres: one row per tyre (serial), wherever it is.
CREATE TABLE IF NOT EXISTS mnt_tyres (
  id             SERIAL PRIMARY KEY,
  serial         VARCHAR(40) NOT NULL,
  brand          VARCHAR(60),
  size           VARCHAR(40),
  pattern        VARCHAR(60),
  kind           VARCHAR(8) NOT NULL DEFAULT 'new' CHECK (kind IN ('new','retread')),
  status         VARCHAR(12) NOT NULL DEFAULT 'in_store' CHECK (status IN ('in_store','fitted','at_retread','scrapped')),
  asset_id       INTEGER REFERENCES mnt_assets(id),
  position       VARCHAR(10),
  fitted_at      TIMESTAMPTZ,
  fitted_km      NUMERIC(12,1),
  km_run         NUMERIC(12,1) NOT NULL DEFAULT 0,
  retread_count  INTEGER NOT NULL DEFAULT 0,
  retread_vendor VARCHAR(100),
  last_tread_mm  NUMERIC(5,1),
  last_tread_at  DATE,
  cost           NUMERIC(12,2),
  retread_cost   NUMERIC(12,2) NOT NULL DEFAULT 0,
  store_txn_id   INTEGER REFERENCES mnt_store_txns(id),
  supplier       VARCHAR(120),
  purchase_date  DATE,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_tyres_serial ON mnt_tyres (lower(serial));
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_tyres_position ON mnt_tyres (asset_id, position) WHERE status = 'fitted';

CREATE TABLE IF NOT EXISTS mnt_batteries (
  id             SERIAL PRIMARY KEY,
  serial         VARCHAR(40) NOT NULL,
  make           VARCHAR(60),
  spec           VARCHAR(60),
  status         VARCHAR(12) NOT NULL DEFAULT 'in_store' CHECK (status IN ('in_store','fitted','claim','scrapped')),
  asset_id       INTEGER REFERENCES mnt_assets(id),
  position       VARCHAR(10),
  fitted_at      TIMESTAMPTZ,
  fitted_km      NUMERIC(12,1),
  warranty_until DATE,
  cost           NUMERIC(12,2),
  store_txn_id   INTEGER REFERENCES mnt_store_txns(id),
  supplier       VARCHAR(120),
  purchase_date  DATE,
  claim_note     TEXT,
  claim_at       DATE,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_batteries_serial ON mnt_batteries (lower(serial));
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_batteries_position ON mnt_batteries (asset_id, position) WHERE status = 'fitted';

-- Every move of a tyre or battery, with the odometer, so its life follows it
-- across vehicles and retreads.
CREATE TABLE IF NOT EXISTS mnt_tb_moves (
  id            SERIAL PRIMARY KEY,
  kind          VARCHAR(8) NOT NULL CHECK (kind IN ('tyre','battery')),
  item_id       INTEGER NOT NULL,
  action        VARCHAR(16) NOT NULL,
  asset_id      INTEGER REFERENCES mnt_assets(id),
  position      VARCHAR(10),
  from_position VARCHAR(10),
  km            NUMERIC(12,1),
  tread_mm      NUMERIC(5,1),
  amount        NUMERIC(12,2),
  job_card_id   INTEGER REFERENCES mnt_job_cards(id),
  note          TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mnt_tb_moves_item ON mnt_tb_moves (kind, item_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_mnt_tb_moves_asset ON mnt_tb_moves (asset_id, id DESC);

-- Certificates: renewing adds a new row and marks the old one superseded, so
-- the history is kept (the old Statutory Compliance overwrote in place).
CREATE TABLE IF NOT EXISTS mnt_certificates (
  id                   SERIAL PRIMARY KEY,
  asset_id             INTEGER NOT NULL REFERENCES mnt_assets(id),
  cert_type            VARCHAR(40) NOT NULL,
  label                VARCHAR(100),
  number               VARCHAR(100),
  valid_from           DATE,
  valid_to             DATE NOT NULL,
  authority            VARCHAR(150),
  fee                  NUMERIC(12,2),
  status               VARCHAR(12) NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded','retired')),
  renewed_from_id      INTEGER REFERENCES mnt_certificates(id),
  legacy_compliance_id INTEGER UNIQUE,
  document             BYTEA,
  document_name        VARCHAR(150),
  document_mime        VARCHAR(80),
  note                 TEXT,
  created_by           INTEGER REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mnt_certificates_current ON mnt_certificates (asset_id, cert_type, COALESCE(label, '')) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_mnt_certificates_valid ON mnt_certificates (valid_to) WHERE status = 'current';

-- Which certificates every machine of a type must have (Administrator).
CREATE TABLE IF NOT EXISTS mnt_cert_rules (
  asset_group  VARCHAR(40) NOT NULL,
  cert_type    VARCHAR(40) NOT NULL,
  PRIMARY KEY (asset_group, cert_type)
);

-- One reminder per certificate per day (30, 15, 7 days before, on the day,
-- then daily until renewed).
CREATE TABLE IF NOT EXISTS mnt_cert_reminders (
  certificate_id INTEGER NOT NULL REFERENCES mnt_certificates(id),
  sent_on        DATE NOT NULL,
  PRIMARY KEY (certificate_id, sent_on)
);

ALTER TABLE mnt_bills DROP CONSTRAINT IF EXISTS mnt_bills_source_type_check;
ALTER TABLE mnt_bills ADD CONSTRAINT mnt_bills_source_type_check CHECK (source_type IN ('grv','outside_repair','certificate'));
`;

// Old Statutory Compliance asset types → maintenance machine types.
const COMPLIANCE_GROUP = {
  transit_mixer: "Transit mixer", boom_pump: "Boom pump", batching_plant: "Plant", loader: "Loader",
  generator: "Generator", weighbridge: "Plant", compressor: "Plant", pickup: "Light vehicle", car: "Light vehicle",
  motor_bike: "Two-wheeler", other: "Other",
};
const DEFAULT_RULES = {
  "Transit mixer": ["insurance", "fitness_certificate", "permit", "puc", "road_tax"],
  "Boom pump": ["insurance", "fitness_certificate", "permit", "puc", "road_tax"],
  "Light truck": ["insurance", "fitness_certificate", "permit", "puc", "road_tax"],
  "Light vehicle": ["insurance", "puc"],
  "Two-wheeler": ["insurance", "puc"],
  Loader: ["insurance"],
  Plant: ["calibration_certificate"],
};

const norm = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export async function migrateRound216(pool, log) {
  await pool.query(ROUND216_SQL);
  const notes = [];
  const mark = async (m) => (await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = $1`, [m])).rows.length > 0;
  const setMark = (m) => pool.query(`INSERT INTO app_migration_marks (mark) VALUES ($1) ON CONFLICT DO NOTHING`, [m]);

  // Statutory Compliance → Certificates, once. Each compliance asset is
  // matched to a maintenance vehicle by registration, asset number or name
  // (ignoring spaces and dashes); one with no match is added to the register
  // without a model, to be given one (or merged) on the Equipment tab.
  if (!(await mark("r216_compliance"))) {
    const exists = (await pool.query(`SELECT to_regclass('compliance_documents') AS t`)).rows[0].t;
    if (exists) {
      const { rows: cas } = await pool.query(`SELECT * FROM compliance_assets WHERE is_active ORDER BY id`);
      const { rows: assets } = await pool.query(`SELECT id, name, asset_no, reg_no FROM mnt_assets WHERE is_active`);
      let matched = 0, added = 0, docs = 0;
      for (const ca of cas) {
        const key = norm(ca.name);
        let a = assets.find((x) => key && (norm(x.reg_no) === key || norm(x.asset_no) === key || norm(x.name) === key
          || norm(x.name).startsWith(key)));
        if (a) matched += 1;
        else {
          const { rows } = await pool.query(
            `INSERT INTO mnt_assets (name, asset_group, detail) VALUES ($1, $2, 'From Statutory Compliance') RETURNING id, name`,
            [ca.name, COMPLIANCE_GROUP[ca.asset_type] || "Other"]);
          a = rows[0];
          assets.push({ ...a, asset_no: null, reg_no: null });
          added += 1;
        }
        const { rows: ds } = await pool.query(`SELECT * FROM compliance_documents WHERE asset_id = $1`, [ca.id]);
        for (const d of ds) {
          const type = CERT_TYPES[d.document_type] ? d.document_type : "other";
          const r = await pool.query(
            `INSERT INTO mnt_certificates (asset_id, cert_type, label, number, valid_to, created_by, created_at, legacy_compliance_id, note)
             VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,'Carried over from Statutory Compliance')
             ON CONFLICT DO NOTHING`,
            [a.id, type, type === "other" ? d.document_type : null, d.document_number, d.expiry_date, d.updated_by, d.updated_at, d.id]);
          docs += r.rowCount;
        }
      }
      notes.push(`Statutory Compliance carried over — ${docs} document(s); ${matched} asset(s) matched to the register, ${added} added without a model`);
    }
    await setMark("r216_compliance");
  }

  if (!(await mark("r216_cert_rules"))) {
    for (const [g, types] of Object.entries(DEFAULT_RULES)) {
      for (const t of types) await pool.query(`INSERT INTO mnt_cert_rules (asset_group, cert_type) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [g, t]);
    }
    await setMark("r216_cert_rules");
    notes.push("default certificate types per machine type set");
  }

  // Defaults for the new functions, for roles that already have rows (the
  // seeding loop only fills a role with none). Once, so a later "off" sticks.
  if (!(await mark("r216_grants"))) {
    const NEW = ["mnt.tyres", "mnt.certificates", "mnt.cert-rules", "mnt.legacy-import"];
    const rows = [];
    for (const c of CATALOGUE) {
      if (!NEW.includes(c.key)) continue;
      for (const [role, actions] of Object.entries(c.roles)) {
        if (role === "administrator" || role === "super_admin") continue;
        for (const a of actions) rows.push([role, c.key, a]);
      }
    }
    if (rows.length) {
      await pool.query(
        `INSERT INTO role_default_permissions (role, permission_key, action)
         SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
        [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])]);
    }
    await setMark("r216_grants");
    notes.push(`granted ${rows.length} default permission(s)`);
  }

  log.push(`Schema migration applied (Round 216 — tyres & batteries, certificates${notes.length ? `: ${notes.join("; ")}` : ""}).`);
}
