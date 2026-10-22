// Round 211 — contract labour: contractors, pump gangs, the Site Supervisor's
// daily confirmation, the gang chosen on each pump order, Admin's month-end
// deductions, contractor bills (GST / TDS), payments and the ledger.
// The rules are in lib/gangs.js and lib/round211Schema.js.
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { gangDays, gangMonth, gangMonthClosed, fyOf, tdsFor, MONTH_RE, DATE_RE } from "../lib/gangs.js";
import { monthRange } from "../lib/hrPayroll.js";
import { istDay, istDaysAgo } from "../lib/istDate.js";

const router = Router();
router.use(requireAuth);

const PAY_MODES = ["cash", "bank_transfer", "upi", "cheque"];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const text = (v, max) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };
const int = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
const money = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : r2(v));
const date = (v) => (DATE_RE.test(String(v || "")) ? String(v) : null);
function friendly(err, res, msg) {
  console.error(err);
  if (err.code === "23505") return bad(res, "That already exists — names must be different.", 409);
  if (err.code === "23503") return bad(res, "Something this refers to no longer exists.", 409);
  res.status(500).json({ error: msg });
}
function any(pairs) {
  return async (req, res, next) => {
    try {
      for (const [k, a] of pairs) if (await can(req.user, k, a)) return next();
      return bad(res, "You don't have access to this.", 403);
    } catch (err) { next(err); }
  };
}
const SEE_GANGS = any([["hr.gangs", "view"], ["hr.gang-attendance", "view"], ["hr.contractor-bills", "view"]]);
const SEE_CONTRACTORS = any([["hr.gangs", "view"], ["hr.contractor-bills", "view"], ["hr.employees", "view"]]);

// =============================================================== contractors
const CONTRACTOR_SELECT = `
  SELECT c.*, to_char(c.created_at, 'YYYY-MM-DD') AS created_on,
         (SELECT count(*)::int FROM hr_gangs g WHERE g.contractor_id = c.id AND g.is_active) AS gangs,
         (SELECT count(*)::int FROM hr_employees e WHERE e.contractor_id = c.id AND e.is_active
            AND NOT EXISTS (SELECT 1 FROM hr_gang_members m WHERE m.employee_id = e.id AND m.to_date IS NULL)) AS workers,
         COALESCE((SELECT sum(b.net_payable) FROM hr_contractor_bills b WHERE b.contractor_id = c.id AND b.status = 'approved'), 0)::float
           - COALESCE((SELECT sum(p.amount) FROM hr_contractor_payments p WHERE p.contractor_id = c.id), 0)::float AS balance
    FROM hr_contractors c`;

router.get("/contractors", SEE_CONTRACTORS, async (req, res) => {
  try {
    const { rows } = await query(`${CONTRACTOR_SELECT} ORDER BY c.is_active DESC, c.name`);
    res.json(rows);
  } catch (err) { friendly(err, res, "Could not load the contractors."); }
});

