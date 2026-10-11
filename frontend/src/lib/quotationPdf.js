// Round 204 — the Quotation-cum-Agreement as an A4 PDF, laid out as the
// owner's Excel (Quotation_Cum_Agreement__2026_Rev1.1.xlsx): the title and the
// gold logo at the top of every page with the quotation number and date, the
// navy bars, the grade table with base price / GST / total, the numbered terms,
// the signatures, and the company footer strip with "Page n of N".
//
// Page breaks are automatic (owner: in Excel a cell that did not split left
// gaps that had to be arranged by hand). A section heading never sits alone at
// the foot of a page; a long clause carries on to the next page line by line;
// the closing paragraph and the signatures stay together.
//
// jsPDF native drawing (the same approach as the delivery challan), with the
// fonts embedded from /public/fonts so ₹ prints: Poppins for the title (as the
// Excel), Carlito for the body (metrically the Calibri family, close to the
// Excel's Segoe UI and free to embed).
import { jsPDF } from "jspdf";
import { filledTerms, splitRate, inr, inr2, fmtDate, AGREEMENT_TITLES } from "./quotationTerms.js";

const NAVY = [32, 56, 100];
const BLACK = [0, 0, 0];
const GREY = [90, 90, 90];
const PAGE_W = 210;
const PAGE_H = 297;
const MX = 12;
const CW = PAGE_W - MX * 2;
const TOP = 37;            // body starts under the repeated header
const BOTTOM = 270;        // body ends above the footer strip
const BODY_PT = 10;
const LH = 4.55;           // body line height, mm

const cache = {};
async function asBase64(url) {
  if (cache[url]) return cache[url];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const buf = await res.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  cache[url] = btoa(bin);
  return cache[url];
}
async function asDataUrl(url) {
  return `data:image/png;base64,${await asBase64(url)}`;
}

async function registerFonts(doc) {
  const fonts = [
    ["Carlito-Regular.ttf", "Body", "normal"],
    ["Carlito-Bold.ttf", "Body", "bold"],
    ["Carlito-Italic.ttf", "Body", "italic"],
    ["Poppins-Bold.ttf", "Title", "bold"],
    ["Poppins-Medium.ttf", "Title", "normal"],
  ];
  for (const [file, name, style] of fonts) {
    doc.addFileToVFS(file, await asBase64(`/fonts/${file}`));
    doc.addFont(file, name, style);
  }
}

