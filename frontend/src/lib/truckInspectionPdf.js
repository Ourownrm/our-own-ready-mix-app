// Transit Mixer Weekly Inspection Checklist — printable report (round 133;
// one-page fit + line-weight fix + Odometer/Hour Meter fields, round 134).
//
// Same jsPDF native-vector pattern as the other PDF generators in this app
// (cubeTestPdf.js, deliveryChallanPdf.js). Layout matches the business's own
// TM_Check_list_for_Plant_Incharge.pdf template as closely as a FILLED-IN
// report reasonably can: same header, same Vehicle/Driver/Cleaner/Date row,
// same five numbered sections, same Observations box and two signature
// lines at the bottom — and, like that source template (confirmed a single
// Letter page), the whole thing is sized to fit on ONE A4 page. Row/section
// spacing below was tuned specifically so all 36 items + 5 section headers +
// observations + signatures fit within one page's content area (verified
// with a Node smoke test rendering real data — see round 134 notes) —
// change these constants carefully, a small increase across 36 rows adds up
// fast.
//
// One deliberate departure from the blank template: Safety & Documentation
// (section 5) items are no longer scored on the Poor/Satisfactory/Good/Very
// Good scale (see inspectionChecklist.js) — each item now has its own
// two-option response (Available/Not Available, Working/Not Working,
// Yes/No). Reproducing a 4-column checkbox grid for a 2-option answer would
// leave two columns always blank and wouldn't show which two words apply to
// THIS item, so section 5 instead prints the item's own selected answer as
// bold text with a filled/hollow marker, in a single "Response" column.
//
// jsPDF's standard fonts don't reliably render Unicode outside WinAnsi (see
// cubeTestPdf.js's own note on this) — checkboxes here are drawn as plain
// vector squares (hollow = not selected, filled = selected), never a
// checkmark glyph.
//
// The checklist's section/item/scale structure lives on the backend
// (backend/src/lib/inspectionChecklist.js) and is fetched via GET
// /maintenance/checklist-definition — same source Maintenance.jsx's
// InspectionForm already uses — never duplicated here. The caller passes
// that `{ sections, rating_scale }` definition in as `checklistDef`.

const RED = [176, 35, 29];
const NAVY = [31, 59, 92];
const SLATE = [91, 100, 112];
const CHARCOAL = [34, 38, 43];
const BORDER = [180, 180, 180];
const SHADE = [238, 242, 246];
const GREEN = [29, 122, 85];
const ALERT = [176, 58, 46];
const WHITE = [255, 255, 255];

const PAGE_W = 210;
const MARGIN_X = 12;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BOTTOM_LIMIT = 283;

// Row/section constants — see the file-header note above on why these are
// this tight. Reference template (business's own TM_Check_list_for_
// Plant_Incharge.pdf) runs its own data rows at ~4.1mm; these are close to
// that.
const SECTION_BAR_H = 4.6;
const GRID_HEAD_H = 4.6;
const GRID_ROW_H = 4.15;
const BINARY_ROW_H = 4.6;
const SECTION_GAP = 1.4;

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

// Sets the shared "normal border" draw style. Called explicitly before
// every line/rect that isn't a checkbox, rather than trusting whatever
// jsPDF's graphics state happens to still be — see drawCheckbox's own note
// on why that trust was exactly the bug (line weights/colors bleeding
// between unrelated shapes) round 134 fixed.
function setBorderStyle(doc) {
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
}

