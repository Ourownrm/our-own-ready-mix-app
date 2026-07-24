import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole } from "../lib/push.js";

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

// Raw material stock — QC Engineer enters/updates daily. Shown read-only on
// Manager and Administrator dashboards until QC updates it again.
//
// Protected by a shared PIN (RAW_MATERIAL_STOCK_PIN env var) so that on a
// shared device/login, not just anyone who can open the QC screen can also
// edit stock — only whoever knows the PIN. If the PIN isn't configured on
// the server yet, saves are still allowed (so this doesn't break anything
// for anyone who hasn't set it up), but nothing is actually protected until
// you do — see README for how to set it.
router.put("/raw-material-stock", requireRole("qc_engineer"), async (req, res) => {
  const configuredPin = process.env.RAW_MATERIAL_STOCK_PIN;
  if (configuredPin && req.body.pin !== configuredPin) {
    return res.status(403).json({ error: "Incorrect PIN." });
  }

  const updates = req.body.rows || [];
  for (const row of updates) {
    await query(
      `UPDATE raw_material_stock SET type_brand = $1, stock_qty = $2, updated_by = $3, updated_at = now()
       WHERE id = $4`,
      [row.type_brand || null, row.stock_qty || 0, req.user.id, row.id]
    );
  }
  const { rows } = await query(
    `SELECT s.id, s.bin_name, s.unit, s.type_brand, s.stock_qty, s.updated_at, u.name AS updated_by_name
     FROM raw_material_stock s LEFT JOIN users u ON u.id = s.updated_by
     ORDER BY s.id`
  );
  res.json(rows);
});

// Trucks that have been sitting at site more than 2 hours — same data Manager
// sees on Active Trucks, so QC can proactively check on quality without
// waiting to be told, and flag it back to Manager if something looks off.
router.get("/delayed-trucks", async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, t.truck_number, u.name AS driver_name,
            c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
            rs.event_time AS reached_site_at,
            EXTRACT(EPOCH FROM (now() - rs.event_time)) / 60 AS minutes_at_site,
            EXISTS (
              SELECT 1 FROM notifications n
              WHERE n.ticket_id = dt.id AND n.type = 'qc_flagged_delay' AND n.is_read = false
            ) AS already_flagged
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN users u ON u.id = dt.driver_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     JOIN LATERAL (
       SELECT event_time FROM trip_events
       WHERE ticket_id = dt.id AND event_type = 'reached_site'
       ORDER BY event_time DESC LIMIT 1
     ) rs ON true
     WHERE dt.ticket_date = CURRENT_DATE AND dt.status IN ('reached_site', 'unloading')
       AND rs.event_time < now() - INTERVAL '2 hours'
     ORDER BY rs.event_time`
  );
  res.json(rows);
});

// QC flags a delayed truck for Manager's attention — shows up directly on the
// Manager Dashboard's Active Trucks table (as a badge on that row), not as a
// separate notification inbox (the app doesn't have one yet).
router.post("/delayed-trucks/:ticketId/flag", async (req, res) => {
  await query(
    `INSERT INTO notifications (recipient_role, ticket_id, type, message)
     VALUES ('manager', $1, 'qc_flagged_delay', 'QC Engineer flagged this delayed truck for review')`,
    [req.params.ticketId]
  );
  const { rows } = await query(
    `SELECT dt.ticket_number, t.truck_number FROM delivery_tickets dt JOIN trucks t ON t.id = dt.truck_id WHERE dt.id = $1`,
    [req.params.ticketId]
  );
  await pushToRole("manager", {
    title: "QC flagged a delayed truck",
    body: rows[0] ? `${rows[0].ticket_number} — ${rows[0].truck_number}` : "A delayed truck was flagged",
    url: "/manager",
  });
  res.json({ ok: true });
});

export default router;
