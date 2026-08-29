// Concrete Cube Test Report — A4 PDF generator (round 118).
//
// Same jsPDF native-vector pattern as deliveryChallanPdf.js/mixDesignPdf.js.
// Visual language matches the confirmed CubeTestPDF.dc.html mockup (spec
// grid, navy "TEST SUMMARY" bar, red "STANDARDS FOLLOWED" reference table,
// navy "CUBE TEST ANALYSIS" per-cube table, remarks + signatory).
//
// Curing method always follows the standard IS 516 water-curing method, so
// it's fixed reference text here, the same treatment as the specimen size
// and load-rate figures below it. Casting location USED to be fixed too
// ("every cube batch in this app is cast during Plant QC" — no longer true
// as of round 120's site-cast cube testing, items 4b/4e: see `is_site_cast`
// below) and is now genuinely variable per test, same as Type of Failure
// (cube_test_results.failure_type, filled in by the Lab Technician at
// result-entry time). Data comes from GET /lab-technician/cube-tests/:resultId/pdf-data
// (plant-cast) or GET /lab-technician/site-cube-tests/:resultId/pdf-data
// (site-cast) — same shape either way, `is_site_cast` tells them apart.
//
// jsPDF's standard 14 fonts (Helvetica) use WinAnsiEncoding and do not
// reliably render Unicode outside that set — superscript "2"/"3" render as
// mojibake or vanish. So every unit in this file is plain ASCII ("N/mm2",
// "kg/m3") even though the on-screen app may show the proper typographic
// form elsewhere.

const NAVY = [31, 59, 92];
const RED = [176, 35, 29];
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
const BOTTOM_LIMIT = 283;

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
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDec(v, n = 1) {
  if (v === null || v === undefined || v === "") return "—";
  return Number(v).toFixed(n);
}

function fmtInt(v) {
  if (v === null || v === undefined || v === "") return "—";
  return Math.round(Number(v)).toLocaleString("en-IN");
}

