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
  const validRoles = ["administrator", "manager", "plant_operator", "qc_engineer", "driver", "site_supervisor", "accountant", "sales_executive"];
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

  // A Sales Executive account should immediately show up correctly in the
  // existing salesperson dropdown/reports, linked to their real login rather
  // than existing only as a disconnected name.
  if (role === "sales_executive") {
    await query(
      `INSERT INTO salespersons (name, user_id) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET user_id = $2`,
      [name, rows[0].id]
    );
  }

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

// Every customer including disabled ones, with full detail — for the
// Administrator management panel specifically. (The plain /master/customers
// endpoint stays active-only, id+name — that's what every dropdown across
// the app uses, and disabling a customer here correctly removes them from
// all of those automatically.)
router.get("/customers", requireRole("administrator", "manager"), async (req, res) => {
  const { rows } = await query("SELECT * FROM customers ORDER BY name");
  res.json(rows);
});

router.post("/customers", requireRole("administrator", "manager"), async (req, res) => {
  const { name, contact_number, billing_address } = req.body;
  if (!name) return res.status(400).json({ error: "Customer name is required." });
  const { rows } = await query(
    "INSERT INTO customers (name, contact_number, billing_address) VALUES ($1,$2,$3) RETURNING *",
    [name, contact_number, billing_address]
  );
  res.status(201).json(rows[0]);
});

router.patch("/customers/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { name, contact_number, billing_address } = req.body;
  if (!name) return res.status(400).json({ error: "Customer name is required." });
  const { rows } = await query(
    `UPDATE customers SET name = $1, contact_number = $2, billing_address = $3 WHERE id = $4 RETURNING *`,
    [name, contact_number || null, billing_address || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Customer not found." });
  res.json(rows[0]);
});

router.post("/customers/:id/status", requireRole("administrator", "manager"), async (req, res) => {
  const { is_active } = req.body;
  const { rows } = await query(
    "UPDATE customers SET is_active = $1 WHERE id = $2 RETURNING *",
    [!!is_active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Customer not found." });
  res.json(rows[0]);
});

// Hard delete — only allowed if nothing actually references this customer
// yet (no orders, sites, leads, or bookings). Almost always the right move
// for a real, established customer is "Disable" instead, which is reversible
// and doesn't risk an FK conflict; delete is really for a duplicate or a
// pure data-entry mistake caught immediately.
router.delete("/customers/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { rows: usageCheck } = await query(
    `SELECT
       (SELECT COUNT(*) FROM customer_orders WHERE customer_id = $1) AS orders,
       (SELECT COUNT(*) FROM sites WHERE customer_id = $1) AS sites,
       (SELECT COUNT(*) FROM leads WHERE won_customer_id = $1) AS leads,
       (SELECT COUNT(*) FROM bookings WHERE customer_id = $1) AS bookings,
       (SELECT COUNT(*) FROM rate_master WHERE customer_id = $1) AS rates,
       (SELECT COUNT(*) FROM invoices WHERE customer_id = $1) AS invoices,
       (SELECT COUNT(*) FROM aftersales_feedback WHERE customer_id = $1) AS feedback,
       (SELECT COUNT(*) FROM customer_visits WHERE customer_id = $1) AS visits,
       (SELECT COUNT(*) FROM customer_opening_balances WHERE customer_id = $1) AS opening_balances`,
    [req.params.id]
  );
  const usage = usageCheck[0];
  const inUse = Object.values(usage).some((n) => Number(n) > 0);
  if (inUse) {
    return res.status(400).json({ error: "This customer has orders, sites, or other records on file — disable it instead of deleting." });
  }
  const { rowCount } = await query("DELETE FROM customers WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Customer not found." });
  res.json({ ok: true });
});

// ===== Master data: Sites =====

