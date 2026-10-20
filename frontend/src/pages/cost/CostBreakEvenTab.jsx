// Round 221 — Break-even (owner, 21 Oct 2026; mock-up "Break-even — Monthly").
// The month's costs in two groups — fixed (paid every month whatever we sell)
// and variable (rise with every m³) — the m³ needed to cover the fixed costs,
// and the day each month got there. Which group a cost is in is an
// Administrator setting (cost.classify), applied to every month.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  useCostData, Loading, MonthSelect, Actions, BTN, Tile, Note, Src, downloadExcel,
  lakh, rsL, rs, num, pct, C, H2, SUB, MUTED, R, NUM, GRID, ROW, panel,
} from "./costUi.jsx";

const dayShort = (ymd) => (ymd ? new Date(`${ymd}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "—");

export default function CostBreakEvenTab({ month, setMonth }) {
  const { can } = usePermissions();
  const mayClassify = can("cost.classify", "edit");
  const { data: d, error, reload } = useCostData(`/cost/break-even?month=${month}`);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  async function setKind(key, kind) {
    setBusy(key); setErr("");
    try { await apiRequest("/cost/line-kinds", { method: "PUT", body: { kinds: { [key]: kind } } }); reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  }

  const s = d?.selected;
  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Break-even — {s && d.month === month ? s.label : "Monthly"}</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>
          Costs split into <b style={{ color: "var(--charcoal)" }}>fixed</b> (the same whatever we sell) and <b style={{ color: "var(--charcoal)" }}>variable</b> (rise with every m³) · ₹ lakh excl. GST
          {s?.is_current && <> · <b style={{ color: "var(--amber)" }}>month so far, {s.days_so_far} of {s.days} days</b></>}
        </div>
      </div>
      <Actions>
        <MonthSelect value={month} onChange={setMonth} />
        <button type="button" style={BTN} disabled={!d} onClick={() => exportBE(d)}>Export Excel</button>
        <button type="button" className="btn-primary" style={BTN} onClick={() => window.print()}>Print / PDF</button>
      </Actions>
    </div>
  );
  if (!d || d.month !== month) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;

  const fixedLines = s.lines.filter((l) => l.kind === "fixed");
  const varLines = s.lines.filter((l) => l.kind === "variable");
  const prev = d.history.length > 1 ? d.history[d.history.length - 2] : null;
  const reachedText = s.reached ? dayShort(s.reached.day) : s.projection ? (s.projection.on ? `~${dayShort(s.projection.on)}` : "Not this month") : "Not reached";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {s.idle && <Note>No sales or costs recorded in {s.label}. Pick another month.</Note>}
      {s.estimated.length > 0 && (
        <Note><b>Some figures for {s.label} are not in yet</b> and are estimated: {s.estimated.map((e) => `${e.label} (${e.how})`).join("; ")}. Break-even will move a little once they are entered.</Note>
      )}
      {s.cm_m3 != null && s.cm_m3 <= 0 && <Note tone="bad">Revenue per m³ does not cover the variable cost per m³ in {s.label} — every m³ sold adds to the loss, so there is no break-even volume.</Note>}

      <div style={GRID(200)}>
        <Tile label="Fixed costs" value={rsL(s.fixed)} sub={`${rsL(s.fixed / s.days)} a day`} note={prev ? `${prev.short}: ${rsL(prev.fixed)}` : null} />
        <Tile label="Left per m³ after variable costs" value={rs(s.cm_m3)} sub={`${pct(s.cm_pct)} of ${rs(s.rev_m3)} revenue`}
          note={`variable ${rs(s.var_m3)} / m³${prev ? ` · ${prev.short} ${rs(prev.cm_m3)}` : ""}`} />
        <Tile label="Break-even volume" value={s.be_m3 == null ? "—" : `${num(s.be_m3)} m³`} sub={s.be_sales == null ? null : `${rsL(s.be_sales)} of sales`}
          note={prev?.be_m3 != null ? `${prev.short}: ${num(prev.be_m3)} m³` : null} />
        <Tile dark label={s.reached || !s.is_current ? "Break-even reached" : "Break-even expected"} value={reachedText}
          sub={s.reached ? `day ${s.reached.n} of ${s.days}` : s.projection ? `${num(s.projection.need_m3)} m³ more at ${num(s.projection.pace)} m³ a day` : `sold ${num(s.qty)} of ${num(s.be_m3)} m³`}
          note={prev?.reached ? `${prev.short}: ${dayShort(prev.reached.day)} (day ${prev.reached.n})` : null} />
        <Tile label={s.reached ? "Safety margin" : "Still to cover"} value={s.safety_m3 == null ? "—" : `${num(Math.abs(s.safety_m3))} m³`}
          sub={s.safety_pct == null ? null : s.safety_m3 >= 0 ? `${pct(s.safety_pct)} above break-even` : "short of break-even"}
          note={s.safety_m3 >= 0 ? "sales could fall this far before a loss" : `fixed costs not yet covered: ${rsL(Math.max(0, s.fixed - s.qty * (s.cm_m3 || 0)))}`} />
      </div>

      <div style={ROW}>
        <Chart s={s} />
        <div style={{ flex: "1 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          {d.current && <SoFar c={d.current} />}
          <Levers levers={d.levers} s={s} />
        </div>
      </div>

      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={ROW}>
        <LinesTable title="Fixed costs — paid every month" sub="The same whether we sell 2,000 m³ or 5,000 m³" total={s.fixed}
          totalNote={`${rsL(s.fixed / s.days)} a day`} lines={fixedLines} kind="fixed" s={s} mayClassify={mayClassify} busy={busy} setKind={setKind} />
        <LinesTable title="Variable costs — rise with every m³" total={s.variable} totalNote={`${rs(s.var_m3)} / m³`}
          sub={<>Per m³ sold · revenue {rs(s.rev_m3)} / m³ − variable {rs(s.var_m3)} / m³ = <b style={{ color: "var(--signal-green)" }}>{rs(s.cm_m3)} left per m³</b></>}
          lines={varLines} kind="variable" s={s} mayClassify={mayClassify} busy={busy} setKind={setKind} />
      </div>

      <History d={d} />

      <div style={{ ...MUTED, lineHeight: 1.6 }}>
        How it is worked out — the same figures as the Profit &amp; Loss, sorted into two groups. Left per m³ = revenue per invoiced m³ (incl. pumping and part-load charges) − variable costs per m³ sold.
        Break-even m³ = fixed costs ÷ left per m³. The day it is reached = the first day the month’s m³ sold, added up day by day, reach the break-even m³.
        Tax on profit is left out — it only arises after break-even. A figure not in yet (payroll not locked, the month’s power or rent not entered) is borrowed from the latest month that has it — a fixed cost as it was, a variable one per m³ — and named above.
        {mayClassify ? " Change a cost’s group with its Fixed / Variable switch; the setting applies to every month." : ""}
        {s.held_m3 > 0 ? ` ${num(s.held_m3, 1)} m³ held with no price are counted at the month’s average revenue per m³.` : ""}
      </div>
    </div>
  );
}

function Chart({ s }) {
  const W = 760, H = 240, TOP = 12;
  const pts = s.daily.filter((x) => x.cum_contribution != null);
  const maxV = Math.max(s.fixed * 1.15, ...pts.map((x) => x.cum_contribution), 1);
  const x = (n) => ((n - 0.5) / s.days) * W;
  const y = (v) => H - 1 - (Math.max(0, v) / maxV) * (H - 1 - TOP);
  const line = ["0," + y(0), ...pts.map((p) => `${x(p.n).toFixed(1)},${y(p.cum_contribution).toFixed(1)}`)].join(" ");
  const last = pts[pts.length - 1];
  const area = last ? `${line} ${x(last.n).toFixed(1)},${H - 1} 0,${H - 1}` : "";
  let beX = null;
  if (s.reached) {
    const i = pts.findIndex((p) => p.n === s.reached.n);
    const a = i > 0 ? pts[i - 1] : { n: 0.5, cum_contribution: 0 }, b = pts[i];
    const f = b.cum_contribution > a.cum_contribution ? (s.fixed - a.cum_contribution) / (b.cum_contribution - a.cum_contribution) : 1;
    beX = (i > 0 ? x(a.n) : 0) + f * (x(b.n) - (i > 0 ? x(a.n) : 0));
  }
  const fy = y(s.fixed);
  const ticks = Array.from({ length: s.days }, (_, i) => i + 1);
  const label = s.reached
    ? `Running contribution in ${s.label} crosses fixed costs of ${lakh(s.fixed)} lakh on day ${s.reached.n}${last ? ` and reaches ${lakh(last.cum_contribution)} lakh by day ${last.n}` : ""}`
    : `Running contribution in ${s.label} is ${last ? lakh(last.cum_contribution) : 0} lakh against fixed costs of ${lakh(s.fixed)} lakh`;
  return (
    <div style={panel("2 1 640px")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>{s.reached ? `When ${s.label.split(" ")[0]} paid for itself` : `${s.label.split(" ")[0]} so far`}</h2>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", ...MUTED }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 14, height: 3, background: C.left, display: "inline-block" }} />Contribution earned so far</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 14, height: 0, borderTop: `2px dashed ${C.bad}`, display: "inline-block" }} />Fixed costs {rsL(s.fixed)}</span>
        </div>
      </div>
      <div style={SUB}>Every m³ sold leaves {rs(s.cm_m3)} after its variable costs. Once that adds up to the month’s fixed costs, the rest of the month is profit.</div>
      <div style={{ position: "relative", marginTop: 14 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={label}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={TOP + (H - TOP) * f} y2={TOP + (H - TOP) * f} stroke="#ECEAE4" />)}
          <line x1="0" x2={W} y1={H - 1} y2={H - 1} stroke="#C8C2B5" />
          {beX != null && <rect x={beX} y="0" width={Math.max(0, (last ? x(last.n) : W) - beX)} height={H} fill="#E4F2EC" opacity="0.6" />}
          {area && <polygon points={area} fill={C.left} opacity="0.1" />}
          <polyline points={line} fill="none" stroke={C.left} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={W} y1={fy} y2={fy} stroke={C.bad} strokeWidth="2" strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
          {beX != null && <line x1={beX} x2={beX} y1="0" y2={H} stroke="#22262B" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        </svg>
        {beX != null && (
          <div style={{ position: "absolute", ...(beX / W > 0.5 ? { right: `${Math.max(0, 100 - (beX / W) * 100)}%` } : { left: `${(beX / W) * 100}%` }),
            top: 10, background: "var(--charcoal)", color: "#fff", fontSize: 12, fontWeight: 600, padding: "5px 9px", borderRadius: 6, whiteSpace: "nowrap" }}>
            Break-even {dayShort(s.reached.day)} · {num(s.be_m3)} m³</div>
        )}
        {s.reached && s.profit_since != null && (
          <div style={{ position: "absolute", right: 8, bottom: 10, fontSize: 12, color: "#1D4F3A", fontWeight: 600, textAlign: "right", background: "rgba(255,255,255,.75)", borderRadius: 6, padding: "2px 6px" }}>
            Profit after break-even<br /><span style={{ fontSize: 18, ...NUM }}>{rsL(s.profit_since)}</span></div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${s.days}, minmax(0, 1fr))`, marginTop: 4 }}>
        {ticks.map((n) => (
          <div key={n} style={{ fontSize: 10.5, color: "var(--slate)", textAlign: "center", fontWeight: s.reached?.n === n ? 700 : 400, ...NUM }}>
            {n === 1 || n % 5 === 0 || s.reached?.n === n ? n : ""}</div>
        ))}
      </div>
      <div style={{ ...GRID(170), marginTop: 14 }}>
        <Mini label="Fixed costs a day" value={rsL(s.fixed / s.days)} sub={`${rsL(s.fixed)} ÷ ${s.days} days, sales or not`} />
        <Mini label="Needed to break even" value={s.be_m3 == null ? "—" : `${num(s.be_m3 / s.days)} m³ a day`} sub={s.be_m3 == null ? "" : `${num(s.be_m3)} m³ over the month`} />
        <Mini label="Actually sold" value={s.days_so_far ? `${num(s.qty / s.days_so_far)} m³ a day` : "—"} sub={`${num(s.qty)} m³ in ${s.days_so_far} days`} />
      </div>
    </div>
  );
}

