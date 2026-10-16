// Round 211 — pump gangs: who was there, day by day (owner, 15 Oct 2026).
//
//   "Pump gang is not fixed to any pump, it can be changed at order level, so
//    order may need a selection of Gang A or Gang B. If any of the gang is not
//    assigned to any order that day, for them it is considered as no pump day,
//    but if they punched should be considered for payment."
//
// A member's day:
//   present  = machine punch that day (the attendance engine's day), unless the
//              Site Supervisor / HR marked him otherwise (hr_gang_marks)
//   pump day = the gang was chosen on at least one order that day (not cancelled)
//
//   P  present on a pump day
//   I  present, no pump order — paid, shown as idle
//   A  away on a pump day (S beside it when a substitute covered him)
//   -  no pump order and did not come — not counted as away
//   '' not a member that day, or a day still to come
//
// Pay is monthly, so the codes decide nothing by themselves: Admin looks at
// each member's away days at month end and decides any deduction
// (hr_gang_deductions). Amount = days × his monthly rate ÷ days in the month.
import { query } from "../db.js";
import { attendanceRegister, datesBetween } from "./hrAttendance.js";
import { monthRange } from "./hrPayroll.js";
import { istDay } from "./istDate.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PRESENT_CODES = new Set(["P", "HD", "IN", "MIS"]);
export function punchedOn(day) {
  return !!day && (PRESENT_CODES.has(day.code) || (day.times && day.times.length > 0) || day.n > 0);
}

// Members of these gangs whose membership touches [from, to].
export async function gangMembers(gangIds, from, to) {
  const { rows } = await query(
    `SELECT m.id AS membership_id, m.gang_id, m.employee_id, m.monthly_rate::float AS monthly_rate, m.is_leader, m.role,
            to_char(m.from_date, 'YYYY-MM-DD') AS from_date, to_char(m.to_date, 'YYYY-MM-DD') AS to_date,
            e.name, e.emp_code, e.machine_user_id, e.mobile, e.is_active
       FROM hr_gang_members m JOIN hr_employees e ON e.id = m.employee_id
      WHERE m.gang_id = ANY($1::int[]) AND m.from_date <= $3::date AND (m.to_date IS NULL OR m.to_date >= $2::date)
      ORDER BY m.gang_id, m.is_leader DESC, m.from_date, e.name`,
    [gangIds, from, to]);
  return rows;
}

// Pump orders per gang per day: Map gangId -> Map date -> [orders]
export async function gangOrders(gangIds, from, to) {
  const { rows } = await query(
    `SELECT o.id, o.pump_gang_id AS gang_id, to_char(o.order_date, 'YYYY-MM-DD') AS d,
            to_char(o.scheduled_batching_time, 'HH24:MI') AS time, o.status, o.order_quantity_m3::float AS m3,
            c.name AS customer_name, s.name AS site_name, p.pump_code
       FROM customer_orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN sites s ON s.id = o.site_id
       LEFT JOIN pumps p ON p.id = o.pump_id
      WHERE o.pump_gang_id = ANY($1::int[]) AND o.order_date BETWEEN $2 AND $3 AND o.status <> 'cancelled'
      ORDER BY o.order_date, o.scheduled_batching_time`,
    [gangIds, from, to]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.gang_id)) out.set(r.gang_id, new Map());
    const m = out.get(r.gang_id);
    if (!m.has(r.d)) m.set(r.d, []);
    m.get(r.d).push(r);
  }
  return out;
}

