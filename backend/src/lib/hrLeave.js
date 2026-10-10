// Round 202 — leave balances, worked out in one place for the HR screens,
// My attendance and the approval check, so they can never disagree.
//
// A leave type gives `yearly_days` days per PERIOD (the column keeps its Round
// 200 name; for a monthly type it is days a month):
//   period 'year'  — Jan–Dec
//   period 'month' — each calendar month (the owner's CL: 1 a month)
// Days not taken by the period end lapse, unless carry_max is set, in which
// case up to that many move into the next period.
// not_on_probation — nothing is given for a period that starts before the
//   person's probation ends (joining date + probation_months).
// for_contract = false — contract workers get none of it.
// A leave counts in the period its first day falls in.
//
// Comp-off (kind 'comp_off') has no allowance: an approved claim for a worked
// off day is a credit that expires co_expiry_days after the day worked. A CO
// leave (approved or waiting) uses the credit that expires first among those
// earned before the leave and still valid on its date.
import { query } from "../db.js";

export async function leaveTypes(activeOnly = false) {
  const { rows } = await query(`SELECT * FROM hr_leave_types ${activeOnly ? "WHERE is_active" : ""} ORDER BY sort_order, code`);
  return rows.map((t) => ({ ...t, yearly_days: t.yearly_days == null ? null : Number(t.yearly_days),
    carry_max: t.carry_max == null ? null : Number(t.carry_max) }));
}

const r1 = (n) => Math.round(n * 10) / 10;
function addMonths(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
export function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); // ist-ok: calendar arithmetic on a date string, no clock
}
const periodKey = (t, ymd) => (t.period === "month" ? ymd.slice(0, 7) : ymd.slice(0, 4));
const periodStart = (t, key) => (t.period === "month" ? `${key}-01` : `${key}-01-01`);
const nextKey = (t, key) => (t.period === "month" ? addMonths(`${key}-01`, 1).slice(0, 7) : String(Number(key) + 1));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const periodLabel = (t, key) => (t.period === "month" ? `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}` : key);

export function probationEnd(emp, months) {
  const j = emp.date_of_joining ? String(emp.date_of_joining).slice(0, 10) : null;
  return j && months ? addMonths(j, Number(months)) : null;
}

// Whether a type can be given to this person at all, and from when.
export function eligibility(emp, type, rules) {
  if (type.kind === "comp_off") return { ok: true };
  if (!type.for_contract && emp.employment_type === "contract") return { ok: false, reason: `${type.name} is not given to contract workers.` };
  if (type.not_on_probation) {
    const pe = probationEnd(emp, rules.probation_months);
    if (pe) return { ok: true, from: pe, reason: `${type.name} is not given during probation (until ${pe}).` };
  }
  return { ok: true };
}

// The balance of one normal type for one person on `asOf`, from their leaves.
function normalBalance(emp, type, rules, leaves, asOf) {
  const el = eligibility(emp, type, rules);
  const cur = periodKey(type, asOf);
  const mine = leaves.filter((l) => l.leave_type_id === type.id);
  const inP = (key, status) => mine.filter((l) => periodKey(type, l.from_date) === key && l.status === status).reduce((a, l) => a + l.days, 0);
  const base = { leave_type_id: type.id, code: type.code, name: type.name, paid: type.paid, kind: type.kind, period: type.period,
    period_label: periodLabel(type, cur), eligible: el.ok, not_eligible_reason: el.ok ? null : el.reason };
  if (type.yearly_days == null) return { ...base, allowance: null, carried: 0, used: r1(inP(cur, "approved")), waiting: r1(inP(cur, "pending")), left: null };
  // Walk the periods so carry forward builds up correctly (at most 3 years back).
  const joined = emp.date_of_joining ? String(emp.date_of_joining).slice(0, 10) : null;
  const back = addMonths(asOf, -36);
  let key = periodKey(type, joined && joined > back ? joined : back);
  let prevLeft = 0, avail = 0, carried = 0;
  for (let guard = 0; guard < 60; guard++) {
    const given = !el.ok ? 0 : el.from && periodStart(type, key) < el.from ? 0 : type.yearly_days;
    carried = type.carry_max > 0 ? Math.min(type.carry_max, Math.max(0, prevLeft)) : 0;
    avail = given + carried;
    if (key === cur) break;
    prevLeft = avail - inP(key, "approved");
    key = nextKey(type, key);
  }
  const used = inP(cur, "approved"), waiting = inP(cur, "pending");
  const inProbation = el.from && periodStart(type, cur) < el.from;
  return { ...base, allowance: r1(avail), carried: r1(carried), used: r1(used), waiting: r1(waiting), left: r1(avail - used),
    eligible: el.ok && !inProbation, not_eligible_reason: !el.ok ? el.reason : inProbation ? el.reason : null };
}