// Every site including disabled ones, with full detail plus its assigned
// salesperson — for the Administrator management panel.
router.get("/sites", requireRole("administrator", "manager"), async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, c.name AS customer_name, sp.name AS salesperson_name,
            tc.label AS trip_allowance_label
     FROM sites s
     JOIN customers c ON c.id = s.customer_id
     LEFT JOIN salespersons sp ON sp.id = s.assigned_sales_representative_id
     LEFT JOIN trip_allowance_categories tc ON tc.id = s.trip_allowance_category_id
     ORDER BY c.name, s.name`
  );
  res.json(rows);
});

router.post("/sites", requireRole("administrator", "manager"), async (req, res) => {
  const { customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude, assigned_sales_representative_id, force } = req.body;
  if (!customer_id || !name) return res.status(400).json({ error: "Customer and site name are required." });
  if (!assigned_sales_representative_id) return res.status(400).json({ error: "Every site needs a salesperson assigned." });

  if (!force) {
    const { rows: dup } = await query(
      "SELECT id FROM sites WHERE customer_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))",
      [customer_id, name]
    );
    if (dup.length) {
      return res.status(409).json({
        error: `A site named "${name}" already exists for this customer. Creating another with the same name will silently split future orders and rates across two records. Use the existing one, or confirm to create a duplicate anyway.`,
        duplicate_site_id: dup[0].id,
      });
    }
  }

  const { rows } = await query(
    `INSERT INTO sites (customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude, assigned_sales_representative_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude || null, longitude || null, assigned_sales_representative_id]
  );
  res.status(201).json(rows[0]);
});

router.patch("/sites/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude } = req.body;
  if (!name) return res.status(400).json({ error: "Site name is required." });
  const { rows } = await query(
    `UPDATE sites SET name = $1, address = $2, distance_from_plant_km = $3, trip_allowance_category_id = $4,
       latitude = $5, longitude = $6
     WHERE id = $7 RETURNING *`,
    [name, address || null, distance_from_plant_km || null, trip_allowance_category_id || null,
     latitude || null, longitude || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Site not found." });
  res.json(rows[0]);
});

router.post("/sites/:id/status", requireRole("administrator", "manager"), async (req, res) => {
  const { is_active } = req.body;
  const { rows } = await query(
    "UPDATE sites SET is_active = $1 WHERE id = $2 RETURNING *",
    [!!is_active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Site not found." });
  res.json(rows[0]);
});

// Hard delete — only if nothing references this site yet. Disable is the
// right move for any site with real history.
router.delete("/sites/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { rows: usageCheck } = await query(
    `SELECT
       (SELECT COUNT(*) FROM customer_orders WHERE site_id = $1) AS orders,
       (SELECT COUNT(*) FROM sales_forecasts WHERE site_id = $1) AS forecasts,
       (SELECT COUNT(*) FROM bookings WHERE site_id = $1) AS bookings,
       (SELECT COUNT(*) FROM notifications WHERE site_id = $1) AS notifications`,
    [req.params.id]
  );
  const usage = usageCheck[0];
  const inUse = Object.values(usage).some((n) => Number(n) > 0);
  if (inUse) {
    return res.status(400).json({ error: "This site has orders, forecasts, or other records on file — disable it instead of deleting." });
  }
  const { rowCount } = await query("DELETE FROM sites WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Site not found." });
  res.json({ ok: true });
});

