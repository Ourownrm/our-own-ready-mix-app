// Mix Design Summary — A4 PDF generator (round 118).
//
// Built with jsPDF's native vector drawing API (not html2canvas), matching
// the pattern established by deliveryChallanPdf.js. Visual language (navy
// section bars, red brand accents, summary grid, two-column proportions/
// materials tables, aggregate ratio bar + pie) replicates the confirmed
// MixDesignPDF.dc.html mockup — but every field on this page comes from the
// live mix_designs row passed in, including the four DB-generated columns
// (target mean strength, total binder, W/B ratio, total aggregate) so the
// PDF can never drift from what's stored. Nothing here is fetched — the
// caller passes the flat JSON already retrieved from
// GET /lab-technician/mix-designs/:id/pdf-data.
//
// A design is deliberately not tied to one customer/site (see
// mix_design_assignments — one design is routinely shared by several
// customers), so unlike the Delivery Challan this report has no
// customer/project/site fields; the identification block instead centers on
// the design itself (grade, ref code, revision, status, dates, authorship).
//
// jsPDF's standard 14 fonts (Helvetica) use WinAnsiEncoding and do not
// reliably render Unicode outside that set — the Greek "sigma" and
// superscript "3"/"2" characters render as mojibake or vanish. So every unit
// in this file is plain ASCII ("kg/m3", not "kg/m3" with a superscript; "SD"
// instead of the sigma symbol) even though the on-screen app may show the
// proper typographic form elsewhere.

const NAVY = [31, 59, 92];
const RED = [176, 35, 29];
const INFO = [42, 111, 151];
const GREEN = [29, 122, 85];
const ALERT = [176, 58, 46];
const SLATE = [91, 100, 112];
const CHARCOAL = [34, 38, 43];
const BORDER = [222, 218, 209];
const SHADE = [238, 242, 246];
const HEAD_TINT = [246, 233, 232];
const WHITE = [255, 255, 255];

const PAGE_W = 210;
const MARGIN_X = 12;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BOTTOM_LIMIT = 290;

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
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtInt(v) {
  if (v === null || v === undefined || v === "") return "—";
  return Math.round(Number(v)).toLocaleString("en-IN");
}

function fmtDec(v, n = 1) {
  if (v === null || v === undefined || v === "") return "—";
  return Number(v).toFixed(n);
}

