// Round 208 — a material order printed as a purchase order, laid out as the
// owner's LPO format (lpo_format2.pdf): the gold logo top right, "PURCHASE
// ORDER" in blue over a gold rule, To / PO No block, the item table with
// total, GST and Total Amount, billing and delivery address, terms, other
// remarks, "For OUR OWN READY MIX" with the Administrator who approved the
// order, and the company footer strip. A4.
//
// jsPDF native drawing with the fonts embedded from /public/fonts (as the
// quotation PDF), so ₹ prints. An order not yet approved prints as a DRAFT.
import { jsPDF } from "jspdf";

const BLUE = [43, 76, 155];
const GOLD = [226, 181, 43];
const BAR = [217, 217, 217];
const BLACK = [28, 28, 28];
const GREY = [96, 96, 96];
const RED = [179, 38, 30];
const PAGE_W = 210;
const PAGE_H = 297;
const MX = 15;
const CW = PAGE_W - MX * 2;
const BOTTOM = 268;
const LH = 4.6;

const cache = {};
async function asBase64(url) {
  if (cache[url]) return cache[url];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  cache[url] = btoa(bin);
  return cache[url];
}
async function registerFonts(doc) {
  const fonts = [
    ["Carlito-Regular.ttf", "Body", "normal"],
    ["Carlito-Bold.ttf", "Body", "bold"],
    ["Carlito-Italic.ttf", "Body", "italic"],
    ["Poppins-Bold.ttf", "Title", "bold"],
  ];
  for (const [file, name, style] of fonts) {
    doc.addFileToVFS(file, await asBase64(`/fonts/${file}`));
    doc.addFont(file, name, style);
  }
}

