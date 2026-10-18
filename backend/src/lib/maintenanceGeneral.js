// Round 215b — lubricants issued to a vehicle land on its job card.
//
// The owner, 18 Oct 2026: "lubricants issue to be in a jobcard of the vehicle
// for general works". Lubricants stay requested / approved / issued in the old
// Fuel & Store flow (supply_requests, store_stock_items); what changes is that
// every ISSUED lubricant request now also shows up — with its cost — on a
// "General works" job card of the vehicle:
//
//   * ONE general-works card per vehicle per month (mnt_job_cards.general_month),
//     with one job "General works — lubricants & top-ups". Every top-up of the
//     month is a line on it (mnt_card_charges). The owner chose this over
//     adding them to whatever repair card is open, so a repair card's cost is
//     the repair only.
//   * The card closes itself when the month is over — nobody marks work done
//     or verifies it. A late entry for a past month still lands on that
//     month's card (closed or not), so the month's cost is right.
//   * The vehicle is found through the maintenance asset's linked truck /
//     pump / equipment row. An issue for a vehicle not linked to an asset yet
//     is picked up the moment it is linked (the sync below is idempotent).
//   * Cost = the amount Store entered at issue (supply_requests.fuel_cost), else
//     quantity × the item's standing rate (store_stock_items.rate_per_liter),
//     else left blank and shown as "no rate".
//
// syncGeneralCharges() is the only writer. It is safe to call any time, any
// number of times: it closes past months' cards, then upserts one charge per
// issued lubricant request since GENERAL_FROM. Callers treat it as
// best-effort — a failure here must never stop fuel or lubricant being issued.
import { pool } from "../db.js";

// Lubricant issues from this date on are charged to job cards (the month the
// Maintenance module went live).
export const GENERAL_FROM = "2026-10-01";
export const GENERAL_JOB = "General works — lubricants & top-ups";

export const ROUND215B_SQL = `
ALTER TABLE mnt_job_cards ADD COLUMN IF NOT EXISTS general_month DATE;
CREATE UNIQUE INDEX IF NOT EXISTS mnt_job_cards_general_month
  ON mnt_job_cards (asset_id, general_month) WHERE general_month IS NOT NULL;

ALTER TABLE mnt_jobs DROP CONSTRAINT IF EXISTS mnt_jobs_origin_check;
ALTER TABLE mnt_jobs ADD CONSTRAINT mnt_jobs_origin_check
  CHECK (origin IN ('not_ok','other','complaint','manual','general'));

-- A cost on a job card that did not come through the maintenance store or an
-- outside repair — today, lubricants issued in the Fuel & Store flow.
CREATE TABLE IF NOT EXISTS mnt_card_charges (
  id            SERIAL PRIMARY KEY,
  job_card_id   INTEGER NOT NULL REFERENCES mnt_job_cards(id),
  job_id        INTEGER REFERENCES mnt_jobs(id),
  asset_id      INTEGER NOT NULL REFERENCES mnt_assets(id),
  source_type   VARCHAR(20) NOT NULL CHECK (source_type IN ('lubricant')),
  source_id     INTEGER NOT NULL,
  description   TEXT NOT NULL,
  qty           NUMERIC(10,2),
  unit          VARCHAR(10),
  amount        NUMERIC(12,2),
  charged_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_mnt_card_charges_card ON mnt_card_charges(job_card_id);
CREATE INDEX IF NOT EXISTS idx_mnt_card_charges_asset ON mnt_card_charges(asset_id, charged_at);
`;

// The first of the current month in IST, as a SQL expression.
const THIS_MONTH = `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date`;

async function closePastMonths(c) {
  const { rows } = await c.query(
    `UPDATE mnt_job_cards SET status = 'closed', work_done_at = COALESCE(work_done_at, now()), verified_at = now()
     WHERE general_month IS NOT NULL AND general_month < ${THIS_MONTH} AND status IN ('open','work_done')
     RETURNING id`);
  if (rows.length) {
    await c.query(`UPDATE mnt_jobs SET status = 'done', done_at = now() WHERE job_card_id = ANY($1::int[]) AND status = 'open'`, [rows.map((r) => r.id)]);
  }
  return rows.length;
}

// The vehicle's general-works card for that month (created on first use).
async function generalCard(c, assetId, month) {
  await c.query(`SELECT pg_advisory_xact_lock(215002, $1)`, [assetId]);
  const found = await c.query(
    `SELECT j.id, (SELECT id FROM mnt_jobs WHERE job_card_id = j.id AND origin = 'general' ORDER BY id LIMIT 1) AS job_id
     FROM mnt_job_cards j WHERE j.asset_id = $1 AND j.general_month = $2::date`, [assetId, month]);
  if (found.rows.length) return found.rows[0];
  const past = await c.query(`SELECT $1::date < ${THIS_MONTH} AS past`, [month]);
  const isPast = past.rows[0].past;
  const ins = await c.query(
    `INSERT INTO mnt_job_cards (asset_id, source, general_month, status, opened_at, work_done_at, verified_at, notes)
     VALUES ($1, 'general', $2::date, $3, now(), $4, $4, 'Lubricants and top-ups issued this month — closes itself at month end')
     RETURNING id`, [assetId, month, isPast ? "closed" : "open", isPast ? new Date() : null]);
  const job = await c.query(
    `INSERT INTO mnt_jobs (job_card_id, description, origin, kind, status, done_at) VALUES ($1, $2, 'general', 'inside', $3, $4) RETURNING id`,
    [ins.rows[0].id, GENERAL_JOB, isPast ? "done" : "open", isPast ? new Date() : null]);
  return { id: ins.rows[0].id, job_id: job.rows[0].id };
}

