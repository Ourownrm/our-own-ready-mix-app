// Round 155 — the frontend twin of backend/src/lib/istDate.js. Same rule, same
// reasons; see that file's header for the full story.
//
// Why the frontend needs it too, even though the plant's browsers are already
// set to IST: `toISOString()` is UTC no matter what the browser's timezone is,
// so `new Date().toISOString().slice(0, 10)` is just as wrong here as on the
// server between 00:00 and 05:30 IST. A report opened at 05:00 would label
// itself "today" and send yesterday's date as the filter.
//
// Pinning to Asia/Kolkata rather than reading the browser's own timezone is
// deliberate: "today" in this app means the plant's today. Somebody opening a
// report from a different timezone should see the plant's day, not theirs.
//
// One trap this file exists to prevent, which is worse than the 05:30 one and
// was live in CubeTestReport.jsx: mixing the local-fields constructor with
// toISOString(), e.g. `new Date(d.getFullYear(), d.getMonth(), 1).toISOString()`.
// That builds local IST midnight and then prints it in UTC, so it lands on the
// LAST DAY OF THE PREVIOUS MONTH — wrong on every day of the year, not just
// early mornings.

const IST = "Asia/Kolkata";

/** The plant's calendar day, as yyyy-mm-dd — what <input type="date"> wants. */
export function istDay(ms = Date.now()) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: IST });
}

/** Today at the plant. */
export function todayStr() {
  return istDay();
}

/** `n` days ago at the plant, as yyyy-mm-dd. */
export function daysAgoStr(n) {
  return istDay(Date.now() - n * 86400000);
}

/** The plant's current month, as yyyy-mm. */
export function istMonth(ms = Date.now()) {
  return istDay(ms).slice(0, 7);
}

/** The 1st of the plant's current month, as yyyy-mm-dd. */
export function monthStartStr(ms = Date.now()) {
  return `${istMonth(ms)}-01`;
}
