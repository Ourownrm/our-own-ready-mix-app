import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

router.get("/customers", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM customers WHERE is_active ORDER BY name");
  res.json(rows);
});

router.get("/sites", async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.customer_id, s.distance_from_plant_km, s.latitude, s.longitude,
            tac.label AS trip_allowance_label
     FROM sites s LEFT JOIN trip_allowance_categories tac ON tac.id = s.trip_allowance_category_id
     WHERE s.is_active ORDER BY s.name`
  );
  res.json(rows);
});

router.get("/mix-grades", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM mix_grades ORDER BY name");
  res.json(rows);
});

router.get("/trucks", async (req, res) => {
  const { rows } = await query("SELECT id, truck_number FROM trucks WHERE is_active ORDER BY truck_number");
  res.json(rows);
});

router.get("/drivers", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM users WHERE role = 'driver' AND is_active ORDER BY name");
  res.json(rows);
});

router.get("/site-supervisors", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM users WHERE role = 'site_supervisor' AND is_active ORDER BY name");
  res.json(rows);
});

router.get("/trip-allowance-categories", async (req, res) => {
  const { rows } = await query("SELECT id, label FROM trip_allowance_categories ORDER BY amount");
  res.json(rows);
});

router.get("/pumps", async (req, res) => {
  const { rows } = await query("SELECT id, pump_code, pump_type FROM pumps WHERE is_active ORDER BY pump_code");
  res.json(rows);
});

router.get("/rejection-reasons", async (req, res) => {
  const { rows } = await query("SELECT id, reason FROM rejection_reasons ORDER BY reason");
  res.json(rows);
});

router.get("/salespersons", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM salespersons WHERE is_active ORDER BY name");
  res.json(rows);
});

router.get("/fuel-stations", async (req, res) => {
  const { rows } = await query("SELECT id, name, location FROM fuel_stations WHERE is_active ORDER BY name");
  res.json(rows);
});

router.get("/equipment", async (req, res) => {
  const { rows } = await query("SELECT id, equipment_type, name FROM equipment WHERE is_active ORDER BY equipment_type, name");
  res.json(rows);
});

// Raw material stock — read-only here (QC Engineer edits via /qc/raw-material-stock).
// Shown on Manager and Administrator dashboards, always reflecting whatever QC
// last saved until they update it again.
router.get("/raw-material-stock", async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.bin_name, s.unit, s.type_brand, s.stock_qty, s.updated_at, u.name AS updated_by_name
     FROM raw_material_stock s LEFT JOIN users u ON u.id = s.updated_by
     ORDER BY s.id`
  );
  res.json(rows);
});

export default router;
