import { Fragment, useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { useAuth } from "../../lib/AuthContext.jsx";
import { daysAgoStr, todayStr } from "../../lib/istDate.js";
import { fmtL, fmtRs, fmtNum, fmtWhen, KIND, exportXlsx } from "./fuelUi.jsx";
import { LedgerKind } from "./FuelDashboard.jsx";

// Round 199 — one ledger for every litre in and out of the tank, with a
// running balance, plus outside-station fills (which never touch the tank).
// Open a row for who asked, who approved, who issued, and how its
// consumption was worked out.

const CHIPS = [["", "All"], ["issue", "Plant issues"], ["receipt", "Deliveries"], ["external", "Outside fills"], ["adjustment", "Adjustments"]];
const ADJUST_ROLES = ["manager", "administrator", "super_admin"];

function Detail({ r }) {
  const c = r.calc || {};
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 28 }}>
      <div style={{ flex: "1 1 280px" }}>
        <div className="kpi-label" style={{ marginBottom: 10 }}>Trail</div>
        <div className="timeline">
          {(r.trail || []).map((t, i) => (
            <div key={i} className="timeline-item">
              <span className="timeline-dot" />
              <div className="timeline-action"><b>{t.step}</b>{t.who ? ` · ${t.who}` : ""}</div>
              <div className="timeline-meta">{fmtWhen(t.at)}{t.note ? ` · ${t.note}` : ""}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: "1 1 280px" }}>
        <div className="kpi-label" style={{ marginBottom: 10 }}>{r.kind === "issue" || r.kind === "external" ? "Fill-to-fill working" : "Balance"}</div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", fontSize: 12.5 }}>
          {(r.kind === "issue" || r.kind === "external") && (
            c.prev_reading != null ? (
              <>
                <span style={{ color: "var(--slate)" }}>Previous fill</span>
                <span style={{ fontWeight: 600 }}>{fmtWhen(c.prev_at)} · {fmtNum(c.prev_reading, c.interval_unit === "hrs" ? 1 : 0)} {c.interval_unit}</span>
                <span style={{ color: "var(--slate)" }}>{c.interval_unit === "km" ? "Distance since" : "Hours since"}</span>
                <span style={{ fontWeight: 600 }}>{c.interval != null ? `${fmtNum(c.interval, 1)} ${c.interval_unit}` : "reading not higher than last time"}</span>
                <span style={{ color: "var(--slate)" }}>Consumption</span>
                <span style={{ fontWeight: 600 }}>
                  {r.consumption
                    ? c.interval_unit === "km"
                      ? `${fmtNum(c.litres)} L ÷ ${fmtNum(c.interval, 1)} km × 100 = ${fmtNum(r.consumption.value, 1)} L/100km`
                      : `${fmtNum(c.litres)} L ÷ ${fmtNum(c.interval, 1)} hrs = ${fmtNum(r.consumption.value, 2)} L/hr`
                    : "—"}
                </span>
              </>
            ) : (
              <><span style={{ color: "var(--slate)" }}>Previous fill</span><span>None with a meter reading — this is the first one, so there is nothing to measure against.</span></>
            )
          )}
          {r.kind === "receipt" && (
            <>
              <span style={{ color: "var(--slate)" }}>Ordered</span><span style={{ fontWeight: 600 }}>{fmtL(c.ordered)}</span>
              <span style={{ color: "var(--slate)" }}>Received</span><span style={{ fontWeight: 600 }}>{fmtL(c.received)}</span>
              <span style={{ color: "var(--slate)" }}>Balance before → after</span><span style={{ fontWeight: 600 }}>{fmtL(c.balance_before)} → {fmtL(r.balance_after)}</span>
            </>
          )}
          {r.kind === "adjustment" && (
            <>
              <span style={{ color: "var(--slate)" }}>Book before</span><span style={{ fontWeight: 600 }}>{fmtL(c.balance_before)}</span>
              <span style={{ color: "var(--slate)" }}>Counted</span><span style={{ fontWeight: 600 }}>{fmtL(r.balance_after)}</span>
              <span style={{ color: "var(--slate)" }}>Change</span><span style={{ fontWeight: 600 }}>{c.change > 0 ? "+" : ""}{fmtL(c.change)}</span>
            </>
          )}
          {r.rate != null && (<><span style={{ color: "var(--slate)" }}>Rate</span><span style={{ fontWeight: 600 }}>{fmtRs(r.rate, 2)}/L{r.value != null ? ` · ${fmtRs(r.value)}` : ""}</span></>)}
        </div>
      </div>
    </div>
  );
}

