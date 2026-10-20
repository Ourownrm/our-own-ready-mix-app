// Round 218 — the Cost module: monthly Cost Dashboard, Profit & Loss and
// Balance Sheet (owner, 20 Oct 2026; mock-up "Monthly Cost Dashboard").
// Administrator only by default.
//
// Most figures are worked out live from what the app already records (see
// lib/costDashboard.js). These tables hold only what the app does NOT record:
//
//   cost_month_entries — the month's expenses Accounts keys in (power bill,
//                        rent, depreciation, interest, tax provision …).
//                        A line not entered counts as 0, and the P&L says so.
//   cost_balances      — Balance Sheet figures Accounts keys in (capital,
//                        loans, fixed assets, bank balance …), dated. A
//                        figure stays in force until a later one is entered.
//   cost_entry_log     — every change to either, with the old and new value.
//
// Additive only; safe to run on every /setup.
const ROUND218_SQL = `
CREATE TABLE IF NOT EXISTS cost_month_entries (
  month       CHAR(7) NOT NULL,
  line_key    VARCHAR(40) NOT NULL,
  amount      NUMERIC(14,2) NOT NULL,
  note        TEXT,
  entered_by  INTEGER REFERENCES users(id),
  entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (month, line_key)
);

CREATE TABLE IF NOT EXISTS cost_balances (
  as_on       DATE NOT NULL,
  line_key    VARCHAR(40) NOT NULL,
  amount      NUMERIC(14,2) NOT NULL,
  note        TEXT,
  entered_by  INTEGER REFERENCES users(id),
  entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (as_on, line_key)
);
CREATE INDEX IF NOT EXISTS idx_cost_balances_key ON cost_balances (line_key, as_on DESC);

CREATE TABLE IF NOT EXISTS cost_entry_log (
  id          SERIAL PRIMARY KEY,
  kind        VARCHAR(8) NOT NULL CHECK (kind IN ('month','balance')),
  period      VARCHAR(10) NOT NULL,
  line_key    VARCHAR(40) NOT NULL,
  old_amount  NUMERIC(14,2),
  new_amount  NUMERIC(14,2),
  note        TEXT,
  changed_by  INTEGER REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_entry_log_period ON cost_entry_log (kind, period);
`;

export async function migrateRound218(pool, log) {
  await pool.query(ROUND218_SQL);
  log?.push?.("Round 218: Cost module — month's entered expenses, Balance Sheet figures, change log.");
}
