import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";

// Public, no-login page reached only via a shared per-customer+site link
// (see pages/CustomerBooking.jsx for how Manager/Admin generate it, and
// routes/customerBooking.js on the backend for why this is safe to leave
// open). Deliberately doesn't use TopBar/ProtectedRoute — there's no session
// here, same pattern as CustomerTracking.jsx.

const STAGES = [
  { key: "left_plant_at", label: "Left\nPlant" },
  { key: "reached_site_at", label: "At\nSite" },
  { key: "unloading_started_at", label: "Unloading" },
  { key: "unloading_completed_at", label: "Delivered" },
];

function truckStageIndex(t) {
  if (t.status === "rejected") return -1;
  if (t.unloading_completed_at) return 3;
  if (t.unloading_started_at) return 2;
  if (t.reached_site_at) return 1;
  if (t.left_plant_at) return 0;
  return -2;
}

const PUMP_LABELS = { boom_pump: "Boom pump", line_pump: "Line pump", without_pump: "No pump — direct pour" };

const emptyForm = {
  mix_grade_id: "", estimated_qty_m3: "", preferred_date: "", preferred_time: "",
  pump_requirement: "without_pump", casting_location: "", site_contact_name: "", site_contact_number: "", notes: "",
};

export default function CustomerBookingForm() {
  const { token } = useParams();
  const [data, setData] = useState(undefined); // undefined = loading, null = expired
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function load() {
    apiRequest(`/customer-booking/${token}`)
      .then((d) => { setData(d); })
      .catch(() => setData(null));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (data === undefined) return <CenterMessage>Loading...</CenterMessage>;

  if (data === null) {
    return (
      <Shell>
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔒</div>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>This booking link is no longer active</h2>
          <p style={{ fontSize: 13, color: "var(--slate)", lineHeight: 1.6 }}>
            It may have been turned off, or unable to connect to Our Own RMC Server. Please contact your Our Own
            Ready Mix representative for a fresh link.
          </p>
        </div>
      </Shell>
    );
  }

  const { customer_name, site_name, mix_grades, latest_request, tracking } = data;
  const displayForm = !latest_request || showForm;

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest(`/customer-booking/${token}`, { method: "POST", body: form });
      setForm(emptyForm);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (displayForm) {
    return (
      <Shell customerLabel={customer_name}>
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 }}>{site_name}</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>Request concrete</div>
        </div>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
        <form onSubmit={submit} className="card" style={{ marginBottom: 20 }}>
          <Field label="Date required">
            <input type="date" value={form.preferred_date} onChange={(e) => setForm({ ...form, preferred_date: e.target.value })} required />
          </Field>
          <Field label="Preferred time">
            <input type="time" value={form.preferred_time} onChange={(e) => setForm({ ...form, preferred_time: e.target.value })} required />
          </Field>
          <Field label="Grade of concrete">
            <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })} required>
              <option value="">Select</option>
              {mix_grades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Quantity (m³)">
            <input type="number" min="0" step="0.5" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} required />
          </Field>
          <Field label="Pump required?">
            <select value={form.pump_requirement} onChange={(e) => setForm({ ...form, pump_requirement: e.target.value })}>
              <option value="without_pump">No pump — direct pour</option>
              <option value="boom_pump">Boom pump</option>
              <option value="line_pump">Line pump</option>
            </select>
          </Field>
          <Field label="Structure / casting location">
            <input type="text" value={form.casting_location} onChange={(e) => setForm({ ...form, casting_location: e.target.value })} placeholder="e.g. Column & slab — Block A, 2nd floor" />
          </Field>
          <Field label="Site contact name">
            <input type="text" value={form.site_contact_name} onChange={(e) => setForm({ ...form, site_contact_name: e.target.value })} />
          </Field>
          <Field label="Site contact phone">
            <input type="tel" value={form.site_contact_number} onChange={(e) => setForm({ ...form, site_contact_number: e.target.value })} required />
          </Field>
          <Field label="Special instructions (optional)">
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <div style={{ fontSize: 11, color: "var(--slate)", lineHeight: 1.5, margin: "2px 0 14px" }}>
            This order will be governed by the Terms &amp; Conditions of your existing Supply Agreement with Our Own
            Ready Mix.
          </div>
          <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
            {saving ? "Sending..." : "Send booking request"}
          </button>
          {latest_request && (
            <button type="button" style={{ width: "100%", marginTop: 8 }} onClick={() => setShowForm(false)}>
              ← Back to my last request's status
            </button>
          )}
        </form>
      </Shell>
    );
  }

  return (
    <Shell customerLabel={customer_name}>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 }}>{site_name}</div>
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>Booking status</div>
      </div>

      <RequestStatusCard request={latest_request} />

      <div className="card" style={{ marginBottom: 14 }}>
        <Kv k="Grade" v={latest_request.mix_grade_name} />
        <Kv k="Quantity" v={latest_request.estimated_qty_m3 ? `${latest_request.estimated_qty_m3} m³` : "—"} />
        <Kv k="Pump" v={PUMP_LABELS[latest_request.pump_requirement] || "—"} />
        <Kv
          k="Requested"
          v={latest_request.preferred_date
            ? `${new Date(latest_request.preferred_date).toLocaleDateString([], { day: "2-digit", month: "short" })}${latest_request.preferred_time ? `, ${latest_request.preferred_time.slice(0, 5)}` : ""}`
            : "—"}
        />
      </div>

      {tracking && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, margin: "4px 0 8px" }}>Live delivery status</div>
          {tracking.trucks.filter((t) => t.status !== "rejected").map((t) => (
            <TruckCard key={t.ticket_number} truck={t} />
          ))}
          {tracking.trucks.length === 0 && (
            <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)" }}>
              No trucks dispatched yet — this will update automatically once one leaves the plant.
            </div>
          )}
        </>
      )}

      {latest_request.status !== "pending" && (
        <button style={{ width: "100%", marginBottom: 10 }} onClick={() => setShowForm(true)}>
          Submit a new request
        </button>
      )}

      <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "6px 16px 22px", lineHeight: 1.6 }}>
        This link shows only your own bookings and site. It doesn't show any other customer's data.<br />
        Shared by Our Own Ready Mix.
      </div>
    </Shell>
  );
}

