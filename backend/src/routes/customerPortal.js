import { Router } from "express";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { query } from "../db.js";
import { getOrderTrackingPayload } from "../lib/orderTracking.js";
import { pushToRole } from "../lib/push.js";

// ===================== CUSTOMER PORTAL (round 119) =====================
// Public, no-login-by-password page — a customer signs in with a short
// access code Manager/Admin issued them (see routes/customerAccess.js) and
// sees their own orders + QC reports (mix design / cube test PDFs) for
// whichever site(s) that code was scoped to. Deliberately NOT mounted
// behind requireAuth/requireRole (those are for staff accounts, a
// completely different trust boundary) — every route here does its own
// customer-scoped auth via requireCustomerAuth below.
//
// Security note: customer sessions are signed with their OWN secret
// (CUSTOMER_JWT_SECRET, falling back to JWT_SECRET if that env var isn't
// set yet — see render.yaml) specifically so a customer session token can
// never be replayed against any staff-only endpoint (different secret =
// verify() throws immediately), and vice versa a stolen staff token can't
// be used here either. requireCustomerAuth also re-checks the underlying
// customer_access_tokens row on EVERY request (not just at login) so a
// Manager revoking a code takes effect immediately, even for a session
// token that hasn't expired yet — same "live check, don't just trust a
// long-lived JWT" reasoning as the staff side's requireAuth would want if
// user.is_active were ever flipped off mid-session.
const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please wait a while before trying again." },
});

function customerSecret() {
  return process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET;
}

router.post("/login", loginLimiter, async (req, res) => {
  const raw = (req.body.token || "").trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: "Enter your access code." });

  const { rows } = await query(
    `SELECT cat.id, cat.customer_id, c.name AS customer_name
     FROM customer_access_tokens cat JOIN customers c ON c.id = cat.customer_id
     WHERE cat.token = $1 AND cat.is_active`,
    [raw]
  );
  if (!rows.length) {
    return res.status(401).json({ error: "That access code isn't valid. Check it and try again, or contact us for a new one." });
  }
  const row = rows[0];
  await query("UPDATE customer_access_tokens SET last_used_at = now() WHERE id = $1", [row.id]);

  const session_token = jwt.sign(
    { type: "customer", token_id: row.id, customer_id: row.customer_id },
    customerSecret(),
    { expiresIn: "180d" } // long-lived on purpose — "save it for auto login next time"
  );
  res.json({ session_token, customer_name: row.customer_name });
});

// Round 119, post-ship (per the business's own mockup) — effective
// tracking/QC-reports/technical-writings access is now resolved per
// customer+SITE from customer_booking_links (see schema.sql's comment
// above that table), not per access code. A code can cover several sites
// with different access; this returns { [site_id]: {tracking, qc_reports,
// technical_writings} }, defaulting all three false for any covered site
// with no active booking-link row (matching tracking_enabled's own
// existing default-false convention — Manager needs to generate a link for
// a site before a portal code covering it shows anything for that site).
async function loadSitePermissions(customerId, siteIds) {
  if (!siteIds.length) return { bySite: {}, sites: [] };
  const { rows } = await query(
    `SELECT s.id AS site_id, s.name,
            COALESCE(cbl.tracking_enabled, false) AS allow_tracking,
            COALESCE(cbl.allow_qc_reports, false) AS allow_qc_reports,
            COALESCE(cbl.allow_technical_writings, false) AS allow_technical_writings
     FROM sites s
     LEFT JOIN customer_booking_links cbl
       ON cbl.customer_id = $1 AND cbl.site_id = s.id AND cbl.is_active
     WHERE s.id = ANY($2::int[])
     ORDER BY s.name`,
    [customerId, siteIds]
  );
  const bySite = {};
  for (const r of rows) {
    bySite[r.site_id] = {
      tracking: r.allow_tracking,
      qc_reports: r.allow_qc_reports,
      technical_writings: r.allow_technical_writings,
    };
  }
  return { bySite, sites: rows };
}

