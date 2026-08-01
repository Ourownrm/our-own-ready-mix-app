import { useEffect, useState, Fragment } from "react";
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
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", contact_number: "", billing_address: "" });
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  async function load() {
    try { setCustomers(await apiRequest("/administrator/customers")); } catch (err) { setError(err.message); }
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

  function startEdit(c) {
    setEditingId(c.id);
    setEditForm({ name: c.name, contact_number: c.contact_number || "", billing_address: c.billing_address || "" });
  }

  async function saveEdit(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/administrator/customers/${id}`, { method: "PATCH", body: editForm });
      setEditingId(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function toggleActive(c) {
    setError("");
    try {
      await apiRequest(`/administrator/customers/${c.id}/status`, { method: "POST", body: { is_active: !c.is_active } });
      load();
    } catch (err) { setError(err.message); }
  }

  async function remove(c) {
    if (!window.confirm(`Delete ${c.name}? This only works if they have no orders, sites, or other records on file.`)) return;
    setError("");
    try {
      await apiRequest(`/administrator/customers/${c.id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  const visible = showInactive ? customers : customers.filter((c) => c.is_active);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Customers</div>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show disabled
        </label>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <table style={{ fontSize: 13 }}>
          <thead><tr><th>Name</th><th>Contact</th><th>Billing address</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} style={!c.is_active ? { opacity: 0.6 } : undefined}>
                {editingId === c.id ? (
                  <>
                    <td><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} style={{ width: "100%" }} /></td>
                    <td><input value={editForm.contact_number} onChange={(e) => setEditForm({ ...editForm, contact_number: e.target.value })} style={{ width: "100%" }} /></td>
                    <td><input value={editForm.billing_address} onChange={(e) => setEditForm({ ...editForm, billing_address: e.target.value })} style={{ width: "100%" }} /></td>
                    <td></td>
                    <td style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => saveEdit(c.id)} disabled={saving}>Save</button>
                      <button onClick={() => setEditingId(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{c.name}</td>
                    <td>{c.contact_number || "–"}</td>
                    <td>{c.billing_address || "–"}</td>
                    <td><span className={`badge ${c.is_active ? "badge-success" : "badge-neutral"}`}>{c.is_active ? "Active" : "Disabled"}</span></td>
                    <td style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button onClick={() => startEdit(c)}>Edit</button>
                      <button onClick={() => toggleActive(c)}>{c.is_active ? "Disable" : "Enable"}</button>
                      <button className="btn-danger" onClick={() => remove(c)}>Delete</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>No customers.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
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
  const [salespersons, setSalespersons] = useState([]);
  const [form, setForm] = useState({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "", latitude: "", longitude: "", assigned_sales_representative_id: "" });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [assigningId, setAssigningId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  async function load() {
    try {
      const [s, c, cat, sp] = await Promise.all([
        apiRequest("/administrator/sites"), apiRequest("/master/customers"),
        apiRequest("/master/trip-allowance-categories"), apiRequest("/master/salespersons"),
      ]);
      setSites(s); setCustomers(c); setCategories(cat); setSalespersons(sp);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/sites", { method: "POST", body: form });
      setForm({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "", latitude: "", longitude: "", assigned_sales_representative_id: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function useCurrentLocation() {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setForm((f) => ({ ...f, latitude: pos.coords.latitude.toFixed(7), longitude: pos.coords.longitude.toFixed(7) })),
      () => setError("Couldn't get current location — enter coordinates manually, or allow location access.")
    );
  }

  function startEdit(s) {
    setEditingId(s.id);
    setEditForm({
      name: s.name, address: s.address || "", distance_from_plant_km: s.distance_from_plant_km || "",
      trip_allowance_category_id: s.trip_allowance_category_id || "", latitude: s.latitude || "", longitude: s.longitude || "",
    });
  }

  async function saveEdit(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/administrator/sites/${id}`, { method: "PATCH", body: editForm });
      setEditingId(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function toggleActive(s) {
    setError("");
    try {
      await apiRequest(`/administrator/sites/${s.id}/status`, { method: "POST", body: { is_active: !s.is_active } });
      load();
    } catch (err) { setError(err.message); }
  }

  async function remove(s) {
    if (!window.confirm(`Delete ${s.name}? This only works if it has no orders, forecasts, or other records on file.`)) return;
    setError("");
    try {
      await apiRequest(`/administrator/sites/${s.id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  async function assignSalesperson(siteId, salespersonId) {
    if (!salespersonId) return;
    setError("");
    try {
      await apiRequest(`/sales/sites/${siteId}/assign-salesperson`, { method: "POST", body: { salesperson_id: salespersonId } });
      setAssigningId(null);
      load();
    } catch (err) { setError(err.message); }
  }

  const visible = showInactive ? sites : sites.filter((s) => s.is_active);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Projects and sites</div>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show disabled
        </label>
      </div>
      <div className="card" style={{ marginBottom: 12, overflowX: "auto" }}>
        <table style={{ fontSize: 13 }}>
          <thead><tr><th>Site</th><th>Customer</th><th>Distance</th><th>Sales person</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.id} style={!s.is_active ? { opacity: 0.6 } : undefined}>
                {editingId === s.id ? (
                  <>
                    <td><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} style={{ width: "100%" }} /></td>
                    <td>{s.customer_name}</td>
                    <td><input type="number" value={editForm.distance_from_plant_km} onChange={(e) => setEditForm({ ...editForm, distance_from_plant_km: e.target.value })} style={{ width: 70 }} /></td>
                    <td>{s.salesperson_name || "–"}</td>
                    <td></td>
                    <td style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => saveEdit(s.id)} disabled={saving}>Save</button>
                      <button onClick={() => setEditingId(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{s.name}</td>
                    <td>{s.customer_name}</td>
                    <td>{s.distance_from_plant_km ? `${s.distance_from_plant_km} km` : "–"}</td>
                    <td>
                      {assigningId === s.id ? (
                        <select autoFocus onChange={(e) => assignSalesperson(s.id, e.target.value)} onBlur={() => setAssigningId(null)}>
                          <option value="">Select</option>
                          {salespersons.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                        </select>
                      ) : (
                        <span>
                          {s.salesperson_name || <span style={{ color: "var(--slate)" }}>Unassigned</span>}{" "}
                          <button style={{ fontSize: 10, padding: "1px 6px" }} onClick={() => setAssigningId(s.id)}>
                            {s.salesperson_name ? "Change" : "Assign"}
                          </button>
                        </span>
                      )}
                    </td>
                    <td><span className={`badge ${s.is_active ? "badge-success" : "badge-neutral"}`}>{s.is_active ? "Active" : "Disabled"}</span></td>
                    <td style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button onClick={() => startEdit(s)}>Edit</button>
                      <button onClick={() => toggleActive(s)}>{s.is_active ? "Disable" : "Enable"}</button>
                      <button className="btn-danger" onClick={() => remove(s)}>Delete</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No sites.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Customer</div>
          <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} required>
            <option value="">Select</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><div style={{ color: "var(--slate)" }}>Site name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Salesperson (required)</div>
          <select value={form.assigned_sales_representative_id} onChange={(e) => setForm({ ...form, assigned_sales_representative_id: e.target.value })} required>
            <option value="">Select</option>
            {salespersons.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
          </select>
        </div>
        <div><div style={{ color: "var(--slate)" }}>Distance from plant (km)</div><input type="number" value={form.distance_from_plant_km} onChange={(e) => setForm({ ...form, distance_from_plant_km: e.target.value })} /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Trip allowance category</div>
          <select value={form.trip_allowance_category_id} onChange={(e) => setForm({ ...form, trip_allowance_category_id: e.target.value })}>
            <option value="">Select</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div><div style={{ color: "var(--slate)" }}>Latitude</div><input type="number" step="any" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} placeholder="e.g. 8.5241" /></div>
        <div><div style={{ color: "var(--slate)" }}>Longitude</div><input type="number" step="any" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} placeholder="e.g. 76.9366" /></div>
        <div style={{ gridColumn: "1 / -1" }}>
          <button type="button" onClick={useCurrentLocation} style={{ fontSize: 12, padding: "6px 10px" }}>Use my current location</button>
        </div>
        <div style={{ gridColumn: "1 / -1" }}><div style={{ color: "var(--slate)" }}>Address</div><textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add site"}</button></div>
      </form>
    </div>
  );
}

export function RatesPanel({ setError }) {
  const [rates, setRates] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [grades, setGrades] = useState([]);
  const [form, setForm] = useState({ customer_id: "", mix_grade_id: "", rate_per_m3: "", pumping_charge_lumpsum: "", waiting_charge_per_hour: "", effective_from: new Date().toISOString().slice(0, 10) });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const [r, c, g] = await Promise.all([
        apiRequest("/administrator/rates"), apiRequest("/master/customers"), apiRequest("/master/mix-grades"),
      ]);
      setRates(r); setCustomers(c); setGrades(g);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/administrator/rates", { method: "POST", body: form });
      setNotice("Rate added.");
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function endRate(id) {
    const effectiveTo = window.prompt("End this rate as of which date? (it stops applying to new deliveries after this date)", new Date().toISOString().slice(0, 10));
    if (!effectiveTo) return;
    setError("");
    try {
      await apiRequest(`/administrator/rates/${id}/end`, { method: "POST", body: { effective_to: effectiveTo } });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Rate history — every rate on file, past and current</div>
      <div className="card" style={{ marginBottom: 20 }}>
        {rates.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>No rates entered yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Customer</th><th>Grade</th><th>Rate/m³</th><th>Pump charge (one-time/order)</th>
                  <th>Waiting/hr</th><th>Effective from</th><th>Effective to</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.id} style={r.currently_active ? { fontWeight: 600 } : { color: "var(--slate)" }}>
                    <td>{r.customer_name}</td>
                    <td>{r.mix_grade_name}</td>
                    <td>₹{r.rate_per_m3}</td>
                    <td>{r.pumping_charge_lumpsum > 0 ? `₹${r.pumping_charge_lumpsum}` : "–"}</td>
                    <td>{r.waiting_charge_per_hour > 0 ? `₹${r.waiting_charge_per_hour}` : "–"}</td>
                    <td>{new Date(r.effective_from).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                    <td>{r.effective_to ? new Date(r.effective_to).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "Open-ended"}</td>
                    <td>{r.currently_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-neutral">{r.effective_to ? "Ended" : "Superseded"}</span>}</td>
                    <td>
                      {!r.effective_to && (
                        <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => endRate(r.id)}>End this rate</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Add a new rate</div>
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
        <div><div style={{ color: "var(--slate)" }}>Pumping charge — one-time per order (₹)</div><input type="number" value={form.pumping_charge_lumpsum} onChange={(e) => setForm({ ...form, pumping_charge_lumpsum: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Waiting charge per hour (₹)</div><input type="number" value={form.waiting_charge_per_hour} onChange={(e) => setForm({ ...form, waiting_charge_per_hour: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Effective from</div><input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} required /></div>
        <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)" }}>
          If this replaces an existing rate above, use "End this rate" on the old one (set its end date to the day before this one starts) so there's no ambiguity about which rate applies on any given day.
        </div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add rate"}</button></div>
      </form>
    </div>
  );
}

export function FleetPanel({ setError }) {
  const [trucks, setTrucks] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [truckForm, setTruckForm] = useState({ truck_number: "", capacity_m3: "" });
  const [pumpForm, setPumpForm] = useState({ pump_code: "", pump_type: "line_pump" });
  const [savingTruck, setSavingTruck] = useState(false);
  const [savingPump, setSavingPump] = useState(false);

  async function load() {
    try {
      const [t, p] = await Promise.all([apiRequest("/administrator/trucks"), apiRequest("/administrator/pumps")]);
      setTrucks(t); setPumps(p);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function addTruck(e) {
    e.preventDefault();
    setSavingTruck(true); setError("");
    try {
      await apiRequest("/administrator/trucks", { method: "POST", body: truckForm });
      setTruckForm({ truck_number: "", capacity_m3: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSavingTruck(false); }
  }

  async function addPump(e) {
    e.preventDefault();
    setSavingPump(true); setError("");
    try {
      await apiRequest("/administrator/pumps", { method: "POST", body: pumpForm });
      setPumpForm({ pump_code: "", pump_type: "line_pump" });
      load();
    } catch (err) { setError(err.message); } finally { setSavingPump(false); }
  }

  async function toggleActive(kind, id, is_active) {
    setError("");
    try {
      await apiRequest(`/administrator/${kind}/${id}/status`, { method: "PATCH", body: { is_active } });
      load();
    } catch (err) { setError(err.message); }
  }

  async function hardDelete(kind, id, label) {
    if (!window.confirm(`Delete ${label}? This can't be undone. If it's already been used anywhere, this will be blocked — deactivate it instead.`)) return;
    setError("");
    try {
      await apiRequest(`/administrator/${kind}/${id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Trucks</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Truck number</th><th>Capacity (m³)</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {trucks.map((t) => (
              <tr key={t.id}>
                <td>{t.truck_number}</td>
                <td>{t.capacity_m3 ?? "–"}</td>
                <td>{t.is_active ? "Active" : "Inactive"}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => toggleActive("trucks", t.id, !t.is_active)}>
                    {t.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button className="btn-danger" style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => hardDelete("trucks", t.id, t.truck_number)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {trucks.length === 0 && <tr><td colSpan={4} style={{ color: "var(--slate)" }}>None yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={addTruck} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginBottom: 24 }}>
        <div><div style={{ color: "var(--slate)" }}>Truck number</div><input value={truckForm.truck_number} onChange={(e) => setTruckForm({ ...truckForm, truck_number: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Capacity (m³)</div><input type="number" value={truckForm.capacity_m3} onChange={(e) => setTruckForm({ ...truckForm, capacity_m3: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={savingTruck}>{savingTruck ? "Saving..." : "Add truck"}</button></div>
      </form>

      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Pumps</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Pump code</th><th>Type</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {pumps.map((p) => (
              <tr key={p.id}>
                <td>{p.pump_code}</td>
                <td>{p.pump_type.replace(/_/g, " ")}</td>
                <td>{p.is_active ? "Active" : "Inactive"}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => toggleActive("pumps", p.id, !p.is_active)}>
                    {p.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button className="btn-danger" style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => hardDelete("pumps", p.id, p.pump_code)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {pumps.length === 0 && <tr><td colSpan={4} style={{ color: "var(--slate)" }}>None yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={addPump} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
        <div><div style={{ color: "var(--slate)" }}>Pump code</div><input value={pumpForm.pump_code} onChange={(e) => setPumpForm({ ...pumpForm, pump_code: e.target.value })} required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Type</div>
          <select value={pumpForm.pump_type} onChange={(e) => setPumpForm({ ...pumpForm, pump_type: e.target.value })}>
            <option value="boom_pump">Boom pump</option>
            <option value="line_pump">Line pump</option>
          </select>
        </div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={savingPump}>{savingPump ? "Saving..." : "Add pump"}</button></div>
      </form>
    </div>
  );
}

export function SalespersonsPanel({ setError }) {
  const [salespersons, setSalespersons] = useState([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setSalespersons(await apiRequest("/administrator/salespersons")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/salespersons", { method: "POST", body: { name } });
      setName("");
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function toggleActive(id, is_active) {
    setError("");
    try {
      await apiRequest(`/administrator/salespersons/${id}/status`, { method: "PATCH", body: { is_active } });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {salespersons.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.is_active ? "Active" : "Inactive"}</td>
                <td>
                  <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => toggleActive(s.id, !s.is_active)}>
                    {s.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
            {salespersons.length === 0 && <tr><td colSpan={3} style={{ color: "var(--slate)" }}>None yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={submit} className="field-input card" style={{ display: "flex", gap: 8, fontSize: 13 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Salesperson name" required style={{ flex: 1 }} />
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Add"}</button>
      </form>
    </div>
  );
}

export function FuelStationsAndEquipmentPanel({ setError }) {
  const [stations, setStations] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [stationForm, setStationForm] = useState({ name: "", location: "" });
  const [equipForm, setEquipForm] = useState({ equipment_type: "pickup_van", name: "" });
  const [savingStation, setSavingStation] = useState(false);
  const [savingEquip, setSavingEquip] = useState(false);

  async function load() {
    try {
      const [s, e] = await Promise.all([apiRequest("/administrator/fuel-stations"), apiRequest("/administrator/equipment")]);
      setStations(s); setEquipment(e);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function addStation(e) {
    e.preventDefault();
    setSavingStation(true); setError("");
    try {
      await apiRequest("/administrator/fuel-stations", { method: "POST", body: stationForm });
      setStationForm({ name: "", location: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSavingStation(false); }
  }

  async function addEquipment(e) {
    e.preventDefault();
    setSavingEquip(true); setError("");
    try {
      await apiRequest("/administrator/equipment", { method: "POST", body: equipForm });
      setEquipForm({ equipment_type: "pickup_van", name: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSavingEquip(false); }
  }

  async function toggleActive(kind, id, is_active) {
    setError("");
    try {
      await apiRequest(`/administrator/${kind}/${id}/status`, { method: "PATCH", body: { is_active } });
      load();
    } catch (err) { setError(err.message); }
  }

  async function hardDelete(kind, id, label) {
    if (!window.confirm(`Delete ${label}? This can't be undone. If it's already been used anywhere, this will be blocked — deactivate it instead.`)) return;
    setError("");
    try {
      await apiRequest(`/administrator/${kind}/${id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Fuel stations</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Name</th><th>Location</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.location || "–"}</td>
                <td>{s.is_active ? "Active" : "Inactive"}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => toggleActive("fuel-stations", s.id, !s.is_active)}>
                    {s.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button className="btn-danger" style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => hardDelete("fuel-stations", s.id, s.name)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {stations.length === 0 && <tr><td colSpan={4} style={{ color: "var(--slate)" }}>None yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={addStation} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginBottom: 24 }}>
        <div><div style={{ color: "var(--slate)" }}>Station name</div><input value={stationForm.name} onChange={(e) => setStationForm({ ...stationForm, name: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Location</div><input value={stationForm.location} onChange={(e) => setStationForm({ ...stationForm, location: e.target.value })} /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={savingStation}>{savingStation ? "Saving..." : "Add fuel station"}</button></div>
      </form>

      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Equipment (pickup vans, loaders, generators)</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Type</th><th>Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {equipment.map((e) => (
              <tr key={e.id}>
                <td>{e.equipment_type.replace("_", " ")}</td>
                <td>{e.name}</td>
                <td>{e.is_active ? "Active" : "Inactive"}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => toggleActive("equipment", e.id, !e.is_active)}>
                    {e.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button className="btn-danger" style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => hardDelete("equipment", e.id, e.name)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {equipment.length === 0 && <tr><td colSpan={4} style={{ color: "var(--slate)" }}>None yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={addEquipment} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Type</div>
          <select value={equipForm.equipment_type} onChange={(e) => setEquipForm({ ...equipForm, equipment_type: e.target.value })}>
            <option value="pickup_van">Pickup van</option>
            <option value="loader">Loader</option>
            <option value="generator">Generator</option>
          </select>
        </div>
        <div><div style={{ color: "var(--slate)" }}>Name</div><input value={equipForm.name} onChange={(e) => setEquipForm({ ...equipForm, name: e.target.value })} placeholder="e.g. Loader-1" required /></div>
        <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={savingEquip}>{savingEquip ? "Saving..." : "Add equipment"}</button></div>
      </form>
    </div>
  );
}

export function OrdersPanel({ setError }) {
  const [orders, setOrders] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ order_quantity_m3: "", scheduled_batching_time: "", remarks: "" });
  const [rescheduling, setRescheduling] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ new_order_date: "", new_scheduled_batching_time: "", reason: "" });
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

  function startReschedule(o) {
    setRescheduling(o.id);
    setRescheduleForm({ new_order_date: o.order_date?.slice(0, 10) || "", new_scheduled_batching_time: o.scheduled_batching_time || "", reason: "" });
  }

  async function saveReschedule(id) {
    if (!rescheduleForm.reason) return setError("A reason is required to reschedule.");
    setSaving(true); setError("");
    try {
      await apiRequest(`/administrator/orders/${id}/reschedule`, { method: "POST", body: rescheduleForm });
      setRescheduling(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr><th>Date</th><th>Customer</th><th>Site</th><th>Grade</th><th>Qty (m³)</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <Fragment key={o.id}>
              <tr>
                <td>
                  {new Date(o.order_date).toLocaleDateString()}
                  {o.original_order_date && (
                    <div style={{ fontSize: 11, color: "var(--slate)" }}>
                      Rescheduled from {new Date(o.original_order_date).toLocaleDateString()}
                      {o.original_scheduled_batching_time ? `, ${o.original_scheduled_batching_time}` : ""}
                    </div>
                  )}
                </td>
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
                  {!["cancelled", "closed", "completed"].includes(o.status) && (
                    editing === o.id ? (
                      <span style={{ display: "flex", gap: 4 }}>
                        <button onClick={() => saveEdit(o.id)} disabled={saving}>Save</button>
                        <button onClick={() => setEditing(null)}>Cancel</button>
                      </span>
                    ) : (
                      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <button onClick={() => startEdit(o)}>Edit</button>
                        <button onClick={() => startReschedule(o)}>Reschedule</button>
                        <button className="btn-danger" onClick={() => cancelOrder(o.id)}>Cancel order</button>
                      </span>
                    )
                  )}
                </td>
              </tr>
              {rescheduling === o.id && (
                <tr>
                  <td colSpan={7}>
                    <div className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr auto", gap: 8, fontSize: 13, padding: 10, background: "var(--concrete)", borderRadius: 8, alignItems: "end" }}>
                      <div>
                        <div style={{ color: "var(--slate)" }}>New date</div>
                        <input type="date" value={rescheduleForm.new_order_date} onChange={(e) => setRescheduleForm({ ...rescheduleForm, new_order_date: e.target.value })} />
                      </div>
                      <div>
                        <div style={{ color: "var(--slate)" }}>New batching time</div>
                        <input type="time" value={rescheduleForm.new_scheduled_batching_time} onChange={(e) => setRescheduleForm({ ...rescheduleForm, new_scheduled_batching_time: e.target.value })} />
                      </div>
                      <div>
                        <div style={{ color: "var(--slate)" }}>Reason (required)</div>
                        <input value={rescheduleForm.reason} onChange={(e) => setRescheduleForm({ ...rescheduleForm, reason: e.target.value })} placeholder="Customer requested a different date, site not ready, etc." style={{ width: "100%" }} />
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={() => saveReschedule(o.id)} disabled={saving}>{saving ? "Saving..." : "Confirm"}</button>
                        <button onClick={() => setRescheduling(null)}>Cancel</button>
                      </div>
                      <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)" }}>
                        Change the date, the time, or both — leaving one unchanged keeps it as-is.
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {orders.length === 0 && <tr><td colSpan={7} style={{ color: "var(--slate)" }}>No orders yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function TicketsPanel({ setError }) {
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
