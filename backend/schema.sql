-- Our Own Ready Mix — Database Schema
-- PostgreSQL. Covers all SRS sections 2-16 including Pump, Fuel, Reports, Audit trail.

CREATE TYPE user_role AS ENUM (
  'administrator', 'manager', 'plant_operator', 'qc_engineer',
  'driver', 'site_supervisor', 'accountant', 'sales_executive', 'store'
);

CREATE TYPE order_status AS ENUM (
  'planned', 'in_progress', 'completed', 'partially_completed', 'cancelled', 'closed'
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
  -- Driver-facing screens/notifications only ('en' | 'ml' | 'hi') — round 96
  preferred_language VARCHAR(10) NOT NULL DEFAULT 'en',
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
  -- The sales person who owns this project/site relationship — distinct from
  -- an individual order's sales_representative_id (which is who sold that
  -- one particular delivery, for attribution/commission reporting). This is
  -- who's responsible for the site as an ongoing relationship, which is what
  -- Sales Forecast is actually keyed on. FK added below once salespersons exists.
  assigned_sales_representative_id INTEGER,
  is_active BOOLEAN DEFAULT TRUE
);

-- Site Contacts directory (round 96) — keyed on customer+site, not the order.
-- Create Order autofills from here once customer+site are picked, and saves
-- any newly-typed contact back to it, so the next order for the same site
-- already has it on file. customer_orders.site_contact_number (below) stays
-- a plain free-text field recording what was actually used on that order.
CREATE TABLE site_contacts (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  contact_name VARCHAR(150) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  role_label VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_site_contacts_customer_site ON site_contacts(customer_id, site_id);

-- Monthly production target (round 96) — feeds the Manager dashboard's
-- Achieved %/Balance/Required-per-day KPI. One row per calendar month so
-- past months keep their own historical target.
CREATE TABLE monthly_production_targets (
  id SERIAL PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  target_m3 NUMERIC(10,1) NOT NULL,
  set_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(year, month)
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
  location TEXT,
  -- Exactly one station is the plant itself — a request approved against it
  -- gets a QR code (issued in person at Store); every other station gets a
  -- shareable approval slip instead, since Store can't hand-issue fuel at a
  -- third-party pump.
  is_plant BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE
);

-- Lightweight equipment — pickup vans, loaders, generators — anything that
-- doesn't need its own specialized table the way trucks/pumps do, but still
-- needs to be selectable when logging fuel.
CREATE TYPE fuel_equipment_type AS ENUM ('truck', 'pump', 'pickup_van', 'loader', 'generator');

CREATE TABLE equipment (
  id SERIAL PRIMARY KEY,
  equipment_type fuel_equipment_type NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE rejection_reasons (
  id SERIAL PRIMARY KEY,
  reason VARCHAR(200) NOT NULL UNIQUE
);

-- Salesmen, as a controlled list — orders reference this instead of a free-text
-- name, so a typo doesn't silently create a second "salesman" in reports.
-- user_id links this entry to an actual Sales Executive login, once they have
-- one — kept nullable so existing orders/reports built on the old name-only
-- list keep working exactly as before for anyone without a real account.
CREATE TABLE salespersons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  user_id INTEGER REFERENCES users(id)
);

ALTER TABLE sites ADD CONSTRAINT sites_assigned_sales_representative_id_fkey
  FOREIGN KEY (assigned_sales_representative_id) REFERENCES salespersons(id);

-- ===================== SALES MODULE =====================

CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'quoted', 'won', 'lost');
-- Set only when a lead is won — Admin decides whether the resulting sale
-- counts as this salesperson's own, or goes to the company directly.
CREATE TYPE lead_attribution AS ENUM ('salesperson', 'company');

