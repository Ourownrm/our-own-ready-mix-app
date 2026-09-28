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

export async function printMaterialReport({ title, meta = [], columns, rows, foot = [], landscape = false, filename }) {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
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
  doc.text(title, MARGIN_X, y);
  // generated-on, right aligned on the same line
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const stamp = `Generated ${nowStamp()}`;
  doc.text(stamp, PAGE_W - MARGIN_X, y, { align: "right" });
  y += 5;

  if (meta.length) {
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text(meta.join("      "), MARGIN_X, y);
    doc.setTextColor(0);
    y += 4.5;
  }

  // ---- table ----
  autoTable(doc, {
    startY: y + 1,
    head: [columns.map((c) => c.header)],
    body: rows,
    foot: foot.length ? foot : undefined,
    margin: { left: MARGIN_X, right: MARGIN_X },
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 1.8, overflow: "linebreak", lineColor: [222, 218, 209], lineWidth: 0.1 },
    headStyles: { fillColor: [34, 38, 43], textColor: 255, fontStyle: "bold", fontSize: 8.5 },
    footStyles: { fillColor: [243, 241, 236], textColor: [34, 38, 43], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [249, 248, 245] },
    columnStyles: Object.fromEntries(
      columns.map((c, i) => [i, { halign: c.align || "left", ...(c.width ? { cellWidth: c.width } : {}) }])
    ),
    didDrawPage: () => {
      // page footer
      const h = doc.internal.pageSize.getHeight();
      const page = doc.internal.getNumberOfPages();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(120);
      doc.text("Our Own Ready Mix — operations app", MARGIN_X, h - 6);
      doc.text(`Page ${page}`, PAGE_W - MARGIN_X, h - 6, { align: "right" });
      doc.setTextColor(0);
    },
  });

  doc.save(filename || `${title.replace(/[^\w]+/g, "-").toLowerCase()}.pdf`);
}
