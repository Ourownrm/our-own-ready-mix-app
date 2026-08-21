import { query } from "../db.js";
import { pushToRole, pushToUser } from "./push.js";
import { pushText, actionLabel } from "./i18n.js";

// Runs on a timer (see index.js) rather than being tied to a user action,
// since nobody "does" anything at the 2-hour mark — it's a passive
// time-based threshold. Uses the notifications table itself to avoid
// re-notifying the same ticket on every tick: once a 'truck_delayed_2hrs'
// notification exists for a ticket, it's skipped on subsequent runs.
export async function checkDelayedTrucks() {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, t.truck_number, s.name AS site_name
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN LATERAL (
       SELECT event_time FROM trip_events
       WHERE ticket_id = dt.id AND event_type = 'reached_site'
       ORDER BY event_time DESC LIMIT 1
     ) rs ON true
     WHERE dt.ticket_date = CURRENT_DATE AND dt.status IN ('reached_site', 'unloading')
       AND rs.event_time < now() - INTERVAL '2 hours'
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.ticket_id = dt.id AND n.type = 'truck_delayed_2hrs'
       )`
  );

  for (const t of rows) {
    await query(
      `INSERT INTO notifications (recipient_role, ticket_id, type, message)
       VALUES ('qc_engineer', $1, 'truck_delayed_2hrs', $2)`,
      [t.ticket_id, `${t.ticket_number} has been at ${t.site_name} over 2 hours — worth a quality check`]
    );
    await pushToRole("qc_engineer", {
      title: "Truck over 2 hours at site",
      body: `${t.truck_number} — ${t.site_name}`,
      url: "/qc",
    });
  }
  return rows;
}

// Pump was scheduled to leave the plant by a certain time and hasn't been
// confirmed departed — notify Manager, Administrator, and the specific
// assigned Site Supervisor. Only applies to orders that actually need a pump.
export async function checkPumpDepartureOverdue() {
  const { rows } = await query(
    `SELECT o.id AS order_id, o.pump_departure_time, s.name AS site_name, c.name AS customer_name,
            o.assigned_site_supervisor_id
     FROM customer_orders o
     JOIN sites s ON s.id = o.site_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.order_date = CURRENT_DATE AND o.pump_requirement != 'without_pump'
       AND o.pump_departure_time IS NOT NULL
       AND o.pump_actual_departure_time IS NULL
       AND (o.order_date + o.pump_departure_time) < now()
       AND o.status NOT IN ('cancelled', 'closed', 'completed')
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.order_id = o.id AND n.type = 'pump_departure_overdue'
       )`
  );

  for (const o of rows) {
    const message = `Pump hasn't left the plant yet for ${o.customer_name} — ${o.site_name} (scheduled ${o.pump_departure_time})`;
    await query(`INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('manager', $1, 'pump_departure_overdue', $2)`, [o.order_id, message]);
    await query(`INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('administrator', $1, 'pump_departure_overdue', $2)`, [o.order_id, message]);
    await pushToRole("manager", { title: "Pump departure overdue", body: message, url: "/manager" });
    await pushToRole("administrator", { title: "Pump departure overdue", body: message, url: "/reports" });
    if (o.assigned_site_supervisor_id) {
      await query(
        `INSERT INTO notifications (recipient_role, recipient_id, order_id, type, message) VALUES ('site_supervisor', $1, $2, 'pump_departure_overdue', $3)`,
        [o.assigned_site_supervisor_id, o.order_id, message]
      );
      await pushToUser(o.assigned_site_supervisor_id, { title: "Pump departure overdue", body: message, url: "/site-supervisor" });
    }
  }
  return rows;
}

