import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount, startPeriodicFlush, flushQueue } from "../lib/offlineQueue.js";
import FollowupsDue from "../lib/FollowupsDue.jsx";

const LEAD_STATUS_BADGE = {
  new: "badge-neutral", contacted: "badge-info", quoted: "badge-progress",
  won: "badge-success", lost: "badge-danger",
};
const BOOKING_STATUS_BADGE = {
  pending: "badge-warning", converted: "badge-success", declined: "badge-danger",
};
const ACTIVITY_LABEL = {
  note: "Note", quotation_issued: "Quotation issued", quotation_followup: "Quotation follow-up",
  quotation_revised: "Quotation revised", meeting: "Meeting", site_visit: "Site visit",
};

// Shared "are you at site?" control — captures GPS if yes, records
// "not updated from site" if no. Used by both lead updates and customer visits.
function AtSitePrompt({ atSite, setAtSite, coords, setCoords }) {
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");

  function chooseYes() {
    setAtSite(true);
    setLocating(true); setLocError("");
    navigator.geolocation?.getCurrentPosition(
      (pos) => { setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }); setLocating(false); },
      () => { setLocError("Couldn't get your location — check location permission."); setLocating(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
  function chooseNo() {
    setAtSite(false);
    setCoords(null);
    setLocError("");
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Are you at site?</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={chooseYes} style={atSite === true ? { border: "1px solid var(--rebar)", fontWeight: 600 } : undefined}>Yes</button>
        <button type="button" onClick={chooseNo} style={atSite === false ? { border: "1px solid var(--rebar)", fontWeight: 600 } : undefined}>No</button>
      </div>
      {atSite === true && locating && <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>Capturing your location...</div>}
      {atSite === true && !locating && coords && <div style={{ fontSize: 11, color: "var(--signal-green)", marginTop: 4 }}>Location captured.</div>}
      {atSite === true && !locating && locError && <div style={{ fontSize: 11, color: "var(--alert-red)", marginTop: 4 }}>{locError}</div>}
      {atSite === false && <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>Will be recorded as "not updated from site."</div>}
    </div>
  );
}

export default function SalesExecutive() {
  const [view, setView] = useState("dashboard");
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [leads, setLeads] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [visits, setVisits] = useState([]);
  const [forecasts, setForecasts] = useState([]);
  const [error, setError] = useState("");
  const [onDuty, setOnDuty] = useState(false);
  const [dutyStatus, setDutyStatus] = useState(null);
  const [pending, setPending] = useState(pendingCount());
  const gpsIntervalRef = useRef(null);
  const wakeLockRef = useRef("off");

  async function loadAll() {
    try {
      const [d, l, b, f, v, fc] = await Promise.all([
        apiRequest("/sales/my-dashboard"),
        apiRequest("/sales/leads"),
        apiRequest("/sales/bookings"),
        apiRequest("/sales/feedback"),
        apiRequest("/sales/visits"),
        apiRequest("/sales/forecasts"),
      ]);
      setDashboard(d); setLeads(l); setBookings(b); setFeedback(f); setVisits(v); setForecasts(fc);
    } catch (err) {
      setError(err.message);
    }
  }
  async function loadDutyStatus() {
    try {
      const status = await apiRequest("/sales/duty-status");
      setOnDuty(status.on_duty);
      setDutyStatus(status);
      return status;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    loadAll();
    loadDutyStatus().then((status) => {
      if (status?.on_duty) { startGpsPings(); requestWakeLock(); }
    });
    // Same fix as Driver's/Site Supervisor's/Plant Operator's screens:
    // catches actions queued at a low-signal moment that would otherwise sit
    // unsent until the app happens to see an offline→online transition.
    const flushInterval = startPeriodicFlush();
    return () => { clearInterval(flushInterval); clearInterval(gpsIntervalRef.current); };
  }, []);

  function pingOnce() {
    navigator.geolocation?.getCurrentPosition((pos) => {
      queuedRequest("/sales/gps-ping", {
        method: "POST",
        body: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy_m: pos.coords.accuracy },
      }).then(() => setPending(pendingCount())).catch(() => {});
    });
  }

  function startGpsPings() {
    clearInterval(gpsIntervalRef.current);
    pingOnce();
    gpsIntervalRef.current = setInterval(pingOnce, 5 * 60 * 1000); // every 5 min — field visits, not a moving vehicle
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

  async function toggleDuty() {
    const next = !onDuty;
    setOnDuty(next);
    if (next) { startGpsPings(); requestWakeLock(); }
    else { clearInterval(gpsIntervalRef.current); wakeLockRef.current = "off"; }

    async function sendDuty(coords) {
      try {
        await queuedRequest("/sales/duty", { method: "POST", body: { on: next, ...coords } });
        setPending(pendingCount());
        loadDutyStatus();
      } catch (err) {
        setError(err.message);
        setOnDuty(!next); // the call actually failed (not just queued) — don't show a duty state that never took effect
      }
    }
    navigator.geolocation?.getCurrentPosition(
      (pos) => sendDuty({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => sendDuty({})
    );
  }

  if (view === "lead-detail" && selectedLeadId) {
    return (
      <LeadDetail
        leadId={selectedLeadId}
        onBack={() => { setView("leads"); setSelectedLeadId(null); loadAll(); }}
      />
    );
  }
  if (view === "new-lead") {
    return <NewLeadForm onDone={() => { setView("leads"); loadAll(); }} onCancel={() => setView("leads")} />;
  }
  if (view === "new-booking") {
    return <NewBookingForm onDone={() => { setView("bookings"); loadAll(); }} onCancel={() => setView("bookings")} />;
  }
  if (view === "new-feedback") {
    return <NewFeedbackForm onDone={() => { setView("feedback"); loadAll(); }} onCancel={() => setView("feedback")} />;
  }
  if (view === "new-visit") {
    return <NewVisitForm onDone={() => { setView("visits"); loadAll(); }} onCancel={() => setView("visits")} />;
  }

  return (
    <>
      <TopBar title="Sales Executive" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <button
          onClick={toggleDuty}
          className={onDuty ? "btn-danger" : "btn-primary"}
          style={{ width: "100%", marginBottom: 8, padding: 12, fontSize: 14, fontWeight: 600 }}
        >
          {onDuty ? "On duty — tap to clock off" : "Off duty — tap to clock in"}
        </button>
        {dutyStatus?.since && (
          <div style={{ textAlign: "center", fontSize: 12, color: "var(--slate)", marginBottom: 8 }}>
            {onDuty ? "On duty since " : "Off duty since "}
            {new Date(dutyStatus.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
        {dutyStatus?.today?.length > 0 && (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", fontSize: 11, marginBottom: 12 }}>
            {dutyStatus.today.map((e, i) => (
              <span key={i} style={{ color: e.is_on ? "var(--signal-green)" : "var(--slate)" }}>
                {e.is_on ? "In " : "Out "}
                {new Date(e.event_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            ))}
          </div>
        )}
        {pending > 0 && (
          <div style={{ textAlign: "center", fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
            {pending} action(s) waiting to sync
            <button
              style={{ display: "block", margin: "6px auto 0", fontSize: 11, padding: "4px 10px" }}
              onClick={async () => { await flushQueue(); setPending(pendingCount()); }}
            >
              Sync now
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {[["dashboard", "Dashboard"], ["leads", "My leads"], ["bookings", "Bookings"], ["visits", "Visits"], ["feedback", "Feedback"]].map(([key, label]) => (
            <button
              key={key}
              className={`btn-tab ${view === key ? "active" : ""}`}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
          <Link to="/sales-forecast"><button className="btn-tab">Forecast</button></Link>
        </div>

        {view === "dashboard" && <Dashboard data={dashboard} forecasts={forecasts} onDuty={onDuty} />}
        {view === "leads" && (
          <LeadsList leads={leads} onDuty={onDuty} onOpen={(id) => { setSelectedLeadId(id); setView("lead-detail"); }} onNew={() => setView("new-lead")} />
        )}
        {view === "bookings" && (
          <BookingsList bookings={bookings} onDuty={onDuty} onNew={() => setView("new-booking")} />
        )}
        {view === "visits" && (
          <VisitsList visits={visits} onDuty={onDuty} onNew={() => setView("new-visit")} />
        )}
        {view === "feedback" && (
          <FeedbackList feedback={feedback} onDuty={onDuty} onNew={() => setView("new-feedback")} />
        )}
      </div>
    </>
  );
}

function Dashboard({ data, forecasts, onDuty }) {
  if (!data) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;
  const leadCounts = data.lead_counts || {};
  const expiredCount = (forecasts || []).filter((f) => f.is_expired).length;
  return (
    <>
      <FollowupsDue />
      {!onDuty && (
        <div className="card" style={{ marginBottom: 16, borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>You're off duty</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>Clock in above to add leads, bookings, visits, feedback, or forecasts.</div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Kpi label="My customers" value={data.customers.length} />
        <Kpi label="Orders this month" value={`${data.orders_month_qty} m³`} />
        <Kpi label="Sales value this month" value={inr(data.orders_month_value)} />
        <Kpi label="Outstanding" value={inr(data.outstanding)} danger={Number(data.outstanding) > 0} />
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Your forecasts
            {expiredCount > 0 && <span className="badge badge-warning" style={{ marginLeft: 8 }}>{expiredCount} need refresh</span>}
          </div>
          <Link to="/sales-forecast" style={{ fontSize: 12 }}>View / add forecasts</Link>
        </div>
        {(!forecasts || forecasts.length === 0) ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing forecasted yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {forecasts.map((f) => (
              <div key={f.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, background: "var(--concrete)", borderRadius: 8, padding: "6px 10px" }}>
                <span>{f.customer_name} &middot; {f.site_name}</span>
                <span>
                  {f.expected_qty_m3} m³ / {f.period_days}d
                  {f.is_expired && <span className="badge badge-warning" style={{ marginLeft: 6, fontSize: 10 }}>Expired</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Leads by stage</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["new", "contacted", "quoted", "won", "lost"].map((s) => (
            <span key={s} className={`badge ${LEAD_STATUS_BADGE[s]}`}>{s} ({leadCounts[s] || 0})</span>
          ))}
        </div>
      </div>
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Outstanding by customer</div>
        {(!data.outstanding_by_customer || data.outstanding_by_customer.length === 0) ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing outstanding under your customers.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>Customer</th><th>Outstanding</th></tr></thead>
              <tbody>
                {data.outstanding_by_customer.map((c, i) => (
                  <tr key={i}><td>{c.customer_name}</td><td>{inr(c.outstanding)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function LeadsList({ leads, onOpen, onNew, onDuty }) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>My leads</div>
        <button onClick={onNew} disabled={!onDuty} title={!onDuty ? "Clock in first" : ""} style={{ fontSize: 12, padding: "5px 10px" }}>+ New lead</button>
      </div>
      {leads.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No leads yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {leads.map((l) => (
            <div key={l.id} onClick={() => onOpen(l.id)} style={{ cursor: "pointer", background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{l.prospect_name}</span>
                <span className={`badge ${LEAD_STATUS_BADGE[l.status]}`}>{l.status}</span>
              </div>
              {l.contact_phone && <div style={{ color: "var(--slate)" }}>{l.contact_phone}</div>}
              {l.site_location && <div style={{ color: "var(--slate)" }}>{l.site_location}</div>}
              {l.quotation_issued && <div style={{ color: "var(--slate)" }}>Quoted ₹{l.latest_quotation_amount}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewLeadForm({ onDone, onCancel }) {
  const [form, setForm] = useState({ prospect_name: "", contact_person: "", contact_phone: "", site_location: "", mix_grade_interest: "", estimated_qty_m3: "" });
  const [atSite, setAtSite] = useState(null);
  const [coords, setCoords] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (atSite === null) return setError("Let us know whether you're at site.");
    setSaving(true);
    try {
      await apiRequest("/sales/leads/self", {
        method: "POST",
        body: { ...form, at_site: atSite, latitude: coords?.latitude, longitude: coords?.longitude },
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Sales Executive · New lead" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <button onClick={onCancel} style={{ marginBottom: 16 }}>← Back</button>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Add a lead</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div><div style={{ color: "var(--slate)" }}>Prospect name</div><input value={form.prospect_name} onChange={(e) => setForm({ ...form, prospect_name: e.target.value })} required /></div>
            <div><div style={{ color: "var(--slate)" }}>Contact person</div><input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} /></div>
            <div><div style={{ color: "var(--slate)" }}>Contact phone</div><input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} /></div>
            <div><div style={{ color: "var(--slate)" }}>Site / location</div><input value={form.site_location} onChange={(e) => setForm({ ...form, site_location: e.target.value })} /></div>
            <div><div style={{ color: "var(--slate)" }}>Grade interested in</div><input value={form.mix_grade_interest} onChange={(e) => setForm({ ...form, mix_grade_interest: e.target.value })} placeholder="e.g. M25" /></div>
            <div><div style={{ color: "var(--slate)" }}>Estimated qty (m³)</div><input type="number" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} /></div>
            <AtSitePrompt atSite={atSite} setAtSite={setAtSite} coords={coords} setCoords={setCoords} />
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <button type="submit" disabled={saving}>{saving ? "Saving..." : "Add lead"}</button>
          </form>
        </div>
      </div>
    </>
  );
}

function LeadDetail({ leadId, onBack }) {
  const [lead, setLead] = useState(null);
  const [activityType, setActivityType] = useState("note");
  const [note, setNote] = useState("");
  const [quotationAmount, setQuotationAmount] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [personsMet, setPersonsMet] = useState("");
  const [atSite, setAtSite] = useState(null);
  const [coords, setCoords] = useState(null);
  const [lostReason, setLostReason] = useState("");
  const [showLost, setShowLost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      setLead(await apiRequest(`/sales/leads/${leadId}`));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [leadId]);

  async function addUpdate() {
    if (!note) return setError("Enter a note.");
    if (atSite === null) return setError("Let us know whether you're at site.");
    setSaving(true); setError("");
    try {
      await apiRequest(`/sales/leads/${leadId}/followup`, {
        method: "POST",
        body: {
          activity_type: activityType, note,
          quotation_amount: quotationAmount || null,
          revision_reason: revisionReason || null,
          persons_met: personsMet || null,
          at_site: atSite,
          latitude: coords?.latitude, longitude: coords?.longitude,
        },
      });
      setNote(""); setQuotationAmount(""); setRevisionReason(""); setPersonsMet(""); setAtSite(null); setCoords(null); setActivityType("note");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function markLost() {
    if (!lostReason) return setError("Enter a reason.");
    setSaving(true); setError("");
    try {
      await apiRequest(`/sales/leads/${leadId}/lost`, { method: "POST", body: { lost_reason: lostReason } });
      load();
      setShowLost(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!lead) {
    return (
      <>
        <TopBar title="Sales Executive · Lead" />
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
          {error ? <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div> : <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Sales Executive · Lead" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <button onClick={onBack} style={{ marginBottom: 16 }}>← Back to leads</button>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}

        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{lead.prospect_name}</div>
            <span className={`badge ${LEAD_STATUS_BADGE[lead.status]}`}>{lead.status}</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--slate)" }}>
            {lead.contact_person && <div>Contact: {lead.contact_person} {lead.contact_phone ? `· ${lead.contact_phone}` : ""}</div>}
            {lead.site_location && <div>Location: {lead.site_location}</div>}
            {lead.mix_grade_interest && <div>Interested in: {lead.mix_grade_interest}</div>}
            {lead.estimated_qty_m3 && <div>Estimated quantity: {lead.estimated_qty_m3} m³</div>}
            {lead.quotation_issued && <div>Latest quotation: ₹{lead.latest_quotation_amount}</div>}
            <div>{lead.at_site === false ? "Added: not updated from site" : lead.at_site ? "Added from site" : ""}</div>
            {lead.status === "lost" && lead.lost_reason && <div style={{ color: "var(--alert-red)", marginTop: 6 }}>Lost — {lead.lost_reason}</div>}
          </div>
          {lead.site_latitude && lead.site_longitude && (
            <a
              href={`https://maps.google.com/?q=${lead.site_latitude},${lead.site_longitude}`}
              target="_blank" rel="noreferrer"
              style={{ display: "block", textAlign: "center", marginTop: 10, padding: 10, background: "var(--rebar)", color: "#fff", borderRadius: 8, fontWeight: 600, textDecoration: "none", fontSize: 13 }}
            >
              Navigate to site in Google Maps
            </a>
          )}
        </div>

        {!["won", "lost"].includes(lead.status) && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Add an update</div>
            <div className="field-input" style={{ fontSize: 13 }}>
              <div style={{ color: "var(--slate)", marginBottom: 4 }}>Type</div>
              <select value={activityType} onChange={(e) => setActivityType(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
                <option value="note">General note</option>
                <option value="quotation_issued">Quotation issued</option>
                <option value="quotation_followup">Quotation follow-up</option>
                <option value="quotation_revised">Quotation revised</option>
                <option value="meeting">Meeting</option>
                <option value="site_visit">Site visit</option>
              </select>

              {(activityType === "quotation_issued" || activityType === "quotation_revised") && (
                <>
                  <div style={{ color: "var(--slate)", marginBottom: 4 }}>Quotation amount (₹)</div>
                  <input type="number" value={quotationAmount} onChange={(e) => setQuotationAmount(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
                </>
              )}
              {activityType === "quotation_revised" && (
                <>
                  <div style={{ color: "var(--slate)", marginBottom: 4 }}>Reason for revision</div>
                  <input value={revisionReason} onChange={(e) => setRevisionReason(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
                </>
              )}
              {activityType === "meeting" && (
                <>
                  <div style={{ color: "var(--slate)", marginBottom: 4 }}>Persons met</div>
                  <input value={personsMet} onChange={(e) => setPersonsMet(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
                </>
              )}

              <div style={{ color: "var(--slate)", marginBottom: 4 }}>Notes</div>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

              <AtSitePrompt atSite={atSite} setAtSite={setAtSite} coords={coords} setCoords={setCoords} />

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={addUpdate} disabled={saving} style={{ flex: 1 }}>{saving ? "Saving..." : "Save update"}</button>
                <button className="btn-danger" style={{ flex: 1 }} onClick={() => setShowLost(!showLost)}>Mark lost</button>
              </div>
              {showLost && (
                <div style={{ marginTop: 10 }}>
                  <input type="text" value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Reason — price, timeline, went with competitor..." style={{ width: "100%", marginBottom: 8 }} />
                  <button className="btn-danger" onClick={markLost} disabled={saving} style={{ width: "100%" }}>Confirm lost</button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Activity history</div>
          {(!lead.followups || lead.followups.length === 0) ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No updates yet.</div>
          ) : (
            lead.followups.map((f) => (
              <div key={f.id} style={{ fontSize: 12, padding: "6px 0", borderBottom: "1px solid var(--concrete)" }}>
                <div style={{ fontWeight: 600 }}>{ACTIVITY_LABEL[f.activity_type] || "Note"}</div>
                <div>{f.note}</div>
                <div style={{ color: "var(--slate)" }}>
                  {new Date(f.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}
                  {" · "}{f.at_site === false ? "Not updated from site" : f.at_site ? "At site" : ""}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function BookingsList({ bookings, onNew, onDuty }) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>My bookings</div>
        <button onClick={onNew} disabled={!onDuty} title={!onDuty ? "Clock in first" : ""} style={{ fontSize: 12, padding: "5px 10px" }}>+ New booking</button>
      </div>
      {bookings.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No bookings placed yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {bookings.map((b) => (
            <div key={b.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{b.customer_name}</span>
                <span className={`badge ${BOOKING_STATUS_BADGE[b.status]}`}>{b.status}</span>
              </div>
              <div style={{ color: "var(--slate)" }}>{b.site_name || "Site TBD"} · {b.mix_grade_name || "Grade TBD"} · {b.estimated_qty_m3 ? `${b.estimated_qty_m3} m³` : ""}</div>
              {b.status === "declined" && b.declined_reason && <div style={{ color: "var(--alert-red)" }}>Declined — {b.declined_reason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewBookingForm({ onDone, onCancel }) {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [mixGrades, setMixGrades] = useState([]);
  const [form, setForm] = useState({ customer_id: "", site_id: "", mix_grade_id: "", estimated_qty_m3: "", preferred_date: "", preferred_time: "", notes: "", site_latitude: "", site_longitude: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites"), apiRequest("/master/mix-grades")])
      .then(([c, s, m]) => { setCustomers(c); setSites(s); setMixGrades(m); })
      .catch((err) => setError(err.message));
  }, []);

  const sitesForCustomer = form.customer_id ? sites.filter((s) => String(s.customer_id) === String(form.customer_id)) : sites;

  async function addCustomer() {
    const name = window.prompt("New customer name:");
    if (!name || !name.trim()) return;
    setError("");
    try {
      const created = await apiRequest("/sales/quick-customer", { method: "POST", body: { name } });
      setCustomers((prev) => [...prev, created]);
      setForm((f) => ({ ...f, customer_id: created.id, site_id: "" }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function addSite() {
    if (!form.customer_id) { setError("Select a customer first."); return; }
    const name = window.prompt("New site/project name:");
    if (!name || !name.trim()) return;
    setError("");
    try {
      const created = await apiRequest("/sales/quick-site", { method: "POST", body: { customer_id: form.customer_id, name } });
      setSites((prev) => [...prev, created]);
      setForm((f) => ({ ...f, site_id: created.id }));
    } catch (err) {
      if (err.status === 409 && window.confirm(`${err.message}\n\nCreate it anyway?`)) {
        try {
          const created = await apiRequest("/sales/quick-site", { method: "POST", body: { customer_id: form.customer_id, name, force: true } });
          setSites((prev) => [...prev, created]);
          setForm((f) => ({ ...f, site_id: created.id }));
        } catch (err2) { setError(err2.message); }
      } else if (err.status !== 409) {
        setError(err.message);
      }
    }
  }

  function useCurrentLocation() {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, site_latitude: pos.coords.latitude.toFixed(7), site_longitude: pos.coords.longitude.toFixed(7) }));
        setLocating(false);
      },
      () => { setError("Couldn't get current location — enter coordinates manually if you have them."); setLocating(false); }
    );
  }

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/sales/bookings", { method: "POST", body: form });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Sales Executive · New booking" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <button onClick={onCancel} style={{ marginBottom: 16 }}>← Back</button>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Place a booking</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Customer</div>
              <div style={{ display: "flex", gap: 6 }}>
                <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value, site_id: "" })} required style={{ flex: 1 }}>
                  <option value="">Select</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" onClick={addCustomer} style={{ fontSize: 12, padding: "4px 10px" }}>+ New</button>
              </div>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Site (if known)</div>
              <div style={{ display: "flex", gap: 6 }}>
                <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} style={{ flex: 1 }}>
                  <option value="">Not decided yet</option>
                  {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button type="button" onClick={addSite} disabled={!form.customer_id} style={{ fontSize: 12, padding: "4px 10px" }}>+ New</button>
              </div>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Site location (GPS)</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
                <input type="number" step="any" value={form.site_latitude} onChange={(e) => setForm({ ...form, site_latitude: e.target.value })} placeholder="Latitude" />
                <input type="number" step="any" value={form.site_longitude} onChange={(e) => setForm({ ...form, site_longitude: e.target.value })} placeholder="Longitude" />
              </div>
              <button type="button" onClick={useCurrentLocation} disabled={locating} style={{ fontSize: 12, padding: "5px 10px" }}>
                {locating ? "Getting location..." : "Use my current location"}
              </button>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
                If this is a new site, this carries through automatically once Manager converts the booking — drivers can navigate there from the first delivery.
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ color: "var(--slate)" }}>Grade</div>
                <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })}>
                  <option value="">Select</option>
                  {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <div style={{ color: "var(--slate)" }}>Est. quantity (m³)</div>
                <input type="number" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ color: "var(--slate)" }}>Preferred date</div>
                <input type="date" value={form.preferred_date} onChange={(e) => setForm({ ...form, preferred_date: e.target.value })} />
              </div>
              <div>
                <div style={{ color: "var(--slate)" }}>Preferred time</div>
                <input type="time" value={form.preferred_time} onChange={(e) => setForm({ ...form, preferred_time: e.target.value })} />
              </div>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Notes for manager</div>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Site plan pending, payment terms 15 days" />
            </div>
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <button type="submit" disabled={saving}>{saving ? "Submitting..." : "Submit booking"}</button>
            <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center" }}>
              Manager confirms site readiness and payment terms before converting this to an order.
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

const VISITOR_TYPE_LABEL = { customer: "Customer", client: "Client", consultant: "Consultant", site_engineer: "Site engineer", other: "Other" };

function VisitsList({ visits, onNew, onDuty }) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Visits</div>
        <button onClick={onNew} disabled={!onDuty} title={!onDuty ? "Clock in first" : ""} style={{ fontSize: 12, padding: "5px 10px" }}>+ Report visit</button>
      </div>
      {visits.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No visits reported yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visits.map((v) => (
            <div key={v.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{v.visited_name}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {v.is_new_project != null && (
                    <span className={v.is_new_project ? "badge badge-info" : "badge badge-success"}>{v.is_new_project ? "New project" : "Existing project"}</span>
                  )}
                  <span className="badge badge-neutral">{VISITOR_TYPE_LABEL[v.visitor_type] || v.visitor_type}</span>
                </div>
              </div>
              <div style={{ color: "var(--slate)" }}>
                {new Date(v.visit_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}
                {v.visit_time ? ` · ${v.visit_time.slice(0, 5)}` : ""}
                {v.contact_person ? ` · ${v.contact_person}` : ""}
                {v.contact_number ? ` · ${v.contact_number}` : ""}
              </div>
              {v.discussion_outcome && <div>{v.discussion_outcome}</div>}
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{v.at_site === false ? "Not at site" : v.at_site ? "At site" : ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const NEW_PROJECT_QUESTIONS = [
  { key: "meeting_outcome", label: "1. How was the meeting?", options: ["Interested", "Comparing prices", "Not ready yet", "Lost to competitor", "Decision maker absent"] },
  { key: "spoke_to", label: "2. Who did you speak to?", options: ["Client", "Engineer", "Contractor", "Purchase dept.", "Other — need to reach decision maker"] },
  { key: "decide_when", label: "3. When will they decide?", options: ["Today/tomorrow", "This week", "Next week", "This month", "More than a month", "Not sure"] },
  { key: "concerns", label: "4. Main concerns", options: ["Price", "Distance from plant", "Delivery timing", "Product quality", "Grade availability", "Pump availability", "Payment terms", "Trust, new supplier", "None"], multi: true },
  { key: "grades", label: "5. Grade(s) asked about", options: ["M10", "M15", "M20", "M25", "M30", "M35", "M40", "M45", "Not sure yet"], multi: true },
  { key: "volume", label: "6. Rough volume expected", options: ["Under 50 m³", "50–200 m³", "200–500 m³", "Above 500 m³", "Unsure"] },
  { key: "project_stage", label: "7. Project stage", options: ["Just planning", "Starting soon", "Excavation", "Foundation ready", "Column/Plinth", "Slab", "Finishing"] },
  { key: "first_pour", label: "8. Expected first pour", options: ["Within 3 days", "1 week", "2 weeks", "1 month", "Later"] },
  { key: "competitor_involved", label: "9. Competitor involved?", options: ["No", "Yes — SEDC", "Yes — Supermix", "Yes — Other"] },
  { key: "competitor_experience", label: "10. Their experience with that competitor", options: ["Happy", "Unhappy", "Minor issues", "None known"], conditional: (a) => a.competitor_involved && a.competitor_involved !== "No" },
  { key: "quotation_status", label: "11. Quotation status", options: ["Submitted", "Send today", "Revised quote needed", "Not required"] },
  { key: "technical_visit", label: "12. Technical visit needed?", options: ["Yes", "No"] },
  { key: "owners_meeting", label: "13. Owners' meeting needed?", options: ["Yes", "No"] },
];
const RUNNING_PROJECT_QUESTIONS = [
  { key: "supply_status", label: "a. How's the supply going?", options: ["All good", "Minor issue", "Serious complaint"] },
  { key: "volume_trend", label: "b. Volume trend?", options: ["Increasing", "Steady", "Decreasing", "Nearing completion"] },
  { key: "payment_status", label: "c. Payments up to date?", options: ["Yes", "Needs follow-up", "Overdue, urgent"] },
  { key: "issues", label: "d. Issues raised", options: ["None", "Late deliveries", "Quality complaint", "Pump crew behaviour", "Driver behaviour", "Other"], multi: true },
  { key: "project_timeline", label: "e. Project timeline?", options: ["Just started", "Mid-project", "Nearing completion", "Finished"] },
  { key: "competitor_activity", label: "f. Competitor activity?", options: ["None mentioned", "Competitor approached them"] },
  { key: "relationship_health", label: "g. Relationship health?", options: ["Strong", "Needs attention", "At risk"] },
];

function QuestionBlock({ q, value, onChange, highlight }) {
  const selected = q.multi ? (Array.isArray(value) ? value : []) : value;
  function tap(opt) {
    if (q.multi) {
      const set = new Set(selected);
      if (set.has(opt)) set.delete(opt); else set.add(opt);
      onChange([...set]);
    } else {
      onChange(opt);
    }
  }
  return (
    <div style={{ marginBottom: 12, ...(highlight ? { background: "var(--amber-bg)", borderRadius: 8, padding: 8 } : {}) }} id={`q-${q.key}`}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        {q.label} {q.multi && <span style={{ fontWeight: 400, color: "var(--slate)" }}>(pick any)</span>}
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {q.options.map((opt) => {
          const isSelected = q.multi ? selected.includes(opt) : selected === opt;
          return (
            <button
              key={opt} type="button" onClick={() => tap(opt)}
              style={{ fontSize: 11, padding: "5px 9px", ...(isSelected ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NewVisitForm({ onDone, onCancel }) {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [visitedName, setVisitedName] = useState("");
  const [visitorType, setVisitorType] = useState("customer");
  const [visitDate, setVisitDate] = useState(new Date().toISOString().slice(0, 10));
  const [visitTime, setVisitTime] = useState(new Date().toTimeString().slice(0, 5));
  const [contactPerson, setContactPerson] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [atSite, setAtSite] = useState(null);
  const [coords, setCoords] = useState(null);
  const [isNewProject, setIsNewProject] = useState(null);
  const [answers, setAnswers] = useState({});
  const [comments, setComments] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [missingKeys, setMissingKeys] = useState([]);

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites")])
      .then(([c, s]) => { setCustomers(c); setSites(s); })
      .catch((err) => setError(err.message));
  }, []);

  const sitesForCustomer = customerId ? sites.filter((s) => String(s.customer_id) === String(customerId)) : [];
  const questions = isNewProject === null ? [] : isNewProject ? NEW_PROJECT_QUESTIONS : RUNNING_PROJECT_QUESTIONS;
  const visibleQuestions = questions.filter((q) => !q.conditional || q.conditional(answers));

  function setAnswer(key, value) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    setError(""); setMissingKeys([]);
    if (atSite === null) return setError("Let us know whether you're at site.");
    if (isNewProject === null) return setError("Confirm whether this is a new or an existing project.");

    const missing = visibleQuestions.filter((q) => {
      const v = answers[q.key];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    });
    if (missing.length > 0) {
      setMissingKeys(missing.map((q) => q.key));
      setError(`${missing.length} question${missing.length > 1 ? "s" : ""} not answered — nothing was saved.`);
      return;
    }

    setSaving(true);
    try {
      await apiRequest("/sales/visits", {
        method: "POST",
        body: {
          customer_id: customerId || null, visited_name: visitedName, site_id: siteId || null,
          visitor_type: visitorType, visit_date: visitDate, visit_time: visitTime || null,
          contact_person: contactPerson, contact_number: contactNumber,
          at_site: atSite, latitude: coords?.latitude, longitude: coords?.longitude,
          is_new_project: isNewProject, answers, comments: comments || null,
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
    <>
      <TopBar title="Sales Executive · Report visit" />
      <div style={{ maxWidth: 420, margin: "0 auto", padding: "0 16px 32px" }}>
        <button onClick={onCancel} style={{ marginBottom: 16 }}>← Back</button>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Report a visit</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Customer name</div>
              <input value={visitedName} onChange={(e) => setVisitedName(e.target.value)} placeholder="Search or type a new name" required />
              <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setSiteId(""); const c = customers.find((x) => String(x.id) === e.target.value); if (c) setVisitedName(c.name); }} style={{ marginTop: 6 }}>
                <option value="">Or link to an existing customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {customerId && (
              <div>
                <div style={{ color: "var(--slate)" }}>Site / project</div>
                <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  <option value="">Not decided / not applicable</option>
                  {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <div style={{ color: "var(--slate)" }}>Whom did you meet</div>
              <input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} required />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Who is he?</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {[["customer", "Customer"], ["client", "Client"], ["consultant", "Consultant"], ["site_engineer", "Site engineer"], ["other", "Other"]].map(([val, label]) => (
                  <button key={val} type="button" onClick={() => setVisitorType(val)} style={{ fontSize: 11, padding: "5px 9px", ...(visitorType === val ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>{label}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Contact number <span style={{ color: "var(--alert-red)" }}>(required)</span></div>
              <input type="tel" value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} required />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div><div style={{ color: "var(--slate)" }}>Date</div><input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} required /></div>
              <div><div style={{ color: "var(--slate)" }}>Time</div><input type="time" value={visitTime} onChange={(e) => setVisitTime(e.target.value)} /></div>
            </div>
            <AtSitePrompt atSite={atSite} setAtSite={setAtSite} coords={coords} setCoords={setCoords} />

            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Is this a new project or an existing one?</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => { setIsNewProject(true); setAnswers({}); }} style={{ flex: 1, padding: 10, ...(isNewProject === true ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>New project</button>
                <button type="button" onClick={() => { setIsNewProject(false); setAnswers({}); }} style={{ flex: 1, padding: 10, ...(isNewProject === false ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>Existing project</button>
              </div>
            </div>

            {visibleQuestions.map((q) => (
              <QuestionBlock key={q.key} q={q} value={answers[q.key]} onChange={(v) => setAnswer(q.key, v)} highlight={missingKeys.includes(q.key)} />
            ))}

            {isNewProject !== null && (
              <div>
                <div style={{ color: "var(--slate)", marginBottom: 4 }}>Anything else worth noting?</div>
                <textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} />
              </div>
            )}

            {error && (
              <div style={{ background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", borderRadius: 8, padding: "8px 10px", fontSize: 12, color: "var(--alert-red)" }}>
                {error}
                {missingKeys.length > 0 && (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {missingKeys.map((k) => {
                      const q = questions.find((qq) => qq.key === k);
                      return <li key={k}><a href={`#q-${k}`} style={{ color: "var(--alert-red)" }}>{q?.label}</a></li>;
                    })}
                  </ul>
                )}
              </div>
            )}
            <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save visit & generate follow-up"}</button>
          </form>
        </div>
      </div>
    </>
  );
}

function FeedbackList({ feedback, onNew, onDuty }) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>After-sales feedback</div>
        <button onClick={onNew} disabled={!onDuty} title={!onDuty ? "Clock in first" : ""} style={{ fontSize: 12, padding: "5px 10px" }}>+ New feedback</button>
      </div>
      {feedback.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>None recorded yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {feedback.map((f) => (
            <div key={f.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600 }}>{f.customer_name}</span>
                <span className={`badge ${f.feedback_type === "complaint" ? "badge-danger" : "badge-success"}`}>{f.feedback_type}</span>
              </div>
              <div style={{ color: "var(--slate)" }}>{f.comment}</div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{new Date(f.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewFeedbackForm({ onDone, onCancel }) {
  const [customers, setCustomers] = useState([]);
  const [form, setForm] = useState({ customer_id: "", feedback_type: "compliment", comment: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/master/customers").then(setCustomers).catch((err) => setError(err.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/sales/feedback", { method: "POST", body: form });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Sales Executive · New feedback" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <button onClick={onCancel} style={{ marginBottom: 16 }}>← Back</button>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Record after-sales feedback</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Customer</div>
              <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} required>
                <option value="">Select</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Type</div>
              <select value={form.feedback_type} onChange={(e) => setForm({ ...form, feedback_type: e.target.value })}>
                <option value="compliment">Compliment</option>
                <option value="complaint">Complaint</option>
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Comment</div>
              <textarea rows={4} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} required placeholder="What did the site say about the delivery, quality, service?" />
            </div>
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save feedback"}</button>
          </form>
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, danger }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${danger ? "danger" : ""}`}>{value}</div>
    </div>
  );
}

function inr(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
