// Round 272 (v11.04) — owner, 7 Nov 2026:
//   1. "Motor workers welfare is to be treated as separate from road tax, same
//      as road tax it is paid for a period and cost to be divided into the
//      months specified." → its own certificate type `welfare_fund`, its own
//      period and its own P&L line. Round 270 kept it on the road tax entry
//      (welfare_fund / welfare_receipt); those are split out once, here.
//   2. Cost › Bank statements: a line can go to a partner — loan received,
//      capital brought in, interest paid (with TDS), loan repaid, capital
//      returned — straight into Cost › Partners.
//   (3. Accounts › Bank receipts hidden — frontend only.)
//   (Tally: a number may repeat until it is in Tally — routes only.)
import { query, pool } from "../db.js";
import { ensurePartners } from "./partners.js";
import { ensureRound270 } from "./round270Schema.js";

export const ROUND272_SQL = `
-- The welfare fund paid in the same bank payment as a road tax: the road tax
-- entry it was paid with (its bill carries both).
ALTER TABLE mnt_certificates ADD COLUMN IF NOT EXISTS paid_with_id INTEGER REFERENCES mnt_certificates(id);

-- A partner entry made (or matched) from a bank statement line.
--   source 'bank'       made by the bank line — removed with it
--   source 'bank-link'  already in Partners (typed / uploaded) — only linked
ALTER TABLE cost_partner_txns ADD COLUMN IF NOT EXISTS source VARCHAR(10);
ALTER TABLE cost_partner_txns ADD COLUMN IF NOT EXISTS source_id INTEGER;
CREATE INDEX IF NOT EXISTS ix_cost_partner_txns_source ON cost_partner_txns(source_id) WHERE source IS NOT NULL;

ALTER TABLE cost_bank_lines DROP CONSTRAINT IF EXISTS cost_bank_lines_treatment_check;
ALTER TABLE cost_bank_lines ADD CONSTRAINT cost_bank_lines_treatment_check
  CHECK (treatment IN ('todo','check','cost','omit','own','loan','tax','asset','capital','personal','pay','cert','partner'));
CREATE TABLE IF NOT EXISTS app_migration_marks (mark VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

// Once: each road tax entry carrying a welfare fund contribution gets a
// separate welfare fund certificate — same vehicle, same period (as it was
// counted until now), the contribution as its fee, the receipt as its number,
// current if the road tax entry is. The road tax entry keeps only road tax.
// Its bill (road tax + contribution) is left as it is.
async function splitWelfareOnce(c) {
  const { rows } = await c.query(
    `INSERT INTO app_migration_marks (mark) VALUES ('r272_welfare_fund_split') ON CONFLICT DO NOTHING RETURNING mark`);
  if (!rows.length) return null;
  const ins = await c.query(
    `INSERT INTO mnt_certificates (asset_id, cert_type, label, number, valid_from, valid_to, authority, fee, status, note,
                                   created_by, created_at, source, source_id, paid_on, paid_with_id)
     SELECT asset_id, 'welfare_fund', NULL, welfare_receipt, valid_from, valid_to, 'Kerala Motor Transport Workers Welfare Fund Board',
            welfare_fund, status, 'Split from the road tax entry it was paid with (Round 272)', created_by, created_at, source, source_id, paid_on, id
       FROM mnt_certificates
      WHERE cert_type = 'road_tax' AND COALESCE(welfare_fund, 0) > 0 AND status <> 'retired'
      ORDER BY id`);
  await c.query(`UPDATE mnt_certificates SET welfare_fund = NULL, welfare_receipt = NULL
                  WHERE cert_type = 'road_tax' AND COALESCE(welfare_fund, 0) > 0 AND status <> 'retired'`);
  return ins.rowCount;
}

export async function migrateRound272(p, log) {
  await ensurePartners();
  await ensureRound270();
  await p.query(ROUND272_SQL);
  const c = await p.connect();
  let n;
  try { await c.query("BEGIN"); n = await splitWelfareOnce(c); await c.query("COMMIT"); }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
  log?.push?.(`Round 272: Motor workers welfare fund as its own certificate; bank lines to partners.${n != null ? ` ${n} welfare fund contribution(s) moved off road tax into their own entries.` : ""}`);
}

let ready = null;
export function ensureRound272() {
  if (!ready) {
    ready = (async () => {
      await ensurePartners();
      await ensureRound270();
      await query(ROUND272_SQL);
      const c = await pool.connect();
      try { await c.query("BEGIN"); await splitWelfareOnce(c); await c.query("COMMIT"); }
      catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
      finally { c.release(); }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
