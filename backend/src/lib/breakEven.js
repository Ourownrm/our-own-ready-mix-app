// Round 221 — the Break-even page (owner, 21 Oct 2026; mock-up v1,
// claude/break-even-page-mockup-v1.md). Round 222 (owner, same night):
// "breakeven is the way to know whether the business is going to be in profit
// or loss, not required exact figures".
//
// The month's costs in two groups:
//   fixed    — the same whatever we sell: staff salaries, pump gangs and
//              contract labour, admin, selling, rent, road tax, insurance,
//              depreciation, interest;
//   variable — rise with every m³: raw material, fuel, plant power, repairs,
//              hired vehicles, and the parts of payroll paid per m³ or per
//              trip (sales incentive, trip allowance, overtime).
// Which group each cost is in is an Administrator setting (cost_line_kinds).
// Tax on profit is in neither — it only arises after break-even.
//
// THE OWNER'S DEFINITION (Round 222): every m³ we sell, less its variable
// cost, leaves a balance. Day by day those balances add up; the day (and the
// m³ sold by then) that the running total overcomes the month's fixed costs
// is break-even — after it, whatever we sell carries only its variable cost
// and the rest is profit. So the running total is built from each DAY's own
// figures, not a month average:
//   day's balance = that day's sales (invoice values excl. GST; a load not
//                   yet invoiced at the month's average ₹/m³)
//                 − that day's raw material (that day's batch weights, valued
//                   and scaled so the month adds up to the P&L figure)
//                 − the other variable costs at the month's ₹/m³ × that
//                   day's m³ (fuel, power, repairs … are not booked per load).
//
// SALARIES ARE ALWAYS IN (Round 222): until a month's payroll is locked,
// staff salaries, pump crews and contract labour are estimated from the
// employee records — the salary, the employer's PF / ESI, the contract rate,
// each crew member's monthly rate — for the whole month. Locked payroll,
// approved contractor bills and closed gang months replace the estimate.
// Other figures not in yet (the month's power or rent not entered) are
// borrowed from the latest month that has them, and named.
import { query } from "../db.js";
import { istMonth, istDay } from "./istDate.js";
import { newContext, monthCore, monthBounds, addMonths, monthLabel, monthsFrom } from "./costDashboard.js";
import { loadRules } from "./hrRules.js";
import { CONSUMPTION_CUTOVER } from "./plantConsumption.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;

export const BE_LINES = [
  { key: "rm", label: "Raw material consumed", hint: "batch weights × weighted average rate", kind: "variable", src: "app" },
  { key: "fuel", label: "Fuel issued", hint: "tank, outside fills, net adjustments", kind: "variable", src: "app" },
  { key: "power", label: "Plant power (electricity)", hint: "entered by Accounts", kind: "variable", src: "entered" },
  { key: "repairs", label: "Repairs & maintenance", hint: "Maintenance job cards", kind: "variable", src: "app" },
  { key: "hired_vehicles", label: "Hired vehicles & pumps", hint: "entered by Accounts", kind: "variable", src: "entered" },
  { key: "incentive", label: "Sales incentive", hint: "HR payroll · per m³ above the minimum", kind: "variable", src: "app" },
  { key: "trip", label: "Trip allowance", hint: "HR payroll · per trip", kind: "variable", src: "app" },
  { key: "overtime", label: "Overtime", hint: "HR payroll", kind: "variable", src: "app" },
  { key: "salaries_base", label: "Staff salaries & wages", hint: "HR payroll, cost to company — less incentive, trip allowance, overtime", kind: "fixed", src: "app" },
  { key: "pump_gangs", label: "Pump gangs", hint: "monthly rate per gang · contractor bills", kind: "fixed", src: "app" },
  { key: "contract", label: "Other contract labour", hint: "contractor bills / payroll", kind: "fixed", src: "app" },
  { key: "admin_office", label: "Admin & office", hint: "", kind: "fixed", src: "entered" },
  { key: "selling", label: "Selling & marketing", hint: "", kind: "fixed", src: "entered" },
  { key: "rent_rates", label: "Rent & rates", hint: "", kind: "fixed", src: "entered" },
  { key: "road_tax", label: "Road tax", hint: "quarterly payments ÷ 3", kind: "fixed", src: "app" },
  { key: "insurance", label: "Vehicle insurance", hint: "yearly premiums ÷ 12", kind: "fixed", src: "app" },
  { key: "other_certs", label: "Other certificates & permits", hint: "spread over their validity", kind: "fixed", src: "app" },
  { key: "depreciation", label: "Depreciation", hint: "from the fixed-asset register", kind: "fixed", src: "entered" },
  { key: "interest", label: "Finance cost (interest)", hint: "term & vehicle loans, cash credit", kind: "fixed", src: "entered" },
];
export const BE_KEYS = new Set(BE_LINES.map((l) => l.key));
const ENTERED = new Set(BE_LINES.filter((l) => l.src === "entered").map((l) => l.key));
const PAYROLL_VAR = ["incentive", "trip", "overtime"];

