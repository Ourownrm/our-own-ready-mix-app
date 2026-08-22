import { Router } from "express";
import { query } from "../db.js";
import { pushToRole } from "../lib/push.js";
import { getOrderTrackingPayload } from "../lib/orderTracking.js";

// Public, unauthenticated customer booking form (round 100, item 4) —
// deliberately NOT mounted behind requireAuth, same reasoning as
// routes/tracking.js: the token itself is the whole access boundary, scoped
// to exactly one customer + one site, no account, no browsing to another
// link. Read+write (the customer can submit a request), but every write is
// scoped to the link's own customer_id/site_id — nothing in the request body
// can point it at a different customer or site.
const router = Router();

async function loadActiveLink(token) {
  const { rows } = await query(
    `SELECT cbl.id, cbl.customer_id, cbl.site_id, cbl.tracking_enabled, cbl.is_active,
            c.name AS customer_name, s.name AS site_name
     FROM customer_booking_links cbl
     JOIN customers c ON c.id = cbl.customer_id
     JOIN sites s ON s.id = cbl.site_id
     WHERE cbl.token = $1`,
    [token]
  );
  const link = rows[0];
  if (!link || !link.is_active) return null;
  return link;
}

router.get("/:token", async (req, res) => {
  const link = await loadActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: "expired" });

  const { rows: mixGrades } = await query("SELECT id, name FROM mix_grades ORDER BY name");

  // Round 116 fixes, reported after round 115 shipped:
  // 1. A request's card used to freeze at "Accepted — scheduled" forever once
  //    converted — it never looked at what happened to the order afterward
  //    (delivered, completed, closed, cancelled). Now LEFT JOINs the linked
  //    order and its (possibly Manager-corrected) mix grade, so the customer
  //    sees the order's real, live status and scheduled details.
  // 2. Whatever date/time/grade/qty Manager actually scheduled the order for
  //    (via Convert or a later Correct Order edit) can differ from what the
  //    customer originally asked for — the booking row itself is left alone
  //    as the historical record of the original ask, but the response now
  //    also carries the order's current values (`order_*` fields) so the
  //    frontend can show what's actually scheduled once converted.
  const { rows: requests } = await query(
    `SELECT b.id, b.status, b.preferred_date, b.preferred_time, b.estimated_qty_m3, b.pump_requirement,
            b.casting_location, b.declined_reason, b.converted_order_id, b.created_at, m.name AS mix_grade_name,
            o.status AS order_status, o.order_date AS order_order_date,
            o.scheduled_batching_time AS order_scheduled_batching_time,
            o.order_quantity_m3 AS order_order_quantity_m3, om.name AS order_mix_grade_name
     FROM bookings b
     LEFT JOIN mix_grades m ON m.id = b.mix_grade_id
     LEFT JOIN customer_orders o ON o.id = b.converted_order_id
     LEFT JOIN mix_grades om ON om.id = o.mix_grade_id
     WHERE b.booking_link_id = $1
     ORDER BY b.created_at DESC`,
    [link.id]
  );

  // Round 116 fix: tracking used to only ever come from a request that was
  // itself submitted through THIS link and converted here — so a link
  // generated for a customer/site that already had an ongoing order (created
  // directly by Manager, not via a booking request) showed no tracking at
  // all, even with tracking turned on. Tracking is now tied to whatever
  // order is currently live for this customer+site, regardless of how that
  // order originated — preferring an order still in progress, falling back
  // to the most recent one otherwise (getOrderTrackingPayload itself already
  // handles the post-terminal grace window / going stale).
  let trackingOrderId = null;
  if (link.tracking_enabled) {
    const { rows: orderRows } = await query(
      `SELECT id FROM customer_orders
       WHERE customer_id = $1 AND site_id = $2
       ORDER BY (status NOT IN ('completed', 'closed', 'cancelled')) DESC, order_date DESC, id DESC
       LIMIT 1`,
      [link.customer_id, link.site_id]
    );
    trackingOrderId = orderRows[0]?.id || null;
  }
  const tracking = trackingOrderId ? await getOrderTrackingPayload(trackingOrderId) : null;

  res.json({
    customer_name: link.customer_name,
    site_name: link.site_name,
    tracking_enabled: link.tracking_enabled,
    mix_grades: mixGrades,
    requests,
    tracking,
  });
});

router.post("/:token", async (req, res) => {
  const link = await loadActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: "expired" });

  // Round 115: used to block a second submission while any request was
  // still pending, on the theory that a pending request already covers
  // "we're waiting on Manager." In practice a site can genuinely need more
  // than one open request at once — e.g. 30 m³ of M25 and 34 m³ of M20 for
  // the same pour, or two different structures on the same site — so a
  // customer can now submit while another request is still under review.
  // Duplicate double-taps are still visible to Manager/Admin as two
  // identical pending requests, same as any other queue.

  const {
    mix_grade_id, estimated_qty_m3, preferred_date, preferred_time,
    pump_requirement, casting_location, site_contact_name, site_contact_number, notes,
  } = req.body;

  const required = { mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, pump_requirement, site_contact_number };
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
      pump_requirement, casting_location, site_contact_name, site_contact_number, booking_link_id, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL)
     RETURNING id`,
    [link.customer_id, link.site_id, mix_grade_id, estimated_qty_m3, preferred_date, preferred_time, notes || null,
     pump_requirement, casting_location || null, site_contact_name || null, site_contact_number, link.id]
  );

  for (const role of ["manager", "administrator"]) {
    await query(
      `INSERT INTO notifications (recipient_role, type, message)
       VALUES ($1, 'customer_booking_submitted', $2)`,
      [role, `New booking request from ${link.customer_name} — ${link.site_name}`]
    );
    await pushToRole(role, {
      title: "New customer booking request",
      body: `${link.customer_name} — ${link.site_name}`,
      url: "/customer-booking",
    });
  }

  res.status(201).json({ ok: true, id: rows[0].id });
});

export default router;
