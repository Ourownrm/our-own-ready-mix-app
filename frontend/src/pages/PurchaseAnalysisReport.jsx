// Round 237 — Raw Material → Reports → Purchase Analysis Report (owner,
// 23 Oct 2026; mock-up of the same name). By material and supplier: qty,
// average rate, amount; each supplier's rate against the cheapest supplier of
// that material; flagged when more was bought from the dearer one, with the
// money paid over the best rate and the qty that money would have bought.
// Rules: backend lib/purchaseAnalysis.js.
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { todayStr } from "../lib/istDate.js";

const pad = (n) => String(n).padStart(2, "0");
function monthEnd(ym) { const [y, m] = ym.split("-").map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; }
function prevMonth(ym) { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; }
function presets() {
  const today = todayStr(), ym = today.slice(0, 7), last = prevMonth(ym);
  const [y, m] = ym.split("-").map(Number);
  const fy = m >= 4 ? y : y - 1;
  return [
    ["This month", `${ym}-01`, today], ["Last month", `${last}-01`, monthEnd(last)], ["This FY", `${fy}-04-01`, today],
  ];
}
const inr = (n, d = 0) => (n == null ? "–" : `${n < 0 ? "−" : ""}${Math.abs(Number(n)).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: d })}`);
const rs = (n, d = 0) => (n == null ? "–" : `${n < 0 ? "−" : ""}₹${Math.abs(Number(n)).toLocaleString("en-IN", { maximumFractionDigits: d })}`);
const lakh = (n) => `₹${(Number(n || 0) / 100000).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const C = { flag: "#FFF4E5", flagBd: "#EBC9A0", red: "#B03A2E", amber: "#8A5E0F", green: "#1D7A55", ink: "#22262B", slate: "var(--slate)" };
const TH = { textAlign: "left", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--slate)", fontWeight: 600, padding: "8px 8px", borderBottom: "1px solid var(--border-strong)", whiteSpace: "nowrap" };
const TD = { padding: "8px 8px", borderBottom: "1px solid var(--border)", fontSize: 12.5, verticalAlign: "middle", fontVariantNumeric: "tabular-nums" };
const R = { textAlign: "right", whiteSpace: "nowrap" };

function FlagIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }}><path d="M4 22V4" /><path d="M4 4h12l-2 4 2 4H4" /></svg>;
}

export default function PurchaseAnalysisReport() {
  const { can } = usePermissions();
  const canEdit = can("material.report.purchase-analysis", "edit");
  const P = presets();
  const [from, setFrom] = useState(P[1][1]);
  const [to, setTo] = useState(P[1][2]);
  const [basis, setBasis] = useState("landed");
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  async function run(f = from, t = to, b = basis) {
    if (!f || !t) { setError("Pick the From and To dates."); return; }
    setLoading(true); setError("");
    try { setD(await apiRequest(`/material-module/reports/purchase-analysis?from=${f}&to=${t}&basis=${b}`)); }
    catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function setReason(m, s, reason) {
    try {
      await apiRequest("/material-module/reports/purchase-analysis/reason", { method: "PUT",
        body: { material_id: m.id, supplier_id: s.id, months: s.months.map((x) => x.ym), reason } });
      run();
    } catch (e) { setError(e.message); }
  }

  async function exportExcel() {
    const XLSX = await import("xlsx");
    const why = (k) => d.reasons.find((r) => r.key === k)?.label || (k === "mixed" ? "Different by month" : "");
    const rows = [["Material", "Supplier", "Loads", "Qty", "Unit", "Share %", "Avg rate", "Best rate", "Over best per unit", "Over best %", "Amount", "Paid over best", "Qty lost", "Flagged", "Why"]];
    for (const m of d.materials) {
      for (const s of m.suppliers) {
        rows.push([m.name, s.name, s.loads, s.qty, m.unit, s.share, s.rate, m.best_rate ?? "", s.over_rate ?? "", s.over_pct ?? "", s.amount, s.extra || "", s.qty_lost || "", s.flagged ? "yes" : "", why(s.reason)]);
      }
      rows.push([m.name, "All suppliers", "", m.qty, m.unit, 100, m.rate, m.best_rate ?? "", "", "", m.amount, m.extra || "", m.qty_lost || "", "", ""]);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Purchase analysis");
    XLSX.writeFile(wb, `Purchase Analysis ${d.from} to ${d.to}.xlsx`);
  }

  const t = d?.totals;
  const flaggedList = d ? d.materials.flatMap((m) => m.suppliers.filter((s) => s.flagged).map((s) => ({ m, s }))).sort((a, b) => b.s.flag_extra - a.s.flag_extra) : [];
  const lost = d ? d.materials.filter((m) => m.qty_lost > 0).sort((a, b) => b.extra - a.extra) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Purchase Analysis Report{d ? ` — ${fmtDay(d.from)} to ${fmtDay(d.to)}` : ""}</div>
          <div style={{ fontSize: 12, color: C.slate, marginTop: 3 }}>Accepted receipts in the period · rates without GST, {basis === "landed" ? "freight included (what it costs us at the plant)" : "material only (freight left out)"}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div role="group" aria-label="Quick period" style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 8, overflow: "hidden" }}>
            {P.map(([label, f, to2]) => {
              const on = from === f && to === to2;
              return <button key={label} type="button" onClick={() => { setFrom(f); setTo(to2); run(f, to2); }} aria-pressed={on}
                style={{ fontSize: 12, padding: "7px 11px", border: 0, borderRadius: 0, background: on ? C.ink : "var(--surface)", color: on ? "#fff" : C.ink }}>{label}</button>;
            })}
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, color: C.slate }}>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ padding: "6px 8px", minHeight: 36 }} /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, color: C.slate }}>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ padding: "6px 8px", minHeight: 36 }} /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, color: C.slate }}>Rate
            <select value={basis} onChange={(e) => { setBasis(e.target.value); run(from, to, e.target.value); }} style={{ padding: "6px 8px", minHeight: 36 }}>
              <option value="landed">Landed (material + freight)</option><option value="material">Material only</option>
            </select>
          </label>
          <button type="button" className="btn-primary" onClick={() => run()} disabled={loading} style={{ fontSize: 12.5, padding: "8px 14px", minHeight: 36 }}>{loading ? "Working…" : "Run"}</button>
          <button type="button" onClick={exportExcel} disabled={!d || !d.materials.length} style={{ fontSize: 12.5, padding: "8px 14px", minHeight: 36 }}>Export Excel</button>
        </div>
      </div>
      {error && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}

      {d && !d.materials.length && <div className="card" style={{ fontSize: 13, color: C.slate }}>No accepted receipts in this period.</div>}
      {d && d.materials.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
            <Tile dark label="Purchased" value={lakh(t.amount)} note={`${t.materials} materials · ${t.suppliers} suppliers · ${inr(t.loads)} loads`} />
            <Tile label="Paid over the best rate" value={lakh(t.extra)} valueColor={t.extra > 0 ? C.red : undefined}
              note={t.compared ? `${t.amount > 0 ? ((t.extra / t.amount) * 100).toFixed(1) : 0}% of what was bought · ${t.compared} material(s) compared` : "no material had two suppliers"} />
            <Tile warn={t.flag_extra > 0} label="More bought from the dearer one" value={lakh(t.flag_extra)}
              note={t.flagged ? `${t.flagged} supplier(s) flagged${t.extra > 0 ? ` · ${Math.round((t.flag_extra / t.extra) * 100)}% of the extra` : ""}` : "none flagged"} />
            <Tile label="Quantity that money would have bought" value={lost[0] ? `${inr(lost[0].qty_lost, 1)} ${lost[0].unit}` : "—"}
              note={lost[0] ? `of ${lost[0].name} at the best rate${lost.slice(1, 3).map((m) => ` · + ${inr(m.qty_lost, 1)} ${m.unit} ${m.name}`).join("")}` : "nothing lost"} />
          </div>

          <div className="card" style={{ overflowX: "auto", padding: "6px 12px 10px" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 0" }}>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Only materials with a flagged supplier</label>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1080 }}>
              <thead><tr>
                <th style={TH}>Material · supplier</th><th style={{ ...TH, ...R }}>Loads</th><th style={{ ...TH, ...R }}>Qty</th><th style={TH}>Share of qty</th>
                <th style={{ ...TH, ...R }}>Avg rate</th><th style={TH}>Against the best rate</th><th style={{ ...TH, ...R }}>Amount ₹</th>
                <th style={{ ...TH, ...R }}>Paid over best ₹</th><th style={{ ...TH, ...R }}>Qty lost</th><th style={{ ...TH, width: 200 }} />
              </tr></thead>
              <tbody>
                {d.materials.filter((m) => !onlyFlagged || m.suppliers.some((s) => s.flagged)).map((m) => (
                  <MaterialRows key={m.id} m={m} reasons={d.reasons} canEdit={canEdit} onReason={setReason} />
                ))}
              </tbody>
              <tfoot><tr>
                <td style={{ ...TD, fontWeight: 700, borderTop: "1px solid var(--border-strong)", borderBottom: 0 }} colSpan={6}>All materials</td>
                <td style={{ ...TD, ...R, fontWeight: 700, borderTop: "1px solid var(--border-strong)", borderBottom: 0 }}>{inr(t.amount)}</td>
                <td style={{ ...TD, ...R, fontWeight: 700, color: t.extra ? C.red : undefined, borderTop: "1px solid var(--border-strong)", borderBottom: 0 }}>{t.extra ? inr(t.extra) : "—"}</td>
                <td style={{ ...TD, borderTop: "1px solid var(--border-strong)", borderBottom: 0 }} colSpan={2} />
              </tr></tfoot>
            </table>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <div className="card" style={{ flex: "1 1 380px", minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Where the extra went</div>
              <div style={{ fontSize: 12, color: C.slate, marginTop: 2 }}>Flagged: the dearer supplier gave us more than the cheapest one</div>
              {!flaggedList.length && <div style={{ fontSize: 12.5, color: C.slate, marginTop: 8 }}>Nothing flagged in this period.</div>}
              {flaggedList.map(({ m, s }, i) => (
                <div key={`${m.id}-${s.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: i < flaggedList.length - 1 ? "1px solid var(--border)" : 0, fontSize: 13 }}>
                  <span style={{ minWidth: 0 }}>{m.name} · {s.name}
                    <span style={{ display: "block", fontSize: 11.5, color: C.slate }}>{Math.round(s.share)}% of the {m.name} at {rs(s.over_rate)} more a {m.unit} than the best rate{s.reason ? ` · reason: ${d.reasons.find((r) => r.key === s.reason)?.label?.toLowerCase() || "different by month"}` : ""}</span></span>
                  <span style={{ ...R, textAlign: "right" }}><b style={{ color: C.red }}>{rs(s.flag_extra)}</b><span style={{ display: "block", fontSize: 11.5, color: C.slate }}>{inr(s.qty_lost, 1)} {m.unit}</span></span>
                </div>
              ))}
            </div>
            <div className="card" style={{ flex: "1 1 380px", minWidth: 0, fontSize: 12.5, lineHeight: 1.6 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>How it is worked out</div>
              <div><b>Qty</b> — accepted quantity on the receipts (what the bill is paid on), in the material's purchase unit. <b>Amount</b> — accepted qty × the order rate{basis === "landed" ? ", plus freight" : ""}, without GST.</div>
              <div><b>Avg rate</b> — amount ÷ qty, so a supplier whose rate changed in the period shows its weighted average.</div>
              <div><b>Best rate</b> — the lowest average rate for that material. Only suppliers of the same material are compared.</div>
              <div><b>Paid over best</b> — (supplier's rate − best rate) × qty bought from them. <b>Qty lost</b> — that amount ÷ the best rate: how much more we could have bought.</div>
              <div><b>Flagged</b> — the supplier is dearer AND gave us more than the cheapest one. A period over several months is compared month by month, so a rate change in one month is not held against another.</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, note, dark, warn, valueColor }) {
  return (
    <div style={{ background: dark ? C.ink : warn ? C.flag : "var(--surface)", color: dark ? "#fff" : C.ink, border: `1px solid ${dark ? C.ink : warn ? C.flagBd : "var(--border)"}`, borderRadius: 10, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, color: dark ? "#B8BFC7" : warn ? "#8A3E0B" : C.slate }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2, color: valueColor, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 11.5, marginTop: 2, color: dark ? "#C9CDD2" : warn ? "#8A3E0B" : C.slate }}>{note}</div>
    </div>
  );
}

