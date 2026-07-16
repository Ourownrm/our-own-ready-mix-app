import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "../db.js";

const router = Router();

// Admin creates all user accounts (SRS §2 — no public signup).
router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "Enter your phone number and password." });
  }

  const { rows } = await query(
    "SELECT id, name, phone, role, password_hash, is_active FROM users WHERE phone = $1",
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

  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

export default router;
