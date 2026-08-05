import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function TripTimeCrossCheckPage() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    apiRequest("/orders/trip-time-crosscheck")
      .then(setRows)
      .catch((err) => setError(err.message));
  }, []);

  const flagged = rows.filter((r) => r.flagged);
  const visible = showAll ? rows : flagged;

  return (
    <>
      <TopBar title="Trip time cross-check" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Trip time cross-check</div>
            {rows.length > 0 && (
              <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show flagged only" : `Show all (${rows.length})`}
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 10 }}>
            Compares the Site In time logged for each trip (by whoever confirmed it — driver or Site Supervisor)
            against the nearest GPS ping at that moment. A gap over 15 minutes is flagged for a look; small gaps
            are normal GPS noise and aren't shown unless you ask to see everything.
          </div>
          {visible.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>
              {rows.length === 0 ? "No trips in the last 7 days to check." : "Nothing flagged in the last 7 days."}
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>DC No.</th><th>Driver</th><th>Site</th><th>Logged by</th><th>Site In (logged)</th><th>Nearest GPS</th><th>Gap</th></tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.ticket_id} style={r.flagged ? { background: "var(--alert-red-bg, #FBEAEA)" } : undefined}>
                      <td>{r.ticket_number}</td>
                      <td>{r.driver_name}</td>
                      <td>{r.customer_name} &middot; {r.site_name}</td>
                      <td>{r.site_in_logged_by || "–"}</td>
                      <td>{formatTime(r.site_in_logged_at)}</td>
                      <td>{r.nearest_gps_time ? formatTime(r.nearest_gps_time) : <span style={{ color: "var(--alert-red)" }}>No GPS data</span>}</td>
                      <td style={r.flagged ? { color: "var(--alert-red)", fontWeight: 600 } : undefined}>
                        {r.gap_minutes != null ? `${r.gap_minutes} min` : "–"}
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

function formatTime(isoTime) {
  if (!isoTime) return "–";
  return new Date(isoTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
