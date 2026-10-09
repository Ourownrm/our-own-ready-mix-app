import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  TankGraphic, tankStatus, fmtL, fmtRs, fmtNum, fmtDate, fmtWhen, Kpi, pctChange,
  KIND, CATEGORY_COLOURS, CATEGORY_LABELS,
} from "./fuelUi.jsx";

// Round 199 — the Fuel dashboard: the tank as a picture, how long it will last,
// what went in and out, and the latest entries.

function LevelChart({ days, capacity, reorder }) {
  if (!days?.length) return null;
  const top = Math.max(capacity || 0, ...days.map((d) => d.closing), reorder || 0) * (capacity ? 1 : 1.15) || 1;
  const W = 640, H = 210, L = 46, R = 10, T = 14, B = 30;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, days.length - 1);
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
  const line = days.map((d, i) => `${x(i)},${y(d.closing)}`).join(" ");
  const area = `${line} ${x(days.length - 1)},${y(0)} ${x(0)},${y(0)}`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", marginTop: 8 }} role="img" aria-label="Tank closing balance for the last 14 days">
      {grid.map((g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke={g === 0 ? "var(--border-strong)" : "#ECEAE4"} />
          <text x={L - 6} y={y(g) + 4} textAnchor="end" fontSize="10" fill="var(--slate)">{g >= 1000 ? `${fmtNum(g / 1000, 1)}k` : fmtNum(g)}</text>
        </g>
      ))}
      {reorder != null && <line x1={L} x2={W - R} y1={y(reorder)} y2={y(reorder)} stroke="var(--alert-red)" strokeWidth="1.5" strokeDasharray="6 4" />}
      <polygon points={area} fill="var(--info)" opacity="0.1" />
      <polyline points={line} fill="none" stroke="var(--info)" strokeWidth="2.5" strokeLinejoin="round" />
      {days.map((d, i) => (
        <g key={d.day}>
          <circle cx={x(i)} cy={y(d.closing)} r={d.received ? 6 : 3.5} fill={d.received ? "var(--signal-green)" : "var(--info)"} stroke="#fff" strokeWidth="1.5">
            <title>{`${fmtDate(d.day)}: closing ${fmtL(d.closing)}${d.received ? `, received ${fmtL(d.received)}` : ""}`}</title>
          </circle>
          {d.received > 0 && <text x={x(i)} y={y(d.closing) - 11} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="var(--signal-green)">+{fmtNum(d.received)}</text>}
          <text x={x(i)} y={H - 10} textAnchor="middle" fontSize="9.5" fill="var(--slate)">{d.day.slice(8)}</text>
        </g>
      ))}
    </svg>
  );
}

