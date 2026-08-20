import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { CHECKLIST_SECTIONS, CHECKLIST_ITEM_KEYS, RATING_SCALE, scoreFromRatings } from "../lib/inspectionChecklist.js";

const router = Router();
router.use(requireAuth);

const STAFF_ROLES = ["manager", "administrator"];

// ===================== MAINTENANCE MODULE (round 98, item 10) =====================

// Due list — every active truck x active action point (minus trucks
// currently away at an external workshop, which get one "in_workshop" row
// instead), classified overdue / due_soon / upcoming / never against
// whichever of days-elapsed or hours-of-operation trips first. Hours read
// off the truck's most recent fuel_logs.hour_meter_reading (already
// captured today by the fuel module — no new data entry needed).
router.get("/dashboard", requireRole(...STAFF_ROLES), async (req, res) => {
  const [dueRows, inWorkshop, turnaround] = await Promise.all([
    query(`
      SELECT
        t.id AS truck_id, t.truck_number,
        ap.id AS action_point_id, ap.name AS action_name,
        ap.interval_days, ap.interval_hours,
        ml.done_at AS last_done_at,
        ml.hours_at_service AS last_hours,
        fh.current_hours,
        CASE WHEN ap.interval_days IS NOT NULL AND ml.done_at IS NOT NULL
             THEN (ml.done_at + (ap.interval_days || ' days')::interval)::date
             ELSE NULL END AS due_date,
        CASE WHEN ap.interval_days IS NOT NULL AND ml.done_at IS NOT NULL
             THEN ((ml.done_at + (ap.interval_days || ' days')::interval)::date - CURRENT_DATE)
             ELSE NULL END AS days_remaining,
        CASE WHEN ap.interval_hours IS NOT NULL AND ml.hours_at_service IS NOT NULL AND fh.current_hours IS NOT NULL
             THEN (ml.hours_at_service + ap.interval_hours) - fh.current_hours
             ELSE NULL END AS hours_remaining
      FROM trucks t
      CROSS JOIN maintenance_action_points ap
      LEFT JOIN LATERAL (
        SELECT done_at, hours_at_service FROM maintenance_logs
        WHERE truck_id = t.id AND action_point_id = ap.id
        ORDER BY done_at DESC, id DESC LIMIT 1
      ) ml ON true
      LEFT JOIN LATERAL (
        SELECT hour_meter_reading AS current_hours FROM fuel_logs
        WHERE truck_id = t.id AND hour_meter_reading IS NOT NULL
        ORDER BY logged_at DESC LIMIT 1
      ) fh ON true
      WHERE t.is_active AND ap.is_active
        AND NOT EXISTS (SELECT 1 FROM external_repairs er WHERE er.truck_id = t.id AND er.status = 'sent_out')
      ORDER BY t.truck_number, ap.name
    `),
    query(`
      SELECT er.id, er.truck_id, t.truck_number, er.sent_out_at, er.workshop_name
      FROM external_repairs er JOIN trucks t ON t.id = er.truck_id
      WHERE er.status = 'sent_out'
      ORDER BY t.truck_number
    `),
    query(`
      SELECT AVG(EXTRACT(EPOCH FROM (returned_at - sent_out_at)) / 86400) AS avg_days
      FROM external_repairs WHERE status = 'returned' AND sent_out_at IS NOT NULL AND returned_at IS NOT NULL
    `),
  ]);

  function classify(row) {
    if (!row.last_done_at) return "never";
    const overdue = (row.days_remaining != null && row.days_remaining < 0) || (row.hours_remaining != null && row.hours_remaining < 0);
    if (overdue) return "overdue";
    const dueSoon = (row.days_remaining != null && row.days_remaining <= 7) || (row.hours_remaining != null && row.hours_remaining <= 20);
    if (dueSoon) return "due_soon";
    return "upcoming";
  }

  const dueList = dueRows.rows.map((r) => ({ ...r, status: classify(r) }));
  const workshopList = inWorkshop.rows.map((r) => ({
    truck_id: r.truck_id, truck_number: r.truck_number, status: "in_workshop",
    workshop_name: r.workshop_name, sent_out_at: r.sent_out_at,
  }));

  res.json({
    kpis: {
      overdue: dueList.filter((r) => r.status === "overdue").length,
      due_soon: dueList.filter((r) => r.status === "due_soon").length,
      in_workshop: workshopList.length,
      avg_turnaround_days: turnaround.rows[0].avg_days != null ? Math.round(Number(turnaround.rows[0].avg_days) * 10) / 10 : null,
    },
    due_list: dueList,
    in_workshop: workshopList,
  });
});

