import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth, requireRole, isAdminLevel } from "../middleware/auth.js";
import { SLOT_BY_KEY } from "../lib/plantSlots.js";
// Round 187 — re-attribute refillable-silo batches after a receipt's fill moves.
import { reresolveSilos } from "./plant.js";
// Round 146 — every route below now carries BOTH its original requireRole and
// a requirePermission. A request must satisfy both, so granting somebody a
// permission can never let them past a role guard: this can only tighten
// access, never loosen it.
import { requirePermission, requireAnyPermission, can } from "../lib/permissions.js";
import { pushToRole, pushToUser } from "../lib/push.js";
// Round 194 — a GRN hands the lab its test cards.
import { issueCardsForReceipt } from "../lib/rmTestCards.js";
import { istDay, istMonth, istDaysAgo, daysElapsedIn } from "../lib/istDate.js";
import { buildLedgers, creditCheck, receiptBillAmount, addDays } from "../lib/supplierLedger.js";
// Round 186 (v10.15 hotfix) — plantConsumptionByMaterialMonth added here. Round
// 185's bookStockRows() called it without importing it, so every caller (Stock
// tab, stock-summary KPIs, Cost Dashboard) threw a ReferenceError at request
// time. check-boot only imports modules, it never runs a handler, so it passed.
import { plantConsumptionByMaterial, plantConsumptionByMaterialMonth, plantProductionM3, CONSUMPTION_CUTOVER, firstOfNextMonth, nextDay, productionM3Range, consumptionByMaterialMonthRange } from "../lib/plantConsumption.js";

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
// Round 192 — the role lists above are kept for the handlers that still read
// them, but no route is guarded by them any more: the permission is the gate
// (see lib/permissions.js). The materials and suppliers lists also sit behind
// the Weighbridge Records filters, so either module's key reads them.
const MATERIALS_LIST_KEYS = ["material.materials", "weighbridge.records", "material.weighbridge-mapping"];
const SUPPLIERS_LIST_KEYS = ["material.suppliers", "weighbridge.records", "material.weighbridge-mapping"];
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

router.get("/materials", requireAnyPermission(MATERIALS_LIST_KEYS, "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM rm_materials WHERE is_active OR $1 ORDER BY category, name`,
    [isAdminLevel(req.user.role)]
  );
  // Store never sees valuation — enforced here, not just left out of the UI.
  const sanitized = isStore(req) ? rows.map(({ opening_stock_rate_per_kg, ...rest }) => rest) : rows;
  res.json(sanitized);
});

router.post("/materials", requirePermission("material.materials", "create"), async (req, res) => {
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
  // Round 189 — every material has at least one source, so an order can always
  // name one. Materials bought by weight never need another.
  await query(
    `INSERT INTO rm_material_sources (material_id, name, purchase_unit, kg_per_purchase_unit, is_default, created_by)
     VALUES ($1, 'Standard', $2, $3, true, $4)`,
    [rows[0].id, purchase_unit.trim(), kg_per_purchase_unit, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// ===================== Material sources (Round 189, v10.18) =====================
// Where a material is quarried or made. The SOURCE decides how many kg one
// purchase unit weighs (20 MM from one quarry weighs differently per CFT than
// from another); the SUPPLIER decides the price. Stock, silos, consumption and
// the physical count stay per MATERIAL — the yard holds one pile of 20 MM
// whichever quarry it came from. A changed conversion applies to new receipts
// only; a receipt keeps the kg it was booked at.
router.get("/material-sources", requirePermission("material.materials", "view"), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.material_id) { params.push(Number(req.query.material_id)); where = `s.material_id = $1`; }
  const { rows } = await query(
    `SELECT s.*, m.name AS material_name,
            (SELECT string_agg(DISTINCT sp.name, ', ' ORDER BY sp.name)
               FROM rm_supplier_rates sr JOIN rm_suppliers sp ON sp.id = sr.supplier_id
              WHERE sr.source_id = s.id AND sr.valid_to IS NULL AND sr.is_active) AS suppliers
       FROM rm_material_sources s JOIN rm_materials m ON m.id = s.material_id
      WHERE ${where}
      ORDER BY m.name, s.is_default DESC, s.name`,
    params
  );
  res.json(rows);
});

function cleanSource(body) {
  const out = {};
  if (body.name !== undefined) {
    const n = String(body.name || "").trim();
    if (!n) throw new Error("Give the source a name.");
    out.name = n.slice(0, 120);
  }
  if (body.place !== undefined) out.place = String(body.place || "").trim().slice(0, 120) || null;
  if (body.purchase_unit !== undefined) {
    const u = String(body.purchase_unit || "").trim();
    if (!u) throw new Error("Purchase unit is required (e.g. CFT, MT).");
    out.purchase_unit = u.slice(0, 20);
  }
  if (body.kg_per_purchase_unit !== undefined) {
    const k = Number(body.kg_per_purchase_unit);
    if (!Number.isFinite(k) || k <= 0) throw new Error("Enter how many kg one unit weighs from this source.");
    out.kg_per_purchase_unit = k;
  }
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  return out;
}

router.post("/materials/:id/sources", requirePermission("material.materials", "create"), async (req, res) => {
  let v;
  try { v = cleanSource({ name: "", purchase_unit: "", kg_per_purchase_unit: 0, ...req.body }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const materialId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (req.body.is_default) await client.query(`UPDATE rm_material_sources SET is_default = false WHERE material_id = $1`, [materialId]);
    const { rows } = await client.query(
      `INSERT INTO rm_material_sources (material_id, name, place, purchase_unit, kg_per_purchase_unit, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [materialId, v.name, v.place ?? null, v.purchase_unit, v.kg_per_purchase_unit, !!req.body.is_default, req.user.id]
    );
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") return res.status(409).json({ error: "This material already has a source with that name." });
    if (err.code === "23503") return res.status(404).json({ error: "No such material." });
    throw err;
  } finally { client.release(); }
});

router.patch("/material-sources/:id", requirePermission("material.materials", "edit"), async (req, res) => {
  let v;
  try { v = cleanSource(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: cur } = await client.query(`SELECT * FROM rm_material_sources WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "No such source." }); }
    if (v.is_active === false && cur[0].is_default && !req.body.is_default) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Make another source the default before switching this one off." });
    }
    if (req.body.is_default === true) {
      await client.query(`UPDATE rm_material_sources SET is_default = false WHERE material_id = $1 AND id <> $2`, [cur[0].material_id, id]);
      v.is_default = true;
      v.is_active = true;
    }
    const keys = Object.keys(v);
    if (keys.length) {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`);
      await client.query(`UPDATE rm_material_sources SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => v[k])]);
    }
    await client.query("COMMIT");
    const { rows } = await query(`SELECT * FROM rm_material_sources WHERE id = $1`, [id]);
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") return res.status(409).json({ error: "This material already has a source with that name." });
    throw err;
  } finally { client.release(); }
});

// The current rate card for one source: which suppliers bring it, at what
// rate and scope. Feeds the order form's supplier list.
router.get("/material-sources/:id/rates", requirePermission("material.supplier-rates", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT sr.id, sr.supplier_id, sp.name AS supplier_name, sr.scope, sr.rate,
            to_char(sr.valid_from, 'YYYY-MM-DD') AS valid_from
       FROM rm_supplier_rates sr JOIN rm_suppliers sp ON sp.id = sr.supplier_id
      WHERE sr.source_id = $1 AND sr.valid_to IS NULL AND sr.is_active AND sp.is_active
      ORDER BY sr.rate, sp.name`,
    [req.params.id]
  );
  res.json(rows);
});

async function defaultSourceId(materialId, q = query) {
  const { rows } = await q(
    `SELECT id FROM rm_material_sources WHERE material_id = $1 AND is_active ORDER BY is_default DESC, id LIMIT 1`,
    [materialId]
  );
  return rows[0]?.id || null;
}

async function checkSource(sourceId, materialId) {
  const { rows } = await query(`SELECT id, is_active FROM rm_material_sources WHERE id = $1 AND material_id = $2`, [sourceId, materialId]);
  if (!rows.length) return "That source does not belong to this material.";
  if (!rows[0].is_active) return "That source is switched off.";
  return null;
}

// ===================== Purchase units per material (item 4, round 140) =====================
// rm_materials.purchase_unit/kg_per_purchase_unit stay the single live
// conversion everything else (orders/receipts/consumption/stock) reads —
// resolved live at receipt time, per the mockup's own "changing a conversion
// affects future receipts only; past receipts keep the value used at the
// time" rule. Marking a unit here default writes through to those two
// columns; this table is the reference/management layer on top.
router.get("/materials/:id/units", requirePermission("material.units", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM rm_material_units WHERE material_id = $1 AND (is_active OR $2) ORDER BY is_default DESC, unit_name`,
    [req.params.id, isAdminLevel(req.user.role)]
  );
  res.json(rows);
});

