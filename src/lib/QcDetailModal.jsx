import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";

export default function QcDetailModal({ ticketId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ticketId) return;
    setData(null); setError("");
    apiRequest(`/production-report/${ticketId}/qc-detail`).then(setData).catch((err) => setError(err.message));
  }, [ticketId]);

  if (!ticketId) return null;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(34,38,43,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 460, width: "100%", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>QC & slump details {data ? `— ${data.ticket_number}` : ""}</div>
          <button onClick={onClose} style={{ padding: "4px 10px" }}>Close</button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
        {!data && !error && <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>}

        {data && (
          <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontWeight: 600, color: "var(--rebar)", marginBottom: 6 }}>At the plant (QC Engineer)</div>
              <Row label="Slump" value={data.plant_slump_mm != null ? `${data.plant_slump_mm} mm` : "Not recorded"} />
              <Row label="Temperature" value={data.plant_temperature_c != null ? `${data.plant_temperature_c} °C` : "Not recorded"} />
              <Row label="Cube samples" value={data.number_of_cubes ?? "Not recorded"} />
              <Row label="Sample IDs" value={data.sample_ids || "–"} />
              <Row label="Remarks" value={data.plant_remarks || "–"} />
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--rebar)", marginBottom: 6 }}>At site (Site Supervisor / Driver)</div>
              <Row label="Slump on arrival" value={data.site_slump_mm != null ? `${data.site_slump_mm} mm` : "Not recorded"} />
              <Row label="Site temperature" value={data.site_temperature_c != null ? `${data.site_temperature_c} °C` : "Not recorded"} />
              <Row label="Unloading" value={
                data.unload_start_time
                  ? `${new Date(data.unload_start_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${data.unload_finish_time ? new Date(data.unload_finish_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "in progress"}`
                  : "Not started"
              } />
              <Row label="Outcome" value={data.accepted === false ? "Rejected" : data.accepted === true ? "Accepted" : "Pending"} />
              {data.accepted === false && (
                <>
                  <Row label="Rejected quantity" value={data.rejected_quantity_m3 != null ? `${data.rejected_quantity_m3} m³` : "–"} />
                  <Row label="Rejection reason" value={data.rejection_reason || "–"} />
                </>
              )}
              <Row label="Delivery note" value={data.delivery_note_status || "–"} />
              <Row label="After-pour care guided" value={data.after_pour_care_confirmed ? "Yes" : "No"} />
              <Row label="Remarks" value={data.site_remarks || "–"} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: "1px solid var(--border, #eee)", paddingBottom: 4, marginBottom: 4 }}>
      <span style={{ color: "var(--slate)" }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: "right" }}>{value}</span>
    </div>
  );
}
