import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";

// Public, no-login page reached only via a shared per-order link (see
// OrderDetailModal's TrackingLinkPanel for how Manager/Admin generate it, and
// routes/tracking.js on the backend for why this is safe to leave open).
// Deliberately doesn't use TopBar/ProtectedRoute — there's no session here.

const STAGES = [
  { key: "left_plant_at", label: "Left\nPlant" },
  { key: "reached_site_at", label: "At\nSite" },
  { key: "unloading_started_at", label: "Unloading" },
  { key: "unloading_completed_at", label: "Delivered" },
];

function truckStageIndex(t) {
  if (t.status === "rejected") return -1;
  if (t.unloading_completed_at) return 3;
  if (t.unloading_started_at) return 2;
  if (t.reached_site_at) return 1;
  if (t.left_plant_at) return 0;
  return -2; // not yet dispatched
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
}

export default function CustomerTracking() {
  const { token } = useParams();
  const [data, setData] = useState(undefined); // undefined = loading, null = expired
  const [error, setError] = useState("");

  function load() {
    apiRequest(`/track/${token}`)
      .then(setData)
      .catch(() => setData(null));
  }
  useEffect(() => {
    load();
    // No login/session here — a plain poll is the simplest reliable way to
    // stay live, same spirit as the rest of this app's dashboards.
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [token]);

  if (data === undefined) {
    return <CenterMessage>Loading...</CenterMessage>;
  }

  if (data === null) {
    return (
      <Shell>
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔒</div>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>This tracking link is no longer active</h2>
          <p style={{ fontSize: 13, color: "var(--slate)", lineHeight: 1.6 }}>
            It may have expired, or unable to connect to Our Own RMC Server, or the order it points to has been
            closed. Please contact your Our Own Ready Mix representative if you need updated tracking.
          </p>
        </div>
      </Shell>
    );
  }

  const { order, trucks } = data;
  const progressPct = order.order_quantity_m3 > 0
    ? Math.min(100, Math.round((Number(order.delivered_qty_m3) / Number(order.order_quantity_m3)) * 100))
    : 0;
  const dispatchedQty = trucks.reduce((sum, t) => sum + Number(t.quantity_m3 || 0), 0);
  const remainingQty = Math.max(0, Number(order.order_quantity_m3) - dispatchedQty);

  return (
    <Shell customerLabel={order.customer_name}>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 }}>{order.site_name}</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{order.customer_name}</div>
            <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 4 }}>
              {order.mix_grade_name} · Ordered {order.order_quantity_m3} m³ ·{" "}
              {new Date(order.order_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}
            </div>
          </div>
          <StatusBadge status={order.status} />
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--slate)", marginBottom: 5 }}>
            <span>Delivered so far</span>
            <span><strong>{order.delivered_qty_m3}</strong> of {order.order_quantity_m3} m³</span>
          </div>
          <div style={{ height: 8, borderRadius: 6, background: "#ECEAE4", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progressPct}%`, background: "var(--rebar)", borderRadius: 6 }} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "var(--slate)", marginBottom: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--signal-green)" }} /> Updates automatically
      </div>

      {trucks.filter((t) => t.status !== "rejected").map((t) => (
        <TruckCard key={t.ticket_number} truck={t} />
      ))}
      {trucks.some((t) => t.status === "rejected") && (
        <div className="card" style={{ marginBottom: 12, fontSize: 12, color: "var(--slate)" }}>
          One or more deliveries on this order were rejected at site and aren't shown above.
        </div>
      )}
      {remainingQty > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>🚚 Not yet dispatched</div>
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{remainingQty} m³ remaining on this order</div>
            </div>
            <span className="badge badge-neutral">Pending</span>
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "6px 16px 22px", lineHeight: 1.6 }}>
        This link shows only this order. It doesn't show any other order or customer.<br />
        Shared by Our Own Ready Mix.
      </div>
    </Shell>
  );
}

function TruckCard({ truck }) {
  const stage = truckStageIndex(truck);
  const done = stage === 3;
  return (
    <div className="card" style={{ marginBottom: 12, opacity: done ? 0.9 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>🚚 {truck.truck_number || "Truck"}</div>
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
  if (stage === -2) return null;
  if (stage === 3) {
    return <Note tone="done">Completed {fmtTime(truck.unloading_completed_at)}</Note>;
  }
  if (stage === 2) return <Note>Unloading started {fmtTime(truck.unloading_started_at)}</Note>;
  if (stage === 1) return <Note>Arrived at site {fmtTime(truck.reached_site_at)}</Note>;
  if (stage === 0) return <Note tone="eta">Left plant {fmtTime(truck.left_plant_at)}</Note>;
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

function StatusBadge({ status }) {
  const map = {
    planned: ["badge-neutral", "Planned"], in_progress: ["badge-progress", "In progress"],
    partially_completed: ["badge-warning", "Partially completed"], completed: ["badge-success", "Completed"],
    closed: ["badge-neutral", "Closed"], cancelled: ["badge-danger", "Cancelled"],
  };
  const [cls, label] = map[status] || ["badge-neutral", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function TruckStatusBadge({ stage }) {
  if (stage === -2) return <span className="badge badge-neutral">Pending</span>;
  if (stage === 0) return <span className="badge badge-info">In transit</span>;
  if (stage === 1) return <span className="badge badge-warning">At site</span>;
  if (stage === 2) return <span className="badge badge-warning">Unloading</span>;
  if (stage === 3) return <span className="badge badge-success">Delivered</span>;
  return null;
}

function Shell({ children, customerLabel }) {
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title">
          Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
          <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>
            Delivery tracking{customerLabel ? ` · shared with ${customerLabel}` : ""}
          </div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>{children}</div>
    </div>
  );
}

function CenterMessage({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--slate)", fontSize: 13 }}>
      {children}
    </div>
  );
}
