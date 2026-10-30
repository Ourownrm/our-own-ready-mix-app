// Round 252 (v10.84) — owner, 30 Oct 2026.
//   * Credit notes (app series CN/26-27/00001): raised by Accounts against an
//     invoice — concrete returned / rejected at site, rate correction,
//     discount, other — approved by Admin; only an APPROVED note changes the
//     customer's ledger. From 1 Oct 2026 a partial return no longer cuts the
//     invoice down; it is flagged for a credit note instead.
//   * Recipes the plant no longer has are hidden (plant_recipes.in_plant).
//   * Quotation acceptance can be recorded with a comment instead of a file.
export const CREDIT_NOTES_FROM = "2026-10-01";

export const ROUND252_SQL = `
CREATE TABLE IF NOT EXISTS credit_notes (
  id               SERIAL PRIMARY KEY,
  cn_no            VARCHAR(30) NOT NULL UNIQUE,
  fy               VARCHAR(7) NOT NULL,
  seq              INTEGER NOT NULL,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id),
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  cn_date          DATE NOT NULL,
  reason           VARCHAR(12) NOT NULL CHECK (reason IN ('return','rate','discount','other')),
  qty_m3           NUMERIC(8,2),
  rate_incl        NUMERIC(10,2),
  total_amount     NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  gst_applied      BOOLEAN NOT NULL DEFAULT true,
  base_amount      NUMERIC(12,2) NOT NULL,
  cgst             NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst             NUMERIC(12,2) NOT NULL DEFAULT 0,
  note             VARCHAR(500),
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  raised_by        INTEGER REFERENCES users(id),
  raised_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by       INTEGER REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  decision_note    VARCHAR(300),
  UNIQUE (fy, seq)
);
CREATE INDEX IF NOT EXISTS ix_cn_invoice ON credit_notes(invoice_id);
CREATE INDEX IF NOT EXISTS ix_cn_customer ON credit_notes(customer_id) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS ix_cn_status ON credit_notes(status);

-- A returned load from 1 Oct 2026 on: the invoice stays at the full delivered
-- quantity and this flag asks Accounts for a credit note (credit_note_needed
-- stays the old, pre-October flag).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS return_credit_due BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS acceptance_comment VARCHAR(500);

ALTER TABLE plant_recipes ADD COLUMN IF NOT EXISTS in_plant BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE plant_recipes ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
`;

let ready = null;
export function ensureRound252(q) {
  if (!ready) ready = q(ROUND252_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
// Round 252 — the legend text some banks print after the last entry (ICICI
// "Legends Used in Account Statement …") had been joined onto that entry's
// narration. Cut it off on the lines already uploaded, with their duplicate
// key worked out again so a re-upload of the same statement still matches.
export const LEGEND_CUT = /\s*(legends?\s+used|abbreviations?\s+used|this is (a|an) (computer|system)[- ]generated|end of (the )?statement)\b.*$/i;
export async function cleanLegendLines(pool, dedupeKey) {
  const { rows } = await pool.query(
    `SELECT id, account_id, txn_date::text AS date, narration, debit, credit, balance FROM cost_bank_lines
      WHERE narration ~* '(legends?\\s+used|abbreviations?\\s+used|end of (the )?statement)'`).catch(() => ({ rows: [] }));
  let n = 0;
  for (const r of rows) {
    const narration = r.narration.replace(LEGEND_CUT, "").trim();
    if (narration === r.narration) continue;
    const key = dedupeKey(r.account_id, { ...r, narration });
    await pool.query(`UPDATE cost_bank_lines SET narration = $1, dedupe_key = $2 WHERE id = $3`, [narration, key, r.id])
      .catch(() => pool.query(`UPDATE cost_bank_lines SET narration = $1 WHERE id = $2`, [narration, r.id]));
    n++;
  }
  return n;
}

export async function migrateRound252(pool, log) {
  await pool.query(ROUND252_SQL);
  try {
    const { dedupeKey } = await import("./bankBook.js");
    const n = await cleanLegendLines(pool, dedupeKey);
    if (n) log?.push?.(`Round 252: legend text removed from ${n} bank line(s).`);
  } catch (e) { console.error("round 252 legend clean", e.message); }
  log?.push?.("Round 252: credit notes with Admin approval; returns flagged for a credit note; recipes the plant no longer has hidden.");
}

// Approved credit notes, for the money sums everywhere (receivables, GST).
export const APPROVED_CN = `(SELECT * FROM credit_notes WHERE status = 'approved')`;
