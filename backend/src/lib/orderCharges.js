// Round 204 — the Manager's charge decisions on an order (owner, 11 Oct 2026).
//
//   * Pump mobilization (line / boom): the price list carries the rule; the
//     Manager decides on each order. Choosing "Not applicable" when the rule
//     would apply (order below the pump's minimum quantity) needs a reason,
//     and the Administrator is notified.
//   * Part load: asked on EVERY order — "if a load goes out below the minimum,
//     charge part load?". Applicable means each delivery below the minimum
//     carries (minimum − load) × the part load rate on its own invoice. Not
//     applicable needs a reason and the Administrator is notified.
//
// The Administrator either accepts the decision or charges it after all, which
// re-prices that order's invoices (recomputeOrderCharges).
//
// Used by Create Order (orders.js) and Convert booking (sales.js) so the two
// can never ask different questions.
import { query } from "../db.js";
import { pushToRole } from "./push.js";
import { chargesForTicket } from "./deliveryConfirmation.js";

export async function rateFor(customerId, siteId, gradeId, date) {
  const { rows } = await query(
    `SELECT id, rate_per_m3, line_pump_charge, line_pump_min_qty_m3, boom_pump_charge, boom_pump_min_qty_m3,
            part_load_min_qty_m3, part_load_charge_per_m3, pumping_charge_lumpsum, quotation_id, source
       FROM rate_master
      WHERE customer_id = $1 AND mix_grade_id = $2 AND (site_id = $3 OR site_id IS NULL)
        AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date)
      ORDER BY (site_id = $3) DESC, effective_from DESC, id DESC LIMIT 1`,
    [customerId, gradeId, siteId, date]
  );
  return rows[0] || null;
}

function pumpRule(rate, pumpRequirement) {
  if (pumpRequirement === "boom_pump") {
    return { amount: Number(rate?.boom_pump_charge || 0) || null, minQty: Number(rate?.boom_pump_min_qty_m3 ?? 50) };
  }
  if (pumpRequirement === "line_pump") {
    return { amount: Number(rate?.line_pump_charge ?? rate?.pumping_charge_lumpsum ?? 0) || null, minQty: Number(rate?.line_pump_min_qty_m3 ?? 20) };
  }
  return { amount: null, minQty: null };
}

// Validates the two decisions and returns the columns to store, or { error }.
export async function resolveChargeDecisions(body, { customer_id, site_id, mix_grade_id, order_date, order_quantity_m3, pump_requirement }) {
  const rate = await rateFor(customer_id, site_id, mix_grade_id, order_date);
  const qty = Number(order_quantity_m3) || 0;
  const out = {
    pump_charge_applicable: null, pump_charge_amount: 0, pump_charge_waiver_reason: null,
    part_load_applicable: null, part_load_charge_amount: 0, part_load_waiver_reason: null,
    part_load_basis: "per_load",
  };

  if (pump_requirement !== "without_pump") {
    if (body.pump_charge_applicable === undefined || body.pump_charge_applicable === null) {
      return { error: "Confirm whether the pump mobilization charge applies to this order." };
    }
    const rule = pumpRule(rate, pump_requirement);
    out.pump_charge_applicable = !!body.pump_charge_applicable;
    if (out.pump_charge_applicable) {
      out.pump_charge_amount = Number(body.pump_charge_amount) > 0 ? Number(body.pump_charge_amount) : (rule.amount || 0);
    } else {
      const ruleApplies = rule.amount && qty < (rule.minQty || 0);
      const reason = String(body.pump_charge_waiver_reason || "").trim();
      if (ruleApplies && !reason) {
        return { error: "Give a reason for not charging the pump mobilization — the Administrator is notified." };
      }
      out.pump_charge_waiver_reason = ruleApplies ? reason : (reason || null);
    }
  }

  if (body.part_load_applicable === undefined || body.part_load_applicable === null) {
    return { error: "Confirm whether the part load charge applies if a load goes out below the minimum." };
  }
  out.part_load_applicable = !!body.part_load_applicable;
  if (!out.part_load_applicable) {
    const reason = String(body.part_load_waiver_reason || "").trim();
    if (!reason) return { error: "Give a reason for not charging part load — the Administrator is notified." };
    out.part_load_waiver_reason = reason;
  }
  return { decisions: out, rate };
}

