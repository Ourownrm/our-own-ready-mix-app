import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function SalesPerformance() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/sales/performance").then(setRows).catch((err) => setError(err.message));
  }, []);

  return (
    <>
      <TopBar title="Sales Performance" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div className="card">
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
