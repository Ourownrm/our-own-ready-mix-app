import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// ===================== HOME SCREEN PHOTOS — STAFF SIDE (Round 131, item 4) =====================
// Manager/Admin manage a small gallery of plant/site photos shown as a
// rotating widget on the customer portal's Home screen (replaces the old
// "Why ready-mix beats site-mix" strip there — see customerPortal.js's
// header comment on the /home-photos routes for the read-only, customer-
// facing side of this). Uploaded as base64 JSON, same convention as
// technicalWritings.js (no multipart middleware anywhere in this app).
const router = Router();
router.use(requireAuth, requireRole("manager", "administrator"));

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — a phone photo, not a raw camera dump
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

router.get("/", async (req, res) => {
  // Never selects image_data here — this list can be fetched often (every
  // time the manage screen loads) and the bytes are only needed once per
  // photo, via the /:id/image route below.
  const { rows } = await query(
    `SELECT hsp.id, hsp.caption, hsp.location_tag, hsp.filename, hsp.mime_type, hsp.size_bytes,
            hsp.display_order, hsp.is_visible, hsp.created_at, u.name AS uploaded_by_name
     FROM home_screen_photos hsp
     LEFT JOIN users u ON u.id = hsp.uploaded_by
     ORDER BY hsp.display_order, hsp.id`
  );
  res.json(rows);
});

router.get("/:id/image", async (req, res) => {
  const { rows } = await query("SELECT mime_type, image_data FROM home_screen_photos WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Photo not found." });
  res.json({ mime_type: rows[0].mime_type, data_base64: rows[0].image_data.toString("base64") });
});

router.post("/", async (req, res) => {
  const { caption, location_tag, filename, mime_type, data_base64 } = req.body;
  if (!filename || !data_base64) {
    return res.status(400).json({ error: "A photo file is required." });
  }
  const tag = location_tag === "site" ? "site" : "plant";
  const type = ALLOWED_MIME_TYPES.includes(mime_type) ? mime_type : "image/jpeg";
  if (!ALLOWED_MIME_TYPES.includes(mime_type)) {
    return res.status(400).json({ error: "Please upload a JPG, PNG, or WEBP photo." });
  }
  let buffer;
  try {
    buffer = Buffer.from(data_base64, "base64");
  } catch {
    return res.status(400).json({ error: "That file couldn't be read — please try uploading it again." });
  }
  if (buffer.length === 0) {
    return res.status(400).json({ error: "That file appears to be empty." });
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    return res.status(400).json({ error: `That photo is too large — please keep it under ${MAX_SIZE_BYTES / (1024 * 1024)}MB.` });
  }

  const { rows: maxRows } = await query("SELECT COALESCE(MAX(display_order), -1) AS max_order FROM home_screen_photos");
  const nextOrder = Number(maxRows[0].max_order) + 1;

  const { rows } = await query(
    `INSERT INTO home_screen_photos (caption, location_tag, filename, mime_type, size_bytes, image_data, display_order, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, caption, location_tag, filename, mime_type, size_bytes, display_order, is_visible, created_at`,
    [(caption || "").trim() || null, tag, filename, type, buffer.length, buffer, nextOrder, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Caption / location tag / visibility — any subset. Re-uploading a new
// image is delete + upload again, same "keep it simple" call as
// technicalWritings.js's rename-only PATCH.
router.patch("/:id", async (req, res) => {
  const { rows: existingRows } = await query("SELECT * FROM home_screen_photos WHERE id = $1", [req.params.id]);
  if (!existingRows.length) return res.status(404).json({ error: "Photo not found." });
  const existing = existingRows[0];

  const caption = req.body.caption !== undefined ? (req.body.caption || "").trim() || null : existing.caption;
  const location_tag = req.body.location_tag === "site" || req.body.location_tag === "plant" ? req.body.location_tag : existing.location_tag;
  const is_visible = req.body.is_visible !== undefined ? !!req.body.is_visible : existing.is_visible;

  const { rows } = await query(
    `UPDATE home_screen_photos SET caption = $1, location_tag = $2, is_visible = $3 WHERE id = $4
     RETURNING id, caption, location_tag, filename, mime_type, size_bytes, display_order, is_visible, created_at`,
    [caption, location_tag, is_visible, req.params.id]
  );
  res.json(rows[0]);
});

// Persists a full new ordering in one call — the admin grid reorders
// locally (move up/down) then sends the whole id list once, simpler and
// more robust than one PATCH per moved card.
router.put("/reorder", async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: "order must be a non-empty list of photo ids." });
  }
  for (let i = 0; i < order.length; i++) {
    await query("UPDATE home_screen_photos SET display_order = $1 WHERE id = $2", [i, order[i]]);
  }
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const { rows } = await query("DELETE FROM home_screen_photos WHERE id = $1 RETURNING id", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Photo not found." });
  res.json({ ok: true });
});

export default router;