// Log a completed maintenance action — resets the due clock for that
// truck+action point (the due-list query above always reads the most
// recent log).
router.post("/logs", requireRole(...STAFF_ROLES), async (req, res) => {
  const { action_point_id, truck_id, done_at, hours_at_service, notes } = req.body;
  if (!action_point_id || !truck_id) {
    return res.status(400).json({ error: "Action point and truck are required." });
  }
  const { rows } = await query(
    `INSERT INTO maintenance_logs (action_point_id, truck_id, done_at, hours_at_service, performed_by, notes)
     VALUES ($1,$2,COALESCE($3, CURRENT_DATE),$4,$5,$6) RETURNING *`,
    [action_point_id, truck_id, done_at || null, hours_at_service || null, req.user.id, notes || null]
  );
  res.status(201).json(rows[0]);
});

// Per-vehicle service history — standard maintenance completions and
// external-workshop repairs, merged into one timeline.
router.get("/vehicle/:truckId/history", requireRole(...STAFF_ROLES), async (req, res) => {
  const truckId = req.params.truckId;
  const [logs, repairs] = await Promise.all([
    query(
      `SELECT ml.done_at AS event_date, ap.name AS title, ml.hours_at_service, ml.notes, u.name AS performed_by_name,
              'maintenance' AS event_type
       FROM maintenance_logs ml
       JOIN maintenance_action_points ap ON ap.id = ml.action_point_id
       LEFT JOIN users u ON u.id = ml.performed_by
       WHERE ml.truck_id = $1
       ORDER BY ml.done_at DESC LIMIT 30`,
      [truckId]
    ),
    query(
      `SELECT er.sent_out_at, er.returned_at, er.issue_description, er.workshop_name, er.status,
              'external_repair' AS event_type
       FROM external_repairs er
       WHERE er.truck_id = $1 AND er.status IN ('sent_out', 'returned')
       ORDER BY er.requested_at DESC LIMIT 30`,
      [truckId]
    ),
  ]);
  const merged = [
    ...logs.rows.map((r) => ({ type: "maintenance", date: r.event_date, title: r.title, meta: [r.performed_by_name, r.hours_at_service ? `${r.hours_at_service} hrs` : null, r.notes].filter(Boolean).join(" · ") })),
    ...repairs.rows.map((r) => ({
      type: "external_repair",
      date: r.sent_out_at,
      end_date: r.returned_at,
      title: `External repair — ${r.issue_description}`,
      meta: [r.workshop_name, r.returned_at ? `Returned ${new Date(r.returned_at).toISOString().slice(0, 10)}` : "Still at workshop"].filter(Boolean).join(" · "),
    })),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  res.json(merged);
});

// ===== External workshop repair flow (sub-requirement 2) =====
router.get("/external-repairs", requireRole(...STAFF_ROLES), async (req, res) => {
  const { rows } = await query(
    `SELECT er.*, t.truck_number, ru.name AS requested_by_name, au.name AS approved_by_name
     FROM external_repairs er
     JOIN trucks t ON t.id = er.truck_id
     JOIN users ru ON ru.id = er.requested_by
     LEFT JOIN users au ON au.id = er.approved_by
     ORDER BY er.requested_at DESC LIMIT 100`
  );
  res.json(rows);
});

router.patch("/external-repairs/:id/approve", requireRole(...STAFF_ROLES), async (req, res) => {
  const { workshop_name } = req.body;
  const { rows } = await query(
    `UPDATE external_repairs SET status = 'approved', approved_by = $1, approved_at = now(), workshop_name = COALESCE($2, workshop_name)
     WHERE id = $3 AND status = 'requested' RETURNING *`,
    [req.user.id, workshop_name || null, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: "This request can no longer be approved (already actioned)." });
  res.json(rows[0]);
});

router.patch("/external-repairs/:id/reject", requireRole(...STAFF_ROLES), async (req, res) => {
  const { rejection_reason } = req.body;
  if (!rejection_reason) return res.status(400).json({ error: "A reason is required to reject a repair request." });
  const { rows } = await query(
    `UPDATE external_repairs SET status = 'rejected', approved_by = $1, approved_at = now(), rejection_reason = $2
     WHERE id = $3 AND status = 'requested' RETURNING *`,
    [req.user.id, rejection_reason, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: "This request can no longer be rejected (already actioned)." });
  res.json(rows[0]);
});

router.patch("/external-repairs/:id/sent-out", requireRole(...STAFF_ROLES), async (req, res) => {
  const { workshop_name } = req.body;
  const { rows } = await query(
    `UPDATE external_repairs SET status = 'sent_out', sent_out_at = now(), workshop_name = COALESCE($1, workshop_name)
     WHERE id = $2 AND status = 'approved' RETURNING *`,
    [workshop_name || null, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: "This repair must be approved first." });
  res.json(rows[0]);
});

router.patch("/external-repairs/:id/returned", requireRole(...STAFF_ROLES), async (req, res) => {
  const { rows } = await query(
    `UPDATE external_repairs SET status = 'returned', returned_at = now()
     WHERE id = $1 AND status = 'sent_out' RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: "This repair isn't currently sent out." });
  res.json(rows[0]);
});

// ===================== DRIVER EVALUATION (round 98, item 11) =====================

router.get("/checklist-definition", requireRole(...STAFF_ROLES), async (req, res) => {
  res.json({ sections: CHECKLIST_SECTIONS, rating_scale: RATING_SCALE });
});

router.post("/inspections", requireRole(...STAFF_ROLES), async (req, res) => {
  const { truck_id, driver_id, cleaner_name, inspection_date, ratings, observations } = req.body;
  if (!truck_id || !ratings) {
    return res.status(400).json({ error: "Truck and the completed checklist are required." });
  }
  const missing = CHECKLIST_ITEM_KEYS.filter((k) => !(k in ratings));
  if (missing.length) {
    return res.status(400).json({ error: `${missing.length} checklist item(s) not yet scored.` });
  }
  const { rows } = await query(
    `INSERT INTO truck_inspections (truck_id, driver_id, cleaner_name, inspection_date, ratings, observations, filled_by)
     VALUES ($1,$2,$3,COALESCE($4, CURRENT_DATE),$5,$6,$7) RETURNING *`,
    [truck_id, driver_id || null, cleaner_name || null, inspection_date || null, JSON.stringify(ratings), observations || null, req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.get("/inspections", requireRole(...STAFF_ROLES), async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.truck_id) { params.push(req.query.truck_id); where = `WHERE ti.truck_id = $${params.length}`; }
  const { rows } = await query(
    `SELECT ti.id, ti.truck_id, t.truck_number, ti.driver_id, d.name AS driver_name, ti.cleaner_name,
            ti.inspection_date, ti.ratings, ti.observations, u.name AS filled_by_name
     FROM truck_inspections ti
     JOIN trucks t ON t.id = ti.truck_id
     LEFT JOIN users d ON d.id = ti.driver_id
     JOIN users u ON u.id = ti.filled_by
     ${where}
     ORDER BY ti.inspection_date DESC, ti.id DESC LIMIT 50`,
    params
  );
  res.json(rows.map((r) => ({ ...r, checklist_score: scoreFromRatings(r.ratings) })));
});

// Best Driver of the Month — composite of four candidate signals confirmed
// with the business: the weekly checklist above, transit efficiency,
// load-quality (inverse rejection rate), and completed-trip volume.
//
// Weights confirmed by the business (round 99): Checklist 40%, Transit
// efficiency (labelled "on_time" in the API/DB for continuity with round 98)
// 15%, Quality 20%, Volume 25%. Easy to retune here if that changes again.
const WEIGHTS = { checklist: 0.40, on_time: 0.15, quality: 0.20, volume: 0.25 };

// Round 99 — "on-time" redefined as transit efficiency, not total time at
// site. Business feedback: how long a truck sits at site depends on site
// conditions (queueing, pump availability, other trucks) — not on the
// driver — so it's unfair to score drivers on it. What IS on the driver is
// the two transit legs: plant-out -> site-in, and site-out -> plant-in.
// Those legs also vary a lot by site (distance/route), so a driver isn't
// scored against a fixed clock — they're scored against how other drivers
// did on trips to the SAME site this month. A ticket only counts toward
// scoring if at least one OTHER driver also has a valid transit reading for
// that site this month (otherwise there's nothing to compare against, and
// the ticket is left out rather than guessed).
//
// NOTE: earlier (round 98) this used trip_events.event_type = 'left_site' as
// the site-out marker, which is never actually written by the app (it only
// ever appears as a geofence *hint* in geofence_events, not a confirmed
// trip_events row) — so on-time was silently always "no data" for every
// driver. Fixed here to use 'unloading_completed', which is the event the
// rest of the app (siteSupervisor.js, tickets.js) already treats as "site
// out".
async function computeTransitRows(year, month, driverIds) {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.driver_id, co.site_id, s.name AS site_name,
            MAX(CASE WHEN te.event_type = 'left_plant' THEN te.event_time END) AS left_plant_at,
            MAX(CASE WHEN te.event_type = 'reached_site' THEN te.event_time END) AS reached_site_at,
            MAX(CASE WHEN te.event_type = 'unloading_completed' THEN te.event_time END) AS site_out_at,
            MAX(CASE WHEN te.event_type = 'returned_to_plant' THEN te.event_time END) AS plant_in_at
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN sites s ON s.id = co.site_id
     JOIN trip_events te ON te.ticket_id = dt.id
     WHERE dt.status IN ('completed', 'returned')
       AND EXTRACT(YEAR FROM dt.ticket_date) = $1 AND EXTRACT(MONTH FROM dt.ticket_date) = $2
       ${driverIds ? "AND dt.driver_id = ANY($3)" : ""}
     GROUP BY dt.id, dt.driver_id, co.site_id, s.name`,
    driverIds ? [year, month, driverIds] : [year, month]
  );

  const out = [];
  for (const r of rows) {
    if (!r.left_plant_at || !r.reached_site_at || !r.site_out_at || !r.plant_in_at) continue; // incomplete timeline — excluded, not guessed
    const outMin = (new Date(r.reached_site_at) - new Date(r.left_plant_at)) / 60000;
    const returnMin = (new Date(r.plant_in_at) - new Date(r.site_out_at)) / 60000;
    if (outMin <= 0 || returnMin <= 0) continue; // bad/out-of-order timestamps — excluded
    out.push({ ticket_id: r.ticket_id, driver_id: r.driver_id, site_id: r.site_id, site_name: r.site_name, out_min: outMin, return_min: returnMin, total_min: outMin + returnMin });
  }
  return out;
}

router.get("/best-driver", requireRole(...STAFF_ROLES), async (req, res) => {
  const { rows: periodRow } = await query(
    `SELECT COALESCE($1::int, EXTRACT(YEAR FROM CURRENT_DATE)::int) AS year,
            COALESCE($2::int, EXTRACT(MONTH FROM CURRENT_DATE)::int) AS month`,
    [req.query.year || null, req.query.month || null]
  );
  const { year, month } = periodRow[0];

  const { rows: drivers } = await query("SELECT id, name FROM users WHERE role = 'driver' AND is_active ORDER BY name");
  if (!drivers.length) return res.json({ year, month, weights: WEIGHTS, ranked: [], unranked: [] });
  const driverIds = drivers.map((d) => d.id);

  const [tripsRes, transitRows, inspectionsRes] = await Promise.all([
    query(
      `SELECT dt.driver_id, COUNT(*) AS trip_count,
              COALESCE(SUM(dt.loaded_quantity_m3), 0) AS loaded_total,
              COALESCE(SUM(sq.rejected_quantity_m3), 0) AS rejected_total
       FROM delivery_tickets dt
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       WHERE dt.driver_id = ANY($1) AND dt.status IN ('completed', 'returned')
         AND EXTRACT(YEAR FROM dt.ticket_date) = $2 AND EXTRACT(MONTH FROM dt.ticket_date) = $3
       GROUP BY dt.driver_id`,
      [driverIds, year, month]
    ),
    computeTransitRows(year, month, driverIds),
    query(
      `SELECT driver_id, ratings FROM truck_inspections
       WHERE driver_id = ANY($1) AND EXTRACT(YEAR FROM inspection_date) = $2 AND EXTRACT(MONTH FROM inspection_date) = $3`,
      [driverIds, year, month]
    ),
  ]);

  // Transit efficiency ("on_time") — each driver is compared only against
  // other drivers who made trips to the SAME site this month (site distance
  // varies too much to use a fixed clock), and only on the two legs that are
  // actually on the driver: plant-out -> site-in and site-out -> plant-in.
  // Site dwell time (site-in -> site-out) is deliberately excluded — that's
  // queueing/pump/site conditions, not the driver.
  const bySite = {};
  for (const r of transitRows) (bySite[r.site_id] ||= []).push(r);

  const onTimeByDriver = {};
  for (const id of driverIds) onTimeByDriver[id] = [];
  for (const siteId of Object.keys(bySite)) {
    const siteRows = bySite[siteId];
    if (siteRows.length < 2) continue; // only this one trip at this site this month — nothing to compare against
    const siteAvg = siteRows.reduce((s, r) => s + r.total_min, 0) / siteRows.length;
    for (const r of siteRows) {
      // 50 = exactly average for this site; +/-100 per 100% faster/slower, clamped 0-100.
      const score = Math.max(0, Math.min(100, 50 + (siteAvg / r.total_min - 1) * 100));
      if (onTimeByDriver[r.driver_id]) onTimeByDriver[r.driver_id].push(score);
    }
  }

  const checklistByDriver = {};
  for (const row of inspectionsRes.rows) {
    const s = scoreFromRatings(row.ratings);
    if (s == null) continue;
    (checklistByDriver[row.driver_id] ||= []).push(s);
  }

  const tripsByDriver = {};
  for (const t of tripsRes.rows) tripsByDriver[t.driver_id] = t;

  const maxTrips = Math.max(1, ...tripsRes.rows.map((t) => Number(t.trip_count)));

  const ranked = [];
  const unranked = [];
  for (const d of drivers) {
    const trip = tripsByDriver[d.id];
    const tripCount = trip ? Number(trip.trip_count) : 0;
    const checklistScores = checklistByDriver[d.id];
    const checklistScore = checklistScores?.length ? Math.round((checklistScores.reduce((s, v) => s + v, 0) / checklistScores.length) * 10) / 10 : null;

    if (tripCount === 0 || checklistScore == null) {
      unranked.push({
        driver_id: d.id, driver_name: d.name, trip_count: tripCount, checklist_score: checklistScore,
        reason: tripCount === 0 && checklistScore == null ? "No completed trips or checklist this month"
          : tripCount === 0 ? "No completed trips this month" : "No weekly checklist filled this month",
      });
      continue;
    }

    const loadedTotal = Number(trip.loaded_total);
    const rejectedTotal = Number(trip.rejected_total);
    const qualityScore = loadedTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - rejectedTotal / loadedTotal) * 1000) / 10)) : 100;

    const onTimeSamples = onTimeByDriver[d.id];
    const onTimeScore = onTimeSamples.length > 0 ? Math.round((onTimeSamples.reduce((s, v) => s + v, 0) / onTimeSamples.length) * 10) / 10 : null;

    const volumeScore = Math.round((tripCount / maxTrips) * 1000) / 10;

    // A driver with no comparable transit data this month (no complete
    // plant-out/site-in/site-out/plant-in timeline, or every site they
    // visited was visited by no one else) has no on-time signal — excluded
    // from that one component rather than guessed, and the composite
    // reweights across the remaining three so a data gap doesn't zero them out.
    const components = { checklist: checklistScore, quality: qualityScore, volume: volumeScore };
    if (onTimeScore != null) components.on_time = onTimeScore;
    const usedWeight = Object.keys(components).reduce((s, k) => s + WEIGHTS[k], 0);
    const composite = Math.round((Object.entries(components).reduce((s, [k, v]) => s + v * WEIGHTS[k], 0) / usedWeight) * 10) / 10;

    ranked.push({
      driver_id: d.id, driver_name: d.name, trip_count: tripCount,
      composite_score: composite,
      checklist_score: checklistScore, on_time_score: onTimeScore, quality_score: qualityScore, volume_score: volumeScore,
    });
  }
  ranked.sort((a, b) => b.composite_score - a.composite_score);

  res.json({ year, month, weights: WEIGHTS, ranked, unranked });
});

