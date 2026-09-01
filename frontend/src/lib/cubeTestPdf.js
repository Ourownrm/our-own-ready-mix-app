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

// Round 131 feedback — a cube slot gets created for every sample taken (see
// labTechnician.js's submit route), but a sample the Lab Technician never
// actually got a reading for still has weight_kg/testing_load_kn both null.
// The report should only ever list cubes someone actually tested — an
// untested slot showing up as a blank/dash row reads as a missing result,
// not as "not sampled here." Cube averages already correctly exclude these
// (Round 124 item 5's avg() fix) — this is purely the row-display side.
function testedCubesOf(cubes) {
  return (cubes || []).filter((c) => c.weight_kg != null && c.weight_kg !== "" || c.testing_load_kn != null && c.testing_load_kn !== "");
}

// Round 120, item 4d — one result's full report, as its own function so it
// could be called either standalone or in a loop onto a shared document.
// Round 131 — generateCubeTestPdf (the standalone case) now goes through
// renderCombinedPourSection instead (see that function's own generator,
// further down, for why); this one is kept solely for
// generateCombinedCubeTestPdf below, for "these results all landed on the
// same day, possibly different pours" — one PDF, one section per result, a
// genuinely different report shape than a single pour's own combined view.
// Draws onto the `doc` it's given starting at the top of whatever page it's
// currently on — the caller is responsible for adding a new page between
// results.
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
  // Round 128 — logo up 10% (15mm -> 16.5mm); kept centered on the same spot
  // the old 15mm logo occupied (y-9 to y+6, center y-1.5) rather than just
  // growing from the same top-left corner, and the address text's left
  // margin nudged out to match (15mm + 4mm gap -> 16.5mm + 4mm gap).
  if (logoData) {
    try { doc.addImage(logoData, "JPEG", MARGIN_X, y - 9.75, 16.5, 16.5); } catch { /* ignore bad image */ }
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...SLATE);
  doc.text("Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala.", MARGIN_X + 20.5, y - 4);
  doc.text("+91 83 4007 4006  ·  mail@ourownrm.com", MARGIN_X + 20.5, y);

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

  // Gap before the rule: the logo's bottom edge sits at y+6.75 (round 128 —
  // addImage placed at y-9.75 with a 16.5mm height), so the rule needs to
  // clear that, not sit flush on top of it — same for the address/IS-code
  // text above.
  y += 9;
  doc.setDrawColor(...RED);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  doc.setLineWidth(0.2);
  y += 7;

  // ---------------- Spec grid ----------------
  // "No. of Cubes" (spec grid) is how many samples were taken; the TEST
  // SUMMARY bar's count further down is how many actually went into the
  // average — not the same number once an untested sample is excluded (see
  // testedCubesOf).
  const cubeCount = data.cubes?.length || data.number_of_cubes || 0;
  const testedCubeCount = testedCubesOf(data.cubes).length || cubeCount;
  // Round 128, items 1/2/6 — Customer and Site pulled out into their own
  // 50/50 row so a long customer name isn't clipped to a quarter-width
  // column; Delivery Ticket dropped (not required to show) and Tested By
  // dropped (it already appears once, in the signature block below — showing
  // it here too was a straight repetition).
  const topSpecs = [
    ["Customer", data.customer_name || "—"],
    ["Site", data.site_name || "—"],
  ];
  const specs = [
    ["Grade", data.mix_grade_name || "—"],
    ["Casting Date", fmtDate(data.cast_at)],
    ["Structure", data.casting_location || "—"],
    ["Sample IDs", data.sample_ids || "—"],
    ["No. of Cubes", String(cubeCount)],
    ["Testing Age", data.testing_age_days ? `${data.testing_age_days} days` : "—"],
    ["Test Date", fmtDate(data.tested_at)],
    ["Compared Design", data.design_ref_code || "— none on file —"],
  ];
  {
    const rh = 8.6;

    // Top row — Customer | Site, 50/50 width.
    y = ensureSpace(y, rh + 2);
    const cw2 = CONTENT_W / 2;
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, rh);
    doc.line(MARGIN_X + cw2, y, MARGIN_X + cw2, y + rh);
    topSpecs.forEach((s, i) => {
      const cx = MARGIN_X + i * cw2;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.6);
      doc.setTextColor(...SLATE);
      doc.text(s[0].toUpperCase(), cx + 2.2, y + 3.5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.2);
      doc.setTextColor(...CHARCOAL);
      const valLines = doc.splitTextToSize(String(s[1]), cw2 - 4.4);
      doc.text(valLines[0], cx + 2.2, y + rh - 2.2);
    });
    y += rh;

    // Remaining fields — 4-column grid.
    const cw = CONTENT_W / 4;
    const rows = Math.ceil(specs.length / 4);
    y = ensureSpace(y, rh * rows + 2);
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
  doc.text(`TEST SUMMARY — AVERAGE OF ${testedCubeCount} CUBE${testedCubeCount === 1 ? "" : "S"}`, MARGIN_X + 3, y + 4.4);
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
    // Round 128, item 7 — row height up (9.5 -> 12.5) and the value pulled
    // further from the bottom edge, so the gap between each label and its
    // result reads clearly instead of the two nearly touching.
    const rh = 12.5;
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
      doc.text(item[1], cx + 2.5, y + rh - 3.2);
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
    const cubes = testedCubesOf(data.cubes);
    // Round 128, item 3 — the "Average" column dropped. It showed the same
    // all-cubes average on every row, which read as though each cube had its
    // own average — the actual average already has its own line in TEST
    // SUMMARY above.
    const headers = ["Cube No", "Dimension (mm)", "Weight (kg)", "Density (kg/m3)", "Load (kN)", "Strength (N/mm2)"];
    const widths = [0.18, 0.18, 0.15, 0.18, 0.15, 0.16].map((f) => f * CONTENT_W);
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
      ];
      let vx = MARGIN_X;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.4);
      vals.forEach((v, vi) => {
        if (vi > 0) doc.line(vx, ry, vx, ry + rh);
        doc.setTextColor(...CHARCOAL);
        doc.text(String(v), vx + widths[vi] / 2, ry + rh / 2 + 1.3, { align: "center" });
        vx += widths[vi];
      });
    });
    y += rh * Math.max(cubes.length, 1) + 5;
  }

  // ---------------- Remarks + signatory ----------------
  // Round 128, items 4/5 — Tested By moved from the right-hand signature
  // column to underneath the Remarks box on the left (Checked By stays put,
  // bottom-right); the Remarks box's minimum height increased to use the
  // vertical space that move freed up on the right.
  y = ensureSpace(y, 42);
  const noteW = CONTENT_W * 0.62;
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
  const remarksH = Math.max(remarkLines.length * 3.6 + 4, 22);
  doc.rect(noteX, y + 5.5, noteW, remarksH);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.4);
  doc.setTextColor(...CHARCOAL);
  remarkLines.forEach((line, i) => doc.text(line, noteX + 3, y + 5.5 + 4.4 + i * 3.6));
  const remarksBottom = y + 5.5 + remarksH;

  // Tested By — bottom-left, under the Remarks box.
  doc.setDrawColor(...CHARCOAL);
  const testedLineY = remarksBottom + 6;
  doc.line(noteX, testedLineY, noteX + sigW, testedLineY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.2);
  doc.setTextColor(...CHARCOAL);
  doc.text(data.tested_by_name || "—", noteX, testedLineY + 3.8);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.text("Tested By — Lab Technician", noteX, testedLineY + 7);
  const noteBottom = testedLineY + 7;

  // Checked By — bottom-right, alone, at roughly the same spot Tested By
  // used to occupy.
  doc.setDrawColor(...CHARCOAL);
  const sigLineY = noteTopY + 11;
  doc.line(sigX, sigLineY, sigX + sigW, sigLineY);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.text("Checked By — QA/QC", sigX, sigLineY + 3.8);

  y = Math.max(noteBottom, sigLineY + 7) + 3;

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

