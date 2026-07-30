import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("accountant", "administrator"));

// Dashboard KPIs: outstanding, collected today, pumping/waiting charges due, trip allowance this month
router.get("/dashboard", async (req, res) => {
  const [outstanding, collectedToday, pumping, allowance] = await Promise.all([
    query(
      `SELECT
         (SELECT COALESCE(SUM(i.total_amount), 0) FROM invoices i)
         + (SELECT COALESCE(SUM(amount), 0) FROM customer_opening_balances)
         - (SELECT COALESCE(SUM(amount), 0) FROM payments)
         AS total`
    ),
    query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE payment_date = CURRENT_DATE`
    ),
    query(
      `SELECT COALESCE(SUM(pumping_charge + waiting_charge), 0) AS total FROM invoices i
       WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)`
    ),
    query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM trip_allowance_payouts
       WHERE date_trunc('month', earned_at) = date_trunc('month', CURRENT_DATE)`
    ),
  ]);

  res.json({
    outstanding: outstanding.rows[0].total,
    collected_today: collectedToday.rows[0].total,
    pumping_waiting_due: pumping.rows[0].total,
    trip_allowance_this_month: allowance.rows[0].total,
  });
});

// Customer ledger — invoices with payment status
router.get("/ledger", async (req, res) => {
  const { rows } = await query(
    `SELECT i.id, i.total_amount, dt.ticket_number, c.name AS customer_name,
            COALESCE(SUM(p.amount), 0) AS paid_amount
     FROM invoices i
     JOIN delivery_tickets dt ON dt.id = i.ticket_id
     JOIN customers c ON c.id = i.customer_id
     LEFT JOIN payments p ON p.invoice_id = i.id
     GROUP BY i.id, dt.ticket_number, c.name
     ORDER BY i.created_at DESC
     LIMIT 50`
  );
  const withStatus = rows.map((r) => ({
    ...r,
    status: Number(r.paid_amount) >= Number(r.total_amount) ? "paid"
      : Number(r.paid_amount) > 0 ? "partially_paid" : "pending",
  }));
  res.json(withStatus);
});

