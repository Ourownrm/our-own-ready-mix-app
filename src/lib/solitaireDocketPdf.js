// TEMPORARY docket PDF generator — jsPDF native drawing, following this
// app's own established pattern (see lib/deliveryChallanPdf.js,
// mixDesignPdf.js, cubeTestPdf.js).
//
// THIS IS A PLACEHOLDER, NOT THE REAL REPORT. Per 03_EXCEL_PRINT_PIPELINE.md,
// the actual "Docket / Batch Report / Autographic Record" must be produced
// by filling cells in the client's real Excel workbook and exporting it —
// "never re-implement the workbook's calculations in application code." That
// pipeline needs the updated workbook (sheets "1"-"10"), which has not been
// provided yet, plus a server-side spreadsheet engine (e.g. LibreOffice
// headless) to do the fill-and-export. This generator exists only so the
// data-entry → confirm → print flow is usable end-to-end today; every PDF
// it produces is flagged is_placeholder_pdf = true in the database (see
// routes/solitaire.js) so it's obvious in Search/Reprint which dockets used
// this interim renderer. Layout/math below mirrors 06_mockup_v7.html's own
// buildDocketHtml() function exactly (including the intentionally-kept
// RAND()-based Set/Actual weight variance — 03_EXCEL_PRINT_PIPELINE.md says
// explicitly not to change that), NOT the real Excel sheet's exact visual
// layout (07_sample_docket_from_real_excel.pdf) — reproducing that exactly
// is the whole point of building the real pipeline once the workbook exists.
//
// DELETE THIS FILE'S CALL SITE (not necessarily the file — old dockets still
// need to render their stored PDF) once the real Excel pipeline exists, and
// point the print flow at that instead.

const PAGE_W = 210;
const MARGIN_X = 14;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BLACK = [0, 0, 0];
const GRAY = [90, 90, 90];

function fmt(v, dp) {
  const n = Number(v) || 0;
  return (Math.abs(n) < 0.005 && dp > 0) ? (0).toFixed(dp) : n.toFixed(dp);
}

export function computeSheetNumber(prodQty, mixerCap) {
  const qty = Number(prodQty) || 0;
  const cap = Number(mixerCap) || 0;
  if (cap <= 0) return 1;
  return Math.min(10, Math.max(1, Math.ceil(qty / cap)));
}

