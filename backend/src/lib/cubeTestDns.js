// Round 122 — a pour-basis cube test result (cube_test_results.plant_qc_id
// IS NULL) draws its cubes from however many DNs contributed to that pour;
// this resolves the summary a PDF/report needs (which ticket(s), combined
// sample IDs, earliest casting time) from cube_test_cubes' own per-cube
// plant_qc_id. The same query shape works unchanged for a legacy
// (pre-round-122) result too — it only ever has one DN, reached via its own
// cube_test_results.plant_qc_id instead — so every caller (Lab Technician's
// own PDF route, the customer portal's, the shared booking-link's) can use
// this one helper regardless of which shape a given result happens to be.
import { query } from "../db.js";

export async function resolveCubeTestDnSummary(resultId) {
  const { rows } = await query(
    `SELECT DISTINCT dt.ticket_number, pq.sample_ids, pq.entered_at
     FROM cube_test_cubes ctc
     JOIN plant_qc pq ON pq.id = ctc.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     WHERE ctc.cube_test_result_id = $1
     UNION
     SELECT dt.ticket_number, pq.sample_ids, pq.entered_at
     FROM cube_test_results ctr
     JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     WHERE ctr.id = $1`,
    [resultId]
  );
  const ticket_number = rows.map((d) => d.ticket_number).filter(Boolean).join(", ") || null;
  const sample_ids = rows.map((d) => d.sample_ids).filter(Boolean).join(", ") || null;
  const cast_at = rows.reduce(
    (min, d) => (d.entered_at && (!min || new Date(d.entered_at) < new Date(min)) ? d.entered_at : min),
    null
  );
  return { ticket_number, sample_ids, cast_at };
}
