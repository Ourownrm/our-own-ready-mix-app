// Round 216 — printed PM Inspection report and Job Card (A4), laid out the way
// fleet workshops file them: company letterhead, document number and status,
// a vehicle block (asset no., registration, model, odometer / hour meter),
// the body tables, a cost summary on the job card, and signature boxes
// (inspected / raised by, mechanic / Plant In Charge, verified by, driver).
// Same letterhead, fonts and colours as the purchase order (Round 208), so ₹
// prints. jspdf-autotable is used through doc.autoTable (see
// materialReportPdf.js for why not the default export).
import { jsPDF } from "jspdf";

const BLUE = [43, 76, 155];
const GOLD = [226, 181, 43];
const INK = [28, 28, 28];
const GREY = [96, 96, 96];
const LIGHT = [243, 241, 236];
const RED = [179, 38, 30];
const GREEN = [31, 122, 77];
const PAGE_W = 210;
const PAGE_H = 297;
const MX = 14;
const CW = PAGE_W - MX * 2;

const cache = {};
async function asBase64(url) {
  if (cache[url]) return cache[url];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  cache[url] = btoa(bin);
  return cache[url];
}

async function newDoc() {
  const autoTableMod = await import("jspdf-autotable");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  if (typeof doc.autoTable !== "function") {
    const apply = autoTableMod.applyPlugin || (autoTableMod.default && autoTableMod.default.applyPlugin);
    if (typeof apply === "function") apply(jsPDF);
  }
  for (const [file, name, style] of [["Carlito-Regular.ttf", "Body", "normal"], ["Carlito-Bold.ttf", "Body", "bold"],
    ["Carlito-Italic.ttf", "Body", "italic"], ["Poppins-Bold.ttf", "Title", "bold"]]) {
    doc.addFileToVFS(file, await asBase64(`/fonts/${file}`));
    doc.addFont(file, name, style);
  }
  const [logo, footer] = await Promise.all([
    asBase64("/quote-logo.png").then((b) => `data:image/png;base64,${b}`).catch(() => null),
    asBase64("/quote-footer.png").then((b) => `data:image/png;base64,${b}`).catch(() => null),
  ]);
  const font = (style = "normal", size = 9.5, fam = "Body") => { doc.setFont(fam, style); doc.setFontSize(size); };
  const color = (c) => doc.setTextColor(...c);
  const text = (s, x, y, o) => doc.text(String(s ?? ""), x, y, o);
  return { doc, logo, footer, font, color, text };
}

