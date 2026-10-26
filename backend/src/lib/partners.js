// Round 242 — PARTNERS: capital and unsecured loans (owner, 26 Oct 2026).
//
//   "Capital Investment — an option in the cost dashboard to upload an Excel
//    sheet of the bank statement with only the capital contribution of the
//    partners; this should also cover capital returned, if any."
//   "Unsecured loan from partners — also an option to upload the unsecured
//    loans from partners (we pay 14% interest from the date of borrowing),
//    interest paid till date, balance interest for payment, TDS deducted etc."
//
// Every movement is one row in cost_partner_txns (round242Schema.js):
//   capital_in / capital_out   capital brought in / returned
//   loan_in / loan_out         loan borrowed / principal repaid
//   interest_paid              interest paid: `amount` is what reached the
//                              partner (net), `tds` what was deducted —
//                              interest settled = amount + tds
//   interest_due               interest owed at a start date (typed once, when
//                              the history before it is not uploaded)
//
// Interest: simple interest, worked by days — balance × rate % × days ÷ 365,
// from the day each amount was borrowed to the day it was repaid (or to the
// date asked). The rate is the partners' loan rate (14% by default) with any
// rate changes from a date. Interest is not compounded: interest left unpaid
// is owed as interest, it does not earn interest.
import { query } from "../db.js";
import { ROUND242_PARTNERS_SQL } from "./round242Schema.js";

let ready = null;
export async function ensurePartners() {
  if (!ready) ready = query(ROUND242_PARTNERS_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY_MS = 86400000;
const toMs = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10); // ist-ok: date arithmetic on UTC midnights (Date.UTC), never the clock
export const addDay = (ymd, n) => fromMs(toMs(ymd) + n * DAY_MS);
const days = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
export function fyOf(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  const s = m >= 4 ? y : y - 1;
  return { label: `${s}-${String((s + 1) % 100).padStart(2, "0")}`, start: `${s}-04-01`, end: `${s + 1}-03-31` };
}

export async function partnerSettings() {
  await ensurePartners();
  const [{ rows: s }, { rows: rates }] = await Promise.all([
    query(`SELECT loan_rate::float AS loan_rate, tds_rate::float AS tds_rate FROM cost_partner_settings WHERE id = 1`),
    query(`SELECT id, to_char(from_date, 'YYYY-MM-DD') AS from_date, rate::float AS rate FROM cost_partner_rates ORDER BY from_date`),
  ]);
  return { loan_rate: s[0]?.loan_rate ?? 14, tds_rate: s[0]?.tds_rate ?? 10, rates };
}

// The rate in force on a day.
function rateOn(settings, day) {
  let r = settings.loan_rate;
  for (const c of settings.rates) if (c.from_date <= day) r = c.rate;
  return r;
}
// Days where the rate changes, inside (a, b].
function rateBreaks(settings, a, b) {
  return settings.rates.map((c) => c.from_date).filter((d) => d > a && d < b);
}

// Interest on `bal` from day a (inclusive) to day b (exclusive), split where
// the rate changes, and spread over the months it falls in (for the P&L).
function accrue(settings, bal, a, b, byMonth) {
  if (!(bal > 0) || b <= a) return 0;
  let total = 0;
  const cuts = [a, ...rateBreaks(settings, a, b), b];
  for (let i = 0; i < cuts.length - 1; i++) {
    const rate = rateOn(settings, cuts[i]);
    // month by month inside this stretch
    let d = cuts[i];
    while (d < cuts[i + 1]) {
      const ym = d.slice(0, 7);
      const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
      const monthEnd = fromMs(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)); // first of next month
      const stop = monthEnd < cuts[i + 1] ? monthEnd : cuts[i + 1];
      const amt = (bal * rate * days(d, stop)) / 36500;
      total += amt;
      if (byMonth) byMonth.set(ym, (byMonth.get(ym) || 0) + amt);
      d = stop;
    }
  }
  return total;
}

