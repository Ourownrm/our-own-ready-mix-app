// Round 245 — the cost of water (owner, 27 Oct 2026: "an option to add a cost
// to water consumed. Better to fix a rate for the water available, and if
// water is purchased that also to be considered").
//
// Water used = the batching plant's own weights: Water 1 + Water 2 actual kg
// of every batch kept in the month (1 kg of water = 1 litre). Operator-typed
// manual loads carry no water line, so they are not in it.
//
// The month's water cost:
//   purchased water   the bills of water bought that month (tanker loads), at
//                     what they cost;
//   own water         the rest of the water used (used − litres bought, never
//                     below 0) × the own-water rate per kilolitre (1,000 L) in
//                     force that month — the cost of the plant's own well /
//                     pump / supply, set once and changed from a date.
// Goes into the P&L as a direct cost ("Water") and into break-even as a
// variable cost.
import { query } from "../db.js";
import { ROUND245_WATER_SQL } from "./round245Schema.js";
import { loadKept } from "./plantLoadReview.js";

let ready = null;
export function ensureWater() {
  if (!ready) ready = query(ROUND245_WATER_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
export function monthBoundsW(ym) {
  const [y, m] = ym.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  return { from: `${ym}-01`, toEx: next };
}

export async function waterSettings() {
  await ensureWater();
  const [{ rows: s }, { rows: rates }] = await Promise.all([
    query(`SELECT w.own_rate_kl::float AS own_rate_kl, w.own_note, w.updated_at, u.name AS updated_by
             FROM cost_water_settings w LEFT JOIN users u ON u.id = w.updated_by WHERE w.id = 1`),
    query(`SELECT id, to_char(from_date, 'YYYY-MM-DD') AS from_date, rate_kl::float AS rate_kl, note FROM cost_water_rates ORDER BY from_date`),
  ]);
  return { own_rate_kl: s[0]?.own_rate_kl ?? null, own_note: s[0]?.own_note || null, updated_at: s[0]?.updated_at || null, updated_by: s[0]?.updated_by || null, rates };
}

// The own-water rate in force on a day (the latest change on or before it,
// else the standing rate).
export function rateOnDay(settings, day) {
  let rate = settings.own_rate_kl;
  for (const r of settings.rates) if (r.from_date <= day) rate = r.rate_kl;
  return rate;
}

export async function waterMonth(ym, settings = null) {
  await ensureWater();
  const st = settings || await waterSettings();
  const { from, toEx } = monthBoundsW(ym);
  const [{ rows: used }, { rows: buys }] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(pm.actual_kg), 0)::float AS litres, COUNT(DISTINCT pb.id)::int AS batches
         FROM plant_batch_materials pm JOIN plant_batches pb ON pb.id = pm.batch_id
        WHERE pm.slot IN ('water1', 'water2') AND pm.actual_kg > 0
          AND pb.batch_date >= $1::date AND pb.batch_date < $2::date AND ${loadKept("pb.")}`, [from, toEx]).catch(() => ({ rows: [{ litres: 0, batches: 0 }] })),
    query(
      `SELECT p.id, to_char(p.bought_on, 'YYYY-MM-DD') AS bought_on, p.supplier, p.litres::float AS litres, p.amount::float AS amount,
              p.bill_no, p.note, u.name AS by_name
         FROM cost_water_purchases p LEFT JOIN users u ON u.id = p.created_by
        WHERE p.bought_on >= $1::date AND p.bought_on < $2::date ORDER BY p.bought_on, p.id`, [from, toEx]),
  ]);
  const usedL = r2(used[0].litres);
  const boughtL = r2(buys.reduce((t, b) => t + b.litres, 0));
  const boughtV = r2(buys.reduce((t, b) => t + b.amount, 0));
  const ownL = r2(Math.max(0, usedL - boughtL));
  // The rate in force on the last day of the month (a mid-month change takes
  // the month from then on; good enough for a monthly figure).
  const lastDay = new Date(Date.UTC(Number(toEx.slice(0, 4)), Number(toEx.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10); // ist-ok: calendar arithmetic on UTC midnight
  const rate = rateOnDay(st, lastDay);
  const ownV = rate == null ? 0 : r2((ownL / 1000) * rate);
  return {
    month: ym, used_l: usedL, batches: used[0].batches, bought_l: boughtL, bought_value: boughtV,
    bought_rate_kl: boughtL > 0 ? r2((boughtV / boughtL) * 1000) : null,
    own_l: ownL, own_rate_kl: rate, own_value: ownV, rate_missing: rate == null && ownL > 0,
    value: r2(boughtV + ownV), purchases: buys,
    surplus_l: r2(Math.max(0, boughtL - usedL)),
  };
}