router.post("/materials/:id/units", requirePermission("material.units", "create"), async (req, res) => {
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

router.patch("/materials/:id/units/:unitId", requirePermission("material.units", "edit"), async (req, res) => {
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

router.delete("/materials/:id/units/:unitId", requirePermission("material.units", "delete"), async (req, res) => {
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

router.patch("/materials/:id", requirePermission("material.materials", "edit"), async (req, res) => {
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

router.get("/suppliers", requireAnyPermission(SUPPLIERS_LIST_KEYS, "view"), async (req, res) => {
  const { rows } = await query(`SELECT * FROM rm_suppliers WHERE is_active OR $1 ORDER BY name`, [isAdminLevel(req.user.role)]);
  res.json(rows);
});

// Round 193 — credit terms. Blank clears; anything else must be a whole number
// of days / a non-negative amount. Returns undefined after answering a 400.
function creditTerms(body, res) {
  const out = {};
  for (const [f, label, whole] of [["credit_days", "Credit days", true], ["credit_limit", "Credit limit", false]]) {
    if (body[f] === undefined) continue;
    const raw = body[f];
    if (raw === null || String(raw).trim() === "") { out[f] = null; continue; }
    const n = Number(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) {
      res.status(400).json({ error: `${label} must be ${whole ? "a whole number of days" : "an amount"} of 0 or more.` });
      return undefined;
    }
    out[f] = n;
  }
  return out;
}

router.post("/suppliers", requirePermission("material.suppliers", "create"), async (req, res) => {
  const { name, contact_person, phone, address, gstin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Supplier name is required." });
  const terms = creditTerms(req.body, res);
  if (terms === undefined) return;
  const { rows } = await query(
    `INSERT INTO rm_suppliers (name, contact_person, phone, address, gstin, created_by, credit_days, credit_limit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name.trim(), contact_person || null, phone || null, address || null, gstin || null, req.user.id,
      terms.credit_days ?? null, terms.credit_limit ?? null]
  );
  res.status(201).json(rows[0]);
});

router.patch("/suppliers/:id", requirePermission("material.suppliers", "edit"), async (req, res) => {
  const fields = ["name", "contact_person", "phone", "address", "gstin", "is_active"];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
  }
  const terms = creditTerms(req.body, res);
  if (terms === undefined) return;
  for (const [f, v] of Object.entries(terms)) { params.push(v); sets.push(`${f} = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  params.push(req.params.id);
  const { rows } = await query(`UPDATE rm_suppliers SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows.length) return res.status(404).json({ error: "Supplier not found." });
  res.json(rows[0]);
});

// ===================== Supplier ledger & payments (Round 193) =====================
// Built by lib/supplierLedger.js — see its header for the rules. Read access is
// material.supplier-ledger; recording a payment or an opening balance is
// material.supplier-payments create, cancelling a payment its delete.

function ledgerDate(v, fallback) {
  const s = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

router.get("/supplier-ledger", requirePermission("material.supplier-ledger", "view"), async (req, res) => {
  const asOn = ledgerDate(req.query.as_on, istDay());
  const all = await buildLedgers({ asOn });
  const suppliers = all
    .filter((l) => l.supplier.is_active || l.balance !== 0 || l.not_billed_count)
    .map((l) => ({ ...l, lines: undefined, open_bills: undefined,
      not_billed: undefined, open_bill_count: l.open_bills.length }));
  const sum = (f) => Math.round(suppliers.reduce((t, x) => t + f(x), 0) * 100) / 100;
  const pendingLoads = all.flatMap((l) => l.not_billed.map((n) => ({ ...n, supplier_id: l.supplier.id, supplier_name: l.supplier.name })));
  const oldest = pendingLoads.reduce((m, n) => Math.max(m, n.days_waiting || 0), 0);
  const { rows: month } = await query(
    `SELECT COALESCE(SUM(amount + tds_amount), 0) AS paid, COUNT(*)::int AS n FROM rm_supplier_payments
      WHERE cancelled_at IS NULL AND to_char(paid_on, 'YYYY-MM') = $1 AND paid_on <= $2::date`,
    [asOn.slice(0, 7), asOn]
  );
  res.json({
    as_on: asOn,
    suppliers,
    totals: {
      opening: sum((x) => x.opening_signed), purchases: sum((x) => x.purchases), paid: sum((x) => x.paid),
      balance: sum((x) => x.balance), payable: sum((x) => Math.max(x.balance, 0)), advance: sum((x) => Math.max(-x.balance, 0)),
      overdue: sum((x) => x.overdue), due_7_days: sum((x) => x.due_7_days), not_billed: sum((x) => x.not_billed_value),
      not_billed_count: pendingLoads.length, oldest_not_billed_days: oldest,
      paid_this_month: Number(month[0].paid), payments_this_month: month[0].n,
    },
    pending_loads: pendingLoads,
  });
});

router.get("/supplier-ledger/:supplierId", requirePermission("material.supplier-ledger", "view"), async (req, res) => {
  const supplierId = Number(req.params.supplierId);
  if (!Number.isInteger(supplierId)) return res.status(400).json({ error: "Invalid supplier." });
  const to = ledgerDate(req.query.to, istDay());
  const [l] = await buildLedgers({ supplierIds: [supplierId], asOn: to });
  if (!l) return res.status(404).json({ error: "Supplier not found." });
  const from = ledgerDate(req.query.from, l.lines[0]?.date || to);
  // Lines before the period fold into one "brought forward" figure.
  const before = l.lines.filter((x) => x.date < from);
  const inPeriod = l.lines.filter((x) => x.date >= from);
  const bf = before.length ? before[before.length - 1].balance : 0;
  const periodDebit = inPeriod.reduce((t, x) => t + x.debit, 0);
  const periodCredit = inPeriod.reduce((t, x) => t + x.credit, 0);
  res.json({
    ...l, from, to,
    brought_forward: before.length ? bf : null,
    lines: inPeriod,
    period_debit: Math.round(periodDebit * 100) / 100,
    period_credit: Math.round(periodCredit * 100) / 100,
  });
});

// The figures behind the credit-limit warning on a new order.
router.get("/supplier-ledger/:supplierId/credit-status", requireAnyPermission(["material.orders", "material.supplier-ledger"], "view"), async (req, res) => {
  const c = await creditCheck(req.params.supplierId, istDay(), Number(req.query.order_value || 0));
  if (!c) return res.status(404).json({ error: "Supplier not found." });
  res.json(c);
});

router.post("/supplier-ledger/:supplierId/payments", requirePermission("material.supplier-payments", "create"), async (req, res) => {
  const supplierId = Number(req.params.supplierId);
  const b = req.body || {};
  const amount = Number(String(b.amount ?? "").replace(/,/g, ""));
  const tds = b.tds_amount === undefined || b.tds_amount === "" ? 0 : Number(String(b.tds_amount).replace(/,/g, ""));
  const mode = String(b.mode || "").toLowerCase();
  const paidOn = ledgerDate(b.paid_on, null);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Enter the amount paid." });
  if (!Number.isFinite(tds) || tds < 0) return res.status(400).json({ error: "TDS must be 0 or more." });
  if (!["neft", "rtgs", "cheque", "upi", "cash", "other"].includes(mode)) return res.status(400).json({ error: "Choose how it was paid." });
  if (!paidOn) return res.status(400).json({ error: "Enter the payment date." });
  if (paidOn > istDay()) return res.status(400).json({ error: "The payment date can't be in the future." });
  if (["neft", "rtgs", "cheque", "upi"].includes(mode) && !String(b.reference || "").trim()) {
    return res.status(400).json({ error: "Enter the UTR / cheque / UPI reference." });
  }

  // Allocations must name this supplier's own open bills, and cannot settle
  // more than a bill still owes or more than the payment itself.
  const [l] = await buildLedgers({ supplierIds: [supplierId], asOn: istDay() });
  if (!l) return res.status(404).json({ error: "Supplier not found." });
  const allocations = [];
  let allocTotal = 0;
  for (const a of Array.isArray(b.allocations) ? b.allocations : []) {
    const amt = Number(String(a.amount ?? "").replace(/,/g, ""));
    if (!amt) continue;
    const bill = l.open_bills.find((x) => x.kind === a.kind && Number(x.id) === Number(a.id));
    if (!bill) return res.status(400).json({ error: "One of the bills is not open for this supplier any more — reload and try again." });
    if (amt < 0 || amt > bill.outstanding + 0.005) return res.status(400).json({ error: `${bill.no} only has ₹${bill.outstanding.toLocaleString("en-IN")} left to settle.` });
    allocTotal += amt;
    allocations.push({ kind: a.kind, id: Number(a.id), amount: amt });
  }
  if (allocTotal > amount + tds + 0.005) return res.status(400).json({ error: "The bills settled add up to more than the payment." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO rm_supplier_payments (supplier_id, paid_on, amount, tds_amount, mode, reference, bank_account, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [supplierId, paidOn, amount, tds, mode, String(b.reference || "").trim() || null,
        String(b.bank_account || "").trim() || null, String(b.notes || "").trim() || null, req.user.id]
    );
    for (const a of allocations) {
      await client.query(
        `INSERT INTO rm_payment_allocations (payment_id, receipt_id, opening_bill_id, amount) VALUES ($1,$2,$3,$4)`,
        [rows[0].id, a.kind === "receipt" ? a.id : null, a.kind === "opening" ? a.id : null, a.amount]
      );
    }
    await client.query(
      `INSERT INTO rm_supplier_ledger_log (supplier_id, action, detail, changed_by) VALUES ($1,'payment',$2,$3)`,
      [supplierId, JSON.stringify({ payment_id: rows[0].id, amount, tds, mode, paid_on: paidOn, allocations }), req.user.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ ...rows[0], allocations });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

router.post("/supplier-payments/:id/cancel", requirePermission("material.supplier-payments", "delete"), async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Say why the payment is being cancelled." });
  const { rows } = await query(
    `UPDATE rm_supplier_payments SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
      WHERE id = $1 AND cancelled_at IS NULL RETURNING *`,
    [req.params.id, req.user.id, reason]
  );
  if (!rows.length) return res.status(404).json({ error: "Payment not found, or already cancelled." });
  await query(
    `INSERT INTO rm_supplier_ledger_log (supplier_id, action, detail, changed_by) VALUES ($1,'payment_cancelled',$2,$3)`,
    [rows[0].supplier_id, JSON.stringify({ payment_id: rows[0].id, amount: rows[0].amount, reason }), req.user.id]
  );
  res.json({ ok: true });
});

// Set (or replace) a supplier's opening balance: one total, or bill by bill.
router.put("/supplier-ledger/:supplierId/opening", requirePermission("material.supplier-payments", "create"), async (req, res) => {
  const supplierId = Number(req.params.supplierId);
  const b = req.body || {};
  const asOn = ledgerDate(b.as_on, null);
  const direction = b.direction === "advance" ? "advance" : b.direction === "payable" ? "payable" : null;
  if (!asOn) return res.status(400).json({ error: "Enter the as-on date." });
  if (!direction) return res.status(400).json({ error: "Say whether we owe the supplier or paid an advance." });
  const bills = [];
  for (const x of Array.isArray(b.bills) ? b.bills : []) {
    const amt = Number(String(x.amount ?? "").replace(/,/g, ""));
    if (!amt) continue;
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: "Each amount must be more than 0." });
    const billDate = ledgerDate(x.bill_date, asOn);
    if (billDate > asOn) return res.status(400).json({ error: "A bill in the opening balance can't be dated after the as-on date." });
    bills.push({ bill_no: String(x.bill_no || "").trim() || null, bill_date: billDate, amount: amt });
  }
  if (!bills.length) return res.status(400).json({ error: "Enter the opening amount." });

  const { rows: supplier } = await query(`SELECT id FROM rm_suppliers WHERE id = $1`, [supplierId]);
  if (!supplier.length) return res.status(404).json({ error: "Supplier not found." });
  // Bills already settled by a payment can't be replaced underneath it.
  const { rows: used } = await query(
    `SELECT 1 FROM rm_payment_allocations a JOIN rm_supplier_opening_bills ob ON ob.id = a.opening_bill_id
       JOIN rm_supplier_payments pm ON pm.id = a.payment_id
      WHERE ob.supplier_id = $1 AND pm.cancelled_at IS NULL LIMIT 1`, [supplierId]
  );
  if (used.length) {
    return res.status(400).json({ error: "A payment has been settled against this opening balance. Cancel that payment first, then change the opening balance." });
  }
  const { rows: before } = await query(
    `SELECT o.as_on, o.direction, (SELECT json_agg(ob) FROM rm_supplier_opening_bills ob WHERE ob.supplier_id = o.supplier_id) AS bills
       FROM rm_supplier_openings o WHERE o.supplier_id = $1`, [supplierId]
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM rm_payment_allocations WHERE opening_bill_id IN (SELECT id FROM rm_supplier_opening_bills WHERE supplier_id = $1)`, [supplierId]);
    await client.query(`DELETE FROM rm_supplier_opening_bills WHERE supplier_id = $1`, [supplierId]);
    await client.query(
      `INSERT INTO rm_supplier_openings (supplier_id, as_on, direction, remarks, set_by, set_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (supplier_id) DO UPDATE SET as_on = EXCLUDED.as_on, direction = EXCLUDED.direction,
         remarks = EXCLUDED.remarks, set_by = EXCLUDED.set_by, set_at = now()`,
      [supplierId, asOn, direction, String(b.remarks || "").trim() || null, req.user.id]
    );
    for (const x of bills) {
      await client.query(
        `INSERT INTO rm_supplier_opening_bills (supplier_id, bill_no, bill_date, amount) VALUES ($1,$2,$3,$4)`,
        [supplierId, x.bill_no, x.bill_date, x.amount]
      );
    }
    await client.query(
      `INSERT INTO rm_supplier_ledger_log (supplier_id, action, detail, changed_by) VALUES ($1,'opening',$2,$3)`,
      [supplierId, JSON.stringify({ before: before[0] || null, after: { as_on: asOn, direction, bills } }), req.user.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

// A supplier may quote a material at both scopes (delivered / ex-factory),
// one CURRENT rate per scope — see schema.sql's comment on rm_supplier_rates.
// Round 140, item 2: rates are effective-dated, so this only returns each
// combination's still-open row (valid_to IS NULL) — the "as of right now"
// rate card. Full history is GET .../rates/history below.
router.get("/suppliers/:supplierId/rates", requirePermission("material.supplier-rates", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT sr.*, m.name AS material_name, COALESCE(src.purchase_unit, m.purchase_unit) AS purchase_unit,
            src.name AS source_name, src.kg_per_purchase_unit AS source_kg_per_unit
     FROM rm_supplier_rates sr JOIN rm_materials m ON m.id = sr.material_id
     LEFT JOIN rm_material_sources src ON src.id = sr.source_id
     WHERE sr.supplier_id = $1 AND sr.is_active AND sr.valid_to IS NULL
     ORDER BY m.name, src.name NULLS FIRST, sr.scope`,
    [req.params.supplierId]
  );
  res.json(rows);
});

// Full effective-dated history for this supplier (every material/scope),
// oldest first within each combination — feeds the mockup's "Rate history"
// button (item 2).
router.get("/suppliers/:supplierId/rates/history", requirePermission("material.supplier-rates", "view"), async (req, res) => {
  const params = [req.params.supplierId];
  let where = "sr.supplier_id = $1";
  if (req.query.material_id) { params.push(req.query.material_id); where += ` AND sr.material_id = $${params.length}`; }
  const { rows } = await query(
    `SELECT sr.*, m.name AS material_name, COALESCE(src.purchase_unit, m.purchase_unit) AS purchase_unit,
            src.name AS source_name, u.name AS updated_by_name
     FROM rm_supplier_rates sr
     JOIN rm_materials m ON m.id = sr.material_id
     LEFT JOIN rm_material_sources src ON src.id = sr.source_id
     LEFT JOIN users u ON u.id = sr.updated_by
     WHERE ${where}
     ORDER BY m.name, src.name NULLS FIRST, sr.scope, sr.valid_from`,
    params
  );
  res.json(rows);
});

// Setting a new rate closes whatever row was current (valid_to = the day
// before this one starts) and inserts a fresh row — never overwrites a past
// rate in place, so history stays intact and a "Rate history" view has
// something real to show (item 2). Orders still snapshot rm_orders.rate at
// order time, same as round 139 — nothing downstream needs to change.
router.post("/suppliers/:supplierId/rates", requirePermission("material.supplier-rates", "create"), async (req, res) => {
  const { material_id, scope, rate, valid_from } = req.body;
  if (!material_id) return res.status(400).json({ error: "Select a material." });
  if (!["delivered", "ex_factory"].includes(scope)) return res.status(400).json({ error: "Scope must be delivered or ex_factory." });
  if (!rate || Number(rate) <= 0) return res.status(400).json({ error: "Enter a valid rate." });
  // Round 189 — a rate is for supplier + material + SOURCE + scope.
  const sourceId = req.body.source_id ? Number(req.body.source_id) : await defaultSourceId(material_id);
  if (sourceId) { const bad = await checkSource(sourceId, material_id); if (bad) return res.status(400).json({ error: bad }); }

  const effectiveFrom = valid_from || istDay();
  const { rows } = await query(
    `UPDATE rm_supplier_rates SET valid_to = $1::date - INTERVAL '1 day'
     WHERE supplier_id = $2 AND material_id = $3 AND scope = $4 AND valid_to IS NULL
       AND source_id IS NOT DISTINCT FROM $5::int
     RETURNING id`,
    [effectiveFrom, req.params.supplierId, material_id, scope, sourceId]
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
    `INSERT INTO rm_supplier_rates (supplier_id, material_id, scope, rate, valid_from, valid_to, is_active, updated_by, source_id)
     VALUES ($1,$2,$3,$4,$5,NULL,true,$6,$7) RETURNING *`,
    [req.params.supplierId, material_id, scope, rate, effectiveFrom, req.user.id, sourceId]
  );
  res.status(201).json(created[0]);
});

router.get("/transporters", requirePermission("material.transporters", "view"), async (req, res) => {
  const { rows } = await query(`SELECT * FROM rm_transporters WHERE is_active OR $1 ORDER BY name`, [isAdminLevel(req.user.role)]);
  res.json(rows);
});

router.post("/transporters", requirePermission("material.transporters", "create"), async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Transporter name is required." });
  const { rows } = await query(`INSERT INTO rm_transporters (name, phone) VALUES ($1,$2) RETURNING *`, [name.trim(), phone || null]);
  res.status(201).json(rows[0]);
});

router.patch("/transporters/:id", requirePermission("material.transporters", "edit"), async (req, res) => {
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
router.get("/suppliers/:supplierId/transporters", requirePermission("material.transporters", "view"), async (req, res) => {
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

router.post("/suppliers/:supplierId/transporters", requirePermission("material.transporters", "create"), async (req, res) => {
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

router.post("/orders", requirePermission("material.orders", "create"), async (req, res) => {
  const { material_id, supplier_id, scope, transporter_id, ordered_qty, rate, freight_rate, freight_basis, tax_pct, gst_treatment, notes } = req.body;
  if (!material_id || !supplier_id) return res.status(400).json({ error: "Select a material and a supplier." });
  if (!["delivered", "ex_factory"].includes(scope)) return res.status(400).json({ error: "Scope must be delivered or ex_factory." });
  if (scope === "ex_factory" && !transporter_id) return res.status(400).json({ error: "Select a transporter for an ex-factory order." });
  if (!ordered_qty || Number(ordered_qty) <= 0) return res.status(400).json({ error: "Enter the quantity to order." });
  if (!rate || Number(rate) <= 0) return res.status(400).json({ error: "Enter the rate." });
  // Round 189 — the order names the SOURCE, which fixes the kg-per-unit its
  // receipts are converted at. No source given = the material's default.
  const sourceId = req.body.source_id ? Number(req.body.source_id) : await defaultSourceId(material_id);
  if (sourceId) { const bad = await checkSource(sourceId, material_id); if (bad) return res.status(400).json({ error: bad }); }

  const { rows } = await query(
    `INSERT INTO rm_orders
       (material_id, supplier_id, scope, transporter_id, ordered_qty, rate, freight_rate, freight_basis, tax_pct, gst_treatment, requested_by, notes, source_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [material_id, supplier_id, scope, transporter_id || null, ordered_qty, rate, freight_rate || null,
      freight_basis || null, tax_pct || 0, gst_treatment || "excluded", req.user.id, notes || null, sourceId]
  );

  const { rows: m } = await query(`SELECT name FROM rm_materials WHERE id = $1`, [material_id]);
  await pushToRole("administrator", {
    title: "New material order for approval",
    body: `${req.user.name} requested ${ordered_qty} of ${m[0]?.name || "a material"}`,
    url: "/material-module?tab=orders",
  });

  // Round 193 — over the supplier's credit limit only WARNS (owner's decision):
  // the order is saved either way and the screen shows the figures.
  let creditWarning = null;
  try {
    const value = Number(ordered_qty) * Number(rate) * (1 + Number(tax_pct || 0) / 100);
    const c = await creditCheck(supplier_id, istDay(), value);
    if (c && c.over_limit) creditWarning = c;
  } catch (err) { console.error("credit check", err); }

  res.status(201).json({ ...rows[0], credit_warning: creditWarning });
});

const ORDER_LIST_COLUMNS = `
  o.*, m.name AS material_name,
  COALESCE(src.purchase_unit, m.purchase_unit) AS purchase_unit,
  COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit) AS kg_per_purchase_unit,
  src.name AS source_name, src.place AS source_place,
  s.name AS supplier_name, t.name AS transporter_name,
  ru.name AS requested_by_name, au.name AS approved_by_name,
  COALESCE(recv.received_qty, 0) AS received_qty
`;
const ORDER_LIST_FROM = `
  FROM rm_orders o
  JOIN rm_materials m ON m.id = o.material_id
  LEFT JOIN rm_material_sources src ON src.id = o.source_id
  JOIN rm_suppliers s ON s.id = o.supplier_id
  LEFT JOIN rm_transporters t ON t.id = o.transporter_id
  JOIN users ru ON ru.id = o.requested_by
  LEFT JOIN users au ON au.id = o.approved_by
  LEFT JOIN LATERAL (
    SELECT SUM(r.accepted_qty) AS received_qty FROM rm_receipts_effective r WHERE r.order_id = o.id
  ) recv ON true
`;

router.get("/orders/mine", requirePermission("material.orders", "view"), async (req, res) => {
  const params = [req.user.id];
  let where = "o.requested_by = $1";
  // Round 192 — someone who can only VIEW orders (a Manager or Accountant
  // given the module read-only) never raises one, so "my orders" would always
  // be empty for them; they see all of them, as an Administrator does.
  if (isAdminLevel(req.user.role) || !(await can(req.user, "material.orders", "create"))) { where = "true"; params.length = 0; }
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM} WHERE ${where} ORDER BY o.requested_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

// Orders Store can currently receive against — approved, with something
// still outstanding. Used to populate the Receipts tab's order picker.
router.get("/orders/receivable", requirePermission("material.orders", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM}
     WHERE o.status = 'approved' AND COALESCE(recv.received_qty, 0) < o.ordered_qty
     ORDER BY o.approved_at DESC`
  );
  res.json(rows);
});

router.get("/orders/pending", requirePermission("material.order-approve", "edit"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_LIST_FROM} WHERE o.status = 'pending_approval' ORDER BY o.requested_at`
  );
  res.json(rows);
});

router.post("/orders/:id/approve", requirePermission("material.order-approve", "edit"), async (req, res) => {
  const { rows: existing } = await query(`SELECT * FROM rm_orders WHERE id = $1 AND status = 'pending_approval'`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Order not found or already actioned." });
  const { rows } = await query(
    `UPDATE rm_orders SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Material order approved", body: "Your order is approved and ready to receive.", url: "/material-module?tab=orders" });
  res.json(rows[0]);
});

router.post("/orders/:id/reject", requirePermission("material.order-approve", "edit"), async (req, res) => {
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
router.post("/orders/:id/close", requirePermission("material.orders", "delete"), async (req, res) => {
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
router.patch("/orders/:id", requirePermission("material.orders", "edit"), async (req, res) => {
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
router.get("/orders/:id/weighbridge-tickets", requirePermission("material.receipts", "create"), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: "Invalid order id." });
  try {
    const { rows } = await query(
      `SELECT wb.ticket_number, wb.weighed_at, wb.net_weight_kg, wb.empty_weight_kg, wb.loaded_weight_kg,
              wb.raw_vehicle, wb.challan_number, wb.purpose,
              COALESCE(v.registration, wb.raw_vehicle) AS vehicle_registration,
              COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit) AS kg_per_purchase_unit,
              -- Offered in the order's own purchase unit, because that is what
              -- Store types into the accepted-quantity box. Doing it here keeps
              -- the conversion in one place rather than in the screen. Round
              -- 189: the ORDER's source decides the kg per unit.
              ROUND((wb.net_weight_kg / NULLIF(COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit), 0))::numeric, 2) AS net_purchase_units
       FROM weighbridge_tickets wb
       JOIN rm_orders o ON o.id = $1
       JOIN rm_materials m ON m.id = o.material_id
       LEFT JOIN rm_material_sources src ON src.id = o.source_id
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

// Round 193 — the supplier's invoice date. Optional (the bill is dated on the
// arrival date when it is blank); a future date is refused like the arrival
// date. Returns the date string or null, or undefined after answering a 400.
function validateInvoiceDate(value, res) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const v = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { res.status(400).json({ error: "Invoice date must be a date." }); return undefined; }
  if (v > istDay()) { res.status(400).json({ error: "The invoice date can't be in the future." }); return undefined; }
  return v;
}

// ROUND 162 — the arrival date, validated in one place because both the create
// and the admin edit take it. Returns a YYYY-MM-DD string, or today when blank;
// answers the response itself and returns undefined when the date is bad, so
// the caller does `const d = validateReceivedDate(...); if (d === undefined) return;`.
function validateReceivedDate(value, res) {
  if (value === undefined || value === null || value === "") {
    // CURRENT_DATE would do it in SQL, but returning the string keeps the INSERT
    // parameter list uniform and lets the value be echoed back to the screen.
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD, IST
  }
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    res.status(400).json({ error: "Enter the arrival date as YYYY-MM-DD." });
    return undefined;
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (s > today) {
    res.status(400).json({ error: "A receipt cannot be dated in the future." });
    return undefined;
  }
  return s;
}

// ROUND 168 — the silos a receipt may be assigned to, for the receive form's
// dropdown. Every mapped hopper that is stock (a fixed material or refillable
// storage); the "not stock at all" ones are left out because a receipt would
// never go into one. material_id lets the form show only the silos that hold
// the material being received — cement into a cement silo, not a sand gate —
// while still allowing any as a fallback. Refillable silos carry no material_id
// of their own (they hold whatever was last put in), so the form matches those
// on the receipt's material against their most recent fill instead.
router.get("/receipt-silos", requirePermission("material.receipts", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT a.slot, a.slot_name, a.material_id, a.is_refillable, m.name AS material_name,
            (SELECT (array_agg(f.material_id ORDER BY f.filled_at DESC))[1]
               FROM plant_silo_fills f WHERE f.slot = a.slot) AS last_fill_material_id
       FROM plant_silo_aliases a
       LEFT JOIN rm_materials m ON m.id = a.material_id
      WHERE a.is_ignored = false
      ORDER BY a.slot`
  );
  res.json(rows.map((r) => ({
    slot: r.slot,
    slot_name: r.slot_name,
    label: SLOT_BY_KEY[r.slot]?.label || r.slot,
    kind: SLOT_BY_KEY[r.slot]?.kind || null,
    is_refillable: r.is_refillable,
    // The material this silo effectively holds: its fixed mapping, or for a
    // refillable silo the material of its most recent fill.
    material_id: r.material_id || r.last_fill_material_id || null,
    material_name: r.material_name || null,
  })));
});

router.post("/receipts", requirePermission("material.receipts", "create"), async (req, res) => {
  const { order_id, supplier_qty, weighbridge_weight_kg, accepted_qty, transporter_id, freight_rate, freight_basis, vehicle_number, challan_number, debit_note_amount, notes, weighbridge_ticket_id, short_reason, received_date, silo_slot, not_in_silo, invoice_date } = req.body;
  if (!order_id) return res.status(400).json({ error: "Select the order this receipt is against." });

  // ROUND 168 — where this load goes: into a silo, or explicitly not into one.
  //
  // notInSilo wins if set (a drum of admixture bound for the lab, or held in the
  // store): the receipt is recorded and counts as stock bought, but adds to no
  // silo and shows in its own "not in silo" list. Otherwise, if a silo is named,
  // the load fills that hopper and a plant_silo_fills row is written alongside
  // the receipt so the silo's level and — for a refillable silo — its
  // material-at-time timeline both move from this one action. A receipt with
  // neither is left untracked, exactly as before this round: nothing forces a
  // silo here, so diesel, oil and the like still post cleanly.
  const notInSilo = not_in_silo === true;
  let siloSlot = null;
  if (!notInSilo && silo_slot !== undefined && silo_slot !== null && String(silo_slot).trim() !== "") {
    siloSlot = String(silo_slot).trim();
    if (!Object.prototype.hasOwnProperty.call(SLOT_BY_KEY, siloSlot)) {
      return res.status(400).json({ error: "That is not a silo this plant has." });
    }
  }
  if (!supplier_qty || Number(supplier_qty) <= 0) return res.status(400).json({ error: "Enter the supplier's invoice/DC quantity." });

  // ROUND 162 — the arrival date. Left blank it is today; a back-dated entry
  // sets it to when the load actually arrived, and everything economic (stock,
  // the weighted-average rate, the month it counts in) keys on this rather than
  // on when the row was typed. A future date is refused — a receipt is a record
  // of something that has happened, and a load dated next week is a typo that
  // would quietly distort next month's opening stock.
  const receivedDate = validateReceivedDate(received_date, res);
  if (receivedDate === undefined) return; // validator already answered

  const { rows: orders } = await query(
    `SELECT o.*, COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit) AS kg_per_purchase_unit, m.tolerance_pct
     FROM rm_orders o JOIN rm_materials m ON m.id = o.material_id
     LEFT JOIN rm_material_sources src ON src.id = o.source_id
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
  // Round 193 — what the supplier is owed for this load: the ACCEPTED quantity,
  // never the invoice's (owner's rule). Fixed here so a later order revision
  // never rewrites a bill already in the ledger.
  const billAmount = receiptBillAmount({ scope: order.scope, rate: order.rate, taxPct: order.tax_pct,
    acceptedQty: finalAcceptedQty, acceptedQtyKg, freightRate: useFreightRate, freightBasis: useFreightBasis });
  const invoiceDate = validateInvoiceDate(invoice_date, res);
  if (invoiceDate === undefined) return;

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

  // ROUND 168 — the receipt and (when a silo is named) its fill are written in
  // ONE transaction. They are two facts about a single event — this load
  // arrived, and it went into that hopper — and stock would be wrong if one
  // landed without the other. A pending receipt (beyond tolerance, awaiting a
  // Manager) does NOT create a fill: it counts for nothing until confirmed, and
  // the silo level draws from confirmed loads only, matching the effective view.
  const client = await pool.connect();
  let rows;
  try {
    await client.query("BEGIN");
    ({ rows } = await client.query(
      `INSERT INTO rm_receipts   -- receipts-raw: the write itself
         (order_id, supplier_qty, weighbridge_weight_kg, accepted_qty, accepted_qty_kg, transporter_id,
          freight_rate, freight_basis, vehicle_number, challan_number, short_qty, debit_note_amount,
          landed_rate_per_kg, received_by, notes, weighbridge_ticket_id, short_reason,
          accepted_basis, variance_qty, variance_pct, confirmation_status, received_date,
          silo_slot, not_in_silo, bill_amount, invoice_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
      [order_id, supplier_qty, weighbridge_weight_kg || null, finalAcceptedQty, acceptedQtyKg,
        transporter_id || order.transporter_id || null, useFreightRate || null, useFreightBasis || null,
        vehicle_number || null, challan_number || null, shortQty, debit_note_amount || null,
        landedRatePerKg, req.user.id, notes || null, ticketId, String(short_reason || "").trim() || null,
        acceptedBasis, varianceQty, variancePct, confirmationStatus, receivedDate,
        siloSlot, notInSilo, billAmount, invoiceDate]
    ));

    if (siloSlot && !needsConfirmation) {
      // filled_at keys on the arrival date, not the typing time, so a back-dated
      // receipt sits at the right point in the silo's timeline (see
      // siloMaterialAt in routes/plant.js). Time is left at IST midnight of that
      // date, which is fine: fills and batches are ordered by day here.
      await client.query(
        `INSERT INTO plant_silo_fills
           (slot, material_id, receipt_id, filled_at, qty_kg, was_empty, balance_before_kg, notes, recorded_by)
         VALUES ($1,$2,$3,$4::date::timestamptz,$5,false,NULL,$6,$7)`,
        [siloSlot, order.material_id, rows[0].id, receivedDate, acceptedQtyKg,
          "From receipt #" + rows[0].id, req.user.id]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ROUND 194 — the lab's test cards for this load, from the material's test
  // plan (lib/rmTestCards.js). AFTER the commit and outside it on purpose: the
  // receipt is the record of a lorry that has arrived and must never fail
  // because card issuing did. A disputed (pending) load still gets its cards —
  // the material is in the yard either way.
  let testCards = [];
  try {
    testCards = await issueCardsForReceipt(rows[0].id, req.user.id);
  } catch (err) {
    console.error("Lab test cards for receipt", rows[0].id, "failed:", err.message);
  }

  res.status(201).json({
    ...rows[0],
    test_cards_issued: testCards.length,
    received_date: receivedDate,   // the validated string, not the pg Date
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
router.patch("/receipts/:id", requirePermission("material.receipts", "edit"), async (req, res) => {
  const { rows: existingRows } = await query(
    `SELECT r.*, o.rate AS order_rate, o.gst_treatment, o.tax_pct, o.material_id AS order_material_id, o.scope AS order_scope,
            to_char(r.received_date, 'YYYY-MM-DD') AS received_date_str,
            to_char(r.invoice_date, 'YYYY-MM-DD') AS invoice_date_str
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

  // ROUND 162 — the arrival date can be corrected too. Omitted, the existing
  // date is kept; a bad or future date is refused by the shared validator.
  let receivedDate = existing.received_date_str || existing.received_date;
  if (req.body.received_date !== undefined) {
    const d = validateReceivedDate(req.body.received_date, res);
    if (d === undefined) return;
    receivedDate = d;
  }

  // ROUND 162 — unlink or relink the weighbridge ticket. This is the admin's
  // remedy for a receipt tied to the wrong ticket: passing "" or null unlinks
  // it (which frees that ticket to be claimed by the right receipt); passing a
  // ticket number relinks, but only to a matched ticket no OTHER receipt holds,
  // the same guard the create path applies — an unguarded relink would
  // double-credit one weighed load into stock twice.
  let ticketId = existing.weighbridge_ticket_id;
  if (req.body.weighbridge_ticket_id !== undefined) {
    const raw = req.body.weighbridge_ticket_id;
    if (raw === null || raw === "" ) {
      ticketId = null;
    } else {
      const want = Number(raw);
      if (!Number.isInteger(want)) return res.status(400).json({ error: "Invalid weighbridge ticket number." });
      const { rows: tk } = await query(
        `SELECT wb.ticket_number, wb.match_status::text AS match_status, r.id AS claimed_by
           FROM weighbridge_tickets wb
           LEFT JOIN rm_receipts r ON r.weighbridge_ticket_id = wb.ticket_number AND r.id <> $2   -- receipts-raw: a pending receipt still claims its ticket
          WHERE wb.ticket_number = $1`,
        [want, req.params.id]
      );
      if (!tk.length) return res.status(404).json({ error: `Weighbridge ticket #${want} does not exist.` });
      if (tk[0].match_status !== "matched") return res.status(409).json({ error: `Ticket #${want} is not matched yet, so it cannot be linked.` });
      if (tk[0].claimed_by) return res.status(409).json({ error: `Ticket #${want} is already linked to another receipt.` });
      ticketId = want;
    }
  }

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
  // Round 193 — the bill follows a corrected accepted quantity.
  const billAmount = receiptBillAmount({ scope: existing.order_scope, rate: existing.order_rate, taxPct: existing.tax_pct,
    acceptedQty, acceptedQtyKg, freightRate: merged.freight_rate, freightBasis: merged.freight_basis });
  let invoiceDate = existing.invoice_date_str || null;
  if (req.body.invoice_date !== undefined) {
    invoiceDate = validateInvoiceDate(req.body.invoice_date, res);
    if (invoiceDate === undefined) return;
  }

  // ROUND 187 (v10.16) — the silo can be corrected too: a silo slot, "not in a
  // silo", or neither. Omitted, the existing assignment is kept.
  let siloSlot = existing.silo_slot || null;
  let notInSilo = !!existing.not_in_silo;
  if (req.body.not_in_silo !== undefined || req.body.silo_slot !== undefined) {
    notInSilo = req.body.not_in_silo === true;
    const raw = req.body.silo_slot;
    siloSlot = (!notInSilo && raw !== undefined && raw !== null && String(raw).trim() !== "") ? String(raw).trim() : null;
    if (siloSlot && !Object.prototype.hasOwnProperty.call(SLOT_BY_KEY, siloSlot)) {
      return res.status(400).json({ error: "That is not a silo this plant has." });
    }
  }
  // The receipt's own silo fill must follow the receipt — its silo, its
  // quantity and its date. Rebuilt whenever the receipt has or had a silo, so a
  // corrected quantity or arrival date also corrects the silo level (Round 168's
  // noted limitation). A pending receipt never has a fill until it is confirmed.
  const touchesSilo = !!(existing.silo_slot || siloSlot);
  const siloChanged = (existing.silo_slot || null) !== siloSlot || !!existing.not_in_silo !== notInSilo;

  const client = await pool.connect();
  let rows;
  try {
    await client.query("BEGIN");
    ({ rows } = await client.query(
      `UPDATE rm_receipts SET   -- receipts-raw: the write itself
         supplier_qty = $1, weighbridge_weight_kg = $2, accepted_qty = $3, accepted_qty_kg = $4,
         transporter_id = $5, freight_rate = $6, freight_basis = $7, vehicle_number = $8, challan_number = $9,
         short_qty = $10, debit_note_amount = $11, landed_rate_per_kg = $12, notes = $13,
         received_date = $15, weighbridge_ticket_id = $16, silo_slot = $17, not_in_silo = $18,
         bill_amount = $19, invoice_date = $20
       WHERE id = $14 RETURNING *`,
      [supplierQty, merged.weighbridge_weight_kg || null, acceptedQty, acceptedQtyKg,
        merged.transporter_id || null, merged.freight_rate || null, merged.freight_basis || null,
        merged.vehicle_number || null, merged.challan_number || null, shortQty,
        merged.debit_note_amount || null, landedRatePerKg, merged.notes || null, req.params.id,
        receivedDate, ticketId, siloSlot, notInSilo, billAmount, invoiceDate]
    ));
    if (touchesSilo) {
      await client.query(`DELETE FROM plant_silo_fills WHERE receipt_id = $1`, [req.params.id]);
      if (siloSlot && existing.confirmation_status !== "pending") {
        await client.query(
          `INSERT INTO plant_silo_fills
             (slot, material_id, receipt_id, filled_at, qty_kg, was_empty, balance_before_kg, notes, recorded_by)
           VALUES ($1,$2,$3,$4::date::timestamptz,$5,false,NULL,$6,$7)`,
          [siloSlot, existing.order_material_id, req.params.id, receivedDate, acceptedQtyKg,
            "From receipt #" + req.params.id + " (edited)", req.user.id]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  // A refillable silo's contents are a timeline, so moving a fill changes what
  // the batches after it were made from. Best effort: the receipt is saved.
  if (touchesSilo) await reresolveSilos().catch((e) => console.error("reresolve after receipt edit", e));
  res.json({ ...rows[0], received_date: receivedDate, silo_changed: siloChanged });
});

router.delete("/receipts/:id", requirePermission("material.receipts", "delete"), async (req, res) => {
  // Round 187 — remove the receipt's own silo fill with it. The fills FK is
  // ON DELETE SET NULL, so without this a deleted receipt left its fill behind
  // still raising the silo's level.
  const { rowCount: fillsRemoved } = await query(`DELETE FROM plant_silo_fills WHERE receipt_id = $1`, [req.params.id]);
  // receipts-raw: the write itself
  const { rows } = await query(`DELETE FROM rm_receipts WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Receipt not found." });
  if (fillsRemoved) await reresolveSilos().catch((e) => console.error("reresolve after receipt delete", e));
  res.json({ deleted: true });
});

router.get("/receipts", requirePermission("material.receipts", "view"), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.user.role === "store") {
    params.push(req.user.id);
    where = `o.requested_by = $${params.length}`;
  }
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_date >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_date < $${params.length}::date + INTERVAL '1 day'`; }
  if (req.query.material_id) { params.push(req.query.material_id); where += ` AND o.material_id = $${params.length}`; }
  if (req.query.supplier_id) { params.push(req.query.supplier_id); where += ` AND o.supplier_id = $${params.length}`; }

  const { rows } = await query(
    `SELECT r.*, to_char(r.received_date,'YYYY-MM-DD') AS received_date,
            to_char(r.invoice_date,'YYYY-MM-DD') AS invoice_date,
            o.material_id, o.supplier_id, m.name AS material_name, m.purchase_unit,
            s.name AS supplier_name, t.name AS transporter_name, ru.name AS received_by_name,
            -- ROUND 162 — the weighbridge ticket this receipt was weighed on, so
            -- the screen can show the link (and its net weight) rather than just
            -- a bare id. Null for a delivery that never crossed the weighbridge.
            wb.net_weight_kg AS wb_net_weight_kg,
            wb.weighed_at    AS wb_weighed_at
     FROM rm_receipts r   -- receipts-raw: the receipts screen deliberately shows pending ones, flagged
     JOIN rm_orders o ON o.id = r.order_id
     JOIN rm_materials m ON m.id = o.material_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     LEFT JOIN rm_transporters t ON t.id = r.transporter_id
     LEFT JOIN weighbridge_tickets wb ON wb.ticket_number = r.weighbridge_ticket_id
     JOIN users ru ON ru.id = r.received_by
     WHERE ${where}
     ORDER BY r.received_date DESC, r.received_at DESC
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

router.get("/receipts/pending", requirePermission("material.receipt-confirm", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      // receipts-raw: this queue exists to show exactly the pending ones
      `SELECT r.id, r.received_at, to_char(r.received_date,'YYYY-MM-DD') AS received_date, r.supplier_qty, r.weighbridge_weight_kg, r.accepted_qty,
              r.variance_qty, r.variance_pct, r.short_reason, r.notes, r.challan_number,
              r.vehicle_number, r.accepted_basis,
              o.id AS order_id, o.rate AS order_rate,
              m.id AS material_id, m.name AS material_name, COALESCE(src.purchase_unit, m.purchase_unit) AS purchase_unit,
              COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit) AS kg_per_purchase_unit, m.tolerance_pct, src.name AS source_name,
              s.name AS supplier_name, ru.name AS received_by_name,
              -- What accepting each figure would actually mean in money, so the
              -- decision is not taken on quantities alone.
              round((r.supplier_qty * o.rate)::numeric, 2) AS value_if_supplier,
              round((r.accepted_qty * o.rate)::numeric, 2) AS value_if_weighed
       FROM rm_receipts r   -- receipts-raw: this queue exists to show exactly the pending ones
       JOIN rm_orders o ON o.id = r.order_id
       JOIN rm_materials m ON m.id = o.material_id
       LEFT JOIN rm_material_sources src ON src.id = o.source_id
       JOIN rm_suppliers s ON s.id = o.supplier_id
       JOIN users ru ON ru.id = r.received_by
       WHERE r.confirmation_status = 'pending'
       ORDER BY r.received_date ASC, r.received_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the receipts waiting for confirmation." });
  }
});

router.post("/receipts/:id/confirm", requirePermission("material.receipt-confirm", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid receipt id." });

  const basis = String(req.body?.basis || "").trim();
  if (!["weighed", "supplier", "entered"].includes(basis)) {
    return res.status(400).json({ error: "Say which figure stands: the weighed one, the supplier's, or a quantity you enter." });
  }

  try {
    const { rows: found } = await query(
      // receipts-raw: confirming is what takes a receipt out of 'pending'
      `SELECT r.*, o.rate AS order_rate, o.gst_treatment, o.tax_pct, o.scope AS order_scope, o.freight_rate AS order_freight_rate,
              o.freight_basis AS order_freight_basis, o.material_id AS order_material_id,
              COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit) AS kg_per_purchase_unit
       FROM rm_receipts r   -- receipts-raw: confirming is what takes a receipt out of 'pending'
       JOIN rm_orders o ON o.id = r.order_id
       JOIN rm_materials m ON m.id = o.material_id
       LEFT JOIN rm_material_sources src ON src.id = o.source_id
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
    // Round 193 — the bill is booked on the quantity that now stands.
    const billAmount = receiptBillAmount({ scope: r.order_scope, rate: r.order_rate, taxPct: r.tax_pct, acceptedQty, acceptedQtyKg,
      freightRate: r.freight_rate ?? r.order_freight_rate, freightBasis: r.freight_basis ?? r.order_freight_basis });
    const varianceQty = Number(r.supplier_qty) - acceptedQty;
    // Signed, to match the POST above and the back-fill in setup.js.
    const variancePct = Number(r.supplier_qty) > 0
      ? varianceQty / Number(r.supplier_qty) * 100 : 0;

    // ROUND 168 — the fill was deferred while this receipt was pending (a load
    // beyond tolerance counts for nothing until settled). Confirming it is the
    // moment it becomes real stock, so if it was assigned to a silo the fill is
    // created NOW, at the confirmed quantity, in the same transaction as the
    // settle. not_in_silo receipts never make one.
    const client = await pool.connect();
    let rows;
    try {
      await client.query("BEGIN");
      ({ rows } = await client.query(
        // receipts-raw: the write itself
        `UPDATE rm_receipts
            SET accepted_qty = $2, accepted_qty_kg = $3, landed_rate_per_kg = $4,
                short_qty = CASE WHEN $5::numeric > 0 THEN $5::numeric ELSE NULL END,
                variance_qty = $5, variance_pct = $6, accepted_basis = $7,
                confirmation_status = 'confirmed', confirmed_by = $8, confirmed_at = now(),
                confirm_note = $9, bill_amount = $10
          WHERE id = $1 AND confirmation_status = 'pending'
          RETURNING *`,
        [id, acceptedQty, acceptedQtyKg, landedRatePerKg, varianceQty,
         Number(variancePct.toFixed(3)), basis, req.user.id,
         String(req.body?.note || "").trim() || null, billAmount]
      ));
      if (rows.length && r.silo_slot && !r.not_in_silo) {
        await client.query(
          `INSERT INTO plant_silo_fills
             (slot, material_id, receipt_id, filled_at, qty_kg, was_empty, balance_before_kg, notes, recorded_by)
           VALUES ($1,$2,$3,$4::date::timestamptz,$5,false,NULL,$6,$7)`,
          [r.silo_slot, r.order_material_id, id, r.received_date, acceptedQtyKg,
            "From receipt #" + id + " (confirmed)", req.user.id]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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

// Round 177 — this is now a READ-ONLY view of the plant's ACTUAL consumption
// for the day (load-cell auto + operator manual, the single source that draws
// down stock from the cutover). Entry moved to the Plant Production screen; the
// hand-keyed rm_daily_consumption is no longer the stock driver. Returns, per
// material, the auto / manual / total kg for the chosen day, plus that day's
// production m³ (batched + manual) for context.
router.get("/consumption", requirePermission("material.consumption", "view"), async (req, res) => {
  const date = (req.query.date || istDay()).slice(0, 10);
  const dayEnd = nextDay(date);
  const [cons, prod, mats] = await Promise.all([
    plantConsumptionByMaterial({ from: date, toExclusive: dayEnd }),
    plantProductionM3({ from: date, toExclusive: dayEnd }),
    query(`SELECT id, name, purchase_unit, kg_per_purchase_unit FROM rm_materials WHERE is_active ORDER BY category, name`),
  ]);
  const materials = mats.rows.map((m) => {
    const c = cons.get(m.id) || { auto_kg: 0, manual_kg: 0, total_kg: 0 };
    return {
      material_id: m.id, name: m.name, purchase_unit: m.purchase_unit,
      kg_per_purchase_unit: Number(m.kg_per_purchase_unit),
      auto_kg: c.auto_kg || 0, manual_kg: c.manual_kg || 0, total_kg: c.total_kg || 0,
    };
  });
  res.json({ date, readonly: true, source: "plant", materials, production: prod });
});

router.post("/consumption", requirePermission("material.consumption", "create"), async (req, res) => {
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

router.get("/production", requirePermission("material.consumption", "view"), async (req, res) => {
  const date = req.query.date || istDay();
  const { rows } = await query(`SELECT * FROM rm_daily_production WHERE production_date = $1`, [date]);
  res.json(rows[0] || null);
});

router.post("/production", requirePermission("material.consumption", "create"), async (req, res) => {
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
    `SELECT to_char(date_trunc('month', r.received_date), 'YYYY-MM') AS ym,
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
  // Round 185 (#1) — book stock is anchored to the latest APPROVED physical
  // count per material: once a month is approved, that counted figure is the
  // opening for the NEXT month, and book stock is derived forward from there
  // (receipts − consumption since the anchor). A material with no approved count
  // falls back to its opening_stock_kg + all history. Everything is bucketed by
  // month and summed in JS, which also carries the Round 177 consumption cutover:
  // a month before CONSUMPTION_CUTOVER draws from the hand-keyed rm_daily_consumption,
  // a month on/after it from the PLANT's actual (load cell + manual) figure.
  const cutoverMonth = CONSUMPTION_CUTOVER.slice(0, 7);   // 'YYYY-MM'
  const curMonth = istMonth();                            // 'YYYY-MM'

  const [materials, recvByMonth, rmByMonth, plantByMonth, anchors] = await Promise.all([
    query(`SELECT * FROM rm_materials WHERE is_active ORDER BY category, name`),
    query(
      `SELECT o.material_id, to_char(r.received_date, 'YYYY-MM') AS ym, SUM(r.accepted_qty_kg)::numeric AS kg
         FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
        GROUP BY o.material_id, ym`),
    query(
      `SELECT c.material_id, to_char(c.consumption_date, 'YYYY-MM') AS ym,
              SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0))::numeric AS kg
         FROM rm_daily_consumption c GROUP BY c.material_id, ym`),
    plantConsumptionByMaterialMonth({ from: CONSUMPTION_CUTOVER }),
    // Latest APPROVED physical count per material → its anchor month (the month
    // the counted figure becomes the opening for = the month AFTER the count).
    query(
      `SELECT DISTINCT ON (material_id) material_id, physical_stock_kg,
              to_char((date_trunc('month', stock_month) + interval '1 month'), 'YYYY-MM') AS anchor_month
         FROM rm_monthly_physical_stock WHERE approved = true
        ORDER BY material_id, stock_month DESC`),
  ]);

  const recvMap = bucketMap(recvByMonth.rows);
  const rmMap = bucketMap(rmByMonth.rows);
  const anchorBy = new Map(anchors.rows.map((a) => [a.material_id, { kg: Number(a.physical_stock_kg) || 0, month: a.anchor_month }]));

  // Consumption for one month, from the right source given the cutover.
  const consumedIn = (mid, ym) => (ym < cutoverMonth
    ? (rmMap.get(mid)?.get(ym) || 0)
    : (plantByMonth.get(mid)?.get(ym) || 0));

  const rows = materials.rows.map((m) => {
    const anchor = anchorBy.get(m.id) || null;
    const baseKg = anchor ? anchor.kg : Number(m.opening_stock_kg) || 0;
    const startMonth = anchor ? anchor.month : null;   // null = from the beginning

    // Every month we have any receipt or consumption for this material.
    const months = new Set([...(recvMap.get(m.id)?.keys() || []), ...(rmMap.get(m.id)?.keys() || []), ...(plantByMonth.get(m.id)?.keys() || [])]);

    let received = 0, consumed = 0;
    for (const ym of months) {
      if (startMonth && ym < startMonth) continue;      // before the anchor — folded into baseKg
      received += recvMap.get(m.id)?.get(ym) || 0;
      consumed += consumedIn(m.id, ym);
    }
    return {
      ...m,
      base_kg: baseKg,                                   // anchor physical, else opening_stock_kg
      received_kg: Math.round(received * 100) / 100,
      consumed_kg: Math.round(consumed * 100) / 100,
      month_received_kg: Math.round((recvMap.get(m.id)?.get(curMonth) || 0) * 100) / 100,
      month_consumed_kg: Math.round(consumedIn(m.id, curMonth) * 100) / 100,
      stock_anchor_month: anchor ? anchor.month : null,
      stock_anchor_kg: anchor ? anchor.kg : null,
    };
  });
  return rows;
}

// Rows of { material_id, ym, kg } → Map(material_id -> Map(ym -> kg)).
function bucketMap(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.material_id)) out.set(r.material_id, new Map());
    out.get(r.material_id).set(r.ym, Number(r.kg) || 0);
  }
  return out;
}

router.get("/stock", requirePermission("material.stock", "view"), async (req, res) => {
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
    // Round 185 — base is the approved physical anchor when there is one, else
    // the material's opening_stock_kg; received_kg/consumed_kg are already
    // counted only since that anchor.
    const bookStockKg = Number(m.base_kg) + Number(m.received_kg) - Number(m.consumed_kg);
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
      // Round 185 — when book stock is anchored to an approved physical count,
      // say which month's count it was reset from (null otherwise).
      anchored_from: m.stock_anchor_month || null,
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
            (o.ordered_qty * COALESCE(src.kg_per_purchase_unit, m.kg_per_purchase_unit)) AS ordered_qty_kg,
            s.name AS supplier_name, o.scope::text AS scope,
            COALESCE(SUM(r.accepted_qty_kg), 0) AS received_kg,
            COALESCE(SUM(r.accepted_qty), 0) AS received_qty
     FROM rm_orders o
     JOIN rm_materials m ON m.id = o.material_id
     LEFT JOIN rm_material_sources src ON src.id = o.source_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     LEFT JOIN rm_receipts_effective r ON r.order_id = o.id
     WHERE o.status = 'approved'
     GROUP BY o.id, o.ordered_qty, m.id, m.name, m.purchase_unit, m.kg_per_purchase_unit, src.kg_per_purchase_unit, s.name, o.scope
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

router.post("/physical-stock", requirePermission("material.physical-stock", "create"), async (req, res) => {
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

// Round 185 (#1) — Administrator approves (or un-approves) a material's monthly
// physical count. An approved count becomes the OPENING for the next month: book
// stock re-anchors to the counted figure, absorbing the variance. Admin only,
// since it moves stock valuation. Editing the count again (POST above) does not
// clear approval on its own, so re-approve after a correction if needed.
router.post("/physical-stock/approve", requirePermission("material.physical-stock-approve", "edit"), async (req, res) => {
  const { material_id, stock_month } = req.body;
  if (!material_id || !stock_month) return res.status(400).json({ error: "material_id and stock_month are required." });
  const monthDate = `${String(stock_month).slice(0, 7)}-01`;
  const setApproved = req.body.approved !== false;   // default true; pass approved:false to un-approve
  // Round 186 (v10.15 hotfix) — explicit casts. Inside a CASE, Postgres cannot
  // infer $4's type from the column it is assigned to, so it defaulted to text
  // and the UPDATE failed (42804 "approved_by is of type integer but expression
  // is of type text") — the Approve button 500'd on every click.
  const { rows } = await query(
    `UPDATE rm_monthly_physical_stock
        SET approved    = $3::boolean,
            approved_by = CASE WHEN $3::boolean THEN $4::integer ELSE NULL END,
            approved_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
      WHERE material_id = $1 AND stock_month = $2::date
      RETURNING id, approved`,
    [material_id, monthDate, setApproved, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "No physical count on file for that material and month — enter the count first." });
  res.json({ ok: true, approved: rows[0].approved });
});

router.get("/physical-stock", requirePermission("material.physical-stock", "view"), async (req, res) => {
  const month = (req.query.month || istMonth()).slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEnd = firstOfNextMonth(monthStart);
  const maySeeValuation = await can(req.user, "material.stock-valuation", "view");

  // Round 177 — plant-actual consumption (load cells + manual) from the cutover.
  // Opening uses plant-actual for the stretch between the cutover and the month
  // being counted; the month itself uses plant-actual when it is on/after the
  // cutover, else the old hand-keyed figure. The cutover is a month boundary, so
  // the counted month is wholly one side or the other.
  const plantBeforeMonth = await plantConsumptionByMaterial({ from: CONSUMPTION_CUTOVER, toExclusive: monthStart });
  const plantThisMonth = monthStart >= CONSUMPTION_CUTOVER
    ? await plantConsumptionByMaterial({ from: monthStart, toExclusive: monthEnd })
    : new Map();

  // Round 185 (#1) — the opening of the counted month chains from the latest
  // APPROVED physical count strictly before it: once a month is approved, that
  // figure IS the opening going forward. anchor_date = first day of the month
  // after the approved count.
  const { rows: anchorRows } = await query(
    `SELECT DISTINCT ON (material_id) material_id, physical_stock_kg,
            to_char((date_trunc('month', stock_month) + interval '1 month'), 'YYYY-MM-DD') AS anchor_date
       FROM rm_monthly_physical_stock
      WHERE approved = true AND stock_month < $1::date
      ORDER BY material_id, stock_month DESC`, [monthStart]);
  const anchorBy = new Map(anchorRows.map((a) => [a.material_id, { kg: Number(a.physical_stock_kg) || 0, date: a.anchor_date }]));

  const { rows: materials } = await query(`SELECT * FROM rm_materials WHERE is_active ORDER BY category, name`);
  const results = [];
  for (const m of materials) {
    // Opening = base + receipts before the month − consumption before the month.
    // Base/start depend on whether an earlier month has an APPROVED physical count:
    //   anchored → base = that physical, counting movement only from its anchor date;
    //   not      → base = opening_stock_kg, counting from the beginning.
    // Consumption splits at the cutover: hand-keyed rm before it, plant-actual after.
    const anchor = anchorBy.get(m.id) || null;
    const baseKg = anchor ? anchor.kg : Number(m.opening_stock_kg) || 0;
    const sinceDate = anchor ? anchor.date : "1900-01-01";
    // Round 186 (v10.15 hotfix) — Round 185 passed a leftover `null` as $2 that
    // the SQL never referenced. Postgres cannot infer a type for an unused
    // parameter and refuses the whole query (42P18 "could not determine data
    // type of parameter $2"), so this endpoint 500'd for every month and the
    // Physical Stock tab showed "Something went wrong" + "No active materials".
    // Parameters renumbered: $1 material, $2 month start, $3 cutover, $4 since.
    const { rows: openingRows } = await query(
      `SELECT
         COALESCE((SELECT SUM(r.accepted_qty_kg) FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
                    WHERE o.material_id = $1 AND r.received_date >= $4::date AND r.received_date < $2::date), 0)
         - COALESCE((SELECT SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)) FROM rm_daily_consumption c
                     WHERE c.material_id = $1 AND c.consumption_date >= $4::date AND c.consumption_date < $2::date AND c.consumption_date < $3::date), 0)
         AS movement_kg`,
      [m.id, monthStart, CONSUMPTION_CUTOVER, sinceDate]
    );
    // Plant-actual consumed between max(anchor, cutover) and the month start.
    const plantFrom = (anchor && anchor.date > CONSUMPTION_CUTOVER) ? anchor.date : CONSUMPTION_CUTOVER;
    const plantBefore = (anchor && anchor.date > CONSUMPTION_CUTOVER)
      ? (await plantConsumptionByMaterial({ from: plantFrom, toExclusive: monthStart })).get(m.id)?.total_kg || 0
      : (plantBeforeMonth.get(m.id)?.total_kg || 0);
    const openingKg = baseKg + Number(openingRows[0].movement_kg) - plantBefore;

    const { rows: monthRows } = await query(
      `SELECT
         COALESCE((SELECT SUM(r.accepted_qty_kg) FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
                   WHERE o.material_id = $1 AND r.received_date >= $2::date AND r.received_date < $2::date + INTERVAL '1 month'), 0) AS purchase_kg,
         COALESCE((SELECT SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0)) FROM rm_daily_consumption c
                   WHERE c.material_id = $1 AND c.consumption_date >= $2::date AND c.consumption_date < $2::date + INTERVAL '1 month'), 0) AS rm_consumption_kg`,
      [m.id, monthStart]
    );
    const purchaseKg = Number(monthRows[0].purchase_kg);
    const plantConsumptionKg = monthStart >= CONSUMPTION_CUTOVER
      ? (plantThisMonth.get(m.id)?.total_kg || 0)
      : Number(monthRows[0].rm_consumption_kg);
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
      // Round 188 (v10.17 #7) — the plant consumption split into what the load
      // cells weighed (auto) and what the operator entered by hand (manual).
      // Null before the cutover, when the month's figure is the hand-keyed one.
      plant_consumption_auto_kg: monthStart >= CONSUMPTION_CUTOVER ? (plantThisMonth.get(m.id)?.auto_kg || 0) : null,
      plant_consumption_manual_kg: monthStart >= CONSUMPTION_CUTOVER ? (plantThisMonth.get(m.id)?.manual_kg || 0) : null,
      // Round 189 — net consumption transfer (+ in / − out) for the month.
      plant_consumption_transfer_kg: monthStart >= CONSUMPTION_CUTOVER ? (plantThisMonth.get(m.id)?.transfer_kg || 0) : null,
      book_stock_kg: bookStockKg,
      physical_stock_kg: count ? Number(count.physical_stock_kg) : null,
      stock_taken_by_name: null,
      notes: count ? count.notes : null,
      taken_at: count ? count.taken_at : null,
      // Round 185 — approval: a count that is approved becomes next month's
      // opening. anchored_opening flags that THIS month's opening was itself
      // reset from an earlier approved count.
      approved: count ? !!count.approved : false,
      approved_at: count ? count.approved_at : null,
      approved_by_name: null,
      anchored_opening: !!anchor,
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

  // Fill in stock_taken_by_name + approved_by_name in one batch rather than a query per row.
  if (results.some((r) => r.taken_at)) {
    const { rows: counts } = await query(
      `SELECT mps.material_id, u.name, au.name AS approved_by_name
         FROM rm_monthly_physical_stock mps
         JOIN users u ON u.id = mps.stock_taken_by
         LEFT JOIN users au ON au.id = mps.approved_by
        WHERE mps.stock_month = $1`,
      [monthStart]
    );
    const byMaterial = new Map(counts.map((c) => [c.material_id, c]));
    for (const r of results) {
      const c = byMaterial.get(r.material_id);
      if (c) { r.stock_taken_by_name = c.name; r.approved_by_name = c.approved_by_name; }
    }
  }

  // The month's production, so the report can show cost per m³ beside the
  // month's total material cost. The Plant Operator's own figure is the
  // basis here, same as everywhere else cost/m³ is computed — never the
  // challan total (see this file's header note on the two volume bases).
  // Round 188 (v10.17 #4) — the plant's actual production (auto + manual) from
  // the cutover; the hand-keyed figure only for months before it.
  const prod = await productionM3Range({ from: monthStart, toExclusive: monthEnd });

  res.json({
    month,
    production_m3: prod.total_m3,
    production_auto_m3: prod.auto_m3,
    production_manual_m3: prod.manual_m3,
    production_hand_keyed_m3: prod.hand_keyed_m3,
    plant_actual: monthStart >= CONSUMPTION_CUTOVER,
    materials: results,
  });
});

// ===================== Plant consumption transfer (Round 189, v10.18) =====================
// When several materials go through one bin (M SAND-DRY fed into the M SAND
// bin, three fly ash brands in one silo, admixtures in one tank) the plant
// books the whole draw to one of them. The physical count shows it: one
// material over-used, another apparently untouched. An Administrator moves the
// quantity from the material the plant booked to the one really used.
//
// The plant's own record (plant_batch_materials) is never changed: a transfer
// is its own row, minus on "from" and plus on "to", and every consumption
// figure — book stock, physical stock, cost per m3, reports — adds it in. One
// month at a time, dated the month's last day (today for the month in
// progress), and only from the cutover on
// (before it the month's consumption is the old hand-keyed figure).
function monthBounds(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return null;
  const start = `${ym}-01`;
  const next = firstOfNextMonth(start);
  const [y, m] = ym.split("-").map(Number);
  const last = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; // ist-ok: calendar arithmetic on a month string
  return { start, next, last };
}

router.get("/consumption-transfers", requirePermission("material.consumption-transfer", "view"), async (req, res) => {
  const b = monthBounds(req.query.month || istMonth());
  if (!b) return res.status(400).json({ error: "Give the month as YYYY-MM." });
  const { rows } = await query(
    `SELECT t.id, to_char(t.transfer_date, 'YYYY-MM-DD') AS transfer_date, t.qty_kg, t.reason,
            t.from_material_id, fm.name AS from_name, fm.purchase_unit AS from_unit, fm.kg_per_purchase_unit AS from_kg_per_unit,
            t.to_material_id, tm.name AS to_name, tm.purchase_unit AS to_unit, tm.kg_per_purchase_unit AS to_kg_per_unit,
            u.name AS created_by_name,
            to_char(t.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') AS created_at
       FROM plant_consumption_transfers t
       JOIN rm_materials fm ON fm.id = t.from_material_id
       JOIN rm_materials tm ON tm.id = t.to_material_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.transfer_date >= $1::date AND t.transfer_date < $2::date
      ORDER BY t.created_at DESC`,
    [b.start, b.next]
  );
  res.json({ month: b.start.slice(0, 7), cutover: CONSUMPTION_CUTOVER, transfers: rows });
});

router.post("/consumption-transfers", requirePermission("material.consumption-transfer", "create"), async (req, res) => {
  const body = req.body || {};
  const b = monthBounds(body.month);
  if (!b) return res.status(400).json({ error: "Give the month as YYYY-MM." });
  if (b.start < CONSUMPTION_CUTOVER) {
    return res.status(400).json({ error: `Transfers start from ${CONSUMPTION_CUTOVER.slice(0, 7)}: earlier months use the hand-keyed consumption.` });
  }
  if (b.start > istMonth() + "-01") return res.status(400).json({ error: "That month has not started yet." });
  const qty = Number(body.qty_kg);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "Enter the quantity to move." });
  const reason = String(body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Say why this is being moved." });
  const fromId = Number(body.from_material_id);
  if (!(Number.isInteger(fromId) && fromId > 0)) return res.status(400).json({ error: "Choose the material the plant booked it to." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let toId = Number(body.to_material_id);
    let created = null;
    // "+ New material" — created in the same transaction as the transfer, so a
    // refused transfer never leaves a stray material behind.
    if (body.new_material) {
      const nm = body.new_material;
      const name = String(nm.name || "").trim();
      const unit = String(nm.purchase_unit || "").trim();
      const kg = Number(nm.kg_per_purchase_unit);
      if (!name) throw Object.assign(new Error("Name the new material."), { status: 400 });
      if (!unit) throw Object.assign(new Error("Give the new material's purchase unit."), { status: 400 });
      if (!Number.isFinite(kg) || kg <= 0) throw Object.assign(new Error("Give the new material's kg per unit."), { status: 400 });
      const { rows: mrows } = await client.query(
        `INSERT INTO rm_materials (name, category, purchase_unit, kg_per_purchase_unit, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, name`,
        [name, String(nm.category || "").trim() || null, unit, kg, req.user.id]
      );
      created = mrows[0];
      toId = created.id;
      await client.query(
        `INSERT INTO rm_material_units (material_id, unit_name, kg_per_unit, is_default) VALUES ($1,$2,$3,true)`,
        [toId, unit, kg]
      );
      await client.query(
        `INSERT INTO rm_material_sources (material_id, name, purchase_unit, kg_per_purchase_unit, is_default, created_by)
         VALUES ($1,'Standard',$2,$3,true,$4)`,
        [toId, unit, kg, req.user.id]
      );
    }
    if (!(Number.isInteger(toId) && toId > 0)) throw Object.assign(new Error("Choose the material that was really used."), { status: 400 });
    if (toId === fromId) throw Object.assign(new Error("From and To must be different materials."), { status: 400 });
    const { rows } = await client.query(
      `INSERT INTO plant_consumption_transfers (transfer_date, from_material_id, to_material_id, qty_kg, reason, created_by)
       VALUES ($1::date, $2, $3, $4, $5, $6) RETURNING id`,
      // The month's last day — or today, for the month in progress, so a
      // transfer is never dated in the future (period views ending today would
      // otherwise count it before its day).
      [b.last > istDay() ? istDay() : b.last, fromId, toId, Math.round(qty * 100) / 100, reason, req.user.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ ok: true, id: rows[0].id, created_material: created });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === "23505") return res.status(409).json({ error: "A material with that name already exists — pick it from the list." });
    if (err.code === "23503") return res.status(400).json({ error: "One of those materials no longer exists." });
    throw err;
  } finally {
    client.release();
  }
});

router.delete("/consumption-transfers/:id", requirePermission("material.consumption-transfer", "delete"), async (req, res) => {
  const { rowCount } = await query(`DELETE FROM plant_consumption_transfers WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "No such transfer." });
  res.json({ ok: true });
});

// ===================== Reports (Administrator only) =====================
// "Raw material stock" is GET /stock above (also used as the live stock
// view for the Store role) — not duplicated here. "Receipts register" is
// GET /receipts above, which already supports date/material/supplier
// filters and returns every computed field a register needs.

// Open order status: approved orders, ordered vs received-so-far, outstanding.
router.get("/reports/open-orders", requirePermission("material.report.open-orders", "view"), async (req, res) => {
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
router.get("/reports/weighbridge-comparison", requirePermission("material.report.weighbridge-comparison", "view"), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_date >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_date < $${params.length}::date + INTERVAL '1 day'`; }
  const { rows } = await query(
    `SELECT r.id, r.received_at, to_char(r.received_date,'YYYY-MM-DD') AS received_date, m.name AS material_name,
            COALESCE(src.purchase_unit, m.purchase_unit) AS purchase_unit, m.tolerance_pct,
            src.name AS source_name, src.kg_per_purchase_unit AS source_kg_per_unit,
            s.name AS supplier_name, r.supplier_qty, r.weighbridge_weight_kg, r.accepted_qty,
            r.short_qty, r.debit_note_amount, r.vehicle_number, r.challan_number
     FROM rm_receipts_effective r
     JOIN rm_orders o ON o.id = r.order_id
     JOIN rm_materials m ON m.id = o.material_id
     LEFT JOIN rm_material_sources src ON src.id = o.source_id
     JOIN rm_suppliers s ON s.id = o.supplier_id
     WHERE ${where}
     ORDER BY r.received_date DESC, r.received_at DESC
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
router.get("/reports/variance", requirePermission("weighbridge.receipt-variance", "view"), async (req, res) => {
  try {
    const params = [];
    let where = "r.variance_qty IS NOT NULL";
    if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_date >= $${params.length}::date`; }
    if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_date < $${params.length}::date + INTERVAL '1 day'`; }
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
        `SELECT r.id, r.received_at, to_char(r.received_date,'YYYY-MM-DD') AS received_date, r.supplier_qty, r.accepted_qty, r.weighbridge_weight_kg,
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
         ORDER BY abs(r.variance_pct) DESC NULLS LAST, r.received_date DESC
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
router.get("/reports/daily-consumption", requirePermission("material.report.daily-consumption", "view"), async (req, res) => {
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

  // Round 188 (v10.17 #4) — from the cutover, the plant's actual (auto + manual).
  const dayProd = await productionM3Range({ from: date, toExclusive: nextDay(date) });
  const operatorM3 = dayProd.total_m3 > 0 ? dayProd.total_m3 : null;

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

router.get("/reports/mix-vs-actual", requirePermission("material.report.mix-vs-actual", "view"), async (req, res) => {
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

  // Round 188 (v10.17 #4) — from the cutover, the plant's actual (auto + manual).
  const dayProd = await productionM3Range({ from: date, toExclusive: nextDay(date) });

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
    operator_production_m3: dayProd.total_m3 > 0 ? dayProd.total_m3 : null,
    grades: volumes.map((v) => ({
      grade: v.grade, m3: Number(v.m3 || 0), design_ref_code: v.design_ref_code, has_design: !!v.mix_design_id,
    })),
    grades_missing_design: gradesMissingDesign,
    materials: rows,
    unmapped_materials: rows.filter((r) => !r.mix_component).map((r) => r.name),
  });
});

router.get("/reports/monthly-consumption-summary", requirePermission("material.report.monthly-consumption", "view"), async (req, res) => {
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

router.get("/reports/monthly-physical-stock", requirePermission("material.report.monthly-physical-stock", "view"), async (req, res) => {
  // Same computation as GET /physical-stock above — this alias exists purely
  // so the Reports tab has a stable, explicitly-named report path.
  req.url = `/physical-stock${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  return router.handle(req, res);
});

router.get("/reports/weighted-average-rate-history", requirePermission("material.report.rate-history", "view"), async (req, res) => {
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

router.get("/reports/supplier-purchase-summary", requirePermission("material.report.supplier-summary", "view"), async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_date >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_date < $${params.length}::date + INTERVAL '1 day'`; }
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

router.get("/reports/transporter-freight", requirePermission("material.report.transporter-freight", "view"), async (req, res) => {
  const params = [];
  let where = "r.transporter_id IS NOT NULL";
  if (req.query.from_date) { params.push(req.query.from_date); where += ` AND r.received_date >= $${params.length}::date`; }
  if (req.query.to_date) { params.push(req.query.to_date); where += ` AND r.received_date < $${params.length}::date + INTERVAL '1 day'`; }
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
router.get("/reports/cost-per-m3", requirePermission("material.report.cost-per-m3", "view"), async (req, res) => {
  const fromDate = req.query.from_date;
  const toDate = req.query.to_date;
  if (!fromDate || !toDate) return res.status(400).json({ error: "from_date and to_date are required." });

  // Round 188 (v10.17 #4) — consumption and production split at the cutover:
  // hand-keyed before it, the plant's actual (load cells + manual) from it.
  const rangeEnd = nextDay(toDate);
  const consumptionRows = await consumptionByMaterialMonthRange({ from: fromDate, toExclusive: rangeEnd });
  const { rows: materials } = await query(`SELECT id, opening_stock_rate_per_kg FROM rm_materials`);
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const rateMapByMaterial = new Map();
  for (const m of materials) rateMapByMaterial.set(m.id, await monthlyWeightedAvgRates(m.id));

  let totalCost = 0;
  for (const row of consumptionRows) {
    const material = materialById.get(row.material_id);
    const rate = effectiveAvgForMonth(rateMapByMaterial.get(row.material_id) || new Map(), row.ym, material?.opening_stock_rate_per_kg);
    if (rate != null) totalCost += Number(row.kg) * rate;
  }

  const rangeProd = await productionM3Range({ from: fromDate, toExclusive: rangeEnd });
  const operatorTotalM3 = rangeProd.total_m3;

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
router.get("/reports/cost-dashboard", requirePermission("material.cost-dashboard", "view"), async (req, res) => {
  const month = (req.query.month || istMonth()).slice(0, 7);
  const monthStart = `${month}-01`;

  const { rows: materials } = await query(`SELECT id, name, opening_stock_rate_per_kg FROM rm_materials`);
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const rateMapByMaterial = new Map();
  for (const m of materials) rateMapByMaterial.set(m.id, await monthlyWeightedAvgRates(m.id));

  // Per-material breakdown + this month's total material cost.
  // Round 188 (v10.17 #4) — the month's consumption and production from the
  // plant's actual once past the cutover (hand-keyed before it).
  const monthEndEx = firstOfNextMonth(monthStart);
  const monthConsumption = (await consumptionByMaterialMonthRange({ from: monthStart, toExclusive: monthEndEx }))
    .map((r) => ({ material_id: r.material_id, consumed_kg: r.kg }));
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

  const monthProd = await productionM3Range({ from: monthStart, toExclusive: monthEndEx });
  const monthM3 = monthProd.total_m3;
  const costPerM3 = monthM3 > 0 ? monthMaterialCost / monthM3 : null;
  for (const p of perMaterial) p.cost_per_m3 = p.cost != null && monthM3 > 0 ? p.cost / monthM3 : null;
  perMaterial.sort((a, b) => (b.cost || 0) - (a.cost || 0));

  // Stock value as of today (same computation as GET /stock).
  // Round 186 — base_kg, not opening_stock_kg: since Round 185 received/consumed
  // only count from a material's approved-count anchor, so adding them to the
  // original opening would mis-state stock value once any count is approved.
  const stockRows = await bookStockRows();
  const nowMonth = istMonth();
  let stockValue = 0;
  for (const m of stockRows) {
    const bookStockKg = Number(m.base_kg) + Number(m.received_kg) - Number(m.consumed_kg);
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
     WHERE to_char(r.received_date, 'YYYY-MM') = $1`,
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
     WHERE to_char(r.received_date, 'YYYY-MM') = $1 AND m.tolerance_pct IS NOT NULL
       AND r.supplier_qty > 0 AND ABS(r.short_qty) / r.supplier_qty * 100 > m.tolerance_pct`,
    [month]
  );

  // 6-month cost/m3 trend (operator basis), this month and the 5 before it.
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(`${monthStart}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    const ym = istMonth(d);
    const ymStart = `${ym}-01`;
    const ymEnd = firstOfNextMonth(ymStart);
    const prod = [{ m3: (await productionM3Range({ from: ymStart, toExclusive: ymEnd })).total_m3 }];
    const cons = await consumptionByMaterialMonthRange({ from: ymStart, toExclusive: ymEnd });
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
      month_m3_auto: monthProd.auto_m3,
      month_m3_manual: monthProd.manual_m3,
      month_m3_hand_keyed: monthProd.hand_keyed_m3,
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
router.get("/reports/stock-summary", requireAnyPermission(["material.kpi", "material.stock-valuation"], "view"), async (req, res) => {
  const month = istMonth();

  // Round 186 — base_kg, not opening_stock_kg (same reason as the Cost
  // Dashboard above): it must match GET /stock's book stock exactly.
  const stockRows = await bookStockRows();
  let stockValue = 0;
  for (const m of stockRows) {
    const bookStockKg = Number(m.base_kg) + Number(m.received_kg) - Number(m.consumed_kg);
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
    `SELECT accepted_qty_kg, landed_rate_per_kg, debit_note_amount FROM rm_receipts_effective WHERE to_char(received_date, 'YYYY-MM') = $1`,
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
