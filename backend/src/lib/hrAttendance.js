// Round 197 — turning punches into an attendance day.
//
// Inputs are read fresh every time (nothing here is stored), so changing a
// roster, a shift or an employee's machine number re-reads the month at once.
//
// THE RULES (user's decisions, 9 Oct 2026):
//   * Office staff: fixed shift (seeded "Office 9 to 5"). Late in / early out
//     beyond the grace minutes is HIGHLIGHTED only — no deduction; the
//     Administrator decides what to do about it.
//   * Operations staff: the shift is whatever the manager put on the roster
//     for that day. No roster entry = no fixed times: the day is judged on
//     hours alone, and nothing is late.
//   * Sales & marketing (attendance source "app"): a day counts only when the
//     sales app's duty Punch In carried a location (sales_duty_log).
//   * One punch only = MIS (missed punch). It stays MIS here; what it becomes
//     when payroll is locked is decided in stage 2.
//
// DAY CODES  P present · HD half day · A absent · MIS missed punch ·
//            NL app check-in without location · WO weekly off / rostered off ·
//            H holiday · IN still at work (today) · "" future / not employed.
//
// WHICH DAY A PUNCH BELONGS TO. Normally 04:00 to 04:00 IST, so a late
// overtime punch at 01:30 stays on the day it belongs to. When the day's shift
// runs past midnight (end before start, e.g. 22:00–06:00) that day's window is
// stretched to 4 hours after the shift ends, and the next day starts there.

import { query } from "../db.js";
import { loadRules } from "./hrRules.js";

export const DEFAULT_FULL_MIN = 420; // hours-only days (no shift): 7 h = full day
export const DEFAULT_HALF_MIN = 240; //                               4 h = half day

const IST_MS = 330 * 60000;
const DAY_MS = 86400000;

// "YYYY-MM-DD" + minutes after local midnight -> epoch ms (IST)
function at(date, minutes) {
  return Date.parse(date + "T00:00:00+05:30") + minutes * 60000;
}
function hhmm(ms) {
  const d = new Date(ms + IST_MS);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}