// Comp-off: credits used first-to-expire. Returns the balance on `asOf` and,
// per credit, what is left — the basis for checking a new CO leave.
export function compoffLedger(claims, coLeaves, asOf) {
  const credits = claims.filter((c) => c.status === "approved")
    .map((c) => ({ id: c.id, work_date: c.work_date, expires_on: c.expires_on, days: c.days, left: c.days }))
    .sort((a, b) => (a.expires_on < b.expires_on ? -1 : a.expires_on > b.expires_on ? 1 : a.id - b.id));
  const uses = [...coLeaves].sort((a, b) => (a.from_date < b.from_date ? -1 : 1));
  let unfunded = 0;
  for (const u of uses) {
    let need = u.days;
    for (const c of credits) {
      if (need <= 0) break;
      if (c.left <= 0 || c.work_date >= u.from_date || c.expires_on < u.from_date) continue;
      const take = Math.min(c.left, need); c.left -= take; need -= take;
    }
    unfunded += need;
  }
  const valid = credits.filter((c) => c.expires_on >= asOf && c.left > 0);
  const lapsed = credits.filter((c) => c.expires_on < asOf).reduce((a, c) => a + c.left, 0);
  const next = valid[0] || null;
  return {
    earned: r1(credits.reduce((a, c) => a + c.days, 0)),
    used: r1(uses.filter((u) => u.status === "approved").reduce((a, u) => a + u.days, 0)),
    waiting: r1(uses.filter((u) => u.status === "pending").reduce((a, u) => a + u.days, 0)),
    lapsed: r1(lapsed), left: r1(valid.reduce((a, c) => a + c.left, 0)), unfunded: r1(unfunded),
    next_expiry: next ? { days: r1(next.left), on: next.expires_on } : null,
    credits,
  };
}

async function loadFor(employeeIds, asOf, excludeLeaveId) {
  const from = addMonths(asOf, -40);
  const [lv, cl] = await Promise.all([
    query(`SELECT id, employee_id, leave_type_id, status, days::float AS days, to_char(from_date, 'YYYY-MM-DD') AS from_date
           FROM hr_leaves WHERE employee_id = ANY($1::int[]) AND status IN ('approved','pending') AND from_date >= $2
             AND ($3::int IS NULL OR id <> $3)`, [employeeIds, from, excludeLeaveId || null]),
    query(`SELECT id, employee_id, status, days::float AS days, to_char(work_date, 'YYYY-MM-DD') AS work_date,
                  to_char(expires_on, 'YYYY-MM-DD') AS expires_on
           FROM hr_compoff_claims WHERE employee_id = ANY($1::int[]) AND status IN ('approved','pending') AND work_date >= $2`, [employeeIds, from]),
  ]);
  return { leaves: lv.rows, claims: cl.rows };
}

// Balances of every active type for each employee on `asOf`.
export async function computeBalances(emps, asOf, rules, { excludeLeaveId = null } = {}) {
  const types = (await leaveTypes()).filter((t) => t.is_active);
  const out = new Map();
  if (!emps.length) return out;
  const { leaves, claims } = await loadFor(emps.map((e) => e.id), asOf, excludeLeaveId);
  for (const emp of emps) {
    const myLeaves = leaves.filter((l) => l.employee_id === emp.id);
    out.set(emp.id, types.map((t) => {
      if (t.kind !== "comp_off") return normalBalance(emp, t, rules, myLeaves, asOf);
      const led = compoffLedger(claims.filter((c) => c.employee_id === emp.id), myLeaves.filter((l) => l.leave_type_id === t.id), asOf);
      return { leave_type_id: t.id, code: t.code, name: t.name, paid: t.paid, kind: t.kind, period: null, period_label: "comp-off",
        eligible: true, allowance: null, carried: 0, used: led.used, waiting: led.waiting, left: led.left, earned: led.earned,
        lapsed: led.lapsed, next_expiry: led.next_expiry, claims_waiting: r1(claims.filter((c) => c.employee_id === emp.id && c.status === "pending").reduce((a, c) => a + c.days, 0)) };
    }));
  }
  return out;
}

// How many comp-off days could fund a new CO leave starting on `date`.
export async function compoffAvailable(empId, coTypeId, date, excludeLeaveId = null) {
  const { leaves, claims } = await loadFor([empId], date, excludeLeaveId);
  const led = compoffLedger(claims, leaves.filter((l) => l.leave_type_id === coTypeId), date);
  return r1(led.credits.filter((c) => c.work_date < date && c.expires_on >= date).reduce((a, c) => a + c.left, 0));
}
