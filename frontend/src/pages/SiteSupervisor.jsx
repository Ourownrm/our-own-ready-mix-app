import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount, startPeriodicFlush, flushQueue } from "../lib/offlineQueue.js";
import { TopBar } from "../lib/TopBar.jsx";

export default function SiteSupervisor() {
  const [deliveries, setDeliveries] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showReject, setShowReject] = useState(false);
  const [workCompleteOrderId, setWorkCompleteOrderId] = useState(null);
  const [pending, setPending] = useState(pendingCount());
  const [error, setError] = useState("");

  // Deriving `selected` from the live `deliveries` list (rather than storing a
  // separate stale copy) is what fixes the "doesn't update until I refresh" bug —
  // every reload now automatically reflects the latest status for whichever
  // ticket is selected.
  const selected = deliveries.find((d) => d.id === selectedId) || deliveries[0] || null;

  async function load() {
    try {
      const [rows, orderRows] = await Promise.all([
        apiRequest("/site-supervisor/my-deliveries"),
        apiRequest("/site-supervisor/my-orders"),
      ]);
      setDeliveries(rows);
      setOrders(orderRows);
      // Keep whatever the supervisor currently has selected, as long as it's
      // still in the list. Reading `selectedId` directly here was the bug:
      // this function is captured once by setInterval below, so it always
      // saw the `null` it had at first render and kept forcing the selection
      // back to the first ticket every 15s, no matter what was picked since.
      // A functional update reads the real current value instead.
      setSelectedId((current) => {
        if (current && rows.some((r) => r.id === current)) return current;
        return rows[0]?.id ?? null;
      });
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // Poll for updates every 15s too, in case someone else (e.g. Plant Operator/QC)
    // changes this ticket's status while the page is open.
    const interval = setInterval(load, 15000);
    // Same fix as Driver's screen: the 'online' event alone doesn't cover
    // reopening the app when it's already connected, so a queued action from
    // a low-signal moment could otherwise sit unsent indefinitely.
    const flushInterval = startPeriodicFlush();
    return () => { clearInterval(interval); clearInterval(flushInterval); };
  }, []);

  async function act(path, body) {
    setError("");
    try {
      await queuedRequest(`/site-supervisor/${selected.id}/${path}`, { method: "POST", body });
      setPending(pendingCount());
      await load();
    } catch (err) {
      setError(err.message);
      throw err; // let CompleteForm/RejectForm know their own submit didn't actually succeed
    }
  }

  async function confirmPumpDeparture(orderId) {
    setError("");
    try {
      await apiRequest(`/site-supervisor/orders/${orderId}/confirm-pump-departure`, { method: "POST" });
      load();
    } catch (err) {
      if (err.message.includes("reason for the delay is required")) {
        const reason = window.prompt("This is past the scheduled departure time — what caused the delay?");
        if (!reason) return;
        try {
          await apiRequest(`/site-supervisor/orders/${orderId}/confirm-pump-departure`, { method: "POST", body: { delay_reason: reason } });
          load();
        } catch (err2) {
          setError(err2.message);
        }
      } else {
        setError(err.message);
      }
    }
  }

  // 99.9% of the time this tap happens standing at the actual site — capturing
  // where the device is right now gives the geofence-based arrival detection a
  // fresher, more precise anchor than the site's own saved (and sometimes
  // stale or rough) coordinate. Best-effort: if location isn't available or
  // permission isn't granted, site-ready confirmation still proceeds exactly
  // as before — this is a bonus signal, never a requirement.
  function currentLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({});
      const timer = setTimeout(() => resolve({}), 4000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(timer); resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }); },
        () => { clearTimeout(timer); resolve({}); },
        { timeout: 4000, maximumAge: 60000 }
      );
    });
  }

  async function confirmSiteReady(orderId) {
    setError("");
    const loc = await currentLocation();
    try {
      await apiRequest(`/site-supervisor/orders/${orderId}/confirm-site-ready`, { method: "POST", body: loc });
      load();
    } catch (err) {
      if (err.message.includes("reason for the delay is required")) {
        const reason = window.prompt("This is past the scheduled batching time — what caused the delay?");
        if (!reason) return;
        try {
          await apiRequest(`/site-supervisor/orders/${orderId}/confirm-site-ready`, { method: "POST", body: { delay_reason: reason, ...loc } });
          load();
        } catch (err2) {
          setError(err2.message);
        }
      } else {
        setError(err.message);
      }
    }
  }

  async function submitWorkCompleted(orderId, afterPourCare, remarks) {
    setError("");
    try {
      await apiRequest(`/site-supervisor/orders/${orderId}/mark-work-completed`, {
        method: "POST",
        body: { after_pour_care_confirmed: afterPourCare, remarks },
      });
      setWorkCompleteOrderId(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (showReject && selected) {
    return (
      <RejectForm
        ticket={selected}
        onDone={() => { setShowReject(false); load(); }}
        onAct={act}
      />
    );
  }

  return (
    <>
      <TopBar title="Site Supervisor" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {!navigator.onLine && (
          <div style={{ textAlign: "center", fontSize: 12, background: "var(--amber-bg)", color: "var(--amber)", padding: 6, borderRadius: 8, marginBottom: 12 }}>
            No signal — actions are being saved and will sync automatically
          </div>
        )}
        {pending > 0 && (
          <div style={{ textAlign: "center", fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
            {pending} action(s) waiting to sync
            <button
              style={{ display: "block", margin: "6px auto 0", fontSize: 11, padding: "4px 10px" }}
              onClick={async () => { await flushQueue(); setPending(pendingCount()); load(); }}
            >
              Sync now
            </button>
          </div>
        )}

        {orders.length > 0 && (
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Today's orders</div>
            {orders.map((o) => (
              <div key={o.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 12 }}>
                <div style={{ display: "inline-block", background: "var(--rebar)", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, marginBottom: 4 }}>Order #{o.id}</div>
                <div style={{ fontWeight: 600 }}>{o.customer_name} — {o.site_name}</div>
                <div style={{ color: "var(--slate)" }}>Batching scheduled {o.scheduled_batching_time}</div>

                {o.pump_requirement !== "without_pump" && (
                  <div style={{ marginTop: 6 }}>
                    {o.pump_actual_departure_time ? (
                      <div style={{ color: "var(--signal-green)" }}>
                        Pump left plant {new Date(o.pump_actual_departure_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {o.pump_departure_delay_reason && <div style={{ color: "var(--slate)" }}>Delay reason: {o.pump_departure_delay_reason}</div>}
                      </div>
                    ) : (
                      <button style={{ width: "100%", fontSize: 12, padding: "6px" }} onClick={() => confirmPumpDeparture(o.id)}>
                        Confirm pump left plant
                      </button>
                    )}
                  </div>
                )}

                <div style={{ marginTop: 6 }}>
                  {o.site_ready_confirmed ? (
                    <div style={{ color: "var(--signal-green)" }}>
                      Site confirmed ready
                      {o.site_ready_delay_reason && <div style={{ color: "var(--slate)" }}>Delay reason: {o.site_ready_delay_reason}</div>}
                    </div>
                  ) : (
                    <button style={{ width: "100%", fontSize: 12, padding: "6px" }} onClick={() => confirmSiteReady(o.id)}>
                      Confirm site ready for batching
                    </button>
                  )}
                </div>

                {workCompleteOrderId === o.id ? (
                  <WorkCompleteForm
                    onCancel={() => setWorkCompleteOrderId(null)}
                    onSubmit={(afterPourCare, remarks) => submitWorkCompleted(o.id, afterPourCare, remarks)}
                  />
                ) : (
                  <button
                    className="btn-danger"
                    style={{ width: "100%", fontSize: 12, padding: "6px", marginTop: 6 }}
                    onClick={() => setWorkCompleteOrderId(o.id)}
                  >
                    Flag work completed for Manager
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <Link to="/fuel"><button type="button" style={{ width: "100%", marginBottom: 12 }}>Fuel filling</button></Link>
        <Link to="/delay-justification-report"><button type="button" style={{ width: "100%", marginBottom: 12 }}>Delay report</button></Link>

        {deliveries.length > 1 && (
          <select
            value={selected?.id || ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            style={{ width: "100%", marginBottom: 12, padding: 8 }}
          >
            {deliveries.map((d) => (
              <option key={d.id} value={d.id}>
                {new Date(d.ticket_date).toLocaleDateString([], { day: "2-digit", month: "short" })} — {d.ticket_number} — {statusLabel(d.status)} — {d.truck_number || "no truck"} · {d.driver_name || "no driver"}
              </option>
            ))}
          </select>
        )}

        {!selected ? (
          <div style={{ fontSize: 13, color: "var(--slate)", textAlign: "center", marginTop: 40 }}>No deliveries need your confirmation right now.</div>
        ) : (
          <div className="card" style={{ borderRadius: 20, padding: "20px 18px" }}>
            <div style={{ textAlign: "center", fontSize: 13, color: "var(--slate)" }}>{selected.site_name} &middot; {selected.ticket_number}</div>
            <div style={{ textAlign: "center", fontSize: 13, color: "var(--slate)", marginTop: 2 }}>
              {selected.truck_number || "No truck"} &middot; {selected.driver_name || "No driver"}
            </div>
            <div style={{ textAlign: "center", fontSize: 16, fontWeight: 600, margin: "4px 0 18px" }}>{statusLabel(selected.status)}</div>

            {/* Geofence hints — GPS movement suggests this happened, but
                nothing is auto-confirmed; purely a nudge to tap the real
                stage below. Server only sends these while the real
                trip_events timestamp is still null. */}
            {selected.hint_reached_site_at && (
              <div style={{ fontSize: 12, color: "var(--info)", background: "var(--info-bg, #EAF3FB)", borderRadius: 8, padding: "8px 10px", marginBottom: 12 }}>
                Looks like the truck reached site around {new Date(selected.hint_reached_site_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — tap <strong>Arrival</strong> below to confirm.
              </div>
            )}
            {selected.hint_left_site_at && (
              <div style={{ fontSize: 12, color: "var(--info)", background: "var(--info-bg, #EAF3FB)", borderRadius: 8, padding: "8px 10px", marginBottom: 12 }}>
                Looks like the truck left site around {new Date(selected.hint_left_site_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — if unloading is done, tap <strong>Completion</strong> below to confirm.
              </div>
            )}

            <SupervisorStageTracker status={selected.status} onAct={act} />

            {selected.status === "unloading" && <CompleteForm onAct={act} />}

            <button
              className="btn-danger"
              style={{ width: "100%", marginTop: 18, padding: "12px", fontSize: 14, fontWeight: 600 }}
              onClick={() => setShowReject(true)}
            >
              Reject concrete
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function SupervisorStageTracker({ status, onAct }) {
  const stages = [
    { key: "arrival", label: "Arrival", action: "arrival", activeWhen: ["created", "batching", "dispatched"], doneWhen: ["reached_site", "unloading", "completed", "rejected"] },
    { key: "unloading_start", label: "Unloading start", action: "unloading-start", activeWhen: ["reached_site"], doneWhen: ["unloading", "completed", "rejected"] },
    { key: "unloading_complete", label: "Completion", action: null, activeWhen: ["unloading"], doneWhen: ["completed", "rejected"] },
  ];

  return (
    <div style={{ display: "flex", alignItems: "flex-start" }}>
      {stages.map((stage, i) => {
        const done = stage.doneWhen.includes(status);
        const active = stage.activeWhen.includes(status);
        const tappable = active && stage.action;
        return (
          <div key={stage.key} style={{ display: "flex", alignItems: "flex-start", flex: i === stages.length - 1 ? "0 0 auto" : 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 70 }}>
              <button
                disabled={!tappable}
                onClick={() => tappable && onAct(stage.action)}
                style={{
                  width: "100%", border: "none", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  padding: "12px 4px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  background: done ? "var(--signal-green)" : tappable ? "var(--rebar)" : "var(--concrete)",
                  color: done || tappable ? "#fff" : "var(--slate)",
                }}
              >
                {stage.label}
              </button>
              <div style={{ fontSize: 10, color: "var(--slate)", marginTop: 5 }}>
                {done ? "Done" : tappable ? "Tap to confirm" : "Waiting"}
              </div>
            </div>
            {i < stages.length - 1 && <div style={{ height: 1, background: "var(--concrete)", flex: "0 0 10px", marginTop: 20 }} />}
          </div>
        );
      })}
    </div>
  );
}

function statusLabel(status) {
  return {
    created: "Awaiting arrival", batching: "Awaiting arrival", dispatched: "Awaiting arrival",
    reached_site: "Arrived, awaiting unload", unloading: "Unloading in progress",
    completed: "Unloading completed", rejected: "Rejected",
  }[status] || status;
}

function WorkCompleteForm({ onSubmit, onCancel }) {
  const [afterPourCare, setAfterPourCare] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!afterPourCare) return setError("Confirm you've guided the customer on after-pour care before continuing.");
    setSaving(true); setError("");
    try {
      await onSubmit(afterPourCare, remarks);
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 6, padding: 8, background: "var(--surface-2, #fff)", border: "1px solid var(--border, #ccc)", borderRadius: 8, fontSize: 12 }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={afterPourCare} onChange={(e) => setAfterPourCare(e.target.checked)} style={{ marginTop: 2 }} />
        <span>Guided customer on after-pour care (covering with plastic sheet, curing) — required</span>
      </label>
      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Comments (optional)</div>
      <textarea
        rows={2}
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
        placeholder="Any notes about how the work wrapped up"
        style={{ width: "100%", marginBottom: 8 }}
      />
      {error && <div style={{ color: "var(--alert-red)", marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn-danger" onClick={submit} disabled={saving} style={{ flex: 1, fontSize: 12, padding: "6px" }}>
          {saving ? "Saving..." : "Confirm work completed"}
        </button>
        <button onClick={onCancel} style={{ flex: 1, fontSize: 12, padding: "6px" }}>Cancel</button>
      </div>
    </div>
  );
}


function CompleteForm({ onAct }) {
  const [slump, setSlump] = useState("");
  const [noteStatus, setNoteStatus] = useState("pending");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setSaving(true); setError("");
    try {
      await onAct("unloading-complete", {
        site_slump_mm: slump,
        delivery_note_status: noteStatus,
      });
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, fontSize: 13, background: "var(--concrete)", borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Record completion details</div>
      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Site slump (mm)</div>
      <input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Delivery note status</div>
      <select value={noteStatus} onChange={(e) => setNoteStatus(e.target.value)} style={{ width: "100%", marginBottom: 12 }}>
        <option value="pending">Pending</option>
        <option value="signed">Signed</option>
        <option value="refused">Refused</option>
      </select>

      {error && <div style={{ color: "var(--alert-red)", marginBottom: 8 }}>{error}</div>}
      <button onClick={submit} disabled={saving} style={{ width: "100%", padding: "12px", fontSize: 14, fontWeight: 600, background: "var(--signal-green)", color: "#fff", border: "none" }}>
        {saving ? "Saving..." : "Save completion"}
      </button>
    </div>
  );
}

function RejectForm({ ticket, onAct, onDone }) {
  const [reasons, setReasons] = useState([]);
  const [reasonId, setReasonId] = useState("");
  const [slump, setSlump] = useState("");
  const [qty, setQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/master/rejection-reasons").then(setReasons).catch(() => {});
  }, []);

  async function submit() {
    setSaving(true); setError("");
    try {
      await onAct("reject", {
        rejection_reason_id: reasonId || null,
        site_slump_mm: slump,
        rejected_quantity_m3: qty,
        remarks,
      });
      onDone();
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Site Supervisor · Reject concrete" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Reject concrete</div>
        <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>{ticket.ticket_number} &middot; {ticket.site_name}</div>

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
