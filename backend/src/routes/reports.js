import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
// Director's Dashboard carries full company financials — Administrator only.
router.use(requireAuth, requireRole("administrator"));

// Everything the Director's Dashboard needs, in one call.
// Consolidates four different delay signals that each live in a different
// place — pump departure, site-ready confirmation, batching-not-started
// alerts, and time spent at site — into one unified report. Each keeps its
// own planned/actual pairing since what "planned" means differs by type,
// but all come back in the same row shape.
router.get("/delay-justification", requireRole("manager", "administrator"), async (req, res) => {
  const fromDate = req.query.from_date || new Date().toISOString().slice(0, 10);
  const toDate = req.query.to_date || fromDate;
  const delayType = req.query.delay_type || "all";
  const minMinutes = Number(req.query.min_delay_minutes) || 0;

  const queries = [];

  if (delayType === "all" || delayType === "Pump departure") {
    queries.push(
      query(
        `SELECT * FROM (
           SELECT co.order_date AS date, c.name AS customer_name, s.name AS site_name,
                  'Pump departure' AS delay_type,
                  co.pump_departure_time::text AS planned_time,
                  to_char(co.pump_actual_departure_time, 'HH24:MI') AS actual_time,
                  co.pump_departure_delay_reason AS reason, u.name AS reason_by_name, co.pump_departure_delay_reason_at AS reason_at,
                  EXTRACT(EPOCH FROM (COALESCE(co.pump_actual_departure_time, now()) - (co.order_date + co.pump_departure_time))) / 60 AS delay_minutes
           FROM customer_orders co
           JOIN customers c ON c.id = co.customer_id JOIN sites s ON s.id = co.site_id
           LEFT JOIN users u ON u.id = co.pump_departure_delay_reason_by
           WHERE co.order_date BETWEEN $1 AND $2 AND co.pump_departure_time IS NOT NULL
             AND (co.pump_actual_departure_time IS NULL OR co.pump_actual_departure_time::time > co.pump_departure_time)
         ) x WHERE delay_minutes >= $3`,
        [fromDate, toDate, minMinutes]
      )
    );
  }
  if (delayType === "all" || delayType === "Site ready") {
    queries.push(
      query(
        `SELECT * FROM (
           SELECT co.order_date AS date, c.name AS customer_name, s.name AS site_name,
                  'Site ready' AS delay_type,
                  co.scheduled_batching_time::text AS planned_time,
                  to_char(co.site_ready_confirmed_at, 'HH24:MI') AS actual_time,
                  co.site_ready_delay_reason AS reason, u.name AS reason_by_name, co.site_ready_delay_reason_at AS reason_at,
                  EXTRACT(EPOCH FROM (co.site_ready_confirmed_at - (co.order_date + co.scheduled_batching_time))) / 60 AS delay_minutes
           FROM customer_orders co
           JOIN customers c ON c.id = co.customer_id JOIN sites s ON s.id = co.site_id
           LEFT JOIN users u ON u.id = co.site_ready_delay_reason_by
           WHERE co.order_date BETWEEN $1 AND $2 AND co.site_ready_delay_reason IS NOT NULL
         ) x WHERE delay_minutes >= $3`,
        [fromDate, toDate, minMinutes]
      )
    );
  }
  if (delayType === "all" || delayType === "Batching not started") {
    queries.push(
      query(
        `SELECT co.order_date AS date, c.name AS customer_name, s.name AS site_name,
                'Batching not started' AS delay_type,
                to_char(co.site_ready_confirmed_at, 'HH24:MI') AS planned_time,
                to_char((SELECT MIN(dt.created_at) FROM delivery_tickets dt WHERE dt.order_id = co.id), 'HH24:MI') AS actual_time,
                co.batching_delay_reason AS reason, u.name AS reason_by_name, co.batching_delay_reason_at AS reason_at,
                NULL::numeric AS delay_minutes
         FROM customer_orders co
         JOIN customers c ON c.id = co.customer_id JOIN sites s ON s.id = co.site_id
         LEFT JOIN users u ON u.id = co.batching_delay_reason_by
         WHERE co.order_date BETWEEN $1 AND $2 AND co.site_ready_confirmed_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM notifications n WHERE n.order_id = co.id AND n.type = 'batching_not_started'
           )`,
        [fromDate, toDate]
      )
    );
  }
  if (delayType === "all" || delayType === "At site over 2 hours") {
    queries.push(
      query(
        `SELECT dt.ticket_date AS date, c.name AS customer_name, s.name AS site_name,
                'At site over 2 hours' AS delay_type,
                to_char(rs.event_time, 'HH24:MI') AS planned_time,
                to_char(dt.site_delay_reason_at, 'HH24:MI') AS actual_time,
                dt.site_delay_reason AS reason, u.name AS reason_by_name, dt.site_delay_reason_at AS reason_at,
                NULL::numeric AS delay_minutes
         FROM delivery_tickets dt
         JOIN customer_orders co ON co.id = dt.order_id
         JOIN customers c ON c.id = co.customer_id JOIN sites s ON s.id = co.site_id
         LEFT JOIN users u ON u.id = dt.site_delay_reason_by
         LEFT JOIN LATERAL (
           SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'reached_site' ORDER BY event_time DESC LIMIT 1
         ) rs ON true
         WHERE dt.ticket_date BETWEEN $1 AND $2 AND dt.site_delay_reason IS NOT NULL`,
        [fromDate, toDate]
      )
    );
  }

  const results = await Promise.all(queries);

  const rows = results.flatMap((r) => r.rows)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  res.json(rows);
});

