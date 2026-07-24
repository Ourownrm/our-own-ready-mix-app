import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export function CreateLeadForm({ setError, onDone }) {
  const [salesExecs, setSalesExecs] = useState([]);
  const [form, setForm] = useState({
    prospect_name: "", contact_person: "", contact_phone: "",
    site_location: "", mix_grade_interest: "", estimated_qty_m3: "", assigned_to: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiRequest("/master/sales-executives").then(setSalesExecs).catch((err) => setError(err.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/sales/leads", { method: "POST", body: form });
      setForm({ prospect_name: "", contact_person: "", contact_phone: "", site_location: "", mix_grade_interest: "", estimated_qty_m3: "", assigned_to: "" });
      if (onDone) onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
      <div><div style={{ color: "var(--slate)" }}>Prospect name</div><input value={form.prospect_name} onChange={(e) => setForm({ ...form, prospect_name: e.target.value })} required /></div>
      <div>
        <div style={{ color: "var(--slate)" }}>Assign to</div>
        <select value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} required>
          <option value="">Select salesperson</option>
          {salesExecs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div><div style={{ color: "var(--slate)" }}>Contact person</div><input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Contact phone</div><input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Site / location</div><input value={form.site_location} onChange={(e) => setForm({ ...form, site_location: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Grade interested in</div><input value={form.mix_grade_interest} onChange={(e) => setForm({ ...form, mix_grade_interest: e.target.value })} placeholder="e.g. M25" /></div>
      <div><div style={{ color: "var(--slate)" }}>Estimated qty (m³)</div><input type="number" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} /></div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Assign lead"}</button></div>
    </form>
  );
}

export function BookingsQueue({ setError }) {
  const [bookings, setBookings] = useState([]);
  const [converting, setConverting] = useState(null);

  async function load() {
    try {
      setBookings(await apiRequest("/sales/bookings"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function decline(id) {
    const reason = window.prompt("Reason for declining this booking (optional):");
    if (reason === null) return;
    setError("");
    try {
      await apiRequest(`/sales/bookings/${id}/decline`, { method: "POST", body: { declined_reason: reason } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (converting) {
    return (
      <ConvertBookingForm
        booking={converting}
        setError={setError}
        onDone={() => { setConverting(null); load(); }}
        onCancel={() => setConverting(null)}
      />
    );
  }

  const pending = bookings.filter((b) => b.status === "pending");

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        Pending bookings
        {pending.length > 0 && <span className="badge badge-warning" style={{ marginLeft: 8 }}>{pending.length}</span>}
      </div>
      {pending.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No bookings waiting on you.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map((b) => (
            <div key={b.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ fontWeight: 600 }}>{b.customer_name}</div>
              <div style={{ color: "var(--slate)" }}>
                {b.site_name || "Site TBD"} · {b.mix_grade_name || "Grade TBD"} · {b.estimated_qty_m3 ? `${b.estimated_qty_m3} m³` : "Qty TBD"}
                {b.preferred_date ? ` · Preferred: ${new Date(b.preferred_date).toLocaleDateString([], { day: "2-digit", month: "short" })}` : ""}
              </div>
              {b.notes && <div style={{ color: "var(--slate)", fontStyle: "italic" }}>"{b.notes}"</div>}
              <div style={{ color: "var(--slate)", fontSize: 11 }}>From {b.requested_by_name}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn-primary" style={{ flex: 1, fontSize: 12 }} onClick={() => setConverting(b)}>Convert to order</button>
                <button className="btn-danger" style={{ flex: 1, fontSize: 12 }} onClick={() => decline(b.id)}>Decline</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConvertBookingForm({ booking, setError, onDone, onCancel }) {
  const [sites, setSites] = useState([]);
  const [mixGrades, setMixGrades] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [form, setForm] = useState({
    order_date: booking.preferred_date ? booking.preferred_date.slice(0, 10) : new Date().toISOString().slice(0, 10),
    scheduled_batching_time: "08:00",
    truck_dispatch_interval_minutes: 20,
    site_id: booking.site_id || "",
    mix_grade_id: booking.mix_grade_id || "",
    order_quantity_m3: booking.estimated_qty_m3 || "",
    pump_requirement: "without_pump",
    pump_id: "",
    site_technician_required: false,
    cube_samples_required: 3,
    assigned_site_supervisor_id: "",
    site_contact_number: "",
    casting_location: "",
    remarks: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([apiRequest("/master/sites"), apiRequest("/master/mix-grades"), apiRequest("/master/site-supervisors"), apiRequest("/master/pumps")])
      .then(([s, m, sup, p]) => { setSites(s); setMixGrades(m); setSupervisors(sup); setPumps(p); })
      .catch((err) => setError(err.message));
  }, []);

  const sitesForCustomer = sites.filter((s) => String(s.customer_id) === String(booking.customer_id));

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest(`/sales/bookings/${booking.id}/convert`, { method: "POST", body: form });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Convert booking to order</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>{booking.customer_name}</div>
      <form onSubmit={submit} className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
        <div><div style={{ color: "var(--slate)" }}>Order date</div><input type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Scheduled batching time</div><input type="time" value={form.scheduled_batching_time} onChange={(e) => setForm({ ...form, scheduled_batching_time: e.target.value })} required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site</div>
          <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} required>
            <option value="">Select</option>
            {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Grade</div>
          <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })} required>
            <option value="">Select</option>
            {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div><div style={{ color: "var(--slate)" }}>Order quantity (m³)</div><input type="number" value={form.order_quantity_m3} onChange={(e) => setForm({ ...form, order_quantity_m3: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Truck dispatch interval (min)</div><input type="number" value={form.truck_dispatch_interval_minutes} onChange={(e) => setForm({ ...form, truck_dispatch_interval_minutes: e.target.value })} required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Pump requirement</div>
          <select value={form.pump_requirement} onChange={(e) => setForm({ ...form, pump_requirement: e.target.value })}>
            <option value="without_pump">Without pump</option>
            <option value="with_pump">With pump</option>
          </select>
        </div>
        {form.pump_requirement === "with_pump" && (
          <div>
            <div style={{ color: "var(--slate)" }}>Pump</div>
            <select value={form.pump_id} onChange={(e) => setForm({ ...form, pump_id: e.target.value })}>
              <option value="">Any available</option>
              {pumps.map((p) => <option key={p.id} value={p.id}>{p.pump_code}</option>)}
            </select>
          </div>
        )}
        <div><div style={{ color: "var(--slate)" }}>Site contact number</div><input value={form.site_contact_number} onChange={(e) => setForm({ ...form, site_contact_number: e.target.value })} required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site supervisor</div>
          <select value={form.assigned_site_supervisor_id} onChange={(e) => setForm({ ...form, assigned_site_supervisor_id: e.target.value })}>
            <option value="">None (small site)</option>
            {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ color: "var(--slate)" }}>Remarks</div>
          <textarea rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </div>
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving} style={{ flex: 1 }}>{saving ? "Creating..." : "Create order"}</button>
          <button type="button" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
