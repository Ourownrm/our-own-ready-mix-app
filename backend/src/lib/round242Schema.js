// Round 242 (v10.74) — owner, 26 Oct 2026. All additive.
//   * Phone attendance: face check per employee (off = location + registered
//     phone only, the camera never opens).
//   * Emergency lock (Super Admin): one switch that stops the whole app for
//     everyone, Administrator included — only each person's own attendance
//     stays open.
//   * Partners: capital brought in / taken back, and unsecured loans from
//     partners (interest from the day borrowed, interest paid, TDS).
//   * Raw-material lab tests: a "schedule starts from" date per test, so a
//     company already running does not get every test since its first load.
export const ROUND242_FACE_SQL = `
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS face_check BOOLEAN NOT NULL DEFAULT true;
`;

export const ROUND242_LOCK_SQL = `
CREATE TABLE IF NOT EXISTS app_lockdown (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_on         BOOLEAN NOT NULL DEFAULT false,
  since         TIMESTAMPTZ,
  reason        VARCHAR(300),
  set_by        INTEGER REFERENCES users(id),
  -- Sign-ins made before this moment no longer work (set when the lock is
  -- lifted with "sign everyone out").
  sessions_after TIMESTAMPTZ
);
INSERT INTO app_lockdown (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS app_lockdown_log (
  id         SERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  action     VARCHAR(20) NOT NULL,
  reason     VARCHAR(300),
  user_id    INTEGER REFERENCES users(id),
  ip         VARCHAR(80)
);
`;

export const ROUND242_PARTNERS_SQL = `
CREATE TABLE IF NOT EXISTS cost_partners (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL UNIQUE,
  match_words VARCHAR(300),
  pan         VARCHAR(12),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cost_partner_settings (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  loan_rate   NUMERIC(6,3) NOT NULL DEFAULT 14,
  tds_rate    NUMERIC(6,3) NOT NULL DEFAULT 10
);
INSERT INTO cost_partner_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS cost_partner_uploads (
  id          SERIAL PRIMARY KEY,
  book        VARCHAR(10) NOT NULL CHECK (book IN ('capital','loan')),
  file_name   VARCHAR(200),
  lines       INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- kind: capital_in / capital_out (capital brought in / returned);
-- loan_in / loan_out (loan borrowed / principal repaid);
-- interest_paid (net paid in amount, TDS beside it, gross = amount + tds);
-- interest_due (interest owed at a start date, typed in once).
CREATE TABLE IF NOT EXISTS cost_partner_txns (
  id          SERIAL PRIMARY KEY,
  partner_id  INTEGER NOT NULL REFERENCES cost_partners(id),
  kind        VARCHAR(14) NOT NULL CHECK (kind IN ('capital_in','capital_out','loan_in','loan_out','interest_paid','interest_due')),
  txn_date    DATE NOT NULL,
  amount      NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  tds         NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (tds >= 0),
  narration   TEXT,
  note        VARCHAR(200),
  upload_id   INTEGER REFERENCES cost_partner_uploads(id),
  dedupe_key  VARCHAR(300) UNIQUE,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_partner_txns ON cost_partner_txns (partner_id, txn_date);
-- Interest rate changes (from a date), for all partners' loans.
CREATE TABLE IF NOT EXISTS cost_partner_rates (
  id          SERIAL PRIMARY KEY,
  from_date   DATE NOT NULL UNIQUE,
  rate        NUMERIC(6,3) NOT NULL CHECK (rate >= 0 AND rate <= 50)
);
`;

// Petrol is a fuel (it was a lubricant type): flagged, so it is shown and
// counted as fuel, and no longer put on job cards as a lubricant.
export const ROUND242_PETROL_SQL = `
ALTER TABLE lubricant_types ADD COLUMN IF NOT EXISTS is_fuel BOOLEAN NOT NULL DEFAULT false;
`;

export const ROUND242_RMTEST_SQL = `
CREATE TABLE IF NOT EXISTS rm_test_settings (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  schedule_from  DATE,
  established    BOOLEAN NOT NULL DEFAULT false,
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TIMESTAMPTZ
);
INSERT INTO rm_test_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
`;
export async function migrateRound242(pool, log) {
  await pool.query(ROUND242_FACE_SQL);
  await pool.query(ROUND242_LOCK_SQL);
  await pool.query(ROUND242_PARTNERS_SQL);
  await pool.query(ROUND242_PETROL_SQL);
  {
    const { rows } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r242_petrol_is_fuel'`).catch(() => ({ rows: [{}] }));
    if (!rows.length) {
      const r = await pool.query(`UPDATE lubricant_types SET is_fuel = true WHERE name ILIKE '%petrol%' AND NOT is_fuel`);
      await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r242_petrol_is_fuel') ON CONFLICT DO NOTHING`);
      log?.push?.(`Round 242: ${r.rowCount} lubricant type(s) named Petrol now counted as fuel.`);
    }
  }
  await pool.query(ROUND242_RMTEST_SQL);
  log?.push?.("Round 242: face check per employee, emergency lock, partners' capital and loans, lab-test schedule start.");
}
