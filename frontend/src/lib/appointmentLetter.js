// Round 250 — the appointment letter (owner, 30 Oct 2026), printed from the
// employee: the company's format "Appointment Letter Ver3.docx" with its terms
// and conditions word for word, the employee's details and passport photo in
// the "For HR use only" box, on the HR letterhead (logo, gold rule, footer
// strip — the same pieces lib/hrPdf.js uses).
//
// Printed as HTML through the browser (not jsPDF) so it can use the sample's
// font, Aptos, 11 pt. Aptos is a Microsoft font that cannot be shipped with
// the app: a computer that has it (Microsoft 365, or the free download from
// Microsoft) prints in Aptos; any other falls back to Segoe UI / Calibri.
// "Save as PDF" in the print dialog gives the PDF.
export const TEMPLATE_VERSION = "Ver 3";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const TENS = { 30: "thirty", 40: "forty", 45: "forty-five", 60: "sixty", 90: "ninety", 120: "one hundred and twenty", 180: "one hundred and eighty" };
const inWords = (n) => WORDS[n] || TENS[n] || String(n);
const count = (n, unit) => `${inWords(n)} (${n}) ${unit}${n === 1 ? "" : "s"}`;
const poss = (n, unit) => (n === 1 ? `${count(n, unit)}'s` : `${count(n, unit)}'`); // one month's · two months'
const plain = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function longDay(ymd) {
  if (!ymd) return "—";
  return new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function shortDay(ymd) {
  if (!ymd) return "—";
  return new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });
}
const rupees = (v) => (v == null || v === "" ? "" : `₹ ${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

// The letter's whole page (HTML document). `origin` makes the logo and footer
// load inside a print iframe or preview.
export function letterHtml({ letter: l, photo }, origin = window.location.origin) {
  const e = l.emp_snapshot || {};
  const name = esc((e.name || "").toUpperCase());
  const desig = esc((l.designation || "").toUpperCase());
  const joined = esc(longDay(l.joining_date));
  const pm = Number(l.probation_months) || 0;
  const npd = Number(l.notice_probation_days) || 0;
  const nam = Number(l.notice_after_months) || 0;
  const salary = Array.isArray(l.salary) ? l.salary : [];
  const fixedTotal = salary.reduce((t, r) => t + (r.amount == null ? 0 : Number(r.amount)), 0);
  const relation = e.relation_name ? `${esc(e.relation_type || "S/o")} ${esc(e.relation_name)}` : "—";
  const draft = l.status === "draft";
  const cancelled = l.status === "cancelled";

  const box = (label, value, wide) => `<div class="kv${wide ? " wide" : ""}"><span>${label}</span><b>${value || "—"}</b></div>`;
  const salaryRows = salary.map((r, i) => `<tr><td class="c">${i + 1}</td><td>${esc(r.label)}</td><td class="r">${r.amount != null ? esc(rupees(r.amount)) : esc(r.note || "")}</td></tr>`).join("");

  const probation = pm > 0 ? `
  <h2>Probation Period</h2>
  <ol>
    <li>You will be on probation for a period of <b>${count(pm, "month")}</b> from the date of appointment.${npd ? ` In the event of resignation during probation period, you must serve a notice period of <b>${count(npd, "day")}</b> in writing.` : ""} The Company reserves the right to extend the probation period at its sole discretion based on performance, conduct, attendance, and business requirements. Confirmation of employment shall be effective only upon issuance of a written confirmation letter by the Company.</li>
    <li>The management may, in writing, confirm your services, extend the period of probation or terminate the appointment at the expiry of the period of probation, depending on your performance at work. During the probation period, the Company may terminate your employment at any time without assigning any reason and without notice or compensation in lieu of notice, subject to applicable laws.</li>
    <li>Till the time you receive a confirmation letter in writing, it will be construed that you will continue to be on probation without any change on the terms and conditions of employment.</li>
  </ol>` : `
  <h2>Probation Period</h2>
  <ol><li>No probation period applies to this appointment.</li></ol>`;

  const notice = [
    nam > 0
      ? `In the event of your resignation${pm > 0 ? ", after confirmation of services with the Company," : ","} you will be required to give an advance notice of <b>${count(nam, "month")}</b> in writing or will have to pay <b>${poss(nam, "month")}</b> salary in lieu of the notice period.`
      : "",
    pm > 0 && npd > 0 ? `During the probation period, either party may terminate the employment by providing <b>${poss(npd, "day")}</b> written notice or salary in lieu thereof, subject to applicable law.` : "",
  ].filter(Boolean).join(" ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Appointment Letter – ${esc(e.name)} – ${esc(l.ref_no)}</title>
<style>
@font-face { font-family: "OORM Title"; src: url("${origin}/fonts/Poppins-Bold.ttf") format("truetype"); font-weight: 700; }
@page { size: A4; margin: 12mm 16mm 10mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Aptos, "Segoe UI", Calibri, Arial, sans-serif; color: #606060; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body { font-family: Aptos, "Aptos Body", "Segoe UI", Calibri, Carlito, Arial, sans-serif; font-size: 11pt; line-height: 1.35; color: #1c1c1c;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media screen { body { padding: 12mm 14mm; max-width: 210mm; margin: 0 auto; } .foot { position: static !important; margin-top: 10mm; } }
table.page { width: 100%; border-collapse: collapse; }
table.page > tfoot td { height: 17mm; }
.lh { display: flex; align-items: center; gap: 4mm; border-bottom: 0.7mm solid #E2B52B; padding-bottom: 3mm; }
.lh img { width: 20mm; height: 20mm; }
.lh .co { font-family: "OORM Title", Aptos, sans-serif; font-weight: 700; font-size: 15pt; color: #2B4C9B; letter-spacing: .2px; }
.lh .sub { font-size: 8.5pt; color: #606060; }
.lh .title { margin-left: auto; text-align: right; white-space: nowrap; }
.lh h1 { font-family: "OORM Title", Aptos, sans-serif; font-size: 14pt; margin: 0; color: #1c1c1c; letter-spacing: .5px; }
.lh .ref { font-size: 9pt; color: #2B4C9B; font-weight: 700; }
.hr { margin-top: 5mm; border: 0.3mm solid #555; display: flex; gap: 4mm; padding: 3mm; break-inside: avoid; }
.hr .grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 1.4mm 5mm; font-size: 9.5pt; align-content: start; }
.hr .head { grid-column: 1 / -1; font-weight: 700; letter-spacing: 1px; color: #2B4C9B; font-size: 9pt; }
.kv span { color: #555; } .kv span::after { content: ": "; } .kv.wide { grid-column: 1 / -1; }
.photo { width: 35mm; height: 45mm; border: 0.3mm solid #555; flex: none; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #f3f1ec; }
.photo img { width: 100%; height: 100%; object-fit: cover; }
.photo i { font-style: normal; font-size: 8.5pt; color: #606060; text-align: center; }
.refline { display: flex; justify-content: space-between; margin: 5mm 0 4mm; font-size: 10.5pt; }
p { margin: 0 0 2.4mm; text-align: justify; }
h2 { font-size: 11pt; margin: 4mm 0 1.5mm; break-after: avoid; }
ol { margin: 0 0 2mm; padding-left: 7mm; } ol ol { list-style: lower-roman; margin-top: 1mm; }
li { margin: 0 0 1.6mm; text-align: justify; }
.counter { counter-reset: sec; } .counter h2 { counter-increment: sec; } .counter h2::before { content: counter(sec) ". "; }
table.sal { width: 100%; border-collapse: collapse; margin: 1mm 0 3mm; font-size: 10.5pt; break-inside: avoid; }
table.sal th, table.sal td { border: 0.25mm solid #777; padding: 1.2mm 2mm; }
table.sal th { background: #2B4C9B; color: #fff; text-align: left; }
.c { text-align: center; width: 9mm; } .r { text-align: right; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; margin-top: 8mm; break-inside: avoid; font-size: 10.5pt; }
.sign .line { border-top: 0.3mm solid #1c1c1c; margin-top: 16mm; padding-top: 1.5mm; }
.foot { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; }
.foot img { width: 170mm; display: block; margin: 0 auto; }
.foot div { font-size: 7.5pt; color: #606060; margin-top: 1mm; }
.mark { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 60pt; font-weight: 700; color: rgba(176, 35, 29, .12); transform: rotate(-30deg); pointer-events: none; }
</style></head>
<body>
${draft ? `<div class="mark">DRAFT</div>` : cancelled ? `<div class="mark">CANCELLED</div>` : ""}
<div class="foot"><img src="${origin}/quote-footer.png" alt=""><div>Our Own Ready Mix – Appointment Letter (T&amp;C ${esc(l.template_version || TEMPLATE_VERSION)}) · Ref. ${esc(l.ref_no)}</div></div>
<table class="page"><tfoot><tr><td></td></tr></tfoot><tbody><tr><td>

<div class="lh">
  <img src="${origin}/quote-logo.png" alt="Our Own Ready Mix logo">
  <div><div class="co">OUR OWN READY MIX</div><div class="sub">Plot No. 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala 671321</div></div>
  <div class="title"><h1>APPOINTMENT LETTER</h1><div class="ref">${esc(l.ref_no)}</div></div>
</div>

<section class="hr" aria-label="For HR use only">
  <div class="grid">
    <div class="head">FOR HR USE ONLY</div>
    ${box("Employee Name", name, true)}
    ${box("S/o · D/o · W/o", relation, true)}
    ${box("Emp. Code", esc(e.emp_code))}
    ${box("Designation", desig)}
    ${box("Department", esc(l.department))}
    ${box("Joining Date", esc(shortDay(l.joining_date)))}
    ${box("Reporting To", esc(l.reporting_to))}
    ${box("Work Location", esc(l.work_location))}
    ${box("Probation", pm > 0 ? plain(pm, "month") : "None")}
    ${box("Notice Period", esc([pm > 0 && npd ? `${npd} days (probation)` : "", nam ? plain(nam, "month") : ""].filter(Boolean).join(" / ")) || "—")}
    ${box("Address", esc(e.address).replace(/\n/g, ", "), true)}
  </div>
  <div class="photo">${photo ? `<img src="${photo}" alt="Photograph of ${esc(e.name)}">` : `<i>Paste passport<br>size photo<br>35 × 45 mm</i>`}</div>
</section>

<div class="refline"><span><b>Ref. No.:</b> ${esc(l.ref_no)}</span><span><b>Date:</b> ${esc(shortDay(l.issue_date))}</span></div>

<p>Dear <b>${name}</b>,</p>
<p>This Appointment Letter is issued by <b>Our Own Ready Mix</b>, having its registered office at <b><i>Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala</i></b> (hereinafter referred to as the "<b>Company</b>").</p>
<p>For the purposes of this Appointment Letter:</p>
<p>"Company" means Our Own Ready Mix, including its registered office, branches, project sites, customer locations, business units, successors, and assigns.</p>
<p>"Employee" means the individual to whom this Appointment Letter is issued and who accepts employment under the terms and conditions contained herein.</p>
<p>With reference to your application and the subsequent interview, we are pleased to appoint you to the position of <b>${desig}</b> with the Company, subject to your acceptance of the following terms and conditions:</p>

<div class="counter">
  <h2>Appointment</h2>
  <ol>
    <li>Your appointment shall be effective from <b>${joined}</b>. Your normal working hours shall be 8.5 hours per day, including lunch break, and may be scheduled by the Department Head based on operational requirements.</li>
    <li>You will have to abide by all service rules, regulations and policies of the Company in force, or as introduced or amended from time to time.</li>
  </ol>
${probation}

  <h2>Compensation</h2>
  <ol>
    <li>Your monthly Salary Package will be as described below and the same will be credited to your bank account after due deductions (if any) on the 5th of following month.</li>
  </ol>
  <table class="sal">
    <thead><tr><th class="c">#</th><th>Component</th><th class="r">Amount (per month)</th></tr></thead>
    <tbody>${salaryRows}
      ${fixedTotal ? `<tr><td></td><td><b>Gross Monthly (Fixed)</b></td><td class="r"><b>${esc(rupees(fixedTotal))}</b></td></tr>` : ""}
    </tbody>
  </table>
  <ol start="2">
    <li>The Company reserves the right to recover any outstanding dues, advances, loans, damages, losses, shortages, notice pay, or any other amounts payable by the employee from salary, incentives, leave encashment, final settlement, or any other payments due to the employee.</li>
    <li>The Employee authorizes the Company to make such deductions from salary, incentives, reimbursement claims, final settlement dues, or any other payments due, to the extent permitted by applicable law.</li>
    <li>Overtime work, where applicable, shall be performed only with prior authorization and shall be compensated in accordance with Company policy and applicable law.</li>
  </ol>

  <h2>Policy on Employee Leave</h2>
  <ol>
    <li>You are eligible to apply for leave as entitled by the prevailing HR guidelines of the company.</li>
    <li>During probation, leave may be granted only with prior approval of management and subject to business requirements. Unauthorized absence shall be treated as Loss of Pay.</li>
    <li>Leave entitlement shall be governed by the Company's Leave Policy as amended from time to time and applicable statutory requirements.</li>
    <li>Unused Casual Leave and Sick Leave may be carried forward to the subsequent year subject to Company policy.</li>
    <li>You should apply for Casual leave at least two days in advance in the prescribed format. You cannot apply for more than two casual leaves at a stretch.</li>
    <li>Leave during the notice period shall not normally be permitted except with the prior written approval of Management.</li>
    <li>Unauthorized absenteeism is a disciplinary issue and on observing such behaviour, disciplinary process will be initiated. Continuous unauthorized absence for three consecutive working days may lead to disciplinary action, including termination, after giving the employee an opportunity to explain.</li>
  </ol>

  <h2>Confidentiality</h2>
  <ol>
    <li>The Company expects you to maintain confidentiality of all official matters and urge you not to divulge or communicate any confidential matters to anyone who is not the intended recipient of such information.</li>
    <li>While dealing with money, material or documents of the company, your complete honesty, sincerity and professional ethics is always expected. The obligation of confidentiality shall survive the termination or cessation of employment and shall remain binding indefinitely.</li>
    <li>The details of your salary, benefits, and any other components of your compensation package are strictly confidential and must not be disclosed to any other employee of the Company, or to any third party, unless specifically required by law or authorized in writing by the Company.</li>
  </ol>

  <h2>Conflict of Interest, Outside Employment and Business Activities</h2>
  <ol>
    <li>You are required to engage yourself exclusively in the work assigned by the Company and shall not take up any independent or individual assignments (whether the same is part or full time, in an advisory capacity or otherwise) directly or indirectly without the express written consent of the management.</li>
    <li>You shall ensure that you do not, directly or indirectly, engage in any activity, hold any interest in, or perform any services for any person or organization whose activities conflict, or are likely to conflict, with the interests of the Company.</li>
    <li>In case of any breach or default by you of the obligations mentioned, the Company may initiate disciplinary action, including termination of employment where warranted.</li>
  </ol>

  <h2>Protection of Business Interests</h2>
  <ol>
    <li>The Employee acknowledges that during the course of employment, he/she may have access to confidential information, customer information, pricing data, mix designs, supplier details, business strategies, operational procedures, and other proprietary information of the Company.</li>
    <li>The Employee agrees that during employment and for a period of twelve (12) months following separation from the Company, he/she shall not directly or indirectly:
      <ol>
        <li>Solicit, divert, canvass, or attempt to solicit any customer, prospective customer, supplier, vendor, or business associate of the Company.</li>
        <li>Induce or attempt to induce any employee, contractor, consultant, or business associate to terminate or reduce their relationship with the Company.</li>
        <li>Use, disclose, copy, transmit, or exploit any confidential information, trade secrets, pricing information, customer information, mix designs, quality records, operational data, or business opportunities belonging to the Company for personal benefit or for the benefit of any third party.</li>
      </ol>
    </li>
    <li>Nothing contained herein shall prevent the Employee from pursuing lawful employment after separation; however, the obligations relating to confidentiality and protection of the Company's business interests shall remain binding.</li>
    <li>The Employee acknowledges that customer relationships, project information, pricing structures, supplier relationships, mix designs, quality procedures, and market intelligence developed within the Company's operating area constitute valuable business interests of the Company.</li>
  </ol>

  <h2>Mobile Phone and Communication Policy</h2>
  <ol>
    <li>Use of personal mobile phones during working hours, while operating equipment, or while driving Company vehicles is prohibited except with prior authorization.</li>
    <li>All official communication with customers, suppliers, employees, and other stakeholders shall be conducted through Company-approved communication channels, including Company-issued SIM cards, email accounts, and software platforms. Use of personal email addresses or personal messaging accounts for official Company communication is prohibited unless specifically authorized by management.</li>
  </ol>

  <h2>Quality Control and Operational Compliance</h2>
  <ol>
    <li>The Employee shall comply with all quality control procedures, testing requirements, batching instructions, and customer specifications. Deliberate falsification of records, test reports, batch tickets, production data, or quality documents shall constitute gross misconduct and may result in termination and legal action.</li>
  </ol>

  <h2>Company Property and Asset Management</h2>
  <ol>
    <li><b>Company Assets</b> – The Employee acknowledges that all Company property issued, assigned, or entrusted to him/her during the course of employment, including but not limited to identity cards, uniforms, PPE, tools, equipment, laptops, mobile phones, SIM cards, keys, vehicles, fuel cards, documents, records, software, and electronic data, shall remain the exclusive property of the Company.</li>
    <li><b>Care and Custody</b> – The Employee shall exercise reasonable care in the use, handling, storage, and protection of Company property and shall use such property only for authorized business purposes.</li>
    <li><b>Loss, Damage, or Theft</b> – Any loss, damage, theft, misuse, or unauthorized use of Company property shall be reported immediately to the reporting supervisor or management. Recovery of losses, where attributable to negligence, misconduct, or unauthorized use, may be made as permitted by applicable law.</li>
    <li><b>Inspection Rights</b> – The Company reserves the right, where reasonably required for safety, security, operational, or investigative purposes, to inspect Company property, lockers, vehicles, workstations, electronic devices, bags brought onto Company premises, and other areas under the Employee's control, in accordance with applicable law and Company policy.</li>
    <li><b>Return of Property</b> – Upon resignation, termination, transfer, suspension, retirement, or upon demand by the Company, the Employee shall immediately return all Company property in his/her possession or control.</li>
    <li><b>Full and Final Settlement</b> – The Company reserves the right to withhold processing of the Full and Final Settlement until completion of clearance formalities, return of Company property, and settlement of outstanding dues, subject to applicable law.</li>
  </ol>

  <h2>Notice Period and Resignation</h2>
  <ol>
    ${notice ? `<li>${notice}</li>` : ""}
    ${nam > 0 ? `<li>Failure to serve the stipulated notice period will require the employee to compensate the Company with <b>${poss(nam, "month")}</b> salary in lieu of notice${pm > 0 ? " after probation" : ""}.</li>` : ""}
    <li>If an employee has taken any leave or has leave balances during the resignation period, they are required to work to compensate for the leave days taken before the last working day.</li>
  </ol>

  <h2>Verification of Information</h2>
  <ol>
    <li>This appointment is subject to satisfactory verification of educational qualifications, experience certificates, identity documents, address proof, references, and any other information furnished by the employee. Any discrepancy or misrepresentation may result in immediate termination.</li>
    <li>Any misrepresentation, suppression of facts, submission of forged documents, or furnishing of false information at any stage before or after appointment shall render this employment liable for immediate termination without notice, and the Company reserves the right to initiate legal proceedings where applicable.</li>
  </ol>

  <h2>Transfer and Deployment</h2>
  <p>The Employee may be transferred, deputed, or assigned to any department, location, branch, project site, customer premises, business unit, or other place of operation of the Company as may be deemed necessary by Management.</p>

  <h2>Misconduct and Disciplinary Action</h2>
  <p>Acts of misconduct including but not limited to theft, fraud, misappropriation, insubordination, harassment, violence, intoxication during duty, falsification of records, unauthorized disclosure of Company information, damage to Company property, or violation of Company policies may result in disciplinary action up to and including termination of employment.</p>

  <h2>Medical Fitness</h2>
  <p>The Company may require the Employee to undergo medical examinations at any time during employment. Continued employment may be subject to satisfactory medical fitness for the assigned duties.</p>

  <h2>Incident and Accident Reporting</h2>
  <p>Any accident, injury, property damage, vehicle incident, quality issue, customer complaint, or safety violation shall be reported immediately to the reporting supervisor.</p>

  <h2>Common HSE, PPE &amp; Safety Compliance Clause</h2>
  <ol>
    <li>The Employee shall comply with all Health, Safety and Environment (HSE) policies, procedures, safety instructions, and operational guidelines issued by the Company from time to time.</li>
    <li>While deployed at customer premises, the Employee shall comply with all customer safety rules, access controls, PPE requirements, and site regulations. Any violation may result in disciplinary action.</li>
    <li>The Employee shall:
      <ol>
        <li>Wear and properly use all prescribed Personal Protective Equipment (PPE) including safety helmet, safety shoes, reflective jacket, gloves, goggles, ear protection, safety harness, and any other safety equipment as required for the assigned work.</li>
        <li>Participate in all safety trainings, toolbox talks, mock drills, medical examinations, and safety awareness programs organized by the Company.</li>
        <li>Immediately report any unsafe condition, unsafe act, accident, injury, near miss incident, equipment defect, environmental hazard, or property damage to the reporting supervisor.</li>
        <li>Not operate any machinery, equipment, vehicle, batching plant, pump, mixer, or other equipment without proper authorization or training.</li>
        <li>Comply with all traffic regulations, site safety requirements, customer site rules, and Company operational procedures while performing duties.</li>
        <li>Refrain from working under the influence of alcohol, narcotic drugs, intoxicants, or any substance that may impair judgment or performance.</li>
      </ol>
    </li>
    <li>Violation of safety procedures, refusal to use PPE, reckless conduct, unauthorized operation of equipment, or any act endangering life, property, or the environment shall constitute serious misconduct and may result in disciplinary action including suspension or termination of employment.</li>
    <li>PPE issued to employees shall remain Company property. Loss, damage due to negligence, or failure to return issued PPE may result in recovery of replacement cost as permitted by law.</li>
  </ol>

  <h2>General Declarations and Warranties</h2>
  <ol>
    <li>We trust that you have not provided us with any false declaration or wilfully suppressed any material information. If you have, you will be liable for removal from service without notice.</li>
    <li>You warrant that you are not prevented by a court or by any other administrative or judicial order from providing the services required under this agreement.</li>
    <li>The Employee acknowledges having received access to the Company Policies and procedures, which shall form an integral part of the terms and conditions of employment.</li>
    <li>Any dispute arising out of this employment shall be subject to the exclusive jurisdiction of the courts at Kasaragod, Kerala.</li>
  </ol>
</div>

<p style="margin-top:4mm">The Employee acknowledges receipt of the above Annexures and agrees to comply with their requirements.</p>
<p>If you are agreeable to the above, please indicate your acceptance by signing a copy of this letter and return to us. Wish you all the best and a rewarding career with Our Own Ready Mix.</p>

<div class="sign">
  <div><b>For Our Own Ready Mix</b>
    <div class="line">Authorized Signatory</div>
    <div>Name: ${esc(l.signatory_name) || "&nbsp;"}</div>
    <div>Designation: ${esc(l.signatory_designation) || "&nbsp;"}</div>
  </div>
  <div><b>Accepted by the Employee</b>
    <div class="line">Employee Signature &amp; Date</div>
    <div>Name: ${name}</div>
    <div>Emp. Code: ${esc(e.emp_code)}</div>
  </div>
</div>

</td></tr></tbody></table>
</body></html>`;
}

// Print through a hidden frame once the logo, footer, photo and fonts are in.
export async function printAppointmentLetter(data) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(letterHtml(data)); doc.close();
  const imgs = [...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
  await Promise.race([Promise.all(imgs), new Promise((r) => setTimeout(r, 6000))]);
  try { await doc.fonts?.ready; } catch { /* fonts are a nicety */ }
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60_000);
}
