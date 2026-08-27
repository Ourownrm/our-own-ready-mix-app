import { Router } from "express";
import { randomBytes } from "crypto";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole } from "../lib/push.js";

const router = Router();
router.use(requireAuth);

// List orders — running (today), scheduled (future), and any not-yet-completed
// order from an earlier day, which carries forward automatically instead of
// disappearing (it stays visible every day until completed or closed).
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status != 'cancelled'), 0)
              - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS delivered_qty_m3,
            MIN(dt.created_at) AS first_ticket_created_at
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     LEFT JOIN delivery_tickets dt ON dt.order_id = o.id
     LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
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
     SET status = 'closed', closed_by = $1, closed_at = now(), terminal_at = now(),
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
    sales_representative_id, casting_location, specified_slump_mm, pump_departure_time, remarks,
    pump_charge_applicable, pump_charge_amount, part_load_applicable, part_load_charge_amount,
  } = req.body;

  const required = { order_date, scheduled_batching_time, truck_dispatch_interval_minutes,
    customer_id, site_id, mix_grade_id, pump_requirement, site_contact_number, order_quantity_m3 };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === "") {
      return res.status(400).json({ error: `${key.replaceAll("_", " ")} is required.` });
    }
  }

  // Both are Manager's own decisions, not automatic — enforced here too, not
  // just in the form, in case anything ever posts to this endpoint directly.
  if (pump_requirement !== "without_pump" && pump_charge_applicable === undefined) {
    return res.status(400).json({ error: "Confirm whether the pump mobilization charge applies to this order." });
  }
  const { rows: rateCheck } = await query(
    `SELECT COALESCE(part_load_min_qty_m3, 5) AS part_load_min_qty_m3 FROM rate_master
     WHERE customer_id = $1 AND mix_grade_id = $2 AND (site_id = $3 OR site_id IS NULL)
       AND effective_from <= $4 AND (effective_to IS NULL OR effective_to >= $4)
     ORDER BY (site_id = $3) DESC, effective_from DESC, id DESC LIMIT 1`,
    [customer_id, mix_grade_id, site_id, order_date]
  );
  const partLoadThreshold = Number(rateCheck[0]?.part_load_min_qty_m3 ?? 5);
  if (Number(order_quantity_m3) < partLoadThreshold && part_load_applicable === undefined) {
    return res.status(400).json({ error: `Confirm whether the part load charge applies — this order is below the ${partLoadThreshold} m³ minimum.` });
  }

  // Round 118 — resolve which mix design this order actually batches to for
  // its grade: a customer-specific assignment first, else whichever design
  // is marked standard for the grade, else none (an order can always be
  // placed with no mix design on file yet — this is purely additive).
  // Snapshotted onto the order at creation so history stays accurate even if
  // the assignment or standard design changes later.
  const { rows: resolvedDesign } = await query(
    `SELECT COALESCE(
       (SELECT mix_design_id FROM mix_design_assignments WHERE customer_id = $1 AND mix_grade_id = $2),
       (SELECT id FROM mix_designs WHERE mix_grade_id = $2 AND is_standard_for_grade = true AND status = 'approved')
     ) AS mix_design_id`,
    [customer_id, mix_grade_id]
  );
  const resolvedMixDesignId = resolvedDesign[0]?.mix_design_id || null;

  // Round 119, post-ship again, item 3 — Ajith Pulikkol is the default QC
  // Engineer on every new order, so this never has to be picked by hand at
  // Create Order time (there's deliberately no QC Engineer field on that
  // form). Resolved by name, not a hardcoded id, since ids differ per
  // deployment/environment. Manager/Admin can still override it afterwards
  // from the existing "Correct Order" screen's QC Engineer picker
  // (administrator.js PATCH /orders/:id) — this only sets the starting
  // value. Falls back to no default (the old role-based pick still applies
  // wherever nothing is assigned) if that name isn't on file as an active
  // QC Engineer in this deployment.
  const { rows: defaultQc } = await query(
    `SELECT id FROM users WHERE role = 'qc_engineer' AND is_active AND name ILIKE 'Ajith Pulikkol%' ORDER BY id LIMIT 1`
  );
  const defaultQcEngineerId = defaultQc[0]?.id || null;

  const { rows } = await query(
    `INSERT INTO customer_orders
     (order_date, scheduled_batching_time, truck_dispatch_interval_minutes, customer_id, site_id,
      mix_grade_id, pump_requirement, pump_id, site_technician_required, cube_samples_required,
      assigned_pump_crew, assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
      sales_representative_id, casting_location, specified_slump_mm, pump_departure_time, remarks, created_by,
      pump_charge_applicable, pump_charge_amount, part_load_applicable, part_load_charge_amount, resolved_mix_design_id,
      assigned_qc_engineer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING *`,
    [order_date, scheduled_batching_time, truck_dispatch_interval_minutes, customer_id, site_id,
     mix_grade_id, pump_requirement, pump_id || null, !!site_technician_required, cube_samples_required,
     assigned_pump_crew || null, assigned_site_supervisor_id || null, site_contact_number, order_quantity_m3,
     sales_representative_id || null, casting_location || null, specified_slump_mm || null, pump_departure_time || null, remarks || null, req.user.id,
     pump_charge_applicable ?? null, pump_charge_applicable ? (pump_charge_amount || 0) : 0,
     part_load_applicable ?? null, part_load_applicable ? (part_load_charge_amount || 0) : 0, resolvedMixDesignId,
     defaultQcEngineerId]
  );
  res.status(201).json(rows[0]);
});

