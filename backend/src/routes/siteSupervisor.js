import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("site_supervisor"));

async function logEvent(ticketId, eventType, userId) {
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by)
     VALUES ($1, $2, 'manual', $3)`,
    [ticketId, eventType, userId]
  );
}

// Today's deliveries headed to sites this supervisor is assigned to
router.get("/my-deliveries", async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, dt.status, s.name AS site_name, c.name AS customer_name,
            m.name AS mix_grade_name, dt.loaded_quantity_m3
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN customers c ON c.id = co.customer_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     WHERE co.assigned_site_supervisor_id = $1
       AND dt.ticket_date = CURRENT_DATE
       AND dt.status NOT IN ('completed', 'cancelled', 'returned')
     ORDER BY dt.created_at`,
    [req.user.id]
  );
  res.json(rows);
});

// Confirm truck arrival at site
router.post("/:ticketId/arrival", async (req, res) => {
  await logEvent(req.params.ticketId, "reached_site", req.user.id);
  await query("UPDATE delivery_tickets SET status = 'reached_site' WHERE id = $1", [req.params.ticketId]);
  res.json({ ok: true });
});

// Confirm unloading start
router.post("/:ticketId/unloading-start", async (req, res) => {
  await logEvent(req.params.ticketId, "unloading_started", req.user.id);
  await query("UPDATE delivery_tickets SET status = 'unloading' WHERE id = $1", [req.params.ticketId]);
  await query(
    `INSERT INTO site_qc (ticket_id, unload_start_time, entered_by)
     VALUES ($1, now(), $2)
     ON CONFLICT (ticket_id) DO UPDATE SET unload_start_time = now()`,
    [req.params.ticketId, req.user.id]
  );
  res.json({ ok: true });
});

// Confirm unloading completion + record site slump — this is what triggers trip allowance payout
router.post("/:ticketId/unloading-complete", async (req, res) => {
  const { site_slump_mm, delivery_note_status, remarks, after_pour_care_confirmed } = req.body;

  await logEvent(req.params.ticketId, "unloading_completed", req.user.id);
  await query(
    `UPDATE site_qc SET unload_finish_time = now(), arrival_slump_mm = $1,
       delivery_note_status = $2, remarks = $3, accepted = true, after_pour_care_confirmed = $5
     WHERE ticket_id = $4`,
    [site_slump_mm, delivery_note_status || "pending", remarks, req.params.ticketId, !!after_pour_care_confirmed]
  );
  await query("UPDATE delivery_tickets SET status = 'completed' WHERE id = $1", [req.params.ticketId]);

  // Trip allowance payout — only on completed delivery (business rule)
  const { rows } = await query(
    `SELECT dt.driver_id, tac.amount
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN trip_allowance_categories tac ON tac.id = s.trip_allowance_category_id
     WHERE dt.id = $1`,
    [req.params.ticketId]
  );
  if (rows[0]) {
    await query(
      `INSERT INTO trip_allowance_payouts (ticket_id, driver_id, amount)
       VALUES ($1, $2, $3) ON CONFLICT (ticket_id) DO NOTHING`,
      [req.params.ticketId, rows[0].driver_id, rows[0].amount]
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
    [req.params.ticketId]
  );
  if (rateRows[0]) {
    const r = rateRows[0];
    const concreteAmount = Number(r.loaded_quantity_m3) * Number(r.rate_per_m3);
    // Pumping charge is a flat lump sum per delivery, not multiplied by quantity
    const pumpingCharge = r.pump_requirement !== "without_pump" ? Number(r.pumping_charge_lumpsum || 0) : 0;
    await query(
      `INSERT INTO invoices (ticket_id, customer_id, concrete_amount, pumping_charge, waiting_charge, total_amount)
       VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT DO NOTHING`,
      [req.params.ticketId, r.customer_id, concreteAmount, pumpingCharge, concreteAmount + pumpingCharge]
    );
  }
  // Note: if no rate is on file for this customer/grade, no invoice is created —
  // the Accountant will need a "missing rate" report, which is one of the items
  // still on the Reports backlog from the earlier gap analysis.

  res.json({ ok: true });
});

// Reject concrete — no trip allowance, notifies manager and accountant
router.post("/:ticketId/reject", async (req, res) => {
  const { rejection_reason_id, rejected_quantity_m3, remarks, site_slump_mm } = req.body;

  await query(
    `INSERT INTO site_qc (ticket_id, arrival_slump_mm, accepted, rejected_quantity_m3,
       rejection_reason_id, remarks, entered_by)
     VALUES ($1, $2, false, $3, $4, $5, $6)
     ON CONFLICT (ticket_id) DO UPDATE SET
       accepted = false, rejected_quantity_m3 = $3, rejection_reason_id = $4, remarks = $5`,
    [req.params.ticketId, site_slump_mm, rejected_quantity_m3, rejection_reason_id, remarks, req.user.id]
  );
  await query("UPDATE delivery_tickets SET status = 'rejected' WHERE id = $1", [req.params.ticketId]);
  await logEvent(req.params.ticketId, "rejected", req.user.id);

  await query(
    `INSERT INTO notifications (recipient_role, ticket_id, type, message)
     VALUES ('manager', $1, 'concrete_rejected', 'Concrete rejected at site — pending manager approval')`,
    [req.params.ticketId]
  );

  res.json({ ok: true });
});

export default router;
