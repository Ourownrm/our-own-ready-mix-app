// Round 249 — HR: PPE and employee exits (owner, 28 Oct 2026).
//
// PPE: "PPE issued to an employee record is required and a request >> approval
// process for PPE".
//   GET  /api/hr/ppe                        items, requests, issues (filters), per-employee holdings
//   POST /api/hr/ppe/items                  add an item          (hr.settings · create)
//   PATCH /api/hr/ppe/items/:id             change an item       (hr.settings · edit)
//   POST /api/hr/ppe/requests               raise for employees  (hr.ppe · create)
//   POST /api/hr/my/ppe-request             raise for oneself    (any signed-in employee)
//   POST /api/hr/ppe/requests/:id/decide    approve / reject     (hr.ppe-approve · edit)
//   POST /api/hr/ppe/requests/:id/cancel    the raiser, or hr.ppe · delete
//   POST /api/hr/ppe/issues                 issue (from an approved request, or direct) (hr.ppe · edit)
//   POST /api/hr/ppe/issues/:id/return      returned             (hr.ppe · edit)
//   DELETE /api/hr/ppe/issues/:id           wrong entry          (hr.ppe · delete)
// Exits: see lib/hrExit.js.
//   GET  /api/hr/exits                      list, with the clearance picture
//   POST /api/hr/exits                      raise                (hr.exit · create)
//   POST /api/hr/exits/:id/decide           approve / reject     (hr.exit-approve · edit)
//   POST /api/hr/exits/:id/complete         complete             (hr.exit-approve · edit)
//   POST /api/hr/exits/:id/cancel           cancel (raiser or approver) — before completion
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { ensureExit, exitBlock } from "../lib/hrExit.js";
import { istDay } from "../lib/istDate.js";
import { clearUserCache } from "../middleware/auth.js";
import { clearPermissionCache } from "../lib/permissions.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureExit(); next(); } catch (e) { next(e); } });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const txt = (v, n) => (String(v ?? "").trim().slice(0, n) || null);
const REASONS = ["new", "worn_out", "damaged", "lost"];
const KINDS = ["resignation", "termination", "retirement", "contract_end", "absconding", "death", "other"];
async function anyOf(user, pairs) { for (const [k, a] of pairs) if (await can(user, k, a)) return true; return false; }
// A light list of employees for the pickers (no pay, no ids, no photos).
async function pickList() {
  const { rows } = await query(`SELECT e.id, e.name, e.emp_code, d.name AS department, e.designation, e.app_user_id
                                  FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id WHERE e.is_active ORDER BY e.name`);
  return rows;
}
async function notify(role, type, message) {
  await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ($1, $2, $3)`, [role, type, message]).catch(() => {});
}

// ------------------------------------------------------------------ PPE ---
router.get("/ppe", async (req, res) => {
  if (!(await anyOf(req.user, [["hr.ppe", "view"], ["hr.ppe-approve", "edit"]]))) return bad(res, "You don't have access to this.", 403);
  const [{ rows: items }, { rows: requests }, { rows: issues }] = await Promise.all([
    query(`SELECT id, name, has_size, life_months, is_active FROM hr_ppe_items ORDER BY is_active DESC, name`),
    query(`SELECT r.id, r.employee_id, e.name AS employee, e.emp_code, d.name AS department, r.item_id, i.name AS item, r.qty, r.size, r.reason, r.note,
                  r.status, r.requested_at, ru.name AS requested_by, r.requested_by AS requested_by_id, r.decided_at, du.name AS decided_by, r.decision_note,
                  (SELECT to_char(MAX(s.issued_on), 'YYYY-MM-DD') FROM hr_ppe_issues s WHERE s.employee_id = r.employee_id AND s.item_id = r.item_id AND s.request_id IS DISTINCT FROM r.id) AS last_issued
             FROM hr_ppe_requests r JOIN hr_employees e ON e.id = r.employee_id LEFT JOIN hr_departments d ON d.id = e.department_id
             JOIN hr_ppe_items i ON i.id = r.item_id
             LEFT JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.decided_by
            WHERE r.status IN ('pending','approved') OR r.requested_at > now() - interval '120 days'
            ORDER BY (r.status = 'pending') DESC, (r.status = 'approved') DESC, r.requested_at DESC LIMIT 500`),
    query(`SELECT s.id, s.employee_id, e.name AS employee, e.emp_code, e.is_active, s.item_id, i.name AS item, i.life_months, s.qty, s.size,
                  to_char(s.issued_on, 'YYYY-MM-DD') AS issued_on, s.request_id, s.note, u.name AS issued_by,
                  to_char(s.returned_on, 'YYYY-MM-DD') AS returned_on, s.return_note,
                  CASE WHEN i.life_months IS NULL THEN NULL ELSE to_char(s.issued_on + make_interval(months => i.life_months), 'YYYY-MM-DD') END AS due_on
             FROM hr_ppe_issues s JOIN hr_employees e ON e.id = s.employee_id JOIN hr_ppe_items i ON i.id = s.item_id
             LEFT JOIN users u ON u.id = s.issued_by
            ORDER BY s.issued_on DESC, s.id DESC LIMIT 2000`),
  ]);
  res.json({ items, requests, issues, employees: await pickList(), today: istDay() });
});

function itemBody(b) {
  return { name: txt(b.name, 80), has_size: !!b.has_size, life_months: b.life_months === "" || b.life_months == null ? null : Math.round(Number(b.life_months)), is_active: b.is_active !== false };
}
router.post("/ppe/items", requirePermission("hr.settings", "create"), async (req, res) => {
  const i = itemBody(req.body || {});
  if (!i.name) return bad(res, "Name the item.");
  if (i.life_months != null && !(i.life_months >= 1 && i.life_months <= 120)) return bad(res, "Life: 1 to 120 months, or blank.");
  try {
    const { rows } = await query(`INSERT INTO hr_ppe_items (name, has_size, life_months) VALUES ($1,$2,$3) RETURNING id`, [i.name, i.has_size, i.life_months]);
    res.status(201).json({ id: rows[0].id });
  } catch (e) { if (e.code === "23505") return bad(res, "That item is already there."); throw e; }
});
router.patch("/ppe/items/:id(\\d+)", requirePermission("hr.settings", "edit"), async (req, res) => {
  const i = itemBody(req.body || {});
  if (!i.name) return bad(res, "Name the item.");
  await query(`UPDATE hr_ppe_items SET name = $1, has_size = $2, life_months = $3, is_active = $4 WHERE id = $5`, [i.name, i.has_size, i.life_months, i.is_active, req.params.id]);
  res.json({ ok: true });
});

async function raise(req, res, lines, self) {
  if (!lines.length) return bad(res, "Add at least one item.");
  if (lines.length > 60) return bad(res, "At most 60 lines in one go.");
  const ids = [];
  for (const [n, l] of lines.entries()) {
    const emp = Number(l.employee_id), item = Number(l.item_id), qty = Math.round(Number(l.qty || 1));
    if (!(emp > 0) || !(item > 0)) return bad(res, `Line ${n + 1}: choose the employee and the item.`);
    if (!(qty >= 1 && qty <= 50)) return bad(res, `Line ${n + 1}: quantity 1 to 50.`);
    const block = await exitBlock(emp, "ppe");
    if (block) return bad(res, block, 409);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const l of lines) {
      const { rows } = await client.query(
        `INSERT INTO hr_ppe_requests (employee_id, item_id, qty, size, reason, note, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [Number(l.employee_id), Number(l.item_id), Math.round(Number(l.qty || 1)), txt(l.size, 20), REASONS.includes(l.reason) ? l.reason : "new", txt(l.note, 300), req.user.id]);
      ids.push(rows[0].id);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  await notify("manager", "hr_ppe_request", `PPE request${ids.length > 1 ? "s" : ""} #${ids.join(", #")} ${self ? `from ${req.user.name}` : `raised by ${req.user.name}`} — waiting for approval.`);
  res.status(201).json({ ids });
}
router.post("/ppe/requests", requirePermission("hr.ppe", "create"), async (req, res) => {
  const b = req.body || {};
  const emps = Array.isArray(b.employee_ids) ? b.employee_ids : b.employee_id ? [b.employee_id] : [];
  const items = Array.isArray(b.items) ? b.items : [];
  const lines = Array.isArray(b.lines) ? b.lines : emps.flatMap((e) => items.map((i) => ({ ...i, employee_id: e, reason: b.reason, note: b.note })));
  return raise(req, res, lines, false);
});
router.post("/my/ppe-request", async (req, res) => {
  const { rows } = await query(`SELECT id FROM hr_employees WHERE app_user_id = $1 AND is_active LIMIT 1`, [req.user.id]);
  if (!rows[0]) return bad(res, "Your login is not linked to an employee record — ask HR.", 404);
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  return raise(req, res, items.map((i) => ({ ...i, employee_id: rows[0].id, reason: i.reason || b.reason, note: i.note || b.note })), true);
});
router.get("/my/ppe", async (req, res) => {
  const { rows: e } = await query(`SELECT id FROM hr_employees WHERE app_user_id = $1 AND is_active LIMIT 1`, [req.user.id]);
  if (!e[0]) return res.json({ linked: false, items: [], requests: [], issues: [] });
  const [{ rows: items }, { rows: requests }, { rows: issues }] = await Promise.all([
    query(`SELECT id, name, has_size FROM hr_ppe_items WHERE is_active ORDER BY name`),
    query(`SELECT r.id, i.name AS item, r.qty, r.size, r.reason, r.status, r.requested_at, r.decision_note FROM hr_ppe_requests r JOIN hr_ppe_items i ON i.id = r.item_id
            WHERE r.employee_id = $1 ORDER BY r.requested_at DESC LIMIT 30`, [e[0].id]),
    query(`SELECT s.id, i.name AS item, s.qty, s.size, to_char(s.issued_on, 'YYYY-MM-DD') AS issued_on, to_char(s.returned_on, 'YYYY-MM-DD') AS returned_on
             FROM hr_ppe_issues s JOIN hr_ppe_items i ON i.id = s.item_id WHERE s.employee_id = $1 ORDER BY s.issued_on DESC LIMIT 50`, [e[0].id]),
  ]);
  res.json({ linked: true, items, requests, issues });
});

