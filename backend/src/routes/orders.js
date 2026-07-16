import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// List orders — running (today) and scheduled (future), visible to all roles per business rule
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     WHERE o.order_date >= CURRENT_DATE - INTERVAL '1 day'
     ORDER BY o.order_date, o.scheduled_batching_time`
  );
  res.json(rows);
});

// Create order — Manager or Administrator only
router.post("/", requireRole("manager", "administrator"), async (req, res) => {
  const {
    order_date, scheduled_batching_time, truck_dispatch_interval_minutes,
    customer_id, site_id, mix_grade_id, pump_requirement,
    site_technician_required, cube_samples_required, assigned_pump_crew,
    assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
    sales_representative, casting_location, pump_departure_time, remarks,
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
      mix_grade_id, pump_requirement, site_technician_required, cube_samples_required,
      assigned_pump_crew, assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
      sales_representative, casting_location, pump_departure_time, remarks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [order_date, scheduled_batching_time, truck_dispatch_interval_minutes, customer_id, site_id,
     mix_grade_id, pump_requirement, !!site_technician_required, cube_samples_required,
     assigned_pump_crew, assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
     sales_representative, casting_location, pump_departure_time, remarks, req.user.id]
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

export default router;
