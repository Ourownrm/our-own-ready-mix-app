import { useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext.jsx";
import { apiRequest } from "../lib/api.js";

const ROLES = ["administrator", "manager", "plant_operator", "qc_engineer", "driver", "site_supervisor", "accountant"];

export default function Administrator() {
  const { user, logout } = useAuth();
  const [view, setView] = useState("users"); // users | customers | sites | trucks | rates
  const [error, setError] = useState("");

  return (
    <div style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "#666" }}>Administrator &middot; {user?.name}</div>
        <button onClick={logout} style={{ fontSize: 12, color: "#999", background: "none", border: "none" }}>Sign out</button>
      </div>
      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          ["users", "Users and roles"],
          ["customers", "Customers"],
          ["sites", "Projects and sites"],
          ["trucks", "Trucks and fleet"],
          ["rates", "Concrete grades and rates"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{ background: view === key ? "#111" : "#fff", color: view === key ? "#fff" : "#111" }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "users" && <UsersPanel setError={setError} />}
      {view === "customers" && <CustomersPanel setError={setError} />}
      {view === "sites" && <SitesPanel setError={setError} />}
      {view === "trucks" && <TrucksPanel setError={setError} />}
      {view === "rates" && <RatesPanel setError={setError} />}
    </div>
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
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#666" }}>
            <th style={{ padding: "6px 4px" }}>Name</th>
            <th style={{ padding: "6px 4px" }}>Phone</th>
            <th style={{ padding: "6px 4px" }}>Role</th>
            <th style={{ padding: "6px 4px" }}>Status</th>
            <th style={{ padding: "6px 4px" }}></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={{ borderTop: "0.5px solid #ddd" }}>
              <td style={{ padding: "6px 4px" }}>{u.name}</td>
              <td style={{ padding: "6px 4px" }}>{u.phone}</td>
              <td style={{ padding: "6px 4px" }}>{u.role.replace("_", " ")}</td>
              <td style={{ padding: "6px 4px", color: u.is_active ? "#1D9E75" : "#999" }}>{u.is_active ? "Active" : "Disabled"}</td>
              <td style={{ padding: "6px 4px" }}>
                <button onClick={() => toggleStatus(u)}>{u.is_active ? "Disable" : "Enable"}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)}>Add user</button>
      ) : (
        <form onSubmit={addUser} className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, background: "#f5f5f5", padding: 16, borderRadius: 12 }}>
          <div><div style={{ color: "#666" }}>Name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><div style={{ color: "#666" }}>Phone</div><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required /></div>
          <div><div style={{ color: "#666" }}>Email (optional)</div><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><div style={{ color: "#666" }}>Temporary password</div><input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></div>
          <div>
            <div style={{ color: "#666" }}>Role</div>
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

