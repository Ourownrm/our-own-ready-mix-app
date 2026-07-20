import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export default function OrderDetailModal({ orderId, onClose }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!orderId) return;
    apiRequest(`/orders/${orderId}`).then(setOrder).catch((err) => setError(err.message));
  }, [orderId]);

  if (!orderId) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(34,38,43,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 480, width: "100%", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Order details</div>
          <button onClick={onClose} style={{ padding: "4px 10px" }}>Close</button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
        {!order && !error && <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>}

        {order && (
          <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 6 }}>
            <Row label="Customer" value={order.customer_name} />
            <Row label="Site" value={order.site_name} />
            {order.site_address && <Row label="Site address" value={order.site_address} />}
            <Row label="Mix grade" value={order.mix_grade_name} />
            <Row label="Order quantity" value={`${order.order_quantity_m3} m³`} />
            <Row label="Delivered so far" value={`${order.delivered_qty_m3} m³`} />
            <Row label="Order date" value={order.order_date?.slice(0, 10)} />
            <Row label="Scheduled batching time" value={order.scheduled_batching_time} />
            <Row label="Truck dispatch interval" value={order.truck_dispatch_interval_minutes ? `${order.truck_dispatch_interval_minutes} min` : "–"} />
            <Row label="Pump requirement" value={order.pump_requirement?.replace(/_/g, " ")} />
            {order.pump_code && <Row label="Pump assigned" value={order.pump_code} />}
            {order.pump_departure_time && <Row label="Pump crew departure time" value={order.pump_departure_time} />}
            <Row label="Site technician required" value={order.site_technician_required ? "Yes" : "No"} />
            <Row label="Cube samples required" value={order.cube_samples_required ? "Yes" : "No"} />
            <Row label="Assigned pump crew" value={order.assigned_pump_crew || "–"} />
            <Row label="Site supervisor" value={order.site_supervisor_name || "None assigned"} />
            <Row label="Site contact number" value={order.site_contact_number} />
            <Row label="Sales representative" value={order.sales_representative_name || "–"} />
            <Row label="Casting location" value={order.casting_location || "–"} />
            <Row label="Status" value={order.status?.replace(/_/g, " ")} />
            {order.closure_reason && <Row label="Closure reason" value={order.closure_reason} />}
            <Row label="Remarks" value={order.remarks || "–"} />
            <Row label="Created by" value={order.created_by_name || "–"} />
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
      <span style={{ color: "var(--slate)" }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: "right" }}>{value}</span>
    </div>
  );
}