// Two site records with the identical name under the same customer is a
// real, serious problem, not just a display nuisance — a rate set up
// against one of them silently never matches orders created against the
// other, even though both show the same name everywhere. Detects the
// pattern (case/whitespace-insensitive match) so it can be found before it
// causes another round of "why isn't this invoicing."
router.get("/sites/duplicates", requireRole("administrator", "manager"), async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.customer_id, c.name AS customer_name, s.is_active,
            (SELECT COUNT(*) FROM customer_orders WHERE site_id = s.id) AS order_count,
            (SELECT COUNT(*) FROM rate_master WHERE site_id = s.id) AS rate_count,
            (SELECT COUNT(*) FROM bookings WHERE site_id = s.id) AS booking_count,
            (SELECT COUNT(*) FROM sales_forecasts WHERE site_id = s.id) AS forecast_count
     FROM sites s
     JOIN customers c ON c.id = s.customer_id
     WHERE EXISTS (
       SELECT 1 FROM sites s2
       WHERE s2.customer_id = s.customer_id AND s2.id != s.id
         AND LOWER(TRIM(s2.name)) = LOWER(TRIM(s.name))
     )
     ORDER BY c.name, LOWER(TRIM(s.name)), s.id`
  );
  res.json(rows);
});

// Reassigns every reference from one site to another and disables the one
// being merged away — the records themselves (past orders, invoices) are
// never touched or deleted, only which site row they point at.
router.post("/sites/:duplicateId/merge-into/:canonicalId", requireRole("administrator", "manager"), async (req, res) => {
  const { duplicateId, canonicalId } = req.params;
  if (duplicateId === canonicalId) return res.status(400).json({ error: "Can't merge a site into itself." });
  const { rows: both } = await query("SELECT id, customer_id FROM sites WHERE id IN ($1, $2)", [duplicateId, canonicalId]);
  if (both.length !== 2) return res.status(404).json({ error: "One of these sites wasn't found." });
  if (both[0].customer_id !== both[1].customer_id) {
    return res.status(400).json({ error: "These sites belong to different customers — merging them would move records to the wrong customer." });
  }

  await query("UPDATE customer_orders SET site_id = $1 WHERE site_id = $2", [canonicalId, duplicateId]);
  await query("UPDATE rate_master SET site_id = $1 WHERE site_id = $2", [canonicalId, duplicateId]);
  await query("UPDATE bookings SET site_id = $1 WHERE site_id = $2", [canonicalId, duplicateId]);
  // A forecast is unique per site — if the canonical site already has one,
  // the duplicate's would collide, so only move it over if there isn't one.
  await query(
    `UPDATE sales_forecasts SET site_id = $1 WHERE site_id = $2
     AND NOT EXISTS (SELECT 1 FROM sales_forecasts WHERE site_id = $1)`,
    [canonicalId, duplicateId]
  );
  await query("DELETE FROM sales_forecasts WHERE site_id = $2", [duplicateId]); // any leftover (collided) one
  await query("UPDATE notifications SET site_id = $1 WHERE site_id = $2", [canonicalId, duplicateId]);
  await query("UPDATE sites SET is_active = false WHERE id = $1", [duplicateId]);

  res.json({ ok: true });
});

router.get("/trucks", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM trucks ORDER BY truck_number");
  res.json(rows);
});

router.post("/trucks", requireRole("administrator"), async (req, res) => {
  const { truck_number, capacity_m3 } = req.body;
  if (!truck_number) return res.status(400).json({ error: "Truck number is required." });
  const { rows } = await query(
    "INSERT INTO trucks (truck_number, capacity_m3) VALUES ($1,$2) RETURNING *",
    [truck_number, capacity_m3]
  );
  res.status(201).json(rows[0]);
});

// Deactivate/reactivate — safe default, doesn't touch any history that points at this truck.
router.patch("/trucks/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE trucks SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

// Hard delete — only for a mistaken entry (e.g. a typo) that was never actually used.
// If it's referenced by any delivery ticket, breakdown report, etc., Postgres blocks
// the delete and we surface a clear message instead of a generic error.
router.delete("/trucks/:id", requireRole("administrator"), async (req, res) => {
  try {
    const { rowCount } = await query("DELETE FROM trucks WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Truck not found." });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(400).json({ error: "This truck already has tickets or other records against it — deactivate it instead of deleting." });
    }
    throw err;
  }
});

// ===== Master data: Rate master (rate per m3, pumping & waiting charges) =====

// Full rate history — every rate ever entered, past and current, so
// Administrator can actually see what's on file before adding a new one
// instead of guessing (this visibility gap is what let overlapping/
// inconsistent rates happen in the first place).
router.get("/rates", requireRole("administrator", "accountant", "manager"), async (req, res) => {
  const { rows } = await query(
    `SELECT rm.*, c.name AS customer_name, m.name AS mix_grade_name, s.name AS site_name,
            (rm.effective_from <= CURRENT_DATE AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)) AS currently_active
     FROM rate_master rm
     JOIN customers c ON c.id = rm.customer_id
     JOIN mix_grades m ON m.id = rm.mix_grade_id
     LEFT JOIN sites s ON s.id = rm.site_id
     ORDER BY c.name, s.name, m.name, rm.effective_from DESC`
  );
  res.json(rows);
});

router.post("/rates", requireRole("administrator", "accountant", "manager"), async (req, res) => {
  const {
    customer_id, site_id, mix_grade_id, rate_per_m3, waiting_charge_per_hour, effective_from,
    line_pump_charge, line_pump_min_qty_m3, boom_pump_charge, boom_pump_min_qty_m3,
    part_load_min_qty_m3, part_load_charge_per_m3,
  } = req.body;
  if (!customer_id || !site_id || !mix_grade_id || !rate_per_m3 || !effective_from) {
    return res.status(400).json({ error: "Customer, site/project, mix grade, rate, and effective date are all required." });
  }
  const { rows } = await query(
    `INSERT INTO rate_master
       (customer_id, site_id, mix_grade_id, rate_per_m3, waiting_charge_per_hour, effective_from,
        line_pump_charge, line_pump_min_qty_m3, boom_pump_charge, boom_pump_min_qty_m3,
        part_load_min_qty_m3, part_load_charge_per_m3)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [customer_id, site_id, mix_grade_id, rate_per_m3, waiting_charge_per_hour || 0, effective_from,
     line_pump_charge || null, line_pump_min_qty_m3 || 20, boom_pump_charge || null, boom_pump_min_qty_m3 || 50,
     part_load_min_qty_m3 || 5, part_load_charge_per_m3 || null]
  );
  res.status(201).json(rows[0]);
});

