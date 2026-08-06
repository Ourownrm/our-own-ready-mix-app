import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
// Director's Dashboard carries full company financials — Administrator only.
router.use(requireAuth, requireRole("administrator"));

// Everything the Director's Dashboard needs, in one call.
router.get("/director-dashboard", async (req, res) => {
  const [
    orderQtyToday, suppliedTicketQtyToday, todayRejectedQty, monthlyTicketQty, monthlyRejectedQty,
    salesToday, salesMonth, salesByCustomer,
    collectedToday, collectedMonth,
    outstanding, aging,
    runningOrders, upcomingOrders,
    salesmanMonthly, pumpUtilization, rejections, unbilled,
  ] = await Promise.all([
    // Order Qty Today — how much was ordered for today, regardless of how much has shipped
    query(`SELECT COALESCE(SUM(order_quantity_m3), 0) AS qty FROM customer_orders WHERE order_date = CURRENT_DATE AND status NOT IN ('cancelled', 'closed')`),
    // Supplied Qty Today — every delivery note issued today counts as supplied as soon as
    // it's created (whether or not the trip has completed), minus whatever got rejected at site.
    query(`SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS qty FROM delivery_tickets WHERE ticket_date = CURRENT_DATE AND status != 'cancelled'`),
    query(
      `SELECT COALESCE(SUM(sq.rejected_quantity_m3), 0) AS qty
       FROM site_qc sq JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       WHERE dt.ticket_date = CURRENT_DATE`
    ),
    // Monthly Production Qty — total ticket quantity this month, minus what was rejected at site
    query(`SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS qty FROM delivery_tickets WHERE date_trunc('month', ticket_date) = date_trunc('month', CURRENT_DATE) AND status != 'cancelled'`),
    query(
      `SELECT COALESCE(SUM(sq.rejected_quantity_m3), 0) AS qty
       FROM site_qc sq JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       WHERE date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`
    ),

    query(
      `SELECT COALESCE(SUM(i.total_amount), 0) AS total FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       WHERE dt.ticket_date = CURRENT_DATE`
    ),
    query(
      `SELECT COALESCE(SUM(i.total_amount), 0) AS total FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       WHERE date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`
    ),
    query(
      `SELECT c.id AS customer_id, c.name AS customer_name, COALESCE(SUM(i.total_amount), 0) AS total,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       WHERE date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
       GROUP BY c.id, c.name ORDER BY total DESC`
    ),

    query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE payment_date = CURRENT_DATE`),
    query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE date_trunc('month', payment_date) = date_trunc('month', CURRENT_DATE)`),

    query(
      `SELECT
         (SELECT COALESCE(SUM(i.total_amount), 0) FROM invoices i)
         + (SELECT COALESCE(SUM(amount), 0) FROM customer_opening_balances)
         - (SELECT COALESCE(SUM(amount), 0) FROM payments)
         AS total`
    ),
    query(
      `WITH inv AS (
         SELECT i.customer_id, i.total_amount - COALESCE(p.paid, 0) AS outstanding,
                (CURRENT_DATE - i.created_at::date) AS age_days
         FROM invoices i
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p
           ON p.invoice_id = i.id
         UNION ALL
         SELECT ob.customer_id, ob.amount - COALESCE(p.paid, 0) AS outstanding,
                (CURRENT_DATE - ob.as_of_date) AS age_days
         FROM customer_opening_balances ob
         LEFT JOIN (SELECT opening_balance_id, SUM(amount) AS paid FROM payments GROUP BY opening_balance_id) p
           ON p.opening_balance_id = ob.id
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
              COALESCE(SUM(dt.loaded_quantity_m3), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS supplied_qty_m3,
              o.order_quantity_m3 - (COALESCE(SUM(dt.loaded_quantity_m3), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0)) AS balance_qty_m3,
              o.order_date, o.status
       FROM customer_orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN sites s ON s.id = o.site_id
       JOIN mix_grades m ON m.id = o.mix_grade_id
       LEFT JOIN delivery_tickets dt ON dt.order_id = o.id AND dt.status != 'cancelled'
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       WHERE o.status IN ('planned', 'in_progress', 'partially_completed')
         AND o.status NOT IN ('cancelled', 'closed')
         AND o.order_date <= CURRENT_DATE
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
      `SELECT sp.id AS salesperson_id, COALESCE(sp.name, 'Unassigned') AS salesman,
              COALESCE(SUM(i.total_amount), 0) AS total,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN sites s ON s.id = co.site_id
       LEFT JOIN salespersons sp ON sp.id = COALESCE(s.assigned_sales_representative_id, co.sales_representative_id)
       WHERE date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
       GROUP BY sp.id, sp.name ORDER BY total DESC`
    ),
    query(
      `SELECT p.pump_code, p.pump_type,
              COUNT(dt.id) AS deliveries,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN pumps p ON p.id = co.pump_id
       WHERE dt.status NOT IN ('cancelled', 'rejected') AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
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
    // Delivered this month but never invoiced — usually means no rate was on
    // file for that customer/grade at the time. Real, uncollected revenue,
    // not a display quirk — surfaced directly so it can't hide inside a
    // mismatch between production and sales figures.
    query(
      `SELECT c.name AS customer_name, s.name AS site_name, dt.ticket_number, dt.ticket_date,
              dt.loaded_quantity_m3 AS qty, diag.likely_reason
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = co.customer_id
       JOIN sites s ON s.id = co.site_id
       LEFT JOIN invoices i ON i.ticket_id = dt.id
       LEFT JOIN LATERAL (
         SELECT CASE
           WHEN dt.status != 'completed' THEN
             'This delivery was never marked complete (status: ' || dt.status || ') — invoicing only happens at that point, regardless of whether a rate exists.'
           WHEN NOT EXISTS (
             SELECT 1 FROM rate_master rm WHERE rm.customer_id = co.customer_id AND rm.mix_grade_id = co.mix_grade_id
           ) THEN 'No rate on file at all for this customer and grade.'
           WHEN NOT EXISTS (
             SELECT 1 FROM rate_master rm WHERE rm.customer_id = co.customer_id AND rm.mix_grade_id = co.mix_grade_id
               AND (rm.site_id = co.site_id OR rm.site_id IS NULL)
           ) THEN 'A rate exists for this customer/grade, but for a different site — and no generic (all-sites) rate either.'
           WHEN NOT EXISTS (
             SELECT 1 FROM rate_master rm WHERE rm.customer_id = co.customer_id AND rm.mix_grade_id = co.mix_grade_id
               AND (rm.site_id = co.site_id OR rm.site_id IS NULL) AND rm.effective_from <= co.order_date
           ) THEN 'The rate on file starts after this order''s date — rates don''t apply retroactively to orders placed before them.'
           WHEN NOT EXISTS (
             SELECT 1 FROM rate_master rm WHERE rm.customer_id = co.customer_id AND rm.mix_grade_id = co.mix_grade_id
               AND (rm.site_id = co.site_id OR rm.site_id IS NULL) AND rm.effective_from <= co.order_date
               AND (rm.effective_to IS NULL OR rm.effective_to >= co.order_date)
           ) THEN 'The rate on file had already ended before this order''s date.'
           ELSE 'A rate should match this and the delivery is marked complete — genuinely worth a manual check.'
         END AS likely_reason
       ) diag ON true
       WHERE date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
         AND dt.status NOT IN ('cancelled', 'rejected')
         AND i.id IS NULL
       ORDER BY dt.ticket_date, dt.id`
    ),
  ]);

  res.json({
    order_qty_today: orderQtyToday.rows[0].qty,
    supplied_qty_today: Number(suppliedTicketQtyToday.rows[0].qty) - Number(todayRejectedQty.rows[0].qty),
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
    unbilled_deliveries_month: unbilled.rows,
  });
});

