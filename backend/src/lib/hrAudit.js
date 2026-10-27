// Round 245 — the HR money audit trail (owner, 27 Oct 2026: "admin should be
// able to audit and correct salary and advances entries"). Every change to an
// advance or to a payroll figure is written here; nothing is ever edited or
// deleted from this table.
import { query } from "../db.js";
import { ROUND245_HR_AUDIT_SQL } from "./round245Schema.js";

let ready = null;
export function ensureHrAudit() {
  if (!ready) ready = query(ROUND245_HR_AUDIT_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}

// Best effort: a failed audit write is logged, never blocks the change itself.
export async function audit(db, { user, entity, entityId = null, employeeId = null, month = null, action, before = null, after = null, reason = null }) {
  try {
    await ensureHrAudit();
    await (db || { query }).query(
      `INSERT INTO hr_money_audit (user_id, entity, entity_id, employee_id, month, action, before, after, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [user?.id || null, entity, entityId, employeeId, month, action,
        before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason ? String(reason).slice(0, 300) : null]);
  } catch (err) {
    console.error("hr audit write failed:", err.message);
  }
}

export async function auditList({ month = null, employeeId = null, limit = 300 } = {}) {
  await ensureHrAudit();
  const { rows } = await query(
    `SELECT a.id, a.at, a.entity, a.entity_id, a.employee_id, a.month, a.action, a.before, a.after, a.reason,
            u.name AS user_name, e.name AS employee_name, e.emp_code
       FROM hr_money_audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN hr_employees e ON e.id = a.employee_id
      WHERE ($1::text IS NULL OR a.month = $1 OR to_char(a.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1)
        AND ($2::int IS NULL OR a.employee_id = $2)
      ORDER BY a.at DESC, a.id DESC LIMIT $3`, [month, employeeId, limit]);
  return rows;
}
