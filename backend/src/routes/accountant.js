import { Router } from "express";
import { pool, query } from "../db.js";
import { positions, postReceipt, applyAdvances, OUTSTANDING_SQL, receivedSql } from "../lib/receivables.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";

const router = Router();
// Round 192 — the Trip Allowance Report is a Production sub-menu that a Super
// Admin grants or denies by its function (reports.trip-allowance: Administrator,
// Manager, Accountant by default). It used to sit behind this router's
// Accountant-only role guard, so the Manager the catalogue and the screen both
// allowed got a 403 from here. Those two paths skip the role guard and are
// gated by the function instead; everything else in this router is unchanged.
const TRIP_REPORT_PATHS = new Set(["/trip-allowance-report", "/trip-allowance-report/export"]);
const accountantOnly = requireRole("accountant", "administrator");
const tripReport = requirePermission("reports.trip-allowance", "view");
router.use(requireAuth, (req, res, next) => (TRIP_REPORT_PATHS.has(req.path) ? tripReport : accountantOnly)(req, res, next));

// Round 180 (#10) — credit notes due. Each is a partial rejection: the invoice
// has already been adjusted down to the accepted m³, and this flags the returned
// portion so Accounts can issue a formal credit note to the customer if the full
// invoice already went out. "Mark issued" clears the flag.
router.get("/credit-notes", async (req, res) => {
  const { rows } = await query(
    `SELECT i.ticket_id, dt.ticket_number, dt.ticket_date, c.name AS customer_name,
            s.name AS site_name, m.name AS grade_name,
            dt.loaded_quantity_m3, i.rejected_quantity_m3, i.credit_note_amount,
            i.credit_note_reason, i.concrete_amount, i.total_amount,
            rr.reason AS rejection_reason
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = co.customer_id
       JOIN sites s ON s.id = co.site_id
       JOIN mix_grades m ON m.id = co.mix_grade_id
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
       LEFT JOIN rejection_reasons rr ON rr.id = sq.rejection_reason_id
      WHERE i.credit_note_needed = true AND COALESCE(i.credit_note_cleared, false) = false
      ORDER BY dt.ticket_date DESC, dt.id DESC`
  );
  res.json(rows);
});

router.post("/credit-notes/:ticketId/clear", async (req, res) => {
  const { rows } = await query(
    `UPDATE invoices SET credit_note_cleared = true
      WHERE ticket_id = $1 AND credit_note_needed = true RETURNING ticket_id`,
    [req.params.ticketId]
  );
  if (!rows.length) return res.status(404).json({ error: "No credit note is flagged for that delivery." });
  res.json({ ok: true });
});

