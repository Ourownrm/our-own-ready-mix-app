// Round 146 — resolving what one person may actually do, and the middleware
// that enforces it.
//
// Two layers, resolved in this order (the design the user approved):
//   1. the role default set          role_default_permissions
//   2. that person's own overrides   user_permission_overrides (grant | revoke)
//
// Only overrides are stored per user, never a full copy of the catalogue, so
// changing a role default later flows through to everyone on that role except
// where they were deliberately overridden.
//
// WHY THIS IS NOT IN THE LOGIN TOKEN: the JWT carries the role and lives 30
// days. A permission revoked today would not take effect for a month. So the
// set is resolved per request from the database, cached in memory for a few
// seconds, and the cache is dropped the moment anyone saves a change — a
// revoked permission bites within seconds, not at next login.
//
// SAFETY PROPERTY OF THIS ROUND, worth stating plainly: `requirePermission` is
// added ALONGSIDE the existing `requireRole` guards, never in place of them.
// On a route that has both, a request must satisfy both. That means granting
// somebody a permission can never let them past a role guard that has not been
// converted yet — this system can only ever tighten access, never loosen it,
// while the conversion is in progress.
import { query } from "../db.js";
import { CATALOGUE, CATALOGUE_BY_KEY, ADMIN_HAS_EVERYTHING, isLocked } from "./permissionCatalogue.js";

const CACHE_MS = 5000;
const cache = new Map(); // userId -> { at, perms: Set<"key:action"> }

export function clearPermissionCache(userId) {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

function pair(key, action) {
  return `${key}:${action}`;
}

// Everything in the catalogue that is not locked — what a Super Admin has, and
// what Administrator has by the user's standing decision.
function everythingUnlocked() {
  const s = new Set();
  for (const c of CATALOGUE) {
    if (c.locked) continue;
    for (const a of c.actions) s.add(pair(c.key, a));
  }
  return s;
}

// Locked functions belong to super_admin alone.
function lockedOnly() {
  const s = new Set();
  for (const c of CATALOGUE) {
    if (!c.locked) continue;
    for (const a of c.actions) s.add(pair(c.key, a));
  }
  return s;
}

export async function effectivePermissions(user) {
  if (!user) return new Set();

  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.perms;

  let perms;
  if (user.role === "super_admin") {
    // The only role that holds the locked functions.
    perms = new Set([...everythingUnlocked(), ...lockedOnly()]);
  } else if (user.role === "administrator" && ADMIN_HAS_EVERYTHING) {
    // Administrator keeps everything except the locked three — the user's
    // decision of 19 Sep. Deliberately computed, not seeded as rows, so it
    // cannot be trimmed by editing the defaults table.
    perms = everythingUnlocked();
  } else {
    const [defaults, overrides] = await Promise.all([
      query(`SELECT permission_key, action FROM role_default_permissions WHERE role = $1`, [user.role]),
      query(`SELECT permission_key, action, granted FROM user_permission_overrides WHERE user_id = $1`, [user.id]),
    ]);
    perms = new Set(defaults.rows.map((r) => pair(r.permission_key, r.action)));
    for (const o of overrides.rows) {
      if (o.granted) perms.add(pair(o.permission_key, o.action));
      else perms.delete(pair(o.permission_key, o.action));
    }
    // A locked function can never be reached this way, whatever the tables
    // happen to contain — belt and braces against a bad row.
    for (const p of [...perms]) if (isLocked(p.slice(0, p.lastIndexOf(":")))) perms.delete(p);
    // View is the gate: create/edit/delete without view is meaningless, and
    // dropping it here means no caller has to remember the rule.
    for (const p of [...perms]) {
      const key = p.slice(0, p.lastIndexOf(":"));
      const action = p.slice(p.lastIndexOf(":") + 1);
      const c = CATALOGUE_BY_KEY[key];
      if (!c) { perms.delete(p); continue; }                 // key no longer in the catalogue
      if (!c.actions.includes(action)) { perms.delete(p); continue; }
      if (action !== "view" && c.actions.includes("view") && !perms.has(pair(key, "view"))) perms.delete(p);
    }
  }

  cache.set(user.id, { at: Date.now(), perms });
  return perms;
}

export async function can(user, key, action) {
  const perms = await effectivePermissions(user);
  return perms.has(pair(key, action));
}

// Usage: router.post("/x", requireRole(...ADMIN), requirePermission("material.orders", "create"), handler)
// Note the ORDER and the fact that requireRole stays — see the header note.
export function requirePermission(key, action) {
  return async (req, res, next) => {
    try {
      if (await can(req.user, key, action)) return next();
      return res.status(403).json({ error: "You don't have access to this." });
    } catch (err) {
      return next(err);
    }
  };
}

// The set in the shape the frontend wants: { "material.orders": ["view","create"] }
export async function permissionsForClient(user) {
  const perms = await effectivePermissions(user);
  const out = {};
  for (const p of perms) {
    const i = p.lastIndexOf(":");
    const key = p.slice(0, i);
    (out[key] = out[key] || []).push(p.slice(i + 1));
  }
  return out;
}
