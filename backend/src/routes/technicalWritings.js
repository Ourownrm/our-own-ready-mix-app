import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// ===================== TECHNICAL WRITINGS — STAFF SIDE (round 119) =====================
// Manager/Admin manage a small library of PDF guides (e.g. "After-pour
// care", "Choosing the right grade for slabs vs. footings") that customers
// see under the portal's "Technical Writings" tile once their own access
// code has allow_technical_writings on. Files are uploaded as base64 JSON
// (see index.js's larger json body limit for this route) rather than a
// real multipart/form-data upload — this app has no multipart middleware
// anywhere yet, and base64-over-JSON matches every other endpoint's
// all-JSON convention with no new dependency. The public/customer-facing
// side (list + download, gated on the per-code switch) lives in
// routes/customerPortal.js, same split as customerAccess.js/customerPortal.js.
const router = Router();
router.use(requireAuth, requireRole("manager", "administrator"));

const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — generous for a text/diagram PDF guide, not a scan dump

router.get("/", async (req, res) => {
  // Deliberately never selects file_data here — this list can be fetched
  // often (every time the manage screen loads) and the bytes are only
  // needed once, at actual download time.
  const { rows } = await query(
    `SELECT td.id, td.title, td.category, td.filename, td.mime_type, td.size_bytes, td.created_at, u.name AS uploaded_by_name
     FROM technical_documents td
     LEFT JOIN users u ON u.id = td.uploaded_by
     ORDER BY td.created_at DESC`
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { title, category, filename, mime_type, data_base64 } = req.body;
  const titleTrimmed = (title || "").trim();
  if (!titleTrimmed || !filename || !data_base64) {
    return res.status(400).json({ error: "Title and a PDF file are required." });
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
    return res.status(400).json({ error: `That file is too large — please keep it under ${MAX_SIZE_BYTES / (1024 * 1024)}MB.` });
  }

  const { rows } = await query(
    `INSERT INTO technical_documents (title, category, filename, mime_type, size_bytes, file_data, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, title, category, filename, mime_type, size_bytes, created_at`,
    [titleTrimmed, (category || "").trim() || null, filename, mime_type || "application/pdf", buffer.length, buffer, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Rename / recategorize only — re-uploading a new file is delete + upload
// again, kept simple rather than building a "replace file" flow business
// hasn't asked for.
router.patch("/:id", async (req, res) => {
  const { title, category } = req.body;
  const titleTrimmed = (title || "").trim();
  if (!titleTrimmed) return res.status(400).json({ error: "Title is required." });
  const { rows } = await query(
    `UPDATE technical_documents SET title = $1, category = $2 WHERE id = $3
     RETURNING id, title, category, filename, mime_type, size_bytes, created_at`,
    [titleTrimmed, (category || "").trim() || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Document not found." });
  res.json(rows[0]);
});

router.delete("/:id", async (req, res) => {
  const { rows } = await query("DELETE FROM technical_documents WHERE id = $1 RETURNING id", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Document not found." });
  res.json({ ok: true });
});

export default router;