function contractorFields(b) {
  const pan = text(b.pan, 10)?.toUpperCase() || null;
  const gstin = text(b.gstin, 15)?.toUpperCase() || null;
  return {
    name: text(b.name, 120), kind: b.kind === "firm" ? "firm" : "individual", pan,
    gst_registered: !!b.gst_registered, gstin: b.gst_registered ? gstin : null,
    gst_rate: money(b.gst_rate) ?? 18, phone: text(b.phone, 20), address: text(b.address, 500), notes: text(b.notes, 500),
    is_active: b.is_active === undefined ? true : !!b.is_active,
  };
}
function checkContractor(f) {
  if (!f.name) return "Give the contractor's name.";
  if (f.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(f.pan)) return "PAN should look like ABCDE1234F.";
  if (f.gst_registered && (!f.gstin || !/^[0-9]{2}[A-Z0-9]{13}$/.test(f.gstin))) return "Give the 15-character GSTIN, or untick GST registered.";
  if (f.gst_rate < 0 || f.gst_rate > 28) return "GST rate should be between 0 and 28%.";
  return null;
}
router.post("/contractors", any([["hr.gangs", "create"], ["hr.contractor-bills", "create"]]), async (req, res) => {
  const f = contractorFields(req.body || {});
  const e = checkContractor(f); if (e) return bad(res, e);
  try {
    const { rows } = await query(
      `INSERT INTO hr_contractors (name, kind, pan, gst_registered, gstin, gst_rate, phone, address, notes, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [f.name, f.kind, f.pan, f.gst_registered, f.gstin, f.gst_rate, f.phone, f.address, f.notes, f.is_active, req.user.id]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) { friendly(err, res, "Could not save the contractor."); }
});
router.put("/contractors/:id(\\d+)", any([["hr.gangs", "edit"], ["hr.contractor-bills", "create"]]), async (req, res) => {
  const f = contractorFields(req.body || {});
  const e = checkContractor(f); if (e) return bad(res, e);
  try {
    const { rowCount } = await query(
      `UPDATE hr_contractors SET name=$1, kind=$2, pan=$3, gst_registered=$4, gstin=$5, gst_rate=$6, phone=$7, address=$8, notes=$9,
              is_active=$10, updated_by=$11, updated_at=now() WHERE id=$12`,
      [f.name, f.kind, f.pan, f.gst_registered, f.gstin, f.gst_rate, f.phone, f.address, f.notes, f.is_active, req.user.id, req.params.id]);
    if (!rowCount) return bad(res, "Contractor not found.", 404);
    // Keep the old text field on the workers in step, for older screens.
    await query(`UPDATE hr_employees SET contractor_name = $1 WHERE contractor_id = $2`, [f.name, req.params.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the contractor."); }
});

// ===================================================================== gangs
router.get("/gangs", SEE_GANGS, async (req, res) => {
  try {
    const day = date(req.query.date) || istDay();
    const { rows: gangs } = await query(
      `SELECT g.id, g.name, g.contractor_id, c.name AS contractor_name, g.location, g.min_crew, g.notes, g.is_active
         FROM hr_gangs g JOIN hr_contractors c ON c.id = g.contractor_id
        WHERE g.is_active OR $1::boolean ORDER BY g.is_active DESC, g.name`, [req.query.all === "1"]);
    const ids = gangs.map((g) => g.id);
    const seePay = await can(req.user, "hr.gangs", "view");
    const d = ids.length ? await gangDays(ids, day, day) : null;
    res.json({
      date: day,
      gangs: gangs.map((g) => {
        const x = d?.gangs.get(g.id) || { members: [], days: [] };
        const today = x.days[0] || null;
        const members = x.members.map((m) => ({
          membership_id: m.membership_id, employee_id: m.employee_id, name: m.name, emp_code: m.emp_code,
          machine_user_id: m.machine_user_id, mobile: m.mobile, is_leader: m.is_leader, role: m.role,
          from_date: m.from_date, to_date: m.to_date, ...(seePay ? { monthly_rate: m.monthly_rate } : {}),
          today: m.days[0] || null,
        }));
        return {
          ...g, members,
          ...(seePay ? { monthly_total: r2(x.members.filter((m) => !m.to_date || m.to_date >= day).reduce((a, m) => a + m.monthly_rate, 0)) } : {}),
          today: today ? { orders: today.orders, pump: today.pump, crew: today.crew, subs: today.sub_list, confirmed: today.confirmed,
                           punched: x.members.filter((m) => m.days[0]?.punched).length } : null,
        };
      }),
    });
  } catch (err) { friendly(err, res, "Could not load the gangs."); }
});

function gangFields(b) {
  return { name: text(b.name, 60), contractor_id: int(b.contractor_id), location: text(b.location, 80),
           min_crew: int(b.min_crew), notes: text(b.notes, 500), is_active: b.is_active === undefined ? true : !!b.is_active };
}
router.post("/gangs", requirePermission("hr.gangs", "create"), async (req, res) => {
  const f = gangFields(req.body || {});
  if (!f.name) return bad(res, "Give the gang a name.");
  if (!f.contractor_id) return bad(res, "Choose the contractor.");
  try {
    const { rows } = await query(
      `INSERT INTO hr_gangs (name, contractor_id, location, min_crew, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [f.name, f.contractor_id, f.location, f.min_crew, f.notes, req.user.id]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) { friendly(err, res, "Could not save the gang."); }
});
router.put("/gangs/:id(\\d+)", requirePermission("hr.gangs", "edit"), async (req, res) => {
  const f = gangFields(req.body || {});
  if (!f.name) return bad(res, "Give the gang a name.");
  if (!f.contractor_id) return bad(res, "Choose the contractor.");
  try {
    if (!f.is_active) {
      const { rows } = await query(`SELECT count(*)::int AS n FROM hr_gang_members WHERE gang_id = $1 AND to_date IS NULL`, [req.params.id]);
      if (rows[0].n) return bad(res, "End every member's time in the gang before closing it.");
    }
    const { rowCount } = await query(
      `UPDATE hr_gangs SET name=$1, contractor_id=$2, location=$3, min_crew=$4, notes=$5, is_active=$6, updated_by=$7, updated_at=now() WHERE id=$8`,
      [f.name, f.contractor_id, f.location, f.min_crew, f.notes, f.is_active, req.user.id, req.params.id]);
    if (!rowCount) return bad(res, "Gang not found.", 404);
    // Members are the contractor's men: keep their contractor in step.
    await query(
      `UPDATE hr_employees e SET contractor_id = $1, contractor_name = (SELECT name FROM hr_contractors WHERE id = $1)
         FROM hr_gang_members m WHERE m.employee_id = e.id AND m.gang_id = $2 AND m.to_date IS NULL`, [f.contractor_id, req.params.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the gang."); }
});

// Add a member: an existing contract worker, or a new person (made an HR
// employee — contract, machine attendance — so the gate machine counts him).
router.post("/gangs/:id(\\d+)/members", requirePermission("hr.gangs", "create"), async (req, res) => {
  const b = req.body || {};
  const rate = money(b.monthly_rate);
  const from = date(b.from_date) || istDay();
  if (!rate || rate <= 0) return bad(res, "Give his monthly rate.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: g } = await client.query(`SELECT g.*, c.name AS contractor_name FROM hr_gangs g JOIN hr_contractors c ON c.id = g.contractor_id WHERE g.id = $1 AND g.is_active`, [req.params.id]);
    if (!g.length) { await client.query("ROLLBACK"); return bad(res, "Gang not found.", 404); }
    let empId = int(b.employee_id);
    if (!empId) {
      const name = text(b.name, 120);
      if (!name) { await client.query("ROLLBACK"); return bad(res, "Give his name."); }
      const machine = text(b.machine_user_id, 30);
      const { rows: n } = await client.query(`SELECT count(*)::int + 1 AS n FROM hr_employees WHERE emp_code LIKE 'PG%'`);
      let code = `PG${String(n[0].n).padStart(3, "0")}`;
      for (let i = 0; i < 50; i++) {
        const { rows: x } = await client.query(`SELECT 1 FROM hr_employees WHERE emp_code = $1`, [code]);
        if (!x.length) break;
        code = `PG${String(n[0].n + i + 1).padStart(3, "0")}`;
      }
      const { rows: e } = await client.query(
        `INSERT INTO hr_employees (emp_code, name, mobile, designation, employment_type, contractor_id, contractor_name, date_of_joining,
                                   attendance_source, machine_user_id, policy, created_by)
         VALUES ($1,$2,$3,$4,'contract',$5,$6,$7,'machine',$8,'operations',$9) RETURNING id`,
        [code, name, text(b.mobile, 20), text(b.role, 40) || "Pump crew", g[0].contractor_id, g[0].contractor_name, from, machine, req.user.id]);
      empId = e[0].id;
    } else {
      const { rows: e } = await client.query(`SELECT employment_type, is_active FROM hr_employees WHERE id = $1`, [empId]);
      if (!e.length || !e[0].is_active) { await client.query("ROLLBACK"); return bad(res, "That person is not an active employee."); }
      await client.query(`UPDATE hr_employees SET employment_type = 'contract', contractor_id = $1, contractor_name = $2 WHERE id = $3`,
        [g[0].contractor_id, g[0].contractor_name, empId]);
    }
    if (b.is_leader) await client.query(`UPDATE hr_gang_members SET is_leader = false WHERE gang_id = $1 AND to_date IS NULL`, [req.params.id]);
    await client.query(
      `INSERT INTO hr_gang_members (gang_id, employee_id, monthly_rate, is_leader, role, from_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, empId, rate, !!b.is_leader, text(b.role, 40), from, req.user.id]);
    await client.query("COMMIT");
    res.status(201).json({ ok: true, employee_id: empId });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505" && /machine/.test(err.constraint || "")) return bad(res, "Another active person already has that machine ID.", 409);
    if (err.code === "23505" && /member_open/.test(err.constraint || "")) return bad(res, "He is already in a gang — end that first.", 409);
    friendly(err, res, "Could not add the member.");
  } finally { client.release(); }
});

router.put("/gangs/:id(\\d+)/members/:mid(\\d+)", requirePermission("hr.gangs", "edit"), async (req, res) => {
  const b = req.body || {};
  const rate = money(b.monthly_rate);
  if (!rate || rate <= 0) return bad(res, "Give his monthly rate.");
  try {
    if (b.is_leader) await query(`UPDATE hr_gang_members SET is_leader = false WHERE gang_id = $1 AND to_date IS NULL AND id <> $2`, [req.params.id, req.params.mid]);
    const { rowCount } = await query(
      `UPDATE hr_gang_members SET monthly_rate = $1, is_leader = $2, role = $3 WHERE id = $4 AND gang_id = $5`,
      [rate, !!b.is_leader, text(b.role, 40), req.params.mid, req.params.id]);
    if (!rowCount) return bad(res, "Member not found.", 404);
    if (b.machine_user_id !== undefined) {
      await query(`UPDATE hr_employees SET machine_user_id = $1 WHERE id = (SELECT employee_id FROM hr_gang_members WHERE id = $2)`,
        [text(b.machine_user_id, 30), req.params.mid]);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return bad(res, "Another active person already has that machine ID.", 409);
    friendly(err, res, "Could not save.");
  }
});

// End a member's time in the gang (replaced, left). He stays an employee
// unless "left" is ticked, which also ends him as an employee.
router.post("/gangs/:id(\\d+)/members/:mid(\\d+)/end", requirePermission("hr.gangs", "edit"), async (req, res) => {
  const to = date(req.body?.to_date);
  if (!to) return bad(res, "Give the last day in the gang.");
  try {
    const { rows } = await query(
      `UPDATE hr_gang_members SET to_date = $1 WHERE id = $2 AND gang_id = $3 AND to_date IS NULL AND from_date <= $1 RETURNING employee_id`,
      [to, req.params.mid, req.params.id]);
    if (!rows.length) return bad(res, "Not an open membership, or the date is before he joined the gang.");
    if (req.body?.left) {
      await query(`UPDATE hr_employees SET is_active = false, date_of_leaving = $1 WHERE id = $2`, [to, rows[0].employee_id]);
    }
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save."); }
});

// ============================================== the day: confirm the crew
// Site Supervisor: today and yesterday. HR (hr.gangs edit): any day of a
// month not yet closed.
async function mayMarkDay(req, gangId, day) {
  if (day > istDay()) return "That day hasn't come yet.";
  const { rows } = await query(`SELECT 1 FROM hr_gang_months WHERE gang_id = $1 AND month = $2`, [gangId, day.slice(0, 7)]);
  if (rows.length) return "That month is closed for this gang.";
  if (await can(req.user, "hr.gangs", "edit")) return null;
  if (day < istDaysAgo(1)) return "Only today and yesterday can be changed here — ask HR for an older day.";
  return null;
}

router.get("/day", SEE_GANGS, async (req, res) => {
  const day = date(req.query.date) || istDay();
  try {
    const { rows: gangs } = await query(
      `SELECT g.id, g.name, g.location, g.min_crew, c.name AS contractor_name
         FROM hr_gangs g JOIN hr_contractors c ON c.id = g.contractor_id WHERE g.is_active ORDER BY g.name`);
    const d = gangs.length ? await gangDays(gangs.map((g) => g.id), day, day) : null;
    res.json({
      date: day, today: istDay(),
      gangs: gangs.map((g) => {
        const x = d.gangs.get(g.id);
        const dd = x.days[0];
        return {
          ...g, orders: dd.orders, pump: dd.pump, crew: dd.crew, subs: dd.sub_list, confirmed: dd.confirmed,
          members: x.members.map((m) => ({ employee_id: m.employee_id, name: m.name, emp_code: m.emp_code, is_leader: m.is_leader,
                                            role: m.role, machine_user_id: m.machine_user_id, ...m.days[0] })),
        };
      }),
    });
  } catch (err) { friendly(err, res, "Could not load the day."); }
});

router.put("/gangs/:id(\\d+)/day/:date", requirePermission("hr.gang-attendance", "edit"), async (req, res) => {
  const day = date(req.params.date);
  if (!day) return bad(res, "Bad date.");
  const gangId = Number(req.params.id);
  try {
    const why = await mayMarkDay(req, gangId, day);
    if (why) return bad(res, why, 409);
    const marks = Array.isArray(req.body?.marks) ? req.body.marks : [];
    const d = await gangDays([gangId], day, day);
    const g = d.gangs.get(gangId);
    const byEmp = new Map(g.members.map((m) => [m.employee_id, m.days[0]]));
    for (const mk of marks) {
      const empId = int(mk.employee_id);
      const cur = byEmp.get(empId);
      if (!cur || cur.code === undefined) return bad(res, "Someone in the list is not in this gang that day.");
      if (mk.present && !cur.punched && !text(mk.reason, 200)) return bad(res, "Say why each man without a machine punch is marked here (e.g. went straight to the site).");
    }
    const lat = Number.isFinite(Number(req.body?.lat)) ? Number(req.body.lat) : null;
    const lng = Number.isFinite(Number(req.body?.lng)) ? Number(req.body.lng) : null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const mk of marks) {
        const empId = int(mk.employee_id);
        const cur = byEmp.get(empId);
        const present = !!mk.present;
        if (present === cur.punched) {
          // Same as the machine: no override needed.
          await client.query(`DELETE FROM hr_gang_marks WHERE gang_id = $1 AND work_date = $2 AND employee_id = $3`, [gangId, day, empId]);
        } else {
          await client.query(
            `INSERT INTO hr_gang_marks (gang_id, work_date, employee_id, present, reason, lat, lng, marked_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (gang_id, work_date, employee_id) DO UPDATE SET present = EXCLUDED.present, reason = EXCLUDED.reason,
               lat = EXCLUDED.lat, lng = EXCLUDED.lng, marked_by = EXCLUDED.marked_by, marked_at = now()`,
            [gangId, day, empId, present, text(mk.reason, 200), lat, lng, req.user.id]);
        }
      }
      if (req.body?.confirm) {
        await client.query(
          `INSERT INTO hr_gang_days (gang_id, work_date, confirmed_by, confirmed_at, note) VALUES ($1,$2,$3,now(),$4)
           ON CONFLICT (gang_id, work_date) DO UPDATE SET confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now(), note = EXCLUDED.note`,
          [gangId, day, req.user.id, text(req.body?.note, 300)]);
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the day."); }
});

router.post("/gangs/:id(\\d+)/day/:date/subs", requirePermission("hr.gang-attendance", "edit"), async (req, res) => {
  const day = date(req.params.date);
  const name = text(req.body?.name, 80);
  if (!day) return bad(res, "Bad date.");
  if (!name) return bad(res, "Give the substitute's name.");
  try {
    const why = await mayMarkDay(req, Number(req.params.id), day);
    if (why) return bad(res, why, 409);
    const forEmp = int(req.body?.for_employee_id);
    await query(`INSERT INTO hr_gang_subs (gang_id, work_date, name, for_employee_id, added_by) VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, day, name, forEmp, req.user.id]);
    res.status(201).json({ ok: true });
  } catch (err) { friendly(err, res, "Could not add the substitute."); }
});
router.delete("/subs/:id(\\d+)", requirePermission("hr.gang-attendance", "edit"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT gang_id, to_char(work_date, 'YYYY-MM-DD') AS d FROM hr_gang_subs WHERE id = $1`, [req.params.id]);
    if (!rows.length) return bad(res, "Not found.", 404);
    const why = await mayMarkDay(req, rows[0].gang_id, rows[0].d);
    if (why) return bad(res, why, 409);
    await query(`DELETE FROM hr_gang_subs WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not remove."); }
});

// ============================================ the gang chosen on each order
const SEE_ORDERS = any([["orders.pump-gang", "edit"], ["hr.gangs", "view"], ["hr.gang-attendance", "view"]]);
router.get("/gang-options", async (req, res) => {
  try {
    const { rows } = await query(`SELECT id, name FROM hr_gangs WHERE is_active ORDER BY name`);
    res.json(rows);
  } catch (err) { friendly(err, res, "Could not load the gangs."); }
});
router.get("/pump-orders", SEE_ORDERS, async (req, res) => {
  const day = date(req.query.date) || istDay();
  try {
    const { rows } = await query(
      `SELECT o.id, to_char(o.order_date, 'YYYY-MM-DD') AS order_date, to_char(o.scheduled_batching_time, 'HH24:MI') AS time,
              o.status, o.order_quantity_m3::float AS m3, o.pump_requirement, p.pump_code, o.pump_gang_id, g.name AS gang_name,
              o.assigned_pump_crew, c.name AS customer_name, s.name AS site_name, m.name AS mix_grade_name
         FROM customer_orders o
         JOIN customers c ON c.id = o.customer_id JOIN sites s ON s.id = o.site_id JOIN mix_grades m ON m.id = o.mix_grade_id
         LEFT JOIN pumps p ON p.id = o.pump_id LEFT JOIN hr_gangs g ON g.id = o.pump_gang_id
        WHERE o.order_date = $1 AND o.status <> 'cancelled' AND (o.pump_requirement <> 'without_pump' OR o.pump_gang_id IS NOT NULL)
        ORDER BY o.scheduled_batching_time, o.id`, [day]);
    res.json({ date: day, orders: rows, can_edit: await can(req.user, "orders.pump-gang", "edit") });
  } catch (err) { friendly(err, res, "Could not load the orders."); }
});
router.put("/orders/:id(\\d+)/pump-gang", requirePermission("orders.pump-gang", "edit"), async (req, res) => {
  const gangId = int(req.body?.gang_id);
  try {
    const { rows: o } = await query(`SELECT to_char(order_date, 'YYYY-MM-DD') AS d, pump_gang_id, status FROM customer_orders WHERE id = $1`, [req.params.id]);
    if (!o.length) return bad(res, "Order not found.", 404);
    const month = o[0].d.slice(0, 7);
    for (const gid of [o[0].pump_gang_id, gangId].filter(Boolean)) {
      if (await gangMonthClosed(gid, month)) return bad(res, "That gang's month is already closed — ask Admin to reopen it first.", 409);
    }
    let name = null;
    if (gangId) {
      const { rows: g } = await query(`SELECT name FROM hr_gangs WHERE id = $1 AND is_active`, [gangId]);
      if (!g.length) return bad(res, "Gang not found.");
      name = g[0].name;
    }
    await query(
      `UPDATE customer_orders SET pump_gang_id = $1, assigned_pump_crew = CASE WHEN $1::int IS NULL THEN assigned_pump_crew ELSE $2 END,
              pump_gang_set_by = $3, pump_gang_set_at = now() WHERE id = $4`,
      [gangId, name, req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the gang on the order."); }
});

// ============================================================ month register
router.get("/gangs/:id(\\d+)/month/:month", requirePermission("hr.gangs", "view"), async (req, res) => {
  const month = req.params.month;
  if (!MONTH_RE.test(month)) return bad(res, "Bad month.");
  try {
    const m = await gangMonth(Number(req.params.id), month);
    if (!m.gang) return bad(res, "Gang not found.", 404);
    // Round 230 — advances to this gang against this month.
    const { rows: advances } = await query(
      `SELECT a.id, a.status, a.amount::float AS amount, a.approved_amount::float AS approved_amount, a.paid_to,
              p.amount::float AS paid_amount, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on
         FROM hr_gang_advances a LEFT JOIN hr_contractor_payments p ON p.id = a.payment_id
        WHERE a.gang_id = $1 AND a.recover_month = $2 AND a.status IN ('pending', 'approved', 'paid') ORDER BY a.id`,
      [req.params.id, month]).catch(() => ({ rows: [] }));
    res.json({ ...m, advances, can_decide: await can(req.user, "hr.gang-deduction", "edit") });
  } catch (err) { friendly(err, res, "Could not load the month."); }
});

router.put("/gangs/:id(\\d+)/month/:month/deductions", requirePermission("hr.gang-deduction", "edit"), async (req, res) => {
  const month = req.params.month;
  if (!MONTH_RE.test(month)) return bad(res, "Bad month.");
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const { days: dim } = monthRange(month);
  try {
    if (await gangMonthClosed(req.params.id, month)) return bad(res, "This month is closed — reopen it to change deductions.", 409);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const it of items) {
        const emp = int(it.employee_id);
        const days = Number(it.days || 0);
        if (!emp || !Number.isFinite(days) || days < 0 || days > dim || Math.round(days * 2) !== days * 2) {
          await client.query("ROLLBACK"); return bad(res, "Days to deduct must be whole or half days within the month.");
        }
        if (days === 0 && !text(it.note, 200)) {
          await client.query(`DELETE FROM hr_gang_deductions WHERE gang_id = $1 AND month = $2 AND employee_id = $3`, [req.params.id, month, emp]);
        } else {
          await client.query(
            `INSERT INTO hr_gang_deductions (gang_id, month, employee_id, days, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (gang_id, month, employee_id) DO UPDATE SET days = EXCLUDED.days, note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
            [req.params.id, month, emp, days, text(it.note, 200), req.user.id]);
        }
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the deductions."); }
});

router.post("/gangs/:id(\\d+)/month/:month/close", requirePermission("hr.gang-deduction", "edit"), async (req, res) => {
  const month = req.params.month;
  if (!MONTH_RE.test(month)) return bad(res, "Bad month.");
  try {
    const m = await gangMonth(Number(req.params.id), month);
    if (!m.gang) return bad(res, "Gang not found.", 404);
    if (m.closed) return bad(res, "Already closed.", 409);
    if (!m.finished) return bad(res, "The month isn't over yet.", 409);
    if (!m.members.length) return bad(res, "No members in this gang that month.", 409);
    const detail = {
      days_in_month: m.days_in_month,
      members: m.members.map((x) => ({ employee_id: x.employee_id, name: x.name, is_leader: x.is_leader, monthly_rate: x.monthly_rate,
        days_in_gang: x.days_in_gang, base: x.base, summary: x.summary, deduction: x.deduction })),
      pump_days: m.days.filter((d) => d.pump).length, idle_crew_days: m.members.reduce((a, x) => a + x.summary.idle, 0),
    };
    await query(`INSERT INTO hr_gang_months (gang_id, month, gross, deduction, amount, detail, closed_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, month, m.gross, m.deduction, m.amount, JSON.stringify(detail), req.user.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not close the month."); }
});

router.post("/gangs/:id(\\d+)/month/:month/reopen", requirePermission("hr.gang-deduction", "edit"), async (req, res) => {
  const month = req.params.month;
  if (!MONTH_RE.test(month)) return bad(res, "Bad month.");
  try {
    const { rows } = await query(
      `SELECT b.status FROM hr_contractor_bills b JOIN hr_gangs g ON g.contractor_id = b.contractor_id WHERE g.id = $1 AND b.month = $2`,
      [req.params.id, month]);
    if (rows.length) return bad(res, rows[0].status === "approved"
      ? "The contractor's bill for this month is approved — it can't change now."
      : "Delete the contractor's draft bill for this month first.", 409);
    await query(`DELETE FROM hr_gang_months WHERE gang_id = $1 AND month = $2`, [req.params.id, month]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not reopen the month."); }
});

// ===================================================================== bills
async function buildBill(contractorId, month) {
  const { rows: c } = await query(`SELECT * FROM hr_contractors WHERE id = $1`, [contractorId]);
  if (!c.length) return { error: "Contractor not found." };
  const { from, to } = monthRange(month);
  // Gangs of this contractor that had members in the month must all be closed.
  const { rows: gangs } = await query(
    `SELECT g.id, g.name, gm.amount::float AS amount, gm.gross::float AS gross, gm.deduction::float AS deduction, gm.detail
       FROM hr_gangs g LEFT JOIN hr_gang_months gm ON gm.gang_id = g.id AND gm.month = $2
      WHERE g.contractor_id = $1 AND EXISTS (SELECT 1 FROM hr_gang_members m WHERE m.gang_id = g.id
              AND m.from_date <= $4::date AND (m.to_date IS NULL OR m.to_date >= $3::date))
      ORDER BY g.name`, [contractorId, month, from, to]);
  const open = gangs.filter((g) => g.amount == null);
  if (open.length) return { error: `Close the month for ${open.map((g) => g.name).join(", ")} first.` };
  // Individual contract labour: their payroll lines (earnings + the
  // contractor's service charge). Gang members are not in payroll.
  const { rows: ind } = await query(
    `SELECT l.employee_id, e.name, e.emp_code, l.calc, l.net_pay::float AS net_pay, l.paid_amount
       FROM hr_payroll_lines l JOIN hr_employees e ON e.id = l.employee_id
      WHERE l.month = $1 AND e.employment_type = 'contract' AND e.contractor_id = $2
        AND NOT EXISTS (SELECT 1 FROM hr_gang_members m WHERE m.employee_id = e.id AND m.from_date <= $4::date AND (m.to_date IS NULL OR m.to_date >= $3::date))
      ORDER BY e.name`, [month, contractorId, from, to]);
  if (ind.length) {
    const { rows: run } = await query(`SELECT status FROM hr_payroll_runs WHERE month = $1`, [month]);
    if (run[0]?.status !== "locked") return { error: "This contractor has individual workers on payroll — lock the month's payroll first." };
  }
  const individuals = ind.map((l) => {
    const calc = l.calc || {};
    const amount = Math.round(Number(calc.total_earnings || 0) + Number(calc.service_charge || 0));
    return { employee_id: l.employee_id, name: l.name, emp_code: l.emp_code, paid_days: calc.paid_days, wages: Number(calc.total_earnings || 0),
             service_charge: Number(calc.service_charge || 0), amount, marked_paid_in_payroll: l.paid_amount != null };
  });
  if (!gangs.length && !individuals.length) return { error: "Nothing to bill for this contractor this month." };
  const gangsAmount = Math.round(gangs.reduce((a, g) => a + g.amount, 0));
  const individualAmount = individuals.reduce((a, x) => a + x.amount, 0);
  const taxable = gangsAmount + individualAmount;
  const gstRate = c[0].gst_registered ? Number(c[0].gst_rate) : 0;
  const gstAmount = Math.round(taxable * gstRate / 100);
  const fy = fyOf(month);
  const { rows: earlier } = await query(
    `SELECT COALESCE(sum(taxable), 0)::float AS t FROM hr_contractor_bills WHERE contractor_id = $1 AND month BETWEEN $2 AND $3 AND month <> $4`,
    [contractorId, fy.from, fy.to, month]);
  const tds = tdsFor(c[0], taxable, earlier[0].t);
  return {
    contractor: c[0],
    row: {
      gangs_amount: gangsAmount, individual_amount: individualAmount, taxable, gst_rate: gstRate, gst_amount: gstAmount,
      tds_rate: tds.rate, tds_amount: tds.amount, tds_note: tds.note, net_payable: taxable + gstAmount - tds.amount,
      detail: { gangs: gangs.map((g) => ({ gang_id: g.id, name: g.name, gross: g.gross, deduction: g.deduction, amount: g.amount, members: g.detail.members })),
                individuals, fy: fy.label, fy_total_with_this: tds.year_total },
    },
  };
}

router.get("/bills", requirePermission("hr.contractor-bills", "view"), async (req, res) => {
  const month = MONTH_RE.test(req.query.month || "") ? req.query.month : null;
  if (!month) return bad(res, "Give the month.");
  try {
    const { from, to } = monthRange(month);
    const { rows: contractors } = await query(`${CONTRACTOR_SELECT} WHERE c.is_active ORDER BY c.name`);
    const { rows: bills } = await query(
      `SELECT b.*, to_char(b.their_invoice_date, 'YYYY-MM-DD') AS their_invoice_date, ua.name AS approved_by_name,
              to_char(b.approved_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY') AS approved_on,
              COALESCE((SELECT sum(amount) FROM hr_contractor_payments p WHERE p.bill_id = b.id), 0)::float AS paid_against
         FROM hr_contractor_bills b LEFT JOIN users ua ON ua.id = b.approved_by WHERE b.month = $1`, [month]);
    const { rows: gangState } = await query(
      `SELECT g.contractor_id, g.id, g.name, (gm.gang_id IS NOT NULL) AS closed
         FROM hr_gangs g LEFT JOIN hr_gang_months gm ON gm.gang_id = g.id AND gm.month = $1
        WHERE EXISTS (SELECT 1 FROM hr_gang_members m WHERE m.gang_id = g.id AND m.from_date <= $3::date AND (m.to_date IS NULL OR m.to_date >= $2::date))`,
      [month, from, to]);
    const byC = new Map(bills.map((b) => [b.contractor_id, b]));
    // Round 230 — gang advances paid against this month: already in the
    // contractor's ledger as on-account payments, shown here so the balance
    // still to pay on the bill is plain.
    const { rows: adv } = await query(
      `SELECT g.contractor_id, a.id, g.name AS gang_name, p.amount::float AS amount, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on
         FROM hr_gang_advances a JOIN hr_gangs g ON g.id = a.gang_id JOIN hr_contractor_payments p ON p.id = a.payment_id
        WHERE a.status = 'paid' AND a.recover_month = $1 ORDER BY p.paid_on`, [month]);
    res.json({
      month,
      contractors: contractors.map((c) => {
        const advances = adv.filter((a) => a.contractor_id === c.id);
        return {
          ...c, bill: byC.get(c.id) || null,
          gangs: gangState.filter((g) => g.contractor_id === c.id),
          gang_advances: advances, gang_advances_total: r2(advances.reduce((t, a) => t + a.amount, 0)),
        };
      }),
    });
  } catch (err) { friendly(err, res, "Could not load the bills."); }
});

router.post("/bills", requirePermission("hr.contractor-bills", "create"), async (req, res) => {
  const month = MONTH_RE.test(req.body?.month || "") ? req.body.month : null;
  const cid = int(req.body?.contractor_id);
  if (!month || !cid) return bad(res, "Give the contractor and month.");
  try {
    const b = await buildBill(cid, month);
    if (b.error) return bad(res, b.error, 409);
    const r = b.row;
    const { rows } = await query(
      `INSERT INTO hr_contractor_bills (contractor_id, month, gangs_amount, individual_amount, taxable, gst_rate, gst_amount, tds_rate, tds_amount,
                                        tds_note, net_payable, their_invoice_no, their_invoice_date, detail, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [cid, month, r.gangs_amount, r.individual_amount, r.taxable, r.gst_rate, r.gst_amount, r.tds_rate, r.tds_amount, r.tds_note, r.net_payable,
       text(req.body?.their_invoice_no, 40), date(req.body?.their_invoice_date), JSON.stringify(r.detail), req.user.id]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return bad(res, "There is already a bill for this contractor and month.", 409);
    friendly(err, res, "Could not make the bill.");
  }
});

router.put("/bills/:id(\\d+)", requirePermission("hr.contractor-bills", "create"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM hr_contractor_bills WHERE id = $1`, [req.params.id]);
    if (!rows.length) return bad(res, "Bill not found.", 404);
    const bill = rows[0];
    if (bill.status === "approved") return bad(res, "An approved bill can't change.", 409);
    let r = null;
    if (req.body?.recalculate) {
      const b = await buildBill(bill.contractor_id, bill.month);
      if (b.error) return bad(res, b.error, 409);
      r = b.row;
    }
    // The contractor's GST invoice must be given for a GST bill before approval;
    // its number and date can be filled any time before.
    await query(
      `UPDATE hr_contractor_bills SET their_invoice_no = $1, their_invoice_date = $2,
              gangs_amount = COALESCE($3, gangs_amount), individual_amount = COALESCE($4, individual_amount), taxable = COALESCE($5, taxable),
              gst_rate = COALESCE($6, gst_rate), gst_amount = COALESCE($7, gst_amount), tds_rate = COALESCE($8, tds_rate), tds_amount = COALESCE($9, tds_amount),
              tds_note = COALESCE($10, tds_note), net_payable = COALESCE($11, net_payable), detail = COALESCE($12, detail)
        WHERE id = $13`,
      [text(req.body?.their_invoice_no, 40), date(req.body?.their_invoice_date),
       r?.gangs_amount ?? null, r?.individual_amount ?? null, r?.taxable ?? null, r?.gst_rate ?? null, r?.gst_amount ?? null,
       r?.tds_rate ?? null, r?.tds_amount ?? null, r?.tds_note ?? null, r?.net_payable ?? null, r ? JSON.stringify(r.detail) : null, req.params.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not save the bill."); }
});

router.post("/bills/:id(\\d+)/approve", requirePermission("hr.contractor-bills", "edit"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.*, c.gst_registered FROM hr_contractor_bills b JOIN hr_contractors c ON c.id = b.contractor_id WHERE b.id = $1`, [req.params.id]);
    if (!rows.length) return bad(res, "Bill not found.", 404);
    if (rows[0].status === "approved") return bad(res, "Already approved.", 409);
    if (Number(rows[0].gst_amount) > 0 && !rows[0].their_invoice_no) return bad(res, "Enter the contractor's tax invoice number before approving a GST bill.");
    await query(`UPDATE hr_contractor_bills SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2`, [req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not approve the bill."); }
});

router.delete("/bills/:id(\\d+)", requirePermission("hr.contractor-bills", "delete"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT status FROM hr_contractor_bills WHERE id = $1`, [req.params.id]);
    if (!rows.length) return bad(res, "Bill not found.", 404);
    const isAdmin = ["administrator", "super_admin"].includes(req.user.role);
    if (rows[0].status === "approved" && !isAdmin) return bad(res, "Only an Administrator can delete an approved bill.", 403);
    const { rows: p } = await query(`SELECT count(*)::int AS n FROM hr_contractor_payments WHERE bill_id = $1`, [req.params.id]);
    if (p[0].n) return bad(res, "Payments are recorded against this bill — remove them first.", 409);
    await query(`DELETE FROM hr_contractor_bills WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not delete the bill."); }
});

// ============================================================ payments, ledger
router.get("/contractors/:id(\\d+)/ledger", requirePermission("hr.contractor-bills", "view"), async (req, res) => {
  try {
    const { rows: c } = await query(`${CONTRACTOR_SELECT} WHERE c.id = $1`, [req.params.id]);
    if (!c.length) return bad(res, "Contractor not found.", 404);
    const { rows: bills } = await query(
      `SELECT id, month, taxable::float, gst_amount::float, tds_amount::float, net_payable::float, their_invoice_no,
              COALESCE(to_char(their_invoice_date, 'YYYY-MM-DD'), to_char(approved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')) AS d
         FROM hr_contractor_bills WHERE contractor_id = $1 AND status = 'approved'`, [req.params.id]);
    const { rows: pays } = await query(
      `SELECT p.id, to_char(p.paid_on, 'YYYY-MM-DD') AS d, p.amount::float, p.mode, p.ref, p.note, p.bill_id, b.month AS bill_month, u.name AS by_name
         FROM hr_contractor_payments p LEFT JOIN hr_contractor_bills b ON b.id = p.bill_id LEFT JOIN users u ON u.id = p.created_by
        WHERE p.contractor_id = $1`, [req.params.id]);
    const entries = [
      ...bills.map((b) => ({ kind: "bill", id: b.id, date: b.d, label: `Bill ${b.month}${b.their_invoice_no ? ` · their invoice ${b.their_invoice_no}` : ""}`,
        detail: `₹${b.taxable.toLocaleString("en-IN")}${b.gst_amount ? ` + GST ₹${b.gst_amount.toLocaleString("en-IN")}` : ""}${b.tds_amount ? ` − TDS ₹${b.tds_amount.toLocaleString("en-IN")}` : ""}`,
        credit: b.net_payable, debit: 0 })),
      ...pays.map((p) => ({ kind: "payment", id: p.id, date: p.d, label: p.bill_id ? `Paid against ${p.bill_month} bill` : "Advance / on account",
        detail: [p.mode.replace("_", " "), p.ref, p.note].filter(Boolean).join(" · "), credit: 0, debit: p.amount, by: p.by_name })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === "bill" ? -1 : 1));
    let bal = 0;
    for (const e of entries) { bal = r2(bal + e.credit - e.debit); e.balance = bal; }
    const { rows: open } = await query(
      `SELECT id, month, net_payable::float FROM hr_contractor_bills WHERE contractor_id = $1 AND status = 'approved' ORDER BY month DESC LIMIT 12`, [req.params.id]);
    res.json({ contractor: c[0], entries, balance: bal, bills: open });
  } catch (err) { friendly(err, res, "Could not load the ledger."); }
});

router.post("/contractors/:id(\\d+)/payments", requirePermission("hr.contractor-bills", "create"), async (req, res) => {
  const b = req.body || {};
  const amount = money(b.amount);
  const on = date(b.paid_on);
  if (!amount || amount <= 0) return bad(res, "Give the amount paid.");
  if (!on) return bad(res, "Give the payment date.");
  if (on > istDay()) return bad(res, "The payment date can't be in the future.");
  try {
    const billId = int(b.bill_id);
    if (billId) {
      const { rows } = await query(`SELECT 1 FROM hr_contractor_bills WHERE id = $1 AND contractor_id = $2 AND status = 'approved'`, [billId, req.params.id]);
      if (!rows.length) return bad(res, "That bill isn't an approved bill of this contractor.");
    }
    await query(
      `INSERT INTO hr_contractor_payments (contractor_id, bill_id, paid_on, amount, mode, ref, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.params.id, billId, on, amount, PAY_MODES.includes(b.mode) ? b.mode : "bank_transfer", text(b.ref, 60), text(b.note, 200), req.user.id]);
    res.status(201).json({ ok: true });
  } catch (err) { friendly(err, res, "Could not record the payment."); }
});

router.delete("/payments/:id(\\d+)", requirePermission("hr.contractor-bills", "delete"), async (req, res) => {
  try {
    // Round 230 — a gang advance paid through this entry goes back to
    // "approved, not paid" so it can be paid again correctly.
    await query(`UPDATE hr_gang_advances SET status = 'approved', payment_id = NULL, paid_to = NULL WHERE payment_id = $1`, [req.params.id]);
    const { rowCount } = await query(`DELETE FROM hr_contractor_payments WHERE id = $1`, [req.params.id]);
    if (!rowCount) return bad(res, "Not found.", 404);
    res.json({ ok: true });
  } catch (err) { friendly(err, res, "Could not remove the payment."); }
});

export default router;
