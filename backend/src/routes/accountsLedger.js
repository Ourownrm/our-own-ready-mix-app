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
  const { rows } = await query(
    `SELECT i.id, i.total_amount, i.concrete_amount, i.pumping_charge, i.part_load_charge, i.waiting_charge,
            i.rate_per_m3, i.gst_applied, i.billing_name, i.billing_gstin, i.created_at,
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

// Delivered loads with no invoice — no price on file for the customer + site +
// grade on the order date. Named with any quotation still with the customer.
router.get("/invoices/held", INV_VIEW, async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.ticket_date::text AS ticket_date, dt.loaded_quantity_m3, dt.status,
            co.id AS order_id, co.order_date::text AS order_date, c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name, m.name AS grade_name,
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
  res.json(rows);
});

router.post("/invoices/held/retry", requirePermission("accounts.invoice-gst", "edit"), async (req, res) => {
  const { rows } = await query(
    `SELECT dt.id FROM delivery_tickets dt
      WHERE dt.status NOT IN ('cancelled', 'rejected') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ticket_id = dt.id)`
  );
  let created = 0;
  for (const r of rows) if (await generateInvoiceForTicket(r.id)) created++;
  res.json({ created, still_held: rows.length - created });
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
            co.customer_id, co.site_id, co.mix_grade_id
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
    const rate = await rateFor(r.customer_id, r.site_id, r.mix_grade_id, r.order_date);
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
  const rate = await rateFor(o.customer_id, o.site_id, o.mix_grade_id, o.od);
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

// Open items (opening balances first, then invoices oldest delivery first).
async function openItems(db, customerId) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT 'opening_balance' AS kind, ob.id, ob.as_of_date AS on_date, 'Opening balance' AS label,
              ob.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.opening_balance_id = ob.id), 0) AS balance, 0 AS ord
         FROM customer_opening_balances ob WHERE ob.customer_id = $1
       UNION ALL
       SELECT 'invoice', i.id, dt.ticket_date, dt.ticket_number,
              i.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0), 1
         FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id WHERE i.customer_id = $1
     ) x WHERE balance > 0.01 ORDER BY ord, on_date, id`,
    [customerId]
  );
  return rows;
}

// Applies what a receipt has not yet allocated to the oldest open items.
// Whatever is left stays on the receipt as the customer's advance.
async function allocateReceipt(db, receiptId) {
  const { rows } = await db.query(
    `SELECT r.*, r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) AS free
       FROM customer_receipts r WHERE r.id = $1 AND r.cancelled_at IS NULL`,
    [receiptId]
  );
  const r = rows[0];
  if (!r) return { applied: [], advance: 0 };
  let free = Number(r.free);
  const applied = [];
  for (const item of await openItems(db, r.customer_id)) {
    if (free <= 0.01) break;
    const amt = r2(Math.min(free, Number(item.balance)));
    const col = item.kind === "opening_balance" ? "opening_balance_id" : "invoice_id";
    await db.query(
      `INSERT INTO payments (${col}, payment_date, amount, mode, reference_number, remarks, entered_by, receipt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [item.id, r.receipt_date, amt, r.mode, r.reference_number, `Receipt #${r.id}`, r.entered_by, r.id]
    );
    applied.push({ label: item.label, amount: amt });
    free = r2(free - amt);
  }
  return { applied, advance: r2(Math.max(0, free)) };
}

router.get("/ledger", LEDGER_VIEW, async (req, res) => {
  const { rows } = await query(`${BALANCES_SQL} ORDER BY balance DESC, c.name`);
  // Overdue: open invoice balances older than 30 days.
  const { rows: od } = await query(
    `SELECT i.customer_id, SUM(i.total_amount - COALESCE(p.paid, 0)) AS overdue
       FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
      WHERE dt.ticket_date < CURRENT_DATE - 30 AND i.total_amount - COALESCE(p.paid, 0) > 0.01
      GROUP BY i.customer_id`
  );
  const overdue = Object.fromEntries(od.map((r) => [r.customer_id, Number(r.overdue)]));
  res.json(rows.map((r) => ({ ...r, overdue_30: overdue[r.id] || 0 })));
});

