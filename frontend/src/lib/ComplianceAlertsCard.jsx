import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "./api.js";

const DOC_LABEL = {
  insurance: "Insurance", road_tax: "Road tax", permit: "Permit", puc: "PUC",
  fitness_certificate: "Fitness certificate", registration_certificate: "Registration certificate",
  amc: "AMC", calibration_certificate: "Calibration certificate",
  inspection_certificate: "Inspection certificate", load_testing_certificate: "Load testing certificate",
  safety_certification: "Safety certification",
};

export default function ComplianceAlertsCard() {
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/compliance/alerts").then(setAlerts).catch((err) => setError(err.message));
  }, []);

  if (error) return null;
  if (alerts.length === 0) return null;

  const expired = alerts.filter((a) => a.days_until_expiry < 0);
  const soon = alerts.filter((a) => a.days_until_expiry >= 0);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Compliance alerts</div>
        <span className="badge badge-danger">{alerts.length}</span>
      </div>

      {expired.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", marginBottom: 6 }}>Expired</div>
          {expired.map((a) => <AlertRow key={a.id} a={a} danger />)}
        </>
      )}
      {soon.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", margin: "10px 0 6px" }}>Expiring within 7 days</div>
          {soon.map((a) => <AlertRow key={a.id} a={a} />)}
        </>
      )}

      <Link to="/compliance"><button type="button" style={{ width: "100%", marginTop: 12 }}>View full compliance register</button></Link>
    </div>
  );
}

function AlertRow({ a, danger }) {
  const days = a.days_until_expiry;
  const daysText = days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? "Expires today" : `${days} days left`;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "8px 0 8px 10px", marginBottom: 6,
        borderLeft: `3px solid ${danger ? "var(--alert-red)" : "var(--amber)"}`,
        background: danger ? "var(--alert-red-bg)" : "var(--amber-bg)",
        borderRadius: "0 8px 8px 0",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {a.asset_name} <span style={{ fontWeight: 400, color: "var(--slate)" }}>— {DOC_LABEL[a.document_type] || a.document_type}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: danger ? "var(--alert-red)" : "var(--amber)", whiteSpace: "nowrap" }}>
        {daysText}
      </div>
    </div>
  );
}
