// Round 264 — the printed handover form for a personal asset (A4).
// A mobile phone or SIM card prints the owner's "Mobile Phone & SIM Card —
// Issue and Undertaking" (their own wording, in the app's design, mockup v4
// artboard 10); any other asset prints the same layout with an items table.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");

const PHONE_UNDERTAKING = [
  "The SIM card, mobile phone and accessories remain the sole property of the Company and are used primarily for official business.",
  "I will not transfer, lend, sell, pledge or allow unauthorised use; I will take proper care of them and immediately report any loss, theft, damage or malfunction.",
  "On resignation, termination, transfer, retirement, or whenever directed by the Company, I will return all issued items in good condition.",
];
const DATA_POLICY = [
  "All official communication with customers, suppliers and other business associates is done on the Company SIM card and phone.",
  "Contacts, WhatsApp chats, call records, SMS, emails, documents, photographs and other business information created or received on them are Company property.",
  "Business communications and data are not deleted, altered, transferred or shared without prior approval from the Management.",
  "On resignation, termination, transfer, or when requested, the SIM card, phone and all related business communications, contacts and records are handed over.",
  "Loss, misuse, unauthorised deletion or withholding of Company data or communication records may lead to disciplinary action, recovery of losses and legal proceedings as permitted by law.",
  "Customer and supplier contact details developed, kept or accessed during employment are confidential Company assets and are not copied, retained, shared, transferred or used for personal benefit or any third party without written authorisation.",
  "The employee cooperates in transferring and keeping access to all Company WhatsApp accounts, contacts, chat history, backups and other communication platforms linked to the SIM card or phone.",
];
const GENERAL_UNDERTAKING = [
  "The items above remain the sole property of the Company and are used for official work.",
  "I will take proper care of them, not lend or transfer them, and immediately report any loss, theft, damage or malfunction.",
  "On resignation, termination, transfer, or whenever directed by the Company, I will return all items in good condition. Loss or damage through misuse may be recovered from my salary.",
];

const CSS = `
@page { size: A4; margin: 0; }
body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #22262B; font-size: 11.5px; line-height: 1.45; }
.page { width: 210mm; min-height: 297mm; box-sizing: border-box; border-top: 6px solid #C75B12; padding: 12mm 14mm 10mm; display: flex; flex-direction: column; gap: 11px; }
.head { display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #C8C2B5; padding-bottom: 9px; }
.co { font-size: 17px; font-weight: 700; letter-spacing: .3px; }
.muted { color: #5B6470; }
.box { border: 1px solid #DEDAD1; border-radius: 8px; padding: 9px 12px; }
.cap { font-size: 10px; color: #C75B12; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
.kv { display: grid; grid-template-columns: 95px 1fr; gap: 3px 8px; }
.kv4 { display: grid; grid-template-columns: 95px 1fr 70px 1fr; gap: 3px 8px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
h2 { font-size: 15px; margin: 0; }
h3 { font-size: 12px; margin: 0 0 3px; }
ol { margin: 3px 0 0; padding-left: 18px; }
table { width: 100%; border-collapse: collapse; } th, td { border-bottom: 1px solid #DEDAD1; padding: 5px 6px; text-align: left; font-size: 11px; }
.decl { background: #F3F1EC; border-radius: 8px; padding: 8px 12px; }
.sig { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 4px; }
.sig div.l { border-top: 1px solid #22262B; padding-top: 4px; margin-top: 34px; }
.ret { border: 1px dashed #C8C2B5; border-radius: 8px; padding: 9px 12px; margin-top: auto; }
.ret .g { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 14px; }
@media print { .noprint { display: none; } }
`;

