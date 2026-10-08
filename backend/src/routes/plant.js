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
import bcrypt from "bcryptjs";
import { pool, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requirePermission, requireAnyPermission } from "../lib/permissions.js";
import { PLANT_SLOTS, SLOT_BY_KEY, RECIPE_TARGET_COLUMNS, normaliseSlot, isPlaceholderName } from "../lib/plantSlots.js";
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

    // Round 189 — new or changed batches on a refillable silo are re-charged
    // first-in-first-out (insert time used the latest fill, the old rule).
    // Best effort: a failure here must not fail the sync, the next one redoes it.
    if (inserted + updated > 0) {
      try {
        const { rows: refill } = await query(`SELECT slot FROM plant_silo_aliases WHERE is_refillable`);
        for (const r of refill) await fifoResolveSlot(r.slot);
      } catch (e) { console.error("FIFO re-attribution after sync failed", e.message); }
    }

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
      // ROUND 174 — don't let an incoming read-sync overwrite a recipe that has
      // an edit waiting to be written to the plant. The app copy already holds
      // the edited values; until the agent applies the change to MCI370 and the
      // next sync carries the new values back, the plant still reports the OLD
      // numbers, which would otherwise clobber the edit. Skip it this cycle.
      const { rows: pend } = await client.query(
        `SELECT 1 FROM plant_recipe_edits e JOIN plant_recipes p ON p.id = e.recipe_id
          WHERE p.recipe_code = $1 AND e.status IN ('pending','claimed') LIMIT 1`, [code]);
      if (pend.length) { unchanged++; continue; }
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

// ROUND 174 — the write-back queue the agent drains. An editable recipe FIELD
// maps to its MCI370 Recipe_Master column here; targets map via
// RECIPE_TARGET_COLUMNS. cost/w-c are computed, and Recipe_Code is handled as a
// rename, so none of those are in this set.
const RECIPE_FIELD_COLUMNS = {
  recipe_name: "Recipe_Name",
  strength: "Strength",
  consistancy: "Consistancy",
  mixing_time: "Mixing_Time",
  mixer_capacity: "Mixer_Capacity",
  mass_weight: "mass_weight",
  premix_time: "PreMixTime",
  dry_mix_time: "Dry_Mix_Time",
  drymix_pct: "DryMix_in_Perc",
  wetmix_pct: "WetMix_in_perc",
  water_ice_pct: "water_ice_percent",
  water_slurry_pct: "water_slurry_percent",
  cement_water_pct: "cement_water_Percentage",
  cement_filler_pct: "cement_filler_percentage",
};

// MCI370 stores its modify date/time as free text; match its own format so its
// screens read naturally (e.g. "10/1/2026", "2:05:11 PM"), in IST.
function mci370Now() {
  const d = new Date();
  const date = d.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", day: "numeric", month: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  return { date, time };
}

