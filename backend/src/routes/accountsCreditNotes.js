// Round 252 — credit notes (owner, 30 Oct 2026).
//   "Reasons: concrete return/rejection and rate corrections, discounts etc."
//   "when a qty is rejected/returned … mark it and alert for creating credit
//    note to accounts, once credit note is issued and approved by admin, then
//    adjust the ledger." · "use app's own series" · "allow more than one
//    credit note per invoice" · "all credit note is app only format".
//
// Accounts raises a credit note against one invoice (number given then, app
// series CN/26-27/00001 per April–March year). It waits for the Administrator,
// who approves or rejects it. Only an APPROVED note counts — in the customer's
// balance (lib/receivables.js), statement, GST working and the month's sales.
//
//   GET  /api/accounts/credit-notes                 returns to credit + the notes
//   GET  /api/accounts/credit-notes/invoices?q=     invoices a note can be raised against
//   POST /api/accounts/credit-notes                 raise           accounts.credit-notes · create
//   POST /api/accounts/credit-notes/:id/approve     approve         accounts.credit-note-approve · edit
//   POST /api/accounts/credit-notes/:id/reject      reject          accounts.credit-note-approve · edit
//   POST /api/accounts/credit-notes/:id/cancel      cancel          the raiser (pending) or an approver
//   GET  /api/accounts/credit-notes/:id             one note, for the print
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { istDay } from "../lib/istDate.js";
import { ensureRound252 } from "../lib/round252Schema.js";
import { applyAdvances } from "../lib/receivables.js";
import { pushToRole } from "../lib/push.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound252(query); next(); } catch (e) { next(e); } });

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const REASONS = { return: "Concrete returned / rejected at site", rate: "Rate correction", discount: "Discount", other: "Other" };
const VIEW = requirePermission("accounts.credit-notes", "view");
const CREATE = requirePermission("accounts.credit-notes", "create");
const APPROVE = requirePermission("accounts.credit-note-approve", "edit");

function fyOf(ymd) {
  const [y, m] = ymd.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}
// GST inside a GST-inclusive amount, split CGST / SGST (as the invoice does).
function split(total, gstApplied) {
  const t = r2(total);
  if (!gstApplied) return { base: t, cgst: 0, sgst: 0 };
  const base = r2((t * 100) / 118);
  const gst = r2(t - base);
  const cgst = r2(gst / 2);
  return { base, cgst, sgst: r2(gst - cgst) };
}

const NOTE_COLS = `cn.id, cn.cn_no, cn.cn_date::text AS cn_date, cn.reason, cn.qty_m3, cn.rate_incl, cn.total_amount, cn.gst_applied,
  cn.base_amount, cn.cgst, cn.sgst, cn.note, cn.status, cn.raised_at, ru.name AS raised_by, cn.raised_by AS raised_by_id,
  cn.decided_at, du.name AS decided_by, cn.decision_note, cn.invoice_id, cn.customer_id,
  COALESCE(i.billing_name, c.name) AS customer_name, i.billing_address, i.billing_gstin, c.billing_address AS customer_address,
  dt.ticket_number, dt.ticket_date::text AS ticket_date, s.name AS site_name, m.name AS grade_name, i.total_amount AS invoice_total,
  i.rate_per_m3, i.tally_invoice_no`;
const NOTE_FROM = `FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN customers c ON c.id = cn.customer_id
  JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customer_orders co ON co.id = dt.order_id
  LEFT JOIN sites s ON s.id = co.site_id LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
  LEFT JOIN users ru ON ru.id = cn.raised_by LEFT JOIN users du ON du.id = cn.decided_by`;

// What is still creditable on an invoice: its total less every pending or approved note.
async function creditable(db, invoiceId, exceptId = null) {
  const { rows } = await db.query(
    `SELECT i.total_amount - COALESCE((SELECT SUM(total_amount) FROM credit_notes WHERE invoice_id = i.id AND status IN ('pending','approved')
              AND ($2::int IS NULL OR id <> $2)), 0) AS left FROM invoices i WHERE i.id = $1`, [invoiceId, exceptId]);
  return rows[0] ? r2(rows[0].left) : null;
}

