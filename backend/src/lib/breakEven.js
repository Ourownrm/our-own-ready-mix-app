// Round 221 — the Break-even page (owner, 21 Oct 2026; mock-up v1,
// claude/break-even-page-mockup-v1.md). The month's costs split into two
// groups:
//
//   fixed    — the same whatever we sell: staff salaries, pump gangs and
//              monthly contract labour, admin, selling, rent, road tax,
//              insurance, depreciation, interest;
//   variable — rise with every m³: raw material, fuel, plant power, repairs,
//              hired vehicles, and the parts of payroll paid per m³ or per
//              trip (sales incentive, trip allowance, overtime).
//
// Which group each cost is in is an Administrator setting (cost_line_kinds),
// one setting for every month. Tax on profit is not in either — it only
// arises after break-even, so break-even is profit before tax = 0.
//
//   left per m³      = revenue per invoiced m³ − variable cost per m³ sold
//   break-even m³    = fixed costs ÷ left per m³
//   reached on       = the first day the month's sold m³, added up day by
//                      day, reach the break-even m³
//
// Revenue per m³ is on INVOICED m³ (a load held with no price has sold but
// has no revenue yet — it is counted at the month's average once invoiced);
// variable cost per m³ is on m³ SOLD, as on the Cost dashboard.
//
// Figures come from lib/costDashboard.js's month (the same as the P&L). A
// month that is not complete yet — the payroll not locked, the month's power
// or rent not entered — borrows the missing figure from the latest month that
// has it (a fixed cost as it is, a variable one per m³), and says so.
import { query } from "../db.js";
import { istMonth, istDay } from "./istDate.js";
import { newContext, monthCore, monthBounds, addMonths, monthLabel, monthsFrom } from "./costDashboard.js";

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

export async function lineKinds() {
  const { rows } = await query(
    `SELECT k.line_key, k.kind, k.changed_at, u.name AS by_name FROM cost_line_kinds k LEFT JOIN users u ON u.id = k.changed_by`).catch(() => ({ rows: [] }));
  const set = new Map(rows.map((r) => [r.line_key, r]));
  return Object.fromEntries(BE_LINES.map((l) => {
    const s = set.get(l.key);
    return [l.key, { kind: s ? s.kind : l.kind, default_kind: l.kind, changed: s && s.kind !== l.kind ? { at: s.changed_at, by: s.by_name } : null }];
  }));
}

// The month's raw figures per line, before anything is borrowed.
function rawLines(core) {
  const a = core.amounts, m = core.man;
  const inc = n0(m.incentive), trip = n0(m.trip), ot = n0(m.overtime);
  return {
    rm: a.rm, fuel: a.fuel, power: a.power, repairs: a.repairs, hired_vehicles: a.hired_vehicles,
    incentive: inc, trip, overtime: ot, salaries_base: r2(n0(m.staff) - inc - trip - ot),
    pump_gangs: n0(m.gangs), contract: n0(m.contract),
    admin_office: a.admin_office, selling: a.selling, rent_rates: a.rent_rates,
    road_tax: a.road_tax, insurance: a.insurance, other_certs: a.other_certs,
    depreciation: a.depreciation, interest: a.interest,
  };
}

// Is a line's figure for this month really there, or does it need borrowing?
function hasFigure(core, key) {
  if (ENTERED.has(key)) return !!core.entries[key];
  if (key === "salaries_base" || PAYROLL_VAR.includes(key)) return core.man.payroll_status !== "none";
  if (key === "pump_gangs" || key === "contract") return core.man.payroll_status !== "none" || core.man.gang_months_closed > 0 || core.man.bills_approved > 0;
  return true;
}
// A draft payroll is a figure, but it may still change.
function isDraft(core, key) {
  return (key === "salaries_base" || PAYROLL_VAR.includes(key) || key === "contract") && core.man.payroll_status === "draft";
}

const idle = (core) => !core.sales.loads && core.man.payroll_status === "none" && !Object.keys(core.entries).length;