async function requireCustomerAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in with your access code to continue." });
  }
  let payload;
  try {
    payload = jwt.verify(header.slice(7), customerSecret());
  } catch {
    return res.status(401).json({ error: "Your session expired. Sign in again with your access code." });
  }
  if (payload.type !== "customer") {
    return res.status(401).json({ error: "Sign in with your access code to continue." });
  }

  const { rows } = await query(
    `SELECT cat.customer_id, c.name AS customer_name
     FROM customer_access_tokens cat
     JOIN customers c ON c.id = cat.customer_id
     WHERE cat.id = $1 AND cat.is_active`,
    [payload.token_id]
  );
  if (!rows.length) {
    return res.status(401).json({ error: "This access code has been revoked. Please contact us for a new one." });
  }
  const { rows: siteRows } = await query(
    "SELECT site_id FROM customer_access_token_sites WHERE token_id = $1",
    [payload.token_id]
  );
  req.customerId = rows[0].customer_id;
  req.customerName = rows[0].customer_name;
  req.siteIds = siteRows.map((r) => r.site_id);
  // Re-read live on every request, same reasoning as the is_active check
  // above: Manager flipping a switch on Booking Links should take effect on
  // the customer's very next request, not wait for their 180-day session.
  const { bySite, sites } = await loadSitePermissions(req.customerId, req.siteIds);
  req.sitePermissions = bySite;
  req.sites = sites;
  next();
}

function siteAllows(req, siteId, key) {
  return !!(req.sitePermissions[siteId] && req.sitePermissions[siteId][key]);
}

router.get("/me", requireCustomerAuth, async (req, res) => {
  res.json({
    customer_name: req.customerName,
    sites: req.sites.map((s) => ({
      id: s.site_id, name: s.name,
      allow_tracking: s.allow_tracking, allow_qc_reports: s.allow_qc_reports, allow_technical_writings: s.allow_technical_writings,
    })),
    // "Any covered site allows this" — used to decide whether a Home-screen
    // tile shows at all. Order-specific screens check the order's own site
    // via siteAllows() instead, since one code's sites can differ.
    permissions: {
      tracking: req.sites.some((s) => s.allow_tracking),
      qc_reports: req.sites.some((s) => s.allow_qc_reports),
      technical_writings: req.sites.some((s) => s.allow_technical_writings),
    },
  });
});

