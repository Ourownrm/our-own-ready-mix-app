// ===========================================================================
// Round 177 — unified plant consumption, per material.
//
// There used to be TWO truths about how much of a material was consumed: the
// material module's hand-keyed `rm_daily_consumption`, and the plant's real
// per-batch load-cell weights (plant_batch_materials) plus the operator's
// manual plant entries (plant_manual_entries). The hand-keyed one drove book
// stock; the real one did not. This helper is the single source: the plant's
// ACTUAL consumption per material — load-cell auto PLUS operator manual, never
// the auto figure alone (the standing build rule for the plant feed).
//
// CONSUMPTION_CUTOVER is the IST calendar date from which material stock is
// driven by this plant-actual figure. Before it, stock keeps using whatever was
// already entered in rm_daily_consumption, so historical months never shift.
// It falls on a month boundary, so no single month is ever split across the two
// sources. (User decision, Round 176: the agent began sending real batch data
// around this date.)
// ===========================================================================
import { query } from "../db.js";

export const CONSUMPTION_CUTOVER = "2026-09-01";

// Per-material plant consumption over [from, toExclusive) (either bound may be
// null for open-ended). Returns Map(material_id -> { auto_kg, manual_kg,
// total_kg }). Only materials with some consumption appear. Dates are IST
// calendar dates, matching plant_batches.batch_date / plant_manual_entries.entry_date.
export async function plantConsumptionByMaterial({ from = null, toExclusive = null } = {}) {
  const autoWh = ["pm.material_id IS NOT NULL"];
  const autoP = [];
  if (from)        { autoP.push(from);        autoWh.push(`pb.batch_date >= $${autoP.length}::date`); }
  if (toExclusive) { autoP.push(toExclusive); autoWh.push(`pb.batch_date <  $${autoP.length}::date`); }

  const manWh = ["e.material_id IS NOT NULL"];
  const manP = [];
  if (from)        { manP.push(from);        manWh.push(`e.entry_date >= $${manP.length}::date`); }
  if (toExclusive) { manP.push(toExclusive); manWh.push(`e.entry_date <  $${manP.length}::date`); }

  const [auto, manual] = await Promise.all([
    query(
      `SELECT pm.material_id, sum(pm.actual_kg)::numeric AS kg
         FROM plant_batch_materials pm
         JOIN plant_batches pb ON pb.id = pm.batch_id
        WHERE ${autoWh.join(" AND ")}
        GROUP BY pm.material_id`, autoP),
    query(
      `SELECT e.material_id, sum(e.qty_kg)::numeric AS kg
         FROM plant_manual_entries e
        WHERE ${manWh.join(" AND ")}
        GROUP BY e.material_id`, manP),
  ]);

  const out = new Map();
  for (const r of auto.rows) out.set(r.material_id, { auto_kg: Number(r.kg) || 0, manual_kg: 0 });
  for (const r of manual.rows) {
    const cur = out.get(r.material_id) || { auto_kg: 0, manual_kg: 0 };
    cur.manual_kg += Number(r.kg) || 0;
    out.set(r.material_id, cur);
  }
  for (const v of out.values()) v.total_kg = Math.round((v.auto_kg + v.manual_kg) * 1000) / 1000;
  return out;
}

// Round 185 (#1) — plant consumption per material, bucketed BY MONTH, from a
// start date. Returns Map(material_id -> Map('YYYY-MM' -> kg)). Used by the
// book-stock calc to sum only the months on/after a material's approved physical
// anchor without needing a per-material date in the query.
export async function plantConsumptionByMaterialMonth({ from = null } = {}) {
  const p = [];
  let where = "pm.material_id IS NOT NULL";
  let whereE = "e.material_id IS NOT NULL";
  if (from) { p.push(from); where += ` AND pb.batch_date >= $1::date`; whereE += ` AND e.entry_date >= $1::date`; }
  const { rows } = await query(
    `SELECT material_id, ym, sum(kg)::numeric AS kg FROM (
        SELECT pm.material_id, to_char(pb.batch_date, 'YYYY-MM') AS ym, pm.actual_kg AS kg
          FROM plant_batch_materials pm JOIN plant_batches pb ON pb.id = pm.batch_id
         WHERE ${where}
        UNION ALL
        SELECT e.material_id, to_char(e.entry_date, 'YYYY-MM') AS ym, e.qty_kg AS kg
          FROM plant_manual_entries e
         WHERE ${whereE}
     ) t GROUP BY material_id, ym`, p);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.material_id)) out.set(r.material_id, new Map());
    out.get(r.material_id).set(r.ym, Number(r.kg) || 0);
  }
  return out;
}