// Everything about these gangs over [from, to], day by day.
export async function gangDays(gangIds, from, to, { nowMs = Date.now() } = {}) {
  const today = istDay(nowMs);
  const dates = datesBetween(from, to);
  const members = await gangMembers(gangIds, from, to);
  const empIds = [...new Set(members.map((m) => m.employee_id))];
  const [reg, orders, marksRes, subsRes, daysRes] = await Promise.all([
    empIds.length ? attendanceRegister({ from, to, employeeIds: empIds, nowMs }) : { employees: [] },
    gangOrders(gangIds, from, to),
    query(`SELECT gang_id, to_char(work_date, 'YYYY-MM-DD') AS d, employee_id, present, reason, u.name AS marked_by_name,
                  to_char(marked_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS marked_at
             FROM hr_gang_marks gm LEFT JOIN users u ON u.id = gm.marked_by
            WHERE gang_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3`, [gangIds, from, to]),
    query(`SELECT s.id, s.gang_id, to_char(s.work_date, 'YYYY-MM-DD') AS d, s.name, s.for_employee_id
             FROM hr_gang_subs s WHERE gang_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3 ORDER BY s.id`, [gangIds, from, to]),
    query(`SELECT g.gang_id, to_char(g.work_date, 'YYYY-MM-DD') AS d, u.name AS confirmed_by_name,
                  to_char(g.confirmed_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS confirmed_at
             FROM hr_gang_days g LEFT JOIN users u ON u.id = g.confirmed_by
            WHERE gang_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3 AND confirmed_at IS NOT NULL`, [gangIds, from, to]),
  ]);
  const att = new Map(reg.employees.map((e) => [e.id, new Map(e.days.map((d) => [d.date, d]))]));
  const marks = new Map(marksRes.rows.map((m) => [`${m.gang_id}|${m.d}|${m.employee_id}`, m]));
  const subs = new Map();
  for (const s of subsRes.rows) {
    const k = `${s.gang_id}|${s.d}`;
    if (!subs.has(k)) subs.set(k, []);
    subs.get(k).push(s);
  }
  const confirmed = new Map(daysRes.rows.map((r) => [`${r.gang_id}|${r.d}`, r]));

  const out = new Map();
  for (const gid of gangIds) {
    const gm = members.filter((m) => m.gang_id === gid);
    const go = orders.get(gid) || new Map();
    const rows = gm.map((m) => {
      const days = dates.map((d) => {
        if (d < m.from_date || (m.to_date && d > m.to_date)) return { date: d, code: "" };
        const ad = att.get(m.employee_id)?.get(d);
        const punched = punchedOn(ad);
        const mark = marks.get(`${gid}|${d}|${m.employee_id}`) || null;
        const daySubs = (subs.get(`${gid}|${d}`) || []).filter((s) => s.for_employee_id === m.employee_id);
        const pump = (go.get(d) || []).length > 0;
        const present = mark ? mark.present : punched;
        const future = d > today;
        let code;
        if (future) code = "";
        else if (present) code = pump ? "P" : "I";
        else if (d === today && !mark) code = pump ? "?" : "";   // not in yet today
        else code = pump ? "A" : "-";
        return {
          date: d, code, punched, first: ad?.first || (ad?.times && ad.times[0]) || null,
          mark: mark ? { present: mark.present, reason: mark.reason, by: mark.marked_by_name, at: mark.marked_at } : null,
          sub: code === "A" && daySubs.length ? daySubs.map((s) => s.name).join(", ") : null,
        };
      });
      const s = { present: 0, idle: 0, away: 0, covered: 0, no_pump_absent: 0 };
      for (const d of days) {
        if (d.code === "P") s.present++;
        else if (d.code === "I") { s.present++; s.idle++; }
        else if (d.code === "A") { s.away++; if (d.sub) s.covered++; }
        else if (d.code === "-") s.no_pump_absent++;
      }
      s.uncovered = s.away - s.covered;
      return { ...m, days, summary: s };
    });
    const perDay = dates.map((d) => {
      const list = go.get(d) || [];
      const crew = rows.filter((r) => { const x = r.days.find((y) => y.date === d); return x && (x.code === "P" || x.code === "I"); }).length;
      const subN = (subs.get(`${gid}|${d}`) || []).length;
      return { date: d, orders: list, pump: list.length > 0, crew, subs: subN, crew_with_subs: crew + subN,
               confirmed: confirmed.get(`${gid}|${d}`) || null, sub_list: subs.get(`${gid}|${d}`) || [] };
    });
    out.set(gid, { members: rows, days: perDay });
  }
  return { from, to, today, dates, gangs: out };
}

export async function gangMonthClosed(gangId, month, db = { query }) {
  const { rows } = await db.query(`SELECT 1 FROM hr_gang_months WHERE gang_id = $1 AND month = $2`, [gangId, month]);
  return rows.length > 0;
}

