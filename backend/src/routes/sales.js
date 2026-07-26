import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole } from "../lib/push.js";

const router = Router();
router.use(requireAuth);

// Resolves the salespersons.id linked to a logged-in Sales Executive's
// account -- that's what customer_orders.sales_representative_id actually
// points at, so every "my sales" query goes through this.
async function mySalespersonId(userId) {
  const { rows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [userId]);
  return rows[0]?.id || null;
}

// ===================== LEADS =====================

router.post("/leads", requireRole("manager", "administrator"), async (req, res) => {
  const { prospect_name, contact_person, contact_phone, site_location, mix_grade_interest, estimated_qty_m3, assigned_to, site_latitude, site_longitude } = req.body;
  if (!prospect_name || !assigned_to) {
    return res.status(400).json({ error: "Prospect name and an assigned salesperson are required." });
  }
  const { rows } = await query(
    `INSERT INTO leads (prospect_name, contact_person, contact_phone, site_location, mix_grade_interest, estimated_qty_m3, assigned_to, created_by, site_latitude, site_longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [prospect_name, contact_person || null, contact_phone || null, site_location || null,
     mix_grade_interest || null, estimated_qty_m3 || null, assigned_to, req.user.id,
     site_latitude || null, site_longitude || null]
  );
  await pushToRole("sales_executive", {
    title: "New lead assigned",
    body: prospect_name,
    url: "/sales",
  });
  res.status(201).json(rows[0]);
});

// A Sales Executive adding their own lead, not one assigned by Admin/Manager —
// auto-assigned and attributed to themselves.
router.post("/leads/self", requireRole("sales_executive"), async (req, res) => {
  const { prospect_name, contact_person, contact_phone, site_location, mix_grade_interest, estimated_qty_m3, at_site, latitude, longitude } = req.body;
  if (!prospect_name) return res.status(400).json({ error: "Prospect name is required." });
  if (typeof at_site !== "boolean") {
    return res.status(400).json({ error: "Let us know whether you're at site for this lead." });
  }
  const { rows } = await query(
    `INSERT INTO leads (prospect_name, contact_person, contact_phone, site_location, mix_grade_interest, estimated_qty_m3, assigned_to, created_by, at_site, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10) RETURNING *`,
    [prospect_name, contact_person || null, contact_phone || null, site_location || null,
     mix_grade_interest || null, estimated_qty_m3 || null, req.user.id,
     at_site, at_site ? (latitude || null) : null, at_site ? (longitude || null) : null]
  );
  res.status(201).json(rows[0]);
});

router.get("/leads", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const own = req.user.role === "sales_executive";
  const { rows } = await query(
    `SELECT l.*, u.name AS assigned_to_name, creator.name AS created_by_name
     FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     LEFT JOIN users creator ON creator.id = l.created_by
     ${own ? "WHERE l.assigned_to = $1" : ""}
     ORDER BY l.status = 'won', l.status = 'lost', l.updated_at DESC`,
    own ? [req.user.id] : []
  );
  res.json(rows);
});

router.get("/leads/:id", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT l.*, u.name AS assigned_to_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Lead not found." });
  if (req.user.role === "sales_executive" && rows[0].assigned_to !== req.user.id) {
    return res.status(403).json({ error: "This lead isn't assigned to you." });
  }
  const { rows: followups } = await query(
    `SELECT lf.*, u.name AS created_by_name FROM lead_followups lf
     LEFT JOIN users u ON u.id = lf.created_by WHERE lf.lead_id = $1 ORDER BY lf.created_at DESC`,
    [req.params.id]
  );
  res.json({ ...rows[0], followups });
});

const ACTIVITY_TYPES = ["note", "quotation_issued", "quotation_followup", "quotation_revised", "meeting", "site_visit"];

router.post("/leads/:id/followup", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const {
    note, activity_type, quotation_amount, revision_reason, persons_met,
    at_site, latitude, longitude,
  } = req.body;
  if (!note) return res.status(400).json({ error: "Enter a note describing this update." });
  const type = ACTIVITY_TYPES.includes(activity_type) ? activity_type : "note";
  if (typeof at_site !== "boolean") {
    return res.status(400).json({ error: "Let us know whether you're at site for this update." });
  }

  await query(
    `INSERT INTO lead_followups
     (lead_id, activity_type, note, quotation_amount, revision_reason, persons_met, at_site, latitude, longitude, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.params.id, type, note, quotation_amount || null, revision_reason || null, persons_met || null,
     at_site, at_site ? (latitude || null) : null, at_site ? (longitude || null) : null, req.user.id]
  );

  const statusBump = type === "note" ? "CASE WHEN status = 'new' THEN 'contacted' ELSE status END" : "status";
  if (type === "quotation_issued" || type === "quotation_revised") {
    await query(
      `UPDATE leads SET status = ${statusBump}, quotation_issued = true,
         latest_quotation_amount = COALESCE($1, latest_quotation_amount), updated_at = now()
       WHERE id = $2`,
      [quotation_amount || null, req.params.id]
    );
  } else {
    await query(`UPDATE leads SET status = ${statusBump}, updated_at = now() WHERE id = $1`, [req.params.id]);
  }
  res.json({ ok: true });
});

