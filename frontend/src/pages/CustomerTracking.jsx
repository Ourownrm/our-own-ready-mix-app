import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";
import { TruckCard } from "../lib/DeliveryTrackingView.jsx";
import { useCustomerLanguage, PublicLanguageSwitcher } from "../lib/customerI18n.jsx";

// Public, no-login page reached only via a shared per-order link (see
// OrderDetailModal's TrackingLinkPanel for how Manager/Admin generate it, and
// routes/tracking.js on the backend for why this is safe to leave open).
// Deliberately doesn't use TopBar/ProtectedRoute — there's no session here.
//
// Round 119, post-ship: the per-truck progress card (TruckCard) moved to
// lib/DeliveryTrackingView.jsx so the new customer portal's "Track
// delivery" panel can show the identical view — no behavior change here.

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

function StatusBadge({ status }) {
  const map = {
    planned: ["badge-neutral", "Planned"], in_progress: ["badge-progress", "In progress"],
    partially_completed: ["badge-warning", "Partially completed"], completed: ["badge-success", "Completed"],
    closed: ["badge-neutral", "Closed"], cancelled: ["badge-danger", "Cancelled"],
  };
  const [cls, label] = map[status] || ["badge-neutral", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function Shell({ children, customerLabel }) {
  const { t } = useCustomerLanguage();
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
            <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>
              {t("title_delivery_tracking")}{customerLabel ? ` · shared with ${customerLabel}` : ""}
            </div>
          </div>
          <PublicLanguageSwitcher />
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
