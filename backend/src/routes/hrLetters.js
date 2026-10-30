// Round 250 — appointment letters (owner, 30 Oct 2026): "incorporated in HR
// module in employee, and should be able to print with all the details and
// photo of employee". The terms are the company's standard (Ver 3) — the text
// lives with the print (frontend/src/lib/appointmentLetter.js); what is set
// per letter is stored here.
//
//   GET   /api/hr/employees/:id/appointment-letters   the employee's letters + defaults for a new one
//   POST  /api/hr/employees/:id/appointment-letters   new draft (Ref. No. given now)   hr.appointment-letter · create
//   PATCH /api/hr/appointment-letters/:id             change a draft                   hr.appointment-letter · edit
//   POST  /api/hr/appointment-letters/:id/issue       lock it (issued)                 hr.appointment-letter · edit
//   POST  /api/hr/appointment-letters/:id/cancel      cancel (draft or issued)         hr.appointment-letter · delete
//   GET   /api/hr/appointment-letters/:id/print       everything the printout needs, with the photo
//   GET   /api/hr/letter-settings                     default signatory               hr.settings · view
//   PUT   /api/hr/letter-settings                                                    hr.settings · edit
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { istDay } from "../lib/istDate.js";
import { ensureRound250 } from "../lib/round250Schema.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound250(query); next(); } catch (e) { next(e); } });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const txt = (v, n) => (String(v ?? "").trim().slice(0, n) || null);
const int = (v, lo, hi, dflt) => {
  if (v === "" || v == null) return dflt;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : NaN;
};
// The rows of the salary table on the letter, in the order of the company's format.
export const SALARY_ROWS = ["Basic Salary", "Other Allowance", "HRA", "Allowance", "Incentive / Over Time"];
const EMP_COLS = `e.id, e.name, e.emp_code, e.designation, d.name AS department, to_char(e.date_of_joining, 'YYYY-MM-DD') AS date_of_joining,
                  e.relation_type, e.relation_name, e.address, e.employment_type, e.is_active`;

function fyOf(ymd) {
  const [y, m] = ymd.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
async function settings() {
  const { rows } = await query(`SELECT key, value FROM hr_letter_settings`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value || ""]));
}
async function employee(id) {
  const { rows } = await query(`SELECT ${EMP_COLS} FROM hr_employees e LEFT JOIN hr_departments d ON d.id = e.department_id WHERE e.id = $1`, [id]);
  return rows[0] || null;
}
// What the employee file says now — frozen into the letter when it is issued.
const snapshotOf = (e) => ({
  name: e.name, emp_code: e.emp_code, relation_type: e.relation_type || null, relation_name: e.relation_name || null,
  address: e.address || null, employment_type: e.employment_type,
});

function salaryBody(list) {
  const src = Array.isArray(list) ? list : [];
  return SALARY_ROWS.map((label, i) => {
    const r = src[i] || {};
    const amount = r.amount === "" || r.amount == null ? null : Number(r.amount);
    if (amount != null && !(Number.isFinite(amount) && amount >= 0 && amount < 1e8)) {
      throw Object.assign(new Error(`${label}: enter an amount in rupees.`), { expose: true });
    }
    return { label, amount: amount == null ? null : Math.round(amount * 100) / 100, note: txt(r.note, 60) };
  });
}
function letterBody(b) {
  const f = {
    issue_date: DAY_RE.test(b.issue_date || "") ? b.issue_date : null,
    joining_date: DAY_RE.test(b.joining_date || "") ? b.joining_date : null,
    designation: txt(b.designation, 80),
    department: txt(b.department, 80),
    work_location: txt(b.work_location, 120),
    reporting_to: txt(b.reporting_to, 120),
    probation_months: int(b.probation_months, 0, 12, 3),
    notice_probation_days: int(b.notice_probation_days, 0, 180, 30),
    notice_after_months: int(b.notice_after_months, 0, 6, 1),
    salary: JSON.stringify(salaryBody(b.salary)),
    signatory_name: txt(b.signatory_name, 120),
    signatory_designation: txt(b.signatory_designation, 80),
    print_photo: b.print_photo !== false,
  };
  if (!f.issue_date) throw Object.assign(new Error("Enter the date of issue."), { expose: true });
  if (!f.joining_date) throw Object.assign(new Error("Enter the joining (effective) date."), { expose: true });
  if (!f.designation) throw Object.assign(new Error("Enter the designation."), { expose: true });
  if (Number.isNaN(f.probation_months)) throw Object.assign(new Error("Probation: 0 to 12 months."), { expose: true });
  if (Number.isNaN(f.notice_probation_days)) throw Object.assign(new Error("Notice during probation: 0 to 180 days."), { expose: true });
  if (Number.isNaN(f.notice_after_months)) throw Object.assign(new Error("Notice after confirmation: 0 to 6 months."), { expose: true });
  return f;
}
function fail(err, res, msg) {
  if (err.expose) return bad(res, err.message);
  console.error(err);
  res.status(500).json({ error: msg });
}
const LETTER_COLS = `l.id, l.employee_id, l.ref_no, to_char(l.issue_date, 'YYYY-MM-DD') AS issue_date, to_char(l.joining_date, 'YYYY-MM-DD') AS joining_date,
  l.designation, l.department, l.work_location, l.reporting_to, l.probation_months, l.notice_probation_days, l.notice_after_months,
  l.salary, l.signatory_name, l.signatory_designation, l.print_photo, l.template_version, l.emp_snapshot, l.status,
  l.created_at, cu.name AS created_by, l.updated_at, l.issued_at, iu.name AS issued_by, l.cancelled_at, xu.name AS cancelled_by`;
