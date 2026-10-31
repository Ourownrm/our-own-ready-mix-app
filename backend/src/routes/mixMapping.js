// Round 254 — Quality Control → Mix mapping (owner, 31 Oct 2026).
// Each customer's quoted mix design (from the quotation / price list) is
// mapped by QC to the plant recipe the batching plant runs. The Plant
// Operator then sees "Mix Design / Recipe: <mix> / <recipe>".
// QC Engineer and Administrator only (quality.mix-mapping).
//   GET  /api/mix-mapping                 customer × mix pairs, mapped or not
//   GET  /api/mix-mapping/recipes         plant recipes in the plant
//   PUT  /api/mix-mapping                 { customer_id, mix_design_id, plant_recipe_id, reason? }
//   GET  /api/mix-mapping/history?customer_id=&mix_design_id=
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { ensureRound254 } from "../lib/round254Schema.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound254(); next(); } catch (e) { next(e); } });

// The pairs: every mix design on a customer's current, enabled price list,
// plus any mix already on one of their orders (so an older price list that
// has since been replaced still shows up while it has orders).
router.get("/", requirePermission("quality.mix-mapping", "view"), async (_req, res) => {
  const { rows } = await query(
    `WITH pairs AS (
       SELECT rm.customer_id, rm.mix_design_id, rm.site_id, q.quote_no
         FROM rate_master rm LEFT JOIN quotations q ON q.id = rm.quotation_id
        WHERE rm.mix_design_id IS NOT NULL AND COALESCE(rm.is_enabled, true)
          AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)
       UNION
       SELECT o.customer_id, o.quoted_mix_design_id, o.site_id, NULL
         FROM customer_orders o WHERE o.quoted_mix_design_id IS NOT NULL AND o.order_date >= CURRENT_DATE - 60)
     SELECT p.customer_id, c.name AS customer_name, p.mix_design_id, md.design_ref_code, md.revision,
            md.design_ref_code || COALESCE(' · rev ' || md.revision, '') AS mix_code,
            mg.id AS mix_grade_id, mg.name AS grade_name, md.mix_description,
            string_agg(DISTINCT s.name, ', ') AS sites, string_agg(DISTINCT p.quote_no, ', ') AS quote_nos,
            m.recipe_code, m.plant_recipe_id, pr.recipe_name, pr.strength AS recipe_strength,
            (m.id IS NOT NULL AND (pr.id IS NULL OR NOT pr.in_plant OR upper(COALESCE(pr.deleted_flag, '')) IN ('YES','Y','TRUE','1','DELETED'))) AS recipe_gone,
            m.mapped_at, u.name AS mapped_by,
            (SELECT MIN(o.order_date)::text FROM customer_orders o
              WHERE o.customer_id = p.customer_id AND o.quoted_mix_design_id = p.mix_design_id
                AND o.order_date >= CURRENT_DATE AND o.status NOT IN ('completed','cancelled','closed')) AS next_order
       FROM pairs p
       JOIN customers c ON c.id = p.customer_id JOIN mix_designs md ON md.id = p.mix_design_id
       JOIN mix_grades mg ON mg.id = md.mix_grade_id LEFT JOIN sites s ON s.id = p.site_id
       LEFT JOIN mix_recipe_map m ON m.customer_id = p.customer_id AND m.mix_design_id = p.mix_design_id
       LEFT JOIN plant_recipes pr ON pr.id = m.plant_recipe_id LEFT JOIN users u ON u.id = m.mapped_by
      GROUP BY p.customer_id, c.name, p.mix_design_id, md.id, mg.id, m.id, pr.id, u.name
      ORDER BY (m.id IS NOT NULL), next_order NULLS LAST, c.name, mg.name`);
  res.json({
    list: rows,
    counts: {
      total: rows.length, mapped: rows.filter((r) => r.recipe_code).length,
      not_mapped: rows.filter((r) => !r.recipe_code).length,
      urgent: rows.filter((r) => !r.recipe_code && r.next_order).length,
      gone: rows.filter((r) => r.recipe_gone).length,
    },
  });
});

router.get("/recipes", requirePermission("quality.mix-mapping", "view"), async (_req, res) => {
  const { rows } = await query(
    `SELECT id, recipe_code, recipe_name, strength FROM plant_recipes
      WHERE in_plant AND upper(COALESCE(deleted_flag, '')) NOT IN ('YES','Y','TRUE','1','DELETED') ORDER BY recipe_code`);
  res.json(rows);
});

router.put("/", requirePermission("quality.mix-mapping", "edit"), async (req, res) => {
  const customerId = Number(req.body.customer_id), mixId = Number(req.body.mix_design_id), recipeId = Number(req.body.plant_recipe_id);
  const reason = String(req.body.reason || "").trim().slice(0, 300);
  if (!customerId || !mixId || !recipeId) return res.status(400).json({ error: "Customer, mix design and recipe are all needed." });
  const { rows: rec } = await query(`SELECT id, recipe_code FROM plant_recipes WHERE id = $1 AND upper(COALESCE(deleted_flag, '')) NOT IN ('YES','Y','TRUE','1','DELETED')`, [recipeId]);
  if (!rec.length) return res.status(400).json({ error: "That recipe is not in the plant." });
  const { rows: cur } = await query(`SELECT recipe_code FROM mix_recipe_map WHERE customer_id = $1 AND mix_design_id = $2`, [customerId, mixId]);
  const old = cur[0]?.recipe_code || null;
  if (old === rec[0].recipe_code) return res.json({ ok: true, unchanged: true });
  if (old && !reason) return res.status(400).json({ error: "Give a reason for changing the recipe." });
  await query(
    `INSERT INTO mix_recipe_map (customer_id, mix_design_id, plant_recipe_id, recipe_code, mapped_by, mapped_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (customer_id, mix_design_id) DO UPDATE SET plant_recipe_id = EXCLUDED.plant_recipe_id, recipe_code = EXCLUDED.recipe_code,
       mapped_by = EXCLUDED.mapped_by, mapped_at = now()`,
    [customerId, mixId, recipeId, rec[0].recipe_code, req.user.id]);
  await query(
    `INSERT INTO mix_recipe_map_log (customer_id, mix_design_id, old_recipe_code, new_recipe_code, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [customerId, mixId, old, rec[0].recipe_code, reason || null, req.user.id]);
  // The "mix not mapped" notices for this pair are done with.
  await query(
    `UPDATE notifications SET is_read = true WHERE type = 'mix_not_mapped' AND is_read = false
        AND order_id IN (SELECT id FROM customer_orders WHERE customer_id = $1 AND quoted_mix_design_id = $2)`, [customerId, mixId]).catch(() => {});
  res.json({ ok: true, recipe_code: rec[0].recipe_code, old_recipe_code: old });
});

router.get("/history", requirePermission("quality.mix-mapping", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT l.old_recipe_code, l.new_recipe_code, l.reason, l.changed_at, u.name AS changed_by
       FROM mix_recipe_map_log l LEFT JOIN users u ON u.id = l.changed_by
      WHERE l.customer_id = $1 AND l.mix_design_id = $2 ORDER BY l.changed_at DESC`, [Number(req.query.customer_id) || 0, Number(req.query.mix_design_id) || 0]);
  res.json(rows);
});

export default router;
