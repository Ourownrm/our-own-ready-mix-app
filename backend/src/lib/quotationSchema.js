// Round 204 — Accounts module: quotations, customer / site price lists,
// invoices with a GST switch, the customer ledger, receipts from bank
// statements, and the one-time migration of the Accountant's rate file.
//
// THE PRICE LIST IS rate_master. A customer + site + grade price list row is
// exactly what invoicing has always looked up (deliveryConfirmation.js), so
// the price list is not a second copy that could disagree with invoicing —
// accepting a quotation ends the old rate_master rows and writes new ones.
// The columns added here only record WHERE a row came from (the rate file or
// a quotation) and the extra terms a quotation carries.
//
// Rates are GST-INCLUSIVE, as they always were (owner, 11 Oct 2026): an
// invoice total is qty × rate. GST is shown by splitting the total
// (price = total × 100 / 118). An invoice the Accountant marks "no GST" keeps
// the same total and simply drops the tax lines.
//
// Purely additive. Safe to run on every /setup.
import { DEFAULT_TERMS } from "./quotationTerms.js";

export const QUOTATION_SQL = `
CREATE TABLE IF NOT EXISTS quotation_settings (
  id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_serial          INTEGER NOT NULL DEFAULT 1 CHECK (next_serial > 0),
  validity_days        INTEGER NOT NULL DEFAULT 7 CHECK (validity_days > 0),
  director_name        VARCHAR(100) NOT NULL DEFAULT 'NISSAR N.',
  director_title       VARCHAR(60) NOT NULL DEFAULT 'Director',
  director_phone       VARCHAR(40) NOT NULL DEFAULT '+91 9778 166 912',
  signature_image      TEXT,                     -- data URL, uploaded by an Administrator
  defaults             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- default charges and payment terms
  bank_accounts        JSONB NOT NULL DEFAULT '[]'::jsonb,
  rates_locked_at      TIMESTAMPTZ,              -- the rate file migration was completed
  rates_locked_by      INTEGER REFERENCES users(id),
  updated_by           INTEGER REFERENCES users(id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotation_term_library (
  agreement_type  VARCHAR(24) PRIMARY KEY,
  terms           JSONB NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotations (
  id                 SERIAL PRIMARY KEY,
  quote_no           VARCHAR(40) NOT NULL UNIQUE,
  family_no          VARCHAR(40) NOT NULL,      -- the original number every revision shares
  revision           INTEGER NOT NULL DEFAULT 0,
  parent_id          INTEGER REFERENCES quotations(id),
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  site_id            INTEGER NOT NULL REFERENCES sites(id),
  billing_address_id INTEGER REFERENCES customer_billing_addresses(id),
  kind_attention     VARCHAR(150),
  agreement_type     VARCHAR(24) NOT NULL CHECK (agreement_type IN ('cash','pay_after_delivery','credit','credit_qty','price_only')),
  quote_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  validity_days      INTEGER NOT NULL DEFAULT 7 CHECK (validity_days > 0),
  valid_until        DATE,
  status             VARCHAR(20) NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending_approval','approved','sent','accepted','declined','lost','superseded','cancelled')),
  charges            JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment            JSONB NOT NULL DEFAULT '{}'::jsonb,
  rebate_per_m3      NUMERIC(10,2),
  special_conditions TEXT,
  terms              JSONB,
  terms_modified     BOOLEAN NOT NULL DEFAULT false,
  revision_reason    TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at       TIMESTAMPTZ,
  approved_by        INTEGER REFERENCES users(id),
  approved_at        TIMESTAMPTZ,
  approval_note      TEXT,
  sent_at            TIMESTAMPTZ,
  sent_via           VARCHAR(40),
  accepted_at        TIMESTAMPTZ,
  accepted_on        DATE,
  acceptance_mode    VARCHAR(20),               -- signed_copy | email | whatsapp | first_order
  acceptance_proof   TEXT,                      -- data URL of the signed copy / screenshot
  acceptance_proof_name VARCHAR(200),
  rates_from         DATE,                      -- the price list changed from this date
  accepted_by        INTEGER REFERENCES users(id),
  closed_reason      TEXT,                      -- lost / declined / cancelled reason
  closed_by          INTEGER REFERENCES users(id),
  closed_at          TIMESTAMPTZ,
  next_followup_on   DATE,
  reminded_day2_at   TIMESTAMPTZ,
  reminded_day5_at   TIMESTAMPTZ,
  reminded_expiry_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotations_customer_site ON quotations(customer_id, site_id);
CREATE INDEX IF NOT EXISTS idx_quotations_family ON quotations(family_no);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id                SERIAL PRIMARY KEY,
  quotation_id      INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL,
  mix_grade_id      INTEGER REFERENCES mix_grades(id),   -- NULL = an extra item (e.g. waterproofing)
  item_label        VARCHAR(80),                         -- extra item's name when there is no grade
  specification     VARCHAR(200),
  qty_m3            NUMERIC(10,2),
  rate_total        NUMERIC(10,2) NOT NULL CHECK (rate_total > 0),   -- per m³ incl. GST
  proposed_rate     NUMERIC(10,2)                                     -- before an Administrator changed it
);
CREATE INDEX IF NOT EXISTS idx_quotation_lines_q ON quotation_lines(quotation_id);

CREATE TABLE IF NOT EXISTS quotation_events (
  id             SERIAL PRIMARY KEY,
  quotation_id   INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  event          VARCHAR(30) NOT NULL,   -- created, submitted, approved, sent_back, sent, followup, revised, accepted, declined, lost, cancelled, extended, reminder
  note           TEXT,
  contact        VARCHAR(120),
  outcome        VARCHAR(40),
  next_followup_on DATE,
  by_user        INTEGER REFERENCES users(id),
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotation_events_q ON quotation_events(quotation_id, at);

-- Where each price-list (rate_master) row came from.
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS quotation_id INTEGER REFERENCES quotations(id);
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'rate_file';
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS committed_qty_m3 NUMERIC(10,2);
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS rebate_per_m3 NUMERIC(10,2);
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS boom_rate_above_per_m3 NUMERIC(10,2);
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS migration_note TEXT;
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Order charges: the Manager decides; leaving a charge out needs a reason
-- and goes to the Administrator. part_load_basis 'per_load' (new orders):
-- every delivery below the minimum carries its own part load charge on its
-- own invoice. NULL = an order made before this round (charged once, as before).
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS part_load_basis VARCHAR(10);
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_charge_waiver_reason TEXT;
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS part_load_waiver_reason TEXT;
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS charge_review_status VARCHAR(12);   -- pending | accepted | charged
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS charge_reviewed_by INTEGER REFERENCES users(id);
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS charge_reviewed_at TIMESTAMPTZ;
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS charge_review_note TEXT;

-- Invoices: which rate and quotation, and the Accountant's GST switch.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rate_per_m3 NUMERIC(10,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rate_id INTEGER REFERENCES rate_master(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_applied BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_changed_by INTEGER REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_changed_at TIMESTAMPTZ;

-- Receipts as they arrive (one bank credit = one receipt). payments rows stay
-- the allocation of a receipt to an invoice or an opening balance, exactly as
-- before; what a receipt has not allocated is the customer's advance.
CREATE TABLE IF NOT EXISTS customer_receipts (
  id               SERIAL PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  receipt_date     DATE NOT NULL,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  mode             payment_mode NOT NULL,
  reference_number VARCHAR(100),
  bank_account     VARCHAR(60),
  narration        TEXT,
  remarks          TEXT,
  bank_line_id     INTEGER,
  entered_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     INTEGER REFERENCES users(id),
  cancel_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_receipts_customer ON customer_receipts(customer_id, receipt_date);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES customer_receipts(id);

CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id            SERIAL PRIMARY KEY,
  bank_account  VARCHAR(60) NOT NULL,
  file_name     VARCHAR(200),
  period_from   DATE,
  period_to     DATE,
  credit_lines  INTEGER NOT NULL DEFAULT 0,
  skipped_lines INTEGER NOT NULL DEFAULT 0,
  imported_by   INTEGER REFERENCES users(id),
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id                  SERIAL PRIMARY KEY,
  import_id           INTEGER NOT NULL REFERENCES bank_statement_imports(id),
  bank_account        VARCHAR(60) NOT NULL,
  txn_date            DATE NOT NULL,
  narration           TEXT,
  reference           VARCHAR(120),
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  dedupe_key          VARCHAR(300) NOT NULL UNIQUE,
  status              VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','ignored')),
  suggested_customer_id INTEGER REFERENCES customers(id),
  match_level         VARCHAR(8),                -- sure | likely | none
  match_reason        VARCHAR(120),
  receipt_id          INTEGER REFERENCES customer_receipts(id),
  ignored_reason      VARCHAR(120),
  settled_by          INTEGER REFERENCES users(id),
  settled_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bank_lines_status ON bank_statement_lines(status, txn_date);

-- What a customer's bank credits look like (UPI IDs, account names), learned
-- each time a receipt is posted from a statement line, so the next statement
-- matches by itself.
CREATE TABLE IF NOT EXISTS customer_payment_aliases (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  alias        VARCHAR(120) NOT NULL UNIQUE,
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plant Production: an Administrator's decision on a load that went into a
-- JCB or had no vehicle — omit it from the production totals, or count it.
CREATE TABLE IF NOT EXISTS plant_load_reviews (
  plant_no     VARCHAR(50) NOT NULL,
  batch_year   INTEGER NOT NULL,
  batch_no     BIGINT NOT NULL,
  decision     VARCHAR(8) NOT NULL CHECK (decision IN ('omit','keep')),
  note         TEXT,
  reviewed_by  INTEGER REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plant_no, batch_year, batch_no)
);
`;

