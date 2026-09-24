import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { istDay, istMonth, istDaysAgo, daysElapsedIn } from "../lib/istDate.js";

const router = Router();
router.use(requireAuth);

const STAFF_ROLES = ["manager", "administrator"];

// ===== 360-degree fuel analysis (round 134, item 8) =====
// Data source note: fuel fills are captured via `supply_requests`
// (request -> approve -> issue), NOT the older `fuel_logs` table — the
// latter has no frontend caller anywhere in this app and is effectively
// dead. `supply_requests` is the only place odometer_reading,
// hour_meter_reading, actual_quantity_issued and which station (plant vs
// outside pump) a fill came from are all captured together, which is what
// this feature needs.
//
// Two views:
//   GET /fleet        - one row per truck: total fuel, distance covered
//                        (from odometer), trip stats, pump usage, timing —
//                        ranked so outliers (efficient/inefficient) stand out.
//   GET /truck/:id     - drill-down for one truck: fill-to-fill consumption
//                        intervals (real L/100km between consecutive fills,
//                        via LAG on odometer_reading), the trip-level rows
//                        behind that truck's activity (all 8 factors the
//                        business asked to analyze), and a per-driver
//                        breakdown for that truck.

// Round 153 fix — these defaults used to be built with
// `istDay()`, which is the UTC calendar day, not
// the IST one. Between midnight and 05:30 IST that named YESTERDAY, so opening
// this screen early in the morning quietly dropped the whole of the current
// day's fills out of the range while the page still said it was showing today.
// Every query below compares against a database session pinned to
// Asia/Kolkata (see db.js), so the default has to be the IST day too.
function dateRange(req) {
  const toDate = req.query.to_date || istDay(Date.now());
  const fromDate = req.query.from_date || istDay(Date.now() - 90 * 86400000);
  return { fromDate, toDate };
}

