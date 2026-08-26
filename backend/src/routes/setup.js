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

      // Seed/sample data — genuinely only for a brand new install. This used
      // to run unconditionally on every /setup call (a real bug — see the
      // note further below where it used to live), which is why it's
      // deliberately placed here instead, inside the fresh-install-only
      // branch.
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

      await query(
        `INSERT INTO pumps (pump_code, pump_type)
         SELECT * FROM (VALUES ('Boom-1', 'boom_pump'::pump_type), ('Line-1', 'line_pump'::pump_type), ('Line-2', 'line_pump'::pump_type)) AS v(pump_code, pump_type)
         WHERE NOT EXISTS (SELECT 1 FROM pumps WHERE pumps.pump_code = v.pump_code)`
      );
      log.push("Sample pumps added (Boom-1, Line-1, Line-2).");

      const { rows: allCustomers } = await query("SELECT id FROM customers");
      const { rows: gradeRows } = await query("SELECT id FROM mix_grades WHERE name = 'M25' LIMIT 1");
      const { rows: siteForRate } = await query("SELECT id, customer_id FROM sites ORDER BY id LIMIT 1");
      if (allCustomers.length && gradeRows.length && siteForRate.length) {
        await query(
          `INSERT INTO rate_master (customer_id, site_id, mix_grade_id, rate_per_m3, pumping_charge_lumpsum, waiting_charge_per_hour, effective_from)
           SELECT $1, $2, $3, 4500, 1500, 500, CURRENT_DATE
           WHERE NOT EXISTS (SELECT 1 FROM rate_master WHERE customer_id = $1 AND mix_grade_id = $3)`,
          [siteForRate[0].customer_id, siteForRate[0].id, gradeRows[0].id]
        );
        log.push("Sample M25 rate added for the sample site.");
      }
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

    // "Closed" is now its own status, separate from "cancelled" — previously
    // both wrote the same value, so a Manager-closed order and an
    // Administrator-cancelled order were indistinguishable in the UI.
    await pool.query(`DO $$ BEGIN
      ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'closed';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    // Backfill: any order that already has a closed_at/closed_by on file was
    // closed via the Manager's "close order" action, not truly cancelled.
    await pool.query(`
      UPDATE customer_orders SET status = 'closed'
      WHERE status = 'cancelled' AND closed_at IS NOT NULL;
    `);
    log.push("Schema migration applied ('closed' is now a distinct order status from 'cancelled' — existing closed orders were corrected).");

    // Web Push subscriptions, for real push notifications (not just the
    // in-app notifications table, which nothing was ever reading from).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    log.push("Schema migration applied (push notification subscriptions table added).");

    // Fuel module redesign: any equipment (not just trucks), odometer or hour
    // meter, filling stations become manageable, new lightweight equipment
    // list for pickup vans/loaders/generators.
    await pool.query(`DO $$ BEGIN
      CREATE TYPE fuel_equipment_type AS ENUM ('truck', 'pump', 'pickup_van', 'loader', 'generator');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment (
        id SERIAL PRIMARY KEY,
        equipment_type fuel_equipment_type NOT NULL,
        name VARCHAR(100) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      );
      ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS equipment_type fuel_equipment_type NOT NULL DEFAULT 'truck';
      ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS pump_id INTEGER REFERENCES pumps(id);
      ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS equipment_id INTEGER REFERENCES equipment(id);
      ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS hour_meter_reading NUMERIC(10,2);
      ALTER TABLE fuel_logs ALTER COLUMN truck_id DROP NOT NULL;
    `);
    log.push("Schema migration applied (fuel filling now covers any equipment — trucks, pumps, pickup vans, loaders, generators — with odometer or hour meter).");

    // Sales module: new role, leads, bookings, after-sales feedback.
    await pool.query(`DO $$ BEGIN
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'sales_executive';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      ALTER TABLE salespersons ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
    `);
    await pool.query(`DO $$ BEGIN
      CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'quoted', 'won', 'lost');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`DO $$ BEGIN
      CREATE TYPE lead_attribution AS ENUM ('salesperson', 'company');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        prospect_name VARCHAR(150) NOT NULL,
        contact_person VARCHAR(150),
        contact_phone VARCHAR(20),
        site_location TEXT,
        mix_grade_interest VARCHAR(50),
        estimated_qty_m3 NUMERIC(8,2),
        assigned_to INTEGER REFERENCES users(id),
        created_by INTEGER REFERENCES users(id),
        status lead_status DEFAULT 'new',
        attribution lead_attribution,
        won_customer_id INTEGER REFERENCES customers(id),
        won_order_id INTEGER REFERENCES customer_orders(id),
        lost_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS lead_followups (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) NOT NULL,
        note TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`DO $$ BEGIN
      CREATE TYPE booking_status AS ENUM ('pending', 'converted', 'declined');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        site_id INTEGER REFERENCES sites(id),
        mix_grade_id INTEGER REFERENCES mix_grades(id),
        estimated_qty_m3 NUMERIC(8,2),
        preferred_date DATE,
        notes TEXT,
        requested_by INTEGER REFERENCES users(id) NOT NULL,
        status booking_status DEFAULT 'pending',
        converted_order_id INTEGER REFERENCES customer_orders(id),
        declined_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`DO $$ BEGIN
      CREATE TYPE feedback_type AS ENUM ('compliment', 'complaint');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aftersales_feedback (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        order_id INTEGER REFERENCES customer_orders(id),
        feedback_type feedback_type NOT NULL,
        comment TEXT NOT NULL,
        recorded_by INTEGER REFERENCES users(id) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    log.push("Schema migration applied (sales module — sales_executive role, leads, bookings, after-sales feedback).");

    // Richer lead activity tracking: quotation issue/follow-up/revision,
    // meetings, site visits — each optionally geotagged when the salesperson
    // confirms they're actually at site — plus quick quotation-status fields
    // on the lead itself for fast list display.
    await pool.query(`
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS quotation_issued BOOLEAN DEFAULT false;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS latest_quotation_amount NUMERIC(10,2);
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS activity_type VARCHAR(30) NOT NULL DEFAULT 'note';
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS quotation_amount NUMERIC(10,2);
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS revision_reason TEXT;
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS persons_met TEXT;
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS at_site BOOLEAN;
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);
    `);
    log.push("Schema migration applied (lead activity log now covers quotations, meetings, site visits, and location — Sales Executives can also self-add leads).");

    // Customer visit reporting — separate from lead activity, since this is
    // for existing customers rather than prospects.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_visits (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        visited_by INTEGER REFERENCES users(id) NOT NULL,
        visit_date DATE NOT NULL,
        visit_time TIME,
        contact_person VARCHAR(150),
        discussion_outcome TEXT NOT NULL,
        at_site BOOLEAN,
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    log.push("Schema migration applied (customer visit reporting for Sales Executives).");

    // Location capture on the lead itself (when a Sales Executive adds it),
    // and visits can now be to anyone — client, consultant, site engineer —
    // not just an existing customer.
    await pool.query(`
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS at_site BOOLEAN;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);
      ALTER TABLE customer_visits ALTER COLUMN customer_id DROP NOT NULL;
      ALTER TABLE customer_visits ADD COLUMN IF NOT EXISTS visited_name VARCHAR(150);
      ALTER TABLE customer_visits ADD COLUMN IF NOT EXISTS visitor_type VARCHAR(30) NOT NULL DEFAULT 'customer';
    `);
    // Backfill visited_name for any visits already logged under the old
    // customer-only design, so nothing existing loses its "who" on display.
    await pool.query(`
      UPDATE customer_visits cv SET visited_name = c.name
      FROM customers c WHERE cv.customer_id = c.id AND cv.visited_name IS NULL;
    `);
    log.push("Schema migration applied (leads capture location on creation; visits can be to anyone, not just existing customers).");

    // Lead site location — the project site/customer office's own GPS
    // coordinates, attached when a lead is assigned, so the salesperson can
    // navigate straight there. Distinct from the at_site/latitude/longitude
    // columns above, which record where the SALESPERSON was standing when
    // they logged an update.
    await pool.query(`
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS site_latitude NUMERIC(10,7);
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS site_longitude NUMERIC(10,7);
    `);
    log.push("Schema migration applied (leads can now carry the project site's own location, for direct navigation).");

    // Pump dispatch tracking and site-readiness gate before batching.
    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_actual_departure_time TIMESTAMPTZ;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_departure_confirmed_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_confirmed BOOLEAN DEFAULT false;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_confirmed_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_confirmed_at TIMESTAMPTZ;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES customer_orders(id);
    `);
    log.push("Schema migration applied (pump departure confirmation and site-readiness gate before batching).");

    // Statutory Compliance Monitoring — Manager-only.
    await pool.query(`DO $$ BEGIN
      CREATE TYPE compliance_asset_type AS ENUM (
        'transit_mixer', 'boom_pump', 'batching_plant', 'loader', 'generator',
        'weighbridge', 'compressor', 'pickup', 'car', 'motor_bike', 'other'
      );
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`DO $$ BEGIN
      CREATE TYPE compliance_category AS ENUM ('vehicle', 'equipment');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compliance_assets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        asset_type compliance_asset_type NOT NULL,
        category compliance_category NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS compliance_documents (
        id SERIAL PRIMARY KEY,
        asset_id INTEGER REFERENCES compliance_assets(id) NOT NULL,
        document_type VARCHAR(50) NOT NULL,
        document_number VARCHAR(100),
        expiry_date DATE NOT NULL,
        updated_by INTEGER REFERENCES users(id),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (asset_id, document_type)
      );
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS compliance_document_id INTEGER REFERENCES compliance_documents(id);
    `);
    log.push("Schema migration applied (Statutory Compliance Monitoring — assets, documents, expiry alerts).");

    // Delay reasons for pump departure / site readiness; separate the Site
    // Supervisor's "work completed" signal from the order's actual status
    // (fixes the confusion where it looked identical to real completion);
    // Manager's written response when clearing a QC-flagged delay.
    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_departure_delay_reason TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_delay_reason TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS supervisor_marked_complete BOOLEAN DEFAULT false;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS supervisor_marked_complete_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS supervisor_marked_complete_at TIMESTAMPTZ;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS after_pour_care_confirmed BOOLEAN;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS work_completion_remarks TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS original_order_date DATE;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS original_scheduled_batching_time TIME;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS reschedule_reason TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS rescheduled_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS manager_response TEXT;
    `);
    // Any order the old logic already marked 'completed' via the Site
    // Supervisor's button (rather than by reaching full delivered quantity)
    // can't be told apart retroactively — left as-is; this only changes
    // behavior for the button going forward.
    log.push("Schema migration applied (pump/site-ready delay reasons, supervisor-completion signal separated from order status, manager response on flagged-delay alerts).");

    // Pre-existing outstanding balances from before this app was in use, and
    // letting payments apply to those (not just invoices) so old debt can be
    // paid down through the same bulk-payment flow as everything else.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_opening_balances (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        as_of_date DATE NOT NULL,
        notes TEXT,
        entered_by INTEGER REFERENCES users(id),
        entered_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE payments ALTER COLUMN invoice_id DROP NOT NULL;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS opening_balance_id INTEGER REFERENCES customer_opening_balances(id);
    `);
    // Constraint added separately and guarded, since re-running /setup would
    // otherwise fail trying to add a constraint that already exists.
    await pool.query(`DO $$ BEGIN
      ALTER TABLE payments ADD CONSTRAINT payments_target_check CHECK (
        (invoice_id IS NOT NULL AND opening_balance_id IS NULL) OR
        (invoice_id IS NULL AND opening_balance_id IS NOT NULL)
      );
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    log.push("Schema migration applied (customer opening balances — pre-existing outstanding from before this app was in use).");

    // Raw material stock — track what's already on order, so low stock can be
    // told apart from "already ordered, arriving soon" vs genuinely at risk.
    await pool.query(`
      ALTER TABLE raw_material_stock ADD COLUMN IF NOT EXISTS qty_on_order NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE raw_material_stock ADD COLUMN IF NOT EXISTS expected_delivery_date DATE;
    `);
    log.push("Schema migration applied (raw material stock now tracks qty on order and expected delivery date).");

    // Booking GPS — captured at booking time, carried into the site record on
    // conversion so drivers can navigate correctly from day one.
    await pool.query(`
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS site_latitude NUMERIC(10,7);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS site_longitude NUMERIC(10,7);
    `);
    log.push("Schema migration applied (bookings can now carry a site GPS location through to conversion).");

    // Sales forecasting — rolling demand estimates for ongoing projects,
    // planning-only (never becomes an order on its own).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_forecasts (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES customer_orders(id) NOT NULL UNIQUE,
        sales_representative_id INTEGER REFERENCES salespersons(id) NOT NULL,
        expected_qty_m3 NUMERIC(10,2) NOT NULL,
        period_days INTEGER NOT NULL,
        confidence VARCHAR(20) NOT NULL,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    log.push("Schema migration applied (sales forecasting for running projects).");

    // Move sales-executive assignment from the order level to the site
    // level — a project/site persists across many orders over its lifetime,
    // and that's what Sales Forecast should actually track continuity
    // against, not a single order's one-off attribution.
    await pool.query(`
      ALTER TABLE sites ADD COLUMN IF NOT EXISTS assigned_sales_representative_id INTEGER REFERENCES salespersons(id);
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id);
      ALTER TABLE sales_forecasts ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id);
    `);
    // Backfill site_id on any forecast that was actually saved under the old
    // order-keyed design, then drop order_id (which takes its unique
    // constraint with it) and require site_id going forward. Guarded so this
    // is safe to run again even after order_id has already been dropped —
    // re-running /setup shouldn't ever break something that already succeeded.
    const { rows: orderIdCheck } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_forecasts' AND column_name = 'order_id'`
    );
    if (orderIdCheck.length > 0) {
      await pool.query(`
        UPDATE sales_forecasts f SET site_id = o.site_id
        FROM customer_orders o WHERE f.order_id = o.id AND f.site_id IS NULL;
      `);
      await pool.query(`DELETE FROM sales_forecasts WHERE site_id IS NULL;`);
      // If two old order-keyed forecasts happened to land on the same site,
      // keep only the most recently updated one before enforcing one-per-site.
      await pool.query(`
        DELETE FROM sales_forecasts a USING sales_forecasts b
        WHERE a.site_id = b.site_id AND a.id < b.id;
      `);
      await pool.query(`ALTER TABLE sales_forecasts DROP COLUMN order_id;`);
    }
    await pool.query(`ALTER TABLE sales_forecasts ALTER COLUMN site_id SET NOT NULL;`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_forecasts_site_id_uidx ON sales_forecasts(site_id);`);
    log.push("Schema migration applied (sales forecasting now keyed on site/project, not individual order — the actual fix for it showing no running projects).");

    // Plant Operator's ticket creation now has offline-queue protection like
    // Driver's and Site Supervisor's screens — this key is what makes a
    // queued/retried submission safe (resolves to the same ticket instead of
    // creating a duplicate).
    await pool.query(`ALTER TABLE delivery_tickets ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64) UNIQUE;`);
    log.push("Schema migration applied (delivery tickets can now be safely created via a queued/retried offline submission).");

    // Sales Executive duty/location tracking — parallel to the driver system.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_duty_log (
        id SERIAL PRIMARY KEY,
        salesperson_user_id INTEGER REFERENCES users(id) NOT NULL,
        is_on BOOLEAN NOT NULL,
        event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7)
      );
      CREATE TABLE IF NOT EXISTS sales_gps_pings (
        id SERIAL PRIMARY KEY,
        salesperson_user_id INTEGER REFERENCES users(id) NOT NULL,
        latitude NUMERIC(10,7) NOT NULL,
        longitude NUMERIC(10,7) NOT NULL,
        accuracy_m NUMERIC(6,2),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_sales_gps_pings_sp_time ON sales_gps_pings(salesperson_user_id, recorded_at);
    `);
    log.push("Schema migration applied (Sales Executive duty login and location tracking).");

    // Rates now key on customer + site/project + grade, not just customer +
    // grade — the same customer's different sites can genuinely need
    // different rates (distance, mix specs, etc.). Existing rates keep their
    // NULL site_id and continue working as a customer-wide fallback when no
    // more specific site+grade rate exists.
    await pool.query(`ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id);`);
    log.push("Schema migration applied (rates now key on customer + site/project + grade).");

    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS preferred_time TIME;`);
    log.push("Schema migration applied (bookings can now carry a preferred time, not just a date).");

    // Pump charges split by pump type (with their own minimum-qty
    // thresholds), part load charge fields on rates, and the Manager's
    // confirmed pricing decisions on the order itself.
    await pool.query(`
      ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS line_pump_charge NUMERIC(10,2);
      ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS line_pump_min_qty_m3 NUMERIC(8,2) DEFAULT 20;
      ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS boom_pump_charge NUMERIC(10,2);
      ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS boom_pump_min_qty_m3 NUMERIC(8,2) DEFAULT 50;
      ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS part_load_min_qty_m3 NUMERIC(8,2) DEFAULT 5;
      ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS part_load_charge_per_m3 NUMERIC(10,2);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_charge_applicable BOOLEAN;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_charge_amount NUMERIC(10,2);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS part_load_applicable BOOLEAN;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS part_load_charge_amount NUMERIC(10,2);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_charge_needs_review BOOLEAN DEFAULT false;
    `);
    log.push("Schema migration applied (pump charges split by pump type with minimum-qty thresholds, part load charge, and order-level pricing confirmation).");

    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS part_load_charge NUMERIC(12,2) DEFAULT 0;`);
    log.push("Schema migration applied (invoices can now carry a part load charge line).");

    // Fixes the Production Report showing duplicate delivery notes — traced
    // to invoices.ticket_id not actually being enforced unique on this
    // database (only ever declared in the original schema.sql, never
    // retrofitted onto a database created before that). If duplicate
    // invoice rows exist for the same ticket, the report's join to
    // invoices doubles that row. Keeps the most recently-created invoice
    // per ticket (the one most likely to reflect the current rate/pump/
    // part-load state) and removes the rest, then adds the constraint so
    // this can't happen again. Safe to run repeatedly — a no-op once clean.
    const { rows: dupeCheck } = await pool.query(`
      SELECT ticket_id, COUNT(*) AS cnt FROM invoices GROUP BY ticket_id HAVING COUNT(*) > 1
    `);
    if (dupeCheck.length > 0) {
      // Picks a keeper per ticket — preferring whichever duplicate already
      // has a payment recorded against it (there should never be more than
      // one with a payment, but if there were, the most recent wins), else
      // just the most recent. Reassigns any payments pointing at the
      // other duplicates onto the keeper before deleting them, so this
      // can never hit the same foreign-key error as before.
      await pool.query(`
        WITH ranked AS (
          SELECT i.id, i.ticket_id,
            ROW_NUMBER() OVER (
              PARTITION BY i.ticket_id
              ORDER BY (EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)) DESC, i.id DESC
            ) AS rn
          FROM invoices i
        ),
        keepers AS (SELECT ticket_id, id AS keeper_id FROM ranked WHERE rn = 1)
        UPDATE payments p SET invoice_id = k.keeper_id
        FROM invoices dup JOIN keepers k ON k.ticket_id = dup.ticket_id
        WHERE p.invoice_id = dup.id AND dup.id != k.keeper_id
      `);
      await pool.query(`
        WITH ranked AS (
          SELECT i.id,
            ROW_NUMBER() OVER (
              PARTITION BY i.ticket_id
              ORDER BY (EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)) DESC, i.id DESC
            ) AS rn
          FROM invoices i
        )
        DELETE FROM invoices WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      `);
      log.push(`Schema migration applied (removed ${dupeCheck.length} duplicate invoice row group(s), preserving any payment history — this is what was causing the Production Report duplication).`);
    }
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'invoices_ticket_id_key'
        ) THEN
          ALTER TABLE invoices ADD CONSTRAINT invoices_ticket_id_key UNIQUE (ticket_id);
        END IF;
      END $$;
    `);
    log.push("Schema migration applied (invoices.ticket_id uniqueness enforced — prevents the duplication from recurring).");

    // Fuel module rebuild — Store role, and the request/approve/issue
    // workflow replacing self-logged fuel entries.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'store' AND enumtypid = 'user_role'::regtype) THEN
          ALTER TYPE user_role ADD VALUE 'store';
        END IF;
      END $$;
    `);
    await pool.query(`ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS is_plant BOOLEAN DEFAULT FALSE;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lubricant_types (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'supply_request_type') THEN
          CREATE TYPE supply_request_type AS ENUM ('fuel', 'lubricant');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'supply_request_status') THEN
          CREATE TYPE supply_request_status AS ENUM ('pending', 'approved', 'rejected', 'issued');
        END IF;
      END $$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS supply_requests (
        id SERIAL PRIMARY KEY,
        request_type supply_request_type NOT NULL,
        requested_by INTEGER REFERENCES users(id) NOT NULL,
        equipment_type fuel_equipment_type NOT NULL,
        truck_id INTEGER REFERENCES trucks(id),
        pump_id INTEGER REFERENCES pumps(id),
        equipment_id INTEGER REFERENCES equipment(id),
        odometer_reading NUMERIC(10,2),
        hour_meter_reading NUMERIC(10,2),
        requested_quantity NUMERIC(7,2) NOT NULL,
        fuel_station_id INTEGER REFERENCES fuel_stations(id),
        lubricant_type_id INTEGER REFERENCES lubricant_types(id),
        status supply_request_status DEFAULT 'pending',
        approved_quantity NUMERIC(7,2),
        approved_station_id INTEGER REFERENCES fuel_stations(id),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        rejected_reason TEXT,
        qr_token VARCHAR(64) UNIQUE,
        issued_by INTEGER REFERENCES users(id),
        issued_at TIMESTAMPTZ,
        actual_quantity_issued NUMERIC(7,2),
        fuel_cost NUMERIC(10,2),
        requested_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`
      INSERT INTO lubricant_types (name)
      SELECT * FROM (VALUES ('Engine oil 15W-40'), ('Gear oil'), ('Hydraulic fluid'), ('Grease'), ('Coolant')) AS v(name)
      WHERE NOT EXISTS (SELECT 1 FROM lubricant_types)
    `);
    log.push("Schema migration applied (fuel module rebuilt — Store role, supply_requests, lubricant_types).");

    // Reworked visit module — structured tap-answer questions instead of a
    // single free-text summary, explicit new/existing project choice, and
    // generated follow-ups with due dates.
    await pool.query(`
      ALTER TABLE customer_visits ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id);
      ALTER TABLE customer_visits ADD COLUMN IF NOT EXISTS is_new_project BOOLEAN;
      ALTER TABLE customer_visits ADD COLUMN IF NOT EXISTS contact_number VARCHAR(20);
      ALTER TABLE customer_visits ADD COLUMN IF NOT EXISTS answers JSONB;
      ALTER TABLE customer_visits ALTER COLUMN discussion_outcome DROP NOT NULL;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visit_followups (
        id SERIAL PRIMARY KEY,
        visit_id INTEGER REFERENCES customer_visits(id) NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        title VARCHAR(200) NOT NULL,
        reason TEXT,
        due_date DATE NOT NULL,
        assigned_to_role user_role NOT NULL DEFAULT 'sales_executive',
        assigned_to_user_id INTEGER REFERENCES users(id),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    log.push("Schema migration applied (visit module reworked — structured questions, follow-ups with due dates).");

    // Who/when tracking on delay reasons — the delay justification report
    // needs to show who entered a reason, not just the reason text.
    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_departure_delay_reason_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_departure_delay_reason_at TIMESTAMPTZ;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_delay_reason_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_delay_reason_at TIMESTAMPTZ;
      ALTER TABLE delivery_tickets ADD COLUMN IF NOT EXISTS site_delay_reason TEXT;
      ALTER TABLE delivery_tickets ADD COLUMN IF NOT EXISTS site_delay_reason_by INTEGER REFERENCES users(id);
      ALTER TABLE delivery_tickets ADD COLUMN IF NOT EXISTS site_delay_reason_at TIMESTAMPTZ;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS responded_by INTEGER REFERENCES users(id);
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
    `);
    log.push("Schema migration applied (who/when tracking added for delay reasons and notification responses).");

    // Plant Operator's own reason for a batching delay — distinct from
    // Manager's response to the alert, since Plant Operator is the one who
    // actually knows why batching hasn't started yet.
    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS batching_delay_reason TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS batching_delay_reason_by INTEGER REFERENCES users(id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS batching_delay_reason_at TIMESTAMPTZ;
    `);
    log.push("Schema migration applied (Plant Operator batching delay reason).");

    // Geofence-based arrival/departure detection (Site Supervisor's
    // site-ready tap as a geofence anchor, plus a saved plant location) —
    // purely additive hints, never auto-confirmed. See
    // lib/scheduledChecks.js's checkGeofenceEvents.
    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_latitude NUMERIC(10,7);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_longitude NUMERIC(10,7);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS site_ready_location_suspect BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plant_locations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL DEFAULT 'Main plant',
        latitude NUMERIC(10,7) NOT NULL,
        longitude NUMERIC(10,7) NOT NULL,
        geofence_radius_m INTEGER NOT NULL DEFAULT 200,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS geofence_events (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES delivery_tickets(id) NOT NULL,
        event_type VARCHAR(30) NOT NULL,
        detected_at TIMESTAMPTZ DEFAULT now(),
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        UNIQUE (ticket_id, event_type)
      );
    `);
    // Great-circle distance in meters — IMMUTABLE so it's safe to use in
    // index expressions later if that's ever needed; used today by the
    // scheduled geofence check as a plain function call.
    await pool.query(`
      CREATE OR REPLACE FUNCTION geo_distance_m(lat1 NUMERIC, lon1 NUMERIC, lat2 NUMERIC, lon2 NUMERIC)
      RETURNS NUMERIC AS $$
        SELECT 6371000 * 2 * ASIN(SQRT(
          POWER(SIN(RADIANS(lat2 - lat1) / 2), 2) +
          COS(RADIANS(lat1)) * COS(RADIANS(lat2)) * POWER(SIN(RADIANS(lon2 - lon1) / 2), 2)
        ));
      $$ LANGUAGE SQL IMMUTABLE;
    `);
    log.push("Schema migration applied (geofence-based arrival/departure detection — plant location, geofence events, site-ready GPS capture).");

    // Customer tracking links — unauthenticated, token-scoped, per-order.
    // Creating a new link auto-revokes any prior active one for the same
    // order (see routes/orders.js), so a link shared to the wrong person can
    // be invalidated by simply generating a fresh one.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_tracking_links (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES customer_orders(id) NOT NULL,
        token VARCHAR(64) UNIQUE NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT now(),
        revoked_at TIMESTAMPTZ,
        revoked_by INTEGER REFERENCES users(id)
      );
    `);
    log.push("Schema migration applied (customer order tracking links).");

    // Visit follow-up outcome — Won/Lost/Closed, with an admin-managed
    // reason list for Lost/Closed so the sales performance report can show
    // *why*, not just that it didn't convert.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visit_outcome_reasons (
        id SERIAL PRIMARY KEY,
        outcome_type VARCHAR(20) NOT NULL CHECK (outcome_type IN ('lost', 'closed')),
        reason VARCHAR(150) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true
      );
    `);
    await pool.query(`
      INSERT INTO visit_outcome_reasons (outcome_type, reason)
      SELECT * FROM (VALUES
        ('lost', 'Lost to competitor'), ('lost', 'Lost on price'), ('lost', 'Not interested'),
        ('closed', 'Project delayed/on hold'), ('closed', 'Project cancelled'), ('closed', 'Budget not approved')
      ) AS v(outcome_type, reason)
      WHERE NOT EXISTS (SELECT 1 FROM visit_outcome_reasons)
    `);
    await pool.query(`
      ALTER TABLE visit_followups ADD COLUMN IF NOT EXISTS outcome VARCHAR(20);
      ALTER TABLE visit_followups ADD COLUMN IF NOT EXISTS outcome_reason_id INTEGER REFERENCES visit_outcome_reasons(id);
      ALTER TABLE visit_followups ADD COLUMN IF NOT EXISTS outcome_notes TEXT;
      ALTER TABLE visit_followups ADD COLUMN IF NOT EXISTS outcome_by INTEGER REFERENCES users(id);
      ALTER TABLE visit_followups ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;
    `);
    log.push("Schema migration applied (visit follow-up outcome tracking — Won/Lost/Closed with reasons).");

    await pool.query(`
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS specified_slump_mm NUMERIC(5,1);
    `);
    log.push("Schema migration applied (specified slump added to orders — feeds the Delivery Challan's Workability field).");

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(10) NOT NULL DEFAULT 'en';
    `);
    log.push("Schema migration applied (driver language preference — 'en' | 'ml' | 'hi' — added to users).");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_contacts (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        site_id INTEGER NOT NULL REFERENCES sites(id),
        contact_name VARCHAR(150) NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        role_label VARCHAR(50),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_site_contacts_customer_site ON site_contacts(customer_id, site_id);
    `);
    log.push("Schema migration applied (Site Contacts directory — customer+site keyed, autofill on Create Order).");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS monthly_production_targets (
        id SERIAL PRIMARY KEY,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        target_m3 NUMERIC(10,1) NOT NULL,
        set_by INTEGER REFERENCES users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(year, month)
      );
    `);
    log.push("Schema migration applied (monthly production target — feeds the Manager dashboard's Achieved %/Balance/Required-per-day KPI).");

    // Round 98 — Maintenance module (item 10) & Best Driver of the Month (item 11).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS maintenance_action_points (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        interval_days INTEGER,
        interval_hours INTEGER,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    log.push("Schema migration applied (maintenance_action_points — Administrator-defined checklist of scheduled maintenance items, days-OR-hours-of-operation basis).");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS maintenance_logs (
        id SERIAL PRIMARY KEY,
        action_point_id INTEGER NOT NULL REFERENCES maintenance_action_points(id),
        truck_id INTEGER NOT NULL REFERENCES trucks(id),
        done_at DATE NOT NULL DEFAULT CURRENT_DATE,
        hours_at_service NUMERIC(10,2),
        performed_by INTEGER REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_logs_truck_action ON maintenance_logs(truck_id, action_point_id, done_at DESC);
    `);
    log.push("Schema migration applied (maintenance_logs — completion history feeding the due list and per-vehicle service history).");

    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE external_repair_status AS ENUM ('requested', 'approved', 'rejected', 'sent_out', 'returned');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_repairs (
        id SERIAL PRIMARY KEY,
        truck_id INTEGER NOT NULL REFERENCES trucks(id),
        requested_by INTEGER NOT NULL REFERENCES users(id),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        issue_description TEXT NOT NULL,
        status external_repair_status NOT NULL DEFAULT 'requested',
        workshop_name VARCHAR(150),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        rejection_reason TEXT,
        sent_out_at TIMESTAMPTZ,
        returned_at TIMESTAMPTZ,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_external_repairs_status ON external_repairs(status);
      CREATE INDEX IF NOT EXISTS idx_external_repairs_truck ON external_repairs(truck_id);
    `);
    log.push("Schema migration applied (external_repairs — driver-requested / Manager-approved external workshop flow; a truck sitting at 'sent_out' is excluded from Plant Operator's ticket-creation truck list).");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS truck_inspections (
        id SERIAL PRIMARY KEY,
        truck_id INTEGER NOT NULL REFERENCES trucks(id),
        driver_id INTEGER REFERENCES users(id),
        cleaner_name VARCHAR(100),
        inspection_date DATE NOT NULL DEFAULT CURRENT_DATE,
        ratings JSONB NOT NULL,
        observations TEXT,
        filled_by INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_truck_inspections_truck_date ON truck_inspections(truck_id, inspection_date DESC);
    `);
    log.push("Schema migration applied (truck_inspections — the digitized Transit Mixer Weekly Inspection Checklist, filled by Manager; ratings stored as JSONB, 1=Poor..4=Very Good per item; feeds Best Driver of the Month's checklist component).");

    await pool.query(`
      ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS issue_type VARCHAR(40);
    `);
    log.push("Schema migration applied (breakdown_reports.issue_type — picklist value for the driver breakdown report, round 99).");

    // Round 100, item 4 — customer concrete booking form, built for real.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_booking_links (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        site_id INTEGER REFERENCES sites(id) NOT NULL,
        token VARCHAR(64) UNIQUE NOT NULL,
        tracking_enabled BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by INTEGER REFERENCES users(id) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_by INTEGER REFERENCES users(id),
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_customer_booking_links_token ON customer_booking_links(token);
      CREATE INDEX IF NOT EXISTS idx_customer_booking_links_customer_site ON customer_booking_links(customer_id, site_id);
    `);
    await pool.query(`
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_link_id INTEGER REFERENCES customer_booking_links(id);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pump_requirement pump_type;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS casting_location VARCHAR(200);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS site_contact_name VARCHAR(150);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS site_contact_number VARCHAR(20);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remarks TEXT;
      ALTER TABLE bookings ALTER COLUMN requested_by DROP NOT NULL;
    `);
    log.push("Schema migration applied (customer_booking_links — Manager/Admin-generated per customer+site token; bookings can now originate from a customer directly, not just a Sales Executive — requested_by is NULL for those, booking_link_id points at the link instead).");

    // Round 101, item 1 — plant-out auto-record after a per-site grace period
    // if the driver never responds to the geofence "left plant" notification.
    await pool.query(`
      ALTER TABLE sites ADD COLUMN IF NOT EXISTS plant_out_grace_minutes INTEGER;
      ALTER TABLE geofence_events ADD COLUMN IF NOT EXISTS last_response_at TIMESTAMPTZ;
    `);
    log.push("Schema migration applied (sites.plant_out_grace_minutes — per-site grace period before Plant Out is auto-recorded; geofence_events.last_response_at — restarts the grace period when a driver taps 'Not yet').");

    // Round 101, item 2 — "Action required" remark per checklist item on the
    // weekly inspection, recorded as an open maintenance action item.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inspection_action_items (
        id SERIAL PRIMARY KEY,
        inspection_id INTEGER NOT NULL REFERENCES truck_inspections(id),
        truck_id INTEGER NOT NULL REFERENCES trucks(id),
        item_key VARCHAR(80) NOT NULL,
        item_label VARCHAR(200) NOT NULL,
        remark TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        raised_by INTEGER NOT NULL REFERENCES users(id),
        raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_by INTEGER REFERENCES users(id),
        resolved_at TIMESTAMPTZ,
        resolution_notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inspection_action_items_status ON inspection_action_items(status, truck_id);
    `);
    log.push("Schema migration applied (inspection_action_items — per-checklist-item 'Action required' remarks from the weekly inspection, tracked open/resolved as maintenance action items).");

    // Round 115 — Sales module rework: mandatory visit questionnaire on a
    // lead's "Site visit" update (is_new_project/answers, plus a link to the
    // customer_visits row it creates), and an action log so a follow-up
    // thread with several open items can show what's actually been done
    // against it, not just whether it's done or not.
    await pool.query(`
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS is_new_project BOOLEAN;
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS answers JSONB;
      ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS related_visit_id INTEGER REFERENCES customer_visits(id);
      CREATE TABLE IF NOT EXISTS followup_actions (
        id SERIAL PRIMARY KEY,
        followup_id INTEGER REFERENCES visit_followups(id) NOT NULL,
        note TEXT NOT NULL,
        next_due_date DATE,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_followup_actions_followup ON followup_actions(followup_id);
    `);
    log.push("Schema migration applied (lead site-visit questionnaire fields, and a followup_actions log for follow-up threads).");

    // Round 118 — Lab Technician role, mix designs, cube test results, PDF reports.
    await pool.query(`DO $$ BEGIN
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'lab_technician';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mix_designs (
        id SERIAL PRIMARY KEY,
        mix_grade_id INTEGER REFERENCES mix_grades(id) NOT NULL,
        design_ref_code VARCHAR(40) NOT NULL UNIQUE,
        mix_description VARCHAR(200),
        fck_28day_mpa NUMERIC(5,1) NOT NULL,
        std_deviation_mpa NUMERIC(4,1) NOT NULL,
        target_mean_strength_mpa NUMERIC(6,2) GENERATED ALWAYS AS (fck_28day_mpa + 1.65 * std_deviation_mpa) STORED,
        max_agg_size_mm INTEGER,
        target_workability_mm VARCHAR(20),
        design_density_kgm3 NUMERIC(7,1),
        cement_kgm3 NUMERIC(6,1) NOT NULL,
        fly_ash_kgm3 NUMERIC(6,1) NOT NULL DEFAULT 0,
        total_binder_kgm3 NUMERIC(6,1) GENERATED ALWAYS AS (cement_kgm3 + fly_ash_kgm3) STORED,
        free_water_kgm3 NUMERIC(6,1) NOT NULL,
        wb_ratio NUMERIC(5,3) GENERATED ALWAYS AS (free_water_kgm3 / NULLIF(cement_kgm3 + fly_ash_kgm3, 0)) STORED,
        fine_agg_kgm3 NUMERIC(6,1) NOT NULL,
        coarse_20mm_kgm3 NUMERIC(6,1) NOT NULL,
        coarse_12_5mm_kgm3 NUMERIC(6,1) NOT NULL,
        total_aggregate_kgm3 NUMERIC(7,1) GENERATED ALWAYS AS (fine_agg_kgm3 + coarse_20mm_kgm3 + coarse_12_5mm_kgm3) STORED,
        cement_type_source VARCHAR(120),
        cement_sp_gr NUMERIC(4,2),
        fly_ash_type_source VARCHAR(120),
        fly_ash_sp_gr NUMERIC(4,2),
        fine_agg_type_source VARCHAR(120),
        fine_agg_sp_gr NUMERIC(4,2),
        coarse_20mm_type_source VARCHAR(120),
        coarse_20mm_sp_gr NUMERIC(4,2),
        coarse_12_5mm_type_source VARCHAR(120),
        coarse_12_5mm_sp_gr NUMERIC(4,2),
        fine_moisture_pct NUMERIC(4,1),
        fine_absorption_pct NUMERIC(4,1),
        coarse_20mm_moisture_pct NUMERIC(4,1),
        coarse_20mm_absorption_pct NUMERIC(4,1),
        coarse_12_5mm_moisture_pct NUMERIC(4,1),
        coarse_12_5mm_absorption_pct NUMERIC(4,1),
        is_standard_for_grade BOOLEAN NOT NULL DEFAULT false,
        status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
        revision VARCHAR(10) NOT NULL DEFAULT '00',
        notes TEXT,
        created_by INTEGER REFERENCES users(id) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mix_designs_standard_per_grade ON mix_designs(mix_grade_id)
        WHERE is_standard_for_grade = true AND status = 'approved';
      CREATE TABLE IF NOT EXISTS mix_design_admixtures (
        id SERIAL PRIMARY KEY,
        mix_design_id INTEGER REFERENCES mix_designs(id) ON DELETE CASCADE NOT NULL,
        type_brand VARCHAR(120) NOT NULL,
        dosage_pct_of_binder NUMERIC(5,2),
        qty_kgm3 NUMERIC(6,2) NOT NULL,
        sp_gr NUMERIC(4,2),
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mix_design_admixtures_design ON mix_design_admixtures(mix_design_id);
      CREATE TABLE IF NOT EXISTS mix_design_assignments (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        mix_grade_id INTEGER REFERENCES mix_grades(id) NOT NULL,
        mix_design_id INTEGER REFERENCES mix_designs(id) NOT NULL,
        assigned_by INTEGER REFERENCES users(id) NOT NULL,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by INTEGER REFERENCES users(id),
        updated_at TIMESTAMPTZ,
        UNIQUE (customer_id, mix_grade_id)
      );
      CREATE TABLE IF NOT EXISTS cube_test_results (
        id SERIAL PRIMARY KEY,
        plant_qc_id INTEGER REFERENCES plant_qc(id) NOT NULL,
        testing_age_days INTEGER NOT NULL CHECK (testing_age_days IN (7, 28)),
        mix_design_id INTEGER REFERENCES mix_designs(id),
        average_weight_kg NUMERIC(6,3),
        average_load_kn NUMERIC(7,2),
        average_density_kgm3 NUMERIC(7,1),
        average_strength_mpa NUMERIC(6,2),
        remarks TEXT,
        tested_by INTEGER REFERENCES users(id) NOT NULL,
        tested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (plant_qc_id, testing_age_days)
      );
      CREATE TABLE IF NOT EXISTS cube_test_cubes (
        id SERIAL PRIMARY KEY,
        cube_test_result_id INTEGER REFERENCES cube_test_results(id) ON DELETE CASCADE NOT NULL,
        cube_label VARCHAR(40) NOT NULL,
        weight_kg NUMERIC(6,3),
        testing_load_kn NUMERIC(7,2),
        density_kgm3 NUMERIC(7,1),
        strength_mpa NUMERIC(6,2),
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cube_test_cubes_result ON cube_test_cubes(cube_test_result_id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS resolved_mix_design_id INTEGER REFERENCES mix_designs(id);
    `);
    log.push("Schema migration applied (lab_technician role; mix_designs — grade-independent mix design library with generated target-strength/W-B-ratio/totals fields, admixtures and assignments as separate tables; cube_test_results/cube_test_cubes — 7/28-day compressive strength results per cube batch; customer_orders.resolved_mix_design_id — the design an order actually resolved to at creation).");

    // cube_batch_status (round 118 refinement) — lets a Lab Technician mark a
    // cube batch as not going to be tested, purely a dashboard/workflow
    // marker so it stops cluttering the active list. Does not touch
    // plant_qc or cube_test_results.
    await query(`
      CREATE TABLE IF NOT EXISTS cube_batch_status (
        plant_qc_id INTEGER PRIMARY KEY REFERENCES plant_qc(id),
        status VARCHAR(20) NOT NULL DEFAULT 'closed' CHECK (status = 'closed'),
        closed_reason TEXT,
        closed_by INTEGER REFERENCES users(id) NOT NULL,
        closed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    log.push("Schema migration applied (cube_batch_status — lets a cube batch be closed out of the active Lab Technician dashboard when it won't be tested).");

    // failure_type (round 118 refinement) — optional per-test note on how
    // the cubes failed under load, shown on the Cube Test Report PDF.
    await query(`
      ALTER TABLE cube_test_results ADD COLUMN IF NOT EXISTS failure_type VARCHAR(60);
    `);
    log.push("Schema migration applied (cube_test_results.failure_type — optional IS 516 failure-mode note per test).");

    // Round 119 — public inquiry capture + the customer portal (short access
    // code, not a shareable link — see schema.sql's comment above
    // customer_access_tokens for why).
    await query(`
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'staff';
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS customer_access_tokens (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        token VARCHAR(12) UNIQUE NOT NULL,
        label VARCHAR(100),
        is_active BOOLEAN NOT NULL DEFAULT true,
        allow_tracking BOOLEAN NOT NULL DEFAULT true,
        allow_qc_reports BOOLEAN NOT NULL DEFAULT true,
        created_by INTEGER REFERENCES users(id) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_by INTEGER REFERENCES users(id),
        revoked_at TIMESTAMPTZ
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_customer_access_tokens_token ON customer_access_tokens(token);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_customer_access_tokens_customer ON customer_access_tokens(customer_id);`);
    await query(`
      CREATE TABLE IF NOT EXISTS customer_access_token_sites (
        token_id INTEGER REFERENCES customer_access_tokens(id) ON DELETE CASCADE NOT NULL,
        site_id INTEGER REFERENCES sites(id) NOT NULL,
        PRIMARY KEY (token_id, site_id)
      );
    `);
    log.push("Schema migration applied (leads.source — distinguishes a public /inquiry submission from a staff-created lead; customer_access_tokens/customer_access_token_sites — short Manager-issued sign-in codes for the customer portal, each scoped to one customer and one or more sites).");

    // Post-ship, same round — access control switches per code (business
    // asked for a way to turn off specific portal capabilities per
    // customer). Separate ALTER, guarded, since the table above may
    // already exist from an earlier round-119 deploy without these columns
    // (CREATE TABLE IF NOT EXISTS is a no-op against an existing table).
    await query(`
      ALTER TABLE customer_access_tokens ADD COLUMN IF NOT EXISTS allow_tracking BOOLEAN NOT NULL DEFAULT true;
    `);
    await query(`
      ALTER TABLE customer_access_tokens ADD COLUMN IF NOT EXISTS allow_qc_reports BOOLEAN NOT NULL DEFAULT true;
    `);
    log.push("Schema migration applied (customer_access_tokens.allow_tracking / allow_qc_reports — per-code switches so Manager can turn off live tracking or QC reports for a specific customer's access code; both default true so existing codes are unaffected).");

    // Post-ship, same round — the business's own mockup clarified "technical
    // writings" as a small admin-managed PDF document library (guides like
    // "After-pour care", not the mix design itself), with its own per-code
    // switch alongside tracking/QC. First feature in this app to store an
    // uploaded file's bytes (BYTEA — no object storage set up elsewhere).
    await query(`
      ALTER TABLE customer_access_tokens ADD COLUMN IF NOT EXISTS allow_technical_writings BOOLEAN NOT NULL DEFAULT true;
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS technical_documents (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        category VARCHAR(60),
        filename VARCHAR(200) NOT NULL,
        mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
        size_bytes INTEGER NOT NULL,
        file_data BYTEA NOT NULL,
        uploaded_by INTEGER REFERENCES users(id) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_technical_documents_category ON technical_documents(category);`);
    log.push("Schema migration applied (customer_access_tokens.allow_technical_writings; technical_documents — Manager/Admin-uploaded PDF guides shown to customers whose code has this switched on).");

    // Round 119, post-ship (per the business's own mockup) — moved the three
    // portal capability switches off customer_access_tokens (per code) onto
    // customer_booking_links (per customer+SITE, one row per site on the
    // same "Booking Links & Requests" table the business already uses).
    // tracking_enabled already existed there; these two are new siblings.
    // Both default true on ALTER so an already-active link keeps showing
    // exactly what it showed before this migration ran.
    await query(`
      ALTER TABLE customer_booking_links ADD COLUMN IF NOT EXISTS allow_qc_reports BOOLEAN NOT NULL DEFAULT true;
    `);
    await query(`
      ALTER TABLE customer_booking_links ADD COLUMN IF NOT EXISTS allow_technical_writings BOOLEAN NOT NULL DEFAULT true;
    `);
    log.push("Schema migration applied (customer_booking_links.allow_qc_reports / allow_technical_writings — per customer+site portal feature switches, alongside the existing tracking_enabled; customer_access_tokens' own three switch columns are no longer read anywhere, superseded by this).");

    // Round 119, post-ship — full mockup-fidelity customer portal rebuild:
    // the new "Order Concrete" self-service form (routes/customerPortal.js's
    // POST /orders) creates a bookings row with requested_by AND
    // booking_link_id both NULL, same as the public /book/:token link
    // leaves requested_by — but there's no link token here, just an
    // authenticated /portal session, so booking_link_id stays NULL too.
    // Without this flag that combination would be indistinguishable from a
    // hypothetical booking with neither a staff submitter nor a link, so
    // it's what tells the Manager/Admin queue (and this app's own
    // requested_by/booking_link_id convention) the two apart.
    await query(`
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS submitted_via_portal BOOLEAN NOT NULL DEFAULT false;
    `);
    log.push("Schema migration applied (bookings.submitted_via_portal — distinguishes a customer's own 'Order Concrete' portal request from a booking-link submission, both of which leave requested_by/booking_link_id NULL/set the same way).");

    // Round 119, post-ship — the expanded public "Request a Quote" form and
    // the new "Free Technical Assistance" callback form (both in
    // routes/publicInquiry.js) both write their free-text extras here.
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;`);
    log.push("Schema migration applied (leads.notes — free-text extras from the expanded public Request-a-Quote and new Free-Technical-Assistance forms).");

    // Round 119, post-ship — editable copy for the two public marketing
    // pages (routes/siteContent.js). Seeded once with the business's own
    // mockup copy, ON CONFLICT DO NOTHING so a Manager's later edits are
    // never overwritten by a subsequent setup run.
    await query(`
      CREATE TABLE IF NOT EXISTS site_content (
        key VARCHAR(40) PRIMARY KEY,
        content JSONB NOT NULL,
        updated_by INTEGER REFERENCES users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(
      `INSERT INTO site_content (key, content) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
      [
        "services",
        JSON.stringify({
          grades: ["M15", "M20", "M25", "M30", "M35", "M40", "Design mixes on request"],
          services: [
            { title: "Ready-mix concrete supply", description: "Batched to order and delivered by transit mixer, with a QC-tested slump on every load." },
            { title: "Concrete pumping", description: "Boom and line pump options for high-rise and hard-to-reach pours." },
            { title: "On-site quality testing", description: "Slump checks and cube casting at the point of pour, with lab-verified compressive strength reports." },
          ],
          fleet: [
            { title: "Transit mixers", subtitle: "6m³ & 8m³" },
            { title: "Boom pumps", subtitle: "up to 32m reach" },
          ],
        }),
      ]
    );
    await query(
      `INSERT INTO site_content (key, content) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
      [
        "rmc_vs_sitemix",
        JSON.stringify({
          hero_title: "One consistent mix,\nevery single load.",
          hero_subtitle: "Why more contractors are moving away from mixing on site.",
          ready_mix_points: [
            "Batched by weight, QC-tested every load",
            "No site storage for cement/aggregate",
            "Faster pour, less labour on site",
            "Consistent strength, lab-verified",
          ],
          site_mix_points: [
            "Manual proportioning, varies by crew",
            "Needs storage & water on site",
            "Slower, more labour-intensive",
            "Strength varies batch to batch",
          ],
          cost_paragraph: "Site-mix looks cheaper per bag of cement — until you count labour, water, wastage, storage space and rework from inconsistent strength. Most contractors find ready-mix comes out even or ahead once a pour is above ~15 m³.",
          quality_paragraph: "Slump checked at the plant and again on site; cubes cast per pour and tested at 7 & 28 days. Once your account is set up, these results are available in the QC section of the app.",
        }),
      ]
    );
    log.push("Schema migration applied (site_content — editable copy for the public Services/Products/Equipment and Ready-Mix vs Site-Mix pages, seeded with the mockup's own default copy).");

    // Round 119, post-ship again — business feedback batch. See
    // pages/MasterDataPanels.jsx's OrdersPanel and routes/customerPortal.js's
    // resolveOrderContacts for the read/write side of this per-order
    // QC Engineer override.
    await query(`ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS assigned_qc_engineer_id INTEGER REFERENCES users(id);`);
    log.push("Schema migration applied (customer_orders.assigned_qc_engineer_id — lets Admin/Manager pick which QC Engineer shows on the customer portal's 'your team' card per order, instead of always the same role-based pick).");

    // Round 119, post-ship again — lets a customer submit their own delivery
    // feedback from the portal (routes/customerPortal.js's POST /feedback),
    // not just a Sales Executive logging it on their behalf. recorded_by can
    // no longer be NOT NULL now that a customer-submitted row has none.
    await query(`ALTER TABLE aftersales_feedback ALTER COLUMN recorded_by DROP NOT NULL;`);
    await query(`ALTER TABLE aftersales_feedback ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 1 AND 5);`);
    await query(`ALTER TABLE aftersales_feedback ADD COLUMN IF NOT EXISTS submitted_by_customer BOOLEAN NOT NULL DEFAULT false;`);
    log.push("Schema migration applied (aftersales_feedback.recorded_by now nullable, + rating and submitted_by_customer columns — for the new customer-portal Feedback screen).");

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

    // Seed/sample data (customer, site, pumps, a starter rate) has been
    // moved to run only on a genuinely fresh install, right after the tables
    // are first created — see above. It used to run unconditionally on every
    // /setup call, which meant the sample M25 rate (₹4500/₹1500/₹500) kept
    // silently getting inserted for any real customer that didn't yet have
    // an M25 rate of their own, every single time /setup was hit. That's a
    // real, serious bug — not a display issue — since deliveries would then
    // get invoiced at that fake rate. See the cleanup tool
    // (Administrator/Manager/Accountant → Rate history → "Review sample
    // rates") for finding and removing rates that came from this.

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

// One-time helper: generates a VAPID key pair for Web Push, so you don't need
// to install anything locally or run a separate script to get one. Visit
// this once, copy the two values into your backend's environment variables
// as VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, then redeploy — push
// notifications won't work until both are set. Safe to revisit (generates a
// fresh pair each time), but note that changing the keys after devices have
// already subscribed invalidates their existing subscriptions — they'll need
// to re-enable notifications once.
router.get("/setup/generate-vapid-keys", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  const webpush = (await import("web-push")).default;
  const keys = webpush.generateVAPIDKeys();
  res.send(
    `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
    `Copy these into your backend service's environment variables on Render,\n` +
    `then redeploy:\n\n` +
    `VAPID_PUBLIC_KEY=${keys.publicKey}\n` +
    `VAPID_PRIVATE_KEY=${keys.privateKey}\n\n` +
    `Keep the private key secret (same care as JWT_SECRET/SETUP_SECRET).</pre>`
  );
});

// Manually runs the "truck over 2 hours at site" check right now, instead of
// waiting for the 5-minute timer — useful for testing, or if you don't want
// to wait for the next automatic pass. Same protection as the rest of this
// file's maintenance endpoints.
router.get("/setup/run-delayed-trucks-check", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  const { checkDelayedTrucks } = await import("../lib/scheduledChecks.js");
  const notified = await checkDelayedTrucks();
  res.send(
    `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
    (notified.length
      ? `Notified QC about ${notified.length} truck(s):\n\n` + notified.map((t) => `- ${t.ticket_number} — ${t.truck_number} — ${t.site_name}`).join("\n")
      : `No trucks currently over 2 hours at site — nothing to notify.\n\n` +
        `If you expected one to show up here, double check its status is\n` +
        `"reached_site" or "unloading", and that it actually reached site\n` +
        `more than 2 hours ago.`) +
    `</pre>`
  );
});

router.get("/setup/run-pump-departure-check", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  const { checkPumpDepartureOverdue } = await import("../lib/scheduledChecks.js");
  const notified = await checkPumpDepartureOverdue();
  res.send(
    `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
    (notified.length
      ? `Notified about ${notified.length} overdue pump departure(s):\n\n` + notified.map((o) => `- ${o.customer_name} — ${o.site_name}`).join("\n")
      : `No overdue pump departures right now — nothing to notify.`) +
    `</pre>`
  );
});

router.get("/setup/run-batching-not-started-check", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  const { checkBatchingNotStarted } = await import("../lib/scheduledChecks.js");
  const notified = await checkBatchingNotStarted();
  res.send(
    `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
    (notified.length
      ? `Notified about ${notified.length} order(s) where batching hasn't started:\n\n` + notified.map((o) => `- ${o.customer_name} — ${o.site_name}`).join("\n")
      : `Nothing overdue right now — nothing to notify.`) +
    `</pre>`
  );
});

router.get("/setup/run-compliance-check", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  const { checkComplianceExpiries } = await import("../lib/scheduledChecks.js");
  const notified = await checkComplianceExpiries();
  res.send(
    `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
    (notified.length
      ? `Notified about ${notified.length} document(s):\n\n` + notified.map((d) => `- ${d.asset_name} — ${d.document_type} (expiry ${d.expiry_date?.toISOString?.().slice(0, 10) || d.expiry_date})`).join("\n")
      : `Nothing due for an alert right now — nothing to notify.`) +
    `</pre>`
  );
});

router.get("/setup/run-batching-delay-check", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  const { checkBatchingDelayAfterSiteReady } = await import("../lib/scheduledChecks.js");
  const notified = await checkBatchingDelayAfterSiteReady();
  res.send(
    `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
    (notified.length
      ? `Notified about ${notified.length} order(s):\n\n` + notified.map((o) => `- ${o.customer_name} — ${o.site_name}`).join("\n")
      : `Nothing over 12 minutes right now — nothing to notify.`) +
    `</pre>`
  );
});

// Diagnostic: shows exactly where a push notification chain might be broken —
// whether VAPID is configured, who has subscribed (by role), and the most
// recent notifications of each type, so you can tell "did the trigger fire"
// apart from "did delivery fail" without needing database access.
router.get("/setup/push-diagnostics", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }
  const vapidConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const { rows: subsByRole } = await pool.query(
    `SELECT u.role, u.name, COUNT(ps.id) AS device_count
     FROM users u LEFT JOIN push_subscriptions ps ON ps.user_id = u.id
     WHERE u.is_active
     GROUP BY u.role, u.name
     ORDER BY u.role, u.name`
  );
  const { rows: recent } = await pool.query(
    `SELECT type, recipient_role, recipient_id, message, created_at
     FROM notifications ORDER BY created_at DESC LIMIT 20`
  );
  res.send(
    `<pre style="font-family: sans-serif; font-size: 14px; padding: 20px;">` +
    `VAPID keys configured: ${vapidConfigured ? "yes" : "NO — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY first"}\n\n` +
    `Who has notifications enabled (0 devices = never tapped "Enable notifications",\n` +
    `or tapped it but their phone blocked the permission prompt):\n` +
    subsByRole.map((r) => `  ${r.role.padEnd(16)} ${r.name.padEnd(20)} ${r.device_count} device(s)`).join("\n") +
    `\n\nLast 20 notifications actually triggered (proves the trigger fired,\n` +
    `separate from whether the push itself was delivered):\n` +
    (recent.length
      ? recent.map((n) => `  ${n.created_at.toISOString().slice(0, 16).replace("T", " ")}  ${n.type.padEnd(22)} → ${n.recipient_id ? `user #${n.recipient_id}` : n.recipient_role}  — ${n.message}`).join("\n")
      : "  None yet.") +
    `</pre>`
  );
});

export default router;
