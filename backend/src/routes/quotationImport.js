// Round 205 — one-time import of the quotations the owner already issued from
// Excel (Quotation_06-07-26.xlsx, sheet "Quotations List": one row per
// quotation, up to 7 grade / spec / rate / qty, rates GST-inclusive).
//
// The browser reads the file (xlsx), matches customers, sites and grades and
// shows the Administrator every row; this endpoint receives the reviewed rows.
// Per row:
//   * a quotation already in the app (same number) is skipped;
//   * a new customer / site is created when the row says so;
//   * accepted → becomes the site's price list from `rates_from` (a grade
//     quoted twice keeps both as price options); existing invoices are NOT
//     re-priced — only deliveries still held for want of a price get invoiced;
//   * sent → follow-ups, valid for the usual days from its date;
//   * lost → kept for history.
// Afterwards the next number continues after the highest serial imported.
import { upperName } from "../lib/names.js";
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { DEFAULT_TERMS, AGREEMENT_TYPES } from "../lib/quotationTerms.js";
import { applyQuotationToPriceList } from "../lib/priceList.js";
import { generateInvoiceForTicket } from "../lib/deliveryConfirmation.js";

const router = Router();
router.use(requireAuth);
const IMPORT = requirePermission("accounts.quotation-import", "edit");

const NO_RE = /^(RMC-QTN-\d{4}-\d{2}-(\d{4}))(R(\d*))?$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = new Set(AGREEMENT_TYPES.map((t) => t.key));

export function parseNumber(no) {
  const m = NO_RE.exec(String(no || "").trim().toUpperCase());
  if (!m) return null;
  // The Excel's revisions: R = 1st, R1 = 2nd, R2 = 3rd …
  const revision = m[3] === undefined ? 0 : m[4] === "" ? 1 : Number(m[4]) + 1;
  return { quote_no: m[0], family_no: m[1], serial: Number(m[2]), revision };
}

// Numbers already in the app — the screen marks those rows "already in".
router.get("/existing", IMPORT, async (req, res) => {
  const { rows } = await query(
    `SELECT q.quote_no, q.source, q.quote_date::text AS quote_date, c.name AS customer_name
       FROM quotations q JOIN customers c ON c.id = q.customer_id`);
  const { rows: s } = await query(`SELECT next_serial FROM quotation_settings WHERE id = 1`);
  // A number made in the app (not imported) that the Excel also used: the two
  // are different quotations and the screen says so.
  res.json({ quote_nos: rows.map((r) => r.quote_no), in_app: rows.filter((r) => r.source !== "import"), next_serial: s[0]?.next_serial || null });
});

