-- Our Own Ready Mix — Database Schema
-- PostgreSQL. Covers all SRS sections 2-16 including Pump, Fuel, Reports, Audit trail.

CREATE TYPE user_role AS ENUM (
  'administrator', 'manager', 'plant_operator', 'qc_engineer',
  'driver', 'site_supervisor', 'accountant'
);

CREATE TYPE order_status AS ENUM (
  'planned', 'in_progress', 'completed', 'partially_completed', 'cancelled'
);

CREATE TYPE ticket_status AS ENUM (
  'created', 'batching', 'dispatched', 'reached_site',
  'unloading', 'completed', 'returned', 'rejected', 'cancelled'
);

CREATE TYPE pump_type AS ENUM ('boom_pump', 'line_pump', 'without_pump');

CREATE TYPE payment_mode AS ENUM ('cash', 'cheque', 'bank_transfer', 'upi');

CREATE TYPE delivery_note_status AS ENUM ('pending', 'signed', 'refused');

-- ===================== USERS & AUTH =====================

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(150) UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ===================== MASTER DATA (SRS 15) =====================

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  contact_number VARCHAR(20),
  billing_address TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Trip allowance category, added per business rule: 100/150/200 by distance, paid only on completed delivery
CREATE TABLE trip_allowance_categories (
  id SERIAL PRIMARY KEY,
  label VARCHAR(50) NOT NULL,          -- e.g. '₹100 (0-10 km)'
  amount NUMERIC(10,2) NOT NULL,
  min_distance_km NUMERIC(6,2) NOT NULL,
  max_distance_km NUMERIC(6,2)
);