// Scheduled batching time has passed with no delivery ticket created yet —
// notify Manager, Administrator, and the assigned Site Supervisor.
export async function checkBatchingNotStarted() {
  const { rows } = await query(
    `SELECT o.id AS order_id, o.scheduled_batching_time, o.site_ready_confirmed_at, s.name AS site_name, c.name AS customer_name,
            o.assigned_site_supervisor_id
     FROM customer_orders o
     JOIN sites s ON s.id = o.site_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.order_date = CURRENT_DATE
       AND o.site_ready_confirmed_at IS NOT NULL
       AND o.site_ready_confirmed_at < now() - INTERVAL '12 minutes'
       AND o.status = 'planned'
       AND NOT EXISTS (SELECT 1 FROM delivery_tickets dt WHERE dt.order_id = o.id)
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.order_id = o.id AND n.type = 'batching_not_started'
       )`
  );

  for (const o of rows) {
    const message = `Batching hasn't started for ${o.customer_name} — ${o.site_name} (site confirmed ready over 12 min ago)`;
    await query(`INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('manager', $1, 'batching_not_started', $2)`, [o.order_id, message]);
    await query(`INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('administrator', $1, 'batching_not_started', $2)`, [o.order_id, message]);
    await pushToRole("manager", { title: "Batching not started", body: message, url: "/manager" });
    await pushToRole("administrator", { title: "Batching not started", body: message, url: "/reports" });
    if (o.assigned_site_supervisor_id) {
      await query(
        `INSERT INTO notifications (recipient_role, recipient_id, order_id, type, message) VALUES ('site_supervisor', $1, $2, 'batching_not_started', $3)`,
        [o.assigned_site_supervisor_id, o.order_id, message]
      );
      await pushToUser(o.assigned_site_supervisor_id, { title: "Batching not started", body: message, url: "/site-supervisor" });
    }
  }
  return rows;
}

const DOC_LABELS = {
  insurance: "Insurance", road_tax: "Road tax", permit: "Permit", puc: "PUC",
  fitness_certificate: "Fitness certificate", registration_certificate: "Registration certificate",
  amc: "AMC", calibration_certificate: "Calibration certificate",
  inspection_certificate: "Inspection certificate", load_testing_certificate: "Load testing certificate",
  safety_certification: "Safety certification",
};

// Compliance alerts fire at 30/15/7 days before expiry, on the expiry date
// itself, and then once a day every day after until renewed. Runs on the
// same 5-minute timer as the other checks, but a per-document-per-day dedup
// (via the notifications table) means it only actually sends once a day no
// matter how often the timer ticks.
export async function checkComplianceExpiries() {
  const { rows } = await query(
    `SELECT cd.id, cd.document_type, cd.expiry_date, ca.name AS asset_name,
            (cd.expiry_date - CURRENT_DATE) AS days_until_expiry
     FROM compliance_documents cd
     JOIN compliance_assets ca ON ca.id = cd.asset_id
     WHERE ca.is_active
       AND ((cd.expiry_date - CURRENT_DATE) IN (30, 15, 7, 0) OR (cd.expiry_date - CURRENT_DATE) < 0)
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.compliance_document_id = cd.id AND n.created_at::date = CURRENT_DATE
       )`
  );

  for (const d of rows) {
    const days = Number(d.days_until_expiry);
    const docLabel = DOC_LABELS[d.document_type] || d.document_type;
    const message = days < 0
      ? `${d.asset_name} — ${docLabel} expired ${Math.abs(days)} day(s) ago`
      : days === 0
      ? `${d.asset_name} — ${docLabel} expires today`
      : `${d.asset_name} — ${docLabel} expires in ${days} day(s)`;
    await query(
      `INSERT INTO notifications (recipient_role, compliance_document_id, type, message) VALUES ('manager', $1, 'compliance_alert', $2)`,
      [d.id, message]
    );
    await query(
      `INSERT INTO notifications (recipient_role, compliance_document_id, type, message) VALUES ('administrator', $1, 'compliance_alert', $2)`,
      [d.id, message]
    );
    await pushToRole("manager", { title: "Compliance alert", body: message, url: "/compliance" });
    await pushToRole("administrator", { title: "Compliance alert", body: message, url: "/compliance" });
  }
  return rows;
}

// Tracks the time from when Site Supervisor confirms site-ready to when the
// FIRST delivery ticket is created for that order (first truck only — once
// any ticket exists, this order is done needing this check). If more than 12
// minutes pass with no ticket yet, alerts Manager and Plant Operator.
export async function checkBatchingDelayAfterSiteReady() {
  const { rows } = await query(
    `SELECT o.id AS order_id, o.site_ready_confirmed_at, c.name AS customer_name, s.name AS site_name
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     WHERE o.site_ready_confirmed = true
       AND o.order_date = CURRENT_DATE
       AND o.status NOT IN ('completed', 'closed', 'cancelled')
       AND NOT EXISTS (SELECT 1 FROM delivery_tickets dt WHERE dt.order_id = o.id)
       AND (now() - o.site_ready_confirmed_at) > INTERVAL '12 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.order_id = o.id AND n.type = 'batching_delay_after_site_ready'
       )`
  );

  for (const o of rows) {
    const message = `Site ready for ${o.customer_name} — ${o.site_name} over 12 minutes ago, still no delivery note created.`;
    await query(`INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('manager', $1, 'batching_delay_after_site_ready', $2)`, [o.order_id, message]);
    await query(`INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('plant_operator', $1, 'batching_delay_after_site_ready', $2)`, [o.order_id, message]);
    await pushToRole("manager", { title: "Batching delayed after site ready", body: message, url: "/manager" });
    await pushToRole("plant_operator", { title: "Start batching now", body: message, url: "/plant-operator" });
  }
  return rows;
}

