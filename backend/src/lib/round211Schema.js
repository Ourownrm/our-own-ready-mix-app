// Round 211 — contract labour: contractors, pump gangs (owner, 15 Oct 2026).
//
//  * hr_contractors — labour contractors: individual or firm, PAN, GST.
//    Individual contract labour (hr_employees, employment_type 'contract')
//    point at one through contractor_id; contractor_name stays filled for
//    older screens.
//  * Pump gangs — a crew of 5/6 paid one monthly amount, which is the sum of
//    each member's own monthly rate (the leader is paid more). Members are
//    hr_employees (contract, with a machine ID — every crew punches the gate
//    machine at the plant each morning); hr_gang_members keeps the history
//    (from / to date) so a man replaced mid-month is counted right.
//  * A gang is NOT fixed to a pump: it is chosen on each pump order
//    (customer_orders.pump_gang_id). A day the gang has no order is a
//    no-pump day — whoever punched in is present and paid; whoever did not is
//    not counted as away.
//  * The Site Supervisor confirms each gang's day (machine punches pre-tick
//    it) and fixes exceptions: hr_gang_marks (Here / Away with a reason) and
//    hr_gang_subs (a substitute the contractor sent).
//  * Month end: no automatic deduction — Admin decides per member
//    (hr_gang_deductions), then the gang's month is closed (hr_gang_months).
//  * Contractor bill per month (gangs + individual labour from payroll),
//    GST if the contractor is registered, TDS on the labour amount; payments
//    and advances in hr_contractor_payments → the contractor ledger.
export const ROUND211_SQL = `
CREATE TABLE IF NOT EXISTS hr_contractors (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  kind           VARCHAR(10) NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual','firm')),
  pan            VARCHAR(10),
  gst_registered BOOLEAN NOT NULL DEFAULT false,
  gstin          VARCHAR(15),
  gst_rate       NUMERIC(5,2) NOT NULL DEFAULT 18,
  phone          VARCHAR(20),
  address        TEXT,
  notes          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_contractors_name ON hr_contractors (LOWER(BTRIM(name)));

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS contractor_id INTEGER REFERENCES hr_contractors(id);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS contract_basis VARCHAR(8) NOT NULL DEFAULT 'daily';
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS monthly_rate NUMERIC(10,2);

CREATE TABLE IF NOT EXISTS hr_gangs (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(60) NOT NULL,
  contractor_id INTEGER NOT NULL REFERENCES hr_contractors(id),
  location      VARCHAR(80),
  min_crew      SMALLINT,
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_gangs_name ON hr_gangs (LOWER(BTRIM(name))) WHERE is_active;

CREATE TABLE IF NOT EXISTS hr_gang_members (
  id           SERIAL PRIMARY KEY,
  gang_id      INTEGER NOT NULL REFERENCES hr_gangs(id),
  employee_id  INTEGER NOT NULL REFERENCES hr_employees(id),
  monthly_rate NUMERIC(10,2) NOT NULL,
  is_leader    BOOLEAN NOT NULL DEFAULT false,
  role         VARCHAR(40),
  from_date    DATE NOT NULL,
  to_date      DATE,
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_date IS NULL OR to_date >= from_date)
);
CREATE INDEX IF NOT EXISTS hr_gang_members_gang ON hr_gang_members (gang_id, from_date);
-- One open membership per person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_gang_member_open ON hr_gang_members (employee_id) WHERE to_date IS NULL;

ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_gang_id INTEGER REFERENCES hr_gangs(id);
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_gang_set_by INTEGER REFERENCES users(id);
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pump_gang_set_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_pump_gang ON customer_orders (pump_gang_id, order_date) WHERE pump_gang_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_gang_days (
  gang_id      INTEGER NOT NULL REFERENCES hr_gangs(id),
  work_date    DATE NOT NULL,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  note         TEXT,
  PRIMARY KEY (gang_id, work_date)
);

CREATE TABLE IF NOT EXISTS hr_gang_marks (
  gang_id     INTEGER NOT NULL REFERENCES hr_gangs(id),
  work_date   DATE NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES hr_employees(id),
  present     BOOLEAN NOT NULL,
  reason      VARCHAR(200),
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  marked_by   INTEGER REFERENCES users(id),
  marked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gang_id, work_date, employee_id)
);

CREATE TABLE IF NOT EXISTS hr_gang_subs (
  id              SERIAL PRIMARY KEY,
  gang_id         INTEGER NOT NULL REFERENCES hr_gangs(id),
  work_date       DATE NOT NULL,
  name            VARCHAR(80) NOT NULL,
  for_employee_id INTEGER REFERENCES hr_employees(id),
  added_by        INTEGER REFERENCES users(id),
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hr_gang_subs_day ON hr_gang_subs (gang_id, work_date);

CREATE TABLE IF NOT EXISTS hr_gang_deductions (
  gang_id     INTEGER NOT NULL REFERENCES hr_gangs(id),
  month       CHAR(7) NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES hr_employees(id),
  days        NUMERIC(4,1) NOT NULL DEFAULT 0 CHECK (days >= 0),
  note        VARCHAR(200),
  decided_by  INTEGER REFERENCES users(id),
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gang_id, month, employee_id)
);

CREATE TABLE IF NOT EXISTS hr_gang_months (
  gang_id     INTEGER NOT NULL REFERENCES hr_gangs(id),
  month       CHAR(7) NOT NULL,
  gross       NUMERIC(12,2) NOT NULL,
  deduction   NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount      NUMERIC(12,2) NOT NULL,
  detail      JSONB NOT NULL,
  closed_by   INTEGER REFERENCES users(id),
  closed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gang_id, month)
);

CREATE TABLE IF NOT EXISTS hr_contractor_bills (
  id                 SERIAL PRIMARY KEY,
  contractor_id      INTEGER NOT NULL REFERENCES hr_contractors(id),
  month              CHAR(7) NOT NULL,
  gangs_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  individual_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable            NUMERIC(12,2) NOT NULL,
  gst_rate           NUMERIC(5,2) NOT NULL DEFAULT 0,
  gst_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  tds_rate           NUMERIC(5,2) NOT NULL DEFAULT 0,
  tds_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  tds_note           VARCHAR(200),
  net_payable        NUMERIC(12,2) NOT NULL,
  their_invoice_no   VARCHAR(40),
  their_invoice_date DATE,
  detail             JSONB NOT NULL,
  status             VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by        INTEGER REFERENCES users(id),
  approved_at        TIMESTAMPTZ,
  UNIQUE (contractor_id, month)
);

CREATE TABLE IF NOT EXISTS hr_contractor_payments (
  id            SERIAL PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES hr_contractors(id),
  bill_id       INTEGER REFERENCES hr_contractor_bills(id),
  paid_on       DATE NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  mode          VARCHAR(20) NOT NULL DEFAULT 'bank_transfer',
  ref           VARCHAR(60),
  note          VARCHAR(200),
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hr_contractor_payments_c ON hr_contractor_payments (contractor_id, paid_on);
`;

