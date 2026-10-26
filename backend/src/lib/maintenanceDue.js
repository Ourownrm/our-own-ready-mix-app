// Round 215 — meter readings and "what is due" for the Maintenance module.
//
// READINGS. An asset's km and hour meter are the highest value recorded
// anywhere the app already keeps them for its linked master row — fuel
// requests (supply_requests), the old self-logged fuel_logs, the weekly truck
// inspection — plus anything typed on the Equipment screen or at a PM
// inspection (mnt_meter_readings). Odometers only go up, so MAX is right and
// cannot be fooled by the order entries arrived in.
//
// m³ CARRIED is summed live from delivery tickets for the linked truck (or
// pump) since the schedule was last done — the same rule the old Maintenance
// tab used (Round 136).
//
// WHICH PAIRS (Round 215c). A schedule is planned against vehicle MODELS
// (mnt_pm_schedule_models); every active vehicle of those models gets it.
// mnt_pm_schedule_assets only holds each vehicle's "last done" record, and a
// vehicle with no row there simply has not been done yet.
//
// DUE. Each (schedule, asset) pair is classified on whichever of its triggers
// is worst. "Never done" pairs have no baseline yet: they show as "Not done
// yet" until someone completes an inspection or the Administrator sets the
// last-done date / reading on the PM schedules screen.
import { query as dbQuery } from "../db.js";

export const TRIGGER_LABEL = {
  day: "day", week: "week", month: "month", km: "km", hours: "hours", m3: "m³", once_km: "km",
};

function fmt(n) {
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function triggerText(s) {
  const e = Number(s.every);
  let t;
  switch (s.trigger_type) {
    case "day": t = e === 1 ? "Every day" : `Every ${fmt(e)} days`; break;
    case "week": t = e === 1 ? "Every week" : `Every ${fmt(e)} weeks`; break;
    case "month": t = e === 1 ? "Every month" : `Every ${fmt(e)} months`; break;
    case "km": t = `Every ${fmt(e)} km`; break;
    case "hours": t = `Every ${fmt(e)} hours`; break;
    case "m3": t = `Every ${fmt(e)} m³ carried`; break;
    case "once_km": t = `Once at ${fmt(e)} km`; break;
    default: t = "";
  }
  const extra = [];
  if (s.or_hours) extra.push(`${fmt(s.or_hours)} hours`);
  if (s.or_months) extra.push(`${s.or_months} month${s.or_months > 1 ? "s" : ""}`);
  if (s.or_days) extra.push(`${s.or_days} days`);
  if (extra.length) t += ` or ${extra.join(" or ")}`;
  if (extra.length) t += " — whichever first";
  return t;
}

const READINGS_SQL = `
SELECT a.id,
  GREATEST(
    (SELECT MAX(km) FROM mnt_meter_readings r WHERE r.asset_id = a.id),
    (SELECT MAX(odometer_reading) FROM supply_requests s
      WHERE s.status <> 'rejected' AND ((a.truck_id IS NOT NULL AND s.truck_id = a.truck_id)
        OR (a.pump_id IS NOT NULL AND s.pump_id = a.pump_id) OR (a.equipment_id IS NOT NULL AND s.equipment_id = a.equipment_id))),
    (SELECT MAX(odometer_reading) FROM fuel_logs f
      WHERE (a.truck_id IS NOT NULL AND f.truck_id = a.truck_id)
        OR (a.pump_id IS NOT NULL AND f.pump_id = a.pump_id) OR (a.equipment_id IS NOT NULL AND f.equipment_id = a.equipment_id)),
    (SELECT MAX(odometer_reading) FROM truck_inspections t WHERE a.truck_id IS NOT NULL AND t.truck_id = a.truck_id)
  ) AS km,
  GREATEST(
    (SELECT MAX(hours) FROM mnt_meter_readings r WHERE r.asset_id = a.id),
    (SELECT MAX(hour_meter_reading) FROM supply_requests s
      WHERE s.status <> 'rejected' AND ((a.truck_id IS NOT NULL AND s.truck_id = a.truck_id)
        OR (a.pump_id IS NOT NULL AND s.pump_id = a.pump_id) OR (a.equipment_id IS NOT NULL AND s.equipment_id = a.equipment_id))),
    (SELECT MAX(hour_meter_reading) FROM fuel_logs f
      WHERE (a.truck_id IS NOT NULL AND f.truck_id = a.truck_id)
        OR (a.pump_id IS NOT NULL AND f.pump_id = a.pump_id) OR (a.equipment_id IS NOT NULL AND f.equipment_id = a.equipment_id)),
    (SELECT MAX(hour_meter_reading) FROM truck_inspections t WHERE a.truck_id IS NOT NULL AND t.truck_id = a.truck_id)
  ) AS hours
FROM mnt_assets a
WHERE a.is_active AND ($1::int[] IS NULL OR a.id = ANY($1::int[]))`;

/** asset id -> { km, hours } (numbers or null). */
export async function assetReadings(assetIds = null, q = dbQuery) {
  const { rows } = await q(READINGS_SQL, [assetIds]);
  const out = {};
  for (const r of rows) out[r.id] = { km: r.km == null ? null : Number(r.km), hours: r.hours == null ? null : Number(r.hours) };
  return out;
}

const DAY = 86400000;

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10); // ist-ok: calendar arithmetic on a yyyy-mm-dd string, no clock
}
function addDays(dateStr, days) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10); // ist-ok: calendar arithmetic on a yyyy-mm-dd string, no clock
}
function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / DAY);
}