export const ROUND221_SQL = `
CREATE TABLE IF NOT EXISTS cost_line_kinds (
  line_key    VARCHAR(40) PRIMARY KEY,
  kind        VARCHAR(8) NOT NULL CHECK (kind IN ('fixed','variable')),
  changed_by  INTEGER REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Round 225 (owner, 21 Oct 2026: "some charges have both fixed and variable
// cost, like electricity — a fixed charge and a charge on usage"): a cost can
// also be PART FIXED — a fixed ₹ a month (e.g. the power bill's demand /
// fixed charge), the rest of that month's figure variable. Widened in place,
// once, the first time it is read (no /setup needed).
let mixedReady = null;
export function ensureMixedKinds() {
  if (!mixedReady) {
    mixedReady = query(`
      ALTER TABLE cost_line_kinds ADD COLUMN IF NOT EXISTS fixed_amount NUMERIC(14,2);
      ALTER TABLE cost_line_kinds DROP CONSTRAINT IF EXISTS cost_line_kinds_kind_check;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_line_kinds_kind_check2') THEN
          ALTER TABLE cost_line_kinds ADD CONSTRAINT cost_line_kinds_kind_check2 CHECK (kind IN ('fixed','variable','mixed'));
        END IF;
      END $$;`).catch((e) => { mixedReady = null; throw e; });
  }
  return mixedReady;
}

export async function lineKinds() {
  await ensureMixedKinds().catch(() => {});
  const { rows } = await query(
    `SELECT k.line_key, k.kind, k.fixed_amount, k.changed_at, u.name AS by_name FROM cost_line_kinds k LEFT JOIN users u ON u.id = k.changed_by`).catch(() => ({ rows: [] }));
  const set = new Map(rows.map((r) => [r.line_key, r]));
  return Object.fromEntries(BE_LINES.map((l) => {
    const s = set.get(l.key);
    const kind = s ? s.kind : l.kind;
    return [l.key, { kind, fixed_amount: kind === "mixed" ? n0(s.fixed_amount) : null, default_kind: l.kind,
      changed: s && s.kind !== l.kind ? { at: s.changed_at, by: s.by_name } : null }];
  }));
}

// The month's raw figures per line, before anything is borrowed.
function rawLines(core) {
  const a = core.amounts, m = core.man;
  const inc = n0(m.incentive), trip = n0(m.trip), ot = n0(m.overtime);
  return {
    rm: a.rm, fuel: a.fuel, power: a.power, repairs: a.repairs, hired_vehicles: a.hired_vehicles,
    incentive: inc, trip, overtime: ot, salaries_base: r2(n0(m.staff) - inc - trip - ot + n0(core.bank?.salaries)),
    pump_gangs: n0(m.gangs), contract: r2(n0(m.contract) + n0(core.bank?.contract_labour)),
    admin_office: a.admin_office, selling: a.selling, rent_rates: a.rent_rates,
    road_tax: a.road_tax, insurance: a.insurance, other_certs: a.other_certs,
    depreciation: a.depreciation, interest: a.interest,
  };
}

// Is a line's figure for this month really there, or does it need borrowing?
// (Salaries, crews and contract labour are never borrowed — they are estimated
// from the employee records instead, see estimateManpower.)
function hasFigure(core, key) {
  if (ENTERED.has(key)) return !!core.entries[key] || !!core.bank?.[key]; // Round 223 — or from the bank statements
  if (PAYROLL_VAR.includes(key)) return core.man.payroll_status !== "none";
  return true;
}

// Round 222 — a whole month's manpower from the employee records, for a month
// whose payroll is not locked. Approximate on purpose: full month, no leave
// or loss of pay, employer PF / ESI at the payroll rules' rates.
async function estimateManpower(ym, cache) {
  if (cache.has(ym)) return cache.get(ym);
  const p = (async () => {
    const { from, end, days } = monthBounds(ym);
    const [rules, emps, gangs] = await Promise.all([
      loadRules().catch(() => ({})),
      query(`SELECT e.id, e.employment_type, e.contractor_id, e.contract_basis, e.monthly_rate, e.daily_rate, e.service_charge_pct,
                    e.salary_basic, e.salary_da, e.salary_hra, e.salary_conveyance, e.salary_special, e.pf_applicable, e.esi_applicable,
                    e.weekly_off, to_char(e.date_of_joining, 'YYYY-MM-DD') AS joined, to_char(e.date_of_leaving, 'YYYY-MM-DD') AS left_on
               FROM hr_employees e
              WHERE (e.date_of_joining IS NULL OR e.date_of_joining <= $2::date)
                AND (e.date_of_leaving IS NULL OR e.date_of_leaving >= $1::date)
                AND (e.is_active OR e.date_of_leaving IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM hr_gang_members g WHERE g.employee_id = e.id
                                  AND g.from_date <= $2::date AND (g.to_date IS NULL OR g.to_date >= $1::date))`, [from, end])
        .catch(() => ({ rows: [] })),
      query(`SELECT m.monthly_rate, to_char(GREATEST(m.from_date, $1::date), 'YYYY-MM-DD') AS a, to_char(LEAST(COALESCE(m.to_date, $2::date), $2::date), 'YYYY-MM-DD') AS b
               FROM hr_gang_members m JOIN hr_gangs g ON g.id = m.gang_id
              WHERE m.from_date <= $2::date AND (m.to_date IS NULL OR m.to_date >= $1::date)`, [from, end]).catch(() => ({ rows: [] })),
    ]);
    const pfRate = n0(rules.pf_rate ?? 12) / 100, pfCap = n0(rules.pf_wage_cap ?? 15000);
    const esiRate = n0(rules.esi_employer_rate ?? 3.25) / 100, esiLimit = n0(rules.esi_gross_limit ?? 21000);
    const dayNum = (ymd) => Number(ymd.slice(8, 10));
    // Share of the month the person was employed.
    const share = (e) => {
      const a = e.joined && e.joined > from ? dayNum(e.joined) : 1;
      const b = e.left_on && e.left_on < end ? dayNum(e.left_on) : days;
      return Math.max(0, b - a + 1) / days;
    };
    // Working days in the month for a daily-rated worker (weekly off left out).
    const workDays = (wo) => {
      if (wo == null) return days;
      let n = 0;
      for (let d = 1; d <= days; d++) if (new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, d)).getUTCDay() !== Number(wo)) n++;
      return n;
    };
    let staff = 0, contract = 0, staffN = 0, contractN = 0;
    for (const e of emps.rows) {
      const f = share(e);
      if (f <= 0) continue;
      if (e.employment_type === "contract") {
        const base = e.contract_basis === "monthly" ? n0(e.monthly_rate) : n0(e.daily_rate) * workDays(e.weekly_off);
        contract += base * f * (1 + n0(e.service_charge_pct) / 100); contractN++;
      } else {
        const basicDa = n0(e.salary_basic) + n0(e.salary_da);
        const gross = basicDa + n0(e.salary_hra) + n0(e.salary_conveyance) + n0(e.salary_special);
        if (!gross) continue;
        const pf = e.pf_applicable ? Math.min(basicDa, pfCap) * pfRate : 0;
        const esi = e.esi_applicable && gross <= esiLimit ? gross * esiRate : 0;
        staff += (gross + pf + esi) * f; staffN++;
      }
    }
    let gangsAmt = 0;
    for (const g of gangs.rows) gangsAmt += n0(g.monthly_rate) * (Math.max(0, dayNum(g.b) - dayNum(g.a) + 1) / days);
    return { salaries_base: r2(staff), contract: r2(contract), pump_gangs: r2(gangsAmt), staff_n: staffN, contract_n: contractN, gang_members: gangs.rows.length };
  })();
  cache.set(ym, p);
  return p;
}

const idle = (core) => !core.sales.loads && core.man.payroll_status === "none" && !Object.keys(core.entries).length;

// One month's break-even. `ctx` is lib/costDashboard.js's request context.
async function monthBE(ym, ctx, kinds) {
  const core = await monthCore(ym, ctx);
  const raw = rawLines(core);
  const qty = core.sales.qty;
  const locked = core.man.payroll_status === "locked";
  const est = !idle(core) && !locked ? await estimateManpower(ym, ctx.beManCache || (ctx.beManCache = new Map())) : null;
  const lines = [];
  for (const def of BE_LINES) {
    const kind = kinds[def.key].kind;
    const fixedAmt = kinds[def.key].fixed_amount || 0;   // mixed: the fixed ₹ a month
    let amount = raw[def.key] || 0, estimated = null;
    if (idle(core)) { /* nothing recorded in this month */ }
    else if (["salaries_base", "pump_gangs", "contract"].includes(def.key)) {
      // Locked payroll (and approved bills / closed gang months) is used as
      // it is; otherwise the employee records give the whole month.
      if (!locked) {
        // Round 223 — plus wages paid from the bank that the app does not record.
        amount = est[def.key] + (def.key === "salaries_base" ? n0(core.bank?.salaries) : def.key === "contract" ? n0(core.bank?.contract_labour) : 0);
        estimated = { from: null, label: def.key === "salaries_base" ? `from ${est.staff_n} staff salaries on the employee records — payroll not locked`
          : def.key === "pump_gangs" ? `from ${est.gang_members} crew members' monthly rates` : `from ${est.contract_n} contract workers' rates` };
        if (!amount) {
          // No rates on the employee records — take the latest locked payroll month.
          for (let i = 1; i <= 12; i++) {
            const pm = addMonths(ym, -i);
            const pc = await monthCore(pm, ctx);
            if (pc.man.payroll_status !== "locked") continue;
            const pv = rawLines(pc)[def.key] || 0;
            if (!pv) continue;
            amount = pv;
            estimated = { from: pm, label: `as in ${monthLabel(pm)} — payroll not locked, no rates on the employee records` };
            break;
          }
        }
      } else if (def.key === "pump_gangs" && !amount && core.man.gang_months_closed === 0) {
        const e2 = await estimateManpower(ym, ctx.beManCache || (ctx.beManCache = new Map()));
        if (e2.pump_gangs) { amount = e2.pump_gangs; estimated = { from: null, label: `from ${e2.gang_members} crew members' monthly rates — gang month not closed` }; }
      }
    } else if (!hasFigure(core, def.key)) {
      // Borrow from the latest earlier month that has it (up to 12 back).
      for (let i = 1; i <= 12; i++) {
        const pm = addMonths(ym, -i);
        const pc = await monthCore(pm, ctx);
        if (idle(pc) || !hasFigure(pc, def.key)) continue;
        if (PAYROLL_VAR.includes(def.key) && pc.man.payroll_status !== "locked") continue;
        const pv = rawLines(pc)[def.key] || 0;
        if (kind === "variable" && pc.sales.qty > 0) amount = r2((pv / pc.sales.qty) * qty);
        else if (kind === "mixed" && pc.sales.qty > 0) amount = r2(Math.min(fixedAmt, pv) + (Math.max(0, pv - fixedAmt) / pc.sales.qty) * qty);
        else amount = pv;
        estimated = { from: pm, label: `${kind === "variable" ? "per m³ of" : kind === "mixed" ? "fixed part + usage per m³ of" : "as in"} ${monthLabel(pm)}` };
        break;
      }
      if (!estimated) estimated = { from: null, label: "not entered — counted as 0" };
    } else if (PAYROLL_VAR.includes(def.key) && core.man.payroll_status === "draft") {
      estimated = { from: null, label: "from the draft payroll" };
    }
    // Round 225 — each line's fixed part and variable part.
    const fixedPart = kind === "fixed" ? amount : kind === "mixed" ? Math.min(Math.max(0, fixedAmt), Math.max(0, amount)) : 0;
    const varPart = amount - fixedPart;
    lines.push({ key: def.key, label: def.label, hint: def.hint, src: def.src, kind, amount: r2(amount),
      fixed_amount: kind === "mixed" ? r2(fixedAmt) : null, fixed_part: r2(fixedPart), var_part: r2(varPart),
      per_m3: qty > 0 ? Math.round(varPart / qty) : null, estimated });
  }
  const a = core.amounts;
  const revenue = r2(a.concrete + a.pumping + a.part_load + a.other_income);
  const fixed = r2(lines.reduce((t, l) => t + l.fixed_part, 0));
  const variable = r2(lines.reduce((t, l) => t + l.var_part, 0));
  const invoiced = core.sales.invoiced_m3;
  const revM3 = invoiced > 0 ? revenue / invoiced : null;
  const varM3 = qty > 0 ? variable / qty : null;
  const cm = revM3 != null && varM3 != null ? revM3 - varM3 : null;
  const beM3 = cm > 0 ? fixed / cm : null;

  // Round 222 — day by day, from each day's own figures (see the note at the top).
  const { from, toEx, days } = monthBounds(ym);
  const end = monthBounds(ym).end;
  const avgInv = invoiced > 0 ? (n0(a.concrete) + n0(a.pumping) + n0(a.part_load)) / invoiced : 0;
  const otherIncomeM3 = qty > 0 ? n0(a.other_income) / qty : 0;
  const rmLine = lines.find((l) => l.key === "rm");
  const rmVar = rmLine ? rmLine.var_part : 0;          // raw material's variable part
  const otherVarM3 = qty > 0 ? (variable - rmVar) / qty : 0;
  const dayStat = new Map();
  const ds = (d) => { if (!dayStat.has(d)) dayStat.set(d, { qty: 0, rev: 0, rm: 0 }); return dayStat.get(d); };
  for (const t of core.tickets) {
    const x = ds(t.day);
    x.qty += t.net;
    x.rev += t.invoice_id ? t.concrete + t.pumping + t.part_load : t.net * avgInv;
  }
  // Raw material by day: the day's consumption valued at the month's rates,
  // scaled so the month adds up to the raw-material figure above.
  let rmByDayUsed = false;
  if (rmVar) {
    const byDay = await rmByDay(ym, from, toEx, ctx);
    const tot = [...byDay.values()].reduce((t, v) => t + v, 0);
    // Only when consumption is recorded day by day (the days with a figure
    // carry at least 80% of the m³ sold); a month booked in one go is spread
    // over the m³ sold instead, or it would show as one very bad day.
    let covQty = 0;
    for (const [d, x] of dayStat) if (byDay.get(d) > 0) covQty += x.qty;
    if (tot > 0 && qty > 0 && covQty / qty >= 0.8) { rmByDayUsed = true; for (const [d, v] of byDay) ds(d).rm += (v / tot) * rmVar; }
    else for (const x of dayStat.values()) x.rm += qty > 0 ? (x.qty / qty) * rmVar : 0;
  }
  const today = istDay();
  const lastDay = ym === istMonth() ? today : end;
  const daily = [];
  let cum = 0, cumQty = 0, reached = null;
  for (let d = 1; d <= days; d++) {
    const day = `${ym}-${String(d).padStart(2, "0")}`;
    if (day > lastDay) break;
    const x = dayStat.get(day) || { qty: 0, rev: 0, rm: 0 };
    const bal = x.rev + x.qty * otherIncomeM3 - x.rm - x.qty * otherVarM3;
    const before = cum, beforeQty = cumQty;
    cum += bal; cumQty += x.qty;
    if (reached == null && fixed > 0 && cum >= fixed - 0.5 && cum > before) {
      // m³ sold at the moment the running total met the fixed costs.
      const f = bal > 0 ? (fixed - before) / bal : 1;
      reached = { day, n: d, m3: Math.round(beforeQty + Math.max(0, Math.min(1, f)) * x.qty) };
    }
    daily.push({ day, n: d, qty: r2(x.qty), revenue: r2(x.rev), other_income: r2(x.qty * otherIncomeM3), material: r2(x.rm),
      other_var: r2(x.qty * otherVarM3), balance: r2(bal), cum_qty: r2(cumQty), cum_contribution: r2(cum),
      reached: !!reached && reached.day === day, before_qty: r2(beforeQty), before_cum: r2(before) });
  }
  const daysSoFar = daily.length;
  const covered = r2(Math.min(cum, fixed));
  let projection = null;
  if (!reached && ym === istMonth() && daysSoFar > 0 && fixed > 0) {
    const pace = cum / daysSoFar;                   // balance earned per day so far
    const need = fixed - cum;
    const more = pace > 0 ? Math.ceil(need / pace) : null;
    const projDay = more != null ? daysSoFar + more : null;
    projection = { need_amount: r2(need), need_m3: cm > 0 ? Math.round(need / cm) : null, pace_amount: r2(pace),
      pace: Math.round(qty / daysSoFar), days_more: more,
      on: projDay != null && projDay <= days ? `${ym}-${String(projDay).padStart(2, "0")}` : null };
  }
  return {
    month: ym, label: monthLabel(ym, true), short: monthLabel(ym), days, days_so_far: daysSoFar,
    is_current: ym === istMonth(), idle: idle(core),
    qty, invoiced_m3: invoiced, held_m3: core.sales.held_m3, revenue, fixed, variable,
    rev_m3: revM3 == null ? null : Math.round(revM3), var_m3: varM3 == null ? null : Math.round(varM3),
    cm_m3: cm == null ? null : Math.round(cm), cm_pct: cm != null && revM3 ? r2((cm / revM3) * 100) : null,
    be_m3: beM3 == null ? null : Math.round(beM3), be_sales: beM3 != null && revM3 ? r2(beM3 * revM3) : null,
    reached, projection, covered, earned: r2(cum),
    reached_m3: reached ? reached.m3 : null,
    safety_m3: reached ? Math.round(qty - reached.m3) : beM3 != null ? Math.round(qty - beM3) : null,
    safety_pct: qty > 0 && (reached || beM3 != null) ? r2(((qty - (reached ? reached.m3 : beM3)) / qty) * 100) : null,
    profit_since: reached ? r2(cum - fixed) : null,
    pbt: r2(revenue - fixed - variable),
    estimated: lines.filter((l) => l.estimated).map((l) => ({ label: l.label, how: l.estimated.label })),
    // Round 225 — the working, so the page can show every step.
    calc: {
      concrete: r2(a.concrete), pumping: r2(a.pumping), part_load: r2(a.part_load), other_income: r2(a.other_income),
      avg_inv_m3: r2(avgInv), other_income_m3: r2(otherIncomeM3), rm_var: r2(rmVar), rm_by_day: rmByDayUsed,
      other_var: r2(variable - rmVar), other_var_m3: r2(otherVarM3),
      held_value: r2(core.sales.held_m3 * avgInv), day_sales: r2(daily.reduce((t, x) => t + x.revenue, 0)),
      day_material: r2(daily.reduce((t, x) => t + x.material, 0)), day_other_var: r2(daily.reduce((t, x) => t + x.other_var, 0)),
      day_other_income: r2(daily.reduce((t, x) => t + x.other_income, 0)),
    },
    lines, daily, core,
  };
}

