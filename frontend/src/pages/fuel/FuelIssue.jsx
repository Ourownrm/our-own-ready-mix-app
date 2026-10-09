import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../lib/api.js";
import { useAuth } from "../../lib/AuthContext.jsx";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { fmtL, fmtNum, fmtWhen } from "./fuelUi.jsx";

// Round 199 — every fuel request still waiting on someone, in one list.
// The actions themselves are unchanged and stay where they were: a Manager
// approves on "Fuel and lubricant requests", Store issues by scanning the
// driver's QR code, and a driver confirms their own outside-station fill.

const STAGES = [
  { key: "approval", title: "Waiting for approval", sub: "A Manager approves or reduces the quantity" },
  { key: "issue", title: "Approved — ready to issue at the plant", sub: "Store scans the driver's QR code to issue" },
  { key: "outside", title: "Approved for an outside station", sub: "The driver confirms the litres after filling" },
];

export default function FuelIssue() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const canApprove = can("store.supply-approve", "edit") && ["manager", "administrator", "super_admin"].includes(user?.role);
  const canScan = can("store.supply-issue", "edit") && ["store", "administrator", "super_admin"].includes(user?.role);

  function load() {
    setError("");
    apiRequest("/fuel-module/issue-queue").then(setRows).catch((e) => setError(e.message));
  }
  useEffect(load, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Issue fuel</h1>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>Fuel requests waiting to be approved, issued or confirmed</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canScan && <Link to="/store"><button type="button" className="btn-primary">Scan QR &amp; issue</button></Link>}
          {canApprove && <Link to="/supply-approvals"><button type="button">Approve requests</button></Link>}
          <button type="button" onClick={load}>Refresh</button>
        </div>
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {!rows && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {rows && STAGES.map((st) => {
        const list = rows.filter((r) => r.stage === st.key);
        return (
          <section key={st.key} className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{st.title} <span className="chip" style={{ marginLeft: 6 }}>{list.length}</span></div>
                <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{st.sub}</div>
              </div>
              {st.key === "approval" && canApprove && list.length > 0 && <Link to="/supply-approvals"><button type="button" style={{ fontSize: 12.5 }}>Open approvals</button></Link>}
              {st.key === "issue" && canScan && list.length > 0 && <Link to="/store"><button type="button" style={{ fontSize: 12.5 }}>Scan QR</button></Link>}
            </div>
            {list.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 10 }}>Nothing waiting.</div>
            ) : (
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table style={{ minWidth: 720 }}>
                  <thead><tr><th>Ref</th><th>Vehicle / machine</th><th style={{ textAlign: "right" }}>Asked</th><th style={{ textAlign: "right" }}>Approved</th><th>Reading</th><th>Requested</th><th>Last fill</th>{st.key !== "approval" && <th>Station</th>}</tr></thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>FR-{r.id}</td>
                        <td><b>{r.unit_label || "—"}</b><div style={{ fontSize: 11, color: "var(--slate)" }}>{r.unit_sub}</div></td>
                        <td style={{ textAlign: "right" }}>{fmtL(r.requested_quantity)}</td>
                        <td style={{ textAlign: "right" }}>{r.approved_quantity != null ? fmtL(r.approved_quantity) : "—"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.odometer_reading != null ? `${fmtNum(r.odometer_reading)} km` : r.hour_meter_reading != null ? `${fmtNum(r.hour_meter_reading, 1)} hrs` : "—"}</td>
                        <td style={{ fontSize: 12 }}>{fmtWhen(r.requested_at)}<div style={{ color: "var(--slate)" }}>{r.requested_by_name}</div></td>
                        <td style={{ fontSize: 12 }}>{r.last_fill_at ? <>{fmtWhen(r.last_fill_at)}<div style={{ color: "var(--slate)" }}>{fmtL(r.last_fill_qty)}</div></> : "—"}</td>
                        {st.key !== "approval" && <td style={{ fontSize: 12 }}>{r.station_name || "—"}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
