import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, requireAnyPermission } from "../lib/permissions.js";
import { istDay, istDaysAgo } from "../lib/istDate.js";

// ===========================================================================
// Round 199 — the Fuel module.
//
// Nothing about how diesel is stored changed. The tank balance is still the
// one store_stock_items row with item_type = 'fuel'; every change to it is
// still a store_stock_transactions row (purchase_receive / issue_deduct /
// adjustment); purchases are still store_stock_purchases; issues are still
// supply_requests. This router only READS those, so the Fuel module, the
// Store screens and the 360° analysis can never disagree about a litre.
//
// The few writes here are the module's own: its settings (tank capacity is
// Administrator-only — the user's rule), the rate history, and a Manager's
// review note on an exception. Requesting, approving and receiving a purchase
// and adjusting the balance keep using the existing /store-stock endpoints,
// and issuing keeps using the QR scan in /supply-requests.
//
// Dates: every comparison is against a database session pinned to
// Asia/Kolkata (see db.js), so `x::date` is the IST day and the defaults below
// are IST days too (lib/istDate.js), never toISOString().
// ===========================================================================

const router = Router();
router.use(requireAuth);

// Anything in the module may need the settings (bands, capacity) and the
// fuel item, so this pair is readable from any fuel function.
const ANY_FUEL = [
  "fuel.dashboard", "fuel.transactions", "fuel.issue", "fuel.purchases",
  "fuel.reports", "fuel.settings", "reports.fuel-analysis",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function range(req, defaultDays = 30) {
  const to = DATE_RE.test(req.query.to_date || "") ? req.query.to_date : istDay();
  const from = DATE_RE.test(req.query.from_date || "") ? req.query.from_date : istDaysAgo(defaultDays);
  return from <= to ? { from, to } : { from: to, to: from };
}
const num = (v) => (v == null ? null : Number(v));

// The fuel stock item — created if this installation never opened Store Stock,
// exactly the way storeStock.js's own ensureStockItems() does it.
async function fuelItem() {
  await query(
    `INSERT INTO store_stock_items (item_type, unit)
     SELECT 'fuel', 'L' WHERE NOT EXISTS (SELECT 1 FROM store_stock_items WHERE item_type = 'fuel')`
  );
  const { rows } = await query(`SELECT * FROM store_stock_items WHERE item_type = 'fuel' ORDER BY id LIMIT 1`);
  return rows[0];
}

async function settings() {
  await query(`INSERT INTO fuel_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const { rows } = await query(
    `SELECT tank_name, capacity_l, reorder_level_l, warning_days, band_high_pct, band_above_pct,
            band_efficient_pct, close_fill_hours,
            to_char(work_start, 'HH24:MI') AS work_start, to_char(work_end, 'HH24:MI') AS work_end,
            updated_at, (SELECT name FROM users WHERE id = fuel_settings.updated_by) AS updated_by_name
       FROM fuel_settings WHERE id = 1`
  );
  const s = rows[0];
  for (const k of ["capacity_l", "reorder_level_l", "warning_days", "band_high_pct", "band_above_pct", "band_efficient_pct", "close_fill_hours"]) {
    s[k] = num(s[k]);
  }
  return s;
}

// The same shape of SQL is needed by several endpoints: every ISSUED fuel
// request, with which category of machine it was, which unit, and the meter
// reading it was filled at. A request names exactly one of truck / pump /
// equipment, so the category comes from which id is set — the same rule
// fuelAnalysis.js uses ("pump" if pump_id, else equipment).
const ISSUED_FUEL_CTE = `
  sr_all AS (
    SELECT sr.*,
      COALESCE(sr.approved_station_id, sr.fuel_station_id) AS station_id,
      CASE WHEN sr.truck_id IS NOT NULL THEN 'truck'
           WHEN sr.pump_id  IS NOT NULL THEN 'pump'
           ELSE 'equipment' END AS category,
      COALESCE(sr.truck_id, sr.pump_id, sr.equipment_id) AS unit_id,
      COALESCE(sr.odometer_reading, sr.hour_meter_reading) AS reading
    FROM supply_requests sr
    WHERE sr.request_type = 'fuel' AND sr.status = 'issued'
  )`;

const UNIT_JOINS = `
  LEFT JOIN trucks t     ON t.id = s.truck_id
  LEFT JOIN pumps p      ON p.id = s.pump_id
  LEFT JOIN equipment e  ON e.id = s.equipment_id`;
const UNIT_LABEL = `COALESCE(t.truck_number, p.pump_code, e.name)`;
const UNIT_SUB = `CASE WHEN s.truck_id IS NOT NULL THEN 'Truck'
                       WHEN s.pump_id IS NOT NULL THEN initcap(replace(p.pump_type::text, '_', ' '))
                       ELSE initcap(replace(e.equipment_type::text, '_', ' ')) END`;

// ===================== Settings =====================

router.get("/settings", requireAnyPermission(ANY_FUEL), async (req, res) => {
  try {
    const [s, item, rates, log] = await Promise.all([
      settings(),
      fuelItem(),
      query(`SELECT h.rate_per_liter, h.effective_from, h.note, u.name AS set_by_name
               FROM fuel_rate_history h LEFT JOIN users u ON u.id = h.set_by
              ORDER BY h.effective_from DESC LIMIT 20`),
      query(`SELECT l.field, l.old_value, l.new_value, l.changed_at, u.name AS changed_by_name
               FROM fuel_settings_log l LEFT JOIN users u ON u.id = l.changed_by
              ORDER BY l.changed_at DESC LIMIT 20`),
    ]);
    res.json({
      settings: s,
      item: { id: item.id, current_qty: num(item.current_qty), rate_per_liter: num(item.rate_per_liter), unit: item.unit },
      rate_history: rates.rows.map((r) => ({ ...r, rate_per_liter: num(r.rate_per_liter) })),
      change_log: log.rows,
    });
  } catch (err) {
    console.error("GET /fuel-module/settings failed:", err);
    res.status(500).json({ error: "Could not load fuel settings." });
  }
});

const SETTING_FIELDS = {
  tank_name: { label: "Tank name", type: "text" },
  capacity_l: { label: "Capacity (L)", type: "num", min: 1 },
  reorder_level_l: { label: "Reorder level (L)", type: "num", min: 0 },
  warning_days: { label: "Early warning (days)", type: "num", min: 0, max: 60 },
  band_high_pct: { label: "High consumption over average (%)", type: "num", min: 0.1, max: 200 },
  band_above_pct: { label: "Above average over average (%)", type: "num", min: 0, max: 200 },
  band_efficient_pct: { label: "Efficient under average (%)", type: "num", min: 0.1, max: 100 },
  close_fill_hours: { label: "Two fills close together (hours)", type: "num", min: 0, max: 72 },
  work_start: { label: "Working hours start", type: "time" },
  work_end: { label: "Working hours end", type: "time" },
};

router.patch("/settings", requirePermission("fuel.settings", "edit"), async (req, res) => {
  try {
    const before = await settings();
    const next = { ...before };
    const changes = [];
    for (const [k, def] of Object.entries(SETTING_FIELDS)) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      if (def.type === "num") {
        if (v === "" || v === null) {
          if (k === "capacity_l" || k === "reorder_level_l") v = null;
          else return res.status(400).json({ error: `${def.label}: enter a number.` });
        } else {
          v = Number(v);
          if (!Number.isFinite(v) || v < def.min || (def.max != null && v > def.max)) {
            return res.status(400).json({ error: `${def.label}: enter a number${def.max != null ? ` between ${def.min} and ${def.max}` : ` of at least ${def.min}`}.` });
          }
        }
      } else if (def.type === "time") {
        if (!/^\d{2}:\d{2}$/.test(String(v || ""))) return res.status(400).json({ error: `${def.label}: use HH:MM.` });
      } else {
        v = String(v || "").trim();
        if (!v) return res.status(400).json({ error: `${def.label} can't be empty.` });
        if (v.length > 80) return res.status(400).json({ error: `${def.label}: 80 characters at most.` });
      }
      if (String(before[k] ?? "") !== String(v ?? "")) changes.push([k, before[k], v]);
      next[k] = v;
    }
    if (next.capacity_l != null && next.reorder_level_l != null && next.reorder_level_l >= next.capacity_l) {
      return res.status(400).json({ error: "The reorder level must be lower than the tank capacity." });
    }
    if (next.band_above_pct >= next.band_high_pct) {
      return res.status(400).json({ error: "\"Above average\" must start below \"High consumption\"." });
    }
    if (!changes.length) return res.json({ settings: before, changed: 0 });

    await query(
      `UPDATE fuel_settings SET tank_name = $1, capacity_l = $2, reorder_level_l = $3, warning_days = $4,
         band_high_pct = $5, band_above_pct = $6, band_efficient_pct = $7, close_fill_hours = $8,
         work_start = $9, work_end = $10, updated_by = $11, updated_at = now()
       WHERE id = 1`,
      [next.tank_name, next.capacity_l, next.reorder_level_l, next.warning_days, next.band_high_pct,
        next.band_above_pct, next.band_efficient_pct, next.close_fill_hours, next.work_start, next.work_end, req.user.id]
    );
    for (const [k, a, b] of changes) {
      await query(
        `INSERT INTO fuel_settings_log (field, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)`,
        [SETTING_FIELDS[k].label, a == null ? null : String(a), b == null ? null : String(b), req.user.id]
      );
    }
    // Store Stock keeps its own reorder_level column for the fuel item; keep it
    // the same number so neither screen shows a stale one.
    if (changes.some(([k]) => k === "reorder_level_l")) {
      await query(`UPDATE store_stock_items SET reorder_level = $1 WHERE item_type = 'fuel'`, [next.reorder_level_l]);
    }
    res.json({ settings: await settings(), changed: changes.length });
  } catch (err) {
    console.error("PATCH /fuel-module/settings failed:", err);
    res.status(500).json({ error: "Could not save fuel settings." });
  }
});

