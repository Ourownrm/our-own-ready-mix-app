// Delivery Challan (Gate Pass & Delivery Note) — A4 PDF generator.
//
// Built with jsPDF's native vector drawing API (not html2canvas) so the
// printed text stays crisp. The layout, field set, fixed defaults, and the
// Terms & Conditions text below all replicate the confirmed mock built from
// the user-supplied OORM_DeliveryNote_V2.01.docx template. Per the user's
// explicit instruction, every piece of DATA (both the fixed mix-design
// defaults and the live values pulled from the database) renders in blue
// (0070C0); every LABEL stays black.
import { apiRequest } from "./api.js";

const BLUE = [0, 112, 192];
const BLACK = [0, 0, 0];
const GRAY = [68, 84, 106];
const RED = [192, 0, 0];
const BORDER = [150, 150, 150];

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN_X = 10;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BOTTOM_LIMIT = 283;

// Full, unmodified Terms & Conditions text from the approved template —
// do not edit without the user's sign-off; this is a legal/contractual
// document that accompanies every outbound truck.
const TERMS = [
  "It is the Contractor’s/Customer's responsibility to provide safe and well-maintained access for the supplier’s pumps and transit mixers to ensure proper safety standards and avoid any damage to the supplier’s vehicles.",
  "Any claims or disputes regarding the quantity delivered must be notified in writing within 24 hours from the time the pour is completed.",
  "Our Own Ready Mix shall not be responsible for any alterations made to the concrete after it arrives at the project site, nor for any resulting quality issues.",
  "The 28-day compressive strength of the concrete is guaranteed only if the sampling and cube preparation are carried out by Our Own Ready-Mix technicians, and the cubes are properly cured and tested at approved laboratories as per the relevant IS standards.",
  "Concrete in the transit mixer must be fully unloaded, and the truck must be released within 2 hours of reaching the site.",
  "If the concrete is batched at the plant as per the customer’s order, full payment becomes due irrespective of its use or return. Under no circumstances will such concrete be taken back.",
  "Our Own Ready Mix shall not be responsible for plastic shrinkage, settlement cracks, drying shrinkage, or restraint cracks. No claims for repair will be entertained, as such cracks typically result from improper handling during casting or the absence of crack-control measures such as contraction joints, adequate reinforcement, or timely curing — all of which are beyond our scope of work.",
  "The supplier shall not be liable for concrete setting, workability loss, or finishing issues arising due to extreme weather conditions (high temperature, rain, humidity) beyond its control.",
];

const POUR_INSTRUCTIONS = [
  "Before placing the concrete, ensure the slab/formwork is adequately wetted (surface should be damp, not waterlogged).",
  "Ensure proper compaction by vibrating the concrete uniformly to avoid honeycombing and voids.",
  "Allow only essential personnel on the slab/roof during concrete placement to avoid disturbance and overloading.",
  "Ensure the concrete is levelled accurately to the required line and grade.",
  "Wet all concrete-contact surfaces with the prescribed amount of water as instructed.",
  "Immediately after finishing, cover the concrete surface with a sheet (hessian cloth/plastic) to avoid direct sunlight and keep it moist as required.",
  "After 12 hours of placing the concrete, start curing by applying the prescribed quantity of water continuously for 14 days.",
  "Formwork/shuttering shall not be removed for at least 14 days, unless otherwise approved by the engineer or as per IS standards.",
];

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

