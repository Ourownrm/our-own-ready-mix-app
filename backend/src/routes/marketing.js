// Round 269 — the Marketing module (owner, 6 Nov 2026). Mockup:
// claude/marketing-directory-mockup-v1.md (canvas "Marketing directory").
//
//   Directory   firms (merged from the customer master and Sales contacts),
//               contacts at three levels, communication plans, history
//   Due today   plans whose next date has come, and birthdays; log a call
//   Library     posters / videos / technical PDFs / brochures in Google
//               Drive; Admin approves before anything can be sent
//   Send        to a group or one firm: WhatsApp API, WhatsApp from the
//               phone, email — each person gets their own tracking link
//   Tracking    who received, read and opened what
//   Settings    lists, WhatsApp, Google Drive, email (secrets never returned)
//
// Owner's decisions: files in Google Drive; WhatsApp both by API and from the
// phone; Admin chooses who may upload / send (Access control) and approves.
import { Router } from "express";
import crypto from "crypto";
import { query, pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { ensureRound269 } from "../lib/round269Schema.js";
import {
  loadSettings, saveData, saveSecrets, backendBase, mediaPath, driveConnectUrl, stateToken, driveFolderFor,
  driveUploadStream, driveForget, waSendTemplate, waNumber, emailReady, sendEmail, forgetMailer, WA_MEDIA_LIMIT,
} from "../lib/mktServices.js";

const router = Router();
router.use(requireAuth);
router.use(async (req, res, next) => { try { await ensureRound269(); next(); } catch (e) { next(e); } });

const P = (key, action) => requirePermission(key, action);
const txt = (v, n = 200) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
const int = (v) => (v == null || v === "" || !Number.isInteger(Number(v)) ? null : Number(v));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (v) => (DATE.test(String(v || "")) ? String(v) : null);
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function fail(res, err, msg) {
  console.error(err);
  res.status(err.code === "drive_off" ? 409 : 500).json({ error: err.code === "drive_off" ? err.message : msg });
}
function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); } // ist-ok: arithmetic on a YYYY-MM-DD anchored at noon, not "today"
function addMonths(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); } // ist-ok: same

// When a plan is next due after being done on `from`.
export function nextDue(plan, from, festivals = []) {
  const n = Math.max(1, Number(plan.every_n) || 1);
  switch (plan.every_kind) {
    case "days": return addDays(from, n);
    case "weeks": return addDays(from, 7 * n);
    case "months": return addMonths(from, n);
    case "yearly": return addMonths(from, 12);
    case "festival": return (festivals.map((f) => f.date).filter((d) => DATE.test(d) && d > from).sort()[0]) || null;
    default: return null; // once, when_sent
  }
}

// ======================= DIRECTORY =======================
const FIRM_COLS = ["name", "firm_type", "category", "status", "area", "address", "office_phone", "email", "gstin", "notes"];
function firmFields(b) {
  const f = {};
  for (const k of FIRM_COLS) if (b[k] !== undefined) f[k] = txt(b[k], k === "address" || k === "notes" ? 2000 : 200);
  if (f.name) f.name = f.name.toUpperCase().replace(/\s+/g, " ");
  if (f.status && !["customer", "prospect", "inactive"].includes(f.status)) f.status = "prospect";
  if (b.owner_user_id !== undefined) f.owner_user_id = int(b.owner_user_id);
  if (b.customer_id !== undefined) f.customer_id = int(b.customer_id);
  return f;
}

router.get("/meta", P("module.marketing", "view"), async (req, res) => {
  try {
    const { data, secrets } = await loadSettings();
    const { rows: users } = await query(`SELECT id, name, role::text AS role FROM users WHERE is_active AND role::text IN ('administrator','manager','sales_executive') ORDER BY name`);
    const { rows: areas } = await query(`SELECT DISTINCT area FROM mkt_firms WHERE area IS NOT NULL ORDER BY area`);
    res.json({
      firm_types: data.firm_types, categories: data.categories, firm_categories: data.firm_categories, levels: data.levels,
      users, areas: areas.map((a) => a.area), today: istToday(),
      channels: { wa_api: !!(secrets.wa_token && data.wa.phone_number_id && data.wa.templates.link?.name), email: await emailReady(), drive: !!secrets.google_refresh_token },
      can: {
        edit: await can(req.user, "marketing.directory", "edit"), create: await can(req.user, "marketing.directory", "create"),
        upload: await can(req.user, "marketing.library", "create"), approve: await can(req.user, "marketing.approve", "edit"),
        send_group: await can(req.user, "marketing.send-group", "create"), send_own: await can(req.user, "marketing.send-own", "create"),
        tracking: await can(req.user, "marketing.tracking", "view"),
      },
    });
  } catch (err) { fail(res, err, "Could not load the marketing lists."); }
});

router.get("/firms", P("marketing.directory", "view"), async (req, res) => {
  try {
    const params = [], wh = ["true"];
    const add = (sql, v) => { params.push(v); wh.push(sql.replace("$?", `$${params.length}`)); };
    if (txt(req.query.q)) add(`(f.name ILIKE $? OR f.area ILIKE $? OR EXISTS (SELECT 1 FROM mkt_contacts c WHERE c.firm_id = f.id AND c.is_active AND (c.name ILIKE $? OR c.mobile ILIKE $?)))`.replace(/\$\?/g, `$${params.length + 1}`), `%${txt(req.query.q)}%`);
    if (txt(req.query.type)) add(`f.firm_type = $?`, txt(req.query.type));
    if (txt(req.query.status)) add(`f.status = $?`, txt(req.query.status));
    else wh.push(`f.status <> 'inactive'`);
    if (txt(req.query.area)) add(`f.area = $?`, txt(req.query.area));
    if (txt(req.query.category)) add(`EXISTS (SELECT 1 FROM mkt_plans p WHERE p.firm_id = f.id AND p.category = $?)`, txt(req.query.category));
    if (int(req.query.owner)) add(`f.owner_user_id = $?`, int(req.query.owner));
    const { rows } = await query(
      `SELECT f.id, f.name, f.firm_type, f.category, f.status, f.area, f.customer_id, f.owner_user_id, u.name AS owner_name,
              (SELECT json_object_agg(lv, n) FROM (SELECT level AS lv, count(*) AS n FROM mkt_contacts WHERE firm_id = f.id AND is_active GROUP BY level) x) AS contacts,
              (SELECT json_agg(json_build_object('category', p.category, 'every_kind', p.every_kind, 'every_n', p.every_n, 'channels', p.channels, 'next_due', p.next_due, 'paused', p.paused) ORDER BY p.id)
                 FROM mkt_plans p WHERE p.firm_id = f.id) AS plans,
              to_char((SELECT min(next_due) FROM mkt_plans p WHERE p.firm_id = f.id AND NOT p.paused), 'YYYY-MM-DD') AS next_due,
              (SELECT json_build_object('at', l.at, 'category', l.category, 'channel', l.channel) FROM mkt_log l WHERE l.firm_id = f.id ORDER BY l.at DESC LIMIT 1) AS last
         FROM mkt_firms f LEFT JOIN users u ON u.id = f.owner_user_id
        WHERE ${wh.join(" AND ")}
        ORDER BY (SELECT min(next_due) FROM mkt_plans p WHERE p.firm_id = f.id AND NOT p.paused) NULLS LAST, f.name
        LIMIT 1000`, params);
    const today = istToday();
    const { rows: t } = await query(
      `SELECT (SELECT count(*) FROM mkt_firms WHERE status <> 'inactive')::int AS firms,
              (SELECT count(*) FROM mkt_contacts c JOIN mkt_firms f ON f.id = c.firm_id WHERE c.is_active AND f.status <> 'inactive')::int AS contacts,
              (SELECT count(*) FROM mkt_plans WHERE NOT paused AND next_due = $1)::int AS due_today,
              (SELECT count(*) FROM mkt_plans WHERE NOT paused AND next_due < $1)::int AS overdue,
              (SELECT count(*) FROM mkt_firms f WHERE f.status <> 'inactive' AND NOT EXISTS (SELECT 1 FROM mkt_log l WHERE l.firm_id = f.id AND l.at > now() - interval '90 days'))::int AS quiet`, [today]);
    res.json({ firms: rows, tiles: t[0], today });
  } catch (err) { fail(res, err, "Could not load the directory."); }
});

