import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

// Round 130 — new Manager Dashboard report, built from the confirmed
// TruckTimingReport.dc.html mockup: same trips as the dashboard's own
// Completed Trips table, but across a chosen date range and with the full
// round-trip timeline (batch through plant-in) instead of just four columns.
// Backed by GET /orders/truck-timing-report — see that route's own comment
// for exactly which trip_events each column reads.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
}
function fmtDateShort(d) {
  return d ? new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "";
}

export default function TruckTimingReport() {
  const [fromDate, setFromDate] = useState(daysAgoStr(4));
  const [toDate, setToDate] = useState(todayStr());
  const [data, setData] = useState(null); // { from, to, trips }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      setData(await apiRequest(`/orders/truck-timing-report?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const trips = data?.trips || [];

  return (
    <>
      <TopBar title="Truck Timing Report" />
      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 16 }}>
          Batch to Plant-In timings for every completed trip — same trips as Completed Trips, with the full round-trip timeline.
        </div>

        <div className="card" style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--slate)", fontWeight: 600, marginBottom: 5 }}>From</div>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--slate)", fontWeight: 600, marginBottom: 5 }}>To</div>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <button type="button" className="btn-primary" onClick={run} disabled={loading}>
            {loading ? "Loading..." : "Filter"}
          </button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {data && (
          trips.length === 0 ? (
            <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No completed trips in this date range.</div>
          ) : (
            <div className="card">
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                {trips.length} completed trip{trips.length === 1 ? "" : "s"} · {fmtDateShort(data.from)}{data.from !== data.to ? ` – ${fmtDateShort(data.to)}` : ""}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Truck</th><th>Driver</th><th>Customer · Site</th><th>Qty</th>
                      <th>Batch</th><th>Plant Out</th><th>Site In</th><th>Unloading Start</th><th>Site Out</th><th>Plant In</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trips.map((t) => (
                      <tr key={t.ticket_id}>
                        <td>{t.truck_number || "—"}</td>
                        <td>{t.driver_name || "—"}</td>
                        <td>{t.customer_name} · {t.site_name}</td>
                        <td>{t.loaded_quantity_m3} m³</td>
                        <td>{fmtTime(t.batch_time)}</td>
                        <td>{fmtTime(t.plant_out_time)}</td>
                        <td>{fmtTime(t.site_in_time)}</td>
                        <td>{fmtTime(t.unloading_start_time)}</td>
                        <td>{fmtTime(t.site_out_time)}</td>
                        <td>{fmtTime(t.plant_in_time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 12 }}>Plant In = returned to plant.</div>
            </div>
          )
        )}
      </div>
    </>
  );
}
