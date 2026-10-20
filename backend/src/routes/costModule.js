// Round 218 — the Cost module (owner, 20 Oct 2026): Cost dashboard, Profit &
// Loss, Balance Sheet, and the figures Accounts keys in each month.
// Administrator only by default (owner: "only with admin access"); a Super
// Admin can switch any page on for someone else on the Access Control page.
//
// The arithmetic lives in lib/costDashboard.js; this file only checks input
// and permissions.
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { istMonth, istDay } from "../lib/istDate.js";
import {
  MONTH_RE, PL_ENTERED, PL_ENTERED_KEYS, BS_ENTERED, BS_ENTERED_KEYS,
  costDashboard, fuelDetail, profitLoss, balanceSheet, monthEntries, balancesOn, addMonths, monthLabel, newContext, monthCore, withTotals,
} from "../lib/costDashboard.js";
import { breakEven, lineKinds, BE_KEYS } from "../lib/breakEven.js";

const router = Router();
router.use(requireAuth);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A month to report on: given, else the last full month; never in the future.
function pickMonth(req, res) {
  const now = istMonth();
  const ym = req.query.month || addMonths(now, -1);
  if (!MONTH_RE.test(ym)) { res.status(400).json({ error: "Pick a month (YYYY-MM)." }); return null; }
  if (ym > now) { res.status(400).json({ error: "That month has not started yet." }); return null; }
  return ym;
}

router.get("/dashboard", requirePermission("cost.dashboard", "view"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  res.json(await costDashboard(ym));
});

// Round 219 — every entry behind the Diesel tile, with how each was valued.
router.get("/fuel-detail", requirePermission("cost.dashboard", "view"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  res.json(await fuelDetail(ym));
});

router.get("/pl", requirePermission("cost.pl", "view"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const period = ["month", "quarter", "ytd"].includes(req.query.period) ? req.query.period : "month";
  const compare = req.query.compare === "last_year" ? "last_year" : "prev";
  res.json(await profitLoss(ym, { period, compare }));
});

router.get("/balance-sheet", requirePermission("cost.balance-sheet", "view"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const compare = req.query.compare === "prev" ? "prev" : "fy_start";
  res.json(await balanceSheet(ym, { compare }));
});

// Round 221 — Break-even: fixed and variable costs, and the day each month
// covered its fixed costs.
router.get("/break-even", requirePermission("cost.break-even", "view"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  res.json(await breakEven(ym));
});

// Which group each cost is in (one setting for every month).
router.put("/line-kinds", requirePermission("cost.classify", "edit"), async (req, res) => {
  const kinds = req.body?.kinds || {};
  const entries = Object.entries(kinds).filter(([k, v]) => BE_KEYS.has(k) && ["fixed", "variable"].includes(v));
  if (!entries.length) return res.status(400).json({ error: "Nothing to change." });
  for (const [k, v] of entries) {
    await query(
      `INSERT INTO cost_line_kinds (line_key, kind, changed_by, changed_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (line_key) DO UPDATE SET kind = EXCLUDED.kind, changed_by = EXCLUDED.changed_by, changed_at = now()`,
      [k, v, req.user.id]);
  }
  res.json({ ok: true, kinds: await lineKinds() });
});

// ------------------------------------------------- the month's expenses ---
router.get("/entries", requirePermission("cost.entries", "view"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const prev = addMonths(ym, -1);
  const [cur, last, log] = await Promise.all([
    monthEntries(ym), monthEntries(prev),
    query(`SELECT l.line_key, l.old_amount, l.new_amount, l.note, l.changed_at, u.name AS by_name
             FROM cost_entry_log l LEFT JOIN users u ON u.id = l.changed_by
            WHERE l.kind = 'month' AND l.period = $1 ORDER BY l.changed_at DESC LIMIT 50`, [ym]),
  ]);
  // A suggestion for the tax line: the month's profit before tax × the rate
  // the owner's mock-up used (25.17%, the 22% regime with surcharge and cess).
  const ctx = await newContext();
  const core = await monthCore(ym, ctx);
  const t = withTotals({ ...core.amounts, tax: 0 });
  res.json({
    month: ym, label: monthLabel(ym, true), prev_label: monthLabel(prev),
    lines: PL_ENTERED.map((e) => ({ ...e, value: cur[e.key] || null, last_month: last[e.key]?.amount ?? null })),
    tax_suggestion: t.pbt > 0 ? r2(t.pbt * 0.2517) : 0, pbt_before_tax_line: t.pbt,
    log: log.rows.map((r) => ({ ...r, old_amount: r.old_amount == null ? null : Number(r.old_amount), new_amount: r.new_amount == null ? null : Number(r.new_amount),
      label: PL_ENTERED.find((e) => e.key === r.line_key)?.label || r.line_key })),
  });
});