// One row per truck. Fuel totals + odometer-derived distance come from
// supply_requests; trip stats (count, quantity, pump usage, average
// travel/waiting/unloading minutes) come from delivery_tickets + trip_events,
// using the same LATERAL-join pattern as reports.js's /cycle-time route.
// A truck only appears if it has fuel fills OR trips in the range, so an
// idle/unused truck doesn't clutter the fleet view.
router.get("/fleet", requireRole(...STAFF_ROLES), async (req, res) => {
  const { fromDate, toDate } = dateRange(req);
  try {
    const { rows } = await query(
      `WITH fuel_rows AS (
         SELECT sr.truck_id, sr.actual_quantity_issued, sr.fuel_cost, sr.odometer_reading, fs.is_plant,
           -- The earliest-by-odometer fill in range has no prior reading to
           -- pair it with, so its litres can't be attributed to any known
           -- distance — same reasoning as the fill-interval drill-down
           -- below. Flagging it here (rather than dropping it) lets
           -- total_litres/total_cost still reflect everything actually
           -- spent, while the rate below only divides by fuel we can pair
           -- with real km — keeping this list's number consistent with
           -- what the drill-down for the same truck shows.
           ROW_NUMBER() OVER (PARTITION BY sr.truck_id ORDER BY sr.odometer_reading ASC NULLS LAST) = 1 AS is_first_in_range
         FROM supply_requests sr
         LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
         WHERE sr.request_type = 'fuel' AND sr.equipment_type = 'truck' AND sr.status = 'issued'
           AND sr.truck_id IS NOT NULL
           AND sr.issued_at::date BETWEEN $1 AND $2
       ),
       fuel AS (
         SELECT truck_id,
           SUM(actual_quantity_issued) AS total_litres,
           SUM(fuel_cost) AS total_cost,
           COUNT(*) AS fill_count,
           MIN(odometer_reading) AS min_odo,
           MAX(odometer_reading) AS max_odo,
           SUM(actual_quantity_issued) FILTER (WHERE NOT is_first_in_range) AS billable_litres,
           COUNT(*) FILTER (WHERE is_plant) AS plant_fill_count,
           COUNT(*) FILTER (WHERE NOT is_plant) AS outside_fill_count
         FROM fuel_rows
         GROUP BY truck_id
       ),
       trip_stats AS (
         SELECT dt.truck_id,
           COUNT(*) AS trip_count,
           SUM(dt.loaded_quantity_m3) AS total_qty_m3,
           SUM(s.distance_from_plant_km) * 2 AS total_est_distance_km,
           -- Round 136 fix: dt.pump_id alone under-counts "with pump" trips.
           -- Pump is chosen at order-creation time (customer_orders.pump_id)
           -- and only copied onto the ticket for some flows, so a ticket
           -- with no pump_id of its own can still belong to an order that
           -- specified one — same gap already fixed in administrator.js's
           -- delivery-ticket listing (see its "Pump No." join comment).
           COUNT(*) FILTER (WHERE COALESCE(dt.pump_id, co.pump_id) IS NOT NULL) AS with_pump_trips,
           COUNT(*) FILTER (WHERE COALESCE(dt.pump_id, co.pump_id) IS NULL) AS without_pump_trips,
           ROUND(AVG(EXTRACT(EPOCH FROM (us.event_time - rs.event_time)) / 60)::numeric, 1) AS avg_waiting_minutes,
           ROUND(AVG(EXTRACT(EPOCH FROM (uc.event_time - us.event_time)) / 60)::numeric, 1) AS avg_unloading_minutes,
           ROUND(AVG(EXTRACT(EPOCH FROM (rs.event_time - lp.event_time)) / 60)::numeric, 1) AS avg_travel_minutes
         FROM delivery_tickets dt
         JOIN customer_orders co ON co.id = dt.order_id
         JOIN sites s ON s.id = co.site_id
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'left_plant' ORDER BY event_time LIMIT 1) lp ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'reached_site' ORDER BY event_time LIMIT 1) rs ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_started' ORDER BY event_time LIMIT 1) us ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_completed' ORDER BY event_time LIMIT 1) uc ON true
         WHERE dt.truck_id IS NOT NULL AND dt.status NOT IN ('cancelled', 'rejected')
           AND dt.ticket_date BETWEEN $1 AND $2
         GROUP BY dt.truck_id
       )
       SELECT t.id AS truck_id, t.truck_number, t.capacity_m3,
         COALESCE(f.total_litres, 0) AS total_litres, COALESCE(f.total_cost, 0) AS total_cost, COALESCE(f.fill_count, 0) AS fill_count,
         f.min_odo, f.max_odo, (f.max_odo - f.min_odo) AS odo_distance_km,
         COALESCE(f.plant_fill_count, 0) AS plant_fill_count, COALESCE(f.outside_fill_count, 0) AS outside_fill_count,
         COALESCE(ts.trip_count, 0) AS trip_count, COALESCE(ts.total_qty_m3, 0) AS total_qty_m3,
         ts.total_est_distance_km, COALESCE(ts.with_pump_trips, 0) AS with_pump_trips, COALESCE(ts.without_pump_trips, 0) AS without_pump_trips,
         ts.avg_waiting_minutes, ts.avg_unloading_minutes, ts.avg_travel_minutes,
         CASE WHEN f.max_odo > f.min_odo THEN ROUND((f.billable_litres / (f.max_odo - f.min_odo)) * 100, 2) END AS litres_per_100km,
         -- Round 136 addition: litres per m³ of concrete carried in the same
         -- range — a distance-independent efficiency figure (unlike
         -- L/100km, it doesn't need paired odometer readings, so it uses
         -- every litre fuelled rather than only billable_litres).
         CASE WHEN COALESCE(f.total_litres, 0) > 0 AND COALESCE(ts.total_qty_m3, 0) > 0
              THEN ROUND((f.total_litres / ts.total_qty_m3)::numeric, 2) END AS litres_per_m3,
         -- Round 137, item 1b — cost per m³, alongside litres per m³. Same
         -- basis (total fuel cost recorded in range / total m³ carried in
         -- range) — not distance-based, so no paired-odometer requirement.
         CASE WHEN COALESCE(f.total_cost, 0) > 0 AND COALESCE(ts.total_qty_m3, 0) > 0
              THEN ROUND((f.total_cost / ts.total_qty_m3)::numeric, 2) END AS cost_per_m3
       FROM trucks t
       LEFT JOIN fuel f ON f.truck_id = t.id
       LEFT JOIN trip_stats ts ON ts.truck_id = t.id
       WHERE t.is_active = true AND (f.truck_id IS NOT NULL OR ts.truck_id IS NOT NULL)
       ORDER BY t.truck_number`,
      [fromDate, toDate]
    );

    // Fleet average (only trucks with a usable L/100km figure) so the
    // frontend can flag outliers without recomputing it client-side.
    const withRate = rows.filter((r) => r.litres_per_100km != null);
    const fleetAvgRate = withRate.length
      ? Math.round((withRate.reduce((sum, r) => sum + Number(r.litres_per_100km), 0) / withRate.length) * 100) / 100
      : null;
    const withM3Rate = rows.filter((r) => r.litres_per_m3 != null);
    const fleetAvgM3Rate = withM3Rate.length
      ? Math.round((withM3Rate.reduce((sum, r) => sum + Number(r.litres_per_m3), 0) / withM3Rate.length) * 100) / 100
      : null;
    const withCostM3 = rows.filter((r) => r.cost_per_m3 != null);
    const fleetAvgCostM3 = withCostM3.length
      ? Math.round((withCostM3.reduce((sum, r) => sum + Number(r.cost_per_m3), 0) / withCostM3.length) * 100) / 100
      : null;

    res.json({
      from_date: fromDate,
      to_date: toDate,
      fleet_avg_litres_per_100km: fleetAvgRate,
      fleet_avg_litres_per_m3: fleetAvgM3Rate,
      fleet_avg_cost_per_m3: fleetAvgCostM3,
      trucks: rows,
    });
  } catch (err) {
    console.error("GET /fuel-analysis/fleet failed:", err);
    res.status(500).json({ error: "Failed to load fleet fuel summary." });
  }
});

