// ===========================================================================
// Round 216 — Maintenance module, part 2 (mounted on /api/maintenance-module
// beside routes/maintenanceModule.js):
//
//   TYRES & BATTERIES (mockup screen 10). Every tyre and battery by serial
//   number: where it is fitted, how far it has run, retreads, tread readings,
//   warranty and warranty claims. Every move records the odometer, so a
//   tyre's life follows it across vehicles and retreads (mnt_tb_moves). A
//   tyre or battery bought through the maintenance store and issued on a job
//   card is registered against that issue, so its cost is the cost already on
//   the job card — never counted twice.
//
//   CERTIFICATES (mockup screen 11) — replaces Statutory Compliance. Renewal
//   adds a new certificate and keeps the old one in history; the fee can go
//   to Payments (to be paid, or paid now). The Administrator sets which
//   certificates every machine of a type must have; a missing one shows as
//   "Not on file". Reminders 30, 15 and 7 days before (lib/scheduledChecks.js).
//
//   FROM THE OLD SCREENS. Old Maintenance action points become PM schedules
//   (with each vehicle's last-done carried over); open repair action points,
//   outside-repair requests, inspection action items and breakdowns become
//   jobs on job cards.
// ===========================================================================
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, requireAnyPermission } from "../lib/permissions.js";
import { assetReadings } from "../lib/maintenanceDue.js";
import { openCardFor, addJobs, assetForMaster, jobCode } from "../lib/maintenanceJobs.js";
import { CERT_TYPES, TYRE_LAYOUTS, BATTERY_SLOTS } from "../lib/round216Schema.js";

const router = Router();
router.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}
function money(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}
function fail(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
// Run a handler; a thrown fail() becomes a clean 4xx.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.status) return bad(res, err.message, err.status);
    if (err.code === "23505" && /serial/.test(err.constraint || "")) return bad(res, "That serial number is already in the register.", 409);
    if (err.code === "23505" && /position/.test(err.constraint || "")) return bad(res, "Something is already fitted in that position.", 409);
    throw err;
  }
};

// ============================================================ tyres ===

const TYRE_STATUS_SQL = `t.id, t.serial, t.brand, t.size, t.pattern, t.kind, t.status, t.asset_id, t.position, t.fitted_at, t.fitted_km,
  t.km_run, t.retread_count, t.retread_vendor, t.last_tread_mm, t.last_tread_at::text AS last_tread_at, t.cost, t.retread_cost,
  t.store_txn_id, t.supplier, t.purchase_date::text AS purchase_date, t.notes`;

function tyreOut(t, kmNow) {
  const current = t.status === "fitted" && t.fitted_km != null && kmNow != null ? Math.max(0, kmNow - Number(t.fitted_km)) : 0;
  const total = Number(t.km_run) + current;
  const cost = Number(t.cost || 0) + Number(t.retread_cost || 0);
  return {
    ...t, fitted_km: t.fitted_km == null ? null : Number(t.fitted_km), km_run: Number(t.km_run),
    last_tread_mm: t.last_tread_mm == null ? null : Number(t.last_tread_mm), cost: t.cost == null ? null : Number(t.cost),
    retread_cost: Number(t.retread_cost || 0), run_here: current, total_km: total,
    cost_per_km: total > 0 && cost > 0 ? Math.round((cost / total) * 100) / 100 : null,
  };
}

async function logMove(c, m, userId) {
  await c.query(
    `INSERT INTO mnt_tb_moves (kind, item_id, action, asset_id, position, from_position, km, tread_mm, amount, job_card_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [m.kind, m.item_id, m.action, m.asset_id || null, m.position || null, m.from_position || null, m.km ?? null, m.tread_mm ?? null,
      m.amount ?? null, m.job_card_id || null, m.note || null, userId]);
}

async function assetOr(c, assetId) {
  const { rows } = await c.query(`SELECT id, name, asset_group FROM mnt_assets WHERE id = $1 AND is_active`, [assetId]);
  if (!rows.length) throw fail("Vehicle not found.", 404);
  return rows[0];
}

// The odometer to record: the one typed, else the vehicle's latest reading.
async function kmFor(assetId, typed) {
  const k = num(typed);
  if (Number.isNaN(k) || (k != null && k < 0)) throw fail("The odometer reading must be a number.");
  if (k != null) return k;
  const r = (await assetReadings([assetId]))[assetId];
  return r?.km ?? null;
}

// A store issue (tyre / battery issued on a job card) a register entry can
// point at — its cost is already on the card. Not more entries than were issued.
async function checkStoreTxn(c, txnId, table, assetId) {
  if (!txnId) return null;
  const { rows } = await c.query(
    `SELECT t.id, t.rate, -t.qty_change AS qty, t.asset_id, i.name, i.category FROM mnt_store_txns t JOIN mnt_store_items i ON i.id = t.item_id
     WHERE t.id = $1 AND t.txn_type = 'issue'`, [txnId]);
  if (!rows.length) throw fail("That store issue wasn't found.");
  const t = rows[0];
  if (assetId && t.asset_id && t.asset_id !== Number(assetId)) throw fail("That store issue was for another vehicle.");
  const used = await c.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE store_txn_id = $1`, [txnId]);
  if (used.rows[0].n >= Number(t.qty)) throw fail(`All ${Number(t.qty)} from that store issue are already in the register.`, 409);
  return t;
}

