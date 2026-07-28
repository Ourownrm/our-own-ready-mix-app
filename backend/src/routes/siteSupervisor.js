import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { confirmArrival, confirmUnloadingStart, confirmUnloadingComplete, confirmRejection } from "../lib/deliveryConfirmation.js";
import { pushToRole } from "../lib/push.js";

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
            o.pump_departure_time, o.pump_actual_departure_time, o.pump_departure_delay_reason,
            o.site_ready_confirmed, o.site_ready_delay_reason, o.supervisor_marked_complete,
            c.name AS customer_name, s.name AS site_name
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     WHERE o.assigned_site_supervisor_id = $1
       AND o.order_date = CURRENT_DATE
       AND o.status NOT IN ('cancelled', 'closed', 'completed')
       AND NOT o.supervisor_marked_complete
     ORDER BY o.scheduled_batching_time`,
    [req.user.id]
  );
  res.json(rows);
});

// Site Supervisor confirms the pump has actually left the plant. If this is
// happening after the scheduled departure time, a reason is required.
router.post("/orders/:orderId/confirm-pump-departure", async (req, res) => {
  const { rows: check } = await query(
    `SELECT pump_departure_time, (order_date + pump_departure_time) < now() AS is_late
     FROM customer_orders WHERE id = $1 AND assigned_site_supervisor_id = $2`,
    [req.params.orderId, req.user.id]
  );
  if (!check.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  if (check[0].pump_departure_time && check[0].is_late && !req.body.delay_reason) {
    return res.status(400).json({ error: "This is past the scheduled departure time — a reason for the delay is required." });
  }

  const { rows } = await query(
    `UPDATE customer_orders SET pump_actual_departure_time = now(), pump_departure_confirmed_by = $1,
       pump_departure_delay_reason = COALESCE($2, pump_departure_delay_reason)
     WHERE id = $3 AND assigned_site_supervisor_id = $1 RETURNING *`,
    [req.user.id, req.body.delay_reason || null, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  res.json(rows[0]);
});

// Site Supervisor confirms the site is ready to receive concrete — required
// once per order before the Plant Operator can start batching. If this is
// happening after the scheduled batching time, a reason is required.
router.post("/orders/:orderId/confirm-site-ready", async (req, res) => {
  const { rows: check } = await query(
    `SELECT scheduled_batching_time, (order_date + scheduled_batching_time) < now() AS is_late
     FROM customer_orders WHERE id = $1 AND assigned_site_supervisor_id = $2`,
    [req.params.orderId, req.user.id]
  );
  if (!check.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  if (check[0].scheduled_batching_time && check[0].is_late && !req.body.delay_reason) {
    return res.status(400).json({ error: "This is past the scheduled batching time — a reason for the delay is required." });
  }

  const { rows } = await query(
    `UPDATE customer_orders SET site_ready_confirmed = true, site_ready_confirmed_by = $1, site_ready_confirmed_at = now(),
       site_ready_delay_reason = COALESCE($2, site_ready_delay_reason)
     WHERE id = $3 AND assigned_site_supervisor_id = $1 RETURNING *`,
    [req.user.id, req.body.delay_reason || null, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  res.json(rows[0]);
});

// Site Supervisor flags the work as finished — this is a SIGNAL to Manager,
// not a status change. It doesn't touch `status` (which already has its own
// meaning driven by delivered quantity, and reusing it here was confusing —
// it looked identical to genuine completion). Manager reviews the signal and
// explicitly confirms completion separately.
router.post("/orders/:orderId/mark-work-completed", async (req, res) => {
  const { after_pour_care_confirmed, remarks } = req.body;
  if (after_pour_care_confirmed !== true) {
    return res.status(400).json({ error: "Confirm you've guided the customer on after-pour care before marking work completed." });
  }
  const { rows } = await query(
    `UPDATE customer_orders SET supervisor_marked_complete = true, supervisor_marked_complete_by = $1, supervisor_marked_complete_at = now(),
       after_pour_care_confirmed = true, work_completion_remarks = $2
     WHERE id = $3 AND assigned_site_supervisor_id = $1
       AND status NOT IN ('cancelled', 'closed', 'completed')
     RETURNING *`,
    [req.user.id, remarks || null, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found, not assigned to you, or already closed out." });

  const { rows: orderInfo } = await query(
    "SELECT c.name AS customer_name, s.name AS site_name FROM customer_orders o JOIN customers c ON c.id = o.customer_id JOIN sites s ON s.id = o.site_id WHERE o.id = $1",
    [req.params.orderId]
  );
  const label = orderInfo[0] ? `${orderInfo[0].customer_name} — ${orderInfo[0].site_name}` : "an order";
  await query(
    `INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('manager', $1, 'work_marked_complete', $2)`,
    [req.params.orderId, `Site Supervisor marked work completed — ${label}. Review and confirm.`]
  );
  await pushToRole("manager", { title: "Work marked completed", body: label, url: "/manager" });

  res.json(rows[0]);
});

export default router;