// ===================== TRIP TIMING ANALYSIS (Charts) =====================
// One flexible endpoint rather than a fixed report per combination — any
// metric (transit/unloading/turnaround) crossed with any group-by dimension
// (site/truck/mix grade/driver/day of week), filtered by truck/site/grade
// and date range. This is what makes it pivot-like instead of a handful of
// bolted-together fixed charts.

const METRIC_EXPR = {
  transit: "EXTRACT(EPOCH FROM (tt.site_in - tt.plant_out)) / 60",
  unloading: "EXTRACT(EPOCH FROM (tt.site_out - tt.site_in)) / 60",
  turnaround: "EXTRACT(EPOCH FROM (tt.plant_in - tt.plant_out)) / 60",
};
const GROUP_EXPR = {
  site: { key: "tt.site_id", label: "tt.site_name" },
  truck: { key: "tt.truck_id", label: "tt.truck_number" },
  mix_grade: { key: "tt.mix_grade_id", label: "tt.mix_grade_name" },
  driver: { key: "tt.driver_id", label: "tt.driver_name" },
  day_of_week: { key: "trim(to_char(tt.ticket_date, 'Day'))", label: "trim(to_char(tt.ticket_date, 'Day'))" },
};

function tripTimesCTE(q, params) {
  const clauses = ["dt.ticket_date BETWEEN $1 AND $2"];
  params.push(q.from_date, q.to_date);
  if (q.truck_ids) { params.push(q.truck_ids.split(",").map(Number)); clauses.push(`dt.truck_id = ANY($${params.length})`); }
  if (q.site_ids) { params.push(q.site_ids.split(",").map(Number)); clauses.push(`co.site_id = ANY($${params.length})`); }
  if (q.mix_grade_ids) { params.push(q.mix_grade_ids.split(",").map(Number)); clauses.push(`co.mix_grade_id = ANY($${params.length})`); }
  return `
    WITH trip_times AS (
      SELECT dt.id AS ticket_id, dt.ticket_date, dt.truck_id, dt.driver_id, dt.loaded_quantity_m3,
             co.site_id, co.mix_grade_id,
             t.truck_number, s.name AS site_name, m.name AS mix_grade_name, u.name AS driver_name, c.name AS customer_name,
             po.event_time AS plant_out, si.event_time AS site_in, so.event_time AS site_out, pi.event_time AS plant_in
      FROM delivery_tickets dt
      JOIN customer_orders co ON co.id = dt.order_id
      JOIN sites s ON s.id = co.site_id
      JOIN mix_grades m ON m.id = co.mix_grade_id
      JOIN customers c ON c.id = co.customer_id
      LEFT JOIN trucks t ON t.id = dt.truck_id
      LEFT JOIN users u ON u.id = dt.driver_id
      LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'left_plant' ORDER BY event_time LIMIT 1) po ON true
      LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'reached_site' ORDER BY event_time LIMIT 1) si ON true
      LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_completed' ORDER BY event_time LIMIT 1) so ON true
      LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'returned_to_plant' ORDER BY event_time LIMIT 1) pi ON true
      WHERE ${clauses.join(" AND ")}
    )
  `;
}

router.get("/trip-analysis", requireRole("manager", "administrator"), async (req, res) => {
  const metric = METRIC_EXPR[req.query.metric] ? req.query.metric : "unloading";
  const groupBy = GROUP_EXPR[req.query.group_by] ? req.query.group_by : "site";
  const params = [];
  const cte = tripTimesCTE(req.query, params);
  const { key, label } = GROUP_EXPR[groupBy];

  const { rows } = await query(
    `${cte}
     SELECT ${label} AS group_label, ${key} AS group_key,
            ROUND(AVG(${METRIC_EXPR[metric]})::numeric, 1) AS avg_minutes,
            ROUND(MIN(${METRIC_EXPR[metric]})::numeric, 1) AS min_minutes,
            ROUND(MAX(${METRIC_EXPR[metric]})::numeric, 1) AS max_minutes,
            COUNT(*) AS trip_count
     FROM trip_times tt
     WHERE tt.plant_out IS NOT NULL AND tt.site_in IS NOT NULL AND tt.site_out IS NOT NULL AND tt.plant_in IS NOT NULL
     GROUP BY ${label}, ${key}
     HAVING COUNT(*) > 0
     ORDER BY avg_minutes DESC`,
    params
  );
  res.json(rows);
});