// A new rate per litre. Same column the issue screens pre-fill cost from
// (store_stock_items.rate_per_liter, Round 137) — this only adds the history.
router.post("/rate", requirePermission("fuel.settings", "edit"), async (req, res) => {
  const { rate_per_liter, note } = req.body;
  const rate = Number(rate_per_liter);
  if (rate_per_liter === "" || rate_per_liter == null || !Number.isFinite(rate) || rate < 0) {
    return res.status(400).json({ error: "Enter a valid rate (₹ per litre)." });
  }
  try {
    const item = await fuelItem();
    await query(`UPDATE store_stock_items SET rate_per_liter = $1 WHERE id = $2`, [rate, item.id]);
    await query(`INSERT INTO fuel_rate_history (rate_per_liter, set_by, note) VALUES ($1, $2, $3)`, [rate, req.user.id, note || null]);
    res.json({ ok: true, rate_per_liter: rate });
  } catch (err) {
    console.error("POST /fuel-module/rate failed:", err);
    res.status(500).json({ error: "Could not save the rate." });
  }
});

// ===================== Ledger (Transactions) =====================
//
// One list for every litre: the tank's own transactions (deliveries in,
// plant issues out, Manager adjustments) and, alongside them, fills at
// outside stations — which never touched the tank and so carry no balance.
// Each issue row also carries its fill-to-fill working: the meter reading of
// the same machine's previous fill (all time, not just this range — the
// same "previous reading" rule fuelAnalysis.js's drill-down uses), so the
// consumption on a row never depends on which dates are being looked at.

function ledgerSql(extraWhere = "", tail = "") {
  return `
    WITH fuel_item AS (SELECT id FROM store_stock_items WHERE item_type = 'fuel' ORDER BY id LIMIT 1),
    ${ISSUED_FUEL_CTE},
    fills AS (
      SELECT s.id,
        LAG(s.reading)   OVER w AS prev_reading,
        LAG(s.issued_at) OVER w AS prev_at,
        LAG(s.id)        OVER w AS prev_id
      FROM sr_all s
      WHERE s.reading IS NOT NULL
      WINDOW w AS (PARTITION BY s.category, s.unit_id ORDER BY s.reading, s.issued_at)
    ),
    tank AS (
      SELECT CASE sst.txn_type WHEN 'purchase_receive' THEN 'receipt'
                               WHEN 'issue_deduct' THEN 'issue'
                               ELSE 'adjustment' END AS kind,
             sst.id AS txn_id, sst.created_at AS at, sst.qty_change, sst.balance_after, sst.note,
             CASE WHEN sst.reference_type = 'supply_request' THEN sst.reference_id END AS sr_id,
             CASE WHEN sst.reference_type = 'store_stock_purchase' THEN sst.reference_id END AS sp_id,
             sst.created_by
        FROM store_stock_transactions sst JOIN fuel_item fi ON fi.id = sst.stock_item_id
    ),
    ext AS (
      SELECT 'external' AS kind, NULL::int AS txn_id, s.issued_at AS at, -s.actual_quantity_issued AS qty_change,
             NULL::numeric AS balance_after, NULL::text AS note, s.id AS sr_id, NULL::int AS sp_id, s.issued_by AS created_by
        FROM sr_all s
        LEFT JOIN fuel_stations fs ON fs.id = s.station_id
       WHERE NOT COALESCE(fs.is_plant, false)
         AND NOT EXISTS (SELECT 1 FROM tank tk WHERE tk.sr_id = s.id)
    ),
    led AS (SELECT * FROM tank UNION ALL SELECT * FROM ext),
    ledger_rows AS (
      SELECT led.kind, led.txn_id, led.at, led.qty_change, led.balance_after, led.note, led.sr_id, led.sp_id,
        to_char(led.at, 'YYYY-MM-DD') AS day,
        uc.name AS done_by_name,
        s.category, s.unit_id, s.truck_id, s.pump_id, s.equipment_id,
        ${UNIT_LABEL} AS unit_label, ${UNIT_SUB} AS unit_sub,
        s.odometer_reading, s.hour_meter_reading, s.requested_quantity, s.approved_quantity,
        s.actual_quantity_issued, s.fuel_cost, s.requested_at, s.approved_at, s.issued_at,
        ureq.name AS requested_by_name, uapp.name AS approved_by_name, uiss.name AS issued_by_name,
        fs.name AS station_name, fs.is_plant,
        fl.prev_reading, fl.prev_at,
        CASE WHEN fl.prev_reading IS NOT NULL AND s.reading > fl.prev_reading THEN s.reading - fl.prev_reading END AS interval,
        CASE WHEN fl.prev_reading IS NOT NULL AND s.reading > fl.prev_reading THEN
          CASE WHEN s.truck_id IS NOT NULL
               THEN ROUND((s.actual_quantity_issued / (s.reading - fl.prev_reading)) * 100, 2)
               ELSE ROUND(s.actual_quantity_issued / (s.reading - fl.prev_reading), 2) END
        END AS consumption,
        sp.supplier_name, sp.notes AS purchase_notes, sp.requested_qty AS purchase_requested_qty,
        sp.approved_qty AS purchase_approved_qty, sp.received_qty, sp.unit_cost, sp.total_cost,
        sp.requested_at AS purchase_requested_at, sp.approved_at AS purchase_approved_at, sp.received_at,
        spreq.name AS purchase_requested_by_name, spapp.name AS purchase_approved_by_name, sprec.name AS received_by_name
      FROM led
      LEFT JOIN users uc ON uc.id = led.created_by
      LEFT JOIN sr_all s ON s.id = led.sr_id
      ${UNIT_JOINS}
      LEFT JOIN fills fl ON fl.id = s.id
      LEFT JOIN fuel_stations fs ON fs.id = s.station_id
      LEFT JOIN users ureq ON ureq.id = s.requested_by
      LEFT JOIN users uapp ON uapp.id = s.approved_by
      LEFT JOIN users uiss ON uiss.id = s.issued_by
      LEFT JOIN store_stock_purchases sp ON sp.id = led.sp_id
      LEFT JOIN users spreq ON spreq.id = sp.requested_by
      LEFT JOIN users spapp ON spapp.id = sp.approved_by
      LEFT JOIN users sprec ON sprec.id = sp.received_by
    )
    SELECT *, COUNT(*) OVER () AS total_rows FROM ledger_rows
    WHERE TRUE ${extraWhere}
    ORDER BY at DESC, txn_id DESC NULLS LAST
    ${tail}`;
}

