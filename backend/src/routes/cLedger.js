// Round 224 — Cost → C Ledger (owner, 21 Oct 2026). The rules, and who may see
// what, are in lib/cLedger.js. Every route here is gated by the person's own
// C Ledger rights (cl_access) — NOT by role: Administrator and Super Admin see
// nothing unless ticked. Only the /access routes (who has which right) are
// Super Admin's.
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { istMonth, istDay } from "../lib/istDate.js";
import { MONTH_RE, monthBounds, monthLabel } from "../lib/costDashboard.js";
import {
  CL_CATEGORIES, CL_CATEGORY_KEYS, CL_INCOME_KINDS, CL_INCOME_KEYS, CL_FACTOR, clAccess, requireCl, clLog, holderBalances, clDeliveryTotal,
} from "../lib/cLedger.js";
import { ensureRound235, postPayment, unpostPayment } from "../lib/ledgerPost.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound235(); next(); } catch (e) { next(e); } });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const bad = (res, msg) => res.status(400).json({ error: msg });
const txt = (v, max) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };

function pickMonth(req, res) {
  const now = istMonth();
  const ym = req.query.month || now;
  if (!MONTH_RE.test(ym) || ym > now) { bad(res, "Pick a month (YYYY-MM)."); return null; }
  return ym;
}
function cleanDay(v) {
  const d = String(v || "");
  return ISO.test(d) && d <= istDay() ? d : null;
}
async function cashHolderIds(client = null) {
  const { rows } = await (client || { query }).query(
    `SELECT a.user_id FROM cl_access a JOIN users u ON u.id = a.user_id WHERE a.is_cash_holder AND u.is_active`);
  return new Set(rows.map((r) => r.user_id));
}

// ------------------------------------------------------------------ me ---
router.get("/me", async (req, res) => {
  const a = await clAccess(req.user.id);
  if (!a.any) return res.json({ access: a });
  const { rows } = await query(
    `SELECT a.user_id AS id, COALESCE(a.short_name, u.name) AS short, u.name FROM cl_access a JOIN users u ON u.id = a.user_id
      WHERE a.is_cash_holder AND u.is_active ORDER BY COALESCE(a.short_name, u.name)`);
  res.json({ access: a, me: req.user.id, holders: rows, categories: CL_CATEGORIES, income_kinds: CL_INCOME_KINDS, today: istDay(), month: istMonth() });
});

// ---------------------------------------------------- delivery records ---
async function deliveriesFor(where, params) {
  const { rows } = await query(
    `SELECT d.id, d.entry_date::text AS entry_date, d.customer_name, d.location, d.grade, d.qty_m3, d.rate, d.other_charges,
            d.sales_rep, d.flagged, d.note, d.created_at, cu.name AS created_by_name, uu.name AS updated_by_name, d.updated_at,
            COALESCE((SELECT json_agg(json_build_object('id', c.id, 'amount', c.amount, 'holder_id', c.holder_id,
                        'holder', COALESCE(ca.short_name, hu.name, 'Bank'), 'mode', c.mode, 'status', c.status, 'reject_reason', c.reject_reason,
                        'paid_on', c.paid_on::text, 'bank', c.holder_id IS NULL)
                        ORDER BY c.id)
                        FROM cl_collections c LEFT JOIN users hu ON hu.id = c.holder_id LEFT JOIN cl_access ca ON ca.user_id = c.holder_id
                       WHERE c.delivery_id = d.id), '[]') AS collections,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'number', t.ticket_number, 'date', t.ticket_date::text,
                        'loaded', t.loaded_quantity_m3) ORDER BY t.ticket_date, t.id)
                        FROM cl_delivery_tickets l JOIN delivery_tickets t ON t.id = l.ticket_id WHERE l.delivery_id = d.id), '[]') AS tickets
       FROM cl_deliveries d
       LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users uu ON uu.id = d.updated_by
      WHERE d.deleted_at IS NULL AND ${where}
      ORDER BY d.entry_date DESC, d.id DESC`, params);
  return rows.map((d) => {
    const total = clDeliveryTotal(d);
    const colls = d.collections.map((c) => ({ ...c, amount: n0(c.amount) }));
    const collected = r2(colls.filter((c) => c.status !== "rejected").reduce((t, c) => t + c.amount, 0));
    return {
      ...d, qty_m3: n0(d.qty_m3), rate: n0(d.rate), other_charges: n0(d.other_charges), collections: colls,
      tickets: d.tickets.map((t) => ({ ...t, loaded: n0(t.loaded) })),
      total, collected, balance: r2(total - collected),
      rejected: r2(colls.filter((c) => c.status === "rejected").reduce((t, c) => t + c.amount, 0)),
      pending: r2(colls.filter((c) => c.status === "pending").reduce((t, c) => t + c.amount, 0)),
      // Round 227 — a record with no delivery note is not a sale (owner).
      sales_value: d.tickets.length ? r2(total * (d.flagged ? CL_FACTOR : 1)) : 0,
    };
  });
}

