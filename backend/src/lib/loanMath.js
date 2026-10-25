// Round 241 — loan arithmetic (owner, 25 Oct 2026: "update the app such
// way that all these type of calculations are covered" — after working out
// the IndusInd, Shriram, KFC and Mahindra loans by hand).
//
// A loan may carry its SCHEDULE from the agreement / statement:
//   loan_amount, disbursed_on, first_due (instalment 1), n_instalments,
//   steps  [{ from_no, amount }] — the instalment from that number on
//          (an EMI for an EMI loan, the principal for a fixed-principal loan):
//          Mahindra 1: ₹5,820, 2: ₹28,000, 38: ₹7,300; Shriram 1: ₹95,000,
//          21: ₹86,000, 41: ₹51,403; KFC 1: ₹23,000, 2: ₹69,000, 13: ₹1,97,000.
//   rates  [{ from, rate }] — the rate from that date on (KFC 140285290 moved
//          10.5 → 10 → 10.5 → 11 → 11.5 → 11%).
// From it the app works out what used to be done by hand:
//   * the real rate of a loan quoted as finance charges / a flat rate
//     (Mahindra ₹2,65,720 on ₹9,16,000 = 5.8% flat = 14.36% a year on the
//     reducing balance) — the rate at which the instalments repay the loan
//     exactly (the lender's IRR);
//   * the principal still owed on any date, instalments paid and left;
//   * each month's instalment (EMI or principal) and rate, for splitting the
//     bank-statement EMI and for working the loan forward.
const n0 = (v) => Number(v) || 0;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const dayN = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86400000;
const MONTH = 365 / 12;

export function addMonths(ymd, n) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)) - 1 + n, d = Number(ymd.slice(8, 10));
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${pad(mm + 1)}-${pad(Math.min(d, last))}`;
}

export function steps(loan) {
  const s = Array.isArray(loan.steps) ? loan.steps : [];
  return s.map((x) => ({ from_no: Math.max(1, Math.round(n0(x.from_no))), amount: n0(x.amount) }))
    .filter((x) => x.amount > 0).sort((a, b) => a.from_no - b.from_no);
}
export function rates(loan) {
  const s = Array.isArray(loan.rates) ? loan.rates : [];
  return s.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.from || "") && n0(x.rate) >= 0)
    .map((x) => ({ from: x.from, rate: n0(x.rate) })).sort((a, b) => (a.from < b.from ? -1 : 1));
}
export const hasSchedule = (loan) => !!loan.first_due && steps(loan).length > 0;

// The instalment number due in the month of this date (1 = first_due's month).
export function instNo(loan, ymd) {
  if (!loan.first_due) return null;
  const f = loan.first_due;
  return (Number(ymd.slice(0, 4)) - Number(f.slice(0, 4))) * 12 + (Number(ymd.slice(5, 7)) - Number(f.slice(5, 7))) + 1;
}
// The instalment (EMI, or principal for a fixed-principal loan) number n.
export function stepAmount(loan, n) {
  const s = steps(loan);
  if (!s.length || n == null) return loan.method === "fixed" ? n0(loan.principal_amt) : n0(loan.emi);
  let a = s[0].amount;
  for (const x of s) if (x.from_no <= n) a = x.amount;
  return a;
}
export function amountOn(loan, ymd) {
  if (!hasSchedule(loan)) return loan.method === "fixed" ? n0(loan.principal_amt) : n0(loan.emi);
  const n = instNo(loan, ymd);
  if (loan.n_instalments && n > n0(loan.n_instalments)) return 0;
  return stepAmount(loan, Math.max(1, n));
}
export function rateOn(loan, ymd) {
  let r = n0(loan.rate_pct);
  for (const x of rates(loan)) if (x.from <= ymd) r = x.rate;
  return r;
}

// The schedule: every instalment with its due date and amount.
export function schedule(loan) {
  if (!hasSchedule(loan)) return [];
  const N = Math.min(600, Math.round(n0(loan.n_instalments)) || 0);
  const out = [];
  for (let n = 1; n <= N; n++) out.push({ n, due: addMonths(loan.first_due, n - 1), amount: stepAmount(loan, n) });
  return out;
}

// The rate a year (monthly rests, % ) at which the EMIs repay the loan exactly.
export function irr(loan) {
  if (loan.method === "fixed") return null;
  const sch = schedule(loan), P = n0(loan.loan_amount);
  if (!sch.length || !(P > 0)) return null;
  const t0 = loan.disbursed_on || addMonths(loan.first_due, -1);
  const total = sch.reduce((t, x) => t + x.amount, 0);
  if (total <= P) return total === P ? 0 : null;
  const pv = (i) => sch.reduce((t, x) => t + x.amount / Math.pow(1 + i, Math.max(0, dayN(x.due) - dayN(t0)) / MONTH), 0);
  let lo = 0, hi = 0.2;
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (pv(m) > P) lo = m; else hi = m; }
  return Math.round(((lo + hi) / 2) * 1200 * 100) / 100;
}
export function flatRate(loan) {
  const sch = schedule(loan), P = n0(loan.loan_amount);
  if (loan.method === "fixed" || !sch.length || !(P > 0)) return null;
  const total = sch.reduce((t, x) => t + x.amount, 0);
  return r2(((total - P) / P / (sch.length / 12)) * 100);
}

// The principal owed on a day if every instalment due by then was paid on
// time: EMI loans at the loan's rate (each rate from its date), monthly
// rests; fixed-principal loans: the loan less the principal instalments due.
export function balanceOn(loan, day) {
  const sch = schedule(loan), P = n0(loan.loan_amount);
  if (!sch.length || !(P > 0)) return null;
  let bal = P, prev = loan.disbursed_on || addMonths(loan.first_due, -1), paid = 0, interest = 0, principal = 0, lastDue = null;
  for (const x of sch) {
    if (x.due > day) break;
    let pr, it;
    if (loan.method === "fixed") { pr = Math.min(x.amount, bal); it = 0; }
    else {
      const i = rateOn(loan, x.due) / 1200;
      it = bal * (Math.pow(1 + i, Math.max(0, dayN(x.due) - dayN(prev)) / MONTH) - 1);
      pr = Math.min(x.amount - it, bal);
    }
    bal -= pr; interest += it; principal += pr; paid++; prev = x.due; lastDue = x.due;
  }
  const left = sch.filter((x) => x.due > day);
  return {
    balance: r2(Math.max(0, bal)), paid_n: paid, last_due: lastDue, interest_paid: r2(interest), principal_paid: r2(principal),
    left_n: left.length, left_amount: r2(left.reduce((t, x) => t + x.amount, 0)), next_due: left[0]?.due || null,
    next_amount: left[0]?.amount ?? null, total: r2(sch.reduce((t, x) => t + x.amount, 0)), n: sch.length,
    // EMI loans: what the rest of the instalments hold as interest
    interest_left: loan.method === "fixed" ? null : r2(left.reduce((t, x) => t + x.amount, 0) - Math.max(0, bal)),
  };
}
