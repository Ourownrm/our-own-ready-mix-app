// Round 268 — Team Chat: tables, default groups, role defaults.
//
// Owner, 1 Nov 2026: "create a chat page like whatsapp in app, so small
// communications with in the team will happen in app" — and "chat i want
// without costing anything extra in render". Mock-up:
// claude/customer-feedback-team-chat-mockup-v1.md (artboards 5–8).
//
// So the chat lives in the SAME web service and the SAME Postgres database as
// everything else: no websocket server, no chat service, no file storage.
// Phones ask "anything new?" every few seconds while a chat is open
// (routes/chat.js), photos are shrunk on the phone before upload and stored
// in Postgres, and old photos / messages are cleared on a schedule the
// Administrator sets (chat_settings).
//
// Additive only, safe to run on every start. It runs itself when the chat
// router loads (routes/chat.js) and again from /setup if that ever calls it,
// so the round needs no /setup visit and no change to index.js.
import { query } from "../db.js";
import { CATALOGUE_BY_KEY } from "./permissionCatalogue.js";

const SQL = `
CREATE TABLE IF NOT EXISTS app_migration_marks (
  mark VARCHAR(80) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_rooms (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('group', 'direct')),
  name VARCHAR(80),
  -- Who is in a group by role. '*' = every staff member. Administrator and
  -- Super Admin are in every group whatever this says (routes/chat.js).
  member_roles TEXT[] NOT NULL DEFAULT '{}',
  -- 'all' = every member may post; 'admins' = only Team Chat managers (Announcements).
  post_policy VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (post_policy IN ('all', 'admins')),
  -- A one-to-one chat: "<smaller user id>:<larger user id>", so the pair has exactly one room.
  direct_key VARCHAR(40) UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  last_message_id BIGINT,
  last_message_at TIMESTAMPTZ
);
-- People added to a group by name (on top of its roles), or taken out of it
-- although their role is listed (excluded). For a one-to-one chat: its two people.
CREATE TABLE IF NOT EXISTS chat_room_members (
  room_id INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  excluded BOOLEAN NOT NULL DEFAULT false,
  added_by INTEGER REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT,
  order_id INTEGER REFERENCES customer_orders(id) ON DELETE SET NULL,
  mentions INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages (room_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages (created_at);
-- A photo is kept in the database (Render's disk is wiped on every deploy).
-- When it passes the keep period its bytes are cleared and the message
-- shows "photo expired"; the text stays.
CREATE TABLE IF NOT EXISTS chat_photos (
  id SERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  mime VARCHAR(40) NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chat_photos_message ON chat_photos (message_id);
-- Each person's place in each chat: what they have read, muted, last push.
CREATE TABLE IF NOT EXISTS chat_reads (
  room_id INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id BIGINT NOT NULL DEFAULT 0,
  muted BOOLEAN NOT NULL DEFAULT false,
  last_push_at TIMESTAMPTZ,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  poll_open_s INTEGER NOT NULL DEFAULT 10,
  poll_badge_s INTEGER NOT NULL DEFAULT 60,
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  photos_allowed BOOLEAN NOT NULL DEFAULT true,
  photo_keep_days INTEGER NOT NULL DEFAULT 90,
  message_keep_months INTEGER NOT NULL DEFAULT 12,
  warn_mb INTEGER NOT NULL DEFAULT 200,
  last_cleanup_at TIMESTAMPTZ,
  last_warned_at TIMESTAMPTZ,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ
);
INSERT INTO chat_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

// The groups from the mock-up (artboard 8). The Administrator edits them in
// Team Chat → Settings; they are created once and never re-created.
export const DEFAULT_GROUPS = [
  { name: "Dispatch & Pump", roles: ["manager", "plant_in_charge", "plant_operator", "driver", "site_supervisor"], post: "all" },
  { name: "Plant Operations", roles: ["manager", "plant_in_charge", "plant_operator", "store", "loader_operator"], post: "all" },
  { name: "QC & Lab", roles: ["qc_engineer", "lab_technician", "manager", "plant_in_charge"], post: "all" },
  { name: "Accounts", roles: ["accountant"], post: "all" },
  { name: "Maintenance & Store", roles: ["store", "manager", "plant_in_charge"], post: "all" },
  { name: "Announcements", roles: ["*"], post: "admins" },
];

export const R268_KEYS = ["chat.use", "chat.manage"];

async function seedGroups(db, log) {
  const { rows: done } = await db.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r268_chat_groups'`);
  if (done.length) return;
  let i = 0;
  for (const g of DEFAULT_GROUPS) {
    i += 10;
    await db.query(
      `INSERT INTO chat_rooms (kind, name, member_roles, post_policy, sort_order)
       SELECT 'group', $1::text, $2::text[], $3::text, $4::int
        WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE kind = 'group' AND lower(name) = lower($1::text))`,
      [g.name, g.roles, g.post, i]);
  }
  await db.query(`INSERT INTO app_migration_marks (mark) VALUES ('r268_chat_groups') ON CONFLICT DO NOTHING`);
  log?.push?.("Round 268: Team Chat groups created.");
}

// The two new functions' role defaults, added ONCE and never where the Super
// Admin has already decided that role + function (same rule as Round 264).
async function grants(db, log) {
  const { rows: done } = await db.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r268_chat_grants'`);
  if (done.length) return;
  const roles = [], keys = [], actions = [];
  for (const k of R268_KEYS) {
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
    // A database without the access-control tables yet (very old install):
    // /setup seeds the whole catalogue there, these included.
    if (/does not exist/.test(e.message)) return { rowCount: 0 };
    throw e;
  });
  await db.query(`INSERT INTO app_migration_marks (mark) VALUES ('r268_chat_grants') ON CONFLICT DO NOTHING`);
  log?.push?.(`Round 268: Team Chat — ${rowCount} role default(s) added.`);
}

export async function migrateRound268(db, log) {
  await db.query(SQL);
  await seedGroups(db, log);
  await grants(db, log);
}

let ready = null;
export function ensureChat() {
  if (!ready) ready = migrateRound268({ query }).catch((e) => { ready = null; throw e; });
  return ready;
}
