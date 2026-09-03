import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

// Round 134, item 8 — 360-degree fuel analysis. Real data, pulled live from
// the backend (GET /fuel-analysis/fleet and /fuel-analysis/truck/:id — see
// that route file's own comments for exactly how each number is derived).
// Two views in one page: a ranked fleet overview that surfaces which trucks
// are burning more fuel per km than the rest, and a per-truck drill-down
// that lays out the factors the business asked to analyze — trips, distance,
// quantity carried, pump vs no-pump, waiting/unloading/travel time, and
// driver — next to the truck's real fill-to-fill consumption.
//
// Fuel source note (shown in the footnote below): fills come from
// supply_requests (request -> approve -> issue), not the older fuel_logs
// table, which has no live caller anywhere in the app.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function fmtDateShort(d) {
  return d ? new Date(d).toLocaleDateString([], { day: "2-digit", month: "short" }) : "—";
}
function fmtMin(m) {
  return m == null ? "—" : `${m} min`;
}
function num(v, digits = 0) {
  return v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
}

// A truck's rate relative to the fleet average — the "is this an outlier"
// judgment call, reused by both the bar chart and the summary table so the
// two never disagree about which trucks are flagged.
function rateStatus(rate, fleetAvg) {
  if (rate == null || fleetAvg == null) return { key: "neutral", label: "No data" };
  const pctOver = (rate - fleetAvg) / fleetAvg;
  if (pctOver > 0.12) return { key: "danger", label: "High consumption" };
  if (pctOver > 0.03) return { key: "warning", label: "Above average" };
  if (pctOver < -0.1) return { key: "success", label: "Efficient" };
  return { key: "neutral", label: "Near average" };
}
const STATUS_COLOR = {
  danger: "var(--alert-red)",
  warning: "var(--amber)",
  success: "var(--signal-green)",
  neutral: "var(--slate)",
};
const STATUS_BADGE = {
  danger: "badge-danger",
  warning: "badge-warning",
  success: "badge-success",
  neutral: "badge-neutral",
};

// Round 137, item 1a — L/m³ is now the main ranking metric (was L/100km):
// distance-independent, so it isolates genuine fuel-efficiency differences
// between trucks rather than mixing in how far each truck's routes happened
// to be this range. Kept generic on a `metricKey`/`unit` pair so the same
// component still works if a metric is ever swapped again.
function FleetBarChart({ trucks, fleetAvg, onPick, metricKey = "litres_per_m3", unit = "L/m³", digits = 2 }) {
  const withRate = trucks.filter((t) => t[metricKey] != null);
  if (withRate.length === 0) {
    return <div style={{ fontSize: 13, color: "var(--slate)" }}>No trucks have both fuel fills and delivered quantity in this range yet.</div>;
  }
  const sorted = [...withRate].sort((a, b) => b[metricKey] - a[metricKey]);
  const max = Math.max(...sorted.map((t) => Number(t[metricKey])), fleetAvg || 0) * 1.08;
  const w = 700, barH = 26, gap = 9, leftPad = 118, rightPad = 78, chartW = w - leftPad - rightPad;
  const h = sorted.length * (barH + gap) + gap;
  const avgX = fleetAvg != null ? leftPad + (fleetAvg / max) * chartW : null;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto" }}>
      {avgX != null && (
        <>
          <line x1={avgX} y1={2} x2={avgX} y2={h - 2} stroke="var(--border-strong)" strokeWidth="1.5" strokeDasharray="3,3" />
          <text x={avgX} y={11} textAnchor="middle" fontSize="10" fill="var(--slate)">fleet avg</text>
        </>
      )}
      {sorted.map((t, i) => {
        const y = gap + i * (barH + gap);
        const rate = Number(t[metricKey]);
        const barW = Math.max((rate / max) * chartW, 2);
        const status = rateStatus(rate, fleetAvg);
        return (
          <g key={t.truck_id} style={{ cursor: "pointer" }} onClick={() => onPick(t)}>
            <text x={leftPad - 8} y={y + barH / 2 + 4} textAnchor="end" fontSize="11" fill="var(--charcoal)" fontWeight="600">{t.truck_number}</text>
            <rect x={leftPad} y={y} width={chartW} height={barH} rx="4" fill="var(--concrete)" />
            <rect x={leftPad} y={y} width={barW} height={barH} rx="4" fill={STATUS_COLOR[status.key]} />
            <text x={leftPad + barW + 6} y={y + barH / 2 + 4} fontSize="11" fill="var(--charcoal)" fontWeight="600">{rate.toFixed(digits)} {unit}</text>
          </g>
        );
      })}
    </svg>
  );
}

