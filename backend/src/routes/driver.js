import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  confirmArrival, confirmUnloadingStart, confirmUnloadingComplete, confirmRejection,
  orderHasNoSiteSupervisor,
} from "../lib/deliveryConfirmation.js";

const router = Router();
router.use(requireAuth, requireRole("driver"));

// SRS §3: Duty ON starts GPS tracking, Duty OFF stops it. Location permission is
// requested once at PWA install time (per business decision), not on every toggle.
//
// Duty is tracked per-driver (driver_duty_log), not per-ticket — a driver can be
// on duty and trackable with no truck assigned and no delivery ticket created yet
// (e.g. waiting at plant, or a small site with no formal ticket). If a ticket_id
// happens to be active, we also log it on that ticket's own timeline for context.
router.post("/duty", async (req, res) => {
  const { on, ticket_id, lat, lng } = req.body;

  await query(
    `INSERT INTO driver_duty_log (driver_id, is_on, latitude, longitude) VALUES ($1,$2,$3,$4)`,
    [req.user.id, !!on, lat || null, lng || null]
  );
  if (ticket_id) {
    await query(
      `INSERT INTO trip_events (ticket_id, event_type, source, edited_by, latitude, longitude)
       VALUES ($1, $2, 'manual', $3, $4, $5)`,
      [ticket_id, on ? "duty_on" : "duty_off", req.user.id, lat, lng]
    );
  }

  // SRS §13: notify manager if driver goes off duty mid-trip
  if (!on && ticket_id) {
    const { rows } = await query(
      "SELECT status FROM delivery_tickets WHERE id = $1", [ticket_id]
    );
    if (rows[0] && !["completed", "returned", "cancelled"].includes(rows[0].status)) {
      await query(
        `INSERT INTO notifications (recipient_role, ticket_id, type, message)
         VALUES ('manager', $1, 'driver_off_duty_during_trip', 'Driver went off duty during an active trip')`,
        [ticket_id]
      );
    }
  }
  res.json({ ok: true });
});

// Current duty status for this driver — read on app load so the toggle reflects
// what the server actually has on file, instead of resetting to "Off" just
// because the browser tab was suspended in the background and lost its local state.
router.get("/duty-status", async (req, res) => {
  const { rows } = await query(
    `SELECT is_on, event_time FROM driver_duty_log WHERE driver_id = $1 ORDER BY event_time DESC LIMIT 1`,
    [req.user.id]
  );
  res.json(rows[0] ? { on_duty: rows[0].is_on, since: rows[0].event_time } : { on_duty: false, since: null });
});

// SRS §4: GPS ping every 30s (configurable), only while on duty
router.post("/gps-ping", async (req, res) => {
  const { ticket_id, latitude, longitude, speed_kmh, accuracy_m } = req.body;
  await query(
    `INSERT INTO gps_pings (driver_id, ticket_id, latitude, longitude, speed_kmh, accuracy_m)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user.id, ticket_id || null, latitude, longitude, speed_kmh, accuracy_m]
  );
  res.json({ ok: true });
});

// ===== Self-service delivery confirmation, for orders with no Site Supervisor
// assigned (small sites, 1-2 trucks, per business need). Blocked if a
// supervisor IS assigned — they're the one who should be confirming it, to
// keep the QC/handoff a second pair of eyes rather than the driver marking
// their own delivery. =====

async function requireNoSupervisor(req, res, next) {
  try {
    if (!(await orderHasNoSiteSupervisor(req.params.ticketId))) {
      return res.status(403).json({ error: "This order has a Site Supervisor assigned — they'll confirm this delivery." });
    }
    next();
  } catch (err) { next(err); }
}

router.post("/tickets/:ticketId/arrival", requireNoSupervisor, async (req, res) => {
  await confirmArrival(req.params.ticketId, req.user.id);
  res.json({ ok: true });
});

router.post("/tickets/:ticketId/unloading-start", requireNoSupervisor, async (req, res) => {
  await confirmUnloadingStart(req.params.ticketId, req.user.id);
  res.json({ ok: true });
});

router.post("/tickets/:ticketId/unloading-complete", requireNoSupervisor, async (req, res) => {
  await confirmUnloadingComplete(req.params.ticketId, req.user.id, req.body);
  res.json({ ok: true });
});

router.post("/tickets/:ticketId/reject", requireNoSupervisor, async (req, res) => {
  await confirmRejection(req.params.ticketId, req.user.id, req.body);
  res.json({ ok: true });
});

router.post("/breakdown", async (req, res) => {
  const { truck_id, location, latitude, longitude, remarks } = req.body;
  await query(
    `INSERT INTO breakdown_reports (equipment_type, truck_id, driver_id, reported_by, location, latitude, longitude, remarks)
     VALUES ('truck', $1,$2,$2,$3,$4,$5,$6)`,
    [truck_id, req.user.id, location, latitude, longitude, remarks]
  );
  res.json({ ok: true });
});

router.post("/fuel", async (req, res) => {
  const { truck_id, odometer_reading, fuel_quantity_litres, fuel_cost, fuel_station_id } = req.body;
  await query(
    `INSERT INTO fuel_logs (truck_id, odometer_reading, fuel_quantity_litres, fuel_cost, fuel_station_id, logged_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [truck_id, odometer_reading, fuel_quantity_litres, fuel_cost, fuel_station_id, req.user.id]
  );
  res.json({ ok: true });
});

export default router;