// After the order is saved: tell the Administrator about any charge left out
// with a reason. Marks the order for review.
export async function notifyWaivers(orderId) {
  const { rows } = await query(
    `SELECT co.id, co.pump_charge_waiver_reason, co.part_load_waiver_reason, co.pump_requirement, co.order_quantity_m3,
            c.name AS customer_name, s.name AS site_name, u.name AS by_name
       FROM customer_orders co JOIN customers c ON c.id = co.customer_id JOIN sites s ON s.id = co.site_id
       LEFT JOIN users u ON u.id = co.created_by
      WHERE co.id = $1`,
    [orderId]
  );
  const o = rows[0];
  if (!o || (!o.pump_charge_waiver_reason && !o.part_load_waiver_reason)) return;
  await query(`UPDATE customer_orders SET charge_review_status = 'pending' WHERE id = $1`, [orderId]);
  const parts = [];
  if (o.pump_charge_waiver_reason) parts.push(`${o.pump_requirement === "boom_pump" ? "Boom" : "Line"} pump charge not charged — "${o.pump_charge_waiver_reason}"`);
  if (o.part_load_waiver_reason) parts.push(`Part load not charged — "${o.part_load_waiver_reason}"`);
  const message = `${o.customer_name} · ${o.site_name} · ${o.order_quantity_m3} m³ (by ${o.by_name || "Manager"}): ${parts.join("; ")}.`;
  await query(
    `INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('administrator', $1, 'charge_waived', $2)`,
    [orderId, message]
  );
  await pushToRole("administrator", { title: "Charge left out of an order", body: message, url: "/accounts?tab=invoices&view=waivers" });
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Re-price every invoice of one order after its charge decisions changed.
// Deliveries are processed oldest first, so the once-per-order pump charge
// lands on the first one, exactly as when the invoices were first raised.
export async function recomputeOrderCharges(orderId) {
  const { rows: tickets } = await query(
    `SELECT dt.id AS ticket_id, dt.loaded_quantity_m3, dt.order_id,
            co.pump_requirement, co.pump_charge_applicable, co.pump_charge_amount,
            co.part_load_applicable, co.part_load_charge_amount, co.part_load_basis,
            rm.part_load_min_qty_m3, rm.part_load_charge_per_m3,
            i.id AS invoice_id, i.concrete_amount, i.waiting_charge
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN invoices i ON i.ticket_id = dt.id
       LEFT JOIN rate_master rm ON rm.id = i.rate_id
      WHERE dt.order_id = $1
      ORDER BY dt.id`,
    [orderId]
  );
  if (!tickets.length) return 0;
  // Clear first, then rebuild in order — chargesForTicket looks at what the
  // order's other invoices already carry.
  await query(
    `UPDATE invoices i SET pumping_charge = 0, part_load_charge = 0,
            total_amount = i.concrete_amount + COALESCE(i.waiting_charge, 0)
       FROM delivery_tickets dt WHERE dt.id = i.ticket_id AND dt.order_id = $1`,
    [orderId]
  );
  let changed = 0;
  for (const t of tickets) {
    // An invoice raised before this round has no rate_id; fall back to the
    // order's current price list row for the part load rule.
    let row = t;
    if (t.part_load_min_qty_m3 == null && t.part_load_basis === "per_load") {
      const { rows: o } = await query(`SELECT customer_id, site_id, mix_grade_id, order_date FROM customer_orders WHERE id = $1`, [orderId]);
      const rate = o[0] ? await rateFor(o[0].customer_id, o[0].site_id, o[0].mix_grade_id, o[0].order_date) : null;
      row = { ...t, part_load_min_qty_m3: rate?.part_load_min_qty_m3, part_load_charge_per_m3: rate?.part_load_charge_per_m3 };
    }
    const { pumpingCharge, partLoadCharge } = await chargesForTicket(row);
    const total = r2(Number(t.concrete_amount) + pumpingCharge + partLoadCharge + Number(t.waiting_charge || 0));
    await query(
      `UPDATE invoices SET pumping_charge = $1, part_load_charge = $2, total_amount = $3 WHERE id = $4`,
      [pumpingCharge, partLoadCharge, total, t.invoice_id]
    );
    changed++;
  }
  return changed;
}
