import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole, pushToUser } from "../lib/push.js";

const router = Router();
router.use(requireAuth);

// A Sales Executive can't log any field activity — a lead, a booking, a
// visit, feedback, a forecast — until they're actually clocked in. Checked
// server-side (not just hidden in the UI) so it can't be bypassed. Only
// applies when the actor is the Sales Executive themselves; Manager/
// Administrator acting on a lead aren't subject to duty tracking at all.
async function requireOnDuty(req, res) {
  if (req.user.role !== "sales_executive") return true;
  const { rows } = await query(
    "SELECT is_on FROM sales_duty_log WHERE salesperson_user_id = $1 ORDER BY event_time DESC LIMIT 1",
    [req.user.id]
  );
  if (!rows[0]?.is_on) {
    res.status(403).json({ error: "Clock in first — you need to be on duty to do this." });
    return false;
  }
  return true;
}

// Resolves the salespersons.id linked to a logged-in Sales Executive's
// account -- that's what customer_orders.sales_representative_id actually
// points at, so every "my sales" query goes through this.
async function mySalespersonId(userId) {
  const { rows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [userId]);
  return rows[0]?.id || null;
}

// Admin/Manager can view a specific Sales Executive's own dashboard via
// ?as_user=<id> — needed once there's more than one Sales Executive, since
// otherwise Admin's own (empty) view was all there was to see. Only honored
// for admin/manager; a Sales Executive always sees their own regardless of
// what's passed.
function targetUserId(req) {
  if (["administrator", "manager"].includes(req.user.role) && req.query.as_user) {
    return Number(req.query.as_user);
  }
  return req.user.id;
}

router.get("/executives", requireRole("administrator", "manager"), async (req, res) => {
  const { rows } = await query("SELECT id, name FROM users WHERE role = 'sales_executive' AND is_active ORDER BY name");
  res.json(rows);
});

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
  if (!(await requireOnDuty(req, res))) return;
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
  if (!(await requireOnDuty(req, res))) return;
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

// Quick-add for a customer/site that doesn't exist yet — a Sales Executive
// sending a booking for a brand new lead shouldn't have to wait on
// Manager/Admin just to get a name into the system first. Kept deliberately
// minimal (name only for the customer; name + optional distance for the
// site) — Manager/Admin can fill in the fuller detail later when converting
// the booking to an order.
router.post("/quick-customer", requireRole("sales_executive"), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Customer name is required." });
  const { rows } = await query(
    "INSERT INTO customers (name) VALUES ($1) RETURNING *",
    [name.trim()]
  );
  res.status(201).json(rows[0]);
});

