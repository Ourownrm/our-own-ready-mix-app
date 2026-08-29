import { useEffect, useState, Fragment } from "react";
import { apiRequest } from "./api.js";
import { useAuth } from "./AuthContext.jsx";
import { generateMixDesignPdf } from "./mixDesignPdf.js";
import { formatOrderNumber } from "./orderNumber.js";

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
  const [form, setForm] = useState({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "", latitude: "", longitude: "", assigned_sales_representative_id: "", plant_out_grace_minutes: "" });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [assigningId, setAssigningId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [showMismatches, setShowMismatches] = useState(false);
  const [notice, setNotice] = useState("");

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
      setForm({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "", latitude: "", longitude: "", assigned_sales_representative_id: "", plant_out_grace_minutes: "" });
      load();
    } catch (err) {
      if (err.status === 409 && window.confirm(`${err.message}\n\nCreate it anyway?`)) {
        try {
          await apiRequest("/administrator/sites", { method: "POST", body: { ...form, force: true } });
          setForm({ customer_id: "", name: "", address: "", distance_from_plant_km: "", trip_allowance_category_id: "", latitude: "", longitude: "", assigned_sales_representative_id: "", plant_out_grace_minutes: "" });
          load();
        } catch (err2) { setError(err2.message); }
      } else if (err.status !== 409) {
        setError(err.message);
      }
    } finally { setSaving(false); }
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
      plant_out_grace_minutes: s.plant_out_grace_minutes || "",
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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show disabled
          </label>
          <button style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setShowDuplicates(true)}>Check for duplicate sites</button>
          <button style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setShowMismatches(true)}>Check for wrong-customer orders</button>
        </div>
      </div>
      {showDuplicates && (
        <DuplicateSitesReview setError={setError} onClose={() => setShowDuplicates(false)} onDone={(msg) => { setNotice(msg); setShowDuplicates(false); load(); }} />
      )}
      {showMismatches && (
        <SiteMismatchReview setError={setError} onClose={() => setShowMismatches(false)} onDone={(msg) => { setNotice(msg); setShowMismatches(false); load(); }} />
      )}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 12, marginBottom: 8 }}>{notice}</div>}
      <div className="card" style={{ marginBottom: 12, overflowX: "auto" }}>
        <table style={{ fontSize: 13 }}>
          <thead><tr><th>Site</th><th>Customer</th><th>Distance</th><th>Auto-confirm grace</th><th>Sales person</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.id} style={!s.is_active ? { opacity: 0.6 } : undefined}>
                {editingId === s.id ? (
                  <>
                    <td><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} style={{ width: "100%" }} /></td>
                    <td>{s.customer_name}</td>
                    <td><input type="number" value={editForm.distance_from_plant_km} onChange={(e) => setEditForm({ ...editForm, distance_from_plant_km: e.target.value })} style={{ width: 70 }} /></td>
                    <td><input type="number" min="1" placeholder="12" value={editForm.plant_out_grace_minutes} onChange={(e) => setEditForm({ ...editForm, plant_out_grace_minutes: e.target.value })} style={{ width: 60 }} /></td>
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
                    <td>{s.plant_out_grace_minutes ? `${s.plant_out_grace_minutes} min` : "Default (12 min)"}</td>
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
            {visible.length === 0 && <tr><td colSpan={7} style={{ color: "var(--slate)" }}>No sites.</td></tr>}
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
        <div>
          <div style={{ color: "var(--slate)" }}>Auto-confirm grace (minutes)</div>
          <input type="number" min="1" value={form.plant_out_grace_minutes} onChange={(e) => setForm({ ...form, plant_out_grace_minutes: e.target.value })} placeholder="Default: 12" />
          <div style={{ fontSize: 11, color: "var(--slate)" }}>
            If a driver doesn't respond to a GPS stage nudge (Plant Out, Site In, Site Out, or Plant In), it's auto-recorded this many minutes later — same grace period for all four. Site Out auto-records with slump/delivery-note left blank, flagged for follow-up. Leave blank to use the default (12 min) — set lower for a short-travel-time site.
          </div>
        </div>
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
  const [sites, setSites] = useState([]);
  const [grades, setGrades] = useState([]);
  const [form, setForm] = useState({
    customer_id: "", site_id: "", mix_grade_id: "", rate_per_m3: "",
    line_pump_charge: "", line_pump_min_qty_m3: "20", boom_pump_charge: "", boom_pump_min_qty_m3: "50",
    part_load_min_qty_m3: "5", part_load_charge_per_m3: "",
    waiting_charge_per_hour: "", effective_from: new Date().toISOString().slice(0, 10),
  });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [recalculatingRateId, setRecalculatingRateId] = useState(null);
  const [showSeedReview, setShowSeedReview] = useState(false);
  const [showEnded, setShowEnded] = useState(false);

  async function load() {
    try {
      const [r, c, s, g] = await Promise.all([
        apiRequest("/administrator/rates"), apiRequest("/master/customers"), apiRequest("/master/sites"), apiRequest("/master/mix-grades"),
      ]);
      setRates(r); setCustomers(c); setSites(s); setGrades(g);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  const sitesForCustomer = form.customer_id ? sites.filter((s) => String(s.customer_id) === String(form.customer_id)) : [];

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

  const visibleRates = showEnded ? rates : rates.filter((r) => r.currently_active);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Rate history</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
            Show ended/superseded
          </label>
          <button style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setShowSeedReview(true)}>Review sample rates</button>
        </div>
      </div>
      {showSeedReview && (
        <SeedRateReview setError={setError} onClose={() => setShowSeedReview(false)} onDone={(msg) => { setNotice(msg); setShowSeedReview(false); load(); }} />
      )}
      <div className="card" style={{ marginBottom: 20 }}>
        {visibleRates.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>{rates.length === 0 ? "No rates entered yet." : "No active rates — check \"Show ended/superseded\" to see them."}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Customer</th><th>Site/Project</th><th>Grade</th><th>Rate/m³</th>
                  <th>Line pump (min m³)</th><th>Boom pump (min m³)</th><th>Part load (min m³ / rate)</th>
                  <th>Waiting/hr</th><th>Effective from</th><th>Effective to</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {visibleRates.map((r) => (
                  <tr key={r.id} style={r.currently_active ? { fontWeight: 600 } : { color: "var(--slate)" }}>
                    <td>{r.customer_name}</td>
                    <td>{r.site_name || <span style={{ fontStyle: "italic" }}>All sites</span>}</td>
                    <td>{r.mix_grade_name}</td>
                    <td>₹{r.rate_per_m3}</td>
                    <td>{r.line_pump_charge > 0 ? `₹${r.line_pump_charge} (${r.line_pump_min_qty_m3 ?? 20})` : (r.pumping_charge_lumpsum > 0 ? `₹${r.pumping_charge_lumpsum} (legacy)` : "–")}</td>
                    <td>{r.boom_pump_charge > 0 ? `₹${r.boom_pump_charge} (${r.boom_pump_min_qty_m3 ?? 50})` : "–"}</td>
                    <td>{r.part_load_charge_per_m3 > 0 ? `${r.part_load_min_qty_m3 ?? 5} m³ / ₹${r.part_load_charge_per_m3}` : "–"}</td>
                    <td>{r.waiting_charge_per_hour > 0 ? `₹${r.waiting_charge_per_hour}` : "–"}</td>
                    <td>{new Date(r.effective_from).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                    <td>{r.effective_to ? new Date(r.effective_to).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "Open-ended"}</td>
                    <td>{r.currently_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-neutral">{r.effective_to ? "Ended" : "Superseded"}</span>}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {!r.effective_to && (
                          <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => endRate(r.id)}>End this rate</button>
                        )}
                        <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setRecalculatingRateId(r.id)}>Recalculate deliveries</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {recalculatingRateId && (
        <RecalculatePreview
          rateId={recalculatingRateId}
          setError={setError}
          onClose={() => setRecalculatingRateId(null)}
          onDone={(msg) => { setNotice(msg); setRecalculatingRateId(null); load(); }}
        />
      )}

      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Add a new rate</div>
      <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, maxWidth: 480 }}>
        {notice && <div style={{ gridColumn: "1 / -1", color: "var(--signal-green)" }}>{notice}</div>}
        <div>
          <div style={{ color: "var(--slate)" }}>Customer</div>
          <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value, site_id: "" })} required>
            <option value="">Select</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site/Project</div>
          <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} required disabled={!form.customer_id}>
            <option value="">{form.customer_id ? "Select" : "Select a customer first"}</option>
            {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
        <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--concrete)", paddingTop: 8, fontSize: 12, fontWeight: 600 }}>Pump mobilization charge</div>
        <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)", marginTop: -4 }}>
          Set per pump type — boom and line pump mobilization costs differ, and typically only apply below the minimum order quantity shown.
        </div>
        <div><div style={{ color: "var(--slate)" }}>Line pump charge (₹)</div><input type="number" value={form.line_pump_charge} onChange={(e) => setForm({ ...form, line_pump_charge: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Line pump min qty (m³)</div><input type="number" value={form.line_pump_min_qty_m3} onChange={(e) => setForm({ ...form, line_pump_min_qty_m3: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Boom pump charge (₹)</div><input type="number" value={form.boom_pump_charge} onChange={(e) => setForm({ ...form, boom_pump_charge: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Boom pump min qty (m³)</div><input type="number" value={form.boom_pump_min_qty_m3} onChange={(e) => setForm({ ...form, boom_pump_min_qty_m3: e.target.value })} /></div>

        <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--concrete)", paddingTop: 8, fontSize: 12, fontWeight: 600 }}>Part load charge</div>
        <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)", marginTop: -4 }}>
          Applies when a single order is below the minimum load — charged per m³ short of the minimum.
        </div>
        <div><div style={{ color: "var(--slate)" }}>Minimum load (m³)</div><input type="number" value={form.part_load_min_qty_m3} onChange={(e) => setForm({ ...form, part_load_min_qty_m3: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Charge per m³ short (₹)</div><input type="number" value={form.part_load_charge_per_m3} onChange={(e) => setForm({ ...form, part_load_charge_per_m3: e.target.value })} /></div>

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

function SiteMismatchReview({ setError, onClose, onDone }) {
  const [rows, setRows] = useState(null);
  const [sites, setSites] = useState([]);
  const [fixSelections, setFixSelections] = useState({});
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    Promise.all([apiRequest("/administrator/orders/site-customer-mismatches"), apiRequest("/administrator/sites")])
      .then(([m, s]) => { setRows(m); setSites(s); })
      .catch((err) => setError(err.message));
  }, []);

  if (rows === null) return <div className="card" style={{ marginBottom: 20, fontSize: 13 }}>Checking...</div>;

  async function fix(orderId) {
    const correctSiteId = fixSelections[orderId];
    if (!correctSiteId) { setError("Pick the correct site first."); return; }
    if (!window.confirm("Reassign this order to the correct site? This only changes this one order — the site record itself and any other order are untouched.")) return;
    setSaving(orderId); setError("");
    try {
      await apiRequest(`/administrator/orders/${orderId}/fix-site-mismatch`, { method: "POST", body: { correct_site_id: correctSiteId } });
      onDone("Order reassigned to the correct site.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20, border: "2px solid var(--alert-red)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Orders pointing at the wrong customer's site</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
        This is the actual bug behind "the rate matched one site, the order used another" — an order whose
        site belongs to a different customer entirely. Now prevented at order creation, but existing orders
        created before that fix need to be corrected by hand — pick which of the order's own customer's
        sites was actually intended.
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>None found.</div>
      ) : (
        rows.map((r) => {
          const ownSites = sites.filter((s) => String(s.customer_id) === String(r.order_customer_id));
          return (
            <div key={r.order_id} style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--concrete)" }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                {formatOrderNumber(r.order_id)} — <strong>{r.order_customer_name}</strong> — {new Date(r.order_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })} — {r.ticket_count} ticket{r.ticket_count === 1 ? "" : "s"}
              </div>
              <div style={{ fontSize: 12, color: "var(--alert-red)", marginBottom: 8 }}>
                Currently pointing at "{r.site_name}", which actually belongs to <strong>{r.site_actual_customer_name}</strong>, not {r.order_customer_name}.
              </div>
              {ownSites.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--slate)" }}>{r.order_customer_name} has no sites on file yet — add one on this screen first, then come back here.</div>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    style={{ fontSize: 12 }}
                    value={fixSelections[r.order_id] || ""}
                    onChange={(e) => setFixSelections({ ...fixSelections, [r.order_id]: e.target.value })}
                  >
                    <option value="">Which of {r.order_customer_name}'s sites was this actually for?</option>
                    {ownSites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button style={{ fontSize: 12, padding: "4px 10px" }} disabled={saving === r.order_id} onClick={() => fix(r.order_id)}>
                    {saving === r.order_id ? "Saving..." : "Fix this order"}
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
      <button onClick={onClose}>Close</button>
    </div>
  );
}

function DuplicateSitesReview({ setError, onClose, onDone }) {
  const [rows, setRows] = useState(null);
  const [canonicalBySite, setCanonicalBySite] = useState({}); // group key -> chosen canonical site id
  const [merging, setMerging] = useState(null);

  useEffect(() => {
    apiRequest("/administrator/sites/duplicates")
      .then(setRows)
      .catch((err) => setError(err.message));
  }, []);

  if (rows === null) return <div className="card" style={{ marginBottom: 20, fontSize: 13 }}>Checking for duplicates...</div>;

  const groups = {};
  for (const r of rows) {
    const key = `${r.customer_id}:${r.name.trim().toLowerCase()}`;
    (groups[key] ||= []).push(r);
  }
  const groupList = Object.entries(groups);

  async function merge(groupKey, duplicateId) {
    const canonicalId = canonicalBySite[groupKey];
    if (!canonicalId) { setError("Pick which one to keep first."); return; }
    if (String(canonicalId) === String(duplicateId)) return;
    if (!window.confirm("Merge this site into the one you picked? All its orders, rates, and bookings will move over, and this one will be disabled. This can't be undone automatically.")) return;
    setMerging(duplicateId); setError("");
    try {
      await apiRequest(`/administrator/sites/${duplicateId}/merge-into/${canonicalId}`, { method: "POST" });
      onDone("Sites merged.");
    } catch (err) {
      setError(err.message);
    } finally {
      setMerging(null);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20, border: "2px solid var(--alert-red)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Duplicate sites</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
        Two site records with the same name under the same customer split orders and rates silently
        between them — a rate set up against one never matches deliveries recorded against the other,
        even though both look identical everywhere. Pick which one to keep, then merge the other into it.
      </div>
      {groupList.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No duplicates found.</div>
      ) : (
        groupList.map(([key, group]) => (
          <div key={key} style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--concrete)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{group[0].customer_name} — "{group[0].name}" ({group.length} records)</div>
            <table style={{ fontSize: 12, width: "100%" }}>
              <thead><tr><th></th><th>Site ID</th><th>Status</th><th>Orders</th><th>Rates</th><th>Bookings</th><th>Forecasts</th><th></th></tr></thead>
              <tbody>
                {group.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        type="radio"
                        name={key}
                        checked={String(canonicalBySite[key]) === String(s.id)}
                        onChange={() => setCanonicalBySite({ ...canonicalBySite, [key]: s.id })}
                      />
                    </td>
                    <td>#{s.id}</td>
                    <td>{s.is_active ? "Active" : "Disabled"}</td>
                    <td>{s.order_count}</td>
                    <td>{s.rate_count}</td>
                    <td>{s.booking_count}</td>
                    <td>{s.forecast_count}</td>
                    <td>
                      {String(canonicalBySite[key]) !== String(s.id) && (
                        <button
                          style={{ fontSize: 11, padding: "3px 8px" }}
                          disabled={!canonicalBySite[key] || merging === s.id}
                          onClick={() => merge(key, s.id)}
                        >
                          {merging === s.id ? "Merging..." : "Merge into selected"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>Select the one to keep, then merge each of the others into it.</div>
          </div>
        ))
      )}
      <button onClick={onClose}>Close</button>
    </div>
  );
}

function SeedRateReview({ setError, onClose, onDone }) {
  const [rows, setRows] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    apiRequest("/administrator/rates/review-seed-pollution")
      .then((r) => { setRows(r); setSelected(new Set(r.map((x) => x.id))); })
      .catch((err) => setError(err.message));
  }, []);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} rate(s)? This can't be undone. If any deliveries were already invoiced using one of these, you'll need to add the correct rate and use "Recalculate deliveries" on it afterward.`)) return;
    setDeleting(true); setError("");
    try {
      for (const id of selected) {
        await apiRequest(`/administrator/rates/${id}`, { method: "DELETE" });
      }
      onDone(`Deleted ${selected.size} rate(s).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20, border: "2px solid var(--alert-red)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Review sample rates</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
        A bug in setup meant a placeholder M25 rate (₹4500/₹1500 pump/₹500 waiting) could get silently
        added for any customer that didn't already have an M25 rate — this lists every rate matching
        that exact pattern so you can check and remove the ones that aren't genuinely correct for that
        customer. "Possibly affected invoices" is a rough count of invoices that were priced using this
        exact number — worth checking those against the customer's real rate.
      </div>

      {rows === null ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Checking...</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>None found — nothing to review.</div>
      ) : (
        <>
          <div style={{ overflowX: "auto", marginBottom: 12 }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr><th></th><th>Customer</th><th>Effective from</th><th>Effective to</th><th>Possibly affected invoices</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td>{r.customer_name}</td>
                    <td>{new Date(r.effective_from).toLocaleDateString()}</td>
                    <td>{r.effective_to ? new Date(r.effective_to).toLocaleDateString() : "Open-ended"}</td>
                    <td>{Number(r.possibly_affected_invoices) > 0 ? <span style={{ color: "var(--alert-red)", fontWeight: 600 }}>{r.possibly_affected_invoices}</span> : "0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-danger" onClick={deleteSelected} disabled={deleting || selected.size === 0}>
              {deleting ? "Deleting..." : `Delete ${selected.size} selected`}
            </button>
            <button onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}

function RecalculatePreview({ rateId, setError, onClose, onDone }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest(`/accountant/rates/${rateId}/recalculate-preview`)
      .then((d) => {
        setData(d);
        // Default to everything that's actually actionable, so one click
        // covers the common case — nothing blocked or already-correct gets
        // pre-selected.
        setSelected(new Set(d.tickets.filter((t) => !t.blocked && t.action !== "unchanged").map((t) => t.ticket_id)));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [rateId]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function confirm() {
    if (selected.size === 0) return setError("Select at least one delivery to apply this to.");
    if (!window.confirm(`Apply this rate to ${selected.size} delivery/deliveries? This will create or correct invoices — it cannot be undone automatically.`)) return;
    setSaving(true); setError("");
    try {
      const result = await apiRequest(`/accountant/rates/${rateId}/recalculate-confirm`, {
        method: "POST",
        body: { ticket_ids: Array.from(selected) },
      });
      onDone(`Done — ${result.created} invoice(s) created, ${result.updated} corrected, ${result.skipped} skipped.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="card" style={{ marginBottom: 20, fontSize: 13 }}>Loading affected deliveries...</div>;
  if (!data) return null;

  const creatable = data.tickets.filter((t) => t.action === "create").length;
  const correctable = data.tickets.filter((t) => t.action === "update" && !t.blocked).length;
  const blocked = data.tickets.filter((t) => t.blocked).length;

  return (
    <div className="card" style={{ marginBottom: 20, border: "2px solid var(--rebar)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Recalculate — {data.rate.customer_name} · {data.rate.site_name || "All sites"} · {data.rate.mix_grade_name} · ₹{data.rate.rate_per_m3}/m³
      </div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
        Effective {new Date(data.rate.effective_from).toLocaleDateString()}
        {data.rate.effective_to ? ` to ${new Date(data.rate.effective_to).toLocaleDateString()}` : " onward"} —
        {" "}{creatable} delivery/deliveries with no invoice yet, {correctable} with an invoice that doesn't match this rate.
        {blocked > 0 && <span style={{ color: "var(--alert-red)" }}> {blocked} already have a payment recorded and won't be touched — review those manually.</span>}
      </div>

      {data.tickets.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No completed deliveries fall in this rate's date range.</div>
      ) : (
        <div style={{ overflowX: "auto", marginBottom: 12 }}>
          <table style={{ fontSize: 12 }}>
            <thead>
              <tr><th></th><th>DC No.</th><th>Date</th><th>Qty</th><th>Current</th><th>New</th><th>Action</th></tr>
            </thead>
            <tbody>
              {data.tickets.map((t) => (
                <tr key={t.ticket_id} style={t.blocked ? { opacity: 0.5 } : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      disabled={t.blocked || t.action === "unchanged"}
                      checked={selected.has(t.ticket_id)}
                      onChange={() => toggle(t.ticket_id)}
                    />
                  </td>
                  <td>{t.ticket_number}</td>
                  <td>{new Date(t.ticket_date).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                  <td>{t.qty} m³</td>
                  <td>{t.current_amount != null ? `₹${Number(t.current_amount).toLocaleString("en-IN")}` : "–"}</td>
                  <td style={{ fontWeight: 600 }}>₹{Number(t.new_total_amount).toLocaleString("en-IN")}</td>
                  <td>
                    {t.blocked ? <span className="badge badge-danger" style={{ fontSize: 10 }}>Has payment — skip</span>
                      : t.action === "create" ? <span className="badge badge-warning" style={{ fontSize: 10 }}>Create invoice</span>
                      : t.action === "update" ? <span className="badge badge-info" style={{ fontSize: 10 }}>Correct amount</span>
                      : <span className="badge badge-success" style={{ fontSize: 10 }}>Already correct</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={confirm} disabled={saving || selected.size === 0}>
          {saving ? "Applying..." : `Apply to ${selected.size} selected`}
        </button>
        <button onClick={onClose}>Cancel</button>
      </div>
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
  const [lubricants, setLubricants] = useState([]);
  const [stationForm, setStationForm] = useState({ name: "", location: "" });
  const [equipForm, setEquipForm] = useState({ equipment_type: "pickup_van", name: "" });
  const [lubricantName, setLubricantName] = useState("");
  const [savingStation, setSavingStation] = useState(false);
  const [savingEquip, setSavingEquip] = useState(false);
  const [savingLubricant, setSavingLubricant] = useState(false);

  async function load() {
    try {
      const [s, e, l] = await Promise.all([
        apiRequest("/administrator/fuel-stations"), apiRequest("/administrator/equipment"), apiRequest("/administrator/lubricant-types"),
      ]);
      setStations(s); setEquipment(e); setLubricants(l);
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

  async function addLubricant(e) {
    e.preventDefault();
    if (!lubricantName.trim()) return;
    setSavingLubricant(true); setError("");
    try {
      await apiRequest("/administrator/lubricant-types", { method: "POST", body: { name: lubricantName } });
      setLubricantName("");
      load();
    } catch (err) { setError(err.message); } finally { setSavingLubricant(false); }
  }

  async function toggleLubricant(id, is_active) {
    setError("");
    try {
      await apiRequest(`/administrator/lubricant-types/${id}/status`, { method: "PATCH", body: { is_active } });
      load();
    } catch (err) { setError(err.message); }
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

  async function setAsPlant(id) {
    setError("");
    try {
      await apiRequest(`/administrator/fuel-stations/${id}/set-plant`, { method: "POST" });
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
                <td>{s.name} {s.is_plant && <span className="badge badge-success" style={{ marginLeft: 6, fontSize: 10 }}>Plant</span>}</td>
                <td>{s.location || "–"}</td>
                <td>{s.is_active ? "Active" : "Inactive"}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  {!s.is_plant && (
                    <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => setAsPlant(s.id)}>
                      Set as plant
                    </button>
                  )}
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

      <div style={{ fontSize: 13, fontWeight: 600, margin: "20px 0 8px" }}>Lubricant types</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <table style={{ fontSize: 13 }}>
          <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {lubricants.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>{l.is_active ? "Active" : "Inactive"}</td>
                <td>
                  <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => toggleLubricant(l.id, !l.is_active)}>
                    {l.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
            {lubricants.length === 0 && <tr><td colSpan={3} style={{ color: "var(--slate)" }}>None yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={addLubricant} className="field-input card" style={{ display: "flex", gap: 8, fontSize: 13, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--slate)" }}>New lubricant name</div>
          <input value={lubricantName} onChange={(e) => setLubricantName(e.target.value)} placeholder="e.g. Transmission fluid" required />
        </div>
        <button type="submit" disabled={savingLubricant}>{savingLubricant ? "Saving..." : "Add"}</button>
      </form>
    </div>
  );
}

// Plant location(s) — the geofence anchor the scheduled check
// (checkGeofenceEvents in scheduledChecks.js) uses to auto-detect Plant Out /
// Plant In and nudge drivers to confirm. Exactly one location is "active" at
// a time; keeping past ones around (inactive) is harmless and lets you swap
// back if a plant move turns out to be temporary.
export function PlantLocationsPanel({ setError }) {
  const [plants, setPlants] = useState([]);
  const [form, setForm] = useState({ name: "Main plant", latitude: "", longitude: "", geofence_radius_m: 200 });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setPlants(await apiRequest("/administrator/plant-locations")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setForm((f) => ({ ...f, latitude: pos.coords.latitude, longitude: pos.coords.longitude })),
      () => setError("Couldn't get your current location — enter latitude/longitude manually.")
    );
  }

  async function addPlant(e) {
    e.preventDefault();
    if (form.latitude === "" || form.longitude === "") {
      setError("Latitude and longitude are required.");
      return;
    }
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/plant-locations", { method: "POST", body: form });
      setForm({ name: "Main plant", latitude: "", longitude: "", geofence_radius_m: 200 });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function setActive(id) {
    setError("");
    try {
      await apiRequest(`/administrator/plant-locations/${id}/set-active`, { method: "POST" });
      load();
    } catch (err) { setError(err.message); }
  }

  async function remove(p) {
    if (!window.confirm(`Delete plant location "${p.name}"? This can't be undone.`)) return;
    setError("");
    try {
      await apiRequest(`/administrator/plant-locations/${p.id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  // Round 120, item 3a — the auto plant-out-delay report (scheduledChecks.js)
  // depends entirely on an active row here existing; with rows present but
  // none marked active (someone added one but never hit "Set active", or the
  // active one got deleted), the whole geofence pipeline goes silently quiet
  // — no error anywhere, it just never fires. The old empty-table message
  // only covered zero rows total; this also covers "rows exist, none active."
  const hasActive = plants.some((p) => p.is_active);

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Plant location (geofence anchor)</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
        Used to auto-detect when a truck leaves or returns to the plant, so drivers get a nudge to confirm Plant Out / Plant In.
        This never confirms anything by itself — the driver still has to tap it.
      </div>
      {plants.length > 0 && !hasActive && (
        <div style={{ fontSize: 12.5, color: "var(--alert-red)", background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          No plant location is currently set active — auto plant-out/plant-in detection (and the auto delay report) is completely off
          until you tap "Set active" on one below.
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Name</th><th>Latitude</th><th>Longitude</th><th>Radius (m)</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {plants.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.latitude}</td>
                <td>{p.longitude}</td>
                <td>{p.geofence_radius_m}</td>
                <td>{p.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-neutral">Inactive</span>}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  {!p.is_active && (
                    <button style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => setActive(p.id)}>
                      Set active
                    </button>
                  )}
                  <button className="btn-danger" style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => remove(p)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {plants.length === 0 && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No plant location set yet — geofence-based nudges are off until one is added.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={addPlant} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
        <div><div style={{ color: "var(--slate)" }}>Name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Geofence radius (m)</div><input type="number" value={form.geofence_radius_m} onChange={(e) => setForm({ ...form, geofence_radius_m: e.target.value })} /></div>
        <div><div style={{ color: "var(--slate)" }}>Latitude</div><input type="number" step="any" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Longitude</div><input type="number" step="any" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} required /></div>
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="button" onClick={useMyLocation}>Use my current location</button>
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Add plant location"}</button>
        </div>
      </form>
    </div>
  );
}

export function OrdersPanel({ setError, initialEditId }) {
  const [orders, setOrders] = useState([]);
  const [mixGrades, setMixGrades] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [qcEngineers, setQcEngineers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ order_quantity_m3: "", scheduled_batching_time: "", required_at_site_time: "", remarks: "", mix_grade_id: "", pump_requirement: "without_pump", pump_id: "", assigned_qc_engineer_id: "" });
  const [rescheduling, setRescheduling] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ new_order_date: "", new_scheduled_batching_time: "", reason: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const rows = await apiRequest("/administrator/orders");
      setOrders(rows);
      if (initialEditId) {
        const target = rows.find((o) => String(o.id) === String(initialEditId));
        if (target && !["cancelled", "closed", "completed"].includes(target.status)) {
          startEdit(target);
          setTimeout(() => document.getElementById(`order-row-${target.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
        }
      }
    } catch (err) { setError(err.message); }
  }
  useEffect(() => {
    load();
    apiRequest("/master/mix-grades").then(setMixGrades).catch((err) => setError(err.message));
    apiRequest("/master/pumps").then(setPumps).catch((err) => setError(err.message));
    apiRequest("/master/qc-engineers").then(setQcEngineers).catch((err) => setError(err.message));
  }, []);

  function startEdit(o) {
    setEditing(o.id);
    setForm({
      order_quantity_m3: o.order_quantity_m3,
      scheduled_batching_time: o.scheduled_batching_time || "",
      required_at_site_time: o.required_at_site_time || "",
      remarks: "",
      mix_grade_id: o.mix_grade_id || "",
      pump_requirement: o.pump_requirement || "without_pump",
      pump_id: o.pump_id || "",
      assigned_qc_engineer_id: o.assigned_qc_engineer_id || "",
    });
  }

  async function saveEdit(id) {
    // Round 97, item 5 — the pump can be corrected here regardless of
    // whether a delivery ticket exists (unlike grade, which stays locked
    // once a DN is raised): during pouring the pump actually used can
    // change for operational reasons, and this needs to stay editable.
    if (form.pump_requirement !== "without_pump" && !form.pump_id) {
      setError("Select which pump is assigned to this order.");
      return;
    }
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
          <tr><th>Date</th><th>Customer</th><th>Site</th><th>Grade</th><th>Qty (m³)</th><th>Pump</th><th>Required at site</th><th>QC Engineer</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <Fragment key={o.id}>
              <tr id={`order-row-${o.id}`} style={editing === o.id ? { background: "var(--amber-bg)" } : undefined}>
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
                <td>
                  {editing === o.id ? (
                    o.has_tickets ? (
                      <span title="A delivery ticket already exists for this order, so the grade is locked.">
                        {o.mix_grade_name} <span style={{ fontSize: 11, color: "var(--slate)" }}>(locked)</span>
                      </span>
                    ) : (
                      <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })}>
                        {mixGrades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    )
                  ) : o.mix_grade_name}
                </td>
                <td>
                  {editing === o.id ? (
                    <input type="number" value={form.order_quantity_m3} onChange={(e) => setForm({ ...form, order_quantity_m3: e.target.value })} style={{ width: 70 }} />
                  ) : o.order_quantity_m3}
                </td>
                <td>
                  {editing === o.id ? (
                    // Deliberately never locked by has_tickets — the pump
                    // actually used can change mid-pour for operational
                    // reasons, so this stays editable even after a delivery
                    // ticket exists (round 97, item 5).
                    <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <select
                        value={form.pump_requirement}
                        onChange={(e) => setForm({ ...form, pump_requirement: e.target.value, pump_id: "" })}
                        style={{ fontSize: 12 }}
                      >
                        <option value="without_pump">Without pump</option>
                        <option value="boom_pump">Boom pump</option>
                        <option value="line_pump">Line pump</option>
                      </select>
                      {form.pump_requirement !== "without_pump" && (
                        <select value={form.pump_id} onChange={(e) => setForm({ ...form, pump_id: e.target.value })} style={{ fontSize: 12 }}>
                          <option value="">Select pump</option>
                          {pumps.filter((p) => p.pump_type === form.pump_requirement).map((p) => (
                            <option key={p.id} value={p.id}>{p.pump_code}</option>
                          ))}
                        </select>
                      )}
                    </span>
                  ) : o.pump_requirement && o.pump_requirement !== "without_pump" ? (o.pump_code || "—") : "—"}
                </td>
                <td>
                  {editing === o.id ? (
                    // Round 119, post-ship again — round 7: this was
                    // captured on Create Order / Convert Booking but had no
                    // correction path afterward at all — a mistyped time
                    // (an easy fat-finger on a plain time input) could only
                    // be fixed with a raw DB edit. Corrected here the same
                    // lightweight way as QC Engineer, below — no "reason"
                    // required, since it's the customer-facing display time,
                    // not the actual batching/dispatch schedule (that stays
                    // behind the heavier Reschedule flow, which does require one).
                    <input type="time" value={form.required_at_site_time} onChange={(e) => setForm({ ...form, required_at_site_time: e.target.value })} style={{ fontSize: 12 }} />
                  ) : (o.required_at_site_time || <span style={{ color: "var(--slate)" }}>—</span>)}
                </td>
                <td>
                  {editing === o.id ? (
                    // Round 119, post-ship again, item 1 — lets Admin/Manager
                    // pick a specific QC Engineer for this order's "your team
                    // on this order" card in the customer portal, instead of
                    // the app always resolving the same one by role (there's
                    // more than one QC Engineer on staff, unlike Manager).
                    // Left blank falls back to the old role-based pick.
                    <select value={form.assigned_qc_engineer_id} onChange={(e) => setForm({ ...form, assigned_qc_engineer_id: e.target.value })} style={{ fontSize: 12 }}>
                      <option value="">(default — any QC Engineer)</option>
                      {qcEngineers.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                    </select>
                  ) : o.qc_engineer_name || <span style={{ color: "var(--slate)" }}>—</span>}
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
                  <td colSpan={10}>
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
          {orders.length === 0 && <tr><td colSpan={10} style={{ color: "var(--slate)" }}>No orders yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function TicketsPanel({ setError, showChallan }) {
  const [tickets, setTickets] = useState([]);
  const [editing, setEditing] = useState(null);
  const [qty, setQty] = useState("");
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(null);

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

  async function printChallan(id) {
    setPrinting(id); setError("");
    try {
      const { generateDeliveryChallanPdf } = await import("./deliveryChallanPdf.js");
      await generateDeliveryChallanPdf(id);
    } catch (err) { setError(err.message); } finally { setPrinting(null); }
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
                    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button onClick={() => { setEditing(t.id); setQty(t.loaded_quantity_m3); }}>Edit</button>
                      <button className="btn-danger" onClick={() => cancelTicket(t.id)}>Cancel ticket</button>
                      {showChallan && (
                        <button onClick={() => printChallan(t.id)} disabled={printing === t.id}>
                          {printing === t.id ? "Generating…" : "Delivery Challan"}
                        </button>
                      )}
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

// Site Contacts directory (round 96, item 7) — Administrator-only browse/
// correct screen. Day-to-day additions happen from Create Order itself
// (autofill + auto-save of anything newly typed); this is for fixing a typo
// or retiring a contact who's moved on, per the business's own answer.
export function SiteContactsPanel({ setError }) {
  const [contacts, setContacts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setContacts(await apiRequest("/administrator/site-contacts")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function startEdit(c) {
    setEditing(c.id);
    setForm({ contact_name: c.contact_name, phone_number: c.phone_number, role_label: c.role_label || "" });
  }

  async function saveEdit(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/administrator/site-contacts/${id}`, { method: "PATCH", body: form });
      setEditing(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function toggleActive(id, is_active) {
    setError("");
    try {
      await apiRequest(`/administrator/site-contacts/${id}`, { method: "PATCH", body: { is_active } });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <table>
        <thead><tr><th>Customer</th><th>Site</th><th>Name</th><th>Role</th><th>Phone</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {contacts.map((c) => (
            <tr key={c.id}>
              <td>{c.customer_name}</td>
              <td>{c.site_name}</td>
              {editing === c.id ? (
                <>
                  <td><input value={form.contact_name} onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))} style={{ width: 120 }} /></td>
                  <td><input value={form.role_label} onChange={(e) => setForm((f) => ({ ...f, role_label: e.target.value }))} style={{ width: 100 }} /></td>
                  <td><input value={form.phone_number} onChange={(e) => setForm((f) => ({ ...f, phone_number: e.target.value }))} style={{ width: 110 }} /></td>
                  <td>{c.is_active ? "Active" : "Inactive"}</td>
                  <td style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => saveEdit(c.id)} disabled={saving}>Save</button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td>{c.contact_name}</td>
                  <td>{c.role_label || "—"}</td>
                  <td>{c.phone_number}</td>
                  <td>{c.is_active ? "Active" : "Inactive"}</td>
                  <td style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => startEdit(c)}>Edit</button>
                    <button onClick={() => toggleActive(c.id, !c.is_active)}>{c.is_active ? "Deactivate" : "Reactivate"}</button>
                  </td>
                </>
              )}
            </tr>
          ))}
          {contacts.length === 0 && <tr><td colSpan={7} style={{ color: "var(--slate)" }}>None yet — contacts are added automatically the first time they're typed on an order.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Monthly production target (round 96, item 8) — Administrator sets it here;
// the Manager dashboard's Achieved %/Balance/Required-per-day KPI reads
// whatever's on file for the current month via GET /orders/dashboard.
export function ProductionTargetPanel({ setError }) {
  const now = new Date();
  const [history, setHistory] = useState([]);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [targetM3, setTargetM3] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    try { setHistory(await apiRequest("/administrator/production-targets")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/administrator/production-targets", { method: "POST", body: { year, month, target_m3: targetM3 } });
      setNotice("Saved.");
      setTargetM3("");
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      <form onSubmit={submit} className="field-input card" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", fontSize: 13, marginBottom: 12 }}>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Month</div>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Year</div>
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} />
        </div>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Target (m³)</div>
          <input type="number" value={targetM3} onChange={(e) => setTargetM3(e.target.value)} required style={{ width: 120 }} />
        </div>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
        {notice && <span style={{ color: "var(--signal-green)" }}>{notice}</span>}
      </form>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>History</div>
        <table>
          <thead><tr><th>Month</th><th>Target</th><th>Last updated</th></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>{MONTH_NAMES[h.month - 1]} {h.year}</td>
                <td>{h.target_m3} m³</td>
                <td>{new Date(h.updated_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
              </tr>
            ))}
            {history.length === 0 && <tr><td colSpan={3} style={{ color: "var(--slate)" }}>No target set yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Round 98, item 10 — Maintenance action points, Administrator-only (the
// due list / logging / repair flow built from these lives at
// Manager+Administrator's "Maintenance" screen — see pages/Maintenance.jsx).
export function MaintenanceActionPointsPanel({ setError }) {
  const [points, setPoints] = useState([]);
  const [form, setForm] = useState({ name: "", interval_days: "", interval_hours: "" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", interval_days: "", interval_hours: "", is_active: true });

  async function load() {
    try { setPoints(await apiRequest("/maintenance/action-points")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!form.interval_days && !form.interval_hours) return setError("Set at least one of interval days / interval hours.");
    setSaving(true); setError("");
    try {
      await apiRequest("/maintenance/action-points", { method: "POST", body: form });
      setForm({ name: "", interval_days: "", interval_hours: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function startEdit(p) {
    setEditing(p.id);
    setEditForm({ name: p.name, interval_days: p.interval_days || "", interval_hours: p.interval_hours || "", is_active: p.is_active });
  }

  async function saveEdit(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/maintenance/action-points/${id}`, { method: "PATCH", body: editForm });
      setEditing(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      <form onSubmit={add} className="field-input card" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", fontSize: 13, marginBottom: 12 }}>
        <div style={{ flex: "1 1 220px" }}>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Action point name</div>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Mixer arm replacement" required />
        </div>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Interval (days)</div>
          <input type="number" value={form.interval_days} onChange={(e) => setForm({ ...form, interval_days: e.target.value })} style={{ width: 100 }} />
        </div>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Interval (hours)</div>
          <input type="number" value={form.interval_hours} onChange={(e) => setForm({ ...form, interval_hours: e.target.value })} style={{ width: 100 }} />
        </div>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Add"}</button>
      </form>
      <p style={{ fontSize: 11.5, color: "var(--slate)", margin: "0 0 12px" }}>
        Whichever interval trips first applies. An action point applies to every active truck (no per-vehicle overrides in this first version).
      </p>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead><tr><th>Name</th><th>Days</th><th>Hours</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.id}>
                {editing === p.id ? (
                  <>
                    <td><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} style={{ width: 180 }} /></td>
                    <td><input type="number" value={editForm.interval_days} onChange={(e) => setEditForm({ ...editForm, interval_days: e.target.value })} style={{ width: 70 }} /></td>
                    <td><input type="number" value={editForm.interval_hours} onChange={(e) => setEditForm({ ...editForm, interval_hours: e.target.value })} style={{ width: 70 }} /></td>
                    <td>
                      <select value={editForm.is_active} onChange={(e) => setEditForm({ ...editForm, is_active: e.target.value === "true" })}>
                        <option value="true">Active</option>
                        <option value="false">Inactive</option>
                      </select>
                    </td>
                    <td style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => saveEdit(p.id)} disabled={saving}>Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{p.name}</td>
                    <td>{p.interval_days || "—"}</td>
                    <td>{p.interval_hours || "—"}</td>
                    <td><span className={`badge ${p.is_active ? "badge-success" : "badge-neutral"}`}>{p.is_active ? "Active" : "Inactive"}</span></td>
                    <td><button style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => startEdit(p)}>Edit</button></td>
                  </>
                )}
              </tr>
            ))}
            {points.length === 0 && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>No action points defined yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Round 118 — which mix design a customer's order for a given grade actually
// resolves to (see mix_design_assignments in schema.sql). One design is
// routinely shared across several customers, so this list is customer-
// centric — assigning the same design to a second customer doesn't create a
// second design, just a second row here, both flagged "Shared" once they
// point at the same design.
export function MixDesignAssignmentsPanel({ setError }) {
  const [assignments, setAssignments] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [grades, setGrades] = useState([]);
  const [designs, setDesigns] = useState([]);
  const [form, setForm] = useState({ customer_id: "", mix_grade_id: "", mix_design_id: "" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const [a, c, g] = await Promise.all([
        apiRequest("/administrator/mix-design-assignments"),
        apiRequest("/administrator/customers"),
        apiRequest("/master/mix-grades"),
      ]);
      setAssignments(a);
      setCustomers(c);
      setGrades(g);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!form.mix_grade_id) { setDesigns([]); return; }
    apiRequest(`/lab-technician/mix-designs?status=approved&mix_grade_id=${form.mix_grade_id}`)
      .then(setDesigns)
      .catch((err) => setError(err.message));
  }, [form.mix_grade_id]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/administrator/mix-design-assignments", { method: "POST", body: form });
      setNotice("Saved.");
      setForm({ customer_id: "", mix_grade_id: "", mix_design_id: "" });
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function remove(id) {
    setError("");
    try {
      await apiRequest(`/administrator/mix-design-assignments/${id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  const designCounts = {};
  assignments.forEach((a) => { designCounts[a.mix_design_id] = (designCounts[a.mix_design_id] || 0) + 1; });

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
        A customer's order only ever records a grade — this resolves which specific, approved mix
        design that grade actually batches to for them. No row for a customer+grade means the
        grade's standard design is used (set from the Lab Technician's Mix Designs list).
      </div>
      <form onSubmit={submit} className="field-input card" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", fontSize: 13, marginBottom: 12 }}>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Customer</div>
          <select value={form.customer_id} onChange={(e) => setForm((f) => ({ ...f, customer_id: e.target.value }))} required style={{ minWidth: 160 }}>
            <option value="">Select</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Grade</div>
          <select value={form.mix_grade_id} onChange={(e) => setForm((f) => ({ ...f, mix_grade_id: e.target.value, mix_design_id: "" }))} required>
            <option value="">Select</option>
            {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Mix design</div>
          <select value={form.mix_design_id} onChange={(e) => setForm((f) => ({ ...f, mix_design_id: e.target.value }))} required disabled={!form.mix_grade_id} style={{ minWidth: 160 }}>
            <option value="">{form.mix_grade_id ? "Select" : "Pick a grade first"}</option>
            {designs.map((d) => <option key={d.id} value={d.id}>{d.design_ref_code}{d.mix_description ? ` — ${d.mix_description}` : ""}</option>)}
          </select>
          {form.mix_grade_id && designs.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>No approved designs for this grade yet.</div>
          )}
        </div>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Assign"}</button>
        {notice && <span style={{ color: "var(--signal-green)" }}>{notice}</span>}
      </form>

      <div className="card">
        <table>
          <thead><tr><th>Customer</th><th>Grade</th><th>Assigned mix design</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id}>
                <td>{a.customer_name}</td>
                <td>{a.mix_grade_name}</td>
                <td>
                  {a.design_ref_code}{" "}
                  {Number(a.design_shared_count) > 1 ? (
                    <span className="badge" style={{ background: "var(--info-bg, #E3EEF4)", color: "var(--info, #2A6F97)" }}>
                      Shared · {a.design_shared_count} customers
                    </span>
                  ) : (
                    <span className="badge badge-success">Custom</span>
                  )}
                </td>
                <td>{new Date(a.assigned_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                <td><button style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => remove(a.id)}>Remove</button></td>
              </tr>
            ))}
            {assignments.length === 0 && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>No customer-specific assignments yet — everyone gets the standard design per grade.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Mix design approval, reachable from Administrator/Manager (not just the
// Lab Technician's own dashboard) — a draft always needs a second, different
// person to sign off, and that second person is routinely a Manager/QC lead
// rather than another Lab Technician. Read/approve only; drafting a new
// design (with the full admixtures/moisture/materials form) stays on the
// Lab Technician screen, not duplicated here.
export function MixDesignsPanel({ setError }) {
  const { user } = useAuth();
  const [designs, setDesigns] = useState([]);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function load() {
    try { setDesigns(await apiRequest("/lab-technician/mix-designs")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function approve(id) {
    setBusyId(id); setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/mix-designs/${id}/approve`, { method: "POST" });
      setNotice("Approved.");
      load();
    } catch (err) { setError(err.message); } finally { setBusyId(null); }
  }

  async function viewPdf(id) {
    setError("");
    try {
      const data = await apiRequest(`/lab-technician/mix-designs/${id}/pdf-data`);
      await generateMixDesignPdf(data);
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
        A draft mix design needs a second, different person to approve it before it can be
        assigned to customers or used as a grade's standard — the design's own creator can't
        approve their own draft. New designs are created from the Lab Technician screen.
      </div>
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}
      <div className="card">
        <table>
          <thead>
            <tr><th>Design</th><th>Grade</th><th>Status</th><th>Created by</th><th>Approved by</th><th></th></tr>
          </thead>
          <tbody>
            {designs.map((d) => {
              const isOwnDraft = d.status === "draft" && user && String(d.created_by) === String(user.id);
              return (
                <tr key={d.id}>
                  <td>{d.design_ref_code}{d.mix_description ? <div style={{ fontSize: 11, color: "var(--slate)" }}>{d.mix_description}</div> : null}</td>
                  <td>{d.mix_grade_name}</td>
                  <td>
                    <span className={`badge ${d.status === "approved" ? "badge-success" : "badge-neutral"}`}>
                      {d.status === "approved" ? "Approved" : "Draft"}
                    </span>
                    {Number(d.assigned_customer_count) > 0 && (
                      <span style={{ fontSize: 11, color: "var(--slate)", marginLeft: 6 }}>
                        · {d.assigned_customer_count} customer{Number(d.assigned_customer_count) === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  <td>{d.created_by_name}</td>
                  <td>{d.approved_by_name || "—"}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    {d.status === "draft" && (
                      <button
                        style={{ fontSize: 12, padding: "4px 10px" }}
                        disabled={isOwnDraft || busyId === d.id}
                        title={isOwnDraft ? "You created this draft — another person needs to approve it." : undefined}
                        onClick={() => approve(d.id)}
                      >
                        {busyId === d.id ? "Approving..." : "Approve"}
                      </button>
                    )}
                    <button style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => viewPdf(d.id)}>View PDF</button>
                  </td>
                </tr>
              );
            })}
            {designs.length === 0 && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No mix designs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
