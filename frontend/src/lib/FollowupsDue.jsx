import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

// Groups by (date, customer) so several follow-ups for the same visit show
// as one header with sub-items underneath, instead of repeating the date
// and customer name on every single line.
function groupByDateCustomer(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.due_date}|${r.visited_name}|${r.site_name || ""}`;
    if (!groups.has(key)) {
      groups.set(key, { due_date: r.due_date, visited_name: r.visited_name, site_name: r.site_name, items: [] });
    }
    groups.get(key).items.push(r);
  }
  return [...groups.values()];
}

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

  function GroupBlock({ group, accentColor }) {
    return (
      <div style={{ borderLeft: `3px solid ${accentColor}`, background: "var(--concrete)", borderRadius: "0 8px 8px 0", padding: "8px 10px", marginBottom: 8, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {new Date(group.due_date).toLocaleDateString([], { day: "2-digit", month: "short" })} — {group.visited_name}{group.site_name ? ` — ${group.site_name}` : ""}
        </div>
        {group.items.map((r) => (
          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, padding: "3px 0 3px 10px" }}>
            <div>
              <div>{r.title}</div>
              {r.reason && <div style={{ color: "var(--slate)", fontSize: 11 }}>{r.reason}</div>}
            </div>
            <button style={{ fontSize: 11, padding: "3px 8px", whiteSpace: "nowrap" }} disabled={busyId === r.id} onClick={() => markDone(r.id)}>
              {busyId === r.id ? "..." : "Done"}
            </button>
          </div>
        ))}
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
              {groupByDateCustomer(overdue).map((g, i) => <GroupBlock key={i} group={g} accentColor="var(--alert-red)" />)}
            </>
          )}
          {dueToday.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--amber)", marginBottom: 4 }}>Today ({dueToday.length})</div>
              {groupByDateCustomer(dueToday).map((g, i) => <GroupBlock key={i} group={g} accentColor="var(--amber)" />)}
            </>
          )}
          {upcoming.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 4 }}>Upcoming ({upcoming.length})</div>
              {groupByDateCustomer(upcoming).map((g, i) => <GroupBlock key={i} group={g} accentColor="var(--slate)" />)}
            </>
          )}
        </>
      )}
    </div>
  );
}
