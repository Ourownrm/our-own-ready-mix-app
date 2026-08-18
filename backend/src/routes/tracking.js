import { Router } from "express";
import { query } from "../db.js";

// Public, unauthenticated order-tracking endpoint reached via a shared link
// (e.g. WhatsApp) — deliberately NOT mounted behind requireAuth, unlike every
// other route in this app. Scoped entirely by the unguessable token itself:
// there is no account, no list, and no way to browse from one order's link to
// another — the token IS the access boundary, so this can't leak a second
// order or a second customer's data even by mistake in a query. Read-only.
const router = Router();

// A link stays valid while the order is still active. Once the order reaches
// a terminal state (completed/closed/cancelled), it stays valid for a further
// 3 hours (covers "delivery finished, customer still confirming with their
// site team") then goes stale on its own — on top of Manager/Admin being able
// to revoke it outright at any time (see orders.js).
const GRACE_HOURS = 3;

router.get("/:token", async (req, res) => {
  const { rows: linkRows } = await query(
    `SELECT otl.id, otl.order_id, otl.revoked_at
     FROM order_tracking_links otl WHERE otl.token = $1`,
    [req.params.token]
  );
  const link = linkRows[0];
  if (!link || link.revoked_at) {
    return res.status(404).json({ error: "expired" });
  }

  const { rows: orderRows } = await query(
    `SELECT o.id, o.status, o.order_quantity_m3, o.order_date, o.terminal_at,
            c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status NOT IN ('cancelled', 'rejected')), 0) AS delivered_qty_m3
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     LEFT JOIN delivery_tickets dt ON dt.order_id = o.id
     WHERE o.id = $1
     GROUP BY o.id, c.name, s.name, m.name`,
    [link.order_id]
  );
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: "expired" });

  const isTerminal = ["completed", "closed", "cancelled"].includes(order.status);
  if (isTerminal && order.terminal_at && new Date(order.terminal_at) < new Date(Date.now() - GRACE_HOURS * 3600 * 1000)) {
    return res.status(404).json({ error: "expired" });
  }

  const { rows: trucks } = await query(
    `SELECT dt.id, dt.ticket_number, dt.loaded_quantity_m3, dt.status, t.truck_number,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'left_plant') AS left_plant_at,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'reached_site') AS reached_site_at,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_started') AS unloading_started_at,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_completed') AS unloading_completed_at
     FROM delivery_tickets dt
     LEFT JOIN trucks t ON t.id = dt.truck_id
     LEFT JOIN trip_events te ON te.ticket_id = dt.id
     WHERE dt.order_id = $1 AND dt.status != 'cancelled'
     GROUP BY dt.id, dt.ticket_number, dt.loaded_quantity_m3, dt.status, t.truck_number
     ORDER BY dt.created_at`,
    [link.order_id]
  );

  res.json({
    order: {
      customer_name: order.customer_name,
      site_name: order.site_name,
      mix_grade_name: order.mix_grade_name,
      order_date: order.order_date,
      order_quantity_m3: order.order_quantity_m3,
      delivered_qty_m3: order.delivered_qty_m3,
      status: order.status,
    },
    trucks: trucks.map((t) => ({
      ticket_number: t.ticket_number,
      truck_number: t.truck_number,
      quantity_m3: t.loaded_quantity_m3,
      status: t.status,
      left_plant_at: t.left_plant_at,
      reached_site_at: t.reached_site_at,
      unloading_started_at: t.unloading_started_at,
      unloading_completed_at: t.unloading_completed_at,
    })),
  });
});

export default router;
