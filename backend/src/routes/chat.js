// Round 268 — Team Chat (owner, 1 & 6 Nov 2026). Mock-up:
// claude/customer-feedback-team-chat-mockup-v1.md, artboards 5–8.
//
// The owner's condition was "without costing anything extra in render", so
// this is deliberately plain HTTP on the existing web service:
//
//   * No websockets and no outside chat service. A phone with a chat OPEN asks
//     GET /rooms/:id/messages?after=<last id> every poll_open_s seconds (10 by
//     default); every other screen asks GET /unread every poll_badge_s (60) for
//     the badge in the header. Both are one indexed query. The app stops asking
//     while it is in the background (frontend/src/pages/TeamChat.jsx).
//   * Phone notifications use the web-push the app already has (lib/push.js);
//     nobody is pushed for a chat they are looking at right now.
//   * Photos are shrunk on the phone (about 150 KB) and kept in Postgres;
//     after photo_keep_days their bytes are cleared, and messages older than
//     message_keep_months are removed. That housekeeping runs from these
//     requests themselves at most once a day, so index.js needs no new timer.
//
// MOUNTED UNDER /api/notifications/chat (routes/notifications.js), not at its
// own /api/chat: Round 267 (v10.99) also changes index.js and had not been
// uploaded when this round was built, and two zips carrying different copies
// of index.js would undo one another. A later round can move it.
//
// Access: "chat.use" (view = read, create = send) and "chat.manage" (settings,
// groups, posting in an Admin-only group) on the Access Control page.
// Administrator and Super Admin are members of every group.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { allow, effectivePermissions } from "../lib/permissions.js";
import { pushToUser } from "../lib/push.js";
import { ensureChat } from "../lib/chatSchema.js";

const router = Router();

// The schema is made as soon as the server loads this file (so the badge's
// first request already finds its tables and its role defaults), and every
// request waits for it, so a request can never race the very first start.
if (process.env.DATABASE_URL) ensureChat().catch((e) => console.error("round 268 chat schema:", e.message));
router.use((req, res, next) => (req.user ? next() : requireAuth(req, res, next)));
router.use(async (req, res, next) => { try { await ensureChat(); next(); } catch (e) { next(e); } });

