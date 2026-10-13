// Round 204 — the customer / site price list, and what accepting a quotation
// does to it.
//
// The price list IS rate_master (see lib/quotationSchema.js). The owner's
// rules (11 Oct 2026):
//   * An existing customer's price list does not change until the customer
//     accepts the revised quotation. Admin approval alone changes nothing.
//   * A brand-new site (no price list yet): the first order against its
//     approved quotation counts as acceptance (clause 9.1, "deemed
//     acceptance"). A revision always needs a recorded acceptance.
//   * On acceptance, the new rates apply from the date given. Deliveries
//     before that date keep the old rates.
import { pool, query } from "../db.js";
import { generateInvoiceForTicket } from "./deliveryConfirmation.js";
import { recomputeOrderCharges } from "./orderCharges.js";
import { pushToRole } from "./push.js";
import { optionsOf, rateForOrder } from "./rateLookup.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Live price-list rows for one site on a date (site-specific rows first; a
// customer-wide row from the old rate file still applies where no site row
// exists — the same precedence invoicing uses).
// Round 209 — { includeDisabled: true } also returns the rows of lines the
// customer did not approve (is_enabled = false), for the price-list screen.
export async function liveRatesForSite(customerId, siteId, date = null, { includeDisabled = false } = {}) {
  const { rows } = await query(
    `SELECT rm.*, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to,
            m.name AS grade_name, q.quote_no, md.design_ref_code, md.revision AS design_revision, md.mix_description
       FROM rate_master rm
       JOIN mix_grades m ON m.id = rm.mix_grade_id
       LEFT JOIN quotations q ON q.id = rm.quotation_id
       LEFT JOIN mix_designs md ON md.id = rm.mix_design_id
      WHERE rm.customer_id = $1 AND (rm.site_id = $2 OR rm.site_id IS NULL)
        AND ($4::boolean OR COALESCE(rm.is_enabled, true))
        AND rm.effective_from <= COALESCE($3::date, CURRENT_DATE)
        AND (rm.effective_to IS NULL OR rm.effective_to >= COALESCE($3::date, CURRENT_DATE))
      ORDER BY m.name, rm.effective_from DESC, rm.id DESC`,
    [customerId, siteId, date, includeDisabled]
  );
  // Round 205 — one row per grade and price option (lib/rateLookup.js).
  // Round 209 — enabled and disabled rows are kept apart, so a disabled line
  // never hides the enabled price of the same grade.
  const byGrade = new Map();
  for (const r of rows) {
    if (includeDisabled) {
      const k = `${r.mix_grade_id}|${r.is_enabled === false ? "off" : "on"}`;
      if (!byGrade.has(k)) byGrade.set(k, []);
      byGrade.get(k).push(r);
      continue;
    }
    if (!byGrade.has(r.mix_grade_id)) byGrade.set(r.mix_grade_id, []);
    byGrade.get(r.mix_grade_id).push(r);
  }
  return [...byGrade.values()].flatMap((g) => optionsOf(g));
}

