// ===========================================================================
// Round 215 — the Maintenance module (/api/maintenance-module).
//
// Built to the owner's mockup v5 (18 Oct 2026). The flow, in the owner's
// words, condensed:
//   * PM Inspection: when a checklist is submitted, every Not OK item and any
//     other job written on it goes onto ONE job card for that vehicle,
//     automatically (an open card for the vehicle is reused, never a second).
//   * Each job on a card is Inside or Outside. An Outside job goes to the
//     Administrator as a repair request with an estimate; a bill above the
//     approved amount goes back to the Administrator before it can be paid.
//   * Inside jobs ask Store for parts. In stock -> Store issues, cost to the
//     job card. Not in stock -> Store makes a PO, Manager / Administrator
//     approves, a GRV is made against the PO and that cost goes to the job
//     card (and so the vehicle).
//   * Complaints (Plant In Charge, drivers, Store, Manager) become jobs too.
//   * Store spares carry "used for" (one machine, a machine type, general) and
//     their last purchase price. A part meant for one vehicle CAN be issued to
//     another — "used for" only sorts the list.
//
// Guards: permission only, like the Fuel module (Round 199) — every route
// names the function it belongs to, so the Access Control page decides.
// Money and stock writes run in one transaction each; balances are moved with
// row locks and logged to the append-only mnt_store_txns ledger.
// ===========================================================================
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, requireAnyPermission, can } from "../lib/permissions.js";
import { pushToRole } from "../lib/push.js";
import { dueList, assetReadings, triggerText } from "../lib/maintenanceDue.js";
import { syncGeneralCharges } from "../lib/maintenanceGeneral.js";
import { refreshAssetNames } from "../lib/maintenanceModels.js";

const router = Router();
router.use(requireAuth);

