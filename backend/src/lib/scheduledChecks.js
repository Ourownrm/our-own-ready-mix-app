import { query } from "../db.js";
import { pushToRole, pushToUser } from "./push.js";

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
    `SELECT o.id AS order_id, o.scheduled_batching_time, s.name AS site_name, c.name AS customer_name,
            o.assigned_site_supervisor_id
     FROM customer_orders o
     JOIN sites s ON s.id = o.site_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.order_date = CURRENT_DATE
       AND (o.order_date + o.scheduled_batching_time) < now()
       AND o.status = 'planned'
       AND NOT EXISTS (SELECT 1 FROM delivery_tickets dt WHERE dt.order_id = o.id)
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.order_id = o.id AND n.type = 'batching_not_started'
       )`
  );

  for (const o of rows) {
    const message = `Batching hasn't started for ${o.customer_name} — ${o.site_name} (scheduled ${o.scheduled_batching_time})`;
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