const IST = "Asia/Kolkata";
export function day(ts) {
  if (!ts) return "—";
  const s = String(ts);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+05:30`) : new Date(ts);
  return d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" });
}
function when(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
const n0 = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 1 }));
const rs = (v) => (v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const q = (v) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function tableStyle(extra = {}) {
  return {
    margin: { left: MX, right: MX, bottom: 26 },
    styles: { font: "Body", fontSize: 9, cellPadding: 1.6, textColor: INK, lineColor: [205, 200, 190], lineWidth: 0.15, overflow: "linebreak" },
    headStyles: { font: "Body", fontStyle: "bold", fillColor: BLUE, textColor: 255, fontSize: 9 },
    footStyles: { font: "Body", fontStyle: "bold", fillColor: LIGHT, textColor: INK },
    alternateRowStyles: { fillColor: [250, 249, 246] },
    theme: "grid",
    ...extra,
  };
}

// Letterhead + title + document number box. Returns the y below it.
function header(k, title, number, status, statusTone) {
  const { doc, logo, font, color, text } = k;
  if (logo) doc.addImage(logo, "PNG", MX, 7, 20, 20);
  font("bold", 13, "Title"); color(BLUE);
  text("OUR OWN READY MIX", MX + (logo ? 24 : 0), 14);
  font("normal", 9); color(GREY);
  text("Maintenance department", MX + (logo ? 24 : 0), 19);
  font("bold", 14, "Title"); color(INK);
  text(title, PAGE_W - MX, 14, { align: "right" });
  font("bold", 11); color(BLUE);
  text(number, PAGE_W - MX, 20, { align: "right" });
  if (status) {
    font("bold", 9); color(statusTone || GREY);
    text(status.toUpperCase(), PAGE_W - MX, 25, { align: "right" });
  }
  doc.setDrawColor(...GOLD); doc.setLineWidth(0.7);
  doc.line(MX, 29, PAGE_W - MX, 29);
  color(INK);
  return 33;
}

// A ruled two-column block of label / value pairs.
function infoGrid(k, y, pairs, cols = 3) {
  const { doc } = k;
  const rows = [];
  for (let i = 0; i < pairs.length; i += cols) rows.push(pairs.slice(i, i + cols));
  const body = rows.map((r) => r.flatMap(([l, v]) => [l, v ?? "—"]).concat(Array((cols - r.length) * 2).fill("")));
  const lw = 24, vw = CW / cols - lw;
  doc.autoTable({
    ...tableStyle(),
    startY: y,
    body,
    theme: "grid",
    styles: { font: "Body", fontSize: 9, cellPadding: 1.4, textColor: INK, lineColor: [205, 200, 190], lineWidth: 0.15 },
    columnStyles: Object.fromEntries(Array.from({ length: cols * 2 }, (_, i) => [i, i % 2 === 0
      ? { cellWidth: lw, fontStyle: "bold", fillColor: LIGHT, textColor: GREY, fontSize: 8.5 } : { cellWidth: vw }])),
    alternateRowStyles: {},
  });
  return doc.lastAutoTable.finalY + 4;
}

function sectionTitle(k, y, label) {
  const { font, color, text, doc } = k;
  if (y > PAGE_H - 45) { doc.addPage(); y = 18; }
  font("bold", 10.5); color(BLUE);
  text(label, MX, y + 3);
  color(INK);
  return y + 5;
}

function signatures(k, y, boxes) {
  const { doc, font, color, text } = k;
  if (y > PAGE_H - 52) { doc.addPage(); y = 20; }
  const w = (CW - (boxes.length - 1) * 4) / boxes.length;
  boxes.forEach(([label, name, at], i) => {
    const x = MX + i * (w + 4);
    doc.setDrawColor(190, 185, 175); doc.setLineWidth(0.2);
    doc.rect(x, y, w, 24);
    font("bold", 8.5); color(GREY); text(label, x + 2, y + 4.5);
    font("normal", 9); color(INK);
    if (name) text(name, x + 2, y + 15);
    if (at) { font("normal", 8); color(GREY); text(at, x + 2, y + 19.5); }
    doc.line(x + 2, y + 21.5, x + w - 2, y + 21.5);
  });
  return y + 28;
}

function finish(k, docLabel) {
  const { doc, footer, font, color, text } = k;
  const pages = doc.getNumberOfPages();
  const stamp = new Date().toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (footer) {
      const fh = CW * 72 / 1153;
      doc.addImage(footer, "PNG", MX, PAGE_H - 8 - fh, CW, fh);
    }
    font("normal", 7.5); color(GREY);
    text(`${docLabel} · printed ${stamp} from the OORM app`, MX, PAGE_H - 4);
    text(`Page ${p} of ${pages}`, PAGE_W - MX, PAGE_H - 4, { align: "right" });
  }
}

function vehiclePairs(v, extra = []) {
  const linked = v.truck_number ? `Truck ${v.truck_number}` : v.pump_code ? `Pump ${v.pump_code}` : v.equipment_name || "—";
  return [
    ["Asset no.", v.asset_no || "—"], ["Registration", v.reg_no || "—"], ["Model", v.model_name || "—"],
    ["Type", v.asset_group || "—"], ["Year", v.asset_year || "—"], ["Fleet record", linked],
    ...extra,
  ];
}

// ------------------------------------------------------------ PM inspection --

export async function buildInspectionPdf(i) {
  const k = await newDoc();
  const { doc, font, color, text } = k;
  const answers = Array.isArray(i.answers) ? i.answers : [];
  const nok = answers.filter((a) => a.ok === false).length;
  let y = header(k, "PM INSPECTION REPORT", i.code, nok ? `${nok} Not OK` : "All OK", nok ? RED : GREEN);
  y = infoGrid(k, y, [
    ...vehiclePairs(i),
    ["Odometer", i.km != null ? `${n0(i.km)} km` : "—"], ["Hour meter", i.hours != null ? `${n0(i.hours)} h` : "—"], ["Inspected", when(i.done_at)],
  ]);
  y = infoGrid(k, y, [
    ["Schedule", i.schedule_name], ["Interval", i.trigger || "—"],
    ["Basis", { OEM: "Manufacturer", ENGINE: "Engine maker", PRACTICE: "Industry practice" }[i.basis] || i.basis || "—"],
    ["Inspected by", i.done_by_name || "—"], ["Job card", i.job_card_code || "None needed"],
    ["Next due", i.next_due?.next ? (/^\d{4}-\d{2}-\d{2}$/.test(i.next_due.next) ? day(i.next_due.next) : i.next_due.next) : "—"],
  ]);

  y = sectionTitle(k, y, "Checklist");
  doc.autoTable({
    ...tableStyle(),
    startY: y,
    head: [["#", "Check", "Result", "Remarks / defect found"]],
    body: answers.map((a, n) => [n + 1, a.label, a.ok ? "OK" : "NOT OK", a.ok ? "" : a.note || ""]),
    columnStyles: { 0: { cellWidth: 8, halign: "center" }, 1: { cellWidth: 82 }, 2: { cellWidth: 20, halign: "center", fontStyle: "bold" } },
    didParseCell: (d) => {
      if (d.section === "body" && d.column.index === 2) d.cell.styles.textColor = d.cell.raw === "OK" ? GREEN : RED;
    },
  });
  y = doc.lastAutoTable.finalY + 5;

  const tasks = Array.isArray(i.schedule_tasks) ? i.schedule_tasks : [];
  if (tasks.length) {
    const done = new Set(Array.isArray(i.tasks_done) ? i.tasks_done : []);
    y = sectionTitle(k, y, "Service tasks");
    doc.autoTable({
      ...tableStyle(),
      startY: y,
      head: [["#", "Task", "Parts / consumables", "Done"]],
      body: tasks.map((t, n) => [n + 1, t.task, t.parts || "", done.has(t.task) ? "Yes" : "No"]),
      columnStyles: { 0: { cellWidth: 8, halign: "center" }, 3: { cellWidth: 16, halign: "center", fontStyle: "bold" } },
      didParseCell: (d) => {
        if (d.section === "body" && d.column.index === 3) d.cell.styles.textColor = d.cell.raw === "Yes" ? GREEN : GREY;
      },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const other = Array.isArray(i.other_jobs) ? i.other_jobs : [];
  if (other.length || (i.jobs || []).length) {
    y = sectionTitle(k, y, `Jobs raised${i.job_card_code ? ` on ${i.job_card_code}` : ""}`);
    const rows = (i.jobs || []).length
      ? i.jobs.map((j, n) => [n + 1, j.description, j.origin === "not_ok" ? "Not OK item" : "Other job noticed", j.kind === "outside" ? "Outside" : "Inside"])
      : other.map((o, n) => [n + 1, o, "Other job noticed", "—"]);
    doc.autoTable({
      ...tableStyle(),
      startY: y,
      head: [["#", "Job", "From", "Inside / outside"]],
      body: rows,
      columnStyles: { 0: { cellWidth: 8, halign: "center" }, 2: { cellWidth: 34 }, 3: { cellWidth: 26 } },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  if (i.remarks) {
    y = sectionTitle(k, y, "Remarks");
    font("normal", 9.5); color(INK);
    const lines = doc.splitTextToSize(i.remarks, CW);
    text(lines, MX, y + 3);
    y += lines.length * 4.4 + 4;
  }

  y = sectionTitle(k, y + 2, "Sign-off");
  signatures(k, y, [["Inspected by", i.done_by_name, when(i.done_at)], ["Driver / operator", "", ""], ["Plant In Charge / Manager", "", ""]]);
  finish(k, `${i.code} · ${i.asset_name}`);
  return doc;
}

export async function printInspectionPdf(i) {
  const doc = await buildInspectionPdf(i);
  openPdf(doc, `${i.code}-${(i.reg_no || i.asset_no || "vehicle").replace(/\W+/g, "")}.pdf`);
}

// ----------------------------------------------------------------- job card --

const CARD_STATUS = { open: ["Open", [176, 112, 0]], work_done: ["Work done — to verify", BLUE], closed: ["Closed", GREEN], cancelled: ["Cancelled", GREY] };
const JOB_STATUS = { open: "Open", done: "Done", cancelled: "Cancelled" };
const ORIGIN = { not_ok: "PM inspection", other: "PM inspection", complaint: "Complaint", manual: "Added", general: "General works" };
const OUT_STATUS = {
  awaiting_approval: "Awaiting approval", approved: "Approved", rejected: "Rejected", sent_out: "At workshop",
  bill_hold: "Bill on hold", billed: "Returned, billed", cancelled: "Cancelled",
};

export async function buildJobCardPdf(c) {
  const k = await newDoc();
  const { doc, font, color, text } = k;
  const [st, tone] = CARD_STATUS[c.status] || [c.status, GREY];
  let y = header(k, c.general_month ? "JOB CARD — GENERAL WORKS" : "VEHICLE JOB CARD", c.code, st, tone);
  y = infoGrid(k, y, [
    ...vehiclePairs(c),
    ["Opened", when(c.opened_at)], ["Opened by", c.opened_by_name || "—"], ["Odometer in", c.km != null ? `${n0(c.km)} km` : "—"],
    ["Source", c.general_label ? `Lubricants · ${c.general_label}` : c.source || "—"],
    ["Work done", c.work_done_at ? when(c.work_done_at) : "—"], ["Verified", c.verified_at ? when(c.verified_at) : "—"],
  ]);

  const jobs = c.jobs || [];
  if (jobs.length && !c.general_month) {
    y = sectionTitle(k, y, "Jobs / complaints");
    doc.autoTable({
      ...tableStyle(),
      startY: y,
      head: [["#", "Job / defect reported", "From", "In / out", "Status", "Done by"]],
      body: jobs.map((j, n) => [
        n + 1,
        `${j.description}${j.urgency && j.urgency !== "normal" ? `  [${j.urgency}]` : ""}${j.machine_stopped ? "  [machine stopped]" : ""}`,
        `${ORIGIN[j.origin] || j.origin}${j.raised_by_name ? `\n${j.raised_by_name}` : ""}`,
        j.kind === "outside" ? "Outside" : "Inside",
        j.outside_status ? OUT_STATUS[j.outside_status] || j.outside_status : JOB_STATUS[j.status] || j.status,
        j.done_at ? `${j.done_by_name || ""}\n${day(j.done_at)}` : "",
      ]),
      columnStyles: { 0: { cellWidth: 8, halign: "center" }, 1: { cellWidth: 72 }, 2: { cellWidth: 28 }, 3: { cellWidth: 16 }, 4: { cellWidth: 26 } },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const issues = c.issues || [];
  let partsTotal = 0;
  if (issues.length) {
    y = sectionTitle(k, y, "Parts & materials issued");
    partsTotal = issues.reduce((s, t) => s + Number(t.value || 0), 0);
    doc.autoTable({
      ...tableStyle(),
      startY: y,
      head: [["#", "Part / material", "Issued", "From", "Qty", "Rate", "Amount"]],
      body: issues.map((t, n) => [n + 1, t.item_name, day(t.created_at), t.ref_type === "grv" ? "Bought (GRV)" : "Store stock",
        `${q(t.qty)} ${t.unit || ""}`, rs(t.rate), rs(t.value)]),
      foot: [["", "Parts total", "", "", "", "", rs(partsTotal)]],
      columnStyles: { 0: { cellWidth: 8, halign: "center" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right", cellWidth: 28 } },
    });
    y = doc.lastAutoTable.finalY + 5;
  }
  const waiting = (c.parts || []).filter((p) => ["requested", "on_po"].includes(p.status));
  if (waiting.length) {
    y = sectionTitle(k, y, "Parts still awaited");
    doc.autoTable({
      ...tableStyle(),
      startY: y,
      head: [["#", "Part", "Qty", "Status"]],
      body: waiting.map((p, n) => [n + 1, p.item_name || p.description, q(p.qty), p.status === "on_po" ? `On ${p.po_code || "PO"}` : "With store"]),
      columnStyles: { 0: { cellWidth: 8, halign: "center" } },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const outside = (c.outside || []).filter((o) => !["rejected", "cancelled"].includes(o.status));
  let outsideTotal = 0;
  if (outside.length) {
    y = sectionTitle(k, y, "Outside work");
    outsideTotal = outside.reduce((s, o) => s + Number(o.final_amount || 0), 0);
    doc.autoTable({
      ...tableStyle(),
      startY: y,
      head: [["Ref", "Workshop", "Estimate", "Approved", "Bill", "Status", "Cost to card"]],
      body: outside.map((o) => [o.code, o.workshop || "", rs(o.estimate_amount), rs(o.approved_amount),
        o.bill_no ? `${o.bill_no}\n${rs(o.bill_amount)}` : "—", OUT_STATUS[o.status] || o.status, rs(o.final_amount)]),
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 6: { halign: "right", cellWidth: 28 } },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const charges = c.charges || [];
  let chargeTotal = 0;
  if (charges.length) {
    y = sectionTitle(k, y, "Lubricants & top-ups");
    chargeTotal = charges.reduce((s, x) => s + Number(x.amount || 0), 0);
    doc.autoTable({
      ...tableStyle(),
      startY: y,
      head: [["#", "Item", "Issued", "Qty", "Amount"]],
      body: charges.map((x, n) => [n + 1, x.description, day(x.charged_at), x.qty == null ? "—" : `${q(x.qty)} ${x.unit || ""}`, x.amount == null ? "no rate" : rs(x.amount)]),
      columnStyles: { 0: { cellWidth: 8, halign: "center" }, 3: { halign: "right" }, 4: { halign: "right", cellWidth: 28 } },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  // Cost summary, right-aligned box.
  if (y > PAGE_H - 70) { doc.addPage(); y = 20; }
  const lines = [["Parts & materials", partsTotal], ["Outside work", outsideTotal], ...(charges.length ? [["Lubricants", chargeTotal]] : [])];
  doc.autoTable({
    ...tableStyle(),
    startY: y,
    margin: { left: PAGE_W - MX - 80, right: MX },
    body: [...lines.map(([l, v]) => [l, rs(v)]), ["Total cost to vehicle", rs(c.cost)]],
    columnStyles: { 0: { cellWidth: 48, fontStyle: "bold", textColor: GREY }, 1: { cellWidth: 32, halign: "right" } },
    didParseCell: (d) => {
      if (d.row.index === lines.length) { d.cell.styles.fillColor = LIGHT; d.cell.styles.fontStyle = "bold"; d.cell.styles.textColor = INK; d.cell.styles.fontSize = 10; }
    },
    alternateRowStyles: {},
  });
  y = doc.lastAutoTable.finalY + 6;

  if (c.notes) {
    font("italic", 9); color(GREY);
    const nl = doc.splitTextToSize(c.notes, CW);
    text(nl, MX, y);
    y += nl.length * 4.2 + 3;
  }

  y = sectionTitle(k, y, "Sign-off");
  signatures(k, y, c.general_month
    ? [["Store", "", ""], ["Plant In Charge / Manager", "", ""]]
    : [["Raised by", c.opened_by_name, when(c.opened_at)], ["Mechanic / Plant In Charge", c.work_done_by_name, c.work_done_at ? when(c.work_done_at) : ""],
      ["Verified by (Manager)", c.verified_by_name, c.verified_at ? when(c.verified_at) : ""], ["Driver (vehicle received)", "", ""]]);
  finish(k, `${c.code} · ${c.asset_name}`);
  return doc;
}

export async function printJobCardPdf(c) {
  const doc = await buildJobCardPdf(c);
  openPdf(doc, `${c.code}-${(c.reg_no || c.asset_no || "vehicle").replace(/\W+/g, "")}.pdf`);
}

// Open in a new tab to print; fall back to a download if pop-ups are blocked.
function openPdf(doc, filename) {
  const url = doc.output("bloburl");
  const w = window.open(url, "_blank");
  if (!w) doc.save(filename);
}
