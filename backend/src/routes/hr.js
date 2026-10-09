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
  "pf_applicable", "esi_applicable", "daily_rate", "service_charge_pct", "incentive_basis", "incentive_min_m3", "incentive_rate"];

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
    const [deps, shifts, hols, mUsers, appUsers] = await Promise.all([
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
    ]);
    res.json({
      departments: deps.rows, shifts: shifts.rows, holidays: hols.rows,
      machine_users: mUsers.rows, app_users: appUsers.rows,
      can_salary: await can(req.user, "hr.salary", "view"),
      can_salary_edit: await can(req.user, "hr.salary", "edit"),
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
      incentive_basis: ["none", "plant_production", "own_sales"].includes(b.incentive_basis) ? b.incentive_basis : "none",
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

export default router;
