// Round 155 — the one place the app is allowed to turn "now" into a date.
//
// THE BUG THIS EXISTS TO END. The plant runs in India (IST, UTC+05:30). Every
// Postgres connection is pinned to Asia/Kolkata before it is handed out
// (src/db.js), so CURRENT_DATE, now()::date and x::date in SQL are all the IST
// calendar day. The backend's Node process runs with no TZ set, so it is UTC.
//
// `new Date().toISOString().slice(0, 10)` is therefore the UTC day, and between
// 00:00 and 05:30 IST every single morning it is YESTERDAY as far as the
// database is concerned. A value built that way and then compared against — or
// stored in — a date column is wrong for five and a half hours a day.
//
// This has been found and fixed in rounds 134, 153, 154 and now 155, in
// different files each time, because each fix was local. The Round 145-154
// review found 49 remaining instances. So: one helper, used everywhere, plus
// scripts/check-dates.mjs to fail the build if the raw form comes back.
//
// THE RULE. Never build a date from `new Date()` by hand. If the decision can
// be made in SQL — "is this overdue", "is this today" — make it in SQL with
// CURRENT_DATE and do not bring it into JavaScript at all. If you genuinely
// need a date string in JS (a default for a query parameter, a value to store),
// use these.
//
// `en-CA` is used because it formats as yyyy-mm-dd, which is what Postgres and
// <input type="date"> both want. It is a formatting locale, not a claim about
// where anybody is.

export const IST = "Asia/Kolkata";

/** The IST calendar day, as yyyy-mm-dd. `ms` defaults to now. */
export function istDay(ms = Date.now()) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: IST });
}

/** The IST calendar month, as yyyy-mm. */
export function istMonth(ms = Date.now()) {
  return istDay(ms).slice(0, 7);
}

/** `n` days before the IST today, as yyyy-mm-dd. Use a negative n for the future. */
export function istDaysAgo(n, ms = Date.now()) {
  return istDay(ms - n * 86400000);
}

/** `n` days after the IST today, as yyyy-mm-dd. */
export function istDaysFromNow(n, ms = Date.now()) {
  return istDaysAgo(-n, ms);
}

/** First day of the IST current month, as yyyy-mm-dd. */
export function istMonthStart(ms = Date.now()) {
  return `${istMonth(ms)}-01`;
}

/**
 * How many days of the given yyyy-mm month have elapsed, in IST.
 *
 * For the CURRENT month that is today's day-of-month. For a month that has
 * already finished it is the month's full length — which is the distinction
 * the old `new Date().getDate()` got wrong in two separate ways: it used the
 * UTC day-of-month, and it used TODAY's regardless of which month was asked
 * for, so a historical query divided that month's consumption by today's date.
 *
 * A future month returns 0, and callers treat that as "no meaningful average".
 */
export function daysElapsedIn(yyyymm, ms = Date.now()) {
  const today = istDay(ms);
  const thisMonth = today.slice(0, 7);
  if (yyyymm === thisMonth) return Number(today.slice(8, 10));
  if (yyyymm > thisMonth) return 0;
  // Day 0 of the following month is the last day of this one.
  const [y, m] = yyyymm.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
