import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { List, CustomersPanel, SitesPanel, RatesPanel } from "../lib/MasterDataPanels.jsx";

const ROLES = ["administrator", "manager", "plant_operator", "qc_engineer", "driver", "site_supervisor", "accountant"];

export default function Administrator() {
  const [view, setView] = useState("users"); // users | customers | sites | trucks | rates
  const [error, setError] = useState("");

  return (
    <>
      <TopBar title="Administrator" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          ["users", "Users and roles"],
          ["customers", "Customers"],
          ["sites", "Projects and sites"],
          ["trucks", "Trucks and fleet"],
          ["pumps", "Pumps"],
          ["rates", "Concrete grades and rates"],
          ["orders", "Correct orders"],
          ["tickets", "Correct tickets"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`btn-tab ${view === key ? "active" : ""}`}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "users" && <UsersPanel setError={setError} />}
      {view === "customers" && <CustomersPanel setError={setError} />}
      {view === "sites" && <SitesPanel setError={setError} />}
      {view === "trucks" && <TrucksPanel setError={setError} />}
      {view === "pumps" && <PumpsPanel setError={setError} />}
      {view === "rates" && <RatesPanel setError={setError} />}
      {view === "orders" && <OrdersPanel setError={setError} />}
      {view === "tickets" && <TicketsPanel setError={setError} />}
    </div>
    </>
  );
}

