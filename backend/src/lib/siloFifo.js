// ===========================================================================
// Round 214 — first-in-first-out for refillable silos, made complete (owner,
// 16 Oct 2026: "when one silo fills with multiple items like CEM3 with fly ash
// Udupi, JSW, Bellari … the system should take first in first out").
//
// Round 189 built FIFO on the silo's fills (receipts put in a silo + manual
// fills). Three gaps made the brands' stock wrong:
//
//  1. Stock already in a silo before tracking began was never a layer, so it
//     was never drawn first (Thoothukudi's 57 MT opening stayed in the books
//     while later loads went negative).
//  2. A silo drawn past its recorded fills charged the extra to the LATEST
//     load — negative stock on the newest brand.
//  3. A batch that spanned two loads was charged whole to the older one.
//
// From the FIFO start date (plant_fifo_settings, a 1st of month):
//  * the silo starts from its OPENING LAYERS — each material's book stock at
//    the start, placed in the silo it was last filled into (is_opening fills,
//    dated one second before the start). Older layers from before the start
//    are set aside.
//  * a draw past the recorded layers is charged to the NEXT load that goes
//    into the silo (the load was in earlier than recorded), and that load's
//    layer is reduced by the same kg. With no later load it falls back to the
//    last material. Every such draw is listed (plant_silo_overdraws) so Store
//    can see the silo was under-recorded.
//  * a batch spanning two loads stays on the older load's row, and the part
//    from the newer load is moved by an automatic consumption transfer
//    (plant_consumption_transfers.fifo_slot) — rebuilt on every re-run.
// Before the start date nothing changes: Round 189's rule, exactly.
// ===========================================================================
import { pool, query } from "../db.js";
import { CONSUMPTION_CUTOVER, plantConsumptionByMaterialMonth } from "./plantConsumption.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.0005;

// 'YYYY-MM-DD' or null.
export async function fifoStart(q = query) {
  const { rows } = await q(`SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM plant_fifo_settings WHERE id = 1`).catch(() => ({ rows: [] }));
  return rows[0]?.d || null;
}
// The moment opening layers sit at: one second before the start (IST).
export const openingStamp = (start) => `${start} 00:00:00+05:30`;
const startMs = (start) => new Date(`${start}T00:00:00+05:30`).getTime();