// Writes one accepted quotation into the price list, inside a transaction.
// Returns the grades touched.
// Round 209 — approvedLineIds: the lines the customer approved (null = all).
// A not-approved line is written as a disabled row (is_enabled = false) that
// the Administrator can enable later at the quoted rate; it does not end the
// grade's current price.
export async function applyQuotationToPriceList(quotationId, ratesFrom, userId, approvedLineIds = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: qs } = await client.query(`SELECT * FROM quotations WHERE id = $1 FOR UPDATE`, [quotationId]);
    const q = qs[0];
    if (!q) throw new Error("Quotation not found.");
    const { rows: lines } = await client.query(
      `SELECT ql.*, md.design_ref_code, md.revision AS design_revision
         FROM quotation_lines ql LEFT JOIN mix_designs md ON md.id = ql.mix_design_id
        WHERE ql.quotation_id = $1 AND ql.mix_grade_id IS NOT NULL ORDER BY ql.line_no`,
      [quotationId]
    );
    const c = q.charges || {};
    const approvedSet = approvedLineIds ? new Set(approvedLineIds.map(Number)) : null;
    const isApproved = (ln) => !approvedSet || approvedSet.has(ln.id);
    await client.query(`UPDATE quotation_lines SET approved = (id = ANY($2::int[])) WHERE quotation_id = $1`,
      [quotationId, lines.filter(isApproved).map((l) => l.id)]);
    const touched = [...new Set(lines.filter(isApproved).map((l) => l.mix_grade_id))];
    // Round 205 — a grade quoted twice (OPC / OPC + fly ash) keeps both, each
    // with its specification as the price option. End what is live for every
    // grade first, then write the lines — so the second option of a grade does
    // not end the first.
    const count = new Map();
    for (const ln of lines) count.set(ln.mix_grade_id, (count.get(ln.mix_grade_id) || 0) + 1);
    for (const gradeId of touched) {
      // A row that would only have started on/after the new date is closed off
      // completely (to = from − 1, so it never applies).
      await client.query(
        `UPDATE rate_master
            SET effective_to = CASE WHEN effective_from < $4::date THEN ($4::date - 1) ELSE (effective_from - 1) END
          WHERE customer_id = $1 AND site_id = $2 AND mix_grade_id = $3
            AND (effective_to IS NULL OR effective_to >= $4::date)`,
        [q.customer_id, q.site_id, gradeId, ratesFrom]
      );
    }
    for (const ln of lines) {
      // Round 209 — a mix design names the option by its ref / rev.
      const option = count.get(ln.mix_grade_id) > 1
        ? (ln.design_ref_code ? `${ln.design_ref_code} · rev ${ln.design_revision}` : (ln.specification || `Option ${ln.line_no}`)) : null;
      await client.query(
        `INSERT INTO rate_master
           (customer_id, site_id, mix_grade_id, rate_per_m3,
            line_pump_charge, line_pump_min_qty_m3, boom_pump_charge, boom_pump_min_qty_m3, boom_rate_above_per_m3,
            part_load_min_qty_m3, part_load_charge_per_m3, waiting_charge_per_hour,
            committed_qty_m3, rebate_per_m3, effective_from, source, quotation_id, created_by, price_option,
            mix_design_id, is_enabled, enabled_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'quotation',$16,$17,$18,$19,$20,$21)`,
        [q.customer_id, q.site_id, ln.mix_grade_id, ln.rate_total,
         c.line_pump_charge ?? null, c.line_pump_min_qty ?? 20, c.boom_min_charge ?? null, c.boom_min_qty ?? 50, c.boom_rate_above ?? null,
         c.part_load_min_qty ?? 5, c.part_load_rate ?? null, c.waiting_rate ?? 0,
         q.agreement_type === "credit_qty" ? ln.qty_m3 : null, q.agreement_type === "credit_qty" ? q.rebate_per_m3 : null,
         ratesFrom, quotationId, userId, option,
         ln.mix_design_id || null, isApproved(ln), isApproved(ln) ? null : "Not approved by the customer"]
      );
    }
    // Earlier quotations of this customer + site that were live are superseded.
    await client.query(
      `UPDATE quotations SET status = 'superseded', updated_at = now()
        WHERE customer_id = $1 AND site_id = $2 AND id <> $3 AND status IN ('accepted')`,
      [q.customer_id, q.site_id, quotationId]
    );
    await client.query(
      `UPDATE quotations SET status = 'superseded', updated_at = now()
        WHERE family_no = $1 AND id <> $2 AND status IN ('approved', 'sent', 'pending_approval', 'draft')`,
      [q.family_no, quotationId]
    );
    await client.query("COMMIT");
    return { customer_id: q.customer_id, site_id: q.site_id, grades: touched };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// After the price list changed: raise held invoices and re-price unpaid ones
