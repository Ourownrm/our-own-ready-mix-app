// Round 198 — monthly payroll.
//
// One line per employee for a month, worked out from:
//   attendance        lib/hrAttendance.js (machine punches, sales app, approved
//                     requests) — the missed-punch rule is applied here
//   pay               hr_employees (monthly components, or a contract daily rate)
//   overtime          hours the punches suggest; a person may change them
//   trip allowance    trip_allowance_payouts of the driver's app login, for
//                     employees marked "gets trip allowance"
//   incentive         own_production    m3 of his customers above his minimum
//                     plant_production  whole plant m3 above the minimum
//                     own_sales_paid    m3 of his sales whose invoice became
//                                       fully paid this month (counted once)
//   advances          hr_advances recovered this month
//   statutory         PF, ESI, PT, bonus and gratuity provisions (lib/hrRules.js)
//
// m3 = loaded quantity of non-cancelled delivery tickets dated in the month,
// less the quantity rejected at site — the same definition as the Admin
// dashboard's "monthly production".
//
// Per-day pay = monthly gross ÷ calendar days in the month. Weekly offs and
// holidays are paid for payroll staff; contract workers are paid for days
// worked only (their contractor handles PF/ESI).

import { query } from "../db.js";
import { attendanceRegister, datesBetween } from "./hrAttendance.js";
import { loadRules } from "./hrRules.js";

const r2 = (n) => Math.round(n * 100) / 100;
const r0 = (n) => Math.round(n);

