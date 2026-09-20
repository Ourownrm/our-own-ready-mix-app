// Round 146 — the Super Admin access-control API.
//
// Everything here is `super_admin` only, at the ROUTER level. The safety rules
// from claude/super-admin-functions-list.md are enforced HERE, in the API, not
// merely hidden in the page:
//
//   * A Super Admin cannot change their own permissions or deactivate their
//     own account — one wrong click must not be able to lock everybody out.
//   * The system refuses any change that would leave zero active Super Admins.
//   * The three locked functions (access control, password reset, /setup) can
//     never be granted to anyone.
//   * View is the gate: create/edit/delete cannot be granted without it, and
//     revoking view takes the rest with it.
//   * Administrator's set is computed, not stored, so it cannot be trimmed
//     here either (the user's standing decision of 19 Sep).
import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { CATALOGUE, CATALOGUE_BY_KEY, GROUPS, ROLES, ACTIONS, PERMISSION_BY_SCREEN, isLocked } from "../lib/permissionCatalogue.js";
import { effectivePermissions, clearPermissionCache } from "../lib/permissions.js";

const router = Router();
router.use(requireAuth);
router.use(requireRole("super_admin"));

// Roles whose defaults are computed rather than stored, and so cannot be
// edited from the defaults grid.
const COMPUTED_ROLES = new Set(["super_admin", "administrator"]);

function validate(key, action) {
  const c = CATALOGUE_BY_KEY[key];
  if (!c) return "That isn't a function this app has.";
  if (!ACTIONS.includes(action) || !c.actions.includes(action)) return `"${c.label}" has no ${action} action.`;
  if (c.locked) return `"${c.label}" can only ever be done by a Super Admin.`;
  return null;
}

async function activeSuperAdminCount(excludeUserId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM users WHERE role = 'super_admin' AND is_active AND ($1::int IS NULL OR id <> $1)`,
    [excludeUserId ?? null]
  );
  return rows[0].n;
}

// ===== The catalogue itself, so the page has labels and groups =====
router.get("/catalogue", (req, res) => {
  res.json({
    groups: GROUPS,
    roles: ROLES,
    computed_roles: [...COMPUTED_ROLES],
    actions: ACTIONS,
    permission_by_screen: PERMISSION_BY_SCREEN,
    functions: CATALOGUE.map((c) => ({
      key: c.key, group: c.group, label: c.label, actions: c.actions,
      locked: !!c.locked, screen: c.screen || null,
    })),
  });
});

// ===== Users =====
router.get("/users", async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.phone, u.role::text AS role, u.is_active,
            COALESCE(o.n, 0)::int AS override_count
     FROM users u
     LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM user_permission_overrides GROUP BY user_id) o
       ON o.user_id = u.id
     ORDER BY u.is_active DESC, u.name`
  );
  res.json(rows.map((r) => ({ ...r, is_self: r.id === req.user.id })));
});

// One person's effective set, their overrides, and their role's defaults, so
// the page can show all three columns side by side.
router.get("/users/:id/permissions", async (req, res) => {
  const { rows: userRows } = await query(
    `SELECT id, name, role::text AS role, is_active FROM users WHERE id = $1`, [req.params.id]
  );
  const user = userRows[0];
  if (!user) return res.status(404).json({ error: "No such user." });

  const [defaults, overrides] = await Promise.all([
    query(`SELECT permission_key, action FROM role_default_permissions WHERE role = $1`, [user.role]),
    query(`SELECT permission_key, action, granted FROM user_permission_overrides WHERE user_id = $1`, [user.id]),
  ]);
  const effective = await effectivePermissions(user);

  res.json({
    user: { ...user, is_self: user.id === req.user.id },
    // Administrator's and Super Admin's sets are computed; the page uses this
    // to lock the matrix rather than pretending an edit would stick.
    computed: COMPUTED_ROLES.has(user.role),
    role_defaults: defaults.rows.map((r) => `${r.permission_key}:${r.action}`),
    overrides: overrides.rows.map((r) => ({ key: r.permission_key, action: r.action, granted: r.granted })),
    effective: [...effective],
  });
});