// Round 120, item 4d — one result's full report, as its own function so it
// can be called either standalone (generateCubeTestPdf, one page, save
// immediately) or in a loop onto a shared document (generateCombinedCubeTestPdf
// below, for "these results all landed on the same day" — one PDF, one
// section per result, per how that question was resolved). Draws onto the
// `doc` it's given starting at the top of whatever page it's currently on —
// the caller is responsible for adding a new page between results.
async function renderCubeTestSection(doc, data, logoData) {
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
  doc.text("CONCRETE CUBE TEST REPORT", PAGE_W - MARGIN_X, y - 1, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.setTextColor(...SLATE);
  doc.text("IS 516 (Part 1)  |  IS:456-2000  |  IS 1199 (1959)", PAGE_W - MARGIN_X, y + 3.5, { align: "right" });

  // Gap before the rule: the logo's bottom edge sits at y+6 (addImage was
  // placed at y-9 with a 15mm height), so the rule needs to clear that,
  // not sit flush on top of it — same for the address/IS-code text above.
  y += 9;
  doc.setDrawColor(...RED);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  doc.setLineWidth(0.2);
  y += 7;

  // ---------------- Spec grid (4 columns) ----------------
  const cubeCount = data.cubes?.length || data.number_of_cubes || 0;
  const specs = [
    ["Customer", data.customer_name || "—"],
    ["Site", data.site_name || "—"],
    ["Grade", data.mix_grade_name || "—"],
    ["Casting Date", fmtDate(data.cast_at)],
    ["Structure", data.casting_location || "—"],
    // Round 120, items 4b/4e — a site-cast batch has no delivery ticket to
    // show here (there's no delivery it's tied to); says so plainly instead
    // of a bare "—", which would otherwise look like a data gap. Round 122 —
    // a pour-level result can draw cubes from more than one DN, so
    // ticket_number may already be a comma-joined list; "#" reads oddly
    // prefixed to more than one, so that prefix is only used for a single
    // ticket.
    ["Delivery Ticket", data.is_site_cast
      ? "Site cast — no ticket"
      : (data.ticket_number
        ? (data.ticket_number.includes(",") ? `DNs: ${data.ticket_number}` : `#${data.ticket_number}`)
        : "—")],
    ["Sample IDs", data.sample_ids || "—"],
    ["No. of Cubes", String(cubeCount)],
    ["Testing Age", data.testing_age_days ? `${data.testing_age_days} days` : "—"],
    ["Test Date", fmtDate(data.tested_at)],
    ["Compared Design", data.design_ref_code || "— none on file —"],
    ["Tested By", data.tested_by_name || "—"],
  ];
  {
    const cw = CONTENT_W / 4;
    const rh = 8.6;
    const rows = Math.ceil(specs.length / 4);
    y = ensureSpace(y, rh * rows + 2);
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
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.2);
      doc.setTextColor(...CHARCOAL);
      const valLines = doc.splitTextToSize(String(s[1]), cw - 4.4);
      doc.text(valLines[0], cx + 2.2, cy + rh - 2.2);
    });
    y += rh * rows + 5;
  }

  // ---------------- Test summary ----------------
  y = ensureSpace(y, 8);
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, y, CONTENT_W, 6.4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  doc.text(`TEST SUMMARY — AVERAGE OF ${cubeCount} CUBE${cubeCount === 1 ? "" : "S"}`, MARGIN_X + 3, y + 4.4);
  y += 6.4;

  const meetsTarget = data.testing_age_days === 28 && data.fck_28day_mpa != null && data.average_strength_mpa != null
    ? Number(data.average_strength_mpa) >= Number(data.fck_28day_mpa)
    : null;

  const summaryItems = [
    ["Average Compressive Strength", `${fmtDec(data.average_strength_mpa)} N/mm2`, meetsTarget === null ? CHARCOAL : (meetsTarget ? GREEN : ALERT)],
    ["Average Testing Load", `${fmtDec(data.average_load_kn, 2)} kN`, CHARCOAL],
    ["Average Density", `${fmtInt(data.average_density_kgm3)} kg/m3`, CHARCOAL],
  ];
  {
    const cw = CONTENT_W / 3;
    const rh = 9.5;
    y = ensureSpace(y, rh + 1);
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, rh);
    summaryItems.forEach((item, i) => {
      const cx = MARGIN_X + i * cw;
      if (i > 0) doc.line(cx, y, cx, y + rh);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.4);
      doc.setTextColor(...CHARCOAL);
      doc.text(item[0], cx + 2.5, y + 3.8);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...item[2]);
      doc.text(item[1], cx + 2.5, y + rh - 2.4);
    });
    y += rh;
    if (meetsTarget !== null) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7.1);
      doc.setTextColor(...(meetsTarget ? GREEN : ALERT));
      doc.text(
        meetsTarget ? `Meets characteristic strength f'ck (${fmtDec(data.fck_28day_mpa)} MPa).` : `Below characteristic strength f'ck (${fmtDec(data.fck_28day_mpa)} MPa) — flag for review.`,
        MARGIN_X, y + 3.8
      );
      y += 5.5;
    }
    y += 2.5;
  }

  // ---------------- Standards followed (fixed reference text) ----------------
  y = ensureSpace(y, 8);
  doc.setFillColor(...RED);
  doc.rect(MARGIN_X, y, CONTENT_W, 6.4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  doc.text("STANDARDS FOLLOWED", MARGIN_X + 3, y + 4.4);
  y += 6.4;
  {
    // Casting Location and Curing Method are fixed for every batch in this
    // app (see file header comment) — shown here as reference facts, same
    // as the specimen size and load-rate figures already below them.
    const rows = [
      ["Sampling of Fresh Concrete", "IS 1199 (1959)"],
      // Round 120, items 4b/4e — this used to be a fixed reference line
      // ("every cube batch in this app is cast during Plant QC" — see this
      // file's own header comment, written before a site-casting workflow
      // existed). Now genuinely variable per test.
      ["Casting Location", data.is_site_cast ? "Customer site (site-cast sample)" : "Plant (cast during Plant QC, at batching plant)"],
      ["Curing Method", "Water Curing (IS 516)"],
      ["Rate of Loading", "140 kg/cm2 per minute"],
      ["Compressive Strength of Concrete Cubes", "IS 456:2000"],
      ["Size of the Specimen", "150 mm x 150 mm x 150 mm"],
      ["Type of Failure", data.failure_type || "Not recorded"],
    ];
    const rh = 6.1;
    y = ensureSpace(y, rh * rows.length + 2);
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, rh * rows.length);
    rows.forEach((r, i) => {
      const ry = y + i * rh;
      if (i > 0) doc.line(MARGIN_X, ry, MARGIN_X + CONTENT_W, ry);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.8);
      doc.setTextColor(...SLATE);
      doc.text(r[0], MARGIN_X + 3, ry + rh / 2 + 1.2);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...CHARCOAL);
      doc.text(r[1], MARGIN_X + CONTENT_W - 3, ry + rh / 2 + 1.2, { align: "right" });
    });
    y += rh * rows.length + 5;
  }

  // ---------------- Cube test analysis ----------------
  y = ensureSpace(y, 8);
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, y, CONTENT_W, 6.4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  doc.text("CUBE TEST ANALYSIS", MARGIN_X + 3, y + 4.4);
  y += 6.4;
  {
    const cubes = data.cubes || [];
    const headers = ["Cube No", "Dimension (mm)", "Weight (kg)", "Density (kg/m3)", "Load (kN)", "Strength (N/mm2)", "Average (N/mm2)"];
    const widths = [0.16, 0.16, 0.13, 0.16, 0.13, 0.14, 0.12].map((f) => f * CONTENT_W);
    const headH = 8.6;
    y = ensureSpace(y, headH + 1);
    doc.setFillColor(...SHADE);
    doc.rect(MARGIN_X, y, CONTENT_W, headH, "F");
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, headH);
    let hx = MARGIN_X;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.4);
    doc.setTextColor(...NAVY);
    headers.forEach((h, i) => {
      if (i > 0) doc.line(hx, y, hx, y + headH);
      const lines = doc.splitTextToSize(h.toUpperCase(), widths[i] - 3);
      lines.forEach((l, li) => doc.text(l, hx + widths[i] / 2, y + 3.3 + li * 2.7, { align: "center" }));
      hx += widths[i];
    });
    y += headH;

    const rh = 6.1;
    y = ensureSpace(y, rh * Math.max(cubes.length, 1) + 1);
    doc.rect(MARGIN_X, y, CONTENT_W, rh * Math.max(cubes.length, 1));
    cubes.forEach((c, i) => {
      const ry = y + i * rh;
      if (i > 0) doc.line(MARGIN_X, ry, MARGIN_X + CONTENT_W, ry);
      const vals = [
        c.cube_label || `Cube ${i + 1}`,
        "150x150x150",
        fmtDec(c.weight_kg, 3),
        fmtInt(c.density_kgm3),
        fmtDec(c.testing_load_kn, 2),
        fmtDec(c.strength_mpa, 1),
        fmtDec(data.average_strength_mpa, 1),
      ];
      let vx = MARGIN_X;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.4);
      vals.forEach((v, vi) => {
        if (vi > 0) doc.line(vx, ry, vx, ry + rh);
        doc.setTextColor(vi === vals.length - 1 ? GREEN[0] : CHARCOAL[0], vi === vals.length - 1 ? GREEN[1] : CHARCOAL[1], vi === vals.length - 1 ? GREEN[2] : CHARCOAL[2]);
        doc.text(String(v), vx + widths[vi] / 2, ry + rh / 2 + 1.3, { align: "center" });
        vx += widths[vi];
      });
    });
    y += rh * Math.max(cubes.length, 1) + 5;
  }

  // ---------------- Remarks + signatory ----------------
  y = ensureSpace(y, 28);
  const noteW = CONTENT_W * 0.6;
  const sigW = CONTENT_W - noteW - 6;
  const noteX = MARGIN_X;
  const sigX = MARGIN_X + noteW + 6;
  const noteTopY = y;

  doc.setFillColor(...HEAD_TINT);
  doc.rect(noteX, y, noteW, 5.5, "F");
  doc.setDrawColor(...BORDER);
  doc.rect(noteX, y, noteW, 5.5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.6);
  doc.setTextColor(...RED);
  doc.text("REMARKS", noteX + 3, y + 3.9);
  const remarksText = data.remarks || "No remarks.";
  const remarkLines = doc.splitTextToSize(remarksText, noteW - 6);
  const remarksH = Math.max(remarkLines.length * 3.6 + 4, 14);
  doc.rect(noteX, y + 5.5, noteW, remarksH);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.4);
  doc.setTextColor(...CHARCOAL);
  remarkLines.forEach((line, i) => doc.text(line, noteX + 3, y + 5.5 + 4.4 + i * 3.6));
  const noteBottom = y + 5.5 + remarksH;

  doc.setDrawColor(...CHARCOAL);
  const sigLine1Y = noteTopY + 11;
  doc.line(sigX, sigLine1Y, sigX + sigW, sigLine1Y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.2);
  doc.setTextColor(...CHARCOAL);
  doc.text(data.tested_by_name || "—", sigX, sigLine1Y + 3.8);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.text("Tested By — Lab Technician", sigX, sigLine1Y + 7);

  const sigLine2Y = sigLine1Y + 17;
  doc.setDrawColor(...CHARCOAL);
  doc.line(sigX, sigLine2Y, sigX + sigW, sigLine2Y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.setFont("helvetica", "italic");
  doc.text("Checked By — QA/QC", sigX, sigLine2Y + 3.8);

  y = Math.max(noteBottom, sigLine2Y + 7) + 3;

  // ---------------- Footer ----------------
  y = ensureSpace(y, 16);
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, y, CONTENT_W, 7.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.2);
  doc.setTextColor(220, 228, 236);
  doc.text("OORM-QC-13", MARGIN_X + 3, y + 5);
  doc.text(`REPORT DATE: ${fmtDate(data.tested_at)}`, PAGE_W / 2, y + 5, { align: "center" });
  doc.text("REV. 0", PAGE_W - MARGIN_X - 3, y + 5, { align: "right" });
  y += 7.5 + 3.5;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.8);
  doc.setTextColor(...SLATE);
  doc.text(
    "Our Own Ready Mix, Plot No 3C-2, Industrial Area, Ananthapuram, Kasaragod, Kerala, India — 671321  ·  +91 83 4007 4006  ·  mail@ourownrm.com  ·  www.ourownrm.com",
    PAGE_W / 2, y, { align: "center" }
  );

}