router.get("/deliveries", requireCl("view_entries"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const { from, end } = monthBounds(ym);
  const list = await deliveriesFor(`d.entry_date BETWEEN $1::date AND $2::date`, [from, end]);
  const sum = (k) => r2(list.reduce((t, d) => t + d[k], 0));
  res.json({
    month: ym, label: monthLabel(ym, true), deliveries: list,
    summary: {
      count: list.length, m3: sum("qty_m3"), billed: sum("total"), collected: sum("collected"), balance: sum("balance"),
      pending: sum("pending"), rejected: sum("rejected"), sales_value: sum("sales_value"),
      flagged: list.filter((d) => d.flagged).length, unlinked: list.filter((d) => !d.tickets.length).length,
      unlinked_total: r2(list.filter((d) => !d.tickets.length).reduce((t, d) => t + d.total, 0)),
    },
    rejected_lines: list.flatMap((d) => d.collections.filter((c) => c.status === "rejected")
      .map((c) => ({ ...c, delivery_id: d.id, customer_name: d.customer_name, entry_date: d.entry_date }))),
  });
});

// Delivery notes to tie a record to: a few days around the date, or by
// number / customer / site.
router.get("/tickets", requireCl("entry"), async (req, res) => {
  const day = ISO.test(req.query.day || "") ? req.query.day : istDay();
  const q = String(req.query.q || "").trim();
  const params = [day];
  let where = `t.ticket_date BETWEEN ($1::date - 3) AND ($1::date + 1)`;
  if (q) {
    params.push(`%${q}%`);
    where = `t.ticket_date BETWEEN ($1::date - 60) AND ($1::date + 1)
             AND (t.ticket_number ILIKE $2 OR c.name ILIKE $2 OR s.name ILIKE $2)`;
  }
  const { rows } = await query(
    `SELECT t.id, t.ticket_number AS number, t.ticket_date::text AS date, t.loaded_quantity_m3 AS loaded,
            c.name AS customer, s.name AS site, g.name AS grade,
            i.rate_per_m3, COALESCE(i.pumping_charge, 0) + COALESCE(i.part_load_charge, 0) + COALESCE(i.waiting_charge, 0) AS other,
            l.delivery_id AS linked_to
       FROM delivery_tickets t
       JOIN customer_orders o ON o.id = t.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN sites s ON s.id = o.site_id
       LEFT JOIN mix_grades g ON g.id = o.mix_grade_id
       LEFT JOIN invoices i ON i.ticket_id = t.id
       LEFT JOIN cl_delivery_tickets l ON l.ticket_id = t.id
      WHERE t.status <> 'cancelled' AND t.loaded_quantity_m3 IS NOT NULL AND ${where}
      ORDER BY t.ticket_date DESC, t.id DESC LIMIT 80`, params);
  res.json({ tickets: rows.map((r) => ({ ...r, loaded: n0(r.loaded), rate_per_m3: r.rate_per_m3 == null ? null : n0(r.rate_per_m3), other: n0(r.other) })) });
});

