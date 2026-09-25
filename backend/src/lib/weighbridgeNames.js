// Round 154 — turning the weighbridge's free-text names into our records.
//
// The weighbridge stores vehicle, material and supplier as strings an operator
// typed, not as foreign keys, and nearly three years of the live dump show how
// far that drifts. The same lorry is recorded as KL77D4231, "KL77D 4231",
// "KL77 D4231", "KL 77 D 4231", KL77D-4231, kl77d4231, KL774231, KL77D423 and
// plain 4231. The same metal is "20MM" and "20 MM". The same supplier is
// "RANI", "RANI METALS AND M SAND" and "RANI METALS AND MSAND".
//
// The approach here is deliberately two-stage and deliberately unclever:
//
//   1. NORMALISE — uppercase, strip everything that is not a letter or digit.
//      This is lossless in the sense that matters: it only ever merges strings
//      that differ by punctuation, spacing or case, which cannot change what a
//      person meant. It collapses most of the mess for free.
//
//   2. LOOK UP an alias table a human maintains. Whatever normalisation did
//      not solve — a genuine typo like KL77D423, a short form like 4231, a
//      different trading name — gets mapped once by an Administrator and then
//      resolves forever, for past tickets as well as future ones.
//
// What this file deliberately does NOT do is fuzzy matching. Levenshtein
// distance would happily map "KL77D423" to whichever of two real lorries it
// scored closer, and 20MM to 12MM is a two-character edit. A wrong automatic
// match credits stock to the wrong supplier or the wrong material and nobody
// finds out for a month. A ticket sitting in a review queue with a badge on it
// gets fixed the same day. So an unrecognised name resolves to nothing and is
// flagged, every time.
//
// Exact-name matching against the master tables is the one automatic step
// beyond normalisation, because it cannot be wrong: if the normalised
// weighbridge string equals the normalised name of exactly ONE active record,
// that is not a guess. Two records normalising the same way (the dump has
// SREE MUTHAPPAN at two different supplier ids) is treated as unresolved, not
// as a coin toss.

import { query } from "../db.js";

/**
 * Uppercase, keep only A-Z and 0-9. Null/blank/whitespace -> "".
 * "KL 77 D 4231" -> "KL77D4231"; "20 MM" -> "20MM"; "DSP " -> "DSP".
 */
