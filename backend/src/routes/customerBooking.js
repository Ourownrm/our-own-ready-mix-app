import { Router } from "express";
import { query } from "../db.js";
import { pushToRole } from "../lib/push.js";
import { getOrderTrackingPayload } from "../lib/orderTracking.js";
import { resolveCubeTestDnSummary } from "../lib/cubeTestDns.js";

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
            cbl.allow_qc_reports, cbl.allow_technical_writings,
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
            COALESCE(o.required_at_site_time, o.scheduled_batching_time) AS order_scheduled_batching_time,
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

  // Round 119, post-ship again, item 4 — this page's own copy on the
  // Booking Links tab ("what this customer can see... on the booking link
  // and in their /portal sign-in") already promised QC Reports and
  // Technical Writings here, but this route never actually returned them —
  // it only ever sent tracking data. Scoped to this link's single
  // customer+site, same allow_qc_reports/allow_technical_writings columns
  // the /portal side reads, just without the multi-site fan-out portal
  // codes need (see customerPortal.js's /qc-reports for that version).
  let qcReports = null;
  if (link.allow_qc_reports) {
    const { rows: cubeTests } = await query(
      `SELECT ctr.id, ctr.testing_age_days, ctr.average_strength_mpa, ctr.tested_at,
              co.id AS order_id, m.name AS mix_grade_name
       FROM cube_test_results ctr
       JOIN customer_orders co ON co.id = ctr.order_id
       JOIN mix_grades m ON m.id = co.mix_grade_id
       WHERE co.customer_id = $1 AND co.site_id = $2
       ORDER BY ctr.tested_at DESC NULLS LAST
       LIMIT 50`,
      [link.customer_id, link.site_id]
    );
    const { rows: mixDesignRows } = await query(
      `SELECT co.id AS order_id, co.order_date, md.design_ref_code, m.name AS mix_grade_name
       FROM customer_orders co
       JOIN mix_designs md ON md.id = co.resolved_mix_design_id AND md.status = 'approved'
       JOIN mix_grades m ON m.id = co.mix_grade_id
       WHERE co.customer_id = $1 AND co.site_id = $2
       ORDER BY co.order_date DESC`,
      [link.customer_id, link.site_id]
    );
    const seenDesigns = new Set();
    const mixDesigns = mixDesignRows.filter((r) => {
      if (seenDesigns.has(r.design_ref_code)) return false;
      seenDesigns.add(r.design_ref_code);
      return true;
    });
    qcReports = { cube_tests: cubeTests, mix_designs: mixDesigns };
  }

  let technicalWritings = null;
  if (link.allow_technical_writings) {
    const { rows: docs } = await query(
      `SELECT id, title, category, filename, size_bytes, created_at
       FROM technical_documents ORDER BY created_at DESC`
    );
    technicalWritings = docs;
  }

  res.json({
    customer_name: link.customer_name,
    site_name: link.site_name,
    tracking_enabled: link.tracking_enabled,
    allow_qc_reports: link.allow_qc_reports,
    allow_technical_writings: link.allow_technical_writings,
    mix_grades: mixGrades,
    requests,
    tracking,
    qc_reports: qcReports,
    technical_writings: technicalWritings,
  });
});

// Round 119, post-ship again, item 4 — mix-design PDF for one of this
// link's own orders. Ownership is the token itself (customer_id/site_id
// baked into the link) plus a check that the order actually belongs to
// that same customer+site, same shape customerPortal.js's equivalent route
// returns so the frontend can reuse one PDF viewer for both.
router.get("/:token/orders/:orderId/mix-design-pdf-data", async (req, res) => {
  const link = await loadActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: "expired" });
  if (!link.allow_qc_reports) return res.status(403).json({ error: "QC reports aren't enabled for this site." });

  const { rows: orderRows } = await query(
    "SELECT id, customer_id, site_id, resolved_mix_design_id FROM customer_orders WHERE id = $1",
    [req.params.orderId]
  );
  const order = orderRows[0];
  if (!order || order.customer_id !== link.customer_id || order.site_id !== link.site_id) {
    return res.status(404).json({ error: "Order not found." });
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
  res.json({ ...rows[0], admixtures });
});

router.get("/:token/cube-tests/:resultId/pdf-data", async (req, res) => {
  const link = await loadActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: "expired" });
  if (!link.allow_qc_reports) return res.status(403).json({ error: "QC reports aren't enabled for this site." });

  const { rows } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_weight_kg, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.average_strength_mpa, ctr.remarks, ctr.failure_type, ctr.tested_at,
            u.name AS tested_by_name,
            co.id AS order_id, co.casting_location, co.order_date, co.customer_id, co.site_id,
            c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa, md.target_mean_strength_mpa
     FROM cube_test_results ctr
     JOIN users u ON u.id = ctr.tested_by
     JOIN customer_orders co ON co.id = ctr.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
     WHERE ctr.id = $1`,
    [req.params.resultId]
  );
  const row = rows[0];
  if (!row || row.customer_id !== link.customer_id || row.site_id !== link.site_id) {
    return res.status(404).json({ error: "Test result not found." });
  }
  const { rows: cubes } = await query(
    `SELECT cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa
     FROM cube_test_cubes WHERE cube_test_result_id = $1 ORDER BY sort_order`,
    [req.params.resultId]
  );
  const dnSummary = await resolveCubeTestDnSummary(req.params.resultId);
  res.json({ ...row, ...dnSummary, number_of_cubes: cubes.length, cubes });
});

// Round 119, post-ship again, item 4 — file download for the shared
// Technical Writings library, same base64-JSON shape as
// customerPortal.js's equivalent so the frontend can reuse one viewer.
router.get("/:token/technical-writings/:id/file", async (req, res) => {
  const link = await loadActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: "expired" });
  if (!link.allow_technical_writings) {
    return res.status(403).json({ error: "Technical writings aren't enabled for this site." });
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