router.get("/tyres/overview", requirePermission("mnt.tyres", "view"), async (req, res) => {
  const [tyres, batteries, assets] = await Promise.all([
    query(`SELECT ${TYRE_STATUS_SQL}, a.name AS asset_name FROM mnt_tyres t LEFT JOIN mnt_assets a ON a.id = t.asset_id
           WHERE t.status <> 'scrapped' OR t.created_at > now() - interval '1 year' ORDER BY t.serial`),
    query(`SELECT b.*, b.warranty_until::text AS warranty_until, b.claim_at::text AS claim_at, b.purchase_date::text AS purchase_date,
             a.name AS asset_name, (b.warranty_until - CURRENT_DATE) AS warranty_days
           FROM mnt_batteries b LEFT JOIN mnt_assets a ON a.id = b.asset_id
           WHERE b.status <> 'scrapped' ORDER BY b.serial`),
    query(`SELECT id, name, asset_group FROM mnt_assets WHERE is_active ORDER BY asset_group, name`),
  ]);
  const readings = await assetReadings(assets.rows.map((a) => a.id));
  const ty = tyres.rows.map((t) => tyreOut(t, t.asset_id ? readings[t.asset_id]?.km ?? null : null));
  const fitted = ty.filter((t) => t.status === "fitted");
  let cost = 0, km = 0;
  for (const t of ty) if (t.total_km > 0 && (t.cost || t.retread_cost)) { cost += (t.cost || 0) + t.retread_cost; km += t.total_km; }
  const vehicles = assets.rows.filter((a) => TYRE_LAYOUTS[a.asset_group] || BATTERY_SLOTS[a.asset_group]).map((a) => {
    const mine = fitted.filter((t) => t.asset_id === a.id);
    const treads = mine.map((t) => t.last_tread_mm).filter((x) => x != null);
    return {
      id: a.id, name: a.name, asset_group: a.asset_group, positions: (TYRE_LAYOUTS[a.asset_group] || []).length,
      fitted: mine.length, min_tread: treads.length ? Math.min(...treads) : null,
      batteries: batteries.rows.filter((b) => b.status === "fitted" && b.asset_id === a.id).length,
      km: readings[a.id]?.km ?? null,
    };
  });
  const bats = batteries.rows.map((b) => ({ ...b, cost: b.cost == null ? null : Number(b.cost), warranty_days: b.warranty_days == null ? null : Number(b.warranty_days) }));
  res.json({
    kpis: {
      fitted: fitted.filter((t) => t.position !== "SPARE").length,
      spares: fitted.filter((t) => t.position === "SPARE").length,
      in_store: ty.filter((t) => t.status === "in_store").length,
      low_tread: fitted.filter((t) => t.last_tread_mm != null && t.last_tread_mm < 4).length,
      at_retread: ty.filter((t) => t.status === "at_retread").length,
      cost_per_km: km > 0 ? Math.round((cost / km) * 100) / 100 : null,
      battery_warranty_soon: bats.filter((b) => b.status === "fitted" && b.warranty_days != null && b.warranty_days >= 0 && b.warranty_days <= 60).length,
      battery_claims: bats.filter((b) => b.status === "claim").length,
    },
    vehicles,
    tyres: ty.filter((t) => t.status !== "fitted"),
    low_tread: fitted.filter((t) => t.last_tread_mm != null && t.last_tread_mm < 4),
    batteries: bats,
  });
});

router.get("/tyres/vehicle/:assetId", requirePermission("mnt.tyres", "view"), handle(async (req, res) => {
  const a = (await query(`SELECT id, name, asset_group FROM mnt_assets WHERE id = $1`, [req.params.assetId])).rows[0];
  if (!a) return bad(res, "Vehicle not found.", 404);
  const id = a.id;
  const km = (await assetReadings([id]))[id]?.km ?? null;
  const [tyres, bats, moves, storeT, storeB, issues, cards] = await Promise.all([
    query(`SELECT ${TYRE_STATUS_SQL} FROM mnt_tyres t WHERE t.asset_id = $1 AND t.status = 'fitted'`, [id]),
    query(`SELECT b.*, b.warranty_until::text AS warranty_until, (b.warranty_until - CURRENT_DATE) AS warranty_days
           FROM mnt_batteries b WHERE b.asset_id = $1 AND b.status = 'fitted' ORDER BY b.position`, [id]),
    query(`SELECT m.*, COALESCE(t.serial, b.serial) AS serial, COALESCE(t.brand, b.make) AS brand, u.name AS by_name
           FROM mnt_tb_moves m LEFT JOIN mnt_tyres t ON m.kind = 'tyre' AND t.id = m.item_id
           LEFT JOIN mnt_batteries b ON m.kind = 'battery' AND b.id = m.item_id LEFT JOIN users u ON u.id = m.created_by
           WHERE m.asset_id = $1 ORDER BY m.id DESC LIMIT 40`, [id]),
    query(`SELECT ${TYRE_STATUS_SQL} FROM mnt_tyres t WHERE t.status = 'in_store' ORDER BY t.kind, t.serial`),
    query(`SELECT b.*, b.warranty_until::text AS warranty_until FROM mnt_batteries b WHERE b.status = 'in_store' ORDER BY b.serial`),
    // Tyres / batteries issued from the maintenance store on this vehicle's
    // job cards that aren't in the register yet.
    query(`SELECT t.id, t.created_at, -t.qty_change AS qty, t.rate, t.job_card_id, i.name, i.category,
             (SELECT COUNT(*) FROM mnt_tyres x WHERE x.store_txn_id = t.id) + (SELECT COUNT(*) FROM mnt_batteries x WHERE x.store_txn_id = t.id) AS registered
           FROM mnt_store_txns t JOIN mnt_store_items i ON i.id = t.item_id
           WHERE t.txn_type = 'issue' AND t.asset_id = $1 AND i.category IN ('Tyres','Batteries') ORDER BY t.id DESC LIMIT 20`, [id]),
    query(`SELECT id FROM mnt_job_cards WHERE asset_id = $1 AND status = 'open' AND general_month IS NULL ORDER BY id`, [id]),
  ]);
  res.json({
    asset: { ...a, km },
    layout: TYRE_LAYOUTS[a.asset_group] || [],
    battery_slots: BATTERY_SLOTS[a.asset_group] || ["B1"],
    tyres: tyres.rows.map((t) => tyreOut(t, km)),
    batteries: bats.rows.map((b) => ({ ...b, warranty_days: b.warranty_days == null ? null : Number(b.warranty_days) })),
    moves: moves.rows,
    store_tyres: storeT.rows.map((t) => tyreOut(t, null)),
    store_batteries: storeB.rows,
    store_issues: issues.rows.filter((x) => Number(x.registered) < Number(x.qty)).map((x) => ({ ...x, qty: Number(x.qty), rate: Number(x.rate), card: jobCode(x.job_card_id) })),
    open_cards: cards.rows.map((c) => ({ id: c.id, code: jobCode(c.id) })),
  });
}));

function positionOk(group, position, kind) {
  const list = kind === "tyre" ? TYRE_LAYOUTS[group] : BATTERY_SLOTS[group] || ["B1"];
  return list && list.includes(position);
}

async function fitTyre(c, t, { asset_id, position, km, job_card_id }, userId) {
  const a = await assetOr(c, asset_id);
  if (!positionOk(a.asset_group, position, "tyre")) throw fail(`${position || "That position"} isn't a tyre position on a ${a.asset_group.toLowerCase()}.`);
  const k = await kmFor(a.id, km);
  await c.query(`UPDATE mnt_tyres SET status = 'fitted', asset_id = $1, position = $2, fitted_at = now(), fitted_km = $3 WHERE id = $4`, [a.id, position, k, t.id]);
  await logMove(c, { kind: "tyre", item_id: t.id, action: "fit", asset_id: a.id, position, km: k, job_card_id: num(job_card_id) || null,
    note: t.kind === "retread" ? `Retread tyre (${t.retread_count}×)` : null }, userId);
}

