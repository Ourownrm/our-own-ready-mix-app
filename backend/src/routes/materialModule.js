import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole, isAdminLevel } from "../middleware/auth.js";
// Round 146 — every route below now carries BOTH its original requireRole and
// a requirePermission. A request must satisfy both, so granting somebody a
// permission can never let them past a role guard: this can only tighten
// access, never loosen it.
import { requirePermission, can } from "../lib/permissions.js";
import { pushToRole, pushToUser } from "../lib/push.js";
import { istDay, istMonth, istDaysAgo, daysElapsedIn } from "../lib/istDate.js";

// Round 139 — Material Module: Store's raw-material purchase -> receive ->
// consume -> physical-count workflow (cement, aggregates, admixtures, etc.).
// See claude/raw-material-module-notes.md (project docs) for the full
// requirements history and claude/oorm-app-state.md for what's confirmed.
//
// Deliberately a SEPARATE system from the pre-existing raw_material_stock
// table (routes/masterData.js GET /raw-material-stock, routes/labTechnician.js
// PUT /raw-material-stock) — that's a simple 9-bin manual snapshot Lab
// Technician updates, shown read-only on Manager/Administrator dashboards,
// and is left completely untouched by this file. Every table here is
// prefixed rm_ so the two can never collide; mounted at /api/material-module
// (not /api/raw-material...) for the same reason, at the code level too.
//
// Current access scope (per the notes doc's stated default — no Manager
// access yet; cheap to extend later by adding "manager" to the role arrays
// below): Administrator (masters, approvals, valuation, reports),
// Store (orders, receipts, stock qty, physical stock entry),
// Plant Operator (daily consumption + production entry).
const router = Router();
router.use(requireAuth);

const ADMIN = ["administrator"];
const MATERIALS_READ_ROLES = ["administrator", "store", "plant_operator"];
const ORDER_ROLES = ["administrator", "store"];
const CONSUMPTION_ROLES = ["administrator", "plant_operator"];
const STOCK_READ_ROLES = ["administrator", "store", "plant_operator"];

// Round 142 — the mix-design ingredients a material may be mapped to. Kept
// as a plain allow-list rather than a DB enum so adding one later is a code
// change only; MIX_COMPONENT_COLUMN (further down) maps each to where the
// per-m3 figure actually lives on a mix design.
const MIX_COMPONENTS = new Set(["cement", "fly_ash", "fine_agg", "coarse_20mm", "coarse_12_5mm", "admixture"]);

function isStore(req) {
  return req.user.role === "store";
}

// ===================== Materials master =====================

router.get("/materials", requireRole(...MATERIALS_READ_ROLES), requirePermission("material.materials", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM rm_materials WHERE is_active OR $1 ORDER BY category, name`,
    [isAdminLevel(req.user.role)]
  );
  // Store never sees valuation — enforced here, not just left out of the UI.
  const sanitized = isStore(req) ? rows.map(({ opening_stock_rate_per_kg, ...rest }) => rest) : rows;
  res.json(sanitized);
});

router.post("/materials", requireRole(...ADMIN), requirePermission("material.materials", "create"), async (req, res) => {
  const { name, category, sub_category, mix_component, purchase_unit, kg_per_purchase_unit, tolerance_pct, reorder_level_kg, opening_stock_kg, opening_stock_rate_per_kg } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Material name is required." });
  if (!purchase_unit || !purchase_unit.trim()) return res.status(400).json({ error: "Purchase unit is required (e.g. CFT, Bag, MT)." });
  if (!kg_per_purchase_unit || Number(kg_per_purchase_unit) <= 0) return res.status(400).json({ error: "Enter the conversion to kg per purchase unit." });

  const { rows } = await query(
    `INSERT INTO rm_materials
       (name, category, sub_category, mix_component, purchase_unit, kg_per_purchase_unit, tolerance_pct, reorder_level_kg, opening_stock_kg, opening_stock_rate_per_kg, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [name.trim(), category || null, sub_category || null, MIX_COMPONENTS.has(mix_component) ? mix_component : null,
      purchase_unit.trim(), kg_per_purchase_unit,
      tolerance_pct || null, reorder_level_kg || null, opening_stock_kg || 0, opening_stock_rate_per_kg || null, req.user.id]
  );
  // Seed the material's first purchase unit from what was just entered, so
  // the Units panel (item 4) always has at least the default unit on it —
  // not a second source of truth, purely the reference/management view over
  // the same purchase_unit/kg_per_purchase_unit columns above.
  await query(
    `INSERT INTO rm_material_units (material_id, unit_name, kg_per_unit, is_default) VALUES ($1,$2,$3,true)`,
    [rows[0].id, purchase_unit.trim(), kg_per_purchase_unit]
  );
  res.status(201).json(rows[0]);
});

// ===================== Purchase units per material (item 4, round 140) =====================
// rm_materials.purchase_unit/kg_per_purchase_unit stay the single live
// conversion everything else (orders/receipts/consumption/stock) reads —
// resolved live at receipt time, per the mockup's own "changing a conversion
// affects future receipts only; past receipts keep the value used at the
// time" rule. Marking a unit here default writes through to those two
// columns; this table is the reference/management layer on top.
router.get("/materials/:id/units", requireRole(...MATERIALS_READ_ROLES), requirePermission("material.units", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM rm_material_units WHERE material_id = $1 AND (is_active OR $2) ORDER BY is_default DESC, unit_name`,
    [req.params.id, isAdminLevel(req.user.role)]
  );
  res.json(rows);
});

router.post("/materials/:id/units", requireRole(...ADMIN), requirePermission("material.units", "create"), async (req, res) => {
  const { unit_name, kg_per_unit, is_default } = req.body;
  if (!unit_name || !unit_name.trim()) return res.status(400).json({ error: "Enter a unit name (e.g. CFT, Brass, MT)." });
  if (!kg_per_unit || Number(kg_per_unit) <= 0) return res.status(400).json({ error: "Enter the conversion to kg for this unit." });

  const { rows: material } = await query(`SELECT id FROM rm_materials WHERE id = $1`, [req.params.id]);
  if (!material.length) return res.status(404).json({ error: "Material not found." });

  if (is_default) {
    await query(`UPDATE rm_material_units SET is_default = false WHERE material_id = $1`, [req.params.id]);
  }
  const { rows } = await query(
    `INSERT INTO rm_material_units (material_id, unit_name, kg_per_unit, is_default) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, unit_name.trim(), kg_per_unit, !!is_default]
  );
  if (is_default) {
    await query(`UPDATE rm_materials SET purchase_unit = $1, kg_per_purchase_unit = $2 WHERE id = $3`, [unit_name.trim(), kg_per_unit, req.params.id]);
  }
  res.status(201).json(rows[0]);
});

