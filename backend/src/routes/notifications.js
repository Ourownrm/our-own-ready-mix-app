import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("manager", "administrator"));

// Everything addressed to this role broadly, or to this specific user.
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM notifications
     WHERE recipient_role = $1 OR recipient_id = $2
     ORDER BY created_at DESC
     LIMIT 200`,
    [req.user.role, req.user.id]
  );
  res.json(rows);
});

router.get("/unread-count", async (req, res) => {
  const { rows } = await query(
    `SELECT COUNT(*) AS count FROM notifications
     WHERE (recipient_role = $1 OR recipient_id = $2) AND is_read = false`,
    [req.user.role, req.user.id]
  );
  res.json({ count: Number(rows[0].count) });
});

router.post("/:id/read", async (req, res) => {
  await query(
    `UPDATE notifications SET is_read = true
     WHERE id = $1 AND (recipient_role = $2 OR recipient_id = $3)`,
    [req.params.id, req.user.role, req.user.id]
  );
  res.json({ ok: true });
});

router.post("/mark-all-read", async (req, res) => {
  await query(
    `UPDATE notifications SET is_read = true
     WHERE (recipient_role = $1 OR recipient_id = $2) AND is_read = false`,
    [req.user.role, req.user.id]
  );
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM notifications WHERE id = $1 AND (recipient_role = $2 OR recipient_id = $3)`,
    [req.params.id, req.user.role, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: "Notification not found." });
  res.json({ ok: true });
});

export default router;