function cleanDelivery(b) {
  const entry_date = cleanDay(b.entry_date);
  if (!entry_date) return { error: "Pick the date (not in the future)." };
  const customer_name = txt(b.customer_name, 200);
  if (!customer_name) return { error: "Enter the customer name." };
  const qty = Number(b.qty_m3 || 0), rate = Number(b.rate || 0), oth = Number(b.other_charges || 0);
  if (![qty, rate, oth].every((v) => Number.isFinite(v) && v >= 0)) return { error: "Quantity, rate and other charges must be numbers (0 or more)." };
  if (qty > 9999 || rate > 999999 || oth > 9999999) return { error: "Check the quantity, rate and other charges." };
  const grade = txt(b.grade, 20)?.toUpperCase() || null;
  const ticket_ids = [...new Set((Array.isArray(b.ticket_ids) ? b.ticket_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const lines = [];
  for (const c of Array.isArray(b.collections) ? b.collections : []) {
    const amount = Number(c.amount);
    if (!c.amount || !Number.isFinite(amount) || amount <= 0) continue;
    // Round 227 — "Paid to bank": no cash holder, the day it reached the bank.
    const bank = c.holder_id === "bank" || c.mode === "bank";
    lines.push({ id: Number(c.id) || null, amount: r2(amount), holder_id: bank ? null : Number(c.holder_id),
      mode: bank ? "bank" : ["cash", "upi", "cheque"].includes(c.mode) ? c.mode : "cash", paid_on: bank ? (cleanDay(c.paid_on) || entry_date) : null });
  }
  return {
    entry_date, customer_name, location: txt(b.location, 200), grade, qty_m3: r2(qty), rate: r2(rate), other_charges: r2(oth),
    sales_rep: txt(b.sales_rep, 100), flagged: !!b.flagged, note: txt(b.note, 500), ticket_ids, lines,
  };
}

// Writes the ticket links and the not-yet-accepted collection lines of one
// record, inside the caller's transaction.
async function writeLinksAndLines(client, id, d, holders) {
  if (d.ticket_ids.length) {
    const { rows: taken } = await client.query(
      `SELECT l.ticket_id, t.ticket_number FROM cl_delivery_tickets l JOIN delivery_tickets t ON t.id = l.ticket_id
        WHERE l.ticket_id = ANY($1::int[]) AND l.delivery_id <> $2`, [d.ticket_ids, id]);
    if (taken.length) return `${taken.map((t) => t.ticket_number).join(", ")} already belong${taken.length === 1 ? "s" : ""} to another C Ledger record.`;
  }
  await client.query(`DELETE FROM cl_delivery_tickets WHERE delivery_id = $1 AND NOT (ticket_id = ANY($2::int[]))`, [id, d.ticket_ids]);
  for (const t of d.ticket_ids) {
    await client.query(`INSERT INTO cl_delivery_tickets (delivery_id, ticket_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, t]);
  }
  const { rows: existing } = await client.query(`SELECT * FROM cl_collections WHERE delivery_id = $1 FOR UPDATE`, [id]);
  // Locked: accepted by a cash holder. A "paid to bank" line stays editable.
  const isLocked = (c) => c.status === "accepted" && c.holder_id != null;
  const accepted = existing.filter(isLocked);
  const total = clDeliveryTotal(d);
  const sum = accepted.reduce((t, c) => t + n0(c.amount), 0) + d.lines.reduce((t, c) => t + c.amount, 0);
  if (sum > total + 0.5) return `Collections (₹${r2(sum).toLocaleString("en-IN")}) are more than the total (₹${total.toLocaleString("en-IN")}).`;
  for (const l of d.lines) if (l.mode !== "bank" && !holders.has(l.holder_id)) return "Each collection line needs a cash holder, or Bank.";
  // Accepted lines are locked; every other line is replaced by what was sent.
  const keep = new Set();
  for (const l of d.lines) {
    const old = l.id ? existing.find((c) => c.id === l.id && !isLocked(c)) : null;
    if (old && l.mode === "bank") {
      await client.query(
        `UPDATE cl_collections SET amount = $2, holder_id = NULL, mode = 'bank', paid_on = $3, status = 'accepted', reject_reason = NULL,
                responded_at = COALESCE(responded_at, now()) WHERE id = $1`, [old.id, l.amount, l.paid_on]);
      keep.add(old.id);
    } else if (old) {
      const changed = n0(old.amount) !== l.amount || old.holder_id !== l.holder_id || old.mode !== l.mode;
      // A rejected line that is saved again goes back to the cash holder.
      await client.query(
        `UPDATE cl_collections SET amount = $2, holder_id = $3, mode = $4,
                status = CASE WHEN status = 'rejected' OR $5 THEN 'pending' ELSE status END,
                reject_reason = CASE WHEN status = 'rejected' OR $5 THEN NULL ELSE reject_reason END,
                responded_at = CASE WHEN status = 'rejected' OR $5 THEN NULL ELSE responded_at END, paid_on = NULL
          WHERE id = $1`, [old.id, l.amount, l.holder_id, l.mode, changed]);
      keep.add(old.id);
    } else {
      const bank = l.mode === "bank";
      const { rows } = await client.query(
        `INSERT INTO cl_collections (delivery_id, amount, holder_id, mode, paid_on, status, responded_at)
         VALUES ($1, $2, $3, $4, $5, $6::varchar, CASE WHEN $6::varchar = 'accepted' THEN now() END) RETURNING id`,
        [id, l.amount, l.holder_id, l.mode, l.paid_on, bank ? "accepted" : "pending"]);
      keep.add(rows[0].id);
    }
  }
  for (const c of existing) {
    if (!isLocked(c) && !keep.has(c.id)) await client.query(`DELETE FROM cl_collections WHERE id = $1`, [c.id]);
  }
  return null;
}

router.post("/deliveries", requireCl("entry"), async (req, res) => {
  const d = cleanDelivery(req.body || {});
  if (d.error) return bad(res, d.error);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const holders = await cashHolderIds(client);
    const { rows } = await client.query(
      `INSERT INTO cl_deliveries (entry_date, customer_name, location, grade, qty_m3, rate, other_charges, sales_rep, flagged, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [d.entry_date, d.customer_name, d.location, d.grade, d.qty_m3, d.rate, d.other_charges, d.sales_rep, d.flagged, d.note, req.user.id]);
    const id = rows[0].id;
    const err = await writeLinksAndLines(client, id, d, holders);
    if (err) { await client.query("ROLLBACK"); return bad(res, err); }
    await clLog(client, "delivery", id, "created", { ...d }, req.user.id);
    await client.query("COMMIT");
    res.json({ ok: true, id });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

router.put("/deliveries/:id", requireCl("entry"), async (req, res) => {
  const id = Number(req.params.id);
  const d = cleanDelivery(req.body || {});
  if (d.error) return bad(res, d.error);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: cur } = await client.query(`SELECT * FROM cl_deliveries WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
    if (!cur.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "That record is not there any more." }); }
    const holders = await cashHolderIds(client);
    await client.query(
      `UPDATE cl_deliveries SET entry_date = $2, customer_name = $3, location = $4, grade = $5, qty_m3 = $6, rate = $7, other_charges = $8,
              sales_rep = $9, flagged = $10, note = $11, updated_by = $12, updated_at = now() WHERE id = $1`,
      [id, d.entry_date, d.customer_name, d.location, d.grade, d.qty_m3, d.rate, d.other_charges, d.sales_rep, d.flagged, d.note, req.user.id]);
    const err = await writeLinksAndLines(client, id, d, holders);
    if (err) { await client.query("ROLLBACK"); return bad(res, err); }
    await clLog(client, "delivery", id, "edited", { before: cur[0], after: d }, req.user.id);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

router.post("/deliveries/:id/flag", requireCl("entry"), async (req, res) => {
  const { rowCount } = await query(
    `UPDATE cl_deliveries SET flagged = $2, updated_by = $3, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [Number(req.params.id), !!req.body?.flagged, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: "That record is not there any more." });
  await clLog(null, "delivery", Number(req.params.id), req.body?.flagged ? "flagged" : "unflagged", null, req.user.id);
  res.json({ ok: true });
});

router.delete("/deliveries/:id", requireCl("entry"), async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM cl_collections WHERE delivery_id = $1 AND status = 'accepted' AND holder_id IS NOT NULL`, [id]);
    if (rows[0].n) { await client.query("ROLLBACK"); return bad(res, "A cash holder has already accepted cash on this record, so it can't be deleted. Edit it instead."); }
    const { rowCount } = await client.query(`UPDATE cl_deliveries SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, req.user.id]);
    if (!rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "That record is not there any more." }); }
    await client.query(`DELETE FROM cl_collections WHERE delivery_id = $1`, [id]);
    await client.query(`DELETE FROM cl_delivery_tickets WHERE delivery_id = $1`, [id]);
    await clLog(client, "delivery", id, "deleted", null, req.user.id);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

// ------------------------------------------------------- cash holder ---
async function expensesFor(where, params) {
  const { rows } = await query(
    `SELECT x.id, x.holder_id, COALESCE(a.short_name, u.name) AS holder, x.txn_date::text AS txn_date, x.amount, x.where_spent,
            x.category, x.flagged, x.created_at, x.party_id, x.post_kind, x.post_id,
            CASE x.post_kind WHEN 'supplier' THEN (SELECT name FROM rm_suppliers WHERE id = x.party_id)
              WHEN 'transporter' THEN (SELECT name FROM rm_transporters WHERE id = x.party_id)
              WHEN 'contractor' THEN (SELECT name FROM hr_contractors WHERE id = x.party_id) END AS party_name
       FROM cl_expenses x JOIN users u ON u.id = x.holder_id LEFT JOIN cl_access a ON a.user_id = x.holder_id
      WHERE x.deleted_at IS NULL AND ${where} ORDER BY x.txn_date DESC, x.id DESC`, params);
  return rows.map((x) => ({ ...x, amount: n0(x.amount), cost: CL_CATEGORIES.find((c) => c.key === x.category)?.notCost ? 0 : r2(n0(x.amount) * (x.flagged ? CL_FACTOR : 1)) }));
}
async function transfersFor(where, params) {
  const { rows } = await query(
    `SELECT t.id, t.txn_date::text AS txn_date, t.kind, t.from_id, t.to_id, t.amount, t.note, t.status, t.created_at,
            COALESCE(fa.short_name, fu.name) AS from_name, COALESCE(ta.short_name, tu.name) AS to_name
       FROM cl_transfers t JOIN users fu ON fu.id = t.from_id LEFT JOIN cl_access fa ON fa.user_id = t.from_id
       LEFT JOIN users tu ON tu.id = t.to_id LEFT JOIN cl_access ta ON ta.user_id = t.to_id
      WHERE t.deleted_at IS NULL AND ${where} ORDER BY t.txn_date DESC, t.id DESC`, params);
  return rows.map((t) => ({ ...t, amount: n0(t.amount) }));
}
// Round 227 — other income.
async function incomesFor(where, params) {
  const { rows } = await query(
    `SELECT i.id, i.txn_date::text AS txn_date, i.kind, i.source, i.amount, i.received_by, i.status, i.reject_reason, i.flagged,
            i.created_by, COALESCE(ra.short_name, ru.name, 'Bank') AS received_name, cu.name AS created_by_name
       FROM cl_incomes i LEFT JOIN users ru ON ru.id = i.received_by LEFT JOIN cl_access ra ON ra.user_id = i.received_by
       LEFT JOIN users cu ON cu.id = i.created_by
      WHERE i.deleted_at IS NULL AND ${where} ORDER BY i.txn_date DESC, i.id DESC`, params);
  return rows.map((i) => ({ ...i, amount: n0(i.amount), kind_label: CL_INCOME_KINDS.find((k) => k.key === i.kind)?.label || i.kind,
    counted: i.status === "rejected" ? 0 : r2(n0(i.amount) * (i.flagged ? CL_FACTOR : 1)) }));
}

router.get("/wallet", requireCl("cash_holder"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const { from, end } = monthBounds(ym);
  const me = req.user.id;
  const [bal, incoming, incomingT, colls, transfers, expenses, incomes, incomingI] = await Promise.all([
    holderBalances(),
    query(`SELECT c.id, c.amount, c.mode, c.created_at, d.id AS delivery_id, d.entry_date::text AS entry_date, d.customer_name, d.location, d.flagged,
                  (SELECT string_agg(t.ticket_number, ', ') FROM cl_delivery_tickets l JOIN delivery_tickets t ON t.id = l.ticket_id WHERE l.delivery_id = d.id) AS tickets
             FROM cl_collections c JOIN cl_deliveries d ON d.id = c.delivery_id
            WHERE c.holder_id = $1 AND c.status = 'pending' AND d.deleted_at IS NULL ORDER BY d.entry_date DESC, c.id DESC`, [me]),
    transfersFor(`t.to_id = $1 AND t.kind = 'holder' AND t.status = 'pending'`, [me]),
    query(`SELECT c.id, c.amount, c.status, c.reject_reason, d.entry_date::text AS txn_date, d.customer_name, d.location, d.flagged
             FROM cl_collections c JOIN cl_deliveries d ON d.id = c.delivery_id
            WHERE c.holder_id = $1 AND c.status <> 'pending' AND d.deleted_at IS NULL AND d.entry_date BETWEEN $2::date AND $3::date`, [me, from, end]),
    transfersFor(`(t.from_id = $1 OR t.to_id = $1) AND t.txn_date BETWEEN $2::date AND $3::date`, [me, from, end]),
    expensesFor(`x.holder_id = $1 AND x.txn_date BETWEEN $2::date AND $3::date`, [me, from, end]),
    incomesFor(`i.received_by = $1 AND i.status <> 'pending' AND i.txn_date BETWEEN $2::date AND $3::date`, [me, from, end]),
    incomesFor(`i.received_by = $1 AND i.status = 'pending'`, [me]),
  ]);
  const mine = bal.find((b) => b.id === me) || { id: me, balance: 0, collected: 0, transfer_in: 0, transfer_out: 0, deposited: 0, expenses: 0, awaiting: 0 };
  // One list of everything that moved this person's cash, newest first.
  const tx = [];
  for (const c of colls.rows) tx.push({ kind: "collection", id: c.id, date: c.txn_date, amount: n0(c.amount), sign: c.status === "accepted" ? 1 : 0,
    desc: `Collection · ${c.customer_name}`, meta: [c.location, c.status === "rejected" ? `rejected${c.reject_reason ? `: ${c.reject_reason}` : ""}` : null].filter(Boolean).join(" · "),
    status: c.status, flagged: c.flagged });
  for (const t of transfers) {
    const out = t.from_id === me;
    // Round 253 — kind 'petty': cash handed into a petty cash box (taken
    // back only from Accounts → Petty cash, where the top-up is cancelled).
    const petty = t.kind === "petty";
    tx.push({ kind: t.kind === "bank" ? "deposit" : petty ? "petty" : "transfer", id: t.id, date: t.txn_date, amount: t.amount,
      sign: out ? (t.status === "rejected" ? 0 : -1) : (t.status === "accepted" ? 1 : 0),
      desc: t.kind === "bank" ? "Deposited to bank" : petty ? "Given to petty cash" : out ? `Transfer to ${t.to_name}` : `Transfer from ${t.from_name}`,
      meta: t.note || "", status: t.kind === "bank" || petty ? "done" : t.status, can_cancel: out && (t.kind === "bank" || t.status === "pending") });
  }
  for (const x of expenses) tx.push({ kind: "expense", id: x.id, date: x.txn_date, amount: x.amount, sign: -1,
    desc: `Expense · ${x.where_spent}`, meta: [CL_CATEGORIES.find((c) => c.key === x.category)?.label || "", x.party_name ? `→ ${x.party_name}` : null].filter(Boolean).join(" "),
    status: "done", flagged: x.flagged, category: x.category, where_spent: x.where_spent, party_id: x.party_id, party_name: x.party_name });
  for (const i of incomes) tx.push({ kind: "income", id: i.id, date: i.txn_date, amount: i.amount, sign: i.status === "accepted" ? 1 : 0,
    desc: `${i.kind_label} · ${i.source}`, meta: i.status === "rejected" ? `rejected${i.reject_reason ? `: ${i.reject_reason}` : ""}` : "",
    status: i.status === "accepted" ? "done" : i.status, flagged: i.flagged, can_edit: i.created_by === me, income: i });
  tx.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  res.json({
    month: ym, label: monthLabel(ym, true), balance: mine,
    incoming: [
      ...incoming.rows.map((c) => ({ type: "collection", id: c.id, amount: n0(c.amount), date: c.entry_date, title: `Collection · ${c.customer_name}`,
        meta: [c.location, c.tickets].filter(Boolean).join(" · "), flagged: c.flagged })),
      ...incomingT.map((t) => ({ type: "transfer", id: t.id, amount: t.amount, date: t.txn_date, title: `Transfer from ${t.from_name}`, meta: t.note || "" })),
      ...incomingI.map((i) => ({ type: "income", id: i.id, amount: i.amount, date: i.txn_date, title: `${i.kind_label} · ${i.source}`,
        meta: i.created_by_name ? `entered by ${i.created_by_name}` : "", flagged: i.flagged })),
    ],
    transactions: tx,
  });
});

router.post("/collections/:id/respond", requireCl("cash_holder"), async (req, res) => {
  const decision = req.body?.decision === "accept" ? "accepted" : req.body?.decision === "reject" ? "rejected" : null;
  if (!decision) return bad(res, "Accept or reject?");
  const reason = txt(req.body?.reason, 300);
  if (decision === "rejected" && !reason) return bad(res, "Say why you are rejecting it.");
  const { rowCount } = await query(
    `UPDATE cl_collections SET status = $3, reject_reason = $4, responded_at = now()
      WHERE id = $1 AND holder_id = $2 AND status = 'pending'`, [Number(req.params.id), req.user.id, decision, reason]);
  if (!rowCount) return bad(res, "That collection is not waiting for you any more.");
  await clLog(null, "collection", Number(req.params.id), decision, reason ? { reason } : null, req.user.id);
  res.json({ ok: true });
});

router.post("/transfers", requireCl("cash_holder"), async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === "bank" ? "bank" : "holder";
  const day = cleanDay(b.txn_date);
  if (!day) return bad(res, "Pick the date (not in the future).");
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return bad(res, "Enter the amount.");
  let to = null;
  if (kind === "holder") {
    to = Number(b.to_id);
    if (to === req.user.id || !(await cashHolderIds()).has(to)) return bad(res, "Pick the cash holder to send it to.");
  }
  const { rows } = await query(
    `INSERT INTO cl_transfers (txn_date, kind, from_id, to_id, amount, note, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [day, kind, req.user.id, to, r2(amount), txt(b.note, 300), kind === "bank" ? "accepted" : "pending"]);
  await clLog(null, "transfer", rows[0].id, kind === "bank" ? "deposit" : "sent", { amount: r2(amount), to }, req.user.id);
  res.json({ ok: true, id: rows[0].id });
});

router.post("/transfers/:id/respond", requireCl("cash_holder"), async (req, res) => {
  const decision = req.body?.decision === "accept" ? "accepted" : req.body?.decision === "reject" ? "rejected" : null;
  if (!decision) return bad(res, "Accept or reject?");
  const { rowCount } = await query(
    `UPDATE cl_transfers SET status = $3, responded_at = now()
      WHERE id = $1 AND to_id = $2 AND kind = 'holder' AND status = 'pending' AND deleted_at IS NULL`,
    [Number(req.params.id), req.user.id, decision]);
  if (!rowCount) return bad(res, "That transfer is not waiting for you any more.");
  await clLog(null, "transfer", Number(req.params.id), decision, null, req.user.id);
  res.json({ ok: true });
});

// The sender takes back a transfer not yet accepted, or a bank deposit.
router.delete("/transfers/:id", requireCl("cash_holder"), async (req, res) => {
  const { rowCount } = await query(
    `UPDATE cl_transfers SET deleted_at = now()
      WHERE id = $1 AND from_id = $2 AND deleted_at IS NULL AND (kind = 'bank' OR status = 'pending')`,
    [Number(req.params.id), req.user.id]);
  if (!rowCount) return bad(res, "Only your own deposit, or a transfer not yet accepted, can be taken back.");
  await clLog(null, "transfer", Number(req.params.id), "taken back", null, req.user.id);
  res.json({ ok: true });
});

function cleanExpense(b) {
  const day = cleanDay(b.txn_date);
  if (!day) return { error: "Pick the date (not in the future)." };
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter the amount." };
  const where_spent = txt(b.where_spent, 300);
  if (!where_spent) return { error: "Write where the money was spent." };
  const category = CL_CATEGORY_KEYS.has(b.category) ? b.category : "todo";
  // Round 235 — a payment to a supplier / transporter / contractor names who.
  const partyKind = CL_CATEGORIES.find((c) => c.key === category)?.party || null;
  const party_id = partyKind ? Number(b.party_id) || null : null;
  return { txn_date: day, amount: r2(amount), where_spent, category, flagged: !!b.flagged, party_kind: party_id ? partyKind : null, party_id };
}
const PARTY_WORD = { supplier: "supplier", transporter: "transporter", contractor: "contractor / pump gang" };
// Post the cash payment into the party's ledger (inside the caller's transaction).
async function postCash(client, id, x, user) {
  if (!x.party_id) return null;
  const { rows: who } = await client.query(`SELECT COALESCE(a.short_name, u.name) AS n FROM users u LEFT JOIN cl_access a ON a.user_id = u.id WHERE u.id = $1`, [user]);
  const out = await postPayment(client, {
    kind: x.party_kind, party_id: x.party_id, amount: x.amount, paid_on: x.txn_date, mode: "cash", reference: `C Ledger #${id}`,
    notes: `Cash — ${who[0]?.n || "C Ledger"} · ${x.where_spent}`.slice(0, 200), user_id: user, source: "cledger", source_id: id,
  });
  await client.query(`UPDATE cl_expenses SET post_kind = $2, post_id = $3 WHERE id = $1`, [id, out.kind, out.id]);
  return out;
}

router.post("/expenses", requireCl("cash_holder"), async (req, res) => {
  const x = cleanExpense(req.body || {});
  if (x.error) return bad(res, x.error);
  const pk = CL_CATEGORIES.find((c) => c.key === x.category)?.party;
  if (pk && !x.party_id) return bad(res, `Choose the ${PARTY_WORD[pk]} paid — it goes into their ledger.`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO cl_expenses (holder_id, txn_date, amount, where_spent, category, flagged, party_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.id, x.txn_date, x.amount, x.where_spent, x.category, x.flagged, x.party_id]);
    await postCash(client, rows[0].id, x, req.user.id);
    await clLog(client, "expense", rows[0].id, "added", x, req.user.id);
    await client.query("COMMIT");
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return bad(res, err.message);
    throw err;
  } finally { client.release(); }
});

