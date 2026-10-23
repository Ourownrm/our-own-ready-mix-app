// Round 236 — Cost → GST payable (owner, 23 Oct 2026; mock-up "GST payable —
// Monthly"). GST on sales less the input credit that can be claimed = the
// cash to pay with GSTR-3B. A working sheet for the CA, not a filing. Rules:
// backend lib/gstBook.js.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { readGstr2b } from "../../lib/gstr2b.js";
import {
  useCostData, Loading, MonthSelect, Actions, BTN, Tile, Note, downloadExcel, Modal,
  rsL, rs, num, fmtDay, H2, SUB, MUTED, R, NUM, GRID, ROW, panel, monthName, addMonths,
} from "./costUi.jsx";

const tot = (x) => (x ? (x.igst || 0) + (x.cgst || 0) + (x.sgst || 0) : 0);
const STATUS = {
  in2b: { label: "In 2B", bg: "var(--signal-green-bg)", fg: "#155C40" },
  held: { label: "Held — not in 2B", bg: "#FFF1D6", fg: "#5C3D00" },
  no2b: { label: "2B not uploaded", bg: "#ECEAE4", fg: "#3F4750" },
  rcm: { label: "Reverse charge", bg: "#E2EAF6", fg: "#1F4A82" },
  none: { label: "No credit", bg: "#ECEAE4", fg: "#3F4750" },
};
function Pill({ s }) {
  const x = STATUS[s] || STATUS.none;
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: x.bg, color: x.fg, whiteSpace: "nowrap" }}>{x.label}</span>;
}
const SRC_LABEL = { receipt: "Raw material receipt", mnt_bill: "Maintenance bill", contractor_bill: "Contractor bill" };

