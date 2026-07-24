import { query } from "../db.js";
import { pushToRole } from "./push.js";

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
}