// Closes out a rate as of a given date, so it stops being picked up for new
// deliveries from that point on — use this when replacing a rate instead of
// just adding a new row and leaving the old one open-ended indefinitely.
router.post("/rates/:id/end", requireRole("administrator", "accountant", "manager"), async (req, res) => {
  const { effective_to } = req.body;
  if (!effective_to) return res.status(400).json({ error: "End date is required." });
  const { rows } = await query(
    "UPDATE rate_master SET effective_to = $1 WHERE id = $2 RETURNING *",
    [effective_to, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Rate not found." });
  res.json(rows[0]);
});

// Cleanup for a bug where /setup's sample-data seeding ran on every call
// instead of only a fresh install — it silently inserted a ₹4500/₹1500/₹500
// M25 rate for any real customer that didn't yet have an M25 rate of their
// own. Finds rows matching that exact fingerprint (generic, no site) so they
// can be reviewed and removed. Never runs automatically — this only lists
// candidates for a human to check.
router.get("/rates/review-seed-pollution", requireRole("administrator", "accountant", "manager"), async (req, res) => {
  const { rows } = await query(
    `SELECT rm.*, c.name AS customer_name, m.name AS mix_grade_name,
            (SELECT COUNT(*) FROM invoices i
             JOIN delivery_tickets dt ON dt.id = i.ticket_id
             JOIN customer_orders co ON co.id = dt.order_id
             WHERE co.customer_id = rm.customer_id AND co.mix_grade_id = rm.mix_grade_id
               AND i.concrete_amount = dt.loaded_quantity_m3 * rm.rate_per_m3) AS possibly_affected_invoices
     FROM rate_master rm
     JOIN customers c ON c.id = rm.customer_id
     JOIN mix_grades m ON m.id = rm.mix_grade_id
     WHERE rm.site_id IS NULL AND rm.rate_per_m3 = 4500 AND rm.pumping_charge_lumpsum = 1500
       AND rm.waiting_charge_per_hour = 500 AND m.name = 'M25'
     ORDER BY c.name`
  );
  res.json(rows);
});

router.delete("/rates/:id", requireRole("administrator", "accountant", "manager"), async (req, res) => {
  const { rowCount } = await query("DELETE FROM rate_master WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Rate not found." });
  res.json({ ok: true });
});

// ===== Master data: Pumps =====

router.get("/pumps", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM pumps ORDER BY pump_code");
  res.json(rows);
});

router.post("/pumps", requireRole("administrator"), async (req, res) => {
  const { pump_code, pump_type } = req.body;
  if (!pump_code || !pump_type) return res.status(400).json({ error: "Pump code and type are required." });
  const { rows } = await query(
    "INSERT INTO pumps (pump_code, pump_type) VALUES ($1,$2) RETURNING *",
    [pump_code, pump_type]
  );
  res.status(201).json(rows[0]);
});

router.patch("/pumps/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE pumps SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

router.delete("/pumps/:id", requireRole("administrator"), async (req, res) => {
  try {
    const { rowCount } = await query("DELETE FROM pumps WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Pump not found." });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(400).json({ error: "This pump already has orders or other records against it — deactivate it instead of deleting." });
    }
    throw err;
  }
});

// ===== Master data: Fuel stations =====

router.get("/fuel-stations", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM fuel_stations ORDER BY name");
  res.json(rows);
});

router.post("/fuel-stations", requireRole("administrator"), async (req, res) => {
  const { name, location } = req.body;
  if (!name) return res.status(400).json({ error: "Station name is required." });
  const { rows } = await query(
    "INSERT INTO fuel_stations (name, location) VALUES ($1,$2) RETURNING *",
    [name, location || null]
  );
  res.status(201).json(rows[0]);
});

