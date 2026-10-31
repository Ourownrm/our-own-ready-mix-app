// Round 204 — Accounts module: invoices (with the Accountant's GST switch),
// charges the Manager left out (Administrator review), the customer ledger,
// receipts from bank statements, and the one-time migration of the
// Accountant's rate file into the price list.
//
// Rates are GST-inclusive (owner, 11 Oct 2026). An invoice total is what the
// customer pays; with GST on, the tax is shown inside it (base = total × 100 /
// 118). With GST off the customer still pays the same total — the tax lines are
// simply not shown.
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { generateInvoiceForTicket } from "../lib/deliveryConfirmation.js";
import { recomputeOrderCharges, rateFor } from "../lib/orderCharges.js";
import { openItems, postReceipt, applyAdvances, positions, AGE_GROUPS } from "../lib/receivables.js";
import { can } from "../lib/permissions.js";
import { lookAlikePriceLists, mergeCustomer, mergeSite, referenceCounts } from "../lib/recordMerge.js";
import { ensureRound251 } from "../lib/round251Schema.js";
import { ensureRound252 } from "../lib/round252Schema.js";
import { ledgerSettings } from "../lib/ledgerPost.js";
import { ensureRound255, setInvoicesCash, sendReceiptToCl, removeReceiptCl, receiptClState } from "../lib/round255Schema.js";

const router = Router();
router.use(requireAuth);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const GST_PCT = 18;

export function taxSplit(total, gstApplied) {
  const t = Number(total) || 0;
  if (!gstApplied) return { base: r2(t), cgst: 0, sgst: 0, gst: 0, total: r2(t) };
  const base = r2((t * 100) / (100 + GST_PCT));
  const gst = r2(t - base);
  const cgst = r2(gst / 2);
  return { base, cgst, sgst: r2(gst - cgst), gst, total: r2(t) };
}

// ===========================================================================
// Invoices
// ===========================================================================
const INV_VIEW = requirePermission("accounts.invoice-list", "view");

router.get("/invoices", INV_VIEW, async (req, res) => {
  const params = [];
  const where = ["TRUE"];
  if (req.query.customer_id) { params.push(Number(req.query.customer_id)); where.push(`i.customer_id = $${params.length}`); }
  if (ISO.test(req.query.from || "")) { params.push(req.query.from); where.push(`dt.ticket_date >= $${params.length}`); }
  if (ISO.test(req.query.to || "")) { params.push(req.query.to); where.push(`dt.ticket_date <= $${params.length}`); }
  if (req.query.gst === "off") where.push("NOT i.gst_applied");
  await ensureRound251(query); // Round 251 — tally_invoice_no
  await ensureRound255(); // Round 255 — the "Cash" mark (C Ledger)
  if (req.query.cash === "on") where.push("i.cl_cash");
  if (req.query.cash === "off") where.push("NOT i.cl_cash");
  if (req.query.order_id) { params.push(Number(req.query.order_id)); where.push(`co.id = $${params.length}`); }
  const { rows } = await query(
    `SELECT i.id, i.total_amount, i.concrete_amount, i.pumping_charge, i.part_load_charge, i.waiting_charge,
            i.rate_per_m3, i.gst_applied, i.billing_name, i.billing_gstin, i.created_at, i.tally_invoice_no, i.cl_cash, co.id AS order_id,
            (SELECT COALESCE(SUM(c.amount), 0) FROM cl_deliveries d JOIN cl_collections c ON c.delivery_id = d.id AND c.status <> 'rejected'
              WHERE d.invoice_id = i.id AND d.deleted_at IS NULL) AS cl_collected,
            dt.ticket_number, dt.ticket_date::text AS ticket_date, dt.loaded_quantity_m3, i.rejected_quantity_m3,
            c.id AS customer_id, c.name AS customer_name, s.name AS site_name, m.name AS grade_name,
            q.quote_no, rm.source AS rate_source,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN sites s ON s.id = co.site_id
       LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
       LEFT JOIN rate_master rm ON rm.id = i.rate_id
       LEFT JOIN quotations q ON q.id = rm.quotation_id
      WHERE ${where.join(" AND ")}
      ORDER BY dt.ticket_date DESC, i.id DESC
      LIMIT 1000`,
    params
  );
  const out = rows
    .map((r) => {
      const balance = r2(Number(r.total_amount) - Number(r.paid));
      return { ...r, ...taxSplit(r.total_amount, r.gst_applied), balance, status: balance <= 0.01 ? "paid" : Number(r.paid) > 0 ? "part_paid" : "unpaid" };
    })
    .filter((r) => !req.query.status || req.query.status === "all" || r.status === req.query.status);
  res.json(out);
});