function MaterialRows({ m, reasons, canEdit, onReason }) {
  const MAT = { ...TD, background: "#F7F5F0", borderTop: "1px solid var(--border-strong)", paddingTop: 10, paddingBottom: 10 };
  return (
    <>
      <tr>
        <td style={MAT} colSpan={2}><b style={{ fontSize: 13.5 }}>{m.name}</b> <span style={{ fontSize: 12, color: C.slate }}>· {m.suppliers.length} supplier{m.suppliers.length > 1 ? "s" : ""}</span></td>
        <td style={{ ...MAT, ...R }}><b>{inr(m.qty, 2)}</b> <span style={{ color: C.slate }}>{m.unit}</span></td>
        <td style={MAT} />
        <td style={{ ...MAT, ...R }}><b>{rs(m.rate, 2)}</b></td>
        <td style={MAT} />
        <td style={{ ...MAT, ...R }}><b>{inr(m.amount)}</b></td>
        <td style={{ ...MAT, ...R }}>{m.extra ? <b style={{ color: C.red }}>{inr(m.extra)}</b> : "—"}</td>
        <td style={{ ...MAT, ...R }}>{m.qty_lost ? <b style={{ color: C.red }}>{inr(m.qty_lost, 1)} {m.unit}</b> : "—"}</td>
        <td style={{ ...MAT, fontSize: 11.5, color: C.slate }}>{!m.compared ? "Only one supplier — nothing to compare" : m.extra ? `Best rate ${rs(m.best_rate, 2)} / ${m.unit}` : ""}</td>
      </tr>
      {m.suppliers.map((s) => {
        const hl = s.flagged;
        const tone = hl ? C.red : C.amber;
        return (
          <tr key={s.id} style={{ background: hl ? C.flag : undefined }}>
            <td style={{ ...TD, paddingLeft: 20 }} title={hl ? "Bought more from this supplier at a higher rate" : undefined}>{hl && <FlagIcon />}{s.name}</td>
            <td style={{ ...TD, ...R }}>{s.loads}</td>
            <td style={{ ...TD, ...R }}>{inr(s.qty, 2)}</td>
            <td style={TD}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 80, height: 8, background: "#ECEAE4", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, s.share)}%`, height: "100%", background: hl ? "#C75B12" : s.best && m.compared ? C.green : "#8A929B" }} />
                </div>
                <span style={{ fontSize: 12 }}>{Math.round(s.share)}%</span>
              </div>
            </td>
            <td style={{ ...TD, ...R }}>{rs(s.rate, 2)}</td>
            <td style={TD}>{!m.compared ? "" : s.best
              ? <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#E5F2EA", color: "#1D5E43" }}>best rate</span>
              : <span style={{ color: tone, fontWeight: hl ? 600 : 400 }}>+{rs(s.over_rate, 2)} · +{s.over_pct}%</span>}</td>
            <td style={{ ...TD, ...R }}>{inr(s.amount)}</td>
            <td style={{ ...TD, ...R, color: tone, fontWeight: hl ? 600 : 400 }}>{s.extra ? inr(s.extra) : ""}</td>
            <td style={{ ...TD, ...R, color: tone, fontWeight: hl ? 600 : 400 }}>{s.qty_lost ? `${inr(s.qty_lost, 1)} ${m.unit}` : ""}</td>
            <td style={TD}>
              {hl ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: C.slate }}>Why
                  <select value={s.reason && s.reason !== "mixed" ? s.reason : ""} disabled={!canEdit} onChange={(e) => onReason(m, s, e.target.value)}
                    style={{ fontSize: 12, padding: "4px 6px", minHeight: 32 }}>
                    <option value="">{s.reason === "mixed" ? "Different by month" : "Not given"}</option>
                    {reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </label>
              ) : s.extra ? <span style={{ fontSize: 11.5, color: C.slate }}>bought less from the dearer one</span> : null}
            </td>
          </tr>
        );
      })}
    </>
  );
}