function ledgerRow(r) {
  const n = (v) => (v == null ? null : Number(v));
  const qty = n(r.qty_change);
  const ref = r.kind === "receipt" ? `FPR-${r.sp_id}` : r.kind === "adjustment" ? `ADJ-${r.txn_id}` : `FR-${r.sr_id}`;
  const out = {
    kind: r.kind, at: r.at, ref, txn_id: r.txn_id, sr_id: r.sr_id, sp_id: r.sp_id,
    in_qty: qty > 0 ? qty : null,
    out_qty: qty < 0 ? -qty : null,
    balance_after: n(r.balance_after),
    category: r.category, unit_label: r.unit_label, unit_sub: r.unit_sub,
    station_name: r.station_name, done_by_name: r.done_by_name, note: r.note,
  };
  if (r.kind === "issue" || r.kind === "external") {
    out.reading = r.odometer_reading != null ? { value: n(r.odometer_reading), unit: "km" }
      : r.hour_meter_reading != null ? { value: n(r.hour_meter_reading), unit: "hrs" } : null;
    out.consumption = r.consumption == null ? null : { value: n(r.consumption), unit: r.truck_id ? "L/100km" : "L/hr" };
    out.value = n(r.fuel_cost);
    out.rate = out.value != null && out.out_qty ? Math.round((out.value / out.out_qty) * 100) / 100 : null;
    out.calc = {
      prev_reading: n(r.prev_reading), prev_at: r.prev_at, interval: n(r.interval),
      interval_unit: r.truck_id ? "km" : "hrs", litres: n(r.actual_quantity_issued),
    };
    out.trail = [
      { step: "Requested", who: r.requested_by_name, at: r.requested_at, note: `${n(r.requested_quantity)} L asked` },
      r.approved_at && { step: "Approved", who: r.approved_by_name, at: r.approved_at,
        note: `${n(r.approved_quantity)} L${r.station_name ? ` · ${r.station_name}` : ""}` },
      { step: r.kind === "external" ? "Filled (self-confirmed)" : "Issued", who: r.issued_by_name, at: r.issued_at,
        note: `${n(r.actual_quantity_issued)} L${r.kind === "external" ? " · tank balance unchanged" : ""}` },
    ].filter(Boolean);
  } else if (r.kind === "receipt") {
    out.unit_label = r.supplier_name || "Supplier not named";
    out.unit_sub = r.purchase_notes || "Delivery received";
    out.value = n(r.total_cost);
    out.rate = n(r.unit_cost);
    out.trail = [
      r.purchase_requested_at && { step: "Purchase requested", who: r.purchase_requested_by_name, at: r.purchase_requested_at, note: `${n(r.purchase_requested_qty)} L` },
      r.purchase_approved_at && { step: "Approved", who: r.purchase_approved_by_name, at: r.purchase_approved_at, note: `${n(r.purchase_approved_qty)} L` },
      { step: "Received", who: r.received_by_name || r.done_by_name, at: r.received_at || r.at, note: `${n(r.received_qty) ?? qty} L` },
    ].filter(Boolean);
    out.calc = {
      ordered: n(r.purchase_approved_qty ?? r.purchase_requested_qty), received: n(r.received_qty ?? qty),
      balance_before: out.balance_after != null && qty != null ? Math.round((out.balance_after - qty) * 100) / 100 : null,
    };
  } else {
    out.unit_label = "Tank adjustment";
    out.unit_sub = r.note || "Physical count";
    out.trail = [{ step: "Adjusted", who: r.done_by_name, at: r.at, note: r.note || "" }];
    out.calc = { balance_before: out.balance_after != null ? Math.round((out.balance_after - qty) * 100) / 100 : null, change: qty };
  }
  return out;
}

