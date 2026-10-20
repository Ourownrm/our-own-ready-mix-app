// Round 217 (owner, 20 Oct 2026):
//   * HR leave: a leave of several days can be approved for only some of its
//     days — the leave is split, and each part remembers where it came from.
//   * Weighbridge: a receipt booked against the wrong supplier can be moved
//     to the right one; every change is kept in a correction log.
const ROUND217_SQL = `
ALTER TABLE hr_leaves ADD COLUMN IF NOT EXISTS split_from_id INTEGER REFERENCES hr_leaves(id);

ALTER TABLE weighbridge_tickets ADD COLUMN IF NOT EXISTS supplier_override_id INTEGER REFERENCES rm_suppliers(id);

CREATE TABLE IF NOT EXISTS weighbridge_supplier_corrections (
  id               SERIAL PRIMARY KEY,
  entry_id         INTEGER NOT NULL REFERENCES weighbridge_tickets(ticket_number),
  old_supplier_id  INTEGER,
  new_supplier_id  INTEGER NOT NULL,
  old_name         TEXT,
  new_name         TEXT,
  reason           TEXT NOT NULL,
  corrected_by     INTEGER REFERENCES users(id),
  corrected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wb_supplier_corrections_entry ON weighbridge_supplier_corrections (entry_id);
`;

export async function migrateRound217(pool, log) {
  await pool.query(ROUND217_SQL);
  log?.push?.("Round 217: leave split column, weighbridge supplier correction log.");
}
