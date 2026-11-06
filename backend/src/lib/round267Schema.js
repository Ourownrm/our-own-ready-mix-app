// Round 267 (v10.99) — owner, 6 Nov 2026: comp-off is no longer claimed.
//
//   "If an employee worked more than 4 hours in a weekly off day or holiday,
//    add that day as eligible comp off day to employee and employee can claim
//    a off day from the comp off balance, and comp off available should expire
//    as per the settings in HR. Some employees need a selection to accumulate
//    comp off with different expiry settings so they can claim it when they go
//    for leave."
//
// So:
//  * A weekly off / holiday worked for MORE than HR → Settings "comp-off earned
//    after (minutes)" (co_half_min, default 240 = 4 h) becomes a comp-off credit
//    by itself — an hr_compoff_claims row with source 'auto', status
//    'approved', no request and no approval. HR → Settings "comp-off days
//    earned" chooses a full day for any such day (default, the owner's rule) or
//    ½ / 1 day by the hours (the old 4 h / 8 h rule).
//  * The employee takes a day off from the balance as an ordinary leave of the
//    CO type (Ask for leave → Comp-off), approved like any leave. Credits are
//    used first-to-expire (lib/hrLeave.js compoffLedger, unchanged).
//  * Expiry follows HR settings, worked out from the day worked: co_expiry_days
//    normally, co_accum_expiry_days for an employee marked "accumulate
//    comp-off" (hr_employees.compoff_accumulate). Changing either setting, or
//    the tick, re-dates every credit still open.
//  * Earning starts on hr_settings 'compoff_auto_start' (the first day of the
//    month this round was deployed), so days already settled under the old
//    claim system — or already paid as overtime — are not credited again.
//  * Punch corrections are picked up for co_claim_days back (default 30). A
//    credit whose day no longer qualifies is withdrawn unless it has been used.
//    An auto credit Admin cancels by hand stays cancelled.
import { query } from "../db.js";
import { attendanceRegister } from "./hrAttendance.js";
import { loadRules } from "./hrRules.js";
import { compoffLedger, addDaysYmd } from "./hrLeave.js";

export const ROUND267_SQL = `
ALTER TABLE hr_compoff_claims ADD COLUMN IF NOT EXISTS source VARCHAR(8) NOT NULL DEFAULT 'claim';
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS compoff_accumulate BOOLEAN NOT NULL DEFAULT false;
INSERT INTO hr_settings (key, value)
  VALUES ('compoff_auto_start', to_jsonb(to_char(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD')))
  ON CONFLICT (key) DO NOTHING;
`;

