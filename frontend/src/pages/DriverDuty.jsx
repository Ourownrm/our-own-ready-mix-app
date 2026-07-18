import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount } from "../lib/offlineQueue.js";
import { TopBar } from "../lib/TopBar.jsx";

export default function DriverDuty() {
  const [onDuty, setOnDuty] = useState(false);
  const [trip, setTrip] = useState(null);
  const [pending, setPending] = useState(pendingCount());
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
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 16 }}>
            <button onClick={() => reportBreakdown(trip)}>Report breakdown</button>
            <button onClick={() => reportFuel(trip)}>Report fuel filling</button>
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

async function reportBreakdown(trip) {
  await queuedRequest("/driver/breakdown", { method: "POST", body: { truck_id: trip?.truck_id } });
}
async function reportFuel(trip) {
  await queuedRequest("/driver/fuel", { method: "POST", body: { truck_id: trip?.truck_id } });
}