function RequestStatusCard({ request }) {
  const map = {
    pending: { bg: "var(--amber-bg)", color: "var(--amber)", title: "Under review", body: "We've received your request. You'll be notified here once it's confirmed." },
    accepted: { bg: "var(--signal-green-bg)", color: "var(--signal-green)", title: "Accepted", body: "Confirmed — see the schedule below." },
    converted: { bg: "var(--signal-green-bg)", color: "var(--signal-green)", title: "Accepted — scheduled", body: "Please ensure the site is ready to receive concrete at the scheduled time." },
    declined: { bg: "var(--alert-red-bg)", color: "var(--alert-red)", title: "Not accepted this time", body: request.declined_reason || "Please contact us, or submit a new request with different details." },
  };
  const s = map[request.status] || map.pending;
  return (
    <div className="card" style={{ marginBottom: 14, textAlign: "center", background: s.bg, borderColor: "transparent" }}>
      <div style={{ fontWeight: 700, color: s.color }}>{s.title}</div>
      <div style={{ fontSize: 12, color: "var(--charcoal)", marginTop: 4 }}>{s.body}</div>
    </div>
  );
}

function TruckCard({ truck }) {
  const stage = truckStageIndex(truck);
  const done = stage === 3;
  return (
    <div className="card" style={{ marginBottom: 12, opacity: done ? 0.9 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>🚚 {truck.truck_number || "Truck"}</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{truck.quantity_m3} m³ · DC #{truck.ticket_number}</div>
        </div>
      </div>
      {stage >= -1 && (
        <div style={{ display: "flex", alignItems: "center", marginTop: 14 }}>
          {STAGES.map((s, i) => (
            <div key={s.key} style={{ flex: 1, textAlign: "center", position: "relative" }}>
              {i > 0 && (
                <div style={{ position: "absolute", top: 11, left: "-50%", width: "100%", height: 2, background: i <= stage ? "var(--signal-green)" : "#ECEAE4", zIndex: -1 }} />
              )}
              <div style={{
                width: 22, height: 22, borderRadius: "50%", margin: "0 auto 6px", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700,
                background: i < stage || (i === stage && done) ? "var(--signal-green)" : i === stage ? "var(--rebar)" : "#ECEAE4",
                color: i <= stage ? "#fff" : "var(--slate)",
                boxShadow: i === stage && !done ? "0 0 0 4px rgba(199,91,18,0.15)" : "none",
              }}>
                {i < stage || (i === stage && done) ? "✓" : i === stage ? "●" : ""}
              </div>
              <div style={{ fontSize: 10, color: i <= stage ? (i === stage && !done ? "var(--rebar)" : "var(--signal-green)") : "var(--slate)", fontWeight: i === stage ? 700 : 500, whiteSpace: "pre-line", lineHeight: 1.2 }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4, display: "block" }}>{label}</span>
      {children}
    </label>
  );
}

function Kv({ k, v }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed var(--border)" }}>
      <span style={{ color: "var(--slate)" }}>{k}</span>
      <span style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}

function Shell({ children, customerLabel }) {
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title">
          Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
          <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>
            Concrete booking{customerLabel ? ` · ${customerLabel}` : ""}
          </div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>{children}</div>
    </div>
  );
}

function CenterMessage({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--slate)", fontSize: 13 }}>
      {children}
    </div>
  );
}
