-- Our Own Ready Mix — Database Schema
-- PostgreSQL. Covers all SRS sections 2-16 including Pump, Fuel, Reports, Audit trail.

CREATE TYPE user_role AS ENUM (
  'administrator', 'manager', 'plant_operator', 'qc_engineer',
  'driver', 'site_supervisor', 'accountant', 'sales_executive', 'store',
  'lab_technician'
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
  -- Round 101, item 1: how long to wait after GPS detects the truck has left
  -- the plant before auto-recording Plant Out if the driver never responds
  -- to the notification. NULL means "use the system default" (12 minutes,
  -- see scheduledChecks.js PLANT_OUT_DEFAULT_GRACE_MINUTES) — set per-site
  -- because a 15-minute-travel-time site needs a shorter grace window than a
  -- flat 12-minute default would allow, per business request.
  plant_out_grace_minutes INTEGER,
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
  -- Round 119: 'staff' (default, created by Manager/Admin or a Sales
  -- Executive as before) or 'public_inquiry' (submitted with no login via
  -- the public /inquiry page — see routes/publicInquiry.js). A public
  -- inquiry lands with assigned_to NULL; Manager/Admin assigns it to a
  -- salesperson afterward via PATCH /sales/leads/:id/assign.
  source VARCHAR(20) NOT NULL DEFAULT 'staff',
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
  -- Round 119, post-ship — free-text extras from the expanded public
  -- "Request a Quote" form (mix requirement, timeline) and the new "Free
  -- Technical Assistance" form (routes/publicInquiry.js's POST / and POST
  -- /technical-assistance) — both public, no-login intake forms that create
  -- a lead the same way. Technical-assistance submissions prefix this with
  -- the topic chip the person picked (e.g. "[Free Technical Assistance —
  -- Choosing a grade]") since there's no separate column for that — one
  -- more discriminator on top of source felt like overkill for a value only
  -- ever read by a human on the lead detail screen.
  notes TEXT,
  -- Round 119, post-ship again round 3 — purely cosmetic per-lead dismiss for
  -- the Manager Dashboard's Customer Inquiries card (PATCH
  -- /sales/leads/:id/dashboard-hide). Completely independent of `status` —
  -- actually closing/marking a lead lost only ever happens via the existing
  -- POST /sales/leads/:id/lost, from the Leads page. Business explicitly
  -- reversed an earlier round's "Close" button on the dashboard card itself.
  dashboard_hidden BOOLEAN NOT NULL DEFAULT false,
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
  -- Round 115: an activity_type = 'site_visit' update now requires the same
  -- structured questionnaire used on the Visits tab (is_new_project + the
  -- matching NEW_PROJECT/RUNNING_PROJECT answer set) — can't be marked
  -- "Site visit done" with nothing behind it. When answered, a
  -- customer_visits row is created alongside this activity log entry (same
  -- follow-up generation as a visit logged directly), and related_visit_id
  -- (added below, once customer_visits exists) points at it.
  is_new_project BOOLEAN,
  answers JSONB,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Round 100, item 4 — a customer booking link: an unguessable token scoped to