// Round 119, post-ship — the "Technical Writings" library (see
// routes/technicalWritings.js for the Manager/Admin management side). This
// library isn't per-site itself (one shared list of guides), so visibility
// is "any of this code's covered sites allows it" — same as the Home tile
// above. List never returns file_data; the actual bytes only travel on the
// specific /file request below, and both are gated the same way.
router.get("/technical-writings", requireCustomerAuth, async (req, res) => {
  if (!req.sites.some((s) => s.allow_technical_writings)) {
    return res.status(403).json({ error: "Technical writings aren't enabled for your sites." });
  }
  const { rows } = await query(
    `SELECT id, title, category, filename, size_bytes, created_at
     FROM technical_documents ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Returns the file as base64 JSON (not a binary stream) so the frontend can
// reuse the same all-JSON customerPortalRequest() helper it already has,
// same reasoning as the base64-upload choice on the staff side.
router.get("/technical-writings/:id/file", requireCustomerAuth, async (req, res) => {
  if (!req.sites.some((s) => s.allow_technical_writings)) {
    return res.status(403).json({ error: "Technical writings aren't enabled for your sites." });
  }
  const { rows } = await query(
    "SELECT title, filename, mime_type, file_data FROM technical_documents WHERE id = $1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Document not found." });
  const doc = rows[0];
  res.json({
    title: doc.title,
    filename: doc.filename,
    mime_type: doc.mime_type,
    data_base64: doc.file_data.toString("base64"),
  });
});

// Ownership-checked lookup used by the routes below — an order only counts
// as "this customer's" if it's both their customer_id AND one of the sites
// their access code actually covers, so a guessed order id from a
// different site (even the same customer's own other site, if their code
// wasn't scoped to it) can't leak data. Site-level permission (tracking/QC)
// is checked separately by the caller via siteAllows(), after this.
async function ownOrder(req, orderId) {
  const { rows } = await query(
    "SELECT id, customer_id, site_id, resolved_mix_design_id FROM customer_orders WHERE id = $1",
    [orderId]
  );
  const order = rows[0];
  if (!order || order.customer_id !== req.customerId || !req.siteIds.includes(order.site_id)) return null;
  return order;
}

// Round 119, post-ship — live per-truck delivery progress for one of this
// customer's own orders, reusing the exact same helper the /track/:token
// link and the customer-booking status view already use
// (lib/orderTracking.js) rather than a third implementation of the same
// query. Gated on the order's own site's tracking switch.
router.get("/orders/:id/tracking", requireCustomerAuth, async (req, res) => {
  const order = await ownOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (!siteAllows(req, order.site_id, "tracking")) {
    return res.status(403).json({ error: "Delivery tracking isn't enabled for this site." });
  }
  const payload = await getOrderTrackingPayload(order.id);
  if (!payload) return res.status(404).json({ error: "No live tracking available for this order right now." });
  res.json(payload);
});

// Round 119, post-ship — turns a raw order/booking row into what the mockup
// shows: a single friendly status label + color, plus which of the three
// "My Orders" groups (In progress / Needs your attention / Earlier) it
// belongs in. Centralized here (not duplicated in the frontend) so the
// list and the order-detail screen never disagree on what a status means.
function summarizeStatus(row) {
  if (row.kind === "booking") {
    if (row.raw_status === "pending") return { label: "Under Review", tone: "warning", group: "attention" };
    return { label: "Declined", tone: "danger", group: "earlier" }; // only other booking_status left unconverted
  }
  switch (row.raw_status) {
    case "planned":
      return row.rescheduled_at
        ? { label: "Rescheduled", tone: "warning", group: "attention" }
        : { label: "Accepted & Scheduled", tone: "info", group: "active" };
    case "in_progress":
      return { label: "In Progress", tone: "progress", group: "active" };
    case "partially_completed":
      return { label: "Partially Delivered", tone: "warning", group: "active" };
    case "completed":
      return { label: "Completed", tone: "success", group: "earlier" };
    case "closed":
      return { label: "Closed", tone: "neutral", group: "earlier" };
    case "cancelled":
      return { label: "Cancelled", tone: "danger", group: "earlier" };
    default:
      return { label: row.raw_status, tone: "neutral", group: "earlier" };
  }
}

// Round 119, post-ship (per the business's own mockup) — "My Orders" is now
// ONE list mixing a customer's own pending/declined "Order Concrete"
// requests (bookings not yet converted — see POST /orders below) together
// with their real, accepted orders, exactly like the mockup's OORM-2371
// "Under Review" card sitting in the same list as OORM-2381 "In Progress".
// A booking drops out of this list the moment Manager converts it — from
// then on the resulting customer_orders row is what shows, so nothing is
// ever listed twice. Sales-entered and booking-link-submitted requests are
// included too (not just portal self-service ones) — they're still this
// customer's own request either way.
router.get("/orders", requireCustomerAuth, async (req, res) => {
  if (!req.siteIds.length) return res.json([]);
  const { rows } = await query(
    `WITH order_rows AS (
       SELECT 'order'::text AS kind, co.id, co.order_date, co.scheduled_batching_time,
              co.status::text AS raw_status, co.order_quantity_m3 AS qty_m3, co.site_id,
              s.name AS site_name, m.name AS mix_grade_name, co.rescheduled_at, co.created_at,
              NULL::text AS declined_reason,
              COALESCE((
                SELECT SUM(dt.loaded_quantity_m3) FROM delivery_tickets dt
                WHERE dt.order_id = co.id AND dt.status = 'completed'
              ), 0) AS delivered_qty_m3
       FROM customer_orders co
       JOIN sites s ON s.id = co.site_id
       JOIN mix_grades m ON m.id = co.mix_grade_id
       WHERE co.customer_id = $1 AND co.site_id = ANY($2::int[])
     ), booking_rows AS (
       SELECT 'booking'::text AS kind, b.id, b.preferred_date AS order_date, b.preferred_time AS scheduled_batching_time,
              b.status::text AS raw_status, b.estimated_qty_m3 AS qty_m3, b.site_id,
              s.name AS site_name, m.name AS mix_grade_name, NULL::timestamptz AS rescheduled_at, b.created_at,
              b.declined_reason, 0::numeric AS delivered_qty_m3
       FROM bookings b
       LEFT JOIN sites s ON s.id = b.site_id
       LEFT JOIN mix_grades m ON m.id = b.mix_grade_id
       WHERE b.customer_id = $1 AND b.converted_order_id IS NULL
         AND (b.site_id IS NULL OR b.site_id = ANY($2::int[]))
     )
     SELECT * FROM order_rows
     UNION ALL
     SELECT * FROM booking_rows
     ORDER BY order_date DESC NULLS LAST, created_at DESC`,
    [req.customerId, req.siteIds]
  );
  const withStatus = rows.map((r) => ({ ...r, ...summarizeStatus(r) }));
  res.json(withStatus);
});

// Round 119, post-ship — one order's full detail: the mockup's 4-stage
// status stepper, the "Rescheduled" history banner (if any), and "Your team
// on this order" (see resolveOrderContacts below). Doesn't reuse ownOrder's
// narrow SELECT since the stepper/contacts/banner all need more columns
// than the tracking/QC routes ever did.
router.get("/orders/:id", requireCustomerAuth, async (req, res) => {
  const owned = await ownOrder(req, req.params.id);
  if (!owned) return res.status(404).json({ error: "Order not found." });

  const { rows } = await query(
    `SELECT co.*, s.name AS site_name, s.address AS site_address, m.name AS mix_grade_name
     FROM customer_orders co
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     WHERE co.id = $1`,
    [owned.id]
  );
  const order = rows[0];

  // The booking this order was converted from, if it came in that way at
  // all (a Manager can also create an order directly, with no booking
  // behind it) — its created_at is the stepper's "Under Review" timestamp.
  // Falls back to the order's own created_at so the stepper always has
  // something to show for that first step.
  const { rows: bookingRows } = await query(
    "SELECT created_at FROM bookings WHERE converted_order_id = $1 ORDER BY created_at ASC LIMIT 1",
    [order.id]
  );
  const reviewedAt = bookingRows[0]?.created_at || order.created_at;

  const { rows: dq } = await query(
    "SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS delivered FROM delivery_tickets WHERE order_id = $1 AND status = 'completed'",
    [order.id]
  );

  const contacts = await resolveOrderContacts(order);
  const status = summarizeStatus({ kind: "order", raw_status: order.status, rescheduled_at: order.rescheduled_at });

  res.json({
    id: order.id,
    order_date: order.order_date,
    scheduled_batching_time: order.scheduled_batching_time,
    status: order.status,
    display_status: status.label,
    status_tone: status.tone,
    site_name: order.site_name,
    site_address: order.site_address,
    mix_grade_name: order.mix_grade_name,
    order_quantity_m3: order.order_quantity_m3,
    delivered_qty_m3: dq[0].delivered,
    casting_location: order.casting_location,
    reviewed_at: reviewedAt,
    scheduled_at: order.created_at,
    is_rescheduled: !!order.rescheduled_at,
    original_order_date: order.original_order_date,
    original_scheduled_batching_time: order.original_scheduled_batching_time,
    reschedule_reason: order.reschedule_reason,
    rescheduled_at: order.rescheduled_at,
    terminal_at: order.terminal_at,
    tracking_allowed: siteAllows(req, order.site_id, "tracking"),
    qc_allowed: siteAllows(req, order.site_id, "qc_reports"),
    resolved_mix_design_id: order.resolved_mix_design_id,
    contacts,
  });
});

// Round 119, post-ship — a lightweight detail view for a request that
// hasn't (or never will) become a real order yet — "Under Review" or
// "Declined" cards in My Orders link here instead of to the full order
// detail (which needs a real customer_orders row to exist).
router.get("/booking-requests/:id", requireCustomerAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.customer_id, b.status, b.preferred_date, b.preferred_time, b.estimated_qty_m3, b.pump_requirement,
            b.casting_location, b.notes, b.declined_reason, b.created_at, b.site_id,
            s.name AS site_name, m.name AS mix_grade_name
     FROM bookings b
     LEFT JOIN sites s ON s.id = b.site_id
     LEFT JOIN mix_grades m ON m.id = b.mix_grade_id
     WHERE b.id = $1`,
    [req.params.id]
  );
  const b = rows[0];
  if (!b || b.customer_id !== req.customerId) {
    return res.status(404).json({ error: "Request not found." });
  }
  delete b.customer_id; // internal-only, not part of the customer-facing shape
  res.json(b);
});