// ------------------------------------------------------------------ list --
router.get("/credit-notes", VIEW, async (req, res) => {
  try {
    const [{ rows: toCredit }, { rows: notes }] = await Promise.all([
      // Loads returned at site from Oct 2026 with no return note raised yet.
      query(`SELECT i.id AS invoice_id, dt.ticket_number, dt.ticket_date::text AS ticket_date, COALESCE(i.billing_name, c.name) AS customer_name,
                    s.name AS site_name, m.name AS grade_name, dt.loaded_quantity_m3 AS loaded_m3, sq.rejected_quantity_m3 AS returned_m3,
                    rr.reason AS return_reason, i.rate_per_m3, i.gst_applied,
                    ROUND(sq.rejected_quantity_m3 * COALESCE(i.rate_per_m3, i.concrete_amount / NULLIF(dt.loaded_quantity_m3, 0)), 2) AS value
               FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customer_orders co ON co.id = dt.order_id
               JOIN customers c ON c.id = i.customer_id LEFT JOIN sites s ON s.id = co.site_id LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
               JOIN site_qc sq ON sq.ticket_id = dt.id LEFT JOIN rejection_reasons rr ON rr.id = sq.rejection_reason_id
              WHERE i.return_credit_due AND COALESCE(sq.rejected_quantity_m3, 0) > 0
                AND NOT EXISTS (SELECT 1 FROM credit_notes x WHERE x.invoice_id = i.id AND x.reason = 'return' AND x.status IN ('pending','approved'))
              ORDER BY dt.ticket_date, dt.id`).catch(() => query(
        // rejection_reasons may be named differently on an older database
        `SELECT i.id AS invoice_id, dt.ticket_number, dt.ticket_date::text AS ticket_date, COALESCE(i.billing_name, c.name) AS customer_name,
                s.name AS site_name, m.name AS grade_name, dt.loaded_quantity_m3 AS loaded_m3, sq.rejected_quantity_m3 AS returned_m3,
                NULL AS return_reason, i.rate_per_m3, i.gst_applied,
                ROUND(sq.rejected_quantity_m3 * COALESCE(i.rate_per_m3, i.concrete_amount / NULLIF(dt.loaded_quantity_m3, 0)), 2) AS value
           FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customer_orders co ON co.id = dt.order_id
           JOIN customers c ON c.id = i.customer_id LEFT JOIN sites s ON s.id = co.site_id LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
           JOIN site_qc sq ON sq.ticket_id = dt.id
          WHERE i.return_credit_due AND COALESCE(sq.rejected_quantity_m3, 0) > 0
            AND NOT EXISTS (SELECT 1 FROM credit_notes x WHERE x.invoice_id = i.id AND x.reason = 'return' AND x.status IN ('pending','approved'))
          ORDER BY dt.ticket_date, dt.id`)),
      query(`SELECT ${NOTE_COLS} ${NOTE_FROM} ORDER BY (cn.status = 'pending') DESC, cn.id DESC LIMIT 500`),
    ]);
    res.json({ to_credit: toCredit, notes, reasons: REASONS, me: req.user.id, can_approve: await can(req.user, "accounts.credit-note-approve", "edit") });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the credit notes." });
  }
});

// Invoices a note can be raised against (search by delivery note or customer).
router.get("/credit-notes/invoices", VIEW, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const id = Number(req.query.invoice_id) || null;
  const { rows } = await query(
    `SELECT i.id, dt.ticket_number, dt.ticket_date::text AS ticket_date, COALESCE(i.billing_name, c.name) AS customer_name, s.name AS site_name,
            m.name AS grade_name, dt.loaded_quantity_m3, i.rate_per_m3, i.total_amount, i.gst_applied,
            COALESCE(sq.rejected_quantity_m3, 0) AS returned_m3,
            i.total_amount - COALESCE((SELECT SUM(total_amount) FROM credit_notes x WHERE x.invoice_id = i.id AND x.status IN ('pending','approved')), 0) AS creditable
       FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = i.customer_id LEFT JOIN sites s ON s.id = co.site_id LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
       LEFT JOIN site_qc sq ON sq.ticket_id = dt.id
      WHERE ($1::int IS NOT NULL AND i.id = $1) OR ($1::int IS NULL AND $2 <> '' AND (dt.ticket_number ILIKE $3 OR c.name ILIKE $3 OR i.billing_name ILIKE $3))
      ORDER BY dt.ticket_date DESC, i.id DESC LIMIT 30`, [id, q, `%${q}%`]);
  res.json(rows.map((r) => ({ ...r, creditable: r2(r.creditable) })));
});

