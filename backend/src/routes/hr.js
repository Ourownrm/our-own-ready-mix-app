// Round 197 — HR module, stage 1: employees, settings, roster, attendance
// register. Mounted at /api/hr. All session; every route is behind an HR
// function from the catalogue (module.hr gates them all, see lib/permissions).
//
// PAY IS A SEPARATE FUNCTION. Salary, PF/ESI, contract rate and incentive
// fields are only returned to someone with hr.salary view, and only accepted
// from someone with hr.salary edit. Anyone else editing an employee simply
// cannot touch them — the fields are dropped, never zeroed.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, requireAnyPermission, can } from "../lib/permissions.js";
import { attendanceRegister, datesBetween } from "../lib/hrAttendance.js";
// Round 198 — stage 2.
import { RULE_DEFS, loadRules, validateRule } from "../lib/hrRules.js";
import { computePayroll, monthRange } from "../lib/hrPayroll.js";

const router = Router();
router.use(requireAuth);

const ANY_HR = ["hr.attendance", "hr.employees", "hr.roster", "hr.settings"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const text = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const money = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new Error("Amounts must be numbers of 0 or more.");
  return Math.round(n * 100) / 100;
};
const date = (v) => (v === null || v === undefined || v === "" ? null : DATE_RE.test(String(v)) ? String(v) : (() => { throw new Error("Dates must be YYYY-MM-DD."); })());
const intOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : (() => { throw new Error("Expected a number."); })());
const bool = (v, dflt) => (v === undefined ? dflt : !!v);

const SALARY_FIELDS = ["salary_basic", "salary_da", "salary_hra", "salary_conveyance", "salary_special",
  "pf_applicable", "esi_applicable", "daily_rate", "service_charge_pct", "incentive_basis", "incentive_min_m3", "incentive_rate", "salesperson_id", "ot_eligible"];

function friendly(err, res, fallback) {
  if (err.code === "23505") {
    const m = String(err.constraint || "");
    const msg = m.includes("machine") ? "That machine number already belongs to another active employee."
      : m.includes("appuser") ? "That app login is already linked to another active employee."
      : m.includes("emp_code") ? "That employee code is already used."
      : "That already exists.";
    return res.status(409).json({ error: msg });
  }
  if (err.code === "23503") return res.status(400).json({ error: "It is still in use, or points at something that does not exist." });
  if (err.code === "23514") return res.status(400).json({ error: "One of the values is out of range." });
  if (err.expose || err.message?.startsWith("Amounts") || err.message?.startsWith("Dates") || err.message?.startsWith("Expected")) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: fallback });
}

