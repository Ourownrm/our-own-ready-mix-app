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
export function computeEmployeeDays(emp, dates, events, plan, holidays, todayDate, nowMs) {
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
      days.push(day);
      return;
    }

    // machine punches
    day.n = mine.length;
    day.times = mine.map((e) => hhmm(e.ms) + (e.state === 0 ? " in" : e.state === 1 ? " out" : ""));
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
    days.push(day);
  });
  return days;
}

export function summarise(days) {
  const s = { present: 0, half: 0, absent: 0, missed: 0, no_location: 0, off: 0, holiday: 0, late: 0, early: 0, off_day_worked: 0, paid_days: 0 };
  for (const d of days) {
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
  }
  // Provisional: missed punches and no-location days are NOT counted until
  // they are resolved (stage 2 requests / payroll lock).
  s.paid_days = s.present + s.half * 0.5 + s.off + s.holiday;
  return s;
}

function istToday(nowMs) {
  // attendance day of "now": 04:00 boundary
  return new Date(nowMs + IST_MS - 240 * 60000).toISOString().slice(0, 10); // ist-ok: shifted by +05:30 first, so this is the IST day (minus the 04:00 boundary)
}

// Load everything for a date range and compute every employee in it.
export async function attendanceRegister({ from, to, employeeIds = null, nowMs = Date.now() }) {
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

  const [shiftRes, holRes, rosterRes] = await Promise.all([
    query(`SELECT * FROM hr_shifts`),
    query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d, name FROM hr_holidays WHERE holiday_date BETWEEN $1 AND $2`, [from, to]),
    query(`SELECT employee_id, to_char(work_date, 'YYYY-MM-DD') AS d, shift_id, is_off FROM hr_roster
           WHERE work_date BETWEEN $1 AND $2 AND employee_id = ANY($3::int[])`, [from, to, emps.map((e) => e.id)]),
  ]);
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

  const employees = emps.map((e) => {
    const plan = new Map();
    for (const d of dates) {
      const r = roster.get(e.id + "|" + d);
      if (r) plan.set(d, { rostered: true, off: r.is_off, shift: r.is_off ? null : shifts.get(r.shift_id) || null });
      else if (e.policy === "office" && e.default_shift_id) plan.set(d, { shift: shifts.get(e.default_shift_id) || null });
      else if (e.policy === "operations" && e.default_shift_id) plan.set(d, { shift: shifts.get(e.default_shift_id) || null });
    }
    const events = e.attendance_source === "machine" ? (byMachine.get(e.machine_user_id) || [])
      : e.attendance_source === "app" ? (byApp.get(e.app_user_id) || []) : [];
    // Not linked to the machine / app yet: nothing to judge, so show nothing
    // rather than a month of false absences.
    const unlinked = (e.attendance_source === "machine" && !e.machine_user_id) || (e.attendance_source === "app" && !e.app_user_id);
    const days = e.attendance_source === "none" || unlinked ? dates.map((d) => ({ date: d, code: "", n: 0, times: [], flags: [] }))
      : computeEmployeeDays(e, dates, events, plan, holidays, todayDate, nowMs);
    return {
      id: e.id, emp_code: e.emp_code, name: e.name, department: e.department, designation: e.designation,
      attendance_source: e.attendance_source, policy: e.policy, machine_user_id: e.machine_user_id,
      linked: e.attendance_source === "machine" ? !!e.machine_user_id : e.attendance_source === "app" ? !!e.app_user_id : true,
      days, summary: summarise(days),
    };
  });
  return {
    from, to, today: todayDate,
    dates: dates.map((d) => ({ date: d, dow: dow(d), holiday: holidays.get(d) || null })),
    employees,
  };
}
