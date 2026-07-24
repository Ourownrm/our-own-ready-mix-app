import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount } from "../lib/offlineQueue.js";
import { TopBar } from "../lib/TopBar.jsx";

export default function DriverDuty() {
  const [onDuty, setOnDuty] = useState(false);
  const [trip, setTrip] = useState(null);
  const [pending, setPending] = useState(pendingCount());
  const [activeForm, setActiveForm] = useState(null); // null | 'breakdown' | 'reject'
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const gpsIntervalRef = useRef(null);
  const wakeLockRef = useRef(null);
  const tripRef = useRef(null);
  tripRef.current = trip;

  function loadTrip() {
    apiRequest("/tickets/my-trip").then(setTrip).catch(() => {});
  }

  // On open, read the REAL duty status from the server instead of assuming
  // "off". A backgrounded Android tab can get suspended by the OS, which
  // resets React state to its defaults on reload — without this, that made it
  // look like duty had silently turned off even though the driver never
  // pressed Duty OFF. If the server says we're still on, resume tracking
  // immediately.
  useEffect(() => {
    loadTrip();
    apiRequest("/driver/duty-status").then((status) => {
      setOnDuty(status.on_duty);
      if (status.on_duty) {
        startGpsPings();
        requestWakeLock();
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    return () => { clearInterval(gpsIntervalRef.current); releaseWakeLock(); };
  }, []);

  // Whenever the app comes back to the foreground (switching apps, unlocking
  // the phone, reopening after the tab was suspended), immediately send a
  // fresh GPS ping and re-acquire the wake lock — closing the tracking gap as
  // soon as possible instead of waiting for the next 30s tick, and without
  // ever declaring "duty off" on our own.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && wakeLockRef.current === "on") {
        requestWakeLock();
        pingOnce();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  function pingOnce() {
    navigator.geolocation?.getCurrentPosition((pos) => {
      queuedRequest("/driver/gps-ping", {
        method: "POST",
        body: {
          ticket_id: tripRef.current?.id,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          speed_kmh: pos.coords.speed ? pos.coords.speed * 3.6 : null,
          accuracy_m: pos.coords.accuracy,
        },
      }).then(() => setPending(pendingCount()));
    });
  }

  function startGpsPings() {
    clearInterval(gpsIntervalRef.current);
    pingOnce();
    gpsIntervalRef.current = setInterval(pingOnce, 30000);
  }

  async function requestWakeLock() {
    wakeLockRef.current = "on";
    try {
      await navigator.wakeLock?.request("screen");
    } catch {
      // Not supported, or permission denied — tracking still works while the
      // app is open and in the foreground, just without the screen-stay-awake
      // assist. No native background GPS is possible from a browser tab; a
      // driver who fully closes the app will need to reopen it to resume.
    }
  }
  function releaseWakeLock() {
    wakeLockRef.current = "off";
  }

  async function toggleDuty() {
    const next = !onDuty;
    setOnDuty(next);
    if (next) { startGpsPings(); requestWakeLock(); }
    else { clearInterval(gpsIntervalRef.current); releaseWakeLock(); }

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

  async function act(path, body) {
    setError(""); setNotice("");
    try {
      await queuedRequest(`/driver/tickets/${trip.id}/${path}`, { method: "POST", body });
      setPending(pendingCount());
      loadTrip();
      return true;
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
      return false;
    }
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
  if (activeForm === "reject") {
    return (
      <RejectForm
        trip={trip}
        onAct={act}
        error={error}
        onDone={() => { setActiveForm(null); loadTrip(); }}
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
          {onDuty && (
            <div style={{ textAlign: "center", fontSize: 11, color: "var(--slate)", marginTop: 10 }}>
              Keep this screen open while on duty for the most accurate tracking —
              reopening the app resumes automatically if it gets interrupted.
            </div>
          )}

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

              {trip.no_site_supervisor && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 6 }}>
                    No Site Supervisor assigned to this site — confirm delivery yourself.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <button
                      disabled={!["created", "batching", "dispatched"].includes(trip.status)}
                      onClick={() => act("arrival")}
                    >
                      Confirm truck arrival
                    </button>
                    <button
                      disabled={trip.status !== "reached_site"}
                      onClick={() => act("unloading-start")}
                    >
                      Confirm unloading start
                    </button>
                  </div>
                  {trip.status === "unloading" && <CompleteForm onAct={act} />}
                  {(trip.status === "reached_site" || trip.status === "unloading") && (
                    <button
                      className="btn-danger"
                      style={{ width: "100%", marginTop: 8 }}
                      onClick={() => setActiveForm("reject")}
                    >
                      Reject concrete
                    </button>
                  )}
                </div>
              )}
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
            <Link to="/fuel"><button type="button" style={{ width: "100%" }}>Report fuel filling</button></Link>
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

function CompleteForm({ onAct }) {
  const [slump, setSlump] = useState("");
  const [noteStatus, setNoteStatus] = useState("pending");
  const [afterPourCare, setAfterPourCare] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    await onAct("unloading-complete", {
      site_slump_mm: slump,
      delivery_note_status: noteStatus,
      after_pour_care_confirmed: afterPourCare,
      remarks,
    });
    setSaving(false);
  }

  return (
    <div style={{ marginTop: 12, fontSize: 13 }}>
      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Site slump (mm)</div>
      <input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Delivery note status</div>
      <select value={noteStatus} onChange={(e) => setNoteStatus(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
        <option value="pending">Pending</option>
        <option value="signed">Signed</option>
        <option value="refused">Refused</option>
      </select>

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={afterPourCare} onChange={(e) => setAfterPourCare(e.target.checked)} />
        <span>Guided customer on after-pour care (covering with plastic sheet, curing)</span>
      </label>

      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Comments about this supply</div>
      <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

      <button onClick={submit} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving..." : "Save completion"}
      </button>
    </div>
  );
}

function RejectForm({ trip, onAct, onDone, error }) {
  const [reasons, setReasons] = useState([]);
  const [reasonId, setReasonId] = useState("");
  const [slump, setSlump] = useState("");
  const [qty, setQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiRequest("/master/rejection-reasons").then(setReasons).catch(() => {});
  }, []);

  async function submit() {
    setSaving(true);
    const ok = await onAct("reject", {
      rejection_reason_id: reasonId || null,
      site_slump_mm: slump,
      rejected_quantity_m3: qty,
      remarks,
    });
    setSaving(false);
    if (ok) onDone();
  }

  return (
    <>
      <TopBar title="Driver · Reject concrete" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Reject concrete</div>
        <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>{trip?.ticket_number} &middot; {trip?.site_name}</div>

        <div className="field-input" style={{ fontSize: 13 }}>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Reason for rejection</div>
          <select value={reasonId} onChange={(e) => setReasonId(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
            <option value="">Select</option>
            {reasons.map((r) => <option key={r.id} value={r.id}>{r.reason}</option>)}
          </select>

          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Measured site slump (mm)</div>
          <input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Quantity rejected (m³)</div>
          <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Comments</div>
          <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />

          {error && <div style={{ color: "var(--alert-red)", marginBottom: 8 }}>{error}</div>}
          <button className="btn-danger" onClick={submit} disabled={saving} style={{ width: "100%", marginBottom: 8 }}>
            {saving ? "Saving..." : "Confirm rejection"}
          </button>
          <button onClick={onDone} style={{ width: "100%" }}>Cancel</button>
        </div>
      </div>
    </>
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