export async function migrateRound211(pool, log) {
  await pool.query(ROUND211_SQL);
  // Once: contract workers carry a contractor's name as text — make each name
  // a contractor and link the workers to it.
  const { rows: done } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r211_contractors_from_names'`);
  let made = 0, linked = 0;
  if (!done.length) {
    const ins = await pool.query(
      `INSERT INTO hr_contractors (name, kind)
       SELECT DISTINCT ON (LOWER(BTRIM(contractor_name))) BTRIM(contractor_name), 'individual'
         FROM hr_employees WHERE employment_type = 'contract' AND BTRIM(COALESCE(contractor_name, '')) <> ''
       ON CONFLICT DO NOTHING`);
    made = ins.rowCount;
    const up = await pool.query(
      `UPDATE hr_employees e SET contractor_id = c.id FROM hr_contractors c
        WHERE e.contractor_id IS NULL AND e.employment_type = 'contract'
          AND LOWER(BTRIM(e.contractor_name)) = LOWER(BTRIM(c.name))`);
    linked = up.rowCount;
    await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r211_contractors_from_names') ON CONFLICT DO NOTHING`);
  }
  log.push(`Schema migration applied (Round 211 — contract labour: contractors, pump gangs, gang chosen on each pump order, contractor bills & ledger${made ? `; ${made} contractor(s) made from the names on contract workers, ${linked} worker(s) linked — check each one's PAN, individual/firm and GST` : ""}).`);
}