function IntervalTrend({ intervals }) {
  const pts = intervals.filter((f) => f.litres_per_100km != null);
  if (pts.length === 0) return <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Need at least two fills in range to compute a fill-to-fill trend.</div>;
  const w = 640, h = 160, padL = 44, padR = 16, padT = 16, padB = 26;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const values = pts.map((p) => Number(p.litres_per_100km));
  const min = Math.min(...values, 0);
  const max = Math.max(...values) * 1.15 || 1;
  const x = (i) => padL + (pts.length === 1 ? chartW / 2 : (i / (pts.length - 1)) * chartW);
  const y = (v) => padT + chartH - ((v - min) / (max - min || 1)) * chartH;
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(Number(p.litres_per_100km))}`).join(" ");
  const areaPath = `${linePath} L ${x(pts.length - 1)} ${padT + chartH} L ${x(0)} ${padT + chartH} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto" }}>
      <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="var(--border)" />
      <line x1={padL} y1={padT + chartH} x2={w - padR} y2={padT + chartH} stroke="var(--border)" />
      <path d={areaPath} fill="var(--rebar)" fillOpacity="0.08" />
      <path d={linePath} fill="none" stroke="var(--rebar)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <g key={p.id}>
          <circle cx={x(i)} cy={y(Number(p.litres_per_100km))} r="4" fill="var(--surface)" stroke="var(--rebar)" strokeWidth="2" />
          <text x={x(i)} y={padT + chartH + 18} textAnchor="middle" fontSize="9.5" fill="var(--slate)">{fmtDateShort(p.issued_at)}</text>
        </g>
      ))}
      <text x={6} y={padT + 4} fontSize="9.5" fill="var(--slate)">{max.toFixed(0)}</text>
      <text x={6} y={padT + chartH} fontSize="9.5" fill="var(--slate)">{min.toFixed(0)}</text>
    </svg>
  );
}

