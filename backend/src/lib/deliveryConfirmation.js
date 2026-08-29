import { query } from "../db.js";
import { pushToRole } from "./push.js";

// The actual arrival/unloading/rejection logic — including the trip-allowance
// payout and invoice generation that fire on completion — used to live only in
// siteSupervisor.js. It's factored out here so the Driver's self-service
// fallback (for small sites with no Site Supervisor assigned) goes through the
// exact same business logic instead of a second, drift-prone copy of it.

// Delivered/supplied quantity for an order = every non-cancelled delivery
// ticket's loaded quantity, counted as soon as the delivery note is created —
// minus whatever was rejected at site. When that reaches the ordered
// quantity, the order is done; if a later rejection drops it back below that
// (e.g. a load gets rejected after the order had already hit its target),
// it's put back to in_progress rather than staying incorrectly "completed".
// Terminal states (cancelled/closed) are never touched.
export async function syncOrderCompletionStatus(orderId) {
  if (!orderId) return;
  const { rows } = await query(
    `SELECT o.status, o.order_quantity_m3,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status != 'cancelled'), 0)
              - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS delivered_qty_m3
     FROM customer_orders o
     LEFT JOIN delivery_tickets dt ON dt.order_id = o.id
     LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
     WHERE o.id = $1
     GROUP BY o.id`,
    [orderId]
  );
  const order = rows[0];
  if (!order || ["cancelled", "closed"].includes(order.status)) return;

  const reached = Number(order.delivered_qty_m3) >= Number(order.order_quantity_m3);
  // Reaching the ordered quantity does NOT auto-complete the order — the
  // last truck unloading is not the same as the site confirming the pour is
  // actually done, and only Manager's explicit confirm-completion sets
  // status to 'completed'. This only handles the reverse case: if a late
  // ticket cancellation drops delivered quantity back below target after
  // completion was confirmed, correctly un-complete the order rather than
  // leave a status that no longer reflects reality.
  if (!reached && order.status === "completed") {
    await query("UPDATE customer_orders SET status = 'in_progress' WHERE id = $1", [orderId]);
  }
}

// A new delivery on an order that already had its pump charge confirmed
// applicable can push the order's cumulative quantity across the pump
// type's minimum threshold — at that point the mobilization charge may no
// longer be warranted. Never auto-corrected (the invoice may already be in
// the customer's hands) — just flagged for Accountant/Manager to review and
// decide.
export async function checkPumpChargeThreshold(orderId) {
  if (!orderId) return;
  const { rows } = await query(
    `SELECT co.pump_requirement, co.pump_charge_applicable, co.pump_charge_needs_review,
            co.customer_id, co.site_id, co.mix_grade_id, co.order_date,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status != 'cancelled'), 0) AS cumulative_qty
     FROM customer_orders co
     LEFT JOIN delivery_tickets dt ON dt.order_id = co.id
     WHERE co.id = $1
     GROUP BY co.id`,
    [orderId]
  );
  const o = rows[0];
  if (!o || !o.pump_charge_applicable || o.pump_charge_needs_review || o.pump_requirement === "without_pump") return;

  const { rows: rateRows } = await query(
    `SELECT line_pump_min_qty_m3, boom_pump_min_qty_m3 FROM rate_master
     WHERE customer_id = $1 AND mix_grade_id = $2 AND (site_id = $3 OR site_id IS NULL)
       AND effective_from <= $4 AND (effective_to IS NULL OR effective_to >= $4)
     ORDER BY (site_id = $3) DESC, effective_from DESC, id DESC LIMIT 1`,
    [o.customer_id, o.mix_grade_id, o.site_id, o.order_date]
  );
  const threshold = o.pump_requirement === "boom_pump"
    ? Number(rateRows[0]?.boom_pump_min_qty_m3 ?? 50)
    : Number(rateRows[0]?.line_pump_min_qty_m3 ?? 20);

  if (Number(o.cumulative_qty) >= threshold) {
    await query("UPDATE customer_orders SET pump_charge_needs_review = true WHERE id = $1", [orderId]);
    const { rows: orderInfo } = await query(
      `SELECT c.name AS customer_name, s.name AS site_name
       FROM customer_orders co JOIN customers c ON c.id = co.customer_id JOIN sites s ON s.id = co.site_id
       WHERE co.id = $1`,
      [orderId]
    );
    const label = orderInfo[0] ? `${orderInfo[0].customer_name} — ${orderInfo[0].site_name}` : `Order #${orderId}`;
    const message = `${label} now totals ${o.cumulative_qty} m³, crossing the ${threshold} m³ minimum — the confirmed pump mobilization charge may no longer apply. Review it.`;
    await query(
      `INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('accountant', $1, 'pump_charge_review', $2)`,
      [orderId, message]
    );
    await query(
      `INSERT INTO notifications (recipient_role, order_id, type, message) VALUES ('manager', $1, 'pump_charge_review', $2)`,
      [orderId, message]
    );
    await pushToRole("accountant", { title: "Pump charge needs review", body: message, url: "/accountant" });
    await pushToRole("manager", { title: "Pump charge needs review", body: message, url: "/manager" });
  }
}