// One partner's loan worked up to (not including) the day `until`: every
// movement dated before it, and interest for each day before it. "As on 31
// March" is until = 1 April — a loan taken on 1 April last year then has 365
// days of interest.
export function loanPosition(txns, settings, until) {
  const asOf = until;
  const rows = txns.filter((t) => ["loan_in", "loan_out", "interest_paid", "interest_due"].includes(t.kind) && t.txn_date < until)
    .sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.id - b.id));
  const byMonth = new Map();
  const ledger = [];
  let bal = 0, accrued = 0, paidGross = 0, paidNet = 0, tds = 0, borrowed = 0, repaid = 0, openingDue = 0;
  let last = rows[0]?.txn_date || null;
  for (const t of rows) {
    if (last && t.txn_date > last) { accrued += accrue(settings, bal, last, t.txn_date, byMonth); }
    last = t.txn_date;
    const amt = Number(t.amount) || 0, td = Number(t.tds) || 0;
    if (t.kind === "loan_in") { bal += amt; borrowed += amt; }
    else if (t.kind === "loan_out") { bal -= amt; repaid += amt; }
    else if (t.kind === "interest_paid") { paidGross += amt + td; paidNet += amt; tds += td; }
    else if (t.kind === "interest_due") { openingDue += amt; }
    ledger.push({ id: t.id, date: t.txn_date, kind: t.kind, amount: r2(amt), tds: r2(td), narration: t.narration, note: t.note,
      balance: r2(bal), interest_to_date: r2(accrued + openingDue), interest_due: r2(accrued + openingDue - paidGross), upload_id: t.upload_id });
  }
  if (last && asOf > last) accrued += accrue(settings, bal, last, asOf, byMonth);
  const due = accrued + openingDue - paidGross;
  return {
    borrowed: r2(borrowed), repaid: r2(repaid), outstanding: r2(bal),
    interest_accrued: r2(accrued), interest_opening: r2(openingDue), interest_total: r2(accrued + openingDue),
    interest_paid_gross: r2(paidGross), interest_paid_net: r2(paidNet), tds: r2(tds),
    interest_due: r2(due), tds_on_due: r2(Math.max(0, due) * settings.tds_rate / 100), net_due: r2(Math.max(0, due) * (1 - settings.tds_rate / 100)),
    rate_now: rateOn(settings, addDay(asOf, -1)), first_date: rows.find((t) => t.kind === "loan_in")?.txn_date || null,
    by_month: [...byMonth.entries()].sort().map(([ym, v]) => ({ ym, interest: r2(v) })),
    ledger,
  };
}

export function capitalPosition(txns, asOf) {
  const rows = txns.filter((t) => (t.kind === "capital_in" || t.kind === "capital_out") && t.txn_date <= asOf)
    .sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.id - b.id));
  let bal = 0, inn = 0, out = 0;
  const ledger = rows.map((t) => {
    const a = Number(t.amount) || 0;
    if (t.kind === "capital_in") { bal += a; inn += a; } else { bal -= a; out += a; }
    return { id: t.id, date: t.txn_date, kind: t.kind, amount: r2(a), narration: t.narration, note: t.note, balance: r2(bal), upload_id: t.upload_id };
  });
  return { brought_in: r2(inn), returned: r2(out), balance: r2(bal), ledger };
}

async function loadAll() {
  await ensurePartners();
  const [{ rows: partners }, { rows: txns }] = await Promise.all([
    query(`SELECT id, name, match_words, pan, is_active FROM cost_partners ORDER BY is_active DESC, name`),
    query(`SELECT id, partner_id, kind, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, amount::float AS amount, tds::float AS tds,
                  narration, note, upload_id FROM cost_partner_txns ORDER BY txn_date, id`),
  ]);
  return { partners, txns };
}