function TruckDrilldown({ truckId, fromDate, toDate, fleetAvg, fleetAvgM3, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true); setError(""); setData(null);
    const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
    apiRequest(`/fuel-analysis/truck/${truckId}?${params.toString()}`)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [truckId, fromDate, toDate]);

  if (loading) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading truck detail...</div>;
  if (error) return <div className="card" style={{ fontSize: 13, color: "var(--alert-red)" }}>{error}</div>;
  if (!data) return null;

  const withRate = data.fill_intervals.filter((f) => f.litres_per_100km != null);
  const overallRate = data.truck && data.fill_intervals.length
    ? (() => {
        const totalL = withRate.reduce((s, f) => s + Number(f.actual_quantity_issued), 0);
        const totalKm = withRate.reduce((s, f) => s + Number(f.interval_km), 0);
        return totalKm > 0 ? (totalL / totalKm) * 100 : null;
      })()
    : null;
  const withPumpTrips = data.trips.filter((t) => t.discharge_mode === "With pump");
  const pumpPct = data.trips.length ? Math.round((withPumpTrips.length / data.trips.length) * 100) : null;
  // Round 137, item 1a/1b — L/m³ and cost/m³ are now the lead figures: total
  // litres fuelled / total cost, both over total concrete carried in range.
  // Distance-independent (unlike L/100km, no paired-odometer requirement),
  // so both use every litre/rupee and every trip in the window.
  const totalLitresAll = data.fill_intervals.reduce((s, f) => s + Number(f.actual_quantity_issued), 0);
  const totalCostAll = data.fill_intervals.reduce((s, f) => s + Number(f.fuel_cost || 0), 0);
  const totalQtyM3 = data.trips.reduce((s, t) => s + Number(t.loaded_quantity_m3 || 0), 0);
  const litresPerM3 = totalQtyM3 > 0 ? totalLitresAll / totalQtyM3 : null;
  const costPerM3 = totalQtyM3 > 0 ? totalCostAll / totalQtyM3 : null;
  const m3Status = rateStatus(litresPerM3, fleetAvgM3);
  const status = rateStatus(overallRate, fleetAvg); // L/100km — now the secondary/supporting figure

  return (
    <div>
      <button onClick={onBack} style={{ fontSize: 12, marginBottom: 14 }}>← Back to fleet overview</button>

      <div className="card" style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{data.truck.truck_number}</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>{data.truck.capacity_m3 ? `${data.truck.capacity_m3} m³ drum` : "Drum size not set"}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 20, flexWrap: "wrap" }}>
          <div>
            <div className="kpi-label">L / m³ (main)</div>
            <div className="kpi-value" style={{ color: STATUS_COLOR[m3Status.key] }}>{litresPerM3 != null ? litresPerM3.toFixed(2) : "—"}</div>
            <span className={`badge ${STATUS_BADGE[m3Status.key]}`} style={{ marginTop: 2 }}>{m3Status.label}</span>
          </div>
          <div>
            <div className="kpi-label">Cost / m³</div>
            <div className="kpi-value">{costPerM3 != null ? `₹${costPerM3.toFixed(0)}` : "—"}</div>
          </div>
          <div>
            <div className="kpi-label">L / 100km</div>
            <div className="kpi-value" style={{ fontSize: 16 }}>{overallRate != null ? overallRate.toFixed(1) : "—"}</div>
          </div>
          <div>
            <div className="kpi-label">Total litres</div>
            <div className="kpi-value">{num(totalLitresAll)}</div>
          </div>
          <div>
            <div className="kpi-label">Total cost</div>
            <div className="kpi-value">₹{num(totalCostAll)}</div>
          </div>
          <div>
            <div className="kpi-label">Trips</div>
            <div className="kpi-value">{data.trips.length}</div>
          </div>
        </div>
      </div>

      {fleetAvgM3 != null && litresPerM3 != null && (
        <div className="open-q" style={{ marginBottom: 16 }}>
          This truck runs at <b>{litresPerM3.toFixed(2)} L/m³</b> against a fleet average of <b>{fleetAvgM3.toFixed(2)} L/m³</b> ({litresPerM3 > fleetAvgM3 ? "+" : ""}{(((litresPerM3 - fleetAvgM3) / fleetAvgM3) * 100).toFixed(0)}%){costPerM3 != null ? <> at <b>₹{costPerM3.toFixed(0)}/m³</b></> : ""}.
          {fleetAvg != null && overallRate != null && <> On a distance basis it's running <b>{overallRate.toFixed(1)} L/100km</b> against a fleet average of <b>{fleetAvg.toFixed(1)} L/100km</b>.</>}
          {pumpPct != null && <> Used a pump on <b>{pumpPct}%</b> of its trips in this range — pump discharge is faster and typically burns less fuel per trip than manual/chute discharge.</>}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Fill-to-fill consumption trend</div>
        <IntervalTrend intervals={data.fill_intervals} />
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ fontSize: 12 }}>
            <thead><tr><th>Date</th><th>Station</th><th>Litres</th><th>Cost</th><th>Distance since last fill</th><th>L/100km</th></tr></thead>
            <tbody>
              {data.fill_intervals.map((f) => (
                <tr key={f.id}>
                  <td>{fmtDateShort(f.issued_at)}</td>
                  <td><span className={`badge ${f.is_plant ? "badge-info" : "badge-neutral"}`}>{f.is_plant ? "Plant" : "Outside pump"}</span> {f.station_name}</td>
                  <td>{num(f.actual_quantity_issued)} L</td>
                  <td>₹{num(f.fuel_cost)}</td>
                  <td>{f.interval_km != null ? `${num(f.interval_km)} km` : "—"}</td>
                  <td>{f.litres_per_100km != null ? f.litres_per_100km : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 8 }}>L/100km is computed between consecutive fills using the odometer reading recorded at each fill — the first fill in range has no prior reading to compare against.</div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Trips behind this truck's activity</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 12 }}>
            <thead><tr><th>Date</th><th>Driver</th><th>Discharge</th><th>Round trip</th><th>Qty</th><th>Travel</th><th>Waiting</th><th>Unloading</th></tr></thead>
            <tbody>
              {data.trips.map((t) => (
                <tr key={t.ticket_id}>
                  <td>{fmtDateShort(t.ticket_date)}</td>
                  <td>{t.driver_name || "—"}</td>
                  <td><span className={`badge ${t.discharge_mode === "With pump" ? "badge-info" : "badge-neutral"}`}>{t.discharge_mode}</span></td>
                  <td>{t.round_trip_km != null ? `${num(t.round_trip_km)} km` : "—"}</td>
                  <td>{num(t.loaded_quantity_m3, 1)} m³</td>
                  <td>{fmtMin(t.travel_minutes)}</td>
                  <td>{fmtMin(t.waiting_minutes)}</td>
                  <td>{fmtMin(t.unloading_minutes)}</td>
                </tr>
              ))}
              {data.trips.length === 0 && <tr><td colSpan={8} style={{ color: "var(--slate)" }}>No trips in this date range.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>By driver</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 12 }}>
            <thead><tr><th>Driver</th><th>Trips</th><th>With pump</th><th>Avg travel</th><th>Avg waiting</th><th>Avg unloading</th></tr></thead>
            <tbody>
              {data.drivers.map((d) => (
                <tr key={d.driver_id ?? "unassigned"}>
                  <td>{d.driver_name || "Unassigned"}</td>
                  <td>{d.trip_count}</td>
                  <td>{d.with_pump_trips} / {Number(d.with_pump_trips) + Number(d.without_pump_trips)}</td>
                  <td>{fmtMin(d.avg_travel_minutes)}</td>
                  <td>{fmtMin(d.avg_waiting_minutes)}</td>
                  <td>{fmtMin(d.avg_unloading_minutes)}</td>
                </tr>
              ))}
              {data.drivers.length === 0 && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No trips in this date range.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function FuelAnalysis() {
  const [fromDate, setFromDate] = useState(daysAgoStr(30));
  const [toDate, setToDate] = useState(todayStr());
  const [fleet, setFleet] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTruck, setSelectedTruck] = useState(null);

  async function run() {
    setLoading(true); setError(""); setSelectedTruck(null);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      setFleet(await apiRequest(`/fuel-analysis/fleet?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const trucks = fleet?.trucks || [];
  const fleetAvg = fleet?.fleet_avg_litres_per_100km != null ? Number(fleet.fleet_avg_litres_per_100km) : null;
  const fleetAvgM3 = fleet?.fleet_avg_litres_per_m3 != null ? Number(fleet.fleet_avg_litres_per_m3) : null;
  const fleetAvgCostM3 = fleet?.fleet_avg_cost_per_m3 != null ? Number(fleet.fleet_avg_cost_per_m3) : null;
  const totalLitres = trucks.reduce((s, t) => s + Number(t.total_litres || 0), 0);
  const totalCost = trucks.reduce((s, t) => s + Number(t.total_cost || 0), 0);
  const totalTrips = trucks.reduce((s, t) => s + Number(t.trip_count || 0), 0);
  // Round 137, item 1a — ranked by L/m³ now, not L/100km.
  const sortedTable = [...trucks].sort((a, b) => (b.litres_per_m3 ?? -1) - (a.litres_per_m3 ?? -1));

  return (
    <>
      <TopBar title="360° Fuel Analysis" />
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 16 }}>
          Fuel consumption ranked across the fleet and broken down by the factors behind it — trips, distance, quantity carried, pump vs. manual discharge, site timing, and driver. Built from real fuel fills and delivery trips, not sample data.
        </div>

        <div className="card" style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--slate)", fontWeight: 600, marginBottom: 5 }}>From</div>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--slate)", fontWeight: 600, marginBottom: 5 }}>To</div>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <button type="button" className="btn-primary" onClick={run} disabled={loading}>
            {loading ? "Loading..." : "Filter"}
          </button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {fleet && !selectedTruck && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
              <div className="kpi" style={{ borderColor: "var(--rebar)" }}>
                <div className="kpi-label">Fleet avg L/m³ (main)</div>
                <div className="kpi-value">{fleetAvgM3 != null ? fleetAvgM3.toFixed(2) : "—"}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Fleet avg cost/m³</div>
                <div className="kpi-value">{fleetAvgCostM3 != null ? `₹${fleetAvgCostM3.toFixed(0)}` : "—"}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Fleet avg L/100km</div>
                <div className="kpi-value" style={{ fontSize: 16 }}>{fleetAvg != null ? fleetAvg.toFixed(1) : "—"}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Total fuel</div>
                <div className="kpi-value">{num(totalLitres)} L</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Total fuel cost</div>
                <div className="kpi-value">₹{num(totalCost)}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Trips in range</div>
                <div className="kpi-value">{totalTrips}</div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Fleet ranked by L/m³ (highest first)</div>
              <FleetBarChart trucks={trucks} fleetAvg={fleetAvgM3} onPick={(t) => setSelectedTruck(t.truck_id)} />
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10, fontSize: 11, color: "var(--slate)" }}>
                <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--alert-red)", marginRight: 5 }} />High consumption</span>
                <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--amber)", marginRight: 5 }} />Above average</span>
                <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--slate)", marginRight: 5 }} />Near average</span>
                <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--signal-green)", marginRight: 5 }} />Efficient</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 6 }}>Tap a truck to see what's driving its number.</div>
            </div>

            <div className="card">
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>All trucks</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Truck</th><th>L/m³</th><th>Cost/m³</th><th>L/100km</th><th>Litres</th><th>Cost</th><th>Fills</th>
                      <th>Plant / Outside</th><th>Trips</th><th>Qty</th><th>With pump</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTable.map((t) => {
                      const status = rateStatus(t.litres_per_m3 != null ? Number(t.litres_per_m3) : null, fleetAvgM3);
                      return (
                        <tr key={t.truck_id} style={{ cursor: "pointer" }} onClick={() => setSelectedTruck(t.truck_id)}>
                          <td>{t.truck_number}</td>
                          <td>
                            {t.litres_per_m3 != null ? (
                              <span className={`badge ${STATUS_BADGE[status.key]}`}>{Number(t.litres_per_m3).toFixed(2)}</span>
                            ) : "—"}
                          </td>
                          <td>{t.cost_per_m3 != null ? `₹${Number(t.cost_per_m3).toFixed(0)}` : "—"}</td>
                          <td>{t.litres_per_100km != null ? Number(t.litres_per_100km).toFixed(1) : "—"}</td>
                          <td>{num(t.total_litres)} L</td>
                          <td>₹{num(t.total_cost)}</td>
                          <td>{t.fill_count}</td>
                          <td>{t.plant_fill_count} / {t.outside_fill_count}</td>
                          <td>{t.trip_count}</td>
                          <td>{num(t.total_qty_m3, 1)} m³</td>
                          <td>{t.with_pump_trips} / {Number(t.with_pump_trips) + Number(t.without_pump_trips)}</td>
                        </tr>
                      );
                    })}
                    {sortedTable.length === 0 && <tr><td colSpan={11} style={{ color: "var(--slate)" }}>No trucks with fuel fills or trips in this date range.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 10 }}>Fuel fills come from Store-issued fuel requests (Plant pump or an outside station); L/100km uses each truck's own odometer readings across its fills.</div>
            </div>
          </>
        )}

        {selectedTruck && (
          <TruckDrilldown truckId={selectedTruck} fromDate={fromDate} toDate={toDate} fleetAvg={fleetAvg} fleetAvgM3={fleetAvgM3} onBack={() => setSelectedTruck(null)} />
        )}
      </div>
    </>
  );
}
