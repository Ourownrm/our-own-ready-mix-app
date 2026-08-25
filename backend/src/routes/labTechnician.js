// Lab Technician (round 118) — new role, separate from QC Engineer.
// QC Engineer keeps doing plant-side fresh-concrete QC (slump/temp, cube
// casting) exactly as before — a "cube batch" here is just a plant_qc row
// that already has cubes cast against it (number_of_cubes > 0); nothing new
// is captured at casting time. Lab Technician owns everything downstream:
// recording compressive-strength results at 7/28 days, and maintaining the
// mix design library those results and both PDF reports are built from.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
// Broad read access for anyone who might reasonably need to see this data;
// writes are tightened per-route below.
router.use(requireAuth, requireRole("lab_technician", "qc_engineer", "manager", "administrator"));

// ===== Cube test batches =====

// Every cube batch (plant_qc row with cubes actually cast), with 7-day/28-day
// due status computed in SQL (recurring pattern #1 — never JS Date() for
// "is this overdue" logic).
router.get("/cube-batches", async (req, res) => {
  const { rows } = await query(
    `SELECT pq.id AS plant_qc_id, pq.ticket_id, pq.number_of_cubes, pq.sample_ids, pq.entered_at AS cast_at,
            dt.ticket_number, co.mix_grade_id, m.name AS mix_grade_name,
            c.name AS customer_name, s.name AS site_name,
            r7.id AS result_7day_id, r7.average_strength_mpa AS result_7day_strength,
            r28.id AS result_28day_id, r28.average_strength_mpa AS result_28day_strength,
            CASE WHEN r7.id IS NOT NULL THEN 'done'
                 WHEN CURRENT_DATE > (pq.entered_at::date + 7) THEN 'overdue'
                 WHEN CURRENT_DATE = (pq.entered_at::date + 7) THEN 'due_today'
                 ELSE 'upcoming' END AS status_7day,
            (pq.entered_at::date + 7) AS due_7day,
            CASE WHEN r28.id IS NOT NULL THEN 'done'
                 WHEN CURRENT_DATE > (pq.entered_at::date + 28) THEN 'overdue'
                 WHEN CURRENT_DATE = (pq.entered_at::date + 28) THEN 'due_today'
                 ELSE 'upcoming' END AS status_28day,
            (pq.entered_at::date + 28) AS due_28day
     FROM plant_qc pq
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN cube_test_results r7 ON r7.plant_qc_id = pq.id AND r7.testing_age_days = 7
     LEFT JOIN cube_test_results r28 ON r28.plant_qc_id = pq.id AND r28.testing_age_days = 28
     WHERE COALESCE(pq.number_of_cubes, 0) > 0
     ORDER BY pq.entered_at DESC
     LIMIT 200`
  );
  res.json(rows);
});

// One batch's detail, plus the approved mix designs for its grade (for the
// "compare against" dropdown) and the order's own resolved design, if any,
// as the sensible default.
router.get("/cube-batches/:plantQcId", async (req, res) => {
  const { rows } = await query(
    `SELECT pq.id AS plant_qc_id, pq.ticket_id, pq.number_of_cubes, pq.sample_ids, pq.entered_at AS cast_at,
            dt.ticket_number, co.id AS order_id, co.mix_grade_id, co.resolved_mix_design_id,
            m.name AS mix_grade_name, c.name AS customer_name, s.name AS site_name
     FROM plant_qc pq
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     WHERE pq.id = $1`,
    [req.params.plantQcId]
  );
  if (!rows.length) return res.status(404).json({ error: "Cube batch not found." });
  const batch = rows[0];

  const { rows: designs } = await query(
    `SELECT id, design_ref_code, mix_description FROM mix_designs
     WHERE mix_grade_id = $1 AND status = 'approved' ORDER BY design_ref_code`,
    [batch.mix_grade_id]
  );
  const { rows: results } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_weight_kg, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.average_strength_mpa, ctr.remarks, ctr.mix_design_id,
            u.name AS tested_by_name, ctr.tested_at
     FROM cube_test_results ctr JOIN users u ON u.id = ctr.tested_by
     WHERE ctr.plant_qc_id = $1 ORDER BY ctr.testing_age_days`,
    [batch.plant_qc_id]
  );
  res.json({ ...batch, approved_designs: designs, results });
});

// Submit (or replace) a cube batch's test result for one testing age.
// Averages are always recomputed here from the posted cubes, never trusted
// as-is from the client, so the stored average can't drift from what the
// per-cube rows actually say.
router.post("/cube-batches/:plantQcId/results", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { testing_age_days, mix_design_id, cubes, remarks } = req.body;
  if (![7, 28].includes(Number(testing_age_days))) {
    return res.status(400).json({ error: "Testing age must be 7 or 28 days." });
  }
  if (!Array.isArray(cubes) || cubes.length === 0) {
    return res.status(400).json({ error: "At least one cube's weight/load is required." });
  }
  const { rows: batchRows } = await query("SELECT id FROM plant_qc WHERE id = $1", [req.params.plantQcId]);
  if (!batchRows.length) return res.status(404).json({ error: "Cube batch not found." });

  const avg = (key) => {
    const vals = cubes.map((c) => Number(c[key])).filter((v) => !isNaN(v));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const avgWeight = avg("weight_kg");
  const avgLoad = avg("testing_load_kn");
  const avgDensity = avg("density_kgm3");
  const avgStrength = avg("strength_mpa");

  const { rows: resultRows } = await query(
    `INSERT INTO cube_test_results
      (plant_qc_id, testing_age_days, mix_design_id, average_weight_kg, average_load_kn,
       average_density_kgm3, average_strength_mpa, remarks, tested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (plant_qc_id, testing_age_days) DO UPDATE SET
       mix_design_id = $3, average_weight_kg = $4, average_load_kn = $5,
       average_density_kgm3 = $6, average_strength_mpa = $7, remarks = $8,
       tested_by = $9, tested_at = now()
     RETURNING id`,
    [req.params.plantQcId, testing_age_days, mix_design_id || null, avgWeight, avgLoad, avgDensity, avgStrength, remarks || null, req.user.id]
  );
  const resultId = resultRows[0].id;

  await query("DELETE FROM cube_test_cubes WHERE cube_test_result_id = $1", [resultId]);
  let i = 0;
  for (const c of cubes) {
    i += 1;
    await query(
      `INSERT INTO cube_test_cubes (cube_test_result_id, cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [resultId, c.cube_label || `Cube ${i}`, c.weight_kg || null, c.testing_load_kn || null, c.density_kgm3 || null, c.strength_mpa || null, i]
    );
  }
  res.status(201).json({ ok: true, result_id: resultId });
});