// Issued lubricant requests since GENERAL_FROM for vehicles linked to an
// active maintenance asset, with what they should cost.
const SOURCE_SQL = `
  SELECT sr.id, a.id AS asset_id, sr.issued_at,
    to_char(date_trunc('month', sr.issued_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS month,
    COALESCE(lt.name, 'Lubricant') AS lub_name,
    sr.actual_quantity_issued AS qty,
    COALESCE(ssi.unit, 'L') AS unit,
    COALESCE(sr.fuel_cost, ROUND(sr.actual_quantity_issued * ssi.rate_per_liter, 2)) AS amount,
    sr.fuel_cost,
    sr.closed_via
  FROM supply_requests sr
  JOIN mnt_assets a ON a.is_active AND (
       (sr.truck_id IS NOT NULL AND a.truck_id = sr.truck_id)
    OR (sr.pump_id IS NOT NULL AND a.pump_id = sr.pump_id)
    OR (sr.equipment_id IS NOT NULL AND a.equipment_id = sr.equipment_id))
  LEFT JOIN lubricant_types lt ON lt.id = sr.lubricant_type_id
  LEFT JOIN store_stock_items ssi ON ssi.item_type = 'lubricant' AND ssi.lubricant_type_id = sr.lubricant_type_id
  WHERE sr.request_type = 'lubricant' AND sr.status = 'issued'
    AND sr.actual_quantity_issued IS NOT NULL
    AND sr.issued_at >= $1::date`;

export async function syncGeneralCharges({ requestId = null } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const closed = await closePastMonths(c);
    const params = [GENERAL_FROM];
    let sql = SOURCE_SQL;
    if (requestId) { params.push(requestId); sql += ` AND sr.id = $2`; }
    const { rows } = await c.query(sql, params);
    // Existing charges, to update a corrected amount without moving the line.
    const { rows: have } = await c.query(
      `SELECT source_id, amount, qty FROM mnt_card_charges WHERE source_type = 'lubricant' AND source_id = ANY($1::int[])`,
      [rows.map((r) => r.id)]);
    const haveBy = new Map(have.map((h) => [h.source_id, h]));
    let added = 0;
    let updated = 0;
    for (const r of rows) {
      const desc = `${r.lub_name} — FR-${r.id}${r.closed_via === "office" ? " (outside, from bill)" : ""}`;
      const h = haveBy.get(r.id);
      if (h) {
        // An amount Store entered always wins (it may have been corrected). An
        // amount worked out from the standing rate is fixed once set, so a
        // later rate change never rewrites a past month's cost.
        const amount = r.fuel_cost != null || h.amount == null ? r.amount : h.amount;
        if (String(h.amount) !== String(amount) || String(h.qty) !== String(r.qty)) {
          await c.query(`UPDATE mnt_card_charges SET qty = $1, amount = $2, description = $3 WHERE source_type = 'lubricant' AND source_id = $4`,
            [r.qty, amount, desc, r.id]);
          updated += 1;
        }
        continue;
      }
      const card = await generalCard(c, r.asset_id, r.month);
      await c.query(
        `INSERT INTO mnt_card_charges (job_card_id, job_id, asset_id, source_type, source_id, description, qty, unit, amount, charged_at)
         VALUES ($1,$2,$3,'lubricant',$4,$5,$6,$7,$8,$9) ON CONFLICT (source_type, source_id) DO NOTHING`,
        [card.id, card.job_id, r.asset_id, r.id, desc, r.qty, r.unit, r.amount, r.issued_at]);
      added += 1;
    }
    await c.query("COMMIT");
    return { closed, added, updated };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// For the Fuel & Store routes: never let a maintenance hiccup fail an issue.
export function chargeLubricantSoon(requestId) {
  syncGeneralCharges({ requestId }).catch((err) => console.error("Lubricant → job card failed:", err.message));
}

export async function migrateRound215b(pool, log) {
  await pool.query(ROUND215B_SQL);
  let note = "";
  try {
    const r = await syncGeneralCharges();
    note = `: ${r.added} lubricant issue(s) since ${GENERAL_FROM} put on general-works job cards`;
  } catch (err) {
    note = ` (lubricant sync failed: ${err.message})`;
  }
  log.push(`Schema migration applied (Round 215b — lubricants on general-works job cards${note}).`);
}
