// Round 209 — the proposed rate of a mix (owner, 13 Oct 2026; mock-up
// "Quotation — Mix Designs, Approved Grades & Salesperson"). Administrator only.
//
//   cost / m³ = material (mix design kg/m³ × this month's weighted-average
//               landed rate per kg; the latest month with receipts if none yet)
//             + fuel    (site-specific from the road km, the all-site average,
//                        or the Admin's value — chosen on each quotation)
//             + salary  (last locked payroll ÷ m³ that month, or Admin value)
//             + other   (a fixed ₹ / m³ set by the Admin)
//   proposed  = cost × (1 + margin) × (1 + GST), rounded
//
// Site-specific fuel per m³:
//   transit mixer = (2 × road km ÷ fleet km per litre + drum & waiting litres)
//                   ÷ load per trip
//   pump          = litres per hour × pour hours ÷ 60 m³ (pumping only)
//   genset/loader = last month's litres ÷ m³ produced (or the Admin's values)
//   × the diesel rate (latest in the Fuel module).
import { query } from "../db.js";
import { productionM3Range, firstOfNextMonth } from "./plantConsumption.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v, d) => (v === "" || v == null || !Number.isFinite(Number(v)) ? d : Number(v));

export const COSTING_DEFAULT = {
  fuel_mode: "actual", fuel_set: null, fuel_months: 1,
  salary_mode: "actual", salary_set: null,
  other_per_m3: 0, margin_pct: 12, gst_pct: 18, round_to: 10,
  drum_litres_per_trip: 2, line_pump_lph: 5, boom_pump_lph: 8, pour_hours_per_60: 5,
  default_load_m3: 6, tm_kmpl: 3, plant_fuel_mode: "actual", genset_lpm3: null, loader_lpm3: null,
};

export function cleanCosting(b = {}) {
  const c = { ...COSTING_DEFAULT };
  c.fuel_mode = b.fuel_mode === "set" ? "set" : "actual";
  c.fuel_set = num(b.fuel_set, null);
  c.fuel_months = [1, 3].includes(Number(b.fuel_months)) ? Number(b.fuel_months) : 1;
  c.salary_mode = b.salary_mode === "set" ? "set" : "actual";
  c.salary_set = num(b.salary_set, null);
  c.plant_fuel_mode = b.plant_fuel_mode === "set" ? "set" : "actual";
  for (const k of ["other_per_m3", "margin_pct", "gst_pct", "round_to", "drum_litres_per_trip", "line_pump_lph", "boom_pump_lph",
    "pour_hours_per_60", "default_load_m3", "tm_kmpl"]) c[k] = Math.max(0, num(b[k], COSTING_DEFAULT[k]));
  c.genset_lpm3 = num(b.genset_lpm3, null);
  c.loader_lpm3 = num(b.loader_lpm3, null);
  if (c.fuel_mode === "set" && !(c.fuel_set >= 0)) throw Object.assign(new Error("Enter the fuel ₹ per m³ to use."), { expose: true });
  if (c.salary_mode === "set" && !(c.salary_set >= 0)) throw Object.assign(new Error("Enter the salary ₹ per m³ to use."), { expose: true });
  if (!(c.round_to >= 1)) c.round_to = 1;
  if (!(c.default_load_m3 > 0)) c.default_load_m3 = 6;
  if (!(c.tm_kmpl > 0)) c.tm_kmpl = 3;
  return c;
}

export async function getCosting() {
  const { rows } = await query(`SELECT costing FROM quotation_settings WHERE id = 1`).catch(() => ({ rows: [] }));
  return { ...COSTING_DEFAULT, ...(rows[0]?.costing || {}) };
}

const istYm = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
// [from, toExclusive) of the last `months` full calendar months.
function lastFullMonths(months) {
  const [y, m] = istYm().split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1 - months, 1));
  const from = start.toISOString().slice(0, 10); // ist-ok: pure UTC month arithmetic on a date-only value
  const toExclusive = `${istYm()}-01`;
  const label = months === 1 ? new Date(Date.UTC(y, m - 2, 15)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
    : `${months} months to ${new Date(Date.UTC(y, m - 2, 15)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })}`;
  return { from, toExclusive, label };
}

