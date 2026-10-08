// Round 194 — the raw material test report, A4, one per test card.
//
// Same visual family as cubeTestPdf.js (letterhead, red rule, spec grid, navy
// TEST SUMMARY bar, red STANDARDS FOLLOWED table, signatures, navy footer with
// the plant's form number), built on jsPDF + jspdf-autotable like
// materialReportPdf.js so it is native vector text.
//
// "Approved by" is the Administrator who approved the card in the app — the
// name comes from the approving account (approved_by_name), never typed. An
// unapproved card prints, but says DRAFT — NOT APPROVED across the signature
// block, so a draft can never pass for a filed report.
//
// Every figure printed is the SERVER's stored calculation (card.result), not a
// fresh one from the browser. The readings table shows exactly what the lab
// typed.
//
// jsPDF's standard fonts cannot draw ≤ ≥ ² µ ₂ reliably, so every string goes
// through pdfText() first (the project's ASCII-only rule for PDFs).
import { TEST_DEFS, rowsFor, VERDICT_LABEL } from "./rmTestDefs.js";

const NAVY = [31, 59, 92];
const RED = [176, 35, 29];
const GREEN = [29, 122, 85];
const ALERT = [176, 58, 46];
const SLATE = [91, 100, 112];
const CHARCOAL = [34, 38, 43];
const BORDER = [222, 218, 209];
const HEAD_TINT = [246, 233, 232];
const AMBER = [156, 107, 18];

const PAGE_W = 210;
const MARGIN_X = 12;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const FOOTER_Y = 285;

export function pdfText(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/≤/g, "<=").replace(/≥/g, ">=")
    .replace(/µm/g, " micron").replace(/µ/g, "micro")
    .replace(/m²/g, "m2").replace(/mm²/g, "mm2").replace(/²/g, "2").replace(/³/g, "3")
    .replace(/₂/g, "2").replace(/₄/g, "4")
    .replace(/×/g, "x").replace(/−/g, "-").replace(/[–—]/g, "-")
    .replace(/·/g, "|").replace(/→/g, "->").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/  +/g, " ");
}

async function loadLogoBase64() {
  const res = await fetch("/logo.jpg");
  if (!res.ok) throw new Error("logo not found");
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function fmtDate(d) {
  if (!d) return "-";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}
function fmtDateTime(d) {
  if (!d) return "-";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
function cellValue(v, dp) {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "number" && dp !== undefined) return v.toFixed(dp);
  return String(v);
}

function drawHeader(doc, card, def, logoData) {
  let y = 16;
  if (logoData) {
    try { doc.addImage(logoData, "JPEG", MARGIN_X, y - 9.75, 16.5, 16.5); } catch { /* ignore bad image */ }
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...SLATE);
  doc.text("Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala.", MARGIN_X + 20.5, y - 4);
  doc.text("+91 83 4007 4006  |  mail@ourownrm.com", MARGIN_X + 20.5, y);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...RED);
  doc.text("OUR OWN READY-MIX", PAGE_W - MARGIN_X, y - 6, { align: "right" });
  doc.setFontSize(10);
  doc.setTextColor(...CHARCOAL);
  const title = pdfText(card.test_label || def.label).toUpperCase();
  const tl = doc.splitTextToSize(title, 110);
  doc.text(tl[0], PAGE_W - MARGIN_X, y - 1, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.setTextColor(...SLATE);
  doc.text(pdfText(def.method), PAGE_W - MARGIN_X, y + 3.5, { align: "right" });

  y += 9;
  doc.setDrawColor(...RED);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  doc.setLineWidth(0.2);
  y += 6;

  const specs = [
    ["Material", card.material_name],
    ["Supplier / source", card.supplier_name || (card.source === "scheduled" ? "Stock pile (scheduled)" : "-")],
    ["Truck no.", card.vehicle_number || "-"],
    ["GRN / received", card.receipt_id ? `R-${String(card.receipt_id).padStart(5, "0")}  ${fmtDate(card.received_date)}` : "-"],
    ["Sampled by", card.sampled_by || "-"],
    ["Sampled on", fmtDateTime(card.sampled_at)],
    ["Date of testing", fmtDate(card.tested_on)],
    ["Report no.", card.report_no],
  ];
  const rh = 8.6;
  const cw = CONTENT_W / 4;
  const rows = Math.ceil(specs.length / 4);
  doc.setDrawColor(...BORDER);
  doc.rect(MARGIN_X, y, CONTENT_W, rh * rows);
  specs.forEach((s, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const cx = MARGIN_X + col * cw;
    const cy = y + row * rh;
    if (col > 0) doc.line(cx, y, cx, y + rh * rows);
    if (row > 0) doc.line(MARGIN_X, cy, MARGIN_X + CONTENT_W, cy);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.6);
    doc.setTextColor(...SLATE);
    doc.text(s[0].toUpperCase(), cx + 2.2, cy + 3.5);
    doc.setFontSize(8.2);
    doc.setTextColor(...CHARCOAL);
    doc.text(doc.splitTextToSize(pdfText(s[1]), cw - 4.4)[0] || "-", cx + 2.2, cy + rh - 2.2);
  });
  return y + rh * rows + 5;
}

