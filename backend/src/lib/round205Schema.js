// Round 205 — additive schema (run by /setup).
//
//  * Two prices for one grade at a site (owner's Excel: OPC and OPC + fly
//    ash). Each price-list row carries its option; an order keeps the option
//    the Manager chose. See lib/rateLookup.js.
//  * Quotations imported from the owner's Excel are marked as such.
//  * HR advances: a request (Accountant, one or many employees) → approval
//    (Plant Manager / Admin) → paid. A paid line becomes the hr_advances row
//    payroll already recovers from.
//  * Comp-off taken against a worked off day in one request: the CO leave is
//    tied to its claim, and both are decided together.
export const ROUND205_SQL = `
ALTER TABLE rate_master ADD COLUMN IF NOT EXISTS price_option VARCHAR(200);
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS price_option VARCHAR(200);

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'app';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS import_note TEXT;

CREATE TABLE IF NOT EXISTS hr_advance_requests (
  id            SERIAL PRIMARY KEY,
  purpose       TEXT,
  status        VARCHAR(12) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','cancelled','paid','part_paid')),
  raised_by     INTEGER REFERENCES users(id),
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT
);
CREATE TABLE IF NOT EXISTS hr_advance_request_lines (
  id               SERIAL PRIMARY KEY,
  request_id       INTEGER NOT NULL REFERENCES hr_advance_requests(id) ON DELETE CASCADE,
  employee_id      INTEGER NOT NULL REFERENCES hr_employees(id),
  amount           NUMERIC(10,2) NOT NULL CHECK (amount > 0),       -- asked
  approved_amount  NUMERIC(10,2),                                    -- set on approval (may be lower)
  recover_month    CHAR(7) NOT NULL,
  advance_id       INTEGER REFERENCES hr_advances(id),               -- the payment, once made
  status           VARCHAR(10) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','paid','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_hr_adv_lines_req ON hr_advance_request_lines(request_id);
ALTER TABLE hr_advances ADD COLUMN IF NOT EXISTS request_line_id INTEGER REFERENCES hr_advance_request_lines(id);

ALTER TABLE hr_leaves ADD COLUMN IF NOT EXISTS compoff_claim_id INTEGER REFERENCES hr_compoff_claims(id);
ALTER TABLE hr_compoff_claims ADD COLUMN IF NOT EXISTS for_absence BOOLEAN NOT NULL DEFAULT false;
`;

export async function migrateRound205(pool, log) {
  await pool.query(ROUND205_SQL);
  // Payer names remembered before this round that are really the front of a
  // bank reference code (e.g. "FDRLR" from "RTGS-FDRLR5202…"): they would
  // match every credit from that bank. Removed; the screen now refuses them.
  const { rows: aliases } = await pool.query(`SELECT id, alias FROM customer_payment_aliases`).catch(() => ({ rows: [] }));
  let removed = 0;
  for (const a of aliases) {
    const flat = String(a.alias).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!flat || /\s/.test(String(a.alias).trim())) continue;
    const { rows } = await pool.query(
      `SELECT 1 FROM bank_statement_lines WHERE upper(narration) ~ ('(^|[^A-Z0-9])' || $1 || '[0-9]') LIMIT 1`, [flat]);
    if (rows.length) { await pool.query(`DELETE FROM customer_payment_aliases WHERE id = $1`, [a.id]); removed++; }
  }
  if (removed) log.push(`Round 205 — removed ${removed} remembered payer name(s) that were bank reference codes, not payers.`);
  // Credits from our own accounts still waiting to be posted: set aside.
  const { rowCount: own } = await pool.query(
    `UPDATE bank_statement_lines SET status = 'ignored', ignored_reason = 'Own account transfer', suggested_customer_id = NULL,
            match_level = 'none', match_reason = 'Own account'
      WHERE status = 'open' AND upper(narration) ~ 'OUR ?OWN ?READY ?MIX'`
  ).catch(() => ({ rowCount: 0 }));
  if (own) log.push(`Round 205 — ${own} bank credit(s) from our own accounts set aside as own transfers.`);
  log.push("Schema migration applied (Round 205 — price options per grade, quotation import, advance requests, comp-off requests).");
}