function CustomersPanel({ setError }) {
  const [customers, setCustomers] = useState([]);
  const [form, setForm] = useState({ name: "", contact_number: "", billing_address: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setCustomers(await apiRequest("/master/customers")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/customers", { method: "POST", body: form });
      setForm({ name: "", contact_number: "", billing_address: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      <List rows={customers} columns={[["name", "Name"], ["contact_number", "Contact"]]} />
      <form onSubmit={submit} className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, background: "#f5f5f5", padding: 16, borderRadius: 12, marginTop: 12 }}>
        <div><div style={{ color: "#666" }}>Name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div><div style={{ color: "#666" }}>Contact number</div><input value={form.contact_number} onChange={(e) => setForm({ ...form, contact_number: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><div style={{ color: "#666" }}>Billing address</div><textarea rows={2} value={form.billing_address} onChange={(e) => setForm({ ...form, billing_address: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add customer"}</button></div>
      </form>
    </div>
  );
}

function SitesPanel({ setError }) {
  const [sites, setSites] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [s, c, cat] = await Promise.all([
        apiRequest("/master/sites"), apiRequest("/master/customers"), apiRequest("/master/trip-allowance-categories"),
      ]);
      setSites(s); setCustomers(c); setCategories(cat);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/sites", { method: "POST", body: form });
      setForm({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      <List rows={sites} columns={[["name", "Site"], ["distance_from_plant_km", "Distance (km)"], ["trip_allowance_label", "Trip allowance"]]} />
      <form onSubmit={submit} className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, background: "#f5f5f5", padding: 16, borderRadius: 12, marginTop: 12 }}>
        <div>
          <div style={{ color: "#666" }}>Customer</div>
          <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} required>
            <option value="">Select</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><div style={{ color: "#666" }}>Site name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div><div style={{ color: "#666" }}>Distance from plant (km)</div><input type="number" value={form.distance_from_plant_km} onChange={(e) => setForm({ ...form, distance_from_plant_km: e.target.value })} /></div>
        <div>
          <div style={{ color: "#666" }}>Trip allowance category</div>
          <select value={form.trip_allowance_category_id} onChange={(e) => setForm({ ...form, trip_allowance_category_id: e.target.value })}>
            <option value="">Select</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: "1 / -1" }}><div style={{ color: "#666" }}>Address</div><textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add site"}</button></div>
      </form>
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
      <form onSubmit={submit} className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, background: "#f5f5f5", padding: 16, borderRadius: 12, marginTop: 12 }}>
        <div><div style={{ color: "#666" }}>Truck number</div><input value={form.truck_number} onChange={(e) => setForm({ ...form, truck_number: e.target.value })} required /></div>
        <div><div style={{ color: "#666" }}>Capacity (m³)</div><input type="number" value={form.capacity_m3} onChange={(e) => setForm({ ...form, capacity_m3: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add truck"}</button></div>
      </form>
    </div>
  );
}

function RatesPanel({ setError }) {
  const [customers, setCustomers] = useState([]);
  const [grades, setGrades] = useState([]);
  const [form, setForm] = useState({ customer_id: "", mix_grade_id: "", rate_per_m3: "", pumping_charge_per_m3: "", waiting_charge_per_hour: "", effective_from: new Date().toISOString().slice(0, 10) });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/mix-grades")])
      .then(([c, g]) => { setCustomers(c); setGrades(g); })
      .catch((err) => setError(err.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/administrator/rates", { method: "POST", body: form });
      setNotice("Rate added.");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, background: "#f5f5f5", padding: 16, borderRadius: 12, maxWidth: 480 }}>
      {notice && <div style={{ gridColumn: "1 / -1", color: "#1D9E75" }}>{notice}</div>}
      <div>
        <div style={{ color: "#666" }}>Customer</div>
        <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} required>
          <option value="">Select</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <div style={{ color: "#666" }}>Mix grade</div>
        <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })} required>
          <option value="">Select</option>
          {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      <div><div style={{ color: "#666" }}>Rate per m³ (₹)</div><input type="number" value={form.rate_per_m3} onChange={(e) => setForm({ ...form, rate_per_m3: e.target.value })} required /></div>
      <div><div style={{ color: "#666" }}>Pumping charge per m³ (₹)</div><input type="number" value={form.pumping_charge_per_m3} onChange={(e) => setForm({ ...form, pumping_charge_per_m3: e.target.value })} /></div>
      <div><div style={{ color: "#666" }}>Waiting charge per hour (₹)</div><input type="number" value={form.waiting_charge_per_hour} onChange={(e) => setForm({ ...form, waiting_charge_per_hour: e.target.value })} /></div>
      <div><div style={{ color: "#666" }}>Effective from</div><input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} required /></div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add rate"}</button></div>
    </form>
  );
}

function List({ rows, columns }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "#666" }}>
          {columns.map(([key, label]) => <th key={key} style={{ padding: "6px 4px" }}>{label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.id || i} style={{ borderTop: "0.5px solid #ddd" }}>
            {columns.map(([key]) => <td key={key} style={{ padding: "6px 4px" }}>{row[key] ?? "–"}</td>)}
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={columns.length} style={{ padding: 8, color: "#999" }}>None yet.</td></tr>}
      </tbody>
    </table>
  );
}
