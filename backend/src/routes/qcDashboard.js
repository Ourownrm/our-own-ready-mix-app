// Round 141 — Cube Strength QC dashboard (Administrator only).
//
// A read-only analysis layer over the cube-testing data the Lab Technician
// module already records. It adds NO tables and NO columns: every number
// here is derived from cube_test_results / cube_test_cubes (plant-cast) and
// site_cube_test_results / site_cube_test_cubes (site-cast), joined to
// customer_orders -> mix_grades and the snapshotted mix_designs row.
//
// Why a separate route file rather than more endpoints on labTechnician.js:
// that router is opened to lab_technician/qc_engineer/manager/administrator
// at the router level (`router.use(requireAuth, requireRole(...))`), and the
// user asked for this dashboard to be Administrator-only. Putting it in its
// own file makes the narrower guard the default for everything in here,
// rather than an easily-forgotten per-route override — exactly the
// "two role surfaces can silently disagree" trap the project doc warns
// about. The frontend route guard in App.jsx is set to the same single role.
//
// The two cube tracks are unioned in one base CTE, the same shape
// labTechnician.js's own /cube-test-report uses (same aliases in both
// halves so one WHERE text and one params array serves both).
//
// Standards used, all stated on the page itself so nothing is a hidden
// assumption:
//   * IS 456:2000 Cl 16.1 acceptance — individual result >= f'ck - 4, and
//     the mean of any 4 consecutive results >= f'ck + 0.825*sigma or
//     f'ck + 4, whichever is greater (values for M20 and above).
//   * IS 456 Cl 16.3 / IS 10262 — sigma is "established" only on >= 30
//     results; below that the grade's assumed sigma is used and the figure
//     is labelled provisional.
//   * IS 10262 assumed sigma: 3.5 (M10-M15), 4.0 (M20-M25), 5.0 (M30-M55).
//   * IS 516 — a cube more than 15% from its batch average makes the test
//     questionable; Cone and Cone & split are satisfactory failure types.
//   * IS 456 Cl 15.2.2 — minimum sampling frequency by volume poured per
//     day: 1-5 m3 = 1 sample, 6-15 = 2, 16-30 = 3, 31-50 = 4, and 4 plus one
//     per additional 50 m3 (or part) above 50.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("administrator"));

// IS 10262 Table 2 — the sigma a design assumes before the plant has 30 of
// its own results. Only used as a fallback: a linked mix design carries its
// own std_deviation_mpa, which is preferred because that is the number the
// design's target mean was actually built on.
export function assumedSigmaForFck(fck) {
  const f = Number(fck);
  if (!Number.isFinite(f)) return null;
  if (f <= 15) return 3.5;
  if (f <= 25) return 4.0;
  return 5.0;
}

// IS 456 Cl 15.2.2 minimum number of samples for a day's pour volume.
export function requiredSamplesForVolume(m3) {
  const v = Number(m3) || 0;
  if (v <= 0) return 0;
  if (v <= 5) return 1;
  if (v <= 15) return 2;
  if (v <= 30) return 3;
  if (v <= 50) return 4;
  return 4 + Math.ceil((v - 50) / 50);
}

// The grade number itself is the fallback characteristic strength for a
// result whose mix_design_id is null (pre-mix-design-library results, and
// any pour whose grade never had a design). M25 -> 25.
const FCK_SQL = `COALESCE(md.fck_28day_mpa, NULLIF(regexp_replace(mg.name, '\\D', '', 'g'), '')::numeric)`;

