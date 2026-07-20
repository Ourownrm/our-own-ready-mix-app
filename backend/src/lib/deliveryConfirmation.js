import { query } from "../db.js";

// The actual arrival/unloading/rejection logic — including the trip-allowance
// payout and invoice generation that fire on completion — used to live only in
// siteSupervisor.js. It's factored out here so the Driver's self-service
// fallback (for small sites with no Site Supervisor assigned) goes through the
// exact same business logic instead of a second, drift-prone copy of it.

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
    [site_slump_mm, delivery_note_status || "pending", remarks, ticketId, !!after_pour_care_confirmed]
  );
  await query("UPDATE delivery_tickets SET status = 'completed' WHERE id = $1", [ticketId]);

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

  // Generate invoice for the Accountant, based on the customer/grade rate on file
  const { rows: rateRows } = await query(
    `SELECT dt.loaded_quantity_m3, co.customer_id, rm.rate_per_m3, rm.pumping_charge_lumpsum, co.pump_requirement
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN rate_master rm ON rm.customer_id = co.customer_id AND rm.mix_grade_id = co.mix_grade_id
       AND rm.effective_from <= CURRENT_DATE AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)
     WHERE dt.id = $1
     ORDER BY rm.effective_from DESC, rm.id DESC LIMIT 1`,
    [ticketId]
  );
  if (rateRows[0]) {
    const r = rateRows[0];
    const concreteAmount = Number(r.loaded_quantity_m3) * Number(r.rate_per_m3);
    const pumpingCharge = r.pump_requirement !== "without_pump" ? Number(r.pumping_charge_lumpsum || 0) : 0;
    await query(
      `INSERT INTO invoices (ticket_id, customer_id, concrete_amount, pumping_charge, waiting_charge, total_amount)
       VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT DO NOTHING`,
      [ticketId, r.customer_id, concreteAmount, pumpingCharge, concreteAmount + pumpingCharge]
    );
  }
  // Note: if no rate is on file for this customer/grade, no invoice is created.
}

export async function confirmRejection(ticketId, userId, { rejection_reason_id, rejected_quantity_m3, remarks, site_slump_mm }) {
  await query(
    `INSERT INTO site_qc (ticket_id, arrival_slump_mm, accepted, rejected_quantity_m3,
       rejection_reason_id, remarks, entered_by)
     VALUES ($1, $2, false, $3, $4, $5, $6)
     ON CONFLICT (ticket_id) DO UPDATE SET
       accepted = false, rejected_quantity_m3 = $3, rejection_reason_id = $4, remarks = $5`,
    [ticketId, site_slump_mm, rejected_quantity_m3, rejection_reason_id, remarks, userId]
  );
  await query("UPDATE delivery_tickets SET status = 'rejected' WHERE id = $1", [ticketId]);
  await logTripEvent(ticketId, "rejected", userId);

  await query(
    `INSERT INTO notifications (recipient_role, ticket_id, type, message)
     VALUES ('manager', $1, 'concrete_rejected', 'Concrete rejected at site — pending manager approval')`,
    [ticketId]
  );
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
