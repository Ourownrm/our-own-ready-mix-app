// Round 255 (v10.87) — owner, 31 Oct 2026; mock-up "CA Tax Desk Mockup"
// (claude/ca-tax-desk-mockup-v1.md, v3 — agreed).
//
//   * Accounts → Invoices: an invoice can be marked "Cash" (collected in cash
//     through C Ledger). A marked invoice becomes a C Ledger delivery entry —
//     its delivery note, m³ and amount — and only what is marked goes in, so
//     40 of an order's 100 m³ shows as 40 m³. The invoice itself is untouched:
//     GST stays on it; it stays in the customer ledger, the GST working and
//     the CA's sales sheet. C Ledger no longer sets the sale value of these
//     loads (the invoice does), so lib/cLedger.js clTicketSales leaves them out.
//     Hand-made C Ledger records from before stay exactly as they were (owner).
//   * Customer ledger → Record a receipt: every mode again (cash, bank
//     transfer, UPI, cheque), and "Send to C Ledger" on any receipt. Cash goes
//     to a cash holder's wallet as a collection to accept; any other mode is a
//     "Paid to bank" line. Each line carries the receipt it came from
//     (cl_collections.receipt_id), so cancelling the receipt takes it out.
//   * The C Ledger expense flag now means what the purchase-bill flag means:
//     FLAGGED = the bill has no tax → the full amount is the cost, no input
//     credit; NOT flagged = tax inside → cost is the amount less tax. Existing
//     flags are turned over once (owner: "Yes you are right"). Petty cash
//     vouchers use the C Ledger rule, so they are turned over with it.
//   * Accounts → Send to CA (routes/accountsCa.js): last month's data in nine
//     Excel sheets, due by the 5th.
import { pool, query } from "../db.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const ROUND255_SQL = `
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cl_cash BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cl_cash_by INTEGER REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cl_cash_at TIMESTAMPTZ;
-- No foreign key on purpose: a fully rejected load still deletes its invoice
-- (lib/deliveryConfirmation.js); the C Ledger entry then shows "invoice gone".
ALTER TABLE cl_deliveries ADD COLUMN IF NOT EXISTS invoice_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_deliveries_invoice ON cl_deliveries(invoice_id) WHERE deleted_at IS NULL AND invoice_id IS NOT NULL;
-- A record made by a receipt for money not set against an invoice
-- (an opening balance or an advance): a collection only, never a sale.
ALTER TABLE cl_deliveries ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES customer_receipts(id);
ALTER TABLE cl_collections ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES customer_receipts(id);
CREATE INDEX IF NOT EXISTS idx_cl_collections_receipt ON cl_collections(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS app_migration_marks (mark VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Send to CA: the CA's ledger name for each app head, and each month sent.
CREATE TABLE IF NOT EXISTS ca_head_names (
  head_key    VARCHAR(40) PRIMARY KEY,
  ledger_name VARCHAR(120) NOT NULL,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ca_sends (
  id          SERIAL PRIMARY KEY,
  month       CHAR(7) NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by     INTEGER REFERENCES users(id),
  note        VARCHAR(300),
  -- every row sent: { "<sheet>|<row key>": "<fingerprint>" }
  fingerprints JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_ca_sends_month ON ca_sends(month, sent_at DESC);
`;

// The flag is turned over once, in one transaction, before anything reads it
// with its new meaning: whoever writes the mark first does the flip.
async function flipFlagsOnce(db) {
  const client = await db.connect();
  const c = client;
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(
      `INSERT INTO app_migration_marks (mark) VALUES ('r255_flag_means_no_tax') ON CONFLICT DO NOTHING RETURNING mark`);
    let n = { cl: 0, pc: 0 };
    if (rows.length) {
      const a = await c.query(`UPDATE cl_expenses SET flagged = NOT flagged`);
      const b = await c.query(`UPDATE pc_vouchers SET flagged = NOT flagged WHERE kind <> 'advance'`).catch(() => ({ rowCount: 0 }));
      n = { cl: a.rowCount, pc: b.rowCount };
    }
    await c.query("COMMIT");
    return rows.length ? n : null;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

let ready = null;
export function ensureRound255() {
  if (!ready) {
    ready = (async () => {
      await query(ROUND255_SQL);
      await flipFlagsOnce(pool);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
export async function migrateRound255(pool, log) {
  await pool.query(ROUND255_SQL);
  const n = await flipFlagsOnce(pool);
  log?.push?.(`Round 255: invoices marked "Cash" go to C Ledger; receipts can be sent to C Ledger; Send to CA.${n ? ` C Ledger / petty cash flag turned to "no tax" (${n.cl} expense${n.cl === 1 ? "" : "s"}, ${n.pc} voucher${n.pc === 1 ? "" : "s"}).` : ""}`);
}

// ---------------------------------------------------- invoice → C Ledger ---
// What a C Ledger entry made from an invoice holds, read from the invoice.
const INVOICE_ROW_SQL = `
  SELECT i.id, i.ticket_id, i.customer_id, i.total_amount, i.rate_per_m3, i.concrete_amount,
         COALESCE(i.pumping_charge, 0) + COALESCE(i.part_load_charge, 0) + COALESCE(i.waiting_charge, 0) AS charges,
         COALESCE(i.rejected_quantity_m3, 0) AS rejected, i.gst_applied, i.cl_cash, i.billing_name,
         dt.ticket_number, dt.ticket_date::text AS ticket_date, dt.loaded_quantity_m3 AS loaded,
         co.id AS order_id, co.site_id, c.name AS customer_name, s.name AS site_name, g.name AS grade
    FROM invoices i
    JOIN delivery_tickets dt ON dt.id = i.ticket_id
    JOIN customer_orders co ON co.id = dt.order_id
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN sites s ON s.id = co.site_id
    LEFT JOIN mix_grades g ON g.id = co.mix_grade_id`;

export function entryFromInvoice(inv) {
  const total = r2(inv.total_amount);
  const qty = r2(Math.max(0, n0(inv.loaded) - n0(inv.rejected)));
  let rate = r2(inv.rate_per_m3);
  let other = r2(total - r2(qty * rate));
  if (other < 0) { other = r2(Math.min(total, n0(inv.charges))); rate = qty > 0 ? r2((total - other) / qty) : 0; }
  if (qty <= 0) { rate = 0; other = total; }
  return {
    entry_date: inv.ticket_date, customer_name: String(inv.billing_name || inv.customer_name).slice(0, 200),
    location: inv.site_name ? String(inv.site_name).slice(0, 200) : null, customer_id: inv.customer_id, site_id: inv.site_id,
    grade: inv.grade ? String(inv.grade).slice(0, 20) : null, qty_m3: qty, rate, other_charges: Math.max(0, other),
  };
}

// Mark (on) or unmark (off) invoices "Cash". Returns { done, refused[] }.
export async function setInvoicesCash(c, ids, on, userId) {
  const done = [], refused = [];
  const { rows } = await c.query(`${INVOICE_ROW_SQL} WHERE i.id = ANY($1::int[]) FOR UPDATE OF i`, [ids]);
  for (const inv of rows) {
    const res = on ? await markOne(c, inv, userId) : await unmarkOne(c, inv, userId);
    if (res) refused.push({ id: inv.id, ticket_number: inv.ticket_number, reason: res }); else done.push(inv.id);
  }
  return { done, refused };
}

async function markOne(c, inv, userId) {
  const { rows: live } = await c.query(`SELECT id FROM cl_deliveries WHERE invoice_id = $1 AND deleted_at IS NULL`, [inv.id]);
  if (live.length) {
    if (!inv.cl_cash) await c.query(`UPDATE invoices SET cl_cash = true, cl_cash_by = $2, cl_cash_at = now() WHERE id = $1`, [inv.id, userId]);
    return null;
  }
  // A hand-made C Ledger record may already hold this delivery note.
  const { rows: held } = await c.query(
    `SELECT d.id, d.entry_date::text AS d FROM cl_delivery_tickets l JOIN cl_deliveries d ON d.id = l.delivery_id AND d.deleted_at IS NULL WHERE l.ticket_id = $1`, [inv.ticket_id]);
  if (held.length) return `already on a C Ledger record entered by hand (${held[0].d}) — change that record in C Ledger instead`;
  const e = entryFromInvoice(inv);
  const { rows } = await c.query(
    `INSERT INTO cl_deliveries (entry_date, customer_name, location, customer_id, site_id, grade, qty_m3, rate, other_charges, flagged, note, created_by, invoice_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12) RETURNING id`,
    [e.entry_date, e.customer_name, e.location, e.customer_id, e.site_id, e.grade, e.qty_m3, e.rate, e.other_charges,
      `Invoice of ${inv.ticket_number}`, userId, inv.id]);
  await c.query(`DELETE FROM cl_delivery_tickets WHERE ticket_id = $1`, [inv.ticket_id]);
  await c.query(`INSERT INTO cl_delivery_tickets (delivery_id, ticket_id) VALUES ($1, $2)`, [rows[0].id, inv.ticket_id]);
  await c.query(`UPDATE invoices SET cl_cash = true, cl_cash_by = $2, cl_cash_at = now() WHERE id = $1`, [inv.id, userId]);
  await c.query(`INSERT INTO cl_log (kind, ref_id, action, detail, done_by) VALUES ('delivery', $1, 'from invoice', $2, $3)`,
    [rows[0].id, JSON.stringify({ invoice_id: inv.id, ticket: inv.ticket_number, ...e }), userId]);
  return null;
}

async function unmarkOne(c, inv, userId) {
  const { rows } = await c.query(`SELECT id FROM cl_deliveries WHERE invoice_id = $1 AND deleted_at IS NULL FOR UPDATE`, [inv.id]);
  if (rows.length) {
    const id = rows[0].id;
    const { rows: col } = await c.query(`SELECT COUNT(*)::int AS n FROM cl_collections WHERE delivery_id = $1 AND status <> 'rejected'`, [id]);
    if (col[0].n) return "money is already collected against it in C Ledger";
    await c.query(`UPDATE cl_deliveries SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, userId]);
    await c.query(`DELETE FROM cl_collections WHERE delivery_id = $1`, [id]);
    await c.query(`DELETE FROM cl_delivery_tickets WHERE delivery_id = $1`, [id]);
    await c.query(`INSERT INTO cl_log (kind, ref_id, action, detail, done_by) VALUES ('delivery', $1, 'unmarked', $2, $3)`,
      [id, JSON.stringify({ invoice_id: inv.id }), userId]);
  }
  await c.query(`UPDATE invoices SET cl_cash = false, cl_cash_by = $2, cl_cash_at = now() WHERE id = $1`, [inv.id, userId]);
  return null;
}