// Drill-down for a single truck. Three parts: fill-to-fill consumption
// intervals (the honest L/100km number — computed only between
// consecutive fills, since we don't know distance before the first fill
// in range), the trip-level rows behind this truck's activity, and a
// per-driver breakdown for this truck (same truck, different drivers can
// have very different consumption/timing).
router.get("/truck/:id", requireRole(...STAFF_ROLES), async (req, res) => {
  const truckId = Number(req.params.id);
  if (!Number.isInteger(truckId)) return res.status(400).json({ error: "Invalid truck id." });
  const { fromDate, toDate } = dateRange(req);

  try {
    const truckResult = await query(`SELECT id, truck_number, capacity_m3, is_active FROM trucks WHERE id = $1`, [truckId]);
    if (truckResult.rows.length === 0) return res.status(404).json({ error: "Truck not found." });

    const [intervals, trips, drivers] = await Promise.all([
      query(
        `WITH fills AS (
           SELECT sr.id, sr.odometer_reading, sr.actual_quantity_issued, sr.issued_at, sr.fuel_cost,
             fs.name AS station_name, fs.is_plant
           FROM supply_requests sr
           LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
           WHERE sr.request_type = 'fuel' AND sr.equipment_type = 'truck' AND sr.status = 'issued'
             AND sr.truck_id = $1 AND sr.odometer_reading IS NOT NULL
             AND sr.issued_at::date BETWEEN $2 AND $3
         )
         SELECT id, issued_at, odometer_reading, actual_quantity_issued, fuel_cost, station_name, is_plant,
           odometer_reading - LAG(odometer_reading) OVER (ORDER BY odometer_reading) AS interval_km,
           ROUND((actual_quantity_issued / NULLIF(odometer_reading - LAG(odometer_reading) OVER (ORDER BY odometer_reading), 0)) * 100, 2) AS litres_per_100km
         FROM fills
         ORDER BY odometer_reading`,
        [truckId, fromDate, toDate]
      ),
      query(
        `SELECT dt.id AS ticket_id, dt.ticket_number, dt.ticket_date, dt.loaded_quantity_m3,
           u.name AS driver_name,
           -- Round 136 fix: see the fleet query's own comment on this same
           -- pump_id fallback — a ticket without its own pump_id can still
           -- belong to an order that specified one.
           CASE WHEN COALESCE(dt.pump_id, co.pump_id) IS NOT NULL THEN 'With pump' ELSE 'Without pump' END AS discharge_mode,
           s.distance_from_plant_km, (s.distance_from_plant_km * 2) AS round_trip_km,
           ROUND(EXTRACT(EPOCH FROM (rs.event_time - lp.event_time)) / 60) AS travel_minutes,
           ROUND(EXTRACT(EPOCH FROM (us.event_time - rs.event_time)) / 60) AS waiting_minutes,
           ROUND(EXTRACT(EPOCH FROM (uc.event_time - us.event_time)) / 60) AS unloading_minutes
         FROM delivery_tickets dt
         JOIN customer_orders co ON co.id = dt.order_id
         JOIN sites s ON s.id = co.site_id
         LEFT JOIN users u ON u.id = dt.driver_id
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'left_plant' ORDER BY event_time LIMIT 1) lp ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'reached_site' ORDER BY event_time LIMIT 1) rs ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_started' ORDER BY event_time LIMIT 1) us ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_completed' ORDER BY event_time LIMIT 1) uc ON true
         WHERE dt.truck_id = $1 AND dt.status NOT IN ('cancelled', 'rejected')
           AND dt.ticket_date BETWEEN $2 AND $3
         ORDER BY dt.ticket_date DESC`,
        [truckId, fromDate, toDate]
      ),
      query(
        `SELECT dt.driver_id, u.name AS driver_name,
           COUNT(*) AS trip_count,
           -- Round 136 fix: same pump_id fallback as the trips/fleet queries above.
           COUNT(*) FILTER (WHERE COALESCE(dt.pump_id, co.pump_id) IS NOT NULL) AS with_pump_trips,
           COUNT(*) FILTER (WHERE COALESCE(dt.pump_id, co.pump_id) IS NULL) AS without_pump_trips,
           ROUND(AVG(EXTRACT(EPOCH FROM (rs.event_time - lp.event_time)) / 60)::numeric, 1) AS avg_travel_minutes,
           ROUND(AVG(EXTRACT(EPOCH FROM (us.event_time - rs.event_time)) / 60)::numeric, 1) AS avg_waiting_minutes,
           ROUND(AVG(EXTRACT(EPOCH FROM (uc.event_time - us.event_time)) / 60)::numeric, 1) AS avg_unloading_minutes
         FROM delivery_tickets dt
         JOIN customer_orders co ON co.id = dt.order_id
         LEFT JOIN users u ON u.id = dt.driver_id
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'left_plant' ORDER BY event_time LIMIT 1) lp ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'reached_site' ORDER BY event_time LIMIT 1) rs ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_started' ORDER BY event_time LIMIT 1) us ON true
         LEFT JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'unloading_completed' ORDER BY event_time LIMIT 1) uc ON true
         WHERE dt.truck_id = $1 AND dt.status NOT IN ('cancelled', 'rejected')
           AND dt.ticket_date BETWEEN $2 AND $3
         GROUP BY dt.driver_id, u.name
         ORDER BY trip_count DESC`,
        [truckId, fromDate, toDate]
      ),
    ]);

    res.json({
      from_date: fromDate,
      to_date: toDate,
      truck: truckResult.rows[0],
      fill_intervals: intervals.rows,
      trips: trips.rows,
      drivers: drivers.rows,
    });
  } catch (err) {
    console.error("GET /fuel-analysis/truck/:id failed:", err);
    res.status(500).json({ error: "Failed to load truck fuel detail." });
  }
});

