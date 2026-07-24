import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

const VISITOR_TYPE_LABEL = { customer: "Customer", client: "Client", consultant: "Consultant", site_engineer: "Site engineer", other: "Other" };

export default function SalesPerformance() {
  const [rows, setRows] = useState(null);
  const [visits, setVisits] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/sales/performance").then(setRows).catch((err) => setError(err.message));
    apiRequest("/sales/visits").then(setVisits).catch((err) => setError(err.message));
  }, []);

  return (
    <>
      <TopBar title="Sales Performance" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ marginBottom: 16 }}>
          <Link to="/leads"><button type="button">Browse all leads</button></Link>
        </div>
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

function inr(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
