// Round 252 — the credit note print, in the app's format (owner, 30 Oct 2026:
// "all credit note is app only format"), laid out as the agreed mockup
// (canvas "GST Tax Invoice — Our Own Ready Mix", artboard 4): letterhead with
// the logo, number / date / invoice block, recipient, reason, the line, HSN tax
// summary, totals, net due on the invoice, note and signatory. A4 through the
// browser's print dialog ("Save as PDF" for the file). A note not yet
// approved prints with NOT APPROVED across it.
import { inrWords } from "./tallyInvoice.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n2 = (v) => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function day(ymd) {
  if (!ymd) return "—";
  return new Date(`${String(ymd).slice(0, 10)}T12:00:00+05:30`).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-");
}
const REASON_LINE = { return: "returned at site", rate: "rate correction", discount: "discount", other: "credit" };

export function creditNoteHtml(cn, origin = window.location.origin) {
  const gst = cn.gst_applied !== false;
  const base = Number(cn.base_amount), cgst = Number(cn.cgst), sgst = Number(cn.sgst), total = Number(cn.total_amount);
  const qty = cn.qty_m3 != null ? Number(cn.qty_m3) : null;
  const rateEx = qty ? base / qty : null;
  const desc = cn.reason === "return"
    ? `Ready-mix concrete ${esc(cn.grade_name || "")} — returned`
    : `Ready-mix concrete ${esc(cn.grade_name || "")} — ${REASON_LINE[cn.reason] || "credit"}`;
  const net = Number(cn.invoice_total) - Number(cn.other_credits || 0) - total;
  const address = String(cn.billing_address || cn.customer_address || "").replace(/\n+/g, ", ");
  const stamp = cn.status === "approved" ? "" : cn.status === "pending" ? "NOT APPROVED" : cn.status.toUpperCase();
  const cell = (label, value, last) => `<div class="c${last ? " l" : ""}"><div class="k">${label}</div><div class="v">${value}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(cn.cn_no)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Serif:wght@700&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:0}
*{box-sizing:border-box}html,body{margin:0;background:#fff}
@media screen{body{background:#e9e6df;padding:16px}.pg{margin:0 auto;box-shadow:0 2px 10px rgba(0,0,0,.15)}}
.pg{position:relative;width:210mm;min-height:297mm;padding:9mm 10mm 7mm;font-family:"IBM Plex Sans",Arial,sans-serif;color:#1A1A1A;font-size:8.6pt;line-height:1.4;background:#fff;
  display:flex;flex-direction:column;gap:7px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.serif{font-family:"IBM Plex Serif",Georgia,serif}
.box{border:1px solid #C9CED8}.mut{color:#555B66}
.grid4{display:grid;grid-template-columns:repeat(4,1fr)}
.c{padding:5px 8px;border-right:1px solid #C9CED8;border-bottom:1px solid #C9CED8}.c.l{border-right:0}
.grid4 .c:nth-child(n+5){border-bottom:0}
.k{color:#555B66;font-size:7.5pt}.v{font-weight:600}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #C9CED8;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#EEF1F6;color:#1E2B4A;font-weight:600}.r{text-align:right;font-variant-numeric:tabular-nums}
.tot div{display:flex;justify-content:space-between;padding:4px 8px;border-bottom:1px solid #E3E6EC}
.stamp{position:absolute;top:42%;left:0;right:0;text-align:center;font-size:54pt;font-weight:700;color:rgba(138,45,28,.13);transform:rotate(-28deg);pointer-events:none}
</style></head><body><div class="pg">
${stamp ? `<div class="stamp">${stamp}</div>` : ""}
<div style="display:flex;align-items:center;gap:12px">
  <img src="${origin}/quote-logo.png" alt="Our Own Ready Mix logo" style="width:22mm;height:22mm;flex:none">
  <div style="flex:1;min-width:0">
    <div class="serif" style="font-size:18pt;font-weight:700;color:#1E2B4A;letter-spacing:.5px">OUR OWN READY MIX</div>
    <div style="color:#3d4350">Plot No. 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala – 671321</div>
    <div style="color:#3d4350">+91 83 4007 4006 · mail@ourownrm.com · www.ourownrm.com</div>
    <div style="margin-top:2px;font-weight:600">GSTIN 32AAGFO7545J1Z2 <span style="font-weight:400;color:#3d4350">· State: Kerala, Code 32 · PAN AAGFO7545J</span></div>
  </div>
  <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
    <div class="serif" style="font-size:17pt;font-weight:700;color:#8A2D1C;letter-spacing:1px">CREDIT NOTE</div>
    <div style="border:1.5px solid #1E2B4A;color:#1E2B4A;font-size:7.5pt;font-weight:700;letter-spacing:1px;padding:2px 7px">ORIGINAL FOR RECIPIENT</div>
  </div>
</div>
<div style="height:3px;background:#B8901F"></div>

<div class="box grid4">
  ${cell("Credit note No.", `<span style="font-size:10pt;font-weight:700">${esc(cn.cn_no)}</span>`)}
  ${cell("Credit note date", esc(day(cn.cn_date)))}
  ${cell("Against invoice", esc(cn.tally_invoice_no || cn.ticket_number))}
  ${cell("Invoice date", esc(day(cn.ticket_date)), true)}
  ${cell("Place of supply", "Kerala (32)")}
  ${cell("Reverse charge", "No")}
  ${cell("Delivery note", esc(cn.ticket_number))}
  ${cell("Site", esc(cn.site_name || "—"), true)}
</div>

<div class="box">
  <div style="background:#1E2B4A;color:#fff;font-weight:600;font-size:8pt;letter-spacing:.8px;padding:3px 8px">ISSUED TO (RECIPIENT)</div>
  <div style="padding:6px 8px;display:grid;grid-template-columns:1fr 1fr;column-gap:14px;row-gap:2px">
    <div style="font-weight:700;font-size:9.5pt">${esc(String(cn.customer_name || "").toUpperCase())}</div>
    <div><span class="mut">GSTIN</span> <b>${esc(cn.billing_gstin || "Unregistered")}</b></div>
    <div>${esc(address || "—")}</div>
    <div><span class="mut">State</span> Kerala · Code 32</div>
  </div>
</div>

<div class="box" style="padding:6px 8px;display:flex;gap:8px">
  <div style="font-weight:700;color:#1E2B4A;flex:none">Reason</div>
  <div>${esc({ return: "Concrete returned / rejected at site", rate: "Rate correction", discount: "Discount", other: "Other" }[cn.reason] || "")}${cn.note ? ` — ${esc(cn.note)}` : ""}</div>
</div>

<table>
  <thead><tr><th style="width:18px">#</th><th>Description</th><th style="width:60px">HSN</th><th class="r" style="width:46px">Qty</th><th style="width:30px">Unit</th><th class="r" style="width:66px">Rate (₹)</th><th class="r" style="width:32px">GST</th><th class="r" style="width:82px">Taxable value (₹)</th></tr></thead>
  <tbody><tr>
    <td>1</td><td><b>${desc}</b><div class="mut" style="font-size:7.8pt">against ${esc(cn.ticket_number)}, ${esc(day(cn.ticket_date))}</div></td>
    <td>38245010</td><td class="r">${qty != null ? n2(qty) : ""}</td><td>${qty != null ? "CBM" : ""}</td>
    <td class="r">${rateEx != null ? n2(rateEx) : ""}</td><td class="r">${gst ? "18%" : "—"}</td><td class="r">${n2(base)}</td>
  </tr></tbody>
</table>

<div style="display:flex;gap:10px;align-items:flex-start">
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:7px">
    ${gst ? `<table style="font-size:7.8pt"><thead><tr><th>HSN</th><th class="r">Taxable (₹)</th><th class="r">CGST 9%</th><th class="r">SGST 9%</th><th class="r">Total tax (₹)</th></tr></thead>
      <tbody><tr><td>38245010</td><td class="r">${n2(base)}</td><td class="r">${n2(cgst)}</td><td class="r">${n2(sgst)}</td><td class="r">${n2(cgst + sgst)}</td></tr></tbody></table>` : ""}
    <div class="box" style="padding:5px 8px"><div class="k">Amount in words</div><div style="font-weight:600">${esc(inrWords(total).replace(/^INR/, "Rupees"))}</div></div>
  </div>
  <div class="box tot" style="width:62mm;flex:none">
    <div><span>Taxable value</span><span class="r">${n2(base)}</span></div>
    ${gst ? `<div><span>CGST 9%</span><span class="r">${n2(cgst)}</span></div><div><span>SGST 9%</span><span class="r">${n2(sgst)}</span></div>` : ""}
    <div><span>Round off</span><span class="r">0.00</span></div>
    <div style="background:#8A2D1C;color:#fff;font-weight:700;font-size:10pt;border:0;padding:6px 8px"><span>Credit total</span><span class="r">₹ ${n2(total)}</span></div>
  </div>
</div>

<div class="box" style="padding:6px 8px;display:grid;grid-template-columns:repeat(3,1fr);column-gap:10px">
  <div><div class="k">Original invoice total</div><div>₹ ${n2(cn.invoice_total)}</div></div>
  <div><div class="k">Less this credit note${Number(cn.other_credits) ? ` (and ₹ ${n2(cn.other_credits)} earlier)` : ""}</div><div>₹ ${n2(total)}</div></div>
  <div><div class="k">Net due on the invoice</div><div style="font-weight:700">₹ ${n2(Math.max(0, net))}</div></div>
</div>

<div style="flex:1"></div>
<div class="box" style="display:grid;grid-template-columns:1fr 1fr">
  <div style="padding:7px 9px;border-right:1px solid #C9CED8;font-size:7.8pt">
    <div style="font-weight:700;color:#1E2B4A;letter-spacing:.6px">NOTE</div>
    <div>The credit is adjusted in your account with us.${gst ? " GST on this credit note is reduced from our output tax; please reverse the matching input tax credit, if claimed." : ""}</div>
  </div>
  <div style="padding:7px 9px;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;text-align:right;min-height:30mm">
    <div style="font-weight:600">For OUR OWN READY MIX</div>
    <div>Authorised Signatory${cn.decided_by && cn.status === "approved" ? `<div class="mut" style="font-size:7.5pt">Approved by ${esc(cn.decided_by)}</div>` : ""}</div>
  </div>
</div>
<div style="display:flex;justify-content:space-between;border-top:2px solid #B8901F;padding-top:5px;font-size:7.5pt;color:#3d4350">
  <span>Credit note issued under Section 34 of the CGST Act, 2017.</span><span>Computer-generated · Page 1 of 1</span>
</div>
</div></body></html>`;
}

export async function printCreditNote(cn) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(creditNoteHtml(cn)); doc.close();
  const imgs = [...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
  await Promise.race([Promise.all(imgs), new Promise((r) => setTimeout(r, 5000))]);
  try { await doc.fonts?.ready; } catch { /* fine */ }
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60_000);
}
