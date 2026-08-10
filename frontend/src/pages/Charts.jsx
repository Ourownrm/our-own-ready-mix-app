import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const METRICS = [
  { key: "transit", label: "Transit time (Plant Out → Site In)" },
  { key: "unloading", label: "Unloading time (Site In → Site Out)" },
  { key: "turnaround", label: "Turnaround (Plant Out → Plant In)" },
];
const GROUP_BYS = [
  { key: "site", label: "Site" },
  { key: "truck", label: "Truck" },
  { key: "mix_grade", label: "Mix grade" },
  { key: "driver", label: "Driver" },
  { key: "day_of_week", label: "Day of week" },
];

function MultiPicker({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const allSelected = selected.length === 0;
  return (
    <div style={{ position: "relative" }}>
      <div style={{ color: "var(--slate)", fontSize: 11, marginBottom: 3 }}>{label}</div>
      <button type="button" onClick={() => setOpen(!open)} style={{ fontSize: 12, padding: "5px 9px", minWidth: 110, textAlign: "left" }}>
        {allSelected ? "All" : `${selected.length} selected`} {open ? "▴" : "▾"}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#fff", border: "1px solid var(--concrete)", borderRadius: 8, padding: 8, zIndex: 30, maxHeight: 240, overflowY: "auto", minWidth: 180, boxShadow: "0 4px 12px rgba(0,0,0,0.12)" }}>
          <label style={{ display: "block", fontSize: 12, padding: "4px 0", cursor: "pointer" }}>
            <input type="checkbox" checked={allSelected} onChange={() => onChange([])} /> All
          </label>
          {options.map((o) => (
            <label key={o.id} style={{ display: "block", fontSize: 12, padding: "4px 0", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => {
                  const set = new Set(selected);
                  set.has(o.id) ? set.delete(o.id) : set.add(o.id);
                  onChange([...set]);
                }}
              />{" "}{o.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function BarChart({ rows, onBarClick }) {
  if (rows.length === 0) return <div style={{ fontSize: 13, color: "var(--slate)" }}>No completed trips match these filters.</div>;
  const max = Math.max(...rows.map((r) => r.max_minutes), 1);
  const w = 700, barH = 28, gap = 10, leftPad = 140, chartW = w - leftPad - 60;
  const h = rows.length * (barH + gap) + gap;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto" }}>
      {rows.map((r, i) => {
        const y = gap + i * (barH + gap);
        const barW = (r.avg_minutes / max) * chartW;
        const rangeX1 = leftPad + (r.min_minutes / max) * chartW;
        const rangeX2 = leftPad + (r.max_minutes / max) * chartW;
        return (
          <g key={r.group_key} style={{ cursor: "pointer" }} onClick={() => onBarClick(r)}>
            <text x={leftPad - 8} y={y + barH / 2 + 4} textAnchor="end" fontSize="11" fill="var(--slate)">{r.group_label}</text>
            <line x1={rangeX1} y1={y + barH / 2} x2={rangeX2} y2={y + barH / 2} stroke="var(--concrete)" strokeWidth="6" strokeLinecap="round" />
            <rect x={leftPad} y={y} width={Math.max(barW, 2)} height={barH} rx="4" fill="var(--rebar)" />
            <text x={leftPad + barW + 6} y={y + barH / 2 + 4} fontSize="11" fill="var(--charcoal, #222)">{r.avg_minutes} min ({r.trip_count})</text>
          </g>
        );
      })}
    </svg>
  );
}

function ScatterChart({ points }) {
  if (points.length === 0) return <div style={{ fontSize: 13, color: "var(--slate)" }}>No completed trips match these filters.</div>;
  const w = 700, h = 320, pad = 40;
  const maxQty = Math.max(...points.map((p) => p.quantity_m3), 1);
  const maxMin = Math.max(...points.map((p) => p.unloading_minutes), 1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto" }}>
      <line x1={pad} y1={h - pad} x2={w - 10} y2={h - pad} stroke="var(--concrete)" />
      <line x1={pad} y1={10} x2={pad} y2={h - pad} stroke="var(--concrete)" />
      <text x={w / 2} y={h - 6} textAnchor="middle" fontSize="11" fill="var(--slate)">Quantity (m³)</text>
      <text x={12} y={14} fontSize="11" fill="var(--slate)">min</text>
      {points.map((p, i) => {
        const x = pad + (p.quantity_m3 / maxQty) * (w - pad - 20);
        const y = h - pad - (p.unloading_minutes / maxMin) * (h - pad - 20);
        return <circle key={i} cx={x} cy={y} r="4" fill="var(--signal-green)" fillOpacity="0.7">
          <title>{p.customer_name} · {p.site_name} · {p.truck_number} · {p.mix_grade_name} · {p.quantity_m3}m³ · {p.unloading_minutes}min</title>
        </circle>;
      })}
    </svg>
  );
}

export default function Charts() {
  const [trucks, setTrucks] = useState([]);
  const [sites, setSites] = useState([]);
  const [grades, setGrades] = useState([]);
  const [fromDate, setFromDate] = useState(daysAgoStr(30));
  const [toDate, setToDate] = useState(todayStr());
  const [truckIds, setTruckIds] = useState([]);
  const [siteIds, setSiteIds] = useState([]);
  const [gradeIds, setGradeIds] = useState([]);
  const [metric, setMetric] = useState("unloading");
  const [groupBy, setGroupBy] = useState("site");
  const [rows, setRows] = useState([]);
  const [scatter, setScatter] = useState(null);
  const [drill, setDrill] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([apiRequest("/master/trucks"), apiRequest("/master/sites"), apiRequest("/master/mix-grades")])
      .then(([t, s, g]) => { setTrucks(t); setSites(s); setGrades(g); })
      .catch((err) => setError(err.message));
  }, []);

  function buildParams(extra = {}) {
    const p = new URLSearchParams({ from_date: fromDate, to_date: toDate, metric, group_by: groupBy, ...extra });
    if (truckIds.length) p.set("truck_ids", truckIds.join(","));
    if (siteIds.length) p.set("site_ids", siteIds.join(","));
    if (gradeIds.length) p.set("mix_grade_ids", gradeIds.join(","));
    return p;
  }

  async function run() {
    setLoading(true); setError(""); setDrill(null);
    try {
      setRows(await apiRequest(`/reports/trip-analysis?${buildParams().toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function runScatter() {
    setLoading(true); setError("");
    try {
      setScatter(await apiRequest(`/reports/trip-analysis/scatter?${buildParams().toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function drillInto(row) {
    setError("");
    try {
      const detail = await apiRequest(`/reports/trip-analysis/detail?${buildParams({ group_key: row.group_key }).toString()}`);
      setDrill({ row, detail });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <TopBar title="Charts — operations performance analysis" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card field-input" style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>From</div>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>To</div>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <MultiPicker label="Trucks" options={trucks.map((t) => ({ id: t.id, name: t.truck_number }))} selected={truckIds} onChange={setTruckIds} />
            <MultiPicker label="Sites" options={sites.map((s) => ({ id: s.id, name: s.name }))} selected={siteIds} onChange={setSiteIds} />
            <MultiPicker label="Mix grade" options={grades.map((g) => ({ id: g.id, name: g.name }))} selected={gradeIds} onChange={setGradeIds} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, paddingTop: 10, borderTop: "1px solid var(--concrete)" }}>
            <span style={{ color: "var(--slate)" }}>Metric</span>
            {METRICS.map((m) => (
              <button key={m.key} onClick={() => setMetric(m.key)} style={{ fontSize: 12, padding: "5px 9px", ...(metric === m.key ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>{m.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, marginTop: 8 }}>
            <span style={{ color: "var(--slate)" }}>Group by</span>
            {GROUP_BYS.map((g) => (
              <button key={g.key} onClick={() => setGroupBy(g.key)} style={{ fontSize: 12, padding: "5px 9px", ...(groupBy === g.key ? { background: "var(--rebar)", color: "#fff", border: "none" } : {}) }}>{g.label}</button>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <button onClick={run} disabled={loading}>{loading ? "Loading..." : "Run"}</button>
            <button onClick={runScatter} disabled={loading} style={{ marginLeft: 8 }}>Unloading vs quantity (scatter)</button>
          </div>
        </div>

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        {rows.length > 0 && !drill && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              {METRICS.find((m) => m.key === metric)?.label} by {GROUP_BYS.find((g) => g.key === groupBy)?.label}
            </div>
            <BarChart rows={rows} onBarClick={drillInto} />
            <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 8 }}>Tap a bar to see the individual trips behind it.</div>
          </div>
        )}

        {drill && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{drill.row.group_label} — {drill.detail.length} trips</div>
              <button onClick={() => setDrill(null)} style={{ fontSize: 12 }}>← Back to chart</button>
            </div>
            <table style={{ fontSize: 12 }}>
              <thead><tr><th>Date</th><th>Customer</th><th>Site</th><th>Truck</th><th>Driver</th><th>Grade</th><th>Qty</th><th>Minutes</th></tr></thead>
              <tbody>
                {drill.detail.map((d, i) => (
                  <tr key={i}>
                    <td>{new Date(d.ticket_date).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                    <td>{d.customer_name}</td>
                    <td>{d.site_name}</td><td>{d.truck_number}</td><td>{d.driver_name}</td><td>{d.mix_grade_name}</td>
                    <td>{d.loaded_quantity_m3} m³</td><td>{d.minutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {scatter && (
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Unloading time vs. quantity delivered</div>
            <ScatterChart points={scatter} />
          </div>
        )}
      </div>
    </>
  );
}
