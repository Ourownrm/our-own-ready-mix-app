import { Router } from "express";
import { query, pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { confirmArrival, confirmUnloadingStart, confirmUnloadingComplete, confirmRejection } from "../lib/deliveryConfirmation.js";
import { pushToRole } from "../lib/push.js";

const router = Router();
router.use(requireAuth, requireRole("site_supervisor"));

// Deliveries headed to sites this supervisor is assigned to — every one
// still awaiting their confirmation, not just today's. Restricting this to
// ticket_date = CURRENT_DATE (as it used to be) meant an older delivery
// that never got confirmed simply vanished from this list the moment the
// day rolled over, even though it was still fully pending — the exact same
// stuck-trip bug already fixed for drivers, just never fixed here too.
router.get("/my-deliveries", async (req, res) => {
  const { rows } = await query(
    `WITH ticket_stages AS (
       SELECT ticket_id,
         MAX(event_time) FILTER (WHERE event_type = 'reached_site') AS site_in_at,
         MAX(event_time) FILTER (WHERE event_type = 'unloading_completed') AS site_out_at
       FROM trip_events GROUP BY ticket_id
     ),
     geofence_hints AS (
       SELECT ticket_id,
         MAX(detected_at) FILTER (WHERE event_type = 'reached_site') AS hint_reached_site_at,
         MAX(detected_at) FILTER (WHERE event_type = 'left_site') AS hint_left_site_at
       FROM geofence_events GROUP BY ticket_id
     )
     SELECT dt.id, dt.ticket_number, dt.status, dt.ticket_date, s.name AS site_name, c.name AS customer_name,
            m.name AS mix_grade_name, dt.loaded_quantity_m3,
            t.truck_number, u.name AS driver_name,
            -- Only meaningful while the real stage is still unconfirmed — once
            -- the supervisor taps arrival/unloading-complete for real, the
            -- earlier geofence hint no longer matters.
            CASE WHEN ts.site_in_at IS NULL THEN gh.hint_reached_site_at END AS hint_reached_site_at,
            CASE WHEN ts.site_out_at IS NULL THEN gh.hint_left_site_at END AS hint_left_site_at
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN customers c ON c.id = co.customer_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN trucks t ON t.id = dt.truck_id
     LEFT JOIN users u ON u.id = dt.driver_id
     LEFT JOIN ticket_stages ts ON ts.ticket_id = dt.id
     LEFT JOIN geofence_hints gh ON gh.ticket_id = dt.id
     WHERE co.assigned_site_supervisor_id = $1
       AND dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
     ORDER BY dt.ticket_date, dt.created_at`,
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
            o.site_ready_latitude, o.site_ready_longitude, o.site_ready_location_suspect,
            c.name AS customer_name, s.name AS site_name, sp.name AS sales_representative_name
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     LEFT JOIN salespersons sp ON sp.id = o.sales_representative_id
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
       pump_departure_delay_reason = COALESCE($2, pump_departure_delay_reason),
       pump_departure_delay_reason_by = CASE WHEN $2 IS NOT NULL THEN $1 ELSE pump_departure_delay_reason_by END,
       pump_departure_delay_reason_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE pump_departure_delay_reason_at END
     WHERE id = $3 AND assigned_site_supervisor_id = $1 RETURNING *`,
    [req.user.id, req.body.delay_reason || null, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  res.json(rows[0]);
});

// Distance in meters between two lat/lng points (small-scale approximation —
// fine at the few-hundred-metre range this is used for; the real precision
// work happens in Postgres's geo_distance_m for the scheduled geofence check).
function roughDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Site Supervisor confirms the site is ready to receive concrete — required
// once per order before the Plant Operator can start batching. If this is
// happening after the scheduled batching time, a reason is required.
//
// Also captures the Supervisor's own device location at this exact moment,
// if given — 99.9% of the time this tap happens from the actual site, which
// makes it a fresher, more precise geofence anchor for auto-detecting truck
// arrival than the site's own saved coordinate (which can be stale, or just
// a rough pin for a large site). Sanity-checked against the site's saved
// coordinate (when one exists): if the tap location is implausibly far from
// it, it's still recorded but flagged suspect and NOT used as the geofence
// anchor — the scheduled check falls back to the site's own coordinate
// instead of trusting a reading that's probably wrong (e.g. confirmed before
// actually leaving for site).
router.post("/orders/:orderId/confirm-site-ready", async (req, res) => {
  const { rows: check } = await query(
    `SELECT co.scheduled_batching_time, (co.order_date + co.scheduled_batching_time) < now() AS is_late,
            s.latitude AS site_latitude, s.longitude AS site_longitude
     FROM customer_orders co JOIN sites s ON s.id = co.site_id
     WHERE co.id = $1 AND co.assigned_site_supervisor_id = $2`,
    [req.params.orderId, req.user.id]
  );
  if (!check.length) return res.status(404).json({ error: "Order not found or not assigned to you." });
  if (check[0].scheduled_batching_time && check[0].is_late && !req.body.delay_reason) {
    return res.status(400).json({ error: "This is past the scheduled batching time — a reason for the delay is required." });
  }

  const { latitude, longitude } = req.body;
  let suspect = false;
  if (latitude != null && longitude != null && check[0].site_latitude != null && check[0].site_longitude != null) {
    const distance = roughDistanceMeters(latitude, longitude, check[0].site_latitude, check[0].site_longitude);
    suspect = distance > 500; // implausibly far from the site's own saved point
  }

  const { rows } = await query(
    `UPDATE customer_orders SET site_ready_confirmed = true, site_ready_confirmed_by = $1, site_ready_confirmed_at = now(),
       site_ready_delay_reason = COALESCE($2, site_ready_delay_reason),
       site_ready_delay_reason_by = CASE WHEN $2 IS NOT NULL THEN $1 ELSE site_ready_delay_reason_by END,
       site_ready_delay_reason_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE site_ready_delay_reason_at END,
       site_ready_latitude = COALESCE($4, site_ready_latitude),
       site_ready_longitude = COALESCE($5, site_ready_longitude),
       site_ready_location_suspect = $6
     WHERE id = $3 AND assigned_site_supervisor_id = $1 RETURNING *`,
    [req.user.id, req.body.delay_reason || null, req.params.orderId, latitude ?? null, longitude ?? null, suspect]
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

// Round 130 — Site Supervisor records cube samples taken while a truck is at
// site, completely independent of the arrival/unloading-complete/reject
// buttons above (explicit feedback: "record cube samples taken against
// truck anytime when truck is at site and save it independently without
// affecting other activity buttons"). Writes into the SAME site_cube_casts
// table Lab Technician's own "+ Record a site cast" already uses — site cube
// casting has always been modeled per-ORDER here, not per-ticket (see
// labTechnician.js's cast-delete route comment: "a site cast has no delivery
// ticket behind it"), so this resolves the ticket to its order and saves
// there. Upserts today's own entry (by this supervisor, for this order)
// rather than inserting a fresh row on every tap, so correcting the count
// later in the day updates one figure instead of piling up duplicates for
// Lab Technician to sort out — a Lab Technician's own entries (or an earlier
// day's) are untouched either way, since this only ever matches on
// (order_id, CURRENT_DATE, entered_by = this supervisor).
router.post("/:ticketId/site-cubes", async (req, res) => {
  const count = Number(req.body.number_of_cubes);
  if (!count || count <= 0) {
    return res.status(400).json({ error: "Number of cube samples is required." });
  }
  const { rows: ticketRows } = await query(
    `SELECT dt.id, dt.order_id FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     WHERE dt.id = $1 AND co.assigned_site_supervisor_id = $2`,
    [req.params.ticketId, req.user.id]
  );
  if (!ticketRows.length) return res.status(404).json({ error: "Delivery not found or not assigned to you." });
  const orderId = ticketRows[0].order_id;

  // A plain SELECT-then-INSERT/UPDATE here is racy: two near-simultaneous
  // taps (a double-tap, or a retry after a slow response on weak site
  // signal) could both see "nothing yet today" and both INSERT, leaving a
  // duplicate row instead of the single upserted one this route promises.
  // An advisory lock scoped to (this order, this supervisor) for the
  // duration of the check-and-write serializes that narrow window without a
  // schema change — a real UNIQUE constraint on (order_id, cast_date,
  // entered_by) isn't safe here since Lab Technician's own
  // POST /site-cube-casts intentionally allows more than one cast per order
  // per day (genuinely separate castings), and would start rejecting those.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [orderId, req.user.id]);
    const { rows: existing } = await client.query(
      `SELECT id FROM site_cube_casts WHERE order_id = $1 AND cast_date = CURRENT_DATE AND entered_by = $2`,
      [orderId, req.user.id]
    );
    const { rows } = existing.length
      ? await client.query(
          `UPDATE site_cube_casts SET number_of_cubes = $1, entered_at = now() WHERE id = $2 RETURNING id, entered_at, number_of_cubes`,
          [count, existing[0].id]
        )
      : await client.query(
          `INSERT INTO site_cube_casts (order_id, cast_date, number_of_cubes, entered_by)
           VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id, entered_at, number_of_cubes`,
          [orderId, count, req.user.id]
        );
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// So the recording card can show "already saved once today: N cubes, at
// HH:MM" (see the mockup this was built from) before the supervisor even
// taps Save — checked on load, same (order_id, CURRENT_DATE, entered_by)
// match the POST above upserts against.
router.get("/:ticketId/site-cubes/today", async (req, res) => {
  const { rows: ticketRows } = await query(
    `SELECT dt.order_id FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     WHERE dt.id = $1 AND co.assigned_site_supervisor_id = $2`,
    [req.params.ticketId, req.user.id]
  );
  if (!ticketRows.length) return res.status(404).json({ error: "Delivery not found or not assigned to you." });
  const { rows } = await query(
    `SELECT number_of_cubes, entered_at FROM site_cube_casts
     WHERE order_id = $1 AND cast_date = CURRENT_DATE AND entered_by = $2
     ORDER BY entered_at DESC LIMIT 1`,
    [ticketRows[0].order_id, req.user.id]
  );
  res.json(rows[0] || null);
});

export default router;
