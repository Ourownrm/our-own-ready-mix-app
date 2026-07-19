import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

async function logEvent(ticketId, eventType, extra = {}) {
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by, latitude, longitude)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ticketId, eventType, extra.source || "auto", extra.editedBy || null,
     extra.lat || null, extra.lng || null]
  );
}

// Plant Operator creates a ticket against an existing order (SRS §5, §5A link)
router.post("/", requireRole("plant_operator", "manager", "administrator"), async (req, res) => {
  const { order_id, ticket_number, loaded_quantity_m3, truck_id, driver_id, pump_id, remarks } = req.body;
  if (!order_id || !ticket_number || !truck_id || !driver_id) {
    return res.status(400).json({ error: "Order, ticket number, truck, and driver are required." });
  }

  const { rows } = await query(
    `INSERT INTO delivery_tickets
     (ticket_number, order_id, loaded_quantity_m3, truck_id, driver_id, plant_operator_id, pump_id, remarks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ticket_number, order_id, loaded_quantity_m3, truck_id, driver_id, req.user.id, pump_id, remarks]
  );
  await logEvent(rows[0].id, "created");
  res.status(201).json(rows[0]);
});

// Driver's currently assigned, not-yet-completed trip — powers the Driver duty screen
router.get("/my-trip", requireRole("driver"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, t.truck_number, t.id AS truck_id, s.name AS site_name,
            s.address AS site_address, s.latitude AS site_latitude, s.longitude AS site_longitude,
            tac.amount AS trip_allowance_amount
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     LEFT JOIN trip_allowance_categories tac ON tac.id = s.trip_allowance_category_id
     WHERE dt.driver_id = $1 AND dt.status NOT IN ('completed', 'cancelled', 'returned')
     ORDER BY dt.created_at DESC LIMIT 1`,
    [req.user.id]
  );
  res.json(rows[0] || null);
});

// Full trip status timeline for one ticket
router.get("/:id/timeline", async (req, res) => {
  const { rows } = await query(
    `SELECT event_type, event_time, source FROM trip_events
     WHERE ticket_id = $1 ORDER BY event_time`,
    [req.params.id]
  );
  res.json(rows);
});

// Generic status/event update — used by Plant QC, Driver duty, Site Supervisor actions
router.post("/:id/events", async (req, res) => {
  const { event_type, status, lat, lng } = req.body;
  await logEvent(req.params.id, event_type, { editedBy: req.user.id, lat, lng });
  if (status) {
    await query("UPDATE delivery_tickets SET status = $1 WHERE id = $2", [status, req.params.id]);
  }

  // Trip allowance is only earned once the delivery is completed (business rule confirmed earlier)
  if (event_type === "unloading_completed" || status === "completed") {
    const { rows: ticketRows } = await query(
      `SELECT dt.driver_id, s.trip_allowance_category_id, tac.amount
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN sites s ON s.id = co.site_id
       JOIN trip_allowance_categories tac ON tac.id = s.trip_allowance_category_id
       WHERE dt.id = $1`,
      [req.params.id]
    );
    const info = ticketRows[0];
    if (info) {
      await query(
        `INSERT INTO trip_allowance_payouts (ticket_id, driver_id, amount)
         VALUES ($1, $2, $3) ON CONFLICT (ticket_id) DO NOTHING`,
        [req.params.id, info.driver_id, info.amount]
      );
    }
  }

  res.json({ ok: true });
});

export default router;