router.post("/tyres", requirePermission("mnt.tyres", "create"), handle(async (req, res) => {
  const b = req.body;
  const serial = String(b.serial || "").trim().toUpperCase();
  if (!serial) return bad(res, "Enter the tyre's serial number.");
  const cost = num(b.cost);
  if (Number.isNaN(cost) || (cost != null && cost < 0)) return bad(res, "Cost must be a number.");
  if (b.purchase_date && !DATE_RE.test(b.purchase_date)) return bad(res, "Purchase date must be yyyy-mm-dd.");
  const tread = num(b.tread_mm);
  if (Number.isNaN(tread) || (tread != null && (tread < 0 || tread > 40))) return bad(res, "Tread depth (mm) looks wrong.");
  const out = await tx(async (c) => {
    const txn = await checkStoreTxn(c, num(b.store_txn_id), "mnt_tyres", b.fit?.asset_id);
    const { rows } = await c.query(
      `INSERT INTO mnt_tyres (serial, brand, size, pattern, kind, cost, store_txn_id, supplier, purchase_date, notes, last_tread_mm, last_tread_at, retread_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11::numeric IS NULL THEN NULL ELSE CURRENT_DATE END,$12,$13) RETURNING *`,
      [serial, b.brand || null, b.size || null, b.pattern || null, b.kind === "retread" ? "retread" : "new",
        txn ? Number(txn.rate) : cost, txn?.id || null, b.supplier || null, b.purchase_date || null, b.notes || null, tread,
        b.kind === "retread" ? 1 : 0, req.user.id]);
    const t = rows[0];
    await logMove(c, { kind: "tyre", item_id: t.id, action: "add", tread_mm: tread, amount: t.cost, job_card_id: txn ? null : null,
      note: txn ? `From store issue on ${jobCode(txn.job_card_id || 0)}` : "Added to the register" }, req.user.id);
    if (b.fit?.asset_id) await fitTyre(c, t, { ...b.fit, job_card_id: b.fit.job_card_id || null }, req.user.id);
    return t;
  });
  res.status(201).json({ id: out.id });
}));

async function tyreOr(c, id) {
  const { rows } = await c.query(`SELECT * FROM mnt_tyres WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows.length) throw fail("Tyre not found.", 404);
  return rows[0];
}

router.post("/tyres/:id/fit", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  await tx(async (c) => {
    const t = await tyreOr(c, req.params.id);
    if (t.status !== "in_store") throw fail("Only a tyre in store can be fitted.", 409);
    await fitTyre(c, t, req.body, req.user.id);
  });
  res.json({ ok: true });
}));

// Off the vehicle: back to store, to the retreader, or scrap. The km it ran
// on this fitting is added to its life.
router.post("/tyres/:id/remove", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  const to = req.body.to;
  if (!["store", "retread", "scrap"].includes(to)) return bad(res, "Say where the tyre goes — store, retread or scrap.");
  const tread = num(req.body.tread_mm);
  if (Number.isNaN(tread)) return bad(res, "Tread depth must be a number.");
  await tx(async (c) => {
    const t = await tyreOr(c, req.params.id);
    if (t.status !== "fitted") throw fail("That tyre isn't fitted.", 409);
    const k = await kmFor(t.asset_id, req.body.km);
    if (k != null && t.fitted_km != null && k < Number(t.fitted_km)) throw fail(`The odometer can't be less than when it was fitted (${Number(t.fitted_km)} km).`);
    const run = k != null && t.fitted_km != null ? k - Number(t.fitted_km) : 0;
    const status = to === "store" ? "in_store" : to === "retread" ? "at_retread" : "scrapped";
    await c.query(
      `UPDATE mnt_tyres SET status = $1::varchar, km_run = km_run + $2, asset_id = NULL, position = NULL, fitted_at = NULL, fitted_km = NULL,
         last_tread_mm = COALESCE($3, last_tread_mm), last_tread_at = CASE WHEN $3::numeric IS NULL THEN last_tread_at ELSE CURRENT_DATE END,
         retread_vendor = CASE WHEN $1::varchar = 'at_retread' THEN $4 ELSE retread_vendor END
       WHERE id = $5`, [status, run, tread, req.body.retread_vendor || null, t.id]);
    await logMove(c, { kind: "tyre", item_id: t.id, action: to === "store" ? "remove" : to === "retread" ? "retread_out" : "scrap",
      asset_id: t.asset_id, from_position: t.position, km: k, tread_mm: tread, job_card_id: num(req.body.job_card_id) || null,
      note: [req.body.note, to === "retread" && req.body.retread_vendor ? `to ${req.body.retread_vendor}` : null, run ? `ran ${Math.round(run)} km` : null].filter(Boolean).join(" · ") }, req.user.id);
  });
  res.json({ ok: true });
}));

// Rotate / swap within the vehicle. Moving to an occupied position swaps the two.
router.post("/tyres/:id/move", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  const position = String(req.body.position || "");
  await tx(async (c) => {
    const t = await tyreOr(c, req.params.id);
    if (t.status !== "fitted") throw fail("That tyre isn't fitted.", 409);
    if (t.position === position) throw fail("It is already there.");
    const a = await assetOr(c, t.asset_id);
    if (!positionOk(a.asset_group, position, "tyre")) throw fail("That isn't a tyre position on this vehicle.");
    const k = await kmFor(a.id, req.body.km);
    const { rows: other } = await c.query(`SELECT * FROM mnt_tyres WHERE asset_id = $1 AND position = $2 AND status = 'fitted' FOR UPDATE`, [a.id, position]);
    // Free the target first (the unique index on fitted positions).
    await c.query(`UPDATE mnt_tyres SET position = NULL WHERE id = $1`, [t.id]);
    if (other.length) await c.query(`UPDATE mnt_tyres SET position = $1 WHERE id = $2`, [t.position, other[0].id]);
    await c.query(`UPDATE mnt_tyres SET position = $1 WHERE id = $2`, [position, t.id]);
    const card = num(req.body.job_card_id) || null;
    await logMove(c, { kind: "tyre", item_id: t.id, action: "rotate", asset_id: a.id, position, from_position: t.position, km: k, job_card_id: card }, req.user.id);
    if (other.length) await logMove(c, { kind: "tyre", item_id: other[0].id, action: "rotate", asset_id: a.id, position: t.position, from_position: position, km: k, job_card_id: card }, req.user.id);
  });
  res.json({ ok: true });
}));

router.post("/tyres/:id/retread-back", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  const cost = num(req.body.cost);
  const tread = num(req.body.tread_mm);
  if (cost == null || Number.isNaN(cost) || cost < 0) return bad(res, "Enter the retreading cost.");
  if (Number.isNaN(tread)) return bad(res, "Tread depth must be a number.");
  await tx(async (c) => {
    const t = await tyreOr(c, req.params.id);
    if (t.status !== "at_retread") throw fail("That tyre isn't at the retreader.", 409);
    await c.query(
      `UPDATE mnt_tyres SET status = 'in_store', kind = 'retread', retread_count = retread_count + 1, retread_cost = retread_cost + $1,
         last_tread_mm = COALESCE($2, last_tread_mm), last_tread_at = CASE WHEN $2::numeric IS NULL THEN last_tread_at ELSE CURRENT_DATE END
       WHERE id = $3`, [cost, tread, t.id]);
    await logMove(c, { kind: "tyre", item_id: t.id, action: "retread_back", amount: cost, tread_mm: tread, note: req.body.note || t.retread_vendor }, req.user.id);
  });
  res.json({ ok: true });
}));

