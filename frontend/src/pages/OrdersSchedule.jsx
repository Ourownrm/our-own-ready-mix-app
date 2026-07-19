import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

export default function OrdersSchedule() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    try {
      setOrders(await apiRequest("/orders"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  const today = orders.filter((o) => isSameDay(o.order_date, new Date()) && o.status !== "cancelled");
  const tomorrow = orders.filter((o) => isSameDay(o.order_date, addDays(new Date(), 1)) && o.status !== "cancelled");
  const overdue = orders.filter((o) =>
    new Date(o.order_date) < startOfDay(new Date()) &&
    !["completed", "cancelled"].includes(o.status)
  );

  return (
    <>
      <TopBar title="Today & Tomorrow's Orders" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {overdue.length > 0 && <OrderTable title="Needs attention — not yet completed" rows={overdue} />}
        <OrderTable title="Running today" rows={today} />
        <OrderTable title="Scheduled tomorrow" rows={tomorrow} />
      </div>
    </>
  );
}

function OrderTable({ title, rows }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No orders.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Customer</th><th>Site</th><th>Grade</th><th>Ordered</th><th>Delivered</th><th>Status</th></tr>
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
    partially_completed: "badge-warning", cancelled: "badge-danger",
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