const USE = allow([["chat.use", "view"]]);
const MANAGE = allow([["chat.manage", "view"]]);
const MANAGE_EDIT = allow([["chat.manage", "edit"]]);
const ADMIN_LEVEL = ["administrator", "super_admin"];
const MAX_BODY = 4000;
const MAX_PHOTO_BYTES = 450 * 1024;     // after the phone has shrunk it; normal is ~150 KB
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function handle(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// A person may SEND when they hold chat.use:create. A view-only account (a
// partner, Round 249) keeps only "view" on everything; chat changes no
// business data, so it may still talk — the auth middleware lets
// /api/notifications/* writes through for exactly that kind of thing.
async function canSend(user) {
  const p = await effectivePermissions(user);
  return p.has("chat.use:create") || (user.view_only && p.has("chat.use:view"));
}
async function canManage(user, action = "edit") {
  if (ADMIN_LEVEL.includes(user.role)) return true;
  const p = await effectivePermissions(user);
  return p.has(`chat.manage:${action}`);
}

// ---- membership ----------------------------------------------------------
// SQL for "user <u> (role <role>) is in room <r>". Used for the room list,
// for opening a room, and — with the user columns of `users u` — for listing
// a room's members.
function memberOf(r, u, role) {
  return `(
    (${r}.kind = 'direct' AND EXISTS (SELECT 1 FROM chat_room_members cm WHERE cm.room_id = ${r}.id AND cm.user_id = ${u} AND NOT cm.excluded))
    OR (${r}.kind = 'group'
        AND NOT EXISTS (SELECT 1 FROM chat_room_members cx WHERE cx.room_id = ${r}.id AND cx.user_id = ${u} AND cx.excluded)
        AND (${role} IN ('administrator', 'super_admin') OR '*' = ANY(${r}.member_roles) OR ${role} = ANY(${r}.member_roles)
             OR EXISTS (SELECT 1 FROM chat_room_members cm WHERE cm.room_id = ${r}.id AND cm.user_id = ${u} AND NOT cm.excluded)))
  )`;
}

async function roomFor(req, id) {
  const { rows } = await query(
    `SELECT r.* FROM chat_rooms r WHERE r.id = $1 AND r.archived_at IS NULL AND ${memberOf("r", "$2::int", "$3::text")}`,
    [id, req.user.id, req.user.role]);
  return rows[0] || null;
}

async function membersOf(roomId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.role::text AS role
       FROM users u, chat_rooms r
      WHERE r.id = $1 AND u.is_active AND u.role::text <> 'customer' AND ${memberOf("r", "u.id", "u.role::text")}
      ORDER BY u.name`, [roomId]);
  return rows;
}

async function settings() {
  const { rows } = await query(`SELECT * FROM chat_settings WHERE id = 1`);
  return rows[0];
}

// Who is looking at which chat right now — so they are not ALSO pushed for
// it. In memory only: losing it on a restart just means one extra push.
const watching = new Map(); // `${userId}:${roomId}` -> ms
function markWatching(userId, roomId) { watching.set(`${userId}:${roomId}`, Date.now()); }
function isWatching(userId, roomId) { const t = watching.get(`${userId}:${roomId}`); return t && Date.now() - t < 25_000; }

// ---- housekeeping (at most once a day, from ordinary requests) -----------
let lastHousekeepCheck = 0;
function housekeepSoon() {
  if (Date.now() - lastHousekeepCheck < 3 * 3600_000) return;
  lastHousekeepCheck = Date.now();
  housekeep().catch((e) => console.error("chat housekeeping:", e.message));
}
async function housekeep() {
  const s = await settings();
  if (s.last_cleanup_at && Date.now() - new Date(s.last_cleanup_at).getTime() < 20 * 3600_000) return;
  await query(`UPDATE chat_settings SET last_cleanup_at = now() WHERE id = 1`);
  await query(
    `UPDATE chat_photos SET data = NULL, expired_at = now()
      WHERE data IS NOT NULL AND created_at < now() - make_interval(days => $1)`, [s.photo_keep_days]);
  await query(`DELETE FROM chat_messages WHERE created_at < now() - make_interval(months => $1)`, [s.message_keep_months]);
  const mb = await storageMb();
  if (mb >= s.warn_mb && (!s.last_warned_at || Date.now() - new Date(s.last_warned_at).getTime() > 7 * 86400_000)) {
    await query(
      `INSERT INTO notifications (recipient_role, type, message) VALUES ('administrator', 'chat_storage', $1)`,
      [`Team Chat is using ${mb} MB of the database (warning level ${s.warn_mb} MB). Shorten "Delete photos after" in Team Chat → Settings, or raise the warning level.`]);
    await query(`UPDATE chat_settings SET last_warned_at = now() WHERE id = 1`);
  }
}
async function storageMb() {
  const { rows } = await query(
    `SELECT COALESCE((SELECT SUM(octet_length(data)) FROM chat_photos WHERE data IS NOT NULL), 0)
          + COALESCE((SELECT SUM(octet_length(COALESCE(body, ''))) FROM chat_messages), 0) AS b`);
  return Math.round((Number(rows[0].b) / 1048576) * 10) / 10;
}

// ---- reading ---------------------------------------------------------------

// What the screens need to know before anything else.
router.get("/config", USE, handle(async (req, res) => {
  const s = await settings();
  res.json({
    me: { id: req.user.id, name: req.user.name, role: req.user.role },
    poll_open_s: s.poll_open_s, poll_badge_s: s.poll_badge_s,
    photos_allowed: s.photos_allowed, push_enabled: s.push_enabled,
    can_send: await canSend(req.user), can_manage: await canManage(req.user, "view"),
  });
}));

// The header badge: unread messages across every chat this person is in and
// has not muted. Cheap on purpose — it is asked every minute by every open app.
// A chat someone has never opened counts only its last 3 days, so a new
// starter is not greeted with a year of "unread".
router.get("/unread", USE, handle(async (req, res) => {
  housekeepSoon();
  const { rows } = await query(
    `SELECT COALESCE(SUM((SELECT COUNT(*) FROM chat_messages m
                           WHERE m.room_id = r.id AND m.id > COALESCE(rd.last_read_id, 0)
                             AND m.user_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL
                             AND (rd.room_id IS NOT NULL OR m.created_at > now() - interval '3 days'))), 0) AS n
       FROM chat_rooms r
       LEFT JOIN chat_reads rd ON rd.room_id = r.id AND rd.user_id = $1
      WHERE r.archived_at IS NULL AND r.last_message_id > COALESCE(rd.last_read_id, 0)
        AND NOT COALESCE(rd.muted, false)
        AND ${memberOf("r", "$1::int", "$2::text")}`,
    [req.user.id, req.user.role]);
  const s = await settings();
  res.json({ count: Number(rows[0].n), poll_badge_s: s.poll_badge_s });
}));

// The chat list: groups and one-to-one chats, newest first.
router.get("/rooms", USE, handle(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.kind, r.post_policy, r.sort_order, r.last_message_at,
            CASE WHEN r.kind = 'direct' THEN ou.name ELSE r.name END AS name,
            CASE WHEN r.kind = 'direct' THEN ou.role::text END AS other_role,
            CASE WHEN r.kind = 'direct' THEN ou.id END AS other_user_id,
            COALESCE(rd.muted, false) AS muted,
            lm.id AS last_id, lm.user_id AS last_user_id, lu.name AS last_user_name,
            CASE WHEN lm.deleted_at IS NOT NULL THEN 'Message deleted'
                 WHEN COALESCE(lm.body, '') <> '' THEN left(lm.body, 120)
                 WHEN EXISTS (SELECT 1 FROM chat_photos p WHERE p.message_id = lm.id) THEN 'Photo'
                 WHEN lm.order_id IS NOT NULL THEN 'Order ORM-' || lm.order_id
                 ELSE '' END AS last_text,
            (SELECT COUNT(*) FROM chat_messages m
              WHERE m.room_id = r.id AND m.id > COALESCE(rd.last_read_id, 0)
                AND m.user_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL
                AND (rd.room_id IS NOT NULL OR m.created_at > now() - interval '3 days'))::int AS unread
       FROM chat_rooms r
       LEFT JOIN chat_reads rd ON rd.room_id = r.id AND rd.user_id = $1
       LEFT JOIN chat_messages lm ON lm.id = r.last_message_id
       LEFT JOIN users lu ON lu.id = lm.user_id
       LEFT JOIN LATERAL (
         SELECT u.id, u.name, u.role FROM chat_room_members cm JOIN users u ON u.id = cm.user_id
          WHERE r.kind = 'direct' AND cm.room_id = r.id AND cm.user_id <> $1 LIMIT 1) ou ON true
      WHERE r.archived_at IS NULL AND ${memberOf("r", "$1::int", "$2::text")}
        AND (r.kind = 'group' OR r.last_message_id IS NOT NULL OR r.created_by = $1)
      ORDER BY r.kind DESC, COALESCE(r.last_message_at, r.created_at) DESC`,
    [req.user.id, req.user.role]);
  const send = await canSend(req.user);
  const manage = await canManage(req.user);
  res.json(rows.map((r) => ({ ...r, can_post: send && (r.post_policy === "all" || manage) })));
}));

