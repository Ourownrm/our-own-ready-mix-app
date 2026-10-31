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
import { breakEven, lineKinds, BE_KEYS, ensureMixedKinds } from "../lib/breakEven.js";
import { waterMonth, waterSettings, ensureWater } from "../lib/waterCost.js";
import { plBreakup, BREAKUP_KEYS } from "../lib/plBreakup.js";

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

// Round 255 — every entry behind one P&L line (owner: "what contributed this 5.3 lakh").
router.get("/pl/breakup", requirePermission("cost.pl", "view"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const key = String(req.query.key || "");
  if (!BREAKUP_KEYS.has(key)) return res.status(400).json({ error: "Pick a line of the Profit & Loss." });
  const period = ["month", "quarter", "ytd"].includes(req.query.period) ? req.query.period : "month";
  res.json(await plBreakup(ym, key, { period }));
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
  const fixedAmounts = req.body?.fixed_amounts || {};
  const entries = Object.entries(kinds).filter(([k, v]) => BE_KEYS.has(k) && ["fixed", "variable", "mixed"].includes(v));
  if (!entries.length) return res.status(400).json({ error: "Nothing to change." });
  // Round 225 — "mixed": a fixed ₹ a month, the rest variable.
  for (const [k, v] of entries) {
    if (v !== "mixed") continue;
    const amt = Number(fixedAmounts[k]);
    if (!(amt >= 0) || amt > 1e9) return res.status(400).json({ error: "Part fixed: give the fixed ₹ a month (e.g. the power bill's fixed / demand charge)." });
  }
  await ensureMixedKinds();
  for (const [k, v] of entries) {
    await query(
      `INSERT INTO cost_line_kinds (line_key, kind, fixed_amount, changed_by, changed_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (line_key) DO UPDATE SET kind = EXCLUDED.kind, fixed_amount = EXCLUDED.fixed_amount, changed_by = EXCLUDED.changed_by, changed_at = now()`,
      [k, v, v === "mixed" ? Math.round(Number(fixedAmounts[k]) * 100) / 100 : null, req.user.id]);
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

// ---------------------------------------------------------- Round 245: water
// Owner, 27 Oct 2026: a rate for the plant's own water, and purchased water.
// Viewing: anyone who sees the P&L; changing: whoever enters the month's
// expenses (cost.entries · edit).
router.get("/water", requirePermission("cost.pl", "view"), async (req, res) => {
  const now = istMonth();
  const ym = MONTH_RE.test(String(req.query.month || "")) ? req.query.month : now;
  const settings = await waterSettings();
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonths(ym, -i));
  const trend = [];
  for (const m of months) {
    const w = await waterMonth(m, settings);
    trend.push({ month: m, used_l: w.used_l, bought_l: w.bought_l, value: w.value });
  }
  res.json({ settings, month: await waterMonth(ym, settings), trend });
});

router.put("/water/settings", requirePermission("cost.entries", "edit"), async (req, res) => {
  await ensureWater();
  const b = req.body || {};
  const rate = b.own_rate_kl === "" || b.own_rate_kl == null ? null : Number(b.own_rate_kl);
  if (rate != null && !(rate >= 0 && rate <= 10000)) return res.status(400).json({ error: "Rate per kilolitre: 0 to 10,000." });
  const changes = Array.isArray(b.rates) ? b.rates : [];
  for (const c of changes) if (!DAY_RE.test(c.from_date || "") || !(Number(c.rate_kl) >= 0)) return res.status(400).json({ error: "Each rate change needs a date and a rate." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE cost_water_settings SET own_rate_kl = $1, own_note = $2, updated_by = $3, updated_at = now() WHERE id = 1`,
      [rate, String(b.own_note || "").trim().slice(0, 200) || null, req.user.id]);
    await client.query(`DELETE FROM cost_water_rates`);
    for (const c of changes) {
      await client.query(`INSERT INTO cost_water_rates (from_date, rate_kl, note) VALUES ($1, $2, $3) ON CONFLICT (from_date) DO UPDATE SET rate_kl = EXCLUDED.rate_kl, note = EXCLUDED.note`,
        [c.from_date, Number(c.rate_kl), String(c.note || "").slice(0, 200) || null]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ settings: await waterSettings() });
});

function purchaseBody(b) {
  const p = {
    bought_on: String(b.bought_on || ""), supplier: String(b.supplier || "").trim().slice(0, 120) || null,
    litres: Number(String(b.litres ?? "").replace(/,/g, "")), amount: Number(String(b.amount ?? "").replace(/[,₹\s]/g, "")),
    bill_no: String(b.bill_no || "").trim().slice(0, 60) || null, note: String(b.note || "").trim().slice(0, 200) || null,
  };
  if (!DAY_RE.test(p.bought_on)) return { err: "Date bought: yyyy-mm-dd." };
  if (p.bought_on > istDay()) return { err: "The date bought can't be in the future." };
  if (!(p.litres > 0)) return { err: "Litres must be more than 0." };
  if (!(p.amount >= 0)) return { err: "Amount must be 0 or more." };
  return { p };
}
router.post("/water/purchases", requirePermission("cost.entries", "edit"), async (req, res) => {
  await ensureWater();
  const { p, err } = purchaseBody(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const { rows } = await query(
    `INSERT INTO cost_water_purchases (bought_on, supplier, litres, amount, bill_no, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.bought_on, p.supplier, p.litres, p.amount, p.bill_no, p.note, req.user.id]);
  res.status(201).json({ id: rows[0].id });
});
router.put("/water/purchases/:id(\\d+)", requirePermission("cost.entries", "edit"), async (req, res) => {
  const { p, err } = purchaseBody(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const r = await query(`UPDATE cost_water_purchases SET bought_on=$1, supplier=$2, litres=$3, amount=$4, bill_no=$5, note=$6 WHERE id=$7`,
    [p.bought_on, p.supplier, p.litres, p.amount, p.bill_no, p.note, Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
});
router.delete("/water/purchases/:id(\\d+)", requirePermission("cost.entries", "edit"), async (req, res) => {
  const r = await query(`DELETE FROM cost_water_purchases WHERE id = $1`, [Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
});

export default router;
