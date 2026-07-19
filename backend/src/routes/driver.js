import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("driver"));

// SRS §3: Duty ON starts GPS tracking, Duty OFF stops it. Location permission is
// requested once at PWA install time (per business decision), not on every toggle.
router.post("/duty", async (req, res) => {
  const { on, ticket_id, lat, lng } = req.body;
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by, latitude, longitude)
     VALUES ($1, $2, 'manual', $3, $4, $5)`,
    [ticket_id, on ? "duty_on" : "duty_off", req.user.id, lat, lng]
  );

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

// SRS §4: GPS ping every 30s (configurable), only while on duty
router.post("/gps-ping", async (req, res) => {
  const { ticket_id, latitude, longitude, speed_kmh, accuracy_m } = req.body;
  await query(
    `INSERT INTO gps_pings (driver_id, ticket_id, latitude, longitude, speed_kmh, accuracy_m)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user.id, ticket_id, latitude, longitude, speed_kmh, accuracy_m]
  );
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
