// Round 197 — HR module, stage 1 (employees, shifts, roster, holidays).
// Run from /setup; the same statements are at the end of schema.sql for a
// fresh database. Purely additive; safe to run any number of times.
//
// What is stored and what is not: attendance itself (Present / Half day /
// Absent / Missed punch) is NOT stored — it is worked out on request from the
// machine punches (attendance_punches, Round 195) and the sales app check-ins
// (sales_duty_log) by lib/hrAttendance.js, so a corrected roster or shift
// re-reads the whole month correctly. Payroll (stage 2) will freeze a month
// when it is processed.

export const HR_SQL = `
CREATE TABLE IF NOT EXISTS hr_departments (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(80) NOT NULL UNIQUE,
  is_direct  BOOLEAN NOT NULL DEFAULT true,   -- makes or delivers concrete (for the manpower cost split)
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

-- A shift. end_time earlier than start_time means it ends the next morning.
CREATE TABLE IF NOT EXISTS hr_shifts (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(60) NOT NULL UNIQUE,
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  grace_min    INTEGER NOT NULL DEFAULT 10 CHECK (grace_min BETWEEN 0 AND 180),
  full_day_min INTEGER NOT NULL DEFAULT 420 CHECK (full_day_min BETWEEN 60 AND 1440),
  half_day_min INTEGER NOT NULL DEFAULT 240 CHECK (half_day_min BETWEEN 30 AND 1440),
  is_active    BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS hr_employees (
  id                 SERIAL PRIMARY KEY,
  emp_code           VARCHAR(20) NOT NULL UNIQUE,
  name               VARCHAR(120) NOT NULL,
  mobile             VARCHAR(20),
  department_id      INTEGER REFERENCES hr_departments(id),
  designation        VARCHAR(80),
  employment_type    VARCHAR(10) NOT NULL DEFAULT 'payroll' CHECK (employment_type IN ('payroll','contract')),
  contractor_name    VARCHAR(120),
  date_of_joining    DATE,
  date_of_leaving    DATE,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  -- attendance
  attendance_source  VARCHAR(10) NOT NULL DEFAULT 'machine' CHECK (attendance_source IN ('machine','app','none')),
  machine_user_id    VARCHAR(30),           -- the number enrolled on the eSSL machine
  app_user_id        INTEGER REFERENCES users(id),  -- app login: sales check-in, driver trips
  policy             VARCHAR(12) NOT NULL DEFAULT 'office' CHECK (policy IN ('office','operations')),
  default_shift_id   INTEGER REFERENCES hr_shifts(id),
  weekly_off         SMALLINT CHECK (weekly_off BETWEEN 0 AND 6),  -- 0 = Sunday; NULL = no fixed weekly off
  trip_allowance     BOOLEAN NOT NULL DEFAULT false,
  -- pay (behind hr.salary)
  salary_basic       NUMERIC(10,2),
  salary_da          NUMERIC(10,2),
  salary_hra         NUMERIC(10,2),
  salary_conveyance  NUMERIC(10,2),
  salary_special     NUMERIC(10,2),
  pf_applicable      BOOLEAN NOT NULL DEFAULT true,
  esi_applicable     BOOLEAN NOT NULL DEFAULT true,
  daily_rate         NUMERIC(10,2),         -- contract workers
  service_charge_pct NUMERIC(5,2),          -- contractor's charge on top of wages
  incentive_basis    VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (incentive_basis IN ('none','plant_production','own_sales')),
  incentive_min_m3   NUMERIC(10,2),         -- no incentive until this much is reached in the month
  incentive_rate     NUMERIC(10,2),         -- rupees per m3 above the minimum (or per m3 of own sales)
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TIMESTAMPTZ
);
-- One active person per machine number, and per app login.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_emp_machine_active ON hr_employees(machine_user_id) WHERE is_active AND machine_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_emp_appuser_active ON hr_employees(app_user_id) WHERE is_active AND app_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_holidays (
  holiday_date DATE PRIMARY KEY,
  name         VARCHAR(80) NOT NULL
);

-- The manager's plan for operations staff: a shift, or a day off, per person per day.
CREATE TABLE IF NOT EXISTS hr_roster (
  employee_id INTEGER NOT NULL REFERENCES hr_employees(id),
  work_date   DATE NOT NULL,
  shift_id    INTEGER REFERENCES hr_shifts(id),
  is_off      BOOLEAN NOT NULL DEFAULT false,
  set_by      INTEGER REFERENCES users(id),
  set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, work_date),
  CHECK (is_off OR shift_id IS NOT NULL)
);
`;

const DEFAULT_DEPARTMENTS = [
  ["Plant operations", true], ["Transit mixer drivers", true], ["Pump operators & helpers", true],
  ["QC lab", true], ["Maintenance", true], ["Sales & marketing", false],
  ["Admin, accounts & stores", false], ["Security & housekeeping", false],
];

export async function migrateHr(pool, log) {
  await pool.query(HR_SQL);
  // Starting lists, only into empty tables — the Administrator edits them after.
  const { rows: d } = await pool.query(`SELECT count(*)::int AS n FROM hr_departments`);
  if (!d[0].n) {
    for (const [i, [name, direct]] of DEFAULT_DEPARTMENTS.entries()) {
      await pool.query(`INSERT INTO hr_departments (name, is_direct, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [name, direct, i + 1]);
    }
  }
  const { rows: s } = await pool.query(`SELECT count(*)::int AS n FROM hr_shifts`);
  if (!s[0].n) {
    await pool.query(
      `INSERT INTO hr_shifts (name, start_time, end_time, grace_min, full_day_min, half_day_min)
       VALUES ('Office 9 to 5', '09:00', '17:00', 10, 420, 240) ON CONFLICT DO NOTHING`
    );
  }
  const { rows: e } = await pool.query(`SELECT count(*)::int AS n FROM hr_employees`);
  log.push(`Schema migration applied (Round 197 — HR module stage 1: employees, shifts, roster, holidays). ${e[0].n} employee(s) on record.`);
}