// Manager dashboard KPIs — production totals, fleet counts, alerts
// Pump utilization this month — for the chart at the bottom of the
// dashboard. Status filter matches the current invoicing philosophy
// (a delivery counts once it exists, not only once formally completed) —
// this used to require status = 'completed', which no longer matched how
// every other figure in this app counts deliveries.
router.get("/pump-utilization-month", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT COALESCE(p.pump_code, 'Without pump') AS pump_code, COALESCE(p.pump_type::text, 'none') AS pump_type,
            COUNT(dt.id) AS deliveries,
            COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     LEFT JOIN pumps p ON p.id = co.pump_id
     WHERE dt.status NOT IN ('cancelled', 'rejected') AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
     GROUP BY p.pump_code, p.pump_type
     ORDER BY total_qty_m3 DESC`
  );
  res.json(rows);
});

router.get("/dashboard", requireRole("manager", "administrator"), async (req, res) => {
  const [today, month, fleet, delayed, rejected, target] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS total
       FROM delivery_tickets dt
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       WHERE dt.status != 'cancelled' AND dt.ticket_date = CURRENT_DATE`
    ),
    query(
      `SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS total
       FROM delivery_tickets dt
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       WHERE dt.status != 'cancelled' AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`
    ),
    query(
      `SELECT status, COUNT(*) AS count FROM delivery_tickets
       WHERE ticket_date = CURRENT_DATE AND status NOT IN ('completed', 'cancelled', 'rejected')
       GROUP BY status`
    ),
    query(
      `SELECT COUNT(*) AS count FROM delivery_tickets dt
       JOIN trip_events te ON te.ticket_id = dt.id AND te.event_type = 'reached_site'
       WHERE dt.ticket_date = CURRENT_DATE AND dt.status NOT IN ('completed', 'cancelled', 'rejected')
       AND te.event_time < now() - INTERVAL '2 hours'`
    ),
    query(
      `SELECT COALESCE(SUM(sq.rejected_quantity_m3), 0) AS total FROM site_qc sq
       JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       WHERE sq.accepted = false AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`
    ),
    // Round 96, item 8 — monthly production target. Looked up by the DB's
    // own idea of "this month" (not the Node process's), same reasoning as
    // every other date-sensitive query in this app (see recurring bug
    // pattern #1 in the project notes — never trust server-side JS Date()
    // for business-date logic).
    query(
      `SELECT target_m3,
              EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'))::int AS days_in_month,
              EXTRACT(DAY FROM CURRENT_DATE)::int AS day_of_month
       FROM monthly_production_targets
       WHERE year = EXTRACT(YEAR FROM CURRENT_DATE) AND month = EXTRACT(MONTH FROM CURRENT_DATE)`
    ),
  ]);

  const t = target.rows[0];
  const monthlyProduction = Number(month.rows[0].total);
  let targetInfo = { target_m3: null, achieved_pct: null, balance_m3: null, required_per_day_m3: null, days_remaining: null, pace_status: null };
  if (t) {
    // "Today counted as remaining" — confirmed with the business — so a
    // target set and checked on the last day of the month still shows 1 day
    // left, not 0 (which would divide by zero).
    const daysRemaining = Math.max(t.days_in_month - t.day_of_month + 1, 1);
    const targetM3 = Number(t.target_m3);
    const balance = Math.max(targetM3 - monthlyProduction, 0);
    const requiredPerDay = Math.round((balance / daysRemaining) * 10) / 10;
    // Pace indicator for the Manager dashboard's colored meter — compares the
    // average daily rate actually achieved so far this month against what's
    // now required for the rest of it, rather than just showing a flat
    // percentage with no sense of whether that's on track or not.
    const avgDailySoFar = monthlyProduction / t.day_of_month;
    const paceRatio = requiredPerDay > 0 ? avgDailySoFar / requiredPerDay : 1;
    const paceStatus = balance <= 0 ? "good" : paceRatio >= 1 ? "good" : paceRatio >= 0.85 ? "watch" : "behind";
    targetInfo = {
      target_m3: targetM3,
      achieved_pct: targetM3 > 0 ? Math.round((monthlyProduction / targetM3) * 1000) / 10 : null,
      balance_m3: Math.round(balance * 10) / 10,
      required_per_day_m3: requiredPerDay,
      days_remaining: daysRemaining,
      pace_status: paceStatus,
    };
  }

  res.json({
    today_production_m3: today.rows[0].total,
    monthly_production_m3: month.rows[0].total,
    fleet_status: fleet.rows,
    delayed_trucks: Number(delayed.rows[0].count),
    rejected_concrete_month_m3: rejected.rows[0].total,
    ...targetInfo,
  });
});