export async function generateMixDesignPdf(data) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* logo optional — proceed without it */ }

  function ensureSpace(y, needed) {
    if (y + needed > BOTTOM_LIMIT) {
      doc.addPage();
      return 15;
    }
    return y;
  }

  // ---------------- Header ----------------
  let y = 16;
  if (logoData) {
    try { doc.addImage(logoData, "JPEG", MARGIN_X, y - 9, 15, 15); } catch { /* ignore bad image */ }
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...SLATE);
  doc.text("Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala.", MARGIN_X + 19, y - 4);
  doc.text("+91 83 4007 4006  ·  mail@ourownrm.com", MARGIN_X + 19, y);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...RED);
  doc.text("OUR OWN READY-MIX", PAGE_W - MARGIN_X, y - 6, { align: "right" });
  doc.setFontSize(10.5);
  doc.setTextColor(...CHARCOAL);
  doc.text("CONCRETE MIX DESIGN", PAGE_W - MARGIN_X, y - 1, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.setTextColor(...SLATE);
  doc.text("IS:10262-2019  |  IS:456-2000  |  IS 4926:2003", PAGE_W - MARGIN_X, y + 3.5, { align: "right" });

  // Gap before the rule: the logo's bottom edge sits at y+6 (addImage was
  // placed at y-9 with a 15mm height), so the rule needs to clear that,
  // not sit flush on top of it — same for the address/IS-code text above.
  y += 9;
  doc.setDrawColor(...RED);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  doc.setLineWidth(0.2);
  y += 7;

  // ---------------- Identification block ----------------
  // Values are fitted to their column width (shrunk to the first wrapped
  // line) so a long design ref code or a long name can never bleed into the
  // next column — this replaces the old fixed-size text that overlapped
  // between "Created" and "Approved" when either carried a long name.
  function idField(x, w, label, value, opts = {}) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8);
    doc.setTextColor(...SLATE);
    doc.text(label.toUpperCase(), x, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(opts.size || 9);
    doc.setTextColor(...(opts.color || CHARCOAL));
    const text = String(value ?? "—") || "—";
    const fitted = doc.splitTextToSize(text, w - 1)[0] || text;
    doc.text(fitted, x, y + 4.6);
  }

  const statusColor = data.status === "approved" ? GREEN : [163, 120, 20];
  const statusLabel = data.status === "approved" ? "APPROVED" : "DRAFT";

  // Round 127 — collapsed to the single row feedback asked for (Mix Grade |
  // Mix Description | Design Ref. Code | Rev | Status). Created/Approved
  // used to live in a second header row here; they're record-keeping
  // metadata rather than identification a reader needs first, so they've
  // moved down to the footer, smaller — see the signature block below.
  const idCols = [
    { w: 0.14, label: "Mix Grade", value: data.mix_grade_name },
    { w: 0.38, label: "Mix Description", value: data.mix_description || "—" },
    { w: 0.24, label: "Design Ref. Code", value: data.design_ref_code },
    { w: 0.09, label: "Rev", value: data.revision },
    { w: 0.15, label: "Status", value: statusLabel, opts: { color: statusColor, size: 8.5 } },
  ];
  let idX = MARGIN_X;
  idCols.forEach((c) => {
    const w = CONTENT_W * c.w;
    idField(idX, w, c.label, c.value, c.opts || {});
    idX += w;
  });
  y += 9;

  // ---------------- Section helpers ----------------
  function navyBar(label, w = CONTENT_W, x = MARGIN_X) {
    y = ensureSpace(y, 8);
    doc.setFillColor(...NAVY);
    doc.rect(x, y, w, 6.4, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...WHITE);
    doc.text(label, x + 3, y + 4.4);
    y += 6.4;
  }

  function redBar(label, w = CONTENT_W, x = MARGIN_X) {
    y = ensureSpace(y, 8);
    doc.setFillColor(...RED);
    doc.rect(x, y, w, 6.4, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...WHITE);
    doc.text(label, x + 3, y + 4.4);
    y += 6.4;
  }

  // ---------------- Mix Design Summary (3x3 grid) ----------------
  navyBar("MIX DESIGN SUMMARY");
  const summaryItems = [
    ["Compressive Strength (f'ck) at 28 days", `${fmtDec(data.fck_28day_mpa)} MPa`],
    ["Standard Deviation (SD)", `${fmtDec(data.std_deviation_mpa)} MPa`],
    ["Maximum Aggregate Size", data.max_agg_size_mm ? `${data.max_agg_size_mm} mm` : "—"],
    ["Target Mean Strength (f'ck + 1.65 x SD)", `${fmtDec(data.target_mean_strength_mpa)} MPa`],
    ["Free Water / Binder Ratio (W/B)", fmtDec(data.wb_ratio, 3)],
    ["Water Content", `${fmtInt(data.free_water_kgm3)} kg/m3`],
    ["Total Binder (Cement + Fly Ash)", `${fmtInt(data.total_binder_kgm3)} kg/m3`],
    ["Target Workability at Site", data.target_workability_mm || "—"],
    ["Design Density", data.design_density_kgm3 ? `${fmtInt(data.design_density_kgm3)} kg/m3` : "—"],
  ];
  {
    const cw = CONTENT_W / 3;
    const rh = 10.5;
    y = ensureSpace(y, rh * 3 + 1);
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, rh * 3);
    summaryItems.forEach((item, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const cx = MARGIN_X + col * cw;
      const cy = y + row * rh;
      if (col > 0) doc.line(cx, y, cx, y + rh * 3);
      if (row > 0) doc.line(MARGIN_X, cy, MARGIN_X + CONTENT_W, cy);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.9);
      doc.setTextColor(...SLATE);
      const labelLines = doc.splitTextToSize(item[0], cw - 5).slice(0, 2);
      labelLines.forEach((line, li) => doc.text(line, cx + 2.5, cy + 3.6 + li * 3.1));
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.setTextColor(...CHARCOAL);
      doc.text(item[1], cx + 2.5, cy + rh - 2.2);
    });
    y += rh * 3 + 7;
  }

  // ---------------- Two-column: Mix Proportions / Materials ----------------
  // A row's value is rendered as "bold figure" + "normal unit" so only the
  // number reads as data-weight — the unit stays a light, secondary label,
  // per feedback that the unit shouldn't carry the same emphasis as the
  // quantity itself.
  function kvTable(x, w, rows) {
    const rh = 6.1;
    y = ensureSpace(y, rh * rows.length + 2);
    doc.setDrawColor(...BORDER);
    doc.rect(x, y, w, rh * rows.length);
    rows.forEach((r, i) => {
      const ry = y + i * rh;
      if (i > 0) doc.line(x, ry, x + w, ry);
      if (r.shade) { doc.setFillColor(...SHADE); doc.rect(x, ry, w, rh, "F"); doc.setDrawColor(...BORDER); doc.rect(x, ry, w, rh); }

      doc.setFont("helvetica", r.shade ? "bold" : "normal");
      doc.setFontSize(7.8);
      doc.setTextColor(...(r.shade ? CHARCOAL : SLATE));
      const numText = r.v;
      const unitText = r.unit || "";
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      const numW = doc.getTextWidth(numText);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.2);
      const unitW = unitText ? doc.getTextWidth(unitText) + 0.8 : 0;
      const valueBlockW = numW + unitW;
      const labelLines = doc.splitTextToSize(r.k, w - 4 - valueBlockW - 4);
      doc.setFont("helvetica", r.shade ? "bold" : "normal");
      doc.setFontSize(7.8);
      doc.setTextColor(...(r.shade ? CHARCOAL : SLATE));
      doc.text(labelLines[0], x + 3, ry + rh / 2 + 1.2);

      let vx = x + w - 3 - valueBlockW;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...CHARCOAL);
      doc.text(numText, vx, ry + rh / 2 + 1.2);
      vx += numW;
      if (unitText) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.2);
        doc.setTextColor(...SLATE);
        doc.text(unitText, vx + 0.8, ry + rh / 2 + 1.2);
      }
    });
    return y + rh * rows.length;
  }

  // Splits a "123 kg/m3"-style formatted string into its numeric figure and
  // unit suffix so kvTable can bold only the figure.
  function splitUnit(text) {
    const m = String(text).match(/^([-\d.,]+)\s*(.*)$/);
    if (m && m[1]) return { v: m[1], unit: m[2] };
    return { v: text, unit: "" };
  }

  const colW = (CONTENT_W - 6) / 2;
  const colXL = MARGIN_X;
  const colXR = MARGIN_X + colW + 6;
  const sectionTopY = y;

  navyBar("MIX PROPORTIONS (SSD/m3)", colW, colXL);
  const propRows = [
    { k: "Cement", ...splitUnit(`${fmtInt(data.cement_kgm3)} kg/m3`) },
  ];
  if (Number(data.fly_ash_kgm3) > 0) {
    const flyPct = data.total_binder_kgm3 ? ((data.fly_ash_kgm3 / data.total_binder_kgm3) * 100).toFixed(0) : "";
    propRows.push({ k: `Fly Ash (PFA) — ${flyPct}% of Binder`, ...splitUnit(`${fmtInt(data.fly_ash_kgm3)} kg/m3`) });
  }
  propRows.push({ k: "Total Binder (Cement + Fly Ash)", ...splitUnit(`${fmtInt(data.total_binder_kgm3)} kg/m3`), shade: true });
  propRows.push({ k: "Free Water Content", ...splitUnit(`${fmtInt(data.free_water_kgm3)} kg/m3`) });
  propRows.push({ k: "Free Water / Binder Ratio (W/B)", v: fmtDec(data.wb_ratio, 3), unit: "" });
  propRows.push({ k: "Fine Aggregate", ...splitUnit(`${fmtInt(data.fine_agg_kgm3)} kg/m3`) });
  propRows.push({ k: "Coarse Aggregate — 20 mm", ...splitUnit(`${fmtInt(data.coarse_20mm_kgm3)} kg/m3`) });
  propRows.push({ k: "Coarse Aggregate — 12.5 mm", ...splitUnit(`${fmtInt(data.coarse_12_5mm_kgm3)} kg/m3`) });
  propRows.push({ k: "Total Aggregate", ...splitUnit(`${fmtInt(data.total_aggregate_kgm3)} kg/m3`), shade: true });
  (data.admixtures || []).forEach((a) => {
    const dosage = a.dosage_pct_of_binder ? `, ${fmtDec(a.dosage_pct_of_binder, 2)}% of Binder` : "";
    propRows.push({ k: `Admixture — ${a.type_brand}${dosage}`, ...splitUnit(`${fmtDec(a.qty_kgm3, 2)} kg/m3`) });
  });
  if (data.design_density_kgm3) propRows.push({ k: "Design Density", ...splitUnit(`${fmtInt(data.design_density_kgm3)} kg/m3`), shade: true });
  const leftBottom = kvTable(colXL, colW, propRows);

  y = sectionTopY;
  redBar("MATERIALS — TYPE / SOURCE / SP. GR.", colW, colXR);
  {
    // Material name and Type/Source both wrap to as many lines as needed
    // (instead of the old single-line truncation) and the row grows to fit
    // — this is what actually shows "OPC 53 Grade / Dalmia / Ramco" in full
    // rather than cutting it after the first slash.
    const rows = [];
    if (data.cement_type_source || data.cement_sp_gr) rows.push(["Cement", data.cement_type_source || "—", fmtDec(data.cement_sp_gr, 2)]);
    if (Number(data.fly_ash_kgm3) > 0) rows.push(["Fly Ash (PFA)", data.fly_ash_type_source || "—", fmtDec(data.fly_ash_sp_gr, 2)]);
    rows.push(["Fine Aggregate", data.fine_agg_type_source || "—", fmtDec(data.fine_agg_sp_gr, 2)]);
    rows.push(["Coarse Aggregate — 20 mm", data.coarse_20mm_type_source || "—", fmtDec(data.coarse_20mm_sp_gr, 2)]);
    rows.push(["Coarse Aggregate — 12.5 mm", data.coarse_12_5mm_type_source || "—", fmtDec(data.coarse_12_5mm_sp_gr, 2)]);
    (data.admixtures || []).forEach((a) => rows.push(["Admixture", a.type_brand || "—", fmtDec(a.sp_gr, 2)]));
    if (data.max_agg_size_mm) rows.push(["Maximum Aggregate Size", `${data.max_agg_size_mm} mm`, "—"]);

    const w1 = colW * 0.42, w2 = colW * 0.38, w3 = colW - w1 - w2;
    const headH = 6;
    const lineH = 3.1;
    doc.setFillColor(...HEAD_TINT);
    doc.rect(colXR, y, colW, headH, "F");
    doc.setDrawColor(...BORDER);
    doc.rect(colXR, y, colW, headH);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8);
    doc.setTextColor(...RED);
    doc.text("MATERIAL", colXR + 2, y + 4);
    doc.text("TYPE / SOURCE", colXR + w1 + 2, y + 4);
    doc.text("SP.GR.", colXR + w1 + w2 + 2, y + 4);
    let ty = y + headH;

    const wrapped = rows.map((r) => {
      const nameLines = doc.splitTextToSize(r[0], w1 - 3);
      const srcLines = doc.splitTextToSize(r[1], w2 - 3);
      const lineCount = Math.max(nameLines.length, srcLines.length, 1);
      return { nameLines, srcLines, sp: r[2], h: Math.max(6.1, lineCount * lineH + 2.6) };
    });
    const totalH = wrapped.reduce((a, r) => a + r.h, 0);
    doc.rect(colXR, ty, colW, totalH);
    let ry = ty;
    wrapped.forEach((r) => {
      if (ry > ty) doc.line(colXR, ry, colXR + colW, ry);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.4);
      doc.setTextColor(...CHARCOAL);
      r.nameLines.forEach((l, li) => doc.text(l, colXR + 2, ry + 3.7 + li * lineH));
      r.srcLines.forEach((l, li) => doc.text(l, colXR + w1 + 2, ry + 3.7 + li * lineH));
      doc.text(r.sp, colXR + w1 + w2 + 2, ry + r.h / 2 + 1.2);
      ry += r.h;
    });
    y = ty + totalH;
  }
  const rightBottom = y;
  y = Math.max(leftBottom, rightBottom) + 7;

  // ---------------- Aggregate proportions + ratio bar ----------------
  const fine = Number(data.fine_agg_kgm3) || 0;
  const c20 = Number(data.coarse_20mm_kgm3) || 0;
  const c125 = Number(data.coarse_12_5mm_kgm3) || 0;
  const totalAgg = Number(data.total_aggregate_kgm3) || (fine + c20 + c125) || 1;
  const finePct = (fine / totalAgg) * 100;
  const c20Pct = (c20 / totalAgg) * 100;
  const c125Pct = (c125 / totalAgg) * 100;
  const coarsePct = c20Pct + c125Pct;

  const aggColW = colW * 1.15;
  const pieColW = CONTENT_W - aggColW - 6;
  const aggX = MARGIN_X;
  const pieX = MARGIN_X + aggColW + 6;
  const aggTopY = y;

  navyBar("AGGREGATE PROPORTIONS", aggColW, aggX);
  {
    const w1 = aggColW * 0.5, w2 = aggColW * 0.28, w3 = aggColW - w1 - w2;
    const rh = 5.3, headH = 5.3; // Round 127 — shorter table per feedback
    doc.setFillColor(...SHADE);
    doc.rect(aggX, y, aggColW, headH, "F");
    doc.setDrawColor(...BORDER);
    doc.rect(aggX, y, aggColW, headH);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8);
    doc.setTextColor(...NAVY);
    doc.text("FRACTION", aggX + 2, y + 4);
    doc.text("QTY (kg/m3)", aggX + w1 + 2, y + 4);
    doc.text("% OF TOTAL", aggX + w1 + w2 + 2, y + 4);
    let ty = y + headH;
    const aggRows = [
      ["Fine Aggregate", fmtInt(fine), `${finePct.toFixed(0)}%`],
      ["Coarse — 20 mm", fmtInt(c20), `${c20Pct.toFixed(0)}%`],
      ["Coarse — 12.5 mm", fmtInt(c125), `${c125Pct.toFixed(0)}%`],
    ];
    doc.rect(aggX, ty, aggColW, rh * (aggRows.length + 1));
    aggRows.forEach((r, i) => {
      const ry = ty + i * rh;
      if (i > 0) doc.line(aggX, ry, aggX + aggColW, ry);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.6);
      doc.setTextColor(...CHARCOAL);
      doc.text(r[0], aggX + 2, ry + rh / 2 + 1.2);
      doc.text(r[1], aggX + w1 + 2, ry + rh / 2 + 1.2);
      doc.text(r[2], aggX + w1 + w2 + 2, ry + rh / 2 + 1.2);
    });
    const totalY = ty + rh * aggRows.length;
    doc.setFillColor(...SHADE);
    doc.rect(aggX, totalY, aggColW, rh, "F");
    doc.setDrawColor(...BORDER);
    doc.rect(aggX, totalY, aggColW, rh);
    doc.line(aggX, totalY, aggX + aggColW, totalY);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.6);
    doc.text("Total", aggX + 2, totalY + rh / 2 + 1.2);
    doc.text(fmtInt(totalAgg), aggX + w1 + 2, totalY + rh / 2 + 1.2);
    doc.text("100%", aggX + w1 + w2 + 2, totalY + rh / 2 + 1.2);
    y = totalY + rh + 2.5;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.2);
    doc.setTextColor(...SLATE);
    doc.text("Coarse / Fine Aggregate Ratio", aggX, y + 3);
    y += 4.5;
    const barH = 5.4; // Round 127 — shorter, to match the tightened table above
    const coarseW = (coarsePct / 100) * aggColW;
    doc.setFillColor(...ALERT);
    doc.rect(aggX, y, coarseW, barH, "F");
    doc.setFillColor(...INFO);
    doc.rect(aggX + coarseW, y, aggColW - coarseW, barH, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.2);
    doc.setTextColor(...WHITE);
    if (coarseW > 20) doc.text(`COARSE ${coarsePct.toFixed(0)}%`, aggX + coarseW / 2, y + barH / 2 + 1.1, { align: "center" });
    if (aggColW - coarseW > 20) doc.text(`FINE ${finePct.toFixed(0)}%`, aggX + coarseW + (aggColW - coarseW) / 2, y + barH / 2 + 1.1, { align: "center" });
    y += barH;
  }
  const aggBottom = y;

  // ---------------- Pie chart ----------------
  // Each slice is filled as a single closed polygon (doc.lines) rather than
  // a fan of small triangles — the old triangle-fan approach left visible
  // hairline seams between adjacent triangles at the slice's outer edge.
  y = aggTopY;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.2);
  doc.setTextColor(...SLATE);
  doc.text("Aggregate Proportion", pieX + pieColW / 2, y + 3, { align: "center" });
  y += 7;
  const pieR = Math.min(20, pieColW / 2 - 4); // Round 127 — bigger now the legend below is one inline row, not a stacked list
  const pieCx = pieX + pieColW / 2;
  const pieCy = y + pieR;

  function polarPoint(cx, cy, r, deg) {
    const rad = (Math.PI / 180) * deg;
    return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
  }
  function drawPieSlice(cx, cy, r, startDeg, endDeg, color) {
    doc.setFillColor(...color);
    const steps = Math.max(2, Math.ceil((endDeg - startDeg) / 4));
    const arcPts = [];
    for (let i = 0; i <= steps; i++) {
      const a = startDeg + ((endDeg - startDeg) * i) / steps;
      arcPts.push(polarPoint(cx, cy, r, a));
    }
    const poly = [[cx, cy], ...arcPts, [cx, cy]];
    const deltas = [];
    for (let i = 1; i < poly.length; i++) {
      deltas.push([poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]]);
    }
    doc.lines(deltas, cx, cy, [1, 1], "F", true);
  }
  let cursor = 0;
  const slices = [
    { pct: finePct, color: INFO },
    { pct: c20Pct, color: ALERT },
    { pct: c125Pct, color: GREEN },
  ];
  slices.forEach((s) => {
    if (s.pct <= 0) return;
    const end = cursor + (s.pct / 100) * 360;
    drawPieSlice(pieCx, pieCy, pieR, cursor, end, s.color);
    cursor = end;
  });

  // Round 127 — inline (one row) instead of a stacked list, per feedback;
  // wraps to a second row only if the three items genuinely don't fit at
  // this column's width.
  y = pieCy + pieR + 6;
  const legend = [
    ["Fine", INFO, finePct],
    ["20 mm", ALERT, c20Pct],
    ["12.5 mm", GREEN, c125Pct],
  ];
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  let lx = pieX;
  const legendTopY = y;
  legend.forEach((item) => {
    const label = `${item[0]} ${item[2].toFixed(0)}%`;
    const labelW = doc.getTextWidth(label);
    const itemW = 4.2 + labelW + 5;
    if (lx + itemW > pieX + pieColW && lx > pieX) { lx = pieX; y += 4.6; }
    doc.setFillColor(...item[1]);
    doc.rect(lx, y - 2.4, 2.8, 2.8, "F");
    doc.setTextColor(...CHARCOAL);
    doc.text(label, lx + 4.2, y);
    lx += itemW;
  });
  y = Math.max(y, legendTopY);

  y = Math.max(aggBottom, y) + 5;

  // ---------------- Note + signatory ----------------
  y = ensureSpace(y, 32);
  const noteW = CONTENT_W * 0.58;
  const sigW = CONTENT_W - noteW - 6;
  const noteX = MARGIN_X;
  const sigX = MARGIN_X + noteW + 6;
  const notes = [
    "Admixture dosage to be adjusted based on ambient temperature and transport time.",
    "Moisture correction of aggregates to be carried out daily.",
    "All quantities are in SSD condition unless specified.",
  ];
  const noteTopY = y;
  doc.setFillColor(...HEAD_TINT);
  doc.rect(noteX, y, noteW, 5.5, "F");
  doc.setDrawColor(...BORDER);
  doc.rect(noteX, y, noteW, 5.5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.6);
  doc.setTextColor(...RED);
  doc.text("NOTE", noteX + 3, y + 3.9);
  let ny = y + 5.5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.setTextColor(...CHARCOAL);
  let noteBodyH = 3.6;
  notes.forEach((n, i) => {
    const lines = doc.splitTextToSize(`${i + 1}. ${n}`, noteW - 8);
    lines.forEach((line) => { doc.text(line, noteX + 4, ny + noteBodyH); noteBodyH += 3.4; });
  });
  doc.rect(noteX, y + 5.5, noteW, noteBodyH + 3);
  const noteBottom = y + 5.5 + noteBodyH + 3;

  doc.setDrawColor(...CHARCOAL);
  const sigLineY = noteTopY + 14;
  doc.line(sigX, sigLineY, sigX + sigW, sigLineY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.6);
  doc.setTextColor(...CHARCOAL);
  // The signatory line always shows the role, not the individual approver —
  // per feedback, keep "Quality Control Engineer" as the fixed default
  // rather than surfacing whichever admin/QC user happened to click Approve.
  doc.text("Quality Control Engineer", sigX, sigLineY + 4.3);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.setTextColor(...SLATE);
  doc.text("Quality Control, Our Own Ready Mix", sigX, sigLineY + 8);

  y = Math.max(noteBottom, sigLineY + 11) + 3;

  // ---------------- Created / Approved (round 127) ----------------
  // Moved down from the header (see the identification block above) and
  // shrunk — this is record-keeping metadata (who/when), not something a
  // reader needs before the design's own numbers.
  y = ensureSpace(y, 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.4);
  doc.setTextColor(...SLATE);
  const createdLine = `Created ${fmtDate(data.created_at)}${data.created_by_name ? ` by ${data.created_by_name}` : ""}`;
  const approvedLine = data.approved_at
    ? `Approved ${fmtDate(data.approved_at)} by Quality Control Engineer`
    : "Approval pending";
  doc.text(createdLine, MARGIN_X, y + 3);
  doc.text(approvedLine, PAGE_W - MARGIN_X, y + 3, { align: "right" });
  y += 6;

  // ---------------- Disclaimer + footer ----------------
  y = ensureSpace(y, 24);
  doc.setFillColor(...NAVY);
  const discText = "Disclaimer: This mix design has been prepared in accordance with applicable Indian Standards based on laboratory trials and the materials specified herein. Actual field performance is dependent upon proper batching, transportation, placement, compaction, finishing, curing and site conditions. Any change in material source or characteristics may require review and revision of the mix design.";
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.8);
  const discLines = doc.splitTextToSize(discText, CONTENT_W - 6);
  const discH = discLines.length * 3 + 3.6;
  doc.rect(MARGIN_X, y, CONTENT_W, discH, "F");
  doc.setTextColor(220, 228, 236);
  discLines.forEach((line, i) => doc.text(line, MARGIN_X + 3, y + 4.3 + i * 3));
  y += discH + 4.5;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.8);
  doc.setTextColor(...SLATE);
  doc.text(
    "Our Own Ready Mix, Plot No 3C-2, Industrial Area, Ananthapuram, Kasaragod, Kerala, India — 671321  ·  +91 83 4007 4006  ·  mail@ourownrm.com  ·  www.ourownrm.com",
    PAGE_W / 2, y, { align: "center" }
  );

  doc.save(`Mix_Design_${data.design_ref_code || data.id}.pdf`);
  return doc;
}