// Round 119, post-ship — the mockup's "Order Concrete" self-service form
// (renamed from the mockup's own "Request Concrete" per explicit business
// instruction). Creates a bookings row exactly like the public
// /book/:token link does (see routes/customerBooking.js's POST /:token —
// same required fields, same validation), but from this authenticated
// /portal session instead of a link token, so requested_by AND
// booking_link_id both stay NULL — submitted_via_portal is what tells this
// apart from a hypothetical link-less, submitter-less row (see schema.sql's
// comment on that column). Goes to the same Manager/Admin "Pending
// bookings" queue as every other booking source.
router.post("/orders", requireCustomerAuth, async (req, res) => {
  const { site_id, mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, pump_requirement, casting_location, notes } = req.body;

  if (!site_id || !req.siteIds.includes(Number(site_id))) {
    return res.status(400).json({ error: "Select one of your sites." });
  }
  const required = { mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, pump_requirement };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === "") {
      return res.status(400).json({ error: `${key.replaceAll("_", " ")} is required.` });
    }
  }
  if (!["boom_pump", "line_pump", "without_pump"].includes(pump_requirement)) {
    return res.status(400).json({ error: "Invalid pump requirement." });
  }

  const { rows } = await query(
    `INSERT INTO bookings
     (customer_id, site_id, mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, notes,
      pump_requirement, casting_location, requested_by, booking_link_id, submitted_via_portal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,true)
     RETURNING id`,
    [req.customerId, site_id, mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, notes || null,
     pump_requirement, casting_location || null]
  );

  for (const role of ["manager", "administrator"]) {
    await query(
      `INSERT INTO notifications (recipient_role, type, message)
       VALUES ($1, 'customer_booking_submitted', $2)`,
      [role, `New "Order Concrete" request from ${req.customerName}`]
    );
    await pushToRole(role, {
      title: "New customer order request",
      body: `${req.customerName} — via customer portal`,
      url: "/customer-booking",
    });
  }

  res.status(201).json({ ok: true, id: rows[0].id });
});