// Set or clear one override for one person.
// body: { key, action, state: "grant" | "revoke" | "default" }
router.put("/users/:id/permissions", async (req, res) => {
  const { key, action, state } = req.body || {};
  const userId = Number(req.params.id);

  if (userId === req.user.id) {
    return res.status(400).json({ error: "You can't change your own access. Ask another Super Admin." });
  }
  if (!["grant", "revoke", "default"].includes(state)) {
    return res.status(400).json({ error: "State must be grant, revoke or default." });
  }
  const invalid = validate(key, action);
  if (invalid) return res.status(400).json({ error: invalid });

  const { rows: userRows } = await query(`SELECT id, name, role::text AS role FROM users WHERE id = $1`, [userId]);
  const target = userRows[0];
  if (!target) return res.status(404).json({ error: "No such user." });
  if (COMPUTED_ROLES.has(target.role)) {
    return res.status(400).json({
      error: target.role === "administrator"
        ? "Administrator keeps every function by design — change their role if they should have less."
        : "A Super Admin's access can't be edited.",
    });
  }

  const c = CATALOGUE_BY_KEY[key];
  const before = await effectivePermissions(target);
  const had = before.has(`${key}:${action}`);

  // View is the gate, enforced here and not just in the page.
  if (state === "grant" && action !== "view" && c.actions.includes("view") && !before.has(`${key}:view`)) {
    return res.status(400).json({ error: `Give them View on "${c.label}" first — the other actions do nothing without it.` });
  }

  const previousState = (await query(
    `SELECT granted FROM user_permission_overrides WHERE user_id = $1 AND permission_key = $2 AND action = $3`,
    [userId, key, action]
  )).rows[0];
  const previousLabel = previousState === undefined ? "role default" : previousState.granted ? "granted" : "revoked";

  if (state === "default") {
    await query(
      `DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_key = $2 AND action = $3`,
      [userId, key, action]
    );
  } else {
    await query(
      `INSERT INTO user_permission_overrides (user_id, permission_key, action, granted, set_by, set_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id, permission_key, action)
       DO UPDATE SET granted = EXCLUDED.granted, set_by = EXCLUDED.set_by, set_at = now()`,
      [userId, key, action, state === "grant", req.user.id]
    );
  }

  // Revoking view takes create/edit/delete with it, rather than leaving
  // orphans the resolver would silently drop anyway.
  let cascaded = 0;
  if (action === "view" && state === "revoke") {
    for (const a of c.actions) {
      if (a === "view") continue;
      const r = await query(
        `INSERT INTO user_permission_overrides (user_id, permission_key, action, granted, set_by, set_at)
         VALUES ($1, $2, $3, false, $4, now())
         ON CONFLICT (user_id, permission_key, action)
         DO UPDATE SET granted = false, set_by = EXCLUDED.set_by, set_at = now()`,
        [userId, key, a, req.user.id]
      );
      cascaded += r.rowCount;
    }
  }

  await query(
    `INSERT INTO permission_change_log (changed_by, target_user_id, permission_key, action, granted, previous_state)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.user.id, userId, key, action, state === "grant", previousLabel]
  );

  clearPermissionCache(userId);
  const after = await effectivePermissions({ id: userId, role: target.role });
  res.json({ ok: true, had, has: after.has(`${key}:${action}`), cascaded, effective: [...after] });
});

// Reset one person back to their role's defaults.
router.delete("/users/:id/permissions", async (req, res) => {
  const userId = Number(req.params.id);
  if (userId === req.user.id) {
    return res.status(400).json({ error: "You can't change your own access. Ask another Super Admin." });
  }
  const { rowCount } = await query(`DELETE FROM user_permission_overrides WHERE user_id = $1`, [userId]);
  clearPermissionCache(userId);
  res.json({ ok: true, removed: rowCount });
});

// ===== Role defaults =====
router.get("/roles/:role/permissions", async (req, res) => {
  const role = req.params.role;
  if (!ROLES.includes(role)) return res.status(404).json({ error: "No such role." });
  if (COMPUTED_ROLES.has(role)) {
    return res.json({ role, computed: true, defaults: [], note: "This role's access is fixed in code and cannot be edited." });
  }
  const { rows } = await query(`SELECT permission_key, action FROM role_default_permissions WHERE role = $1`, [role]);
  const { rows: counts } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND is_active`, [role]);
  res.json({ role, computed: false, defaults: rows.map((r) => `${r.permission_key}:${r.action}`), active_users: counts[0].n });
});