router.post("/ppe/requests/:id(\\d+)/decide", requirePermission("hr.ppe-approve", "edit"), async (req, res) => {
  const b = req.body || {};
  const approve = b.action === "approve";
  if (!approve && b.action !== "reject") return bad(res, "Approve or reject.");
  const { rows } = await query(`SELECT r.*, e.app_user_id FROM hr_ppe_requests r JOIN hr_employees e ON e.id = r.employee_id WHERE r.id = $1`, [req.params.id]);
  const r = rows[0];
  if (!r) return bad(res, "Not found.", 404);
  if (r.status !== "pending") return bad(res, "This request has already been decided.", 409);
  const admin = req.user.role === "administrator" || req.user.role === "super_admin";
  if (!admin && (r.requested_by === req.user.id || r.app_user_id === req.user.id)) return bad(res, "Someone else approves a request you raised or one for yourself.", 403);
  if (!approve && !txt(b.note, 300)) return bad(res, "Say why it is rejected.");
  if (approve) { const block = await exitBlock(r.employee_id, "ppe"); if (block) return bad(res, block, 409); }
  await query(`UPDATE hr_ppe_requests SET status = $1, qty = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $5`,
    [approve ? "approved" : "rejected", approve && Number(b.qty) >= 1 && Number(b.qty) <= r.qty ? Math.round(Number(b.qty)) : r.qty, req.user.id, txt(b.note, 300), r.id]);
  res.json({ ok: true });
});
router.post("/ppe/requests/:id(\\d+)/cancel", async (req, res) => {
  const { rows } = await query(`SELECT * FROM hr_ppe_requests WHERE id = $1`, [req.params.id]);
  const r = rows[0];
  if (!r) return bad(res, "Not found.", 404);
  if (!["pending", "approved"].includes(r.status)) return bad(res, "Only an open request can be cancelled.", 409);
  if (r.requested_by !== req.user.id && !(await can(req.user, "hr.ppe", "delete"))) return bad(res, "Only whoever raised it can cancel it.", 403);
  await query(`UPDATE hr_ppe_requests SET status = 'cancelled', decision_note = COALESCE(decision_note, $2) WHERE id = $1`, [r.id, txt(req.body?.note, 300)]);
  res.json({ ok: true });
});