// Daily digest of follow-ups due today or overdue — this is what actually
// prevents a generated follow-up from quietly going stale after its
// immediate at-creation push (which only fires once, at the moment it's
// created). Guards against repeating the same notification twice in one day.
export async function checkFollowupsDue() {
  const { rows } = await query(
    `SELECT vf.id, vf.title, vf.due_date, vf.assigned_to_role, vf.assigned_to_user_id, cv.visited_name,
            (CURRENT_DATE - vf.due_date) AS days_overdue
     FROM visit_followups vf
     JOIN customer_visits cv ON cv.id = vf.visit_id
     WHERE vf.status = 'pending' AND vf.due_date <= CURRENT_DATE
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.type = 'followup_due' AND n.message LIKE '%#' || vf.id || '#%' AND n.created_at::date = CURRENT_DATE
       )`
  );
  for (const f of rows) {
    const overdue = Number(f.days_overdue);
    const message = `#${f.id}# ${f.visited_name} — ${f.title}${overdue > 0 ? ` (${overdue} day${overdue > 1 ? "s" : ""} overdue)` : " (due today)"}`;
    await query(
      `INSERT INTO notifications (recipient_role, recipient_id, type, message) VALUES ($1, $2, 'followup_due', $3)`,
      [f.assigned_to_role, f.assigned_to_user_id, message]
    );
    await pushToRole(f.assigned_to_role, {
      title: overdue > 0 ? "Follow-up overdue" : "Follow-up due today",
      body: `${f.visited_name} — ${f.title}`,
      url: f.assigned_to_role === "sales_executive" ? "/sales" : f.assigned_to_role === "accountant" ? "/accountant" : "/manager",
    });
  }
  return rows;
}

// ===================== GEOFENCE-BASED TRUCK STATUS DETECTION =====================
// Compares each active trip's most recent GPS pings against fixed points
// (the plant, and the Site Supervisor's own location captured when they
// confirmed site-ready — falling back to the site's own saved coordinates)
// to catch a truck arriving/leaving without anyone remembering to tap a
// button. Deliberately additive: this writes to `geofence_events`, a
// separate table from `trip_events` — it never touches the real
// confirmation flow (driver.js's hasStage/trip_events gating, invoicing,
// trip-allowance payout, etc. all stay exactly as they were). All this does
// is record a candidate detected time and nudge the right person to make
// the real, human-confirmed tap — same "suggest, don't auto-decide"
// principle as everywhere else money or status changes in this app.
//
// Requires the 2 most recent pings (within the last 15 minutes) to agree,
// so a single noisy/boundary reading can't fire a false detection.
const RECENT_PING_WINDOW = "15 minutes";

// The site-ready anchor (captured from the Site Supervisor's own device when
// they confirmed site-ready) is preferred over the site's saved coordinate —
// but only when it wasn't flagged suspect (implausibly far from the site's
// own saved point at capture time, see siteSupervisor.js). A suspect anchor
// falls back to the plain site coordinate instead of being trusted.
const SITE_ANCHOR_LAT = "COALESCE(CASE WHEN co.site_ready_location_suspect THEN NULL ELSE co.site_ready_latitude END, s.latitude)";
const SITE_ANCHOR_LNG = "COALESCE(CASE WHEN co.site_ready_location_suspect THEN NULL ELSE co.site_ready_longitude END, s.longitude)";

