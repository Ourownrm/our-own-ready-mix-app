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

// Lets the order-creation form check whether a rate is actually on file for a
// customer/grade before the order is placed, instead of only discovering the
// gap after a delivery completes with no invoice.
router.get("/rate-check", async (req, res) => {
  const { customer_id, mix_grade_id, site_id, date } = req.query;
  if (!customer_id || !mix_grade_id) {
    return res.status(400).json({ error: "customer_id and mix_grade_id are required." });
  }
  const { rows } = await query(
    `SELECT rate_per_m3, (site_id = $4::int) AS is_site_specific,
            line_pump_charge, line_pump_min_qty_m3, boom_pump_charge, boom_pump_min_qty_m3,
            part_load_min_qty_m3, part_load_charge_per_m3, pumping_charge_lumpsum
     FROM rate_master
     WHERE customer_id = $1 AND mix_grade_id = $2
       AND (site_id = $4::int OR site_id IS NULL)
       AND effective_from <= COALESCE($3::date, CURRENT_DATE) AND (effective_to IS NULL OR effective_to >= COALESCE($3::date, CURRENT_DATE))
     ORDER BY (site_id = $4::int) DESC, effective_from DESC, id DESC LIMIT 1`,
    [customer_id, mix_grade_id, date || null, site_id || null]
  );
  const r = rows[0];
  res.json({
    rate_exists: rows.length > 0,
    rate_per_m3: r?.rate_per_m3 ?? null,
    is_site_specific: r?.is_site_specific ?? false,
    // Falls back to the legacy single pump-charge field (as the line pump
    // charge) for a rate that predates the pump-type split.
    line_pump_charge: r?.line_pump_charge ?? r?.pumping_charge_lumpsum ?? null,
    line_pump_min_qty_m3: r?.line_pump_min_qty_m3 ?? 20,
    boom_pump_charge: r?.boom_pump_charge ?? null,
    boom_pump_min_qty_m3: r?.boom_pump_min_qty_m3 ?? 50,
    part_load_min_qty_m3: r?.part_load_min_qty_m3 ?? 5,
    part_load_charge_per_m3: r?.part_load_charge_per_m3 ?? null,
  });
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

router.get("/sales-executives", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM users WHERE role = 'sales_executive' AND is_active ORDER BY name");
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
    `SELECT s.id, s.bin_name, s.unit, s.type_brand, s.stock_qty, s.qty_on_order, s.expected_delivery_date, s.updated_at, u.name AS updated_by_name
     FROM raw_material_stock s LEFT JOIN users u ON u.id = s.updated_by
     ORDER BY s.id`
  );
  res.json(rows);
});

export default router;