// Round 229 (owner): the four rights are independent — only the cash holder
// who spent it changes an expense (Entry is deliveries only).
router.put("/expenses/:id", requireCl("cash_holder"), async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`SELECT *, txn_date::text AS txn_day FROM cl_expenses WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!rows.length) return res.status(404).json({ error: "That expense is not there any more." });
  const cur = rows[0];
  if (cur.holder_id !== req.user.id) return res.status(403).json({ error: "Only the person who spent it can change this expense." });
  // A change of one field (category, flag) keeps the rest as it was.
  const x = cleanExpense({ txn_date: cur.txn_day,
    amount: cur.amount, where_spent: cur.where_spent, category: cur.category, flagged: cur.flagged, party_id: cur.party_id, ...(req.body || {}) });
  if (x.error) return bad(res, x.error);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The ledger payment is replaced only when who / how much / when changed.
    const same = cur.post_kind && cur.post_kind === x.party_kind && Number(cur.party_id) === Number(x.party_id)
      && r2(cur.amount) === x.amount && cur.txn_day === x.txn_date;
    if (cur.post_kind && !same) await unpostPayment(client, cur.post_kind, cur.post_id, req.user.id, "C Ledger expense changed");
    await client.query(`UPDATE cl_expenses SET txn_date = $2, amount = $3, where_spent = $4, category = $5, flagged = $6, updated_by = $7, updated_at = now(),
                               party_id = $8 ${same ? "" : ", post_kind = NULL, post_id = NULL"} WHERE id = $1`,
      [id, x.txn_date, x.amount, x.where_spent, x.category, x.flagged, req.user.id, x.party_id]);
    if (!same) await postCash(client, id, x, req.user.id);
    await clLog(client, "expense", id, "edited", { before: cur, after: x }, req.user.id);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return bad(res, err.message);
    throw err;
  } finally { client.release(); }
});

router.delete("/expenses/:id", requireCl("cash_holder"), async (req, res) => {
  const client = await pool.connect();
  let rowCount = 0;
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE cl_expenses SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND holder_id = $2 AND deleted_at IS NULL RETURNING post_kind, post_id`,
      [Number(req.params.id), req.user.id]);
    rowCount = r.rowCount;
    if (r.rows[0]?.post_kind) await unpostPayment(client, r.rows[0].post_kind, r.rows[0].post_id, req.user.id, "C Ledger expense deleted");
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  if (!rowCount) return bad(res, "Only your own expense can be deleted.");
  await clLog(null, "expense", Number(req.params.id), "deleted", null, req.user.id);
  res.json({ ok: true });
});