function drawFooter(doc, card, page, pages) {
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, FOOTER_Y, CONTENT_W, 5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.6);
  doc.setTextColor(220, 228, 236);
  doc.text(pdfText(card.form_no || "FORM NO. NOT ASSIGNED"), MARGIN_X + 3, FOOTER_Y + 3.4);
  doc.text(`REPORT NO. ${pdfText(card.report_no)}  |  R00/21-03-2025`, PAGE_W / 2, FOOTER_Y + 3.4, { align: "center" });
  doc.text(`REV. 0  |  PAGE ${page} OF ${pages}`, PAGE_W - MARGIN_X - 3, FOOTER_Y + 3.4, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.2);
  doc.setTextColor(...SLATE);
  doc.text(
    "Our Own Ready Mix, Plot No 3C-2, Industrial Area, Ananthapuram, Kasaragod, Kerala, India - 671321  |  +91 83 4007 4006  |  mail@ourownrm.com",
    PAGE_W / 2, FOOTER_Y + 8.5, { align: "center" }
  );
}

function sectionTitle(doc, y, text, color = NAVY) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.4);
  doc.setTextColor(...color);
  doc.text(text, MARGIN_X, y);
  return y + 2;
}

// The readings as the lab typed them, plus the server's computed columns.
function readingsTable(card, def) {
  const params = card.params || {};
  const rows = rowsFor(card.test_code, params);
  const cells = (card.result && card.result.cells) || {};
  const grid = (card.readings && card.readings.grid) || {};
  const label = (f) => pdfText(f.label + (f.unit ? ` (${f.unit})` : ""));
  const val = (r, f) => {
    if (f.input) return pdfText(cellValue(grid[r.key] && grid[r.key][f.key]));
    const c = cells[r.key] || {};
    return pdfText(cellValue(c[f.key], f.dp));
  };
  if (def.layout === "trials") {
    return {
      head: [["Description", ...rows.map((r) => r.label)]],
      body: def.fields.map((f) => [label(f), ...rows.map((r) => val(r, f))]),
      firstColWidth: 92,
    };
  }
  if (def.layout === "rows") {
    return {
      head: [[def.code.startsWith("sieve") ? "IS sieve" : def.code === "cement_strength" ? "Age" : "Fraction", ...def.fields.map(label)]],
      body: rows.map((r) => [pdfText(r.label), ...def.fields.map((f) => val(r, f))]),
      firstColWidth: 26,
    };
  }
  return null;
}

