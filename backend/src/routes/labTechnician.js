// Lab Technician (round 118) — new role, separate from QC Engineer.
// QC Engineer keeps doing plant-side fresh-concrete QC (slump/temp, cube
// casting) exactly as before — a plant_qc row is just a delivery ticket that
// already has cubes cast against it (number_of_cubes > 0); nothing new is
// captured at casting time. Lab Technician owns everything downstream:
// recording compressive-strength results at 7/28 days, and maintaining the
// mix design library those results and both PDF reports are built from.
// Round 122 — that downstream testing moved from per-DN to per-POUR (the
// order); see the "Cube testing, pour-basis" section below for the full
// reasoning.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { resolveCubeTestDnSummary } from "../lib/cubeTestDns.js";

const router = Router();
// Broad read access for anyone who might reasonably need to see this data;
// writes are tightened per-route below.
router.use(requireAuth, requireRole("lab_technician", "qc_engineer", "manager", "administrator"));

// Round 121, item 4 — order picker for "+ Record a site cast" (the only
// place Lab Technician manually picks an order, since a site cast has no
// delivery ticket to derive it from). The generic GET /orders list used
// elsewhere still includes an order right up until it's ever delivered
// against (and, within its 1-day carry-forward window, even after being
// cancelled/closed with zero supply) — exactly the case that shouldn't be
// selectable here: cubes can only ever have been cast at a site for concrete
// that actually reached it. Filtered here, not on the shared route, so nothing
// else in the app (which legitimately wants to see a just-created order with
// no deliveries yet) is affected.
router.get("/orders-with-supply", async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.order_date, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status != 'cancelled'), 0) AS delivered_qty_m3
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     JOIN delivery_tickets dt ON dt.order_id = o.id
     GROUP BY o.id, c.name, s.name, m.name
     HAVING COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status != 'cancelled'), 0) > 0
     ORDER BY o.order_date DESC, o.id DESC
     LIMIT 300`
  );
  res.json(rows);
});

// ===== Cube testing, pour-basis (round 122) =====
// Cube testing is now grouped and entered by POUR (the customer_orders row),
// not by individual delivery note — a pour is usually served by several
// trucks/DNs, and cubes cast against any of them are one shared batch as far
// as compressive-strength testing goes. QC Engineer's own plant-side capture
// is completely unchanged (still one plant_qc row per delivery ticket, cubes
// cast and counted there); only how Lab Technician tests them changes.
//
// A NEW-style cube_test_results row belongs to the pour as a whole:
// order_id is set, plant_qc_id is NULL (see schema.sql's comment on that
// column and the partial unique index idx_cube_test_results_pour). A row
// entered before this round keeps its old shape (plant_qc_id set, one DN's
// own result) and is never migrated or touched — every route below treats
// those as "legacy" and keeps surfacing them so nothing already recorded
// drops out of view.

// Every pour (order) that has at least one plant_qc row with cubes actually
// cast, with 7-day/28-day due status computed in SQL (recurring pattern #1
// — never JS Date() for "is this overdue" logic). "poured_at" is the
// EARLIEST cube-casting time across the pour's DNs — the conservative choice
// for a due-date anchor, so a due date never lands later than it would have
// under the old per-DN model.
router.get("/cube-pours", async (req, res) => {
  // Three dashboard buckets so the default (active) list doesn't get
  // cluttered by pours that are already fully tested or that were
  // deliberately closed out — "completed"/"closed" are their own views, not
  // just filtered client-side, so the active list stays the default even as
  // the pour count grows. Bucket is computed here, not stored, so it can
  // never drift from the underlying test results.
  const view = ["active", "completed", "closed"].includes(req.query.view) ? req.query.view : "active";
  const { rows } = await query(
    `SELECT * FROM (
       WITH pour_batches AS (
         SELECT co.id AS order_id, m.name AS mix_grade_name, c.name AS customer_name, s.name AS site_name,
                MIN(pq.entered_at) AS poured_at, COUNT(DISTINCT pq.id) AS dn_count,
                COALESCE(SUM(pq.number_of_cubes), 0) AS total_cubes
         FROM plant_qc pq
         JOIN delivery_tickets dt ON dt.id = pq.ticket_id
         JOIN customer_orders co ON co.id = dt.order_id
         JOIN customers c ON c.id = co.customer_id
         JOIN sites s ON s.id = co.site_id
         JOIN mix_grades m ON m.id = co.mix_grade_id
         WHERE COALESCE(pq.number_of_cubes, 0) > 0
         GROUP BY co.id, m.name, c.name, s.name
       ),
       legacy_results AS (
         -- Any pre-round-122 DN-level result, rolled up to its order — the
         -- most recently tested one per order+age stands in for the list's
         -- badges until that pour gets its own shared pour-level result.
         SELECT DISTINCT ON (dt.order_id, ctr.testing_age_days)
                dt.order_id, ctr.testing_age_days, ctr.average_strength_mpa AS strength
         FROM cube_test_results ctr
         JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
         JOIN delivery_tickets dt ON dt.id = pq.ticket_id
         ORDER BY dt.order_id, ctr.testing_age_days, ctr.tested_at DESC
       )
       SELECT pb.order_id, pb.mix_grade_name, pb.customer_name, pb.site_name, pb.poured_at, pb.dn_count, pb.total_cubes,
              pr7.id AS result_7day_id, pr7.average_strength_mpa AS result_7day_strength,
              pr28.id AS result_28day_id, pr28.average_strength_mpa AS result_28day_strength,
              leg7.strength AS legacy_7day_strength, leg28.strength AS legacy_28day_strength,
              cps.closed_reason, cps.closed_at, cu.name AS closed_by_name,
              CASE WHEN cps.order_id IS NOT NULL THEN 'closed'
                   WHEN (pr7.id IS NOT NULL OR leg7.strength IS NOT NULL)
                    AND (pr28.id IS NOT NULL OR leg28.strength IS NOT NULL) THEN 'completed'
                   ELSE 'active' END AS view_bucket,
              CASE WHEN pr7.id IS NOT NULL OR leg7.strength IS NOT NULL THEN 'done'
                   WHEN CURRENT_DATE > (pb.poured_at::date + 7) THEN 'overdue'
                   WHEN CURRENT_DATE = (pb.poured_at::date + 7) THEN 'due_today'
                   ELSE 'upcoming' END AS status_7day,
              (pb.poured_at::date + 7) AS due_7day,
              CASE WHEN pr28.id IS NOT NULL OR leg28.strength IS NOT NULL THEN 'done'
                   WHEN CURRENT_DATE > (pb.poured_at::date + 28) THEN 'overdue'
                   WHEN CURRENT_DATE = (pb.poured_at::date + 28) THEN 'due_today'
                   ELSE 'upcoming' END AS status_28day,
              (pb.poured_at::date + 28) AS due_28day
       FROM pour_batches pb
       LEFT JOIN cube_test_results pr7 ON pr7.order_id = pb.order_id AND pr7.testing_age_days = 7 AND pr7.plant_qc_id IS NULL
       LEFT JOIN cube_test_results pr28 ON pr28.order_id = pb.order_id AND pr28.testing_age_days = 28 AND pr28.plant_qc_id IS NULL
       LEFT JOIN legacy_results leg7 ON leg7.order_id = pb.order_id AND leg7.testing_age_days = 7
       LEFT JOIN legacy_results leg28 ON leg28.order_id = pb.order_id AND leg28.testing_age_days = 28
       LEFT JOIN cube_pour_status cps ON cps.order_id = pb.order_id
       LEFT JOIN users cu ON cu.id = cps.closed_by
     ) t
     WHERE view_bucket = $1
     ORDER BY poured_at DESC
     LIMIT 200`,
    [view]
  );
  res.json(rows);
});

// One pour's detail: every DN that had cubes cast for it (the reference list
// shown before entering a shared result — see the mockup's "Cube samples for
// this pour"), the approved designs for its grade, and every result on file
// for it — new pour-level rows plus any legacy per-DN rows still on record
// (see the file header comment).
router.get("/cube-pours/:orderId", async (req, res) => {
  const { rows: orderRows } = await query(
    `SELECT co.id AS order_id, co.mix_grade_id, co.resolved_mix_design_id,
            m.name AS mix_grade_name, c.name AS customer_name, s.name AS site_name,
            cps.closed_reason, cps.closed_at, cu.name AS closed_by_name, (cps.order_id IS NOT NULL) AS is_closed
     FROM customer_orders co
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN cube_pour_status cps ON cps.order_id = co.id
     LEFT JOIN users cu ON cu.id = cps.closed_by
     WHERE co.id = $1`,
    [req.params.orderId]
  );
  if (!orderRows.length) return res.status(404).json({ error: "Order not found." });
  const order = orderRows[0];

  const { rows: dns } = await query(
    `SELECT pq.id AS plant_qc_id, pq.number_of_cubes, pq.sample_ids, pq.entered_at AS cast_at,
            dt.ticket_number, tr.truck_number
     FROM plant_qc pq
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     LEFT JOIN trucks tr ON tr.id = dt.truck_id
     WHERE dt.order_id = $1 AND COALESCE(pq.number_of_cubes, 0) > 0
     ORDER BY pq.entered_at`,
    [req.params.orderId]
  );
  if (!dns.length) return res.status(404).json({ error: "No cube-cast delivery notes found for this order." });

  const { rows: designs } = await query(
    `SELECT id, design_ref_code, mix_description FROM mix_designs
     WHERE mix_grade_id = $1 AND status = 'approved' ORDER BY design_ref_code`,
    [order.mix_grade_id]
  );
  const { rows: results } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_weight_kg, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.average_strength_mpa, ctr.remarks, ctr.mix_design_id,
            ctr.failure_type, ctr.visible_to_customer, u.name AS tested_by_name, ctr.tested_at,
            (ctr.plant_qc_id IS NULL) AS is_pour_level
     FROM cube_test_results ctr JOIN users u ON u.id = ctr.tested_by
     WHERE (ctr.order_id = $1 AND ctr.plant_qc_id IS NULL) OR ctr.plant_qc_id = ANY($2::int[])
     ORDER BY ctr.testing_age_days, ctr.tested_at`,
    [req.params.orderId, dns.map((d) => d.plant_qc_id)]
  );
  res.json({ ...order, dns, approved_designs: designs, results });
});