const ANY_MNT = [
  "mnt.dashboard", "mnt.equipment", "mnt.schedules", "mnt.inspections", "mnt.job-cards",
  "mnt.outside-repairs", "mnt.store", "mnt.purchase-orders", "mnt.payments", "mnt.complaints",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRIGGERS = ["day", "week", "month", "km", "hours", "m3", "once_km"];
const GROUPS = ["Transit mixer", "Boom pump", "Light truck", "Light vehicle", "Loader", "Plant", "Two-wheeler", "Generator", "Other"];

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
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
function notify(role, title, body, url) {
  pushToRole(role, { title, body, url }).catch((e) => console.error("push", e.message));
}
export function code(prefix, id) {
  return `${prefix}-${String(id).padStart(4, "0")}`;
}

// ---------------------------------------------------------------- assets ---

const ASSET_COLS = `a.id, a.name, a.asset_group, a.make_model, a.year, a.detail, a.truck_id, a.pump_id, a.equipment_id, a.is_active,
  a.model_id, a.asset_no, a.reg_no, mm.name AS model_name,
  t.truck_number, p.pump_code, e.name AS equipment_name`;
const ASSET_FROM = `FROM mnt_assets a
  LEFT JOIN mnt_models mm ON mm.id = a.model_id
  LEFT JOIN trucks t ON t.id = a.truck_id
  LEFT JOIN pumps p ON p.id = a.pump_id
  LEFT JOIN equipment e ON e.id = a.equipment_id`;

function linkedLabel(a) {
  if (a.truck_number) return `Truck ${a.truck_number}`;
  if (a.pump_code) return `Pump ${a.pump_code}`;
  if (a.equipment_name) return a.equipment_name;
  return null;
}

// The asset list for dropdowns — readable from any maintenance function,
// including complaints (drivers and Store raise those without the module).
router.get("/asset-options", requireAnyPermission(ANY_MNT), async (req, res) => {
  const { rows } = await query(`SELECT ${ASSET_COLS} ${ASSET_FROM} WHERE a.is_active ORDER BY a.asset_group, a.name`);
  res.json(rows.map((a) => ({ id: a.id, name: a.name, asset_group: a.asset_group, model_id: a.model_id, model_name: a.model_name, linked: linkedLabel(a) })));
});

router.get("/assets", requirePermission("mnt.equipment", "view"), async (req, res) => {
  const { rows } = await query(`SELECT ${ASSET_COLS},
      (SELECT COUNT(*)::int FROM mnt_job_cards j WHERE j.asset_id = a.id AND j.status IN ('open','work_done') AND j.general_month IS NULL) AS open_job_cards,
      (SELECT COUNT(*)::int FROM mnt_outside_repairs o WHERE o.asset_id = a.id AND o.status = 'sent_out') AS at_workshop
    ${ASSET_FROM} WHERE a.is_active ORDER BY a.asset_group, a.name`);
  const [readings, due] = await Promise.all([assetReadings(rows.map((r) => r.id)), dueList()]);
  const worstBy = {};
  const rank = { overdue: 0, due_soon: 1, never: 2 };
  for (const d of due) {
    if (!(d.status in rank)) continue;
    const cur = worstBy[d.asset_id];
    if (!cur || rank[d.status] < rank[cur]) worstBy[d.asset_id] = d.status;
  }
  res.json(rows.map((a) => ({
    ...a, linked: linkedLabel(a), km: readings[a.id]?.km ?? null, hours: readings[a.id]?.hours ?? null,
    pm_status: worstBy[a.id] || "ok",
  })));
});

// Master rows (trucks / pumps / equipment) and which asset each is linked to,
// for the "Linked master record" picker.
router.get("/masters", requirePermission("mnt.equipment", "view"), async (req, res) => {
  const [t, p, e, a, models] = await Promise.all([
    query(`SELECT id, truck_number AS label FROM trucks WHERE is_active ORDER BY truck_number`),
    query(`SELECT id, pump_code AS label FROM pumps WHERE is_active ORDER BY pump_code`),
    query(`SELECT id, name AS label, equipment_type::text AS type FROM equipment WHERE is_active ORDER BY name`),
    query(`SELECT id, name, truck_id, pump_id, equipment_id FROM mnt_assets WHERE is_active`),
    query(`SELECT id, name, asset_group FROM mnt_models WHERE is_active ORDER BY asset_group, name`),
  ]);
  const owner = (col, id) => a.rows.find((x) => x[col] === id) || null;
  res.json({
    trucks: t.rows.map((r) => ({ ...r, asset: owner("truck_id", r.id) })),
    pumps: p.rows.map((r) => ({ ...r, asset: owner("pump_id", r.id) })),
    equipment: e.rows.map((r) => ({ ...r, asset: owner("equipment_id", r.id) })),
    groups: GROUPS,
    models: models.rows,
  });
});

// Round 215c — each vehicle is its own asset: a model, an asset number and / or
// a registration number. Its name is built from those (see refreshAssetNames).
function assetBody(b) {
  const out = {
    name: String(b.name || "").trim(),
    model_id: num(b.model_id),
    asset_no: b.asset_no ? String(b.asset_no).trim().toUpperCase().slice(0, 30) : null,
    reg_no: b.reg_no ? String(b.reg_no).replace(/\s+/g, "").toUpperCase().slice(0, 30) : null,
    asset_group: GROUPS.includes(b.asset_group) ? b.asset_group : "Other",
    make_model: b.make_model ? String(b.make_model).trim() : null,
    year: num(b.year),
    detail: b.detail ? String(b.detail).trim() : null,
    truck_id: num(b.truck_id), pump_id: num(b.pump_id), equipment_id: num(b.equipment_id),
  };
  return out;
}
function assetError(a) {
  if (Number.isNaN(a.model_id)) return "Pick the model.";
  if (a.model_id && !a.asset_no && !a.reg_no) return "Enter the asset number or the registration number.";
  if (!a.model_id && !a.name) return "Pick the model.";
  if (Number.isNaN(a.year) || (a.year != null && (a.year < 1950 || a.year > 2100))) return "Year doesn't look right.";
  if ([a.truck_id, a.pump_id, a.equipment_id].some((v) => Number.isNaN(v))) return "Pick a valid master record.";
  if ([a.truck_id, a.pump_id, a.equipment_id].filter((v) => v != null).length > 1) return "Link to one master record only — a truck, a pump or an equipment row.";
  return null;
}
function uniqueLinkError(err, res) {
  if (err.code === "23505" && /asset_no/.test(err.constraint || "")) return bad(res, "Another vehicle already has that asset number.", 409);
  if (err.code === "23505" && /reg_no/.test(err.constraint || "")) return bad(res, "Another vehicle already has that registration number.", 409);
  if (err.code === "23505") return bad(res, "That master record is already linked to another piece of equipment.", 409);
  throw err;
}

// The model must exist; a vehicle linked to a truck / pump and given no
// registration takes the truck number / pump code.
async function prepAsset(a) {
  if (a.model_id) {
    const m = await query(`SELECT name, asset_group FROM mnt_models WHERE id = $1 AND is_active`, [a.model_id]);
    if (!m.rows.length) return "That model isn't on the list.";
    a.asset_group = m.rows[0].asset_group;
    a.make_model = m.rows[0].name;
    if (!a.name) a.name = m.rows[0].name;
  }
  if (!a.reg_no && (a.truck_id || a.pump_id)) {
    const r = a.truck_id
      ? await query(`SELECT truck_number AS n FROM trucks WHERE id = $1`, [a.truck_id])
      : await query(`SELECT pump_code AS n FROM pumps WHERE id = $1`, [a.pump_id]);
    if (r.rows[0]?.n) a.reg_no = String(r.rows[0].n).replace(/\s+/g, "").toUpperCase();
  }
  return null;
}

async function insertAsset(a, userId, q = query) {
  const { rows } = await q(
    `INSERT INTO mnt_assets (name, asset_group, make_model, year, detail, truck_id, pump_id, equipment_id, model_id, asset_no, reg_no, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [a.name, a.asset_group, a.make_model, a.year, a.detail, a.truck_id, a.pump_id, a.equipment_id, a.model_id, a.asset_no, a.reg_no, userId]
  );
  if (a.model_id) await refreshAssetNames(q, { assetId: rows[0].id });
  return rows[0];
}

router.post("/assets", requirePermission("mnt.equipment", "create"), async (req, res) => {
  const a = assetBody(req.body);
  const e = (await prepAsset(a)) || assetError(a);
  if (e) return bad(res, e);
  try {
    const rows = [await insertAsset(a, req.user.id)];
    // A newly linked vehicle picks up its lubricant issues since the start.
    await syncGeneralCharges().catch((err) => console.error("general-works sync:", err.message));
    res.status(201).json(rows[0]);
  } catch (err) { uniqueLinkError(err, res); }
});

router.patch("/assets/:id", requirePermission("mnt.equipment", "edit"), async (req, res) => {
  const a = assetBody(req.body);
  const e = (await prepAsset(a)) || assetError(a);
  if (e) return bad(res, e);
  try {
    const r = await query(
      `UPDATE mnt_assets SET name=$1, asset_group=$2, make_model=$3, year=$4, detail=$5, truck_id=$6, pump_id=$7, equipment_id=$8,
         model_id=$9, asset_no=$10, reg_no=$11
       WHERE id=$12 AND is_active`,
      [a.name, a.asset_group, a.make_model, a.year, a.detail, a.truck_id, a.pump_id, a.equipment_id, a.model_id, a.asset_no, a.reg_no, req.params.id]
    );
    if (!r.rowCount) return bad(res, "Equipment not found.", 404);
    if (a.model_id) await refreshAssetNames(query, { assetId: Number(req.params.id) });
    await syncGeneralCharges().catch((err) => console.error("general-works sync:", err.message));
    res.json({ ok: true });
  } catch (err) { uniqueLinkError(err, res); }
});

// Several vehicles at once from the fleet records (trucks / pumps /
// equipment): each row picks its model and may carry an asset number. All or
// nothing, so a clash on one row leaves nothing half-added.
router.post("/assets/bulk", requirePermission("mnt.equipment", "create"), async (req, res) => {
  const rowsIn = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rowsIn.length) return bad(res, "Pick at least one vehicle.");
  const prepared = [];
  for (const [i, raw] of rowsIn.entries()) {
    const a = assetBody(raw);
    if (!a.model_id) return bad(res, `Row ${i + 1}: pick the model.`);
    const e = (await prepAsset(a)) || assetError(a);
    if (e) return bad(res, `Row ${i + 1}: ${e}`);
    prepared.push(a);
  }
  try {
    const ids = await tx(async (c) => {
      const out = [];
      for (const a of prepared) out.push((await insertAsset(a, req.user.id, (t, p) => c.query(t, p))).id);
      return out;
    });
    await syncGeneralCharges().catch((err) => console.error("general-works sync:", err.message));
    res.status(201).json({ added: ids.length, ids });
  } catch (err) { uniqueLinkError(err, res); }
});

// ---- models (Round 215c): the make / model a vehicle belongs to. PM
// schedules are planned against models.
router.get("/models", requireAnyPermission(["mnt.equipment", "mnt.schedules", "mnt.store"]), async (req, res) => {
  const { rows } = await query(`
    SELECT m.id, m.name, m.asset_group, m.detail,
      (SELECT COUNT(*)::int FROM mnt_assets a WHERE a.model_id = m.id AND a.is_active) AS vehicles,
      (SELECT COUNT(*)::int FROM mnt_pm_schedule_models sm JOIN mnt_pm_schedules s ON s.id = sm.schedule_id AND s.is_active WHERE sm.model_id = m.id) AS schedules
    FROM mnt_models m WHERE m.is_active ORDER BY m.asset_group, m.name`);
  res.json({ models: rows, groups: GROUPS });
});

function modelBody(b) {
  return {
    name: String(b.name || "").trim().slice(0, 150),
    asset_group: GROUPS.includes(b.asset_group) ? b.asset_group : "Other",
    detail: b.detail ? String(b.detail).trim() : null,
  };
}
function modelUnique(err, res) {
  if (err.code === "23505") return bad(res, "There is already a model with that name.", 409);
  throw err;
}

router.post("/models", requirePermission("mnt.equipment", "create"), async (req, res) => {
  const m = modelBody(req.body);
  if (!m.name) return bad(res, "Name the model (e.g. Tata Signa 2825.K).");
  try {
    const { rows } = await query(`INSERT INTO mnt_models (name, asset_group, detail, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [m.name, m.asset_group, m.detail, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (err) { modelUnique(err, res); }
});

router.patch("/models/:id", requirePermission("mnt.equipment", "edit"), async (req, res) => {
  const m = modelBody(req.body);
  if (!m.name) return bad(res, "Name the model.");
  try {
    const r = await query(`UPDATE mnt_models SET name = $1, asset_group = $2, detail = $3 WHERE id = $4 AND is_active`,
      [m.name, m.asset_group, m.detail, req.params.id]);
    if (!r.rowCount) return bad(res, "Model not found.", 404);
    await refreshAssetNames(query, { modelId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) { modelUnique(err, res); }
});

router.delete("/models/:id", requirePermission("mnt.equipment", "delete"), async (req, res) => {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM mnt_assets WHERE model_id = $1 AND is_active`, [req.params.id]);
  if (rows[0].n) return bad(res, `${rows[0].n} vehicle(s) are of this model — move or remove them first.`, 409);
  await query(`UPDATE mnt_models SET is_active = false WHERE id = $1`, [req.params.id]);
  await query(`DELETE FROM mnt_pm_schedule_models WHERE model_id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// Retire, never delete: job cards, inspections and costs point at it.
router.delete("/assets/:id", requirePermission("mnt.equipment", "delete"), async (req, res) => {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM mnt_job_cards WHERE asset_id = $1 AND status IN ('open','work_done') AND general_month IS NULL`, [req.params.id]);
  if (rows[0].n) return bad(res, "Close its open job cards first.", 409);
  await query(`UPDATE mnt_assets SET is_active = false WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.post("/assets/:id/readings", requirePermission("mnt.equipment", "create"), async (req, res) => {
  const km = num(req.body.km);
  const hours = num(req.body.hours);
  if (Number.isNaN(km) || Number.isNaN(hours) || (km == null && hours == null)) return bad(res, "Enter a km or hour-meter reading.");
  if ((km != null && km < 0) || (hours != null && hours < 0)) return bad(res, "Readings can't be negative.");
  const cur = (await assetReadings([Number(req.params.id)]))[req.params.id];
  if (!cur) return bad(res, "Equipment not found.", 404);
  // A lower reading than one already on record means a typing mistake or a
  // replaced meter; say which, rather than silently keeping the higher one.
  if (km != null && cur.km != null && km < cur.km && !req.body.meter_replaced) {
    return bad(res, `That is lower than the last km on record (${cur.km}). If the odometer was replaced, tick "meter replaced".`, 409);
  }
  if (hours != null && cur.hours != null && hours < cur.hours && !req.body.meter_replaced) {
    return bad(res, `That is lower than the last hour-meter reading on record (${cur.hours}). If the meter was replaced, tick "meter replaced".`, 409);
  }
  await query(
    `INSERT INTO mnt_meter_readings (asset_id, km, hours, source, note, entered_by) VALUES ($1,$2,$3,'manual',$4,$5)`,
    [req.params.id, km, hours, req.body.meter_replaced ? "Meter replaced" : (req.body.note || null), req.user.id]
  );
  res.status(201).json({ ok: true });
});

router.get("/assets/:id", requirePermission("mnt.equipment", "view"), async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`SELECT ${ASSET_COLS} ${ASSET_FROM} WHERE a.id = $1`, [id]);
  if (!rows.length) return bad(res, "Equipment not found.", 404);
  const a = rows[0];
  const [readings, due, cards, insp, cost] = await Promise.all([
    assetReadings([id]),
    dueList({ assetId: id }),
    query(`SELECT j.id, j.status, j.source, j.opened_at, j.verified_at, to_char(j.general_month, 'Mon YYYY') AS general_label,
             (SELECT string_agg(description, '; ' ORDER BY id) FROM mnt_jobs WHERE job_card_id = j.id AND status <> 'cancelled') AS jobs
           FROM mnt_job_cards j WHERE j.asset_id = $1 ORDER BY j.opened_at DESC LIMIT 20`, [id]),
    query(`SELECT i.id, i.done_at, i.km, i.hours, s.name AS schedule_name, i.job_card_id,
             (SELECT COUNT(*)::int FROM jsonb_array_elements(i.answers) x WHERE x->>'ok' = 'false') AS not_ok
           FROM mnt_pm_inspections i JOIN mnt_pm_schedules s ON s.id = i.schedule_id
           WHERE i.asset_id = $1 ORDER BY i.done_at DESC LIMIT 20`, [id]),
    query(`SELECT
             COALESCE((SELECT SUM(value) FROM mnt_store_txns WHERE asset_id = $1 AND txn_type = 'issue' AND created_at >= date_trunc('year', now() - interval '3 months') + interval '3 months'), 0) AS parts_fy,
             COALESCE((SELECT SUM(final_amount) FROM mnt_outside_repairs WHERE asset_id = $1 AND final_amount IS NOT NULL AND returned_at >= date_trunc('year', now() - interval '3 months') + interval '3 months'), 0) AS outside_fy,
             COALESCE((SELECT SUM(amount) FROM mnt_card_charges WHERE asset_id = $1 AND charged_at >= date_trunc('year', now() - interval '3 months') + interval '3 months'), 0) AS general_fy`, [id]),
  ]);
  const history = [
    ...cards.rows.map((c) => ({ kind: "job_card", date: c.opened_at, title: `${code("JC", c.id)} · ${c.general_label ? `General works · ${c.general_label}` : c.jobs || "No jobs"}`, status: c.status, id: c.id })),
    ...insp.rows.map((i) => ({ kind: "inspection", date: i.done_at, title: `PM inspection · ${i.schedule_name}`, meta: i.not_ok ? `${i.not_ok} Not OK → ${code("JC", i.job_card_id)}` : "All OK", id: i.id })),
  ].sort((x, y) => new Date(y.date) - new Date(x.date)).slice(0, 25);
  res.json({
    ...a, linked: linkedLabel(a), km: readings[id]?.km ?? null, hours: readings[id]?.hours ?? null,
    due, history, cost_fy: money(Number(cost.rows[0].parts_fy) + Number(cost.rows[0].outside_fy) + Number(cost.rows[0].general_fy)),
  });
});

// -------------------------------------------------------------- schedules ---

function schedBody(b) {
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean);
  const tasks = (Array.isArray(b.tasks) ? b.tasks : []).map((t) => (typeof t === "string" ? { task: t, parts: "" } : { task: String(t.task || "").trim(), parts: String(t.parts || "").trim() })).filter((t) => t.task);
  return {
    name: String(b.name || "").trim(),
    trigger_type: b.trigger_type,
    every: num(b.every),
    or_months: num(b.or_months), or_days: num(b.or_days), or_hours: num(b.or_hours),
    basis: ["OEM", "ENGINE", "PRACTICE"].includes(b.basis) ? b.basis : "PRACTICE",
    note: b.note ? String(b.note).trim() : null,
    checklist: list(b.checklist), tasks,
    model_ids: (Array.isArray(b.model_ids) ? b.model_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
  };
}
function schedError(s) {
  if (!s.name) return "Give the schedule a name.";
  if (!TRIGGERS.includes(s.trigger_type)) return "Pick when it is due.";
  if (!s.every || Number.isNaN(s.every) || s.every <= 0) return "Enter the interval.";
  for (const k of ["or_months", "or_days", "or_hours"]) if (Number.isNaN(s[k]) || (s[k] != null && s[k] <= 0)) return "The 'or after' limit must be a positive number.";
  if (!s.model_ids.length) return "Pick at least one model it applies to.";
  if (!s.checklist.length && !s.tasks.length) return "Add at least one check or task.";
  return null;
}

// Each schedule with the models it is planned for, and every vehicle of
// those models with its own "last done".
router.get("/schedules", requireAnyPermission(["mnt.schedules", "mnt.inspections"]), async (req, res) => {
  const { rows } = await query(`
    SELECT s.*,
      COALESCE((SELECT json_agg(json_build_object('model_id', m.id, 'name', m.name) ORDER BY m.name)
                FROM mnt_pm_schedule_models sm JOIN mnt_models m ON m.id = sm.model_id AND m.is_active
                WHERE sm.schedule_id = s.id), '[]') AS models,
      COALESCE((SELECT json_agg(json_build_object('asset_id', a.id, 'name', a.name, 'model_id', a.model_id,
                  'last_done_date', sa.last_done_date::text, 'last_done_km', sa.last_done_km, 'last_done_hours', sa.last_done_hours) ORDER BY a.name)
                FROM mnt_pm_schedule_models sm JOIN mnt_assets a ON a.model_id = sm.model_id AND a.is_active
                LEFT JOIN mnt_pm_schedule_assets sa ON sa.schedule_id = s.id AND sa.asset_id = a.id
                WHERE sm.schedule_id = s.id), '[]') AS assets
    FROM mnt_pm_schedules s
    WHERE s.is_active
    ORDER BY s.name`);
  res.json(rows.map((s) => ({ ...s, trigger: triggerText(s) })));
});

async function setScheduleModels(client, id, modelIds) {
  await client.query(`DELETE FROM mnt_pm_schedule_models WHERE schedule_id = $1 AND NOT (model_id = ANY($2::int[]))`, [id, modelIds]);
  for (const m of modelIds) {
    await client.query(`INSERT INTO mnt_pm_schedule_models (schedule_id, model_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, m]);
  }
}

// Does this schedule apply to this vehicle (through its model)?
async function scheduleApplies(q, scheduleId, assetId) {
  const { rows } = await q(
    `SELECT 1 FROM mnt_pm_schedule_models sm JOIN mnt_assets a ON a.model_id = sm.model_id AND a.is_active
     JOIN mnt_pm_schedules s ON s.id = sm.schedule_id AND s.is_active
     WHERE sm.schedule_id = $1 AND a.id = $2`, [scheduleId, assetId]);
  return rows.length > 0;
}

router.post("/schedules", requirePermission("mnt.schedules", "create"), async (req, res) => {
  const s = schedBody(req.body);
  const e = schedError(s);
  if (e) return bad(res, e);
  const id = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO mnt_pm_schedules (name, trigger_type, every, or_months, or_days, or_hours, basis, note, checklist, tasks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$11) RETURNING id`,
      [s.name, s.trigger_type, s.every, s.or_months, s.or_days, s.or_hours, s.basis, s.note, JSON.stringify(s.checklist), JSON.stringify(s.tasks), req.user.id]
    );
    await setScheduleModels(c, rows[0].id, s.model_ids);
    return rows[0].id;
  });
  res.status(201).json({ id });
});

router.patch("/schedules/:id", requirePermission("mnt.schedules", "edit"), async (req, res) => {
  const s = schedBody(req.body);
  const e = schedError(s);
  if (e) return bad(res, e);
  const ok = await tx(async (c) => {
    const r = await c.query(
      `UPDATE mnt_pm_schedules SET name=$1, trigger_type=$2, every=$3, or_months=$4, or_days=$5, or_hours=$6, basis=$7, note=$8,
         checklist=$9::jsonb, tasks=$10::jsonb, updated_by=$11, updated_at=now()
       WHERE id=$12 AND is_active`,
      [s.name, s.trigger_type, s.every, s.or_months, s.or_days, s.or_hours, s.basis, s.note, JSON.stringify(s.checklist), JSON.stringify(s.tasks), req.user.id, req.params.id]
    );
    if (!r.rowCount) return false;
    await setScheduleModels(c, Number(req.params.id), s.model_ids);
    return true;
  });
  if (!ok) return bad(res, "Schedule not found.", 404);
  res.json({ ok: true });
});

// Retired rather than removed: past inspections point at it.
router.delete("/schedules/:id", requirePermission("mnt.schedules", "delete"), async (req, res) => {
  const r = await query(`UPDATE mnt_pm_schedules SET is_active = false, updated_by = $1, updated_at = now() WHERE id = $2 AND is_active`, [req.user.id, req.params.id]);
  if (!r.rowCount) return bad(res, "Schedule not found.", 404);
  res.json({ ok: true });
});

// Undo a delete (the screen offers it straight after).
router.post("/schedules/:id/restore", requirePermission("mnt.schedules", "delete"), async (req, res) => {
  await query(`UPDATE mnt_pm_schedules SET is_active = true, updated_by = $1, updated_at = now() WHERE id = $2`, [req.user.id, req.params.id]);
  res.json({ ok: true });
});

// The starting point for one asset: when it was last done, at what reading.
router.patch("/schedules/:id/assets/:assetId", requirePermission("mnt.schedules", "edit"), async (req, res) => {
  const d = req.body.last_done_date || null;
  if (d && !DATE_RE.test(d)) return bad(res, "Date must be yyyy-mm-dd.");
  const km = num(req.body.last_done_km);
  const hours = num(req.body.last_done_hours);
  if (Number.isNaN(km) || Number.isNaN(hours)) return bad(res, "Readings must be numbers.");
  if (!(await scheduleApplies(query, req.params.id, req.params.assetId))) return bad(res, "That schedule doesn't apply to this vehicle's model.", 404);
  await query(
    `INSERT INTO mnt_pm_schedule_assets (schedule_id, asset_id, last_done_date, last_done_km, last_done_hours) VALUES ($4,$5,$1,$2,$3)
     ON CONFLICT (schedule_id, asset_id) DO UPDATE SET last_done_date=$1, last_done_km=$2, last_done_hours=$3`,
    [d, km, hours, req.params.id, req.params.assetId]
  );
  res.json({ ok: true });
});

router.get("/due", requireAnyPermission(["mnt.dashboard", "mnt.inspections", "mnt.schedules"]), async (req, res) => {
  const assetId = req.query.asset_id ? Number(req.query.asset_id) : null;
  res.json(await dueList({ assetId }));
});

// ------------------------------------------------------------ job cards ---

// The open card for an asset, or a new one. Locked so two submissions at the
// same moment can't each open a card for the same vehicle.
async function openCardFor(c, assetId, userId, source, sourceId, km) {
  await c.query(`SELECT pg_advisory_xact_lock(215001, $1)`, [assetId]);
  const { rows } = await c.query(`SELECT id FROM mnt_job_cards WHERE asset_id = $1 AND status = 'open' AND general_month IS NULL ORDER BY id LIMIT 1`, [assetId]);
  if (rows.length) return { id: rows[0].id, created: false };
  const ins = await c.query(
    `INSERT INTO mnt_job_cards (asset_id, source, source_id, opened_by, km) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [assetId, source, sourceId, userId, km]
  );
  return { id: ins.rows[0].id, created: true };
}

async function addJobs(c, cardId, jobs, user) {
  for (const j of jobs) {
    await c.query(
      `INSERT INTO mnt_jobs (job_card_id, description, origin, kind, urgency, machine_stopped, raised_by, raised_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cardId, j.description, j.origin, j.kind === "outside" ? "outside" : "inside", j.urgency || null, !!j.machine_stopped, user.id, user.role]
    );
  }
}

// ----------------------------------------------------------- inspections ---

router.get("/inspections", requireAnyPermission(["mnt.inspections", "mnt.job-cards"]), async (req, res) => {
  const { rows } = await query(`
    SELECT i.id, i.done_at, i.km, i.hours, i.job_card_id, a.name AS asset_name, s.name AS schedule_name, u.name AS done_by_name,
      (SELECT COUNT(*)::int FROM jsonb_array_elements(i.answers) x WHERE x->>'ok' = 'false') AS not_ok,
      jsonb_array_length(i.other_jobs) AS other_jobs
    FROM mnt_pm_inspections i
    JOIN mnt_assets a ON a.id = i.asset_id JOIN mnt_pm_schedules s ON s.id = i.schedule_id
    LEFT JOIN users u ON u.id = i.done_by
    ORDER BY i.done_at DESC LIMIT 60`);
  res.json(rows);
});

router.get("/inspections/:id", requireAnyPermission(["mnt.inspections", "mnt.job-cards", "mnt.equipment"]), async (req, res) => {
  const { rows } = await query(`
    SELECT i.*, a.name AS asset_name, s.name AS schedule_name, u.name AS done_by_name
    FROM mnt_pm_inspections i JOIN mnt_assets a ON a.id = i.asset_id JOIN mnt_pm_schedules s ON s.id = i.schedule_id
    LEFT JOIN users u ON u.id = i.done_by WHERE i.id = $1`, [req.params.id]);
  if (!rows.length) return bad(res, "Inspection not found.", 404);
  res.json(rows[0]);
});

router.post("/inspections", requirePermission("mnt.inspections", "create"), async (req, res) => {
  const scheduleId = Number(req.body.schedule_id);
  const assetId = Number(req.body.asset_id);
  const km = num(req.body.km);
  const hours = num(req.body.hours);
  if (Number.isNaN(km) || Number.isNaN(hours)) return bad(res, "Readings must be numbers.");
  const { rows: sr } = await query(`SELECT s.* FROM mnt_pm_schedules s WHERE s.id = $1 AND s.is_active`, [scheduleId]);
  if (!sr.length || !(await scheduleApplies(query, scheduleId, assetId))) return bad(res, "That schedule doesn't apply to this vehicle's model.");
  const s = sr[0];
  if (["km", "once_km"].includes(s.trigger_type) && km == null) return bad(res, "Enter the odometer reading — this schedule runs on km.");
  if (s.trigger_type === "hours" && hours == null) return bad(res, "Enter the hour-meter reading — this schedule runs on hours.");

  const answersIn = Array.isArray(req.body.answers) ? req.body.answers : [];
  const answers = [];
  for (const label of s.checklist) {
    const a = answersIn.find((x) => x && x.label === label) || {};
    if (a.ok !== true && a.ok !== false) return bad(res, `Mark "${label}" OK or Not OK.`);
    const note = String(a.note || "").trim();
    if (a.ok === false && !note) return bad(res, `Say what is wrong with "${label}".`);
    answers.push({ label, ok: a.ok, note: a.ok ? "" : note });
  }
  const otherJobs = (Array.isArray(req.body.other_jobs) ? req.body.other_jobs : []).map((x) => String(x || "").trim()).filter(Boolean);
  const tasksDone = (Array.isArray(req.body.tasks_done) ? req.body.tasks_done : []).map(String);

  const cur = (await assetReadings([assetId]))[assetId] || {};
  if (km != null && cur.km != null && km < cur.km) return bad(res, `Odometer ${km} is lower than the last km on record (${cur.km}). Check the reading.`);
  if (hours != null && cur.hours != null && hours < cur.hours) return bad(res, `Hour meter ${hours} is lower than the last reading on record (${cur.hours}). Check the reading.`);

  const out = await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO mnt_pm_inspections (schedule_id, asset_id, km, hours, answers, other_jobs, tasks_done, remarks, done_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9) RETURNING id`,
      [scheduleId, assetId, km, hours, JSON.stringify(answers), JSON.stringify(otherJobs), JSON.stringify(tasksDone), req.body.remarks || null, req.user.id]
    );
    const inspId = ins.rows[0].id;
    if (km != null || hours != null) {
      await c.query(`INSERT INTO mnt_meter_readings (asset_id, km, hours, source, note, entered_by) VALUES ($1,$2,$3,'inspection',$4,$5)`,
        [assetId, km, hours, `PM inspection ${inspId}`, req.user.id]);
    }
    await c.query(
      `INSERT INTO mnt_pm_schedule_assets (schedule_id, asset_id, last_done_date, last_done_km, last_done_hours)
       VALUES ($3, $4, CURRENT_DATE, $1, $2)
       ON CONFLICT (schedule_id, asset_id) DO UPDATE SET last_done_date = CURRENT_DATE,
         last_done_km = COALESCE($1, mnt_pm_schedule_assets.last_done_km), last_done_hours = COALESCE($2, mnt_pm_schedule_assets.last_done_hours)`,
      [km, hours, scheduleId, assetId]);
    const jobs = [
      ...answers.filter((a) => !a.ok).map((a) => ({ description: `${a.label} — ${a.note}`, origin: "not_ok" })),
      ...otherJobs.map((t) => ({ description: t, origin: "other" })),
    ];
    let cardId = null;
    let created = false;
    if (jobs.length) {
      const card = await openCardFor(c, assetId, req.user.id, "inspection", inspId, km);
      cardId = card.id;
      created = card.created;
      await addJobs(c, cardId, jobs, req.user);
      await c.query(`UPDATE mnt_pm_inspections SET job_card_id = $1 WHERE id = $2`, [cardId, inspId]);
    }
    return { id: inspId, job_card_id: cardId, job_card_created: created, jobs_added: jobs.length };
  });
  res.status(201).json(out);
});

// -------------------------------------------------------------- job cards ---

const CARD_COST_SQL = `
  COALESCE((SELECT SUM(value) FROM mnt_store_txns WHERE job_card_id = j.id AND txn_type = 'issue'), 0)
  + COALESCE((SELECT SUM(final_amount) FROM mnt_outside_repairs WHERE job_card_id = j.id AND final_amount IS NOT NULL), 0)
  + COALESCE((SELECT SUM(amount) FROM mnt_card_charges WHERE job_card_id = j.id), 0)`;

router.get("/job-cards", requirePermission("mnt.job-cards", "view"), async (req, res) => {
  await syncGeneralCharges().catch((err) => console.error("general-works sync:", err.message));
  const status = req.query.status || "active";
  const where = status === "active" ? `j.status IN ('open','work_done')` : status === "all" ? "true" : `j.status = $1`;
  const params = status === "active" || status === "all" ? [] : [status];
  const { rows } = await query(`
    SELECT j.id, j.status, j.source, j.opened_at, j.work_done_at, j.verified_at, a.id AS asset_id, a.name AS asset_name,
      to_char(j.general_month, 'Mon YYYY') AS general_label,
      (SELECT COUNT(*)::int FROM mnt_card_charges x WHERE x.job_card_id = j.id) AS charges,
      COUNT(m.*) FILTER (WHERE m.status <> 'cancelled')::int AS jobs,
      COUNT(m.*) FILTER (WHERE m.status = 'open')::int AS jobs_open,
      COUNT(m.*) FILTER (WHERE m.kind = 'outside' AND m.status <> 'cancelled')::int AS outside_jobs,
      (SELECT COUNT(*)::int FROM mnt_part_requests p WHERE p.job_card_id = j.id AND p.status IN ('requested','on_po')) AS parts_waiting,
      ${CARD_COST_SQL} AS cost
    FROM mnt_job_cards j JOIN mnt_assets a ON a.id = j.asset_id
    LEFT JOIN mnt_jobs m ON m.job_card_id = j.id
    WHERE ${where}
    GROUP BY j.id, a.id ORDER BY j.opened_at DESC LIMIT 200`, params);
  res.json(rows.map((r) => ({ ...r, code: code("JC", r.id), cost: money(r.cost) })));
});

async function cardDetail(id) {
  const { rows } = await query(`
    SELECT j.*, to_char(j.general_month, 'Mon YYYY') AS general_label, a.name AS asset_name, a.asset_group, ob.name AS opened_by_name, vb.name AS verified_by_name, ${CARD_COST_SQL} AS cost
    FROM mnt_job_cards j JOIN mnt_assets a ON a.id = j.asset_id
    LEFT JOIN users ob ON ob.id = j.opened_by LEFT JOIN users vb ON vb.id = j.verified_by
    WHERE j.id = $1`, [id]);
  if (!rows.length) return null;
  const [jobs, parts, issues, outside, charges] = await Promise.all([
    query(`SELECT m.*, u.name AS raised_by_name, o.status AS outside_status
           FROM mnt_jobs m LEFT JOIN users u ON u.id = m.raised_by LEFT JOIN mnt_outside_repairs o ON o.id = m.outside_repair_id
           WHERE m.job_card_id = $1 ORDER BY m.id`, [id]),
    query(`SELECT p.*, i.name AS item_name, i.unit, i.current_qty, l.po_id
           FROM mnt_part_requests p LEFT JOIN mnt_store_items i ON i.id = p.item_id
           LEFT JOIN mnt_po_lines l ON l.id = p.po_line_id
           WHERE p.job_card_id = $1 ORDER BY p.id`, [id]),
    query(`SELECT t.id, t.created_at, -t.qty_change AS qty, t.rate, t.value, t.ref_type, t.ref_id, i.name AS item_name, i.unit
           FROM mnt_store_txns t JOIN mnt_store_items i ON i.id = t.item_id
           WHERE t.job_card_id = $1 AND t.txn_type = 'issue' ORDER BY t.id`, [id]),
    query(`SELECT * FROM mnt_outside_repairs WHERE job_card_id = $1 ORDER BY id`, [id]),
    query(`SELECT id, source_type, source_id, description, qty, unit, amount, charged_at FROM mnt_card_charges WHERE job_card_id = $1 ORDER BY charged_at, id`, [id]),
  ]);
  return {
    ...rows[0], code: code("JC", id), cost: money(rows[0].cost),
    jobs: jobs.rows, parts: parts.rows.map((p) => ({ ...p, po_code: p.po_id ? code("PO", p.po_id) : null })),
    issues: issues.rows, outside: outside.rows.map((o) => ({ ...o, code: code("ER", o.id) })),
    charges: charges.rows.map((x) => ({ ...x, qty: x.qty == null ? null : Number(x.qty), amount: x.amount == null ? null : Number(x.amount) })),
  };
}

router.get("/job-cards/:id", requireAnyPermission(["mnt.job-cards", "mnt.outside-repairs"]), async (req, res) => {
  const d = await cardDetail(Number(req.params.id));
  if (!d) return bad(res, "Job card not found.", 404);
  res.json(d);
});

router.post("/job-cards", requirePermission("mnt.job-cards", "create"), async (req, res) => {
  const assetId = Number(req.body.asset_id);
  const jobs = (Array.isArray(req.body.jobs) ? req.body.jobs : [])
    .map((j) => ({ description: String(j.description || "").trim(), kind: j.kind, origin: "manual" })).filter((j) => j.description);
  if (!assetId) return bad(res, "Pick the vehicle or machine.");
  if (!jobs.length) return bad(res, "Add at least one job.");
  const out = await tx(async (c) => {
    const card = await openCardFor(c, assetId, req.user.id, "manual", null, null);
    await addJobs(c, card.id, jobs, req.user);
    return card;
  });
  res.status(201).json(out);
});

const GENERAL_LOCKED = "This is the vehicle's monthly general-works card (lubricants and top-ups) — it fills and closes itself. Raise repairs on a normal job card.";

async function cardOpenOr409(res, id) {
  const { rows } = await query(`SELECT status, general_month FROM mnt_job_cards WHERE id = $1`, [id]);
  if (!rows.length) { bad(res, "Job card not found.", 404); return false; }
  if (rows[0].status !== "open") { bad(res, "This job card is no longer open.", 409); return false; }
  if (rows[0].general_month) { bad(res, GENERAL_LOCKED, 409); return false; }
  return true;
}

router.post("/job-cards/:id/jobs", requirePermission("mnt.job-cards", "edit"), async (req, res) => {
  const description = String(req.body.description || "").trim();
  if (!description) return bad(res, "Describe the job.");
  if (!(await cardOpenOr409(res, req.params.id))) return;
  await tx((c) => addJobs(c, Number(req.params.id), [{ description, kind: req.body.kind, origin: "manual" }], req.user));
  res.status(201).json({ ok: true });
});

// Inside / outside, done, cancelled. Switching kind is refused once an
// outside repair has been raised for the job (cancel that first).
router.patch("/jobs/:id", requirePermission("mnt.job-cards", "edit"), async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, j.status AS card_status, j.general_month, o.status AS outside_status FROM mnt_jobs m
     JOIN mnt_job_cards j ON j.id = m.job_card_id LEFT JOIN mnt_outside_repairs o ON o.id = m.outside_repair_id
     WHERE m.id = $1`, [req.params.id]);
  if (!rows.length) return bad(res, "Job not found.", 404);
  const m = rows[0];
  if (m.card_status !== "open") return bad(res, "This job card is no longer open.", 409);
  if (m.general_month) return bad(res, GENERAL_LOCKED, 409);
  const liveOutside = m.outside_repair_id && !["rejected", "cancelled"].includes(m.outside_status);
  const kind = req.body.kind;
  const status = req.body.status;
  if (kind && !["inside", "outside"].includes(kind)) return bad(res, "Inside or outside only.");
  if (status && !["open", "done", "cancelled"].includes(status)) return bad(res, "Unknown status.");
  if (kind && kind !== m.kind && liveOutside) return bad(res, "An outside repair is already raised for this job — reject or cancel it first.", 409);
  if (status === "done" && m.kind === "outside" && liveOutside && !["billed", "bill_hold"].includes(m.outside_status)) {
    return bad(res, "An outside job is done when the vehicle is back from the workshop — mark it returned on the outside repair.", 409);
  }
  const desc = req.body.description != null ? String(req.body.description).trim() : null;
  await query(
    `UPDATE mnt_jobs SET kind = COALESCE($1, kind), status = COALESCE($2, status), description = COALESCE(NULLIF($3, ''), description),
       outside_repair_id = CASE WHEN $1 = 'inside' THEN NULL ELSE outside_repair_id END,
       done_by = CASE WHEN $2 = 'done' THEN $4 WHEN $2 IS NOT NULL THEN NULL ELSE done_by END,
       done_at = CASE WHEN $2 = 'done' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE done_at END
     WHERE id = $5`, [kind || null, status || null, desc, req.user.id, req.params.id]);
  res.json({ ok: true });
});

// Mechanic / Plant In Charge: every inside job is done.
router.post("/job-cards/:id/work-done", requirePermission("mnt.job-cards", "edit"), async (req, res) => {
  const d = await cardDetail(Number(req.params.id));
  if (!d) return bad(res, "Job card not found.", 404);
  if (d.status !== "open") return bad(res, "This job card is no longer open.", 409);
  if (d.general_month) return bad(res, GENERAL_LOCKED, 409);
  const openJobs = d.jobs.filter((j) => j.status === "open");
  if (openJobs.length) return bad(res, `${openJobs.length} job(s) still open — mark each done or cancelled first.`, 409);
  const waiting = d.parts.filter((p) => ["requested", "on_po"].includes(p.status));
  if (waiting.length) return bad(res, `${waiting.length} part request(s) still waiting — issue or cancel them first.`, 409);
  await query(`UPDATE mnt_job_cards SET status = 'work_done', work_done_by = $1, work_done_at = now() WHERE id = $2`, [req.user.id, req.params.id]);
  notify("manager", "Job card ready to verify", `${d.code} · ${d.asset_name}`, "/maintenance-module?tab=job-cards");
  res.json({ ok: true });
});

router.post("/job-cards/:id/verify", requirePermission("mnt.job-verify", "edit"), async (req, res) => {
  const reopen = !!req.body.reopen;
  const { rows } = await query(`SELECT status, general_month FROM mnt_job_cards WHERE id = $1`, [req.params.id]);
  if (!rows.length) return bad(res, "Job card not found.", 404);
  if (rows[0].general_month) return bad(res, GENERAL_LOCKED, 409);
  if (rows[0].status !== "work_done") return bad(res, "Only a card marked work done can be verified.", 409);
  if (reopen) {
    await query(`UPDATE mnt_job_cards SET status = 'open', work_done_by = NULL, work_done_at = NULL WHERE id = $1`, [req.params.id]);
  } else {
    await query(`UPDATE mnt_job_cards SET status = 'closed', verified_by = $1, verified_at = now() WHERE id = $2`, [req.user.id, req.params.id]);
  }
  res.json({ ok: true });
});

router.post("/job-cards/:id/cancel", requirePermission("mnt.job-verify", "edit"), async (req, res) => {
  const d = await cardDetail(Number(req.params.id));
  if (!d) return bad(res, "Job card not found.", 404);
  if (!["open", "work_done"].includes(d.status)) return bad(res, "This job card is already closed.", 409);
  if (d.general_month) return bad(res, GENERAL_LOCKED, 409);
  if (d.issues.length || d.outside.some((o) => !["rejected", "cancelled"].includes(o.status))) {
    return bad(res, "Parts were issued or an outside repair is live on this card — close it normally instead.", 409);
  }
  await tx(async (c) => {
    await c.query(`UPDATE mnt_part_requests SET status = 'cancelled' WHERE job_card_id = $1 AND status = 'requested'`, [req.params.id]);
    await c.query(`UPDATE mnt_jobs SET status = 'cancelled' WHERE job_card_id = $1 AND status = 'open'`, [req.params.id]);
    await c.query(`UPDATE mnt_job_cards SET status = 'cancelled', verified_by = $1, verified_at = now() WHERE id = $2`, [req.user.id, req.params.id]);
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------ complaints ---

router.post("/complaints", requirePermission("mnt.complaints", "create"), async (req, res) => {
  const assetId = Number(req.body.asset_id);
  const description = String(req.body.description || "").trim();
  if (!assetId) return bad(res, "Pick the vehicle or machine.");
  if (!description) return bad(res, "Say what is wrong.");
  const urgency = ["normal", "urgent", "breakdown"].includes(req.body.urgency) ? req.body.urgency : "normal";
  const km = num(req.body.km);
  if (Number.isNaN(km)) return bad(res, "Reading must be a number.");
  const { rows: a } = await query(`SELECT name FROM mnt_assets WHERE id = $1 AND is_active`, [assetId]);
  if (!a.length) return bad(res, "Equipment not found.", 404);
  const out = await tx(async (c) => {
    const card = await openCardFor(c, assetId, req.user.id, "complaint", null, km);
    await addJobs(c, card.id, [{ description, origin: "complaint", kind: req.body.kind, urgency, machine_stopped: !!req.body.machine_stopped }], req.user);
    if (km != null) {
      await c.query(`INSERT INTO mnt_meter_readings (asset_id, km, source, note, entered_by) VALUES ($1,$2,'manual','Complaint',$3)`, [assetId, km, req.user.id]);
    }
    return card;
  });
  if (urgency !== "normal" || req.body.machine_stopped) {
    notify("manager", urgency === "breakdown" ? "Breakdown complaint" : "Urgent maintenance complaint", `${a[0].name}: ${description}`, "/maintenance-module?tab=job-cards");
  }
  res.status(201).json({ job_card_id: out.id, code: code("JC", out.id), new_card: out.created });
});

router.get("/complaints", requirePermission("mnt.complaints", "view"), async (req, res) => {
  // Everyone sees their own; whoever can see job cards sees all of them.
  const all = await can(req.user, "mnt.job-cards", "view");
  const { rows } = await query(`
    SELECT m.id, m.created_at, m.description, m.kind, m.status, m.urgency, m.machine_stopped, m.raised_role,
      u.name AS raised_by_name, a.name AS asset_name, j.id AS job_card_id, j.status AS card_status, o.status AS outside_status
    FROM mnt_jobs m JOIN mnt_job_cards j ON j.id = m.job_card_id JOIN mnt_assets a ON a.id = j.asset_id
    LEFT JOIN users u ON u.id = m.raised_by LEFT JOIN mnt_outside_repairs o ON o.id = m.outside_repair_id
    WHERE m.origin = 'complaint' AND ($1 OR m.raised_by = $2)
    ORDER BY m.created_at DESC LIMIT 60`, [all, req.user.id]);
  res.json(rows.map((r) => ({ ...r, job_card_code: code("JC", r.job_card_id) })));
});

// -------------------------------------------------------- outside repairs ---

router.post("/job-cards/:id/outside-request", requirePermission("mnt.outside-repairs", "create"), async (req, res) => {
  const cardId = Number(req.params.id);
  const jobIds = (Array.isArray(req.body.job_ids) ? req.body.job_ids : []).map(Number).filter(Boolean);
  const estimate = num(req.body.estimate_amount);
  const advance = num(req.body.advance_amount);
  const days = num(req.body.expected_days);
  const workshop = String(req.body.workshop || "").trim();
  if (!jobIds.length) return bad(res, "Pick the outside job(s) this estimate covers.");
  if (!workshop) return bad(res, "Name the workshop.");
  if (!estimate || Number.isNaN(estimate) || estimate <= 0) return bad(res, "Enter the estimate amount.");
  if (Number.isNaN(advance) || (advance != null && (advance < 0 || advance > estimate))) return bad(res, "Advance must be between 0 and the estimate.");
  if (Number.isNaN(days)) return bad(res, "Expected days must be a number.");
  if (!(await cardOpenOr409(res, cardId))) return;
  const { rows: jobs } = await query(`SELECT id, kind, outside_repair_id, status FROM mnt_jobs WHERE job_card_id = $1 AND id = ANY($2::int[])`, [cardId, jobIds]);
  if (jobs.length !== jobIds.length) return bad(res, "One of those jobs isn't on this card.");
  if (jobs.some((j) => j.kind !== "outside" || j.status !== "open")) return bad(res, "Only open jobs set to Outside can go on an outside repair.");
  if (jobs.some((j) => j.outside_repair_id)) {
    const { rows: live } = await query(`SELECT 1 FROM mnt_outside_repairs WHERE id = ANY($1::int[]) AND status NOT IN ('rejected','cancelled')`, [jobs.map((j) => j.outside_repair_id).filter(Boolean)]);
    if (live.length) return bad(res, "One of those jobs already has an outside repair raised.", 409);
  }
  const id = await tx(async (c) => {
    const { rows: card } = await c.query(`SELECT asset_id FROM mnt_job_cards WHERE id = $1`, [cardId]);
    const { rows } = await c.query(
      `INSERT INTO mnt_outside_repairs (job_card_id, asset_id, workshop, estimate_amount, expected_days, advance_amount, notes, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [cardId, card[0].asset_id, workshop, estimate, days, advance, req.body.notes || null, req.user.id]
    );
    await c.query(`UPDATE mnt_jobs SET outside_repair_id = $1 WHERE id = ANY($2::int[])`, [rows[0].id, jobIds]);
    return rows[0].id;
  });
  notify("administrator", "Outside repair for approval", `${code("ER", id)} · ₹${estimate} · ${workshop}`, "/maintenance-module?tab=outside");
  res.status(201).json({ id, code: code("ER", id) });
});

router.get("/outside-repairs", requirePermission("mnt.outside-repairs", "view"), async (req, res) => {
  const { rows } = await query(`
    SELECT o.*, a.name AS asset_name, rb.name AS requested_by_name, ab.name AS approved_by_name,
      (SELECT string_agg(description, '; ' ORDER BY id) FROM mnt_jobs WHERE outside_repair_id = o.id) AS work
    FROM mnt_outside_repairs o JOIN mnt_assets a ON a.id = o.asset_id
    LEFT JOIN users rb ON rb.id = o.requested_by LEFT JOIN users ab ON ab.id = o.approved_by
    ORDER BY CASE o.status WHEN 'awaiting_approval' THEN 0 WHEN 'bill_hold' THEN 1 WHEN 'approved' THEN 2 WHEN 'sent_out' THEN 3 ELSE 4 END,
      o.requested_at DESC LIMIT 200`);
  res.json(rows.map((o) => ({ ...o, code: code("ER", o.id), job_card_code: code("JC", o.job_card_id) })));
});

async function repairOr404(res, id) {
  const { rows } = await query(`SELECT o.*, a.name AS asset_name FROM mnt_outside_repairs o JOIN mnt_assets a ON a.id = o.asset_id WHERE o.id = $1`, [id]);
  if (!rows.length) { bad(res, "Outside repair not found.", 404); return null; }
  return rows[0];
}

router.post("/outside-repairs/:id/approve", requirePermission("mnt.outside-approve", "edit"), async (req, res) => {
  const o = await repairOr404(res, req.params.id);
  if (!o) return;
  if (o.status !== "awaiting_approval") return bad(res, "This request isn't waiting for approval.", 409);
  const amt = num(req.body.approved_amount) ?? Number(o.estimate_amount);
  if (Number.isNaN(amt) || amt <= 0) return bad(res, "Enter the approved amount.");
  const advance = req.body.allow_advance === false ? null : o.advance_amount;
  await tx(async (c) => {
    await c.query(
      `UPDATE mnt_outside_repairs SET status = 'approved', approved_amount = $1, advance_amount = $2, admin_note = $3,
         approved_by = $4, approved_at = now() WHERE id = $5`, [amt, advance, req.body.admin_note || null, req.user.id, o.id]);
    // The bill row exists from approval so an advance can be paid against it;
    // it carries the approved amount as an estimate until the real bill.
    await c.query(
      `INSERT INTO mnt_bills (source_type, source_id, payee, amount, is_estimate, note)
       VALUES ('outside_repair', $1, $2, $3, true, 'Approved estimate — final bill on return')
       ON CONFLICT (source_type, source_id) DO UPDATE SET amount = EXCLUDED.amount, is_estimate = true`,
      [o.id, o.workshop || "Workshop", amt]);
  });
  res.json({ ok: true });
});

router.post("/outside-repairs/:id/reject", requirePermission("mnt.outside-approve", "edit"), async (req, res) => {
  const o = await repairOr404(res, req.params.id);
  if (!o) return;
  if (o.status !== "awaiting_approval") return bad(res, "This request isn't waiting for approval.", 409);
  const reason = String(req.body.reason || "").trim();
  if (!reason) return bad(res, "Give a reason.");
  await tx(async (c) => {
    await c.query(`UPDATE mnt_outside_repairs SET status = 'rejected', reject_reason = $1, approved_by = $2, approved_at = now() WHERE id = $3`, [reason, req.user.id, o.id]);
    // The jobs go back to being plain outside jobs; they can be re-estimated
    // or switched to Inside.
    await c.query(`UPDATE mnt_jobs SET outside_repair_id = NULL WHERE outside_repair_id = $1`, [o.id]);
  });
  res.json({ ok: true });
});

router.post("/outside-repairs/:id/cancel", requirePermission("mnt.outside-repairs", "edit"), async (req, res) => {
  const o = await repairOr404(res, req.params.id);
  if (!o) return;
  if (!["awaiting_approval", "approved"].includes(o.status)) return bad(res, "Only a request not yet sent out can be cancelled.", 409);
  const { rows: paid } = await query(`SELECT COALESCE(SUM(p.amount),0) AS paid FROM mnt_payments p JOIN mnt_bills b ON b.id = p.bill_id WHERE b.source_type = 'outside_repair' AND b.source_id = $1`, [o.id]);
  if (Number(paid[0].paid) > 0) return bad(res, "An advance has been paid on this repair — it can't be cancelled here.", 409);
  await tx(async (c) => {
    await c.query(`UPDATE mnt_outside_repairs SET status = 'cancelled' WHERE id = $1`, [o.id]);
    await c.query(`UPDATE mnt_jobs SET outside_repair_id = NULL WHERE outside_repair_id = $1`, [o.id]);
    await c.query(`DELETE FROM mnt_bills WHERE source_type = 'outside_repair' AND source_id = $1`, [o.id]);
  });
  res.json({ ok: true });
});

router.post("/outside-repairs/:id/sent-out", requirePermission("mnt.outside-repairs", "edit"), async (req, res) => {
  const o = await repairOr404(res, req.params.id);
  if (!o) return;
  if (o.status !== "approved") return bad(res, "Only an approved repair can be sent out.", 409);
  await query(`UPDATE mnt_outside_repairs SET status = 'sent_out', sent_out_at = now() WHERE id = $1`, [o.id]);
  res.json({ ok: true });
});

// Back from the workshop with its bill. Within the approved amount it is
// billed and payable; above it, it is held for the Administrator.
router.post("/outside-repairs/:id/returned", requirePermission("mnt.outside-repairs", "edit"), async (req, res) => {
  const o = await repairOr404(res, req.params.id);
  if (!o) return;
  if (o.status !== "sent_out") return bad(res, "Only a repair that was sent out can come back.", 409);
  const amount = num(req.body.bill_amount);
  const billNo = String(req.body.bill_no || "").trim();
  const billDate = req.body.bill_date || null;
  if (!amount || Number.isNaN(amount) || amount <= 0) return bad(res, "Enter the bill amount.");
  if (!billNo) return bad(res, "Enter the bill number.");
  if (billDate && !DATE_RE.test(billDate)) return bad(res, "Bill date must be yyyy-mm-dd.");
  const over = amount > Number(o.approved_amount) + 0.005;
  await tx(async (c) => {
    await c.query(
      `UPDATE mnt_outside_repairs SET status = $1, returned_at = now(), bill_no = $2, bill_date = COALESCE($3::date, CURRENT_DATE), bill_amount = $4,
         final_amount = CASE WHEN $5 THEN NULL ELSE $4::numeric END WHERE id = $6`,
      [over ? "bill_hold" : "billed", billNo, billDate, amount, over, o.id]);
    await c.query(
      `UPDATE mnt_bills SET bill_no = $1, bill_date = COALESCE($2::date, CURRENT_DATE), due_date = COALESCE($2::date, CURRENT_DATE),
         amount = $3, is_estimate = false, on_hold = $4,
         note = CASE WHEN $4 THEN 'Bill above the approved amount — waiting for Administrator' ELSE NULL END
       WHERE source_type = 'outside_repair' AND source_id = $5`, [billNo, billDate, amount, over, o.id]);
    await c.query(`UPDATE mnt_jobs SET status = 'done', done_by = $1, done_at = now() WHERE outside_repair_id = $2 AND status = 'open'`, [req.user.id, o.id]);
  });
  if (over) notify("administrator", "Outside bill above the approved amount", `${code("ER", o.id)} · bill ₹${amount} vs approved ₹${o.approved_amount}`, "/maintenance-module?tab=outside");
  res.json({ ok: true, on_hold: over });
});

router.post("/outside-repairs/:id/approve-bill", requirePermission("mnt.outside-approve", "edit"), async (req, res) => {
  const o = await repairOr404(res, req.params.id);
  if (!o) return;
  if (o.status !== "bill_hold") return bad(res, "This bill isn't waiting for approval.", 409);
  const accept = req.body.accept === "approved_only" ? Number(o.approved_amount) : Number(o.bill_amount);
  await tx(async (c) => {
    await c.query(`UPDATE mnt_outside_repairs SET status = 'billed', final_amount = $1, bill_approved_by = $2, bill_approved_at = now() WHERE id = $3`, [accept, req.user.id, o.id]);
    await c.query(`UPDATE mnt_bills SET amount = $1, on_hold = false, note = $2 WHERE source_type = 'outside_repair' AND source_id = $3`,
      [accept, accept < Number(o.bill_amount) ? `Administrator approved only the approved amount (bill ₹${o.bill_amount})` : "Administrator approved the full bill", o.id]);
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ store ---

const CATEGORIES = ["Vehicle spares", "Plant spares", "Filters", "Lubricants", "Tyres", "Batteries", "Consumables", "Tools", "Other"];

router.get("/store/items", requireAnyPermission(["mnt.store", "mnt.job-cards", "mnt.purchase-orders"]), async (req, res) => {
  const assetId = req.query.asset_id ? Number(req.query.asset_id) : null;
  const { rows } = await query(`
    SELECT i.*,
      COALESCE((SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY a.name)
                FROM mnt_store_item_assets ia JOIN mnt_assets a ON a.id = ia.asset_id WHERE ia.item_id = i.id), '[]') AS assets,
      COALESCE((SELECT json_agg(json_build_object('id', m.id, 'name', m.name) ORDER BY m.name)
                FROM mnt_store_item_models im JOIN mnt_models m ON m.id = im.model_id WHERE im.item_id = i.id), '[]') AS models
    FROM mnt_store_items i
    WHERE i.is_active ORDER BY i.name`);
  let group = null;
  let modelId = null;
  if (assetId) {
    const g = await query(`SELECT asset_group, model_id FROM mnt_assets WHERE id = $1`, [assetId]);
    group = g.rows[0]?.asset_group || null;
    modelId = g.rows[0]?.model_id || null;
  }
  // How well the item fits the vehicle: its own part (0), its model (1), its
  // type (2), general (3), meant for something else (4).
  const out = rows.map((i) => {
    let fit = 4;
    if (assetId) {
      if (i.used_for_type === "asset" && i.assets.some((a) => a.id === assetId)) fit = 0;
      else if (i.used_for_type === "model" && i.models.some((m) => m.id === modelId)) fit = 1;
      else if (i.used_for_type === "group" && i.used_for_group === group) fit = 2;
      else if (i.used_for_type === "general") fit = 3;
    }
    return {
      ...i, current_qty: Number(i.current_qty), avg_rate: Number(i.avg_rate),
      last_price: i.last_price == null ? null : Number(i.last_price), prev_price: i.prev_price == null ? null : Number(i.prev_price),
      reorder_level: i.reorder_level == null ? null : Number(i.reorder_level),
      used_for_label: i.used_for_type === "general" ? "General" : i.used_for_type === "group" ? `All ${String(i.used_for_group || "").toLowerCase()}s`
        : i.used_for_type === "model" ? (i.models.map((m) => `All ${m.name}`).join(", ") || "—") : (i.assets.map((a) => a.name).join(", ") || "—"),
      fit,
    };
  });
  if (assetId) out.sort((a, b) => a.fit - b.fit || a.name.localeCompare(b.name));
  res.json({ items: out, categories: CATEGORIES, groups: GROUPS });
});

function itemBody(b) {
  return {
    name: String(b.name || "").trim(), part_no: b.part_no ? String(b.part_no).trim() : null,
    category: CATEGORIES.includes(b.category) ? b.category : "Other", unit: String(b.unit || "Nos").trim() || "Nos",
    used_for_type: ["asset", "model", "group", "general"].includes(b.used_for_type) ? b.used_for_type : "general",
    used_for_group: b.used_for_type === "group" && GROUPS.includes(b.used_for_group) ? b.used_for_group : null,
    reorder_level: num(b.reorder_level),
    asset_ids: b.used_for_type === "asset" ? (Array.isArray(b.asset_ids) ? b.asset_ids : []).map(Number).filter(Boolean) : [],
    model_ids: b.used_for_type === "model" ? (Array.isArray(b.model_ids) ? b.model_ids : []).map(Number).filter(Boolean) : [],
  };
}
function itemError(i) {
  if (!i.name) return "Give the item a name.";
  if (Number.isNaN(i.reorder_level) || (i.reorder_level != null && i.reorder_level < 0)) return "Re-order level must be 0 or more.";
  if (i.used_for_type === "group" && !i.used_for_group) return "Pick the machine type.";
  if (i.used_for_type === "asset" && !i.asset_ids.length) return "Pick the vehicle(s) it is used for.";
  if (i.used_for_type === "model" && !i.model_ids.length) return "Pick the model(s) it is used for.";
  return null;
}

router.post("/store/items", requirePermission("mnt.store", "create"), async (req, res) => {
  const i = itemBody(req.body);
  const e = itemError(i);
  if (e) return bad(res, e);
  const id = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO mnt_store_items (name, part_no, category, unit, used_for_type, used_for_group, reorder_level, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [i.name, i.part_no, i.category, i.unit, i.used_for_type, i.used_for_group, i.reorder_level, req.user.id]);
    for (const a of i.asset_ids) await c.query(`INSERT INTO mnt_store_item_assets (item_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [rows[0].id, a]);
    for (const m of i.model_ids) await c.query(`INSERT INTO mnt_store_item_models (item_id, model_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [rows[0].id, m]);
    return rows[0].id;
  });
  res.status(201).json({ id });
});

router.patch("/store/items/:id", requirePermission("mnt.store", "edit"), async (req, res) => {
  const i = itemBody(req.body);
  const e = itemError(i);
  if (e) return bad(res, e);
  const ok = await tx(async (c) => {
    const r = await c.query(
      `UPDATE mnt_store_items SET name=$1, part_no=$2, category=$3, unit=$4, used_for_type=$5, used_for_group=$6, reorder_level=$7
       WHERE id=$8 AND is_active`, [i.name, i.part_no, i.category, i.unit, i.used_for_type, i.used_for_group, i.reorder_level, req.params.id]);
    if (!r.rowCount) return false;
    await c.query(`DELETE FROM mnt_store_item_assets WHERE item_id = $1`, [req.params.id]);
    for (const a of i.asset_ids) await c.query(`INSERT INTO mnt_store_item_assets (item_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, a]);
    await c.query(`DELETE FROM mnt_store_item_models WHERE item_id = $1`, [req.params.id]);
    for (const m of i.model_ids) await c.query(`INSERT INTO mnt_store_item_models (item_id, model_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, m]);
    return true;
  });
  if (!ok) return bad(res, "Item not found.", 404);
  res.json({ ok: true });
});

router.get("/store/items/:id", requireAnyPermission(["mnt.store", "mnt.purchase-orders"]), async (req, res) => {
  const [ledger, prices] = await Promise.all([
    query(`SELECT t.*, u.name AS by_name, a.name AS asset_name FROM mnt_store_txns t
           LEFT JOIN users u ON u.id = t.created_by LEFT JOIN mnt_assets a ON a.id = t.asset_id
           WHERE t.item_id = $1 ORDER BY t.id DESC LIMIT 100`, [req.params.id]),
    query(`SELECT g.grv_date, po.supplier_name, gl.rate, g.id AS grv_id, po.id AS po_id
           FROM mnt_grv_lines gl JOIN mnt_grvs g ON g.id = gl.grv_id JOIN mnt_po_lines l ON l.id = gl.po_line_id
           JOIN mnt_purchase_orders po ON po.id = g.po_id
           WHERE l.item_id = $1 ORDER BY g.grv_date DESC, g.id DESC LIMIT 20`, [req.params.id]),
  ]);
  res.json({
    ledger: ledger.rows.map((t) => ({ ...t, job_card_code: t.job_card_id ? code("JC", t.job_card_id) : null })),
    prices: prices.rows.map((p) => ({ ...p, grv_code: code("GRV", p.grv_id), po_code: code("PO", p.po_id) })),
  });
});

// Opening stock and physical-count corrections.
router.post("/store/items/:id/adjust", requirePermission("mnt.store-adjust", "edit"), async (req, res) => {
  const counted = num(req.body.counted_qty);
  const rate = num(req.body.rate);
  if (counted == null || Number.isNaN(counted) || counted < 0) return bad(res, "Enter the counted quantity.");
  if (Number.isNaN(rate) || (rate != null && rate < 0)) return bad(res, "Rate must be 0 or more.");
  const note = String(req.body.note || "").trim();
  if (!note) return bad(res, "Say why (opening stock, physical count…).");
  const ok = await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM mnt_store_items WHERE id = $1 AND is_active FOR UPDATE`, [req.params.id]);
    if (!rows.length) return false;
    const it = rows[0];
    const diff = counted - Number(it.current_qty);
    // An opening quantity with a rate sets the average rate; otherwise the
    // rate is untouched.
    let avg = Number(it.avg_rate);
    if (rate != null && diff > 0) avg = counted > 0 ? (Number(it.current_qty) * avg + diff * rate) / counted : rate;
    await c.query(`UPDATE mnt_store_items SET current_qty = $1, avg_rate = $2 WHERE id = $3`, [counted, money(avg), it.id]);
    await c.query(
      `INSERT INTO mnt_store_txns (item_id, txn_type, qty_change, balance_after, rate, value, note, created_by)
       VALUES ($1,'adjust',$2,$3,$4,$5,$6,$7)`, [it.id, diff, counted, money(avg), money(Math.abs(diff) * avg), note, req.user.id]);
    return true;
  });
  if (!ok) return bad(res, "Item not found.", 404);
  res.json({ ok: true });
});

// -------------------------------------------------------- part requests ---

router.post("/job-cards/:id/part-requests", requirePermission("mnt.job-cards", "edit"), async (req, res) => {
  const cardId = Number(req.params.id);
  const qty = num(req.body.qty);
  const itemId = num(req.body.item_id);
  const jobId = num(req.body.job_id);
  if (!qty || Number.isNaN(qty) || qty <= 0) return bad(res, "Enter the quantity.");
  if (Number.isNaN(itemId) || Number.isNaN(jobId)) return bad(res, "Pick a valid item.");
  if (!(await cardOpenOr409(res, cardId))) return;
  let description = String(req.body.description || "").trim();
  if (itemId) {
    const { rows } = await query(`SELECT name FROM mnt_store_items WHERE id = $1 AND is_active`, [itemId]);
    if (!rows.length) return bad(res, "Item not found.", 404);
    description = description || rows[0].name;
  }
  if (!description) return bad(res, "Pick an item from store, or describe the part.");
  if (jobId) {
    const { rows } = await query(`SELECT kind FROM mnt_jobs WHERE id = $1 AND job_card_id = $2`, [jobId, cardId]);
    if (!rows.length) return bad(res, "That job isn't on this card.");
    if (rows[0].kind === "outside") return bad(res, "Parts for an outside job come from the workshop — request parts for inside jobs only.");
  }
  const { rows } = await query(
    `INSERT INTO mnt_part_requests (job_card_id, job_id, item_id, description, qty, note, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [cardId, jobId, itemId, description, qty, req.body.note || null, req.user.id]);
  notify("store", "Part requested", `${code("JC", cardId)}: ${description} × ${qty}`, "/maintenance-module?tab=purchase");
  res.status(201).json(rows[0]);
});

router.get("/part-requests", requireAnyPermission(["mnt.store", "mnt.purchase-orders", "mnt.job-cards"]), async (req, res) => {
  const open = req.query.status !== "all";
  const { rows } = await query(`
    SELECT p.*, i.name AS item_name, i.unit, i.current_qty, i.last_price, i.used_for_type, a.id AS asset_id, a.name AS asset_name, a.asset_group,
      u.name AS requested_by_name, l.po_id,
      (i.used_for_type = 'asset' AND NOT EXISTS (SELECT 1 FROM mnt_store_item_assets x WHERE x.item_id = i.id AND x.asset_id = a.id))
        OR (i.used_for_type = 'group' AND i.used_for_group IS DISTINCT FROM a.asset_group)
        OR (i.used_for_type = 'model' AND NOT EXISTS (SELECT 1 FROM mnt_store_item_models x WHERE x.item_id = i.id AND x.model_id = a.model_id)) AS other_machine
    FROM mnt_part_requests p
    JOIN mnt_job_cards j ON j.id = p.job_card_id JOIN mnt_assets a ON a.id = j.asset_id
    LEFT JOIN mnt_store_items i ON i.id = p.item_id LEFT JOIN users u ON u.id = p.requested_by
    LEFT JOIN mnt_po_lines l ON l.id = p.po_line_id
    WHERE ($1 = false OR p.status IN ('requested','on_po'))
    ORDER BY p.requested_at DESC LIMIT 200`, [open]);
  res.json(rows.map((p) => ({ ...p, job_card_code: code("JC", p.job_card_id), po_code: p.po_id ? code("PO", p.po_id) : null, current_qty: p.current_qty == null ? null : Number(p.current_qty) })));
});

// Issue a spare against a job card, at the item's average rate. The cost lands
// on the job card and its vehicle. A part meant for another machine can still
// be issued (the owner, 18 Oct) — the screen only shows a note.
async function issueToCard(c, { itemId, qty, cardId, assetId, userId, refType, refId, rate = null }) {
  const { rows } = await c.query(`SELECT * FROM mnt_store_items WHERE id = $1 FOR UPDATE`, [itemId]);
  const it = rows[0];
  if (!it) throw Object.assign(new Error("Item not found."), { status: 404 });
  if (Number(it.current_qty) + 0.0001 < qty) throw Object.assign(new Error(`Only ${Number(it.current_qty)} ${it.unit} in stock.`), { status: 409 });
  const r = rate == null ? Number(it.avg_rate) : rate;
  const after = Number(it.current_qty) - qty;
  await c.query(`UPDATE mnt_store_items SET current_qty = $1 WHERE id = $2`, [after, itemId]);
  const value = money(qty * r);
  await c.query(
    `INSERT INTO mnt_store_txns (item_id, txn_type, qty_change, balance_after, rate, value, job_card_id, asset_id, ref_type, ref_id, created_by)
     VALUES ($1,'issue',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [itemId, -qty, after, money(r), value, cardId, assetId, refType, refId, userId]);
  return value;
}

router.post("/part-requests/:id/issue", requirePermission("mnt.parts-issue", "edit"), async (req, res) => {
  const qtyIn = num(req.body.qty);
  try {
    const out = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT p.*, j.asset_id, j.status AS card_status FROM mnt_part_requests p JOIN mnt_job_cards j ON j.id = p.job_card_id
         WHERE p.id = $1 FOR UPDATE OF p`, [req.params.id]);
      const p = rows[0];
      if (!p) throw Object.assign(new Error("Request not found."), { status: 404 });
      if (p.status !== "requested") throw Object.assign(new Error("This request is no longer waiting to be issued."), { status: 409 });
      if (p.card_status !== "open") throw Object.assign(new Error("The job card is no longer open."), { status: 409 });
      const itemId = num(req.body.item_id) || p.item_id;
      if (!itemId) throw Object.assign(new Error("Pick the store item to issue."), { status: 400 });
      const qty = qtyIn || Number(p.qty);
      if (!(qty > 0)) throw Object.assign(new Error("Enter the quantity."), { status: 400 });
      const value = await issueToCard(c, { itemId, qty, cardId: p.job_card_id, assetId: p.asset_id, userId: req.user.id, refType: "part_request", refId: p.id });
      await c.query(`UPDATE mnt_part_requests SET status = 'issued', item_id = $1, issued_qty = $2, issue_value = $3, issued_by = $4, issued_at = now() WHERE id = $5`,
        [itemId, qty, value, req.user.id, p.id]);
      return { value };
    });
    res.json(out);
  } catch (err) {
    if (err.status) return bad(res, err.message, err.status);
    throw err;
  }
});

router.post("/part-requests/:id/cancel", requireAnyPermission(["mnt.parts-issue", "mnt.job-cards"], "edit"), async (req, res) => {
  const r = await query(`UPDATE mnt_part_requests SET status = 'cancelled' WHERE id = $1 AND status = 'requested'`, [req.params.id]);
  if (!r.rowCount) return bad(res, "Only a request not yet issued or ordered can be cancelled.", 409);
  res.json({ ok: true });
});

// ------------------------------------------------------- purchase orders ---

router.get("/purchase-orders", requirePermission("mnt.purchase-orders", "view"), async (req, res) => {
  const { rows } = await query(`
    SELECT po.*, cb.name AS created_by_name, ab.name AS approved_by_name,
      (SELECT COALESCE(SUM(received_qty * rate * (1 + gst_pct / 100)), 0) FROM mnt_po_lines WHERE po_id = po.id) AS received_value,
      (SELECT string_agg(DISTINCT 'JC-' || LPAD(job_card_id::text, 4, '0'), ', ') FROM mnt_po_lines WHERE po_id = po.id AND job_card_id IS NOT NULL) AS for_cards,
      (SELECT string_agg(code, ', ') FROM (SELECT 'GRV-' || LPAD(id::text, 4, '0') AS code FROM mnt_grvs WHERE po_id = po.id ORDER BY id) g) AS grvs
    FROM mnt_purchase_orders po LEFT JOIN users cb ON cb.id = po.created_by LEFT JOIN users ab ON ab.id = po.approved_by
    ORDER BY CASE po.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, po.created_at DESC LIMIT 200`);
  res.json(rows.map((p) => ({ ...p, code: code("PO", p.id), total: Number(p.total) })));
});

router.get("/purchase-orders/:id", requirePermission("mnt.purchase-orders", "view"), async (req, res) => {
  const { rows } = await query(`SELECT po.*, cb.name AS created_by_name, ab.name AS approved_by_name FROM mnt_purchase_orders po
    LEFT JOIN users cb ON cb.id = po.created_by LEFT JOIN users ab ON ab.id = po.approved_by WHERE po.id = $1`, [req.params.id]);
  if (!rows.length) return bad(res, "Purchase order not found.", 404);
  const [lines, grvs] = await Promise.all([
    query(`SELECT l.*, i.name AS item_name, i.unit, i.last_price, a.name AS asset_name
           FROM mnt_po_lines l JOIN mnt_store_items i ON i.id = l.item_id
           LEFT JOIN mnt_job_cards j ON j.id = l.job_card_id LEFT JOIN mnt_assets a ON a.id = j.asset_id
           WHERE l.po_id = $1 ORDER BY l.id`, [req.params.id]),
    query(`SELECT g.*, u.name AS created_by_name FROM mnt_grvs g LEFT JOIN users u ON u.id = g.created_by WHERE g.po_id = $1 ORDER BY g.id`, [req.params.id]),
  ]);
  res.json({
    ...rows[0], code: code("PO", rows[0].id),
    lines: lines.rows.map((l) => ({ ...l, job_card_code: l.job_card_id ? code("JC", l.job_card_id) : null })),
    grvs: grvs.rows.map((g) => ({ ...g, code: code("GRV", g.id) })),
  });
});

router.post("/purchase-orders", requirePermission("mnt.purchase-orders", "create"), async (req, res) => {
  const supplier = String(req.body.supplier_name || "").trim();
  const credit = num(req.body.credit_days);
  if (!supplier) return bad(res, "Name the supplier.");
  if (Number.isNaN(credit) || (credit != null && credit < 0)) return bad(res, "Credit days must be 0 or more.");
  const linesIn = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!linesIn.length) return bad(res, "Add at least one line.");
  const lines = [];
  for (const l of linesIn) {
    const item = num(l.item_id), qty = num(l.qty), rate = num(l.rate), gst = num(l.gst_pct ?? 18), pr = num(l.part_request_id);
    if (!item || Number.isNaN(item)) return bad(res, "Every line needs a store item (add a new item first if it isn't listed).");
    if (!qty || Number.isNaN(qty) || qty <= 0) return bad(res, "Every line needs a quantity.");
    if (rate == null || Number.isNaN(rate) || rate < 0) return bad(res, "Every line needs a rate.");
    if (Number.isNaN(gst) || gst < 0 || gst > 40) return bad(res, "GST % looks wrong.");
    lines.push({ item, qty, rate, gst, pr: pr || null });
  }
  try {
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO mnt_purchase_orders (supplier_name, credit_days, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [supplier, credit ?? 30, req.body.notes || null, req.user.id]);
      const poId = rows[0].id;
      let total = 0;
      for (const l of lines) {
        let cardId = null;
        if (l.pr) {
          const { rows: pr } = await c.query(`SELECT * FROM mnt_part_requests WHERE id = $1 FOR UPDATE`, [l.pr]);
          if (!pr.length || pr[0].status !== "requested") throw Object.assign(new Error("A part request on this PO is no longer waiting."), { status: 409 });
          cardId = pr[0].job_card_id;
        }
        const amount = money(l.qty * l.rate * (1 + l.gst / 100));
        total += amount;
        const ins = await c.query(
          `INSERT INTO mnt_po_lines (po_id, item_id, qty, rate, gst_pct, amount, job_card_id, part_request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [poId, l.item, l.qty, l.rate, l.gst, amount, cardId, l.pr]);
        if (l.pr) await c.query(`UPDATE mnt_part_requests SET status = 'on_po', item_id = COALESCE(item_id, $1), po_line_id = $2 WHERE id = $3`, [l.item, ins.rows[0].id, l.pr]);
      }
      await c.query(`UPDATE mnt_purchase_orders SET total = $1 WHERE id = $2`, [money(total), poId]);
      return poId;
    });
    notify("manager", "Maintenance PO for approval", `${code("PO", id)} · ${supplier}`, "/maintenance-module?tab=purchase");
    res.status(201).json({ id, code: code("PO", id) });
  } catch (err) {
    if (err.status) return bad(res, err.message, err.status);
    throw err;
  }
});

router.post("/purchase-orders/:id/approve", requirePermission("mnt.po-approve", "edit"), async (req, res) => {
  const r = await query(`UPDATE mnt_purchase_orders SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2 AND status = 'pending'`, [req.user.id, req.params.id]);
  if (!r.rowCount) return bad(res, "This PO isn't waiting for approval.", 409);
  res.json({ ok: true });
});

async function releaseRequests(c, poId) {
  // Part requests on a rejected / cancelled PO go back to Store's queue.
  await c.query(`UPDATE mnt_part_requests SET status = 'requested', po_line_id = NULL
    WHERE po_line_id IN (SELECT id FROM mnt_po_lines WHERE po_id = $1) AND status = 'on_po'`, [poId]);
}

router.post("/purchase-orders/:id/reject", requirePermission("mnt.po-approve", "edit"), async (req, res) => {
  const reason = String(req.body.reason || "").trim();
  if (!reason) return bad(res, "Give a reason.");
  const ok = await tx(async (c) => {
    const r = await c.query(`UPDATE mnt_purchase_orders SET status = 'rejected', reject_reason = $1, approved_by = $2, approved_at = now() WHERE id = $3 AND status = 'pending'`, [reason, req.user.id, req.params.id]);
    if (!r.rowCount) return false;
    await releaseRequests(c, req.params.id);
    return true;
  });
  if (!ok) return bad(res, "This PO isn't waiting for approval.", 409);
  res.json({ ok: true });
});

router.post("/purchase-orders/:id/cancel", requirePermission("mnt.purchase-orders", "edit"), async (req, res) => {
  const ok = await tx(async (c) => {
    const { rows } = await c.query(`SELECT status, (SELECT COUNT(*) FROM mnt_grvs WHERE po_id = $1)::int AS grvs FROM mnt_purchase_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length || !["pending", "approved"].includes(rows[0].status) || rows[0].grvs) return false;
    await c.query(`UPDATE mnt_purchase_orders SET status = 'cancelled' WHERE id = $1`, [req.params.id]);
    await releaseRequests(c, req.params.id);
    return true;
  });
  if (!ok) return bad(res, "Only a PO with nothing received yet can be cancelled.", 409);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- GRV ---
// Receive against an approved PO. Every line goes into stock at the bought
// rate (moving average) and sets the item's last purchase price. A line bought
// for a job card is issued straight on to that card at the same rate, so its
// cost lands on the vehicle. The supplier's bill joins Payments with the PO's
// credit days.

router.post("/purchase-orders/:id/grv", requirePermission("mnt.grv", "create"), async (req, res) => {
  const poId = Number(req.params.id);
  const grvDate = req.body.grv_date || null;
  const billDate = req.body.bill_date || null;
  const billNo = String(req.body.bill_no || "").trim();
  const billAmount = num(req.body.bill_amount);
  if ((grvDate && !DATE_RE.test(grvDate)) || (billDate && !DATE_RE.test(billDate))) return bad(res, "Dates must be yyyy-mm-dd.");
  if (Number.isNaN(billAmount) || (billAmount != null && billAmount < 0)) return bad(res, "Bill amount must be a number.");
  const linesIn = (Array.isArray(req.body.lines) ? req.body.lines : []).map((l) => ({ id: Number(l.po_line_id), qty: num(l.qty) })).filter((l) => l.qty);
  if (!linesIn.length) return bad(res, "Enter what was received.");
  if (linesIn.some((l) => Number.isNaN(l.qty) || l.qty <= 0)) return bad(res, "Received quantities must be positive.");
  try {
    const out = await tx(async (c) => {
      const { rows: po } = await c.query(`SELECT * FROM mnt_purchase_orders WHERE id = $1 FOR UPDATE`, [poId]);
      if (!po.length) throw Object.assign(new Error("Purchase order not found."), { status: 404 });
      if (po[0].status !== "approved") throw Object.assign(new Error("A GRV can only be made against an approved PO."), { status: 409 });
      const g = await c.query(
        `INSERT INTO mnt_grvs (po_id, grv_date, bill_no, bill_date, bill_amount, created_by) VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6) RETURNING id, grv_date::text`,
        [poId, grvDate, billNo || null, billDate, billAmount, req.user.id]);
      const grvId = g.rows[0].id;
      let total = 0;
      for (const li of linesIn) {
        const { rows: lr } = await c.query(
          `SELECT l.*, j.asset_id, j.status AS card_status FROM mnt_po_lines l LEFT JOIN mnt_job_cards j ON j.id = l.job_card_id
           WHERE l.id = $1 AND l.po_id = $2 FOR UPDATE OF l`, [li.id, poId]);
        const l = lr[0];
        if (!l) throw Object.assign(new Error("A line isn't on this PO."), { status: 400 });
        const left = Number(l.qty) - Number(l.received_qty);
        if (li.qty > left + 0.0001) throw Object.assign(new Error(`More received than ordered on a line (${left} left to receive).`), { status: 409 });
        const landed = Number(l.rate) * (1 + Number(l.gst_pct) / 100);
        const value = money(li.qty * landed);
        total += value;
        // Into stock, moving average.
        const { rows: ir } = await c.query(`SELECT * FROM mnt_store_items WHERE id = $1 FOR UPDATE`, [l.item_id]);
        const it = ir[0];
        const newQty = Number(it.current_qty) + li.qty;
        const avg = newQty > 0 ? (Math.max(0, Number(it.current_qty)) * Number(it.avg_rate) + li.qty * landed) / newQty : landed;
        await c.query(
          `UPDATE mnt_store_items SET current_qty = $1, avg_rate = $2, prev_price = last_price, last_price = $3, last_supplier = $4, last_purchase_date = $5::date WHERE id = $6`,
          [newQty, money(avg), l.rate, po[0].supplier_name, g.rows[0].grv_date, it.id]);
        await c.query(
          `INSERT INTO mnt_store_txns (item_id, txn_type, qty_change, balance_after, rate, value, ref_type, ref_id, note, created_by)
           VALUES ($1,'receive',$2,$3,$4,$5,'grv',$6,$7,$8)`,
          [it.id, li.qty, newQty, money(landed), value, grvId, `${code("GRV", grvId)} / ${code("PO", poId)} · ${po[0].supplier_name}`, req.user.id]);
        await c.query(`UPDATE mnt_po_lines SET received_qty = received_qty + $1 WHERE id = $2`, [li.qty, l.id]);
        await c.query(`INSERT INTO mnt_grv_lines (grv_id, po_line_id, qty, rate, value, job_card_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [grvId, l.id, li.qty, money(landed), value, l.job_card_id]);
        // Bought for a job card: straight on to it at the bought rate.
        if (l.job_card_id && l.card_status === "open") {
          await issueToCard(c, { itemId: it.id, qty: li.qty, cardId: l.job_card_id, assetId: l.asset_id, userId: req.user.id, refType: "grv", refId: grvId, rate: landed });
          if (l.part_request_id) {
            await c.query(
              `UPDATE mnt_part_requests SET status = 'issued', issued_qty = COALESCE(issued_qty, 0) + $1, issue_value = COALESCE(issue_value, 0) + $2,
                 issued_by = $3, issued_at = now() WHERE id = $4`, [li.qty, value, req.user.id, l.part_request_id]);
          }
        }
      }
      const { rows: rem } = await c.query(`SELECT COUNT(*)::int AS n FROM mnt_po_lines WHERE po_id = $1 AND received_qty + 0.0001 < qty`, [poId]);
      if (!rem[0].n) await c.query(`UPDATE mnt_purchase_orders SET status = 'received' WHERE id = $1`, [poId]);
      const amount = billAmount ?? money(total);
      await c.query(
        `INSERT INTO mnt_bills (source_type, source_id, payee, bill_no, bill_date, amount, due_date)
         VALUES ('grv', $1, $2, $3, COALESCE($4::date, $5::date), $6, COALESCE($4::date, $5::date) + $7::int)`,
        [grvId, po[0].supplier_name, billNo || null, billDate, g.rows[0].grv_date, amount, po[0].credit_days]);
      return { id: grvId, code: code("GRV", grvId), value: money(total) };
    });
    res.status(201).json(out);
  } catch (err) {
    if (err.status) return bad(res, err.message, err.status);
    throw err;
  }
});

// -------------------------------------------------------------- payments ---

router.get("/bills", requirePermission("mnt.payments", "view"), async (req, res) => {
  const { rows } = await query(`
    SELECT b.*, b.due_date::text AS due_date, b.bill_date::text AS bill_date, COALESCE(SUM(p.amount + p.tds), 0) AS paid, CURRENT_DATE::text AS today,
      CASE b.source_type WHEN 'grv' THEN (SELECT 'GRV-' || LPAD(g.id::text, 4, '0') || ' / PO-' || LPAD(g.po_id::text, 4, '0') FROM mnt_grvs g WHERE g.id = b.source_id)
        ELSE (SELECT 'ER-' || LPAD(o.id::text, 4, '0') || ' · ' || a.name FROM mnt_outside_repairs o JOIN mnt_assets a ON a.id = o.asset_id WHERE o.id = b.source_id) END AS against
    FROM mnt_bills b LEFT JOIN mnt_payments p ON p.bill_id = b.id
    GROUP BY b.id ORDER BY b.on_hold DESC, b.due_date NULLS LAST, b.id DESC LIMIT 300`);
  res.json(rows.map((b) => {
    const balance = money(Number(b.amount) - Number(b.paid));
    let state = "open";
    if (b.on_hold) state = "on_hold";
    else if (balance <= 0.004) state = "paid";
    else if (b.is_estimate) state = "estimate";
    else if (b.due_date && String(b.due_date).slice(0, 10) < b.today) state = "overdue";
    return { ...b, amount: Number(b.amount), paid: Number(b.paid), balance, state };
  }));
});

router.get("/bills/:id/payments", requirePermission("mnt.payments", "view"), async (req, res) => {
  const { rows } = await query(`SELECT p.*, u.name AS by_name FROM mnt_payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.bill_id = $1 ORDER BY p.paid_on, p.id`, [req.params.id]);
  res.json(rows);
});

router.post("/bills/:id/payments", requirePermission("mnt.payments", "create"), async (req, res) => {
  const amount = num(req.body.amount);
  const tds = num(req.body.tds) || 0;
  const paidOn = req.body.paid_on || null;
  if (!amount || Number.isNaN(amount) || amount <= 0) return bad(res, "Enter the amount paid.");
  if (Number.isNaN(tds) || tds < 0) return bad(res, "TDS must be 0 or more.");
  if (paidOn && !DATE_RE.test(paidOn)) return bad(res, "Date must be yyyy-mm-dd.");
  try {
    await tx(async (c) => {
      const { rows } = await c.query(`SELECT b.*, (SELECT COALESCE(SUM(amount + tds), 0) FROM mnt_payments WHERE bill_id = b.id) AS paid FROM mnt_bills b WHERE b.id = $1 FOR UPDATE`, [req.params.id]);
      const b = rows[0];
      if (!b) throw Object.assign(new Error("Bill not found."), { status: 404 });
      if (b.on_hold) throw Object.assign(new Error("This bill is on hold — the Administrator has to approve it first."), { status: 409 });
      const balance = Number(b.amount) - Number(b.paid);
      if (amount + tds > balance + 0.005) throw Object.assign(new Error(`That is more than the balance (₹${money(balance)}).`), { status: 409 });
      await c.query(`INSERT INTO mnt_payments (bill_id, amount, tds, paid_on, mode, reference, created_by) VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7)`,
        [b.id, amount, tds, paidOn, req.body.mode || null, req.body.reference || null, req.user.id]);
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.status) return bad(res, err.message, err.status);
    throw err;
  }
});

// ------------------------------------------------------------- dashboard ---

router.get("/dashboard", requirePermission("mnt.dashboard", "view"), async (req, res) => {
  await syncGeneralCharges().catch((err) => console.error("general-works sync:", err.message));
  const [due, counts, approvals] = await Promise.all([
    dueList(),
    query(`SELECT
      (SELECT COUNT(*)::int FROM mnt_job_cards WHERE status = 'open' AND general_month IS NULL) AS open_cards,
      (SELECT COUNT(*)::int FROM mnt_job_cards WHERE status = 'work_done') AS to_verify,
      (SELECT COUNT(*)::int FROM mnt_part_requests WHERE status IN ('requested','on_po')) AS parts_waiting,
      (SELECT COUNT(*)::int FROM mnt_outside_repairs WHERE status = 'sent_out') AS at_workshop,
      (SELECT COUNT(*)::int FROM mnt_store_items WHERE is_active AND reorder_level IS NOT NULL AND current_qty <= reorder_level) AS low_stock,
      (SELECT COALESCE(SUM(b.amount - COALESCE((SELECT SUM(amount + tds) FROM mnt_payments WHERE bill_id = b.id), 0)), 0)
         FROM mnt_bills b WHERE NOT b.is_estimate) AS payable,
      (SELECT COALESCE(SUM(value), 0) FROM mnt_store_txns WHERE txn_type = 'issue' AND created_at >= date_trunc('month', now()))
       + (SELECT COALESCE(SUM(final_amount), 0) FROM mnt_outside_repairs WHERE final_amount IS NOT NULL AND returned_at >= date_trunc('month', now()))
       + (SELECT COALESCE(SUM(amount), 0) FROM mnt_card_charges WHERE charged_at >= date_trunc('month', now())) AS cost_month`),
    query(`
      SELECT 'outside' AS kind, o.id, o.estimate_amount AS amount, a.name AS asset_name, o.workshop AS detail, o.requested_at AS at
        FROM mnt_outside_repairs o JOIN mnt_assets a ON a.id = o.asset_id WHERE o.status = 'awaiting_approval'
      UNION ALL
      SELECT 'bill_hold', o.id, o.bill_amount - o.approved_amount, a.name, o.workshop || ' · bill ₹' || o.bill_amount || ' vs approved ₹' || o.approved_amount, o.returned_at
        FROM mnt_outside_repairs o JOIN mnt_assets a ON a.id = o.asset_id WHERE o.status = 'bill_hold'
      UNION ALL
      SELECT 'po', po.id, po.total, NULL, po.supplier_name, po.created_at FROM mnt_purchase_orders po WHERE po.status = 'pending'
      ORDER BY at`),
  ]);
  const c = counts.rows[0];
  res.json({
    kpis: {
      overdue: due.filter((d) => d.status === "overdue").length,
      due_soon: due.filter((d) => d.status === "due_soon").length,
      never: due.filter((d) => d.status === "never").length,
      open_cards: c.open_cards, to_verify: c.to_verify, parts_waiting: c.parts_waiting, at_workshop: c.at_workshop,
      low_stock: c.low_stock, payable: money(c.payable), cost_month: money(c.cost_month),
    },
    approvals: approvals.rows.map((r) => ({ ...r, amount: Number(r.amount), code: code(r.kind === "po" ? "PO" : "ER", r.id) })),
    due: due.filter((d) => ["overdue", "due_soon"].includes(d.status)).slice(0, 25),
  });
});

export default router;