// Rate per kg per mix component (cement, fly_ash, fine_agg, coarse_20mm,
// coarse_12_5mm, admixture).
async function componentRates() {
  const { rows } = await query(
    `SELECT m.mix_component AS comp, to_char(r.received_date, 'YYYY-MM') AS ym,
            SUM(r.accepted_qty_kg * r.landed_rate_per_kg) AS v, SUM(r.accepted_qty_kg) AS q
       FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id JOIN rm_materials m ON m.id = o.material_id
      WHERE m.mix_component IS NOT NULL AND r.landed_rate_per_kg IS NOT NULL AND r.accepted_qty_kg > 0
      GROUP BY 1, 2 ORDER BY 2 DESC`
  ).catch(() => ({ rows: [] }));
  const out = {};
  for (const r of rows) if (!out[r.comp] && Number(r.q) > 0) out[r.comp] = { rate: Number(r.v) / Number(r.q), month: r.ym };
  const { rows: open } = await query(
    `SELECT mix_component AS comp, AVG(opening_stock_rate_per_kg) AS rate FROM rm_materials
      WHERE mix_component IS NOT NULL AND opening_stock_rate_per_kg > 0 GROUP BY 1`
  ).catch(() => ({ rows: [] }));
  for (const o of open) if (!out[o.comp]) out[o.comp] = { rate: Number(o.rate), month: null };
  return out;
}

export async function dieselRate() {
  const { rows } = await query(`SELECT rate_per_liter FROM fuel_rate_history ORDER BY effective_from DESC, id DESC LIMIT 1`).catch(() => ({ rows: [] }));
  if (rows[0]) return Number(rows[0].rate_per_liter);
  const { rows: it } = await query(`SELECT rate_per_liter FROM store_stock_items WHERE item_type = 'fuel' LIMIT 1`).catch(() => ({ rows: [] }));
  return it[0] ? Number(it[0].rate_per_liter) || null : null;
}

// Litres and ₹ of fuel issued in [from, to), by kind of machine.
async function fuelUsed(from, toExclusive, rate) {
  const { rows } = await query(
    `SELECT CASE WHEN sr.truck_id IS NOT NULL THEN 'truck' WHEN sr.pump_id IS NOT NULL THEN 'pump'
                 ELSE COALESCE(e.equipment_type::text, 'other') END AS kind,
            SUM(sr.actual_quantity_issued) AS litres,
            SUM(COALESCE(sr.fuel_cost, sr.actual_quantity_issued * $3)) AS value
       FROM supply_requests sr LEFT JOIN equipment e ON e.id = sr.equipment_id
      WHERE sr.request_type = 'fuel' AND COALESCE(sr.fuel_kind, 'diesel') = 'diesel' AND sr.status = 'issued' AND sr.actual_quantity_issued > 0
        AND (sr.issued_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date AND (sr.issued_at AT TIME ZONE 'Asia/Kolkata')::date < $2::date
      GROUP BY 1`,
    [from, toExclusive, rate || 0]
  ).catch(() => ({ rows: [] }));
  const by = {};
  for (const r of rows) by[r.kind] = { litres: Number(r.litres) || 0, value: Number(r.value) || 0 };
  return by;
}

// Fleet km per litre from transit-mixer fills in the last 90 days.
async function fleetKmpl() {
  const { rows } = await query(
    `SELECT truck_id, odometer_reading AS km, actual_quantity_issued AS l
       FROM supply_requests
      WHERE request_type = 'fuel' AND COALESCE(fuel_kind, 'diesel') = 'diesel' AND status = 'issued' AND truck_id IS NOT NULL AND odometer_reading IS NOT NULL
        AND actual_quantity_issued > 0 AND issued_at > now() - interval '90 days'
      ORDER BY truck_id, odometer_reading`
  ).catch(() => ({ rows: [] }));
  const by = new Map();
  for (const r of rows) { if (!by.has(r.truck_id)) by.set(r.truck_id, []); by.get(r.truck_id).push(r); }
  let km = 0, litres = 0;
  for (const list of by.values()) {
    if (list.length < 2) continue;
    const d = Number(list[list.length - 1].km) - Number(list[0].km);
    if (!(d > 0)) continue;
    km += d;
    litres += list.slice(1).reduce((t, x) => t + Number(x.l), 0);
  }
  return km > 0 && litres > 0 ? Math.round((km / litres) * 100) / 100 : null;
}

