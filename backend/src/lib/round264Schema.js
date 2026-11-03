// Round 264 (v10.96) — Tools Issue Register, personal assets, cube moulds &
// pump pipes, exit clearance with a payroll hold (owner, 2–3 Nov 2026; the
// approved mockup is claude/tools-issue-register-mockup-v1.md, v5).
//
//   tl_types        the tool list / asset types / mould & pipe types, each with
//                   its ID prefix (T, PT, IT, CM, PM, CY, PP, PB …); a type can
//                   be tied to a Maintenance store item so a GRV knows it
//   tl_items        ONE row per numbered thing — a spanner set, a grinder, a
//                   laptop, a cube mould, a pipe. Its code (CM-041) is never
//                   reused, even after the item is removed.
//   tl_batches      the one-time "add existing list" (and later corrections),
//                   confirmed by the Plant In Charge before the items count
//   tl_issues       Store issues to an employee (permanent / temporary); the
//   tl_issue_lines  Plant In Charge approves (Administrator for personal
//                   assets); the employee accepts on the phone; a take-back is
//                   per line, with condition — damaged / lost goes to the
//                   Administrator: no charge, repair, or recover from salary
//   tl_kits         standard kits (Mechanic, Electrician …) of tool types
//   tl_removals     a damaged / lost mould, pipe or tool leaves the list only
//                   when the Plant In Charge (Administrator if lost) approves
//   tl_events       every change to an item, for its history
//   hr_exit_clearance  the five sections of an exit clearance; salary is held
//                   on payroll until the Administrator approves the clearance
import { query } from "../db.js";
import { CATALOGUE_BY_KEY } from "./permissionCatalogue.js";
import { ROUND249_SQL } from "./round249Schema.js";

