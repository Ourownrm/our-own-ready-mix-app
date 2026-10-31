// Round 254 — the Production module's tabs (owner, 31 Oct 2026; mock-up
// "Production Module Redesign"). The lists behind them:
//   GET /api/production/attention        "Needs you now" counts (Plant overview)
//   GET /api/production/orders           order list by view (Orders tab)
//   GET /api/production/tickets?date=    delivery tickets of a day, by order
//   GET /api/production/tracking         running orders' trucks, stage, GPS, ETA
//   GET /api/production/customers        customer list with site counts, balance
//   GET /api/production/customers/:id    the customer file: sites, billing, contacts, orders
// Changes still go through the existing routes (administrator.js orders /
// tickets / customers / sites), so the rules there hold.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { istDay } from "../lib/istDate.js";
import { ensureRound254 } from "../lib/round254Schema.js";
import { estimateEtaAt, ASSUMED_AVERAGE_SPEED_KMPH } from "../lib/etaEstimate.js";
import { positions } from "../lib/receivables.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound254(); next(); } catch (e) { next(e); } });

const n0 = (v) => Number(v) || 0;
const r2 = (n) => Math.round(n0(n) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const safe = (p, fallback = []) => p.then((r) => r.rows).catch((e) => { console.error("production:", e.message); return fallback; });
const MIX = `CASE WHEN md.id IS NULL THEN NULL ELSE md.design_ref_code || COALESCE(' · rev ' || md.revision, '') END`;

// ------------------------------------------------------------ attention ---
// The items the Plant overview's "Needs you now" panel counts. Each is
// counted only for someone who could act on it.
router.get("/attention", requirePermission("production.manager-dashboard", "view"), async (req, res) => {
  const u = req.user;
  const [supply, purchase, bookings, leads, followups, certs] = await Promise.all([
    (await can(u, "store.supply-approve", "edit")) ? safe(query(`SELECT COUNT(*)::int AS n FROM supply_requests WHERE status = 'pending'`), [{ n: 0 }]) : [{ n: 0 }],
    (await can(u, "store.supply-approve", "edit")) ? safe(query(`SELECT COUNT(*)::int AS n FROM store_stock_purchases WHERE status = 'pending'`), [{ n: 0 }]) : [{ n: 0 }],
    safe(query(`SELECT COUNT(*)::int AS n FROM bookings WHERE status = 'pending'`), [{ n: 0 }]),
    safe(query(`SELECT COUNT(*)::int AS n FROM leads WHERE status = 'new' AND assigned_to IS NULL AND COALESCE(dashboard_hidden, false) = false`), [{ n: 0 }]),
    safe(query(`SELECT COUNT(*)::int AS n FROM sales_followups WHERE completed_at IS NULL AND due_date <= CURRENT_DATE`), [{ n: 0 }]),
    safe(query(`SELECT COUNT(*)::int AS n FROM mnt_certificates WHERE status = 'current' AND valid_to <= CURRENT_DATE + 15`), [{ n: 0 }]),
  ]);
  const { rows: ord } = await query(
    `SELECT o.id, o.status, o.order_quantity_m3, o.site_ready_confirmed_at,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status <> 'cancelled'), 0) - COALESCE(SUM(sq.rejected_quantity_m3), 0) AS supplied,
            COUNT(dt.id) FILTER (WHERE dt.status <> 'cancelled') AS loads
       FROM customer_orders o LEFT JOIN delivery_tickets dt ON dt.order_id = o.id LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
      WHERE o.order_date <= CURRENT_DATE AND o.status NOT IN ('completed','cancelled','closed')
      GROUP BY o.id`);
  const { rows: late } = await query(
    `SELECT COUNT(*)::int AS n FROM delivery_tickets dt
       JOIN LATERAL (SELECT event_time FROM trip_events WHERE ticket_id = dt.id AND event_type = 'reached_site' ORDER BY event_time DESC LIMIT 1) rs ON true
      WHERE dt.ticket_date >= CURRENT_DATE - 1 AND dt.status <> 'cancelled' AND rs.event_time < now() - interval '120 minutes'
        AND NOT EXISTS (SELECT 1 FROM trip_events x WHERE x.ticket_id = dt.id AND x.event_type IN ('unloading_completed','returned_to_plant'))`);
  res.json({
    supply: n0(supply[0]?.n), purchases: n0(purchase[0]?.n), bookings: n0(bookings[0]?.n), inquiries: n0(leads[0]?.n),
    followups: n0(followups[0]?.n), compliance: n0(certs[0]?.n), delayed: n0(late[0]?.n),
    to_confirm: ord.filter((o) => n0(o.supplied) >= n0(o.order_quantity_m3) - 0.01 && n0(o.order_quantity_m3) > 0).length,
    waiting_first_load: ord.filter((o) => o.site_ready_confirmed_at && n0(o.loads) === 0).length,
  });
});

// --------------------------------------------------------------- orders ---
const ORDER_SQL = `
  SELECT o.id, o.order_date::text AS order_date, o.scheduled_batching_time, o.required_at_site_time, o.status,
         o.customer_id, c.name AS customer_name, o.site_id, s.name AS site_name, o.mix_grade_id, m.name AS mix_grade_name,
         o.price_option, o.quoted_mix_design_id, ${MIX} AS mix_code,
         o.order_quantity_m3, o.pump_requirement, o.pump_id, p.pump_code, o.assigned_qc_engineer_id, qc.name AS qc_engineer_name,
         o.pump_charge_applicable, o.pump_charge_waiver_reason, o.part_load_applicable, o.part_load_waiver_reason, o.part_load_basis,
         o.remarks, o.supervisor_marked_complete, o.site_ready_confirmed, o.assigned_site_supervisor_id,
         COALESCE(t.loaded, 0) - COALESCE(t.rejected, 0) AS supplied, COALESCE(t.loads, 0) AS loads
    FROM customer_orders o
    JOIN customers c ON c.id = o.customer_id JOIN sites s ON s.id = o.site_id JOIN mix_grades m ON m.id = o.mix_grade_id
    LEFT JOIN mix_designs md ON md.id = o.quoted_mix_design_id
    LEFT JOIN pumps p ON p.id = o.pump_id LEFT JOIN users qc ON qc.id = o.assigned_qc_engineer_id
    LEFT JOIN LATERAL (
      SELECT SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status <> 'cancelled') AS loaded,
             SUM(sq.rejected_quantity_m3) AS rejected, COUNT(*) FILTER (WHERE dt.status <> 'cancelled') AS loads
        FROM delivery_tickets dt LEFT JOIN site_qc sq ON sq.ticket_id = dt.id WHERE dt.order_id = o.id) t ON true`;
const TERMINAL = `('completed','cancelled','closed')`;
const VIEWS = {
  carried: `o.order_date < CURRENT_DATE AND o.status NOT IN ${TERMINAL}`,
  today: `o.order_date = CURRENT_DATE`,
  tomorrow: `o.order_date = CURRENT_DATE + 1`,
  upcoming: `o.order_date > CURRENT_DATE + 1 AND o.status NOT IN ${TERMINAL}`,
  past: `o.order_date < CURRENT_DATE`,
};
const shapeOrder = (o) => {
  const qty = n0(o.order_quantity_m3), supplied = r2(o.supplied);
  return { ...o, order_quantity_m3: qty, supplied, loads: Number(o.loads), to_confirm: !["completed", "cancelled", "closed"].includes(o.status) && qty > 0 && supplied >= qty - 0.01 };
};

router.get("/orders", requirePermission("production.correct-order", "view"), async (req, res) => {
  const view = VIEWS[req.query.view] ? req.query.view : "today";
  const where = [VIEWS[view]], params = [];
  if (req.query.customer_id) { params.push(Number(req.query.customer_id)); where.push(`o.customer_id = $${params.length}`); }
  if (view === "past") {
    if (ISO.test(req.query.from || "")) { params.push(req.query.from); where.push(`o.order_date >= $${params.length}::date`); }
    if (ISO.test(req.query.to || "")) { params.push(req.query.to); where.push(`o.order_date <= $${params.length}::date`); }
  }
  const { rows } = await query(
    `${ORDER_SQL} WHERE ${where.join(" AND ")}
      ORDER BY ${view === "past" ? "o.order_date DESC, o.scheduled_batching_time DESC" : "o.order_date, o.scheduled_batching_time"} LIMIT ${view === "past" ? 300 : 500}`, params);
  const { rows: counts } = await query(
    `SELECT COUNT(*) FILTER (WHERE ${VIEWS.carried})::int AS carried, COUNT(*) FILTER (WHERE ${VIEWS.today})::int AS today,
            COUNT(*) FILTER (WHERE ${VIEWS.tomorrow})::int AS tomorrow, COUNT(*) FILTER (WHERE ${VIEWS.upcoming})::int AS upcoming
       FROM customer_orders o`);
  const list = rows.map(shapeOrder);
  res.json({
    view, counts: counts[0], list,
    totals: { ordered: r2(list.filter((o) => !["cancelled", "closed"].includes(o.status)).reduce((s, o) => s + o.order_quantity_m3, 0)), supplied: r2(list.reduce((s, o) => s + o.supplied, 0)) },
  });
});

// The mixes an order can take at its site (grade, then mix design), for the
// inline edit: same source as Create Order (/master/site-mixes).
router.get("/orders/:id(\\d+)", requirePermission("production.correct-order", "view"), async (req, res) => {
  const { rows } = await query(`${ORDER_SQL} WHERE o.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Order not found." });
  res.json(shapeOrder(rows[0]));
});

// -------------------------------------------------------------- tickets ---
router.get("/tickets", requirePermission("production.correct-tickets", "view"), async (req, res) => {
  const day = ISO.test(req.query.date || "") ? req.query.date : istDay();
  const { rows } = await query(
    `SELECT dt.id, dt.ticket_number, dt.status, dt.created_at, dt.loaded_quantity_m3, dt.order_id,
            t.truck_number, u.name AS driver_name,
            o.order_quantity_m3, o.pump_requirement, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name, ${MIX} AS mix_code,
            i.total_amount AS invoice_total, i.part_load_charge, sq.rejected_quantity_m3 AS returned_m3,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'left_plant') AS left_plant_at,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'reached_site') AS reached_site_at,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_started') AS unloading_started_at,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_completed') AS unloading_completed_at,
            MAX(te.event_time) FILTER (WHERE te.event_type = 'returned_to_plant') AS returned_at,
            (SELECT COUNT(*)::int FROM ticket_qty_corrections x WHERE x.ticket_id = dt.id) AS corrections
       FROM delivery_tickets dt
       JOIN customer_orders o ON o.id = dt.order_id JOIN customers c ON c.id = o.customer_id JOIN sites s ON s.id = o.site_id
       JOIN mix_grades m ON m.id = o.mix_grade_id LEFT JOIN mix_designs md ON md.id = o.quoted_mix_design_id
       LEFT JOIN trucks t ON t.id = dt.truck_id LEFT JOIN users u ON u.id = dt.driver_id
       LEFT JOIN invoices i ON i.ticket_id = dt.id LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       LEFT JOIN trip_events te ON te.ticket_id = dt.id
      WHERE dt.ticket_date = $1::date
      GROUP BY dt.id, t.truck_number, u.name, o.id, c.name, s.name, m.name, md.id, i.id, sq.id
      ORDER BY dt.created_at`, [day]);
  const list = rows.map((r) => ({
    ...r, loaded_quantity_m3: n0(r.loaded_quantity_m3), invoice_total: r.invoice_total == null ? null : n0(r.invoice_total),
    part_load_charge: n0(r.part_load_charge), returned_m3: n0(r.returned_m3), order_quantity_m3: n0(r.order_quantity_m3),
  }));
  const live = list.filter((t) => t.status !== "cancelled");
  const onRoad = live.filter((t) => !t.unloading_completed_at && !["completed", "returned", "rejected"].includes(t.status));
  res.json({
    date: day, list,
    tiles: {
      loads: live.length, loaded_m3: r2(live.reduce((s, t) => s + t.loaded_quantity_m3, 0)),
      on_road: onRoad.length, on_road_m3: r2(onRoad.reduce((s, t) => s + t.loaded_quantity_m3, 0)),
      unloaded: live.filter((t) => t.unloading_completed_at || t.status === "completed").length,
      unloaded_m3: r2(live.filter((t) => t.unloading_completed_at || t.status === "completed").reduce((s, t) => s + t.loaded_quantity_m3, 0)),
      part_loads: live.filter((t) => t.part_load_charge > 0).length, part_load_amount: r2(live.reduce((s, t) => s + t.part_load_charge, 0)),
      returned: live.filter((t) => t.returned_m3 > 0 || ["returned", "rejected"].includes(t.status)).length,
      returned_m3: r2(live.reduce((s, t) => s + t.returned_m3, 0)),
    },
  });
});

router.get("/tickets/:id(\\d+)/corrections", requirePermission("production.correct-tickets", "view"), async (req, res) => {
  const { rows } = await query(
    `SELECT x.old_qty, x.new_qty, x.reason, x.done_at, u.name AS done_by FROM ticket_qty_corrections x LEFT JOIN users u ON u.id = x.done_by
      WHERE x.ticket_id = $1 ORDER BY x.done_at`, [req.params.id]);
  res.json(rows);
});

// ------------------------------------------------------------- tracking ---
// The stage a truck is at, from its trip events:
//  -1 loading at the plant · 0 left plant (to site) · 1 at site · 2 unloading
//   3 returning · 4 back at plant (trip done)
export function stageOf(t) {
  if (t.returned_at) return 4;
  if (t.unloading_completed_at) return 3;
  if (t.unloading_started_at) return 2;
  if (t.reached_site_at) return 1;
  if (t.left_plant_at) return 0;
  return -1;
}
const AT_SITE_LIMIT_MIN = 120;   // same as the dashboard's "over 2 hrs at site"
const GPS_STALE_MIN = 10;

router.get("/tracking", requirePermission("orders.live-tracking", "view"), async (req, res) => {
  const [{ rows: tickets }, { rows: plantRows }] = await Promise.all([
    query(
      `SELECT dt.id, dt.ticket_number, dt.status, dt.created_at, dt.loaded_quantity_m3, dt.order_id, dt.site_delay_reason,
              t.truck_number, u.name AS driver_name, u.phone AS driver_phone,
              o.order_quantity_m3, c.name AS customer_name, s.name AS site_name, s.id AS site_id, m.name AS mix_grade_name, ${MIX} AS mix_code,
              s.latitude AS site_lat, s.longitude AS site_lng, s.geofence_radius_m, s.distance_from_plant_km,
              o.site_ready_latitude, o.site_ready_longitude, o.site_ready_location_suspect, o.site_contact_number,
              MAX(te.event_time) FILTER (WHERE te.event_type = 'left_plant') AS left_plant_at,
              MAX(te.event_time) FILTER (WHERE te.event_type = 'reached_site') AS reached_site_at,
              MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_started') AS unloading_started_at,
              MAX(te.event_time) FILTER (WHERE te.event_type = 'unloading_completed') AS unloading_completed_at,
              MAX(te.event_time) FILTER (WHERE te.event_type = 'returned_to_plant') AS returned_at,
              gp.latitude AS last_ping_latitude, gp.longitude AS last_ping_longitude, gp.speed_kmh AS last_ping_speed_kmh, gp.recorded_at AS last_ping_at
         FROM delivery_tickets dt
         JOIN customer_orders o ON o.id = dt.order_id JOIN customers c ON c.id = o.customer_id JOIN sites s ON s.id = o.site_id
         JOIN mix_grades m ON m.id = o.mix_grade_id LEFT JOIN mix_designs md ON md.id = o.quoted_mix_design_id
         LEFT JOIN trucks t ON t.id = dt.truck_id LEFT JOIN users u ON u.id = dt.driver_id
         LEFT JOIN trip_events te ON te.ticket_id = dt.id
         LEFT JOIN LATERAL (SELECT latitude, longitude, speed_kmh, recorded_at FROM gps_pings WHERE ticket_id = dt.id ORDER BY recorded_at DESC LIMIT 1) gp ON true
        WHERE dt.status NOT IN ('cancelled')
          AND (dt.ticket_date = CURRENT_DATE OR (o.status NOT IN ('completed','cancelled','closed') AND dt.ticket_date >= CURRENT_DATE - 1))
        GROUP BY dt.id, t.truck_number, u.name, u.phone, o.id, c.name, s.id, m.name, md.id, gp.latitude, gp.longitude, gp.speed_kmh, gp.recorded_at
        ORDER BY dt.created_at`),
    query(`SELECT name, latitude, longitude, geofence_radius_m FROM plant_locations WHERE is_active LIMIT 1`).catch(() => ({ rows: [] })),
  ]);
  const plant = plantRows[0] || null;
  const now = Date.now();
  const mins = (t) => (t ? Math.round((now - new Date(t).getTime()) / 60000) : null);
  const orders = new Map();
  const trucks = tickets.map((t) => {
    const stage = stageOf(t);
    const site = {
      latitude: !t.site_ready_location_suspect && t.site_ready_latitude != null ? t.site_ready_latitude : t.site_lat,
      longitude: !t.site_ready_location_suspect && t.site_ready_longitude != null ? t.site_ready_longitude : t.site_lng,
      distance_from_plant_km: t.distance_from_plant_km,
    };
    const pingAge = mins(t.last_ping_at);
    const atSiteMin = stage === 1 || stage === 2 ? mins(t.reached_site_at) : null;
    let eta = stage === 0 ? estimateEtaAt(t, site, plant) : null;
    // Back to the plant: from the end of unloading, at the same assumed speed.
    if (stage === 3 && t.distance_from_plant_km) {
      eta = new Date(new Date(t.unloading_completed_at).getTime() + (n0(t.distance_from_plant_km) / ASSUMED_AVERAGE_SPEED_KMPH) * 3600000).toISOString();
    }
    const row = {
      ticket_id: t.id, ticket_number: t.ticket_number, truck_number: t.truck_number, driver_name: t.driver_name, driver_phone: t.driver_phone,
      order_id: t.order_id, loaded_quantity_m3: n0(t.loaded_quantity_m3), stage,
      left_plant_at: t.left_plant_at, reached_site_at: t.reached_site_at, unloading_started_at: t.unloading_started_at,
      unloading_completed_at: t.unloading_completed_at, returned_at: t.returned_at, created_at: t.created_at,
      eta_at: eta, minutes_at_site: atSiteMin, delayed: atSiteMin != null && atSiteMin > AT_SITE_LIMIT_MIN,
      gps_age_min: pingAge, gps_stale: stage >= 0 && stage <= 3 && (pingAge == null || pingAge > GPS_STALE_MIN),
      lat: t.last_ping_latitude != null ? Number(t.last_ping_latitude) : null, lng: t.last_ping_longitude != null ? Number(t.last_ping_longitude) : null,
      site_delay_reason: t.site_delay_reason,
    };
    if (!orders.has(t.order_id)) {
      orders.set(t.order_id, {
        order_id: t.order_id, customer_name: t.customer_name, site_name: t.site_name, site_id: t.site_id, grade: t.mix_grade_name, mix_code: t.mix_code,
        order_quantity_m3: n0(t.order_quantity_m3), supplied: 0, distance_km: t.distance_from_plant_km == null ? null : n0(t.distance_from_plant_km),
        site_contact: t.site_contact_number,
        site: site.latitude != null ? { lat: Number(site.latitude), lng: Number(site.longitude), radius_m: Number(t.geofence_radius_m) || 150 } : null,
        trucks: [],
      });
    }
    const o = orders.get(t.order_id);
    o.supplied = r2(o.supplied + row.loaded_quantity_m3);
    o.trucks.push(row);
    return row;
  });
  const running = trucks.filter((t) => t.stage < 4);
  res.json({
    updated_at: new Date().toISOString(),
    plant: plant && plant.latitude != null ? { name: plant.name, lat: Number(plant.latitude), lng: Number(plant.longitude) } : null,
    orders: [...orders.values()].map((o) => ({ ...o, trucks: o.trucks.sort((a, b) => (a.stage === 4) - (b.stage === 4) || new Date(b.created_at) - new Date(a.created_at)) })),
    tiles: {
      orders: [...orders.values()].filter((o) => o.trucks.some((t) => t.stage < 4)).length,
      to_site: running.filter((t) => t.stage <= 0).length,
      at_site: running.filter((t) => t.stage === 1 || t.stage === 2).length,
      returning: running.filter((t) => t.stage === 3).length,
      delayed: running.filter((t) => t.delayed).length,
      gps_stale: running.filter((t) => t.gps_stale).length,
    },
  });
});

// ------------------------------------------------------------ customers ---
router.get("/customers", requirePermission("masters.customers", "view"), async (req, res) => {
  const [{ rows }, pos] = await Promise.all([
    query(
      `SELECT c.id, c.name, c.contact_number, c.is_active,
              (SELECT COUNT(*)::int FROM sites s WHERE s.customer_id = c.id AND COALESCE(s.is_active, true)) AS sites,
              (SELECT MAX(o.order_date)::text FROM customer_orders o WHERE o.customer_id = c.id) AS last_order
         FROM customers c WHERE c.merged_into_id IS NULL ORDER BY c.is_active DESC, c.name`).catch(() =>
      query(`SELECT c.id, c.name, c.contact_number, c.is_active,
                    (SELECT COUNT(*)::int FROM sites s WHERE s.customer_id = c.id) AS sites, NULL AS last_order
               FROM customers c ORDER BY c.is_active DESC, c.name`)),
    positions().catch(() => []),
  ]);
  const by = new Map(pos.map((p) => [p.id, p]));
  res.json(rows.map((c) => ({ ...c, balance: by.get(c.id)?.balance || 0, advance: by.get(c.id)?.advance || 0 })));
});

router.get("/customers/:id(\\d+)", requirePermission("masters.customers", "view"), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: cu } = await query(`SELECT * FROM customers WHERE id = $1`, [id]);
  if (!cu.length) return res.status(404).json({ error: "Customer not found." });
  const [sites, billing, contacts, orders, pos, pdc, month] = await Promise.all([
    safe(query(
      `SELECT s.*, sp.name AS salesperson_name, tc.label AS trip_allowance_label,
              (SELECT MAX(o.order_date)::text FROM customer_orders o WHERE o.site_id = s.id) AS last_order,
              (SELECT string_agg(DISTINCT mg.name, ', ') FROM rate_master rm JOIN mix_grades mg ON mg.id = rm.mix_grade_id
                WHERE rm.site_id = s.id AND COALESCE(rm.is_enabled, true) AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)) AS price_grades
         FROM sites s LEFT JOIN salespersons sp ON sp.id = s.assigned_sales_representative_id
         LEFT JOIN trip_allowance_categories tc ON tc.id = s.trip_allowance_category_id
        WHERE s.customer_id = $1 ORDER BY COALESCE(s.is_active, true) DESC, s.name`, [id])),
    safe(query(`SELECT * FROM customer_billing_addresses WHERE customer_id = $1 ORDER BY is_default DESC, is_active DESC, id`, [id])),
    safe(query(`SELECT sc.*, s.name AS site_name FROM site_contacts sc JOIN sites s ON s.id = sc.site_id WHERE sc.customer_id = $1 AND sc.is_active ORDER BY s.name, sc.contact_name`, [id])),
    safe(query(`${ORDER_SQL} WHERE o.customer_id = $1 ORDER BY o.order_date DESC, o.id DESC LIMIT 8`, [id])),
    positions({ customerId: id }).catch(() => []),
    safe(query(`SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*)::int AS n FROM cheques WHERE direction = 'received' AND customer_id = $1 AND status = 'in_hand'`, [id]), [{ amount: 0, n: 0 }]),
    safe(query(
      `SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) AS m3 FROM delivery_tickets dt JOIN customer_orders o ON o.id = dt.order_id
        WHERE o.customer_id = $1 AND dt.status <> 'cancelled' AND to_char(dt.ticket_date, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')`, [id]), [{ m3: 0 }]),
  ]);
  const p = pos[0];
  const def = billing.find((b) => b.is_default && b.is_active);
  res.json({
    customer: { ...cu[0], gstin: def?.gstin || null },
    balance: p ? p.balance : 0, advance: p ? p.advance : 0, oldest_due_days: p ? p.oldest_due_days : null,
    pdc: { amount: n0(pdc[0]?.amount), n: n0(pdc[0]?.n) }, month_m3: r2(month[0]?.m3),
    sites: sites.map((s) => ({ ...s, has_location: s.latitude != null && s.longitude != null })),
    billing, contacts, orders: orders.map(shapeOrder),
    can_merge: await can(req.user, "masters.customer-merge", "delete"),
  });
});

export default router;