// Keeps the C Ledger entries made from invoices in step with their invoice
// (a quantity correction or a credit to the invoice changes it). Cheap: only
// rows that actually differ are written.
export async function refreshInvoiceEntries() {
  await ensureRound255();
  const { rows } = await query(
    `${INVOICE_ROW_SQL}
      JOIN cl_deliveries d ON d.invoice_id = i.id AND d.deleted_at IS NULL`).catch(() => ({ rows: [] }));
  const { rows: cur } = await query(
    `SELECT id, invoice_id, entry_date::text AS entry_date, customer_name, location, grade, qty_m3, rate, other_charges
       FROM cl_deliveries WHERE invoice_id IS NOT NULL AND deleted_at IS NULL`).catch(() => ({ rows: [] }));
  const byInv = new Map(rows.map((r) => [r.id, r]));
  for (const d of cur) {
    const inv = byInv.get(d.invoice_id);
    if (!inv) continue; // invoice gone — kept, shown in the cross-check
    const e = entryFromInvoice(inv);
    if (d.entry_date === e.entry_date && d.customer_name === e.customer_name && (d.location || null) === e.location && (d.grade || null) === e.grade
      && r2(d.qty_m3) === e.qty_m3 && r2(d.rate) === e.rate && r2(d.other_charges) === e.other_charges) continue;
    await query(
      `UPDATE cl_deliveries SET entry_date = $2, customer_name = $3, location = $4, grade = $5, qty_m3 = $6, rate = $7, other_charges = $8, updated_at = now() WHERE id = $1`,
      [d.id, e.entry_date, e.customer_name, e.location, e.grade, e.qty_m3, e.rate, e.other_charges]);
  }
}

