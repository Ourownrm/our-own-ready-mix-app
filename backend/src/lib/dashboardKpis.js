// Round 143 follow-up — the ONE definition of the four headline production and
// collection figures.
//
// Why this file exists: round 143's new Administrator dashboard computed its
// own version of these numbers and every one of them disagreed with the
// Reports page, which the user spotted immediately. Two hand-written copies of
// "today's production" will always drift, so there is now exactly one copy and
// both pages import it. If a definition below is wrong, it is wrong in one
// place and fixes in one place.
//
// The definitions are `reports.js`'s (the Director's Dashboard), kept verbatim
// including the rules that are easy to get wrong:
//
//   Order qty today  — an order that was cancelled or closed WITHOUT ever
//                      being supplied was never real demand and is excluded;
//                      one that did receive supply before being cancelled or
//                      closed still counts. (Round 129 fixed this on the
//                      Reports page; round 143 re-broke it here by writing a
//                      simpler `status <> 'cancelled'`.)
//   Production       — delivery-challan quantity, NOT the Plant Operator's own
//                      daily figure, and NET of what site QC rejected. The
//                      operator figure is the right basis for cost per m³ in
//                      the Material Module — and only there; this is the
//                      number the plant reports as production.
//   Outstanding      — all invoices + all opening balances − all payments.
//                      NOTE this is not the same arithmetic as the
//                      Outstanding Collection *report*, which sums only
//                      customers whose own balance is positive, so a customer
//                      in credit reduces this figure but not that one. Both
//                      numbers are long-standing; this is the one the Reports
//                      page shows, so it is the one the KPI shows.
import { query } from "../db.js";

export async function dashboardKpiRows() {
  return Promise.all([
    query(`
      SELECT COALESCE(SUM(o.order_quantity_m3), 0) AS qty,
             COUNT(*)::int AS orders
      FROM customer_orders o
      WHERE o.order_date = CURRENT_DATE
        AND (
          o.status NOT IN ('cancelled', 'closed')
          OR EXISTS (
            SELECT 1 FROM delivery_tickets dt WHERE dt.order_id = o.id AND dt.status != 'cancelled'
          )
        )
    `),
    query(
      `SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS qty, COUNT(*)::int AS tickets
       FROM delivery_tickets WHERE ticket_date = CURRENT_DATE AND status != 'cancelled'`
    ),
    query(
      `SELECT COALESCE(SUM(sq.rejected_quantity_m3), 0) AS qty
       FROM site_qc sq JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       WHERE dt.ticket_date = CURRENT_DATE`
    ),
    query(
      `SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS qty
       FROM delivery_tickets
       WHERE date_trunc('month', ticket_date) = date_trunc('month', CURRENT_DATE) AND status != 'cancelled'`
    ),
    query(
      `SELECT COALESCE(SUM(sq.rejected_quantity_m3), 0) AS qty
       FROM site_qc sq JOIN delivery_tickets dt ON dt.id = sq.ticket_id
       WHERE date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`
    ),
    query(
      `SELECT
         (SELECT COALESCE(SUM(i.total_amount), 0) FROM invoices i)
         + (SELECT COALESCE(SUM(amount), 0) FROM customer_opening_balances)
         - (SELECT COALESCE(SUM(amount), 0) FROM payments)
         AS total`
    ),
  ]);
}

// The same six rows, reduced to the numbers a KPI tile shows.
export async function dashboardKpis() {
  const [orderToday, ticketToday, rejectedToday, ticketMonth, rejectedMonth, outstanding] =
    await dashboardKpiRows();
  return {
    order_qty_today: Number(orderToday.rows[0].qty),
    order_count_today: orderToday.rows[0].orders,
    // Challan quantity net of site rejections — the same subtraction the
    // Reports page does, done here so it cannot be forgotten by a caller.
    supplied_qty_today: Number(ticketToday.rows[0].qty) - Number(rejectedToday.rows[0].qty),
    ticket_count_today: ticketToday.rows[0].tickets,
    rejected_qty_today: Number(rejectedToday.rows[0].qty),
    monthly_production_qty: Number(ticketMonth.rows[0].qty) - Number(rejectedMonth.rows[0].qty),
    total_outstanding: Number(outstanding.rows[0].total),
  };
}
