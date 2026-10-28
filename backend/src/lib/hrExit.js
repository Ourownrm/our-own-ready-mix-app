// Round 249 — an employee leaving (owner, 28 Oct 2026: "a flow for when an
// employee leaves the company, an approval, block from accidental creation of
// any payment etc.").
//
//   raise     (hr.exit · create)        type, notice date, last working day, reason
//   approve   (hr.exit-approve · edit)  Admin; the employee's date of leaving is
//                                       set to the last working day, so
//                                       attendance and payroll stop there
//   complete  (hr.exit-approve · edit)  after the last working day: the final
//                                       settlement noted, the employee made
//                                       inactive, the app login turned off
//   reject / cancel                     the date of leaving goes back
//
// The blocks (exitBlock below), from the moment an exit is RAISED:
//   * no new salary advance — requested, paid or entered by hand;
//   * no PPE issued once it is approved;
// and once it is APPROVED, no salary payment for a month after the last
// working day's month (the final month is the full & final settlement).
import { query } from "../db.js";
import { ROUND249_SQL } from "./round249Schema.js";

let ready = null;
export function ensureExit() {
  if (!ready) ready = query(ROUND249_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
const fmt = (ymd) => new Date(`${ymd}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

// The open or finished exit of an employee (newest), with the employee's state.
export async function exitOf(empId, db = { query }) {
  await ensureExit();
  const { rows } = await db.query(
    `SELECT e.id AS employee_id, e.name, e.is_active, to_char(e.date_of_leaving, 'YYYY-MM-DD') AS date_of_leaving,
            x.id, x.status, x.kind, to_char(x.last_working_day, 'YYYY-MM-DD') AS last_working_day
       FROM hr_employees e
       LEFT JOIN LATERAL (SELECT * FROM hr_exits x WHERE x.employee_id = e.id AND x.status IN ('pending','approved','completed')
                           ORDER BY x.id DESC LIMIT 1) x ON true
      WHERE e.id = $1`, [empId]);
  return rows[0] || null;
}

// A reason the action must not happen, or null.
//   purpose: "advance" | "salary" (with month YYYY-MM) | "ppe"
export async function exitBlock(empId, purpose, { month } = {}, db) {
  const x = await exitOf(empId, db);
  if (!x) return null;
  const who = x.name;
  if (x.status === "completed" || (!x.is_active && x.date_of_leaving)) {
    const day = x.last_working_day || x.date_of_leaving;
    if (purpose === "salary" && month && day && month <= day.slice(0, 7)) return null;
    return `${who} has left the company${day ? ` (last working day ${fmt(day)})` : ""} — ${purpose === "salary" ? `no salary for ${month}` : purpose === "ppe" ? "no PPE can be issued" : "no advance can be given"}.`;
  }
  if (x.status === "pending" || x.status === "approved") {
    const lwd = x.last_working_day;
    if (purpose === "advance") return `${who} is leaving (exit ${x.status === "pending" ? "raised" : "approved"}, last working day ${fmt(lwd)}) — no new advance. Settle dues in the final settlement.`;
    if (purpose === "ppe" && x.status === "approved") return `${who} is leaving on ${fmt(lwd)} — no PPE issue. Collect the PPE back instead.`;
    if (purpose === "salary" && x.status === "approved" && month && month > lwd.slice(0, 7)) return `${who}'s last working day is ${fmt(lwd)} — no salary for ${month}.`;
  }
  return null;
}

// SQL: employees who must not be paid salary for month $N (approved / done exits
// whose last working day is before the month).
export const LEFT_BEFORE_MONTH_SQL = (p) => `employee_id NOT IN (SELECT employee_id FROM hr_exits
  WHERE status IN ('approved','completed') AND to_char(last_working_day, 'YYYY-MM') < ${p})`;
