// Round 254 — Production → Customers & sites (owner, 31 Oct 2026). The
// customer file with its sites merged in: the customer list on the left
// (a phone shows the list, then the file), and the file — contact, GSTIN,
// balance, sites as cards, billing profiles, site contacts, recent orders.
// Edits use the existing Administrator routes, so their rules hold.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { formatOrderNumber } from "../../lib/orderNumber.js";
import { Modal } from "../accounts/ui.jsx";
import MergeModal from "../accounts/MergeModal.jsx";
import { CustomerBillingAddressesEditor, SiteMismatchReview, DuplicateSitesReview } from "../../lib/MasterDataPanels.jsx";
import { OrderStatus } from "./OrdersTab.jsx";

const sub = { fontSize: 12, color: "var(--slate)" };
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const L = { ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 };

function useNarrow() {
  const q = "(max-width: 760px)";
  const [n, setN] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setN(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return n;
}

export default function CustomersTab({ go, params }) {
  const { can } = usePermissions();
  const canEdit = can("masters.customers", "edit");
  const canCreate = can("masters.customers", "create");
  const canSites = can("masters.sites", "edit");
  const narrow = useNarrow();
  const [list, setList] = useState(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState("active");
  const [selId, setSelId] = useState(params.get("customer") ? Number(params.get("customer")) : null);
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(null); // {kind, ...}

  async function loadList() {
    try { setList(await apiRequest("/production/customers")); } catch (e) { setError(e.message); }
  }
  async function loadFile(id = selId) {
    if (!id) return setFile(null);
    try { setFile(await apiRequest(`/production/customers/${id}`)); } catch (e) { setError(e.message); }
  }
  useEffect(() => { loadList(); }, []);
  useEffect(() => { setFile(null); loadFile(); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!narrow && !selId && list?.length) setSelId(list.find((c) => c.is_active)?.id || list[0].id); }, [list, narrow]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list || []).filter((c) => (show === "all" || (show === "active" ? c.is_active : !c.is_active))
      && (!s || [c.name, c.contact_number].some((v) => String(v || "").toLowerCase().includes(s))));
  }, [list, q, show]);

  function done(msg) { setModal(null); setNotice(msg); loadList(); loadFile(); }
  async function toggleCustomer() {
    const c = file.customer;
    if (!window.confirm(`${c.is_active ? "Disable" : "Enable"} ${c.name}?${c.is_active ? " New orders can't be taken for a disabled customer." : ""}`)) return;
    try { await apiRequest(`/administrator/customers/${c.id}/status`, { method: "POST", body: { is_active: !c.is_active } }); done(`${c.name} ${c.is_active ? "disabled" : "enabled"}.`); } catch (e) { setError(e.message); }
  }
  async function toggleSite(s) {
    if (!window.confirm(`${s.is_active ? "Disable" : "Enable"} site ${s.name}?`)) return;
    try { await apiRequest(`/administrator/sites/${s.id}/status`, { method: "POST", body: { is_active: !s.is_active } }); done(`${s.name} ${s.is_active ? "disabled" : "enabled"}.`); } catch (e) { setError(e.message); }
  }
  async function retireContact(c) {
    if (!window.confirm(`Remove ${c.contact_name} from the site contacts?`)) return;
    try { await apiRequest(`/administrator/site-contacts/${c.id}`, { method: "PATCH", body: { is_active: false } }); done(`${c.contact_name} removed.`); } catch (e) { setError(e.message); }
  }

  const listPane = (
    <aside className="card" style={{ flex: "1 1 300px", minWidth: 0, padding: 0, overflow: "hidden", alignSelf: "flex-start" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <b style={{ fontSize: 15 }}>Customers · {shown.length}</b>
          {canCreate && <button type="button" className="btn-primary" onClick={() => setModal({ kind: "customer" })}>+ New</button>}
        </div>
        <input aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" />
        <div style={{ display: "flex", gap: 6 }}>
          {[["active", "Active"], ["disabled", "Disabled"], ["all", "All"]].map(([k, l]) => (
            <button key={k} type="button" className={`btn-tab ${show === k ? "active" : ""}`} onClick={() => setShow(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ maxHeight: narrow ? undefined : 640, overflowY: "auto" }}>
        {shown.map((c) => {
          const on = c.id === selId;
          return (
            <button key={c.id} type="button" onClick={() => setSelId(c.id)}
              style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderBottom: "1px solid var(--border)", borderRadius: 0, background: on ? "#FBEDE3" : "#fff", boxShadow: on ? "inset 3px 0 0 var(--rebar)" : undefined, padding: "12px 14px", minHeight: 44, color: "var(--charcoal)", font: "inherit", opacity: c.is_active ? 1 : 0.65 }}>
              <b>{c.name}</b>
              <div style={sub}>{c.sites} site{c.sites === 1 ? "" : "s"} · {c.balance > 0.5 ? `balance ${money(c.balance)}` : c.advance > 0.5 ? `advance ${money(c.advance)}` : "nothing due"}</div>
            </button>
          );
        })}
        {list && shown.length === 0 && <div style={{ padding: 14, ...sub }}>No customers.</div>}
      </div>
      {canSites && (
        <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); setModal({ kind: "duplicates" }); }}>Check for duplicate sites</a>
          <a href="#" onClick={(e) => { e.preventDefault(); setModal({ kind: "mismatch" }); }}>Check for wrong-customer orders</a>
        </div>
      )}
    </aside>
  );

  const filePane = file && (
    <main style={{ flex: "999 1 620px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
      {narrow && <button type="button" onClick={() => setSelId(null)} style={{ alignSelf: "flex-start" }}>← All customers</button>}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 21 }}>{file.customer.name} <span className={`badge ${file.customer.is_active ? "badge-success" : "badge-neutral"}`} style={{ verticalAlign: "middle" }}>{file.customer.is_active ? "Active" : "Disabled"}</span></h2>
            <div style={{ ...sub, marginTop: 4 }}>Customer since {new Date(file.customer.created_at).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}{file.customer.code ? ` · code ${file.customer.code}` : ""}</div>
          </div>
          {canEdit && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setModal({ kind: "customer", c: file.customer })}>Edit</button>
              <button type="button" onClick={toggleCustomer}>{file.customer.is_active ? "Disable" : "Enable"}</button>
              {file.can_merge && <button type="button" onClick={() => setModal({ kind: "merge-pick" })}>Merge into…</button>}
            </div>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 14, fontSize: 13.5 }}>
          <KV k="Contact" v={file.customer.contact_number ? <a href={`tel:${file.customer.contact_number}`}>{file.customer.contact_number}</a> : "—"} />
          <KV k="GSTIN" v={file.customer.gstin || "—"} />
          <KV k="Billing address" v={file.customer.billing_address || "—"} wide />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 14 }}>
          <Stat k={file.balance >= 0 ? "Balance due" : "Advance"} v={money(Math.abs(file.balance))} red={file.balance > 0.5 && file.oldest_due_days > 30} note={file.balance > 0.5 && file.oldest_due_days != null ? `oldest ${file.oldest_due_days} days` : null} />
          <Stat k="This month" v={`${file.month_m3} m³`} />
          <Stat k="Last order" v={file.orders[0]?.order_date || "—"} />
          <Stat k="PDCs in hand" v={money(file.pdc.amount)} note={file.pdc.n ? `${file.pdc.n} cheque${file.pdc.n === 1 ? "" : "s"}` : null} />
        </div>
      </section>

      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <b style={{ fontSize: 15 }}>Sites · {file.sites.filter((s) => s.is_active !== false).length}</b>
          {canSites && <button type="button" onClick={() => setModal({ kind: "site" })}>+ Add site</button>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
          {file.sites.map((s) => {
            const off = s.is_active === false;
            return (
              <div key={s.id} style={{ border: `1px ${off ? "dashed" : "solid"} var(--border${off ? "-strong" : ""})`, borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6, opacity: off ? 0.7 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><b>{s.name}</b><span className={`badge ${off ? "badge-neutral" : "badge-success"}`}>{off ? "Disabled" : "Active"}</span></div>
                {s.address && <div style={sub}>{s.address}</div>}
                {!off && (
                  <div style={{ fontSize: 13, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "4px 10px" }}>
                    <span>{s.distance_from_plant_km != null ? `${Number(s.distance_from_plant_km)} km` : <span style={{ color: "var(--amber)" }}>no distance</span>}{s.trip_allowance_label ? ` · ${s.trip_allowance_label}` : ""}</span>
                    <span style={s.has_location ? undefined : { color: "var(--amber)" }}>{s.has_location ? `Geofence ✓ ${s.geofence_radius_m || 150} m` : "No geofence — set"}</span>
                    <span style={s.salesperson_name ? undefined : { color: "var(--amber)" }}>Sales: {s.salesperson_name || "unassigned"}</span>
                    <span>Grace: {s.plant_out_grace_minutes ? `${s.plant_out_grace_minutes} min` : "default"}</span>
                  </div>
                )}
                <div style={sub}>{s.price_grades ? `Price list: ${s.price_grades}` : "No price list"}{s.last_order ? ` · last order ${s.last_order}` : ""}</div>
                {canSites && (
                  <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    {!off && <button type="button" onClick={() => setModal({ kind: "site", s })}>Edit</button>}
                    {!off && <button type="button" onClick={() => go("orders", { view: "past", customer: String(file.customer.id) })}>Orders</button>}
                    <button type="button" onClick={() => toggleSite(s)}>{off ? "Enable" : "Disable"}</button>
                  </div>
                )}
              </div>
            );
          })}
          {file.sites.length === 0 && <div style={sub}>No sites yet.</div>}
        </div>
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <section className="card" style={{ flex: "1 1 300px", minWidth: 0, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <b style={{ fontSize: 15 }}>Billing profiles</b>
            {canEdit && <button type="button" onClick={() => setModal({ kind: "billing" })}>Manage</button>}
          </div>
          {file.billing.filter((b) => b.is_active).map((b) => (
            <div key={b.id} style={{ fontSize: 13, borderTop: "1px solid var(--border)", padding: "8px 0" }}>
              <b>{b.name}</b>{b.is_default ? " (default)" : ""}<div style={sub}>{[b.gstin, b.address].filter(Boolean).join(" · ") || "—"}</div>
            </div>
          ))}
          {!file.billing.some((b) => b.is_active) && <div style={sub}>Billed in the customer's own name.</div>}
        </section>
        <section className="card" style={{ flex: "1 1 300px", minWidth: 0, padding: 16 }}>
          <div style={{ marginBottom: 8 }}><b style={{ fontSize: 15 }}>Site contacts</b> <span style={sub}>· added from New order</span></div>
          {file.contacts.map((c) => (
            <div key={c.id} style={{ fontSize: 13, borderTop: "1px solid var(--border)", padding: "8px 0", display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span><b>{c.contact_name}</b>{c.role_label ? ` · ${c.role_label}` : ""}<div style={sub}>{c.site_name}</div></span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}><a href={`tel:${c.phone_number}`}>{c.phone_number}</a>{canEdit && <button type="button" aria-label={`Remove ${c.contact_name}`} onClick={() => retireContact(c)} style={{ padding: "2px 8px" }}>✕</button>}</span>
            </div>
          ))}
          {file.contacts.length === 0 && <div style={sub}>None on file.</div>}
        </section>
      </div>

      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <b style={{ fontSize: 15 }}>Recent orders</b>
          <a href="#" style={{ fontSize: 13 }} onClick={(e) => { e.preventDefault(); go("orders", { view: "past", customer: String(file.customer.id) }); }}>All orders of this customer →</a>
        </div>
        {file.orders.map((o) => (
          <div key={o.id} style={{ fontSize: 13, borderTop: "1px solid var(--border)", padding: "8px 0", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <a href="#" onClick={(e) => { e.preventDefault(); go("orders", { edit: String(o.id) }); }} style={{ color: "var(--charcoal)", textDecoration: "none" }}>{o.order_date} · {formatOrderNumber(o.id)} · {o.site_name} · {o.mix_grade_name}</a>
            <span>{o.supplied} / {o.order_quantity_m3} m³ · <OrderStatus o={o} /></span>
          </div>
        ))}
        {file.orders.length === 0 && <div style={sub}>No orders yet.</div>}
      </section>
    </main>
  );

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 10, color: "var(--alert-red)", background: "var(--alert-red-bg)", fontSize: 13 }}>{error} <button type="button" onClick={() => setError("")} style={{ marginLeft: 8, padding: "2px 8px" }}>✕</button></div>}
      {notice && <div className="card" style={{ marginBottom: 10, color: "var(--signal-green)", background: "var(--signal-green-bg)", fontSize: 13 }}>{notice}</div>}
      {modal?.kind === "duplicates" && <DuplicateSitesReview setError={setError} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "mismatch" && <SiteMismatchReview setError={setError} onClose={() => setModal(null)} onDone={done} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        {(!narrow || !selId) && listPane}
        {(!narrow || selId) && (filePane || (selId && <div className="card" style={{ flex: "999 1 620px", ...sub }}>Loading…</div>))}
      </div>

      {modal?.kind === "customer" && <CustomerForm c={modal.c} setError={setError} onClose={() => setModal(null)} onDone={(msg, id) => { if (id) setSelId(id); done(msg); }} />}
      {modal?.kind === "site" && file && <SiteForm s={modal.s} customerId={file.customer.id} setError={setError} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "billing" && file && (
        <Modal title={`Billing profiles — ${file.customer.name}`} width={720} onClose={() => { setModal(null); loadFile(); }}>
          <CustomerBillingAddressesEditor customerId={file.customer.id} setError={setError} />
        </Modal>
      )}
      {modal?.kind === "merge-pick" && file && (
        <MergePick list={list} from={file.customer} onClose={() => setModal(null)} onPick={(to) => setModal({ kind: "merge", to })} />
      )}
      {modal?.kind === "merge" && file && (
        <MergeModal
          keep={{ customer_id: modal.to.id, customer_name: modal.to.name, site_id: 0, site_name: "" }}
          merge={{ customer_id: file.customer.id, customer_name: file.customer.name, site_id: 0, site_name: "" }}
          onClose={() => setModal(null)}
          onDone={(r) => { setSelId(modal.to.id); done(`Merged ${r.customer?.from || file.customer.name} into ${r.customer?.to || modal.to.name}.`); }} />
      )}
    </>
  );
}

function KV({ k, v, wide }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 2, gridColumn: wide ? "span 2" : undefined }}><span style={sub}>{k}</span><span>{v}</span></div>;
}
function Stat({ k, v, note, red }) {
  return (
    <div style={{ background: red ? "var(--alert-red-bg)" : "var(--concrete)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ ...sub, color: red ? "var(--alert-red)" : sub.color }}>{k}</div><b style={{ color: red ? "var(--alert-red)" : undefined }}>{v}</b>
      {note && <div style={sub}>{note}</div>}
    </div>
  );
}

function CustomerForm({ c, setError, onClose, onDone }) {
  const [f, setF] = useState({ name: c?.name || "", contact_number: c?.contact_number || "", billing_address: c?.billing_address || "" });
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      if (c) { await apiRequest(`/administrator/customers/${c.id}`, { method: "PATCH", body: f }); onDone(`${f.name} saved.`); }
      else { const r = await apiRequest("/administrator/customers", { method: "POST", body: f }); onDone(`${f.name} added.`, r?.id); }
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={c ? `Edit ${c.name}` : "New customer"} onClose={onClose}>
      <form onSubmit={save}>
        <label style={L}>Name<input value={f.name} required onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label style={L}>Contact number<input value={f.contact_number} onChange={(e) => setF({ ...f, contact_number: e.target.value })} /></label>
        <label style={L}>Billing address<textarea rows={3} value={f.billing_address} onChange={(e) => setF({ ...f, billing_address: e.target.value })} /></label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
      </form>
    </Modal>
  );
}

function SiteForm({ s, customerId, setError, onClose, onDone }) {
  const [f, setF] = useState({
    name: s?.name || "", address: s?.address || "", distance_from_plant_km: s?.distance_from_plant_km ?? "", trip_allowance_category_id: s?.trip_allowance_category_id || "",
    latitude: s?.latitude ?? "", longitude: s?.longitude ?? "", plant_out_grace_minutes: s?.plant_out_grace_minutes ?? "",
    assigned_sales_representative_id: s?.assigned_sales_representative_id || "",
  });
  const [cats, setCats] = useState([]);
  const [sps, setSps] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiRequest("/master/trip-allowance-categories").then(setCats).catch(() => {});
    apiRequest("/master/salespersons").then(setSps).catch(() => {});
  }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  function here() {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setF((x) => ({ ...x, latitude: pos.coords.latitude.toFixed(7), longitude: pos.coords.longitude.toFixed(7) })),
      () => setError("Couldn't get the location — allow location access, or type the coordinates."),
    );
  }
  async function save(e, force = false) {
    e?.preventDefault();
    setBusy(true); setError("");
    try {
      if (s) {
        const { assigned_sales_representative_id, ...body } = f;
        await apiRequest(`/administrator/sites/${s.id}`, { method: "PATCH", body });
        if (assigned_sales_representative_id && String(assigned_sales_representative_id) !== String(s.assigned_sales_representative_id || "")) {
          await apiRequest(`/sales/sites/${s.id}/assign-salesperson`, { method: "POST", body: { salesperson_id: assigned_sales_representative_id } });
        }
        onDone(`${f.name} saved.`);
      } else {
        await apiRequest("/administrator/sites", { method: "POST", body: { ...f, customer_id: customerId, force: force || undefined } });
        onDone(`${f.name} added.`);
      }
    } catch (err) {
      setBusy(false);
      if (err.status === 409 && !s && window.confirm(`${err.message}\n\nAdd it anyway?`)) return save(null, true);
      if (err.status !== 409) setError(err.message);
    }
  }
  const G = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0 12px" };
  return (
    <Modal title={s ? `Edit site — ${s.name}` : "Add site"} width={640} onClose={onClose}>
      <form onSubmit={save}>
        <label style={L}>Site / project name<input value={f.name} required onChange={(e) => set("name", e.target.value)} /></label>
        <label style={L}>Address<input value={f.address} onChange={(e) => set("address", e.target.value)} /></label>
        <div style={G}>
          <label style={L}>Distance from plant (km)<input type="number" step="0.1" value={f.distance_from_plant_km} onChange={(e) => set("distance_from_plant_km", e.target.value)} /></label>
          <label style={L}>Trip allowance category
            <select value={f.trip_allowance_category_id} onChange={(e) => set("trip_allowance_category_id", e.target.value)}>
              <option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select></label>
          <label style={L}>Latitude<input value={f.latitude} onChange={(e) => set("latitude", e.target.value)} /></label>
          <label style={L}>Longitude<input value={f.longitude} onChange={(e) => set("longitude", e.target.value)} /></label>
          <label style={L}>Plant-out grace (min)<input type="number" value={f.plant_out_grace_minutes} placeholder="default" onChange={(e) => set("plant_out_grace_minutes", e.target.value)} /></label>
          <label style={L}>Sales person
            <select value={f.assigned_sales_representative_id} onChange={(e) => set("assigned_sales_representative_id", e.target.value)}>
              <option value="">Unassigned</option>{sps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        </div>
        <button type="button" onClick={here} style={{ marginBottom: 12 }}>📍 Set location here (I'm at the site)</button>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
      </form>
    </Modal>
  );
}

function MergePick({ list, from, onClose, onPick }) {
  const [q, setQ] = useState("");
  const rows = (list || []).filter((c) => c.id !== from.id && c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30);
  return (
    <Modal title={`Merge ${from.name} into…`} onClose={onClose}>
      <div style={{ ...sub, marginBottom: 8 }}>Pick the customer that stays. Every site, order, invoice and receipt of {from.name} moves to it.</div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer" style={{ width: "100%", marginBottom: 8 }} />
      {rows.map((c) => (
        <button key={c.id} type="button" onClick={() => onPick(c)} style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 4 }}>
          <b>{c.name}</b> <span style={sub}>· {c.sites} site{c.sites === 1 ? "" : "s"}</span>
        </button>
      ))}
    </Modal>
  );
}
