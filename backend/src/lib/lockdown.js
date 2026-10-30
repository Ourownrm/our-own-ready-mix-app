// Round 242 — EMERGENCY LOCK (owner, 26 Oct 2026): "a switch to disable app
// functions to everyone if I felt any security breach. Only thing shown after
// the disable button is ON is the attendance of the user. One switch which
// disables all the functions to all users including admin."
//
// While the lock is on, every /api request is refused (503, code "lockdown")
// except:
//   * signing in, and "who am I" (so people can still reach their attendance);
//   * the lock itself — its status (anyone) and the switch (Super Admin only,
//     who must type their password to lift it);
//   * each person's OWN attendance: Mark attendance on the phone (/hr/punch…)
//     and My attendance (/hr/my…);
//   * the public website's text (GET /site-content) and its enquiry form.
// Everything else — every module, report, customer link, customer portal and
// the plant computers' agents — stops. The agents keep retrying and catch up
// once the lock is lifted.
//
// Lifting the lock can also sign everyone out: every sign-in made before that
// moment stops working (sessions_after), so a stolen session cannot be used
// after the lock is lifted.
import { query } from "../db.js";
import { ROUND242_LOCK_SQL } from "./round242Schema.js";

const CACHE_MS = 3000;
let cache = { at: 0, row: null };
let ready = null;

async function ensure() {
  if (!ready) ready = query(ROUND242_LOCK_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}

export async function lockState({ fresh = false } = {}) {
  if (!fresh && cache.row && Date.now() - cache.at < CACHE_MS) return cache.row;
  try {
    await ensure();
    const { rows } = await query(
      `SELECT l.is_on, l.since, l.reason, l.sessions_after, u.name AS set_by_name
         FROM app_lockdown l LEFT JOIN users u ON u.id = l.set_by WHERE l.id = 1`);
    cache = { at: Date.now(), row: rows[0] || { is_on: false } };
  } catch (err) {
    // A database that cannot be read must not open a lock that was on: keep
    // the last known state (and when there is none, the app's normal checks
    // still apply on every route).
    console.error("lockdown: could not read the lock", err.message);
    if (!cache.row) return { is_on: false };
  }
  return cache.row;
}

export function clearLockCache() { cache = { at: 0, row: null }; }

export async function setLock({ on, reason, userId, ip, signOutAll }) {
  await ensure();
  if (on) {
    // Round 252 (owner, 30 Oct 2026): "once locked sign out all users
    // immediately" — every sign-in made before this moment stops working,
    // the Super Admin's own included (signing in stays open while locked).
    await query(`UPDATE app_lockdown SET is_on = true, since = now(), reason = $1, set_by = $2, sessions_after = now() WHERE id = 1`, [reason || null, userId]);
  } else {
    await query(
      `UPDATE app_lockdown SET is_on = false, since = now(), reason = NULL, set_by = $1,
              sessions_after = CASE WHEN $2::boolean THEN now() ELSE sessions_after END WHERE id = 1`,
      [userId, !!signOutAll]);
  }
  await query(`INSERT INTO app_lockdown_log (action, reason, user_id, ip) VALUES ($1, $2, $3, $4)`,
    [on ? "lock+signout" : signOutAll ? "unlock+signout" : "unlock", reason || null, userId, String(ip || "").slice(0, 80)]);
  clearLockCache();
  return lockState({ fresh: true });
}

export async function lockLog(limit = 20) {
  await ensure();
  const { rows } = await query(
    `SELECT g.at, g.action, g.reason, g.ip, u.name AS user_name FROM app_lockdown_log g LEFT JOIN users u ON u.id = g.user_id
      ORDER BY g.at DESC LIMIT $1`, [limit]);
  return rows;
}

// What stays open while the lock is on.
function allowed(method, path) {
  if (path === "/api/auth/login" || path === "/api/auth/me") return true;
  if (path === "/api/lockdown" || path.startsWith("/api/lockdown/")) return true;
  if (path === "/api/hr/punch" || path.startsWith("/api/hr/punch/")) return true;
  if (path === "/api/hr/my" || path.startsWith("/api/hr/my/")) return true;
  if (method === "GET" && path.startsWith("/api/site-content/")) return true;
  if (method === "POST" && (path === "/api/public-inquiry" || path.startsWith("/api/public-inquiry/"))) return true;
  return false;
}

export async function lockdownGate(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  if (req.method === "OPTIONS") return next();
  const st = await lockState();
  if (!st.is_on || allowed(req.method, req.path.replace(/\/+$/, ""))) return next();
  return res.status(503).json({
    error: "The app is locked by the Super Admin. Only your attendance can be marked until it is unlocked.",
    code: "lockdown", since: st.since,
  });
}
