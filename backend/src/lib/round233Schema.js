// Round 233 — attendance on the phone inside a WORKING AREA (owner, 23 Oct
// 2026): "punch in with a perimeter (e.g. 50 km) working area, location
// registered when they tap; location off → warning; outside → warning."
export const ROUND233_SQL = `
ALTER TABLE hr_employees DROP CONSTRAINT IF EXISTS hr_employees_app_punch_check;
ALTER TABLE hr_employees ADD CONSTRAINT hr_employees_app_punch_check CHECK (app_punch IN ('off','plant','anywhere','area'));
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_area_km NUMERIC(6,1);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_area_location_id INTEGER REFERENCES hr_work_locations(id);
ALTER TABLE hr_app_punches ADD COLUMN IF NOT EXISTS kind VARCHAR(3) CHECK (kind IN ('in','out'));
ALTER TABLE hr_app_punches ADD COLUMN IF NOT EXISTS warning VARCHAR(20) CHECK (warning IN ('no_location','outside_area','inaccurate'));
ALTER TABLE hr_app_punches ADD COLUMN IF NOT EXISTS warning_note VARCHAR(200);
ALTER TABLE hr_app_punches ADD COLUMN IF NOT EXISTS warning_seen_by INTEGER REFERENCES users(id);
ALTER TABLE hr_app_punches ADD COLUMN IF NOT EXISTS warning_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS hr_app_punches_warning ON hr_app_punches (punched_at) WHERE warning IS NOT NULL;
`;
export async function migrateRound233(pool, log) {
  await pool.query(ROUND233_SQL);
  log?.push?.("Round 233: phone attendance inside a working area (km), location warnings.");
}

