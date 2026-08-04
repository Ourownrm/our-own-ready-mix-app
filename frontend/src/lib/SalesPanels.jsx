import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export function CreateLeadForm({ setError, onDone }) {
  const [salesExecs, setSalesExecs] = useState([]);
  const [form, setForm] = useState({
    prospect_name: "", contact_person: "", contact_phone: "",
    site_location: "", mix_grade_interest: "", estimated_qty_m3: "", assigned_to: "",
    site_latitude: "", site_longitude: "",
  });
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    apiRequest("/master/sales-executives").then(setSalesExecs).catch((err) => setError(err.message));
  }, []);

  function useCurrentLocation() {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, site_latitude: pos.coords.latitude.toFixed(7), site_longitude: pos.coords.longitude.toFixed(7) }));
        setLocating(false);
      },
      () => { setError("Couldn't get current location — enter coordinates manually, or paste from Google Maps."); setLocating(false); }
    );
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/sales/leads", { method: "POST", body: form });
      setForm({ prospect_name: "", contact_person: "", contact_phone: "", site_location: "", mix_grade_interest: "", estimated_qty_m3: "", assigned_to: "", site_latitude: "", site_longitude: "" });
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
      <div><div style={{ color: "var(--slate)" }}>Site / location (text)</div><input value={form.site_location} onChange={(e) => setForm({ ...form, site_location: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Grade interested in</div><input value={form.mix_grade_interest} onChange={(e) => setForm({ ...form, mix_grade_interest: e.target.value })} placeholder="e.g. M25" /></div>
      <div><div style={{ color: "var(--slate)" }}>Estimated qty (m³)</div><input type="number" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} /></div>
      <div></div>
      <div><div style={{ color: "var(--slate)" }}>Site latitude</div><input type="number" step="any" value={form.site_latitude} onChange={(e) => setForm({ ...form, site_latitude: e.target.value })} placeholder="e.g. 8.5241" /></div>
      <div><div style={{ color: "var(--slate)" }}>Site longitude</div><input type="number" step="any" value={form.site_longitude} onChange={(e) => setForm({ ...form, site_longitude: e.target.value })} placeholder="e.g. 76.9366" /></div>
      <div style={{ gridColumn: "1 / -1" }}>
        <button type="button" onClick={useCurrentLocation} disabled={locating} style={{ fontSize: 12, padding: "6px 10px" }}>
          {locating ? "Getting location..." : "Use my current location"}
        </button>
        <span style={{ fontSize: 11, color: "var(--slate)", marginLeft: 8 }}>
          Or paste coordinates from Google Maps (long-press the pin on the site → copy the numbers shown)
        </span>
      </div>
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
                {b.preferred_date ? ` · Preferred: ${new Date(b.preferred_date).toLocaleDateString([], { day: "2-digit", month: "short" })}${b.preferred_time ? ` ${b.preferred_time.slice(0, 5)}` : ""}` : ""}
              </div>
              {b.notes && <div style={{ color: "var(--slate)", fontStyle: "italic" }}>"{b.notes}"</div>}
              {(b.site_latitude && b.site_longitude) && (
                <a href={`https://maps.google.com/?q=${b.site_latitude},${b.site_longitude}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  View site location
                </a>
              )}
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
    scheduled_batching_time: booking.preferred_time ? booking.preferred_time.slice(0, 5) : "08:00",
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
  const [rateInfo, setRateInfo] = useState(null);
  const [pumpChargeDecision, setPumpChargeDecision] = useState(null);
  const [partLoadDecision, setPartLoadDecision] = useState(null);

  useEffect(() => {
    Promise.all([apiRequest("/master/sites"), apiRequest("/master/mix-grades"), apiRequest("/master/site-supervisors"), apiRequest("/master/pumps")])
      .then(([s, m, sup, p]) => { setSites(s); setMixGrades(m); setSupervisors(sup); setPumps(p); })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setPumpChargeDecision(null); setPartLoadDecision(null);
    if (!form.mix_grade_id || !form.site_id) { setRateInfo(null); return; }
    apiRequest(`/master/rate-check?customer_id=${booking.customer_id}&mix_grade_id=${form.mix_grade_id}&site_id=${form.site_id}&date=${form.order_date}`)
      .then(setRateInfo)
      .catch(() => setRateInfo(null));
  }, [form.mix_grade_id, form.site_id, form.order_date]);

  const sitesForCustomer = sites.filter((s) => String(s.customer_id) === String(booking.customer_id));

  const pumpChargeAmount = form.pump_requirement === "boom_pump" ? rateInfo?.boom_pump_charge : form.pump_requirement === "line_pump" ? rateInfo?.line_pump_charge : null;
  const pumpMinQty = form.pump_requirement === "boom_pump" ? rateInfo?.boom_pump_min_qty_m3 : rateInfo?.line_pump_min_qty_m3;
  const needsPumpDecision = form.pump_requirement !== "without_pump" && rateInfo;
  const partLoadThreshold = Number(rateInfo?.part_load_min_qty_m3 ?? 5);
  const partLoadShortfall = form.order_quantity_m3 ? partLoadThreshold - Number(form.order_quantity_m3) : 0;
  const needsPartLoadDecision = rateInfo && form.order_quantity_m3 && partLoadShortfall > 0;
  const partLoadAmount = needsPartLoadDecision && rateInfo?.part_load_charge_per_m3
    ? partLoadShortfall * Number(rateInfo.part_load_charge_per_m3) : 0;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (needsPumpDecision && pumpChargeDecision === null) {
      setError("Confirm whether the pump mobilization charge applies to this order.");
      return;
    }
    if (needsPartLoadDecision && partLoadDecision === null) {
      setError(`Confirm whether the part load charge applies — this order is below the ${partLoadThreshold} m³ minimum.`);
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/sales/bookings/${booking.id}/convert`, {
        method: "POST",
        body: {
          ...form,
          pump_charge_applicable: needsPumpDecision ? pumpChargeDecision : undefined,
          pump_charge_amount: needsPumpDecision && pumpChargeDecision ? pumpChargeAmount : 0,
          part_load_applicable: needsPartLoadDecision ? partLoadDecision : undefined,
          part_load_charge_amount: needsPartLoadDecision && partLoadDecision ? partLoadAmount : 0,
        },
      });
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
          <select value={form.pump_requirement} onChange={(e) => setForm({ ...form, pump_requirement: e.target.value, pump_id: "" })}>
            <option value="without_pump">Without pump</option>
            <option value="boom_pump">Boom pump</option>
            <option value="line_pump">Line pump</option>
          </select>
        </div>
        {form.pump_requirement !== "without_pump" && (
          <div>
            <div style={{ color: "var(--slate)" }}>Pump</div>
            <select value={form.pump_id} onChange={(e) => setForm({ ...form, pump_id: e.target.value })}>
              <option value="">Select</option>
              {pumps.filter((p) => p.pump_type === form.pump_requirement).map((p) => <option key={p.id} value={p.id}>{p.pump_code}</option>)}
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
        {rateInfo && !rateInfo.rate_exists && (
          <div style={{ gridColumn: "1 / -1", color: "var(--amber)", background: "var(--amber-bg)", padding: 10, borderRadius: 8, fontSize: 12 }}>
            No rate is on file for this customer, site, and grade combination as of this order date — deliveries won't generate invoices until one is added.
          </div>
        )}
        {needsPumpDecision && (
          <div style={{ gridColumn: "1 / -1", background: "var(--amber-bg)", border: "1px solid var(--amber)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Pump mobilization charge (required)</div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
              {form.pump_requirement === "boom_pump" ? "Boom" : "Line"} pump rate on file: {pumpChargeAmount ? `₹${pumpChargeAmount}` : "not set"}
              {pumpMinQty ? ` (usually applies below ${pumpMinQty} m³)` : ""}. Confirm whether it applies to this order.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setPumpChargeDecision(true)} style={pumpChargeDecision === true ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Applicable{pumpChargeAmount ? ` — ₹${pumpChargeAmount}` : ""}
              </button>
              <button type="button" onClick={() => setPumpChargeDecision(false)} style={pumpChargeDecision === false ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Not applicable
              </button>
            </div>
          </div>
        )}
        {needsPartLoadDecision && (
          <div style={{ gridColumn: "1 / -1", background: "var(--concrete)", border: "1px solid var(--border-strong, #ccc)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Part load charge (required)</div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
              Minimum load is {partLoadThreshold} m³. This order is {form.order_quantity_m3} m³ — short by {partLoadShortfall.toFixed(2)} m³
              {rateInfo?.part_load_charge_per_m3 ? ` × ₹${rateInfo.part_load_charge_per_m3} = ₹${partLoadAmount.toFixed(2)}` : " (no part-load rate on file)"}.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setPartLoadDecision(true)} style={partLoadDecision === true ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Applicable{rateInfo?.part_load_charge_per_m3 ? ` — ₹${partLoadAmount.toFixed(2)}` : ""}
              </button>
              <button type="button" onClick={() => setPartLoadDecision(false)} style={partLoadDecision === false ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Not applicable
              </button>
            </div>
          </div>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving} style={{ flex: 1 }}>{saving ? "Creating..." : "Create order"}</button>
          <button type="button" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
