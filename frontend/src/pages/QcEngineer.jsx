import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function QcEngineer() {
  const [pendingQc, setPendingQc] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qcTicketId, setQcTicketId] = useState("");
  const [qcForm, setQcForm] = useState({ slump_mm: "", temperature_c: "", number_of_cubes: 3, sample_ids: "", remarks: "" });

  async function load() {
    try {
      setPendingQc(await apiRequest("/qc-engineer/pending-qc"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

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

  return (
    <>
      <TopBar title="QC Engineer" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}

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
      </div>
    </>
  );
}
