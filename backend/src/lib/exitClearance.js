// Round 264 — exit clearance (owner, 2 Nov 2026: "Salary should not be
// processed (highlight on payroll) until exit clearance is done, so we need an
// exit clearance approval system").
//
// Opened when an exit is APPROVED. Five sections, each cleared by whoever the
// Access Control page names for it:
//   tools     Plant In Charge (tools.approve)      — nothing may still be held
//   assets    Administrator   (hr.assets · edit)   — laptop, phone, SIM, ID card…
//   money     Accounts        (hr.exit-clear-money)— advances, cash in hand, petty cash
//   ppe       HR              (hr.ppe · edit)      — PPE back
//   handover  Manager         (hr.exit-clear-handover)
// Tools, assets and PPE clear themselves when the person holds nothing.
// When all five are clear the Administrator approves the clearance
// (hr.exit-approve). Until then salary is held on payroll, and the exit
// cannot be completed.
import { query } from "../db.js";
import { can } from "./permissions.js";
import { ensureRound264 } from "./round264Schema.js";

export const SECTIONS = [
  { key: "tools", label: "Tools & power tools", who: "Plant In Charge", perm: ["tools.approve", "edit"], auto: true },
  { key: "assets", label: "Personal assets & company data", who: "Administrator", perm: ["hr.assets", "edit"], auto: true },
  { key: "money", label: "Money — advances, cash in hand, petty cash", who: "Accounts", perm: ["hr.exit-clear-money", "edit"] },
  { key: "ppe", label: "PPE", who: "HR", perm: ["hr.ppe", "edit"], auto: true },
  { key: "handover", label: "Work handover", who: "Reporting manager", perm: ["hr.exit-clear-handover", "edit"] },
];

// What the employee still holds, by section.
async function held(employeeId, db) {
  const [tl, ppe] = await Promise.all([
    db.query(
      `SELECT i.code, i.kind, t.name, (i.status = 'issued') AS issued FROM tl_items i JOIN tl_types t ON t.id = i.type_id
        WHERE i.employee_id = $1 AND i.status = 'issued'
       UNION ALL
       SELECT i.code, i.kind, t.name, false FROM tl_issue_lines l JOIN tl_issues s ON s.id = l.issue_id JOIN tl_items i ON i.id = l.item_id
         JOIN tl_types t ON t.id = i.type_id WHERE s.employee_id = $1 AND s.status = 'pending'`, [employeeId]),
    db.query(`SELECT i.name, s.qty FROM hr_ppe_issues s JOIN hr_ppe_items i ON i.id = s.item_id WHERE s.employee_id = $1 AND s.returned_on IS NULL`, [employeeId]),
  ]);
  return {
    tools: tl.rows.filter((r) => r.kind !== "asset").map((r) => `${r.code} ${r.name}`),
    assets: tl.rows.filter((r) => r.kind === "asset").map((r) => `${r.code} ${r.name}`),
    ppe: ppe.rows.map((r) => `${r.name}${Number(r.qty) > 1 ? ` × ${r.qty}` : ""}`),
  };
}

// The clearance of one exit: sections with state, and whether it is done.
export async function clearanceOf(exitRow, db = { query }) {
  await ensureRound264();
  const [{ rows }, h] = await Promise.all([
    db.query(`SELECT c.*, u.name AS cleared_by_name FROM hr_exit_clearance c LEFT JOIN users u ON u.id = c.cleared_by WHERE c.exit_id = $1`, [exitRow.id]),
    held(exitRow.employee_id, db),
  ]);
  const by = new Map(rows.map((r) => [r.section, r]));
  const sections = SECTIONS.map((s) => {
    const r = by.get(s.key);
    const holding = h[s.key] || [];
    const cleared = r?.status === "cleared" && !holding.length;
    const auto = !!s.auto && !holding.length && !cleared;
    return { key: s.key, label: s.label, who: s.who, holding, done: cleared || auto, auto, note: r?.note || null,
      cleared_by: r?.cleared_by_name || null, cleared_at: r?.cleared_at || null };
  });
  const done = sections.filter((s) => s.done).length;
  return { sections, done, total: sections.length, all_clear: done === sections.length,
    approved_at: exitRow.clearance_approved_at || null };
}

export async function canClear(user, section) {
  const s = SECTIONS.find((x) => x.key === section);
  return !!s && (await can(user, s.perm[0], s.perm[1]));
}

// Employees whose salary is on hold: an approved exit whose clearance the
// Administrator has not approved yet. { employee_id: { exit_id, done, total } }
export async function payrollHolds(employeeIds = null) {
  await ensureRound264();
  const { rows } = await query(
    `SELECT x.id, x.employee_id, x.clearance_approved_at FROM hr_exits x
      WHERE x.status = 'approved' AND x.clearance_approved_at IS NULL ${employeeIds ? "AND x.employee_id = ANY($1::int[])" : ""}`,
    employeeIds ? [employeeIds] : []);
  const out = {};
  for (const x of rows) {
    const c = await clearanceOf(x);
    out[x.employee_id] = { exit_id: x.id, done: c.done, total: c.total };
  }
  return out;
}
// For SQL: employees on hold (used by Pay all).
export const NOT_ON_HOLD_SQL = `employee_id NOT IN (SELECT employee_id FROM hr_exits WHERE status = 'approved' AND clearance_approved_at IS NULL)`;
