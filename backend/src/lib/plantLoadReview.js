// Round 204 — loads the plant batched into a JCB, or with no vehicle at all
// (owner, 11 Oct 2026). An Administrator reviews each and may OMIT it from the
// production totals (m³ made, cost per m³, diesel per m³, production vs
// billed). Material consumption still counts it — the material was used.
//
// One SQL condition, used by every production total, so they can never
// disagree. `a` is the plant_batches alias with its dot ("pb."); with no
// alias the table name is used — an unqualified plant_no inside the subquery
// would bind to plant_load_reviews itself and drop every load.
export function loadKept(a = "plant_batches.") {
  return `NOT EXISTS (SELECT 1 FROM plant_load_reviews lr
                       WHERE lr.plant_no = ${a}plant_no AND lr.batch_year = ${a}batch_year
                         AND lr.batch_no = ${a}batch_no AND lr.decision = 'omit')`;
}

// A load needs review when the truck field is blank, or names something that
// is not one of our registered trucks (a JCB, a tractor, "SELF").
// Registration numbers are compared without spaces or dashes.
export const TRUCK_KEY = (expr) => `upper(regexp_replace(COALESCE(${expr}, ''), '[^A-Za-z0-9]', '', 'g'))`;