let ready = null;
export function ensureRound267() {
  if (!ready) ready = query(ROUND267_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound267(pool, log) {
  await pool.query(ROUND267_SQL);
  log?.push?.("Round 267: comp-off is earned automatically from off days / holidays worked; balance with expiry, and 'accumulate' per employee.");
}

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// What a day earns by the rules (0, 0.5 or 1).
export function autoCompoffDays(day, rules) {
  if (!day || day.worked == null || !day.flags?.some((f) => f.startsWith("worked on"))) return 0;
  const half = Number(rules.co_half_min) || 240, full = Number(rules.co_full_min) || 480;
  if (rules.co_auto_days === "split") return day.worked >= full ? 1 : day.worked >= half ? 0.5 : 0;
  return day.worked > half ? 1 : 0;
}

export async function autoStart() {
  const { rows } = await query(`SELECT value FROM hr_settings WHERE key = 'compoff_auto_start'`);
  const v = rows[0]?.value;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : istToday().slice(0, 7) + "-01";
}

// What is left of each credit after every CO leave (approved or waiting).
async function creditsLeft(employeeIds) {
  const [cl, lv] = await Promise.all([
    query(`SELECT id, employee_id, status, days::float AS days, to_char(work_date, 'YYYY-MM-DD') AS work_date, to_char(expires_on, 'YYYY-MM-DD') AS expires_on
             FROM hr_compoff_claims WHERE employee_id = ANY($1::int[]) AND status = 'approved'`, [employeeIds]),
    query(`SELECT l.id, l.employee_id, l.leave_type_id, l.status, l.days::float AS days, to_char(l.from_date, 'YYYY-MM-DD') AS from_date,
                  to_char(l.to_date, 'YYYY-MM-DD') AS to_date, l.compoff_claim_id
             FROM hr_leaves l JOIN hr_leave_types t ON t.id = l.leave_type_id
            WHERE l.employee_id = ANY($1::int[]) AND l.status IN ('approved','pending') AND t.kind = 'comp_off'`, [employeeIds]),
  ]);
  const left = new Map();
  for (const id of employeeIds) {
    const led = compoffLedger(cl.rows.filter((c) => c.employee_id === id), lv.rows.filter((l) => l.employee_id === id), "9999-12-31");
    for (const c of led.credits) left.set(c.id, { days: c.days, left: c.left });
  }
  return left;
}

let lastAll = 0;
// Bring the auto credits up to date. With employeeIds: just those people
// (cheap — used before showing someone their own balance or checking a CO
// leave). Without: everybody, at most every 10 minutes unless forced.
export async function syncAutoCompoff({ employeeIds = null, force = false } = {}) {
  await ensureRound267();
  if (!employeeIds && !force && Date.now() - lastAll < 10 * 60 * 1000) return { skipped: true };
  if (!employeeIds) lastAll = Date.now();
  const rules = await loadRules();
  const today = istToday();
  const to = addDaysYmd(today, -1);
  let from = addDaysYmd(today, -Math.max(1, Number(rules.co_claim_days) || 30));
  const start = await autoStart();
  if (start > from) from = start;
  let added = 0, changed = 0, withdrawn = 0;
  if (from <= to) {
    const reg = await attendanceRegister({ from, to, employeeIds });
    const ids = reg.employees.map((e) => e.id);
    if (ids.length) {
      const { rows: existing } = await query(
        `SELECT id, employee_id, to_char(work_date, 'YYYY-MM-DD') AS d, status, source, days::float AS days, decided_by
           FROM hr_compoff_claims WHERE employee_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3`, [ids, from, to]);
      const byKey = new Map();
      for (const c of existing) {
        const k = `${c.employee_id}|${c.d}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(c);
      }
      const { rows: accRows } = await query(`SELECT id, compoff_accumulate FROM hr_employees WHERE id = ANY($1::int[])`, [ids]);
      const acc = new Map(accRows.map((r) => [r.id, !!r.compoff_accumulate]));
      let left = null;
      for (const e of reg.employees) {
        for (const day of e.days) {
          const earns = autoCompoffDays(day, rules);
          const rows = byKey.get(`${e.id}|${day.date}`) || [];
          const live = rows.find((c) => c.status === "pending" || c.status === "approved");
          const auto = rows.find((c) => c.source === "auto");
          const expiry = addDaysYmd(day.date, acc.get(e.id) ? Number(rules.co_accum_expiry_days) || 365 : Number(rules.co_expiry_days) || 60);
          if (earns > 0) {
            if (live) {
              if (live.source === "auto" && live.days !== earns) {
                left = left || await creditsLeft(ids);
                const l = left.get(live.id);
                if (!l || l.left >= l.days || earns > live.days) {
                  await query(`UPDATE hr_compoff_claims SET days = $1, worked_min = $2, qualifies = $1 WHERE id = $3`, [earns, day.worked, live.id]);
                  changed++;
                }
              }
              continue; // a manual claim already covers the day
            }
            if (auto && auto.decided_by) continue; // Admin cancelled this one by hand
            if (auto) {
              await query(`UPDATE hr_compoff_claims SET status = 'approved', days = $1, worked_min = $2, qualifies = $1, expires_on = $3,
                                  decided_at = now(), decision_note = 'Earned automatically — worked on an off day / holiday' WHERE id = $4`,
                [earns, day.worked, expiry, auto.id]);
              changed++;
              continue;
            }
            await query(
              `INSERT INTO hr_compoff_claims (employee_id, work_date, days, worked_min, qualifies, reason, status, expires_on, decided_at, decision_note, source)
               VALUES ($1, $2, $3, $4, $3, $5, 'approved', $6, now(), 'Earned automatically — worked on an off day / holiday', 'auto')
               ON CONFLICT (employee_id, work_date) WHERE status IN ('pending','approved') DO NOTHING`,
              [e.id, day.date, earns, day.worked, `Worked ${day.flags.find((f) => f.startsWith("worked on")).slice(10)}`, expiry]);
            added++;
          } else if (live && live.source === "auto" && live.status === "approved") {
            // The day no longer qualifies (punches corrected): withdrawn, unless used.
            left = left || await creditsLeft(ids);
            const l = left.get(live.id);
            if (!l || l.left >= l.days) {
              await query(`UPDATE hr_compoff_claims SET status = 'cancelled', decided_at = now(), decided_by = NULL,
                                  decision_note = 'Withdrawn automatically — the day no longer qualifies' WHERE id = $1`, [live.id]);
              withdrawn++;
            }
          }
        }
      }
    }
  }
  // Expiry as per the settings (and each person's accumulate tick), for every
  // credit still open.
  const { rowCount } = await query(
    `UPDATE hr_compoff_claims c
        SET expires_on = c.work_date + (CASE WHEN e.compoff_accumulate THEN $2::int ELSE $3::int END)
       FROM hr_employees e
      WHERE e.id = c.employee_id AND c.status IN ('pending','approved')
        AND ($1::int[] IS NULL OR c.employee_id = ANY($1::int[]))
        AND c.expires_on IS DISTINCT FROM c.work_date + (CASE WHEN e.compoff_accumulate THEN $2::int ELSE $3::int END)`,
    [employeeIds, Number(rules.co_accum_expiry_days) || 365, Number(rules.co_expiry_days) || 60]);
  return { added, changed, withdrawn, redated: rowCount };
}

// Fire-and-forget form for list screens: never blocks or breaks the page.
export function syncAutoCompoffQuiet(opts) {
  return syncAutoCompoff(opts).catch((err) => { console.error("comp-off auto sync:", err.message); return null; });
}