// Raw material consumed per day of the month, valued at the month's rates.
// Same sources as the Material module: the plant's batch weights and manual
// entries from the cutover, the hand-keyed daily figures before it.
async function rmByDay(ym, from, toEx, ctx) {
  const sql = from >= CONSUMPTION_CUTOVER
    ? `SELECT day, material_id, SUM(kg) AS kg FROM (
         SELECT pb.batch_date::text AS day, pm.material_id, pm.actual_kg AS kg FROM plant_batch_materials pm JOIN plant_batches pb ON pb.id = pm.batch_id
          WHERE pm.material_id IS NOT NULL AND pb.batch_date >= $1::date AND pb.batch_date < $2::date
         UNION ALL
         SELECT e.entry_date::text, e.material_id, e.qty_kg FROM plant_manual_entries e
          WHERE e.material_id IS NOT NULL AND e.entry_date >= $1::date AND e.entry_date < $2::date) x GROUP BY 1, 2`
    : `SELECT consumption_date::text AS day, material_id, SUM(COALESCE(automatic_qty_kg, manual_qty_kg, 0)) AS kg
         FROM rm_daily_consumption WHERE consumption_date >= $1::date AND consumption_date < $2::date GROUP BY 1, 2`;
  const { rows } = await query(sql, [from, toEx]).catch(() => ({ rows: [] }));
  const out = new Map();
  for (const r of rows) {
    const rate = ctx.rmRate(r.material_id, ym);
    if (rate == null) continue;
    out.set(r.day, (out.get(r.day) || 0) + n0(r.kg) * rate);
  }
  return out;
}

