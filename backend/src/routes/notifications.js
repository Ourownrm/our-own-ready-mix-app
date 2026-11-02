import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { allow } from "../lib/permissions.js";

const router = Router();
// Round 260 — the Access Control page's "Notifications" function, not a role
// list. A Plant In Charge (the Plant Manager's deputy) given it also reads
// what is addressed to the Manager.
router.use(requireAuth);
router.get("*", allow([["admin.notifications", "view"]]));
router.post("*", allow([["admin.notifications", "edit"]]));
router.delete("*", allow([["admin.notifications", "edit"]]));
const rolesOf = (user) => (user.role === "plant_in_charge" ? [user.role, "manager"] : [user.role]);

// Everything addressed to this role broadly, or to this specific user.
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM notifications
     WHERE recipient_role = ANY($1::text[]) OR recipient_id = $2
     ORDER BY created_at DESC
     LIMIT 200`,
    [rolesOf(req.user), req.user.id]
  );
  res.json(rows);
});

router.get("/unread-count", async (req, res) => {
  const { rows } = await query(
    `SELECT COUNT(*) AS count FROM notifications
     WHERE (recipient_role = ANY($1::text[]) OR recipient_id = $2) AND is_read = false`,
    [rolesOf(req.user), req.user.id]
  );
  res.json({ count: Number(rows[0].count) });
});

router.post("/:id/read", async (req, res) => {
  await query(
    `UPDATE notifications SET is_read = true
     WHERE id = $1 AND (recipient_role = ANY($2::text[]) OR recipient_id = $3)`,
    [req.params.id, rolesOf(req.user), req.user.id]
  );
  res.json({ ok: true });
});

router.post("/mark-all-read", async (req, res) => {
  await query(
    `UPDATE notifications SET is_read = true
     WHERE (recipient_role = ANY($1::text[]) OR recipient_id = $2) AND is_read = false`,
    [rolesOf(req.user), req.user.id]
  );
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM notifications WHERE id = $1 AND (recipient_role = ANY($2::text[]) OR recipient_id = $3)`,
    [req.params.id, rolesOf(req.user), req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: "Notification not found." });
  res.json({ ok: true });
});

export default router;
