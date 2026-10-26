// Round 242 — the emergency lock's switch. See lib/lockdown.js.
//   GET  /api/lockdown          anyone: is the app locked, since when
//   GET  /api/lockdown/admin    Super Admin: + reason, who, recent history
//   POST /api/lockdown/on       Super Admin: lock now {reason}
//   POST /api/lockdown/off      Super Admin: unlock {password, sign_out_all}
import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { lockState, setLock, lockLog } from "../lib/lockdown.js";

const router = Router();

// Only a Super Admin by role — not the administrator, not a permission grant.
function superAdminOnly(req, res, next) {
  if (req.user?.role !== "super_admin") return res.status(403).json({ error: "Only a Super Admin can use the emergency lock." });
  next();
}

router.get("/", async (_req, res) => {
  const st = await lockState();
  res.json({ locked: !!st.is_on, since: st.is_on ? st.since : null });
});

router.get("/admin", requireAuth, superAdminOnly, async (_req, res) => {
  const st = await lockState({ fresh: true });
  res.json({ locked: !!st.is_on, since: st.since, reason: st.reason, set_by: st.set_by_name, sessions_after: st.sessions_after, log: await lockLog(15) });
});

router.post("/on", requireAuth, superAdminOnly, async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 300);
  const st = await setLock({ on: true, reason, userId: req.user.id, ip: req.ip });
  res.json({ locked: !!st.is_on, since: st.since });
});

router.post("/off", requireAuth, superAdminOnly, async (req, res) => {
  const password = String(req.body?.password || "");
  if (!password) return res.status(400).json({ error: "Type your password to unlock." });
  const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1 AND is_active`, [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(403).json({ error: "That password is not right — the app stays locked.", code: "bad_password" });
  }
  const st = await setLock({ on: false, userId: req.user.id, ip: req.ip, signOutAll: req.body?.sign_out_all !== false });
  res.json({ locked: !!st.is_on, signed_out: req.body?.sign_out_all !== false });
});

export default router;
