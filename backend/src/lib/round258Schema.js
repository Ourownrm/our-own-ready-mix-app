// Round 258 (v10.90) — owner, 1 Nov 2026:
//  1. Taking the "Cash" mark off an invoice whose cash a holder has already
//     accepted needs that holder's approval (cl_untick_requests). Cash not
//     yet accepted (waiting / rejected / paid to bank) goes straight away.
//  2. C Ledger shows who sent an invoice / receipt there, with their role
//     (cl_deliveries.created_by already; cl_collections.sent_by for receipts).
//  3. (label only) Accounts → Invoices column "Cash".
//  4. Quotation → "Project completed": an accepted quotation is closed when
//     the project is done; its price list ends on that day (no new orders);
//     it can be reopened, which restores those price-list rows.
import { query } from "../db.js";

export const ROUND258_SQL = `
ALTER TABLE cl_collections ADD COLUMN IF NOT EXISTS sent_by INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS cl_untick_requests (
  id             SERIAL PRIMARY KEY,
  invoice_id     INTEGER NOT NULL,
  delivery_id    INTEGER NOT NULL REFERENCES cl_deliveries(id),
  holder_id      INTEGER NOT NULL REFERENCES users(id),
  amount         NUMERIC(12,2) NOT NULL,
  reason         VARCHAR(300),
  requested_by   INTEGER REFERENCES users(id),
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_at     TIMESTAMPTZ,
  reject_reason  VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS ix_cl_untick_holder ON cl_untick_requests(holder_id, status);
CREATE INDEX IF NOT EXISTS ix_cl_untick_invoice ON cl_untick_requests(invoice_id, status);

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('draft','pending_approval','approved','sent','accepted','declined','lost','superseded','cancelled','completed'));
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS completed_on DATE;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS completed_rate_ids INTEGER[];
`;

let ready = null;
export function ensureRound258() {
  if (!ready) ready = query(ROUND258_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound258(pool, log) {
  await pool.query(ROUND258_SQL);
  log?.push?.("Round 258: un-ticking a Cash invoice needs the cash holder's OK once accepted; who sent it shown in C Ledger; quotation → Project completed.");
}

export const ROLE_LABEL = {
  super_admin: "Super Admin", administrator: "Administrator", manager: "Manager", plant_operator: "Plant Operator",
  qc_engineer: "QC Engineer", driver: "Driver", site_supervisor: "Site Supervisor", accountant: "Accountant",
  sales_executive: "Sales Executive", store: "Store", lab_technician: "Lab Technician", loader_operator: "Loader Operator",
  plant_in_charge: "Plant In Charge",
};
export const roleLabel = (r) => ROLE_LABEL[r] || String(r || "").replace(/_/g, " ");