export async function breakEven(ym) {
  const ctx = await newContext();
  const kinds = await lineKinds();
  const sel = await monthBE(ym, ctx, kinds);
  const now = istMonth();
  // The six months to the selected one, and this month so far if newer.
  const hist = [];
  for (const m of monthsFrom(addMonths(ym, -5), ym)) {
    const b = m === ym ? sel : await monthBE(m, ctx, kinds);
    if (b.idle) continue;
    hist.push(b);
  }
  const current = ym < now ? await monthBE(now, ctx, kinds) : null;

  // What moves break-even, at the selected month's figures.
  let levers = [];
  if (sel.be_m3 != null && sel.cm_m3 > 0) {
    const be = (cm, fixed = sel.fixed) => (cm > 0 ? fixed / cm : null);
    const base = be(sel.cm_m3);
    const cementKg = sel.core.rm.materials.filter((r) => r.mix_component === "cement").reduce((t, r) => t + r.consumed_kg, 0);
    const cementPerM3 = sel.qty > 0 ? cementKg / sel.qty : 0;
    const litresPerM3 = sel.qty > 0 ? n0(sel.core.fuel.issued_litres) / sel.qty : 0;
    const perDay = sel.days_so_far ? sel.qty / sel.days_so_far : 0;
    const row = (what, b2) => {
      const d = Math.round(b2 - base);
      const days = perDay > 0 ? Math.abs(d) / perDay : null;
      return { what, change_m3: d, days: days == null ? null : Math.round(days * 10) / 10 };
    };
    levers = [
      row("₹100 more per m³ (better rate or cheaper mix)", be(sel.cm_m3 + 100)),
      ...(cementPerM3 > 0 ? [row(`Cement ₹10 more per bag (${Math.round(cementPerM3)} kg per m³)`, be(sel.cm_m3 - (cementPerM3 / 50) * 10))] : []),
      ...(litresPerM3 > 0 ? [row(`Diesel ₹5 more per litre (${litresPerM3.toFixed(2)} L per m³)`, be(sel.cm_m3 - litresPerM3 * 5))] : []),
      row("₹1 L more fixed cost a month (e.g. a new hire)", be(sel.cm_m3, sel.fixed + 100000)),
    ];
  }
  const strip = ({ core, ...rest }) => rest;
  return {
    month: ym, kinds,
    selected: strip(sel),
    history: hist.map((h) => { const { core, lines, daily, ...rest } = h; return rest; }),
    current: current && !current.idle ? (({ core, lines, ...rest }) => rest)(current) : null,
    levers,
    lines_meta: BE_LINES.map((l) => ({ key: l.key, label: l.label, default_kind: l.kind })),
  };
}