function Mini({ label, value, sub }) {
  return (
    <div style={{ background: "#F7F5F0", borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, ...NUM }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--slate)" }}>{sub}</div>
    </div>
  );
}

function SoFar({ c }) {
  const pctCovered = c.be_m3 ? Math.min(100, (Math.min(c.qty, c.be_m3) / Math.max(c.qty, c.be_m3)) * 100) : 0;
  return (
    <div style={panel("0 0 auto")}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 style={H2}>{c.label.split(" ")[0]} so far</h2>
        <span className={`badge ${c.reached ? "badge-success" : "badge-warning"}`}>{c.reached ? "Break-even reached" : "Covering fixed costs"}</span>
      </div>
      <div style={SUB}>1–{c.days_so_far} {c.short.split(" ")[0]} · live, updates as loads are delivered</div>
      {c.be_m3 != null && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", ...MUTED }}><span>Sold {num(c.qty)} m³</span><span>needed {num(c.be_m3)} m³</span></div>
          <div style={{ position: "relative", height: 14, borderRadius: 7, background: "var(--concrete)", overflow: "hidden", marginTop: 5 }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${c.reached ? (c.be_m3 / c.qty) * 100 : pctCovered}%`, background: C.soft }} />
            {c.reached && <div style={{ position: "absolute", left: `${(c.be_m3 / c.qty) * 100}%`, top: 0, bottom: 0, right: 0, background: C.left }} />}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--slate)", marginTop: 4 }}><span>covering fixed costs</span>{c.reached && <span>profit</span>}</div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
        <div><div style={{ ...MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{c.reached ? "Reached on" : "Expected"}</div>
          <div style={{ fontSize: 20, fontWeight: 700, ...NUM }}>{c.reached ? dayShort(c.reached.day) : c.projection?.on ? `~${dayShort(c.projection.on)}` : c.projection ? "Not this month" : "—"}</div>
          <div style={{ ...MUTED }}>{c.reached ? `day ${c.reached.n} of ${c.days}` : c.projection ? `${num(c.projection.need_m3)} m³ more · about ${num(c.projection.days_more)} days at this pace` : ""}</div></div>
        <div><div style={{ ...MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{c.reached ? "Profit since" : "Fixed costs to cover"}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: c.reached ? "var(--signal-green)" : undefined, ...NUM }}>{c.reached ? rsL(c.profit_since) : rsL(Math.max(0, c.fixed - c.qty * (c.cm_m3 || 0)))}</div>
          <div style={MUTED}>{c.reached ? `${num(c.qty - c.be_m3)} m³ × ${rs(c.cm_m3)}` : `of ${rsL(c.fixed)}`}</div></div>
      </div>
      {c.estimated.length > 0 && (
        <div style={{ marginTop: 14 }}><Note>Estimated until entered: {c.estimated.map((e) => e.label).join(", ")}.</Note></div>
      )}
    </div>
  );
}

function Levers({ levers, s }) {
  if (!levers.length) return null;
  return (
    <div style={panel("0 0 auto")}>
      <h2 style={H2}>What moves break-even</h2>
      <div style={SUB}>At {s.label}’s figures ({num(s.be_m3)} m³)</div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 10, fontSize: 13 }}>
        {levers.map((l) => (
          <div key={l.what} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <span>{l.what}</span>
            <b style={{ color: l.change_m3 < 0 ? "var(--signal-green)" : "var(--alert-red)", whiteSpace: "nowrap", ...NUM }}>
              {l.change_m3 > 0 ? "+" : "−"}{num(Math.abs(l.change_m3))} m³{l.days != null && l.days >= 0.3 ? ` · ${l.days < 0.8 ? "half a day" : `about ${Math.round(l.days)} day${Math.round(l.days) === 1 ? "" : "s"}`} ${l.change_m3 < 0 ? "sooner" : "later"}` : ""}
            </b>
          </div>
        ))}
      </div>
    </div>
  );
}

function LinesTable({ title, sub, total, totalNote, lines, kind, s, mayClassify, busy, setKind }) {
  return (
    <div style={panel("1 1 520px")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>{title}</h2>
        <div style={{ fontSize: 13, fontWeight: 700, ...NUM }}>{rsL(total)} · {totalNote}</div>
      </div>
      <div style={SUB}>{sub}</div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 480 }}>
          <thead><tr><th>Cost</th><th style={R}>₹ L</th><th style={R}>{kind === "fixed" ? "Share" : "₹ / m³"}</th><th>Source</th>{mayClassify && <th className="no-print">Treat as</th>}</tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td style={{ whiteSpace: "normal" }}>{l.label}
                  <div style={{ fontSize: 11, color: l.estimated ? "var(--amber)" : "var(--slate)" }}>{l.estimated ? `estimated — ${l.estimated.label}` : l.hint}</div></td>
                <td style={{ ...R, fontWeight: kind === "fixed" ? 600 : 400 }}>{lakh(l.amount)}</td>
                <td style={{ ...R, fontWeight: kind === "variable" ? 600 : 400, color: kind === "fixed" ? "#4A525C" : undefined }}>
                  {kind === "fixed" ? pct(total ? (l.amount / total) * 100 : null) : num(l.per_m3)}</td>
                <td><Src src={l.src} /></td>
                {mayClassify && (
                  <td className="no-print">
                    <div role="group" aria-label={`${l.label}: fixed or variable`} style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 7, overflow: "hidden" }}>
                      {["fixed", "variable"].map((k) => (
                        <button key={k} type="button" aria-pressed={l.kind === k} disabled={busy === l.key || l.kind === k} onClick={() => setKind(l.key, k)}
                          style={{ padding: "6px 10px", minHeight: 32, border: "none", borderRadius: 0, fontSize: 11.5, opacity: 1,
                            background: l.kind === k ? "var(--charcoal)" : "var(--surface)", color: l.kind === k ? "#fff" : "#4A525C", cursor: l.kind === k ? "default" : "pointer" }}>
                          {k === "fixed" ? "Fixed" : "Variable"}</button>
                      ))}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>None in this group.</td></tr>}
          </tbody>
          <tfoot><tr><td style={{ fontWeight: 700 }}>Total {kind}</td><td style={{ ...R, fontWeight: 700 }}>{lakh(total)}</td>
            <td style={{ ...R, fontWeight: 700 }}>{kind === "fixed" ? "100%" : num(s.var_m3)}</td><td />{mayClassify && <td className="no-print" />}</tr></tfoot>
        </table>
      </div>
      {kind === "variable" && s.rev_m3 > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <div role="img" aria-label={`Of ${num(s.rev_m3)} rupees revenue per m3: variable costs ${num(s.var_m3)}, left ${num(s.cm_m3)}`}
            style={{ display: "flex", height: 22, borderRadius: 6, overflow: "hidden", gap: 2, background: "var(--concrete)" }}>
            <div style={{ width: `${Math.min(100, (s.var_m3 / s.rev_m3) * 100)}%`, background: C.rm }} />
            {s.cm_m3 > 0 && <div style={{ width: `${(s.cm_m3 / s.rev_m3) * 100}%`, background: C.left }} />}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", ...MUTED }}>
            <span>Variable {rs(s.var_m3)} ({pct((s.var_m3 / s.rev_m3) * 100)})</span><span>Left {rs(s.cm_m3)} ({pct(s.cm_pct)})</span></div>
        </div>
      )}
    </div>
  );
}

function History({ d }) {
  const rows = [...d.history];
  if (d.current) rows.push({ ...d.current, so_far: true });
  return (
    <div style={panel("1 1 100%")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>Break-even month by month</h2>
        <div style={MUTED}>The bar is the month; the dark mark is the day fixed costs were covered</div>
      </div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 980 }}>
          <thead><tr><th>Month</th><th style={R}>Sold m³</th><th style={R}>Fixed ₹ L</th><th style={R}>Left per m³</th><th style={R}>Break-even m³</th><th>Reached on</th>
            <th style={{ minWidth: 200 }}>Through the month</th><th style={R}>Safety margin</th><th style={R}>Profit before tax ₹ L</th></tr></thead>
          <tbody>
            {rows.map((m) => {
              const at = m.reached ? m.reached.n : null;
              const upTo = m.so_far ? m.days_so_far : m.days;
              return (
                <tr key={m.month} style={{ background: m.month === d.month ? "#F7F5F0" : undefined }}>
                  <td style={{ fontWeight: 600 }}>{m.label}{(m.so_far || m.estimated.length > 0) && (
                    <div style={{ fontSize: 11, color: "var(--slate)", fontWeight: 400 }}>{[m.so_far ? `so far, to ${dayShort(m.daily?.[m.daily.length - 1]?.day || `${m.month}-${String(m.days_so_far).padStart(2, "0")}`)}` : null, m.estimated.length ? "some figures estimated" : null].filter(Boolean).join(" · ")}</div>)}</td>
                  <td style={R}>{num(m.qty)}</td>
                  <td style={R}>{lakh(m.fixed)}</td>
                  <td style={R}>{rs(m.cm_m3)}</td>
                  <td style={{ ...R, fontWeight: 700 }}>{num(m.be_m3)}</td>
                  <td style={{ fontWeight: 600, ...NUM }}>{at ? `${dayShort(m.reached.day)} · day ${at}` : m.so_far ? (m.projection?.on ? `expected ~${dayShort(m.projection.on)}` : "not yet") : <span style={{ color: "var(--alert-red)" }}>not reached</span>}</td>
                  <td>
                    <div style={{ position: "relative", height: 12, borderRadius: 6, background: "var(--concrete)", overflow: "hidden" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${((at || upTo) / m.days) * 100}%`, background: "#E7D8AE" }} />
                      {at && <div style={{ position: "absolute", left: `${(at / m.days) * 100}%`, top: 0, bottom: 0, width: `${((upTo - at) / m.days) * 100}%`, background: C.soft }} />}
                      {at && <div style={{ position: "absolute", left: `${(at / m.days) * 100}%`, top: -1, bottom: -1, width: 3, background: "var(--charcoal)" }} />}
                    </div>
                  </td>
                  <td style={R}>{m.safety_m3 == null ? "—" : m.so_far && !at ? "—" : `${num(m.safety_m3)} m³ · ${pct(m.safety_pct, 0)}`}</td>
                  <td style={{ ...R, fontWeight: 700, color: m.pbt < 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{m.so_far && at ? lakh(m.profit_since) : lakh(m.pbt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", ...MUTED, marginTop: 10 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: "#E7D8AE", display: "inline-block" }} />days covering fixed costs</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: C.soft, display: "inline-block" }} />days in profit</span>
        <span>Safety margin = how far sales could fall before a loss.{d.current ? " This month’s profit is the profit since break-even." : ""}</span>
      </div>
    </div>
  );
}

function exportBE(d) {
  const s = d.selected;
  const L = (v) => (v == null ? "" : Math.round(v) / 100000);
  const rows = [[`Break-even — ${s.label}`], ["₹ lakh excl. GST"], [],
    ["Revenue per m³", s.rev_m3], ["Variable cost per m³", s.var_m3], ["Left per m³", s.cm_m3], ["Fixed costs ₹ L", L(s.fixed)],
    ["Break-even m³", s.be_m3], ["Reached on", s.reached ? s.reached.day : ""], ["Sold m³", s.qty], ["Safety margin m³", s.safety_m3], [],
    ["Cost", "Group", "₹ L", "₹ / m³", "Note"],
    ...s.lines.map((l) => [l.label, l.kind === "fixed" ? "Fixed" : "Variable", L(l.amount), l.per_m3, l.estimated ? `estimated — ${l.estimated.label}` : ""])];
  const hist = [["Month", "Sold m³", "Fixed ₹ L", "Variable ₹ L", "Revenue ₹ L", "Left per m³", "Break-even m³", "Reached on", "Day", "Safety margin m³", "Profit before tax ₹ L"],
    ...[...d.history, ...(d.current ? [d.current] : [])].map((m) => [m.label, m.qty, L(m.fixed), L(m.variable), L(m.revenue), m.cm_m3, m.be_m3, m.reached ? m.reached.day : "", m.reached ? m.reached.n : "", m.safety_m3, L(m.pbt)])];
  const daily = [["Day", "m³ sold", "m³ to date", "Contribution to date ₹ L"], ...s.daily.map((x) => [x.day, x.qty, x.cum_qty, L(x.cum_contribution)])];
  downloadExcel(`Break-even ${d.month}.xlsx`, [{ name: "Break-even", rows }, { name: "Month by month", rows: hist }, { name: "Day by day", rows: daily }]);
}