// Active trucks today — matches the original "Active trucks" mockup table.
// Also flags any truck that has been sitting at site more than 2 hours since
// arrival (site_supervisor's "reached_site" confirmation) so the delay is
// visible right on this list, not just as a background count.
router.get("/active-trucks", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.status, dt.created_at, dt.order_id, dt.loaded_quantity_m3,
            t.truck_number, u.name AS driver_name, c.name AS customer_name, s.name AS site_name,
            rs.event_time AS reached_site_at,
            CASE WHEN dt.status IN ('reached_site', 'unloading') AND rs.event_time IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (now() - rs.event_time)) / 60
            END AS minutes_at_site,
            EXISTS (
              SELECT 1 FROM notifications n
              WHERE n.ticket_id = dt.id AND n.type = 'qc_flagged_delay' AND n.is_read = false
            ) AS qc_flagged,
            (
              SELECT n.manager_response FROM notifications n
              WHERE n.ticket_id = dt.id AND n.type = 'qc_flagged_delay' AND n.manager_response IS NOT NULL
              ORDER BY n.created_at DESC LIMIT 1
            ) AS qc_flag_response,
            dt.site_delay_reason
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
     WHERE dt.ticket_date = CURRENT_DATE AND dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
     ORDER BY dt.created_at`
  );
  res.json(rows);
});

// Manager clears a QC flag once they've reviewed it.
router.post("/active-trucks/:ticketId/mark-reviewed", requireRole("manager", "administrator"), async (req, res) => {
  const { response } = req.body;
  if (!response) return res.status(400).json({ error: "Write the action taken or reason before marking this reviewed." });
  await query(
    `UPDATE notifications SET is_read = true, manager_response = $2, responded_by = $3, responded_at = now()
     WHERE ticket_id = $1 AND type = 'qc_flagged_delay' AND is_read = false`,
    [req.params.ticketId, response, req.user.id]
  );
  res.json({ ok: true });
});

// Tags a delayed delivery (from the "over 2 hrs at site" alert already shown
// on Active Trucks) with a waiting/delay charge — a Manager decision, not
// automatic. Uses the exact arrival time already driving that alert, and
// the rate's configured waiting_charge_per_hour. Charges only the time past
// the same 2-hour free allowance the alert itself uses, rounded up to the
// next full hour.
// Records why a truck sat at site past the alert threshold — this alert is
// purely live/computed with no notification row behind it, so there was
// nowhere to record a reason at all until now.
router.post("/tickets/:ticketId/site-delay-reason", requireRole("manager", "administrator"), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "Write a reason." });
  await query(
    "UPDATE delivery_tickets SET site_delay_reason = $1, site_delay_reason_by = $2, site_delay_reason_at = now() WHERE id = $3",
    [reason, req.user.id, req.params.ticketId]
  );
  res.json({ ok: true });
});

router.post("/tickets/:ticketId/apply-delay-charge", requireRole("manager", "administrator", "accountant"), async (req, res) => {
  const FREE_MINUTES = 120;

  const { rows } = await query(
    `SELECT dt.order_id, co.customer_id, co.site_id, co.mix_grade_id, co.order_date,
            EXTRACT(EPOCH FROM (now() - rs.event_time)) / 60 AS minutes_at_site
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     LEFT JOIN LATERAL (
       SELECT event_time FROM trip_events
       WHERE ticket_id = dt.id AND event_type = 'reached_site'
       ORDER BY event_time DESC LIMIT 1
     ) rs ON true
     WHERE dt.id = $1`,
    [req.params.ticketId]
  );
  const t = rows[0];
  if (!t || t.minutes_at_site === null) {
    return res.status(400).json({ error: "No arrival time recorded for this delivery yet — can't compute a waiting duration." });
  }
  const minutesOver = Number(t.minutes_at_site) - FREE_MINUTES;
  if (minutesOver <= 0) {
    return res.status(400).json({ error: `Not past the ${FREE_MINUTES / 60}-hour free waiting allowance yet.` });
  }
  const hoursCharged = Math.ceil(minutesOver / 60);

  const { rows: rateRows } = await query(
    `SELECT waiting_charge_per_hour FROM rate_master
     WHERE customer_id = $1 AND mix_grade_id = $2 AND (site_id = $3 OR site_id IS NULL)
       AND effective_from <= $4 AND (effective_to IS NULL OR effective_to >= $4)
     ORDER BY (site_id = $3) DESC, effective_from DESC, id DESC LIMIT 1`,
    [t.customer_id, t.mix_grade_id, t.site_id, t.order_date]
  );
  const ratePerHour = Number(rateRows[0]?.waiting_charge_per_hour || 0);
  if (ratePerHour === 0) {
    return res.status(400).json({ error: "No waiting charge rate is on file for this customer/grade — add one on the rate first." });
  }
  const charge = hoursCharged * ratePerHour;

  const { rows: invRows } = await query(
    `SELECT i.id, i.concrete_amount, i.pumping_charge, i.part_load_charge,
            COALESCE((SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id), 0) AS payment_count
     FROM invoices i WHERE i.ticket_id = $1`,
    [req.params.ticketId]
  );
  const inv = invRows[0];
  if (!inv) return res.status(400).json({ error: "No invoice exists yet for this delivery — add a rate first." });
  if (Number(inv.payment_count) > 0) {
    return res.status(400).json({ error: "A payment has already been recorded against this invoice — can't add a charge automatically." });
  }

  const newTotal = Number(inv.concrete_amount) + Number(inv.pumping_charge) + Number(inv.part_load_charge) + charge;
  await query("UPDATE invoices SET waiting_charge = $1, total_amount = $2 WHERE id = $3", [charge, newTotal, inv.id]);

  const { rows: ticketInfo } = await query(
    `SELECT dt.ticket_number, c.name AS customer_name
     FROM delivery_tickets dt JOIN customer_orders co ON co.id = dt.order_id JOIN customers c ON c.id = co.customer_id
     WHERE dt.id = $1`,
    [req.params.ticketId]
  );
  const label = ticketInfo[0] ? `${ticketInfo[0].ticket_number} — ${ticketInfo[0].customer_name}` : "A delivery";
  const message = `Waiting charge of ₹${charge} added to ${label} (already invoiced) — total is now ₹${newTotal.toFixed(2)}. The customer's outstanding balance updates automatically, but they may already have an earlier total in hand — worth flagging when following up.`;
  await query(
    `INSERT INTO notifications (recipient_role, ticket_id, type, message) VALUES ('accountant', $1, 'waiting_charge_added', $2)`,
    [req.params.ticketId, message]
  );
  await pushToRole("accountant", { title: "Waiting charge added to an invoiced delivery", body: message, url: "/accountant" });

  res.json({ ok: true, hours_charged: hoursCharged, rate_per_hour: ratePerHour, charge });
});