// The agent claims pending edits here (and re-claims any stuck >10 min), gets a
// ready-to-write column→value set, applies them to MCI370, then reports via
// /recipes/write-result. Agent-authenticated, like /sync.
router.get("/recipes/pending-writes", async (req, res) => {
  if (!agentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });
  try {
    const { rows: claimed } = await query(
      `UPDATE plant_recipe_edits
          SET status = 'claimed', claimed_at = now()
        WHERE id IN (
          SELECT id FROM plant_recipe_edits
           WHERE status = 'pending' OR (status = 'claimed' AND claimed_at < now() - interval '10 minutes')
           ORDER BY edited_at
           LIMIT 25 FOR UPDATE SKIP LOCKED)
        RETURNING id, recipe_code, after_json, is_code_rename, old_recipe_code, new_recipe_code, edited_by`
    );
    if (!claimed.length) return res.json({ writes: [] });
    const userIds = [...new Set(claimed.map((e) => e.edited_by).filter(Boolean))];
    const names = new Map();
    if (userIds.length) {
      const { rows: us } = await query(`SELECT id, name FROM users WHERE id = ANY($1)`, [userIds]);
      for (const u of us) names.set(u.id, u.name);
    }
    const stamp = mci370Now();
    const writes = claimed.map((e) => {
      const after = e.after_json || {};
      const set = {};
      for (const [f, col] of Object.entries(RECIPE_FIELD_COLUMNS)) {
        if (after.fields && Object.prototype.hasOwnProperty.call(after.fields, f) && after.fields[f] != null) {
          set[col] = after.fields[f];
        }
      }
      // Every target column, 0 for a slot turned off, so the plant mirrors the app exactly.
      for (const [slot, col] of Object.entries(RECIPE_TARGET_COLUMNS)) {
        set[col] = after.targets && after.targets[slot] != null ? Number(after.targets[slot]) : 0;
      }
      set.Modifier_Name = (e.edited_by && names.get(e.edited_by)) || "App";
      set.Modified_User_Level = "App (QC)";
      set.Modified_Date = stamp.date;
      set.Modified_Time = stamp.time;
      return {
        edit_id: e.id,
        where_recipe_code: e.is_code_rename ? e.old_recipe_code : e.recipe_code,
        rename_to: e.is_code_rename ? e.new_recipe_code : null,
        set,
      };
    });
    res.json({ writes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load pending recipe writes." });
  }
});

router.post("/recipes/write-result", async (req, res) => {
  if (!agentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });
  const results = Array.isArray(req.body?.results) ? req.body.results : null;
  if (!results) return res.status(400).json({ error: "Send { results: [{edit_id, ok, error}] }." });
  try {
    for (const r of results) {
      const id = Number(r.edit_id);
      if (!Number.isInteger(id)) continue;
      if (r.ok) {
        await query(`UPDATE plant_recipe_edits SET status='applied', applied_at=now(), agent_error=NULL WHERE id=$1 AND status IN ('pending','claimed')`, [id]);
      } else {
        await query(`UPDATE plant_recipe_edits SET status='failed', agent_error=$2 WHERE id=$1 AND status IN ('pending','claimed')`,
          [id, String(r.error || "write failed").slice(0, 500)]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not record write results." });
  }
});

router.use(requireAuth);

const PLANT_ROLES = ["administrator", "manager", "store", "plant_operator", "qc_engineer", "lab_technician"];
const PLANT_ADMIN = ["administrator"];
// Reading the day's figures is the same audience as the rest of the plant data.
const PLANT_READ = PLANT_ROLES;
// Entering what the plant did not record is the Plant Operator's job — they are
// the person who knows a hand mix happened. Administrator too, for corrections.
const PLANT_MANUAL = ["administrator", "plant_operator"];
// Round 192 — the plant's recipes and mix designs are read by Plant Production
// AND by Quality Control's Mix Designs & Recipes screen. Either module's key
// opens them, so denying one module does not break the other.
const MIX_READ = ["production.plant-data", "quality.mix-designs-view"];

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
router.get("/summary", requirePermission("plant.kpi", "view"), async (req, res) => {
  try {
    // CURRENT_DATE is the IST day — db.js pins every connection to
    // Asia/Kolkata. Doing this in JavaScript would give the UTC day and be
    // wrong between midnight and 05:30 every morning.
    const [today, last, unmapped, manualToday] = await Promise.all([
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
      // Round 188 (v10.17 #1) — "Made today" includes what the operator
      // entered by hand for today, as every other production figure does.
      query(
        `SELECT COALESCE(sum(qty_m3), 0)::numeric AS m3 FROM plant_manual_entries
          WHERE entry_date = CURRENT_DATE AND material_id IS NULL`
      ),
    ]);
    const autoToday = Number(today.rows[0].m3) || 0;
    const manualTodayM3 = Number(manualToday.rows[0].m3) || 0;
    res.json({
      today_m3: Math.round((autoToday + manualTodayM3) * 1000) / 1000,
      today_auto_m3: autoToday,
      today_manual_m3: manualTodayM3,
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
router.get("/production", requirePermission("plant.production", "view"), async (req, res) => {
  try {
    const rng = dateRange(req, "batch_date");
    const rngE = dateRange(req, "entry_date");   // plant_manual_entries
    const [byDay, byRecipe, manualDay, manualTot] = await Promise.all([
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
      // Round 184 (#5) — operator-entered manual production (material_id IS NULL),
      // so manual m³ shows in Production, not just in cost calculations.
      query(
        `SELECT to_char(entry_date, 'YYYY-MM-DD') AS batch_date, sum(qty_m3)::numeric AS m3
           FROM plant_manual_entries
          WHERE ${rngE.sql} AND material_id IS NULL
          GROUP BY entry_date`,
        rngE.params
      ),
      // Round 188 — the manual rows themselves, with their per-recipe split
      // (recipe_lines), so manual m3 lands on its recipe in "By recipe".
      query(
        `SELECT qty_m3, recipe_lines FROM plant_manual_entries
          WHERE ${rngE.sql} AND material_id IS NULL`,
        rngE.params
      ),
    ]);

    // Fold manual production into the per-day totals (and add days that had only
    // a manual entry). m3 is the combined figure; manual_m3 is kept for the note.
    const dayMap = new Map();
    for (const r of byDay.rows) {
      dayMap.set(r.batch_date, { batch_date: r.batch_date, auto_m3: Number(r.m3) || 0, manual_m3: 0, batches: r.batches, loads: r.loads });
    }
    for (const r of manualDay.rows) {
      const cur = dayMap.get(r.batch_date) || { batch_date: r.batch_date, auto_m3: 0, manual_m3: 0, batches: 0, loads: 0 };
      cur.manual_m3 += Number(r.m3) || 0;
      dayMap.set(r.batch_date, cur);
    }
    const by_day = [...dayMap.values()]
      .map((d) => ({ ...d, m3: Math.round((d.auto_m3 + d.manual_m3) * 1000) / 1000 }))
      .sort((a, b) => (a.batch_date < b.batch_date ? 1 : -1));

    // Round 188 (v10.17 #2/#3) — manual m3 is split onto its recipe where the
    // operator entered it by recipe; whatever was entered without a recipe
    // stays on one "(manual, no recipe)" line. Each recipe row carries its
    // auto and manual parts so the card can show both.
    const recipeMap = new Map();
    for (const r of byRecipe.rows) {
      recipeMap.set(r.recipe_code, { recipe_code: r.recipe_code, recipe_name: r.recipe_name, auto_m3: Number(r.m3) || 0, manual_m3: 0, loads: r.loads });
    }
    let manualM3 = 0, unassigned = 0;
    for (const e of manualTot.rows) {
      const m3 = Number(e.qty_m3) || 0;
      manualM3 += m3;
      let assigned = 0;
      for (const ln of Array.isArray(e.recipe_lines) ? e.recipe_lines : []) {
        const code = String(ln?.recipe_code || "").trim();
        const q = Number(ln?.m3) || 0;
        if (!code || q <= 0) continue;
        const cur = recipeMap.get(code) || { recipe_code: code, recipe_name: null, auto_m3: 0, manual_m3: 0, loads: 0 };
        cur.manual_m3 += q;
        recipeMap.set(code, cur);
        assigned += q;
      }
      unassigned += Math.max(0, m3 - assigned);
    }
    if (unassigned > 0.0005) recipeMap.set("(manual)", { recipe_code: "(manual)", recipe_name: "no recipe given", auto_m3: 0, manual_m3: unassigned, loads: 0 });
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const by_recipe = [...recipeMap.values()]
      .map((r) => ({ ...r, auto_m3: r3(r.auto_m3), manual_m3: r3(r.manual_m3), m3: r3(r.auto_m3 + r.manual_m3) }))
      .sort((a, b) => b.m3 - a.m3);
    manualM3 = r3(manualM3);

    const autoM3 = r3(by_day.reduce((t, d) => t + d.auto_m3, 0));
    const totals = {
      auto_m3: autoM3, manual_m3: manualM3, total_m3: r3(autoM3 + manualM3),
      loads: by_day.reduce((t, d) => t + (d.loads || 0), 0),
      batches: by_day.reduce((t, d) => t + (d.batches || 0), 0),
      days: by_day.length,
    };

    res.json({ by_day, by_recipe, manual_m3: manualM3, totals });
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
router.get("/consumption", requirePermission("plant.consumption", "view"), async (req, res) => {
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
    const rngE = dateRange(req, "e.entry_date");   // plant_manual_entries
    const rngT = dateRange(req, "t.transfer_date"); // plant_consumption_transfers
    const [{ rows: prod }, { rows: prodManual }, { rows: manualCons }, { rows: transfers }] = await Promise.all([
      query(
        `SELECT COALESCE(sum(batch_qty_m3), 0)::numeric AS m3
         FROM plant_batches pb WHERE ${rng.sql}`,
        rng.params
      ),
      // Round 184 (#5) — manual production m³ (so total m³ matches Production).
      query(
        `SELECT COALESCE(sum(e.qty_m3), 0)::numeric AS m3 FROM plant_manual_entries e
          WHERE ${rngE.sql} AND e.material_id IS NULL`,
        rngE.params
      ),
      // Operator-entered manual consumption, per material (no silo), so it shows
      // in Consumption too — not only in cost calculations.
      query(
        `SELECT e.material_id, m.name AS material_name, sum(e.qty_kg)::numeric AS actual_kg
           FROM plant_manual_entries e JOIN rm_materials m ON m.id = e.material_id
          WHERE ${rngE.sql} AND e.material_id IS NOT NULL
          GROUP BY e.material_id, m.name
          ORDER BY sum(e.qty_kg) DESC`,
        rngE.params
      ),
      // Round 189 — Admin's consumption transfers in the period, so the screen
      // shows "transferred in / out" beside what the plant weighed.
      query(
        `SELECT t.id, to_char(t.transfer_date, 'YYYY-MM-DD') AS transfer_date, t.qty_kg, t.reason,
                fm.name AS from_name, tm.name AS to_name
           FROM plant_consumption_transfers t
           JOIN rm_materials fm ON fm.id = t.from_material_id
           JOIN rm_materials tm ON tm.id = t.to_material_id
          WHERE ${rngT.sql}
          ORDER BY t.transfer_date DESC, t.id DESC`,
        rngT.params
      ),
    ]);
    res.json({
      silos: rows,
      manual: manualCons,
      transfers,
      total_m3: Math.round((Number(prod[0].m3) + Number(prodManual[0].m3)) * 1000) / 1000,
    });
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
// Round 193 — the cost groups the owner asked for. A material's mix component
// (set on the Materials master, used by the mix-vs-actual report) decides it;
// without one, its category and then its name are read for the usual words.
const COST_GROUPS = ["Cement", "Aggregate", "Admixture", "Water", "Other"];
function costGroupOf(m) {
  const mc = String(m.mix_component || "");
  if (mc === "cement" || mc === "fly_ash") return "Cement";
  if (mc === "fine_agg" || mc.startsWith("coarse")) return "Aggregate";
  if (mc === "admixture") return "Admixture";
  const text = `${m.category || ""} ${m.name || ""}`.toLowerCase();
  if (/cement|opc|ppc|psc|fly\s*ash|ggbs|binder|micro\s*silica/.test(text)) return "Cement";
  if (/admix|chemical|plasticiser|plasticizer|retarder|accelerator/.test(text)) return "Admixture";
  if (/aggregate|sand|m\s*sand|\d+\s*mm|gsb|metal|stone|chips|dust/.test(text)) return "Aggregate";
  if (/water/.test(text)) return "Water";
  return "Other";
}

router.get("/cost-per-m3", requirePermission("plant.cost", "view"), async (req, res) => {
  try {
    const rngB = dateRange(req, "pb.batch_date");     // plant_batch_materials via its batch
    const rngE = dateRange(req, "e.entry_date");       // plant_manual_entries
    const rngT = dateRange(req, "t.transfer_date");    // plant_consumption_transfers (Round 189)
    const [auto, manual, prodAuto, prodManual, rates, mats, transfers] = await Promise.all([
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
      query(`SELECT id, name, opening_stock_rate_per_kg, category, mix_component FROM rm_materials WHERE is_active = true`),
      query(
        `SELECT material_id, sum(kg)::numeric AS kg FROM (
            SELECT t.from_material_id AS material_id, -t.qty_kg AS kg FROM plant_consumption_transfers t WHERE ${rngT.sql}
            UNION ALL
            SELECT t.to_material_id, t.qty_kg FROM plant_consumption_transfers t WHERE ${rngT.sql}
         ) x GROUP BY material_id`, rngT.params),
    ]);

    const producedM3 = Number(prodAuto.rows[0].m3) + Number(prodManual.rows[0].m3);
    const rateBy = new Map(rates.rows.map((r) => [r.material_id, r.rate == null ? null : Number(r.rate)]));
    const consumed = new Map();
    for (const r of auto.rows) consumed.set(r.material_id, Number(r.kg));
    for (const r of manual.rows) consumed.set(r.material_id, (consumed.get(r.material_id) || 0) + Number(r.kg));
    for (const r of transfers.rows) consumed.set(r.material_id, (consumed.get(r.material_id) || 0) + Number(r.kg));

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
        group: costGroupOf(m),
      });
    }
    rows.sort((a, b) => (b.cost_per_m3 || 0) - (a.cost_per_m3 || 0));
    for (const r of rows) r.share_pct = totalCostPerM3 > 0 && r.cost_per_m3 != null ? Math.round((r.cost_per_m3 / totalCostPerM3) * 1000) / 10 : null;
    // Round 193 — grouped into Cement / Aggregate / Admixture (then Water and
    // Other), each with its subtotal, in that fixed order.
    const groups = COST_GROUPS.map((g) => {
      const items = rows.filter((r) => r.group === g);
      const cost = items.reduce((t, r) => t + (r.cost_per_m3 || 0), 0);
      return {
        group: g, rows: items,
        consumed_kg: Math.round(items.reduce((t, r) => t + r.consumed_kg, 0) * 100) / 100,
        cost_per_m3: Math.round(cost * 100) / 100,
        share_pct: totalCostPerM3 > 0 ? Math.round((cost / totalCostPerM3) * 1000) / 10 : null,
      };
    }).filter((g) => g.rows.length);

    res.json({
      produced_m3: Math.round(producedM3 * 100) / 100,
      total_cost_per_m3: Math.round(totalCostPerM3 * 100) / 100,
      total_material_cost: Math.round(totalCostPerM3 * producedM3 * 100) / 100,
      rows,
      groups,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not compute cost per m³." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 169 — the Mix Designs page (item 7a). Three read-only views of the
// ---------------------------------------------------------------------------
// ROUND 179 (#4) — Plant vs billed production. What the batching plant actually
// MADE (plant_batches batched m³ + manual production entries) against what was
// BILLED/DELIVERED on customer challans (delivery_tickets.loaded_quantity_m3),
// over the selected period, per day and in total. Read-only; m³ only (no money),
// so the same plant-data audience may see it. The gap is over-batching / wash-out
// / returns / unbilled or unrecorded loads — a figure worth watching, not a
// reconciliation that must zero.
// ---------------------------------------------------------------------------
router.get("/production-vs-billed", requirePermission("plant.vs-billed", "view"), async (req, res) => {
  // Round 187 kept this from the Plant Operator by a role check here. Round
  // 192 made it the plant.vs-billed key, which the Plant Operator does not get
  // by default — same result, but a Super Admin can now change it.
  try {
    // One date filter, applied to each source's own date column so the three
    // share a single param set (dateRange() can't, since each call restarts $1).
    const from = ISO_DATE.test(req.query.from_date || "") ? req.query.from_date : null;
    const to = ISO_DATE.test(req.query.to_date || "") ? req.query.to_date : null;
    let params, cond;
    if (from && to) { params = [from, to]; cond = (col) => `${col} BETWEEN $1::date AND $2::date`; }
    else { const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400); params = [days]; cond = (col) => `${col} >= CURRENT_DATE - ($1::int - 1)`; }

    const { rows } = await query(
      `WITH p AS (
         SELECT pb.batch_date AS d, sum(pb.batch_qty_m3) AS m3
           FROM plant_batches pb WHERE ${cond("pb.batch_date")} GROUP BY pb.batch_date
       ), pm AS (
         SELECT e.entry_date AS d, sum(e.qty_m3) AS m3
           FROM plant_manual_entries e WHERE ${cond("e.entry_date")} AND e.material_id IS NULL GROUP BY e.entry_date
       ), b AS (
         -- Billed = delivery challans created, INCLUDING rejected, EXCLUDING
         -- cancelled — same rule as the daily production report (dt.status !=
         -- 'cancelled'), so the two figures agree.
         SELECT dt.ticket_date AS d, sum(dt.loaded_quantity_m3) AS m3, count(*) AS n
           FROM delivery_tickets dt
          WHERE ${cond("dt.ticket_date")} AND dt.status <> 'cancelled'
          GROUP BY dt.ticket_date
       ), days AS (SELECT d FROM p UNION SELECT d FROM pm UNION SELECT d FROM b)
       SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
              COALESCE(p.m3, 0) + COALESCE(pm.m3, 0) AS plant_m3,
              COALESCE(b.m3, 0) AS billed_m3,
              COALESCE(b.n, 0)::int AS tickets
         FROM days
         LEFT JOIN p  ON p.d  = days.d
         LEFT JOIN pm ON pm.d = days.d
         LEFT JOIN b  ON b.d  = days.d
        ORDER BY days.d DESC`,
      params
    );

    let plantM3 = 0, billedM3 = 0, tickets = 0;
    const byDay = rows.map((r) => {
      const plant = Number(r.plant_m3) || 0, billed = Number(r.billed_m3) || 0;
      plantM3 += plant; billedM3 += billed; tickets += Number(r.tickets) || 0;
      return { day: r.day, plant_m3: Math.round(plant * 100) / 100, billed_m3: Math.round(billed * 100) / 100, difference_m3: Math.round((plant - billed) * 100) / 100, tickets: Number(r.tickets) || 0 };
    });
    plantM3 = Math.round(plantM3 * 100) / 100; billedM3 = Math.round(billedM3 * 100) / 100;
    res.json({
      rows: byDay,
      totals: {
        plant_m3: plantM3,
        billed_m3: billedM3,
        difference_m3: Math.round((plantM3 - billedM3) * 100) / 100,
        difference_pct: billedM3 > 0 ? Math.round(((plantM3 - billedM3) / billedM3) * 1000) / 10 : null,
        tickets,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the plant-vs-billed comparison." });
  }
});

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

router.get("/mix-designs", requireAnyPermission(MIX_READ, "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT d.id, d.design_ref_code, d.mix_description, d.revision, d.status, d.is_standard_for_grade,
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

router.get("/mix-designs-comparison", requireAnyPermission(MIX_READ, "view"), async (req, res) => {
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

router.get("/mix-designs/:id", requireAnyPermission(MIX_READ, "view"), async (req, res) => {
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
    // Round 178 — the recipes mapped to this mix design (many-to-many).
    const { rows: mappedRecipes } = await query(
      `SELECT r.id AS recipe_id, r.recipe_code, r.recipe_name
         FROM recipe_mix_design_map map
         JOIN plant_recipes r ON r.id = map.recipe_id
        WHERE map.mix_design_id = $1
        ORDER BY r.recipe_code`, [id]);
    res.json({ design: rows[0], admixtures: adm, mapped_recipes: mappedRecipes });
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
router.get("/mix-designs/:id/costing", requirePermission("material.stock-valuation", "view"), async (req, res) => {
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

router.get("/recipes", requireAnyPermission(MIX_READ, "view"), async (req, res) => {
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

router.get("/recipes/:id", requireAnyPermission(MIX_READ, "view"), async (req, res) => {
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
    // Every slot a recipe CAN carry (not just the ones in use), so the edit
    // form can switch a slot on by giving it a weight. Current target is 0 when
    // the slot is off. Only slots with a Recipe_Master target column appear.
    const editableSlots = Object.keys(RECIPE_TARGET_COLUMNS).map((slot) => ({
      slot,
      slot_label: SLOT_BY_KEY[slot]?.label || slot,
      kind: SLOT_BY_KEY[slot]?.kind || null,
      plant_name: nameBySlot.get(slot) || null,
      target: tgtBySlot.get(slot) || 0,
      material_name: slotMat.get(slot) ? rateLk.name(slotMat.get(slot)) : null,
    }));
    const { rows: le } = await query(
      `SELECT e.id, e.status, e.edited_at, e.applied_at, e.agent_error, e.is_code_rename,
              e.old_recipe_code, e.new_recipe_code, u.name AS edited_by_name
         FROM plant_recipe_edits e LEFT JOIN users u ON u.id = e.edited_by
        WHERE e.recipe_id = $1 ORDER BY e.edited_at DESC LIMIT 5`, [id]);
    // Round 178 — the mix designs mapped to this recipe (many-to-many).
    const { rows: mappedDesigns } = await query(
      `SELECT d.id AS mix_design_id, d.design_ref_code, d.revision, d.mix_description, g.name AS grade
         FROM recipe_mix_design_map map
         JOIN mix_designs d ON d.id = map.mix_design_id
         JOIN mix_grades g ON g.id = d.mix_grade_id
        WHERE map.recipe_id = $1
        ORDER BY g.name, d.design_ref_code`, [id]);
    res.json({
      recipe: {
        ...recipe,
        binder_kg: Math.round(binder * 100) / 100,
        water_kg: Math.round(water * 100) / 100,
        wc_ratio: binder > 0 ? Math.round((water / binder) * 1000) / 1000 : null,
      },
      targets: lines,
      editable_slots: editableSlots,
      cost_per_m3: Math.round(cost * 100) / 100,
      cost_incomplete: anyUnpriced,
      recent_edits: le,
      pending_write: le.some((e) => e.status === "pending" || e.status === "claimed"),
      mapped_designs: mappedDesigns,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the recipe." });
  }
});

// Round 178 — lab_technician added so a Super Admin can give recipe-master
// editing to the lab as well as QC. The two-guard design couples the role
// allow-list with a default grant (check-guards enforces it), so lab is granted
// by default here and in the catalogue; the Super Admin can revoke it for the
// whole lab role or per lab user on the Access Control page, and the plant-wide
// edit password is still required on every change.
// NOTE (Round 181 hotfix): this const MUST be declared before the routes that
// use it below — a `const` sits in the temporal dead zone until this line runs,
// so registering a route with `...RECIPE_EDIT_ROLES` above it throws at startup
// ("Cannot access 'RECIPE_EDIT_ROLES' before initialization").
const RECIPE_EDIT_ROLES = ["administrator", "manager", "qc_engineer", "lab_technician"];

// ---------------------------------------------------------------------------
// ROUND 178 — Recipe <-> Mix Design mapping (many-to-many). Editable from either
// side on the Mix Designs & Recipes screen. App-only metadata — nothing is
// written to MCI370 — so no edit-password gate; gated by the same role/permission
// that may edit recipes (production.recipe-edit edit).
// ---------------------------------------------------------------------------
router.post("/recipe-design-map", requirePermission("production.recipe-edit", "edit"), async (req, res) => {
  const recipeId = Number(req.body.recipe_id);
  const designId = Number(req.body.mix_design_id);
  if (!(Number.isInteger(recipeId) && recipeId > 0) || !(Number.isInteger(designId) && designId > 0)) {
    return res.status(400).json({ error: "A recipe and a mix design are both required." });
  }
  try {
    const [{ rows: r }, { rows: d }] = await Promise.all([
      query(`SELECT 1 FROM plant_recipes WHERE id = $1`, [recipeId]),
      query(`SELECT 1 FROM mix_designs WHERE id = $1`, [designId]),
    ]);
    if (!r.length) return res.status(404).json({ error: "Recipe not found." });
    if (!d.length) return res.status(404).json({ error: "Mix design not found." });
    await query(
      `INSERT INTO recipe_mix_design_map (recipe_id, mix_design_id, created_by)
       VALUES ($1,$2,$3) ON CONFLICT (recipe_id, mix_design_id) DO NOTHING`,
      [recipeId, designId, req.user.id]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not map the recipe and mix design." });
  }
});

router.delete("/recipe-design-map", requirePermission("production.recipe-edit", "edit"), async (req, res) => {
  const recipeId = Number(req.query.recipe_id);
  const designId = Number(req.query.mix_design_id);
  if (!(Number.isInteger(recipeId) && recipeId > 0) || !(Number.isInteger(designId) && designId > 0)) {
    return res.status(400).json({ error: "A recipe and a mix design are both required." });
  }
  try {
    await query(`DELETE FROM recipe_mix_design_map WHERE recipe_id = $1 AND mix_design_id = $2`, [recipeId, designId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove the mapping." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 174 — editing a recipe (writes back to MCI370), the edit password, and
// undo. The permission says who may reach the editor; the plant-wide edit
// password (below) is the second key entered on every change.
// (RECIPE_EDIT_ROLES is declared above, before the mapping routes that use it.)
// ---------------------------------------------------------------------------

// Editable recipe fields → their app column + a coercer. cost_per_m3_plant is
// NOT here (the app computes cost); Recipe_Code is handled as a rename.
const RECIPE_EDIT_FIELDS = {
  recipe_name: (v) => (v == null ? null : String(v).slice(0, 100)),
  strength: (v) => NUM(v),
  consistancy: (v) => (v == null || v === "" ? null : String(v).slice(0, 15)),
  mixing_time: (v) => NUM(v),
  mixer_capacity: (v) => NUM(v),
  mass_weight: (v) => NUM(v),
  premix_time: (v) => NUM(v),
  dry_mix_time: (v) => NUM(v),
  drymix_pct: (v) => NUM(v),
  wetmix_pct: (v) => NUM(v),
  water_ice_pct: (v) => NUM(v),
  water_slurry_pct: (v) => NUM(v),
  cement_water_pct: (v) => NUM(v),
  cement_filler_pct: (v) => NUM(v),
};

// Whether a plant-wide edit password has been set. No auth beyond login: the UI
// uses it to show "ask a Super Admin to set the edit password" rather than a
// dead password box.
router.get("/recipes/edit-password/status", async (req, res) => {
  try {
    const { rows } = await query(`SELECT 1 FROM plant_recipe_edit_auth WHERE id = 1`);
    res.json({ is_set: rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not check the edit password." });
  }
});

// Set / reset the plant-wide edit password — Super Admin only.
router.put("/recipes/edit-password", requireRole("super_admin"), async (req, res) => {
  const pw = String(req.body?.password || "");
  if (pw.length < 4) return res.status(400).json({ error: "Choose an edit password of at least 4 characters." });
  try {
    const hash = await bcrypt.hash(pw, 10);
    await query(
      `INSERT INTO plant_recipe_edit_auth (id, password_hash, updated_by, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not set the edit password." });
  }
});

async function checkEditPassword(given) {
  const { rows } = await query(`SELECT password_hash FROM plant_recipe_edit_auth WHERE id = 1`);
  if (!rows.length) return { ok: false, status: 400, error: "No edit password is set. Ask a Super Admin to set it first." };
  const match = await bcrypt.compare(String(given || ""), rows[0].password_hash);
  if (!match) return { ok: false, status: 403, error: "That edit password is not correct." };
  return { ok: true };
}

// Snapshot a recipe's current fields + targets, for the undo record.
async function snapshotRecipe(recipeId) {
  const { rows } = await query(`SELECT * FROM plant_recipes WHERE id = $1`, [recipeId]);
  if (!rows.length) return null;
  const { rows: tg } = await query(`SELECT slot, target FROM plant_recipe_targets WHERE recipe_id = $1`, [recipeId]);
  const fields = {};
  for (const f of Object.keys(RECIPE_EDIT_FIELDS)) fields[f] = rows[0][f];
  const targets = {};
  for (const t of tg) targets[t.slot] = Number(t.target);
  return { recipe_code: rows[0].recipe_code, fields, targets };
}

// Apply an after-snapshot (fields + targets [+ optional new code]) to the app
// copy and queue the write-back. Shared by edit and revert.
async function applyRecipeEdit({ recipeId, after, note, userId, revertsEditId }) {
  const before = await snapshotRecipe(recipeId);
  if (!before) throw new Error("recipe gone");
  const isRename = !!(after.new_recipe_code && after.new_recipe_code !== before.recipe_code);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Fields
    const sets = [], vals = [];
    let i = 1;
    for (const [f, coerce] of Object.entries(RECIPE_EDIT_FIELDS)) {
      if (after.fields && Object.prototype.hasOwnProperty.call(after.fields, f)) {
        sets.push(`${f} = $${i++}`); vals.push(coerce(after.fields[f]));
      }
    }
    if (isRename) { sets.push(`recipe_code = $${i++}`); vals.push(after.new_recipe_code); }
    if (sets.length) {
      vals.push(recipeId);
      await client.query(`UPDATE plant_recipes SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    }
    // Targets — replace with the non-zero set from `after.targets`.
    await client.query(`DELETE FROM plant_recipe_targets WHERE recipe_id = $1`, [recipeId]);
    for (const [slot, v] of Object.entries(after.targets || {})) {
      if (!SLOT_BY_KEY[slot]) continue;
      const t = Number(v);
      if (!Number.isFinite(t) || t <= 0) continue;
      await client.query(`INSERT INTO plant_recipe_targets (recipe_id, slot, target) VALUES ($1,$2,$3)`, [recipeId, slot, t]);
    }
    const { rows: er } = await client.query(
      `INSERT INTO plant_recipe_edits
         (recipe_id, recipe_code, before_json, after_json, is_code_rename, old_recipe_code, new_recipe_code,
          status, note, edited_by, reverts_edit_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10) RETURNING id`,
      [recipeId, before.recipe_code, JSON.stringify(before),
       JSON.stringify({ fields: after.fields || {}, targets: after.targets || {}, new_recipe_code: isRename ? after.new_recipe_code : null }),
       isRename, isRename ? before.recipe_code : null, isRename ? after.new_recipe_code : null,
       note || null, userId || null, revertsEditId || null]
    );
    const newEditId = er[0].id;
    await client.query("COMMIT");
    return newEditId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

router.patch("/recipes/:id", requirePermission("production.recipe-edit", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid recipe id." });
  const pw = await checkEditPassword(req.body?.edit_password);
  if (!pw.ok) return res.status(pw.status).json({ error: pw.error });
  try {
    const { rows } = await query(`SELECT id, recipe_code FROM plant_recipes WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Recipe not found." });

    // A rename must land on a code no other recipe already uses.
    const newCode = req.body?.new_recipe_code ? String(req.body.new_recipe_code).trim() : null;
    if (newCode && newCode !== rows[0].recipe_code) {
      const { rows: clash } = await query(`SELECT 1 FROM plant_recipes WHERE recipe_code = $1 AND id <> $2`, [newCode, id]);
      if (clash.length) return res.status(400).json({ error: `Recipe code "${newCode}" is already in use.` });
    }
    // Validate target values up front.
    const targets = req.body?.targets && typeof req.body.targets === "object" ? req.body.targets : {};
    for (const [slot, v] of Object.entries(targets)) {
      if (!SLOT_BY_KEY[slot]) return res.status(400).json({ error: `Unknown slot "${slot}".` });
      if (v !== "" && v != null && !(Number(v) >= 0)) return res.status(400).json({ error: `Target for ${slot} must be zero or more.` });
    }
    const fields = req.body?.fields && typeof req.body.fields === "object" ? req.body.fields : {};
    const editId = await applyRecipeEdit({
      recipeId: id,
      after: { fields, targets, new_recipe_code: newCode },
      note: req.body?.note,
      userId: req.user.id,
    });
    res.json({ ok: true, edit_id: editId, message: "Saved. Queued to write to the plant — it will show as applied once the agent confirms." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the recipe edit." });
  }
});

// Undo an edit: re-apply its before-snapshot (and queue that to the plant too).
router.post("/recipes/edits/:editId/revert", requirePermission("production.recipe-edit", "edit"), async (req, res) => {
  const editId = Number(req.params.editId);
  if (!(Number.isInteger(editId) && editId > 0)) return res.status(400).json({ error: "Invalid edit id." });
  const pw = await checkEditPassword(req.body?.edit_password);
  if (!pw.ok) return res.status(pw.status).json({ error: pw.error });
  try {
    const { rows } = await query(`SELECT * FROM plant_recipe_edits WHERE id = $1`, [editId]);
    if (!rows.length) return res.status(404).json({ error: "Edit not found." });
    const e = rows[0];
    if (!e.recipe_id) return res.status(400).json({ error: "That recipe no longer exists." });
    const before = e.before_json;
    const newEdit = await applyRecipeEdit({
      recipeId: e.recipe_id,
      after: { fields: before.fields || {}, targets: before.targets || {}, new_recipe_code: e.is_code_rename ? e.old_recipe_code : null },
      note: `Undo of edit #${editId}`,
      userId: req.user.id,
      revertsEditId: editId,
    });
    res.json({ ok: true, edit_id: newEdit, message: "Reverted. Queued to restore on the plant." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not revert that edit." });
  }
});

// Round 182 — discard a QUEUED recipe edit before the agent writes it to MCI370.
// Only an edit still pending (or dry-run-claimed) can be discarded; once applied
// it must be undone with Revert instead. This removes it from the write-back
// queue so turning write-back on never flushes a stale or unwanted edit to the
// live plant database. reverts_edit_id is a self-FK, so any reference to this
// row is cleared first.
router.post("/recipes/edits/:editId/discard", requirePermission("production.recipe-edit", "edit"), async (req, res) => {
  const editId = Number(req.params.editId);
  if (!(Number.isInteger(editId) && editId > 0)) return res.status(400).json({ error: "Invalid edit id." });
  const pw = await checkEditPassword(req.body?.edit_password);
  if (!pw.ok) return res.status(pw.status).json({ error: pw.error });
  try {
    const { rows } = await query(`SELECT id, status FROM plant_recipe_edits WHERE id = $1`, [editId]);
    if (!rows.length) return res.status(404).json({ error: "Edit not found." });
    // A queued edit (pending/claimed) or one whose write FAILED can be discarded
    // — neither reached MCI370. One already applied must be undone with Revert.
    if (!["pending", "claimed", "failed"].includes(rows[0].status)) {
      return res.status(400).json({ error: "Only a queued or failed edit (never written to the plant) can be discarded — one already applied must be undone with Revert." });
    }
    await query(`UPDATE plant_recipe_edits SET reverts_edit_id = NULL WHERE reverts_edit_id = $1`, [editId]);
    await query(`DELETE FROM plant_recipe_edits WHERE id = $1 AND status IN ('pending','claimed','failed')`, [editId]);
    res.json({ ok: true, message: "Discarded — removed from the plant write queue." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not discard that edit." });
  }
});

// The recent loads, batches rolled up.
router.get("/loads", requirePermission("plant.production", "view"), async (req, res) => {
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
// ROUND 189 (v10.18) — first-in-first-out attribution for ONE refillable silo.
//
// Walks the silo's fills and its load-cell draws in time order. Each fill adds
// a layer (its material, its kg); each draw is charged to the material of the
// oldest layer that still has something left, and its kg come off the layers
// from the oldest up. A fill marked "silo was empty" discards whatever the
// layers still held. A draw before any fill has no material (as before); a
// draw after every layer is used up — the silo was under-recorded — takes the
// latest fill's material, which is what the old rule did, so nothing goes
// unattributed.
//
// One plant_batch_materials row carries one material, so a draw that straddles
// two layers is charged whole to the older one. The error is at most one
// batch's weight at each changeover, which is far smaller than the old rule's
// error and is what the month-end consumption transfer is for.
export async function fifoResolveSlot(slot, q = query) {
  const { rows: fills } = await q(
    `SELECT material_id, qty_kg, filled_at, COALESCE(was_empty, false) AS was_empty
       FROM plant_silo_fills WHERE slot = $1 ORDER BY filled_at, id`,
    [slot]
  );
  const { rows: draws } = await q(
    `SELECT pm.id, pm.actual_kg, pm.material_id,
            COALESCE(pb.batched_at, pb.batch_date::timestamptz) AS at
       FROM plant_batch_materials pm
       JOIN plant_batches pb ON pb.id = pm.batch_id
      WHERE pm.slot = $1
      ORDER BY COALESCE(pb.batched_at, pb.batch_date::timestamptz), pm.id`,
    [slot]
  );
  const layers = [];   // { mid, left }
  let fi = 0, lastMid = null;
  const ids = [], mids = [];
  for (const d of draws) {
    const at = new Date(d.at).getTime();
    while (fi < fills.length && new Date(fills[fi].filled_at).getTime() <= at) {
      const f = fills[fi++];
      if (f.was_empty) layers.length = 0;
      layers.push({ mid: f.material_id, left: Number(f.qty_kg) || 0 });
      lastMid = f.material_id;
    }
    while (layers.length && layers[0].left <= 0.0005) layers.shift();
    const want = layers.length ? layers[0].mid : lastMid;
    let kg = Number(d.actual_kg) || 0;
    while (kg > 0 && layers.length) {
      const take = Math.min(kg, layers[0].left);
      layers[0].left -= take;
      kg -= take;
      if (layers[0].left <= 0.0005) layers.shift();
    }
    if ((d.material_id ?? null) !== (want ?? null)) { ids.push(d.id); mids.push(want); }
  }
  if (!ids.length) return 0;
  const { rowCount } = await q(
    `UPDATE plant_batch_materials pm SET material_id = u.mid
       FROM unnest($1::int[], $2::int[]) AS u(id, mid)
      WHERE pm.id = u.id`,
    [ids, mids]
  );
  return rowCount;
}

export async function reresolveSilos() {
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

  // Refillable silos — Round 189 (v10.18): FIRST IN, FIRST OUT.
  //
  // Until now each batch was charged to the silo's LATEST fill before it. A silo
  // holding several brands (fly ash JSW / Thoothukudi / Udupi, three cement
  // brands) then booked every draw to whichever load arrived last, so the brand
  // that went in first showed almost no consumption and the last one far too
  // much. Now each draw comes off the OLDEST load still in the silo; when that
  // load is used up the next one starts. See fifoResolveSlot().
  const { rows: refill } = await query(`SELECT slot FROM plant_silo_aliases WHERE is_refillable`);
  let refilled = 0;
  for (const r of refill) refilled += await fifoResolveSlot(r.slot);
  touched += refilled;

  return touched;
}

// ---------------------------------------------------------------------------
// ROUND 159 — the silos: what each hopper is, and what the refillable ones
// have held over time.
// ---------------------------------------------------------------------------
router.get("/silos", requirePermission("production.plant-mapping", "view"), async (req, res) => {
  try {
    const [seen, aliases, materials, fills, notInSilo, units] = await Promise.all([
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
      // Round 188 (v10.17 #6) — each material's purchase unit, so a level is
      // shown the way the material is bought (aggregate in CFT, cement in MT…).
      query(`SELECT id, purchase_unit, kg_per_purchase_unit FROM rm_materials`),
    ]);
    const unitBy = new Map(units.rows.map((u) => [u.id, u]));
    const unitOf = (mid) => {
      const u = mid ? unitBy.get(mid) : null;
      const k = u ? Number(u.kg_per_purchase_unit) : 0;
      return u && u.purchase_unit && k > 0 ? { purchase_unit: u.purchase_unit, kg_per_purchase_unit: k } : { purchase_unit: null, kg_per_purchase_unit: null };
    };

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
          ...unitOf(a.is_refillable ? (b?.current_material_id || null) : a.material_id),
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
        ...unitOf(r.material_id),
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
router.post("/silos", requirePermission("production.plant-mapping", "create"), async (req, res) => {
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

router.delete("/silos/:id", requirePermission("production.plant-mapping", "edit"), async (req, res) => {
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
router.get("/silo-fills", requirePermission("production.plant-mapping", "view"), async (req, res) => {
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

router.post("/silo-fills", requirePermission("production.plant-mapping", "create"), async (req, res) => {
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

router.delete("/silo-fills/:id", requirePermission("production.plant-mapping", "edit"), async (req, res) => {
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
router.get("/manual", requirePermission("production.plant-manual", "view"), async (req, res) => {
  try {
    const day = istDay(req.query.date ? new Date(req.query.date) : new Date());
    const [entries, auto, autoProd] = await Promise.all([
      query(
        // to_char, not the bare date: a DATE comes back as a UTC timestamp
        // otherwise, which is the exact round trip behind this app's IST bug
        // every time it has appeared. Round 158 fixed the same thing on the
        // production-by-day query.
        `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
                e.material_id, e.qty_kg, e.qty_m3, e.reason, e.entered_at, e.recipe_lines,
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
    // Round 187 — every active material, so manual consumption can be entered
    // for a material the plant did not weigh that day (including a whole day
    // the plant was down, when the auto list above is empty).
    const { rows: materials } = await query(
      `SELECT id, name, category FROM rm_materials WHERE is_active = true ORDER BY category NULLS LAST, name`
    );
    // Round 188 (v10.17 #8) — the plant's recipes, so manual production can be
    // entered by recipe and its consumption worked out from the recipe targets.
    const { rows: recipes } = await query(
      `SELECT recipe_code, recipe_name FROM plant_recipes WHERE COALESCE(deleted_flag, '') <> 'Yes' ORDER BY recipe_code`
    );
    res.json({
      date: day,
      consumption: auto.rows,
      production: autoProd.rows[0],
      entries: entries.rows,
      materials,
      recipes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the day's entries." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 188 (v10.17 #8) — consumption worked out from manual production.
//
// The operator enters what the plant made by hand as recipe + m3 lines. Each
// recipe's per-m3 targets (MCI370's Recipe_Master, synced into plant_recipes /
// plant_recipe_targets) times the m3 gives kg per hopper; each hopper is turned
// into a material the same way the plant's own batches are (the silo mapping,
// or the latest fill for a refillable silo). The result pre-fills the manual
// consumption boxes; the operator can still correct any figure before saving.
// ---------------------------------------------------------------------------
function cleanRecipeLines(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    const code = String(it?.recipe_code || "").trim().slice(0, 50);
    const m3 = Number(it?.m3);
    if (!code && (it?.m3 === "" || it?.m3 == null)) continue;
    if (!code) throw new Error("Choose the recipe for every manual line.");
    if (!Number.isFinite(m3) || m3 <= 0) throw new Error(`Enter the m³ for ${code}.`);
    out.push({ recipe_code: code, m3: Math.round(m3 * 1000) / 1000 });
  }
  return out;
}

async function consumptionFromRecipes(lines) {
  if (!lines.length) return { materials: [], unknown_recipes: [], unmapped_slots: [] };
  const codes = [...new Set(lines.map((l) => l.recipe_code))];
  const [{ rows: targets }, slotMat, { rows: mats }] = await Promise.all([
    query(
      `SELECT r.recipe_code, t.slot, t.target
         FROM plant_recipes r JOIN plant_recipe_targets t ON t.recipe_id = r.id
        WHERE r.recipe_code = ANY($1::text[])`,
      [codes]
    ),
    slotMaterialMap(),
    query(`SELECT id, name FROM rm_materials`),
  ]);
  const nameOf = new Map(mats.map((m) => [m.id, m.name]));
  const byRecipe = new Map();
  for (const t of targets) {
    if (!byRecipe.has(t.recipe_code)) byRecipe.set(t.recipe_code, []);
    byRecipe.get(t.recipe_code).push(t);
  }
  const kg = new Map();
  const unknown = new Set(), unmapped = new Set();
  for (const l of lines) {
    const ts = byRecipe.get(l.recipe_code);
    if (!ts) { unknown.add(l.recipe_code); continue; }
    for (const t of ts) {
      const tgt = Number(t.target) || 0;
      if (tgt <= 0) continue;
      const mid = slotMat.get(t.slot);
      if (!mid) { unmapped.add(t.slot); continue; }
      kg.set(mid, (kg.get(mid) || 0) + tgt * l.m3);
    }
  }
  return {
    materials: [...kg.entries()]
      .map(([material_id, v]) => ({ material_id, name: nameOf.get(material_id) || `#${material_id}`, kg: Math.round(v * 100) / 100 }))
      .sort((a, b) => b.kg - a.kg),
    unknown_recipes: [...unknown],
    unmapped_slots: [...unmapped],
  };
}

router.post("/manual/calc", requirePermission("production.plant-manual", "view"), async (req, res) => {
  try {
    const lines = cleanRecipeLines(req.body?.recipe_lines);
    res.json({ ...(await consumptionFromRecipes(lines)), production_m3: Math.round(lines.reduce((t, l) => t + l.m3, 0) * 1000) / 1000 });
  } catch (err) {
    if (err.message && !err.code) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Could not work out the consumption." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 187 (v10.16) — save a whole day's manual entry in one go.
//
// The screen used to save each box on blur. Its boxes were uncontrolled, so
// when the day changed they kept what was typed for the previous day, and the
// next blur saved those figures against the NEW day. Now the screen holds a
// draft and sends the complete day here when the operator presses Save: the
// day's manual rows are replaced as a set, in one transaction, so what is on
// the screen after saving is exactly what is stored. A blank or zero clears.
// ---------------------------------------------------------------------------
router.post("/manual/day", requirePermission("production.plant-manual", "create"), async (req, res) => {
  const day = String(req.body?.entry_date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "Give the date as YYYY-MM-DD." });
  if (day > istDay()) return res.status(400).json({ error: "Manual entries cannot be made for a future date." });
  const reason = String(req.body?.reason || "").trim() || null;

  // Round 188 — manual production may come as recipe lines; then the day's
  // manual m3 IS their total, so the two can never disagree.
  let recipeLines;
  try { recipeLines = cleanRecipeLines(req.body?.recipe_lines); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const m3Raw = req.body?.production_m3;
  let m3 = m3Raw === null || m3Raw === undefined || m3Raw === "" ? 0 : Number(m3Raw);
  if (recipeLines.length) m3 = Math.round(recipeLines.reduce((t, l) => t + l.m3, 0) * 1000) / 1000;
  if (!Number.isFinite(m3) || m3 < 0) return res.status(400).json({ error: "Manual production must be zero or more m³." });

  const list = Array.isArray(req.body?.materials) ? req.body.materials : [];
  const mats = new Map();
  for (const it of list) {
    const id = Number(it?.material_id);
    if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ error: "Invalid material in the list." });
    const raw = it?.qty_kg;
    const kg = raw === null || raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(kg) || kg < 0) return res.status(400).json({ error: "Manual consumption must be zero or more." });
    if (kg > 0) mats.set(id, kg);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM plant_manual_entries WHERE entry_date = $1::date`, [day]);
    if (m3 > 0) {
      await client.query(
        `INSERT INTO plant_manual_entries (entry_date, material_id, qty_m3, reason, entered_by, recipe_lines)
         VALUES ($1::date, NULL, $2, $3, $4, $5)`,
        [day, m3, reason, req.user.id, recipeLines.length ? JSON.stringify(recipeLines) : null]
      );
    }
    for (const [id, kg] of mats) {
      await client.query(
        `INSERT INTO plant_manual_entries (entry_date, material_id, qty_kg, reason, entered_by)
         VALUES ($1::date, $2, $3, $4, $5)`,
        [day, id, kg, reason, req.user.id]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, entry_date: day, production_m3: m3, materials_saved: mats.size, cleared: m3 === 0 && mats.size === 0 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    if (err.code === "23503") return res.status(400).json({ error: "One of those materials no longer exists." });
    res.status(500).json({ error: "Could not save the day's manual entry." });
  } finally {
    client.release();
  }
});

// Round 187 — the days that have any manual entry, newest first, so a saved
// day can be found again and edited.
router.get("/manual/days", requirePermission("production.plant-manual", "view"), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 120, 1), 800);
    const { rows } = await query(
      `SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
              COALESCE(sum(e.qty_m3) FILTER (WHERE e.material_id IS NULL), 0)::numeric AS production_m3,
              count(*) FILTER (WHERE e.material_id IS NOT NULL)::int AS materials,
              COALESCE(sum(e.qty_kg), 0)::numeric AS consumption_kg,
              max(e.reason) AS reason,
              max(e.entered_at) AS entered_at,
              (array_agg(u.name ORDER BY e.entered_at DESC))[1] AS entered_by_name
         FROM plant_manual_entries e
         LEFT JOIN users u ON u.id = e.entered_by
        WHERE e.entry_date >= CURRENT_DATE - ($1::int - 1)
        GROUP BY e.entry_date
        ORDER BY e.entry_date DESC`,
      [days]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the saved manual entries." });
  }
});

router.post("/manual", requirePermission("production.plant-manual", "create"), async (req, res) => {
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
      // Round 187 — material_id is NULL here, so ON CONFLICT (entry_date,
      // material_id) never matched and each save ADDED a row. Replace instead.
      await query(`DELETE FROM plant_manual_entries WHERE entry_date = $1::date AND material_id IS NULL`, [day]);
      const { rows } = await query(
        `INSERT INTO plant_manual_entries (entry_date, material_id, qty_m3, reason, entered_by)
         VALUES ($1::date, NULL, $2, $3, $4)
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

// Round 188 (v10.17 #5) — the rule's target is now the PLANT's text, because a
// MixTrack docket carries the customer and site exactly as MCI370 recorded
// them. The pickers list what the plant has actually used (last 12 months),
// which is also why the old screen showed no customers: it asked the wrong
// endpoint, and even the right one would have offered names a docket never
// carries. Rules made earlier against the app's own customers / sites are
// still listed, still applied to older dockets, and can be removed.
router.get("/qc-delays", requirePermission("production.mixtrack-qc-delay", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT q.id, q.customer_id, q.site_id, q.customer_text, q.site_text, q.delay_minutes, q.note,
            to_char(q.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS updated_at,
            COALESCE(q.customer_text, c.name) AS customer_name, COALESCE(q.site_text, s.name) AS site_name,
            u.name AS updated_by_name
       FROM mixtrack_qc_delays q
       LEFT JOIN customers c ON c.id = q.customer_id
       LEFT JOIN sites s ON s.id = q.site_id
       LEFT JOIN users u ON u.id = q.updated_by
      ORDER BY (q.site_id IS NULL AND q.customer_id IS NULL AND q.site_text IS NULL AND q.customer_text IS NULL),
               COALESCE(q.site_text, s.name) NULLS LAST, COALESCE(q.customer_text, c.name) NULLS LAST`
  );
  res.json(rows);
});

router.get("/qc-delays/targets", requirePermission("production.mixtrack-qc-delay", "view"), async (req, res) => {
  const [cust, site] = await Promise.all([
    query(
      `SELECT btrim(customer_code) AS name, count(DISTINCT (batch_year, batch_no))::int AS loads
         FROM plant_batches
        WHERE batch_date >= CURRENT_DATE - 365 AND btrim(COALESCE(customer_code, '')) <> ''
        GROUP BY btrim(customer_code) ORDER BY 1`
    ),
    query(
      `SELECT btrim(site_name) AS name, (array_agg(btrim(customer_code) ORDER BY batched_at DESC NULLS LAST))[1] AS customer,
              count(DISTINCT (batch_year, batch_no))::int AS loads
         FROM plant_batches
        WHERE batch_date >= CURRENT_DATE - 365 AND btrim(COALESCE(site_name, '')) <> ''
        GROUP BY btrim(site_name) ORDER BY 1`
    ),
  ]);
  res.json({ customers: cust.rows, sites: site.rows });
});

router.post("/qc-delays", requirePermission("production.mixtrack-qc-delay", "create"), async (req, res) => {
  const { delay_minutes, note } = req.body || {};
  const customerText = String(req.body?.customer_text || "").trim() || null;
  const siteText = String(req.body?.site_text || "").trim() || null;
  const mins = Number(delay_minutes);
  if (!Number.isFinite(mins) || mins < 0 || mins > 240) {
    return res.status(400).json({ error: "The allowance must be between 0 and 240 minutes." });
  }
  // Both set is refused rather than silently resolved: a rule naming a
  // customer AND a site reads as "this customer at this site", which is not
  // what the lookup does.
  if (customerText && siteText) {
    return res.status(400).json({ error: "Set the allowance against a site or a customer, not both." });
  }
  const m = Math.round(mins);
  // Find the existing rule for the same target (case-insensitive), so saving
  // again edits it instead of tripping the unique index.
  const { rows: existing } = await query(
    `SELECT id FROM mixtrack_qc_delays
      WHERE ($1::text IS NOT NULL AND site_text IS NOT NULL AND upper(btrim(site_text)) = upper($1::text))
         OR ($1::text IS NULL AND $2::text IS NOT NULL AND site_text IS NULL AND customer_text IS NOT NULL
             AND upper(btrim(customer_text)) = upper($2::text))
         OR ($1::text IS NULL AND $2::text IS NULL AND site_id IS NULL AND customer_id IS NULL
             AND site_text IS NULL AND customer_text IS NULL)
      LIMIT 1`,
    [siteText, customerText]
  );
  if (existing.length) {
    const { rows } = await query(
      `UPDATE mixtrack_qc_delays SET delay_minutes = $2, note = $3, updated_by = $4, updated_at = now()
        WHERE id = $1 RETURNING id, customer_text, site_text, delay_minutes`,
      [existing[0].id, m, note || null, req.user.id]
    );
    return res.json(rows[0]);
  }
  const { rows } = await query(
    `INSERT INTO mixtrack_qc_delays (customer_text, site_text, delay_minutes, note, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, customer_text, site_text, delay_minutes`,
    [customerText, siteText, m, note || null, req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.delete("/qc-delays/:id", requirePermission("production.mixtrack-qc-delay", "edit"), async (req, res) => {
  await query(`DELETE FROM mixtrack_qc_delays WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.post("/recheck", requirePermission("production.plant-mapping", "edit"), async (req, res) => {
  try {
    const touched = await reresolveSilos();
    res.json({ ok: true, rows_updated: touched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not re-check the silos." });
  }
});

export default router;
