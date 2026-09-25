import { Router } from "express";
import { CATALOGUE as PERM_CATALOGUE, ROLES as PERM_ROLES } from "../lib/permissionCatalogue.js";
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

    // Round 138, item 3 — business asked to rename two existing lubricant
    // types and add two more. Renaming (rather than deactivating the old
    // name and adding a new row) keeps every existing supply_requests /
    // store_stock_items row pointing at the same lubricant_type_id, so
    // history and the current stock balance carry over untouched. Matched
    // case-insensitively so this catches the original seed's lowercase
    // names above ('Gear oil', 'Hydraulic fluid') or any hand-typed variant
    // already in a live database, and is a no-op once already renamed —
    // safe to re-run on every /setup visit like the rest of this file.
    // Placed here (before the store_stock_items self-healing seed further
    // below, which creates a matching stock item for every lubricant type
    // on file) so a single /setup visit provisions the two new types
    // (DEF (AdBlue), Petrol) AND their stock items together, not just the
    // types with the items following on some later visit.
    await pool.query(`
      UPDATE lubricant_types SET name = 'Hydraulic Oil 68'
      WHERE lower(name) = lower('Hydraulic Fluid') AND lower(name) != lower('Hydraulic Oil 68')
    `);
    await pool.query(`
      UPDATE lubricant_types SET name = 'Gear Oil 140'
      WHERE lower(name) = lower('Gear Oil') AND lower(name) != lower('Gear Oil 140')
    `);
    await pool.query(`
      INSERT INTO lubricant_types (name)
      SELECT v.name FROM (VALUES ('Hydraulic Oil 68'), ('Gear Oil 140'), ('DEF (AdBlue)'), ('Petrol')) AS v(name)
      WHERE NOT EXISTS (SELECT 1 FROM lubricant_types lt WHERE lower(lt.name) = lower(v.name))
    `);
    log.push("Schema migration applied (lubricant types: 'Hydraulic Fluid' renamed to 'Hydraulic Oil 68', 'Gear Oil' renamed to 'Gear Oil 140', added 'DEF (AdBlue)' and 'Petrol').");

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

    // Round 119, post-ship again — round 3: the Manager dashboard's "Close"
    // button on a public inquiry used to actually mark the lead lost — the
    // business only wanted it dismissed from the widget, with closing staying
    // a Leads-page-only action. dashboard_hidden is purely a per-lead
    // "dismissed from the dashboard widget" flag, reversible via the same
    // PATCH /sales/leads/:id/dashboard-hide route (hidden: false) — it has no
    // bearing on lead status/won/lost.
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS dashboard_hidden BOOLEAN NOT NULL DEFAULT false;`);
    log.push("Schema migration applied (leads.dashboard_hidden — lets a Manager dismiss a public inquiry from the dashboard widget without closing the lead).");

    // Round 119, post-ship again — round 3: extends the existing Plant-Out
    // auto-record grace period (sites.plant_out_grace_minutes — see
    // checkPlantOutAutoRecord in scheduledChecks.js) to the other 3 GPS
    // stage nudges (Site In, Site Out, Plant In). Site In/Plant In are plain
    // trip_events, same as Plant Out — nothing new needed there. Site Out is
    // different: it normally also captures site_qc's slump/delivery-note/
    // after-pour-care from the driver's own form. When it auto-records
    // instead (driver never responded), those fields are left blank and this
    // flag is set, so Manager/QC's dashboards can tell "driver confirmed
    // this" apart from "system closed this out with no info" and follow up.
    await query(`ALTER TABLE site_qc ADD COLUMN IF NOT EXISTS auto_confirmed BOOLEAN NOT NULL DEFAULT false;`);
    log.push("Schema migration applied (site_qc.auto_confirmed — flags a Site Out that was GPS-auto-recorded with no slump/delivery-note/after-pour-care info from the driver).");

    // Round 119, post-ship again — round 6: customer_orders.required_at_site_time
    // — the time the customer actually needs concrete AT SITE, distinct from
    // scheduled_batching_time (when the plant starts batching, which needs to
    // be earlier by however long the delivery takes to reach the site). See
    // Create Order / Convert Booking (lib/SalesPanels.jsx, pages/CreateOrder.jsx)
    // for the "suggested batching time" helper this feeds, and
    // routes/customerPortal.js for where it replaces scheduled_batching_time
    // on every customer-facing screen.
    await query(`ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS required_at_site_time TIME;`);
    log.push("Schema migration applied (customer_orders.required_at_site_time — the customer-facing 'needed at site' time, distinct from the internal plant batching time).");

    // Round 120, item 4a — per-result show/hide switch so not every internal
    // cube test needs to be visible in the customer module. Defaults true so
    // every existing result stays exactly as visible as it is today; a Lab
    // Technician/Administrator has to actively hide one.
    await query(`ALTER TABLE cube_test_results ADD COLUMN IF NOT EXISTS visible_to_customer BOOLEAN NOT NULL DEFAULT true;`);
    log.push("Schema migration applied (cube_test_results.visible_to_customer — per-result switch for whether a test appears in the customer module; defaults true).");

    // Round 120, items 4b/4e — cubes prepared AT THE CUSTOMER'S SITE (not
    // plant-cast), a genuinely separate workflow from plant_qc/cube_test_results
    // since there's no delivery ticket to anchor a site-cast batch to — it
    // belongs to the order/pour as a whole instead. Deliberately mirrors the
    // existing plant_qc → cube_test_results → cube_test_cubes three-table
    // shape (a "cast" record, one "test result" row per testing age, each
    // with its own cube rows) so the same reporting/PDF patterns apply with
    // minimal new concepts — the only structural difference is order_id
    // instead of ticket_id as the anchor. Same visible_to_customer switch as
    // plant-cast results, defaulting true.
    await query(`
      CREATE TABLE IF NOT EXISTS site_cube_casts (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES customer_orders(id) NOT NULL,
        cast_date DATE NOT NULL,
        number_of_cubes INTEGER,
        sample_ids TEXT,
        remarks TEXT,
        entered_by INTEGER REFERENCES users(id),
        entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_site_cube_casts_order ON site_cube_casts(order_id);
      CREATE TABLE IF NOT EXISTS site_cube_test_results (
        id SERIAL PRIMARY KEY,
        site_cube_cast_id INTEGER REFERENCES site_cube_casts(id) NOT NULL,
        testing_age_days INTEGER NOT NULL CHECK (testing_age_days IN (7, 28)),
        mix_design_id INTEGER REFERENCES mix_designs(id),
        average_weight_kg NUMERIC(6,3),
        average_load_kn NUMERIC(7,2),
        average_density_kgm3 NUMERIC(7,1),
        average_strength_mpa NUMERIC(6,2),
        failure_type VARCHAR(60),
        remarks TEXT,
        visible_to_customer BOOLEAN NOT NULL DEFAULT true,
        tested_by INTEGER REFERENCES users(id) NOT NULL,
        tested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (site_cube_cast_id, testing_age_days)
      );
      CREATE TABLE IF NOT EXISTS site_cube_test_cubes (
        id SERIAL PRIMARY KEY,
        site_cube_test_result_id INTEGER REFERENCES site_cube_test_results(id) ON DELETE CASCADE NOT NULL,
        cube_label VARCHAR(40) NOT NULL,
        weight_kg NUMERIC(6,3),
        testing_load_kn NUMERIC(7,2),
        density_kgm3 NUMERIC(7,1),
        strength_mpa NUMERIC(6,2),
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_site_cube_test_cubes_result ON site_cube_test_cubes(site_cube_test_result_id);
    `);
    log.push("Schema migration applied (site_cube_casts/site_cube_test_results/site_cube_test_cubes — cube samples cast at the customer's site rather than the plant, anchored to the order instead of a delivery ticket; same visible_to_customer switch as plant-cast results).");

    // Round 121, item 3 — a customer may need multiple billing entities
    // (business decision: "one day bill Company A, next order Company B, to
    // manage tax," even for the same site) — each a named, reusable profile
    // (name/address/GSTIN) a customer maintains, picked per order (defaults
    // to whichever one is_default, but always changeable). Deliberately
    // additive: customers.billing_address (the old single free-text field)
    // stays exactly as-is as the fallback for a customer with no profiles
    // set up — nothing here changes what any existing order or invoice shows.
    await query(`
      CREATE TABLE IF NOT EXISTS customer_billing_addresses (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) NOT NULL,
        name VARCHAR(150) NOT NULL,
        address TEXT,
        gstin VARCHAR(20),
        is_default BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_customer_billing_addresses_customer ON customer_billing_addresses(customer_id);
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS billing_address_id INTEGER REFERENCES customer_billing_addresses(id);
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_name VARCHAR(200);
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_address TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_gstin VARCHAR(20);
    `);
    log.push("Schema migration applied (customer_billing_addresses — named, reusable billing profiles per customer; customer_orders.billing_address_id — which profile an order is billed under; invoices.billing_name/billing_address/billing_gstin — snapshotted at invoice-generation time so a past invoice never changes if the profile is later edited).");

    await query(`
      ALTER TABLE customer_access_tokens ADD COLUMN IF NOT EXISTS covers_all_sites BOOLEAN NOT NULL DEFAULT false;
    `);
    log.push("Schema migration applied (customer_access_tokens.covers_all_sites — an access code can now cover every current and future site for a customer instead of a fixed, checked-at-generation-time site list).");

    // Round 122 — cube testing moves from per-DN to per-pour (see
    // schema.sql's comment above cube_test_results). Purely additive: relax
    // plant_qc_id to nullable so a new pour-level row can omit it, add
    // order_id (backfilled below for every existing row so date-correction
    // and reporting can key off it uniformly regardless of a row's age), add
    // the partial unique index that only governs NEW pour-level rows, add
    // cube_test_cubes.plant_qc_id for per-cube DN provenance on a multi-DN
    // pour, and add cube_pour_status as a parallel table to the existing
    // per-DN cube_batch_status (left untouched).
    await query(`
      ALTER TABLE cube_test_results ALTER COLUMN plant_qc_id DROP NOT NULL;
      ALTER TABLE cube_test_results ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES customer_orders(id);
    `);
    await query(`
      UPDATE cube_test_results ctr SET order_id = dt.order_id
      FROM plant_qc pq JOIN delivery_tickets dt ON dt.id = pq.ticket_id
      WHERE pq.id = ctr.plant_qc_id AND ctr.order_id IS NULL;
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cube_test_results_pour ON cube_test_results(order_id, testing_age_days)
        WHERE plant_qc_id IS NULL;
      ALTER TABLE cube_test_cubes ADD COLUMN IF NOT EXISTS plant_qc_id INTEGER REFERENCES plant_qc(id);
      CREATE TABLE IF NOT EXISTS cube_pour_status (
        order_id INTEGER PRIMARY KEY REFERENCES customer_orders(id),
        status VARCHAR(20) NOT NULL DEFAULT 'closed' CHECK (status = 'closed'),
        closed_reason TEXT,
        closed_by INTEGER REFERENCES users(id) NOT NULL,
        closed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    log.push("Schema migration applied (cube_test_results — cube testing moves from per-DN to per-pour; plant_qc_id is now nullable and order_id added/backfilled, with a partial unique index covering only new pour-level rows so no existing per-DN result is touched; cube_test_cubes.plant_qc_id — per-cube DN provenance for a multi-DN pour; cube_pour_status — pour-level close/reopen, parallel to the existing cube_batch_status).");

    // Round 127 — data repair, not a schema change. The averaging bug fixed
    // in round 124 (an untested cube's blank field silently pulling the
    // average toward zero — see the POST routes below) only fixed how a
    // NEW submission gets averaged; any result that was already stored
    // before that fix kept its wrong average forever, since the PDF/report
    // routes just display the stored average_* columns rather than
    // recomputing them. This recomputes every stored average directly from
    // its own cube_test_cubes/site_cube_test_cubes rows — which have always
    // correctly distinguished a tested cube from an untested one (a real
    // NULL, never a phantom zero) — and only writes back rows whose stored
    // figure is actually wrong (IS DISTINCT FROM), so this is cheap and
    // idempotent to re-run on every startup, and touches nothing for a
    // result that was already correct.
    await query(`
      UPDATE cube_test_results ctr SET
        average_weight_kg = sub.avg_weight,
        average_load_kn = sub.avg_load,
        average_density_kgm3 = sub.avg_density,
        average_strength_mpa = sub.avg_strength
      FROM (
        SELECT cube_test_result_id,
               AVG(weight_kg) FILTER (WHERE weight_kg IS NOT NULL) AS avg_weight,
               AVG(testing_load_kn) FILTER (WHERE testing_load_kn IS NOT NULL) AS avg_load,
               AVG(density_kgm3) FILTER (WHERE density_kgm3 IS NOT NULL) AS avg_density,
               AVG(strength_mpa) FILTER (WHERE strength_mpa IS NOT NULL) AS avg_strength
        FROM cube_test_cubes
        GROUP BY cube_test_result_id
      ) sub
      WHERE ctr.id = sub.cube_test_result_id
        AND (ctr.average_weight_kg IS DISTINCT FROM sub.avg_weight
          OR ctr.average_load_kn IS DISTINCT FROM sub.avg_load
          OR ctr.average_density_kgm3 IS DISTINCT FROM sub.avg_density
          OR ctr.average_strength_mpa IS DISTINCT FROM sub.avg_strength);
    `);
    await query(`
      UPDATE site_cube_test_results sctr SET
        average_weight_kg = sub.avg_weight,
        average_load_kn = sub.avg_load,
        average_density_kgm3 = sub.avg_density,
        average_strength_mpa = sub.avg_strength
      FROM (
        SELECT site_cube_test_result_id,
               AVG(weight_kg) FILTER (WHERE weight_kg IS NOT NULL) AS avg_weight,
               AVG(testing_load_kn) FILTER (WHERE testing_load_kn IS NOT NULL) AS avg_load,
               AVG(density_kgm3) FILTER (WHERE density_kgm3 IS NOT NULL) AS avg_density,
               AVG(strength_mpa) FILTER (WHERE strength_mpa IS NOT NULL) AS avg_strength
        FROM site_cube_test_cubes
        GROUP BY site_cube_test_result_id
      ) sub
      WHERE sctr.id = sub.site_cube_test_result_id
        AND (sctr.average_weight_kg IS DISTINCT FROM sub.avg_weight
          OR sctr.average_load_kn IS DISTINCT FROM sub.avg_load
          OR sctr.average_density_kgm3 IS DISTINCT FROM sub.avg_density
          OR sctr.average_strength_mpa IS DISTINCT FROM sub.avg_strength);
    `);
    log.push("Data repair applied (cube_test_results/site_cube_test_results average_* columns recomputed from their own cube rows, excluding untested/blank cubes — fixes any result stored before round 124's averaging fix, no schema change).");

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

    // Round 131, item 5 — Store stock (purchase/receive/balance) layer on
    // top of the existing give-fuel-out workflow. See schema.sql's own
    // comment above store_stock_items for the full design rationale.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'store_stock_item_type') THEN
          CREATE TYPE store_stock_item_type AS ENUM ('fuel', 'lubricant');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'store_purchase_status') THEN
          CREATE TYPE store_purchase_status AS ENUM ('pending', 'approved', 'rejected', 'received');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'store_stock_txn_type') THEN
          CREATE TYPE store_stock_txn_type AS ENUM ('purchase_receive', 'issue_deduct', 'adjustment');
        END IF;
      END $$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_stock_items (
        id SERIAL PRIMARY KEY,
        item_type store_stock_item_type NOT NULL,
        lubricant_type_id INTEGER REFERENCES lubricant_types(id),
        unit VARCHAR(10) NOT NULL DEFAULT 'L',
        current_qty NUMERIC(10,2) NOT NULL DEFAULT 0,
        reorder_level NUMERIC(10,2),
        is_active BOOLEAN DEFAULT TRUE
      );
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS store_stock_items_fuel_singleton ON store_stock_items (item_type) WHERE item_type = 'fuel';`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS store_stock_items_lubricant_unique ON store_stock_items (lubricant_type_id) WHERE item_type = 'lubricant';`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_stock_purchases (
        id SERIAL PRIMARY KEY,
        stock_item_id INTEGER REFERENCES store_stock_items(id) NOT NULL,
        requested_by INTEGER REFERENCES users(id) NOT NULL,
        requested_qty NUMERIC(10,2) NOT NULL,
        supplier_name VARCHAR(150),
        notes TEXT,
        status store_purchase_status DEFAULT 'pending',
        approved_qty NUMERIC(10,2),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        rejected_reason TEXT,
        received_qty NUMERIC(10,2),
        unit_cost NUMERIC(10,2),
        total_cost NUMERIC(10,2),
        received_by INTEGER REFERENCES users(id),
        received_at TIMESTAMPTZ,
        requested_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_stock_transactions (
        id SERIAL PRIMARY KEY,
        stock_item_id INTEGER REFERENCES store_stock_items(id) NOT NULL,
        txn_type store_stock_txn_type NOT NULL,
        qty_change NUMERIC(10,2) NOT NULL,
        balance_after NUMERIC(10,2) NOT NULL,
        reference_type VARCHAR(30),
        reference_id INTEGER,
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    // Seed the singleton fuel stock item, and one lubricant stock item per
    // active lubricant type already on file — self-healing (also re-run
    // every /setup visit) so a lubricant type added before or after this
    // migration always ends up with a matching stock item.
    await pool.query(`
      INSERT INTO store_stock_items (item_type, unit)
      SELECT 'fuel', 'L' WHERE NOT EXISTS (SELECT 1 FROM store_stock_items WHERE item_type = 'fuel')
    `);
    await pool.query(`
      INSERT INTO store_stock_items (item_type, lubricant_type_id, unit)
      SELECT 'lubricant', lt.id, 'L'
      FROM lubricant_types lt
      WHERE lt.is_active
        AND NOT EXISTS (SELECT 1 FROM store_stock_items ssi WHERE ssi.item_type = 'lubricant' AND ssi.lubricant_type_id = lt.id)
    `);
    log.push("Schema migration applied (store_stock_items/store_stock_purchases/store_stock_transactions — Store can request fuel/lubricant purchases, Manager approves, Store receives and the balance updates; Manager can also make a physical stock adjustment; issuing fuel/lubricant at the plant — supply_requests' existing /:id/issue — now auto-deducts from this balance).");

    // Round 131, item 4 — home-screen photo widget. Manager/Admin upload
    // plant/site photos (routes/homeScreenPhotos.js); the customer portal
    // shows the visible ones, ordered, as a rotating "From our plant &
    // sites" widget on Home, replacing the old rmc-vs-sitemix strip there.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS home_screen_photos (
        id SERIAL PRIMARY KEY,
        caption VARCHAR(150),
        location_tag VARCHAR(10) NOT NULL DEFAULT 'plant' CHECK (location_tag IN ('plant', 'site')),
        filename VARCHAR(200) NOT NULL,
        mime_type VARCHAR(50) NOT NULL DEFAULT 'image/jpeg',
        size_bytes INTEGER NOT NULL,
        image_data BYTEA NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        is_visible BOOLEAN NOT NULL DEFAULT TRUE,
        uploaded_by INTEGER REFERENCES users(id) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_home_screen_photos_order ON home_screen_photos(display_order, id);`);
    log.push("Schema migration applied (home_screen_photos — Manager/Admin-managed plant/site photo gallery shown as a rotating widget on the customer portal's Home screen).");

    // Round 132, item 6 — Administrator/Manager can now set (and change) a
    // "since" date on a mix design assignment; saving one retroactively
    // rewrites customer_orders.resolved_mix_design_id for that customer+
    // grade's existing orders from that date onward, so a newly assigned
    // design actually appears in the customer portal for orders already on
    // the books, not just future ones.
    await query(`ALTER TABLE mix_design_assignments ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT CURRENT_DATE;`);

    // Round 133 — Loader Operator role: a dedicated login, scoped to just
    // requesting fuel/lubricant for the loader and seeing their own request
    // history (reuses the existing supply_requests table and
    // FuelFilling.jsx screen — no new table). No column/table migration
    // needed beyond the enum value itself.
    await pool.query(`DO $$ BEGIN
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'loader_operator';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    log.push("Schema migration applied (loader_operator role).");

    // Round 134, items 1-2 — Loader Operator can now report a breakdown and
    // request an outside repair for their loader, not just fuel. Reuses the
    // existing breakdown_reports/external_repairs tables via a new
    // 'equipment' bucket (breakdown_reports) and a new nullable
    // equipment_id column (both tables) — mirrors fuel_logs' own
    // truck_id/pump_id/equipment_id split. truck_id's NOT NULL is relaxed
    // on external_repairs since a loader repair request has no truck at
    // all; which of truck_id/equipment_id is set is enforced in the API,
    // not a DB constraint (same house style as fuel_logs).
    await pool.query(`DO $$ BEGIN
      ALTER TYPE breakdown_equipment_type ADD VALUE IF NOT EXISTS 'equipment';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await query(`ALTER TABLE breakdown_reports ADD COLUMN IF NOT EXISTS equipment_id INTEGER REFERENCES equipment(id);`);
    await query(`ALTER TABLE external_repairs ADD COLUMN IF NOT EXISTS equipment_id INTEGER REFERENCES equipment(id);`);
    await query(`ALTER TABLE external_repairs ALTER COLUMN truck_id DROP NOT NULL;`);
    log.push("Schema migration applied (breakdown_reports/external_repairs now also cover loader/equipment, not just trucks — Loader Operator can report breakdowns and request outside repairs).");

    // Round 134, item 3 — Odometer and Hour Meter reading fields on the
    // weekly Truck Inspection Checklist, alongside the existing per-item
    // ratings.
    await query(`ALTER TABLE truck_inspections ADD COLUMN IF NOT EXISTS odometer_reading NUMERIC(10,2);`);
    await query(`ALTER TABLE truck_inspections ADD COLUMN IF NOT EXISTS hour_meter_reading NUMERIC(10,2);`);
    log.push("Schema migration applied (truck_inspections.odometer_reading / hour_meter_reading).");

    // Round 136, item 1 — Maintenance Action Points: a third interval type
    // (quantity in m3 carried since last service, alongside the existing
    // days/hours) and per-vehicle/equipment scoping instead of always
    // applying to every active truck. No row in the new scope table for a
    // given action point means "applies to every active truck" — the exact
    // behavior every action point already on file had before this column
    // existed, so nothing already defined silently stops applying.
    // truck_id/equipment_id here follow the same "exactly one set,
    // enforced in the API not a DB constraint" house style as
    // external_repairs (Round 134) and fuel_logs before it.
    await query(`ALTER TABLE maintenance_action_points ADD COLUMN IF NOT EXISTS interval_qty_m3 NUMERIC(10,2);`);
    await query(`
      CREATE TABLE IF NOT EXISTS maintenance_action_point_scope (
        id SERIAL PRIMARY KEY,
        action_point_id INTEGER NOT NULL REFERENCES maintenance_action_points(id) ON DELETE CASCADE,
        truck_id INTEGER REFERENCES trucks(id),
        equipment_id INTEGER REFERENCES equipment(id),
        UNIQUE (action_point_id, truck_id),
        UNIQUE (action_point_id, equipment_id)
      );
    `);
    log.push("Schema migration applied (maintenance_action_points.interval_qty_m3, maintenance_action_point_scope).");

    // Round 136, item 2 — Repair Action Points: a scheduled repair against a
    // specific vehicle or equipment, flagged Internal or External, added as
    // and when a need comes up. Deliberately a new, separate table — NOT an
    // extension of breakdown_reports (unplanned, reported on the spot by a
    // driver/operator) or external_repairs' own send-out workflow.
    // external_repair_id is set once an External-flagged point actually
    // starts that workflow (once it's due), linking the two records rather
    // than duplicating external_repairs' own approve/sent-out/returned
    // states here.
    await query(`
      CREATE TABLE IF NOT EXISTS repair_action_points (
        id SERIAL PRIMARY KEY,
        truck_id INTEGER REFERENCES trucks(id),
        equipment_id INTEGER REFERENCES equipment(id),
        description VARCHAR(300) NOT NULL,
        repair_type VARCHAR(10) NOT NULL CHECK (repair_type IN ('internal','external')),
        scheduled_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scheduled','in_progress','completed','cancelled')),
        external_repair_id INTEGER REFERENCES external_repairs(id),
        notes TEXT,
        created_by INTEGER REFERENCES users(id) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_by INTEGER REFERENCES users(id),
        completed_at TIMESTAMPTZ
      );
    `);
    log.push("Schema migration applied (repair_action_points).");

    // Round 137, item 5 — the Batching Plant itself can now be added as an
    // equipment master row (Administrator → Masters → Fuel Stations and
    // Equipment's), so it can be scoped on a Maintenance Action Point or
    // targeted by a Repair Action Point like any other piece of equipment.
    await pool.query(`DO $$ BEGIN
      ALTER TYPE fuel_equipment_type ADD VALUE IF NOT EXISTS 'batching_plant';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    log.push("Schema migration applied (fuel_equipment_type gains 'batching_plant').");

    // Round 137, item 1d — a standing rupees/liter rate per stock item
    // (fuel, and each lubricant type), Manager/Administrator-maintained.
    // Distinct from store_stock_purchases.unit_cost (what was actually paid
    // for one purchase, captured at receive time) — this is the rate Store
    // sees pre-filled when issuing fuel/lubricant, so a cost doesn't have to
    // be guessed or looked up by hand at every single/frequent issue.
    await query(`ALTER TABLE store_stock_items ADD COLUMN IF NOT EXISTS rate_per_liter NUMERIC(10,2);`);
    log.push("Schema migration applied (store_stock_items.rate_per_liter).");

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

    // Round 139 — Material Module: Store's raw-material purchase → receive →
    // consume → physical-count workflow. Deliberately separate from the
    // pre-existing raw_material_stock table (Lab Technician's simple 9-bin
    // manual snapshot, untouched here) — every new table is prefixed rm_ so
    // the two can never collide. Full design rationale is on each table in
    // schema.sql's own "MATERIAL MODULE" section; this block just creates
    // the same tables additively for a database that predates this round.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rm_supply_scope') THEN
          CREATE TYPE rm_supply_scope AS ENUM ('delivered', 'ex_factory');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rm_freight_basis') THEN
          CREATE TYPE rm_freight_basis AS ENUM ('per_purchase_unit', 'per_trip', 'per_kg');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rm_order_status') THEN
          CREATE TYPE rm_order_status AS ENUM ('pending_approval', 'approved', 'rejected', 'closed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rm_gst_treatment') THEN
          CREATE TYPE rm_gst_treatment AS ENUM ('excluded', 'included');
        END IF;
      END $$;
    `);
    // Round 140, item 7 — 'closed' added to an enum that may already exist
    // from round 139 (the DO block above only creates it if missing, so a
    // pre-existing enum never picks up the new value on its own). ADD VALUE
    // IF NOT EXISTS is a plain top-level statement — can't go inside a DO
    // block's exception-catching the way the other guards do.
    await pool.query(`ALTER TYPE rm_order_status ADD VALUE IF NOT EXISTS 'closed';`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rm_materials (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL UNIQUE,
        category VARCHAR(80),
        sub_category VARCHAR(80),
        purchase_unit VARCHAR(20) NOT NULL,
        kg_per_purchase_unit NUMERIC(12,4) NOT NULL,
        tolerance_pct NUMERIC(5,2),
        reorder_level_kg NUMERIC(12,2),
        opening_stock_kg NUMERIC(14,2) NOT NULL DEFAULT 0,
        opening_stock_rate_per_kg NUMERIC(12,4),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS rm_suppliers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        contact_person VARCHAR(120),
        phone VARCHAR(30),
        address TEXT,
        gstin VARCHAR(20),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS rm_material_units (
        id SERIAL PRIMARY KEY,
        material_id INTEGER NOT NULL REFERENCES rm_materials(id),
        unit_name VARCHAR(20) NOT NULL,
        kg_per_unit NUMERIC(12,4) NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (material_id, unit_name)
      );
      CREATE TABLE IF NOT EXISTS rm_supplier_rates (
        id SERIAL PRIMARY KEY,
        supplier_id INTEGER NOT NULL REFERENCES rm_suppliers(id),
        material_id INTEGER NOT NULL REFERENCES rm_materials(id),
        scope rm_supply_scope NOT NULL,
        rate NUMERIC(12,2) NOT NULL,
        valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
        valid_to DATE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        updated_by INTEGER REFERENCES users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS rm_transporters (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        phone VARCHAR(30),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS rm_supplier_transporters (
        id SERIAL PRIMARY KEY,
        supplier_id INTEGER NOT NULL REFERENCES rm_suppliers(id),
        material_id INTEGER NOT NULL REFERENCES rm_materials(id),
        transporter_id INTEGER NOT NULL REFERENCES rm_transporters(id),
        freight_rate NUMERIC(12,2) NOT NULL,
        freight_basis rm_freight_basis NOT NULL DEFAULT 'per_purchase_unit',
        is_default BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true,
        UNIQUE (supplier_id, material_id, transporter_id)
      );
      CREATE TABLE IF NOT EXISTS rm_orders (
        id SERIAL PRIMARY KEY,
        material_id INTEGER NOT NULL REFERENCES rm_materials(id),
        supplier_id INTEGER NOT NULL REFERENCES rm_suppliers(id),
        scope rm_supply_scope NOT NULL,
        transporter_id INTEGER REFERENCES rm_transporters(id),
        ordered_qty NUMERIC(12,2) NOT NULL,
        rate NUMERIC(12,2) NOT NULL,
        freight_rate NUMERIC(12,2),
        freight_basis rm_freight_basis,
        tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
        gst_treatment rm_gst_treatment NOT NULL DEFAULT 'excluded',
        status rm_order_status NOT NULL DEFAULT 'pending_approval',
        requested_by INTEGER NOT NULL REFERENCES users(id),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        rejected_reason TEXT,
        notes TEXT,
        closed_by INTEGER REFERENCES users(id),
        closed_at TIMESTAMPTZ,
        closed_reason TEXT,
        revised_by INTEGER REFERENCES users(id),
        revised_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS rm_receipts (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES rm_orders(id),
        supplier_qty NUMERIC(12,2) NOT NULL,
        weighbridge_weight_kg NUMERIC(12,2),
        accepted_qty NUMERIC(12,2) NOT NULL,
        accepted_qty_kg NUMERIC(14,2) NOT NULL,
        transporter_id INTEGER REFERENCES rm_transporters(id),
        freight_rate NUMERIC(12,2),
        freight_basis rm_freight_basis,
        vehicle_number VARCHAR(20),
        challan_number VARCHAR(60),
        short_qty NUMERIC(12,2),
        debit_note_amount NUMERIC(12,2),
        landed_rate_per_kg NUMERIC(14,4),
        received_by INTEGER NOT NULL REFERENCES users(id),
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS rm_daily_consumption (
        id SERIAL PRIMARY KEY,
        material_id INTEGER NOT NULL REFERENCES rm_materials(id),
        consumption_date DATE NOT NULL,
        automatic_qty_kg NUMERIC(12,2),
        manual_qty_kg NUMERIC(12,2),
        recorded_by INTEGER NOT NULL REFERENCES users(id),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (material_id, consumption_date)
      );
      CREATE TABLE IF NOT EXISTS rm_daily_production (
        id SERIAL PRIMARY KEY,
        production_date DATE NOT NULL UNIQUE,
        concrete_produced_m3 NUMERIC(10,2) NOT NULL,
        recorded_by INTEGER NOT NULL REFERENCES users(id),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS rm_monthly_physical_stock (
        id SERIAL PRIMARY KEY,
        material_id INTEGER NOT NULL REFERENCES rm_materials(id),
        stock_month DATE NOT NULL,
        physical_stock_kg NUMERIC(14,2) NOT NULL,
        stock_taken_by INTEGER NOT NULL REFERENCES users(id),
        taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        notes TEXT,
        UNIQUE (material_id, stock_month)
      );
    `);
    log.push("Schema migration applied (Material Module — rm_materials, rm_material_units, rm_suppliers, rm_supplier_rates, rm_transporters, rm_supplier_transporters, rm_orders, rm_receipts, rm_daily_consumption, rm_daily_production, rm_monthly_physical_stock).");

    // Round 140 additive columns/indexes for databases that already had these
    // tables from round 139 (CREATE TABLE IF NOT EXISTS above is a no-op on
    // those, so the new columns/index need their own ADD-if-missing step).
    await pool.query(`
      ALTER TABLE rm_supplier_rates ADD COLUMN IF NOT EXISTS valid_from DATE NOT NULL DEFAULT CURRENT_DATE;
      ALTER TABLE rm_supplier_rates ADD COLUMN IF NOT EXISTS valid_to DATE;
      ALTER TABLE rm_supplier_rates DROP CONSTRAINT IF EXISTS rm_supplier_rates_supplier_id_material_id_scope_key;
      ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES users(id);
      ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
      ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS closed_reason TEXT;
      ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS revised_by INTEGER REFERENCES users(id);
      ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS revised_at TIMESTAMPTZ;
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_supplier_rates_current ON rm_supplier_rates(supplier_id, material_id, scope) WHERE valid_to IS NULL;`);
    // Backfill: a material created before round 140 has no rm_material_units
    // row at all (that table didn't exist yet), so its Units panel would
    // otherwise show empty even though it has a perfectly good purchase unit
    // on rm_materials itself — seed one default unit per such material from
    // its own purchase_unit/kg_per_purchase_unit, same as POST /materials
    // now does for a brand-new one.
    const { rowCount: unitsBackfilled } = await pool.query(`
      INSERT INTO rm_material_units (material_id, unit_name, kg_per_unit, is_default)
      SELECT m.id, m.purchase_unit, m.kg_per_purchase_unit, true
      FROM rm_materials m
      WHERE NOT EXISTS (SELECT 1 FROM rm_material_units u WHERE u.material_id = m.id)
    `);
    log.push(`Schema migration applied (Round 140 — rm_material_units; rm_supplier_rates effective dating; rm_orders close/revise columns). Backfilled ${unitsBackfilled} pre-existing material(s) into rm_material_units.`);

    // Round 142 — the Daily Consumption "mix design vs actual" report needs
    // to know which mix-design ingredient each raw material IS. The design
    // table has fixed component columns (cement_kgm3, fly_ash_kgm3, ...)
    // while rm_materials are whatever the business named them, so the link
    // has to be stated once by Administrator rather than guessed from the
    // material's name — a plant that calls a material "OPC 53 (Malabar)"
    // must not silently stop being cement because the string changed.
    // Nullable on purpose: a material with no component (admixture, water)
    // simply has no theoretical figure and the report says so.
    await pool.query(`
      ALTER TABLE rm_materials ADD COLUMN IF NOT EXISTS mix_component VARCHAR(20);
    `);
    // Best-effort first guess ONLY for materials nobody has classified yet,
    // and only on unambiguous name matches. Administrator can change any of
    // them afterwards; a material already classified is never overwritten.
    const { rowCount: componentsGuessed } = await pool.query(`
      UPDATE rm_materials SET mix_component = CASE
        WHEN name ILIKE '%cement%' OR name ILIKE 'opc%' OR name ILIKE 'ppc%' THEN 'cement'
        WHEN name ILIKE '%fly ash%' OR name ILIKE '%flyash%' THEN 'fly_ash'
        WHEN name ILIKE '%m-sand%' OR name ILIKE '%m sand%' OR name ILIKE '%msand%'
          OR name ILIKE '%fine agg%' OR name ILIKE '%river sand%' THEN 'fine_agg'
        WHEN name ILIKE '%20mm%' OR name ILIKE '%20 mm%' THEN 'coarse_20mm'
        WHEN name ILIKE '%12mm%' OR name ILIKE '%12 mm%' OR name ILIKE '%12.5%' THEN 'coarse_12_5mm'
        WHEN name ILIKE '%admixture%' OR name ILIKE '%plasticiz%' OR name ILIKE '%plasticis%'
          OR name ILIKE '%retarder%' OR name ILIKE 'pce%' THEN 'admixture'
      END
      WHERE mix_component IS NULL
        AND (name ILIKE '%cement%' OR name ILIKE 'opc%' OR name ILIKE 'ppc%'
             OR name ILIKE '%fly ash%' OR name ILIKE '%flyash%'
             OR name ILIKE '%m-sand%' OR name ILIKE '%m sand%' OR name ILIKE '%msand%'
             OR name ILIKE '%fine agg%' OR name ILIKE '%river sand%'
             OR name ILIKE '%20mm%' OR name ILIKE '%20 mm%'
             OR name ILIKE '%12mm%' OR name ILIKE '%12 mm%' OR name ILIKE '%12.5%'
             OR name ILIKE '%admixture%' OR name ILIKE '%plasticiz%' OR name ILIKE '%plasticis%'
             OR name ILIKE '%retarder%' OR name ILIKE 'pce%')
    `);
    // Round 143 — pinned screens for the icon-view Administrator dashboard.
    // Additive and empty by default: a user with no row simply gets the
    // dashboard's own default pins until they change them.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_dashboard_pins (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        screen_keys TEXT[] NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    log.push("Schema migration applied (Round 143 — user_dashboard_pins for the icon-view dashboard).");

    // Round 146 — the Super Admin permission system.
    // The enum value first: ADD VALUE cannot run inside a transaction block in
    // older Postgres and cannot be repeated, hence IF NOT EXISTS.
    await pool.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin'`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_default_permissions (
        role user_role NOT NULL,
        permission_key VARCHAR(80) NOT NULL,
        action VARCHAR(10) NOT NULL CHECK (action IN ('view', 'create', 'edit', 'delete')),
        PRIMARY KEY (role, permission_key, action)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_permission_overrides (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        permission_key VARCHAR(80) NOT NULL,
        action VARCHAR(10) NOT NULL CHECK (action IN ('view', 'create', 'edit', 'delete')),
        granted BOOLEAN NOT NULL,
        set_by INTEGER REFERENCES users(id),
        set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, permission_key, action)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permission_change_log (
        id SERIAL PRIMARY KEY,
        changed_by INTEGER REFERENCES users(id) NOT NULL,
        target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_role user_role,
        permission_key VARCHAR(80) NOT NULL,
        action VARCHAR(10) NOT NULL,
        granted BOOLEAN NOT NULL,
        previous_state VARCHAR(20) NOT NULL,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permission_change_log_at ON permission_change_log(changed_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permission_change_log_user ON permission_change_log(target_user_id)`);

    // Seed each role's defaults from the catalogue — ONLY where that role has
    // no rows at all. A role somebody has already tuned is never overwritten
    // by a later /setup run, which is what makes this safe to visit again.
    const seeded = [];
    for (const role of PERM_ROLES) {
      if (role === "super_admin" || role === "administrator") continue; // computed, never seeded
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM role_default_permissions WHERE role = $1 LIMIT 1`, [role]
      );
      if (existing.length) continue;
      const values = [];
      for (const c of PERM_CATALOGUE) {
        if (c.locked) continue;
        for (const a of (c.roles[role] || [])) values.push([role, c.key, a]);
      }
      if (!values.length) continue;
      await pool.query(
        `INSERT INTO role_default_permissions (role, permission_key, action)
         SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
         ON CONFLICT DO NOTHING`,
        [values.map((v) => v[0]), values.map((v) => v[1]), values.map((v) => v[2])]
      );
      seeded.push(`${role}:${values.length}`);
    }
    log.push(
      `Schema migration applied (Round 146 — super_admin role + permission tables). ` +
      (seeded.length ? `Seeded role defaults for ${seeded.join(", ")}.` : "Role defaults already present, left untouched.")
    );

    // Round 148 — repair the six view defaults Round 146 got wrong.
    //
    // The seeding loop above only runs for a role with NO rows, which is what
    // stops a later /setup trampling access somebody has tuned. That is right,
    // but it means a CORRECTION to the catalogue never reaches an installation
    // that has already been seeded — and Round 146 seeded Store and Plant
    // Operator without the master-data reads their own routes allow, so both
    // roles currently get a 403 on screens they are supposed to use (Materials,
    // Suppliers, Rates, Transporters; see permissionCatalogue.js).
    //
    // So these specific rows are inserted by name, additively, with ON CONFLICT
    // DO NOTHING. Nothing is removed and nothing else is touched. If somebody
    // has deliberately revoked one of these from a person, that lives in
    // user_permission_overrides and still wins — this only fixes the role's
    // baseline. And since requireRole and requirePermission must BOTH pass, a
    // row here can never grant access the role guard doesn't already allow.
    const REPAIR_148 = [
      ["store", "material.materials", "view"],
      ["store", "material.units", "view"],
      ["store", "material.suppliers", "view"],
      ["store", "material.supplier-rates", "view"],
      ["store", "material.transporters", "view"],
      ["plant_operator", "material.materials", "view"],
      ["plant_operator", "material.units", "view"],
      ["plant_operator", "material.physical-stock", "view"],
    ];
    const repaired = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
       ON CONFLICT DO NOTHING
       RETURNING role::text, permission_key`,
      [REPAIR_148.map((r) => r[0]), REPAIR_148.map((r) => r[1]), REPAIR_148.map((r) => r[2])]
    );
    log.push(
      repaired.rows.length
        ? `Schema migration applied (Round 148 — restored ${repaired.rows.length} master-data view default(s) Round 146 missed: ` +
          `${repaired.rows.map((r) => `${r.role}/${r.permission_key}`).join(", ")}).`
        : `Round 148 — master-data view defaults already correct, nothing to repair.`
    );

    // Round 149 — the Solitaire ("RMC Delivery Challan") plugin and the plugin
    // registry it switches off from. Purely additive: new tables only, nothing
    // existing is altered. Safe to re-run — every statement is IF NOT EXISTS
    // and the seeds are ON CONFLICT DO NOTHING.
    await pool.query(`
-- ============================================================================
-- PLUGINS (Round 149) — the on/off switch for optional modules.
--
-- A plugin is a whole module that can be turned off by a Super Admin without a
-- deploy. This is NOT the permission system: permissions decide what a PERSON
-- may do, a plugin decides whether the module exists for anyone at all. Off
-- means the API refuses every one of its routes and the icon disappears —
-- hiding the icon alone would be theatre.
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_plugins (
  key         VARCHAR(40) PRIMARY KEY,
  label       VARCHAR(80) NOT NULL,
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- SOLITAIRE MODULE (Round 149) — "RMC Delivery Challan" / Batching Docket.
--
-- Deliberately self-contained: its own accounts, its own device lock, its own
-- customers/sites/trucks/mix designs. It shares NOTHING with the main app's
-- users/customers/sites/trucks/mix_designs tables. The single link to the main
-- app is solitaire_accounts.granted_to_user_id, which is how a Super Admin
-- grants somebody access — see routes/solitaireAccess.js.
--
-- Every table is prefixed solitaire_ so the boundary is visible in the schema
-- itself, and so a future decision to drop the module is one DROP list.
-- ============================================================================
CREATE TABLE IF NOT EXISTS solitaire_accounts (
  id                 SERIAL PRIMARY KEY,
  username           VARCHAR(60) UNIQUE NOT NULL,
  password_hash      TEXT NOT NULL,
  role               VARCHAR(10) NOT NULL CHECK (role IN ('operator', 'qc', 'admin')),
  display_name       VARCHAR(120) NOT NULL,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  -- UNIQUE because routes/solitaireAccess.js grants with
  -- ON CONFLICT (granted_to_user_id), so one staff member has at most one
  -- Solitaire account and re-granting updates it in place.
  granted_to_user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  granted_by         INTEGER REFERENCES users(id),
  granted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by         INTEGER REFERENCES users(id),
  revoked_at         TIMESTAMPTZ
);

-- The device lock is company-wide, not per account: a browser is authorised or
-- it is not, whoever signs in from it.
CREATE TABLE IF NOT EXISTS solitaire_devices (
  id            SERIAL PRIMARY KEY,
  device_token  TEXT UNIQUE NOT NULL,
  label         VARCHAR(120),
  registered_by INTEGER REFERENCES solitaire_accounts(id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    INTEGER REFERENCES solitaire_accounts(id)
);

CREATE TABLE IF NOT EXISTS solitaire_settings (
  key        VARCHAR(40) PRIMARY KEY,
  value      TEXT,
  updated_by INTEGER REFERENCES solitaire_accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS solitaire_customers (
  id        SERIAL PRIMARY KEY,
  code      VARCHAR(40) NOT NULL,
  name      VARCHAR(160) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS solitaire_sites (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES solitaire_customers(id) ON DELETE CASCADE,
  name        VARCHAR(160) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS solitaire_trucks (
  id                  SERIAL PRIMARY KEY,
  registration_number VARCHAR(40) NOT NULL,
  truck_code          VARCHAR(40) NOT NULL,
  driver_name         VARCHAR(120),
  is_active           BOOLEAN NOT NULL DEFAULT true
);

-- Per-m3 ingredient quantities, matching the docket's own field names rather
-- than the main app's mix_designs columns — the two are not the same recipe
-- list and must not be conflated.
CREATE TABLE IF NOT EXISTS solitaire_mix_designs (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(40) NOT NULL,
  name          VARCHAR(120),
  msand_kgm3    NUMERIC(10,2) NOT NULL DEFAULT 0,
  agg_12mm_kgm3 NUMERIC(10,2) NOT NULL DEFAULT 0,
  agg_20mm_kgm3 NUMERIC(10,2) NOT NULL DEFAULT 0,
  cem1_kgm3     NUMERIC(10,2) NOT NULL DEFAULT 0,
  cem2_kgm3     NUMERIC(10,2) NOT NULL DEFAULT 0,
  cem3_kgm3     NUMERIC(10,2) NOT NULL DEFAULT 0,
  admix1_kgm3   NUMERIC(10,3) NOT NULL DEFAULT 0,
  admix2_kgm3   NUMERIC(10,3) NOT NULL DEFAULT 0,
  water_kgm3    NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true
);

-- batch_number is TEXT, not an integer: the next number is derived with
-- MAX(batch_number::int) over rows matching '^[0-9]+$', which keeps the door
-- open for a prefixed series later without a migration.
--
-- pdf_data holds the printed docket itself. is_placeholder_pdf marks every
-- docket printed through the interim jsPDF generator, so that once the real
-- Excel pipeline exists it is one query to find everything that predates it.
CREATE TABLE IF NOT EXISTS solitaire_dockets (
  id                 SERIAL PRIMARY KEY,
  batch_number       VARCHAR(40),
  order_date_time    TIMESTAMPTZ,
  order_qty_m3       NUMERIC(10,2),
  with_this_load_m3  NUMERIC(10,2),
  customer_id        INTEGER NOT NULL REFERENCES solitaire_customers(id),
  site_id            INTEGER NOT NULL REFERENCES solitaire_sites(id),
  mix_design_id      INTEGER NOT NULL REFERENCES solitaire_mix_designs(id),
  truck_id           INTEGER NOT NULL REFERENCES solitaire_trucks(id),
  driver_name        VARCHAR(120),
  production_qty_m3  NUMERIC(10,2) NOT NULL,
  mixer_capacity_m3  NUMERIC(10,2),
  moisture_pct       NUMERIC(6,2),
  sheet_number       INTEGER,
  pdf_filename       TEXT,
  pdf_data           BYTEA,
  is_placeholder_pdf BOOLEAN NOT NULL DEFAULT true,
  printed_by         INTEGER REFERENCES solitaire_accounts(id),
  printed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_solitaire_dockets_printed ON solitaire_dockets(printed_at DESC);
CREATE INDEX IF NOT EXISTS idx_solitaire_dockets_batch ON solitaire_dockets(batch_number);
`);

    // The plugin row. Created ENABLED so the module works the moment access is
    // granted — but note that enabling it shows the Plant Operator icon to
    // nobody until a Super Admin grants somebody an account, so this is not a
    // surprise exposure. ON CONFLICT DO NOTHING means a later /setup never
    // re-enables a plugin a Super Admin has deliberately switched off.
    const pluginSeed = await pool.query(
      `INSERT INTO app_plugins (key, label, is_enabled) VALUES ('solitaire', 'MixTrack', true)
       ON CONFLICT (key) DO NOTHING RETURNING key`
    );

    // Solitaire's own settings, same deal — the folder path and printer are
    // the Admin-only values from the module's Settings screen.
    await pool.query(
      `INSERT INTO solitaire_settings (key, value) VALUES
         ('max_devices', '2'),
         ('save_folder_path', ''),
         ('default_printer', '')
       ON CONFLICT (key) DO NOTHING`
    );

    log.push(
      `Schema migration applied (Round 149 — Solitaire delivery-challan plugin: 8 solitaire_* tables + app_plugins). ` +
      (pluginSeed.rows.length
        ? `Plugin registered and ENABLED; grant somebody access from the Super Admin screen to make its icon appear.`
        : `Plugin already registered — its on/off state was left exactly as the Super Admin set it.`)
    );

    // NOTE ON ORDER: this block MUST stay below the Round 149 one. schema.sql
    // is only loaded on a brand-new install (see the top of this route), so on
    // an existing database these migration blocks are the only thing that
    // creates these tables — and solitaire_pairing_codes has a foreign key to
    // solitaire_devices. Written above Round 149 first time round, it passed
    // every fresh-database test (schema.sql had already made both tables) and
    // would have failed on the live database on the first visit. Same trap as
    // Round 143's KPIs: agreeing with yourself is not verification.
    // Round 150 — device pairing codes, and the device limit raised to 3.
    await pool.query(`
-- ============================================================================
-- SOLITAIRE DEVICE PAIRING CODES (Round 150)
--
-- Fixes a real defect found after Round 149 shipped. A brand-new machine could
-- never authorise itself: POST /devices registers the browser MAKING the call
-- and needs a signed-in session, but signing in needs an already-authorised
-- browser. Only the zero-devices bootstrap worked, so the module supported
-- exactly ONE browser however high max_devices was set.
--
-- A pairing code breaks that circle. An Admin on an authorised browser mints a
-- short code; the new machine types it once at login and registers itself.
-- Single use, short-lived, and still subject to max_devices.
-- ============================================================================
CREATE TABLE IF NOT EXISTS solitaire_pairing_codes (
  id             SERIAL PRIMARY KEY,
  code           VARCHAR(12) UNIQUE NOT NULL,
  label          VARCHAR(120),
  created_by     INTEGER REFERENCES solitaire_accounts(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  used_device_id INTEGER REFERENCES solitaire_devices(id)
);
CREATE INDEX IF NOT EXISTS idx_solitaire_pairing_open
  ON solitaire_pairing_codes(code) WHERE used_at IS NULL;
`);

    // max_devices 2 -> 3 (plant, lab, office). Only bumps an install still
    // sitting on the old default: a number the user has deliberately chosen is
    // left alone, same principle as never re-enabling a disabled plugin.
    const bumped = await pool.query(
      `UPDATE solitaire_settings SET value = '3', updated_at = now()
        WHERE key = 'max_devices' AND value = '2' RETURNING value`
    );
    await pool.query(
      `INSERT INTO solitaire_settings (key, value) VALUES ('max_devices', '3') ON CONFLICT (key) DO NOTHING`
    );
    log.push(
      `Schema migration applied (Round 150 — device pairing codes). ` +
      (bumped.rows.length
        ? `Device limit raised 2 -> 3.`
        : `Device limit left as configured.`)
    );


    // Round 152 — the delivery-challan module shares the main app's master
    // data, and its mix designs widen to match the workbook. Purely additive
    // columns plus one guarded re-pointing of foreign keys; safe to re-run.
    await pool.query(`-- ============================================================================
-- ROUND 152 — the Delivery Challan module stops keeping its own copies of the
-- customer, site, truck and driver lists and reads the main app's instead.
--
-- Round 139's design deliberately shared nothing with the main app, which was
-- right when this was a standalone package. As a plugin inside the app it only
-- means entering every customer and site twice and watching the two drift.
--
-- Two optional columns on the MAIN tables carry the fields the MCI370 screen
-- shows and the main app never had: a customer code, and a short truck id.
-- Both are nullable and unique-when-set, so nothing existing is disturbed.
-- ============================================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS code VARCHAR(40);
ALTER TABLE trucks    ADD COLUMN IF NOT EXISTS truck_code VARCHAR(40);

-- UNIQUE via an index rather than a constraint so IF NOT EXISTS works, and
-- partial so the many rows with no code yet do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_code
  ON customers(code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trucks_truck_code
  ON trucks(truck_code) WHERE truck_code IS NOT NULL;

-- A docket now records who drove, from the main app's own driver accounts.
-- The workbook derives the driver from the truck by lookup, one fixed driver
-- per vehicle; the main app knows drivers change trip to trip, so this is
-- stored per docket and the workbook's lookup is fed from it.
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS driver_user_id INTEGER REFERENCES users(id);

-- Re-point the docket's customer / site / truck at the main app's tables.
--
-- Guarded on the table being EMPTY. No docket has ever been printed (the
-- module's menus were unreachable until Round 151), so this is free today and
-- would be a data migration in a month. If rows ever do exist, this block
-- simply does nothing rather than breaking referential integrity — the /setup
-- output says so, and a real migration would be written then.
DO $$
BEGIN
  IF (SELECT count(*) FROM solitaire_dockets) = 0
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'solitaire_dockets_customer_main_fkey') THEN

    ALTER TABLE solitaire_dockets DROP CONSTRAINT IF EXISTS solitaire_dockets_customer_id_fkey;
    ALTER TABLE solitaire_dockets DROP CONSTRAINT IF EXISTS solitaire_dockets_site_id_fkey;
    ALTER TABLE solitaire_dockets DROP CONSTRAINT IF EXISTS solitaire_dockets_truck_id_fkey;

    ALTER TABLE solitaire_dockets
      ADD CONSTRAINT solitaire_dockets_customer_main_fkey FOREIGN KEY (customer_id) REFERENCES customers(id),
      ADD CONSTRAINT solitaire_dockets_site_main_fkey     FOREIGN KEY (site_id)     REFERENCES sites(id),
      ADD CONSTRAINT solitaire_dockets_truck_main_fkey    FOREIGN KEY (truck_id)    REFERENCES trucks(id);
  END IF;
END $$;

-- ============================================================================
-- ROUND 152 — mix designs widened to match the workbook's own Mix Design sheet.
--
-- The module stored the ten quantity fields only. The sheet also carries four
-- absorption percentages, four moisture percentages and the water variance
-- band — so QC editing here was editing a subset while the workbook printed
-- stale values for the rest. Bulk upload would have silently dropped them too.
-- Column names mirror the sheet's own headers rather than inventing new ones.
-- ============================================================================
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS msand2_kgm3   NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS absorb_msand_pct   NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS absorb_msand2_pct  NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS absorb_12mm_pct    NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS absorb_20mm_pct    NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS moisture_msand_pct  NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS moisture_msand2_pct NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS moisture_12mm_pct   NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS moisture_20mm_pct   NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS water_var_min_pct NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE solitaire_mix_designs ADD COLUMN IF NOT EXISTS water_var_max_pct NUMERIC(6,2) NOT NULL DEFAULT 0;

-- The recipe code is what the workbook looks up on, so a bulk upload must be
-- able to update a recipe in place rather than duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_solitaire_mix_designs_code ON solitaire_mix_designs(code);
`);

    const { rows: docketCount } = await pool.query(`SELECT count(*)::int AS n FROM solitaire_dockets`);
    const { rows: repointed } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'solitaire_dockets_customer_main_fkey'`
    );
    log.push(
      `Schema migration applied (Round 152 — shared master data + wider mix designs). ` +
      (repointed.length
        ? `Dockets now reference the main app's customers, sites and trucks.`
        : `Dockets still reference the module's own tables — ${docketCount[0].n} docket(s) already exist, so the re-point was skipped and needs a data migration.`)
    );

    // ========================================================================
    // ROUND 157 — MCI370 batching plant: production and consumption.
    //
    // Additive and re-runnable. Built from the real MCI370 Access schema read
    // out of the installer's own .mdb — see schema.sql's Round 157 block for
    // why a load is several mixes and why NameSetUp matters.
    // ========================================================================
    await pool.query(`
CREATE TABLE IF NOT EXISTS plant_batches (
  id SERIAL PRIMARY KEY,
  plant_no      VARCHAR(50) NOT NULL DEFAULT '1',
  batch_year    INTEGER NOT NULL,
  batch_no      BIGINT NOT NULL,
  batch_index   INTEGER NOT NULL DEFAULT 1,
  batched_at    TIMESTAMPTZ,
  batch_date    DATE,
  recipe_code   VARCHAR(50),
  recipe_name   VARCHAR(100),
  strength      INTEGER,
  consistency   INTEGER,
  customer_code VARCHAR(100),
  site_name     VARCHAR(175),
  truck_no      VARCHAR(50),
  truck_driver  VARCHAR(50),
  order_no      VARCHAR(50),
  batcher_name  VARCHAR(100),
  production_qty_m3 NUMERIC(10,3),
  ordered_qty_m3    NUMERIC(10,3),
  returned_qty_m3   NUMERIC(10,3),
  with_this_load_m3 NUMERIC(10,3),
  batch_size_m3     NUMERIC(10,3),
  mixer_capacity_m3 NUMERIC(10,3),
  mixing_time_s     NUMERIC(10,2),
  weighed_net_weight_kg NUMERIC(12,2),
  weighbridge_stat      VARCHAR(1),
  source_hash     CHAR(64) NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plant_no, batch_year, batch_no, batch_index)
);
CREATE INDEX IF NOT EXISTS idx_plant_batches_date   ON plant_batches(batch_date DESC);
CREATE INDEX IF NOT EXISTS idx_plant_batches_at     ON plant_batches(batched_at DESC);
CREATE INDEX IF NOT EXISTS idx_plant_batches_recipe ON plant_batches(recipe_code);

CREATE TABLE IF NOT EXISTS plant_batch_materials (
  id           SERIAL PRIMARY KEY,
  batch_id     INTEGER NOT NULL REFERENCES plant_batches(id) ON DELETE CASCADE,
  slot         VARCHAR(20) NOT NULL,
  slot_name    VARCHAR(60),
  actual_kg    NUMERIC(12,3),
  target_kg    NUMERIC(12,3),
  moisture_pct NUMERIC(6,2),
  correction   NUMERIC(10,3),
  material_id  INTEGER REFERENCES rm_materials(id),
  UNIQUE (batch_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_plant_batch_materials_batch    ON plant_batch_materials(batch_id);
CREATE INDEX IF NOT EXISTS idx_plant_batch_materials_material ON plant_batch_materials(material_id);
CREATE INDEX IF NOT EXISTS idx_plant_batch_materials_slotname ON plant_batch_materials(slot_name);

CREATE TABLE IF NOT EXISTS plant_silo_aliases (
  id          SERIAL PRIMARY KEY,
  normalised  VARCHAR(60) NOT NULL UNIQUE,
  raw_sample  VARCHAR(60) NOT NULL,
  material_id INTEGER REFERENCES rm_materials(id),
  is_ignored  BOOLEAN NOT NULL DEFAULT false,
  mapped_by   INTEGER REFERENCES users(id),
  mapped_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_ignored OR material_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS plant_recipe_aliases (
  id            SERIAL PRIMARY KEY,
  normalised    VARCHAR(60) NOT NULL UNIQUE,
  raw_sample    VARCHAR(100) NOT NULL,
  mix_grade_id  INTEGER REFERENCES mix_grades(id),
  is_ignored    BOOLEAN NOT NULL DEFAULT false,
  mapped_by     INTEGER REFERENCES users(id),
  mapped_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_ignored OR mix_grade_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS plant_sync_log (
  id             SERIAL PRIMARY KEY,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_version  VARCHAR(20),
  rows_sent      INTEGER NOT NULL DEFAULT 0,
  rows_inserted  INTEGER NOT NULL DEFAULT 0,
  rows_updated   INTEGER NOT NULL DEFAULT 0,
  rows_unchanged INTEGER NOT NULL DEFAULT 0,
  rows_rejected  INTEGER NOT NULL DEFAULT 0,
  highest_batch  BIGINT,
  batch_year     INTEGER,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_plant_sync_log_received ON plant_sync_log(received_at DESC);
`);

    const { rows: pbCount } = await pool.query(`SELECT count(*)::int AS n FROM plant_batches`);
    log.push(
      `Schema migration applied (Round 157 — MCI370 production and consumption). ` +
      `plant_batches holds ${pbCount[0].n} mix(es). ` +
      (process.env.PLANT_API_KEY
        ? `PLANT_API_KEY is set, so the MCI370 agent can post to /api/plant/sync.`
        : `PLANT_API_KEY is NOT set — /api/plant/sync will reject every call until it is. ` +
          `Set it in the backend environment and give the same value to the agent on the plant PC.`)
    );

    // Round 157 — the two new plant permission keys. Same mechanism and reason
    // as REPAIR_148/153/154: the seeding loop only fires for a role with NO
    // rows, so a brand new catalogue KEY never reaches a live installation.
    // Without this the Plant Production tile would appear and then 403.
    //
    // production.plant-mapping is deliberately absent — Administrator alone,
    // computed rather than seeded.
    const REPAIR_157 = [
      ["manager", "production.plant-data", "view"],
      ["store", "production.plant-data", "view"],
      ["plant_operator", "production.plant-data", "view"],
      ["qc_engineer", "production.plant-data", "view"],
      ["lab_technician", "production.plant-data", "view"],
    ];
    const plantRepaired = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
       ON CONFLICT DO NOTHING
       RETURNING role::text`,
      [REPAIR_157.map((r) => r[0]), REPAIR_157.map((r) => r[1]), REPAIR_157.map((r) => r[2])]
    );
    log.push(
      plantRepaired.rows.length
        ? `Schema migration applied (Round 157 — plant production access granted to ` +
          `${plantRepaired.rows.map((r) => r.role).join(", ")}). Super Admin can revoke any of it.`
        : `Round 157 — plant production access defaults already in place, nothing to repair.`
    );


    // ========================================================================
    // ROUND 156 — supplier-scoped material mappings, and the vehicle registry.
    //
    // Additive and re-runnable. The two constraint drops are IF EXISTS, the
    // table and columns are IF NOT EXISTS, and the back-fill at the end only
    // touches rows that have no vehicle yet.
    //
    // See schema.sql's Round 156 block for why each of these exists — in
    // short, the first week of live weighbridge data showed that one
    // weighbridge name can mean several materials depending on the supplier,
    // and that forcing a supplier's lorry to "ignored" threw away the vehicle
    // on nearly every ticket.
    // ========================================================================
    await pool.query(`
ALTER TABLE weighbridge_material_aliases ADD COLUMN IF NOT EXISTS supplier_scope_id INTEGER REFERENCES rm_suppliers(id);
ALTER TABLE weighbridge_material_aliases DROP CONSTRAINT IF EXISTS weighbridge_material_aliases_normalised_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_mat_alias_unscoped ON weighbridge_material_aliases(normalised) WHERE supplier_scope_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_mat_alias_scoped   ON weighbridge_material_aliases(normalised, supplier_scope_id) WHERE supplier_scope_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS weighbridge_vehicles (
  id            SERIAL PRIMARY KEY,
  normalised    VARCHAR(60) NOT NULL UNIQUE,
  registration  VARCHAR(60) NOT NULL,
  truck_id      INTEGER REFERENCES trucks(id),
  supplier_id   INTEGER REFERENCES rm_suppliers(id),
  is_junk       BOOLEAN NOT NULL DEFAULT false,
  notes         TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INTEGER REFERENCES users(id),
  CHECK (truck_id IS NULL OR supplier_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_wb_vehicles_truck    ON weighbridge_vehicles(truck_id)    WHERE truck_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wb_vehicles_supplier ON weighbridge_vehicles(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wb_vehicles_lastseen ON weighbridge_vehicles(last_seen_at DESC);

ALTER TABLE weighbridge_tickets ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES weighbridge_vehicles(id);
CREATE INDEX IF NOT EXISTS idx_wb_tickets_vehicle ON weighbridge_tickets(vehicle_id);

ALTER TABLE weighbridge_vehicle_aliases ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES weighbridge_vehicles(id);
ALTER TABLE weighbridge_vehicle_aliases DROP CONSTRAINT IF EXISTS weighbridge_vehicle_aliases_check;

ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS short_reason TEXT;

-- ROUND 158 — receipts always save; a real disagreement waits on a Manager.
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS accepted_basis VARCHAR(12) NOT NULL DEFAULT 'weighed';
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS variance_qty NUMERIC(12,2);
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS variance_pct NUMERIC(8,3);
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS confirmation_status VARCHAR(12) NOT NULL DEFAULT 'auto';
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS confirmed_by INTEGER REFERENCES users(id);
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS confirm_note TEXT;
CREATE INDEX IF NOT EXISTS idx_rm_receipts_pending ON rm_receipts(confirmation_status)
  WHERE confirmation_status = 'pending';

-- Every existing receipt was saved under the old rules, which means somebody
-- already accepted its quantity — nothing historical should land in the queue
-- and start demanding decisions about lorries that left months ago.
CREATE OR REPLACE VIEW rm_receipts_effective AS
  SELECT * FROM rm_receipts WHERE confirmation_status <> 'pending';
`);

    // ========================================================================
    // ROUND 159 — the plant, corrected against its own real data.
    //
    // Round 157 was designed against the installer's BLANK template, which is
    // the only thing that was available. The live database showed two of its
    // assumptions to be wrong, and one of them was serious.
    // ========================================================================
    await pool.query(`
-- The quantity columns are renamed rather than added to, because the old name
-- IS the bug: anybody who sums production_qty_m3 gets a figure 4.6x too high.
-- Renaming is safe here: the plant agent has never been deployed, so these
-- tables are empty on every installation. The guards make it re-runnable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'plant_batches' AND column_name = 'production_qty_m3') THEN
    ALTER TABLE plant_batches RENAME COLUMN production_qty_m3 TO cumulative_qty_m3;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'plant_batches' AND column_name = 'batch_size_m3') THEN
    ALTER TABLE plant_batches RENAME COLUMN batch_size_m3 TO batch_qty_m3;
  END IF;
END $$;

ALTER TABLE plant_batches ADD COLUMN IF NOT EXISTS batch_qty_m3      NUMERIC(10,3);
ALTER TABLE plant_batches ADD COLUMN IF NOT EXISTS load_qty_m3       NUMERIC(10,3);
ALTER TABLE plant_batches ADD COLUMN IF NOT EXISTS cumulative_qty_m3 NUMERIC(10,3);
ALTER TABLE plant_batches ADD COLUMN IF NOT EXISTS load_started_at   TIMESTAMPTZ;
ALTER TABLE plant_batches ADD COLUMN IF NOT EXISTS load_ended_at     TIMESTAMPTZ;

-- The recipe's own per-m³ figure, so design / target / actual can all be shown.
ALTER TABLE plant_batch_materials ADD COLUMN IF NOT EXISTS design_kg_per_m3 NUMERIC(12,3);

-- Silo mappings move from being keyed on the hopper's NAME to being keyed on
-- the hopper itself. Their plant calls Gate1 and Gate2 both "M SAND", which a
-- name-keyed alias cannot tell apart.
ALTER TABLE plant_silo_aliases ADD COLUMN IF NOT EXISTS slot          VARCHAR(20);
ALTER TABLE plant_silo_aliases ADD COLUMN IF NOT EXISTS is_refillable BOOLEAN NOT NULL DEFAULT false;
-- Carry old name-keyed mappings over to the slot key, but only where that old
-- column still exists: a database built fresh from schema.sql never had it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'plant_silo_aliases' AND column_name = 'normalised') THEN
    EXECUTE 'UPDATE plant_silo_aliases SET slot = normalised WHERE slot IS NULL';
  END IF;
END $$;
DELETE FROM plant_silo_aliases a USING plant_silo_aliases b
 WHERE a.id > b.id AND a.slot = b.slot;
DELETE FROM plant_silo_aliases WHERE slot IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plant_silo_aliases_slot ON plant_silo_aliases(slot);

CREATE TABLE IF NOT EXISTS plant_silo_fills (
  id SERIAL PRIMARY KEY,
  slot        VARCHAR(20) NOT NULL,
  material_id INTEGER NOT NULL REFERENCES rm_materials(id),
  receipt_id  INTEGER REFERENCES rm_receipts(id) ON DELETE SET NULL,
  filled_at   TIMESTAMPTZ NOT NULL,
  qty_kg      NUMERIC(14,2) NOT NULL,
  was_empty         BOOLEAN,
  balance_before_kg NUMERIC(14,2),
  notes       TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (qty_kg > 0)
);
CREATE INDEX IF NOT EXISTS idx_plant_silo_fills_slot_time ON plant_silo_fills(slot, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_plant_silo_fills_receipt   ON plant_silo_fills(receipt_id);
CREATE INDEX IF NOT EXISTS idx_plant_silo_fills_material  ON plant_silo_fills(material_id);

CREATE TABLE IF NOT EXISTS plant_manual_entries (
  id SERIAL PRIMARY KEY,
  entry_date  DATE NOT NULL,
  material_id INTEGER REFERENCES rm_materials(id),
  qty_kg      NUMERIC(14,2),
  qty_m3      NUMERIC(12,3),
  reason      TEXT,
  entered_by  INTEGER NOT NULL REFERENCES users(id),
  entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_date, material_id),
  CHECK ((material_id IS NOT NULL AND qty_kg IS NOT NULL AND qty_m3 IS NULL)
      OR (material_id IS NULL     AND qty_m3 IS NOT NULL AND qty_kg IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_plant_manual_date ON plant_manual_entries(entry_date DESC);

-- The receipt says which silo it filled, so the fill can be created from it.
ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS silo_slot VARCHAR(20);

-- ROUND 159 — Solitaire is called MixTrack now. The plugin row is created once
-- on first setup, so an installation that already has it keeps the old label
-- forever unless it is updated here. The KEY stays 'solitaire': it is internal,
-- nothing shows it to anybody, and changing it would break every existing
-- permission grant for no gain.
UPDATE app_plugins SET label = 'MixTrack'
 WHERE key = 'solitaire' AND label <> 'MixTrack';
`);
    log.push(
      "Schema migration applied (Round 159 — plant quantities renamed so the cumulative figure " +
      "cannot be summed by accident, recipe design values, real load start/end times, silo fill " +
      "history and manual entries)."
    );

    // ========================================================================
    // ROUND 160 — the ticket workbook lost three lookups, so we store three
    // more fields.
    //
    // M32 (Recipe Name), AZ32 (Driver Name) and AZ34 (Order No) were formulas
    // BPR107a.xlsm worked out for itself. The user removed them; MixTrack
    // writes all three now. A lookup needs nothing stored, a written value
    // does.
    //
    // Both removed lookups were already failing on real data, which is the
    // part worth recording: AZ32 looked the driver up against an 11-row table
    // while the plant has run 17 trucks and 28 drivers, returning #N/A on most
    // loads; M32 looked the recipe name up from the code, and Recipe_Code and
    // Recipe_Name are different strings on 210 of 2,495 real loads.
    // ========================================================================
    await pool.query(`
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS order_no           VARCHAR(100);
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS recipe_name        VARCHAR(120);
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS batch_started_at   TIMESTAMPTZ;
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS batch_ended_at     TIMESTAMPTZ;
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS qc_delay_minutes   INTEGER NOT NULL DEFAULT 0;

-- The QC allowance, per customer or per site. Site wins over customer when
-- both are set: the delay belongs to the pour, not to who is paying for it.
CREATE TABLE IF NOT EXISTS mixtrack_qc_delays (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  site_id       INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0 AND delay_minutes <= 240),
  note          TEXT,
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mixtrack_qc_delay_site
  ON mixtrack_qc_delays(site_id) WHERE site_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mixtrack_qc_delay_customer
  ON mixtrack_qc_delays(customer_id) WHERE site_id IS NULL AND customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mixtrack_qc_delay_default
  ON mixtrack_qc_delays((true)) WHERE site_id IS NULL AND customer_id IS NULL;

-- order_no, recipe_name and truck_driver already exist on plant_batches and
-- the agent already sends all three; Round 157 stored them without yet having
-- a use for them. Only the index is new.
--
-- Order_No is the key to map customers on, NOT Customer_Code: it resolves into
-- MCI370's Order_Master on 2,492 of 2,492 real loads, while Customer_Code
-- fails against Customer_Master on 1,911 of 2,485.
CREATE INDEX IF NOT EXISTS idx_plant_batches_order_no ON plant_batches(order_no);
`);
    log.push(
      "Schema migration applied (Round 160 — the ticket's recipe name, driver and order number " +
      "are stored rather than looked up, batch start/end times with a per-site QC allowance, and " +
      "the plant's order number as the customer key)."
    );

    // ========================================================================
    // ROUND 158 — back-fill the variance on receipts already taken.
    //
    // The variance report is only worth opening if it has history behind it —
    // a supplier consistently billing more than they deliver is a pattern over
    // months, not something visible in next week's loads. Every past receipt
    // already holds both figures, so the variance can simply be computed.
    //
    // Only rows where it has not been computed yet, so re-running /setup is
    // free. Nothing is moved into the queue: these were all accepted under the
    // old rules by somebody who was there at the time, and dragging lorries
    // from months ago into a Manager's queue would be absurd.
    // ========================================================================
    const varianceFilled = await pool.query(
      `UPDATE rm_receipts
          SET variance_qty = supplier_qty - accepted_qty,
              variance_pct = CASE WHEN supplier_qty > 0
                                  THEN round(((supplier_qty - accepted_qty) / supplier_qty * 100)::numeric, 3)
                                  ELSE NULL END
        WHERE variance_qty IS NULL
        RETURNING id`
    );
    log.push(
      varianceFilled.rows.length
        ? `Schema migration applied (Round 158 — variance computed on ${varianceFilled.rows.length} existing receipt(s)). ` +
          `All of them stay accepted as recorded; none were moved into the confirmation queue.`
        : `Round 158 — receipt variance already computed, nothing to back-fill.`
    );

    // material.receipt-confirm is a brand new catalogue KEY, and the seeding
    // loop only runs for a role with NO rows at all — so on a live database
    // Manager would get the screen and then 403 on it. Same repair as 148,
    // 153, 154, 155 and 157.
    const REPAIR_158 = [
      ["manager", "material.receipt-confirm", "view"],
      ["manager", "material.receipt-confirm", "edit"],
    ];
    const confirmRepaired = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
       ON CONFLICT DO NOTHING
       RETURNING role::text`,
      [REPAIR_158.map((r) => r[0]), REPAIR_158.map((r) => r[1]), REPAIR_158.map((r) => r[2])]
    );
    log.push(
      confirmRepaired.rows.length
        ? `Schema migration applied (Round 158 — Manager can now confirm a disputed receipt quantity). ` +
          `Administrator already could. Super Admin can revoke it.`
        : `Round 158 — receipt confirmation access already in place, nothing to repair.`
    );

    // Round 159 — production.plant-manual is a new key, so the seeding loop
    // (which only runs for a role with no rows at all) never reaches it.
    const REPAIR_159 = [
      ["plant_operator", "production.plant-manual", "view"],
      ["plant_operator", "production.plant-manual", "create"],
      ["plant_operator", "production.plant-manual", "edit"],
    ];
    const manualRepaired = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
       ON CONFLICT DO NOTHING RETURNING role::text`,
      [REPAIR_159.map((r) => r[0]), REPAIR_159.map((r) => r[1]), REPAIR_159.map((r) => r[2])]
    );
    log.push(
      manualRepaired.rows.length
        ? `Schema migration applied (Round 159 — the Plant Operator can now enter the consumption and production the plant did not record).`
        : `Round 159 — plant manual-entry access already in place, nothing to repair.`
    );

    // ========================================================================
    // ROUND 161 — MixTrack makes the ticket.
    //
    // The recipe map exists because MCI370 and the workbook's Mix Design sheet
    // spell the same recipe differently and always will: the plant writes
    // 'M25A', the sheet has 'M 25 A'. Over 2,495 real loads the plant's code
    // matches a sheet row EXACTLY — which is what VLOOKUP(..., FALSE) needs —
    // on 2 loads. It is a human mapping rather than normalise-and-hope, for
    // the same reason the weighbridge's aliases are: 'M25A' is one edit from
    // 'M35A', and a wrong auto-match prints the wrong mix for a customer.
    // ========================================================================
    await pool.query(`
CREATE TABLE IF NOT EXISTS mixtrack_recipe_map (
  id            SERIAL PRIMARY KEY,
  mci370_code   VARCHAR(50) NOT NULL UNIQUE,
  mix_design_id INTEGER NOT NULL REFERENCES solitaire_mix_designs(id) ON DELETE RESTRICT,
  mapped_by     INTEGER REFERENCES solitaire_accounts(id),
  mapped_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT
);

CREATE TABLE IF NOT EXISTS mixtrack_mix_design_log (
  id            SERIAL PRIMARY KEY,
  mix_design_id INTEGER NOT NULL REFERENCES solitaire_mix_designs(id) ON DELETE CASCADE,
  action        VARCHAR(12) NOT NULL CHECK (action IN ('create', 'update', 'deactivate', 'seed')),
  before_json   JSONB,
  after_json    JSONB,
  changed_by    INTEGER REFERENCES solitaire_accounts(id),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_mixtrack_mix_log ON mixtrack_mix_design_log(mix_design_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS mixtrack_print_jobs (
  id            SERIAL PRIMARY KEY,
  docket_id     INTEGER NOT NULL REFERENCES solitaire_dockets(id) ON DELETE CASCADE,
  status        VARCHAR(12) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
  payload_json  JSONB NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,
  pdf_filename  TEXT,
  agent_version VARCHAR(20),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mixtrack_jobs_pending ON mixtrack_print_jobs(created_at)
  WHERE status IN ('pending', 'claimed');

-- Types MATCH plant_batches exactly: plant_no is VARCHAR there (MCI370 can be
-- networked across plants and the value is theirs, not ours) and batch_no is
-- BIGINT. A mismatched type here would make the join silently cast on every
-- lookup, and would eventually refuse a value plant_batches accepts.
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS plant_no         VARCHAR(50);
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS plant_batch_no   BIGINT;
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS plant_batch_year INTEGER;
-- MCI370's OWN recipe code, which is what the ticket PRINTS (M29 -> J14 on
-- every numbered sheet). lookup_code beside it is the workbook's spelling and
-- is what the VLOOKUP uses (H45). Keeping only one of them was a real bug
-- caught in verification: the payload printed the workbook's code where the
-- plant's belonged, which is exactly what splitting H45 from M29 was for.
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS recipe_code      VARCHAR(50);
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS lookup_code      VARCHAR(50);
ALTER TABLE solitaire_dockets ADD COLUMN IF NOT EXISTS pdf_purged_at    TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_docket_plant_load
  ON solitaire_dockets(plant_no, plant_batch_year, plant_batch_no)
  WHERE plant_batch_no IS NOT NULL;

-- Two months, the user's decision. The docket ROW is kept forever (~1 KB, so
-- the whole history is ~1.5 MB a year here); only pdf_data is purged, because
-- at ~200 KB a ticket and ~1,500 loads a year that is ~290 MB a year and fills
-- a 1 GB database in three. Every PDF also lives on the plant PC, and past the
-- window the search window reprints it from there.
INSERT INTO solitaire_settings (key, value)
VALUES ('pdf_retention_months', '2')
ON CONFLICT (key) DO NOTHING;
`);
    log.push(
      "Schema migration applied (Round 161 — the recipe map, QC's mix-design edit history, the " +
      "print queue, and a two-month PDF retention window)."
    );

    // Round 160 — production.mixtrack-qc-delay is a new key, and the seeding
    // loop only runs for a role with no rows at all, so it would never be
    // reached on an installation that already has permissions.
    const REPAIR_160 = [
      ["manager", "production.mixtrack-qc-delay", "view"],
    ];
    const qcDelayRepaired = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
       ON CONFLICT DO NOTHING RETURNING role::text`,
      [REPAIR_160.map((r) => r[0]), REPAIR_160.map((r) => r[1]), REPAIR_160.map((r) => r[2])]
    );
    log.push(
      qcDelayRepaired.rows.length
        ? `Schema migration applied (Round 160 — a Manager can now see the QC delay allowance that moves the ticket's finish time). Administrator can change it.`
        : `Round 160 — QC delay allowance access already in place, nothing to repair.`
    );

    // Register every vehicle already sitting in the synced tickets, so the
    // registry arrives populated rather than empty. One row per distinct
    // normalised registration, carrying the first spelling seen and the real
    // first/last dates — a month of history rather than a blank page.
    //
    // The blank-name list matches lib/weighbridgeNames.js's own, because the
    // weighbridge has no concept of an empty field: "the operator left it
    // blank" arrives as the literal text N/A, NONE or NIL, and none of those
    // is a lorry.
    const vehBackfill = await pool.query(
      `WITH seen AS (
         SELECT upper(regexp_replace(raw_vehicle, '[^A-Za-z0-9]', '', 'g')) AS norm,
                (array_agg(raw_vehicle ORDER BY weighed_at DESC NULLS LAST))[1] AS sample,
                min(weighed_at) AS first_at, max(weighed_at) AS last_at
         FROM weighbridge_tickets
         WHERE raw_vehicle IS NOT NULL
         GROUP BY 1
       )
       INSERT INTO weighbridge_vehicles (normalised, registration, first_seen_at, last_seen_at)
       SELECT norm, sample, COALESCE(first_at, now()), COALESCE(last_at, now())
       FROM seen
       WHERE norm <> '' AND norm NOT IN ('NA','NONE','NIL','NULL','N','0','TEST','XXX','ABC')
       ON CONFLICT (normalised) DO NOTHING
       RETURNING id`
    );

    // Point the tickets at their vehicle, and carry over any Round 155 mapping
    // that already said "this spelling is one of our trucks" so that work is
    // not lost.
    await pool.query(
      `UPDATE weighbridge_vehicles v
          SET truck_id = a.truck_id
         FROM weighbridge_vehicle_aliases a
        WHERE a.normalised = v.normalised AND a.truck_id IS NOT NULL AND v.truck_id IS NULL
          AND v.supplier_id IS NULL`
    );
    const vehLinked = await pool.query(
      `UPDATE weighbridge_tickets t
          SET vehicle_id = v.id
         FROM weighbridge_vehicles v
        WHERE v.normalised = upper(regexp_replace(t.raw_vehicle, '[^A-Za-z0-9]', '', 'g'))
          AND t.vehicle_id IS NULL
        RETURNING t.ticket_number`
    );

    log.push(
      `Schema migration applied (Round 156 — supplier-scoped material mappings + vehicle registry). ` +
      `Registered ${vehBackfill.rows.length} vehicle(s) from tickets already synced and linked ` +
      `${vehLinked.rows.length} ticket(s) to them. A lorry nobody has seen before now registers itself ` +
      `on arrival, so no weighment waits on a vehicle being known in advance.`
    );

    // ========================================================================
    // ROUND 155 — recover the cube batches the lab could not see.
    //
    // The QC form's cube-count box defaulted to 0 (Ver. 9.29 set it that way to
    // stop the previous default of 3 creating phantom batches). Lab Technician's
    // queue is `WHERE COALESCE(number_of_cubes, 0) > 0`, so any QC submission
    // where the engineer filled in the sample IDs but left that box alone saved
    // fine and then vanished from the lab entirely. The lab reported it from
    // 21 September; it was reproduced exactly on a clean database.
    //
    // Round 155 makes the field required so no new row can be written this way.
    // This repairs the rows already written. A row that lists sample IDs is
    // unambiguous evidence that cubes were physically cast — the count is
    // simply how many IDs were listed.
    //
    // Deliberately NARROW. Only rows with a non-empty sample_ids are touched.
    // A row with 0 cubes and no sample IDs means exactly what it says — no
    // cubes were cast — and inventing a count for it would recreate the Ver.
    // 9.29 phantom-batch bug from the other direction.
    const cubeBackfill = await pool.query(
      `UPDATE plant_qc
          SET number_of_cubes = cardinality(
                array_remove(string_to_array(regexp_replace(sample_ids, '\\s', '', 'g'), ','), '')
              )
        WHERE COALESCE(number_of_cubes, 0) = 0
          AND sample_ids IS NOT NULL
          AND btrim(sample_ids) <> ''
          AND cardinality(
                array_remove(string_to_array(regexp_replace(sample_ids, '\\s', '', 'g'), ','), '')
              ) > 0
        RETURNING ticket_id, number_of_cubes`
    );
    log.push(
      cubeBackfill.rows.length
        ? `Schema migration applied (Round 155 — recovered ${cubeBackfill.rows.length} cube batch(es) that ` +
          `were recorded with sample IDs but a zero cube count, so the Lab Technician could not see them. ` +
          `Ticket(s): ${cubeBackfill.rows.map((r) => r.ticket_id).join(", ")}. ` +
          `The cube count on the QC form is now a required field, so this cannot recur.`
        : `Round 155 — no cube batches needed recovering; nothing was recorded with sample IDs but no count.`
    );

    // ========================================================================
    // ROUND 154 — weighbridge integration tables.
    //
    // Additive only, and written so a re-run is a no-op: every table is
    // IF NOT EXISTS, the enum is created inside a DO block that checks pg_type
    // first (Postgres has no CREATE TYPE IF NOT EXISTS), and the rm_receipts
    // column is ADD COLUMN IF NOT EXISTS. Nothing here drops, renames or
    // rewrites an existing row.
    //
    // See schema.sql's Round 154 block for why the shape is what it is — in
    // short: the weighbridge's multi-material child table has never been used,
    // its moisture and "actual weight" columns are free text the operators type
    // into, and vehicle/material/supplier are unnormalised strings that need a
    // human-maintained alias layer rather than a fuzzy guess.
    // ========================================================================
    await pool.query(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wb_match_status') THEN
    CREATE TYPE wb_match_status AS ENUM ('matched', 'needs_review', 'ignored');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS weighbridge_tickets (
  ticket_number      INTEGER PRIMARY KEY,
  raw_vehicle        VARCHAR(60),
  raw_material       VARCHAR(120),
  raw_material_code  VARCHAR(120),
  raw_supplier       VARCHAR(150),
  purpose            VARCHAR(60),
  challan_number     VARCHAR(60),
  driver_name        VARCHAR(120),
  site_name          VARCHAR(120),
  shift              VARCHAR(20),
  load_status        VARCHAR(20),
  remarks            TEXT,
  charges            VARCHAR(120),
  concrete_grade     VARCHAR(60),
  empty_weight_kg    INTEGER,
  loaded_weight_kg   INTEGER,
  net_weight_kg      INTEGER,
  ticket_date        DATE,
  empty_weighed_at   TIMESTAMPTZ,
  loaded_weighed_at  TIMESTAMPTZ,
  weighed_at         TIMESTAMPTZ,
  material_id        INTEGER REFERENCES rm_materials(id),
  supplier_id        INTEGER REFERENCES rm_suppliers(id),
  truck_id           INTEGER REFERENCES trucks(id),
  match_status       wb_match_status NOT NULL DEFAULT 'needs_review',
  unresolved         TEXT[] NOT NULL DEFAULT '{}',
  review_note        TEXT,
  reviewed_by        INTEGER REFERENCES users(id),
  reviewed_at        TIMESTAMPTZ,
  source_hash        CHAR(64) NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  first_synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wb_tickets_status  ON weighbridge_tickets(match_status);
CREATE INDEX IF NOT EXISTS idx_wb_tickets_weighed ON weighbridge_tickets(weighed_at DESC);
CREATE INDEX IF NOT EXISTS idx_wb_tickets_purpose ON weighbridge_tickets(purpose);

CREATE TABLE IF NOT EXISTS weighbridge_material_aliases (
  id          SERIAL PRIMARY KEY,
  normalised  VARCHAR(120) NOT NULL UNIQUE,
  raw_sample  VARCHAR(120) NOT NULL,
  material_id INTEGER REFERENCES rm_materials(id),
  is_ignored  BOOLEAN NOT NULL DEFAULT false,
  mapped_by   INTEGER REFERENCES users(id),
  mapped_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_ignored OR material_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS weighbridge_supplier_aliases (
  id          SERIAL PRIMARY KEY,
  normalised  VARCHAR(150) NOT NULL UNIQUE,
  raw_sample  VARCHAR(150) NOT NULL,
  supplier_id INTEGER REFERENCES rm_suppliers(id),
  is_ignored  BOOLEAN NOT NULL DEFAULT false,
  mapped_by   INTEGER REFERENCES users(id),
  mapped_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_ignored OR supplier_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS weighbridge_vehicle_aliases (
  id          SERIAL PRIMARY KEY,
  normalised  VARCHAR(60) NOT NULL UNIQUE,
  raw_sample  VARCHAR(60) NOT NULL,
  truck_id    INTEGER REFERENCES trucks(id),
  is_ignored  BOOLEAN NOT NULL DEFAULT false,
  mapped_by   INTEGER REFERENCES users(id),
  mapped_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_ignored OR truck_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS weighbridge_sync_log (
  id             SERIAL PRIMARY KEY,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_version  VARCHAR(20),
  rows_sent      INTEGER NOT NULL DEFAULT 0,
  rows_inserted  INTEGER NOT NULL DEFAULT 0,
  rows_updated   INTEGER NOT NULL DEFAULT 0,
  rows_unchanged INTEGER NOT NULL DEFAULT 0,
  rows_rejected  INTEGER NOT NULL DEFAULT 0,
  highest_ticket INTEGER,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_wb_sync_log_received ON weighbridge_sync_log(received_at DESC);

ALTER TABLE rm_receipts ADD COLUMN IF NOT EXISTS weighbridge_ticket_id INTEGER REFERENCES weighbridge_tickets(ticket_number);
CREATE INDEX IF NOT EXISTS idx_rm_receipts_wb_ticket ON rm_receipts(weighbridge_ticket_id);
`);

    const { rows: wbCount } = await pool.query(`SELECT count(*)::int AS n FROM weighbridge_tickets`);
    log.push(
      `Schema migration applied (Round 154 — weighbridge integration). ` +
      `weighbridge_tickets holds ${wbCount[0].n} ticket(s). ` +
      (process.env.WEIGHBRIDGE_API_KEY
        ? `WEIGHBRIDGE_API_KEY is set, so the sync agent can post to /api/weighbridge/sync.`
        : `WEIGHBRIDGE_API_KEY is NOT set — /api/weighbridge/sync will reject every call until it is. ` +
          `Set it in the backend environment and give the same value to the agent on the weighbridge PC.`)
    );

    // Round 154 — the two new weighbridge permission keys.
    //
    // Same mechanism and same reason as REPAIR_148 and REPAIR_153: the seeding
    // loop only fires for a role that has NO rows at all, so a brand new
    // catalogue KEY never reaches an installation that is already live. Without
    // this, Store and the Manager would open the Weighbridge screen and get a
    // bare 403 on a tile the dashboard was happy to show them.
    //
    // Administrator and Super Admin are deliberately absent: their sets are
    // computed (ADMIN_HAS_EVERYTHING), not seeded, so inserting rows for them
    // would be dead weight.
    //
    // Note what is NOT granted here. material.weighbridge-mapping goes to
    // nobody but Administrator, because mapping a weighbridge spelling to a
    // material or supplier decides where stock is credited from then on, for
    // every past and future ticket carrying that spelling. Store can flag a
    // ticket; Store cannot decide what it means.
    const REPAIR_154 = [
      ["manager",        "material.weighbridge", "view"],
      ["manager",        "material.weighbridge", "edit"],
      ["store",          "material.weighbridge", "view"],
      ["store",          "material.weighbridge", "edit"],
      ["plant_operator", "material.weighbridge", "view"],
      ["lab_technician", "material.weighbridge", "view"],
    ];
    const wbRepaired = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
       ON CONFLICT DO NOTHING
       RETURNING role::text, permission_key, action`,
      [REPAIR_154.map((r) => r[0]), REPAIR_154.map((r) => r[1]), REPAIR_154.map((r) => r[2])]
    );
    log.push(
      wbRepaired.rows.length
        ? `Schema migration applied (Round 154 — weighbridge access granted to ` +
          `${[...new Set(wbRepaired.rows.map((r) => r.role))].join(", ")}). ` +
          `Super Admin can revoke any of it on the Access Control page.`
        : `Round 154 — weighbridge access defaults already in place, nothing to repair.`
    );

    // Round 153, item 1 — let the Plant Operator, the lab, QC and the Manager
    // open and print a Delivery Challan.
    //
    // Same mechanism and same reasoning as REPAIR_148 above: the catalogue's
    // widened default for orders.challan-print only reaches a role that has
    // never been seeded, so an installation that is already live would carry on
    // 403-ing these four roles on the new list. Inserted by name, additively,
    // ON CONFLICT DO NOTHING — nothing is revoked, a per-person override still
    // wins, and requireRole still has to agree before any of it matters.
    //
    // Deliberately NOT a schema change: there is nothing to migrate, only four
    // baseline rows. A Super Admin who does not want one of these roles to have
    // it can untick it on the Access Control page straight afterwards.
    const REPAIR_153 = [
      ["manager", "orders.challan-print", "view"],
      ["plant_operator", "orders.challan-print", "view"],
      ["lab_technician", "orders.challan-print", "view"],
      ["qc_engineer", "orders.challan-print", "view"],
    ];
    const challanRepaired = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT * FROM UNNEST($1::user_role[], $2::text[], $3::text[])
       ON CONFLICT DO NOTHING
       RETURNING role::text, permission_key`,
      [REPAIR_153.map((r) => r[0]), REPAIR_153.map((r) => r[1]), REPAIR_153.map((r) => r[2])]
    );
    log.push(
      challanRepaired.rows.length
        ? `Schema migration applied (Round 153 — challan printing granted to ${challanRepaired.rows.length} more role(s): ` +
          `${challanRepaired.rows.map((r) => r.role).join(", ")}). Super Admin can revoke any of these on the Access Control page.`
        : `Round 153 — challan printing defaults already in place, nothing to repair.`
    );

    log.push(`Schema migration applied (Round 142 — rm_materials.mix_component). Auto-classified ${componentsGuessed} material(s) by name; Administrator can correct any of them in Materials.`);

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

// Round 147 — creates the FIRST Super Admin, without needing a database client.
//
// Why this exists at all: an Administrator deliberately cannot mint a Super
// Admin (see the ROLES list in Administrator.jsx), so the very first one has to
// come from outside the app's own permission system. The documented way was a
// manual `UPDATE users SET role='super_admin' …` in psql, which means installing
// a Postgres client just to run one statement — Render's lower plans have no
// in-browser shell. This does the same statement from a URL you already know how
// to use.
//
// What stops it being a back door:
//   1. It needs SETUP_SECRET, same as every other endpoint in this file.
//   2. It refuses once an ACTIVE Super Admin exists. After the first one, the
//      route is permanently inert and every later change goes through the
//      Super Admin screen, which writes to permission_change_log. There is no
//      override parameter — reopening it would mean clearing the role in the
//      database, which is exactly the situation this route exists to avoid
//      needing, so if you are ever there you can promote from psql anyway.
//   3. It only promotes an EXISTING, active account. It never creates a user
//      and never touches a password, so it cannot be used to plant a login.
//
// Visiting it without &phone= lists the accounts you could promote, so you can
// see the exact phone number as stored rather than guessing at spacing or a
// country-code prefix.
router.get("/setup/promote-super-admin", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }

  const page = (body, colour = "#111") =>
    `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px; white-space: pre-wrap; color: ${colour};">${body}</pre>`;

  try {
    // Guard 1 — has the Round 146 migration run? If not, the UPDATE below would
    // fail with a raw "invalid input value for enum user_role" that reads like a
    // bug rather than a missing step, so say the actual next action instead.
    const { rows: enumRows } = await pool.query(
      `SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'user_role' AND e.enumlabel = 'super_admin'`
    );
    if (!enumRows.length) {
      return res.status(400).send(page(
        `The 'super_admin' role does not exist in the database yet.\n\n` +
        `Visit /setup?key=… once first — that is what adds it — then come back here.`,
        "#c0392b"
      ));
    }

    // Guard 2 — one-shot. Inactive Super Admins do not count, so a deactivated
    // first Super Admin doesn't lock you out of ever making another.
    const { rows: existing } = await pool.query(
      `SELECT id, name, phone FROM users WHERE role = 'super_admin' AND is_active ORDER BY id`
    );
    if (existing.length) {
      return res.status(409).send(page(
        `A Super Admin already exists, so this one-time route is closed:\n\n` +
        existing.map((u) => `  #${u.id}  ${u.name}  (${u.phone})`).join("\n") +
        `\n\nSign in as that person and use the Super Admin screen to promote anyone else —\n` +
        `every change there is recorded in the change log, which this route is not.`,
        "#b9770e"
      ));
    }

    const phone = String(req.query.phone || "").trim();

    // No phone given — show what's available rather than making them guess.
    if (!phone) {
      const { rows: candidates } = await pool.query(
        `SELECT id, name, phone, role FROM users WHERE is_active ORDER BY role, name`
      );
      return res.send(page(
        `No Super Admin exists yet. Pick the account to promote and add its phone\n` +
        `number to this URL, exactly as shown below:\n\n` +
        `   …/setup/promote-super-admin?key=…&phone=XXXXXXXXXX\n\n` +
        `Active accounts:\n\n` +
        (candidates.length
          ? candidates.map((u) => `  #${String(u.id).padEnd(4)} ${String(u.phone).padEnd(16)} ${String(u.role).padEnd(16)} ${u.name}`).join("\n")
          : `  (none — create a user from the Administrator screen first)`)
      ));
    }

    // Look before writing. Matching on phone because that is what people sign
    // in with. `users.phone` carries a UNIQUE constraint, so the multi-match
    // branch below should never fire — it stays as cheap defence, because
    // resolving to one id and updating by id costs nothing, while an
    // `UPDATE … WHERE phone = $1` that promoted two rows would need each
    // account's previous role guessed at to undo.
    const { rows: matches } = await pool.query(
      `SELECT id, name, phone, role FROM users WHERE phone = $1 AND is_active ORDER BY id`,
      [phone]
    );

    if (!matches.length) {
      return res.status(404).send(page(
        `No active user with phone "${phone}".\n\n` +
        `Load this URL without the &phone= part to see the list of accounts\n` +
        `with their phone numbers exactly as stored.`,
        "#c0392b"
      ));
    }
    if (matches.length > 1) {
      // Two accounts share a phone number — promoting both is not what anyone
      // meant, and nothing has been written yet, so stop here.
      return res.status(409).send(page(
        `${matches.length} active accounts share the phone "${phone}" — nothing was changed.\n\n` +
        matches.map((m) => `  #${m.id}  ${m.name}  (${m.role})`).join("\n") +
        `\n\nDeactivate the duplicate from the Administrator screen, then try again.`,
        "#c0392b"
      ));
    }

    const { rows: promoted } = await pool.query(
      `UPDATE users SET role = 'super_admin' WHERE id = $1 RETURNING id, name, phone, role`,
      [matches[0].id]
    );
    const u = promoted[0];
    res.send(page(
      `Done.\n\n` +
      `  #${u.id}  ${u.name}  (${u.phone})  →  ${u.role}\n\n` +
      `Sign out of the app completely, then sign in again with that phone number.\n` +
      `You should land on the Super Admin screen rather than the Administrator dashboard.\n` +
      `If you land on the old page, tap Refresh in the app footer — that asks the\n` +
      `service worker for the newest build before reloading.\n\n` +
      `Do this next: from the Super Admin screen, make a SECOND Super Admin.\n` +
      `Nobody can change their own role or their own access, and the system refuses to\n` +
      `leave zero active Super Admins — so with only one account, losing it means coming\n` +
      `back to a database prompt. Two accounts can rescue each other.\n\n` +
      `This route is now closed and will refuse any further use.`
    ));
  } catch (err) {
    console.error(err);
    res.status(500).send(page(`Something went wrong:\n${err.message}`, "#c0392b"));
  }
});

export default router;