// Plant production (m³) over [from, toExclusive): batched m³ (plant_batches)
// plus manual production entries (plant_manual_entries, material_id IS NULL).
export async function plantProductionM3({ from = null, toExclusive = null } = {}) {
  const bWh = [], bP = [];
  if (from)        { bP.push(from);        bWh.push(`pb.batch_date >= $${bP.length}::date`); }
  if (toExclusive) { bP.push(toExclusive); bWh.push(`pb.batch_date <  $${bP.length}::date`); }
  const eWh = ["e.material_id IS NULL"], eP = [];
  if (from)        { eP.push(from);        eWh.push(`e.entry_date >= $${eP.length}::date`); }
  if (toExclusive) { eP.push(toExclusive); eWh.push(`e.entry_date <  $${eP.length}::date`); }
  const [b, e] = await Promise.all([
    query(`SELECT COALESCE(sum(batch_qty_m3),0)::numeric AS m3 FROM plant_batches pb${bWh.length ? " WHERE " + bWh.join(" AND ") : ""}`, bP),
    query(`SELECT COALESCE(sum(e.qty_m3),0)::numeric AS m3 FROM plant_manual_entries e WHERE ${eWh.join(" AND ")}`, eP),
  ]);
  const auto = Number(b.rows[0].m3) || 0;
  const manual = Number(e.rows[0].m3) || 0;
  return { auto_m3: auto, manual_m3: manual, total_m3: Math.round((auto + manual) * 1000) / 1000 };
}

// First day of the next calendar month after a 'YYYY-MM-01' (or any 'YYYY-MM-..')
// date string. Month arithmetic only — no timezone involved.
export function firstOfNextMonth(ymd) {
  const [y, m] = ymd.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m (1-based) as 0-based next month
  return d.toISOString().slice(0, 10); // ist-ok: pure UTC month arithmetic on a date-only string, read back as UTC date — no clock/tz involved
}

// The day after a 'YYYY-MM-DD' date string. Date arithmetic only (uses UTC for
// the calendar math; the strings are IST calendar dates and never carry a time).
export function nextDay(ymd) {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); // ist-ok: pure UTC day arithmetic on a date-only string, read back as UTC date — no clock/tz involved
}

// ===========================================================================
// Round 188 (v10.17 #4) — production and consumption for a DATE RANGE, split at
// the cutover, for the material module's reports. Before CONSUMPTION_CUTOVER
// the hand-keyed figures (rm_daily_production / rm_daily_consumption) are the
// record; from it, the plant's actual (load cells + operator manual entries).
// The material module used rm_daily_production for every month, so September
// showed only what somebody had typed into that old form, not what the plant
// made. Ranges are [from, toExclusive) of IST calendar dates ('YYYY-MM-DD').
// ===========================================================================
export async function productionM3Range({ from, toExclusive }) {
  const cut = CONSUMPTION_CUTOVER;
  let handKeyed = 0;
  let plant = { auto_m3: 0, manual_m3: 0 };
  if (from < cut) {
    const end = toExclusive < cut ? toExclusive : cut;
    const { rows } = await query(
      `SELECT COALESCE(sum(concrete_produced_m3), 0)::numeric AS m3 FROM rm_daily_production
        WHERE production_date >= $1::date AND production_date < $2::date`, [from, end]);
    handKeyed = Number(rows[0].m3) || 0;
  }
  if (toExclusive > cut) {
    plant = await plantProductionM3({ from: from > cut ? from : cut, toExclusive });
  }
  const total = handKeyed + plant.auto_m3 + plant.manual_m3;
  return {
    hand_keyed_m3: Math.round(handKeyed * 1000) / 1000,
    auto_m3: Math.round(plant.auto_m3 * 1000) / 1000,
    manual_m3: Math.round(plant.manual_m3 * 1000) / 1000,
    total_m3: Math.round(total * 1000) / 1000,
  };
}

// Per material per month over [from, toExclusive): [{ material_id, ym, kg }].
export async function consumptionByMaterialMonthRange({ from, toExclusive }) {
  const cut = CONSUMPTION_CUTOVER;
  const out = [];
  if (from < cut) {
    const end = toExclusive < cut ? toExclusive : cut;
    const { rows } = await query(
      `SELECT material_id, to_char(consumption_date, 'YYYY-MM') AS ym,
              sum(COALESCE(automatic_qty_kg, manual_qty_kg, 0))::numeric AS kg
         FROM rm_daily_consumption
        WHERE consumption_date >= $1::date AND consumption_date < $2::date
        GROUP BY material_id, 2`, [from, end]);
    for (const r of rows) out.push({ material_id: r.material_id, ym: r.ym, kg: Number(r.kg) || 0 });
  }
  if (toExclusive > cut) {
    const pf = from > cut ? from : cut;
    const { rows } = await query(
      `SELECT material_id, ym, sum(kg)::numeric AS kg FROM (
          SELECT pm.material_id, to_char(pb.batch_date, 'YYYY-MM') AS ym, pm.actual_kg AS kg
            FROM plant_batch_materials pm JOIN plant_batches pb ON pb.id = pm.batch_id
           WHERE pm.material_id IS NOT NULL AND pb.batch_date >= $1::date AND pb.batch_date < $2::date
          UNION ALL
          SELECT e.material_id, to_char(e.entry_date, 'YYYY-MM') AS ym, e.qty_kg AS kg
            FROM plant_manual_entries e
           WHERE e.material_id IS NOT NULL AND e.entry_date >= $1::date AND e.entry_date < $2::date
       ) t GROUP BY material_id, ym`, [pf, toExclusive]);
    for (const r of rows) out.push({ material_id: r.material_id, ym: r.ym, kg: Number(r.kg) || 0 });
  }
  return out;
}
