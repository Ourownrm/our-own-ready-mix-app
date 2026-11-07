// Round 269 (v11.01) — owner, 6 Nov 2026: "code the marketing and weighbridge
// mock ups" (mockups: claude/marketing-directory-mockup-v1.md and the
// "Weighbridge ticket from the app" canvas; change: no photo attachment on the
// weighbridge).
//
// Additive only. Runs from /setup (migrateRound269) and lazily from the two
// route files (ensureRound269), so a deploy works before /setup is visited.
import { query } from "../db.js";
import { CATALOGUE_BY_KEY } from "./permissionCatalogue.js";

export const ROUND269_SQL = `
-- ============ Weighbridge: tickets weighed from the app ============
-- A closed app ticket is ALSO written into weighbridge_tickets (ticket_number
-- = 1,000,000 + id, source 'app') so Receipts, Record receipt and the variance
-- check treat it exactly like a SmartWeigh ticket. The agent's high-water mark
-- ignores those numbers (routes/weighbridge.js).
ALTER TABLE weighbridge_tickets ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'smartweigh';
ALTER TABLE weighbridge_tickets ADD COLUMN IF NOT EXISTS app_ticket_no VARCHAR(20);

CREATE SEQUENCE IF NOT EXISTS wb_app_ticket_seq;
CREATE TABLE IF NOT EXISTS wb_app_tickets (
  id                SERIAL PRIMARY KEY,
  ticket_no         VARCHAR(20) NOT NULL UNIQUE,
  purpose           VARCHAR(12) NOT NULL CHECK (purpose IN ('raw_in','rmc_out','internal','outside')),
  vehicle_text      VARCHAR(60) NOT NULL,
  vehicle_id        INTEGER REFERENCES weighbridge_vehicles(id),
  truck_id          INTEGER REFERENCES trucks(id),
  material_id       INTEGER REFERENCES rm_materials(id),
  material_text     VARCHAR(120),
  supplier_id       INTEGER REFERENCES rm_suppliers(id),
  rm_order_id       INTEGER REFERENCES rm_orders(id),
  delivery_ticket_id INTEGER REFERENCES delivery_tickets(id),
  party_name        VARCHAR(150),
  charge_amount     NUMERIC(10,2),
  charge_mode       VARCHAR(10),
  challan_no        VARCHAR(60),
  challan_qty       NUMERIC(12,3),
  driver_name       VARCHAR(120),
  remarks           TEXT,
  first_kg          INTEGER NOT NULL,
  first_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_by          INTEGER REFERENCES users(id),
  second_kg         INTEGER,
  second_at         TIMESTAMPTZ,
  second_by         INTEGER REFERENCES users(id),
  gross_kg          INTEGER,
  tare_kg           INTEGER,
  net_kg            INTEGER,
  status            VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  cancel_reason     TEXT,
  cancelled_by      INTEGER REFERENCES users(id),
  cancelled_at      TIMESTAMPTZ,
  wb_ticket_number  INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wb_app_open_vehicle ON wb_app_tickets (vehicle_id) WHERE status = 'open' AND vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wb_app_status ON wb_app_tickets (status, first_at DESC);

-- ============ Marketing ============
CREATE TABLE IF NOT EXISTS mkt_settings (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO mkt_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS mkt_firms (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  firm_type     VARCHAR(60),
  category      VARCHAR(60),
  status        VARCHAR(12) NOT NULL DEFAULT 'prospect' CHECK (status IN ('customer','prospect','inactive')),
  customer_id   INTEGER REFERENCES customers(id),
  area          VARCHAR(80),
  address       TEXT,
  office_phone  VARCHAR(30),
  email         VARCHAR(150),
  gstin         VARCHAR(20),
  owner_user_id INTEGER REFERENCES users(id),
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkt_firms_customer ON mkt_firms (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_firms_name ON mkt_firms (LOWER(name));

CREATE TABLE IF NOT EXISTS mkt_contacts (
  id            SERIAL PRIMARY KEY,
  firm_id       INTEGER NOT NULL REFERENCES mkt_firms(id) ON DELETE CASCADE,
  name          VARCHAR(150) NOT NULL,
  designation   VARCHAR(100),
  level         SMALLINT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  mobile        VARCHAR(20),
  on_whatsapp   BOOLEAN NOT NULL DEFAULT true,
  email         VARCHAR(150),
  prefers       VARCHAR(10) NOT NULL DEFAULT 'whatsapp' CHECK (prefers IN ('whatsapp','email','phone')),
  birthday      DATE,
  consent       BOOLEAN NOT NULL DEFAULT false,
  consent_at    TIMESTAMPTZ,
  opted_out_at  TIMESTAMPTZ,
  sales_contact_id INTEGER REFERENCES sales_contacts(id),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_firm ON mkt_contacts (firm_id);

CREATE TABLE IF NOT EXISTS mkt_plans (
  id            SERIAL PRIMARY KEY,
  firm_id       INTEGER NOT NULL REFERENCES mkt_firms(id) ON DELETE CASCADE,
  category      VARCHAR(60) NOT NULL,
  levels        SMALLINT[] NOT NULL DEFAULT '{1,2,3}',
  every_kind    VARCHAR(10) NOT NULL DEFAULT 'months' CHECK (every_kind IN ('once','days','weeks','months','yearly','festival','when_sent')),
  every_n       SMALLINT NOT NULL DEFAULT 1,
  channels      TEXT[] NOT NULL DEFAULT '{whatsapp}',
  next_due      DATE,
  last_done     DATE,
  paused        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_plans_due ON mkt_plans (next_due) WHERE NOT paused;

CREATE TABLE IF NOT EXISTS mkt_items (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(200) NOT NULL,
  kind          VARCHAR(10) NOT NULL CHECK (kind IN ('poster','video','pdf','brochure')),
  topic         VARCHAR(120),
  language      VARCHAR(30),
  valid_until   DATE,
  version       SMALLINT NOT NULL DEFAULT 1,
  previous_id   INTEGER REFERENCES mkt_items(id),
  status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','sent_back','retired')),
  drive_file_id VARCHAR(120),
  file_name     VARCHAR(200),
  mime          VARCHAR(100),
  size_bytes    BIGINT,
  notes         TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS mkt_sends (
  id            SERIAL PRIMARY KEY,
  category      VARCHAR(60),
  item_ids      INTEGER[] NOT NULL DEFAULT '{}',
  message       TEXT NOT NULL,
  channels      TEXT[] NOT NULL,
  firm_id       INTEGER REFERENCES mkt_firms(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mkt_recipients (
  id              SERIAL PRIMARY KEY,
  send_id         INTEGER NOT NULL REFERENCES mkt_sends(id) ON DELETE CASCADE,
  firm_id         INTEGER REFERENCES mkt_firms(id) ON DELETE SET NULL,
  contact_id      INTEGER REFERENCES mkt_contacts(id) ON DELETE SET NULL,
  channel         VARCHAR(10) NOT NULL CHECK (channel IN ('wa_api','wa_phone','email','skipped')),
  token           VARCHAR(24) NOT NULL UNIQUE,
  status          VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed','skipped')),
  skip_reason     TEXT,
  wa_message_id   VARCHAR(120),
  error           TEXT,
  sent_by         INTEGER REFERENCES users(id),
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  first_open_at   TIMESTAMPTZ,
  last_open_at    TIMESTAMPTZ,
  open_count      INTEGER NOT NULL DEFAULT 0,
  download_count  INTEGER NOT NULL DEFAULT 0,
  play_end_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mkt_recipients_send ON mkt_recipients (send_id);
CREATE INDEX IF NOT EXISTS idx_mkt_recipients_wa ON mkt_recipients (wa_message_id) WHERE wa_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mkt_events (
  id            BIGSERIAL PRIMARY KEY,
  recipient_id  INTEGER NOT NULL REFERENCES mkt_recipients(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES mkt_items(id),
  kind          VARCHAR(10) NOT NULL CHECK (kind IN ('open','view','download','play_end','opt_out')),
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mkt_log (
  id            SERIAL PRIMARY KEY,
  firm_id       INTEGER NOT NULL REFERENCES mkt_firms(id) ON DELETE CASCADE,
  contact_id    INTEGER REFERENCES mkt_contacts(id) ON DELETE SET NULL,
  plan_id       INTEGER REFERENCES mkt_plans(id) ON DELETE SET NULL,
  send_id       INTEGER REFERENCES mkt_sends(id) ON DELETE SET NULL,
  category      VARCHAR(60),
  channel       VARCHAR(10),
  outcome       VARCHAR(16),
  note          TEXT,
  by_user       INTEGER REFERENCES users(id),
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_log_firm ON mkt_log (firm_id, at DESC);

CREATE TABLE IF NOT EXISTS app_migration_marks (mark VARCHAR(80) PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

export const R269_KEYS = [
  "weighbridge.weighing", "module.marketing", "marketing.directory", "marketing.library", "marketing.approve",
  "marketing.send-group", "marketing.send-own", "marketing.tracking", "marketing.settings",
];

async function grants(db, log) {
  const { rows: done } = await db.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r269_grants'`);
  if (done.length) return;
  const roles = [], keys = [], actions = [];
  for (const k of R269_KEYS) {
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
     ON CONFLICT DO NOTHING`, [roles, keys, actions]).catch((e) => {
    if (/does not exist/.test(e.message)) return { rowCount: 0 };
    throw e;
  });
  await db.query(`INSERT INTO app_migration_marks (mark) VALUES ('r269_grants') ON CONFLICT DO NOTHING`);
  log?.push?.(`Round 269: weighing from the app and the Marketing module — ${rowCount} role default(s) added.`);
}

export async function migrateRound269(db, log) {
  await db.query(ROUND269_SQL);
  await grants(db, log);
  log?.push?.("Round 269: weighbridge tickets from the app; Marketing directory, library, sending and tracking.");
}

let ready = null;
export function ensureRound269() {
  if (!ready) ready = migrateRound269({ query }).catch((e) => { ready = null; throw e; });
  return ready;
}