router.post("/leads/:id/lost", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const { lost_reason } = req.body;
  if (!lost_reason) return res.status(400).json({ error: "A reason is required to mark a lead lost." });
  await query(
    "UPDATE leads SET status = 'lost', lost_reason = $1, updated_at = now() WHERE id = $2",
    [lost_reason, req.params.id]
  );
  res.json({ ok: true });
});

router.post("/leads/:id/won", requireRole("administrator"), async (req, res) => {
  const { attribution, won_customer_id, won_order_id } = req.body;
  if (!["salesperson", "company"].includes(attribution)) {
    return res.status(400).json({ error: "Choose whether this counts as the salesperson's sale or the company's." });
  }
  const { rows } = await query(
    `UPDATE leads SET status = 'won', attribution = $1, won_customer_id = $2, won_order_id = $3, updated_at = now()
     WHERE id = $4 RETURNING *`,
    [attribution, won_customer_id || null, won_order_id || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Lead not found." });
  res.json(rows[0]);
});

// ===================== BOOKINGS =====================

router.post("/bookings", requireRole("sales_executive"), async (req, res) => {
  const { customer_id, site_id, mix_grade_id, estimated_qty_m3, preferred_date, notes } = req.body;
  if (!customer_id) return res.status(400).json({ error: "Select a customer." });
  const { rows } = await query(
    `INSERT INTO bookings (customer_id, site_id, mix_grade_id, estimated_qty_m3, preferred_date, notes, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [customer_id, site_id || null, mix_grade_id || null, estimated_qty_m3 || null, preferred_date || null, notes || null, req.user.id]
  );
  await pushToRole("manager", {
    title: "New booking submitted",
    body: `From ${req.user.name}`,
    url: "/manager",
  });
  res.status(201).json(rows[0]);
});

router.get("/bookings", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const own = req.user.role === "sales_executive";
  const { rows } = await query(
    `SELECT b.*, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name, u.name AS requested_by_name
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     LEFT JOIN sites s ON s.id = b.site_id
     LEFT JOIN mix_grades m ON m.id = b.mix_grade_id
     LEFT JOIN users u ON u.id = b.requested_by
     ${own ? "WHERE b.requested_by = $1" : ""}
     ORDER BY b.status = 'pending' DESC, b.created_at DESC`,
    own ? [req.user.id] : []
  );
  res.json(rows);
});

router.post("/bookings/:id/decline", requireRole("manager", "administrator"), async (req, res) => {
  const { declined_reason } = req.body;
  await query(
    "UPDATE bookings SET status = 'declined', declined_reason = $1 WHERE id = $2",
    [declined_reason || null, req.params.id]
  );
  res.json({ ok: true });
});

// Manager converts a booking into a real order, after confirming site
// readiness and payment terms — the booking itself never becomes an order
// automatically, this is a deliberate human step.
router.post("/bookings/:id/convert", requireRole("manager", "administrator"), async (req, res) => {
  const { rows: bookingRows } = await query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
  const booking = bookingRows[0];
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  if (booking.status !== "pending") return res.status(400).json({ error: "This booking has already been converted or declined." });

  const {
    order_date, scheduled_batching_time, truck_dispatch_interval_minutes,
    site_id, mix_grade_id, pump_requirement, pump_id,
    site_technician_required, cube_samples_required, assigned_pump_crew,
    assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
    sales_representative_id, casting_location, pump_departure_time, remarks,
  } = req.body;

  const finalSiteId = site_id || booking.site_id;
  const finalMixGradeId = mix_grade_id || booking.mix_grade_id;
  const finalQty = order_quantity_m3 || booking.estimated_qty_m3;
  let finalSalesRepId = sales_representative_id || null;
  if (!finalSalesRepId) {
    const { rows: spRows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [booking.requested_by]);
    finalSalesRepId = spRows[0]?.id || null;
  }
  const required = { order_date, scheduled_batching_time, truck_dispatch_interval_minutes,
    site_id: finalSiteId, mix_grade_id: finalMixGradeId, pump_requirement, site_contact_number, order_quantity_m3: finalQty };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === "") {
      return res.status(400).json({ error: `${key.replaceAll("_", " ")} is required.` });
    }
  }

  const { rows } = await query(
    `INSERT INTO customer_orders
     (order_date, scheduled_batching_time, truck_dispatch_interval_minutes, customer_id, site_id,
      mix_grade_id, pump_requirement, pump_id, site_technician_required, cube_samples_required,
      assigned_pump_crew, assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
      sales_representative_id, casting_location, pump_departure_time, remarks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [order_date, scheduled_batching_time, truck_dispatch_interval_minutes, booking.customer_id, finalSiteId,
     finalMixGradeId, pump_requirement, pump_id || null, !!site_technician_required, cube_samples_required || null,
     assigned_pump_crew || null, assigned_site_supervisor_id || null, site_contact_number, finalQty,
     finalSalesRepId, casting_location || null, pump_departure_time || null, remarks || null, req.user.id]
  );

  await query(
    "UPDATE bookings SET status = 'converted', converted_order_id = $1 WHERE id = $2",
    [rows[0].id, req.params.id]
  );
  res.status(201).json(rows[0]);
});

// ===================== AFTER-SALES FEEDBACK =====================

router.post("/feedback", requireRole("sales_executive"), async (req, res) => {
  const { customer_id, order_id, feedback_type, comment } = req.body;
  if (!customer_id || !feedback_type || !comment) {
    return res.status(400).json({ error: "Customer, feedback type, and a comment are all required." });
  }
  if (!["compliment", "complaint"].includes(feedback_type)) {
    return res.status(400).json({ error: "Feedback type must be compliment or complaint." });
  }
  const { rows } = await query(
    `INSERT INTO aftersales_feedback (customer_id, order_id, feedback_type, comment, recorded_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [customer_id, order_id || null, feedback_type, comment, req.user.id]
  );
  if (feedback_type === "complaint") {
    await pushToRole("manager", { title: "Customer complaint logged", body: comment.slice(0, 80), url: "/manager" });
  }
  res.status(201).json(rows[0]);
});

router.get("/feedback", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const own = req.user.role === "sales_executive";
  const { rows } = await query(
    `SELECT f.*, c.name AS customer_name, u.name AS recorded_by_name
     FROM aftersales_feedback f
     JOIN customers c ON c.id = f.customer_id
     LEFT JOIN users u ON u.id = f.recorded_by
     ${own ? "WHERE f.recorded_by = $1" : ""}
     ORDER BY f.created_at DESC`,
    own ? [req.user.id] : []
  );
  res.json(rows);
});

// ===================== CUSTOMER VISITS =====================

const VISITOR_TYPES = ["customer", "client", "consultant", "site_engineer", "other"];

router.post("/visits", requireRole("sales_executive"), async (req, res) => {
  const { customer_id, visited_name, visitor_type, visit_date, visit_time, contact_person, discussion_outcome, at_site, latitude, longitude } = req.body;
  if (!visited_name || !visit_date || !discussion_outcome) {
    return res.status(400).json({ error: "Who you visited, the date, and the discussion outcome are all required." });
  }
  if (!VISITOR_TYPES.includes(visitor_type)) {
    return res.status(400).json({ error: "Select who this is — customer, client, consultant, site engineer, or other." });
  }
  if (typeof at_site !== "boolean") {
    return res.status(400).json({ error: "Let us know whether you're at site for this visit." });
  }
  const { rows } = await query(
    `INSERT INTO customer_visits (customer_id, visited_name, visitor_type, visited_by, visit_date, visit_time, contact_person, discussion_outcome, at_site, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [customer_id || null, visited_name, visitor_type, req.user.id, visit_date, visit_time || null, contact_person || null, discussion_outcome,
     at_site, at_site ? (latitude || null) : null, at_site ? (longitude || null) : null]
  );
  res.status(201).json(rows[0]);
});

// Sales Executive sees their own visits; Manager/Administrator see everyone's
// (this is the report that shows on Admin's Sales Performance dashboard).
router.get("/visits", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const own = req.user.role === "sales_executive";
  const { rows } = await query(
    `SELECT cv.*, c.name AS customer_name, u.name AS visited_by_name
     FROM customer_visits cv
     LEFT JOIN customers c ON c.id = cv.customer_id
     JOIN users u ON u.id = cv.visited_by
     ${own ? "WHERE cv.visited_by = $1" : ""}
     ORDER BY cv.visit_date DESC, cv.created_at DESC
     LIMIT 200`,
    own ? [req.user.id] : []
  );
  res.json(rows);
});

// ===================== SALES EXECUTIVE'S OWN DASHBOARD =====================

router.get("/my-dashboard", requireRole("sales_executive"), async (req, res) => {
  const spId = await mySalespersonId(req.user.id);
  if (!spId) {
    return res.json({ customers: [], orders_month_qty: 0, orders_month_value: 0, outstanding: 0, outstanding_by_customer: [], lead_counts: {} });
  }

  const [customers, ordersMonth, outstanding, outstandingByCustomer, leadCounts] = await Promise.all([
    query(
      `SELECT DISTINCT c.id, c.name FROM customer_orders co
       JOIN customers c ON c.id = co.customer_id
       WHERE co.sales_representative_id = $1 ORDER BY c.name`,
      [spId]
    ),
    query(
      `SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) AS qty, COALESCE(SUM(i.total_amount), 0) AS value
       FROM customer_orders co
       JOIN delivery_tickets dt ON dt.order_id = co.id AND dt.status != 'cancelled'
       LEFT JOIN invoices i ON i.ticket_id = dt.id
       WHERE co.sales_representative_id = $1 AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`,
      [spId]
    ),
    query(
      `SELECT COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS total
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE co.sales_representative_id = $1`,
      [spId]
    ),
    query(
      `SELECT c.name AS customer_name,
              COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS outstanding
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = co.customer_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE co.sales_representative_id = $1
       GROUP BY c.name
       HAVING COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) > 0.01
       ORDER BY outstanding DESC`,
      [spId]
    ),
    query(
      `SELECT status, COUNT(*) AS count FROM leads WHERE assigned_to = $1 GROUP BY status`,
      [req.user.id]
    ),
  ]);

  res.json({
    customers: customers.rows,
    orders_month_qty: ordersMonth.rows[0].qty,
    orders_month_value: ordersMonth.rows[0].value,
    outstanding: outstanding.rows[0].total,
    outstanding_by_customer: outstandingByCustomer.rows,
    lead_counts: Object.fromEntries(leadCounts.rows.map((r) => [r.status, Number(r.count)])),
  });
});

// ===================== ADMIN: COMBINED PERFORMANCE DASHBOARD =====================

router.get("/performance", requireRole("administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT sp.id AS salesperson_id, sp.name, sp.user_id,
            COALESCE(month_stats.qty, 0) AS orders_month_qty,
            COALESCE(month_stats.value, 0) AS orders_month_value,
            COALESCE(outstanding_stats.total, 0) AS outstanding,
            COALESCE(lead_stats.total_leads, 0) AS total_leads,
            COALESCE(lead_stats.won_leads, 0) AS won_leads,
            COALESCE(lead_stats.lost_leads, 0) AS lost_leads,
            COALESCE(activity_stats.quotations, 0) AS quotations_this_month,
            COALESCE(activity_stats.meetings, 0) AS meetings_this_month,
            COALESCE(activity_stats.site_visits, 0) AS site_visits_this_month,
            COALESCE(visit_stats.visits, 0) AS customer_visits_this_month
     FROM salespersons sp
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) AS qty, COALESCE(SUM(i.total_amount), 0) AS value
       FROM customer_orders co
       JOIN delivery_tickets dt ON dt.order_id = co.id AND dt.status != 'cancelled'
       LEFT JOIN invoices i ON i.ticket_id = dt.id
       WHERE co.sales_representative_id = sp.id AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
     ) month_stats ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS total
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE co.sales_representative_id = sp.id
     ) outstanding_stats ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS total_leads,
              COUNT(*) FILTER (WHERE status = 'won') AS won_leads,
              COUNT(*) FILTER (WHERE status = 'lost') AS lost_leads
       FROM leads WHERE assigned_to = sp.user_id
     ) lead_stats ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE lf.activity_type IN ('quotation_issued', 'quotation_revised')) AS quotations,
              COUNT(*) FILTER (WHERE lf.activity_type = 'meeting') AS meetings,
              COUNT(*) FILTER (WHERE lf.activity_type = 'site_visit') AS site_visits
       FROM lead_followups lf
       JOIN leads l ON l.id = lf.lead_id
       WHERE l.assigned_to = sp.user_id AND date_trunc('month', lf.created_at) = date_trunc('month', CURRENT_DATE)
     ) activity_stats ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS visits
       FROM customer_visits cv
       WHERE cv.visited_by = sp.user_id AND date_trunc('month', cv.visit_date) = date_trunc('month', CURRENT_DATE)
     ) visit_stats ON true
     WHERE sp.is_active
     ORDER BY orders_month_value DESC`
  );
  res.json(rows);
});

export default router;