router.put("/roles/:role/permissions", async (req, res) => {
  const role = req.params.role;
  const { key, action, on } = req.body || {};
  if (!ROLES.includes(role)) return res.status(404).json({ error: "No such role." });
  if (COMPUTED_ROLES.has(role)) {
    return res.status(400).json({ error: "This role's access is fixed in code and cannot be edited." });
  }
  const invalid = validate(key, action);
  if (invalid) return res.status(400).json({ error: invalid });

  const c = CATALOGUE_BY_KEY[key];
  const current = new Set(
    (await query(`SELECT permission_key, action FROM role_default_permissions WHERE role = $1`, [role]))
      .rows.map((r) => `${r.permission_key}:${r.action}`)
  );
  if (on && action !== "view" && c.actions.includes("view") && !current.has(`${key}:view`)) {
    return res.status(400).json({ error: `Turn View on for "${c.label}" first — the other actions do nothing without it.` });
  }

  if (on) {
    await query(
      `INSERT INTO role_default_permissions (role, permission_key, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [role, key, action]
    );
  } else {
    await query(
      `DELETE FROM role_default_permissions WHERE role = $1 AND permission_key = $2 AND action = $3`,
      [role, key, action]
    );
    // Same cascade as the per-user case.
    if (action === "view") {
      await query(
        `DELETE FROM role_default_permissions WHERE role = $1 AND permission_key = $2 AND action <> 'view'`,
        [role, key]
      );
    }
  }

  await query(
    `INSERT INTO permission_change_log (changed_by, target_role, permission_key, action, granted, previous_state)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.user.id, role, key, action, !!on, current.has(`${key}:${action}`) ? "granted" : "revoked"]
  );

  // Everyone on this role has a stale cached set.
  clearPermissionCache();
  const overridden = await query(
    `SELECT u.id, u.name FROM user_permission_overrides o JOIN users u ON u.id = o.user_id
     WHERE u.role = $1 AND o.permission_key = $2 AND o.action = $3`,
    [role, key, action]
  );
  // Saying who this change will NOT reach matters: an individual override
  // always wins over a role default, and it is easy to assume otherwise.
  res.json({ ok: true, unaffected_because_overridden: overridden.rows });
});

// ===== Super Admin account management =====
// Promoting somebody, and the two rules that stop the system locking itself.

router.post("/users/:id/role", async (req, res) => {
  const userId = Number(req.params.id);
  const { role } = req.body || {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: "No such role." });
  if (userId === req.user.id) return res.status(400).json({ error: "You can't change your own role." });

  const { rows } = await query(`SELECT id, name, role::text AS role, is_active FROM users WHERE id = $1`, [userId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "No such user." });

  if (target.role === "super_admin" && role !== "super_admin" && (await activeSuperAdminCount(userId)) === 0) {
    return res.status(400).json({ error: "That would leave no Super Admin. Promote someone else first." });
  }
  await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, userId]);
  clearPermissionCache(userId);
  res.json({ ok: true, role });
});

router.post("/users", async (req, res) => {
  const { name, phone, password, role } = req.body || {};
  if (!name || !phone || !password) return res.status(400).json({ error: "Name, phone and a password are all needed." });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "No such role." });
  const { rows } = await query(
    `INSERT INTO users (name, phone, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, role::text AS role`,
    [name, phone, await bcrypt.hash(password, 10), role]
  );
  res.status(201).json(rows[0]);
});

router.patch("/users/:id/status", async (req, res) => {
  const userId = Number(req.params.id);
  const isActive = !!(req.body || {}).is_active;
  if (userId === req.user.id) return res.status(400).json({ error: "You can't deactivate your own account." });

  const { rows } = await query(`SELECT role::text AS role FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return res.status(404).json({ error: "No such user." });
  if (!isActive && rows[0].role === "super_admin" && (await activeSuperAdminCount(userId)) === 0) {
    return res.status(400).json({ error: "That would leave no active Super Admin." });
  }
  await query(`UPDATE users SET is_active = $1 WHERE id = $2`, [isActive, userId]);
  clearPermissionCache(userId);
  res.json({ ok: true });
});

// ===== Change log =====
router.get("/change-log", async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.permission_key, l.action, l.granted, l.previous_state, l.changed_at,
            l.target_role::text AS target_role,
            b.name AS changed_by_name, t.name AS target_user_name
     FROM permission_change_log l
     JOIN users b ON b.id = l.changed_by
     LEFT JOIN users t ON t.id = l.target_user_id
     ORDER BY l.changed_at DESC
     LIMIT 200`
  );
  res.json(rows.map((r) => ({ ...r, label: (CATALOGUE_BY_KEY[r.permission_key] || {}).label || r.permission_key })));
});

export default router;