// ---------------------------------------------------- receipt → C Ledger ---
// target: { holder_id } (cash only) or { bank: true }.
export async function sendReceiptToCl(c, receiptId, target, userId) {
  await ensureRound255();
  const { rows: rr } = await c.query(
    `SELECT r.*, r.receipt_date::text AS day, r.mode::text AS mode_t, cu.name AS customer_name
       FROM customer_receipts r JOIN customers cu ON cu.id = r.customer_id WHERE r.id = $1 AND r.cancelled_at IS NULL FOR UPDATE OF r`, [receiptId]);
  const r = rr[0];
  if (!r) throw fail("That receipt is not there (or was cancelled).", 404);
  const { rows: already } = await c.query(`SELECT COUNT(*)::int AS n FROM cl_collections WHERE receipt_id = $1`, [receiptId]);
  if (already[0].n) throw fail("This receipt is already in C Ledger.", 409);
  const bank = !!target?.bank || r.mode_t !== "cash";
  let holder = null;
  if (!bank) {
    holder = Number(target?.holder_id);
    const { rows: h } = await c.query(
      `SELECT 1 FROM cl_access a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND a.is_cash_holder AND u.is_active`, [holder]);
    if (!h.length) throw fail("Choose the cash holder who has the cash.");
  }
  const line = async (deliveryId, amount) => {
    await c.query(
      `INSERT INTO cl_collections (delivery_id, amount, holder_id, mode, paid_on, status, responded_at, receipt_id)
       VALUES ($1, $2, $3, $4, $5, $6::varchar, CASE WHEN $6::varchar = 'accepted' THEN now() END, $7)`,
      [deliveryId, r2(amount), bank ? null : holder, bank ? "bank" : "cash", bank ? r.day : null, bank ? "accepted" : "pending", receiptId]);
  };
  // What the receipt paid: invoices (marked "Cash" if not yet), then the rest.
  const { rows: alloc } = await c.query(
    `SELECT p.invoice_id, SUM(p.amount) AS amount FROM payments p WHERE p.receipt_id = $1 AND p.invoice_id IS NOT NULL GROUP BY p.invoice_id ORDER BY p.invoice_id`, [receiptId]);
  let toInvoices = 0;
  for (const a of alloc) {
    const { refused } = await setInvoicesCash(c, [a.invoice_id], true, userId);
    if (refused.length) throw fail(`${refused[0].ticket_number}: ${refused[0].reason}.`, 409);
    const { rows: d } = await c.query(
      `SELECT d.id, d.qty_m3, d.rate, d.other_charges,
              (SELECT COALESCE(SUM(amount), 0) FROM cl_collections WHERE delivery_id = d.id AND status <> 'rejected') AS got
         FROM cl_deliveries d WHERE d.invoice_id = $1 AND d.deleted_at IS NULL`, [a.invoice_id]);
    const total = r2(n0(d[0].qty_m3) * n0(d[0].rate) + n0(d[0].other_charges));
    const room = r2(total - n0(d[0].got));
    const amt = r2(Math.min(n0(a.amount), Math.max(0, room)));
    if (amt > 0) await line(d[0].id, amt);
    toInvoices = r2(toInvoices + amt);
  }
  const rest = r2(n0(r.amount) - toInvoices);
  if (rest > 0.009) {
    const { rows: rec } = await c.query(
      `INSERT INTO cl_deliveries (entry_date, customer_name, customer_id, qty_m3, rate, other_charges, flagged, note, created_by, receipt_id)
       VALUES ($1, $2, $3, 0, 0, $4, false, $5, $6, $7) RETURNING id`,
      [r.day, String(r.customer_name).slice(0, 200), r.customer_id, rest, `Receipt #${receiptId} — not against an invoice (opening balance / advance)`, userId, receiptId]);
    await line(rec[0].id, rest);
  }
  await c.query(`INSERT INTO cl_log (kind, ref_id, action, detail, done_by) VALUES ('receipt', $1, 'sent to C Ledger', $2, $3)`,
    [receiptId, JSON.stringify({ bank, holder, amount: n0(r.amount), to_invoices: toInvoices, rest: Math.max(0, rest) }), userId]);
  return { bank, holder, to_invoices: toInvoices, rest: Math.max(0, rest) };
}