router.get("/firms/:id", P("marketing.directory", "view"), async (req, res) => {
  try {
    const id = int(req.params.id);
    const { rows } = await query(`SELECT f.*, u.name AS owner_name, c.name AS customer_name FROM mkt_firms f
                                   LEFT JOIN users u ON u.id = f.owner_user_id LEFT JOIN customers c ON c.id = f.customer_id WHERE f.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Firm not found." });
    const [contacts, plans, log, received] = await Promise.all([
      query(`SELECT *, to_char(birthday, 'YYYY-MM-DD') AS birthday FROM mkt_contacts WHERE firm_id = $1 AND is_active ORDER BY level, name`, [id]),
      query(`SELECT *, to_char(next_due, 'YYYY-MM-DD') AS next_due, to_char(last_done, 'YYYY-MM-DD') AS last_done FROM mkt_plans WHERE firm_id = $1 ORDER BY paused, mkt_plans.next_due NULLS LAST, id`, [id]),
      query(`SELECT l.*, c.name AS contact_name, u.name AS by_name FROM mkt_log l LEFT JOIN mkt_contacts c ON c.id = l.contact_id
               LEFT JOIN users u ON u.id = l.by_user WHERE l.firm_id = $1 ORDER BY l.at DESC LIMIT 100`, [id]),
      query(`SELECT r.send_id, r.channel, r.status, r.open_count, r.first_open_at, r.read_at, r.sent_at, c.name AS contact_name,
                    (SELECT string_agg(i.title, ', ') FROM mkt_items i WHERE i.id = ANY(s.item_ids)) AS titles
               FROM mkt_recipients r JOIN mkt_sends s ON s.id = r.send_id LEFT JOIN mkt_contacts c ON c.id = r.contact_id
              WHERE r.firm_id = $1 AND r.channel <> 'skipped' ORDER BY r.id DESC LIMIT 100`, [id]),
    ]);
    res.json({ firm: rows[0], contacts: contacts.rows, plans: plans.rows, log: log.rows, received: received.rows });
  } catch (err) { fail(res, err, "Could not load the firm."); }
});

router.post("/firms", P("marketing.directory", "create"), async (req, res) => {
  const f = firmFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: "Enter the firm's name." });
  try {
    const { rows: dup } = await query(`SELECT id FROM mkt_firms WHERE LOWER(name) = LOWER($1)`, [f.name]);
    if (dup.length) return res.status(409).json({ error: "A firm with this name is already in the directory.", id: dup[0].id });
    if (f.owner_user_id === undefined) f.owner_user_id = req.user.id;
    const keys = Object.keys(f);
    const { rows } = await query(
      `INSERT INTO mkt_firms (${keys.join(", ")}, created_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}) RETURNING id`,
      [...keys.map((k) => f[k]), req.user.id]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) { fail(res, err, "Could not add the firm."); }
});

router.patch("/firms/:id", P("marketing.directory", "edit"), async (req, res) => {
  const f = firmFields(req.body || {});
  const keys = Object.keys(f);
  if (!keys.length) return res.json({ ok: true });
  if ("name" in f && !f.name) return res.status(400).json({ error: "The name cannot be empty." });
  try {
    await query(`UPDATE mkt_firms SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [int(req.params.id), ...keys.map((k) => f[k])]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, "Could not save the firm."); }
});