async function detectAndNotify({ eventType, sql, params, buildMessage, pushTo }) {
  const { rows } = await query(sql, params);
  for (const r of rows) {
    const { rows: inserted } = await query(
      `INSERT INTO geofence_events (ticket_id, event_type, latitude, longitude)
       VALUES ($1, $2, $3, $4) ON CONFLICT (ticket_id, event_type) DO NOTHING RETURNING id`,
      [r.ticket_id, eventType, r.latitude, r.longitude]
    );
    if (!inserted.length) continue; // already detected earlier — don't re-notify
    // `action` (round 96, item 9), when present, lets the service worker log
    // the stage directly from a notification action button — no need to
    // open the app first. Only wired up for the four driver stages and the
    // two Site Supervisor stages that have a plain "confirm this" endpoint;
    // omitted anywhere a form's actually needed (nothing today needs that
    // for these six).
    const { title, body, role, userId, url, action, actionText } = buildMessage(r);
    await query(
      `INSERT INTO notifications (recipient_role, recipient_id, ticket_id, type, message)
       VALUES ($1, $2, $3, 'geofence_hint', $4)`,
      [role, userId || null, r.ticket_id, body]
    );
    const payload = { title, body, url, ...(action ? { action, actionText } : {}) };
    if (userId) await pushToUser(userId, payload);
    else await pushToRole(role, payload);
  }
  return rows;
}

