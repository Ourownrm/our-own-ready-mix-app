import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { pool, query } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const ALL_MIX_GRADES = ["M7.5", "M10", "M15", "M20", "M25", "M30", "M35", "M40", "M45", "M50"];

// One-time setup, triggered by visiting this URL with the correct key in a browser.
// Safe to run more than once — it skips anything already created, and applies any
// new migrations needed for databases created by an earlier version of this app.
router.get("/setup", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }

  const log = [];
  try {
    const { rows } = await query(`SELECT to_regclass('public.users') AS exists`);
    if (!rows[0].exists) {
      const schemaPath = path.join(__dirname, "..", "..", "schema.sql");
      const schemaSql = fs.readFileSync(schemaPath, "utf8");
      await pool.query(schemaSql);
      log.push("Database tables created.");
    } else {
      log.push("Database tables already exist — skipped.");
    }

    // ===== Migrations for databases created by earlier versions of this app =====
    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_id INTEGER REFERENCES pumps(id);
      ALTER TABLE site_qc ADD COLUMN IF NOT EXISTS after_pour_care_confirmed BOOLEAN DEFAULT false;
      ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS pumping_charge_lumpsum NUMERIC(10,2) DEFAULT 0;
    `);
    log.push("Schema migrations applied (specific pump selection, after-pour care checklist, lump-sum pumping charge).");

    // Order closing (Manager "close/never-complete" action) — orders now carry
    // forward automatically until completed or formally closed here.
    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS closure_reason TEXT;
    `);
    log.push("Schema migration applied (order closing / carry-forward).");

    // Breakdown reporting extended from trucks-only to trucks + pumps + the batching plant.
    await pool.query(`DO $$ BEGIN
      CREATE TYPE breakdown_equipment_type AS ENUM ('truck', 'pump', 'plant');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS equipment_type breakdown_equipment_type NOT NULL DEFAULT 'truck';
      ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS pump_id INTEGER REFERENCES pumps(id);
      ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS equipment_label VARCHAR(100);
      ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS reported_by INTEGER REFERENCES users(id);
      ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS repaired_by INTEGER REFERENCES users(id);
      ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS repaired_at TIMESTAMPTZ;
      ALTER TABLE breakdown_reports ALTER COLUMN truck_id DROP NOT NULL;
      ALTER TABLE breakdown_reports ALTER COLUMN driver_id DROP NOT NULL;
      UPDATE breakdown_reports SET reported_by = driver_id WHERE reported_by IS NULL;
    `);
    log.push("Schema migration applied (breakdown reporting now covers pumps and the batching plant, not just trucks).");

    // Salesman is now a controlled dropdown list instead of free text, so a
    // typo can't silently split one salesman's numbers across two names.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS salespersons (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL UNIQUE,
        is_active BOOLEAN DEFAULT TRUE
      );
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS sales_representative_id INTEGER REFERENCES salespersons(id);
    `);
    // Carry forward any distinct names already typed into the old free-text
    // field, so existing orders aren't silently orphaned from the new dropdown.
    await pool.query(`
      INSERT INTO salespersons (name)
      SELECT DISTINCT trim(sales_representative) FROM customer_orders
      WHERE sales_representative IS NOT NULL AND trim(sales_representative) != ''
      ON CONFLICT (name) DO NOTHING;
      UPDATE customer_orders co SET sales_representative_id = sp.id
      FROM salespersons sp
      WHERE co.sales_representative_id IS NULL AND trim(co.sales_representative) = sp.name;
    `);
    log.push("Schema migration applied (salesman is now a dropdown list — any names already on file were carried over as options).");

    // Driver duty ON/OFF, tracked per-driver instead of per-ticket, so a driver
    // can be on duty and trackable with no truck/order assigned yet (small
    // sites, or waiting at plant before the first ticket of the day).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS driver_duty_log (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER REFERENCES users(id) NOT NULL,
        is_on BOOLEAN NOT NULL,
        event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7)
      );
    `);
    log.push("Schema migration applied (driver duty ON/OFF now tracked independent of any truck or ticket).");

    // Raw material stock — fixed set of bins, QC-editable type/brand and quantity.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raw_material_stock (
        id SERIAL PRIMARY KEY,
        bin_name VARCHAR(50) NOT NULL UNIQUE,
        unit VARCHAR(20) NOT NULL,
        type_brand VARCHAR(100),
        stock_qty NUMERIC(10,2) NOT NULL DEFAULT 0,
        updated_by INTEGER REFERENCES users(id),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`
      INSERT INTO raw_material_stock (bin_name, unit) VALUES
        ('Silo 1', 'ton'), ('Silo 2', 'ton'), ('Silo 3', 'ton'),
        ('Admix. 1', 'Barrel'), ('Admix. 2', 'Barrel'), ('Admix. 3', 'Barrel'),
        ('M Sand', 'Load'), ('Agg. 12 mm', 'Load'), ('Agg. 20 mm', 'Load')
      ON CONFLICT (bin_name) DO NOTHING;
    `);
    log.push("Schema migration applied (raw material stock — 9 bins seeded, ready for QC Engineer to fill in).");

    const { rows: existingAdmin } = await query("SELECT id FROM users WHERE phone = '9999999999'");
    if (existingAdmin.length === 0) {
      const passwordHash = await bcrypt.hash("ChangeMe123!", 10);
      await query(
        `INSERT INTO users (name, phone, email, password_hash, role)
         VALUES ('Admin', '9999999999', 'admin@example.com', $1, 'administrator')`,
        [passwordHash]
      );
      log.push("First Administrator login created: phone 9999999999, password ChangeMe123!");
    } else {
      log.push("Administrator login already exists — skipped.");
    }

    await query(
      `INSERT INTO trip_allowance_categories (label, amount, min_distance_km, max_distance_km)
       SELECT * FROM (VALUES
         ('₹100 per trip', 100::numeric, 0::numeric, 10::numeric),
         ('₹150 per trip', 150::numeric, 10::numeric, 20::numeric),
         ('₹200 per trip', 200::numeric, 20::numeric, NULL::numeric)
       ) AS v(label, amount, min_distance_km, max_distance_km)
       WHERE NOT EXISTS (SELECT 1 FROM trip_allowance_categories)`
    );
    // Existing installs may already have labels seeded with the distance range
    // baked in (e.g. "₹100 per trip (0-10 km)") — clean those up too.
    await query(
      `UPDATE trip_allowance_categories SET label = regexp_replace(label, '\\s*\\([^)]*\\)\\s*$', '')
       WHERE label ~ '\\([^)]*\\)\\s*$'`
    );

    // Mix grades: insert each grade individually so adding new grades later
    // doesn't get skipped just because some grades already exist.
    for (const g of ALL_MIX_GRADES) {
      await query(
        `INSERT INTO mix_grades (name) SELECT $1::varchar WHERE NOT EXISTS (SELECT 1 FROM mix_grades WHERE name = $1::varchar)`,
        [g]
      );
    }
    log.push(`Mix grades ensured: ${ALL_MIX_GRADES.join(", ")}.`);

    await query(
      `INSERT INTO rejection_reasons (reason)
       SELECT * FROM (VALUES
         ('Slump out of range'), ('Segregation'),
         ('Delayed delivery / setting started'), ('Wrong grade supplied'), ('Other')
       ) AS v(reason)
       WHERE NOT EXISTS (SELECT 1 FROM rejection_reasons)`
    );
    log.push("Sample trip allowance categories and rejection reasons added.");

    await query(
      `INSERT INTO customers (name)
       SELECT * FROM (VALUES ('Skyline Builders'), ('Greenfield Infra')) AS v(name)
       WHERE NOT EXISTS (SELECT 1 FROM customers)`
    );
    const { rows: custForSite } = await query("SELECT id FROM customers ORDER BY id LIMIT 1");
    const { rows: catForSite } = await query("SELECT id FROM trip_allowance_categories WHERE amount = 150 LIMIT 1");
    if (custForSite.length && catForSite.length) {
      await query(
        `INSERT INTO sites (customer_id, name, distance_from_plant_km, trip_allowance_category_id)
         SELECT $1, 'Sector 12, Site A', 14, $2
         WHERE NOT EXISTS (SELECT 1 FROM sites)`,
        [custForSite[0].id, catForSite[0].id]
      );
    }
    log.push("Sample customer and site added.");

    // Sample pumps, so the order form's pump dropdown has something to pick from
    await query(
      `INSERT INTO pumps (pump_code, pump_type)
       SELECT * FROM (VALUES ('Boom-1', 'boom_pump'::pump_type), ('Line-1', 'line_pump'::pump_type), ('Line-2', 'line_pump'::pump_type)) AS v(pump_code, pump_type)
       WHERE NOT EXISTS (SELECT 1 FROM pumps WHERE pumps.pump_code = v.pump_code)`
    );
    log.push("Sample pumps added (Boom-1, Line-1, Line-2).");

    const { rows: allCustomers } = await query("SELECT id FROM customers");
    const { rows: gradeRows } = await query("SELECT id FROM mix_grades WHERE name = 'M25' LIMIT 1");
    if (allCustomers.length && gradeRows.length) {
      for (const c of allCustomers) {
        await query(
          `INSERT INTO rate_master (customer_id, mix_grade_id, rate_per_m3, pumping_charge_lumpsum, waiting_charge_per_hour, effective_from)
           SELECT $1, $2, 4500, 1500, 500, CURRENT_DATE
           WHERE NOT EXISTS (SELECT 1 FROM rate_master WHERE customer_id = $1 AND mix_grade_id = $2)`,
          [c.id, gradeRows[0].id]
        );
      }
      log.push("Sample M25 rate added for all existing customers (pumping charge now a lump sum, not per m³).");
    }

    res.send(
      `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
      `Setup complete.\n\n${log.join("\n")}\n\n` +
      `You can now sign in to the app with:\nPhone: 9999999999\nPassword: ChangeMe123!\n\n` +
      `Please change this password once you're able to.` +
      `</pre>`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(
      `<pre style="font-family: sans-serif; padding: 20px; color: #c0392b;">Something went wrong:\n${err.message}</pre>`
    );
  }
});

