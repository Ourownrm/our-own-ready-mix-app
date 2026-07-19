import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { CustomersPanel, SitesPanel } from "../lib/MasterDataPanels.jsx";
import CreateOrder from "./CreateOrder.jsx";

const FLEET_LABELS = {
  created: "At plant", batching: "At plant", dispatched: "Running",
  reached_site: "At site", unloading: "At site", returned: "Returning",
};

export default function ManagerDashboard() {
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [activeTrucks, setActiveTrucks] = useState([]);
  const [liveLocations, setLiveLocations] = useState([]);
  const [view, setView] = useState("dashboard"); // dashboard | create-order | customers | sites
  const [error, setError] = useState("");

  async function load() {
    try {
      const [dashboard, orderList, trucks, locations] = await Promise.all([
        apiRequest("/orders/dashboard"),
        apiRequest("/orders"),
        apiRequest("/orders/active-trucks"),
        apiRequest("/orders/live-locations"),
      ]);
      setStats(dashboard);
      setOrders(orderList);
      setActiveTrucks(trucks);
      setLiveLocations(locations);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000); // keep the truck list and map reasonably live
    return () => clearInterval(interval);
  }, []);

  async function closeOrder(order) {
    const reason = window.prompt(
      `Close order for ${order.customer_name} · ${order.site_name}?\n` +
      `This marks it as never-to-be-completed and removes it from the running lists.\n\n` +
      `Reason (optional):`
    );
    if (reason === null) return;
    try {
      await apiRequest(`/orders/${order.id}/close`, { method: "POST", body: { reason } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (view === "create-order") {
    return (
      <>
        <TopBar title="Manager · Create order" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 16px 32px" }}>
          <button onClick={() => setView("dashboard")} style={{ marginBottom: 16 }}>← Back to dashboard</button>
          <CreateOrder onDone={() => { setView("dashboard"); load(); }} />
        </div>
      </>
    );
  }
  if (view === "customers" || view === "sites") {
    return (
      <>
        <TopBar title="Manager · Customers & Sites" />
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button onClick={() => setView("dashboard")}>← Back to dashboard</button>
            <button className={`btn-tab ${view === "customers" ? "active" : ""}`} onClick={() => setView("customers")}>Customers</button>
            <button className={`btn-tab ${view === "sites" ? "active" : ""}`} onClick={() => setView("sites")}>Projects and sites</button>
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
          {view === "customers" && <CustomersPanel setError={setError} />}
          {view === "sites" && <SitesPanel setError={setError} />}
        </div>
      </>
    );
  }

  const fleetCounts = { "At plant": 0, Running: 0, "At site": 0, Returning: 0 };
  stats?.fleet_status?.forEach((row) => {
    const label = FLEET_LABELS[row.status];
    if (label) fleetCounts[label] += Number(row.count);
  });

  const today = orders.filter((o) => isSameDay(o.order_date, new Date()) && o.status !== "cancelled");
  const tomorrow = orders.filter((o) => isSameDay(o.order_date, addDays(new Date(), 1)) && o.status !== "cancelled");
  const carriedForward = orders.filter((o) =>
    new Date(o.order_date) < startOfDay(new Date()) &&
    !["completed", "cancelled"].includes(o.status)
  );

  return (
    <>
      <TopBar title="Manager Dashboard" />
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
          <Kpi label="Today's production" value={`${stats?.today_production_m3 ?? "–"} m³`} />
          <Kpi label="Monthly production" value={`${stats?.monthly_production_m3 ?? "–"} m³`} />
          <Kpi label="Delayed trucks" value={stats?.delayed_trucks ?? "–"} danger={stats?.delayed_trucks > 0} />
          <Kpi label="Rejected concrete" value={stats?.rejected_concrete ?? "–"} />
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          {Object.entries(fleetCounts).map(([label, count]) => (
            <div key={label} className="card" style={{ flex: 1, textAlign: "center" }}>
              <div className="kpi-label">{label}</div>
              <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{count}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={() => setView("create-order")}>Create order</button>
          <button onClick={() => setView("customers")}>Manage customers &amp; sites</button>
          <Link to="/reports"><button type="button">Reports &amp; Director's Dashboard</button></Link>
          <Link to="/breakdowns"><button type="button">Equipment breakdowns</button></Link>
        </div>

        <ActiveTrucksTable trucks={activeTrucks} locations={liveLocations} />

        {carriedForward.length > 0 && (
          <OrderTable
            title="Needs attention — carried forward from an earlier day"
            rows={carriedForward}
            onClose={closeOrder}
          />
        )}
        <OrderTable title="Running today" rows={today} onClose={closeOrder} />
        <OrderTable title="Scheduled tomorrow" rows={tomorrow} onClose={closeOrder} />
      </div>
    </>
  );
}

function Kpi({ label, value, danger }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${danger ? "danger" : ""}`}>{value}</div>
    </div>
  );
}

function ActiveTrucksTable({ trucks, locations }) {
  const locationByTicket = Object.fromEntries(locations.map((l) => [l.ticket_id, l]));

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Active trucks</div>
      {trucks.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No trucks currently running.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Truck</th><th>Driver</th><th>Customer</th><th>Loaded at</th><th>Status</th><th>GPS</th></tr>
          </thead>
          <tbody>
            {trucks.map((t) => {
              const loc = locationByTicket[t.ticket_id];
              return (
                <tr key={t.ticket_id}>
                  <td>{t.truck_number}</td>
                  <td>{t.driver_name}</td>
                  <td>{t.customer_name} &middot; {t.site_name}</td>
                  <td>{formatTime(t.created_at)}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>
                    {loc ? (
                      <a
                        href={`https://maps.google.com/?q=${loc.latitude},${loc.longitude}`}
                        target="_blank" rel="noreferrer"
                      >
                        View location ({minutesAgo(loc.recorded_at)})
                      </a>
                    ) : (
                      <span style={{ color: "var(--slate)" }}>No GPS yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OrderTable({ title, rows, onClose }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No orders.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Customer</th><th>Site</th><th>Grade</th><th>Ordered</th><th>Delivered</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>{o.customer_name}</td>
                <td>{o.site_name}</td>
                <td>{o.mix_grade_name}</td>
                <td>{o.order_quantity_m3} m³</td>
                <td>{o.delivered_qty_m3} m³</td>
                <td><StatusBadge status={o.status} /></td>
                <td>
                  <button className="btn-danger" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => onClose(o)}>
                    Close order
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    completed: "badge-success", planned: "badge-neutral", in_progress: "badge-warning",
    partially_completed: "badge-warning", cancelled: "badge-danger", dispatched: "badge-warning",
    reached_site: "badge-warning", unloading: "badge-warning", created: "badge-neutral",
  };
  return <span className={`badge ${map[status] || "badge-neutral"}`}>{status.replace(/_/g, " ")}</span>;
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
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function minutesAgo(isoTime) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(isoTime).getTime()) / 60000));
  return mins < 1 ? "just now" : `${mins} min ago`;
}
function formatTime(isoTime) {
  if (!isoTime) return "–";
  return new Date(isoTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