// Round 120, item 4a — Lab Technician/Administrator toggles whether one
// result is shown in the customer module. Defaults true (see the schema
// migration), so this is only ever hit to actively hide something. Works
// unchanged for a pour-level or a legacy result — it only ever touches the
// one row by its own id.
router.patch("/cube-tests/:resultId/visibility", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { rows } = await query(
    `UPDATE cube_test_results SET visible_to_customer = $1 WHERE id = $2 RETURNING id`,
    [!!req.body.visible_to_customer, req.params.resultId]
  );
  if (!rows.length) return res.status(404).json({ error: "Test result not found." });
  res.json({ ok: true });
});

// Close a pour that isn't going to be tested (cubes damaged, order
// cancelled, etc.) — a pure dashboard/workflow marker, doesn't touch
// plant_qc or any cube_test_results row, and never destroys anything: a
// closed pour can always be reopened. Parallel to (but independent of) the
// older per-DN cube_batch_status, which stays untouched for any DN closed
// out under the pre-round-122 model.
router.post("/cube-pours/:orderId/close", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { reason } = req.body;
  const { rows: orderRows } = await query("SELECT id FROM customer_orders WHERE id = $1", [req.params.orderId]);
  if (!orderRows.length) return res.status(404).json({ error: "Order not found." });
  await query(
    `INSERT INTO cube_pour_status (order_id, closed_reason, closed_by, closed_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (order_id) DO UPDATE SET closed_reason = $2, closed_by = $3, closed_at = now()`,
    [req.params.orderId, reason || null, req.user.id]
  );
  res.json({ ok: true });
});

