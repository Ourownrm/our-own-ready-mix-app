// Round 210 — Sales contacts: the people a Sales Executive meets who are not
// (yet) customers — site engineers, clients, consultants, contractors. Kept
// in the Sales module (sales_contacts), not in the customer master.
import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

const fmtDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "");

// Round 210 — Sales contacts (people met who are not customers).
export const CONTACT_TYPE_LABEL = { client: "Client", site_engineer: "Site engineer", consultant: "Consultant", contractor: "Contractor", architect: "Architect", builder: "Builder", other: "Other" };
export const VISITOR_TYPES_FOR_CONTACT = { client: "client", site_engineer: "site_engineer", consultant: "consultant", contractor: "other", architect: "consultant", builder: "customer", other: "other" };

export function NewContactForm({ initialName = "", onSaved, onCancel }) {
  const [f, setF] = useState({ name: initialName, contact_type: "site_engineer", organisation: "", phone: "", notes: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(force = false) {
    setBusy(true); setError("");
    try {
      onSaved(await apiRequest("/sales/contacts", { method: "POST", body: { ...f, force } }));
    } catch (err) {
      if (err.status === 409 && err.data?.existing) {
        if (window.confirm(`${err.message}\n\nOK = use that contact · Cancel = add a new one anyway`)) {
          const all = await apiRequest("/sales/contacts");
          const ex = all.find((c) => c.id === err.data.existing.id);
          if (ex) { onSaved(ex); return; }
        } else { await save(true); return; }
      }
      setError(err.message);
    } finally { setBusy(false); }
  }
  return (
    <div onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
      style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginTop: 6, display: "flex", flexDirection: "column", gap: 6, background: "var(--concrete)" }}>
      <div style={{ fontWeight: 600 }}>New sales contact</div>
      <div style={{ fontSize: 11, color: "var(--slate)" }}>Kept in the Sales module — not added to the customer master.</div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12 }}>{error}</div>}
      <input placeholder="Name of the person" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select value={f.contact_type} onChange={(e) => setF({ ...f, contact_type: e.target.value })}>
        {Object.entries(CONTACT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <input placeholder="Company / firm / project (optional)" value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value.toUpperCase() })} />
      <input placeholder="Phone" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" onClick={onCancel} style={{ fontSize: 12 }}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !f.name.trim()} onClick={() => save(false)} style={{ fontSize: 12 }}>{busy ? "Saving…" : "Save contact"}</button>
      </div>
    </div>
  );
}


