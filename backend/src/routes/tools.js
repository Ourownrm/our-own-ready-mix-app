// Round 264 (v10.96) — Tools Issue Register, personal assets, cube moulds &
// concrete pump pipes (owner, 2–3 Nov 2026; mockup v5 in the Project:
// claude/tools-issue-register-mockup-v1.md). Tables: lib/round264Schema.js.
//
// Every numbered thing is one tl_items row with its own ID (T-…, PT-…, IT-…,
// CM-…, PP-…). Items come in three ways only:
//   * a Maintenance GRV line whose store item is in a register category
//     (Tools / Power tools & equipment / Personal assets / Cube moulds / Pump
//     pipes) — see addFromGrv(), called from routes/maintenanceModule.js;
//   * the one-time "add existing list" (a batch the Plant In Charge confirms;
//     later corrections go the same way);
//   * personal assets, which the Administrator adds directly (HR).
// Items leave only by an approved removal (damaged / lost), and an ID is never
// used again.
//
// Who does what (all on the Access Control page):
//   tools.register / tools.in-use / hr.assets   see, add existing, edit, move
//   tools.issue (hr.assets for assets)          issue (create), take back (edit)
//   tools.approve (hr.asset-approve)            approve an issue
//   tools.report-damage                         report a damaged / lost item
//   tools.removal-approve                       approve a removal; confirm a list
//   tools.loss-decide                           damaged / lost on return: no
//                                               charge, repair, or recover from
//                                               salary; approve a LOST removal
//   tools.my                                    my own tools & assets, accept
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { allow, can } from "../lib/permissions.js";
import { pushToRole, pushToUser } from "../lib/push.js";
import { ensureRound264 } from "../lib/round264Schema.js";
import { exitBlock, ensureExit } from "../lib/hrExit.js";

const router = Router();
router.use(requireAuth);
// Schema first, OUTSIDE any transaction: a first-time ALTER waiting on a
// table an open transaction has read would never finish.
router.use((req, res, next) => { ensureRound264().then(() => ensureExit()).then(() => next(), next); });

export const KINDS = ["tool", "power_tool", "asset", "cube_mould", "pump_pipe"];
export const KIND_LABEL = { tool: "Tool", power_tool: "Power tool", asset: "Personal asset", cube_mould: "Cube mould", pump_pipe: "Pump pipe / bend" };
export const DEFAULT_PREFIX = { tool: "T", power_tool: "PT", asset: "IT", cube_mould: "CM", pump_pipe: "PP" };
// The Maintenance store categories that feed a register (see the GRV).
export const CATEGORY_KIND = {
  "Tools": "tool", "Power tools & equipment": "power_tool", "Personal assets": "asset",
  "Cube moulds": "cube_mould", "Pump pipes": "pump_pipe",
};
const VIEW_KEY = { tool: "tools.register", power_tool: "tools.register", asset: "hr.assets", cube_mould: "tools.in-use", pump_pipe: "tools.in-use" };
const IN_USE = ["cube_mould", "pump_pipe"];
const TOOLISH = ["tool", "power_tool"];
export const PLACES = ["Plant lab", "Boom placer BP-01", "Line pump set", "Plant spare", "Tools store"];
const REASONS = ["Burst / cracked", "Worn thin", "Bent / dented", "Broken", "Not working", "Lost"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const txt = (v, n = 300) => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };
const num = (v) => (v === "" || v == null ? null : Number(v));
class Fail extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const out = await fn(c); await c.query("COMMIT"); return out; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
function handle(fn) {
  return async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) { if (e instanceof Fail || e.status) return bad(res, e.message, e.status || 400); next(e); }
  };
}
function notifyRole(role, title, body, url) {
  pushToRole(role, { title, body, url }).catch(() => {});
  query(`INSERT INTO notifications (recipient_role, type, message) VALUES ($1, 'tools', $2)`, [role, `${title} — ${body}`]).catch(() => {});
}
async function canAny(user, pairs) { for (const [k, a] of pairs) if (await can(user, k, a)) return true; return false; }
async function mustCan(user, key, action, msg = "You don't have access to this.") {
  if (!(await can(user, key, action))) throw new Fail(msg, 403);
}
const issueKey = (assets) => (assets ? "hr.assets" : "tools.issue");
const approveKey = (assets) => (assets ? "hr.asset-approve" : "tools.approve");

export async function logEvent(db, itemId, event, note, userId) {
  await db.query(`INSERT INTO tl_events (item_id, event, note, created_by) VALUES ($1,$2,$3,$4)`, [itemId, event, txt(note, 500), userId || null]);
}