export const ROUND264_SQL = `
CREATE TABLE IF NOT EXISTS tl_types (
  id             SERIAL PRIMARY KEY,
  kind           VARCHAR(12) NOT NULL CHECK (kind IN ('tool','power_tool','asset','cube_mould','pump_pipe')),
  name           VARCHAR(150) NOT NULL,
  prefix         VARCHAR(6) NOT NULL,
  store_item_id  INTEGER REFERENCES mnt_store_items(id),
  value          NUMERIC(12,2),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tl_types_name ON tl_types(kind, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_tl_types_store_item ON tl_types(store_item_id) WHERE store_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tl_batches (
  id            SERIAL PRIMARY KEY,
  is_opening    BOOLEAN NOT NULL DEFAULT true,
  status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  note          VARCHAR(500),
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note VARCHAR(300)
);

CREATE TABLE IF NOT EXISTS tl_items (
  id              SERIAL PRIMARY KEY,
  kind            VARCHAR(12) NOT NULL CHECK (kind IN ('tool','power_tool','asset','cube_mould','pump_pipe')),
  type_id         INTEGER NOT NULL REFERENCES tl_types(id),
  code            VARCHAR(20) NOT NULL UNIQUE,
  make_model      VARCHAR(150),
  serial_no       VARCHAR(80),
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(16) NOT NULL DEFAULT 'in_store'
                  CHECK (status IN ('pending','in_store','issue_pending','issued','in_use','at_site','removal_pending','repair','removed','lost')),
  location        VARCHAR(150),
  employee_id     INTEGER REFERENCES hr_employees(id),
  since           TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          VARCHAR(10) NOT NULL DEFAULT 'added' CHECK (source IN ('opening','grv','added')),
  grv_id          INTEGER REFERENCES mnt_grvs(id),
  batch_id        INTEGER REFERENCES tl_batches(id),
  purchase_value  NUMERIC(12,2),
  purchase_date   DATE,
  warranty_until  DATE,
  condition_note  VARCHAR(300),
  cast_ref        VARCHAR(150),
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tl_items_kind ON tl_items(kind, status);
CREATE INDEX IF NOT EXISTS idx_tl_items_emp ON tl_items(employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tl_kits (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(80) NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tl_kit_types (
  kit_id   INTEGER NOT NULL REFERENCES tl_kits(id) ON DELETE CASCADE,
  type_id  INTEGER NOT NULL REFERENCES tl_types(id),
  qty      INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  PRIMARY KEY (kit_id, type_id)
);

CREATE TABLE IF NOT EXISTS tl_issues (
  id             SERIAL PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES hr_employees(id),
  mode           VARCHAR(10) NOT NULL CHECK (mode IN ('permanent','temporary')),
  return_by      DATE,
  for_assets     BOOLEAN NOT NULL DEFAULT false,
  kit_id         INTEGER REFERENCES tl_kits(id),
  grv_id         INTEGER REFERENCES mnt_grvs(id),
  note           VARCHAR(500),
  status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by   INTEGER REFERENCES users(id),
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decision_note  VARCHAR(300),
  accepted_at    TIMESTAMPTZ,
  accept_note    VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS idx_tl_issues_status ON tl_issues(status);
CREATE TABLE IF NOT EXISTS tl_issue_lines (
  id                SERIAL PRIMARY KEY,
  issue_id          INTEGER NOT NULL REFERENCES tl_issues(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL REFERENCES tl_items(id),
  returned_at       TIMESTAMPTZ,
  returned_by       INTEGER REFERENCES users(id),
  return_condition  VARCHAR(8) CHECK (return_condition IN ('good','damaged','lost')),
  return_note       VARCHAR(300),
  decision          VARCHAR(10) CHECK (decision IN ('no_charge','repair','recover')),
  recover_amount    NUMERIC(12,2),
  recover_month     CHAR(7),
  decided_by        INTEGER REFERENCES users(id),
  decided_at        TIMESTAMPTZ,
  decision_note     VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS idx_tl_issue_lines_item ON tl_issue_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_tl_issue_lines_recover ON tl_issue_lines(recover_month) WHERE decision = 'recover';

CREATE TABLE IF NOT EXISTS tl_removals (
  id             SERIAL PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES tl_items(id),
  reason         VARCHAR(40) NOT NULL,
  note           VARCHAR(500),
  photo          TEXT,
  scrap          BOOLEAN NOT NULL DEFAULT false,
  is_lost        BOOLEAN NOT NULL DEFAULT false,
  prev_status    VARCHAR(16),
  status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reported_by    INTEGER REFERENCES users(id),
  reported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decision_note  VARCHAR(300)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tl_removals_open ON tl_removals(item_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS tl_events (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES tl_items(id) ON DELETE CASCADE,
  event       VARCHAR(20) NOT NULL,
  note        VARCHAR(500),
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tl_events_item ON tl_events(item_id, created_at DESC);

ALTER TABLE mnt_grv_lines ADD COLUMN IF NOT EXISTS register_codes TEXT;
ALTER TABLE site_cube_casts ADD COLUMN IF NOT EXISTS mould_codes TEXT;

ALTER TABLE hr_exits ADD COLUMN IF NOT EXISTS clearance_approved_by INTEGER REFERENCES users(id);
ALTER TABLE hr_exits ADD COLUMN IF NOT EXISTS clearance_approved_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS hr_exit_clearance (
  exit_id     INTEGER NOT NULL REFERENCES hr_exits(id) ON DELETE CASCADE,
  section     VARCHAR(10) NOT NULL CHECK (section IN ('tools','assets','money','ppe','handover')),
  status      VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared')),
  note        VARCHAR(300),
  cleared_by  INTEGER REFERENCES users(id),
  cleared_at  TIMESTAMPTZ,
  PRIMARY KEY (exit_id, section)
);
`;

// The starting lists from the mockup — a start for the owner to edit.
const SEED_TYPES = [
  ["cube_mould", "Cube mould, cast iron 150 mm", "CM"],
  ["cube_mould", "Cube mould, plastic 150 mm", "PM"],
  ["cube_mould", "Cylinder mould 150 × 300 mm", "CY"],
  ["pump_pipe", "Straight pipe 3 m (125 mm)", "PP"],
  ["pump_pipe", "Straight pipe 2 m (125 mm)", "PP"],
  ["pump_pipe", "Straight pipe 1 m (125 mm)", "PP"],
  ["pump_pipe", "Straight pipe 0.5 m (125 mm)", "PP"],
  ["pump_pipe", "Bend 90°", "PB"],
  ["pump_pipe", "Bend 45°", "PB"],
  ["pump_pipe", "Bend 30°", "PB"],
  ["pump_pipe", "Reducer 5″ → 4″", "PR"],
  ["pump_pipe", "End hose 3 m", "PH"],
  ["pump_pipe", "Rubber hose 5 m", "PH"],
  ...["Breaker / demolition hammer", "Rotary hammer drill", "Angle grinder 4″", "Angle grinder 7″", "Core drill", "Drill machine",
    "Welding machine", "Chop saw", "Insulation tester (megger)", "Earth tester", "Pressure washer", "Air blower", "Impact wrench",
    "Magnetic drill", "Concrete vibrator", "Bench grinder", "Heat gun", "Jigsaw", "Portable generator"].map((n) => ["power_tool", n, "PT"]),
  ...["Laptop", "Desktop computer", "Monitor", "Keyboard", "Mouse", "Printer", "Scanner", "UPS", "Mobile phone", "SIM card", "Tablet",
    "Laptop bag", "Charger / adapter", "External hard disk", "Pen drive", "Headset", "Webcam", "Router / dongle", "Power bank",
    "Walkie-talkie", "Calculator", "Camera", "Office key / access card", "Company ID card", "Company two-wheeler", "Car keys"].map((n) => ["asset", n, "IT"]),
];
const MECH = ["Combination spanner set 6–32 mm", "Ring spanner set", "Double-end spanner set", "Socket set ½″", "Socket set ¾″",
  "Torque wrench", "Pipe wrench 18″", "Adjustable spanner 12″", "Combination pliers", "Long-nose pliers", "Circlip pliers set",
  "Screwdriver set", "Ball-peen hammer", "Sledge hammer", "Allen key set", "Grease gun", "Feeler gauge", "Vernier caliper",
  "Wheel spanner", "Tyre lever", "Hacksaw", "File set", "Chisel & punch set", "Tool box"];