-- exactly one customer + one site (same pattern as order_tracking_links
-- below), shared with a customer who already has a signed supply agreement.
-- Opening it lets them submit a booking request without logging in.
-- tracking_enabled is independent of is_active — Manager/Admin can turn the
-- live delivery-status view on/off for a link without revoking the booking
-- link itself (revoke kills both, since without the link there's nothing to
-- show either way).
CREATE TABLE customer_booking_links (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  site_id INTEGER REFERENCES sites(id) NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,
  tracking_enabled BOOLEAN NOT NULL DEFAULT false,
  -- Round 119, post-ship (per the business's own mockup) — this row is now
  -- ALSO the single per-customer+site home for the customer portal's
  -- feature switches, not just the public tracking view. The mockup's own
  -- wording: "Tracking already exists today (Customer Booking -> Links) —
  -- carried forward as-is. QC Reports and Technical Writings are new
  -- columns on the SAME table, switched per customer+site rather than one
  -- global on/off." A customer's /portal access code can cover several
  -- sites (customer_access_token_sites); for each order, the effective
  -- allow_tracking/allow_qc_reports/allow_technical_writings is resolved
  -- from THIS table's row for that order's own (customer_id, site_id) —
  -- see requireCustomerAuth in routes/customerPortal.js. A site with no
  -- active link row here shows nothing (all three effectively false,
  -- matching tracking_enabled's own existing default-false convention) —
  -- Manager needs to generate a link for a site before a portal code
  -- covering it will show anything for that site. This supersedes
  -- customer_access_tokens.allow_tracking/allow_qc_reports/
  -- allow_technical_writings below, which are no longer read anywhere
  -- (left in place rather than dropped, to avoid a destructive migration).
  allow_qc_reports BOOLEAN NOT NULL DEFAULT true,
  allow_technical_writings BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by INTEGER REFERENCES users(id),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_customer_booking_links_token ON customer_booking_links(token);
CREATE INDEX idx_customer_booking_links_customer_site ON customer_booking_links(customer_id, site_id);

-- Round 119 — the customer portal: a short, human-typeable access code
-- (6-10 chars, generated server-side) scoped to one customer and one or
-- more of their sites, that a customer types into /portal to sign in and
-- see their own orders + QC reports (mix design / cube test PDFs). Unlike
-- customer_booking_links above (one link per customer+site, opened by
-- tapping a URL), this is deliberately a short *code* a Manager reads out
-- or sends over their own phone (SMS/WhatsApp/call) — the business
-- explicitly did not want a bare shareable link here, since anyone holding
-- the link/URL could open it; a code still has to be typed in by the
-- person it was given to, and can cover several sites in one code instead
-- of needing a separate link per site. See routes/customerPortal.js (the
-- public sign-in + data side) and routes/customerAccess.js (Manager/Admin
-- side: generate, list, revoke).
CREATE TABLE customer_access_tokens (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  token VARCHAR(12) UNIQUE NOT NULL,
  label VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Post-ship (round 119): per-code capability switches, business asked to
  -- be able to switch off specific portal capabilities per customer. These
  -- three columns are now VESTIGIAL — round 119 post-ship (per the
  -- business's own mockup) moved this control onto customer_booking_links
  -- above instead (one row per customer+SITE, matching the mockup exactly),
  -- since a single access code can cover several sites and the business
  -- wanted control at the site level, visible on the same table as the
  -- existing "Booking Links & Requests" screen. Left in place rather than
  -- dropped (no destructive migration), but nothing reads them any more —
  -- see routes/customerBooking.js's PATCH /:id/permissions and
  -- routes/customerPortal.js's requireCustomerAuth for the real thing.
  allow_tracking BOOLEAN NOT NULL DEFAULT true,
  allow_qc_reports BOOLEAN NOT NULL DEFAULT true,
  allow_technical_writings BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES users(id),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_customer_access_tokens_token ON customer_access_tokens(token);
CREATE INDEX idx_customer_access_tokens_customer ON customer_access_tokens(customer_id);

-- Many-to-many: one access code can cover several sites for the same
-- customer (e.g. a head-office contact who should see every active
-- project), which a single customer_booking_links row can't express since
-- that's scoped to exactly one site.
CREATE TABLE customer_access_token_sites (
  token_id INTEGER REFERENCES customer_access_tokens(id) ON DELETE CASCADE NOT NULL,
  site_id INTEGER REFERENCES sites(id) NOT NULL,
  PRIMARY KEY (token_id, site_id)
);

-- Post-ship (round 119, per the business's own mockup) — a small document
-- library: PDF guides/articles (e.g. "After-pour care", "Choosing the
-- right grade for slabs vs. footings") that Manager/Admin uploads and
-- categorizes, shown to customers whose access code has
-- allow_technical_writings on. This is the FIRST place this app stores an
-- uploaded file's actual bytes — no S3/external object storage is set up
-- anywhere else, so file_data is a plain BYTEA. That's a fine trade-off at
-- this app's scale (a handful of small PDFs, not per-order attachments —
-- see the app's Known Limitations note on file attachments generally) but
-- worth revisiting with real object storage if this library grows large or
-- a future round needs per-order photo/file attachments too.
CREATE TABLE technical_documents (
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
CREATE INDEX idx_technical_documents_category ON technical_documents(category);

-- Round 119, post-ship — editable copy for the public marketing pages (per
-- the business's own mockup): "Services, Products & Equipment" and
-- "Ready-Mix vs. Site-Mix" comparison. One JSONB blob per page (key =
-- 'services' or 'rmc_vs_sitemix') rather than a fully normalized set of
-- tables — this is marketing copy a Manager/Admin edits occasionally
-- through a form (routes/siteContent.js), not transactional data anything
-- else in the app joins against, so a flexible blob is the right amount of
-- structure. Seeded with the mockup's own copy at setup time (see
-- routes/setup.js) so the public pages aren't empty before anyone edits
-- them. Read is public/unauthenticated (routes/siteContent.js's GET);
-- write is Manager/Admin only.
CREATE TABLE site_content (
  key VARCHAR(40) PRIMARY KEY,
  content JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A booking is a lighter-weight commitment than a real order — placed either
-- by a Sales Executive, or (round 100) by a customer themselves via a
-- customer_booking_links token (booking_link_id set, requested_by NULL in
-- that case). It sits pending until Manager confirms site readiness and
-- payment terms, then converts it into a real customer_orders row.
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
  requested_by INTEGER REFERENCES users(id), -- NULL for a customer-submitted booking (see booking_link_id)
  booking_link_id INTEGER REFERENCES customer_booking_links(id),
  pump_requirement pump_type,
  casting_location VARCHAR(200),
  site_contact_name VARCHAR(150),
  site_contact_number VARCHAR(20),
  remarks TEXT,
  status booking_status DEFAULT 'pending',
  converted_order_id INTEGER, -- FK to customer_orders added below, once that table exists
  declined_reason TEXT,
  -- Round 119, post-ship — a THIRD way a booking can originate, alongside
  -- requested_by (Sales Executive, phone/in person) and booking_link_id (the
  -- public, no-login /book/:token page). This one is a customer's own
  -- "Order Concrete" self-service request, submitted while signed in at
  -- /portal with their access code (routes/customerPortal.js's POST
  -- /orders) — requested_by and booking_link_id are both NULL for these,
  -- same as a booking-link submission, so this flag is what tells the
  -- Manager/Admin queue (lib/SalesPanels.jsx's BookingsQueue) and reports
  -- apart from that case rather than leaving both indistinguishable.
  submitted_via_portal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TYPE feedback_type AS ENUM ('compliment', 'complaint');

CREATE TABLE aftersales_feedback (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) NOT NULL,
  order_id INTEGER, -- FK to customer_orders added below, once that table exists
  feedback_type feedback_type NOT NULL,
  comment TEXT NOT NULL,
  -- Round 119, post-ship again — a customer can now log their own feedback
  -- from a new "Feedback" screen in the customer portal (routes/
  -- customerPortal.js's POST /feedback), not just a Sales Executive logging
  -- it on the customer's behalf after a visit. recorded_by is nullable for
  -- exactly that case (no staff user did the recording); submitted_by_customer
  -- distinguishes it from a hypothetical future NULL for some other reason.
  -- rating is the star rating (1-5) the customer picks; feedback_type above
  -- is derived from it server-side (kept as a real column rather than
  -- computed from rating every read, since staff-logged feedback has no
  -- rating at all and still needs a feedback_type).
  recorded_by INTEGER REFERENCES users(id),
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  submitted_by_customer BOOLEAN NOT NULL DEFAULT false,
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

ALTER TABLE lead_followups ADD COLUMN related_visit_id INTEGER REFERENCES customer_visits(id);

-- Round 115: a running log of what was actually done against one follow-up
-- task, without closing it out (that's still what marking it "done" is for).
-- Several of these can accumulate against the same visit_followups row —
-- e.g. "called, no answer, will retry" then "called again, asked for 2 more
-- days" — so a customer/visit's open follow-ups read as a thread with a
-- history, not a single reminder that either exists or doesn't.
CREATE TABLE followup_actions (
  id SERIAL PRIMARY KEY,
  followup_id INTEGER REFERENCES visit_followups(id) NOT NULL,
  note TEXT NOT NULL,
  next_due_date DATE,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_followup_actions_followup ON followup_actions(followup_id);

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
  -- Round 119, post-ship again — round 6: when the customer actually needs
  -- concrete AT SITE, as distinct from scheduled_batching_time (when the
  -- plant starts batching). The two differ by travel time — a customer
  -- asking for 8 AM at a far site needs batching well before 8 AM. This is
  -- what's shown to the CUSTOMER (portal/tracking); scheduled_batching_time
  -- stays the internal plant-facing time. Nullable — older orders and any
  -- order placed before this column existed simply fall back to showing
  -- scheduled_batching_time to the customer instead.
  required_at_site_time TIME,
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
  -- Round 119, post-ship again — same idea as assigned_site_supervisor_id
  -- above, for QC Engineer: business feedback was that the "your team on
  -- this order" card in the customer portal always showed the same QC
  -- Engineer (picked by role, see resolveOrderContacts in
  -- routes/customerPortal.js), even though there's more than one QC
  -- Engineer on staff. NULL means "no specific QC Engineer assigned to this
  -- order" and the app falls back to the old role-based pick, same as
  -- before this column existed — set/changed from Administrator/Manager's
  -- Correct Order screen.
  assigned_qc_engineer_id INTEGER REFERENCES users(id),
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
  pump_charge_needs_review BOOLEAN DEFAULT false,
  -- Round 118: the mix design this order actually resolved to at creation
  -- time (via mix_design_assignments, falling back to the grade's standard
  -- design) — snapshotted here so history stays accurate even if the
  -- assignment or standard design changes later. Nullable: an order created
  -- before any mix design existed for its grade, or before this feature
  -- existed at all, simply has none. The customer never picks this directly —
  -- they only ever pick mix_grade_id above.
  resolved_mix_design_id INTEGER
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
  -- Round 101, item 1: set when the driver taps "Not yet" on the geofence
  -- popup for this exact hint — the plant-out grace period (see sites.
  -- plant_out_grace_minutes) counts from here instead of detected_at when
  -- present, since the driver has actively said "not yet, still here."
  last_response_at TIMESTAMPTZ,
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
  entered_at TIMESTAMPTZ DEFAULT now(),
  -- Round 119, post-ship again round 3 — set by checkSiteOutAutoRecord
  -- (scheduledChecks.js) when Site Out was GPS-auto-recorded because the
  -- driver never responded to the geofence hint within the grace period.
  -- Slump/delivery-note-status/after-pour-care are left at their defaults in
  -- that case (not guessed at) — this flag is what lets Manager/QC see the
  -- gap and follow up. Never set true by the driver's own manual Site Out
  -- submission.
  auto_confirmed BOOLEAN NOT NULL DEFAULT false
);

-- ===================== MIX DESIGNS & CUBE TESTING (round 118) =====================
-- New Lab Technician role, separate from QC Engineer. QC Engineer keeps doing
-- plant-side fresh-concrete QC (slump/temp/cube casting) exactly as before —
-- plant_qc.sample_ids/number_of_cubes above is unchanged and is what a cube
-- test "batch" here reuses (plant_qc.id is the batch identifier; no new
-- casting-time capture is added). Lab Technician owns everything downstream:
-- recording the actual compressive-strength test results at 7/28 days, and
-- maintaining the mix design library those results (and the customer-facing
-- PDF reports) are built from.
--
-- A mix design is deliberately NOT tied 1:1 to a customer at creation — one
-- design is routinely shared by several customers (or is the plain "standard"
-- design for a grade, used when nothing more specific is assigned). See
-- mix_design_assignments below for how a customer/grade resolves to a design.
CREATE TABLE mix_designs (
  id SERIAL PRIMARY KEY,
  mix_grade_id INTEGER REFERENCES mix_grades(id) NOT NULL,
  design_ref_code VARCHAR(40) NOT NULL UNIQUE,
  mix_description VARCHAR(200),
  fck_28day_mpa NUMERIC(5,1) NOT NULL,
  std_deviation_mpa NUMERIC(4,1) NOT NULL,
  -- f'ck + 1.65sigma, generated so this can never drift from its inputs.
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
  -- Baseline aggregate moisture/absorption captured at design time — the
  -- daily field-correction reading a real batching system would apply is
  -- deliberately out of scope this round (see README); these are the values
  -- printed on the mix design PDF's own note, not a live-updated feed.
  fine_moisture_pct NUMERIC(4,1),
  fine_absorption_pct NUMERIC(4,1),
  coarse_20mm_moisture_pct NUMERIC(4,1),
  coarse_20mm_absorption_pct NUMERIC(4,1),
  coarse_12_5mm_moisture_pct NUMERIC(4,1),
  coarse_12_5mm_absorption_pct NUMERIC(4,1),
  -- The default design for its grade when no customer-specific assignment
  -- exists. Only one design per grade can hold this (see the partial unique
  -- index below), and only an approved design can hold it.
  is_standard_for_grade BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  revision VARCHAR(10) NOT NULL DEFAULT '00',
  notes TEXT,
  created_by INTEGER REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deliberately a second, different user from created_by — enforced in the
  -- API, not here, since "different from created_by" isn't expressible as a
  -- plain column constraint. A draft shows "Pending approval" until this is set.
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_mix_designs_standard_per_grade ON mix_designs(mix_grade_id)
  WHERE is_standard_for_grade = true AND status = 'approved';

-- customer_orders.resolved_mix_design_id (declared as a plain INTEGER above,
-- since mix_designs is defined after customer_orders in this file) gets its
-- FK here, same forward-reference pattern used for sites/leads/bookings above.
ALTER TABLE customer_orders ADD CONSTRAINT customer_orders_resolved_mix_design_id_fkey
  FOREIGN KEY (resolved_mix_design_id) REFERENCES mix_designs(id);

-- A mix design can carry more than one admixture (e.g. a superplasticizer
-- plus a retarder) — one row per admixture, ordered for display.
CREATE TABLE mix_design_admixtures (
  id SERIAL PRIMARY KEY,
  mix_design_id INTEGER REFERENCES mix_designs(id) ON DELETE CASCADE NOT NULL,
  type_brand VARCHAR(120) NOT NULL,
  dosage_pct_of_binder NUMERIC(5,2),
  qty_kgm3 NUMERIC(6,2) NOT NULL,
  sp_gr NUMERIC(4,2),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_mix_design_admixtures_design ON mix_design_admixtures(mix_design_id);

-- Which design a customer's order for a given grade actually resolves to.
-- One row per customer+grade — changing it is an update, not a new row, so
-- "025-B" here can be (and typically is) pointed at by several different
-- customer rows at once; that's what makes a design "shared". No row for a
-- customer+grade means the grade's is_standard_for_grade design applies.
CREATE TABLE mix_design_assignments (
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

-- A cube test result for one cube batch (plant_qc row) at one testing age.
-- Cubes from the same batch are almost always tested together (per-cube rows
-- below), so this is the "result set", not a single cube.
CREATE TABLE cube_test_results (
  id SERIAL PRIMARY KEY,
  plant_qc_id INTEGER REFERENCES plant_qc(id) NOT NULL,
  testing_age_days INTEGER NOT NULL CHECK (testing_age_days IN (7, 28)),
  -- Snapshotted so the report always shows the target strength that applied
  -- at test time, even if the design is revised later.
  mix_design_id INTEGER REFERENCES mix_designs(id),
  average_weight_kg NUMERIC(6,3),
  average_load_kn NUMERIC(7,2),
  average_density_kgm3 NUMERIC(7,1),
  average_strength_mpa NUMERIC(6,2),
  -- Optional — how the batch failed under load (e.g. "Cone", "Shear",
  -- "Columnar"), per IS 516. Free text, not an enum: the lab technician
  -- records what they actually observed, and this varies test to test, so
  -- (unlike casting location / curing method, which are fixed for every
  -- batch in this app) it genuinely needs to be captured, not defaulted.
  failure_type VARCHAR(60),
  remarks TEXT,
  tested_by INTEGER REFERENCES users(id) NOT NULL,
  tested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plant_qc_id, testing_age_days)
);

CREATE TABLE cube_test_cubes (
  id SERIAL PRIMARY KEY,
  cube_test_result_id INTEGER REFERENCES cube_test_results(id) ON DELETE CASCADE NOT NULL,
  cube_label VARCHAR(40) NOT NULL,
  weight_kg NUMERIC(6,3),
  testing_load_kn NUMERIC(7,2),
  density_kgm3 NUMERIC(7,1),
  strength_mpa NUMERIC(6,2),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cube_test_cubes_result ON cube_test_cubes(cube_test_result_id);

-- Some cube batches never actually get tested (cubes damaged, order cancelled,
-- etc.) — closing one here is purely a dashboard/workflow marker so it stops
-- cluttering the Lab Technician's active list; it does not touch plant_qc or
-- any cube_test_results row. One row per batch that's ever been closed;
-- reopening deletes the row rather than tracking a history of open/close
-- cycles. A batch's overall "active / completed / closed" bucket is computed
-- in the API (closed here, else both ages done = completed, else active) —
-- not stored, so it can never drift from the underlying test results.
CREATE TABLE cube_batch_status (
  plant_qc_id INTEGER PRIMARY KEY REFERENCES plant_qc(id),
  status VARCHAR(20) NOT NULL DEFAULT 'closed' CHECK (status = 'closed'),
  closed_reason TEXT,
  closed_by INTEGER REFERENCES users(id) NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  -- Free-text location kept for pump/plant breakdowns (reported by staff who
  -- aren't standing at a truck's exact GPS point). Round 99: no longer set
  -- by the driver truck-breakdown flow, which now relies solely on
  -- latitude/longitude auto-captured at submit time — see issue_type below.
  location TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  -- Round 99, item 3 — picklist value from breakdownIssueTypes.js (driver
  -- flow only; NULL for pump/plant reports which don't use the picklist).
  issue_type VARCHAR(40),
  remarks TEXT,
  resolved BOOLEAN DEFAULT FALSE,
  repaired_by INTEGER REFERENCES users(id),
  repaired_at TIMESTAMPTZ
);

-- ===================== MAINTENANCE MODULE (round 98, item 10) =====================
-- Preventive/scheduled maintenance, complementary to the purely reactive
-- breakdown_reports above. Action points apply uniformly to every active
-- truck (no per-vehicle overrides in this first version) and trip on
-- whichever of interval_days / interval_hours comes first — hours read off
-- the truck's most recent fuel_logs.hour_meter_reading.

CREATE TABLE maintenance_action_points (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  interval_days INTEGER,
  interval_hours INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_logs (
  id SERIAL PRIMARY KEY,
  action_point_id INTEGER NOT NULL REFERENCES maintenance_action_points(id),
  truck_id INTEGER NOT NULL REFERENCES trucks(id),
  done_at DATE NOT NULL DEFAULT CURRENT_DATE,
  hours_at_service NUMERIC(10,2),
  performed_by INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_maintenance_logs_truck_action ON maintenance_logs(truck_id, action_point_id, done_at DESC);

-- Sub-requirement 2 — driver requests an external-workshop repair, Manager
-- approves, sent-out/returned timestamps logged. A truck sitting at
-- 'sent_out' is excluded from Plant Operator's ticket-creation truck list
-- (sub-requirement 3) — see GET /master/trucks?exclude_in_repair=true.
CREATE TYPE external_repair_status AS ENUM ('requested', 'approved', 'rejected', 'sent_out', 'returned');

CREATE TABLE external_repairs (
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
CREATE INDEX idx_external_repairs_status ON external_repairs(status);
CREATE INDEX idx_external_repairs_truck ON external_repairs(truck_id);

-- ===================== DRIVER EVALUATION (round 98, item 11) =====================
-- The digitized "Transit Mixer Weekly Inspection Checklist" — filled by
-- Manager (confirmed by the business, not Plant Operator despite the source
-- PDF's own "Plant In-Charge Signature" label). ratings is keyed by the
-- ~36 fixed item keys in backend/src/lib/inspectionChecklist.js, each
-- 1 (Poor) .. 4 (Very Good). Feeds the Checklist component of Best Driver
-- of the Month, alongside on-time/quality/volume computed from existing
-- trip data.
CREATE TABLE truck_inspections (
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
CREATE INDEX idx_truck_inspections_truck_date ON truck_inspections(truck_id, inspection_date DESC);

-- Round 101, item 2: an "Action required" remark against a specific
-- checklist item on a weekly inspection becomes an open maintenance action
-- point to follow up on — separate from maintenance_action_points (the
-- fixed, recurring master list like "Oil change every 90 days"), since these
-- are ad-hoc findings from a specific inspection ("Front tyres — worn,
-- needs replacement") rather than a scheduled recurring task.
CREATE TABLE inspection_action_items (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES truck_inspections(id),
  truck_id INTEGER NOT NULL REFERENCES trucks(id),
  item_key VARCHAR(80) NOT NULL,
  item_label VARCHAR(200) NOT NULL,
  remark TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open', -- open | resolved
  raised_by INTEGER NOT NULL REFERENCES users(id),
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT
);
CREATE INDEX idx_inspection_action_items_status ON inspection_action_items(status, truck_id);

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
