import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

const EQUIPMENT_LABEL = { truck: "Truck", pump: "Pump", plant: "Batching plant" };

export default function Breakdowns() {
  const [rows, setRows] = useState([]);
  const [issueLabels, setIssueLabels] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      setRows(await apiRequest("/breakdowns"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    // Round 99, item 3 — issue_type picklist labels, fetched once (same
    // single-source-of-truth as backend/src/lib/breakdownIssueTypes.js).
    apiRequest("/master/breakdown-issue-types")
      .then((list) => setIssueLabels(Object.fromEntries(list.map((i) => [i.value, i.label]))))
      .catch(() => {});
    return () => clearInterval(interval);
  }, []);

  function details(r) {
    const bits = [];
    if (r.issue_type) bits.push(issueLabels[r.issue_type] || r.issue_type);
    if (r.remarks) bits.push(r.remarks);
    if (r.location) bits.push(r.location); // pump/plant reports only — driver flow no longer sets this
    return bits.join(" — ") || "—";
  }

  async function markRepaired(id) {
    try {
      await apiRequest(`/breakdowns/${id}/repaired`, { method: "POST" });
      setNotice("Marked repaired.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const active = rows.filter((r) => !r.resolved);
  const resolved = rows.filter((r) => r.resolved);

  return (
    <>
      <TopBar title="Equipment Breakdowns" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 12 }}>{notice}</div>}

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Active breakdowns</div>
          {active.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing currently broken down.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Equipment</th><th>Reported</th><th>By</th><th>Details</th><th></th></tr>
              </thead>
              <tbody>
                {active.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="badge badge-danger">{EQUIPMENT_LABEL[r.equipment_type]}</span>{" "}
                      {r.truck_number || r.pump_code || r.equipment_label}
                    </td>
                    <td>{new Date(r.breakdown_time).toLocaleString()}</td>
                    <td>{r.reported_by_name || "–"}</td>
                    <td style={{ maxWidth: 300 }}>
                      {details(r)}
                      {r.latitude && r.longitude && (
                        <>
                          {" "}
                          <a href={`https://maps.google.com/?q=${r.latitude},${r.longitude}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                            view location
                          </a>
                        </>
                      )}
                    </td>
                    <td>
                      <button className="btn-primary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => markRepaired(r.id)}>
                        Mark repaired
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Recently repaired</div>
          {resolved.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>None yet.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Equipment</th><th>Reported</th><th>Repaired</th><th>By</th></tr>
              </thead>
              <tbody>
                {resolved.slice(0, 30).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="badge badge-success">{EQUIPMENT_LABEL[r.equipment_type]}</span>{" "}
                      {r.truck_number || r.pump_code || r.equipment_label}
                    </td>
                    <td>{new Date(r.breakdown_time).toLocaleString()}</td>
                    <td>{r.repaired_at ? new Date(r.repaired_at).toLocaleString() : "–"}</td>
                    <td>{r.repaired_by_name || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