// Draws the fixed top block — logo/company name, report title, and the
// Vehicle No. / Driver Name / Cleaner Name / Odometer / Hour Meter row.
// Called on page 1 and again (in a shorter form) at the top of every
// continuation page, so a reader flipping to page 2 of a long checklist
// still knows whose truck they're looking at. In practice, with the
// tightened row heights below, a normal checklist no longer needs a page 2
// at all — this stays in place as a safety net for an unusually long
// Observations note or a future extra section.
function drawHeader(doc, data, logoData, { continued }) {
  let y = 16;
  if (logoData) {
    try { doc.addImage(logoData, "JPEG", MARGIN_X, y - 9.75, 16.5, 16.5); } catch { /* ignore bad image */ }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...RED);
  doc.text("OUR OWN READY MIX", MARGIN_X + 20.5, y - 2);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...CHARCOAL);
  doc.text(`TRANSIT MIXER WEEKLY INSPECTION CHECKLIST${continued ? "  (continued)" : ""}`, MARGIN_X + 20.5, y + 3.5);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...SLATE);
  doc.text(`Date: ${fmtDate(data.inspection_date)}`, PAGE_W - MARGIN_X, y - 2, { align: "right" });
  if (continued) {
    doc.text(`Vehicle ${data.truck_number || "—"}`, PAGE_W - MARGIN_X, y + 3.5, { align: "right" });
  }

  y += 9;
  doc.setDrawColor(...RED);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  setBorderStyle(doc);
  y += 5.5;

  if (!continued) {
    const rh = 7.4;
    // Round 134, item 3 — Odometer/Hour Meter added alongside the existing
    // three fields; five equal columns instead of three.
    const fields = [
      ["Vehicle No.", data.truck_number || "—"],
      ["Driver Name", data.driver_name || "—"],
      ["Cleaner Name", data.cleaner_name || "—"],
      ["Odometer", data.odometer_reading != null && data.odometer_reading !== "" ? String(data.odometer_reading) : "—"],
      ["Hour Meter", data.hour_meter_reading != null && data.hour_meter_reading !== "" ? String(data.hour_meter_reading) : "—"],
    ];
    const cw = CONTENT_W / fields.length;
    setBorderStyle(doc);
    doc.rect(MARGIN_X, y, CONTENT_W, rh);
    fields.forEach((f, i) => {
      const cx = MARGIN_X + i * cw;
      if (i > 0) doc.line(cx, y, cx, y + rh);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.3);
      doc.setTextColor(...SLATE);
      doc.text(f[0].toUpperCase(), cx + 2, y + 3.2);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.8);
      doc.setTextColor(...CHARCOAL);
      doc.text(String(f[1]), cx + 2, y + rh - 1.8);
    });
    y += rh + 3.5;
  } else {
    y += 2.5;
  }
  return y;
}

// Compact footer, drawn at a fixed spot near the bottom of every page (not
// in the content flow) — form number, report/inspection date, and rev, plus
// the company address line. Deliberately short (this app's cube test report
// footer went through the same "reduce the height" feedback — see
// cubeTestPdf.js — so this one starts out short rather than needing the
// same fix later).
function drawFooter(doc, data) {
  const y = 288;
  setBorderStyle(doc);
  doc.line(MARGIN_X, y - 3, PAGE_W - MARGIN_X, y - 3);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.6);
  doc.setTextColor(...SLATE);
  doc.text("OORM-MT-04", MARGIN_X, y);
  doc.text(`INSPECTION DATE: ${fmtDate(data.inspection_date)}`, PAGE_W / 2, y, { align: "center" });
  doc.text("REV. 0", PAGE_W - MARGIN_X, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.2);
  doc.setTextColor(...SLATE);
  doc.text("Our Own Ready Mix, Plot No 3C-2, Industrial Area, Ananthapuram, Kasaragod, Kerala — 671321", PAGE_W / 2, y + 3.5, { align: "center" });
}

// Round 134, item 5 fix: this used to leave the draw color/line width at
// CHARCOAL/0.25 (the checkbox's own stroke) after returning, so whichever
// grid line was drawn NEXT — with no explicit setDrawColor/setLineWidth of
// its own — silently inherited that darker, thicker stroke instead of the
// normal border style. That's exactly why the printed report had some
// column-divider lines noticeably bolder than the row lines around them.
// Restoring the shared border style before returning makes every checkbox
// call self-contained, regardless of what's drawn right after it.
function drawCheckbox(doc, cx, cy, size, filled) {
  doc.setDrawColor(...CHARCOAL);
  doc.setLineWidth(0.25);
  if (filled) {
    doc.setFillColor(...NAVY);
    doc.rect(cx - size / 2, cy - size / 2, size, size, "FD");
  } else {
    doc.rect(cx - size / 2, cy - size / 2, size, size);
  }
  setBorderStyle(doc);
}