// Everything that does not depend on the mix: read once per request.
export async function costContext() {
  const costing = await getCosting();
  const rate = await dieselRate();
  const fuelWin = lastFullMonths(costing.fuel_months);
  const lastMonth = lastFullMonths(1);
  const [rates, fuel, prodFuel, fuelLast, prodLast, kmpl, pay] = await Promise.all([
    componentRates(),
    fuelUsed(fuelWin.from, fuelWin.toExclusive, rate),
    productionM3Range({ from: fuelWin.from, toExclusive: fuelWin.toExclusive }).catch(() => ({ total_m3: 0 })),
    fuelUsed(lastMonth.from, lastMonth.toExclusive, rate),
    productionM3Range({ from: lastMonth.from, toExclusive: lastMonth.toExclusive }).catch(() => ({ total_m3: 0 })),
    fleetKmpl(),
    query(`SELECT r.month, SUM(l.cost_to_company) AS ctc FROM hr_payroll_runs r JOIN hr_payroll_lines l ON l.month = r.month
            WHERE r.status = 'locked' GROUP BY r.month ORDER BY r.month DESC LIMIT 1`).catch(() => ({ rows: [] })),
  ]);
  const m3 = Number(prodFuel.total_m3) || 0;
  const fuelValue = Object.values(fuel).reduce((t, x) => t + x.value, 0);
  const lastM3 = Number(prodLast.total_m3) || 0;
  let salary = null;
  if (pay.rows[0]) {
    const pm = pay.rows[0].month;
    const p = await productionM3Range({ from: `${pm}-01`, toExclusive: firstOfNextMonth(`${pm}-01`) }).catch(() => ({ total_m3: 0 }));
    const pm3 = Number(p.total_m3) || 0;
    salary = { month: pm, ctc: r2(pay.rows[0].ctc), m3: pm3, per_m3: pm3 > 0 ? r2(Number(pay.rows[0].ctc) / pm3) : null };
  }
  const perM3 = (kind) => (lastM3 > 0 && fuelLast[kind] ? fuelLast[kind].litres / lastM3 : null);
  return {
    costing, diesel_rate: rate,
    rates,
    fuel_average: { label: fuelWin.label, value: r2(fuelValue), m3, per_m3: m3 > 0 ? r2(fuelValue / m3) : null },
    plant_fuel: {
      label: lastMonth.label,
      genset_lpm3: costing.plant_fuel_mode === "set" ? costing.genset_lpm3 : perM3("generator"),
      loader_lpm3: costing.plant_fuel_mode === "set" ? costing.loader_lpm3 : perM3("loader"),
    },
    fleet_kmpl: kmpl,
    salary,
  };
}

// site_fuel: { road_km, load_m3, pump: 'none'|'line_pump'|'boom_pump', tm_kmpl?, diesel_rate?, genset_lpm3?, loader_lpm3? }
export function siteFuel(ctx, sf = {}) {
  const c = ctx.costing;
  const km = num(sf.road_km, null);
  if (!(km >= 0)) return null;
  const rate = num(sf.diesel_rate, ctx.diesel_rate);
  if (!(rate > 0)) return null;
  const load = num(sf.load_m3, c.default_load_m3) || c.default_load_m3;
  const kmpl = num(sf.tm_kmpl, ctx.fleet_kmpl || c.tm_kmpl) || c.tm_kmpl;
  const tripL = (2 * km) / kmpl + c.drum_litres_per_trip;
  const tm = tripL / load;
  const lph = sf.pump === "boom_pump" ? c.boom_pump_lph : sf.pump === "line_pump" ? c.line_pump_lph : 0;
  const pump = (lph * c.pour_hours_per_60) / 60;
  const genset = num(sf.genset_lpm3, ctx.plant_fuel.genset_lpm3) || 0;
  const loader = num(sf.loader_lpm3, ctx.plant_fuel.loader_lpm3) || 0;
  const parts = [
    { key: "tm", label: "Transit mixer", how: `${r2(2 * km)} km round trip ÷ ${kmpl} km/L + ${c.drum_litres_per_trip} L drum & waiting = ${r2(tripL)} L per trip ÷ ${load} m³`, lpm3: tm },
    { key: "pump", label: "Pump", how: lph ? `${lph} L/hour × ${c.pour_hours_per_60} hours ÷ 60 m³ (pumping only)` : "no pump", lpm3: pump },
    { key: "genset", label: "Genset (plant power)", how: `${ctx.costing.plant_fuel_mode === "set" ? "Admin value" : `${ctx.plant_fuel.label} actual`}`, lpm3: genset },
    { key: "loader", label: "Loader", how: `${ctx.costing.plant_fuel_mode === "set" ? "Admin value" : `${ctx.plant_fuel.label} actual`}`, lpm3: loader },
  ].map((p) => ({ ...p, lpm3: Math.round(p.lpm3 * 100) / 100, per_m3: r2(p.lpm3 * rate) }));
  const total = r2(parts.reduce((t, p) => t + p.per_m3, 0));
  return { road_km: km, load_m3: load, pump: sf.pump || "none", tm_kmpl: kmpl, diesel_rate: rate, parts, per_m3: total };
}