export default function CostGstTab({ month, setMonth }) {
  const { can } = usePermissions();
  const canEdit = can("cost.gst", "edit");
  const { data: d, error, reload } = useCostData(`/cost/gst?month=${month}`);
  const [tab, setTab] = useState("source");
  const [modal, setModal] = useState(null);   // 2b | settings | challan
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>GST payable — {d && d.month === month ? d.label : monthName(month)}</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4, maxWidth: 760 }}>
          GST on sales (output) less the GST paid on purchases you can claim (input tax credit) = cash to pay with GSTR-3B{d && d.month === month ? ` by ${fmtDay(d.due_on)}` : ""} · a working sheet for your CA, not a filing
        </div>
      </div>
      <Actions>
        <MonthSelect value={month} onChange={setMonth} />
        {canEdit && <button type="button" style={BTN} onClick={() => setModal("settings")} disabled={!d}>Start month</button>}
        <button type="button" style={BTN} disabled={!d || d.month !== month} onClick={() => exportCa(d)}>Export for CA (Excel)</button>
        {canEdit && <button type="button" className="btn-primary" style={BTN} onClick={() => setModal("2b")}>Upload GSTR-2B (Excel)</button>}
      </Actions>
    </div>
  );
  if (!d || d.month !== month) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;

  const out = d.output;
  const outTax = tot(out);
  const cashTot = tot(d.cash);
  const paidTot = tot(d.paid);
  const still = Math.max(0, Math.round((cashTot - paidTot) * 100) / 100);
  const inter = out.igst > 0 || d.cash.igst > 0 || d.credit_new.igst > 0;
  async function act(fn, ok) {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); if (ok) setMsg(ok); reload(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const flag = (p) => act(() => apiRequest("/cost/gst/flag", { method: "POST", body: { src: p.src, id: p.id, no_tax: !p.no_tax } }));
  const ignore = (l) => act(() => apiRequest(`/cost/gst/2b-lines/${l.id}/ignore`, { method: "POST", body: { ignored: !l.ignored } }));

  const TABS = [
    ["source", "By source"], ["supplier", "By supplier (GSTIN)"], ["held", `Not in GSTR-2B · ${d.held.length}`],
    ["purchases", `Purchases · flag · ${d.purchases.length}`], ["notinapp", `In 2B, not in the app · ${d.not_in_app.filter((x) => !x.ignored).length}`],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {msg && <Note tone="good">{msg}</Note>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      {!d.has_2b && (
        <Note>GSTR-2B for {d.label} is not uploaded yet, so every purchase with GST is counted as claimable — an estimate. Download it from the GST portal (after the 14th of next month) and upload it here; then only the invoices your suppliers have filed are claimed, the rest are held and carried forward.</Note>
      )}
      {!d.settings.from_set && (
        <Note>The working starts from {monthName(d.settings.from_month)} (the first month with invoices), with no credit brought in. {canEdit ? "Set the start month and any credit already in your GST ledger under “Start month”." : ""}</Note>
      )}

      <div style={GRID(190)}>
        <Tile label="Output GST · sales" value={rsL(outTax)} note={`on ${rsL(out.taxable)} taxable · 18% · ${num(out.invoices)} invoices`} />
        <Tile label="Input credit · claim now" value={rsL(d.input.claim)} note={`of ${rsL(d.input.total)} GST paid on this month's purchases${tot(d.carried_in) ? ` · ${rsL(tot(d.carried_in))} brought in` : ""}`} />
        <Tile label="Held · not in GSTR-2B" value={rsL(d.input.held)} note={d.input.held_count ? `${num(d.input.held_count)} bills from ${num(d.input.held_parties)} parties` : "nothing held"} />
        <Tile label="Reverse charge · cash" value={rsL(tot(d.rcm))} note="GTA freight 5% — paid in cash, and claimed back" />
        <Tile dark label="Cash to pay · GSTR-3B" value={rsL(cashTot)}
          note={`${inter ? `IGST ${rs(d.cash.igst)} + ` : ""}CGST ${rs(d.cash.cgst)} + SGST ${rs(d.cash.sgst)} · due ${fmtDay(d.due_on)}`} />
      </div>

      <div style={{ ...ROW, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 460px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={panel("0 0 auto")}>
            <h2 style={H2}>1 · Output GST — on your sales</h2>
            <div style={SUB}>From the tax invoices (one per delivery note); rates include GST, so the tax is 18/118 of each invoice. Invoices with GST switched off by the Accountant are listed apart — no tax is shown on them.</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>From</th><th style={R}>Taxable ₹</th><th style={R}>GST ₹</th></tr></thead>
                <tbody>
                  <tr><td style={{ whiteSpace: "normal" }}>Tax invoices — concrete<div style={MUTED}>{num(out.invoices)} invoices · GST on</div></td>
                    <td style={R}>{num(out.concrete_taxable)}</td><td style={R}>{num(out.concrete_taxable * 0.18)}</td></tr>
                  {out.other_taxable > 0 && <tr><td style={{ whiteSpace: "normal" }}>Pump, part-load &amp; waiting charges<div style={MUTED}>on the same invoices</div></td>
                    <td style={R}>{num(out.other_taxable)}</td><td style={R}>{num(out.other_taxable * 0.18)}</td></tr>}
                  {out.off.n > 0 && <tr><td style={{ whiteSpace: "normal" }}>Invoices with GST switched off<div style={MUTED}>{num(out.off.n)} invoices · {rsL(out.off.amount)} — no tax shown on them; ask your CA</div></td><td style={R}>—</td><td style={R}>—</td></tr>}
                  {out.rejections > 0 && <tr><td style={{ whiteSpace: "normal" }} colSpan={3}><span style={MUTED}>{num(out.rejections)} invoice(s) with part of the load returned — already billed on the accepted m³, so no credit note is taken off here.</span></td></tr>}
                </tbody>
                <tfoot><tr><td>Output GST{inter ? ` · IGST ${num(out.igst)}` : ""} · CGST {num(out.cgst)} · SGST {num(out.sgst)}</td><td style={R}>{num(out.taxable)}</td><td style={R}>{num(outTax)}</td></tr></tfoot>
              </table>
            </div>
            <div style={{ ...MUTED, marginTop: 8 }}>{out.inter ? `${num(out.inter)} invoice(s) to customers registered in another state are IGST 18%.` : "All sales are within the state (or to customers without a GSTIN), so CGST + SGST at 9% each. A sale to another state's GSTIN is IGST 18%, in its own column."}</div>
          </div>

          <div style={panel("0 0 auto")}>
            <h2 style={H2}>3 · What to pay</h2>
            <div style={SUB}>Credit is used against the tax first (IGST credit before CGST and SGST credit); the rest is paid in cash.</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th />{inter && <th style={R}>IGST ₹</th>}<th style={R}>CGST ₹</th><th style={R}>SGST ₹</th></tr></thead>
                <tbody>
                  <SetRow label="Output GST" v={out} inter={inter} bold />
                  <SetRow label={`Credit brought in${d.prev ? ` from ${monthName(d.prev.ym, false)}` : " (opening)"}`} v={d.carried_in} inter={inter} neg />
                  <SetRow label="Credit claimed this month" v={d.credit_new} inter={inter} neg />
                  <SetRow label="Tax after credit" v={d.setoff.cash} inter={inter} bold />
                  {tot(d.rcm) > 0 && <SetRow label="Add: reverse charge (cash only)" v={d.rcm} inter={inter} />}
                </tbody>
                <tfoot>
                  <SetRow label={`Cash to pay by ${fmtDay(d.due_on)}`} v={d.cash} inter={inter} bold foot />
                </tfoot>
              </table>
            </div>
            {tot(d.carried_out) > 0 && <div style={{ ...MUTED, marginTop: 6 }}>Credit left over, carried to {monthName(addMonths(d.month, 1), false)}: {rs(tot(d.carried_out))}{inter ? ` (IGST ${rs(d.carried_out.igst)})` : ""} · CGST {rs(d.carried_out.cgst)} · SGST {rs(d.carried_out.sgst)}.</div>}
            {d.input.held > 0 && <Note>{rs(d.input.held)} of credit is held because those suppliers have not filed yet (not in GSTR-2B). It is claimed in the month they do — the page carries it forward.</Note>}
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <b style={{ fontSize: 13 }}>Challans paid for {d.label}</b>
                {canEdit && <button type="button" style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }} onClick={() => setModal("challan")}>Record a challan</button>}
              </div>
              {d.challans.map((c) => (
                <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
                  <span>{fmtDay(c.paid_on)}{c.cpin ? ` · CPIN ${c.cpin}` : ""}<span style={{ display: "block", ...MUTED }}>{[c.igst ? `IGST ${rs(c.igst)}` : null, `CGST ${rs(c.cgst)}`, `SGST ${rs(c.sgst)}`, c.interest ? `interest ${rs(c.interest)}` : null, c.late_fee ? `late fee ${rs(c.late_fee)}` : null].filter(Boolean).join(" · ")}{c.by_name ? ` · ${c.by_name}` : ""}</span></span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}><b style={NUM}>{rs(tot(c) + c.interest + c.late_fee)}</b>
                    {canEdit && <button type="button" disabled={busy} style={{ fontSize: 11.5, padding: "2px 8px", minHeight: 28 }} onClick={() => window.confirm("Remove this challan?") && act(() => apiRequest(`/cost/gst/challans/${c.id}`, { method: "DELETE" }))}>Remove</button>}</span>
                </div>
              ))}
              {!d.challans.length && <div style={{ ...MUTED, padding: "6px 0" }}>None recorded. After paying, record the challan (CPIN, date, amounts) — the Balance Sheet then shows what is still due.</div>}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 13 }}><span>Still to pay</span><b style={{ ...NUM, color: still > 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{rs(still)}</b></div>
            </div>
          </div>
        </div>

        <div style={panel("2 1 620px")}>
          <h2 style={H2}>2 · Input tax credit — the GST you paid and can claim</h2>
          <div style={SUB}>Every purchase the app records with its GST — matched against GSTR-2B (your suppliers' filed invoices, from the GST portal). Only credit that is in 2B is claimed this month{d.has_2b ? "" : " (2B not uploaded: all of it, as an estimate)"}.</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {TABS.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}
                style={{ padding: "6px 12px", minHeight: 34, fontSize: 12.5, borderRadius: 999, border: `1px solid ${tab === k ? "var(--charcoal)" : "var(--border-strong)"}`,
                  background: tab === k ? "var(--charcoal)" : "var(--surface)", color: tab === k ? "#fff" : "var(--charcoal)" }}>{label}</button>
            ))}
          </div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            {tab === "source" && <BySource d={d} />}
            {tab === "supplier" && <BySupplier d={d} />}
            {tab === "held" && <Items list={d.held} empty="Nothing held — every bill with GST is in GSTR-2B (or 2B is not uploaded)." showMonth />}
            {tab === "purchases" && <Purchases d={d} canEdit={canEdit} busy={busy} onFlag={flag} />}
            {tab === "notinapp" && <NotInApp d={d} canEdit={canEdit} busy={busy} onIgnore={ignore} />}
          </div>
          {tab === "source" && <NoCredit d={d} />}
          {d.suppliers_without_gstin > 0 && <div style={{ ...MUTED, marginTop: 10 }}>{num(d.suppliers_without_gstin)} active supplier(s) have no GSTIN — add it on the supplier so their bills match GSTR-2B line by line.</div>}
        </div>
      </div>

      <div style={{ ...MUTED, lineHeight: 1.6 }}>
        How it works — output GST is 18/118 of each invoice with GST on (IGST for a customer GSTIN from another state). Input credit: raw material receipts at the order's GST %, freight at the transporter's GST % (none → reverse charge 5%), maintenance GRVs at the PO's GST %, outside repairs 18% inside the bill, contractor bills' GST, bank-statement costs at the GST % on the line, and C Ledger expenses flagged with GST. Every purchase starts without the flag (= it has tax); the Accountant flags a bill that came without tax, here under “Purchases”, and it gives no credit. GSTR-2B is matched by GSTIN + invoice number, then invoice number + tax, then the same tax within 20 days. Credit left over carries to the next month.
      </div>

      {modal === "2b" && <Upload2B month={month} onClose={() => setModal(null)} onDone={(m) => { setModal(null); setMsg(m); reload(); }} uploads={d.uploads_2b} />}
      {modal === "settings" && <SettingsModal d={d} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === "challan" && <ChallanModal d={d} still={d.cash} paid={d.paid} onClose={() => setModal(null)} onDone={() => { setModal(null); setMsg("Challan recorded."); reload(); }} />}
    </div>
  );
}

