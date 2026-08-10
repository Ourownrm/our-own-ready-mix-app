import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount, failedCount, clearFailed, startPeriodicFlush, flushQueue } from "../lib/offlineQueue.js";
import ElapsedTimer from "../lib/ElapsedTimer.jsx";

function newIdempotencyKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function PlantOperator() {
  const [orders, setOrders] = useState([]);
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [pending, setPending] = useState(pendingCount());
  const [failed, setFailed] = useState(failedCount());
  const [driverOpenTrips, setDriverOpenTrips] = useState([]);

  const [ticketForm, setTicketForm] = useState({ order_id: "", loaded_quantity_m3: "", truck_id: "", driver_id: "", idempotency_key: newIdempotencyKey() });

  useEffect(() => {
    if (!ticketForm.driver_id) { setDriverOpenTrips([]); return; }
    apiRequest(`/plant-operator/driver-open-trips?driver_id=${ticketForm.driver_id}`)
      .then(setDriverOpenTrips)
      .catch(() => {});
  }, [ticketForm.driver_id]);

  async function load() {
    try {
      const [o, t, d, p] = await Promise.all([
        apiRequest("/plant-operator/available-orders"),
        apiRequest("/master/trucks"),
        apiRequest("/master/drivers"),
        apiRequest("/master/pumps"),
      ]);
      setOrders(o); setTrucks(t); setDrivers(d); setPumps(p);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    // Same fix as Driver's and Site Supervisor's screens: catches actions
    // that got queued at a weak-signal moment and never actually synced —
    // the 'online' event alone doesn't cover reopening the app when it's
    // already connected.
    const flushInterval = startPeriodicFlush();
    const refreshAfterFlush = setInterval(() => { load(); setPending(pendingCount()); setFailed(failedCount()); }, 30000);
    return () => { clearInterval(interval); clearInterval(flushInterval); clearInterval(refreshAfterFlush); };
  }, []);

  async function submitTicket(e) {
    e.preventDefault();
    setError(""); setNotice("");
    try {
      const result = await queuedRequest("/plant-operator/tickets", { method: "POST", body: ticketForm });
      setPending(pendingCount());
      if (result?.queued) {
        setNotice("No signal right now — this delivery note is saved and will be created automatically once you're back online. Don't re-enter it.");
      } else {
        setNotice(`Ticket ${result.ticket_number} created — now waiting on QC Engineer.`);
      }
      setTicketForm({ order_id: "", loaded_quantity_m3: "", truck_id: "", driver_id: "", idempotency_key: newIdempotencyKey() });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const selectedOrder = orders.find((o) => String(o.id) === String(ticketForm.order_id));

  if (showBreakdown) {
    return (
      <BreakdownForm
        pumps={pumps}
        onDone={(msg) => { setShowBreakdown(false); setNotice(msg); }}
        onCancel={() => setShowBreakdown(false)}
      />
    );
  }

  return (
    <>
      <TopBar title="Plant Operator" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}
        {failed > 0 && (
          <div style={{ textAlign: "center", fontSize: 12, color: "var(--alert-red)", background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", borderRadius: 8, padding: 10, marginBottom: 12 }}>
            {failed} delivery note(s) couldn't be saved — this wasn't a signal problem, something about the entry itself needs fixing. Please re-enter manually.
            <button
              style={{ display: "block", margin: "6px auto 0", fontSize: 11, padding: "4px 10px" }}
              onClick={() => { clearFailed(); setFailed(failedCount()); }}
            >
              Dismiss
            </button>
          </div>
        )}
        {pending > 0 && (
          <div style={{ textAlign: "center", fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
            {pending} delivery note(s) waiting to sync
            <button
              style={{ display: "block", margin: "6px auto 0", fontSize: 11, padding: "4px 10px" }}
              onClick={async () => { await flushQueue(); setPending(pendingCount()); setFailed(failedCount()); load(); }}
            >
              Sync now
            </button>
          </div>
        )}

        {orders.filter((o) => o.site_ready_confirmed_at && !o.first_ticket_created_at).map((o) => (
          <div key={o.id} style={{ marginBottom: 12 }}>
            <ElapsedTimer since={o.site_ready_confirmed_at} alertAfterMinutes={12} big label={`${o.customer_name} — site ready, waiting for first DN`} />
          </div>
        ))}

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Create delivery ticket</div>
          <form onSubmit={submitTicket} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Select order</div>
              <select value={ticketForm.order_id} onChange={(e) => setTicketForm({ ...ticketForm, order_id: e.target.value })} required>
                <option value="">Select</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.customer_name} &middot; {o.site_name} &middot; {o.mix_grade_name} &middot; {o.scheduled_batching_time?.slice(0, 5)} &middot; {o.order_quantity_m3 - o.dispatched_so_far} m³ remaining
                    {o.blocked_site_not_ready ? " — site not confirmed ready yet" : ""}
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
            {selectedOrder?.blocked_site_not_ready && (
              <div style={{ fontSize: 12, color: "var(--alert-red)", background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", padding: 8, borderRadius: 6 }}>
                Site Supervisor hasn't confirmed this specific order's site is ready yet — can't start batching.
                If another order for the same customer and site is confirmed, this is still a separate order.
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
            {driverOpenTrips.length > 0 && (
              <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--alert-red)", background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", borderRadius: 6, padding: "8px 10px", marginTop: 4 }}>
                This driver still has {driverOpenTrips.length} open trip{driverOpenTrips.length > 1 ? "s" : ""} not yet confirmed:{" "}
                {driverOpenTrips.map((t) => t.ticket_number).join(", ")}. Assigning a new one is fine if the earlier one is genuinely done — it just hasn't been confirmed yet — but worth a quick check first.
              </div>
            )}
            <button type="submit" style={{ marginTop: 4 }}>Save ticket</button>
          </form>
        </div>

        <button style={{ width: "100%", marginTop: 16 }} className="btn-danger" onClick={() => { setError(""); setNotice(""); setShowBreakdown(true); }}>
          Report pump / plant breakdown
        </button>
      </div>
    </>
  );
}

function BreakdownForm({ pumps, onDone, onCancel }) {
  const [equipmentType, setEquipmentType] = useState("pump");
  const [pumpId, setPumpId] = useState("");
  const [equipmentLabel, setEquipmentLabel] = useState("Batching plant");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/breakdowns", {
        method: "POST",
        body: {
          equipment_type: equipmentType,
          pump_id: equipmentType === "pump" ? pumpId : undefined,
          equipment_label: equipmentType === "plant" ? equipmentLabel : undefined,
          remarks,
        },
      });
      onDone("Breakdown reported. The manager has been notified.");
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Plant Operator · Report breakdown" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Report breakdown</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Equipment</div>
              <select value={equipmentType} onChange={(e) => setEquipmentType(e.target.value)}>
                <option value="pump">Pump</option>
                <option value="plant">Batching plant</option>
              </select>
            </div>
            {equipmentType === "pump" ? (
              <div>
                <div style={{ color: "var(--slate)" }}>Which pump</div>
                <select value={pumpId} onChange={(e) => setPumpId(e.target.value)} required>
                  <option value="">Select</option>
                  {pumps.map((p) => <option key={p.id} value={p.id}>{p.pump_code}</option>)}
                </select>
              </div>
            ) : (
              <div>
                <div style={{ color: "var(--slate)" }}>Which unit</div>
                <input type="text" value={equipmentLabel} onChange={(e) => setEquipmentLabel(e.target.value)} />
              </div>
            )}
            <div>
              <div style={{ color: "var(--slate)" }}>What happened</div>
              <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} required />
            </div>
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={saving}>{saving ? "Saving..." : "Submit"}</button>
              <button type="button" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
