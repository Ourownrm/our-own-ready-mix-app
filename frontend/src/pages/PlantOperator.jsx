import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function PlantOperator() {
  const [orders, setOrders] = useState([]);
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [ticketForm, setTicketForm] = useState({ order_id: "", loaded_quantity_m3: "", truck_id: "", driver_id: "" });

  async function load() {
    try {
      const [o, t, d] = await Promise.all([
        apiRequest("/plant-operator/available-orders"),
        apiRequest("/master/trucks"),
        apiRequest("/master/drivers"),
      ]);
      setOrders(o); setTrucks(t); setDrivers(d);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function submitTicket(e) {
    e.preventDefault();
    setError(""); setNotice("");
    try {
      const ticket = await apiRequest("/plant-operator/tickets", { method: "POST", body: ticketForm });
      setNotice(`Ticket ${ticket.ticket_number} created — now waiting on QC Engineer.`);
      setTicketForm({ order_id: "", loaded_quantity_m3: "", truck_id: "", driver_id: "" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const selectedOrder = orders.find((o) => String(o.id) === String(ticketForm.order_id));

  return (
    <>
      <TopBar title="Plant Operator" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Create delivery ticket</div>
          <form onSubmit={submitTicket} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Select order</div>
              <select value={ticketForm.order_id} onChange={(e) => setTicketForm({ ...ticketForm, order_id: e.target.value })} required>
                <option value="">Select</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.customer_name} &middot; {o.site_name} &middot; {o.mix_grade_name} &middot; {o.order_quantity_m3 - o.dispatched_so_far} m³ remaining
                  </option>
                ))}
              </select>
            </div>
            {selectedOrder && (
              <div style={{ fontSize: 12, color: "var(--slate)", background: "var(--concrete)", padding: 8, borderRadius: 6 }}>
                Order {selectedOrder.order_quantity_m3} m³ &middot; dispatched {selectedOrder.dispatched_so_far} m³ &middot;
                remaining {selectedOrder.order_quantity_m3 - selectedOrder.dispatched_so_far} m³
              </div>
            )}
            <div>
              <div style={{ color: "var(--slate)" }}>This ticket's quantity (m³)</div>
              <input type="number" value={ticketForm.loaded_quantity_m3} onChange={(e) => setTicketForm({ ...ticketForm, loaded_quantity_m3: e.target.value })} required />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ color: "var(--slate)" }}>Truck</div>
                <select value={ticketForm.truck_id} onChange={(e) => setTicketForm({ ...ticketForm, truck_id: e.target.value })} required>
                  <option value="">Select</option>
                  {trucks.map((t) => <option key={t.id} value={t.id}>{t.truck_number}</option>)}
                </select>
              </div>
              <div>
                <div style={{ color: "var(--slate)" }}>Driver</div>
                <select value={ticketForm.driver_id} onChange={(e) => setTicketForm({ ...ticketForm, driver_id: e.target.value })} required>
                  <option value="">Select</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </div>
            <button type="submit" style={{ marginTop: 4 }}>Save ticket</button>
          </form>
        </div>
      </div>
    </>
  );
}
