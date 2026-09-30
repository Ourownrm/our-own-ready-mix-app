// Round 157 — the MCI370 batching plant feed.
//
// Same two-audience shape as routes/weighbridge.js, and deliberately so: the
// plant now has two machines that produce data (the weighbridge and the
// batching panel) and one pattern for getting it in.
//
//   POST /plant/sync   — the agent on the plant control PC. NOT a user session;
//                        API key, declared ABOVE router.use(requireAuth) so it
//                        never sees the session middleware. Moving it below
//                        that line would start demanding a session and the
//                        agent would fail silently at 2am.
//
//   everything else    — people in the app, both guards as usual.
//
// DIRECTION. One-way, permanently. MCI370 is Schwing Stetter's closed control
// software writing to a plain Access file; there is no supported write
// contract, and Jet file locking against software that is currently batching
// concrete is not a risk worth taking. The agent opens it read-only.
//
// WHAT A "BATCH" IS HERE. One MIX, not one load. MCI370's Batch_Transaction
// carries a Batch_Index and writes one row per mix, so a 6 m³ truck filled by
// a 1 m³ mixer is six rows sharing a Batch_No. The natural key is therefore
// (plant_no, batch_year, batch_no, batch_index), and everything user-facing
// sums across the index. Getting this wrong would silently discard five
// sixths of the plant's consumption.
import { Router } from "express";
import crypto from "crypto";
import { pool, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { PLANT_SLOTS, SLOT_BY_KEY, normaliseSlot, isPlaceholderName } from "../lib/plantSlots.js";
import { istDay } from "../lib/istDate.js";

const router = Router();

const MAX_BATCH = 500;

// The fields that make up a mix's identity for change detection. Material rows
// are folded in separately (see hashMix) because a corrected weight on one
// hopper has to register as a change.
const HASH_FIELDS = [
  "plant_no", "batch_year", "batch_no", "batch_index", "batched_at",
  "recipe_code", "recipe_name", "strength", "consistency",
  "customer_code", "site_name", "truck_no", "truck_driver", "order_no", "batcher_name",
  "batch_qty_m3", "load_qty_m3", "cumulative_qty_m3",
  "ordered_qty_m3", "returned_qty_m3", "with_this_load_m3",
  "mixer_capacity_m3", "mixing_time_s", "load_started_at", "load_ended_at",
  "weighed_net_weight_kg", "weighbridge_stat",
];

function hashMix(row, materials) {
  const head = HASH_FIELDS.map((f) => (row[f] === null || row[f] === undefined ? "" : String(row[f]))).join("\u0001");
  const mats = materials
    .map((m) => [m.slot, m.slot_name, m.actual_kg, m.target_kg, m.moisture_pct, m.correction].join("\u0002"))
    .sort()
    .join("\u0003");
  return crypto.createHash("sha256").update(head + "\u0004" + mats).digest("hex");
}

// ============================================================================
// THE AGENT ENDPOINT — API key, no session. Must stay above requireAuth.
// ============================================================================

function agentAuthorised(req) {
  const expected = process.env.PLANT_API_KEY;
  // An unset key closes the endpoint rather than opening it, same as the
  // weighbridge. Refusing to boot without one would take the whole backend
  // down over an integration that is not in use yet.
  if (!expected) return false;
  const given = req.get("x-plant-key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const NUM = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const INT = (v) => {
  const n = NUM(v);
  return n === null ? null : Math.round(n);
};
const TEXT = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s.slice(0, max);
};

// MCI370 stores Batch_Date and Batch_Time as separate Access DateTime values,
// both in plant-local time. The agent combines them and sends one ISO instant
// with an explicit +05:30; anything before the plant existed is a sentinel.
const EARLIEST = Date.parse("2010-01-01T00:00:00Z");
const TS = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < EARLIEST) return null;
  return new Date(t).toISOString();
};

function cleanMix(raw) {
  const batch_no = INT(raw.batch_no);
  const batch_year = INT(raw.batch_year);
  if (!Number.isInteger(batch_no) || !Number.isInteger(batch_year)) return null;

  const row = {
    plant_no:    TEXT(raw.plant_no, 50) || "1",
    batch_year,
    batch_no,
    batch_index: Number.isInteger(INT(raw.batch_index)) ? INT(raw.batch_index) : 1,
    batched_at:  TS(raw.batched_at),
    recipe_code:   TEXT(raw.recipe_code, 50),
    recipe_name:   TEXT(raw.recipe_name, 100),
    strength:      INT(raw.strength),
    consistency:   INT(raw.consistency),
    customer_code: TEXT(raw.customer_code, 100),
    site_name:     TEXT(raw.site_name, 175),
    truck_no:      TEXT(raw.truck_no, 50),
    truck_driver:  TEXT(raw.truck_driver, 50),
    order_no:      TEXT(raw.order_no, 50),
    batcher_name:  TEXT(raw.batcher_name, 100),
    // ROUND 159 — three quantities, and only one of them may be summed.
    // batch_qty_m3 is this batch alone; load_qty_m3 is the whole load and is
    // the SAME on every batch of it; cumulative_qty_m3 is MCI370's running
    // total, kept for audit and never computed with. See schema.sql.
    batch_qty_m3:      NUM(raw.batch_qty_m3),
    load_qty_m3:       NUM(raw.load_qty_m3),
    cumulative_qty_m3: NUM(raw.cumulative_qty_m3),
    ordered_qty_m3:    NUM(raw.ordered_qty_m3),
    returned_qty_m3:   NUM(raw.returned_qty_m3),
    with_this_load_m3: NUM(raw.with_this_load_m3),
    mixer_capacity_m3: NUM(raw.mixer_capacity_m3),
    mixing_time_s:     NUM(raw.mixing_time_s),
    load_started_at:   raw.load_started_at || null,
    load_ended_at:     raw.load_ended_at || null,
    weighed_net_weight_kg: NUM(raw.weighed_net_weight_kg),
    weighbridge_stat:      TEXT(raw.weighbridge_stat, 1),
  };

  // batch_date is the IST calendar day, derived here rather than trusted from
  // the agent, and built with istDay rather than a UTC slice. This is the
  // app's recurring bug and the reason lib/istDate.js exists: a mix batched at
  // 02:00 would otherwise file itself under the previous day and vanish from
  // the day's production figure.
  row.batch_date = row.batched_at ? istDay(Date.parse(row.batched_at)) : null;

  // The material rows. Only hoppers that actually weighed something produce a
  // row — see lib/plantSlots.js for why a named-but-idle hopper is skipped and
  // an unnamed-but-active one is not.
  const materials = [];
  for (const slot of PLANT_SLOTS) {
    const m = (raw.materials || {})[slot.key];
    if (!m) continue;
    const actual = NUM(m.actual_kg);
    if (actual === null || actual === 0) continue;
    materials.push({
      slot: slot.key,
      slot_name: TEXT(m.slot_name, 60),
      // Round 159 — the recipe's own per-m³ figure. Came through the agent from
      // the load header and was being dropped here, which is how it reached the
      // database as null on every row despite the agent sending it on 100% of
      // batches. Sanitisers that silently drop unknown keys need every new
      // field adding in two places, not one.
      design_kg_per_m3: NUM(m.design_kg_per_m3),
      actual_kg: actual,
      target_kg: NUM(m.target_kg),
      moisture_pct: slot.kind === "aggregate" ? NUM(m.moisture_pct) : null,
      correction: slot.kind === "aggregate" ? null : NUM(m.correction),
    });
  }
  row.materials = materials;
  return row;
}

/**
 * Silo name -> our material, from plant_silo_aliases plus an exact match
 * against the active materials master.
 *
 * Same two-stage design as the weighbridge, and no fuzzy matching for the same
 * reason: "20MM" and "12MM" are two characters apart, and a wrong automatic
 * match misattributes a month of consumption before anybody notices.
 */
/**
 * ROUND 159 — resolution is keyed on the SLOT, not the hopper's name.
 *
 * Their plant names Gate1 and Gate2 both "M SAND". Keyed on the name, mapping
 * one mapped the other and the two could never be told apart; rename a hopper
 * on the panel and its history silently re-pointed. The slot is the physical
 * thing and never moves.
 *
 * Name matching survives only as a CONVENIENCE for a slot nobody has mapped
 * yet: if the panel calls a hopper exactly what we call a material, that is a
 * good first guess. An explicit mapping always beats it.
 *
 * A refillable silo (CEM1/2/3) resolves to nothing here — its material depends
 * on WHEN, and comes from the fill history instead. See siloMaterialAt().
 */
async function loadSiloResolver() {
  const [aliases, materials] = await Promise.all([
    query(`SELECT slot, material_id, is_ignored, is_refillable FROM plant_silo_aliases`),
    query(`SELECT id, name FROM rm_materials WHERE is_active = true`),
  ]);
  const byName = new Map();
  for (const m of materials.rows) {
    const key = normaliseSlot(m.name);
    if (!key) continue;
    // Two active materials normalising alike is a data error in the master,
    // not something to pick a winner from.
    byName.set(key, byName.has(key) ? { ambiguous: true } : { id: m.id });
  }
  const bySlot = new Map();
  for (const a of aliases.rows) {
    bySlot.set(a.slot, a.is_ignored ? { ignored: true }
                     : a.is_refillable ? { refillable: true }
                     : { id: a.material_id });
  }
  return { bySlot, byName };
}

function resolveSilo(resolver, slot, slotName) {
  // A hopper the plant left named "0", "1" or "-" is not a material and never
  // needs mapping — it resolves to nothing without entering any queue.
  if (isPlaceholderName(slotName)) return null;
  const explicit = resolver.bySlot.get(slot);
  if (explicit) {
    if (explicit.ignored || explicit.refillable) return null;
    return explicit.id ?? null;
  }
  const guess = resolver.byName.get(normaliseSlot(slotName));
  if (!guess || guess.ignored || guess.ambiguous) return null;
  return guess.id;
}