export function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}`, days: last };
}

async function monthData(month, from, to) {
  const [trips, plant, bySp, paidBySp, adv] = await Promise.all([
    query(`SELECT driver_id, count(*)::int AS n, COALESCE(sum(amount), 0)::numeric AS amt
           FROM trip_allowance_payouts
           WHERE earned_at >= $1::date AND earned_at < ($2::date + 1)
           GROUP BY driver_id`, [from, to]),
    query(`SELECT COALESCE(sum(dt.loaded_quantity_m3), 0) - COALESCE(sum(sq.rejected_quantity_m3), 0) AS m3
           FROM delivery_tickets dt LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
           WHERE dt.ticket_date BETWEEN $1 AND $2 AND dt.status <> 'cancelled'`, [from, to]),
    query(`SELECT co.sales_representative_id AS sp,
                  COALESCE(sum(dt.loaded_quantity_m3), 0) - COALESCE(sum(sq.rejected_quantity_m3), 0) AS m3
           FROM delivery_tickets dt
           JOIN customer_orders co ON co.id = dt.order_id
           LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
           WHERE dt.ticket_date BETWEEN $1 AND $2 AND dt.status <> 'cancelled' AND co.sales_representative_id IS NOT NULL
           GROUP BY co.sales_representative_id`, [from, to]),
    // An invoice counts in the month its payments first add up to the full amount.
    query(`WITH paid AS (
             SELECT i.id, i.ticket_id
             FROM invoices i
             JOIN LATERAL (
               SELECT p.payment_date, sum(p.amount) OVER (ORDER BY p.payment_date, p.id) AS running
               FROM payments p WHERE p.invoice_id = i.id
             ) pr ON true
             GROUP BY i.id, i.ticket_id, i.total_amount
             HAVING min(pr.payment_date) FILTER (WHERE pr.running >= i.total_amount - 1) BETWEEN $1 AND $2
           )
           SELECT co.sales_representative_id AS sp, count(*)::int AS invoices,
                  COALESCE(sum(dt.loaded_quantity_m3), 0) - COALESCE(sum(sq.rejected_quantity_m3), 0) AS m3
           FROM paid
           JOIN delivery_tickets dt ON dt.id = paid.ticket_id
           JOIN customer_orders co ON co.id = dt.order_id
           LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
           WHERE co.sales_representative_id IS NOT NULL
           GROUP BY co.sales_representative_id`, [from, to]),
    query(`SELECT employee_id, COALESCE(sum(amount), 0) AS amt, count(*)::int AS n
           FROM hr_advances WHERE recover_month = $1 GROUP BY employee_id`, [month]),
  ]);
  return {
    trips: new Map(trips.rows.map((t) => [t.driver_id, { n: t.n, amt: Number(t.amt) }])),
    plantM3: Number(plant.rows[0].m3) || 0,
    spM3: new Map(bySp.rows.map((r) => [r.sp, Number(r.m3)])),
    spPaid: new Map(paidBySp.rows.map((r) => [r.sp, { m3: Number(r.m3), invoices: r.invoices }])),
    advances: new Map(adv.rows.map((a) => [a.employee_id, { amt: Number(a.amt), n: a.n }])),
  };
}

// The pure calculation for one employee. Exported for the check script.
export function payLine({ emp, att, daysInMonth, datesInMonth, rules, data, manual = {} }) {
  const warn = [];
  const s = att.summary;
  const joined = emp.date_of_joining || null;
  const left = emp.date_of_leaving || null;
  const daysEmployed = datesInMonth.filter((d) => (!joined || d >= joined) && (!left || d <= left)).length;

  const missedPaid = rules.missed_punch_at_lock === "half" ? s.missed * 0.5 : 0;
  const contract = emp.employment_type === "contract";
  let paidDays;
  // Round 200 — approved paid leave is a paid day (for contract workers too:
  // whoever approves a paid leave type for one has decided to pay it).
  const leavePaid = s.leave_paid || 0;
  if (emp.attendance_source === "none") paidDays = daysEmployed;
  else if (contract) paidDays = s.present + s.half * 0.5 + missedPaid + leavePaid;
  else paidDays = s.present + s.half * 0.5 + s.off + s.holiday + missedPaid + leavePaid;
  paidDays = Math.min(paidDays, daysEmployed);
  const lopDays = contract ? 0 : Math.max(0, daysEmployed - paidDays);

  if (s.missed) warn.push(`${s.missed} missed punch${s.missed > 1 ? "es" : ""} counted as ${rules.missed_punch_at_lock === "half" ? "half day" : "absent"}`);
  if (s.no_location) warn.push(`${s.no_location} app check-in${s.no_location > 1 ? "s" : ""} without location not paid`);
  if (s.pending) warn.push(`${s.pending} request${s.pending > 1 ? "s" : ""} still waiting for approval`);
  if (!att.linked) warn.push("not linked to the machine / app — no attendance");

  const comp = {
    basic: Number(emp.salary_basic || 0), da: Number(emp.salary_da || 0), hra: Number(emp.salary_hra || 0),
    conveyance: Number(emp.salary_conveyance || 0), special: Number(emp.salary_special || 0),
  };
  const grossMonthly = comp.basic + comp.da + comp.hra + comp.conveyance + comp.special;
  const dailyRate = Number(emp.daily_rate || 0);
  if (contract ? !dailyRate : !grossMonthly) warn.push("pay not set on the employee record");

  const f = daysInMonth ? paidDays / daysInMonth : 0;
  const earned = contract
    ? { wages: r2(dailyRate * paidDays) }
    : Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, r2(v * f)]));
  const earnedGross = contract ? earned.wages : r2(Object.values(earned).reduce((a, b) => a + b, 0));
  const earnedBasicDa = contract ? 0 : r2(earned.basic + earned.da);

  // Overtime
  const otSuggested = r2((s.ot_min || 0) / 60);
  const otHours = manual.ot_hours != null ? Number(manual.ot_hours) : otSuggested;
  const hourly = contract ? dailyRate / rules.ot_hours_per_day
    : grossMonthly / daysInMonth / rules.ot_hours_per_day;
  // Paid only for people marked "paid overtime"; for others the hours are
  // shown for information and nothing is paid.
  const otAmount = emp.ot_eligible ? r0(otHours * hourly * rules.ot_multiplier) : 0;

  // Trip allowance
  // Round 202 — say WHY none is paid, rather than show a silent zero: trips
  // are recorded against the driver's app login, so a missing link or an
  // unticked "Gets trip allowance" is the usual cause.
  let trip = { n: 0, amt: 0 };
  const loginTrips = emp.app_user_id ? data.trips.get(emp.app_user_id) : null;
  if (emp.trip_allowance) {
    if (!emp.app_user_id) warn.push("gets trip allowance but has no app login linked — trips are recorded against the driver's login");
    else if (!loginTrips) warn.push("gets trip allowance but no trips were recorded for their app login this month");
    else trip = loginTrips;
  } else if (loginTrips && loginTrips.amt > 0) {
    warn.push(`${loginTrips.n} trips worth ₹${Math.round(loginTrips.amt).toLocaleString("en-IN")} this month, but "Gets trip allowance" is not ticked — not paid`);
  }

  // Incentive
  let incentive = 0, incentiveNote = null;
  const basis = emp.incentive_basis || "none";
  const min = Number(emp.incentive_min_m3 || 0), rate = Number(emp.incentive_rate || 0);
  if (basis !== "none") {
    let m3 = 0;
    if (basis === "plant_production") m3 = data.plantM3;
    else if (!emp.salesperson_id) warn.push("incentive needs the salesperson link on the employee record");
    else if (basis === "own_production") m3 = data.spM3.get(emp.salesperson_id) || 0;
    else if (basis === "own_sales_paid") m3 = (data.spPaid.get(emp.salesperson_id) || { m3: 0 }).m3;
    m3 = r2(m3);
    const above = Math.max(0, m3 - min);
    incentive = r0(above * rate);
    const what = basis === "plant_production" ? "plant production" : basis === "own_production" ? "own customers' production" : "own sales paid for this month";
    incentiveNote = `${m3} m³ ${what}${min ? `, minimum ${min}` : ""} → ${r2(above)} m³ × ₹${rate}`;
  }

  const otherEarning = Number(manual.other_earning || 0);
  const totalEarnings = r0(earnedGross + otAmount + trip.amt + incentive + otherEarning);

  // Deductions (payroll staff only)
  let pf = 0, esi = 0, pt = 0, pfEr = 0, esiEr = 0, bonus = 0, gratuity = 0;
  if (!contract) {
    const pfBase = Math.min(earnedBasicDa, rules.pf_wage_cap);
    if (emp.pf_applicable) { pf = r0(pfBase * rules.pf_rate / 100); pfEr = pf; }
    if (emp.esi_applicable && grossMonthly > 0 && grossMonthly <= rules.esi_gross_limit) {
      const esiBase = earnedGross + otAmount;
      esi = Math.ceil(esiBase * rules.esi_employee_rate / 100);
      esiEr = Math.ceil(esiBase * rules.esi_employer_rate / 100);
    }
    if (rules.pt_amount && totalEarnings >= rules.pt_threshold) pt = rules.pt_amount;
    if (comp.basic + comp.da <= 21000) bonus = r0(Math.min(earnedBasicDa, rules.bonus_wage_cap) * rules.bonus_rate / 100);
    gratuity = r0(earnedBasicDa * rules.gratuity_rate / 100);
  }
  const advance = (data.advances.get(emp.id) || { amt: 0 }).amt;
  const otherDeduction = Number(manual.other_deduction || 0);
  const totalDeductions = r0(pf + esi + pt + advance + otherDeduction);
  const netPay = totalEarnings - totalDeductions;
  if (netPay < 0) warn.push("deductions are more than the earnings");

  const serviceCharge = contract ? r0((earnedGross + otAmount) * Number(emp.service_charge_pct || 0) / 100) : 0;
  const costToCompany = totalEarnings + pfEr + esiEr + bonus + gratuity + serviceCharge;

  return {
    calc: {
      contract, days_in_month: daysInMonth, days_employed: daysEmployed,
      present: s.present, half: s.half, absent: s.absent, missed: s.missed, no_location: s.no_location,
      off: s.off, holiday: s.holiday, late: s.late, early: s.early,
      leave: s.leave || 0, leave_paid: leavePaid, leave_unpaid: s.leave_unpaid || 0,
      paid_days: r2(paidDays), lop_days: r2(lopDays),
      gross_monthly: grossMonthly, daily_rate: dailyRate, earned, earned_gross: earnedGross,
      ot_eligible: !!emp.ot_eligible, ot_suggested: otSuggested, ot_hours: emp.ot_eligible ? otHours : 0, ot_amount: otAmount,
      trip_count: trip.n, trip_allowance: trip.amt,
      incentive, incentive_note: incentiveNote,
      other_earning: otherEarning, total_earnings: totalEarnings,
      pf, esi, pt, advance, other_deduction: otherDeduction, total_deductions: totalDeductions,
      pf_employer: pfEr, esi_employer: esiEr, bonus_provision: bonus, gratuity_provision: gratuity,
      service_charge: serviceCharge,
      warnings: warn,
    },
    net_pay: netPay,
    cost_to_company: costToCompany,
  };
}

// Compute lines for a month (optionally a subset of employees), using the
// manual fields already saved on the month's lines.
export async function computePayroll(month, { employeeIds = null } = {}) {
  const { from, to, days } = monthRange(month);
  const [reg, rules, data, manualRes] = await Promise.all([
    attendanceRegister({ from, to, employeeIds, withRows: true }),
    loadRules(),
    monthData(month, from, to),
    query(`SELECT employee_id, ot_hours, other_earning, other_deduction, remarks FROM hr_payroll_lines WHERE month = $1`, [month]),
  ]);
  const manual = new Map(manualRes.rows.map((m) => [m.employee_id, m]));
  const dates = datesBetween(from, to);
  const lines = reg.employees.map((att) => {
    const emp = att.row;
    const out = payLine({ emp, att, daysInMonth: days, datesInMonth: dates, rules, data, manual: manual.get(emp.id) || {} });
    return { employee_id: emp.id, ...out };
  });
  return { month, from, to, rules, lines, plant_m3: data.plantM3 };
}