const LETTER_FROM = `FROM hr_appointment_letters l LEFT JOIN users cu ON cu.id = l.created_by
  LEFT JOIN users iu ON iu.id = l.issued_by LEFT JOIN users xu ON xu.id = l.cancelled_by`;

// ------------------------------------------------------------------ list --
router.get("/employees/:id/appointment-letters", requirePermission("hr.appointment-letter", "view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, "Invalid employee.");
  try {
    const e = await employee(id);
    if (!e) return bad(res, "Employee not found.", 404);
    const [{ rows: letters }, s] = await Promise.all([
      query(`SELECT ${LETTER_COLS} ${LETTER_FROM} WHERE l.employee_id = $1 ORDER BY l.id DESC`, [id]),
      settings(),
    ]);
    // Defaults for a new letter: from the employee file and the settings.
    let salary = SALARY_ROWS.map((label) => ({ label, amount: null, note: null }));
    if (await can(req.user, "hr.salary", "view")) {
      const { rows } = await query(`SELECT salary_basic, salary_da, salary_hra, salary_conveyance, salary_special FROM hr_employees WHERE id = $1`, [id]);
      const p = rows[0] || {};
      const n = (v) => (v == null ? null : Number(v));
      const allow = (n(p.salary_conveyance) || 0) + (n(p.salary_special) || 0);
      salary = [
        { label: SALARY_ROWS[0], amount: n(p.salary_basic), note: null },
        { label: SALARY_ROWS[1], amount: n(p.salary_da), note: null },
        { label: SALARY_ROWS[2], amount: n(p.salary_hra), note: null },
        { label: SALARY_ROWS[3], amount: allow || null, note: null },
        { label: SALARY_ROWS[4], amount: null, note: "As per policy" },
      ];
    } else {
      salary[4].note = "As per policy";
    }
    res.json({
      employee: e,
      letters,
      settings: s,
      defaults: {
        issue_date: istDay(),
        joining_date: e.date_of_joining || "",
        designation: e.designation || "",
        department: e.department || "",
        work_location: s.work_location || "",
        reporting_to: "Plant Manager",
        probation_months: e.employment_type === "contract" ? 0 : 3,
        notice_probation_days: 30,
        notice_after_months: 1,
        salary,
        signatory_name: s.signatory_name || "",
        signatory_designation: s.signatory_designation || "Managing Partner",
        print_photo: true,
      },
    });
  } catch (err) { fail(err, res, "Could not load the appointment letters."); }
});

// ---------------------------------------------------------------- create --
router.post("/employees/:id/appointment-letters", requirePermission("hr.appointment-letter", "create"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, "Invalid employee.");
  try {
    const e = await employee(id);
    if (!e) return bad(res, "Employee not found.", 404);
    const f = letterBody(req.body || {});
    const fy = fyOf(f.issue_date);
    // The next number in the financial year; retried if two are made at once.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { rows: m } = await query(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM hr_appointment_letters WHERE fy = $1`, [fy]);
      const seq = m[0].n;
      const ref = `OORM/HR/APT/${fy}/${String(seq).padStart(3, "0")}`;
      try {
        const cols = { ...f, employee_id: id, ref_no: ref, fy, seq, emp_snapshot: JSON.stringify(snapshotOf(e)), created_by: req.user.id };
        const keys = Object.keys(cols);
        const { rows } = await query(
          `INSERT INTO hr_appointment_letters (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, ref_no`,
          keys.map((k) => cols[k]));
        return res.status(201).json(rows[0]);
      } catch (err) {
        if (err.code !== "23505") throw err;
      }
    }
    bad(res, "Could not give the letter a number — try again.", 409);
  } catch (err) { fail(err, res, "Could not create the letter."); }
});