CREATE TABLE sites (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  name VARCHAR(200) NOT NULL,
  address TEXT,
  distance_from_plant_km NUMERIC(6,2),
  trip_allowance_category_id INTEGER REFERENCES trip_allowance_categories(id),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  geofence_radius_m INTEGER DEFAULT 150,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE mix_grades (
  id SERIAL PRIMARY KEY,
  name VARCHAR(20) NOT NULL UNIQUE      -- e.g. M25, M30
);

CREATE TABLE trucks (
  id SERIAL PRIMARY KEY,
  truck_number VARCHAR(30) NOT NULL UNIQUE,
  capacity_m3 NUMERIC(5,2),
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE pumps (
  id SERIAL PRIMARY KEY,
  pump_code VARCHAR(30) NOT NULL UNIQUE,
  pump_type pump_type NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE fuel_stations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  location TEXT
);

CREATE TABLE rejection_reasons (
  id SERIAL PRIMARY KEY,
  reason VARCHAR(200) NOT NULL UNIQUE
);

-- Salesmen, as a controlled list — orders reference this instead of a free-text
-- name, so a typo doesn't silently create a second "salesman" in reports.
CREATE TABLE salespersons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE
);

-- Rate master for Accountant (rates, pumping charges, waiting charges per customer/grade)
CREATE TABLE rate_master (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  mix_grade_id INTEGER REFERENCES mix_grades(id),
  rate_per_m3 NUMERIC(10,2) NOT NULL,
  pumping_charge_lumpsum NUMERIC(10,2) DEFAULT 0,  -- flat charge per delivery, not per m³
  waiting_charge_per_hour NUMERIC(10,2) DEFAULT 0,
  effective_from DATE NOT NULL,
  effective_to DATE
);

-- Role-permission matrix for Administrator's permission assignment
CREATE TABLE role_permissions (
  id SERIAL PRIMARY KEY,
  role user_role NOT NULL,
  module VARCHAR(50) NOT NULL,          -- e.g. 'accounts', 'reports', 'master_data'
  can_view BOOLEAN DEFAULT FALSE,
  can_edit BOOLEAN DEFAULT FALSE,
  UNIQUE(role, module)
);

-- ===================== ORDERS (SRS 5A) =====================

CREATE TABLE customer_orders (
  id SERIAL PRIMARY KEY,
  order_date DATE NOT NULL,
  scheduled_batching_time TIME NOT NULL,
  truck_dispatch_interval_minutes INTEGER NOT NULL,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  site_id INTEGER REFERENCES sites(id) NOT NULL,
  mix_grade_id INTEGER REFERENCES mix_grades(id) NOT NULL,
  pump_requirement pump_type NOT NULL,
  pump_id INTEGER REFERENCES pumps(id),  -- which specific pump (e.g. Line-2), when more than one exists
  site_technician_required BOOLEAN NOT NULL,
  cube_samples_required INTEGER NOT NULL,
  assigned_pump_crew VARCHAR(150),
  assigned_site_supervisor_id INTEGER REFERENCES users(id),
  site_contact_number VARCHAR(20) NOT NULL,
  order_quantity_m3 NUMERIC(8,2) NOT NULL,
  sales_representative VARCHAR(150),  -- deprecated free-text field, kept for old records only
  sales_representative_id INTEGER REFERENCES salespersons(id),
  casting_location VARCHAR(200),
  pump_departure_time TIME,
  remarks TEXT,
  status order_status DEFAULT 'planned',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  -- Manager "close order" (formal cancel when an order will never be completed).
  -- Orders are never deleted; incomplete orders instead carry forward to every
  -- following day automatically until completed or closed here.
  closed_by INTEGER REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closure_reason TEXT
);

-- ===================== DELIVERY TICKETS (SRS 6) =====================

CREATE TABLE delivery_tickets (
  id SERIAL PRIMARY KEY,
  ticket_number VARCHAR(30) UNIQUE NOT NULL,   -- e.g. DT-2231
  order_id INTEGER REFERENCES customer_orders(id) NOT NULL,
  ticket_date DATE NOT NULL DEFAULT CURRENT_DATE,
  loaded_quantity_m3 NUMERIC(8,2),
  truck_id INTEGER REFERENCES trucks(id),
  driver_id INTEGER REFERENCES users(id),
  plant_operator_id INTEGER REFERENCES users(id),
  pump_id INTEGER REFERENCES pumps(id),
  status ticket_status DEFAULT 'created',
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===================== TRIP STATUS TIMELINE (SRS §7, technical requirements) =====================
-- Every event in the trip lifecycle logged here, drives the "Trip Status Timeline" view

CREATE TABLE trip_events (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES delivery_tickets(id) NOT NULL,
  event_type VARCHAR(50) NOT NULL,   -- created, batching_started, batching_completed, plant_qc_completed,
                                      -- duty_on, left_plant, reached_site, site_slump_checked,
                                      -- unloading_started, unloading_completed, left_site, returned_to_plant, trip_closed
  event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  source VARCHAR(20) DEFAULT 'auto', -- 'auto' (GPS geofence) or 'manual'
  edited_by INTEGER REFERENCES users(id),      -- set if manually edited
  manager_approved_by INTEGER REFERENCES users(id), -- SRS §7: manual edits require manager approval
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7)
);

-- ===================== GPS TRACKING (SRS §4) =====================

CREATE TABLE gps_pings (
  id BIGSERIAL PRIMARY KEY,
  driver_id INTEGER REFERENCES users(id) NOT NULL,
  ticket_id INTEGER REFERENCES delivery_tickets(id),
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  speed_kmh NUMERIC(6,2),
  accuracy_m NUMERIC(6,2),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gps_pings_driver_time ON gps_pings(driver_id, recorded_at);

-- ===================== PLANT QC (SRS §8) =====================

CREATE TABLE plant_qc (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES delivery_tickets(id) UNIQUE NOT NULL,
  slump_mm NUMERIC(5,1),
  temperature_c NUMERIC(4,1),
  number_of_cubes INTEGER,
  sample_ids TEXT,
  remarks TEXT,
  entered_by INTEGER REFERENCES users(id),
  entered_at TIMESTAMPTZ DEFAULT now()
);

-- ===================== SITE QC / SITE SUPERVISOR (SRS §9) =====================

CREATE TABLE site_qc (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES delivery_tickets(id) UNIQUE NOT NULL,
  arrival_slump_mm NUMERIC(5,1),
  site_temperature_c NUMERIC(4,1),
  unload_start_time TIMESTAMPTZ,
  unload_finish_time TIMESTAMPTZ,
  accepted BOOLEAN,
  rejected_quantity_m3 NUMERIC(8,2),
  rejection_reason_id INTEGER REFERENCES rejection_reasons(id),
  delivery_note_status delivery_note_status DEFAULT 'pending',
  after_pour_care_confirmed BOOLEAN DEFAULT false,  -- site supervisor guided customer on post-pour care (e.g. plastic sheeting)
  remarks TEXT,
  manager_approved_rejection BOOLEAN DEFAULT FALSE, -- Manager role: "approve rejected concrete"
  manager_approved_by INTEGER REFERENCES users(id),
  entered_by INTEGER REFERENCES users(id),
  entered_at TIMESTAMPTZ DEFAULT now()
);

-- ===================== PUMP MODULE (SRS §10) =====================

CREATE TABLE pump_logs (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES delivery_tickets(id) NOT NULL,
  pump_id INTEGER REFERENCES pumps(id),
  pump_operator_id INTEGER REFERENCES users(id),
  start_time TIMESTAMPTZ,
  finish_time TIMESTAMPTZ,
  pumping_quantity_m3 NUMERIC(8,2),
  waiting_time_minutes INTEGER,
  fuel_litres NUMERIC(6,2),
  remarks TEXT
);

-- ===================== FUEL MODULE (SRS §11) =====================

CREATE TABLE fuel_logs (
  id SERIAL PRIMARY KEY,
  truck_id INTEGER REFERENCES trucks(id) NOT NULL,
  odometer_reading NUMERIC(10,2),
  fuel_quantity_litres NUMERIC(7,2),
  fuel_cost NUMERIC(10,2),
  fuel_station_id INTEGER REFERENCES fuel_stations(id),
  pump_fuel_litres NUMERIC(7,2),        -- fuel used by pump, if applicable
  generator_fuel_litres NUMERIC(7,2),   -- fuel used by generator, if applicable
  logged_by INTEGER REFERENCES users(id),
  logged_at TIMESTAMPTZ DEFAULT now()
);

-- ===================== BREAKDOWN REPORTING =====================
-- Covers trucks (mixers), pumps, and the batching plant itself — equipment_type
-- says which. truck_id/pump_id are set only for their matching equipment_type;
-- equipment_label is a free-text name for the plant (or any non-listed asset).

CREATE TYPE breakdown_equipment_type AS ENUM ('truck', 'pump', 'plant');

CREATE TABLE breakdown_reports (
  id SERIAL PRIMARY KEY,
  equipment_type breakdown_equipment_type NOT NULL DEFAULT 'truck',
  truck_id INTEGER REFERENCES trucks(id),
  pump_id INTEGER REFERENCES pumps(id),
  equipment_label VARCHAR(100),
  reported_by INTEGER REFERENCES users(id) NOT NULL,
  driver_id INTEGER REFERENCES users(id),
  breakdown_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  location TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  remarks TEXT,
  resolved BOOLEAN DEFAULT FALSE,
  repaired_by INTEGER REFERENCES users(id),
  repaired_at TIMESTAMPTZ
);

-- ===================== ACCOUNTS (SRS §2, §16 — restricted visibility) =====================

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES delivery_tickets(id) UNIQUE NOT NULL,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  concrete_amount NUMERIC(12,2) NOT NULL,
  pumping_charge NUMERIC(12,2) DEFAULT 0,
  waiting_charge NUMERIC(12,2) DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Supports multiple receipts against the same invoice (Additional Recommendations)
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id) NOT NULL,
  payment_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  mode payment_mode NOT NULL,
  reference_number VARCHAR(100),
  remarks TEXT,
  entered_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Trip allowance payout ledger — only credited when ticket status = completed
CREATE TABLE trip_allowance_payouts (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES delivery_tickets(id) UNIQUE NOT NULL,
  driver_id INTEGER REFERENCES users(id) NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  earned_at TIMESTAMPTZ DEFAULT now(),
  paid_out BOOLEAN DEFAULT FALSE,
  paid_out_at TIMESTAMPTZ
);

-- ===================== NOTIFICATIONS (SRS §13) =====================

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  recipient_role user_role NOT NULL DEFAULT 'manager',
  recipient_id INTEGER REFERENCES users(id),
  ticket_id INTEGER REFERENCES delivery_tickets(id),
  type VARCHAR(50) NOT NULL,  -- left_plant, reached_site, delayed, at_site_over_threshold,
                              -- concrete_rejected, delivery_completed, driver_off_duty_during_trip
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Configurable GPS delay alert threshold (Additional Recommendations, default 120 min / repeat 30 min)
CREATE TABLE alert_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) UNIQUE NOT NULL,
  value_minutes INTEGER NOT NULL
);
INSERT INTO alert_settings (key, value_minutes) VALUES
  ('gps_delay_threshold', 120),
  ('gps_delay_reminder_interval', 30);

-- ===================== AUDIT TRAIL (SRS §16) =====================

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  table_name VARCHAR(100) NOT NULL,
  record_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(20) NOT NULL,   -- insert, update (never delete — SRS: no permanent deletion)
  old_value JSONB,
  new_value JSONB,
  changed_at TIMESTAMPTZ DEFAULT now()
);

-- Soft-delete pattern used everywhere instead of DELETE, to satisfy "no record shall be permanently deleted"
-- (is_active / is_deleted columns already present on master tables above)