function SetRow({ label, v, inter, bold, neg, foot }) {
  const f = (x) => (neg && x ? `−${num(x)}` : num(x));
  const st = { ...R, fontWeight: bold ? 700 : 400 };
  return (
    <tr style={foot ? { background: "var(--charcoal)", color: "#fff" } : undefined}>
      <td style={{ fontWeight: bold ? 700 : 400, whiteSpace: "normal" }}>{label}</td>
      {inter && <td style={st}>{f(v.igst)}</td>}<td style={st}>{f(v.cgst)}</td><td style={st}>{f(v.sgst)}</td>
    </tr>
  );
}

function BySource({ d }) {
  const g = d.input.groups;
  const sum = (k) => g.reduce((t, x) => t + x[k], 0);
  if (!g.length) return <div style={{ ...MUTED, padding: "8px 0" }}>No purchases with GST in {d.label}.</div>;
  return (
    <table style={{ minWidth: 720 }}>
      <thead><tr><th>Where it comes from in the app</th><th style={R}>GST rate</th><th style={R}>Taxable ₹</th><th style={R}>GST paid ₹</th><th style={R}>In GSTR-2B ₹</th><th style={R}>Held ₹</th><th style={R}>Claim now ₹</th></tr></thead>
      <tbody>
        {g.map((x) => (
          <tr key={x.group} style={{ background: x.held > 0 ? "#FFFBEF" : undefined }}>
            <td style={{ whiteSpace: "normal" }}>{x.group}<div style={MUTED}>{num(x.n)} bill(s){x.earlier ? ` · ${rs(x.earlier)} from earlier months now in 2B` : ""}</div></td>
            <td style={R}>{x.rates.map((r) => `${num(r, 2).replace(/\.00$/, "")}%`).join(", ")}</td>
            <td style={R}>{num(x.taxable)}</td><td style={R}>{num(x.gst)}</td>
            <td style={R}>{x.src === "rcm" ? "self-invoice" : d.has_2b ? num(x.in2b) : "—"}</td>
            <td style={R}>{num(x.held)}</td><td style={{ ...R, fontWeight: 600 }}>{num(x.claim)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><td>Input tax credit</td><td /><td style={R}>{num(sum("taxable"))}</td><td style={R}>{num(sum("gst"))}</td><td style={R}>{d.has_2b ? num(sum("in2b")) : "—"}</td><td style={R}>{num(sum("held"))}</td><td style={R}>{num(sum("claim"))}</td></tr></tfoot>
    </table>
  );
}

function NoCredit({ d }) {
  const n = d.not_counted;
  const rows = [
    n.fuel.amount > 0 && [`Diesel & store purchases ${rsL(n.fuel.amount)}`, "outside GST, no tax charged, so no credit"],
    n.flagged.n > 0 && [`Purchases flagged by the Accountant ${rsL(n.flagged.amount)}`, `${num(n.flagged.n)} bill(s): no tax on the bill, no credit`],
    ...n.reasons.map((r) => [`${r.reason[0].toUpperCase()}${r.reason.slice(1)} ${rsL(r.amount)}`, `${num(r.n)} bill(s) / line(s) — no credit`]),
  ].filter(Boolean);
  if (!rows.length && !d.two_b?.lines) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <b style={{ fontSize: 13 }}>No credit — not counted</b>
      {rows.map(([a, b]) => <div key={a} style={{ fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>{a} <span style={MUTED}>— {b}</span></div>)}
      {d.two_b?.no_itc > 0 && <div style={{ fontSize: 12.5, padding: "4px 0" }}>GSTR-2B lines marked “ITC not available” {rs(d.two_b.no_itc)} <span style={MUTED}>— not claimed</span></div>}
      {d.two_b?.notes ? <div style={{ fontSize: 12.5, padding: "4px 0" }}>Credit / debit notes in GSTR-2B (net) {rs(d.two_b.notes)} <span style={MUTED}>— reduce the credit; check with your CA</span></div> : null}
      <div style={{ ...MUTED, marginTop: 4 }}>Staff food, motor-car costs and similar are blocked by law (Sec 17(5)) — leave them without GST % on the bank line.</div>
    </div>
  );
}

function BySupplier({ d }) {
  if (!d.by_supplier.length) return <div style={{ ...MUTED, padding: "8px 0" }}>No purchases with GST in {d.label}.</div>;
  return (
    <table style={{ minWidth: 620 }}>
      <thead><tr><th>Supplier</th><th>GSTIN</th><th style={R}>Bills</th><th style={R}>GST paid ₹</th><th style={R}>In GSTR-2B ₹</th><th style={R}>Held ₹</th></tr></thead>
      <tbody>
        {d.by_supplier.map((s) => (
          <tr key={`${s.gstin}-${s.party}`} style={{ background: s.held > 0 ? "#FFFBEF" : undefined }}>
            <td style={{ whiteSpace: "normal" }}>{s.party}</td><td style={{ fontSize: 12, ...NUM }}>{s.gstin || <span style={{ color: "var(--alert-red)" }}>none</span>}</td>
            <td style={R}>{num(s.n)}</td><td style={R}>{num(s.gst)}</td><td style={R}>{d.has_2b ? num(s.in2b) : "—"}</td><td style={R}>{num(s.held)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Items({ list, empty, showMonth }) {
  if (!list.length) return <div style={{ ...MUTED, padding: "8px 0" }}>{empty}</div>;
  return (
    <table style={{ minWidth: 760 }}>
      <thead><tr><th>Date</th><th>Party</th><th>Their bill</th><th>From</th><th style={R}>Taxable ₹</th><th style={R}>GST ₹</th><th>Status</th></tr></thead>
      <tbody>
        {list.map((i) => (
          <tr key={i.key}>
            <td style={{ whiteSpace: "nowrap", ...NUM }}>{fmtDay(i.day)}</td>
            <td style={{ whiteSpace: "normal", maxWidth: 220 }}>{i.party}{i.gstin ? <div style={MUTED}>{i.gstin}</div> : null}</td>
            <td style={{ fontSize: 12 }}>{i.inv_no || "—"}</td>
            <td style={{ fontSize: 12, whiteSpace: "normal", maxWidth: 200 }}>{i.group}</td>
            <td style={R}>{num(i.taxable)}</td><td style={R}>{num(i.gst)}</td>
            <td><Pill s={i.status} />{showMonth && i.claim_ym ? <div style={MUTED}>claimed {monthName(i.claim_ym, false)}</div> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Purchases({ d, canEdit, busy, onFlag }) {
  return (
    <div>
      <div style={{ ...MUTED, marginBottom: 8, maxWidth: 760 }}>Each purchase carries a small flag. No flag (the default) — the bill has tax: its tax is input credit here. Flagged — no tax on this bill: no credit. The Accountant flags the bills that came without tax. Nothing on the entry screens shows it.</div>
      {!d.purchases.length ? <div style={{ ...MUTED, padding: "8px 0" }}>No raw material receipts, maintenance bills or contractor bills in {d.label}.</div> : (
        <table style={{ minWidth: 820 }}>
          <thead><tr><th>Flag</th><th>Date</th><th>Purchase</th><th>Party</th><th>Their bill</th><th style={R}>Amount ₹</th><th style={R}>GST ₹</th><th>Status</th></tr></thead>
          <tbody>
            {d.purchases.map((p) => (
              <tr key={p.key} style={{ background: p.no_tax ? "#FAF9F6" : undefined }}>
                <td>{canEdit ? (
                  <button type="button" disabled={busy} onClick={() => onFlag(p)} aria-pressed={p.no_tax}
                    title={p.no_tax ? "Flagged: no tax on this bill — click to take the flag off" : "Flag: this bill came without tax"}
                    style={{ fontSize: 12, padding: "3px 10px", minHeight: 30, borderRadius: 999, background: p.no_tax ? "var(--charcoal)" : "var(--surface)", color: p.no_tax ? "#fff" : "var(--charcoal)" }}>
                    {p.no_tax ? "⚑ Flagged" : "⚐ Flag"}</button>
                ) : p.no_tax ? "⚑" : ""}</td>
                <td style={{ whiteSpace: "nowrap", ...NUM }}>{fmtDay(p.day)}</td>
                <td style={{ fontSize: 12, whiteSpace: "normal", maxWidth: 200 }}>{SRC_LABEL[p.src]}<div style={MUTED}>{p.group.replace(/^Raw material — /, "")}</div></td>
                <td style={{ whiteSpace: "normal", maxWidth: 200 }}>{p.party}</td>
                <td style={{ fontSize: 12 }}>{p.inv_no || "—"}</td>
                <td style={R}>{num(p.taxable + p.gst)}</td><td style={R}>{p.no_tax ? "—" : num(p.gst)}</td>
                <td>{p.no_tax ? <span style={MUTED}>no tax</span> : <Pill s={p.status} />}{p.short ? <div style={MUTED}>2B shows {rs(p.match?.tax)}</div> : null}</td>

              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NotInApp({ d, canEdit, busy, onIgnore }) {
  if (!d.has_2b) return <div style={{ ...MUTED, padding: "8px 0" }}>Upload GSTR-2B for {d.label} to see invoices your suppliers filed that the app does not have.</div>;
  if (!d.not_in_app.length) return <div style={{ ...MUTED, padding: "8px 0" }}>Every invoice in GSTR-2B is matched to a purchase in the app.</div>;
  return (
    <div>
      <div style={{ ...MUTED, marginBottom: 8 }}>Filed by a supplier against your GSTIN, but no purchase in the app matches. Enter the purchase where it belongs (receipt, GRV, bank line …) — or set it aside if it is not yours to claim.</div>
      <table style={{ minWidth: 680 }}>
        <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th style={R}>Taxable ₹</th><th style={R}>GST ₹</th><th /></tr></thead>
        <tbody>
          {d.not_in_app.map((l) => (
            <tr key={l.id} style={{ opacity: l.ignored ? 0.55 : 1 }}>
              <td style={{ whiteSpace: "normal" }}>{l.name || "—"}<div style={MUTED}>{l.gstin}</div></td>
              <td style={{ fontSize: 12 }}>{l.inv_no}</td><td style={{ whiteSpace: "nowrap" }}>{l.inv_date ? fmtDay(l.inv_date) : "—"}</td>
              <td style={R}>{num(l.taxable)}</td><td style={R}>{num(l.tax)}</td>
              <td>{canEdit && <button type="button" disabled={busy} onClick={() => onIgnore(l)} style={{ fontSize: 12, padding: "3px 10px", minHeight: 30 }}>{l.ignored ? "Set aside — undo" : "Set aside"}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------ modals ---
function Upload2B({ month, onClose, onDone, uploads }) {
  const [period, setPeriod] = useState(month);
  const [file, setFile] = useState(null);
  const [read, setRead] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function pick(f) {
    setFile(f); setRead(null); setErr("");
    if (!f) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const r = readGstr2b(XLSX, wb);
      if (!r.lines.length) { setErr("No invoices found — is this the GSTR-2B Excel from the GST portal (with a B2B sheet)?"); return; }
      setRead(r);
    } catch (e) { setErr(`Could not read the file: ${e.message}`); }
  }
  async function save() {
    setBusy(true); setErr("");
    try {
      const r = await apiRequest("/cost/gst/2b", { method: "POST", body: { period, file_name: file?.name, lines: read.lines } });
      onDone(`GSTR-2B for ${monthName(period)}: ${num(r.lines)} invoice line(s) read and matched.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  const inv = read ? read.lines.filter((l) => l.kind === "inv") : [];
  const tax = inv.reduce((t, l) => t + l.igst + l.cgst + l.sgst, 0);
  const months = Array.from({ length: 13 }, (_, i) => addMonths(month, -i));
  return (
    <Modal title="Upload GSTR-2B" onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
        <div style={MUTED}>On the GST portal: Returns → GSTR-2B → the month → Download Excel. Upload it as it is; a month uploaded again replaces the earlier one.</div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontWeight: 600 }}>Return period (month)
          <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ minHeight: 38 }}>
            {months.map((m) => <option key={m} value={m}>{monthName(m)}{uploads.some((u) => u.period === m) ? " · uploaded" : ""}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontWeight: 600 }}>GSTR-2B Excel
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => pick(e.target.files?.[0] || null)} />
        </label>
        {read && <Note tone="good">{num(inv.length)} invoice(s) from {num(new Set(inv.map((l) => l.gstin)).size)} supplier(s) · GST {rs(tax)}{read.lines.length > inv.length ? ` · ${num(read.lines.length - inv.length)} credit / debit note(s)` : ""}</Note>}
        {err && <div role="alert" style={{ color: "var(--alert-red)" }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={BTN}>Cancel</button>
          <button type="button" className="btn-primary" style={BTN} disabled={!read || busy} onClick={save}>{busy ? "Saving…" : "Save and match"}</button>
        </div>
        {uploads.length > 0 && <div style={MUTED}>Uploaded: {uploads.map((u) => `${monthName(u.period, false)} (${num(u.lines)} lines)`).join(" · ")}</div>}
      </div>
    </Modal>
  );
}

function SettingsModal({ d, onClose, onDone }) {
  const s = d.settings;
  const [f, setF] = useState({ from_month: s.from_month, our_state: s.our_state, open_igst: s.open.igst || "", open_cgst: s.open.cgst || "", open_sgst: s.open.sgst || "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr("");
    try { await apiRequest("/cost/gst/settings", { method: "PUT", body: f }); onDone(); } catch (e) { setErr(e.message); setBusy(false); }
  }
  const L = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  return (
    <Modal title="Where the working starts" onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={MUTED}>The page works month by month from this month, carrying unused credit forward. Enter the credit already in your electronic credit ledger at the start (from the GST portal), if any.</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={L}>Start month<input type="month" value={f.from_month} onChange={(e) => setF({ ...f, from_month: e.target.value })} style={{ minHeight: 36 }} /></label>
          <label style={L}>Our state code<input value={f.our_state} onChange={(e) => setF({ ...f, our_state: e.target.value })} style={{ width: 80, minHeight: 36 }} /></label>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {["igst", "cgst", "sgst"].map((k) => (
            <label key={k} style={L}>Opening {k.toUpperCase()} credit ₹<input type="number" min="0" step="0.01" value={f[`open_${k}`]} onChange={(e) => setF({ ...f, [`open_${k}`]: e.target.value })} style={{ width: 130, minHeight: 36 }} /></label>
          ))}
        </div>
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={BTN}>Cancel</button>
          <button type="button" className="btn-primary" style={BTN} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </Modal>
  );
}

function ChallanModal({ d, still, paid, onClose, onDone }) {
  const left = (k) => Math.max(0, Math.round((still[k] - paid[k]) * 100) / 100);
  const [f, setF] = useState({ month: d.month, cpin: "", paid_on: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    igst: left("igst") || "", cgst: left("cgst") || "", sgst: left("sgst") || "", interest: "", late_fee: "", note: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr("");
    try { await apiRequest("/cost/gst/challans", { method: "POST", body: f }); onDone(); } catch (e) { setErr(e.message); setBusy(false); }
  }
  const L = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  const box = (k, label, w = 120) => <label key={k} style={L}>{label}<input type={k === "cpin" || k === "note" ? "text" : "number"} min="0" step="0.01" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ width: w, minHeight: 36 }} /></label>;
  return (
    <Modal title={`GST challan — ${d.label}`} onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {box("cpin", "CPIN", 190)}
          <label style={L}>Paid on<input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} style={{ minHeight: 36 }} /></label>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{box("igst", "IGST ₹")}{box("cgst", "CGST ₹")}{box("sgst", "SGST ₹")}</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{box("interest", "Interest ₹")}{box("late_fee", "Late fee ₹")}{box("note", "Note", 220)}</div>
        <div style={MUTED}>The bank line for this payment is sorted as Tax on Bank statements — it is not a cost.</div>
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={BTN}>Cancel</button>
          <button type="button" className="btn-primary" style={BTN} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save challan"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ export ---
function exportCa(d) {
  const t = (x) => Math.round(tot(x) * 100) / 100;
  const summary = [
    ["GST working — " + d.label, "", "IGST", "CGST", "SGST", "Total"],
    ["Output GST (sales)", "", d.output.igst, d.output.cgst, d.output.sgst, t(d.output)],
    ["Credit brought in", "", d.carried_in.igst, d.carried_in.cgst, d.carried_in.sgst, t(d.carried_in)],
    ["Credit claimed this month", "", d.credit_new.igst, d.credit_new.cgst, d.credit_new.sgst, t(d.credit_new)],
    ["Reverse charge (cash)", "", d.rcm.igst, d.rcm.cgst, d.rcm.sgst, t(d.rcm)],
    ["Cash to pay", "", d.cash.igst, d.cash.cgst, d.cash.sgst, t(d.cash)],
    ["Paid (challans)", "", d.paid.igst, d.paid.cgst, d.paid.sgst, t(d.paid)],
    ["Credit carried forward", "", d.carried_out.igst, d.carried_out.cgst, d.carried_out.sgst, t(d.carried_out)],
    [], ["Taxable sales", d.output.taxable], ["Invoices with GST", d.output.invoices], ["Invoices with GST switched off", d.output.off.n, "amount", d.output.off.amount],
    ["Credit held (not in GSTR-2B)", d.input.held], ["GSTR-2B uploaded", d.has_2b ? "yes" : "no — credit is an estimate"],
  ];
  const src = [["Source", "GST rates", "Taxable", "GST paid", "In GSTR-2B", "Held", "Claim now"],
    ...d.input.groups.map((g) => [g.group, g.rates.join(", "), g.taxable, g.gst, g.in2b, g.held, g.claim])];
  const item = (i) => [i.day, i.party, i.gstin || "", i.inv_no || "", i.group, i.taxable, i.gst, STATUS[i.status]?.label || i.status, i.claim_ym || "", i.no_tax ? "no tax (flagged)" : ""];
  const head = ["Date", "Party", "GSTIN", "Their bill", "From", "Taxable", "GST", "Status", "Claimed in", "Flag"];
  const sup = [["Supplier", "GSTIN", "Bills", "GST paid", "In GSTR-2B", "Held"], ...d.by_supplier.map((s) => [s.party, s.gstin || "", s.n, s.gst, s.in2b, s.held])];
  const nia = [["GSTIN", "Supplier", "Invoice", "Date", "Taxable", "GST", "Set aside"], ...d.not_in_app.map((l) => [l.gstin, l.name || "", l.inv_no, l.inv_date || "", l.taxable, l.tax, l.ignored ? "yes" : ""])];
  const ch = [["Paid on", "CPIN", "IGST", "CGST", "SGST", "Interest", "Late fee"], ...d.challans.map((c) => [c.paid_on, c.cpin || "", c.igst, c.cgst, c.sgst, c.interest, c.late_fee])];
  downloadExcel(`GST working ${d.month}.xlsx`, [
    { name: "Summary", rows: summary }, { name: "Input by source", rows: src }, { name: "By supplier", rows: sup },
    { name: "Purchases", rows: [head, ...d.purchases.map(item)] }, { name: "Held", rows: [head, ...d.held.map(item)] },
    { name: "2B not in app", rows: nia }, { name: "Challans", rows: ch },
  ]);
}