router.patch("/fuel-stations/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE fuel_stations SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

router.delete("/fuel-stations/:id", requireRole("administrator"), async (req, res) => {
  try {
    const { rowCount } = await query("DELETE FROM fuel_stations WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Fuel station not found." });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(400).json({ error: "This station already has fuel entries against it — deactivate it instead of deleting." });
    }
    throw err;
  }
});

// ===== Master data: Equipment (pickup vans, loaders, generators) =====

router.get("/equipment", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM equipment ORDER BY equipment_type, name");
  res.json(rows);
});

router.post("/equipment", requireRole("administrator"), async (req, res) => {
  const { equipment_type, name } = req.body;
  if (!equipment_type || !["pickup_van", "loader", "generator"].includes(equipment_type)) {
    return res.status(400).json({ error: "Equipment type must be pickup van, loader, or generator." });
  }
  if (!name) return res.status(400).json({ error: "Name is required." });
  const { rows } = await query(
    "INSERT INTO equipment (equipment_type, name) VALUES ($1,$2) RETURNING *",
    [equipment_type, name]
  );
  res.status(201).json(rows[0]);
});

router.patch("/equipment/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE equipment SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

router.delete("/equipment/:id", requireRole("administrator"), async (req, res) => {
  try {
    const { rowCount } = await query("DELETE FROM equipment WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Equipment not found." });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(400).json({ error: "This equipment already has fuel entries against it — deactivate it instead of deleting." });
    }
    throw err;
  }
});

// ===== Master data: Salespersons (dropdown, replaces free-text sales rep) =====

router.get("/salespersons", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM salespersons ORDER BY name");
  res.json(rows);
});

router.post("/salespersons", requireRole("administrator", "manager"), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required." });
  const { rows } = await query(
    `INSERT INTO salespersons (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET is_active = true
     RETURNING *`,
    [name.trim()]
  );
  res.status(201).json(rows[0]);
});

router.patch("/salespersons/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE salespersons SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

// ===== Correcting mistaken entries (orders & tickets) =====
// Nothing is ever hard-deleted (SRS §16) — "delete" here means cancelling, which
// keeps the record but excludes it from active workflows and dashboards.

router.get("/orders", requireRole("administrator", "manager"), async (req, res) => {
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

router.patch("/orders/:id", requireRole("administrator", "manager"), async (req, res) => {
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

router.post("/orders/:id/reschedule", requireRole("administrator", "manager"), async (req, res) => {
  const { new_order_date, new_scheduled_batching_time, reason } = req.body;
  if (!reason || (!new_order_date && !new_scheduled_batching_time)) {
    return res.status(400).json({ error: "A reason and at least a new date or new time are required to reschedule." });
  }
  const { rows } = await query(
    `UPDATE customer_orders SET
       original_order_date = COALESCE(original_order_date, order_date),
       original_scheduled_batching_time = COALESCE(original_scheduled_batching_time, scheduled_batching_time),
       order_date = COALESCE($1, order_date),
       scheduled_batching_time = COALESCE($2, scheduled_batching_time),
       reschedule_reason = $3, rescheduled_by = $4, rescheduled_at = now(),
       site_ready_confirmed = false, site_ready_confirmed_by = NULL, site_ready_confirmed_at = NULL
     WHERE id = $5 AND status NOT IN ('cancelled', 'closed', 'completed')
     RETURNING *`,
    [new_order_date || null, new_scheduled_batching_time || null, reason, req.user.id, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found or already closed out." });
  res.json(rows[0]);
});

router.post("/orders/:id/cancel", requireRole("administrator", "manager"), async (req, res) => {
  await query("UPDATE customer_orders SET status = 'cancelled' WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

router.get("/tickets", requireRole("administrator", "manager"), async (req, res) => {
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

router.patch("/tickets/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { loaded_quantity_m3 } = req.body;
  const { rows } = await query(
    `UPDATE delivery_tickets SET loaded_quantity_m3 = COALESCE($1, loaded_quantity_m3) WHERE id = $2 RETURNING *`,
    [loaded_quantity_m3, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Ticket not found." });
  res.json(rows[0]);
});

router.post("/tickets/:id/cancel", requireRole("administrator", "manager"), async (req, res) => {
  await query("UPDATE delivery_tickets SET status = 'cancelled' WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

export default router;
