// Round 210 — additive schema (run by /setup).
//
//  * Sales contacts: the people a Sales Executive meets (site engineers,
//    clients, consultants, contractors …) are kept in the Sales module's own
//    list, not in the customer master. A visit can be logged against a
//    contact; a contact can later be linked to the real billing customer.
//  * customers.created_via — 'sales' for a customer a Sales Executive added
//    (from a booking), so the Administrator can see where it came from.
//  * Customer and site names in CAPITALS — existing names converted once.
export const ROUND210_SQL = `
CREATE TABLE IF NOT EXISTS sales_contacts (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(150) NOT NULL,
  contact_type        VARCHAR(30)  NOT NULL DEFAULT 'other',
  organisation        VARCHAR(200),
  phone               VARCHAR(20),
  notes               TEXT,
  linked_customer_id  INTEGER REFERENCES customers(id),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_contacts_name ON sales_contacts (LOWER(name));

ALTER TABLE customer_visits ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES sales_contacts(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_via VARCHAR(20);
`;

export async function migrateRound210(pool, log) {
  await pool.query(ROUND210_SQL);
  const c = await pool.query(`UPDATE customers SET name = UPPER(BTRIM(name)) WHERE name <> UPPER(BTRIM(name))`);
  const s = await pool.query(`UPDATE sites SET name = UPPER(BTRIM(name)) WHERE name <> UPPER(BTRIM(name))`);
  log.push(`Schema migration applied (Round 210 — sales contacts; customer & site names in capitals: ${c.rowCount} customer(s), ${s.rowCount} site(s) converted).`);
}