// Round 255 — mark invoices "Cash" (collected through C Ledger) or take the
// mark off. { ids: [...] } or { order_id } (the whole order), and { on }.
router.post("/invoices/cash", requirePermission("accounts.invoice-cash", "edit"), async (req, res) => {
  await ensureRound255();
  const on = !!req.body?.on;
  let ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length && req.body?.order_id) {
    const { rows } = await query(
      `SELECT i.id FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id WHERE dt.order_id = $1 AND i.cl_cash <> $2`,
      [Number(req.body.order_id), on]);
    ids = rows.map((r) => r.id);
  }
  if (!ids.length) return res.status(400).json({ error: on ? "Nothing to mark." : "Nothing to take the mark off." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await setInvoicesCash(client, ids, on, req.user.id);
    await client.query("COMMIT");
    res.json(out);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

// Delivered loads with no invoice — no price on file for the customer + site +
// grade on the order date. Named with any quotation still with the customer.
router.get("/invoices/held", INV_VIEW, async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.ticket_date::text AS ticket_date, dt.loaded_quantity_m3, dt.status,
            co.id AS order_id, co.order_date::text AS order_date, c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name, m.name AS grade_name,
            s.customer_id AS site_customer_id, (SELECT name FROM customers sc WHERE sc.id = s.customer_id) AS site_customer_name,
            -- Round 232 — a price for this customer, project and grade that
            -- starts AFTER the delivery (quotation accepted "rates from" later).
            (SELECT min(rm.effective_from)::text FROM rate_master rm
              WHERE rm.customer_id = co.customer_id AND (rm.site_id = co.site_id OR rm.site_id IS NULL)
                AND rm.mix_grade_id = co.mix_grade_id AND rm.effective_from > co.order_date) AS later_price_from,
            (SELECT json_build_object('id', q.id, 'quote_no', q.quote_no, 'status', q.status)
               FROM quotations q WHERE q.customer_id = co.customer_id AND q.site_id = co.site_id
                AND q.status IN ('pending_approval', 'approved', 'sent') ORDER BY q.id DESC LIMIT 1) AS pending_quotation
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = co.customer_id
       LEFT JOIN sites s ON s.id = co.site_id
       LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
      WHERE dt.status NOT IN ('cancelled', 'rejected')
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ticket_id = dt.id)
      ORDER BY dt.ticket_date, dt.id`
  );
  // Round 230 — a price list sitting on a look-alike customer / project (the
  // same one entered twice) is named on the row, with a merge to fix it.
  const alikes = await lookAlikePriceLists(rows).catch((e) => { console.error("lookAlikePriceLists", e.message); return new Map(); });
  res.json(rows.map((r) => ({ ...r, look_alikes: alikes.get(`${r.customer_id}|${r.site_id}`) || [] })));
});

async function retryHeld() {
  const { rows } = await query(
    `SELECT dt.id FROM delivery_tickets dt
      WHERE dt.status NOT IN ('cancelled', 'rejected') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ticket_id = dt.id)`
  );
  let created = 0;
  for (const r of rows) if (await generateInvoiceForTicket(r.id)) created++;
  return { created, still_held: rows.length - created };
}

// ===========================================================================
// Round 230 — merge a customer / project entered twice
// ===========================================================================
// What each record has hanging off it, before anyone merges.
router.get("/merge/preview", async (req, res) => {
  const ids = (k) => (/^\d+$/.test(String(req.query[k] || "")) ? Number(req.query[k]) : null);
  const fc = ids("from_customer_id"), tc = ids("to_customer_id"), fs = ids("from_site_id"), ts = ids("to_site_id");
  if (!(await can(req.user, "masters.site-merge", "delete")) && !(await can(req.user, "masters.customer-merge", "delete"))) {
    return res.status(403).json({ error: "You don't have access to this." });
  }
  const one = async (table, id) => {
    if (!id) return null;
    const { rows } = await query(
      table === "customers" ? `SELECT id, name, is_active FROM customers WHERE id = $1`
        : `SELECT s.id, s.name, s.is_active, s.customer_id, c.name AS customer_name FROM sites s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1`, [id]);
    if (!rows[0]) return null;
    return { ...rows[0], refs: await referenceCounts({ query }, table, id) };
  };
  res.json({
    from_customer: await one("customers", fc), to_customer: await one("customers", tc),
    from_site: await one("sites", fs), to_site: await one("sites", ts),
    can_merge_customers: await can(req.user, "masters.customer-merge", "delete"),
    can_merge_sites: await can(req.user, "masters.site-merge", "delete"),
  });
});

// { from_customer_id, to_customer_id, from_site_id, to_site_id, keep_names: 'to' | 'from', note }
// The duplicate (from) is merged into the record that stays (to). Customers
// first (the duplicate's projects come along), then the project. Held
// deliveries are invoiced straight after.
router.post("/merge", async (req, res) => {
  const b = req.body || {};
  const id = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const fc = id(b.from_customer_id), tc = id(b.to_customer_id), fs = id(b.from_site_id), ts = id(b.to_site_id);
  const doCustomers = fc && tc && fc !== tc;
  const doSites = fs && ts && fs !== ts;
  if (!doCustomers && !doSites) return res.status(400).json({ error: "Choose what to merge." });
  if (doCustomers && !(await can(req.user, "masters.customer-merge", "delete"))) return res.status(403).json({ error: "Merging customers needs the \"Merge duplicate customers\" right." });
  if (doSites && !(await can(req.user, "masters.site-merge", "delete"))) return res.status(403).json({ error: "Merging projects needs the \"Merge duplicate sites\" right." });
  const note = String(b.note || "").trim().slice(0, 300) || null;
  const keepFromNames = b.keep_names === "from";
  const client = await pool.connect();
  let done = {};
  try {
    await client.query("BEGIN");
    if (doCustomers) {
      if (doSites) {
        const { rows } = await client.query(`SELECT id, customer_id FROM sites WHERE id = ANY($1::int[])`, [[fs, ts]]);
        const f = rows.find((r) => r.id === fs), t = rows.find((r) => r.id === ts);
        if (!f || !t || f.customer_id !== fc || t.customer_id !== tc) throw Object.assign(new Error("Each project must belong to its customer."), { status: 400 });
      }
      done.customer = await mergeCustomer(client, fc, tc, req.user.id, note);
      if (keepFromNames) await client.query(`UPDATE customers SET name = $2 WHERE id = $1`, [tc, done.customer.from.name]);
    }
    if (doSites) {
      done.site = await mergeSite(client, fs, ts, req.user.id, note);
      if (keepFromNames) await client.query(`UPDATE sites SET name = $2 WHERE id = $1`, [ts, done.site.from.name]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("merge", err);
    return res.status(500).json({ error: "Could not merge — nothing was changed." });
  } finally {
    client.release();
  }
  const held = await retryHeld();
  res.json({
    ok: true, ...held,
    customer: done.customer ? { from: done.customer.from.name, to: done.customer.to.name } : null,
    site: done.site ? { from: done.site.from.name, to: done.site.to.name } : null,
  });
});

// Round 231 — an order placed under one customer on a project that belongs to
// another: move the order (and its unpaid invoices) to the project's owner.
// For when they are really different customers; when they are the same
// customer entered twice, the customer merge above is the fix.
router.post("/held/move-order", async (req, res) => {
  if (!(await can(req.user, "masters.site-merge", "delete")) && !(await can(req.user, "masters.customer-merge", "delete"))) {
    return res.status(403).json({ error: "You don't have access to this." });
  }
  const orderId = Number(req.body?.order_id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: "Which order?" });
  const client = await pool.connect();
  let moved;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT co.id, co.customer_id, s.customer_id AS site_customer_id, c.name AS from_name, sc.name AS to_name
         FROM customer_orders co JOIN sites s ON s.id = co.site_id
         JOIN customers c ON c.id = co.customer_id JOIN customers sc ON sc.id = s.customer_id
        WHERE co.id = $1 FOR UPDATE OF co`, [orderId]);
    const o = rows[0];
    if (!o) throw Object.assign(new Error("Order not found."), { status: 404 });
    if (o.customer_id === o.site_customer_id) throw Object.assign(new Error("This order is already under the project's customer."), { status: 409 });
    const { rows: paid } = await client.query(
      `SELECT count(*)::int AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN delivery_tickets dt ON dt.id = i.ticket_id WHERE dt.order_id = $1`, [orderId]);
    if (paid[0].n) throw Object.assign(new Error("A payment is recorded against this order's invoices — it can't be moved here."), { status: 409 });
    await client.query(
      `UPDATE customer_orders SET customer_id = $2,
              billing_address_id = CASE WHEN billing_address_id IN (SELECT id FROM customer_billing_addresses WHERE customer_id = $2) THEN billing_address_id END
        WHERE id = $1`, [orderId, o.site_customer_id]);
    const inv = await client.query(
      `UPDATE invoices i SET customer_id = $2 FROM delivery_tickets dt WHERE dt.id = i.ticket_id AND dt.order_id = $1`, [orderId, o.site_customer_id]);
    await client.query(
      `INSERT INTO record_merges (kind, from_id, to_id, from_name, to_name, moved, note, merged_by)
       VALUES ('customer', $1, $2, $3, $4, $5, $6, $7)`,
      [o.customer_id, o.site_customer_id, o.from_name, o.to_name, JSON.stringify([{ table: "customer_orders", column: "customer_id", rows: 1 }, { table: "invoices", column: "customer_id", rows: inv.rowCount }]),
       `Order #${orderId} moved to the project's customer`, req.user.id]);
    await client.query("COMMIT");
    moved = o;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("move-order", err);
    return res.status(500).json({ error: "Could not move the order — nothing was changed." });
  } finally {
    client.release();
  }
  const held = await retryHeld();
  res.json({ ok: true, from: moved.from_name, to: moved.to_name, ...held });
});

router.get("/merge/history", async (req, res) => {
  if (!(await can(req.user, "masters.site-merge", "delete")) && !(await can(req.user, "masters.customer-merge", "delete"))) {
    return res.status(403).json({ error: "You don't have access to this." });
  }
  const { rows } = await query(
    `SELECT m.id, m.kind, m.from_name, m.to_name, m.moved, m.note, m.merged_at, u.name AS merged_by_name
       FROM record_merges m LEFT JOIN users u ON u.id = m.merged_by ORDER BY m.id DESC LIMIT 100`);
  res.json(rows);
});

router.post("/invoices/held/retry", requirePermission("accounts.invoice-gst", "edit"), async (req, res) => {
  res.json(await retryHeld());
});

// The Accountant's switch. Same total either way.
router.post("/invoices/:id(\\d+)/gst", requirePermission("accounts.invoice-gst", "edit"), async (req, res) => {
  const on = !!req.body.gst_applied;
  const { rows } = await query(
    `UPDATE invoices SET gst_applied = $2, gst_changed_by = $3, gst_changed_at = now() WHERE id = $1
     RETURNING id, total_amount, gst_applied`,
    [req.params.id, on, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Invoice not found." });
  res.json({ ...rows[0], ...taxSplit(rows[0].total_amount, on) });
});

router.post("/invoices/gst-bulk", requirePermission("accounts.invoice-gst", "edit"), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: "Choose the invoices." });
  const { rowCount } = await query(
    `UPDATE invoices SET gst_applied = $2, gst_changed_by = $3, gst_changed_at = now() WHERE id = ANY($1::int[])`,
    [ids, !!req.body.gst_applied, req.user.id]
  );
  res.json({ updated: rowCount });
});

// ===========================================================================
// Charges the Manager left out — the Administrator accepts, or charges after all.
// ===========================================================================
router.get("/waivers", INV_VIEW, async (req, res) => {
  const status = ["pending", "accepted", "charged"].includes(req.query.status) ? req.query.status : "pending";
  const { rows } = await query(
    `SELECT co.id AS order_id, co.order_date::text AS order_date, co.order_quantity_m3, co.pump_requirement,
            co.pump_charge_waiver_reason, co.part_load_waiver_reason, co.charge_review_status, co.charge_review_note,
            co.charge_reviewed_at, ru.name AS reviewed_by_name,
            c.name AS customer_name, s.name AS site_name, m.name AS grade_name, u.name AS created_by_name,
            (SELECT json_agg(json_build_object('ticket_number', dt.ticket_number, 'm3', dt.loaded_quantity_m3) ORDER BY dt.id)
               FROM delivery_tickets dt WHERE dt.order_id = co.id AND dt.status NOT IN ('cancelled', 'rejected')) AS loads,
            (SELECT COUNT(*) FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN delivery_tickets dt ON dt.id = i.ticket_id
              WHERE dt.order_id = co.id)::int AS payment_count,
            co.customer_id, co.site_id, co.mix_grade_id, co.price_option
       FROM customer_orders co
       JOIN customers c ON c.id = co.customer_id
       LEFT JOIN sites s ON s.id = co.site_id
       LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
       LEFT JOIN users u ON u.id = co.created_by
       LEFT JOIN users ru ON ru.id = co.charge_reviewed_by
      WHERE co.charge_review_status = $1
      ORDER BY co.id DESC LIMIT 300`,
    [status]
  );
  // What charging would add, from the price list.
  for (const r of rows) {
    const rate = await rateFor(r.customer_id, r.site_id, r.mix_grade_id, r.order_date, r.price_option);
    let pump = 0, part = 0;
    if (r.pump_charge_waiver_reason && rate) {
      pump = Number(r.pump_requirement === "boom_pump" ? rate.boom_pump_charge : (rate.line_pump_charge ?? rate.pumping_charge_lumpsum)) || 0;
    }
    if (r.part_load_waiver_reason && rate) {
      const min = Number(rate.part_load_min_qty_m3 ?? 5);
      const per = Number(rate.part_load_charge_per_m3) || 0;
      for (const l of r.loads || []) part += Math.max(0, min - Number(l.m3)) * per;
    }
    r.would_add = { pump: r2(pump), part_load: r2(part) };
  }
  res.json(rows);
});