// Round 130 — the ONE-PAGE combined pour report: both testing ages merged
// into a single report (one header/spec block, one two-column TEST SUMMARY,
// one CUBE TEST ANALYSIS table spanning both ages with a rowspan-style
// Average column), replacing the old idea of "combined" meaning two full
// per-age reports concatenated (that's still what generateCombinedCubeTestPdf
// below does, for its own different job — same-day results, possibly from
// different pours). Data comes from GET /lab-technician/cube-pours/:orderId/combined-pdf-data
// (plant-cast) or GET /lab-technician/site-cube-casts/:castId/combined-pdf-data
// (site-cast) — `day7`/`day28` are each either that age's full result+cubes,
// or null if that age hasn't been tested yet (the caller only offers this
// option once both are done, but this renders sensibly either way).
async function renderCombinedPourSection(doc, data, logoData) {
  function ensureSpace(y, needed) {
    if (y + needed > BOTTOM_LIMIT) {
      doc.addPage();
      return 15;
    }
    return y;
  }

  const { day7, day28 } = data;
  const ages = [["7-Day", 7, day7], ["28-Day", 28, day28]].filter(([, , r]) => r);

  // ---------------- Header ----------------
  let y = 16;
  if (logoData) {
    try { doc.addImage(logoData, "JPEG", MARGIN_X, y - 9.75, 16.5, 16.5); } catch { /* ignore bad image */ }
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...SLATE);
  doc.text("Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala.", MARGIN_X + 20.5, y - 4);
  doc.text("+91 83 4007 4006  ·  mail@ourownrm.com", MARGIN_X + 20.5, y);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...RED);
  doc.text("OUR OWN READY-MIX", PAGE_W - MARGIN_X, y - 6, { align: "right" });
  doc.setFontSize(10.5);
  doc.setTextColor(...CHARCOAL);
  doc.text(day7 && day28 ? "CONCRETE CUBE TEST REPORT — COMBINED" : "CONCRETE CUBE TEST REPORT", PAGE_W - MARGIN_X, y - 1, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.setTextColor(...SLATE);
  doc.text("IS 516 (Part 1)  |  IS:456-2000  |  IS 1199 (1959)", PAGE_W - MARGIN_X, y + 3.5, { align: "right" });

  y += 9;
  doc.setDrawColor(...RED);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  doc.setLineWidth(0.2);
  y += 7;

  // ---------------- Spec grid ----------------
  // Round 129 feedback — no Sample IDs in the header (this is a pour-level,
  // possibly multi-DN, report — a single "sample IDs" field doesn't read
  // cleanly any more) and Casting Date takes its place.
  {
    const rh = 8.6;
    y = ensureSpace(y, rh + 2);
    const cw2 = CONTENT_W / 2;
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, rh);
    doc.line(MARGIN_X + cw2, y, MARGIN_X + cw2, y + rh);
    [["Customer", data.customer_name || "—"], ["Site", data.site_name || "—"]].forEach((s, i) => {
      const cx = MARGIN_X + i * cw2;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.6);
      doc.setTextColor(...SLATE);
      doc.text(s[0].toUpperCase(), cx + 2.2, y + 3.5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.2);
      doc.setTextColor(...CHARCOAL);
      const valLines = doc.splitTextToSize(String(s[1]), cw2 - 4.4);
      doc.text(valLines[0], cx + 2.2, y + rh - 2.2);
    });
    y += rh;

    const specs = [
      ["Grade", data.mix_grade_name || "—"],
      ["Structure", data.casting_location || "—"],
      ["Casting Date", fmtDate(data.cast_at)],
      ["Compared Design", data.design_ref_code || "— none on file —"],
    ];
    const cw = CONTENT_W / 4;
    y = ensureSpace(y, rh + 2);
    doc.rect(MARGIN_X, y, CONTENT_W, rh);
    specs.forEach((s, i) => {
      const cx = MARGIN_X + i * cw;
      if (i > 0) doc.line(cx, y, cx, y + rh);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.6);
      doc.setTextColor(...SLATE);
      doc.text(s[0].toUpperCase(), cx + 2.2, y + 3.5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.2);
      doc.setTextColor(...CHARCOAL);
      const valLines = doc.splitTextToSize(String(s[1]), cw - 4.4);
      doc.text(valLines[0], cx + 2.2, y + rh - 2.2);
    });
    y += rh + 5;
  }

  // ---------------- Standards followed (restored per feedback) ----------------
  y = ensureSpace(y, 8);
  doc.setFillColor(...RED);
  doc.rect(MARGIN_X, y, CONTENT_W, 6.4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  doc.text("STANDARDS FOLLOWED", MARGIN_X + 3, y + 4.4);
  y += 6.4;
  {
    // Round 131 — a single-age report (only day7 or only day28 present, now
    // that generateCubeTestPdf routes through this same renderer) shouldn't
    // claim anything about the age that was never tested; only say "7-Day: X
    // · 28-Day: Y" once both actually exist.
    const failureText = day7 && day28
      ? `7-Day: ${day7.failure_type || "Not recorded"}  ·  28-Day: ${day28.failure_type || "Not recorded"}`
      : (day7 || day28)?.failure_type || "Not recorded";
    const rows = [
      ["Sampling of Fresh Concrete", "IS 1199 (1959)"],
      ["Casting Location", data.is_site_cast ? "Customer site (site-cast sample)" : "Plant (cast during Plant QC, at batching plant)"],
      ["Curing Method", "Water Curing (IS 516)"],
      ["Rate of Loading", "140 kg/cm2 per minute"],
      ["Compressive Strength of Concrete Cubes", "IS 456:2000"],
      ["Size of the Specimen", "150 mm x 150 mm x 150 mm"],
      ["Type of Failure", failureText],
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

  // ---------------- Test summary — 7 & 28 day averages side by side ----------------
  // Round 129 feedback (2nd round) — load/density moved beside the headline
  // number instead of stacked below it (shorter panel), and the f'ck
  // pass/fail line moved into the bar itself, right-aligned, instead of its
  // own line below the panel.
  const meetsTarget = data.fck_28day_mpa != null && day28?.average_strength_mpa != null
    ? Number(day28.average_strength_mpa) >= Number(data.fck_28day_mpa)
    : null;
  y = ensureSpace(y, 8);
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, y, CONTENT_W, 6.4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  doc.text(
    day7 && day28 ? "TEST SUMMARY — 7 & 28 DAY AVERAGES" : `TEST SUMMARY — ${(day7 ? 7 : 28)} DAY AVERAGE`,
    MARGIN_X + 3, y + 4.4
  );
  if (meetsTarget !== null) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.6);
    doc.setTextColor(...(meetsTarget ? [169, 224, 201] : [240, 190, 185]));
    doc.text(
      meetsTarget ? `Meets characteristic strength f'ck (${fmtDec(data.fck_28day_mpa)} MPa)` : `Below characteristic strength f'ck (${fmtDec(data.fck_28day_mpa)} MPa)`,
      PAGE_W - MARGIN_X - 3, y + 4.4, { align: "right" }
    );
  }
  y += 6.4;
  {
    const cw = CONTENT_W / 2;
    const rh = 13.5;
    y = ensureSpace(y, rh + 1);
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, rh);
    doc.line(MARGIN_X + cw, y, MARGIN_X + cw, y + rh);
    [["7-Day Avg.", day7], ["28-Day Avg.", day28]].forEach(([label, r], i) => {
      const cx = MARGIN_X + i * cw + 3;
      const color = i === 1 && r ? GREEN : CHARCOAL;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.6);
      doc.setTextColor(...SLATE);
      doc.text(label.toUpperCase(), cx, y + 4.2);
      if (r) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13.5);
        doc.setTextColor(...color);
        doc.text(`${fmtDec(r.average_strength_mpa)}`, cx, y + rh - 3);
        const numW = doc.getTextWidth(`${fmtDec(r.average_strength_mpa)} `);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.4);
        doc.setTextColor(...SLATE);
        doc.text("N/mm2", cx + numW, y + rh - 3);

        const dividerX = cx + cw - 6 - 32;
        doc.setDrawColor(...BORDER);
        doc.line(dividerX, y + 3, dividerX, y + rh - 3);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6.6);
        doc.setTextColor(...SLATE);
        doc.text(`Load ${fmtDec(r.average_load_kn, 1)} kN`, dividerX + 3, y + 6);
        doc.text(`Density ${fmtInt(r.average_density_kgm3)} kg/m3`, dividerX + 3, y + 10.2);
      } else {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8.5);
        doc.setTextColor(...SLATE);
        doc.text("Not yet tested", cx, y + rh - 4.5);
      }
    });
    y += rh + 5;
  }

  // ---------------- Cube test analysis — both ages, one table ----------------
  // Round 129 feedback (2nd round) — no "7 DAY RESULTS"/"28 DAY RESULTS"
  // divider rows (the Age column already says so); each age's rows share one
  // rowspan-style Average cell on the right, drawn as a single tall rect
  // rather than one full-width label row per age.
  y = ensureSpace(y, 8);
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, y, CONTENT_W, 6.4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  doc.text("CUBE TEST ANALYSIS", MARGIN_X + 3, y + 4.4);
  y += 6.4;
  {
    const headers = ["Cube No", "Date of Test", "Age (Days)", "Weight (kg)", "Density (kg/m3)", "Load (kN)", "Strength (N/mm2)", "Average (N/mm2)"];
    const widths = [0.15, 0.13, 0.08, 0.12, 0.14, 0.12, 0.13, 0.13].map((f) => f * CONTENT_W);
    const headH = 8.6;
    y = ensureSpace(y, headH + 1);
    doc.setFillColor(...SHADE);
    doc.rect(MARGIN_X, y, CONTENT_W, headH, "F");
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, headH);
    let hx = MARGIN_X;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.2);
    doc.setTextColor(...NAVY);
    headers.forEach((h, i) => {
      if (i > 0) doc.line(hx, y, hx, y + headH);
      if (i === headers.length - 1) { doc.setFillColor(...HEAD_TINT); doc.rect(hx, y, widths[i], headH, "F"); doc.setDrawColor(...BORDER); doc.rect(hx, y, widths[i], headH); }
      const lines = doc.splitTextToSize(h.toUpperCase(), widths[i] - 3);
      doc.setTextColor(...NAVY);
      lines.forEach((l, li) => doc.text(l, hx + widths[i] / 2, y + 3.3 + li * 2.5, { align: "center" }));
      hx += widths[i];
    });
    y += headH;

    const rh = 6.1;
    const totalRows = ages.reduce((sum, [, , r]) => sum + Math.max(testedCubesOf(r.cubes).length, 1), 0) || 1;
    y = ensureSpace(y, rh * totalRows + 1);
    const tableTop = y;
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, tableTop, CONTENT_W, rh * totalRows);
    // Column separators for the first 7 columns, full table height.
    let vx = MARGIN_X;
    for (let i = 0; i < widths.length - 1; i++) { vx += widths[i]; doc.line(vx, tableTop, vx, tableTop + rh * totalRows); }

    let rowCursor = 0;
    ages.forEach(([ageLabel, ageDays, r]) => {
      const tested = testedCubesOf(r.cubes);
      const cubes = tested.length ? tested : [{ cube_label: "—", weight_kg: r.average_weight_kg, density_kgm3: r.average_density_kgm3, testing_load_kn: r.average_load_kn, strength_mpa: r.average_strength_mpa }];
      const groupTop = tableTop + rowCursor * rh;
      cubes.forEach((c, i) => {
        const ry = groupTop + i * rh;
        if (rowCursor + i > 0) doc.line(MARGIN_X, ry, MARGIN_X + CONTENT_W - widths[widths.length - 1], ry);
        const vals = [c.cube_label || `Cube ${i + 1}`, fmtDate(r.tested_at), String(ageDays), fmtDec(c.weight_kg, 3), fmtInt(c.density_kgm3), fmtDec(c.testing_load_kn, 2), fmtDec(c.strength_mpa, 1)];
        let cx = MARGIN_X;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.2);
        doc.setTextColor(...CHARCOAL);
        vals.forEach((v, vi) => { doc.text(String(v), cx + widths[vi] / 2, ry + rh / 2 + 1.3, { align: "center" }); cx += widths[vi]; });
      });
      // The rowspan-style Average cell — one rect + one centered value for
      // the whole group, colored green for the 28-day group like the
      // confirmed mockup.
      const groupH = cubes.length * rh;
      const avgX = MARGIN_X + CONTENT_W - widths[widths.length - 1];
      doc.setFillColor(...HEAD_TINT);
      doc.rect(avgX, groupTop, widths[widths.length - 1], groupH, "F");
      doc.setDrawColor(...BORDER);
      doc.rect(avgX, groupTop, widths[widths.length - 1], groupH);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.setTextColor(...(ageDays === 28 ? GREEN : CHARCOAL));
      doc.text(fmtDec(r.average_strength_mpa), avgX + widths[widths.length - 1] / 2, groupTop + groupH / 2 + 1.6, { align: "center" });
      if (rowCursor > 0) doc.line(MARGIN_X, groupTop, MARGIN_X + CONTENT_W - widths[widths.length - 1], groupTop);
      rowCursor += cubes.length;
    });
    y = tableTop + rh * totalRows + 5;
  }

  // ---------------- Remarks + signatories ----------------
  // Round 129 feedback (both rounds) — Remarks is full-width (not sharing a
  // row with the signatures), and Tested By / Checked By sit side by side on
  // one row well below it (more breathing room), instead of Tested By under
  // Remarks and Checked By floating at the top-right like the single-result
  // layout above uses.
  y = ensureSpace(y, 46);
  doc.setFillColor(...HEAD_TINT);
  doc.rect(MARGIN_X, y, CONTENT_W, 5.5, "F");
  doc.setDrawColor(...BORDER);
  doc.rect(MARGIN_X, y, CONTENT_W, 5.5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.6);
  doc.setTextColor(...RED);
  doc.text("REMARKS", MARGIN_X + 3, y + 3.9);
  // Round 131 — no age prefix needed on a single-age report; only label
  // which age a remark belongs to once there's a real choice between two.
  let remarksText;
  if (day7 && day28) {
    const remarksParts = [];
    if (day7.remarks) remarksParts.push(`7-Day: ${day7.remarks}`);
    if (day28.remarks) remarksParts.push(`28-Day: ${day28.remarks}`);
    remarksText = remarksParts.length ? remarksParts.join("   ·   ") : "No remarks.";
  } else {
    remarksText = (day7 || day28)?.remarks || "No remarks.";
  }
  const remarkLines = doc.splitTextToSize(remarksText, CONTENT_W - 6);
  const remarksH = Math.max(remarkLines.length * 3.6 + 4, 16);
  doc.rect(MARGIN_X, y + 5.5, CONTENT_W, remarksH);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.4);
  doc.setTextColor(...CHARCOAL);
  remarkLines.forEach((line, i) => doc.text(line, MARGIN_X + 3, y + 5.5 + 4.4 + i * 3.6));
  y = y + 5.5 + remarksH + 14;

  const testedByName = day7 && day28
    ? (day7.tested_by_name === day28.tested_by_name ? day7.tested_by_name : `${day7.tested_by_name} (7-Day) / ${day28.tested_by_name} (28-Day)`)
    : (day7 || day28)?.tested_by_name || "—";
  const halfW = (CONTENT_W - 14) / 2;
  doc.setDrawColor(...CHARCOAL);
  doc.line(MARGIN_X, y, MARGIN_X + halfW, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.2);
  doc.setTextColor(...CHARCOAL);
  doc.text(testedByName, MARGIN_X, y + 3.8);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.text("Tested By — Lab Technician", MARGIN_X, y + 7);

  const sigX = MARGIN_X + halfW + 14;
  doc.line(sigX, y, sigX + halfW, y);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.text("Checked By — QA/QC", sigX, y + 3.8);
  y += 7 + 5;

  // ---------------- Footer ----------------
  y = ensureSpace(y, 16);
  const reportDate = [day7?.tested_at, day28?.tested_at].filter(Boolean).sort().pop();
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN_X, y, CONTENT_W, 7.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.2);
  doc.setTextColor(220, 228, 236);
  doc.text("OORM-QC-13", MARGIN_X + 3, y + 5);
  doc.text(`REPORT DATE: ${fmtDate(reportDate)}`, PAGE_W / 2, y + 5, { align: "center" });
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