// ----------------------------------------------------------------- raise --
router.post("/credit-notes", CREATE, async (req, res) => {
  const b = req.body || {};
  const invoiceId = Number(b.invoice_id);
  if (!REASONS[b.reason]) return bad(res, "Choose the reason.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: inv } = await client.query(
      `SELECT i.id, i.customer_id, i.gst_applied, i.rate_per_m3, i.concrete_amount, dt.loaded_quantity_m3, dt.ticket_number
         FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id WHERE i.id = $1 FOR UPDATE OF i`, [invoiceId]);
    if (!inv.length) { await client.query("ROLLBACK"); return bad(res, "Choose the invoice (delivery note) this credit note is against."); }
    const i = inv[0];
    let qty = null, rate = null, total;
    if (b.reason === "return") {
      qty = r2(b.qty_m3);
      rate = r2(b.rate_incl || i.rate_per_m3 || (Number(i.loaded_quantity_m3) ? Number(i.concrete_amount) / Number(i.loaded_quantity_m3) : 0));
      if (!(qty > 0)) { await client.query("ROLLBACK"); return bad(res, "Enter the quantity returned (m³)."); }
      if (qty > Number(i.loaded_quantity_m3) + 0.001) { await client.query("ROLLBACK"); return bad(res, `More than the ${i.loaded_quantity_m3} m³ delivered on ${i.ticket_number}.`); }
      if (!(rate > 0)) { await client.query("ROLLBACK"); return bad(res, "Enter the rate (₹/m³, with GST)."); }
      total = r2(qty * rate);
    } else {
      total = r2(b.amount);
      if (!(total > 0)) { await client.query("ROLLBACK"); return bad(res, "Enter the amount of the credit (₹, with GST)."); }
    }
    const left = await creditable(client, i.id);
    if (total > left + 0.005) { await client.query("ROLLBACK"); return bad(res, `Only ₹${left.toLocaleString("en-IN")} of ${i.ticket_number} is left to credit (other credit notes take the rest).`); }
    const { base, cgst, sgst } = split(total, i.gst_applied);
    const day = istDay();
    const fy = fyOf(day);
    await client.query(`SELECT pg_advisory_xact_lock(252001)`);   // one number at a time
    const { rows: n } = await client.query(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM credit_notes WHERE fy = $1`, [fy]);
    const seq = n[0].n;
    const cnNo = `CN/${fy}/${String(seq).padStart(5, "0")}`;
    const { rows } = await client.query(
      `INSERT INTO credit_notes (cn_no, fy, seq, invoice_id, customer_id, cn_date, reason, qty_m3, rate_incl, total_amount, gst_applied,
                                 base_amount, cgst, sgst, note, raised_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, cn_no`,
      [cnNo, fy, seq, i.id, i.customer_id, day, b.reason, qty, rate, total, i.gst_applied, base, cgst, sgst,
       String(b.note || "").trim().slice(0, 500) || null, req.user.id]);
    await client.query("COMMIT");
    const msg = `Credit note ${cnNo} (${REASONS[b.reason]}) on ${i.ticket_number} — ₹${total.toLocaleString("en-IN")} — waiting for your approval`;
    await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ('administrator', 'credit_note_approval', $1)`, [msg]).catch(() => {});
    await pushToRole("administrator", { title: "Credit note to approve", body: msg, url: "/accounts?tab=credit-notes" }).catch(() => {});
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not raise the credit note." });
  } finally { client.release(); }
});

