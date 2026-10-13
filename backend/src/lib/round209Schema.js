// Round 209 — additive schema (run by /setup).
//
//  * Quotation lines carry the mix design (ref / rev) they quote; its "Mix
//    description" fills the line's description (specification).
//  * At acceptance each line is approved or not. Only approved lines become
//    live price-list rows; a not-approved line is kept as a disabled row an
//    Administrator can enable later (at the quoted rate). Price-list rows
//    carry their mix design, so an order batches to the mix that was priced.
//  * Salesperson on each quotation (app only, never printed).
//  * Proposed-rate costing (Administrator only): settings, and on each
//    quotation the fuel basis and the site's road distance.
//  * Employee file: Aadhaar, PAN, driving licence, bank account.
export const ROUND209_SQL = `
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS mix_design_id INTEGER REFERENCES mix_designs(id);
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS approved BOOLEAN;
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS cost_rate NUMERIC(10,2);
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS cost_breakup JSONB;

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS salesperson_id INTEGER REFERENCES salespersons(id);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS fuel_basis VARCHAR(10) NOT NULL DEFAULT 'average';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS site_fuel JSONB;

ALTER TABLE quotation_settings ADD COLUMN IF NOT EXISTS costing JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS mix_design_id INTEGER REFERENCES mix_designs(id);
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS enabled_note TEXT;
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS enabled_changed_by INTEGER REFERENCES users(id);
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS enabled_changed_at TIMESTAMPTZ;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS road_km NUMERIC(6,1);

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS aadhaar_no VARCHAR(12);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pan_no VARCHAR(10);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS dl_no VARCHAR(20);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS dl_valid_till DATE;
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS bank_account_name VARCHAR(120);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS bank_name VARCHAR(80);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS bank_account_no VARCHAR(20);
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(11);
`;

export async function migrateRound209(pool, log) {
  await pool.query(ROUND209_SQL);
  // Quotations already accepted before this round: every line counted as
  // approved, as it did then.
  await pool.query(`UPDATE quotation_lines ql SET approved = true FROM quotations q
                     WHERE q.id = ql.quotation_id AND q.status IN ('accepted', 'superseded') AND ql.approved IS NULL`);
  // Salesperson of existing quotations: the site's assigned salesperson.
  await pool.query(`UPDATE quotations q SET salesperson_id = s.assigned_sales_representative_id
                      FROM sites s WHERE s.id = q.site_id AND q.salesperson_id IS NULL AND s.assigned_sales_representative_id IS NOT NULL`);
  log.push("Schema migration applied (Round 209 — mix designs on quotation lines, approved lines, salesperson, proposed-rate costing, employee ID & bank details).");
}