/**
 * ROUND 159 — what a refillable silo held at a given moment.
 *
 * The fill immediately at or before that time wins. A batch from 3 August is
 * costed against whatever was in the silo on 3 August, and a fill on the 10th
 * changes nothing behind it — which is the entire reason the fills are a
 * timeline rather than a single current value.
 */
async function siloMaterialAt(slot, whenIso, q = query) {
  const { rows } = await q(
    `SELECT material_id FROM plant_silo_fills
      WHERE slot = $1 AND filled_at <= $2::timestamptz
      ORDER BY filled_at DESC LIMIT 1`,
    [slot, whenIso]
  );
  return rows.length ? rows[0].material_id : null;
}

const MIX_COLS = [
  "plant_no", "batch_year", "batch_no", "batch_index", "batched_at", "batch_date",
  "recipe_code", "recipe_name", "strength", "consistency",
  "customer_code", "site_name", "truck_no", "truck_driver", "order_no", "batcher_name",
  "batch_qty_m3", "load_qty_m3", "cumulative_qty_m3",
  "ordered_qty_m3", "returned_qty_m3", "with_this_load_m3",
  "mixer_capacity_m3", "mixing_time_s", "load_started_at", "load_ended_at",
  "weighed_net_weight_kg", "weighbridge_stat", "source_hash",
];

