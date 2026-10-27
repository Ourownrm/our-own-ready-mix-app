// Round 245 (v10.77) — owner, 27 Oct 2026. All additive.
//   * Partners: the sheet import made a second partner for every name spelt
//     differently ("Ajith Kumar" / "AJITH KUMAR P. V"); taking the upload back
//     left those partners behind. A partner now remembers the upload that made
//     it (taking that upload back removes it when it has no entries left), and
//     partners can be merged or removed.
//   * Water: a cost per kilolitre for the plant's own water, and purchased
//     water (tanker loads) with their bills, for the cost dashboard.
export const ROUND245_PARTNER_SQL = `
ALTER TABLE cost_partners ADD COLUMN IF NOT EXISTS made_by_upload INTEGER;
`;
export const ROUND245_WATER_SQL = `
CREATE TABLE IF NOT EXISTS cost_water_settings (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  own_rate_kl   NUMERIC(10,2),              -- ₹ per kilolitre (1,000 L) of the plant's own water
  own_note      VARCHAR(200),
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMPTZ
);
INSERT INTO cost_water_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
-- Own-water rate changes, from a date.
CREATE TABLE IF NOT EXISTS cost_water_rates (
  id          SERIAL PRIMARY KEY,
  from_date   DATE NOT NULL UNIQUE,
  rate_kl     NUMERIC(10,2) NOT NULL CHECK (rate_kl >= 0),
  note        VARCHAR(200)
);
-- Purchased water: a tanker load (or a month's bill) bought.
CREATE TABLE IF NOT EXISTS cost_water_purchases (
  id           SERIAL PRIMARY KEY,
  bought_on    DATE NOT NULL,
  supplier     VARCHAR(120),
  litres       NUMERIC(12,1) NOT NULL CHECK (litres > 0),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  bill_no      VARCHAR(60),
  note         VARCHAR(200),
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_water_purchases ON cost_water_purchases (bought_on);
`;
// HR money audit trail: every change to an advance or a payroll figure —
// who, when, what it was, what it became, and why.
export const ROUND245_HR_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS hr_money_audit (
  id           SERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      INTEGER REFERENCES users(id),
  entity       VARCHAR(20) NOT NULL,      -- advance | payroll_line | payroll_month | salary_payment
  entity_id    INTEGER,
  employee_id  INTEGER REFERENCES hr_employees(id),
  month        CHAR(7),
  action       VARCHAR(20) NOT NULL,      -- created | changed | removed | locked | unlocked | paid | payment_cleared
  before       JSONB,
  after        JSONB,
  reason       VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS idx_hr_money_audit_month ON hr_money_audit (month, at DESC);
`;
export async function migrateRound245(pool, log) {
  await pool.query(ROUND245_PARTNER_SQL);
  await pool.query(ROUND245_HR_AUDIT_SQL);
  await pool.query(ROUND245_WATER_SQL);
  log?.push?.("Round 245: partners merge / remove; HR money audit trail; water cost (own water rate, purchased water).");
}
