import { Router } from "express";
import { randomBytes } from "crypto";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// ===================== CUSTOMER BOOKING LINKS (round 100, item 4) =====================
// Manager/Admin side of the customer-facing booking form — generate, list,
// toggle tracking, and revoke a per-customer+site link. The public side that
// the customer actually opens lives in routes/customerBooking.js.
const router = Router();
router.use(requireAuth);

function newToken() {
  return randomBytes(24).toString("base64url");
}

router.get("/", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT cbl.id, cbl.customer_id, cbl.site_id, cbl.token, cbl.tracking_enabled, cbl.is_active,
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
router.post("/", requireRole("manager", "administrator"), async (req, res) => {
  const { customer_id, site_id, tracking_enabled } = req.body;
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
    `INSERT INTO customer_booking_links (customer_id, site_id, token, tracking_enabled, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, token, tracking_enabled, is_active, created_at`,
    [customer_id, site_id, newToken(), !!tracking_enabled, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Independent of revoke — this is what answers "how do I turn off just the
// delivery-status view without killing the booking link itself": tracking_enabled
// flips on its own, is_active is untouched either way.
router.patch("/:id/tracking", requireRole("manager", "administrator"), async (req, res) => {
  const { tracking_enabled } = req.body;
  const { rows } = await query(
    `UPDATE customer_booking_links SET tracking_enabled = $1 WHERE id = $2 RETURNING id, tracking_enabled`,
    [!!tracking_enabled, req.params.id]
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