router.post("/quick-site", requireRole("sales_executive"), async (req, res) => {
  const { customer_id, name, distance_from_plant_km, force } = req.body;
  if (!customer_id || !name || !name.trim()) return res.status(400).json({ error: "Customer and site name are required." });
  const { rows: spRows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [req.user.id]);
  if (!spRows.length) return res.status(400).json({ error: "No salesperson record linked to your account — ask Manager/Admin to set this up first." });

  if (!force) {
    const { rows: dup } = await query(
      "SELECT id FROM sites WHERE customer_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))",
      [customer_id, name]
    );
    if (dup.length) {
      return res.status(409).json({
        error: `A site named "${name}" already exists for this customer. Use the existing one, or confirm to create a duplicate anyway.`,
        duplicate_site_id: dup[0].id,
      });
    }
  }

  const { rows } = await query(
    `INSERT INTO sites (customer_id, name, distance_from_plant_km, assigned_sales_representative_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [customer_id, name.trim(), distance_from_plant_km || null, spRows[0].id]
  );
  res.status(201).json(rows[0]);
});

router.post("/bookings", requireRole("sales_executive"), async (req, res) => {
  if (!(await requireOnDuty(req, res))) return;
  const { customer_id, site_id, mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, notes, site_latitude, site_longitude } = req.body;
  if (!customer_id) return res.status(400).json({ error: "Select a customer." });
  const { rows } = await query(
    `INSERT INTO bookings (customer_id, site_id, mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, notes, site_latitude, site_longitude, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [customer_id, site_id || null, mix_grade_id || null, estimated_qty_m3 || null, preferred_date || null, preferred_time || null, notes || null,
     site_latitude || null, site_longitude || null, req.user.id]
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
    pump_charge_applicable, pump_charge_amount, part_load_applicable, part_load_charge_amount,
  } = req.body;

  const finalSiteId = site_id || booking.site_id;
  const finalMixGradeId = mix_grade_id || booking.mix_grade_id;
  const finalQty = order_quantity_m3 || booking.estimated_qty_m3;

  // Fill in the site's GPS from the booking, if the site doesn't already have
  // one on file — this is what gets drivers a working "navigate to site"
  // button from the very first delivery, instead of needing someone to add
  // it separately after the fact.
  if (finalSiteId && (booking.site_latitude || booking.site_longitude)) {
    await query(
      `UPDATE sites SET latitude = COALESCE(latitude, $1), longitude = COALESCE(longitude, $2) WHERE id = $3`,
      [booking.site_latitude, booking.site_longitude, finalSiteId]
    );
  }

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

  // Same confirmation requirement as creating an order directly — not
  // automatic, and this endpoint bypasses that one entirely, so it needs its
  // own copy of the check.
  if (pump_requirement !== "without_pump" && pump_charge_applicable === undefined) {
    return res.status(400).json({ error: "Confirm whether the pump mobilization charge applies to this order." });
  }
  const { rows: rateCheck } = await query(
    `SELECT COALESCE(part_load_min_qty_m3, 5) AS part_load_min_qty_m3 FROM rate_master
     WHERE customer_id = $1 AND mix_grade_id = $2 AND (site_id = $3 OR site_id IS NULL)
       AND effective_from <= $4 AND (effective_to IS NULL OR effective_to >= $4)
     ORDER BY (site_id = $3) DESC, effective_from DESC, id DESC LIMIT 1`,
    [booking.customer_id, finalMixGradeId, finalSiteId, order_date]
  );
  const partLoadThreshold = Number(rateCheck[0]?.part_load_min_qty_m3 ?? 5);
  if (Number(finalQty) < partLoadThreshold && part_load_applicable === undefined) {
    return res.status(400).json({ error: `Confirm whether the part load charge applies — this order is below the ${partLoadThreshold} m³ minimum.` });
  }

  const { rows } = await query(
    `INSERT INTO customer_orders
     (order_date, scheduled_batching_time, truck_dispatch_interval_minutes, customer_id, site_id,
      mix_grade_id, pump_requirement, pump_id, site_technician_required, cube_samples_required,
      assigned_pump_crew, assigned_site_supervisor_id, site_contact_number, order_quantity_m3,
      sales_representative_id, casting_location, pump_departure_time, remarks, created_by,
      pump_charge_applicable, pump_charge_amount, part_load_applicable, part_load_charge_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING *`,
    [order_date, scheduled_batching_time, truck_dispatch_interval_minutes, booking.customer_id, finalSiteId,
     finalMixGradeId, pump_requirement, pump_id || null, !!site_technician_required, cube_samples_required || null,
     assigned_pump_crew || null, assigned_site_supervisor_id || null, site_contact_number, finalQty,
     finalSalesRepId, casting_location || null, pump_departure_time || null, remarks || null, req.user.id,
     pump_charge_applicable ?? null, pump_charge_applicable ? (pump_charge_amount || 0) : 0,
     part_load_applicable ?? null, part_load_applicable ? (part_load_charge_amount || 0) : 0]
  );

  await query(
    "UPDATE bookings SET status = 'converted', converted_order_id = $1 WHERE id = $2",
    [rows[0].id, req.params.id]
  );
  res.status(201).json(rows[0]);
});

// ===================== AFTER-SALES FEEDBACK =====================

router.post("/feedback", requireRole("sales_executive"), async (req, res) => {
  if (!(await requireOnDuty(req, res))) return;
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

const NEW_PROJECT_KEYS = [
  "meeting_outcome", "decide_when", "concerns", "grades", "volume",
  "project_stage", "first_pour", "competitor_involved", "quotation_status",
  "technical_visit", "owners_meeting",
];
const RUNNING_PROJECT_KEYS = [
  "supply_status", "volume_trend", "payment_status", "issues",
  "project_timeline", "competitor_activity", "relationship_health",
];

function missingAnswerKeys(isNewProject, answers) {
  const required = isNewProject ? [...NEW_PROJECT_KEYS] : [...RUNNING_PROJECT_KEYS];
  // competitor_experience is conditional — only required once a competitor's
  // actually involved, not asked at all otherwise.
  if (isNewProject && answers?.competitor_involved && answers.competitor_involved !== "No") {
    required.push("competitor_experience");
  }
  return required.filter((k) => {
    const v = answers?.[k];
    return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  });
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// The actual "don't miss the order" logic — reads the combination of
// answers, not any single one in isolation, and produces specific,
// separately-actionable follow-ups with their own due dates, some assigned
// beyond Sales Executive when the action genuinely isn't theirs to take.
function generateFollowups(isNewProject, answers, visitorType) {
  const items = [];

  if (isNewProject) {
    if (answers.meeting_outcome === "Lost to competitor") return items; // nothing to follow up

    // Base urgency: how soon they need concrete drives how soon we call.
    let dueInDays = 7;
    if (answers.first_pour === "Within 3 days") dueInDays = 1;
    else if (["Today/tomorrow", "This week"].includes(answers.decide_when)) dueInDays = 2;
    else if (answers.decide_when === "Next week") dueInDays = 5;
    else if (answers.decide_when === "This month") dueInDays = 10;
    else dueInDays = 14;

    if (answers.meeting_outcome !== "Not ready yet") {
      items.push({
        title: "Call back to check decision",
        reason: `${answers.meeting_outcome} · deciding ${answers.decide_when?.toLowerCase()}${answers.first_pour === "Within 3 days" ? " · pour expected within 3 days" : ""}`,
        due_in_days: dueInDays, role: "sales_executive",
      });
    }
    if (answers.quotation_status === "Send today") {
      items.push({ title: "Send quotation today", reason: "Marked \"send today\"", due_in_days: 0, role: "sales_executive" });
    } else if (answers.quotation_status === "Revised quote needed") {
      items.push({ title: "Prepare and send revised quote", reason: "Revised quote requested", due_in_days: 1, role: "sales_executive" });
    }
    if (answers.technical_visit === "Yes") {
      items.push({ title: "Schedule technical visit", reason: "Marked as required", due_in_days: 3, role: "sales_executive" });
    }
    if (answers.owners_meeting === "Yes") {
      items.push({ title: "Arrange owners' meeting", reason: "Requested during visit", due_in_days: 3, role: "manager" });
    }
    if (visitorType && !["customer", "client"].includes(visitorType)) {
      items.push({ title: "Reach the actual decision maker", reason: `Only spoke to a ${visitorType.replace("_", " ")}`, due_in_days: dueInDays, role: "sales_executive" });
    }
    if (answers.competitor_involved && answers.competitor_involved !== "No" && answers.competitor_experience === "Unhappy") {
      items.push({ title: `Highlight our advantages over ${answers.competitor_involved.replace("Yes — ", "")}`, reason: "They're unhappy with their current supplier", due_in_days: dueInDays, role: "sales_executive" });
    }
  } else {
    if (answers.supply_status === "Serious complaint") {
      items.push({ title: "Urgent: address complaint", reason: "Serious complaint raised", due_in_days: 1, role: "manager" });
    }
    if (answers.payment_status === "Overdue, urgent") {
      items.push({ title: "Follow up on overdue payment", reason: "Marked overdue/urgent", due_in_days: 2, role: "accountant" });
    } else if (answers.payment_status === "Needs follow-up") {
      items.push({ title: "Follow up on payment status", reason: "Needs follow-up", due_in_days: 4, role: "accountant" });
    }
    if (answers.volume_trend === "Increasing") {
      items.push({ title: "Explore upsell — volume increasing", reason: "Customer indicated increasing volume", due_in_days: 5, role: "sales_executive" });
    }
    if (answers.competitor_activity === "Competitor approached them") {
      items.push({ title: "Reinforce relationship — competitor approached them", reason: "Competitor activity reported", due_in_days: 3, role: "sales_executive" });
    }
    if (answers.relationship_health === "At risk") {
      items.push({ title: "Relationship at risk — schedule a check-in", reason: "Flagged at risk", due_in_days: 2, role: "manager" });
    }
    if (Array.isArray(answers.issues) && answers.issues.length && !answers.issues.includes("None")) {
      items.push({ title: `Address raised issue(s): ${answers.issues.join(", ")}`, reason: "Issues raised during visit", due_in_days: 2, role: "sales_executive" });
    }
  }

  return items;
}

router.post("/visits", requireRole("sales_executive"), async (req, res) => {
  if (!(await requireOnDuty(req, res))) return;
  const {
    customer_id, visited_name, site_id, visitor_type, visit_date, visit_time,
    contact_person, contact_number, at_site, latitude, longitude,
    is_new_project, answers, comments,
  } = req.body;

  if (!visited_name || !visit_date) return res.status(400).json({ error: "Customer name and date are required." });
  if (!contact_person) return res.status(400).json({ error: "Who you met is required." });
  if (!VISITOR_TYPES.includes(visitor_type)) return res.status(400).json({ error: "Select who this is." });
  if (!contact_number) return res.status(400).json({ error: "Contact number is required." });
  if (typeof at_site !== "boolean") return res.status(400).json({ error: "Let us know whether you're at site for this visit." });
  if (typeof is_new_project !== "boolean") return res.status(400).json({ error: "Confirm whether this is a new or an existing project." });

  const missing = missingAnswerKeys(is_new_project, answers || {});
  if (missing.length > 0) {
    return res.status(400).json({ error: `${missing.length} question(s) still need an answer.`, missing_keys: missing });
  }

  const { rows } = await query(
    `INSERT INTO customer_visits
       (customer_id, visited_name, site_id, visitor_type, visited_by, visit_date, visit_time,
        contact_person, contact_number, discussion_outcome, at_site, latitude, longitude,
        is_new_project, answers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [customer_id || null, visited_name, site_id || null, visitor_type, req.user.id, visit_date, visit_time || null,
     contact_person, contact_number, comments || null, at_site, at_site ? (latitude || null) : null, at_site ? (longitude || null) : null,
     is_new_project, JSON.stringify(answers || {})]
  );
  const visit = rows[0];

  if (answers?.owners_meeting === "Yes") {
    const msg = `${visited_name} asked for an owners' meeting`;
    // Not persisted for Manager — the "Arrange owners' meeting" follow-up
    // task already routes to Manager and shows on their Follow-ups Due, so
    // a separate notification row here would just show the same thing
    // twice. The immediate push still fires, for prompt awareness ahead of
    // the follow-up's own due date.
    await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ('administrator', 'owners_meeting_requested', $1)`, [msg]);
    await pushToRole("manager", { title: "Owners' meeting requested", body: msg, url: "/manager" });
    await pushToRole("administrator", { title: "Owners' meeting requested", body: msg, url: "/reports" });
  }
  if (answers?.technical_visit === "Yes") {
    const msg = `${visited_name} needs a technical visit`;
    await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ('manager', 'technical_visit_requested', $1)`, [msg]);
    await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ('administrator', 'technical_visit_requested', $1)`, [msg]);
    await pushToRole("manager", { title: "Technical visit requested", body: msg, url: "/manager" });
    await pushToRole("administrator", { title: "Technical visit requested", body: msg, url: "/reports" });
  }

  const followups = generateFollowups(is_new_project, answers || {}, visitor_type);
  const created = [];
  for (const f of followups) {
    const dueDate = daysFromNow(f.due_in_days);
    const { rows: fRows } = await query(
      `INSERT INTO visit_followups (visit_id, customer_id, title, reason, due_date, assigned_to_role, assigned_to_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [visit.id, customer_id || null, f.title, f.reason, dueDate, f.role, f.role === "sales_executive" ? req.user.id : null]
    );
    created.push(fRows[0]);
    // Anything due today or tomorrow gets pushed immediately — this is the
    // actual fix for orders getting missed on slow follow-up, not just a
    // list someone has to remember to check.
    if (f.due_in_days <= 1) {
      await pushToRole(f.role, { title: "Follow-up due " + (f.due_in_days === 0 ? "today" : "tomorrow"), body: `${visited_name} — ${f.title}`, url: f.role === "sales_executive" ? "/sales" : "/manager" });
    }
  }

  res.status(201).json({ visit, followups: created });
});

// Sales Executive sees their own visits; Manager/Administrator see everyone's
// (this is the report that shows on Admin's Sales Performance dashboard).
// Every role that can have a follow-up assigned to them (sales_executive,
// manager, accountant) sees their own — sorted so overdue is unmissable at
// the top, matching the actual daily-use pattern this exists for.
router.get("/followups", requireRole("sales_executive", "manager", "accountant", "administrator"), async (req, res) => {
  const viewingAs = ["administrator", "manager"].includes(req.user.role) && req.query.as_user;
  const role = viewingAs ? "sales_executive" : req.user.role;
  const userFilter = viewingAs ? Number(req.query.as_user) : (req.user.role === "sales_executive" ? req.user.id : null);
  const { rows } = await query(
    `SELECT vf.*, cv.visited_name, cv.site_id, s.name AS site_name
     FROM visit_followups vf
     JOIN customer_visits cv ON cv.id = vf.visit_id
     LEFT JOIN sites s ON s.id = cv.site_id
     WHERE vf.status = 'pending'
       AND vf.assigned_to_role = $1
       AND ($2::int IS NULL OR vf.assigned_to_user_id = $2)
     ORDER BY vf.due_date`,
    [role, userFilter]
  );
  res.json(rows);
});

router.post("/followups/:id/done", requireRole("sales_executive", "manager", "accountant", "administrator"), async (req, res) => {
  await query("UPDATE visit_followups SET status = 'done' WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// Admin-manageable reason lists for the two "didn't convert" outcomes —
// same pattern as rejection_reasons/lubricant_types, so "Lost to competitor"
// or "Project cancelled" can be added/retired without a code change, and
// reporting on why deals are lost stays clean (no free-text drift).
router.get("/visit-outcome-reasons", async (req, res) => {
  const outcomeType = req.query.outcome_type;
  const { rows } = await query(
    `SELECT id, outcome_type, reason FROM visit_outcome_reasons
     WHERE is_active ${outcomeType ? "AND outcome_type = $1" : ""} ORDER BY reason`,
    outcomeType ? [outcomeType] : []
  );
  res.json(rows);
});

// Marking an opportunity's outcome resolves every still-open follow-up task
// generated from that same visit at once — "did we bag it" is a question
// about the visit/opportunity as a whole, not any one reminder task. Leaving
// a follow-up's outcome unset (the default) is exactly "still active, there's
// a chance" — no action needed to represent that state, it's just what
// "pending" already means.
const OUTCOMES = ["won", "lost", "closed"];
router.post("/visits/:visitId/outcome", requireRole("sales_executive", "manager", "accountant", "administrator"), async (req, res) => {
  const { outcome, outcome_reason_id, outcome_notes } = req.body;
  if (!OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: "Outcome must be won, lost, or closed." });
  }
  if ((outcome === "lost" || outcome === "closed") && !outcome_reason_id) {
    return res.status(400).json({ error: "A reason is required when marking a visit lost or closed." });
  }
  const { rows } = await query(
    `UPDATE visit_followups
     SET status = 'done', outcome = $1, outcome_reason_id = $2, outcome_notes = $3,
         outcome_by = $4, outcome_at = now()
     WHERE visit_id = $5 AND status = 'pending'
     RETURNING id`,
    [outcome, outcome_reason_id || null, outcome_notes || null, req.user.id, req.params.visitId]
  );
  res.json({ ok: true, resolved_count: rows.length });
});

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

// A Sales Executive visiting a genuinely new prospect often only knows who
// they met — a person or a site name — not the exact legal/billing name a
// customer will eventually be invoiced under. Forcing that guess up front is
// what causes duplicate/wrong-customer messes later (the same class of
// problem already found in the site-mismatch saga). visited_name stays free
// text and customer_id stays optional at visit time (unchanged); this just
// surfaces every visit that never got linked to a real customer record, so
// Admin/Manager can reconcile it once the real billing identity is known —
// e.g. right when the visit turns into a booking/order.
router.get("/visits/unlinked-names", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT LOWER(TRIM(cv.visited_name)) AS name_key,
            (ARRAY_AGG(cv.visited_name ORDER BY cv.created_at DESC))[1] AS visited_name,
            COUNT(*) AS visit_count,
            MAX(cv.visit_date) AS last_visit_date,
            (ARRAY_AGG(cv.contact_person ORDER BY cv.created_at DESC))[1] AS last_contact_person,
            (ARRAY_AGG(cv.contact_number ORDER BY cv.created_at DESC))[1] AS last_contact_number,
            (ARRAY_AGG(u.name ORDER BY cv.created_at DESC))[1] AS last_visited_by_name
     FROM customer_visits cv
     JOIN users u ON u.id = cv.visited_by
     WHERE cv.customer_id IS NULL
     GROUP BY LOWER(TRIM(cv.visited_name))
     ORDER BY MAX(cv.visit_date) DESC`
  );
  res.json(rows);
});

// Links every still-unlinked visit under this exact (case/whitespace-
// insensitive) visited name to a real customer in one go — a visitor
// usually gets referred to the same way across visits, so reconciling once
// per name is the natural unit, not per individual visit row.
router.post("/visits/link-customer", requireRole("manager", "administrator"), async (req, res) => {
  const { visited_name, customer_id } = req.body;
  if (!visited_name || !customer_id) {
    return res.status(400).json({ error: "visited_name and customer_id are required." });
  }
  const { rows } = await query(
    `UPDATE customer_visits SET customer_id = $1
     WHERE customer_id IS NULL AND LOWER(TRIM(visited_name)) = LOWER(TRIM($2))
     RETURNING id`,
    [customer_id, visited_name]
  );
  res.json({ ok: true, linked_visit_count: rows.length });
});

// ===================== SALES EXECUTIVE'S OWN DASHBOARD =====================

router.get("/my-dashboard", requireRole("sales_executive", "administrator", "manager"), async (req, res) => {
  const spId = await mySalespersonId(targetUserId(req));
  if (!spId) {
    return res.json({ customers: [], orders_month_qty: 0, orders_month_value: 0, outstanding: 0, outstanding_by_customer: [], lead_counts: {} });
  }

  const [customers, ordersMonth, outstanding, outstandingByCustomer, leadCounts] = await Promise.all([
    query(
      `SELECT DISTINCT c.id, c.name FROM customer_orders co
       JOIN customers c ON c.id = co.customer_id
       JOIN sites s ON s.id = co.site_id
       WHERE COALESCE(s.assigned_sales_representative_id, co.sales_representative_id) = $1 ORDER BY c.name`,
      [spId]
    ),
    query(
      `SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) AS qty, COALESCE(SUM(i.total_amount), 0) AS value
       FROM customer_orders co
       JOIN sites s ON s.id = co.site_id
       JOIN delivery_tickets dt ON dt.order_id = co.id AND dt.status != 'cancelled'
       LEFT JOIN invoices i ON i.ticket_id = dt.id
       WHERE COALESCE(s.assigned_sales_representative_id, co.sales_representative_id) = $1 AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)`,
      [spId]
    ),
    query(
      `SELECT COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS total
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN sites s ON s.id = co.site_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE COALESCE(s.assigned_sales_representative_id, co.sales_representative_id) = $1`,
      [spId]
    ),
    query(
      `SELECT c.name AS customer_name,
              COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS outstanding
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = co.customer_id
       JOIN sites s ON s.id = co.site_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE COALESCE(s.assigned_sales_representative_id, co.sales_representative_id) = $1
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
       JOIN sites s ON s.id = co.site_id
       JOIN delivery_tickets dt ON dt.order_id = co.id AND dt.status != 'cancelled'
       LEFT JOIN invoices i ON i.ticket_id = dt.id
       WHERE COALESCE(s.assigned_sales_representative_id, co.sales_representative_id) = sp.id AND date_trunc('month', dt.ticket_date) = date_trunc('month', CURRENT_DATE)
     ) month_stats ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS total
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN sites s ON s.id = co.site_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE COALESCE(s.assigned_sales_representative_id, co.sales_representative_id) = sp.id
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

// ===================== SALES FORECASTING =====================
// Rolling demand estimates for ongoing projects — planning only, never
// becomes an order on its own (that's what a booking is for). Keyed on the
// SITE, not any individual order — a project's sales-executive assignment
// and forecast should persist across its whole lifetime, not reset per
// delivery. (customer_orders.sales_representative_id is a separate, still-
// valid concept — who sold that one particular order, for attribution —
// this is who owns the ongoing project relationship.)

// Sales Executive's own running projects — what the forecast form picks from.
router.get("/my-running-projects", requireRole("sales_executive"), async (req, res) => {
  const { rows: spRows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [req.user.id]);
  const salespersonId = spRows[0]?.id;
  if (!salespersonId) return res.json([]);
  const { rows } = await query(
    `SELECT s.id, c.name AS customer_name, s.name AS site_name
     FROM sites s
     JOIN customers c ON c.id = s.customer_id
     WHERE s.assigned_sales_representative_id = $1 AND s.is_active
     ORDER BY s.name`,
    [salespersonId]
  );
  res.json(rows);
});

// Upsert — one forecast per project. Saving (including editing an expired
// one) re-anchors the window to right now via updated_at.
router.post("/forecasts", requireRole("sales_executive"), async (req, res) => {
  if (!(await requireOnDuty(req, res))) return;
  const { site_id, expected_qty_m3, period_days, confidence, notes } = req.body;
  if (!site_id || !expected_qty_m3 || !period_days || !confidence) {
    return res.status(400).json({ error: "Project, expected quantity, period, and confidence are all required." });
  }
  const { rows: spRows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [req.user.id]);
  const salespersonId = spRows[0]?.id;
  if (!salespersonId) return res.status(400).json({ error: "No salesperson profile linked to your account." });

  const { rows } = await query(
    `INSERT INTO sales_forecasts (site_id, sales_representative_id, expected_qty_m3, period_days, confidence, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (site_id) DO UPDATE SET
       expected_qty_m3 = $3, period_days = $4, confidence = $5, notes = $6, updated_at = now()
     RETURNING *`,
    [site_id, salespersonId, expected_qty_m3, period_days, confidence, notes || null]
  );
  await query(
    `UPDATE notifications SET is_read = true
     WHERE recipient_id = $1 AND site_id = $2 AND type = 'forecast_update_requested' AND is_read = false`,
    [req.user.id, site_id]
  );
  res.status(201).json(rows[0]);
});

// Sales Executive sees their own; Manager/Administrator see everyone's.
router.get("/forecasts", requireRole("sales_executive", "manager", "administrator"), async (req, res) => {
  const own = req.user.role === "sales_executive";
  let salespersonId = null;
  if (own) {
    const { rows: spRows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [req.user.id]);
    salespersonId = spRows[0]?.id;
    if (!salespersonId) return res.json([]);
  }
  const { rows } = await query(
    `SELECT f.*, c.name AS customer_name, s.name AS site_name, sp.name AS salesperson_name,
            (f.updated_at::date + f.period_days) AS period_end_date,
            (f.updated_at::date + f.period_days) < CURRENT_DATE AS is_expired
     FROM sales_forecasts f
     JOIN sites s ON s.id = f.site_id
     JOIN customers c ON c.id = s.customer_id
     JOIN salespersons sp ON sp.id = f.sales_representative_id
     ${own ? "WHERE f.sales_representative_id = $1" : ""}
     ORDER BY f.updated_at DESC`,
    own ? [salespersonId] : []
  );
  res.json(rows);
});

router.delete("/forecasts/:id", requireRole("sales_executive"), async (req, res) => {
  const { rows: spRows } = await query("SELECT id FROM salespersons WHERE user_id = $1", [req.user.id]);
  const salespersonId = spRows[0]?.id;
  const { rowCount } = await query(
    "DELETE FROM sales_forecasts WHERE id = $1 AND sales_representative_id = $2",
    [req.params.id, salespersonId]
  );
  if (!rowCount) return res.status(404).json({ error: "Forecast not found." });
  res.json({ ok: true });
});

// Assign a salesperson to the project/site — the actual fix for a project
// not showing up anywhere in Sales Forecast, since everything here is keyed
// off this assignment. Persists for the site's whole lifetime.
router.post("/sites/:siteId/assign-salesperson", requireRole("manager", "administrator"), async (req, res) => {
  const { salesperson_id } = req.body;
  if (!salesperson_id) return res.status(400).json({ error: "Select a salesperson." });
  const { rows } = await query(
    "UPDATE sites SET assigned_sales_representative_id = $1 WHERE id = $2 RETURNING *",
    [salesperson_id, req.params.siteId]
  );
  if (!rows.length) return res.status(404).json({ error: "Site not found." });
  res.json(rows[0]);
});

// Every active site/project, with its forecast status if any — lets
// Manager/Administrator see gaps (no sales person, no forecast, or an
// expired one) and request an update, not just review what's current.
router.get("/running-projects-with-forecast-status", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT s.id AS site_id, c.name AS customer_name, s.name AS site_name,
            sp.name AS salesperson_name, sp.user_id AS salesperson_user_id,
            f.expected_qty_m3, f.period_days, f.confidence, f.updated_at AS forecast_updated_at,
            (f.id IS NOT NULL) AS has_forecast,
            (f.id IS NOT NULL AND (f.updated_at::date + f.period_days) < CURRENT_DATE) AS is_expired
     FROM sites s
     JOIN customers c ON c.id = s.customer_id
     LEFT JOIN salespersons sp ON sp.id = s.assigned_sales_representative_id
     LEFT JOIN sales_forecasts f ON f.site_id = s.id
     WHERE s.is_active
     ORDER BY has_forecast ASC, s.name`
  );
  res.json(rows);
});

// Manager/Administrator asks the assigned Sales Executive to add or refresh
// a forecast for a specific project — a direct nudge rather than waiting.
router.post("/forecasts/request-update", requireRole("manager", "administrator"), async (req, res) => {
  const { site_id, message } = req.body;
  if (!site_id) return res.status(400).json({ error: "Select a project." });

  const { rows } = await query(
    `SELECT s.id, sp.user_id AS salesperson_user_id, c.name AS customer_name, s.name AS site_name
     FROM sites s
     JOIN customers c ON c.id = s.customer_id
     LEFT JOIN salespersons sp ON sp.id = s.assigned_sales_representative_id
     WHERE s.id = $1`,
    [site_id]
  );
  const site = rows[0];
  if (!site) return res.status(404).json({ error: "Project not found." });
  if (!site.salesperson_user_id) return res.status(400).json({ error: "This project has no sales person assigned." });

  const label = `${site.customer_name} — ${site.site_name}`;
  const text = message
    ? `Manager asked for a forecast update on ${label}: "${message}"`
    : `Manager asked for a forecast update on ${label}.`;
  await query(
    `INSERT INTO notifications (recipient_role, recipient_id, site_id, type, message) VALUES ('sales_executive', $1, $2, 'forecast_update_requested', $3)`,
    [site.salesperson_user_id, site_id, text]
  );
  await pushToUser(site.salesperson_user_id, { title: "Forecast update requested", body: label, url: "/sales-forecast" });

  res.json({ ok: true });
});

// Sales Executive's own pending forecast-update requests — surfaced as an
// alert at the top of their forecast screen.
router.get("/forecast-update-requests", requireRole("sales_executive"), async (req, res) => {
  const { rows } = await query(
    `SELECT id, site_id, message, created_at FROM notifications
     WHERE recipient_id = $1 AND type = 'forecast_update_requested' AND is_read = false
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// Weekly aggregate for the Manager/Administrator chart — expected demand
// this week and next, broken down by confidence level.
router.get("/forecasts/summary", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT confidence,
            COALESCE(SUM(
              expected_qty_m3 / NULLIF(period_days, 0) *
              GREATEST(0, LEAST(updated_at::date + period_days, CURRENT_DATE + 7) - GREATEST(updated_at::date, CURRENT_DATE))
            ), 0) AS this_week,
            COALESCE(SUM(
              expected_qty_m3 / NULLIF(period_days, 0) *
              GREATEST(0, LEAST(updated_at::date + period_days, CURRENT_DATE + 14) - GREATEST(updated_at::date, CURRENT_DATE + 7))
            ), 0) AS next_week
     FROM sales_forecasts
     WHERE (updated_at::date + period_days) >= CURRENT_DATE
     GROUP BY confidence`
  );
  res.json(rows);
});

// ===================== DUTY LOGIN & LOCATION TRACKING =====================
// Parallel to the Driver duty/GPS system — a Sales Executive's day out in the
// field, tracked the same way (toggle on/off, periodic pings while on).

router.get("/duty-status", requireRole("sales_executive", "administrator", "manager"), async (req, res) => {
  const uid = targetUserId(req);
  const { rows } = await query(
    "SELECT is_on, event_time FROM sales_duty_log WHERE salesperson_user_id = $1 ORDER BY event_time DESC LIMIT 1",
    [uid]
  );
  const { rows: today } = await query(
    `SELECT is_on, event_time FROM sales_duty_log
     WHERE salesperson_user_id = $1 AND event_time::date = CURRENT_DATE
     ORDER BY event_time`,
    [uid]
  );
  res.json({
    on_duty: rows[0]?.is_on || false,
    since: rows[0]?.event_time || null,
    today,
  });
});

router.post("/duty", requireRole("sales_executive"), async (req, res) => {
  const { on, lat, lng } = req.body;
  await query(
    "INSERT INTO sales_duty_log (salesperson_user_id, is_on, latitude, longitude) VALUES ($1, $2, $3, $4)",
    [req.user.id, !!on, lat || null, lng || null]
  );
  res.json({ ok: true });
});

router.post("/gps-ping", requireRole("sales_executive"), async (req, res) => {
  const { latitude, longitude, accuracy_m } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: "Latitude and longitude are required." });
  }
  await query(
    "INSERT INTO sales_gps_pings (salesperson_user_id, latitude, longitude, accuracy_m) VALUES ($1, $2, $3, $4)",
    [req.user.id, latitude, longitude, accuracy_m || null]
  );
  res.json({ ok: true });
});

// Manager/Administrator view of who's currently out in the field — same
// >12-hour staleness rule as On-Duty Drivers, so a phone that died or an app
// that got killed without properly clocking off doesn't show as perpetually
// "on duty."
router.get("/on-duty", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (d.salesperson_user_id)
            d.salesperson_user_id, u.name AS salesperson_name, d.event_time AS duty_since,
            gp.latitude, gp.longitude, gp.recorded_at
     FROM (
       SELECT DISTINCT ON (salesperson_user_id) salesperson_user_id, is_on, event_time
       FROM sales_duty_log ORDER BY salesperson_user_id, event_time DESC
     ) d
     JOIN users u ON u.id = d.salesperson_user_id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, recorded_at FROM sales_gps_pings
       WHERE salesperson_user_id = d.salesperson_user_id ORDER BY recorded_at DESC LIMIT 1
     ) gp ON true
     WHERE d.is_on = true
       AND gp.recorded_at IS NOT NULL AND gp.recorded_at > now() - INTERVAL '12 hours'
     ORDER BY d.salesperson_user_id, d.event_time DESC`
  );
  res.json(rows);
});

export default router;
