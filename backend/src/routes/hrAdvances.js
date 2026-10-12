// Round 205 — salary advances as a request (owner, 12 Oct 2026):
//
//   "There should be advance request created by Accountant (for whoever want
//    advance, single employee or multiple), approval from Manager/Admin then
//    record how much is paid."
//
//   1. Raise   (hr.advance-request · create) — the Accountant, for one
//              employee or several, each with the amount asked and the payroll
//              month it is recovered from.
//   2. Decide  (hr.advance-approve · edit) — the Plant Manager or Admin
//              approves each line (the amount may be cut) or rejects it. No one
//              decides a request they raised, or an advance for themselves
//              (an Administrator may decide one they raised).
//   3. Pay     (hr.advance-pay · edit) — the Accountant records what was
//              actually paid, when and how. The payment becomes the
//              hr_advances row payroll already recovers from.
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";

const router = Router();
router.use(requireAuth);

const ANY_PAIRS = [["hr.advance-request", "view"], ["hr.advance-approve", "edit"], ["hr.advance-pay", "edit"], ["hr.advances", "view"]];
async function ANY(req, res, next) {
  try {
    for (const [k, a] of ANY_PAIRS) if (await can(req.user, k, a)) return next();
    return res.status(403).json({ error: "You don't have access to this." });
  } catch (err) { next(err); }
}
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAY_MODES = ["cash", "bank_transfer", "upi", "cheque"];
const isAdmin = (u) => ["administrator", "super_admin"].includes(u.role);
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

async function monthLocked(month, db = { query }) {
  const { rows } = await db.query(`SELECT status FROM hr_payroll_runs WHERE month = $1`, [month]);
  return rows[0]?.status === "locked";
}

async function perms(user) {
  const [raise, approve, pay] = await Promise.all([
    can(user, "hr.advance-request", "create"), can(user, "hr.advance-approve", "edit"), can(user, "hr.advance-pay", "edit"),
  ]);
  return { raise, approve, pay };
}

// Active employees to pick from (name and code only — no pay details).
router.get("/employees", ANY, async (req, res) => {
  const { rows } = await query(
    `SELECT e.id, e.name, e.emp_code, d.name AS department
       FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
      WHERE e.is_active ORDER BY e.name`
  ).catch(() => query(`SELECT id, name, emp_code FROM hr_employees WHERE is_active ORDER BY name`));
  res.json(rows);
});

router.get("/", ANY, async (req, res) => {
  const show = ["open", "all"].includes(req.query.show) ? req.query.show : "open";
  const { rows } = await query(
    `SELECT r.id, r.purpose, r.status, r.raised_at, r.decided_at, r.decision_note, r.raised_by,
            ru.name AS raised_by_name, du.name AS decided_by_name,
            json_agg(json_build_object(
              'id', l.id, 'employee_id', l.employee_id, 'employee_name', e.name, 'emp_code', e.emp_code,
              'employee_user_id', e.app_user_id, 'amount', l.amount, 'approved_amount', l.approved_amount,
              'recover_month', l.recover_month, 'status', l.status,
              'paid', CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object(
                 'amount', a.amount, 'given_on', to_char(a.given_on, 'YYYY-MM-DD'), 'mode', a.mode, 'reference', a.reference) END
            ) ORDER BY e.name) AS lines
       FROM hr_advance_requests r
       JOIN hr_advance_request_lines l ON l.request_id = r.id
       JOIN hr_employees e ON e.id = l.employee_id
       LEFT JOIN hr_advances a ON a.id = l.advance_id
       LEFT JOIN users ru ON ru.id = r.raised_by LEFT JOIN users du ON du.id = r.decided_by
      WHERE ($1 = 'all' AND r.raised_at > now() - interval '180 days') OR r.status IN ('pending', 'approved', 'part_paid')
      GROUP BY r.id, ru.name, du.name
      ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'part_paid' THEN 1 ELSE 2 END, r.raised_at DESC
      LIMIT 200`,
    [show]
  );
  const p = await perms(req.user);
  res.json({
    perms: p,
    requests: rows.map((r) => ({
      ...r,
      can_decide: p.approve && r.status === "pending" && (r.raised_by !== req.user.id || isAdmin(req.user)),
      can_cancel: r.status === "pending" && (r.raised_by === req.user.id || isAdmin(req.user)),
    })),
  });
});