export async function checkGeofenceEvents() {
  const results = [];

  // Plant Out — driver's ping has moved outside the plant radius but they
  // never tapped "Plant Out" themselves.
  results.push(await detectAndNotify({
    eventType: "left_plant",
    sql: `
      WITH plant AS (SELECT latitude, longitude, geofence_radius_m FROM plant_locations WHERE is_active LIMIT 1),
      recent AS (
        SELECT ticket_id, latitude, longitude,
               ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY recorded_at DESC) AS rn
        FROM gps_pings WHERE ticket_id IS NOT NULL AND recorded_at > now() - INTERVAL '${RECENT_PING_WINDOW}'
      )
      SELECT dt.id AS ticket_id, dt.ticket_number, dt.driver_id, t.truck_number, r.latitude, r.longitude,
             COALESCE(du.preferred_language, 'en') AS driver_lang
      FROM delivery_tickets dt
      JOIN trucks t ON t.id = dt.truck_id
      JOIN plant ON true
      JOIN users du ON du.id = dt.driver_id
      JOIN LATERAL (SELECT latitude, longitude FROM recent WHERE ticket_id = dt.id AND rn = 1) r ON true
      WHERE dt.ticket_date = CURRENT_DATE
        AND dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
        AND NOT EXISTS (SELECT 1 FROM trip_events te WHERE te.ticket_id = dt.id AND te.event_type = 'left_plant')
        AND (SELECT COUNT(*) FROM recent WHERE ticket_id = dt.id AND rn <= 2
               AND geo_distance_m(latitude, longitude, plant.latitude, plant.longitude) > plant.geofence_radius_m) = 2`,
    params: [],
    buildMessage: (r) => ({
      title: pushText("left_plant", r.driver_lang, "title"),
      body: pushText("left_plant", r.driver_lang, "body", [r.ticket_number, r.truck_number]),
      role: "driver", userId: r.driver_id, url: "/driver",
      action: { path: `/driver/tickets/${r.ticket_id}/plant-out`, method: "POST" },
      actionText: actionLabel("plant_out", r.driver_lang),
    }),
  }));

  // Site In — driver's ping is now inside the site-ready anchor point (or
  // the site's own saved coordinate if no fresher one was captured), and
  // arrival hasn't been confirmed yet. Notifies whoever actually owns that
  // confirmation: the assigned Site Supervisor, or the driver themselves on
  // a self-service site — same split used everywhere else in this app.
  results.push(await detectAndNotify({
    eventType: "reached_site",
    sql: `
      WITH recent AS (
        SELECT ticket_id, latitude, longitude,
               ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY recorded_at DESC) AS rn
        FROM gps_pings WHERE ticket_id IS NOT NULL AND recorded_at > now() - INTERVAL '${RECENT_PING_WINDOW}'
      )
      SELECT dt.id AS ticket_id, dt.ticket_number, dt.driver_id, t.truck_number, r.latitude, r.longitude,
             co.assigned_site_supervisor_id, COALESCE(du.preferred_language, 'en') AS driver_lang
      FROM delivery_tickets dt
      JOIN trucks t ON t.id = dt.truck_id
      JOIN customer_orders co ON co.id = dt.order_id
      JOIN sites s ON s.id = co.site_id
      JOIN users du ON du.id = dt.driver_id
      JOIN LATERAL (SELECT latitude, longitude FROM recent WHERE ticket_id = dt.id AND rn = 1) r ON true
      WHERE dt.ticket_date = CURRENT_DATE
        AND dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
        AND NOT EXISTS (SELECT 1 FROM trip_events te WHERE te.ticket_id = dt.id AND te.event_type = 'reached_site')
        AND ${SITE_ANCHOR_LAT} IS NOT NULL
        AND (SELECT COUNT(*) FROM recent re WHERE re.ticket_id = dt.id AND re.rn <= 2
               AND geo_distance_m(re.latitude, re.longitude, ${SITE_ANCHOR_LAT}, ${SITE_ANCHOR_LNG})
                   <= COALESCE(s.geofence_radius_m, 150)) = 2`,
    params: [],
    buildMessage: (r) => r.assigned_site_supervisor_id
      ? {
          title: "Truck appears to have reached site",
          body: `${r.truck_number} — confirm arrival for ${r.ticket_number}`,
          role: "site_supervisor", userId: r.assigned_site_supervisor_id, url: "/site-supervisor",
          action: { path: `/site-supervisor/${r.ticket_id}/arrival`, method: "POST" },
          actionText: "Arrival",
        }
      : {
          title: pushText("reached_site", r.driver_lang, "title"),
          body: pushText("reached_site", r.driver_lang, "body", [r.ticket_number]),
          role: "driver", userId: r.driver_id, url: "/driver",
          action: { path: `/driver/tickets/${r.ticket_id}/arrival`, method: "POST" },
          actionText: actionLabel("site_in", r.driver_lang),
        },
  }));

  // Left site — ticket reached site (and may or may not have started
  // unloading — most will have, by the time they actually leave) but never
  // got unloading_completed, and the driver's ping has now moved back
  // outside the site radius. This is a nudge only — it can't tell "finished
  // unloading" from "left without finishing," it just flags that the truck
  // is no longer physically there so someone closes the trip out properly.
  results.push(await detectAndNotify({
    eventType: "left_site",
    sql: `
      WITH recent AS (
        SELECT ticket_id, latitude, longitude,
               ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY recorded_at DESC) AS rn
        FROM gps_pings WHERE ticket_id IS NOT NULL AND recorded_at > now() - INTERVAL '${RECENT_PING_WINDOW}'
      )
      SELECT dt.id AS ticket_id, dt.ticket_number, dt.driver_id, t.truck_number, r.latitude, r.longitude,
             co.assigned_site_supervisor_id, COALESCE(du.preferred_language, 'en') AS driver_lang
      FROM delivery_tickets dt
      JOIN trucks t ON t.id = dt.truck_id
      JOIN customer_orders co ON co.id = dt.order_id
      JOIN sites s ON s.id = co.site_id
      JOIN users du ON du.id = dt.driver_id
      JOIN LATERAL (SELECT latitude, longitude FROM recent WHERE ticket_id = dt.id AND rn = 1) r ON true
      WHERE dt.ticket_date >= CURRENT_DATE - INTERVAL '2 days'
        AND dt.status IN ('reached_site', 'unloading')
        AND EXISTS (SELECT 1 FROM trip_events te WHERE te.ticket_id = dt.id AND te.event_type = 'reached_site')
        AND NOT EXISTS (SELECT 1 FROM trip_events te WHERE te.ticket_id = dt.id AND te.event_type = 'unloading_completed')
        AND ${SITE_ANCHOR_LAT} IS NOT NULL
        AND (SELECT COUNT(*) FROM recent re WHERE re.ticket_id = dt.id AND re.rn <= 2
               AND geo_distance_m(re.latitude, re.longitude, ${SITE_ANCHOR_LAT}, ${SITE_ANCHOR_LNG})
                   > COALESCE(s.geofence_radius_m, 150)) = 2`,
    params: [],
    buildMessage: (r) => r.assigned_site_supervisor_id
      ? {
          title: "Truck appears to have left site",
          body: `${r.truck_number} — confirm unloading is complete for ${r.ticket_number}`,
          role: "site_supervisor", userId: r.assigned_site_supervisor_id, url: "/site-supervisor",
          action: { path: `/site-supervisor/${r.ticket_id}/unloading-complete`, method: "POST" },
          actionText: "Completion",
        }
      : {
          title: pushText("left_site", r.driver_lang, "title"),
          body: pushText("left_site", r.driver_lang, "body", [r.ticket_number]),
          role: "driver", userId: r.driver_id, url: "/driver",
          action: { path: `/driver/tickets/${r.ticket_id}/site-out`, method: "POST" },
          actionText: actionLabel("site_out", r.driver_lang),
        },
  }));

  // Plant In — driver has an open trip and their ping is back inside the
  // plant radius, but Plant In was never tapped.
  results.push(await detectAndNotify({
    eventType: "returned_to_plant",
    sql: `
      WITH plant AS (SELECT latitude, longitude, geofence_radius_m FROM plant_locations WHERE is_active LIMIT 1),
      recent AS (
        SELECT ticket_id, latitude, longitude,
               ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY recorded_at DESC) AS rn
        FROM gps_pings WHERE ticket_id IS NOT NULL AND recorded_at > now() - INTERVAL '${RECENT_PING_WINDOW}'
      )
      SELECT dt.id AS ticket_id, dt.ticket_number, dt.driver_id, t.truck_number, r.latitude, r.longitude,
             COALESCE(du.preferred_language, 'en') AS driver_lang
      FROM delivery_tickets dt
      JOIN trucks t ON t.id = dt.truck_id
      JOIN plant ON true
      JOIN users du ON du.id = dt.driver_id
      JOIN LATERAL (SELECT latitude, longitude FROM recent WHERE ticket_id = dt.id AND rn = 1) r ON true
      WHERE dt.ticket_date = CURRENT_DATE
        AND dt.status NOT IN ('cancelled')
        AND EXISTS (SELECT 1 FROM trip_events te WHERE te.ticket_id = dt.id AND te.event_type = 'left_plant')
        AND NOT EXISTS (SELECT 1 FROM trip_events te WHERE te.ticket_id = dt.id AND te.event_type = 'returned_to_plant')
        AND (SELECT COUNT(*) FROM recent WHERE ticket_id = dt.id AND rn <= 2
               AND geo_distance_m(latitude, longitude, plant.latitude, plant.longitude) <= plant.geofence_radius_m) = 2`,
    params: [],
    buildMessage: (r) => ({
      title: pushText("returned_to_plant", r.driver_lang, "title"),
      body: pushText("returned_to_plant", r.driver_lang, "body", [r.ticket_number, r.truck_number]),
      role: "driver", userId: r.driver_id, url: "/driver",
      action: { path: `/driver/tickets/${r.ticket_id}/plant-in`, method: "POST" },
      actionText: actionLabel("plant_in", r.driver_lang),
    }),
  }));

  return results.flat();
}

