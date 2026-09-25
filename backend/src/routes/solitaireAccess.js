// Main-app-side "MixTrack Access" API. This file lives on the MAIN app's
// side of the boundary — protected by the main app's own requireAuth /
// requireRole, NOT Solitaire's own auth (see routes/solitaire.js and
// middleware/solitaireAuth.js for that side). It is the ONE integration point
// between the two systems: granting access here creates a row in Solitaire's
// own solitaire_accounts table, which is otherwise entirely separate.
//
// Round 149 — TWO changes from how this file was originally written, both
// from the user's explicit instruction that the Delivery Challan module is a
// plugin an Administrator has no part in:
//
//   1. Granting is SUPER ADMIN only, not Administrator. The original draft
//      used requireRole("administrator") and the panel lived on the
//      Administrator screen. It now lives on the Super Admin screen, and the
//      matching catalogue function (admin.plugins) is locked, so there is no
//      permission an Administrator could be given that would reach it.
//      requireRole("super_admin") still admits a Super Admin only —
//      Round 148's bypass lets a super_admin through EVERY guard, but that
//      widens nothing here, since it is the named role.
//
//   2. The whole router sits behind requirePluginEnabled("solitaire"). When a
//      Super Admin switches the plugin off, granting and checking access stop
//      working too, not just the module itself. Otherwise "disabled" would
//      still let somebody be handed an account for a module that isn't there.
//
// GET /me is the one route any signed-in user may call — it answers only
// "have I been granted this?", and it is what makes the Plant Operator icon
// appear. It is inside the plugin guard, so when the plugin is off it 404s
// and the icon disappears with it.
import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js"; // MAIN APP auth
import { requirePluginEnabled } from "../lib/plugins.js";
import { requireSolitaireConfigured } from "../lib/solitaireAuth.js";

const router = Router();
// Plugin gate FIRST, above auth: a switched-off module answers the same to
// everyone, signed in or not, so there is nothing to probe.
router.use(requirePluginEnabled("solitaire"));
router.use(requireSolitaireConfigured);
router.use(requireAuth);

// Any logged-in main-app user can check their OWN Solitaire access — this
// is what drives whether the "MixTrack" button shows on their dashboard.
// Deliberately not admin-gated (unlike everything else in this file).
router.get("/me", async (req, res) => {
  const { rows } = await query(
    `SELECT username FROM solitaire_accounts WHERE granted_to_user_id = $1 AND is_active = true`,
    [req.user.id]
  );
  res.json({ has_access: rows.length > 0 });
});

router.use(requireRole("super_admin"));

// Every active staff user, with whatever Solitaire account they currently
// have (if any) — for the admin panel's list/grant/revoke UI.
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.phone, u.role,
            sa.id AS solitaire_account_id, sa.username AS solitaire_username,
            sa.role AS solitaire_role, sa.is_active AS solitaire_is_active, sa.granted_at
     FROM users u
     LEFT JOIN solitaire_accounts sa ON sa.granted_to_user_id = u.id
     WHERE u.is_active
     ORDER BY u.name`
  );
  res.json(rows);
});

// Grants (or re-grants, if previously revoked) Solitaire access to a staff
// user. The Super Admin sets the username/password/role directly here — not a
// self-serve first-login flow. Re-granting an existing account overwrites the
// password, which is deliberately how a forgotten one is reset: Solitaire has
// no password-reset of its own, and no main-app Administrator route reaches
// these credentials.
router.post("/:userId/grant", async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: "Username, password, and MixTrack role are all required." });
  }
  if (!["operator", "qc", "admin"].includes(role)) {
    return res.status(400).json({ error: "Role must be operator, qc, or admin." });
  }

  const { rows: userRows } = await query(`SELECT id, name FROM users WHERE id = $1 AND is_active`, [req.params.userId]);
  if (!userRows.length) return res.status(404).json({ error: "User not found." });

  // solitaire_accounts.username is UNIQUE, so without this the insert fails
  // with a raw constraint error the page can only show as "something went
  // wrong". Excluding this same person's row means re-granting them under
  // their existing username is not a clash with themselves.
  const { rows: clash } = await query(
    `SELECT id FROM solitaire_accounts WHERE username = $1 AND granted_to_user_id IS DISTINCT FROM $2`,
    [username.trim(), req.params.userId]
  );
  if (clash.length) return res.status(400).json({ error: "That MixTrack username is already taken." });

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO solitaire_accounts (granted_to_user_id, username, password_hash, role, display_name, granted_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (granted_to_user_id) DO UPDATE SET
       username = $2, password_hash = $3, role = $4, display_name = $5,
       is_active = true, granted_by = $6, granted_at = now(), revoked_by = NULL, revoked_at = NULL
     RETURNING id, username, role, granted_at`,
    [req.params.userId, username.trim(), passwordHash, role, userRows[0].name, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Revokes access — that user's "MixTrack" dashboard button disappears
// (their own GET /me above starts returning has_access: false). Device
// authorizations are untouched: the device-lock is a separate, company-wide
// concept, not tied to any one account.
router.post("/:userId/revoke", async (req, res) => {
  const { rows } = await query(
    `UPDATE solitaire_accounts SET is_active = false, revoked_by = $1, revoked_at = now()
     WHERE granted_to_user_id = $2 RETURNING id`,
    [req.user.id, req.params.userId]
  );
  if (!rows.length) return res.status(404).json({ error: "This user has no MixTrack account to revoke." });
  res.json({ ok: true });
});

export default router;