// Drill-down — the individual trips behind one group's average.
router.get("/trip-analysis/detail", requireRole("manager", "administrator"), async (req, res) => {
  const metric = METRIC_EXPR[req.query.metric] ? req.query.metric : "unloading";
  const groupBy = GROUP_EXPR[req.query.group_by] ? req.query.group_by : "site";
  const params = [];
  const cte = tripTimesCTE(req.query, params);
  const { key } = GROUP_EXPR[groupBy];
  params.push(req.query.group_key);

  const { rows } = await query(
    `${cte}
     SELECT tt.ticket_date, tt.customer_name, tt.site_name, tt.truck_number, tt.driver_name, tt.mix_grade_name, tt.loaded_quantity_m3,
            ROUND((${METRIC_EXPR[metric]})::numeric, 1) AS minutes
     FROM trip_times tt
     WHERE tt.plant_out IS NOT NULL AND tt.site_in IS NOT NULL AND tt.site_out IS NOT NULL AND tt.plant_in IS NOT NULL
       AND ${key}::text = $${params.length}
     ORDER BY tt.ticket_date DESC`,
    params
  );
  res.json(rows);
});

// Scatter mode — unloading time against quantity delivered, not grouped,
// since quantity is continuous rather than a natural pivot dimension.
router.get("/trip-analysis/scatter", requireRole("manager", "administrator"), async (req, res) => {
  const params = [];
  const cte = tripTimesCTE(req.query, params);
  const { rows } = await query(
    `${cte}
     SELECT tt.loaded_quantity_m3 AS quantity_m3,
            ROUND((${METRIC_EXPR.unloading})::numeric, 1) AS unloading_minutes,
            tt.site_name, tt.truck_number, tt.mix_grade_name, tt.customer_name
     FROM trip_times tt
     WHERE tt.site_in IS NOT NULL AND tt.site_out IS NOT NULL`,
    params
  );
  res.json(rows);
});

// Cycle time report (Gantt) — per-trip phase boundaries: DN creation (QC
// checks) through Plant Out, Site In, Unloading Start, and Unloading
// Complete. Each trip's own timestamps, not aggregated — the frontend draws
// the actual timeline from these.
router.get("/cycle-time", requireRole("manager", "administrator"), async (req, res) => {
  const fromDate = req.query.from_date || new Date().toISOString().slice(0, 10);
  const toDate = req.query.to_date || fromDate;
  const sortBy = req.query.sort_by === "truck" ? "t.truck_number" : "dt.ticket_number";

  const clauses = ["dt.ticket_date BETWEEN $1 AND $2", "dt.status NOT IN ('cancelled', 'rejected')"];
  const params = [fromDate, toDate];
  if (req.query.customer_id) { params.push(req.query.customer_id); clauses.push(`co.customer_id = $${params.length}`); }
  if (req.query.site_id) { params.push(req.query.site_id); clauses.push(`co.site_id = $${params.length}`); }

  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, dt.status, dt.loaded_quantity_m3, dt.created_at,
            t.truck_number, u.name AS driver_name, c.name AS customer_name, s.name AS site_name,
            lp.event_time AS left_plant, rs.event_time AS reached_site,
            us.event_time AS unloading_started, uc.event_time AS unloading_completed
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     LEFT JOIN trucks t ON t.id = dt.truck_id
     LEFT JOIN users u ON u.id = dt.driver_id
     LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'left_plant' ORDER BY event_time LIMIT 1) lp ON true
     LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'reached_site' ORDER BY event_time LIMIT 1) rs ON true
     LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_started' ORDER BY event_time LIMIT 1) us ON true
     LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_completed' ORDER BY event_time LIMIT 1) uc ON true
     WHERE ${clauses.join(" AND ")}
     ORDER BY ${sortBy}
     LIMIT 500`,
    params
  );
  res.json(rows);
});

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

    query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE payment_date = CURRENT_DATE - INTERVAL '1 day'`),
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
      `SELECT COALESCE(p.pump_code, 'Without pump') AS pump_code, COALESCE(p.pump_type::text, 'none') AS pump_type,
              COUNT(dt.id) AS deliveries,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       LEFT JOIN pumps p ON p.id = co.pump_id
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
    collected_yesterday: collectedToday.rows[0].total,
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
