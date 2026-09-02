// Transit Mixer Weekly Inspection Checklist — printable report (round 133).
//
// Same jsPDF native-vector pattern as the other PDF generators in this app
// (cubeTestPdf.js, deliveryChallanPdf.js). Layout matches the business's own
// TM_Check_list_for_Plant_Incharge.pdf template as closely as a FILLED-IN
// report reasonably can: same header, same Vehicle/Driver/Cleaner/Date row,
// same five numbered sections, same Observations box and two signature
// lines at the bottom.
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

// Draws the fixed top block — logo/company name, report title, and the
// Vehicle No. / Driver Name / Cleaner Name / Date row. Called on page 1 and
// again (in a shorter form) at the top of every continuation page, so a
// reader flipping to page 2 of a long checklist still knows whose truck
// they're looking at.
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
  doc.setLineWidth(0.2);
  y += 6;

  if (!continued) {
    const rh = 8.2;
    const fields = [
      ["Vehicle No.", data.truck_number || "—"],
      ["Driver Name", data.driver_name || "—"],
      ["Cleaner Name", data.cleaner_name || "—"],
    ];
    const cw = CONTENT_W / 3;
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, CONTENT_W, rh);
    fields.forEach((f, i) => {
      const cx = MARGIN_X + i * cw;
      if (i > 0) doc.line(cx, y, cx, y + rh);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.6);
      doc.setTextColor(...SLATE);
      doc.text(f[0].toUpperCase(), cx + 2.2, y + 3.5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.4);
      doc.setTextColor(...CHARCOAL);
      doc.text(String(f[1]), cx + 2.2, y + rh - 2.2);
    });
    y += rh + 5;
  } else {
    y += 3;
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
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
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

function drawCheckbox(doc, cx, cy, size, filled) {
  doc.setDrawColor(...CHARCOAL);
  doc.setLineWidth(0.25);
  if (filled) {
    doc.setFillColor(...NAVY);
    doc.rect(cx - size / 2, cy - size / 2, size, size, "FD");
  } else {
    doc.rect(cx - size / 2, cy - size / 2, size, size);
  }
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
    y = ensureSpace(y, 10 + 6);
    doc.setFillColor(...RED);
    doc.rect(MARGIN_X, y, CONTENT_W, 5.6, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...WHITE);
    doc.text(sec.title.toUpperCase(), MARGIN_X + 3, y + 3.9);
    y += 5.6;

    if (!isBinarySection) {
      // ---- Poor / Satisfactory / Good / Very Good checkbox grid ----
      const itemColW = CONTENT_W * 0.42;
      const optColW = (CONTENT_W - itemColW) / RATING_SCALE.length;
      const headH = 6;
      y = ensureSpace(y, headH);
      doc.setFillColor(...SHADE);
      doc.rect(MARGIN_X, y, CONTENT_W, headH, "F");
      doc.setDrawColor(...BORDER);
      doc.rect(MARGIN_X, y, CONTENT_W, headH);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.6);
      doc.setTextColor(...NAVY);
      doc.text("INSPECTION ITEM", MARGIN_X + 2.5, y + headH / 2 + 1.1);
      RATING_SCALE.forEach((r, i) => {
        const cx = MARGIN_X + itemColW + i * optColW;
        doc.line(cx, y, cx, y + headH);
        doc.text(r.label.toUpperCase(), cx + optColW / 2, y + headH / 2 + 1.1, { align: "center" });
      });
      y += headH;

      const rh = 6.2;
      sec.items.forEach((item) => {
        y = ensureSpace(y, rh);
        doc.setDrawColor(...BORDER);
        doc.rect(MARGIN_X, y, CONTENT_W, rh);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.4);
        doc.setTextColor(...CHARCOAL);
        doc.text(item.label, MARGIN_X + 2.5, y + rh / 2 + 1.1);
        const selected = ratings[item.key];
        RATING_SCALE.forEach((r, i) => {
          const cx = MARGIN_X + itemColW + i * optColW + optColW / 2;
          if (i > 0) doc.line(MARGIN_X + itemColW + i * optColW, y, MARGIN_X + itemColW + i * optColW, y + rh);
          drawCheckbox(doc, cx, y + rh / 2, 2.6, selected === r.value);
        });
        y += rh;
      });
      y += 4;
    } else {
      // ---- Section 5 — each item's own two-option response ----
      const itemColW = CONTENT_W * 0.5;
      const respColW = CONTENT_W - itemColW;
      const headH = 6;
      y = ensureSpace(y, headH);
      doc.setFillColor(...SHADE);
      doc.rect(MARGIN_X, y, CONTENT_W, headH, "F");
      doc.setDrawColor(...BORDER);
      doc.rect(MARGIN_X, y, CONTENT_W, headH);
      doc.line(MARGIN_X + itemColW, y, MARGIN_X + itemColW, y + headH);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.6);
      doc.setTextColor(...NAVY);
      doc.text("INSPECTION ITEM", MARGIN_X + 2.5, y + headH / 2 + 1.1);
      doc.text("RESPONSE", MARGIN_X + itemColW + 2.5, y + headH / 2 + 1.1);
      y += headH;

      const rh = 6.6;
      sec.items.forEach((item) => {
        y = ensureSpace(y, rh);
        doc.setDrawColor(...BORDER);
        doc.rect(MARGIN_X, y, CONTENT_W, rh);
        doc.line(MARGIN_X + itemColW, y, MARGIN_X + itemColW, y + rh);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.4);
        doc.setTextColor(...CHARCOAL);
        doc.text(item.label, MARGIN_X + 2.5, y + rh / 2 + 1.1);

        const scale = item.scale || RATING_SCALE;
        const selected = ratings[item.key];
        const positive = scale.find((s) => s.value === 4) || scale[0];
        const negative = scale.find((s) => s.value === 1) || scale[1];
        const answered = selected === 4 || selected === 1;
        const label = selected === 4 ? positive.label : selected === 1 ? negative.label : "— Not answered —";
        const color = selected === 4 ? GREEN : selected === 1 ? ALERT : SLATE;
        drawCheckbox(doc, MARGIN_X + itemColW + 4, y + rh / 2, 2.8, answered);
        doc.setFont("helvetica", answered ? "bold" : "italic");
        doc.setFontSize(7.6);
        doc.setTextColor(...color);
        doc.text(label, MARGIN_X + itemColW + 8, y + rh / 2 + 1.1);
        y += rh;
      });
      y += 4;
    }
  }

  // ---------------- Observations / corrective action ----------------
  y = ensureSpace(y, 26);
  doc.setFillColor(...SHADE);
  doc.rect(MARGIN_X, y, CONTENT_W, 5.5, "F");
  doc.setDrawColor(...BORDER);
  doc.rect(MARGIN_X, y, CONTENT_W, 5.5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.4);
  doc.setTextColor(...NAVY);
  doc.text("OBSERVATIONS / CORRECTIVE ACTION REQUIRED", MARGIN_X + 3, y + 3.8);
  const obsText = data.observations || "None.";
  const obsLines = doc.splitTextToSize(obsText, CONTENT_W - 6);
  const obsH = Math.max(obsLines.length * 3.7 + 5, 16);
  doc.rect(MARGIN_X, y + 5.5, CONTENT_W, obsH);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.4);
  doc.setTextColor(...CHARCOAL);
  obsLines.forEach((line, i) => doc.text(line, MARGIN_X + 3, y + 5.5 + 4.4 + i * 3.7));
  y += 5.5 + obsH + 14;

  // ---------------- Signatures ----------------
  y = ensureSpace(y, 16);
  const halfW = (CONTENT_W - 14) / 2;
  doc.setDrawColor(...CHARCOAL);
  doc.line(MARGIN_X, y, MARGIN_X + halfW, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.2);
  doc.setTextColor(...CHARCOAL);
  doc.text(data.filled_by_name || "—", MARGIN_X, y + 3.8);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.text("Plant In-Charge Signature", MARGIN_X, y + 7);

  const sigX = MARGIN_X + halfW + 14;
  doc.line(sigX, y, sigX + halfW, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.2);
  doc.setTextColor(...CHARCOAL);
  doc.text(data.driver_name || "—", sigX, y + 3.8);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.9);
  doc.setTextColor(...SLATE);
  doc.text("Driver Signature", sigX, y + 7);

  drawFooter(doc, data);
  doc.save(`Truck_Inspection_${data.truck_number || data.truck_id}_${(data.inspection_date || "").slice(0, 10)}.pdf`);
  return doc;
}
