import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth); // per-route role checks below, since customers/sites/rates need broader access

// ===== Users =====

router.get("/users", requireRole("administrator"), async (req, res) => {
  const { rows } = await query(
    "SELECT id, name, phone, email, role, is_active, created_at FROM users ORDER BY created_at DESC"
  );
  res.json(rows);
});

router.post("/users", requireRole("administrator"), async (req, res) => {
  const { name, phone, email, password, role } = req.body;
  if (!name || !phone || !password || !role) {
    return res.status(400).json({ error: "Name, phone, password, and role are all required." });
  }
  const validRoles = ["administrator", "manager", "plant_operator", "qc_engineer", "driver", "site_supervisor", "accountant"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: "That role isn't recognized." });
  }

  const { rows: existing } = await query("SELECT id FROM users WHERE phone = $1", [phone]);
  if (existing.length) {
    return res.status(400).json({ error: "A user with that phone number already exists." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (name, phone, email, password_hash, role)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phone, email, role, is_active`,
    [name, phone, email || null, passwordHash, role]
  );
  res.status(201).json(rows[0]);
});

// Toggle active/disabled — soft only, never a hard delete (SRS §16)
router.patch("/users/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE users SET is_active = $1, updated_at = now() WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

router.post("/users/:id/reset-password", requireRole("administrator"), async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  const passwordHash = await bcrypt.hash(new_password, 10);
  await query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [passwordHash, req.params.id]);
  res.json({ ok: true });
});

// ===== Master data: Customers =====

router.post("/customers", requireRole("administrator", "manager"), async (req, res) => {
  const { name, contact_number, billing_address } = req.body;
  if (!name) return res.status(400).json({ error: "Customer name is required." });
  const { rows } = await query(
    "INSERT INTO customers (name, contact_number, billing_address) VALUES ($1,$2,$3) RETURNING *",
    [name, contact_number, billing_address]
  );
  res.status(201).json(rows[0]);
});

// ===== Master data: Sites =====

router.post("/sites", requireRole("administrator", "manager"), async (req, res) => {
  const { customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude } = req.body;
  if (!customer_id || !name) return res.status(400).json({ error: "Customer and site name are required." });
  const { rows } = await query(
    `INSERT INTO sites (customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude || null, longitude || null]
  );
  res.status(201).json(rows[0]);
});

// ===== Master data: Trucks =====

router.post("/trucks", requireRole("administrator"), async (req, res) => {
  const { truck_number, capacity_m3 } = req.body;
  if (!truck_number) return res.status(400).json({ error: "Truck number is required." });
  const { rows } = await query(
    "INSERT INTO trucks (truck_number, capacity_m3) VALUES ($1,$2) RETURNING *",
    [truck_number, capacity_m3]
  );
  res.status(201).json(rows[0]);
});

// ===== Master data: Rate master (rate per m3, pumping & waiting charges) =====

router.post("/rates", requireRole("administrator", "accountant"), async (req, res) => {
  const { customer_id, mix_grade_id, rate_per_m3, pumping_charge_lumpsum, waiting_charge_per_hour, effective_from } = req.body;
  if (!customer_id || !mix_grade_id || !rate_per_m3 || !effective_from) {
    return res.status(400).json({ error: "Customer, mix grade, rate, and effective date are required." });
  }
  const { rows } = await query(
    `INSERT INTO rate_master (customer_id, mix_grade_id, rate_per_m3, pumping_charge_lumpsum, waiting_charge_per_hour, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [customer_id, mix_grade_id, rate_per_m3, pumping_charge_lumpsum || 0, waiting_charge_per_hour || 0, effective_from]
  );
  res.status(201).json(rows[0]);
});

// ===== Master data: Pumps =====

router.post("/pumps", requireRole("administrator"), async (req, res) => {
  const { pump_code, pump_type } = req.body;
  if (!pump_code || !pump_type) return res.status(400).json({ error: "Pump code and type are required." });
  const { rows } = await query(
    "INSERT INTO pumps (pump_code, pump_type) VALUES ($1,$2) RETURNING *",
    [pump_code, pump_type]
  );
  res.status(201).json(rows[0]);
});

// ===== Correcting mistaken entries (orders & tickets) =====
// Nothing is ever hard-deleted (SRS §16) — "delete" here means cancelling, which
// keeps the record but excludes it from active workflows and dashboards.

router.get("/orders", requireRole("administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.order_date, o.order_quantity_m3, o.status, o.scheduled_batching_time,
            c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     ORDER BY o.order_date DESC, o.id DESC
     LIMIT 100`
  );
  res.json(rows);
});

router.patch("/orders/:id", requireRole("administrator"), async (req, res) => {
  const { order_quantity_m3, scheduled_batching_time, remarks } = req.body;
  const { rows } = await query(
    `UPDATE customer_orders SET
       order_quantity_m3 = COALESCE($1, order_quantity_m3),
       scheduled_batching_time = COALESCE($2, scheduled_batching_time),
       remarks = COALESCE($3, remarks)
     WHERE id = $4 RETURNING *`,
    [order_quantity_m3, scheduled_batching_time, remarks, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found." });
  res.json(rows[0]);
});

router.post("/orders/:id/cancel", requireRole("administrator"), async (req, res) => {
  await query("UPDATE customer_orders SET status = 'cancelled' WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

router.get("/tickets", requireRole("administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, dt.loaded_quantity_m3, dt.status, dt.ticket_date,
            t.truck_number, u.name AS driver_name, s.name AS site_name
     FROM delivery_tickets dt
     JOIN trucks t ON t.id = dt.truck_id
     JOIN users u ON u.id = dt.driver_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     ORDER BY dt.ticket_date DESC, dt.id DESC
     LIMIT 100`
  );
  res.json(rows);
});

router.patch("/tickets/:id", requireRole("administrator"), async (req, res) => {
  const { loaded_quantity_m3 } = req.body;
  const { rows } = await query(
    `UPDATE delivery_tickets SET loaded_quantity_m3 = COALESCE($1, loaded_quantity_m3) WHERE id = $2 RETURNING *`,
    [loaded_quantity_m3, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Ticket not found." });
  res.json(rows[0]);
});

router.post("/tickets/:id/cancel", requireRole("administrator"), async (req, res) => {
  await query("UPDATE delivery_tickets SET status = 'cancelled' WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

export default router;