// Round 235 — who a cash payment can be to.
router.get("/parties", requireCl("cash_holder"), async (_req, res) => {
  const list = (sql) => query(sql).then((r) => r.rows).catch(() => []);
  const [supplier, transporter, contractor] = await Promise.all([
    list(`SELECT id, name FROM rm_suppliers WHERE is_active ORDER BY name`),
    list(`SELECT id, name FROM rm_transporters WHERE is_active ORDER BY name`),
    list(`SELECT id, name FROM hr_contractors WHERE is_active ORDER BY name`),
  ]);
  res.json({ supplier, transporter, contractor });
});

// ------------------------------------------------ other income (227) ---
// Round 229 (owner): only a cash holder records other income, and only what
// they received themselves — it is in their cash at once. Entry has no part in it.
function cleanIncome(b) {
  const day = cleanDay(b.txn_date);
  if (!day) return { error: "Pick the date (not in the future)." };
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter the amount." };
  const source = txt(b.source, 300);
  if (!source) return { error: "Write what was sold, and to whom." };
  return { txn_date: day, amount: r2(amount), source, kind: CL_INCOME_KEYS.has(b.kind) ? b.kind : "other", flagged: !!b.flagged };
}

router.post("/incomes", requireCl("cash_holder"), async (req, res) => {
  const x = cleanIncome(req.body || {});
  if (x.error) return bad(res, x.error);
  const { rows } = await query(
    `INSERT INTO cl_incomes (txn_date, kind, source, amount, received_by, status, responded_at, flagged, created_by)
     VALUES ($1, $2, $3, $4, $5, 'accepted', now(), $6, $5) RETURNING id`,
    [x.txn_date, x.kind, x.source, x.amount, req.user.id, x.flagged]);
  await clLog(null, "income", rows[0].id, "added", x, req.user.id);
  res.json({ ok: true, id: rows[0].id });
});