export async function generateCubeTestPdf(data) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* logo optional — proceed without it */ }
  await renderCubeTestSection(doc, data, logoData);
  // Round 122 — a pour-level result no longer carries a single plant_qc_id
  // (see labTechnician.js's pdf-data route), so the filename falls back to
  // the order id instead once sample_ids/ticket_number are both empty.
  const label = data.sample_ids
    ? data.sample_ids.split(",")[0].trim()
    : (data.is_site_cast ? data.site_cube_cast_id : (data.ticket_number ? data.ticket_number.split(",")[0].trim() : data.order_id));
  doc.save(`Cube_Test_${label}_${data.testing_age_days || ""}day.pdf`);
  return doc;
}

// Round 120, item 4d — "what if a customer's 7-day and 28-day results land
// on the same day, possibly from different pours?" was resolved as: combine
// them into one PDF rather than making the customer open several. Same
// per-result section as the single-result PDF above, just looped onto one
// shared document with a page break between each. `payload` is
// GET /cube-tests/by-date/:date/pdf-data's response shape ({date, results}).
export async function generateCombinedCubeTestPdf(payload) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* logo optional — proceed without it */ }
  const results = payload.results || [];
  for (let i = 0; i < results.length; i++) {
    if (i > 0) doc.addPage();
    await renderCubeTestSection(doc, results[i], logoData);
  }
  doc.save(`Cube_Test_Combined_${payload.date}.pdf`);
  return doc;
}
