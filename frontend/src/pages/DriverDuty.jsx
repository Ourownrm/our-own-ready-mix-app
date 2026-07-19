import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount } from "../lib/offlineQueue.js";
import { TopBar } from "../lib/TopBar.jsx";

export default function DriverDuty() {
  const [onDuty, setOnDuty] = useState(false);
  const [trip, setTrip] = useState(null);
  const [pending, setPending] = useState(pendingCount());
  const [activeForm, setActiveForm] = useState(null); // null | 'breakdown' | 'fuel'
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const gpsIntervalRef = useRef(null);

  useEffect(() => {
    apiRequest("/tickets/my-trip").then(setTrip).catch(() => {});
  }, []);

  useEffect(() => {
    return () => clearInterval(gpsIntervalRef.current);
  }, []);

  function startGpsPings() {
    gpsIntervalRef.current = setInterval(() => {
      navigator.geolocation?.getCurrentPosition((pos) => {
        queuedRequest("/driver/gps-ping", {
          method: "POST",
          body: {
            ticket_id: trip?.id,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            speed_kmh: pos.coords.speed ? pos.coords.speed * 3.6 : null,
            accuracy_m: pos.coords.accuracy,
          },
        }).then(() => setPending(pendingCount()));
      });
    }, 30000);
  }

  async function toggleDuty() {
    const next = !onDuty;
    setOnDuty(next);
    if (next) startGpsPings();
    else clearInterval(gpsIntervalRef.current);

    navigator.geolocation?.getCurrentPosition(async (pos) => {
      await queuedRequest("/driver/duty", {
        method: "POST",
        body: { on: next, ticket_id: trip?.id, lat: pos.coords.latitude, lng: pos.coords.longitude },
      });
      setPending(pendingCount());
    }, async () => {
      await queuedRequest("/driver/duty", { method: "POST", body: { on: next, ticket_id: trip?.id } });
      setPending(pendingCount());
    });
  }

  if (activeForm === "breakdown") {
    return (
      <BreakdownForm
        trip={trip}
        onDone={(msg) => { setActiveForm(null); setNotice(msg); setPending(pendingCount()); }}
        onCancel={() => setActiveForm(null)}
      />
    );
  }
  if (activeForm === "fuel") {
    return (
      <FuelForm
        trip={trip}
        onDone={(msg) => { setActiveForm(null); setNotice(msg); setPending(pendingCount()); }}
        onCancel={() => setActiveForm(null)}
      />
    );
  }

  return (
    <>
      <TopBar title="Driver" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ textAlign: "center", fontSize: 13, color: "var(--slate)" }}>
            {trip?.truck_number || "No truck assigned"}
          </div>
          <div style={{ textAlign: "center", fontSize: 15, fontWeight: 600, margin: "4px 0 16px" }}>
            {onDuty ? "On duty" : "Off duty"}
          </div>

          {!navigator.onLine && (
            <div style={{ textAlign: "center", fontSize: 12, background: "var(--amber-bg)", color: "var(--amber)", padding: 6, borderRadius: 8, marginBottom: 12 }}>
              No signal — actions are being saved and will sync automatically
            </div>
          )}
          {pending > 0 && (
            <div style={{ textAlign: "center", fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
              {pending} action{pending > 1 ? "s" : ""} waiting to sync
            </div>
          )}
          {notice && <div style={{ textAlign: "center", fontSize: 12, color: "var(--signal-green)", marginBottom: 12 }}>{notice}</div>}
          {error && <div style={{ textAlign: "center", fontSize: 12, color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

          <div style={{ display: "flex", justifyContent: "center" }}>
            <button
              onClick={toggleDuty}
              style={{
                width: "50%", aspectRatio: "1", borderRadius: "50%", border: "none",
                background: onDuty ? "var(--alert-red)" : "var(--signal-green)",
                color: "#fff", fontSize: 16, fontWeight: 600,
              }}
            >
              {onDuty ? "Duty OFF" : "Duty ON"}
            </button>
          </div>

          {trip && (
            <div style={{ marginTop: 20 }}>
              <div className="kpi-label" style={{ marginBottom: 8 }}>Assigned trip</div>
              <div style={{ background: "var(--concrete)", borderRadius: 10, padding: 12, fontSize: 13 }}>
                <Row label="Ticket" value={trip.ticket_number} />
                <Row label="Site" value={trip.site_name} />
                <Row label="Trip allowance" value={`₹${trip.trip_allowance_amount}`} strong />
                {trip.site_latitude && trip.site_longitude && (
                  <a
                    href={`https://maps.google.com/?q=${trip.site_latitude},${trip.site_longitude}`}
                    target="_blank" rel="noreferrer"
                    style={{ display: "block", textAlign: "center", marginTop: 10, padding: 10, background: "var(--rebar)", color: "#fff", borderRadius: 8, fontWeight: 600, textDecoration: "none" }}
                  >
                    Navigate to site in Google Maps
                  </a>
                )}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 16 }}>
            <button
              onClick={() => {
                if (!trip?.truck_id) { setError("No truck assigned yet — can't report this without one."); return; }
                setError(""); setNotice(""); setActiveForm("breakdown");
              }}
            >
              Report breakdown
            </button>
            <button
              onClick={() => {
                if (!trip?.truck_id) { setError("No truck assigned yet — can't report this without one."); return; }
                setError(""); setNotice(""); setActiveForm("fuel");
              }}
            >
              Report fuel filling
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
      <span style={{ color: "var(--slate)" }}>{label}</span>
      <span style={{ fontWeight: strong ? 600 : 400 }}>{value}</span>
    </div>
  );
}

function BreakdownForm({ trip, onDone, onCancel }) {
  const [location, setLocation] = useState("");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await queuedRequest("/driver/breakdown", {
        method: "POST",
        body: { truck_id: trip.truck_id, location, remarks },
      });
      onDone("Breakdown reported. The manager has been notified.");
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Driver · Report breakdown" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Report breakdown</div>
          <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>{trip?.truck_number}</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Location</div>
              <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Near Sector 12 signal" />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>What happened</div>
              <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} required />
            </div>
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={saving}>{saving ? "Saving..." : "Submit"}</button>
              <button type="button" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

function FuelForm({ trip, onDone, onCancel }) {
  const [odometer, setOdometer] = useState("");
  const [litres, setLitres] = useState("");
  const [cost, setCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await queuedRequest("/driver/fuel", {
        method: "POST",
        body: { truck_id: trip.truck_id, odometer_reading: odometer, fuel_quantity_litres: litres, fuel_cost: cost },
      });
      onDone("Fuel filling recorded.");
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Driver · Report fuel filling" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Report fuel filling</div>
          <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>{trip?.truck_number}</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Odometer reading</div>
              <input type="number" value={odometer} onChange={(e) => setOdometer(e.target.value)} required />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Fuel quantity (litres)</div>
              <input type="number" value={litres} onChange={(e) => setLitres(e.target.value)} required />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Cost (₹)</div>
              <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={saving}>{saving ? "Saving..." : "Submit"}</button>
              <button type="button" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
