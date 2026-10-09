// Round 200 — the Transporter Ledger tab of the Material Module.
//
// Freight owed to each transporter on ex-factory loads, payments and opening
// balances, and one transporter's statement. Every figure comes from the
// backend's lib/transporterLedger.js; this screen only lays them out.
// Same look as the Supplier Ledger tab.
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function amt(v) {
  const a = Math.abs(Number(v));
  const whole = Math.abs(a - Math.round(a)) < 0.005;
  return a.toLocaleString("en-IN", whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const money = (n) => (n === null || n === undefined || n === "" ? "–" : `${Number(n) < 0 ? "-" : ""}₹${amt(n)}`);
// "payable" = we owe the transporter; "advance" = money with them. Never Cr/Dr.
function bal(n) {
  const v = Number(n || 0);
  if (Math.abs(v) < 0.005) return "₹0";
  return `₹${amt(v)} ${v > 0 ? "payable" : "advance"}`;
}
function fmtDate(d) {
  if (!d) return "–";
  const [y, m, day] = String(d).slice(0, 10).split("-");
  return `${day}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`;
}
const MODES = [["neft", "NEFT"], ["rtgs", "RTGS"], ["cheque", "Cheque"], ["upi", "UPI"], ["cash", "Cash"], ["other", "Other"]];
const input = { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", border: "1px solid var(--border-strong)", borderRadius: 8, fontFamily: "inherit" };
const th = { textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--slate)", fontWeight: 500, padding: "8px 6px", borderBottom: "1px solid var(--border-strong)", whiteSpace: "nowrap" };
const td = { padding: "8px 6px", borderBottom: "1px solid var(--border)", fontSize: 12.5, verticalAlign: "top" };
const num = { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

function Kpi({ label, value, sub, tone }) {
  return (
    <div className="kpi" style={tone === "dark" ? { background: "var(--charcoal)", color: "#fff", borderColor: "var(--charcoal)" } : undefined}>
      <div className="kpi-label" style={tone === "dark" ? { color: "#ccc" } : undefined}>{label}</div>
      <div className="kpi-value" style={{ fontSize: 20, color: tone === "red" ? "var(--alert-red)" : tone === "dark" ? "#fff" : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: tone === "dark" ? "#ccc" : "var(--slate)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", fontWeight: 600 }}>{label}{children}</label>;
}

export default function TransporterLedgerTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(null);
  const load = () => apiRequest("/material-module/transporter-ledger").then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (sel) return <Statement id={sel} onBack={() => { setSel(null); load(); }} />;
  const t = data?.totals;
  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
        Freight we owe each transporter on <b>ex-factory</b> loads (on a delivered order the supplier pays the transport and it is in the supplier&rsquo;s bill).
        Each receipt is a freight bill at its own rate on the accepted quantity, plus the transporter&rsquo;s GST % if set. Open a transporter to see the statement and record a payment.
      </div>
      {!data && !error && <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
            <Kpi label="We owe transporters" value={money(t.payable)} tone="dark" sub={t.advance ? `${money(t.advance)} advance with some` : null} />
            <Kpi label="Overdue" value={money(t.overdue)} tone={t.overdue ? "red" : undefined} />
            <Kpi label="Freight booked" value={money(t.freight)} />
            <Kpi label="Paid this month" value={money(t.paid_this_month)} sub={`${t.payments_this_month} payment${t.payments_this_month === 1 ? "" : "s"}`} />
            <Kpi label="Received, not billed" value={money(t.not_billed)} sub="receipts still waiting for approval" />
          </div>
          {t.no_rate > 0 && <div style={{ background: "var(--amber-bg)", color: "var(--amber)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 12 }}>{t.no_rate} ex-factory load{t.no_rate > 1 ? "s have" : " has"} no freight rate, so nothing is booked for {t.no_rate > 1 ? "them" : "it"}. Open the transporter to see which, and correct the rate on the receipt.</div>}
          {!data.transporters.length ? <div className="card" style={{ fontSize: 13 }}>No transporters yet. Add them in Suppliers → Transporters.</div> : (
            <div className="card" style={{ padding: "4px 12px" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Transporter</th><th style={{ ...th, ...num }}>Loads</th><th style={{ ...th, ...num }}>Freight</th><th style={{ ...th, ...num }}>Paid</th><th style={{ ...th, ...num }}>Balance</th><th style={{ ...th, ...num }}>Overdue</th><th style={th}>Last payment</th></tr></thead>
                  <tbody>
                    {data.transporters.map((x) => (
                      <tr key={x.transporter.id} onClick={() => setSel(x.transporter.id)} style={{ cursor: "pointer" }}>
                        <td style={td}><b>{x.transporter.name}</b>
                          <div style={{ fontSize: 11, color: "var(--slate)" }}>{x.transporter.credit_days != null ? `${x.transporter.credit_days} days credit` : "no credit days set"}{x.transporter.gst_pct ? ` · GST ${x.transporter.gst_pct}%` : ""}{x.no_rate.length ? ` · ${x.no_rate.length} without rate` : ""}</div></td>
                        <td style={{ ...td, ...num }}>{x.trips}</td>
                        <td style={{ ...td, ...num }}>{money(x.freight)}</td>
                        <td style={{ ...td, ...num }}>{money(x.paid)}</td>
                        <td style={{ ...td, ...num, fontWeight: 700 }}>{bal(x.balance)}</td>
                        <td style={{ ...td, ...num, color: x.overdue ? "var(--alert-red)" : "var(--slate)" }}>{x.overdue ? `${money(x.overdue)} · ${x.oldest_overdue_days}d` : "—"}</td>
                        <td style={td}>{x.last_payment ? `${fmtDate(x.last_payment.date)} · ${money(x.last_payment.amount)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Statement({ id, onBack }) {
  const { can } = usePermissions();
  const mayPay = can("material.transporter-payments", "create");
  const mayCancel = can("material.transporter-payments", "delete");
  const mayEditMaster = can("material.transporters", "edit");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayIst());
  const [l, setL] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // "pay" | "opening" | "terms"
  const load = () => {
    const q = new URLSearchParams({ to });
    if (from) q.set("from", from);
    apiRequest(`/material-module/transporter-ledger/${id}?${q}`).then(setL).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, [from, to]);
  const after = () => { setForm(null); load(); };

  async function exportXlsx() {
    const XLSX = await import("xlsx");
    const rows = [];
    if (l.brought_forward != null) rows.push({ Date: l.from, Particulars: "Brought forward", Reference: "", "Freight (Rs.)": "", "Paid (Rs.)": "", "Balance (Rs.)": l.brought_forward });
    for (const x of l.lines) rows.push({ Date: x.date, Particulars: x.text, Reference: x.refs, "Freight (Rs.)": x.credit || "", "Paid (Rs.)": x.debit || "", "Balance (Rs.)": x.balance });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Statement");
    XLSX.writeFile(wb, `Transporter_${l.transporter.name.replace(/[^A-Za-z0-9]+/g, "_")}_${l.to}.xlsx`);
  }

  if (!l) return <div>{error ? <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div> : <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}</div>;
  const tr = l.transporter;
  return (
    <div>
      <button type="button" onClick={onBack} style={{ fontSize: 12, marginBottom: 10 }}>&larr; All transporters</button>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{tr.name}</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>
            {tr.phone || "no phone"}{tr.pan ? ` · PAN ${tr.pan}` : ""}{tr.gstin ? ` · GSTIN ${tr.gstin}` : ""} · {tr.credit_days != null ? `${tr.credit_days} days credit` : "no credit days"} · GST {tr.gst_pct}% on freight
            {mayEditMaster && <button type="button" style={{ fontSize: 11, padding: "2px 8px", marginLeft: 8 }} onClick={() => setForm("terms")}>Edit terms</button>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
          {mayPay && <button type="button" className="btn-primary" onClick={() => setForm("pay")}>Record payment</button>}
          {mayPay && <button type="button" onClick={() => setForm("opening")}>Opening balance</button>}
          <button type="button" onClick={exportXlsx}>Download Excel</button>
        </div>
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {form === "pay" && <PaymentForm l={l} onDone={after} onCancel={() => setForm(null)} />}
      {form === "opening" && <OpeningForm l={l} onDone={after} onCancel={() => setForm(null)} />}
      {form === "terms" && <TermsForm tr={tr} onDone={after} onCancel={() => setForm(null)} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Kpi label="Balance" value={bal(l.balance)} tone="dark" />
        <Kpi label="Overdue" value={money(l.overdue)} tone={l.overdue ? "red" : undefined} sub={l.overdue ? `oldest ${l.oldest_overdue_days} days late` : null} />
        <Kpi label="Freight booked" value={money(l.freight)} sub={`${l.trips} loads · ${l.qty_mt} MT`} />
        <Kpi label="Paid (incl. TDS)" value={money(l.paid)} />
      </div>
      {l.no_rate.length > 0 && <div style={{ background: "var(--amber-bg)", color: "var(--amber)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 10 }}>
        No freight rate on: {l.no_rate.map((x) => `R-${String(x.id).padStart(4, "0")} (${fmtDate(x.date)}, ${x.material_name})`).join(", ")} — nothing is booked for these until the rate is set on the receipt.</div>}
      {l.not_billed.length > 0 && <div style={{ background: "var(--info-bg)", color: "var(--info)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 10 }}>
        Received, not billed yet: {l.not_billed.map((x) => `R-${String(x.id).padStart(4, "0")} ${fmtDate(x.date)} ${x.value != null ? money(x.value) : ""} (${x.note})`).join("; ")}</div>}

      <div className="card" style={{ padding: "8px 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, flex: 1 }}>Statement</div>
          <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ ...input, width: 150 }} /></Field>
          <Field label="To"><input type="date" value={to} max={todayIst()} onChange={(e) => e.target.value && setTo(e.target.value)} style={{ ...input, width: 150 }} /></Field>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Date</th><th style={th}>Particulars</th><th style={{ ...th, ...num }}>Freight</th><th style={{ ...th, ...num }}>Paid</th><th style={{ ...th, ...num }}>Balance</th><th style={th}></th></tr></thead>
            <tbody>
              {l.brought_forward != null && <tr><td style={td}>{fmtDate(l.from)}</td><td style={{ ...td, fontStyle: "italic" }}>Brought forward</td><td style={td}></td><td style={td}></td><td style={{ ...td, ...num }}>{bal(l.brought_forward)}</td><td style={td}></td></tr>}
              {!l.lines.length && <tr><td style={td} colSpan={6}>Nothing in this period.</td></tr>}
              {l.lines.map((x, i) => (
                <tr key={i}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtDate(x.date)}</td>
                  <td style={td}>{x.type === "payment" ? <b>Payment · {x.text}</b> : x.text}<div style={{ fontSize: 11, color: "var(--slate)" }}>{x.refs}</div></td>
                  <td style={{ ...td, ...num }}>{x.credit ? money(x.credit) : ""}</td>
                  <td style={{ ...td, ...num }}>{x.debit ? money(x.debit) : ""}</td>
                  <td style={{ ...td, ...num }}>{bal(x.balance)}</td>
                  <td style={td}>{x.type === "payment" && mayCancel && <button type="button" style={{ fontSize: 10.5, padding: "2px 7px" }} onClick={async () => {
                    const reason = window.prompt("Why is this payment being cancelled?");
                    if (!reason) return;
                    try { await apiRequest(`/material-module/transporter-payments/${x.ref_id}/cancel`, { method: "POST", body: { reason } }); load(); } catch (err) { setError(err.message); }
                  }}>Cancel</button>}</td>
                </tr>
              ))}
            </tbody>
            {l.lines.length > 0 && <tfoot><tr><td style={td}></td><td style={{ ...td, fontWeight: 700 }}>Period total</td><td style={{ ...td, ...num, fontWeight: 700 }}>{money(l.period_credit)}</td><td style={{ ...td, ...num, fontWeight: 700 }}>{money(l.period_debit)}</td><td style={{ ...td, ...num, fontWeight: 700 }}>{bal(l.balance)}</td><td style={td}></td></tr></tfoot>}
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: "8px 12px" }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Unpaid freight ({l.open_bills.length})</div>
        {!l.open_bills.length ? <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Nothing outstanding.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Bill</th><th style={th}>Date</th><th style={th}>Due</th><th style={{ ...th, ...num }}>Amount</th><th style={{ ...th, ...num }}>Outstanding</th></tr></thead>
              <tbody>
                {l.open_bills.map((b) => (
                  <tr key={b.kind + b.id}>
                    <td style={td}><b>{b.no}</b><div style={{ fontSize: 11, color: "var(--slate)" }}>{b.detail}{b.vehicle ? ` · ${b.vehicle}` : ""}</div></td>
                    <td style={td}>{fmtDate(b.date)}</td>
                    <td style={{ ...td, color: b.overdue ? "var(--alert-red)" : undefined }}>{fmtDate(b.due_date)}{b.overdue ? ` · ${b.days_late}d late` : ""}</td>
                    <td style={{ ...td, ...num }}>{money(b.amount)}</td>
                    <td style={{ ...td, ...num, fontWeight: 600 }}>{money(b.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 6 }}>Payments (with TDS) settle the oldest freight first.</div>
      </div>
    </div>
  );
}

function FormCard({ title, children, onSubmit, onCancel, error, saving, submitLabel }) {
  return (
    <form className="card" onSubmit={onSubmit} style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>{children}</div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving…" : submitLabel}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
function useSubmit(fn, onDone) {
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  return { error, saving, submit: async (e) => { e.preventDefault(); setError(""); setSaving(true); try { await fn(); onDone(); } catch (err) { setError(err.message); } finally { setSaving(false); } } };
}

function PaymentForm({ l, onDone, onCancel }) {
  const [f, setF] = useState({ paid_on: todayIst(), amount: l.balance > 0 ? String(l.balance) : "", tds_amount: "", mode: "neft", reference: "", notes: "" });
  const s = useSubmit(() => apiRequest(`/material-module/transporter-ledger/${l.transporter.id}/payments`, { method: "POST", body: f }), onDone);
  const total = Number(f.amount || 0) + Number(f.tds_amount || 0);
  return (
    <FormCard title={`Record a payment to ${l.transporter.name}`} onSubmit={s.submit} onCancel={onCancel} error={s.error} saving={s.saving} submitLabel="Save payment">
      <Field label="Paid on"><input type="date" max={todayIst()} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} style={input} required /></Field>
      <Field label="Amount paid (₹)"><input type="number" min="0.01" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={input} required /></Field>
      <Field label="TDS deducted (₹)"><input type="number" min="0" step="0.01" value={f.tds_amount} onChange={(e) => setF({ ...f, tds_amount: e.target.value })} style={input} placeholder="0" /></Field>
      <Field label="Mode"><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} style={input}>{MODES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="UTR / cheque / UPI ref."><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} style={input} required={["neft", "rtgs", "cheque", "upi"].includes(f.mode)} /></Field>
      <Field label="Note"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={input} /></Field>
      <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)" }}>Settles {money(total)} of freight (amount + TDS), oldest first. Balance now {bal(l.balance)}.</div>
    </FormCard>
  );
}

function OpeningForm({ l, onDone, onCancel }) {
  const o = l.opening;
  const [f, setF] = useState({ as_on: o?.as_on || todayIst(), direction: o?.direction || "payable", amount: o ? String(o.amount) : "", remarks: o?.remarks || "" });
  const s = useSubmit(() => apiRequest(`/material-module/transporter-ledger/${l.transporter.id}/opening`, { method: "PUT", body: f }), onDone);
  return (
    <FormCard title="Opening balance" onSubmit={s.submit} onCancel={onCancel} error={s.error} saving={s.saving} submitLabel="Save opening balance">
      <Field label="As on"><input type="date" value={f.as_on} onChange={(e) => setF({ ...f, as_on: e.target.value })} style={input} required /></Field>
      <Field label="Which way"><select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} style={input}><option value="payable">We owe the transporter</option><option value="advance">We paid an advance</option></select></Field>
      <Field label="Amount (₹)"><input type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={input} required /></Field>
      <Field label="Remarks"><input value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} style={input} placeholder="e.g. as per Tally 30-Sep" /></Field>
      <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)" }}>The balance carried in from before the app — one figure. Saving again replaces it.</div>
    </FormCard>
  );
}

function TermsForm({ tr, onDone, onCancel }) {
  const [f, setF] = useState({ phone: tr.phone || "", pan: tr.pan || "", gstin: tr.gstin || "", credit_days: tr.credit_days ?? "", gst_pct: tr.gst_pct ?? 0 });
  const s = useSubmit(() => apiRequest(`/material-module/transporters/${tr.id}`, { method: "PATCH", body: f }), onDone);
  return (
    <FormCard title={`${tr.name} — terms`} onSubmit={s.submit} onCancel={onCancel} error={s.error} saving={s.saving} submitLabel="Save">
      <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} style={input} /></Field>
      <Field label="PAN"><input value={f.pan} maxLength={12} onChange={(e) => setF({ ...f, pan: e.target.value })} style={input} /></Field>
      <Field label="GSTIN"><input value={f.gstin} maxLength={20} onChange={(e) => setF({ ...f, gstin: e.target.value })} style={input} /></Field>
      <Field label="Credit days"><input type="number" min="0" max="365" value={f.credit_days} onChange={(e) => setF({ ...f, credit_days: e.target.value })} style={input} placeholder="0 = due on the day" /></Field>
      <Field label="GST % added to freight"><input type="number" min="0" max="28" step="0.01" value={f.gst_pct} onChange={(e) => setF({ ...f, gst_pct: e.target.value })} style={input} /></Field>
      <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)" }}>Leave GST at 0 if the transporter does not charge GST (e.g. under reverse charge you pay it to the government, not to them).</div>
    </FormCard>
  );
}