// One-time (repeatable) import from the customer master and Sales contacts.
router.post("/firms/import", P("marketing.directory", "create"), async (req, res) => {
  try {
    const out = { customers: 0, contacts: 0 };
    const { rows: custs } = await query(
      `SELECT c.id, c.name, c.contact_number, c.billing_address FROM customers c
        WHERE COALESCE(c.is_active, true) AND NOT EXISTS (SELECT 1 FROM mkt_firms f WHERE f.customer_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM mkt_firms f WHERE LOWER(f.name) = LOWER(c.name))`);
    for (const c of custs) {
      const { rows } = await query(
        `INSERT INTO mkt_firms (name, status, customer_id, address, office_phone, firm_type, created_by)
         VALUES ($1, 'customer', $2, $3, $4, NULL, $5) RETURNING id`, [String(c.name).toUpperCase(), c.id, c.billing_address, c.contact_number, req.user.id]);
      if (c.contact_number) await query(`INSERT INTO mkt_contacts (firm_id, name, level, mobile) VALUES ($1, $2, 1, $3)`, [rows[0].id, c.name, c.contact_number]);
      out.customers++;
    }
    const TYPE = { client: "Individual house owner", site_engineer: "Engineer", consultant: "Structural consultant", contractor: "Contractor", architect: "Architect", builder: "Builder / developer" };
    const { rows: sc } = await query(
      `SELECT s.id, s.name, s.contact_type, s.organisation, s.phone, s.notes, s.linked_customer_id FROM sales_contacts s
        WHERE s.is_active AND NOT EXISTS (SELECT 1 FROM mkt_contacts m WHERE m.sales_contact_id = s.id)`).catch(() => ({ rows: [] }));
    for (const s of sc) {
      const firmName = String(s.organisation || s.name).toUpperCase().replace(/\s+/g, " ");
      let firmId = null;
      if (s.linked_customer_id) firmId = (await query(`SELECT id FROM mkt_firms WHERE customer_id = $1`, [s.linked_customer_id])).rows[0]?.id;
      if (!firmId) firmId = (await query(`SELECT id FROM mkt_firms WHERE LOWER(name) = LOWER($1)`, [firmName])).rows[0]?.id;
      if (!firmId) {
        firmId = (await query(`INSERT INTO mkt_firms (name, status, firm_type, notes, created_by) VALUES ($1, 'prospect', $2, $3, $4) RETURNING id`,
          [firmName, TYPE[s.contact_type] || null, s.notes, req.user.id])).rows[0].id;
      }
      await query(`INSERT INTO mkt_contacts (firm_id, name, designation, level, mobile, sales_contact_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [firmId, s.name, s.contact_type ? s.contact_type.replace(/_/g, " ") : null, s.contact_type === "site_engineer" ? 3 : 1, s.phone, s.id]);
      out.contacts++;
    }
    res.json({ ok: true, ...out });
  } catch (err) { fail(res, err, "Could not import."); }
});

// ---------------- contacts ----------------
function contactFields(b) {
  const f = {};
  for (const k of ["name", "designation", "mobile", "email"]) if (b[k] !== undefined) f[k] = txt(b[k], k === "email" ? 150 : 150);
  if (b.level !== undefined) f.level = [1, 2, 3].includes(Number(b.level)) ? Number(b.level) : 1;
  if (b.on_whatsapp !== undefined) f.on_whatsapp = !!b.on_whatsapp;
  if (b.prefers !== undefined) f.prefers = ["whatsapp", "email", "phone"].includes(b.prefers) ? b.prefers : "whatsapp";
  if (b.birthday !== undefined) f.birthday = day(b.birthday);
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) f.email = undefined;
  return f;
}
router.post("/firms/:id/contacts", P("marketing.directory", "create"), async (req, res) => {
  const f = contactFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: "Enter the person's name." });
  if (f.email === undefined && req.body.email) return res.status(400).json({ error: "That email address does not look right." });
  const consent = !!req.body.consent;
  try {
    const keys = Object.keys(f).filter((k) => f[k] !== undefined);
    const { rows } = await query(
      `INSERT INTO mkt_contacts (firm_id, ${keys.join(", ")}, consent, consent_at) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}, $${keys.length + 2}, CASE WHEN $${keys.length + 2} THEN now() END) RETURNING id`,
      [int(req.params.id), ...keys.map((k) => f[k]), consent]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) { fail(res, err, "Could not add the person."); }
});
router.patch("/contacts/:id", P("marketing.directory", "edit"), async (req, res) => {
  const b = req.body || {};
  const f = contactFields(b);
  if (f.email === undefined && b.email) return res.status(400).json({ error: "That email address does not look right." });
  const sets = [], vals = [int(req.params.id)];
  for (const [k, v] of Object.entries(f)) { if (v === undefined) continue; vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (b.consent !== undefined) { vals.push(!!b.consent); sets.push(`consent = $${vals.length}, consent_at = CASE WHEN $${vals.length} THEN COALESCE(consent_at, now()) END`); }
  if (b.opted_out !== undefined) sets.push(b.opted_out ? `opted_out_at = COALESCE(opted_out_at, now())` : `opted_out_at = NULL`);
  if (b.firm_id !== undefined && int(b.firm_id)) { vals.push(int(b.firm_id)); sets.push(`firm_id = $${vals.length}`); }
  if (!sets.length) return res.json({ ok: true });
  try {
    await query(`UPDATE mkt_contacts SET ${sets.join(", ")} WHERE id = $1`, vals);
    res.json({ ok: true });
  } catch (err) { fail(res, err, "Could not save the person."); }
});
router.delete("/contacts/:id", P("marketing.directory", "edit"), async (req, res) => {
  try { await query(`UPDATE mkt_contacts SET is_active = false WHERE id = $1`, [int(req.params.id)]); res.json({ ok: true }); }
  catch (err) { fail(res, err, "Could not remove the person."); }
});

// ---------------- plans ----------------
const KINDS = ["once", "days", "weeks", "months", "yearly", "festival", "when_sent"];
const CHANNELS = ["whatsapp", "email", "phone", "visit"];
function planFields(b) {
  const f = {};
  if (b.category !== undefined) f.category = txt(b.category, 60);
  if (b.levels !== undefined) f.levels = [].concat(b.levels).map(Number).filter((n) => [1, 2, 3].includes(n));
  if (b.every_kind !== undefined) f.every_kind = KINDS.includes(b.every_kind) ? b.every_kind : "months";
  if (b.every_n !== undefined) f.every_n = Math.min(Math.max(int(b.every_n) || 1, 1), 365);
  if (b.channels !== undefined) f.channels = [].concat(b.channels).filter((c) => CHANNELS.includes(c));
  if (b.next_due !== undefined) f.next_due = day(b.next_due);
  if (b.paused !== undefined) f.paused = !!b.paused;
  return f;
}
router.post("/firms/:id/plans", P("marketing.directory", "create"), async (req, res) => {
  const f = planFields(req.body || {});
  if (!f.category) return res.status(400).json({ error: "Choose the category." });
  if (!f.levels?.length) f.levels = [1, 2, 3];
  if (!f.channels?.length) f.channels = ["whatsapp"];
  try {
    if (f.next_due === undefined || f.next_due === null) {
      const { data } = await loadSettings();
      f.next_due = f.every_kind === "festival" ? nextDue(f, addDays(istToday(), -1), data.festivals) : f.every_kind === "when_sent" ? null : istToday();
    }
    const keys = Object.keys(f);
    const { rows } = await query(`INSERT INTO mkt_plans (firm_id, ${keys.join(", ")}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
      [int(req.params.id), ...keys.map((k) => f[k])]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) { fail(res, err, "Could not add the plan."); }
});
router.patch("/plans/:id", P("marketing.directory", "edit"), async (req, res) => {
  const f = planFields(req.body || {});
  const keys = Object.keys(f);
  if (!keys.length) return res.json({ ok: true });
  try {
    await query(`UPDATE mkt_plans SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [int(req.params.id), ...keys.map((k) => f[k])]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, "Could not save the plan."); }
});
router.delete("/plans/:id", P("marketing.directory", "edit"), async (req, res) => {
  try { await query(`DELETE FROM mkt_plans WHERE id = $1`, [int(req.params.id)]); res.json({ ok: true }); }
  catch (err) { fail(res, err, "Could not remove the plan."); }
});

// ---------------- due today + log ----------------
router.get("/due", P("marketing.directory", "view"), async (req, res) => {
  try {
    const today = istToday();
    const mine = req.query.mine === "1";
    const { rows: plans } = await query(
      `SELECT p.*, to_char(p.next_due, 'YYYY-MM-DD') AS next_due, to_char(p.last_done, 'YYYY-MM-DD') AS last_done, f.name AS firm_name, f.owner_user_id, u.name AS owner_name,
              (SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'designation', c.designation, 'level', c.level, 'mobile', c.mobile,
                                                 'email', c.email, 'on_whatsapp', c.on_whatsapp, 'prefers', c.prefers) ORDER BY c.level, c.name)
                 FROM mkt_contacts c WHERE c.firm_id = f.id AND c.is_active AND c.level = ANY(p.levels)) AS contacts,
              (SELECT json_build_object('at', l.at, 'note', l.note, 'outcome', l.outcome) FROM mkt_log l WHERE l.firm_id = f.id ORDER BY l.at DESC LIMIT 1) AS last
         FROM mkt_plans p JOIN mkt_firms f ON f.id = p.firm_id LEFT JOIN users u ON u.id = f.owner_user_id
        WHERE NOT p.paused AND p.next_due <= $1 AND f.status <> 'inactive' AND ($2::int IS NULL OR f.owner_user_id = $2)
        ORDER BY p.next_due, f.name`, [today, mine ? req.user.id : null]);
    const { rows: birthdays } = await query(
      `SELECT c.id, c.name, c.designation, c.mobile, c.on_whatsapp, c.level, f.id AS firm_id, f.name AS firm_name
         FROM mkt_contacts c JOIN mkt_firms f ON f.id = c.firm_id
        WHERE c.is_active AND c.birthday IS NOT NULL AND f.status <> 'inactive'
          AND to_char(c.birthday, 'MM-DD') = to_char($1::date, 'MM-DD') AND ($2::int IS NULL OR f.owner_user_id = $2)`, [today, mine ? req.user.id : null]);
    res.json({ today, plans, birthdays });
  } catch (err) { fail(res, err, "Could not load what is due."); }
});

router.post("/firms/:id/log", P("marketing.directory", "create"), async (req, res) => {
  const b = req.body || {};
  const firmId = int(req.params.id);
  const outcome = ["spoke", "no_answer", "call_back", "not_interested", "sent", "visited", "note"].includes(b.outcome) ? b.outcome : "note";
  const channel = ["whatsapp", "email", "phone", "visit"].includes(b.channel) ? b.channel : null;
  try {
    const { data } = await loadSettings();
    const today = istToday();
    let plan = null;
    if (int(b.plan_id)) plan = (await query(`SELECT * FROM mkt_plans WHERE id = $1 AND firm_id = $2`, [int(b.plan_id), firmId])).rows[0] || null;
    await query(`INSERT INTO mkt_log (firm_id, contact_id, plan_id, category, channel, outcome, note, by_user) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [firmId, int(b.contact_id), plan?.id || null, plan?.category || txt(b.category, 60), channel, outcome, txt(b.note, 2000), req.user.id]);
    let next = null;
    if (plan) {
      if (outcome === "not_interested") {
        await query(`UPDATE mkt_plans SET paused = true, last_done = $2 WHERE id = $1`, [plan.id, today]);
      } else if (outcome === "no_answer" && !day(b.next_due)) {
        next = addDays(today, 1);
        await query(`UPDATE mkt_plans SET next_due = $2 WHERE id = $1`, [plan.id, next]);
      } else {
        next = day(b.next_due) || nextDue(plan, today, data.festivals);
        await query(`UPDATE mkt_plans SET last_done = $2, next_due = $3, paused = CASE WHEN $3::date IS NULL AND every_kind = 'once' THEN true ELSE paused END WHERE id = $1`, [plan.id, today, next]);
      }
    }
    res.json({ ok: true, next_due: next });
  } catch (err) { fail(res, err, "Could not save."); }
});