// Round 101, item 1 — if GPS has detected the truck leaving the plant
// (geofence_events, event_type='left_plant') but the driver never taps the
// real Plant Out button and never responds to the popup either, Plant Out
// is auto-recorded so the trip doesn't sit stuck with no plant-out time —
// and so the customer's tracking link isn't left showing nothing for a
// truck that has plainly already left. Grace period is per-site
// (sites.plant_out_grace_minutes), falling back to this default; it counts
// from the driver's last "not yet" response if there was one, else from the
// original GPS detection. The recorded event_time is the exact computed
// deadline (detection/response + grace), not "whenever this check happens
// to run" — matching the business's own worked example (detect 10:10, no
// response by 10:22 -> 10:22 recorded, even if this check next runs at
// 10:25). Written with source='auto' so reports and Best Driver scoring can
// tell it apart from a driver's own confirmed tap (see computeTransitRows
// in maintenance.js for why that distinction matters for fairness).
const PLANT_OUT_DEFAULT_GRACE_MINUTES = 12;

export async function checkPlantOutAutoRecord() {
  const { rows } = await query(
    `SELECT ge.ticket_id, ge.latitude, ge.longitude,
            COALESCE(ge.last_response_at, ge.detected_at)
              + (COALESCE(s.plant_out_grace_minutes, ${PLANT_OUT_DEFAULT_GRACE_MINUTES}) || ' minutes')::interval
              AS auto_event_time,
            dt.ticket_number, dt.driver_id,
            to_char(
              COALESCE(ge.last_response_at, ge.detected_at)
                + (COALESCE(s.plant_out_grace_minutes, ${PLANT_OUT_DEFAULT_GRACE_MINUTES}) || ' minutes')::interval,
              'HH24:MI'
            ) AS auto_event_time_label,
            COALESCE(du.preferred_language, 'en') AS driver_lang
     FROM geofence_events ge
     JOIN delivery_tickets dt ON dt.id = ge.ticket_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN users du ON du.id = dt.driver_id
     WHERE ge.event_type = 'left_plant'
       AND dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
       AND NOT EXISTS (SELECT 1 FROM trip_events te WHERE te.ticket_id = ge.ticket_id AND te.event_type = 'left_plant')
       AND COALESCE(ge.last_response_at, ge.detected_at)
             + (COALESCE(s.plant_out_grace_minutes, ${PLANT_OUT_DEFAULT_GRACE_MINUTES}) || ' minutes')::interval
           <= now()`
  );

  for (const r of rows) {
    // Defensive re-check — a driver could confirm the real stage in the gap
    // between the SELECT above and this INSERT (the interval between
    // scheduled-check runs is long enough for that to matter in theory).
    const { rows: already } = await query(
      "SELECT 1 FROM trip_events WHERE ticket_id = $1 AND event_type = 'left_plant' LIMIT 1",
      [r.ticket_id]
    );
    if (already.length) continue;

    await query(
      `INSERT INTO trip_events (ticket_id, event_type, event_time, source, latitude, longitude)
       VALUES ($1, 'left_plant', $2, 'auto', $3, $4)`,
      [r.ticket_id, r.auto_event_time, r.latitude, r.longitude]
    );

    const message = `${r.ticket_number} — Plant Out auto-recorded at ${r.auto_event_time_label} (driver didn't respond)`;
    await query(
      `INSERT INTO notifications (recipient_role, ticket_id, type, message) VALUES ('driver', $1, 'plant_out_auto_recorded', $2)`,
      [r.ticket_id, message]
    );
    await query(
      `INSERT INTO notifications (recipient_role, ticket_id, type, message) VALUES ('manager', $1, 'plant_out_auto_recorded', $2)`,
      [r.ticket_id, message]
    );
    await pushToUser(r.driver_id, {
      title: pushText("plant_out_auto_recorded", r.driver_lang, "title"),
      body: pushText("plant_out_auto_recorded", r.driver_lang, "body", [r.ticket_number, r.auto_event_time_label]),
      url: "/driver",
    });
    await pushToRole("manager", {
      title: "Plant Out auto-recorded",
      body: message,
      url: "/manager",
    });
  }
  return rows;
}