// Round 130 — the pour's single combined report (both ages, one page). See
// renderCombinedPourSection above for what changed vs. the per-age report.
export async function generateCombinedPourCubeTestPdf(data) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* logo optional — proceed without it */ }
  await renderCombinedPourSection(doc, data, logoData);
  doc.save(`Cube_Test_Combined_Pour_${data.order_id}.pdf`);
  return doc;
}

// Round 131 feedback — a single-age report now goes through the exact same
// renderer as generateCombinedPourCubeTestPdf below (renderCombinedPourSection),
// with only one of day7/day28 filled in: no Sample IDs in the header, the
// Age/Average columns and untested-cube omission that already applied to
// the combined report, and the same Tested By/Checked By footer layout —
// instead of the older, differently laid out format renderCubeTestSection
// produces (that function is kept only for generateCombinedCubeTestPdf's own
// different same-day-multiple-pours job, further below). Every caller of
// this function — Lab Technician, the customer portal, the public
// booking-link form, and the staff Cube Test Report — gets the new format
// automatically, with no call-site changes needed.
export async function generateCubeTestPdf(data) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* logo optional — proceed without it */ }
  const wrapped = {
    order_id: data.order_id,
    casting_location: data.casting_location,
    customer_name: data.customer_name,
    site_name: data.site_name,
    mix_grade_name: data.mix_grade_name,
    cast_at: data.cast_at || data.cast_date, // plant results carry cast_at, site-cast results carry cast_date
    is_site_cast: !!data.is_site_cast,
    design_ref_code: data.design_ref_code,
    fck_28day_mpa: data.fck_28day_mpa,
    day7: data.testing_age_days === 7 ? data : null,
    day28: data.testing_age_days === 28 ? data : null,
  };
  await renderCombinedPourSection(doc, wrapped, logoData);
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
