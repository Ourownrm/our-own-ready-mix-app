import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const PHASE_COLORS = {
  qc: "#6B4C9A",       // violet
  transit: "#2A6F97",  // blue
  waiting: "#9C6B12",  // amber
  unload: "#1D7A55",   // green
};

function toMinutes(iso, dayStart) {
  return Math.round((new Date(iso) - dayStart) / 60000);
}

function buildTrip(t, dayStart, nowMin) {
  const created = t.created_at ? toMinutes(t.created_at, dayStart) : null;
  const left = t.left_plant ? toMinutes(t.left_plant, dayStart) : null;
  const reached = t.reached_site ? toMinutes(t.reached_site, dayStart) : null;
  const unloadStart = t.unloading_started ? toMinutes(t.unloading_started, dayStart) : null;
  const unloadEnd = t.unloading_completed ? toMinutes(t.unloading_completed, dayStart) : null;

  const isOpen = (from) => from != null && unloadEnd == null && !["completed", "closed"].includes(t.status);

  return {
    ...t,
    qc: created != null && left != null ? [created, left] : null,
    transit: left != null && reached != null ? [left, reached] : null,
    waiting: reached != null && unloadStart != null ? [reached, unloadStart] : null,
    unload: unloadStart != null && unloadEnd != null ? [unloadStart, unloadEnd] : null,
    ongoing:
      unloadStart != null && unloadEnd == null ? [unloadStart, nowMin]
      : reached != null && unloadStart == null && unloadEnd == null ? null // waiting, not yet a bar — handled as "waiting ongoing" below
      : null,
    waitingOngoing: reached != null && unloadStart == null && unloadEnd == null ? [reached, nowMin] : null,
    maxTime: Math.max(created ?? 0, left ?? 0, reached ?? 0, unloadStart ?? 0, unloadEnd ?? nowMin, 0),
  };
}

function Segment({ range, color, dashed, pxPerMin }) {
  if (!range) return null;
  const left = range[0] * pxPerMin;
  const width = Math.max((range[1] - range[0]) * pxPerMin, 2);
  const dur = range[1] - range[0];
  const showLabel = width >= 28;
  return (
    <div
      title={`${dur} min`}
      style={{
        position: "absolute", left, width, top: 2, bottom: 2, borderRadius: 4,
        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
        background: dashed ? "#ffffff55" : color,
        border: dashed ? `1.5px dashed ${color}` : "none",
        boxShadow: dashed ? `inset 0 0 0 1000px ${color}33` : "none",
      }}
    >
      {showLabel && <span style={{ fontSize: 10, fontWeight: 600, color: dashed ? color : "#fff", whiteSpace: "nowrap" }}>{dur}m</span>}
    </div>
  );
}

export default function CycleTimeReport() {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [customerId, setCustomerId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [sortBy, setSortBy] = useState("dn");
  const [rows, setRows] = useState(null);
  const [zoom, setZoom] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites")])
      .then(([c, s]) => { setCustomers(c); setSites(s); })
      .catch((err) => setError(err.message));
  }, []);

  const sitesForCustomer = customerId ? sites.filter((s) => String(s.customer_id) === String(customerId)) : sites;

  async function run() {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate, sort_by: sortBy });
      if (customerId) params.set("customer_id", customerId);
      if (siteId) params.set("site_id", siteId);
      setRows(await apiRequest(`/reports/cycle-time?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const dayStart = new Date(`${fromDate}T00:00:00`);
  const nowMin = toMinutes(new Date().toISOString(), dayStart);
  const trips = (rows || []).map((t) => buildTrip(t, dayStart, nowMin));
  const maxMin = trips.length ? Math.max(...trips.map((t) => t.maxTime), 60) : 60;
  const trackWidth = maxMin * zoom;

  function clockLabel(min) {
    const totalMin = ((min % 1440) + 1440) % 1440;
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  return (
    <>
      <TopBar title="Cycle time report" />
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card field-input" style={{ marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", fontSize: 13 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>Customer</div>
            <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setSiteId(""); }}>
              <option value="">All</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Site</div>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">All</option>
              {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>From</div>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>To</div>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Sort by</div>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="dn">DN</option>
              <option value="truck">Truck</option>
            </select>
          </div>
          <button onClick={run} disabled={loading}>{loading ? "Loading..." : "Run"}</button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        {rows && (
          rows.length === 0 ? (
            <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No trips match these filters.</div>
          ) : (
            <div className="card">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 12, fontSize: 12, color: "var(--slate)" }}>
                <Legend color={PHASE_COLORS.qc} label="QC checks" />
                <Legend color={PHASE_COLORS.transit} label="Transit to site" />
                <Legend color={PHASE_COLORS.waiting} label="Waiting at site" />
                <Legend color={PHASE_COLORS.unload} label="Unloading" />
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, border: "1.5px dashed var(--slate)" }} />
                  In progress
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12 }}>
                <span style={{ color: "var(--slate)" }}>Zoom</span>
                <input type="range" min="3" max="18" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ width: 140 }} />
                <span style={{ color: "var(--slate)" }}>Scroll the timeline to see more</span>
              </div>

              <div style={{ display: "flex", fontSize: 11, color: "var(--slate)", paddingBottom: 6, borderBottom: "1px solid var(--concrete)" }}>
                <div style={{ width: 64, flexShrink: 0 }}>DN</div>
                <div style={{ width: 90, flexShrink: 0 }}>Truck</div>
                <div style={{ width: 100, flexShrink: 0 }}>Driver</div>
                <div style={{ width: 44, flexShrink: 0 }}>Qty</div>
                <div style={{ flex: 1 }}>Timeline</div>
              </div>

              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: "100%" }}>
                  {trips.map((t) => (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "0.5px solid var(--concrete)", fontSize: 12 }}>
                      <div style={{ width: 64, flexShrink: 0, fontWeight: 600 }}>{t.ticket_number}</div>
                      <div style={{ width: 90, flexShrink: 0, color: "var(--slate)" }}>{t.truck_number || "–"}</div>
                      <div style={{ width: 100, flexShrink: 0, color: "var(--slate)" }}>{t.driver_name || "–"}</div>
                      <div style={{ width: 44, flexShrink: 0, color: "var(--slate)" }}>{t.loaded_quantity_m3}m³</div>
                      <div style={{ position: "relative", height: 28, background: "var(--concrete)", borderRadius: 4, width: trackWidth }}>
                        <Segment range={t.qc} color={PHASE_COLORS.qc} pxPerMin={zoom} />
                        <Segment range={t.transit} color={PHASE_COLORS.transit} pxPerMin={zoom} />
                        <Segment range={t.waiting} color={PHASE_COLORS.waiting} pxPerMin={zoom} />
                        <Segment range={t.waitingOngoing} color={PHASE_COLORS.waiting} dashed pxPerMin={zoom} />
                        <Segment range={t.unload} color={PHASE_COLORS.unload} pxPerMin={zoom} />
                        <Segment range={t.ongoing} color={PHASE_COLORS.unload} dashed pxPerMin={zoom} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </>
  );
}

function Legend({ color, label }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}
