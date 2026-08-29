import { Router } from "express";
import { randomInt } from "crypto";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ensureActiveLink } from "./bookingLinks.js";

// ===================== CUSTOMER PORTAL ACCESS CODES (round 119) =====================
// Manager/Admin side: generate, list, and revoke the short access codes
// customers type into /portal to see their own orders + QC reports. The
// public side the customer actually uses lives in routes/customerPortal.js.
// See schema.sql's comment above customer_access_tokens for why this is a
// typed-in code rather than a shareable link like customer_booking_links.
//
// Round 119, post-ship — this route file is now IDENTITY-ONLY (which
// customer, which sites, a label). What a code can actually see (tracking/
// QC reports/technical writings) moved to routes/bookingLinks.js's
// PATCH /:id/permissions instead, per customer+SITE rather than per code —
// see schema.sql's comment above customer_booking_links. A code covering
// three sites can now show different things per site; that couldn't be
// expressed when the switches lived here.
const router = Router();
router.use(requireAuth, requireRole("manager", "administrator"));

// Avoids visually ambiguous characters (0/O, 1/I/L) since this is meant to
// be read out over a phone call or typed in from a WhatsApp message.
const TOKEN_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 8;

function randomToken() {
  let t = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) t += TOKEN_CHARS[randomInt(TOKEN_CHARS.length)];
  return t;
}

async function newUniqueToken() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomToken();
    const { rows } = await query("SELECT 1 FROM customer_access_tokens WHERE token = $1", [candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error("Could not generate a unique access code — please try again.");
}

router.get("/", async (req, res) => {
  // Round 119, post-ship again, item 3 — now returns each site's id
  // alongside its name (not just the name string), so the frontend can look
  // up and edit that site's customer_booking_links permissions (Live
  // Tracking / QC Reports / Tech. Writings) right here on the Portal Access
  // tab, instead of sending Manager to the separate Booking Links tab with
  // no way back to which sites a given code even covers.
  //
  // Round 122 — a covers_all_sites code has no rows in
  // customer_access_token_sites at all (see that column's comment in
  // schema.sql), so "sites" here is resolved live from the customer's
  // CURRENT sites for one of those, same as requireCustomerAuth does at
  // sign-in time — this is purely for display (an accurate "N sites" count
  // right now), not what auth actually checks against.
  const { rows } = await query(
    `SELECT cat.id, cat.customer_id, cat.token, cat.label, cat.is_active, cat.created_at,
            cat.last_used_at, cat.revoked_at, cat.covers_all_sites, c.name AS customer_name, u.name AS created_by_name,
            CASE WHEN cat.covers_all_sites THEN
              COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name) FROM sites s WHERE s.customer_id = cat.customer_id), '[]')
            ELSE
              COALESCE(
                (SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                 FROM customer_access_token_sites cats JOIN sites s ON s.id = cats.site_id
                 WHERE cats.token_id = cat.id),
                '[]'
              )
            END AS sites
     FROM customer_access_tokens cat
     JOIN customers c ON c.id = cat.customer_id
     LEFT JOIN users u ON u.id = cat.created_by
     ORDER BY cat.is_active DESC, cat.created_at DESC`
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { customer_id, site_ids, covers_all_sites, label } = req.body;
  const coversAllSites = !!covers_all_sites;
  let siteIds = Array.isArray(site_ids) ? site_ids.map(Number).filter(Boolean) : [];

  if (!customer_id) return res.status(400).json({ error: "Select a customer." });
  if (!coversAllSites && siteIds.length === 0) {
    return res.status(400).json({ error: "Select a customer and at least one site, or choose \"All sites for this customer\"." });
  }

  if (coversAllSites) {
    // The token itself doesn't enumerate sites when covers_all_sites is
    // true (see schema.sql) — but we still need today's site list to
    // provision customer_booking_links rows below, so any site the
    // customer already has shows something in the portal immediately.
    // Any site added LATER is picked up live by requireCustomerAuth, no
    // action needed here for it.
    const { rows: allSites } = await query("SELECT id FROM sites WHERE customer_id = $1", [customer_id]);
    siteIds = allSites.map((s) => s.id);
  } else {
    const { rows: siteCheck } = await query(
      "SELECT id FROM sites WHERE customer_id = $1 AND id = ANY($2::int[])",
      [customer_id, siteIds]
    );
    if (siteCheck.length !== siteIds.length) {
      return res.status(400).json({ error: "One or more selected sites don't belong to this customer." });
    }
  }

  const token = await newUniqueToken();
  const { rows } = await query(
    `INSERT INTO customer_access_tokens (customer_id, token, label, covers_all_sites, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, token, label, is_active, covers_all_sites, created_at`,
    [customer_id, token, (label || "").trim() || null, coversAllSites, req.user.id]
  );
  const tokenId = rows[0].id;
  if (!coversAllSites) {
    await query(
      `INSERT INTO customer_access_token_sites (token_id, site_id)
       SELECT $1, unnest($2::int[])`,
      [tokenId, siteIds]
    );
  }

  // Round 119, post-ship again, item 3 — guarantee every site this code
  // covers has a customer_booking_links row (default permissions: tracking
  // off, QC reports + technical writings on), so a customer signing in with
  // just a Portal Access code — no one having separately generated a public
  // booking link for that site — still resolves real permissions instead of
  // everything defaulting to off. See ensureActiveLink in bookingLinks.js.
  // Round 122 — the permission flags passed in from the unified "Grant
  // portal access" form apply on top of ensureActiveLink's defaults, so
  // choosing e.g. "Live delivery tracking" at generation time takes effect
  // immediately instead of defaulting off and needing a second edit.
  const {
    tracking_enabled: grantTracking,
    allow_qc_reports: grantQc,
    allow_technical_writings: grantWritings,
  } = req.body;
  for (const siteId of siteIds) {
    const link = await ensureActiveLink(customer_id, siteId, req.user.id);
    if (typeof grantTracking === "boolean" || typeof grantQc === "boolean" || typeof grantWritings === "boolean") {
      await query(
        `UPDATE customer_booking_links SET tracking_enabled = $1, allow_qc_reports = $2, allow_technical_writings = $3 WHERE id = $4`,
        [
          typeof grantTracking === "boolean" ? grantTracking : link.tracking_enabled,
          typeof grantQc === "boolean" ? grantQc : link.allow_qc_reports,
          typeof grantWritings === "boolean" ? grantWritings : link.allow_technical_writings,
          link.id,
        ]
      );
    }
  }

  res.status(201).json(rows[0]);
});

router.post("/:id/revoke", async (req, res) => {
  const { rows } = await query(
    `UPDATE customer_access_tokens SET is_active = false, revoked_at = now(), revoked_by = $1
     WHERE id = $2 AND is_active RETURNING id`,
    [req.user.id, req.params.id]
  );
  if (!rows.length) return res.status(400).json({ error: "This access code is already revoked." });
  res.json({ ok: true });
});

export default router;