function fmtTime(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  return dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function fmtQty(v) {
  if (v === null || v === undefined || v === "") return "";
  return Number(v).toFixed(2);
}

export async function generateDeliveryChallanPdf(ticketId) {
  const data = await apiRequest(`/administrator/tickets/${ticketId}/challan`);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  let logoData = null;
  try { logoData = await loadLogoBase64(); } catch { /* logo optional — proceed without it */ }

  const mixCode = data.mix_grade_name ? `OR${data.mix_grade_name}` : "";
  const methodOfPouring = data.pump_requirement && data.pump_requirement !== "without_pump" ? "With Pump" : "Direct";

  function ensureSpace(y, needed) {
    if (y + needed > BOTTOM_LIMIT) {
      doc.addPage();
      return 15;
    }
    return y;
  }

  // ---------------- Header ----------------
  let y = 14;
  if (logoData) {
    try { doc.addImage(logoData, "JPEG", MARGIN_X, y - 6, 20, 20); } catch { /* ignore bad image */ }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...RED);
  doc.text("OUR OWN READY MIX", PAGE_W / 2, y, { align: "center" });
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...GRAY);
  doc.text("Plot No. 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala. 671321.", PAGE_W / 2, y, { align: "center" });
  y += 4;
  doc.text("+91 83 4007 4006      mail@ourownrm.com      www.ourownrm.com", PAGE_W / 2, y, { align: "center" });
  y += 4;
  doc.text("GSTIN : 32AAGFO7545J1Z2", PAGE_W / 2, y, { align: "center" });
  y += 5;
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  y += 7;

  // ---------------- Title + DN No ----------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...BLACK);
  doc.text("GATE PASS & DELIVERY NOTE", MARGIN_X, y);
  doc.setFontSize(9.5);
  const dnLabel = "DN No: ";
  const dnLabelW = doc.getTextWidth(dnLabel);
  doc.text(dnLabel, PAGE_W - MARGIN_X - dnLabelW - doc.getTextWidth(String(data.ticket_number || "")), y);
  doc.setTextColor(...BLUE);
  doc.text(String(data.ticket_number || ""), PAGE_W - MARGIN_X - doc.getTextWidth(String(data.ticket_number || "")), y);
  y += 4;

  // ---------------- Info grid ----------------
  const rowH = 7;

  function drawRow(cells) {
    y = ensureSpace(y, rowH);
    const totalW = CONTENT_W;
    let x = MARGIN_X;
    doc.setDrawColor(...BORDER);
    doc.rect(MARGIN_X, y, totalW, rowH);
    cells.forEach((cell, i) => {
      if (i > 0) doc.line(x, y, x, y + rowH);
      const padX = x + 2;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...BLACK);
      doc.text(cell.label, padX, y + rowH / 2 + 1.2);
      const labelW = doc.getTextWidth(cell.label);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...BLUE);
      const valueX = padX + labelW + 1.5;
      const maxValueW = cell.w - labelW - 5;
      const valueText = String(cell.value ?? "");
      const fitted = maxValueW > 0 ? doc.splitTextToSize(valueText, maxValueW)[0] || "" : valueText;
      doc.text(fitted, valueX, y + rowH / 2 + 1.2);
      x += cell.w;
    });
    y += rowH;
  }

  const w4 = CONTENT_W / 4;
  const w3 = CONTENT_W / 3;
  const w2 = CONTENT_W / 2;

  drawRow([
    { label: "Date: ", value: fmtDate(data.ticket_date), w: w4 },
    { label: "Branch: ", value: "Ananthapuram", w: w4 },
    { label: "Plant: ", value: "Plant 1", w: w4 },
    { label: "Loading Time: ", value: fmtTime(data.created_at), w: w4 },
  ]);
  drawRow([
    { label: "Customer: ", value: data.customer_name, w: w2 + w4 },
    { label: "Order No: ", value: `#${data.order_id}`, w: w4 },
  ]);
  drawRow([
    { label: "Project: ", value: data.site_name, w: w2 + w4 },
    { label: "Batch No: ", value: "", w: w4 },
  ]);
  drawRow([
    { label: "Location/Site: ", value: data.site_address || "", w: w2 + w4 },
    { label: "Site Contact: ", value: data.site_contact_number || "", w: w4 },
  ]);
  drawRow([
    { label: "Mode of Dispatch: ", value: "By Road", w: CONTENT_W },
  ]);
  drawRow([
    { label: "Ordered Qty m3: ", value: fmtQty(data.order_quantity_m3), w: w4 },
    { label: "Delivered Qty m3: ", value: fmtQty(data.delivered_prior_m3), w: w4 },
    { label: "Balance Qty m3: ", value: fmtQty(data.balance_m3), w: w4 },
    { label: "This Load m3: ", value: fmtQty(data.loaded_quantity_m3), w: w4 },
  ]);
  drawRow([
    { label: "Mix Code: ", value: mixCode, w: w4 },
    { label: "Grade/Class: ", value: data.mix_grade_name || "", w: w4 },
    { label: "Structure: ", value: data.casting_location || "", w: w4 },
    { label: "Workability: ", value: data.specified_slump_mm ? `${data.specified_slump_mm} mm` : "", w: w4 },
  ]);
  drawRow([
    { label: "Truck: ", value: data.truck_number || "", w: w3 },
    { label: "Driver: ", value: data.driver_name || "", w: w3 },
    { label: "Pump No.: ", value: data.pump_code || "", w: w3 },
  ]);

  y += 3;

  // ---------------- Mix design table ----------------
  y = ensureSpace(y, rowH + 2);
  drawRow([
    { label: "Cement Type/Brand: ", value: "OPC", w: w4 },
    { label: "Max. Aggregate Size: ", value: "20MM", w: w4 },
    { label: "Sand Used: ", value: "M SAND", w: w4 },
    { label: "Admixture Type/Brand: ", value: "PC200", w: w4 },
  ]);
  drawRow([
    { label: "Free Water/Cement Ratio: ", value: "", w: CONTENT_W },
  ]);

  y += 3;

  // ---------------- Signed-for / Site Checks block ----------------
  const halfW = CONTENT_W / 2;
  const blockH = 30;
  y = ensureSpace(y, blockH + 6);
  const blockTop = y;
  doc.setDrawColor(...BORDER);
  doc.rect(MARGIN_X, blockTop, CONTENT_W, blockH);
  doc.line(MARGIN_X + halfW, blockTop, MARGIN_X + halfW, blockTop + blockH);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...BLACK);
  doc.text("Signed for and on behalf of Our Own Ready Mix", MARGIN_X + 2, blockTop + 5);
  doc.text("Site Checks", MARGIN_X + halfW + 2, blockTop + 5);

  function labelValueLine(x, yy, label, value) {
    const trimmedLabel = label.trimEnd();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...BLACK);
    doc.text(trimmedLabel, x, yy);
    // Measure width while still in the bold font used to draw the label —
    // switching to normal first (as an earlier version did) under-measures
    // bold text and lets long labels visually collide with the value.
    const labelW = doc.getTextWidth(trimmedLabel);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BLUE);
    doc.text(String(value ?? ""), x + labelW + 2.2, yy);
  }

  labelValueLine(MARGIN_X + 2, blockTop + 12, "Prepared by: ", data.plant_operator_name || "");
  labelValueLine(MARGIN_X + 2, blockTop + 19, "Quality Control: ", "");
  labelValueLine(MARGIN_X + 2, blockTop + 26, "Method of Pouring: ", methodOfPouring);

  labelValueLine(MARGIN_X + halfW + 2, blockTop + 12, "Time Arrived: ", "");
  labelValueLine(MARGIN_X + halfW + 2, blockTop + 19, "Workability: ", "");
  labelValueLine(MARGIN_X + halfW + 2, blockTop + 26, "Pouring Completed At: ", "");

  y = blockTop + blockH + 5;

  // ---------------- Remarks ----------------
  y = ensureSpace(y, 8);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...BLACK);
  doc.text("Remarks: ", MARGIN_X, y);
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN_X + doc.getTextWidth("Remarks: ") + 2, y, PAGE_W - MARGIN_X, y);
  y += 8;

  // ---------------- Terms & Conditions ----------------
  y = ensureSpace(y, 10);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(...BLACK);
  doc.text("Terms And Conditions for Supply of Ready-Mix Concrete", MARGIN_X, y);
  y += 5;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.3);
  const termIndent = 5;
  const termTextW = CONTENT_W - termIndent;

  TERMS.forEach((term, idx) => {
    const lines = doc.splitTextToSize(`${idx + 1}. ${term}`, termTextW);
    y = ensureSpace(y, lines.length * 3.4 + 1);
    doc.setTextColor(...BLACK);
    lines.forEach((line, li) => {
      doc.text(line, MARGIN_X + (li === 0 ? 0 : termIndent), y);
      y += 3.4;
    });
    y += 0.6;
  });

  // Item 9 — "Pour Instructions" heading with a-h sub-items
  const headingLines = doc.splitTextToSize("9. Pour Instructions", termTextW);
  y = ensureSpace(y, headingLines.length * 3.4 + 1);
  doc.setFont("helvetica", "bold");
  headingLines.forEach((line) => { doc.text(line, MARGIN_X, y); y += 3.4; });
  y += 0.6;

  doc.setFont("helvetica", "normal");
  const letters = ["a", "b", "c", "d", "e", "f", "g", "h"];
  POUR_INSTRUCTIONS.forEach((item, idx) => {
    const lines = doc.splitTextToSize(`${letters[idx]}. ${item}`, termTextW - termIndent);
    y = ensureSpace(y, lines.length * 3.4 + 1);
    lines.forEach((line) => {
      doc.text(line, MARGIN_X + termIndent, y);
      y += 3.4;
    });
    y += 0.6;
  });

  y += 4;

  // ---------------- Received & Accepted ----------------
  y = ensureSpace(y, 22);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...BLACK);
  doc.text("Received & Accepted – In Accordance with the above details.", MARGIN_X, y);
  y += 16;
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN_X, y, MARGIN_X + 80, y);
  y += 4;
  doc.setFontSize(7.5);
  doc.text("Signed by or on behalf of Customer", MARGIN_X, y);

  doc.save(`Delivery_Challan_${data.ticket_number || ticketId}.pdf`);
}
