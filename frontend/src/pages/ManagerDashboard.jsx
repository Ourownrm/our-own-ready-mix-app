import { useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext.jsx";
import { apiRequest } from "../lib/api.js";
import CreateOrder from "./CreateOrder.jsx";

const FLEET_LABELS = {
  created: "At plant", batching: "At plant", dispatched: "Running",
  reached_site: "At site", unloading: "At site", returned: "Returning",
};

export default function ManagerDashboard() {
  const { user, logout } = useAuth();
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [showCreateOrder, setShowCreateOrder] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [dashboard, orderList] = await Promise.all([
        apiRequest("/orders/dashboard"),
        apiRequest("/orders"),
      ]);
      setStats(dashboard);
      setOrders(orderList);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  if (showCreateOrder) {
    return <CreateOrder onDone={() => { setShowCreateOrder(false); load(); }} />;
  }

  const fleetCounts = { "At plant": 0, Running: 0, "At site": 0, Returning: 0 };
  stats?.fleet_status?.forEach((row) => {
    const label = FLEET_LABELS[row.status];
    if (label) fleetCounts[label] += Number(row.count);
  });

  const today = orders.filter((o) => isSameDay(o.order_date, new Date()));
  const tomorrow = orders.filter((o) => isSameDay(o.order_date, addDays(new Date(), 1)));

  return (
    <div style={{ maxWidth: 960, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "#666" }}>Manager Dashboard &middot; {user?.name}</div>
        <button onClick={logout} style={{ fontSize: 12, color: "#999", background: "none", border: "none" }}>Sign out</button>
      </div>

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Kpi label="Today's production" value={`${stats?.today_production_m3 ?? "–"} m³`} />
        <Kpi label="Monthly production" value={`${stats?.monthly_production_m3 ?? "–"} m³`} />
        <Kpi label="Delayed trucks" value={stats?.delayed_trucks ?? "–"} danger={stats?.delayed_trucks > 0} />
        <Kpi label="Rejected concrete" value={stats?.rejected_concrete ?? "–"} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        {Object.entries(fleetCounts).map(([label, count]) => (
          <div key={label} style={{ flex: 1, background: "#f5f5f5", borderRadius: 12, padding: "10px", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 500 }}>{count}</div>
          </div>
        ))}
      </div>

      <button onClick={() => setShowCreateOrder(true)} style={{ marginBottom: 16 }}>Create order</button>

      <OrderTable title="Running today" rows={today} />
      <OrderTable title="Scheduled tomorrow" rows={tomorrow} />
    </div>
  );
}

function Kpi({ label, value, danger }) {
  return (
    <div style={{ background: "#f5f5f5", borderRadius: 12, padding: "1rem" }}>
      <div style={{ fontSize: 13, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 500, color: danger ? "#c0392b" : "#111" }}>{value}</div>
    </div>
  );
}

function OrderTable({ title, rows }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "#999" }}>No orders.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#666" }}>
              <th style={{ padding: "6px 4px" }}>Customer</th>
              <th style={{ padding: "6px 4px" }}>Site</th>
              <th style={{ padding: "6px 4px" }}>Grade</th>
              <th style={{ padding: "6px 4px" }}>Qty</th>
              <th style={{ padding: "6px 4px" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} style={{ borderTop: "0.5px solid #ddd" }}>
                <td style={{ padding: "6px 4px" }}>{o.customer_name}</td>
                <td style={{ padding: "6px 4px" }}>{o.site_name}</td>
                <td style={{ padding: "6px 4px" }}>{o.mix_grade_name}</td>
                <td style={{ padding: "6px 4px" }}>{o.order_quantity_m3} m³</td>
                <td style={{ padding: "6px 4px" }}>{o.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function isSameDay(dateStr, d2) {
  const d1 = new Date(dateStr);
  return d1.toDateString() === d2.toDateString();
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
