import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { voidInvoiceForTicket, generateInvoiceForTicket } from "../lib/deliveryConfirmation.js";

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
  const validRoles = ["administrator", "manager", "plant_operator", "qc_engineer", "lab_technician", "driver", "site_supervisor", "accountant", "sales_executive", "store"];
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

router.post("/customers", requireRole("administrator", "manager", "sales_executive"), async (req, res) => {
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

// ===== Round 121, item 3: Billing addresses (per-customer, multiple) =====
// Named, reusable billing profiles a customer maintains — a customer with
// none has every order fall back to the plain customers.billing_address
// field, exactly as before this feature existed.

router.get("/customers/:customerId/billing-addresses", requireRole("administrator", "manager", "sales_executive", "accountant"), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM customer_billing_addresses WHERE customer_id = $1 ORDER BY is_default DESC, is_active DESC, name`,
    [req.params.customerId]
  );
  res.json(rows);
});

router.post("/customers/:customerId/billing-addresses", requireRole("administrator", "manager"), async (req, res) => {
  const { name, address, gstin, is_default } = req.body;
  if (!name) return res.status(400).json({ error: "A name for this billing entity is required (e.g. the company name)." });
  const { rows: customerCheck } = await query("SELECT id FROM customers WHERE id = $1", [req.params.customerId]);
  if (!customerCheck.length) return res.status(404).json({ error: "Customer not found." });

  // First billing address a customer ever gets is set default automatically
  // — otherwise "keep a default always available" (the business's own
  // requirement) would silently not hold for the common case of a customer
  // who only ever adds one.
  const { rows: existing } = await query("SELECT COUNT(*) FROM customer_billing_addresses WHERE customer_id = $1", [req.params.customerId]);
  const shouldBeDefault = !!is_default || Number(existing[0].count) === 0;
  if (shouldBeDefault) {
    await query("UPDATE customer_billing_addresses SET is_default = false WHERE customer_id = $1", [req.params.customerId]);
  }
  const { rows } = await query(
    `INSERT INTO customer_billing_addresses (customer_id, name, address, gstin, is_default)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.customerId, name, address || null, gstin || null, shouldBeDefault]
  );
  res.status(201).json(rows[0]);
});