router.get("/ledger/:customerId(\\d+)", LEDGER_VIEW, async (req, res) => {
  const cid = Number(req.params.customerId);
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
       SELECT r.receipt_date, 'receipt', r.id, CONCAT('Receipt · ', r.mode::text), CONCAT_WS(' · ', r.reference_number, r.bank_account, r.narration),
              0, r.amount, 2
         FROM customer_receipts r WHERE r.customer_id = $1 AND r.cancelled_at IS NULL
       UNION ALL
       SELECT p.payment_date, 'payment', p.id, CONCAT('Payment · ', p.mode::text), CONCAT_WS(' · ', p.reference_number, p.remarks),
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
  const items = await openItems(pool, cid);
  const today = new Date();
  const aging = { "0-15": 0, "16-30": 0, "31-60": 0, "60+": 0 };
  for (const it of items) {
    const days = Math.floor((today - new Date(it.on_date)) / 86400000);
    const k = days <= 15 ? "0-15" : days <= 30 ? "16-30" : days <= 60 ? "31-60" : "60+";
    aging[k] = r2(aging[k] + Number(it.balance));
  }
  const { rows: bal } = await query(`${BALANCES_SQL} AND c.id = $1`, [cid]);
  const { rows: credit } = await query(
    `SELECT quote_no, agreement_type, payment FROM quotations WHERE customer_id = $1 AND status = 'accepted'
        AND agreement_type IN ('credit', 'credit_qty') ORDER BY accepted_at DESC LIMIT 1`,
    [cid]
  );
  res.json({
    customer: cust[0], opening_balance: from ? opening : null, lines, aging,
    position: bal[0] || { billed: 0, received: 0, balance: 0, unallocated: 0 },
    credit: credit[0] ? { quote_no: credit[0].quote_no, limit: credit[0].payment?.credit_limit ?? null, days: credit[0].payment?.credit_days ?? null } : null,
    open_items: items.map((i) => ({ ...i, on_date: typeof i.on_date === "string" ? i.on_date : i.on_date.toLocaleDateString("en-CA") })), // ist-ok: DATE column
  });
});

// Apply a customer's advance to invoices raised since.
router.post("/ledger/:customerId(\\d+)/apply-advance", requirePermission("accounts.bank-receipts", "create"), async (req, res) => {
  const { rows } = await query(
    `SELECT id FROM customer_receipts r WHERE customer_id = $1 AND cancelled_at IS NULL
        AND r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) > 0.01
      ORDER BY receipt_date, id`,
    [req.params.customerId]
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const applied = [];
    for (const r of rows) applied.push(...(await allocateReceipt(client, r.id)).applied);
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

async function postReceipt(client, { customer_id, receipt_date, amount, mode, reference_number, bank_account, narration, remarks, bank_line_id, userId }) {
  const { rows } = await client.query(
    `INSERT INTO customer_receipts (customer_id, receipt_date, amount, mode, reference_number, bank_account, narration, remarks, bank_line_id, entered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [customer_id, receipt_date, r2(amount), mode, reference_number || null, bank_account || null, narration || null, remarks || null, bank_line_id || null, userId]
  );
  const id = rows[0].id;
  const alloc = await allocateReceipt(client, id);
  return { id, ...alloc };
}

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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await postReceipt(client, { ...b, userId: req.user.id });
    await client.query("COMMIT");
    res.status(201).json(out);
  } catch (err) {
    await client.query("ROLLBACK");
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
    const { rows } = await client.query(
      `UPDATE customer_receipts SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
        WHERE id = $1 AND cancelled_at IS NULL RETURNING bank_line_id`,
      [req.params.id, req.user.id, reason]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Receipt not found or already cancelled." });
    }
    await client.query(`DELETE FROM payments WHERE receipt_id = $1`, [req.params.id]);
    if (rows[0].bank_line_id) {
      await client.query(
        `UPDATE bank_statement_lines SET status = 'open', receipt_id = NULL, settled_by = NULL, settled_at = NULL WHERE id = $1`,
        [rows[0].bank_line_id]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// ===========================================================================
// Bank statements — the Accountant uploads the statement (parsed in the
// browser), credits come in as lines to post. Debits are skipped.
// ===========================================================================
const STOP = new Set(["PVT", "LTD", "PRIVATE", "LIMITED", "THE", "AND", "CONSTRUCTIONS", "CONSTRUCTION", "BUILDERS", "BUILDER",
  "DEVELOPERS", "ENTERPRISES", "INFRA", "PROJECTS", "COMPANY", "TRADERS", "ASSOCIATES", "GROUP", "SONS", "MR", "MRS", "MS"]);
const tokens = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t));

async function matchLine(line, ctx) {
  const narr = String(line.narration || "").toUpperCase();
  for (const a of ctx.aliases) {
    if (narr.includes(a.alias.toUpperCase())) return { customer_id: a.customer_id, level: "sure", reason: `Known payer “${a.alias}”` };
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
    const key = [bankAccount, r.date, amount.toFixed(2), reference || narration.slice(0, 120), r.balance ?? ""].join("|").slice(0, 300);
    clean.push({ date: r.date, amount, narration, reference, key });
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
    for (const c of clean) {
      const m = await matchLine(c, ctx);
      const { rowCount } = await client.query(
        `INSERT INTO bank_statement_lines (import_id, bank_account, txn_date, narration, reference, amount, dedupe_key,
                                           suggested_customer_id, match_level, match_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dedupe_key) DO NOTHING`,
        [importId, bankAccount, c.date, c.narration, c.reference, c.amount, c.key, m.customer_id, m.level, m.reason]
      );
      if (rowCount) added++; else duplicates++;
    }
    await client.query(`UPDATE bank_statement_imports SET credit_lines = $2 WHERE id = $1`, [importId, added]);
    await client.query("COMMIT");
    res.json({ import_id: importId, added, duplicates, skipped });
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
    const alias = String(req.body.learn_alias || "").trim().toUpperCase().slice(0, 120);
    if (alias.length >= 4) {
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