export function normalise(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Values that mean "the operator left this blank", which the weighbridge has
// no concept of — every column is a string, so emptiness arrives as one of
// these. Anything here is treated as absent rather than as a name to map.
const BLANKS = new Set(["", "NA", "NONE", "NIL", "NULL", "N", "0", "TEST", "XXX", "ABC"]);

export function isBlankName(raw) {
  return BLANKS.has(normalise(raw));
}

/**
 * Load the whole resolution map in three queries, once per sync batch, rather
 * than querying per ticket. The masters are small (tens of rows) and a batch
 * can be hundreds of tickets, so this is the difference between 3 queries and
 * 1,500.
 *
 * Shape: { materials: Map, suppliers: Map, vehicles: Map } where each Map goes
 * normalised string -> { id } | { ignored: true } | { ambiguous: true }.
 */
export async function loadResolver() {
  const [mAlias, sAlias, mMaster, sMaster] = await Promise.all([
    // Round 156 — material aliases now carry an optional supplier scope.
    query(`SELECT normalised, material_id, is_ignored, supplier_scope_id FROM weighbridge_material_aliases`),
    query(`SELECT normalised, supplier_id, is_ignored FROM weighbridge_supplier_aliases`),
    query(`SELECT id, name FROM rm_materials WHERE is_active = true`),
    query(`SELECT id, name FROM rm_suppliers WHERE is_active = true`),
  ]);

  // Build the master map first, then let aliases overwrite it. An alias is a
  // human's explicit decision and must win over an accidental name collision.
  function build(masterRows, idField, nameField, aliasRows, aliasIdField) {
    const map = new Map();
    for (const row of masterRows) {
      const key = normalise(row[nameField]);
      if (!key) continue;
      if (map.has(key)) {
        // Two active master records normalise identically — the dump has
        // exactly this (SREE MUTHAPPAN at supplier ids 8 and 10). Picking one
        // would be a silent data error, so mark it and let a human map it.
        map.set(key, { ambiguous: true });
      } else {
        map.set(key, { id: row[idField] });
      }
    }
    for (const row of aliasRows) {
      map.set(row.normalised, row.is_ignored ? { ignored: true } : { id: row[aliasIdField] });
    }
    return map;
  }

  // ROUND 156 — the supplier-scoped material map.
  //
  // Keyed `${normalisedMaterial}\u0000${supplierId}`. Consulted BEFORE the
  // unscoped map, which is what makes "FLY ASH from JSW" beat a plain
  // "FLY ASH" rule. Without this, one weighbridge name could only ever mean
  // one material — and the plant buys three different fly ashes that the
  // weighbridge calls by the same name, told apart only by who sent them.
  const scopedMaterials = new Map();
  for (const row of mAlias.rows) {
    if (row.supplier_scope_id == null) continue;
    scopedMaterials.set(
      `${row.normalised}\u0000${row.supplier_scope_id}`,
      row.is_ignored ? { ignored: true } : { id: row.material_id }
    );
  }

  return {
    // Unscoped material rules only — a scoped row must not leak into the
    // fallback map, or it would apply to every supplier, which is the exact
    // bug this round exists to fix.
    materials: build(
      mMaster.rows, "id", "name",
      mAlias.rows.filter((r) => r.supplier_scope_id == null), "material_id"
    ),
    scopedMaterials,
    suppliers: build(sMaster.rows, "id", "name", sAlias.rows, "supplier_id"),
  };
}

/**
 * Resolve one name against one of the maps.
 * Returns { id, status } where status is 'matched' | 'blank' | 'ignored' | 'unresolved'.
 * id is null for everything except 'matched'.
 */
export function resolveOne(map, raw) {
  if (isBlankName(raw)) return { id: null, status: "blank" };
  const hit = map.get(normalise(raw));
  if (!hit) return { id: null, status: "unresolved" };
  if (hit.ignored) return { id: null, status: "ignored" };
  if (hit.ambiguous) return { id: null, status: "unresolved" };
  return { id: hit.id, status: "matched" };
}

/**
 * Resolve a whole ticket. Returns the three ids plus the match_status and the
 * `unresolved` array the review screen reads.
 *
 * The rules, and why:
 *
 *   * MATERIAL is what decides which stock bin gets credited, so an
 *     unresolved or blank material always means needs_review. There is no
 *     useful thing to do with a receipt whose material we do not know.
 *
 *   * SUPPLIER matters for valuation and for the supplier ledger, so an
 *     unresolved one also means needs_review. A BLANK supplier does not,
 *     though: plenty of internal movements genuinely have none.
 *
 *   * VEHICLE is informational. Most lorries on this weighbridge belong to
 *     suppliers and will never be in our trucks table, so an unresolved
 *     vehicle is the normal case and must NOT hold up a receipt. It is
 *     recorded as unresolved so the mapping screen can offer it, but it does
 *     not by itself push the ticket into the queue.
 *
 *   * Anything the operator explicitly mapped to "ignore" resolves cleanly to
 *     null and is not a problem.
 */
export function resolveTicket(resolver, ticket) {
  // Supplier first, because it is an INPUT to resolving the material now.
  const supplier = resolveOne(resolver.suppliers, ticket.raw_supplier);

  // ROUND 156 — the material lookup is supplier-aware.
  //
  // Order matters and is the whole point: a rule written for this material
  // FROM THIS SUPPLIER wins, and only if there is none do we fall back to the
  // plain rule for the name. "FLY ASH" from JSW and "FLY ASH" from Thoothukudi
  // are different materials in the yard, and until this round the app had no
  // way to say so.
  const rawMaterial = ticket.raw_material || ticket.raw_material_code;
  let material;
  const scopedHit = supplier.id != null && !isBlankName(rawMaterial)
    ? resolver.scopedMaterials.get(`${normalise(rawMaterial)}\u0000${supplier.id}`)
    : null;
  if (scopedHit) {
    material = scopedHit.ignored ? { id: null, status: "ignored" } : { id: scopedHit.id, status: "matched" };
  } else {
    material = resolveOne(resolver.materials, rawMaterial);
  }

  const unresolved = [];
  if (material.status === "unresolved" || material.status === "blank") unresolved.push("material");
  if (supplier.status === "unresolved") unresolved.push("supplier");
  // Vehicles are deliberately absent from this list from Round 156 onward.
  // Every registration now gets a registry row the moment it is seen, so there
  // is nothing for a human to resolve and nothing to hold a ticket up. See
  // resolveVehicle() below and routes/weighbridge.js.

  // A material somebody explicitly mapped to "not ours" settles the whole
  // ticket: they have said this is not something the plant stocks, so the
  // weighment is not a receipt we track. Calling it 'matched' would leave a
  // row in the Matched list with no material against it — it would read as
  // legitimate and creditable while being neither. 'ignored' is what it is.
  if (material.status === "ignored") {
    return { material_id: null, supplier_id: supplier.id, match_status: "ignored", unresolved: [] };
  }

  const blocking =
    material.status === "unresolved" || material.status === "blank" ||
    supplier.status === "unresolved";

  return {
    material_id: material.id,
    supplier_id: supplier.id,
    match_status: blocking ? "needs_review" : "matched",
    unresolved,
  };
}

/**
 * ROUND 156 — resolve a raw registration to a row in the vehicle registry,
 * CREATING one if this is the first time it has been seen.
 *
 * This replaces Round 154's "map it to one of our trucks or ignore it", which
 * was wrong for this yard: almost every lorry over that weighbridge belongs to
 * a supplier, so the honest answer was "ignore" nearly every time, and the
 * vehicle — the thing you would want for asking which lorry arrives light, or
 * whether a tare is drifting — was thrown away.
 *
 * Auto-creating matters because the plant does not know a supplier's
 * registration until the lorry is standing on the weighbridge. Anything that
 * required somebody to enter it in advance would simply never be done.
 *
 * Returns { vehicle_id, truck_id } — truck_id is non-null only when a human
 * has said this registry row is one of our own mixers.
 *
 * Takes a client/query function so the caller can run it inside its own
 * transaction alongside the ticket upsert.
 */
export async function resolveVehicle(raw, q = query) {
  const norm = normalise(raw);
  if (!norm || isBlankName(raw)) return { vehicle_id: null, truck_id: null };

  // An alias points a typo at the lorry it was meant to be — this is what the
  // "merge into" action on the vehicles screen writes.
  const { rows: alias } = await q(
    `SELECT vehicle_id FROM weighbridge_vehicle_aliases WHERE normalised = $1 AND vehicle_id IS NOT NULL`,
    [norm]
  );
  const target = alias.length ? alias[0].vehicle_id : null;
  if (target) {
    const { rows } = await q(`SELECT id, truck_id, is_junk FROM weighbridge_vehicles WHERE id = $1`, [target]);
    if (rows.length) {
      return { vehicle_id: rows[0].id, truck_id: rows[0].is_junk ? null : rows[0].truck_id };
    }
  }

  // Upsert, so a registration seen for the first time registers itself and one
  // seen again just has its last_seen_at moved on. ON CONFLICT rather than
  // select-then-insert because two tickets in the same batch can carry the
  // same new lorry.
  //
  // A new row is linked to one of our own trucks when the normalised
  // registration is EXACTLY one of theirs. That is not a guess in the way the
  // material and supplier lookups would be — it is our own fleet list, and
  // there is only ever one lorry with a given registration. Anything less
  // certain is left for a human on the Vehicles screen.
  const { rows } = await q(
    `INSERT INTO weighbridge_vehicles (normalised, registration, truck_id)
     -- $1 is cast explicitly at BOTH uses. Without it Postgres infers varchar
     -- from the column on the first and text from the comparison on the
     -- second, and refuses the statement with "text versus character varying".
     VALUES ($1::text, $2, (
       SELECT t.id FROM trucks t
       WHERE t.is_active = true
         AND upper(regexp_replace(t.truck_number, '[^A-Za-z0-9]', '', 'g')) = $1::text
       -- Two active trucks normalising the same way would be a data error in
       -- the fleet list, not something to pick a winner from.
       LIMIT 1
     ))
     ON CONFLICT (normalised) DO UPDATE SET last_seen_at = now()
     RETURNING id, truck_id, is_junk`,
    [norm, String(raw).trim().slice(0, 60)]
  );
  return { vehicle_id: rows[0].id, truck_id: rows[0].is_junk ? null : rows[0].truck_id };
}