// ======================= LIBRARY =======================
const ITEM_SELECT = `
  SELECT i.*, to_char(i.valid_until, 'YYYY-MM-DD') AS valid_until, u.name AS uploaded_by_name, d.name AS decided_by_name,
         (SELECT count(*) FROM mkt_recipients r JOIN mkt_sends s ON s.id = r.send_id WHERE i.id = ANY(s.item_ids) AND r.channel <> 'skipped' AND r.status <> 'queued')::int AS sent_n,
         (SELECT count(*) FROM mkt_recipients r JOIN mkt_sends s ON s.id = r.send_id WHERE i.id = ANY(s.item_ids) AND r.open_count > 0)::int AS opened_n
    FROM mkt_items i LEFT JOIN users u ON u.id = i.uploaded_by LEFT JOIN users d ON d.id = i.decided_by`;

router.get("/items", P("marketing.library", "view"), async (req, res) => {
  try {
    const st = ["pending", "approved", "sent_back", "retired"].includes(req.query.status) ? req.query.status : null;
    const { rows } = await query(`${ITEM_SELECT} WHERE ($1::text IS NULL OR i.status = $1) ORDER BY (i.status = 'pending') DESC, i.uploaded_at DESC LIMIT 500`, [st]);
    const today = istToday();
    res.json({
      items: rows.map((r) => ({ ...r, preview: mediaPath(r.id, 6) })),
      tiles: {
        approved: rows.filter((r) => r.status === "approved").length,
        pending: rows.filter((r) => r.status === "pending").length,
        expiring: rows.filter((r) => r.status === "approved" && r.valid_until && r.valid_until <= addDays(today, 7)).length,
        bytes: rows.filter((r) => r.status !== "retired").reduce((t, r) => t + Number(r.size_bytes || 0), 0),
      },
    });
  } catch (err) { fail(res, err, "Could not load the library."); }
});

const KIND_OK = ["poster", "video", "pdf", "brochure"];
const MAX_UPLOAD = 100 * 1024 * 1024;
// The file is the raw request body (not JSON) so a big video streams through
// to Drive; the details come in the query string.
router.post("/items/upload", P("marketing.library", "create"), async (req, res) => {
  const q = req.query;
  const size = Number(req.get("content-length"));
  const mime = (req.get("content-type") || "application/octet-stream").split(";")[0];
  const kind = KIND_OK.includes(q.kind) ? q.kind : null;
  const title = txt(q.title, 200);
  if (!kind || !title) return res.status(400).json({ error: "Give a title and choose the kind." });
  if (!(size > 0)) return res.status(400).json({ error: "The file is empty." });
  if (size > MAX_UPLOAD) return res.status(413).json({ error: "Files up to 100 MB only." });
  const okMime = kind === "poster" ? /^image\// : kind === "video" ? /^video\// : /^(application\/pdf|image\/)/;
  if (!okMime.test(mime)) return res.status(400).json({ error: kind === "video" ? "Choose a video file." : kind === "poster" ? "Choose an image file." : "Choose a PDF file." });
  try {
    const name = txt(q.file_name, 200) || `${title}`;
    const folderId = await driveFolderFor(kind);
    const up = await driveUploadStream(req, { name, mime, size, folderId });
    const prev = int(q.previous_id);
    let version = 1;
    if (prev) version = ((await query(`SELECT version FROM mkt_items WHERE id = $1`, [prev])).rows[0]?.version || 0) + 1;
    const { rows } = await query(
      `INSERT INTO mkt_items (title, kind, topic, language, valid_until, version, previous_id, drive_file_id, file_name, mime, size_bytes, notes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [title, kind, txt(q.topic, 120), txt(q.language, 30), day(q.valid_until), version, prev, up.id, name, mime, size, txt(q.notes, 1000), req.user.id]);
    await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ('administrator', 'marketing_approval', $1)`,
      [`Marketing: "${title}" (${kind}) is waiting for your approval in Marketing › Library.`]).catch(() => {});
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    req.resume();
    fail(res, err, "Could not upload the file to Google Drive.");
  }
});

