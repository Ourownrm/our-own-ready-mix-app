import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount, startPeriodicFlush, flushQueue } from "../lib/offlineQueue.js";
import { TopBar } from "../lib/TopBar.jsx";
import { formatOrderNumber } from "../lib/orderNumber.js";

export default function SiteSupervisor() {
  const [deliveries, setDeliveries] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showReject, setShowReject] = useState(false);
  const [workCompleteOrderId, setWorkCompleteOrderId] = useState(null);
  const [delaySheet, setDelaySheet] = useState(null); // { kind: 'pump'|'site-ready', orderId, loc? }
  const [pending, setPending] = useState(pendingCount());
  const [error, setError] = useState("");
  // Item 9: same interruptive-popup treatment as the Driver app, not just a
  // passive banner. Keyed by ticket+hint so "Not Yet" only suppresses that
  // exact hint, not every future one.
  const [dismissedHints, setDismissedHints] = useState({});

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

  // Round 119, post-ship again round 3, item 8: replaces window.prompt with
  // a real required bottom sheet (DelayReasonSheet below) — same backend
  // requirement either way (both routes still 400 without delay_reason),
  // this just changes how it's collected. delaySheet holds everything
  // submitDelayReason needs to retry the exact same request with the reason
  // attached.
  async function confirmPumpDeparture(orderId) {
    setError("");
    try {
      await apiRequest(`/site-supervisor/orders/${orderId}/confirm-pump-departure`, { method: "POST" });
      load();
    } catch (err) {
      if (err.message.includes("reason for the delay is required")) {
        setDelaySheet({ kind: "pump", orderId });
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
      // Construction sites often have weaker GPS signal than the plant or
      // office — 4s was cutting off before a fix could be acquired often
      // enough that this looked broken. 10s gives a real shot at a lock
      // while still keeping the tap-to-confirm flow snappy.
      const timer = setTimeout(() => resolve({}), 10000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(timer); resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }); },
        () => { clearTimeout(timer); resolve({}); },
        { timeout: 10000, maximumAge: 60000 }
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
        setDelaySheet({ kind: "site-ready", orderId, loc });
      } else {
        setError(err.message);
      }
    }
  }

  async function submitDelayReason(reason) {
    if (!delaySheet) return;
    const { kind, orderId, loc } = delaySheet;
    try {
      const path = kind === "pump" ? "confirm-pump-departure" : "confirm-site-ready";
      const body = kind === "pump" ? { delay_reason: reason } : { delay_reason: reason, ...(loc || {}) };
      await apiRequest(`/site-supervisor/orders/${orderId}/${path}`, { method: "POST", body });
      setDelaySheet(null);
      load();
    } catch (err) {
      setError(err.message);
      setDelaySheet(null);
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

  // Item 9: interruptive popup for whichever hint fired first on the
  // currently-selected ticket. Reached-site -> a plain one-tap confirm
  // (arrival has no extra fields). Left-site -> the Completion form still
  // needs to be filled in properly (quantity/remarks), so "Confirm" here
  // just dismisses the popup and leaves the existing form below in view,
  // same tradeoff made on the Driver app's Site Out popup.
  let popupHint = null;
  if (selected) {
    if (selected.hint_reached_site_at && dismissedHints[`${selected.id}:reached`] !== selected.hint_reached_site_at) {
      popupHint = { key: "reached", ts: selected.hint_reached_site_at, text: `Looks like the truck reached site around ${new Date(selected.hint_reached_site_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — confirm Arrival?`, instant: true, action: "arrival" };
    } else if (selected.hint_left_site_at && dismissedHints[`${selected.id}:left`] !== selected.hint_left_site_at) {
      popupHint = { key: "left", ts: selected.hint_left_site_at, text: `Looks like the truck left site around ${new Date(selected.hint_left_site_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — if unloading is done, confirm Completion below.`, instant: false };
    }
  }
  function dismissPopup() {
    if (!popupHint) return;
    setDismissedHints((prev) => ({ ...prev, [`${selected.id}:${popupHint.key}`]: popupHint.ts }));
  }
  async function confirmPopup() {
    if (!popupHint) return;
    if (popupHint.instant) {
      dismissPopup();
      await act(popupHint.action, {});
    } else {
      dismissPopup(); // Completion form is already visible below once status is 'unloading'
    }
  }

  return (
    <>
      <TopBar title="Site Supervisor" />
      {delaySheet && (
        <DelayReasonSheet
          title={delaySheet.kind === "pump" ? "Pump departure is running late" : "Site batching confirmation is running late"}
          subtitle={
            delaySheet.kind === "pump"
              ? "Scheduled pump departure has already passed and no reason is on file yet — this only appears when a delivery is running late."
              : "This is past the scheduled batching time — a reason for the delay is required before this goes through."
          }
          onSubmit={submitDelayReason}
          onCancel={() => setDelaySheet(null)}
        />
      )}
      {popupHint && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
          <div className="card" style={{ maxWidth: 320, width: "100%", textAlign: "center" }}>
            <div style={{ fontSize: 14, marginBottom: 16 }}>{popupHint.text}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ flex: 1 }} onClick={dismissPopup}>Not Yet</button>
              <button style={{ flex: 1, background: "var(--signal-green)", color: "#fff", border: "none" }} onClick={confirmPopup}>
                {popupHint.instant ? "Confirm Arrival" : "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
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
                <div style={{ display: "inline-block", background: "var(--rebar)", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, marginBottom: 4 }}>{formatOrderNumber(o.id)}</div>
                <div style={{ fontWeight: 600 }}>{o.customer_name} — {o.site_name}</div>
                <div style={{ color: "var(--slate)" }}>Batching scheduled {o.scheduled_batching_time}</div>
                {o.sales_representative_name && (
                  <div style={{ color: "var(--slate)" }}>Sales rep: {o.sales_representative_name}</div>
                )}

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
                      <div style={{ color: "var(--slate)", fontSize: 11 }}>
                        {o.site_ready_latitude && o.site_ready_longitude
                          ? o.site_ready_location_suspect
                            ? "Location captured, but it looked far from the saved site — using the site's saved location instead."
                            : "Location captured."
                          : "Location wasn't available on your device for this confirmation — that's fine, it's optional."}
                      </div>
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

        {!selected ? (
          <div style={{ fontSize: 13, color: "var(--slate)", textAlign: "center", marginTop: 40 }}>No deliveries need your confirmation right now.</div>
        ) : (
          <>
            {deliveries.length > 1 && (
              <div style={{ fontSize: 11, color: "var(--slate)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                Up next — delivery {deliveries.findIndex((d) => d.id === selected.id) + 1} of {deliveries.length}
              </div>
            )}
            <div className="card" style={{ borderRadius: 20, padding: "20px 18px" }}>
              <div style={{ textAlign: "center", fontSize: 13, color: "var(--slate)" }}>{selected.site_name} &middot; {selected.ticket_number}</div>
              <div style={{ textAlign: "center", fontSize: 13, color: "var(--slate)", marginTop: 2 }}>
                {selected.truck_number || "No truck"} &middot; {selected.driver_name || "No driver"}
              </div>
              <div style={{ textAlign: "center", fontSize: 16, fontWeight: 600, margin: "4px 0 18px" }}>{statusLabel(selected.status)}</div>

              {/* Geofence hints — GPS movement suggests this happened, but
                  nothing is auto-confirmed (unlike the Driver app's own
                  hints, since round 119 post-ship again round 3 — this one
                  stays "suggest, never decide" on purpose: confirming a
                  truck's arrival/completion on the Supervisor's behalf isn't
                  something GPS should ever silently do for them). Purely a
                  nudge to tap the real stage below. Server only sends these
                  while the real trip_events timestamp is still null. */}
              {selected.hint_reached_site_at && (
                <div style={{ fontSize: 12, color: "var(--info)", background: "var(--info-bg, #EAF3FB)", borderRadius: 8, padding: "8px 10px", marginBottom: 12 }}>
                  Looks like the truck reached site around {new Date(selected.hint_reached_site_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Confirm Arrival will be one tap, no countdown.
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

            {/* Round 119, post-ship again round 3, item 9: replaces the plain
                <select> switcher with a stack — the "up next" delivery stays
                expanded above (with the full stage tracker), everything else
                collapses into a compact card here; tapping one brings it to
                the front instead of picking from a dropdown. */}
            {deliveries.length > 1 && (
              <div style={{ marginTop: 14 }}>
                {deliveries.filter((d) => d.id !== selected.id).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    style={{
                      width: "100%", textAlign: "left", background: "var(--concrete)", border: "none",
                      borderRadius: 10, padding: "10px 12px", marginBottom: 8, cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{d.truck_number || "No truck"}</span>
                      <span className="badge badge-neutral" style={{ fontSize: 10.5 }}>{statusLabel(d.status)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>{d.ticket_number} &middot; {d.driver_name || "No driver"}</div>
                  </button>
                ))}
              </div>
            )}
          </>
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
              {/* Buttons sized ~25% larger than standard (mockup item 9) —
                  this is the primary action surface on the supervisor's
                  screen, so it gets extra tap-target emphasis. */}
              <button
                disabled={!tappable}
                onClick={() => tappable && onAct(stage.action)}
                style={{
                  width: "100%", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 600,
                  padding: "15px 5px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
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


const NOTE_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "signed", label: "Signed" },
  { value: "refused", label: "Refused" },
];

function NoteStatusPills({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      {NOTE_STATUS_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          style={{
            flex: 1, border: "none", borderRadius: 8, padding: "8px 4px", fontSize: 12.5, fontWeight: 600,
            background: value === opt.value ? "var(--signal-green)" : "#fff",
            color: value === opt.value ? "#fff" : "var(--slate)",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Round 119, post-ship again round 3, item 11: pill restyle only — this is
// the "Mark Completion" modal from the mockup (per-delivery, triggers trip
// allowance payout). See WorkCompleteForm above for the distinct per-order
// "Work Complete" signal, which is a different flow at a different
// granularity, not a duplicate of this one.
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
      <NoteStatusPills value={noteStatus} onChange={setNoteStatus} />

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
          <div style={{ background: "var(--alert-red-bg, #FBEAEA)", color: "var(--alert-red)", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 12 }}>
            This load will not be added to the driver's trip allowance. Manager is notified automatically.
          </div>

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

// Round 119, post-ship again round 3, item 8: required bottom sheet,
// replacing window.prompt for both the pump-departure and site-ready delay
// reasons (see confirmPumpDeparture/confirmSiteReady/submitDelayReason
// above). No skip — the Submit button stays disabled until something's
// typed — but Cancel backs out of the sheet without submitting, same
// no-op-on-abandon behavior window.prompt already had (the underlying
// confirmation simply doesn't go through until a reason is provided).
function DelayReasonSheet({ title, subtitle, onSubmit, onCancel }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!reason.trim()) return;
    setSaving(true);
    await onSubmit(reason.trim());
    setSaving(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1000 }}>
      <div className="card" style={{ width: "100%", maxWidth: 400, borderRadius: "16px 16px 0 0", padding: "20px 18px", boxSizing: "border-box" }}>
        <div style={{ width: 40, height: 4, background: "var(--concrete)", borderRadius: 999, margin: "0 auto 14px" }} />
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 12, color: "var(--slate)", background: "var(--amber-bg)", borderRadius: 8, padding: "8px 10px", margin: "8px 0 12px" }}>
            {subtitle}
          </div>
        )}
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4 }}>Reason for delay *</div>
        <textarea
          rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Site access blocked, waiting on pump availability, traffic on route..."
          style={{ width: "100%", marginBottom: 6, boxSizing: "border-box" }}
        />
        <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 14 }}>
          Required — this sheet stays open until a reason is entered. There is no skip.
        </div>
        <button onClick={submit} disabled={saving || !reason.trim()} style={{ width: "100%", marginBottom: 8 }}>
          {saving ? "Saving..." : "Submit reason"}
        </button>
        <button type="button" onClick={onCancel} style={{ width: "100%", background: "none", border: "none", color: "var(--slate)", fontSize: 12 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
