// Round 143 — the Administrator dashboard's icon view (see
// claude/admin-dashboard-icon-view-notes.md and the "Admin Dashboard — Icon
// View" mockup). Two jobs, deliberately kept off administrator.js, which is
// already 77 routes of master-data CRUD:
//
//   GET  /summary  — the four KPI tiles plus every pending count the grid
//                    badges, in ONE call. The counts already existed, but
//                    scattered across five routers; asking each of them in
//                    turn would have meant five round trips before the home
//                    screen could paint.
//   GET  /pins     — this user's pinned screen keys.
//   PUT  /pins     — replace them.
//
// Administrator-only at the ROUTER level (same reasoning as qcDashboard.js in
// round 141): a per-route override is something a later edit can silently
// drop, a router-level guard is not.
//
// The screen keys this file knows about are the badge keys only. The full
// screen registry lives on the frontend in lib/adminScreens.js — the labels,
// icons and routes are a UI concern, and duplicating them here would give the
// two halves a chance to disagree.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);
router.use(requireRole("administrator"));

// Screen keys a Super Admin could later pin; validated so a bad client can't
// store arbitrary text that the frontend would then try to render.
const PIN_KEY_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const MAX_PINS = 8;

// The outstanding-collection balance, same two-legged shape reports.js's own
// /outstanding-collection uses (invoices net of payments, UNION opening
// balances net of payments). Kept identical on purpose: the KPI tile and that
// report must never show two different numbers for the same day.
const OUTSTANDING_CTE = `
  WITH inv AS (
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
  )`;

router.get("/summary", async (req, res) => {
  const [
    ordersToday, productionToday, challanToday, monthProduction, monthTarget, outstanding,
    materialOrders, mixDesigns, breakdowns, bookings, leads, compliance,
  ] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(order_quantity_m3), 0) AS m3
       FROM customer_orders
       WHERE order_date = CURRENT_DATE AND status <> 'cancelled'`
    ),
    // The Plant Operator's own figure is the production number everywhere in
    // this app — it excludes rejected and duplicated loads, which the challan
    // total does not. The challan figure is shown beside it, never instead of
    // it (the same rule the Material Module's cost/m3 follows).
    query(
      `SELECT COALESCE(SUM(concrete_produced_m3), 0) AS m3
       FROM rm_daily_production WHERE production_date = CURRENT_DATE`
    ),
    query(
      `SELECT COUNT(*)::int AS tickets, COALESCE(SUM(loaded_quantity_m3), 0) AS m3
       FROM delivery_tickets
       WHERE ticket_date = CURRENT_DATE AND status NOT IN ('cancelled', 'rejected', 'returned')`
    ),
    query(
      `SELECT COALESCE(SUM(concrete_produced_m3), 0) AS m3
       FROM rm_daily_production
       WHERE production_date >= date_trunc('month', CURRENT_DATE)
         AND production_date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'`
    ),
    query(
      `SELECT target_m3 FROM monthly_production_targets
       WHERE year = EXTRACT(YEAR FROM CURRENT_DATE)::int AND month = EXTRACT(MONTH FROM CURRENT_DATE)::int`
    ),
    query(
      `${OUTSTANDING_CTE}
       SELECT COALESCE(SUM(outstanding), 0) AS total,
              COUNT(*) FILTER (WHERE outstanding > 0.01 AND age_days > 30)::int AS overdue_30_plus
       FROM inv WHERE outstanding > 0.01`
    ),
    query(`SELECT COUNT(*)::int AS n FROM rm_orders WHERE status = 'pending_approval'`),
    query(`SELECT COUNT(*)::int AS n FROM mix_designs WHERE status = 'draft'`),
    query(`SELECT COUNT(*)::int AS n FROM breakdown_reports WHERE NOT resolved`),
    query(`SELECT COUNT(*)::int AS n FROM bookings WHERE status = 'pending'`),
    query(`SELECT COUNT(*)::int AS n FROM leads WHERE assigned_to IS NULL AND status = 'new'`),
    query(
      `SELECT COUNT(*)::int AS n FROM compliance_documents
       WHERE expiry_date <= CURRENT_DATE + INTERVAL '30 days'`
    ),
  ]);

  const achieved = Number(monthProduction.rows[0].m3);
  const target = monthTarget.rows[0] ? Number(monthTarget.rows[0].target_m3) : null;

  res.json({
    kpis: {
      // m3 leads, the order count is the supporting line — volume is what the
      // plant is measured on, not how many orders it arrived in.
      orders_today_m3: Number(ordersToday.rows[0].m3),
      orders_today_count: ordersToday.rows[0].orders,
      production_today_m3: Number(productionToday.rows[0].m3),
      challan_today_m3: Number(challanToday.rows[0].m3),
      challan_today_tickets: challanToday.rows[0].tickets,
      month_production_m3: achieved,
      month_target_m3: target,
      // Null, not 0, when no target is set for the month: "no target" and
      // "0% of target" are different states and the tile says which.
      month_target_pct: target ? (achieved / target) * 100 : null,
      outstanding_total: Number(outstanding.rows[0].total),
      outstanding_overdue_30_plus: outstanding.rows[0].overdue_30_plus,
    },
    badges: {
      "material-module": materialOrders.rows[0].n,
      "mix-designs-approve": mixDesigns.rows[0].n,
      "equipment-breakdowns": breakdowns.rows[0].n,
      "booking-links": bookings.rows[0].n,
      "assign-lead": leads.rows[0].n,
      "statutory-compliance": compliance.rows[0].n,
      "outstanding-collection": outstanding.rows[0].overdue_30_plus,
    },
  });
});

// ===== Pinned screens =====
// One row per user, holding the keys in the order they should appear. Stored
// per person and never shared: what the Administrator pins has no effect on
// anyone else's dashboard.

router.get("/pins", async (req, res) => {
  const { rows } = await query(`SELECT screen_keys FROM user_dashboard_pins WHERE user_id = $1`, [req.user.id]);
  res.json({ keys: rows[0] ? rows[0].screen_keys : null });
});

router.put("/pins", async (req, res) => {
  const keys = req.body && req.body.keys;
  if (!Array.isArray(keys)) return res.status(400).json({ error: "Send the pinned screens as a list." });
  if (keys.length > MAX_PINS) return res.status(400).json({ error: `You can pin at most ${MAX_PINS} screens.` });
  // Reject anything that isn't a plain screen key, and silently collapse
  // duplicates rather than rendering the same tile twice.
  const clean = [];
  for (const k of keys) {
    if (typeof k !== "string" || !PIN_KEY_RE.test(k)) {
      // Deliberately NOT "no such screen": this file doesn't hold the
      // registry (see the header note), so it can only vouch for the shape.
      // A key that passes here but matches no screen is skipped when the
      // grid renders, which is the documented behaviour.
      return res.status(400).json({ error: "That isn't a valid screen name." });
    }
    if (!clean.includes(k)) clean.push(k);
  }
  await query(
    `INSERT INTO user_dashboard_pins (user_id, screen_keys, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET screen_keys = EXCLUDED.screen_keys, updated_at = now()`,
    [req.user.id, clean]
  );
  res.json({ keys: clean });
});

export default router;