const RANK = { overdue: 0, due_soon: 1, never: 2, ok: 3, done: 4, unknown: 5 };

function worst(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RANK[a.status] <= RANK[b.status] ? a : b;
}

// One trigger -> { status, left (text), next (text), sort }
function timePart(lastDate, days, months, today) {
  if (!lastDate) return null;
  const next = months ? addMonths(lastDate, months) : addDays(lastDate, days);
  const left = daysBetween(today, next);
  const span = months ? months * 30 : days;
  let status = "ok";
  if (left < 0) status = "overdue";
  else if (left === 0 || left <= Math.min(7, Math.max(1, Math.round(span * 0.25)))) status = "due_soon";
  const leftText = left < 0 ? `${-left} day${left === -1 ? "" : "s"} over` : left === 0 ? "Today" : `${left} day${left === 1 ? "" : "s"}`;
  return { status, left: leftText, next: next, nextKind: "date", sort: left };
}

function meterPart(lastVal, every, current, unit, softAbs) {
  if (lastVal == null) return null;
  if (current == null) return { status: "unknown", left: `no ${unit} reading`, next: `${fmt(Number(lastVal) + every)} ${unit}`, nextKind: unit, sort: 99999 };
  const nextAt = Number(lastVal) + every;
  const left = nextAt - current;
  let status = "ok";
  if (left < 0) status = "overdue";
  else if (left <= Math.max(softAbs, every * 0.1)) status = "due_soon";
  return { status, left: left < 0 ? `${fmt(-left)} ${unit} over` : `${fmt(left)} ${unit}`, next: `${fmt(nextAt)} ${unit}`, nextKind: unit, sort: left };
}

/**
 * Classify one pair. `p` carries the schedule's trigger columns, the pair's
 * baseline (last_done_*), the asset's readings and m³ since last done.
 */
export function classify(p, today) {
  const every = Number(p.every);
  const t = p.trigger_type;
  const hasBaseline = p.last_done_date != null || p.last_done_km != null || p.last_done_hours != null;

  if (t === "once_km") {
    if (p.last_done_date) return { status: "done", left: "Done", next: "—", sort: 1e9 };
    if (p.km == null) return { status: "unknown", left: "no km reading", next: `${fmt(every)} km`, sort: 99999 };
    const left = every - p.km;
    const status = left < 0 ? "overdue" : left <= Math.max(300, every * 0.15) ? "due_soon" : "ok";
    return { status, left: left < 0 ? `${fmt(-left)} km over` : `${fmt(left)} km`, next: `${fmt(every)} km`, sort: left };
  }
  if (!hasBaseline) return { status: "never", left: "Not done yet", next: "—", sort: -1 };

  let r = null;
  if (t === "day") r = worst(r, timePart(p.last_done_date, every, null, today));
  if (t === "week") r = worst(r, timePart(p.last_done_date, every * 7, null, today));
  if (t === "month") r = worst(r, timePart(p.last_done_date, null, every, today));
  if (t === "km") r = worst(r, meterPart(p.last_done_km, every, p.km, "km", 500));
  if (t === "hours") r = worst(r, meterPart(p.last_done_hours, every, p.hours, "h", 20));
  if (t === "m3") {
    if (p.last_done_date) {
      const left = every - Number(p.m3_since || 0);
      const status = left < 0 ? "overdue" : left <= every * 0.1 ? "due_soon" : "ok";
      r = worst(r, { status, left: left < 0 ? `${fmt(-left)} m³ over` : `${fmt(left)} m³`, next: `${fmt(every)} m³`, sort: left });
    }
  }
  if (p.or_hours) r = worst(r, meterPart(p.last_done_hours, Number(p.or_hours), p.hours, "h", 20));
  if (p.or_months) r = worst(r, timePart(p.last_done_date, null, Number(p.or_months), today));
  if (p.or_days) r = worst(r, timePart(p.last_done_date, Number(p.or_days), null, today));
  return r || { status: "never", left: "Not done yet", next: "—", sort: -1 };
}

