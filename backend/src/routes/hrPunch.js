// Round 202 — attendance marked on the phone. Mounted at /api/hr beside
// routes/hr.js.
//
// The owner's rules:
//   * Only staff who already have an app login may mark attendance on the
//     phone (hr_employees.app_punch: 'off' | 'plant' | 'anywhere'). Drivers
//     never: they use the gate machine.
//   * Everyone who marks on the phone passes a FACE CHECK.
//
// What a punch must pass, and what happens when it doesn't:
//   1. The person's own registered phone. The first phone used is registered;
//      HR moves it when the phone changes. Another phone → refused.
//   2. Location. 'plant': inside a work location's radius, with the phone's
//      GPS accuracy no worse than gps_accuracy_max. Outside → refused (ask for
//      On duty instead). 'anywhere' (sales): any location, saved and shown.
//   3. Face. The phone turns the selfie into a 128-number face descriptor
//      (face-api, on the phone) and checks for a blink. The SERVER compares
//      the descriptor with the one enrolled by HR — the phone's own verdict is
//      never trusted. Distance within face_match_max and a blink → counted.
//      Not matched → refused; the phone tries again. After face_tries the
//      punch is saved with its photo for the manager to check, and counts
//      only once approved.
// Every punch keeps its photo (deleted after photo_keep_days) and location.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { loadRules } from "../lib/hrRules.js";

const router = Router();
router.use(requireAuth);

const ADMIN_ROLES = ["administrator", "super_admin"];
const isAdmin = (u) => ADMIN_ROLES.includes(u.role);
const bad = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });

