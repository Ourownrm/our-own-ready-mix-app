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
       AND dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
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

// Today's orders assigned to this supervisor — for pump departure and
// site-ready confirmations, which are order-level, not ticket-level.
router.get("/my-orders", async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.order_date, o.scheduled_batching_time, o.pump_requirement,
            o.pump_departure_time, o.pump_actual_departure_time, o.site_ready_confirmed,
            c.name AS customer_name, s.name AS site_name
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     WHERE o.assigned_site_supervisor_id = $1
       AND o.order_date = CURRENT_DATE
       AND o.status NOT IN ('cancelled', 'closed')
     ORDER BY o.scheduled_batching_time`,
    [req.user.id]
  );
  res.json(rows);
});

// Site Supervisor confirms the pump has actually left the plant.
router.post("/orders/:orderId/confirm-pump-departure", async (req, res) => {
  const { rows } = await query(
    `UPDATE customer_orders SET pump_actual_departure_time = now(), pump_departure_confirmed_by = $1
     WHERE id = $2 AND assigned_site_supervisor_id = $1 RETURNING *`,
    [req.user.id, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  res.json(rows[0]);
});

// Site Supervisor confirms the site is ready to receive concrete — required
// once per order before the Plant Operator can start batching.
router.post("/orders/:orderId/confirm-site-ready", async (req, res) => {
  const { rows } = await query(
    `UPDATE customer_orders SET site_ready_confirmed = true, site_ready_confirmed_by = $1, site_ready_confirmed_at = now()
     WHERE id = $2 AND assigned_site_supervisor_id = $1 RETURNING *`,
    [req.user.id, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  res.json(rows[0]);
});

export default router;