async function letterRow(id) {
  const { rows } = await query(`SELECT id, employee_id, status FROM hr_appointment_letters WHERE id = $1`, [id]);
  return rows[0] || null;
}

// ------------------------------------------------------------ edit draft --
router.patch("/appointment-letters/:id", requirePermission("hr.appointment-letter", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, "Invalid letter.");
  try {
    const cur = await letterRow(id);
    if (!cur) return bad(res, "Letter not found.", 404);
    if (cur.status !== "draft") return bad(res, "This letter has been issued and is locked. Make a new letter to change it.", 409);
    const f = letterBody(req.body || {});
    const e = await employee(cur.employee_id);
    f.emp_snapshot = JSON.stringify(snapshotOf(e));
    f.updated_by = req.user.id;
    const keys = Object.keys(f);
    await query(`UPDATE hr_appointment_letters SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = now()
                  WHERE id = $${keys.length + 1} AND status = 'draft'`, [...keys.map((k) => f[k]), id]);
    res.json({ ok: true });
  } catch (err) { fail(err, res, "Could not save the letter."); }
});

// ----------------------------------------------------------------- issue --
router.post("/appointment-letters/:id/issue", requirePermission("hr.appointment-letter", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, "Invalid letter.");
  try {
    const cur = await letterRow(id);
    if (!cur) return bad(res, "Letter not found.", 404);
    if (cur.status !== "draft") return bad(res, "Only a draft can be issued.", 409);
    const e = await employee(cur.employee_id);
    if (!e.address) return bad(res, `Add ${e.name}'s address on the employee file first — it prints in the letter.`);
    await query(`UPDATE hr_appointment_letters SET status = 'issued', emp_snapshot = $1, issued_by = $2, issued_at = now()
                  WHERE id = $3 AND status = 'draft'`, [JSON.stringify(snapshotOf(e)), req.user.id, id]);
    res.json({ ok: true });
  } catch (err) { fail(err, res, "Could not issue the letter."); }
});

// ---------------------------------------------------------------- cancel --
router.post("/appointment-letters/:id/cancel", requirePermission("hr.appointment-letter", "delete"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, "Invalid letter.");
  try {
    const { rowCount } = await query(`UPDATE hr_appointment_letters SET status = 'cancelled', cancelled_by = $1, cancelled_at = now()
                                        WHERE id = $2 AND status IN ('draft','issued')`, [req.user.id, id]);
    if (!rowCount) return bad(res, "This letter is already cancelled or does not exist.", 409);
    res.json({ ok: true });
  } catch (err) { fail(err, res, "Could not cancel the letter."); }
});

// ----------------------------------------------------------------- print --
router.get("/appointment-letters/:id/print", requirePermission("hr.appointment-letter", "view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, "Invalid letter.");
  try {
    const { rows } = await query(`SELECT ${LETTER_COLS} ${LETTER_FROM} WHERE l.id = $1`, [id]);
    const l = rows[0];
    if (!l) return bad(res, "Letter not found.", 404);
    // A draft prints what the employee file says now; an issued letter what it said when issued.
    if (l.status === "draft") l.emp_snapshot = snapshotOf(await employee(l.employee_id));
    let photo = null;
    if (l.print_photo) {
      const { rows: p } = await query(`SELECT photo, mime FROM hr_employee_photos WHERE employee_id = $1`, [l.employee_id]);
      if (p[0]) photo = `data:${p[0].mime};base64,${p[0].photo.toString("base64")}`;
    }
    res.json({ letter: l, photo });
  } catch (err) { fail(err, res, "Could not prepare the letter."); }
});

// -------------------------------------------------------------- settings --
router.get("/letter-settings", requirePermission("hr.settings", "view"), async (_req, res) => {
  try { res.json(await settings()); } catch (err) { fail(err, res, "Could not load the letter settings."); }
});
router.put("/letter-settings", requirePermission("hr.settings", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const vals = {
      signatory_name: txt(b.signatory_name, 120) || "",
      signatory_designation: txt(b.signatory_designation, 80) || "Managing Partner",
      work_location: txt(b.work_location, 120) || "",
    };
    for (const [k, v] of Object.entries(vals)) {
      await query(`INSERT INTO hr_letter_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
    }
    res.json({ ok: true });
  } catch (err) { fail(err, res, "Could not save the letter settings."); }
});

export default router;
