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
// The four headline figures have ONE definition, shared with the Reports
// page's Director's Dashboard — see the header note in that file.
import { dashboardKpis } from "../lib/dashboardKpis.js";

const router = Router();
router.use(requireAuth);
router.use(requireRole("administrator"));

// Screen keys a Super Admin could later pin; validated so a bad client can't
// store arbitrary text that the frontend would then try to render.
const PIN_KEY_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const MAX_PINS = 8;

router.get("/summary", async (req, res) => {
  const [
    kpis,
    monthTarget,
    materialOrders, mixDesigns, breakdowns, bookings, leads, compliance,
  ] = await Promise.all([
    dashboardKpis(),
    query(
      `SELECT target_m3 FROM monthly_production_targets
       WHERE year = EXTRACT(YEAR FROM CURRENT_DATE)::int AND month = EXTRACT(MONTH FROM CURRENT_DATE)::int`
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

  const target = monthTarget.rows[0] ? Number(monthTarget.rows[0].target_m3) : null;

  // How many invoices are more than 30 days overdue. This is the only figure
  // here that uses the Outstanding Collection *report's* per-invoice
  // arithmetic rather than the KPI total's, because "how many are late" is a
  // per-invoice question. It is a count, never a rupee figure, so it cannot be
  // mistaken for the total beside it.
  const overdue = await query(
    `WITH inv AS (
       SELECT i.customer_id, i.total_amount - COALESCE(p.paid, 0) AS outstanding,
              (CURRENT_DATE - i.created_at::date) AS age_days
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p
         ON p.invoice_id = i.id
     )
     SELECT COUNT(*)::int AS n FROM inv WHERE outstanding > 0.01 AND age_days > 30`
  );

  res.json({
    kpis: {
      // Today's Order — m3 leads, the order count is the supporting line.
      orders_today_m3: kpis.order_qty_today,
      orders_today_count: kpis.order_count_today,
      // Today's Production — the delivery-challan quantity net of site
      // rejections, exactly as the Reports page reports it. NOT the Plant
      // Operator's own daily entry, which is the right basis only for the
      // Material Module's cost per m3 and is often not filled in at all.
      production_today_m3: kpis.supplied_qty_today,
      challan_today_tickets: kpis.ticket_count_today,
      rejected_today_m3: kpis.rejected_qty_today,
      month_production_m3: kpis.monthly_production_qty,
      month_target_m3: target,
      // Null, not 0, when no target is set for the month: "no target" and
      // "0% of target" are different states and the tile says which.
      month_target_pct: target ? (kpis.monthly_production_qty / target) * 100 : null,
      outstanding_total: kpis.total_outstanding,
      outstanding_overdue_30_plus: overdue.rows[0].n,
    },
    badges: {
      "material-module": materialOrders.rows[0].n,
      "mix-designs-approve": mixDesigns.rows[0].n,
      "equipment-breakdowns": breakdowns.rows[0].n,
      "booking-links": bookings.rows[0].n,
      "assign-lead": leads.rows[0].n,
      "statutory-compliance": compliance.rows[0].n,
      "outstanding-collection": overdue.rows[0].n,
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
