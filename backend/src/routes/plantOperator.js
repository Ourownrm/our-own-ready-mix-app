import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { syncOrderCompletionStatus } from "../lib/deliveryConfirmation.js";
import { pushToUser } from "../lib/push.js";

const router = Router();
router.use(requireAuth, requireRole("plant_operator", "manager", "administrator"));

// Non-blocking warning at ticket creation — the actual fix for a driver
// getting a second trip assigned while their first one is still open and
// unconfirmed. Doesn't stop the assignment (sometimes it's legitimate — the
// dispatcher knows the first one really is done and just hasn't been
// confirmed yet), just makes it visible instead of silent.
router.get("/driver-open-trips", async (req, res) => {
  const { driver_id } = req.query;
  if (!driver_id) return res.json([]);
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, dt.status, dt.created_at, c.name AS customer_name, s.name AS site_name
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     WHERE dt.driver_id = $1 AND dt.status NOT IN ('completed', 'cancelled', 'returned', 'rejected')
     ORDER BY dt.created_at DESC`,
    [driver_id]
  );
  res.json(rows);
});

async function logEvent(ticketId, eventType, userId) {
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by)
     VALUES ($1, $2, 'manual', $3)`,
    [ticketId, eventType, userId]
  );
}

// Orders with remaining quantity still available to dispatch — powers the "Select order" dropdown
router.get("/available-orders", async (req, res) => {
  const { rows } = await query(
    `SELECT co.id, co.order_quantity_m3, c.name AS customer_name, s.name AS site_name,
            m.name AS mix_grade_name,
            (co.assigned_site_supervisor_id IS NOT NULL AND NOT co.site_ready_confirmed) AS blocked_site_not_ready,
            co.site_ready_confirmed_at,
            MIN(dt.created_at) AS first_ticket_created_at,
            COALESCE(SUM(dt.loaded_quantity_m3), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS dispatched_so_far
     FROM customer_orders co
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN delivery_tickets dt ON dt.order_id = co.id AND dt.status != 'cancelled'
     LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
     WHERE co.order_date = CURRENT_DATE AND co.status IN ('planned', 'in_progress', 'partially_completed')
     GROUP BY co.id, c.name, s.name, m.name, co.assigned_site_supervisor_id, co.site_ready_confirmed, co.site_ready_confirmed_at
     HAVING COALESCE(SUM(dt.loaded_quantity_m3), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0) < co.order_quantity_m3
     ORDER BY co.scheduled_batching_time`
  );
  res.json(rows);
});

// Create a delivery ticket against an order
router.post("/tickets", requireRole("plant_operator", "administrator"), async (req, res) => {
  const { order_id, loaded_quantity_m3, truck_id, driver_id, idempotency_key } = req.body;
  if (!order_id || !loaded_quantity_m3 || !truck_id || !driver_id) {
    return res.status(400).json({ error: "Order, quantity, truck, and driver are all required." });
  }

  // A queued submission from a weak-signal moment might get retried more
  // than once (by the offline queue's own retry, and possibly by the
  // operator resubmitting not realizing the first attempt is queued). If
  // this exact submission already went through, return that same ticket
  // instead of creating a second one.
  if (idempotency_key) {
    const { rows: existing } = await query(
      "SELECT * FROM delivery_tickets WHERE idempotency_key = $1",
      [idempotency_key]
    );
    if (existing.length) return res.status(201).json(existing[0]);
  }

  // No batching until the assigned Site Supervisor confirms the site is
  // ready — orders with no supervisor (small sites) aren't gated, since
  // there's no one able to confirm.
  const { rows: gateCheck } = await query(
    "SELECT assigned_site_supervisor_id, site_ready_confirmed FROM customer_orders WHERE id = $1",
    [order_id]
  );
  if (gateCheck[0]?.assigned_site_supervisor_id && !gateCheck[0].site_ready_confirmed) {
    return res.status(400).json({ error: "Site Supervisor hasn't confirmed the site is ready yet — can't start batching for this order." });
  }

  // Ticket numbers must be globally unique. Basing the next number on a same-day
  // COUNT(*) could collide — a cancelled ticket, a manually-entered ticket number
  // from Administrator/Manager (see tickets.js), or two tickets created back to
  // back could all land on the same number and fail the UNIQUE constraint with a
  // generic 500. Instead: derive the next number from the highest DT-#### issued
  // so far (any date), and retry a couple of times on the rare remaining race.
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows: maxRows } = await query(
        `SELECT COALESCE(MAX((regexp_match(ticket_number, '^DT-(\\d+)$'))[1]::int), 2200) AS max_num
         FROM delivery_tickets`
      );
      const ticketNumber = `DT-${Number(maxRows[0].max_num) + 1}`;

      const { rows } = await query(
        `INSERT INTO delivery_tickets (ticket_number, order_id, loaded_quantity_m3, truck_id, driver_id, plant_operator_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ticketNumber, order_id, loaded_quantity_m3, truck_id, driver_id, req.user.id, idempotency_key || null]
      );
      await logEvent(rows[0].id, "created", req.user.id);

      await query(
        `UPDATE customer_orders SET status = 'in_progress' WHERE id = $1 AND status = 'planned'`,
        [order_id]
      );
      await syncOrderCompletionStatus(order_id);

      // Notify the Site Supervisor actually assigned to this order — a truck
      // is now loaded and headed their way. Nothing to notify if the site
      // has no supervisor assigned (small sites, per business need).
      const { rows: siteInfo } = await query(
        `SELECT co.assigned_site_supervisor_id, s.name AS site_name, t.truck_number
         FROM customer_orders co
         JOIN sites s ON s.id = co.site_id
         JOIN trucks t ON t.id = $2
         WHERE co.id = $1`,
        [order_id, truck_id]
      );
      if (siteInfo[0]?.assigned_site_supervisor_id) {
        await query(
          `INSERT INTO notifications (recipient_role, recipient_id, ticket_id, type, message)
           VALUES ('site_supervisor', $1, $2, 'delivery_note_created', $3)`,
          [siteInfo[0].assigned_site_supervisor_id, rows[0].id, `Delivery note ${ticketNumber} created for ${siteInfo[0].site_name}`]
        );
        await pushToUser(siteInfo[0].assigned_site_supervisor_id, {
          title: "Truck loaded and on the way",
          body: `${ticketNumber} — ${siteInfo[0].truck_number} — ${siteInfo[0].site_name}`,
          url: "/site-supervisor",
        });
      }

      return res.status(201).json(rows[0]);
    } catch (err) {
      lastErr = err;
      if (err.code !== "23505") break; // not a duplicate-key race — don't retry other errors
    }
  }
  throw lastErr;
});

export default router;