// Safety net for supply requests still pending after a while — the
// at-creation push only fires once, and if Manager hadn't enabled
// notifications yet (or just missed it), the request could otherwise sit
// unseen with no second signal. Same once-per-day guard pattern as the
// follow-ups digest.
export async function checkPendingSupplyRequests() {
  const { rows } = await query(
    `SELECT sr.id, sr.request_type, sr.requested_quantity, u.name AS requested_by_name
     FROM supply_requests sr
     JOIN users u ON u.id = sr.requested_by
     WHERE sr.status = 'pending' AND sr.requested_at < now() - INTERVAL '15 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.type = 'supply_request_pending_reminder' AND n.message LIKE '%#' || sr.id || '#%' AND n.created_at::date = CURRENT_DATE
       )`
  );
  for (const r of rows) {
    const message = `#${r.id}# ${r.requested_by_name} — ${r.requested_quantity} ${r.request_type === "fuel" ? "L fuel" : "lubricant"} still awaiting approval`;
    await query(
      `INSERT INTO notifications (recipient_role, type, message) VALUES ('manager', 'supply_request_pending_reminder', $1)`,
      [message]
    );
    await pushToRole("manager", { title: "Fuel/lubricant request still pending", body: message, url: "/supply-approvals" });
  }
  return rows;
}

// Notifications accumulate forever otherwise, making the notifications tab a
// growing wall of stale, long-actioned alerts. Read notifications are pure
// history at that point — safe to drop after a shorter window. Unread ones
// are kept longer on purpose (someone may still need to see and act on an
// old one), but even those age out eventually so the list can't grow
// unbounded if nobody's clearing their inbox.
const NOTIFICATION_RETENTION = {
  read: "30 days",
  unread: "90 days",
};

export async function cleanupOldNotifications() {
  const { rowCount: readDeleted } = await query(
    `DELETE FROM notifications WHERE is_read = true AND created_at < now() - INTERVAL '${NOTIFICATION_RETENTION.read}'`
  );
  const { rowCount: unreadDeleted } = await query(
    `DELETE FROM notifications WHERE is_read = false AND created_at < now() - INTERVAL '${NOTIFICATION_RETENTION.unread}'`
  );
  return { readDeleted, unreadDeleted };
}