// Flat JSON for the client-side cube test PDF generator (mirrors the
// Delivery Challan PDF pattern — the PDF itself is built in the browser,
// nothing is rendered or stored server-side).
router.get("/cube-tests/:resultId/pdf-data", async (req, res) => {
  const { rows } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_weight_kg, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.average_strength_mpa, ctr.remarks, ctr.tested_at,
            u.name AS tested_by_name,
            pq.id AS plant_qc_id, pq.sample_ids, pq.entered_at AS cast_at, pq.number_of_cubes,
            dt.ticket_number,
            co.id AS order_id, co.casting_location, co.order_date,
            c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa, md.target_mean_strength_mpa
     FROM cube_test_results ctr
     JOIN users u ON u.id = ctr.tested_by
     JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
     WHERE ctr.id = $1`,
    [req.params.resultId]
  );
  if (!rows.length) return res.status(404).json({ error: "Test result not found." });
  const { rows: cubes } = await query(
    `SELECT cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa
     FROM cube_test_cubes WHERE cube_test_result_id = $1 ORDER BY sort_order`,
    [req.params.resultId]
  );
  res.json({ ...rows[0], cubes });
});

// ===== Mix designs =====

router.get("/mix-designs", async (req, res) => {
  const { status, mix_grade_id } = req.query;
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`md.status = $${params.length}`); }
  if (mix_grade_id) { params.push(mix_grade_id); conditions.push(`md.mix_grade_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT md.id, md.design_ref_code, md.mix_description, md.mix_grade_id, m.name AS mix_grade_name,
            md.fck_28day_mpa, md.target_mean_strength_mpa, md.status, md.is_standard_for_grade,
            md.revision, md.created_at, cu.name AS created_by_name,
            au.name AS approved_by_name, md.approved_at,
            (SELECT COUNT(*) FROM mix_design_assignments a WHERE a.mix_design_id = md.id) AS assigned_customer_count
     FROM mix_designs md
     JOIN mix_grades m ON m.id = md.mix_grade_id
     JOIN users cu ON cu.id = md.created_by
     LEFT JOIN users au ON au.id = md.approved_by
     ${where}
     ORDER BY md.created_at DESC`,
    params
  );
  res.json(rows);
});

router.get("/mix-designs/:id", async (req, res) => {
  const { rows } = await query(
    `SELECT md.*, m.name AS mix_grade_name, cu.name AS created_by_name, au.name AS approved_by_name
     FROM mix_designs md
     JOIN mix_grades m ON m.id = md.mix_grade_id
     JOIN users cu ON cu.id = md.created_by
     LEFT JOIN users au ON au.id = md.approved_by
     WHERE md.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Mix design not found." });
  const { rows: admixtures } = await query(
    `SELECT id, type_brand, dosage_pct_of_binder, qty_kgm3, sp_gr FROM mix_design_admixtures
     WHERE mix_design_id = $1 ORDER BY sort_order`,
    [req.params.id]
  );
  res.json({ ...rows[0], admixtures });
});

