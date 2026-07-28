import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { CustomersPanel, SitesPanel, OrdersPanel, TicketsPanel, RatesPanel } from "../lib/MasterDataPanels.jsx";
import OrderDetailModal from "../lib/OrderDetailModal.jsx";
import RawMaterialStockCard from "../lib/RawMaterialStockCard.jsx";
import ComplianceAlertsCard from "../lib/ComplianceAlertsCard.jsx";
import ElapsedTimer from "../lib/ElapsedTimer.jsx";
import { BookingsQueue, CreateLeadForm } from "../lib/SalesPanels.jsx";
import CreateOrder from "./CreateOrder.jsx";

const FLEET_LABELS = {
  created: "At plant", batching: "At plant", dispatched: "Running",
  reached_site: "At site", unloading: "At site", returned: "Returning",
};

export default function ManagerDashboard() {
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [activeTrucks, setActiveTrucks] = useState([]);
  const [completedTrips, setCompletedTrips] = useState([]);
  const [liveLocations, setLiveLocations] = useState([]);
  const [onDutyDrivers, setOnDutyDrivers] = useState([]);
  const [view, setView] = useState("dashboard"); // dashboard | create-order | customers | sites
  const [error, setError] = useState("");
  const [detailOrderId, setDetailOrderId] = useState(null);

  async function load() {
    try {
      const [dashboard, orderList, trucks, trips, locations, drivers] = await Promise.all([
        apiRequest("/orders/dashboard"),
        apiRequest("/orders"),
        apiRequest("/orders/active-trucks"),
        apiRequest("/orders/completed-trips"),
        apiRequest("/orders/live-locations"),
        apiRequest("/orders/on-duty-drivers"),
      ]);
      setStats(dashboard);
      setOrders(orderList);
      setActiveTrucks(trucks);
      setCompletedTrips(trips);
      setLiveLocations(locations);
      setOnDutyDrivers(drivers);
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

  async function confirmCompletion(order) {
    if (!window.confirm(`Confirm ${order.customer_name} · ${order.site_name} is complete? This closes the order out.`)) return;
    try {
      await apiRequest(`/orders/${order.id}/confirm-completion`, { method: "POST" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function markReviewed(ticketId) {
    const response = window.prompt("Action taken or reason for allowing this truck to continue at site:");
    if (!response) return;
    setError("");
    try {
      await apiRequest(`/orders/active-trucks/${ticketId}/mark-reviewed`, { method: "POST", body: { response } });
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
  if (["customers", "sites", "correct-orders", "correct-tickets", "rates"].includes(view)) {
    return (
      <>
        <TopBar title="Manager · Records" />
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <button onClick={() => setView("dashboard")}>← Back to dashboard</button>
            <button className={`btn-tab ${view === "customers" ? "active" : ""}`} onClick={() => setView("customers")}>Customers</button>
            <button className={`btn-tab ${view === "sites" ? "active" : ""}`} onClick={() => setView("sites")}>Projects and sites</button>
            <button className={`btn-tab ${view === "correct-orders" ? "active" : ""}`} onClick={() => setView("correct-orders")}>Correct orders</button>
            <button className={`btn-tab ${view === "correct-tickets" ? "active" : ""}`} onClick={() => setView("correct-tickets")}>Correct tickets</button>
            <button className={`btn-tab ${view === "rates" ? "active" : ""}`} onClick={() => setView("rates")}>Concrete grades and rates</button>
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
          {view === "customers" && <CustomersPanel setError={setError} />}
          {view === "sites" && <SitesPanel setError={setError} />}
          {view === "correct-orders" && <OrdersPanel setError={setError} />}
          {view === "correct-tickets" && <TicketsPanel setError={setError} />}
          {view === "rates" && <RatesPanel setError={setError} />}
        </div>
      </>
    );
  }
  if (view === "leads") {
    return (
      <>
        <TopBar title="Manager · Assign a lead" />
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "0 16px 32px" }}>
          <button onClick={() => setView("dashboard")} style={{ marginBottom: 16 }}>← Back to dashboard</button>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
          <CreateLeadForm setError={setError} onDone={() => setView("dashboard")} />
        </div>
      </>
    );
  }

  const fleetCounts = { "At plant": 0, Running: 0, "At site": 0, Returning: 0 };
  stats?.fleet_status?.forEach((row) => {
    const label = FLEET_LABELS[row.status];
    if (label) fleetCounts[label] += Number(row.count);
  });

  const today = orders.filter((o) => isSameDay(o.order_date, new Date()) && !["cancelled", "closed"].includes(o.status));
  const tomorrow = orders.filter((o) => isSameDay(o.order_date, addDays(new Date(), 1)) && !["cancelled", "closed"].includes(o.status));
  const carriedForward = orders.filter((o) =>
    new Date(o.order_date) < startOfDay(new Date()) &&
    !["completed", "cancelled", "closed"].includes(o.status)
  );

  return (
    <>
      <TopBar title="Manager Dashboard" />
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={() => setView("create-order")}>Create order</button>
          <button onClick={() => setView("customers")}>Manage customers &amp; sites</button>
          <button onClick={() => setView("correct-orders")}>Correct orders</button>
          <button onClick={() => setView("correct-tickets")}>Correct tickets</button>
          <button onClick={() => setView("rates")}>Concrete grades and rates</button>
          <button onClick={() => setView("leads")}>Assign a lead</button>
          <Link to="/leads"><button type="button">Browse leads</button></Link>
          <Link to="/customer-feedback"><button type="button">Customer feedback</button></Link>
          <Link to="/breakdowns"><button type="button">Equipment breakdowns</button></Link>
          <Link to="/fuel"><button type="button">Fuel filling</button></Link>
          <Link to="/compliance"><button type="button">Statutory compliance</button></Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
          <Kpi label="Today's production" value={`${stats?.today_production_m3 ?? "–"} m³`} />
          <Kpi label="Monthly production" value={`${stats?.monthly_production_m3 ?? "–"} m³`} />
          <Kpi label="Delayed trucks" value={stats?.delayed_trucks ?? "–"} danger={stats?.delayed_trucks > 0} />
          <Kpi label="Rejected concrete — month" value={`${stats?.rejected_concrete_month_m3 ?? "–"} m³`} />
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          {Object.entries(fleetCounts).map(([label, count]) => (
            <div key={label} className="card" style={{ flex: 1, textAlign: "center" }}>
              <div className="kpi-label">{label}</div>
              <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{count}</div>
            </div>
          ))}
        </div>

        <BookingsQueue setError={setError} />
        <PumpStatusTable orders={today.concat(carriedForward)} activeTrucks={activeTrucks} setError={setError} onReload={load} />
        <ActiveTrucksTable trucks={activeTrucks} locations={liveLocations} onMarkReviewed={markReviewed} />
        <CompletedTripsTable trips={completedTrips} />

        {carriedForward.length > 0 && (
          <OrderTable
            title="Needs attention — carried forward from an earlier day"
            rows={carriedForward}
            onClose={closeOrder}
            onView={setDetailOrderId}
            onConfirmCompletion={confirmCompletion}
            setError={setError}
            onReload={load}
          />
        )}
        <OrderTable title="Running today" rows={today} onClose={closeOrder} onView={setDetailOrderId} onConfirmCompletion={confirmCompletion} setError={setError} onReload={load} />
        <OrderTable title="Scheduled tomorrow" rows={tomorrow} onClose={closeOrder} onView={setDetailOrderId} onConfirmCompletion={confirmCompletion} setError={setError} onReload={load} />

        <OnDutyDriversTable drivers={onDutyDrivers} />
        <RawMaterialStockCard />
        <ComplianceAlertsCard />
      </div>
      <OrderDetailModal orderId={detailOrderId} onClose={() => setDetailOrderId(null)} />
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

// Every driver currently on duty — tracked independent of whether they have a
// truck/ticket right now, and stays listed until they press Duty OFF. This is
// what makes a driver trackable at a small site with no formal delivery ticket.
function OnDutyDriversTable({ drivers }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>On-duty drivers</div>
      {drivers.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No drivers currently on duty.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Driver</th><th>Current trip</th><th>On duty since</th><th>Last location</th></tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.driver_id}>
                  <td>{d.driver_name}</td>
                  <td>{d.ticket_number ? `${d.ticket_number} · ${d.truck_number || ""}` : "No active ticket"}</td>
                  <td>{formatTime(d.duty_since)}</td>
                  <td>
                    {d.latitude ? (
                      <a href={`https://maps.google.com/?q=${d.latitude},${d.longitude}`} target="_blank" rel="noreferrer">
                        View location ({minutesAgo(d.recorded_at)})
                      </a>
                    ) : (
                      <span style={{ color: "var(--slate)" }}>No GPS yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActiveTrucksTable({ trucks, locations, onMarkReviewed }) {
  const locationByTicket = Object.fromEntries(locations.map((l) => [l.ticket_id, l]));
  const delayedCount = trucks.filter((t) => t.minutes_at_site > 120).length;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        Active trucks
        {delayedCount > 0 && (
          <span className="badge badge-danger" style={{ marginLeft: 8 }}>
            {delayedCount} truck{delayedCount > 1 ? "s" : ""} over 2 hrs at site
          </span>
        )}
      </div>
      {trucks.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No trucks currently running.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Truck</th><th>Driver</th><th>Customer</th><th>Loaded at</th><th>Status</th><th>GPS</th></tr>
            </thead>
            <tbody>
              {trucks.map((t) => {
                const loc = locationByTicket[t.ticket_id];
                const delayed = t.minutes_at_site > 120;
                return (
                  <tr key={t.ticket_id} style={delayed ? { background: "var(--alert-red-bg, #FBEAEA)" } : undefined}>
                    <td>{t.truck_number}</td>
                    <td>{t.driver_name}</td>
                    <td>{t.customer_name} &middot; {t.site_name}</td>
                    <td>{formatTime(t.created_at)}</td>
                    <td>
                      <StatusBadge status={t.status} />
                      {delayed && (
                        <div style={{ color: "var(--alert-red)", fontSize: 11, fontWeight: 600, marginTop: 2 }}>
                          At site {formatDuration(t.minutes_at_site)} — notify site
                        </div>
                      )}
                      {t.qc_flagged && (
                        <div style={{ marginTop: 4 }}>
                          <span className="badge badge-progress" style={{ fontSize: 10 }}>QC flagged this delivery</span>
                          <button
                            style={{ display: "block", marginTop: 4, padding: "2px 6px", fontSize: 11 }}
                            onClick={() => onMarkReviewed(t.ticket_id)}
                          >
                            Add response &amp; mark reviewed
                          </button>
                        </div>
                      )}
                      {!t.qc_flagged && t.qc_flag_response && (
                        <div style={{ marginTop: 4, fontSize: 11, color: "var(--slate)" }}>
                          <span className="badge badge-neutral" style={{ fontSize: 10 }}>QC flag reviewed</span>
                          <div>{t.qc_flag_response}</div>
                        </div>
                      )}
                    </td>
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
        </div>
      )}
    </div>
  );
}

// Every order that needs a pump today — scheduled vs actual departure time,
// live pump status, and whether the site has confirmed ready for batching.
function PumpStatusTable({ orders, activeTrucks, setError, onReload }) {
  const pumpOrders = orders.filter((o) => o.pump_requirement !== "without_pump");
  if (pumpOrders.length === 0) return null;

  function pumpStatus(order) {
    const overdue = order.pump_departure_time && !order.pump_actual_departure_time &&
      new Date(`${order.order_date?.slice(0, 10)}T${order.pump_departure_time}`) < new Date();
    // A delivery note exists for this order and the truck is actively unloading —
    // that's the pump actually pumping concrete at site right now.
    const isPumping = activeTrucks.some((t) => t.order_id === order.id && t.status === "unloading");
    if (isPumping) return { label: "Pumping", cls: "badge-progress" };
    if (order.pump_actual_departure_time) return { label: "En route", cls: "badge-info" };
    if (overdue) return { label: "Overdue", cls: "badge-danger" };
    return { label: "Not yet departed", cls: "badge-neutral" };
  }

  async function addReason(orderId) {
    const reason = window.prompt("Reason for the pump departure delay:");
    if (!reason) return;
    try {
      await apiRequest(`/orders/${orderId}/pump-delay-reason`, { method: "POST", body: { reason } });
      onReload();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Pump status</div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr><th>Customer</th><th>Site</th><th>Scheduled departure</th><th>Actual departure</th><th>Pump status</th><th>Site ready</th></tr>
          </thead>
          <tbody>
            {pumpOrders.map((o) => {
              const status = pumpStatus(o);
              return (
                <tr key={o.id} style={status.label === "Overdue" ? { background: "var(--alert-red-bg, #FBEAEA)" } : undefined}>
                  <td>{o.customer_name}</td>
                  <td>{o.site_name}</td>
                  <td>{o.pump_departure_time || "–"}</td>
                  <td>
                    {o.pump_actual_departure_time ? formatTime(o.pump_actual_departure_time) : "–"}
                    {o.pump_departure_delay_reason && (
                      <div style={{ fontSize: 11, color: "var(--slate)" }}>Delay: {o.pump_departure_delay_reason}</div>
                    )}
                    {!o.pump_departure_delay_reason && status.label === "Overdue" && (
                      <button style={{ fontSize: 10, padding: "2px 6px", marginTop: 2 }} onClick={() => addReason(o.id)}>Add reason</button>
                    )}
                  </td>
                  <td><span className={`badge ${status.cls}`}>{status.label}</span></td>
                  <td>
                    {o.site_ready_confirmed ? <span className="badge badge-success">Ready</span> : <span className="badge badge-warning">Not confirmed</span>}
                    {o.site_ready_delay_reason && (
                      <div style={{ fontSize: 11, color: "var(--slate)" }}>Delay: {o.site_ready_delay_reason}</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompletedTripsTable({ trips }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Completed trips today</div>
      {trips.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No trips completed yet today.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Truck</th><th>Driver</th><th>Customer</th><th>Qty</th><th>Status</th>
                <th>Batch time</th><th>Left plant</th><th>Reached site</th><th>Unloading start</th><th>Unloading finish</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr key={t.ticket_id}>
                  <td>{t.truck_number}</td>
                  <td>{t.driver_name}</td>
                  <td>{t.customer_name} &middot; {t.site_name}</td>
                  <td>{t.loaded_quantity_m3} m³</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>{formatTime(t.batch_time)}</td>
                  <td>{formatTime(t.left_plant_time)}</td>
                  <td>{formatTime(t.reached_site_time)}</td>
                  <td>{formatTime(t.unloading_start_time)}</td>
                  <td>{formatTime(t.unloading_finish_time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrderTable({ title, rows, onClose, onView, onConfirmCompletion, setError, onReload }) {
  function isSiteReadyOverdue(o) {
    if (o.site_ready_confirmed || !o.assigned_site_supervisor_id || !o.scheduled_batching_time) return false;
    return new Date(`${o.order_date?.slice(0, 10)}T${o.scheduled_batching_time}`) < new Date();
  }

  async function addSiteReadyReason(orderId) {
    const reason = window.prompt("Reason the site wasn't confirmed ready on time:");
    if (!reason) return;
    try {
      await apiRequest(`/orders/${orderId}/site-ready-delay-reason`, { method: "POST", body: { reason } });
      onReload();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No orders.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Customer</th><th>Site</th><th>Grade</th><th>Ordered</th><th>Delivered</th><th>Status</th><th>Site ready</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const overdue = isSiteReadyOverdue(o);
                return (
                  <tr key={o.id} style={overdue ? { background: "var(--alert-red-bg, #FBEAEA)" } : undefined}>
                    <td>{o.customer_name}</td>
                    <td>{o.site_name}</td>
                    <td>{o.mix_grade_name}</td>
                    <td>{o.order_quantity_m3} m³</td>
                    <td>{o.delivered_qty_m3} m³</td>
                    <td>
                      <StatusBadge status={o.status} />
                      {o.supervisor_marked_complete && !["completed", "closed", "cancelled"].includes(o.status) && (
                        <div style={{ marginTop: 4 }}>
                          <span className="badge badge-warning" style={{ fontSize: 10 }}>Site marked complete</span>
                          {o.work_completion_remarks && <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>"{o.work_completion_remarks}"</div>}
                          <button style={{ display: "block", marginTop: 4, padding: "3px 8px", fontSize: 11 }} onClick={() => onConfirmCompletion(o)}>
                            Confirm completion
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {!o.assigned_site_supervisor_id ? (
                        <span style={{ color: "var(--slate)", fontSize: 12 }}>No supervisor</span>
                      ) : o.site_ready_confirmed ? (
                        o.first_ticket_created_at ? (
                          <span className="badge badge-success">Ready</span>
                        ) : (
                          <>
                            <span className="badge badge-success" style={{ marginBottom: 2, display: "inline-block" }}>Ready</span>
                            <ElapsedTimer since={o.site_ready_confirmed_at} alertAfterMinutes={12} label="Waiting for DN" />
                          </>
                        )
                      ) : (
                        <>
                          <span className={`badge ${overdue ? "badge-danger" : "badge-warning"}`}>{overdue ? "Overdue" : "Not confirmed"}</span>
                          {o.site_ready_delay_reason && <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>Delay: {o.site_ready_delay_reason}</div>}
                          {overdue && !o.site_ready_delay_reason && (
                            <button style={{ display: "block", marginTop: 2, padding: "2px 6px", fontSize: 10 }} onClick={() => addSiteReadyReason(o.id)}>Add reason</button>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <button style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => onView(o.id)}>View details</button>
                    </td>
                    <td>
                      {!["closed", "cancelled", "completed"].includes(o.status) && (
                        <button className="btn-danger" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => onClose(o)}>
                          Close order
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    completed: "badge-success", planned: "badge-neutral", in_progress: "badge-info",
    partially_completed: "badge-info", cancelled: "badge-danger", closed: "badge-neutral", dispatched: "badge-info",
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
function minutesAgo(isoTime) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(isoTime).getTime()) / 60000));
  return mins < 1 ? "just now" : `${mins} min ago`;
}
function formatTime(isoTime) {
  if (!isoTime) return "–";
  return new Date(isoTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