// 1. Raise
router.post("/", requirePermission("hr.advance-request", "create"), async (req, res) => {
  const b = req.body || {};
  const purpose = String(b.purpose || "").trim().slice(0, 500) || null;
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) return bad(res, "Add at least one employee.");
  if (lines.length > 100) return bad(res, "At most 100 employees in one request.");
  const seen = new Set();
  const clean = [];
  for (const l of lines) {
    const emp = Number(l.employee_id);
    const amt = r2(l.amount);
    const month = MONTH_RE.test(String(l.recover_month || "")) ? l.recover_month : istToday().slice(0, 7);
    if (!Number.isInteger(emp) || emp <= 0) return bad(res, "Choose the employee on every line.");
    if (!(amt > 0) || amt > 1000000) return bad(res, "Enter the amount asked on every line.");
    if (seen.has(emp)) return bad(res, "The same employee is on two lines — put it in one.");
    if (await monthLocked(month)) return bad(res, `Payroll for ${month} is already locked — recover from a later month.`, 409);
    seen.add(emp);
    clean.push({ emp, amt, month });
  }
  const { rows: emps } = await query(`SELECT id, app_user_id FROM hr_employees WHERE is_active AND id = ANY($1::int[])`, [[...seen]]);
  if (emps.length !== seen.size) return bad(res, "One of the employees was not found or has left.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO hr_advance_requests (purpose, raised_by) VALUES ($1, $2) RETURNING id`, [purpose, req.user.id]);
    for (const l of clean) {
      await client.query(
        `INSERT INTO hr_advance_request_lines (request_id, employee_id, amount, recover_month) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, l.emp, l.amt, l.month]);
    }
    await client.query(
      `INSERT INTO notifications (recipient_role, type, message) VALUES ('manager', 'hr_advance_request', $1)`,
      [`Salary advance request #${rows[0].id}: ${clean.length} employee(s), ₹${r2(clean.reduce((t, l) => t + l.amt, 0)).toLocaleString("en-IN")} — waiting for approval.`]
    ).catch(() => {});
    await client.query("COMMIT");
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    bad(res, "Could not save the request.", 500);
  } finally {
    client.release();
  }
});

// 2. Decide — { action: 'approve' | 'reject', note, lines: [{ id, approve, approved_amount }] }
router.post("/:id(\\d+)/decide", requirePermission("hr.advance-approve", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const note = String(b.note || "").trim().slice(0, 500) || null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: rq } = await client.query(`SELECT * FROM hr_advance_requests WHERE id = $1 FOR UPDATE`, [id]);
    const r = rq[0];
    if (!r) { await client.query("ROLLBACK"); return bad(res, "Request not found.", 404); }
    if (r.status !== "pending") { await client.query("ROLLBACK"); return bad(res, "This request has already been decided.", 409); }
    if (r.raised_by === req.user.id && !isAdmin(req.user)) { await client.query("ROLLBACK"); return bad(res, "You raised this request — another approver must decide it.", 403); }
    const { rows: lines } = await client.query(
      `SELECT l.*, e.app_user_id, e.name FROM hr_advance_request_lines l JOIN hr_employees e ON e.id = l.employee_id WHERE l.request_id = $1`, [id]);
    const wanted = new Map((Array.isArray(b.lines) ? b.lines : []).map((l) => [Number(l.id), l]));
    let approved = 0;
    for (const l of lines) {
      const w = wanted.get(l.id);
      const yes = b.action === "approve" && (w ? w.approve !== false : true);
      if (yes && l.app_user_id === req.user.id) {
        await client.query("ROLLBACK");
        return bad(res, `${l.name}'s advance is your own — someone else must approve it.`, 403);
      }
      if (yes) {
        const amt = w && w.approved_amount !== undefined && w.approved_amount !== "" ? r2(w.approved_amount) : Number(l.amount);
        if (!(amt > 0) || amt > Number(l.amount)) { await client.query("ROLLBACK"); return bad(res, `${l.name}: the approved amount must be more than 0 and not more than asked.`); }
        await client.query(`UPDATE hr_advance_request_lines SET status = 'approved', approved_amount = $1 WHERE id = $2`, [amt, l.id]);
        approved++;
      } else {
        await client.query(`UPDATE hr_advance_request_lines SET status = 'rejected', approved_amount = NULL WHERE id = $1`, [l.id]);
      }
    }
    if (b.action !== "approve" && !note) { await client.query("ROLLBACK"); return bad(res, "Say why it is rejected."); }
    const status = approved ? "approved" : "rejected";
    await client.query(
      `UPDATE hr_advance_requests SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4`,
      [status, req.user.id, note, id]);
    await client.query(
      `INSERT INTO notifications (recipient_role, type, message) VALUES ('accountant', 'hr_advance_decided', $1)`,
      [status === "approved" ? `Salary advance request #${id} approved (${approved} of ${lines.length}) — record the payment.` : `Salary advance request #${id} was rejected${note ? `: ${note}` : ""}.`]
    ).catch(() => {});
    await client.query("COMMIT");
    res.json({ ok: true, status });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    bad(res, "Could not save the decision.", 500);
  } finally {
    client.release();
  }
});

