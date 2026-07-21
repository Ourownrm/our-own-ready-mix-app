import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
// Director's Dashboard carries full company financials — Administrator only.
router.use(requireAuth, requireRole("administrator"));

// Everything the Director's Dashboard needs, in one call.
router.get("/director-dashboard", async (req, res) => {
  const [
    orderQtyToday, suppliedQtyToday, monthlyTicketQty, monthlyRejectedQty,
    salesToday, salesMonth, salesByCustomer,
    collectedToday, collectedMonth,
    outstanding, aging,
    runningOrders, upcomingOrders,
    salesmanMonthly, pumpUtilization, rejections,
  ] = await Promise.all([
    // Order Qty Today — how much was ordered for today, regardless of how much has shipped
    query(`SELECT COALESCE(SUM(order_quantity_m3), 0) AS qty FROM customer_orders WHERE order_date = CURRENT_DATE AND status NOT IN ('cancelled', 'closed')`),
    // Supplied Qty Today — total delivery ticket quantity for today, whether or not the trip has completed
    query(`SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS qty FROM delivery_tickets WHERE ticket_date = CURRENT_DATE AND status != 'cancelled'`),
    // Monthly Production Qty — total ticket quantity this month, minus what was rejected at site
    query(`SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS qty FROM delivery_tickets WHERE date_trunc('month', ticket_date) = date_trunc('month', CURRENT_DATE) AND status != 'cancelled'`),
    query(
      `SELECT COALESCE(SUM(sq.rejected_quantity_m3), 0) AS qty
       FROM site_qc sq JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       WHERE date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`
    ),

    query(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM invoices WHERE created_at::date = CURRENT_DATE`),
    query(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM invoices WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`),
    query(
      `SELECT c.name AS customer_name, COALESCE(SUM(i.total_amount), 0) AS total,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       WHERE date_trunc('month', i.created_at) = date_trunc('month', CURRENT_DATE)
       GROUP BY c.name ORDER BY total DESC`
    ),

    query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE payment_date = CURRENT_DATE`),
    query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE date_trunc('month', payment_date) = date_trunc('month', CURRENT_DATE)`),

    query(
      `SELECT COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS total
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p
         ON p.invoice_id = i.id`
    ),
    query(
      `WITH inv AS (
         SELECT i.customer_id, i.total_amount - COALESCE(p.paid, 0) AS outstanding,
                (CURRENT_DATE - i.created_at::date) AS age_days
         FROM invoices i
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p
           ON p.invoice_id = i.id
       )
       SELECT c.name AS customer_name,
         COALESCE(SUM(CASE WHEN age_days <= 7 THEN outstanding ELSE 0 END), 0) AS bucket_0_7,
         COALESCE(SUM(CASE WHEN age_days > 7 AND age_days <= 14 THEN outstanding ELSE 0 END), 0) AS bucket_8_14,
         COALESCE(SUM(CASE WHEN age_days > 14 AND age_days <= 30 THEN outstanding ELSE 0 END), 0) AS bucket_15_30,
         COALESCE(SUM(CASE WHEN age_days > 30 THEN outstanding ELSE 0 END), 0) AS bucket_30_plus,
         COALESCE(SUM(outstanding), 0) AS total_outstanding
       FROM inv JOIN customers c ON c.id = inv.customer_id
       GROUP BY c.name
       HAVING COALESCE(SUM(outstanding), 0) > 0.01
       ORDER BY total_outstanding DESC`
    ),

    query(
      `SELECT o.id, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
              o.order_quantity_m3,
              COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status = 'completed'), 0) AS supplied_qty_m3,
              o.order_quantity_m3 - COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status = 'completed'), 0) AS balance_qty_m3,
              o.order_date, o.status
       FROM customer_orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN sites s ON s.id = o.site_id
       JOIN mix_grades m ON m.id = o.mix_grade_id
       LEFT JOIN delivery_tickets dt ON dt.order_id = o.id AND dt.status != 'cancelled'
       WHERE o.status IN ('planned', 'in_progress', 'partially_completed')
         AND o.status NOT IN ('cancelled', 'closed')
       GROUP BY o.id, c.name, s.name, m.name
       ORDER BY o.order_date, o.scheduled_batching_time`
    ),
    query(
      `SELECT o.id, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
              o.order_quantity_m3, o.order_date, o.scheduled_batching_time
       FROM customer_orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN sites s ON s.id = o.site_id
       JOIN mix_grades m ON m.id = o.mix_grade_id
       WHERE o.order_date > CURRENT_DATE AND o.status NOT IN ('cancelled', 'closed', 'completed')
       ORDER BY o.order_date, o.scheduled_batching_time
       LIMIT 100`
    ),

    query(
      `SELECT COALESCE(sp.name, 'Unassigned') AS salesman,
              COALESCE(SUM(i.total_amount), 0) AS total,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       LEFT JOIN salespersons sp ON sp.id = co.sales_representative_id
       WHERE date_trunc('month', i.created_at) = date_trunc('month', CURRENT_DATE)
       GROUP BY salesman ORDER BY total DESC`
    ),
    query(
      `SELECT p.pump_code, p.pump_type,
              COUNT(dt.id) AS deliveries,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN pumps p ON p.id = co.pump_id
       WHERE dt.status = 'completed' AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
       GROUP BY p.pump_code, p.pump_type
       ORDER BY total_qty_m3 DESC`
    ),
    query(
      `SELECT COALESCE(rr.reason, 'No reason recorded') AS reason,
              COUNT(*) AS occurrences,
              COALESCE(SUM(sq.rejected_quantity_m3), 0) AS total_qty_m3
       FROM site_qc sq
       JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       LEFT JOIN rejection_reasons rr ON rr.id = sq.rejection_reason_id
       WHERE sq.accepted = false AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
       GROUP BY rr.reason
       ORDER BY total_qty_m3 DESC`
    ),
  ]);

  res.json({
    order_qty_today: orderQtyToday.rows[0].qty,
    supplied_qty_today: suppliedQtyToday.rows[0].qty,
    monthly_production_qty: Number(monthlyTicketQty.rows[0].qty) - Number(monthlyRejectedQty.rows[0].qty),
    sales_today: salesToday.rows[0].total,
    sales_month: salesMonth.rows[0].total,
    sales_by_customer_month: salesByCustomer.rows,
    collected_today: collectedToday.rows[0].total,
    collected_month: collectedMonth.rows[0].total,
    total_outstanding: outstanding.rows[0].total,
    outstanding_aging: aging.rows,
    running_orders: runningOrders.rows,
    upcoming_orders: upcomingOrders.rows,
    salesman_monthly: salesmanMonthly.rows,
    pump_utilization_month: pumpUtilization.rows,
    rejections_month: rejections.rows,
  });
});

// Daily production for the last N days (default 7) — fills in gaps with 0 so
// a day with no completed deliveries still shows a bar rather than a hole.
router.get("/daily-production", async (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  const { rows } = await query(
    `SELECT ticket_date::text AS day, COALESCE(SUM(loaded_quantity_m3), 0) AS qty_m3
     FROM delivery_tickets
     WHERE status = 'completed' AND ticket_date >= CURRENT_DATE - ($1 || ' days')::interval
     GROUP BY ticket_date`,
    [days - 1]
  );
  const byDay = Object.fromEntries(rows.map((r) => [r.day, Number(r.qty_m3)]));
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ day: key, qty_m3: byDay[key] || 0 });
  }
  res.json(result);
});

export default router;
