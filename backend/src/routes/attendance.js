// Round 195 — the attendance machine (eSSL K30 at the main gate).
//
// Same two-audience shape as routes/weighbridge.js:
//
//   POST /attendance/sync   the agent on a plant PC (tools/essl-agent), which
//                           reads the machine directly over the LAN. NOT a
//                           user session; authenticated by ATTENDANCE_API_KEY.
//                           Defined ABOVE router.use(requireAuth) — keep it so.
//
//   everything else         people in the app, behind the
//                           "admin.attendance-machine" permission.
//
// SCOPE OF THIS ROUND. Raw punches only, exactly as the machine recorded them,
// plus the machine's own user list. Turning punches into Present / Half day /
// Absent (the Attendance Rules of the HR mockup) and linking machine IDs to
// employees belong to the HR module, which is not built yet. The daily view
// below is deliberately plain arithmetic — first punch, last punch, the gap —
// so nobody mistakes it for a payroll decision.
//
// IDEMPOTENCE. A punch is (machine, machine user ID, time). The agent re-sends
// a trailing window every cycle; ON CONFLICT DO NOTHING makes that free.
//
// DIRECTION. One-way. Nothing here sends anything to the agent or the machine,
// and the agent has no command that could change the machine anyway.
//
// DAY BOUNDARY. A punch belongs to the attendance day of (IST time − 4 hours),
// so a night shift 22:00 → 06:00 stays one day — the rule agreed in the HR
// mockup ("Rules for every policy: day boundary at 04:00").
import { Router } from "express";
import crypto from "crypto";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";

const router = Router();
const MAX_BATCH = 1000;
const MAX_USERS = 5000;
const PERM = "admin.attendance-machine";

// The attendance day, as SQL. db.js pins every connection to Asia/Kolkata, so
// `punched_at::timestamp` is IST wall-clock time.
const ATT_DAY = `((p.punched_at::timestamp - interval '4 hours')::date)`;

function agentAuthorised(req) {
  const expected = process.env.ATTENDANCE_API_KEY;
  if (!expected) return false; // unset = closed, never open
  const a = Buffer.from(req.get("x-attendance-key") || "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const TEXT = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u0000-\u001f]/g, "").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
};
const SMALL = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 32768 ? n : null;
};
const INT = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 2147483647 ? n : null;
};