// Clears every transactional/operational record — orders, delivery tickets and
// their full event/GPS/QC history, breakdown and fuel logs, invoices, payments,
// and notifications — so the app can start fresh with real data.
//
// Deliberately KEPT (not touched): users, trucks, pumps, customers, sites,
// mix grades, salespersons, rate master, trip allowance categories, rejection
// reasons, fuel stations, and role permissions — none of that is "test data",
// it's your configuration.
//
// Protected the same way as /setup: needs the SETUP_SECRET, plus an explicit
// confirm=RESET so a stray visit to the URL can't trigger it by accident.
router.get("/setup/reset-transactional-data", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  if (req.query.confirm !== "RESET") {
    return res.status(400).send(
      `<pre style="font-family: sans-serif; padding: 20px;">` +
      `This permanently deletes every order, delivery ticket, invoice, payment, and log —\n` +
      `keeping only users, equipment (trucks/pumps), customers, and sites.\n\n` +
      `This cannot be undone. To proceed, add &confirm=RESET to this URL.</pre>`
    );
  }

  try {
    await pool.query(`
      TRUNCATE TABLE
        audit_log, notifications, trip_allowance_payouts, payments, invoices,
        breakdown_reports, fuel_logs, pump_logs, site_qc, plant_qc, gps_pings,
        driver_duty_log, trip_events, delivery_tickets, customer_orders
      RESTART IDENTITY CASCADE;
    `);
    res.send(
      `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
      `Done. All orders, delivery tickets, logs, invoices, and payments have been cleared.\n\n` +
      `Kept as-is: users, trucks, pumps, customers, sites, mix grades, salespersons,\n` +
      `rate master, trip allowance categories, rejection reasons.\n\n` +
      `You're starting fresh on transactional data.</pre>`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(
      `<pre style="font-family: sans-serif; padding: 20px; color: #c0392b;">Something went wrong:\n${err.message}</pre>`
    );
  }
});

export default router;
