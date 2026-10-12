// Round 205 — which price-list row applies, in ONE place.
//
// A quotation may give two prices for one grade (owner's Excel, e.g. M25 OPC
// ₹7,150 and M25 OPC + fly ash ₹6,750). Each becomes its own price-list row
// with `price_option` = the line's specification. The Manager picks the
// option on the order (customer_orders.price_option) whenever the site has
// more than one price for that grade; invoicing then uses that row.
//
// Precedence, unchanged from before: rows for the site win over a
// customer-wide row (site_id NULL, the old rate file); within one option the
// latest effective_from (then id) wins.
import { query } from "../db.js";

export const normOption = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9+]/g, "");

// Every live row for the customer + site + grade on the date, newest first.
export async function liveRows(customerId, siteId, gradeId, date, q = query) {
  const { rows } = await q(
    `SELECT rm.*, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to, qn.quote_no
       FROM rate_master rm LEFT JOIN quotations qn ON qn.id = rm.quotation_id
      WHERE rm.customer_id = $1 AND rm.mix_grade_id = $2 AND (rm.site_id = $3 OR rm.site_id IS NULL)
        AND rm.effective_from <= COALESCE($4::date, CURRENT_DATE)
        AND (rm.effective_to IS NULL OR rm.effective_to >= COALESCE($4::date, CURRENT_DATE))
      ORDER BY rm.effective_from DESC, rm.id DESC`,
    [customerId, gradeId, siteId || null, date || null]
  );
  return rows;
}

// The options on offer: one row per option (site rows first; customer-wide
// rows only when the site has none).
export function optionsOf(rows) {
  const siteRows = rows.filter((r) => r.site_id != null);
  const use = siteRows.length ? siteRows : rows;
  const byOpt = new Map();
  for (const r of use) {
    const k = normOption(r.price_option);
    if (!byOpt.has(k)) byOpt.set(k, r); // rows come newest first
  }
  return [...byOpt.values()];
}

// { rate, options, reason } — reason is set when no single row applies:
//   'none'      no price for this site + grade on that date
//   'choose'    two or more options and the order did not say which
//   'no_option' the order's option is not in the price list (any more)
export function pick(rows, option) {
  const options = optionsOf(rows);
  if (!options.length) return { rate: null, options, reason: "none" };
  if (options.length === 1) return { rate: options[0], options, reason: null };
  if (!option) return { rate: null, options, reason: "choose" };
  const want = normOption(option);
  const hit = options.find((r) => normOption(r.price_option) === want);
  return hit ? { rate: hit, options, reason: null } : { rate: null, options, reason: "no_option" };
}

export async function rateForOrder({ customer_id, site_id, mix_grade_id, order_date, price_option }, q = query) {
  return pick(await liveRows(customer_id, site_id, mix_grade_id, order_date, q), price_option);
}