// One month's break-even. `ctx` is lib/costDashboard.js's request context.
async function monthBE(ym, ctx, kinds) {
  const core = await monthCore(ym, ctx);
  const raw = rawLines(core);
  const qty = core.sales.qty;
  const lines = [];
  for (const def of BE_LINES) {
    const kind = kinds[def.key].kind;
    let amount = raw[def.key] || 0, estimated = null;
    if (!idle(core) && !hasFigure(core, def.key)) {
      // Borrow from the latest earlier month that has it (up to 12 back).
      for (let i = 1; i <= 12; i++) {
        const pm = addMonths(ym, -i);
        const pc = await monthCore(pm, ctx);
        if (idle(pc) || !hasFigure(pc, def.key) || isDraft(pc, def.key)) continue;
        const pv = rawLines(pc)[def.key] || 0;
        if (kind === "variable" && pc.sales.qty > 0) amount = r2((pv / pc.sales.qty) * qty);
        else amount = pv;
        estimated = { from: pm, label: `${kind === "variable" ? "per m³ of" : "as in"} ${monthLabel(pm)}` };
        break;
      }
      if (!estimated) estimated = { from: null, label: "not entered — counted as 0" };
    } else if (isDraft(core, def.key)) estimated = { from: null, label: "payroll not locked yet" };
    lines.push({ key: def.key, label: def.label, hint: def.hint, src: def.src, kind, amount: r2(amount),
      per_m3: qty > 0 ? Math.round(amount / qty) : null, estimated });
  }
  const a = core.amounts;
  const revenue = r2(a.concrete + a.pumping + a.part_load + a.other_income);
  const fixed = r2(lines.filter((l) => l.kind === "fixed").reduce((t, l) => t + l.amount, 0));
  const variable = r2(lines.filter((l) => l.kind === "variable").reduce((t, l) => t + l.amount, 0));
  const invoiced = core.sales.invoiced_m3;
  const revM3 = invoiced > 0 ? revenue / invoiced : null;
  const varM3 = qty > 0 ? variable / qty : null;
  const cm = revM3 != null && varM3 != null ? revM3 - varM3 : null;
  const beM3 = cm > 0 ? fixed / cm : null;

  // Day by day: m³ sold, and the day the running total reaches break-even.
  const { from, end, days } = monthBounds(ym);
  const byDay = new Map();
  for (const t of core.tickets) byDay.set(t.day, (byDay.get(t.day) || 0) + t.net);
  const today = istDay();
  const lastDay = ym === istMonth() ? today : end;
  const daily = [];
  let cum = 0, reached = null;
  for (let d = 1; d <= days; d++) {
    const day = `${ym}-${String(d).padStart(2, "0")}`;
    if (day > lastDay) break;
    const q = byDay.get(day) || 0;
    cum += q;
    if (reached == null && beM3 != null && cum >= beM3 - 1e-6) reached = { day, n: d };
    daily.push({ day, n: d, qty: r2(q), cum_qty: r2(cum), cum_contribution: cm != null ? r2(cum * cm) : null });
  }
  const daysSoFar = daily.length;
  let projection = null;
  if (!reached && beM3 != null && ym === istMonth() && daysSoFar > 0) {
    const pace = qty / daysSoFar;
    const need = beM3 - qty;
    const more = pace > 0 ? Math.ceil(need / pace) : null;
    const projDay = more != null ? daysSoFar + more : null;
    projection = { need_m3: Math.round(need), pace: Math.round(pace), days_more: more,
      on: projDay != null && projDay <= days ? `${ym}-${String(projDay).padStart(2, "0")}` : null };
  }
  return {
    month: ym, label: monthLabel(ym, true), short: monthLabel(ym), days, days_so_far: daysSoFar,
    is_current: ym === istMonth(), idle: idle(core),
    qty, invoiced_m3: invoiced, held_m3: core.sales.held_m3, revenue, fixed, variable,
    rev_m3: revM3 == null ? null : Math.round(revM3), var_m3: varM3 == null ? null : Math.round(varM3),
    cm_m3: cm == null ? null : Math.round(cm), cm_pct: cm != null && revM3 ? r2((cm / revM3) * 100) : null,
    be_m3: beM3 == null ? null : Math.round(beM3), be_sales: beM3 != null && revM3 ? r2(beM3 * revM3) : null,
    reached, projection,
    safety_m3: beM3 != null ? Math.round(qty - beM3) : null, safety_pct: beM3 != null && qty > 0 ? r2(((qty - beM3) / qty) * 100) : null,
    profit_since: reached && cm != null ? r2((qty - beM3) * cm) : null,
    pbt: r2(revenue - fixed - variable),
    estimated: lines.filter((l) => l.estimated).map((l) => ({ label: l.label, how: l.estimated.label })),
    lines, daily, core,
  };
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
