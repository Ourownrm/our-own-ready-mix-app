import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("driver", "manager", "accountant", "administrator"));

const EQUIPMENT_TYPES = ["truck", "pump", "pickup_van", "loader", "generator"];

router.post("/", async (req, res) => {
  const {
    equipment_type, truck_id, pump_id, equipment_id,
    odometer_reading, hour_meter_reading,
    fuel_quantity_litres, fuel_cost, fuel_station_id,
  } = req.body;

  if (!equipment_type || !EQUIPMENT_TYPES.includes(equipment_type)) {
    return res.status(400).json({ error: "Select which type of equipment this is." });
  }
  if (equipment_type === "truck" && !truck_id) return res.status(400).json({ error: "Select which truck." });
  if (equipment_type === "pump" && !pump_id) return res.status(400).json({ error: "Select which pump." });
  if (["pickup_van", "loader", "generator"].includes(equipment_type) && !equipment_id) {
    return res.status(400).json({ error: "Select which unit." });
  }
  if (!fuel_quantity_litres) {
    return res.status(400).json({ error: "Enter the fuel quantity." });
  }
  if (!odometer_reading && !hour_meter_reading) {
    return res.status(400).json({ error: "Enter either an odometer reading or an hour meter reading." });
  }

  const { rows } = await query(
    `INSERT INTO fuel_logs
     (equipment_type, truck_id, pump_id, equipment_id, odometer_reading, hour_meter_reading,
      fuel_quantity_litres, fuel_cost, fuel_station_id, logged_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      equipment_type,
      equipment_type === "truck" ? truck_id : null,
      equipment_type === "pump" ? pump_id : null,
      ["pickup_van", "loader", "generator"].includes(equipment_type) ? equipment_id : null,
      odometer_reading || null, hour_meter_reading || null,
      fuel_quantity_litres, fuel_cost || null, fuel_station_id || null, req.user.id,
    ]
  );
  res.status(201).json(rows[0]);
});

// Recent fuel history across every equipment type — the report this naturally
// gives you. Grouping/aggregating "litres and cost per equipment" happens on
// the frontend from this same flat list, so there's a single source of truth
// to build the later high-consumption/early-refill flagging on top of.
router.get("/history", async (req, res) => {
  const { rows } = await query(
    `SELECT f.id, f.equipment_type, f.odometer_reading, f.hour_meter_reading,
            f.fuel_quantity_litres, f.fuel_cost, f.logged_at,
            t.truck_number, p.pump_code, e.name AS equipment_name,
            fs.name AS fuel_station_name, u.name AS logged_by_name
     FROM fuel_logs f
     LEFT JOIN trucks t ON t.id = f.truck_id
     LEFT JOIN pumps p ON p.id = f.pump_id
     LEFT JOIN equipment e ON e.id = f.equipment_id
     LEFT JOIN fuel_stations fs ON fs.id = f.fuel_station_id
     LEFT JOIN users u ON u.id = f.logged_by
     ORDER BY f.logged_at DESC
     LIMIT 300`
  );
  res.json(rows);
});

export default router;
