import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { permissionsForClient } from "../lib/permissions.js";
import { PERMISSION_BY_SCREEN } from "../lib/permissionCatalogue.js";

const router = Router();

// Admin creates all user accounts (SRS §2 — no public signup).
router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "Enter your phone number and password." });
  }

  const { rows } = await query(
    "SELECT id, name, phone, role, password_hash, is_active, preferred_language FROM users WHERE phone = $1",
    [phone]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    return res.status(401).json({ error: "That phone number and password don't match." });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "That phone number and password don't match." });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "30d" } // long-lived: field staff shouldn't need to re-login constantly
  );

  res.json({ token, user: { id: user.id, name: user.name, role: user.role, preferred_language: user.preferred_language || "en" } });
});

// Round 146 — what this person may actually do, resolved per request rather
// than carried in the token. The token lives 30 days; a permission changed
// today has to bite today, so the frontend asks here on load and the answer is
// cached for a few seconds server-side (see lib/permissions.js).
router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await query(
    "SELECT id, name, phone, role::text AS role, is_active, preferred_language FROM users WHERE id = $1",
    [req.user.id]
  );
  const user = rows[0];
  if (!user || !user.is_active) return res.status(401).json({ error: "Sign in to continue." });
  // The screen -> permission map travels with it so the dashboard can hide a
  // tile without a second request, and without the frontend keeping its own
  // copy of the mapping that could drift from the catalogue.
  res.json({ user, permissions: await permissionsForClient(user), permission_by_screen: PERMISSION_BY_SCREEN });
});

export default router;