// The list — a Sales Executive sees and adds; Manager / Administrator can
// also link a contact to its customer, or set it inactive.
export function ContactsList({ canLink = false, customers = [], compact = false }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  function load() { apiRequest("/sales/contacts").then(setRows).catch((e) => setError(e.message)); }
  useEffect(() => { load(); }, []);
  async function patch(id, body) {
    setBusy(id); setError("");
    try { await apiRequest(`/sales/contacts/${id}`, { method: "PATCH", body }); load(); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }
  const needle = q.trim().toLowerCase();
  const list = (rows || []).filter((r) => (!type || r.contact_type === type)
    && (!needle || `${r.name} ${r.organisation || ""} ${r.phone || ""} ${r.linked_customer_name || ""}`.toLowerCase().includes(needle)));
  return (
    <div className="card" style={{ fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 600 }}>Sales contacts {rows && <span className="badge badge-neutral">{rows.length}</span>}</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>People met on visits — kept here, not in the customer master.</div>
        </div>
        {!adding && <button type="button" onClick={() => setAdding(true)} style={{ fontSize: 12 }}>+ New contact</button>}
      </div>
      {adding && <NewContactForm onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12, margin: "6px 0" }}>{error}</div>}
      <div className="field-input" style={{ display: "flex", gap: 6, margin: "8px 0", flexWrap: "wrap" }}>
        <input placeholder="Search name, firm, phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 180px" }} />
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ flex: "0 1 160px" }}>
          <option value="">All types</option>
          {Object.entries(CONTACT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {!rows ? <div style={{ color: "var(--slate)" }}>Loading…</div> : !list.length ? <div style={{ color: "var(--slate)" }}>No contacts{rows.length ? " match" : " yet"}.</div> : compact ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((r) => (
            <div key={r.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b>{r.name}</b>
                <span className="badge badge-neutral" style={{ flex: "none" }}>{CONTACT_TYPE_LABEL[r.contact_type] || r.contact_type}</span>
              </div>
              {r.organisation && <div style={{ fontSize: 12 }}>{r.organisation}</div>}
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>
                {r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : "no phone"} · {r.visit_count} visit{r.visit_count === 1 ? "" : "s"}{r.last_visit_date ? `, last ${fmtDay(r.last_visit_date)}` : ""}
                {r.linked_customer_name ? ` · ${r.linked_customer_name}` : ""}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 13, width: "100%" }}>
            <thead><tr><th>Name</th><th>Type</th><th>Firm / project</th><th>Phone</th><th>Visits</th><th>Customer</th>{canLink && <th></th>}</tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b>{r.created_by_name && <div style={{ fontSize: 11, color: "var(--slate)" }}>added by {r.created_by_name}</div>}</td>
                  <td>{CONTACT_TYPE_LABEL[r.contact_type] || r.contact_type}</td>
                  <td>{r.organisation || "—"}</td>
                  <td>{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : "—"}</td>
                  <td>{r.visit_count}{r.last_visit_date ? <div style={{ fontSize: 11, color: "var(--slate)" }}>last {fmtDay(r.last_visit_date)}</div> : null}</td>
                  <td>
                    {canLink ? (
                      <select value={r.linked_customer_id || ""} disabled={busy === r.id} style={{ fontSize: 12, maxWidth: 200 }}
                        onChange={(e) => patch(r.id, { linked_customer_id: e.target.value || null })}>
                        <option value="">Not linked</option>
                        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    ) : (r.linked_customer_name || "—")}
                  </td>
                  {canLink && <td><button type="button" style={{ fontSize: 11, padding: "3px 8px" }} disabled={busy === r.id} onClick={() => { if (window.confirm(`Remove ${r.name} from Sales contacts? Their past visits stay.`)) patch(r.id, { is_active: false }); }}>Remove</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Customers that were only ever people met on visits — nothing against them
// but visits (no order, quotation, price, invoice, booking …). Manager /
// Administrator can move each to Sales contacts; its visits move with it.
export function CustomerCleanup({ onMoved }) {
  const [rows, setRows] = useState(null);
  const [types, setTypes] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  function load() { apiRequest("/sales/customer-cleanup").then(setRows).catch((e) => setError(e.message)); }
  useEffect(() => { load(); }, []);
  async function move(r) {
    if (!window.confirm(`Move "${r.name}" out of the customer master into Sales contacts?${r.site_count ? ` Its ${r.site_count} empty site(s) are removed.` : ""}`)) return;
    setBusy(r.id); setError(""); setMsg("");
    try {
      const res = await apiRequest(`/sales/customer-cleanup/${r.id}/move`, { method: "POST", body: { contact_type: types[r.id] || guessType(r) } });
      setMsg(`${r.name} moved to Sales contacts (${res.visits_moved} visit${res.visits_moved === 1 ? "" : "s"}).`);
      load(); onMoved?.();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }
  if (!rows || !rows.length) return null;
  return (
    <div className="card" style={{ marginBottom: 20, borderLeft: "3px solid var(--amber)", fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <div style={{ fontWeight: 600 }}>Customers with no business yet <span className="badge badge-warning">{rows.length}</span></div>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>{open ? "Hide ▴" : "Show ▾"}</span>
      </div>
      {open && <>
        <div style={{ fontSize: 12, color: "var(--slate)", margin: "6px 0 10px" }}>
          In the customer master with nothing against them except visits — no order, quotation, price, invoice or booking.
          Many were added from sales visits (a site engineer, a client …). Move those to Sales contacts; real customers can stay.
        </div>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
        {msg && <div style={{ color: "var(--signal-green)", fontSize: 12, marginBottom: 8 }}>{msg}</div>}
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 13, width: "100%" }}>
            <thead><tr><th>Name</th><th>Added</th><th>Visits</th><th>Sites</th><th>Move as</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b>{r.created_via === "sales" && <span className="badge badge-info" style={{ marginLeft: 6 }}>from Sales</span>}{r.is_active === false && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>disabled</span>}</td>
                  <td>{r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</td>
                  <td>{r.visit_count}{r.last_visit_date ? <div style={{ fontSize: 11, color: "var(--slate)" }}>last {fmtDay(r.last_visit_date)}</div> : null}</td>
                  <td>{r.site_count}</td>
                  <td>
                    <select value={types[r.id] || guessType(r)} onChange={(e) => setTypes((t) => ({ ...t, [r.id]: e.target.value }))} style={{ fontSize: 12 }}>
                      {Object.entries(CONTACT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td><button type="button" disabled={busy === r.id} onClick={() => move(r)} style={{ fontSize: 12, padding: "3px 8px" }}>{busy === r.id ? "…" : "Move to contacts"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
    </div>
  );
}

function guessType(r) {
  return { site_engineer: "site_engineer", client: "client", consultant: "consultant" }[r.last_visitor_type] || "other";
}