export const DEFAULT_CHARGES = {
  line_pump_min_qty: 20, line_pump_charge: 6000,
  boom_min_charge: 15000, boom_min_qty: 50, boom_rate_above: 200,
  part_load_min_qty: 5, part_load_rate: 1000,
  waiting_free_hours: 2, waiting_rate: 300,
  extra_cement_rate: 9,
  waterproofing: "on_request", waterproofing_rate: null,
  fiber: "on_request", fiber_rate: null,
};

export const DEFAULT_PAYMENT = {
  advance_pct: 100, pay_within_days: 1, security_cheque: true,
  credit_days: 15, credit_limit: 500000, interest_pct: 18, dispute_hours: 24,
};

export const DEFAULT_BANK_ACCOUNTS = [
  { label: "Account 1", name: "Our Own Ready Mix", number: "022005003275", ifsc: "ICIC0000221", bank: "ICICI Bank, Kasaragod" },
  { label: "Account 2", name: "Our Own Ready Mix", number: "13700200012037", ifsc: "FDRL0001370", bank: "Federal Bank, Kasaragod." },
  { label: "UPI", upi: "ourow28580.ibz@icici" },
];

export async function migrateQuotations(pool, log) {
  await pool.query(QUOTATION_SQL);
  await pool.query(
    `INSERT INTO quotation_settings (id, defaults, bank_accounts, next_serial)
     VALUES (1, $1::jsonb, $2::jsonb, 253)   -- the owner's Excel ends at RMC-QTN-2026-27-0252; editable in Settings
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify({ charges: DEFAULT_CHARGES, payment: DEFAULT_PAYMENT }), JSON.stringify(DEFAULT_BANK_ACCOUNTS)]
  );
  // The terms library: one row per agreement type, seeded once from the Excel.
  for (const [type, terms] of Object.entries(DEFAULT_TERMS)) {
    await pool.query(
      `INSERT INTO quotation_term_library (agreement_type, terms) VALUES ($1, $2::jsonb)
       ON CONFLICT (agreement_type) DO NOTHING`,
      [type, JSON.stringify(terms)]
    );
  }
  // A rate written before this round came from the Accountant's rate file.
  await pool.query(`UPDATE rate_master SET source = 'rate_file' WHERE source IS NULL`);
  log.push("Schema migration applied (Round 204 — Accounts module: quotations, price lists, receipts from bank statements, invoice GST switch, plant load reviews).");
}
