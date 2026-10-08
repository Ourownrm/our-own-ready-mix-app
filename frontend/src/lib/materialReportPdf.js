// Round 166 — a small shared helper that turns a Material Module table into a
// printable PDF. Built on jsPDF + jspdf-autotable (already used across the app)
// so the output is native vector text, not a screenshot: it prints crisply and
// stays small.
//
// The three callers (Stock, Receipts, Physical Stock) pass their own columns,
// rows and totals — this only owns the plant letterhead, the title/meta block,
// the table styling and the page footer, so the three reports look like one
// family and match the delivery-note / cube-test PDFs already in the app.
//
// `columns`: [{ header, align?, width? }]
// `rows`:    array of arrays of cell strings (same length as columns)
// `foot`:    optional array of arrays for a bold totals band
// `meta`:    optional array of "Label: value" strings shown under the title
//            (the active filters — month, date range — so a printed sheet says
//            what it is a sheet OF).

const PLANT_NAME = "OUR OWN READY MIX";
const PLANT_ADDR = "Plot No. 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala. 671321.";
const PLANT_GSTIN = "GSTIN : 32AAGFO7545J1Z2";

function nowStamp() {
  return new Date().toLocaleString([], {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// Round 193 — jsPDF's built-in Helvetica has no rupee glyph (₹ printed as a
// stray character) and no Unicode minus. Every string drawn goes through this,
// so all the Material Module prints read "Rs." instead.
function pdfText(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/₹\s?/g, "Rs. ").replace(/\u2212/g, "-");
}
const clean = (table) => table.map((row) => row.map(pdfText));

// `extraTables` (Round 193): more tables drawn after the main one, each with
// its own heading — [{ title, columns, rows, foot }] — for a statement that has
// more than one list on it (the supplier ledger: entries, open bills, loads
// not yet billed).
export async function printMaterialReport({ title, meta = [], columns, rows, foot = [], landscape = false, filename, extraTables = [] }) {
  const { jsPDF } = await import("jspdf");
  // jspdf-autotable registers `doc.autoTable(...)` on the jsPDF prototype when
  // imported. Its default export shape differs across builds (function vs a
  // wrapped object), so we do NOT call the default directly — we import for the
  // side effect and use `doc.autoTable`, falling back to applyPlugin if a build
  // ever skips the auto-registration.
  const autoTableMod = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
  if (typeof doc.autoTable !== "function") {
    const apply = autoTableMod.applyPlugin || (autoTableMod.default && autoTableMod.default.applyPlugin);
    if (typeof apply === "function") apply(jsPDF);
  }
  const PAGE_W = doc.internal.pageSize.getWidth();
  const MARGIN_X = 12;
  let y = 14;

  // ---- letterhead ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(PLANT_NAME, PAGE_W / 2, y, { align: "center" });
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.text(PLANT_ADDR, PAGE_W / 2, y, { align: "center" });
  y += 3.6;
  doc.text(PLANT_GSTIN, PAGE_W / 2, y, { align: "center" });
  y += 6;

  // ---- title + meta ----
  doc.setDrawColor(199, 91, 18); // --rebar
  doc.setLineWidth(0.5);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  y += 5.5;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(pdfText(title), MARGIN_X, y);
  // generated-on, right aligned on the same line
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const stamp = `Generated ${nowStamp()}`;
  doc.text(stamp, PAGE_W - MARGIN_X, y, { align: "right" });
  y += 5;

  if (meta.length) {
    doc.setFontSize(9);
    doc.setTextColor(90);
    const metaLines = doc.splitTextToSize(pdfText(meta.join("      ")), PAGE_W - 2 * MARGIN_X);
    doc.text(metaLines, MARGIN_X, y);
    y += (metaLines.length - 1) * 4;
    doc.setTextColor(0);
    y += 4.5;
  }

  // ---- table ----
  const drawFooter = () => {
    const h = doc.internal.pageSize.getHeight();
    const page = doc.internal.getNumberOfPages();
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(120);
    doc.text("Our Own Ready Mix - operations app", MARGIN_X, h - 6);
    doc.text(`Page ${page}`, PAGE_W - MARGIN_X, h - 6, { align: "right" });
    doc.setTextColor(0);
  };
  doc.autoTable({
    startY: y + 1,
    head: [columns.map((c) => pdfText(c.header))],
    body: clean(rows),
    foot: foot.length ? clean(foot) : undefined,
    margin: { left: MARGIN_X, right: MARGIN_X },
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 1.8, overflow: "linebreak", lineColor: [222, 218, 209], lineWidth: 0.1 },
    headStyles: { fillColor: [34, 38, 43], textColor: 255, fontStyle: "bold", fontSize: 8.5 },
    footStyles: { fillColor: [243, 241, 236], textColor: [34, 38, 43], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [249, 248, 245] },
    columnStyles: Object.fromEntries(
      columns.map((c, i) => [i, { halign: c.align || "left", ...(c.width ? { cellWidth: c.width } : {}) }])
    ),
    didDrawPage: drawFooter,
  });

  for (const t of extraTables) {
    if (!t || !t.rows || !t.rows.length) continue;
    let ty = doc.lastAutoTable.finalY + 8;
    if (ty > doc.internal.pageSize.getHeight() - 30) { doc.addPage(); ty = 16; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(pdfText(t.title), MARGIN_X, ty);
    doc.autoTable({
      startY: ty + 2,
      head: [t.columns.map((c) => pdfText(c.header))],
      body: clean(t.rows),
      foot: t.foot && t.foot.length ? clean(t.foot) : undefined,
      margin: { left: MARGIN_X, right: MARGIN_X, bottom: 14 },
      styles: { font: "helvetica", fontSize: 8, cellPadding: 1.6, overflow: "linebreak", lineColor: [222, 218, 209], lineWidth: 0.1 },
      headStyles: { fillColor: [91, 100, 112], textColor: 255, fontStyle: "bold", fontSize: 8 },
      footStyles: { fillColor: [243, 241, 236], textColor: [34, 38, 43], fontStyle: "bold" },
      columnStyles: Object.fromEntries(t.columns.map((c, i) => [i, { halign: c.align || "left", ...(c.width ? { cellWidth: c.width } : {}) }])),
      didDrawPage: drawFooter,
    });
  }

  doc.save(filename || `${title.replace(/[^\w]+/g, "-").toLowerCase()}.pdf`);
}