router.patch("/materials/:id/units/:unitId", requireRole(...ADMIN), requirePermission("material.units", "edit"), async (req, res) => {
  const { unit_name, kg_per_unit, is_default, is_active } = req.body;
  const { rows: existing } = await query(`SELECT * FROM rm_material_units WHERE id = $1 AND material_id = $2`, [req.params.unitId, req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Unit not found." });

  const sets = [];
  const params = [];
  if (unit_name !== undefined) {
    if (!unit_name.trim()) return res.status(400).json({ error: "Unit name can't be blank." });
    params.push(unit_name.trim()); sets.push(`unit_name = $${params.length}`);
  }
  if (kg_per_unit !== undefined) {
    if (!kg_per_unit || Number(kg_per_unit) <= 0) return res.status(400).json({ error: "Enter a valid kg conversion." });
    params.push(kg_per_unit); sets.push(`kg_per_unit = $${params.length}`);
  }
  if (is_default !== undefined) { params.push(!!is_default); sets.push(`is_default = $${params.length}`); }
  if (is_active !== undefined) { params.push(!!is_active); sets.push(`is_active = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });

  if (is_default) {
    await query(`UPDATE rm_material_units SET is_default = false WHERE material_id = $1 AND id != $2`, [req.params.id, req.params.unitId]);
  }
  params.push(req.params.unitId);
  const { rows } = await query(`UPDATE rm_material_units SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);

  if (is_default || (existing[0].is_default && (unit_name !== undefined || kg_per_unit !== undefined))) {
    await query(`UPDATE rm_materials SET purchase_unit = $1, kg_per_purchase_unit = $2 WHERE id = $3`, [rows[0].unit_name, rows[0].kg_per_unit, req.params.id]);
  }
  res.json(rows[0]);
});

router.delete("/materials/:id/units/:unitId", requireRole(...ADMIN), requirePermission("material.units", "delete"), async (req, res) => {
  const { rows: existing } = await query(`SELECT * FROM rm_material_units WHERE id = $1 AND material_id = $2`, [req.params.unitId, req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Unit not found." });
  if (existing[0].is_default) return res.status(400).json({ error: "Can't delete the default unit — mark a different unit default first." });
  await query(`DELETE FROM rm_material_units WHERE id = $1`, [req.params.unitId]);
  res.json({ deleted: true });
});

// Numeric columns that are allowed to be genuinely empty (nullable in
// schema.sql) — a blank form field for these becomes NULL. kg_per_purchase_unit
// and opening_stock_kg are NOT NULL, so a blank there is a validation error,
// not a silent NULL. Without this normalization, an empty string was forwarded
// straight to Postgres and crashed with "invalid input syntax for type
// numeric: \"\"", surfaced to the user only as the generic "Something went
// wrong" (this file's item 1 fix, round 140).
const MATERIAL_NULLABLE_NUMERIC_FIELDS = new Set(["tolerance_pct", "reorder_level_kg", "opening_stock_rate_per_kg"]);
const MATERIAL_REQUIRED_NUMERIC_FIELDS = new Set(["kg_per_purchase_unit", "opening_stock_kg"]);

router.patch("/materials/:id", requireRole(...ADMIN), requirePermission("material.materials", "edit"), async (req, res) => {
  const fields = ["name", "category", "sub_category", "mix_component", "purchase_unit", "kg_per_purchase_unit", "tolerance_pct", "reorder_level_kg", "opening_stock_kg", "opening_stock_rate_per_kg", "is_active"];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let value = req.body[f];
    // Only the five design columns plus admixture are real components; the
    // blank option (and anything unrecognised) is stored as NULL rather than
    // an empty string, so the report's own "is this mapped?" test has one
    // answer, not two.
    if (f === "mix_component") value = MIX_COMPONENTS.has(value) ? value : null;
    if (typeof value === "string" && value.trim() === "") {
      if (MATERIAL_REQUIRED_NUMERIC_FIELDS.has(f)) {
        return res.status(400).json({ error: `${f === "kg_per_purchase_unit" ? "Kg per purchase unit" : "Opening stock"} can't be left blank.` });
      }
      if (MATERIAL_NULLABLE_NUMERIC_FIELDS.has(f)) value = null;
    }
    params.push(value);
    sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  params.push(req.params.id);
  const { rows } = await query(`UPDATE rm_materials SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows.length) return res.status(404).json({ error: "Material not found." });
  res.json(rows[0]);
});

// ===================== Suppliers, rates & transporters master =====================

router.get("/suppliers", requireRole(...ORDER_ROLES), requirePermission("material.suppliers", "view"), async (req, res) => {
  const { rows } = await query(`SELECT * FROM rm_suppliers WHERE is_active OR $1 ORDER BY name`, [isAdminLevel(req.user.role)]);
  res.json(rows);
});

router.post("/suppliers", requireRole(...ADMIN), requirePermission("material.suppliers", "create"), async (req, res) => {
  const { name, contact_person, phone, address, gstin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Supplier name is required." });
  const { rows } = await query(
    `INSERT INTO rm_suppliers (name, contact_person, phone, address, gstin, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name.trim(), contact_person || null, phone || null, address || null, gstin || null, req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.patch("/suppliers/:id", requireRole(...ADMIN), requirePermission("material.suppliers", "edit"), async (req, res) => {
  const fields = ["name", "contact_person", "phone", "address", "gstin", "is_active"];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  params.push(req.params.id);
  const { rows } = await query(`UPDATE rm_suppliers SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows.length) return res.status(404).json({ error: "Supplier not found." });
  res.json(rows[0]);
});

// A supplier may quote a material at both scopes (delivered / ex-factory),
// one CURRENT rate per scope — see schema.sql's comment on rm_supplier_rates.
// Round 140, item 2: rates are effective-dated, so this only returns each
// combination's still-open row (valid_to IS NULL) — the "as of right now"
// rate card. Full history is GET .../rates/history below.
router.get("/suppliers/:supplierId/rates", requireRole(...ORDER_ROLES), requirePermission("material.supplier-rates", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT sr.*, m.name AS material_name, m.purchase_unit
     FROM rm_supplier_rates sr JOIN rm_materials m ON m.id = sr.material_id
     WHERE sr.supplier_id = $1 AND sr.is_active AND sr.valid_to IS NULL
     ORDER BY m.name, sr.scope`,
    [req.params.supplierId]
  );
  res.json(rows);
});

// Full effective-dated history for this supplier (every material/scope),
// oldest first within each combination — feeds the mockup's "Rate history"
// button (item 2).
router.get("/suppliers/:supplierId/rates/history", requireRole(...ORDER_ROLES), requirePermission("material.supplier-rates", "view"), async (req, res) => {
  const params = [req.params.supplierId];
  let where = "sr.supplier_id = $1";
  if (req.query.material_id) { params.push(req.query.material_id); where += ` AND sr.material_id = $${params.length}`; }
  const { rows } = await query(
    `SELECT sr.*, m.name AS material_name, m.purchase_unit, u.name AS updated_by_name
     FROM rm_supplier_rates sr
     JOIN rm_materials m ON m.id = sr.material_id
     LEFT JOIN users u ON u.id = sr.updated_by
     WHERE ${where}
     ORDER BY m.name, sr.scope, sr.valid_from`,
    params
  );
  res.json(rows);
});

// Setting a new rate closes whatever row was current (valid_to = the day
// before this one starts) and inserts a fresh row — never overwrites a past
// rate in place, so history stays intact and a "Rate history" view has
// something real to show (item 2). Orders still snapshot rm_orders.rate at
// order time, same as round 139 — nothing downstream needs to change.
router.post("/suppliers/:supplierId/rates", requireRole(...ADMIN), requirePermission("material.supplier-rates", "create"), async (req, res) => {
  const { material_id, scope, rate, valid_from } = req.body;
  if (!material_id) return res.status(400).json({ error: "Select a material." });
  if (!["delivered", "ex_factory"].includes(scope)) return res.status(400).json({ error: "Scope must be delivered or ex_factory." });
  if (!rate || Number(rate) <= 0) return res.status(400).json({ error: "Enter a valid rate." });

  const effectiveFrom = valid_from || istDay();
  const { rows } = await query(
    `UPDATE rm_supplier_rates SET valid_to = $1::date - INTERVAL '1 day'
     WHERE supplier_id = $2 AND material_id = $3 AND scope = $4 AND valid_to IS NULL
     RETURNING id`,
    [effectiveFrom, req.params.supplierId, material_id, scope]
  );
  // No-op if this exact rate already IS the current one — avoids a
  // zero-day-long history row when the admin just re-saves the same rate.
  if (rows.length) {
    const { rows: closed } = await query(`SELECT rate FROM rm_supplier_rates WHERE id = $1`, [rows[0].id]);
    if (Number(closed[0].rate) === Number(rate)) {
      await query(`UPDATE rm_supplier_rates SET valid_to = NULL WHERE id = $1`, [rows[0].id]);
      const { rows: unchanged } = await query(`SELECT sr.*, m.name AS material_name, m.purchase_unit FROM rm_supplier_rates sr JOIN rm_materials m ON m.id = sr.material_id WHERE sr.id = $1`, [rows[0].id]);
      return res.status(200).json(unchanged[0]);
    }
  }

  const { rows: created } = await query(
    `INSERT INTO rm_supplier_rates (supplier_id, material_id, scope, rate, valid_from, valid_to, is_active, updated_by)
     VALUES ($1,$2,$3,$4,$5,NULL,true,$6) RETURNING *`,
    [req.params.supplierId, material_id, scope, rate, effectiveFrom, req.user.id]
  );
  res.status(201).json(created[0]);
});

router.get("/transporters", requireRole(...ORDER_ROLES), requirePermission("material.transporters", "view"), async (req, res) => {
  const { rows } = await query(`SELECT * FROM rm_transporters WHERE is_active OR $1 ORDER BY name`, [isAdminLevel(req.user.role)]);
  res.json(rows);
});

router.post("/transporters", requireRole(...ADMIN), requirePermission("material.transporters", "create"), async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Transporter name is required." });
  const { rows } = await query(`INSERT INTO rm_transporters (name, phone) VALUES ($1,$2) RETURNING *`, [name.trim(), phone || null]);
  res.status(201).json(rows[0]);
});

router.patch("/transporters/:id", requireRole(...ADMIN), requirePermission("material.transporters", "edit"), async (req, res) => {
  const { name, phone, is_active } = req.body;
  const sets = [];
  const params = [];
  if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
  if (phone !== undefined) { params.push(phone); sets.push(`phone = $${params.length}`); }
  if (is_active !== undefined) { params.push(is_active); sets.push(`is_active = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  params.push(req.params.id);
  const { rows } = await query(`UPDATE rm_transporters SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows.length) return res.status(404).json({ error: "Transporter not found." });
  res.json(rows[0]);
});

// Ex-factory material -> several transporters on file for one supplier, one
// marked default. Both order and receipt can pick any of these (or the
// default is pre-selected).
router.get("/suppliers/:supplierId/transporters", requireRole(...ORDER_ROLES), requirePermission("material.transporters", "view"), async (req, res) => {
  const { material_id } = req.query;
  const params = [req.params.supplierId];
  let where = "st.supplier_id = $1 AND st.is_active";
  if (material_id) { params.push(material_id); where += ` AND st.material_id = $${params.length}`; }
  const { rows } = await query(
    `SELECT st.*, t.name AS transporter_name, t.phone AS transporter_phone
     FROM rm_supplier_transporters st JOIN rm_transporters t ON t.id = st.transporter_id
     WHERE ${where}
     ORDER BY st.is_default DESC, t.name`,
    params
  );
  res.json(rows);
});

router.post("/suppliers/:supplierId/transporters", requireRole(...ADMIN), requirePermission("material.transporters", "create"), async (req, res) => {
  const { material_id, transporter_id, freight_rate, freight_basis, is_default } = req.body;
  if (!material_id || !transporter_id) return res.status(400).json({ error: "Select a material and a transporter." });
  if (!freight_rate || Number(freight_rate) < 0) return res.status(400).json({ error: "Enter a valid freight rate." });

  if (is_default) {
    await query(
      `UPDATE rm_supplier_transporters SET is_default = false WHERE supplier_id = $1 AND material_id = $2`,
      [req.params.supplierId, material_id]
    );
  }
  const { rows } = await query(
    `INSERT INTO rm_supplier_transporters (supplier_id, material_id, transporter_id, freight_rate, freight_basis, is_default)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (supplier_id, material_id, transporter_id)
     DO UPDATE SET freight_rate = EXCLUDED.freight_rate, freight_basis = EXCLUDED.freight_basis, is_default = EXCLUDED.is_default, is_active = true
     RETURNING *`,
    [req.params.supplierId, material_id, transporter_id, freight_rate, freight_basis || "per_purchase_unit", !!is_default]
  );
  res.status(201).json(rows[0]);
});

// ===================== Orders (Store prepares, Administrator approves) =====================
// Confirmed decision (reversed twice during planning — see the notes doc):
// an order cannot be received against until Administrator approves it.

router.post("/orders", requireRole(...ORDER_ROLES), requirePermission("material.orders", "create"), async (req, res) => {
  const { material_id, supplier_id, scope, transporter_id, ordered_qty, rate, freight_rate, freight_basis, tax_pct, gst_treatment, notes } = req.body;
  if (!material_id || !supplier_id) return res.status(400).json({ error: "Select a material and a supplier." });
  if (!["delivered", "ex_factory"].includes(scope)) return res.status(400).json({ error: "Scope must be delivered or ex_factory." });
  if (scope === "ex_factory" && !transporter_id) return res.status(400).json({ error: "Select a transporter for an ex-factory order." });
  if (!ordered_qty || Number(ordered_qty) <= 0) return res.status(400).json({ error: "Enter the quantity to order." });
  if (!rate || Number(rate) <= 0) return res.status(400).json({ error: "Enter the rate." });

  const { rows } = await query(
    `INSERT INTO rm_orders
       (material_id, supplier_id, scope, transporter_id, ordered_qty, rate, freight_rate, freight_basis, tax_pct, gst_treatment, requested_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [material_id, supplier_id, scope, transporter_id || null, ordered_qty, rate, freight_rate || null,
      freight_basis || null, tax_pct || 0, gst_treatment || "excluded", req.user.id, notes || null]
  );

  const { rows: m } = await query(`SELECT name FROM rm_materials WHERE id = $1`, [material_id]);
  await pushToRole("administrator", {
    title: "New material order for approval",
    body: `${req.user.name} requested ${ordered_qty} of ${m[0]?.name || "a material"}`,
    url: "/material-module?tab=orders",
  });

  res.status(201).json(rows[0]);
});

const ORDER_LIST_COLUMNS = `
  o.*, m.name AS material_name, m.purchase_unit, m.kg_per_purchase_unit,
  s.name AS supplier_name, t.name AS transporter_name,
  ru.name AS requested_by_name, au.name AS approved_by_name,
  COALESCE(recv.received_qty, 0) AS received_qty
`;
const ORDER_LIST_FROM = `
  FROM rm_orders o
  JOIN rm_materials m ON m.id = o.material_id
  JOIN rm_suppliers s ON s.id = o.supplier_id
  LEFT JOIN rm_transporters t ON t.id = o.transporter_id
  JOIN users ru ON ru.id = o.requested_by
  LEFT JOIN users au ON au.id = o.approved_by
  LEFT JOIN LATERAL (
    SELECT SUM(r.accepted_qty) AS received_qty FROM rm_receipts_effective r WHERE r.order_id = o.id
  ) recv ON true
`;

router.get("/orders/mine", requireRole(...ORDER_ROLES), requirePermission("material.orders", "view"), async (req, res) => {
  const params = [req.user.id];
  let where = "o.requested_by = $1";
  if (isAdminLevel(req.user.role)) { where = "true"; params.length = 0; }
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM} WHERE ${where} ORDER BY o.requested_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

// Orders Store can currently receive against — approved, with something
// still outstanding. Used to populate the Receipts tab's order picker.
router.get("/orders/receivable", requireRole(...ORDER_ROLES), requirePermission("material.orders", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM}
     WHERE o.status = 'approved' AND COALESCE(recv.received_qty, 0) < o.ordered_qty
     ORDER BY o.approved_at DESC`
  );
  res.json(rows);
});

router.get("/orders/pending", requireRole(...ADMIN), requirePermission("material.order-approve", "edit"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM} WHERE o.status = 'pending_approval' ORDER BY o.requested_at`
  );
  res.json(rows);
});

router.post("/orders/:id/approve", requireRole(...ADMIN), requirePermission("material.order-approve", "edit"), async (req, res) => {
  const { rows: existing } = await query(`SELECT * FROM rm_orders WHERE id = $1 AND status = 'pending_approval'`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Order not found or already actioned." });
  const { rows } = await query(
    `UPDATE rm_orders SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Material order approved", body: "Your order is approved and ready to receive.", url: "/material-module?tab=orders" });
  res.json(rows[0]);
});

router.post("/orders/:id/reject", requireRole(...ADMIN), requirePermission("material.order-approve", "edit"), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "Give a reason for rejecting this." });
  const { rows: existing } = await query(`SELECT * FROM rm_orders WHERE id = $1 AND status = 'pending_approval'`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Order not found or already actioned." });
  const { rows } = await query(
    `UPDATE rm_orders SET status = 'rejected', rejected_reason = $1, approved_by = $2, approved_at = now() WHERE id = $3 RETURNING *`,
    [reason, req.user.id, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Material order rejected", body: reason, url: "/material-module?tab=orders" });
  res.json(rows[0]);
});

// Close (item 7, round 140) — a terminal state Administrator sets by hand
// when an order should stop accepting receipts even though it's not fully
// received (rate/supply conditions changed, a replacement order was placed
// instead). Distinct from reject (never approved to begin with).
router.post("/orders/:id/close", requireRole(...ADMIN), requirePermission("material.orders", "delete"), async (req, res) => {
  const { reason } = req.body;
  const { rows: existing } = await query(`SELECT * FROM rm_orders WHERE id = $1`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Order not found." });
  if (["rejected", "closed"].includes(existing[0].status)) return res.status(400).json({ error: "This order is already closed or rejected." });
  const { rows } = await query(
    `UPDATE rm_orders SET status = 'closed', closed_by = $1, closed_at = now(), closed_reason = $2 WHERE id = $3 RETURNING *`,
    [req.user.id, reason || null, req.params.id]
  );
  res.json(rows[0]);
});

// Revise (item 7) — rate/freight/tax/qty changed after approval, before the
// order is closed or rejected. Never touches receipts already recorded
// against this order: each one's landed_rate_per_kg was already computed and
// stored at receipt time (round 139's immutability rule) — only receipts
// taken AFTER the revision see the new rate.
router.patch("/orders/:id", requireRole(...ADMIN), requirePermission("material.orders", "edit"), async (req, res) => {
  const { rows: existing } = await query(`SELECT * FROM rm_orders WHERE id = $1`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Order not found." });
  if (["rejected", "closed"].includes(existing[0].status)) {
    return res.status(400).json({ error: "This order is closed or rejected and can't be revised — place a new order instead." });
  }

  const REQUIRED_NUMERIC = new Set(["ordered_qty", "rate"]);
  const NULLABLE_NUMERIC = new Set(["freight_rate", "tax_pct"]);
  const fields = ["ordered_qty", "rate", "freight_rate", "freight_basis", "tax_pct", "gst_treatment", "notes"];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let value = req.body[f];
    if (typeof value === "string" && value.trim() === "") {
      if (REQUIRED_NUMERIC.has(f)) return res.status(400).json({ error: `Enter a valid ${f === "ordered_qty" ? "quantity" : "rate"}.` });
      if (NULLABLE_NUMERIC.has(f)) value = null;
    }
    if (REQUIRED_NUMERIC.has(f) && Number(value) <= 0) return res.status(400).json({ error: `Enter a valid ${f === "ordered_qty" ? "quantity" : "rate"}.` });
    params.push(value);
    sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to revise." });
  params.push(req.user.id);
  sets.push(`revised_by = $${params.length}`);
  sets.push(`revised_at = now()`);
  params.push(req.params.id);
  const { rows } = await query(`UPDATE rm_orders SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
  res.json(rows[0]);
});

// ===================== Receipts (Store receives against an approved order) =====================
// Weighbridge weight is a manual entry for now (see claude/weighbridge-
// integration-notes.md — the sync is a later phase); accepted_qty defaults
// to it but Store can override. landed_rate_per_kg is computed once, here,
// and stored — so a later change to the order's rate/freight master never
// silently rewrites history.
function computeFreightTotal(freight_rate, freight_basis, accepted_qty, accepted_qty_kg) {
  if (!freight_rate) return 0;
  if (freight_basis === "per_kg") return Number(freight_rate) * Number(accepted_qty_kg);
  if (freight_basis === "per_trip") return Number(freight_rate);
  return Number(freight_rate) * Number(accepted_qty); // per_purchase_unit, the default
}

// ROUND 156 — the weighbridge tickets this order could be receiving against.
//
// Matched only, and only ones no receipt has claimed. Matching is on the
// order's OWN material and supplier, so Store is never offered a load of fly
// ash against a 20 MM order — the pairing is the point, and it is also what
// makes the supplier-scoped material mapping matter: without it every fly ash
// would resolve to the same record and this list would offer the wrong loads.
//
// Not date-limited to today. A lorry weighed at 11pm and receipted the next
// morning is ordinary, and the count is small because claimed tickets drop out.
router.get("/orders/:id/weighbridge-tickets", requireRole(...ORDER_ROLES), requirePermission("material.receipts", "create"), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: "Invalid order id." });
  try {
    const { rows } = await query(
      `SELECT wb.ticket_number, wb.weighed_at, wb.net_weight_kg, wb.empty_weight_kg, wb.loaded_weight_kg,
              wb.raw_vehicle, wb.challan_number, wb.purpose,
              COALESCE(v.registration, wb.raw_vehicle) AS vehicle_registration,
              m.kg_per_purchase_unit,
              -- Offered in the order's own purchase unit, because that is what
              -- Store types into the accepted-quantity box. Doing it here keeps
              -- the conversion in one place rather than in the screen.
              ROUND((wb.net_weight_kg / NULLIF(m.kg_per_purchase_unit, 0))::numeric, 2) AS net_purchase_units
       FROM weighbridge_tickets wb
       JOIN rm_orders o ON o.id = $1
       JOIN rm_materials m ON m.id = o.material_id
       LEFT JOIN weighbridge_vehicles v ON v.id = wb.vehicle_id
       LEFT JOIN rm_receipts r ON r.weighbridge_ticket_id = wb.ticket_number   -- receipts-raw: claim check must see pending receipts, or a ticket could be claimed twice
       WHERE wb.match_status = 'matched'
         AND r.id IS NULL
         AND wb.material_id = o.material_id
         AND wb.supplier_id IS NOT DISTINCT FROM o.supplier_id
         AND wb.net_weight_kg IS NOT NULL
       ORDER BY wb.weighed_at DESC NULLS LAST
       LIMIT 40`,
      [orderId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the weighbridge tickets for this order." });
  }
});

router.post("/receipts", requireRole(...ORDER_ROLES), requirePermission("material.receipts", "create"), async (req, res) => {
  const { order_id, supplier_qty, weighbridge_weight_kg, accepted_qty, transporter_id, freight_rate, freight_basis, vehicle_number, challan_number, debit_note_amount, notes, weighbridge_ticket_id, short_reason } = req.body;
  if (!order_id) return res.status(400).json({ error: "Select the order this receipt is against." });
  if (!supplier_qty || Number(supplier_qty) <= 0) return res.status(400).json({ error: "Enter the supplier's invoice/DC quantity." });

  const { rows: orders } = await query(
    `SELECT o.*, m.kg_per_purchase_unit, m.tolerance_pct
     FROM rm_orders o JOIN rm_materials m ON m.id = o.material_id
     WHERE o.id = $1 AND o.status = 'approved'`,
    [order_id]
  );
  if (!orders.length) return res.status(404).json({ error: "Order not found or not approved yet." });
  const order = orders[0];

  // accepted_qty defaults to the weighbridge weight converted to purchase
  // units when Store doesn't override it — the weighbridge figure is the
  // whole point of this comparison, so it's the default, not the fallback.
  let finalAcceptedQty = accepted_qty;
  // Round 158 — record WHERE the accepted figure came from, not just what it
  // was. The variance report is far more useful when it can say a quantity was
  // the weighbridge's own reading rather than something typed over the top.
  let acceptedBasis = "entered";
  if (finalAcceptedQty === undefined || finalAcceptedQty === null || finalAcceptedQty === "") {
    if (!weighbridge_weight_kg) return res.status(400).json({ error: "Enter the accepted quantity, or the weighbridge weight to derive it from." });
    finalAcceptedQty = Number(weighbridge_weight_kg) / Number(order.kg_per_purchase_unit);
    acceptedBasis = "weighed";
  }
  finalAcceptedQty = Number(finalAcceptedQty);
  if (finalAcceptedQty <= 0) return res.status(400).json({ error: "Accepted quantity must be greater than zero." });
  const acceptedQtyKg = finalAcceptedQty * Number(order.kg_per_purchase_unit);

  const useFreightRate = freight_rate !== undefined && freight_rate !== null && freight_rate !== "" ? freight_rate : order.freight_rate;
  const useFreightBasis = freight_basis || order.freight_basis;
  const freightTotal = computeFreightTotal(useFreightRate, useFreightBasis, finalAcceptedQty, acceptedQtyKg);
  const baseCost = finalAcceptedQty * Number(order.rate) + freightTotal;
  const taxAmount = order.gst_treatment === "included" ? baseCost * (Number(order.tax_pct) / 100) : 0;
  const landedRatePerKg = (baseCost + taxAmount) / acceptedQtyKg;

  const shortQty = Number(supplier_qty) - finalAcceptedQty;

  // ROUND 156 — a short load beyond tolerance needs a REASON, not a block.
  //
  // The lorry has arrived and the material is in the yard. Refusing to record
  // that would push Store into not recording it at all, or into fudging the
  // accepted quantity until the app stops complaining — both worse than a note.
  // But a shortfall outside the material's own tolerance should be a decision
  // somebody made rather than a number nobody looked at, so it has to carry
  // one sentence saying what happened.
  // ROUND 158 — the block is gone. A receipt ALWAYS saves.
  //
  // Round 156 refused this save until somebody typed a reason, and it was the
  // wrong instinct: the lorry has arrived and the material is in the yard.
  // Refusing to record that pushes Store into not recording it at all, or into
  // fudging the accepted figure until the app stops complaining — both worse
  // than an unexplained number.
  //
  // What takes its place is a DECISION rather than an obstacle. Within
  // tolerance the receipt posts straight away at the weighed figure, exactly as
  // before, and nobody is troubled. Beyond it, the receipt still saves but
  // posts as 'pending': it counts for nothing until a Manager says which of the
  // two quantities stands. That choice moves both stock and money, so it is not
  // Store's alone to make — but nor is it a reason to keep a lorry's load out
  // of the system while somebody goes looking for a manager.
  //
  // signed: positive means the supplier billed for more than we accepted. Note
  // deviationPct is computed on the ABSOLUTE difference, because an excess is
  // just as much a disagreement as a shortfall — Round 156 used the same
  // absolute value but then described every case as "short", which read as
  // nonsense ("-5.00 short") whenever the weighbridge came in heavy.
  const tolerancePct = order.tolerance_pct != null ? Number(order.tolerance_pct) : null;
  const varianceQty = shortQty;
  const deviationPct = Number(supplier_qty) > 0 ? Math.abs(varianceQty) / Number(supplier_qty) * 100 : 0;
  const toleranceExceeded = tolerancePct != null && deviationPct > tolerancePct;
  const needsConfirmation = toleranceExceeded;
  const confirmationStatus = needsConfirmation ? "pending" : "auto";
  // Stored SIGNED, while the tolerance test above uses the absolute value.
  // The direction is the informative part — a supplier always short is a
  // different problem from one that scatters — and the report takes abs()
  // where it wants magnitude. The back-fill in setup.js stores it signed too;
  // they must agree or the report mixes two conventions in one column.
  const variancePct = Number(supplier_qty) > 0
    ? Number((varianceQty / Number(supplier_qty) * 100).toFixed(3)) : 0;

  // ROUND 156 — the weighbridge ticket this receipt was weighed on.
  //
  // Checked rather than trusted: a ticket that is still in review has no
  // reliable material or supplier behind it, and a ticket another receipt has
  // already claimed would double-credit the same load into stock. Both are
  // easy to do by accident from a stale screen.
  let ticketId = null;
  if (weighbridge_ticket_id !== undefined && weighbridge_ticket_id !== null && weighbridge_ticket_id !== "") {
    ticketId = Number(weighbridge_ticket_id);
    if (!Number.isInteger(ticketId)) return res.status(400).json({ error: "Invalid weighbridge ticket." });
    const { rows: tk } = await query(
      `SELECT wb.ticket_number, wb.match_status::text AS match_status, r.id AS claimed_by
       FROM weighbridge_tickets wb
       LEFT JOIN rm_receipts r ON r.weighbridge_ticket_id = wb.ticket_number   -- receipts-raw: claim check must see pending receipts, or a ticket could be claimed twice
       WHERE wb.ticket_number = $1`,
      [ticketId]
    );
    if (!tk.length) return res.status(400).json({ error: "That weighbridge ticket does not exist." });
    if (tk[0].claimed_by) {
      return res.status(400).json({ error: `Weighbridge ticket #${ticketId} is already on receipt #${tk[0].claimed_by}.` });
    }
    if (tk[0].match_status !== "matched") {
      return res.status(400).json({ error: `Weighbridge ticket #${ticketId} is still in review — resolve its names first.` });
    }
  }

  const { rows } = await query(
    `INSERT INTO rm_receipts   -- receipts-raw: the write itself
       (order_id, supplier_qty, weighbridge_weight_kg, accepted_qty, accepted_qty_kg, transporter_id,
        freight_rate, freight_basis, vehicle_number, challan_number, short_qty, debit_note_amount,
        landed_rate_per_kg, received_by, notes, weighbridge_ticket_id, short_reason,
        accepted_basis, variance_qty, variance_pct, confirmation_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [order_id, supplier_qty, weighbridge_weight_kg || null, finalAcceptedQty, acceptedQtyKg,
      transporter_id || order.transporter_id || null, useFreightRate || null, useFreightBasis || null,
      vehicle_number || null, challan_number || null, shortQty, debit_note_amount || null,
      landedRatePerKg, req.user.id, notes || null, ticketId, String(short_reason || "").trim() || null,
      acceptedBasis, varianceQty, variancePct, confirmationStatus]
  );

  res.status(201).json({
    ...rows[0],
    tolerance_exceeded: toleranceExceeded,
    // The screen needs to say what just happened, and the two outcomes are
    // genuinely different: one is filed, the other is waiting on somebody.
    pending_confirmation: needsConfirmation,
    message: needsConfirmation
      ? `Saved. The weighed quantity and the supplier's differ by ${deviationPct.toFixed(1)}% ` +
        `(tolerance ${tolerancePct}%), so this receipt is waiting for a Manager to confirm which ` +
        `figure stands. It does not affect stock until then.`
      : null,
  });
});

// Admin-only edit/delete for a wrong receipt entry (item 6, round 140). Book
// stock and the weighted-average rate are both computed LIVE from
// rm_receipts on every read (round 139's architecture), so editing or
// deleting a receipt needs no separate stock/rate repair — the next read
// simply reflects the corrected data.
router.patch("/receipts/:id", requireRole(...ADMIN), requirePermission("material.receipts", "edit"), async (req, res) => {
  const { rows: existingRows } = await query(
    `SELECT r.*, o.rate AS order_rate, o.gst_treatment, o.tax_pct
     FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id   -- receipts-raw: editing a receipt must be able to load a pending one
     WHERE r.id = $1`,
    [req.params.id]
  );
  if (!existingRows.length) return res.status(404).json({ error: "Receipt not found." });
  const existing = existingRows[0];

  const fields = ["supplier_qty", "weighbridge_weight_kg", "accepted_qty", "transporter_id", "freight_rate", "freight_basis", "vehicle_number", "challan_number", "debit_note_amount", "notes"];
  const merged = {};
  for (const f of fields) {
    if (req.body[f] === undefined) { merged[f] = existing[f]; continue; }
    // A blank string means "clear this field" for the optional ones; for
    // supplier_qty/accepted_qty it becomes 0, which the required-field checks
    // below reject with a clear message — same "" -> crash bug class as item 1.
    merged[f] = (typeof req.body[f] === "string" && req.body[f].trim() === "") ? null : req.body[f];
  }

  const supplierQty = Number(merged.supplier_qty);
  if (!supplierQty || supplierQty <= 0) return res.status(400).json({ error: "Enter the supplier's invoice/DC quantity." });
  const acceptedQty = Number(merged.accepted_qty);
  if (!acceptedQty || acceptedQty <= 0) return res.status(400).json({ error: "Accepted quantity must be greater than zero." });

  // Preserve the conversion factor the ORIGINAL receipt used (not today's
  // material default) — same "past receipts keep the value used at the
  // time" rule the receipt already followed when it was first recorded.
  const kgPerUnit = Number(existing.accepted_qty_kg) / Number(existing.accepted_qty);
  const acceptedQtyKg = acceptedQty * kgPerUnit;

  const freightTotal = computeFreightTotal(merged.freight_rate, merged.freight_basis, acceptedQty, acceptedQtyKg);
  const baseCost = acceptedQty * Number(existing.order_rate) + freightTotal;
  const taxAmount = existing.gst_treatment === "included" ? baseCost * (Number(existing.tax_pct) / 100) : 0;
  const landedRatePerKg = (baseCost + taxAmount) / acceptedQtyKg;
  const shortQty = supplierQty - acceptedQty;

  const { rows } = await query(
    `UPDATE rm_receipts SET   -- receipts-raw: the write itself
       supplier_qty = $1, weighbridge_weight_kg = $2, accepted_qty = $3, accepted_qty_kg = $4,
       transporter_id = $5, freight_rate = $6, freight_basis = $7, vehicle_number = $8, challan_number = $9,
       short_qty = $10, debit_note_amount = $11, landed_rate_per_kg = $12, notes = $13
     WHERE id = $14 RETURNING *`,
    [supplierQty, merged.weighbridge_weight_kg || null, acceptedQty, acceptedQtyKg,
      merged.transporter_id || null, merged.freight_rate || null, merged.freight_basis || null,
      merged.vehicle_number || null, merged.challan_number || null, shortQty,
      merged.debit_note_amount || null, landedRatePerKg, merged.notes || null, req.params.id]
  );
  res.json(rows[0]);
});

router.delete("/receipts/:id", requireRole(...ADMIN), requirePermission("material.receipts", "delete"), async (req, res) => {
  // receipts-raw: the write itself
  const { rows } = await query(`DELETE FROM rm_receipts WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Receipt not found." });
  res.json({ deleted: true });
});

router.get("/receipts", requireRole(...ORDER_ROLES), requirePermission("material.receipts", "view"), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.user.role === "store") {
    params.push(req.user.id);
    where = `o.requested_by = $${params.length}`;
  }
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_at >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_at < $${params.length}::date + INTERVAL '1 day'`; }
  if (req.query.material_id) { params.push(req.query.material_id); where += ` AND o.material_id = $${params.length}`; }
  if (req.query.supplier_id) { params.push(req.query.supplier_id); where += ` AND o.supplier_id = $${params.length}`; }

  const { rows } = await query(
    `SELECT r.*, o.material_id, o.supplier_id, m.name AS material_name, m.purchase_unit,
            s.name AS supplier_name, t.name AS transporter_name, ru.name AS received_by_name
     FROM rm_receipts r   -- receipts-raw: the receipts screen deliberately shows pending ones, flagged
     JOIN rm_orders o ON o.id = r.order_id
     JOIN rm_materials m ON m.id = o.material_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     LEFT JOIN rm_transporters t ON t.id = r.transporter_id
     JOIN users ru ON ru.id = r.received_by
     WHERE ${where}
     ORDER BY r.received_at DESC
     LIMIT 500`,
    params
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// ROUND 158 — the confirmation queue.
//
// Only the receipts where the weighbridge and the supplier's invoice genuinely
// disagree land here. Everything within tolerance posted itself and nobody is
// asked anything, which is the point: an approval step that fires on every
// routine delivery gets clicked through without being read, and then it is
// worse than no approval at all.
// ---------------------------------------------------------------------------
const CONFIRM_ROLES = ["administrator", "manager"];

router.get("/receipts/pending", requireRole(...CONFIRM_ROLES), requirePermission("material.receipt-confirm", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      // receipts-raw: this queue exists to show exactly the pending ones
      `SELECT r.id, r.received_at, r.supplier_qty, r.weighbridge_weight_kg, r.accepted_qty,
              r.variance_qty, r.variance_pct, r.short_reason, r.notes, r.challan_number,
              r.vehicle_number, r.accepted_basis,
              o.id AS order_id, o.rate AS order_rate,
              m.id AS material_id, m.name AS material_name, m.purchase_unit,
              m.kg_per_purchase_unit, m.tolerance_pct,
              s.name AS supplier_name, ru.name AS received_by_name,
              -- What accepting each figure would actually mean in money, so the
              -- decision is not taken on quantities alone.
              round((r.supplier_qty * o.rate)::numeric, 2) AS value_if_supplier,
              round((r.accepted_qty * o.rate)::numeric, 2) AS value_if_weighed
       FROM rm_receipts r   -- receipts-raw: this queue exists to show exactly the pending ones
       JOIN rm_orders o ON o.id = r.order_id
       JOIN rm_materials m ON m.id = o.material_id
       JOIN rm_suppliers s ON s.id = o.supplier_id
       JOIN users ru ON ru.id = r.received_by
       WHERE r.confirmation_status = 'pending'
       ORDER BY r.received_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the receipts waiting for confirmation." });
  }
});

router.post("/receipts/:id/confirm", requireRole(...CONFIRM_ROLES), requirePermission("material.receipt-confirm", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid receipt id." });

  const basis = String(req.body?.basis || "").trim();
  if (!["weighed", "supplier", "entered"].includes(basis)) {
    return res.status(400).json({ error: "Say which figure stands: the weighed one, the supplier's, or a quantity you enter." });
  }

  try {
    const { rows: found } = await query(
      // receipts-raw: confirming is what takes a receipt out of 'pending'
      `SELECT r.*, o.rate AS order_rate, o.gst_treatment, o.tax_pct, o.freight_rate AS order_freight_rate,
              o.freight_basis AS order_freight_basis, m.kg_per_purchase_unit
       FROM rm_receipts r   -- receipts-raw: confirming is what takes a receipt out of 'pending'
       JOIN rm_orders o ON o.id = r.order_id
       JOIN rm_materials m ON m.id = o.material_id
       WHERE r.id = $1`,
      [id]
    );
    if (!found.length) return res.status(404).json({ error: "Receipt not found." });
    const r = found[0];
    if (r.confirmation_status !== "pending") {
      // Two managers opening the queue at once is ordinary, and the second one
      // should be told plainly rather than silently overwriting the first.
      return res.status(409).json({
        error: `This receipt was already settled${r.confirmed_at ? ` on ${new Date(r.confirmed_at).toLocaleDateString("en-GB")}` : ""}. Reload the queue.`,
      });
    }

    const kgPerUnit = Number(r.kg_per_purchase_unit);
    let acceptedQty;
    if (basis === "supplier") acceptedQty = Number(r.supplier_qty);
    else if (basis === "weighed") acceptedQty = Number(r.accepted_qty);
    else {
      acceptedQty = Number(req.body?.accepted_qty);
      if (!Number.isFinite(acceptedQty) || acceptedQty <= 0) {
        return res.status(400).json({ error: "Enter the quantity you want accepted." });
      }
    }

    // Everything downstream of the quantity has to move with it — the landed
    // rate is what stock valuation reads, and leaving it computed from the
    // figure that was NOT chosen is the kind of error nobody spots for months.
    const acceptedQtyKg = acceptedQty * kgPerUnit;
    const freightTotal = computeFreightTotal(
      r.freight_rate ?? r.order_freight_rate,
      r.freight_basis ?? r.order_freight_basis,
      acceptedQty, acceptedQtyKg
    );
    const baseCost = acceptedQty * Number(r.order_rate) + freightTotal;
    const taxAmount = r.gst_treatment === "included" ? baseCost * (Number(r.tax_pct) / 100) : 0;
    const landedRatePerKg = (baseCost + taxAmount) / acceptedQtyKg;
    const varianceQty = Number(r.supplier_qty) - acceptedQty;
    // Signed, to match the POST above and the back-fill in setup.js.
    const variancePct = Number(r.supplier_qty) > 0
      ? varianceQty / Number(r.supplier_qty) * 100 : 0;

    const { rows } = await query(
      // receipts-raw: the write itself
      `UPDATE rm_receipts
          SET accepted_qty = $2, accepted_qty_kg = $3, landed_rate_per_kg = $4,
              short_qty = CASE WHEN $5::numeric > 0 THEN $5::numeric ELSE NULL END,
              variance_qty = $5, variance_pct = $6, accepted_basis = $7,
              confirmation_status = 'confirmed', confirmed_by = $8, confirmed_at = now(),
              confirm_note = $9
        WHERE id = $1 AND confirmation_status = 'pending'
        RETURNING *`,
      [id, acceptedQty, acceptedQtyKg, landedRatePerKg, varianceQty,
       Number(variancePct.toFixed(3)), basis, req.user.id,
       String(req.body?.note || "").trim() || null]
    );
    if (!rows.length) return res.status(409).json({ error: "Somebody settled this receipt first. Reload the queue." });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not confirm that receipt." });
  }
});

// ===================== Daily consumption & production (Plant Operator) =====================
// Once per day, no shift (confirmed). Automatic (batching-software reading)
// and Manual (operator's own count) are two independent figures shown side
// by side for comparison — see schema.sql's comment on rm_daily_consumption
// for which one book-stock deduction actually uses.

router.get("/consumption", requireRole(...CONSUMPTION_ROLES), requirePermission("material.consumption", "view"), async (req, res) => {
  const date = req.query.date || istDay();
  const { rows } = await query(
    `SELECT m.id AS material_id, m.name, m.purchase_unit, m.kg_per_purchase_unit,
            c.automatic_qty_kg, c.manual_qty_kg, c.recorded_at
     FROM rm_materials m
     LEFT JOIN rm_daily_consumption c ON c.material_id = m.id AND c.consumption_date = $1
     WHERE m.is_active
     ORDER BY m.category, m.name`,
    [date]
  );
  res.json({ date, materials: rows });
});

router.post("/consumption", requireRole(...CONSUMPTION_ROLES), requirePermission("material.consumption", "create"), async (req, res) => {
  const { date, entries } = req.body; // entries: [{ material_id, automatic_qty_kg, manual_qty_kg }]
  if (!date) return res.status(400).json({ error: "Date is required." });
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: "Enter at least one material's consumption." });

  const saved = [];
  for (const e of entries) {
    if (!e.material_id) continue;
    if ((e.automatic_qty_kg === undefined || e.automatic_qty_kg === null || e.automatic_qty_kg === "")
      && (e.manual_qty_kg === undefined || e.manual_qty_kg === null || e.manual_qty_kg === "")) continue; // skip untouched rows
    const { rows } = await query(
      `INSERT INTO rm_daily_consumption (material_id, consumption_date, automatic_qty_kg, manual_qty_kg, recorded_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (material_id, consumption_date)
       DO UPDATE SET automatic_qty_kg = EXCLUDED.automatic_qty_kg, manual_qty_kg = EXCLUDED.manual_qty_kg,
                     recorded_by = EXCLUDED.recorded_by, recorded_at = now()
       RETURNING *`,
      [e.material_id, date, e.automatic_qty_kg || null, e.manual_qty_kg || null, req.user.id]
    );
    saved.push(rows[0]);
  }
  res.status(201).json(saved);
});

router.get("/production", requireRole(...CONSUMPTION_ROLES), requirePermission("material.consumption", "view"), async (req, res) => {
  const date = req.query.date || istDay();
  const { rows } = await query(`SELECT * FROM rm_daily_production WHERE production_date = $1`, [date]);
  res.json(rows[0] || null);
});

router.post("/production", requireRole(...CONSUMPTION_ROLES), requirePermission("material.consumption", "create"), async (req, res) => {
  const { date, concrete_produced_m3 } = req.body;
  if (!date) return res.status(400).json({ error: "Date is required." });
  if (concrete_produced_m3 === undefined || concrete_produced_m3 === null || Number(concrete_produced_m3) < 0) {
    return res.status(400).json({ error: "Enter concrete produced today (m3)." });
  }
  const { rows } = await query(
    `INSERT INTO rm_daily_production (production_date, concrete_produced_m3, recorded_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (production_date)
     DO UPDATE SET concrete_produced_m3 = EXCLUDED.concrete_produced_m3, recorded_by = EXCLUDED.recorded_by, recorded_at = now()
     RETURNING *`,
    [date, concrete_produced_m3, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// ===================== Stock balance & weighted average rate =====================
// Book stock (kg) = opening balance + everything received - everything
// consumed. Consumption uses Automatic when present, else Manual (see
// schema.sql's comment on rm_daily_consumption).
//
// Weighted average rate is a CALENDAR-MONTH average of that month's own
// receipts (confirmed decision — not a continuous moving average). A month
// with no receipts keeps the previous month's closing average, walking
// backward to find it; a material with no receipts at all yet falls back to
// its own opening_stock_rate_per_kg, or has no valuation until its first
// receipt. Computed live from rm_receipts every time, not stored, so a
// correction to an old receipt is always reflected everywhere that reads it.
async function monthlyWeightedAvgRates(materialId) {
  const { rows } = await query(
    `SELECT to_char(date_trunc('month', r.received_at), 'YYYY-MM') AS ym,
            SUM(r.accepted_qty_kg * r.landed_rate_per_kg) AS value_sum,
            SUM(r.accepted_qty_kg) AS qty_sum
     FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
     WHERE o.material_id = $1 AND r.landed_rate_per_kg IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    [materialId]
  );
  const map = new Map();
  for (const r of rows) map.set(r.ym, Number(r.value_sum) / Number(r.qty_sum));
  return map;
}

function effectiveAvgForMonth(rateMap, yearMonth, openingRate) {
  if (rateMap.has(yearMonth)) return rateMap.get(yearMonth);
  let candidate = null;
  for (const ym of [...rateMap.keys()].sort()) {
    if (ym <= yearMonth) candidate = rateMap.get(ym); else break;
  }
  if (candidate != null) return candidate;
  return openingRate != null ? Number(openingRate) : null;
}

async function bookStockRows() {
  const { rows } = await query(`
    SELECT m.*,
           COALESCE(recv.total_kg, 0) AS received_kg,
           COALESCE(cons.total_kg, 0) AS consumed_kg,
           COALESCE(monthcons.month_kg, 0) AS month_consumed_kg,
           COALESCE(monthrecv.month_kg, 0) AS month_received_kg
    FROM rm_materials m
    LEFT JOIN LATERAL (
      SELECT SUM(r.accepted_qty_kg) AS total_kg
      FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id WHERE o.material_id = m.id
    ) recv ON true
    LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)) AS total_kg
      FROM rm_daily_consumption c WHERE c.material_id = m.id
    ) cons ON true
    LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)) AS month_kg
      FROM rm_daily_consumption c
      WHERE c.material_id = m.id AND date_trunc('month', c.consumption_date) = date_trunc('month', CURRENT_DATE)
    ) monthcons ON true
    -- Round 142 — this month's receipts, so the Stock tab can show the
    -- mockup's Opening / Received / Consumed / Book stock line for the month
    -- rather than only the running balance.
    LEFT JOIN LATERAL (
      SELECT SUM(r.accepted_qty_kg) AS month_kg
      FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
      WHERE o.material_id = m.id AND date_trunc('month', r.received_at) = date_trunc('month', CURRENT_DATE)
    ) monthrecv ON true
    WHERE m.is_active
    ORDER BY m.category, m.name
  `);
  return rows;
}

router.get("/stock", requireRole(...STOCK_READ_ROLES), requirePermission("material.stock", "view"), async (req, res) => {
  const asOfMonth = req.query.month || istMonth();
  // Round 155 — was `new Date().getDate()`, the UTC day-of-month on a server
  // that runs in UTC. At 03:00 IST on the 1st, UTC is still the 30th, so this
  // returned 30: the new month's few hours of consumption were divided by 30
  // instead of 1 and stock_days_remaining came out roughly thirty times too
  // high, silencing the low-stock and reorder warnings on precisely the
  // morning stock is thinnest.
  //
  // It also has to follow asOfMonth, not today: asking for a PAST month used
  // to divide that month's consumption by today's day-of-month. For any month
  // that has already ended the right denominator is its full length.
  const daysElapsedThisMonth = daysElapsedIn(asOfMonth);
  const maySeeValuation = await can(req.user, "material.stock-valuation", "view");
  const materials = await bookStockRows();
  const results = [];
  for (const m of materials) {
    const bookStockKg = Number(m.opening_stock_kg) + Number(m.received_kg) - Number(m.consumed_kg);
    const avgDailyThisMonth = Number(m.month_consumed_kg) / daysElapsedThisMonth;
    const row = {
      material_id: m.id, name: m.name, category: m.category, sub_category: m.sub_category,
      purchase_unit: m.purchase_unit, kg_per_purchase_unit: Number(m.kg_per_purchase_unit),
      reorder_level_kg: m.reorder_level_kg,
      book_stock_kg: bookStockKg,
      book_stock_purchase_units: bookStockKg / Number(m.kg_per_purchase_unit),
      low_stock: m.reorder_level_kg != null && bookStockKg <= Number(m.reorder_level_kg),
      stock_days_remaining: avgDailyThisMonth > 0 ? bookStockKg / avgDailyThisMonth : null,
      // Round 142 — the month's own movement, for the mockup's Stock table.
      // Opening is derived backwards from the current balance rather than
      // stored, so it can never disagree with book stock.
      month_received_kg: Number(m.month_received_kg),
      month_consumed_kg: Number(m.month_consumed_kg),
      month_opening_kg: bookStockKg - Number(m.month_received_kg) + Number(m.month_consumed_kg),
    };
    // Round 155 — this used to read `if (req.user.role !== "store")`, which
    // excluded exactly one role by name and therefore handed rates and stock
    // value to the PLANT OPERATOR, who is in STOCK_READ_ROLES. Purchase
    // economics are a separate, deliberately narrower grant in the catalogue —
    // `material.stock-valuation`, which defaults to Administrator alone — and
    // the string compare meant revoking it on the Access Control page changed
    // nothing here. check-guards.mjs cannot catch this: the route's own
    // declared key/action pair is correct and the leak is inside the handler.
    //
    // Now it asks the permission system the question the catalogue already
    // answers. Resolved once before the loop rather than per material, since
    // it cannot change mid-request.
    if (maySeeValuation) {
      const rateMap = await monthlyWeightedAvgRates(m.id);
      const rate = effectiveAvgForMonth(rateMap, asOfMonth, m.opening_stock_rate_per_kg);
      row.rate_per_kg = rate;
      row.stock_value = rate != null ? rate * bookStockKg : null;
    }
    results.push(row);
  }
  // Open orders, for the mockup's right-hand panel: what is still on its way
  // per material, so Store can see at a glance that a low material already
  // has cover coming (or does not).
  const { rows: openOrders } = await query(
    `SELECT o.id, o.ordered_qty, m.id AS material_id, m.name AS material_name, m.purchase_unit,
            (o.ordered_qty * m.kg_per_purchase_unit) AS ordered_qty_kg,
            s.name AS supplier_name, o.scope::text AS scope,
            COALESCE(SUM(r.accepted_qty_kg), 0) AS received_kg,
            COALESCE(SUM(r.accepted_qty), 0) AS received_qty
     FROM rm_orders o
     JOIN rm_materials m ON m.id = o.material_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     LEFT JOIN rm_receipts_effective r ON r.order_id = o.id
     WHERE o.status = 'approved'
     GROUP BY o.id, o.ordered_qty, m.id, m.name, m.purchase_unit, m.kg_per_purchase_unit, s.name, o.scope
     HAVING COALESCE(SUM(r.accepted_qty), 0) < o.ordered_qty
     ORDER BY o.id DESC
     LIMIT 12`
  );
  res.json({ as_of_month: asOfMonth, materials: results, open_orders: openOrders });
});

// ===================== Monthly physical stock =====================
// "Stock taken by" — a physical count reconciled against book stock once a
// month per material. Columns match the confirmed layout: Opening | Purchase
// | Plant Consumption | Book Stock | Physical Stock | Actual Consumption
// (opening + purchase - physical) | Diff kg & % (of plant consumption;
// minus = more was actually used than reported) | Cost of Actual Consumption
// | Cost of Difference.

router.post("/physical-stock", requireRole(...ORDER_ROLES), requirePermission("material.physical-stock", "create"), async (req, res) => {
  const { material_id, stock_month, physical_stock_kg, notes } = req.body;
  if (!material_id) return res.status(400).json({ error: "Select a material." });
  if (!stock_month) return res.status(400).json({ error: "Select the month being counted." });
  if (physical_stock_kg === undefined || physical_stock_kg === null || Number(physical_stock_kg) < 0) {
    return res.status(400).json({ error: "Enter the counted quantity (kg)." });
  }
  // Normalize to the 1st of the given month, however it arrives (YYYY-MM or YYYY-MM-DD).
  const monthDate = `${stock_month.slice(0, 7)}-01`;
  const { rows } = await query(
    `INSERT INTO rm_monthly_physical_stock (material_id, stock_month, physical_stock_kg, stock_taken_by, notes)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (material_id, stock_month)
     DO UPDATE SET physical_stock_kg = EXCLUDED.physical_stock_kg, stock_taken_by = EXCLUDED.stock_taken_by,
                   taken_at = now(), notes = EXCLUDED.notes
     RETURNING *`,
    [material_id, monthDate, physical_stock_kg, req.user.id, notes || null]
  );
  res.status(201).json(rows[0]);
});

router.get("/physical-stock", requireRole(...STOCK_READ_ROLES), requirePermission("material.physical-stock", "view"), async (req, res) => {
  const month = (req.query.month || istMonth()).slice(0, 7);
  const monthStart = `${month}-01`;
  const maySeeValuation = await can(req.user, "material.stock-valuation", "view");

  const { rows: materials } = await query(`SELECT * FROM rm_materials WHERE is_active ORDER BY category, name`);
  const results = [];
  for (const m of materials) {
    const { rows: openingRows } = await query(
      `SELECT
         $2::numeric + COALESCE((SELECT SUM(r.accepted_qty_kg) FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id WHERE o.material_id = $1 AND r.received_at < $3::date), 0)
         - COALESCE((SELECT SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)) FROM rm_daily_consumption c WHERE c.material_id = $1 AND c.consumption_date < $3::date), 0)
         AS opening_kg`,
      [m.id, m.opening_stock_kg, monthStart]
    );
    const openingKg = Number(openingRows[0].opening_kg);

    const { rows: monthRows } = await query(
      `SELECT
         COALESCE((SELECT SUM(r.accepted_qty_kg) FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
                   WHERE o.material_id = $1 AND r.received_at >= $2::date AND r.received_at < $2::date + INTERVAL '1 month'), 0) AS purchase_kg,
         COALESCE((SELECT SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)) FROM rm_daily_consumption c
                   WHERE c.material_id = $1 AND c.consumption_date >= $2::date AND c.consumption_date < $2::date + INTERVAL '1 month'), 0) AS plant_consumption_kg`,
      [m.id, monthStart]
    );
    const purchaseKg = Number(monthRows[0].purchase_kg);
    const plantConsumptionKg = Number(monthRows[0].plant_consumption_kg);
    const bookStockKg = openingKg + purchaseKg - plantConsumptionKg;

    const { rows: countRows } = await query(
      `SELECT * FROM rm_monthly_physical_stock WHERE material_id = $1 AND stock_month = $2`,
      [m.id, monthStart]
    );
    const count = countRows[0] || null;

    const row = {
      material_id: m.id, name: m.name, category: m.category, purchase_unit: m.purchase_unit,
      // Round 142 — the count sheet lets Store enter the figure in the unit
      // it was actually counted in (CFT of a pile, barrels), so the page
      // needs the conversion; kg stays the only thing stored.
      kg_per_purchase_unit: Number(m.kg_per_purchase_unit),
      opening_kg: openingKg, purchase_kg: purchaseKg, plant_consumption_kg: plantConsumptionKg,
      book_stock_kg: bookStockKg,
      physical_stock_kg: count ? Number(count.physical_stock_kg) : null,
      stock_taken_by_name: null,
      notes: count ? count.notes : null,
      taken_at: count ? count.taken_at : null,
    };
    // Round 142 — the rate is resolved for EVERY material, not only the
    // counted ones. The report's "cost as per plant consumption" card needs
    // the whole month's material cost, and before this it silently summed
    // only the materials that happened to have been counted, which made the
    // cost-of-difference percentage beside it meaningless.
    let rate = null;
    // Same Round 155 change as in GET /stock above, and for the same reason:
    // `role !== "store"` was leaking the month's material cost to the Plant
    // Operator, who has no material.stock-valuation grant.
    if (maySeeValuation) {
      const rateMap = await monthlyWeightedAvgRates(m.id);
      rate = effectiveAvgForMonth(rateMap, month, m.opening_stock_rate_per_kg);
      row.rate_per_kg = rate;
      row.cost_plant_consumption = rate != null ? rate * plantConsumptionKg : null;
    }
    if (count) {
      const actualConsumptionKg = openingKg + purchaseKg - Number(count.physical_stock_kg);
      const diffKg = plantConsumptionKg - actualConsumptionKg;
      row.actual_consumption_kg = actualConsumptionKg;
      row.diff_kg = diffKg;
      row.diff_pct = plantConsumptionKg !== 0 ? (diffKg / plantConsumptionKg) * 100 : null;
      if (rate != null) {
        row.cost_actual_consumption = rate * actualConsumptionKg;
        row.cost_of_diff = rate * diffKg;
      }
    }
    results.push(row);
  }

  // Fill in stock_taken_by_name in one batch rather than a query per row.
  if (results.some((r) => r.taken_at)) {
    const { rows: counts } = await query(
      `SELECT mps.material_id, u.name FROM rm_monthly_physical_stock mps JOIN users u ON u.id = mps.stock_taken_by WHERE mps.stock_month = $1`,
      [monthStart]
    );
    const nameByMaterial = new Map(counts.map((c) => [c.material_id, c.name]));
    for (const r of results) if (nameByMaterial.has(r.material_id)) r.stock_taken_by_name = nameByMaterial.get(r.material_id);
  }

  // The month's production, so the report can show cost per m³ beside the
  // month's total material cost. The Plant Operator's own figure is the
  // basis here, same as everywhere else cost/m³ is computed — never the
  // challan total (see this file's header note on the two volume bases).
  const { rows: prodRows } = await query(
    `SELECT COALESCE(SUM(concrete_produced_m3), 0) AS m3 FROM rm_daily_production
     WHERE production_date >= $1::date AND production_date < $1::date + INTERVAL '1 month'`,
    [monthStart]
  );
  const productionM3 = Number(prodRows[0].m3);

  res.json({ month, production_m3: productionM3, materials: results });
});

// ===================== Reports (Administrator only) =====================
// "Raw material stock" is GET /stock above (also used as the live stock
// view for the Store role) — not duplicated here. "Receipts register" is
// GET /receipts above, which already supports date/material/supplier
// filters and returns every computed field a register needs.

// Open order status: approved orders, ordered vs received-so-far, outstanding.
router.get("/reports/open-orders", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS},
            (o.ordered_qty - COALESCE(recv.received_qty, 0)) AS outstanding_qty
     ${ORDER_LIST_FROM}
     WHERE o.status = 'approved'
     ORDER BY o.approved_at`
  );
  res.json(rows);
});

// Supplier qty vs weighbridge weight, and short supply / debit notes — one
// query serves both report items from the notes doc, since they're the same
// underlying receipt fields viewed two ways (the frontend can filter to
// short-only for the debit-notes view).
router.get("/reports/weighbridge-comparison", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_at >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_at < $${params.length}::date + INTERVAL '1 day'`; }
  const { rows } = await query(
    `SELECT r.id, r.received_at, m.name AS material_name, m.purchase_unit, m.tolerance_pct,
            s.name AS supplier_name, r.supplier_qty, r.weighbridge_weight_kg, r.accepted_qty,
            r.short_qty, r.debit_note_amount, r.vehicle_number, r.challan_number
     FROM rm_receipts_effective r
     JOIN rm_orders o ON o.id = r.order_id
     JOIN rm_materials m ON m.id = o.material_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     WHERE ${where}
     ORDER BY r.received_at DESC
     LIMIT 500`,
    params
  );
  const withFlags = rows.map((r) => {
    const deviationPct = Number(r.supplier_qty) > 0 ? Math.abs(Number(r.short_qty)) / Number(r.supplier_qty) * 100 : 0;
    return { ...r, tolerance_exceeded: r.tolerance_pct != null && deviationPct > Number(r.tolerance_pct) };
  });
  res.json(withFlags);
});

// ---------------------------------------------------------------------------
// ROUND 158 — the variance report.
//
// weighbridge-comparison above already lists individual receipts, and that is
// the right tool for "what happened on Tuesday". It is the wrong tool for the
// question that actually costs money, which is whether a particular supplier
// is SHORT-BILLING AS A HABIT. One load 3% light is weather and spillage;
// forty loads averaging 3% light, always in the same direction, is not.
//
// Hence the rollup. Two things make it readable rather than just arithmetic:
//
//   net vs absolute. Net variance is what you are actually out of pocket by.
//   Mean absolute variance says how NOISY a supplier is. A supplier whose
//   loads scatter either side of the mark averages out to nothing on net while
//   being thoroughly unreliable, and those are different conversations.
//
//   short_loads vs over_loads. A supplier genuinely mis-weighing lands on both
//   sides. One that is always short, never over, is not making mistakes.
// ---------------------------------------------------------------------------
router.get("/reports/variance", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  try {
    const params = [];
    let where = "r.variance_qty IS NOT NULL";
    if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_at >= $${params.length}::date`; }
    if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_at < $${params.length}::date + INTERVAL '1 day'`; }
    if (req.query.supplier_id) { params.push(req.query.supplier_id); where += ` AND o.supplier_id = $${params.length}`; }
    if (req.query.material_id) { params.push(req.query.material_id); where += ` AND o.material_id = $${params.length}`; }

    const roll = (groupCols, labelCols) => `
      SELECT ${labelCols},
             count(*)::int                                   AS loads,
             sum(r.supplier_qty)::numeric                     AS billed_qty,
             sum(r.accepted_qty)::numeric                     AS accepted_qty,
             sum(r.variance_qty)::numeric                     AS net_variance_qty,
             round(avg(abs(r.variance_pct))::numeric, 2)      AS mean_abs_variance_pct,
             round((CASE WHEN sum(r.supplier_qty) > 0
                         THEN sum(r.variance_qty) / sum(r.supplier_qty) * 100
                         ELSE 0 END)::numeric, 2)             AS net_variance_pct,
             count(*) FILTER (WHERE r.variance_qty > 0)::int  AS short_loads,
             count(*) FILTER (WHERE r.variance_qty < 0)::int  AS over_loads,
             -- What the net shortfall is worth at the order's own rate, which
             -- is the number that makes somebody pick up the phone.
             round(sum(r.variance_qty * o.rate)::numeric, 2)  AS net_variance_value
      FROM rm_receipts_effective r
      JOIN rm_orders o ON o.id = r.order_id
      JOIN rm_materials m ON m.id = o.material_id
      JOIN rm_suppliers s ON s.id = o.supplier_id
      WHERE ${where}
      GROUP BY ${groupCols}
      ORDER BY sum(r.variance_qty * o.rate) DESC NULLS LAST`;

    const [bySupplier, byMaterial, detail, totals] = await Promise.all([
      query(roll("s.id, s.name", "s.id AS supplier_id, s.name AS supplier_name"), params),
      query(roll("m.id, m.name, m.purchase_unit",
                 "m.id AS material_id, m.name AS material_name, m.purchase_unit"), params),
      query(
        `SELECT r.id, r.received_at, r.supplier_qty, r.accepted_qty, r.weighbridge_weight_kg,
                r.variance_qty, r.variance_pct, r.accepted_basis, r.confirmation_status,
                r.short_reason, r.confirm_note, r.vehicle_number, r.challan_number,
                m.name AS material_name, m.purchase_unit, m.tolerance_pct,
                s.name AS supplier_name, cu.name AS confirmed_by_name
         FROM rm_receipts_effective r
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         JOIN rm_suppliers s ON s.id = o.supplier_id
         LEFT JOIN users cu ON cu.id = r.confirmed_by
         WHERE ${where}
         ORDER BY abs(r.variance_pct) DESC NULLS LAST, r.received_at DESC
         LIMIT 300`, params),
      query(
        `SELECT count(*)::int AS loads,
                sum(r.variance_qty)::numeric AS net_variance_qty,
                round(sum(r.variance_qty * o.rate)::numeric, 2) AS net_variance_value,
                count(*) FILTER (WHERE r.confirmation_status = 'confirmed')::int AS confirmed_loads
         FROM rm_receipts_effective r
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         JOIN rm_suppliers s ON s.id = o.supplier_id
         WHERE ${where}`, params),
    ]);

    res.json({
      by_supplier: bySupplier.rows,
      by_material: byMaterial.rows,
      detail: detail.rows,
      totals: totals.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not build the variance report." });
  }
});

// Daily consumption: mix (challan-derived, grade-split) vs actual (operator's
// own production figure) — deliberately shows BOTH volumes rather than
// applying one to the other (confirmed "Volume basis" decision).
router.get("/reports/daily-consumption", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const date = req.query.date || istDay();

  const { rows: consumption } = await query(
    `SELECT m.id AS material_id, m.name, m.category, m.purchase_unit, m.kg_per_purchase_unit,
            c.automatic_qty_kg, c.manual_qty_kg
     FROM rm_materials m
     LEFT JOIN rm_daily_consumption c ON c.material_id = m.id AND c.consumption_date = $1
     WHERE m.is_active
     ORDER BY m.category, m.name`,
    [date]
  );

  const { rows: production } = await query(`SELECT concrete_produced_m3 FROM rm_daily_production WHERE production_date = $1`, [date]);
  const operatorM3 = production[0] ? Number(production[0].concrete_produced_m3) : null;

  const { rows: challanByGrade } = await query(
    `SELECT g.name AS grade, SUM(dt.loaded_quantity_m3) AS m3
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN mix_grades g ON g.id = co.mix_grade_id
     WHERE dt.ticket_date = $1 AND dt.loaded_quantity_m3 IS NOT NULL
     GROUP BY g.name ORDER BY g.name`,
    [date]
  );
  const challanM3 = challanByGrade.reduce((sum, r) => sum + Number(r.m3), 0);

  res.json({
    date,
    materials: consumption,
    operator_production_m3: operatorM3,
    challan_production_m3: challanM3,
    challan_by_grade: challanByGrade,
  });
});

// Round 142 — Daily consumption: mix design vs actual.
//
// Theoretical = for each grade poured that day, that grade's own effective
// mix design quantity per m3 x the m3 of that grade on the delivery
// challans, summed per material. The GRADE SPLIT can only come from the
// challans (the operator enters one total m3, not a split by grade) — this
// is the volume-basis decision the user settled explicitly: theoretical is
// challan-derived, cost/m3 is operator-derived, and both volumes are shown
// so the gap is visible rather than hidden.
//
// Which design applies to a grade on a given day: each order already carries
// resolved_mix_design_id (written when the order was placed, from the
// customer's assignment or the grade's standard design), so the report uses
// the order's own design rather than re-resolving it now and risking a
// different answer than the one the plant actually batched to.
const MIX_COMPONENT_COLUMN = {
  cement: "cement_kgm3",
  fly_ash: "fly_ash_kgm3",
  fine_agg: "fine_agg_kgm3",
  coarse_20mm: "coarse_20mm_kgm3",
  coarse_12_5mm: "coarse_12_5mm_kgm3",
  // Admixture isn't a column on mix_designs — a design can carry several
  // (superplasticizer + retarder) in mix_design_admixtures. The volumes query
  // below sums that child table per design into the same shape, so the
  // report treats it like any other component. Deliberately left NULL (not
  // 0) when a design has no admixture rows at all: "no figure" is honest,
  // whereas 0 would make the actual dosage look like a 100% overrun.
  admixture: "admix_kgm3",
};

router.get("/reports/mix-vs-actual", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const date = req.query.date || istDay();

  // m3 per grade per design from the day's challans.
  const { rows: volumes } = await query(
    `SELECT g.id AS mix_grade_id, g.name AS grade,
            COALESCE(md.id, std.id) AS mix_design_id,
            COALESCE(md.design_ref_code, std.design_ref_code) AS design_ref_code,
            SUM(dt.loaded_quantity_m3) AS m3,
            COALESCE(md.cement_kgm3, std.cement_kgm3) AS cement_kgm3,
            COALESCE(md.fly_ash_kgm3, std.fly_ash_kgm3) AS fly_ash_kgm3,
            COALESCE(md.fine_agg_kgm3, std.fine_agg_kgm3) AS fine_agg_kgm3,
            COALESCE(md.coarse_20mm_kgm3, std.coarse_20mm_kgm3) AS coarse_20mm_kgm3,
            COALESCE(md.coarse_12_5mm_kgm3, std.coarse_12_5mm_kgm3) AS coarse_12_5mm_kgm3,
            adm.qty AS admix_kgm3
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN mix_grades g ON g.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = co.resolved_mix_design_id
     LEFT JOIN LATERAL (
       SELECT d.* FROM mix_designs d
       WHERE d.mix_grade_id = co.mix_grade_id AND d.is_standard_for_grade AND d.status = 'approved'
       LIMIT 1
     ) std ON true
     LEFT JOIN LATERAL (
       SELECT SUM(a.qty_kgm3) AS qty FROM mix_design_admixtures a
       WHERE a.mix_design_id = COALESCE(md.id, std.id)
     ) adm ON true
     WHERE dt.ticket_date = $1
       AND dt.loaded_quantity_m3 IS NOT NULL
       AND dt.status NOT IN ('cancelled', 'rejected', 'returned')
     GROUP BY g.id, g.name, md.id, std.id, md.design_ref_code, std.design_ref_code,
              md.cement_kgm3, std.cement_kgm3, md.fly_ash_kgm3, std.fly_ash_kgm3,
              md.fine_agg_kgm3, std.fine_agg_kgm3, md.coarse_20mm_kgm3, std.coarse_20mm_kgm3,
              md.coarse_12_5mm_kgm3, std.coarse_12_5mm_kgm3, adm.qty
     ORDER BY g.name`,
    [date]
  );

  const { rows: materials } = await query(
    `SELECT m.id AS material_id, m.name, m.category, m.mix_component,
            c.automatic_qty_kg, c.manual_qty_kg,
            COALESCE(c.automatic_qty_kg, 0) + COALESCE(c.manual_qty_kg, 0) AS actual_kg,
            c.id AS consumption_id
     FROM rm_materials m
     LEFT JOIN rm_daily_consumption c ON c.material_id = m.id AND c.consumption_date = $1
     WHERE m.is_active
     ORDER BY m.category, m.name`,
    [date]
  );

  const { rows: production } = await query(
    `SELECT concrete_produced_m3 FROM rm_daily_production WHERE production_date = $1`, [date]
  );

  const challanM3 = volumes.reduce((sum, v) => sum + Number(v.m3 || 0), 0);
  const gradesMissingDesign = volumes.filter((v) => !v.mix_design_id).map((v) => v.grade);

  const rows = materials.map((m) => {
    const col = MIX_COMPONENT_COLUMN[m.mix_component];
    let theoretical = null;
    const perGrade = [];
    if (col) {
      theoretical = 0;
      for (const v of volumes) {
        const perM3 = v[col] == null ? null : Number(v[col]);
        const m3 = Number(v.m3 || 0);
        const qty = perM3 == null ? null : perM3 * m3;
        perGrade.push({ grade: v.grade, m3, per_m3: perM3, qty_kg: qty, design_ref_code: v.design_ref_code });
        if (qty != null) theoretical += qty;
      }
      // Every grade poured that day lacking a design makes the total a
      // partial figure — say so rather than quietly under-reporting.
      if (perGrade.every((g) => g.qty_kg == null)) theoretical = null;
    }
    const actual = m.consumption_id == null ? null : Number(m.actual_kg);
    return {
      material_id: m.material_id, name: m.name, category: m.category,
      mix_component: m.mix_component,
      automatic_qty_kg: m.automatic_qty_kg, manual_qty_kg: m.manual_qty_kg,
      actual_kg: actual,
      theoretical_kg: theoretical,
      per_grade: perGrade,
      diff_kg: theoretical != null && actual != null ? actual - theoretical : null,
      // `theoretical &&` alone would let a null actual through as NaN — the
      // consumption simply not being entered yet is a normal state, not zero.
      diff_pct: theoretical && actual != null ? ((actual - theoretical) / theoretical) * 100 : null,
    };
  });

  res.json({
    date,
    challan_production_m3: challanM3,
    operator_production_m3: production[0] ? Number(production[0].concrete_produced_m3) : null,
    grades: volumes.map((v) => ({
      grade: v.grade, m3: Number(v.m3 || 0), design_ref_code: v.design_ref_code, has_design: !!v.mix_design_id,
    })),
    grades_missing_design: gradesMissingDesign,
    materials: rows,
    unmapped_materials: rows.filter((r) => !r.mix_component).map((r) => r.name),
  });
});

router.get("/reports/monthly-consumption-summary", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const month = (req.query.month || istMonth()).slice(0, 7);
  const { rows } = await query(
    `SELECT m.id AS material_id, m.name, m.category, m.purchase_unit, m.kg_per_purchase_unit,
            COALESCE(SUM(c.automatic_qty_kg), 0) AS automatic_total_kg,
            COALESCE(SUM(c.manual_qty_kg), 0) AS manual_total_kg,
            COALESCE(SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)), 0) AS consumed_total_kg
     FROM rm_materials m
     LEFT JOIN rm_daily_consumption c ON c.material_id = m.id
       AND to_char(c.consumption_date, 'YYYY-MM') = $1
     WHERE m.is_active
     GROUP BY m.id, m.name, m.category, m.purchase_unit, m.kg_per_purchase_unit
     ORDER BY m.category, m.name`,
    [month]
  );
  res.json({ month, materials: rows });
});

router.get("/reports/monthly-physical-stock", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  // Same computation as GET /physical-stock above — this alias exists purely
  // so the Reports tab has a stable, explicitly-named report path.
  req.url = `/physical-stock${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  return router.handle(req, res);
});

router.get("/reports/weighted-average-rate-history", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const { rows: materials } = await query(`SELECT id, name, category, opening_stock_rate_per_kg FROM rm_materials ORDER BY category, name`);
  const results = [];
  for (const m of materials) {
    const rateMap = await monthlyWeightedAvgRates(m.id);
    if (!rateMap.size && m.opening_stock_rate_per_kg == null) continue;
    results.push({
      material_id: m.id,
      name: m.name,
      opening_stock_rate_per_kg: m.opening_stock_rate_per_kg,
      months: [...rateMap.entries()].map(([month, rate]) => ({ month, rate })),
    });
  }
  res.json(results);
});

router.get("/reports/supplier-purchase-summary", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_at >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_at < $${params.length}::date + INTERVAL '1 day'`; }
  const { rows } = await query(
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            COUNT(r.id) AS receipt_count,
            SUM(r.accepted_qty_kg) AS total_qty_kg,
            SUM(r.accepted_qty_kg * r.landed_rate_per_kg) AS total_value
     FROM rm_receipts_effective r
     JOIN rm_orders o ON o.id = r.order_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     WHERE ${where}
     GROUP BY s.id, s.name
     ORDER BY total_value DESC NULLS LAST`,
    params
  );
  res.json(rows);
});

router.get("/reports/transporter-freight", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const params = [];
  let where = "r.transporter_id IS NOT NULL";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_at >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_at < $${params.length}::date + INTERVAL '1 day'`; }
  const { rows } = await query(
    `SELECT t.id AS transporter_id, t.name AS transporter_name,
            COUNT(r.id) AS trip_count,
            SUM(CASE
                  WHEN r.freight_basis = 'per_kg' THEN r.freight_rate * r.accepted_qty_kg
                  WHEN r.freight_basis = 'per_trip' THEN r.freight_rate
                  ELSE r.freight_rate * r.accepted_qty
                END) AS total_freight
     FROM rm_receipts_effective r
     JOIN rm_transporters t ON t.id = r.transporter_id
     WHERE ${where}
     GROUP BY t.id, t.name
     ORDER BY total_freight DESC NULLS LAST`,
    params
  );
  res.json(rows);
});

// Material cost per m3 by grade — deliberately keeps the two volume bases
// separate per the confirmed "Volume basis" decision: the grade SPLIT comes
// from delivery challans (the only place grade-wise volume is recorded);
// overall cost/m3 divides by the operator's own daily production figure
// (challans can miss rejected loads or contain duplicates). Every m3 figure
// in the response is labeled with its source so the two can never be
// silently mixed on the frontend.
router.get("/reports/cost-per-m3", requireRole(...ADMIN), requirePermission("material.reports", "view"), async (req, res) => {
  const fromDate = req.query.from_date;
  const toDate = req.query.to_date;
  if (!fromDate || !toDate) return res.status(400).json({ error: "from_date and to_date are required." });

  const { rows: dailyConsumption } = await query(
    `SELECT c.material_id, c.consumption_date, COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0) AS consumed_kg
     FROM rm_daily_consumption c
     WHERE c.consumption_date >= $1::date AND c.consumption_date <= $2::date`,
    [fromDate, toDate]
  );
  const { rows: materials } = await query(`SELECT id, opening_stock_rate_per_kg FROM rm_materials`);
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const rateMapByMaterial = new Map();
  for (const m of materials) rateMapByMaterial.set(m.id, await monthlyWeightedAvgRates(m.id));

  let totalCost = 0;
  for (const row of dailyConsumption) {
    const ym = istMonth(row.consumption_date);
    const material = materialById.get(row.material_id);
    const rate = effectiveAvgForMonth(rateMapByMaterial.get(row.material_id) || new Map(), ym, material?.opening_stock_rate_per_kg);
    if (rate != null) totalCost += Number(row.consumed_kg) * rate;
  }

  const { rows: productionRows } = await query(
    `SELECT COALESCE(SUM(concrete_produced_m3), 0) AS total_m3 FROM rm_daily_production WHERE production_date >= $1::date AND production_date <= $2::date`,
    [fromDate, toDate]
  );
  const operatorTotalM3 = Number(productionRows[0].total_m3);

  const { rows: challanByGrade } = await query(
    `SELECT g.name AS grade, SUM(dt.loaded_quantity_m3) AS m3
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN mix_grades g ON g.id = co.mix_grade_id
     WHERE dt.ticket_date >= $1::date AND dt.ticket_date <= $2::date AND dt.loaded_quantity_m3 IS NOT NULL
     GROUP BY g.name ORDER BY g.name`,
    [fromDate, toDate]
  );
  const challanTotalM3 = challanByGrade.reduce((sum, r) => sum + Number(r.m3), 0);
  const gradeSplit = challanByGrade.map((r) => ({
    grade: r.grade,
    challan_m3: Number(r.m3),
    // Cost allocated to this grade in proportion to its share of challan
    // volume for the period — an allocation, not a separately-tracked cost.
    allocated_cost: challanTotalM3 > 0 ? (Number(r.m3) / challanTotalM3) * totalCost : null,
  }));

  res.json({
    from_date: fromDate,
    to_date: toDate,
    total_material_cost: totalCost,
    operator_production_m3: operatorTotalM3,
    cost_per_m3_operator_basis: operatorTotalM3 > 0 ? totalCost / operatorTotalM3 : null,
    challan_production_m3: challanTotalM3,
    grade_split_challan_basis: gradeSplit,
  });
});

// ===================== Cost Dashboard (item 8, round 140) =====================
// Reuses monthlyWeightedAvgRates/effectiveAvgForMonth (same calendar-month
// weighted rate as everywhere else) and the operator's own production m3 as
// the cost/m3 basis (never the challan-derived figure) — the same "Volume
// basis" decision GET /reports/cost-per-m3 above already follows.
router.get("/reports/cost-dashboard", requireRole(...ADMIN), requirePermission("material.cost-dashboard", "view"), async (req, res) => {
  const month = (req.query.month || istMonth()).slice(0, 7);
  const monthStart = `${month}-01`;

  const { rows: materials } = await query(`SELECT id, name, opening_stock_rate_per_kg FROM rm_materials`);
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const rateMapByMaterial = new Map();
  for (const m of materials) rateMapByMaterial.set(m.id, await monthlyWeightedAvgRates(m.id));

  // Per-material breakdown + this month's total material cost.
  const { rows: monthConsumption } = await query(
    `SELECT material_id, SUM(COALESCE(automatic_qty_kg, manual_qty_kg, 0)) AS consumed_kg
     FROM rm_daily_consumption WHERE to_char(consumption_date, 'YYYY-MM') = $1 GROUP BY material_id`,
    [month]
  );
  let monthMaterialCost = 0;
  const perMaterial = [];
  for (const row of monthConsumption) {
    const material = materialById.get(row.material_id);
    if (!material) continue;
    const rate = effectiveAvgForMonth(rateMapByMaterial.get(row.material_id) || new Map(), month, material.opening_stock_rate_per_kg);
    const cost = rate != null ? Number(row.consumed_kg) * rate : null;
    if (cost != null) monthMaterialCost += cost;
    perMaterial.push({ material_id: row.material_id, name: material.name, consumed_kg: Number(row.consumed_kg), rate_per_kg: rate, cost });
  }

  const { rows: productionRows } = await query(
    `SELECT COALESCE(SUM(concrete_produced_m3), 0) AS total_m3 FROM rm_daily_production WHERE to_char(production_date, 'YYYY-MM') = $1`,
    [month]
  );
  const monthM3 = Number(productionRows[0].total_m3);
  const costPerM3 = monthM3 > 0 ? monthMaterialCost / monthM3 : null;
  for (const p of perMaterial) p.cost_per_m3 = p.cost != null && monthM3 > 0 ? p.cost / monthM3 : null;
  perMaterial.sort((a, b) => (b.cost || 0) - (a.cost || 0));

  // Stock value as of today (same computation as GET /stock).
  const stockRows = await bookStockRows();
  const nowMonth = istMonth();
  let stockValue = 0;
  for (const m of stockRows) {
    const bookStockKg = Number(m.opening_stock_kg) + Number(m.received_kg) - Number(m.consumed_kg);
    const rate = effectiveAvgForMonth(rateMapByMaterial.get(m.id) || new Map(), nowMonth, m.opening_stock_rate_per_kg);
    if (rate != null) stockValue += rate * bookStockKg;
  }

  // This month's receipts — purchase value, debit notes, and the grouped
  // material -> supplier weighted-rate table with short-supply%.
  const { rows: monthReceipts } = await query(
    `SELECT r.accepted_qty_kg, r.landed_rate_per_kg, r.debit_note_amount, r.short_qty, r.supplier_qty,
            o.material_id, o.supplier_id, m.name AS material_name, m.purchase_unit, s.name AS supplier_name
     FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
     JOIN rm_materials m ON m.id = o.material_id JOIN rm_suppliers s ON s.id = o.supplier_id
     WHERE to_char(r.received_at, 'YYYY-MM') = $1`,
    [month]
  );
  const monthPurchaseValue = monthReceipts.reduce((sum, r) => sum + Number(r.accepted_qty_kg) * Number(r.landed_rate_per_kg || 0), 0);
  const debitNotesDue = monthReceipts.reduce((sum, r) => sum + Number(r.debit_note_amount || 0), 0);

  const groupMap = new Map();
  for (const r of monthReceipts) {
    if (!groupMap.has(r.material_id)) {
      groupMap.set(r.material_id, { material_id: r.material_id, name: r.material_name, purchase_unit: r.purchase_unit, suppliers: new Map(), total_qty_kg: 0, total_value: 0 });
    }
    const g = groupMap.get(r.material_id);
    if (!g.suppliers.has(r.supplier_id)) {
      g.suppliers.set(r.supplier_id, { supplier_id: r.supplier_id, name: r.supplier_name, qty_kg: 0, value: 0, short_qty: 0, supplier_qty: 0 });
    }
    const s = g.suppliers.get(r.supplier_id);
    const value = Number(r.accepted_qty_kg) * Number(r.landed_rate_per_kg || 0);
    s.qty_kg += Number(r.accepted_qty_kg); s.value += value;
    s.short_qty += Number(r.short_qty || 0); s.supplier_qty += Number(r.supplier_qty || 0);
    g.total_qty_kg += Number(r.accepted_qty_kg); g.total_value += value;
  }
  const groupedSupplierTable = [...groupMap.values()]
    .map((g) => ({
      material_id: g.material_id, name: g.name, purchase_unit: g.purchase_unit,
      total_qty_kg: g.total_qty_kg,
      blended_rate_per_kg: g.total_qty_kg > 0 ? g.total_value / g.total_qty_kg : null,
      suppliers: [...g.suppliers.values()]
        .map((s) => ({
          supplier_id: s.supplier_id, name: s.name, qty_kg: s.qty_kg,
          rate_per_kg: s.qty_kg > 0 ? s.value / s.qty_kg : null,
          short_supply_pct: s.supplier_qty > 0 ? (s.short_qty / s.supplier_qty) * 100 : null,
        }))
        .sort((a, b) => b.qty_kg - a.qty_kg),
    }))
    .sort((a, b) => b.total_qty_kg - a.total_qty_kg);

  const { rows: toleranceRows } = await query(
    `SELECT COUNT(*) AS n FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id JOIN rm_materials m ON m.id = o.material_id
     WHERE to_char(r.received_at, 'YYYY-MM') = $1 AND m.tolerance_pct IS NOT NULL
       AND r.supplier_qty > 0 AND ABS(r.short_qty) / r.supplier_qty * 100 > m.tolerance_pct`,
    [month]
  );

  // 6-month cost/m3 trend (operator basis), this month and the 5 before it.
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(`${monthStart}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    const ym = istMonth(d);
    const { rows: prod } = await query(`SELECT COALESCE(SUM(concrete_produced_m3), 0) AS m3 FROM rm_daily_production WHERE to_char(production_date, 'YYYY-MM') = $1`, [ym]);
    const { rows: cons } = await query(`SELECT material_id, SUM(COALESCE(automatic_qty_kg, manual_qty_kg, 0)) AS kg FROM rm_daily_consumption WHERE to_char(consumption_date, 'YYYY-MM') = $1 GROUP BY material_id`, [ym]);
    let cost = 0;
    for (const row of cons) {
      const material = materialById.get(row.material_id);
      if (!material) continue;
      const rate = effectiveAvgForMonth(rateMapByMaterial.get(row.material_id) || new Map(), ym, material.opening_stock_rate_per_kg);
      if (rate != null) cost += Number(row.kg) * rate;
    }
    const m3 = Number(prod[0].m3);
    trend.push({ month: ym, cost_per_m3: m3 > 0 ? cost / m3 : null, m3 });
  }

  res.json({
    month,
    kpis: {
      cost_per_m3: costPerM3,
      month_m3: monthM3,
      stock_value: stockValue,
      month_purchase_value: monthPurchaseValue,
      debit_notes_due: debitNotesDue,
      over_tolerance_count: Number(toleranceRows[0].n),
    },
    trend,
    per_material: perMaterial,
    grouped_supplier_table: groupedSupplierTable,
  });
});

// Admin Stock tab KPI banner (item 8 extra, round 140) — 4 summary cards
// (stock value, balance on open orders, month's purchases, debit notes due)
// plus a pending-approval count, per AdminStock.dc.html.
router.get("/reports/stock-summary", requireRole(...ADMIN), requirePermission("material.stock-valuation", "view"), async (req, res) => {
  const month = istMonth();

  const stockRows = await bookStockRows();
  let stockValue = 0;
  for (const m of stockRows) {
    const bookStockKg = Number(m.opening_stock_kg) + Number(m.received_kg) - Number(m.consumed_kg);
    const rateMap = await monthlyWeightedAvgRates(m.id);
    const rate = effectiveAvgForMonth(rateMap, month, m.opening_stock_rate_per_kg);
    if (rate != null) stockValue += rate * bookStockKg;
  }

  const { rows: openOrders } = await query(
    `SELECT o.rate, o.ordered_qty, COALESCE(recv.received_qty, 0) AS received_qty
     FROM rm_orders o
     LEFT JOIN LATERAL (SELECT SUM(r.accepted_qty) AS received_qty FROM rm_receipts_effective r WHERE r.order_id = o.id) recv ON true
     WHERE o.status = 'approved'`
  );
  const openOrderBalanceValue = openOrders.reduce((sum, o) => sum + Math.max(0, Number(o.ordered_qty) - Number(o.received_qty)) * Number(o.rate), 0);

  const { rows: monthReceipts } = await query(
    `SELECT accepted_qty_kg, landed_rate_per_kg, debit_note_amount FROM rm_receipts_effective WHERE to_char(received_at, 'YYYY-MM') = $1`,
    [month]
  );
  const monthPurchaseValue = monthReceipts.reduce((sum, r) => sum + Number(r.accepted_qty_kg) * Number(r.landed_rate_per_kg || 0), 0);
  const debitNotesDue = monthReceipts.reduce((sum, r) => sum + Number(r.debit_note_amount || 0), 0);

  const { rows: pendingRows } = await query(`SELECT COUNT(*) AS n FROM rm_orders WHERE status = 'pending_approval'`);

  res.json({
    stock_value: stockValue,
    open_order_balance_value: openOrderBalanceValue,
    month_purchase_value: monthPurchaseValue,
    debit_notes_due: debitNotesDue,
    pending_approval_count: Number(pendingRows[0].n),
  });
});

export default router;
