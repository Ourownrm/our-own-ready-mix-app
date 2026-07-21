import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// List orders — running (today), scheduled (future), and any not-yet-completed
// order from an earlier day, which carries forward automatically instead of
// disappearing (it stays visible every day until completed or closed).
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status = 'completed'), 0) AS delivered_qty_m3
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     LEFT JOIN delivery_tickets dt ON dt.order_id = o.id
     WHERE o.order_date >= CURRENT_DATE - INTERVAL '1 day'
        OR o.status NOT IN ('completed', 'cancelled', 'closed')
     GROUP BY o.id, c.name, s.name, m.name
     ORDER BY o.order_date, o.scheduled_batching_time`
  );
  res.json(rows);
});

// Manager formally closes an order that will never be completed. Distinct from
// Administrator's "cancel" — same effect (stops it from carrying forward or
// counting as running/upcoming) but keeps its own status so the two read
// differently in the UI and reports.
router.post("/:id/close", requireRole("manager", "administrator"), async (req, res) => {
  const { reason } = req.body;
  const { rows } = await query(
    `UPDATE customer_orders
     SET status = 'closed', closed_by = $1, closed_at = now(),
         closure_reason = COALESCE($2, closure_reason)
     WHERE id = $3 RETURNING *`,
    [req.user.id, reason || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found." });
  res.json(rows[0]);
});

// Create order — Manager or Administrator only
router.post("/", requireRole("manager", "administrator"), async (req, res) => {
  const {
    order_date, scheduled_batching_time, truck_dispatch_interval_minutes,
    customer_id, site_id, mix_grade_id, pump_requirement, pump_id,
    site_technician_required, cube_samples_required, assigned_pump_crew,
    assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
    sales_representative_id, casting_location, pump_departure_time, remarks,
  } = req.body;

  const required = { order_date, scheduled_batching_time, truck_dispatch_interval_minutes,
    customer_id, site_id, mix_grade_id, pump_requirement, site_contact_number, order_quantity_m3 };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === "") {
      return res.status(400).json({ error: `${key.replaceAll("_", " ")} is required.` });
    }
  }

  const { rows } = await query(
    `INSERT INTO customer_orders
     (order_date, scheduled_batching_time, truck_dispatch_interval_minutes, customer_id, site_id,
      mix_grade_id, pump_requirement, pump_id, site_technician_required, cube_samples_required,
      assigned_pump_crew, assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
      sales_representative_id, casting_location, pump_departure_time, remarks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [order_date, scheduled_batching_time, truck_dispatch_interval_minutes, customer_id, site_id,
     mix_grade_id, pump_requirement, pump_id || null, !!site_technician_required, cube_samples_required,
     assigned_pump_crew || null, assigned_site_supervisor_id || null, site_contact_number, order_quantity_m3,
     sales_representative_id || null, casting_location || null, pump_departure_time || null, remarks || null, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Manager dashboard KPIs — production totals, fleet counts, alerts
router.get("/dashboard", requireRole("manager", "administrator"), async (req, res) => {
  const [today, month, fleet, delayed, rejected] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total
       FROM delivery_tickets dt
       WHERE dt.status = 'completed' AND dt.ticket_date = CURRENT_DATE`
    ),
    query(
      `SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total
       FROM delivery_tickets dt
       WHERE dt.status = 'completed' AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`
    ),
    query(
      `SELECT status, COUNT(*) AS count FROM delivery_tickets
       WHERE ticket_date = CURRENT_DATE AND status NOT IN ('completed', 'cancelled')
       GROUP BY status`
    ),
    query(
      `SELECT COUNT(*) AS count FROM delivery_tickets dt
       JOIN trip_events te ON te.ticket_id = dt.id AND te.event_type = 'reached_site'
       WHERE dt.ticket_date = CURRENT_DATE AND dt.status NOT IN ('completed', 'cancelled')
       AND te.event_time < now() - INTERVAL '2 hours'`
    ),
    query(
      `SELECT COUNT(*) AS count FROM site_qc sq
       JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       WHERE sq.accepted = false AND dt.ticket_date = CURRENT_DATE`
    ),
  ]);

  res.json({
    today_production_m3: today.rows[0].total,
    monthly_production_m3: month.rows[0].total,
    fleet_status: fleet.rows,
    delayed_trucks: Number(delayed.rows[0].count),
    rejected_concrete: Number(rejected.rows[0].count),
  });
});

// Active trucks today — matches the original "Active trucks" mockup table.
// Also flags any truck that has been sitting at site more than 2 hours since
// arrival (site_supervisor's "reached_site" confirmation) so the delay is
// visible right on this list, not just as a background count.
router.get("/active-trucks", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.status, dt.created_at,
            t.truck_number, u.name AS driver_name, c.name AS customer_name, s.name AS site_name,
            rs.event_time AS reached_site_at,
            CASE WHEN dt.status IN ('reached_site', 'unloading') AND rs.event_time IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (now() - rs.event_time)) / 60
            END AS minutes_at_site
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN users u ON u.id = dt.driver_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     LEFT JOIN LATERAL (
       SELECT event_time FROM trip_events
       WHERE ticket_id = dt.id AND event_type = 'reached_site'
       ORDER BY event_time DESC LIMIT 1
     ) rs ON true
     WHERE dt.ticket_date = CURRENT_DATE AND dt.status NOT IN ('completed', 'cancelled', 'returned')
     ORDER BY dt.created_at`
  );
  res.json(rows);
});

// Completed trips today, with the full timeline: batching (ticket created),
// left plant (dispatched by QC), reached site, unloading start, unloading finish.
router.get("/completed-trips", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, t.truck_number, u.name AS driver_name,
            c.name AS customer_name, s.name AS site_name, dt.loaded_quantity_m3,
            dt.created_at AS batch_time,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'dispatched') AS left_plant_time,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'reached_site') AS reached_site_time,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_started') AS unloading_start_time,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_completed') AS unloading_finish_time
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN users u ON u.id = dt.driver_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     LEFT JOIN trip_events te ON te.ticket_id = dt.id
     WHERE dt.ticket_date = CURRENT_DATE AND dt.status = 'completed'
     GROUP BY dt.id, t.truck_number, u.name, c.name, s.name, dt.loaded_quantity_m3, dt.created_at
     ORDER BY dt.created_at DESC`
  );
  res.json(rows);
});

// Latest known position for every truck currently on an active trip
router.get("/live-locations", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (dt.id)
            dt.id AS ticket_id, dt.ticket_number, t.truck_number, u.name AS driver_name,
            s.name AS site_name, gp.latitude, gp.longitude, gp.recorded_at
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN users u ON u.id = dt.driver_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN gps_pings gp ON gp.ticket_id = dt.id
     WHERE dt.status NOT IN ('completed', 'cancelled', 'returned') AND dt.ticket_date = CURRENT_DATE
     ORDER BY dt.id, gp.recorded_at DESC`
  );
  res.json(rows);
});