// One chat: who is in it, may I post, is it muted.
router.get("/rooms/:id(\\d+)", USE, handle(async (req, res) => {
  const room = await roomFor(req, req.params.id);
  if (!room) return bad(res, "That chat was not found, or you are not in it.", 404);
  const members = await membersOf(room.id);
  const { rows: rd } = await query(`SELECT muted FROM chat_reads WHERE room_id = $1 AND user_id = $2`, [room.id, req.user.id]);
  const send = await canSend(req.user);
  const manage = await canManage(req.user);
  let name = room.name;
  if (room.kind === "direct") name = members.find((m) => m.id !== req.user.id)?.name || "Chat";
  res.json({
    id: room.id, kind: room.kind, name, post_policy: room.post_policy,
    can_post: send && (room.post_policy === "all" || manage),
    muted: !!rd[0]?.muted, members,
  });
}));

const MSG_SELECT = `
  SELECT m.id, m.room_id, m.user_id, u.name AS user_name, u.role::text AS user_role,
         CASE WHEN m.deleted_at IS NULL THEN m.body END AS body,
         m.deleted_at IS NOT NULL AS deleted, m.created_at, m.mentions,
         CASE WHEN m.deleted_at IS NULL THEN m.order_id END AS order_id,
         to_char(o.order_date, 'YYYY-MM-DD') AS order_date, o.order_quantity_m3, c.name AS order_customer, s.name AS order_site, g.name AS order_grade,
         p.id AS photo_id, p.width AS photo_w, p.height AS photo_h, p.bytes AS photo_bytes,
         (p.id IS NOT NULL AND p.data IS NULL) AS photo_expired
    FROM chat_messages m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN customer_orders o ON o.id = m.order_id AND m.deleted_at IS NULL
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN sites s ON s.id = o.site_id
    LEFT JOIN mix_grades g ON g.id = o.mix_grade_id
    LEFT JOIN LATERAL (SELECT id, width, height, bytes, data FROM chat_photos WHERE message_id = m.id AND m.deleted_at IS NULL ORDER BY id LIMIT 1) p ON true`;