// Round 205 — the Accountant home (owner, 12 Oct 2026). Every rupee figure
// comes from lib/receivables.js, the same calculation as Accounts → Customer
// ledger, the Outstanding Collection report and the Director dashboard.
router.get("/home", async (req, res) => {
  const [all, out, today, month, billedMonth, bank, held, creditNotes, waivers, pump, reprice, dupOb, allowance, todayList] = await Promise.all([
    positions(),
    query(OUTSTANDING_SQL),
    query(receivedSql("CURRENT_DATE", "CURRENT_DATE")),
    query(receivedSql("date_trunc('month', CURRENT_DATE)", "CURRENT_DATE")),
    query(`SELECT COALESCE(SUM(i.total_amount), 0) AS total FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
            WHERE dt.ticket_date >= date_trunc('month', CURRENT_DATE)`),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS amt, COUNT(*) FILTER (WHERE suggested_customer_id IS NOT NULL)::int AS matched
             FROM bank_statement_lines WHERE status = 'open'`).catch(() => ({ rows: [{ n: 0, amt: 0, matched: 0 }] })),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(dt.loaded_quantity_m3), 0) AS m3 FROM delivery_tickets dt
            WHERE dt.status NOT IN ('cancelled', 'rejected') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ticket_id = dt.id)`),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(credit_note_amount), 0) AS amt FROM invoices
            WHERE credit_note_needed = true AND COALESCE(credit_note_cleared, false) = false`),
    query(`SELECT COUNT(*)::int AS n FROM customer_orders WHERE charge_review_status = 'pending'`).catch(() => ({ rows: [{ n: 0 }] })),
    query(`SELECT COUNT(*)::int AS n FROM customer_orders WHERE pump_charge_needs_review = true`),
    query(`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'reprice_review' AND COALESCE(is_read, false) = false`),
    query(`SELECT COUNT(*)::int AS n FROM (SELECT customer_id FROM customer_opening_balances GROUP BY customer_id HAVING COUNT(*) > 1) x`),
    query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(DISTINCT driver_id)::int AS drivers FROM trip_allowance_payouts
            WHERE date_trunc('month', earned_at) = date_trunc('month', CURRENT_DATE)`).catch(() => ({ rows: [{ total: 0, drivers: 0 }] })),
    query(`SELECT * FROM (
             SELECT r.id, 'receipt' AS kind, c.name AS customer_name, r.amount, r.mode::text AS mode, r.reference_number, r.created_at
               FROM customer_receipts r JOIN customers c ON c.id = r.customer_id
              WHERE r.cancelled_at IS NULL AND r.receipt_date = CURRENT_DATE
             UNION ALL
             SELECT p.id, 'payment', c.name, p.amount, p.mode::text, p.reference_number, p.created_at
               FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customer_opening_balances b ON b.id = p.opening_balance_id
               JOIN customers c ON c.id = COALESCE(i.customer_id, b.customer_id)
              WHERE p.receipt_id IS NULL AND p.payment_date = CURRENT_DATE
           ) x ORDER BY created_at DESC LIMIT 30`).catch(() => ({ rows: [] })),
  ]);
  const owing = all.filter((p) => p.balance > 0.01);
  const sum = (k) => owing.reduce((t, p) => t + p[k], 0);
  // Who to chase: oldest money first, then the largest.
  const chase = owing
    .map((p) => ({ ...p, overdue: p.d15_30 + p.d30p }))
    .sort((a, b) => b.d30p - a.d30p || b.overdue - a.overdue || b.balance - a.balance)
    .slice(0, 25);
  const r2 = (n) => Math.round(n * 100) / 100;
  res.json({
    kpis: {
      outstanding: Number(out.rows[0].total),
      customers_owing: owing.length,
      over_30: r2(sum("d30p")),
      over_30_customers: owing.filter((p) => p.d30p > 0.01).length,
      received_today: Number(today.rows[0].total), received_today_count: Number(today.rows[0].count),
      received_month: Number(month.rows[0].total),
      billed_month: Number(billedMonth.rows[0].total),
      advances: r2(all.reduce((t, p) => t + p.advance, 0)),
      over_credit_limit: owing.filter((p) => p.credit?.over_by > 0).length,
    },
    ageing: { d0_7: r2(sum("d0_7")), d8_14: r2(sum("d8_14")), d15_30: r2(sum("d15_30")), d30p: r2(sum("d30p")) },
    needs: {
      bank_lines: bank.rows[0].n, bank_amount: Number(bank.rows[0].amt), bank_matched: bank.rows[0].matched,
      held_loads: held.rows[0].n, held_m3: Number(held.rows[0].m3),
      credit_notes: creditNotes.rows[0].n, credit_note_amount: Number(creditNotes.rows[0].amt),
      charges_left_out: waivers.rows[0].n, pump_recheck: pump.rows[0].n,
      reprice_review: reprice.rows[0].n,
      duplicate_opening_balances: dupOb.rows[0].n,
    },
    chase,
    received_today: todayList.rows,
    trip_allowance: { total: Number(allowance.rows[0].total), drivers: allowance.rows[0].drivers },
  });
});

// Everyone who owes money, with ageing — the export on the Accountant home.
router.get("/customers-outstanding", async (req, res) => {
  const rows = (await positions()).filter((p) => p.balance > 0.01).sort((a, b) => b.balance - a.balance);
  res.json(rows.map((p) => ({
    customer_id: p.id, customer_name: p.name, contact_number: p.contact_number,
    total_invoiced: p.billed, total_paid: p.received, balance: p.balance, advance: p.advance,
    d0_7: p.d0_7, d8_14: p.d8_14, d15_30: p.d15_30, d30p: p.d30p,
    oldest_unpaid_date: p.oldest_due_on, last_receipt_on: p.last_receipt_on, credit: p.credit,
  })));
});