router.post("/cube-pours/:orderId/reopen", requireRole("lab_technician", "administrator"), async (req, res) => {
  await query("DELETE FROM cube_pour_status WHERE order_id = $1", [req.params.orderId]);
  res.json({ ok: true });
});

// ===== Raw material stock =====
// Moved here from QC Engineer (round 118 refinement, per explicit request)
// — QC Engineer no longer has write access to this at all. Still shown
// read-only on Manager/Administrator dashboards via GET /master/raw-material-stock,
// unchanged. Same shared-PIN protection as before it moved.
router.put("/raw-material-stock", requireRole("lab_technician"), async (req, res) => {
  const configuredPin = process.env.RAW_MATERIAL_STOCK_PIN;
  if (configuredPin && req.body.pin !== configuredPin) {
    return res.status(403).json({ error: "Incorrect PIN." });
  }

  const updates = req.body.rows || [];
  for (const row of updates) {
    await query(
      `UPDATE raw_material_stock SET type_brand = $1, stock_qty = $2, qty_on_order = $3, expected_delivery_date = $4,
         updated_by = $5, updated_at = now()
       WHERE id = $6`,
      [row.type_brand || null, row.stock_qty || 0, row.qty_on_order || 0, row.expected_delivery_date || null, req.user.id, row.id]
    );
  }
  const { rows } = await query(
    `SELECT s.id, s.bin_name, s.unit, s.type_brand, s.stock_qty, s.qty_on_order, s.expected_delivery_date, s.updated_at, u.name AS updated_by_name
     FROM raw_material_stock s LEFT JOIN users u ON u.id = s.updated_by
     ORDER BY s.id`
  );
  res.json(rows);
});

