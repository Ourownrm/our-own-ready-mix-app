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

  const { rows: reqRows } = await query(
    `SELECT b.id, b.status, b.preferred_date, b.preferred_time, b.estimated_qty_m3, b.pump_requirement,
            b.casting_location, b.declined_reason, b.converted_order_id, b.created_at, m.name AS mix_grade_name
     FROM bookings b
     LEFT JOIN mix_grades m ON m.id = b.mix_grade_id
     WHERE b.booking_link_id = $1
     ORDER BY b.created_at DESC LIMIT 1`,
    [link.id]
  );
  const latest = reqRows[0] || null;

  let tracking = null;
  if (latest && latest.status === "converted" && link.tracking_enabled && latest.converted_order_id) {
    tracking = await getOrderTrackingPayload(latest.converted_order_id);
  }

  res.json({
    customer_name: link.customer_name,
    site_name: link.site_name,
    tracking_enabled: link.tracking_enabled,
    mix_grades: mixGrades,
    latest_request: latest,
    tracking,
  });
});

router.post("/:token", async (req, res) => {
  const link = await loadActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: "expired" });

  // A pending request already covers "we're waiting on Manager" — block a
  // second submission until that one's resolved, so the queue doesn't fill
  // up with duplicates from someone tapping Send twice.
  const { rows: pendingCheck } = await query(
    "SELECT id FROM bookings WHERE booking_link_id = $1 AND status = 'pending'",
    [link.id]
  );
  if (pendingCheck.length) {
    return res.status(409).json({ error: "You already have a request pending review — check back once it's been actioned." });
  }

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