// ===== Round 153, punch-list item 4 — everything that is NOT a truck =====
//
// The fleet view above only ever answered for trucks, because a truck has an
// odometer and the whole analysis was built on distance. A pump, a loader, a
// generator has an hour meter instead, and until now the litres they burn were
// recorded (supply_requests captures hour_meter_reading at request time) and
// then never looked at again.
//
// The arithmetic is the same shape with hours in place of kilometres:
//   trucks      litres per 100 km, litres per m³ carried
//   pumps       litres per running hour, litres per m³ pumped
//   other kit   litres per running hour
//
// Two unit families share this endpoint — pumps live in their own `pumps`
// table, everything else in `equipment` — so every row carries `kind`
// ('pump' or 'equipment') alongside its id. The drill-down URL needs both,
// because id 3 is a different machine in each table. Getting that wrong would
// silently show one machine's fuel under another's name, which is why the two
// halves are UNIONed with an explicit literal rather than merged on id.
//
// litres_per_hour deliberately excludes the earliest fill in the range, for
// the reason the fleet query already sets out: the litres in the first fill
// were burned before the window opened, over hours nobody here can see.
// total_litres still counts every litre, so the spend figure stays honest.
router.get("/equipment", requireRole(...STAFF_ROLES), async (req, res) => {
  const { fromDate, toDate } = dateRange(req);
  try {
    const { rows } = await query(
      `WITH fuel_rows AS (
         SELECT
           CASE WHEN sr.pump_id IS NOT NULL THEN 'pump' ELSE 'equipment' END AS kind,
           COALESCE(sr.pump_id, sr.equipment_id) AS unit_id,
           sr.actual_quantity_issued, sr.fuel_cost, sr.hour_meter_reading, fs.is_plant,
           ROW_NUMBER() OVER (
             PARTITION BY COALESCE(sr.pump_id, sr.equipment_id),
                          CASE WHEN sr.pump_id IS NOT NULL THEN 'pump' ELSE 'equipment' END
             ORDER BY sr.hour_meter_reading ASC NULLS LAST
           ) = 1 AS is_first_in_range
         FROM supply_requests sr
         LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
         WHERE sr.request_type = 'fuel' AND sr.status = 'issued'
           AND sr.equipment_type != 'truck'
           AND COALESCE(sr.pump_id, sr.equipment_id) IS NOT NULL
           AND sr.issued_at::date BETWEEN $1 AND $2
       ),
       fuel AS (
         SELECT kind, unit_id,
           SUM(actual_quantity_issued) AS total_litres,
           SUM(fuel_cost) AS total_cost,
           COUNT(*) AS fill_count,
           MIN(hour_meter_reading) AS min_hours,
           MAX(hour_meter_reading) AS max_hours,
           SUM(actual_quantity_issued) FILTER (WHERE NOT is_first_in_range) AS billable_litres,
           COUNT(*) FILTER (WHERE is_plant) AS plant_fill_count,
           COUNT(*) FILTER (WHERE NOT is_plant) AS outside_fill_count
         FROM fuel_rows
         GROUP BY kind, unit_id
       ),
       -- Pumps are the one non-truck unit with an output figure of its own:
       -- pump_logs records what each pump actually pushed, per delivery. That
       -- makes litres-per-m³ available for pumps exactly as it is for trucks.
       pump_output AS (
         SELECT pl.pump_id AS unit_id,
           COUNT(*) AS job_count,
           SUM(pl.pumping_quantity_m3) AS total_qty_m3
         FROM pump_logs pl
         WHERE pl.pump_id IS NOT NULL AND pl.start_time::date BETWEEN $1 AND $2
         GROUP BY pl.pump_id
       ),
       units AS (
         SELECT 'pump'::text AS kind, p.id AS unit_id, p.pump_code AS unit_name,
                p.pump_type::text AS unit_subtype
         FROM pumps p WHERE p.is_active = true
         UNION ALL
         SELECT 'equipment'::text, e.id, e.name, e.equipment_type::text
         FROM equipment e WHERE e.is_active = true
       )
       SELECT u.kind, u.unit_id, u.unit_name, u.unit_subtype,
         COALESCE(f.total_litres, 0) AS total_litres,
         COALESCE(f.total_cost, 0) AS total_cost,
         COALESCE(f.fill_count, 0) AS fill_count,
         f.min_hours, f.max_hours, (f.max_hours - f.min_hours) AS hours_run,
         COALESCE(f.plant_fill_count, 0) AS plant_fill_count,
         COALESCE(f.outside_fill_count, 0) AS outside_fill_count,
         COALESCE(po.job_count, 0) AS job_count,
         po.total_qty_m3,
         CASE WHEN f.max_hours > f.min_hours
              THEN ROUND(f.billable_litres / (f.max_hours - f.min_hours), 2) END AS litres_per_hour,
         CASE WHEN COALESCE(f.total_litres, 0) > 0 AND COALESCE(po.total_qty_m3, 0) > 0
              THEN ROUND((f.total_litres / po.total_qty_m3)::numeric, 2) END AS litres_per_m3
       FROM units u
       LEFT JOIN fuel f ON f.kind = u.kind AND f.unit_id = u.unit_id
       LEFT JOIN pump_output po ON u.kind = 'pump' AND po.unit_id = u.unit_id
       -- A unit that neither fuelled nor worked in the range is left out, the
       -- same way an idle truck is left out of the fleet list.
       WHERE f.unit_id IS NOT NULL OR po.unit_id IS NOT NULL
       ORDER BY u.kind, u.unit_name`,
      [fromDate, toDate]
    );

    // Averages are per FAMILY, not across the whole list: a line pump and a
    // generator have nothing in common, and one average over both would flag
    // every machine as an outlier. Pumps are averaged against pumps; each
    // other equipment type against its own type.
    const avgOf = (subset) => {
      const usable = subset.filter((r) => r.litres_per_hour != null);
      if (!usable.length) return null;
      return Math.round((usable.reduce((s, r) => s + Number(r.litres_per_hour), 0) / usable.length) * 100) / 100;
    };
    const avgByType = {};
    for (const r of rows) {
      (avgByType[r.unit_subtype] = avgByType[r.unit_subtype] || []).push(r);
    }
    const typeAverages = Object.fromEntries(
      Object.entries(avgByType).map(([type, subset]) => [type, avgOf(subset)])
    );

    res.json({
      from_date: fromDate,
      to_date: toDate,
      avg_litres_per_hour_by_type: typeAverages,
      units: rows,
    });
  } catch (err) {
    console.error("GET /fuel-analysis/equipment failed:", err);
    res.status(500).json({ error: "Failed to load equipment fuel summary." });
  }
});