export async function generateRmTestPdf(card, { save = true } = {}) {
  const def = TEST_DEFS[card.test_code];
  if (!def) throw new Error("Unknown test");
  const { jsPDF } = await import("jspdf");
  const autoTableMod = await import("jspdf-autotable");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  if (typeof doc.autoTable !== "function") {
    const apply = autoTableMod.applyPlugin || (autoTableMod.default && autoTableMod.default.applyPlugin);
    if (apply) apply(jsPDF);
  }
  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* print without */ }

  const result = card.result || { results: [], warnings: [] };
  let y = drawHeader(doc, card, def, logoData);
  const ensureSpace = (needed) => {
    if (y + needed > FOOTER_Y - 4) {
      doc.addPage();
      y = 20;
    }
  };

  // ---- TEST SUMMARY bar ----
  const verdict = card.verdict;
  const vColor = verdict === "conforms" ? GREEN : verdict === "non_conforming" ? ALERT : SLATE;
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, y, CONTENT_W, 7, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.4);
  doc.setTextColor(255, 255, 255);
  doc.text("TEST SUMMARY", MARGIN_X + 3, y + 4.7);
  const vText = (VERDICT_LABEL[verdict] || "INCOMPLETE").toUpperCase();
  doc.setFontSize(7.6);
  const vW = doc.getTextWidth(vText) + 8;
  doc.setFillColor(...vColor);
  doc.roundedRect(PAGE_W - MARGIN_X - vW - 2, y + 1.1, vW, 4.8, 2, 2, "F");
  doc.text(vText, PAGE_W - MARGIN_X - 2 - vW / 2, y + 4.5, { align: "center" });
  y += 9;

  // Head values (sample weight, cast date, Blaine, external lab details...)
  const headVals = (def.head || [])
    .map((f) => [f.label, card.readings && card.readings.head ? card.readings.head[f.key] : null, f])
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([l, v, f]) => {
      let shown = String(v);
      if (f.type === "select") shown = (f.options.find(([o]) => o === v) || [v, v])[1];
      return [pdfText(l), pdfText(shown + (f.unit ? " " + f.unit : ""))];
    });

  // ---- headline results ----
  const resRows = (result.results || []).map((r) => [
    pdfText(r.label),
    pdfText(r.text ? r.value : cellValue(r.value, r.dp) + (r.unit ? " " + r.unit : "") + (r.note ? " " + r.note : "")),
    pdfText(r.limit || "-"),
    r.ok === true ? "Within" : r.ok === false ? "Outside" : "-",
  ]);
  doc.autoTable({
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X, bottom: 16 },
    head: [["Result", "Value", "Requirement", "Check"]],
    body: [...headVals.map(([l, v]) => [l, v, "", ""]), ...resRows],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 8.4, cellPadding: 1.8, lineColor: BORDER, textColor: CHARCOAL },
    headStyles: { fillColor: [238, 242, 246], textColor: SLATE, fontStyle: "bold", fontSize: 7.4 },
    columnStyles: { 0: { cellWidth: 70 }, 1: { fontStyle: "bold" }, 3: { cellWidth: 20 } },
    didParseCell: (d) => {
      if (d.section === "body" && d.column.index === 3) {
        if (d.cell.raw === "Within") d.cell.styles.textColor = GREEN;
        if (d.cell.raw === "Outside") { d.cell.styles.textColor = ALERT; d.cell.styles.fontStyle = "bold"; }
      }
    },
  });
  y = doc.lastAutoTable.finalY + 5;

  // ---- readings ----
  const rt = readingsTable(card, def);
  if (rt) {
    ensureSpace(20);
    y = sectionTitle(doc, y, "READINGS");
    doc.autoTable({
      startY: y + 1,
      margin: { left: MARGIN_X, right: MARGIN_X, bottom: 16 },
      head: rt.head,
      body: rt.body,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 7.8, cellPadding: 1.6, lineColor: BORDER, textColor: CHARCOAL, halign: "right" },
      headStyles: { fillColor: [238, 242, 246], textColor: SLATE, fontStyle: "bold", fontSize: 7, halign: "right" },
      columnStyles: { 0: { halign: "left", cellWidth: rt.firstColWidth } },
      didParseCell: (d) => {
        if (d.column.index === 0) d.cell.styles.halign = "left";
        if (d.section === "body" && d.cell.raw === "Outside") { d.cell.styles.textColor = ALERT; d.cell.styles.fontStyle = "bold"; }
        if (d.section === "body" && d.cell.raw === "Within") d.cell.styles.textColor = GREEN;
      },
    });
    y = doc.lastAutoTable.finalY + 4;
  }

  if ((result.warnings || []).length) {
    ensureSpace(6 + result.warnings.length * 4);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.4);
    doc.setTextColor(...AMBER);
    for (const w of result.warnings) {
      const lines = doc.splitTextToSize("Note: " + pdfText(w), CONTENT_W);
      doc.text(lines, MARGIN_X, y + 2);
      y += lines.length * 3.4;
    }
    y += 2;
  }

  // ---- standards followed ----
  ensureSpace(28);
  y = sectionTitle(doc, y + 1, "STANDARDS FOLLOWED", RED);
  doc.autoTable({
    startY: y + 1,
    margin: { left: MARGIN_X, right: MARGIN_X, bottom: 16 },
    head: [["Reference", "Used for"]],
    body: [
      [pdfText(def.method), "Method of test"],
      [pdfText(def.spec), "Acceptance"],
      ["IS 4926:2003, Annex B", pdfText("Test frequency - " + (card.reason || "as planned"))],
    ],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 7.8, cellPadding: 1.6, lineColor: [231, 207, 204], textColor: CHARCOAL },
    headStyles: { fillColor: HEAD_TINT, textColor: RED, fontStyle: "bold", fontSize: 7.2 },
    columnStyles: { 0: { cellWidth: 92 } },
  });
  y = doc.lastAutoTable.finalY + 5;

  // ---- remarks ----
  const remarkText = [
    card.summary ? (verdict === "conforms" ? "Result obtained satisfactory as per the specified IS limit: " : verdict === "non_conforming" ? "Result does NOT meet the specified limit: " : "Result recorded: ") + card.summary + "." : null,
    card.remarks || null,
    card.equipment ? "Equipment: " + card.equipment : null,
  ].filter(Boolean).map(pdfText).join("\n");
  const remarkLines = doc.splitTextToSize(remarkText || "-", CONTENT_W - 6);
  ensureSpace(12 + remarkLines.length * 3.6);
  doc.setDrawColor(...BORDER);
  doc.rect(MARGIN_X, y, CONTENT_W, 7 + remarkLines.length * 3.6);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.setTextColor(...NAVY);
  doc.text("REMARKS", MARGIN_X + 3, y + 4);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...CHARCOAL);
  doc.text(remarkLines, MARGIN_X + 3, y + 8);
  y += 10 + remarkLines.length * 3.6;

  // ---- signatures ----
  ensureSpace(26);
  const sy = Math.max(y + 8, FOOTER_Y - 30);
  const half = CONTENT_W / 2;
  doc.setDrawColor(...CHARCOAL);
  doc.setLineWidth(0.3);
  doc.line(MARGIN_X, sy, MARGIN_X + half - 8, sy);
  doc.line(MARGIN_X + half + 8, sy, PAGE_W - MARGIN_X, sy);
  doc.setLineWidth(0.2);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...CHARCOAL);
  doc.text("Tested by: Lab Technician", MARGIN_X, sy + 4.5);
  doc.text("Approved by: Administrator", MARGIN_X + half + 8, sy + 4.5);
  doc.setFont("helvetica", "normal");
  doc.text(pdfText(card.submitted_by_name || card.started_by_name || "-"), MARGIN_X, sy + 9);
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  doc.text(card.submitted_at ? "Submitted " + fmtDateTime(card.submitted_at) : "Not yet submitted", MARGIN_X, sy + 13);
  if (card.status === "approved" && card.approved_by_name) {
    doc.setFontSize(8);
    doc.setTextColor(...CHARCOAL);
    doc.text(pdfText(card.approved_by_name), MARGIN_X + half + 8, sy + 9);
    doc.setFontSize(7);
    doc.setTextColor(...SLATE);
    doc.text("Approved in the app " + fmtDateTime(card.approved_at), MARGIN_X + half + 8, sy + 13);
    // A drawn stamp, like the plant's rubber stamp on the paper forms.
    const cx = PAGE_W - MARGIN_X - 12, cy = sy - 6;
    doc.setDrawColor(62, 92, 138);
    doc.setLineWidth(0.5);
    doc.circle(cx, cy, 10);
    doc.circle(cx, cy, 8.6);
    doc.setLineWidth(0.2);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(5.2);
    doc.setTextColor(62, 92, 138);
    doc.text("OUR OWN", cx, cy - 3.2, { align: "center" });
    doc.text("READY MIX", cx, cy - 0.8, { align: "center" });
    doc.setFontSize(6);
    doc.text("APPROVED", cx, cy + 2.2, { align: "center" });
    doc.setFontSize(4.6);
    doc.text("KASARAGOD", cx, cy + 4.6, { align: "center" });
  } else {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...ALERT);
    doc.text("DRAFT - NOT APPROVED", MARGIN_X + half + 8, sy + 9.5);
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawFooter(doc, card, p, pages);
  }

  const fname = `${(card.report_no || "RMT").replace(/\//g, "-")}_${pdfText(card.test_label || def.short).replace(/[^A-Za-z0-9]+/g, "_")}.pdf`;
  if (save) doc.save(fname);
  return doc;
}