function shapeMsg(r) {
  return {
    id: Number(r.id), user_id: r.user_id, user_name: r.user_name || "(removed user)", user_role: r.user_role,
    body: r.body, deleted: r.deleted, created_at: r.created_at,
    order: r.order_id ? {
      id: r.order_id, date: r.order_date, qty: r.order_quantity_m3 != null ? Number(r.order_quantity_m3) : null,
      customer: r.order_customer, site: r.order_site, grade: r.order_grade,
    } : null,
    photo: r.photo_id ? { id: r.photo_id, w: r.photo_w, h: r.photo_h, bytes: r.photo_bytes, expired: r.photo_expired } : null,
  };
}

// Messages: ?after=<id> for the poll (new ones only), ?before=<id> for older
// pages, neither for the latest 50. Also returns every other member's read
// position, so the screen can show "Seen by N" under its own messages.
router.get("/rooms/:id(\\d+)/messages", USE, handle(async (req, res) => {
  const room = await roomFor(req, req.params.id);
  if (!room) return bad(res, "That chat was not found, or you are not in it.", 404);
  markWatching(req.user.id, room.id);
  const after = Number(req.query.after) || 0;
  const before = Number(req.query.before) || 0;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  let rows;
  if (after) {
    ({ rows } = await query(`${MSG_SELECT} WHERE m.room_id = $1 AND m.id > $2 ORDER BY m.id LIMIT 200`, [room.id, after]));
  } else {
    ({ rows } = await query(
      `SELECT * FROM (${MSG_SELECT} WHERE m.room_id = $1 ${before ? "AND m.id < $3" : ""} ORDER BY m.id DESC LIMIT $2) x ORDER BY id`,
      before ? [room.id, limit, before] : [room.id, limit]));
  }
  // Deletions since the screen last looked: the poll carries the ids of the
  // recent messages that are now deleted, so they disappear for everyone.
  const { rows: del } = after
    ? await query(`SELECT id FROM chat_messages WHERE room_id = $1 AND deleted_at > now() - interval '10 minutes'`, [room.id])
    : { rows: [] };
  const { rows: reads } = await query(
    `SELECT user_id, last_read_id FROM chat_reads WHERE room_id = $1 AND user_id <> $2 AND last_read_id > 0`, [room.id, req.user.id]);
  res.json({
    messages: rows.map(shapeMsg),
    deleted_ids: del.map((d) => Number(d.id)),
    reads: reads.map((r) => Number(r.last_read_id)),
    has_more: !after && rows.length === limit,
    poll_open_s: (await settings()).poll_open_s,
  });
}));