router.post("/waivers/:orderId(\\d+)", requirePermission("orders.charge-waiver-review", "edit"), async (req, res) => {
  const action = req.body.action;
  if (!["accept", "charge"].includes(action)) return res.status(400).json({ error: "Accept the decision or charge it." });
  const { rows } = await query(
    `SELECT co.*, co.order_date::text AS od FROM customer_orders co WHERE co.id = $1`,
    [req.params.orderId]
  );
  const o = rows[0];
  if (!o) return res.status(404).json({ error: "Order not found." });
  if (o.charge_review_status !== "pending") return res.status(409).json({ error: "This order was already reviewed." });
  const note = String(req.body.note || "").trim() || null;
  if (action === "accept") {
    await query(
      `UPDATE customer_orders SET charge_review_status = 'accepted', charge_reviewed_by = $2, charge_reviewed_at = now(), charge_review_note = $3
        WHERE id = $1`,
      [o.id, req.user.id, note]
    );
    return res.json({ ok: true });
  }
  const { rows: paid } = await query(
    `SELECT 1 FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN delivery_tickets dt ON dt.id = i.ticket_id
      WHERE dt.order_id = $1 LIMIT 1`,
    [o.id]
  );
  if (paid.length) {
    return res.status(409).json({ error: "A payment is already recorded on this order's invoices — raise the charge on a separate invoice instead." });
  }
  const rate = await rateFor(o.customer_id, o.site_id, o.mix_grade_id, o.od, o.price_option);
  const charge = req.body.charge || {};
  const sets = [];
  const vals = [o.id];
  if (o.pump_charge_waiver_reason && charge.pump !== false) {
    const amt = Number(charge.pump_amount) > 0 ? Number(charge.pump_amount)
      : Number(o.pump_requirement === "boom_pump" ? rate?.boom_pump_charge : (rate?.line_pump_charge ?? rate?.pumping_charge_lumpsum)) || 0;
    vals.push(amt);
    sets.push(`pump_charge_applicable = true, pump_charge_amount = $${vals.length}`);
  }
  if (o.part_load_waiver_reason && charge.part_load !== false) {
    sets.push(`part_load_applicable = true, part_load_basis = 'per_load'`);
  }
  vals.push(req.user.id, note);
  await query(
    `UPDATE customer_orders SET ${sets.length ? sets.join(", ") + "," : ""} charge_review_status = 'charged',
            charge_reviewed_by = $${vals.length - 1}, charge_reviewed_at = now(), charge_review_note = $${vals.length}
      WHERE id = $1`,
    vals
  );
  const changed = await recomputeOrderCharges(o.id);
  res.json({ ok: true, invoices_updated: changed });
});

// ===========================================================================
// Customer ledger
// ===========================================================================
const LEDGER_VIEW = requirePermission("accounts.customer-ledger", "view");

// Every customer's position: billed (invoices + opening balance) less received
// (receipts, plus payments entered before receipts existed).
const BALANCES_SQL = `
  WITH inv AS (SELECT customer_id, SUM(total_amount) AS amt, MAX(created_at) AS last_at FROM invoices GROUP BY customer_id),
       ob AS (SELECT customer_id, SUM(amount) AS amt FROM customer_opening_balances GROUP BY customer_id),
       rc AS (SELECT customer_id, SUM(amount) AS amt, MAX(receipt_date) AS last_on FROM customer_receipts WHERE cancelled_at IS NULL GROUP BY customer_id),
       lp AS (SELECT COALESCE(i.customer_id, b.customer_id) AS customer_id, SUM(p.amount) AS amt, MAX(p.payment_date) AS last_on
                FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
                LEFT JOIN customer_opening_balances b ON b.id = p.opening_balance_id
               WHERE p.receipt_id IS NULL GROUP BY 1),
       al AS (SELECT r.customer_id, SUM(p.amount) AS amt FROM payments p JOIN customer_receipts r ON r.id = p.receipt_id
               WHERE r.cancelled_at IS NULL GROUP BY 1)
  SELECT c.id, c.name,
         COALESCE(inv.amt, 0) + COALESCE(ob.amt, 0) AS billed,
         COALESCE(rc.amt, 0) + COALESCE(lp.amt, 0) AS received,
         COALESCE(inv.amt, 0) + COALESCE(ob.amt, 0) - COALESCE(rc.amt, 0) - COALESCE(lp.amt, 0) AS balance,
         COALESCE(rc.amt, 0) - COALESCE(al.amt, 0) AS unallocated,
         GREATEST(rc.last_on, lp.last_on)::text AS last_receipt_on
    FROM customers c
    LEFT JOIN inv ON inv.customer_id = c.id LEFT JOIN ob ON ob.customer_id = c.id
    LEFT JOIN rc ON rc.customer_id = c.id LEFT JOIN lp ON lp.customer_id = c.id LEFT JOIN al ON al.customer_id = c.id
   WHERE (inv.amt IS NOT NULL OR ob.amt IS NOT NULL OR rc.amt IS NOT NULL)`;

router.get("/ledger", LEDGER_VIEW, async (req, res) => {
  // One calculation for every screen (lib/receivables.js).
  const rows = (await positions()).sort((x, y) => y.balance - x.balance || x.name.localeCompare(y.name));
  res.json(rows.map((r) => ({ ...r, unallocated: r.advance, overdue_30: r.d30p })));
});

