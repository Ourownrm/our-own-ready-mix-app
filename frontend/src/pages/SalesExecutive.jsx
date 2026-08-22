import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount, startPeriodicFlush, flushQueue } from "../lib/offlineQueue.js";
import FollowupsDue from "../lib/FollowupsDue.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import ShareableVisitReport from "../lib/ShareableVisitReport.jsx";
import VisitCadenceStrip from "../lib/VisitCadenceStrip.jsx";

const LEAD_STATUS_BADGE = {
  new: "badge-neutral", contacted: "badge-info", quoted: "badge-progress",
  won: "badge-success", lost: "badge-danger",
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
  const { user } = useAuth();
  const isAdmin = user?.role === "administrator";
  const [executives, setExecutives] = useState([]);
  const [viewAsUser, setViewAsUser] = useState("");
  const [view, setView] = useState("leads");
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [leads, setLeads] = useState([]);
  const [visits, setVisits] = useState([]);
  const [forecasts, setForecasts] = useState([]);
  const [visitCadence, setVisitCadence] = useState([]);
  const [error, setError] = useState("");
  const [onDuty, setOnDuty] = useState(false);
  const [dutyStatus, setDutyStatus] = useState(null);
  const [pending, setPending] = useState(pendingCount());
  const gpsIntervalRef = useRef(null);
  const wakeLockRef = useRef("off");

  useEffect(() => {
    if (isAdmin) {
      apiRequest("/sales/executives").then(setExecutives).catch(() => {});
    }
  }, [isAdmin]);

  const asUserParam = isAdmin && viewAsUser ? `?as_user=${viewAsUser}` : "";

  async function loadAll() {
    try {
      const [d, l, v, fc, vc] = await Promise.all([
        apiRequest(`/sales/my-dashboard${asUserParam}`),
        apiRequest("/sales/leads"),
        apiRequest("/sales/visits"),
        apiRequest("/sales/forecasts"),
        apiRequest(`/sales/visits/summary?days=7${asUserParam ? `&${asUserParam.slice(1)}` : ""}`),
      ]);
      setDashboard(d); setLeads(l); setVisits(v); setForecasts(fc); setVisitCadence(vc);
    } catch (err) {
      setError(err.message);
    }
  }
  async function loadDutyStatus() {
    try {
      const status = await apiRequest(`/sales/duty-status${asUserParam}`);
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

  useEffect(() => {
    if (isAdmin) loadAll();
  }, [viewAsUser]);

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
  if (view === "new-visit") {
    return <NewVisitForm onDone={() => { setView("visits"); loadAll(); }} onCancel={() => setView("visits")} />;
  }

  return (
    <>
      <TopBar title="Sales Executive" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {isAdmin && (
          <div className="card" style={{ marginBottom: 12, fontSize: 13 }}>
            <div style={{ color: "var(--slate)", marginBottom: 4 }}>Viewing as</div>
            <select value={viewAsUser} onChange={(e) => setViewAsUser(e.target.value)} style={{ width: "100%" }}>
              <option value="">Select a Sales Executive</option>
              {executives.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
            </select>
          </div>
        )}

        {!isAdmin && (
        <button
          onClick={toggleDuty}
          className={onDuty ? "btn-danger" : "btn-primary"}
          style={{ width: "100%", marginBottom: 8, padding: 12, fontSize: 14, fontWeight: 600 }}
        >
          {onDuty ? "On duty — tap to clock off" : "Off duty — tap to clock in"}
        </button>
        )}
        {!isAdmin && dutyStatus?.since && (
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

        <TopKpis data={dashboard} forecasts={forecasts} visitCadence={visitCadence} />

        <FollowupsDue asUser={isAdmin ? viewAsUser : undefined} />

        {!onDuty && (
          <div className="card" style={{ margin: "16px 0", borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>You're off duty</div>
            <div style={{ fontSize: 12, color: "var(--slate)" }}>Clock in above to add leads, visits, or forecasts.</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, margin: "20px 0", flexWrap: "wrap", alignItems: "center" }}>
          {[["leads", "My leads"], ["visits", "Visits"], ["forecast", "Forecast"]].map(([key, label]) => (
            <button
              key={key}
              className={`btn-tab ${view === key ? "active" : ""}`}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
          {!isAdmin && (
            <Link to="/customer-booking" style={{ marginLeft: "auto", fontSize: 12.5 }}>
              Bookings &amp; feedback →
            </Link>
          )}
        </div>

        {view === "leads" && (
          <LeadsList leads={leads} onDuty={onDuty} onOpen={(id) => { setSelectedLeadId(id); setView("lead-detail"); }} onNew={() => setView("new-lead")} />
        )}
        {view === "visits" && (
          <>
            <VisitCadenceCard days={visitCadence} />
            <VisitsList visits={visits} onDuty={onDuty} onNew={() => setView("new-visit")} />
          </>
        )}
        {view === "forecast" && (
          <ForecastTab forecasts={forecasts} onDuty={onDuty} onReload={loadAll} />
        )}
      </div>
    </>
  );
}

// Landing KPI row — promoted above the tabs (round 115). Achieved sales and
// outstanding already existed on the old Dashboard tab; kept here rather
// than dropped when that tab went away. "Sites overdue a visit" is new —
// the actual forcing-function metric for "visit more sites," visible to the
// rep on their own screen rather than only in a report someone else checks.
function TopKpis({ data, forecasts, visitCadence }) {
  const [showOutstanding, setShowOutstanding] = useState(false);
  if (!data) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;
  const leadCounts = data.lead_counts || {};
  const openLeads = (leadCounts.new || 0) + (leadCounts.contacted || 0) + (leadCounts.quoted || 0);
  const expiredCount = (forecasts || []).filter((f) => f.is_expired).length;
  const visitsThisWeek = (visitCadence || []).reduce((sum, d) => sum + (d.visits || 0), 0);
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginTop: 16 }}>
        <Kpi label="Open leads" value={openLeads} />
        <Kpi label="Visits this week" value={visitsThisWeek} />
        <Kpi label="Sites overdue a visit" value={data.sites_overdue_visit ?? 0} danger={Number(data.sites_overdue_visit) > 0} />
        <Kpi label="Forecast status" value={expiredCount > 0 ? `${expiredCount} need refresh` : "Up to date"} danger={expiredCount > 0} />
        <Kpi label="Achieved this month" value={`${data.orders_month_qty} m³`} />
        <Kpi label="Outstanding" value={inr(data.outstanding)} danger={Number(data.outstanding) > 0} />
      </div>
      {data.outstanding_by_customer?.length > 0 && (
        <>
          <div className="collapse-toggle" style={{ fontSize: 12, color: "var(--rebar)", cursor: "pointer", marginTop: 8 }} onClick={() => setShowOutstanding((s) => !s)}>
            {showOutstanding ? "▴ Hide" : "▾ View"} outstanding by customer
          </div>
          {showOutstanding && (
            <div className="card" style={{ marginTop: 8 }}>
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
        </>
      )}
    </>
  );
}

// Date-wise visit summary, last 7 days — days the rep was on duty with zero
// visits logged are flagged, so under-visiting is visible right where they
// work, not just in a report Manager/Admin might check. The day-strip itself
// is shared with the Sales Performance page's cross-rep cadence report —
// see lib/VisitCadenceStrip.jsx.
function VisitCadenceCard({ days }) {
  if (!days || days.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Visit summary — last 7 days</div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>Days you were on duty with zero visits logged are flagged red.</div>
      <VisitCadenceStrip days={days} />
    </div>
  );
}

// Forecast, folded in as a tab (round 115) instead of a separate page link —
// same /sales/forecasts and /sales/my-running-projects endpoints as the
// standalone Sales Forecast page (still reachable at /sales-forecast for
// Manager/Administrator).
function ForecastTab({ forecasts, onDuty, onReload }) {
  const [showForm, setShowForm] = useState(false);
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({ site_id: "", expected_qty_m3: "", period_days: "30", confidence: "likely", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (showForm) apiRequest("/sales/my-running-projects").then(setProjects).catch((err) => setError(err.message));
  }, [showForm]);

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/sales/forecasts", { method: "POST", body: form });
      setShowForm(false);
      setForm({ site_id: "", expected_qty_m3: "", period_days: "30", confidence: "likely", notes: "" });
      onReload();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Sales forecast — running projects</div>
        <button onClick={() => setShowForm((s) => !s)} disabled={!onDuty} title={!onDuty ? "Clock in first" : ""} style={{ fontSize: 12, padding: "5px 10px" }}>
          {showForm ? "Cancel" : "+ Add / update project"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--slate)", margin: "-4px 0 10px" }}>
        Saving a forecast update notifies Manager/Operations right away, the same way an owners'-meeting or
        technical-visit request does.
      </div>
      {showForm && (
        <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, marginBottom: 14, background: "var(--concrete)", padding: 10, borderRadius: 8 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>Project / site</div>
            <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} required style={{ width: "100%" }}>
              <option value="">Select</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.customer_name} — {p.site_name}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div><div style={{ color: "var(--slate)" }}>Expected qty (m³)</div><input type="number" value={form.expected_qty_m3} onChange={(e) => setForm({ ...form, expected_qty_m3: e.target.value })} required style={{ width: "100%" }} /></div>
            <div><div style={{ color: "var(--slate)" }}>Period (days)</div><input type="number" value={form.period_days} onChange={(e) => setForm({ ...form, period_days: e.target.value })} required style={{ width: "100%" }} /></div>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Confidence</div>
            <select value={form.confidence} onChange={(e) => setForm({ ...form, confidence: e.target.value })} style={{ width: "100%" }}>
              <option value="confirmed">Confirmed</option>
              <option value="likely">Likely</option>
              <option value="tentative">Tentative</option>
            </select>
          </div>
          <div><div style={{ color: "var(--slate)" }}>Notes</div><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ width: "100%" }} /></div>
          {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save forecast"}</button>
        </form>
      )}
      {(!forecasts || forecasts.length === 0) ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing forecasted yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 13 }}>
            <thead><tr><th>Project / site</th><th>Expected qty (m³)</th><th>Period</th><th>Confidence</th><th></th></tr></thead>
            <tbody>
              {forecasts.map((f) => (
                <tr key={f.id}>
                  <td>{f.customer_name} — {f.site_name}</td>
                  <td>{f.expected_qty_m3}</td>
                  <td>{f.period_days}d</td>
                  <td>
                    <span className={`badge ${f.confidence === "confirmed" ? "badge-success" : f.confidence === "likely" ? "badge-warning" : "badge-neutral"}`}>{f.confidence}</span>
                    {f.is_expired && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Expired</span>}
                  </td>
                  <td><button className="btn-ghost" onClick={() => setShowForm(true)} style={{ fontSize: 12 }}>Update</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 600 }}>{l.prospect_name}</span>
                <span style={{ display: "flex", gap: 4 }}>
                  {l.latest_activity_type === "site_visit" && !["won", "lost"].includes(l.status) && (
                    <span className="badge badge-info">Site visit done</span>
                  )}
                  <span className={`badge ${LEAD_STATUS_BADGE[l.status]}`}>{l.status}</span>
                </span>
              </div>
              {l.contact_phone && <div style={{ color: "var(--slate)" }}>{l.contact_phone}</div>}
              {l.site_location && <div style={{ color: "var(--slate)" }}>{l.site_location}</div>}
              {l.quotation_issued && <div style={{ color: "var(--slate)" }}>Quoted ₹{l.latest_quotation_amount}</div>}
              <div style={{ color: "var(--slate)", fontSize: 11, marginTop: 2 }}>
                Sent by {l.created_by_name || "Unknown"} &middot; {new Date(l.created_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })} &middot; {new Date(l.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
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

  // Round 115 — "Site visit" as the update type now requires the same
  // questionnaire as the Visits tab, answered inline, before Save is enabled.
  const [isNewProject, setIsNewProject] = useState(null);
  const [answers, setAnswers] = useState({});
  const [visitorType, setVisitorType] = useState("customer");
  const [missingKeys, setMissingKeys] = useState([]);

  async function load() {
    try {
      setLead(await apiRequest(`/sales/leads/${leadId}`));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [leadId]);

  function setAnswer(key, value) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  const questions = isNewProject === null ? [] : isNewProject ? NEW_PROJECT_QUESTIONS : RUNNING_PROJECT_QUESTIONS;
  const visibleQuestions = questions.filter((q) => !q.conditional || q.conditional(answers));
  const questionnaireIncomplete = activityType === "site_visit" && (
    isNewProject === null || missingAnswerKeysClient(isNewProject, answers).length > 0
  );

  async function addUpdate() {
    if (!note) return setError("Enter a note.");
    if (atSite === null) return setError("Let us know whether you're at site.");
    if (activityType === "site_visit") {
      if (isNewProject === null) return setError("Confirm whether this is a new or an existing project.");
      const missing = missingAnswerKeysClient(isNewProject, answers);
      if (missing.length > 0) {
        setMissingKeys(missing);
        return setError(`${missing.length} question(s) still need an answer — the visit questionnaire is mandatory for a site visit update.`);
      }
    }
    setSaving(true); setError(""); setMissingKeys([]);
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
          is_new_project: activityType === "site_visit" ? isNewProject : undefined,
          answers: activityType === "site_visit" ? answers : undefined,
          visitor_type: activityType === "site_visit" ? visitorType : undefined,
        },
      });
      setNote(""); setQuotationAmount(""); setRevisionReason(""); setPersonsMet(""); setAtSite(null); setCoords(null);
      setActivityType("note"); setIsNewProject(null); setAnswers({});
      load();
    } catch (err) {
      setError(err.message);
      if (err.data?.missing_keys) setMissingKeys(err.data.missing_keys);
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

              {activityType === "site_visit" && (
                <div style={{ border: "1px dashed var(--rebar)", background: "#FDF3EA", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--rebar-dark)", marginBottom: 6 }}>
                    Visit questionnaire — required to save as "Site visit done"
                  </div>
                  <div style={{ color: "var(--slate)", marginBottom: 4 }}>Who is he?</div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                    {[["customer", "Customer"], ["client", "Client"], ["consultant", "Consultant"], ["site_engineer", "Site engineer"], ["other", "Other"]].map(([val, label]) => (
                      <button key={val} type="button" onClick={() => setVisitorType(val)} style={{ fontSize: 11, padding: "5px 9px", ...(visitorType === val ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>{label}</button>
                    ))}
                  </div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Is this a new project or an existing one?</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <button type="button" onClick={() => { setIsNewProject(true); setAnswers({}); }} style={{ flex: 1, padding: 10, ...(isNewProject === true ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>New project</button>
                    <button type="button" onClick={() => { setIsNewProject(false); setAnswers({}); }} style={{ flex: 1, padding: 10, ...(isNewProject === false ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>Existing project</button>
                  </div>
                  {visibleQuestions.map((q) => (
                    <QuestionBlock key={q.key} q={q} value={answers[q.key]} onChange={(v) => setAnswer(q.key, v)} highlight={missingKeys.includes(q.key)} />
                  ))}
                  {isNewProject !== null && visibleQuestions.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--slate)" }}>Loading questions...</div>
                  )}
                </div>
              )}

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={addUpdate} disabled={saving || questionnaireIncomplete} title={questionnaireIncomplete ? "Answer every question above to save a site visit update" : ""} style={{ flex: 1, ...(questionnaireIncomplete ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}>
                  {saving ? "Saving..." : questionnaireIncomplete ? "Save update — answer questionnaire first" : "Save update"}
                </button>
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

const VISITOR_TYPE_LABEL = { customer: "Customer", client: "Client", consultant: "Consultant", site_engineer: "Site engineer", other: "Other" };

function VisitsList({ visits, onNew, onDuty }) {
  const [shareOpenId, setShareOpenId] = useState(null);
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
              <button
                style={{ fontSize: 11, padding: "4px 10px", marginTop: 6 }}
                onClick={() => setShareOpenId(shareOpenId === v.id ? null : v.id)}
              >
                {shareOpenId === v.id ? "Hide report" : "Share report"}
              </button>
              {shareOpenId === v.id && (
                <div style={{ marginTop: 8 }}>
                  <ShareableVisitReport visit={v} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const NEW_PROJECT_QUESTIONS = [
  { key: "meeting_outcome", label: "1. How was the meeting?", options: ["Interested", "Comparing prices", "Not ready yet", "Lost to competitor", "Decision maker absent"] },
  { key: "decide_when", label: "2. When will they decide?", options: ["Today/tomorrow", "This week", "Next week", "This month", "More than a month", "Not sure"] },
  { key: "concerns", label: "3. Main concerns", options: ["Price", "Distance from plant", "Delivery timing", "Product quality", "Grade availability", "Pump availability", "Payment terms", "Trust, new supplier", "None"], multi: true },
  { key: "grades", label: "4. Grade(s) asked about", options: ["M10", "M15", "M20", "M25", "M30", "M35", "M40", "M45", "Not sure yet"], multi: true },
  { key: "volume", label: "5. Rough volume expected", options: ["Under 50 m³", "50–200 m³", "200–500 m³", "Above 500 m³", "Unsure"] },
  { key: "project_stage", label: "6. Project stage", options: ["Just planning", "Starting soon", "Excavation", "Foundation ready", "Column/Plinth", "Slab", "Finishing"] },
  { key: "first_pour", label: "7. Expected first pour", options: ["Within 3 days", "1 week", "2 weeks", "1 month", "Later"] },
  { key: "competitor_involved", label: "8. Competitor involved?", options: ["No", "Yes — SEDC", "Yes — Supermix", "Yes — Other"] },
  { key: "competitor_experience", label: "9. Their experience with that competitor", options: ["Happy", "Unhappy", "Minor issues", "None known"], conditional: (a) => a.competitor_involved && a.competitor_involved !== "No" },
  { key: "quotation_status", label: "10. Quotation status", options: ["Submitted", "Send today", "Revised quote needed", "Not required"] },
  { key: "technical_visit", label: "11. Technical visit needed?", options: ["Yes", "No"] },
  { key: "owners_meeting", label: "12. Owners' meeting needed?", options: ["Yes", "No"] },
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

// Client-side mirror of the backend's missingAnswerKeys() in sales.js —
// used to disable Save until the questionnaire is complete, both here (a
// lead's "Site visit" update) and in NewVisitForm below, without waiting on
// a round trip to find out something's missing.
function missingAnswerKeysClient(isNewProject, answers) {
  const questions = isNewProject ? NEW_PROJECT_QUESTIONS : RUNNING_PROJECT_QUESTIONS;
  const visible = questions.filter((q) => !q.conditional || q.conditional(answers));
  return visible
    .filter((q) => {
      const v = answers?.[q.key];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    })
    .map((q) => q.key);
}

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
  const [browseAll, setBrowseAll] = useState(false);
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

  // Round 115 — post-delivery feedback folded into the visit form (was its
  // own separate tab, disconnected from which visit surfaced it), plus an
  // optional manual follow-up for anything the rule-based ones don't cover.
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackType, setFeedbackType] = useState("compliment");
  const [feedbackComment, setFeedbackComment] = useState("");
  const [showManualFollowup, setShowManualFollowup] = useState(false);
  const [manualFollowupTitle, setManualFollowupTitle] = useState("");
  const [manualFollowupDue, setManualFollowupDue] = useState("");

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites")])
      .then(([c, s]) => { setCustomers(c); setSites(s); })
      .catch((err) => setError(err.message));
  }, []);

  const sitesForCustomer = customerId ? sites.filter((s) => String(s.customer_id) === String(customerId)) : [];
  const questions = isNewProject === null ? [] : isNewProject ? NEW_PROJECT_QUESTIONS : RUNNING_PROJECT_QUESTIONS;
  const visibleQuestions = questions.filter((q) => !q.conditional || q.conditional(answers));

  async function addNewCustomer() {
    const name = window.prompt("New customer name:");
    if (!name || !name.trim()) return;
    setError("");
    try {
      const created = await apiRequest("/sales/quick-customer", { method: "POST", body: { name } });
      setCustomers((prev) => [...prev, created]);
      setCustomerId(created.id);
      setVisitedName(created.name);
      setSiteId("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function addNewSite() {
    if (!customerId) { setError("Link to a customer first."); return; }
    const name = window.prompt("New site/project name:");
    if (!name || !name.trim()) return;
    setError("");
    try {
      const created = await apiRequest("/sales/quick-site", { method: "POST", body: { customer_id: customerId, name } });
      setSites((prev) => [...prev, created]);
      setSiteId(created.id);
    } catch (err) {
      if (err.status === 409 && window.confirm(`${err.message}\n\nCreate it anyway?`)) {
        try {
          const created = await apiRequest("/sales/quick-site", { method: "POST", body: { customer_id: customerId, name, force: true } });
          setSites((prev) => [...prev, created]);
          setSiteId(created.id);
        } catch (err2) { setError(err2.message); }
      } else if (err.status !== 409) {
        setError(err.message);
      }
    }
  }

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

    if (showFeedback && !feedbackComment) return setError("Enter a comment for the feedback you're logging, or collapse that section.");
    if (showManualFollowup && (!manualFollowupTitle || !manualFollowupDue)) {
      return setError("Fill in both fields for your own follow-up, or collapse that section.");
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
          post_delivery_feedback: showFeedback ? { feedback_type: feedbackType, comment: feedbackComment } : undefined,
          manual_followup: showManualFollowup ? { title: manualFollowupTitle, due_date: manualFollowupDue } : undefined,
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
              <input
                value={visitedName}
                onChange={(e) => {
                  const v = e.target.value;
                  setVisitedName(v);
                  // If they'd linked a customer and then keep editing away from
                  // that exact name, the link no longer reflects what's typed —
                  // unlink rather than silently keep a stale customer_id.
                  const linked = customers.find((c) => String(c.id) === String(customerId));
                  if (customerId && linked && linked.name !== v) { setCustomerId(""); setSiteId(""); }
                }}
                placeholder="Who did you visit? (type to search existing customers)"
                required
                autoComplete="off"
              />
              {/* Live suggestions instead of one giant dropdown — this is the
                  actual fix for the "guessed the wrong billing name" problem:
                  surfacing a likely existing-customer match while they type,
                  instead of only offering to browse everyone alphabetically. */}
              {!customerId && visitedName.trim().length >= 2 && (
                <div style={{ marginTop: 4 }}>
                  {customers
                    .filter((c) => c.name.toLowerCase().includes(visitedName.trim().toLowerCase()))
                    .slice(0, 5)
                    .map((c) => (
                      <div
                        key={c.id}
                        onClick={() => { setCustomerId(c.id); setVisitedName(c.name); setSiteId(""); }}
                        style={{ padding: "6px 8px", fontSize: 12, border: "1px solid var(--border)", borderTop: "none", cursor: "pointer", background: "var(--surface)" }}
                      >
                        🔗 Link to existing customer: <strong>{c.name}</strong>
                      </div>
                    ))}
                </div>
              )}
              {customerId && (
                <div style={{ fontSize: 11, color: "var(--signal-green)", marginTop: 4 }}>
                  ✓ Linked to existing customer — this visit will count toward their record.
                </div>
              )}
              {!customerId && visitedName.trim().length >= 2 && customers.filter((c) => c.name.toLowerCase().includes(visitedName.trim().toLowerCase())).length === 0 && (
                <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
                  No matching existing customer — this will be saved as a new, unlinked name. An Admin can link it to the
                  real billing customer later once that's known (Sales Performance → Unlinked visit names).
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button type="button" onClick={addNewCustomer} style={{ fontSize: 12, padding: "4px 10px" }}>+ New customer</button>
                <button type="button" onClick={() => setBrowseAll((b) => !b)} style={{ fontSize: 12, padding: "4px 10px" }}>
                  {browseAll ? "Hide full list" : "Browse full customer list"}
                </button>
              </div>
              {browseAll && (
                <select
                  value={customerId}
                  onChange={(e) => { setCustomerId(e.target.value); setSiteId(""); const c = customers.find((x) => String(x.id) === e.target.value); if (c) setVisitedName(c.name); }}
                  style={{ marginTop: 6, width: "100%" }}
                >
                  <option value="">Or pick from the full list</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </div>
            {customerId && (
              <div>
                <div style={{ color: "var(--slate)" }}>Site / project</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <select value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Not decided / not applicable</option>
                    {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button type="button" onClick={addNewSite} style={{ fontSize: 12, padding: "4px 10px" }}>+ New</button>
                </div>
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

            <div
              onClick={() => setShowFeedback((s) => !s)}
              style={{ fontSize: 12, color: "var(--rebar)", cursor: "pointer" }}
            >
              {showFeedback ? "▴ Hide" : "＋ Was this a post-delivery visit? Log feedback while you're here ▾"}
            </div>
            {showFeedback && (
              <div style={{ border: "1px dashed var(--signal-green)", background: "var(--signal-green-bg)", borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#14523A", marginBottom: 6 }}>
                  Delivery feedback <span style={{ fontWeight: 400 }}>(optional — only if this visit follows a delivery)</span>
                </div>
                {!customerId && (
                  <div style={{ fontSize: 11, color: "var(--alert-red)", marginBottom: 6 }}>
                    Link this visit to an existing customer above first — feedback needs a real customer record to attach to.
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                  <div>
                    <div style={{ color: "var(--slate)", fontSize: 12 }}>Type</div>
                    <select value={feedbackType} onChange={(e) => setFeedbackType(e.target.value)} style={{ width: "100%" }}>
                      <option value="compliment">Compliment</option>
                      <option value="complaint">Complaint</option>
                    </select>
                  </div>
                </div>
                <div style={{ color: "var(--slate)", fontSize: 12 }}>Comment</div>
                <textarea rows={2} value={feedbackComment} onChange={(e) => setFeedbackComment(e.target.value)} style={{ width: "100%" }} placeholder="Finish quality praised, on-time delivery" />
              </div>
            )}

            <div style={{ border: "1px dashed var(--info)", background: "var(--info-bg)", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#144A66", marginBottom: 6 }}>Follow-up</div>
              <div style={{ fontSize: 12, color: "#144A66", marginBottom: 8, lineHeight: 1.5 }}>
                A follow-up is always created when you save this visit — if none of the usual rules apply, a default
                check-in reminder is added instead of no next action at all.
              </div>
              <div
                onClick={() => setShowManualFollowup((s) => !s)}
                style={{ fontSize: 12, color: "var(--rebar)", cursor: "pointer" }}
              >
                {showManualFollowup ? "▴ Hide" : "＋ Add your own follow-up too (optional) ▾"}
              </div>
              {showManualFollowup && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                  <div>
                    <div style={{ color: "var(--slate)", fontSize: 12 }}>What to follow up on</div>
                    <input value={manualFollowupTitle} onChange={(e) => setManualFollowupTitle(e.target.value)} placeholder="e.g. Confirm site plan received from architect" style={{ width: "100%" }} />
                  </div>
                  <div>
                    <div style={{ color: "var(--slate)", fontSize: 12 }}>Due date</div>
                    <input type="date" value={manualFollowupDue} onChange={(e) => setManualFollowupDue(e.target.value)} style={{ width: "100%" }} />
                  </div>
                </div>
              )}
            </div>

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
