import { Router } from "express";
import { randomBytes } from "crypto";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// ===================== CUSTOMER BOOKING LINKS (round 100, item 4) =====================
// Manager/Admin side of the customer-facing booking form — generate, list,
// toggle tracking/QC reports/technical writings, and revoke a per-customer+
// site link. The public side that the customer actually opens lives in
// routes/customerBooking.js.
//
// Round 119, post-ship (per the business's own mockup) — this same table is
// now ALSO the single per-customer+site control for what the /portal
// customer sign-in shows: allow_qc_reports and allow_technical_writings
// joined tracking_enabled as siblings on this row, rather than living on
// customer_access_tokens (per access code). See schema.sql's comment above
// customer_booking_links for the full reasoning, and
// routes/customerPortal.js's requireCustomerAuth for how a portal session
// resolves effective permissions per order's own site from here.
const router = Router();
router.use(requireAuth);

function newToken() {
  return randomBytes(24).toString("base64url");
}

router.get("/", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT cbl.id, cbl.customer_id, cbl.site_id, cbl.token, cbl.tracking_enabled,
            cbl.allow_qc_reports, cbl.allow_technical_writings, cbl.is_active,
            cbl.created_at, cbl.revoked_at, c.name AS customer_name, s.name AS site_name,
            u.name AS created_by_name
     FROM customer_booking_links cbl
     JOIN customers c ON c.id = cbl.customer_id
     JOIN sites s ON s.id = cbl.site_id
     LEFT JOIN users u ON u.id = cbl.created_by
     ORDER BY cbl.is_active DESC, cbl.created_at DESC`
  );
  res.json(rows);
});

// Generating a new link for a customer+site automatically revokes whatever
// link was active before for that same customer+site — same "no two links
// valid for the same thing at once" rule as the round-91 order tracking link.
// tracking_enabled keeps its historical default of OFF (a heavier feature —
// live GPS — Manager opts a customer into deliberately); QC reports and
// Technical Writings default ON, matching how the old per-code system
// behaved before this round (the common case is "let them see everything").
router.post("/", requireRole("manager", "administrator"), async (req, res) => {
  const { customer_id, site_id, tracking_enabled, allow_qc_reports, allow_technical_writings } = req.body;
  if (!customer_id || !site_id) return res.status(400).json({ error: "Select a customer and a site." });

  const { rows: siteCheck } = await query(
    "SELECT id FROM sites WHERE id = $1 AND customer_id = $2",
    [site_id, customer_id]
  );
  if (!siteCheck.length) return res.status(400).json({ error: "That site doesn't belong to the selected customer." });

  await query(
    `UPDATE customer_booking_links SET is_active = false, revoked_at = now(), revoked_by = $1
     WHERE customer_id = $2 AND site_id = $3 AND is_active`,
    [req.user.id, customer_id, site_id]
  );
  const { rows } = await query(
    `INSERT INTO customer_booking_links (customer_id, site_id, token, tracking_enabled, allow_qc_reports, allow_technical_writings, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, token, tracking_enabled, allow_qc_reports, allow_technical_writings, is_active, created_at`,
    [customer_id, site_id, newToken(), !!tracking_enabled, allow_qc_reports !== false, allow_technical_writings !== false, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Round 119, post-ship — replaces the old single-purpose PATCH /:id/tracking
// with all three switches together, matching customerAccess.js's own
// PATCH /:id/permissions pattern. Independent of revoke either way: flipping
// any of these does not touch is_active, and revoking doesn't touch these —
// a revoked link's switches are just moot since there's no link to open.
router.patch("/:id/permissions", requireRole("manager", "administrator"), async (req, res) => {
  const { tracking_enabled, allow_qc_reports, allow_technical_writings } = req.body;
  if (
    typeof tracking_enabled !== "boolean" ||
    typeof allow_qc_reports !== "boolean" ||
    typeof allow_technical_writings !== "boolean"
  ) {
    return res.status(400).json({ error: "All three switches must be sent as true/false." });
  }
  const { rows } = await query(
    `UPDATE customer_booking_links SET tracking_enabled = $1, allow_qc_reports = $2, allow_technical_writings = $3
     WHERE id = $4 RETURNING id, tracking_enabled, allow_qc_reports, allow_technical_writings`,
    [tracking_enabled, allow_qc_reports, allow_technical_writings, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Link not found." });
  res.json(rows[0]);
});

router.post("/:id/revoke", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `UPDATE customer_booking_links SET is_active = false, revoked_at = now(), revoked_by = $1
     WHERE id = $2 AND is_active RETURNING id`,
    [req.user.id, req.params.id]
  );
  if (!rows.length) return res.status(400).json({ error: "Link is already revoked." });
  res.json({ ok: true });
});

export default router;
