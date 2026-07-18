import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";

const initialForm = {
  order_date: new Date().toISOString().slice(0, 10),
  scheduled_batching_time: "08:00",
  truck_dispatch_interval_minutes: 20,
  customer_id: "",
  site_id: "",
  mix_grade_id: "",
  pump_requirement: "without_pump",
  pump_id: "",
  site_technician_required: false,
  cube_samples_required: 3,
  assigned_pump_crew: "",
  assigned_site_supervisor_id: "",
  site_contact_number: "",
  order_quantity_m3: "",
  sales_representative: "",
  casting_location: "",
  pump_departure_time: "",
  remarks: "",
};

export default function CreateOrder({ onDone }) {
  const [form, setForm] = useState(initialForm);
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [mixGrades, setMixGrades] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      apiRequest("/master/customers"),
      apiRequest("/master/sites"),
      apiRequest("/master/mix-grades"),
      apiRequest("/master/site-supervisors"),
      apiRequest("/master/pumps"),
    ]).then(([c, s, m, sup, p]) => {
      setCustomers(c); setSites(s); setMixGrades(m); setSupervisors(sup); setPumps(p);
    }).catch((err) => setError(err.message));
  }, []);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await apiRequest("/orders", { method: "POST", body: form });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const selectedSite = sites.find((s) => String(s.id) === String(form.site_id));

  return (
    <div className="card" style={{ maxWidth: 640, margin: "0 auto" }}>
      <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 12 }}>Create customer order</div>
      <form onSubmit={handleSubmit} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 13 }}>
        <Field label="Order date">
          <input type="date" value={form.order_date} onChange={(e) => set("order_date", e.target.value)} required />
        </Field>
        <Field label="Scheduled batching time">
          <input type="time" value={form.scheduled_batching_time} onChange={(e) => set("scheduled_batching_time", e.target.value)} required />
        </Field>
        <Field label="Truck dispatch interval (min)">
          <input type="number" value={form.truck_dispatch_interval_minutes} onChange={(e) => set("truck_dispatch_interval_minutes", e.target.value)} required />
        </Field>
        <Field label="Customer">
          <select value={form.customer_id} onChange={(e) => set("customer_id", e.target.value)} required>
            <option value="">Select</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Project / site">
          <select value={form.site_id} onChange={(e) => set("site_id", e.target.value)} required>
            <option value="">Select</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Mix grade">
          <select value={form.mix_grade_id} onChange={(e) => set("mix_grade_id", e.target.value)} required>
            <option value="">Select</option>
            {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Pump requirement">
          <select value={form.pump_requirement} onChange={(e) => set("pump_requirement", e.target.value)}>
            <option value="boom_pump">Boom pump</option>
            <option value="line_pump">Line pump</option>
            <option value="without_pump">Without pump</option>
          </select>
        </Field>
        {form.pump_requirement !== "without_pump" && (
          <Field label="Which pump">
            <select value={form.pump_id} onChange={(e) => set("pump_id", e.target.value)}>
              <option value="">Select</option>
              {pumps.filter((p) => p.pump_type === form.pump_requirement).map((p) => (
                <option key={p.id} value={p.id}>{p.pump_code}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Site technician required">
          <select value={form.site_technician_required} onChange={(e) => set("site_technician_required", e.target.value === "true")}>
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </Field>
        <Field label="Cube samples required">
          <input type="number" value={form.cube_samples_required} onChange={(e) => set("cube_samples_required", e.target.value)} />
        </Field>
        <Field label="Assigned pump crew">
          <input type="text" value={form.assigned_pump_crew} onChange={(e) => set("assigned_pump_crew", e.target.value)} />
        </Field>
        <Field label="Assigned site supervisor">
          <select value={form.assigned_site_supervisor_id} onChange={(e) => set("assigned_site_supervisor_id", e.target.value)}>
            <option value="">Select</option>
            {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Site contact number">
          <input type="tel" value={form.site_contact_number} onChange={(e) => set("site_contact_number", e.target.value)} required />
        </Field>
        <Field label="Order quantity (m³)">
          <input type="number" value={form.order_quantity_m3} onChange={(e) => set("order_quantity_m3", e.target.value)} required />
        </Field>
        <Field label="Sales representative">
          <input type="text" value={form.sales_representative} onChange={(e) => set("sales_representative", e.target.value)} />
        </Field>
        <Field label="Structure / casting location">
          <input type="text" value={form.casting_location} onChange={(e) => set("casting_location", e.target.value)} />
        </Field>
        <Field label="Pump departure time">
          <input type="time" value={form.pump_departure_time} onChange={(e) => set("pump_departure_time", e.target.value)} />
        </Field>

        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Remarks">
            <textarea rows={2} value={form.remarks} onChange={(e) => set("remarks", e.target.value)} />
          </Field>
        </div>

        {selectedSite?.trip_allowance_label && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)" }}>
            Driver trip allowance for this site: {selectedSite.trip_allowance_label}
          </div>
        )}

        {error && <div style={{ gridColumn: "1 / -1", color: "var(--alert-red)" }}>{error}</div>}

        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save order"}</button>
          <button type="button" onClick={onDone}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ color: "var(--slate)", marginBottom: 4 }}>{label}</div>
      <div className="field-input">{children}</div>
    </div>
  );
}
