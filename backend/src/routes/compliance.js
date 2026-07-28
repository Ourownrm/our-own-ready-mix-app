import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("manager", "administrator"));

const ASSET_CATEGORY = {
  transit_mixer: "vehicle", boom_pump: "equipment", batching_plant: "equipment",
  loader: "equipment", generator: "equipment", weighbridge: "equipment",
  compressor: "equipment", pickup: "vehicle", car: "vehicle", motor_bike: "vehicle", other: "equipment",
};

router.get("/assets", async (req, res) => {
  const { rows } = await query("SELECT * FROM compliance_assets ORDER BY category, asset_type, name");
  res.json(rows);
});

router.post("/assets", async (req, res) => {
  const { name, asset_type } = req.body;
  if (!name || !ASSET_CATEGORY[asset_type]) {
    return res.status(400).json({ error: "Name and a valid asset type are required." });
  }
  const { rows } = await query(
    "INSERT INTO compliance_assets (name, asset_type, category) VALUES ($1,$2,$3) RETURNING *",
    [name, asset_type, ASSET_CATEGORY[asset_type]]
  );
  res.status(201).json(rows[0]);
});

router.patch("/assets/:id/status", async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE compliance_assets SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

// Full register — every tracked document, active assets only, most urgent first.
router.get("/documents", async (req, res) => {
  const { rows } = await query(
    `SELECT cd.*, ca.name AS asset_name, ca.asset_type, ca.category, u.name AS updated_by_name,
            (cd.expiry_date - CURRENT_DATE) AS days_until_expiry
     FROM compliance_documents cd
     JOIN compliance_assets ca ON ca.id = cd.asset_id
     LEFT JOIN users u ON u.id = cd.updated_by
     WHERE ca.is_active
     ORDER BY cd.expiry_date ASC`
  );
  res.json(rows);
});

// Add or renew a document — one row per asset+document type, so renewing
// just updates the same row's expiry date instead of piling up history.
router.post("/documents", async (req, res) => {
  const { asset_id, document_type, document_number, expiry_date } = req.body;
  if (!asset_id || !document_type || !expiry_date) {
    return res.status(400).json({ error: "Asset, document type, and expiry date are required." });
  }
  const { rows } = await query(
    `INSERT INTO compliance_documents (asset_id, document_type, document_number, expiry_date, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (asset_id, document_type) DO UPDATE SET
       document_number = $3, expiry_date = $4, updated_by = $5, updated_at = now()
     RETURNING *`,
    [asset_id, document_type, document_number || null, expiry_date, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Dashboard card: everything expired or due within 7 days.
router.get("/alerts", async (req, res) => {
  const { rows } = await query(
    `SELECT cd.id, cd.document_type, cd.expiry_date, ca.name AS asset_name,
            (cd.expiry_date - CURRENT_DATE) AS days_until_expiry
     FROM compliance_documents cd
     JOIN compliance_assets ca ON ca.id = cd.asset_id
     WHERE ca.is_active AND (cd.expiry_date - CURRENT_DATE) <= 7
     ORDER BY cd.expiry_date ASC`
  );
  res.json(rows);
});

export default router;