export async function generateTruckInspectionPdf(data, checklistDef) {
  const CHECKLIST_SECTIONS = checklistDef.sections;
  const RATING_SCALE = checklistDef.rating_scale;
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* logo optional */ }

  function ensureSpace(y, needed) {
    if (y + needed > BOTTOM_LIMIT) {
      drawFooter(doc, data);
      doc.addPage();
      return drawHeader(doc, data, logoData, { continued: true });
    }
    return y;
  }

  let y = drawHeader(doc, data, logoData, { continued: false });
  const ratings = data.ratings || {};

  for (const sec of CHECKLIST_SECTIONS) {
    const isBinarySection = sec.items.every((it) => it.scale);

    // Section title bar.
    y = ensureSpace(y, SECTION_BAR_H + GRID_HEAD_H);
    doc.setFillColor(...RED);
    doc.rect(MARGIN_X, y, CONTENT_W, SECTION_BAR_H, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.8);
    doc.setTextColor(...WHITE);
    doc.text(sec.title.toUpperCase(), MARGIN_X + 3, y + SECTION_BAR_H / 2 + 1.3);
    y += SECTION_BAR_H;

    if (!isBinarySection) {
      // ---- Poor / Satisfactory / Good / Very Good checkbox grid ----
      const itemColW = CONTENT_W * 0.42;
      const optColW = (CONTENT_W - itemColW) / RATING_SCALE.length;
      y = ensureSpace(y, GRID_HEAD_H);
      doc.setFillColor(...SHADE);
      doc.rect(MARGIN_X, y, CONTENT_W, GRID_HEAD_H, "F");
      setBorderStyle(doc);
      doc.rect(MARGIN_X, y, CONTENT_W, GRID_HEAD_H);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.4);
      doc.setTextColor(...NAVY);
      doc.text("INSPECTION ITEM", MARGIN_X + 2.5, y + GRID_HEAD_H / 2 + 1.1);
      RATING_SCALE.forEach((r, i) => {
        const cx = MARGIN_X + itemColW + i * optColW;
        doc.line(cx, y, cx, y + GRID_HEAD_H);
        doc.text(r.label.toUpperCase(), cx + optColW / 2, y + GRID_HEAD_H / 2 + 1.1, { align: "center" });
      });
      y += GRID_HEAD_H;

      sec.items.forEach((item) => {
        y = ensureSpace(y, GRID_ROW_H);
        // Every border-relevant line for this row is drawn up front, in one
        // consistent style, BEFORE any checkbox — see drawCheckbox's note
        // above for exactly why that ordering (now also belt-and-suspenders
        // with the style restore in drawCheckbox itself) matters here.
        setBorderStyle(doc);
        doc.rect(MARGIN_X, y, CONTENT_W, GRID_ROW_H);
        for (let i = 1; i < RATING_SCALE.length; i++) {
          const lx = MARGIN_X + itemColW + i * optColW;
          doc.line(lx, y, lx, y + GRID_ROW_H);
        }
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.2);
        doc.setTextColor(...CHARCOAL);
        doc.text(item.label, MARGIN_X + 2.5, y + GRID_ROW_H / 2 + 1.1);
        const selected = ratings[item.key];
        RATING_SCALE.forEach((r, i) => {
          const cx = MARGIN_X + itemColW + i * optColW + optColW / 2;
          drawCheckbox(doc, cx, y + GRID_ROW_H / 2, 2.3, selected === r.value);
        });
        y += GRID_ROW_H;
      });
      y += SECTION_GAP;
    } else {
      // ---- Section 5 — each item's own two-option response ----
      const itemColW = CONTENT_W * 0.5;
      y = ensureSpace(y, GRID_HEAD_H);
      doc.setFillColor(...SHADE);
      doc.rect(MARGIN_X, y, CONTENT_W, GRID_HEAD_H, "F");
      setBorderStyle(doc);
      doc.rect(MARGIN_X, y, CONTENT_W, GRID_HEAD_H);
      doc.line(MARGIN_X + itemColW, y, MARGIN_X + itemColW, y + GRID_HEAD_H);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.4);
      doc.setTextColor(...NAVY);
      doc.text("INSPECTION ITEM", MARGIN_X + 2.5, y + GRID_HEAD_H / 2 + 1.1);
      doc.text("RESPONSE", MARGIN_X + itemColW + 2.5, y + GRID_HEAD_H / 2 + 1.1);
      y += GRID_HEAD_H;

      sec.items.forEach((item) => {
        y = ensureSpace(y, BINARY_ROW_H);
        setBorderStyle(doc);
        doc.rect(MARGIN_X, y, CONTENT_W, BINARY_ROW_H);
        doc.line(MARGIN_X + itemColW, y, MARGIN_X + itemColW, y + BINARY_ROW_H);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.2);
        doc.setTextColor(...CHARCOAL);
        doc.text(item.label, MARGIN_X + 2.5, y + BINARY_ROW_H / 2 + 1.1);

        const scale = item.scale || RATING_SCALE;
        const selected = ratings[item.key];
        const positive = scale.find((s) => s.value === 4) || scale[0];
        const negative = scale.find((s) => s.value === 1) || scale[1];
        const answered = selected === 4 || selected === 1;
        const label = selected === 4 ? positive.label : selected === 1 ? negative.label : "— Not answered —";
        const color = selected === 4 ? GREEN : selected === 1 ? ALERT : SLATE;
        drawCheckbox(doc, MARGIN_X + itemColW + 4, y + BINARY_ROW_H / 2, 2.6, answered);
        doc.setFont("helvetica", answered ? "bold" : "italic");
        doc.setFontSize(7.4);
        doc.setTextColor(...color);
        doc.text(label, MARGIN_X + itemColW + 8, y + BINARY_ROW_H / 2 + 1.1);
        y += BINARY_ROW_H;
      });
      y += SECTION_GAP;
    }
  }

  // ---------------- Observations / corrective action ----------------
  y = ensureSpace(y, 22);
  setBorderStyle(doc);
  doc.setFillColor(...SHADE);
  doc.rect(MARGIN_X, y, CONTENT_W, 5, "F");
  doc.rect(MARGIN_X, y, CONTENT_W, 5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.2);
  doc.setTextColor(...NAVY);
  doc.text("OBSERVATIONS / CORRECTIVE ACTION REQUIRED", MARGIN_X + 3, y + 3.5);
  const obsText = data.observations || "None.";
  const obsLines = doc.splitTextToSize(obsText, CONTENT_W - 6);
  const obsH = Math.max(obsLines.length * 3.6 + 4, 13);
  setBorderStyle(doc);
  doc.rect(MARGIN_X, y + 5, CONTENT_W, obsH);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.setTextColor(...CHARCOAL);
  obsLines.forEach((line, i) => doc.text(line, MARGIN_X + 3, y + 5 + 4.2 + i * 3.6));
  y += 5 + obsH + 5;

  // ---------------- Signatures ----------------
  y = ensureSpace(y, 9);
  const halfW = (CONTENT_W - 14) / 2;
  doc.setDrawColor(...CHARCOAL);
  doc.setLineWidth(0.2);
  doc.line(MARGIN_X, y, MARGIN_X + halfW, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...CHARCOAL);
  doc.text(data.filled_by_name || "—", MARGIN_X, y + 3.6);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.8);
  doc.setTextColor(...SLATE);
  doc.text("Plant In-Charge Signature", MARGIN_X, y + 6.7);

  const sigX = MARGIN_X + halfW + 14;
  doc.setDrawColor(...CHARCOAL);
  doc.setLineWidth(0.2);
  doc.line(sigX, y, sigX + halfW, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...CHARCOAL);
  doc.text(data.driver_name || "—", sigX, y + 3.6);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.8);
  doc.setTextColor(...SLATE);
  doc.text("Driver Signature", sigX, y + 6.7);

  drawFooter(doc, data);
  doc.save(`Truck_Inspection_${data.truck_number || data.truck_id}_${(data.inspection_date || "").slice(0, 10)}.pdf`);
  return doc;
}