// Site Efficiency (round 99) — the business asked for a way to see, per
// site, how long each driver takes on the two driver-controlled transit
// legs (plant-out -> site-in, site-out -> plant-in), so a driver who looks
// slow overall but is simply unlucky on which sites they were assigned can
// be told apart from one who's genuinely slower than peers on the SAME site.
router.get("/site-efficiency", requireRole(...STAFF_ROLES), async (req, res) => {
  const { rows: periodRow } = await query(
    `SELECT COALESCE($1::int, EXTRACT(YEAR FROM CURRENT_DATE)::int) AS year,
            COALESCE($2::int, EXTRACT(MONTH FROM CURRENT_DATE)::int) AS month`,
    [req.query.year || null, req.query.month || null]
  );
  const { year, month } = periodRow[0];

  const transitRows = await computeTransitRows(year, month, null);
  if (!transitRows.length) return res.json({ year, month, sites: [] });

  const driverIds = [...new Set(transitRows.map((r) => r.driver_id))];
  const { rows: driverRows } = await query("SELECT id, name FROM users WHERE id = ANY($1)", [driverIds]);
  const driverName = Object.fromEntries(driverRows.map((d) => [d.id, d.name]));

  const bySite = {};
  for (const r of transitRows) (bySite[r.site_id] ||= { site_name: r.site_name, rows: [] }).rows.push(r);

  const sites = Object.entries(bySite).map(([siteId, { site_name, rows }]) => {
    const siteAvg = rows.reduce((s, r) => s + r.total_min, 0) / rows.length;
    const byDriver = {};
    for (const r of rows) (byDriver[r.driver_id] ||= []).push(r);
    const drivers = Object.entries(byDriver).map(([driverId, dRows]) => {
      const avgOut = dRows.reduce((s, r) => s + r.out_min, 0) / dRows.length;
      const avgReturn = dRows.reduce((s, r) => s + r.return_min, 0) / dRows.length;
      const avgTotal = avgOut + avgReturn;
      return {
        driver_id: Number(driverId),
        driver_name: driverName[driverId] || "—",
        trip_count: dRows.length,
        avg_out_min: Math.round(avgOut),
        avg_return_min: Math.round(avgReturn),
        avg_total_min: Math.round(avgTotal),
        // Positive = faster than this site's average across all drivers.
        vs_site_avg_pct: rows.length > 1 ? Math.round(((siteAvg - avgTotal) / siteAvg) * 1000) / 10 : null,
      };
    });
    drivers.sort((a, b) => a.avg_total_min - b.avg_total_min);
    return { site_id: Number(siteId), site_name, trip_count: rows.length, site_avg_total_min: Math.round(siteAvg), drivers };
  });
  sites.sort((a, b) => a.site_name.localeCompare(b.site_name));

  res.json({ year, month, sites });
});

export default router;
