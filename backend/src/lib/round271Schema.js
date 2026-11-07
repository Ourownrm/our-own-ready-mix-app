// Round 271 (v11.03) — B2C invoices into Tally (owner, 31 Oct 2026; mock-up
// "B2C Invoices to Tally Mockup", claude/b2c-tally-posting-mockup-v1.md; "Code
// this", 7 Nov 2026).
//
//   - Only B2C invoices (no GSTIN), only from the date set in Tally settings.
//   - The Accountant verifies and approves each one; approval gives it the
//     next Tally voucher number (the owner types the first one; the app counts
//     on; any number can be changed before posting).
//   - "Post to Tally" — and nothing else — sends them. The Tally Bridge, a
//     small program on the Tally computer, relays each request to TallyPrime
//     (port 9000) and hands Tally's answer back.
//
// invoices.tp_state:
//   NULL      to verify (or nothing yet, before the start date)
//   back      sent back with a note (tp_note); still to verify
//   approved  checked, has its number (invoices.tally_invoice_no) and date
//   queued    Post pressed — waiting for the bridge (first: is the number free in Tally?)
//   posting   the bridge has the voucher
//   posted    Tally created the voucher
//   failed    Tally refused (tp_note says why) — Retry, or change the number
//   manual    entered in Tally by hand (before this round, or "Mark as entered")
//
// The voucher number is the Round 251 print number (invoices.tally_invoice_no),
// so the Tally-format print and the Tally voucher always agree.
import { query, pool } from "../db.js";

export const ROUND271_SQL = `
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_state VARCHAR(10);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_note TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_total NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_approved_by INTEGER REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_approved_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_posted_by INTEGER REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_posted_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tp_by_hand BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS ix_invoices_tp_state ON invoices(tp_state) WHERE tp_state IS NOT NULL;

CREATE TABLE IF NOT EXISTS tally_settings (
  id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company            TEXT,
  voucher_type       TEXT NOT NULL DEFAULT 'Sales B2C',
  prefix             VARCHAR(20) NOT NULL DEFAULT '',
  suffix             VARCHAR(20) NOT NULL DEFAULT '',
  next_no            INTEGER,
  series_fy          VARCHAR(7),
  restart_april      BOOLEAN NOT NULL DEFAULT true,
  party_mode         VARCHAR(10) NOT NULL DEFAULT 'cash' CHECK (party_mode IN ('cash','customer')),
  ledgers            JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_date          DATE,
  bridge_token_hash  TEXT,
  bridge_token_at    TIMESTAMPTZ,
  bridge_seen_at     TIMESTAMPTZ,
  bridge_pc          TEXT,
  tally_alive        BOOLEAN,
  check_result       JSONB,
  check_at           TIMESTAMPTZ,
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TIMESTAMPTZ
);
INSERT INTO tally_settings (id, from_date) VALUES (1, CURRENT_DATE) ON CONFLICT (id) DO NOTHING;

-- What the bridge is to send to Tally, and Tally's answer.
CREATE TABLE IF NOT EXISTS tally_jobs (
  id          SERIAL PRIMARY KEY,
  kind        VARCHAR(8) NOT NULL CHECK (kind IN ('exists','post','check')),
  invoice_id  INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  xml         TEXT NOT NULL,
  status      VARCHAR(8) NOT NULL DEFAULT 'new' CHECK (status IN ('new','picked','done','dropped')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_at   TIMESTAMPTZ,
  done_at     TIMESTAMPTZ,
  response    TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS ix_tally_jobs_open ON tally_jobs(status) WHERE status IN ('new','picked');
CREATE INDEX IF NOT EXISTS ix_tally_jobs_invoice ON tally_jobs(invoice_id);
CREATE TABLE IF NOT EXISTS app_migration_marks (mark VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

// Once: a B2C invoice already printed in the Tally format before this round
// was entered in Tally by hand (Round 251's way) — it is "in Tally" already
// and must never be offered for posting.
async function markPrintedOnce(c) {
  const { rows } = await c.query(
    `INSERT INTO app_migration_marks (mark) VALUES ('r271_printed_are_in_tally') ON CONFLICT DO NOTHING RETURNING mark`);
  if (!rows.length) return null;
  const r = await c.query(
    `UPDATE invoices SET tp_state = 'manual', tp_by_hand = true
      WHERE tally_invoice_no IS NOT NULL AND tp_state IS NULL`);
  return r.rowCount;
}

export async function migrateRound271(p, log) {
  await p.query(ROUND271_SQL);
  const n = await markPrintedOnce(p);
  log?.push?.(`Round 271: B2C invoices → Tally (tally_settings, tally_jobs, invoices.tp_*).${n != null ? ` ${n} invoice(s) already printed in the Tally format marked as entered in Tally by hand.` : ""}`);
}

let ready = null;
export function ensureRound271() {
  if (!ready) ready = (async () => { await query(ROUND271_SQL); await markPrintedOnce(pool); })().catch((e) => { ready = null; throw e; });
  return ready;
}
