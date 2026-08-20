import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount, startPeriodicFlush, flushQueue } from "../lib/offlineQueue.js";
import { TopBar } from "../lib/TopBar.jsx";
import { useT } from "../lib/i18n.js";

const STAGES = [
  { key: "plant_out", labelKey: "stage_plant_out", path: "plant-out", icon: "check" },
  { key: "site_in", labelKey: "stage_site_in", path: "arrival", icon: "check" },
  { key: "site_out", labelKey: "stage_site_out", path: "site-out", icon: "check" },
  { key: "plant_in", labelKey: "stage_plant_in", path: "plant-in", icon: "check" },
];

// A trip is done from the driver's own perspective either when the ticket
// reaches a terminal status, or — on a supervised site — once the driver
// has logged Plant In. Site In/Out belong to the Site Supervisor there, so
// waiting on their confirmation before clearing this from the driver's list
// left them staring at "needs action" for something that was never theirs
// to finish.
function isDriverDone(t) {
  return ["completed", "cancelled", "returned", "rejected"].includes(t.status) || !!t.plant_in_at;
}

// Item 9 (geofence popup): the four possible hint keys, in the order a real
// trip would move through them, so if more than one is somehow set at once
// (shouldn't normally happen — each hint clears itself the moment the real
// stage is confirmed) the earliest unconfirmed stage wins.
const HINT_STAGES = [
  { hintKey: "hint_plant_out_at", stageKey: "plant_out", path: "plant-out", hintTextKey: "hint_left_plant", selfServiceOnly: false },
  { hintKey: "hint_site_in_at", stageKey: "site_in", path: "arrival", hintTextKey: "hint_reached_site", selfServiceOnly: true },
  { hintKey: "hint_site_out_at", stageKey: "site_out", path: "site-out", hintTextKey: "hint_left_site", selfServiceOnly: true },
  { hintKey: "hint_plant_in_at", stageKey: "plant_in", path: "plant-in", hintTextKey: "hint_returned_to_plant", selfServiceOnly: false },
];

