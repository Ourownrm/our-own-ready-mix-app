import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { daysAgoStr, todayStr } from "../../lib/istDate.js";
import {
  FleetBarChart, TruckDrilldown, EquipmentDrilldown, EquipmentOverview,
  rateStatus, setStatusBands, STATUS_COLOR, STATUS_BADGE,
} from "../FuelAnalysis.jsx";
import {
  bandsFromSettings, fmtL, fmtRs, fmtNum, fmtWhen, fmtMonth, pctChange, Sparkline, Kpi,
  CATEGORY_COLOURS,
} from "./fuelUi.jsx";

// Round 199 — the 360° Fuel Analysis, moved into the Fuel module.
//
// The Trucks and Pumps & equipment views are the existing analysis, unchanged
// underneath: same /fuel-analysis endpoints, same L/m³-first ranking, same
// fill-to-fill drill-downs (FuelAnalysis.jsx's own components). Added around
// them: a plant-wide Overview, a comparison with an earlier period on every
// headline figure, 6-month trends per truck and machine, an Exceptions view,
// and an Approvals view.

const VIEWS = [
  { key: "overview", label: "Overview", isNew: true },
  { key: "trucks", label: "Trucks" },
  { key: "equipment", label: "Pumps & equipment" },
  { key: "exceptions", label: "Exceptions", isNew: true },
  { key: "approvals", label: "Approvals", isNew: true },
];

// The comparison period — mirrors compareRange() in routes/fuelModule.js.
function compareRange(from, to, mode) {
  if (mode === "none") return null;
  const d = (s) => new Date(`${s}T00:00:00Z`);
  const fmt = (x) => x.toISOString().slice(0, 10); // ist-ok: UTC-midnight date built from a yyyy-mm-dd string
  if (mode === "year") {
    const f = d(from); f.setUTCFullYear(f.getUTCFullYear() - 1);
    const t = d(to); t.setUTCFullYear(t.getUTCFullYear() - 1);
    return { from: fmt(f), to: fmt(t) };
  }
  const days = Math.round((d(to) - d(from)) / 86400000) + 1;
  const t = d(from); t.setUTCDate(t.getUTCDate() - 1);
  const f = new Date(t); f.setUTCDate(f.getUTCDate() - (days - 1));
  return { from: fmt(f), to: fmt(t) };
}

function DeltaLine({ now, before, betterWhenLower = true }) {
  const p = pctChange(now, before);
  if (p == null) return null;
  if (Math.abs(p) < 0.05) return <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 2, color: "var(--slate)" }}>No change vs earlier period</div>;
  const better = betterWhenLower ? p < -0.5 : p > 0.5;
  return (
    <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 2, color: better ? "var(--signal-green)" : "var(--slate)" }}>
      {p > 0 ? "+" : "−"}{fmtNum(Math.abs(p), Math.abs(p) < 10 ? 1 : 0)}% vs earlier period
    </div>
  );
}

function NewTag() {
  return <span className="badge badge-success" style={{ fontSize: 9.5, padding: "1px 7px", marginLeft: 6, letterSpacing: 0.4, textTransform: "uppercase" }}>New</span>;
}

