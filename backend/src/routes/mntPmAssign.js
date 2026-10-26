// Round 243 — PM schedules given to a person (owner, 26 Oct 2026): "an option
// to assign each schedule to a user — plant operator for plant-related (set by
// Manager / Plant In Charge), a driver for a vehicle, loader operator — it
// should appear in their login and they have to confirm it is done or not".
//
// Mounted at /api/maintenance-module beside the other two maintenance routers.
//   GET  /pm-assign/people          who can be given a schedule
//   PUT  /pm-assign                 {schedule_id?, asset_id, user_id|null}
//                                   no schedule_id = every schedule of that vehicle
//   GET  /my-pm                     my schedules, with status (any signed-in user)
//   POST /my-pm/confirm             {schedule_id, asset_id, done, km, hours, note}
// Done sets "last done" to today with the reading given (the same starting
// point a PM inspection updates). Not done needs a reason and tells the
// Manager and Plant In Charge.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { dueList } from "../lib/maintenanceDue.js";
import { pushToRole, pushToUser } from "../lib/push.js";
import { ensureRound243 } from "../lib/round243Schema.js";
import { istDay } from "../lib/istDate.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound243(); next(); } catch (e) { next(e); } });

const SETTERS = ["manager", "plant_in_charge", "administrator", "super_admin"];
const canSet = (u) => SETTERS.includes(u.role);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const num = (v) => (v === "" || v == null ? null : Number(v));

router.get("/pm-assign/people", async (req, res) => {
  if (!canSet(req.user)) return bad(res, "Only the Manager, Plant In Charge or Administrator assigns PM schedules.", 403);
  const { rows } = await query(
    `SELECT id, name, role::text AS role FROM users WHERE is_active AND role::text NOT IN ('super_admin')
      ORDER BY CASE role::text WHEN 'driver' THEN 1 WHEN 'plant_operator' THEN 2 WHEN 'loader_operator' THEN 3 ELSE 4 END, name`);
  res.json(rows);
});

router.put("/pm-assign", async (req, res) => {
  if (!canSet(req.user)) return bad(res, "Only the Manager, Plant In Charge or Administrator assigns PM schedules.", 403);
  const assetId = Number(req.body?.asset_id);
  const scheduleId = req.body?.schedule_id ? Number(req.body.schedule_id) : null;
  const userId = req.body?.user_id ? Number(req.body.user_id) : null;
  if (!(assetId > 0)) return bad(res, "Choose the vehicle or machine.");
  // the schedules of this vehicle (through its model)
  const { rows: sch } = await query(
    `SELECT s.id, s.name FROM mnt_pm_schedules s JOIN mnt_pm_schedule_models sm ON sm.schedule_id = s.id
       JOIN mnt_assets a ON a.model_id = sm.model_id AND a.id = $1 AND a.is_active
      WHERE s.is_active AND ($2::int IS NULL OR s.id = $2)`, [assetId, scheduleId]);
  if (!sch.length) return bad(res, "That schedule doesn't apply to this vehicle.", 404);
  if (userId) {
    const { rows: u } = await query(`SELECT id FROM users WHERE id = $1 AND is_active`, [userId]);
    if (!u.length) return bad(res, "That person is not an active user.");
  }
  for (const s of sch) {
    if (userId) {
      await query(
        `INSERT INTO mnt_pm_assignees (schedule_id, asset_id, user_id, set_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (schedule_id, asset_id) DO UPDATE SET user_id = EXCLUDED.user_id, set_by = EXCLUDED.set_by, set_at = now()`,
        [s.id, assetId, userId, req.user.id]);
    } else {
      await query(`DELETE FROM mnt_pm_assignees WHERE schedule_id = $1 AND asset_id = $2`, [s.id, assetId]);
    }
  }
  if (userId) {
    const { rows: a } = await query(`SELECT name FROM mnt_assets WHERE id = $1`, [assetId]);
    pushToUser(userId, { title: "PM check given to you", body: `${a[0]?.name || "A vehicle"}: ${sch.map((s) => s.name).join(", ")}`, url: "/my-pm" }).catch(() => {});
  }
  res.json({ ok: true, schedules: sch.length });
});

router.get("/my-pm", async (req, res) => {
  const rows = await dueList({ assigneeId: req.user.id });
  const ids = [...new Set(rows.map((r) => r.schedule_id))];
  const { rows: sch } = ids.length
    ? await query(`SELECT id, checklist, tasks, note FROM mnt_pm_schedules WHERE id = ANY($1::int[])`, [ids])
    : { rows: [] };
  const byId = new Map(sch.map((s) => [s.id, s]));
  res.json(rows.map((r) => ({ ...r, checklist: byId.get(r.schedule_id)?.checklist || [], tasks: byId.get(r.schedule_id)?.tasks || [] })));
});

router.post("/my-pm/confirm", async (req, res) => {
  const b = req.body || {};
  const scheduleId = Number(b.schedule_id), assetId = Number(b.asset_id);
  const done = b.done === true;
  const km = num(b.km), hours = num(b.hours);
  const note = String(b.note || "").trim().slice(0, 400);
  if (Number.isNaN(km) || Number.isNaN(hours)) return bad(res, "Readings must be numbers.");
  if (!done && !note) return bad(res, "Say why it was not done.");
  const { rows: asg } = await query(`SELECT user_id FROM mnt_pm_assignees WHERE schedule_id = $1 AND asset_id = $2`, [scheduleId, assetId]);
  if (!asg.length || (asg[0].user_id !== req.user.id && !canSet(req.user))) return bad(res, "This PM check is not given to you.", 403);
  await query(
    `INSERT INTO mnt_pm_confirmations (schedule_id, asset_id, user_id, done, km, hours, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [scheduleId, assetId, req.user.id, done, km, hours, note || null]);
  const { rows: info } = await query(
    `SELECT s.name AS schedule_name, a.name AS asset_name FROM mnt_pm_schedules s, mnt_assets a WHERE s.id = $1 AND a.id = $2`, [scheduleId, assetId]);
  const label = `${info[0]?.asset_name || "Vehicle"} · ${info[0]?.schedule_name || "PM"}`;
  if (done) {
    await query(
      `INSERT INTO mnt_pm_schedule_assets (schedule_id, asset_id, last_done_date, last_done_km, last_done_hours) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (schedule_id, asset_id) DO UPDATE SET last_done_date = $3,
         last_done_km = COALESCE($4, mnt_pm_schedule_assets.last_done_km), last_done_hours = COALESCE($5, mnt_pm_schedule_assets.last_done_hours)`,
      [scheduleId, assetId, istDay(), km, hours]);
  } else {
    const msg = `PM not done — ${label} (${req.user.name}): ${note}`;
    for (const role of ["manager", "plant_in_charge"]) {
      await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ($1, 'pm_not_done', $2)`, [role, msg]).catch(() => {});
      pushToRole(role, { title: "PM check not done", body: msg, url: "/maintenance-module?tab=schedules" }).catch(() => {});
    }
  }
  res.json({ ok: true });
});

export default router;