function UsersPanel({ setError }) {
  const [users, setUsers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", password: "", role: "driver" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setUsers(await apiRequest("/administrator/users")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function addUser(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/users", { method: "POST", body: form });
      setForm({ name: "", phone: "", email: "", password: "", role: "driver" });
      setShowAdd(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(u) {
    try {
      await apiRequest(`/administrator/users/${u.id}/status`, { method: "PATCH", body: { is_active: !u.is_active } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.phone}</td>
              <td>{u.role.replace("_", " ")}</td>
              <td><span className={`badge ${u.is_active ? "badge-success" : "badge-neutral"}`}>{u.is_active ? "Active" : "Disabled"}</span></td>
              <td>
                <button onClick={() => toggleStatus(u)}>{u.is_active ? "Disable" : "Enable"}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)}>Add user</button>
      ) : (
        <form onSubmit={addUser} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
          <div><div style={{ color: "var(--slate)" }}>Name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Phone</div><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Email (optional)</div><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><div style={{ color: "var(--slate)" }}>Temporary password</div><input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></div>
          <div>
            <div style={{ color: "var(--slate)" }}>Role</div>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
            <button type="submit" disabled={saving}>{saving ? "Saving..." : "Create user"}</button>
            <button type="button" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function TrucksPanel({ setError }) {
  const [trucks, setTrucks] = useState([]);
  const [form, setForm] = useState({ truck_number: "", capacity_m3: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setTrucks(await apiRequest("/master/trucks")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/trucks", { method: "POST", body: form });
      setForm({ truck_number: "", capacity_m3: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      <List rows={trucks} columns={[["truck_number", "Truck number"], ["capacity_m3", "Capacity (m³)"]]} />
      <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginTop: 12 }}>
        <div><div style={{ color: "var(--slate)" }}>Truck number</div><input value={form.truck_number} onChange={(e) => setForm({ ...form, truck_number: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Capacity (m³)</div><input type="number" value={form.capacity_m3} onChange={(e) => setForm({ ...form, capacity_m3: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add truck"}</button></div>
      </form>
    </div>
  );
}

function PumpsPanel({ setError }) {
  const [pumps, setPumps] = useState([]);
  const [form, setForm] = useState({ pump_code: "", pump_type: "line_pump" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setPumps(await apiRequest("/master/pumps")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/pumps", { method: "POST", body: form });
      setForm({ pump_code: "", pump_type: "line_pump" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      <List rows={pumps} columns={[["pump_code", "Pump"], ["pump_type", "Type"]]} />
      <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginTop: 12 }}>
        <div><div style={{ color: "var(--slate)" }}>Pump code</div><input value={form.pump_code} onChange={(e) => setForm({ ...form, pump_code: e.target.value })} placeholder="e.g. Line-3" required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Type</div>
          <select value={form.pump_type} onChange={(e) => setForm({ ...form, pump_type: e.target.value })}>
            <option value="line_pump">Line pump</option>
            <option value="boom_pump">Boom pump</option>
          </select>
        </div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add pump"}</button></div>
      </form>
    </div>
  );
}

function OrdersPanel({ setError }) {
  const [orders, setOrders] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ order_quantity_m3: "", scheduled_batching_time: "", remarks: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setOrders(await apiRequest("/administrator/orders")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function startEdit(o) {
    setEditing(o.id);
    setForm({ order_quantity_m3: o.order_quantity_m3, scheduled_batching_time: o.scheduled_batching_time || "", remarks: "" });
  }

  async function saveEdit(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/administrator/orders/${id}`, { method: "PATCH", body: form });
      setEditing(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function cancelOrder(id) {
    if (!confirm("Cancel this order? It will no longer show as active, but stays on record.")) return;
    try {
      await apiRequest(`/administrator/orders/${id}/cancel`, { method: "POST" });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr><th>Date</th><th>Customer</th><th>Site</th><th>Grade</th><th>Qty (m³)</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>{new Date(o.order_date).toLocaleDateString()}</td>
              <td>{o.customer_name}</td>
              <td>{o.site_name}</td>
              <td>{o.mix_grade_name}</td>
              <td>
                {editing === o.id ? (
                  <input type="number" value={form.order_quantity_m3} onChange={(e) => setForm({ ...form, order_quantity_m3: e.target.value })} style={{ width: 70 }} />
                ) : o.order_quantity_m3}
              </td>
              <td><span className={`badge ${o.status === "cancelled" ? "badge-danger" : "badge-neutral"}`}>{o.status.replace("_", " ")}</span></td>
              <td>
                {o.status !== "cancelled" && (
                  editing === o.id ? (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => saveEdit(o.id)} disabled={saving}>Save</button>
                      <button onClick={() => setEditing(null)}>Cancel</button>
                    </span>
                  ) : (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => startEdit(o)}>Edit</button>
                      <button className="btn-danger" onClick={() => cancelOrder(o.id)}>Cancel order</button>
                    </span>
                  )
                )}
              </td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={7} style={{ color: "var(--slate)" }}>No orders yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function TicketsPanel({ setError }) {
  const [tickets, setTickets] = useState([]);
  const [editing, setEditing] = useState(null);
  const [qty, setQty] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setTickets(await apiRequest("/administrator/tickets")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function saveEdit(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/administrator/tickets/${id}`, { method: "PATCH", body: { loaded_quantity_m3: qty } });
      setEditing(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function cancelTicket(id) {
    if (!confirm("Cancel this delivery ticket? It stays on record but won't count as active.")) return;
    try {
      await apiRequest(`/administrator/tickets/${id}/cancel`, { method: "POST" });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr><th>Ticket</th><th>Truck</th><th>Driver</th><th>Site</th><th>Qty (m³)</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={t.id}>
              <td>{t.ticket_number}</td>
              <td>{t.truck_number}</td>
              <td>{t.driver_name}</td>
              <td>{t.site_name}</td>
              <td>
                {editing === t.id ? (
                  <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 70 }} />
                ) : t.loaded_quantity_m3}
              </td>
              <td><span className={`badge ${t.status === "cancelled" ? "badge-danger" : t.status === "completed" ? "badge-success" : "badge-neutral"}`}>{t.status.replace("_", " ")}</span></td>
              <td>
                {t.status !== "cancelled" && (
                  editing === t.id ? (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => saveEdit(t.id)} disabled={saving}>Save</button>
                      <button onClick={() => setEditing(null)}>Cancel</button>
                    </span>
                  ) : (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => { setEditing(t.id); setQty(t.loaded_quantity_m3); }}>Edit</button>
                      <button className="btn-danger" onClick={() => cancelTicket(t.id)}>Cancel ticket</button>
                    </span>
                  )
                )}
              </td>
            </tr>
          ))}
          {tickets.length === 0 && <tr><td colSpan={7} style={{ color: "var(--slate)" }}>No tickets yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