router.patch("/items/:id", P("marketing.library", "create"), async (req, res) => {
  const b = req.body || {};
  const f = {};
  if (b.title !== undefined) f.title = txt(b.title, 200);
  if (b.topic !== undefined) f.topic = txt(b.topic, 120);
  if (b.language !== undefined) f.language = txt(b.language, 30);
  if (b.valid_until !== undefined) f.valid_until = day(b.valid_until);
  if (b.notes !== undefined) f.notes = txt(b.notes, 1000);
  const keys = Object.keys(f);
  if (!keys.length) return res.json({ ok: true });
  try {
    // A change to approved material goes back for approval.
    await query(`UPDATE mkt_items SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                   status = CASE WHEN status IN ('approved','sent_back') THEN 'pending' ELSE status END WHERE id = $1 AND status <> 'retired'`,
      [int(req.params.id), ...keys.map((k) => f[k])]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, "Could not save."); }
});

router.post("/items/:id/decide", P("marketing.approve", "edit"), async (req, res) => {
  const action = req.body?.action;
  const note = txt(req.body?.note, 1000);
  if (!["approve", "send_back", "retire"].includes(action)) return res.status(400).json({ error: "Approve, send back or retire." });
  if (action === "send_back" && !note) return res.status(400).json({ error: "Say what needs changing." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM mkt_items WHERE id = $1 FOR UPDATE`, [int(req.params.id)]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found." }); }
    const it = rows[0];
    const status = action === "approve" ? "approved" : action === "retire" ? "retired" : "sent_back";
    if (action !== "retire" && it.status !== "pending") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Only material waiting for approval can be decided." }); }
    await client.query(`UPDATE mkt_items SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [it.id, status, req.user.id, note]);
    // A new version, once approved, retires the one it replaces.
    if (action === "approve" && it.previous_id) await client.query(`UPDATE mkt_items SET status = 'retired' WHERE id = $1 AND status = 'approved'`, [it.previous_id]);
    await client.query("COMMIT");
    if (it.uploaded_by && it.uploaded_by !== req.user.id) {
      await query(`INSERT INTO notifications (recipient_id, recipient_role, type, message) VALUES ($1, (SELECT role FROM users WHERE id = $1), 'marketing_decision', $2)`,
        [it.uploaded_by, `Marketing: "${it.title}" was ${status === "approved" ? "approved" : status === "retired" ? "retired" : `sent back — ${note}`}.`]).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    fail(res, err, "Could not save the decision.");
  } finally { client.release(); }
});

// ======================= SENDING =======================
function token() { return crypto.randomBytes(9).toString("base64url"); }
function linkFor(origin, tok) { return `${(origin || "").replace(/\/$/, "")}/m/${tok}`; }

// Who would get a send: contacts of the chosen firms at the chosen levels,
// with the channel each one gets, or the reason they are left out.
async function resolveRecipients(b, settings, userId) {
  const levels = [].concat(b.levels || [1, 2, 3]).map(Number).filter((n) => [1, 2, 3].includes(n));
  const channels = [].concat(b.channels || []).filter((c) => ["wa_api", "wa_phone", "email"].includes(c));
  const params = [levels];
  const wh = ["c.is_active", "f.status <> 'inactive'", "c.level = ANY($1::int[])"];
  const add = (sql, v) => { params.push(v); wh.push(sql.replace(/\$\?/g, `$${params.length}`)); };
  const firmIds = [].concat(b.firm_ids || []).map(int).filter(Boolean);
  const contactIds = [].concat(b.contact_ids || []).map(int).filter(Boolean);
  if (contactIds.length) add(`c.id = ANY($?::int[])`, contactIds);
  else if (firmIds.length) add(`f.id = ANY($?::int[])`, firmIds);
  else {
    if (b.filter?.plan_category) add(`EXISTS (SELECT 1 FROM mkt_plans p WHERE p.firm_id = f.id AND p.category = $? AND NOT p.paused)`, b.filter.plan_category);
    if (b.filter?.status) add(`f.status = $?`, b.filter.status);
    if ([].concat(b.filter?.types || []).length) add(`f.firm_type = ANY($?::text[])`, [].concat(b.filter.types));
    if ([].concat(b.filter?.areas || []).length) add(`f.area = ANY($?::text[])`, [].concat(b.filter.areas));
    if (b.filter?.mine) add(`f.owner_user_id = $?`, userId);
  }
  const { rows } = await query(
    `SELECT c.*, f.name AS firm_name,
            (SELECT max(r.sent_at) FROM mkt_recipients r WHERE r.contact_id = c.id AND r.sent_at IS NOT NULL) AS last_sent
       FROM mkt_contacts c JOIN mkt_firms f ON f.id = c.firm_id WHERE ${wh.join(" AND ")} ORDER BY f.name, c.level, c.name LIMIT 5000`, params);
  const minDays = Number(settings.min_days_between) || 0;
  const out = [];
  for (const c of rows) {
    const base = { contact_id: c.id, firm_id: c.firm_id, firm_name: c.firm_name, name: c.name, level: c.level, mobile: c.mobile, email: c.email };
    const skip = (reason) => out.push({ ...base, channel: "skipped", reason });
    if (c.opted_out_at) { skip("asked not to be sent these"); continue; }
    if (settings.require_consent && !c.consent) { skip("no consent recorded"); continue; }
    if (minDays && c.last_sent && Date.now() - new Date(c.last_sent).getTime() < minDays * 86400000) { skip(`sent something in the last ${minDays} days`); continue; }
    const wa = waNumber(c.mobile) && c.on_whatsapp;
    let picks = [];
    if (b.preferred_only) {
      if (c.prefers === "email" && c.email && channels.includes("email")) picks = ["email"];
      else if (wa && channels.includes("wa_api")) picks = ["wa_api"];
      else if (wa && channels.includes("wa_phone")) picks = ["wa_phone"];
      else if (c.email && channels.includes("email")) picks = ["email"];
    } else {
      if (wa && channels.includes("wa_api")) picks.push("wa_api");
      else if (wa && channels.includes("wa_phone")) picks.push("wa_phone");
      if (c.email && channels.includes("email")) picks.push("email");
    }
    if (!picks.length) { skip(!wa && !c.email ? "no WhatsApp number or email" : "no contact detail for the chosen ways"); continue; }
    for (const ch of picks) out.push({ ...base, channel: ch });
  }
  return out;
}

async function checkSendRights(req, b) {
  const group = await can(req.user, "marketing.send-group", "create");
  if (group) return null;
  const own = await can(req.user, "marketing.send-own", "create");
  if (!own) return "You are not allowed to send marketing material.";
  const firmIds = [].concat(b.firm_ids || []).map(int).filter(Boolean);
  if ((b.contact_ids || []).length === 0 && firmIds.length !== 1) return "You can send to one firm at a time.";
  if ([].concat(b.channels || []).some((c) => c !== "wa_phone" && c !== "email")) return "You can send from your phone only (WhatsApp or email).";
  return null;
}

router.post("/sends/preview", P("module.marketing", "view"), async (req, res) => {
  try {
    const why = await checkSendRights(req, req.body || {});
    if (why) return res.status(403).json({ error: why });
    const { data } = await loadSettings();
    const list = await resolveRecipients(req.body || {}, data, req.user.id);
    res.json({ recipients: list, firms: new Set(list.filter((r) => r.channel !== "skipped").map((r) => r.firm_id)).size });
  } catch (err) { fail(res, err, "Could not work out who gets it."); }
});

async function processQueue(sendId, origin, apiBase) {
  const { rows: s } = await query(`SELECT * FROM mkt_sends WHERE id = $1`, [sendId]);
  if (!s.length) return;
  const send = s[0];
  const { rows: items } = await query(`SELECT * FROM mkt_items WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`, [send.item_ids]);
  const first = items[0] || null;
  const title = items.map((i) => i.title).join(", ") || send.category || "Our Own Ready Mix";
  const { rows: recips } = await query(
    `SELECT r.*, c.name, c.mobile, c.email FROM mkt_recipients r LEFT JOIN mkt_contacts c ON c.id = r.contact_id
      WHERE r.send_id = $1 AND r.status = 'queued' AND r.channel IN ('wa_api','email')`, [sendId]);
  const smtp = await emailReady();
  for (const r of recips) {
    try {
      if (r.channel === "wa_api") {
        const id = await waSendTemplate({
          to: waNumber(r.mobile), item: first, name: r.name, title, token: r.token,
          mediaUrl: first && Number(first.size_bytes) <= (WA_MEDIA_LIMIT[first.kind] || 0) ? `${apiBase}${mediaPath(first.id, 72)}` : null,
        });
        await query(`UPDATE mkt_recipients SET status = 'sent', wa_message_id = $2, sent_at = now() WHERE id = $1`, [r.id, id]);
      } else if (r.channel === "email" && smtp) {
        const link = linkFor(origin, r.token);
        const msg = String(send.message || "").replace(/\{name\}/g, r.name || "").replace(/\{firm\}/g, "");
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#22262B;line-height:1.5">${msg.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch])).replace(/\n/g, "<br>")}
          <p><a href="${link}" style="display:inline-block;background:#C75B12;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open: ${title.replace(/[<>&]/g, "")}</a></p>
          <p style="font-size:11px;color:#5B6470">Our Own Ready Mix, Kasaragod · <a href="${link}?stop=1" style="color:#5B6470">Don't send me these</a></p></div>`;
        await sendEmail({ to: r.email, subject: title, html, text: `${msg}\n\n${link}` });
        await query(`UPDATE mkt_recipients SET status = 'sent', sent_at = now() WHERE id = $1`, [r.id]);
      }
    } catch (e) {
      await query(`UPDATE mkt_recipients SET status = 'failed', error = $2 WHERE id = $1`, [r.id, String(e.message).slice(0, 500)]);
    }
    await new Promise((ok) => setTimeout(ok, 120));
  }
}

router.post("/sends", P("module.marketing", "view"), async (req, res) => {
  const b = req.body || {};
  const why = await checkSendRights(req, b).catch(() => "Could not check your access.");
  if (why) return res.status(403).json({ error: why });
  const message = txt(b.message, 4000);
  const itemIds = [].concat(b.item_ids || []).map(int).filter(Boolean);
  if (!message) return res.status(400).json({ error: "Write the message." });
  try {
    const { data } = await loadSettings();
    if (itemIds.length) {
      const { rows } = await query(`SELECT id, status, title, valid_until FROM mkt_items WHERE id = ANY($1::int[])`, [itemIds]);
      const bad = rows.find((r) => r.status !== "approved");
      if (bad || rows.length !== itemIds.length) return res.status(400).json({ error: `"${bad?.title || "An item"}" is not approved — only approved material can be sent.` });
    }
    const origin = txt(b.app_origin, 200) || data.public_origin;
    if (origin && origin !== data.public_origin) await saveData({ public_origin: origin }, req.user.id);
    const list = await resolveRecipients(b, data, req.user.id);
    const live = list.filter((r) => r.channel !== "skipped");
    if (!live.length) return res.status(400).json({ error: "Nobody to send to with the choices made.", recipients: list });
    const smtp = await emailReady();
    const client = await pool.connect();
    let sendId;
    try {
      await client.query("BEGIN");
      const firmIds = [...new Set(live.map((r) => r.firm_id))];
      sendId = (await client.query(`INSERT INTO mkt_sends (category, item_ids, message, channels, firm_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [txt(b.category, 60), itemIds, message, [].concat(b.channels || []), firmIds.length === 1 ? firmIds[0] : null, req.user.id])).rows[0].id;
      for (const r of list) {
        // Email with no mail server set up is sent from the person's own mail app, like WhatsApp from the phone.
        const ch = r.channel;
        await client.query(`INSERT INTO mkt_recipients (send_id, firm_id, contact_id, channel, token, status, skip_reason, sent_by)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [sendId, r.firm_id, r.contact_id, ch, token(), ch === "skipped" ? "skipped" : "queued", r.reason || (ch === "email" && !smtp ? "manual" : null), req.user.id]);
      }
      for (const fid of firmIds) {
        await client.query(`INSERT INTO mkt_log (firm_id, send_id, category, channel, outcome, note, by_user) VALUES ($1, $2, $3, $4, 'sent', $5, $6)`,
          [fid, sendId, txt(b.category, 60), live.find((r) => r.firm_id === fid).channel.startsWith("wa") ? "whatsapp" : "email", txt(b.note, 300), req.user.id]);
      }
      // Plans "when sent" in this category count as done today.
      if (txt(b.category, 60)) await client.query(`UPDATE mkt_plans SET last_done = $3 WHERE firm_id = ANY($1::int[]) AND category = $2`, [firmIds, txt(b.category, 60), istToday()]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
    const apiBase = backendBase(req);
    processQueue(sendId, origin, apiBase).catch((e) => console.error("marketing send queue:", e));
    res.status(201).json({ ok: true, id: sendId });
  } catch (err) { fail(res, err, "Could not send."); }
});

// One send, with each person (and the links for phone / manual email sending).
router.get("/sends/:id", P("module.marketing", "view"), async (req, res) => {
  try {
    const id = int(req.params.id);
    const { rows } = await query(`SELECT s.*, u.name AS by_name FROM mkt_sends s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Not found." });
    const send = rows[0];
    if (send.created_by !== req.user.id && !(await can(req.user, "marketing.tracking", "view"))) return res.status(403).json({ error: "Not allowed." });
    const { data } = await loadSettings();
    const { rows: items } = await query(`SELECT id, title, kind FROM mkt_items WHERE id = ANY($1::int[])`, [send.item_ids]);
    const { rows: rec } = await query(
      `SELECT r.*, c.name, c.mobile, c.email, c.level, f.name AS firm_name FROM mkt_recipients r
         LEFT JOIN mkt_contacts c ON c.id = r.contact_id LEFT JOIN mkt_firms f ON f.id = r.firm_id WHERE r.send_id = $1 ORDER BY f.name, c.level`, [id]);
    const origin = data.public_origin || "";
    res.json({
      send, items,
      recipients: rec.map((r) => {
        const link = linkFor(origin, r.token);
        const text = `${String(send.message).replace(/\{name\}/g, r.name || "")}\n\n${link}`;
        return {
          ...r, link,
          open_url: r.channel === "wa_phone" ? `https://wa.me/${waNumber(r.mobile)}?text=${encodeURIComponent(text)}`
            : r.channel === "email" && r.skip_reason === "manual" ? `mailto:${encodeURIComponent(r.email || "")}?subject=${encodeURIComponent(items.map((i) => i.title).join(", ") || send.category || "Our Own Ready Mix")}&body=${encodeURIComponent(text)}` : null,
        };
      }),
    });
  } catch (err) { fail(res, err, "Could not load the send."); }
});

