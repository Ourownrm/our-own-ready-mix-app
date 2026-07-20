import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import OrderDetailModal from "../lib/OrderDetailModal.jsx";

export default function OrdersSchedule() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [detailOrderId, setDetailOrderId] = useState(null);
  const { user } = useAuth();
  const canClose = user?.role === "manager" || user?.role === "administrator";

  async function load() {
    try {
      setOrders(await apiRequest("/orders"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function closeOrder(order) {
    const reason = window.prompt(
      `Close order for ${order.customer_name} · ${order.site_name}?\n` +
      `This marks it as never-to-be-completed and removes it from the running lists.\n\n` +
      `Reason (optional):`
    );
    if (reason === null) return; // cancelled the prompt
    try {
      await apiRequest(`/orders/${order.id}/close`, { method: "POST", body: { reason } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

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

        {overdue.length > 0 && (
          <OrderTable
            title="Needs attention — carried forward, not yet completed"
            rows={overdue}
            canClose={canClose}
            onClose={closeOrder}
            onView={setDetailOrderId}
          />
        )}
        <OrderTable title="Running today" rows={today} canClose={canClose} onClose={closeOrder} onView={setDetailOrderId} />
        <OrderTable title="Scheduled tomorrow" rows={tomorrow} canClose={canClose} onClose={closeOrder} onView={setDetailOrderId} />
      </div>
      <OrderDetailModal orderId={detailOrderId} onClose={() => setDetailOrderId(null)} />
    </>
  );
}

function OrderTable({ title, rows, canClose, onClose, onView }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No orders.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Customer</th><th>Site</th><th>Grade</th><th>Ordered</th><th>Delivered</th><th>Status</th>
              <th></th>
              {canClose && <th></th>}
            </tr>
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
                  <button style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => onView(o.id)}>View details</button>
                </td>
                {canClose && (
                  <td>
                    <button className="btn-danger" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => onClose(o)}>
                      Close order
                    </button>
                  </td>
                )}
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
    completed: "badge-success", planned: "badge-neutral", in_progress: "badge-info",
    partially_completed: "badge-info", cancelled: "badge-danger", dispatched: "badge-info",
    reached_site: "badge-warning", unloading: "badge-progress", created: "badge-neutral",
    batching: "badge-neutral", returned: "badge-neutral", rejected: "badge-danger",
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