// Round 119, post-ship — "Your team on this order" (see CustOrderDetail in
// the business's mockup). There's no per-order "Plant Manager" assignment
// anywhere in this schema, and there's genuinely only ever one Manager on
// staff at a time in practice, so that one is resolved by ROLE — whichever
// active user currently holds the manager role is shown, same person on
// every order. Site Supervisor is genuinely per-order
// (assigned_site_supervisor_id) and visually highlighted for it.
//
// Round 119, post-ship again — QC Engineer used to be resolved by role too
// (the same "whichever qc_engineer is active" pick as Manager above), but
// business feedback was that this doesn't hold up once there's more than
// one QC Engineer on staff — the card always showed the same person
// regardless of who actually handled the order. customer_orders.
// assigned_qc_engineer_id (settable per order from Administrator/Manager's
// Correct Order screen) now overrides the role-based pick when set, and is
// highlighted the same way Site Supervisor is, since it means someone
// specifically chose this QC Engineer for this order rather than the app
// guessing. Falls back to the old role-based pick for any order where it's
// never been set, so this isn't a breaking change for existing orders.
async function resolveOrderContacts(order) {
  const contacts = [];

  if (order.sales_representative_id) {
    const { rows } = await query(
      "SELECT u.name, u.phone FROM salespersons sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1",
      [order.sales_representative_id]
    );
    if (rows.length) contacts.push({ role: "Sales Executive", name: rows[0].name, phone: rows[0].phone, highlight: false });
  }
  if (!contacts.length && order.created_by) {
    const { rows } = await query("SELECT name, phone, role FROM users WHERE id = $1", [order.created_by]);
    if (rows.length && rows[0].role === "sales_executive") {
      contacts.push({ role: "Sales Executive", name: rows[0].name, phone: rows[0].phone, highlight: false });
    }
  }

  const { rows: mgr } = await query("SELECT name, phone FROM users WHERE role = 'manager' AND is_active ORDER BY id LIMIT 1");
  if (mgr.length) contacts.push({ role: "Plant Manager", name: mgr[0].name, phone: mgr[0].phone, highlight: false });

  if (order.assigned_qc_engineer_id) {
    const { rows } = await query("SELECT name, phone FROM users WHERE id = $1", [order.assigned_qc_engineer_id]);
    if (rows.length) contacts.push({ role: "QC Engineer · assigned", name: rows[0].name, phone: rows[0].phone, highlight: true });
  } else {
    const { rows: qc } = await query("SELECT name, phone FROM users WHERE role = 'qc_engineer' AND is_active ORDER BY id LIMIT 1");
    if (qc.length) contacts.push({ role: "QC Engineer", name: qc[0].name, phone: qc[0].phone, highlight: false });
  }

  if (order.assigned_site_supervisor_id) {
    const { rows } = await query("SELECT name, phone FROM users WHERE id = $1", [order.assigned_site_supervisor_id]);
    if (rows.length) contacts.push({ role: "Site Supervisor · assigned", name: rows[0].name, phone: rows[0].phone, highlight: true });
  }

  return contacts;
}