function AdjustForm({ itemId, current, onDone, onCancel }) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  async function save() {
    setSaving(true); setErr("");
    try {
      await apiRequest(`/store-stock/items/${itemId}/adjust`, { method: "POST", body: { counted_qty: counted, note } });
      onDone();
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  }
  return (
    <div className="card field-input" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", borderColor: "var(--violet)" }}>
      <div style={{ flex: "1 1 100%", fontSize: 13 }}>
        <b>Adjust the tank balance after a physical count.</b> Book balance now: <b>{fmtL(current)}</b>. The change is recorded in this ledger with your reason.
      </div>
      <label style={{ fontSize: 12, color: "var(--slate)" }}>Counted litres
        <input type="number" min="0" value={counted} onChange={(e) => setCounted(e.target.value)} style={{ display: "block", marginTop: 4, width: 150 }} />
      </label>
      <label style={{ fontSize: 12, color: "var(--slate)", flex: "1 1 240px" }}>Reason
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Month-end physical count" style={{ display: "block", marginTop: 4 }} />
      </label>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn-primary" disabled={saving || counted === "" || !note.trim()} onClick={save}>{saving ? "Saving…" : "Save adjustment"}</button>
      {err && <div style={{ flex: "1 1 100%", color: "var(--alert-red)", fontSize: 12.5 }}>{err}</div>}
    </div>
  );
}