router.post("/ppe/issues", requirePermission("hr.ppe", "edit"), async (req, res) => {
  const b = req.body || {};
  const on = DAY_RE.test(b.issued_on || "") ? b.issued_on : istDay();
  if (on > istDay()) return bad(res, "The issue date cannot be in the future.");
  let emp = Number(b.employee_id), item = Number(b.item_id), qty = Math.round(Number(b.qty || 1)), size = txt(b.size, 20), reqId = null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (b.request_id) {
      const { rows } = await client.query(`SELECT * FROM hr_ppe_requests WHERE id = $1 FOR UPDATE`, [b.request_id]);
      const r = rows[0];
      if (!r) { await client.query("ROLLBACK"); return bad(res, "Request not found.", 404); }
      if (r.status !== "approved") { await client.query("ROLLBACK"); return bad(res, r.status === "issued" ? "Already issued." : "Only an approved request can be issued.", 409); }
      emp = r.employee_id; item = r.item_id; qty = r.qty; size = size || r.size; reqId = r.id;
      await client.query(`UPDATE hr_ppe_requests SET status = 'issued' WHERE id = $1`, [r.id]);
    } else if (!(await can(req.user, "hr.ppe-approve", "edit"))) {
      // A direct issue skips the approval — only someone who may approve does it.
      await client.query("ROLLBACK"); return bad(res, "Issue against an approved request — raise one first.", 403);
    }
    if (!(emp > 0) || !(item > 0) || !(qty >= 1 && qty <= 50)) { await client.query("ROLLBACK"); return bad(res, "Choose the employee, the item and the quantity."); }
    const block = await exitBlock(emp, "ppe", {}, client);
    if (block) { await client.query("ROLLBACK"); return bad(res, block, 409); }
    const { rows } = await client.query(
      `INSERT INTO hr_ppe_issues (employee_id, item_id, qty, size, issued_on, request_id, note, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [emp, item, qty, size, on, reqId, txt(b.note, 300), req.user.id]);
    await client.query("COMMIT");
    res.status(201).json({ id: rows[0].id });
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
});
router.post("/ppe/issues/:id(\\d+)/return", requirePermission("hr.ppe", "edit"), async (req, res) => {
  const b = req.body || {};
  const undo = b.undo === true;
  const on = DAY_RE.test(b.returned_on || "") ? b.returned_on : istDay();
  const r = await query(`UPDATE hr_ppe_issues SET returned_on = $1, return_note = $2 WHERE id = $3`, [undo ? null : on, undo ? null : txt(b.note, 200), req.params.id]);
  if (!r.rowCount) return bad(res, "Not found.", 404);
  res.json({ ok: true });
});
router.delete("/ppe/issues/:id(\\d+)", requirePermission("hr.ppe", "delete"), async (req, res) => {
  const { rows } = await query(`DELETE FROM hr_ppe_issues WHERE id = $1 RETURNING request_id`, [req.params.id]);
  if (!rows[0]) return bad(res, "Not found.", 404);
  if (rows[0].request_id) await query(`UPDATE hr_ppe_requests SET status = 'approved' WHERE id = $1 AND status = 'issued'`, [rows[0].request_id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- exits ---
router.get("/exits", async (req, res) => {
  if (!(await anyOf(req.user, [["hr.exit", "view"], ["hr.exit-approve", "edit"]]))) return bad(res, "You don't have access to this.", 403);
  const { rows } = await query(
    `SELECT x.id, x.employee_id, e.name AS employee, e.emp_code, e.designation, d.name AS department, e.is_active, e.app_user_id,
            to_char(e.date_of_joining, 'YYYY-MM-DD') AS date_of_joining,
            x.kind, to_char(x.notice_date, 'YYYY-MM-DD') AS notice_date, to_char(x.last_working_day, 'YYYY-MM-DD') AS last_working_day,
            x.reason, x.status, x.requested_at, ru.name AS requested_by, x.requested_by AS requested_by_id, x.decided_at, du.name AS decided_by, x.decision_note,
            x.settlement_note, x.disable_login, x.completed_at, cu.name AS completed_by,
            (SELECT COALESCE(json_agg(json_build_object('item', i.name, 'qty', s.qty, 'issued_on', to_char(s.issued_on, 'YYYY-MM-DD')) ORDER BY s.issued_on), '[]')
               FROM hr_ppe_issues s JOIN hr_ppe_items i ON i.id = s.item_id WHERE s.employee_id = x.employee_id AND s.returned_on IS NULL) AS ppe_out,
            (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'amount', a.amount::float, 'given_on', to_char(a.given_on, 'YYYY-MM-DD'), 'recover_month', a.recover_month) ORDER BY a.given_on), '[]')
               FROM hr_advances a WHERE a.employee_id = x.employee_id AND a.recover_month >= to_char(x.last_working_day, 'YYYY-MM')) AS advances_to_recover,
            (SELECT COUNT(*)::int FROM hr_advance_request_lines l WHERE l.employee_id = x.employee_id AND l.status IN ('pending','approved')) AS advance_requests_open,
            (SELECT COUNT(*)::int FROM hr_ppe_requests r WHERE r.employee_id = x.employee_id AND r.status IN ('pending','approved')) AS ppe_requests_open,
            (SELECT json_build_object('month', p.month, 'net', p.net_pay::float, 'paid', p.paid_amount::float) FROM hr_payroll_lines p
              WHERE p.employee_id = x.employee_id ORDER BY p.month DESC LIMIT 1) AS last_payroll
       FROM hr_exits x JOIN hr_employees e ON e.id = x.employee_id LEFT JOIN hr_departments d ON d.id = e.department_id
       LEFT JOIN users ru ON ru.id = x.requested_by LEFT JOIN users du ON du.id = x.decided_by LEFT JOIN users cu ON cu.id = x.completed_by
      ORDER BY (x.status IN ('pending','approved')) DESC, x.last_working_day DESC, x.id DESC LIMIT 300`);
  res.json({ exits: rows, employees: await pickList(), today: istDay() });
});

router.post("/exits", requirePermission("hr.exit", "create"), async (req, res) => {
  const b = req.body || {};
  const emp = Number(b.employee_id);
  if (!(emp > 0)) return bad(res, "Choose the employee.");
  if (!KINDS.includes(b.kind)) return bad(res, "Choose why the employee is leaving.");
  if (!DAY_RE.test(b.last_working_day || "")) return bad(res, "Give the last working day.");
  const notice = DAY_RE.test(b.notice_date || "") ? b.notice_date : null;
  if (notice && notice > b.last_working_day) return bad(res, "The notice date is after the last working day.");
  const { rows: e } = await query(`SELECT id, name, is_active, to_char(date_of_joining, 'YYYY-MM-DD') AS doj FROM hr_employees WHERE id = $1`, [emp]);
  if (!e[0]) return bad(res, "Employee not found.", 404);
  if (!e[0].is_active) return bad(res, `${e[0].name} is already marked as left.`, 409);
  if (e[0].doj && b.last_working_day < e[0].doj) return bad(res, "The last working day is before the date of joining.");
  try {
    const { rows } = await query(
      `INSERT INTO hr_exits (employee_id, kind, notice_date, last_working_day, reason, requested_by, disable_login) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [emp, b.kind, notice, b.last_working_day, txt(b.reason, 500), req.user.id, b.disable_login !== false]);
    await notify("administrator", "hr_exit", `Exit raised for ${e[0].name} (last working day ${b.last_working_day}) by ${req.user.name} — waiting for approval.`);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return bad(res, `An exit for ${e[0].name} is already open.`, 409);
    throw err;
  }
});