// ============================================================ meta
router.get("/meta", requireAnyPermission(ANY_HR), async (req, res) => {
  try {
    const [deps, shifts, hols, mUsers, appUsers, sps, rules] = await Promise.all([
      query(`SELECT * FROM hr_departments ORDER BY sort_order, name`),
      query(`SELECT id, name, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
                    grace_min, full_day_min, half_day_min, is_active FROM hr_shifts ORDER BY is_active DESC, start_time, name`),
      query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name FROM hr_holidays
             WHERE holiday_date >= (CURRENT_DATE - interval '400 days') ORDER BY holiday_date`),
      query(`SELECT du.machine_user_id, max(du.name_on_machine) AS name_on_machine,
                    to_char(max(p.punched_at), 'YYYY-MM-DD') AS last_punch,
                    (SELECT e.id FROM hr_employees e WHERE e.is_active AND e.machine_user_id = du.machine_user_id LIMIT 1) AS employee_id
             FROM attendance_device_users du
             LEFT JOIN attendance_punches p ON p.machine_user_id = du.machine_user_id
             GROUP BY du.machine_user_id
             ORDER BY CASE WHEN du.machine_user_id ~ '^[0-9]+$' THEN du.machine_user_id::bigint END NULLS LAST, du.machine_user_id`),
      query(`SELECT u.id, u.name, u.role, u.phone,
                    (SELECT e.id FROM hr_employees e WHERE e.is_active AND e.app_user_id = u.id LIMIT 1) AS employee_id
             FROM users u WHERE u.is_active AND u.role NOT IN ('super_admin') ORDER BY u.name`),
      query(`SELECT id, name, user_id FROM salespersons WHERE is_active ORDER BY name`),
      loadRules(),
    ]);
    res.json({
      departments: deps.rows, shifts: shifts.rows, holidays: hols.rows,
      machine_users: mUsers.rows, app_users: appUsers.rows,
      can_salary: await can(req.user, "hr.salary", "view"),
      can_salary_edit: await can(req.user, "hr.salary", "edit"),
      salespersons: sps.rows,
      rules, rule_defs: RULE_DEFS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load HR settings." });
  }
});

// ============================================================ employees
router.get("/employees", requirePermission("hr.employees", "view"), async (req, res) => {
  try {
    const salary = await can(req.user, "hr.salary", "view");
    const { rows } = await query(
      `SELECT e.*, to_char(e.date_of_joining, 'YYYY-MM-DD') AS date_of_joining, to_char(e.date_of_leaving, 'YYYY-MM-DD') AS date_of_leaving,
              d.name AS department, s.name AS default_shift_name, u.name AS app_user_name,
              (SELECT max(name_on_machine) FROM attendance_device_users du WHERE du.machine_user_id = e.machine_user_id) AS name_on_machine
       FROM hr_employees e
       LEFT JOIN hr_departments d ON d.id = e.department_id
       LEFT JOIN hr_shifts s ON s.id = e.default_shift_id
       LEFT JOIN users u ON u.id = e.app_user_id
       ORDER BY e.is_active DESC, d.sort_order NULLS LAST, e.name`
    );
    if (!salary) for (const r of rows) for (const f of SALARY_FIELDS) delete r[f];
    for (const r of rows) {
      if (!salary) continue;
      const g = ["salary_basic", "salary_da", "salary_hra", "salary_conveyance", "salary_special"].reduce((a, f) => a + Number(r[f] || 0), 0);
      r.gross_monthly = g || null;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load employees." });
  }
});

function employeeFields(b, { withSalary }) {
  const f = {
    emp_code: text(b.emp_code, 20),
    name: text(b.name, 120),
    mobile: text(b.mobile, 20),
    department_id: intOrNull(b.department_id),
    designation: text(b.designation, 80),
    employment_type: b.employment_type === "contract" ? "contract" : "payroll",
    contractor_name: text(b.contractor_name, 120),
    date_of_joining: date(b.date_of_joining),
    date_of_leaving: date(b.date_of_leaving),
    attendance_source: ["machine", "app", "none"].includes(b.attendance_source) ? b.attendance_source : "machine",
    machine_user_id: text(b.machine_user_id, 30),
    app_user_id: intOrNull(b.app_user_id),
    policy: b.policy === "operations" ? "operations" : "office",
    default_shift_id: intOrNull(b.default_shift_id),
    weekly_off: b.weekly_off === null || b.weekly_off === "" || b.weekly_off === undefined ? null : intOrNull(b.weekly_off),
    trip_allowance: bool(b.trip_allowance, false),
    notes: text(b.notes, 2000),
  };
  if (f.weekly_off !== null && (f.weekly_off < 0 || f.weekly_off > 6)) throw Object.assign(new Error("Weekly off must be a day of the week."), { expose: true });
  if (f.date_of_leaving && f.date_of_joining && f.date_of_leaving < f.date_of_joining) throw Object.assign(new Error("Leaving date is before joining date."), { expose: true });
  if (withSalary) {
    Object.assign(f, {
      salary_basic: money(b.salary_basic), salary_da: money(b.salary_da), salary_hra: money(b.salary_hra),
      salary_conveyance: money(b.salary_conveyance), salary_special: money(b.salary_special),
      pf_applicable: bool(b.pf_applicable, true), esi_applicable: bool(b.esi_applicable, true),
      daily_rate: money(b.daily_rate), service_charge_pct: money(b.service_charge_pct),
      incentive_basis: ["none", "own_production", "plant_production", "own_sales_paid"].includes(b.incentive_basis) ? b.incentive_basis : "none",
      salesperson_id: intOrNull(b.salesperson_id),
      ot_eligible: bool(b.ot_eligible, false),
      incentive_min_m3: money(b.incentive_min_m3), incentive_rate: money(b.incentive_rate),
    });
  }
  return f;
}

router.post("/employees", requirePermission("hr.employees", "create"), async (req, res) => {
  try {
    const withSalary = await can(req.user, "hr.salary", "edit");
    const f = employeeFields(req.body || {}, { withSalary });
    if (!f.emp_code || !f.name) return res.status(400).json({ error: "Employee code and name are required." });
    f.is_active = !f.date_of_leaving;
    f.created_by = req.user.id;
    const cols = Object.keys(f);
    const { rows } = await query(
      `INSERT INTO hr_employees (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      cols.map((c) => f[c])
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    friendly(err, res, "Could not add the employee.");
  }
});

router.patch("/employees/:id", requirePermission("hr.employees", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid employee." });
  try {
    const withSalary = await can(req.user, "hr.salary", "edit");
    const f = employeeFields(req.body || {}, { withSalary });
    if (!f.emp_code || !f.name) return res.status(400).json({ error: "Employee code and name are required." });
    // Someone who has left is inactive, so their machine number frees up for a new joiner.
    f.is_active = req.body.is_active === false ? false : !f.date_of_leaving || f.date_of_leaving >= new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    f.updated_by = req.user.id;
    const cols = Object.keys(f);
    const { rowCount } = await query(
      `UPDATE hr_employees SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}, updated_at = now() WHERE id = $${cols.length + 1}`,
      [...cols.map((c) => f[c]), id]
    );
    if (!rowCount) return res.status(404).json({ error: "Employee not found." });
    res.json({ ok: true, salary_saved: withSalary });
  } catch (err) {
    friendly(err, res, "Could not save the employee.");
  }
});

// ============================================================ settings
router.post("/departments", requirePermission("hr.settings", "create"), async (req, res) => {
  try {
    const name = text(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: "Name is required." });
    const { rows } = await query(
      `INSERT INTO hr_departments (name, is_direct, sort_order)
       VALUES ($1, $2, (SELECT COALESCE(max(sort_order), 0) + 1 FROM hr_departments)) RETURNING id`,
      [name, bool(req.body?.is_direct, true)]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) { friendly(err, res, "Could not add the department."); }
});
router.patch("/departments/:id", requirePermission("hr.settings", "edit"), async (req, res) => {
  try {
    const name = text(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: "Name is required." });
    await query(`UPDATE hr_departments SET name = $1, is_direct = $2, is_active = $3 WHERE id = $4`,
      [name, bool(req.body?.is_direct, true), bool(req.body?.is_active, true), Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the department."); }
});

function shiftFields(b) {
  const start = String(b.start_time || ""), end = String(b.end_time || "");
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw Object.assign(new Error("Start and end must be times like 09:00."), { expose: true });
  const toMin = (h) => Math.round(Number(h) * 60);
  const full = toMin(b.full_day_hours ?? 7), half = toMin(b.half_day_hours ?? 4);
  if (!(half > 0 && full > half && full <= 1440)) throw Object.assign(new Error("Full-day hours must be more than half-day hours."), { expose: true });
  const grace = Number(b.grace_min ?? 10);
  if (!Number.isInteger(grace) || grace < 0 || grace > 180) throw Object.assign(new Error("Grace must be 0 to 180 minutes."), { expose: true });
  return { name: text(b.name, 60), start, end, grace, full, half };
}
router.post("/shifts", requirePermission("hr.settings", "create"), async (req, res) => {
  try {
    const s = shiftFields(req.body || {});
    if (!s.name) return res.status(400).json({ error: "Name is required." });
    const { rows } = await query(
      `INSERT INTO hr_shifts (name, start_time, end_time, grace_min, full_day_min, half_day_min) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [s.name, s.start, s.end, s.grace, s.full, s.half]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) { friendly(err, res, "Could not add the shift."); }
});
router.patch("/shifts/:id", requirePermission("hr.settings", "edit"), async (req, res) => {
  try {
    const s = shiftFields(req.body || {});
    if (!s.name) return res.status(400).json({ error: "Name is required." });
    await query(
      `UPDATE hr_shifts SET name=$1, start_time=$2, end_time=$3, grace_min=$4, full_day_min=$5, half_day_min=$6, is_active=$7 WHERE id=$8`,
      [s.name, s.start, s.end, s.grace, s.full, s.half, bool(req.body?.is_active, true), Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the shift."); }
});

router.post("/holidays", requirePermission("hr.settings", "create"), async (req, res) => {
  try {
    const d = date(req.body?.holiday_date), name = text(req.body?.name, 80);
    if (!d || !name) return res.status(400).json({ error: "Date and name are required." });
    await query(`INSERT INTO hr_holidays (holiday_date, name) VALUES ($1,$2) ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name`, [d, name]);
    res.status(201).json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the holiday."); }
});
router.delete("/holidays/:date", requirePermission("hr.settings", "delete"), async (req, res) => {
  try {
    const d = date(req.params.date);
    await query(`DELETE FROM hr_holidays WHERE holiday_date = $1`, [d]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not remove the holiday."); }
});

// ============================================================ roster
// Operations staff, one week (or any range up to 31 days) at a time.
router.get("/roster", requirePermission("hr.roster", "view"), async (req, res) => {
  const from = DATE_RE.test(String(req.query.from || "")) ? req.query.from : null;
  const to = DATE_RE.test(String(req.query.to || "")) ? req.query.to : null;
  if (!from || !to || to < from || datesBetween(from, to).length > 31) return res.status(400).json({ error: "Give from and to, at most 31 days apart." });
  try {
    const [emps, entries] = await Promise.all([
      query(`SELECT e.id, e.emp_code, e.name, e.designation, e.default_shift_id, e.weekly_off, d.name AS department
             FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id
             WHERE e.is_active AND e.policy = 'operations' ORDER BY d.sort_order NULLS LAST, e.name`),
      query(`SELECT employee_id, to_char(work_date, 'YYYY-MM-DD') AS work_date, shift_id, is_off
             FROM hr_roster WHERE work_date BETWEEN $1 AND $2`, [from, to]),
    ]);
    res.json({ dates: datesBetween(from, to), employees: emps.rows, entries: entries.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the roster." });
  }
});

// Body: { entries: [{ employee_id, work_date, shift_id | null, is_off, clear }] }
router.put("/roster", requirePermission("hr.roster", "edit"), async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!entries.length || entries.length > 2000) return res.status(400).json({ error: "Nothing to save." });
  try {
    let saved = 0;
    for (const e of entries) {
      const emp = intOrNull(e.employee_id), d = date(e.work_date);
      if (!emp || !d) continue;
      if (e.clear) {
        await query(`DELETE FROM hr_roster WHERE employee_id = $1 AND work_date = $2`, [emp, d]);
      } else {
        const off = !!e.is_off, shift = off ? null : intOrNull(e.shift_id);
        if (!off && !shift) continue;
        await query(
          `INSERT INTO hr_roster (employee_id, work_date, shift_id, is_off, set_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (employee_id, work_date) DO UPDATE SET shift_id = EXCLUDED.shift_id, is_off = EXCLUDED.is_off,
             set_by = EXCLUDED.set_by, set_at = now()`,
          [emp, d, shift, off, req.user.id]);
      }
      saved++;
    }
    res.json({ ok: true, saved });
  } catch (err) { friendly(err, res, "Could not save the roster."); }
});

// ============================================================ attendance
// ?month=YYYY-MM  or  ?from=…&to=… (max 62 days)  [&employee=id]
router.get("/attendance", requirePermission("hr.attendance", "view"), async (req, res) => {
  let from = req.query.from, to = req.query.to;
  if (/^\d{4}-\d{2}$/.test(String(req.query.month || ""))) {
    const [y, m] = req.query.month.split("-").map(Number);
    from = `${req.query.month}-01`;
    to = `${req.query.month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  if (!DATE_RE.test(String(from || "")) || !DATE_RE.test(String(to || "")) || to < from || datesBetween(from, to).length > 62) {
    return res.status(400).json({ error: "Give a month, or from and to at most 62 days apart." });
  }
  try {
    const emp = req.query.employee ? [Number(req.query.employee)].filter(Number.isInteger) : null;
    res.json(await attendanceRegister({ from, to, employeeIds: emp && emp.length ? emp : null }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not work out attendance." });
  }
});

// ============================================================ Round 198 — stage 2
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ADMIN_ROLES = ["administrator", "super_admin"];
const isAdmin = (u) => ADMIN_ROLES.includes(u.role);
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const PAY_MODES = ["cash", "bank_transfer", "upi", "cheque"];

async function monthLocked(month) {
  const { rows } = await query(`SELECT status FROM hr_payroll_runs WHERE month = $1`, [month]);
  return rows[0]?.status === "locked";
}

// ---------------------------------------------------------------- rules
router.put("/rules", requirePermission("hr.settings", "edit"), async (req, res) => {
  try {
    const body = req.body || {};
    for (const [k, v] of Object.entries(body)) {
      const val = validateRule(k, v);
      await query(
        `INSERT INTO hr_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [k, JSON.stringify(val), req.user.id]);
    }
    res.json({ ok: true, rules: await loadRules() });
  } catch (err) { friendly(err, res, "Could not save the rules."); }
});

// ---------------------------------------------------------------- requests
const KINDS = {
  missed_in: "Missed punch — IN", missed_out: "Missed punch — OUT", on_duty: "On duty / site visit", full_day: "Present for the whole day",
};

// Works out whether a request needs Admin rather than the Plant Manager, and why.
async function adminNeed(emp, workDate, kind, excludeId = null) {
  const rules = await loadRules();
  const reasons = [];
  if (emp.app_user_role === "manager") reasons.push("Plant Manager's own request");
  const ageDays = Math.round((Date.parse(istToday()) - Date.parse(workDate)) / 86400000);
  if (ageDays > rules.request_backdate_days) reasons.push(`${ageDays} days old`);
  if (kind === "full_day") reasons.push("whole manual day");
  if (kind === "missed_in" || kind === "missed_out") {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM hr_requests
       WHERE employee_id = $1 AND kind IN ('missed_in','missed_out') AND status IN ('pending','approved')
         AND date_trunc('month', work_date) = date_trunc('month', $2::date) AND ($3::int IS NULL OR id <> $3)`,
      [emp.id, workDate, excludeId]);
    if (rows[0].n >= rules.missed_punch_monthly_limit) reasons.push(`over ${rules.missed_punch_monthly_limit} missed punches this month`);
  }
  return { needs: reasons.length > 0, reason: reasons.join(", ").slice(0, 120) || null };
}

async function loadEmployee(id) {
  const { rows } = await query(
    `SELECT e.*, to_char(e.date_of_joining, 'YYYY-MM-DD') AS date_of_joining, u.role AS app_user_role FROM hr_employees e LEFT JOIN users u ON u.id = e.app_user_id WHERE e.id = $1`, [id]);
  return rows[0] || null;
}

async function createRequest(req, res, emp) {
  const b = req.body || {};
  const workDate = date(b.work_date);
  const kind = b.kind;
  if (!emp || !emp.is_active) return res.status(400).json({ error: "Employee not found or no longer active." });
  if (!workDate || !KINDS[kind]) return res.status(400).json({ error: "Give a date and what needs correcting." });
  if (workDate > istToday()) return res.status(400).json({ error: "That day has not happened yet." });
  if (emp.date_of_joining && workDate < String(emp.date_of_joining).slice(0, 10)) return res.status(400).json({ error: "That is before the joining date." });
  const tin = b.time_in && TIME_RE.test(b.time_in) ? b.time_in : null;
  const tout = b.time_out && TIME_RE.test(b.time_out) ? b.time_out : null;
  if (kind === "missed_in" && !tin) return res.status(400).json({ error: "Give the IN time." });
  if (kind === "missed_out" && !tout) return res.status(400).json({ error: "Give the OUT time." });
  if (kind === "on_duty" && (!tin || !tout)) return res.status(400).json({ error: "Give the time the work outside started and ended." });
  const reason = text(b.reason, 1000);
  if (!reason) return res.status(400).json({ error: "Give a reason." });
  if (await monthLocked(workDate.slice(0, 7))) return res.status(409).json({ error: "Payroll for that month is locked — corrections are closed." });
  const { rows: dup } = await query(
    `SELECT id FROM hr_requests WHERE employee_id = $1 AND work_date = $2 AND kind = $3 AND status = 'pending'`, [emp.id, workDate, kind]);
  if (dup.length) return res.status(409).json({ error: "The same request for that day is already waiting." });
  const need = await adminNeed(emp, workDate, kind);
  const { rows } = await query(
    `INSERT INTO hr_requests (employee_id, work_date, kind, time_in, time_out, reason, needs_admin, admin_reason, raised_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [emp.id, workDate, kind, kind === "missed_out" ? null : tin, kind === "missed_in" ? null : tout, reason, need.needs, need.reason, req.user.id]);
  res.status(201).json({ id: rows[0].id, needs_admin: need.needs, admin_reason: need.reason });
}

// The day's machine punches, shown to the approver next to each request.
async function punchesFor(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r.machine_user_id) continue;
    const { rows: p } = await query(
      `SELECT to_char(punched_at, 'HH24:MI') AS t FROM attendance_punches
       WHERE machine_user_id = $1 AND punched_at >= ($2::date + time '04:00') AND punched_at < ($2::date + 1 + time '04:00')
       ORDER BY punched_at`, [r.machine_user_id, r.work_date]);
    out.set(r.id, p.map((x) => x.t));
  }
  return out;
}

const REQ_SELECT = `
  SELECT r.id, r.employee_id, to_char(r.work_date, 'YYYY-MM-DD') AS work_date, r.kind,
         to_char(r.time_in, 'HH24:MI') AS time_in, to_char(r.time_out, 'HH24:MI') AS time_out,
         r.reason, r.status, r.needs_admin, r.admin_reason, r.raised_at, r.decided_at, r.decision_note,
         e.name AS employee_name, e.emp_code, e.machine_user_id, e.app_user_id, d.name AS department,
         rb.name AS raised_by_name, db.name AS decided_by_name
  FROM hr_requests r
  JOIN hr_employees e ON e.id = r.employee_id
  LEFT JOIN hr_departments d ON d.id = e.department_id
  LEFT JOIN users rb ON rb.id = r.raised_by
  LEFT JOIN users db ON db.id = r.decided_by`;

router.get("/requests", requirePermission("hr.requests", "view"), async (req, res) => {
  try {
    const status = ["pending", "approved", "rejected", "cancelled"].includes(req.query.status) ? req.query.status : null;
    const month = MONTH_RE.test(String(req.query.month || "")) ? req.query.month : null;
    const { rows } = await query(
      `${REQ_SELECT}
       WHERE ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR to_char(r.work_date, 'YYYY-MM') = $2)
       ORDER BY (r.status = 'pending') DESC, r.work_date DESC, r.id DESC LIMIT 500`, [status, month]);
    const punches = await punchesFor(rows);
    const admin = isAdmin(req.user);
    res.json({
      kinds: KINDS,
      requests: rows.map((r) => ({
        ...r, machine_shows: punches.get(r.id) || null,
        can_decide: r.status === "pending" && (admin || !r.needs_admin) && r.app_user_id !== req.user.id,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load requests." });
  }
});

// HR / the Plant Manager raising one for an employee (e.g. someone with no app login).
router.post("/requests", requirePermission("hr.requests", "create"), async (req, res) => {
  try { await createRequest(req, res, await loadEmployee(Number(req.body?.employee_id))); }
  catch (err) { friendly(err, res, "Could not save the request."); }
});

router.post("/requests/:id/decide", requirePermission("hr.requests", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await query(`${REQ_SELECT} WHERE r.id = $1`, [id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found." });
    if (r.status !== "pending") return res.status(409).json({ error: "This request has already been decided." });
    if (r.app_user_id === req.user.id) return res.status(403).json({ error: "Nobody can approve their own request." });
    if (r.needs_admin && !isAdmin(req.user)) return res.status(403).json({ error: `This one needs Admin (${r.admin_reason}).` });
    if (await monthLocked(r.work_date.slice(0, 7))) return res.status(409).json({ error: "Payroll for that month is locked." });
    const approve = !!req.body?.approve;
    const note = text(req.body?.note, 500);
    if (!approve && !note) return res.status(400).json({ error: "Say why it is rejected." });
    await query(`UPDATE hr_requests SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4`,
      [approve ? "approved" : "rejected", req.user.id, note, id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the decision."); }
});

router.post("/requests/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await query(`SELECT status, raised_by FROM hr_requests WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: "Request not found." });
    if (rows[0].status !== "pending") return res.status(409).json({ error: "Only a waiting request can be withdrawn." });
    if (rows[0].raised_by !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: "Only the person who raised it can withdraw it." });
    await query(`UPDATE hr_requests SET status = 'cancelled', decided_by = $1, decided_at = now() WHERE id = $2`, [req.user.id, id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not withdraw the request."); }
});

// ---------------------------------------------------------------- my attendance (self-service)
// Any signed-in person whose login is linked to an employee record. No HR
// permission needed — it only ever shows and touches that one person.
async function myEmployee(req) {
  const { rows } = await query(
    `SELECT e.*, to_char(e.date_of_joining, 'YYYY-MM-DD') AS date_of_joining, u.role AS app_user_role FROM hr_employees e LEFT JOIN users u ON u.id = e.app_user_id
     WHERE e.app_user_id = $1 AND e.is_active LIMIT 1`, [req.user.id]);
  return rows[0] || null;
}
// Cheap check for the header link — no attendance is worked out.
router.get("/my/linked", async (req, res) => {
  try { res.json({ linked: !!(await myEmployee(req)) }); }
  catch (err) { console.error(err); res.json({ linked: false }); }
});
router.get("/my", async (req, res) => {
  try {
    const emp = await myEmployee(req);
    if (!emp) return res.json({ linked: false });
    const month = MONTH_RE.test(String(req.query.month || "")) ? req.query.month : istToday().slice(0, 7);
    const { from, to } = monthRange(month);
    const [reg, reqs] = await Promise.all([
      attendanceRegister({ from, to, employeeIds: [emp.id] }),
      query(`${REQ_SELECT} WHERE r.employee_id = $1 ORDER BY r.work_date DESC, r.id DESC LIMIT 60`, [emp.id]),
    ]);
    res.json({ linked: true, month, employee: { name: emp.name, emp_code: emp.emp_code }, attendance: reg.employees[0] || null,
      dates: reg.dates, requests: reqs.rows, kinds: KINDS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your attendance." });
  }
});
router.post("/my/requests", async (req, res) => {
  try {
    const emp = await myEmployee(req);
    if (!emp) return res.status(403).json({ error: "Your login is not linked to an employee record. Ask HR." });
    await createRequest(req, res, emp);
  } catch (err) { friendly(err, res, "Could not save the request."); }
});

// ---------------------------------------------------------------- advances
router.get("/advances", requirePermission("hr.advances", "view"), async (req, res) => {
  const month = MONTH_RE.test(String(req.query.month || "")) ? req.query.month : istToday().slice(0, 7);
  try {
    const { rows } = await query(
      `SELECT a.id, a.employee_id, to_char(a.given_on, 'YYYY-MM-DD') AS given_on, a.amount, a.mode, a.reference,
              a.recover_month, a.note, e.name AS employee_name, e.emp_code, u.name AS created_by_name
       FROM hr_advances a JOIN hr_employees e ON e.id = a.employee_id LEFT JOIN users u ON u.id = a.created_by
       WHERE a.recover_month = $1 OR to_char(a.given_on, 'YYYY-MM') = $1
       ORDER BY a.given_on DESC, a.id DESC`, [month]);
    res.json({ month, locked: await monthLocked(month), advances: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load advances." });
  }
});
function advanceFields(b) {
  const f = {
    employee_id: intOrNull(b.employee_id), given_on: date(b.given_on), amount: money(b.amount),
    mode: PAY_MODES.includes(b.mode) ? b.mode : "cash", reference: text(b.reference, 100), note: text(b.note, 1000),
    recover_month: MONTH_RE.test(String(b.recover_month || "")) ? b.recover_month : null,
  };
  if (!f.employee_id || !f.given_on || !f.amount) throw Object.assign(new Error("Employee, date and amount are required."), { expose: true });
  if (!f.recover_month) f.recover_month = f.given_on.slice(0, 7);
  return f;
}
router.post("/advances", requirePermission("hr.advances", "create"), async (req, res) => {
  try {
    const f = advanceFields(req.body || {});
    if (await monthLocked(f.recover_month)) return res.status(409).json({ error: `Payroll for ${f.recover_month} is locked — recover it from a later month.` });
    const { rows } = await query(
      `INSERT INTO hr_advances (employee_id, given_on, amount, mode, reference, recover_month, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [f.employee_id, f.given_on, f.amount, f.mode, f.reference, f.recover_month, f.note, req.user.id]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) { friendly(err, res, "Could not save the advance."); }
});
router.patch("/advances/:id", requirePermission("hr.advances", "edit"), async (req, res) => {
  try {
    const { rows: cur } = await query(`SELECT recover_month FROM hr_advances WHERE id = $1`, [Number(req.params.id)]);
    if (!cur[0]) return res.status(404).json({ error: "Advance not found." });
    const f = advanceFields(req.body || {});
    if (await monthLocked(cur[0].recover_month) || await monthLocked(f.recover_month)) return res.status(409).json({ error: "That payroll month is locked." });
    await query(`UPDATE hr_advances SET employee_id=$1, given_on=$2, amount=$3, mode=$4, reference=$5, recover_month=$6, note=$7 WHERE id=$8`,
      [f.employee_id, f.given_on, f.amount, f.mode, f.reference, f.recover_month, f.note, Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the advance."); }
});
router.delete("/advances/:id", requirePermission("hr.advances", "delete"), async (req, res) => {
  try {
    const { rows: cur } = await query(`SELECT recover_month FROM hr_advances WHERE id = $1`, [Number(req.params.id)]);
    if (!cur[0]) return res.status(404).json({ error: "Advance not found." });
    if (await monthLocked(cur[0].recover_month)) return res.status(409).json({ error: "That payroll month is locked." });
    await query(`DELETE FROM hr_advances WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not remove the advance."); }
});

// ---------------------------------------------------------------- payroll
async function saveLines(month, result, userId, { onlyIds = null } = {}) {
  await query(
    `INSERT INTO hr_payroll_runs (month, status, computed_at, computed_by, rules) VALUES ($1, 'draft', now(), $2, $3)
     ON CONFLICT (month) DO UPDATE SET computed_at = now(), computed_by = EXCLUDED.computed_by, rules = EXCLUDED.rules`,
    [month, userId, JSON.stringify(result.rules)]);
  for (const l of result.lines) {
    await query(
      `INSERT INTO hr_payroll_lines (month, employee_id, calc, net_pay, cost_to_company) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (month, employee_id) DO UPDATE SET calc = EXCLUDED.calc, net_pay = EXCLUDED.net_pay, cost_to_company = EXCLUDED.cost_to_company`,
      [month, l.employee_id, JSON.stringify(l.calc), l.net_pay, l.cost_to_company]);
  }
  if (!onlyIds) {
    // someone no longer in the month (e.g. joining date corrected) — drop their unpaid line
    await query(`DELETE FROM hr_payroll_lines WHERE month = $1 AND paid_amount IS NULL AND NOT (employee_id = ANY($2::int[]))`,
      [month, result.lines.map((l) => l.employee_id)]);
  }
}

router.get("/payroll", requirePermission("hr.payroll", "view"), async (req, res) => {
  const month = MONTH_RE.test(String(req.query.month || "")) ? req.query.month : null;
  if (!month) return res.status(400).json({ error: "Give a month." });
  try {
    const [run, lines] = await Promise.all([
      query(`SELECT r.*, cu.name AS computed_by_name, lu.name AS locked_by_name FROM hr_payroll_runs r
             LEFT JOIN users cu ON cu.id = r.computed_by LEFT JOIN users lu ON lu.id = r.locked_by WHERE r.month = $1`, [month]),
      query(`SELECT l.*, to_char(l.paid_on, 'YYYY-MM-DD') AS paid_on, e.name, e.emp_code, e.designation, e.employment_type,
                    e.contractor_name, d.name AS department
             FROM hr_payroll_lines l JOIN hr_employees e ON e.id = l.employee_id LEFT JOIN hr_departments d ON d.id = e.department_id
             WHERE l.month = $1 ORDER BY e.employment_type, d.sort_order NULLS LAST, e.name`, [month]),
    ]);
    const { to } = monthRange(month);
    const pending = await query(`SELECT count(*)::int AS n FROM hr_requests WHERE status = 'pending' AND to_char(work_date, 'YYYY-MM') = $1`, [month]);
    res.json({ month, run: run.rows[0] || null, lines: lines.rows, month_finished: to < istToday(), pending_requests: pending.rows[0].n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load payroll." });
  }
});

router.post("/payroll/:month/calculate", requirePermission("hr.payroll", "create"), async (req, res) => {
  const month = req.params.month;
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: "Bad month." });
  try {
    if (await monthLocked(month)) return res.status(409).json({ error: "This month is locked. Unlock it first to recalculate." });
    const result = await computePayroll(month);
    await saveLines(month, result, req.user.id);
    res.json({ ok: true, lines: result.lines.length });
  } catch (err) { friendly(err, res, "Could not calculate payroll."); }
});

router.patch("/payroll/:month/lines/:emp", requirePermission("hr.payroll", "edit"), async (req, res) => {
  const month = req.params.month, emp = Number(req.params.emp);
  if (!MONTH_RE.test(month) || !Number.isInteger(emp)) return res.status(400).json({ error: "Bad request." });
  try {
    if (await monthLocked(month)) return res.status(409).json({ error: "This month is locked." });
    const b = req.body || {};
    const ot = b.ot_hours === "" || b.ot_hours === null || b.ot_hours === undefined ? null : Number(b.ot_hours);
    if (ot !== null && !(Number.isFinite(ot) && ot >= 0 && ot <= 300)) return res.status(400).json({ error: "Overtime hours must be 0 to 300." });
    const { rowCount } = await query(
      `UPDATE hr_payroll_lines SET ot_hours = $1, other_earning = $2, other_deduction = $3, remarks = $4 WHERE month = $5 AND employee_id = $6`,
      [ot, money(b.other_earning) || 0, money(b.other_deduction) || 0, text(b.remarks, 500), month, emp]);
    if (!rowCount) return res.status(404).json({ error: "Calculate the month first." });
    const result = await computePayroll(month, { employeeIds: [emp] });
    await saveLines(month, result, req.user.id, { onlyIds: [emp] });
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the change."); }
});

router.post("/payroll/:month/lock", requirePermission("hr.payroll", "edit"), async (req, res) => {
  const month = req.params.month;
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: "Bad month." });
  try {
    if (await monthLocked(month)) return res.status(409).json({ error: "Already locked." });
    if (monthRange(month).to >= istToday()) return res.status(409).json({ error: "The month has not finished yet." });
    // Final calculation with everything as it stands now, then freeze.
    const result = await computePayroll(month);
    await saveLines(month, result, req.user.id);
    await query(`UPDATE hr_payroll_runs SET status = 'locked', locked_at = now(), locked_by = $1 WHERE month = $2`, [req.user.id, month]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not lock the month."); }
});

router.post("/payroll/:month/unlock", requirePermission("hr.payroll", "delete"), async (req, res) => {
  const month = req.params.month;
  try {
    const { rows } = await query(`SELECT count(*)::int AS n FROM hr_payroll_lines WHERE month = $1 AND paid_amount IS NOT NULL`, [month]);
    if (rows[0].n) return res.status(409).json({ error: `${rows[0].n} salary payment(s) are already recorded for this month. Remove them first.` });
    await query(`UPDATE hr_payroll_runs SET status = 'draft', locked_at = NULL, locked_by = NULL WHERE month = $1`, [month]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not unlock the month."); }
});

// Salary / wages paid. Only on a locked month, so what was paid is what was approved.
router.put("/payroll/:month/lines/:emp/payment", requirePermission("hr.payroll", "edit"), async (req, res) => {
  const month = req.params.month, emp = Number(req.params.emp);
  try {
    if (!(await monthLocked(month))) return res.status(409).json({ error: "Lock the month before recording payments." });
    const b = req.body || {};
    if (b.clear) {
      await query(`UPDATE hr_payroll_lines SET paid_amount = NULL, paid_on = NULL, paid_mode = NULL, paid_ref = NULL, paid_by = NULL
                   WHERE month = $1 AND employee_id = $2`, [month, emp]);
      return res.json({ ok: true });
    }
    const amount = money(b.paid_amount), on = date(b.paid_on);
    if (amount === null || !on) return res.status(400).json({ error: "Give the amount paid and the date." });
    const { rowCount } = await query(
      `UPDATE hr_payroll_lines SET paid_amount = $1, paid_on = $2, paid_mode = $3, paid_ref = $4, paid_by = $5 WHERE month = $6 AND employee_id = $7`,
      [amount, on, PAY_MODES.includes(b.paid_mode) ? b.paid_mode : "bank_transfer", text(b.paid_ref, 100), req.user.id, month, emp]);
    if (!rowCount) return res.status(404).json({ error: "No payroll line for that employee." });
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not record the payment."); }
});

router.post("/payroll/:month/pay-all", requirePermission("hr.payroll", "edit"), async (req, res) => {
  const month = req.params.month;
  try {
    if (!(await monthLocked(month))) return res.status(409).json({ error: "Lock the month before recording payments." });
    const on = date(req.body?.paid_on);
    if (!on) return res.status(400).json({ error: "Give the payment date." });
    const mode = PAY_MODES.includes(req.body?.paid_mode) ? req.body.paid_mode : "bank_transfer";
    const { rowCount } = await query(
      `UPDATE hr_payroll_lines SET paid_amount = net_pay, paid_on = $1, paid_mode = $2, paid_ref = $3, paid_by = $4
       WHERE month = $5 AND paid_amount IS NULL AND net_pay > 0
         AND ($6::text IS NULL OR employee_id IN (SELECT id FROM hr_employees WHERE employment_type = $6))`,
      [on, mode, text(req.body?.paid_ref, 100), req.user.id, month, ["payroll", "contract"].includes(req.body?.only) ? req.body.only : null]);
    res.json({ ok: true, paid: rowCount });
  } catch (err) { friendly(err, res, "Could not record the payments."); }
});

export default router;