// Only an explicit +05:30 local time is accepted — the agent always sends that
// form. Anything else (no offset, a UTC "Z") is refused rather than guessed at,
// because a guessed timezone is the bug this app keeps meeting.
const PUNCH_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+05:30$/;
const EARLIEST = Date.parse("2015-01-01T00:00:00+05:30");
function punchTime(v) {
  const m = PUNCH_RE.exec(String(v || ""));
  if (!m) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < EARLIEST || t > Date.now() + 2 * 86400_000) return null;
  return v;
}
const DEVICE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// ============================================================================
// THE AGENT ENDPOINT — API key, no session. Must stay above requireAuth.
// ============================================================================
router.post("/sync", async (req, res) => {
  if (!agentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });

  const body = req.body || {};
  const d = body.device || {};
  const punches = Array.isArray(body.punches) ? body.punches : [];
  const users = Array.isArray(body.users) ? body.users : [];
  if (punches.length > MAX_BATCH) return res.status(413).json({ error: `Send at most ${MAX_BATCH} punches per call.` });
  if (users.length > MAX_USERS) return res.status(413).json({ error: `Too many users in one call.` });

  const agentVersion = TEXT(body.agent_version, 20);
  const deviceError = TEXT(body.device_error, 1000);
  const ip = TEXT(d.ip, 45);
  // A machine that will not say its serial is still one machine — key it on
  // its address so its punches do not scatter.
  let serial = TEXT(d.serial, 60);
  if (!serial && ip) {
    // No serial — usually because the machine could not be reached this time.
    // File the report against the machine already known at that address.
    const { rows: known } = await query(
      `SELECT serial FROM attendance_devices WHERE ip = $1 ORDER BY last_read_ok_at DESC NULLS LAST LIMIT 1`, [ip]);
    serial = known[0]?.serial || `ip:${ip}`;
  }
  if (!serial) return res.status(400).json({ error: "Expected device.serial or device.ip." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const deviceTime = DEVICE_TIME_RE.test(String(d.device_time || "")) ? d.device_time : null;
    let drift = null;
    if (deviceTime) {
      const pcMs = Date.parse(d.pc_time || "") || Date.now();
      drift = Math.round((Date.parse(deviceTime.replace(" ", "T") + "+05:30") - pcMs) / 60000);
    }

    const { rows: dev } = await client.query(
      `INSERT INTO attendance_devices (serial, label, ip, model, firmware, user_count, record_count, record_capacity,
                                       device_time, clock_drift_min, agent_version, last_seen_at, last_error, last_error_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (serial) DO UPDATE SET
         label           = COALESCE(EXCLUDED.label, attendance_devices.label),
         ip              = COALESCE(EXCLUDED.ip, attendance_devices.ip),
         model           = COALESCE(EXCLUDED.model, attendance_devices.model),
         firmware        = COALESCE(EXCLUDED.firmware, attendance_devices.firmware),
         user_count      = COALESCE(EXCLUDED.user_count, attendance_devices.user_count),
         record_count    = COALESCE(EXCLUDED.record_count, attendance_devices.record_count),
         record_capacity = COALESCE(EXCLUDED.record_capacity, attendance_devices.record_capacity),
         device_time     = COALESCE(EXCLUDED.device_time, attendance_devices.device_time),
         clock_drift_min = COALESCE(EXCLUDED.clock_drift_min, attendance_devices.clock_drift_min),
         agent_version   = EXCLUDED.agent_version,
         last_seen_at    = now(),
         last_read_ok_at = CASE WHEN EXCLUDED.last_error IS NULL THEN now() ELSE attendance_devices.last_read_ok_at END,
         last_error      = EXCLUDED.last_error,
         last_error_at   = CASE WHEN EXCLUDED.last_error IS NULL THEN attendance_devices.last_error_at ELSE now() END
       RETURNING id`,
      [serial, TEXT(d.label, 80), ip, TEXT(d.model, 60), TEXT(d.firmware, 80), INT(d.user_count), INT(d.record_count),
       INT(d.record_capacity), deviceTime, drift, agentVersion, deviceError]
    );
    const deviceId = dev[0].id;
    if (!deviceError) {
      await client.query(`UPDATE attendance_devices SET last_read_ok_at = now() WHERE id = $1`, [deviceId]);
    }

    // The machine's own user list — names as typed on the machine. Upserted so
    // a renamed user follows; nobody is ever deleted from here.
    let usersSeen = 0;
    const cleanUsers = [];
    const seenU = new Set();
    for (const u of users) {
      const id = TEXT(u.user_id, 30);
      if (!id || seenU.has(id)) continue;
      seenU.add(id);
      cleanUsers.push([id, TEXT(u.name, 60), SMALL(u.privilege)]);
    }
    for (let i = 0; i < cleanUsers.length; i += 500) {
      const chunk = cleanUsers.slice(i, i + 500);
      const vals = [], params = [deviceId];
      chunk.forEach((u, j) => { vals.push(`($1, $${j * 3 + 2}, $${j * 3 + 3}, $${j * 3 + 4}, now(), now())`); params.push(...u); });
      await client.query(
        `INSERT INTO attendance_device_users (device_id, machine_user_id, name_on_machine, privilege, first_seen_at, last_seen_at)
         VALUES ${vals.join(", ")}
         ON CONFLICT (device_id, machine_user_id) DO UPDATE SET
           name_on_machine = COALESCE(EXCLUDED.name_on_machine, attendance_device_users.name_on_machine),
           privilege = EXCLUDED.privilege, last_seen_at = now()`,
        params
      );
      usersSeen += chunk.length;
    }

    // Punches.
    let rejected = 0;
    const clean = [];
    const seenP = new Set();
    for (const p of punches) {
      const uid = TEXT(p.user_id, 30);
      const at = punchTime(p.punched_at);
      if (!uid || !at) { rejected++; continue; }
      const k = uid + "|" + at;
      if (seenP.has(k)) continue;
      seenP.add(k);
      clean.push([uid, at, SMALL(p.state), SMALL(p.verify), INT(p.work_code)]);
    }
    let inserted = 0;
    for (let i = 0; i < clean.length; i += 500) {
      const chunk = clean.slice(i, i + 500);
      const vals = [], params = [deviceId];
      chunk.forEach((c, j) => {
        const b = j * 5 + 2;
        vals.push(`($1, $${b}, $${b + 1}::timestamptz, $${b + 2}, $${b + 3}, $${b + 4})`);
        params.push(...c);
      });
      const r = await client.query(
        `INSERT INTO attendance_punches (device_id, machine_user_id, punched_at, key_state, verify_mode, work_code)
         VALUES ${vals.join(", ")}
         ON CONFLICT (device_id, machine_user_id, punched_at) DO NOTHING`,
        params
      );
      inserted += r.rowCount;
    }
    // A punch from someone the machine's user list did not include (deleted
    // from the machine since) still needs a row to hang a name on later.
    if (clean.length) {
      await client.query(
        `INSERT INTO attendance_device_users (device_id, machine_user_id, first_seen_at, last_seen_at)
         SELECT DISTINCT $1::int, u, now(), now() FROM unnest($2::text[]) AS u
         ON CONFLICT (device_id, machine_user_id) DO NOTHING`,
        [deviceId, [...new Set(clean.map((c) => c[0]))]]
      );
    }

    await client.query(
      `INSERT INTO attendance_sync_log (device_id, agent_version, punches_sent, punches_inserted, punches_rejected, users_sent, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [deviceId, agentVersion, punches.length, inserted, rejected, usersSeen, deviceError]
    );
    const { rows: latest } = await client.query(
      `SELECT to_char(max(punched_at), 'YYYY-MM-DD HH24:MI:SS') AS at FROM attendance_punches WHERE device_id = $1`, [deviceId]);
    await client.query("COMMIT");

    res.json({
      ok: true, inserted, already: clean.length - inserted, rejected, users: usersSeen,
      latest_punch_at: latest[0].at || null,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("attendance sync failed:", err);
    // Record the failure where the screen can see it, outside the rolled-back transaction.
    await query(`INSERT INTO attendance_sync_log (agent_version, punches_sent, error) VALUES ($1, $2, $3)`,
      [agentVersion, punches.length, `server: ${err.message}`.slice(0, 1000)]).catch(() => {});
    res.status(500).json({ error: "Could not store the punches." });
  } finally {
    client.release();
  }
});

// ============================================================================
// EVERYTHING BELOW IS A USER SESSION.
// ============================================================================
router.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The header: is the machine being read, and what does it hold.
router.get("/status", requirePermission(PERM, "view"), async (req, res) => {
  try {
    const [devices, log, counts, today] = await Promise.all([
      query(`SELECT id, serial, label, ip, model, firmware, user_count, record_count, record_capacity,
                    to_char(device_time, 'YYYY-MM-DD HH24:MI:SS') AS device_time, clock_drift_min, agent_version,
                    last_seen_at, last_read_ok_at, last_error, last_error_at
             FROM attendance_devices ORDER BY id`),
      query(`SELECT l.received_at, l.agent_version, l.punches_sent, l.punches_inserted, l.punches_rejected, l.error,
                    d.label AS device_label
             FROM attendance_sync_log l LEFT JOIN attendance_devices d ON d.id = l.device_id
             ORDER BY l.received_at DESC LIMIT 12`),
      query(`SELECT count(*)::int AS punches,
                    to_char(min(punched_at), 'YYYY-MM-DD') AS first_day,
                    to_char(max(punched_at), 'YYYY-MM-DD HH24:MI:SS') AS latest,
                    (SELECT count(*)::int FROM attendance_device_users) AS machine_users,
                    (SELECT count(*)::int FROM attendance_device_users WHERE name_on_machine IS NULL) AS unnamed
             FROM attendance_punches`),
      query(`SELECT count(*)::int AS punches, count(DISTINCT machine_user_id)::int AS people
             FROM attendance_punches p WHERE ${ATT_DAY} = (now()::timestamp - interval '4 hours')::date`),
    ]);
    res.json({
      devices: devices.rows,
      sync_log: log.rows,
      totals: counts.rows[0],
      today: today.rows[0],
      key_configured: !!process.env.ATTENDANCE_API_KEY,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the attendance machine status." });
  }
});

// One attendance day: every machine user who punched, with first and last
// punch. Raw arithmetic only — see the header note on scope.
router.get("/day", requirePermission(PERM, "view"), async (req, res) => {
  const date = DATE_RE.test(String(req.query.date || "")) ? req.query.date : null;
  try {
    const { rows: dayRow } = await query(
      `SELECT to_char(COALESCE($1::date, (now()::timestamp - interval '4 hours')::date), 'YYYY-MM-DD') AS d`, [date]);
    const day = dayRow[0].d;
    const { rows } = await query(
      `SELECT p.machine_user_id, du.name_on_machine,
              count(*)::int AS punches,
              to_char(min(p.punched_at), 'HH24:MI') AS first_punch,
              to_char(max(p.punched_at), 'HH24:MI') AS last_punch,
              to_char(min(p.punched_at), 'YYYY-MM-DD') AS first_date,
              to_char(max(p.punched_at), 'YYYY-MM-DD') AS last_date,
              CASE WHEN count(*) > 1
                   THEN round(extract(epoch FROM max(p.punched_at) - min(p.punched_at)) / 60)::int END AS span_min,
              string_agg(to_char(p.punched_at, 'HH24:MI') ||
                         CASE p.key_state WHEN 0 THEN ' in' WHEN 1 THEN ' out' ELSE '' END,
                         ', ' ORDER BY p.punched_at) AS all_punches
       FROM attendance_punches p
       LEFT JOIN attendance_device_users du ON du.device_id = p.device_id AND du.machine_user_id = p.machine_user_id
       WHERE ${ATT_DAY} = $1::date
       GROUP BY p.machine_user_id, du.name_on_machine
       ORDER BY min(p.punched_at)`,
      [day]
    );
    res.json({
      date: day,
      people: rows,
      single_punch: rows.filter((r) => r.punches === 1).length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load that day's punches." });
  }
});

// Everyone the machine knows, and when each last punched.
router.get("/machine-users", requirePermission(PERM, "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT du.machine_user_id, du.name_on_machine, du.privilege, d.label AS device_label,
              to_char(max(p.punched_at), 'YYYY-MM-DD HH24:MI') AS last_punch,
              count(p.id) FILTER (WHERE p.punched_at > now() - interval '30 days')::int AS punches_30d,
              count(DISTINCT ${ATT_DAY}) FILTER (WHERE p.punched_at > now() - interval '30 days')::int AS days_30d
       FROM attendance_device_users du
       JOIN attendance_devices d ON d.id = du.device_id
       LEFT JOIN attendance_punches p ON p.device_id = du.device_id AND p.machine_user_id = du.machine_user_id
       GROUP BY du.device_id, du.machine_user_id, du.name_on_machine, du.privilege, d.label
       ORDER BY CASE WHEN du.machine_user_id ~ '^[0-9]+$' THEN du.machine_user_id::bigint END NULLS LAST, du.machine_user_id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the machine's users." });
  }
});

export default router;
