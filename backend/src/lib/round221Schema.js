// Round 221 (owner, 21 Oct 2026):
//   * Break-even page — which group (fixed / variable) each cost is in, an
//     Administrator setting (lib/breakEven.js).
//   * HR — a photo on each employee record. Kept in its own table so the
//     employee list (SELECT e.*) never carries the images.
import { ROUND221_SQL as BREAK_EVEN_SQL } from "./breakEven.js";

const ROUND221_SQL = `
${BREAK_EVEN_SQL}
CREATE TABLE IF NOT EXISTS hr_employee_photos (
  employee_id  INTEGER PRIMARY KEY REFERENCES hr_employees(id),
  photo        BYTEA NOT NULL,
  mime         VARCHAR(30) NOT NULL,
  thumb        BYTEA,                    -- 96 px JPEG for the employee list
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrateRound221(pool, log) {
  await pool.query(ROUND221_SQL);
  log?.push?.("Round 221: break-even cost groups, employee photos.");
}