router.patch("/billing-addresses/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { name, address, gstin } = req.body;
  if (!name) return res.status(400).json({ error: "A name for this billing entity is required." });
  const { rows } = await query(
    `UPDATE customer_billing_addresses SET name = $1, address = $2, gstin = $3 WHERE id = $4 RETURNING *`,
    [name, address || null, gstin || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Billing address not found." });
  res.json(rows[0]);
});

router.post("/billing-addresses/:id/set-default", requireRole("administrator", "manager"), async (req, res) => {
  const { rows: rowCheck } = await query("SELECT customer_id FROM customer_billing_addresses WHERE id = $1", [req.params.id]);
  if (!rowCheck.length) return res.status(404).json({ error: "Billing address not found." });
  await query("UPDATE customer_billing_addresses SET is_default = false WHERE customer_id = $1", [rowCheck[0].customer_id]);
  await query("UPDATE customer_billing_addresses SET is_default = true WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// Deactivate rather than delete — past orders/invoices keep referencing this
// row (invoices only ever snapshot its text anyway, so a deactivated profile
// changes nothing about history), it just stops appearing as a choice for
// new orders.
router.post("/billing-addresses/:id/status", requireRole("administrator", "manager"), async (req, res) => {
  const { is_active } = req.body;
  const { rows } = await query(
    "UPDATE customer_billing_addresses SET is_active = $1 WHERE id = $2 RETURNING *",
    [!!is_active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Billing address not found." });
  res.json(rows[0]);
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

// Round 121, item 6 — every site's geofence anchor (the coordinate + radius
// that decides "has this truck reached/left the site" for auto-detection),
// alongside the freshest Site Supervisor site-ready GPS tap on file for it —
// so a manager can see exactly what's actually driving detection for a site,
// compare it against where the site really is on the map, and fix a stale or
// missing saved coordinate without needing a database console. This is a
// diagnostic/adjustment view, not a new detection mechanism — the detection
// logic in scheduledChecks.js is unchanged; this just makes what it's using
// visible and editable.
router.get("/sites/geofence-report", requireRole("administrator", "manager"), async (req, res) => {
  const { rows: plant } = await query(
    `SELECT id, name, latitude, longitude, geofence_radius_m, is_active FROM plant_locations ORDER BY is_active DESC, name`
  );
  const { rows: sites } = await query(
    `SELECT s.id, s.name, s.latitude, s.longitude, s.geofence_radius_m, s.distance_from_plant_km,
            c.name AS customer_name,
            lr.site_ready_latitude AS last_site_ready_latitude, lr.site_ready_longitude AS last_site_ready_longitude,
            lr.site_ready_location_suspect AS last_site_ready_suspect, lr.site_ready_confirmed_at AS last_site_ready_at
     FROM sites s
     JOIN customers c ON c.id = s.customer_id
     LEFT JOIN LATERAL (
       SELECT site_ready_latitude, site_ready_longitude, site_ready_location_suspect, site_ready_confirmed_at
       FROM customer_orders
       WHERE site_id = s.id AND site_ready_confirmed_at IS NOT NULL
       ORDER BY site_ready_confirmed_at DESC LIMIT 1
     ) lr ON true
     ORDER BY c.name, s.name`
  );
  res.json({ plant_locations: plant, sites });
});

router.post("/sites", requireRole("administrator", "manager", "sales_executive"), async (req, res) => {
  const { customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude, geofence_radius_m, assigned_sales_representative_id, plant_out_grace_minutes, force } = req.body;
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
    `INSERT INTO sites (customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude, geofence_radius_m, assigned_sales_representative_id, plant_out_grace_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [customer_id, name, address, distance_from_plant_km, trip_allowance_category_id, latitude || null, longitude || null, geofence_radius_m || null, assigned_sales_representative_id, plant_out_grace_minutes || null]
  );
  res.status(201).json(rows[0]);
});

// Round 121, item 6 — geofence_radius_m gained a UI (below); previously it
// only ever existed in the schema with its SQL-level default (150), with no
// way to actually set it per site.
router.patch("/sites/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { name, address, distance_from_plant_km, trip_allowance_category_id, latitude, longitude, geofence_radius_m, plant_out_grace_minutes } = req.body;
  if (!name) return res.status(400).json({ error: "Site name is required." });
  const { rows } = await query(
    `UPDATE sites SET name = $1, address = $2, distance_from_plant_km = $3, trip_allowance_category_id = $4,
       latitude = $5, longitude = $6, geofence_radius_m = $7, plant_out_grace_minutes = $8
     WHERE id = $9 RETURNING *`,
    [name, address || null, distance_from_plant_km || null, trip_allowance_category_id || null,
     latitude || null, longitude || null, geofence_radius_m || null, plant_out_grace_minutes || null, req.params.id]
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

// The real bug behind "rate matches one site, order used another" — an
// order whose site_id points to a site owned by a DIFFERENT customer than
// the order itself. This was possible before order creation's site dropdown
// was filtered by customer; existing broken orders need to be found and
// fixed by hand, since which site was actually intended can't be inferred
// automatically.
router.get("/orders/site-customer-mismatches", requireRole("administrator", "manager"), async (req, res) => {
  const { rows } = await query(
    `SELECT co.id AS order_id, co.order_date, co.order_quantity_m3, co.status,
            oc.name AS order_customer_name, co.customer_id AS order_customer_id,
            s.id AS site_id, s.name AS site_name,
            sc.name AS site_actual_customer_name, s.customer_id AS site_actual_customer_id,
            (SELECT COUNT(*) FROM delivery_tickets WHERE order_id = co.id) AS ticket_count
     FROM customer_orders co
     JOIN customers oc ON oc.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN customers sc ON sc.id = s.customer_id
     WHERE co.customer_id != s.customer_id
     ORDER BY co.order_date DESC`
  );
  res.json(rows);
});

// Reassigns the order to a site that actually belongs to its own customer —
// the targeted, safe fix (only touches this one order, not the site record
// or any other order referencing it).
router.post("/orders/:id/fix-site-mismatch", requireRole("administrator", "manager"), async (req, res) => {
  const { correct_site_id } = req.body;
  if (!correct_site_id) return res.status(400).json({ error: "Select the correct site." });

  const { rows: orderRows } = await query("SELECT customer_id FROM customer_orders WHERE id = $1", [req.params.id]);
  if (!orderRows.length) return res.status(404).json({ error: "Order not found." });

  const { rows: siteRows } = await query("SELECT customer_id FROM sites WHERE id = $1", [correct_site_id]);
  if (!siteRows.length) return res.status(404).json({ error: "Site not found." });
  if (siteRows[0].customer_id !== orderRows[0].customer_id) {
    return res.status(400).json({ error: "That site doesn't belong to this order's customer either." });
  }

  await query("UPDATE customer_orders SET site_id = $1 WHERE id = $2", [correct_site_id, req.params.id]);
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

// Exactly one station is ever the plant — marking a new one unmarks any
// previous one, rather than requiring the admin to remember to do that
// themselves.
router.post("/fuel-stations/:id/set-plant", requireRole("administrator"), async (req, res) => {
  await query("UPDATE fuel_stations SET is_plant = FALSE WHERE is_plant = TRUE");
  await query("UPDATE fuel_stations SET is_plant = TRUE WHERE id = $1", [req.params.id]);
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

// ===== Plant location — the geofence anchor used to auto-detect Plant Out /
// Plant In (see lib/scheduledChecks.js's checkGeofenceEvents). Exactly one
// active plant at a time, same "set-active unmarks any previous one" pattern
// already used for fuel_stations.is_plant just above. =====

router.get("/plant-locations", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM plant_locations ORDER BY is_active DESC, name");
  res.json(rows);
});

router.post("/plant-locations", requireRole("administrator"), async (req, res) => {
  const { name, latitude, longitude, geofence_radius_m } = req.body;
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) {
    return res.status(400).json({ error: "Latitude and longitude are required." });
  }
  const { rows } = await query(
    `INSERT INTO plant_locations (name, latitude, longitude, geofence_radius_m)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [name || "Main plant", latitude, longitude, geofence_radius_m || 200]
  );
  res.status(201).json(rows[0]);
});

router.patch("/plant-locations/:id", requireRole("administrator"), async (req, res) => {
  const { name, latitude, longitude, geofence_radius_m } = req.body;
  const { rows } = await query(
    `UPDATE plant_locations SET
       name = COALESCE($1, name), latitude = COALESCE($2, latitude),
       longitude = COALESCE($3, longitude), geofence_radius_m = COALESCE($4, geofence_radius_m)
     WHERE id = $5 RETURNING *`,
    [name || null, latitude ?? null, longitude ?? null, geofence_radius_m || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Plant location not found." });
  res.json(rows[0]);
});

router.post("/plant-locations/:id/set-active", requireRole("administrator"), async (req, res) => {
  await query("UPDATE plant_locations SET is_active = FALSE WHERE is_active = TRUE");
  await query("UPDATE plant_locations SET is_active = TRUE WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

router.delete("/plant-locations/:id", requireRole("administrator"), async (req, res) => {
  await query("DELETE FROM plant_locations WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ===== Master data: Lubricant types =====

router.get("/lubricant-types", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM lubricant_types ORDER BY name");
  res.json(rows);
});

router.post("/lubricant-types", requireRole("administrator"), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Lubricant name is required." });
  const { rows } = await query("INSERT INTO lubricant_types (name) VALUES ($1) RETURNING *", [name]);
  res.status(201).json(rows[0]);
});

router.patch("/lubricant-types/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE lubricant_types SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
});

// ===== Master data: Visit outcome reasons (why a visit-generated
// opportunity didn't convert — "Lost to competitor", "Project cancelled",
// etc.) — same admin-manageable-list pattern as lubricant types, so this
// stays a controlled vocabulary usable for reporting, not free text. =====

router.get("/visit-outcome-reasons", requireRole("administrator"), async (req, res) => {
  const { rows } = await query("SELECT * FROM visit_outcome_reasons ORDER BY outcome_type, reason");
  res.json(rows);
});

router.post("/visit-outcome-reasons", requireRole("administrator"), async (req, res) => {
  const { outcome_type, reason } = req.body;
  if (!["lost", "closed"].includes(outcome_type)) {
    return res.status(400).json({ error: "Outcome type must be lost or closed." });
  }
  if (!reason) return res.status(400).json({ error: "Reason text is required." });
  const { rows } = await query(
    "INSERT INTO visit_outcome_reasons (outcome_type, reason) VALUES ($1,$2) RETURNING *",
    [outcome_type, reason]
  );
  res.status(201).json(rows[0]);
});

router.patch("/visit-outcome-reasons/:id/status", requireRole("administrator"), async (req, res) => {
  const { is_active } = req.body;
  await query("UPDATE visit_outcome_reasons SET is_active = $1 WHERE id = $2", [is_active, req.params.id]);
  res.json({ ok: true });
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
    `SELECT o.id, o.order_date, o.order_quantity_m3, o.status, o.scheduled_batching_time, o.required_at_site_time,
            o.mix_grade_id, o.pump_requirement, o.pump_id, p.pump_code,
            o.assigned_qc_engineer_id, qc.name AS qc_engineer_name,
            c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name,
            EXISTS (SELECT 1 FROM delivery_tickets dt WHERE dt.order_id = o.id) AS has_tickets
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN sites s ON s.id = o.site_id
     JOIN mix_grades m ON m.id = o.mix_grade_id
     LEFT JOIN pumps p ON p.id = o.pump_id
     LEFT JOIN users qc ON qc.id = o.assigned_qc_engineer_id
     ORDER BY o.order_date DESC, o.id DESC
     LIMIT 100`
  );
  res.json(rows);
});

router.patch("/orders/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { order_quantity_m3, scheduled_batching_time, required_at_site_time, remarks, mix_grade_id, pump_requirement, pump_id, assigned_qc_engineer_id } = req.body;

  // Unlike grade, the pump is deliberately editable at any time — even after
  // a delivery ticket (DN) exists — because the pump actually used can
  // change mid-pour for operational reasons (breakdown, site access, etc.).
  // This only corrects the order's own record; it does not rewrite pump_id
  // on tickets already printed.
  if (pump_requirement === "without_pump") {
    // no pump involved — pump_id is cleared below via the explicit null branch
  } else if (pump_requirement !== undefined && !pump_id) {
    return res.status(400).json({ error: "Select which pump is assigned to this order." });
  }

  // Grade can only be corrected before any delivery ticket (DN) has been
  // raised against the order — once a DN exists it references the original
  // grade (invoices, QC records, and the printed challan all key off it), so
  // changing the grade after the fact would silently desync those records.
  // Only checked when the request actually asks to change the grade (the
  // panel always includes the current mix_grade_id in a quantity-only save,
  // so a same-value submit must never trip this).
  if (mix_grade_id !== undefined && mix_grade_id !== null && mix_grade_id !== "") {
    const { rows: current } = await query("SELECT mix_grade_id FROM customer_orders WHERE id = $1", [req.params.id]);
    if (current.length && String(current[0].mix_grade_id) !== String(mix_grade_id)) {
      const { rows: ticketCheck } = await query(
        "SELECT 1 FROM delivery_tickets WHERE order_id = $1 LIMIT 1",
        [req.params.id]
      );
      if (ticketCheck.length) {
        return res.status(400).json({ error: "Grade can't be changed — a delivery ticket has already been created against this order." });
      }
    }
  }

  const { rows } = await query(
    `UPDATE customer_orders SET
       order_quantity_m3 = COALESCE($1, order_quantity_m3),
       scheduled_batching_time = COALESCE($2, scheduled_batching_time),
       remarks = COALESCE($3, remarks),
       mix_grade_id = COALESCE($4, mix_grade_id),
       pump_requirement = COALESCE($5, pump_requirement),
       pump_id = CASE WHEN $5::text IS NULL THEN pump_id WHEN $5 = 'without_pump' THEN NULL ELSE $6 END,
       assigned_qc_engineer_id = $8,
       required_at_site_time = COALESCE($9, required_at_site_time)
     WHERE id = $7 RETURNING *`,
    [order_quantity_m3, scheduled_batching_time, remarks, mix_grade_id || null, pump_requirement || null, pump_id || null, req.params.id, assigned_qc_engineer_id || null, required_at_site_time || null]
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
  await query("UPDATE customer_orders SET status = 'cancelled', terminal_at = now() WHERE id = $1", [req.params.id]);
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

// Delivery Challan (Gate Pass & Delivery Note) — printed A4 document handed to
// the driver before the truck leaves the plant. Admin-only for now (per
// business decision — other roles may get access later). Returns every field
// the frontend PDF generator (deliveryChallanPdf.js) needs; the PDF itself is
// built client-side so there's nothing to store or regenerate server-side.
router.get("/tickets/:id/challan", requireRole("administrator"), async (req, res) => {
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
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Ticket not found." });
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

  res.json({
    ...ticket,
    delivered_prior_m3: deliveredPrior,
    balance_m3: Math.max(0, ordered - deliveredPrior - thisLoad),
  });
});

router.patch("/tickets/:id", requireRole("administrator", "manager"), async (req, res) => {
  const { loaded_quantity_m3 } = req.body;

  const { rows: before } = await query("SELECT loaded_quantity_m3 FROM delivery_tickets WHERE id = $1", [req.params.id]);
  if (!before.length) return res.status(404).json({ error: "Ticket not found." });
  const oldQty = Number(before[0].loaded_quantity_m3);

  const { rows } = await query(
    `UPDATE delivery_tickets SET loaded_quantity_m3 = COALESCE($1, loaded_quantity_m3) WHERE id = $2 RETURNING *`,
    [loaded_quantity_m3, req.params.id]
  );

  if (loaded_quantity_m3 && Number(loaded_quantity_m3) !== oldQty && oldQty > 0) {
    const { rows: invRows } = await query(
      `SELECT i.id, i.concrete_amount, i.pumping_charge, i.part_load_charge,
              COALESCE((SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id), 0) AS payment_count
       FROM invoices i WHERE i.ticket_id = $1`,
      [req.params.id]
    );
    const inv = invRows[0];
    // Skipped automatically (not an error) if there's no invoice yet, or a
    // payment has already been recorded against it — same safety rule used
    // everywhere else money is involved.
    if (inv && Number(inv.payment_count) === 0) {
      const ratePerM3 = Number(inv.concrete_amount) / oldQty;
      const newConcreteAmount = ratePerM3 * Number(loaded_quantity_m3);
      const newTotal = newConcreteAmount + Number(inv.pumping_charge) + Number(inv.part_load_charge);
      await query(
        "UPDATE invoices SET concrete_amount = $1, total_amount = $2 WHERE id = $3",
        [newConcreteAmount, newTotal, inv.id]
      );
    }
  }

  res.json(rows[0]);
});

router.post("/tickets/:id/cancel", requireRole("administrator", "manager"), async (req, res) => {
  await query("UPDATE delivery_tickets SET status = 'cancelled' WHERE id = $1", [req.params.id]);
  await voidInvoiceForTicket(req.params.id, "cancelled");
  res.json({ ok: true });
});

// ===== Site Contacts directory (round 96, item 7) =====
// Full management screen — Administrator only, per the business's answer
// ("admin should be able to edit if required, and manager will modify when
// creating also" — that day-to-day edit-while-creating path is
// /master/site-contacts, used from Create Order; this is the dedicated
// browse/correct-mistakes screen).
router.get("/site-contacts", requireRole("administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT sc.id, sc.contact_name, sc.phone_number, sc.role_label, sc.is_active, sc.created_at,
            c.name AS customer_name, s.name AS site_name
     FROM site_contacts sc
     JOIN customers c ON c.id = sc.customer_id
     JOIN sites s ON s.id = sc.site_id
     ORDER BY c.name, s.name, sc.contact_name`
  );
  res.json(rows);
});

// ===== Monthly production target (round 96, item 8) =====
// One row per calendar month, so past months keep their own historical
// target rather than a single value silently drifting. Manager dashboard
// reads the resulting KPI via GET /orders/dashboard (see orders.js).
router.get("/production-targets", requireRole("administrator", "manager"), async (req, res) => {
  const { rows } = await query(
    `SELECT id, year, month, target_m3, updated_at FROM monthly_production_targets
     ORDER BY year DESC, month DESC LIMIT 24`
  );
  res.json(rows);
});

router.post("/production-targets", requireRole("administrator"), async (req, res) => {
  const { year, month, target_m3 } = req.body;
  if (!year || !month || !target_m3) {
    return res.status(400).json({ error: "Year, month, and target quantity are required." });
  }
  const { rows } = await query(
    `INSERT INTO monthly_production_targets (year, month, target_m3, set_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (year, month) DO UPDATE SET target_m3 = $3, set_by = $4, updated_at = now()
     RETURNING *`,
    [year, month, target_m3, req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.patch("/site-contacts/:id", requireRole("administrator"), async (req, res) => {
  const { contact_name, phone_number, role_label, is_active } = req.body;
  const { rows } = await query(
    `UPDATE site_contacts SET
       contact_name = COALESCE($1, contact_name),
       phone_number = COALESCE($2, phone_number),
       role_label = COALESCE($3, role_label),
       is_active = COALESCE($4, is_active)
     WHERE id = $5 RETURNING *`,
    [contact_name || null, phone_number || null, role_label || null, is_active, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Contact not found." });
  res.json(rows[0]);
});

// Maintenance action points (round 98, item 10) moved to
// routes/maintenance.js in round 101 — the business asked for this master
// data to be Manager's, not Administrator's, to manage. See that file for
// GET/POST/PATCH /api/maintenance/action-points.

// ===== Approved mix assignments (round 118) =====
// Which specific mix design a customer's order for a given grade actually
// resolves to — see mix_design_assignments in schema.sql. One design (e.g.
// "025-B") is routinely shared across several customer rows; this list is
// customer-centric (one row per customer+grade override), not design-centric.
router.get("/mix-design-assignments", requireRole("administrator", "manager"), async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.customer_id, c.name AS customer_name, a.mix_grade_id, m.name AS mix_grade_name,
            a.mix_design_id, md.design_ref_code, a.assigned_at,
            (SELECT COUNT(*) FROM mix_design_assignments a2 WHERE a2.mix_design_id = a.mix_design_id) AS design_shared_count
     FROM mix_design_assignments a
     JOIN customers c ON c.id = a.customer_id
     JOIN mix_grades m ON m.id = a.mix_grade_id
     JOIN mix_designs md ON md.id = a.mix_design_id
     ORDER BY c.name, m.name`
  );
  res.json(rows);
});

// Upsert on (customer_id, mix_grade_id) — assigning again for the same
// customer+grade updates the existing link rather than creating a second one.
router.post("/mix-design-assignments", requireRole("administrator", "manager"), async (req, res) => {
  const { customer_id, mix_grade_id, mix_design_id } = req.body;
  if (!customer_id || !mix_grade_id || !mix_design_id) {
    return res.status(400).json({ error: "Customer, grade, and mix design are all required." });
  }
  const { rows: designCheck } = await query(
    "SELECT id, mix_grade_id, status FROM mix_designs WHERE id = $1", [mix_design_id]
  );
  if (!designCheck.length || designCheck[0].status !== "approved") {
    return res.status(400).json({ error: "Only an approved mix design can be assigned." });
  }
  if (Number(designCheck[0].mix_grade_id) !== Number(mix_grade_id)) {
    return res.status(400).json({ error: "That mix design is for a different grade." });
  }
  const { rows } = await query(
    `INSERT INTO mix_design_assignments (customer_id, mix_grade_id, mix_design_id, assigned_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (customer_id, mix_grade_id) DO UPDATE SET
       mix_design_id = $3, updated_by = $4, updated_at = now()
     RETURNING id`,
    [customer_id, mix_grade_id, mix_design_id, req.user.id]
  );
  res.status(201).json({ id: rows[0].id });
});

router.delete("/mix-design-assignments/:id", requireRole("administrator", "manager"), async (req, res) => {
  await query("DELETE FROM mix_design_assignments WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// Sets (or clears) a mix design as the default/"standard" design for its
// grade — used whenever a customer+grade has no specific assignment. Only
// one design per grade can hold this at a time (enforced by a partial unique
// index too); setting a new one here first clears whichever design already
// held it for that grade.
router.patch("/mix-designs/:id/standard", requireRole("administrator", "manager"), async (req, res) => {
  const { is_standard } = req.body;
  const { rows } = await query("SELECT id, mix_grade_id, status FROM mix_designs WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Mix design not found." });
  if (is_standard && rows[0].status !== "approved") {
    return res.status(400).json({ error: "Only an approved mix design can be made the standard for its grade." });
  }
  if (is_standard) {
    await query(
      "UPDATE mix_designs SET is_standard_for_grade = false WHERE mix_grade_id = $1 AND id != $2",
      [rows[0].mix_grade_id, req.params.id]
    );
  }
  await query("UPDATE mix_designs SET is_standard_for_grade = $1 WHERE id = $2", [!!is_standard, req.params.id]);
  res.json({ ok: true });
});

export default router;