router.post("/:id(\\d+)/cancel", ANY, async (req, res) => {
  const { rows } = await query(`SELECT raised_by, status FROM hr_advance_requests WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return bad(res, "Request not found.", 404);
  if (rows[0].status !== "pending") return bad(res, "Only a request still waiting for approval can be withdrawn.", 409);
  if (rows[0].raised_by !== req.user.id && !isAdmin(req.user)) return bad(res, "Only the person who raised it can withdraw it.", 403);
  await query(`UPDATE hr_advance_request_lines SET status = 'cancelled' WHERE request_id = $1`, [req.params.id]);
  await query(`UPDATE hr_advance_requests SET status = 'cancelled', decided_at = now(), decided_by = $2 WHERE id = $1`, [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// 3. Pay one approved line — { amount, given_on, mode, reference, recover_month }
router.post("/lines/:lineId(\\d+)/pay", requirePermission("hr.advance-pay", "edit"), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT l.*, r.id AS rid, r.status AS rstatus FROM hr_advance_request_lines l JOIN hr_advance_requests r ON r.id = l.request_id
        WHERE l.id = $1 FOR UPDATE OF l`, [req.params.lineId]);
    const l = rows[0];
    if (!l) { await client.query("ROLLBACK"); return bad(res, "Not found.", 404); }
    if (l.status !== "approved") { await client.query("ROLLBACK"); return bad(res, l.status === "paid" ? "Already paid." : "Only an approved advance can be paid.", 409); }
    const amt = b.amount === undefined || b.amount === "" ? Number(l.approved_amount) : r2(b.amount);
    if (!(amt > 0) || amt > Number(l.approved_amount)) { await client.query("ROLLBACK"); return bad(res, `Pay more than 0 and not more than the ₹${Number(l.approved_amount).toLocaleString("en-IN")} approved.`); }
    const day = DATE_RE.test(b.given_on || "") ? b.given_on : istToday();
    if (day > istToday()) { await client.query("ROLLBACK"); return bad(res, "The date paid cannot be in the future."); }
    const mode = PAY_MODES.includes(b.mode) ? b.mode : "cash";
    const month = MONTH_RE.test(String(b.recover_month || "")) ? b.recover_month : l.recover_month;
    if (await monthLocked(month, client)) { await client.query("ROLLBACK"); return bad(res, `Payroll for ${month} is locked — recover it from a later month.`, 409); }
    const { rows: adv } = await client.query(
      `INSERT INTO hr_advances (employee_id, given_on, amount, mode, reference, recover_month, note, created_by, request_line_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [l.employee_id, day, amt, mode, String(b.reference || "").trim().slice(0, 100) || null, month,
       `Advance request #${l.rid}`, req.user.id, l.id]);
    await client.query(`UPDATE hr_advance_request_lines SET status = 'paid', advance_id = $1, recover_month = $2 WHERE id = $3`, [adv[0].id, month, l.id]);
    const { rows: left } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'approved')::int AS open, COUNT(*) FILTER (WHERE status = 'paid')::int AS paid
         FROM hr_advance_request_lines WHERE request_id = $1`, [l.rid]);
    await client.query(`UPDATE hr_advance_requests SET status = $1 WHERE id = $2`, [left[0].open ? "part_paid" : "paid", l.rid]);
    await client.query("COMMIT");
    res.status(201).json({ advance_id: adv[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    bad(res, "Could not record the payment.", 500);
  } finally {
    client.release();
  }
});

export default router;
