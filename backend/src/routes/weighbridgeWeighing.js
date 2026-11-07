// Round 269 — weighing a lorry from the app (owner, 6 Nov 2026: "code the …
// weighbridge mock ups", without the photo attachment).
//
// THE WEIGHT IS NEVER TYPED. The indicator agent on the weighbridge PC
// (tools/weighbridge-agent/indicator.js) reads the indicator's serial output
// and posts the reading here about once a second. A capture takes the
// server's own latest reading — the screen only sends what it showed
// (expect_kg) so a lorry that moved between the look and the tap is refused
// instead of recorded.
//
// Mounted at /api/weighbridge BEFORE routes/weighbridge.js (index.js): that
// router puts every path behind a session, and the agent's POST /live has none.
//
// A closed ticket is also written into weighbridge_tickets as ticket number
// 1,000,000 + id (source 'app'), so the Receipts screen, Record receipt's
// ticket picker and the billed-vs-weighed check treat it exactly like a
// SmartWeigh ticket. Nothing else needed to learn about app tickets.
import { Router } from "express";
import crypto from "crypto";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { resolveVehicle, normalise } from "../lib/weighbridgeNames.js";
import { ensureRound269 } from "../lib/round269Schema.js";

const router = Router();

export const APP_TICKET_BASE = 1000000;
const MAX_READING_AGE_MS = 5000;   // a capture needs a reading this fresh
const CONNECTED_MS = 15000;        // the screen says "indicator offline" after this
const MOVED_KG = 20;               // shown vs captured may differ by this much
const MIN_DIFF_KG = 200;           // 1st and 2nd weight must differ by more than this

const PURPOSES = {
  raw_in: "Production Usage",
  rmc_out: "Ready Mix Invoicing",
  internal: "Internal",
  outside: "Outside party",
};

// The latest reading. In memory on purpose: it changes every second and is
// worthless a few seconds later, so writing it to Postgres would only cost.
const live = { kg: null, stable: false, at: 0, raw: null, agent: null };