const ELEC = ["Multimeter", "Clamp meter", "Line tester", "Insulated screwdriver set", "Insulated combination pliers", "Insulated long-nose pliers",
  "Wire stripper", "Crimping tool", "Cable cutter", "Side cutter", "Electrician's knife", "Soldering iron", "Insulation tape set",
  "Torch / headlamp", "Extension board", "Fish tape", "Tool bag", "Safety gloves (electrical)"];

async function seed(db) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM tl_types`);
  if (rows[0].n) return;
  const all = [...SEED_TYPES, ...MECH.map((n) => ["tool", n, "T"]), ...ELEC.filter((n) => !MECH.includes(n)).map((n) => ["tool", n, "T"])];
  for (const [kind, name, prefix] of all) {
    await db.query(`INSERT INTO tl_types (kind, name, prefix) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [kind, name, prefix]);
  }
  for (const [kit, list] of [["Mechanic kit", MECH], ["Electrician kit", ELEC]]) {
    const { rows: k } = await db.query(`INSERT INTO tl_kits (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [kit]);
    await db.query(
      `INSERT INTO tl_kit_types (kit_id, type_id, qty) SELECT $1, id, 1 FROM tl_types WHERE kind = 'tool' AND name = ANY($2::text[]) ON CONFLICT DO NOTHING`,
      [k[0].id, list]);
  }
}

// The new functions. Their role defaults come from the catalogue; they are
// added to a live database ONCE, never where the Super Admin has already
// decided that role + function.
export const R264_KEYS = ["tools.register", "tools.issue", "tools.approve", "tools.kits", "tools.in-use", "tools.report-damage",
  "tools.removal-approve", "tools.loss-decide", "tools.my", "hr.assets", "hr.asset-approve", "hr.exit-clear-money", "hr.exit-clear-handover"];

async function grants(db, log) {
  const { rows: done } = await db.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r264_tools_grants'`).catch(() => ({ rows: [{}] }));
  if (done.length) return;
  const roles = [], keys = [], actions = [];
  for (const k of R264_KEYS) {
    const c = CATALOGUE_BY_KEY[k];
    if (!c) continue;
    for (const [role, acts] of Object.entries(c.roles || {})) for (const a of acts) { roles.push(role); keys.push(k); actions.push(a); }
  }
  const { rowCount } = await db.query(
    `INSERT INTO role_default_permissions (role, permission_key, action)
     SELECT g.role::user_role, g.k, g.a FROM UNNEST($1::text[], $2::text[], $3::text[]) AS g(role, k, a)
      WHERE g.role IN (SELECT unnest(enum_range(NULL::user_role))::text)
        AND EXISTS (SELECT 1 FROM role_default_permissions d WHERE d.role::text = g.role)
        AND NOT EXISTS (SELECT 1 FROM permission_change_log l WHERE l.target_role::text = g.role AND l.permission_key = g.k AND l.action = g.a)
     ON CONFLICT DO NOTHING`, [roles, keys, actions]);
  await db.query(`INSERT INTO app_migration_marks (mark) VALUES ('r264_tools_grants') ON CONFLICT DO NOTHING`);
  log?.push?.(`Round 264: Tools & assets register, cube moulds & pipes, exit clearance — ${rowCount} role default(s) added.`);
}

export async function migrateRound264(db, log) {
  await db.query(ROUND249_SQL);   // hr_exits must exist first
  await db.query(ROUND264_SQL);
  await seed(db);
  await grants(db, log);
}

let ready = null;
export function ensureRound264() {
  if (!ready) ready = migrateRound264({ query }).catch((e) => { ready = null; throw e; });
  return ready;
}