// Drill-down for one pump or one piece of equipment: the fill-to-fill
// intervals, which is the only honest consumption figure — litres in this
// fill over the hours run since the last one. Pumps additionally get the jobs
// behind those hours, so a high figure can be read against what the machine
// was actually doing rather than guessed at.
router.get("/equipment/:kind/:id", requireRole(...STAFF_ROLES), async (req, res) => {
  const kind = req.params.kind;
  const unitId = Number(req.params.id);
  if (kind !== "pump" && kind !== "equipment") return res.status(400).json({ error: "Invalid equipment kind." });
  if (!Number.isInteger(unitId)) return res.status(400).json({ error: "Invalid equipment id." });
  const { fromDate, toDate } = dateRange(req);

  try {
    const unitResult = kind === "pump"
      ? await query(`SELECT id, pump_code AS unit_name, pump_type::text AS unit_subtype FROM pumps WHERE id = $1`, [unitId])
      : await query(`SELECT id, name AS unit_name, equipment_type::text AS unit_subtype FROM equipment WHERE id = $1`, [unitId]);
    if (!unitResult.rows.length) return res.status(404).json({ error: "Equipment not found." });

    // The id column to match on depends on the family, and it is chosen here
    // rather than interpolated into the SQL — $4 carries the kind and the
    // WHERE clause picks the column from it, so no part of the query text is
    // ever built from a URL segment.
    const intervals = await query(
      `WITH fills AS (
         SELECT sr.id, sr.hour_meter_reading, sr.actual_quantity_issued, sr.issued_at, sr.fuel_cost,
           fs.name AS station_name, fs.is_plant
         FROM supply_requests sr
         LEFT JOIN fuel_stations fs ON fs.id = COALESCE(sr.approved_station_id, sr.fuel_station_id)
         WHERE sr.request_type = 'fuel' AND sr.status = 'issued'
           AND sr.hour_meter_reading IS NOT NULL
           AND sr.issued_at::date BETWEEN $2 AND $3
           AND (($4 = 'pump' AND sr.pump_id = $1) OR ($4 = 'equipment' AND sr.equipment_id = $1))
       )
       SELECT id, issued_at, hour_meter_reading, actual_quantity_issued, fuel_cost, station_name, is_plant,
         hour_meter_reading - LAG(hour_meter_reading) OVER (ORDER BY hour_meter_reading) AS interval_hours,
         ROUND(actual_quantity_issued / NULLIF(hour_meter_reading - LAG(hour_meter_reading) OVER (ORDER BY hour_meter_reading), 0), 2) AS litres_per_hour
       FROM fills
       ORDER BY hour_meter_reading`,
      [unitId, fromDate, toDate, kind]
    );

    const jobs = kind === "pump"
      ? await query(
          `SELECT pl.id, pl.start_time, pl.finish_time, pl.pumping_quantity_m3, pl.waiting_time_minutes,
             dt.ticket_number, c.name AS customer_name, s.name AS site_name,
             ROUND(EXTRACT(EPOCH FROM (pl.finish_time - pl.start_time)) / 60) AS running_minutes
           FROM pump_logs pl
           LEFT JOIN delivery_tickets dt ON dt.id = pl.ticket_id
           LEFT JOIN customer_orders co ON co.id = dt.order_id
           LEFT JOIN customers c ON c.id = co.customer_id
           LEFT JOIN sites s ON s.id = co.site_id
           WHERE pl.pump_id = $1 AND pl.start_time::date BETWEEN $2 AND $3
           ORDER BY pl.start_time DESC`,
          [unitId, fromDate, toDate]
        )
      : { rows: [] };

    res.json({
      from_date: fromDate,
      to_date: toDate,
      kind,
      unit: unitResult.rows[0],
      fill_intervals: intervals.rows,
      jobs: jobs.rows,
    });
  } catch (err) {
    console.error("GET /fuel-analysis/equipment/:kind/:id failed:", err);
    res.status(500).json({ error: "Failed to load equipment fuel detail." });
  }
});

export default router;
