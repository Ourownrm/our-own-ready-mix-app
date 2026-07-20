import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { confirmArrival, confirmUnloadingStart, confirmUnloadingComplete, confirmRejection } from "../lib/deliveryConfirmation.js";

const router = Router();
router.use(requireAuth, requireRole("site_supervisor"));

// Today's deliveries headed to sites this supervisor is assigned to
router.get("/my-deliveries", async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, dt.status, s.name AS site_name, c.name AS customer_name,
            m.name AS mix_grade_name, dt.loaded_quantity_m3,
            t.truck_number, u.name AS driver_name
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN customers c ON c.id = co.customer_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN trucks t ON t.id = dt.truck_id
     LEFT JOIN users u ON u.id = dt.driver_id
     WHERE co.assigned_site_supervisor_id = $1
       AND dt.ticket_date = CURRENT_DATE
       AND dt.status NOT IN ('completed', 'cancelled', 'returned')
     ORDER BY dt.created_at`,
    [req.user.id]
  );
  res.json(rows);
});

// Confirm truck arrival at site
router.post("/:ticketId/arrival", async (req, res) => {
  await confirmArrival(req.params.ticketId, req.user.id);
  res.json({ ok: true });
});

// Confirm unloading start
router.post("/:ticketId/unloading-start", async (req, res) => {
  await confirmUnloadingStart(req.params.ticketId, req.user.id);
  res.json({ ok: true });
});

// Confirm unloading completion + record site slump — this is what triggers trip allowance payout
router.post("/:ticketId/unloading-complete", async (req, res) => {
  await confirmUnloadingComplete(req.params.ticketId, req.user.id, req.body);
  res.json({ ok: true });
});

// Reject concrete — no trip allowance, notifies manager and accountant
router.post("/:ticketId/reject", async (req, res) => {
  await confirmRejection(req.params.ticketId, req.user.id, req.body);
  res.json({ ok: true });
});

export default router;
