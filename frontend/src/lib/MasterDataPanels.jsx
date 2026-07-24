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
  const [form, setForm] = useState({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "", latitude: "", longitude: "" });
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
      setForm({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "", latitude: "", longitude: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function useCurrentLocation() {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setForm((f) => ({ ...f, latitude: pos.coords.latitude.toFixed(7), longitude: pos.coords.longitude.toFixed(7) })),
      () => setError("Couldn't get current location — enter coordinates manually, or allow location access.")
    );
  }

  return (
    <div>
      <List rows={sites} columns={[["name", "Site"], ["distance_from_plant_km", "Distance (km)"], ["trip_allowance_label", "Trip allowance"], ["latitude", "Lat"], ["longitude", "Lng"]]} />
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