router.post("/rooms/:id(\\d+)/read", USE, handle(async (req, res) => {
  const room = await roomFor(req, req.params.id);
  if (!room) return bad(res, "That chat was not found, or you are not in it.", 404);
  const last = Number(req.body?.last_id) || 0;
  await query(
    `INSERT INTO chat_reads (room_id, user_id, last_read_id) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`,
    [room.id, req.user.id, last]);
  res.json({ ok: true });
}));

router.post("/rooms/:id(\\d+)/mute", USE, handle(async (req, res) => {
  const room = await roomFor(req, req.params.id);
  if (!room) return bad(res, "That chat was not found, or you are not in it.", 404);
  const muted = !!req.body?.muted;
  await query(
    `INSERT INTO chat_reads (room_id, user_id, muted, last_read_id)
     VALUES ($1, $2, $3, COALESCE((SELECT last_message_id FROM chat_rooms WHERE id = $1), 0))
     ON CONFLICT (room_id, user_id) DO UPDATE SET muted = EXCLUDED.muted`,
    [room.id, req.user.id, muted]);
  res.json({ ok: true, muted });
}));

// A photo, only to someone in its chat. The screen fetches it with the
// sign-in header and shows it from memory (an <img src> cannot send one).
router.get("/photos/:id(\\d+)", USE, handle(async (req, res) => {
  const { rows } = await query(
    `SELECT p.mime, p.data, m.room_id FROM chat_photos p JOIN chat_messages m ON m.id = p.message_id
      WHERE p.id = $1 AND m.deleted_at IS NULL`, [req.params.id]);
  const p = rows[0];
  if (!p || !(await roomFor(req, p.room_id))) return bad(res, "Photo not found.", 404);
  if (!p.data) return bad(res, "This photo has expired.", 410);
  res.set("Content-Type", p.mime);
  res.set("Cache-Control", "private, max-age=604800");
  res.send(p.data);
}));

// People to start a one-to-one chat with.
router.get("/people", USE, handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const { rows } = await query(
    `SELECT id, name, role::text AS role FROM users
      WHERE is_active AND id <> $1 AND role::text <> 'customer' ${q ? "AND name ILIKE $2" : ""}
      ORDER BY name LIMIT 60`, q ? [req.user.id, `%${q}%`] : [req.user.id]);
  res.json(rows);
}));