// The month register for one gang plus Admin's deductions and the amount.
export async function gangMonth(gangId, month) {
  const { from, to, days: dim } = monthRange(month);
  const [{ gangs, today }, dedRes, closedRes, gRes] = await Promise.all([
    gangDays([gangId], from, to),
    query(`SELECT d.employee_id, d.days::float AS days, d.note, u.name AS decided_by_name,
                  to_char(d.decided_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon') AS decided_at
             FROM hr_gang_deductions d LEFT JOIN users u ON u.id = d.decided_by WHERE gang_id = $1 AND month = $2`, [gangId, month]),
    query(`SELECT m.*, u.name AS closed_by_name, to_char(m.closed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY') AS closed_on
             FROM hr_gang_months m LEFT JOIN users u ON u.id = m.closed_by WHERE gang_id = $1 AND month = $2`, [gangId, month]),
    query(`SELECT g.*, c.name AS contractor_name FROM hr_gangs g JOIN hr_contractors c ON c.id = g.contractor_id WHERE g.id = $1`, [gangId]),
  ]);
  const g = gangs.get(gangId);
  const ded = new Map(dedRes.rows.map((d) => [d.employee_id, d]));
  const dates = datesBetween(from, to);
  let gross = 0, deduction = 0;
  const members = g.members.map((m) => {
    // Paid for the part of the month he was a member.
    const inDays = dates.filter((d) => d >= m.from_date && (!m.to_date || d <= m.to_date)).length;
    const dayValue = r2(m.monthly_rate / dim);
    const base = inDays === dim ? r2(m.monthly_rate) : r2(dayValue * inDays);
    const dd = ded.get(m.employee_id) || null;
    const dedDays = dd ? Number(dd.days) : 0;
    const dedAmt = Math.round(dedDays * m.monthly_rate / dim);
    gross += base; deduction += dedAmt;
    return { ...m, days_in_gang: inDays, day_value: dayValue, base, deduction: dd ? { days: dedDays, amount: dedAmt, note: dd.note, by: dd.decided_by_name, at: dd.decided_at } : null };
  });
  gross = Math.round(gross);
  return {
    gang: gRes.rows[0] || null, month, from, to, days_in_month: dim, today,
    finished: today > to,
    dates, days: g.days, members,
    gross, deduction, amount: gross - deduction,
    closed: closedRes.rows[0] || null,
  };
}

// TDS (Income-tax Act 2025 s.393, formerly s.194C) on payments to a labour
// contractor: 1% individual / HUF, 2% others, 20% without PAN; only once one
// bill is over ₹30,000 or the financial year's bills pass ₹1,00,000. On the
// labour amount — GST shown separately is left out.
export const TDS_SINGLE_LIMIT = 30000;
export const TDS_YEAR_LIMIT = 100000;
export function fyOf(month) {
  const [y, m] = month.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04`, to: `${start + 1}-03`, label: `${start}-${String(start + 1).slice(2)}` };
}
export function tdsFor(contractor, taxable, earlierThisYear) {
  const rate = !contractor.pan ? 20 : contractor.kind === "firm" ? 2 : 1;
  const yearTotal = earlierThisYear + taxable;
  const applies = taxable > TDS_SINGLE_LIMIT || yearTotal > TDS_YEAR_LIMIT;
  const note = applies
    ? `${rate}%${!contractor.pan ? " (no PAN)" : ""} — ${taxable > TDS_SINGLE_LIMIT ? "bill over ₹30,000" : "year's bills over ₹1,00,000"}`
    : `not deducted — bill ₹30,000 or less and year's bills ₹1,00,000 or less`;
  return { rate: applies ? rate : 0, amount: applies ? Math.round(taxable * rate / 100) : 0, note, year_total: yearTotal };
}

// Round 211 — the gang chosen when an order is booked (CreateOrder / Sales
// convert). Ignored when the id is not an active gang.
export async function setOrderGang(orderId, gangId, userId) {
  const gid = Number(gangId);
  if (!orderId || !Number.isInteger(gid) || gid <= 0) return;
  await query(
    `UPDATE customer_orders o SET pump_gang_id = g.id, assigned_pump_crew = g.name, pump_gang_set_by = $3, pump_gang_set_at = now()
       FROM hr_gangs g WHERE o.id = $1 AND g.id = $2 AND g.is_active`, [orderId, gid, userId]);
}
