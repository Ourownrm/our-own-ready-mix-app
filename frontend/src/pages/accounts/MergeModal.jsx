// Round 230 — merge a customer / project entered twice. The record the
// orders are on stays; the duplicate (usually made by a quotation or the
// Excel import) is merged into it: every order, invoice, receipt, quotation
// and price-list row moves across and the duplicate is switched off. Either
// name can be kept.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { Banner, Field, Modal } from "./ui.jsx";

const TABLE_LABEL = {
  customer_orders: "orders", invoices: "invoices", quotations: "quotations", rate_master: "price-list rows",
  customer_receipts: "receipts", customer_opening_balances: "opening balances", customer_ledger_corrections: "ledger corrections",
  sites: "projects / sites", bookings: "bookings", customer_billing_addresses: "billing addresses", customer_access_tokens: "sign-in codes",
  customer_booking_links: "booking links", site_contacts: "site contacts", customer_visits: "sales visits", cl_deliveries: "C Ledger deliveries",
  solitaire_dockets: "dockets", customer_payment_aliases: "bank-name aliases", sales_forecasts: "forecasts", notifications: "notices",
};
const describe = (refs) => (refs || []).map((r) => `${r.rows} ${TABLE_LABEL[r.table] || r.table.replace(/_/g, " ")}`).join(" · ") || "nothing else";

// keep  = { customer_id, customer_name, site_id, site_name }   (the record that stays — the orders' one)
// merge = { customer_id, customer_name, site_id, site_name }   (the duplicate)
export default function MergeModal({ keep, merge, onClose, onDone }) {
  const sameCustomer = keep.customer_id === merge.customer_id;
  // Round 231 — the same project, two customers: only the customers merge.
  const sameSite = keep.site_id === merge.site_id;
  const [preview, setPreview] = useState(null);
  // The customer that holds the price list usually has the full, proper name.
  const [keepNames, setKeepNames] = useState(merge.same_site && merge.quotation ? "from" : "to");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const qs = sameSite ? new URLSearchParams() : new URLSearchParams({ from_site_id: merge.site_id, to_site_id: keep.site_id });
    if (!sameCustomer) { qs.set("from_customer_id", merge.customer_id); qs.set("to_customer_id", keep.customer_id); }
    apiRequest(`/accounts/merge/preview?${qs}`).then(setPreview).catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = preview && ((!sameCustomer && !preview.can_merge_customers) || (!sameSite && !preview.can_merge_sites));
  async function go() {
    setBusy(true); setError("");
    try {
      const body = sameSite ? { keep_names: keepNames, note } : { from_site_id: merge.site_id, to_site_id: keep.site_id, keep_names: keepNames, note };
      if (!sameCustomer) Object.assign(body, { from_customer_id: merge.customer_id, to_customer_id: keep.customer_id });
      onDone(await apiRequest("/accounts/merge", { method: "POST", body }));
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const box = { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", fontSize: 13 };
  const sub = { fontSize: 11.5, color: "var(--slate)", marginTop: 4 };
  return (
    <Modal title={sameSite ? "Same customer — merge" : "Same customer and project — merge"} onClose={onClose} width={620}>
      <Banner>{error}</Banner>
      <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 12 }}>
        {sameSite ? "The two customers are merged into one: every order, invoice, receipt, quotation and price list of the other customer moves across, so the held deliveries invoice straight away." : "The duplicate is merged into the record the orders are on. Its quotations and price list move across, so the held deliveries invoice straight away."} This can't be undone.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <div style={box}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: ".04em" }}>Duplicate — merged in</div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>{merge.customer_name}</div>
          <div>{merge.site_name}</div>
          {preview && <div style={sub}>{!sameCustomer && <>Customer: {describe(preview.from_customer?.refs)}<br /></>}{!sameSite && <>Project: {describe(preview.from_site?.refs)}</>}</div>}
        </div>
        <div style={{ fontSize: 20, color: "var(--slate)" }} aria-hidden="true">→</div>
        <div style={{ ...box, borderColor: "var(--signal-green)", background: "var(--signal-green-bg)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: ".04em" }}>Stays — orders are here</div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>{keep.customer_name}</div>
          <div>{keep.site_name}</div>
          {preview && <div style={sub}>{!sameCustomer && <>Customer: {describe(preview.to_customer?.refs)}<br /></>}{!sameSite && <>Project: {describe(preview.to_site?.refs)}</>}</div>}
        </div>
      </div>
      {!sameCustomer && (
        <div style={{ fontSize: 12.5, color: "var(--amber)", marginBottom: 10 }}>
          The customers are merged too: every other project of {merge.customer_name} moves under {keep.customer_name}, with its invoices and receipts.
        </div>
      )}
      <Field label="Names to keep">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" checked={keepNames === "to"} onChange={() => setKeepNames("to")} />{keep.customer_name} · {keep.site_name}</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" checked={keepNames === "from"} onChange={() => setKeepNames("from")} />{merge.customer_name} · {merge.site_name}</label>
        </div>
      </Field>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. quotation made with the full company name" /></Field>
      {blocked && <div style={{ fontSize: 12.5, color: "var(--alert-red)", marginBottom: 8 }}>You don't have the right to merge {!sameCustomer && !preview.can_merge_customers ? "customers" : "projects"} — ask an Administrator.</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !preview || blocked} onClick={go}>{busy ? "Merging…" : "Merge"}</button>
      </div>
    </Modal>
  );
}