// Orders to attach to a message: recent and upcoming, searchable by number,
// customer or site.
router.get("/orders", USE, handle(async (req, res) => {
  const q = String(req.query.q || "").trim().replace(/^orm-?/i, "");
  const params = [];
  let where = `o.order_date >= CURRENT_DATE - 30`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (o.id::text = $1 OR c.name ILIKE $1 OR s.name ILIKE $1)`;
    if (/^\d+$/.test(q)) { params[0] = q; where = `(o.id::text = $1)`; }
  }
  const { rows } = await query(
    `SELECT o.id, to_char(o.order_date, 'YYYY-MM-DD') AS order_date, o.order_quantity_m3, o.status::text AS status, c.name AS customer, s.name AS site, g.name AS grade
       FROM customer_orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN sites s ON s.id = o.site_id
       LEFT JOIN mix_grades g ON g.id = o.mix_grade_id
      WHERE ${where}
      ORDER BY abs(o.order_date - CURRENT_DATE), o.id DESC LIMIT 20`, params);
  res.json(rows);
}));

// ---- writing ---------------------------------------------------------------

router.post("/direct", USE, handle(async (req, res) => {
  if (!(await canSend(req.user))) return bad(res, "You can read Team Chat but not start a chat.", 403);
  const other = Number(req.body?.user_id);
  if (!other || other === req.user.id) return bad(res, "Pick someone to chat with.");
  const { rows: ou } = await query(`SELECT id FROM users WHERE id = $1 AND is_active`, [other]);
  if (!ou.length) return bad(res, "That person is not an active user.");
  const key = [req.user.id, other].sort((a, b) => a - b).join(":");
  const { rows } = await query(
    `INSERT INTO chat_rooms (kind, direct_key, created_by) VALUES ('direct', $1, $2)
     ON CONFLICT (direct_key) DO UPDATE SET archived_at = NULL RETURNING id`, [key, req.user.id]);
  const id = rows[0].id;
  await query(
    `INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES ($1, $2, $4), ($1, $3, $4) ON CONFLICT DO NOTHING`,
    [id, req.user.id, other, req.user.id]);
  res.json({ id });
}));

router.post("/rooms/:id(\\d+)/messages", USE, handle(async (req, res) => {
  const room = await roomFor(req, req.params.id);
  if (!room) return bad(res, "That chat was not found, or you are not in it.", 404);
  if (!(await canSend(req.user))) return bad(res, "You can read Team Chat but not send messages.", 403);
  if (room.post_policy === "admins" && !(await canManage(req.user))) return bad(res, "Only the Administrator posts in this group.", 403);
  const s = await settings();

  const body = String(req.body?.body || "").replace(/\r\n/g, "\n").trim();
  if (body.length > MAX_BODY) return bad(res, `A message can be at most ${MAX_BODY} characters.`);
  const orderId = req.body?.order_id ? Number(req.body.order_id) : null;
  if (orderId) {
    const { rows } = await query(`SELECT 1 FROM customer_orders WHERE id = $1`, [orderId]);
    if (!rows.length) return bad(res, "That order was not found.");
  }
  let photo = null;
  if (req.body?.photo) {
    if (!s.photos_allowed) return bad(res, "Photos are switched off in Team Chat settings.");
    const mime = String(req.body.photo.mime || "");
    if (!PHOTO_TYPES.includes(mime)) return bad(res, "Only JPG, PNG or WebP photos can be sent.");
    const buf = Buffer.from(String(req.body.photo.data || "").replace(/^data:[^,]*,/, ""), "base64");
    if (!buf.length) return bad(res, "The photo could not be read.");
    if (buf.length > MAX_PHOTO_BYTES) return bad(res, "That photo is too large. Try again — the app shrinks it before sending.");
    photo = { mime, buf, w: Number(req.body.photo.width) || null, h: Number(req.body.photo.height) || null };
  }
  if (!body && !photo && !orderId) return bad(res, "Type a message first.");

  const members = await membersOf(room.id);
  // @Name — a mention reaches that person even in a chat they have muted.
  const low = body.toLowerCase();
  const mentions = members.filter((m) => m.id !== req.user.id && low.includes(`@${m.name.toLowerCase()}`)).map((m) => m.id);

  const { rows } = await query(
    `INSERT INTO chat_messages (room_id, user_id, body, order_id, mentions) VALUES ($1, $2, $3, $4, $5::int[]) RETURNING id, created_at`,
    [room.id, req.user.id, body || null, orderId, mentions]);
  const msgId = rows[0].id;
  if (photo) {
    await query(`INSERT INTO chat_photos (message_id, mime, bytes, width, height, data) VALUES ($1, $2, $3, $4, $5, $6)`,
      [msgId, photo.mime, photo.buf.length, photo.w, photo.h, photo.buf]);
  }
  await query(`UPDATE chat_rooms SET last_message_id = $2, last_message_at = $3 WHERE id = $1`, [room.id, msgId, rows[0].created_at]);
  await query(
    `INSERT INTO chat_reads (room_id, user_id, last_read_id) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`,
    [room.id, req.user.id, msgId]);

  const { rows: full } = await query(`${MSG_SELECT} WHERE m.id = $1`, [msgId]);
  res.status(201).json(shapeMsg(full[0]));

  // Phone notifications, after the reply has gone. Not to the sender, not to
  // someone who has the chat open, not to a muted chat (unless mentioned),
  // and at most one every 30 s per person per chat (the phone groups them).
  if (s.push_enabled) {
    notifyMembers({ room, members, sender: req.user, body, photo: !!photo, orderId, mentions })
      .catch((e) => console.error("chat push:", e.message));
  }
}));

async function notifyMembers({ room, members, sender, body, photo, orderId, mentions }) {
  const others = members.filter((m) => m.id !== sender.id);
  if (!others.length) return;
  const { rows: reads } = await query(
    `SELECT user_id, muted, last_push_at FROM chat_reads WHERE room_id = $1 AND user_id = ANY($2::int[])`,
    [room.id, others.map((m) => m.id)]);
  const byUser = Object.fromEntries(reads.map((r) => [r.user_id, r]));
  const text = body ? (body.length > 140 ? `${body.slice(0, 137)}…` : body) : photo ? "Photo" : orderId ? `Order ORM-${orderId}` : "";
  const title = room.kind === "direct" ? sender.name : room.name;
  for (const m of others) {
    const r = byUser[m.id];
    const mentioned = mentions.includes(m.id);
    if (r?.muted && !mentioned) continue;
    if (isWatching(m.id, room.id)) continue;
    if (!mentioned && r?.last_push_at && Date.now() - new Date(r.last_push_at).getTime() < 30_000) continue;
    await query(
      `INSERT INTO chat_reads (room_id, user_id, last_read_id, last_push_at) VALUES ($1, $2, 0, now())
       ON CONFLICT (room_id, user_id) DO UPDATE SET last_push_at = now()`, [room.id, m.id]);
    await pushToUser(m.id, {
      title: mentioned ? `${sender.name} mentioned you · ${title}` : title,
      body: room.kind === "direct" ? text : `${sender.name}: ${text}`,
      url: `/chat?room=${room.id}`,
      tag: `chat-${room.id}`,
    }).catch(() => {});
  }
}

// Delete: your own message within 24 hours, or any message by a Team Chat manager.
router.delete("/messages/:id(\\d+)", USE, handle(async (req, res) => {
  const { rows } = await query(`SELECT id, room_id, user_id, created_at, deleted_at FROM chat_messages WHERE id = $1`, [req.params.id]);
  const m = rows[0];
  if (!m || m.deleted_at || !(await roomFor(req, m.room_id))) return bad(res, "Message not found.", 404);
  const own = m.user_id === req.user.id && Date.now() - new Date(m.created_at).getTime() < 24 * 3600_000;
  if (!own && !(await canManage(req.user))) return bad(res, "You can delete only your own messages, within 24 hours.", 403);
  await query(`UPDATE chat_messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [m.id, req.user.id]);
  await query(`UPDATE chat_photos SET data = NULL, expired_at = now() WHERE message_id = $1`, [m.id]);
  res.json({ ok: true });
}));