// the Site Supervisor didn't (or Manager wants to add more context).
router.post("/:orderId/pump-delay-reason", requireRole("manager", "administrator"), async (req, res) => {
  const { reason } = req.body;
  await query(
    "UPDATE customer_orders SET pump_departure_delay_reason = $1, pump_departure_delay_reason_by = $2, pump_departure_delay_reason_at = now() WHERE id = $3",
    [reason || null, req.user.id, req.params.orderId]
  );
  res.json({ ok: true });
});

router.post("/:orderId/site-ready-delay-reason", requireRole("manager", "administrator"), async (req, res) => {
  const { reason } = req.body;
  await query(
    "UPDATE customer_orders SET site_ready_delay_reason = $1, site_ready_delay_reason_by = $2, site_ready_delay_reason_at = now() WHERE id = $3",
    [reason || null, req.user.id, req.params.orderId]
  );
  res.json({ ok: true });
});

// Manager reviews the Site Supervisor's "work completed" signal and
// explicitly confirms — this is the only thing that actually sets the order
// to completed; the supervisor's signal alone never does.
router.post("/:orderId/confirm-completion", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `UPDATE customer_orders SET status = 'completed', terminal_at = now()
     WHERE id = $1 AND status NOT IN ('cancelled', 'closed', 'completed')
     RETURNING *`,
    [req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found or already closed out." });
  res.json(rows[0]);
});