router.get("/ledger/:customerId(\\d+)", LEDGER_VIEW, async (req, res) => {
  const cid = Number(req.params.customerId);
  await ensureRound252(query);
  const from = ISO.test(req.query.from || "") ? req.query.from : null;
  const to = ISO.test(req.query.to || "") ? req.query.to : null;
  const { rows: cust } = await query(`SELECT id, name, contact_number FROM customers WHERE id = $1`, [cid]);
  if (!cust.length) return res.status(404).json({ error: "Customer not found." });
  const { rows: entries } = await query(
    `SELECT * FROM (
       SELECT ob.as_of_date AS on_date, 'opening' AS kind, ob.id, 'Opening balance' AS particulars, ob.notes AS detail,
              ob.amount AS debit, 0::numeric AS credit, 0 AS ord
         FROM customer_opening_balances ob WHERE ob.customer_id = $1
       UNION ALL
       SELECT dt.ticket_date, 'invoice', i.id, dt.ticket_number,
              CONCAT(m.name, ' · ', s.name, ' · ', dt.loaded_quantity_m3, ' m³', CASE WHEN i.gst_applied THEN '' ELSE ' · without GST' END),
              i.total_amount, 0, 1
         FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customer_orders co ON co.id = dt.order_id
         LEFT JOIN mix_grades m ON m.id = co.mix_grade_id LEFT JOIN sites s ON s.id = co.site_id
        WHERE i.customer_id = $1
       UNION ALL
       SELECT r.receipt_date, 'receipt', r.id, CONCAT('Receipt · ', r.mode::text),
              -- Round 206 — what the money was set against, so a payment of the
              -- opening balance is visible on the ledger.
              CONCAT_WS(' · ', r.reference_number, r.bank_account, r.narration, r.remarks,
                -- Round 212 — each due named once (a corrected receipt can pay one in parts).
                (SELECT 'against ' || string_agg(lbl, ', ' ORDER BY first_id) FROM (
                   SELECT COALESCE(dt.ticket_number, 'Opening balance') AS lbl, MIN(p.id) AS first_id
                     FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN delivery_tickets dt ON dt.id = i.ticket_id
                    WHERE p.receipt_id = r.id GROUP BY 1) q),
                CASE WHEN r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) > 0.01
                     THEN 'advance ₹' || to_char(r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0), 'FM99,99,99,990') END,
                CASE WHEN r.edited_at IS NOT NULL THEN 'corrected' END),
              0, r.amount, 2
         FROM customer_receipts r WHERE r.customer_id = $1 AND r.cancelled_at IS NULL
       UNION ALL
       -- Round 252 — an approved credit note, a credit on the customer's statement.
       SELECT cn.cn_date, 'credit_note', cn.id, CONCAT('Credit note · ', cn.cn_no),
              CONCAT_WS(' · ', CASE cn.reason WHEN 'return' THEN 'concrete returned / rejected' WHEN 'rate' THEN 'rate correction'
                                              WHEN 'discount' THEN 'discount' ELSE 'other' END,
                        'against ' || (SELECT dt.ticket_number FROM invoices i2 JOIN delivery_tickets dt ON dt.id = i2.ticket_id WHERE i2.id = cn.invoice_id),
                        CASE WHEN cn.qty_m3 IS NOT NULL THEN cn.qty_m3 || ' m³' END, cn.note),
              0, cn.total_amount, 2
         FROM credit_notes cn WHERE cn.customer_id = $1 AND cn.status = 'approved'
       UNION ALL
       SELECT p.payment_date, 'payment', p.id, CONCAT('Payment · ', p.mode::text),
              CONCAT_WS(' · ', 'against ' || CASE WHEN p.opening_balance_id IS NOT NULL THEN 'Opening balance'
                                                  ELSE (SELECT dt.ticket_number FROM delivery_tickets dt WHERE dt.id = i.ticket_id) END,
                        p.reference_number, p.remarks),
              0, p.amount, 2
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customer_opening_balances b ON b.id = p.opening_balance_id
        WHERE p.receipt_id IS NULL AND COALESCE(i.customer_id, b.customer_id) = $1
     ) x ORDER BY on_date, ord, id`,
    [cid]
  );
  let running = 0, opening = 0;
  const lines = [];
  for (const e of entries) {
    const d = typeof e.on_date === "string" ? e.on_date : e.on_date.toLocaleDateString("en-CA"); // ist-ok: DATE column, pg returns local midnight
    running = r2(running + Number(e.debit) - Number(e.credit));
    if (from && d < from) { opening = running; continue; }
    if (to && d > to) continue;
    lines.push({ ...e, on_date: d, balance: running });
  }
  // Round 255 — which receipts are in C Ledger (and with whom).
  await ensureRound255();
  const rIds = lines.filter((l) => l.kind === "receipt").map((l) => l.id);
  if (rIds.length) {
    const { rows: cl } = await query(
      `SELECT c.receipt_id, bool_and(c.holder_id IS NULL) AS bank, string_agg(DISTINCT COALESCE(a.short_name, u.name), ', ') AS holders,
              bool_or(c.status = 'pending') AS pending, bool_or(c.status = 'rejected') AS rejected
         FROM cl_collections c LEFT JOIN users u ON u.id = c.holder_id LEFT JOIN cl_access a ON a.user_id = c.holder_id
        WHERE c.receipt_id = ANY($1::int[]) GROUP BY c.receipt_id`, [rIds]).catch(() => ({ rows: [] }));
    const m = new Map(cl.map((x) => [x.receipt_id, x]));
    for (const l of lines) if (l.kind === "receipt") {
      const x = m.get(l.id);
      l.c_ledger = x ? { bank: x.bank, holders: x.holders, pending: x.pending, rejected: x.rejected } : null;
      l.mode = String(l.particulars || "").replace(/^Receipt · /, "");
    }
  }
  const items = await openItems(pool, cid);
  const pos = (await positions({ customerId: cid }))[0];
  const aging = Object.fromEntries(AGE_GROUPS.map((g) => [g.label, pos ? pos[g.key] : 0]));
  res.json({
    customer: cust[0], opening_balance: from ? opening : null, lines, aging,
    position: pos ? { ...pos, unallocated: pos.advance } : { billed: 0, received: 0, balance: 0, unallocated: 0 },
    credit: pos?.credit || null,
    open_items: items,
  });
});