// Submit (or replace) a pour's shared test result for one testing age.
// `groups` is one entry per contributing DN — {plant_qc_id, cubes: [...]} —
// matching the mockup's "From DN <ticket>" sub-sections; cubes are flattened
// across every group before averaging (recomputed here, never trusted as-is
// from the client, same rule every other averaged figure in this app
// follows), and each cube keeps which DN it was pulled from
// (cube_test_cubes.plant_qc_id) for the PDF/report's own provenance, even
// though the human-readable cube_label the Lab Technician types already
// spells the DN out too (e.g. "TCK-2208 · Cube 1").
router.post("/cube-pours/:orderId/results", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { testing_age_days, mix_design_id, groups, remarks, failure_type } = req.body;
  if (![7, 28].includes(Number(testing_age_days))) {
    return res.status(400).json({ error: "Testing age must be 7 or 28 days." });
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: "At least one DN's cubes are required." });
  }
  const { rows: orderRows } = await query("SELECT id FROM customer_orders WHERE id = $1", [req.params.orderId]);
  if (!orderRows.length) return res.status(404).json({ error: "Order not found." });
  const { rows: closedRows } = await query("SELECT 1 FROM cube_pour_status WHERE order_id = $1", [req.params.orderId]);
  if (closedRows.length) return res.status(400).json({ error: "This pour is closed — reopen it first." });

  // Every group's plant_qc_id must actually belong to this order — the
  // checklist the frontend builds it from is already scoped to this pour's
  // own DNs, but this is cheap insurance against a stale client.
  const { rows: validDns } = await query(
    `SELECT pq.id FROM plant_qc pq JOIN delivery_tickets dt ON dt.id = pq.ticket_id WHERE dt.order_id = $1`,
    [req.params.orderId]
  );
  const validIds = new Set(validDns.map((r) => r.id));
  const flatCubes = [];
  for (const g of groups) {
    if (!validIds.has(Number(g.plant_qc_id))) {
      return res.status(400).json({ error: "One of the selected DNs doesn't belong to this order." });
    }
    for (const c of (g.cubes || [])) flatCubes.push({ ...c, plant_qc_id: Number(g.plant_qc_id) });
  }
  if (flatCubes.length === 0) {
    return res.status(400).json({ error: "At least one cube's weight/load is required." });
  }

  const avg = (key) => {
    const vals = flatCubes.map((c) => Number(c[key])).filter((v) => !isNaN(v));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const avgWeight = avg("weight_kg");
  const avgLoad = avg("testing_load_kn");
  const avgDensity = avg("density_kgm3");
  const avgStrength = avg("strength_mpa");

  const { rows: resultRows } = await query(
    `INSERT INTO cube_test_results
      (order_id, plant_qc_id, testing_age_days, mix_design_id, average_weight_kg, average_load_kn,
       average_density_kgm3, average_strength_mpa, remarks, failure_type, tested_by)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (order_id, testing_age_days) WHERE plant_qc_id IS NULL DO UPDATE SET
       mix_design_id = $3, average_weight_kg = $4, average_load_kn = $5,
       average_density_kgm3 = $6, average_strength_mpa = $7, remarks = $8,
       failure_type = $9, tested_by = $10, tested_at = now()
     RETURNING id`,
    [req.params.orderId, testing_age_days, mix_design_id || null, avgWeight, avgLoad, avgDensity, avgStrength, remarks || null, failure_type || null, req.user.id]
  );
  const resultId = resultRows[0].id;

  await query("DELETE FROM cube_test_cubes WHERE cube_test_result_id = $1", [resultId]);
  let i = 0;
  for (const c of flatCubes) {
    i += 1;
    await query(
      `INSERT INTO cube_test_cubes (cube_test_result_id, plant_qc_id, cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [resultId, c.plant_qc_id, c.cube_label || `Cube ${i}`, c.weight_kg || null, c.testing_load_kn || null, c.density_kgm3 || null, c.strength_mpa || null, i]
    );
  }
  res.status(201).json({ ok: true, result_id: resultId });
});

// ===== Site-cast cube tests (round 120, items 4b/4e) =====
// Cubes prepared AT THE CUSTOMER'S SITE rather than plant-cast — a genuinely
// separate workflow since there's no delivery ticket to anchor a batch to.
// A "site cube cast" plays the same role plant_qc plays for a plant batch;
// everything below deliberately mirrors the (pre-round-122, single-DN) plant
// cube-batches shape — same averaging-recomputed-server-side rule, same
// visibility-toggle pattern — just anchored to an order instead of a ticket.
// It's deliberately NOT folded into the pour-basis routes above: a site cast
// already has exactly one order behind it and no DN to group by, so there's
// nothing pour-basis testing would add here.

router.get("/site-cube-casts", async (req, res) => {
  const { rows } = await query(
    `SELECT scc.id AS cast_id, scc.order_id, scc.cast_date, scc.number_of_cubes, scc.sample_ids, scc.entered_at,
            co.mix_grade_id, m.name AS mix_grade_name, c.name AS customer_name, s.name AS site_name,
            r7.id AS result_7day_id, r7.average_strength_mpa AS result_7day_strength,
            r28.id AS result_28day_id, r28.average_strength_mpa AS result_28day_strength
     FROM site_cube_casts scc
     JOIN customer_orders co ON co.id = scc.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN site_cube_test_results r7 ON r7.site_cube_cast_id = scc.id AND r7.testing_age_days = 7
     LEFT JOIN site_cube_test_results r28 ON r28.site_cube_cast_id = scc.id AND r28.testing_age_days = 28
     ORDER BY scc.entered_at DESC
     LIMIT 200`
  );
  res.json(rows);
});

router.post("/site-cube-casts", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { order_id, cast_date, number_of_cubes, sample_ids, remarks } = req.body;
  if (!order_id || !cast_date) {
    return res.status(400).json({ error: "Order and cast date are required." });
  }
  const { rows: orderCheck } = await query("SELECT id FROM customer_orders WHERE id = $1", [order_id]);
  if (!orderCheck.length) return res.status(404).json({ error: "Order not found." });
  const { rows } = await query(
    `INSERT INTO site_cube_casts (order_id, cast_date, number_of_cubes, sample_ids, remarks, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [order_id, cast_date, number_of_cubes || null, sample_ids || null, remarks || null, req.user.id]
  );
  res.status(201).json({ id: rows[0].id });
});

router.get("/site-cube-casts/:castId", async (req, res) => {
  const { rows } = await query(
    `SELECT scc.id AS cast_id, scc.order_id, scc.cast_date, scc.number_of_cubes, scc.sample_ids, scc.remarks, scc.entered_at,
            co.mix_grade_id, co.resolved_mix_design_id, co.casting_location, co.order_date,
            m.name AS mix_grade_name, c.name AS customer_name, s.name AS site_name, s.address AS site_address
     FROM site_cube_casts scc
     JOIN customer_orders co ON co.id = scc.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     WHERE scc.id = $1`,
    [req.params.castId]
  );
  if (!rows.length) return res.status(404).json({ error: "Site cube cast not found." });
  const batch = rows[0];

  const { rows: designs } = await query(
    `SELECT id, design_ref_code, mix_description FROM mix_designs
     WHERE mix_grade_id = $1 AND status = 'approved' ORDER BY design_ref_code`,
    [batch.mix_grade_id]
  );
  const { rows: results } = await query(
    `SELECT sctr.id, sctr.testing_age_days, sctr.average_weight_kg, sctr.average_load_kn,
            sctr.average_density_kgm3, sctr.average_strength_mpa, sctr.remarks, sctr.mix_design_id,
            sctr.failure_type, sctr.visible_to_customer, u.name AS tested_by_name, sctr.tested_at
     FROM site_cube_test_results sctr JOIN users u ON u.id = sctr.tested_by
     WHERE sctr.site_cube_cast_id = $1 ORDER BY sctr.testing_age_days`,
    [batch.cast_id]
  );
  res.json({ ...batch, approved_designs: designs, results });
});

// Round 121, item 5 — delete a wrongly-entered site cast (e.g. logged
// against the wrong order, or duplicated). Unlike a plant batch (which is
// only ever "closed," never deleted, since it's tied to a real delivery
// ticket that stays on record either way), a site cast has no ticket behind
// it, so a genuine mis-entry has no other record to fall back on — deleting
// it outright is the correct fix, not a status flag. Removes any test
// results/cubes entered against it first (no ON DELETE CASCADE from
// site_cube_test_results to site_cube_casts in the schema, by design — this
// keeps a plain accidental-click DELETE on a *test result* from silently
// taking the whole cast with it).
router.delete("/site-cube-casts/:castId", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { rows: castRows } = await query("SELECT id FROM site_cube_casts WHERE id = $1", [req.params.castId]);
  if (!castRows.length) return res.status(404).json({ error: "Site cube cast not found." });
  await query(
    `DELETE FROM site_cube_test_results WHERE site_cube_cast_id = $1`,
    [req.params.castId]
  ); // cascades to site_cube_test_cubes via its own ON DELETE CASCADE
  await query("DELETE FROM site_cube_casts WHERE id = $1", [req.params.castId]);
  res.json({ ok: true });
});

