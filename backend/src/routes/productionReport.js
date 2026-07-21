import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
// Same visibility as the Director's Dashboard — Administrator only.
router.use(requireAuth, requireRole("administrator"));

const VALID_STATUSES = ["signed", "pending", "refused"];

// Builds the shared WHERE clause + params from query filters. Every filter is
// optional and combined with AND — an absent filter just doesn't add a clause.
function buildFilters(q) {
  const clauses = ["dt.status != 'cancelled'"];
  const params = [];

  function add(clause, value) {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  }

  if (q.from_date) add("dt.ticket_date >= ?", q.from_date);
  if (q.to_date) add("dt.ticket_date <= ?", q.to_date);
  if (q.customer_id) add("co.customer_id = ?", q.customer_id);
  if (q.site_id) add("co.site_id = ?", q.site_id);
  if (q.truck_id) add("dt.truck_id = ?", q.truck_id);
  if (q.driver_id) add("dt.driver_id = ?", q.driver_id);
  if (q.salesperson_id) add("co.sales_representative_id = ?", q.salesperson_id);
  if (q.pump_id) add("co.pump_id = ?", q.pump_id);
  if (q.supervisor_id) add("co.assigned_site_supervisor_id = ?", q.supervisor_id);

  // Delivery note status — multi-select. Absent/empty means "All" (no filter).
  if (q.delivery_note_status) {
    const statuses = String(q.delivery_note_status).split(",").map((s) => s.trim().toLowerCase())
      .filter((s) => VALID_STATUSES.includes(s));
    if (statuses.length > 0) {
      params.push(statuses);
      clauses.push(`sq.delivery_note_status = ANY($${params.length})`);
    }
  }

  return { where: clauses.join(" AND "), params };
}

const BASE_FROM = `
  FROM delivery_tickets dt
  JOIN customer_orders co ON co.id = dt.order_id
  JOIN customers c ON c.id = co.customer_id
  JOIN sites s ON s.id = co.site_id
  JOIN mix_grades m ON m.id = co.mix_grade_id
  JOIN trucks t ON t.id = dt.truck_id
  JOIN users u_driver ON u_driver.id = dt.driver_id
  LEFT JOIN salespersons sp ON sp.id = co.sales_representative_id
  LEFT JOIN pumps p ON p.id = co.pump_id
  LEFT JOIN users u_sup ON u_sup.id = co.assigned_site_supervisor_id
  LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
  LEFT JOIN invoices i ON i.ticket_id = dt.id
`;

const ROW_COLUMNS = `
  dt.id, dt.ticket_number AS dc_no, dt.ticket_date, dt.loaded_quantity_m3 AS quantity_m3,
  c.name AS customer_name, s.name AS site_name, t.truck_number, u_driver.name AS driver_name,
  sp.name AS salesperson_name, p.pump_code, u_sup.name AS supervisor_name, m.name AS grade_name,
  sq.delivery_note_status,
  CASE WHEN dt.loaded_quantity_m3 > 0 AND i.concrete_amount IS NOT NULL
       THEN ROUND(i.concrete_amount / dt.loaded_quantity_m3, 2) END AS rate,
  i.total_amount AS amount
`;

// Paginated results + totals for the current filtered set (not just the visible page).
router.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 100));
  const { where, params } = buildFilters(req.query);

  const [rowsResult, totalsResult] = await Promise.all([
    query(
      `SELECT ${ROW_COLUMNS} ${BASE_FROM}
       WHERE ${where}
       ORDER BY dt.ticket_date DESC, dt.id DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    ),
    query(
      `SELECT COUNT(*) AS delivery_count,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS total_qty_m3,
              COALESCE(SUM(i.total_amount), 0) AS total_amount
       ${BASE_FROM}
       WHERE ${where}`,
      params
    ),
  ]);

  res.json({
    rows: rowsResult.rows,
    page, page_size: pageSize,
    totals: {
      delivery_count: Number(totalsResult.rows[0].delivery_count),
      total_qty_m3: totalsResult.rows[0].total_qty_m3,
      total_amount: totalsResult.rows[0].total_amount,
    },
  });
});

// Full filtered set, unpaginated — for PDF/Excel export. Capped at 5000 rows;
// narrow the date range if a filter combination genuinely exceeds that.
router.get("/export", async (req, res) => {
  const { where, params } = buildFilters(req.query);
  const { rows } = await query(
    `SELECT ${ROW_COLUMNS} ${BASE_FROM}
     WHERE ${where}
     ORDER BY dt.ticket_date DESC, dt.id DESC
     LIMIT 5000`,
    params
  );
  res.json(rows);
});

export default router;