function haversineM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
function descriptorOk(d) {
  return Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 5);
}
function faceDistance(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
// A small JPEG as a data URL → bytes. Anything else, or too big, is dropped.
function photoBytes(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  return buf.length > 0 && buf.length <= 200_000 ? buf : null;
}
const deviceOk = (d) => typeof d === "string" && /^[A-Za-z0-9-]{16,64}$/.test(d);

async function myEmployee(userId) {
  const { rows } = await query(
    `SELECT e.id, e.name, e.emp_code, e.app_punch, e.attendance_source, e.device_id, e.is_active, u.role,
            (f.employee_id IS NOT NULL) AS enrolled
     FROM hr_employees e JOIN users u ON u.id = e.app_user_id
     LEFT JOIN hr_employee_faces f ON f.employee_id = e.id
     WHERE e.app_user_id = $1 AND e.is_active LIMIT 1`, [userId]);
  return rows[0] || null;
}
const allowedFor = (emp) => !!emp && emp.app_punch !== "off" && emp.role !== "driver";

async function todaysPunches(empId) {
  const { rows } = await query(
    `SELECT id, to_char(punched_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS t, status, distance_m, location_id
     FROM hr_app_punches WHERE employee_id = $1
       AND punched_at >= ((((now() AT TIME ZONE 'Asia/Kolkata') - interval '4 hours')::date + time '04:00') AT TIME ZONE 'Asia/Kolkata')
     ORDER BY punched_at`, [empId]);
  return rows;
}

// ---------------------------------------------------------------- the phone
// Everything the Mark attendance screen needs before it opens the camera.
router.get("/punch/setup", async (req, res) => {
  try {
    const emp = await myEmployee(req.user.id);
    if (!emp) return res.json({ allowed: false, reason: "Your login is not linked to an employee record." });
    if (!allowedFor(emp)) {
      return res.json({ allowed: false, employee: { name: emp.name },
        reason: emp.role === "driver" ? "Drivers mark attendance on the gate machine." : "Attendance on the phone is not switched on for you. Use the gate machine, or ask HR." });
    }
    const rules = await loadRules();
    const { rows: locs } = await query(`SELECT id, name, lat, lng, radius_m FROM hr_work_locations WHERE is_active ORDER BY name`);
    res.json({
      allowed: true, employee: { name: emp.name, emp_code: emp.emp_code }, mode: emp.app_punch,
      enrolled: emp.enrolled, device_registered: !!emp.device_id,
      locations: locs, rules: { gps_accuracy_max: rules.gps_accuracy_max, face_tries: rules.face_tries },
      today: await todaysPunches(emp.id),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load attendance." });
  }
});
// Cheap check for the header link.
router.get("/punch/allowed", async (req, res) => {
  try { res.json({ allowed: allowedFor(await myEmployee(req.user.id)) }); }
  catch (err) { console.error(err); res.json({ allowed: false }); }
});

router.post("/punch", async (req, res) => {
  try {
    const emp = await myEmployee(req.user.id);
    if (!allowedFor(emp)) return bad(res, 403, "Attendance on the phone is not switched on for you.");
    if (!emp.enrolled) return bad(res, 409, "HR has not enrolled your face yet. Ask HR to take your photo once.", { code: "not_enrolled" });
    const b = req.body || {};
    const rules = await loadRules();

    // 1. registered phone
    if (!deviceOk(b.device_id)) return bad(res, 400, "This phone could not be identified. Reload and try again.");
    if (emp.device_id && emp.device_id !== b.device_id) {
      return bad(res, 403, "This isn't your registered phone. New phone? Ask HR to move your registration.", { code: "wrong_device" });
    }

    // 2. location
    const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return bad(res, 400, "Location is needed to mark attendance. Allow location for this app and try again.", { code: "no_location" });
    }
    const { rows: locs } = await query(`SELECT id, name, lat, lng, radius_m FROM hr_work_locations WHERE is_active`);
    let nearest = null;
    for (const l of locs) {
      const dist = haversineM({ lat, lng }, l);
      if (!nearest || dist < nearest.dist) nearest = { ...l, dist };
    }
    if (emp.app_punch === "plant") {
      if (!locs.length) return bad(res, 409, "No work location is set up yet. Ask HR to add the plant's location.", { code: "no_locations" });
      if (!Number.isFinite(acc) || acc > rules.gps_accuracy_max) {
        return bad(res, 422, `Location is not accurate enough (±${Number.isFinite(acc) ? Math.round(acc) : "?"} m, needs ±${rules.gps_accuracy_max} m). Step outside or wait a few seconds and try again.`, { code: "inaccurate" });
      }
      if (nearest.dist > nearest.radius_m) {
        return bad(res, 422, `You're ${nearest.dist >= 1000 ? (nearest.dist / 1000).toFixed(1) + " km" : nearest.dist + " m"} from ${nearest.name} — you can mark attendance within ${nearest.radius_m} m. On work outside? Ask for On duty instead.`,
          { code: "outside", distance_m: nearest.dist, radius_m: nearest.radius_m, location: nearest.name });
      }
    }

    // 3. face — decided here, against the enrolled descriptor
    const tries = Math.max(1, Math.min(20, Number(b.tries) || 1));
    const hasFace = descriptorOk(b.descriptor);
    if (!hasFace && tries < rules.face_tries) {
      return bad(res, 422, "No face found in the picture. Look straight at the camera in good light.", { code: "no_face", tries_left: rules.face_tries - tries });
    }
    let dist = null;
    if (hasFace) {
      const { rows: f } = await query(`SELECT descriptor FROM hr_employee_faces WHERE employee_id = $1`, [emp.id]);
      dist = Math.round(faceDistance(b.descriptor, f[0].descriptor) * 1000) / 1000;
    }
    const live = b.live === true;
    const matched = hasFace && dist <= rules.face_match_max && live;
    if (!matched && tries < rules.face_tries) {
      return bad(res, 422, live ? "Face not recognised. Face the light, take off the helmet or mask, and try again." : "Please blink once while looking at the camera.",
        { code: live ? "face_mismatch" : "no_blink", tries_left: rules.face_tries - tries });
    }
    // After the last try the punch is saved anyway, with its photo, for the
    // manager to look at — it counts only once they approve.
    const photo = photoBytes(b.photo);
    const status = matched ? "ok" : "review";
    const reviewReason = matched ? null : !hasFace ? "no face found" : !live ? "no blink detected" : `face did not match (${dist})`;
    if (!emp.device_id) {
      await query(`UPDATE hr_employees SET device_id = $1, device_registered_at = now() WHERE id = $2 AND device_id IS NULL`, [b.device_id, emp.id]);
    }
    const { rows } = await query(
      `INSERT INTO hr_app_punches (employee_id, lat, lng, accuracy_m, location_id, distance_m, face_distance, live, tries, device_id, photo, status, review_reason, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, to_char(punched_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS t`,
      [emp.id, lat, lng, Number.isFinite(acc) ? acc : null, nearest?.id || null, nearest?.dist ?? null, dist, live, tries, b.device_id, photo,
        status, reviewReason, req.user.id]);
    // Old photos go after the keep period (the punch itself stays).
    query(`UPDATE hr_app_punches SET photo = NULL WHERE photo IS NOT NULL AND punched_at < now() - ($1 || ' days')::interval`, [String(rules.photo_keep_days)]).catch(() => {});
    res.status(201).json({
      ok: true, id: rows[0].id, time: rows[0].t, status,
      message: matched ? `Marked at ${rows[0].t}.` : `Saved at ${rows[0].t} for your manager to check — it counts once they approve.`,
      location: nearest ? { name: nearest.name, distance_m: nearest.dist } : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not mark attendance." });
  }
});

// ---------------------------------------------------------------- HR side
// Enrol a face: the HR screen captures the photo and the descriptor on the
// device; the server keeps both.
router.put("/employees/:id/face", requirePermission("hr.employees", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (!descriptorOk(b.descriptor)) return bad(res, 400, "No face was found in the photo. Take it again, facing the camera.");
  const photo = photoBytes(b.photo);
  try {
    const { rowCount } = await query(`SELECT 1 FROM hr_employees WHERE id = $1`, [id]);
    if (!rowCount) return bad(res, 404, "Employee not found.");
    await query(
      `INSERT INTO hr_employee_faces (employee_id, descriptor, photo, enrolled_by) VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (employee_id) DO UPDATE SET descriptor = EXCLUDED.descriptor, photo = EXCLUDED.photo, enrolled_at = now(), enrolled_by = EXCLUDED.enrolled_by`,
      [id, JSON.stringify(b.descriptor), photo, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the face." });
  }
});
router.delete("/employees/:id/face", requirePermission("hr.employees", "edit"), async (req, res) => {
  await query(`DELETE FROM hr_employee_faces WHERE employee_id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});
router.get("/employees/:id/face/photo", requirePermission("hr.employees", "view"), async (req, res) => {
  const { rows } = await query(`SELECT photo FROM hr_employee_faces WHERE employee_id = $1`, [Number(req.params.id)]);
  if (!rows[0]?.photo) return res.status(404).end();
  res.set("Content-Type", "image/jpeg").set("Cache-Control", "private, max-age=60").send(rows[0].photo);
});
// Forget the registered phone, so the next phone used becomes the registered one.
router.delete("/employees/:id/device", requirePermission("hr.employees", "edit"), async (req, res) => {
  await query(`UPDATE hr_employees SET device_id = NULL, device_registered_at = NULL WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});
router.get("/employees/:id/punch-status", requirePermission("hr.employees", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT e.app_punch, e.device_registered_at, f.enrolled_at, u.name AS enrolled_by_name
     FROM hr_employees e LEFT JOIN hr_employee_faces f ON f.employee_id = e.id LEFT JOIN users u ON u.id = f.enrolled_by WHERE e.id = $1`,
    [Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: "Employee not found." });
  res.json(rows[0]);
});

// Work locations.
function locFields(b) {
  const name = String(b.name || "").trim().slice(0, 80);
  const lat = Number(b.lat), lng = Number(b.lng), r = Number(b.radius_m);
  if (!name) throw Object.assign(new Error("Give the location a name."), { expose: true });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw Object.assign(new Error("Latitude and longitude are needed."), { expose: true });
  if (!(Number.isInteger(r) && r >= 20 && r <= 5000)) throw Object.assign(new Error("Radius must be 20 to 5000 metres."), { expose: true });
  return [name, lat, lng, r, b.is_active !== false];
}
router.get("/work-locations", requirePermission("hr.settings", "view"), async (req, res) => {
  const { rows } = await query(`SELECT * FROM hr_work_locations ORDER BY is_active DESC, name`);
  res.json(rows);
});
router.post("/work-locations", requirePermission("hr.settings", "create"), async (req, res) => {
  try {
    const { rows } = await query(`INSERT INTO hr_work_locations (name, lat, lng, radius_m, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING *`, locFields(req.body || {}));
    res.status(201).json(rows[0]);
  } catch (err) { if (err.expose) return bad(res, 400, err.message); console.error(err); bad(res, 500, "Could not save the location."); }
});
router.patch("/work-locations/:id", requirePermission("hr.settings", "edit"), async (req, res) => {
  try {
    const { rows } = await query(`UPDATE hr_work_locations SET name=$1, lat=$2, lng=$3, radius_m=$4, is_active=$5 WHERE id=$6 RETURNING *`,
      [...locFields(req.body || {}), Number(req.params.id)]);
    if (!rows.length) return bad(res, 404, "Location not found.");
    res.json(rows[0]);
  } catch (err) { if (err.expose) return bad(res, 400, err.message); console.error(err); bad(res, 500, "Could not save the location."); }
});

// Punches to check: saved after the face check failed. Same approval rule as
// the other requests: Plant Manager; Admin for the Plant Manager's own.
router.get("/app-punches", requirePermission("hr.requests", "view"), async (req, res) => {
  const status = ["review", "approved", "rejected", "ok"].includes(req.query.status) ? req.query.status : "review";
  const { rows } = await query(
    `SELECT p.id, p.employee_id, to_char(p.punched_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS date,
            to_char(p.punched_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS time, p.lat, p.lng, p.accuracy_m, p.distance_m,
            p.face_distance, p.live, p.tries, p.status, p.review_reason, p.review_note, (p.photo IS NOT NULL) AS has_photo,
            l.name AS location_name, e.name AS employee_name, e.emp_code, e.app_user_id, u.role AS app_user_role, d.name AS department,
            rb.name AS reviewed_by_name
     FROM hr_app_punches p JOIN hr_employees e ON e.id = p.employee_id
     LEFT JOIN users u ON u.id = e.app_user_id
     LEFT JOIN hr_work_locations l ON l.id = p.location_id
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN users rb ON rb.id = p.reviewed_by
     WHERE p.status = $1 ORDER BY p.punched_at DESC LIMIT 300`, [status]);
  const admin = isAdmin(req.user);
  res.json(rows.map((r) => ({ ...r, can_decide: r.status === "review" && r.app_user_id !== req.user.id && (admin || r.app_user_role !== "manager") })));
});
router.get("/app-punches/:id/photo", requirePermission("hr.requests", "view"), async (req, res) => {
  const { rows } = await query(`SELECT photo FROM hr_app_punches WHERE id = $1`, [Number(req.params.id)]);
  if (!rows[0]?.photo) return res.status(404).end();
  res.set("Content-Type", "image/jpeg").set("Cache-Control", "private, max-age=300").send(rows[0].photo);
});
router.post("/app-punches/:id/decide", requirePermission("hr.requests", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(
    `SELECT p.status, e.app_user_id, u.role, to_char(p.punched_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month
     FROM hr_app_punches p JOIN hr_employees e ON e.id = p.employee_id LEFT JOIN users u ON u.id = e.app_user_id WHERE p.id = $1`, [id]);
  const p = rows[0];
  if (!p) return bad(res, 404, "Punch not found.");
  if (p.status !== "review") return bad(res, 409, "This punch has already been checked.");
  if (p.app_user_id === req.user.id) return bad(res, 403, "Nobody can approve their own punch.");
  if (p.role === "manager" && !isAdmin(req.user)) return bad(res, 403, "This one needs Admin (Plant Manager's own punch).");
  const { rows: lk } = await query(`SELECT status FROM hr_payroll_runs WHERE month = $1`, [p.month]);
  if (lk[0]?.status === "locked") return bad(res, 409, "Payroll for that month is locked.");
  const approve = !!req.body?.approve;
  const note = String(req.body?.note || "").trim().slice(0, 500) || null;
  if (!approve && !note) return bad(res, 400, "Say why it is rejected.");
  await query(`UPDATE hr_app_punches SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $4`,
    [approve ? "approved" : "rejected", req.user.id, note, id]);
  res.json({ ok: true });
});

export default router;