router.post("/sync", async (req, res) => {
  if (!agentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });

  const body = req.body || {};
  // ROUND 159 — the user's vocabulary: a LOAD is the truckful, a BATCH is one
  // drop of the mixer into it. "batches" is accepted, "mixes" still works so an
  // agent that has not been updated yet keeps syncing rather than failing.
  const incoming = Array.isArray(body.batches) ? body.batches
                 : Array.isArray(body.mixes)   ? body.mixes : null;
  if (!incoming) return res.status(400).json({ error: "Expected a `batches` array." });
  if (incoming.length > MAX_BATCH) {
    return res.status(413).json({ error: `Send at most ${MAX_BATCH} batches per call.`, max_batch: MAX_BATCH });
  }
  const agentVersion = TEXT(body.agent_version, 20);

  const client = await pool.connect();
  try {
    if (!incoming.length) {
      const { rows: hw } = await query(
        `SELECT max(batch_no) AS highest, max(batch_year) AS yr FROM plant_batches`
      );
      await query(
        `INSERT INTO plant_sync_log (agent_version, rows_sent, highest_batch, batch_year) VALUES ($1, 0, $2, $3)`,
        [agentVersion, hw[0].highest, hw[0].yr]
      );
      return res.json({ ok: true, inserted: 0, updated: 0, unchanged: 0, rejected: 0, highest_batch: hw[0].highest, batch_year: hw[0].yr });
    }

    const resolver = await loadSiloResolver();

    const clean = [];
    let rejected = 0;
    const seen = new Set();
    for (const raw of incoming) {
      const row = cleanMix(raw);
      if (!row) { rejected++; continue; }
      const k = `${row.plant_no}|${row.batch_year}|${row.batch_no}|${row.batch_index}`;
      if (seen.has(k)) {
        // The same mix twice in one payload would make ON CONFLICT fire against
        // a row inserted by the same statement, which Postgres refuses. Last
        // one wins, which is also what a re-read of the source would give.
        const at = clean.findIndex((r) => `${r.plant_no}|${r.batch_year}|${r.batch_no}|${r.batch_index}` === k);
        clean[at] = row;
        continue;
      }
      seen.add(k);
      clean.push(row);
    }

    // ROUND 159 — per-slot resolution, and a refillable silo asks the fill
    // history what it held at the moment this batch was made.
    const refillable = new Set(
      [...resolver.bySlot.entries()].filter(([, v]) => v.refillable).map(([k]) => k)
    );
    for (const row of clean) {
      for (const m of row.materials) {
        m.material_id = refillable.has(m.slot)
          ? await siloMaterialAt(m.slot, row.batched_at || row.batch_date)
          : resolveSilo(resolver, m.slot, m.slot_name);
      }
      row.source_hash = hashMix(row, row.materials);
    }

    let inserted = 0, updated = 0;

    await client.query("BEGIN");
    for (const row of clean) {
      const params = MIX_COLS.map((c) => row[c]);
      const { rows: up } = await client.query(
        `INSERT INTO plant_batches (${MIX_COLS.join(", ")})
         VALUES (${MIX_COLS.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (plant_no, batch_year, batch_no, batch_index) DO UPDATE SET
           batched_at = EXCLUDED.batched_at, batch_date = EXCLUDED.batch_date,
           recipe_code = EXCLUDED.recipe_code, recipe_name = EXCLUDED.recipe_name,
           strength = EXCLUDED.strength, consistency = EXCLUDED.consistency,
           customer_code = EXCLUDED.customer_code, site_name = EXCLUDED.site_name,
           truck_no = EXCLUDED.truck_no, truck_driver = EXCLUDED.truck_driver,
           order_no = EXCLUDED.order_no, batcher_name = EXCLUDED.batcher_name,
           batch_qty_m3 = EXCLUDED.batch_qty_m3, load_qty_m3 = EXCLUDED.load_qty_m3,
           cumulative_qty_m3 = EXCLUDED.cumulative_qty_m3,
           ordered_qty_m3 = EXCLUDED.ordered_qty_m3,
           returned_qty_m3 = EXCLUDED.returned_qty_m3, with_this_load_m3 = EXCLUDED.with_this_load_m3,
           mixer_capacity_m3 = EXCLUDED.mixer_capacity_m3,
           mixing_time_s = EXCLUDED.mixing_time_s,
           load_started_at = EXCLUDED.load_started_at, load_ended_at = EXCLUDED.load_ended_at,
           weighed_net_weight_kg = EXCLUDED.weighed_net_weight_kg,
           weighbridge_stat = EXCLUDED.weighbridge_stat,
           source_hash = EXCLUDED.source_hash,
           revision = plant_batches.revision + 1,
           last_synced_at = now()
         WHERE plant_batches.source_hash IS DISTINCT FROM EXCLUDED.source_hash
         RETURNING id, (xmax = 0) AS inserted`,
        params
      );

      // Nothing returned means the hash matched and this mix has not changed —
      // the common case on the trailing re-read window, and it costs one
      // comparison. Its material rows are necessarily unchanged too.
      if (!up.length) continue;
      const batchId = up[0].id;
      if (up[0].inserted) inserted++; else updated++;

      // Materials are replaced wholesale rather than merged. A mix has at most
      // twenty rows, and a corrected batch could legitimately have a hopper
      // that no longer fires — a merge would leave that stale row behind and
      // over-count consumption.
      await client.query(`DELETE FROM plant_batch_materials WHERE batch_id = $1`, [batchId]);
      for (const m of row.materials) {
        await client.query(
          `INSERT INTO plant_batch_materials
             (batch_id, slot, slot_name, design_kg_per_m3, actual_kg, target_kg, moisture_pct, correction, material_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [batchId, m.slot, m.slot_name, m.design_kg_per_m3, m.actual_kg, m.target_kg,
           m.moisture_pct, m.correction, m.material_id]
        );
      }
    }
    await client.query("COMMIT");

    const { rows: hw } = await query(
      `SELECT max(batch_no) AS highest, max(batch_year) AS yr FROM plant_batches`
    );
    const unchanged = clean.length - inserted - updated;

    await query(
      `INSERT INTO plant_sync_log
         (agent_version, rows_sent, rows_inserted, rows_updated, rows_unchanged, rows_rejected, highest_batch, batch_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [agentVersion, incoming.length, inserted, updated, unchanged, rejected, hw[0].highest, hw[0].yr]
    );

    res.json({
      ok: true, inserted, updated, unchanged, rejected,
      // The agent resumes from here rather than keeping its own state in step
      // with ours — so a restored backup pulls it back automatically.
      highest_batch: hw[0].highest,
      batch_year: hw[0].yr,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("plant sync failed", err);
    await query(
      `INSERT INTO plant_sync_log (agent_version, rows_sent, error) VALUES ($1, $2, $3)`,
      [agentVersion, incoming.length, String(err.message).slice(0, 2000)]
    ).catch(() => {});
    res.status(500).json({ error: "Could not store the batches." });
  } finally {
    client.release();
  }
});

// ============================================================================
// EVERYTHING BELOW IS A USER SESSION.
// ============================================================================
// ROUND 171 — Recipe Master sync is an AGENT endpoint, so it must sit ABOVE
// router.use(requireAuth) with the batch /sync route, not behind the user
// login. The read routes (GET /recipes) stay below, gated by permissions.
router.post("/recipes/sync", async (req, res) => {
  if (!agentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });
  const recipes = Array.isArray(req.body?.recipes) ? req.body.recipes : null;
  if (!recipes) return res.status(400).json({ error: "Send { recipes: [...] }." });

  let inserted = 0, updated = 0, unchanged = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of recipes) {
      const code = String(r.recipe_code || "").trim();
      if (!code) continue;
      const hash = crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex");
      const { rows } = await client.query(
        `INSERT INTO plant_recipes
           (recipe_code, recipe_name, strength, consistancy, mixing_time, mixer_capacity, mass_weight,
            premix_time, dry_mix_time, drymix_pct, wetmix_pct, water_ice_pct, water_slurry_pct,
            cement_water_pct, cement_filler_pct, cost_per_m3_plant, deleted_flag,
            plant_creater_name, plant_created_at, plant_modifier_name, plant_modified_at, plant_modified_user_level,
            source_hash, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now())
         ON CONFLICT (recipe_code) DO UPDATE SET
           recipe_name=EXCLUDED.recipe_name, strength=EXCLUDED.strength, consistancy=EXCLUDED.consistancy,
           mixing_time=EXCLUDED.mixing_time, mixer_capacity=EXCLUDED.mixer_capacity, mass_weight=EXCLUDED.mass_weight,
           premix_time=EXCLUDED.premix_time, dry_mix_time=EXCLUDED.dry_mix_time, drymix_pct=EXCLUDED.drymix_pct,
           wetmix_pct=EXCLUDED.wetmix_pct, water_ice_pct=EXCLUDED.water_ice_pct, water_slurry_pct=EXCLUDED.water_slurry_pct,
           cement_water_pct=EXCLUDED.cement_water_pct, cement_filler_pct=EXCLUDED.cement_filler_pct,
           cost_per_m3_plant=EXCLUDED.cost_per_m3_plant, deleted_flag=EXCLUDED.deleted_flag,
           plant_creater_name=EXCLUDED.plant_creater_name, plant_created_at=EXCLUDED.plant_created_at,
           plant_modifier_name=EXCLUDED.plant_modifier_name, plant_modified_at=EXCLUDED.plant_modified_at,
           plant_modified_user_level=EXCLUDED.plant_modified_user_level,
           source_hash=EXCLUDED.source_hash, last_synced_at=now()
         WHERE plant_recipes.source_hash IS DISTINCT FROM EXCLUDED.source_hash
         RETURNING id, (xmax = 0) AS was_insert`,
        [code, r.recipe_name || null, NUM(r.strength), r.consistancy || null, NUM(r.mixing_time), NUM(r.mixer_capacity),
         NUM(r.mass_weight), NUM(r.premix_time), NUM(r.dry_mix_time), NUM(r.drymix_pct), NUM(r.wetmix_pct),
         NUM(r.water_ice_pct), NUM(r.water_slurry_pct), NUM(r.cement_water_pct), NUM(r.cement_filler_pct),
         NUM(r.cost_per_m3_plant), r.deleted_flag || null,
         r.plant_creater_name || null, r.plant_created_at || null, r.plant_modifier_name || null,
         r.plant_modified_at || null, r.plant_modified_user_level || null, hash]
      );
      if (!rows.length) { unchanged++; continue; }   // hash identical → nothing to do, targets already current
      const recipeId = rows[0].id;
      rows[0].was_insert ? inserted++ : updated++;
      // Rewrite the targets to match exactly what the plant sent (only slots in use).
      await client.query(`DELETE FROM plant_recipe_targets WHERE recipe_id = $1`, [recipeId]);
      const targets = r.targets && typeof r.targets === "object" ? r.targets : {};
      for (const [slot, val] of Object.entries(targets)) {
        if (!SLOT_BY_KEY[slot]) continue;
        const t = Number(val);
        if (!Number.isFinite(t) || t === 0) continue;
        await client.query(`INSERT INTO plant_recipe_targets (recipe_id, slot, target) VALUES ($1,$2,$3)`, [recipeId, slot, t]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({ error: "Recipe sync failed." });
  } finally {
    client.release();
  }
  res.json({ ok: true, received: recipes.length, inserted, updated, unchanged });
});

router.use(requireAuth);

const PLANT_ROLES = ["administrator", "manager", "store", "plant_operator", "qc_engineer", "lab_technician"];
const PLANT_ADMIN = ["administrator"];
// Reading the day's figures is the same audience as the rest of the plant data.
const PLANT_READ = PLANT_ROLES;
// Entering what the plant did not record is the Plant Operator's job — they are
// the person who knows a hand mix happened. Administrator too, for corrections.
const PLANT_MANUAL = ["administrator", "plant_operator"];

// Round 167 — a shared date window for the reporting routes. When the caller
// passes a valid from_date AND to_date (YYYY-MM-DD) it's an explicit range;
// otherwise it falls back to the `days` preset (1/7/30/90…), exactly as before.
// Returns a WHERE fragment and its params so each query can splice them in at
// $1 (and $2 for a range). IST is handled by db.js pinning the session to
// Asia/Kolkata, so CURRENT_DATE and ::date comparisons are the plant's day.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dateRange(req, col) {
  const from = ISO_DATE.test(req.query.from_date || "") ? req.query.from_date : null;
  const to = ISO_DATE.test(req.query.to_date || "") ? req.query.to_date : null;
  if (from && to) {
    return { sql: `${col} BETWEEN $1::date AND $2::date`, params: [from, to] };
  }
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400);
  return { sql: `${col} >= CURRENT_DATE - ($1::int - 1)`, params: [days] };
}

// The day's production, and how the plant is running.
router.get("/summary", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    // CURRENT_DATE is the IST day — db.js pins every connection to
    // Asia/Kolkata. Doing this in JavaScript would give the UTC day and be
    // wrong between midnight and 05:30 every morning.
    const [today, last, unmapped] = await Promise.all([
      query(
        `SELECT COALESCE(sum(batch_qty_m3), 0)::numeric AS m3,
                count(*)::int AS batches,
                count(DISTINCT (batch_year, batch_no))::int AS loads,
                count(DISTINCT recipe_code)::int AS recipes
         FROM plant_batches WHERE batch_date = CURRENT_DATE`
      ),
      query(`SELECT received_at, agent_version, error FROM plant_sync_log ORDER BY received_at DESC LIMIT 1`),
      // Silos still needing a human. A silo somebody deliberately marked as
      // not-stock (mains water, a spare hopper) also has material_id NULL, so
      // counting NULLs alone would nag forever about a decision already made —
      // hence the NOT EXISTS against the alias table. Placeholder names the
      // plant never used ("0", "-") are excluded for the same reason: they are
      // not silos, they are empty slots.
      query(
        // Round 159 — counted per HOPPER, not per name. A hopper with any kind
        // of decision recorded against it is settled, refillable and
        // not-stock included; only one nobody has said anything about is work.
        `SELECT count(*)::int AS n FROM (
           SELECT pm.slot,
                  (array_agg(pm.slot_name) FILTER (WHERE pm.slot_name IS NOT NULL))[1] AS nm
             FROM plant_batch_materials pm
            WHERE pm.material_id IS NULL
            GROUP BY pm.slot
         ) n
         WHERE upper(regexp_replace(COALESCE(n.nm, ''), '[^A-Za-z0-9]', '', 'g'))
               NOT IN ('', '0', '1', 'NA', 'NONE', 'NIL', 'AGG6', 'XXX', 'DUMMY', 'SPARE')
           AND NOT EXISTS (SELECT 1 FROM plant_silo_aliases a WHERE a.slot = n.slot)`
      ),
    ]);
    res.json({
      today_m3: Number(today.rows[0].m3),
      today_batches: today.rows[0].batches,
      today_loads: today.rows[0].loads,
      today_recipes: today.rows[0].recipes,
      unmapped_silos: unmapped.rows[0].n,
      last_sync_at: last.rows[0]?.received_at || null,
      last_sync_error: last.rows[0]?.error || null,
      agent_version: last.rows[0]?.agent_version || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the plant summary." });
  }
});

// Production by day, and by recipe within the range.
router.get("/production", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    const rng = dateRange(req, "batch_date");
    const [byDay, byRecipe] = await Promise.all([
      query(
        // to_char, not the bare date: node-postgres turns a DATE into a JS
        // Date at the session timezone, and the browser then has to turn it
        // back. That round trip is the exact shape of the UTC/IST bug this app
        // keeps meeting. A plain 'YYYY-MM-DD' string cannot drift.
        `SELECT to_char(batch_date, 'YYYY-MM-DD') AS batch_date,
                sum(batch_qty_m3)::numeric AS m3,
                count(*)::int AS batches,
                count(DISTINCT (batch_year, batch_no))::int AS loads
         FROM plant_batches
         WHERE ${rng.sql}
         GROUP BY batch_date ORDER BY batch_date DESC`,
        rng.params
      ),
      query(
        `SELECT COALESCE(recipe_code, '(none)') AS recipe_code,
                max(recipe_name) AS recipe_name,
                sum(batch_qty_m3)::numeric AS m3,
                count(DISTINCT (batch_year, batch_no))::int AS loads
         FROM plant_batches
         WHERE ${rng.sql}
         GROUP BY 1 ORDER BY m3 DESC NULLS LAST`,
        rng.params
      ),
    ]);
    res.json({ by_day: byDay.rows, by_recipe: byRecipe.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load production." });
  }
});

// What the plant actually consumed, per silo, with design-vs-actual.
//
// Reported by SILO rather than by material, with the material shown alongside
// where one is mapped. That way a hopper nobody has mapped yet still shows its
// real consumption instead of disappearing — the figures are true before the
// mapping work is done, which is the opposite of how the weighbridge behaves
// and is right here because the plant weighed it either way.
router.get("/consumption", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    const rng = dateRange(req, "pb.batch_date");
    const { rows } = await query(
      `SELECT pm.slot,
              (array_agg(pm.slot_name ORDER BY pb.batched_at DESC NULLS LAST))[1] AS slot_name,
              m.name AS material_name, pm.material_id,
              sum(pm.actual_kg)::numeric AS actual_kg,
              sum(pm.target_kg)::numeric AS target_kg,
              round(avg(pm.moisture_pct)::numeric, 2) AS avg_moisture_pct,
              count(*)::int AS batches,
              -- So a hopper someone has deliberately marked "not stock" reads
              -- as a settled decision here rather than as outstanding work.
              bool_or(EXISTS (SELECT 1 FROM plant_silo_aliases a
                               WHERE a.slot = pm.slot AND a.is_ignored)) AS ignored,
              -- Round 159 — a refillable silo with nothing behind it is
              -- awaiting a FILL, which is different from awaiting a mapping.
              bool_or(EXISTS (SELECT 1 FROM plant_silo_aliases a
                               WHERE a.slot = pm.slot AND a.is_refillable)) AS refillable,
              round(avg(pm.design_kg_per_m3)::numeric, 2) AS design_kg_per_m3
       FROM plant_batch_materials pm
       JOIN plant_batches pb ON pb.id = pm.batch_id
       LEFT JOIN rm_materials m ON m.id = pm.material_id
       WHERE ${rng.sql}
       GROUP BY pm.slot, m.name, pm.material_id
       ORDER BY sum(pm.actual_kg) DESC NULLS LAST`,
      rng.params
    );
    const { rows: prod } = await query(
      `SELECT COALESCE(sum(batch_qty_m3), 0)::numeric AS m3
       FROM plant_batches pb WHERE ${rng.sql}`,
      rng.params
    );
    res.json({ silos: rows, total_m3: Number(prod[0].m3) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load consumption." });
  }
});

// Round 167 — Cost/m³ (material). Raw-material cost per m³ over the period:
// for each material, the quantity the plant CONSUMED (load-cell auto + the
// operator's manual entries — never the auto figure alone) × the material's
// weighted-average landed rate, divided by the m³ PRODUCED (batches + manual
// production). Rates are money, so this is gated like the material module's
// valuation: Administrator only (material.stock-valuation). No new permission
// key, so no seeding/REPAIR is needed.
router.get("/cost-per-m3", requireRole("administrator"), requirePermission("material.stock-valuation", "view"), async (req, res) => {
  try {
    const rngB = dateRange(req, "pb.batch_date");     // plant_batch_materials via its batch
    const rngE = dateRange(req, "e.entry_date");       // plant_manual_entries
    const [auto, manual, prodAuto, prodManual, rates, mats] = await Promise.all([
      query(
        `SELECT pm.material_id, sum(pm.actual_kg)::numeric AS kg
           FROM plant_batch_materials pm
           JOIN plant_batches pb ON pb.id = pm.batch_id
          WHERE ${rngB.sql} AND pm.material_id IS NOT NULL
          GROUP BY pm.material_id`, rngB.params),
      query(
        `SELECT e.material_id, sum(e.qty_kg)::numeric AS kg
           FROM plant_manual_entries e
          WHERE ${rngE.sql} AND e.material_id IS NOT NULL
          GROUP BY e.material_id`, rngE.params),
      query(`SELECT COALESCE(sum(batch_qty_m3),0)::numeric AS m3 FROM plant_batches pb WHERE ${rngB.sql}`, rngB.params),
      query(`SELECT COALESCE(sum(e.qty_m3),0)::numeric AS m3 FROM plant_manual_entries e WHERE ${rngE.sql} AND e.material_id IS NULL`, rngE.params),
      // Weighted-average landed rate per material, across all receipts to date.
      query(
        `SELECT o.material_id,
                CASE WHEN sum(r.accepted_qty_kg) > 0
                     THEN sum(r.accepted_qty_kg * r.landed_rate_per_kg) / sum(r.accepted_qty_kg)
                END AS rate
           FROM rm_receipts_effective r
           JOIN rm_orders o ON o.id = r.order_id
          WHERE r.landed_rate_per_kg IS NOT NULL
          GROUP BY o.material_id`),
      query(`SELECT id, name, opening_stock_rate_per_kg FROM rm_materials WHERE is_active = true`),
    ]);

    const producedM3 = Number(prodAuto.rows[0].m3) + Number(prodManual.rows[0].m3);
    const rateBy = new Map(rates.rows.map((r) => [r.material_id, r.rate == null ? null : Number(r.rate)]));
    const consumed = new Map();
    for (const r of auto.rows) consumed.set(r.material_id, Number(r.kg));
    for (const r of manual.rows) consumed.set(r.material_id, (consumed.get(r.material_id) || 0) + Number(r.kg));

    const rows = [];
    let totalCostPerM3 = 0;
    for (const m of mats.rows) {
      const kg = consumed.get(m.id);
      if (!kg) continue;                                  // only materials actually consumed
      const rate = rateBy.get(m.id) ?? (m.opening_stock_rate_per_kg != null ? Number(m.opening_stock_rate_per_kg) : null);
      const costPerM3 = (rate != null && producedM3 > 0) ? (kg * rate) / producedM3 : null;
      if (costPerM3 != null) totalCostPerM3 += costPerM3;
      rows.push({
        material_id: m.id, material_name: m.name,
        consumed_kg: Math.round(kg * 100) / 100,
        rate_per_kg: rate == null ? null : Math.round(rate * 10000) / 10000,
        has_rate: rate != null,
        cost_per_m3: costPerM3 == null ? null : Math.round(costPerM3 * 100) / 100,
      });
    }
    rows.sort((a, b) => (b.cost_per_m3 || 0) - (a.cost_per_m3 || 0));
    for (const r of rows) r.share_pct = totalCostPerM3 > 0 && r.cost_per_m3 != null ? Math.round((r.cost_per_m3 / totalCostPerM3) * 1000) / 10 : null;

    res.json({
      produced_m3: Math.round(producedM3 * 100) / 100,
      total_cost_per_m3: Math.round(totalCostPerM3 * 100) / 100,
      total_material_cost: Math.round(totalCostPerM3 * producedM3 * 100) / 100,
      rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not compute cost per m³." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 169 — the Mix Designs page (item 7a). Three read-only views of the
// mix_designs data the lab already maintains, brought onto the plant side:
// Details (one design in full), Comparison (every grade's standard design side
// by side) and Costing (design kg/m³ vs what the plant actually weighed, each
// priced at the material's landed rate). Nothing here writes — a design is
// created and approved on the lab side; this is the plant's read of it.
// ---------------------------------------------------------------------------

// The design ingredients that have a fixed column on mix_designs, in the order
// the page shows them. Admixture is handled separately (a design can carry
// several, in mix_design_admixtures). material.mix_component ties a material to
// one of these keys, which is how a design ingredient finds its rate and its
// weighed-out actual.
const MIX_COST_COMPONENTS = [
  { key: "cement",        label: "Cement",             col: "cement_kgm3" },
  { key: "fly_ash",       label: "Fly ash",            col: "fly_ash_kgm3" },
  { key: "fine_agg",      label: "Fine aggregate",     col: "fine_agg_kgm3" },
  { key: "coarse_20mm",   label: "20 mm coarse",       col: "coarse_20mm_kgm3" },
  { key: "coarse_12_5mm", label: "12.5 mm coarse",     col: "coarse_12_5mm_kgm3" },
];

router.get("/mix-designs", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT d.id, d.design_ref_code, d.revision, d.status, d.is_standard_for_grade,
              d.fck_28day_mpa, g.id AS grade_id, g.name AS grade
         FROM mix_designs d
         JOIN mix_grades g ON g.id = d.mix_grade_id
        WHERE d.status = 'approved'
        ORDER BY g.name, d.is_standard_for_grade DESC, d.design_ref_code`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the mix designs." });
  }
});

router.get("/mix-designs-comparison", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT g.name AS grade, d.design_ref_code, d.is_standard_for_grade,
              d.cement_kgm3, d.fly_ash_kgm3, d.total_binder_kgm3,
              d.free_water_kgm3, d.wb_ratio, d.total_aggregate_kgm3,
              (SELECT COALESCE(sum(a.qty_kgm3), 0) FROM mix_design_admixtures a WHERE a.mix_design_id = d.id) AS admix_kgm3
         FROM mix_designs d
         JOIN mix_grades g ON g.id = d.mix_grade_id
        WHERE d.status = 'approved' AND d.is_standard_for_grade = true
        ORDER BY d.cement_kgm3 NULLS LAST, g.name`
    );
    res.json(rows.map((r) => ({
      ...r,
      admix_pct: Number(r.total_binder_kgm3) > 0 ? (Number(r.admix_kgm3) / Number(r.total_binder_kgm3)) * 100 : null,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the comparison." });
  }
});

router.get("/mix-designs/:id", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid mix design id." });
  try {
    const { rows } = await query(
      `SELECT d.*, g.name AS grade FROM mix_designs d JOIN mix_grades g ON g.id = d.mix_grade_id WHERE d.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Mix design not found." });
    const { rows: adm } = await query(
      `SELECT type_brand, dosage_pct_of_binder, qty_kgm3, sp_gr FROM mix_design_admixtures WHERE mix_design_id = $1 ORDER BY sort_order, id`,
      [id]
    );
    res.json({ design: rows[0], admixtures: adm });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the mix design." });
  }
});

// Costing — money, so Administrator + the same valuation permission as Cost/m³.
// Design side: design kg/m³ × the ingredient's landed rate. Actual side: what
// the plant weighed per m³ FOR THIS GRADE'S BATCHES in the period (load-cell
// actual_kg over batches whose recipe resolved to this design's grade, ÷ this
// grade's m³), same rate. The gap between the two is the over/under-batching cost.
router.get("/mix-designs/:id/costing", requireRole("administrator"), requirePermission("material.stock-valuation", "view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid mix design id." });
  try {
    const { rows: dr } = await query(`SELECT * FROM mix_designs d WHERE d.id = $1`, [id]);
    if (!dr.length) return res.status(404).json({ error: "Mix design not found." });
    const design = dr[0];
    const gradeId = design.mix_grade_id;
    const rng = dateRange(req, "pb.batch_date");
    const gradeParam = rng.params.length + 1;

    const [actual, gradeM3, admDesign, rates] = await Promise.all([
      // What the plant weighed out, per material, for this grade's batches in
      // range. material_id is already resolved against the silo mappings. The
      // batch's grade comes from plant_recipe_aliases — its recipe code
      // normalised (upper-case, alphanumerics only, matching normaliseRecipe on
      // the MixTrack side) against the alias table's key. Until a recipe is
      // mapped there, its batches simply don't count toward any grade here.
      query(
        `SELECT pm.material_id, m.mix_component, sum(pm.actual_kg)::numeric AS kg
           FROM plant_batch_materials pm
           JOIN plant_batches pb ON pb.id = pm.batch_id
           JOIN plant_recipe_aliases ra
             ON ra.normalised = upper(regexp_replace(coalesce(pb.recipe_code, ''), '[^A-Za-z0-9]', '', 'g'))
            AND ra.is_ignored = false
           JOIN rm_materials m ON m.id = pm.material_id
          WHERE ${rng.sql} AND ra.mix_grade_id = $${gradeParam}
            AND pm.material_id IS NOT NULL
          GROUP BY pm.material_id, m.mix_component`,
        [...rng.params, gradeId]
      ),
      query(
        `SELECT COALESCE(sum(pb.batch_qty_m3), 0)::numeric AS m3
           FROM plant_batches pb
           JOIN plant_recipe_aliases ra
             ON ra.normalised = upper(regexp_replace(coalesce(pb.recipe_code, ''), '[^A-Za-z0-9]', '', 'g'))
            AND ra.is_ignored = false
          WHERE ${rng.sql} AND ra.mix_grade_id = $${gradeParam}`,
        [...rng.params, gradeId]
      ),
      query(`SELECT COALESCE(sum(qty_kgm3), 0)::numeric AS kgm3 FROM mix_design_admixtures WHERE mix_design_id = $1`, [id]),
      // Weighted-average landed rate per material (all receipts to date), with
      // its mix_component and the opening-stock rate as a fallback.
      query(
        `SELECT m.id AS material_id, m.name, m.mix_component, m.opening_stock_rate_per_kg,
                (SELECT CASE WHEN sum(r.accepted_qty_kg) > 0
                             THEN sum(r.accepted_qty_kg * r.landed_rate_per_kg) / sum(r.accepted_qty_kg) END
                   FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
                  WHERE o.material_id = m.id AND r.landed_rate_per_kg IS NOT NULL) AS rate
           FROM rm_materials m
          WHERE m.is_active = true AND m.mix_component IS NOT NULL`
      ),
    ]);

    const producedM3 = Number(gradeM3.rows[0].m3);
    // Per material: its rate (weighted-avg landed, else opening-stock rate) and
    // consumed kg, grouped so a component can weight several materials' rates.
    const rateByMat = new Map();
    for (const r of rates.rows) {
      const rate = r.rate != null ? Number(r.rate) : (r.opening_stock_rate_per_kg != null ? Number(r.opening_stock_rate_per_kg) : null);
      rateByMat.set(r.material_id, { rate, component: r.mix_component });
    }
    // Consumed kg by component, and by (component → material) for rate weighting.
    const consumedByComponent = new Map();
    const consumedByMat = new Map();
    for (const a of actual.rows) {
      const kg = Number(a.kg);
      consumedByComponent.set(a.mix_component, (consumedByComponent.get(a.mix_component) || 0) + kg);
      consumedByMat.set(a.material_id, kg);
    }
    // Materials grouped by component, for choosing/weighting a component's rate.
    const matsByComponent = new Map();
    for (const r of rates.rows) {
      if (!matsByComponent.has(r.mix_component)) matsByComponent.set(r.mix_component, []);
      matsByComponent.get(r.mix_component).push(r.material_id);
    }

    // One rate per ingredient: consumption-weighted across that component's
    // materials where there is consumption, else a simple average of the rates
    // that exist. Keeps the table to a single readable Rate column.
    function componentRate(componentKey) {
      const mats = matsByComponent.get(componentKey) || [];
      let wSum = 0, wKg = 0, plainSum = 0, plainN = 0;
      for (const mid of mats) {
        const info = rateByMat.get(mid);
        if (!info || info.rate == null) continue;
        const kg = consumedByMat.get(mid) || 0;
        if (kg > 0) { wSum += info.rate * kg; wKg += kg; }
        plainSum += info.rate; plainN += 1;
      }
      if (wKg > 0) return wSum / wKg;
      if (plainN > 0) return plainSum / plainN;
      return null;
    }

    const rows = [];
    let designTotal = 0, actualTotal = 0;
    const ingredients = [
      ...MIX_COST_COMPONENTS.map((c) => ({ ...c, designKg: design[c.col] != null ? Number(design[c.col]) : null })),
      { key: "admixture", label: "Admixture", designKg: Number(admDesign.rows[0].kgm3) || 0 },
    ];
    for (const ing of ingredients) {
      const rate = componentRate(ing.key);
      const actualKg = consumedByComponent.has(ing.key) && producedM3 > 0
        ? consumedByComponent.get(ing.key) / producedM3 : null;
      const designCost = rate != null && ing.designKg != null ? rate * ing.designKg : null;
      const actualCost = rate != null && actualKg != null ? rate * actualKg : null;
      if (designCost != null) designTotal += designCost;
      if (actualCost != null) actualTotal += actualCost;
      rows.push({
        key: ing.key, label: ing.label,
        rate_per_kg: rate == null ? null : Math.round(rate * 10000) / 10000,
        design_kg_m3: ing.designKg == null ? null : Math.round(ing.designKg * 1000) / 1000,
        design_cost_m3: designCost == null ? null : Math.round(designCost * 100) / 100,
        actual_kg_m3: actualKg == null ? null : Math.round(actualKg * 1000) / 1000,
        actual_cost_m3: actualCost == null ? null : Math.round(actualCost * 100) / 100,
      });
    }

    res.json({
      design_ref_code: design.design_ref_code,
      revision: design.revision,
      grade_id: gradeId,
      produced_m3: Math.round(producedM3 * 100) / 100,
      has_actual: producedM3 > 0,
      rows,
      design_total_cost_m3: Math.round(designTotal * 100) / 100,
      actual_total_cost_m3: producedM3 > 0 ? Math.round(actualTotal * 100) / 100 : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not compute the mix design costing." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 171 — the Recipe Master, copied from MCI370 into the app.
//
// The agent reads MCI370's Recipe_Master and POSTs it here; QC reads the recipes
// and their cost per m³. (The password-gated write-back to MCI370 is a later
// round — this one is read-only, same posture as the rest of the plant sync.)
// ---------------------------------------------------------------------------

// What material a slot currently holds: its fixed mapping, or for a refillable
// silo the material of its most recent fill. Used to price a recipe's targets.
async function slotMaterialMap() {
  const [{ rows: aliases }, { rows: fills }] = await Promise.all([
    query(`SELECT slot, material_id, is_refillable, is_ignored FROM plant_silo_aliases`),
    query(`SELECT DISTINCT ON (slot) slot, material_id FROM plant_silo_fills ORDER BY slot, filled_at DESC`),
  ]);
  const fillBySlot = new Map(fills.map((f) => [f.slot, f.material_id]));
  const map = new Map();
  for (const a of aliases) {
    if (a.is_ignored) continue;
    const mid = a.is_refillable ? (fillBySlot.get(a.slot) || null) : a.material_id;
    if (mid) map.set(a.slot, mid);
  }
  return map;
}

// Weighted-average landed rate per material, opening-stock rate as a fallback.
async function materialRateLookup() {
  const [{ rows }, { rows: mats }] = await Promise.all([
    query(
      `SELECT o.material_id,
              CASE WHEN sum(r.accepted_qty_kg) > 0
                   THEN sum(r.accepted_qty_kg * r.landed_rate_per_kg) / sum(r.accepted_qty_kg) END AS rate
         FROM rm_receipts_effective r JOIN rm_orders o ON o.id = r.order_id
        WHERE r.landed_rate_per_kg IS NOT NULL GROUP BY o.material_id`),
    query(`SELECT id, name, opening_stock_rate_per_kg FROM rm_materials`),
  ]);
  const landed = new Map();
  for (const r of rows) if (r.rate != null) landed.set(r.material_id, Number(r.rate));
  const opening = new Map(mats.map((m) => [m.id, m.opening_stock_rate_per_kg != null ? Number(m.opening_stock_rate_per_kg) : null]));
  const name = new Map(mats.map((m) => [m.id, m.name]));
  return {
    rate: (mid) => (landed.has(mid) ? landed.get(mid) : (opening.get(mid) ?? null)),
    name: (mid) => name.get(mid) || null,
  };
}

// Binder = the cement slots plus the filler slot (this plant carries fly ash on
// the filler slot). Water = the two water lines. Enough for the list's w/c.
const BINDER_SLOTS = ["cement1", "cement2", "cement3", "cement4", "filler1"];
const WATER_SLOTS = ["water1", "water2"];

router.get("/recipes", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    const [{ rows: recipes }, { rows: targets }, slotMat, rateLk] = await Promise.all([
      query(`SELECT * FROM plant_recipes WHERE COALESCE(deleted_flag, '') <> 'Yes' ORDER BY recipe_code`),
      query(`SELECT recipe_id, slot, target FROM plant_recipe_targets`),
      slotMaterialMap(),
      materialRateLookup(),
    ]);
    const byRecipe = new Map();
    for (const t of targets) {
      if (!byRecipe.has(t.recipe_id)) byRecipe.set(t.recipe_id, []);
      byRecipe.get(t.recipe_id).push(t);
    }
    res.json(recipes.map((r) => {
      let cost = 0, binder = 0, water = 0, anyUnpriced = false;
      for (const t of byRecipe.get(r.id) || []) {
        const tgt = Number(t.target);
        if (BINDER_SLOTS.includes(t.slot)) binder += tgt;
        if (WATER_SLOTS.includes(t.slot)) water += tgt;
        const mid = slotMat.get(t.slot);
        const rate = mid ? rateLk.rate(mid) : null;
        if (rate != null) cost += tgt * rate; else anyUnpriced = true;
      }
      return {
        id: r.id, recipe_code: r.recipe_code, recipe_name: r.recipe_name,
        mixing_time: r.mixing_time, mixer_capacity: r.mixer_capacity,
        plant_modifier_name: r.plant_modifier_name, plant_modified_at: r.plant_modified_at,
        binder_kg: Math.round(binder * 100) / 100,
        water_kg: Math.round(water * 100) / 100,
        wc_ratio: binder > 0 ? Math.round((water / binder) * 1000) / 1000 : null,
        cost_per_m3: Math.round(cost * 100) / 100,
        cost_incomplete: anyUnpriced,
      };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the recipes." });
  }
});

router.get("/recipes/:id", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid recipe id." });
  try {
    const { rows } = await query(`SELECT * FROM plant_recipes WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Recipe not found." });
    const recipe = rows[0];
    const [{ rows: targets }, { rows: aliases }, slotMat, rateLk] = await Promise.all([
      query(`SELECT slot, target FROM plant_recipe_targets WHERE recipe_id = $1`, [id]),
      query(`SELECT slot, slot_name FROM plant_silo_aliases`),
      slotMaterialMap(),
      materialRateLookup(),
    ]);
    const nameBySlot = new Map(aliases.map((a) => [a.slot, a.slot_name]));
    let cost = 0, binder = 0, water = 0, anyUnpriced = false;
    // Present the used slots in the fixed plant order, not insertion order.
    const order = PLANT_SLOTS.map((s) => s.key);
    const tgtBySlot = new Map(targets.map((t) => [t.slot, Number(t.target)]));
    const lines = [];
    for (const slot of order) {
      if (!tgtBySlot.has(slot)) continue;
      const tgt = tgtBySlot.get(slot);
      const mid = slotMat.get(slot);
      const rate = mid ? rateLk.rate(mid) : null;
      const lineCost = rate != null ? tgt * rate : null;
      if (lineCost != null) cost += lineCost; else anyUnpriced = true;
      if (BINDER_SLOTS.includes(slot)) binder += tgt;
      if (WATER_SLOTS.includes(slot)) water += tgt;
      lines.push({
        slot,
        slot_label: SLOT_BY_KEY[slot]?.label || slot,
        kind: SLOT_BY_KEY[slot]?.kind || null,
        plant_name: nameBySlot.get(slot) || null,
        target: tgt,
        material_name: mid ? rateLk.name(mid) : null,
        rate_per_kg: rate == null ? null : Math.round(rate * 10000) / 10000,
        cost_per_m3: lineCost == null ? null : Math.round(lineCost * 100) / 100,
      });
    }
    res.json({
      recipe: {
        ...recipe,
        binder_kg: Math.round(binder * 100) / 100,
        water_kg: Math.round(water * 100) / 100,
        wc_ratio: binder > 0 ? Math.round((water / binder) * 1000) / 1000 : null,
      },
      targets: lines,
      cost_per_m3: Math.round(cost * 100) / 100,
      cost_incomplete: anyUnpriced,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the recipe." });
  }
});

// The recent loads, batches rolled up.
router.get("/loads", requireRole(...PLANT_ROLES), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    const rng = dateRange(req, "batch_date");
    const { rows } = await query(
      `SELECT batch_year, batch_no, plant_no,
              min(batched_at) AS started_at,
              max(batched_at) AS finished_at,
              count(*)::int AS batches,
              sum(batch_qty_m3)::numeric AS m3,
              max(recipe_code) AS recipe_code, max(recipe_name) AS recipe_name,
              max(customer_code) AS customer_code, max(site_name) AS site_name,
              max(truck_no) AS truck_no, max(truck_driver) AS truck_driver,
              max(batcher_name) AS batcher_name, max(order_no) AS order_no
       FROM plant_batches
       WHERE ${rng.sql}
       GROUP BY batch_year, batch_no, plant_no
       ORDER BY min(batched_at) DESC NULLS LAST
       LIMIT 300`,
      rng.params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the batches." });
  }
});

// ---------------------------------------------------------------------------
// Silo mapping — Administrator only, same reasoning as the weighbridge's:
// deciding what a silo holds decides where a month of consumption is counted.
// ---------------------------------------------------------------------------// ---------------------------------------------------------------------------
// Re-resolve every material row against the current mappings and fill history.
// Called after any mapping or fill change, and available on demand — the same
// reason the weighbridge needed it: adding a material to the masters, or
// recording a fill, must reach rows that have already synced.
// ---------------------------------------------------------------------------
async function reresolveSilos() {
  const resolver = await loadSiloResolver();
  let touched = 0;

  // Fixed hoppers: one decision covers every row of that slot.
  const { rows: slots } = await query(
    `SELECT pm.slot, (array_agg(pm.slot_name) FILTER (WHERE pm.slot_name IS NOT NULL))[1] AS slot_name
       FROM plant_batch_materials pm GROUP BY pm.slot`
  );
  for (const r of slots) {
    const entry = resolver.bySlot.get(r.slot);
    if (entry && entry.refillable) continue;          // handled below, per batch
    const id = resolveSilo(resolver, r.slot, r.slot_name);
    const { rowCount } = await query(
      `UPDATE plant_batch_materials SET material_id = $2
        WHERE slot = $1 AND material_id IS DISTINCT FROM $2`,
      [r.slot, id]
    );
    touched += rowCount;
  }

  // Refillable silos: the answer depends on WHEN, so each row takes the fill
  // that was in force at its own batch's moment.
  //
  // A CTE rather than a LATERAL because Postgres will not let a LATERAL in the
  // FROM clause reference the UPDATE's own target table. Computing the wanted
  // material first also means the NULL case — a batch older than any fill —
  // falls out of the same statement instead of needing a second one to clear
  // stale values.
  const { rowCount: refilled } = await query(
    `WITH want AS (
       SELECT pm.id,
              (SELECT sf.material_id FROM plant_silo_fills sf
                WHERE sf.slot = pm.slot
                  AND sf.filled_at <= COALESCE(pb.batched_at, pb.batch_date::timestamptz)
                ORDER BY sf.filled_at DESC LIMIT 1) AS mid
         FROM plant_batch_materials pm
         JOIN plant_batches pb ON pb.id = pm.batch_id
        WHERE pm.slot IN (SELECT slot FROM plant_silo_aliases WHERE is_refillable)
     )
     UPDATE plant_batch_materials pm
        SET material_id = w.mid
       FROM want w
      WHERE w.id = pm.id AND pm.material_id IS DISTINCT FROM w.mid`
  );
  touched += refilled;

  return touched;
}

// ---------------------------------------------------------------------------
// ROUND 159 — the silos: what each hopper is, and what the refillable ones
// have held over time.
// ---------------------------------------------------------------------------
router.get("/silos", requireRole(...PLANT_ADMIN), requirePermission("production.plant-mapping", "view"), async (req, res) => {
  try {
    const [seen, aliases, materials, fills, notInSilo] = await Promise.all([
      // Keyed on the SLOT. slot_name is the panel's most recent word for it —
      // shown so a rename on the panel is visible rather than silent.
      query(
        `SELECT pm.slot,
                (array_agg(pm.slot_name ORDER BY pb.batched_at DESC NULLS LAST))[1] AS slot_name,
                count(DISTINCT pm.slot_name)::int AS name_count,
                sum(pm.actual_kg)::numeric AS actual_kg,
                count(*)::int AS batches,
                max(pb.batched_at) AS last_seen
         FROM plant_batch_materials pm
         JOIN plant_batches pb ON pb.id = pm.batch_id
         GROUP BY pm.slot
         ORDER BY sum(pm.actual_kg) DESC NULLS LAST`
      ),
      query(`SELECT a.id, a.slot, a.slot_name, a.material_id, a.is_ignored, a.is_refillable,
                    a.capacity_kg, m.name AS target, u.name AS mapped_by_name, a.mapped_at
             FROM plant_silo_aliases a
             LEFT JOIN rm_materials m ON m.id = a.material_id
             LEFT JOIN users u ON u.id = a.mapped_by
             ORDER BY a.slot`),
      query(`SELECT id, name FROM rm_materials WHERE is_active = true ORDER BY name`),
      // Balance per silo that has any fill: everything put in, less everything
      // the plant has weighed out SINCE the first fill. Counting only
      // post-first-fill consumption is deliberate — a silo's load-cell history
      // reaches back long before the app knew its opening stock, and subtracting
      // all of it would show a large phantom negative. From the first fill on,
      // in minus out is a real running level. (Round 159 computed this for
      // refillable silos alone; Round 168 keeps the same query but the frontend
      // now shows a level for every silo, not just the refillable ones.)
      query(
        `SELECT f.slot,
                (array_agg(f.material_id ORDER BY f.filled_at DESC))[1] AS current_material_id,
                (array_agg(m.name       ORDER BY f.filled_at DESC))[1] AS current_material,
                max(f.filled_at) AS last_filled_at,
                sum(f.qty_kg)::numeric AS filled_kg,
                COALESCE((SELECT sum(pm.actual_kg) FROM plant_batch_materials pm
                           JOIN plant_batches pb ON pb.id = pm.batch_id
                          WHERE pm.slot = f.slot
                            AND COALESCE(pb.batched_at, pb.batch_date::timestamptz) >= min(f.filled_at)), 0)::numeric AS used_kg
         FROM plant_silo_fills f
         LEFT JOIN rm_materials m ON m.id = f.material_id
         GROUP BY f.slot`
      ),
      // ROUND 168 — receipts explicitly NOT put into a silo (admixture drums for
      // the lab or the store). Read from the raw table, not rm_receipts_effective:
      // not_in_silo was added after that view was defined, and a SELECT * view
      // freezes its columns. Pending loads are excluded here to match the silo
      // level, which only counts confirmed stock.
      query(
        `SELECT o.material_id, m.name AS material_name,
                sum(r.accepted_qty_kg)::numeric AS qty_kg,
                count(*)::int AS receipts,
                max(r.received_date) AS last_received
         FROM rm_receipts r   -- receipts-raw: not_in_silo is newer than rm_receipts_effective (a SELECT * view freezes its columns), and pending is filtered explicitly on the next line
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         WHERE r.not_in_silo = true AND r.confirmation_status <> 'pending'
         GROUP BY o.material_id, m.name
         ORDER BY m.name`
      ),
    ]);

    const balance = new Map(fills.rows.map((r) => [r.slot, r]));

    // One level card per mapped silo that is stock (fixed material or refillable
    // storage). "Not stock at all" hoppers are left out — there is nothing to
    // level. level_kg is null until a silo has its first fill; pct is null until
    // it also has a capacity, so the card shows a bare quantity in the meantime.
    const levels = aliases.rows
      .filter((a) => !a.is_ignored)
      .map((a) => {
        const b = balance.get(a.slot) || null;
        const kind = SLOT_BY_KEY[a.slot]?.kind || null;
        const capacity = a.capacity_kg != null ? Number(a.capacity_kg) : null;
        const levelKg = b ? Number(b.filled_kg) - Number(b.used_kg) : null;
        const pct = capacity && capacity > 0 && levelKg != null
          ? Math.max(0, Math.min(100, (levelKg / capacity) * 100)) : null;
        return {
          slot: a.slot,
          slot_name: a.slot_name,
          label: SLOT_BY_KEY[a.slot]?.label || a.slot,
          kind,
          is_refillable: a.is_refillable,
          material_id: a.is_refillable ? (b?.current_material_id || null) : a.material_id,
          material_name: a.is_refillable ? (b?.current_material || null) : a.target,
          capacity_kg: capacity,
          filled_kg: b ? Number(b.filled_kg) : null,
          used_kg: b ? Number(b.used_kg) : null,
          level_kg: levelKg,
          pct,
          last_filled_at: b?.last_filled_at || null,
        };
      });

    res.json({
      seen: seen.rows.map((r) => ({ ...r, balance: balance.get(r.slot) || null })),
      aliases: aliases.rows,
      options: materials.rows,
      slots: PLANT_SLOTS.map((s) => ({ key: s.key, label: s.label, kind: s.kind })),
      levels,
      not_in_silo: notInSilo.rows.map((r) => ({
        material_id: r.material_id,
        material_name: r.material_name,
        qty_kg: Number(r.qty_kg),
        receipts: r.receipts,
        last_received: r.last_received,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the silos." });
  }
});

// Say what a hopper is: one of our materials, not stock at all, or refillable
// storage whose contents come from the fill history.
router.post("/silos", requireRole(...PLANT_ADMIN), requirePermission("production.plant-mapping", "create"), async (req, res) => {
  const slot = String(req.body?.slot ?? "").trim();
  if (!Object.prototype.hasOwnProperty.call(SLOT_BY_KEY, slot)) return res.status(400).json({ error: "That is not a hopper this plant has." });

  const isIgnored = req.body?.is_ignored === true;
  const isRefillable = req.body?.is_refillable === true;
  if (isIgnored && isRefillable) {
    return res.status(400).json({ error: "A silo is either refillable storage or not stock at all, not both." });
  }
  const targetId = (isIgnored || isRefillable) ? null : Number(req.body?.material_id);
  if (!isIgnored && !isRefillable && !(Number.isInteger(targetId) && targetId > 0)) {
    return res.status(400).json({ error: "Pick a material, mark the silo refillable, or mark it not stock." });
  }

  // ROUND 168 — capacity in kg, optional. A blank value CLEARS it (a silo with
  // no size shows a level but no percentage); the field being ABSENT from the
  // request leaves whatever was there, so saving a material mapping from a form
  // that has no capacity box never wipes a capacity set elsewhere. A "not stock
  // at all" hopper never carries one — there is nothing to fill. Anything
  // non-numeric or negative is refused rather than silently stored as garbage.
  const capacityProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "capacity_kg");
  let capacityKg = null;
  if (isIgnored) {
    capacityKg = null;
  } else if (capacityProvided) {
    const rawCap = req.body.capacity_kg;
    if (rawCap !== null && String(rawCap).trim() !== "") {
      capacityKg = Number(rawCap);
      if (!Number.isFinite(capacityKg) || capacityKg <= 0) {
        return res.status(400).json({ error: "Capacity must be a number greater than zero, or left blank." });
      }
    }
  } else {
    const { rows: cur } = await query(`SELECT capacity_kg FROM plant_silo_aliases WHERE slot = $1`, [slot]);
    capacityKg = cur.length && cur[0].capacity_kg != null ? Number(cur[0].capacity_kg) : null;
  }

  try {
    if (targetId) {
      const { rows: ok } = await query(`SELECT 1 FROM rm_materials WHERE id = $1`, [targetId]);
      if (!ok.length) return res.status(400).json({ error: "That material no longer exists." });
    }
    await query(
      `INSERT INTO plant_silo_aliases (slot, slot_name, material_id, is_ignored, is_refillable, capacity_kg, mapped_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slot) DO UPDATE SET
         slot_name = EXCLUDED.slot_name, material_id = EXCLUDED.material_id,
         is_ignored = EXCLUDED.is_ignored, is_refillable = EXCLUDED.is_refillable,
         capacity_kg = EXCLUDED.capacity_kg,
         mapped_by = EXCLUDED.mapped_by, mapped_at = now()`,
      [slot, String(req.body?.slot_name || "").slice(0, 60) || null, targetId, isIgnored, isRefillable, capacityKg, req.user.id]
    );
    const touched = await reresolveSilos();
    res.json({ ok: true, slot, rows_updated: touched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the silo mapping." });
  }
});

router.delete("/silos/:id", requireRole(...PLANT_ADMIN), requirePermission("production.plant-mapping", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid mapping id." });
  try {
    const { rowCount } = await query(`DELETE FROM plant_silo_aliases WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Mapping not found." });
    await reresolveSilos();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove the mapping." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 159 — silo fills. What went into a silo, when, and what was left of the
// last lot when it did.
// ---------------------------------------------------------------------------
router.get("/silo-fills", requireRole(...PLANT_ADMIN), requirePermission("production.plant-mapping", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT f.*, m.name AS material_name, u.name AS recorded_by_name,
              r.challan_number, s.name AS supplier_name,
              -- When the next fill replaced this one. Null means it is what the
              -- silo holds now, which is the question people actually ask.
              lead(f.filled_at) OVER (PARTITION BY f.slot ORDER BY f.filled_at) AS until
       FROM plant_silo_fills f
       JOIN rm_materials m ON m.id = f.material_id
       LEFT JOIN users u ON u.id = f.recorded_by
       LEFT JOIN rm_receipts_effective r ON r.id = f.receipt_id
       LEFT JOIN rm_orders o ON o.id = r.order_id
       LEFT JOIN rm_suppliers s ON s.id = o.supplier_id
       ORDER BY f.filled_at DESC
       LIMIT 300`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the silo fills." });
  }
});

router.post("/silo-fills", requireRole(...PLANT_ADMIN), requirePermission("production.plant-mapping", "create"), async (req, res) => {
  const slot = String(req.body?.slot ?? "").trim();
  if (!Object.prototype.hasOwnProperty.call(SLOT_BY_KEY, slot)) return res.status(400).json({ error: "That is not a hopper this plant has." });

  const materialId = Number(req.body?.material_id);
  if (!(Number.isInteger(materialId) && materialId > 0)) {
    return res.status(400).json({ error: "Say which material went into the silo." });
  }
  const qtyKg = Number(req.body?.qty_kg);
  if (!Number.isFinite(qtyKg) || qtyKg <= 0) {
    return res.status(400).json({ error: "Enter how much went in." });
  }
  const filledAt = String(req.body?.filled_at || "").trim();
  if (!filledAt) return res.status(400).json({ error: "Say when the silo was filled." });

  const receiptId = req.body?.receipt_id == null || req.body.receipt_id === ""
    ? null : Number(req.body.receipt_id);
  if (receiptId !== null && !(Number.isInteger(receiptId) && receiptId > 0)) {
    return res.status(400).json({ error: "Invalid receipt." });
  }

  try {
    const { rows: mat } = await query(`SELECT 1 FROM rm_materials WHERE id = $1`, [materialId]);
    if (!mat.length) return res.status(400).json({ error: "That material no longer exists." });

    // What was left of the previous lot. Recorded rather than assumed: a fill
    // on top of a remaining balance is honest about the overlap instead of
    // pretending the silo was clean.
    const { rows: bal } = await query(
      `SELECT COALESCE(sum(f.qty_kg), 0)
              - COALESCE((SELECT sum(pm.actual_kg) FROM plant_batch_materials pm
                           JOIN plant_batches pb ON pb.id = pm.batch_id
                          WHERE pm.slot = $1
                            AND COALESCE(pb.batched_at, pb.batch_date::timestamptz) >= min(f.filled_at)
                            AND COALESCE(pb.batched_at, pb.batch_date::timestamptz) <= $2::timestamptz), 0)
              AS remaining
         FROM plant_silo_fills f WHERE f.slot = $1 AND f.filled_at <= $2::timestamptz`,
      [slot, filledAt]
    );
    const remaining = Number(bal[0]?.remaining ?? 0);
    const wasEmpty = req.body?.was_empty === true ? true
                   : req.body?.was_empty === false ? false
                   : remaining <= 0;

    const { rows } = await query(
      `INSERT INTO plant_silo_fills
         (slot, material_id, receipt_id, filled_at, qty_kg, was_empty, balance_before_kg, notes, recorded_by)
       VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9) RETURNING *`,
      [slot, materialId, receiptId, filledAt, qtyKg, wasEmpty,
       remaining > 0 ? remaining : 0, String(req.body?.notes || "").trim() || null, req.user.id]
    );

    // A fill changes what every batch after it was made from.
    const touched = await reresolveSilos();
    res.status(201).json({ ...rows[0], rows_updated: touched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not record that fill." });
  }
});

router.delete("/silo-fills/:id", requireRole(...PLANT_ADMIN), requirePermission("production.plant-mapping", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid fill id." });
  try {
    const { rowCount } = await query(`DELETE FROM plant_silo_fills WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Fill not found." });
    const touched = await reresolveSilos();
    res.json({ ok: true, rows_updated: touched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove that fill." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 159 — what the plant did NOT record.
//
// The operator enters only the part the load cells never saw, and it is ADDED
// to the automatic figure rather than replacing it. That is what keeps "the
// plant weighed this" a true statement whatever anybody types.
// ---------------------------------------------------------------------------
router.get("/manual", requireRole(...PLANT_READ), requirePermission("production.plant-data", "view"), async (req, res) => {
  try {
    const day = istDay(req.query.date ? new Date(req.query.date) : new Date());
    const [entries, auto, autoProd] = await Promise.all([
      query(
        // to_char, not the bare date: a DATE comes back as a UTC timestamp
        // otherwise, which is the exact round trip behind this app's IST bug
        // every time it has appeared. Round 158 fixed the same thing on the
        // production-by-day query.
        `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
                e.material_id, e.qty_kg, e.qty_m3, e.reason, e.entered_at,
                m.name AS material_name, m.purchase_unit, u.name AS entered_by_name
           FROM plant_manual_entries e
           LEFT JOIN rm_materials m ON m.id = e.material_id
           LEFT JOIN users u ON u.id = e.entered_by
          WHERE e.entry_date = $1::date ORDER BY m.name NULLS FIRST`,
        [day]
      ),
      query(
        `SELECT pm.material_id, m.name AS material_name,
                (array_agg(pm.slot ORDER BY pm.slot))[1] AS slot,
                sum(pm.actual_kg)::numeric AS auto_kg
           FROM plant_batch_materials pm
           JOIN plant_batches pb ON pb.id = pm.batch_id
           LEFT JOIN rm_materials m ON m.id = pm.material_id
          WHERE pb.batch_date = $1::date
          GROUP BY pm.material_id, m.name
          ORDER BY sum(pm.actual_kg) DESC NULLS LAST`,
        [day]
      ),
      query(
        `SELECT COALESCE(sum(batch_qty_m3), 0)::numeric AS auto_m3,
                count(DISTINCT (batch_year, batch_no))::int AS loads,
                count(*)::int AS batches
           FROM plant_batches WHERE batch_date = $1::date`,
        [day]
      ),
    ]);
    res.json({
      date: day,
      consumption: auto.rows,
      production: autoProd.rows[0],
      entries: entries.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the day's entries." });
  }
});

router.post("/manual", requireRole(...PLANT_MANUAL), requirePermission("production.plant-manual", "create"), async (req, res) => {
  const day = String(req.body?.entry_date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "Give the date as YYYY-MM-DD." });

  const isProduction = req.body?.material_id == null || req.body.material_id === "";
  const reason = String(req.body?.reason || "").trim() || null;

  try {
    if (isProduction) {
      const m3 = Number(req.body?.qty_m3);
      if (!Number.isFinite(m3) || m3 < 0) return res.status(400).json({ error: "Enter the m³ the plant did not record." });
      // Zero means "nothing to add" — clearing the row is tidier than storing a
      // zero that has to be explained every time somebody reads the table.
      if (m3 === 0) {
        await query(`DELETE FROM plant_manual_entries WHERE entry_date = $1::date AND material_id IS NULL`, [day]);
        return res.json({ ok: true, cleared: true });
      }
      const { rows } = await query(
        `INSERT INTO plant_manual_entries (entry_date, material_id, qty_m3, reason, entered_by)
         VALUES ($1::date, NULL, $2, $3, $4)
         ON CONFLICT (entry_date, material_id) DO UPDATE SET
           qty_m3 = EXCLUDED.qty_m3, reason = EXCLUDED.reason,
           entered_by = EXCLUDED.entered_by, entered_at = now()
         RETURNING id, to_char(entry_date,'YYYY-MM-DD') AS entry_date, qty_m3, reason`,
        [day, m3, reason, req.user.id]
      );
      return res.json(rows[0]);
    }

    const materialId = Number(req.body.material_id);
    if (!(Number.isInteger(materialId) && materialId > 0)) return res.status(400).json({ error: "Invalid material." });
    const kg = Number(req.body?.qty_kg);
    if (!Number.isFinite(kg) || kg < 0) return res.status(400).json({ error: "Enter the kilograms the plant did not record." });
    if (kg === 0) {
      await query(`DELETE FROM plant_manual_entries WHERE entry_date = $1::date AND material_id = $2`, [day, materialId]);
      return res.json({ ok: true, cleared: true });
    }
    const { rows } = await query(
      `INSERT INTO plant_manual_entries (entry_date, material_id, qty_kg, reason, entered_by)
       VALUES ($1::date, $2, $3, $4, $5)
       ON CONFLICT (entry_date, material_id) DO UPDATE SET
         qty_kg = EXCLUDED.qty_kg, reason = EXCLUDED.reason,
         entered_by = EXCLUDED.entered_by, entered_at = now()
       RETURNING id, to_char(entry_date,'YYYY-MM-DD') AS entry_date, material_id, qty_kg, reason`,
      [day, materialId, kg, reason, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save that entry." });
  }
});

/* =========================================================================
 * ROUND 160 — the QC delay allowance behind the ticket's finish time.
 *
 * BPR107a.xlsm used to compute the finish time itself. That formula is gone,
 * so MixTrack writes cell K21, and what it writes is the plant's own end time
 * plus an allowance: plant QC procedure runs on past the mixer finishing, and
 * the ticket should say when the load was released rather than when the last
 * batch dropped.
 *
 * Per site OR per customer, and site wins when both exist — the delay belongs
 * to the pour, not to whoever is paying for it. A row with neither set is the
 * plant-wide default, of which the unique indexes permit exactly one.
 *
 * Administrator to change, Manager to read. This moves a time printed on a
 * document that goes to a customer, which makes it a settings decision rather
 * than a shift-floor one — deliberately NOT the Plant Operator's, unlike the
 * manual entry endpoints above.
 * ===================================================================== */

const QC_DELAY_READ = ["administrator", "manager"];

router.get("/qc-delays", requireRole(...QC_DELAY_READ), requirePermission("production.mixtrack-qc-delay", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT q.id, q.customer_id, q.site_id, q.delay_minutes, q.note,
            to_char(q.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS updated_at,
            c.name AS customer_name, s.name AS site_name, u.name AS updated_by_name
       FROM mixtrack_qc_delays q
       LEFT JOIN customers c ON c.id = q.customer_id
       LEFT JOIN sites s ON s.id = q.site_id
       LEFT JOIN users u ON u.id = q.updated_by
      ORDER BY (q.site_id IS NULL AND q.customer_id IS NULL), s.name NULLS LAST, c.name NULLS LAST`
  );
  res.json(rows);
});

router.post("/qc-delays", requireRole(...PLANT_ADMIN), requirePermission("production.mixtrack-qc-delay", "create"), async (req, res) => {
  const { customer_id, site_id, delay_minutes, note } = req.body || {};
  const mins = Number(delay_minutes);
  if (!Number.isFinite(mins) || mins < 0 || mins > 240) {
    return res.status(400).json({ error: "The allowance must be between 0 and 240 minutes." });
  }
  // Both set is refused rather than silently resolved. A row that names a
  // customer AND a site reads as "this customer at this site", which is not
  // what the lookup does, and a rule that does not mean what it says is worse
  // than no rule.
  if (customer_id && site_id) {
    return res.status(400).json({ error: "Set the allowance against a site or a customer, not both." });
  }
  const { rows } = await query(
    `INSERT INTO mixtrack_qc_delays (customer_id, site_id, delay_minutes, note, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING
     RETURNING id, customer_id, site_id, delay_minutes`,
    [customer_id || null, site_id || null, Math.round(mins), note || null, req.user.id]
  );
  if (!rows.length) {
    // The unique indexes caught an existing rule for the same target, so this
    // is an edit rather than a new rule.
    const { rows: updated } = await query(
      `UPDATE mixtrack_qc_delays
          SET delay_minutes = $3, note = $4, updated_by = $5, updated_at = now()
        WHERE (site_id IS NOT DISTINCT FROM $2) AND (customer_id IS NOT DISTINCT FROM $1)
        RETURNING id, customer_id, site_id, delay_minutes`,
      [customer_id || null, site_id || null, Math.round(mins), note || null, req.user.id]
    );
    return res.json(updated[0] || null);
  }
  res.status(201).json(rows[0]);
});

router.delete("/qc-delays/:id", requireRole(...PLANT_ADMIN), requirePermission("production.mixtrack-qc-delay", "edit"), async (req, res) => {
  await query(`DELETE FROM mixtrack_qc_delays WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.post("/recheck", requireRole(...PLANT_ADMIN), requirePermission("production.plant-mapping", "edit"), async (req, res) => {
  try {
    const touched = await reresolveSilos();
    res.json({ ok: true, rows_updated: touched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not re-check the silos." });
  }
});

export default router;