// Customer-level outstanding summary — the real day-to-day view: who owes
// how much in total (invoices AND any pre-app opening balance combined), not
// scattered across dozens of individual delivery rows. Sorted by balance
// descending so the biggest amounts owed surface first.
router.get("/customers-outstanding", async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT c.id AS customer_id, c.name AS customer_name,
              COALESCE(inv.total_invoiced, 0) + COALESCE(ob.total_opening, 0) AS total_invoiced,
              COALESCE(inv.total_paid, 0) + COALESCE(ob.total_paid, 0) AS total_paid,
              (COALESCE(inv.total_invoiced, 0) + COALESCE(ob.total_opening, 0))
                - (COALESCE(inv.total_paid, 0) + COALESCE(ob.total_paid, 0)) AS balance,
              LEAST(
                COALESCE(inv.oldest_unpaid_date, ob.oldest_unpaid_date),
                COALESCE(ob.oldest_unpaid_date, inv.oldest_unpaid_date)
              ) AS oldest_unpaid_date
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT SUM(i.total_amount) AS total_invoiced, SUM(COALESCE(p.paid, 0)) AS total_paid,
                MIN(dt.ticket_date) FILTER (WHERE i.total_amount > COALESCE(p.paid, 0)) AS oldest_unpaid_date
         FROM invoices i
         JOIN delivery_tickets dt ON dt.id = i.ticket_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
         WHERE i.customer_id = c.id
       ) inv ON true
       LEFT JOIN LATERAL (
         SELECT SUM(ob.amount) AS total_opening, SUM(COALESCE(p.paid, 0)) AS total_paid,
                MIN(ob.as_of_date) FILTER (WHERE ob.amount > COALESCE(p.paid, 0)) AS oldest_unpaid_date
         FROM customer_opening_balances ob
         LEFT JOIN (SELECT opening_balance_id, SUM(amount) AS paid FROM payments GROUP BY opening_balance_id) p ON p.opening_balance_id = ob.id
         WHERE ob.customer_id = c.id
       ) ob ON true
       WHERE COALESCE(inv.total_invoiced, 0) > 0 OR COALESCE(ob.total_opening, 0) > 0
     ) summary
     WHERE balance > 0.01
     ORDER BY balance DESC`
  );
  res.json(rows);
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

// The main time-saver: Accountant enters one lump sum against a customer,
// and it's applied automatically across everything that customer owes —
// their opening balance first (it's always the oldest debt), then invoices
// oldest delivery first — instead of hunting down and paying each one
// individually. Still creates one row per item touched in `payments` (same
// table, same reporting), so nothing downstream needs to know this was
// entered in bulk.
router.post("/customers/:customerId/bulk-payment", async (req, res) => {
  const { amount, mode, reference_number, remarks, payment_date } = req.body;
  if (!amount || !mode || Number(amount) <= 0) {
    return res.status(400).json({ error: "Amount and payment mode are required." });
  }

  const [{ rows: openingBalances }, { rows: outstandingInvoices }] = await Promise.all([
    query(
      `SELECT ob.id, ob.as_of_date, ob.amount - COALESCE(SUM(p.amount), 0) AS balance
       FROM customer_opening_balances ob
       LEFT JOIN payments p ON p.opening_balance_id = ob.id
       WHERE ob.customer_id = $1
       GROUP BY ob.id, ob.amount
       HAVING ob.amount - COALESCE(SUM(p.amount), 0) > 0.01
       ORDER BY ob.as_of_date`,
      [req.params.customerId]
    ),
    query(
      `SELECT i.id, i.total_amount, dt.ticket_number, dt.ticket_date,
              i.total_amount - COALESCE(SUM(p.amount), 0) AS balance
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       LEFT JOIN payments p ON p.invoice_id = i.id
       WHERE i.customer_id = $1
       GROUP BY i.id, dt.ticket_number, dt.ticket_date
       HAVING i.total_amount - COALESCE(SUM(p.amount), 0) > 0.01
       ORDER BY dt.ticket_date, i.id`,
      [req.params.customerId]
    ),
  ]);

  // Opening balances predate every real invoice by definition, so they're
  // paid off first, then invoices oldest-delivery-first.
  const items = [
    ...openingBalances.map((ob) => ({ kind: "opening_balance", id: ob.id, label: "Opening balance", balance: Number(ob.balance) })),
    ...outstandingInvoices.map((inv) => ({ kind: "invoice", id: inv.id, label: inv.ticket_number, balance: Number(inv.balance) })),
  ];

  let remaining = Number(amount);
  const applied = [];
  for (const item of items) {
    if (remaining <= 0.01) break;
    const thisPayment = Math.min(remaining, item.balance);
    const column = item.kind === "opening_balance" ? "opening_balance_id" : "invoice_id";
    await query(
      `INSERT INTO payments (${column}, payment_date, amount, mode, reference_number, remarks, entered_by)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7)`,
      [item.id, payment_date || null, thisPayment, mode, reference_number || null, remarks || null, req.user.id]
    );
    applied.push({
      ticket_number: item.label,
      amount_applied: thisPayment,
      fully_paid: thisPayment >= item.balance - 0.01,
    });
    remaining -= thisPayment;
  }

  res.status(201).json({
    total_received: Number(amount),
    total_applied: Number(amount) - remaining,
    unapplied_credit: remaining, // leftover if payment exceeds everything currently owed
    applied,
  });
});

// Record a payment — supports multiple receipts against the same invoice
router.post("/payments", async (req, res) => {
  const { invoice_id, amount, mode, reference_number, remarks, payment_date } = req.body;
  if (!invoice_id || !amount || !mode) {
    return res.status(400).json({ error: "Invoice, amount, and payment mode are required." });
  }
  const { rows } = await query(
    `INSERT INTO payments (invoice_id, payment_date, amount, mode, reference_number, remarks, entered_by)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7) RETURNING *`,
    [invoice_id, payment_date || null, amount, mode, reference_number, remarks, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// ===================== OPENING BALANCES =====================
// Pre-existing outstanding from before this app was in use.

router.get("/opening-balances", async (req, res) => {
  const { rows } = await query(
    `SELECT ob.*, c.name AS customer_name, u.name AS entered_by_name,
            COALESCE(SUM(p.amount), 0) AS paid_amount
     FROM customer_opening_balances ob
     JOIN customers c ON c.id = ob.customer_id
     LEFT JOIN users u ON u.id = ob.entered_by
     LEFT JOIN payments p ON p.opening_balance_id = ob.id
     GROUP BY ob.id, c.name, u.name
     ORDER BY ob.entered_at DESC`
  );
  res.json(rows);
});

router.post("/opening-balances", async (req, res) => {
  const { customer_id, amount, days_outstanding, notes } = req.body;
  if (!customer_id || !amount || days_outstanding === undefined || days_outstanding === null) {
    return res.status(400).json({ error: "Customer, amount, and how many days it's been outstanding are all required." });
  }
  const { rows } = await query(
    `INSERT INTO customer_opening_balances (customer_id, amount, as_of_date, notes, entered_by)
     VALUES ($1, $2, (CURRENT_DATE - ($3 || ' days')::interval)::date, $4, $5) RETURNING *`,
    [customer_id, amount, Number(days_outstanding), notes || null, req.user.id]
  );
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
  for (const r of inputRows) {
    if (!r.customer_id || !r.amount || r.days_outstanding === undefined || r.days_outstanding === null) continue;
    const { rows } = await query(
      `INSERT INTO customer_opening_balances (customer_id, amount, as_of_date, notes, entered_by)
       VALUES ($1, $2, (CURRENT_DATE - ($3 || ' days')::interval)::date, $4, $5) RETURNING *`,
      [r.customer_id, r.amount, Number(r.days_outstanding), r.notes || null, req.user.id]
    );
    inserted.push(rows[0]);
  }
  res.status(201).json({ inserted: inserted.length });
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

export default router;
