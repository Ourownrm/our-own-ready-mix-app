import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// ===================== SITE CONTENT (round 119, post-ship) =====================
// Editable copy for the public marketing pages the mockup adds:
// "Services, Products & Equipment" (/services) and "Ready-Mix vs. Site-Mix"
// (/rmc-vs-sitemix) — see schema.sql's comment above site_content for why
// this is one JSONB blob per page rather than normalized tables. GET is
// public/unauthenticated (the marketing pages themselves have no login);
// PUT is Manager/Admin only, via the "Site Content" editor reachable from
// the Masters menu (pages/SiteContentEditor.jsx).
const ONLY_KEYS = ["services", "rmc_vs_sitemix"];
const router = Router();

router.get("/:key", async (req, res) => {
  if (!ONLY_KEYS.includes(req.params.key)) return res.status(404).json({ error: "Unknown content key." });
  const { rows } = await query("SELECT content, updated_at FROM site_content WHERE key = $1", [req.params.key]);
  if (!rows.length) return res.status(404).json({ error: "No content saved yet for this page." });
  res.json(rows[0]);
});

router.put("/:key", requireAuth, requireRole("manager", "administrator"), async (req, res) => {
  if (!ONLY_KEYS.includes(req.params.key)) return res.status(404).json({ error: "Unknown content key." });
  const { content } = req.body;
  if (!content || typeof content !== "object") {
    return res.status(400).json({ error: "content must be a JSON object." });
  }
  const { rows } = await query(
    `INSERT INTO site_content (key, content, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET content = $2::jsonb, updated_by = $3, updated_at = now()
     RETURNING content, updated_at`,
    [req.params.key, JSON.stringify(content), req.user.id]
  );
  res.json(rows[0]);
});

export default router;
