import { query } from "../db.js";

// Shared by the round-91 public order-tracking link (routes/tracking.js) and
// the round-100 customer booking status view (routes/customerBooking.js) —
// both need "here's this order's per-truck delivery progress" in the exact
// same shape, so it's pulled into one place instead of copy-pasted twice.

// A link stays valid while the order is still active. Once the order reaches
// a terminal state (completed/closed/cancelled), it stays valid for a further
// 3 hours (covers "delivery finished, customer still confirming with their
// site team") then goes stale on its own.
export const TRACKING_GRACE_HOURS = 3;

// Returns null if the order doesn't exist, or if it's terminal and past the
// grace window — callers should treat either the same as "nothing to show".
export async function getOrderTrackingPayload(orderId) {
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
    [orderId]
  );
  const order = orderRows[0];
  if (!order) return null;

  const isTerminal = ["completed", "closed", "cancelled"].includes(order.status);
  if (isTerminal && order.terminal_at && new Date(order.terminal_at) < new Date(Date.now() - TRACKING_GRACE_HOURS * 3600 * 1000)) {
    return null;
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
    [orderId]
  );

  return {
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
  };
}