// The whole page: every partner's capital and loan as on `asOf`, totals, and
// a financial-year summary (interest, TDS) for the year of `asOf` and the one
// before it.
export async function partnersReport(asOf) {
  const settings = await partnerSettings();
  const { partners, txns } = await loadAll();
  const fy = fyOf(asOf);
  const prevFy = fyOf(addDay(fy.start, -1));
  const out = partners.map((p) => {
    const mine = txns.filter((t) => t.partner_id === p.id);
    const cap = capitalPosition(mine, asOf);
    const loan = loanPosition(mine, settings, addDay(asOf, 1));
    const fyRow = (f) => {
      const end = f.end < asOf ? f.end : asOf;
      const before = loanPosition(mine, settings, f.start);
      const after = loanPosition(mine, settings, addDay(end, 1));
      const inFy = mine.filter((t) => t.txn_date >= f.start && t.txn_date <= end);
      const sum = (k, f2 = "amount") => r2(inFy.filter((t) => t.kind === k).reduce((a, t) => a + (Number(t[f2]) || 0), 0));
      return {
        fy: f.label, from: f.start, to: end,
        interest: r2(after.interest_accrued - before.interest_accrued),
        paid_net: sum("interest_paid"), tds: sum("interest_paid", "tds"),
        borrowed: sum("loan_in"), repaid: sum("loan_out"),
        capital_in: sum("capital_in"), capital_out: sum("capital_out"),
      };
    };
    return {
      id: p.id, name: p.name, match_words: p.match_words, pan: p.pan, is_active: p.is_active,
      capital: cap, loan, fy: [fyRow(fy), prevFy.start >= "2000-01-01" ? fyRow(prevFy) : null].filter(Boolean),
      txn_count: mine.length,
    };
  });
  const tot = (f) => r2(out.reduce((a, p) => a + f(p), 0));
  const { rows: uploads } = await query(
    `SELECT u.id, u.book, u.file_name, u.lines, u.uploaded_at, us.name AS uploaded_by,
            (SELECT COUNT(*)::int FROM cost_partner_txns t WHERE t.upload_id = u.id) AS kept
       FROM cost_partner_uploads u LEFT JOIN users us ON us.id = u.uploaded_by ORDER BY u.uploaded_at DESC LIMIT 30`);
  return {
    as_of: asOf, fy: fy.label, prev_fy: prevFy.label, settings,
    partners: out,
    totals: {
      capital: tot((p) => p.capital.balance), capital_in: tot((p) => p.capital.brought_in), capital_out: tot((p) => p.capital.returned),
      loans: tot((p) => p.loan.outstanding), borrowed: tot((p) => p.loan.borrowed), repaid: tot((p) => p.loan.repaid),
      interest_total: tot((p) => p.loan.interest_total), interest_paid_gross: tot((p) => p.loan.interest_paid_gross),
      interest_paid_net: tot((p) => p.loan.interest_paid_net), tds: tot((p) => p.loan.tds),
      interest_due: tot((p) => p.loan.interest_due), tds_on_due: tot((p) => p.loan.tds_on_due), net_due: tot((p) => p.loan.net_due),
      fy_interest: tot((p) => p.fy[0]?.interest || 0), fy_tds: tot((p) => p.fy[0]?.tds || 0), fy_paid_net: tot((p) => p.fy[0]?.paid_net || 0),
    },
    uploads,
  };
}

// For the P&L: partners' loan interest accrued in a month (all partners).
export async function partnerInterestMonth(ym) {
  await ensurePartners();
  const { rows: n } = await query(`SELECT COUNT(*)::int AS n FROM cost_partner_txns WHERE kind IN ('loan_in','loan_out')`);
  if (!n[0].n) return 0;
  const settings = await partnerSettings();
  const { partners, txns } = await loadAll();
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const nextFirst = fromMs(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  let total = 0;
  for (const p of partners) {
    const pos = loanPosition(txns.filter((t) => t.partner_id === p.id), settings, nextFirst);
    total += pos.by_month.find((x) => x.ym === ym)?.interest || 0;
  }
  return r2(total);
}

// For the Balance Sheet: capital, loans and interest owed on a day. Null
// when nothing has been entered for that part (the typed figure is used).
export async function partnerBalancesOn(day) {
  await ensurePartners();
  const { rows: k } = await query(
    `SELECT COUNT(*) FILTER (WHERE kind IN ('capital_in','capital_out'))::int AS cap,
            COUNT(*) FILTER (WHERE kind IN ('loan_in','loan_out','interest_paid','interest_due'))::int AS loan
       FROM cost_partner_txns WHERE txn_date <= $1::date`, [day]);
  if (!k[0].cap && !k[0].loan) return {};
  const settings = await partnerSettings();
  const { partners, txns } = await loadAll();
  // interest up to and including `day`
  const until = addDay(day, 1);
  let cap = 0, loans = 0, due = 0;
  for (const p of partners) {
    const mine = txns.filter((t) => t.partner_id === p.id && t.txn_date <= day);
    cap += capitalPosition(mine, day).balance;
    const l = loanPosition(mine, settings, until);
    loans += l.outstanding; due += Math.max(0, l.interest_due);
  }
  const out = {};
  if (k[0].cap) out.capital = r2(cap);
  if (k[0].loan) { out.partner_loans = r2(loans); out.partner_interest_due = r2(due); }
  return out;
}

// Bank-statement cost lines that are the same payment as a partner's
// interest (same day, same amount) — so the interest is not counted twice
// when the bank statement line was also given the head "interest".
export const PARTNER_DUP_SQL = `NOT EXISTS (SELECT 1 FROM cost_partner_txns pt
  WHERE pt.kind = 'interest_paid' AND pt.txn_date = l.txn_date AND pt.amount = l.debit)`;