export default function DriverDuty() {
  const t = useT();
  const [onDuty, setOnDuty] = useState(false);
  const [trips, setTrips] = useState([]);
  const [pending, setPending] = useState(pendingCount());
  const [view, setView] = useState("home"); // 'home' | 'older' | 'breakdown' | 'reject'
  const [activeTicketId, setActiveTicketId] = useState(null); // which trip a form applies to
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dismissedHints, setDismissedHints] = useState({}); // `${ticketId}:${hintKey}` -> timestamp string that was dismissed
  const gpsIntervalRef = useRef(null);
  const wakeLockRef = useRef(null);
  const tripsRef = useRef([]);
  tripsRef.current = trips;

  function loadTrips() {
    apiRequest("/tickets/my-trips").then(setTrips).catch(() => {});
  }

  useEffect(() => {
    loadTrips();
    apiRequest("/driver/duty-status").then((status) => {
      setOnDuty(status.on_duty);
      if (status.on_duty) {
        startGpsPings();
        requestWakeLock();
      }
    }).catch(() => {});

    const flushInterval = startPeriodicFlush();
    const refreshAfterFlush = setInterval(() => {
      loadTrips();
      setPending(pendingCount());
    }, 30000);
    return () => { clearInterval(flushInterval); clearInterval(refreshAfterFlush); };
  }, []);

  useEffect(() => {
    return () => { clearInterval(gpsIntervalRef.current); releaseWakeLock(); };
  }, []);

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

  function currentTicketId() {
    const active = tripsRef.current.filter((t) => !isDriverDone(t));
    return active[0]?.id || null;
  }

  function pingOnce() {
    navigator.geolocation?.getCurrentPosition((pos) => {
      queuedRequest("/driver/gps-ping", {
        method: "POST",
        body: {
          ticket_id: currentTicketId(),
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          speed_kmh: pos.coords.speed ? pos.coords.speed * 3.6 : null,
          accuracy_m: pos.coords.accuracy,
        },
      }).then(() => setPending(pendingCount())).catch(() => {});
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
      // app is open and in the foreground.
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

    async function sendDuty(coords) {
      try {
        await queuedRequest("/driver/duty", { method: "POST", body: { on: next, ticket_id: currentTicketId(), ...coords } });
        setPending(pendingCount());
      } catch (err) {
        setError(err.message);
        setOnDuty(!next);
      }
    }
    navigator.geolocation?.getCurrentPosition(
      (pos) => sendDuty({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => sendDuty({})
    );
  }

  async function act(ticketId, path, body) {
    setError(""); setNotice("");
    try {
      await queuedRequest(`/driver/tickets/${ticketId}/${path}`, { method: "POST", body });
      setPending(pendingCount());
      loadTrips();
      return true;
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
      return false;
    }
  }

  // Stage taps (Plant Out / Site In / Site Out / Plant In) capture GPS at
  // that exact moment — that's what makes the manager's cross-check
  // meaningful; without it there'd be nothing to compare the logged time
  // against.
  function actWithLocation(ticketId, path, body = {}) {
    return new Promise((resolve) => {
      navigator.geolocation?.getCurrentPosition(
        (pos) => resolve(act(ticketId, path, { ...body, lat: pos.coords.latitude, lng: pos.coords.longitude })),
        () => resolve(act(ticketId, path, body)),
        { timeout: 8000 }
      );
      if (!navigator.geolocation) resolve(act(ticketId, path, body));
    });
  }

  const activeTrips = trips.filter((t) => !isDriverDone(t));
  const completedToday = trips.filter(isDriverDone);
  const current = activeTrips[0] || null;
  const older = activeTrips.slice(1);
  const activeTrip = trips.find((t) => t.id === activeTicketId);

  // Item 9: the geofence popup is interruptive (a modal, not just a passive
  // banner) — it's shown for whichever active trip has the earliest
  // still-unconfirmed hint, across ALL active trips, not just the one
  // currently on screen, so a hint on an "older" trip still gets surfaced.
  // Site In/Out hints only apply on a self-service site (no_site_supervisor)
  // — on a supervised site those are the Site Supervisor's own to confirm.
  let popupHint = null;
  for (const trip of activeTrips) {
    for (const h of HINT_STAGES) {
      if (h.selfServiceOnly && !trip.no_site_supervisor) continue;
      const ts = trip[h.hintKey];
      if (!ts) continue;
      const dismissKey = `${trip.id}:${h.hintKey}`;
      if (dismissedHints[dismissKey] === ts) continue; // already dismissed this exact hint
      popupHint = { trip, ...h, ts };
      break;
    }
    if (popupHint) break;
  }

  function dismissPopup() {
    if (!popupHint) return;
    setDismissedHints((prev) => ({ ...prev, [`${popupHint.trip.id}:${popupHint.hintKey}`]: popupHint.ts }));
  }

  async function confirmPopup() {
    if (!popupHint) return;
    if (popupHint.stageKey === "site_out") {
      // Site Out needs the slump/notes form, not a blind one-tap confirm.
      dismissPopup();
      setActiveTicketId(popupHint.trip.id);
      setView("site-out");
      return;
    }
    dismissPopup();
    await actWithLocation(popupHint.trip.id, popupHint.path, {});
  }

  if (view === "breakdown") {
    return (
      <BreakdownForm
        trip={activeTrip || current}
        onDone={(msg) => { setView("home"); setNotice(msg); setPending(pendingCount()); }}
        onCancel={() => setView("home")}
      />
    );
  }
  if (view === "reject") {
    return (
      <RejectForm
        trip={activeTrip}
        onAct={act}
        error={error}
        onDone={() => { setView("home"); loadTrips(); }}
      />
    );
  }
  if (view === "older") {
    return (
      <>
        <TopBar title={`${t("driver_title")} · Older trips`} />
        <div style={{ maxWidth: 360, margin: "0 auto", padding: "0 16px 32px" }}>
          <button onClick={() => setView("home")} style={{ marginBottom: 16 }}>&larr; {t("back")}</button>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
          {older.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No older trips waiting.</div>
          ) : (
            older.map((t) => (
              <TripCard
                key={t.id}
                trip={t}
                onAct={(path, body) => actWithLocation(t.id, path, body)}
                onSiteOut={() => { setActiveTicketId(t.id); setView("site-out"); }}
                onReject={() => { setActiveTicketId(t.id); setView("reject"); }}
                compact
              />
            ))
          )}
        </div>
      </>
    );
  }
  if (view === "site-out") {
    const trip = activeTrip || current;
    return (
      <>
        <TopBar title={`${t("driver_title")} · ${t("stage_site_out")}`} />
        <div style={{ maxWidth: 360, margin: "0 auto", padding: "0 16px 32px" }}>
          <button onClick={() => setView(older.some((t) => t.id === trip?.id) ? "older" : "home")} style={{ marginBottom: 16 }}>&larr; {t("back")}</button>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{trip?.ticket_number}</div>
          <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>{trip?.customer_name} &middot; {trip?.site_name}</div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <SiteOutForm onAct={(body) => actWithLocation(trip.id, "site-out", body)} onDone={() => setView("home")} />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title={t("driver_title")} />
      <div style={{ maxWidth: 360, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <Link to="/driver/settings" style={{ fontSize: 12, color: "var(--slate)", textDecoration: "none" }}>
            ⚙ {t("settings")}
          </Link>
        </div>
        <button
          onClick={toggleDuty}
          style={{
            width: "100%", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600,
            padding: 12, marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: onDuty ? "var(--alert-red)" : "var(--signal-green)", color: "#fff",
          }}
        >
          {onDuty ? t("punched_in") : t("punch_in")}
        </button>

        {!navigator.onLine && (
          <div style={{ textAlign: "center", fontSize: 12, background: "var(--amber-bg)", color: "var(--amber)", padding: 6, borderRadius: 8, marginBottom: 12 }}>
            {t("offline_notice")}
          </div>
        )}
        {pending > 0 && (
          <div style={{ textAlign: "center", fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
            {t("pending_actions", { count: pending })}
            <button
              style={{ display: "block", margin: "6px auto 0", fontSize: 11, padding: "4px 10px" }}
              onClick={async () => { await flushQueue(); setPending(pendingCount()); loadTrips(); }}
            >
              {t("sync_now")}
            </button>
          </div>
        )}
        {notice && <div style={{ textAlign: "center", fontSize: 12, color: "var(--signal-green)", marginBottom: 12 }}>{notice}</div>}
        {error && <div style={{ textAlign: "center", fontSize: 12, color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        {current ? (
          <TripCard
            trip={current}
            onAct={(path, body) => actWithLocation(current.id, path, body)}
            onSiteOut={() => { setActiveTicketId(current.id); setView("site-out"); }}
            onReject={() => { setActiveTicketId(current.id); setView("reject"); }}
          />
        ) : (
          <div className="card" style={{ textAlign: "center", fontSize: 13, color: "var(--slate)", marginBottom: 10 }}>
            {t("no_trip")}
          </div>
        )}

        {older.length > 0 && (
          <a
            href="#" onClick={(e) => { e.preventDefault(); setView("older"); }}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", borderRadius: 8, padding: "10px 12px", textDecoration: "none", marginBottom: 16 }}
          >
            <span style={{ fontSize: 12, color: "var(--alert-red)", fontWeight: 600 }}>
              {t("older_trips_need_action", { count: older.length })}
            </span>
            <span style={{ color: "var(--alert-red)" }}>&rsaquo;</span>
          </a>
        )}

        {completedToday.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              {t("completed_label")} ({completedToday.length})
              {completedToday.some((t) => t.allowance_paid) && (
                <span style={{ color: "var(--signal-green)", fontWeight: 400 }}>
                  {" "}&middot; ₹{completedToday.reduce((s, t) => s + Number(t.allowance_paid || 0), 0)} {t("earned_suffix")}
                </span>
              )}
            </div>
            {completedToday.map((tr) => {
              const isToday = new Date(tr.ticket_date).toDateString() === new Date().toDateString();
              return (
                <div key={tr.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--concrete)", fontSize: 12 }}>
                  <div>
                    <div>{tr.ticket_number} &middot; {tr.customer_name}</div>
                    <div style={{ fontSize: 10, color: "var(--slate)" }}>
                      {!isToday && `${new Date(tr.ticket_date).toLocaleDateString([], { day: "2-digit", month: "short" })} · `}
                      {tr.status === "rejected" ? "Rejected" : tr.plant_in_at ? `Plant In ${formatTime(tr.plant_in_at)}` : `Site Out ${formatTime(tr.site_out_at)}`}
                    </div>
                  </div>
                  {tr.allowance_paid ? <span style={{ color: "var(--signal-green)", fontWeight: 600 }}>+₹{tr.allowance_paid}</span> : null}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button
            onClick={() => {
              if (!current?.truck_id) { setError("No truck assigned yet — can't report this without one."); return; }
              setError(""); setNotice(""); setView("breakdown");
            }}
          >
            {t("report_breakdown")}
          </button>
          <Link to="/fuel"><button type="button" style={{ width: "100%" }}>{t("report_fuel")}</button></Link>
        </div>
      </div>

      {popupHint && (
        <GeofenceHintModal
          trip={popupHint.trip}
          text={t(popupHint.hintTextKey, { time: formatTime(popupHint.ts) })}
          stageLabel={t(STAGES.find((s) => s.key === popupHint.stageKey)?.labelKey)}
          onConfirm={confirmPopup}
          onDismiss={dismissPopup}
          t={t}
        />
      )}
    </>
  );
}

// Item 9: an actual interruptive popup (not a passive banner) shown when the
// app is open in the foreground and a geofence hint fires for a stage
// nobody's confirmed yet. Purely a nudge either way — nothing is
// auto-confirmed by showing this; "Confirm" just does exactly what tapping
// the real stage button would.
function GeofenceHintModal({ text, stageLabel, onConfirm, onDismiss, t }) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex",
        alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20,
      }}
    >
      <div className="card" style={{ maxWidth: 320, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 14, marginBottom: 16 }}>{text}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ flex: 1 }} onClick={onDismiss} disabled={busy}>{t("not_yet")}</button>
          <button
            className="btn-primary"
            style={{ flex: 1, background: "var(--signal-green)", color: "#fff", border: "none" }}
            disabled={busy}
            onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }}
          >
            {t("confirm_stage", { stage: stageLabel })}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TripCard({ trip, onAct, onSiteOut, onReject, compact }) {
  const t = useT();
  const canDriverActSiteStages = trip.no_site_supervisor;

  const stageState = (key) => {
    if (trip[`${key}_at`]) return "done";
    // On a supervised site, Plant In doesn't wait on Site Out — that's the
    // Supervisor's own confirmation, on their own timing, and a driver
    // shouldn't be stuck unable to close a trip just because that hasn't
    // happened yet. Only a no-supervisor site (where the driver logs Site
    // Out themselves) keeps the full sequential order.
    if (key === "plant_in" && !canDriverActSiteStages) {
      return trip.plant_out_at ? "actionable" : "locked";
    }
    const order = ["plant_out", "site_in", "site_out", "plant_in"];
    const idx = order.indexOf(key);
    const priorDone = idx === 0 || trip[`${order[idx - 1]}_at`];
    return priorDone ? "actionable" : "locked";
  };

  function tapStage(stage) {
    if (stage.key === "plant_out") onAct("plant-out", {});
    else if (stage.key === "site_in") onAct("arrival", {});
    else if (stage.key === "site_out") onSiteOut();
    else if (stage.key === "plant_in") onAct("plant-in", {});
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--slate)" }}>{compact ? t("assigned") : t("current_trip")}</div>
          <div style={{ fontSize: compact ? 14 : 17, fontWeight: 600 }}>{trip.ticket_number}</div>
        </div>
        {trip.trip_allowance_amount && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "var(--slate)" }}>{t("trip_allowance")}</div>
            <div style={{ fontSize: compact ? 14 : 17, fontWeight: 600, color: "var(--signal-green)" }}>₹{trip.trip_allowance_amount}</div>
          </div>
        )}
      </div>
      <div style={{ fontSize: compact ? 13 : 15, fontWeight: 500 }}>{trip.customer_name}</div>
      <div style={{ fontSize: compact ? 12 : 14, color: "var(--slate)", marginBottom: 8 }}>{trip.site_name}</div>
      {trip.site_latitude && trip.site_longitude && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: compact ? 10 : 20, fontSize: 13 }}>
          {trip.distance_from_plant_km && <span style={{ color: "var(--slate)" }}>{trip.distance_from_plant_km} {t("km_from_plant")}</span>}
          <a href={`https://maps.google.com/?q=${trip.site_latitude},${trip.site_longitude}`} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
            {t("site_location")}
          </a>
        </div>
      )}

      {!canDriverActSiteStages && (
        <div style={{ fontSize: 12, color: "var(--rebar)", background: "var(--concrete)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
          {t("site_supervisor_note", { name: trip.site_supervisor_name || t("the_site_supervisor") })}
        </div>
      )}

      {/* Geofence hints — the app noticed GPS movement suggesting this stage
          happened, but nothing is auto-confirmed. Purely a nudge to tap the
          real button below; disappears the moment that stage is logged for
          real (server only sends the hint while the real timestamp is null).
          The same hint also pops up as an interruptive modal (see
          GeofenceHintModal above) — this banner stays too, since a trip
          further down the "older trips" list won't be the one shown in the
          modal at any given moment. */}
      {trip.hint_plant_out_at && (
        <div style={{ fontSize: 12, color: "var(--info)", background: "var(--info-bg, #EAF3FB)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
          {t("hint_left_plant", { time: formatTime(trip.hint_plant_out_at) })}
        </div>
      )}
      {canDriverActSiteStages && trip.hint_site_in_at && (
        <div style={{ fontSize: 12, color: "var(--info)", background: "var(--info-bg, #EAF3FB)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
          {t("hint_reached_site", { time: formatTime(trip.hint_site_in_at) })}
        </div>
      )}
      {canDriverActSiteStages && trip.hint_site_out_at && (
        <div style={{ fontSize: 12, color: "var(--info)", background: "var(--info-bg, #EAF3FB)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
          {t("hint_left_site", { time: formatTime(trip.hint_site_out_at) })}
        </div>
      )}
      {trip.hint_plant_in_at && (
        <div style={{ fontSize: 12, color: "var(--info)", background: "var(--info-bg, #EAF3FB)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
          {t("hint_returned_to_plant", { time: formatTime(trip.hint_plant_in_at) })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-start" }}>
        {STAGES.map((stage, i) => {
          const state = stageState(stage.key);
          const driverCanTap = (stage.key === "plant_out" || stage.key === "plant_in") ? true : canDriverActSiteStages;
          const tappable = state === "actionable" && driverCanTap;
          return (
            <div key={stage.key} style={{ display: "flex", alignItems: "flex-start", flex: i === STAGES.length - 1 ? "0 0 auto" : 1 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: compact ? 56 : 70 }}>
                <button
                  disabled={!tappable}
                  onClick={() => tappable && tapStage(stage)}
                  style={{
                    width: "100%", border: "none", borderRadius: 8, fontSize: compact ? 11 : 13, fontWeight: 600,
                    padding: compact ? "8px 2px" : "12px 4px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    background: state === "done" ? "var(--signal-green)" : tappable ? "var(--rebar)" : "var(--concrete)",
                    color: state === "done" || tappable ? "#fff" : "var(--slate)",
                  }}
                >
                  {t(stage.labelKey)}
                </button>
                <div style={{ fontSize: 10, color: state === "done" ? "var(--slate)" : tappable ? "var(--rebar)" : "var(--slate)", marginTop: 5 }}>
                  {trip[`${stage.key}_at`] ? formatTime(trip[`${stage.key}_at`]) : tappable ? t("tap_to_log") : t("waiting")}
                </div>
              </div>
              {i < STAGES.length - 1 && <div style={{ height: 1, background: "var(--concrete)", flex: "0 0 10px", marginTop: compact ? 18 : 24 }} />}
            </div>
          );
        })}
      </div>

      {canDriverActSiteStages && stageState("site_in") === "done" && stageState("site_out") !== "done" && (
        <button className="btn-danger" style={{ width: "100%", marginTop: 10, fontSize: 12 }} onClick={onReject}>
          {t("reject_concrete")}
        </button>
      )}
    </div>
  );
}

function SiteOutForm({ onAct, onDone }) {
  const [slump, setSlump] = useState("");
  const [noteStatus, setNoteStatus] = useState("pending");
  const [afterPourCare, setAfterPourCare] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const ok = await onAct({
      site_slump_mm: slump,
      delivery_note_status: noteStatus,
      after_pour_care_confirmed: afterPourCare,
      remarks,
    });
    setSaving(false);
    if (ok) onDone();
  }

  return (
    <div style={{ fontSize: 13 }}>
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
        {saving ? "Saving..." : "Log Site Out"}
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
    const ok = await onAct(trip.id, "reject", {
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
      // Round 97, item 2 — capture GPS at the moment of reporting, same
      // pattern as actWithLocation() above: best-effort, never blocks the
      // report on a GPS failure/timeout.
      const coords = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve({});
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
          () => resolve({}),
          { timeout: 8000 }
        );
      });
      await queuedRequest("/driver/breakdown", {
        method: "POST",
        body: { truck_id: trip.truck_id, location, remarks, ...coords },
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
