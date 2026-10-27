// Round 221 — HR printouts (owner, 21 Oct 2026):
//   * payslip, one employee per page (one or all), with bank details;
//   * the monthly payroll statement (A4 landscape) with each employee's bank;
//   * the employee details sheet, with the photo.
// Same letterhead, fonts and colours as the job card / purchase order, so ₹
// prints. Loaded only when a printout is asked for (dynamic import).
import { jsPDF } from "jspdf";
import { rupeesInWords } from "./purchaseOrderPdf.js";

const BLUE = [43, 76, 155];
const GOLD = [226, 181, 43];
const INK = [28, 28, 28];
const GREY = [96, 96, 96];
const LIGHT = [243, 241, 236];
const IST = "Asia/Kolkata";

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

async function newDoc(orientation = "portrait") {
  const autoTableMod = await import("jspdf-autotable");
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation });
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
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const MX = 14;
  const k = {
    doc, logo, footer, W, H, MX, CW: W - MX * 2,
    font: (style = "normal", size = 9.5, fam = "Body") => { doc.setFont(fam, style); doc.setFontSize(size); },
    color: (c) => doc.setTextColor(...c),
    text: (s, x, y, o) => doc.text(String(s ?? ""), x, y, o),
  };
  return k;
}

const rs2 = (v) => (v == null || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const rs0 = (v) => (v == null || v === "" ? "—" : `₹${Math.round(Number(v)).toLocaleString("en-IN")}`);
export function day(ts) {
  if (!ts) return "—";
  const s = String(ts);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+05:30`) : new Date(ts);
  return d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" });
}
const monthName = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
};
const MODES = { bank_transfer: "Bank transfer", cash: "Cash", upi: "UPI", cheque: "Cheque" };

function tableStyle(k, extra = {}) {
  return {
    margin: { left: k.MX, right: k.MX, bottom: 24 },
    styles: { font: "Body", fontSize: 9, cellPadding: 1.6, textColor: INK, lineColor: [205, 200, 190], lineWidth: 0.15, overflow: "linebreak" },
    headStyles: { font: "Body", fontStyle: "bold", fillColor: BLUE, textColor: 255, fontSize: 9 },
    footStyles: { font: "Body", fontStyle: "bold", fillColor: LIGHT, textColor: INK },
    alternateRowStyles: { fillColor: [250, 249, 246] },
    theme: "grid",
    ...extra,
  };
}

function header(k, title, sub, right2) {
  const { doc, logo, font, color, text, W, MX } = k;
  if (logo) doc.addImage(logo, "PNG", MX, 7, 20, 20);
  font("bold", 13, "Title"); color(BLUE);
  text("OUR OWN READY MIX", MX + (logo ? 24 : 0), 14);
  font("normal", 9); color(GREY);
  text(sub, MX + (logo ? 24 : 0), 19);
  font("bold", 14, "Title"); color(INK);
  text(title, W - MX, 14, { align: "right" });
  if (right2) { font("bold", 11); color(BLUE); text(right2, W - MX, 20, { align: "right" }); }
  doc.setDrawColor(...GOLD); doc.setLineWidth(0.7);
  doc.line(MX, 29, W - MX, 29);
  color(INK);
  return 33;
}

function infoGrid(k, y, pairs, cols = 3, width = k.CW) {
  const rows = [];
  for (let i = 0; i < pairs.length; i += cols) rows.push(pairs.slice(i, i + cols));
  const body = rows.map((r) => r.flatMap(([l, v]) => [l, v ?? "—"]).concat(Array((cols - r.length) * 2).fill("")));
  const lw = 27, vw = width / cols - lw;
  k.doc.autoTable({
    ...tableStyle(k),
    startY: y,
    body,
    tableWidth: width,
    styles: { font: "Body", fontSize: 9, cellPadding: 1.4, textColor: INK, lineColor: [205, 200, 190], lineWidth: 0.15 },
    columnStyles: Object.fromEntries(Array.from({ length: cols * 2 }, (_, i) => [i, i % 2 === 0
      ? { cellWidth: lw, fontStyle: "bold", fillColor: LIGHT, textColor: GREY, fontSize: 8.5 } : { cellWidth: vw }])),
    alternateRowStyles: {},
  });
  return k.doc.lastAutoTable.finalY + 4;
}

function section(k, y, label) {
  const { font, color, text, doc, H, MX } = k;
  if (y > H - 45) { doc.addPage(); y = 18; }
  font("bold", 10.5); color(BLUE);
  text(label, MX, y + 3);
  color(INK);
  return y + 5;
}

function signatures(k, y, boxes) {
  const { doc, font, color, text, H, MX, CW } = k;
  if (y > H - 50) { doc.addPage(); y = 20; }
  const w = (CW - (boxes.length - 1) * 4) / boxes.length;
  boxes.forEach((label, i) => {
    const x = MX + i * (w + 4);
    doc.setDrawColor(190, 185, 175); doc.setLineWidth(0.2);
    doc.rect(x, y, w, 20);
    font("bold", 8.5); color(GREY); text(label, x + 2, y + 4.5);
    doc.line(x + 2, y + 17, x + w - 2, y + 17);
  });
  return y + 24;
}

function finish(k, label) {
  const { doc, footer, font, color, text, W, H, MX, CW } = k;
  const pages = doc.getNumberOfPages();
  const stamp = new Date().toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (footer) {
      const fw = Math.min(CW, 182), fh = fw * 72 / 1153;
      doc.addImage(footer, "PNG", (W - fw) / 2, H - 8 - fh, fw, fh);
    }
    font("normal", 7.5); color(GREY);
    text(`${label} · printed ${stamp} from the OORM app`, MX, H - 4);
    text(`Page ${p} of ${pages}`, W - MX, H - 4, { align: "right" });
  }
}

function open(doc, filename) {
  const url = doc.output("bloburl");
  const w = window.open(url, "_blank");
  if (!w) doc.save(filename);
}

// ------------------------------------------------------------------ payslip --
function earningsRows(c) {
  const rows = [];
  if (c.contract) rows.push([`Wages (${c.paid_days} days × ${rs2(c.daily_rate)})`, c.earned?.wages ?? c.earned_gross]);
  else {
    // The stored figures come back in the database's key order — print them in pay-slip order.
    const ORDER = ["basic", "da", "hra", "conveyance", "special"];
    const LABEL = { basic: "Basic", da: "DA", hra: "HRA", conveyance: "Conveyance", special: "Special allowance" };
    const keys = Object.keys(c.earned || {}).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
    for (const k2 of keys) if (Number(c.earned[k2])) rows.push([LABEL[k2] || k2[0].toUpperCase() + k2.slice(1), c.earned[k2]]);
  }
  if (Number(c.ot_amount)) rows.push([`Overtime (${c.ot_hours} h)`, c.ot_amount]);
  if (Number(c.trip_allowance)) rows.push([`Trip allowance (${c.trip_count} trips)`, c.trip_allowance]);
  if (Number(c.incentive)) rows.push(["Sales incentive", c.incentive]);
  if (Number(c.other_earning)) rows.push(["Other earning", c.other_earning]);
  return rows;
}
function deductionRows(c) {
  const rows = [["Provident Fund (PF)", c.pf], ["ESI", c.esi], ["Professional tax", c.pt],
    ["Salary advance recovered", c.advance], ["Other deduction", c.other_deduction]];
  return rows.filter((r) => Number(r[1]));
}

function payslipPage(k, line, month) {
  const { doc, font, color, text, MX, CW, W } = k;
  const c = line.calc;
  let y = header(k, "PAYSLIP", "Salary / wages statement", monthName(month));
  const b = line.bank;
  y = infoGrid(k, y, [
    ["Employee", line.name], ["Code", line.emp_code], ["Designation", line.designation || "—"],
    ["Department", line.department || "—"], ["Joined", line.date_of_joining ? day(line.date_of_joining) : "—"],
    ["Type", c.contract ? `Contract${line.contractor_name ? ` — ${line.contractor_name}` : ""}` : "Payroll"],
    ...(b ? [["PAN", b.pan || "—"], ["Bank", b.bank_name || "—"], ["IFSC", b.ifsc || "—"],
      ["Account no.", b.account_no || "—"], ["Account name", b.account_name || line.name]] : []),
  ], 3);
  y = infoGrid(k, y, [
    ["Days in month", String(c.days_in_month)], ["Paid days", String(c.paid_days)], ["Loss of pay", String(c.lop_days || 0)],
    ["Present", `${c.present}${c.half ? ` + ${c.half} half` : ""}`], ["Leave", `${c.leave_paid || 0} paid · ${c.leave_unpaid || 0} unpaid`],
    ["Weekly off / hol.", `${c.off} / ${c.holiday}`],
  ], 3);
  const earn = earningsRows(c), ded = deductionRows(c);
  const n = Math.max(earn.length, ded.length);
  const body = Array.from({ length: n }, (_, i) => [earn[i]?.[0] || "", earn[i] ? rs2(earn[i][1]) : "", ded[i]?.[0] || "", ded[i] ? rs2(ded[i][1]) : ""]);
  doc.autoTable({
    ...tableStyle(k),
    startY: y,
    head: [["Earnings", "Amount", "Deductions", "Amount"]],
    body,
    foot: [["Total earnings", rs2(c.total_earnings), "Total deductions", rs2(c.total_deductions)]],
    columnStyles: { 0: { cellWidth: CW * 0.32 }, 1: { cellWidth: CW * 0.18, halign: "right" }, 2: { cellWidth: CW * 0.32 }, 3: { cellWidth: CW * 0.18, halign: "right" } },
    didParseCell: (h) => { if ((h.column.index === 1 || h.column.index === 3) && h.section !== "body") h.cell.styles.halign = "right"; },
  });
  y = doc.lastAutoTable.finalY + 5;
  doc.setFillColor(...LIGHT); doc.setDrawColor(...BLUE); doc.setLineWidth(0.4);
  doc.rect(MX, y, CW, 16, "FD");
  font("bold", 11); color(BLUE); text("NET PAY", MX + 3, y + 6.5);
  font("bold", 14, "Title"); color(INK); text(rs2(line.net_pay), W - MX - 3, y + 7.5, { align: "right" });
  font("italic", 9); color(GREY); text(rupeesInWords(Math.max(0, Number(line.net_pay))), MX + 3, y + 12.5);
  y += 21;
  if (line.paid_amount != null) {
    font("normal", 9.5); color(INK);
    text(`Paid ${rs2(line.paid_amount)} on ${day(line.paid_on)} by ${MODES[line.paid_mode] || line.paid_mode || "—"}${line.paid_ref ? ` · ref. ${line.paid_ref}` : ""}${b?.account_no && line.paid_mode === "bank_transfer" ? ` to A/c ${b.account_no}` : ""}.`, MX, y);
    y += 6;
  } else {
    font("normal", 9.5); color(GREY); text("Payment not recorded yet.", MX, y); y += 6;
  }
  if (c.incentive_note) { font("normal", 8.5); color(GREY); text(`Incentive: ${c.incentive_note}`, MX, y, { maxWidth: CW }); y += 6; }
  if (line.remarks) { font("normal", 8.5); color(GREY); text(`Remarks: ${line.remarks}`, MX, y, { maxWidth: CW }); y += 6; }
  font("normal", 8); color(GREY);
  text("Employer's contribution (not deducted from pay): " +
    `PF ${rs2(c.pf_employer)} · ESI ${rs2(c.esi_employer)}${Number(c.bonus_provision) ? ` · bonus provision ${rs2(c.bonus_provision)}` : ""}`, MX, y + 2);
  y += 8;
  signatures(k, y, ["Prepared by (Accounts)", "Approved by", "Received by (employee)"]);
}

export async function printPayslips(lines, month) {
  const k = await newDoc();
  lines.forEach((l, i) => { if (i) k.doc.addPage(); payslipPage(k, l, month); });
  finish(k, `Payslip ${monthName(month)}`);
  const name = lines.length === 1 ? `Payslip_${month}_${lines[0].emp_code}.pdf` : `Payslips_${month}.pdf`;
  open(k.doc, name);
}

// ------------------------------------------------- payroll statement -----
export async function printPayrollStatement(data, month) {
  const k = await newDoc("landscape");
  const { doc, MX, CW } = k;
  let y = header(k, "PAYROLL STATEMENT", "Monthly salary & wages", monthName(month));
  const bank = !!data.bank_details;
  const locked = data.run?.status === "locked";
  const head = ["#", "Code", "Employee", "Paid days", "Earnings", "Deductions", "Advance", "Net pay",
    ...(bank ? ["Bank", "Account no.", "IFSC"] : []), "Paid on · mode · ref."];
  let te = 0, td = 0, ta = 0, tn = 0, tp = 0;
  const body = data.lines.map((l, i) => {
    const c = l.calc;
    te += c.total_earnings; td += c.total_deductions - c.advance; ta += c.advance; tn += Number(l.net_pay); tp += Number(l.paid_amount || 0);
    return [i + 1, l.emp_code, `${l.name}${c.contract ? " (contract)" : ""}${l.designation ? `\n${l.designation}` : ""}`, c.paid_days,
      rs0(c.total_earnings), rs0(c.total_deductions - c.advance), c.advance ? rs0(c.advance) : "—", rs0(l.net_pay),
      ...(bank ? [l.bank?.bank_name || "—", l.bank?.account_no || "—", l.bank?.ifsc || "—"] : []),
      l.paid_amount != null ? `${day(l.paid_on)}\n${MODES[l.paid_mode] || ""}${l.paid_ref ? ` · ${l.paid_ref}` : ""}${Number(l.paid_amount) !== Number(l.net_pay) ? `\n(${rs0(l.paid_amount)})` : ""}` : "unpaid"];
  });
  const right = { halign: "right" };
  const colStyles = bank
    ? { 0: { cellWidth: 8 }, 1: { cellWidth: 15 }, 2: { cellWidth: 40 }, 3: { cellWidth: 13, ...right }, 4: { cellWidth: 21, ...right }, 5: { cellWidth: 20, ...right },
        6: { cellWidth: 17, ...right }, 7: { cellWidth: 21, ...right }, 8: { cellWidth: 26 }, 9: { cellWidth: 29 }, 10: { cellWidth: 23 } }
    : { 0: { cellWidth: 8 }, 1: { cellWidth: 18 }, 2: { cellWidth: 70 }, 3: { cellWidth: 16, ...right }, 4: { cellWidth: 28, ...right }, 5: { cellWidth: 28, ...right },
        6: { cellWidth: 24, ...right }, 7: { cellWidth: 28, ...right } };
  doc.autoTable({
    ...tableStyle(k, { styles: { font: "Body", fontSize: 8.5, cellPadding: 1.3, textColor: INK, lineColor: [205, 200, 190], lineWidth: 0.15, overflow: "linebreak" } }),
    startY: y,
    head: [head],
    body,
    foot: [["", "", `Total · ${data.lines.length} employees`, "", rs0(te), rs0(td), rs0(ta), rs0(tn), ...(bank ? ["", "", ""] : []), `paid ${rs0(tp)}`]],
    columnStyles: colStyles,
    didParseCell: (h) => { if (h.section !== "body" && [3, 4, 5, 6, 7].includes(h.column.index)) h.cell.styles.halign = "right"; },
  });
  y = doc.lastAutoTable.finalY + 5;
  k.font("normal", 8.5); k.color(GREY);
  k.text(`${locked ? "Locked payroll" : "Draft — not locked; figures may change"}. Net pay = earnings − deductions − advance recovered.${bank ? "" : " Bank details are shown only to those allowed to see them (Access Control → HR → Bank details on the payroll statement)."}`, MX, y, { maxWidth: CW });
  signatures(k, y + 6, ["Prepared by (Accounts)", "Checked by (Plant Manager)", "Approved by (Administrator)"]);
  finish(k, `Payroll statement ${monthName(month)}`);
  open(doc, `Payroll_statement_${month}.pdf`);
}

// ------------------------------------------------------ employee details --
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export async function printEmployee(e, { photo, canSalary, canIds } = {}) {
  const k = await newDoc();
  const { doc, MX, CW, W } = k;
  let y = header(k, "EMPLOYEE DETAILS", "Human resources", e.emp_code);
  const photoW = 32, photoH = 40;
  const gridW = photo ? CW - photoW - 4 : CW;
  if (photo) {
    try {
      const fmt = photo.startsWith("data:image/png") ? "PNG" : photo.startsWith("data:image/webp") ? "WEBP" : "JPEG";
      doc.setDrawColor(190, 185, 175); doc.setLineWidth(0.3);
      doc.addImage(photo, fmt, W - MX - photoW, y, photoW, photoH);
      doc.rect(W - MX - photoW, y, photoW, photoH);
    } catch { /* an unreadable image simply does not print */ }
  }
  const top = y;
  y = infoGrid(k, y, [
    ["Name", e.name], ["Code", e.emp_code],
    ["Designation", e.designation || "—"], ["Department", e.department || "—"],
    ["Type", e.employment_type === "contract" ? "Contract" : "Payroll"], ["Contractor", e.employment_type === "contract" ? e.contractor_name || "—" : "—"],
    ["Mobile", e.mobile || "—"], ["Status", e.is_active ? "Active" : "Left"],
    ["Joined", e.date_of_joining ? day(e.date_of_joining) : "—"], ["Left", e.date_of_leaving ? day(e.date_of_leaving) : "—"],
  ], 2, gridW);
  if (photo) y = Math.max(y, top + photoH + 4);
  y = section(k, y, "Attendance & timing");
  y = infoGrid(k, y, [
    ["Attendance", e.attendance_source === "machine" ? `Machine${e.machine_user_id ? ` #${e.machine_user_id}` : ""}` : e.attendance_source === "app" ? "App" : "Not tracked"],
    ["App login", e.app_user_name || "—"],
    ["Phone attendance", e.app_punch === "plant" ? "At the plant" : e.app_punch === "anywhere" ? "Anywhere" : "Off"],
    ["Timing", e.policy === "office" ? "Office" : "Operations"], ["Shift", e.default_shift_name || "—"],
    ["Weekly off", e.weekly_off == null ? "—" : WEEKDAY[e.weekly_off]],
    ["Trip allowance", e.trip_allowance ? "Yes" : "No"], ["Overtime", e.ot_eligible ? "Paid" : canSalary ? "Not paid" : "—"],
  ], 3);
  if (canSalary) {
    y = section(k, y, "Pay");
    if (e.employment_type === "contract") {
      y = infoGrid(k, y, [
        ["Basis", e.contract_basis === "monthly" ? "Monthly rate" : "Daily rate"],
        ["Rate", e.contract_basis === "monthly" ? `${rs2(e.monthly_rate)} / month` : `${rs2(e.daily_rate)} / day`],
        ["Service charge", e.service_charge_pct ? `${e.service_charge_pct}%` : "—"],
      ], 3);
    } else {
      const gross = ["salary_basic", "salary_da", "salary_hra", "salary_conveyance", "salary_special"].reduce((t, f) => t + Number(e[f] || 0), 0);
      y = infoGrid(k, y, [
        ["Basic", rs2(e.salary_basic)], ["DA", rs2(e.salary_da)], ["HRA", rs2(e.salary_hra)],
        ["Conveyance", rs2(e.salary_conveyance)], ["Special", rs2(e.salary_special)], ["Gross / month", rs2(gross)],
        ["PF", e.pf_applicable ? "Applicable" : "No"], ["ESI", e.esi_applicable ? "Applicable" : "No"],
        ["Incentive", e.incentive_basis && e.incentive_basis !== "none"
          ? `${rs2(e.incentive_rate)}/m³${e.incentive_min_m3 ? ` above ${e.incentive_min_m3} m³` : ""}` : "None"],
      ], 3);
    }
  }
  if (canIds) {
    y = section(k, y, "Identity & bank");
    y = infoGrid(k, y, [
      ["Aadhaar", e.aadhaar_no ? e.aadhaar_no.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3") : "—"], ["PAN", e.pan_no || "—"],
      ["Driving licence", e.dl_no || "—"], ["Licence valid till", e.dl_valid_till ? day(e.dl_valid_till) : "—"],
      ["Account name", e.bank_account_name || "—"], ["Bank", e.bank_name || "—"],
      ["Account no.", e.bank_account_no || "—"], ["IFSC", e.bank_ifsc || "—"],
    ], 2);
  }
  if (e.notes) {
    y = section(k, y, "Notes");
    k.font("normal", 9.5); k.color(INK);
    const lines = doc.splitTextToSize(e.notes, CW);
    k.text(lines, MX, y + 3);
    y += 4 + lines.length * 4.5;
  }
  signatures(k, y + 4, ["Employee", "Plant Manager", "Administrator"]);
  finish(k, `Employee ${e.emp_code}`);
  open(doc, `Employee_${e.emp_code}.pdf`);
}

// ------------------------------------------- advances of a month (Round 245) --
// Owner, 27 Oct 2026: "an option to print advance requests of the month (all
// the requests for the month) and advances paid". A4 landscape:
//   1. every salary-advance request raised that month or recovered from that
//      month's salary — each line: employee, asked, approved, status, paid;
//   2. pump-gang advance requests, the same way (when there are any);
//   3. advances paid — the hr_advances recovered from that month's salary
//      (and those given in the month for a later one).
const STATUS = { pending: "Waiting for approval", approved: "Approved — to pay", rejected: "Rejected", cancelled: "Withdrawn", paid: "Paid", part_paid: "Part paid" };
// Round 246 — `part`: "requests" (requests + pump gang requests),
// "paid" (advances paid) or "all" (both, as before).
export async function printAdvancesMonth({ requests = [], gangs = [], paid = [], month, part = "all" }) {
  const k = await newDoc("landscape");
  const { doc, MX, CW } = k;
  const wantReq = part !== "paid", wantPaid = part !== "requests";
  const title = part === "requests" ? "ADVANCE REQUESTS" : part === "paid" ? "ADVANCES PAID" : "SALARY ADVANCES";
  let y = header(k, title, part === "requests" ? "Salary advance requests of the month" : part === "paid" ? "Salary advances paid" : "Requests and advances paid", monthName(month));
  let n = 0;
  const num = () => (part === "all" ? `${++n} · ` : "");
  const right = { halign: "right" };
  const style = tableStyle(k, { styles: { font: "Body", fontSize: 8.5, cellPadding: 1.3, textColor: INK, lineColor: [205, 200, 190], lineWidth: 0.15, overflow: "linebreak" } });

  // 1. requests
  if (wantReq) {
  y = section(k, y, `${num()}Advance requests — ${requests.length} request${requests.length === 1 ? "" : "s"}`);
  let ta = 0, tap = 0, tpd = 0, nLines = 0;
  const body = [];
  for (const r of requests) {
    for (const l of r.lines) {
      nLines++;
      ta += Number(l.amount) || 0;
      if (["approved", "paid"].includes(l.status)) tap += Number(l.approved_amount ?? l.amount) || 0;
      if (l.paid) tpd += Number(l.paid.amount) || 0;
      body.push([
        `#${r.id}`, `${day(r.raised_at)}\n${r.raised_by_name || ""}`, `${l.employee_name}\n${l.emp_code || ""}`,
        rs0(l.amount), l.approved_amount != null ? rs0(l.approved_amount) : "—", l.recover_month,
        STATUS[l.status] || l.status,
        r.decided_by_name ? `${r.decided_by_name}\n${day(r.decided_at)}` : "—",
        l.paid ? `${rs0(l.paid.amount)} · ${day(l.paid.given_on)}\n${MODES[l.paid.mode] || l.paid.mode || ""}${l.paid.reference ? ` · ${l.paid.reference}` : ""}` : "—",
        r.purpose || "",
      ]);
    }
  }
  if (body.length) {
    doc.autoTable({
      ...style, startY: y,
      head: [["Req.", "Raised · by", "Employee", "Asked", "Approved", "Recover from", "Status", "Decided by", "Paid · date · mode", "Purpose"]],
      body,
      foot: [["", "", `${nLines} line${nLines === 1 ? "" : "s"}`, rs0(ta), rs0(tap), "", "", "", `paid ${rs0(tpd)}`, ""]],
      columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 26 }, 2: { cellWidth: 40 }, 3: { cellWidth: 20, ...right }, 4: { cellWidth: 20, ...right },
        5: { cellWidth: 18 }, 6: { cellWidth: 28 }, 7: { cellWidth: 28 }, 8: { cellWidth: 38 }, 9: { cellWidth: "auto" } },
      didParseCell: (h) => { if (h.section !== "body" && [3, 4].includes(h.column.index)) h.cell.styles.halign = "right"; },
    });
    y = doc.lastAutoTable.finalY + 6;
  } else {
    k.font("normal", 9); k.color(GREY); k.text("No advance requests for this month.", MX, y + 3); k.color(INK); y += 8;
  }

  // 2. pump gang requests
  if (gangs.length) {
    y = section(k, y, `${num()}Pump gang advances — ${gangs.length}`);
    doc.autoTable({
      ...style, startY: y,
      head: [["Raised · by", "Gang", "Contractor", "Asked", "Approved", "Against bill of", "Status", "Paid · date · mode", "Purpose"]],
      body: gangs.map((a) => [`${day(a.raised_at)}\n${a.raised_by_name || ""}`, `${a.gang_name}${a.location ? `\n${a.location}` : ""}`, a.contractor_name,
        rs0(a.amount), a.approved_amount != null ? rs0(a.approved_amount) : "—", a.recover_month, STATUS[a.status] || a.status,
        a.paid ? `${rs0(a.paid.amount)} · ${day(a.paid.paid_on)}\n${MODES[a.paid.mode] || a.paid.mode || ""}${a.paid.ref ? ` · ${a.paid.ref}` : ""}` : "—", a.purpose || ""]),
      foot: [["", `${gangs.length}`, "", rs0(gangs.reduce((t, a) => t + (Number(a.amount) || 0), 0)), rs0(gangs.reduce((t, a) => t + (Number(a.approved_amount) || 0), 0)), "", "",
        `paid ${rs0(gangs.reduce((t, a) => t + (Number(a.paid?.amount) || 0), 0))}`, ""]],
      columnStyles: { 0: { cellWidth: 26 }, 1: { cellWidth: 36 }, 2: { cellWidth: 36 }, 3: { cellWidth: 20, ...right }, 4: { cellWidth: 20, ...right }, 5: { cellWidth: 20 },
        6: { cellWidth: 28 }, 7: { cellWidth: 40 }, 8: { cellWidth: "auto" } },
      didParseCell: (h) => { if (h.section !== "body" && [3, 4].includes(h.column.index)) h.cell.styles.halign = "right"; },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  }
  // 3. advances paid
  if (wantPaid) {
  const rec = paid.filter((a) => a.recover_month === month);
  y = section(k, y, `${num()}Advances paid — ${paid.length} (recovered from ${monthName(month)} salary: ${rs0(rec.reduce((t, a) => t + Number(a.amount), 0))})`);
  if (paid.length) {
    doc.autoTable({
      ...style, startY: y,
      head: [["#", "Given on", "Employee", "Amount", "Paid by · reference", "Recover from", "Note", "Entered by"]],
      body: paid.map((a, i) => [i + 1, day(a.given_on), `${a.employee_name}\n${a.emp_code || ""}`, rs0(a.amount),
        `${MODES[a.mode] || a.mode || ""}${a.reference ? ` · ${a.reference}` : ""}`, `${a.recover_month}${a.recover_month !== month ? " (other month)" : ""}`, a.note || "", a.created_by_name || ""]),
      foot: [["", "", `${paid.length}`, rs0(paid.reduce((t, a) => t + Number(a.amount), 0)), "", "", "", ""]],
      columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 24 }, 2: { cellWidth: 52 }, 3: { cellWidth: 24, ...right }, 4: { cellWidth: 44 }, 5: { cellWidth: 30 }, 6: { cellWidth: "auto" }, 7: { cellWidth: 30 } },
      didParseCell: (h) => { if (h.section !== "body" && h.column.index === 3) h.cell.styles.halign = "right"; },
    });
    y = doc.lastAutoTable.finalY + 6;
  } else {
    k.font("normal", 9); k.color(GREY); k.text("No advances paid for this month.", MX, y + 3); k.color(INK); y += 8;
  }
  k.font("normal", 8.5); k.color(GREY);
  k.text("Advances paid are deducted from the salary of the month shown under “Recover from”.", MX, y, { maxWidth: CW });
  }
  signatures(k, y + (wantPaid ? 5 : 0), ["Prepared by (Accounts)", "Checked by (Plant Manager)", "Approved by (Administrator)"]);
  const label = part === "requests" ? "Advance requests" : part === "paid" ? "Advances paid" : "Salary advances";
  finish(k, `${label} ${monthName(month)}`);
  open(doc, `${part === "requests" ? "Advance_requests" : part === "paid" ? "Advances_paid" : "Advances"}_${month}.pdf`);
}
