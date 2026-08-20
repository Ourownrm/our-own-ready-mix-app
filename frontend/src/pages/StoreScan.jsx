import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function StoreScan() {
  const { token } = useParams();
  const [request, setRequest] = useState(null);
  const [error, setError] = useState(""); // page-level: bad/expired token, load failure
  const [formError, setFormError] = useState(""); // issue-form validation, shown inline without hiding the form
  const [actualQty, setActualQty] = useState("");
  const [cost, setCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    apiRequest(`/supply-requests/scan/${token}`)
      .then((r) => { setRequest(r); setActualQty(r.approved_quantity); })
      .catch((err) => setError(err.message));
  }, [token]);

  async function confirmIssue() {
    if (!actualQty) { setFormError("Enter the actual quantity issued."); return; }
    if (Number(actualQty) > Number(request.approved_quantity)) {
      setFormError(`Can't issue more than the approved quantity (${request.approved_quantity}). Enter that amount or less.`);
      return;
    }
    setSaving(true); setFormError("");
    try {
      await apiRequest(`/supply-requests/${request.id}/issue`, {
        method: "POST",
        body: { actual_quantity_issued: actualQty, fuel_cost: cost || null },
      });
      setDone(true);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Store · Issue supply" />
      <div style={{ maxWidth: 380, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && (
          <div style={{ background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", borderRadius: 12, padding: 16, textAlign: "center" }}>
            <div style={{ color: "var(--alert-red)", fontWeight: 600 }}>{error}</div>
          </div>
        )}

        {!error && done && (
          <div style={{ background: "var(--signal-green)", color: "#fff", borderRadius: 12, padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Issued</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Recorded — this code can't be used again.</div>
          </div>
        )}

        {!error && !done && !request && <div style={{ fontSize: 13, color: "var(--slate)", textAlign: "center", marginTop: 40 }}>Loading...</div>}

        {!error && !done && request && (
          <div style={{ background: "var(--surface-2, #fff)", border: "1px solid var(--rebar)", borderRadius: 16, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Scanned — details revealed</span>
            </div>

            <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "10px 12px", marginBottom: 14, fontSize: 13 }}>
              <Row label="Vehicle/machine" value={request.truck_number || request.pump_code || request.equipment_name} />
              <Row label="Requested by" value={request.requested_by_name} />
              <Row label="Reading" value={request.odometer_reading ? `${request.odometer_reading} km` : `${request.hour_meter_reading} hrs`} />
              <Row label={request.request_type === "fuel" ? "Approved fuel" : "Approved lubricant"} value={request.request_type === "fuel" ? `${request.approved_quantity} L` : `${request.approved_quantity} ${request.lubricant_type_name}`} />
              {request.request_type === "fuel" && <Row label="Station" value={request.approved_station_name} />}
            </div>

            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4 }}>
              Actual quantity issued <span style={{ color: "var(--slate)" }}>(max {request.approved_quantity} — less is fine if stock is short)</span>
            </div>
            <input type="number" max={request.approved_quantity} value={actualQty} onChange={(e) => setActualQty(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

            {request.request_type === "fuel" && (
              <>
                <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4 }}>Cost (₹, optional)</div>
                <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} style={{ width: "100%", marginBottom: 14 }} />
              </>
            )}

            {formError && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 10 }}>{formError}</div>}

            <button onClick={confirmIssue} disabled={saving} style={{ width: "100%", padding: 12, fontSize: 14, fontWeight: 600, background: "var(--signal-green)", color: "#fff", border: "none" }}>
              {saving ? "Saving..." : "Confirm issued"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
      <span style={{ color: "var(--slate)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
