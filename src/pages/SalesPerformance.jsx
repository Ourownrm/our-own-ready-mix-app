import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { CreateLeadForm } from "../lib/SalesPanels.jsx";
import VisitCadenceStrip from "../lib/VisitCadenceStrip.jsx";

const VISITOR_TYPE_LABEL = { customer: "Customer", client: "Client", consultant: "Consultant", site_engineer: "Site engineer", other: "Other" };

export default function SalesPerformance() {
  const [rows, setRows] = useState(null);
  const [visits, setVisits] = useState([]);
  const [error, setError] = useState("");
  const [showAssignLead, setShowAssignLead] = useState(false);

  useEffect(() => {
    apiRequest("/sales/performance").then(setRows).catch((err) => setError(err.message));
    apiRequest("/sales/visits").then(setVisits).catch((err) => setError(err.message));
  }, []);

  function reload() {
    apiRequest("/sales/visits").then(setVisits).catch((err) => setError(err.message));
  }

  return (
    <>
      <TopBar title="Sales Performance" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link to="/leads"><button type="button">Browse all leads</button></Link>
          <button type="button" onClick={() => setShowAssignLead(!showAssignLead)}>
            {showAssignLead ? "Hide" : "Assign a lead"}
          </button>
        </div>
        {showAssignLead && (
          <div style={{ marginBottom: 20 }}>
            <CreateLeadForm setError={setError} onDone={() => setShowAssignLead(false)} />
          </div>
        )}
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Salespersons — this month</div>
          {!rows ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
          ) : rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No salespersons on file yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>Salesperson</th><th>Qty this month</th><th>Sales value</th>
                    <th>Outstanding</th><th>Total leads</th><th>Won</th><th>Lost</th>
                    <th>Quotations</th><th>Meetings</th><th>Site visits</th><th>Customer visits</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.salesperson_id}>
                      <td>{r.name}</td>
                      <td>{r.orders_month_qty} m³</td>
                      <td>{inr(r.orders_month_value)}</td>
                      <td style={Number(r.outstanding) > 0 ? { color: "var(--alert-red)" } : undefined}>{inr(r.outstanding)}</td>
                      <td>{r.total_leads}</td>
                      <td>{r.won_leads}</td>
                      <td>{r.lost_leads}</td>
                      <td>{r.quotations_this_month}</td>
                      <td>{r.meetings_this_month}</td>
                      <td>{r.site_visits_this_month}</td>
                      <td>{r.customer_visits_this_month}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <UnlinkedVisitNames onLinked={reload} />

        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Customer visits report</div>
          {visits.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No visits reported yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 13 }}>
                <thead>
                  <tr><th>Date</th><th>Salesperson</th><th>Visited</th><th>Type</th><th>Contact</th><th>Outcome</th><th>Location</th></tr>
                </thead>
                <tbody>
                  {visits.map((v) => (
                    <tr key={v.id}>
                      <td>{new Date(v.visit_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}{v.visit_time ? ` ${v.visit_time.slice(0, 5)}` : ""}</td>
                      <td>{v.visited_by_name}</td>
                      <td>{v.visited_name}{v.customer_name ? ` (${v.customer_name})` : ""}</td>
                      <td>{VISITOR_TYPE_LABEL[v.visitor_type] || v.visitor_type}</td>
                      <td>{v.contact_person || "–"}</td>
                      <td>{v.discussion_outcome}</td>
                      <td>
                        {v.at_site && v.latitude ? (
                          <a href={`https://maps.google.com/?q=${v.latitude},${v.longitude}`} target="_blank" rel="noreferrer">View</a>
                        ) : v.at_site === false ? "Not updated from site" : "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <VisitCadenceReport />
        <FollowupThreadsReport />
      </div>
    </>
  );
}

// Round 115 — visit-cadence accountability, appended below the two tables
// that already lived on this page rather than as a new report. One day-strip
// per active Sales Executive, same component the rep sees on their own
// Visits tab (lib/VisitCadenceStrip.jsx) — Manager/Admin sees everyone's at
// once instead of checking each rep's own dashboard.
function VisitCadenceReport() {
  const [reps, setReps] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/sales/visits/cadence?days=7").then(setReps).catch((err) => setError(err.message));
  }, []);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Visit cadence — by sales rep</div>
        <div style={{ fontSize: 11.5, color: "var(--slate)" }}>Last 7 days · all reps</div>
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {!reps ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
      ) : reps.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No active Sales Executives on file yet.</div>
      ) : (
        reps.map((r) => (
          <div key={r.user_id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>{r.name}</div>
            <VisitCadenceStrip days={r.days} />
          </div>
        ))
      )}
    </div>
  );
}

