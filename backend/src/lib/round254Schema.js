// Round 254 (v10.86) — owner, 31 Oct 2026; mock-up "Production Module
// Redesign" (claude/production-module-redesign-mockup-v1.md).
//   * The Production module becomes one page with tabs, like Accounts.
//   * New order: grade, then the quotation's mix design for that grade —
//     required when the site's price list names mix designs. The chosen mix
//     is kept on the order (customer_orders.quoted_mix_design_id).
//   * Quality Control → Mix mapping: QC maps each customer's quoted mix
//     design to a plant recipe (mix_recipe_map). The Plant Operator sees
//     "Mix Design / Recipe: <mix> / <recipe>" (or "Not mapped").
//   * Delivery tickets: a quantity correction needs a reason and is logged
//     (ticket_qty_corrections); the invoice's part load is worked out again.
import { query } from "../db.js";

export const ROUND254_SQL = `
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS quoted_mix_design_id INTEGER REFERENCES mix_designs(id);

CREATE TABLE IF NOT EXISTS mix_recipe_map (
  id               SERIAL PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  mix_design_id    INTEGER NOT NULL REFERENCES mix_designs(id),
  plant_recipe_id  INTEGER REFERENCES plant_recipes(id),
  recipe_code      VARCHAR(50) NOT NULL,
  mapped_by        INTEGER REFERENCES users(id),
  mapped_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, mix_design_id)
);
CREATE TABLE IF NOT EXISTS mix_recipe_map_log (
  id               SERIAL PRIMARY KEY,
  customer_id      INTEGER NOT NULL,
  mix_design_id    INTEGER NOT NULL,
  old_recipe_code  VARCHAR(50),
  new_recipe_code  VARCHAR(50),
  reason           VARCHAR(300),
  changed_by       INTEGER REFERENCES users(id),
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_mix_recipe_map_log ON mix_recipe_map_log(customer_id, mix_design_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS ticket_qty_corrections (
  id         SERIAL PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES delivery_tickets(id),
  old_qty    NUMERIC(8,2),
  new_qty    NUMERIC(8,2),
  reason     VARCHAR(300),
  done_by    INTEGER REFERENCES users(id),
  done_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let ready = null;
export function ensureRound254() {
  if (!ready) ready = query(ROUND254_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound254(pool, log) {
  await pool.query(ROUND254_SQL);
  log?.push?.("Round 254: Production module tabs, mix design on orders, QC mix mapping (mix → plant recipe), ticket quantity corrections logged.");
}

// The plant recipe mapped to a customer's mix design, or null.
export async function mappedRecipe(db, customerId, mixDesignId) {
  if (!customerId || !mixDesignId) return null;
  await ensureRound254();
  const { rows } = await db.query(
    `SELECT m.recipe_code, m.plant_recipe_id FROM mix_recipe_map m WHERE m.customer_id = $1 AND m.mix_design_id = $2`, [customerId, mixDesignId]);
  return rows[0] || null;
}

// After an order is saved: keep the quotation's mix on it, and if QC has not
// mapped that mix to a plant recipe yet, tell QC (the Plant Operator will see
// "Not mapped" until they do).
export async function afterOrderMix(orderId, quotedMixId) {
  if (!quotedMixId) return;
  await ensureRound254();
  await query(`UPDATE customer_orders SET quoted_mix_design_id = $1 WHERE id = $2`, [quotedMixId, orderId]);
  const { rows } = await query(
    `SELECT o.customer_id, o.order_date::text AS order_date, c.name AS customer_name, md.design_ref_code,
            EXISTS (SELECT 1 FROM mix_recipe_map m WHERE m.customer_id = o.customer_id AND m.mix_design_id = $2) AS mapped
       FROM customer_orders o JOIN customers c ON c.id = o.customer_id JOIN mix_designs md ON md.id = $2
      WHERE o.id = $1`, [orderId, quotedMixId]);
  const o = rows[0];
  if (!o || o.mapped) return;
  const message = `${o.customer_name}: mix ${o.design_ref_code} has no plant recipe mapped — order on ${o.order_date}. Map it in Quality Control → Mix mapping.`;
  await query(`INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('qc_engineer', $1, 'mix_not_mapped', $2)`, [orderId, message]).catch(() => {});
  try {
    const { pushToRole } = await import("./push.js");
    await pushToRole("qc_engineer", { title: "Mix not mapped to a recipe", body: message, url: "/mix-mapping" });
  } catch { /* push is best effort */ }
}