export function printAssetForm(item, all = []) {
  // The person's other phone / SIM items issued with this one go on the same form.
  const mine = all.filter((i) => i.employee_id && i.employee_id === item.employee_id && ["issued", "issue_pending"].includes(i.status));
  const sameIssue = mine.filter((i) => i.issue_id === item.issue_id);
  const group = sameIssue.length ? sameIssue : [item];
  const isPhone = (i) => /mobile phone|phone|tablet/i.test(i.type_name);
  const isSim = (i) => /sim/i.test(i.type_name);
  const phoneForm = group.some((i) => isPhone(i) || isSim(i));
  const phone = group.find(isPhone);
  const sim = group.find(isSim) || (phone && phone.details?.mobile_no ? phone : null);
  const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const emp = `<div class="box"><div class="cap">Employee</div><div class="kv"><span class="muted">Name</span><b>${esc(item.employee_name)}</b><span class="muted">Employee ID</span><span>${esc(item.emp_code)}</span><span class="muted">Designation</span><span>${esc(item.employee_designation || "")}</span><span class="muted">Issue</span><span>${item.mode === "temporary" ? `Temporary · return by ${day(item.return_by)}` : "Permanent"}</span></div></div>`;
  const d = (x, k) => esc(x?.details?.[k] || "");
  const body = phoneForm ? `
    <div><h2>Mobile Phone &amp; SIM Card — Issue and Undertaking</h2><div class="muted">Company property issued to an employee for official work</div></div>
    <div class="grid2">${emp}
      <div class="box"><div class="cap">SIM card</div><div class="kv"><span class="muted">Mobile no.</span><b>${d(sim, "mobile_no")}</b><span class="muted">Provider</span><span>${d(sim, "provider")}</span><span class="muted">SIM (ICCID)</span><span>${d(sim, "iccid") || esc(sim?.serial_no || "")}</span><span class="muted">Plan &amp; limit</span><span>${d(sim, "plan")}</span></div></div>
    </div>
    <div class="box"><div class="cap">Mobile phone ${phone ? `· ${esc(phone.code)}` : "(if issued)"}</div><div class="kv4">
      <span class="muted">Brand &amp; model</span><span>${esc(phone?.make_model || "")}</span><span class="muted">Serial no.</span><span>${esc(phone?.serial_no || "")}</span>
      <span class="muted">IMEI 1</span><span>${d(phone, "imei1")}</span><span class="muted">IMEI 2</span><span>${d(phone, "imei2")}</span>
      <span class="muted">Accessories</span><span>${d(phone, "accessories")}</span><span class="muted">Condition</span><span>${esc(phone?.condition_note || "Good")}</span></div></div>
    <div><h3>Acknowledgement &amp; undertaking</h3><div>I, <b>${esc(item.employee_name)}</b>, acknowledge receipt of the above Company-issued SIM card and/or mobile phone belonging to Our Own Ready Mix, and undertake that:</div>
      <ol>${PHONE_UNDERTAKING.map((t) => `<li>${t}</li>`).join("")}</ol></div>
    <div><h3>Communication &amp; data retention</h3><ol>${DATA_POLICY.map((t) => `<li>${t}</li>`).join("")}</ol></div>`
    : `
    <div><h2>Company Asset — Handover and Undertaking</h2><div class="muted">Company property issued to an employee for official work</div></div>
    ${emp}
    <table><thead><tr><th>Asset no.</th><th>Item</th><th>Make / model</th><th>Serial</th><th>Comes with</th><th>Condition</th></tr></thead><tbody>
      ${group.map((i) => `<tr><td><b>${esc(i.code)}</b></td><td>${esc(i.type_name)}</td><td>${esc(i.make_model || "")}</td><td>${esc(i.serial_no || "")}</td><td>${esc(i.details?.accessories || "")}</td><td>${esc(i.condition_note || "Good")}</td></tr>`).join("")}
    </tbody></table>
    <div><h3>Acknowledgement &amp; undertaking</h3><div>I, <b>${esc(item.employee_name)}</b>, acknowledge receipt of the above items belonging to Our Own Ready Mix, and undertake that:</div>
      <ol>${GENERAL_UNDERTAKING.map((t) => `<li>${t}</li>`).join("")}</ol></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(item.code)} · ${esc(item.employee_name)}</title><style>${CSS}</style></head><body>
  <div class="noprint" style="padding:10px;text-align:center"><button onclick="window.print()">Print</button></div>
  <div class="page">
    <div class="head"><div><div class="co">OUR OWN READY MIX</div><div class="muted" style="font-size:10.5px">Plot No. 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala 671321 · +91 83 4007 4006</div></div>
      <div style="margin-left:auto;text-align:right" class="muted">No. <b style="color:#22262B">${esc(group.map((i) => i.code).join(", "))}</b><br>Date <b style="color:#22262B">${today}</b></div></div>
    ${body}
    <div class="decl"><b>Declaration —</b> I confirm that I have read, understood and accepted the terms above and agree to comply with them.</div>
    <div class="sig"><div><div class="l"><b>Employee</b><br><span class="muted">${esc(item.employee_name)} · date</span></div></div><div><div class="l"><b>Issued by</b><br><span class="muted">name · date</span></div></div><div><div class="l"><b>Approved by</b><br><span class="muted">Administrator · date</span></div></div></div>
    <div class="ret"><div class="cap">Return record</div><div class="g"><span>Date returned: __________</span><span>${phoneForm ? "Phone returned: Yes / No" : "All items returned: Yes / No"}</span><span>${phoneForm ? "SIM returned: Yes / No" : "Accessories: Yes / No"}</span>
      <span>${phoneForm ? "Accessories returned: Yes / No" : ""}</span><span>Condition: Good / Damaged</span><span>Received by: __________</span><span style="grid-column: span 3">Remarks: ____________________________________________</span></div></div>
    <div class="muted" style="font-size:9.5px;text-align:right">Printed from Our Own Smart App · asset record ${esc(group.map((i) => i.code).join(", "))}</div>
  </div></body></html>`;
  const w = window.open("", "_blank");
  if (!w) { alert("Allow pop-ups to print the form."); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