/**
 * Every active (schedule, asset) pair with its status. Optional filters:
 * { assetId, scheduleId }.
 */
export async function dueList({ assetId = null, scheduleId = null, assigneeId = null } = {}, q = dbQuery) {
  const { rows } = await q(`
    SELECT s.id AS schedule_id, s.name AS schedule_name, s.trigger_type, s.every, s.or_months, s.or_days, s.or_hours, s.basis,
           a.id AS asset_id, a.name AS asset_name, a.asset_group, a.truck_id, a.pump_id,
           sa.last_done_date::text AS last_done_date, sa.last_done_km, sa.last_done_hours,
           pa.user_id AS assignee_id, au.name AS assignee_name, au.role::text AS assignee_role,
           (SELECT json_build_object('done', c.done, 'at', c.at, 'note', c.note, 'by', cu.name)
              FROM mnt_pm_confirmations c LEFT JOIN users cu ON cu.id = c.user_id
             WHERE c.schedule_id = s.id AND c.asset_id = a.id ORDER BY c.at DESC LIMIT 1) AS last_confirmation,
           CURRENT_DATE::text AS today,
           CASE WHEN s.trigger_type = 'm3' AND sa.last_done_date IS NOT NULL THEN (
             SELECT COALESCE(SUM(dt.loaded_quantity_m3), 0) FROM delivery_tickets dt
             WHERE dt.status NOT IN ('cancelled', 'rejected') AND dt.ticket_date > sa.last_done_date
               AND ((a.truck_id IS NOT NULL AND dt.truck_id = a.truck_id) OR (a.pump_id IS NOT NULL AND dt.pump_id = a.pump_id))
           ) END AS m3_since
    FROM mnt_pm_schedules s
    JOIN mnt_pm_schedule_models sm ON sm.schedule_id = s.id
    JOIN mnt_assets a ON a.model_id = sm.model_id AND a.is_active
    LEFT JOIN mnt_pm_schedule_assets sa ON sa.schedule_id = s.id AND sa.asset_id = a.id
    LEFT JOIN mnt_pm_assignees pa ON pa.schedule_id = s.id AND pa.asset_id = a.id
    LEFT JOIN users au ON au.id = pa.user_id
    WHERE s.is_active AND ($1::int IS NULL OR a.id = $1) AND ($2::int IS NULL OR s.id = $2)
      AND ($3::int IS NULL OR pa.user_id = $3)`, [assetId, scheduleId, assigneeId]);
  if (!rows.length) return [];
  const readings = await assetReadings([...new Set(rows.map((r) => r.asset_id))], q);
  const today = rows[0].today;
  return rows.map((r) => {
    const rd = readings[r.asset_id] || {};
    const c = classify({ ...r, km: rd.km ?? null, hours: rd.hours ?? null, m3_since: r.m3_since == null ? null : Number(r.m3_since) }, today);
    return {
      schedule_id: r.schedule_id, schedule_name: r.schedule_name, basis: r.basis,
      trigger_type: r.trigger_type, every: r.every == null ? null : Number(r.every),
      assignee_id: r.assignee_id, assignee_name: r.assignee_name, assignee_role: r.assignee_role, last_confirmation: r.last_confirmation,
      trigger: triggerText(r), asset_id: r.asset_id, asset_name: r.asset_name, asset_group: r.asset_group,
      last_done_date: r.last_done_date, last_done_km: r.last_done_km == null ? null : Number(r.last_done_km),
      last_done_hours: r.last_done_hours == null ? null : Number(r.last_done_hours),
      km: rd.km ?? null, hours: rd.hours ?? null, m3_since: r.m3_since == null ? null : Number(r.m3_since),
      status: c.status, left: c.left, next: c.next, sort: c.sort,
    };
  }).sort((a, b) => RANK[a.status] - RANK[b.status] || a.sort - b.sort);
}