router.put("/entries", requirePermission("cost.entries", "edit"), async (req, res) => {
  const ym = String(req.body?.month || "");
  if (!MONTH_RE.test(ym) || ym > istMonth()) return res.status(400).json({ error: "Pick a month that has started." });
  const values = req.body?.values || {};
  const note = String(req.body?.note || "").trim() || null;
  const client = await pool.connect();
  let changed = 0;
  try {
    await client.query("BEGIN");
    for (const [key, raw] of Object.entries(values)) {
      if (!PL_ENTERED_KEYS.has(key)) continue;
      const clear = raw === null || raw === "";
      const amount = clear ? null : Number(raw);
      if (!clear && (!Number.isFinite(amount) || amount < 0)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Enter a valid amount for ${PL_ENTERED.find((e) => e.key === key).label}.` });
      }
      const { rows } = await client.query(`SELECT amount FROM cost_month_entries WHERE month = $1 AND line_key = $2 FOR UPDATE`, [ym, key]);
      const old = rows[0] ? Number(rows[0].amount) : null;
      if ((old == null && clear) || (old != null && !clear && Math.abs(old - amount) < 0.005)) continue;
      if (clear) await client.query(`DELETE FROM cost_month_entries WHERE month = $1 AND line_key = $2`, [ym, key]);
      else {
        await client.query(
          `INSERT INTO cost_month_entries (month, line_key, amount, note, entered_by, entered_at) VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (month, line_key) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note, entered_by = EXCLUDED.entered_by, entered_at = now()`,
          [ym, key, r2(amount), note, req.user.id]);
      }
      await client.query(
        `INSERT INTO cost_entry_log (kind, period, line_key, old_amount, new_amount, note, changed_by) VALUES ('month', $1, $2, $3, $4, $5, $6)`,
        [ym, key, old, clear ? null : r2(amount), note, req.user.id]);
      changed += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, changed });
});

// ---------------------------------------------- Balance Sheet figures ---
router.get("/balances", requirePermission("cost.entries", "view"), async (req, res) => {
  const day = DAY_RE.test(req.query.as_on || "") ? req.query.as_on : istDay();
  const [inForce, onDay, log] = await Promise.all([
    balancesOn(day),
    query(`SELECT line_key, amount FROM cost_balances WHERE as_on = $1::date`, [day]),
    query(`SELECT l.line_key, l.period, l.old_amount, l.new_amount, l.note, l.changed_at, u.name AS by_name
             FROM cost_entry_log l LEFT JOIN users u ON u.id = l.changed_by
            WHERE l.kind = 'balance' ORDER BY l.changed_at DESC LIMIT 50`),
  ]);
  const exact = new Map(onDay.rows.map((r) => [r.line_key, Number(r.amount)]));
  res.json({
    as_on: day,
    lines: BS_ENTERED.map((e) => ({ ...e, value: exact.has(e.key) ? exact.get(e.key) : null,
      in_force: inForce[e.key] ? { amount: inForce[e.key].amount, as_on: inForce[e.key].as_on } : null })),
    log: log.rows.map((r) => ({ ...r, old_amount: r.old_amount == null ? null : Number(r.old_amount), new_amount: r.new_amount == null ? null : Number(r.new_amount),
      label: BS_ENTERED.find((e) => e.key === r.line_key)?.label || r.line_key })),
  });
});

router.put("/balances", requirePermission("cost.entries", "edit"), async (req, res) => {
  const day = String(req.body?.as_on || "");
  if (!DAY_RE.test(day) || day > istDay()) return res.status(400).json({ error: "Pick the date these figures are as on (not in the future)." });
  const values = req.body?.values || {};
  const note = String(req.body?.note || "").trim() || null;
  const client = await pool.connect();
  let changed = 0;
  try {
    await client.query("BEGIN");
    for (const [key, raw] of Object.entries(values)) {
      if (!BS_ENTERED_KEYS.has(key)) continue;
      const clear = raw === null || raw === "";
      const amount = clear ? null : Number(raw);
      if (!clear && !Number.isFinite(amount)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Enter a valid amount for ${BS_ENTERED.find((e) => e.key === key).label}.` });
      }
      const { rows } = await client.query(`SELECT amount FROM cost_balances WHERE as_on = $1::date AND line_key = $2 FOR UPDATE`, [day, key]);
      const old = rows[0] ? Number(rows[0].amount) : null;
      if ((old == null && clear) || (old != null && !clear && Math.abs(old - amount) < 0.005)) continue;
      if (clear) await client.query(`DELETE FROM cost_balances WHERE as_on = $1::date AND line_key = $2`, [day, key]);
      else {
        await client.query(
          `INSERT INTO cost_balances (as_on, line_key, amount, note, entered_by, entered_at) VALUES ($1::date, $2, $3, $4, $5, now())
           ON CONFLICT (as_on, line_key) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note, entered_by = EXCLUDED.entered_by, entered_at = now()`,
          [day, key, r2(amount), note, req.user.id]);
      }
      await client.query(
        `INSERT INTO cost_entry_log (kind, period, line_key, old_amount, new_amount, note, changed_by) VALUES ('balance', $1, $2, $3, $4, $5, $6)`,
        [day, key, old, clear ? null : r2(amount), note, req.user.id]);
      changed += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, changed });
});

export default router;
