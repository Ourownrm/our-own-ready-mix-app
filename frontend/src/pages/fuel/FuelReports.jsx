import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { daysAgoStr, monthStartStr, todayStr } from "../../lib/istDate.js";
import { fmtL, fmtRs, fmtNum, fmtDate, exportXlsx } from "./fuelUi.jsx";

// Round 199 — the stock statement: opening + deliveries − issues ± Manager
// adjustments = closing, for any range, by day, week or month. No dip
// readings (the user's decision) — the closing is the ledger's own balance.

function Waterfall({ s }) {
  // Round 217 — outside fills are bought and issued at once (in and out, the
  // tank never sees them); an adjustment down counts as issued, up as added.
  const o = s.outside.litres;
  const a = s.opening;
  const b = a + s.received;
  const c = b + o;
  const d = c + s.adj_in;
  const e = d - s.issued;
  const f = e - o;
  const steps = [
    { label: `Opening`, from: 0, to: a, colour: "#8A8478", val: fmtL(a) },
    { label: `+ Delivered into tank (${s.deliveries})`, from: a, to: b, colour: "var(--signal-green)", val: `+${fmtNum(s.received)}` },
    { label: `+ Bought outside (${s.outside.fills})`, from: b, to: c, colour: "#5FA382", val: `+${fmtNum(o)}` },
    { label: "+ Stock added (adjustment)", from: c, to: d, colour: "var(--violet)", val: `+${fmtNum(s.adj_in)}` },
    { label: "− Issued from tank", from: d, to: e, colour: "var(--info)", val: `−${fmtNum(s.issued)}` },
    { label: "− Issued at outside stations", from: e, to: f, colour: "#6E9FBD", val: `−${fmtNum(o)}` },
    { label: "− Issued (adjustment)", from: f, to: s.closing, colour: "var(--alert-red)", val: `−${fmtNum(s.adj_out)}` },
    { label: "= Closing", from: 0, to: s.closing, colour: "var(--charcoal)", val: fmtL(s.closing) },
  ];
  const max = Math.max(1, ...steps.map((x) => Math.max(x.from, x.to)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 16 }}>
      {steps.map((x) => {
        const lo = Math.min(x.from, x.to), w = Math.abs(x.to - x.from);
        return (
          <div key={x.label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 190, flex: "none", fontSize: 12.5, fontWeight: 600 }}>{x.label}</div>
            <div style={{ flex: 1, position: "relative", height: 24, background: "var(--concrete)", borderRadius: 4 }}>
              <div style={{ position: "absolute", top: 0, bottom: 0, left: `${(Math.max(0, lo) / max) * 100}%`, width: `${Math.max(w > 0 ? 0.5 : 0, (w / max) * 100)}%`, background: x.colour, borderRadius: 4 }} />
            </div>
            <div style={{ width: 96, flex: "none", textAlign: "right", fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{x.val}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function FuelReports({ go }) {
  const { can } = usePermissions();
  const [from, setFrom] = useState(monthStartStr());
  const [to, setTo] = useState(todayStr());
  const [group, setGroup] = useState("week");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(f = from, t = to, g = group) {
    setLoading(true); setError("");
    try { setData(await apiRequest(`/fuel-module/stock-statement?from_date=${f}&to_date=${t}&group=${g}`)); }
    catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function preset(f, t, g) { setFrom(f); setTo(t); setGroup(g); load(f, t, g); }

  const s = data?.summary;
  const COLS = ["received", "outside", "adj_in", "purchased_total", "issued", "adj_out", "issued_total", "received_value", "outside_value", "issued_value"];
  const totals = data?.rows.reduce((a, r) => Object.fromEntries(COLS.map((k) => [k, (a[k] || 0) + (r[k] || 0)])), {});

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      <aside className="card" style={{ flex: "1 1 220px", padding: 10 }}>
        <div className="kpi-label" style={{ padding: "8px 10px 6px" }}>Reports</div>
        <div style={{ padding: "10px 10px", borderRadius: 8, background: "#FFF1E6", color: "var(--rebar-dark)", fontWeight: 600, fontSize: 13 }}>
          Stock statement<div style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>Opening, in, out, adjustments, closing</div>
        </div>
        {can("reports.fuel-analysis") && (
          <button type="button" onClick={() => go("analysis")} style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "none", padding: "10px 10px", fontWeight: 600 }}>
            360° fuel analysis<div style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>Consumption by truck and machine, exceptions</div>
          </button>
        )}
        {can("fuel.transactions") && (
          <button type="button" onClick={() => go("transactions")} style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "none", padding: "10px 10px", fontWeight: 600 }}>
            Transaction ledger<div style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>Every entry, with Excel export</div>
          </button>
        )}
        {can("reports.fuel") && (
          <Link to="/fuel-report" style={{ display: "block", padding: "10px 10px", fontWeight: 600, fontSize: 13, color: "var(--charcoal)", textDecoration: "none" }}>
            Fuel and lubricant request report<div style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>Request-by-request, PDF and Excel</div>
          </Link>
        )}
      </aside>

      <div style={{ flex: "999 1 640px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="card field-input" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", padding: "14px 16px" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 100%" }}>
            <button type="button" onClick={() => preset(monthStartStr(), todayStr(), "week")}>This month</button>
            <button type="button" onClick={() => preset(daysAgoStr(29), todayStr(), "day")}>Last 30 days, by day</button>
            <button type="button" onClick={() => preset(daysAgoStr(180), todayStr(), "month")}>Last 6 months, by month</button>
          </div>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ display: "block", marginTop: 4 }} /></label>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ display: "block", marginTop: 4 }} /></label>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>Group by
            <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ display: "block", marginTop: 4 }}>
              <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
            </select>
          </label>
          <button type="button" className="btn-primary" disabled={loading} onClick={() => load()}>{loading ? "Loading…" : "Show"}</button>
          <button type="button" disabled={!data} onClick={() => exportXlsx(data.rows.map((r) => ({
            From: r.from_date, To: r.to_date, "Opening (L)": r.opening,
            "Delivered into tank (L)": r.received, "Bought outside (L)": r.outside, "Stock added - adjustment (L)": r.adj_in, "Total in (L)": r.purchased_total + r.adj_in,
            "Issued from tank (L)": r.issued, "Issued outside (L)": r.outside, "Issued - adjustment (L)": r.adj_out, "Total issued (L)": r.issued_total,
            "Closing (L)": r.closing, "Purchase value (Rs)": r.received_value + r.outside_value, "Issue value (Rs)": r.issued_value + r.outside_value,
          })), "Stock statement", `Fuel_Stock_Statement_${from}_to_${to}.xlsx`)}>Export Excel</button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}

        {data && s && (
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
              <div>
                <h2 style={{ fontSize: 16 }}>Stock statement · {fmtDate(data.from_date)} – {fmtDate(data.to_date)}</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>Opening + bought (tank and outside) + stock added − issued (tank, outside and adjustments down) = closing</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="badge badge-success">Bought {fmtL(s.purchased_total)}</span>
                <span className="badge badge-info">Issued {fmtL(s.issued_total)}</span>
                {s.adjustments > 0 && <span className="badge badge-progress">{s.adjustments} adjustment{s.adjustments === 1 ? "" : "s"}</span>}
              </div>
            </div>
            <Waterfall s={s} />
            <div style={{ overflowX: "auto", marginTop: 20 }}>
              <table style={{ minWidth: 1120 }}>
                <thead>
                  <tr>
                    <th rowSpan={2}>Period</th><th rowSpan={2} style={{ textAlign: "right" }}>Opening</th>
                    <th colSpan={3} style={{ textAlign: "center", borderBottom: "1px solid var(--border)" }}>In</th>
                    <th colSpan={4} style={{ textAlign: "center", borderBottom: "1px solid var(--border)" }}>Issued</th>
                    <th rowSpan={2} style={{ textAlign: "right" }}>Closing</th>
                    <th rowSpan={2} style={{ textAlign: "right" }}>Purchase value</th><th rowSpan={2} style={{ textAlign: "right" }}>Issue value</th>
                  </tr>
                  <tr>
                    <th style={{ textAlign: "right" }}>Into tank</th><th style={{ textAlign: "right" }}>Outside</th><th style={{ textAlign: "right" }}>Adj. +</th>
                    <th style={{ textAlign: "right" }}>From tank</th><th style={{ textAlign: "right" }}>Outside</th><th style={{ textAlign: "right" }}>Adj. −</th><th style={{ textAlign: "right" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.from_date}>
                      <td>{r.from_date === r.to_date ? fmtDate(r.from_date) : `${fmtDate(r.from_date)} – ${fmtDate(r.to_date)}`}</td>
                      <td style={{ textAlign: "right" }}>{fmtNum(r.opening)}</td>
                      <td style={{ textAlign: "right" }}>{r.received ? fmtNum(r.received) : "–"}</td>
                      <td style={{ textAlign: "right" }}>{r.outside ? fmtNum(r.outside) : "–"}</td>
                      <td style={{ textAlign: "right" }}>{r.adj_in ? fmtNum(r.adj_in) : "–"}</td>
                      <td style={{ textAlign: "right" }}>{r.issued ? fmtNum(r.issued) : "–"}</td>
                      <td style={{ textAlign: "right" }}>{r.outside ? fmtNum(r.outside) : "–"}</td>
                      <td style={{ textAlign: "right" }}>{r.adj_out ? fmtNum(r.adj_out) : "–"}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>{r.issued_total ? fmtNum(r.issued_total) : "–"}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtNum(r.closing)}</td>
                      <td style={{ textAlign: "right" }}>{r.received_value + r.outside_value ? fmtRs(r.received_value + r.outside_value) : "–"}</td>
                      <td style={{ textAlign: "right" }}>{r.issued_value + r.outside_value ? fmtRs(r.issued_value + r.outside_value) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td><td style={{ textAlign: "right" }}>{fmtNum(s.opening)}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(totals.received)}</td><td style={{ textAlign: "right" }}>{fmtNum(totals.outside)}</td><td style={{ textAlign: "right" }}>{fmtNum(totals.adj_in)}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(totals.issued)}</td><td style={{ textAlign: "right" }}>{fmtNum(totals.outside)}</td><td style={{ textAlign: "right" }}>{fmtNum(totals.adj_out)}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(totals.issued_total)}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(s.closing)}</td>
                    <td style={{ textAlign: "right" }}>{fmtRs(totals.received_value + totals.outside_value)}</td><td style={{ textAlign: "right" }}>{fmtRs(totals.issued_value + totals.outside_value)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 10 }}>
              Outside-station fills are bought and issued at the same moment, straight into the vehicle — they appear under both In and Issued and never change the tank balance.
              An adjustment that lowers the stock is counted as fuel issued; one that raises it is counted as stock added.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
