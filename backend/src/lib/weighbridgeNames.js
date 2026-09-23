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
  const [mAlias, sAlias, vAlias, mMaster, sMaster, tMaster] = await Promise.all([
    query(`SELECT normalised, material_id, is_ignored FROM weighbridge_material_aliases`),
    query(`SELECT normalised, supplier_id, is_ignored FROM weighbridge_supplier_aliases`),
    query(`SELECT normalised, truck_id,    is_ignored FROM weighbridge_vehicle_aliases`),
    query(`SELECT id, name FROM rm_materials WHERE is_active = true`),
    query(`SELECT id, name FROM rm_suppliers WHERE is_active = true`),
    query(`SELECT id, truck_number FROM trucks WHERE is_active = true`),
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

  return {
    materials: build(mMaster.rows, "id", "name", mAlias.rows, "material_id"),
    suppliers: build(sMaster.rows, "id", "name", sAlias.rows, "supplier_id"),
    vehicles:  build(tMaster.rows, "id", "truck_number", vAlias.rows, "truck_id"),
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
  const material = resolveOne(resolver.materials, ticket.raw_material || ticket.raw_material_code);
  const supplier = resolveOne(resolver.suppliers, ticket.raw_supplier);
  const vehicle  = resolveOne(resolver.vehicles,  ticket.raw_vehicle);

  const unresolved = [];
  if (material.status === "unresolved" || material.status === "blank") unresolved.push("material");
  if (supplier.status === "unresolved") unresolved.push("supplier");
  if (vehicle.status === "unresolved") unresolved.push("vehicle");

  // A material somebody explicitly mapped to "not ours" settles the whole
  // ticket: they have said this is not something the plant stocks, so the
  // weighment is not a receipt we track. Calling it 'matched' would leave a
  // row in the Matched list with no material against it — it would read as
  // legitimate and creditable while being neither. 'ignored' is what it is.
  if (material.status === "ignored") {
    return { material_id: null, supplier_id: supplier.id, truck_id: vehicle.id, match_status: "ignored", unresolved: [] };
  }

  const blocking =
    material.status === "unresolved" || material.status === "blank" ||
    supplier.status === "unresolved";

  return {
    material_id: material.id,
    supplier_id: supplier.id,
    truck_id: vehicle.id,
    match_status: blocking ? "needs_review" : "matched",
    unresolved,
  };
}
