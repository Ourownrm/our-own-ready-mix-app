// Round 208 — print a material order as a purchase order, and the PO settings
// (letterhead addresses, contact, our GSTIN, default terms). The PDF itself is
// lib/purchaseOrderPdf.js.
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { downloadPurchaseOrderPdf, poFigures, poNo, fmtDay } from "../lib/purchaseOrderPdf.js";

const input = { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 9px", border: "1px solid var(--line, #ccc)", borderRadius: 8, font: "inherit" };
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function Sheet({ title, onClose, children }) {
  const downOnBackdrop = useRef(false);
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }}
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-label={title} style={{ background: "#fff", borderRadius: "14px 14px 0 0", padding: 18, width: "100%", maxWidth: 680, maxHeight: "88vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>{title}</div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: "none", background: "none", fontSize: 20, lineHeight: 1, padding: 0, color: "var(--slate)" }}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children, wide }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--slate)", gridColumn: wide ? "1 / -1" : undefined }}>
      {label}
      {children}
      {hint && <span style={{ fontSize: 10.5 }}>{hint}</span>}
    </label>
  );
}

export function PrintPoModal({ orderId, onClose }) {
  const [data, setData] = useState(null);
  const [t, setT] = useState(null);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest(`/material-module/orders/${orderId}/po`)
      .then((d) => { setData(d); setT({ ...d.defaults, ...(d.terms || {}) }); })
      .catch((e) => setError(e.message));
  }, [orderId]);

  async function print(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      if (keep && data.may_save_terms) {
        await apiRequest(`/material-module/orders/${orderId}/po-terms`, { method: "PUT", body: t });
      }
      await downloadPurchaseOrderPdf({ order: data.order, settings: data.settings, terms: t });
      onClose();
    } catch (err) { setError(err.message || "Could not make the PDF."); } finally { setBusy(false); }
  }

  const o = data?.order;
  const fig = o ? poFigures(o, data.settings) : null;
  const draft = o && (o.status === "pending_approval" || !o.approved_day);
  const set = (k) => (e) => setT({ ...t, [k]: e.target.value });

  return (
    <Sheet title={`Print purchase order${o ? ` · ${poNo(o.id)}` : ""}`} onClose={onClose}>
      {error && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
      {!data && !error && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading…</div>}
      {data && t && (
        <form onSubmit={print} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "var(--bg, #F7F5F0)", borderRadius: 8, padding: "9px 11px", fontSize: 12, lineHeight: 1.5 }}>
            <b>{o.supplier_name}</b>{o.supplier_gstin ? ` · GSTIN ${o.supplier_gstin}` : " · no GSTIN on file"} · {o.material_name},{" "}
            {Number(o.ordered_qty).toLocaleString("en-IN")} {o.purchase_unit} @ {money(o.rate)}
            {fig.pct > 0 ? ` · ${fig.interState ? "IGST" : "CGST + SGST"} ${fig.pct}%${fig.included ? " (included in rate)" : ""}` : ""}
            {" "}· total <b>{money(fig.total)}</b>
            {draft
              ? <div style={{ color: "var(--alert-red)", fontWeight: 600 }}>Not approved yet — this prints as a DRAFT.</div>
              : <div>Signed by {o.approved_by_name} (approved {fmtDay(o.approved_day)})</div>}
            {!o.supplier_address && <div style={{ color: "var(--amber, #8A5A00)" }}>The supplier has no address on file — add it in Suppliers so it prints.</div>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            <Field label="Particulars (printed in the item line)" hint="Add a code, grade or HSN on a second line if needed" wide>
              <textarea rows={2} value={t.particulars} onChange={set("particulars")} style={{ ...input, resize: "vertical" }} />
            </Field>
            <Field label="Supplier's quotation ref."><input value={t.quotation_ref} onChange={set("quotation_ref")} style={input} /></Field>
            <Field label="Quotation date"><input type="date" value={t.quotation_date} onChange={set("quotation_date")} style={input} /></Field>
            <Field label="Delivery"><input value={t.delivery} onChange={set("delivery")} style={input} /></Field>
            <Field label="Payment" hint={o.supplier_credit_days != null ? `From the supplier's credit days (${o.supplier_credit_days})` : undefined}>
              <input value={t.payment} onChange={set("payment")} style={input} />
            </Field>
            <Field label="Unloading"><input value={t.unloading} onChange={set("unloading")} style={input} /></Field>
            <Field label="Freight" hint={o.scope === "delivered" ? "Delivered order" : "Ex-factory order"}><input value={t.freight} onChange={set("freight")} style={input} /></Field>
            <Field label="Taxes"><input value={t.taxes} onChange={set("taxes")} style={input} /></Field>
            <Field label="Contact person" hint={!t.contact_person ? `Blank prints ${o.requested_by_name}` : undefined}><input value={t.contact_person} onChange={set("contact_person")} style={input} /></Field>
            <Field label="Cheque no. (advance only)"><input value={t.cheque_no} onChange={set("cheque_no")} style={input} /></Field>
            <Field label="Cheque amount (₹)"><input inputMode="decimal" value={t.cheque_amount} onChange={set("cheque_amount")} style={{ ...input, textAlign: "right" }} /></Field>
            <Field label="Other remarks (one per line)" wide>
              <textarea rows={3} value={t.remarks} onChange={set("remarks")} style={{ ...input, resize: "vertical" }} />
            </Field>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {data.may_save_terms
              ? <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Save these terms with the order (a reprint shows the same)</label>
              : <span style={{ fontSize: 11.5, color: "var(--slate)" }}>Changes here print but are not saved.</span>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Making PDF…" : draft ? "Print draft PO (PDF)" : "Print PO (PDF)"}</button>
            </div>
          </div>
        </form>
      )}
    </Sheet>
  );
}