function timeToMin(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + (m || 0);
}
export function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10)); // ist-ok: pure calendar stepping from a UTC-midnight date string
  }
  return out;
}
function dow(date) {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

function shiftOf(s) {
  if (!s) return null;
  const start = timeToMin(s.start_time);
  let end = timeToMin(s.end_time);
  if (end <= start) end += 1440; // runs past midnight
  return { id: s.id, name: s.name, start, end, grace: s.grace_min, full: s.full_day_min, half: s.half_day_min };
}

// The pure part: one employee, a list of dates, everything already loaded.
//   emp       hr_employees row
//   events    [{ ms, kind: "punch"|"on"|"off", located }]  sorted
//   plan      date -> { shift, off }  (roster, already merged with default shift)
//   holidays  Map date -> name
//   todayDate "YYYY-MM-DD" (attendance day of now)
//   opts.reqs   Map date -> { full, pending }   (Round 198 requests)
//   opts.rules  overtime rules (lib/hrRules.js)
export function computeEmployeeDays(emp, dates, events, plan, holidays, todayDate, nowMs, opts = {}) {
  const rules = opts.rules || {};
  const days = [];
  // window per date
  const windows = [];
  let carry = null;
  for (const d of dates) {
    const p = plan.get(d) || {};
    let ws = at(d, 240);
    if (carry && carry > ws) ws = carry;
    let we = at(d, 1440 + 240);
    if (p.shift && p.shift.end > 1440) {
      we = Math.max(we, at(d, p.shift.end + 240));
    }
    windows.push([ws, we]);
    carry = we;
  }
  let i = 0;
  const firstWs = windows.length ? windows[0][0] : 0;
  while (i < events.length && events[i].ms < firstWs) i++;

  const joined = emp.date_of_joining ? String(emp.date_of_joining).slice(0, 10) : null;
  const left = emp.date_of_leaving ? String(emp.date_of_leaving).slice(0, 10) : null;

  dates.forEach((d, idx) => {
    const [ws, we] = windows[idx];
    const mine = [];
    while (i < events.length && events[i].ms < we) { if (events[i].ms >= ws) mine.push(events[i]); i++; }

    const p = plan.get(d) || {};
    const shift = p.shift || null;
    const holiday = holidays.get(d) || null;
    const weeklyOff = emp.weekly_off !== null && emp.weekly_off !== undefined && Number(emp.weekly_off) === dow(d) && !p.rostered;
    const offDay = p.off || weeklyOff || (!!holiday && !p.rostered);
    const day = { date: d, code: "", n: 0, times: [], first: null, last: null, worked: null, late: null, early: null,
      shift: shift ? shift.name : null, flags: [] };

    if ((joined && d < joined) || (left && d > left) || d > todayDate) { days.push(day); return; }

    const isToday = d === todayDate;
    const fullMin = shift ? shift.full : DEFAULT_FULL_MIN;
    const halfMin = shift ? shift.half : DEFAULT_HALF_MIN;

    if (emp.attendance_source === "app") {
      const ons = mine.filter((e) => e.kind === "on");
      const located = ons.filter((e) => e.located);
      day.n = mine.length;
      day.times = mine.map((e) => hhmm(e.ms) + (e.kind === "on" ? " in" : " out") + (e.kind === "on" && !e.located ? " (no location)" : ""));
      if (mine.length) {
        day.first = hhmm(mine[0].ms);
        day.last = mine.length > 1 ? hhmm(mine[mine.length - 1].ms) : null;
      }
      if (located.length) {
        day.code = "P";
        if (!mine.some((e) => e.kind === "off") && !isToday) day.flags.push("no check-out");
      } else if (ons.length) {
        day.code = "NL";
      } else {
        day.code = offDay ? (holiday && !p.off ? "H" : "WO") : isToday ? "" : "A";
      }
      if (offDay && day.code === "P") day.flags.push("worked on " + (holiday ? "holiday" : "off day"));
      // Round 200 — an app check-in with location is the whole of the duty.
      if (day.code === "P") day.met = true;
      days.push(day);
      return;
    }

    // machine punches
    day.n = mine.length;
    day.times = mine.map((e) => hhmm(e.ms) + (e.state === 0 ? " in" : e.state === 1 ? " out" : "") + (e.synthetic ? " (request)" : ""));
    if (mine.some((e) => e.synthetic)) day.flags.push("corrected by approved request");
    if (!mine.length) {
      day.code = offDay ? (holiday && !p.off ? "H" : "WO") : isToday ? "" : "A";
      days.push(day);
      return;
    }
    const first = mine[0].ms;
    const last = mine[mine.length - 1].ms;
    day.first = hhmm(first);
    if (mine.length === 1) {
      day.code = isToday && nowMs - first < 16 * 3600000 ? "IN" : "MIS";
    } else {
      day.last = hhmm(last);
      const worked = Math.round((last - first) / 60000);
      day.worked = worked;
      day.code = worked >= fullMin ? "P" : worked >= halfMin ? "HD" : (isToday ? "IN" : "A");
      if (day.code === "A") day.flags.push("short hours");
    }
    if (shift) {
      const lateBy = Math.round((first - at(d, shift.start)) / 60000);
      if (lateBy > shift.grace) day.late = lateBy;
      if (mine.length > 1) {
        const earlyBy = Math.round((at(d, shift.end) - last) / 60000);
        if (earlyBy > shift.grace) day.early = earlyBy;
      }
    }
    if (offDay) day.flags.push("worked on " + (holiday && !p.off ? "holiday" : "off day"));
    // Round 200 — did the day meet the duty hours? The shift's own length
    // (9 to 5 = 8 h), or 8 hours for someone with no shift (operators). The
    // employee's own screen shows a met day as just "P"; anything short shows
    // the punches so it can be corrected.
    day.req = shift ? shift.end - shift.start : (rules.ot_standard_day_min ?? 480);
    day.met = day.code === "P" && day.worked != null && day.worked >= day.req;
    // Round 198 — overtime the punches suggest. Payroll shows it for approval;
    // nothing is paid on this number until a person accepts it there.
    if (day.worked != null && !isToday) {
      const after = rules.ot_after_min ?? 30, step = rules.ot_step_min ?? 30;
      let raw = offDay ? day.worked
        : shift ? Math.round((last - at(d, shift.end)) / 60000)
        : day.worked - (rules.ot_standard_day_min ?? 480);
      if (raw >= after && raw > 0) day.ot = Math.floor(raw / step) * step;
    }
    days.push(day);
  });

  // Round 198 — approved "present for the whole day" requests, and pending flags.
  if (opts.reqs) {
    for (const day of days) {
      const rq = opts.reqs.get(day.date);
      if (!rq || (!day.code && day.date > todayDate)) continue;
      if (rq.full && day.code !== "" ) {
        if (day.code !== "P") day.flags.push(`marked present by approved request (was ${day.code})`);
        day.code = "P";
        day.ot = null;
      }
      if (rq.pending) day.flags.push(`${rq.pending} request${rq.pending > 1 ? "s" : ""} waiting for approval`);
      day.pending = rq.pending || 0;
    }
  }

  // Round 200 — leave. An approved leave turns an absence (or a missed punch,
  // a no-location check-in, a blank future day) into "L". It never takes a
  // weekly off or holiday, and a day the person actually worked stays worked.
  // A half-day leave on a half day makes it whole.
  if (opts.leaves) {
    for (const day of days) {
      const lv = opts.leaves.get(day.date);
      if (!lv) continue;
      const before = (joined && day.date < joined) || (left && day.date > left);
      if (before) continue;
      if (lv.pending) {
        day.pending = (day.pending || 0) + lv.pending;
        day.flags.push(`leave request waiting (${lv.pending_code})`);
      }
      const a = lv.approved;
      if (!a) continue;
      if (day.code === "WO" || day.code === "H") continue;
      if (day.code === "P" || day.code === "IN") { day.flags.push(`${a.code} approved, but attended`); continue; }
      if (a.half && day.code === "HD") {
        day.leave = { code: a.code, name: a.name, paid: a.paid, half: true };
        day.flags.push(`half day + ${a.code} half-day leave`);
        continue;
      }
      if (day.code && day.code !== "A") day.flags.push(`was ${day.code}`);
      day.code = "L";
      day.leave = { code: a.code, name: a.name, paid: a.paid, half: !!a.half };
      day.ot = null;
    }
  }
  return days;
}

export function summarise(days) {
  const s = { present: 0, half: 0, absent: 0, missed: 0, no_location: 0, off: 0, holiday: 0, late: 0, early: 0, off_day_worked: 0, paid_days: 0, ot_min: 0, pending: 0,
    leave: 0, leave_paid: 0, leave_unpaid: 0 };
  for (const d of days) {
    if (d.leave) {
      const n = d.leave.half ? 0.5 : 1;
      s.leave += n;
      if (d.leave.paid) s.leave_paid += n; else s.leave_unpaid += n;
    }
    if (d.code === "P") s.present++;
    else if (d.code === "HD") s.half++;
    else if (d.code === "A") s.absent++;
    else if (d.code === "MIS") s.missed++;
    else if (d.code === "NL") s.no_location++;
    else if (d.code === "WO") s.off++;
    else if (d.code === "H") s.holiday++;
    if (d.late) s.late++;
    if (d.early) s.early++;
    if (d.flags.some((f) => f.startsWith("worked on"))) s.off_day_worked++;
    if (d.ot) s.ot_min += d.ot;
    if (d.pending) s.pending += d.pending;
  }
  // Provisional: missed punches and no-location days are NOT counted until
  // they are resolved (stage 2 requests / payroll lock).
  s.paid_days = s.present + s.half * 0.5 + s.off + s.holiday + s.leave_paid;
  return s;
}

function istToday(nowMs) {
  // attendance day of "now": 04:00 boundary
  return new Date(nowMs + IST_MS - 240 * 60000).toISOString().slice(0, 10); // ist-ok: shifted by +05:30 first, so this is the IST day (minus the 04:00 boundary)
}

// Load everything for a date range and compute every employee in it.
export async function attendanceRegister({ from, to, employeeIds = null, nowMs = Date.now(), withRows = false }) {
  const dates = datesBetween(from, to);
  const todayDate = istToday(nowMs);

  const empRes = await query(
    `SELECT e.*, to_char(e.date_of_joining, 'YYYY-MM-DD') AS date_of_joining,
            to_char(e.date_of_leaving, 'YYYY-MM-DD') AS date_of_leaving,
            d.name AS department, s.name AS default_shift_name
     FROM hr_employees e
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_shifts s ON s.id = e.default_shift_id
     WHERE (e.date_of_joining IS NULL OR e.date_of_joining <= $2::date)
       AND (e.date_of_leaving IS NULL OR e.date_of_leaving >= $1::date)
       AND (e.is_active OR e.date_of_leaving IS NOT NULL)
       AND ($3::int[] IS NULL OR e.id = ANY($3::int[]))
     ORDER BY d.sort_order NULLS LAST, d.name NULLS LAST, e.name`,
    [from, to, employeeIds]
  );
  const emps = empRes.rows;
  if (!emps.length) return { from, to, today: todayDate, dates: dates.map((d) => ({ date: d, dow: dow(d) })), employees: [] };

  const [shiftRes, holRes, rosterRes, reqRes, rules] = await Promise.all([
    query(`SELECT * FROM hr_shifts`),
    query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d, name FROM hr_holidays WHERE holiday_date BETWEEN $1 AND $2`, [from, to]),
    query(`SELECT employee_id, to_char(work_date, 'YYYY-MM-DD') AS d, shift_id, is_off FROM hr_roster
           WHERE work_date BETWEEN $1 AND $2 AND employee_id = ANY($3::int[])`, [from, to, emps.map((e) => e.id)]),
    // Round 198 — approved corrections and waiting requests.
    query(`SELECT employee_id, to_char(work_date, 'YYYY-MM-DD') AS d, kind, status,
                  to_char(time_in, 'HH24:MI') AS time_in, to_char(time_out, 'HH24:MI') AS time_out
           FROM hr_requests WHERE work_date BETWEEN $1 AND $2 AND employee_id = ANY($3::int[])
             AND status IN ('approved','pending')`, [from, to, emps.map((e) => e.id)]),
    loadRules(),
  ]);
  // Round 200 — leave overlapping the range, approved or waiting.
  const leaveRes = await query(
    `SELECT l.employee_id, to_char(l.from_date, 'YYYY-MM-DD') AS f, to_char(l.to_date, 'YYYY-MM-DD') AS t, l.half_day, l.status,
            lt.code, lt.name, lt.paid
     FROM hr_leaves l JOIN hr_leave_types lt ON lt.id = l.leave_type_id
     WHERE l.status IN ('approved','pending') AND l.from_date <= $2 AND l.to_date >= $1 AND l.employee_id = ANY($3::int[])`,
    [from, to, emps.map((e) => e.id)]);
  const leavesByEmp = new Map();
  for (const l of leaveRes.rows) {
    if (!leavesByEmp.has(l.employee_id)) leavesByEmp.set(l.employee_id, new Map());
    const m = leavesByEmp.get(l.employee_id);
    for (const d of datesBetween(l.f < from ? from : l.f, l.t > to ? to : l.t)) {
      const cur = m.get(d) || { approved: null, pending: 0, pending_code: null };
      if (l.status === "approved") cur.approved = { code: l.code, name: l.name, paid: l.paid, half: l.half_day };
      else { cur.pending++; cur.pending_code = l.code; }
      m.set(d, cur);
    }
  }
  const shifts = new Map(shiftRes.rows.map((s) => [s.id, shiftOf(s)]));
  const holidays = new Map(holRes.rows.map((h) => [h.d, h.name]));
  const roster = new Map();
  for (const r of rosterRes.rows) roster.set(r.employee_id + "|" + r.d, r);

  // events: a day's window can start 4h before and end ~1.5 days after
  const evFrom = new Date(at(from, 0) - DAY_MS).toISOString();
  const evTo = new Date(at(to, 2 * 1440 + 600)).toISOString();
  const machineIds = emps.filter((e) => e.attendance_source === "machine" && e.machine_user_id).map((e) => e.machine_user_id);
  const appIds = emps.filter((e) => e.attendance_source === "app" && e.app_user_id).map((e) => e.app_user_id);
  const [punchRes, dutyRes] = await Promise.all([
    machineIds.length
      ? query(`SELECT machine_user_id, extract(epoch FROM punched_at) * 1000 AS ms, key_state
               FROM attendance_punches WHERE machine_user_id = ANY($1::text[]) AND punched_at >= $2 AND punched_at < $3
               ORDER BY punched_at`, [machineIds, evFrom, evTo])
      : { rows: [] },
    appIds.length
      ? query(`SELECT salesperson_user_id AS uid, extract(epoch FROM event_time) * 1000 AS ms, is_on,
                      (latitude IS NOT NULL AND longitude IS NOT NULL) AS located
               FROM sales_duty_log WHERE salesperson_user_id = ANY($1::int[]) AND event_time >= $2 AND event_time < $3
               ORDER BY event_time`, [appIds, evFrom, evTo])
      : { rows: [] },
  ]);
  const byMachine = new Map();
  for (const p of punchRes.rows) {
    if (!byMachine.has(p.machine_user_id)) byMachine.set(p.machine_user_id, []);
    byMachine.get(p.machine_user_id).push({ ms: Number(p.ms), kind: "punch", state: p.key_state });
  }
  const byApp = new Map();
  for (const p of dutyRes.rows) {
    if (!byApp.has(p.uid)) byApp.set(p.uid, []);
    byApp.get(p.uid).push({ ms: Number(p.ms), kind: p.is_on ? "on" : "off", located: p.located });
  }

  // An approved missed-punch / on-duty request becomes a punch at the stated
  // time on that day (a time before 04:00 is the early hours of the next
  // morning). Marked synthetic, so the screens can say where it came from.
  const reqsByEmp = new Map();
  const extraEvents = new Map();
  for (const r of reqRes.rows) {
    if (!reqsByEmp.has(r.employee_id)) reqsByEmp.set(r.employee_id, new Map());
    const m = reqsByEmp.get(r.employee_id);
    const cur = m.get(r.d) || { full: false, pending: 0 };
    if (r.status === "pending") cur.pending++;
    else if (r.kind === "full_day") cur.full = true;
    else {
      for (const t of [r.time_in, r.time_out]) {
        if (!t) continue;
        let min = timeToMin(t);
        if (min < 240) min += 1440;
        if (!extraEvents.has(r.employee_id)) extraEvents.set(r.employee_id, []);
        extraEvents.get(r.employee_id).push({ ms: at(r.d, min), kind: "punch", state: t === r.time_in ? 0 : 1, synthetic: true });
      }
    }
    m.set(r.d, cur);
  }

  const employees = emps.map((e) => {
    const plan = new Map();
    for (const d of dates) {
      const r = roster.get(e.id + "|" + d);
      if (r) plan.set(d, { rostered: true, off: r.is_off, shift: r.is_off ? null : shifts.get(r.shift_id) || null });
      else if (e.policy === "office" && e.default_shift_id) plan.set(d, { shift: shifts.get(e.default_shift_id) || null });
      else if (e.policy === "operations" && e.default_shift_id) plan.set(d, { shift: shifts.get(e.default_shift_id) || null });
    }
    let events = e.attendance_source === "machine" ? (byMachine.get(e.machine_user_id) || [])
      : e.attendance_source === "app" ? (byApp.get(e.app_user_id) || []) : [];
    if (e.attendance_source === "machine" && extraEvents.has(e.id)) {
      events = [...events, ...extraEvents.get(e.id)].sort((a, b) => a.ms - b.ms);
    }
    // Not linked to the machine / app yet: nothing to judge, so show nothing
    // rather than a month of false absences.
    const unlinked = (e.attendance_source === "machine" && !e.machine_user_id) || (e.attendance_source === "app" && !e.app_user_id);
    const days = e.attendance_source === "none" || unlinked ? dates.map((d) => ({ date: d, code: "", n: 0, times: [], flags: [] }))
      : computeEmployeeDays(e, dates, events, plan, holidays, todayDate, nowMs, { reqs: reqsByEmp.get(e.id), leaves: leavesByEmp.get(e.id), rules });
    return {
      id: e.id, emp_code: e.emp_code, name: e.name, department: e.department, designation: e.designation,
      attendance_source: e.attendance_source, policy: e.policy, machine_user_id: e.machine_user_id,
      linked: e.attendance_source === "machine" ? !!e.machine_user_id : e.attendance_source === "app" ? !!e.app_user_id : true,
      days, summary: summarise(days),
      ...(withRows ? { row: e } : {}),
    };
  });
  return {
    from, to, today: todayDate,
    dates: dates.map((d) => ({ date: d, dow: dow(d), holiday: holidays.get(d) || null })),
    employees,
  };
}
