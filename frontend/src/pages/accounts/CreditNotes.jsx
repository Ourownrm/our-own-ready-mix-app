// Round 252 — Accounts → Credit notes (owner, 30 Oct 2026; mockup artboard 8).
//   Returns to credit — loads returned / rejected at site from Oct 2026: the
//     invoice stays at the full quantity until a credit note is approved.
//   New credit note — against one invoice: returned concrete (m³ × rate),
//     rate correction, discount or other (an amount). App series number.
//   Awaiting approval — the Administrator approves or rejects; only then does
//     the customer's ledger change. Approved notes print in the app format.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { inr2, fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, Banner, Field, Modal, Empty, Table } from "./ui.jsx";

const VIEWS = [["to_credit", "Returns to credit"], ["pending", "Awaiting approval"], ["approved", "Approved"], ["closed", "Rejected / cancelled"]];
const BADGE = { pending: ["Awaiting approval", "badge-warning"], approved: ["Approved", "badge-success"], rejected: ["Rejected", "badge-danger"], cancelled: ["Cancelled", "badge-neutral"] };

export default function CreditNotes({ params, go }) {
  const { can } = usePermissions();
  const canCreate = can("accounts.credit-notes", "create");
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(0);
  const [form, setForm] = useState(null);   // { invoiceId?, reason?, qty? }
  const view = params.get("view") || "to_credit";
  const load = () => apiRequest("/accounts/credit-notes").then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function act(cn, what) {
    let note = "";
    if (what === "approve" && !window.confirm(`Approve ${cn.cn_no} for ₹${inr2(cn.total_amount)}? ${cn.customer_name}'s balance goes down by this amount.`)) return;
    if (what === "reject" || what === "cancel") {
      note = window.prompt(what === "reject" ? `Why is ${cn.cn_no} rejected?` : `Cancel ${cn.cn_no}? Give the reason.${cn.status === "approved" ? " The customer's balance goes back up." : ""}`, "");
      if (note == null) return;
      if (what === "reject" && !note.trim()) { setError("Say why it is rejected."); return; }
    }
    setBusy(cn.id); setError(""); setMsg("");
    try {
      await apiRequest(`/accounts/credit-notes/${cn.id}/${what}`, { method: "POST", body: { note } });
      setMsg(what === "approve" ? `${cn.cn_no} approved — the customer's ledger is adjusted.` : what === "reject" ? `${cn.cn_no} rejected.` : `${cn.cn_no} cancelled.`);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(0); }
  }
  async function print(cn) {
    setBusy(cn.id); setError("");
    try {
      const full = await apiRequest(`/accounts/credit-notes/${cn.id}`);
      const m = await import("../../lib/creditNotePrint.js");
      await m.printCreditNote(full);
    } catch (e) { setError(e.message); } finally { setBusy(0); }
  }

  if (!d) return <><Banner>{error}</Banner>{!error && <Empty>Loading…</Empty>}</>;
  const notes = d.notes.filter((n) => (view === "pending" ? n.status === "pending" : view === "approved" ? n.status === "approved" : view === "closed" ? ["rejected", "cancelled"].includes(n.status) : false));
  const counts = { to_credit: d.to_credit.length, pending: d.notes.filter((n) => n.status === "pending").length };

  return (
    <>
      <Banner>{error}</Banner>
      <Banner kind="ok">{msg}</Banner>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" className={`btn-tab ${view === k ? "active" : ""}`} onClick={() => go("credit-notes", { view: k })}>
            {label}{counts[k] ? ` · ${counts[k]}` : ""}
          </button>
        ))}
        {canCreate && <button type="button" className="btn-primary" style={{ marginLeft: "auto" }} onClick={() => setForm({})}>+ New credit note</button>}
      </div>

      {view === "to_credit" && (
        <>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 8 }}>
            Concrete returned or rejected at site from 1 Oct 2026. The invoice stays at the full delivered quantity until the credit note is approved; production already shows the net m³.
          </div>
          {!d.to_credit.length ? <Empty>Nothing waiting — every return has a credit note.</Empty> : (
            <Table minWidth={760} head={<>
              <th style={TH}>Delivery · date</th><th style={TH}>Customer · site</th><th style={TH}>Returned</th>
              <th style={{ ...NUM, fontWeight: 600, fontSize: 12, color: "var(--slate)" }}>Value at billed rate</th><th style={TH} />
            </>}>
              {d.to_credit.map((r) => (
                <tr key={r.invoice_id} style={row}>
                  <td style={TD}><b>{r.ticket_number}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{fmtDate(r.ticket_date)}</div></td>
                  <td style={TD}>{r.customer_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.site_name}</div></td>
                  <td style={TD}>{r.returned_m3} of {r.loaded_m3} m³ {r.grade_name}{r.return_reason && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.return_reason}</div>}</td>
                  <td style={NUM}>₹{inr2(r.value)}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {canCreate && <button type="button" style={{ fontSize: 12.5, padding: "5px 12px" }} onClick={() => setForm({ invoiceId: r.invoice_id, reason: "return", qty: r.returned_m3 })}>Create credit note</button>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}

      {view !== "to_credit" && (!notes.length ? <Empty>None here.</Empty> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {notes.map((n) => {
            const [label, cls] = BADGE[n.status] || [n.status, "badge-neutral"];
            const b = busy === n.id;
            const mine = n.raised_by_id && d.me === n.raised_by_id;
            return (
              <div key={n.id} className="card" style={{ padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{n.cn_no} <span className={`badge ${cls}`} style={{ marginLeft: 6 }}>{label}</span></div>
                    <div style={{ fontSize: 12.5, color: "var(--slate)" }}>
                      Against {n.ticket_number} · {n.customer_name} · {d.reasons[n.reason]}{n.qty_m3 ? ` · ${n.qty_m3} m³` : ""} · raised by {n.raised_by || "—"}, {fmtDate(String(n.raised_at).slice(0, 10))}
                      {n.decided_by && ` · ${n.status} by ${n.decided_by}`}{n.decision_note && ` — “${n.decision_note}”`}
                    </div>
                    {n.note && <div style={{ fontSize: 12.5, marginTop: 2 }}>{n.note}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" disabled={b} onClick={() => print(n)}>{n.status === "approved" ? "Print / PDF" : "Preview"}</button>
                    {n.status === "pending" && d.can_approve && <button type="button" disabled={b} onClick={() => act(n, "reject")}>Reject</button>}
                    {n.status === "pending" && d.can_approve && <button type="button" className="btn-primary" disabled={b} onClick={() => act(n, "approve")}>Approve</button>}
                    {(n.status === "pending" && (d.can_approve || mine || canCreate)) || (n.status === "approved" && d.can_approve)
                      ? <button type="button" disabled={b} onClick={() => act(n, "cancel")}>Cancel</button> : null}
                  </div>
                </div>
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, fontSize: 12.5 }}>
                  <div style={{ background: "#F8F6F1", borderRadius: 8, padding: "7px 10px" }}>Taxable value<br /><b>₹{inr2(n.base_amount)}</b></div>
                  <div style={{ background: "#F8F6F1", borderRadius: 8, padding: "7px 10px" }}>{n.gst_applied ? "CGST 9% + SGST 9%" : "GST"}<br /><b>{n.gst_applied ? `₹${inr2(Number(n.cgst) + Number(n.sgst))}` : "none (no-GST invoice)"}</b></div>
                  <div style={{ background: "#F8F6F1", borderRadius: 8, padding: "7px 10px" }}>Credit note total<br /><b>₹{inr2(n.total_amount)}</b></div>
                  {n.status === "pending" && <div style={{ background: "#FFF7F0", borderRadius: 8, padding: "7px 10px", color: "#7A3A08" }}>On approval<br /><b>customer balance − ₹{inr2(n.total_amount)}</b></div>}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {form && <NewCreditNote init={form} reasons={d.reasons} onClose={() => setForm(null)}
        onDone={(r) => { setForm(null); setMsg(`${r.cn_no} raised — sent to the Administrator for approval.`); load(); go("credit-notes", { view: "pending" }); }} />}
    </>
  );
}

function NewCreditNote({ init, reasons, onClose, onDone }) {
  const [inv, setInv] = useState(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState([]);
  const [f, setF] = useState({ reason: init.reason || "return", qty_m3: init.qty != null ? String(init.qty) : "", rate_incl: "", amount: "", note: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!init.invoiceId) return;
    apiRequest(`/accounts/credit-notes/invoices?invoice_id=${init.invoiceId}`).then((r) => {
      if (r[0]) { setInv(r[0]); setF((x) => ({ ...x, rate_incl: r[0].rate_per_m3 ? String(r[0].rate_per_m3) : "" })); }
    }).catch((e) => setError(e.message));
  }, [init.invoiceId]);
  useEffect(() => {
    if (inv || q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => apiRequest(`/accounts/credit-notes/invoices?q=${encodeURIComponent(q.trim())}`).then(setFound).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q, inv]);
  const total = f.reason === "return" ? Math.round((Number(f.qty_m3) || 0) * (Number(f.rate_incl) || 0) * 100) / 100 : Number(f.amount) || 0;
  async function save(e) {
    e.preventDefault();
    if (!inv) { setError("Choose the invoice (delivery note)."); return; }
    setBusy(true); setError("");
    try { onDone(await apiRequest("/accounts/credit-notes", { method: "POST", body: { invoice_id: inv.id, ...f } })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  const pick = (r) => { setInv(r); setFound([]); setF((x) => ({ ...x, rate_incl: r.rate_per_m3 ? String(r.rate_per_m3) : "", qty_m3: x.qty_m3 || (Number(r.returned_m3) > 0 ? String(r.returned_m3) : "") })); };
  return (
    <Modal title="New credit note" onClose={onClose} width={560}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>The number is given on save (app series, April–March). It waits for the Administrator; the ledger changes only when it is approved.</div>
        {inv ? (
          <div className="card" style={{ padding: 10, marginBottom: 10, fontSize: 13 }}>
            <b>{inv.ticket_number}</b> · {fmtDate(inv.ticket_date)} · {inv.customer_name} · {inv.site_name}<br />
            {inv.grade_name} · {inv.loaded_quantity_m3} m³ · invoice ₹{inr2(inv.total_amount)} · <b>₹{inr2(inv.creditable)}</b> left to credit
            {!init.invoiceId && <button type="button" style={{ marginLeft: 8, fontSize: 12, padding: "2px 8px" }} onClick={() => setInv(null)}>Change</button>}
          </div>
        ) : (
          <Field label="Against invoice — search delivery note or customer">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. DN 2490 or customer name" />
            {found.length > 0 && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: "auto" }}>
                {found.map((r) => (
                  <button key={r.id} type="button" onClick={() => pick(r)} style={{ display: "block", width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid var(--border)", borderRadius: 0, padding: "8px 10px", fontSize: 12.5, background: "var(--surface)" }}>
                    <b>{r.ticket_number}</b> · {fmtDate(r.ticket_date)} · {r.customer_name} · ₹{inr2(r.total_amount)}{Number(r.creditable) < Number(r.total_amount) ? ` (₹${inr2(r.creditable)} left)` : ""}
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}
        <Field label="Reason">
          <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
            {Object.entries(reasons).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        {f.reason === "return" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Quantity returned (m³)"><input inputMode="decimal" value={f.qty_m3} onChange={(e) => setF({ ...f, qty_m3: e.target.value })} required /></Field>
            <Field label="Rate with GST (₹/m³)" hint="The rate it was billed at."><input inputMode="decimal" value={f.rate_incl} onChange={(e) => setF({ ...f, rate_incl: e.target.value })} required /></Field>
          </div>
        ) : (
          <Field label="Credit amount with GST (₹)" hint={f.reason === "rate" ? "The difference: (billed rate − correct rate) × m³." : undefined}>
            <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />
          </Field>
        )}
        <Field label="Note on the credit note"><textarea rows={2} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={f.reason === "return" ? "e.g. 1.5 m³ returned at site — slump too low." : ""} /></Field>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F8F6F1", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 10 }}>
          <span>Credit note total (with GST)</span><b>₹{inr2(total)}</b>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !inv || !(total > 0)}>{busy ? "Saving…" : "Send for approval"}</button>
        </div>
      </form>
    </Modal>
  );
}