router.post("/tyres/:id/tread", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  const tread = num(req.body.tread_mm);
  if (tread == null || Number.isNaN(tread) || tread < 0 || tread > 40) return bad(res, "Enter the tread depth in mm.");
  await tx(async (c) => {
    const t = await tyreOr(c, req.params.id);
    await c.query(`UPDATE mnt_tyres SET last_tread_mm = $1, last_tread_at = CURRENT_DATE WHERE id = $2`, [tread, t.id]);
    await logMove(c, { kind: "tyre", item_id: t.id, action: "tread", asset_id: t.asset_id, position: t.position, tread_mm: tread, km: t.asset_id ? await kmFor(t.asset_id, req.body.km) : null }, req.user.id);
  });
  res.json({ ok: true });
}));

router.post("/tyres/:id/scrap", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  await tx(async (c) => {
    const t = await tyreOr(c, req.params.id);
    if (!["in_store", "at_retread"].includes(t.status)) throw fail("Remove it from the vehicle first.", 409);
    await c.query(`UPDATE mnt_tyres SET status = 'scrapped' WHERE id = $1`, [t.id]);
    await logMove(c, { kind: "tyre", item_id: t.id, action: "scrap", note: req.body.note || null }, req.user.id);
  });
  res.json({ ok: true });
}));

router.get("/tyres/:id/history", requirePermission("mnt.tyres", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, a.name AS asset_name, u.name AS by_name FROM mnt_tb_moves m LEFT JOIN mnt_assets a ON a.id = m.asset_id
     LEFT JOIN users u ON u.id = m.created_by WHERE m.kind = $1 AND m.item_id = $2 ORDER BY m.id DESC`,
    [req.query.kind === "battery" ? "battery" : "tyre", req.params.id]);
  res.json(rows);
});

// ========================================================= batteries ===

async function batteryOr(c, id) {
  const { rows } = await c.query(`SELECT * FROM mnt_batteries WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows.length) throw fail("Battery not found.", 404);
  return rows[0];
}
async function fitBattery(c, b, { asset_id, position, km, job_card_id }, userId) {
  const a = await assetOr(c, asset_id);
  const pos = position || "B1";
  if (!positionOk(a.asset_group, pos, "battery")) throw fail(`${pos} isn't a battery position on this machine.`);
  const k = await kmFor(a.id, km);
  await c.query(`UPDATE mnt_batteries SET status = 'fitted', asset_id = $1, position = $2, fitted_at = now(), fitted_km = $3 WHERE id = $4`, [a.id, pos, k, b.id]);
  await logMove(c, { kind: "battery", item_id: b.id, action: "fit", asset_id: a.id, position: pos, km: k, job_card_id: num(job_card_id) || null }, userId);
}

