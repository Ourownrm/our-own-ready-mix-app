// Round 205 — "Record a receipt", shared by Accounts → Bank receipts and the
// Accountant home (it replaces the old "Record payment"). Shows which dues
// the money pays, oldest first, before saving; anything over is kept as the
// customer's advance and pays the next invoices automatically.
//
// Round 255 (owner, 31 Oct 2026): every mode again (cash, bank transfer, UPI,
// cheque) — Round 252's "cash only" is gone; a bank transfer recorded here is
// matched when the bank statement comes, not posted twice. "Send to C Ledger":
// cash goes to a cash holder's wallet as a collection to accept; any other
// mode is a "Paid to bank" line. The invoices it pays are marked Cash.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { todayStr } from "../../lib/istDate.js";
import { inr2, fmtDate } from "../../lib/quotationTerms.js";
import { Banner, Field, Modal } from "./ui.jsx";

export function ReceiptModal({ customerId, onClose, onDone }) {
  const [customers, setCustomers] = useState([]);
  const [f, setF] = useState({ customer_id: customerId || "", receipt_date: todayStr(), amount: "", mode: "cash", reference_number: "", remarks: "" });
  const [toCl, setToCl] = useState(false);
  const [holder, setHolder] = useState("");
  const [holders, setHolders] = useState(null);
  useEffect(() => { apiRequest("/accounts/cl-holders").then((h) => { setHolders(h); if (h[0]) setHolder(String(h[0].id)); }).catch(() => setHolders([])); }, []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!customerId) apiRequest("/master/customers").then(setCustomers).catch(() => {}); }, [customerId]);
  // Round 205 — what this receipt will pay, oldest due first, before saving.
  const [open, setOpen] = useState(null);
  useEffect(() => {
    setOpen(null);
    if (!f.customer_id) return;
    apiRequest(`/accounts/ledger/${f.customer_id}`).then((d) => setOpen(d.open_items || [])).catch(() => setOpen(null));
  }, [f.customer_id]);
  const preview = [];
  let left = Number(f.amount) || 0;
  for (const it of open || []) {
    if (left <= 0.01) break;
    const amt = Math.min(left, Number(it.balance));
    preview.push({ ...it, amt, full: amt >= Number(it.balance) - 0.01 });
    left -= amt;
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const c_ledger = !toCl ? null : f.mode === "cash" ? { holder_id: Number(holder) } : { bank: true };
    if (toCl && f.mode === "cash" && !holder) { setError("Choose the cash holder who has the cash."); setBusy(false); return; }
    try { onDone(await apiRequest("/accounts/receipts", { method: "POST", body: { ...f, customer_id: Number(f.customer_id), amount: Number(f.amount), c_ledger } })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title="Record a receipt" onClose={onClose} width={480}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        {!customerId && (
          <Field label="Customer">
            <select required value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })}>
              <option value="">Choose…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Date received"><input type="date" required value={f.receipt_date} max={todayStr()} onChange={(e) => setF({ ...f, receipt_date: e.target.value })} /></Field>
          <Field label="Amount ₹"><input type="number" min="1" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Mode">
            <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="cash">Cash</option>
              <option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option><option value="cheque">Cheque</option>
            </select>
          </Field>
          <Field label="Reference / cheque no."><input value={f.reference_number} onChange={(e) => setF({ ...f, reference_number: e.target.value })} /></Field>
        </div>
        <Field label="Remarks"><input value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
        {f.mode !== "cash" && <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>When the bank statement comes, its line for this money is matched to this receipt — it is not posted twice.</div>}
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 10, background: toCl ? "var(--concrete)" : undefined }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, fontWeight: 600 }}>
            <input type="checkbox" checked={toCl} onChange={(e) => setToCl(e.target.checked)} style={{ width: "auto" }} /> Send to C Ledger
          </label>
          {toCl && (f.mode === "cash" ? (
            holders && holders.length === 0 ? <div style={{ fontSize: 12, color: "var(--alert-red)", marginTop: 6 }}>No cash holders yet — a Super Admin sets them under C Ledger users.</div> : (
              <Field label="Cash holder who has the cash" style={{ marginTop: 8, marginBottom: 0 }}>
                <select value={holder} onChange={(e) => setHolder(e.target.value)}>
                  {(holders || []).map((h) => <option key={h.id} value={h.id}>{h.short}{h.short !== h.name ? ` — ${h.name}` : ""}</option>)}
                </select>
              </Field>
            )
          ) : <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 6 }}>Goes in as &ldquo;Paid to bank&rdquo; — collected, in nobody&rsquo;s cash.</div>)}
          {toCl && <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 6 }}>The invoices it pays are marked Cash and get a collection line each; anything not set against an invoice goes in as a collection only.</div>}
        </div>
        {open && Number(f.amount) > 0 ? (
          <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12.5 }}>
            <div style={{ color: "var(--slate)", marginBottom: 4 }}>This receipt pays (oldest first):</div>
            {!preview.length && <div style={{ color: "var(--slate)" }}>Nothing is due — all of it is kept as an advance.</div>}
            {preview.slice(0, 8).map((p) => (
              <div key={`${p.kind}${p.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{p.label} · {fmtDate(p.on_date)}</span><span>₹{inr2(p.amt)}{p.full ? "" : " (part)"}</span>
              </div>
            ))}
            {preview.length > 8 && <div style={{ color: "var(--slate)" }}>… and {preview.length - 8} more</div>}
            {left > 0.01 && <div style={{ color: "var(--amber)", marginTop: 4 }}>₹{inr2(left)} more than is due — kept as an advance for the next deliveries.</div>}
          </div>
        ) : <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Paid against the oldest dues first; anything over is kept as an advance.</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save receipt"}</button>
        </div>
      </form>
    </Modal>
  );
}