// Opening / in / out / adjusted / closing for the tank over a date range.
// Closing on a day = today's balance minus every change logged after it, so
// it is right even for ranges far in the past.
async function tankSummary(from, to) {
  const item = await fuelItem();
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(qty_change) FILTER (WHERE created_at::date >= $2::date), 0) AS since_from,
       COALESCE(SUM(qty_change) FILTER (WHERE created_at::date > $3::date), 0) AS after_to,
       COALESCE(SUM(qty_change) FILTER (WHERE txn_type = 'purchase_receive' AND created_at::date BETWEEN $2 AND $3), 0) AS received,
       COUNT(*) FILTER (WHERE txn_type = 'purchase_receive' AND created_at::date BETWEEN $2 AND $3) AS deliveries,
       COALESCE(-SUM(qty_change) FILTER (WHERE txn_type = 'issue_deduct' AND created_at::date BETWEEN $2 AND $3), 0) AS issued,
       COUNT(*) FILTER (WHERE txn_type = 'issue_deduct' AND created_at::date BETWEEN $2 AND $3) AS issues,
       COALESCE(SUM(qty_change) FILTER (WHERE txn_type = 'adjustment' AND created_at::date BETWEEN $2 AND $3), 0) AS adjusted,
       COUNT(*) FILTER (WHERE txn_type = 'adjustment' AND created_at::date BETWEEN $2 AND $3) AS adjustments
     FROM store_stock_transactions WHERE stock_item_id = $1`,
    [item.id, from, to]
  );
  const values = await query(
    `SELECT
       (SELECT COALESCE(SUM(sp.total_cost), 0) FROM store_stock_purchases sp
         WHERE sp.stock_item_id = $1 AND sp.status = 'received' AND sp.received_at::date BETWEEN $2 AND $3) AS received_value,
       (SELECT COALESCE(SUM(sr.fuel_cost), 0) FROM store_stock_transactions sst
          JOIN supply_requests sr ON sr.id = sst.reference_id AND sst.reference_type = 'supply_request'
         WHERE sst.stock_item_id = $1 AND sst.txn_type = 'issue_deduct' AND sst.created_at::date BETWEEN $2 AND $3) AS issued_value`,
    [item.id, from, to]
  );
  const ext = await query(
    `WITH ${ISSUED_FUEL_CTE}
     SELECT COALESCE(SUM(s.actual_quantity_issued), 0) AS litres, COUNT(*) AS fills, COALESCE(SUM(s.fuel_cost), 0) AS value
       FROM sr_all s LEFT JOIN fuel_stations fs ON fs.id = s.station_id
      WHERE NOT COALESCE(fs.is_plant, false) AND s.issued_at::date BETWEEN $1 AND $2
        AND NOT EXISTS (SELECT 1 FROM store_stock_transactions sst
                         WHERE sst.reference_type = 'supply_request' AND sst.reference_id = s.id)`,
    [from, to]
  );
  const r = rows[0];
  const current = Number(item.current_qty);
  const n = (v) => Math.round(Number(v) * 100) / 100;
  return {
    opening: n(current - Number(r.since_from)),
    received: n(r.received), deliveries: Number(r.deliveries), received_value: n(values.rows[0].received_value),
    issued: n(r.issued), issues: Number(r.issues), issued_value: n(values.rows[0].issued_value),
    adjusted: n(r.adjusted), adjustments: Number(r.adjustments),
    closing: n(current - Number(r.after_to)),
    outside: { litres: n(ext.rows[0].litres), fills: Number(ext.rows[0].fills), value: n(ext.rows[0].value) },
    current: n(current),
  };
}

router.get("/transactions", requirePermission("fuel.transactions", "view"), async (req, res) => {
  const { from, to } = range(req, 30);
  const params = [from, to];
  let where = ` AND day BETWEEN $1 AND $2`;
  const kind = String(req.query.kind || "");
  if (["issue", "receipt", "external", "adjustment"].includes(kind)) { params.push(kind); where += ` AND kind = $${params.length}`; }
  const category = String(req.query.category || "");
  if (["truck", "pump", "equipment"].includes(category)) { params.push(category); where += ` AND category = $${params.length}`; }
  const unit = String(req.query.unit || "");
  if (/^(truck|pump|equipment):\d+$/.test(unit)) {
    const [c, id] = unit.split(":");
    params.push(c, Number(id));
    where += ` AND category = $${params.length - 1} AND unit_id = $${params.length}`;
  }
  const q = String(req.query.q || "").trim();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where += ` AND (unit_label ILIKE ${p} OR supplier_name ILIKE ${p} OR note ILIKE ${p} OR done_by_name ILIKE ${p}
                 OR requested_by_name ILIKE ${p} OR station_name ILIKE ${p} OR purchase_notes ILIKE ${p}
                 OR ('FR-' || sr_id) ILIKE ${p} OR ('FPR-' || sp_id) ILIKE ${p} OR ('ADJ-' || txn_id) ILIKE ${p})`;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  params.push(limit, (page - 1) * limit);
  try {
    await fuelItem();
    const [{ rows }, summary] = await Promise.all([
      query(ledgerSql(where, `LIMIT $${params.length - 1} OFFSET $${params.length}`), params),
      tankSummary(from, to),
    ]);
    res.json({
      from_date: from, to_date: to, page, limit,
      total: rows.length ? Number(rows[0].total_rows) : 0,
      rows: rows.map(ledgerRow),
      summary,
    });
  } catch (err) {
    console.error("GET /fuel-module/transactions failed:", err);
    res.status(500).json({ error: "Could not load fuel transactions." });
  }
});

// Units that have ever had fuel, for the Transactions filter.
router.get("/units", requireAnyPermission(ANY_FUEL), async (req, res) => {
  try {
    const { rows } = await query(
      `WITH ${ISSUED_FUEL_CTE}
       SELECT DISTINCT s.category, s.unit_id, ${UNIT_LABEL} AS unit_label, ${UNIT_SUB} AS unit_sub
         FROM sr_all s ${UNIT_JOINS}
        WHERE s.unit_id IS NOT NULL
        ORDER BY 1, 3`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /fuel-module/units failed:", err);
    res.status(500).json({ error: "Could not load vehicles and machines." });
  }
});

// ===================== Dashboard =====================

router.get("/dashboard", requirePermission("fuel.dashboard", "view"), async (req, res) => {
  try {
    const [item, s] = await Promise.all([fuelItem(), settings()]);
    const today = istDay();
    const from14 = istDaysAgo(13);
    const monthStart = today.slice(0, 8) + "01";

    const [daily, after, issues7, pending, purchases, month, monthM3, top, lastDelivery, recent] = await Promise.all([
      // Per day for the last 14 days: issues out of the tank by category, and deliveries in.
      query(
        `SELECT to_char(sst.created_at, 'YYYY-MM-DD') AS day,
                COALESCE(-SUM(sst.qty_change) FILTER (WHERE sst.txn_type = 'issue_deduct' AND sr.truck_id IS NOT NULL), 0) AS truck,
                COALESCE(-SUM(sst.qty_change) FILTER (WHERE sst.txn_type = 'issue_deduct' AND sr.truck_id IS NULL AND sr.pump_id IS NOT NULL), 0) AS pump,
                COALESCE(-SUM(sst.qty_change) FILTER (WHERE sst.txn_type = 'issue_deduct' AND sr.truck_id IS NULL AND sr.pump_id IS NULL), 0) AS equipment,
                COALESCE(SUM(sst.qty_change) FILTER (WHERE sst.txn_type = 'purchase_receive'), 0) AS received
           FROM store_stock_transactions sst
           LEFT JOIN supply_requests sr ON sst.reference_type = 'supply_request' AND sr.id = sst.reference_id
          WHERE sst.stock_item_id = $1 AND sst.created_at::date BETWEEN $2 AND $3
          GROUP BY 1`,
        [item.id, from14, today]
      ),
      // Sum of every change logged after each day — closing(day) = current - this.
      query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                COALESCE((SELECT SUM(qty_change) FROM store_stock_transactions
                           WHERE stock_item_id = $1 AND created_at::date > d::date), 0) AS after
           FROM generate_series($2::date, $3::date, interval '1 day') d`,
        [item.id, from14, today]
      ),
      query(
        `SELECT COALESCE(-SUM(qty_change) FILTER (WHERE created_at::date > $2::date - 7), 0) AS last7,
                COALESCE(-SUM(qty_change) FILTER (WHERE created_at::date <= $2::date - 7 AND created_at::date > $2::date - 14), 0) AS prev7,
                COALESCE(-SUM(qty_change) FILTER (WHERE created_at::date = $2::date), 0) AS today
           FROM store_stock_transactions WHERE stock_item_id = $1 AND txn_type = 'issue_deduct'
            AND created_at::date > $2::date - 14`,
        [item.id, today]
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE sr.status = 'pending') AS awaiting_approval,
                COUNT(*) FILTER (WHERE sr.status = 'approved' AND COALESCE(fs.is_plant, false)) AS awaiting_issue,
                COUNT(*) FILTER (WHERE sr.status = 'approved' AND NOT COALESCE(fs.is_plant, false)) AS awaiting_outside
           FROM supply_requests sr
           LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
          WHERE sr.request_type = 'fuel' AND sr.status IN ('pending', 'approved')`
      ),
      query(
        `SELECT id, status, requested_qty, approved_qty, supplier_name, requested_at
           FROM store_stock_purchases WHERE stock_item_id = $1 AND status IN ('pending', 'approved')
          ORDER BY requested_at`,
        [item.id]
      ),
      tankSummary(monthStart, today),
      query(
        `SELECT (SELECT COALESCE(SUM(batch_qty_m3), 0) FROM plant_batches WHERE batch_date BETWEEN $1 AND $2)
              + (SELECT COALESCE(SUM(qty_m3), 0) FROM plant_manual_entries WHERE entry_date BETWEEN $1 AND $2 AND material_id IS NULL) AS m3`,
        [monthStart, today]
      ),
      query(
        `WITH ${ISSUED_FUEL_CTE}
         SELECT s.category, s.unit_id, ${UNIT_LABEL} AS unit_label, ${UNIT_SUB} AS unit_sub,
                SUM(s.actual_quantity_issued) AS litres, SUM(s.fuel_cost) AS cost, COUNT(*) AS fills
           FROM sr_all s ${UNIT_JOINS}
          WHERE s.issued_at::date BETWEEN $1 AND $2
          GROUP BY 1, 2, 3, 4 ORDER BY litres DESC LIMIT 6`,
        [monthStart, today]
      ),
      query(
        `SELECT sp.received_qty, sp.unit_cost, sp.supplier_name, sp.received_at
           FROM store_stock_purchases sp WHERE sp.stock_item_id = $1 AND sp.status = 'received'
          ORDER BY sp.received_at DESC LIMIT 1`,
        [item.id]
      ),
      query(ledgerSql("", "LIMIT 8")),
    ]);

    const byDay = Object.fromEntries(daily.rows.map((r) => [r.day, r]));
    const current = Number(item.current_qty);
    const days = after.rows.map((r) => {
      const d = byDay[r.day] || {};
      return {
        day: r.day,
        closing: Math.round((current - Number(r.after)) * 100) / 100,
        truck: Number(d.truck || 0), pump: Number(d.pump || 0), equipment: Number(d.equipment || 0),
        received: Number(d.received || 0),
      };
    });

    const i7 = issues7.rows[0];
    const avg7 = Number(i7.last7) / 7;
    const monthUsedAll = month.issued + month.outside.litres;
    const m3 = Number(monthM3.rows[0].m3) || 0;
    const monthCostAll = month.issued_value + month.outside.value;

    res.json({
      today,
      settings: s,
      tank: {
        current_qty: current,
        rate_per_liter: num(item.rate_per_liter),
        capacity_l: s.capacity_l,
        reorder_level_l: s.reorder_level_l,
        avg_daily_7: Math.round(avg7 * 10) / 10,
        prev_avg_daily_7: Math.round((Number(i7.prev7) / 7) * 10) / 10,
        days_of_cover: avg7 > 0 ? Math.round((current / avg7) * 10) / 10 : null,
        days_to_reorder: avg7 > 0 && s.reorder_level_l != null ? Math.round(((current - s.reorder_level_l) / avg7) * 10) / 10 : null,
      },
      today_issued: Number(i7.today),
      month: {
        start: monthStart,
        received: month.received, deliveries: month.deliveries, received_value: month.received_value,
        issued: month.issued, issued_value: month.issued_value,
        outside: month.outside,
        m3_produced: Math.round(m3 * 10) / 10,
        litres_per_m3: m3 > 0 ? Math.round((monthUsedAll / m3) * 100) / 100 : null,
        cost_per_m3: m3 > 0 ? Math.round(monthCostAll / m3) : null,
      },
      pending: {
        ...Object.fromEntries(Object.entries(pending.rows[0]).map(([k, v]) => [k, Number(v)])),
        purchases: purchases.rows.map((p) => ({ ...p, requested_qty: num(p.requested_qty), approved_qty: num(p.approved_qty) })),
      },
      days,
      top: top.rows.map((r) => ({ ...r, litres: num(r.litres), cost: num(r.cost), fills: Number(r.fills) })),
      last_delivery: lastDelivery.rows[0]
        ? { ...lastDelivery.rows[0], received_qty: num(lastDelivery.rows[0].received_qty), unit_cost: num(lastDelivery.rows[0].unit_cost) }
        : null,
      recent: recent.rows.map(ledgerRow),
    });
  } catch (err) {
    console.error("GET /fuel-module/dashboard failed:", err);
    res.status(500).json({ error: "Could not load the fuel dashboard." });
  }
});

// ===================== Issue fuel =====================
// Requests waiting on someone. Approving stays on Supply Approvals and issuing
// stays on the Store QR scan — this is the one list of what is outstanding.

router.get("/issue-queue", requirePermission("fuel.issue", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `WITH last_fill AS (
         SELECT DISTINCT ON (COALESCE(truck_id, 0), COALESCE(pump_id, 0), COALESCE(equipment_id, 0))
                truck_id, pump_id, equipment_id, issued_at, actual_quantity_issued
           FROM supply_requests
          WHERE request_type = 'fuel' AND status = 'issued'
          ORDER BY COALESCE(truck_id, 0), COALESCE(pump_id, 0), COALESCE(equipment_id, 0), issued_at DESC
       )
       SELECT s.id, s.status, s.requested_quantity, s.approved_quantity, s.requested_at, s.approved_at,
              s.odometer_reading, s.hour_meter_reading,
              ${UNIT_LABEL} AS unit_label, ${UNIT_SUB} AS unit_sub,
              ureq.name AS requested_by_name, uapp.name AS approved_by_name,
              fs.name AS station_name, COALESCE(fs.is_plant, false) AS is_plant,
              lf.issued_at AS last_fill_at, lf.actual_quantity_issued AS last_fill_qty
         FROM supply_requests s
         ${UNIT_JOINS}
         LEFT JOIN users ureq ON ureq.id = s.requested_by
         LEFT JOIN users uapp ON uapp.id = s.approved_by
         LEFT JOIN fuel_stations fs ON fs.id = COALESCE(s.approved_station_id, s.fuel_station_id)
         LEFT JOIN last_fill lf ON lf.truck_id IS NOT DISTINCT FROM s.truck_id
                               AND lf.pump_id IS NOT DISTINCT FROM s.pump_id
                               AND lf.equipment_id IS NOT DISTINCT FROM s.equipment_id
        WHERE s.request_type = 'fuel' AND s.status IN ('pending', 'approved')
        ORDER BY s.requested_at`
    );
    res.json(rows.map((r) => ({
      ...r,
      requested_quantity: num(r.requested_quantity), approved_quantity: num(r.approved_quantity),
      odometer_reading: num(r.odometer_reading), hour_meter_reading: num(r.hour_meter_reading),
      last_fill_qty: num(r.last_fill_qty),
      stage: r.status === "pending" ? "approval" : r.is_plant ? "issue" : "outside",
    })));
  } catch (err) {
    console.error("GET /fuel-module/issue-queue failed:", err);
    res.status(500).json({ error: "Could not load the fuel requests." });
  }
});

// ===================== Purchases =====================
// Every diesel purchase, any status. Requesting, approving, rejecting and
// receiving use the existing /store-stock/purchases endpoints.

router.get("/purchases", requirePermission("fuel.purchases", "view"), async (req, res) => {
  try {
    const item = await fuelItem();
    const { rows } = await query(
      `SELECT sp.*, ur.name AS requested_by_name, ua.name AS approved_by_name, urc.name AS received_by_name
         FROM store_stock_purchases sp
         LEFT JOIN users ur  ON ur.id  = sp.requested_by
         LEFT JOIN users ua  ON ua.id  = sp.approved_by
         LEFT JOIN users urc ON urc.id = sp.received_by
        WHERE sp.stock_item_id = $1
          AND (sp.status IN ('pending', 'approved') OR sp.requested_at > now() - INTERVAL '180 days')
        ORDER BY CASE sp.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, sp.requested_at DESC
        LIMIT 200`,
      [item.id]
    );
    res.json({
      item: { id: item.id, current_qty: num(item.current_qty), rate_per_liter: num(item.rate_per_liter) },
      purchases: rows.map((r) => ({
        ...r,
        requested_qty: num(r.requested_qty), approved_qty: num(r.approved_qty), received_qty: num(r.received_qty),
        unit_cost: num(r.unit_cost), total_cost: num(r.total_cost),
      })),
    });
  } catch (err) {
    console.error("GET /fuel-module/purchases failed:", err);
    res.status(500).json({ error: "Could not load diesel purchases." });
  }
});

// ===================== Reports: stock statement =====================

router.get("/stock-statement", requirePermission("fuel.reports", "view"), async (req, res) => {
  const { from, to } = range(req, 30);
  const group = ["day", "week", "month"].includes(req.query.group) ? req.query.group : "week";
  try {
    const item = await fuelItem();
    const step = group === "day" ? "1 day" : group === "week" ? "1 week" : "1 month";
    const start = group === "week" ? `date_trunc('week', $2::date)::date` : group === "month" ? `date_trunc('month', $2::date)::date` : `$2::date`;
    const { rows } = await query(
      `WITH buckets AS (
         SELECT b::date AS b_start,
                LEAST((b + interval '${step}' - interval '1 day')::date, $3::date) AS b_end
           FROM generate_series(${start}, $3::date, interval '${step}') b
       )
       SELECT to_char(GREATEST(b.b_start, $2::date), 'YYYY-MM-DD') AS from_date,
              to_char(b.b_end, 'YYYY-MM-DD') AS to_date,
              COALESCE((SELECT SUM(qty_change) FROM store_stock_transactions
                         WHERE stock_item_id = $1 AND created_at::date >= GREATEST(b.b_start, $2::date)), 0) AS since_start,
              COALESCE((SELECT SUM(qty_change) FROM store_stock_transactions
                         WHERE stock_item_id = $1 AND created_at::date > b.b_end), 0) AS after_end,
              COALESCE((SELECT SUM(qty_change) FROM store_stock_transactions
                         WHERE stock_item_id = $1 AND txn_type = 'purchase_receive'
                           AND created_at::date BETWEEN GREATEST(b.b_start, $2::date) AND b.b_end), 0) AS received,
              COALESCE((SELECT -SUM(qty_change) FROM store_stock_transactions
                         WHERE stock_item_id = $1 AND txn_type = 'issue_deduct'
                           AND created_at::date BETWEEN GREATEST(b.b_start, $2::date) AND b.b_end), 0) AS issued,
              COALESCE((SELECT SUM(qty_change) FROM store_stock_transactions
                         WHERE stock_item_id = $1 AND txn_type = 'adjustment'
                           AND created_at::date BETWEEN GREATEST(b.b_start, $2::date) AND b.b_end), 0) AS adjusted,
              COALESCE((SELECT SUM(sr.fuel_cost) FROM store_stock_transactions sst
                          JOIN supply_requests sr ON sst.reference_type = 'supply_request' AND sr.id = sst.reference_id
                         WHERE sst.stock_item_id = $1 AND sst.txn_type = 'issue_deduct'
                           AND sst.created_at::date BETWEEN GREATEST(b.b_start, $2::date) AND b.b_end), 0) AS issued_value
         FROM buckets b ORDER BY b.b_start`,
      [item.id, from, to]
    );
    const current = Number(item.current_qty);
    const r2 = (v) => Math.round(Number(v) * 100) / 100;
    res.json({
      from_date: from, to_date: to, group,
      rows: rows.map((r) => ({
        from_date: r.from_date, to_date: r.to_date,
        opening: r2(current - Number(r.since_start)),
        received: r2(r.received), issued: r2(r.issued), adjusted: r2(r.adjusted),
        closing: r2(current - Number(r.after_end)),
        issued_value: r2(r.issued_value),
      })),
      summary: await tankSummary(from, to),
    });
  } catch (err) {
    console.error("GET /fuel-module/stock-statement failed:", err);
    res.status(500).json({ error: "Could not load the stock statement." });
  }
});

// ===================== 360° analysis — the new parts =====================
// The Trucks and Pumps & equipment views keep using /fuel-analysis exactly as
// before. These add the plant-wide Overview, month-by-month trends, the
// Exceptions list and the Approvals view.

const ANALYSIS = requirePermission("reports.fuel-analysis", "view");

function monthsEnding(to, n = 6) {
  const [y, m] = to.split("-").map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// The comparison range: the same number of days immediately before, or the
// same dates a year earlier.
function compareRange(from, to, mode) {
  if (mode === "none") return null;
  const d = (s) => new Date(`${s}T00:00:00Z`);
  const fmt = (x) => x.toISOString().slice(0, 10); // ist-ok: x is built at UTC midnight from a yyyy-mm-dd string, so slicing returns that same day
  if (mode === "year") {
    const f = d(from); f.setUTCFullYear(f.getUTCFullYear() - 1);
    const t = d(to); t.setUTCFullYear(t.getUTCFullYear() - 1);
    return { from: fmt(f), to: fmt(t) };
  }
  const days = Math.round((d(to) - d(from)) / 86400000) + 1;
  const t = d(from); t.setUTCDate(t.getUTCDate() - 1);
  const f = new Date(t); f.setUTCDate(f.getUTCDate() - (days - 1));
  return { from: fmt(f), to: fmt(t) };
}

async function periodTotals(from, to) {
  const [fuel, m3, ext] = await Promise.all([
    query(
      `WITH ${ISSUED_FUEL_CTE}
       SELECT COALESCE(SUM(actual_quantity_issued), 0) AS litres,
              COALESCE(SUM(fuel_cost), 0) AS cost,
              COALESCE(SUM(actual_quantity_issued) FILTER (WHERE fuel_cost IS NOT NULL), 0) AS costed_litres,
              COUNT(*) AS fills,
              COALESCE(SUM(actual_quantity_issued) FILTER (WHERE category = 'truck'), 0) AS truck,
              COALESCE(SUM(actual_quantity_issued) FILTER (WHERE category = 'pump'), 0) AS pump,
              COALESCE(SUM(actual_quantity_issued) FILTER (WHERE category = 'equipment'), 0) AS equipment,
              COUNT(DISTINCT unit_id) FILTER (WHERE category = 'truck') AS truck_units,
              COUNT(DISTINCT unit_id) FILTER (WHERE category = 'pump') AS pump_units,
              COUNT(DISTINCT unit_id) FILTER (WHERE category = 'equipment') AS equipment_units
         FROM sr_all WHERE issued_at::date BETWEEN $1 AND $2`,
      [from, to]
    ),
    query(
      `SELECT (SELECT COALESCE(SUM(batch_qty_m3), 0) FROM plant_batches WHERE batch_date BETWEEN $1 AND $2)
            + (SELECT COALESCE(SUM(qty_m3), 0) FROM plant_manual_entries WHERE entry_date BETWEEN $1 AND $2 AND material_id IS NULL) AS m3`,
      [from, to]
    ),
    query(
      `WITH ${ISSUED_FUEL_CTE}
       SELECT COALESCE(SUM(s.actual_quantity_issued), 0) AS litres, COUNT(*) AS fills, COALESCE(SUM(s.fuel_cost), 0) AS cost
         FROM sr_all s LEFT JOIN fuel_stations fs ON fs.id = s.station_id
        WHERE NOT COALESCE(fs.is_plant, false) AND s.issued_at::date BETWEEN $1 AND $2`,
      [from, to]
    ),
  ]);
  const f = fuel.rows[0];
  const litres = Number(f.litres);
  const cost = Number(f.cost);
  const m3v = Number(m3.rows[0].m3) || 0;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    from, to,
    litres: r2(litres), cost: r2(cost), fills: Number(f.fills),
    avg_rate: Number(f.costed_litres) > 0 ? r2(cost / Number(f.costed_litres)) : null,
    m3_produced: r2(m3v),
    litres_per_m3: m3v > 0 ? Math.round((litres / m3v) * 1000) / 1000 : null,
    cost_per_m3: m3v > 0 ? r2(cost / m3v) : null,
    groups: {
      truck: { litres: r2(Number(f.truck)), units: Number(f.truck_units) },
      pump: { litres: r2(Number(f.pump)), units: Number(f.pump_units) },
      equipment: { litres: r2(Number(f.equipment)), units: Number(f.equipment_units) },
    },
    outside: { litres: r2(Number(ext.rows[0].litres)), fills: Number(ext.rows[0].fills), cost: r2(Number(ext.rows[0].cost)) },
  };
}

router.get("/analysis/overview", ANALYSIS, async (req, res) => {
  const { from, to } = range(req, 30);
  const mode = ["prev", "year", "none"].includes(req.query.compare) ? req.query.compare : "prev";
  try {
    const cmp = compareRange(from, to, mode);
    const months = monthsEnding(to, 6);
    const item = await fuelItem();
    const [current, previous, monthly] = await Promise.all([
      periodTotals(from, to),
      cmp ? periodTotals(cmp.from, cmp.to) : null,
      query(
        `WITH ${ISSUED_FUEL_CTE},
         m AS (SELECT unnest($1::text[]) AS ym)
         SELECT m.ym,
           (SELECT COALESCE(SUM(actual_quantity_issued), 0) FROM sr_all WHERE to_char(issued_at, 'YYYY-MM') = m.ym) AS used,
           (SELECT COALESCE(SUM(batch_qty_m3), 0) FROM plant_batches WHERE to_char(batch_date, 'YYYY-MM') = m.ym)
             + (SELECT COALESCE(SUM(qty_m3), 0) FROM plant_manual_entries WHERE to_char(entry_date, 'YYYY-MM') = m.ym AND material_id IS NULL) AS m3,
           (SELECT COALESCE(SUM(qty_change), 0) FROM store_stock_transactions
             WHERE stock_item_id = $2 AND txn_type = 'purchase_receive' AND to_char(created_at, 'YYYY-MM') = m.ym) AS received,
           (SELECT COALESCE(-SUM(qty_change), 0) FROM store_stock_transactions
             WHERE stock_item_id = $2 AND txn_type = 'issue_deduct' AND to_char(created_at, 'YYYY-MM') = m.ym) AS issued,
           (SELECT CASE WHEN SUM(received_qty) FILTER (WHERE unit_cost IS NOT NULL) > 0
                        THEN SUM(total_cost) / SUM(received_qty) FILTER (WHERE unit_cost IS NOT NULL) END
              FROM store_stock_purchases
             WHERE stock_item_id = $2 AND status = 'received' AND to_char(received_at, 'YYYY-MM') = m.ym) AS rate_paid,
           (SELECT CASE WHEN SUM(actual_quantity_issued) FILTER (WHERE fuel_cost IS NOT NULL) > 0
                        THEN SUM(fuel_cost) / SUM(actual_quantity_issued) FILTER (WHERE fuel_cost IS NOT NULL) END
              FROM sr_all WHERE to_char(issued_at, 'YYYY-MM') = m.ym) AS rate_charged
         FROM m ORDER BY m.ym`,
        [months, item.id]
      ),
    ]);

    // Why the bill moved: more (or fewer) litres at the old rate, plus the
    // change in rate on this period's litres. The two add up to the change.
    let costChange = null;
    if (previous && previous.avg_rate != null && current.avg_rate != null) {
      const volume = (current.litres - previous.litres) * previous.avg_rate;
      const rate = (current.avg_rate - previous.avg_rate) * current.litres;
      costChange = { total: Math.round(current.cost - previous.cost), volume: Math.round(volume), rate: Math.round(rate) };
    }
    const r = (v, d = 2) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
    res.json({
      compare: mode, current, previous, cost_change: costChange,
      months: monthly.rows.map((m) => {
        const m3 = Number(m.m3) || 0;
        return {
          month: m.ym, used: r(m.used), m3_produced: r(m3, 1),
          litres_per_m3: m3 > 0 ? r(Number(m.used) / m3, 3) : null,
          received: r(m.received), issued: r(m.issued),
          rate: r(m.rate_paid ?? m.rate_charged),
        };
      }),
    });
  } catch (err) {
    console.error("GET /fuel-module/analysis/overview failed:", err);
    res.status(500).json({ error: "Could not load the fuel overview." });
  }
});

// Month by month for every truck (L/m³ carried — the main figure on the
// Trucks view) and every pump / machine (L per running hour). Same bases as
// fuelAnalysis.js: a truck's litres over the m³ it carried that month; a
// machine's paired fill-to-fill litres over the hours between those fills.
router.get("/analysis/trends", ANALYSIS, async (req, res) => {
  const { to } = range(req, 30);
  const months = monthsEnding(to, Math.min(Math.max(Number(req.query.months) || 6, 2), 12));
  try {
    const [trucks, units] = await Promise.all([
      query(
        `WITH ${ISSUED_FUEL_CTE},
         m AS (SELECT unnest($1::text[]) AS ym),
         f AS (SELECT truck_id, to_char(issued_at, 'YYYY-MM') AS ym, SUM(actual_quantity_issued) AS litres
                 FROM sr_all WHERE truck_id IS NOT NULL GROUP BY 1, 2),
         q AS (SELECT dt.truck_id, to_char(dt.ticket_date, 'YYYY-MM') AS ym, SUM(dt.loaded_quantity_m3) AS m3
                 FROM delivery_tickets dt
                WHERE dt.truck_id IS NOT NULL AND dt.status NOT IN ('cancelled', 'rejected')
                GROUP BY 1, 2)
         SELECT f.truck_id, f.ym, CASE WHEN q.m3 > 0 THEN ROUND((f.litres / q.m3)::numeric, 3) END AS litres_per_m3
           FROM f JOIN m ON m.ym = f.ym LEFT JOIN q ON q.truck_id = f.truck_id AND q.ym = f.ym`,
        [months]
      ),
      query(
        `WITH ${ISSUED_FUEL_CTE},
         m AS (SELECT unnest($1::text[]) AS ym),
         iv AS (
           SELECT s.category, s.unit_id, to_char(s.issued_at, 'YYYY-MM') AS ym, s.actual_quantity_issued AS litres,
                  s.hour_meter_reading - LAG(s.hour_meter_reading) OVER (PARTITION BY s.category, s.unit_id ORDER BY s.hour_meter_reading, s.issued_at) AS hrs
             FROM sr_all s WHERE s.truck_id IS NULL AND s.hour_meter_reading IS NOT NULL
         )
         SELECT iv.category, iv.unit_id, iv.ym,
                CASE WHEN SUM(hrs) FILTER (WHERE hrs > 0) > 0
                     THEN ROUND(SUM(litres) FILTER (WHERE hrs > 0) / SUM(hrs) FILTER (WHERE hrs > 0), 2) END AS litres_per_hour
           FROM iv JOIN m ON m.ym = iv.ym
          GROUP BY 1, 2, 3`,
        [months]
      ),
    ]);
    const truckOut = {};
    for (const r of trucks.rows) {
      (truckOut[r.truck_id] ||= months.map(() => null))[months.indexOf(r.ym)] = num(r.litres_per_m3);
    }
    const unitOut = {};
    for (const r of units.rows) {
      const kind = r.category === "pump" ? "pump" : "equipment";
      (unitOut[`${kind}:${r.unit_id}`] ||= months.map(() => null))[months.indexOf(r.ym)] = num(r.litres_per_hour);
    }
    const fleetAvg = months.map((_, i) => {
      const vals = Object.values(truckOut).map((a) => a[i]).filter((v) => v != null);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : null;
    });
    res.json({ months, trucks: truckOut, units: unitOut, fleet_avg_litres_per_m3: fleetAvg });
  } catch (err) {
    console.error("GET /fuel-module/analysis/trends failed:", err);
    res.status(500).json({ error: "Could not load fuel trends." });
  }
});

// Checks over every fill in the range. Each finding names the fuel request it
// was raised on, so the Transactions ledger can open it and a Manager can mark
// it reviewed.
const CHECKS = {
  meter_backwards: "Odometer / hour meter went backwards",
  close_fills: "Two fills close together",
  after_hours: "Issued outside working hours",
  outside_with_stock: "Outside fill while the plant tank had stock",
  no_reading: "Fill with no meter reading",
};

router.get("/analysis/exceptions", ANALYSIS, async (req, res) => {
  const { from, to } = range(req, 30);
  try {
    const [s, item] = await Promise.all([settings(), fuelItem()]);
    const { rows } = await query(
      `WITH ${ISSUED_FUEL_CTE},
       seq AS (
         SELECT s.*,
                LAG(s.reading)   OVER w AS prev_reading,
                LAG(s.issued_at) OVER w AS prev_at
           FROM sr_all s
         WINDOW w AS (PARTITION BY s.category, s.unit_id ORDER BY s.issued_at)
       )
       SELECT q.id, q.issued_at, q.reading, q.prev_reading, q.prev_at, q.actual_quantity_issued,
              q.odometer_reading, q.hour_meter_reading, q.truck_id,
              ${UNIT_LABEL.replace(/\bs\./g, "q.")} AS unit_label,
              fs.name AS station_name, COALESCE(fs.is_plant, false) AS is_plant,
              to_char(q.issued_at, 'HH24:MI') AS issued_time,
              CASE WHEN $3::time <= $4::time
                   THEN (q.issued_at::time < $3::time OR q.issued_at::time >= $4::time)
                   ELSE (q.issued_at::time >= $4::time AND q.issued_at::time < $3::time) END AS after_hours,
              EXTRACT(EPOCH FROM (q.issued_at - q.prev_at)) / 3600 AS hours_since_prev,
              (SELECT sst.balance_after FROM store_stock_transactions sst
                WHERE sst.stock_item_id = $6 AND sst.created_at <= q.issued_at
                ORDER BY sst.created_at DESC, sst.id DESC LIMIT 1) AS tank_balance_then
         FROM seq q
         LEFT JOIN trucks t    ON t.id = q.truck_id
         LEFT JOIN pumps p     ON p.id = q.pump_id
         LEFT JOIN equipment e ON e.id = q.equipment_id
         LEFT JOIN fuel_stations fs ON fs.id = q.station_id
        WHERE q.issued_at::date BETWEEN $1 AND $2
          AND ( (q.reading IS NOT NULL AND q.prev_reading IS NOT NULL AND q.reading < q.prev_reading)
             OR (q.prev_at IS NOT NULL AND q.issued_at - q.prev_at < make_interval(secs => ($5::numeric * 3600)::double precision))
             OR (CASE WHEN $3::time <= $4::time
                      THEN (q.issued_at::time < $3::time OR q.issued_at::time >= $4::time)
                      ELSE (q.issued_at::time >= $4::time AND q.issued_at::time < $3::time) END)
             OR NOT COALESCE(fs.is_plant, false)
             OR q.reading IS NULL )
        ORDER BY q.issued_at DESC`,
      [from, to, s.work_start, s.work_end, s.close_fill_hours, item.id]
    );
    const reviews = await query(
      `SELECT r.check_key, r.reference_id, r.note, r.reviewed_at, u.name AS reviewed_by_name
         FROM fuel_exception_reviews r LEFT JOIN users u ON u.id = r.reviewed_by
        WHERE r.reference_id = ANY($1::int[])`,
      [rows.map((r) => r.id)]
    );
    const reviewOf = Object.fromEntries(reviews.rows.map((r) => [`${r.check_key}:${r.reference_id}`, r]));
    const reorder = s.reorder_level_l ?? 0;
    const unitWord = (r) => (r.truck_id ? "km" : "hrs");
    const found = [];
    const add = (key, r, detail) => found.push({
      check: key, label: CHECKS[key], sr_id: r.id, ref: `FR-${r.id}`, at: r.issued_at, unit_label: r.unit_label,
      litres: num(r.actual_quantity_issued), detail, review: reviewOf[`${key}:${r.id}`] || null,
    });
    for (const r of rows) {
      const rd = num(r.reading), prev = num(r.prev_reading);
      if (rd != null && prev != null && rd < prev) add("meter_backwards", r, `${rd.toLocaleString("en-IN")} ${unitWord(r)} after ${prev.toLocaleString("en-IN")} ${unitWord(r)} at the fill before`);
      const h = r.hours_since_prev == null ? null : Number(r.hours_since_prev);
      if (h != null && h < s.close_fill_hours) add("close_fills", r, `${h.toFixed(1)} hours after the previous fill`);
      if (r.after_hours) add("after_hours", r, `Issued at ${r.issued_time} (working hours ${s.work_start}–${s.work_end})`);
      const bal = r.tank_balance_then == null ? null : Number(r.tank_balance_then);
      if (!r.is_plant && bal != null && bal > reorder) add("outside_with_stock", r, `At ${r.station_name || "an outside station"} — the plant tank had ${bal.toLocaleString("en-IN")} L`);
      if (rd == null) add("no_reading", r, "No odometer or hour-meter reading, so it can't be used for consumption");
    }
    const counts = Object.fromEntries(Object.keys(CHECKS).map((k) => [k, {
      label: CHECKS[k],
      found: found.filter((f) => f.check === k).length,
      reviewed: found.filter((f) => f.check === k && f.review).length,
    }]));
    res.json({ from_date: from, to_date: to, settings: s, counts, items: found });
  } catch (err) {
    console.error("GET /fuel-module/analysis/exceptions failed:", err);
    res.status(500).json({ error: "Could not load fuel exceptions." });
  }
});

router.post("/analysis/exceptions/review", requirePermission("fuel.exception-review", "edit"), async (req, res) => {
  const { check_key, reference_id, note } = req.body;
  if (!CHECKS[check_key]) return res.status(400).json({ error: "Unknown check." });
  if (!Number.isInteger(Number(reference_id))) return res.status(400).json({ error: "Which fill is this about?" });
  if (!note || !String(note).trim()) return res.status(400).json({ error: "Write a short note on what you found." });
  try {
    const { rows } = await query(
      `INSERT INTO fuel_exception_reviews (check_key, reference_id, note, reviewed_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (check_key, reference_id) DO UPDATE SET note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()
       RETURNING *`,
      [check_key, Number(reference_id), String(note).trim().slice(0, 500), req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error("POST /fuel-module/analysis/exceptions/review failed:", err);
    res.status(500).json({ error: "Could not save the review." });
  }
});

router.get("/analysis/approvals", ANALYSIS, async (req, res) => {
  const { from, to } = range(req, 30);
  try {
    const [totals, timing, issuers, cuts] = await Promise.all([
      query(
        `SELECT COUNT(*) AS requests,
                COUNT(*) FILTER (WHERE status = 'issued') AS issued,
                COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
                COUNT(*) FILTER (WHERE status IN ('pending', 'approved')) AS open,
                COALESCE(SUM(requested_quantity) FILTER (WHERE approved_quantity IS NOT NULL AND status <> 'rejected'), 0) AS asked,
                COALESCE(SUM(approved_quantity) FILTER (WHERE approved_quantity IS NOT NULL AND status <> 'rejected'), 0) AS approved
           FROM supply_requests WHERE request_type = 'fuel' AND requested_at::date BETWEEN $1 AND $2`,
        [from, to]
      ),
      query(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (approved_at - requested_at)) / 60)
                  FILTER (WHERE approved_at IS NOT NULL AND status <> 'rejected') AS req_to_approve,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (issued_at - approved_at)) / 60)
                  FILTER (WHERE issued_at IS NOT NULL AND approved_at IS NOT NULL AND COALESCE(fs.is_plant, false)) AS approve_to_issue
           FROM supply_requests sr
           LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
          WHERE sr.request_type = 'fuel' AND sr.requested_at::date BETWEEN $1 AND $2`,
        [from, to]
      ),
      query(
        `SELECT CASE WHEN COALESCE(fs.is_plant, false) THEN u.name ELSE 'Drivers · outside stations' END AS who,
                COALESCE(fs.is_plant, false) AS at_plant,
                COUNT(*) AS fills, COALESCE(SUM(sr.actual_quantity_issued), 0) AS litres
           FROM supply_requests sr
           LEFT JOIN users u ON u.id = sr.issued_by
           LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
          WHERE sr.request_type = 'fuel' AND sr.status = 'issued' AND sr.issued_at::date BETWEEN $1 AND $2
          GROUP BY 1, 2 ORDER BY 2 DESC, litres DESC`,
        [from, to]
      ),
      query(
        `SELECT ${UNIT_LABEL} AS unit_label,
                SUM(s.requested_quantity) AS asked, SUM(s.approved_quantity) AS approved, COUNT(*) AS requests
           FROM supply_requests s ${UNIT_JOINS}
          WHERE s.request_type = 'fuel' AND s.approved_quantity IS NOT NULL AND s.status <> 'rejected'
            AND s.requested_at::date BETWEEN $1 AND $2
          GROUP BY 1
         HAVING SUM(s.requested_quantity) > SUM(s.approved_quantity)
          ORDER BY SUM(s.requested_quantity) - SUM(s.approved_quantity) DESC LIMIT 5`,
        [from, to]
      ),
    ]);
    const t = totals.rows[0];
    const asked = Number(t.asked), approved = Number(t.approved);
    res.json({
      from_date: from, to_date: to,
      requests: Number(t.requests), issued: Number(t.issued), rejected: Number(t.rejected), open: Number(t.open),
      cut_litres: Math.round((asked - approved) * 100) / 100,
      cut_pct: asked > 0 ? Math.round(((asked - approved) / asked) * 1000) / 10 : null,
      median_request_to_approve_min: timing.rows[0].req_to_approve == null ? null : Math.round(Number(timing.rows[0].req_to_approve)),
      median_approve_to_issue_min: timing.rows[0].approve_to_issue == null ? null : Math.round(Number(timing.rows[0].approve_to_issue)),
      issuers: issuers.rows.map((r) => ({ who: r.who || "Not recorded", at_plant: r.at_plant, fills: Number(r.fills), litres: num(r.litres) })),
      most_cut: cuts.rows.map((r) => ({ unit_label: r.unit_label, asked: num(r.asked), approved: num(r.approved), requests: Number(r.requests) })),
    });
  } catch (err) {
    console.error("GET /fuel-module/analysis/approvals failed:", err);
    res.status(500).json({ error: "Could not load the approvals view." });
  }
});

export default router;
