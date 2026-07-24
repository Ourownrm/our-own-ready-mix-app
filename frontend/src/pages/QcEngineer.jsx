import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function QcEngineer() {
  const [pendingQc, setPendingQc] = useState([]);
  const [delayedTrucks, setDelayedTrucks] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qcTicketId, setQcTicketId] = useState("");
  const [qcForm, setQcForm] = useState({ slump_mm: "", temperature_c: "", number_of_cubes: 3, sample_ids: "", remarks: "" });

  async function load() {
    try {
      const [pending, delayed] = await Promise.all([
        apiRequest("/qc-engineer/pending-qc"),
        apiRequest("/qc-engineer/delayed-trucks"),
      ]);
      setPendingQc(pending);
      setDelayedTrucks(delayed);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000); // keep the delayed-trucks list reasonably live
    return () => clearInterval(interval);
  }, []);

  async function submitQc(e) {
    e.preventDefault();
    setError(""); setNotice("");
    if (!qcTicketId) return setError("Select a ticket to submit QC for.");
    try {
      await apiRequest(`/qc-engineer/${qcTicketId}/plant-qc`, { method: "POST", body: qcForm });
      setNotice("QC submitted, ticket moved to dispatched.");
      setQcForm({ slump_mm: "", temperature_c: "", number_of_cubes: 3, sample_ids: "", remarks: "" });
      setQcTicketId("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function flagForManager(ticketId) {
    setError("");
    try {
      await apiRequest(`/qc-engineer/delayed-trucks/${ticketId}/flag`, { method: "POST" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <TopBar title="QC Engineer" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}

        {delayedTrucks.length > 0 && (
          <div className="card" style={{ marginBottom: 16, border: "1px solid var(--alert-red)" }}>
            <div style={{ fontWeight: 600, color: "var(--alert-red)", marginBottom: 4 }}>
              {delayedTrucks.length} truck{delayedTrucks.length > 1 ? "s" : ""} over 2 hrs at site
            </div>
            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
              Worth a quality check — a truck sitting this long at site can mean the concrete is losing workability.
            </div>
            {delayedTrucks.map((t) => (
              <div key={t.ticket_id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 13 }}>
                <div style={{ fontWeight: 600 }}>{t.truck_number} · {t.ticket_number}</div>
                <div style={{ color: "var(--slate)" }}>{t.customer_name} — {t.site_name}</div>
                <div style={{ color: "var(--slate)" }}>{t.mix_grade_name} · Driver: {t.driver_name}</div>
                <div style={{ color: "var(--alert-red)", fontWeight: 600, marginTop: 4 }}>
                  At site {formatDuration(t.minutes_at_site)}
                </div>
                <button
                  style={{ marginTop: 8, width: "100%", fontSize: 12, padding: "6px" }}
                  disabled={t.already_flagged}
                  onClick={() => flagForManager(t.ticket_id)}
                >
                  {t.already_flagged ? "Manager already notified" : "Flag for Manager"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Plant QC entry</div>
          <form onSubmit={submitQc} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Ticket awaiting QC</div>
              <select value={qcTicketId} onChange={(e) => setQcTicketId(e.target.value)} required>
                <option value="">Select</option>
                {pendingQc.map((t) => (
                  <option key={t.id} value={t.id}>{t.ticket_number} — {t.truck_number} — {t.site_name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ color: "var(--slate)" }}>Slump (mm)</div>
                <input type="number" value={qcForm.slump_mm} onChange={(e) => setQcForm({ ...qcForm, slump_mm: e.target.value })} required />
              </div>
              <div>
                <div style={{ color: "var(--slate)" }}>Temperature (°C)</div>
                <input type="number" value={qcForm.temperature_c} onChange={(e) => setQcForm({ ...qcForm, temperature_c: e.target.value })} />
              </div>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Number of cubes</div>
              <input type="number" value={qcForm.number_of_cubes} onChange={(e) => setQcForm({ ...qcForm, number_of_cubes: e.target.value })} />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Sample IDs</div>
              <input type="text" value={qcForm.sample_ids} onChange={(e) => setQcForm({ ...qcForm, sample_ids: e.target.value })} placeholder="C-2231-1, C-2231-2" />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Remarks</div>
              <textarea rows={2} value={qcForm.remarks} onChange={(e) => setQcForm({ ...qcForm, remarks: e.target.value })} />
            </div>
            <button type="submit" style={{ marginTop: 4 }}>Submit QC and release</button>
          </form>
        </div>

        {pendingQc.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 12 }}>No tickets waiting on QC right now.</div>
        )}

        <Link to="/qc/raw-material-stock">
          <button type="button" style={{ width: "100%", marginTop: 16 }}>Raw material stock entry →</button>
        </Link>
      </div>
    </>
  );
}

function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
