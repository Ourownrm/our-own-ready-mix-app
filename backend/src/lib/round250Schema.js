// Round 250 (v10.82) — owner, 30 Oct 2026: the appointment letter, printed
// from the employee with the employee's details and passport photo, on the
// company letterhead, with the company's standard terms (Ver 3).
//   * hr_employees gains the two details an appointment letter needs that the
//     employee file did not hold: S/o · D/o · W/o and the address.
//   * hr_appointment_letters — one row per letter. A draft can be changed;
//     once issued it is locked (a change means a new letter, new Ref. No.).
//     emp_snapshot freezes the employee's name, code, address etc. at issue,
//     so an issued letter reprints exactly as it was signed.
//   * hr_letter_settings — the default authorised signatory.
export const ROUND250_SQL = `
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS relation_type VARCHAR(4);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS relation_name VARCHAR(120);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS address TEXT;

CREATE TABLE IF NOT EXISTS hr_appointment_letters (
  id                    SERIAL PRIMARY KEY,
  employee_id           INTEGER NOT NULL REFERENCES hr_employees(id),
  ref_no                VARCHAR(40) NOT NULL UNIQUE,
  fy                    VARCHAR(7) NOT NULL,
  seq                   INTEGER NOT NULL,
  issue_date            DATE NOT NULL,
  joining_date          DATE,
  designation           VARCHAR(80),
  department            VARCHAR(80),
  work_location         VARCHAR(120),
  reporting_to          VARCHAR(120),
  probation_months      SMALLINT NOT NULL DEFAULT 3 CHECK (probation_months BETWEEN 0 AND 12),
  notice_probation_days SMALLINT NOT NULL DEFAULT 30 CHECK (notice_probation_days BETWEEN 0 AND 180),
  notice_after_months   SMALLINT NOT NULL DEFAULT 1 CHECK (notice_after_months BETWEEN 0 AND 6),
  salary                JSONB NOT NULL DEFAULT '[]',
  signatory_name        VARCHAR(120),
  signatory_designation VARCHAR(80),
  print_photo           BOOLEAN NOT NULL DEFAULT true,
  template_version      VARCHAR(10) NOT NULL DEFAULT 'Ver 3',
  emp_snapshot          JSONB NOT NULL DEFAULT '{}',
  status                VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            INTEGER REFERENCES users(id),
  updated_at            TIMESTAMPTZ,
  issued_by             INTEGER REFERENCES users(id),
  issued_at             TIMESTAMPTZ,
  cancelled_by          INTEGER REFERENCES users(id),
  cancelled_at          TIMESTAMPTZ,
  UNIQUE (fy, seq)
);
CREATE INDEX IF NOT EXISTS ix_hr_appt_emp ON hr_appointment_letters(employee_id);

CREATE TABLE IF NOT EXISTS hr_letter_settings (
  key   VARCHAR(40) PRIMARY KEY,
  value TEXT
);
INSERT INTO hr_letter_settings (key, value) VALUES
  ('signatory_name', ''), ('signatory_designation', 'Managing Partner'), ('work_location', 'Plant, Kasaragod')
ON CONFLICT (key) DO NOTHING;
`;

let ready = null;
// Used by the routes that touch these tables, so a deploy works before /setup is run.
export async function ensureRound250(q) {
  if (!ready) ready = q(ROUND250_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}

export async function migrateRound250(pool, log) {
  await pool.query(ROUND250_SQL);
  log?.push?.("Round 250: appointment letters (employee S/o and address, letters, default signatory).");
}
