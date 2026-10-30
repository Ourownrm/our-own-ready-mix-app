// Round 205 — what customers owe, in ONE place (owner, 12 Oct 2026).
//
// Every screen — the Accountant home, Accounts → Customer ledger, the
// Outstanding Collection report and the Director / Admin dashboards — uses
// these functions, so they can never show different figures again.
//
//   billed   = invoices − approved credit notes (Round 252) + opening balances
//   received = receipts (not cancelled) + payments entered before receipts
//              existed (payments with no receipt)
//   balance  = billed − received          (negative = the customer paid ahead)
//   advance  = what receipts have not yet been set against an invoice
//
// Ageing counts from the DELIVERY date (an opening balance from its own date)
// in the owner's groups: 0–7, 8–14, 15–30 and over 30 days. An open item is
// what is still unpaid on it after the money set against it.
import { query } from "../db.js";
import { ensureRound252 } from "./round252Schema.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const AGE_GROUPS = [
  { key: "d0_7", label: "0–7 days", max: 7 },
  { key: "d8_14", label: "8–14 days", max: 14 },
  { key: "d15_30", label: "15–30 days", max: 30 },
  { key: "d30p", label: "Over 30 days", max: Infinity },
];
export const ageGroup = (days) => AGE_GROUPS.find((g) => days <= g.max).key;

// Open items of one customer: opening balances first, then invoices oldest
// delivery first — the order money is set against them.
export async function openItems(db, customerId) {
  await ensureRound252(query);
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT 'opening_balance' AS kind, ob.id, ob.as_of_date::text AS on_date, 'Opening balance' AS label,
              ob.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.opening_balance_id = ob.id), 0) AS balance, 0 AS ord
         FROM customer_opening_balances ob WHERE ob.customer_id = $1
       UNION ALL
       SELECT 'invoice', i.id, dt.ticket_date::text, dt.ticket_number,
              i.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)
                - COALESCE((SELECT SUM(cn.total_amount) FROM credit_notes cn WHERE cn.invoice_id = i.id AND cn.status = 'approved'), 0), 1
         FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id WHERE i.customer_id = $1
     ) x WHERE balance > 0.01 ORDER BY ord, on_date, id`,
    [customerId]
  );
  return rows;
}

// Sets what a receipt has not yet allocated against the oldest open items.
// Whatever is left stays on the receipt as the customer's advance.
export async function allocateReceipt(db, receiptId) {
  const { rows } = await db.query(
    `SELECT r.*, r.receipt_date::text AS receipt_day,
            r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) AS free
       FROM customer_receipts r WHERE r.id = $1 AND r.cancelled_at IS NULL`,
    [receiptId]
  );
  const r = rows[0];
  if (!r) return { applied: [], advance: 0 };
  let free = Number(r.free);
  const applied = [];
  if (free > 0.01) {
    for (const item of await openItems(db, r.customer_id)) {
      if (free <= 0.01) break;
      const amt = r2(Math.min(free, Number(item.balance)));
      const col = item.kind === "opening_balance" ? "opening_balance_id" : "invoice_id";
      await db.query(
        `INSERT INTO payments (${col}, payment_date, amount, mode, reference_number, remarks, entered_by, receipt_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [item.id, r.receipt_day, amt, r.mode, r.reference_number, `Receipt #${r.id}`, r.entered_by, r.id]
      );
      applied.push({ label: item.label, amount: amt });
      free = r2(free - amt);
    }
  }
  return { applied, advance: r2(Math.max(0, free)) };
}

// Sets every unallocated receipt of a customer against what is open — run
// when a new invoice is raised, so an advance pays it at once.
export async function applyAdvances(db, customerId) {
  const { rows } = await db.query(
    `SELECT id FROM customer_receipts r WHERE customer_id = $1 AND cancelled_at IS NULL
        AND r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) > 0.01
      ORDER BY receipt_date, id`,
    [customerId]
  );
  const applied = [];
  for (const r of rows) applied.push(...(await allocateReceipt(db, r.id)).applied);
  return applied;
}

