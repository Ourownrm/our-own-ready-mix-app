import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  confirmArrival, confirmUnloadingStart, confirmUnloadingComplete, confirmRejection,
  orderHasNoSiteSupervisor,
} from "../lib/deliveryConfirmation.js";
import { pushToRole } from "../lib/push.js";
import { BREAKDOWN_ISSUE_LABELS } from "../lib/breakdownIssueTypes.js";

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
      "SELECT dt.status, dt.ticket_number, t.truck_number FROM delivery_tickets dt JOIN trucks t ON t.id = dt.truck_id WHERE dt.id = $1",
      [ticket_id]
    );
    if (rows[0] && !["completed", "returned", "cancelled"].includes(rows[0].status)) {
      await query(
        `INSERT INTO notifications (recipient_role, ticket_id, type, message)
         VALUES ('manager', $1, 'driver_off_duty_during_trip', 'Driver went off duty during an active trip')`,
        [ticket_id]
      );
      await pushToRole("manager", {
        title: "Driver went off duty mid-trip",
        body: `${rows[0].ticket_number} — ${rows[0].truck_number}`,
        url: "/manager",
      });
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

// Sequential gating for the 4-stage trip sheet (Plant Out / Site In / Site
// Out / Plant In) — a driver can't log a later stage before the one before
// it, so times can't come back out of order. Checks trip_events directly
// rather than delivery_tickets.status, since Site In/Out can be logged by a
// Site Supervisor instead of the driver on a supervised site, and this needs
// to recognize that either way.
async function hasStage(ticketId, eventType) {
  const { rows } = await query(
    "SELECT 1 FROM trip_events WHERE ticket_id = $1 AND event_type = $2 LIMIT 1",
    [ticketId, eventType]
  );
  return rows.length > 0;
}

async function logStageEvent(ticketId, eventType, userId, lat, lng) {
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by, latitude, longitude)
     VALUES ($1, $2, 'manual', $3, $4, $5)`,
    [ticketId, eventType, userId, lat || null, lng || null]
  );
}

// Plant Out — available on every trip regardless of whether the site has a
// Site Supervisor, since it's the driver leaving the plant either way.
router.post("/tickets/:ticketId/plant-out", async (req, res) => {
  if (await hasStage(req.params.ticketId, "left_plant")) return res.json({ ok: true, already_logged: true });
  await logStageEvent(req.params.ticketId, "left_plant", req.user.id, req.body.lat, req.body.lng);
  res.json({ ok: true });
});

// Round 101, item 1: driver tapped "Not yet" on a geofence hint popup — the
// grace period before auto-recording that stage restarts from this response
// instead of the original GPS detection, since the driver has actively
// confirmed they're still there. Originally wired up for Plant Out only
// (checkPlantOutAutoRecord); round 119 post-ship again round 3 generalized
// auto-record to all 4 stages (see its 3 siblings in scheduledChecks.js),
// and this same endpoint/response now backs the grace-period restart for
// whichever stage's hint the driver dismissed. A no-op if there's no
// matching geofence_events row yet (e.g. a stale/duplicate tap) — nothing to
// update, and nothing to error about either.
router.post("/tickets/:ticketId/geofence-response", async (req, res) => {
  const { event_type } = req.body;
  if (!event_type) return res.status(400).json({ error: "event_type is required." });
  await query(
    `UPDATE geofence_events SET last_response_at = now() WHERE ticket_id = $1 AND event_type = $2`,
    [req.params.ticketId, event_type]
  );
  res.json({ ok: true });
});

// Plant In — same, available regardless of supervisor; gated on the site
// having been marked done (by whoever did it — driver or supervisor).
router.post("/tickets/:ticketId/plant-in", async (req, res) => {
  const { rows } = await query(
    `SELECT (co.assigned_site_supervisor_id IS NULL) AS no_site_supervisor
     FROM delivery_tickets dt JOIN customer_orders co ON co.id = dt.order_id
     WHERE dt.id = $1`,
    [req.params.ticketId]
  );
  const noSupervisor = rows[0]?.no_site_supervisor;
  // On a site with no Site Supervisor, the driver is the one who logs Site
  // Out themselves, so requiring it first still makes sense — it keeps
  // their own stage order honest. On a supervised site, Site In/Out are
  // entirely the Supervisor's to confirm and on their own timing; gating
  // Plant In on that would leave a driver permanently unable to close a
  // trip whenever the Supervisor is slow or misses it. The driver reporting
  // "I'm back at the plant" is true regardless of that paperwork's status.
  if (noSupervisor && !(await hasStage(req.params.ticketId, "unloading_completed"))) {
    return res.status(400).json({ error: "Log Site Out before Plant In." });
  }
  if (await hasStage(req.params.ticketId, "returned_to_plant")) return res.json({ ok: true, already_logged: true });
  await logStageEvent(req.params.ticketId, "returned_to_plant", req.user.id, req.body.lat, req.body.lng);
  res.json({ ok: true });
});

async function requireNoSupervisor(req, res, next) {
  try {
    if (!(await orderHasNoSiteSupervisor(req.params.ticketId))) {
      return res.status(403).json({ error: "This order has a Site Supervisor assigned — they'll confirm this delivery." });
    }
    next();
  } catch (err) { next(err); }
}

router.post("/tickets/:ticketId/arrival", requireNoSupervisor, async (req, res) => {
  if (!(await hasStage(req.params.ticketId, "left_plant"))) {
    return res.status(400).json({ error: "Log Plant Out before Site In." });
  }
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

// Site Out — the trip sheet shows this as one stage, but underneath it's
// still the existing unloading-start-then-complete pair (unloading-start
// creates the site_qc row that unloading-complete needs to update; skipping
// straight to complete would silently save nothing). Gated on Site In.
router.post("/tickets/:ticketId/site-out", requireNoSupervisor, async (req, res) => {
  if (!(await hasStage(req.params.ticketId, "reached_site"))) {
    return res.status(400).json({ error: "Log Site In before Site Out." });
  }
  if (!(await hasStage(req.params.ticketId, "unloading_started"))) {
    await confirmUnloadingStart(req.params.ticketId, req.user.id);
  }
  await confirmUnloadingComplete(req.params.ticketId, req.user.id, req.body);
  res.json({ ok: true });
});

router.post("/tickets/:ticketId/reject", requireNoSupervisor, async (req, res) => {
  await confirmRejection(req.params.ticketId, req.user.id, req.body);
  res.json({ ok: true });
});

router.post("/breakdown", async (req, res) => {
  // Round 99, item 3 — the manual "Location" text field is gone. Location is
  // now GPS only (latitude/longitude, best-effort captured by the frontend
  // at submit time — same pattern as everywhere else in the app). issue_type
  // is a picklist value from breakdownIssueTypes.js; remarks stays free text
  // (required by the frontend only when issue_type === 'other').
  const { truck_id, issue_type, latitude, longitude, remarks } = req.body;
  if (!issue_type) return res.status(400).json({ error: "Select what happened." });
  await query(
    `INSERT INTO breakdown_reports (equipment_type, truck_id, driver_id, reported_by, issue_type, latitude, longitude, remarks)
     VALUES ('truck', $1,$2,$2,$3,$4,$5,$6)`,
    [truck_id, req.user.id, issue_type, latitude || null, longitude || null, remarks || null]
  );
  const { rows } = await query("SELECT truck_number FROM trucks WHERE id = $1", [truck_id]);
  const issueLabel = BREAKDOWN_ISSUE_LABELS[issue_type] || issue_type;
  await query(
    `INSERT INTO notifications (recipient_role, type, message)
     VALUES ('manager', 'breakdown_reported', $1)`,
    [`Breakdown reported: truck ${rows[0]?.truck_number || truck_id} — ${issueLabel}`]
  );
  await pushToRole("manager", {
    title: "Truck breakdown reported",
    body: `${rows[0]?.truck_number || "A truck"} — ${issueLabel}`,
    url: "/manager",
  });
  res.json({ ok: true });
});

// Fuel filling moved to the shared /api/fuel route (covers any equipment,
// not just this driver's truck) — see routes/fuel.js.

// Round 98, item 10 sub-requirement 2 — driver requests an external-workshop
// repair; Manager approves/rejects, then logs sent-out/returned as the truck
// actually goes. See backend/src/routes/maintenance.js for the Manager side.
router.post("/external-repair", async (req, res) => {
  const { truck_id, issue_description } = req.body;
  if (!truck_id || !issue_description) {
    return res.status(400).json({ error: "Truck and a description of the issue are required." });
  }
  const { rows } = await query(
    `INSERT INTO external_repairs (truck_id, requested_by, issue_description)
     VALUES ($1,$2,$3) RETURNING *`,
    [truck_id, req.user.id, issue_description]
  );
  const { rows: truckRows } = await query("SELECT truck_number FROM trucks WHERE id = $1", [truck_id]);
  await query(
    `INSERT INTO notifications (recipient_role, type, message)
     VALUES ('manager', 'external_repair_requested', $1)`,
    [`External repair requested: truck ${truckRows[0]?.truck_number || truck_id} — ${issue_description}`]
  );
  await pushToRole("manager", {
    title: "External repair requested",
    body: `${truckRows[0]?.truck_number || "A truck"} — ${issue_description}`,
    url: "/manager",
  });
  res.status(201).json(rows[0]);
});

// Driver's own request history — so they can see whether a request they
// made was approved/rejected, without needing Manager access.
router.get("/external-repair", async (req, res) => {
  const { rows } = await query(
    `SELECT er.id, er.status, er.issue_description, er.requested_at, er.workshop_name,
            er.sent_out_at, er.returned_at, er.rejection_reason, t.truck_number
     FROM external_repairs er
     JOIN trucks t ON t.id = er.truck_id
     WHERE er.requested_by = $1
     ORDER BY er.requested_at DESC LIMIT 20`,
    [req.user.id]
  );
  res.json(rows);
});

// Driver's own app-language preference (round 96) — drives both the UI text
// on driver-facing screens and the language used for push notifications sent
// to this driver (see backend/src/lib/i18n.js).
const SUPPORTED_LANGUAGES = ["en", "ml", "hi"];
router.patch("/language", async (req, res) => {
  const { preferred_language } = req.body;
  if (!SUPPORTED_LANGUAGES.includes(preferred_language)) {
    return res.status(400).json({ error: "Unsupported language." });
  }
  await query("UPDATE users SET preferred_language = $1 WHERE id = $2", [preferred_language, req.user.id]);
  res.json({ ok: true, preferred_language });
});

export default router;