// Apply a customer's advance to invoices raised since.
router.post("/ledger/:customerId(\\d+)/apply-advance", requirePermission("accounts.bank-receipts", "create"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const applied = await applyAdvances(client, req.params.customerId);
    await client.query("COMMIT");
    res.json({ applied });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// ===========================================================================
// Receipts
// ===========================================================================
const RC_VIEW = requirePermission("accounts.bank-receipts", "view");
const RC_CREATE = requirePermission("accounts.bank-receipts", "create");
const MODES = ["cash", "cheque", "bank_transfer", "upi"];

router.get("/receipts", RC_VIEW, async (req, res) => {
  const params = [];
  const where = ["TRUE"];
  if (req.query.customer_id) { params.push(Number(req.query.customer_id)); where.push(`r.customer_id = $${params.length}`); }
  if (ISO.test(req.query.from || "")) { params.push(req.query.from); where.push(`r.receipt_date >= $${params.length}`); }
  const { rows } = await query(
    `SELECT r.*, r.receipt_date::text AS receipt_date, c.name AS customer_name, u.name AS entered_by_name,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) AS allocated
       FROM customer_receipts r JOIN customers c ON c.id = r.customer_id LEFT JOIN users u ON u.id = r.entered_by
      WHERE ${where.join(" AND ")} ORDER BY r.receipt_date DESC, r.id DESC LIMIT 500`,
    params
  );
  res.json(rows);
});

router.post("/receipts", RC_CREATE, async (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: "Choose the customer." });
  if (!(Number(b.amount) > 0)) return res.status(400).json({ error: "Enter the amount received." });
  if (!MODES.includes(b.mode)) return res.status(400).json({ error: "Choose how it was paid." });
  if (!ISO.test(b.receipt_date || "")) return res.status(400).json({ error: "Enter the date received." });
  // Round 255 (owner, 31 Oct 2026): Record a receipt takes every mode again —
  // Round 252's "cash only by hand" is gone. A bank transfer recorded here is
  // matched when the bank statement comes ("already in the app"), not posted twice.
  // "Send to C Ledger" (c_ledger: { holder_id } for cash, or { bank: true }).
  const target = b.c_ledger && (b.c_ledger.bank || b.c_ledger.holder_id) ? b.c_ledger : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await postReceipt(client, { ...b, userId: req.user.id });
    if (target) out.c_ledger = await sendReceiptToCl(client, out.id, target, req.user.id);
    await client.query("COMMIT");
    res.status(201).json(out);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

// Round 255 — the cash holders a receipt can be sent to (names only).
router.get("/cl-holders", RC_VIEW, async (_req, res) => {
  await ensureRound255();
  const { rows } = await query(
    `SELECT a.user_id AS id, COALESCE(a.short_name, u.name) AS short, u.name FROM cl_access a JOIN users u ON u.id = a.user_id
      WHERE a.is_cash_holder AND u.is_active ORDER BY COALESCE(a.short_name, u.name)`).catch(() => ({ rows: [] }));
  res.json(rows);
});

// Round 255 — send a receipt already recorded (by hand or from the bank
// statement) to C Ledger, or take it out again.
router.post("/receipts/:id(\\d+)/c-ledger", RC_CREATE, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await sendReceiptToCl(client, Number(req.params.id), req.body || {}, req.user.id);
    await client.query("COMMIT");
    res.json(out);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});
router.delete("/receipts/:id(\\d+)/c-ledger", RC_CREATE, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const n = await removeReceiptCl(client, Number(req.params.id), { userId: req.user.id });
    await client.query("COMMIT");
    res.json({ ok: true, removed: n });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

router.post("/receipts/:id(\\d+)/cancel", requirePermission("accounts.receipt-cancel", "edit"), async (req, res) => {
  const reason = String(req.body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Give the reason for cancelling." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ok = await cancelReceipt(client, Number(req.params.id), req.user.id, reason);
    if (!ok) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Receipt not found or already cancelled." });
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

// Cancels a receipt: its allocations go, a bank line goes back to "To post",
// and any other advance of the customer is set against what this freed.
// The change is logged. Returns false if there is no such live receipt.
async function cancelReceipt(client, id, userId, reason) {
  // Round 255 — its C Ledger lines go too (refused while a cash holder has
  // accepted its cash: that cash is in their wallet).
  await ensureRound255();
  await removeReceiptCl(client, id, { userId });
  const { rows } = await client.query(
    `UPDATE customer_receipts SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
      WHERE id = $1 AND cancelled_at IS NULL
      RETURNING id, customer_id, receipt_date::text AS receipt_date, amount, mode::text AS mode, reference_number, remarks, bank_line_id`,
    [id, userId, reason]
  );
  if (!rows.length) return false;
  const r = rows[0];
  await client.query(`DELETE FROM payments WHERE receipt_id = $1`, [id]);
  if (r.bank_line_id) {
    await client.query(
      `UPDATE bank_statement_lines SET status = 'open', receipt_id = NULL, settled_by = NULL, settled_at = NULL WHERE id = $1`,
      [r.bank_line_id]
    );
  }
  await logCorrection(client, { kind: "receipt", id, customerId: r.customer_id, action: "delete", before: receiptView(r), after: null, reason, userId });
  await applyAdvances(client, r.customer_id);
  return true;
}

// ===========================================================================
// Round 212 — correcting a wrong payment entry from the customer ledger
// (owner, 16 Oct 2026). Receipts are edited in place and re-set against the
// dues; a delete cancels the receipt (kept, hidden). Old-style payments
// (entered before receipts existed) are edited or removed. Every change is
// logged with the values before / after and the reason.
// ===========================================================================
const CORRECT_EDIT = requirePermission("accounts.receipt-correct", "edit");
const CORRECT_DELETE = requirePermission("accounts.receipt-correct", "delete");

const receiptView = (r) => ({
  customer_id: r.customer_id, date: r.receipt_date, amount: r2(r.amount), mode: r.mode,
  reference_number: r.reference_number || null, remarks: r.remarks || null,
});
const paymentView = (p) => ({
  date: p.payment_date, amount: r2(p.amount), mode: p.mode,
  reference_number: p.reference_number || null, remarks: p.remarks || null,
});

async function logCorrection(client, { kind, id, customerId, action, before, after, reason, userId }) {
  await client.query(
    `INSERT INTO customer_ledger_corrections (entry_kind, entry_id, customer_id, action, before_value, after_value, reason, done_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [kind, id, customerId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason, userId]
  );
}

const clean = (v, max) => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };

// One entry as stored, for the edit form.
router.get("/ledger/entries/receipt/:id(\\d+)", CORRECT_EDIT, async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.customer_id, c.name AS customer_name, r.receipt_date::text AS date, r.amount, r.mode::text AS mode,
            r.reference_number, r.remarks, r.narration, r.bank_account, r.bank_line_id,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) AS allocated
       FROM customer_receipts r JOIN customers c ON c.id = r.customer_id
      WHERE r.id = $1 AND r.cancelled_at IS NULL`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Receipt not found or already deleted." });
  res.json({ kind: "receipt", ...rows[0], from_bank: !!rows[0].bank_line_id });
});

router.get("/ledger/entries/payment/:id(\\d+)", CORRECT_EDIT, async (req, res) => {
  const { rows } = await query(
    `SELECT p.id, COALESCE(i.customer_id, b.customer_id) AS customer_id, p.payment_date::text AS date, p.amount, p.mode::text AS mode,
            p.reference_number, p.remarks, p.invoice_id, p.opening_balance_id,
            CASE WHEN p.opening_balance_id IS NOT NULL THEN 'Opening balance' ELSE dt.ticket_number END AS against
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN delivery_tickets dt ON dt.id = i.ticket_id
       LEFT JOIN customer_opening_balances b ON b.id = p.opening_balance_id
      WHERE p.id = $1 AND p.receipt_id IS NULL`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Payment not found." });
  res.json({ kind: "payment", ...rows[0] });
});

// Edit a receipt. A receipt from a bank statement keeps its date and amount
// (they are the bank's) — delete it and post the bank line again for those.
router.post("/ledger/entries/receipt/:id(\\d+)/edit", CORRECT_EDIT, async (req, res) => {
  const b = req.body || {};
  const reason = clean(b.reason, 300);
  if (!reason) return res.status(400).json({ error: "Give the reason for the correction." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, customer_id, receipt_date::text AS receipt_date, amount, mode::text AS mode, reference_number, remarks, bank_line_id
         FROM customer_receipts WHERE id = $1 AND cancelled_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    const old = rows[0];
    if (!old) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Receipt not found or already deleted." }); }
    const next = {
      customer_id: b.customer_id ? Number(b.customer_id) : old.customer_id,
      receipt_date: b.date ?? old.receipt_date,
      amount: b.amount != null && b.amount !== "" ? r2(b.amount) : r2(old.amount),
      mode: b.mode ?? old.mode,
      reference_number: b.reference_number !== undefined ? clean(b.reference_number, 100) : old.reference_number,
      remarks: b.remarks !== undefined ? clean(b.remarks, 500) : old.remarks,
    };
    const bad = (msg, code = 400) => client.query("ROLLBACK").then(() => res.status(code).json({ error: msg }));
    if (!ISO.test(next.receipt_date || "")) return bad("Enter the date received.");
    if (!(next.amount > 0)) return bad("Enter the amount received.");
    if (!MODES.includes(next.mode)) return bad("Choose how it was paid.");
    if (old.bank_line_id && (next.receipt_date !== old.receipt_date || Math.abs(next.amount - Number(old.amount)) > 0.005)) {
      return bad("This receipt came from a bank statement — its date and amount are the bank's. To change them, delete the receipt and post the bank line again.");
    }
    if (next.customer_id !== old.customer_id) {
      const { rows: c } = await client.query(`SELECT 1 FROM customers WHERE id = $1`, [next.customer_id]);
      if (!c.length) return bad("Customer not found.");
    }
    const before = receiptView(old);
    const after = receiptView({ ...next });
    if (JSON.stringify(before) === JSON.stringify(after)) return bad("Nothing was changed.");

    // Round 255 — a receipt sent to C Ledger: its lines are made again from
    // the corrected receipt (refused while a cash holder has accepted its cash).
    await ensureRound255();
    const clBefore = await receiptClState(client, old.id);
    const moneyChanged = next.customer_id !== old.customer_id || next.receipt_date !== old.receipt_date
      || Math.abs(next.amount - Number(old.amount)) > 0.005 || next.mode !== old.mode;
    if (clBefore && moneyChanged) await removeReceiptCl(client, old.id, { userId: req.user.id });
    // Take the receipt off the dues it paid, change it, and set it (and any
    // other advance of the customer) against the dues again, oldest first.
    await client.query(`DELETE FROM payments WHERE receipt_id = $1`, [old.id]);
    await client.query(
      `UPDATE customer_receipts SET customer_id = $2, receipt_date = $3, amount = $4, mode = $5, reference_number = $6, remarks = $7,
              edited_at = now(), edited_by = $8
        WHERE id = $1`,
      [old.id, next.customer_id, next.receipt_date, next.amount, next.mode, next.reference_number, next.remarks, req.user.id]
    );
    await logCorrection(client, { kind: "receipt", id: old.id, customerId: next.customer_id, action: "edit", before, after, reason, userId: req.user.id });
    if (next.customer_id !== old.customer_id) {
      // Also logged under the customer it was taken from.
      await logCorrection(client, { kind: "receipt", id: old.id, customerId: old.customer_id, action: "edit", before, after, reason, userId: req.user.id });
      await applyAdvances(client, old.customer_id);
    }
    await applyAdvances(client, next.customer_id);
    if (clBefore && moneyChanged) {
      await sendReceiptToCl(client, old.id, next.mode === "cash" && clBefore.holder_id ? { holder_id: clBefore.holder_id } : { bank: true }, req.user.id);
    }
    const { rows: left } = await client.query(
      `SELECT r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) AS free,
              (SELECT string_agg(lbl, ', ' ORDER BY first_id) FROM (
                 SELECT COALESCE(dt.ticket_number, 'Opening balance') AS lbl, MIN(p.id) AS first_id
                   FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN delivery_tickets dt ON dt.id = i.ticket_id
                  WHERE p.receipt_id = r.id GROUP BY 1) q) AS against
         FROM customer_receipts r WHERE r.id = $1`,
      [old.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, moved: next.customer_id !== old.customer_id, against: left[0].against, advance: r2(Math.max(0, Number(left[0].free))) });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

router.post("/ledger/entries/receipt/:id(\\d+)/delete", CORRECT_DELETE, async (req, res) => {
  const reason = clean(req.body?.reason, 300);
  if (!reason) return res.status(400).json({ error: "Give the reason for deleting." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ok = await cancelReceipt(client, Number(req.params.id), req.user.id, reason);
    if (!ok) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Receipt not found or already deleted." }); }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

// Old-style payment (set straight against one invoice / opening balance).
// It cannot be raised above what that item still owes.
router.post("/ledger/entries/payment/:id(\\d+)/edit", CORRECT_EDIT, async (req, res) => {
  const b = req.body || {};
  const reason = clean(b.reason, 300);
  if (!reason) return res.status(400).json({ error: "Give the reason for the correction." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT p.*, p.payment_date::text AS payment_date, p.mode::text AS mode, COALESCE(i.customer_id, ob.customer_id) AS customer_id,
              COALESCE(i.total_amount, ob.amount)
                - COALESCE((SELECT SUM(x.amount) FROM payments x WHERE x.id <> p.id
                              AND (x.invoice_id = p.invoice_id OR x.opening_balance_id = p.opening_balance_id)), 0) AS room
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customer_opening_balances ob ON ob.id = p.opening_balance_id
        WHERE p.id = $1 AND p.receipt_id IS NULL FOR UPDATE OF p`,
      [req.params.id]
    );
    const old = rows[0];
    if (!old) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Payment not found." }); }
    const next = {
      payment_date: b.date ?? old.payment_date,
      amount: b.amount != null && b.amount !== "" ? r2(b.amount) : r2(old.amount),
      mode: b.mode ?? old.mode,
      reference_number: b.reference_number !== undefined ? clean(b.reference_number, 100) : old.reference_number,
      remarks: b.remarks !== undefined ? clean(b.remarks, 500) : old.remarks,
    };
    const bad = (msg) => client.query("ROLLBACK").then(() => res.status(400).json({ error: msg }));
    if (!ISO.test(next.payment_date || "")) return bad("Enter the date received.");
    if (!(next.amount > 0)) return bad("Enter the amount — to remove the payment, delete it.");
    if (!MODES.includes(next.mode)) return bad("Choose how it was paid.");
    if (next.amount > Number(old.room) + 0.005) return bad(`Only ₹${r2(old.room)} is owed on what this payment is against. For more, record a receipt — the extra is kept as an advance.`);
    const before = paymentView(old);
    const after = paymentView(next);
    if (JSON.stringify(before) === JSON.stringify(after)) return bad("Nothing was changed.");
    await client.query(
      `UPDATE payments SET payment_date = $2, amount = $3, mode = $4, reference_number = $5, remarks = $6 WHERE id = $1`,
      [old.id, next.payment_date, next.amount, next.mode, next.reference_number, next.remarks]
    );
    await logCorrection(client, { kind: "payment", id: old.id, customerId: old.customer_id, action: "edit", before, after, reason, userId: req.user.id });
    if (next.amount < Number(old.amount)) await applyAdvances(client, old.customer_id);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

router.post("/ledger/entries/payment/:id(\\d+)/delete", CORRECT_DELETE, async (req, res) => {
  const reason = clean(req.body?.reason, 300);
  if (!reason) return res.status(400).json({ error: "Give the reason for deleting." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `DELETE FROM payments p USING (SELECT p2.id, COALESCE(i.customer_id, ob.customer_id) AS customer_id
                                       FROM payments p2 LEFT JOIN invoices i ON i.id = p2.invoice_id
                                       LEFT JOIN customer_opening_balances ob ON ob.id = p2.opening_balance_id) c
        WHERE p.id = $1 AND p.receipt_id IS NULL AND c.id = p.id
        RETURNING p.id, c.customer_id, p.payment_date::text AS payment_date, p.amount, p.mode::text AS mode, p.reference_number, p.remarks`,
      [req.params.id]
    );
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Payment not found." }); }
    const p = rows[0];
    await logCorrection(client, { kind: "payment", id: p.id, customerId: p.customer_id, action: "delete", before: paymentView(p), after: null, reason, userId: req.user.id });
    await applyAdvances(client, p.customer_id);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// The corrections made on one customer's ledger, newest first.
router.get("/ledger/:customerId(\\d+)/corrections", LEDGER_VIEW, async (req, res) => {
  const { rows } = await query(
    `SELECT k.id, k.entry_kind, k.entry_id, k.action, k.before_value, k.after_value, k.reason, k.done_at, u.name AS done_by_name
       FROM customer_ledger_corrections k LEFT JOIN users u ON u.id = k.done_by
      WHERE k.customer_id = $1 ORDER BY k.done_at DESC, k.id DESC LIMIT 200`,
    [req.params.customerId]
  );
  const ids = [...new Set(rows.flatMap((r) => [r.before_value?.customer_id, r.after_value?.customer_id]).filter(Boolean))];
  const names = ids.length ? (await query(`SELECT id, name FROM customers WHERE id = ANY($1::int[])`, [ids])).rows : [];
  res.json({ rows, customers: Object.fromEntries(names.map((c) => [c.id, c.name])) });
});

// ===========================================================================
// Bank statements — the Accountant uploads the statement (parsed in the
// browser), credits come in as lines to post. Debits are skipped.
// ===========================================================================
const STOP = new Set(["PVT", "LTD", "PRIVATE", "LIMITED", "THE", "AND", "CONSTRUCTIONS", "CONSTRUCTION", "BUILDERS", "BUILDER",
  "DEVELOPERS", "ENTERPRISES", "INFRA", "PROJECTS", "COMPANY", "TRADERS", "ASSOCIATES", "GROUP", "SONS", "MR", "MRS", "MS"]);
const tokens = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t));

// Round 205 — a remembered payer name counts only as a whole word in the
// narration, never as the front of a reference code ("FDRLR" inside
// "FDRLR52026…" is the paying bank, not a customer).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function aliasHit(narr, alias) {
  const a = String(alias || "").toUpperCase().trim();
  if (!a) return false;
  return new RegExp(`(^|[^A-Z0-9])${escRe(a)}($|[^A-Z0-9])`).test(String(narr || "").toUpperCase());
}
// Why a payer name cannot be remembered, or null.
export function aliasProblem(alias, narration, ownWords) {
  const a = String(alias || "").toUpperCase().replace(/\s+/g, " ").trim();
  const letters = (a.match(/[A-Z]/g) || []).length, digits = (a.match(/[0-9]/g) || []).length;
  if (letters < 4) return "Too short — use the payer's name as the bank shows it.";
  if (digits > letters / 2) return "That is a reference number, not a name.";
  const narr = String(narration || "").toUpperCase();
  const codeTokens = narr.split(/[^A-Z0-9]+/).filter((t) => /[0-9]/.test(t) && /[A-Z]/.test(t));
  const flat = a.replace(/[^A-Z0-9]/g, "");
  if (codeTokens.some((t) => t.startsWith(flat) || t.includes(flat))) return "That is part of the bank's reference code (the paying bank), not the payer — use the name.";
  if (ownWords.some((w) => a.includes(w))) return "That is our own name or account.";
  return null;
}
// Credits from our own accounts (bank-to-bank transfers): the narration
// carries our name or one of our account numbers from Settings.
async function ownMarkers() {
  const { rows } = await query(`SELECT bank_accounts FROM quotation_settings WHERE id = 1`).catch(() => ({ rows: [] }));
  const nums = (rows[0]?.bank_accounts || []).map((b) => String(b.number || "").replace(/\D/g, "")).filter((n) => n.length >= 6);
  return { names: ["OUR OWN READY MIX", "OUR OWN READYMIX", "OUROWN READY MIX"], nums };
}
export function isOwnTransfer(narration, own) {
  const n = String(narration || "").toUpperCase();
  const digits = n.replace(/[^0-9]/g, " ");
  return own.names.some((w) => n.includes(w)) || own.nums.some((x) => digits.split(/\s+/).includes(x) || n.includes(x));
}

async function matchLine(line, ctx) {
  const narr = String(line.narration || "").toUpperCase();
  for (const a of ctx.aliases) {
    if (aliasHit(narr, a.alias)) return { customer_id: a.customer_id, level: "sure", reason: `Known payer “${a.alias}”` };
  }
  const narrTokens = new Set(tokens(narr));
  const byName = ctx.customers.filter((c) => {
    const t = tokens(c.name);
    return t.length && t.every((x) => narrTokens.has(x));
  });
  if (byName.length === 1) return { customer_id: byName[0].id, level: "likely", reason: "Name in the narration" };
  const partial = ctx.customers.filter((c) => tokens(c.name).some((x) => narrTokens.has(x)));
  const amt = r2(line.amount);
  const byAmount = ctx.balances.filter((b) => Math.abs(Number(b.balance) - amt) < 0.5 || (b.items || []).some((v) => Math.abs(Number(v) - amt) < 0.5));
  if (partial.length === 1) return { customer_id: partial[0].id, level: "likely", reason: "Part of the name in the narration" };
  if (byAmount.length === 1) return { customer_id: byAmount[0].id, level: "likely", reason: "Same as an amount due" };
  return { customer_id: null, level: "none", reason: null };
}

async function matchContext() {
  const [aliases, customers, balances] = await Promise.all([
    query(`SELECT customer_id, alias FROM customer_payment_aliases ORDER BY LENGTH(alias) DESC`),
    query(`SELECT id, name FROM customers`),
    query(
      `SELECT x.id, x.balance, (SELECT array_agg(i.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0))
                                  FROM invoices i WHERE i.customer_id = x.id) AS items
         FROM (${BALANCES_SQL}) x WHERE x.balance > 0.01`
    ),
  ]);
  return { aliases: aliases.rows, customers: customers.rows, balances: balances.rows };
}

router.post("/bank/import", RC_CREATE, async (req, res) => {
  const bankAccount = String(req.body.bank_account || "").trim().slice(0, 60);
  if (!bankAccount) return res.status(400).json({ error: "Choose which bank account this statement is for." });
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "No credit lines were found in the statement." });
  if (rows.length > 5000) return res.status(400).json({ error: "That statement is too long — import at most 5,000 lines at a time." });
  const clean = [];
  let skipped = 0;
  for (const r of rows) {
    const amount = r2(String(r.credit ?? r.amount ?? "").replace(/[,₹\s]/g, ""));
    if (!ISO.test(r.date || "") || !(amount > 0)) { skipped++; continue; }
    const narration = String(r.narration || "").trim().slice(0, 500);
    const reference = String(r.reference || "").trim().slice(0, 120) || null;
    // Round 205 — the same credit gives the same key however the statement
    // was downloaded: balance as a number, reference / narration without
    // spaces or case. The Round 204 key is still checked, so a statement
    // uploaded before this round is not brought in twice.
    const bal = String(r.balance ?? "").replace(/[,₹\s]/g, "").replace(/(CR|DR)$/i, "");
    const balKey = bal !== "" && Number.isFinite(Number(bal)) ? Number(bal).toFixed(2) : "";
    const refKey = (reference || narration).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 120);
    const key = ["v2", bankAccount, r.date, amount.toFixed(2), refKey, balKey].join("|").slice(0, 300);
    const legacyKey = [bankAccount, r.date, amount.toFixed(2), reference || narration.slice(0, 120), r.balance ?? ""].join("|").slice(0, 300);
    clean.push({ date: r.date, amount, narration, reference, key, legacyKey });
  }
  const ctx = await matchContext();
  const dates = clean.map((c) => c.date).sort();
  const client = await pool.connect();
  let added = 0, duplicates = 0;
  try {
    await client.query("BEGIN");
    const { rows: imp } = await client.query(
      `INSERT INTO bank_statement_imports (bank_account, file_name, period_from, period_to, credit_lines, skipped_lines, imported_by)
       VALUES ($1, $2, $3, $4, 0, $5, $6) RETURNING id`,
      [bankAccount, String(req.body.file_name || "").slice(0, 200) || null, dates[0] || null, dates[dates.length - 1] || null, skipped, req.user.id]
    );
    const importId = imp[0].id;
    const own = await ownMarkers();
    let ownCount = 0;
    for (const c of clean) {
      const { rows: legacy } = await client.query(`SELECT 1 FROM bank_statement_lines WHERE dedupe_key = $1`, [c.legacyKey]);
      if (legacy.length) { duplicates++; continue; }
      const ownT = isOwnTransfer(c.narration, own);
      const m = ownT ? { customer_id: null, level: "none", reason: "Own account" } : await matchLine(c, ctx);
      const { rowCount } = await client.query(
        `INSERT INTO bank_statement_lines (import_id, bank_account, txn_date, narration, reference, amount, dedupe_key,
                                           suggested_customer_id, match_level, match_reason, status, ignored_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (dedupe_key) DO NOTHING`,
        [importId, bankAccount, c.date, c.narration, c.reference, c.amount, c.key, m.customer_id, m.level, m.reason,
         ownT ? "ignored" : "open", ownT ? "Own account transfer" : null]
      );
      if (rowCount) { added++; if (ownT) ownCount++; } else duplicates++;
    }
    await client.query(`UPDATE bank_statement_imports SET credit_lines = $2 WHERE id = $1`, [importId, added]);
    await client.query("COMMIT");
    res.json({ import_id: importId, added, duplicates, skipped, own_transfers: ownCount });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

router.get("/bank/lines", RC_VIEW, async (req, res) => {
  const status = ["open", "posted", "ignored"].includes(req.query.status) ? req.query.status : "open";
  const { rows } = await query(
    `SELECT l.*, l.txn_date::text AS txn_date, c.name AS suggested_customer_name, r.customer_id AS posted_customer_id,
            pc.name AS posted_customer_name, u.name AS settled_by_name
       FROM bank_statement_lines l
       LEFT JOIN customers c ON c.id = l.suggested_customer_id
       LEFT JOIN customer_receipts r ON r.id = l.receipt_id
       LEFT JOIN customers pc ON pc.id = r.customer_id
       LEFT JOIN users u ON u.id = l.settled_by
      WHERE l.status = $1
      ORDER BY l.txn_date DESC, l.id DESC LIMIT 1000`,
    [status]
  );
  const { rows: imports } = await query(
    `SELECT bi.*, bi.period_from::text AS period_from, bi.period_to::text AS period_to, u.name AS imported_by_name
       FROM bank_statement_imports bi LEFT JOIN users u ON u.id = bi.imported_by ORDER BY bi.id DESC LIMIT 10`
  );
  res.json({ lines: rows, imports });
});

// Re-run matching on the open lines (after a customer or alias was added).
router.post("/bank/rematch", RC_CREATE, async (req, res) => {
  const ctx = await matchContext();
  const { rows } = await query(`SELECT id, narration, amount FROM bank_statement_lines WHERE status = 'open'`);
  for (const l of rows) {
    const m = await matchLine(l, ctx);
    await query(
      `UPDATE bank_statement_lines SET suggested_customer_id = $2, match_level = $3, match_reason = $4 WHERE id = $1`,
      [l.id, m.customer_id, m.level, m.reason]
    );
  }
  res.json({ rematched: rows.length });
});

router.post("/bank/lines/:id(\\d+)/post", RC_CREATE, async (req, res) => {
  const customerId = Number(req.body.customer_id);
  if (!customerId) return res.status(400).json({ error: "Choose the customer this payment is from." });
  const mode = MODES.includes(req.body.mode) ? req.body.mode : (/UPI/i.test(req.body.narration || "") ? "upi" : "bank_transfer");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM bank_statement_lines WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const l = rows[0];
    if (!l) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Line not found." }); }
    if (l.status !== "open") { await client.query("ROLLBACK"); return res.status(409).json({ error: "This line is already settled." }); }
    const lineMode = MODES.includes(req.body.mode) ? req.body.mode : (/UPI/i.test(l.narration || "") ? "upi" : mode);
    const out = await postReceipt(client, {
      customer_id: customerId, receipt_date: l.txn_date, amount: l.amount, mode: lineMode,
      reference_number: l.reference, bank_account: l.bank_account, narration: l.narration,
      remarks: String(req.body.remarks || "").trim() || null, bank_line_id: l.id, userId: req.user.id,
    });
    await client.query(
      `UPDATE bank_statement_lines SET status = 'posted', receipt_id = $2, settled_by = $3, settled_at = now() WHERE id = $1`,
      [l.id, out.id, req.user.id]
    );
    const alias = String(req.body.learn_alias || "").trim().toUpperCase().replace(/\s+/g, " ").slice(0, 120);
    if (alias) {
      const problem = aliasProblem(alias, l.narration, (await ownMarkers()).names);
      if (problem) { await client.query("ROLLBACK"); return res.status(400).json({ error: `Payer name "${alias}": ${problem} Or untick "Remember".` }); }
      const { rows: taken } = await client.query(`SELECT c.name FROM customer_payment_aliases a JOIN customers c ON c.id = a.customer_id WHERE a.alias = $1 AND a.customer_id <> $2`, [alias, customerId]);
      if (taken.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: `"${alias}" is already remembered for ${taken[0].name}. Untick "Remember" or forget it under Payer names first.` }); }
      await client.query(
        `INSERT INTO customer_payment_aliases (customer_id, alias, created_by) VALUES ($1, $2, $3) ON CONFLICT (alias) DO NOTHING`,
        [customerId, alias, req.user.id]
      );
    }
    await client.query("COMMIT");
    res.json(out);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

router.post("/bank/lines/:id(\\d+)/ignore", RC_CREATE, async (req, res) => {
  const reason = String(req.body.reason || "").trim().slice(0, 120);
  if (!reason) return res.status(400).json({ error: "Say why — e.g. not a customer (interest, refund, own transfer)." });
  const { rowCount } = await query(
    `UPDATE bank_statement_lines SET status = 'ignored', ignored_reason = $2, settled_by = $3, settled_at = now()
      WHERE id = $1 AND status = 'open'`,
    [req.params.id, reason, req.user.id]
  );
  if (!rowCount) return res.status(409).json({ error: "This line is already settled." });
  res.json({ ok: true });
});

router.post("/bank/lines/:id(\\d+)/reopen", RC_CREATE, async (req, res) => {
  const { rowCount } = await query(
    `UPDATE bank_statement_lines SET status = 'open', ignored_reason = NULL, settled_by = NULL, settled_at = NULL
      WHERE id = $1 AND status = 'ignored'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(409).json({ error: "Only an ignored line can be reopened (cancel the receipt to reopen a posted one)." });
  res.json({ ok: true });
});

router.get("/aliases", RC_VIEW, async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, c.name AS customer_name FROM customer_payment_aliases a JOIN customers c ON c.id = a.customer_id ORDER BY c.name, a.alias`
  );
  res.json(rows);
});
router.delete("/aliases/:id(\\d+)", RC_CREATE, async (req, res) => {
  await query(`DELETE FROM customer_payment_aliases WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ===========================================================================
// One-time migration of the Accountant's rate file into the price list.
// Each live rate is checked; the Administrator keeps it, moves a customer-wide
// rate onto a site, or leaves it out (ended the day before it started, so it
// never applies — history stays). Complete locks direct rate edits.
// ===========================================================================
const MIG_VIEW = requirePermission("accounts.rate-migration", "view");
const MIG_EDIT = requirePermission("accounts.rate-migration", "edit");

router.get("/rate-migration", MIG_VIEW, async (req, res) => {
  const { rows } = await query(
    `SELECT rm.id, rm.customer_id, c.name AS customer_name, rm.site_id, s.name AS site_name, rm.mix_grade_id, m.name AS grade_name,
            rm.rate_per_m3, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to,
            rm.line_pump_charge, rm.pumping_charge_lumpsum, rm.boom_pump_charge, rm.part_load_charge_per_m3, rm.waiting_charge_per_hour,
            rm.migration_note,
            (SELECT COUNT(*) FROM rate_master d WHERE d.customer_id = rm.customer_id AND d.mix_grade_id = rm.mix_grade_id
               AND d.site_id IS NOT DISTINCT FROM rm.site_id AND d.id <> rm.id AND d.source = 'rate_file'
               AND d.effective_from <= CURRENT_DATE AND (d.effective_to IS NULL OR d.effective_to >= CURRENT_DATE))::int AS duplicates,
            (SELECT COUNT(*) FROM sites st WHERE st.customer_id = rm.customer_id AND COALESCE(st.is_active, true))::int AS customer_sites,
            (SELECT MAX(co.order_date)::text FROM customer_orders co WHERE co.customer_id = rm.customer_id AND co.mix_grade_id = rm.mix_grade_id
               AND (rm.site_id IS NULL OR co.site_id = rm.site_id)) AS last_order_on
       FROM rate_master rm
       JOIN customers c ON c.id = rm.customer_id
       JOIN mix_grades m ON m.id = rm.mix_grade_id
       LEFT JOIN sites s ON s.id = rm.site_id
      WHERE rm.source = 'rate_file' AND rm.effective_from <= CURRENT_DATE
        AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)
      ORDER BY c.name, s.name NULLS FIRST, m.name`
  );
  const out = rows.map((r) => {
    const issues = [];
    if (r.duplicates > 0) issues.push("duplicate");
    if (r.site_id == null) issues.push("no_site");
    if (Number(r.rate_per_m3) === 4500 && Number(r.pumping_charge_lumpsum) === 1500 && Number(r.waiting_charge_per_hour) === 500 && r.grade_name === "M25") issues.push("sample_rate");
    if (r.line_pump_charge == null && r.pumping_charge_lumpsum == null && r.boom_pump_charge == null && r.part_load_charge_per_m3 == null) issues.push("no_charges");
    return { ...r, issues };
  });
  const { rows: st } = await query(
    `SELECT s.rates_locked_at, u.name AS rates_locked_by_name FROM quotation_settings s LEFT JOIN users u ON u.id = s.rates_locked_by WHERE s.id = 1`
  );
  const { rows: sites } = await query(
    `SELECT id, customer_id, name FROM sites WHERE COALESCE(is_active, true) AND customer_id = ANY($1::int[]) ORDER BY name`,
    [[...new Set(rows.map((r) => r.customer_id))]]
  );
  res.json({ rates: out, locked_at: st[0]?.rates_locked_at || null, locked_by: st[0]?.rates_locked_by_name || null, sites });
});

router.post("/rate-migration/:id(\\d+)", MIG_EDIT, async (req, res) => {
  const action = req.body.action;
  const { rows } = await query(`SELECT * FROM rate_master WHERE id = $1 AND source = 'rate_file'`, [req.params.id]);
  const r = rows[0];
  if (!r) return res.status(404).json({ error: "Rate not found." });
  const note = String(req.body.note || "").trim() || null;
  if (action === "keep") {
    await query(`UPDATE rate_master SET migration_note = COALESCE($2, 'Kept') WHERE id = $1`, [r.id, note]);
  } else if (action === "leave_out") {
    // Ends it before it starts from today: it keeps its history up to
    // yesterday and applies to nothing new.
    await query(
      `UPDATE rate_master SET effective_to = GREATEST(effective_from, CURRENT_DATE) - 1,
              migration_note = COALESCE($2, 'Left out at migration') WHERE id = $1`,
      [r.id, note]
    );
  } else if (action === "set_site") {
    const siteIds = (Array.isArray(req.body.site_ids) ? req.body.site_ids : [req.body.site_id]).map(Number).filter(Boolean);
    if (!siteIds.length) return res.status(400).json({ error: "Choose the site(s)." });
    const { rows: ok } = await query(`SELECT id FROM sites WHERE id = ANY($1::int[]) AND customer_id = $2`, [siteIds, r.customer_id]);
    if (ok.length !== siteIds.length) return res.status(400).json({ error: "A chosen site belongs to another customer." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const sid of siteIds) {
        await client.query(
          `INSERT INTO rate_master (customer_id, site_id, mix_grade_id, rate_per_m3, waiting_charge_per_hour, effective_from,
                                    pumping_charge_lumpsum, line_pump_charge, line_pump_min_qty_m3, boom_pump_charge, boom_pump_min_qty_m3,
                                    part_load_min_qty_m3, part_load_charge_per_m3, source, migration_note, created_by)
           SELECT customer_id, $2, mix_grade_id, rate_per_m3, waiting_charge_per_hour, effective_from,
                  pumping_charge_lumpsum, line_pump_charge, line_pump_min_qty_m3, boom_pump_charge, boom_pump_min_qty_m3,
                  part_load_min_qty_m3, part_load_charge_per_m3, 'rate_file', $3, $4
             FROM rate_master WHERE id = $1`,
          [r.id, sid, `Moved from the customer-wide rate #${r.id}`, req.user.id]
        );
      }
      if (r.site_id == null && req.body.end_customer_wide !== false) {
        await client.query(
          `UPDATE rate_master SET effective_to = GREATEST(effective_from, CURRENT_DATE) - 1,
                  migration_note = 'Replaced by site rates at migration'
            WHERE id = $1`,
          [r.id]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } else {
    return res.status(400).json({ error: "Unknown action." });
  }
  res.json({ ok: true });
});

// Round 252 (owner, 30 Oct 2026): "disable old rate files option or merge if
// rate is same". A live rate-file rate that a quotation price list already
// gives at the SAME rate (same customer, site, grade) is closed from today —
// the quotation's rate carries on, so nothing is priced differently. A rate-
// file rate with no matching quotation rate keeps applying until the customer
// is quoted (closing it would hold their deliveries with no price).
const LIVE_RF = `rm.source = 'rate_file' AND rm.effective_from <= CURRENT_DATE AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)`;
const SAME_QUOTE = `EXISTS (SELECT 1 FROM rate_master q WHERE q.source <> 'rate_file' AND q.customer_id = rm.customer_id
                      AND q.site_id IS NOT DISTINCT FROM rm.site_id AND q.mix_grade_id = rm.mix_grade_id AND q.rate_per_m3 = rm.rate_per_m3
                      AND q.effective_from <= CURRENT_DATE AND (q.effective_to IS NULL OR q.effective_to >= CURRENT_DATE))`;
router.get("/rate-file-status", MIG_VIEW, async (req, res) => {
  const { rows } = await query(`SELECT COUNT(*)::int AS live, COUNT(*) FILTER (WHERE ${SAME_QUOTE})::int AS same FROM rate_master rm WHERE ${LIVE_RF}`);
  res.json(rows[0]);
});
router.post("/rate-file-merge", MIG_EDIT, async (req, res) => {
  const { rowCount } = await query(
    `UPDATE rate_master rm SET effective_to = GREATEST(rm.effective_from, CURRENT_DATE) - 1,
            migration_note = 'Merged — the same rate is on the quotation price list'
      WHERE ${LIVE_RF} AND ${SAME_QUOTE}`);
  const { rows } = await query(`SELECT COUNT(*)::int AS live FROM rate_master rm WHERE ${LIVE_RF}`);
  res.json({ merged: rowCount, still_live: rows[0].live });
});

router.post("/rate-migration/complete", MIG_EDIT, async (req, res) => {
  await query(`UPDATE quotation_settings SET rates_locked_at = now(), rates_locked_by = $1 WHERE id = 1 AND rates_locked_at IS NULL`, [req.user.id]);
  res.json({ ok: true });
});

// Undo the lock (an Administrator who needs a direct correction).
router.post("/rate-migration/unlock", MIG_EDIT, async (req, res) => {
  await query(`UPDATE quotation_settings SET rates_locked_at = NULL, rates_locked_by = NULL WHERE id = 1`);
  res.json({ ok: true });
});

export default router;
