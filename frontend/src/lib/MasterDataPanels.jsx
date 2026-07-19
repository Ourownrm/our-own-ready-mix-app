import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export function List({ rows, columns }) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <table>
        <thead>
          <tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || i}>
              {columns.map(([key]) => <td key={key}>{row[key] ?? "–"}</td>)}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={columns.length} style={{ color: "var(--slate)" }}>None yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function CustomersPanel({ setError }) {
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
      <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginTop: 12 }}>
        <div><div style={{ color: "var(--slate)" }}>Name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Contact number</div><input value={form.contact_number} onChange={(e) => setForm({ ...form, contact_number: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><div style={{ color: "var(--slate)" }}>Billing address</div><textarea rows={2} value={form.billing_address} onChange={(e) => setForm({ ...form, billing_address: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add customer"}</button></div>
      </form>
    </div>
  );
}

export function SitesPanel({ setError }) {
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
      <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginTop: 12 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Customer</div>
          <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} required>
            <option value="">Select</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><div style={{ color: "var(--slate)" }}>Site name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Distance from plant (km)</div><input type="number" value={form.distance_from_plant_km} onChange={(e) => setForm({ ...form, distance_from_plant_km: e.target.value })} /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Trip allowance category</div>
          <select value={form.trip_allowance_category_id} onChange={(e) => setForm({ ...form, trip_allowance_category_id: e.target.value })}>
            <option value="">Select</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: "1 / -1" }}><div style={{ color: "var(--slate)" }}>Address</div><textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add site"}</button></div>
      </form>
    </div>
  );
}

export function RatesPanel({ setError }) {
  const [customers, setCustomers] = useState([]);
  const [grades, setGrades] = useState([]);
  const [form, setForm] = useState({ customer_id: "", mix_grade_id: "", rate_per_m3: "", pumping_charge_lumpsum: "", waiting_charge_per_hour: "", effective_from: new Date().toISOString().slice(0, 10) });
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
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, maxWidth: 480 }}>
      {notice && <div style={{ gridColumn: "1 / -1", color: "var(--signal-green)" }}>{notice}</div>}
      <div>
        <div style={{ color: "var(--slate)" }}>Customer</div>
        <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} required>
          <option value="">Select</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <div style={{ color: "var(--slate)" }}>Mix grade</div>
        <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })} required>
          <option value="">Select</option>
          {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      <div><div style={{ color: "var(--slate)" }}>Rate per m³ (₹)</div><input type="number" value={form.rate_per_m3} onChange={(e) => setForm({ ...form, rate_per_m3: e.target.value })} required /></div>
      <div><div style={{ color: "var(--slate)" }}>Pumping charge — lump sum per delivery (₹)</div><input type="number" value={form.pumping_charge_lumpsum} onChange={(e) => setForm({ ...form, pumping_charge_lumpsum: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Waiting charge per hour (₹)</div><input type="number" value={form.waiting_charge_per_hour} onChange={(e) => setForm({ ...form, waiting_charge_per_hour: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Effective from</div><input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} required /></div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add rate"}</button></div>
    </form>
  );
}
