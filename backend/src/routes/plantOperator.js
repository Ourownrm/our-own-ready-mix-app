import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("plant_operator", "manager", "administrator"));

async function logEvent(ticketId, eventType, userId) {
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by)
     VALUES ($1, $2, 'manual', $3)`,
    [ticketId, eventType, userId]
  );
}

// Orders with remaining quantity still available to dispatch — powers the "Select order" dropdown
router.get("/available-orders", async (req, res) => {
  const { rows } = await query(
    `SELECT co.id, co.order_quantity_m3, c.name AS customer_name, s.name AS site_name,
            m.name AS mix_grade_name,
            COALESCE(SUM(dt.loaded_quantity_m3), 0) AS dispatched_so_far
     FROM customer_orders co
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN delivery_tickets dt ON dt.order_id = co.id AND dt.status != 'cancelled'
     WHERE co.order_date = CURRENT_DATE AND co.status IN ('planned', 'in_progress', 'partially_completed')
     GROUP BY co.id, c.name, s.name, m.name
     HAVING COALESCE(SUM(dt.loaded_quantity_m3), 0) < co.order_quantity_m3
     ORDER BY co.scheduled_batching_time`
  );
  res.json(rows);
});

// Create a delivery ticket against an order
router.post("/tickets", requireRole("plant_operator", "administrator"), async (req, res) => {
  const { order_id, loaded_quantity_m3, truck_id, driver_id } = req.body;
  if (!order_id || !loaded_quantity_m3 || !truck_id || !driver_id) {
    return res.status(400).json({ error: "Order, quantity, truck, and driver are all required." });
  }

  const { rows: countRows } = await query(
    "SELECT COUNT(*) FROM delivery_tickets WHERE ticket_date = CURRENT_DATE"
  );
  const ticketNumber = `DT-${2200 + Number(countRows[0].count) + 1}`;

  const { rows } = await query(
    `INSERT INTO delivery_tickets (ticket_number, order_id, loaded_quantity_m3, truck_id, driver_id, plant_operator_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ticketNumber, order_id, loaded_quantity_m3, truck_id, driver_id, req.user.id]
  );
  await logEvent(rows[0].id, "created", req.user.id);

  await query(
    `UPDATE customer_orders SET status = 'in_progress' WHERE id = $1 AND status = 'planned'`,
    [order_id]
  );

  res.status(201).json(rows[0]);
});

export default router;
