import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("accountant", "administrator"));

// Dashboard KPIs: outstanding, collected today, pumping/waiting charges due, trip allowance this month
router.get("/dashboard", async (req, res) => {
  const [outstanding, collectedToday, pumping, allowance] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(p.paid), 0) AS total
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p
         ON p.invoice_id = i.id`
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

// Record a payment — supports multiple receipts against the same invoice
router.post("/payments", async (req, res) => {
  const { invoice_id, amount, mode, reference_number, remarks, payment_date } = req.body;
  if (!invoice_id || !amount || !mode) {
    return res.status(400).json({ error: "Invoice, amount, and payment mode are required." });
  }
  const { rows } = await query(
    `INSERT INTO payments (invoice_id, payment_date, amount, mode, reference_number, remarks, entered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [invoice_id, payment_date || new Date().toISOString().slice(0, 10), amount, mode, reference_number, remarks, req.user.id]
  );
  res.status(201).json(rows[0]);
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