export async function buildQuotationPdf({ quotation: q, settings = {}, defaults = {} }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  await registerFonts(doc);
  const [logo, footer] = await Promise.all([
    asDataUrl("/quote-logo.png").catch(() => null),
    asDataUrl("/quote-footer.png").catch(() => null),
  ]);
  const title = AGREEMENT_TITLES[q.agreement_type] || AGREEMENT_TITLES.default;
  const isPriceOnly = q.agreement_type === "price_only";
  let y = TOP;

  const font = (style = "normal", size = BODY_PT, fam = "Body") => { doc.setFont(fam, style); doc.setFontSize(size); };
  const color = (c) => doc.setTextColor(...c);

  function header() {
    font("bold", 13.5, "Title"); color(BLACK);
    doc.text(title, MX, 16);
    if (logo) doc.addImage(logo, "PNG", PAGE_W - MX - 20, 5, 20, 20);
    doc.setDrawColor(...BLACK); doc.setLineWidth(0.35);
    doc.line(MX, 25.5, PAGE_W - MX, 25.5);
    font("normal", 10.5, "Title");
    doc.text("Quotation/Agreement No.", MX, 31);
    doc.text("Date", 152, 31);
    font("bold", 10.5, "Title");
    doc.text(`: ${q.quote_no}`, MX + 51, 31);
    doc.text(`: ${fmtDate(q.quote_date)}`, 166, 31);
    doc.setLineDashPattern([0.4, 0.6], 0); doc.setLineWidth(0.2);
    doc.line(MX, 33, PAGE_W - MX, 33);
    doc.setLineDashPattern([], 0);
    font();
  }
  function newPage() {
    doc.addPage();
    header();
    y = TOP + 2;
  }
  const ensure = (h) => { if (y + h > BOTTOM) newPage(); };

  // Justified paragraph: every line but the last is stretched to the width.
  // Returns [{ t, end }] — `end` marks the last line of each paragraph
  // (a line break in the clause), which is never stretched.
  function wrap(text, width, style = "normal", size = BODY_PT) {
    font(style, size);
    const out = [];
    for (const piece of String(text || "").split(/\n/)) {
      const ls = doc.splitTextToSize(piece, width);
      ls.forEach((t, i) => out.push({ t, end: i === ls.length - 1 }));
    }
    return out;
  }
  function drawLine(line, x, yy, width, justify) {
    const words = line.trim().split(/\s+/);
    if (!justify || words.length < 2) { doc.text(line.trim(), x, yy); return; }
    const total = words.reduce((t, w) => t + doc.getTextWidth(w), 0);
    const gap = (width - total) / (words.length - 1);
    if (gap > 4) { doc.text(line.trim(), x, yy); return; }  // a short line is not stretched
    let cx = x;
    for (const w of words) { doc.text(w, cx, yy); cx += doc.getTextWidth(w) + gap; }
  }
  function paragraph(text, { x = MX, width = CW, style = "normal", size = BODY_PT, justify = true, after = 1.6, keepLines = 2 } = {}) {
    const lines = wrap(text, width, style, size);
    ensure(Math.min(lines.length, keepLines) * LH);
    font(style, size); color(BLACK);
    lines.forEach((ln) => {
      if (y + LH > BOTTOM) { newPage(); font(style, size); color(BLACK); }
      drawLine(ln.t, x, y + 3.4, width, justify && !ln.end);
      y += LH;
    });
    y += after;
  }
  function bar(label) {
    ensure(8);
    doc.setFillColor(...NAVY); doc.rect(MX, y, CW, 6.2, "F");
    font("bold", 11); color([255, 255, 255]);
    doc.text(label, MX + 2, y + 4.5);
    color(BLACK);
    y += 8;
  }

  // ---------------- page 1 ----------------
  header();
  bar("CUSTOMER");
  const name = (q.billing_name || q.customer_name || "").toUpperCase();
  const addr = (q.billing_address || q.customer_address || "").toUpperCase();
  font("bold", 10.5); doc.text(name, MX + 2, y + 3.4); y += LH + 0.4;
  font("normal", 10);
  for (const ln of doc.splitTextToSize(addr + (q.billing_gstin ? ` (GSTIN : ${q.billing_gstin})` : ""), CW - 4)) {
    doc.text(ln, MX + 2, y + 3.4); y += LH;
  }
  if (q.kind_attention) { doc.text(`KIND ATTENTION : ${q.kind_attention.toUpperCase()}`, MX + 2, y + 3.4); y += LH; }
  y += 2.5;
  font("bold", 10); doc.text("PROJECT / SITE :", MX, y + 3.4);
  font("normal", 10);
  const siteLines = doc.splitTextToSize((q.site_name || "").toUpperCase(), CW - 34);
  siteLines.forEach((ln) => { doc.text(ln, MX + 34, y + 3.4); y += LH; });
  y += 3;
  paragraph("Dear Sir,", { justify: false, after: 0 });
  paragraph("We are thankful to you for showing interest in our Products and considering us to submit the quotation for above project. We are pleased to make the competitive offer for your Project and the details are as below:", { after: 3 });

  // ---------------- the grade table ----------------
  const lines = q.lines || [];
  const showQty = lines.some((l) => Number(l.qty_m3) > 0);
  const qtyLabel = q.agreement_type === "credit_qty" ? "Committed\nQuantity\n(m³)" : "Quantity\n(m³)";
  const cols = [
    { k: "no", w: 8, h: "No" },
    { k: "grade", w: 16, h: "Grade" },
    { k: "spec", w: 0, h: "Specification\n(Cementitious Content) Kgs/m³" },
    ...(showQty ? [{ k: "qty", w: 22, h: qtyLabel }] : []),
    { k: "price", w: 21, h: "Price\nRs./m³" },
    { k: "gst", w: 18, h: `GST\n(18%)` },
    { k: "total", w: 22, h: "Total Rate\nper m³" },
  ];
  const tw = CW - 4;
  cols.find((c) => c.k === "spec").w = tw - cols.reduce((t, c) => t + c.w, 0);
  const tx = MX + 2;
  const headH = 13;
  ensure(headH + 8 * Math.min(lines.length, 3));
  function tableHead() {
    doc.setFillColor(...NAVY); doc.rect(tx, y, tw, headH, "F");
    font("bold", 9.5); color([255, 255, 255]);
    let cx = tx;
    for (const c of cols) {
      const hl = c.h.split("\n");
      const startY = y + headH / 2 - ((hl.length - 1) * 3.6) / 2 + 1.2;
      hl.forEach((t, i) => doc.text(t, cx + c.w / 2, startY + i * 3.6, { align: "center" }));
      cx += c.w;
    }
    color(BLACK);
    y += headH;
  }
  tableHead();
  doc.setDrawColor(...NAVY); doc.setLineWidth(0.3);
  lines.forEach((l, i) => {
    const sp = splitRate(l.rate_total);
    font("normal", 10);
    const specLines = doc.splitTextToSize(l.specification || "", cols.find((c) => c.k === "spec").w - 3);
    const rh = Math.max(7.5, specLines.length * 4.2 + 3.3);
    if (y + rh > BOTTOM) { newPage(); tableHead(); doc.setDrawColor(...NAVY); }
    const vals = {
      no: String(i + 1), grade: l.grade_name || l.item_label || "", spec: specLines,
      qty: Number(l.qty_m3) > 0 ? inr(l.qty_m3) : "", price: inr2(sp.base), gst: inr2(sp.gst), total: inr2(sp.total),
    };
    let cx = tx;
    for (const c of cols) {
      doc.rect(cx, y, c.w, rh);
      font(c.k === "no" ? "bold" : "normal", 10);
      const v = vals[c.k];
      if (Array.isArray(v)) {
        const sy = y + rh / 2 - ((v.length - 1) * 4.2) / 2 + 1.3;
        v.forEach((t, j) => doc.text(t, cx + c.w / 2, sy + j * 4.2, { align: "center" }));
      } else {
        doc.text(String(v), cx + c.w / 2, y + rh / 2 + 1.3, { align: "center" });
      }
      cx += c.w;
    }
    y += rh;
  });
  y += 6;

  // ---------------- the terms ----------------
  const terms = filledTerms(q, defaults);
  if (terms.parties.length) {
    ensure(6 + 3 * LH);
    sectionHead("Parties");
    terms.parties.forEach((p) => paragraph(p));
  }
  function sectionHead(text) {
    font("bold", 11.5); color(BLACK);
    doc.text(text, MX, y + 4);
    doc.setDrawColor(...NAVY); doc.setLineWidth(0.4);
    doc.line(MX, y + 5.4, PAGE_W - MX, y + 5.4);
    y += 7;
  }
  const NUMW = 10;
  function clause(c) {
    if (c.kind === "bank") { bankTable(c.no); return; }
    const textLines = wrap(c.text, CW - NUMW);
    ensure(Math.min(textLines.length, 2) * LH);
    font("bold", BODY_PT); color(BLACK);
    doc.text(String(c.no || ""), MX + NUMW / 2 - 0.5, y + 3.4, { align: "center" });
    font("normal", BODY_PT);
    textLines.forEach((ln) => {
      if (y + LH > BOTTOM) { newPage(); font("normal", BODY_PT); color(BLACK); }
      drawLine(ln.t, MX + NUMW, y + 3.4, CW - NUMW, !ln.end);
      y += LH;
    });
    y += 1.7;
  }
  function bankTable(no) {
    const accts = (settings.bank_accounts || []).filter((a) => a.number || a.upi);
    const bankRows = accts.filter((a) => a.number);
    const upi = accts.find((a) => a.upi);
    const h = 6 + bankRows.length * 6 + (upi ? 6 : 0) + 2;
    ensure(h);
    font("bold", BODY_PT);
    doc.text(String(no || ""), MX + NUMW / 2 - 0.5, y + 3.4, { align: "center" });
    doc.text("Bank Account Details", MX + NUMW, y + 3.4);
    y += 5.5;
    const bc = [
      { h: "Account Name", w: 46, k: "name" }, { h: "Account No.", w: 38, k: "number" },
      { h: "IFSC", w: 30, k: "ifsc" }, { h: "Bank & Branch", w: CW - NUMW - 114, k: "bank" },
    ];
    let cx = MX + NUMW;
    doc.setFillColor(...NAVY); doc.rect(cx, y, CW - NUMW, 5.6, "F");
    font("bold", 9.5); color([255, 255, 255]);
    for (const c of bc) { doc.text(c.h, cx + 2, y + 3.9); cx += c.w; }
    color(BLACK); y += 5.6;
    doc.setDrawColor(...NAVY); doc.setLineWidth(0.25);
    for (const a of bankRows) {
      cx = MX + NUMW;
      for (const c of bc) {
        doc.rect(cx, y, c.w, 6);
        font(c.k === "number" ? "bold" : "normal", 9.5);
        doc.text(doc.splitTextToSize(String(a[c.k] || ""), c.w - 3)[0] || "", cx + 2, y + 4.1);
        cx += c.w;
      }
      y += 6;
    }
    if (upi) {
      font("normal", 9.5);
      doc.text("UPI ID : ", MX + NUMW, y + 4.3);
      font("bold", 9.5);
      doc.text(upi.upi, MX + NUMW + doc.getTextWidth("UPI ID : ") + 1, y + 4.3);
      y += 6;
    }
    y += 2;
  }

  for (const s of terms.sections) {
    // A heading never ends a page on its own: room for it and two lines.
    ensure(7 + 2 * LH + 2);
    sectionHead(`${s.no ? `${s.no}. ` : ""}${s.title}`);
    for (const c of s.clauses) clause(c);
    y += 1;
  }

  // ---------------- closing and signatures, kept together ----------------
  const closingH = terms.closing.reduce((t, p) => t + wrap(p, CW).length * LH + 1.6, 0);
  const sigH = 36;
  if (y + closingH + sigH > BOTTOM) {
    // Keep the last paragraph with the signatures; earlier ones may stay.
    const lastH = terms.closing.length ? wrap(terms.closing[terms.closing.length - 1], CW).length * LH + 1.6 : 0;
    terms.closing.slice(0, -1).forEach((p) => paragraph(p));
    if (y + lastH + sigH > BOTTOM) newPage();
    if (terms.closing.length) paragraph(terms.closing[terms.closing.length - 1]);
  } else {
    y += 2;
    terms.closing.forEach((p) => paragraph(p));
  }
  y += 3;
  const sy = y;
  font("bold", 10); color(BLACK);
  doc.text("For Our Own Ready Mix", MX, sy + 3.4);
  if (settings.signature_image) {
    try { doc.addImage(settings.signature_image, MX, sy + 5, 30, 13); } catch { /* a bad image never blocks the print */ }
  }
  font("bold", 10);
  doc.text(settings.director_name || "", MX, sy + 24);
  font("normal", 10);
  doc.text(settings.director_title || "Director", MX, sy + 28.5);
  if (settings.director_phone) doc.text(`Mob: ${settings.director_phone}`, MX, sy + 33);
  if (!isPriceOnly) {
    const rx = 122;
    font("bold", 10);
    doc.text("Accepted by the Customer", rx, sy + 3.4);
    doc.setDrawColor(...GREY); doc.setLineWidth(0.2);
    doc.line(rx, sy + 20, PAGE_W - MX, sy + 20);
    font("normal", 9.5); color(GREY);
    doc.text("Signature, name & seal", rx, sy + 24);
    doc.text("Date:", rx, sy + 30);
    color(BLACK);
  }
  y = sy + sigH;

  // ---------------- footer on every page ----------------
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (footer) {
      const fw = 203.5, fh = 12.7;
      doc.addImage(footer, "PNG", (PAGE_W - fw) / 2, PAGE_H - 8.5 - fh, fw, fh);
    }
    font("normal", 9); color(BLACK);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MX + 2, PAGE_H - 4.5, { align: "right" });
  }
  return doc;
}

export async function downloadQuotationPdf(data) {
  const doc = await buildQuotationPdf(data);
  doc.save(`${data.quotation.quote_no}.pdf`);
}

export async function quotationPdfBlobUrl(data) {
  const doc = await buildQuotationPdf(data);
  return URL.createObjectURL(doc.output("blob"));
}
