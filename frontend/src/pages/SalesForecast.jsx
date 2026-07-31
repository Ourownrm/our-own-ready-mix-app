import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";

const CONFIDENCE_LABEL = { confirmed: "Confirmed", likely: "Likely", tentative: "Tentative" };
const CONFIDENCE_COLOR = { confirmed: "badge-success", likely: "badge-info", tentative: "badge-neutral" };

export default function SalesForecast() {
  const { user } = useAuth();
  const isSalesExec = user?.role === "sales_executive";

  const [forecasts, setForecasts] = useState([]);
  const [runningOrders, setRunningOrders] = useState([]);
  const [projects, setProjects] = useState([]); // manager/admin: every running project + forecast status
  const [salespersons, setSalespersons] = useState([]);
  const [summary, setSummary] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [assigningOrderId, setAssigningOrderId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      if (isSalesExec) {
        const [f, ro, pr] = await Promise.all([
          apiRequest("/sales/forecasts"),
          apiRequest("/sales/my-running-orders"),
          apiRequest("/sales/forecast-update-requests"),
        ]);
        setForecasts(f); setRunningOrders(ro); setPendingRequests(pr);
      } else {
        const [proj, sum, sp] = await Promise.all([
          apiRequest("/sales/running-projects-with-forecast-status"),
          apiRequest("/sales/forecasts/summary"),
          apiRequest("/master/salespersons"),
        ]);
        setProjects(proj); setSummary(sum); setSalespersons(sp);
      }
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function requestUpdate(orderId, customerName) {
    const message = window.prompt(`Ask for a forecast update on ${customerName}? Optional note to include:`);
    if (message === null) return;
    setError("");
    try {
      await apiRequest("/sales/forecasts/request-update", { method: "POST", body: { order_id: orderId, message } });
      setNotice("Request sent.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function assignSalesperson(orderId, salespersonId) {
    if (!salespersonId) return;
    setError("");
    try {
      await apiRequest(`/sales/orders/${orderId}/assign-salesperson`, { method: "POST", body: { salesperson_id: salespersonId } });
      setAssigningOrderId(null);
      setNotice("Salesperson assigned.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <TopBar title="Sales Forecast" />
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 12 }}>{notice}</div>}

        {isSalesExec && pendingRequests.length > 0 && (
          <div className="card" style={{ marginBottom: 16, borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Your manager is asking for an update</div>
            {pendingRequests.map((r) => (
              <div key={r.id} style={{ fontSize: 13, marginBottom: 4 }}>{r.message}</div>
            ))}
          </div>
        )}

        {isSalesExec && (
          <>
            <button onClick={() => setShowForm(!showForm)} style={{ marginBottom: 16 }}>
              {showForm ? "Hide" : "+ Add / update forecast"}
            </button>
            {showForm && (
              <ForecastForm
                runningOrders={runningOrders}
                setError={setError}
                onDone={() => { setNotice("Forecast saved."); setShowForm(false); load(); }}
              />
            )}
          </>
        )}

        {!isSalesExec && summary.length > 0 && <ForecastChart summary={summary} />}

        {isSalesExec ? (
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Your forecasts</div>
            {forecasts.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing forecasted yet.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 13 }}>
                  <thead>
                    <tr><th>Project</th><th>Expected qty</th><th>Window</th><th>Confidence</th><th>Notes</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {forecasts.map((f) => (
                      <tr key={f.id}>
                        <td>{f.customer_name} &middot; {f.site_name}</td>
                        <td>{f.expected_qty_m3} m³</td>
                        <td>Next {f.period_days}d (to {new Date(f.period_end_date).toLocaleDateString([], { day: "2-digit", month: "short" })})</td>
                        <td><span className={`badge ${CONFIDENCE_COLOR[f.confidence]}`}>{CONFIDENCE_LABEL[f.confidence] || f.confidence}</span></td>
                        <td>{f.notes || "–"}</td>
                        <td>{f.is_expired ? <span className="badge badge-warning">Expired — needs refresh</span> : <span className="badge badge-success">Current</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Running projects</div>
            {projects.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--slate)" }}>No running projects with a sales person assigned.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 13 }}>
                  <thead>
                    <tr><th>Project</th><th>Sales person</th><th>Expected qty</th><th>Confidence</th><th>Status</th><th></th></tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr key={p.order_id}>
                        <td>{p.customer_name} &middot; {p.site_name}</td>
                        <td>{p.salesperson_name || <span style={{ color: "var(--slate)" }}>Unassigned</span>}</td>
                        <td>{p.has_forecast ? `${p.expected_qty_m3} m³ / ${p.period_days}d` : "–"}</td>
                        <td>{p.has_forecast ? <span className={`badge ${CONFIDENCE_COLOR[p.confidence]}`}>{CONFIDENCE_LABEL[p.confidence] || p.confidence}</span> : "–"}</td>
                        <td>
                          {!p.has_forecast ? (
                            <span className="badge badge-neutral">No forecast yet</span>
                          ) : p.is_expired ? (
                            <span className="badge badge-warning">Expired</span>
                          ) : (
                            <span className="badge badge-success">Current</span>
                          )}
                        </td>
                        <td>
                          {!p.salesperson_name ? (
                            assigningOrderId === p.order_id ? (
                              <select autoFocus onChange={(e) => assignSalesperson(p.order_id, e.target.value)} onBlur={() => setAssigningOrderId(null)}>
                                <option value="">Select salesperson</option>
                                {salespersons.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                              </select>
                            ) : (
                              <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setAssigningOrderId(p.order_id)}>
                                Assign salesperson
                              </button>
                            )
                          ) : (
                            <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => requestUpdate(p.order_id, p.customer_name)}>
                              Ask for update
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function ForecastForm({ runningOrders, setError, onDone }) {
  const [orderId, setOrderId] = useState("");
  const [qty, setQty] = useState("");
  const [days, setDays] = useState("");
  const [confidence, setConfidence] = useState("likely");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/sales/forecasts", {
        method: "POST",
        body: { order_id: orderId, expected_qty_m3: qty, period_days: days, confidence, notes },
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginBottom: 16 }}>
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{ color: "var(--slate)" }}>Running project</div>
        <select value={orderId} onChange={(e) => setOrderId(e.target.value)} required>
          <option value="">Select</option>
          {runningOrders.map((o) => <option key={o.id} value={o.id}>{o.customer_name} — {o.site_name}</option>)}
        </select>
      </div>
      <div><div style={{ color: "var(--slate)" }}>Expected qty (m³)</div><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} required /></div>
      <div><div style={{ color: "var(--slate)" }}>Over next (days)</div><input type="number" value={days} onChange={(e) => setDays(e.target.value)} required /></div>
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{ color: "var(--slate)" }}>Confidence</div>
        <select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
          <option value="confirmed">Confirmed — customer committed</option>
          <option value="likely">Likely — based on site progress</option>
          <option value="tentative">Tentative — early estimate</option>
        </select>
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{ color: "var(--slate)" }}>Notes (optional)</div>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. slab pour expected first week of August" />
      </div>
      <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)" }}>
        If this project already has a forecast, saving here updates it and refreshes the window to start from today — this is also how you refresh an expired one.
      </div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Save forecast"}</button></div>
    </form>
  );
}

function ForecastChart({ summary }) {
  const byConfidence = Object.fromEntries(summary.map((s) => [s.confidence, s]));
  const order = ["confirmed", "likely", "tentative"];
  const colors = { confirmed: "#2a78d6", likely: "#78a8e0", tentative: "#c3d8f0" };

  const weeks = [
    { label: "This week", key: "this_week" },
    { label: "Next week", key: "next_week" },
  ];
  const totals = weeks.map((w) => order.reduce((sum, c) => sum + Number(byConfidence[c]?.[w.key] || 0), 0));
  const max = Math.max(1, ...totals);
  const chartHeight = 140;
  const barWidth = 90;
  const gap = 40;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Expected demand — next two weeks</div>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 11 }}>
        {order.map((c) => (
          <span key={c} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: colors[c], display: "inline-block" }} />
            {CONFIDENCE_LABEL[c]}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${weeks.length * (barWidth + gap)} ${chartHeight + 30}`} style={{ width: "100%", maxWidth: 400, height: "auto" }}>
        {weeks.map((w, i) => {
          let yOffset = chartHeight;
          const x = i * (barWidth + gap) + gap / 2;
          const segments = order.map((c) => {
            const val = Number(byConfidence[c]?.[w.key] || 0);
            const h = (val / max) * (chartHeight - 20);
            yOffset -= h;
            return { c, val, y: yOffset, h };
          });
          const total = segments.reduce((s, seg) => s + seg.val, 0);
          return (
            <g key={w.key}>
              {segments.map((seg) => seg.h > 0 && (
                <rect key={seg.c} x={x} y={seg.y} width={barWidth} height={seg.h} fill={colors[seg.c]} />
              ))}
              <text x={x + barWidth / 2} y={chartHeight - (segments.reduce((s, seg) => s + seg.h, 0)) - 6} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--ink, #1a1a1a)">
                {total} m³
              </text>
              <text x={x + barWidth / 2} y={chartHeight + 18} textAnchor="middle" fontSize="11" fill="var(--slate, #767671)">
                {w.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