// ===================== CUSTOMER-FACING TRACKING LINK =====================
// A shareable, single-order link (no login) the customer's own site agent can
// open to see just that order's trucks — nothing else, not even a different
// order for the same customer.
function newToken() {
  return randomBytes(24).toString("base64url");
}

router.get("/:orderId/tracking-link", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT id, token, created_at FROM order_tracking_links
     WHERE order_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [req.params.orderId]
  );
  res.json({ active_link: rows[0] || null });
});

// Creating a new link automatically revokes whatever link was active before —
// this is the actual fix for "shared it to the wrong person by mistake": there
// is deliberately no way for two links to be valid for the same order at
// once, so making a fresh one is itself the safe way to kill the old one.
router.post("/:orderId/tracking-link", requireRole("manager", "administrator"), async (req, res) => {
  const { rows: orderCheck } = await query("SELECT id FROM customer_orders WHERE id = $1", [req.params.orderId]);
  if (!orderCheck.length) return res.status(404).json({ error: "Order not found." });

  await query(
    `UPDATE order_tracking_links SET revoked_at = now(), revoked_by = $1
     WHERE order_id = $2 AND revoked_at IS NULL`,
    [req.user.id, req.params.orderId]
  );
  const { rows } = await query(
    `INSERT INTO order_tracking_links (order_id, token, created_by) VALUES ($1, $2, $3) RETURNING id, token, created_at`,
    [req.params.orderId, newToken(), req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Revoke without replacing — for "just kill it, I'll decide about a new one later."
router.post("/:orderId/tracking-link/revoke", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `UPDATE order_tracking_links SET revoked_at = now(), revoked_by = $1
     WHERE order_id = $2 AND revoked_at IS NULL RETURNING id`,
    [req.user.id, req.params.orderId]
  );
  res.json({ ok: true, revoked_count: rows.length });
});

// Completed trips today, with the full timeline: batching (ticket created),
// left plant (dispatched by QC), reached site, unloading start, unloading finish.
router.get("/completed-trips", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.status, t.truck_number, u.name AS driver_name,
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
     WHERE dt.ticket_date = CURRENT_DATE AND dt.status IN ('completed', 'rejected')
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
     WHERE dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected') AND dt.ticket_date = CURRENT_DATE
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
       WHERE driver_id = d.driver_id AND status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
       ORDER BY created_at DESC LIMIT 1
     ) dt ON true
     LEFT JOIN trucks t ON t.id = dt.truck_id
     WHERE d.is_on = true
       AND gp.recorded_at IS NOT NULL AND gp.recorded_at > now() - INTERVAL '12 hours'
     ORDER BY d.driver_id, d.event_time DESC`
  );
  res.json(rows);
});

// Cross-checks each trip's self-reported stage times (logged by whichever of
// driver or Site Supervisor actually did it — they share the same
// confirmation step, so there's one time per stage, not two) against the
// nearest GPS ping at that moment. A big gap between the two is worth a
// look; a small one is just normal GPS noise and isn't flagged.
router.get("/trip-time-crosscheck", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.ticket_date,
            u.name AS driver_name, t.truck_number, c.name AS customer_name, s.name AS site_name,
            si.event_time AS site_in_logged_at, si_user.name AS site_in_logged_by,
            gp.recorded_at AS nearest_gps_time,
            ROUND(ABS(EXTRACT(EPOCH FROM (si.event_time - gp.recorded_at))) / 60) AS gap_minutes,
            -- Round 101, item 1: Plant Out is marked when it was auto-recorded
            -- (driver didn't respond to the geofence popup within the grace
            -- period) rather than a real driver/supervisor tap, so a manager
            -- reviewing this report knows which times are GPS-inferred.
            po.event_time AS plant_out_logged_at, po.source AS plant_out_source
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN users u ON u.id = dt.driver_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN trip_events si ON si.ticket_id = dt.id AND si.event_type = 'reached_site'
     LEFT JOIN users si_user ON si_user.id = si.edited_by
     LEFT JOIN LATERAL (
       SELECT recorded_at FROM gps_pings
       WHERE driver_id = dt.driver_id
       ORDER BY ABS(EXTRACT(EPOCH FROM (recorded_at - si.event_time))) LIMIT 1
     ) gp ON true
     LEFT JOIN LATERAL (
       SELECT event_time, source FROM trip_events
       WHERE ticket_id = dt.id AND event_type = 'left_plant' ORDER BY event_time LIMIT 1
     ) po ON true
     WHERE dt.ticket_date >= CURRENT_DATE - 7
     ORDER BY gap_minutes DESC NULLS LAST
     LIMIT 100`
  );
  res.json(rows.map((r) => ({ ...r, flagged: r.gap_minutes === null || Number(r.gap_minutes) > 15 })));
});

// Full order detail — every role can view (read-only); editing stays restricted
// to Administrator's "Correct orders" panel.
router.get("/:id", async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name, p.pump_code, sup.name AS site_supervisor_name,
            sp.name AS sales_representative_name, creator.name AS created_by_name,
            qc.name AS qc_engineer_name,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status != 'cancelled'), 0)
              - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS delivered_qty_m3
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     LEFT JOIN pumps p ON p.id = o.pump_id
     LEFT JOIN users sup ON sup.id = o.assigned_site_supervisor_id
     LEFT JOIN salespersons sp ON sp.id = COALESCE(s.assigned_sales_representative_id, o.sales_representative_id)
     LEFT JOIN users creator ON creator.id = o.created_by
     LEFT JOIN users qc ON qc.id = o.assigned_qc_engineer_id
     LEFT JOIN delivery_tickets dt ON dt.order_id = o.id
     LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
     WHERE o.id = $1
     GROUP BY o.id, c.name, s.name, s.address, m.name, p.pump_code, sup.name, sp.name, creator.name, qc.name`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found." });
  res.json(rows[0]);
});

export default router;
