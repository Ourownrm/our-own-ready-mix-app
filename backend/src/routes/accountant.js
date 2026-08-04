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

// ===================== RETROACTIVE INVOICE RECALCULATION =====================
// When a rate is added or corrected with a past effective date, this finds
// every delivery that rate should apply to and shows exactly what would
// change before touching anything. Deliveries with no invoice yet get one
// created; an existing invoice only gets corrected if nothing has been paid
// against it yet — anything with payments already recorded is left alone and
// flagged for manual review, since silently changing the amount owed on
// something a customer may have already paid against isn't safe to automate.

async function buildRecalculationPreview(rateId) {
  const { rows: rateRows } = await query(
    `SELECT rm.*, c.name AS customer_name, m.name AS mix_grade_name, s.name AS site_name
     FROM rate_master rm
     JOIN customers c ON c.id = rm.customer_id
     JOIN mix_grades m ON m.id = rm.mix_grade_id
     LEFT JOIN sites s ON s.id = rm.site_id
     WHERE rm.id = $1`,
    [rateId]
  );
  if (!rateRows.length) return null;
  const rate = rateRows[0];

  const { rows: tickets } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.ticket_date, dt.loaded_quantity_m3, dt.order_id,
            co.pump_charge_applicable, co.pump_charge_amount, co.part_load_applicable, co.part_load_charge_amount,
            i.id AS invoice_id, i.total_amount AS current_total_amount,
            COALESCE((SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id), 0) AS payment_count
     FROM delivery_tickets dt
     JOIN customer_orders co ON co.id = dt.order_id
     LEFT JOIN invoices i ON i.ticket_id = dt.id
     WHERE co.customer_id = $1 AND co.mix_grade_id = $2
       AND ($5::int IS NULL OR co.site_id = $5)
       AND dt.status = 'completed'
       AND dt.ticket_date >= $3 AND ($4::date IS NULL OR dt.ticket_date <= $4)
     ORDER BY dt.ticket_date, dt.id`,
    [rate.customer_id, rate.mix_grade_id, rate.effective_from, rate.effective_to, rate.site_id]
  );

  // Pump charge and part load are Manager's own confirmed decision on the
  // order, not something this tool recalculates — it only corrects the
  // concrete rate itself. Still only charged once per order regardless of
  // which ticket ends up carrying it.
  const { rows: alreadyCharged } = await query(
    `SELECT DISTINCT dt.order_id FROM delivery_tickets dt
     JOIN invoices i ON i.ticket_id = dt.id
     WHERE dt.order_id = ANY($1) AND (i.pumping_charge > 0 OR i.part_load_charge > 0)`,
    [[...new Set(tickets.map((t) => t.order_id))]]
  );
  const chargedOrders = new Set(alreadyCharged.map((r) => r.order_id));

  const preview = tickets.map((t) => {
    const concreteAmount = Number(t.loaded_quantity_m3) * Number(rate.rate_per_m3);
    let pumpingCharge = 0;
    let partLoadCharge = 0;
    if (!chargedOrders.has(t.order_id)) {
      if (t.pump_charge_applicable) pumpingCharge = Number(t.pump_charge_amount || 0);
      if (t.part_load_applicable) partLoadCharge = Number(t.part_load_charge_amount || 0);
      if (pumpingCharge > 0 || partLoadCharge > 0) chargedOrders.add(t.order_id);
    }
    const newTotal = concreteAmount + pumpingCharge + partLoadCharge;
    const hasPayments = Number(t.payment_count) > 0;
    const currentTotal = t.current_total_amount !== null ? Number(t.current_total_amount) : null;
    const changed = currentTotal === null || Math.abs(currentTotal - newTotal) > 0.01;
    return {
      ticket_id: t.ticket_id, ticket_number: t.ticket_number, ticket_date: t.ticket_date,
      qty: t.loaded_quantity_m3, current_amount: currentTotal, new_concrete_amount: concreteAmount,
      new_pumping_charge: pumpingCharge, new_part_load_charge: partLoadCharge, new_total_amount: newTotal,
      action: !t.invoice_id ? "create" : (changed ? "update" : "unchanged"),
      blocked: hasPayments && changed,
    };
  });

  return { rate, tickets: preview };
}

router.get("/rates/:rateId/recalculate-preview", async (req, res) => {
  const result = await buildRecalculationPreview(req.params.rateId);
  if (!result) return res.status(404).json({ error: "Rate not found." });
  res.json(result);
});

router.post("/rates/:rateId/recalculate-confirm", async (req, res) => {
  const result = await buildRecalculationPreview(req.params.rateId);
  if (!result) return res.status(404).json({ error: "Rate not found." });

  const requestedIds = new Set((req.body.ticket_ids || []).map(String));
  let created = 0, updated = 0, skipped = 0;

  for (const t of result.tickets) {
    if (!requestedIds.has(String(t.ticket_id))) continue;
    if (t.blocked || t.action === "unchanged") { skipped++; continue; }

    if (t.action === "create") {
      await query(
        `INSERT INTO invoices (ticket_id, customer_id, concrete_amount, pumping_charge, part_load_charge, waiting_charge, total_amount)
         VALUES ($1, $2, $3, $4, $5, 0, $6)
         ON CONFLICT DO NOTHING`,
        [t.ticket_id, result.rate.customer_id, t.new_concrete_amount, t.new_pumping_charge, t.new_part_load_charge, t.new_total_amount]
      );
      created++;
    } else if (t.action === "update") {
      await query(
        `UPDATE invoices SET concrete_amount = $1, pumping_charge = $2, part_load_charge = $3, total_amount = $4
         WHERE ticket_id = $5`,
        [t.new_concrete_amount, t.new_pumping_charge, t.new_part_load_charge, t.new_total_amount, t.ticket_id]
      );
      updated++;
    }
  }

  res.json({ created, updated, skipped });
});


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