function IssueBars({ days }) {
  const max = Math.max(1, ...days.map((d) => d.truck + d.pump + d.equipment));
  const h = 150;
  const seg = (v, c, first) => ({ height: v > 0 ? Math.max(2, (v / max) * h) : 0, background: c, borderRadius: first ? "3px 3px 0 0" : 0 });
  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: h + 18, marginTop: 14, borderBottom: "1px solid var(--border-strong)" }}>
        {days.map((d) => {
          const total = d.truck + d.pump + d.equipment;
          const order = [["equipment", d.equipment], ["pump", d.pump], ["truck", d.truck]].filter(([, v]) => v > 0);
          return (
            <div key={d.day} title={`${fmtDate(d.day)}: ${fmtL(total)}`}
              style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 2, minWidth: 0, height: "100%" }}>
              <div style={{ fontSize: 9.5, color: "var(--slate)", fontVariantNumeric: "tabular-nums" }}>{total ? fmtNum(total) : ""}</div>
              <div style={{ width: "100%", maxWidth: 30, display: "flex", flexDirection: "column", gap: 2 }}>
                {order.map(([k, v], i) => <div key={k} style={seg(v, CATEGORY_COLOURS[k], i === 0)} />)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
        {days.map((d) => <div key={d.day} style={{ flex: "1 1 0", textAlign: "center", fontSize: 9.5, color: "var(--slate)" }}>{d.day.slice(8)}</div>)}
      </div>
    </>
  );
}

export function LedgerKind({ kind }) {
  const k = KIND[kind] || KIND.issue;
  return <span className={`badge ${k.cls}`} style={{ whiteSpace: "nowrap" }}>{k.label}</span>;
}

export default function FuelDashboard({ go }) {
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/fuel-module/dashboard").then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading the fuel dashboard…</div>;

  const { tank, settings: s, month, pending } = data;
  const status = tankStatus(tank, s);
  const cap = s.capacity_l;
  const avgChange = pctChange(tank.avg_daily_7, tank.prev_avg_daily_7);
  const waitingPurchase = pending.purchases[0];
  const showAlert = status.key === "critical" || status.key === "low";
  const isAdmin = can("fuel.settings", "edit");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Diesel stock</h1>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>{s.tank_name} · as of {fmtWhen(new Date())}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {can("fuel.issue") && <button type="button" className="btn-primary" onClick={() => go("issue")}>Issue fuel</button>}
          {can("fuel.purchases") && <button type="button" onClick={() => go("purchases")}>Purchases &amp; deliveries</button>}
          {can("fuel.transactions") && <button type="button" onClick={() => go("transactions")}>All transactions</button>}
        </div>
      </div>

      {(cap == null || s.reorder_level_l == null) && (
        <div className="open-q">
          <b>The tank isn't set up yet.</b> {cap == null ? "Capacity" : "Reorder level"} has not been entered, so the tank picture and the reorder alert can't work.
          {isAdmin ? <> Set it in <button type="button" onClick={() => go("settings")} style={{ padding: "2px 8px", fontSize: 12 }}>Settings</button>.</> : " An Administrator sets it in Fuel → Settings."}
        </div>
      )}

      {showAlert && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", background: status.bg, border: `1px solid ${status.ink}`, borderRadius: "var(--radius)", padding: "12px 14px", fontSize: 13 }}>
          <div style={{ flex: "1 1 260px" }}>
            <b style={{ color: status.ink }}>
              {status.key === "critical" ? "Diesel is below the reorder level." : `Diesel will reach the reorder level in about ${fmtNum(tank.days_to_reorder, 1)} days.`}
            </b>{" "}
            <span style={{ color: "var(--slate)" }}>
              At the 7-day average of {fmtL(tank.avg_daily_7)}/day.{" "}
              {waitingPurchase
                ? `Purchase FPR-${waitingPurchase.id} for ${fmtL(waitingPurchase.approved_qty ?? waitingPurchase.requested_qty)} is ${waitingPurchase.status === "pending" ? "waiting for approval" : "approved, waiting for delivery"}.`
                : "No purchase has been requested yet."}
            </span>
          </div>
          {can("fuel.purchases") && <button type="button" onClick={() => go("purchases")}>{waitingPurchase ? "View purchase" : "Request purchase"}</button>}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <section className="card" style={{ flex: "1 1 400px", display: "flex", flexWrap: "wrap", gap: "8px 20px", alignItems: "center" }}>
          <div style={{ flex: "1 1 100%", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="kpi-label">Tank level</div>
            <span className="badge" style={{ background: status.bg, color: status.ink }}>{status.label}</span>
          </div>
          <TankGraphic current={tank.current_qty} capacity={cap} reorder={s.reorder_level_l} statusKey={status.key} width={250} />
          <div style={{ flex: "1 1 180px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {fmtNum(tank.current_qty)} <span style={{ fontSize: 15, fontWeight: 600, color: "var(--slate)" }}>L</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>{cap ? `of ${fmtL(cap)} capacity` : "capacity not set"}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px 14px", fontSize: 12.5 }}>
              <div><div style={{ color: "var(--slate)" }}>Empty space</div><div style={{ fontWeight: 700, fontSize: 15 }}>{cap ? fmtL(Math.max(0, cap - tank.current_qty)) : "—"}</div></div>
              <div><div style={{ color: "var(--slate)" }}>Above reorder</div><div style={{ fontWeight: 700, fontSize: 15 }}>{s.reorder_level_l != null ? fmtL(Math.max(0, tank.current_qty - s.reorder_level_l)) : "—"}</div></div>
              <div><div style={{ color: "var(--slate)" }}>Days of cover</div><div style={{ fontWeight: 700, fontSize: 15 }}>{tank.days_of_cover != null ? `${fmtNum(tank.days_of_cover, 1)} days` : "—"}</div></div>
              <div><div style={{ color: "var(--slate)" }}>To reorder level</div><div style={{ fontWeight: 700, fontSize: 15 }}>{tank.days_to_reorder == null ? "—" : tank.days_to_reorder <= 0 ? "Now" : `${fmtNum(tank.days_to_reorder, 1)} days`}</div></div>
            </div>
            {data.last_delivery && (
              <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "10px 12px", fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700 }}>Last delivery · {fmtWhen(data.last_delivery.received_at)}</div>
                <div>+{fmtL(data.last_delivery.received_qty)}{data.last_delivery.supplier_name ? ` from ${data.last_delivery.supplier_name}` : ""}{data.last_delivery.unit_cost != null ? ` at ${fmtRs(data.last_delivery.unit_cost, 2)}/L` : ""}</div>
              </div>
            )}
          </div>
        </section>

        <section style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <Kpi label="Issued today" value={fmtL(data.today_issued)} sub="from the plant tank" />
            <Kpi label="7-day avg / day" value={fmtL(tank.avg_daily_7)}>
              {avgChange != null && <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 2, color: avgChange <= 0 ? "var(--signal-green)" : "var(--slate)" }}>
                {avgChange > 0 ? "+" : "−"}{fmtNum(Math.abs(avgChange), 0)}% vs previous 7 days</div>}
            </Kpi>
            <Kpi label="Received this month" value={fmtL(month.received)} sub={`${month.deliveries} deliver${month.deliveries === 1 ? "y" : "ies"} · ${fmtRs(month.received_value)}`} />
            <Kpi label="Issued this month" value={fmtL(month.issued)} sub={`${fmtRs(month.issued_value)} · plus ${fmtL(month.outside.litres)} outside`} />
            <Kpi label="Fuel per m³" value={month.litres_per_m3 != null ? `${fmtNum(month.litres_per_m3, 2)} L` : "—"}
              sub={month.cost_per_m3 != null ? `${fmtRs(month.cost_per_m3)}/m³ · ${fmtNum(month.m3_produced)} m³ produced` : "no production this month yet"} />
            <Kpi label="Waiting" value={`${pending.awaiting_approval + pending.awaiting_issue} · ${pending.purchases.length}`}
              sub="fuel requests · purchases" />
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div className="kpi-label">Tank level · last 14 days</div>
                <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>Closing balance each day; green markers are deliveries received</div>
              </div>
              <div className="legend" style={{ margin: 0 }}>
                <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--info)", height: 3 }} />Balance</span>
                {s.reorder_level_l != null && <span className="legend-item"><span style={{ width: 14, borderTop: "2px dashed var(--alert-red)", display: "inline-block" }} />Reorder</span>}
                <span className="legend-item"><span className="legend-swatch" style={{ background: "var(--signal-green)", borderRadius: "50%" }} />Delivery</span>
              </div>
            </div>
            <LevelChart days={data.days} capacity={cap} reorder={s.reorder_level_l} />
          </div>
        </section>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <section className="card" style={{ flex: "1 1 520px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div className="kpi-label">Daily issues by category</div>
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>Litres issued from the plant tank (outside-station fills not included)</div>
            </div>
            <div className="legend" style={{ margin: 0 }}>
              {Object.keys(CATEGORY_COLOURS).map((k) => (
                <span key={k} className="legend-item"><span className="legend-swatch" style={{ background: CATEGORY_COLOURS[k] }} />{CATEGORY_LABELS[k]}</span>
              ))}
            </div>
          </div>
          <IssueBars days={data.days} />
        </section>

        <section className="card" style={{ flex: "1 1 380px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <div className="kpi-label">Top consumers · this month</div>
            {can("reports.fuel-analysis") && <button type="button" onClick={() => go("analysis")} style={{ fontSize: 12, padding: "6px 10px" }}>360° analysis</button>}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Vehicle / machine</th><th style={{ textAlign: "right" }}>Litres</th><th style={{ textAlign: "right" }}>Cost</th><th style={{ textAlign: "right" }}>Fills</th></tr></thead>
              <tbody>
                {data.top.map((t) => (
                  <tr key={`${t.category}-${t.unit_id}`}>
                    <td><b>{t.unit_label || "—"}</b><div style={{ fontSize: 11, color: "var(--slate)" }}>{t.unit_sub}</div></td>
                    <td style={{ textAlign: "right" }}>{fmtNum(t.litres)}</td>
                    <td style={{ textAlign: "right" }}>{fmtRs(t.cost)}</td>
                    <td style={{ textAlign: "right" }}>{t.fills}</td>
                  </tr>
                ))}
                {data.top.length === 0 && <tr><td colSpan={4} style={{ color: "var(--slate)" }}>No fuel issued this month yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div className="kpi-label">Recent transactions</div>
          {can("fuel.transactions") && <button type="button" onClick={() => go("transactions")} style={{ fontSize: 12, padding: "6px 10px" }}>All transactions</button>}
        </div>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ minWidth: 820 }}>
            <thead><tr><th>When</th><th>Type</th><th>Vehicle / supplier</th><th>Reading</th><th style={{ textAlign: "right" }}>In</th><th style={{ textAlign: "right" }}>Out</th><th style={{ textAlign: "right" }}>Balance</th><th>By</th><th>Ref</th></tr></thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={`${r.kind}-${r.txn_id ?? r.sr_id}`} style={r.kind === "external" ? { color: "var(--slate)" } : undefined}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.at)}</td>
                  <td><LedgerKind kind={r.kind} /></td>
                  <td><b>{r.unit_label}</b>{r.kind === "external" && r.station_name ? ` at ${r.station_name}` : ""}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.reading ? `${fmtNum(r.reading.value, r.reading.unit === "hrs" ? 1 : 0)} ${r.reading.unit}` : "—"}
                    {r.consumption && <> · <b>{fmtNum(r.consumption.value, 1)} {r.consumption.unit}</b></>}
                  </td>
                  <td style={{ textAlign: "right" }}>{r.in_qty != null ? fmtNum(r.in_qty) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{r.out_qty != null ? (r.kind === "external" ? `(${fmtNum(r.out_qty)})` : fmtNum(r.out_qty)) : "—"}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{r.balance_after != null ? fmtNum(r.balance_after) : "not from tank"}</td>
                  <td>{r.done_by_name || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.ref}</td>
                </tr>
              ))}
              {data.recent.length === 0 && <tr><td colSpan={9} style={{ color: "var(--slate)" }}>No fuel transactions yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
