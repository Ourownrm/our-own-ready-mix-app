// Round 119, post-ship — pulled out of CustomerTracking.jsx (the round-91
// public /track/:token page) so the customer portal's new "Track delivery"
// panel (CustomerPortal.jsx) can show the exact same per-truck progress
// view instead of a second, slightly-different implementation. Both
// consumers get their data from the same backend helper
// (lib/orderTracking.js's getOrderTrackingPayload), so this is purely a
// display-layer reuse — no behavior change to the existing /track page.

export const STAGES = [
  { key: "left_plant_at", label: "Left\nPlant" },
  { key: "reached_site_at", label: "At\nSite" },
  { key: "unloading_started_at", label: "Unloading" },
  { key: "unloading_completed_at", label: "Delivered" },
];

export function truckStageIndex(t) {
  if (t.status === "rejected") return -1;
  if (t.unloading_completed_at) return 3;
  if (t.unloading_started_at) return 2;
  if (t.reached_site_at) return 1;
  if (t.left_plant_at) return 0;
  return -2; // not yet dispatched
}

export function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
}

export function TruckCard({ truck }) {
  const stage = truckStageIndex(truck);
  const done = stage === 3;
  return (
    <div className="card" style={{ marginBottom: 12, opacity: done ? 0.9 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            {/* Round 120, item 3c — a customer with several trucks on one
                order asked to see which delivery each truck is, at a glance
                (not just a ticket number, which doesn't read as a count). */}
            {truck.delivery_number != null && <span style={{ color: "var(--slate)", fontWeight: 600 }}>#{truck.delivery_number} · </span>}
            🚚 {truck.truck_number || "Truck"}
          </div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{truck.quantity_m3} m³ · DC #{truck.ticket_number}</div>
        </div>
        <TruckStatusBadge stage={stage} />
      </div>
      {stage >= -1 && (
        <div style={{ display: "flex", alignItems: "center", marginTop: 14 }}>
          {STAGES.map((s, i) => (
            <div key={s.key} style={{ flex: 1, textAlign: "center", position: "relative" }}>
              {i > 0 && (
                <div style={{ position: "absolute", top: 11, left: "-50%", width: "100%", height: 2, background: i <= stage ? "var(--signal-green)" : "#ECEAE4", zIndex: -1 }} />
              )}
              <div style={{
                width: 22, height: 22, borderRadius: "50%", margin: "0 auto 6px", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700,
                background: i < stage || (i === stage && done) ? "var(--signal-green)" : i === stage ? "var(--rebar)" : "#ECEAE4",
                color: i <= stage ? "#fff" : "var(--slate)",
                boxShadow: i === stage && !done ? "0 0 0 4px rgba(199,91,18,0.15)" : "none",
              }}>
                {i < stage || (i === stage && done) ? "✓" : i === stage ? "●" : ""}
              </div>
              <div style={{ fontSize: 10, color: i <= stage ? (i === stage && !done ? "var(--rebar)" : "var(--signal-green)") : "var(--slate)", fontWeight: i === stage ? 700 : 500, whiteSpace: "pre-line", lineHeight: 1.2 }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}
      <TruckNote truck={truck} stage={stage} />
    </div>
  );
}

function TruckNote({ truck, stage }) {
  // Round 120, item 3b — stage -2 means the delivery note exists (dt.status
  // is 'created' or 'dispatched') but plant-out hasn't been logged yet, i.e.
  // the truck is still physically at the plant being loaded/QC'd. This used
  // to render nothing here and a bare "Pending" badge above, which read as
  // "this delivery might not even be real yet" rather than "in progress at
  // the plant" — both the badge and this note now say so explicitly.
  if (stage === -2) return <Note>Under loading / quality check at plant</Note>;
  if (stage === 3) {
    return <Note tone="done">Completed {fmtTime(truck.unloading_completed_at)}</Note>;
  }
  if (stage === 2) return <Note>Unloading started {fmtTime(truck.unloading_started_at)}</Note>;
  if (stage === 1) return <Note>Arrived at site {fmtTime(truck.reached_site_at)}</Note>;
  if (stage === 0) {
    // Round 120, item 3e — eta_at is computed server-side
    // (backend/src/lib/etaEstimate.js): a live GPS-based estimate once recent
    // ping data exists, falling back to a distance-based one otherwise. Both
    // consumers of this component already re-poll the tracking payload every
    // 20s, so this narrows in automatically as the truck moves — no extra
    // polling needed here.
    return (
      <Note tone="eta">
        Left plant {fmtTime(truck.left_plant_at)}
        {truck.eta_at && ` · ETA site ${fmtTime(truck.eta_at)}`}
      </Note>
    );
  }
  return null;
}

function Note({ children, tone }) {
  const styles = {
    default: { color: "var(--slate)", background: "#FAF9F6", border: "1px solid var(--border)" },
    eta: { color: "var(--info)", background: "var(--info-bg)", border: "none" },
    done: { color: "var(--signal-green)", background: "var(--signal-green-bg)", border: "none" },
  };
  const s = styles[tone] || styles.default;
  return <div style={{ marginTop: 12, fontSize: 12, borderRadius: 8, padding: "8px 10px", ...s }}>{children}</div>;
}

export function TruckStatusBadge({ stage }) {
  // Round 120, item 3b — was "Pending", which is indistinguishable from "this
  // delivery doesn't exist yet". Every truck reaching this component IS a
  // real delivery_tickets row (dt.status 'created' or 'dispatched') that
  // simply hasn't had plant-out logged, so it's actively being loaded/QC'd
  // at the plant right now — say that.
  if (stage === -2) return <span className="badge badge-neutral">Under Loading / Quality Check</span>;
  if (stage === 0) return <span className="badge badge-info">In transit</span>;
  if (stage === 1) return <span className="badge badge-warning">At site</span>;
  if (stage === 2) return <span className="badge badge-warning">Unloading</span>;
  if (stage === 3) return <span className="badge badge-success">Delivered</span>;
  return null;
}