router.post("/", IMPORT, async (req, res) => {
  const list = Array.isArray(req.body?.quotations) ? req.body.quotations : [];
  if (!list.length) return res.status(400).json({ error: "Nothing to import." });
  if (list.length > 500) return res.status(400).json({ error: "At most 500 quotations at a time." });
  const { rows: lib } = await query(`SELECT agreement_type, terms FROM quotation_term_library`);
  const terms = Object.fromEntries(lib.map((r) => [r.agreement_type, r.terms]));
  const { rows: st } = await query(`SELECT validity_days FROM quotation_settings WHERE id = 1`);
  const validity = st[0]?.validity_days || 7;

  // Oldest first, originals before their revisions, so a later acceptance
  // supersedes an earlier one exactly as it did in real life.
  const rows = list.map((r) => ({ ...r, _n: parseNumber(r.quote_no) }))
    .sort((a, b) => (String(a.quote_date) < String(b.quote_date) ? -1 : String(a.quote_date) > String(b.quote_date) ? 1 : (a._n?.revision || 0) - (b._n?.revision || 0)));

  const result = { imported: 0, skipped: [], failed: [], accepted: 0, customers_created: 0, sites_created: 0 };
  let maxSerial = 0;
  const newCustomers = new Map(); // key → id, so two rows for one new customer make one
  const newSites = new Map();

  for (const r of rows) {
    const n = r._n;
    if (!n) { result.failed.push({ quote_no: r.quote_no, error: "Not a quotation number (RMC-QTN-YYYY-YY-NNNN)." }); continue; }
    maxSerial = Math.max(maxSerial, n.serial);
    const client = await pool.connect();
    const madeHere = { customers: [], sites: [] }; // undone if this row fails
    try {
      await client.query("BEGIN");
      const { rows: dup } = await client.query(`SELECT id FROM quotations WHERE quote_no = $1`, [n.quote_no]);
      if (dup.length) { await client.query("ROLLBACK"); result.skipped.push(n.quote_no); continue; }
      if (!ISO.test(r.quote_date || "")) throw new Error("No date.");
      const type = TYPES.has(r.agreement_type) ? r.agreement_type : "pay_after_delivery";
      const status = ["accepted", "sent", "lost"].includes(r.status) ? r.status : "sent";

      // Customer
      let customerId = Number(r.customer_id) || null;
      if (!customerId) {
        const name = upperName(r.new_customer?.name);
        if (!name) throw new Error("No customer.");
        const key = name.toUpperCase();
        if (newCustomers.has(key)) customerId = newCustomers.get(key);
        else {
          const { rows: c } = await client.query(
            `INSERT INTO customers (name, billing_address) VALUES ($1, $2) RETURNING id`,
            [name.slice(0, 150), String(r.new_customer?.address || "").trim() || null]
          );
          customerId = c[0].id;
          newCustomers.set(key, customerId);
          madeHere.customers.push(key);
        }
      }
      // Site
      let siteId = Number(r.site_id) || null;
      if (!siteId) {
        const name = upperName(r.new_site?.name);
        if (!name) throw new Error("No project / site.");
        const key = `${customerId}|${name.toUpperCase()}`;
        if (newSites.has(key)) siteId = newSites.get(key);
        else {
          const { rows: s } = await client.query(
            `INSERT INTO sites (customer_id, name, address) VALUES ($1, $2, $3) RETURNING id`,
            [customerId, name.slice(0, 200), String(r.new_site?.address || "").trim() || null]
          );
          siteId = s[0].id;
          newSites.set(key, siteId);
          madeHere.sites.push(key);
        }
      } else {
        const { rows: ok } = await client.query(`SELECT 1 FROM sites WHERE id = $1 AND customer_id = $2`, [siteId, customerId]);
        if (!ok.length) throw new Error("The site belongs to another customer.");
      }

      const lines = (Array.isArray(r.lines) ? r.lines : []).filter((l) => Number(l.rate_total) > 0 && (Number(l.mix_grade_id) || String(l.item_label || "").trim()));
      if (!lines.length) throw new Error("No grade with a rate.");

      // The revision's parent, when the earlier one is in the app.
      let parentId = null;
      if (n.revision > 0) {
        const { rows: p } = await client.query(
          `SELECT id FROM quotations WHERE family_no = $1 AND revision < $2 ORDER BY revision DESC LIMIT 1`, [n.family_no, n.revision]);
        parentId = p[0]?.id || null;
      }
      const qd = r.quote_date;
      const { rows: ins } = await client.query(
        `INSERT INTO quotations
           (quote_no, family_no, revision, parent_id, customer_id, site_id, kind_attention, agreement_type, quote_date,
            validity_days, valid_until, status, charges, payment, rebate_per_m3, special_conditions, terms, created_by,
            submitted_at, approved_by, approved_at, sent_at, sent_via, accepted_at, accepted_on, acceptance_mode, rates_from, accepted_by,
            closed_reason, closed_by, closed_at, source, import_note, revision_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::int, $9::date + $10::int, $11::text, $12, $13, $14, $15, $16, $17,
                 $9::date, $17, $9::date, $9::date, 'excel',
                 CASE WHEN $11::text = 'accepted' THEN $18::date END, CASE WHEN $11::text = 'accepted' THEN $18::date END,
                 CASE WHEN $11::text = 'accepted' THEN 'imported' END, CASE WHEN $11::text = 'accepted' THEN $18::date END,
                 CASE WHEN $11::text = 'accepted' THEN $17::int END,
                 CASE WHEN $11::text = 'lost' THEN $19 END, CASE WHEN $11::text = 'lost' THEN $17::int END, CASE WHEN $11::text = 'lost' THEN now() END,
                 'import', $20, $21)
         RETURNING id`,
        [n.quote_no, n.family_no, n.revision, parentId, customerId, siteId, String(r.kind_attention || "").trim().slice(0, 150) || null,
         type, qd, validity, status === "accepted" ? "accepted" : status, r.charges && typeof r.charges === "object" ? r.charges : {},
         r.payment && typeof r.payment === "object" ? r.payment : {}, Number(r.rebate_per_m3) || null,
         String(r.special_conditions || "").trim() || null, JSON.stringify(terms[type] || DEFAULT_TERMS[type]), req.user.id,
         ISO.test(r.rates_from || "") ? r.rates_from : qd, "Imported from Excel — not taken up", "Imported from the quotations Excel",
         n.revision > 0 ? "Revision issued from Excel" : null]
      );
      const qid = ins[0].id;
      let ln = 1;
      for (const l of lines) {
        await client.query(
          `INSERT INTO quotation_lines (quotation_id, line_no, mix_grade_id, item_label, specification, qty_m3, rate_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [qid, ln++, Number(l.mix_grade_id) || null, Number(l.mix_grade_id) ? null : String(l.item_label).trim().slice(0, 80),
           String(l.specification || "").trim().slice(0, 200) || null, Number(l.qty_m3) > 0 ? Number(l.qty_m3) : null,
           Math.round(Number(l.rate_total) * 100) / 100]
        );
      }
      await client.query(
        `INSERT INTO quotation_events (quotation_id, event, note, by_user) VALUES ($1, 'created', $2, $3)`,
        [qid, `Imported from the quotations Excel as ${status}.`, req.user.id]
      );
      await client.query("COMMIT");
      result.customers_created += madeHere.customers.length;
      result.sites_created += madeHere.sites.length;
      if (status === "accepted") {
        // The same price-list write an acceptance in the app makes.
        await applyQuotationToPriceList(qid, ISO.test(r.rates_from || "") ? r.rates_from : qd, req.user.id);
        await query(`UPDATE quotations SET status = 'accepted' WHERE id = $1 AND status <> 'accepted'`, [qid]);
        result.accepted++;
      }
      result.imported++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      for (const k of madeHere.customers) newCustomers.delete(k);
      for (const k of madeHere.sites) newSites.delete(k);
      result.failed.push({ quote_no: n.quote_no, error: err.message?.slice(0, 200) || "Could not import." });
    } finally {
      client.release();
    }
  }

  // Numbering continues after the highest serial imported — never reissued.
  if (maxSerial) {
    await query(`UPDATE quotation_settings SET next_serial = GREATEST(next_serial, $1) WHERE id = 1`, [maxSerial + 1]);
  }
  // Deliveries held for want of a price get their invoice now; invoices that
  // already exist are left exactly as they are.
  const { rows: held } = await query(
    `SELECT dt.id FROM delivery_tickets dt
      WHERE dt.status NOT IN ('cancelled', 'rejected') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ticket_id = dt.id)`
  );
  let invoiced = 0;
  for (const h of held) if (await generateInvoiceForTicket(h.id)) invoiced++;
  const { rows: s } = await query(`SELECT next_serial FROM quotation_settings WHERE id = 1`);
  res.json({ ...result, held_invoiced: invoiced, next_serial: s[0]?.next_serial });
});

export default router;
