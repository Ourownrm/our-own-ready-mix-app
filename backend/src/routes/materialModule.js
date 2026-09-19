import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole, pushToUser } from "../lib/push.js";

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

function isStore(req) {
  return req.user.role === "store";
}

// ===================== Materials master =====================

router.get("/materials", requireRole(...MATERIALS_READ_ROLES), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM rm_materials WHERE is_active OR $1 = 'administrator' ORDER BY category, name`,
    [req.user.role]
  );
  // Store never sees valuation — enforced here, not just left out of the UI.
  const sanitized = isStore(req) ? rows.map(({ opening_stock_rate_per_kg, ...rest }) => rest) : rows;
  res.json(sanitized);
});

router.post("/materials", requireRole(...ADMIN), async (req, res) => {
  const { name, category, sub_category, purchase_unit, kg_per_purchase_unit, tolerance_pct, reorder_level_kg, opening_stock_kg, opening_stock_rate_per_kg } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Material name is required." });
  if (!purchase_unit || !purchase_unit.trim()) return res.status(400).json({ error: "Purchase unit is required (e.g. CFT, Bag, MT)." });
  if (!kg_per_purchase_unit || Number(kg_per_purchase_unit) <= 0) return res.status(400).json({ error: "Enter the conversion to kg per purchase unit." });

  const { rows } = await query(
    `INSERT INTO rm_materials
       (name, category, sub_category, purchase_unit, kg_per_purchase_unit, tolerance_pct, reorder_level_kg, opening_stock_kg, opening_stock_rate_per_kg, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name.trim(), category || null, sub_category || null, purchase_unit.trim(), kg_per_purchase_unit,
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
router.get("/materials/:id/units", requireRole(...MATERIALS_READ_ROLES), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM rm_material_units WHERE material_id = $1 AND (is_active OR $2 = 'administrator') ORDER BY is_default DESC, unit_name`,
    [req.params.id, req.user.role]
  );
  res.json(rows);
});

router.post("/materials/:id/units", requireRole(...ADMIN), async (req, res) => {
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

router.patch("/materials/:id/units/:unitId", requireRole(...ADMIN), async (req, res) => {
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

router.delete("/materials/:id/units/:unitId", requireRole(...ADMIN), async (req, res) => {
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

router.patch("/materials/:id", requireRole(...ADMIN), async (req, res) => {
  const fields = ["name", "category", "sub_category", "purchase_unit", "kg_per_purchase_unit", "tolerance_pct", "reorder_level_kg", "opening_stock_kg", "opening_stock_rate_per_kg", "is_active"];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let value = req.body[f];
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

router.get("/suppliers", requireRole(...ORDER_ROLES), async (req, res) => {
  const { rows } = await query(`SELECT * FROM rm_suppliers WHERE is_active OR $1 = 'administrator' ORDER BY name`, [req.user.role]);
  res.json(rows);
});

router.post("/suppliers", requireRole(...ADMIN), async (req, res) => {
  const { name, contact_person, phone, address, gstin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Supplier name is required." });
  const { rows } = await query(
    `INSERT INTO rm_suppliers (name, contact_person, phone, address, gstin, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name.trim(), contact_person || null, phone || null, address || null, gstin || null, req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.patch("/suppliers/:id", requireRole(...ADMIN), async (req, res) => {
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
router.get("/suppliers/:supplierId/rates", requireRole(...ORDER_ROLES), async (req, res) => {
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
router.get("/suppliers/:supplierId/rates/history", requireRole(...ORDER_ROLES), async (req, res) => {
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
router.post("/suppliers/:supplierId/rates", requireRole(...ADMIN), async (req, res) => {
  const { material_id, scope, rate, valid_from } = req.body;
  if (!material_id) return res.status(400).json({ error: "Select a material." });
  if (!["delivered", "ex_factory"].includes(scope)) return res.status(400).json({ error: "Scope must be delivered or ex_factory." });
  if (!rate || Number(rate) <= 0) return res.status(400).json({ error: "Enter a valid rate." });

  const effectiveFrom = valid_from || new Date().toISOString().slice(0, 10);
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

router.get("/transporters", requireRole(...ORDER_ROLES), async (req, res) => {
  const { rows } = await query(`SELECT * FROM rm_transporters WHERE is_active OR $1 = 'administrator' ORDER BY name`, [req.user.role]);
  res.json(rows);
});

router.post("/transporters", requireRole(...ADMIN), async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Transporter name is required." });
  const { rows } = await query(`INSERT INTO rm_transporters (name, phone) VALUES ($1,$2) RETURNING *`, [name.trim(), phone || null]);
  res.status(201).json(rows[0]);
});

router.patch("/transporters/:id", requireRole(...ADMIN), async (req, res) => {
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
router.get("/suppliers/:supplierId/transporters", requireRole(...ORDER_ROLES), async (req, res) => {
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

router.post("/suppliers/:supplierId/transporters", requireRole(...ADMIN), async (req, res) => {
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

router.post("/orders", requireRole(...ORDER_ROLES), async (req, res) => {
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
    SELECT SUM(r.accepted_qty) AS received_qty FROM rm_receipts r WHERE r.order_id = o.id
  ) recv ON true
`;

router.get("/orders/mine", requireRole(...ORDER_ROLES), async (req, res) => {
  const params = [req.user.id];
  let where = "o.requested_by = $1";
  if (req.user.role === "administrator") { where = "true"; params.length = 0; }
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM} WHERE ${where} ORDER BY o.requested_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

// Orders Store can currently receive against — approved, with something
// still outstanding. Used to populate the Receipts tab's order picker.
router.get("/orders/receivable", requireRole(...ORDER_ROLES), async (req, res) => {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM}
     WHERE o.status = 'approved' AND COALESCE(recv.received_qty, 0) < o.ordered_qty
     ORDER BY o.approved_at DESC`
  );
  res.json(rows);
});

router.get("/orders/pending", requireRole(...ADMIN), async (req, res) => {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM} WHERE o.status = 'pending_approval' ORDER BY o.requested_at`
  );
  res.json(rows);
});

router.post("/orders/:id/approve", requireRole(...ADMIN), async (req, res) => {
  const { rows: existing } = await query(`SELECT * FROM rm_orders WHERE id = $1 AND status = 'pending_approval'`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Order not found or already actioned." });
  const { rows } = await query(
    `UPDATE rm_orders SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Material order approved", body: "Your order is approved and ready to receive.", url: "/material-module?tab=orders" });
  res.json(rows[0]);
});

router.post("/orders/:id/reject", requireRole(...ADMIN), async (req, res) => {
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
router.post("/orders/:id/close", requireRole(...ADMIN), async (req, res) => {
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
router.patch("/orders/:id", requireRole(...ADMIN), async (req, res) => {
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

router.post("/receipts", requireRole(...ORDER_ROLES), async (req, res) => {
  const { order_id, supplier_qty, weighbridge_weight_kg, accepted_qty, transporter_id, freight_rate, freight_basis, vehicle_number, challan_number, debit_note_amount, notes } = req.body;
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
  if (finalAcceptedQty === undefined || finalAcceptedQty === null || finalAcceptedQty === "") {
    if (!weighbridge_weight_kg) return res.status(400).json({ error: "Enter the accepted quantity, or the weighbridge weight to derive it from." });
    finalAcceptedQty = Number(weighbridge_weight_kg) / Number(order.kg_per_purchase_unit);
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

  const { rows } = await query(
    `INSERT INTO rm_receipts
       (order_id, supplier_qty, weighbridge_weight_kg, accepted_qty, accepted_qty_kg, transporter_id,
        freight_rate, freight_basis, vehicle_number, challan_number, short_qty, debit_note_amount,
        landed_rate_per_kg, received_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [order_id, supplier_qty, weighbridge_weight_kg || null, finalAcceptedQty, acceptedQtyKg,
      transporter_id || order.transporter_id || null, useFreightRate || null, useFreightBasis || null,
      vehicle_number || null, challan_number || null, shortQty, debit_note_amount || null,
      landedRatePerKg, req.user.id, notes || null]
  );

  const tolerancePct = order.tolerance_pct != null ? Number(order.tolerance_pct) : null;
  const deviationPct = Number(supplier_qty) > 0 ? Math.abs(shortQty) / Number(supplier_qty) * 100 : 0;
  res.status(201).json({
    ...rows[0],
    tolerance_exceeded: tolerancePct != null && deviationPct > tolerancePct,
  });
});

// Admin-only edit/delete for a wrong receipt entry (item 6, round 140). Book
// stock and the weighted-average rate are both computed LIVE from
// rm_receipts on every read (round 139's architecture), so editing or
// deleting a receipt needs no separate stock/rate repair — the next read
// simply reflects the corrected data.
router.patch("/receipts/:id", requireRole(...ADMIN), async (req, res) => {
  const { rows: existingRows } = await query(
    `SELECT r.*, o.rate AS order_rate, o.gst_treatment, o.tax_pct
     FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id
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
    `UPDATE rm_receipts SET
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

router.delete("/receipts/:id", requireRole(...ADMIN), async (req, res) => {
  const { rows } = await query(`DELETE FROM rm_receipts WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Receipt not found." });
  res.json({ deleted: true });
});

router.get("/receipts", requireRole(...ORDER_ROLES), async (req, res) => {
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
     FROM rm_receipts r
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

// ===================== Daily consumption & production (Plant Operator) =====================
// Once per day, no shift (confirmed). Automatic (batching-software reading)
// and Manual (operator's own count) are two independent figures shown side
// by side for comparison — see schema.sql's comment on rm_daily_consumption
// for which one book-stock deduction actually uses.

router.get("/consumption", requireRole(...CONSUMPTION_ROLES), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
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

router.post("/consumption", requireRole(...CONSUMPTION_ROLES), async (req, res) => {
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

router.get("/production", requireRole(...CONSUMPTION_ROLES), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows } = await query(`SELECT * FROM rm_daily_production WHERE production_date = $1`, [date]);
  res.json(rows[0] || null);
});

router.post("/production", requireRole(...CONSUMPTION_ROLES), async (req, res) => {
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
     FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id
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
           COALESCE(monthcons.month_kg, 0) AS month_consumed_kg
    FROM rm_materials m
    LEFT JOIN LATERAL (
      SELECT SUM(r.accepted_qty_kg) AS total_kg
      FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id WHERE o.material_id = m.id
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
    WHERE m.is_active
    ORDER BY m.category, m.name
  `);
  return rows;
}

router.get("/stock", requireRole(...STOCK_READ_ROLES), async (req, res) => {
  const asOfMonth = req.query.month || new Date().toISOString().slice(0, 7);
  const daysElapsedThisMonth = new Date().getDate();
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
    };
    if (req.user.role !== "store") {
      const rateMap = await monthlyWeightedAvgRates(m.id);
      const rate = effectiveAvgForMonth(rateMap, asOfMonth, m.opening_stock_rate_per_kg);
      row.rate_per_kg = rate;
      row.stock_value = rate != null ? rate * bookStockKg : null;
    }
    results.push(row);
  }
  res.json({ as_of_month: asOfMonth, materials: results });
});

// ===================== Monthly physical stock =====================
// "Stock taken by" — a physical count reconciled against book stock once a
// month per material. Columns match the confirmed layout: Opening | Purchase
// | Plant Consumption | Book Stock | Physical Stock | Actual Consumption
// (opening + purchase - physical) | Diff kg & % (of plant consumption;
// minus = more was actually used than reported) | Cost of Actual Consumption
// | Cost of Difference.

router.post("/physical-stock", requireRole(...ORDER_ROLES), async (req, res) => {
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

router.get("/physical-stock", requireRole(...STOCK_READ_ROLES), async (req, res) => {
  const month = (req.query.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const monthStart = `${month}-01`;

  const { rows: materials } = await query(`SELECT * FROM rm_materials WHERE is_active ORDER BY category, name`);
  const results = [];
  for (const m of materials) {
    const { rows: openingRows } = await query(
      `SELECT
         $2::numeric + COALESCE((SELECT SUM(r.accepted_qty_kg) FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id WHERE o.material_id = $1 AND r.received_at < $3::date), 0)
         - COALESCE((SELECT SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)) FROM rm_daily_consumption c WHERE c.material_id = $1 AND c.consumption_date < $3::date), 0)
         AS opening_kg`,
      [m.id, m.opening_stock_kg, monthStart]
    );
    const openingKg = Number(openingRows[0].opening_kg);

    const { rows: monthRows } = await query(
      `SELECT
         COALESCE((SELECT SUM(r.accepted_qty_kg) FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id
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
      opening_kg: openingKg, purchase_kg: purchaseKg, plant_consumption_kg: plantConsumptionKg,
      book_stock_kg: bookStockKg,
      physical_stock_kg: count ? Number(count.physical_stock_kg) : null,
      stock_taken_by_name: null,
      taken_at: count ? count.taken_at : null,
    };
    if (count) {
      const actualConsumptionKg = openingKg + purchaseKg - Number(count.physical_stock_kg);
      const diffKg = plantConsumptionKg - actualConsumptionKg;
      row.actual_consumption_kg = actualConsumptionKg;
      row.diff_kg = diffKg;
      row.diff_pct = plantConsumptionKg !== 0 ? (diffKg / plantConsumptionKg) * 100 : null;
      if (req.user.role !== "store") {
        const rateMap = await monthlyWeightedAvgRates(m.id);
        const rate = effectiveAvgForMonth(rateMap, month, m.opening_stock_rate_per_kg);
        row.rate_per_kg = rate;
        row.cost_actual_consumption = rate != null ? rate * actualConsumptionKg : null;
        row.cost_of_diff = rate != null ? rate * diffKg : null;
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

  res.json({ month, materials: results });
});

// ===================== Reports (Administrator only) =====================
// "Raw material stock" is GET /stock above (also used as the live stock
// view for the Store role) — not duplicated here. "Receipts register" is
// GET /receipts above, which already supports date/material/supplier
// filters and returns every computed field a register needs.

// Open order status: approved orders, ordered vs received-so-far, outstanding.
router.get("/reports/open-orders", requireRole(...ADMIN), async (req, res) => {
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
router.get("/reports/weighbridge-comparison", requireRole(...ADMIN), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_at >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_at < $${params.length}::date + INTERVAL '1 day'`; }
  const { rows } = await query(
    `SELECT r.id, r.received_at, m.name AS material_name, m.purchase_unit, m.tolerance_pct,
            s.name AS supplier_name, r.supplier_qty, r.weighbridge_weight_kg, r.accepted_qty,
            r.short_qty, r.debit_note_amount, r.vehicle_number, r.challan_number
     FROM rm_receipts r
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

// Daily consumption: mix (challan-derived, grade-split) vs actual (operator's
// own production figure) — deliberately shows BOTH volumes rather than
// applying one to the other (confirmed "Volume basis" decision).
router.get("/reports/daily-consumption", requireRole(...ADMIN), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

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

router.get("/reports/monthly-consumption-summary", requireRole(...ADMIN), async (req, res) => {
  const month = (req.query.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
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

router.get("/reports/monthly-physical-stock", requireRole(...ADMIN), async (req, res) => {
  // Same computation as GET /physical-stock above — this alias exists purely
  // so the Reports tab has a stable, explicitly-named report path.
  req.url = `/physical-stock${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  return router.handle(req, res);
});

router.get("/reports/weighted-average-rate-history", requireRole(...ADMIN), async (req, res) => {
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

router.get("/reports/supplier-purchase-summary", requireRole(...ADMIN), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_at >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_at < $${params.length}::date + INTERVAL '1 day'`; }
  const { rows } = await query(
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            COUNT(r.id) AS receipt_count,
            SUM(r.accepted_qty_kg) AS total_qty_kg,
            SUM(r.accepted_qty_kg * r.landed_rate_per_kg) AS total_value
     FROM rm_receipts r
     JOIN rm_orders o ON o.id = r.order_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     WHERE ${where}
     GROUP BY s.id, s.name
     ORDER BY total_value DESC NULLS LAST`,
    params
  );
  res.json(rows);
});

router.get("/reports/transporter-freight", requireRole(...ADMIN), async (req, res) => {
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
     FROM rm_receipts r
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
router.get("/reports/cost-per-m3", requireRole(...ADMIN), async (req, res) => {
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
    const ym = row.consumption_date.toISOString().slice(0, 7);
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
router.get("/reports/cost-dashboard", requireRole(...ADMIN), async (req, res) => {
  const month = (req.query.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
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
  const nowMonth = new Date().toISOString().slice(0, 7);
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
     FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id
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
    `SELECT COUNT(*) AS n FROM rm_receipts r JOIN rm_orders o ON o.id = r.order_id JOIN rm_materials m ON m.id = o.material_id
     WHERE to_char(r.received_at, 'YYYY-MM') = $1 AND m.tolerance_pct IS NOT NULL
       AND r.supplier_qty > 0 AND ABS(r.short_qty) / r.supplier_qty * 100 > m.tolerance_pct`,
    [month]
  );

  // 6-month cost/m3 trend (operator basis), this month and the 5 before it.
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(`${monthStart}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    const ym = d.toISOString().slice(0, 7);
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
router.get("/reports/stock-summary", requireRole(...ADMIN), async (req, res) => {
  const month = new Date().toISOString().slice(0, 7);

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
     LEFT JOIN LATERAL (SELECT SUM(r.accepted_qty) AS received_qty FROM rm_receipts r WHERE r.order_id = o.id) recv ON true
     WHERE o.status = 'approved'`
  );
  const openOrderBalanceValue = openOrders.reduce((sum, o) => sum + Math.max(0, Number(o.ordered_qty) - Number(o.received_qty)) * Number(o.rate), 0);

  const { rows: monthReceipts } = await query(
    `SELECT accepted_qty_kg, landed_rate_per_kg, debit_note_amount FROM rm_receipts WHERE to_char(received_at, 'YYYY-MM') = $1`,
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