// --------------------------------------------------------------- approve --
// The note counts from now. If the invoice had already been paid past what
// is left of it, the excess is taken back off the receipt that paid it and
// becomes the customer's advance (set against their other dues).
router.post("/credit-notes/:id(\\d+)/approve", APPROVE, async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM credit_notes WHERE id = $1 FOR UPDATE`, [id]);
    const cn = rows[0];
    if (!cn) { await client.query("ROLLBACK"); return bad(res, "Credit note not found.", 404); }
    if (cn.status !== "pending") { await client.query("ROLLBACK"); return bad(res, `This credit note is already ${cn.status}.`, 409); }
    await client.query(
      `UPDATE credit_notes SET status = 'approved', decided_by = $2, decided_at = now(), cn_date = $3, decision_note = $4 WHERE id = $1`,
      [id, req.user.id, istDay(), String(req.body?.note || "").trim().slice(0, 300) || null]);
    // Paid past what the invoice now comes to?
    const { rows: st } = await client.query(
      `SELECT i.total_amount - COALESCE((SELECT SUM(total_amount) FROM credit_notes WHERE invoice_id = i.id AND status = 'approved'), 0) AS net,
              COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS paid FROM invoices i WHERE i.id = $1`, [cn.invoice_id]);
    let excess = r2(Number(st[0].paid) - Math.max(0, Number(st[0].net)));
    if (excess > 0.004) {
      const { rows: pays } = await client.query(
        `SELECT id, amount FROM payments WHERE invoice_id = $1 AND receipt_id IS NOT NULL ORDER BY payment_date DESC, id DESC`, [cn.invoice_id]);
      for (const p of pays) {
        if (excess <= 0.004) break;
        const cut = r2(Math.min(excess, Number(p.amount)));
        if (cut >= Number(p.amount) - 0.004) await client.query(`DELETE FROM payments WHERE id = $1`, [p.id]);
        else await client.query(`UPDATE payments SET amount = amount - $2 WHERE id = $1`, [p.id, cut]);
        excess = r2(excess - cut);
      }
      await applyAdvances(client, cn.customer_id);
    }
    if (cn.reason === "return") await client.query(`UPDATE invoices SET return_credit_due = false WHERE id = $1`, [cn.invoice_id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not approve the credit note." });
  } finally { client.release(); }
});

router.post("/credit-notes/:id(\\d+)/reject", APPROVE, async (req, res) => {
  const note = String(req.body?.note || "").trim().slice(0, 300);
  if (!note) return bad(res, "Say why it is rejected.");
  const { rowCount } = await query(
    `UPDATE credit_notes SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 AND status = 'pending'`,
    [req.params.id, req.user.id, note]);
  if (!rowCount) return bad(res, "Only a credit note waiting for approval can be rejected.", 409);
  res.json({ ok: true });
});

// Cancel: the raiser while it waits; an approver at any time (an approved
// note then stops counting — the customer's balance goes back up).
router.post("/credit-notes/:id(\\d+)/cancel", VIEW, async (req, res) => {
  const { rows } = await query(`SELECT status, raised_by, customer_id FROM credit_notes WHERE id = $1`, [req.params.id]);
  const cn = rows[0];
  if (!cn) return bad(res, "Credit note not found.", 404);
  const approver = await can(req.user, "accounts.credit-note-approve", "edit");
  if (!["pending", "approved"].includes(cn.status)) return bad(res, `This credit note is already ${cn.status}.`, 409);
  if (cn.status === "approved" && !approver) return bad(res, "Only the Administrator can cancel an approved credit note.", 403);
  if (cn.status === "pending" && !approver && cn.raised_by !== req.user.id) return bad(res, "Only whoever raised it, or the Administrator, can cancel it.", 403);
  const note = String(req.body?.note || "").trim().slice(0, 300) || "Cancelled";
  await query(`UPDATE credit_notes SET status = 'cancelled', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [req.params.id, req.user.id, note]);
  // The invoice is due again in full: any advance the customer holds pays it.
  if (cn.status === "approved") await applyAdvances({ query }, cn.customer_id).catch((e) => console.error("cn cancel advances", e.message));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ one --
router.get("/credit-notes/:id(\\d+)", VIEW, async (req, res) => {
  const { rows } = await query(
    `SELECT ${NOTE_COLS}, COALESCE((SELECT SUM(x.total_amount) FROM credit_notes x WHERE x.invoice_id = cn.invoice_id AND x.status = 'approved' AND x.id <> cn.id), 0) AS other_credits
     ${NOTE_FROM} WHERE cn.id = $1`, [req.params.id]);
  if (!rows.length) return bad(res, "Credit note not found.", 404);
  res.json({ ...rows[0], reason_label: REASONS[rows[0].reason] });
});

export default router;
