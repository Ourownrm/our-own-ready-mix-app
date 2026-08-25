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
const PAGE_H = 297;
const MARGIN_X = 12;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BOTTOM_LIMIT = 282;

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
    try { doc.addImage(logoData, "JPEG", MARGIN_X, y - 8, 18, 18); } catch { /* ignore bad image */ }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...SLATE);
  doc.text("Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala.", MARGIN_X + 21, y - 4);
  doc.text("+91 83 4007 4006  ·  mail@ourownrm.com", MARGIN_X + 21, y);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...RED);
  doc.text("OUR OWN READY-MIX", PAGE_W - MARGIN_X, y - 6, { align: "right" });
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text("CONCRETE MIX DESIGN", PAGE_W - MARGIN_X, y - 1, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...SLATE);
  doc.text("IS:10262-2019  |  IS:456-2000  |  IS 4926:2003", PAGE_W - MARGIN_X, y + 3.5, { align: "right" });

  y += 8;
  doc.setDrawColor(...RED);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  doc.setLineWidth(0.2);
  y += 7;

  // ---------------- Identification block ----------------
  const idRowH = 8;
  function idField(x, w, label, value, opts = {}) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.3);
    doc.setTextColor(...SLATE);
    doc.text(label.toUpperCase(), x, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...(opts.color || CHARCOAL));
    doc.text(String(value ?? "—") || "—", x, y + 5);
  }

  const statusColor = data.status === "approved" ? GREEN : [163, 120, 20];
  const statusLabel = data.status === "approved" ? "APPROVED" : "DRAFT";

  const c4 = CONTENT_W / 4;
  idField(MARGIN_X, c4, "Mix Grade", data.mix_grade_name);
  idField(MARGIN_X + c4, c4 * 1.6, "Design Ref. Code", data.design_ref_code);
  idField(MARGIN_X + c4 * 2.6, c4 * 0.7, "Revision", data.revision);
  idField(MARGIN_X + c4 * 3.3, c4 * 0.7, "Status", statusLabel, { color: statusColor });
  y += idRowH + 2;

  idField(MARGIN_X, CONTENT_W * 0.5, "Mix Description", data.mix_description || "—");
  idField(MARGIN_X + CONTENT_W * 0.5, CONTENT_W * 0.25, "Created", `${fmtDate(data.created_at)}${data.created_by_name ? " · " + data.created_by_name : ""}`);
  idField(MARGIN_X + CONTENT_W * 0.75, CONTENT_W * 0.25, "Approved", data.approved_at ? `${fmtDate(data.approved_at)}${data.approved_by_name ? " · " + data.approved_by_name : ""}` : "Pending");
  y += idRowH + 3;

  // ---------------- Section helpers ----------------
  function navyBar(label, w = CONTENT_W, x = MARGIN_X) {
    y = ensureSpace(y, 8);
    doc.setFillColor(...NAVY);
    doc.rect(x, y, w, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...WHITE);
    doc.text(label, x + 3, y + 4.9);
    y += 7;
  }

  function redBar(label, w = CONTENT_W, x = MARGIN_X) {
    y = ensureSpace(y, 8);
    doc.setFillColor(...RED);
    doc.rect(x, y, w, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...WHITE);
    doc.text(label, x + 3, y + 4.9);
    y += 7;
  }

  // ---------------- Mix Design Summary (3x3 grid) ----------------
  navyBar("MIX DESIGN SUMMARY");
  const summaryItems = [
    ["Compressive Strength (f'ck) at 28 days", `${fmtDec(data.fck_28day_mpa)} MPa`],
    ["Standard Deviation (σ)", `${fmtDec(data.std_deviation_mpa)} MPa`],
    ["Maximum Aggregate Size", data.max_agg_size_mm ? `${data.max_agg_size_mm} mm` : "—"],
    ["Target Mean Strength (f'm = f'ck + 1.65σ)", `${fmtDec(data.target_mean_strength_mpa)} MPa`],
    ["Free Water / Binder Ratio (W/B)", fmtDec(data.wb_ratio, 3)],
    ["Water Content", `${fmtInt(data.free_water_kgm3)} kg/m³`],
    ["Total Binder (Cement + Fly Ash)", `${fmtInt(data.total_binder_kgm3)} kg/m³`],
    ["Target Workability at Site", data.target_workability_mm || "—"],
    ["Design Density", data.design_density_kgm3 ? `${fmtInt(data.design_density_kgm3)} kg/m³` : "—"],
  ];
  {
    const cw = CONTENT_W / 3;
    const rh = 9;
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
      doc.setFontSize(7.6);
      doc.setTextColor(...CHARCOAL);
      const labelLines = doc.splitTextToSize(item[0], cw - 4);
      doc.text(labelLines[0], cx + 2.5, cy + 4);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.text(item[1], cx + 2.5, cy + rh - 2.3);
    });
    y += rh * 3 + 6;
  }

  // ---------------- Two-column: Mix Proportions / Materials ----------------
  function kvTable(x, w, rows) {
    const rh = 6.6;
    y = ensureSpace(y, rh * rows.length + 2);
    doc.setDrawColor(...BORDER);
    doc.rect(x, y, w, rh * rows.length);
    rows.forEach((r, i) => {
      const ry = y + i * rh;
      if (i > 0) doc.line(x, ry, x + w, ry);
      if (r.shade) { doc.setFillColor(...SHADE); doc.rect(x, ry, w, rh, "F"); doc.setDrawColor(...BORDER); doc.rect(x, ry, w, rh); }
      doc.setFont("helvetica", r.shade ? "bold" : "normal");
      doc.setFontSize(8.3);
      doc.setTextColor(...(r.shade ? CHARCOAL : SLATE));
      const labelLines = doc.splitTextToSize(r.k, w - 4 - doc.getTextWidth(r.v) - 4);
      doc.text(labelLines[0], x + 3, ry + rh / 2 + 1.2);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...CHARCOAL);
      doc.text(r.v, x + w - 3, ry + rh / 2 + 1.2, { align: "right" });
    });
    return y + rh * rows.length;
  }

  const colW = (CONTENT_W - 6) / 2;
  const colXL = MARGIN_X;
  const colXR = MARGIN_X + colW + 6;
  const sectionTopY = y;

  navyBar("MIX PROPORTIONS (SSD/m³)", colW, colXL);
  const propRows = [
    { k: "Cement", v: `${fmtInt(data.cement_kgm3)} kg/m³` },
  ];
  if (Number(data.fly_ash_kgm3) > 0) {
    const flyPct = data.total_binder_kgm3 ? ((data.fly_ash_kgm3 / data.total_binder_kgm3) * 100).toFixed(0) : "";
    propRows.push({ k: `Fly Ash (PFA) — ${flyPct}% of Binder`, v: `${fmtInt(data.fly_ash_kgm3)} kg/m³` });
  }
  propRows.push({ k: "Total Binder (Cement + Fly Ash)", v: `${fmtInt(data.total_binder_kgm3)} kg/m³`, shade: true });
  propRows.push({ k: "Free Water Content", v: `${fmtInt(data.free_water_kgm3)} kg/m³` });
  propRows.push({ k: "Free Water / Binder Ratio (W/B)", v: fmtDec(data.wb_ratio, 3) });
  propRows.push({ k: "Fine Aggregate", v: `${fmtInt(data.fine_agg_kgm3)} kg/m³` });
  propRows.push({ k: "Coarse Aggregate — 20 mm", v: `${fmtInt(data.coarse_20mm_kgm3)} kg/m³` });
  propRows.push({ k: "Coarse Aggregate — 12.5 mm", v: `${fmtInt(data.coarse_12_5mm_kgm3)} kg/m³` });
  propRows.push({ k: "Total Aggregate", v: `${fmtInt(data.total_aggregate_kgm3)} kg/m³`, shade: true });
  (data.admixtures || []).forEach((a) => {
    const dosage = a.dosage_pct_of_binder ? `, ${fmtDec(a.dosage_pct_of_binder, 2)}% of Binder` : "";
    propRows.push({ k: `Admixture — ${a.type_brand}${dosage}`, v: `${fmtDec(a.qty_kgm3, 2)} kg/m³` });
  });
  if (data.design_density_kgm3) propRows.push({ k: "Design Density", v: `${fmtInt(data.design_density_kgm3)} kg/m³`, shade: true });
  const leftBottom = kvTable(colXL, colW, propRows);

  y = sectionTopY;
  redBar("MATERIALS — TYPE / SOURCE / SP. GR.", colW, colXR);
  {
    const rows = [];
    if (data.cement_type_source || data.cement_sp_gr) rows.push(["Cement", data.cement_type_source || "—", fmtDec(data.cement_sp_gr, 2)]);
    if (Number(data.fly_ash_kgm3) > 0) rows.push(["Fly Ash (PFA)", data.fly_ash_type_source || "—", fmtDec(data.fly_ash_sp_gr, 2)]);
    rows.push(["Fine Aggregate", data.fine_agg_type_source || "—", fmtDec(data.fine_agg_sp_gr, 2)]);
    rows.push(["Coarse Aggregate — 20 mm", data.coarse_20mm_type_source || "—", fmtDec(data.coarse_20mm_sp_gr, 2)]);
    rows.push(["Coarse Aggregate — 12.5 mm", data.coarse_12_5mm_type_source || "—", fmtDec(data.coarse_12_5mm_sp_gr, 2)]);
    (data.admixtures || []).forEach((a) => rows.push([`Admixture — ${a.type_brand}`, "—", fmtDec(a.sp_gr, 2)]));
    if (data.max_agg_size_mm) rows.push(["Maximum Aggregate Size", `${data.max_agg_size_mm} mm`, "—"]);

    const w1 = colW * 0.48, w2 = colW * 0.30, w3 = colW - w1 - w2;
    const rh = 6.6;
    const headH = 6.5;
    doc.setFillColor(...HEAD_TINT);
    doc.rect(colXR, y, colW, headH, "F");
    doc.setDrawColor(...BORDER);
    doc.rect(colXR, y, colW, headH);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.3);
    doc.setTextColor(...RED);
    doc.text("MATERIAL", colXR + 2, y + 4.4);
    doc.text("TYPE / SOURCE", colXR + w1 + 2, y + 4.4);
    doc.text("SP.GR.", colXR + w1 + w2 + 2, y + 4.4);
    let ty = y + headH;
    doc.rect(colXR, ty, colW, rh * rows.length);
    rows.forEach((r, i) => {
      const ry = ty + i * rh;
      if (i > 0) doc.line(colXR, ry, colXR + colW, ry);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.6);
      doc.setTextColor(...CHARCOAL);
      const nameLines = doc.splitTextToSize(r[0], w1 - 3);
      doc.text(nameLines[0], colXR + 2, ry + rh / 2 + 1.2);
      const srcLines = doc.splitTextToSize(r[1], w2 - 3);
      doc.text(srcLines[0], colXR + w1 + 2, ry + rh / 2 + 1.2);
      doc.text(r[2], colXR + w1 + w2 + 2, ry + rh / 2 + 1.2);
    });
    y = ty + rh * rows.length;
  }
  const rightBottom = y;
  y = Math.max(leftBottom, rightBottom) + 6;

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
    const rh = 6.6, headH = 6.5;
    doc.setFillColor(...SHADE);
    doc.rect(aggX, y, aggColW, headH, "F");
    doc.setDrawColor(...BORDER);
    doc.rect(aggX, y, aggColW, headH);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.3);
    doc.setTextColor(...NAVY);
    doc.text("FRACTION", aggX + 2, y + 4.4);
    doc.text("QTY (kg/m³)", aggX + w1 + 2, y + 4.4);
    doc.text("% OF TOTAL", aggX + w1 + w2 + 2, y + 4.4);
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
      doc.setFontSize(8);
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
    doc.setFontSize(8);
    doc.text("Total", aggX + 2, totalY + rh / 2 + 1.2);
    doc.text(fmtInt(totalAgg), aggX + w1 + 2, totalY + rh / 2 + 1.2);
    doc.text("100%", aggX + w1 + w2 + 2, totalY + rh / 2 + 1.2);
    y = totalY + rh + 3;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.6);
    doc.setTextColor(...SLATE);
    doc.text("Coarse / Fine Aggregate Ratio", aggX, y + 3);
    y += 5;
    const barH = 7;
    const coarseW = (coarsePct / 100) * aggColW;
    doc.setFillColor(...ALERT);
    doc.rect(aggX, y, coarseW, barH, "F");
    doc.setFillColor(...INFO);
    doc.rect(aggX + coarseW, y, aggColW - coarseW, barH, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...WHITE);
    if (coarseW > 20) doc.text(`COARSE ${coarsePct.toFixed(0)}%`, aggX + coarseW / 2, y + barH / 2 + 1.2, { align: "center" });
    if (aggColW - coarseW > 20) doc.text(`FINE ${finePct.toFixed(0)}%`, aggX + coarseW + (aggColW - coarseW) / 2, y + barH / 2 + 1.2, { align: "center" });
    y += barH;
  }
  const aggBottom = y;

  // ---------------- Pie chart ----------------
  y = aggTopY;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.6);
  doc.setTextColor(...SLATE);
  doc.text("Aggregate Proportion", pieX + pieColW / 2, y + 3, { align: "center" });
  y += 8;
  const pieR = Math.min(20, pieColW / 2 - 4);
  const pieCx = pieX + pieColW / 2;
  const pieCy = y + pieR;

  function polarPoint(cx, cy, r, deg) {
    const rad = (Math.PI / 180) * deg;
    return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
  }
  function drawPieSlice(cx, cy, r, startDeg, endDeg, color) {
    doc.setFillColor(...color);
    const step = 3;
    for (let a = startDeg; a < endDeg; a += step) {
      const a2 = Math.min(a + step, endDeg);
      const [x1, y1] = polarPoint(cx, cy, r, a);
      const [x2, y2] = polarPoint(cx, cy, r, a2);
      doc.triangle(cx, cy, x1, y1, x2, y2, "F");
    }
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

  y = pieCy + pieR + 6;
  const legend = [
    ["M-Sand (fine)", INFO, finePct],
    ["20 mm (coarse)", ALERT, c20Pct],
    ["12.5 mm (coarse)", GREEN, c125Pct],
  ];
  legend.forEach((item) => {
    doc.setFillColor(...item[1]);
    doc.rect(pieX + 4, y - 2.6, 3, 3, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.6);
    doc.setTextColor(...CHARCOAL);
    doc.text(`${item[0]} — ${item[2].toFixed(0)}%`, pieX + 9, y);
    y += 5;
  });

  y = Math.max(aggBottom, y) + 6;

  // ---------------- Note + signatory ----------------
  y = ensureSpace(y, 34);
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
  doc.rect(noteX, y, noteW, 6, "F");
  doc.setDrawColor(...BORDER);
  doc.rect(noteX, y, noteW, 6);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...RED);
  doc.text("NOTE", noteX + 3, y + 4.2);
  let ny = y + 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...CHARCOAL);
  let noteBodyH = 4;
  notes.forEach((n, i) => {
    const lines = doc.splitTextToSize(`${i + 1}. ${n}`, noteW - 8);
    lines.forEach((line) => { doc.text(line, noteX + 4, ny + noteBodyH); noteBodyH += 3.6; });
  });
  doc.rect(noteX, y + 6, noteW, noteBodyH + 4);
  const noteBottom = y + 6 + noteBodyH + 4;

  doc.setDrawColor(...CHARCOAL);
  const sigLineY = noteTopY + 28;
  doc.line(sigX, sigLineY, sigX + sigW, sigLineY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...CHARCOAL);
  doc.text(data.approved_by_name || "Authorised Signatory", sigX, sigLineY + 4.5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...SLATE);
  doc.text("Quality Control, Our Own Ready Mix", sigX, sigLineY + 8.5);

  y = Math.max(noteBottom, sigLineY + 12) + 4;

  // ---------------- Disclaimer + footer ----------------
  y = ensureSpace(y, 24);
  doc.setFillColor(...NAVY);
  const discText = "Disclaimer: This mix design has been prepared in accordance with applicable Indian Standards based on laboratory trials and the materials specified herein. Actual field performance is dependent upon proper batching, transportation, placement, compaction, finishing, curing and site conditions. Any change in material source or characteristics may require review and revision of the mix design.";
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7);
  const discLines = doc.splitTextToSize(discText, CONTENT_W - 6);
  const discH = discLines.length * 3.1 + 4;
  doc.rect(MARGIN_X, y, CONTENT_W, discH, "F");
  doc.setTextColor(220, 228, 236);
  discLines.forEach((line, i) => doc.text(line, MARGIN_X + 3, y + 4.5 + i * 3.1));
  y += discH + 4;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  doc.text(
    "Our Own Ready Mix, Plot No 3C-2, Industrial Area, Ananthapuram, Kasaragod, Kerala, India — 671321  ·  +91 83 4007 4006  ·  mail@ourownrm.com  ·  www.ourownrm.com",
    PAGE_W / 2, y, { align: "center" }
  );

  doc.save(`Mix_Design_${data.design_ref_code || data.id}.pdf`);
}