router.post("/mix-designs", requireRole("lab_technician", "administrator"), async (req, res) => {
  const b = req.body;
  const required = ["mix_grade_id", "design_ref_code", "fck_28day_mpa", "std_deviation_mpa", "cement_kgm3", "free_water_kgm3", "fine_agg_kgm3", "coarse_20mm_kgm3", "coarse_12_5mm_kgm3"];
  for (const key of required) {
    if (b[key] === undefined || b[key] === null || b[key] === "") {
      return res.status(400).json({ error: `${key.replaceAll("_", " ")} is required.` });
    }
  }
  const { rows: existing } = await query("SELECT id FROM mix_designs WHERE design_ref_code = $1", [b.design_ref_code]);
  if (existing.length) return res.status(400).json({ error: "A mix design with that reference code already exists." });

  const { rows } = await query(
    `INSERT INTO mix_designs
      (mix_grade_id, design_ref_code, mix_description, fck_28day_mpa, std_deviation_mpa, max_agg_size_mm,
       target_workability_mm, design_density_kgm3, cement_kgm3, fly_ash_kgm3, free_water_kgm3,
       fine_agg_kgm3, coarse_20mm_kgm3, coarse_12_5mm_kgm3,
       cement_type_source, cement_sp_gr, fly_ash_type_source, fly_ash_sp_gr,
       fine_agg_type_source, fine_agg_sp_gr, coarse_20mm_type_source, coarse_20mm_sp_gr,
       coarse_12_5mm_type_source, coarse_12_5mm_sp_gr,
       fine_moisture_pct, fine_absorption_pct, coarse_20mm_moisture_pct, coarse_20mm_absorption_pct,
       coarse_12_5mm_moisture_pct, coarse_12_5mm_absorption_pct, revision, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
     RETURNING id`,
    [b.mix_grade_id, b.design_ref_code, b.mix_description || null, b.fck_28day_mpa, b.std_deviation_mpa, b.max_agg_size_mm || null,
     b.target_workability_mm || null, b.design_density_kgm3 || null, b.cement_kgm3, b.fly_ash_kgm3 || 0, b.free_water_kgm3,
     b.fine_agg_kgm3, b.coarse_20mm_kgm3, b.coarse_12_5mm_kgm3,
     b.cement_type_source || null, b.cement_sp_gr || null, b.fly_ash_type_source || null, b.fly_ash_sp_gr || null,
     b.fine_agg_type_source || null, b.fine_agg_sp_gr || null, b.coarse_20mm_type_source || null, b.coarse_20mm_sp_gr || null,
     b.coarse_12_5mm_type_source || null, b.coarse_12_5mm_sp_gr || null,
     b.fine_moisture_pct || null, b.fine_absorption_pct || null, b.coarse_20mm_moisture_pct || null, b.coarse_20mm_absorption_pct || null,
     b.coarse_12_5mm_moisture_pct || null, b.coarse_12_5mm_absorption_pct || null, b.revision || "00", b.notes || null, req.user.id]
  );
  const designId = rows[0].id;

  const admixtures = Array.isArray(b.admixtures) ? b.admixtures : [];
  let i = 0;
  for (const a of admixtures) {
    if (!a.type_brand || !a.qty_kgm3) continue;
    i += 1;
    await query(
      `INSERT INTO mix_design_admixtures (mix_design_id, type_brand, dosage_pct_of_binder, qty_kgm3, sp_gr, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [designId, a.type_brand, a.dosage_pct_of_binder || null, a.qty_kgm3, a.sp_gr || null, i]
    );
  }
  res.status(201).json({ id: designId });
});

// A draft needs a second, different person to approve it — either another
// Lab Technician or a QC lead (QC Engineer/Manager/Administrator).
router.post("/mix-designs/:id/approve", requireRole("lab_technician", "qc_engineer", "manager", "administrator"), async (req, res) => {
  const { rows } = await query("SELECT id, created_by, status FROM mix_designs WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Mix design not found." });
  const design = rows[0];
  if (design.status === "approved") return res.status(400).json({ error: "Already approved." });
  if (design.created_by === req.user.id) {
    return res.status(400).json({ error: "The design's own creator can't approve it — a second person needs to sign off." });
  }
  await query(
    `UPDATE mix_designs SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2`,
    [req.user.id, req.params.id]
  );
  res.json({ ok: true });
});

// Flat JSON for the client-side mix design PDF generator.
router.get("/mix-designs/:id/pdf-data", async (req, res) => {
  const { rows } = await query(
    `SELECT md.*, m.name AS mix_grade_name, cu.name AS created_by_name, au.name AS approved_by_name
     FROM mix_designs md
     JOIN mix_grades m ON m.id = md.mix_grade_id
     JOIN users cu ON cu.id = md.created_by
     LEFT JOIN users au ON au.id = md.approved_by
     WHERE md.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Mix design not found." });
  const { rows: admixtures } = await query(
    `SELECT type_brand, dosage_pct_of_binder, qty_kgm3, sp_gr FROM mix_design_admixtures
     WHERE mix_design_id = $1 ORDER BY sort_order`,
    [req.params.id]
  );
  res.json({ ...rows[0], admixtures });
});

export default router;