export const poNo = (id) => `PO-${String(id).padStart(5, "0")}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(ymd) {
  if (!ymd) return "";
  const [y, m, d] = String(ymd).slice(0, 10).split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10); // ist-ok: UTC midnight of a calendar date, no clock involved
}
const num = (v, dp = 2) => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const qtyText = (v) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const pctText = (v) => Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });

// ---------------- amount in words, Indian system ----------------
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`; }
function threeDigits(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? twoDigits(r) : ""].filter(Boolean).join(" ");
}
function wholeWords(n) {
  if (n === 0) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${wholeWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(" ");
}
export function rupeesInWords(amount) {
  const paise = Math.round(Number(amount || 0) * 100);
  const rupees = Math.floor(paise / 100), p = paise % 100;
  return `Rupees ${wholeWords(rupees)}${p ? ` and ${twoDigits(p)} Paise` : ""} Only`;
}

// ---------------- the figures ----------------
// GST is split CGST + SGST when the supplier is in our state (same first two
// digits of the GSTIN), IGST otherwise. A supplier with no GSTIN on file is
// taken as in-state — the local sand and aggregate suppliers.
export function poFigures(order, settings) {
  const qty = Number(order.ordered_qty || 0);
  const rate = Number(order.rate || 0);
  const pct = Number(order.tax_pct || 0);
  const gross = round2(qty * rate);
  const ourState = String(settings.our_gstin || "").slice(0, 2);
  const theirState = String(order.supplier_gstin || "").trim().slice(0, 2);
  const interState = !!(ourState && theirState && /^\d\d$/.test(theirState) && theirState !== ourState);
  let taxable, tax, total;
  if (pct <= 0) { taxable = gross; tax = 0; total = gross; }
  else if (order.gst_treatment === "included") { total = gross; taxable = round2(gross / (1 + pct / 100)); tax = round2(total - taxable); }
  else { taxable = gross; tax = round2(gross * pct / 100); total = round2(taxable + tax); }
  const lines = [];
  if (pct > 0) {
    if (interState) lines.push({ label: `IGST @ ${pctText(pct)}%`, amount: tax });
    else {
      const half = round2(tax / 2);
      lines.push({ label: `CGST @ ${pctText(pct / 2)}%`, amount: half });
      lines.push({ label: `SGST @ ${pctText(pct / 2)}%`, amount: round2(tax - half) });
    }
  }
  return { qty, rate, pct, gross, taxable, tax, total, interState, included: order.gst_treatment === "included" && pct > 0, lines };
}

export async function buildPurchaseOrderPdf({ order: o, settings: st, terms: t }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  await registerFonts(doc);
  const [logo, footer] = await Promise.all([
    asBase64("/quote-logo.png").then((b) => `data:image/png;base64,${b}`).catch(() => null),
    asBase64("/quote-footer.png").then((b) => `data:image/png;base64,${b}`).catch(() => null),
  ]);
  const approved = !!o.approved_day && o.status !== "pending_approval";
  const poDate = approved ? o.approved_day : o.requested_day;
  const fig = poFigures(o, st);

  const font = (style = "normal", size = 10, fam = "Body") => { doc.setFont(fam, style); doc.setFontSize(size); };
  const color = (c) => doc.setTextColor(...c);
  const text = (s, x, yy, opts) => doc.text(String(s ?? ""), x, yy, opts);

  function header() {
    if (logo) doc.addImage(logo, "PNG", PAGE_W - MX - 24, 6, 24, 24);
    font("bold", 15, "Title"); color(BLUE);
    text("PURCHASE ORDER", PAGE_W / 2, 30, { align: "center" });
    doc.setDrawColor(...GOLD); doc.setLineWidth(0.6);
    doc.line(MX, 33, PAGE_W - MX, 33);
    if (!approved) {
      font("bold", 9.5); color(RED);
      text("DRAFT — not approved yet", MX, 30);
    }
    color(BLACK); font();
  }
  function watermark() {
    if (approved) return;
    doc.saveGraphicsState();
    doc.setGState(new doc.GState({ opacity: 0.08 }));
    font("bold", 90, "Title"); color([0, 0, 0]);
    text("DRAFT", PAGE_W / 2, PAGE_H / 2 + 20, { align: "center", angle: 35 });
    doc.restoreGraphicsState();
    color(BLACK);
  }
  let y = 40;
  function newPage() { doc.addPage(); header(); watermark(); y = 40; }
  const ensure = (h) => { if (y + h > BOTTOM) newPage(); };
  function bar(label, x = MX, w = CW) {
    doc.setFillColor(...BAR); doc.rect(x, y, w, 5.6, "F");
    doc.setDrawColor(...GOLD); doc.setLineWidth(0.5); doc.line(x, y + 5.6, x + w, y + 5.6);
    font("bold", 10); color(BLACK);
    text(label, x + 1.5, y + 4.1);
  }

  header();
  watermark();

  // ---------------- To / PO block ----------------
  font("normal", 10); color(BLACK);
  let ly = y;
  text("To,", MX, ly + 3.4); ly += LH;
  font("bold", 10.5); text(o.supplier_name, MX, ly + 3.4); ly += LH;
  font("normal", 10);
  const addr = String(o.supplier_address || "").split(/\n/).flatMap((l) => doc.splitTextToSize(l, 104)).filter((l) => l.trim());
  for (const l of addr) { text(l, MX, ly + 3.4); ly += LH; }
  const contact = [o.supplier_contact, o.supplier_phone].filter(Boolean).join(" · ");
  if (contact) { ly += 1; text(`Contact: ${contact}`, MX, ly + 3.4); ly += LH; }
  text(`GST No.: ${o.supplier_gstin || ""}`, MX, ly + 3.4); ly += LH;

  const rx = 126;
  const rows = [
    ["PO No", poNo(o.id), true],
    ["PO Date", fmtDay(poDate)],
    ["Quotation Ref.", t.quotation_ref],
    ["Quotation Date", fmtDay(t.quotation_date)],
    ["Our GST No.", st.our_gstin],
  ];
  if (st.validity_days && poDate) rows.push(["Valid till", fmtDay(addDaysYmd(poDate, Number(st.validity_days)))]);
  let ry = y;
  for (const [l, v, bold] of rows) {
    font("normal", 10); text(l, rx, ry + 3.4); text(":", rx + 27, ry + 3.4);
    font(bold ? "bold" : "normal", 10); text(v || "", rx + 30, ry + 3.4);
    ry += LH;
  }
  y = Math.max(ly, ry) + 3;

  font("normal", 10);
  text("Dear Sir,", MX, y + 3.4); y += LH;
  text("We are pleased to place our order for the following items", MX, y + 3.4); y += LH + 2;

  // ---------------- item table ----------------
  const C = { sn: MX + 1.5, part: MX + 11, qtyR: 128, unitC: 139, rateR: 168, amtR: PAGE_W - MX - 1.5 };
  bar("");
  font("bold", 10);
  text("S.N.", C.sn, y + 4.1);
  text("Particulars with Code", C.part, y + 4.1);
  text("Qty", C.qtyR, y + 4.1, { align: "right" });
  text("Unit", C.unitC, y + 4.1, { align: "center" });
  text("Rate / Unit", C.rateR, y + 4.1, { align: "right" });
  text("Amount", C.amtR, y + 4.1, { align: "right" });
  y += 7.5;
  const partLines = String(t.particulars || o.material_name).split(/\n/).flatMap((l) => doc.splitTextToSize(l, 74));
  const sub = o.scope === "delivered" ? "Delivered at our plant" : `Ex-factory${o.source_place ? ` — ${o.source_place}` : ""}`;
  font("normal", 10);
  text("1", C.sn + 1, y + 3.4);
  text(qtyText(fig.qty), C.qtyR, y + 3.4, { align: "right" });
  text(o.purchase_unit || "", C.unitC, y + 3.4, { align: "center" });
  text(num(fig.rate), C.rateR, y + 3.4, { align: "right" });
  text(num(fig.gross), C.amtR, y + 3.4, { align: "right" });
  partLines.forEach((l, i) => { font(i === 0 ? "bold" : "normal", 10); text(l, C.part, y + 3.4); y += LH; });
  font("italic", 9); color(GREY); text(sub, C.part, y + 3.2); color(BLACK); y += LH;
  doc.setDrawColor(190, 190, 190); doc.setLineWidth(0.25); doc.line(MX, y + 1, PAGE_W - MX, y + 1);
  y += 2.5;

  // ---------------- totals ----------------
  const totRows = [];
  if (fig.pct > 0 && fig.included) {
    totRows.push({ label: "Taxable value :", amount: fig.taxable, bold: true });
    fig.lines.forEach((l) => totRows.push({ label: `${l.label} (included)`, amount: l.amount }));
  } else {
    totRows.push({ label: "Total :", amount: fig.taxable, bold: true });
    fig.lines.forEach((l) => totRows.push(l));
  }
  totRows.push({ label: "Total Amount :", amount: fig.total, bold: true, red: true });
  for (const r of totRows) {
    font(r.bold ? "bold" : "normal", 10);
    text(r.label, C.rateR, y + 3.4, { align: "right" });
    if (r.red) color(RED);
    text(num(r.amount), C.amtR, y + 3.4, { align: "right" });
    color(BLACK);
    y += LH;
  }
  y += 1;
  doc.setDrawColor(190, 190, 190); doc.line(MX, y, PAGE_W - MX, y);
  font("bold", 10); text("Amount in words:", MX + 1.5, y + 4.2);
  font("normal", 10);
  const words = doc.splitTextToSize(rupeesInWords(fig.total), CW - 32);
  words.forEach((w, i) => text(w, MX + 30, y + 4.2 + i * LH));
  y += 2 + words.length * LH;
  doc.line(MX, y, PAGE_W - MX, y);
  y += 5;

  // ---------------- addresses ----------------
  const half = (CW - 8) / 2;
  const x2 = MX + half + 8;
  const billing = String(st.billing_address || "").split(/\n/).flatMap((l) => doc.splitTextToSize(l, half - 2));
  const delivery = String(st.delivery_address || "").split(/\n/).flatMap((l) => doc.splitTextToSize(l, half - 2));
  ensure(10 + Math.max(billing.length, delivery.length) * LH + 8);
  bar("Billing Address", MX, half);
  bar("Delivery Address", x2, half);
  y += 7;
  font("normal", 10);
  billing.forEach((l, i) => text(l, MX + 1.5, y + 3.4 + i * LH));
  delivery.forEach((l, i) => text(l, x2 + 1.5, y + 3.4 + i * LH));
  y += Math.max(billing.length, delivery.length) * LH + 2;
  text(`Contact Person: ${t.contact_person || o.requested_by_name || ""}`, MX + 1.5, y + 3.4);
  text(`Contact Number: ${st.contact_phone || ""}`, x2 + 1.5, y + 3.4);
  y += LH + 4;

  // ---------------- terms ----------------
  ensure(34);
  bar("Terms & Conditions");
  y += 7;
  const leftTerms = [["Delivery", t.delivery], ["Payment", t.payment], ["Unloading", t.unloading], ["Taxes", t.taxes]];
  const chequeAmt = String(t.cheque_amount || "").trim();
  const rightTerms = [["Freight", t.freight], ["Cheque No.", t.cheque_no || "—"],
    ["Cheque Amount", chequeAmt ? `₹${num(Number(chequeAmt.replace(/,/g, "")))}` : "—"]];
  function termCol(list, x, labelW, w) {
    let yy = y;
    for (const [l, v] of list) {
      const vs = doc.splitTextToSize(String(v || ""), w - labelW - 4);
      font("normal", 10); text(l, x, yy + 3.4); text(":", x + labelW, yy + 3.4);
      vs.forEach((s, i) => text(s, x + labelW + 3, yy + 3.4 + i * LH));
      yy += Math.max(1, vs.length) * LH;
    }
    return yy;
  }
  y = Math.max(termCol(leftTerms, MX + 1.5, 20, half), termCol(rightTerms, x2 + 1.5, 26, half)) + 2;

  const remarks = String(t.remarks || "").split(/\n/).map((r) => r.trim()).filter(Boolean);
  font("normal", 10);
  text("Other Remarks", MX + 1.5, y + 3.4); text(":", MX + 21.5, y + 3.4);
  if (!remarks.length) y += LH;
  remarks.forEach((r, i) => {
    const ls = doc.splitTextToSize(`${remarks.length > 1 ? `${i + 1}. ` : ""}${r}`, CW - 28);
    ls.forEach((l) => { ensure(LH); text(l, MX + 24.5, y + 3.4); y += LH; });
  });
  y += 5;

  // ---------------- signatory ----------------
  ensure(30);
  font("normal", 10.5); text("For ", MX + 1.5, y + 3.4);
  font("bold", 10.5); text("OUR OWN READY MIX", MX + 1.5 + doc.getTextWidth("For "), y + 3.4);
  y += 20;
  if (approved) {
    font("bold", 10.5); text(String(o.approved_by_name || "").toUpperCase(), MX + 1.5, y + 3.4); y += LH;
    font("normal", 10); color(GREY); text("Administrator", MX + 1.5, y + 3.4); y += LH;
    font("normal", 8.5); text(`Approved in the app on ${o.approved_at_text || fmtDay(o.approved_day)}`, MX + 1.5, y + 3.4);
  } else {
    font("bold", 10); color(RED); text("Not yet approved — draft for reference only", MX + 1.5, y + 3.4);
  }
  color(BLACK);

  // ---------------- footer on every page ----------------
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (footer) {
      const fw = CW, fh = CW * 72 / 1153;
      doc.addImage(footer, "PNG", MX, PAGE_H - 9 - fh, fw, fh);
    }
    if (pages > 1) { font("normal", 8.5); color(GREY); text(`Page ${p} of ${pages}`, PAGE_W - MX, PAGE_H - 4.5, { align: "right" }); }
  }
  return doc;
}

export async function downloadPurchaseOrderPdf(data) {
  const doc = await buildPurchaseOrderPdf(data);
  doc.save(`${poNo(data.order.id)}${data.order.status === "pending_approval" ? "-DRAFT" : ""}.pdf`);
}