export async function postReceipt(db, { customer_id, receipt_date, amount, mode, reference_number, bank_account, narration, remarks, bank_line_id, userId }) {
  const { rows } = await db.query(
    `INSERT INTO customer_receipts (customer_id, receipt_date, amount, mode, reference_number, bank_account, narration, remarks, bank_line_id, entered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [customer_id, receipt_date, r2(amount), mode, reference_number || null, bank_account || null, narration || null, remarks || null, bank_line_id || null, userId]
  );
  const id = rows[0].id;
  return { id, ...(await allocateReceipt(db, id)) };
}

// Totals: outstanding (billed − received), and money received in a period.
export const OUTSTANDING_SQL = `
  SELECT (SELECT COALESCE(SUM(total_amount), 0) FROM invoices)
       - (SELECT COALESCE(SUM(total_amount), 0) FROM credit_notes WHERE status = 'approved')
       + (SELECT COALESCE(SUM(amount), 0) FROM customer_opening_balances)
       - (SELECT COALESCE(SUM(amount), 0) FROM customer_receipts WHERE cancelled_at IS NULL)
       - (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE receipt_id IS NULL) AS total`;
// $1 = from (date), $2 = to (date)
export const RECEIVED_SQL = `
  SELECT (SELECT COALESCE(SUM(amount), 0) FROM customer_receipts WHERE cancelled_at IS NULL AND receipt_date BETWEEN $1::date AND $2::date)
       + (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE receipt_id IS NULL AND payment_date BETWEEN $1::date AND $2::date) AS total,
         (SELECT COUNT(*) FROM customer_receipts WHERE cancelled_at IS NULL AND receipt_date BETWEEN $1::date AND $2::date)
       + (SELECT COUNT(*) FROM payments WHERE receipt_id IS NULL AND payment_date BETWEEN $1::date AND $2::date) AS count`;

// The same with SQL date expressions in place of $1 / $2.
export const receivedSql = (fromExpr, toExpr) =>
  RECEIVED_SQL.replace(/\$1::date/g, `(${fromExpr})::date`).replace(/\$2::date/g, `(${toExpr})::date`);

// Every customer's position, with ageing. { customerId } narrows to one.
export async function positions({ customerId = null } = {}) {
  await ensureRound252(query);
  const [{ rows: base }, { rows: items }, { rows: last }, { rows: credit }] = await Promise.all([
    query(
      `WITH inv AS (SELECT customer_id, SUM(total_amount) AS amt FROM invoices GROUP BY customer_id),
            -- Round 252 — an approved credit note lowers what was billed.
            cn AS (SELECT customer_id, SUM(total_amount) AS amt FROM credit_notes WHERE status = 'approved' GROUP BY customer_id),
            ob AS (SELECT customer_id, SUM(amount) AS amt FROM customer_opening_balances GROUP BY customer_id),
            rc AS (SELECT customer_id, SUM(amount) AS amt FROM customer_receipts WHERE cancelled_at IS NULL GROUP BY customer_id),
            lp AS (SELECT COALESCE(i.customer_id, b.customer_id) AS customer_id, SUM(p.amount) AS amt
                     FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
                     LEFT JOIN customer_opening_balances b ON b.id = p.opening_balance_id
                    WHERE p.receipt_id IS NULL GROUP BY 1),
            al AS (SELECT r.customer_id, SUM(p.amount) AS amt FROM payments p JOIN customer_receipts r ON r.id = p.receipt_id
                    WHERE r.cancelled_at IS NULL GROUP BY 1)
       SELECT c.id, c.name, c.contact_number,
              COALESCE(inv.amt, 0) - COALESCE(cn.amt, 0) + COALESCE(ob.amt, 0) AS billed,
              COALESCE(rc.amt, 0) + COALESCE(lp.amt, 0) AS received,
              COALESCE(rc.amt, 0) - COALESCE(al.amt, 0) AS advance
         FROM customers c
         LEFT JOIN inv ON inv.customer_id = c.id LEFT JOIN cn ON cn.customer_id = c.id LEFT JOIN ob ON ob.customer_id = c.id
         LEFT JOIN rc ON rc.customer_id = c.id LEFT JOIN lp ON lp.customer_id = c.id LEFT JOIN al ON al.customer_id = c.id
        WHERE (inv.amt IS NOT NULL OR ob.amt IS NOT NULL OR rc.amt IS NOT NULL OR lp.amt IS NOT NULL)
          AND ($1::int IS NULL OR c.id = $1)`,
      [customerId]
    ),
    query(
      `SELECT * FROM (
         SELECT ob.customer_id, (CURRENT_DATE - ob.as_of_date) AS age,
                ob.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.opening_balance_id = ob.id), 0) AS open,
                ob.as_of_date AS on_date
           FROM customer_opening_balances ob WHERE ($1::int IS NULL OR ob.customer_id = $1)
         UNION ALL
         SELECT i.customer_id, (CURRENT_DATE - dt.ticket_date),
                i.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)
                  - COALESCE((SELECT SUM(cn.total_amount) FROM credit_notes cn WHERE cn.invoice_id = i.id AND cn.status = 'approved'), 0), dt.ticket_date
           FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id WHERE ($1::int IS NULL OR i.customer_id = $1)
       ) x WHERE open > 0.01`,
      [customerId]
    ),
    query(
      `SELECT DISTINCT ON (customer_id) customer_id, on_day, amount FROM (
         SELECT customer_id, receipt_date AS on_day, amount, id FROM customer_receipts WHERE cancelled_at IS NULL
         UNION ALL
         SELECT COALESCE(i.customer_id, b.customer_id), p.payment_date, p.amount, -p.id
           FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customer_opening_balances b ON b.id = p.opening_balance_id
          WHERE p.receipt_id IS NULL
       ) x WHERE ($1::int IS NULL OR customer_id = $1)
       ORDER BY customer_id, on_day DESC, id DESC`,
      [customerId]
    ),
    query(
      `SELECT DISTINCT ON (customer_id) customer_id, quote_no, agreement_type, payment
         FROM quotations WHERE status = 'accepted' AND agreement_type IN ('credit', 'credit_qty')
          AND ($1::int IS NULL OR customer_id = $1)
        ORDER BY customer_id, accepted_at DESC NULLS LAST, id DESC`,
      [customerId]
    ),
  ]);
  const byCust = new Map();
  for (const it of items) {
    const g = byCust.get(it.customer_id) || { d0_7: 0, d8_14: 0, d15_30: 0, d30p: 0, oldest: null, oldest_age: null };
    g[ageGroup(Number(it.age))] += Number(it.open);
    const d = typeof it.on_date === "string" ? it.on_date : it.on_date.toLocaleDateString("en-CA"); // ist-ok: DATE column, local midnight
    if (!g.oldest || d < g.oldest) { g.oldest = d; g.oldest_age = Number(it.age); }
    byCust.set(it.customer_id, g);
  }
  const lastBy = new Map(last.map((l) => [l.customer_id, l]));
  const creditBy = new Map(credit.map((c) => [c.customer_id, c]));
  return base.map((c) => {
    const g = byCust.get(c.id) || { d0_7: 0, d8_14: 0, d15_30: 0, d30p: 0, oldest: null, oldest_age: null };
    const l = lastBy.get(c.id);
    const cr = creditBy.get(c.id);
    const balance = r2(Number(c.billed) - Number(c.received));
    const limit = cr?.payment?.credit_limit != null ? Number(cr.payment.credit_limit) : null;
    return {
      id: c.id, name: c.name, contact_number: c.contact_number,
      billed: r2(c.billed), received: r2(c.received), balance, advance: r2(Math.max(0, Number(c.advance))),
      d0_7: r2(g.d0_7), d8_14: r2(g.d8_14), d15_30: r2(g.d15_30), d30p: r2(g.d30p),
      oldest_due_on: g.oldest, oldest_due_days: g.oldest_age,
      last_receipt_on: l ? (typeof l.on_day === "string" ? l.on_day : l.on_day.toLocaleDateString("en-CA")) : null, // ist-ok: DATE column
      last_receipt_amount: l ? r2(l.amount) : null,
      credit: cr ? { quote_no: cr.quote_no, limit, days: cr.payment?.credit_days ?? null, over_by: limit != null && balance > limit ? r2(balance - limit) : 0 } : null,
    };
  });
}
