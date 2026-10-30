// Round 251 — print a B2C invoice in the Tally format (owner, 30 Oct 2026).
// Only for invoices without a GSTIN. The Tally invoice number and the Tally
// boxes the app does not hold are typed here, only when printing; they are
// kept on the invoice so a reprint shows the same, and a number already used
// on another invoice is flagged before it prints.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { inr2 } from "../../lib/quotationTerms.js";
import { Modal, Banner } from "./ui.jsx";

const BOXES = [
  ["delivery_note", "Delivery Note"], ["payment_terms", "Mode/Terms of Payment"],
  ["reference", "Reference No. & Date"], ["other_references", "Other References"],
  ["buyer_order_no", "Buyer's Order No."], ["buyer_order_date", "Dated (buyer's order)"],
  ["dispatch_doc_no", "Dispatch Doc No."], ["delivery_note_date", "Delivery Note Date"],
  ["dispatched_through", "Dispatched through"], ["lr_no", "Bill of Lading/LR-RR No."],
];
const LBL = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" };
const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px 14px" };

// "B2C/195/26-27" → "B2C/196/26-27": the number after the last printed one.
export function nextTallyNo(last) {
  const m = /^(.*?)(\d+)(\D[^\d]*\d{2}-\d{2})?$/.exec(String(last || "").trim());
  if (!m) return "";
  const n = String(Number(m[2]) + 1).padStart(m[2].length, "0");
  return `${m[1]}${n}${m[3] || ""}`;
}

export default function TallyPrintModal({ invoiceId, onClose, onPrinted }) {
  const { can } = usePermissions();
  const canPrint = can("accounts.invoice-print", "edit");
  const [data, setData] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState("");
  const [dup, setDup] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest(`/accounts/invoices/${invoiceId}/tally`).then((d) => {
      const inv = d.invoice, t = inv.tally_details || {};
      setData(d);
      setF({
        invoice_no: inv.tally_invoice_no || "",
        dated: t.dated || inv.ticket_date,
        buyer_state: t.buyer_state || "Kerala, Code : 32",
        destination: t.destination ?? String(inv.site_name || "").toUpperCase(),
        vehicle_no: t.vehicle_no ?? (inv.truck_number || ""),
        terms_of_delivery: t.terms_of_delivery || "",
        ...Object.fromEntries(BOXES.map(([k]) => [k, t[k] || ""])),
      });
    }).catch((e) => setError(e.message));
  }, [invoiceId]);

  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); if (k === "invoice_no") setDup(null); };

  async function print(force = false) {
    setBusy(true); setError("");
    try {
      const { invoice_no, ...details } = f;
      const r = await apiRequest(`/accounts/invoices/${invoiceId}/tally`, { method: "POST", body: { invoice_no, details, force } });
      const m = await import("../../lib/tallyInvoice.js");
      await m.printTallyInvoice(r.invoice);
      onPrinted?.(r.invoice);
      onClose();
    } catch (e) {
      if (e.status === 409 || /already printed/i.test(e.message)) setDup(e.message);
      else setError(e.message);
    } finally { setBusy(false); }
  }

  const inv = data?.invoice;
  const suggestion = data && !f?.invoice_no ? nextTallyNo(data.last_tally_no) : "";
  return (
    <Modal title={inv ? `Print in Tally format — ${inv.ticket_number}` : "Print in Tally format"} onClose={onClose} width={680}>
      <Banner>{error}</Banner>
      {!f ? <div style={{ fontSize: 13 }}>{error ? "" : "Loading…"}</div> : (
        <form onSubmit={(e) => { e.preventDefault(); print(false); }}>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 12 }}>
            {inv.billing_name || inv.customer_name} · {inv.site_name} · {inv.grade_name} · B2C (no GSTIN) · total ₹{inr2(inv.total_amount)}
            {!inv.gst_applied && <div style={{ color: "var(--amber)", marginTop: 4 }}>GST is off on this invoice in the app. The Tally print still shows CGST and SGST inside the same total, as Tally does.</div>}
          </div>

          <div style={GRID}>
            <label style={LBL}>Tally Invoice No. *
              <input value={f.invoice_no} onChange={set("invoice_no")} required maxLength={40} autoFocus placeholder={suggestion || "e.g. B2C/195/26-27"}
                style={{ fontSize: 15, fontWeight: 700, borderColor: "var(--rebar)", borderWidth: 2 }} />
              <span style={{ fontWeight: 400, fontSize: 11.5 }}>
                Printed instead of the app's number.
                {data.last_tally_no && <> Last Tally print: {data.last_tally_no}{suggestion && <> — <button type="button" onClick={() => setF((x) => ({ ...x, invoice_no: suggestion }))} style={{ padding: "0 6px", fontSize: 11.5 }}>use {suggestion}</button></>}</>}
              </span>
            </label>
            <label style={LBL}>Dated<input type="date" value={f.dated} onChange={set("dated")} /></label>
            <label style={LBL}>Destination<input value={f.destination} onChange={set("destination")} maxLength={60} /></label>
            <label style={LBL}>Motor Vehicle No.<input value={f.vehicle_no} onChange={set("vehicle_no")} maxLength={30} /></label>
            <label style={LBL}>Buyer's State Name<input value={f.buyer_state} onChange={set("buyer_state")} maxLength={60} /></label>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", padding: "8px 0", color: "var(--rebar)", fontWeight: 600, fontSize: 13 }}>Other Tally boxes — print blank if left empty</summary>
            <div style={{ ...GRID, marginTop: 4 }}>
              {BOXES.map(([k, l]) => <label key={k} style={LBL}>{l}<input value={f[k]} onChange={set(k)} maxLength={80} /></label>)}
              <label style={{ ...LBL, gridColumn: "1 / -1" }}>Terms of Delivery<input value={f.terms_of_delivery} onChange={set("terms_of_delivery")} maxLength={80} /></label>
            </div>
          </details>

          {dup && (
            <div role="alert" style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "var(--amber-bg)", fontSize: 13 }}>
              <b>Number already used.</b> {dup} Print with the same number anyway?
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn-danger" disabled={busy} onClick={() => print(true)}>Print anyway</button>
                <button type="button" onClick={() => setDup(null)}>Change the number</button>
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !canPrint || !!dup}>{busy ? "Preparing…" : "Print / PDF"}</button>
          </div>
          {!canPrint && <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 6, textAlign: "right" }}>You can see this but not print — ask for “Print a B2C invoice in the Tally format”.</div>}
        </form>
      )}
    </Modal>
  );
}