// Round 119, post-ship — the grade dropdown on the "Order Concrete" form.
router.get("/mix-grades", requireCustomerAuth, async (req, res) => {
  const { rows } = await query("SELECT id, name FROM mix_grades ORDER BY name");
  res.json(rows);
});

// Round 119, post-ship again, item 6 — the portal's own "Feedback" screen:
// a customer can log their own after-sales feedback (star rating + comment,
// optionally tied to one of their own orders) instead of it only ever being
// recorded by a Sales Executive after a visit. feedback_type is derived from
// the rating here (4-5 stars = compliment, 1-3 = complaint) since every
// reader of aftersales_feedback (FeedbackTab in CustomerBooking.jsx,
// sales.js's GET /feedback) still keys off that column either way — see
// schema.sql's comment above aftersales_feedback for the full reasoning.
router.post("/feedback", requireCustomerAuth, async (req, res) => {
  const { order_id, rating, comment } = req.body;
  const ratingNum = Number(rating);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: "Select a star rating from 1 to 5." });
  }
  if (!comment || !comment.trim()) {
    return res.status(400).json({ error: "Please add a short comment." });
  }
  let orderId = null;
  if (order_id) {
    const owned = await ownOrder(req, order_id);
    if (!owned) return res.status(400).json({ error: "That order wasn't found on your account." });
    orderId = owned.id;
  }
  const feedbackType = ratingNum >= 4 ? "compliment" : "complaint";
  const { rows } = await query(
    `INSERT INTO aftersales_feedback (customer_id, order_id, feedback_type, comment, rating, submitted_by_customer)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [req.customerId, orderId, feedbackType, comment.trim(), ratingNum]
  );
  if (feedbackType === "complaint") {
    await pushToRole("manager", { title: "Customer feedback logged (low rating)", body: comment.trim().slice(0, 80), url: "/customer-booking" });
  }
  res.status(201).json({ ok: true, id: rows[0].id });
});

// Round 119, post-ship — the "More" tab's "QC & Mix Designs" screen (see
// the mockup's QCReports screen): a cross-order Test Results / Approved Mix
// Designs view, rather than having to open each order individually.
// site_id is scoped to whichever of the customer's sites currently have QC
// reports switched on — same siteAllows() boundary every other QC route
// uses, just applied across all of them at once instead of one order.
// design_ref_code is deduped in JS (same design gets reused across many
// orders); the PDF itself is still fetched per-order (GET
// /orders/:id/mix-design-pdf-data below), since that's the only mix-design
// PDF endpoint that exists — this just picks the most recent qualifying
// order for whichever design shows here.
router.get("/qc-reports", requireCustomerAuth, async (req, res) => {
  const qcSiteIds = req.sites.filter((s) => s.allow_qc_reports).map((s) => s.site_id);
  if (!qcSiteIds.length) return res.json({ cube_tests: [], mix_designs: [] });

  const { rows: cubeTests } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_strength_mpa, ctr.tested_at,
            co.id AS order_id, s.name AS site_name, m.name AS mix_grade_name
     FROM cube_test_results ctr
     JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     WHERE co.customer_id = $1 AND co.site_id = ANY($2::int[])
     ORDER BY ctr.tested_at DESC NULLS LAST
     LIMIT 50`,
    [req.customerId, qcSiteIds]
  );

  const { rows: mixDesignRows } = await query(
    `SELECT co.id AS order_id, co.order_date, md.design_ref_code, m.name AS mix_grade_name, s.name AS site_name
     FROM customer_orders co
     JOIN mix_designs md ON md.id = co.resolved_mix_design_id AND md.status = 'approved'
     JOIN mix_grades m ON m.id = co.mix_grade_id
     JOIN sites s ON s.id = co.site_id
     WHERE co.customer_id = $1 AND co.site_id = ANY($2::int[])
     ORDER BY co.order_date DESC`,
    [req.customerId, qcSiteIds]
  );
  const seenDesigns = new Set();
  const mixDesigns = mixDesignRows.filter((r) => {
    if (seenDesigns.has(r.design_ref_code)) return false;
    seenDesigns.add(r.design_ref_code);
    return true;
  });

  res.json({ cube_tests: cubeTests, mix_designs: mixDesigns });
});

