// Round 216 — putting a job on a vehicle's job card, shared by the
// Maintenance module and the older screens that now feed it:
//   * a driver's or loader operator's breakdown report,
//   * a driver's / loader operator's outside-repair request,
//   * a pump or batching-plant breakdown,
//   * an "Action required" remark on the weekly truck inspection.
// Each finds the vehicle through the maintenance register's link to the
// truck / pump / equipment record. A vehicle not in the register yet gets
// nothing here — the caller keeps the old record, and Maintenance →
// Dashboard → "From the old screens" brings it over once the vehicle is added.
import { pool } from "../db.js";
import { pushToRole } from "./push.js";

export function jobCode(id) {
  return `JC-${String(id).padStart(4, "0")}`;
}

// The open repair card for a vehicle, or a new one. Locked so two submissions
// at the same moment can't each open a card. The monthly general-works card
// (Round 215b) is never used for repairs.
export async function openCardFor(c, assetId, userId, source, sourceId, km) {
  await c.query(`SELECT pg_advisory_xact_lock(215001, $1)`, [assetId]);
  const { rows } = await c.query(`SELECT id FROM mnt_job_cards WHERE asset_id = $1 AND status = 'open' AND general_month IS NULL ORDER BY id LIMIT 1`, [assetId]);
  if (rows.length) return { id: rows[0].id, created: false };
  const ins = await c.query(
    `INSERT INTO mnt_job_cards (asset_id, source, source_id, opened_by, km) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [assetId, source, sourceId, userId, km]
  );
  return { id: ins.rows[0].id, created: true };
}

export async function addJobs(c, cardId, jobs, user) {
  const ids = [];
  for (const j of jobs) {
    const { rows } = await c.query(
      `INSERT INTO mnt_jobs (job_card_id, description, origin, kind, urgency, machine_stopped, raised_by, raised_role, source_type, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [cardId, j.description, j.origin, j.kind === "outside" ? "outside" : "inside", j.urgency || null, !!j.machine_stopped,
        user?.id || null, user?.role || null, j.source_type || null, j.source_id || null]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

/** The active maintenance vehicle linked to a truck / pump / equipment row. */
export async function assetForMaster(q, { truck_id = null, pump_id = null, equipment_id = null, asset_id = null, plant = false }) {
  if (asset_id) return (await q(`SELECT id, name FROM mnt_assets WHERE id = $1 AND is_active`, [asset_id])).rows[0] || null;
  // "The batching plant" (no master row): the register's only Plant machine.
  if (plant) {
    const { rows } = await q(`SELECT id, name FROM mnt_assets WHERE is_active AND asset_group = 'Plant' AND name ILIKE '%batching%' ORDER BY id`);
    return rows.length === 1 ? rows[0] : null;
  }
  if (!truck_id && !pump_id && !equipment_id) return null;
  const { rows } = await q(
    `SELECT id, name FROM mnt_assets WHERE is_active AND (
       ($1::int IS NOT NULL AND truck_id = $1) OR ($2::int IS NOT NULL AND pump_id = $2) OR ($3::int IS NOT NULL AND equipment_id = $3))
     LIMIT 1`, [truck_id, pump_id, equipment_id]);
  return rows[0] || null;
}

/**
 * Put one job on the vehicle's open job card (or a new one). Returns
 * { job_card_id, job_id, asset_name } or null when the vehicle isn't in the
 * maintenance register. Runs in its own transaction.
 */
export async function raiseJob(master, job, user, { source = "complaint", km = null, notifyManager = false } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const asset = await assetForMaster((t, p) => c.query(t, p), master);
    if (!asset) { await c.query("ROLLBACK"); return null; }
    const card = await openCardFor(c, asset.id, user?.id || null, source, null, km);
    const [jobId] = await addJobs(c, card.id, [job], user);
    await c.query("COMMIT");
    if (notifyManager) {
      pushToRole("manager", { title: job.urgency === "breakdown" ? "Breakdown — on a job card" : "New maintenance job", body: `${asset.name}: ${job.description}`, url: `/maintenance-module?tab=job-cards&card=${card.id}` })
        .catch(() => {});
    }
    return { job_card_id: card.id, job_id: jobId, asset_name: asset.name, code: jobCode(card.id) };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Best-effort wrapper for the older screens: never fails their request. */
export async function raiseJobSafe(master, job, user, opts) {
  try {
    return await raiseJob(master, job, user, opts);
  } catch (err) {
    console.error("raise maintenance job:", err.message);
    return null;
  }
}
