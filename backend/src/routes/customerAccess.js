import { Router } from "express";
import { randomInt } from "crypto";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// ===================== CUSTOMER PORTAL ACCESS CODES (round 119) =====================
// Manager/Admin side: generate, list, and revoke the short access codes
// customers type into /portal to see their own orders + QC reports. The
// public side the customer actually uses lives in routes/customerPortal.js.
// See schema.sql's comment above customer_access_tokens for why this is a
// typed-in code rather than a shareable link like customer_booking_links.
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
  const { rows } = await query(
    `SELECT cat.id, cat.customer_id, cat.token, cat.label, cat.is_active, cat.created_at,
            cat.last_used_at, cat.revoked_at, c.name AS customer_name, u.name AS created_by_name,
            COALESCE(
              (SELECT json_agg(s.name ORDER BY s.name)
               FROM customer_access_token_sites cats JOIN sites s ON s.id = cats.site_id
               WHERE cats.token_id = cat.id),
              '[]'
            ) AS site_names
     FROM customer_access_tokens cat
     JOIN customers c ON c.id = cat.customer_id
     LEFT JOIN users u ON u.id = cat.created_by
     ORDER BY cat.is_active DESC, cat.created_at DESC`
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { customer_id, site_ids, label } = req.body;
  const siteIds = Array.isArray(site_ids) ? site_ids.map(Number).filter(Boolean) : [];
  if (!customer_id || siteIds.length === 0) {
    return res.status(400).json({ error: "Select a customer and at least one site." });
  }

  const { rows: siteCheck } = await query(
    "SELECT id FROM sites WHERE customer_id = $1 AND id = ANY($2::int[])",
    [customer_id, siteIds]
  );
  if (siteCheck.length !== siteIds.length) {
    return res.status(400).json({ error: "One or more selected sites don't belong to this customer." });
  }

  const token = await newUniqueToken();
  const { rows } = await query(
    `INSERT INTO customer_access_tokens (customer_id, token, label, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id, token, label, is_active, created_at`,
    [customer_id, token, (label || "").trim() || null, req.user.id]
  );
  const tokenId = rows[0].id;
  await query(
    `INSERT INTO customer_access_token_sites (token_id, site_id)
     SELECT $1, unnest($2::int[])`,
    [tokenId, siteIds]
  );

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