// Round 115 — follow-up threads (grouped by the visit that generated them)
// with the latest logged action, across every Sales Executive — the
// accountability/reporting half of clubbing multiple follow-ups from one
// visit into a thread with an action history.
function FollowupThreadsReport() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/sales/followups/report").then(setRows).catch((err) => setError(err.message));
  }, []);

  const threads = groupFollowupsByVisit(rows || []);

  return (
    <div className="card">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Follow-up threads &amp; actions taken</div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {!rows ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
      ) : threads.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No follow-up threads in the last 30 days.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 13 }}>
            <thead>
              <tr><th>Customer / site</th><th>Origin visit</th><th>Rep</th><th>Open threads</th><th>Latest action</th><th>Status</th></tr>
            </thead>
            <tbody>
              {threads.map((t) => {
                const st = threadStatus(t);
                return (
                  <tr key={t.visit_id}>
                    <td>{t.visited_name}</td>
                    <td>{new Date(t.visit_date).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                    <td>{t.rep_name || "–"}</td>
                    <td>{t.openCount}</td>
                    <td>{t.latestAction ? `${new Date(t.latestAction.at).toLocaleDateString([], { day: "2-digit", month: "short" })} — ${t.latestAction.note}` : "— none logged yet"}</td>
                    <td><span className={`badge ${st.className}`}>{st.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function groupFollowupsByVisit(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.visit_id)) {
      groups.set(r.visit_id, { visit_id: r.visit_id, visited_name: r.visited_name, visit_date: r.visit_date, rep_name: r.rep_name, items: [] });
    }
    groups.get(r.visit_id).items.push(r);
  }
  return [...groups.values()].map((g) => {
    const openCount = g.items.filter((i) => i.status === "pending").length;
    const latest = g.items
      .filter((i) => i.latest_action_at)
      .sort((a, b) => new Date(b.latest_action_at) - new Date(a.latest_action_at))[0];
    return { ...g, openCount, latestAction: latest ? { at: latest.latest_action_at, note: latest.latest_action_note } : null };
  }).sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date));
}

function threadStatus(t) {
  if (t.openCount === 0) return { label: "Closed", className: "badge-success" };
  const soonest = Math.min(...t.items.filter((i) => i.status === "pending").map((i) => dayDiff(i.due_date)));
  if (soonest < 0) return { label: "Overdue", className: "badge-danger" };
  if (soonest === 0) return { label: "Due today", className: "badge-warning" };
  return { label: "Upcoming", className: "badge-info" };
}

function dayDiff(dueDate) {
  const due = new Date(dueDate);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

// Visit names never linked to a real customer record — the sales exec only
// knew who/what they visited, not the eventual billing identity. Lets Admin/
// Manager reconcile once the real customer is known (e.g. once a booking or
// order actually gets created against it), rather than that guess sitting
// unresolved forever.
function UnlinkedVisitNames({ onLinked }) {
  const [rows, setRows] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [picked, setPicked] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(true);

  function load() {
    Promise.all([apiRequest("/sales/visits/unlinked-names"), apiRequest("/master/customers")])
      .then(([u, c]) => { setRows(u); setCustomers(c); })
      .catch((err) => setError(err.message));
  }
  useEffect(() => { load(); }, []);

  async function link(nameKey, visitedName) {
    const customerId = picked[nameKey];
    if (!customerId) { setError("Pick a customer to link first."); return; }
    setBusyKey(nameKey); setError("");
    try {
      await apiRequest("/sales/visits/link-customer", { method: "POST", body: { visited_name: visitedName, customer_id: customerId } });
      load();
      onLinked?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 20, borderLeft: "3px solid var(--amber)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setCollapsed((c) => !c)}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          Unlinked visit names <span className="badge badge-warning">{rows.length}</span>
        </div>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>{collapsed ? "Show ▾" : "Hide ▴"}</span>
      </div>
      {!collapsed && (
        <>
          <div style={{ fontSize: 12, color: "var(--slate)", margin: "6px 0 10px" }}>
            These visits were logged against a name that was never matched to a real customer record —
            usually because the exact billing name wasn't known yet at the time of the visit. Link each
            one to the correct customer once it's known (this updates every past visit under that name).
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead>
                <tr><th>Visited as</th><th>Visits</th><th>Last visit</th><th>Contact</th><th>Link to</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name_key}>
                    <td>{r.visited_name}</td>
                    <td>{r.visit_count}</td>
                    <td>{new Date(r.last_visit_date).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                    <td>{r.last_contact_person || "–"}{r.last_contact_number ? ` · ${r.last_contact_number}` : ""}</td>
                    <td>
                      <select
                        value={picked[r.name_key] || ""}
                        onChange={(e) => setPicked((p) => ({ ...p, [r.name_key]: e.target.value }))}
                        style={{ fontSize: 12 }}
                      >
                        <option value="">Select customer...</option>
                        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={busyKey === r.name_key}
                        onClick={() => link(r.name_key, r.visited_name)}
                        style={{ fontSize: 12, padding: "3px 8px" }}
                      >
                        {busyKey === r.name_key ? "..." : "Link"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function inr(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