// for deliveries on orders dated from the new date. An invoice that already
// has a payment is never changed automatically — the Accountant is told.
export async function repriceAfterAcceptance({ customer_id, site_id, grades }, ratesFrom) {
  if (!grades.length) return { created: 0, updated: 0, flagged: 0 };
  const { rows: tickets } = await query(
    `SELECT dt.id AS ticket_id, dt.ticket_number, dt.order_id, dt.loaded_quantity_m3,
            co.customer_id, co.site_id, co.mix_grade_id, co.order_date::text AS order_day, co.price_option,
            i.id AS invoice_id, i.rate_per_m3 AS inv_rate, i.concrete_amount, i.rejected_quantity_m3,
            (SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id)::int AS payment_count
       FROM delivery_tickets dt
       JOIN customer_orders co ON co.id = dt.order_id
       LEFT JOIN invoices i ON i.ticket_id = dt.id
      WHERE co.customer_id = $1 AND co.site_id = $2 AND co.mix_grade_id = ANY($3::int[])
        AND co.order_date >= $4::date
        AND dt.status NOT IN ('cancelled', 'rejected')
      ORDER BY dt.id`,
    [customer_id, site_id, grades, ratesFrom]
  );
  let created = 0, updated = 0, flagged = 0;
  const ordersToRecompute = new Set();
  for (const t of tickets) {
    if (!t.invoice_id) {
      if (await generateInvoiceForTicket(t.ticket_id)) created++;
      continue;
    }
    const picked = await rateForOrder({ customer_id: t.customer_id, site_id: t.site_id, mix_grade_id: t.mix_grade_id, order_date: t.order_day, price_option: t.price_option });
    const rr = picked.rate ? [picked.rate] : [];
    const rate = rr[0];
    if (!rate) continue;
    const accepted = Number(t.loaded_quantity_m3 || 0) - Number(t.rejected_quantity_m3 || 0);
    const newConcrete = r2(accepted * Number(rate.rate_per_m3));
    if (Math.abs(newConcrete - Number(t.concrete_amount)) < 0.01 && t.inv_rate != null) continue;
    if (t.payment_count > 0) {
      flagged++;
      await query(
        `INSERT INTO notifications (recipient_role, ticket_id, type, message) VALUES ('accountant', $1, 'reprice_review', $2)`,
        [t.ticket_id, `${t.ticket_number}: the customer accepted a new rate (₹${rate.rate_per_m3}/m³ from ${ratesFrom}), but this invoice already has a payment — not changed automatically. Review it.`]
      );
      continue;
    }
    await query(
      `UPDATE invoices SET concrete_amount = $1, rate_per_m3 = $2, rate_id = $3,
              total_amount = $1 + pumping_charge + part_load_charge + COALESCE(waiting_charge, 0)
        WHERE id = $4`,
      [newConcrete, rate.rate_per_m3, rate.id, t.invoice_id]
    );
    ordersToRecompute.add(t.order_id);
    updated++;
  }
  // The part load rate comes from the price list too.
  for (const orderId of ordersToRecompute) {
    const { rows: paid } = await query(
      `SELECT 1 FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN delivery_tickets dt ON dt.id = i.ticket_id
        WHERE dt.order_id = $1 LIMIT 1`,
      [orderId]
    );
    if (!paid.length) await recomputeOrderCharges(orderId);
  }
  return { created, updated, flagged };
}