// Reprice notices (an accepted new rate could not change an invoice that
// already had money set against it): listed, then marked seen.
router.get("/reprice-review", async (req, res) => {
  const { rows } = await query(
    `SELECT id, ticket_id, message, created_at FROM notifications
      WHERE type = 'reprice_review' AND COALESCE(is_read, false) = false ORDER BY id DESC LIMIT 100`);
  res.json(rows);
});
router.post("/reprice-review/:id(\\d+)/seen", async (req, res) => {
  await query(`UPDATE notifications SET is_read = true WHERE id = $1 AND type = 'reprice_review'`, [req.params.id]);
  res.json({ ok: true });
});

// One customer's individual invoices plus their opening balance (if any), for
// drilling into specifics before a bulk payment.
router.get("/customers/:customerId/invoices", async (req, res) => {
  const [{ rows: invoiceRows }, { rows: obRows }] = await Promise.all([
    query(
      `SELECT i.id, i.total_amount, dt.ticket_number, dt.ticket_date,
              COALESCE(SUM(p.amount), 0) AS paid_amount
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       LEFT JOIN payments p ON p.invoice_id = i.id
       WHERE i.customer_id = $1
       GROUP BY i.id, dt.ticket_number, dt.ticket_date
       ORDER BY dt.ticket_date, i.id`,
      [req.params.customerId]
    ),
    query(
      `SELECT ob.id, ob.amount AS total_amount, ob.as_of_date AS ticket_date,
              ob.notes, COALESCE(SUM(p.amount), 0) AS paid_amount
       FROM customer_opening_balances ob
       LEFT JOIN payments p ON p.opening_balance_id = ob.id
       WHERE ob.customer_id = $1
       GROUP BY ob.id, ob.amount, ob.as_of_date, ob.notes
       ORDER BY ob.as_of_date`,
      [req.params.customerId]
    ),
  ]);
  const withStatus = (rows, isOpening) => rows.map((r) => ({
    ...r,
    ticket_number: isOpening ? `Opening balance${r.notes ? ` — ${r.notes}` : ""}` : r.ticket_number,
    is_opening_balance: isOpening,
    status: Number(r.paid_amount) >= Number(r.total_amount) ? "paid"
      : Number(r.paid_amount) > 0 ? "partially_paid" : "pending",
  }));
  res.json([...withStatus(obRows, true), ...withStatus(invoiceRows, false)]);
});

