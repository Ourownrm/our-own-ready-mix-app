// Round 212 — correct a wrong payment entry from the customer ledger (owner,
// 16 Oct 2026). Edit: change the date, amount, mode, reference or remarks —
// and for a receipt, the customer it belongs to. Delete: the receipt is
// cancelled (a bank line goes back to "To post"). A reason is needed for
// either, and every change is logged on the customer's statement.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { todayStr } from "../../lib/istDate.js";
import { inr2, fmtDate } from "../../lib/quotationTerms.js";
import { Banner, Field, Modal } from "./ui.jsx";

export function CorrectEntryModal({ entry, mode, canEdit, canDelete, onClose, onDone }) {
  const [e, setE] = useState(null);
  const [f, setF] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [action, setAction] = useState(mode === "delete" ? "delete" : "edit");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = `/accounts/ledger/entries/${entry.kind}/${entry.id}`;

  useEffect(() => {
    apiRequest(url).then((d) => {
      setE(d);
      setF({ customer_id: String(d.customer_id), date: d.date, amount: String(Number(d.amount)), mode: d.mode, reference_number: d.reference_number || "", remarks: d.remarks || "" });
    }).catch((err) => setError(err.message));
    if (entry.kind === "receipt") apiRequest("/master/customers").then(setCustomers).catch(() => {});
  }, [url, entry.kind]);

  async function save(ev) {
    ev.preventDefault();
    setBusy(true); setError("");
    try {
      if (action === "delete") {
        await apiRequest(`${url}/delete`, { method: "POST", body: { reason } });
        onDone(`${label} of ₹${inr2(e.amount)} deleted.`);
      } else {
        const body = { ...f, amount: Number(f.amount), reason };
        if (entry.kind === "receipt") body.customer_id = Number(f.customer_id);
        else delete body.customer_id;
        const r = await apiRequest(`${url}/edit`, { method: "POST", body });
        const name = customers.find((c) => String(c.id) === f.customer_id)?.name;
        onDone(r.moved
          ? `Receipt moved to ${name || "the other customer"}.`
          : `${label} corrected${r.against ? ` — now set against ${r.against}` : ""}${r.advance ? `; ₹${inr2(r.advance)} kept as advance` : ""}.`);
      }
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const label = entry.kind === "receipt" ? "Receipt" : "Payment";
  const locked = e?.from_bank;
  return (
    <Modal title={`Correct ${label.toLowerCase()} · ${fmtDate(entry.on_date)} · ₹${inr2(entry.credit)}`} onClose={onClose} width={500}>
      <Banner>{error}</Banner>
      {!e || !f ? (!error && <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>) : (
        <form onSubmit={save}>
          {canEdit && canDelete && (
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <button type="button" className={action === "edit" ? "btn-primary" : ""} onClick={() => setAction("edit")}>Edit</button>
              <button type="button" className={action === "delete" ? "btn-primary" : ""} onClick={() => setAction("delete")}>Delete</button>
            </div>
          )}
          {action === "edit" ? (
            <>
              {entry.kind === "receipt" && (
                <Field label="Customer" hint={f.customer_id !== String(e.customer_id) ? "The receipt moves to this customer's ledger and pays their dues." : null}>
                  <select value={f.customer_id} onChange={(ev) => setF({ ...f, customer_id: ev.target.value })}>
                    {!customers.some((c) => String(c.id) === String(e.customer_id)) && <option value={String(e.customer_id)}>{e.customer_name}</option>}
                    {customers.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                  </select>
                </Field>
              )}
              {entry.kind === "payment" && <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>Against <b>{e.against}</b></div>}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Date received"><input type="date" required disabled={locked} value={f.date} max={todayStr()} onChange={(ev) => setF({ ...f, date: ev.target.value })} /></Field>
                <Field label="Amount ₹"><input type="number" min="0.01" step="0.01" required disabled={locked} value={f.amount} onChange={(ev) => setF({ ...f, amount: ev.target.value })} /></Field>
                <Field label="Mode">
                  <select value={f.mode} onChange={(ev) => setF({ ...f, mode: ev.target.value })}>
                    <option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option>
                  </select>
                </Field>
                <Field label="Reference / cheque no."><input value={f.reference_number} onChange={(ev) => setF({ ...f, reference_number: ev.target.value })} /></Field>
              </div>
              <Field label="Remarks"><input value={f.remarks} onChange={(ev) => setF({ ...f, remarks: ev.target.value })} /></Field>
              {locked && <div style={{ fontSize: 12, color: "var(--amber)", marginBottom: 10 }}>From the bank statement — date and amount are the bank's. To change them, delete this receipt and post the bank line again.</div>}
              {entry.kind === "receipt" && <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>On saving, the receipt is set against the dues again, oldest first; anything over is kept as an advance.</div>}
            </>
          ) : (
            <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13 }}>
              Delete this {label.toLowerCase()} of <b>₹{inr2(e.amount)}</b> dated {fmtDate(e.date)}{e.reference_number ? ` (ref ${e.reference_number})` : ""}?
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4 }}>
                {entry.kind === "receipt"
                  ? <>The dues it paid become due again.{locked && " Its bank line goes back to “To post” in Bank receipts."} It stays in the corrections log.</>
                  : <>What it paid becomes due again. It stays in the corrections log.</>}
              </div>
            </div>
          )}
          <Field label="Reason (kept in the corrections log)">
            <input required value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder={action === "delete" ? "e.g. entered twice" : "e.g. wrong amount typed"} />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose}>Close</button>
            <button type="submit" disabled={busy} style={action === "delete" ? { background: "var(--alert-red)", color: "#fff", borderColor: "var(--alert-red)" } : undefined} className={action === "edit" ? "btn-primary" : ""}>
              {busy ? "Saving…" : action === "delete" ? `Delete ${label.toLowerCase()}` : "Save correction"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// The corrections made on this customer's ledger.
export function CorrectionsLog({ customerId, tick }) {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { apiRequest(`/accounts/ledger/${customerId}/corrections`).then(setD).catch(() => setD({ rows: [], customers: {} })); }, [customerId, tick]);
  if (!d || !d.rows.length) return null;
  const desc = (v) => !v ? "" : [
    v.customer_id && d.customers[v.customer_id], fmtDate(v.date), `₹${inr2(v.amount)}`, v.mode?.replace("_", " "),
    v.reference_number && `ref ${v.reference_number}`, v.remarks,
  ].filter(Boolean).join(" · ");
  return (
    <div className="card" style={{ marginTop: 12, fontSize: 13 }}>
      <button type="button" onClick={() => setOpen(!open)} style={{ fontSize: 12.5 }}>{open ? "Hide" : "Show"} corrections ({d.rows.length})</button>
      {open && d.rows.map((r) => (
        <div key={r.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
          <div><b>{r.action === "delete" ? "Deleted" : "Edited"}</b> {r.entry_kind} #{r.entry_id} · {new Date(r.done_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} · {r.done_by_name}</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>
            Was: {desc(r.before_value)}{r.after_value && <><br />Now: {desc(r.after_value)}</>}
            <br />Reason: {r.reason}
          </div>
        </div>
      ))}
    </div>
  );
}