router.get("/orders/:id/mix-design-pdf-data", requireCustomerAuth, async (req, res) => {
  const order = await ownOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (!siteAllows(req, order.site_id, "qc_reports")) {
    return res.status(403).json({ error: "QC reports aren't enabled for this site." });
  }
  if (!order.resolved_mix_design_id) {
    return res.status(404).json({ error: "No mix design is linked to this order yet." });
  }
  const { rows } = await query(
    `SELECT md.*, m.name AS mix_grade_name, cu.name AS created_by_name
     FROM mix_designs md
     JOIN mix_grades m ON m.id = md.mix_grade_id
     JOIN users cu ON cu.id = md.created_by
     WHERE md.id = $1 AND md.status = 'approved'`,
    [order.resolved_mix_design_id]
  );
  if (!rows.length) return res.status(404).json({ error: "This mix design hasn't been approved yet." });
  const { rows: admixtures } = await query(
    `SELECT type_brand, dosage_pct_of_binder, qty_kgm3, sp_gr FROM mix_design_admixtures
     WHERE mix_design_id = $1 ORDER BY sort_order`,
    [order.resolved_mix_design_id]
  );
  // Same real PDF data a staff member would see — no redaction. The
  // generator already shows a fixed "Quality Control Engineer" role label
  // for Approved by regardless of who clicked approve (see mixDesignPdf.js).
  res.json({ ...rows[0], admixtures });
});

router.get("/orders/:id/cube-tests", requireCustomerAuth, async (req, res) => {
  const order = await ownOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (!siteAllows(req, order.site_id, "qc_reports")) {
    return res.status(403).json({ error: "QC reports aren't enabled for this site." });
  }
  const { rows } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_strength_mpa, ctr.tested_at
     FROM cube_test_results ctr
     JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     WHERE dt.order_id = $1
     ORDER BY ctr.tested_at DESC`,
    [order.id]
  );
  res.json(rows);
});

router.get("/cube-tests/:resultId/pdf-data", requireCustomerAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_weight_kg, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.average_strength_mpa, ctr.remarks, ctr.failure_type, ctr.tested_at,
            u.name AS tested_by_name,
            pq.id AS plant_qc_id, pq.sample_ids, pq.entered_at AS cast_at, pq.number_of_cubes,
            dt.ticket_number, dt.order_id,
            co.id AS order_id, co.casting_location, co.order_date, co.customer_id, co.site_id,
            c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa, md.target_mean_strength_mpa
     FROM cube_test_results ctr
     JOIN users u ON u.id = ctr.tested_by
     JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
     WHERE ctr.id = $1`,
    [req.params.resultId]
  );
  const row = rows[0];
  if (!row || row.customer_id !== req.customerId || !req.siteIds.includes(row.site_id)) {
    return res.status(404).json({ error: "Test result not found." });
  }
  if (!siteAllows(req, row.site_id, "qc_reports")) {
    return res.status(403).json({ error: "QC reports aren't enabled for this site." });
  }
  const { rows: cubes } = await query(
    `SELECT cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa
     FROM cube_test_cubes WHERE cube_test_result_id = $1 ORDER BY sort_order`,
    [req.params.resultId]
  );
  // Same real PDF data a staff member would see — no redaction.
  res.json({ ...row, cubes });
});

export default router;