CREATE TABLE leads (
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
  won_order_id INTEGER, -- FK to customer_orders added below, once that table exists
  lost_reason TEXT,
  quotation_issued BOOLEAN DEFAULT false,
  latest_quotation_amount NUMERIC(10,2),
  at_site BOOLEAN,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  site_latitude NUMERIC(10,7),
  site_longitude NUMERIC(10,7),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Every update a Sales Executive logs against a lead — a general note,
-- issuing/revising a quotation, a meeting, or a site visit — all go through
-- this one activity log so Admin (their reporting authority) sees the full
-- trail in one place. Every entry captures whether they were actually at
-- site when logging it, and their GPS location if so.
CREATE TABLE lead_followups (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) NOT NULL,
  activity_type VARCHAR(30) NOT NULL DEFAULT 'note',
  -- 'note', 'quotation_issued', 'quotation_followup', 'quotation_revised', 'meeting', 'site_visit'
  note TEXT NOT NULL,
  quotation_amount NUMERIC(10,2),
  revision_reason TEXT,
  persons_met TEXT,
  at_site BOOLEAN,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- A booking is a lighter-weight commitment than a real order — a Sales
-- Executive places one, and it sits pending until Manager confirms site
-- readiness and payment terms, then converts it into a real customer_orders row.
CREATE TYPE booking_status AS ENUM ('pending', 'converted', 'declined');

CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  site_id INTEGER REFERENCES sites(id),
  mix_grade_id INTEGER REFERENCES mix_grades(id),
  estimated_qty_m3 NUMERIC(8,2),
  preferred_date DATE,
  preferred_time TIME,
  notes TEXT,
  site_latitude NUMERIC(10,7),
  site_longitude NUMERIC(10,7),
  requested_by INTEGER REFERENCES users(id) NOT NULL,
  status booking_status DEFAULT 'pending',
  converted_order_id INTEGER, -- FK to customer_orders added below, once that table exists
  declined_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TYPE feedback_type AS ENUM ('compliment', 'complaint');

CREATE TABLE aftersales_feedback (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  order_id INTEGER, -- FK to customer_orders added below, once that table exists
  feedback_type feedback_type NOT NULL,
  comment TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===================== STATUTORY COMPLIANCE MONITORING =====================
-- Manager-only. Tracks expiry dates for vehicle and equipment documents
-- across every company asset — insurance, permits, AMCs, certifications, etc.

CREATE TYPE compliance_asset_type AS ENUM (
  'transit_mixer', 'boom_pump', 'batching_plant', 'loader', 'generator',
  'weighbridge', 'compressor', 'pickup', 'car', 'motor_bike', 'other'
);
CREATE TYPE compliance_category AS ENUM ('vehicle', 'equipment');

CREATE TABLE compliance_assets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  asset_type compliance_asset_type NOT NULL,
  category compliance_category NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

-- One row per asset + document type — renewing a document updates this same
-- row's expiry date (and who/when) rather than piling up history rows.
CREATE TABLE compliance_documents (
  id SERIAL PRIMARY KEY,
  asset_id INTEGER REFERENCES compliance_assets(id) NOT NULL,
  document_type VARCHAR(50) NOT NULL,
  document_number VARCHAR(100),
  expiry_date DATE NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (asset_id, document_type)
);

-- A Sales Executive's logged visit to whoever they actually met — an
-- existing customer, but also a client, consultant, or site engineer who
-- isn't in the customers list at all. visited_name/visitor_type are the
-- primary "who" — customer_id is only set when it genuinely is an existing
-- customer they want tagged for reporting.
CREATE TABLE customer_visits (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  visited_name VARCHAR(150) NOT NULL,
  visitor_type VARCHAR(30) NOT NULL DEFAULT 'customer',
  -- 'customer', 'client', 'consultant', 'site_engineer', 'other'
  visited_by INTEGER REFERENCES users(id) NOT NULL,
  visit_date DATE NOT NULL,
  visit_time TIME,
  contact_person VARCHAR(150),
  contact_number VARCHAR(20),
  -- Nullable — the reworked visit form (structured tap-answer questions)
  -- doesn't always produce a single free-text summary the way the old form did.
  discussion_outcome TEXT,
  site_id INTEGER REFERENCES sites(id),
  is_new_project BOOLEAN,
  -- Structured tap-answer responses from the reworked visit form.
  answers JSONB,
  at_site BOOLEAN,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Follow-ups generated from a visit (e.g. "call back in 3 days"), plus the
-- eventual outcome — Won/Lost/Closed, with a reason for Lost/Closed drawn
-- from visit_outcome_reasons below.
CREATE TABLE visit_followups (
  id SERIAL PRIMARY KEY,
  visit_id INTEGER REFERENCES customer_visits(id) NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  title VARCHAR(200) NOT NULL,
  reason TEXT,
  due_date DATE NOT NULL,
  assigned_to_role user_role NOT NULL DEFAULT 'sales_executive',
  assigned_to_user_id INTEGER REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  outcome VARCHAR(20),
  outcome_reason_id INTEGER,
  outcome_notes TEXT,
  outcome_by INTEGER REFERENCES users(id),
  outcome_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Admin-managed reason list shown when a follow-up is marked Lost or Closed.
CREATE TABLE visit_outcome_reasons (
  id SERIAL PRIMARY KEY,
  outcome_type VARCHAR(20) NOT NULL CHECK (outcome_type IN ('lost', 'closed')),
  reason VARCHAR(150) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE visit_followups ADD CONSTRAINT visit_followups_outcome_reason_id_fkey
  FOREIGN KEY (outcome_reason_id) REFERENCES visit_outcome_reasons(id);

-- Raw material stock — one row per bin, entered/updated by QC Engineer and
-- shown read-only on the Manager and Administrator dashboards until QC
-- updates it again. Bins themselves are a fixed list (silos, admixtures,
-- aggregates); type/brand and quantity are what QC edits day to day.
CREATE TABLE raw_material_stock (
  id SERIAL PRIMARY KEY,
  bin_name VARCHAR(50) NOT NULL UNIQUE,
  unit VARCHAR(20) NOT NULL,
  type_brand VARCHAR(100),
  stock_qty NUMERIC(10,2) NOT NULL DEFAULT 0,
  qty_on_order NUMERIC(10,2) DEFAULT 0,
  expected_delivery_date DATE,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Web Push subscriptions — one row per device/browser a user has enabled
-- notifications on (a user can have more than one, e.g. phone + desktop).
CREATE TABLE push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Rate master for Accountant (rates, pumping charges, waiting charges per customer/grade)
CREATE TABLE rate_master (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  -- Nullable on purpose: a rate with no site set applies to any of that
  -- customer's sites as a fallback, when no more specific site+grade rate
  -- exists. New rates should always specify a site — this stays nullable
  -- only so a rate entered before site-level rates existed keeps working.
  site_id INTEGER REFERENCES sites(id),
  mix_grade_id INTEGER REFERENCES mix_grades(id),
  rate_per_m3 NUMERIC(10,2) NOT NULL,
  -- Legacy single pump charge — kept only as a fallback for rates entered
  -- before pump charges were split by pump type. New rates use the two
  -- fields below instead.
  pumping_charge_lumpsum NUMERIC(10,2) DEFAULT 0,
  -- Pump mobilization charge is genuinely different by pump type, and only
  -- ordinarily applies below a minimum order quantity (line pump vs boom
  -- pump have different thresholds) — Manager still confirms it applies on
  -- each order rather than this being automatic, but these are what the
  -- confirmation screen suggests.
  line_pump_charge NUMERIC(10,2),
  line_pump_min_qty_m3 NUMERIC(8,2) DEFAULT 20,
  boom_pump_charge NUMERIC(10,2),
  boom_pump_min_qty_m3 NUMERIC(8,2) DEFAULT 50,
  -- Part load: charged per m³ short of the minimum load, when the order
  -- itself is below that minimum. Also a Manager-confirmed decision, not
  -- automatic — sometimes sending a part load is the company's own call.
  part_load_min_qty_m3 NUMERIC(8,2) DEFAULT 5,
  part_load_charge_per_m3 NUMERIC(10,2),
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
  -- Specified/target slump for this order, set at booking time — feeds the
  -- "Workability" field on the printed Delivery Challan. Distinct from the
  -- slump actually measured later at plant QC (plant_qc.slump_mm) or on
  -- arrival at site (site_qc.arrival_slump_mm).
  specified_slump_mm NUMERIC(5,1),
  pump_departure_time TIME,
  pump_actual_departure_time TIMESTAMPTZ,
  pump_departure_confirmed_by INTEGER REFERENCES users(id),
  pump_departure_delay_reason TEXT,
  -- Site Supervisor confirms the site is ready to receive concrete before the
  -- Plant Operator is allowed to start batching — once per order.
  site_ready_confirmed BOOLEAN DEFAULT false,
  site_ready_confirmed_by INTEGER REFERENCES users(id),
  site_ready_confirmed_at TIMESTAMPTZ,
  site_ready_delay_reason TEXT,
  -- Supervisor's device location at the moment they tapped Site Ready — 99.9%
  -- of the time that's genuinely at the site, making it a fresher geofence
  -- anchor than the site's own saved (and sometimes stale) coordinate. If the
  -- tap location is implausibly far from the site's saved point, it's still
  -- recorded but flagged suspect and the geofence check falls back to the
  -- site's own coordinate instead.
  site_ready_latitude NUMERIC(10,7),
  site_ready_longitude NUMERIC(10,7),
  site_ready_location_suspect BOOLEAN NOT NULL DEFAULT false,
  -- Set the moment an order becomes terminal (completed/closed/cancelled) —
  -- drives the customer tracking link's 3-hour post-completion grace period.
  terminal_at TIMESTAMPTZ,
  -- Site Supervisor's "work completed" is a signal, not a status change — it
  -- doesn't touch `status` (which already has its own meaning driven by
  -- delivered quantity). Manager reviews the signal and explicitly confirms
  -- completion (setting status='completed') before it's actually closed out.
  supervisor_marked_complete BOOLEAN DEFAULT false,
  supervisor_marked_complete_by INTEGER REFERENCES users(id),
  supervisor_marked_complete_at TIMESTAMPTZ,
  after_pour_care_confirmed BOOLEAN,
  work_completion_remarks TEXT,
  original_order_date DATE,
  original_scheduled_batching_time TIME,
  reschedule_reason TEXT,
  rescheduled_by INTEGER REFERENCES users(id),
  rescheduled_at TIMESTAMPTZ,
  remarks TEXT,
  status order_status DEFAULT 'planned',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  -- Manager "close order" (formal cancel when an order will never be completed).
  -- Orders are never deleted; incomplete orders instead carry forward to every
  -- following day automatically until completed or closed here.
  closed_by INTEGER REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closure_reason TEXT,
  -- Manager's confirmed decision at order creation — not automatic, and
  -- snapshotted so a later rate change never silently alters what was
  -- confirmed at the time. amount is what actually gets invoiced.
  pump_charge_applicable BOOLEAN,
  pump_charge_amount NUMERIC(10,2),
  part_load_applicable BOOLEAN,
  part_load_charge_amount NUMERIC(10,2),
  -- Set when a later delivery pushes the order's cumulative quantity across
  -- the pump type's minimum threshold after the pump charge was already
  -- confirmed applicable — flagged for a human to review and decide whether
  -- to reverse it, never auto-corrected on an invoice that may already be
  -- in the customer's hands.
  pump_charge_needs_review BOOLEAN DEFAULT false
);

-- ===================== DELIVERY TICKETS (SRS 6) =====================

ALTER TABLE leads ADD CONSTRAINT leads_won_order_id_fkey FOREIGN KEY (won_order_id) REFERENCES customer_orders(id);
ALTER TABLE bookings ADD CONSTRAINT bookings_converted_order_id_fkey FOREIGN KEY (converted_order_id) REFERENCES customer_orders(id);
ALTER TABLE aftersales_feedback ADD CONSTRAINT aftersales_feedback_order_id_fkey FOREIGN KEY (order_id) REFERENCES customer_orders(id);

-- Rolling demand estimate for an ongoing project — planning only, never
-- becomes an order on its own (that's what a booking is for). One row per
-- order: editing a forecast re-anchors its window to right now, which is how
-- an expired forecast gets "refreshed" rather than needing a new record.
CREATE TABLE sales_forecasts (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) NOT NULL UNIQUE,
  sales_representative_id INTEGER REFERENCES salespersons(id) NOT NULL,
  expected_qty_m3 NUMERIC(10,2) NOT NULL,
  period_days INTEGER NOT NULL,
  confidence VARCHAR(20) NOT NULL, -- confirmed, likely, tentative
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

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
  -- Client-generated, one per form submission (not per retry) — lets a
  -- queued/retried submission from a weak-signal moment at the plant safely
  -- resolve to the same ticket instead of creating a duplicate.
  idempotency_key VARCHAR(64) UNIQUE,
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

-- Saved plant location(s), used as the geofence anchor for auto-detecting
-- Plant Out / Plant In. Exactly one row is is_active at a time (admin-managed
-- via Administrator → Masters → Plant Location).
CREATE TABLE plant_locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL DEFAULT 'Main plant',
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  geofence_radius_m INTEGER NOT NULL DEFAULT 200,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Geofence-detected hints (left_plant, reached_site, left_site,
-- returned_to_plant) — a scheduled check writes here from GPS pings, and the
-- driver/site-supervisor UI surfaces these as a nudge to confirm the real
-- trip_events stage. Never written to trip_events or delivery_tickets.status
-- directly — this table is purely additive, alongside the existing
-- manual-confirmation flow, never replacing it.
CREATE TABLE geofence_events (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES delivery_tickets(id) NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  detected_at TIMESTAMPTZ DEFAULT now(),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  UNIQUE (ticket_id, event_type)
);

-- Great-circle distance in meters — used by the scheduled geofence check.
CREATE OR REPLACE FUNCTION geo_distance_m(lat1 NUMERIC, lon1 NUMERIC, lat2 NUMERIC, lon2 NUMERIC)
RETURNS NUMERIC AS $$
  SELECT 6371000 * 2 * ASIN(SQRT(
    POWER(SIN(RADIANS(lat2 - lat1) / 2), 2) +
    COS(RADIANS(lat1)) * COS(RADIANS(lat2)) * POWER(SIN(RADIANS(lon2 - lon1) / 2), 2)
  ));
$$ LANGUAGE SQL IMMUTABLE;

-- Unauthenticated, token-scoped tracking links customers can be sent — the
-- token itself is the access boundary (no login, no listing, no browsing).
-- Creating a new link for an order auto-revokes any prior active one, so a
-- link shared to the wrong person can be invalidated by generating a fresh
-- one. Stays valid for 3 hours after the order becomes terminal (see
-- customer_orders.terminal_at).
CREATE TABLE order_tracking_links (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES customer_orders(id) NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES users(id)
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

-- Driver duty ON/OFF, tracked per-driver rather than per-ticket. A driver can be
-- on duty (and trackable) with no truck assigned and no delivery ticket created
-- yet — e.g. waiting at the plant, or covering a small site with no formal trip.
CREATE TABLE driver_duty_log (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER REFERENCES users(id) NOT NULL,
  is_on BOOLEAN NOT NULL,
  event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7)
);
CREATE INDEX idx_gps_pings_driver_time ON gps_pings(driver_id, recorded_at);

-- Sales Executive duty/location tracking — a parallel system to the driver
-- one above, not a shared table, since the two roles have different
-- downstream needs (this isn't tied to a delivery ticket).
CREATE TABLE sales_duty_log (
  id SERIAL PRIMARY KEY,
  salesperson_user_id INTEGER REFERENCES users(id) NOT NULL,
  is_on BOOLEAN NOT NULL,
  event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7)
);
CREATE TABLE sales_gps_pings (
  id SERIAL PRIMARY KEY,
  salesperson_user_id INTEGER REFERENCES users(id) NOT NULL,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  accuracy_m NUMERIC(6,2),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_gps_pings_sp_time ON sales_gps_pings(salesperson_user_id, recorded_at);

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

-- One row per fuel filling, for any equipment — a truck, a pump, or (via the
-- equipment table) a pickup van, loader, or generator. Exactly one of
-- truck_id/pump_id/equipment_id is set, matching equipment_type. At least one
-- of odometer_reading/hour_meter_reading is required (enforced in the API,
-- not a DB constraint, to keep this easy to adjust later) — trucks and
-- pickup vans run on odometer, pumps/loaders/generators run on hour meter.
CREATE TABLE fuel_logs (
  id SERIAL PRIMARY KEY,
  equipment_type fuel_equipment_type NOT NULL,
  truck_id INTEGER REFERENCES trucks(id),
  pump_id INTEGER REFERENCES pumps(id),
  equipment_id INTEGER REFERENCES equipment(id),
  odometer_reading NUMERIC(10,2),
  hour_meter_reading NUMERIC(10,2),
  fuel_quantity_litres NUMERIC(7,2) NOT NULL,
  fuel_cost NUMERIC(10,2),
  fuel_station_id INTEGER REFERENCES fuel_stations(id),
  logged_by INTEGER REFERENCES users(id),
  logged_at TIMESTAMPTZ DEFAULT now()
);

-- Lubricants issued internally only — always from Store's own stock, never
-- an external station, so requests for these never carry a fuel_station_id.
CREATE TABLE lubricant_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

-- The request/approve/issue workflow that replaces self-logged fuel_logs
-- entries. A driver or machine operator requests; Manager approves (and can
-- adjust quantity/station); Store issues — at the plant via a single-use QR
-- whose details stay hidden until Store visits the scan link, or at an
-- external station via a shareable approval slip Store never touches.
CREATE TYPE supply_request_type AS ENUM ('fuel', 'lubricant');
CREATE TYPE supply_request_status AS ENUM ('pending', 'approved', 'rejected', 'issued');

CREATE TABLE supply_requests (
  id SERIAL PRIMARY KEY,
  request_type supply_request_type NOT NULL,
  requested_by INTEGER REFERENCES users(id) NOT NULL,
  equipment_type fuel_equipment_type NOT NULL,
  truck_id INTEGER REFERENCES trucks(id),
  pump_id INTEGER REFERENCES pumps(id),
  equipment_id INTEGER REFERENCES equipment(id),
  -- One of these two is required at request time — whichever applies to the
  -- equipment_type — and is the analysis-critical field the old self-logged
  -- flow already captured; this keeps that intact.
  odometer_reading NUMERIC(10,2),
  hour_meter_reading NUMERIC(10,2),
  requested_quantity NUMERIC(7,2) NOT NULL,
  fuel_station_id INTEGER REFERENCES fuel_stations(id), -- fuel requests only; NULL for lubricant
  lubricant_type_id INTEGER REFERENCES lubricant_types(id), -- lubricant requests only
  status supply_request_status DEFAULT 'pending',
  approved_quantity NUMERIC(7,2),
  approved_station_id INTEGER REFERENCES fuel_stations(id), -- Manager can redirect to a different station
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  -- Random, unguessable, single-use — the QR encodes a URL containing this,
  -- and it's cleared the moment Store issues, which is what makes the QR
  -- disappear from the driver's screen and blocks any re-use.
  qr_token VARCHAR(64) UNIQUE,
  issued_by INTEGER REFERENCES users(id),
  issued_at TIMESTAMPTZ,
  actual_quantity_issued NUMERIC(7,2),
  fuel_cost NUMERIC(10,2),
  requested_at TIMESTAMPTZ DEFAULT now()
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
  part_load_charge NUMERIC(12,2) DEFAULT 0,
  waiting_charge NUMERIC(12,2) DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Supports multiple receipts against the same invoice (Additional Recommendations)
-- Pre-existing outstanding balances from before this app was in use — so the
-- accountant dashboard's outstanding/aging figures are accurate from day one,
-- not just reflecting what's happened since go-live. as_of_date lets these
-- slot correctly into the aging report alongside real invoices.
CREATE TABLE customer_opening_balances (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  as_of_date DATE NOT NULL,
  notes TEXT,
  entered_by INTEGER REFERENCES users(id),
  entered_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id),
  opening_balance_id INTEGER REFERENCES customer_opening_balances(id),
  payment_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  mode payment_mode NOT NULL,
  reference_number VARCHAR(100),
  remarks TEXT,
  entered_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT payments_target_check CHECK (
    (invoice_id IS NOT NULL AND opening_balance_id IS NULL) OR
    (invoice_id IS NULL AND opening_balance_id IS NOT NULL)
  )
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
  order_id INTEGER REFERENCES customer_orders(id),
  compliance_document_id INTEGER REFERENCES compliance_documents(id),
  site_id INTEGER REFERENCES sites(id),
  type VARCHAR(50) NOT NULL,  -- left_plant, reached_site, delayed, at_site_over_threshold,
                              -- concrete_rejected, delivery_completed, driver_off_duty_during_trip,
                              -- pump_departure_overdue, batching_not_started, compliance_alert
  message TEXT NOT NULL,
  manager_response TEXT,
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
