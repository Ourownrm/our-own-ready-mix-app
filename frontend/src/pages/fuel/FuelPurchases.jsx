import { Fragment, useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { useAuth } from "../../lib/AuthContext.jsx";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { fmtL, fmtRs, fmtWhen } from "./fuelUi.jsx";

// Round 199 — diesel purchases, moved here from Store Stock (lubricant
// purchases stay there). Same request → approve → receive flow and the same
// /store-stock endpoints underneath; receiving is still the step that adds
// litres to the tank.

const STATUS = {
  pending: ["Waiting for approval", "badge-warning"],
  approved: ["Approved — awaiting delivery", "badge-info"],
  received: ["Received", "badge-success"],
  rejected: ["Rejected", "badge-danger"],
};
const REQUESTER_ROLES = ["store", "manager", "administrator", "super_admin"];
const APPROVER_ROLES = ["manager", "administrator", "super_admin"];

export default function FuelPurchases() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);           // new request
  const [acting, setActing] = useState(null);       // { id, mode: approve|reject|receive, ...values }
  const role = user?.role;
  const canRequest = can("fuel.purchases", "create") && REQUESTER_ROLES.includes(role);
  const canReceive = can("fuel.purchases", "edit") && REQUESTER_ROLES.includes(role);
  const canApprove = can("store.purchase-approve", "edit") && APPROVER_ROLES.includes(role);
  const canDelete = can("fuel.purchases", "delete") && APPROVER_ROLES.includes(role);

  function load() {
    apiRequest("/fuel-module/purchases").then(setData).catch((e) => setError(e.message));
  }
  useEffect(load, []);

  async function run(fn, done) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(done); setForm(null); setActing(null); load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const submitRequest = () => run(() => apiRequest("/store-stock/purchases", {
    method: "POST", body: { stock_item_id: data.item.id, requested_qty: form.qty, supplier_name: form.supplier, notes: form.notes },
  }), "Purchase requested. The Manager has been notified.");

  function submitAction() {
    const a = acting;
    if (a.mode === "approve") return run(() => apiRequest(`/store-stock/purchases/${a.id}/approve`, { method: "POST", body: { approved_qty: a.qty } }), "Purchase approved.");
    if (a.mode === "reject") return run(() => apiRequest(`/store-stock/purchases/${a.id}/reject`, { method: "POST", body: { reason: a.reason } }), "Purchase rejected.");
    if (a.mode === "receive") return run(() => apiRequest(`/store-stock/purchases/${a.id}/receive`, { method: "POST", body: { received_qty: a.qty, unit_cost: a.rate } }), "Delivery received — the litres are now in the tank.");
    return null;
  }

  if (error && !data) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const open = data.purchases.filter((p) => p.status === "pending" || p.status === "approved");
  const done = data.purchases.filter((p) => p.status === "received" || p.status === "rejected");

  // A plain function, not a component: a component defined inside this one
  // would be a new type every render and remount, losing typing focus.
  const renderRow = (p) => {
    const [label, cls] = STATUS[p.status] || [p.status, "badge-neutral"];
    const isActing = acting?.id === p.id;
    return (
      <>
        <tr>
          <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>FPR-{p.id}</td>
          <td style={{ fontSize: 12 }}>{fmtWhen(p.requested_at)}<div style={{ color: "var(--slate)" }}>{p.requested_by_name}</div></td>
          <td>{p.supplier_name || "—"}{p.notes && <div style={{ fontSize: 11, color: "var(--slate)" }}>{p.notes}</div>}</td>
          <td style={{ textAlign: "right" }}>{fmtL(p.requested_qty)}</td>
          <td style={{ textAlign: "right" }}>{p.approved_qty != null ? fmtL(p.approved_qty) : "—"}</td>
          <td style={{ textAlign: "right" }}>{p.received_qty != null ? fmtL(p.received_qty) : "—"}</td>
          <td style={{ textAlign: "right" }}>{p.unit_cost != null ? `${fmtRs(p.unit_cost, 2)}/L` : "—"}<div style={{ fontSize: 11, color: "var(--slate)" }}>{p.total_cost != null ? fmtRs(p.total_cost) : ""}</div></td>
          <td><span className={`badge ${cls}`}>{label}</span>{p.rejected_reason && <div style={{ fontSize: 11, color: "var(--slate)" }}>{p.rejected_reason}</div>}
            {p.received_at && <div style={{ fontSize: 11, color: "var(--slate)" }}>{fmtWhen(p.received_at)} · {p.received_by_name}</div>}</td>
          <td style={{ whiteSpace: "nowrap" }}>
            {p.status === "pending" && canApprove && <button type="button" style={{ fontSize: 12, padding: "6px 10px", marginRight: 6 }} onClick={() => setActing({ id: p.id, mode: "approve", qty: p.requested_qty })}>Approve</button>}
            {p.status === "pending" && canApprove && <button type="button" style={{ fontSize: 12, padding: "6px 10px", marginRight: 6 }} onClick={() => setActing({ id: p.id, mode: "reject", reason: "" })}>Reject</button>}
            {p.status === "pending" && canDelete && <button type="button" style={{ fontSize: 12, padding: "6px 10px" }} disabled={busy}
              onClick={() => run(() => apiRequest(`/store-stock/purchases/${p.id}`, { method: "DELETE" }), "Request deleted.")}>Delete</button>}
            {p.status === "approved" && canReceive && <button type="button" className="btn-primary" style={{ fontSize: 12, padding: "6px 10px" }}
              onClick={() => setActing({ id: p.id, mode: "receive", qty: p.approved_qty ?? p.requested_qty, rate: data.item.rate_per_liter ?? "" })}>Receive delivery</button>}
          </td>
        </tr>
        {isActing && (
          <tr><td colSpan={9} style={{ background: "#FAF9F6" }}>
            <div className="field-input" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", padding: "6px 0" }}>
              {acting.mode !== "reject" && (
                <label style={{ fontSize: 12, color: "var(--slate)" }}>{acting.mode === "approve" ? "Approved litres" : "Litres received"}
                  <input type="number" min="1" value={acting.qty ?? ""} onChange={(e) => setActing({ ...acting, qty: e.target.value })} style={{ display: "block", marginTop: 4, width: 150 }} />
                </label>
              )}
              {acting.mode === "receive" && (
                <label style={{ fontSize: 12, color: "var(--slate)" }}>Rate paid (₹ per litre)
                  <input type="number" min="0" step="0.01" value={acting.rate ?? ""} onChange={(e) => setActing({ ...acting, rate: e.target.value })} style={{ display: "block", marginTop: 4, width: 150 }} />
                </label>
              )}
              {acting.mode === "reject" && (
                <label style={{ fontSize: 12, color: "var(--slate)", flex: "1 1 260px" }}>Reason
                  <input type="text" value={acting.reason} onChange={(e) => setActing({ ...acting, reason: e.target.value })} style={{ display: "block", marginTop: 4 }} />
                </label>
              )}
              <button type="button" onClick={() => setActing(null)}>Cancel</button>
              <button type="button" className={acting.mode === "reject" ? "btn-danger" : "btn-primary"} disabled={busy} onClick={submitAction}>
                {busy ? "Saving…" : acting.mode === "approve" ? "Approve" : acting.mode === "reject" ? "Reject" : "Confirm receipt"}
              </button>
            </div>
          </td></tr>
        )}
      </>
    );
  };

  const table = (list) => (
    <div style={{ overflowX: "auto" }}>
      <table style={{ minWidth: 960 }}>
        <thead><tr><th>Ref</th><th>Requested</th><th>Supplier</th><th style={{ textAlign: "right" }}>Asked</th><th style={{ textAlign: "right" }}>Approved</th><th style={{ textAlign: "right" }}>Received</th><th style={{ textAlign: "right" }}>Rate</th><th>Status</th><th /></tr></thead>
        <tbody>{list.map((p) => <Fragment key={p.id}>{renderRow(p)}</Fragment>)}</tbody>
      </table>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Diesel purchases</h1>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>In the tank now: <b>{fmtL(data.item.current_qty)}</b> · standing rate {data.item.rate_per_liter != null ? `${fmtRs(data.item.rate_per_liter, 2)}/L` : "not set"}</div>
        </div>
        {canRequest && !form && <button type="button" className="btn-primary" onClick={() => setForm({ qty: "", supplier: "", notes: "" })}>Request purchase</button>}
      </div>

      {notice && <div style={{ background: "var(--signal-green-bg)", color: "var(--signal-green)", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>{notice}</div>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}

      {form && (
        <div className="card field-input" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>Litres to buy
            <input type="number" min="1" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} style={{ display: "block", marginTop: 4, width: 150 }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--slate)", flex: "1 1 200px" }}>Supplier
            <input type="text" value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} style={{ display: "block", marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--slate)", flex: "1 1 240px" }}>Notes
            <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ display: "block", marginTop: 4 }} />
          </label>
          <button type="button" onClick={() => setForm(null)}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy || !(Number(form.qty) > 0)} onClick={submitRequest}>{busy ? "Sending…" : "Send for approval"}</button>
        </div>
      )}

      <section className="card">
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Open <span className="chip" style={{ marginLeft: 6 }}>{open.length}</span></div>
        {open.length ? table(open) : <div style={{ fontSize: 13, color: "var(--slate)" }}>No purchase is waiting.</div>}
      </section>
      <section className="card">
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Last 6 months</div>
        {done.length ? table(done) : <div style={{ fontSize: 13, color: "var(--slate)" }}>No deliveries in the last 6 months.</div>}
      </section>
    </div>
  );
}
