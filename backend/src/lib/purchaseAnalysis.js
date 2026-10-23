// Round 237 (owner, 23 Oct 2026; mock-up "Purchase Analysis Report"). What was
// bought in a period, by material and supplier, and what it cost to buy from
// the dearer supplier.
//   Qty     — accepted quantity on the receipts (what the bill is paid on).
//   Amount  — landed: accepted qty × order rate + freight, without GST
//             (or material only: without the freight).
//   Avg rate — amount ÷ qty (weighted). Quantities are added in kg and shown in
//             the material's own purchase unit, so a source bought in another
//             unit is still compared fairly.
//   Best rate — the lowest average rate among that material's suppliers in the
//             month. A period over several months is compared month by month.
//   Paid over best — (supplier's rate − best) × qty from them; qty lost = that
//             ÷ the best rate (what the money would have bought).
//   Flagged — dearer AND supplied more than the cheapest supplier that month.
import { query } from "../db.js";
import { computeFreightTotal } from "./supplierLedger.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;

export const ROUND237_SQL = `
CREATE TABLE IF NOT EXISTS rm_purchase_reasons (
  material_id  INTEGER NOT NULL REFERENCES rm_materials(id),
  supplier_id  INTEGER NOT NULL REFERENCES rm_suppliers(id),
  month        CHAR(7) NOT NULL,
  reason       VARCHAR(40) NOT NULL,
  note         VARCHAR(200),
  set_by       INTEGER REFERENCES users(id),
  set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, supplier_id, month)
);
`;
export const REASONS = [
  ["no_stock", "Cheaper supplier had no stock"],
  ["quality", "Quality"],
  ["credit", "Credit terms"],
  ["delivery", "Nearer / faster delivery"],
  ["other", "Other"],
];
let ready = null;
export function ensureRound237() {
  if (!ready) ready = query(ROUND237_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound237(pool, log) {
  await pool.query(ROUND237_SQL);
  log?.push?.("Round 237: Purchase Analysis Report (reasons for buying at a higher rate).");
}

// rows: one per receipt { material_id, material, unit, kg_per_unit, supplier_id, supplier, ym, kg, amount }
export function analyse(rows, reasons = []) {
  const why = new Map(reasons.map((x) => [`${x.material_id}:${x.supplier_id}:${x.month}`, x]));
  const mats = new Map();
  for (const r of rows) {
    if (!(r.kg > 0)) continue;
    if (!mats.has(r.material_id)) mats.set(r.material_id, { id: r.material_id, name: r.material, unit: r.unit, kpu: n0(r.kg_per_unit) || 1, cells: new Map(), sup: new Map() });
    const m = mats.get(r.material_id);
    const ck = `${r.ym}|${r.supplier_id}`;
    const c = m.cells.get(ck) || { ym: r.ym, supplier_id: r.supplier_id, kg: 0, amount: 0 };
    c.kg += r.kg; c.amount += r.amount; m.cells.set(ck, c);
    const s = m.sup.get(r.supplier_id) || { id: r.supplier_id, name: r.supplier, loads: 0, kg: 0, amount: 0, extra: 0, kg_lost: 0, flagged: false, flag_extra: 0, months: [] };
    s.loads += 1; s.kg += r.kg; s.amount += r.amount; m.sup.set(r.supplier_id, s);
  }
  const out = [];
  for (const m of mats.values()) {
    // Month by month: best rate (per kg) among that month's suppliers.
    const byMonth = new Map();
    for (const c of m.cells.values()) { if (!byMonth.has(c.ym)) byMonth.set(c.ym, []); byMonth.get(c.ym).push(c); }
    for (const [ym, cells] of byMonth) {
      if (cells.length < 2) continue;
      const rate = (c) => c.amount / c.kg;
      const best = cells.reduce((a, b) => (rate(b) < rate(a) ? b : a));
      const bestRate = rate(best);
      for (const c of cells) {
        const s = m.sup.get(c.supplier_id);
        const extra = (rate(c) - bestRate) * c.kg;
        if (extra <= 0.005) continue;
        s.extra += extra;
        s.kg_lost += bestRate > 0 ? extra / bestRate : 0;
        if (c.kg > best.kg) {
          s.flagged = true; s.flag_extra += extra;
          const w = why.get(`${m.id}:${c.supplier_id}:${ym}`);
          s.months.push({ ym, extra: r2(extra), reason: w?.reason || null, note: w?.note || null });
        }
      }
    }
    const sups = [...m.sup.values()];
    const kg = sups.reduce((t, s) => t + s.kg, 0);
    const amount = sups.reduce((t, s) => t + s.amount, 0);
    const perUnit = (amt, k) => (k > 0 ? (amt / k) * m.kpu : 0);
    const bestAvg = sups.length > 1 ? Math.min(...sups.map((s) => s.amount / s.kg)) : null;
    const suppliers = sups.map((s) => {
      const reasonSet = new Set(s.months.map((x) => x.reason).filter(Boolean));
      return {
        id: s.id, name: s.name, loads: s.loads, qty: r2(s.kg / m.kpu), amount: r2(s.amount), share: kg > 0 ? r2((s.kg / kg) * 100) : 0,
        rate: r2(perUnit(s.amount, s.kg)), best: bestAvg != null && Math.abs(s.amount / s.kg - bestAvg) < 1e-9,
        over_rate: bestAvg != null ? r2(perUnit(s.amount, s.kg) - bestAvg * m.kpu) : null,
        over_pct: bestAvg != null && bestAvg > 0 ? r2(((s.amount / s.kg - bestAvg) / bestAvg) * 100) : null,
        extra: r2(s.extra), qty_lost: r2(s.kg_lost / m.kpu), flagged: s.flagged, flag_extra: r2(s.flag_extra),
        months: s.months, reason: reasonSet.size === 1 ? [...reasonSet][0] : reasonSet.size > 1 ? "mixed" : null,
        reason_note: s.months.map((x) => x.note).filter(Boolean)[0] || null,
      };
    }).sort((a, b) => b.qty - a.qty);
    out.push({
      id: m.id, name: m.name, unit: m.unit, qty: r2(kg / m.kpu), amount: r2(amount), rate: r2(perUnit(amount, kg)),
      best_rate: bestAvg != null ? r2(bestAvg * m.kpu) : null, compared: sups.length > 1,
      extra: r2(suppliers.reduce((t, s) => t + s.extra, 0)), qty_lost: r2(suppliers.reduce((t, s) => t + s.qty_lost, 0)),
      flag_extra: r2(suppliers.reduce((t, s) => t + s.flag_extra, 0)), suppliers,
    });
  }
  out.sort((a, b) => b.amount - a.amount);
  const sum = (k) => r2(out.reduce((t, m) => t + m[k], 0));
  return {
    materials: out,
    totals: {
      amount: sum("amount"), extra: sum("extra"), flag_extra: sum("flag_extra"),
      materials: out.length, compared: out.filter((m) => m.compared).length,
      suppliers: new Set(out.flatMap((m) => m.suppliers.map((s) => s.id))).size,
      loads: out.reduce((t, m) => t + m.suppliers.reduce((u, s) => u + s.loads, 0), 0),
      flagged: out.reduce((t, m) => t + m.suppliers.filter((s) => s.flagged).length, 0),
    },
  };
}

export async function purchaseAnalysis({ from, to, basis = "landed" }) {
  await ensureRound237();
  const { rows } = await query(
    `SELECT r.id, o.material_id, m.name AS material, m.purchase_unit AS unit, m.kg_per_purchase_unit AS kg_per_unit,
            s.id AS supplier_id, s.name AS supplier, to_char(r.received_date, 'YYYY-MM') AS ym,
            r.accepted_qty, r.accepted_qty_kg, o.rate,
            COALESCE(r.freight_rate, o.freight_rate) AS freight_rate, COALESCE(r.freight_basis, o.freight_basis) AS freight_basis
       FROM rm_receipts_effective r
       JOIN rm_orders o ON o.id = r.order_id
       JOIN rm_materials m ON m.id = o.material_id
       JOIN rm_suppliers s ON s.id = o.supplier_id
      WHERE r.received_date BETWEEN $1::date AND $2::date AND r.accepted_qty_kg > 0`, [from, to]);
  const data = rows.map((r) => {
    const material = n0(r.accepted_qty) * n0(r.rate);
    const freight = basis === "landed" ? computeFreightTotal(r.freight_rate, r.freight_basis, Number(r.accepted_qty), Number(r.accepted_qty_kg)) : 0;
    return { ...r, kg: n0(r.accepted_qty_kg), amount: material + freight };
  });
  const { rows: reasons } = await query(
    `SELECT material_id, supplier_id, month, reason, note FROM rm_purchase_reasons WHERE month BETWEEN $1 AND $2`,
    [from.slice(0, 7), to.slice(0, 7)]);
  return { from, to, basis, reasons: REASONS.map(([key, label]) => ({ key, label })), ...analyse(data, reasons) };
}