// Daily production for the last N days (default 7) — fills in gaps with 0 so
// a day with no completed deliveries still shows a bar rather than a hole.
router.get("/daily-production", async (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  const [{ rows }, { rows: dayRows }] = await Promise.all([
    query(
      `SELECT dt.ticket_date::text AS day,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS qty_m3
       FROM delivery_tickets dt
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       WHERE dt.status != 'cancelled' AND dt.ticket_date >= CURRENT_DATE - ($1 || ' days')::interval
       GROUP BY dt.ticket_date`,
      [days - 1]
    ),
    // Generating the last N day-keys in SQL (against the IST-pinned session)
    // instead of a JS Date loop — the JS version ran on the server's own
    // clock (UTC on Render), which could disagree with the query above about
    // what "today" actually is during the UTC/IST day-boundary gap, silently
    // misaligning which bar is labeled "today".
    query(`SELECT generate_series(CURRENT_DATE - ($1 || ' days')::interval, CURRENT_DATE, '1 day')::date::text AS day`, [days - 1]),
  ]);
  const byDay = Object.fromEntries(rows.map((r) => [r.day, Number(r.qty_m3)]));
  const result = dayRows.map((r) => ({ day: r.day, qty_m3: byDay[r.day] || 0 }));
  res.json(result);
});

export default router;
