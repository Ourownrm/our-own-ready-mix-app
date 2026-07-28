import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { CustomersPanel, SitesPanel, RatesPanel, FleetPanel, SalespersonsPanel, FuelStationsAndEquipmentPanel, OrdersPanel as SharedOrdersPanel, TicketsPanel as SharedTicketsPanel } from "../lib/MasterDataPanels.jsx";

const ROLES = ["administrator", "manager", "plant_operator", "qc_engineer", "driver", "site_supervisor", "accountant", "sales_executive"];

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
          ["fleet", "Trucks and pumps"],
          ["fuel", "Fuel stations and equipment"],
          ["salespersons", "Salespersons"],
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
        <Link to="/reports"><button type="button">Reports &amp; Director's Dashboard</button></Link>
        <Link to="/breakdowns"><button type="button">Equipment breakdowns</button></Link>
      </div>

      {view === "users" && <UsersPanel setError={setError} />}
      {view === "customers" && <CustomersPanel setError={setError} />}
      {view === "sites" && <SitesPanel setError={setError} />}
      {view === "fleet" && <FleetPanel setError={setError} />}
      {view === "fuel" && <FuelStationsAndEquipmentPanel setError={setError} />}
      {view === "salespersons" && <SalespersonsPanel setError={setError} />}
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

  async function resetPassword(u) {
    const newPassword = window.prompt(`New password for ${u.name} (at least 6 characters):`);
    if (!newPassword) return; // cancelled
    try {
      await apiRequest(`/administrator/users/${u.id}/reset-password`, { method: "POST", body: { new_password: newPassword } });
      window.alert(`Password updated for ${u.name}. Tell them the new password directly — it isn't emailed or shown anywhere else.`);
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
              <td style={{ display: "flex", gap: 6 }}>
                <button onClick={() => toggleStatus(u)}>{u.is_active ? "Disable" : "Enable"}</button>
                <button onClick={() => resetPassword(u)}>Reset password</button>
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

function OrdersPanel({ setError }) {
  return <SharedOrdersPanel setError={setError} />;
}

function TicketsPanel({ setError }) {
  return <SharedTicketsPanel setError={setError} />;
}