// Invoicing now follows the exact same principle as production quantity
// (see syncOrderCompletionStatus above): a delivery note counts the moment
// it's created — treated as invoiced and due for payment — not only once
// someone gets around to confirming unloading complete. A pending delivery
// is assumed accepted until it's explicitly rejected; only an explicit
// rejection (or cancellation) reverses it. Called at ticket creation, and
// again at unloading-complete as a safety net (e.g. a rate that didn't
// exist yet at creation time but does by completion) — idempotent either
// way via ON CONFLICT DO NOTHING.
export async function generateInvoiceForTicket(ticketId) {
  const { rows: rateRows } = await query(
    `SELECT dt.loaded_quantity_m3, dt.order_id, co.customer_id, co.order_date,
            rm.rate_per_m3, co.pump_requirement,
            co.pump_charge_applicable, co.pump_charge_amount,
            co.part_load_applicable, co.part_load_charge_amount,
            -- Round 121, item 3 — the order's chosen billing profile (if any),
            -- falling back to the customer's own name/billing_address so a
            -- customer who never set up multiple billing entities invoices
            -- exactly as before this feature existed.
            COALESCE(ba.name, c.name) AS billing_name,
            COALESCE(ba.address, c.billing_address) AS billing_address,
            ba.gstin AS billing_gstin
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     LEFT JOIN customer_billing_addresses ba ON ba.id = co.billing_address_id
     JOIN rate_master rm ON rm.customer_id = co.customer_id AND rm.mix_grade_id = co.mix_grade_id
       AND (rm.site_id = co.site_id OR rm.site_id IS NULL)
       AND rm.effective_from <= co.order_date AND (rm.effective_to IS NULL OR rm.effective_to >= co.order_date)
     WHERE dt.id = $1
     ORDER BY (rm.site_id = co.site_id) DESC, rm.effective_from DESC, rm.id DESC LIMIT 1`,
    [ticketId]
  );
  if (rateRows[0]) {
    const r = rateRows[0];
    const concreteAmount = Number(r.loaded_quantity_m3) * Number(r.rate_per_m3);

    // Both pump charge and part load are Manager's own confirmed decision at
    // order creation (not automatic) — still only charged once per order,
    // on whichever ticket happens to be invoiced first.
    let pumpingCharge = 0;
    let partLoadCharge = 0;
    if (r.pump_charge_applicable || r.part_load_applicable) {
      const { rows: alreadyCharged } = await query(
        `SELECT COALESCE(SUM(pumping_charge), 0) AS pump_total, COALESCE(SUM(part_load_charge), 0) AS part_load_total
         FROM invoices i JOIN delivery_tickets dt2 ON dt2.id = i.ticket_id
         WHERE dt2.order_id = $1`,
        [r.order_id]
      );
      const nothingChargedYet = Number(alreadyCharged[0].pump_total) === 0 && Number(alreadyCharged[0].part_load_total) === 0;
      if (nothingChargedYet) {
        if (r.pump_charge_applicable) pumpingCharge = Number(r.pump_charge_amount || 0);
        if (r.part_load_applicable) partLoadCharge = Number(r.part_load_charge_amount || 0);
      }
    }

    await query(
      `INSERT INTO invoices (ticket_id, customer_id, concrete_amount, pumping_charge, part_load_charge, waiting_charge, total_amount, billing_name, billing_address, billing_gstin)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [ticketId, r.customer_id, concreteAmount, pumpingCharge, partLoadCharge, concreteAmount + pumpingCharge + partLoadCharge,
       r.billing_name, r.billing_address, r.billing_gstin]
    );
    return true;
  } else {
    // No rate on file for this customer/mix-grade combination — this delivery
    // will never show up in Sales/Collections until a rate is added and this
    // is corrected, so make that visible instead of a silent gap. Guarded so
    // this notice only fires once (creation attempt), not again at
    // unloading-complete for the same ticket.
    const { rows: already } = await query(
      "SELECT 1 FROM notifications WHERE ticket_id = $1 AND type = 'no_rate_on_file'",
      [ticketId]
    );
    if (already.length) return false;
    await query(
      `INSERT INTO notifications (recipient_role, ticket_id, type, message)
       VALUES ('accountant', $1, 'no_rate_on_file',
         'Delivery note created but no rate is on file for this customer/grade — invoice not generated')`,
      [ticketId]
    );
    const { rows: t } = await query("SELECT ticket_number FROM delivery_tickets WHERE id = $1", [ticketId]);
    await pushToRole("accountant", {
      title: "No rate on file",
      body: `${t[0]?.ticket_number || "A delivery"} — invoice not generated`,
      url: "/accountant",
    });
    return false;
  }
}

// Reverses an already-generated invoice when a delivery turns out to be
// rejected or cancelled — never silently, and never touching one a payment
// has already been recorded against (flagged for Accountant to handle by
// hand instead, same safety rule used everywhere else money is involved).
export async function voidInvoiceForTicket(ticketId, reason) {
  const { rows } = await query(
    `SELECT i.id, i.total_amount, COALESCE((SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id), 0) AS payment_count
     FROM invoices i WHERE i.ticket_id = $1`,
    [ticketId]
  );
  const invoice = rows[0];
  if (!invoice) return;

  if (Number(invoice.payment_count) > 0) {
    const { rows: t } = await query("SELECT ticket_number FROM delivery_tickets WHERE id = $1", [ticketId]);
    const message = `${t[0]?.ticket_number || "A delivery"} was ${reason}, but a payment has already been recorded against its invoice (₹${invoice.total_amount}) — can't reverse it automatically. Needs manual review.`;
    await query(
      `INSERT INTO notifications (recipient_role, ticket_id, type, message) VALUES ('accountant', $1, 'invoice_reversal_blocked', $2)`,
      [ticketId, message]
    );
    await pushToRole("accountant", { title: "Invoice reversal needs review", body: message, url: "/accountant" });
    return;
  }

  await query("DELETE FROM invoices WHERE id = $1", [invoice.id]);
}

export async function logTripEvent(ticketId, eventType, userId) {
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by)
     VALUES ($1, $2, 'manual', $3)`,
    [ticketId, eventType, userId]
  );
}

export async function confirmArrival(ticketId, userId) {
  await logTripEvent(ticketId, "reached_site", userId);
  await query("UPDATE delivery_tickets SET status = 'reached_site' WHERE id = $1", [ticketId]);
}

export async function confirmUnloadingStart(ticketId, userId) {
  await logTripEvent(ticketId, "unloading_started", userId);
  await query("UPDATE delivery_tickets SET status = 'unloading' WHERE id = $1", [ticketId]);
  await query(
    `INSERT INTO site_qc (ticket_id, unload_start_time, entered_by)
     VALUES ($1, now(), $2)
     ON CONFLICT (ticket_id) DO UPDATE SET unload_start_time = now()`,
    [ticketId, userId]
  );
}

// Confirm unloading completion + record site slump — this is what triggers trip
// allowance payout and invoice generation.
export async function confirmUnloadingComplete(ticketId, userId, { site_slump_mm, delivery_note_status, remarks, after_pour_care_confirmed }) {
  await logTripEvent(ticketId, "unloading_completed", userId);
  await query(
    `UPDATE site_qc SET unload_finish_time = now(), arrival_slump_mm = $1,
       delivery_note_status = $2, remarks = $3, accepted = true, after_pour_care_confirmed = $5
     WHERE ticket_id = $4`,
    [site_slump_mm || null, delivery_note_status || "pending", remarks, ticketId, !!after_pour_care_confirmed]
  );
  await query("UPDATE delivery_tickets SET status = 'completed' WHERE id = $1", [ticketId]);

  const { rows: ticketRows } = await query("SELECT order_id FROM delivery_tickets WHERE id = $1", [ticketId]);
  const orderId = ticketRows[0]?.order_id;

  // Trip allowance payout — only on completed delivery (business rule)
  const { rows } = await query(
    `SELECT dt.driver_id, tac.amount
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN trip_allowance_categories tac ON tac.id = s.trip_allowance_category_id
     WHERE dt.id = $1`,
    [ticketId]
  );
  if (rows[0]) {
    await query(
      `INSERT INTO trip_allowance_payouts (ticket_id, driver_id, amount)
       VALUES ($1, $2, $3) ON CONFLICT (ticket_id) DO NOTHING`,
      [ticketId, rows[0].driver_id, rows[0].amount]
    );
  }

  // Safety net — invoicing normally already happened at ticket creation now.
  // This only does anything if that first attempt found no rate on file
  // (ON CONFLICT DO NOTHING makes a repeat call harmless either way).
  await generateInvoiceForTicket(ticketId);

  await syncOrderCompletionStatus(orderId);
}

export async function confirmRejection(ticketId, userId, { rejection_reason_id, rejected_quantity_m3, remarks, site_slump_mm }) {
  await query(
    `INSERT INTO site_qc (ticket_id, arrival_slump_mm, accepted, rejected_quantity_m3,
       rejection_reason_id, remarks, entered_by)
     VALUES ($1, $2, false, $3, $4, $5, $6)
     ON CONFLICT (ticket_id) DO UPDATE SET
       accepted = false, rejected_quantity_m3 = $3, rejection_reason_id = $4, remarks = $5`,
    [ticketId, site_slump_mm || null, rejected_quantity_m3 || null, rejection_reason_id || null, remarks, userId]
  );
  await query("UPDATE delivery_tickets SET status = 'rejected' WHERE id = $1", [ticketId]);
  await logTripEvent(ticketId, "rejected", userId);
  await voidInvoiceForTicket(ticketId, "rejected");

  await query(
    `INSERT INTO notifications (recipient_role, ticket_id, type, message)
     VALUES ('manager', $1, 'concrete_rejected', 'Concrete rejected at site — pending manager approval')`,
    [ticketId]
  );
  const { rows: t } = await query("SELECT ticket_number FROM delivery_tickets WHERE id = $1", [ticketId]);
  await pushToRole("manager", {
    title: "Concrete rejected at site",
    body: t[0]?.ticket_number || "A delivery was rejected",
    url: "/manager",
  });

  const { rows: ticketRows } = await query("SELECT order_id FROM delivery_tickets WHERE id = $1", [ticketId]);
  await syncOrderCompletionStatus(ticketRows[0]?.order_id);
}

// A ticket can be confirmed by the Driver directly only when its order has no
// Site Supervisor assigned (small sites with 1-2 trucks, per business need) —
// otherwise the assigned supervisor is the one who should be confirming it.
export async function orderHasNoSiteSupervisor(ticketId) {
  const { rows } = await query(
    `SELECT co.assigned_site_supervisor_id
     FROM delivery_tickets dt JOIN customer_orders co ON co.id = dt.order_id
     WHERE dt.id = $1`,
    [ticketId]
  );
  return rows.length > 0 && rows[0].assigned_site_supervisor_id === null;
}
