import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("qc_engineer", "manager", "administrator"));

async function logEvent(ticketId, eventType, userId) {
  await query(
    `INSERT INTO trip_events (ticket_id, event_type, source, edited_by)
     VALUES ($1, $2, 'manual', $3)`,
    [ticketId, eventType, userId]
  );
}

// Tickets awaiting plant QC (created but not yet QC'd)
router.get("/pending-qc", async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, t.truck_number, s.name AS site_name, m.name AS mix_grade_name,
            co.cube_samples_required
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN plant_qc pq ON pq.ticket_id = dt.id
     WHERE dt.status = 'created' AND pq.id IS NULL AND dt.ticket_date = CURRENT_DATE
     ORDER BY dt.created_at`
  );
  res.json(rows);
});

// Submit plant QC — advances ticket to dispatched, matching the Trip Status Timeline
router.post("/:ticketId/plant-qc", requireRole("qc_engineer", "administrator"), async (req, res) => {
  const { slump_mm, temperature_c, number_of_cubes, sample_ids, remarks } = req.body;

  await query(
    `INSERT INTO plant_qc (ticket_id, slump_mm, temperature_c, number_of_cubes, sample_ids, remarks, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (ticket_id) DO UPDATE SET
       slump_mm = $2, temperature_c = $3, number_of_cubes = $4, sample_ids = $5, remarks = $6`,
    [req.params.ticketId, slump_mm, temperature_c, number_of_cubes, sample_ids, remarks, req.user.id]
  );
  await logEvent(req.params.ticketId, "plant_qc_completed", req.user.id);
  await query("UPDATE delivery_tickets SET status = 'dispatched' WHERE id = $1", [req.params.ticketId]);
  await logEvent(req.params.ticketId, "dispatched", req.user.id);

  res.json({ ok: true });
});

export default router;
