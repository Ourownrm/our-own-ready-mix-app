import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// Report a pump or batching-plant breakdown — Plant Operator, QC Engineer, or
// Manager/Administrator can log these (Drivers keep using /driver/breakdown for
// trucks, which also writes into this same table).
router.post(
  "/",
  requireRole("plant_operator", "qc_engineer", "manager", "administrator"),
  async (req, res) => {
    const { equipment_type, pump_id, equipment_label, location, latitude, longitude, remarks } = req.body;
    if (!equipment_type || !["pump", "plant"].includes(equipment_type)) {
      return res.status(400).json({ error: "Equipment type must be 'pump' or 'plant'." });
    }
    if (equipment_type === "pump" && !pump_id) {
      return res.status(400).json({ error: "Select which pump broke down." });
    }
    if (!remarks) {
      return res.status(400).json({ error: "Describe what happened." });
    }
    const { rows } = await query(
      `INSERT INTO breakdown_reports
       (equipment_type, pump_id, equipment_label, reported_by, location, latitude, longitude, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [equipment_type, equipment_type === "pump" ? pump_id : null,
       equipment_type === "plant" ? (equipment_label || "Batching plant") : null,
       req.user.id, location, latitude || null, longitude || null, remarks]
    );
    res.status(201).json(rows[0]);
  }
);

// Manager/Administrator: everything currently unresolved, across trucks, pumps, and the plant.
router.get("/", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.equipment_type, b.breakdown_time, b.location, b.latitude, b.longitude,
            b.remarks, b.resolved, b.repaired_at,
            t.truck_number, p.pump_code, b.equipment_label,
            reporter.name AS reported_by_name, repairer.name AS repaired_by_name
     FROM breakdown_reports b
     LEFT JOIN trucks t ON t.id = b.truck_id
     LEFT JOIN pumps p ON p.id = b.pump_id
     LEFT JOIN users reporter ON reporter.id = COALESCE(b.reported_by, b.driver_id)
     LEFT JOIN users repairer ON repairer.id = b.repaired_by
     ORDER BY b.resolved ASC, b.breakdown_time DESC
     LIMIT 200`
  );
  res.json(rows);
});

// Manager marks a breakdown repaired — clears it off the active list.
router.post("/:id/repaired", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `UPDATE breakdown_reports
     SET resolved = TRUE, repaired_by = $1, repaired_at = now()
     WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Breakdown report not found." });
  res.json(rows[0]);
});

export default router;
