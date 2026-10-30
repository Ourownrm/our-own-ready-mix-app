// Round 251 — a B2C invoice printed in the Tally format (owner, 30 Oct 2026:
// "the printing format should be same as provided one" — Tally's
// "Sales_B2C_195_26-27.pdf"). Every rule and word is placed at the Tally
// PDF's own position, in points, on an A4 page; Tally prints Helvetica
// squeezed to 93 % wide (81 % for a few labels), so the text is squeezed the
// same way. Figures are worked out as Tally does: rate before GST = rate ÷
// 1.18 to the paisa, amount = quantity × that rate, CGST and SGST 9 % each on
// the taxable total, and the total rounded to the rupee with a ROUNDOFF line.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n2 = (v) => Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v) => {
  const x = Number(v) || 0;
  return x.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
};
export const HSN = "38245010";

// Indian-system words, as Tally writes them ("Seven Thousand Six Hundred Eighty Eight").
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
  "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function two(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`; }
function three(n) { const h = Math.floor(n / 100), r = n % 100; return [h ? `${ONES[h]} Hundred` : "", r ? two(r) : ""].filter(Boolean).join(" "); }
function words(n) {
  if (!n) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thou = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${words(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thou) parts.push(`${two(thou)} Thousand`);
  if (n) parts.push(three(n));
  return parts.join(" ");
}
export function inrWords(amount) {
  const a = r2(amount);
  const rupees = Math.floor(a);
  const paise = Math.round((a - rupees) * 100);
  return `INR ${words(rupees)}${paise ? ` and ${two(paise)} paise` : ""} Only`;
}
function tallyDate(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${String(d).padStart(2, "0")}-${mon}-${String(y).slice(2)}`;
}

// The invoice's lines and tax, Tally's way.
export function tallyFigures(inv) {
  const m3 = r2(Number(inv.loaded_quantity_m3 || 0) - Number(inv.rejected_quantity_m3 || 0));
  const lines = [];
  if (Number(inv.concrete_amount) > 0) {
    const rateIncl = Number(inv.rate_per_m3) || (m3 ? Number(inv.concrete_amount) / m3 : 0);
    const rate = r2(rateIncl / 1.18);
    lines.push({ name: `${String(inv.grade_name || "").toUpperCase()} GRADE CONCRETE`, qty: m3, rate, amount: r2(m3 * rate) });
  }
  for (const [k, label] of [["pumping_charge", "PUMP CHARGES"], ["part_load_charge", "PART LOAD CHARGES"], ["waiting_charge", "WAITING CHARGES"]]) {
    if (Number(inv[k]) > 0) lines.push({ name: label, qty: null, rate: null, amount: r2(Number(inv[k]) / 1.18) });
  }
  const taxable = r2(lines.reduce((t, l) => t + l.amount, 0));
  const cgst = r2(taxable * 0.09), sgst = r2(taxable * 0.09);
  const exact = r2(taxable + cgst + sgst);
  const total = Math.round(exact);
  return { lines, m3, taxable, cgst, sgst, roundoff: r2(total - exact), total, tax: r2(cgst + sgst) };
}

// One positioned piece of text. `at` is the left edge, or {right} for figures.
function T(x, y, text, cls = "s10", style = "") {
  const pos = typeof x === "object" ? `right:${595 - x.right}pt` : `left:${x}pt`;
  const anchor = typeof x === "object" ? " r" : "";
  return `<span class="${cls}${anchor}" style="${pos};top:${y}pt;${style}">${esc(text)}</span>`;
}
const H = (x, y, w, extra = "") => `<div class="h" style="left:${x}pt;top:${y}pt;width:${w}pt;${extra}"></div>`;
const V = (x, y, h) => `<div class="v" style="left:${x}pt;top:${y}pt;height:${h}pt"></div>`;

export function tallyInvoiceHtml(inv) {
  const d = inv.tally_details || {};
  const f = tallyFigures(inv);
  const buyerAddr = String(inv.billing_address || inv.customer_address || "").split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const out = [];

  // rules — exactly where Tally draws them
  out.push(H(36, 33, 468), H(37, 140, 231));
  for (const y of [59, 84, 109, 134, 159, 184, 209]) out.push(H(271, y, 113), H(386, y, 114));
  out.push(H(36, 274, 468, "border-top-width:1pt"), H(37, 304, 466), H(36, 520, 468), H(36, 537, 468), H(36, 567, 468), H(251, 581, 192),
    H(37, 595, 466), H(37, 607, 466), H(36, 621, 468), H(270, 640, 233), H(39, 650, 41), H(36, 683, 468));
  out.push(V(36, 33, 650), V(504, 33, 650), V(270, 34, 239), V(386, 34, 175), V(271, 184, 12));
  for (const x of [49, 244, 297, 350, 403, 425]) out.push(V(x, 274, 263));
  for (const x of [191, 251, 347, 443]) out.push(V(x, 567, 54));
  out.push(V(288, 580, 41), V(383, 580, 41), V(270, 640, 42));

  out.push(T(236, 21.5, "Tax Invoice", "s12 b"));
  // seller — as Tally prints it
  [["OUR OWN READYMIX", "s10 b"], ["Ananthapuram DP"], ["Kasaragod"], ["GSTIN/UIN: 32AAGFO7545J1Z2"], ["State Name :  Kerala, Code : 32"],
    ["Contact : +91-+91 8340074006"], ["E-Mail : mail@ourownrm.com"], ["www.ourownrm.com"]]
    .forEach(([t, c], i) => out.push(T(39, i === 0 ? 39.1 : 39.1 + 13 * i, t, c || "s10")));
  // buyer
  out.push(T(39, 143.9, "Buyer (Bill to)", "s9"));
  out.push(T(39, 158.1, String(inv.billing_name || inv.customer_name || "").toUpperCase(), "s10 b"));
  buyerAddr.forEach((a, i) => out.push(T(39, 171.1 + 13 * i, a.toUpperCase())));
  const sy = 171.1 + 13 * buyerAddr.length;
  out.push(T(39, sy, "State Name", "s10"), T(113, sy, ":", "s10"), T(120, sy, d.buyer_state || "Kerala, Code : 32", "s10"));

  // right-hand boxes: label, then the value under it
  const box = (x, y, label, value) => { out.push(T(x, y, label, "s9")); if (value) out.push(T(x, y + 11.2, value, "s10 b")); };
  box(273, 36.9, "Invoice No.", inv.tally_invoice_no);
  box(388, 36.9, "Dated", tallyDate(d.dated || inv.ticket_date));
  box(273, 61.9, "Delivery Note", d.delivery_note);
  box(388, 61.9, "Mode/Terms of Payment", d.payment_terms);
  box(273, 86.9, "Reference No. & Date.", d.reference);
  box(388, 86.9, "Other References", d.other_references);
  box(273, 111.9, "Buyer’s Order No.", d.buyer_order_no);
  box(388, 111.9, "Dated", d.buyer_order_date);
  box(273, 136.9, "Dispatch Doc No.", d.dispatch_doc_no);
  box(388, 136.9, "Delivery Note Date", d.delivery_note_date);
  box(273, 161.9, "Dispatched through", d.dispatched_through);
  box(388, 161.9, "Destination", d.destination);
  box(273, 186.9, "Bill of Lading/LR-RR No.", d.lr_no);
  box(388, 186.9, "Motor Vehicle No.", d.vehicle_no);
  out.push(T(273, 211.9, "Terms of Delivery", "s9"));
  if (d.terms_of_delivery) out.push(T(273, 223.1, d.terms_of_delivery, "s10 b"));

  // item table heading
  out.push(T(39, 280.1, "Sl", "s10", "transform:scaleX(.73)"), T(39, 293.1, "No.", "s10", "transform:scaleX(.43)"),
    T(100, 279.9, "Description of Goods", "s9"), T(249, 279.9, "HSN/SAC", "s9"), T(305, 279.9, "Quantity", "s9"),
    T(366, 279.9, "Rate", "s9"), T(407, 279.9, "per", "s9"), T(448, 279.9, "Amount", "s9"));

  // items, 13 pt apart; then the tax lines 25 pt below the last item
  let y = 312.1;
  f.lines.forEach((l, i) => {
    out.push(T(41, y + 1, String(i + 1)), T(51, y, l.name, "s10 b"), T(246, y + 0.8, HSN, "s9"));
    if (l.qty != null) out.push(T({ right: 344.3 }, y, `${qty(l.qty)} M`, "s10 b"), T({ right: 397.6 }, y + 0.8, n2(l.rate), "s9"), T(416, y + 0.8, "M", "s9"));
    out.push(T({ right: 494.4 }, y, n2(l.amount), "s10 b"));
    y += 13;
  });
  y += 25;
  out.push(T({ right: 237.8 }, y, "Output Cgst 9%", "s10 b i"), T({ right: 400.2 }, y + 2, "9", "s10 i"), T(405, y + 2, "%", "s10 i"), T({ right: 495.2 }, y + 1, n2(f.cgst), "s10 b"));
  y += 13;
  out.push(T({ right: 237.2 }, y, "Output Sgst 9%", "s10 b i"), T({ right: 400.2 }, y + 2, "9", "s10 i"), T(405, y + 2, "%", "s10 i"), T({ right: 495.2 }, y + 1, n2(f.sgst), "s10 b"));
  if (f.roundoff) {
    y += 13;
    out.push(T({ right: 238.7 }, y, "ROUNDOFF", "s10 b i"), T({ right: 498.1 }, y + 1, f.roundoff > 0 ? n2(f.roundoff) : `(-)${n2(-f.roundoff)}`, "s10 b"));
  }

  // total row and below — the bottom half of the Tally page
  out.push(T({ right: 240.6 }, 523.9, "Total", "s9"));
  if (f.m3) out.push(T({ right: 344.3 }, 523.1, `${qty(f.m3)} M`, "s10 b"));
  out.push(T({ right: 494.7 }, 524.5, `₹ ${n2(f.total)}`, "s12 b"));
  out.push(T(39, 539.9, "Amount Chargeable (in words)", "s9 k81"), T({ right: 496.6 }, 539.9, "E. & O.E", "s9 i"));
  out.push(T(39, 554.1, inrWords(f.total), "s10 b"));
  out.push(T(91, 570.9, "HSN/SAC", "s9"), T(205, 570.9, "Taxable", "s9"), T(211, 583.9, "Value", "s9"), T(286, 570.9, "CGST", "s9"),
    T(366, 570.9, "SGST/UTGST", "s9"), T(463, 570.9, "Total", "s9"), T(260, 583.9, "Rate", "s9"), T(302, 583.9, "Amount", "s9"),
    T(355, 583.9, "Rate", "s9"), T(397, 583.9, "Amount", "s9"), T(448, 583.9, "Tax Amount", "s9"));
  out.push(T(39, 597.9, HSN, "s9"), T({ right: 247.2 }, 597.9, n2(f.taxable), "s9"), T({ right: 285.1 }, 597.9, "9%", "s9"),
    T({ right: 342.6 }, 597.9, n2(f.cgst), "s9"), T({ right: 380.1 }, 597.9, "9%", "s9"), T({ right: 437.6 }, 597.9, n2(f.sgst), "s9"),
    T({ right: 497.6 }, 597.9, n2(f.tax), "s9"));
  out.push(T({ right: 189 }, 610.9, "Total", "s9 b"), T({ right: 247.2 }, 610.9, n2(f.taxable), "s9 b"), T({ right: 342.6 }, 610.9, n2(f.cgst), "s9 b"),
    T({ right: 437.6 }, 610.9, n2(f.sgst), "s9 b"), T({ right: 497.6 }, 610.9, n2(f.tax), "s9 b"));
  out.push(T(39, 629.9, "Tax Amount (in words)  :", "s9 k81"), T(133, 629.1, inrWords(f.tax), "s10 b"));
  out.push(T(39, 642.3, "Declaration", "s7 k100"),
    T(39, 652.6, "We declare that this invoice shows the actual price of", "s8 k105"),
    T(39, 662.6, "the goods described and that all particulars are true", "s8 k105"),
    T(39, 672.6, "and correct.", "s8 k105"),
    T({ right: 490.3 }, 642.9, "for OUR OWN READYMIX", "s9 b k81"),
    T({ right: 491.7 }, 672.9, "Authorised Signatory", "s9 k81"));
  out.push(T(189, 691.9, "This is a Computer Generated Invoice", "s9"));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(inv.tally_invoice_no || "Invoice")}</title>
<style>
@page{size:A4;margin:0}
html,body{margin:0;background:#fff}
@media screen{body{background:#e9e6df;padding:16px}.tp{margin:0 auto;box-shadow:0 2px 10px rgba(0,0,0,.15)}}
.tp{position:relative;width:595pt;height:841pt;background:#fff;color:#000;font-family:Helvetica,Arial,"Liberation Sans",sans-serif;overflow:hidden;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.tp span{position:absolute;white-space:pre;line-height:1;transform:scaleX(.93);transform-origin:left top}
.tp span.r{transform-origin:right top}
.tp span.k81{transform:scaleX(.81)}.tp span.k100{transform:none}.tp span.k105{transform:scaleX(1.046)}
.tp .h{position:absolute;height:0;border-top:.75pt solid #000}
.tp .v{position:absolute;width:0;border-left:.75pt solid #000}
.s7{font-size:7.2pt}.s8{font-size:8.1pt}.s9{font-size:9pt}.s10{font-size:10pt}.s12{font-size:12pt}.b{font-weight:700}.i{font-style:italic}
</style></head><body><div class="tp">${out.join("\n")}</div></body></html>`;
}

export async function printTallyInvoice(inv) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(tallyInvoiceHtml(inv)); doc.close();
  try { await doc.fonts?.ready; } catch { /* fine */ }
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60_000);
}