// The receipt's lines in C Ledger: { bank, holder_id, accepted } or null.
export async function receiptClState(c, receiptId) {
  const { rows } = await c.query(
    `SELECT holder_id, status, amount FROM cl_collections WHERE receipt_id = $1`, [receiptId]).catch(() => ({ rows: [] }));
  if (!rows.length) return null;
  return { bank: rows.every((x) => x.holder_id == null), holder_id: rows.find((x) => x.holder_id != null)?.holder_id || null,
    accepted: rows.some((x) => x.holder_id != null && x.status === "accepted") };
}

// Takes the receipt out of C Ledger. Cash a holder has already accepted is in
// their wallet — refused unless `force` (a bank line undone at its source).
export async function removeReceiptCl(c, receiptId, { force = false, userId = null } = {}) {
  const { rows } = await c.query(
    `SELECT c.id, c.delivery_id, c.amount, c.status, c.holder_id, COALESCE(a.short_name, u.name) AS holder
       FROM cl_collections c LEFT JOIN users u ON u.id = c.holder_id LEFT JOIN cl_access a ON a.user_id = c.holder_id
      WHERE c.receipt_id = $1 FOR UPDATE OF c`, [receiptId]).catch(() => ({ rows: [] }));
  if (!rows.length) return 0;
  const taken = rows.filter((x) => x.holder_id != null && x.status === "accepted");
  if (taken.length && !force) {
    throw fail(`${taken[0].holder} has already accepted ₹${r2(taken.reduce((t, x) => t + n0(x.amount), 0)).toLocaleString("en-IN")} of this receipt in C Ledger. `
      + "It is in their cash: they have to hand it back (a transfer) before this can change.", 409);
  }
  await c.query(`DELETE FROM cl_collections WHERE receipt_id = $1`, [receiptId]);
  await c.query(
    `UPDATE cl_deliveries SET deleted_at = now(), deleted_by = $2
      WHERE receipt_id = $1 AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM cl_collections x WHERE x.delivery_id = cl_deliveries.id)`,
    [receiptId, userId]);
  await c.query(`INSERT INTO cl_log (kind, ref_id, action, detail, done_by) VALUES ('receipt', $1, 'taken out of C Ledger', $2, $3)`,
    [receiptId, JSON.stringify({ lines: rows.length, force }), userId]);
  return rows.length;
}