// Round 205 — the old "Record payment" now records a RECEIPT, exactly like
// Accounts → Bank receipts → Record a receipt: set against the opening
// balance and then the oldest deliveries, and anything left over is kept as
// the customer's advance (it used to be lost).
router.post("/customers/:customerId/bulk-payment", async (req, res) => {
  const { amount, mode, reference_number, remarks, payment_date } = req.body;
  if (!(Number(amount) > 0) || !["cash", "cheque", "bank_transfer", "upi"].includes(mode)) {
    return res.status(400).json({ error: "Amount and payment mode are required." });
  }
  const day = /^\d{4}-\d{2}-\d{2}$/.test(payment_date || "") ? payment_date : (await query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await postReceipt(client, {
      customer_id: Number(req.params.customerId), receipt_date: day, amount: Number(amount), mode,
      reference_number, remarks, userId: req.user.id,
    });
    await client.query("COMMIT");
    res.status(201).json({
      receipt_id: out.id, total_received: Number(amount),
      total_applied: Math.round((Number(amount) - out.advance) * 100) / 100,
      unapplied_credit: out.advance,
      applied: out.applied.map((a) => ({ ticket_number: a.label, amount_applied: a.amount })),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Pre-existing outstanding from before this app was in use.

router.get("/opening-balances", async (req, res) => {
  const { rows } = await query(
    `SELECT ob.*, to_char(ob.as_of_date, 'YYYY-MM-DD') AS as_of, c.name AS customer_name, u.name AS entered_by_name,
            COALESCE(SUM(p.amount), 0) AS paid_amount,
            (SELECT COUNT(*) FROM customer_opening_balances o2 WHERE o2.customer_id = ob.customer_id)::int AS on_file
     FROM customer_opening_balances ob
     JOIN customers c ON c.id = ob.customer_id
     LEFT JOIN users u ON u.id = ob.entered_by
     LEFT JOIN payments p ON p.opening_balance_id = ob.id
     GROUP BY ob.id, c.name, u.name
     ORDER BY (SELECT COUNT(*) FROM customer_opening_balances o2 WHERE o2.customer_id = ob.customer_id) > 1 DESC, c.name, ob.id`
  );
  // Round 206 — a customer has ONE opening balance. Any later one for the same
  // customer is shown as a duplicate the Accountant can remove.
  const firstOf = new Map();
  for (const r of rows) if (!firstOf.has(r.customer_id) || r.id < firstOf.get(r.customer_id)) firstOf.set(r.customer_id, r.id);
  res.json(rows.map((r) => ({ ...r, duplicate: r.on_file > 1 && firstOf.get(r.customer_id) !== r.id })));
});

router.post("/opening-balances", async (req, res) => {
  const { customer_id, amount, days_outstanding, notes } = req.body;
  if (!customer_id || !amount || days_outstanding === undefined || days_outstanding === null) {
    return res.status(400).json({ error: "Customer, amount, and how many days it's been outstanding are all required." });
  }
  // Round 206 — one opening balance per customer (a second one doubled the
  // customer's dues on the ledger).
  const { rows: had } = await query(
    `SELECT amount, to_char(as_of_date, 'DD-Mon-YYYY') AS d FROM customer_opening_balances WHERE customer_id = $1 LIMIT 1`, [customer_id]);
  if (had.length) {
    return res.status(409).json({ error: `This customer already has an opening balance (₹${Number(had[0].amount).toLocaleString("en-IN")} as of ${had[0].d}). A customer has only one — delete that one first if it is wrong.` });
  }
  const { rows } = await query(
    `INSERT INTO customer_opening_balances (customer_id, amount, as_of_date, notes, entered_by)
     VALUES ($1, $2, (CURRENT_DATE - ($3 || ' days')::interval)::date, $4, $5) RETURNING *`,
    [customer_id, amount, Number(days_outstanding), notes || null, req.user.id]
  );
  await applyAdvances({ query }, customer_id); // Round 205: an advance pays it at once
  res.status(201).json(rows[0]);
});

// Bulk add — the Excel-upload flow parses the file client-side (this app
// already has the xlsx library for the Production Report export) and matches
// customer names before ever hitting the server, so this just takes an
// already-resolved array: no new server-side file-upload handling needed.
router.post("/opening-balances/bulk", async (req, res) => {
  const { rows: inputRows } = req.body;
  if (!Array.isArray(inputRows) || inputRows.length === 0) {
    return res.status(400).json({ error: "No rows to import." });
  }
  const inserted = [];
  const skipped = [];
  const { rows: had } = await query(`SELECT DISTINCT customer_id FROM customer_opening_balances`);
  const taken = new Set(had.map((h) => h.customer_id));
  for (const r of inputRows) {
    if (!r.customer_id || !r.amount || r.days_outstanding === undefined || r.days_outstanding === null) continue;
    // Round 206 — one per customer: already on file, or twice in this file.
    if (taken.has(Number(r.customer_id))) { skipped.push(Number(r.customer_id)); continue; }
    taken.add(Number(r.customer_id));
    const { rows } = await query(
      `INSERT INTO customer_opening_balances (customer_id, amount, as_of_date, notes, entered_by)
       VALUES ($1, $2, (CURRENT_DATE - ($3 || ' days')::interval)::date, $4, $5) RETURNING *`,
      [r.customer_id, r.amount, Number(r.days_outstanding), r.notes || null, req.user.id]
    );
    inserted.push(rows[0]);
  }
  for (const cid of new Set(inserted.map((r) => r.customer_id))) await applyAdvances({ query }, cid);
  res.status(201).json({ inserted: inserted.length, skipped: skipped.length });
});

// Round 206 — remove a second opening balance entered for the same customer.
// Money already set against it is not lost: payments entered directly against
// it become receipts, and every receipt is set again against what is still
// open (oldest first) — anything over stays as the customer's advance.
router.post("/opening-balances/:id(\\d+)/remove-duplicate", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM customer_opening_balances WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const ob = rows[0];
    if (!ob) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found." }); }
    const { rows: others } = await client.query(
      `SELECT id FROM customer_opening_balances WHERE customer_id = $1 AND id <> $2`, [ob.customer_id, ob.id]);
    if (!others.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "This is the customer's only opening balance — it is not a duplicate." }); }
    const { rows: pays } = await client.query(
      `SELECT p.*, to_char(p.payment_date, 'YYYY-MM-DD') AS day FROM payments p WHERE p.opening_balance_id = $1`, [ob.id]);
    const receiptIds = new Set();
    let moved = 0;
    for (const p of pays) {
      if (p.receipt_id) { receiptIds.add(p.receipt_id); continue; }
      const { rows: rc } = await client.query(
        `INSERT INTO customer_receipts (customer_id, receipt_date, amount, mode, reference_number, remarks, entered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [ob.customer_id, p.day, p.amount, p.mode, p.reference_number,
         `Moved from a duplicate opening balance${p.remarks ? ` — ${p.remarks}` : ""}`, req.user.id]);
      receiptIds.add(rc[0].id);
      moved++;
    }
    await client.query(`DELETE FROM payments WHERE opening_balance_id = $1`, [ob.id]);
    await client.query(`DELETE FROM customer_opening_balances WHERE id = $1`, [ob.id]);
    const applied = await applyAdvances(client, ob.customer_id);
    await client.query("COMMIT");
    res.json({ ok: true, payments_moved: moved, receipts_reapplied: receiptIds.size, applied });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

router.delete("/opening-balances/:id", async (req, res) => {
  const { rowCount } = await query(
    "DELETE FROM customer_opening_balances WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payments WHERE opening_balance_id = $1)",
    [req.params.id]
  );
  if (!rowCount) return res.status(400).json({ error: "Not found, or a payment has already been recorded against it — can't delete." });
  res.json({ ok: true });
});

// Driver trip allowance summary for the current month, based only on completed deliveries
router.get("/trip-allowances", async (req, res) => {
  const { rows } = await query(
    `SELECT u.name AS driver_name, SUM(tap.amount) AS total
     FROM trip_allowance_payouts tap
     JOIN users u ON u.id = tap.driver_id
     WHERE date_trunc('month', tap.earned_at) = date_trunc('month', CURRENT_DATE)
     GROUP BY u.name
     ORDER BY total DESC`
  );
  res.json(rows);
});

// Full trip allowance report — per-trip detail, filterable by date range and
// driver, for the Driver Trip Allowance report screen (with PDF/Excel export).
function buildAllowanceFilters(q) {
  const clauses = ["true"];
  const params = [];
  if (q.from_date) { params.push(q.from_date); clauses.push(`tap.earned_at >= $${params.length}::date`); }
  if (q.to_date) { params.push(q.to_date); clauses.push(`tap.earned_at < $${params.length}::date + INTERVAL '1 day'`); }
  if (q.driver_id) { params.push(q.driver_id); clauses.push(`tap.driver_id = $${params.length}`); }
  return { where: clauses.join(" AND "), params };
}
const ALLOWANCE_COLUMNS = `
  tap.id, tap.amount, tap.earned_at, tap.paid_out,
  u.name AS driver_name, dt.ticket_number, dt.loaded_quantity_m3,
  c.name AS customer_name, s.name AS site_name, t.truck_number
`;
const ALLOWANCE_FROM = `
  FROM trip_allowance_payouts tap
  JOIN users u ON u.id = tap.driver_id
  JOIN delivery_tickets dt ON dt.id = tap.ticket_id
  JOIN customer_orders co ON co.id = dt.order_id
  JOIN customers c ON c.id = co.customer_id
  JOIN sites s ON s.id = co.site_id
  LEFT JOIN trucks t ON t.id = dt.truck_id
`;

router.get("/trip-allowance-report", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 100));
  const { where, params } = buildAllowanceFilters(req.query);

  const [rowsResult, totalsResult] = await Promise.all([
    query(
      `SELECT ${ALLOWANCE_COLUMNS} ${ALLOWANCE_FROM} WHERE ${where}
       ORDER BY tap.earned_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    ),
    query(`SELECT COUNT(*) AS trip_count, COALESCE(SUM(tap.amount), 0) AS total_amount ${ALLOWANCE_FROM} WHERE ${where}`, params),
  ]);

  res.json({
    rows: rowsResult.rows, page, page_size: pageSize,
    totals: { trip_count: Number(totalsResult.rows[0].trip_count), total_amount: totalsResult.rows[0].total_amount },
  });
});

router.get("/trip-allowance-report/export", async (req, res) => {
  const { where, params } = buildAllowanceFilters(req.query);
  const { rows } = await query(
    `SELECT ${ALLOWANCE_COLUMNS} ${ALLOWANCE_FROM} WHERE ${where} ORDER BY tap.earned_at DESC LIMIT 5000`,
    params
  );
  res.json(rows);
});

// ===================== PUMP CHARGE REVIEW =====================
// Orders flagged because a later delivery pushed cumulative quantity past
// the pump type's minimum threshold after the charge was already confirmed
// applicable. Never auto-corrected — a person reviews and decides.

router.get("/pump-charge-review", async (req, res) => {
  const { rows } = await query(
    `SELECT co.id AS order_id, c.name AS customer_name, s.name AS site_name, co.pump_requirement,
            co.order_quantity_m3, co.pump_charge_amount,
            COALESCE(SUM(dt.loaded_quantity_m3) FILTER (WHERE dt.status != 'cancelled'), 0) AS cumulative_qty,
            i.id AS invoice_id, i.pumping_charge, dt2.ticket_number AS charged_ticket_number,
            COALESCE((SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id), 0) AS payment_count
     FROM customer_orders co
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     LEFT JOIN delivery_tickets dt ON dt.order_id = co.id
     LEFT JOIN delivery_tickets dt2 ON dt2.order_id = co.id
     LEFT JOIN invoices i ON i.ticket_id = dt2.id AND i.pumping_charge > 0
     WHERE co.pump_charge_needs_review = true
     GROUP BY co.id, c.name, s.name, i.id, i.pumping_charge, dt2.ticket_number
     ORDER BY co.id DESC`
  );
  res.json(rows);
});

router.post("/pump-charge-review/:orderId/dismiss", async (req, res) => {
  const { rowCount } = await query(
    "UPDATE customer_orders SET pump_charge_needs_review = false WHERE id = $1",
    [req.params.orderId]
  );
  if (!rowCount) return res.status(404).json({ error: "Order not found." });
  res.json({ ok: true });
});

router.post("/pump-charge-review/:orderId/remove-charge", async (req, res) => {
  const { rows: invoiceRows } = await query(
    `SELECT i.id, i.pumping_charge, i.concrete_amount, i.part_load_charge,
            COALESCE((SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id), 0) AS payment_count
     FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
     WHERE dt.order_id = $1 AND i.pumping_charge > 0`,
    [req.params.orderId]
  );
  const inv = invoiceRows[0];
  if (!inv) return res.status(404).json({ error: "No pump charge found on this order's invoices." });
  if (Number(inv.payment_count) > 0) {
    return res.status(400).json({ error: "A payment has already been recorded against this invoice — can't remove the charge automatically." });
  }
  await query(
    `UPDATE invoices SET pumping_charge = 0, total_amount = concrete_amount + part_load_charge WHERE id = $1`,
    [inv.id]
  );
  await query("UPDATE customer_orders SET pump_charge_needs_review = false, pump_charge_applicable = false WHERE id = $1", [req.params.orderId]);
  res.json({ ok: true });
});

export default router;