export function PoSettingsModal({ onClose, onSaved }) {
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/material-module/po-settings")
      .then((s) => setF({ ...s, validity_days: s.validity_days == null ? "" : String(s.validity_days) }))
      .catch((e) => setError(e.message));
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await apiRequest("/material-module/po-settings", { method: "PUT", body: f });
      onSaved && onSaved("Purchase order settings saved.");
      onClose();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Sheet title="Purchase order settings" onClose={onClose}>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Every printed PO uses these. The Print dialog can change the terms for one order. The PO is signed by the Administrator who approved the order.</div>
      {error && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
      {f && (
        <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <Field label="Billing address"><textarea rows={4} value={f.billing_address} onChange={set("billing_address")} style={{ ...input, resize: "vertical" }} /></Field>
          <Field label="Delivery address"><textarea rows={4} value={f.delivery_address} onChange={set("delivery_address")} style={{ ...input, resize: "vertical" }} /></Field>
          <Field label="Contact person" hint="Blank prints whoever raised the order"><input value={f.contact_person} onChange={set("contact_person")} style={input} /></Field>
          <Field label="Contact number"><input value={f.contact_phone} onChange={set("contact_phone")} style={input} /></Field>
          <Field label="Our GST No." hint="Its state code decides CGST + SGST or IGST"><input value={f.our_gstin} onChange={set("our_gstin")} style={input} /></Field>
          <Field label="PO valid for (days)" hint="Blank: no “Valid till” line"><input inputMode="numeric" value={f.validity_days} onChange={set("validity_days")} style={{ ...input, textAlign: "right" }} /></Field>
          <Field label="Default delivery"><input value={f.delivery} onChange={set("delivery")} style={input} /></Field>
          <Field label="Default payment" hint="Used when the supplier has no credit days set"><input value={f.payment} onChange={set("payment")} style={input} /></Field>
          <Field label="Default unloading"><input value={f.unloading} onChange={set("unloading")} style={input} /></Field>
          <Field label="Standard remarks (one per line)" wide><textarea rows={3} value={f.remarks} onChange={set("remarks")} style={{ ...input, resize: "vertical" }} /></Field>
          <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