// -------------------------------------------------------- cross-check ---
// Accounts against C Ledger for a month. A row that doesn't match stops
// nothing — it is there to be explained.
export async function clCrossCheck(from, end) {
  await ensureRound255();
  await refreshInvoiceEntries();
  const one = (sql, p) => query(sql, p).then((r) => r.rows[0]).catch(() => ({}));
  const [marked, entries, sent, lines, handLines, pending, gone, exp, unsent] = await Promise.all([
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(i.total_amount), 0) AS v FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
          WHERE i.cl_cash AND dt.ticket_date BETWEEN $1::date AND $2::date`, [from, end]),
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(d.qty_m3 * d.rate + d.other_charges), 0) AS v FROM cl_deliveries d
          WHERE d.invoice_id IS NOT NULL AND d.deleted_at IS NULL AND d.entry_date BETWEEN $1::date AND $2::date`, [from, end]),
    one(`SELECT COUNT(DISTINCT r.id)::int AS n, COALESCE(SUM(r.amount), 0) AS v FROM customer_receipts r
          WHERE r.cancelled_at IS NULL AND r.receipt_date BETWEEN $1::date AND $2::date
            AND EXISTS (SELECT 1 FROM cl_collections c WHERE c.receipt_id = r.id)`, [from, end]),
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(c.amount), 0) AS v FROM cl_collections c JOIN customer_receipts r ON r.id = c.receipt_id
          WHERE c.status <> 'rejected' AND r.receipt_date BETWEEN $1::date AND $2::date`, [from, end]),
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(c.amount), 0) AS v FROM cl_collections c JOIN cl_deliveries d ON d.id = c.delivery_id
          WHERE c.receipt_id IS NULL AND c.status <> 'rejected' AND d.invoice_id IS NOT NULL AND d.deleted_at IS NULL
            AND d.entry_date BETWEEN $1::date AND $2::date`, [from, end]),
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(c.amount), 0) AS v FROM cl_collections c JOIN cl_deliveries d ON d.id = c.delivery_id
          WHERE c.status = 'pending' AND d.deleted_at IS NULL`, []),
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(d.qty_m3 * d.rate + d.other_charges), 0) AS v FROM cl_deliveries d
          WHERE d.invoice_id IS NOT NULL AND d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = d.invoice_id)`, []),
    query(`SELECT x.flagged, COUNT(*)::int AS n, COALESCE(SUM(x.amount), 0) AS v FROM cl_expenses x
            WHERE x.deleted_at IS NULL AND x.txn_date BETWEEN $1::date AND $2::date GROUP BY x.flagged`, [from, end]).then((r) => r.rows).catch(() => []),
    // Cash received against a marked invoice but never sent to C Ledger.
    one(`SELECT COUNT(DISTINCT r.id)::int AS n, COALESCE(SUM(p.amount), 0) AS v
           FROM payments p JOIN customer_receipts r ON r.id = p.receipt_id JOIN invoices i ON i.id = p.invoice_id
          WHERE i.cl_cash AND r.cancelled_at IS NULL AND r.receipt_date BETWEEN $1::date AND $2::date
            AND NOT EXISTS (SELECT 1 FROM cl_collections c WHERE c.receipt_id = r.id)`, [from, end]),
  ]);
  const v = (x) => r2(x?.v), n = (x) => Number(x?.n) || 0;
  const flagged = exp.find((x) => x.flagged) || { n: 0, v: 0 }, plain = exp.find((x) => !x.flagged) || { n: 0, v: 0 };
  const F = 100 / 118;
  const checks = [
    { key: "marked", label: "Invoices marked Cash = C Ledger entries made from invoices", left: v(marked), right: v(entries), left_n: n(marked), right_n: n(entries) },
    { key: "sent", label: "Receipts sent to C Ledger = their collection lines", left: v(sent), right: v(lines), left_n: n(sent), right_n: n(lines) },
    { key: "unsent", label: "Receipts against Cash invoices not sent to C Ledger", left: v(unsent), right: 0, left_n: n(unsent), right_n: 0, warn_only: true },
    { key: "hand", label: "Collections on invoice entries typed in C Ledger (no receipt in Accounts)", left: 0, right: v(handLines), left_n: 0, right_n: n(handLines), warn_only: true },
    { key: "gone", label: "C Ledger entries whose invoice was cancelled", left: 0, right: v(gone), left_n: 0, right_n: n(gone), warn_only: true },
  ].map((x) => ({ ...x, ok: Math.abs(x.left - x.right) < 0.5 }));
  return {
    checks,
    pending: { n: n(pending), amount: v(pending) },
    expenses: {
      flagged: { n: n(flagged), amount: v(flagged), cost: v(flagged) },
      not_flagged: { n: n(plain), amount: v(plain), cost: r2(v(plain) * F) },
      total: { n: n(flagged) + n(plain), amount: r2(v(flagged) + v(plain)), cost: r2(v(flagged) + v(plain) * F) },
    },
    ok: checks.every((x) => x.ok),
  };
}
