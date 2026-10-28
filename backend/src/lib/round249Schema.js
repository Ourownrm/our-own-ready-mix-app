// Round 249 (v10.81) — owner, 28 Oct 2026.
//   2. "a partner role, same as admin but only view, no edit option … or option
//      for selected admin user to limit edit and delete access"
//      → users.view_only (middleware/auth.js refuses every write; the
//        permission set keeps only "view").
//   5. "PPE issued to an employee record is required and a request >> approval
//      process for PPE"
//      → hr_ppe_items, hr_ppe_requests (raise → approve / reject → issue),
//        hr_ppe_issues (what each employee holds; returned or not).
//   6. "a flow for when an employee leaves the company, an approval, block
//      from accidental creation of any payment etc."
//      → hr_exits (raise → Admin approves → complete); lib/hrExit.js blocks
//        advances, salary after the last working day, PPE issue, punching.
export const ROUND249_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS view_only BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS hr_ppe_items (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(80) NOT NULL UNIQUE,
  has_size    BOOLEAN NOT NULL DEFAULT false,
  life_months SMALLINT CHECK (life_months IS NULL OR life_months BETWEEN 1 AND 120),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO hr_ppe_items (name, has_size, life_months) VALUES
  ('Safety helmet', false, 24), ('Safety shoes', true, 12), ('Reflective jacket', true, 12),
  ('Hand gloves', false, 1), ('Dust mask', false, 1), ('Safety goggles', false, 12),
  ('Ear plugs', false, 3), ('Gumboots', true, 12), ('Raincoat', true, 12)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS hr_ppe_requests (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES hr_employees(id),
  item_id       INTEGER NOT NULL REFERENCES hr_ppe_items(id),
  qty           SMALLINT NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 50),
  size          VARCHAR(20),
  reason        VARCHAR(12) NOT NULL DEFAULT 'new' CHECK (reason IN ('new','worn_out','damaged','lost')),
  note          VARCHAR(300),
  status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','issued','cancelled')),
  requested_by  INTEGER REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS ix_hr_ppe_req_status ON hr_ppe_requests(status);

CREATE TABLE IF NOT EXISTS hr_ppe_issues (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES hr_employees(id),
  item_id      INTEGER NOT NULL REFERENCES hr_ppe_items(id),
  qty          SMALLINT NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 50),
  size         VARCHAR(20),
  issued_on    DATE NOT NULL,
  request_id   INTEGER REFERENCES hr_ppe_requests(id),
  note         VARCHAR(300),
  issued_by    INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_on  DATE,
  return_note  VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS ix_hr_ppe_issue_emp ON hr_ppe_issues(employee_id);

CREATE TABLE IF NOT EXISTS hr_exits (
  id                SERIAL PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES hr_employees(id),
  kind              VARCHAR(14) NOT NULL CHECK (kind IN ('resignation','termination','retirement','contract_end','absconding','death','other')),
  notice_date       DATE,
  last_working_day  DATE NOT NULL,
  reason            VARCHAR(500),
  status            VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','completed')),
  requested_by      INTEGER REFERENCES users(id),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by        INTEGER REFERENCES users(id),
  decided_at        TIMESTAMPTZ,
  decision_note     VARCHAR(300),
  settlement_note   VARCHAR(500),
  disable_login     BOOLEAN NOT NULL DEFAULT true,
  completed_by      INTEGER REFERENCES users(id),
  completed_at      TIMESTAMPTZ,
  prev_leaving_date DATE
);
-- One open exit per employee at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_exit_open ON hr_exits(employee_id) WHERE status IN ('pending','approved');
`;
export async function migrateRound249(pool, log) {
  await pool.query(ROUND249_SQL);
  log?.push?.("Round 249: view-only accounts (partners), PPE requests and issue register, employee exit with approval.");
}