// The person tapped Send in WhatsApp / their mail app.
router.post("/recipients/:id/sent", P("module.marketing", "view"), async (req, res) => {
  try {
    const { rowCount } = await query(`UPDATE mkt_recipients SET status = 'sent', sent_at = now(), sent_by = $2
                                       WHERE id = $1 AND status = 'queued' AND channel IN ('wa_phone','email')`, [int(req.params.id), req.user.id]);
    res.json({ ok: true, changed: rowCount });
  } catch (err) { fail(res, err, "Could not mark it sent."); }
});

// ======================= TRACKING =======================
router.get("/sends", P("marketing.tracking", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.category, s.created_at, s.channels, u.name AS by_name, f.name AS firm_name,
              (SELECT string_agg(i.title, ', ') FROM mkt_items i WHERE i.id = ANY(s.item_ids)) AS titles,
              count(r.*) FILTER (WHERE r.channel <> 'skipped')::int AS people,
              count(r.*) FILTER (WHERE r.status IN ('sent','delivered','read'))::int AS sent,
              count(r.*) FILTER (WHERE r.status IN ('delivered','read'))::int AS delivered,
              count(r.*) FILTER (WHERE r.status = 'read')::int AS read,
              count(r.*) FILTER (WHERE r.open_count > 0)::int AS opened,
              count(r.*) FILTER (WHERE r.status = 'failed')::int AS failed,
              count(r.*) FILTER (WHERE r.status = 'queued')::int AS queued,
              count(r.*) FILTER (WHERE r.channel = 'skipped')::int AS skipped
         FROM mkt_sends s LEFT JOIN users u ON u.id = s.created_by LEFT JOIN mkt_firms f ON f.id = s.firm_id
         LEFT JOIN mkt_recipients r ON r.send_id = s.id
        GROUP BY s.id, u.name, f.name ORDER BY s.id DESC LIMIT 300`);
    res.json(rows);
  } catch (err) { fail(res, err, "Could not load the sends."); }
});

router.get("/items/:id/tracking", P("marketing.tracking", "view"), async (req, res) => {
  try {
    const id = int(req.params.id);
    const { rows: it } = await query(`SELECT id, title, kind, version, status FROM mkt_items WHERE id = $1`, [id]);
    if (!it.length) return res.status(404).json({ error: "Not found." });
    const { rows } = await query(
      `SELECT r.id, r.send_id, r.channel, r.status, r.error, r.sent_at, r.delivered_at, r.read_at, r.first_open_at, r.last_open_at,
              r.open_count, r.download_count, r.play_end_count, r.contact_id, r.firm_id, c.name, c.level, f.name AS firm_name, u.name AS sent_by_name,
              (SELECT 1 FROM mkt_events e WHERE e.recipient_id = r.id AND e.kind = 'opt_out' LIMIT 1) IS NOT NULL AS opted_out
         FROM mkt_recipients r JOIN mkt_sends s ON s.id = r.send_id
         LEFT JOIN mkt_contacts c ON c.id = r.contact_id LEFT JOIN mkt_firms f ON f.id = r.firm_id LEFT JOIN users u ON u.id = r.sent_by
        WHERE $1 = ANY(s.item_ids) AND r.channel <> 'skipped' ORDER BY r.sent_at DESC NULLS LAST`, [id]);
    const sent = rows.filter((r) => ["sent", "delivered", "read"].includes(r.status));
    const api = rows.filter((r) => r.channel === "wa_api");
    const notOpened = sent.filter((r) => !r.open_count && r.sent_at && Date.now() - new Date(r.sent_at).getTime() > 3 * 86400000);
    res.json({
      item: it[0], recipients: rows,
      tiles: {
        sent: sent.length, firms: new Set(sent.map((r) => r.firm_id)).size,
        api_delivered: api.filter((r) => ["delivered", "read"].includes(r.status)).length, api_total: api.length,
        opened: rows.filter((r) => r.open_count > 0).length, not_opened_3d: notOpened.length,
        opted_out: rows.filter((r) => r.opted_out).length,
      },
    });
  } catch (err) { fail(res, err, "Could not load the tracking."); }
});

// Openers → a "Follow-up call" due today on their firm.
router.post("/items/:id/followups", P("marketing.directory", "create"), async (req, res) => {
  try {
    const id = int(req.params.id);
    const { rows } = await query(
      `SELECT DISTINCT r.firm_id, c.level FROM mkt_recipients r JOIN mkt_sends s ON s.id = r.send_id JOIN mkt_contacts c ON c.id = r.contact_id
        WHERE $1 = ANY(s.item_ids) AND r.open_count > 0 AND r.firm_id IS NOT NULL`, [id]);
    const today = istToday();
    let n = 0;
    for (const r of rows) {
      const { rowCount } = await query(
        `INSERT INTO mkt_plans (firm_id, category, levels, every_kind, every_n, channels, next_due)
         SELECT $1, 'Follow-up call', ARRAY[$2]::smallint[], 'once', 1, '{phone}', $3
          WHERE NOT EXISTS (SELECT 1 FROM mkt_plans WHERE firm_id = $1 AND category = 'Follow-up call' AND NOT paused AND next_due <= $3)`, [r.firm_id, r.level, today]);
      n += rowCount;
    }
    res.json({ ok: true, added: n });
  } catch (err) { fail(res, err, "Could not add the follow-ups."); }
});

// ======================= SETTINGS =======================
router.get("/settings", P("marketing.settings", "view"), async (req, res) => {
  try {
    const { data, secrets } = await loadSettings();
    let verify = secrets.wa_verify_token;
    if (!verify) { verify = crypto.randomBytes(12).toString("hex"); await saveSecrets({ wa_verify_token: verify }); }
    const base = backendBase(req);
    const { rows: usage } = await query(
      `SELECT count(*) FILTER (WHERE channel = 'wa_api' AND sent_at >= date_trunc('month', now()))::int AS wa_month,
              count(*) FILTER (WHERE channel = 'email' AND sent_at >= date_trunc('month', now()))::int AS email_month FROM mkt_recipients`);
    res.json({
      data,
      secrets: {
        wa_token: !!secrets.wa_token, wa_app_secret: !!secrets.wa_app_secret, wa_verify_token: verify,
        google_client_id: secrets.google_client_id || "", google_client_secret: !!secrets.google_client_secret, drive_connected: !!secrets.google_refresh_token,
        smtp: { host: secrets.smtp?.host || "", port: secrets.smtp?.port || 465, user: secrets.smtp?.user || "", pass: !!secrets.smtp?.pass },
      },
      urls: { drive_redirect: `${base}/api/marketing-public/drive/callback`, wa_webhook: `${base}/api/marketing-public/wa-webhook`, link_base: data.public_origin ? `${data.public_origin}/m/` : null },
      usage: usage[0],
    });
  } catch (err) { fail(res, err, "Could not load the settings."); }
});

router.put("/settings", P("marketing.settings", "edit"), async (req, res) => {
  const b = req.body || {};
  try {
    const { data } = await loadSettings();
    const patch = {};
    const list = (v) => [].concat(v || []).map((x) => txt(x, 80)).filter(Boolean).slice(0, 60);
    if (b.firm_types !== undefined) patch.firm_types = list(b.firm_types);
    if (b.categories !== undefined) patch.categories = list(b.categories);
    if (b.firm_categories !== undefined) patch.firm_categories = list(b.firm_categories);
    if (b.levels !== undefined) patch.levels = { 1: txt(b.levels[1], 40) || "Level 1", 2: txt(b.levels[2], 40) || "Level 2", 3: txt(b.levels[3], 40) || "Level 3" };
    if (b.festivals !== undefined) patch.festivals = [].concat(b.festivals || []).filter((f) => txt(f?.name, 60) && day(f?.date)).map((f) => ({ name: txt(f.name, 60), date: day(f.date) })).slice(0, 60);
    if (b.require_consent !== undefined) patch.require_consent = !!b.require_consent;
    if (b.min_days_between !== undefined) patch.min_days_between = Math.min(Math.max(int(b.min_days_between) || 0, 0), 90);
    if (b.public_origin !== undefined) patch.public_origin = txt(b.public_origin, 200);
    if (b.wa !== undefined) {
      const t = b.wa.templates || {};
      const tpl = (k) => ({ name: txt(t[k]?.name, 120) || "", lang: txt(t[k]?.lang, 10) || "en" });
      patch.wa = { phone_number_id: txt(b.wa.phone_number_id, 40) || "", waba_id: txt(b.wa.waba_id, 40) || "", api_version: txt(b.wa.api_version, 10) || "v21.0",
        templates: { link: tpl("link"), poster: tpl("poster"), video: tpl("video"), pdf: tpl("pdf"), brochure: tpl("brochure") } };
    }
    if (b.email !== undefined) patch.email = { from_name: txt(b.email.from_name, 80) || "Our Own Ready Mix", from_email: txt(b.email.from_email, 150) || "" };
    if (Object.keys(patch).length) await saveData(patch, req.user.id);
    const sp = {};
    if (txt(b.wa_token, 1000)) sp.wa_token = txt(b.wa_token, 1000);
    if (txt(b.wa_app_secret, 200)) sp.wa_app_secret = txt(b.wa_app_secret, 200);
    if (b.google_client_id !== undefined) sp.google_client_id = txt(b.google_client_id, 200) || "";
    if (txt(b.google_client_secret, 200)) sp.google_client_secret = txt(b.google_client_secret, 200);
    if (b.smtp) {
      const { secrets } = await loadSettings();
      sp.smtp = { host: txt(b.smtp.host, 120) || "", port: int(b.smtp.port) || 465, user: txt(b.smtp.user, 150) || "", pass: txt(b.smtp.pass, 200) || secrets.smtp?.pass || "" };
      forgetMailer();
    }
    if (b.drive_disconnect) { sp.google_refresh_token = null; driveForget(); patch.drive = { ...data.drive, account: null }; await saveData({ drive: patch.drive }, req.user.id); }
    if (Object.keys(sp).length) await saveSecrets(sp);
    res.json({ ok: true });
  } catch (err) { fail(res, err, "Could not save the settings."); }
});

router.post("/settings/drive-connect", P("marketing.settings", "edit"), async (req, res) => {
  try {
    const { secrets } = await loadSettings();
    if (!secrets.google_client_id || !secrets.google_client_secret) return res.status(400).json({ error: "Enter the Google client ID and secret first, and save." });
    const back = txt(req.body?.app_origin, 200);
    const url = driveConnectUrl(secrets.google_client_id, `${backendBase(req)}/api/marketing-public/drive/callback`, stateToken({ u: req.user.id, back }));
    res.json({ url });
  } catch (err) { fail(res, err, "Could not start the Google connection."); }
});

router.post("/settings/wa-test", P("marketing.settings", "edit"), async (req, res) => {
  const to = waNumber(req.body?.to);
  if (!to) return res.status(400).json({ error: "Enter a mobile number." });
  try {
    const id = await waSendTemplate({ to, item: null, name: req.user.name, title: "Test from the app", token: "test" });
    res.json({ ok: true, id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/settings/email-test", P("marketing.settings", "edit"), async (req, res) => {
  const to = txt(req.body?.to, 150);
  if (!to) return res.status(400).json({ error: "Enter an email address." });
  try {
    await sendEmail({ to, subject: "Test from the Our Own Ready Mix app", text: "Email from the Marketing module works.", html: "<p>Email from the Marketing module works.</p>" });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

export default router;
