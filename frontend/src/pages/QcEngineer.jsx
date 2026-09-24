import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import TodaysDeliveryNotes from "../lib/TodaysDeliveryNotes.jsx";

export default function QcEngineer() {
  const [pendingQc, setPendingQc] = useState([]);
  const [delayedTrucks, setDelayedTrucks] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qcTicketId, setQcTicketId] = useState("");
  // Round 155 — number_of_cubes starts EMPTY, not 0 and not 3.
  //
  // It defaulted to 3 until Ver. 9.29, which created phantom batches in the
  // lab's queue for loads where nothing was cast. That was "fixed" by
  // defaulting to 0 — which produced the opposite and quieter failure the lab
  // reported in September: QC entered slump and sample IDs, left this box
  // alone, and the pour never reached the lab at all, because the lab's queue
  // is `COALESCE(number_of_cubes, 0) > 0`.
  //
  // Both defaults answer a question nobody asked. There is no default now: the
  // field is required, 0 is a valid and meaningful answer, and the backend
  // refuses the submission if it is blank.
  const [qcForm, setQcForm] = useState({ slump_mm: "", temperature_c: "", number_of_cubes: "", sample_ids: "", remarks: "" });

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

  // Which ticket is selected, so the form can show what its order actually
  // asks for. pendingQc already carries cube_samples_required from
  // qcEngineer.js's /pending-qc query.
  const selectedTicket = pendingQc.find((t) => String(t.id) === String(qcTicketId)) || null;
  const cubeMismatch =
    selectedTicket?.cube_samples_required != null &&
    qcForm.number_of_cubes !== "" &&
    Number(qcForm.number_of_cubes) !== Number(selectedTicket.cube_samples_required);

  async function submitQc(e) {
    e.preventDefault();
    setError(""); setNotice("");
    if (!qcTicketId) return setError("Select a ticket to submit QC for.");
    try {
      await apiRequest(`/qc-engineer/${qcTicketId}/plant-qc`, { method: "POST", body: qcForm });
      setNotice("QC submitted, ticket moved to dispatched.");
      setQcForm({ slump_mm: "", temperature_c: "", number_of_cubes: "", sample_ids: "", remarks: "" });
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
                {t.sales_representative_name && (
                  <div style={{ color: "var(--slate)" }}>Sales rep: {t.sales_representative_name}</div>
                )}
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
              <div style={{ color: "var(--slate)", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>Number of cubes <span style={{ color: "var(--alert-red)" }}>*</span></span>
                {/* The order has always carried this number and the API has
                    always sent it — it was simply never shown, so QC had no
                    prompt that 3 cubes were expected for this load. */}
                {selectedTicket?.cube_samples_required != null && (
                  <span style={{ color: "var(--rebar)", fontWeight: 600 }}>
                    order asks for {selectedTicket.cube_samples_required}
                  </span>
                )}
              </div>
              <input
                type="number" min="0" max="60" step="1" required
                placeholder="how many were actually cast"
                value={qcForm.number_of_cubes}
                onChange={(e) => setQcForm({ ...qcForm, number_of_cubes: e.target.value })}
              />
              {cubeMismatch && (
                <div style={{ fontSize: 12, color: "var(--amber)", marginTop: 4 }}>
                  That differs from the {selectedTicket.cube_samples_required} this order asks for — fine if
                  that is what was cast, it will be recorded as entered.
                </div>
              )}
              {qcForm.number_of_cubes === "0" && (
                <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4 }}>
                  No cubes cast for this load — it will not appear in the lab's testing queue.
                </div>
              )}
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

        {/* Round 153, item 1 — the paperwork behind a load QC is being asked
            about, without going through an Administrator. */}
        <TodaysDeliveryNotes />
      </div>
    </>
  );
}

function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