// ---- settings and groups (chat.manage) ------------------------------------

const SETTING_LIMITS = {
  poll_open_s: [5, 60], poll_badge_s: [30, 600], photo_keep_days: [7, 3650],
  message_keep_months: [1, 120], warn_mb: [20, 10000],
};

router.get("/admin/settings", MANAGE, handle(async (req, res) => {
  const s = await settings();
  const { rows: u } = await query(
    `SELECT (SELECT COUNT(*) FROM chat_photos WHERE data IS NOT NULL)::int AS photos,
            (SELECT COUNT(*) FROM chat_messages WHERE created_at >= date_trunc('month', now()))::int AS month_messages,
            (SELECT COUNT(*) FROM chat_messages)::int AS all_messages,
            round(pg_database_size(current_database()) / 1048576.0)::int AS db_mb`);
  res.json({ settings: s, usage: { ...u[0], chat_mb: await storageMb() } });
}));

router.put("/admin/settings", MANAGE_EDIT, handle(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  for (const [k, [lo, hi]] of Object.entries(SETTING_LIMITS)) {
    if (b[k] === undefined) continue;
    const v = Math.round(Number(b[k]));
    if (!Number.isFinite(v) || v < lo || v > hi) return bad(res, `${k.replace(/_/g, " ")} must be between ${lo} and ${hi}.`);
    vals.push(v); sets.push(`${k} = $${vals.length}`);
  }
  for (const k of ["push_enabled", "photos_allowed"]) {
    if (b[k] === undefined) continue;
    vals.push(!!b[k]); sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return bad(res, "Nothing to save.");
  vals.push(req.user.id);
  await query(`UPDATE chat_settings SET ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() WHERE id = 1`, vals);
  res.json({ settings: await settings() });
}));

