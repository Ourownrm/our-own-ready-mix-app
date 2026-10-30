// Round 251 — B2C invoice in the Tally format (owner, 30 Oct 2026): "when B2C
// invoice printing time there should be an option to print in tally format …
// the invoice number, the other details app dont have, to be typed". Only for
// invoices without a GSTIN (B2C). The number typed is checked against every
// other invoice's Tally number; a repeat is flagged and printed only when the
// person confirms.
//
//   GET  /api/accounts/invoices/:id/tally   what the printout needs + what was typed last time   accounts.invoice-print · view
//   POST /api/accounts/invoices/:id/tally   save the typed number and boxes before printing     accounts.invoice-print · edit
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { ensureRound251 } from "../lib/round251Schema.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound251(query); next(); } catch (e) { next(e); } });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const txt = (v, n) => (String(v ?? "").trim().slice(0, n));
// The Tally header boxes the app has no value for. Typed at print; blank prints blank.
export const TALLY_BOXES = ["delivery_note", "payment_terms", "reference", "other_references", "buyer_order_no", "buyer_order_date",
  "dispatch_doc_no", "delivery_note_date", "dispatched_through", "lr_no", "terms_of_delivery"];

async function invoice(id) {
  const { rows } = await query(
    `SELECT i.id, i.concrete_amount, i.pumping_charge, i.part_load_charge, i.waiting_charge, i.total_amount, i.rate_per_m3, i.gst_applied,
            i.billing_name, i.billing_address, i.billing_gstin, i.rejected_quantity_m3,
            i.tally_invoice_no, i.tally_details, i.tally_printed_at, pu.name AS tally_printed_by,
            dt.ticket_number, dt.ticket_date::text AS ticket_date, dt.loaded_quantity_m3,
            c.name AS customer_name, c.billing_address AS customer_address,
            s.name AS site_name, m.name AS grade_name, t.truck_number
       FROM invoices i
       JOIN delivery_tickets dt ON dt.id = i.ticket_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN sites s ON s.id = co.site_id
       LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
       LEFT JOIN trucks t ON t.id = dt.truck_id
       LEFT JOIN users pu ON pu.id = i.tally_printed_by
      WHERE i.id = $1`, [id]);
  return rows[0] || null;
}
const isB2c = (inv) => !String(inv.billing_gstin || "").trim();

router.get("/invoices/:id(\\d+)/tally", requirePermission("accounts.invoice-print", "view"), async (req, res) => {
  try {
    const inv = await invoice(Number(req.params.id));
    if (!inv) return res.status(404).json({ error: "Invoice not found." });
    if (!isB2c(inv)) return res.status(400).json({ error: "The Tally format is for B2C invoices only — this customer has a GSTIN." });
    const { rows: last } = await query(
      `SELECT tally_invoice_no FROM invoices WHERE tally_invoice_no IS NOT NULL AND id <> $1 ORDER BY tally_printed_at DESC NULLS LAST, id DESC LIMIT 1`,
      [inv.id]);
    res.json({ invoice: inv, last_tally_no: last[0]?.tally_invoice_no || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the invoice for printing." });
  }
});

router.post("/invoices/:id(\\d+)/tally", requirePermission("accounts.invoice-print", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const inv = await invoice(id);
    if (!inv) return res.status(404).json({ error: "Invoice not found." });
    if (!isB2c(inv)) return res.status(400).json({ error: "The Tally format is for B2C invoices only — this customer has a GSTIN." });
    const b = req.body || {};
    const no = txt(b.invoice_no, 40);
    if (!no) return res.status(400).json({ error: "Type the Tally invoice number." });
    // The owner: a number already used on another invoice is flagged.
    if (!b.force) {
      const { rows: dup } = await query(
        `SELECT i.id, dt.ticket_number, dt.ticket_date::text AS ticket_date, COALESCE(i.billing_name, c.name) AS customer
           FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customers c ON c.id = i.customer_id
          WHERE lower(i.tally_invoice_no) = lower($1) AND i.id <> $2 LIMIT 1`, [no, id]);
      if (dup[0]) {
        return res.status(409).json({
          error: `${no} is already printed on ${dup[0].ticket_number} (${dup[0].customer}, ${dup[0].ticket_date}).`,
          duplicate: dup[0],
        });
      }
    }
    const d = b.details || {};
    const details = {
      dated: ISO.test(d.dated || "") ? d.dated : inv.ticket_date,
      buyer_state: txt(d.buyer_state, 60) || "Kerala, Code : 32",
      destination: txt(d.destination, 60),
      vehicle_no: txt(d.vehicle_no, 30),
    };
    for (const k of TALLY_BOXES) details[k] = txt(d[k], 80);
    await query(`UPDATE invoices SET tally_invoice_no = $1, tally_details = $2, tally_printed_at = now(), tally_printed_by = $3 WHERE id = $4`,
      [no, JSON.stringify(details), req.user.id, id]);
    res.json({ ok: true, invoice: await invoice(id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the Tally details." });
  }
});

export default router;
