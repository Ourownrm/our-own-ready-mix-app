import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
// Director's Dashboard carries full company financials — Administrator only.
router.use(requireAuth, requireRole("administrator"));

// Everything the Director's Dashboard needs, in one call.
router.get("/director-dashboard", async (req, res) => {
  const [
    ordersToday, ordersMonth,
    salesToday, salesMonth, salesByCustomer,
    collectedToday, collectedMonth,
    outstanding, aging,
    runningOrders, upcomingOrders,
    salesmanMonthly, pumpUtilization, rejections,
  ] = await Promise.all([
    query(`SELECT COUNT(*) AS count FROM customer_orders WHERE order_date = CURRENT_DATE`),
    query(`SELECT COUNT(*) AS count FROM customer_orders WHERE date_trunc('month', order_date) = date_trunc('month', CURRENT_DATE)`),

    query(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM invoices WHERE created_at::date = CURRENT_DATE`),
    query(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM invoices WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`),
    query(
      `SELECT c.name AS customer_name, COALESCE(SUM(i.total_amount), 0) AS total
       FROM invoices i JOIN customers c ON c.id = i.customer_id
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
       WHERE o.order_date > CURRENT_DATE AND o.status NOT IN ('cancelled', 'completed')
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
    orders_today: Number(ordersToday.rows[0].count),
    orders_month: Number(ordersMonth.rows[0].count),
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

export default router;
