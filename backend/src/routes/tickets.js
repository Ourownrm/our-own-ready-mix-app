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

// Every trip that still needs driver action, plus today's completed ones —
// replaces the old single-trip "LIMIT 1" query, which is exactly why a
// second trip assigned before the first was closed out made the first one
// silently disappear from the driver's screen with no way to act on it.
router.get("/my-trips", requireRole("driver"), async (req, res) => {
  const { rows } = await query(
    `WITH ticket_stages AS (
       SELECT ticket_id,
         MAX(event_time) FILTER (WHERE event_type = 'left_plant') AS plant_out_at,
         MAX(event_time) FILTER (WHERE event_type = 'reached_site') AS site_in_at,
         MAX(event_time) FILTER (WHERE event_type = 'unloading_completed') AS site_out_at,
         MAX(event_time) FILTER (WHERE event_type = 'returned_to_plant') AS plant_in_at
       FROM trip_events GROUP BY ticket_id
     ),
     geofence_hints AS (
       SELECT ticket_id,
         MAX(detected_at) FILTER (WHERE event_type = 'left_plant') AS hint_plant_out_at,
         MAX(detected_at) FILTER (WHERE event_type = 'returned_to_plant') AS hint_plant_in_at,
         MAX(detected_at) FILTER (WHERE event_type = 'reached_site') AS hint_site_in_at,
         MAX(detected_at) FILTER (WHERE event_type = 'left_site') AS hint_site_out_at
       FROM geofence_events GROUP BY ticket_id
     )
     SELECT dt.id, dt.ticket_number, dt.status, dt.created_at, dt.ticket_date,
            t.truck_number, t.id AS truck_id,
            c.name AS customer_name, s.name AS site_name,
            m.name AS mix_grade_name, dt.loaded_quantity_m3,
            -- Round 119, post-ship again round 3: same grace-period setting
            -- driving GPS auto-record server-side (see checkPlantOutAutoRecord
            -- and its 3 siblings in scheduledChecks.js) — exposed here so the
            -- driver's geofence-hint popup can show an accurate countdown to
            -- the same deadline, not a made-up number.
            COALESCE(s.plant_out_grace_minutes, 12) AS auto_confirm_grace_minutes,
            -- The site's saved coordinate is often unset or rough. Prefer the
            -- Site Supervisor's fresh GPS capture from their Site Ready tap
            -- on this order when it's available and wasn't flagged as
            -- implausibly far from the saved site — that's the more precise,
            -- more current point, and without this fallback the "Site
            -- location" link simply never showed for any site missing a
            -- saved coordinate, which is most of them.
            COALESCE(
              CASE WHEN co.site_ready_location_suspect THEN NULL ELSE co.site_ready_latitude END,
              s.latitude
            ) AS site_latitude,
            COALESCE(
              CASE WHEN co.site_ready_location_suspect THEN NULL ELSE co.site_ready_longitude END,
              s.longitude
            ) AS site_longitude,
            s.distance_from_plant_km,
            tac.amount AS trip_allowance_amount,
            tap.amount AS allowance_paid,
            (co.assigned_site_supervisor_id IS NULL) AS no_site_supervisor,
            sup.name AS site_supervisor_name,
            ts.plant_out_at, ts.site_in_at, ts.site_out_at, ts.plant_in_at,
            -- Only meaningful while the real stage is still unconfirmed — once
            -- the driver taps it for real, the earlier hint no longer matters.
            -- Site In/Out hints are only ever actionable by the driver on a
            -- self-service site (no_site_supervisor) — on a supervised site
            -- these two stages are the Supervisor's own to confirm (they get
            -- the matching hint on their own screen, see siteSupervisor.js),
            -- so the frontend gates display on no_site_supervisor even though
            -- the raw hint is included here either way.
            CASE WHEN ts.plant_out_at IS NULL THEN gh.hint_plant_out_at END AS hint_plant_out_at,
            CASE WHEN ts.plant_in_at IS NULL THEN gh.hint_plant_in_at END AS hint_plant_in_at,
            CASE WHEN ts.site_in_at IS NULL THEN gh.hint_site_in_at END AS hint_site_in_at,
            CASE WHEN ts.site_out_at IS NULL THEN gh.hint_site_out_at END AS hint_site_out_at
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN users sup ON sup.id = co.assigned_site_supervisor_id
     LEFT JOIN trip_allowance_categories tac ON tac.id = s.trip_allowance_category_id
     LEFT JOIN ticket_stages ts ON ts.ticket_id = dt.id
     LEFT JOIN geofence_hints gh ON gh.ticket_id = dt.id
     LEFT JOIN trip_allowance_payouts tap ON tap.ticket_id = dt.id
     WHERE dt.driver_id = $1
       AND (
         dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
         OR dt.ticket_date = CURRENT_DATE
       )
     ORDER BY dt.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
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
