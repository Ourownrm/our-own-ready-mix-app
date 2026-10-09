// Round 198 — the HR rules a person can change on HR > Settings > Payroll rules.
// Stored one key per row in hr_settings; anything never saved uses the default.
import { query } from "../db.js";

export const RULE_DEFS = {
  // attendance
  missed_punch_at_lock: { label: "An unresolved missed punch, when the month is locked, counts as", type: "enum", options: { half: "Half day", absent: "Absent" }, default: "half" },
  missed_punch_monthly_limit: { label: "Missed-punch requests a Plant Manager may approve per person per month (more go to Admin)", type: "int", min: 0, max: 31, default: 3 },
  request_backdate_days: { label: "Requests older than this many days go to Admin", type: "int", min: 0, max: 60, default: 3 },
  // overtime
  ot_after_min: { label: "Overtime counts only when it is at least (minutes)", type: "int", min: 0, max: 240, default: 30 },
  ot_step_min: { label: "Overtime is rounded down to steps of (minutes)", type: "int", min: 1, max: 120, default: 30 },
  ot_standard_day_min: { label: "Normal working day with no shift set (minutes) — overtime after this", type: "int", min: 240, max: 960, default: 480 },
  ot_multiplier: { label: "Overtime rate × normal hourly rate", type: "num", min: 1, max: 3, default: 2 },
  ot_hours_per_day: { label: "Hours in a normal day (for the hourly rate)", type: "num", min: 4, max: 12, default: 8 },
  // statutory
  pf_rate: { label: "PF — employee and employer, % of Basic + DA", type: "num", min: 0, max: 20, default: 12 },
  pf_wage_cap: { label: "PF wage ceiling (₹ Basic + DA per month)", type: "num", min: 0, max: 100000, default: 15000 },
  esi_employee_rate: { label: "ESI — employee %", type: "num", min: 0, max: 5, default: 0.75 },
  esi_employer_rate: { label: "ESI — employer %", type: "num", min: 0, max: 10, default: 3.25 },
  esi_gross_limit: { label: "ESI applies when monthly gross is at most (₹)", type: "num", min: 0, max: 100000, default: 21000 },
  pt_amount: { label: "Professional tax per month (₹)", type: "num", min: 0, max: 2500, default: 200 },
  pt_threshold: { label: "Professional tax when the month's earnings reach (₹)", type: "num", min: 0, max: 200000, default: 25000 },
  bonus_rate: { label: "Bonus provision % (of Basic + DA, up to the ceiling)", type: "num", min: 0, max: 20, default: 8.33 },
  bonus_wage_cap: { label: "Bonus wage ceiling (₹ per month)", type: "num", min: 0, max: 100000, default: 7000 },
  gratuity_rate: { label: "Gratuity provision % of Basic + DA", type: "num", min: 0, max: 10, default: 4.81 },
};

export async function loadRules() {
  const { rows } = await query(`SELECT key, value FROM hr_settings`);
  const saved = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const [k, d] of Object.entries(RULE_DEFS)) out[k] = k in saved ? saved[k] : d.default;
  return out;
}

export function validateRule(key, value) {
  const d = RULE_DEFS[key];
  if (!d) throw Object.assign(new Error(`Unknown rule "${key}".`), { expose: true });
  if (d.type === "enum") {
    if (!(value in d.options)) throw Object.assign(new Error(`${d.label}: not an allowed choice.`), { expose: true });
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < d.min || n > d.max || (d.type === "int" && !Number.isInteger(n))) {
    throw Object.assign(new Error(`${d.label}: must be ${d.type === "int" ? "a whole number" : "a number"} from ${d.min} to ${d.max}.`), { expose: true });
  }
  return n;
}