// Whoever received it may change or delete it, as long as it is theirs.
router.put("/incomes/:id", requireCl("cash_holder"), async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`SELECT *, txn_date::text AS day FROM cl_incomes WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!rows.length) return res.status(404).json({ error: "That income is not there any more." });
  const cur = rows[0];
  if (cur.created_by !== req.user.id || cur.received_by !== req.user.id) return res.status(403).json({ error: "Only the person who received it can change this." });
  const x = cleanIncome({ ...cur, amount: Number(cur.amount), txn_date: cur.day, ...req.body });
  if (x.error) return bad(res, x.error);
  await query(`UPDATE cl_incomes SET txn_date = $2, kind = $3, source = $4, amount = $5, flagged = $6, updated_by = $7, updated_at = now() WHERE id = $1`,
    [id, x.txn_date, x.kind, x.source, x.amount, x.flagged, req.user.id]);
  await clLog(null, "income", id, "edited", { before: cur, after: x }, req.user.id);
  res.json({ ok: true });
});

router.delete("/incomes/:id", requireCl("cash_holder"), async (req, res) => {
  const { rowCount } = await query(
    `UPDATE cl_incomes SET deleted_at = now() WHERE id = $1 AND created_by = $2 AND received_by = $2 AND deleted_at IS NULL`,
    [Number(req.params.id), req.user.id]);
  if (!rowCount) return bad(res, "Only the person who received it can delete it.");
  await clLog(null, "income", Number(req.params.id), "deleted", null, req.user.id);
  res.json({ ok: true });
});

// Income entered for someone else before Round 229 may still be waiting.
router.post("/incomes/:id/respond", requireCl("cash_holder"), async (req, res) => {
  const decision = req.body?.decision === "accept" ? "accepted" : req.body?.decision === "reject" ? "rejected" : null;
  if (!decision) return bad(res, "Accept or reject?");
  const reason = txt(req.body?.reason, 300);
  if (decision === "rejected" && !reason) return bad(res, "Say why you are rejecting it.");
  const { rowCount } = await query(
    `UPDATE cl_incomes SET status = $3, reject_reason = $4, responded_at = now()
      WHERE id = $1 AND received_by = $2 AND status = 'pending' AND deleted_at IS NULL`, [Number(req.params.id), req.user.id, decision, reason]);
  if (!rowCount) return bad(res, "That is not waiting for you any more.");
  await clLog(null, "income", Number(req.params.id), decision, reason ? { reason } : null, req.user.id);
  res.json({ ok: true });
});

// ------------------------------------------------- all transactions ---
// Everyone's cash: balances, transfers, deposits, expenses and other income —
// read only, View transactions alone (Round 229: Entry does not see it).
router.get("/transactions", requireCl("view_txns"), async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const { from, end } = monthBounds(ym);
  const [expenses, transfers, balances, incomes] = await Promise.all([
    expensesFor(`x.txn_date BETWEEN $1::date AND $2::date`, [from, end]),
    transfersFor(`t.txn_date BETWEEN $1::date AND $2::date`, [from, end]),
    holderBalances(),
    incomesFor(`i.txn_date BETWEEN $1::date AND $2::date`, [from, end]),
  ]);
  const byCat = {};
  for (const x of expenses) {
    const c = byCat[x.category] || (byCat[x.category] = { key: x.category, label: CL_CATEGORIES.find((k) => k.key === x.category)?.label || x.category, paid: 0, cost: 0, n: 0 });
    c.paid += x.amount; c.cost += x.cost; c.n += 1;
  }
  res.json({
    month: ym, label: monthLabel(ym, true), full: true,
    expenses, transfers, balances, incomes,
    by_category: Object.values(byCat).map((c) => ({ ...c, paid: r2(c.paid), cost: r2(c.cost) })).sort((a, b) => b.paid - a.paid),
    summary: {
      paid: r2(expenses.reduce((t, x) => t + x.amount, 0)), cost: r2(expenses.reduce((t, x) => t + x.cost, 0)),
      flagged: expenses.filter((x) => x.flagged).length, todo: expenses.filter((x) => x.category === "todo").length,
      cash_in_hand: r2(balances.reduce((t, b) => t + b.balance, 0)),
      deposited: r2(transfers.filter((t) => t.kind === "bank").reduce((s, t) => s + t.amount, 0)),
      income: r2(incomes.filter((i) => i.status !== "rejected").reduce((t, i) => t + i.amount, 0)),
      income_counted: r2(incomes.reduce((t, i) => t + i.counted, 0)),
    },
  });
});

// ------------------------------------------ who has which right (SA) ---
router.get("/access", requireRole("super_admin"), async (req, res) => {
  const [users, log] = await Promise.all([
    query(`SELECT u.id, u.name, u.phone, u.role, u.is_active, a.can_entry, a.can_view_entries, a.is_cash_holder, a.can_view_txns, a.short_name
             FROM users u LEFT JOIN cl_access a ON a.user_id = u.id
            WHERE u.is_active OR a.user_id IS NOT NULL ORDER BY (a.user_id IS NULL), u.name`),
    query(`SELECT l.user_id, u.name AS user_name, l.before, l.after, l.changed_at, b.name AS by_name
             FROM cl_access_log l JOIN users u ON u.id = l.user_id LEFT JOIN users b ON b.id = l.changed_by
            ORDER BY l.changed_at DESC LIMIT 50`),
  ]);
  res.json({
    users: users.rows.map((u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, is_active: u.is_active, short_name: u.short_name || "",
      entry: !!u.can_entry, view_entries: !!u.can_view_entries, cash_holder: !!u.is_cash_holder, view_txns: !!u.can_view_txns })),
    log: log.rows,
  });
});

router.put("/access/:userId", requireRole("super_admin"), async (req, res) => {
  const uid = Number(req.params.userId);
  const { rows: u } = await query(`SELECT id FROM users WHERE id = $1`, [uid]);
  if (!u.length) return res.status(404).json({ error: "No such user." });
  const b = req.body || {};
  const next = { entry: !!b.entry, view_entries: !!b.view_entries || !!b.entry, cash_holder: !!b.cash_holder, view_txns: !!b.view_txns,
    short_name: txt(b.short_name, 12) };
  const { rows: cur } = await query(`SELECT can_entry, can_view_entries, is_cash_holder, can_view_txns, short_name FROM cl_access WHERE user_id = $1`, [uid]);
  if (!next.cash_holder && cur[0]?.is_cash_holder) {
    const { rows: p } = await query(`SELECT (SELECT COUNT(*) FROM cl_collections WHERE holder_id = $1 AND status = 'pending')
                                          + (SELECT COUNT(*) FROM cl_incomes WHERE received_by = $1 AND status = 'pending' AND deleted_at IS NULL) AS n`, [uid]);
    if (Number(p[0].n)) return bad(res, `This person still has ${p[0].n} collection(s) or income waiting to be accepted. Have them accept or reject those first, or have Entry move them to another cash holder.`);
  }
  await query(
    `INSERT INTO cl_access (user_id, can_entry, can_view_entries, is_cash_holder, can_view_txns, short_name, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (user_id) DO UPDATE SET can_entry = EXCLUDED.can_entry, can_view_entries = EXCLUDED.can_view_entries,
       is_cash_holder = EXCLUDED.is_cash_holder, can_view_txns = EXCLUDED.can_view_txns, short_name = EXCLUDED.short_name,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [uid, next.entry, next.view_entries, next.cash_holder, next.view_txns, next.short_name, req.user.id]);
  await query(`INSERT INTO cl_access_log (user_id, before, after, changed_by) VALUES ($1, $2, $3, $4)`,
    [uid, cur[0] ? JSON.stringify(cur[0]) : null, JSON.stringify(next), req.user.id]);
  res.json({ ok: true });
});

export default router;