function buildFilters(q) {
  const conditions = [];
  const params = [];
  if (q.from_date) { params.push(q.from_date); conditions.push(`ctr.tested_at::date >= $${params.length}`); }
  if (q.to_date) { params.push(q.to_date); conditions.push(`ctr.tested_at::date <= $${params.length}`); }
  if (q.customer_id) { params.push(Number(q.customer_id)); conditions.push(`c.id = $${params.length}`); }
  if (q.mix_grade_id) { params.push(Number(q.mix_grade_id)); conditions.push(`mg.id = $${params.length}`); }
  if (q.mix_design_id) { params.push(Number(q.mix_design_id)); conditions.push(`md.id = $${params.length}`); }
  if (q.tested_by) { params.push(Number(q.tested_by)); conditions.push(`u.id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

// One row per cube test, both tracks. `max_dev_pct` is the worst single
// cube's distance from its own batch average (IS 516's 15% test) and is
// computed only over cubes that were actually crushed — a cube row exists
// for every sample TAKEN, and an untested one has null load/strength, so
// including them would invent a deviation that never happened.
function baseResultsCte(where) {
  return `
  WITH results AS (
    SELECT 'plant' AS source, ctr.id AS result_id, co.id AS batch_id, co.id AS order_id,
           ctr.testing_age_days, ctr.average_strength_mpa AS strength,
           ctr.average_density_kgm3 AS density, ctr.failure_type, ctr.tested_at,
           u.id AS tested_by_id, u.name AS tested_by_name,
           c.id AS customer_id, c.name AS customer_name,
           s.id AS site_id, s.name AS site_name,
           mg.id AS mix_grade_id, mg.name AS mix_grade_name,
           md.id AS mix_design_id, md.design_ref_code,
           ${FCK_SQL} AS fck, md.std_deviation_mpa AS design_sigma,
           md.target_mean_strength_mpa AS design_target_mean,
           COALESCE(pq.entered_at::date, (
             SELECT MIN(pq2.entered_at)::date FROM cube_test_cubes ctc2
             JOIN plant_qc pq2 ON pq2.id = ctc2.plant_qc_id
             WHERE ctc2.cube_test_result_id = ctr.id
           )) AS cast_date,
           cs.cube_count, cs.max_dev_pct
    FROM cube_test_results ctr
    JOIN users u ON u.id = ctr.tested_by
    JOIN customer_orders co ON co.id = ctr.order_id
    JOIN customers c ON c.id = co.customer_id
    JOIN sites s ON s.id = co.site_id
    JOIN mix_grades mg ON mg.id = co.mix_grade_id
    LEFT JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
    LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cube_count,
             MAX(ABS(x.strength_mpa - a.avg_s) / NULLIF(a.avg_s, 0)) * 100 AS max_dev_pct
      FROM cube_test_cubes x
      CROSS JOIN LATERAL (
        SELECT AVG(y.strength_mpa) AS avg_s FROM cube_test_cubes y
        WHERE y.cube_test_result_id = ctr.id AND y.strength_mpa IS NOT NULL AND y.testing_load_kn IS NOT NULL
      ) a
      WHERE x.cube_test_result_id = ctr.id AND x.strength_mpa IS NOT NULL AND x.testing_load_kn IS NOT NULL
    ) cs ON true
    ${where}
    UNION ALL
    SELECT 'site' AS source, ctr.id AS result_id, scc.id AS batch_id, co.id AS order_id,
           ctr.testing_age_days, ctr.average_strength_mpa AS strength,
           ctr.average_density_kgm3 AS density, ctr.failure_type, ctr.tested_at,
           u.id AS tested_by_id, u.name AS tested_by_name,
           c.id AS customer_id, c.name AS customer_name,
           s.id AS site_id, s.name AS site_name,
           mg.id AS mix_grade_id, mg.name AS mix_grade_name,
           md.id AS mix_design_id, md.design_ref_code,
           ${FCK_SQL} AS fck, md.std_deviation_mpa AS design_sigma,
           md.target_mean_strength_mpa AS design_target_mean,
           scc.cast_date AS cast_date,
           cs.cube_count, cs.max_dev_pct
    FROM site_cube_test_results ctr
    JOIN users u ON u.id = ctr.tested_by
    JOIN site_cube_casts scc ON scc.id = ctr.site_cube_cast_id
    JOIN customer_orders co ON co.id = scc.order_id
    JOIN customers c ON c.id = co.customer_id
    JOIN sites s ON s.id = co.site_id
    JOIN mix_grades mg ON mg.id = co.mix_grade_id
    LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cube_count,
             MAX(ABS(x.strength_mpa - a.avg_s) / NULLIF(a.avg_s, 0)) * 100 AS max_dev_pct
      FROM site_cube_test_cubes x
      CROSS JOIN LATERAL (
        SELECT AVG(y.strength_mpa) AS avg_s FROM site_cube_test_cubes y
        WHERE y.site_cube_test_result_id = ctr.id AND y.strength_mpa IS NOT NULL AND y.testing_load_kn IS NOT NULL
      ) a
      WHERE x.site_cube_test_result_id = ctr.id AND x.strength_mpa IS NOT NULL AND x.testing_load_kn IS NOT NULL
    ) cs ON true
    ${where}
  )`;
}

// Filter lists for the page's own dropdowns — only values that actually
// appear in cube results, so a grade nobody has ever tested doesn't sit in
// the filter as a dead option.
router.get("/filters", async (_req, res) => {
  const [grades, customers, designs, techs] = await Promise.all([
    query(`SELECT DISTINCT mg.id, mg.name FROM mix_grades mg
           WHERE mg.id IN (SELECT co.mix_grade_id FROM customer_orders co
                           WHERE co.id IN (SELECT order_id FROM cube_test_results WHERE order_id IS NOT NULL
                                           UNION SELECT order_id FROM site_cube_casts))
           ORDER BY mg.name`),
    query(`SELECT DISTINCT c.id, c.name FROM customers c
           JOIN customer_orders co ON co.customer_id = c.id
           WHERE co.id IN (SELECT order_id FROM cube_test_results WHERE order_id IS NOT NULL
                           UNION SELECT order_id FROM site_cube_casts)
           ORDER BY c.name`),
    query(`SELECT DISTINCT md.id, md.design_ref_code, mg.name AS mix_grade_name
           FROM mix_designs md JOIN mix_grades mg ON mg.id = md.mix_grade_id
           WHERE md.id IN (SELECT mix_design_id FROM cube_test_results WHERE mix_design_id IS NOT NULL
                           UNION SELECT mix_design_id FROM site_cube_test_results WHERE mix_design_id IS NOT NULL)
           ORDER BY md.design_ref_code`),
    query(`SELECT DISTINCT u.id, u.name FROM users u
           WHERE u.id IN (SELECT tested_by FROM cube_test_results UNION SELECT tested_by FROM site_cube_test_results)
           ORDER BY u.name`),
  ]);
  res.json({
    grades: grades.rows,
    customers: customers.rows,
    mix_designs: designs.rows,
    technicians: techs.rows,
  });
});

router.get("/summary", async (req, res) => {
  const { where, params } = buildFilters(req.query);
  const cte = baseResultsCte(where);
  // Applied after the union (it is the only filter that differs between the
  // two halves, so it can't live in the shared WHERE text).
  const srcParam = ["plant", "site"].includes(req.query.source) ? req.query.source : null;
  const p = [...params, srcParam];
  const srcN = p.length;
  const srcFilter = `($${srcN}::text IS NULL OR source = $${srcN})`;

  const [results, spread, failures, density, customers, designs, weekly, workload, pending] = await Promise.all([
    // Every result in range. The page needs the individual points anyway for
    // the control chart, so they are returned once and the per-grade
    // statistics are computed from them in JS rather than in a second pass
    // of SQL that could drift from this one.
    query(
      `${cte}
       SELECT source, result_id, batch_id, order_id, testing_age_days, strength, density, failure_type,
              tested_at, tested_by_id, tested_by_name, customer_id, customer_name, site_id, site_name,
              mix_grade_id, mix_grade_name, mix_design_id, design_ref_code, fck, design_sigma,
              design_target_mean, cast_date, cube_count, max_dev_pct
       FROM results WHERE ${srcFilter} AND strength IS NOT NULL
       ORDER BY COALESCE(cast_date, tested_at::date), tested_at
       LIMIT 5000`, p),
    query(
      `${cte}
       SELECT CASE WHEN max_dev_pct IS NULL THEN 'unknown'
                   WHEN max_dev_pct <= 5 THEN 'le5'
                   WHEN max_dev_pct <= 10 THEN 'le10'
                   WHEN max_dev_pct <= 15 THEN 'le15'
                   ELSE 'gt15' END AS bucket,
              COUNT(*)::int AS n
       FROM results WHERE ${srcFilter} AND strength IS NOT NULL
       GROUP BY 1`, p),
    query(
      `${cte}
       SELECT COALESCE(NULLIF(TRIM(failure_type), ''), 'Not recorded') AS failure_type, COUNT(*)::int AS n
       FROM results WHERE ${srcFilter} AND strength IS NOT NULL
       GROUP BY 1 ORDER BY n DESC`, p),
    query(
      `${cte}
       SELECT COUNT(*) FILTER (WHERE density IS NOT NULL)::int AS with_density,
              COUNT(*) FILTER (WHERE density IS NOT NULL AND (density < 2300 OR density > 2500))::int AS outside,
              COUNT(*) FILTER (WHERE density IS NOT NULL AND (density < 2300 OR density > 2500)
                                 AND testing_age_days = 28 AND strength < fck)::int AS outside_and_failed,
              ROUND(AVG(density) FILTER (WHERE density IS NOT NULL), 0) AS avg_density
       FROM results WHERE ${srcFilter} AND strength IS NOT NULL`, p),
    query(
      `${cte}
       SELECT customer_id, customer_name, site_id, site_name,
              COUNT(*)::int AS tests,
              COUNT(*) FILTER (WHERE testing_age_days = 28)::int AS tests_28,
              COUNT(*) FILTER (WHERE testing_age_days = 28 AND strength >= fck)::int AS pass_28,
              MIN(strength - fck) FILTER (WHERE testing_age_days = 28) AS min_margin,
              string_agg(DISTINCT mix_grade_name, ', ' ORDER BY mix_grade_name) AS grades
       FROM results WHERE ${srcFilter} AND strength IS NOT NULL
       GROUP BY customer_id, customer_name, site_id, site_name
       ORDER BY min_margin NULLS LAST`, p),
    query(
      `${cte}
       SELECT mix_design_id, design_ref_code, mix_grade_name, MAX(fck) AS fck,
              MAX(design_sigma) AS design_sigma, MAX(design_target_mean) AS design_target_mean,
              COUNT(*) FILTER (WHERE testing_age_days = 28)::int AS n,
              AVG(strength) FILTER (WHERE testing_age_days = 28) AS mean_28,
              STDDEV_SAMP(strength) FILTER (WHERE testing_age_days = 28) AS sigma_28,
              MIN(strength) FILTER (WHERE testing_age_days = 28) AS min_28,
              MAX(strength) FILTER (WHERE testing_age_days = 28) AS max_28
       FROM results WHERE ${srcFilter} AND strength IS NOT NULL AND mix_design_id IS NOT NULL
       GROUP BY mix_design_id, design_ref_code, mix_grade_name
       HAVING COUNT(*) FILTER (WHERE testing_age_days = 28) > 0
       ORDER BY mix_grade_name, design_ref_code`, p),
    // Samples per week vs what IS 456 Cl 15.2.2 asks for, given the volume
    // actually delivered that week. Volume comes from delivery_tickets, the
    // same source the production reports use; the required count is computed
    // per DAY (the standard is a per-day rule) and summed into the week, not
    // computed once on the week's total, which would understate it.
    query(
      `${cte}, samples AS (
         SELECT date_trunc('week', COALESCE(cast_date, tested_at::date))::date AS wk, source, batch_id
         FROM results WHERE ${srcFilter} AND testing_age_days = 7
         UNION
         SELECT date_trunc('week', COALESCE(cast_date, tested_at::date))::date AS wk, source, batch_id
         FROM results WHERE ${srcFilter} AND testing_age_days = 28
       ),
       counted AS (
         SELECT wk, COUNT(*) FILTER (WHERE source = 'plant')::int AS plant_samples,
                    COUNT(*) FILTER (WHERE source = 'site')::int AS site_samples
         FROM samples GROUP BY wk
       ),
       daily_volume AS (
         SELECT dt.ticket_date::date AS d, SUM(COALESCE(dt.loaded_quantity_m3, 0)) AS m3
         FROM delivery_tickets dt
         WHERE dt.status NOT IN ('cancelled', 'rejected', 'returned')
           AND dt.ticket_date >= (SELECT MIN(COALESCE(cast_date, tested_at::date)) FROM results WHERE ${srcFilter})
         GROUP BY 1
       )
       SELECT c.wk, c.plant_samples, c.site_samples,
              COALESCE((SELECT SUM(dv.m3) FROM daily_volume dv
                        WHERE date_trunc('week', dv.d)::date = c.wk), 0) AS volume_m3,
              COALESCE((SELECT json_agg(dv.m3) FROM daily_volume dv
                        WHERE date_trunc('week', dv.d)::date = c.wk), '[]'::json) AS daily_m3
       FROM counted c
       ORDER BY c.wk DESC
       LIMIT 13`, p),
    // Lab workload — counts only, deliberately the same shape the Lab
    // Technician's own "Samples Due" page already computes, so the two can
    // never tell the Administrator and the lab different numbers.
    query(
      `WITH pour_batches AS (
         SELECT co.id AS order_id, MIN(pq.entered_at)::date AS cast_date
         FROM plant_qc pq
         JOIN delivery_tickets dt ON dt.id = pq.ticket_id
         JOIN customer_orders co ON co.id = dt.order_id
         WHERE COALESCE(pq.number_of_cubes, 0) > 0
         GROUP BY co.id
       ),
       plant AS (
         SELECT pb.order_id, pb.cast_date,
                EXISTS (SELECT 1 FROM cube_test_results r WHERE r.order_id = pb.order_id AND r.testing_age_days = 7) AS has7,
                EXISTS (SELECT 1 FROM cube_test_results r WHERE r.order_id = pb.order_id AND r.testing_age_days = 28) AS has28,
                EXISTS (SELECT 1 FROM cube_pour_status cps WHERE cps.order_id = pb.order_id) AS closed
         FROM pour_batches pb
       ),
       site AS (
         SELECT scc.id, scc.cast_date,
                EXISTS (SELECT 1 FROM site_cube_test_results r WHERE r.site_cube_cast_id = scc.id AND r.testing_age_days = 7) AS has7,
                EXISTS (SELECT 1 FROM site_cube_test_results r WHERE r.site_cube_cast_id = scc.id AND r.testing_age_days = 28) AS has28,
                false AS closed
         FROM site_cube_casts scc
       ),
       -- 'both' would be a reserved word here (TRIM(BOTH ...)), hence the name.
       all_batches AS (SELECT cast_date, has7, has28, closed FROM plant UNION ALL SELECT cast_date, has7, has28, closed FROM site)
       SELECT
         COUNT(*) FILTER (WHERE NOT has7 AND NOT closed AND cast_date + 7 = CURRENT_DATE)::int AS due_today_7,
         COUNT(*) FILTER (WHERE NOT has28 AND NOT closed AND cast_date + 28 = CURRENT_DATE)::int AS due_today_28,
         COUNT(*) FILTER (WHERE NOT has7 AND NOT closed AND cast_date + 7 < CURRENT_DATE)::int AS overdue_7,
         COUNT(*) FILTER (WHERE NOT has28 AND NOT closed AND cast_date + 28 < CURRENT_DATE)::int AS overdue_28,
         COUNT(*) FILTER (WHERE NOT has7 AND NOT has28 AND NOT closed AND cast_date + 28 < CURRENT_DATE)::int AS never_tested,
         COUNT(*) FILTER (WHERE NOT has28 AND NOT closed AND cast_date + 28 BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS due_this_week_28
       FROM all_batches`),
    // 7-day results whose 28-day test has not been entered yet: the early
    // warning list. Projection itself happens in JS from the grade's own
    // historical 7d/28d ratio (computed from the results array above), so
    // the ratio and the projection can never be computed from two different
    // filtered sets.
    query(
      `${cte}
       SELECT r.source, r.result_id, r.batch_id, r.order_id, r.strength AS strength_7, r.cast_date,
              r.customer_name, r.site_name, r.mix_grade_id, r.mix_grade_name, r.design_ref_code, r.fck,
              r.tested_at
       FROM results r
       WHERE ${srcFilter} AND r.testing_age_days = 7 AND r.strength IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM cube_test_results x WHERE r.source = 'plant' AND x.order_id = r.order_id AND x.testing_age_days = 28
         )
         AND NOT EXISTS (
           SELECT 1 FROM site_cube_test_results y WHERE r.source = 'site' AND y.site_cube_cast_id = r.batch_id AND y.testing_age_days = 28
         )
       ORDER BY r.cast_date DESC NULLS LAST
       LIMIT 200`, p),
  ]);

  res.json({
    results: results.rows,
    spread_buckets: spread.rows,
    failure_types: failures.rows,
    density: density.rows[0] || {},
    customers: customers.rows,
    mix_designs: designs.rows,
    weekly: weekly.rows.map((w) => ({
      week_start: w.wk,
      plant_samples: w.plant_samples,
      site_samples: w.site_samples,
      volume_m3: Number(w.volume_m3) || 0,
      required_samples: (Array.isArray(w.daily_m3) ? w.daily_m3 : [])
        .reduce((sum, m3) => sum + requiredSamplesForVolume(m3), 0),
    })),
    lab_workload: workload.rows[0] || {},
    pending_28day: pending.rows,
    standards: {
      individual_allowance_mpa: 4,
      mean_of_four_sigma_factor: 0.825,
      mean_of_four_floor_mpa: 4,
      within_batch_limit_pct: 15,
      density_min: 2300,
      density_max: 2500,
      established_sigma_min_results: 30,
      satisfactory_failure_types: ["Cone", "Cone & split"],
    },
  });
});

export default router;