router.post("/site-cube-casts/:castId/results", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { testing_age_days, mix_design_id, cubes, remarks, failure_type } = req.body;
  if (![7, 28].includes(Number(testing_age_days))) {
    return res.status(400).json({ error: "Testing age must be 7 or 28 days." });
  }
  if (!Array.isArray(cubes) || cubes.length === 0) {
    return res.status(400).json({ error: "At least one cube's weight/load is required." });
  }
  const { rows: castRows } = await query("SELECT id FROM site_cube_casts WHERE id = $1", [req.params.castId]);
  if (!castRows.length) return res.status(404).json({ error: "Site cube cast not found." });

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
    `INSERT INTO site_cube_test_results
      (site_cube_cast_id, testing_age_days, mix_design_id, average_weight_kg, average_load_kn,
       average_density_kgm3, average_strength_mpa, remarks, failure_type, tested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (site_cube_cast_id, testing_age_days) DO UPDATE SET
       mix_design_id = $3, average_weight_kg = $4, average_load_kn = $5,
       average_density_kgm3 = $6, average_strength_mpa = $7, remarks = $8,
       failure_type = $9, tested_by = $10, tested_at = now()
     RETURNING id`,
    [req.params.castId, testing_age_days, mix_design_id || null, avgWeight, avgLoad, avgDensity, avgStrength, remarks || null, failure_type || null, req.user.id]
  );
  const resultId = resultRows[0].id;

  await query("DELETE FROM site_cube_test_cubes WHERE site_cube_test_result_id = $1", [resultId]);
  let i = 0;
  for (const c of cubes) {
    i += 1;
    await query(
      `INSERT INTO site_cube_test_cubes (site_cube_test_result_id, cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [resultId, c.cube_label || `Cube ${i}`, c.weight_kg || null, c.testing_load_kn || null, c.density_kgm3 || null, c.strength_mpa || null, i]
    );
  }
  res.status(201).json({ ok: true, result_id: resultId });
});

// Round 120, item 4a — same toggle as the plant-cast one above, mirrored for
// site-cast results.
router.patch("/site-cube-tests/:resultId/visibility", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { rows } = await query(
    `UPDATE site_cube_test_results SET visible_to_customer = $1 WHERE id = $2 RETURNING id`,
    [!!req.body.visible_to_customer, req.params.resultId]
  );
  if (!rows.length) return res.status(404).json({ error: "Test result not found." });
  res.json({ ok: true });
});

// Flat JSON for the client-side PDF generator — same shape as the plant
// cube-tests/:resultId/pdf-data below, minus the ticket_number a site-cast
// batch doesn't have.
router.get("/site-cube-tests/:resultId/pdf-data", async (req, res) => {
  const { rows } = await query(
    `SELECT sctr.id, sctr.testing_age_days, sctr.average_weight_kg, sctr.average_load_kn,
            sctr.average_density_kgm3, sctr.average_strength_mpa, sctr.remarks, sctr.failure_type, sctr.tested_at,
            u.name AS tested_by_name,
            scc.id AS site_cube_cast_id, scc.sample_ids, scc.cast_date, scc.number_of_cubes,
            co.id AS order_id, co.casting_location, co.order_date,
            c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa, md.target_mean_strength_mpa
     FROM site_cube_test_results sctr
     JOIN users u ON u.id = sctr.tested_by
     JOIN site_cube_casts scc ON scc.id = sctr.site_cube_cast_id
     JOIN customer_orders co ON co.id = scc.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = sctr.mix_design_id
     WHERE sctr.id = $1`,
    [req.params.resultId]
  );
  if (!rows.length) return res.status(404).json({ error: "Test result not found." });
  const { rows: cubes } = await query(
    `SELECT cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa
     FROM site_cube_test_cubes WHERE site_cube_test_result_id = $1 ORDER BY sort_order`,
    [req.params.resultId]
  );
  res.json({ ...rows[0], cubes, is_site_cast: true });
});

// Correct a saved test's recorded date — administrator only. Exists purely
// for after-the-fact data-entry corrections (a result entered days later
// but back-dated to when the test actually happened, or a typo caught after
// saving); it does not re-run any of the averaging logic above.
// Correct a saved test's recorded date — administrator only. order_id is
// backfilled on every row (legacy or pour-level, see the schema migration),
// so this one WHERE works uniformly regardless of which shape the result is.
router.patch("/cube-pours/:orderId/results/:resultId/date", requireRole("administrator"), async (req, res) => {
  const { tested_at } = req.body;
  const parsed = tested_at ? new Date(tested_at) : null;
  if (!parsed || isNaN(parsed)) {
    return res.status(400).json({ error: "A valid test date is required." });
  }
  const { rows } = await query(
    `UPDATE cube_test_results SET tested_at = $1
     WHERE id = $2 AND order_id = $3
     RETURNING id`,
    [parsed.toISOString(), req.params.resultId, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Test result not found." });
  res.json({ ok: true });
});

// Flat JSON for the client-side cube test PDF generator (mirrors the
// Delivery Challan PDF pattern — the PDF itself is built in the browser,
// nothing is rendered or stored server-side). Joins to the order via
// ctr.order_id directly (populated for both legacy and pour-level rows) so
// this works for either shape without branching; the DN-level fields the PDF
// wants (ticket number(s), sample IDs, casting time) come from the shared
// resolveCubeTestDnSummary helper, which already knows how to summarize
// across however many DNs a pour-level result actually drew from.
router.get("/cube-tests/:resultId/pdf-data", async (req, res) => {
  const { rows } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_weight_kg, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.average_strength_mpa, ctr.remarks, ctr.failure_type, ctr.tested_at,
            ctr.visible_to_customer, (ctr.plant_qc_id IS NULL) AS is_pour_level,
            u.name AS tested_by_name,
            co.id AS order_id, co.casting_location, co.order_date,
            c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa, md.target_mean_strength_mpa
     FROM cube_test_results ctr
     JOIN users u ON u.id = ctr.tested_by
     JOIN customer_orders co ON co.id = ctr.order_id
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
  const dnSummary = await resolveCubeTestDnSummary(req.params.resultId);
  res.json({ ...rows[0], ...dnSummary, number_of_cubes: cubes.length, cubes, is_site_cast: false });
});

// Configurable summary table across every cube test result — date range,
// customer, grade, and design ref code, any combination. Restricted to
// Lab Technician + Administrator only (tighter than this router's general
// read access above) since this is a cross-batch report, not a single
// batch's own detail.
//
// Round 120, item 4d — "pour-based reporting" first shipped as a
// reporting-layer-only change (`order_id` on every row so the frontend,
// CubeTestReport.jsx, could group by order/pour for display) while casting
// and testing stayed per-DN underneath. Round 122 made that real: a plant
// row's own `order_id`/`ticket_number`/`sample_ids`/`cast_at` below now
// resolve correctly whether the underlying result is pour-level or a legacy
// per-DN one (see the COALESCE subqueries), so this report needed no other
// change to keep working across both.
// Round 120, items 4b/4e — UNIONed with site_cube_test_results (cubes cast
// at the customer's site rather than the plant) so this one report covers
// both; `source` tells the two apart since they don't share an id space.
router.get("/cube-test-report", requireRole("lab_technician", "administrator"), async (req, res) => {
  const { from_date, to_date, customer_id, mix_grade_id, design_ref_code, testing_age_days } = req.query;
  const conditions = [];
  const params = [];
  if (from_date) { params.push(from_date); conditions.push(`ctr.tested_at::date >= $${params.length}`); }
  if (to_date) { params.push(to_date); conditions.push(`ctr.tested_at::date <= $${params.length}`); }
  if (customer_id) { params.push(customer_id); conditions.push(`c.id = $${params.length}`); }
  if (mix_grade_id) { params.push(mix_grade_id); conditions.push(`m.id = $${params.length}`); }
  if (design_ref_code) { params.push(`%${design_ref_code}%`); conditions.push(`md.design_ref_code ILIKE $${params.length}`); }
  if ([7, 28].includes(Number(testing_age_days))) { params.push(Number(testing_age_days)); conditions.push(`ctr.testing_age_days = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await query(
    `SELECT 'plant' AS source, ctr.id, co.id AS order_id, ctr.testing_age_days, ctr.average_strength_mpa, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.failure_type, ctr.remarks, ctr.tested_at, ctr.visible_to_customer,
            u.name AS tested_by_name,
            co.id AS batch_id,
            COALESCE(pq.entered_at, (
              SELECT MIN(pq2.entered_at) FROM cube_test_cubes ctc
              JOIN plant_qc pq2 ON pq2.id = ctc.plant_qc_id
              WHERE ctc.cube_test_result_id = ctr.id
            )) AS cast_at,
            COALESCE(pq.sample_ids, (
              SELECT string_agg(DISTINCT pq2.sample_ids, ', ') FROM cube_test_cubes ctc
              JOIN plant_qc pq2 ON pq2.id = ctc.plant_qc_id
              WHERE ctc.cube_test_result_id = ctr.id AND pq2.sample_ids IS NOT NULL
            )) AS sample_ids,
            COALESCE(dt.ticket_number, (
              SELECT string_agg(DISTINCT dt2.ticket_number, ', ') FROM cube_test_cubes ctc
              JOIN plant_qc pq2 ON pq2.id = ctc.plant_qc_id
              JOIN delivery_tickets dt2 ON dt2.id = pq2.ticket_id
              WHERE ctc.cube_test_result_id = ctr.id
            )) AS ticket_number,
            c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name,
            m.id AS mix_grade_id, m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa,
            CASE WHEN ctr.testing_age_days = 28 AND md.fck_28day_mpa IS NOT NULL
                 THEN (ctr.average_strength_mpa >= md.fck_28day_mpa) END AS meets_target
     FROM cube_test_results ctr
     JOIN users u ON u.id = ctr.tested_by
     JOIN customer_orders co ON co.id = ctr.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     LEFT JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
     ${where}
     UNION ALL
     SELECT 'site' AS source, ctr.id, co.id AS order_id, ctr.testing_age_days, ctr.average_strength_mpa, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.failure_type, ctr.remarks, ctr.tested_at, ctr.visible_to_customer,
            u.name AS tested_by_name,
            scc.id AS batch_id, scc.cast_date::timestamptz AS cast_at, scc.sample_ids,
            NULL AS ticket_number,
            c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name,
            m.id AS mix_grade_id, m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa,
            CASE WHEN ctr.testing_age_days = 28 AND md.fck_28day_mpa IS NOT NULL
                 THEN (ctr.average_strength_mpa >= md.fck_28day_mpa) END AS meets_target
     FROM site_cube_test_results ctr
     JOIN users u ON u.id = ctr.tested_by
     JOIN site_cube_casts scc ON scc.id = ctr.site_cube_cast_id
     JOIN customer_orders co ON co.id = scc.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
     ${where}
     ORDER BY tested_at DESC
     LIMIT 1000`,
    // Both halves of the UNION ALL reuse the exact same \`where\` text (built
    // once above, with matching aliases in both SELECTs — ctr/c/m/md — so the
    // same $N placeholders apply to both), so the same params array covers
    // both; there's no separate second set of placeholders to fill.
    params
  );
  res.json(rows);
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
            md.revision, md.created_at, md.created_by, cu.name AS created_by_name,
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

  // Dosage % of binder is always derived from qty_kgm3 against this same
  // design's total binder (cement + fly ash) — never taken from the client,
  // same "recompute server-side, never trust it as typed" rule the cube-test
  // averages already follow. mix_design_admixtures can't hold this as a
  // Postgres GENERATED column itself (it'd need to read a sibling row's
  // cement_kgm3/fly_ash_kgm3 across tables), so it's computed here instead,
  // once, at the moment both numbers are known.
  const totalBinder = Number(b.cement_kgm3) + (Number(b.fly_ash_kgm3) || 0);
  const admixtures = Array.isArray(b.admixtures) ? b.admixtures : [];
  let i = 0;
  for (const a of admixtures) {
    if (!a.type_brand || !a.qty_kgm3) continue;
    i += 1;
    const dosagePct = totalBinder > 0 ? Number(((Number(a.qty_kgm3) / totalBinder) * 100).toFixed(2)) : null;
    await query(
      `INSERT INTO mix_design_admixtures (mix_design_id, type_brand, dosage_pct_of_binder, qty_kgm3, sp_gr, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [designId, a.type_brand, dosagePct, a.qty_kgm3, a.sp_gr || null, i]
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
