import jwt from "jsonwebtoken";
import { query } from "../db.js";

// ===========================================================================
// ROUND 155 — the token is proof of WHO, never of WHAT.
//
// Until now requireAuth verified the JWT and trusted its payload whole. The
// payload carries { id, name, role } and is signed at login for THIRTY DAYS
// (routes/auth.js). Two consequences, both reproduced against a live database
// during the Round 145-154 review:
//
//   * Deactivating somebody did not revoke their API access. `is_active` was
//     read in exactly one place in the entire app — GET /auth/me — which logs
//     the FRONTEND out. Every guarded route kept serving that token real data.
//     Somebody who left the company kept working access for up to a month.
//
//   * Changing somebody's role did nothing. requireRole reads req.user.role,
//     which came from the token, so a lab technician demoted to driver could
//     still READ and WRITE lab records. superAdmin.js called
//     clearPermissionCache() on the change, but that was inert — the next
//     request recomputed from the token's role and reached the same answer.
//     Worse for administrator/super_admin, which short-circuit in
//     lib/permissions.js to the whole catalogue without reading a table.
//
// The fix is to treat the token as an assertion of identity only, and to read
// role and is_active from the users table on every request. That is one extra
// query per request, so it sits behind the same 5-second TTL the permission
// layer already uses — a change bites within five seconds, and a request costs
// at most one lookup per user per five seconds rather than one per request.
//
// Why not just shorten the token's life instead: field staff on plant wifi
// should not be re-logging-in daily, and a short token would still leave a
// window. This closes the window to seconds without touching how anyone signs
// in.
// ===========================================================================

const USER_CACHE_MS = 5000;
const userCache = new Map(); // id -> { at, user: {id,name,role,is_active} | null }

/**
 * Drop a user from the live-identity cache so the very next request re-reads
 * them. Called by superAdmin.js whenever a role or active flag changes, so an
 * intentional change takes effect immediately rather than within 5s.
 *
 * Note this is a per-process cache: on a multi-instance deployment the other
 * instances still pick the change up within USER_CACHE_MS, which is the point
 * of keeping that window short.
 */
export function clearUserCache(userId) {
  if (userId === undefined) userCache.clear();
  else userCache.delete(Number(userId));
}

async function liveUser(id) {
  const key = Number(id);
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user;
  const { rows } = await query(
    `SELECT id, name, role::text AS role, is_active FROM users WHERE id = $1`,
    [key]
  );
  const user = rows[0] || null;
  userCache.set(key, { at: Date.now(), user });
  return user;
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in to continue." });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Belt-and-suspenders (round 119): customer-portal sessions are signed
    // with their own CUSTOMER_JWT_SECRET (see routes/customerPortal.js), so
    // in normal operation they'd fail verification above and never reach
    // here. This check only matters in the one misconfiguration case where
    // CUSTOMER_JWT_SECRET is unset and silently falls back to this same
    // JWT_SECRET — without it, a customer's access-code session would pass
    // straight through as a staff session on any route that checks nothing
    // more than "is this person signed in" (requireAuth with no
    // requireRole after it, e.g. most of routes/masterData.js), exposing
    // staff-only master data to a customer. Reject it explicitly so that
    // misconfiguration fails safe instead of quietly working.
    if (payload && payload.type === "customer") {
      return res.status(401).json({ error: "Sign in to continue." });
    }

    // The token says who. The database says what they may be. A token whose
    // user has since been deactivated, deleted, or given a different role is
    // still cryptographically valid — it just no longer means what it says.
    const live = await liveUser(payload.id);
    if (!live || !live.is_active) {
      return res.status(401).json({ error: "Your access has been turned off. Speak to your administrator." });
    }

    // role and name come from the row, never the token, so a role change takes
    // effect within USER_CACHE_MS instead of at the token's 30-day expiry.
    // Anything else the payload happens to carry is kept, so this stays a
    // superset of the old behaviour for any field a route reads.
    req.user = { ...payload, id: live.id, name: live.name, role: live.role };
    next();
  } catch (err) {
    // Distinguish a bad/expired token from the database being unreachable. The
    // old version had a bare `catch` around jwt.verify alone, so everything was
    // a 401; now a failed lookup must not tell a legitimate person their
    // session expired, or they will log out and back in to no effect.
    if (err && (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" || err.name === "NotBeforeError")) {
      return res.status(401).json({ error: "Your session expired. Sign in again." });
    }
    return next(err);
  }
}

// Usage: requireRole('manager', 'administrator')
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    // A Super Admin outranks every role, so it passes any check — see the
    // note at the bottom of this file. The one place this must NOT apply is a
    // guard that names super_admin itself, and that still works: the role is
    // in allowedRoles there, so the normal path allows it anyway.
    if (req.user && req.user.role === "super_admin") return next();
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have access to this." });
    }
    next();
  };
}

// Round 148 — `super_admin` is the TOP role, not a sideways one.
//
// Round 146 introduced it as a twelfth role and guarded `/super-admin` with it,
// which had a consequence nobody wanted: promoting an account to super_admin
// took away every Administrator screen, because each one is guarded
// `requireRole("administrator")` / `roles={["administrator"]}` and super_admin
// is not that string. The first real promotion locked the account out of the
// whole app except the access-control page.
//
// So the rule is now explicit and lives in one place: a Super Admin satisfies
// any role check. `requireRole` below lets it through unconditionally, and
// `isAdminLevel` is how the rest of the code asks "is this an administrator?"
// so that question can never again be asked as a bare string compare that
// silently excludes the one role that outranks it.
//
// Note this deliberately does NOT rewrite `req.user.role` to "administrator".
// Masking it that way would make every existing check pass for free, but it
// would also make a future `req.user.role === "super_admin"` silently false —
// a trap worth more than the few edits avoided.
export function isAdminLevel(role) {
  return role === "administrator" || role === "super_admin";
}
