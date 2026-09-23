// Round 153 — the Delivery Challan payload, in ONE place.
//
// This query used to live inline in administrator.js's
// GET /tickets/:id/challan, which was the only way to print a challan and was
// Administrator-only. Round 153 gives the Plant Operator, the lab and QC the
// same printed document, and the wrong way to do that would be to copy the
// query into the new router: two copies drift, and the copy that drifts is
// the one nobody is looking at. So the query moved here and BOTH routes call
// this — administrator.js keeps its own URL (the Administrator screen's print
// button already points at it) but no longer owns the SQL.
//
// Returns null when the ticket does not exist, so each caller can answer 404
// in its own voice.
import { query } from "../db.js";

export async function fetchChallanData(ticketId) {
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, dt.ticket_date, dt.loaded_quantity_m3, dt.created_at,
            t.truck_number,
            drv.name AS driver_name,
            po.name AS plant_operator_name,
            p.pump_code,
            co.id AS order_id, co.order_quantity_m3, co.casting_location, co.specified_slump_mm,
            co.pump_requirement, co.site_contact_number,
            c.name AS customer_name,
            s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN users drv ON drv.id = dt.driver_id
     LEFT JOIN users po ON po.id = dt.plant_operator_id
     JOIN customer_orders co ON co.id = dt.order_id
     -- Pump is assigned at order-creation time (customer_orders.pump_id) — the
     -- Plant Operator's normal ticket-creation flow never sets a per-ticket
     -- pump_id, so joining on dt.pump_id alone left "Pump No." blank on every
     -- real ticket even when the order clearly had a pump (Method of Pouring
     -- showed "With Pump" from co.pump_requirement while Pump No. stayed
     -- empty). Falling back to the order's pump_id fixes that.
     LEFT JOIN pumps p ON p.id = COALESCE(dt.pump_id, co.pump_id)
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     WHERE dt.id = $1`,
    [ticketId]
  );
  if (!rows.length) return null;
  const ticket = rows[0];

  // "Delivered Qty" = quantity already sent out on OTHER tickets against this
  // same order (this document accompanies an outbound truck, so the current
  // ticket's own load is reported separately as "This Load", not folded in).
  const { rows: priorRows } = await query(
    `SELECT COALESCE(SUM(loaded_quantity_m3), 0) AS delivered_prior_m3
     FROM delivery_tickets
     WHERE order_id = $1 AND id != $2 AND status != 'cancelled'`,
    [ticket.order_id, ticket.id]
  );
  const deliveredPrior = Number(priorRows[0].delivered_prior_m3);
  const ordered = Number(ticket.order_quantity_m3);
  const thisLoad = Number(ticket.loaded_quantity_m3 || 0);

  return {
    ...ticket,
    delivered_prior_m3: deliveredPrior,
    balance_m3: Math.max(0, ordered - deliveredPrior - thisLoad),
  };
}