// Clause 9.1 for a NEW site: an approved (or sent) quotation for a customer +
// site that has no price list yet is accepted by the first order placed
// against it. A revision of a site that already has a price list is never
// accepted this way — the owner's rule.
export async function deemedAcceptOnFirstOrder(orderId, userId) {
  try {
    const { rows: o } = await query(
      `SELECT id, customer_id, site_id, order_date::text AS order_date FROM customer_orders WHERE id = $1`,
      [orderId]
    );
    if (!o.length) return null;
    const order = o[0];
    const { rows: existing } = await query(
      `SELECT 1 FROM rate_master WHERE customer_id = $1 AND site_id = $2 LIMIT 1`,
      [order.customer_id, order.site_id]
    );
    if (existing.length) return null;
    const { rows: qs } = await query(
      `SELECT id, quote_no FROM quotations
        WHERE customer_id = $1 AND site_id = $2 AND status IN ('approved', 'sent') AND revision = 0
        ORDER BY id DESC LIMIT 1`,
      [order.customer_id, order.site_id]
    );
    if (!qs.length) return null;
    const q = qs[0];
    const ratesFrom = order.order_date.slice(0, 10);
    const result = await applyQuotationToPriceList(q.id, ratesFrom, userId);
    await query(
      `UPDATE quotations SET status = 'accepted', accepted_at = now(), accepted_on = $2::date, acceptance_mode = 'first_order',
              rates_from = $2::date, accepted_by = $3, updated_at = now()
        WHERE id = $1`,
      [q.id, ratesFrom, userId]
    );
    await query(
      `INSERT INTO quotation_events (quotation_id, event, note, by_user) VALUES ($1, 'accepted', $2, $3)`,
      [q.id, `Deemed accepted by the first order (clause 9.1); price list set from ${ratesFrom}.`, userId]
    );
    await repriceAfterAcceptance(result, ratesFrom);
    await pushToRole("administrator", {
      title: "Quotation accepted by first order",
      body: `${q.quote_no} — price list set for the site from ${ratesFrom}.`,
      url: "/accounts?tab=quotations",
    });
    return q.id;
  } catch (err) {
    console.error("Deemed acceptance failed:", err);
    return null;
  }
}

// Round 209 — the Administrator enables a price-list row the customer did not
// approve at first (at its quoted rate, from the given date), or disables a
// row so it can no longer be ordered. Enabling ends any other enabled row of
// the same grade and option for that site.
export async function setRowEnabled(rowId, enabled, { from = null, note = null, userId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM rate_master WHERE id = $1 FOR UPDATE`, [rowId]);
    const r = rows[0];
    if (!r) throw Object.assign(new Error("Price-list row not found."), { status: 404 });
    if (enabled) {
      const day = from || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      await client.query(
        `UPDATE rate_master SET effective_to = GREATEST(effective_from, $5::date - 1)
          WHERE customer_id = $1 AND site_id IS NOT DISTINCT FROM $2 AND mix_grade_id = $3 AND id <> $4
            AND COALESCE(is_enabled, true) AND (effective_to IS NULL OR effective_to >= $5::date)
            AND upper(regexp_replace(COALESCE(price_option, ''), '[^A-Za-z0-9+]', '', 'g'))
              = upper(regexp_replace(COALESCE($6::text, ''), '[^A-Za-z0-9+]', '', 'g'))`,
        [r.customer_id, r.site_id, r.mix_grade_id, r.id, day, r.price_option]
      );
      await client.query(
        `UPDATE rate_master SET is_enabled = true, effective_from = GREATEST(effective_from, $2::date), effective_to = NULL,
                enabled_note = $3, enabled_changed_by = $4, enabled_changed_at = now() WHERE id = $1`,
        [r.id, day, note, userId]
      );
      if (r.quotation_id) {
        await client.query(`UPDATE quotation_lines SET approved = true WHERE quotation_id = $1 AND mix_grade_id = $2 AND mix_design_id IS NOT DISTINCT FROM $3`,
          [r.quotation_id, r.mix_grade_id, r.mix_design_id]);
      }
    } else {
      await client.query(
        `UPDATE rate_master SET is_enabled = false, enabled_note = $2, enabled_changed_by = $3, enabled_changed_at = now() WHERE id = $1`,
        [r.id, note, userId]
      );
    }
    if (r.quotation_id) {
      await client.query(
        `INSERT INTO quotation_events (quotation_id, event, note, by_user) VALUES ($1, 'price_list', $2, $3)`,
        [r.quotation_id, `${enabled ? "Enabled" : "Disabled"} on the price list${note ? `: ${note}` : ""}.`, userId]
      );
    }
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
