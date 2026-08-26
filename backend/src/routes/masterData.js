import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { BREAKDOWN_ISSUE_TYPES } from "../lib/breakdownIssueTypes.js";

const router = Router();
router.use(requireAuth);

router.get("/customers", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM customers WHERE is_active ORDER BY name");
  res.json(rows);
});

// Round 99, item 3 — fixed picklist for the driver breakdown report.
router.get("/breakdown-issue-types", (req, res) => {
  res.json(BREAKDOWN_ISSUE_TYPES);
});

router.get("/lubricant-types", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM lubricant_types WHERE is_active ORDER BY name");
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

// Site Contacts directory (round 96, item 7) — feeds Create Order's autofill.
// Scoped to customer+site, since a contact is normally specific to a site,
// not the customer as a whole. Any role that can reach Create Order (Manager
// or Administrator) can read/add here.
router.get("/site-contacts", async (req, res) => {
  const { customer_id, site_id } = req.query;
  if (!customer_id || !site_id) return res.json([]);
  const { rows } = await query(
    `SELECT id, contact_name, phone_number, role_label
     FROM site_contacts
     WHERE customer_id = $1 AND site_id = $2 AND is_active
     ORDER BY contact_name`,
    [customer_id, site_id]
  );
  res.json(rows);
});

// Saves a newly-typed contact so the next order for the same customer+site
// already has it on file — called from Create Order right when the order is
// submitted, not as a separate data-entry step. Silently reuses an existing
// row with the same phone number for this customer+site instead of creating
// a duplicate (e.g. the same contact typed slightly differently by name).
router.post("/site-contacts", async (req, res) => {
  const { customer_id, site_id, contact_name, phone_number, role_label } = req.body;
  if (!customer_id || !site_id || !phone_number) {
    return res.status(400).json({ error: "Customer, site, and phone number are required." });
  }
  const { rows: existing } = await query(
    `SELECT id FROM site_contacts WHERE customer_id = $1 AND site_id = $2 AND phone_number = $3`,
    [customer_id, site_id, phone_number]
  );
  if (existing.length) {
    if (contact_name) {
      await query(`UPDATE site_contacts SET contact_name = $1 WHERE id = $2`, [contact_name, existing[0].id]);
    }
    return res.json({ id: existing[0].id, reused: true });
  }
  const { rows } = await query(
    `INSERT INTO site_contacts (customer_id, site_id, contact_name, phone_number, role_label)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, contact_name, phone_number, role_label`,
    [customer_id, site_id, contact_name || "Site contact", phone_number, role_label || null]
  );
  res.status(201).json(rows[0]);
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

// Round 118 — lets Create Order show an informational note about which mix
// design a customer+grade will actually resolve to, before the order is even
// submitted (same resolution logic as orders.js's own INSERT). Returns
// nothing (design: null) rather than an error when no design is on file yet
// for this grade — that's the normal, unremarkable case for most grades
// today, not a problem to surface.
router.get("/resolve-mix-design", async (req, res) => {
  const { customer_id, mix_grade_id } = req.query;
  if (!customer_id || !mix_grade_id) return res.json({ design: null });
  const { rows } = await query(
    `SELECT md.id, md.design_ref_code,
            (a.id IS NOT NULL) AS is_customer_specific
     FROM mix_designs md
     LEFT JOIN mix_design_assignments a ON a.mix_design_id = md.id AND a.customer_id = $1 AND a.mix_grade_id = $2
     WHERE md.id = COALESCE(
       (SELECT mix_design_id FROM mix_design_assignments WHERE customer_id = $1 AND mix_grade_id = $2),
       (SELECT id FROM mix_designs WHERE mix_grade_id = $2 AND is_standard_for_grade = true AND status = 'approved')
     )`,
    [customer_id, mix_grade_id]
  );
  res.json({ design: rows[0] || null });
});

router.get("/trucks", async (req, res) => {
  // Round 98, item 10 sub-requirement 3 — a truck currently away at an
  // external workshop (external_repairs.status = 'sent_out') can't be
  // selected for a new delivery ticket. Only Plant Operator's ticket-
  // creation truck picker passes this flag; every other caller of this
  // endpoint (reports, filters, fuel logging) still sees the full active
  // fleet, since a truck away for repair may still legitimately need those.
  const excludeInRepair = req.query.exclude_in_repair === "true";
  const { rows } = await query(
    excludeInRepair
      ? `SELECT id, truck_number FROM trucks
         WHERE is_active AND id NOT IN (SELECT truck_id FROM external_repairs WHERE status = 'sent_out')
         ORDER BY truck_number`
      : "SELECT id, truck_number FROM trucks WHERE is_active ORDER BY truck_number"
  );
  res.json(rows);
});

router.get("/maintenance-action-points", async (req, res) => {
  const { rows } = await query(
    "SELECT id, name, interval_days, interval_hours FROM maintenance_action_points WHERE is_active ORDER BY name"
  );
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

// Round 119, post-ship again — lets Administrator/Manager pick a specific
// QC Engineer per order (customer_orders.assigned_qc_engineer_id) rather
// than the app always resolving "the" QC Engineer by role, which broke down
// once there was more than one on staff. See MasterDataPanels.jsx's
// OrdersPanel and customerPortal.js's resolveOrderContacts.
router.get("/qc-engineers", async (req, res) => {
  const { rows } = await query("SELECT id, name FROM users WHERE role = 'qc_engineer' AND is_active ORDER BY name");
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
  const { rows } = await query("SELECT id, name, location, is_plant FROM fuel_stations WHERE is_active ORDER BY is_plant DESC, name");
  res.json(rows);
});

router.get("/equipment", async (req, res) => {
  const { rows } = await query("SELECT id, equipment_type, name FROM equipment WHERE is_active ORDER BY equipment_type, name");
  res.json(rows);
});

// Raw material stock — read-only here (Lab Technician edits via
// /lab-technician/raw-material-stock as of round 118; QC Engineer no longer
// has write access to this). Shown on Manager and Administrator dashboards,
// always reflecting whatever Lab Technician last saved until they update it
// again.
router.get("/raw-material-stock", async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.bin_name, s.unit, s.type_brand, s.stock_qty, s.qty_on_order, s.expected_delivery_date, s.updated_at, u.name AS updated_by_name
     FROM raw_material_stock s LEFT JOIN users u ON u.id = s.updated_by
     ORDER BY s.id`
  );
  res.json(rows);
});

export default router;
