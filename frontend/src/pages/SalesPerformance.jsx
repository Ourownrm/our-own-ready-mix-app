import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { CreateLeadForm } from "../lib/SalesPanels.jsx";

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
      </div>
    </>
  );
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