const COMP_COLS = [
  ["cement", "cement_kgm3", "Cement"], ["fly_ash", "fly_ash_kgm3", "Fly ash"], ["fine_agg", "fine_agg_kgm3", "Fine aggregate"],
  ["coarse_20mm", "coarse_20mm_kgm3", "20 mm"], ["coarse_12_5mm", "coarse_12_5mm_kgm3", "12.5 mm"],
];

// One mix design → the cost build-up and proposed rate.
export async function costMix(ctx, mixDesignId, { fuel_basis = "average", site_fuel = null } = {}) {
  const { rows } = await query(
    `SELECT md.*, (SELECT SUM(a.qty_kgm3) FROM mix_design_admixtures a WHERE a.mix_design_id = md.id) AS admix_kgm3
       FROM mix_designs md WHERE md.id = $1`, [mixDesignId]);
  const md = rows[0];
  if (!md) return null;
  const c = ctx.costing;
  const lines = [];
  const missing = [];
  for (const [comp, col, label] of [...COMP_COLS, ["admixture", "admix_kgm3", "Admixture"]]) {
    const kg = Number(md[col]) || 0;
    if (!kg) continue;
    const rate = ctx.rates[comp]?.rate;
    if (rate == null) missing.push(label);
    lines.push({ comp, label, kg: r2(kg), rate_per_kg: rate == null ? null : Math.round(rate * 1000) / 1000, amount: rate == null ? null : r2(kg * rate) });
  }
  const material = r2(lines.reduce((t, l) => t + (l.amount || 0), 0));
  let fuel = null;
  if (fuel_basis === "site") {
    const sf = siteFuel(ctx, site_fuel || {});
    fuel = sf ? { basis: "site", per_m3: sf.per_m3, label: `site-specific, ${sf.road_km} km`, site: sf } : null;
  }
  if (!fuel && fuel_basis === "admin") fuel = c.fuel_set != null ? { basis: "admin", per_m3: r2(c.fuel_set), label: "Admin value" } : null;
  if (!fuel) {
    fuel = c.fuel_mode === "set" && c.fuel_set != null
      ? { basis: "admin", per_m3: r2(c.fuel_set), label: "Admin value" }
      : { basis: "average", per_m3: ctx.fuel_average.per_m3 ?? 0, label: `all-site average, ${ctx.fuel_average.label}` };
  }
  const salary = c.salary_mode === "set" && c.salary_set != null
    ? { mode: "set", per_m3: r2(c.salary_set), label: "Admin value" }
    : { mode: "actual", per_m3: ctx.salary?.per_m3 ?? 0, label: ctx.salary ? `${ctx.salary.month} payroll` : "no locked payroll yet" };
  const other = r2(c.other_per_m3);
  const cost = r2(material + fuel.per_m3 + salary.per_m3 + other);
  const withMargin = r2(cost * (1 + c.margin_pct / 100));
  const withGst = r2(withMargin * (1 + c.gst_pct / 100));
  const proposed = Math.round(withGst / c.round_to) * c.round_to;
  return {
    mix_design_id: md.id, design_ref: `${md.design_ref_code} · rev ${md.revision}`,
    material: { lines, total: material, missing }, fuel, salary, other,
    cost, margin_pct: c.margin_pct, with_margin: withMargin, gst_pct: c.gst_pct, with_gst: withGst, round_to: c.round_to, proposed,
  };
}