// ---------- Overview ----------
function Overview({ data }) {
  const c = data.current, p = data.previous;
  const months = data.months;
  const maxM3 = Math.max(1, ...months.map((m) => m.m3_produced || 0));
  const lpm = months.map((m) => m.litres_per_m3).filter((v) => v != null);
  const lo = lpm.length ? Math.min(...lpm) * 0.9 : 0, hi = lpm.length ? Math.max(...lpm) * 1.1 : 1;
  const maxFlow = Math.max(1, ...months.flatMap((m) => [m.received || 0, m.issued || 0]));
  const groups = [["truck", "Trucks"], ["pump", "Pumps"], ["equipment", "Loaders, generators & vans"]];
  const totalG = groups.reduce((a, [k]) => a + c.groups[k].litres, 0) || 1;
  const rates = months.map((m) => m.rate).filter((v) => v != null);
  const rlo = rates.length ? Math.min(...rates) - 0.5 : 0, rhi = rates.length ? Math.max(...rates) + 0.5 : 1;
  const cc = data.cost_change;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="open-q">The whole plant in one view, trucks and machines together, measured against the <b>m³ actually produced</b> (Plant Production) rather than the m³ each truck carried.{p ? " Each figure shows the change from the earlier period." : ""}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Kpi label="Fuel used" value={fmtL(c.litres)}>{p && <DeltaLine now={c.litres} before={p.litres} />}</Kpi>
        <Kpi label="Fuel cost" value={fmtRs(c.cost)}>{p && <DeltaLine now={c.cost} before={p.cost} />}</Kpi>
        <Kpi label="Litres / m³ produced" accent value={c.litres_per_m3 != null ? fmtNum(c.litres_per_m3, 2) : "—"}>{p && <DeltaLine now={c.litres_per_m3} before={p.litres_per_m3} />}</Kpi>
        <Kpi label="Cost / m³ produced" value={c.cost_per_m3 != null ? fmtRs(c.cost_per_m3) : "—"}>{p && <DeltaLine now={c.cost_per_m3} before={p.cost_per_m3} />}</Kpi>
        <Kpi label="Outside fills" value={c.litres ? `${fmtNum((c.outside.litres / c.litres) * 100, 1)}%` : "—"} sub={`${fmtL(c.outside.litres)} · ${c.outside.fills} fills`} />
        <Kpi label="Avg rate charged" value={c.avg_rate != null ? fmtRs(c.avg_rate, 2) : "—"}>{p && <DeltaLine now={c.avg_rate} before={p.avg_rate} />}</Kpi>
        <Kpi label="m³ produced" value={fmtNum(c.m3_produced)}>{p && <DeltaLine now={c.m3_produced} before={p.m3_produced} betterWhenLower={false} />}</Kpi>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <section className="card" style={{ flex: "1 1 520px", minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Fuel against concrete produced · 6 months</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>Bars: m³ produced · line: litres per m³ (all fuel ÷ all m³)</div>
          <div style={{ position: "relative", height: 200, marginTop: 14 }}>
            <div style={{ position: "absolute", inset: "0 0 24px 0", display: "flex", alignItems: "flex-end", gap: 16, borderBottom: "1px solid var(--border-strong)", padding: "0 6px" }}>
              {months.map((m) => (
                <div key={m.month} style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                  <div style={{ fontSize: 10, color: "var(--slate)" }}>{fmtNum(m.m3_produced)}</div>
                  <div style={{ width: "60%", maxWidth: 44, height: `${((m.m3_produced || 0) / maxM3) * 140}px`, background: "#D9D4C8", borderRadius: "3px 3px 0 0" }} />
                </div>
              ))}
            </div>
            <svg viewBox="0 0 600 176" preserveAspectRatio="none" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: 176 }} aria-hidden="true">
              <polyline fill="none" stroke="var(--rebar)" strokeWidth="3" vectorEffect="non-scaling-stroke"
                points={months.map((m, i) => (m.litres_per_m3 == null ? null : `${(i + 0.5) * (600 / months.length)},${160 - ((m.litres_per_m3 - lo) / (hi - lo || 1)) * 120}`)).filter(Boolean).join(" ")} />
            </svg>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", gap: 16, padding: "0 6px" }}>
              {months.map((m) => <div key={m.month} style={{ flex: "1 1 0", textAlign: "center", fontSize: 11, color: "var(--slate)" }}>{fmtMonth(m.month)} · <b style={{ color: "var(--rebar)" }}>{m.litres_per_m3 != null ? fmtNum(m.litres_per_m3, 2) : "—"}</b></div>)}
            </div>
          </div>
        </section>

        <section className="card" style={{ flex: "1 1 400px", minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Where the fuel went</div>
          <div style={{ display: "flex", height: 22, borderRadius: 4, overflow: "hidden", marginTop: 14, gap: 2 }}>
            {groups.map(([k]) => c.groups[k].litres > 0 && <div key={k} style={{ width: `${(c.groups[k].litres / totalG) * 100}%`, background: CATEGORY_COLOURS[k] }} />)}
          </div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Group</th><th style={{ textAlign: "right" }}>Litres</th><th style={{ textAlign: "right" }}>Share</th>{p && <th style={{ textAlign: "right" }}>Change</th>}</tr></thead>
            <tbody>
              {groups.map(([k, label]) => {
                const ch = p ? pctChange(c.groups[k].litres, p.groups[k].litres) : null;
                return (
                  <tr key={k}>
                    <td><span className="legend-swatch" style={{ background: CATEGORY_COLOURS[k], marginRight: 8 }} />{label} ({c.groups[k].units})</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(c.groups[k].litres)}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum((c.groups[k].litres / totalG) * 100)}%</td>
                    {p && <td style={{ textAlign: "right" }}>{ch == null ? "—" : `${ch > 0 ? "+" : "−"}${fmtNum(Math.abs(ch))}%`}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <div style={{ flex: 1, background: "var(--concrete)", borderRadius: 8, padding: "10px 12px" }}>
              <div className="kpi-label">Plant tank</div><div style={{ fontSize: 18, fontWeight: 700 }}>{fmtL(c.litres - c.outside.litres)}</div>
            </div>
            <div style={{ flex: 1, background: "var(--concrete)", borderRadius: 8, padding: "10px 12px" }}>
              <div className="kpi-label">Outside stations</div><div style={{ fontSize: 18, fontWeight: 700 }}>{fmtL(c.outside.litres)}</div>
              <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{c.outside.fills} fills · {fmtRs(c.outside.cost)}</div>
            </div>
          </div>
        </section>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <section className="card" style={{ flex: "1 1 520px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Tank: received vs issued · 6 months</div>
            <div className="legend" style={{ margin: 0 }}>
              <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--signal-green)" }} />Received</span>
              <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--info)" }} />Issued</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16, height: 160, marginTop: 14, borderBottom: "1px solid var(--border-strong)", padding: "0 6px" }}>
            {months.map((m) => (
              <div key={m.month} style={{ flex: "1 1 0", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 4, height: "100%" }}>
                <div title={`Received ${fmtL(m.received)}`} style={{ width: "34%", maxWidth: 24, height: `${((m.received || 0) / maxFlow) * 140}px`, background: "var(--signal-green)", borderRadius: "3px 3px 0 0" }} />
                <div title={`Issued ${fmtL(m.issued)}`} style={{ width: "34%", maxWidth: 24, height: `${((m.issued || 0) / maxFlow) * 140}px`, background: "var(--info)", borderRadius: "3px 3px 0 0" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 16, padding: "6px 6px 0" }}>
            {months.map((m) => <div key={m.month} style={{ flex: "1 1 0", textAlign: "center", fontSize: 11, color: "var(--slate)" }}>{fmtMonth(m.month)}</div>)}
          </div>
        </section>

        <section className="card" style={{ flex: "1 1 400px", minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Why the fuel bill changed</div>
          {cc ? (
            <>
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>Against the earlier period · {cc.total >= 0 ? "+" : "−"}{fmtRs(Math.abs(cc.total))}</div>
              {[["More / fewer litres used", cc.volume, "var(--info)"], ["Change in rate", cc.rate, "var(--rebar)"]].map(([label, v, col]) => {
                const max = Math.max(1, Math.abs(cc.volume), Math.abs(cc.rate));
                return (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                    <div style={{ width: 150, fontSize: 12.5, fontWeight: 600 }}>{label}</div>
                    <div style={{ flex: 1, height: 22, background: "var(--concrete)", borderRadius: 4, position: "relative" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(Math.abs(v) / max) * 100}%`, background: col, borderRadius: 4, opacity: v < 0 ? 0.5 : 1 }} />
                    </div>
                    <div style={{ width: 90, textAlign: "right", fontWeight: 700, fontSize: 13 }}>{v >= 0 ? "+" : "−"}{fmtRs(Math.abs(v))}</div>
                  </div>
                );
              })}
            </>
          ) : <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 8 }}>Choose a comparison period to see this split.</div>}
          <div className="kpi-label" style={{ marginTop: 16 }}>Rate per litre · 6 months</div>
          {rates.length >= 2 ? (
            <svg viewBox="0 0 400 70" preserveAspectRatio="none" style={{ width: "100%", height: 70, display: "block", marginTop: 6 }} aria-label="Rate per litre by month">
              <polyline fill="none" stroke="var(--charcoal)" strokeWidth="2.5" vectorEffect="non-scaling-stroke"
                points={months.map((m, i) => (m.rate == null ? null : `${(i + 0.5) * (400 / months.length)},${62 - ((m.rate - rlo) / (rhi - rlo || 1)) * 55}`)).filter(Boolean).join(" ")} />
            </svg>
          ) : <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 6 }}>Not enough priced deliveries yet.</div>}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--slate)" }}>
            {months.map((m) => <span key={m.month}>{fmtMonth(m.month)} {m.rate != null ? `₹${fmtNum(m.rate, 2)}` : ""}</span>)}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------- Trucks ----------
function Trucks({ fleet, prevFleet, trends, from, to, exceptions, onPick, selected, onBack }) {
  const trucks = fleet?.trucks || [];
  const fleetAvg = fleet?.fleet_avg_litres_per_100km != null ? Number(fleet.fleet_avg_litres_per_100km) : null;
  const fleetAvgM3 = fleet?.fleet_avg_litres_per_m3 != null ? Number(fleet.fleet_avg_litres_per_m3) : null;
  const fleetAvgCostM3 = fleet?.fleet_avg_cost_per_m3 != null ? Number(fleet.fleet_avg_cost_per_m3) : null;
  const sum = (list, k) => (list || []).reduce((s, t) => s + Number(t[k] || 0), 0);
  const prev = prevFleet ? {
    m3: prevFleet.fleet_avg_litres_per_m3, cost: prevFleet.fleet_avg_cost_per_m3, km: prevFleet.fleet_avg_litres_per_100km,
    litres: sum(prevFleet.trucks, "total_litres"), spend: sum(prevFleet.trucks, "total_cost"), trips: sum(prevFleet.trucks, "trip_count"),
  } : null;
  const sorted = [...trucks].sort((a, b) => (b.litres_per_m3 ?? -1) - (a.litres_per_m3 ?? -1));

  if (selected) {
    const truck = trucks.find((t) => t.truck_id === selected);
    const series = trends?.trucks?.[selected] || [];
    const avgSeries = trends?.fleet_avg_litres_per_m3 || [];
    const exc = (exceptions?.items || []).filter((e) => truck && e.unit_label === truck.truck_number);
    const vals = [...series, ...avgSeries].filter((v) => v != null);
    const lo = vals.length ? Math.min(...vals) * 0.9 : 0, hi = vals.length ? Math.max(...vals) * 1.1 : 1;
    const xy = (arr) => arr.map((v, i) => (v == null ? null : `${10 + i * (380 / Math.max(1, arr.length - 1))},${130 - ((v - lo) / (hi - lo || 1)) * 115}`)).filter(Boolean).join(" ");
    const extra = (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
        <section className="card" style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Month by month<NewTag /></div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>L/m³ for this truck (solid) against the fleet average (dashed)</div>
          {vals.length >= 2 ? (
            <svg viewBox="0 0 400 140" preserveAspectRatio="none" style={{ width: "100%", height: 140, display: "block", marginTop: 8, background: "#FAF9F6", borderRadius: 6 }} aria-label="Six-month L/m³ trend">
              <polyline points={xy(avgSeries)} fill="none" stroke="var(--charcoal)" strokeDasharray="5 4" opacity=".55" vectorEffect="non-scaling-stroke" />
              <polyline points={xy(series)} fill="none" stroke="var(--rebar)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 8 }}>Needs at least two months with both fuel and delivered m³.</div>}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
            {(trends?.months || []).map((m, i) => <span key={m}>{fmtMonth(m)} {series[i] != null ? fmtNum(series[i], 2) : ""}</span>)}
          </div>
        </section>
        <section className="card" style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Exceptions on this truck<NewTag /></div>
          {exc.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 8 }}>None in this date range.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10, fontSize: 12.5 }}>
              {exc.map((e) => (
                <div key={`${e.check}-${e.sr_id}`} style={{ padding: "8px 10px", borderRadius: 8, background: e.review ? "var(--concrete)" : "var(--amber-bg)" }}>
                  <b>{e.label}</b> · {e.ref} · {fmtWhen(e.at)}<div style={{ color: "var(--slate)" }}>{e.detail}{e.review ? ` — reviewed: ${e.review.note}` : ""}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    );
    return <TruckDrilldown truckId={selected} fromDate={from} toDate={to} fleetAvg={fleetAvg} fleetAvgM3={fleetAvgM3} onBack={onBack} extra={extra} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Kpi accent label="Fleet avg L/m³ (main)" value={fleetAvgM3 != null ? fleetAvgM3.toFixed(2) : "—"}>{prev && <DeltaLine now={fleetAvgM3} before={prev.m3} />}</Kpi>
        <Kpi label="Fleet avg cost/m³" value={fleetAvgCostM3 != null ? `₹${fleetAvgCostM3.toFixed(0)}` : "—"}>{prev && <DeltaLine now={fleetAvgCostM3} before={prev.cost} />}</Kpi>
        <Kpi label="Fleet avg L/100km" value={fleetAvg != null ? fleetAvg.toFixed(1) : "—"} valueStyle={{ fontSize: 17 }}>{prev && <DeltaLine now={fleetAvg} before={prev.km} />}</Kpi>
        <Kpi label="Total fuel" value={fmtL(sum(trucks, "total_litres"))}>{prev && <DeltaLine now={sum(trucks, "total_litres")} before={prev.litres} />}</Kpi>
        <Kpi label="Total fuel cost" value={fmtRs(sum(trucks, "total_cost"))}>{prev && <DeltaLine now={sum(trucks, "total_cost")} before={prev.spend} />}</Kpi>
        <Kpi label="Trips in range" value={fmtNum(sum(trucks, "trip_count"))}>{prev && <DeltaLine now={sum(trucks, "trip_count")} before={prev.trips} betterWhenLower={false} />}</Kpi>
      </div>

      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Fleet ranked by L/m³ (highest first)</div>
        <FleetBarChart trucks={trucks} fleetAvg={fleetAvgM3} onPick={(t) => onPick(t.truck_id)} />
        <div className="legend" style={{ marginTop: 10 }}>
          <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--alert-red)" }} />High consumption</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--amber)" }} />Above average</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--slate)" }} />Near average</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--signal-green)" }} />Efficient</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 6 }}>Tap a truck to see what's driving its number.</div>
      </div>

      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>All trucks</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 12, minWidth: 1080 }}>
            <thead>
              <tr>
                <th>Truck</th><th>L/m³</th><th>Cost/m³</th><th>L/100km</th><th>Litres</th><th>Cost</th><th>Fills</th>
                <th>Plant / Outside</th><th>Trips</th><th>Qty</th><th>With pump</th>
                <th style={{ background: "#F4FAF7" }}>Status<NewTag /></th><th style={{ background: "#F4FAF7" }}>L/m³ · 6 months<NewTag /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => {
                const status = rateStatus(t.litres_per_m3 != null ? Number(t.litres_per_m3) : null, fleetAvgM3);
                return (
                  <tr key={t.truck_id} style={{ cursor: "pointer" }} onClick={() => onPick(t.truck_id)}>
                    <td><button type="button" onClick={(e) => { e.stopPropagation(); onPick(t.truck_id); }} style={{ padding: "4px 8px", fontWeight: 700, fontSize: 12 }}>{t.truck_number}</button></td>
                    <td>{t.litres_per_m3 != null ? <span className={`badge ${STATUS_BADGE[status.key]}`}>{Number(t.litres_per_m3).toFixed(2)}</span> : "—"}</td>
                    <td>{t.cost_per_m3 != null ? `₹${Number(t.cost_per_m3).toFixed(0)}` : "—"}</td>
                    <td>{t.litres_per_100km != null ? Number(t.litres_per_100km).toFixed(1) : "—"}</td>
                    <td>{fmtNum(t.total_litres)} L</td>
                    <td>₹{fmtNum(t.total_cost)}</td>
                    <td>{t.fill_count}</td>
                    <td>{t.plant_fill_count} / {t.outside_fill_count}</td>
                    <td>{t.trip_count}</td>
                    <td>{fmtNum(t.total_qty_m3, 1)} m³</td>
                    <td>{t.with_pump_trips} / {Number(t.with_pump_trips) + Number(t.without_pump_trips)}</td>
                    <td style={{ background: "#F4FAF7", color: STATUS_COLOR[status.key], fontWeight: 600 }}>{status.label}</td>
                    <td style={{ background: "#F4FAF7" }}><Sparkline values={trends?.trucks?.[t.truck_id] || []} color={STATUS_COLOR[status.key]} /></td>
                  </tr>
                );
              })}
              {sorted.length === 0 && <tr><td colSpan={13} style={{ color: "var(--slate)" }}>No trucks with fuel fills or trips in this date range.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 10 }}>Fuel fills come from Store-issued fuel requests (plant pump or an outside station); L/100km uses each truck's own odometer readings across its fills.</div>
      </div>
    </div>
  );
}

// ---------- Pumps & equipment ----------
function Equipment({ data, prevData, trends, from, to, selected, onPick, onBack }) {
  if (selected) {
    return (
      <EquipmentDrilldown kind={selected.kind} unitId={selected.id} fromDate={from} toDate={to}
        typeAvg={data?.avg_litres_per_hour_by_type?.[selected.type] != null ? Number(data.avg_litres_per_hour_by_type[selected.type]) : null}
        onBack={onBack} />
    );
  }
  const sum = (d, k) => (d?.units || []).reduce((s, u) => s + Number(u[k] || 0), 0);
  return (
    <div>
      {prevData && (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
          <span>Compared with the earlier period<NewTag />:</span>
          {[["Fuel", "total_litres", fmtL], ["Cost", "total_cost", fmtRs], ["Hours run", "hours_run", (v) => fmtNum(v, 1)]].map(([label, k, f]) => {
            const ch = pctChange(sum(data, k), sum(prevData, k));
            return <span key={k}><b style={{ color: "var(--charcoal)" }}>{label}</b> {f(sum(prevData, k))} → {f(sum(data, k))}{ch != null ? ` (${ch > 0 ? "+" : "−"}${fmtNum(Math.abs(ch))}%)` : ""}</span>;
          })}
        </div>
      )}
      <EquipmentOverview data={data} onPick={(u) => onPick({ kind: u.kind, id: u.unit_id, type: u.unit_subtype })}
        trendFor={(u, status) => <Sparkline values={trends?.units?.[`${u.kind}:${u.unit_id}`] || []} color={STATUS_COLOR[status.key]} />} />
    </div>
  );
}

// ---------- Exceptions ----------
function Exceptions({ data, fleet, equipment, canReview, onReviewed, openLedger }) {
  const [reviewing, setReviewing] = useState(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  // High consumption is the analysis's own badge rule, applied to every truck
  // (L/m³ against the fleet) and machine (L/hr against its own type).
  const fleetAvgM3 = fleet?.fleet_avg_litres_per_m3 != null ? Number(fleet.fleet_avg_litres_per_m3) : null;
  const high = [
    ...(fleet?.trucks || []).filter((t) => t.litres_per_m3 != null && rateStatus(Number(t.litres_per_m3), fleetAvgM3).key === "danger")
      .map((t) => ({ key: `t${t.truck_id}`, unit: t.truck_number, text: `${Number(t.litres_per_m3).toFixed(2)} L/m³ against a fleet average of ${fleetAvgM3?.toFixed(2)}` })),
    ...(equipment?.units || []).filter((u) => {
      const avg = equipment.avg_litres_per_hour_by_type?.[u.unit_subtype];
      return u.litres_per_hour != null && avg != null && rateStatus(Number(u.litres_per_hour), Number(avg)).key === "danger";
    }).map((u) => ({ key: `${u.kind}${u.unit_id}`, unit: u.unit_name, text: `${Number(u.litres_per_hour).toFixed(2)} L/hr against ${Number(equipment.avg_litres_per_hour_by_type[u.unit_subtype]).toFixed(2)} for its type` })),
  ];

  async function save(item) {
    setSaving(true); setErr("");
    try {
      await apiRequest("/fuel-module/analysis/exceptions/review", { method: "POST", body: { check_key: item.check, reference_id: item.sr_id, note } });
      setReviewing(null); setNote(""); onReviewed();
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="open-q">Checks run over every fill in the date range. Open one to see it in the ledger{canReview ? ", and mark it reviewed with a short note" : ""}.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <div className="kpi"><div className="kpi-label">High consumption</div><div className="kpi-value" style={{ fontSize: 22, color: high.length ? "var(--alert-red)" : undefined }}>{high.length}</div><div style={{ fontSize: 11.5, color: "var(--slate)" }}>trucks & machines</div></div>
        {Object.entries(data.counts).map(([k, c]) => (
          <div key={k} className="kpi"><div className="kpi-label">{c.label}</div>
            <div className="kpi-value" style={{ fontSize: 22, color: c.found - c.reviewed > 0 ? "var(--amber)" : undefined }}>{c.found}</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{c.reviewed} reviewed</div></div>
        ))}
      </div>

      {high.length > 0 && (
        <section className="card">
          <div style={{ fontSize: 15, fontWeight: 700 }}>High consumption</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>More than {fmtNum(data.settings.band_high_pct)}% over the average — the same rule as the red badges on the Trucks and Pumps & equipment views</div>
          <table style={{ marginTop: 8 }}>
            <tbody>{high.map((h) => <tr key={h.key}><td style={{ fontWeight: 700, width: 140 }}>{h.unit}</td><td>{h.text}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 16px 6px", fontSize: 15, fontWeight: 700 }}>Fills that need a second look</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ minWidth: 860 }}>
            <thead><tr><th>Check</th><th>When</th><th>Ref</th><th>Vehicle / machine</th><th>What was found</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.items.map((it) => {
                const key = `${it.check}-${it.sr_id}`;
                return (
                  <tr key={key}>
                    <td style={{ fontWeight: 600 }}>{it.label}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(it.at)}</td>
                    <td>{it.ref}</td>
                    <td>{it.unit_label || "—"}<div style={{ fontSize: 11, color: "var(--slate)" }}>{fmtL(it.litres)}</div></td>
                    <td style={{ fontSize: 12.5 }}>{it.detail}
                      {reviewing === key && (
                        <div className="field-input" style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you found, e.g. grid cut — DG run at night" style={{ flex: "1 1 240px" }} />
                          <button type="button" onClick={() => setReviewing(null)}>Cancel</button>
                          <button type="button" className="btn-primary" disabled={saving || !note.trim()} onClick={() => save(it)}>{saving ? "Saving…" : "Mark reviewed"}</button>
                          {err && <div style={{ color: "var(--alert-red)", fontSize: 12, flex: "1 1 100%" }}>{err}</div>}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>{it.review ? <><span className="badge badge-success">Reviewed</span><div style={{ color: "var(--slate)", marginTop: 3 }}>{it.review.note} · {it.review.reviewed_by_name}</div></> : <span className="badge badge-warning">Open</span>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {openLedger && <button type="button" style={{ fontSize: 12, padding: "6px 10px", marginRight: 6 }} onClick={() => openLedger(it.ref)}>View</button>}
                      {canReview && reviewing !== key && <button type="button" style={{ fontSize: 12, padding: "6px 10px" }} onClick={() => { setReviewing(key); setNote(it.review?.note || ""); }}>{it.review ? "Edit note" : "Review"}</button>}
                    </td>
                  </tr>
                );
              })}
              {data.items.length === 0 && <tr><td colSpan={7} style={{ color: "var(--slate)", padding: 16 }}>Nothing found in this date range.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------- Approvals ----------
function Approvals({ data }) {
  const box = (label, value, sub) => (
    <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "10px 12px" }}>
      <div className="kpi-label">{label}</div><div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--slate)" }}>{sub}</div>}
    </div>
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
      <section className="card" style={{ flex: "1 1 440px" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>How fuel requests were handled</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginTop: 14 }}>
          {box("Requests", fmtNum(data.requests), `${data.issued} issued · ${data.rejected} rejected · ${data.open} open`)}
          {box("Cut at approval", fmtL(data.cut_litres), data.cut_pct != null ? `${fmtNum(data.cut_pct, 1)}% less than asked` : null)}
          {box("Request → approve", data.median_request_to_approve_min != null ? `${data.median_request_to_approve_min} min` : "—", "median")}
          {box("Approve → issue", data.median_approve_to_issue_min != null ? `${data.median_approve_to_issue_min} min` : "—", "median, plant issues")}
        </div>
      </section>
      <section className="card" style={{ flex: "1 1 440px" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Who issued, and what was cut</div>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Issued by</th><th style={{ textAlign: "right" }}>Fills</th><th style={{ textAlign: "right" }}>Litres</th></tr></thead>
          <tbody>
            {data.issuers.map((r) => <tr key={r.who}><td>{r.who}</td><td style={{ textAlign: "right" }}>{r.fills}</td><td style={{ textAlign: "right" }}>{fmtNum(r.litres)}</td></tr>)}
            {data.issuers.length === 0 && <tr><td colSpan={3} style={{ color: "var(--slate)" }}>No fuel issued in this range.</td></tr>}
          </tbody>
        </table>
        <table style={{ marginTop: 14 }}>
          <thead><tr><th>Most cut at approval</th><th style={{ textAlign: "right" }}>Asked</th><th style={{ textAlign: "right" }}>Approved</th></tr></thead>
          <tbody>
            {data.most_cut.map((r) => <tr key={r.unit_label}><td>{r.unit_label}</td><td style={{ textAlign: "right" }}>{fmtL(r.asked)}</td><td style={{ textAlign: "right" }}>{fmtL(r.approved)}</td></tr>)}
            {data.most_cut.length === 0 && <tr><td colSpan={3} style={{ color: "var(--slate)" }}>Nothing was reduced at approval.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default function FuelAnalysis360({ go, params }) {
  const { can } = usePermissions();
  const [fromDate, setFromDate] = useState(daysAgoStr(30));
  const [toDate, setToDate] = useState(todayStr());
  const [compare, setCompare] = useState("prev");
  const [view, setView] = useState(params?.get("view") || "overview");
  const [ready, setReady] = useState(false);
  const [store, setStore] = useState({});            // loaded data, per view, for the current filter
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTruck, setSelectedTruck] = useState(null);
  const [selectedUnit, setSelectedUnit] = useState(null);

  // The status bands come from Fuel → Settings; set them before anything draws.
  useEffect(() => {
    apiRequest("/fuel-module/settings")
      .then((s) => setStatusBands(bandsFromSettings(s.settings)))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  async function fetchView(v, f = fromDate, t = toDate, cmp = compare) {
    const q = new URLSearchParams({ from_date: f, to_date: t }).toString();
    const prev = compareRange(f, t, cmp);
    const pq = prev ? new URLSearchParams({ from_date: prev.from, to_date: prev.to }).toString() : null;
    if (v === "overview") return { overview: await apiRequest(`/fuel-module/analysis/overview?${q}&compare=${cmp}`) };
    if (v === "trucks") {
      const [fleet, prevFleet, trends, exceptions] = await Promise.all([
        apiRequest(`/fuel-analysis/fleet?${q}`),
        pq ? apiRequest(`/fuel-analysis/fleet?${pq}`) : null,
        apiRequest(`/fuel-module/analysis/trends?to_date=${t}`),
        apiRequest(`/fuel-module/analysis/exceptions?${q}`),
      ]);
      return { fleet, prevFleet, trends, exceptions };
    }
    if (v === "equipment") {
      const [equipment, prevEquipment, trends] = await Promise.all([
        apiRequest(`/fuel-analysis/equipment?${q}`),
        pq ? apiRequest(`/fuel-analysis/equipment?${pq}`) : null,
        apiRequest(`/fuel-module/analysis/trends?to_date=${t}`),
      ]);
      return { equipment, prevEquipment, trends };
    }
    if (v === "exceptions") {
      const [exceptions, fleet, equipment] = await Promise.all([
        apiRequest(`/fuel-module/analysis/exceptions?${q}`),
        apiRequest(`/fuel-analysis/fleet?${q}`),
        apiRequest(`/fuel-analysis/equipment?${q}`),
      ]);
      return { exceptions, fleet, equipment };
    }
    if (v === "approvals") return { approvals: await apiRequest(`/fuel-module/analysis/approvals?${q}`) };
    return {};
  }

  async function run(v = view, reset = true) {
    setLoading(true); setError("");
    try {
      const got = await fetchView(v);
      setStore((s) => ({ ...(reset ? {} : s), [v]: got }));
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  useEffect(() => { if (ready) run(view); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ready]);

  function switchView(v) {
    setView(v); setSelectedTruck(null); setSelectedUnit(null); setError("");
    if (!store[v]) run(v, false);
  }

  const cur = store[view];
  const views = VIEWS;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h1 style={{ fontSize: 21, margin: 0 }}>360° fuel analysis</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>
          {view === "equipment"
            ? "Pumps, loaders, generators and vans — everything on an hour meter, so the figure is litres per running hour. Pumps also get litres per m³ pumped."
            : "Fuel consumption across the fleet and the plant, broken down by the factors behind it — built from real fuel fills, delivery trips and pump logs."}
        </div>
      </div>

      <div className="card field-input" style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", padding: "14px 16px" }}>
        <label style={{ fontSize: 11, color: "var(--slate)", fontWeight: 600 }}>From<input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ display: "block", marginTop: 5 }} /></label>
        <label style={{ fontSize: 11, color: "var(--slate)", fontWeight: 600 }}>To<input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ display: "block", marginTop: 5 }} /></label>
        <label style={{ fontSize: 11, color: "var(--slate)", fontWeight: 600 }}>Compare with
          <select value={compare} onChange={(e) => setCompare(e.target.value)} style={{ display: "block", marginTop: 5 }}>
            <option value="prev">The period just before</option><option value="year">Same dates last year</option><option value="none">No comparison</option>
          </select>
        </label>
        <button type="button" className="btn-primary" onClick={() => { setSelectedTruck(null); setSelectedUnit(null); run(view, true); }} disabled={loading}>{loading ? "Loading…" : "Filter"}</button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="tablist" aria-label="Analysis views">
        {views.map((v) => (
          <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={`btn-tab ${view === v.key ? "active" : ""}`} onClick={() => switchView(v.key)}>
            {v.label}{v.isNew && <NewTag />}
          </button>
        ))}
      </div>

      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {!cur && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}

      {cur && view === "overview" && <Overview data={cur.overview} />}
      {cur && view === "trucks" && (
        <Trucks fleet={cur.fleet} prevFleet={cur.prevFleet} trends={cur.trends} exceptions={cur.exceptions} from={fromDate} to={toDate}
          selected={selectedTruck} onPick={setSelectedTruck} onBack={() => setSelectedTruck(null)} />
      )}
      {cur && view === "equipment" && (
        <Equipment data={cur.equipment} prevData={cur.prevEquipment} trends={cur.trends} from={fromDate} to={toDate}
          selected={selectedUnit} onPick={setSelectedUnit} onBack={() => setSelectedUnit(null)} />
      )}
      {cur && view === "exceptions" && (
        <Exceptions data={cur.exceptions} fleet={cur.fleet} equipment={cur.equipment}
          canReview={can("fuel.exception-review", "edit")} onReviewed={() => run("exceptions", false)}
          openLedger={can("fuel.transactions") ? (ref) => go("transactions", { q: ref, from: fromDate, to: toDate }) : null} />
      )}
      {cur && view === "approvals" && <Approvals data={cur.approvals} />}
    </div>
  );
}