// Returns { filename, base64 } — base64 is what gets POSTed to
// /api/solitaire/dockets; the caller may also doc.save() a local copy for
// the operator's own immediate print, same as this app's other PDFs do.
export async function generateSolitaireDocketPdf({
  batchNumber, orderQty, withThisLoad, customer, site, mixDesign, truck, driverName,
  prodQty, mixerCap, plantSerialNumber = "160",
}) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const n = computeSheetNumber(prodQty, mixerCap); // sheet_number / batch count — §6
  const batchSize = n > 0 ? prodQty / n : 0;
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  let y = 16;
  doc.setFont("times", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...BLACK);
  doc.text("OUR OWN RMC", PAGE_W / 2, y, { align: "center" });
  y += 8;
  doc.setFontSize(11);
  doc.text("MCI 370 Control System Ver 3.1", MARGIN_X, y);
  y += 4.5;
  doc.setFont("times", "normal");
  doc.setFontSize(9.5);
  doc.text("SCHWING", MARGIN_X, y);
  y += 4;
  doc.text("Stetter", MARGIN_X, y);
  y += 2;
  doc.setFont("times", "bold");
  doc.setFontSize(11.5);
  doc.text("Docket / Batch Report / Autographic Record", PAGE_W / 2, y + 3, { align: "center" });
  y += 10;

  // ---- Batch Date/Start/End + Plant Serial ----
  doc.setFont("times", "bold");
  doc.setFontSize(9.5);
  doc.text(`Batch Date`, MARGIN_X, y);
  doc.setFont("times", "normal");
  doc.text(`: ${dateStr}`, MARGIN_X + 26, y);
  doc.setFont("times", "bold");
  doc.text("Plant Serial Number :", PAGE_W - MARGIN_X - 45, y);
  doc.setFont("times", "normal");
  doc.text(String(plantSerialNumber), PAGE_W - MARGIN_X - 8, y, { align: "right" });
  y += 4.5;
  doc.setFont("times", "bold");
  doc.text("Batch Start Time", MARGIN_X, y);
  doc.setFont("times", "normal");
  doc.text(`: ${now.toLocaleTimeString()}`, MARGIN_X + 26, y);
  y += 4.5;
  doc.setFont("times", "bold");
  doc.text("Batch End Time", MARGIN_X, y);
  doc.setFont("times", "normal");
  doc.text(`: ${now.toLocaleTimeString()}`, MARGIN_X + 26, y);
  y += 7;

  // ---- kv-grid, 2 columns x 8 rows, matching buildDocketHtml()'s field order ----
  const leftRows = [
    ["Batch Number / Docket Number", batchNumber],
    ["Customer", customer?.name || "—"],
    ["Site", site?.name || "—"],
    ["Recipe Code", mixDesign?.code || "—"],
    ["Recipe Name", mixDesign?.name || "—"],
    ["Truck Number", truck?.registration_number || "—"],
    ["Truck Driver", driverName || truck?.driver_name || "—"],
    ["Order Number", customer?.name || "—"],
  ];
  const rightRows = [
    ["Ordered Quantity", `${fmt(orderQty, 2)} M³`],
    ["Production Quantity", `${fmt(prodQty, 2)} M³`],
    ["Adj/Manual Quantity", "0.00 M³"],
    ["With This Load", `${fmt(withThisLoad, 2)} M³`],
    ["Mixer Capacity", `${fmt(mixerCap, 2)} M³`],
    ["Batch Size", `${fmt(batchSize, 2)} M³`],
    ["Net Wt from W.Bridge", "0 Kg"],
    ["Batcher Name", "Stetter"],
  ];
  const colW = CONTENT_W / 2;
  doc.setFontSize(8.8);
  for (let i = 0; i < 8; i++) {
    const rowY = y + i * 4.6;
    doc.setFont("times", "bold");
    doc.text(leftRows[i][0], MARGIN_X, rowY);
    doc.setFont("times", "normal");
    doc.text(`: ${leftRows[i][1]}`, MARGIN_X + 52, rowY);
    doc.setFont("times", "bold");
    doc.text(rightRows[i][0], MARGIN_X + colW, rowY);
    doc.setFont("times", "normal");
    doc.text(`: ${rightRows[i][1]}`, MARGIN_X + colW + 46, rowY);
  }
  y += 8 * 4.6 + 4;

  // ---- Batch table (Aggregate / Cement / Water / MS-ICE / Admixture) ----
  // Column composition and the Water-Abs/Moisture placeholder constants
  // below intentionally mirror the approved mockup's buildDocketHtml()
  // exactly — those constants are NOT derived from a real moisture-
  // correction formula (none was specified); revisit once the real
  // workbook/pipeline defines one.
  const aggCols = [["M SAND", 0], ["M SAND", mixDesign?.msand_kgm3 || 0], ["12 MM", mixDesign?.agg_12mm_kgm3 || 0], ["20 MM", mixDesign?.agg_20mm_kgm3 || 0], ["0", 0]];
  const cemCols = [["CEM 1", mixDesign?.cem1_kgm3 || 0], ["CEM 2", mixDesign?.cem2_kgm3 || 0], ["CEM 3", mixDesign?.cem3_kgm3 || 0]];
  const watCols = [["WATER", mixDesign?.water_kgm3 || 0]];
  const msCols = [["-", 0]];
  const admixCols = [["ADMIX1", mixDesign?.admix1_kgm3 || 0], ["ADMIX2", mixDesign?.admix2_kgm3 || 0]];
  const flatCols = [...aggCols, ...cemCols, ...watCols, ...msCols, ...admixCols];
  const decimals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2];
  const absPct = [0.00, 2.00, 1.00, 1.00, 0.00];
  const moistPct = [0.00, 5.20, 0.00, 0.00, 0.00];

  const labelColW = 16;
  const colWidth = (CONTENT_W - labelColW) / flatCols.length;
  function colX(i) { return MARGIN_X + labelColW + i * colWidth; }

  function ensureSpace(needed) {
    if (y + needed > 280) { doc.addPage(); y = 16; }
  }

  // Group header
  ensureSpace(14);
  doc.setFont("times", "bold");
  doc.setFontSize(8);
  const groups = [["Aggregate", aggCols.length], ["Cement", cemCols.length], ["Water", watCols.length], ["MS / ICE", msCols.length], ["Admixture", admixCols.length]];
  let gi = 0;
  groups.forEach(([label, span]) => {
    const gx = colX(gi) + (span * colWidth) / 2;
    doc.text(label, gx, y, { align: "center" });
    gi += span;
  });
  doc.setDrawColor(0);
  doc.line(MARGIN_X + labelColW, y + 1.5, PAGE_W - MARGIN_X, y + 1.5);
  y += 5;

  doc.setFontSize(7);
  flatCols.forEach((c, i) => doc.text(c[0], colX(i) + colWidth / 2, y, { align: "center" }));
  y += 4;

  doc.setFont("times", "bold");
  doc.text("Recipe Targets", MARGIN_X, y);
  y += 3.5;
  doc.setFont("times", "normal");
  flatCols.forEach((c, i) => {
    const val = c[1] ? fmt(c[1], decimals[i]) : "";
    doc.text(val, colX(i) + colWidth - 1, y, { align: "right" });
  });
  y += 5;

  doc.setFontSize(6.8);
  doc.text("Water Abs (%) / Moisture (%) with water correction / Corr. Target in Kgs / Actual in Kgs.", MARGIN_X, y);
  y += 4;

  const totalSet = flatCols.map(() => 0);
  const totalActual = flatCols.map(() => 0);

  for (let b = 1; b <= n; b++) {
    ensureSpace(16);
    doc.setFontSize(6.8);
    aggCols.forEach((c, i) => doc.text(absPct[i].toFixed(2), colX(i) + colWidth - 1, y, { align: "right" }));
    y += 3;
    aggCols.forEach((c, i) => doc.text(moistPct[i].toFixed(2), colX(i) + colWidth - 1, y, { align: "right" }));
    doc.text("Bal. Wtr  0", colX(aggCols.length + cemCols.length) + colWidth - 1, y, { align: "right" });
    y += 3;
    flatCols.forEach((c, i) => {
      const target = c[1];
      const v = target ? Math.round(target * batchSize) : 0;
      totalSet[i] += v;
      doc.text(decimals[i] > 0 ? fmt(v, decimals[i]) : String(v), colX(i) + colWidth - 1, y, { align: "right" });
    });
    y += 3;
    // Set/Actual variance kept intentionally (RAND()-based in the real
    // workbook) — see file header comment.
    flatCols.forEach((c, i) => {
      const target = c[1];
      const set = target ? Math.round(target * batchSize) : 0;
      const actual = set ? Math.round(set + (Math.random() - 0.5) * Math.max(set, 1) * 0.02) : 0;
      totalActual[i] += actual;
      doc.text(decimals[i] > 0 ? fmt(actual, decimals[i]) : String(actual), colX(i) + colWidth - 1, y, { align: "right" });
    });
    y += 4;
  }

  ensureSpace(10);
  doc.setFont("times", "bold");
  doc.setFontSize(7.5);
  doc.text("Total Set Weight in Kgs.", MARGIN_X, y);
  y += 3;
  doc.setDrawColor(0);
  doc.line(MARGIN_X + labelColW, y - 1, PAGE_W - MARGIN_X, y - 1);
  flatCols.forEach((c, i) => doc.text(decimals[i] > 0 ? fmt(totalSet[i], decimals[i]) : String(totalSet[i]), colX(i) + colWidth - 1, y, { align: "right" }));
  y += 5;
  doc.text("Total Actual in Kgs.", MARGIN_X, y);
  y += 3;
  flatCols.forEach((c, i) => doc.text(decimals[i] > 0 ? fmt(totalActual[i], decimals[i]) : String(totalActual[i]), colX(i) + colWidth - 1, y, { align: "right" }));
  y += 8;

  // Clearly mark every placeholder PDF as such, on the document itself —
  // not just in the database flag — so nobody mistakes this for the real
  // report while the Excel pipeline is still pending.
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(...GRAY);
  doc.text(
    "TEMPORARY FORMAT — generated by the app pending integration with the real Excel-based print pipeline.",
    MARGIN_X, 292
  );

  const filename = `Report No.${batchNumber}_${customer?.name || "UNKNOWN"}_${fmt(prodQty, 2)}m3.pdf`;
  const base64 = doc.output("datauristring").split(",")[1];
  return { filename, base64, sheetNumber: n, doc };
}
