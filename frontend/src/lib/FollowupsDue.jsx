import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export default function FollowupsDue() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function load() {
    try {
      setRows(await apiRequest("/sales/followups"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function markDone(id) {
    setBusyId(id); setError("");
    try {
      await apiRequest(`/sales/followups/${id}/done`, { method: "POST" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const today = new Date().toDateString();
  const overdue = rows.filter((r) => new Date(r.due_date) < new Date(today));
  const dueToday = rows.filter((r) => new Date(r.due_date).toDateString() === today);
  const upcoming = rows.filter((r) => new Date(r.due_date) > new Date(today));

  function Row({ r }) {
    return (
      <div style={{ borderLeft: "3px solid var(--alert-red)", background: "var(--concrete)", borderRadius: "0 8px 8px 0", padding: "8px 10px", marginBottom: 8, fontSize: 13 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{r.visited_name}{r.site_name ? ` — ${r.site_name}` : ""}</div>
            <div>{r.title}</div>
            {r.reason && <div style={{ color: "var(--slate)", fontSize: 11 }}>{r.reason}</div>}
          </div>
          <button style={{ fontSize: 11, padding: "3px 8px", whiteSpace: "nowrap" }} disabled={busyId === r.id} onClick={() => markDone(r.id)}>
            {busyId === r.id ? "..." : "Done"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Follow-ups due</div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing pending.</div>
      ) : (
        <>
          {overdue.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--alert-red)", marginBottom: 4 }}>Overdue ({overdue.length})</div>
              {overdue.map((r) => <Row key={r.id} r={r} />)}
            </>
          )}
          {dueToday.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--amber)", marginBottom: 4 }}>Today ({dueToday.length})</div>
              {dueToday.map((r) => <Row key={r.id} r={r} />)}
            </>
          )}
          {upcoming.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 4 }}>Upcoming ({upcoming.length})</div>
              {upcoming.map((r) => (
                <div key={r.id} style={{ fontSize: 12, color: "var(--slate)", padding: "4px 0", borderTop: "1px solid var(--concrete)" }}>
                  {new Date(r.due_date).toLocaleDateString([], { day: "2-digit", month: "short" })} — {r.visited_name} — {r.title}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
