// Round 269 — the weighment slip for a ticket weighed in the app (mockup
// artboard 4, without photos). A4 through the browser's print dialog
// ("Save as PDF" for a file), the same way as the credit note print.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kg = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
const when = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "") : "—");

export const PURPOSE_LABEL = { raw_in: "Raw material in", rmc_out: "RMC out", internal: "Internal / transfer", outside: "Outside party" };

export function slipHtml(t, origin = window.location.origin) {
  const firstIsGross = t.first_kg >= (t.second_kg ?? 0);
  const grossAt = firstIsGross ? t.first_at : t.second_at;
  const tareAt = firstIsGross ? t.second_at : t.first_at;
  const v = t.variance;
  const rows = [
    ["Vehicle", `<b>${esc(t.vehicle_text)}</b>${t.truck_number ? ` (${esc(t.truck_number)})` : ""}`, "Purpose", esc(PURPOSE_LABEL[t.purpose] || t.purpose)],
  ];
  if (t.purpose === "raw_in" || t.material_name) rows.push(["Material", esc(t.material_name || t.material_text || "—"), "Supplier", esc(t.supplier_name || "—")]);
  if (t.purpose === "rmc_out") rows.push(["Delivery ticket", esc(t.dt_number || "—"), "Customer", esc(t.dt_customer || "—")]);
  if (t.purpose === "outside") rows.push(["Party", esc(t.party_name || "—"), "Charge", t.charge_amount != null ? `₹${esc(Number(t.charge_amount).toLocaleString("en-IN"))} ${esc(t.charge_mode || "")}` : "—"]);
  if (t.challan_no || t.challan_qty) rows.push(["Supplier challan", `${esc(t.challan_no || "—")}${t.challan_qty ? ` · ${esc(t.challan_qty)} ${esc(t.purchase_unit || "")}` : ""}`, "Purchase order", t.rm_order_id ? `PO-${String(t.rm_order_id).padStart(4, "0")}` : "—"]);
  rows.push(["Driver", esc(t.driver_name || "—"), "Weighed by", esc([t.first_by_name, t.second_by_name].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(" / ") || "—")]);
  const tr = rows.map((r) => `<tr><td class="k">${r[0]}</td><td>${r[1]}</td><td class="k">${r[2]}</td><td>${r[3]}</td></tr>`).join("");
  const varLine = v ? `<p>Against the challan (${kg(v.billed_kg)} kg): <b style="color:${v.short ? "#B03A2E" : "#1D7A55"}">${v.diff_kg > 0 ? "+" : ""}${kg(v.diff_kg)} kg (${v.pct > 0 ? "+" : ""}${v.pct}%)${v.short ? " — short" : ""}</b></p>` : "";
  const stamp = t.status === "closed" ? "" : `<div class="stamp">${t.status === "open" ? "OPEN — NOT COMPLETE" : "CANCELLED"}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(t.ticket_no)}</title>
<style>
@page{size:A4;margin:0}
*{box-sizing:border-box}html,body{margin:0;background:#fff}
@media screen{body{background:#e9e6df;padding:16px}.pg{margin:0 auto;box-shadow:0 2px 10px rgba(0,0,0,.15)}}
.pg{position:relative;width:210mm;min-height:297mm;padding:0 15mm 12mm;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#22262B;font-size:11pt;background:#fff;display:flex;flex-direction:column;gap:14px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{height:6px;background:#C75B12;margin:0 -15mm}
.head{display:flex;justify-content:space-between;align-items:flex-start;padding-top:10mm}
.head h1{margin:0;font-size:18pt}.mut{color:#5B6470;font-size:9.5pt;line-height:1.5}
.title{display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid #22262B;border-bottom:1px solid #DEDAD1;padding:8px 0}
.title b{font-size:15pt;letter-spacing:.5px}
table{width:100%;border-collapse:collapse}
.info td{padding:5px 0;vertical-align:top}.info td.k{color:#5B6470;width:22%}
.w{border:1.5px solid #22262B;font-size:12pt}.w th{background:#22262B;color:#fff;padding:8px 10px;text-align:left}
.w td{padding:9px 10px;border-bottom:1px solid #DEDAD1}.w td.r,.w th.r{text-align:right}
.w tr.net td{background:#F3F1EC;font-weight:800;font-size:16pt;border-bottom:0}
.sig{margin-top:auto;display:flex;justify-content:space-between;font-size:10pt;padding-top:30mm}
.sig div{width:40%;border-top:1px solid #22262B;padding-top:6px}
.stamp{position:absolute;top:120mm;left:0;right:0;text-align:center;font-size:40pt;font-weight:800;color:rgba(176,58,46,.18);transform:rotate(-18deg)}
</style></head><body><div class="pg">
<div class="bar"></div>
<div class="head"><div><h1>OUR OWN READY MIX</h1>
<div class="mut">Plot No. 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala 671321<br>+91 83 4007 4006 · mail@ourownrm.com</div></div>
<img src="${origin}/quote-logo.png" alt="" style="width:64px;height:64px;object-fit:contain"></div>
<div class="title"><b>WEIGHMENT SLIP</b><span>No. <b style="font-size:12pt">${esc(t.ticket_no)}</b> · ${esc(when(t.second_at || t.first_at).slice(0, 11))}</span></div>
<table class="info">${tr}</table>
<table class="w"><thead><tr><th>Weighing</th><th>Date &amp; time</th><th class="r">Weight (kg)</th></tr></thead><tbody>
<tr><td>Gross (loaded)</td><td>${when(t.status === "closed" ? grossAt : t.first_at)}</td><td class="r">${kg(t.status === "closed" ? t.gross_kg : t.first_kg)}</td></tr>
<tr><td>Tare (empty)</td><td>${t.status === "closed" ? when(tareAt) : "—"}</td><td class="r">${t.status === "closed" ? kg(t.tare_kg) : "—"}</td></tr>
<tr class="net"><td>NET</td><td></td><td class="r">${t.status === "closed" ? kg(t.net_kg) : "—"}</td></tr>
</tbody></table>
${varLine}
<div class="mut">Weights read directly from the weighbridge indicator — not typed.${t.remarks ? ` Remarks: ${esc(t.remarks)}` : ""}${t.status === "cancelled" ? ` Cancelled: ${esc(t.cancel_reason || "")}` : ""}</div>
<div class="sig"><div>Driver's signature</div><div style="text-align:right">For Our Own Ready Mix</div></div>
${stamp}
</div></body></html>`;
}

export async function printSlip(t) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(slipHtml(t)); doc.close();
  const imgs = [...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
  await Promise.race([Promise.all(imgs), new Promise((r) => setTimeout(r, 4000))]);
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60_000);
}