function agentAuthorised(req) {
  const expected = process.env.WEIGHBRIDGE_API_KEY;
  if (!expected) return false;
  const a = Buffer.from(req.get("x-weighbridge-key") || "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------- the indicator agent (no session) ----------------
router.post("/live", (req, res) => {
  if (!agentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });
  const kg = Number(req.body?.kg);
  if (!Number.isFinite(kg) || Math.abs(kg) > 200000) return res.status(400).json({ error: "kg must be a number." });
  live.kg = Math.round(kg);
  live.stable = !!req.body.stable;
  live.at = Date.now();
  live.raw = typeof req.body.raw === "string" ? req.body.raw.slice(0, 60) : null;
  live.agent = typeof req.body.agent_version === "string" ? req.body.agent_version.slice(0, 20) : null;
  res.json({ ok: true });
});

// ============ everything below needs a signed-in person ============
const VIEW = requirePermission("weighbridge.weighing", "view");
const CREATE = requirePermission("weighbridge.weighing", "create");
const EDIT = requirePermission("weighbridge.weighing", "edit");
const auth = [requireAuth];

function liveState() {
  const age = live.at ? Date.now() - live.at : null;
  return {
    kg: live.kg, stable: live.stable, age_ms: age, raw: live.raw,
    connected: age != null && age < CONNECTED_MS,
    ready: age != null && age <= MAX_READING_AGE_MS && live.stable && live.kg != null,
  };
}

router.get("/live", auth, VIEW, (req, res) => res.json(liveState()));

// Takes the weight now, or explains why it can't.
function capture(expectKg) {
  const s = liveState();
  if (!s.connected || s.age_ms > MAX_READING_AGE_MS) {
    return { error: "No live weight from the weighbridge. Check that the indicator agent is running on the weighbridge PC." };
  }
  if (!s.stable) return { error: "The weight is not stable yet — wait for the lorry to settle and try again." };
  if (s.kg <= 0) return { error: "The weighbridge shows no load." };
  if (expectKg != null && expectKg !== "" && Math.abs(Number(expectKg) - s.kg) > MOVED_KG) {
    return { error: `The weight changed to ${s.kg.toLocaleString("en-IN")} kg — check and capture again.`, kg: s.kg };
  }
  return { kg: s.kg, reading_at: new Date(live.at) };
}

const txt = (v, n) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
const int = (v) => (v == null || v === "" || !Number.isInteger(Number(v)) ? null : Number(v));
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------------- lists for the form ----------------
router.get("/weighing-options", auth, VIEW, async (req, res) => {
  try {
    await ensureRound269();
    const [materials, suppliers, orders, dts] = await Promise.all([
      query(`SELECT id, name, purchase_unit, kg_per_purchase_unit::float AS kg_per_unit FROM rm_materials WHERE is_active ORDER BY name`),
      query(`SELECT id, name FROM rm_suppliers WHERE is_active ORDER BY name`),
      query(`SELECT o.id, o.material_id, o.supplier_id, m.name AS material_name, s.name AS supplier_name,
                    o.ordered_qty::float AS ordered_qty, m.purchase_unit
               FROM rm_orders o JOIN rm_materials m ON m.id = o.material_id JOIN rm_suppliers s ON s.id = o.supplier_id
              WHERE o.status = 'approved' ORDER BY o.id DESC LIMIT 200`),
      query(`SELECT dt.id, dt.ticket_number, t.truck_number, c.name AS customer_name, dt.loaded_quantity_m3::float AS qty_m3
               FROM delivery_tickets dt
               LEFT JOIN trucks t ON t.id = dt.truck_id
               LEFT JOIN customer_orders o ON o.id = dt.order_id
               LEFT JOIN customers c ON c.id = o.customer_id
              WHERE dt.ticket_date >= CURRENT_DATE - 1 ORDER BY dt.id DESC LIMIT 150`).catch(() => ({ rows: [] })),
    ]);
    res.json({ materials: materials.rows, suppliers: suppliers.rows, orders: orders.rows, delivery_tickets: dts.rows, purposes: PURPOSES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the lists for weighing." });
  }
});

// What the app already knows about a registration: whose lorry, last tare,
// and whether it is already on an open ticket.
router.get("/vehicle-lookup", auth, VIEW, async (req, res) => {
  try {
    await ensureRound269();
    const norm = normalise(req.query.reg || "");
    if (!norm) return res.json({ found: false });
    const { rows } = await query(
      `SELECT v.id, v.registration, v.supplier_id, s.name AS supplier_name, v.truck_id, t.truck_number
         FROM weighbridge_vehicles v
         LEFT JOIN rm_suppliers s ON s.id = v.supplier_id
         LEFT JOIN trucks t ON t.id = v.truck_id
        WHERE v.normalised = $1
           OR v.id = (SELECT vehicle_id FROM weighbridge_vehicle_aliases WHERE normalised = $1 AND vehicle_id IS NOT NULL LIMIT 1)
        LIMIT 1`, [norm]).catch(() => ({ rows: [] }));
    if (!rows.length) return res.json({ found: false });
    const v = rows[0];
    const [tare, open] = await Promise.all([
      query(`SELECT empty_weight_kg AS kg, COALESCE(empty_weighed_at, weighed_at) AS at FROM weighbridge_tickets
              WHERE vehicle_id = $1 AND empty_weight_kg > 0 ORDER BY COALESCE(empty_weighed_at, weighed_at) DESC NULLS LAST LIMIT 1`, [v.id]),
      query(`SELECT id, ticket_no FROM wb_app_tickets WHERE vehicle_id = $1 AND status = 'open' LIMIT 1`, [v.id]),
    ]);
    res.json({ found: true, ...v, last_tare_kg: tare.rows[0]?.kg ?? null, last_tare_at: tare.rows[0]?.at ?? null, open_ticket: open.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not look up the vehicle." });
  }
});

const SELECT = `
  SELECT a.*, m.name AS material_name, m.purchase_unit, m.kg_per_purchase_unit::float AS kg_per_unit, m.tolerance_pct::float AS tolerance_pct,
         s.name AS supplier_name, t.truck_number, dt.ticket_number AS dt_number, c.name AS dt_customer,
         u1.name AS first_by_name, u2.name AS second_by_name, u3.name AS cancelled_by_name,
         CASE WHEN a.purpose = 'raw_in' AND a.status = 'closed' AND a.challan_qty > 0 AND m.kg_per_purchase_unit > 0
              THEN a.net_kg - ROUND(a.challan_qty * m.kg_per_purchase_unit)::int END AS diff_kg
    FROM wb_app_tickets a
    LEFT JOIN rm_materials m ON m.id = a.material_id
    LEFT JOIN rm_suppliers s ON s.id = a.supplier_id
    LEFT JOIN trucks t ON t.id = a.truck_id
    LEFT JOIN delivery_tickets dt ON dt.id = a.delivery_ticket_id
    LEFT JOIN customer_orders co ON co.id = dt.order_id
    LEFT JOIN customers c ON c.id = co.customer_id
    LEFT JOIN users u1 ON u1.id = a.first_by
    LEFT JOIN users u2 ON u2.id = a.second_by
    LEFT JOIN users u3 ON u3.id = a.cancelled_by`;

function shortFlag(r) {
  if (r.diff_kg == null || !(r.challan_qty > 0)) return null;
  const billedKg = Math.round(Number(r.challan_qty) * Number(r.kg_per_unit));
  const pct = billedKg ? (r.diff_kg / billedKg) * 100 : 0;
  const tol = r.tolerance_pct != null ? Number(r.tolerance_pct) : 1;
  return { billed_kg: billedKg, diff_kg: r.diff_kg, pct: Math.round(pct * 10) / 10, short: pct < -tol, tolerance_pct: tol };
}
const shape = (r) => ({ ...r, variance: shortFlag(r) });

router.get("/weighings", auth, VIEW, async (req, res) => {
  try {
    await ensureRound269();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : null;
    const [open, closed, summary] = await Promise.all([
      query(`${SELECT} WHERE a.status = 'open' ORDER BY a.first_at`),
      query(`${SELECT} WHERE a.status <> 'open'
               AND (COALESCE(a.second_at, a.cancelled_at) AT TIME ZONE 'Asia/Kolkata')::date = COALESCE($1::date, (now() AT TIME ZONE 'Asia/Kolkata')::date)
             ORDER BY COALESCE(a.second_at, a.cancelled_at) DESC`, [day]),
      query(`SELECT count(*) FILTER (WHERE status = 'closed')::int AS closed,
                    COALESCE(sum(net_kg) FILTER (WHERE status = 'closed' AND purpose = 'raw_in'), 0)::bigint AS net_in_kg
               FROM wb_app_tickets
              WHERE (second_at AT TIME ZONE 'Asia/Kolkata')::date = COALESCE($1::date, (now() AT TIME ZONE 'Asia/Kolkata')::date)`, [day]),
    ]);
    const closedRows = closed.rows.map(shape);
    res.json({
      open: open.rows.map(shape),
      closed: closedRows,
      summary: { ...summary.rows[0], open: open.rows.length, short: closedRows.filter((r) => r.variance?.short).length },
      live: liveState(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the weighings." });
  }
});

router.get("/weighings/:id", auth, VIEW, async (req, res) => {
  try {
    await ensureRound269();
    const { rows } = await query(`${SELECT} WHERE a.id = $1`, [int(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: "Ticket not found." });
    res.json(shape(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the ticket." });
  }
});

// ---------------- first weight: opens the ticket ----------------
router.post("/weighings", auth, CREATE, async (req, res) => {
  const b = req.body || {};
  const purpose = PURPOSES[b.purpose] ? b.purpose : null;
  if (!purpose) return res.status(400).json({ error: "Choose the purpose." });
  const vehicle = txt(b.vehicle, 60);
  if (!vehicle || !normalise(vehicle)) return res.status(400).json({ error: "Enter the vehicle number." });
  let materialId = int(b.material_id), supplierId = int(b.supplier_id);
  const orderId = int(b.rm_order_id);
  try {
    await ensureRound269();
    if (orderId) {
      const { rows } = await query(`SELECT material_id, supplier_id FROM rm_orders WHERE id = $1`, [orderId]);
      if (!rows.length) return res.status(400).json({ error: "That purchase order was not found." });
      materialId = rows[0].material_id; supplierId = rows[0].supplier_id;
    }
    if (purpose === "raw_in" && (!materialId || !supplierId)) {
      return res.status(400).json({ error: "Choose the material and the supplier (or the purchase order)." });
    }
    if (purpose === "outside" && !txt(b.party_name, 150)) return res.status(400).json({ error: "Enter the party's name." });
    const chargeMode = ["cash", "upi", "credit"].includes(b.charge_mode) ? b.charge_mode : null;

    const veh = await resolveVehicle(vehicle);
    if (veh.vehicle_id) {
      const { rows: open } = await query(`SELECT ticket_no FROM wb_app_tickets WHERE vehicle_id = $1 AND status = 'open'`, [veh.vehicle_id]);
      if (open.length) return res.status(409).json({ error: `${vehicle} is already on open ticket ${open[0].ticket_no} — take its second weight.` });
    }
    const w = capture(b.expect_kg);
    if (w.error) return res.status(409).json(w);

    const { rows } = await query(
      `INSERT INTO wb_app_tickets (ticket_no, purpose, vehicle_text, vehicle_id, truck_id, material_id, material_text, supplier_id,
                                   rm_order_id, delivery_ticket_id, party_name, charge_amount, charge_mode, challan_no, challan_qty,
                                   driver_name, remarks, first_kg, first_by)
       VALUES ('WB-A-' || lpad(nextval('wb_app_ticket_seq')::text, 4, '0'), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id, ticket_no`,
      [purpose, vehicle.toUpperCase(), veh.vehicle_id, veh.truck_id, materialId, txt(b.material_text, 120), supplierId,
        orderId, int(b.delivery_ticket_id), txt(b.party_name, 150), num(b.charge_amount), chargeMode,
        txt(b.challan_no, 60), num(b.challan_qty), txt(b.driver_name, 120), txt(b.remarks, 1000), w.kg, req.user.id]);
    res.status(201).json({ ok: true, ...rows[0], kg: w.kg });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "This vehicle already has an open ticket." });
    console.error(err);
    res.status(500).json({ error: "Could not open the ticket." });
  }
});

// ---------------- second weight: closes the ticket ----------------
router.post("/weighings/:id/second", auth, CREATE, async (req, res) => {
  const id = int(req.params.id);
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await ensureRound269();
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM wb_app_tickets WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Ticket not found." }); }
    const t = rows[0];
    if (t.status !== "open") { await client.query("ROLLBACK"); return res.status(409).json({ error: `Ticket ${t.ticket_no} is already ${t.status}.` }); }
    const w = capture(b.expect_kg);
    if (w.error) { await client.query("ROLLBACK"); return res.status(409).json(w); }
    if (Math.abs(w.kg - t.first_kg) <= MIN_DIFF_KG) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `The second weight (${w.kg.toLocaleString("en-IN")} kg) is within ${MIN_DIFF_KG} kg of the first — has the lorry been loaded / unloaded?` });
    }
    const gross = Math.max(w.kg, t.first_kg), tare = Math.min(w.kg, t.first_kg), net = gross - tare;
    const secondAt = new Date();
    const firstIsGross = t.first_kg >= w.kg;
    const challanQty = b.challan_qty !== undefined && b.challan_qty !== "" ? num(b.challan_qty) : t.challan_qty;
    const remarks = txt(b.remarks, 1000) ?? t.remarks;
    await client.query(
      `UPDATE wb_app_tickets SET second_kg = $2, second_at = $3, second_by = $4, gross_kg = $5, tare_kg = $6, net_kg = $7,
              status = 'closed', challan_qty = $8, remarks = $9, wb_ticket_number = $10 WHERE id = $1`,
      [id, w.kg, secondAt, req.user.id, gross, tare, net, challanQty, remarks, APP_TICKET_BASE + id]);

    // Into the shared ticket table, as if the weighbridge had weighed it.
    const { rows: names } = await client.query(
      `SELECT (SELECT name FROM rm_materials WHERE id = $1) AS material, (SELECT name FROM rm_suppliers WHERE id = $2) AS supplier`,
      [t.material_id, t.supplier_id]);
    let status = "ignored", unresolved = [], note = "Weighed in the app — not a raw-material receipt.";
    if (t.purpose === "raw_in") {
      if (!t.material_id) unresolved.push("material");
      if (!t.supplier_id) unresolved.push("supplier");
      status = unresolved.length ? "needs_review" : "matched";
      note = null;
    }
    const firstAt = t.first_at;
    await client.query(
      `INSERT INTO weighbridge_tickets
         (ticket_number, raw_vehicle, raw_material, raw_supplier, purpose, challan_number, driver_name, site_name, remarks,
          charges, empty_weight_kg, loaded_weight_kg, net_weight_kg, billed_qty_raw, ticket_date,
          empty_weighed_at, loaded_weighed_at, weighed_at, material_id, supplier_id, truck_id, vehicle_id,
          match_status, unresolved, review_note, source_hash, source, app_ticket_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ($15::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,
               $16, $17, $15, $18, $19, $20, $21, $22::wb_match_status, $23, $24, $25, 'app', $26)
       ON CONFLICT (ticket_number) DO NOTHING`,
      [APP_TICKET_BASE + id, t.vehicle_text, names[0].material || t.material_text, names[0].supplier || t.party_name,
        PURPOSES[t.purpose], t.challan_no, t.driver_name, "RMC PLANT", remarks,
        t.charge_amount != null ? `${t.charge_amount} ${t.charge_mode || ""}`.trim() : null,
        tare, gross, net, challanQty != null ? String(challanQty) : null, secondAt,
        firstIsGross ? secondAt : firstAt, firstIsGross ? firstAt : secondAt,
        t.material_id, t.supplier_id, t.truck_id, t.vehicle_id, status, unresolved, note,
        crypto.createHash("sha256").update(`app:${id}`).digest("hex"), t.ticket_no]);
    await client.query("COMMIT");
    const { rows: out } = await query(`${SELECT} WHERE a.id = $1`, [id]);
    res.json({ ok: true, ticket: shape(out[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not close the ticket." });
  } finally {
    client.release();
  }
});

// Cancel an open ticket (a lorry that turned back). Never reused, never deleted.
router.post("/weighings/:id/cancel", auth, EDIT, async (req, res) => {
  const reason = txt(req.body?.reason, 500);
  if (!reason) return res.status(400).json({ error: "Give the reason for cancelling." });
  try {
    await ensureRound269();
    const { rowCount } = await query(
      `UPDATE wb_app_tickets SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3, cancelled_at = now()
        WHERE id = $1 AND status = 'open'`, [int(req.params.id), reason, req.user.id]);
    if (!rowCount) return res.status(409).json({ error: "Only an open ticket can be cancelled." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not cancel the ticket." });
  }
});

export default router;