router.post("/batteries", requirePermission("mnt.tyres", "create"), handle(async (req, res) => {
  const b = req.body;
  const serial = String(b.serial || "").trim().toUpperCase();
  if (!serial) return bad(res, "Enter the battery's serial number.");
  const cost = num(b.cost);
  if (Number.isNaN(cost) || (cost != null && cost < 0)) return bad(res, "Cost must be a number.");
  for (const d of [b.purchase_date, b.warranty_until]) if (d && !DATE_RE.test(d)) return bad(res, "Dates must be yyyy-mm-dd.");
  const out = await tx(async (c) => {
    const txn = await checkStoreTxn(c, num(b.store_txn_id), "mnt_batteries", b.fit?.asset_id);
    const { rows } = await c.query(
      `INSERT INTO mnt_batteries (serial, make, spec, warranty_until, cost, store_txn_id, supplier, purchase_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [serial, b.make || null, b.spec || null, b.warranty_until || null, txn ? Number(txn.rate) : cost, txn?.id || null,
        b.supplier || null, b.purchase_date || null, b.notes || null, req.user.id]);
    await logMove(c, { kind: "battery", item_id: rows[0].id, action: "add", amount: rows[0].cost, note: "Added to the register" }, req.user.id);
    if (b.fit?.asset_id) await fitBattery(c, rows[0], b.fit, req.user.id);
    return rows[0];
  });
  res.status(201).json({ id: out.id });
}));

router.post("/batteries/:id/fit", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  await tx(async (c) => {
    const b = await batteryOr(c, req.params.id);
    if (b.status !== "in_store") throw fail("Only a battery in store can be fitted.", 409);
    await fitBattery(c, b, req.body, req.user.id);
  });
  res.json({ ok: true });
}));

// Off the machine: to store, scrap, or — if it failed inside its warranty —
// a warranty claim instead of a purchase.
router.post("/batteries/:id/remove", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  const to = req.body.to;
  if (!["store", "scrap", "claim"].includes(to)) return bad(res, "Say where the battery goes — store, scrap or warranty claim.");
  await tx(async (c) => {
    const b = await batteryOr(c, req.params.id);
    if (b.status !== "fitted") throw fail("That battery isn't fitted.", 409);
    if (to === "claim") {
      const w = await c.query(`SELECT warranty_until IS NOT NULL AND warranty_until >= CURRENT_DATE AS ok FROM mnt_batteries WHERE id = $1`, [b.id]);
      if (!w.rows[0].ok) throw fail("This battery is out of warranty — scrap it instead.", 409);
    }
    const k = await kmFor(b.asset_id, req.body.km);
    const status = to === "store" ? "in_store" : to === "claim" ? "claim" : "scrapped";
    await c.query(
      `UPDATE mnt_batteries SET status = $1::varchar, asset_id = NULL, position = NULL, fitted_at = NULL, fitted_km = NULL,
         claim_note = CASE WHEN $1::varchar = 'claim' THEN $2 ELSE claim_note END, claim_at = CASE WHEN $1::varchar = 'claim' THEN CURRENT_DATE ELSE claim_at END
       WHERE id = $3`, [status, req.body.note || null, b.id]);
    await logMove(c, { kind: "battery", item_id: b.id, action: to === "store" ? "remove" : to === "claim" ? "claim" : "scrap",
      asset_id: b.asset_id, from_position: b.position, km: k, job_card_id: num(req.body.job_card_id) || null, note: req.body.note || null }, req.user.id);
  });
  res.json({ ok: true });
}));

// The supplier settled the claim: replaced (the old one is scrapped — add the
// replacement as a new battery at no cost) or rejected (scrap it).
router.post("/batteries/:id/claim-close", requirePermission("mnt.tyres", "edit"), handle(async (req, res) => {
  const result = req.body.result === "rejected" ? "rejected" : "replaced";
  await tx(async (c) => {
    const b = await batteryOr(c, req.params.id);
    if (b.status !== "claim") throw fail("That battery has no open claim.", 409);
    await c.query(`UPDATE mnt_batteries SET status = 'scrapped' WHERE id = $1`, [b.id]);
    await logMove(c, { kind: "battery", item_id: b.id, action: "claim_closed", note: result === "replaced" ? "Claim accepted — replaced by the supplier" : `Claim rejected${req.body.note ? ` — ${req.body.note}` : ""}` }, req.user.id);
  });
  res.json({ ok: true });
}));

// ====================================================== certificates ===

function certOut(r) {
  return {
    ...r, document: undefined, has_document: !!r.has_document, fee: r.fee == null ? null : Number(r.fee),
    days_left: r.days_left == null ? null : Number(r.days_left),
    type_label: r.label || CERT_TYPES[r.cert_type] || r.cert_type,
  };
}
const CERT_COLS = `c.id, c.asset_id, c.cert_type, c.label, c.number, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to,
  c.authority, c.fee, c.status, c.renewed_from_id, c.note, c.created_at, c.document_name, (c.document IS NOT NULL) AS has_document,
  (c.valid_to - CURRENT_DATE) AS days_left, a.name AS asset_name, a.asset_group, u.name AS created_by_name,
  b.id AS bill_id, b.amount AS bill_amount,
  (SELECT COALESCE(SUM(p.amount + p.tds), 0) FROM mnt_payments p WHERE p.bill_id = b.id) AS bill_paid`;
const CERT_FROM = `FROM mnt_certificates c JOIN mnt_assets a ON a.id = c.asset_id LEFT JOIN users u ON u.id = c.created_by
  LEFT JOIN mnt_bills b ON b.source_type = 'certificate' AND b.source_id = c.id`;

router.get("/certificates", requirePermission("mnt.certificates", "view"), async (req, res) => {
  const [certs, rules, assets, spend] = await Promise.all([
    query(`SELECT ${CERT_COLS} ${CERT_FROM} WHERE c.status = 'current' AND a.is_active ORDER BY c.valid_to, a.name`),
    query(`SELECT asset_group, cert_type FROM mnt_cert_rules`),
    query(`SELECT id, name, asset_group FROM mnt_assets WHERE is_active ORDER BY asset_group, name`),
    query(`SELECT COALESCE(SUM(fee), 0) AS s FROM mnt_certificates
           WHERE created_at >= date_trunc('year', now() - interval '3 months') + interval '3 months' AND legacy_compliance_id IS NULL`),
  ]);
  const list = certs.rows.map(certOut);
  const missing = [];
  for (const a of assets.rows) {
    for (const r of rules.rows.filter((x) => x.asset_group === a.asset_group)) {
      if (!list.some((c) => c.asset_id === a.id && c.cert_type === r.cert_type)) {
        missing.push({ asset_id: a.id, asset_name: a.name, asset_group: a.asset_group, cert_type: r.cert_type, type_label: CERT_TYPES[r.cert_type] || r.cert_type });
      }
    }
  }
  res.json({
    kpis: {
      expired: list.filter((c) => c.days_left < 0).length,
      due_30: list.filter((c) => c.days_left >= 0 && c.days_left <= 30).length,
      due_60: list.filter((c) => c.days_left > 30 && c.days_left <= 60).length,
      valid: list.filter((c) => c.days_left > 60).length,
      missing: missing.length,
      spend_fy: money(spend.rows[0].s),
    },
    certificates: list, missing,
    types: Object.entries(CERT_TYPES).map(([key, label]) => ({ key, label })),
    assets: assets.rows,
  });
});

// The dashboard / home-screen card: expired or due within 30 days.
router.get("/certificates/alerts", requireAnyPermission(["mnt.certificates", "reports.compliance", "mnt.dashboard"]), async (req, res) => {
  const { rows } = await query(`SELECT ${CERT_COLS} ${CERT_FROM} WHERE c.status = 'current' AND a.is_active AND c.valid_to - CURRENT_DATE <= 30 ORDER BY c.valid_to`);
  res.json(rows.map(certOut));
});

router.get("/certificates/:id", requirePermission("mnt.certificates", "view"), async (req, res) => {
  const { rows } = await query(`SELECT ${CERT_COLS} ${CERT_FROM} WHERE c.id = $1`, [req.params.id]);
  if (!rows.length) return bad(res, "Certificate not found.", 404);
  const c = rows[0];
  const hist = await query(`SELECT ${CERT_COLS} ${CERT_FROM} WHERE c.asset_id = $1 AND c.cert_type = $2 AND COALESCE(c.label,'') = COALESCE($3,'') ORDER BY c.valid_to DESC, c.id DESC`,
    [c.asset_id, c.cert_type, c.label]);
  res.json({ ...certOut(c), history: hist.rows.map(certOut) });
});

router.get("/certificates/:id/document", requirePermission("mnt.certificates", "view"), async (req, res) => {
  const { rows } = await query(`SELECT document, document_name, document_mime FROM mnt_certificates WHERE id = $1`, [req.params.id]);
  if (!rows.length || !rows[0].document) return bad(res, "No document on file.", 404);
  res.setHeader("Content-Type", rows[0].document_mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${String(rows[0].document_name || "certificate").replace(/[^\w.\- ]/g, "_")}"`);
  res.send(rows[0].document);
});

function docFrom(body) {
  const d = body.document;
  if (!d || !d.data) return null;
  const buf = Buffer.from(String(d.data).replace(/^data:[^,]+,/, ""), "base64");
  if (buf.length > 5 * 1024 * 1024) throw fail("The document is larger than 5 MB — use a smaller scan or photo.");
  const mime = String(d.mime || "");
  if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(mime)) throw fail("Upload a PDF or a photo (JPG / PNG).");
  return { buf, name: String(d.name || "certificate").slice(0, 150), mime };
}

// Add, or renew: the current certificate of the same type for that machine
// is kept as history (superseded), not overwritten.
router.post("/certificates", requirePermission("mnt.certificates", "create"), handle(async (req, res) => {
  const b = req.body;
  const assetId = num(b.asset_id);
  if (!assetId || Number.isNaN(assetId)) return bad(res, "Pick the vehicle or machine.");
  if (!CERT_TYPES[b.cert_type]) return bad(res, "Pick the certificate type.");
  const label = b.cert_type === "other" ? String(b.label || "").trim().slice(0, 100) : null;
  if (b.cert_type === "other" && !label) return bad(res, "Name the certificate.");
  if (!b.valid_to || !DATE_RE.test(b.valid_to)) return bad(res, "Enter the expiry (valid to) date.");
  if (b.valid_from && !DATE_RE.test(b.valid_from)) return bad(res, "Valid from must be yyyy-mm-dd.");
  if (b.valid_from && b.valid_from > b.valid_to) return bad(res, "Valid from is after valid to.");
  const fee = num(b.fee);
  if (Number.isNaN(fee) || (fee != null && fee < 0)) return bad(res, "Fee must be a number.");
  const payment = ["to_pay", "paid"].includes(b.payment) && fee ? b.payment : "none";
  const doc = docFrom(b);
  const out = await tx(async (c) => {
    await assetOr(c, assetId);
    const { rows: cur } = await c.query(
      `SELECT id FROM mnt_certificates WHERE asset_id = $1 AND cert_type = $2 AND COALESCE(label,'') = COALESCE($3,'') AND status = 'current' FOR UPDATE`,
      [assetId, b.cert_type, label]);
    if (cur.length) await c.query(`UPDATE mnt_certificates SET status = 'superseded' WHERE id = $1`, [cur[0].id]);
    const { rows } = await c.query(
      `INSERT INTO mnt_certificates (asset_id, cert_type, label, number, valid_from, valid_to, authority, fee, renewed_from_id,
         document, document_name, document_mime, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [assetId, b.cert_type, label, b.number || null, b.valid_from || null, b.valid_to, b.authority || null, fee,
        cur[0]?.id || null, doc?.buf || null, doc?.name || null, doc?.mime || null, b.note || null, req.user.id]);
    const id = rows[0].id;
    if (payment !== "none") {
      const bill = await c.query(
        `INSERT INTO mnt_bills (source_type, source_id, payee, bill_no, bill_date, amount, due_date, note)
         VALUES ('certificate', $1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, CURRENT_DATE, $6) RETURNING id`,
        [id, b.authority || "Renewal fee", b.number || null, b.valid_from || null, fee, `${label || CERT_TYPES[b.cert_type]} fee`]);
      if (payment === "paid") {
        await c.query(`INSERT INTO mnt_payments (bill_id, amount, tds, paid_on, mode, reference, created_by) VALUES ($1,$2,0,CURRENT_DATE,$3,$4,$5)`,
          [bill.rows[0].id, fee, b.payment_mode || null, b.payment_ref || null, req.user.id]);
      }
    }
    return { id, renewed: !!cur.length };
  });
  res.status(201).json(out);
}));

router.patch("/certificates/:id", requirePermission("mnt.certificates", "edit"), handle(async (req, res) => {
  const b = req.body;
  if (b.valid_to && !DATE_RE.test(b.valid_to)) return bad(res, "Valid to must be yyyy-mm-dd.");
  if (b.valid_from && !DATE_RE.test(b.valid_from)) return bad(res, "Valid from must be yyyy-mm-dd.");
  const doc = docFrom(b);
  const r = await query(
    `UPDATE mnt_certificates SET number = COALESCE($1, number), valid_from = COALESCE($2::date, valid_from), valid_to = COALESCE($3::date, valid_to),
       authority = COALESCE($4, authority), note = COALESCE($5, note),
       document = COALESCE($6, document), document_name = COALESCE($7, document_name), document_mime = COALESCE($8, document_mime)
     WHERE id = $9 AND status = 'current'`,
    [b.number ?? null, b.valid_from || null, b.valid_to || null, b.authority ?? null, b.note ?? null, doc?.buf || null, doc?.name || null, doc?.mime || null, req.params.id]);
  if (!r.rowCount) return bad(res, "Only the current certificate can be corrected.", 409);
  res.json({ ok: true });
}));

// Remove a wrong entry (or one that no longer applies). If it was a renewal,
// the certificate it replaced becomes current again.
router.delete("/certificates/:id", requirePermission("mnt.certificates", "delete"), handle(async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM mnt_certificates WHERE id = $1 AND status = 'current' FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw fail("Only the current certificate can be removed.", 409);
    const paid = await c.query(`SELECT COALESCE(SUM(p.amount),0) AS s FROM mnt_payments p JOIN mnt_bills b ON b.id = p.bill_id WHERE b.source_type = 'certificate' AND b.source_id = $1`, [rows[0].id]);
    if (Number(paid.rows[0].s) > 0) throw fail("A fee has been paid on this certificate — correct it instead of removing it.", 409);
    await c.query(`DELETE FROM mnt_bills WHERE source_type = 'certificate' AND source_id = $1`, [rows[0].id]);
    await c.query(`UPDATE mnt_certificates SET status = 'retired' WHERE id = $1`, [rows[0].id]);
    if (rows[0].renewed_from_id) await c.query(`UPDATE mnt_certificates SET status = 'current' WHERE id = $1 AND status = 'superseded'`, [rows[0].renewed_from_id]);
  });
  res.json({ ok: true });
}));

router.get("/cert-rules", requireAnyPermission(["mnt.certificates", "mnt.cert-rules"]), async (req, res) => {
  const { rows } = await query(`SELECT asset_group, cert_type FROM mnt_cert_rules ORDER BY asset_group, cert_type`);
  const rules = {};
  for (const r of rows) (rules[r.asset_group] = rules[r.asset_group] || []).push(r.cert_type);
  res.json({ rules, types: Object.entries(CERT_TYPES).filter(([k]) => k !== "other").map(([key, label]) => ({ key, label })) });
});

router.put("/cert-rules", requirePermission("mnt.cert-rules", "edit"), handle(async (req, res) => {
  const group = String(req.body.asset_group || "").trim();
  if (!group) return bad(res, "Pick the machine type.");
  const types = (Array.isArray(req.body.cert_types) ? req.body.cert_types : []).filter((t) => CERT_TYPES[t] && t !== "other");
  await tx(async (c) => {
    await c.query(`DELETE FROM mnt_cert_rules WHERE asset_group = $1`, [group]);
    for (const t of types) await c.query(`INSERT INTO mnt_cert_rules (asset_group, cert_type) VALUES ($1,$2)`, [group, t]);
  });
  res.json({ ok: true });
}));

// ================================================ from the old screens ===

const FROM_MASTER = `
  LEFT JOIN trucks t ON t.id = x.truck_id
  LEFT JOIN equipment e ON e.id = x.equipment_id`;

async function legacyLists() {
  const [aps, scope, rps, ers, ais, bds] = await Promise.all([
    query(`SELECT id, name, interval_days, interval_hours, interval_qty_m3 FROM maintenance_action_points WHERE is_active AND moved_to_schedule IS NULL ORDER BY name`),
    query(`SELECT s.action_point_id, s.truck_id, s.equipment_id, t.truck_number, e.name AS equipment_name
           FROM maintenance_action_point_scope s LEFT JOIN trucks t ON t.id = s.truck_id LEFT JOIN equipment e ON e.id = s.equipment_id`),
    query(`SELECT x.id, x.truck_id, x.equipment_id, x.description, x.repair_type, x.status, x.scheduled_date::text AS scheduled_date,
             COALESCE(t.truck_number, e.name) AS unit FROM repair_action_points x ${FROM_MASTER}
           WHERE x.status IN ('pending','scheduled','in_progress') AND x.moved_to_card IS NULL ORDER BY x.created_at`),
    query(`SELECT x.id, x.truck_id, x.equipment_id, x.issue_description AS description, x.status, x.workshop_name, x.requested_at,
             COALESCE(t.truck_number, e.name) AS unit FROM external_repairs x ${FROM_MASTER}
           WHERE x.status IN ('requested','approved','sent_out') AND x.moved_to_card IS NULL ORDER BY x.requested_at`),
    query(`SELECT x.id, x.truck_id, NULL::int AS equipment_id, x.item_label || ' — ' || x.remark AS description, x.raised_at,
             t.truck_number AS unit FROM inspection_action_items x LEFT JOIN trucks t ON t.id = x.truck_id
           WHERE x.status = 'open' AND x.moved_to_card IS NULL ORDER BY x.raised_at`),
    query(`SELECT x.id, x.truck_id, x.pump_id, x.equipment_id, x.equipment_type::text AS equipment_type, x.issue_type,
             COALESCE(x.remarks, '') AS remarks, x.breakdown_time, COALESCE(t.truck_number, p.pump_code, e.name, x.equipment_label) AS unit
           FROM breakdown_reports x LEFT JOIN trucks t ON t.id = x.truck_id LEFT JOIN pumps p ON p.id = x.pump_id LEFT JOIN equipment e ON e.id = x.equipment_id
           WHERE x.repaired_at IS NULL AND x.moved_to_card IS NULL ORDER BY x.breakdown_time`),
  ]);
  const withAsset = async (rows) => {
    const out = [];
    for (const r of rows) {
      const a = await assetForMaster(query, { truck_id: r.truck_id || null, pump_id: r.pump_id || null, equipment_id: r.equipment_id || null });
      out.push({ ...r, asset_id: a?.id || null, asset_name: a?.name || null });
    }
    return out;
  };
  return {
    action_points: aps.rows.map((ap) => ({ ...ap, scope: scope.rows.filter((s) => s.action_point_id === ap.id).map((s) => s.truck_number || s.equipment_name) })),
    repair_points: await withAsset(rps.rows),
    external_repairs: await withAsset(ers.rows),
    action_items: await withAsset(ais.rows),
    breakdowns: await withAsset(bds.rows),
  };
}

router.get("/legacy", requirePermission("mnt.legacy-import", "edit"), async (req, res) => {
  res.json(await legacyLists());
});

// Old action point → PM schedule on the models of the vehicles it covered,
// with each vehicle's last service carried over as its "last done".
async function importActionPoint(c, apId, modelIdsIn, userId) {
  const { rows } = await c.query(`SELECT * FROM maintenance_action_points WHERE id = $1 AND is_active AND moved_to_schedule IS NULL FOR UPDATE`, [apId]);
  if (!rows.length) throw fail("That action point was already brought over.", 409);
  const ap = rows[0];
  const { rows: scope } = await c.query(`SELECT truck_id, equipment_id FROM maintenance_action_point_scope WHERE action_point_id = $1`, [apId]);
  // Vehicles it covered: its scope, or (no scope) every truck.
  const { rows: vehicles } = scope.length
    ? await c.query(`SELECT a.id, a.model_id, a.truck_id, a.equipment_id FROM mnt_assets a WHERE a.is_active AND a.model_id IS NOT NULL
        AND (a.truck_id = ANY($1::int[]) OR a.equipment_id = ANY($2::int[]))`,
      [scope.map((s) => s.truck_id).filter(Boolean), scope.map((s) => s.equipment_id).filter(Boolean)])
    : await c.query(`SELECT a.id, a.model_id, a.truck_id, a.equipment_id FROM mnt_assets a WHERE a.is_active AND a.model_id IS NOT NULL AND a.truck_id IS NOT NULL`);
  const modelIds = (Array.isArray(modelIdsIn) && modelIdsIn.length ? modelIdsIn.map(Number) : [...new Set(vehicles.map((v) => v.model_id))]).filter(Boolean);
  if (!modelIds.length) throw fail(`"${ap.name}": none of its vehicles is in the register with a model yet — add them on the Equipment tab first.`, 409);
  let trigger = "day", every = ap.interval_days, orDays = null, orHours = null;
  if (ap.interval_qty_m3) { trigger = "m3"; every = Number(ap.interval_qty_m3); orDays = ap.interval_days || null; orHours = ap.interval_hours || null; }
  else if (ap.interval_hours) { trigger = "hours"; every = ap.interval_hours; orDays = ap.interval_days || null; }
  if (!every) throw fail(`"${ap.name}" has no interval.`);
  const s = await c.query(
    `INSERT INTO mnt_pm_schedules (name, trigger_type, every, or_days, or_hours, basis, note, sources, checklist, tasks, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,'PRACTICE','Brought over from the old Maintenance Action Points','[]'::jsonb,'[]'::jsonb,$6::jsonb,$7,$7) RETURNING id`,
    [ap.name, trigger, every, orDays, orHours, JSON.stringify([{ task: ap.name, parts: "" }]), userId]);
  const sid = s.rows[0].id;
  for (const m of modelIds) await c.query(`INSERT INTO mnt_pm_schedule_models (schedule_id, model_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [sid, m]);
  let baselines = 0;
  const { rows: all } = await c.query(`SELECT id, truck_id, equipment_id FROM mnt_assets WHERE is_active AND model_id = ANY($1::int[])`, [modelIds]);
  for (const v of all) {
    const { rows: log } = await c.query(
      `SELECT done_at::text AS done_at, hours_at_service FROM maintenance_logs WHERE action_point_id = $1
         AND (($2::int IS NOT NULL AND truck_id = $2) OR ($3::int IS NOT NULL AND equipment_id = $3)) ORDER BY done_at DESC, id DESC LIMIT 1`,
      [apId, v.truck_id, v.equipment_id]);
    if (!log.length) continue;
    await c.query(
      `INSERT INTO mnt_pm_schedule_assets (schedule_id, asset_id, last_done_date, last_done_hours) VALUES ($1,$2,$3,$4)
       ON CONFLICT (schedule_id, asset_id) DO UPDATE SET last_done_date = EXCLUDED.last_done_date, last_done_hours = EXCLUDED.last_done_hours`,
      [sid, v.id, log[0].done_at, log[0].hours_at_service]);
    baselines += 1;
  }
  await c.query(`UPDATE maintenance_action_points SET is_active = false, moved_to_schedule = $1 WHERE id = $2`, [sid, apId]);
  return { schedule_id: sid, models: modelIds.length, baselines };
}

// Old open record → a job on the vehicle's job card.
async function importToCard(c, kind, id, user, extra = {}) {
  const SPEC = {
    repair_point: {
      sql: `SELECT id, truck_id, NULL::int AS pump_id, equipment_id, description, repair_type AS rt FROM repair_action_points WHERE id = $1 AND moved_to_card IS NULL FOR UPDATE`,
      job: (r) => ({ description: r.description, origin: "manual", kind: r.rt === "external" ? "outside" : "inside", source_type: "repair_point", source_id: r.id }),
      done: `UPDATE repair_action_points SET moved_to_card = $1, status = 'in_progress', notes = COALESCE(notes || ' · ', '') || $2 WHERE id = $3`,
    },
    external_repair: {
      sql: `SELECT id, truck_id, NULL::int AS pump_id, equipment_id, issue_description AS description, status, workshop_name, requested_by, requested_at FROM external_repairs WHERE id = $1 AND moved_to_card IS NULL FOR UPDATE`,
      job: (r) => ({ description: r.description, origin: "complaint", kind: "outside", source_type: "external_repair", source_id: r.id }),
      done: `UPDATE external_repairs SET moved_to_card = $1, notes = COALESCE(notes || ' · ', '') || $2 WHERE id = $3`,
    },
    action_item: {
      sql: `SELECT id, truck_id, NULL::int AS pump_id, NULL::int AS equipment_id, item_label || ' — ' || remark AS description FROM inspection_action_items WHERE id = $1 AND status = 'open' AND moved_to_card IS NULL FOR UPDATE`,
      job: (r) => ({ description: r.description, origin: "not_ok", kind: "inside", source_type: "inspection_item", source_id: r.id }),
      done: `UPDATE inspection_action_items SET moved_to_card = $1, resolution_notes = $2 WHERE id = $3`,
    },
    breakdown: {
      sql: `SELECT id, truck_id, pump_id, equipment_id, 'Breakdown — ' || COALESCE(NULLIF(issue_type, ''), 'reported') || COALESCE(': ' || NULLIF(remarks, ''), '') AS description FROM breakdown_reports WHERE id = $1 AND repaired_at IS NULL AND moved_to_card IS NULL FOR UPDATE`,
      job: (r) => ({ description: r.description, origin: "complaint", kind: "inside", urgency: "breakdown", machine_stopped: true, source_type: "breakdown", source_id: r.id }),
      done: `UPDATE breakdown_reports SET moved_to_card = $1 WHERE id = $3 AND $2::text IS NOT NULL`,
    },
  }[kind];
  if (!SPEC) throw fail("Unknown record.");
  const { rows } = await c.query(SPEC.sql, [id]);
  if (!rows.length) throw fail("That record was already brought over or closed.", 409);
  const r = rows[0];
  const a = await assetForMaster((t, p) => c.query(t, p), { truck_id: r.truck_id, pump_id: r.pump_id, equipment_id: r.equipment_id });
  if (!a) throw fail("That vehicle isn't in the maintenance register yet — add it on the Equipment tab first.", 409);
  const card = await openCardFor(c, a.id, user.id, "legacy", null, null);
  const [jobId] = await addJobs(c, card.id, [SPEC.job(r)], user);
  // An outside repair already approved / at the workshop keeps going in the
  // new flow; one only requested waits for its estimate on the job card.
  if (kind === "external_repair" && ["approved", "sent_out"].includes(r.status)) {
    const est = num(extra.estimate_amount) || 0;
    const o = await c.query(
      `INSERT INTO mnt_outside_repairs (job_card_id, asset_id, workshop, estimate_amount, approved_amount, status, notes, requested_by, requested_at, approved_at, sent_out_at)
       VALUES ($1,$2,$3,$4,$4,$5::varchar,'Brought over from the old Maintenance screen',$6,$7,now(),CASE WHEN $5::varchar = 'sent_out' THEN now() END) RETURNING id`,
      [card.id, a.id, r.workshop_name || "Workshop", est, r.status, r.requested_by, r.requested_at]);
    await c.query(`UPDATE mnt_jobs SET outside_repair_id = $1 WHERE id = $2`, [o.rows[0].id, jobId]);
    await c.query(`INSERT INTO mnt_bills (source_type, source_id, payee, amount, is_estimate, note) VALUES ('outside_repair',$1,$2,$3,true,'Approved estimate — final bill on return') ON CONFLICT DO NOTHING`,
      [o.rows[0].id, r.workshop_name || "Workshop", est]);
  }
  await c.query(SPEC.done, [card.id, `Moved to ${jobCode(card.id)}`, r.id]);
  return { job_card_id: card.id, code: jobCode(card.id), asset_name: a.name };
}

const IMPORT_KINDS = { "repair-points": "repair_point", "external-repairs": "external_repair", "action-items": "action_item", breakdowns: "breakdown" };

router.post("/legacy/action-points/:id", requirePermission("mnt.legacy-import", "edit"), handle(async (req, res) => {
  res.json(await tx((c) => importActionPoint(c, Number(req.params.id), req.body.model_ids, req.user.id)));
}));

router.post("/legacy/:kind/:id", requirePermission("mnt.legacy-import", "edit"), handle(async (req, res) => {
  const kind = IMPORT_KINDS[req.params.kind];
  if (!kind) return bad(res, "Unknown record.", 404);
  res.json(await tx((c) => importToCard(c, kind, Number(req.params.id), req.user, req.body)));
}));

// Everything that can go across in one go; the rest is listed with why.
router.post("/legacy-all", requirePermission("mnt.legacy-import", "edit"), handle(async (req, res) => {
  const lists = await legacyLists();
  const done = { schedules: 0, jobs: 0 };
  const skipped = [];
  for (const ap of lists.action_points) {
    try { await tx((c) => importActionPoint(c, ap.id, null, req.user.id)); done.schedules += 1; } catch (err) { if (!err.status) throw err; skipped.push(err.message); }
  }
  const pairs = [["repair_points", "repair_point"], ["action_items", "action_item"], ["breakdowns", "breakdown"], ["external_repairs", "external_repair"]];
  for (const [list, kind] of pairs) {
    for (const r of lists[list]) {
      if (!r.asset_id) { skipped.push(`${r.unit || "A vehicle"} isn't in the register — ${r.description || r.remarks || ""}`.trim()); continue; }
      try { await tx((c) => importToCard(c, kind, r.id, req.user)); done.jobs += 1; } catch (err) { if (!err.status) throw err; skipped.push(err.message); }
    }
  }
  res.json({ ...done, skipped });
}));

export default router;
