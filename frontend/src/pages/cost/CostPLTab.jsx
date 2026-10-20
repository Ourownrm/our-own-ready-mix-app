// Round 218 — Profit & Loss: a month, the quarter or the year to date.
// App lines come from the modules; Entered lines are keyed in by Accounts
// (a line not entered counts as 0 and is listed under Month status).
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  useCostData, Loading, MonthSelect, Select, Actions, BTN, Tile, Src, SrcLegend, Modal, downloadExcel,
  lakh, rsL, rs, num, pct, signed, C, H2, SUB, MUTED, R, NUM, GRID, ROW, panel, monthName,
} from "./costUi.jsx";

const BANDS = { soft: "#F7F5F0", green: "#EEF6F1", strong: "var(--signal-green-bg)" };

export default function CostPLTab({ month, setMonth }) {
  const { can } = usePermissions();
  const [period, setPeriod] = useState("month");
  const [compare, setCompare] = useState("prev");
  const [entering, setEntering] = useState(false);
  const { data: d, error, reload } = useCostData(`/cost/pl?month=${month}&period=${period}&compare=${compare}`);
  const mayEnter = can("cost.entries", "edit");
  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Profit &amp; Loss — {d ? d.label : monthName(month)}</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>₹ lakh, excluding GST{d ? <> · per m³ on <b style={{ color: "var(--charcoal)" }}>{num(d.qty, 1)} m³ sold</b></> : null}</div>
      </div>
      <Actions>
        <MonthSelect value={month} onChange={setMonth} label="Up to" />
        <Select label="Period" value={period} onChange={setPeriod} options={[
          { value: "month", label: "The month" }, { value: "quarter", label: "Quarter to date" }, { value: "ytd", label: "Year to date (Apr–)" }]} />
        <Select label="Compare with" value={compare} onChange={setCompare} options={[
          { value: "prev", label: period === "ytd" ? "Same period last year" : "Previous period" }, { value: "last_year", label: "Same period last year" }]} />
        {mayEnter && <button type="button" style={BTN} onClick={() => setEntering(true)}>Enter month’s expenses</button>}
        <button type="button" style={BTN} disabled={!d} onClick={() => exportPL(d)}>Export Excel</button>
        <button type="button" className="btn-primary" style={BTN} onClick={() => window.print()}>Print / PDF</button>
      </Actions>
    </div>
  );
  const modal = entering && <EntryModal month={month} onClose={() => setEntering(false)} onSaved={() => { setEntering(false); reload(); }} />;
  if (!d || d.month !== month) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div>{modal}</>;

  const k = d.kpis;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      <div style={GRID(200)}>
        <Tile label="Revenue" value={rsL(k.revenue)} sub={`${rs(k.revenue_m3)} / m³`} note={k.revenue_change == null ? null : `${signed(k.revenue_change)} vs ${d.cmp_label}`} />
        <Tile label="Gross margin" value={rsL(k.gross)} sub={`${pct(k.gross_pct)} · ${rs(k.gross_m3)} / m³`} note="after material, fuel, power, repairs, hire" />
        <Tile label="EBITDA" value={rsL(k.ebitda)} sub={`${pct(k.ebitda_pct)} · ${rs(k.ebitda_m3)} / m³`} note={k.cmp_ebitda_pct == null ? null : `${d.cmp_label} ${pct(k.cmp_ebitda_pct)}`} />
        <Tile dark label="Profit after tax" value={rsL(k.pat)} sub={`${pct(k.pat_pct)} · ${rs(k.pat_m3)} / m³`}
          note={k.cmp_pat ? `${signed(((k.pat - k.cmp_pat) / Math.abs(k.cmp_pat)) * 100)} vs ${d.cmp_label} ${rsL(k.cmp_pat)}` : null} />
        <Tile label="Break-even volume" value={k.breakeven_m3 == null ? "—" : `${num(k.breakeven_m3)} m³`} sub="a month, at this margin"
          note={k.breakeven_m3 == null ? "gross margin is not positive" : `overheads, depreciation, interest ${rsL(k.fixed_costs)} ÷ ${rs(k.gross_m3)} / m³`} />
      </div>

      <div style={ROW}>
        <div style={panel("999 1 720px")}>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
            <h2 style={H2}>Statement</h2><SrcLegend />
          </div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{ minWidth: 820 }}>
              <thead><tr><th style={{ minWidth: 210 }}>Particulars</th><th style={R}>{d.label}</th><th style={R}>₹ / m³</th><th style={R}>% of revenue</th>
                <th style={R}>{d.cmp_label}</th><th style={R}>Change</th><th style={R}>{d.ytd_label}</th><th>Source</th></tr></thead>
              <tbody>
                {d.rows.map((r, i) => {
                  if (r.kind === "head") return (
                    <tr key={i}><td colSpan={8} style={{ paddingTop: 16, fontSize: 11.5, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid var(--border-strong)" }}>{r.label}</td></tr>);
                  const total = r.kind === "total";
                  const top = total ? { borderTop: "1px solid var(--border-strong)" } : {};
                  const chColor = r.better == null ? "var(--slate)" : r.better ? "var(--signal-green)" : "var(--alert-red)";
                  return (
                    <tr key={i} style={{ background: total ? BANDS[r.band] || undefined : undefined }}>
                      <td style={{ paddingLeft: total ? 6 : 20, fontWeight: total ? 700 : 400, ...top }}>
                        {r.label}{r.missing && <span style={{ color: "var(--amber)", fontWeight: 600 }}> · not entered</span>}
                        {r.hint && <div style={{ ...MUTED, fontSize: 11 }}>{r.hint}</div>}</td>
                      <td style={{ ...R, fontWeight: total ? 700 : 400, color: r.cur < 0 ? "var(--alert-red)" : undefined, ...top }}>{lakh(r.cur)}</td>
                      <td style={{ ...R, color: "#4A525C", fontWeight: total ? 700 : 400, ...top }}>{num(r.per_m3)}</td>
                      <td style={{ ...R, color: "#4A525C", fontWeight: total ? 700 : 400, ...top }}>{pct(r.pct)}</td>
                      <td style={{ ...R, color: "#4A525C", ...top }}>{lakh(r.cmp)}</td>
                      <td style={{ ...R, color: chColor, fontWeight: total ? 700 : 600, ...top }}>{signed(r.change)}</td>
                      <td style={{ ...R, fontWeight: total ? 700 : 400, ...top }}>{lakh(r.ytd)}</td>
                      <td style={top}><Src src={r.src} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ flex: "1 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={panel("0 0 auto")}>
            <h2 style={H2}>From {rs(k.revenue_m3)} of revenue per m³</h2>
            <div style={SUB}>{d.label}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 14 }}>
              {d.water.length === 0 && <div style={MUTED}>No sales in this period.</div>}
              {d.water.map((w) => {
                const colour = { "Raw material": C.rm, Fuel: C.fuel, "Power, repairs, hire": C.mnt, "Salaries & contract labour": C.man,
                  "Other overheads": C.grey, "Depreciation & interest": C.slate2, Tax: "#C8C2B5", "Profit after tax": C.left }[w.label];
                const bold = w.label === "Profit after tax";
                return (
                  <div key={w.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: bold ? 700 : 400 }}>
                      <span>{w.label}</span><span style={{ ...NUM, color: w.per_m3 < 0 ? "var(--alert-red)" : undefined }}>{rs(w.per_m3)}</span></div>
                    <div style={{ height: 10, background: "var(--concrete)", borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, w.pct))}%`, background: w.per_m3 < 0 ? C.bad : colour, borderRadius: 5 }} /></div>
                  </div>
                );
              })}
            </div>
          </div>

          <PatBars pat={d.pat} ytd={d.ytd_totals} ytdLabel={d.ytd_label} />

          <MonthStatus d={d} mayEnter={mayEnter} onEnter={() => setEntering(true)} />
        </div>
      </div>

      <div style={{ ...MUTED, lineHeight: 1.6 }}>
        How each App line is worked out — Sales: tax invoices, one per delivery note, base = total × 100 / 118 (the total itself when GST is switched off on an invoice) ·
        Pumping, part-load and waiting charges: on the invoices, as decided per order · Raw material: plant consumption × the month’s weighted average rate ·
        Fuel: Fuel module issues incl. outside-station fills and adjustments down · Repairs &amp; maintenance: Maintenance module job cards ·
        Road tax and insurance: each certificate’s fee (Maintenance → Certificates) spread evenly over the days it covers — road tax over its quarter, insurance over its policy year; the part not yet used is prepaid on the Balance Sheet ·
        Salaries &amp; wages: HR payroll, cost to company · Contract labour: approved contractor bills before TDS, excl. GST (until a bill is approved, payroll and the closed gang months).
        Entered lines are keyed in by Accounts each month.
      </div>
      {modal}
    </div>
  );
}

function PatBars({ pat, ytd, ytdLabel }) {
  const max = Math.max(1, ...pat.map((p) => Math.abs(p.pat)));
  return (
    <div style={panel("0 0 auto")}>
      <h2 style={H2}>Profit after tax — 6 months</h2>
      <div role="img" aria-label={`Profit after tax by month, lakh: ${pat.map((p) => `${p.label} ${lakh(p.pat, 1)}`).join(", ")}`}
        style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10, marginTop: 14, alignItems: "end", height: 140 }}>
        {pat.map((p, i) => (
          <div key={p.month} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 5, height: "100%" }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, ...NUM, color: p.pat < 0 ? "var(--alert-red)" : undefined }}>{lakh(p.pat, 1)}</div>
            <div style={{ width: "100%", maxWidth: 40, height: Math.max(2, Math.round((Math.abs(p.pat) / max) * 90)), borderRadius: "4px 4px 0 0",
              background: p.pat < 0 ? C.bad : i === pat.length - 1 ? C.left : C.soft }} />
            <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{p.label}</div>
          </div>
        ))}
      </div>
      <div style={{ ...MUTED, marginTop: 10 }}>₹ lakh{pat.some((p) => p.pat < 0) ? " · red = loss" : ""}. {ytdLabel} {rsL(ytd.pat)} · {pct(ytd.revenue ? (ytd.pat / ytd.revenue) * 100 : null)} of revenue.</div>
    </div>
  );
}

function MonthStatus({ d, mayEnter, onEnter }) {
  const s = d.status;
  const allIn = s.missing.length === 0;
  return (
    <div style={{ background: allIn ? "var(--signal-green-bg)" : "var(--amber-bg)", border: `1px solid ${allIn ? "#BFDCCB" : "#E7D8AE"}`, borderRadius: 10, padding: "14px 16px", fontSize: 12.5, lineHeight: 1.55 }}>
      <b>Month status:</b>{" "}
      {allIn ? "every entered line for this period is in." : "these entered lines are not in yet — until they are they count as 0 and profit reads too high:"}
      {!allIn && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {s.missing.map((m) => <li key={m.month}><b>{m.label}:</b> {m.lines.join(", ")}</li>)}
        </ul>
      )}
      {(s.held_loads > 0 || s.bills_on_hold > 0 || s.flags.length > 0) && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {s.held_loads > 0 && <li>{num(s.held_loads)} load(s), {num(s.held_m3, 1)} m³, held with no price — not in sales until invoiced.</li>}
          {s.bills_on_hold > 0 && <li>{num(s.bills_on_hold)} outside repair bill(s) on hold above the estimate — not in repairs until accepted.</li>}
          {s.flags.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      )}
      {mayEnter && !allIn && <div style={{ marginTop: 8 }}><button type="button" style={{ padding: "6px 11px", fontSize: 12.5 }} onClick={onEnter}>Enter the month’s expenses</button></div>}
    </div>
  );
}

function EntryModal({ month, onClose, onSaved }) {
  const [ym, setYm] = useState(month);
  const [data, setData] = useState(null);
  const [vals, setVals] = useState({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setData(null); setErr("");
    apiRequest(`/cost/entries?month=${ym}`).then((d) => {
      setData(d);
      setVals(Object.fromEntries(d.lines.map((l) => [l.key, l.value ? String(l.value.amount) : ""])));
    }).catch((e) => setErr(e.message));
  }, [ym]);
  async function save() {
    setBusy(true); setErr("");
    try {
      const values = {};
      for (const l of data.lines) {
        const v = vals[l.key].trim();
        values[l.key] = v === "" ? null : Number(v.replace(/,/g, ""));
      }
      await apiRequest("/cost/entries", { method: "PUT", body: { month: ym, values, note } });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="The month’s expenses" onClose={onClose} width={720}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
        <MonthSelect value={ym} onChange={setYm} />
        <div style={{ ...MUTED, flex: 1, minWidth: 220 }}>In rupees, excluding GST. Leave a line empty if it is not known yet — the P&amp;L will say it is missing.</div>
      </div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {!data ? <div style={MUTED}>Loading…</div> : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {data.lines.map((l) => (
              <div key={l.key} style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1.3fr) minmax(130px, 1fr) minmax(120px, 1fr)", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                <label htmlFor={`ce-${l.key}`} style={{ fontSize: 13 }}><b style={{ fontWeight: 600 }}>{l.label}</b>{l.hint && <div style={{ ...MUTED, fontSize: 11 }}>{l.hint}</div>}</label>
                <input id={`ce-${l.key}`} inputMode="decimal" className="field-input" value={vals[l.key] ?? ""} placeholder="not entered"
                  onChange={(e) => setVals({ ...vals, [l.key]: e.target.value })}
                  style={{ padding: "8px 10px", fontSize: 13, border: "1px solid var(--border-strong)", borderRadius: 7, minHeight: 40, textAlign: "right", ...NUM }} />
                <div style={{ ...MUTED, fontSize: 11.5 }}>
                  {vals[l.key] && Number(vals[l.key].replace(/,/g, "")) ? `₹${lakh(Number(vals[l.key].replace(/,/g, "")))} L` : ""}
                  {l.key === "tax" ? (
                    <div><button type="button" style={{ padding: "4px 8px", fontSize: 11.5, marginTop: 2 }} onClick={() => setVals({ ...vals, tax: String(data.tax_suggestion) })}>
                      Use 25.17% of profit: {rs(data.tax_suggestion)}</button></div>
                  ) : l.last_month != null && (
                    <div><button type="button" style={{ padding: "4px 8px", fontSize: 11.5, marginTop: 2 }} onClick={() => setVals({ ...vals, [l.key]: String(l.last_month) })}>
                      Same as {data.prev_label}: {rs(l.last_month)}</button></div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <label style={{ display: "block", marginTop: 12, fontSize: 12.5 }}>Note (optional)
            <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. KSEB bill no., from Tally"
              style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 10px", fontSize: 13, border: "1px solid var(--border-strong)", borderRadius: 7, minHeight: 40 }} />
          </label>
          <div style={{ ...MUTED, marginTop: 8 }}>Tax suggestion is on the month’s profit before tax with every line as entered now ({rs(data.pbt_before_tax_line)}).</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          </div>
          {data.log.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary style={{ fontSize: 12.5, cursor: "pointer" }}>Changes made ({data.log.length})</summary>
              <ul style={{ fontSize: 12, paddingLeft: 18, margin: "6px 0 0" }}>
                {data.log.map((g, i) => (
                  <li key={i}>{g.label}: {g.old_amount == null ? "—" : rs(g.old_amount)} → {g.new_amount == null ? "cleared" : rs(g.new_amount)} · {g.by_name || "—"} · {new Date(g.changed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{g.note ? ` · ${g.note}` : ""}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}

function exportPL(d) {
  const L = (v) => (v == null ? "" : Math.round(v) / 100000);
  const rows = [[`Profit & Loss — ${d.label}`], [`₹ lakh excl. GST · per m³ on ${d.qty} m³ sold`], [],
    ["Particulars", d.label, "₹ / m³", "% of revenue", d.cmp_label, "Change %", d.ytd_label, "Source"]];
  for (const r of d.rows) {
    if (r.kind === "head") { rows.push([r.label.toUpperCase()]); continue; }
    rows.push([r.label, L(r.cur), r.per_m3, r.pct, L(r.cmp), r.change, L(r.ytd), r.src === "app" ? "App" : r.src === "entered" ? (r.missing ? "Entered — missing" : "Entered") : ""]);
  }
  downloadExcel(`Profit and Loss ${d.month} ${d.period}.xlsx`, [{ name: "Profit & Loss", rows }]);
}