router.post("/exits/:id(\\d+)/decide", requirePermission("hr.exit-approve", "edit"), async (req, res) => {
  const b = req.body || {};
  const approve = b.action === "approve";
  if (!approve && b.action !== "reject") return bad(res, "Approve or reject.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT x.*, to_char(x.last_working_day, 'YYYY-MM-DD') AS lwd, e.date_of_leaving FROM hr_exits x JOIN hr_employees e ON e.id = x.employee_id WHERE x.id = $1 FOR UPDATE OF x`, [req.params.id]);
    const x = rows[0];
    if (!x) { await client.query("ROLLBACK"); return bad(res, "Not found.", 404); }
    if (x.status !== "pending") { await client.query("ROLLBACK"); return bad(res, "This exit has already been decided.", 409); }
    if (!approve && !txt(b.note, 300)) { await client.query("ROLLBACK"); return bad(res, "Say why it is rejected."); }
    const lwd = approve && DAY_RE.test(b.last_working_day || "") ? b.last_working_day : x.lwd;
    await client.query(`UPDATE hr_exits SET status = $1, last_working_day = $2, decided_by = $3, decided_at = now(), decision_note = $4, prev_leaving_date = $5 WHERE id = $6`,
      [approve ? "approved" : "rejected", lwd, req.user.id, txt(b.note, 300), x.date_of_leaving, x.id]);
    // Attendance and payroll stop at the last working day.
    if (approve) await client.query(`UPDATE hr_employees SET date_of_leaving = $1, updated_by = $2, updated_at = now() WHERE id = $3`, [lwd, req.user.id, x.employee_id]);
    // Open advance requests and PPE requests for a leaver are closed.
    if (approve) {
      await client.query(`UPDATE hr_ppe_requests SET status = 'cancelled', decision_note = 'Employee leaving' WHERE employee_id = $1 AND status IN ('pending','approved')`, [x.employee_id]);
      await client.query(`UPDATE hr_advance_request_lines SET status = 'cancelled' WHERE employee_id = $1 AND status IN ('pending','approved')`, [x.employee_id]).catch(() => {});
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
});

router.post("/exits/:id(\\d+)/complete", requirePermission("hr.exit-approve", "edit"), async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(`SELECT x.*, to_char(x.last_working_day, 'YYYY-MM-DD') AS lwd, e.app_user_id, e.name FROM hr_exits x JOIN hr_employees e ON e.id = x.employee_id WHERE x.id = $1`, [req.params.id]);
  const x = rows[0];
  if (!x) return bad(res, "Not found.", 404);
  if (x.status !== "approved") return bad(res, "Approve the exit first.", 409);
  if (x.lwd > istDay()) return bad(res, `The last working day (${x.lwd}) has not come yet.`, 409);
  const disable = b.disable_login !== false && x.disable_login !== false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE hr_exits SET status = 'completed', settlement_note = $1, disable_login = $2, completed_by = $3, completed_at = now() WHERE id = $4`,
      [txt(b.settlement_note, 500), disable, req.user.id, x.id]);
    await client.query(`UPDATE hr_employees SET is_active = false, date_of_leaving = $1, updated_by = $2, updated_at = now() WHERE id = $3`, [x.lwd, req.user.id, x.employee_id]);
    if (disable && x.app_user_id) {
      // Never the last Super Admin, never oneself.
      await client.query(`UPDATE users SET is_active = false WHERE id = $1 AND id <> $2 AND role::text <> 'super_admin'`, [x.app_user_id, req.user.id]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
  if (x.app_user_id) { clearUserCache(x.app_user_id); clearPermissionCache(x.app_user_id); }
  res.json({ ok: true });
});

router.post("/exits/:id(\\d+)/cancel", async (req, res) => {
  const { rows } = await query(`SELECT * FROM hr_exits WHERE id = $1`, [req.params.id]);
  const x = rows[0];
  if (!x) return bad(res, "Not found.", 404);
  if (!["pending", "approved"].includes(x.status)) return bad(res, "Only an open exit can be cancelled.", 409);
  const approver = await can(req.user, "hr.exit-approve", "edit");
  if (x.status === "approved" && !approver) return bad(res, "Only the Administrator cancels an approved exit.", 403);
  if (x.status === "pending" && x.requested_by !== req.user.id && !approver) return bad(res, "Only whoever raised it, or the Administrator, can cancel it.", 403);
  await query(`UPDATE hr_exits SET status = 'cancelled', decision_note = COALESCE($2, decision_note) WHERE id = $1`, [x.id, txt(req.body?.note, 300)]);
  if (x.status === "approved") await query(`UPDATE hr_employees SET date_of_leaving = $1 WHERE id = $2`, [x.prev_leaving_date, x.employee_id]);
  res.json({ ok: true });
});

export default router;