// Every driver currently on duty, regardless of whether they have a truck
// assigned or a delivery ticket created yet — small sites and plant waiting
// time still need to be trackable. Stays listed here until the driver
// explicitly presses Duty OFF; a gap in recent GPS pings (backgrounded app,
// bad signal) is shown as "last seen" rather than dropping them off the list.
router.get("/on-duty-drivers", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (d.driver_id)
            d.driver_id, u.name AS driver_name, d.event_time AS duty_since,
            gp.latitude, gp.longitude, gp.recorded_at,
            dt.id AS ticket_id, dt.ticket_number, t.truck_number
     FROM (
       SELECT DISTINCT ON (driver_id) driver_id, is_on, event_time
       FROM driver_duty_log ORDER BY driver_id, event_time DESC
     ) d
     JOIN users u ON u.id = d.driver_id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, recorded_at FROM gps_pings
       WHERE driver_id = d.driver_id ORDER BY recorded_at DESC LIMIT 1
     ) gp ON true
     LEFT JOIN LATERAL (
       SELECT id, ticket_number, truck_id FROM delivery_tickets
       WHERE driver_id = d.driver_id AND status NOT IN ('completed', 'cancelled', 'returned')
       ORDER BY created_at DESC LIMIT 1
     ) dt ON true
     LEFT JOIN trucks t ON t.id = dt.truck_id
     WHERE d.is_on = true
     ORDER BY d.driver_id, d.event_time DESC`
  );
  res.json(rows);
});

// Full order detail — every role can view (read-only); editing stays restricted
// to Administrator's "Correct orders" panel.
router.get("/:id", async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name, p.pump_code, sup.name AS site_supervisor_name,
            sp.name AS sales_representative_name, creator.name AS created_by_name,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status = 'completed'), 0) AS delivered_qty_m3
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     LEFT JOIN pumps p ON p.id = o.pump_id
     LEFT JOIN users sup ON sup.id = o.assigned_site_supervisor_id
     LEFT JOIN salespersons sp ON sp.id = o.sales_representative_id
     LEFT JOIN users creator ON creator.id = o.created_by
     LEFT JOIN delivery_tickets dt ON dt.order_id = o.id
     WHERE o.id = $1
     GROUP BY o.id, c.name, s.name, s.address, m.name, p.pump_code, sup.name, sp.name, creator.name`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found." });
  res.json(rows[0]);
});

export default router;