router.get("/admin/groups", MANAGE, handle(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.name, r.member_roles, r.post_policy, r.sort_order, r.archived_at,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'role', u.role::text) ORDER BY u.name)
                        FROM chat_room_members cm JOIN users u ON u.id = cm.user_id WHERE cm.room_id = r.id AND NOT cm.excluded), '[]') AS extra,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'role', u.role::text) ORDER BY u.name)
                        FROM chat_room_members cm JOIN users u ON u.id = cm.user_id WHERE cm.room_id = r.id AND cm.excluded), '[]') AS excluded,
            (SELECT COUNT(*) FROM users u WHERE u.is_active AND ${memberOf("r", "u.id", "u.role::text")})::int AS member_count
       FROM chat_rooms r WHERE r.kind = 'group'
      ORDER BY r.archived_at IS NOT NULL, r.sort_order, r.id`);
  const { rows: roles } = await query(`SELECT unnest(enum_range(NULL::user_role))::text AS role`);
  res.json({ groups: rows, roles: roles.map((r) => r.role).filter((r) => r !== "customer") });
}));

function groupInput(b, res) {
  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) { bad(res, "Give the group a name."); return null; }
  const roles = Array.isArray(b.member_roles) ? [...new Set(b.member_roles.map(String))] : [];
  const post = b.post_policy === "admins" ? "admins" : "all";
  return { name, roles, post };
}

async function setMembers(roomId, b, by) {
  if (!Array.isArray(b.extra_user_ids) && !Array.isArray(b.excluded_user_ids)) return;
  const extra = (b.extra_user_ids || []).map(Number).filter(Boolean);
  const excluded = (b.excluded_user_ids || []).map(Number).filter((id) => id && !extra.includes(id));
  await query(`DELETE FROM chat_room_members WHERE room_id = $1`, [roomId]);
  if (extra.length) {
    await query(`INSERT INTO chat_room_members (room_id, user_id, excluded, added_by) SELECT $1, unnest($2::int[]), false, $3 ON CONFLICT DO NOTHING`, [roomId, extra, by]);
  }
  if (excluded.length) {
    await query(`INSERT INTO chat_room_members (room_id, user_id, excluded, added_by) SELECT $1, unnest($2::int[]), true, $3 ON CONFLICT DO NOTHING`, [roomId, excluded, by]);
  }
}

router.post("/admin/groups", MANAGE_EDIT, handle(async (req, res) => {
  const g = groupInput(req.body || {}, res);
  if (!g) return;
  const { rows: dup } = await query(`SELECT 1 FROM chat_rooms WHERE kind = 'group' AND lower(name) = lower($1) AND archived_at IS NULL`, [g.name]);
  if (dup.length) return bad(res, "A group with that name already exists.");
  const { rows } = await query(
    `INSERT INTO chat_rooms (kind, name, member_roles, post_policy, sort_order, created_by)
     VALUES ('group', $1, $2::text[], $3, COALESCE((SELECT MAX(sort_order) FROM chat_rooms WHERE kind = 'group'), 0) + 10, $4) RETURNING id`,
    [g.name, g.roles, g.post, req.user.id]);
  await setMembers(rows[0].id, req.body, req.user.id);
  res.status(201).json({ id: rows[0].id });
}));

router.put("/admin/groups/:id(\\d+)", MANAGE_EDIT, handle(async (req, res) => {
  const { rows: ex } = await query(`SELECT id FROM chat_rooms WHERE id = $1 AND kind = 'group'`, [req.params.id]);
  if (!ex.length) return bad(res, "Group not found.", 404);
  const b = req.body || {};
  if (b.archived !== undefined && Object.keys(b).length === 1) {
    await query(`UPDATE chat_rooms SET archived_at = CASE WHEN $2 THEN now() END WHERE id = $1`, [req.params.id, !!b.archived]);
    return res.json({ ok: true });
  }
  const g = groupInput(b, res);
  if (!g) return;
  await query(`UPDATE chat_rooms SET name = $2, member_roles = $3::text[], post_policy = $4 WHERE id = $1`, [req.params.id, g.name, g.roles, g.post]);
  await setMembers(Number(req.params.id), b, req.user.id);
  res.json({ ok: true });
}));

export default router;