export default function FuelTransactions({ params }) {
  const { user } = useAuth();
  const [from, setFrom] = useState(params.get("from") || daysAgoStr(30));
  const [to, setTo] = useState(params.get("to") || todayStr());
  const [kind, setKind] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState("");
  const [q, setQ] = useState(params.get("q") || "");
  const [page, setPage] = useState(1);
  const [units, setUnits] = useState([]);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [item, setItem] = useState(null);
  const [adjusting, setAdjusting] = useState(false);
  const canAdjust = user && ADJUST_ROLES.includes(user.role);

  function qs(p = page, limit = 50) {
    const s = new URLSearchParams({ from_date: from, to_date: to, page: String(p), limit: String(limit) });
    if (kind) s.set("kind", kind);
    if (category) s.set("category", category);
    if (unit) s.set("unit", unit);
    if (q.trim()) s.set("q", q.trim());
    return s.toString();
  }

  async function load(p = 1) {
    setLoading(true); setError("");
    try {
      const d = await apiRequest(`/fuel-module/transactions?${qs(p)}`);
      setData(d); setPage(p);
      if (d.rows.length === 1) setOpen(`${d.rows[0].kind}-${d.rows[0].txn_id ?? d.rows[0].sr_id}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  useEffect(() => {
    apiRequest("/fuel-module/units").then(setUnits).catch(() => {});
    apiRequest("/fuel-module/settings").then((s) => setItem(s.item)).catch(() => {});
  }, []);
  // Filters apply as they change; dates and the search box wait for "Show".
  useEffect(() => { load(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, category, unit]);

  async function exportExcel() {
    setExporting(true);
    try {
      const all = [];
      for (let p = 1; p <= 25; p++) {
        const d = await apiRequest(`/fuel-module/transactions?${qs(p, 200)}`);
        all.push(...d.rows);
        if (all.length >= d.total || !d.rows.length) break;
      }
      await exportXlsx(all.map((r) => ({
        "Date & time": fmtWhen(r.at), Ref: r.ref, Type: KIND[r.kind]?.label || r.kind,
        "Vehicle / machine / supplier": r.unit_label, Detail: r.unit_sub || "",
        Station: r.station_name || "",
        Reading: r.reading ? `${r.reading.value} ${r.reading.unit}` : "",
        Consumption: r.consumption ? `${r.consumption.value} ${r.consumption.unit}` : "",
        "In (L)": r.in_qty ?? "", "Out (L)": r.out_qty ?? "",
        "Balance (L)": r.balance_after ?? (r.kind === "external" ? "not from tank" : ""),
        "Rate (Rs/L)": r.rate ?? "", "Value (Rs)": r.value ?? "", "Done by": r.done_by_name || "", Note: r.note || "",
      })), "Fuel transactions", `Fuel_Transactions_${from}_to_${to}.xlsx`);
    } catch (e) { setError(e.message || "Couldn't export."); } finally { setExporting(false); }
  }

  const s = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Fuel transactions</h1>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>Every litre in and out of the tank, with a running balance</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canAdjust && item && <button type="button" onClick={() => setAdjusting((v) => !v)}>Adjust stock</button>}
          <button type="button" onClick={exportExcel} disabled={exporting || !data}>{exporting ? "Exporting…" : "Export Excel"}</button>
        </div>
      </div>

      {adjusting && item && (
        <AdjustForm itemId={item.id} current={s?.current ?? item.current_qty}
          onCancel={() => setAdjusting(false)} onDone={() => { setAdjusting(false); load(1); }} />
      )}

      <form className="card field-input" onSubmit={(e) => { e.preventDefault(); load(1); }}
        style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", padding: "14px 16px" }}>
        <label style={{ fontSize: 12, color: "var(--slate)" }}>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ display: "block", marginTop: 4 }} /></label>
        <label style={{ fontSize: 12, color: "var(--slate)" }}>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ display: "block", marginTop: 4 }} /></label>
        <label style={{ fontSize: 12, color: "var(--slate)", minWidth: 170 }}>Category
          <select value={category} onChange={(e) => { setCategory(e.target.value); setUnit(""); }} style={{ display: "block", marginTop: 4 }}>
            <option value="">All categories</option><option value="truck">Trucks</option><option value="pump">Pumps</option><option value="equipment">Plant equipment &amp; DG</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--slate)", minWidth: 190 }}>Vehicle / machine
          <select value={unit} onChange={(e) => setUnit(e.target.value)} style={{ display: "block", marginTop: 4 }}>
            <option value="">All vehicles &amp; machines</option>
            {units.filter((u) => !category || u.category === category).map((u) => (
              <option key={`${u.category}:${u.unit_id}`} value={`${u.category}:${u.unit_id}`}>{u.unit_label} · {u.unit_sub}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--slate)", flex: "1 1 200px" }}>Search
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ref, vehicle, person, supplier…" style={{ display: "block", marginTop: 4 }} />
        </label>
        <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Loading…" : "Show"}</button>
      </form>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} role="group" aria-label="Transaction type">
        {CHIPS.map(([k, label]) => (
          <button key={k || "all"} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
            className={`btn-tab ${kind === k ? "active" : ""}`} style={{ borderRadius: 20, padding: "8px 14px" }}>{label}</button>
        ))}
      </div>

      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}

      {s && (
        <section className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {[
              ["Opening", fmtL(s.opening), null, "var(--charcoal)"],
              ["+ Received", fmtL(s.received), `${s.deliveries} deliver${s.deliveries === 1 ? "y" : "ies"} · ${fmtRs(s.received_value)}`, "var(--signal-green)"],
              ["− Issued from tank", fmtL(s.issued), `${s.issues} fills · ${fmtRs(s.issued_value)}`, "var(--info)"],
              ["± Adjustments", `${s.adjusted > 0 ? "+" : ""}${fmtL(s.adjusted)}`, `${s.adjustments} by Manager`, "var(--violet)"],
              ["= Closing", fmtL(s.closing), null, "var(--charcoal)"],
              ["Outside stations", fmtL(s.outside.litres), `${s.outside.fills} fills · not from tank`, "var(--slate)"],
            ].map(([label, value, sub, colour], i) => (
              <div key={label} style={{ padding: "13px 16px", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)", background: i >= 4 ? "#FAF9F6" : undefined }}>
                <div className="kpi-label">{label}</div>
                <div style={{ fontSize: 21, fontWeight: 700, marginTop: 3, color: colour }}>{value}</div>
                {sub && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{sub}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {data && (
        <section className="card" style={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ minWidth: 1080 }}>
              <thead>
                <tr>
                  <th style={{ width: 40 }} /><th>Date &amp; time</th><th>Ref</th><th>Type</th><th>Vehicle / machine / supplier</th>
                  <th>Meter reading</th><th style={{ textAlign: "right" }}>Consumption</th><th style={{ textAlign: "right" }}>In (L)</th>
                  <th style={{ textAlign: "right" }}>Out (L)</th><th style={{ textAlign: "right" }}>Balance (L)</th><th style={{ textAlign: "right" }}>Value</th><th>Done by</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const key = `${r.kind}-${r.txn_id ?? r.sr_id}`;
                  const isOpen = open === key;
                  return (
                    <Fragment key={key}>
                      <tr style={{ color: r.kind === "external" ? "var(--slate)" : undefined, background: isOpen ? "#FFF8F2" : undefined }}>
                        <td>
                          <button type="button" aria-expanded={isOpen} aria-label={`Details for ${r.ref}`} onClick={() => setOpen(isOpen ? null : key)}
                            style={{ width: 32, height: 32, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                              style={{ transition: "transform .15s", transform: isOpen ? "rotate(90deg)" : "none" }}><path d="m9 6 6 6-6 6" /></svg>
                          </button>
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.at)}</td>
                        <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{r.ref}</td>
                        <td><LedgerKind kind={r.kind} /></td>
                        <td><b>{r.unit_label}</b><div style={{ fontSize: 11, color: "var(--slate)" }}>{r.unit_sub}{r.kind === "external" && r.station_name ? ` · ${r.station_name}` : ""}</div></td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.reading ? `${fmtNum(r.reading.value, r.reading.unit === "hrs" ? 1 : 0)} ${r.reading.unit}` : "—"}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{r.consumption ? `${fmtNum(r.consumption.value, r.consumption.unit === "L/hr" ? 2 : 1)} ${r.consumption.unit}` : "—"}</td>
                        <td style={{ textAlign: "right", color: "var(--signal-green)", fontWeight: 600 }}>{r.in_qty != null ? fmtNum(r.in_qty) : "—"}</td>
                        <td style={{ textAlign: "right" }}>{r.out_qty != null ? (r.kind === "external" ? `(${fmtNum(r.out_qty)})` : fmtNum(r.out_qty)) : "—"}</td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>{r.balance_after != null ? fmtNum(r.balance_after) : "—"}</td>
                        <td style={{ textAlign: "right" }}>{r.value != null ? fmtRs(r.value) : "—"}</td>
                        <td style={{ fontSize: 12 }}>{r.done_by_name || "—"}</td>
                      </tr>
                      {isOpen && (
                        <tr><td colSpan={12} style={{ background: "#FAF9F6", padding: "16px 18px 18px 52px" }}><Detail r={r} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
                {data.rows.length === 0 && <tr><td colSpan={12} style={{ color: "var(--slate)", padding: 16 }}>No fuel transactions match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderTop: "1px solid var(--border)", fontSize: 12.5, color: "var(--slate)", flexWrap: "wrap", gap: 8 }}>
            <span>{data.total ? `Showing ${(page - 1) * data.limit + 1}–${Math.min(page * data.limit, data.total)} of ${data.total} · newest first` : ""}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>Previous</button>
              <button type="button" disabled={page >= pages || loading} onClick={() => load(page + 1)}>Next</button>
            </div>
          </div>
        </section>
      )}
      <div style={{ fontSize: 11.5, color: "var(--slate)" }}>
        Consumption is worked out fill to fill from the meter reading at each fill: L/100km for trucks, L/hr for pumps and machines. Outside-station fills are shown in brackets; they count towards consumption but never change the tank balance.
      </div>
    </div>
  );
}
