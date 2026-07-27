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
    await pushToRole("manager", { title: "Compliance alert", body: message, url: "/compliance" });
  }
  return rows;
}