// The next free number for a prefix (CM-001, CM-002 …). Locked per prefix so
// two saves at once never hand out the same ID; removed IDs are never reused
// because removed rows stay.
export async function nextCodes(db, prefix, n) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('tl_code_' || $1))`, [prefix]);
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(substring(code from '^' || $1 || '-(\\d+)$')::int), 0) AS n FROM tl_items WHERE code LIKE $1 || '-%'`, [prefix]);
  const start = Number(rows[0].n) + 1;
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(start + i).padStart(3, "0")}`);
}

// The register type for a Maintenance store item (created the first time).
export async function typeForStoreItem(db, item, kind) {
  const { rows } = await db.query(`SELECT * FROM tl_types WHERE store_item_id = $1`, [item.id]);
  if (rows[0]) return rows[0];
  const { rows: same } = await db.query(`SELECT * FROM tl_types WHERE kind = $1 AND lower(name) = lower($2) AND store_item_id IS NULL`, [kind, item.name]);
  if (same[0]) {
    await db.query(`UPDATE tl_types SET store_item_id = $1 WHERE id = $2`, [item.id, same[0].id]);
    return same[0];
  }
  const { rows: ins } = await db.query(
    `INSERT INTO tl_types (kind, name, prefix, store_item_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (kind, lower(name)) DO UPDATE SET store_item_id = COALESCE(tl_types.store_item_id, EXCLUDED.store_item_id) RETURNING *`,
    [kind, item.name, DEFAULT_PREFIX[kind], item.id]);
  return ins[0];
}

async function employee(db, id) {
  const { rows } = await db.query(`SELECT id, name, emp_code, designation, app_user_id, is_active FROM hr_employees WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Create an issue (pending approval). Items must be in the store.
export async function createIssue(db, { employeeId, mode, returnBy, itemIds, kitId = null, grvId = null, note, userId }) {
  const emp = await employee(db, employeeId);
  if (!emp || !emp.is_active) throw new Fail("Choose an active employee.");
  const leaving = await exitBlock(emp.id, "advance", {}, db);
  if (leaving) throw new Fail(`${emp.name} is leaving — tools and assets are taken back, not issued.`, 409);
  if (!["permanent", "temporary"].includes(mode)) throw new Fail("Permanent or temporary?");
  if (mode === "temporary" && !DAY_RE.test(returnBy || "")) throw new Fail("A temporary issue needs a return-by date.");
  const ids = [...new Set((itemIds || []).map(Number).filter((x) => x > 0))];
  if (!ids.length) throw new Fail("Pick at least one item.");
  const { rows: items } = await db.query(`SELECT id, code, kind, status FROM tl_items WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
  if (items.length !== ids.length) throw new Fail("An item was not found.", 404);
  const assets = items.some((i) => i.kind === "asset");
  if (assets && items.some((i) => i.kind !== "asset")) throw new Fail("Issue personal assets separately from tools.");
  if (items.some((i) => IN_USE.includes(i.kind))) throw new Fail("Cube moulds and pump pipes are not issued to a person.");
  const busy = items.filter((i) => i.status !== "in_store");
  if (busy.length) throw new Fail(`Not in the store: ${busy.map((i) => i.code).join(", ")}.`, 409);
  const { rows } = await db.query(
    `INSERT INTO tl_issues (employee_id, mode, return_by, for_assets, kit_id, grv_id, note, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [emp.id, mode, mode === "temporary" ? returnBy : null, assets, kitId, grvId, txt(note, 500), userId]);
  const issueId = rows[0].id;
  for (const it of items) {
    await db.query(`INSERT INTO tl_issue_lines (issue_id, item_id) VALUES ($1,$2)`, [issueId, it.id]);
    await db.query(`UPDATE tl_items SET status = 'issue_pending' WHERE id = $1`, [it.id]);
    await logEvent(db, it.id, "issue_raised", `To ${emp.name} (${mode}) — waiting for approval`, userId);
  }
  return { id: issueId, assets, employee: emp.name, count: items.length };
}
function notifyIssue(out) {
  const who = out.assets ? "administrator" : "plant_in_charge";
  notifyRole(who, out.assets ? "Asset issue to approve" : "Tool issue to approve", `${out.count} item(s) for ${out.employee}`, out.assets ? "/hr?tab=assets" : "/maintenance-module?tab=tools");
}

// Called by the Maintenance GRV for every line whose store item is in a
// register category: one numbered item per unit, and — for tools, power tools
// and personal assets — an optional issue to a person in the same step.
export async function addFromGrv(db, { grvId, item, qty, rate, grvDate, issue, userId }) {
  const kind = CATEGORY_KIND[item.category];
  if (!kind) return null;
  if (!Number.isInteger(Number(qty)) || Number(qty) < 1) throw new Fail(`${item.name} goes on the register one by one — receive a whole number.`);
  const type = await typeForStoreItem(db, item, kind);
  const codes = await nextCodes(db, type.prefix, Number(qty));
  const status = IN_USE.includes(kind) ? "in_use" : "in_store";
  const location = kind === "cube_mould" ? "Plant lab" : kind === "pump_pipe" ? "Plant spare" : kind === "asset" ? null : "Tools store";
  const ids = [];
  for (const code of codes) {
    const { rows } = await db.query(
      `INSERT INTO tl_items (kind, type_id, code, status, location, source, grv_id, purchase_value, purchase_date, created_by)
       VALUES ($1,$2,$3,$4,$5,'grv',$6,$7,$8,$9) RETURNING id`,
      [kind, type.id, code, status, location, grvId, rate, grvDate, userId]);
    ids.push(rows[0].id);
    await logEvent(db, rows[0].id, "added", `From GRV-${String(grvId).padStart(4, "0")}`, userId);
  }
  let issued = null;
  if (issue && issue.employee_id && !IN_USE.includes(kind)) {
    issued = await createIssue(db, { employeeId: Number(issue.employee_id), mode: issue.mode || "permanent", returnBy: issue.return_by,
      itemIds: ids, grvId, note: `Issued from GRV-${String(grvId).padStart(4, "0")}`, userId });
  }
  return { kind, codes, issued };
}

// ------------------------------------------------------------------ meta ---
const ANY_VIEW = [["tools.register", "view"], ["tools.in-use", "view"], ["tools.kits", "view"], ["hr.assets", "view"], ["tools.issue", "view"],
  ["tools.approve", "edit"], ["tools.report-damage", "view"], ["tools.removal-approve", "edit"], ["tools.loss-decide", "edit"],
  ["hr.asset-approve", "edit"], ["mnt.grv", "create"]];

router.get("/meta", allow(ANY_VIEW), handle(async (req, res) => {
  const [types, kits, emps] = await Promise.all([
    query(`SELECT t.*, (SELECT count(*)::int FROM tl_items i WHERE i.type_id = t.id AND i.status NOT IN ('removed','lost','pending')) AS on_list
             FROM tl_types t ORDER BY t.kind, t.name`),
    query(`SELECT k.id, k.name, k.is_active,
                  COALESCE(json_agg(json_build_object('type_id', kt.type_id, 'qty', kt.qty, 'name', t.name) ORDER BY t.name) FILTER (WHERE kt.type_id IS NOT NULL), '[]') AS types
             FROM tl_kits k LEFT JOIN tl_kit_types kt ON kt.kit_id = k.id LEFT JOIN tl_types t ON t.id = kt.type_id
            GROUP BY k.id ORDER BY k.name`),
    query(`SELECT e.id, e.name, e.emp_code, e.designation, d.name AS department FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
            WHERE e.is_active ORDER BY e.name`),
  ]);
  res.json({ types: types.rows, kits: kits.rows, employees: emps.rows, places: PLACES, reasons: REASONS, kind_label: KIND_LABEL,
    category_kind: CATEGORY_KIND });
}));

// ----------------------------------------------------------------- items ---
async function kindsAllowed(user, wanted, action = "view") {
  const out = [];
  for (const k of wanted) if (await can(user, VIEW_KEY[k], action)) out.push(k);
  return out;
}
const ITEM_SQL = `
  SELECT i.*, to_char(i.purchase_date, 'YYYY-MM-DD') AS purchase_date, to_char(i.warranty_until, 'YYYY-MM-DD') AS warranty_until,
         t.name AS type_name, t.prefix, e.name AS employee_name, e.emp_code, e.designation AS employee_designation,
         iss.issue_id, iss.mode, to_char(iss.return_by, 'YYYY-MM-DD') AS return_by, iss.issue_status, iss.accepted_at, iss.line_id,
         rm.id AS removal_id, rm.reason AS removal_reason
    FROM tl_items i JOIN tl_types t ON t.id = i.type_id
    LEFT JOIN hr_employees e ON e.id = i.employee_id
    LEFT JOIN LATERAL (SELECT s.id AS issue_id, s.mode, s.return_by, s.status AS issue_status, s.accepted_at, l.id AS line_id
                         FROM tl_issue_lines l JOIN tl_issues s ON s.id = l.issue_id
                        WHERE l.item_id = i.id AND l.returned_at IS NULL AND s.status IN ('pending','approved')
                        ORDER BY s.id DESC LIMIT 1) iss ON true
    LEFT JOIN tl_removals rm ON rm.item_id = i.id AND rm.status = 'pending'`;

router.get("/items", allow(ANY_VIEW), handle(async (req, res) => {
  const group = String(req.query.group || "tools");
  const wanted = group === "assets" ? ["asset"] : group === "in-use" ? IN_USE : TOOLISH;
  let kinds = await kindsAllowed(req.user, wanted);
  // Someone who may only REPORT damage (Lab Technician, Site Supervisor …)
  // sees just the moulds / pipes / tools that can be reported, by ID.
  let reportOnly = false;
  if (!kinds.length && group !== "assets" && (await can(req.user, "tools.report-damage", "create"))) { kinds = wanted; reportOnly = true; }
  if (!kinds.length) return bad(res, "You don't have access to this.", 403);
  const showGone = req.query.all === "1" && !reportOnly;
  const { rows } = await query(`${ITEM_SQL} WHERE i.kind = ANY($1::text[]) ${showGone ? "" : "AND i.status NOT IN ('removed','lost')"}
    ${reportOnly ? "AND i.status IN ('in_store','in_use','at_site','repair')" : ""}
    ORDER BY i.kind, t.name, i.code LIMIT 3000`, [kinds]);
  if (reportOnly) return res.json({ items: rows.map((r) => ({ id: r.id, code: r.code, kind: r.kind, type_name: r.type_name, status: r.status, location: r.location })), report_only: true });
  res.json({ items: rows, today: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) });
}));

router.get("/items/:id(\\d+)", allow(ANY_VIEW.concat([["tools.my", "view"]])), handle(async (req, res) => {
  const { rows } = await query(`${ITEM_SQL} WHERE i.id = $1`, [req.params.id]);
  const it = rows[0];
  if (!it) return bad(res, "Not found.", 404);
  const mine = it.employee_id && (await query(`SELECT 1 FROM hr_employees WHERE id = $1 AND app_user_id = $2`, [it.employee_id, req.user.id])).rows.length;
  if (!mine && !(await can(req.user, VIEW_KEY[it.kind], "view")) && !(await can(req.user, "tools.report-damage", "view"))) return bad(res, "You don't have access to this.", 403);
  const [events, issues] = await Promise.all([
    query(`SELECT ev.*, u.name AS by_name FROM tl_events ev LEFT JOIN users u ON u.id = ev.created_by WHERE ev.item_id = $1 ORDER BY ev.created_at DESC, ev.id DESC LIMIT 200`, [it.id]),
    query(`SELECT s.id, s.mode, s.status, s.requested_at, s.decided_at, l.returned_at, l.return_condition, l.decision, l.recover_amount, e.name AS employee
             FROM tl_issue_lines l JOIN tl_issues s ON s.id = l.issue_id JOIN hr_employees e ON e.id = s.employee_id WHERE l.item_id = $1 ORDER BY s.id DESC`, [it.id]),
  ]);
  res.json({ ...it, events: events.rows, issues: issues.rows });
}));

router.post("/items/:id(\\d+)/edit", allow(ANY_VIEW), handle(async (req, res) => {
  const { rows } = await query(`SELECT * FROM tl_items WHERE id = $1`, [req.params.id]);
  const it = rows[0];
  if (!it) return bad(res, "Not found.", 404);
  await mustCan(req.user, VIEW_KEY[it.kind], "edit");
  const b = req.body || {};
  const details = b.details && typeof b.details === "object" ? Object.fromEntries(Object.entries(b.details).slice(0, 40).map(([k, v]) => [String(k).slice(0, 40), typeof v === "boolean" ? v : txt(v, 200)])) : it.details;
  await query(`UPDATE tl_items SET make_model = $1, serial_no = $2, details = $3, warranty_until = $4, purchase_value = $5, condition_note = $6 WHERE id = $7`,
    [txt(b.make_model, 150), txt(b.serial_no, 80), JSON.stringify(details || {}), DAY_RE.test(b.warranty_until || "") ? b.warranty_until : null,
      num(b.purchase_value), txt(b.condition_note), it.id]);
  await logEvent({ query }, it.id, "edited", "Details changed", req.user.id);
  res.json({ ok: true });
}));

// Back from repair → the store (or the list, for a mould / pipe).
router.post("/items/:id(\\d+)/repaired", allow(ANY_VIEW), handle(async (req, res) => {
  const { rows } = await query(`SELECT * FROM tl_items WHERE id = $1`, [req.params.id]);
  const it = rows[0];
  if (!it) return bad(res, "Not found.", 404);
  await mustCan(req.user, VIEW_KEY[it.kind], "edit");
  if (it.status !== "repair") return bad(res, "This item is not at repair.", 409);
  await query(`UPDATE tl_items SET status = $1, since = now() WHERE id = $2`, [IN_USE.includes(it.kind) ? "in_use" : "in_store", it.id]);
  await logEvent({ query }, it.id, "repaired", txt(req.body?.note) || "Back from repair", req.user.id);
  res.json({ ok: true });
}));

// ------------------------------------------- add existing list / assets ---
// rows: [{ type_id, qty, location, make_model, serial_no, condition_note, codes: "CM-101, CM-102" }]
router.post("/items/add", allow(ANY_VIEW), handle(async (req, res) => {
  const b = req.body || {};
  const rowsIn = Array.isArray(b.rows) ? b.rows.slice(0, 200) : [];
  if (!rowsIn.length) return bad(res, "Add at least one row.");
  const out = await tx(async (c) => {
    const typeIds = [...new Set(rowsIn.map((r) => Number(r.type_id)))];
    const { rows: types } = await c.query(`SELECT * FROM tl_types WHERE id = ANY($1::int[]) AND is_active`, [typeIds]);
    if (types.length !== typeIds.length) throw new Fail("Choose the item type on every row.");
    const kinds = [...new Set(types.map((t) => t.kind))];
    const assets = kinds.includes("asset");
    if (assets && kinds.length > 1) throw new Fail("Add personal assets on their own.");
    for (const k of kinds) await mustCan(req.user, VIEW_KEY[k], "create");
    // Personal assets: the Administrator adds them straight away. Everything
    // else is a list the Plant In Charge confirms before it counts.
    let batchId = null;
    if (!assets) {
      const { rows: prev } = await c.query(`SELECT 1 FROM tl_batches bb JOIN tl_items i ON i.batch_id = bb.id WHERE bb.status = 'confirmed' AND i.kind = ANY($1::text[]) LIMIT 1`, [kinds]);
      const { rows: bt } = await c.query(`INSERT INTO tl_batches (is_opening, note, created_by) VALUES ($1,$2,$3) RETURNING id`, [!prev.length, txt(b.note, 500), req.user.id]);
      batchId = bt[0].id;
    }
    const byId = new Map(types.map((t) => [t.id, t]));
    const created = [];
    for (const r of rowsIn) {
      const t = byId.get(Number(r.type_id));
      const own = String(r.codes || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      const qty = own.length || Number(r.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 500) throw new Fail(`How many ${t.name}? (1 to 500)`);
      if (own.some((x) => !/^[A-Z]{1,6}-\d{1,5}$/.test(x))) throw new Fail("Your own IDs must look like CM-041.");
      if (own.length) {
        const { rows: taken } = await c.query(`SELECT code FROM tl_items WHERE code = ANY($1::text[])`, [own]);
        if (taken.length) throw new Fail(`Already on the list: ${taken.map((x) => x.code).join(", ")}.`, 409);
      }
      const codes = own.length ? own : await nextCodes(c, t.prefix, qty);
      const location = IN_USE.includes(t.kind) ? (txt(r.location, 150) || (t.kind === "cube_mould" ? "Plant lab" : "Plant spare")) : t.kind === "asset" ? txt(r.location, 150) : "Tools store";
      const atSite = IN_USE.includes(t.kind) && !PLACES.includes(location);
      for (const code of codes) {
        const { rows: ins } = await c.query(
          `INSERT INTO tl_items (kind, type_id, code, make_model, serial_no, details, status, location, source, batch_id, purchase_value, purchase_date, warranty_until, condition_note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [t.kind, t.id, code, txt(r.make_model, 150), qty === 1 ? txt(r.serial_no, 80) : null, JSON.stringify(r.details && typeof r.details === "object" ? r.details : {}),
            assets ? "in_store" : "pending", location, assets ? "added" : "opening", batchId, num(r.purchase_value) ?? t.value,
            DAY_RE.test(r.purchase_date || "") ? r.purchase_date : null, DAY_RE.test(r.warranty_until || "") ? r.warranty_until : null,
            txt(r.condition_note), req.user.id]);
        await logEvent(c, ins[0].id, "added", assets ? "Added to the register" : `On ${atSite ? "an" : "the"} existing list — waiting for the Plant In Charge`, req.user.id);
        created.push(code);
      }
    }
    return { batch_id: batchId, codes: created, assets };
  });
  if (out.batch_id) notifyRole("plant_in_charge", "List to confirm", `${out.codes.length} item(s) to confirm on the tools / moulds & pipes list`, "/maintenance-module?tab=tools");
  res.status(201).json(out);
}));

router.get("/batches", allow([["tools.register", "view"], ["tools.in-use", "view"], ["tools.removal-approve", "edit"]]), handle(async (req, res) => {
  const { rows } = await query(
    `SELECT bb.*, u.name AS created_by_name, du.name AS decided_by_name,
            (SELECT json_agg(json_build_object('type', x.name, 'kind', x.kind, 'n', x.n, 'first', x.first, 'last', x.last, 'places', x.places) ORDER BY x.name)
               FROM (SELECT t.name, t.kind, count(*)::int AS n, min(i.code) AS first, max(i.code) AS last, string_agg(DISTINCT i.location, ', ') AS places
                       FROM tl_items i JOIN tl_types t ON t.id = i.type_id WHERE i.batch_id = bb.id GROUP BY t.name, t.kind) x) AS lines
       FROM tl_batches bb LEFT JOIN users u ON u.id = bb.created_by LEFT JOIN users du ON du.id = bb.decided_by
      ORDER BY (bb.status = 'pending') DESC, bb.id DESC LIMIT 50`);
  res.json(rows);
}));

router.post("/batches/:id(\\d+)/decide", allow([["tools.removal-approve", "edit"]]), handle(async (req, res) => {
  const confirm = req.body?.action === "confirm";
  if (!confirm && req.body?.action !== "reject") return bad(res, "Confirm or reject.");
  if (!confirm && !txt(req.body?.note)) return bad(res, "Say why it is rejected.");
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM tl_batches WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows[0]) throw new Fail("Not found.", 404);
    if (rows[0].status !== "pending") throw new Fail("Already decided.", 409);
    await c.query(`UPDATE tl_batches SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4`,
      [confirm ? "confirmed" : "rejected", req.user.id, txt(req.body?.note), rows[0].id]);
    if (confirm) {
      await c.query(`UPDATE tl_items SET status = CASE WHEN kind IN ('cube_mould','pump_pipe') THEN
                        (CASE WHEN location = ANY($2::text[]) THEN 'in_use' ELSE 'at_site' END) ELSE 'in_store' END, since = now()
                      WHERE batch_id = $1 AND status = 'pending'`, [rows[0].id, PLACES]);
      await c.query(`INSERT INTO tl_events (item_id, event, note, created_by) SELECT id, 'confirmed', 'List confirmed', $2 FROM tl_items WHERE batch_id = $1`, [rows[0].id, req.user.id]);
    } else {
      // Never counted, so nothing to keep: the IDs are free again.
      await c.query(`DELETE FROM tl_items WHERE batch_id = $1 AND status = 'pending'`, [rows[0].id]);
    }
  });
  res.json({ ok: true });
}));

// ----------------------------------------------------------- types & kits ---
router.post("/types", allow([["tools.kits", "create"], ["hr.assets", "create"], ["tools.in-use", "create"]]), handle(async (req, res) => {
  const b = req.body || {};
  if (!KINDS.includes(b.kind)) return bad(res, "Choose what kind of item it is.");
  await mustCan(req.user, b.kind === "asset" ? "hr.assets" : IN_USE.includes(b.kind) ? "tools.in-use" : "tools.kits", "create");
  const name = txt(b.name, 150);
  if (!name) return bad(res, "Name it.");
  const prefix = String(b.prefix || DEFAULT_PREFIX[b.kind]).trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(prefix)) return bad(res, "The ID prefix is 1 to 6 letters, e.g. CM.");
  try {
    const { rows } = await query(`INSERT INTO tl_types (kind, name, prefix, value, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.kind, name, prefix, num(b.value), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return bad(res, "That item is already on the list.", 409);
    throw e;
  }
}));

router.patch("/types/:id(\\d+)", allow([["tools.kits", "edit"], ["hr.assets", "edit"], ["tools.in-use", "edit"]]), handle(async (req, res) => {
  const { rows } = await query(`SELECT * FROM tl_types WHERE id = $1`, [req.params.id]);
  const t = rows[0];
  if (!t) return bad(res, "Not found.", 404);
  await mustCan(req.user, t.kind === "asset" ? "hr.assets" : IN_USE.includes(t.kind) ? "tools.in-use" : "tools.kits", "edit");
  const b = req.body || {};
  const prefix = b.prefix ? String(b.prefix).trim().toUpperCase() : t.prefix;
  if (!/^[A-Z]{1,6}$/.test(prefix)) return bad(res, "The ID prefix is 1 to 6 letters.");
  try {
    await query(`UPDATE tl_types SET name = $1, prefix = $2, value = $3, is_active = $4 WHERE id = $5`,
      [txt(b.name, 150) || t.name, prefix, b.value === undefined ? t.value : num(b.value), b.is_active === undefined ? t.is_active : !!b.is_active, t.id]);
  } catch (e) {
    if (e.code === "23505") return bad(res, "Another item has that name.", 409);
    throw e;
  }
  res.json({ ok: true });
}));

router.post("/kits", allow([["tools.kits", "create"]]), handle(async (req, res) => {
  const name = txt(req.body?.name, 80);
  if (!name) return bad(res, "Name the kit.");
  try {
    const { rows } = await query(`INSERT INTO tl_kits (name, created_by) VALUES ($1,$2) RETURNING id`, [name, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { if (e.code === "23505") return bad(res, "A kit with that name exists.", 409); throw e; }
}));

router.put("/kits/:id(\\d+)", allow([["tools.kits", "edit"]]), handle(async (req, res) => {
  const b = req.body || {};
  const lines = (Array.isArray(b.types) ? b.types : []).map((l) => ({ type_id: Number(l.type_id), qty: Number(l.qty) || 1 })).filter((l) => l.type_id > 0 && l.qty > 0 && l.qty < 100);
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM tl_kits WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new Fail("Not found.", 404);
    await c.query(`UPDATE tl_kits SET name = COALESCE($1, name), is_active = COALESCE($2, is_active) WHERE id = $3`,
      [txt(b.name, 80), b.is_active === undefined ? null : !!b.is_active, rows[0].id]);
    if (Array.isArray(b.types)) {
      await c.query(`DELETE FROM tl_kit_types WHERE kit_id = $1`, [rows[0].id]);
      for (const l of lines) await c.query(`INSERT INTO tl_kit_types (kit_id, type_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [rows[0].id, l.type_id, l.qty]);
    }
  });
  res.json({ ok: true });
}));

// What a kit would issue from the store now: items in store per type, and
// what is short (to buy).
router.get("/kits/:id(\\d+)/pick", allow([["tools.issue", "create"]]), handle(async (req, res) => {
  const { rows } = await query(
    `SELECT kt.type_id, kt.qty, t.name,
            (SELECT COALESCE(json_agg(json_build_object('id', i.id, 'code', i.code) ORDER BY i.code), '[]') FROM
               (SELECT id, code FROM tl_items WHERE type_id = kt.type_id AND status = 'in_store' ORDER BY code LIMIT kt.qty) i) AS items
       FROM tl_kit_types kt JOIN tl_types t ON t.id = kt.type_id WHERE kt.kit_id = $1 ORDER BY t.name`, [req.params.id]);
  res.json(rows.map((r) => ({ ...r, short: Math.max(0, r.qty - r.items.length) })));
}));

// ---------------------------------------------------------------- issues ---
router.post("/issues", allow([["tools.issue", "create"], ["hr.assets", "create"]]), handle(async (req, res) => {
  const b = req.body || {};
  const ids = (b.item_ids || []).map(Number);
  const { rows: k } = await query(`SELECT DISTINCT kind FROM tl_items WHERE id = ANY($1::int[])`, [ids]);
  await mustCan(req.user, issueKey(k.some((x) => x.kind === "asset")), "create");
  const out = await tx((c) => createIssue(c, { employeeId: Number(b.employee_id), mode: b.mode, returnBy: b.return_by, itemIds: ids,
    kitId: Number(b.kit_id) || null, note: b.note, userId: req.user.id }));
  notifyIssue(out);
  res.status(201).json(out);
}));

const ISSUE_SQL = `
  SELECT s.*, to_char(s.return_by, 'YYYY-MM-DD') AS return_by, e.name AS employee, e.emp_code, e.designation, k.name AS kit_name,
         ru.name AS requested_by_name, du.name AS decided_by_name,
         (SELECT json_agg(json_build_object('line_id', l.id, 'item_id', i.id, 'code', i.code, 'name', t.name, 'kind', i.kind, 'serial_no', i.serial_no,
                   'returned_at', l.returned_at, 'return_condition', l.return_condition, 'decision', l.decision) ORDER BY i.code)
            FROM tl_issue_lines l JOIN tl_items i ON i.id = l.item_id JOIN tl_types t ON t.id = i.type_id WHERE l.issue_id = s.id) AS lines
    FROM tl_issues s JOIN hr_employees e ON e.id = s.employee_id LEFT JOIN tl_kits k ON k.id = s.kit_id
    LEFT JOIN users ru ON ru.id = s.requested_by LEFT JOIN users du ON du.id = s.decided_by`;

router.get("/issues", allow([["tools.issue", "view"], ["tools.approve", "edit"], ["hr.assets", "view"], ["hr.asset-approve", "edit"]]), handle(async (req, res) => {
  const assets = req.query.assets === "1";
  if (!(await canAny(req.user, assets ? [["hr.assets", "view"], ["hr.asset-approve", "edit"]] : [["tools.issue", "view"], ["tools.approve", "edit"]]))) {
    return bad(res, "You don't have access to this.", 403);
  }
  const { rows } = await query(`${ISSUE_SQL} WHERE s.for_assets = $1 AND (s.status = 'pending' OR s.requested_at > now() - interval '45 days')
    ORDER BY (s.status = 'pending') DESC, s.id DESC LIMIT 200`, [assets]);
  res.json(rows);
}));

router.post("/issues/:id(\\d+)/decide", allow([["tools.approve", "edit"], ["hr.asset-approve", "edit"]]), handle(async (req, res) => {
  const approve = req.body?.action === "approve";
  if (!approve && req.body?.action !== "reject") return bad(res, "Approve or reject.");
  const out = await tx(async (c) => {
    const { rows } = await c.query(`SELECT s.*, e.name, e.app_user_id FROM tl_issues s JOIN hr_employees e ON e.id = s.employee_id WHERE s.id = $1 FOR UPDATE OF s`, [req.params.id]);
    const s = rows[0];
    if (!s) throw new Fail("Not found.", 404);
    await mustCan(req.user, approveKey(s.for_assets), "edit");
    if (s.status !== "pending") throw new Fail("This issue has already been decided.", 409);
    if (!approve && !txt(req.body?.note)) throw new Fail("Say why it is rejected.");
    await c.query(`UPDATE tl_issues SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4`,
      [approve ? "approved" : "rejected", req.user.id, txt(req.body?.note), s.id]);
    const { rows: items } = await c.query(`SELECT item_id FROM tl_issue_lines WHERE issue_id = $1`, [s.id]);
    for (const { item_id } of items) {
      if (approve) await c.query(`UPDATE tl_items SET status = 'issued', employee_id = $1, since = now(), location = NULL WHERE id = $2`, [s.employee_id, item_id]);
      else await c.query(`UPDATE tl_items SET status = 'in_store' WHERE id = $1 AND status = 'issue_pending'`, [item_id]);
      await logEvent(c, item_id, approve ? "issued" : "issue_rejected", approve ? `To ${s.name} (${s.mode})` : `Rejected: ${txt(req.body?.note)}`, req.user.id);
    }
    return s;
  });
  if (approve && out.app_user_id) pushToUser(out.app_user_id, { title: "Please check and accept", body: "Tools / assets have been issued to you.", url: "/my-tools" }).catch(() => {});
  res.json({ ok: true });
}));

router.post("/issues/:id(\\d+)/cancel", allow([["tools.issue", "create"], ["hr.assets", "create"]]), handle(async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM tl_issues WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const s = rows[0];
    if (!s) throw new Fail("Not found.", 404);
    await mustCan(req.user, issueKey(s.for_assets), "create");
    if (s.status !== "pending") throw new Fail("Only an issue still waiting for approval can be cancelled.", 409);
    await c.query(`UPDATE tl_issues SET status = 'cancelled' WHERE id = $1`, [s.id]);
    await c.query(`UPDATE tl_items SET status = 'in_store' WHERE status = 'issue_pending' AND id IN (SELECT item_id FROM tl_issue_lines WHERE issue_id = $1)`, [s.id]);
  });
  res.json({ ok: true });
}));

// Take back, line by line. Good → the store. Damaged / lost → the
// Administrator decides (no charge, repair, recover from salary).
router.post("/lines/:id(\\d+)/return", allow([["tools.issue", "edit"], ["hr.assets", "edit"]]), handle(async (req, res) => {
  const cond = req.body?.condition;
  if (!["good", "damaged", "lost"].includes(cond)) return bad(res, "Good, damaged or lost?");
  if (cond !== "good" && !txt(req.body?.note)) return bad(res, "Say what happened.");
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT l.*, s.for_assets, s.status AS issue_status, i.kind, i.code, e.name FROM tl_issue_lines l JOIN tl_issues s ON s.id = l.issue_id
         JOIN tl_items i ON i.id = l.item_id JOIN hr_employees e ON e.id = s.employee_id WHERE l.id = $1 FOR UPDATE OF l`, [req.params.id]);
    const l = rows[0];
    if (!l) throw new Fail("Not found.", 404);
    await mustCan(req.user, issueKey(l.for_assets), "edit");
    if (l.issue_status !== "approved") throw new Fail("This issue is not with the employee.", 409);
    if (l.returned_at) throw new Fail("Already taken back.", 409);
    await c.query(`UPDATE tl_issue_lines SET returned_at = now(), returned_by = $1, return_condition = $2, return_note = $3 WHERE id = $4`,
      [req.user.id, cond, txt(req.body?.note), l.id]);
    const status = cond === "good" ? "in_store" : cond === "lost" ? "lost" : "repair";
    await c.query(`UPDATE tl_items SET status = $1, employee_id = NULL, since = now(), location = $2, condition_note = COALESCE($3, condition_note) WHERE id = $4`,
      [status, cond === "good" && !l.for_assets ? "Tools store" : null, cond === "good" ? null : txt(req.body?.note), l.item_id]);
    await logEvent(c, l.item_id, "returned", `From ${l.name} — ${cond}${txt(req.body?.note) ? `: ${txt(req.body?.note)}` : ""}`, req.user.id);
    return { ...l, cond };
  });
  if (out.cond !== "good") notifyRole("administrator", `${out.code} ${out.cond}`, `Returned ${out.cond} by ${out.name} — decide: no charge, repair or recover`, out.for_assets ? "/hr?tab=assets" : "/maintenance-module?tab=tools");
  res.json({ ok: true });
}));

router.get("/decisions", allow([["tools.loss-decide", "edit"], ["tools.issue", "view"], ["hr.assets", "view"]]), handle(async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.return_condition, l.return_note, l.returned_at, l.decision, l.recover_amount, l.recover_month, l.decided_at, du.name AS decided_by_name,
            i.code, i.kind, t.name, i.purchase_value, e.id AS employee_id, e.name AS employee, ru.name AS returned_by_name, s.for_assets
       FROM tl_issue_lines l JOIN tl_issues s ON s.id = l.issue_id JOIN tl_items i ON i.id = l.item_id JOIN tl_types t ON t.id = i.type_id
       JOIN hr_employees e ON e.id = s.employee_id LEFT JOIN users ru ON ru.id = l.returned_by LEFT JOIN users du ON du.id = l.decided_by
      WHERE l.return_condition IN ('damaged','lost') AND (l.decision IS NULL OR l.decided_at > now() - interval '60 days')
      ORDER BY (l.decision IS NULL) DESC, l.returned_at DESC LIMIT 100`);
  res.json(rows);
}));

router.post("/lines/:id(\\d+)/decide", allow([["tools.loss-decide", "edit"]]), handle(async (req, res) => {
  const b = req.body || {};
  if (!["no_charge", "repair", "recover"].includes(b.decision)) return bad(res, "No charge, repair or recover?");
  const amount = b.decision === "recover" ? num(b.amount) : null;
  if (b.decision === "recover" && !(amount > 0)) return bad(res, "How much is recovered from salary?");
  if (b.decision === "recover" && !MONTH_RE.test(b.month || "")) return bad(res, "From which month's salary?");
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT l.*, i.kind, i.status AS item_status, s.employee_id FROM tl_issue_lines l JOIN tl_items i ON i.id = l.item_id
      JOIN tl_issues s ON s.id = l.issue_id WHERE l.id = $1 FOR UPDATE OF l`, [req.params.id]);
    const l = rows[0];
    if (!l) throw new Fail("Not found.", 404);
    if (!["damaged", "lost"].includes(l.return_condition)) throw new Fail("Only a damaged or lost item needs a decision.", 409);
    if (l.decision) throw new Fail("Already decided.", 409);
    if (b.decision === "recover") {
      const { rows: lk } = await c.query(`SELECT status FROM hr_payroll_runs WHERE month = $1`, [b.month]);
      if (lk[0]?.status === "locked") throw new Fail(`Payroll for ${b.month} is locked — choose a later month.`, 409);
    }
    await c.query(`UPDATE tl_issue_lines SET decision = $1, recover_amount = $2, recover_month = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE id = $6`,
      [b.decision, amount, b.decision === "recover" ? b.month : null, req.user.id, txt(b.note), l.id]);
    // A damaged item: repair keeps it at repair; otherwise back to the store,
    // or off the list when written off. A lost item stays lost.
    if (l.return_condition === "damaged" && l.item_status === "repair") {
      const next = b.write_off ? "removed" : b.decision === "repair" ? "repair" : "in_store";
      await c.query(`UPDATE tl_items SET status = $1, location = $2, since = now() WHERE id = $3`, [next, next === "in_store" && l.kind !== "asset" ? "Tools store" : null, l.item_id]);
    }
    await logEvent(c, l.item_id, "decided", b.decision === "recover" ? `Recover ₹${amount} from ${b.month} salary` : b.decision === "repair" ? "Repair at company cost" : "No charge", req.user.id);
  });
  res.json({ ok: true });
}));

// ------------------------------------------- cube moulds & pipes: moving ---
router.post("/items/move", allow([["tools.in-use", "edit"]]), handle(async (req, res) => {
  const ids = (req.body?.item_ids || []).map(Number).filter((x) => x > 0);
  const place = txt(req.body?.location, 150);
  if (!ids.length) return bad(res, "Pick the items to move.");
  if (!place) return bad(res, "Where to?");
  const atSite = !PLACES.includes(place);
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT id, code, kind, status, location FROM tl_items WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
    const wrong = rows.filter((r) => !IN_USE.includes(r.kind) || !["in_use", "at_site"].includes(r.status));
    if (wrong.length) throw new Fail(`Cannot move: ${wrong.map((r) => r.code).join(", ")}.`, 409);
    for (const r of rows) {
      await c.query(`UPDATE tl_items SET location = $1, status = $2, since = now(), cast_ref = $3 WHERE id = $4`,
        [place, atSite ? "at_site" : "in_use", atSite ? txt(req.body?.cast_ref, 150) : null, r.id]);
      await logEvent(c, r.id, "moved", `${r.location || "—"} → ${place}${txt(req.body?.cast_ref) ? ` · ${txt(req.body?.cast_ref)}` : ""}`, req.user.id);
    }
  });
  res.json({ ok: true });
}));

// Cube casting: the moulds used go to the site (called from the Lab
// Technician's site cast). Codes are checked before anything is written.
export async function mouldsToSite(db, codesText, place, ref, userId) {
  const codes = [...new Set(String(codesText || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) return [];
  const { rows } = await db.query(`SELECT id, code, status, kind FROM tl_items WHERE code = ANY($1::text[]) AND kind = 'cube_mould'`, [codes]);
  const found = new Set(rows.map((r) => r.code));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length) throw new Fail(`Not on the cube mould list: ${missing.join(", ")}.`);
  const busy = rows.filter((r) => !["in_use", "at_site"].includes(r.status));
  if (busy.length) throw new Fail(`Not in use: ${busy.map((r) => r.code).join(", ")}.`, 409);
  for (const r of rows) {
    await db.query(`UPDATE tl_items SET location = $1, status = 'at_site', cast_ref = $2, since = now() WHERE id = $3`, [place.slice(0, 150), ref.slice(0, 150), r.id]);
    await logEvent(db, r.id, "cast", `${ref} · at ${place}`, userId);
  }
  return codes;
}

// -------------------------------------------------------------- removals ---
router.post("/removals", allow([["tools.report-damage", "create"]]), handle(async (req, res) => {
  const b = req.body || {};
  const ids = (b.item_ids || []).map(Number).filter((x) => x > 0);
  if (!ids.length) return bad(res, "Pick the item(s).");
  const reason = txt(b.reason, 40);
  if (!reason) return bad(res, "What happened?");
  const lost = reason === "Lost" || !!b.is_lost;
  const photo = b.photo ? String(b.photo) : null;
  if (photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 2_500_000)) return bad(res, "The photo must be a JPEG / PNG under 2 MB.");
  if (!photo && !lost) return bad(res, "Add a photo of the damage.");
  const out = await tx(async (c) => {
    const { rows } = await c.query(`SELECT id, code, kind, status FROM tl_items WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
    const wrong = rows.filter((r) => !["in_store", "in_use", "at_site", "repair"].includes(r.status));
    if (wrong.length) throw new Fail(`${wrong.map((r) => r.code).join(", ")} cannot be reported here${wrong.some((r) => r.status === "issued") ? " — an issued item is taken back by Store with its condition" : ""}.`, 409);
    for (const r of rows) {
      await c.query(`INSERT INTO tl_removals (item_id, reason, note, photo, scrap, is_lost, prev_status, reported_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.id, reason, txt(b.note, 500), photo, !!b.scrap, lost, r.status, req.user.id]);
      await c.query(`UPDATE tl_items SET status = 'removal_pending' WHERE id = $1`, [r.id]);
      await logEvent(c, r.id, "reported", `${reason}${txt(b.note) ? `: ${txt(b.note)}` : ""} — removal pending`, req.user.id);
    }
    return { codes: rows.map((r) => r.code), lost };
  });
  notifyRole(out.lost ? "administrator" : "plant_in_charge", "Removal to approve", `${out.codes.join(", ")} reported ${out.lost ? "lost" : "damaged"}`, "/maintenance-module?tab=in-use");
  res.status(201).json(out);
}));

router.get("/removals", allow([["tools.removal-approve", "edit"], ["tools.loss-decide", "edit"], ["tools.in-use", "view"], ["tools.register", "view"], ["tools.report-damage", "view"], ["hr.assets", "view"]]), handle(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.item_id, r.reason, r.note, r.scrap, r.is_lost, r.status, r.reported_at, r.decided_at, r.decision_note, (r.photo IS NOT NULL) AS has_photo,
            i.code, i.kind, i.location, t.name, ru.name AS reported_by_name, du.name AS decided_by_name
       FROM tl_removals r JOIN tl_items i ON i.id = r.item_id JOIN tl_types t ON t.id = i.type_id
       LEFT JOIN users ru ON ru.id = r.reported_by LEFT JOIN users du ON du.id = r.decided_by
      WHERE r.status = 'pending' OR r.decided_at > now() - interval '60 days'
      ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 200`);
  res.json(rows);
}));

router.get("/removals/:id(\\d+)/photo", allow([["tools.removal-approve", "edit"], ["tools.loss-decide", "edit"], ["tools.in-use", "view"], ["tools.register", "view"], ["tools.report-damage", "view"]]), handle(async (req, res) => {
  const { rows } = await query(`SELECT photo FROM tl_removals WHERE id = $1`, [req.params.id]);
  res.json({ photo: rows[0]?.photo || null });
}));

router.post("/removals/:id(\\d+)/decide", allow([["tools.removal-approve", "edit"], ["tools.loss-decide", "edit"]]), handle(async (req, res) => {
  const approve = req.body?.action === "approve";
  if (!approve && req.body?.action !== "reject") return bad(res, "Approve or reject.");
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM tl_removals WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const r = rows[0];
    if (!r) throw new Fail("Not found.", 404);
    if (r.status !== "pending") throw new Fail("Already decided.", 409);
    await mustCan(req.user, r.is_lost ? "tools.loss-decide" : "tools.removal-approve", "edit",
      r.is_lost ? "A lost item's removal is approved by the Administrator." : "Only the Plant In Charge approves a removal.");
    if (r.reported_by === req.user.id && req.user.role !== "administrator" && req.user.role !== "super_admin") throw new Fail("You reported this one — someone else approves it.", 403);
    await c.query(`UPDATE tl_removals SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4`,
      [approve ? "approved" : "rejected", req.user.id, txt(req.body?.note), r.id]);
    await c.query(`UPDATE tl_items SET status = $1, since = now() WHERE id = $2`, [approve ? (r.is_lost ? "lost" : "removed") : (r.prev_status || "in_use"), r.item_id]);
    await logEvent(c, r.item_id, approve ? "removed" : "removal_rejected", approve ? `Removed — ${r.reason}${r.scrap ? " (kept for scrap)" : ""}` : `Removal rejected${txt(req.body?.note) ? `: ${txt(req.body?.note)}` : ""}`, req.user.id);
  });
  res.json({ ok: true });
}));

router.get("/history", allow([["tools.in-use", "view"], ["tools.register", "view"], ["hr.assets", "view"]]), handle(async (req, res) => {
  const group = String(req.query.group || "in-use");
  const kinds = await kindsAllowed(req.user, group === "assets" ? ["asset"] : group === "tools" ? TOOLISH : IN_USE);
  const { rows } = await query(
    `SELECT ev.event, ev.note, ev.created_at, i.code, t.name, u.name AS by_name FROM tl_events ev JOIN tl_items i ON i.id = ev.item_id
       JOIN tl_types t ON t.id = i.type_id LEFT JOIN users u ON u.id = ev.created_by
      WHERE i.kind = ANY($1::text[]) ORDER BY ev.created_at DESC, ev.id DESC LIMIT 60`, [kinds]);
  res.json(rows);
}));

// --------------------------------------------------------------------- my ---
router.get("/my", allow([["tools.my", "view"]]), handle(async (req, res) => {
  const { rows: e } = await query(`SELECT id, name, emp_code, designation FROM hr_employees WHERE app_user_id = $1 AND is_active ORDER BY id LIMIT 1`, [req.user.id]);
  if (!e[0]) return res.json({ employee: null, items: [], to_accept: [], waiting: [] });
  const [items, toAccept, waiting] = await Promise.all([
    query(`${ITEM_SQL} WHERE i.employee_id = $1 AND i.status = 'issued' ORDER BY i.kind, i.code`, [e[0].id]),
    query(`${ISSUE_SQL} WHERE s.employee_id = $1 AND s.status = 'approved' AND s.accepted_at IS NULL ORDER BY s.id`, [e[0].id]),
    query(`${ISSUE_SQL} WHERE s.employee_id = $1 AND s.status = 'pending' ORDER BY s.id`, [e[0].id]),
  ]);
  res.json({ employee: e[0], items: items.rows, to_accept: toAccept.rows, waiting: waiting.rows });
}));

router.post("/issues/:id(\\d+)/accept", allow([["tools.my", "edit"]]), handle(async (req, res) => {
  const missing = txt(req.body?.missing, 300);
  const { rows } = await query(`SELECT s.*, e.name FROM tl_issues s JOIN hr_employees e ON e.id = s.employee_id WHERE s.id = $1 AND e.app_user_id = $2`, [req.params.id, req.user.id]);
  const s = rows[0];
  if (!s) return bad(res, "Not found.", 404);
  if (s.status !== "approved" || s.accepted_at) return bad(res, "Nothing to accept here.", 409);
  await query(`UPDATE tl_issues SET accepted_at = now(), accept_note = $1 WHERE id = $2`, [missing, s.id]);
  if (missing) notifyRole("store", "Something missing", `${s.name}: ${missing}`, s.for_assets ? "/hr?tab=assets" : "/maintenance-module?tab=tools");
  res.json({ ok: true });
}));

router.post("/my/report", allow([["tools.my", "edit"]]), handle(async (req, res) => {
  const note = txt(req.body?.note, 300);
  const itemId = Number(req.body?.item_id);
  if (!note) return bad(res, "Say what happened.");
  const { rows } = await query(`SELECT i.id, i.code, i.kind, e.name FROM tl_items i JOIN hr_employees e ON e.id = i.employee_id WHERE i.id = $1 AND e.app_user_id = $2 AND i.status = 'issued'`, [itemId, req.user.id]);
  if (!rows[0]) return bad(res, "That item is not with you.", 404);
  await logEvent({ query }, rows[0].id, "employee_report", note, req.user.id);
  notifyRole(rows[0].kind === "asset" ? "administrator" : "store", `${rows[0].code}: problem reported`, `${rows[0].name}: ${note}`, rows[0].kind === "asset" ? "/hr?tab=assets" : "/maintenance-module?tab=tools");
  res.json({ ok: true });
}));

// ---------------------------------------- held items (exit clearance) ---
export async function heldBy(employeeId, db = { query }) {
  await ensureRound264();
  const { rows } = await db.query(
    `SELECT i.code, i.kind, t.name, i.status FROM tl_items i JOIN tl_types t ON t.id = i.type_id
      WHERE i.employee_id = $1 AND i.status = 'issued'
     UNION ALL
     SELECT i.code, i.kind, t.name, 'issue_pending' FROM tl_issue_lines l JOIN tl_issues s ON s.id = l.issue_id JOIN tl_items i ON i.id = l.item_id
       JOIN tl_types t ON t.id = i.type_id WHERE s.employee_id = $1 AND s.status = 'pending'`, [employeeId]);
  return rows;
}

export default router;