// ---------------------------------------------------------------------------
// Book stock of each active material at the START of month ymS — the same
// arithmetic as materialModule's bookStockRows() (approved physical count as
// anchor, else opening_stock_kg; receipts in; consumption out, hand-keyed
// before CONSUMPTION_CUTOVER and the plant's own figure from it), stopped at
// the month before ymS. Consumption after the start never enters, so seeding
// openings and the FIFO re-run cannot feed back into each other.
// ---------------------------------------------------------------------------
export async function bookOpeningAt(ymS, q = query) {
  const cutoverMonth = CONSUMPTION_CUTOVER.slice(0, 7);
  const [materials, recv, rm, plant, anchors] = await Promise.all([
    q(`SELECT id, name, opening_stock_kg FROM rm_materials WHERE is_active`),
    q(`SELECT o.material_id, to_char(r.received_date, 'YYYY-MM') AS ym, SUM(r.accepted_qty_kg)::numeric AS kg
         FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id GROUP BY o.material_id, ym`),
    q(`SELECT c.material_id, to_char(c.consumption_date, 'YYYY-MM') AS ym,
              SUM(COALESCE(c.automatic_qty_kg, c.manual_qty_kg, 0))::numeric AS kg
         FROM rm_daily_consumption c GROUP BY c.material_id, ym`),
    plantConsumptionByMaterialMonth({ from: CONSUMPTION_CUTOVER }),
    q(`SELECT DISTINCT ON (material_id) material_id, physical_stock_kg,
              to_char((date_trunc('month', stock_month) + interval '1 month'), 'YYYY-MM') AS anchor_month
         FROM rm_monthly_physical_stock WHERE approved = true ORDER BY material_id, stock_month DESC`),
  ]);
  const bucket = (rows) => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.material_id)) m.set(r.material_id, new Map()); m.get(r.material_id).set(r.ym, Number(r.kg) || 0); }
    return m;
  };
  const recvM = bucket(recv.rows), rmM = bucket(rm.rows);
  const anchorBy = new Map(anchors.rows.map((a) => [a.material_id, { kg: Number(a.physical_stock_kg) || 0, month: a.anchor_month }]));
  const out = new Map();
  for (const m of materials.rows) {
    const net = (ym) => (recvM.get(m.id)?.get(ym) || 0)
      - (ym < cutoverMonth ? (rmM.get(m.id)?.get(ym) || 0) : (plant.get(m.id)?.get(ym) || 0));
    const months = new Set([...(recvM.get(m.id)?.keys() || []), ...(rmM.get(m.id)?.keys() || []), ...(plant.get(m.id)?.keys() || [])]);
    const a = anchorBy.get(m.id);
    let kg;
    if (!a || a.month <= ymS) {
      kg = a ? a.kg : Number(m.opening_stock_kg) || 0;
      for (const ym of months) if (ym < ymS && (!a || ym >= a.month)) kg += net(ym);
    } else {
      // The count is later than the start: walk back from it.
      kg = a.kg;
      for (const ym of months) if (ym >= ymS && ym < a.month) kg -= net(ym);
    }
    out.set(m.id, { name: m.name, kg: r2(kg) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Opening layers: replaces every is_opening fill with each material's book
// stock at the start, in the refillable silo it was last filled into before
// the start (else the first one it went into after; else the one the plant last
// drew it from before the start). Several materials in one
// silo are layered oldest-filled first. A material never put into a refillable
// silo is not silo stock and gets no layer.
// ---------------------------------------------------------------------------
export async function seedOpeningLayers(userId = null) {
  const start = await fifoStart();
  if (!start) return { start: null, placed: [] };
  const opening = await bookOpeningAt(start.slice(0, 7));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('silo-fifo-seed'))`);
    const { rows: home } = await client.query(
      `SELECT DISTINCT ON (f.material_id) f.material_id, f.slot, f.filled_at, (f.filled_at < $1::timestamptz) AS before
         FROM plant_silo_fills f JOIN plant_silo_aliases a ON a.slot = f.slot AND a.is_refillable
        WHERE NOT f.is_opening
        ORDER BY f.material_id, (f.filled_at < $1::timestamptz) DESC,
                 CASE WHEN f.filled_at < $1::timestamptz THEN -extract(epoch FROM f.filled_at) ELSE extract(epoch FROM f.filled_at) END`,
      [openingStamp(start)]
    );
    const homeBy = new Map(home.map((h) => [h.material_id, h]));
    // A material never recorded as filled, but which the plant drew from a
    // refillable silo (stock that was there before the app tracked fills):
    // its home is the silo it was last drawn from before the start.
    const { rows: drawn } = await client.query(
      `SELECT DISTINCT ON (pm.material_id) pm.material_id, pm.slot, COALESCE(pb.batched_at, pb.batch_date::timestamptz) AS at
         FROM plant_batch_materials pm JOIN plant_batches pb ON pb.id = pm.batch_id
         JOIN plant_silo_aliases a ON a.slot = pm.slot AND a.is_refillable
        WHERE pm.material_id IS NOT NULL AND COALESCE(pb.batched_at, pb.batch_date::timestamptz) < $1::timestamptz
        ORDER BY pm.material_id, COALESCE(pb.batched_at, pb.batch_date::timestamptz) DESC`,
      [openingStamp(start)]
    );
    for (const d of drawn) if (!homeBy.has(d.material_id)) homeBy.set(d.material_id, { slot: d.slot, filled_at: d.at, before: true });
    await client.query(`DELETE FROM plant_silo_fills WHERE is_opening`);
    const bySlot = new Map();
    const placed = [];
    for (const [mid, o] of opening) {
      if (!(o.kg > 0.5)) continue;
      const h = homeBy.get(mid);
      if (!h) continue;                         // not a silo material
      if (!bySlot.has(h.slot)) bySlot.set(h.slot, []);
      bySlot.get(h.slot).push({ mid, name: o.name, kg: o.kg, before: h.before, at: new Date(h.filled_at).getTime() });
    }
    for (const [slot, list] of bySlot) {
      list.sort((x, y) => (x.before === y.before ? x.at - y.at : x.before ? -1 : 1));
      let first = true;
      for (const l of list) {
        await client.query(
          `INSERT INTO plant_silo_fills (slot, material_id, filled_at, qty_kg, was_empty, balance_before_kg, notes, recorded_by, is_opening)
           VALUES ($1, $2, $3::timestamptz - interval '1 second', $4, $5, NULL, $6, $7, true)`,
          [slot, l.mid, openingStamp(start), l.kg, first, `Opening stock (book) at ${start}`, userId]
        );
        first = false;
        placed.push({ slot, material_id: l.mid, name: l.name, kg: l.kg });
      }
    }
    await client.query(`UPDATE plant_fifo_settings SET seeded_at = now() WHERE id = 1`);
    await client.query("COMMIT");
    return { start, placed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// FIFO for ONE refillable silo. Walks fills and load-cell draws in time order.
// Writes: plant_batch_materials.material_id (the older load of each draw),
// automatic transfers for draws spanning loads, and the over-draw list.
// Returns how many batch rows changed material.
// ---------------------------------------------------------------------------
export async function fifoResolveSlot(slot) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('silo-fifo:' || $1))`, [slot]);
    const start = await fifoStart((sql, p) => client.query(sql, p));
    const sMs = start ? startMs(start) - 1000 : Infinity;   // opening layers sit at start − 1 s
    const { rows: fills } = await client.query(
      `SELECT material_id, qty_kg, filled_at, COALESCE(was_empty, false) AS was_empty, is_opening
         FROM plant_silo_fills WHERE slot = $1 ORDER BY filled_at, is_opening DESC, id`,
      [slot]
    );
    const { rows: draws } = await client.query(
      `SELECT pm.id, pm.actual_kg, pm.material_id, to_char(pb.batch_date, 'YYYY-MM-DD') AS day,
              COALESCE(pb.batched_at, pb.batch_date::timestamptz) AS at
         FROM plant_batch_materials pm
         JOIN plant_batches pb ON pb.id = pm.batch_id
        WHERE pm.slot = $1
        ORDER BY COALESCE(pb.batched_at, pb.batch_date::timestamptz), pm.id`,
      [slot]
    );
    const layers = [];          // { mid, left }
    const debt = new Map();     // fill index → kg already drawn ahead of it
    let fi = 0, lastMid = null, reset = false;
    const ms = (t) => new Date(t).getTime();
    const addFill = () => {
      const f = fills[fi];
      if (f.was_empty) layers.length = 0;
      let left = (Number(f.qty_kg) || 0) - (debt.get(fi) || 0);
      if (left < 0) {           // drawn ahead by more than this load: the rest is owed by the next
        if (fi + 1 < fills.length) debt.set(fi + 1, (debt.get(fi + 1) || 0) - left);
        left = 0;
      }
      layers.push({ mid: f.material_id, left });
      lastMid = f.material_id;
      fi++;
    };
    const advanceTo = (at) => {
      while (fi < fills.length && ms(fills[fi].filled_at) <= at) {
        if (!reset && ms(fills[fi].filled_at) >= sMs) { layers.length = 0; reset = true; }
        addFill();
      }
      if (!reset && sMs !== Infinity && at >= sMs) { layers.length = 0; reset = true; }
    };

    const ids = [], mids = [];
    const transfers = new Map();   // `${day}|${from}|${to}` → kg
    const overdraws = new Map();   // `${day}|${mid}|${kind}` → kg
    for (const d of draws) {
      const at = ms(d.at);
      advanceTo(at);
      while (layers.length && layers[0].left <= EPS) layers.shift();
      let want;
      if (at < sMs) {
        // Before the FIFO start — Round 189's rule, unchanged.
        want = layers.length ? layers[0].mid : lastMid;
        let kg = Number(d.actual_kg) || 0;
        while (kg > 0 && layers.length) {
          const take = Math.min(kg, layers[0].left);
          layers[0].left -= take; kg -= take;
          if (layers[0].left <= EPS) layers.shift();
        }
      } else {
        let kg = Number(d.actual_kg) || 0;
        const parts = [];
        while (kg > EPS && layers.length) {
          const take = Math.min(kg, layers[0].left);
          parts.push({ mid: layers[0].mid, kg: take });
          layers[0].left -= take; kg -= take;
          if (layers[0].left <= EPS) layers.shift();
        }
        if (kg > EPS && fills.length) {
          // Drawn past every recorded load: it came from the next load in.
          let mid, kind;
          if (fi < fills.length) { mid = fills[fi].material_id; kind = "next_load"; debt.set(fi, (debt.get(fi) || 0) + kg); }
          else { mid = lastMid; kind = "no_later_load"; }
          if (mid != null) {
            parts.push({ mid, kg });
            const k = `${d.day}|${mid}|${kind}`;
            overdraws.set(k, (overdraws.get(k) || 0) + kg);
          }
        }
        want = parts.length ? parts[0].mid : (layers.length ? layers[0].mid : (fi < fills.length ? fills[fi].material_id : lastMid));
        for (const p of parts.slice(1)) {
          if (want == null || p.mid == null || p.mid === want) continue;
          const k = `${d.day}|${want}|${p.mid}`;
          transfers.set(k, (transfers.get(k) || 0) + p.kg);
        }
      }
      if ((d.material_id ?? null) !== (want ?? null)) { ids.push(d.id); mids.push(want); }
    }

    // What is left in the silo now, load by load (every fill counted).
    advanceTo(Infinity);
    const left = new Map();
    for (const l of layers) if (l.left > EPS) left.set(l.mid, (left.get(l.mid) || 0) + l.left);
    await client.query(`DELETE FROM plant_silo_contents WHERE slot = $1`, [slot]);
    for (const [mid, kg] of left) {
      await client.query(`INSERT INTO plant_silo_contents (slot, material_id, qty_kg) VALUES ($1, $2, $3)`, [slot, mid, r2(kg)]);
    }

    let changed = 0;
    if (ids.length) {
      const { rowCount } = await client.query(
        `UPDATE plant_batch_materials pm SET material_id = u.mid
           FROM unnest($1::int[], $2::int[]) AS u(id, mid) WHERE pm.id = u.id`,
        [ids, mids]
      );
      changed = rowCount;
    }
    await client.query(`DELETE FROM plant_consumption_transfers WHERE fifo_slot = $1`, [slot]);
    const tr = [...transfers].map(([k, kg]) => [...k.split("|"), r2(kg)]).filter((t) => t[3] >= 0.01);
    if (tr.length) {
      await client.query(
        `INSERT INTO plant_consumption_transfers (transfer_date, from_material_id, to_material_id, qty_kg, reason, created_by, fifo_slot)
         SELECT u.d::date, u.f, u.t, u.kg, $5, NULL, $6
           FROM unnest($1::text[], $2::int[], $3::int[], $4::numeric[]) AS u(d, f, t, kg)`,
        [tr.map((t) => t[0]), tr.map((t) => Number(t[1])), tr.map((t) => Number(t[2])), tr.map((t) => t[3]),
          `FIFO: batches drawing from two loads in silo ${slot}`, slot]
      );
    }
    await client.query(`DELETE FROM plant_silo_overdraws WHERE slot = $1`, [slot]);
    const od = [...overdraws].map(([k, kg]) => [...k.split("|"), r2(kg)]).filter((o) => o[3] >= 0.01);
    if (od.length) {
      await client.query(
        `INSERT INTO plant_silo_overdraws (slot, on_date, material_id, kind, qty_kg)
         SELECT $5, u.d::date, u.m, u.k, u.kg FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[]) AS u(d, m, k, kg)`,
        [od.map((o) => o[0]), od.map((o) => Number(o[1])), od.map((o) => o[2]), od.map((o) => o[3]), slot]
      );
    }
    await client.query("COMMIT");
    return changed;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Silo levels (filled − drawn). A refillable silo counts from the FIFO start
// (its opening layers) once one is set; any other silo from its first fill.
export const SILO_LEVELS_SQL = `
  WITH st AS (SELECT (start_date::timestamptz - interval '1 second') AS t FROM plant_fifo_settings WHERE id = 1),
  ff AS (
    SELECT f.* FROM plant_silo_fills f LEFT JOIN plant_silo_aliases a ON a.slot = f.slot
     WHERE NOT (COALESCE(a.is_refillable, false) AND EXISTS (SELECT 1 FROM st) AND f.filled_at < (SELECT t FROM st))
  )
  SELECT ff.slot,
         (array_agg(ff.material_id ORDER BY ff.filled_at DESC, ff.id DESC))[1] AS current_material_id,
         (array_agg(m.name ORDER BY ff.filled_at DESC, ff.id DESC))[1] AS current_material,
         max(ff.filled_at) AS last_filled_at,
         to_char(min(ff.filled_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS first_fill,
         sum(ff.qty_kg)::numeric AS filled_kg,
         COALESCE((SELECT sum(pm.actual_kg) FROM plant_batch_materials pm
                    JOIN plant_batches pb ON pb.id = pm.batch_id
                   WHERE pm.slot = ff.slot
                     AND COALESCE(pb.batched_at, pb.batch_date::timestamptz) >= min(ff.filled_at)), 0)::numeric AS used_kg
    FROM ff LEFT JOIN rm_materials m ON m.id = ff.material_id
   GROUP BY ff.slot`;
