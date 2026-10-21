// Round 221 — Break-even (owner, 21 Oct 2026; mock-up "Break-even — Monthly").
// The month's costs in two groups — fixed (paid every month whatever we sell)
// and variable (rise with every m³) — the m³ needed to cover the fixed costs,
// and the day each month got there. Which group a cost is in is an
// Administrator setting (cost.classify), applied to every month.
// Round 222 (owner): break-even is the point in the month where what each m³
// sold leaves after its variable costs, added up day by day from each day's
// own sales and material, has paid the month's fixed costs; everything sold
// after that day carries only variable cost and is profit. Salaries, pump
// gangs and contract labour are always in — estimated from the employee
// records until the payroll is locked.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  useCostData, Loading, Modal, MonthSelect, Actions, BTN, Tile, Note, Src, downloadExcel,
  lakh, rsL, rs, num, pct, C, H2, SUB, MUTED, R, NUM, GRID, ROW, panel,
} from "./costUi.jsx";

// m³ sold when the fixed costs were covered; this month, sold so far + the m³
// still needed; a month that never got there, fixed ÷ left per m³.
const beVol = (m) => (m.reached ? m.reached.m3 : m.projection?.need_m3 != null ? Math.round(m.qty + m.projection.need_m3) : m.be_m3);
const dayShort = (ymd) => (ymd ? new Date(`${ymd}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "—");

export default function CostBreakEvenTab({ month, setMonth }) {
  const { can } = usePermissions();
  const mayClassify = can("cost.classify", "edit");
  const { data: d, error, reload } = useCostData(`/cost/break-even?month=${month}`);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [working, setWorking] = useState(false);   // Round 225 — the calculation, step by step

  async function setKind(key, kind, fixedAmount) {
    setBusy(key); setErr("");
    try {
      await apiRequest("/cost/line-kinds", { method: "PUT", body: { kinds: { [key]: kind }, fixed_amounts: kind === "mixed" ? { [key]: fixedAmount } : {} } });
      reload();
      return true;
    } catch (e) { setErr(e.message); return false; } finally { setBusy(""); }
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
        <button type="button" style={BTN} disabled={!d || d.month !== month} onClick={() => setWorking(true)}>Show the calculation</button>
        <button type="button" style={BTN} disabled={!d} onClick={() => exportBE(d)}>Export Excel</button>
        <button type="button" className="btn-primary" style={BTN} onClick={() => window.print()}>Print / PDF</button>
      </Actions>
    </div>
  );
  if (!d || d.month !== month) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;

  const fixedLines = s.lines.filter((l) => l.kind === "fixed" || l.kind === "mixed");
  const varLines = s.lines.filter((l) => l.kind === "variable" || l.kind === "mixed");
  const show = () => setWorking(true);
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
        <Tile label="Fixed costs" value={rsL(s.fixed)} sub={`${rsL(s.fixed / s.days)} a day`} note={prev ? `${prev.short}: ${rsL(prev.fixed)}` : null} onClick={show} />
        <Tile label="Left per m³ after variable costs" value={rs(s.cm_m3)} sub={`${pct(s.cm_pct)} of ${rs(s.rev_m3)} revenue`}
          note={`variable ${rs(s.var_m3)} / m³${prev ? ` · ${prev.short} ${rs(prev.cm_m3)}` : ""}`} onClick={show} />
        <Tile onClick={show} label="Break-even volume" value={beVol(s) == null ? "—" : `${num(beVol(s))} m³`}
          sub={s.reached ? `sold by ${dayShort(s.reached.day)}` : s.projection ? `${num(s.qty)} sold + ${num(s.projection.need_m3)} more` : s.be_m3 != null ? `needed at ${rs(s.cm_m3)} left per m³` : null}
          note={prev && beVol(prev) != null ? `${prev.short}: ${num(beVol(prev))} m³` : null} />
        <Tile dark onClick={show} label={s.reached || !s.is_current ? "Break-even reached" : "Break-even expected"} value={reachedText}
          sub={s.reached ? `day ${s.reached.n} of ${s.days}` : s.projection ? `${num(s.projection.need_m3)} m³ more at ${num(s.projection.pace)} m³ a day` : `sold ${num(s.qty)} of ${num(beVol(s))} m³`}
          note={prev?.reached ? `${prev.short}: ${dayShort(prev.reached.day)} (day ${prev.reached.n})` : null} />
        <Tile label={s.reached ? "Safety margin" : "Still to cover"} value={s.safety_m3 == null ? "—" : `${num(Math.abs(s.safety_m3))} m³`}
          sub={s.safety_pct == null ? null : s.safety_m3 >= 0 ? `${pct(s.safety_pct)} above break-even` : "short of break-even"}
          note={s.safety_m3 >= 0 ? "sales could fall this far before a loss" : `fixed costs not yet covered: ${rsL(Math.max(0, s.fixed - s.covered))}`} />
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
        How it is worked out — the same figures as the Profit &amp; Loss, sorted into two groups. For each day: that day’s sales (incl. pumping and part-load charges) − that day’s raw material − the other variable costs for the m³ sold that day = what the day left. Those are added up day by day; break-even is the day, and the m³ sold, at which the total reaches the month’s fixed costs. After that, what we sell carries only its variable cost and the rest is profit.
        It is a guide to whether the month will end in profit or loss, not an exact figure. Salaries, pump gangs and contract labour are always counted — until the month’s payroll is locked they are estimated from the employee records (monthly salary or daily rate × working days, employer PF / ESI). Other figures not in yet (power, rent, incentives) are borrowed from the latest month that has them and named above. Tax on profit is left out — it only arises after break-even.
        {mayClassify ? " Change a cost’s group with its Fixed / Variable / Part fixed switch; the setting applies to every month. Part fixed: a fixed ₹ a month (e.g. the power bill’s fixed / demand charge) — the rest of that cost is variable." : ""}
        {" "}<button type="button" className="btn-link no-print" onClick={show} style={{ fontSize: 11.5, padding: 0, minHeight: 0 }}>Show the calculation, step by step ›</button>
        {s.held_m3 > 0 ? ` ${num(s.held_m3, 1)} m³ held with no price are counted at the month’s average revenue per m³.` : ""}
      </div>
      {working && <Workings s={s} onClose={() => setWorking(false)} />}
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
      <div style={SUB}>Each day’s sales less that day’s material and other variable costs, added up. Once the total pays the month’s fixed costs, every m³ after that carries only its variable cost — the rest is profit. (Month average: {rs(s.cm_m3)} left per m³.)</div>
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
            Break-even {dayShort(s.reached.day)} · {num(s.reached.m3)} m³</div>
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
        <Mini label="Needed to break even" value={beVol(s) == null ? "—" : `${num(beVol(s) / s.days)} m³ a day`} sub={beVol(s) == null ? "" : `${num(beVol(s))} m³ over the month`} />
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
  const need = beVol(c);
  const pctCovered = c.fixed > 0 ? Math.min(100, (c.covered / c.fixed) * 100) : 0;
  return (
    <div style={panel("0 0 auto")}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 style={H2}>{c.label.split(" ")[0]} so far</h2>
        <span className={`badge ${c.reached ? "badge-success" : "badge-warning"}`}>{c.reached ? "Break-even reached" : "Covering fixed costs"}</span>
      </div>
      <div style={SUB}>1–{c.days_so_far} {c.short.split(" ")[0]} · live, updates as loads are delivered</div>
      {need != null && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", ...MUTED }}><span>Sold {num(c.qty)} m³</span><span>needed {num(need)} m³</span></div>
          <div style={{ position: "relative", height: 14, borderRadius: 7, background: "var(--concrete)", overflow: "hidden", marginTop: 5 }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${c.reached ? (need / c.qty) * 100 : pctCovered}%`, background: C.soft }} />
            {c.reached && <div style={{ position: "absolute", left: `${(need / c.qty) * 100}%`, top: 0, bottom: 0, right: 0, background: C.left }} />}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--slate)", marginTop: 4 }}><span>covering fixed costs</span>{c.reached && <span>profit</span>}</div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
        <div><div style={{ ...MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{c.reached ? "Reached on" : "Expected"}</div>
          <div style={{ fontSize: 20, fontWeight: 700, ...NUM }}>{c.reached ? dayShort(c.reached.day) : c.projection?.on ? `~${dayShort(c.projection.on)}` : c.projection ? "Not this month" : "—"}</div>
          <div style={{ ...MUTED }}>{c.reached ? `day ${c.reached.n} of ${c.days}` : c.projection ? `${num(c.projection.need_m3)} m³ more · about ${num(c.projection.days_more)} days at this pace` : ""}</div></div>
        <div><div style={{ ...MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{c.reached ? "Profit since" : "Fixed costs to cover"}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: c.reached ? "var(--signal-green)" : undefined, ...NUM }}>{c.reached ? rsL(c.profit_since) : rsL(Math.max(0, c.fixed - c.covered))}</div>
          <div style={MUTED}>{c.reached ? `on ${num(c.qty - c.reached.m3)} m³ sold after` : `${rsL(c.covered)} of ${rsL(c.fixed)} covered`}</div></div>
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
      <div style={SUB}>At {s.label}’s figures ({num(beVol(s))} m³)</div>
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
  const [mixing, setMixing] = useState(null);     // { key, amount }
  const part = (l) => (kind === "fixed" ? l.fixed_part : l.var_part);
  async function saveMixed() {
    if (await setKind(mixing.key, "mixed", Number(mixing.amount))) setMixing(null);
  }
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
              <tr key={l.key} style={{ verticalAlign: "top" }}>
                <td style={{ whiteSpace: "normal" }}>{l.label}{l.kind === "mixed" && <b style={{ fontWeight: 600, color: "#55357A" }}> · {kind === "fixed" ? "fixed part" : "usage part"}</b>}
                  {l.kind === "mixed" && <div style={{ fontSize: 11, color: "#55357A" }}>{kind === "fixed"
                    ? `₹${num(l.fixed_amount)} a month of ${rsL(l.amount)}${l.fixed_amount > l.amount ? " (capped at the month’s figure)" : ""}`
                    : `${rsL(l.amount)} less the fixed ₹${num(l.fixed_part)}`}</div>}
                  <div style={{ fontSize: 11, color: l.estimated ? "var(--amber)" : "var(--slate)" }}>{l.estimated ? `estimated — ${l.estimated.label}` : l.hint}</div></td>
                <td style={{ ...R, fontWeight: kind === "fixed" ? 600 : 400 }}>{lakh(part(l))}</td>
                <td style={{ ...R, fontWeight: kind === "variable" ? 600 : 400, color: kind === "fixed" ? "#4A525C" : undefined }}>
                  {kind === "fixed" ? pct(total ? (part(l) / total) * 100 : null) : num(l.per_m3)}</td>
                <td><Src src={l.src} /></td>
                {mayClassify && (
                  <td className="no-print">
                    <div role="group" aria-label={`${l.label}: fixed, variable or part fixed`} style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 7, overflow: "hidden" }}>
                      {["fixed", "variable", "mixed"].map((k) => (
                        <button key={k} type="button" aria-pressed={l.kind === k} disabled={busy === l.key || (l.kind === k && k !== "mixed")}
                          onClick={() => (k === "mixed" ? setMixing({ key: l.key, amount: l.fixed_amount ?? "" }) : setKind(l.key, k))}
                          style={{ padding: "6px 9px", minHeight: 32, border: "none", borderRadius: 0, fontSize: 11.5, opacity: 1, whiteSpace: "nowrap",
                            background: l.kind === k ? "var(--charcoal)" : "var(--surface)", color: l.kind === k ? "#fff" : "#4A525C", cursor: l.kind === k && k !== "mixed" ? "default" : "pointer" }}>
                          {k === "fixed" ? "Fixed" : k === "variable" ? "Variable" : "Part fixed"}</button>
                      ))}
                    </div>
                    {mixing?.key === l.key && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                        <label style={{ fontSize: 11.5, color: "#4A525C", display: "flex", gap: 4, alignItems: "center" }}>Fixed ₹ a month
                          <input type="number" min="0" step="1" value={mixing.amount} autoFocus onChange={(e) => setMixing({ ...mixing, amount: e.target.value })}
                            onKeyDown={(e) => { if (e.key === "Enter") saveMixed(); if (e.key === "Escape") setMixing(null); }} style={{ width: 110, minHeight: 32 }} /></label>
                        <button type="button" className="btn-primary" disabled={busy === l.key || mixing.amount === ""} onClick={saveMixed} style={{ fontSize: 11.5, padding: "4px 10px", minHeight: 32 }}>Save</button>
                        <button type="button" onClick={() => setMixing(null)} style={{ fontSize: 11.5, padding: "4px 10px", minHeight: 32 }}>Cancel</button>
                        <div style={{ ...MUTED, width: "100%" }}>e.g. the power bill’s fixed / demand charge — the rest of the bill counts per m³</div>
                      </div>
                    )}
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
  const rows = d.history.map((m) => ({ ...m }));
  if (d.current) rows.push({ ...d.current, so_far: true });
  for (const m of rows) if (m.is_current) m.so_far = true;
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
                  <td style={{ ...R, fontWeight: 700 }}>{num(beVol(m))}</td>
                  <td style={{ fontWeight: 600, ...NUM }}>{at ? `${dayShort(m.reached.day)} · day ${at}` : m.so_far ? (m.projection?.on ? `expected ~${dayShort(m.projection.on)}` : "not yet") : <span style={{ color: "var(--alert-red)" }}>not reached</span>}</td>
                  <td>
                    <div style={{ position: "relative", height: 12, borderRadius: 6, background: "var(--concrete)", overflow: "hidden" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${((at || upTo) / m.days) * 100}%`, background: "#E7D8AE" }} />
                      {at && <div style={{ position: "absolute", left: `${(at / m.days) * 100}%`, top: 0, bottom: 0, width: `${((upTo - at) / m.days) * 100}%`, background: C.soft }} />}
                      {at && <div style={{ position: "absolute", left: `${(at / m.days) * 100}%`, top: -1, bottom: -1, width: 3, background: "var(--charcoal)" }} />}
                    </div>
                  </td>
                  <td style={R}>{m.safety_m3 == null ? "—" : m.so_far && !at ? "—" : `${num(m.safety_m3)} m³ · ${pct(m.safety_pct, 0)}`}</td>
                  <td style={{ ...R, fontWeight: 700, color: m.pbt < 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{m.so_far ? lakh(at ? m.profit_since : m.earned - m.fixed) : lakh(m.pbt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", ...MUTED, marginTop: 10 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: "#E7D8AE", display: "inline-block" }} />days covering fixed costs</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: C.soft, display: "inline-block" }} />days in profit</span>
        <span>Safety margin = how far sales could fall before a loss.{rows.some((m) => m.so_far) ? " This month: profit since break-even, or (minus) the fixed costs still to cover." : ""}</span>
      </div>
    </div>
  );
}

function exportBE(d) {
  const s = d.selected;
  const L = (v) => (v == null ? "" : Math.round(v) / 100000);
  const rows = [[`Break-even — ${s.label}`], ["₹ lakh excl. GST"], [],
    ["Revenue per m³", s.rev_m3], ["Variable cost per m³", s.var_m3], ["Left per m³", s.cm_m3], ["Fixed costs ₹ L", L(s.fixed)],
    ["Break-even m³", beVol(s)], ["Reached on", s.reached ? s.reached.day : ""], ["Sold m³", s.qty], ["Safety margin m³", s.safety_m3], [],
    ["Cost", "Group", "₹ L", "Fixed part ₹ L", "Variable part ₹ L", "Variable ₹ / m³", "Note"],
    ...s.lines.map((l) => [l.label, l.kind === "fixed" ? "Fixed" : l.kind === "mixed" ? `Part fixed (₹${l.fixed_amount} a month)` : "Variable", L(l.amount), L(l.fixed_part), L(l.var_part), l.per_m3, l.estimated ? `estimated — ${l.estimated.label}` : ""])];
  const hist = [["Month", "Sold m³", "Fixed ₹ L", "Variable ₹ L", "Revenue ₹ L", "Left per m³", "Break-even m³", "Reached on", "Day", "Safety margin m³", "Profit before tax ₹ L"],
    ...[...d.history, ...(d.current ? [d.current] : [])].map((m) => [m.label, m.qty, L(m.fixed), L(m.variable), L(m.revenue), m.cm_m3, beVol(m), m.reached ? m.reached.day : "", m.reached ? m.reached.n : "", m.safety_m3, L(m.pbt)])];
  const daily = [["Day", "m³ sold", "Sales ₹", "Other income ₹", "Raw material ₹", "Other variable costs ₹", "Left that day ₹", "m³ to date", "Left to date ₹", "Fixed costs ₹", "Still to cover ₹"],
    ...s.daily.map((x) => [x.day, x.qty, Math.round(x.revenue), Math.round(x.other_income), Math.round(x.material), Math.round(x.other_var), Math.round(x.balance), x.cum_qty,
      Math.round(x.cum_contribution), Math.round(s.fixed), Math.round(Math.max(0, s.fixed - x.cum_contribution))])];
  downloadExcel(`Break-even ${d.month}.xlsx`, [{ name: "Break-even", rows }, { name: "Month by month", rows: hist }, { name: "Day by day", rows: daily }]);
}


// ------------------------------------------------------------------------
// Round 225 (owner, 21 Oct 2026: "i am not convinced the breakeven
// calculation, it is better to show the calculations somewhere in the app").
// Every step with the month's own figures, the same numbers the page uses.
const rupee = (v, d = 0) => `${v < 0 ? "−" : ""}₹${num(Math.abs(v), d)}`;
const STEP = { display: "flex", flexDirection: "column", gap: 8, padding: "14px 0", borderTop: "1px solid var(--border)" };
function StepHead({ n, children }) {
  return <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, display: "flex", gap: 8, alignItems: "baseline" }}>
    <span style={{ background: "var(--charcoal)", color: "#fff", borderRadius: 20, minWidth: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{n}</span>{children}</h3>;
}
function SumTable({ rows, total, totalLabel, cols = ["", "₹"] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ minWidth: 420 }}>
        <thead><tr>{cols.map((c, i) => <th key={i} style={i ? R : undefined}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={j ? R : { whiteSpace: "normal" }}>{c}</td>)}</tr>)}</tbody>
        {total && <tfoot><tr><td>{totalLabel}</td>{total.map((t, i) => <td key={i} style={R}>{t}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

function Workings({ s, onClose }) {
  const c = s.calc;
  const varLines = s.lines.filter((l) => l.var_part);
  const fixLines = s.lines.filter((l) => l.fixed_part);
  const cross = s.daily.find((x) => x.reached);
  const last = s.daily[s.daily.length - 1];
  const sales = r2(c.concrete + c.pumping + c.part_load);
  const diff = r2(s.earned - s.fixed - s.pbt);
  return (
    <Modal title={`How break-even is worked out — ${s.label}`} onClose={onClose} width={980}>
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>
        <div style={{ color: "#3F4750" }}>
          The month’s figures from the Profit &amp; Loss, sorted into costs that stay the same whatever we sell (fixed) and costs that rise with every m³ (variable).
          Every m³ sold leaves something after its variable cost; added up day by day, the day that total pays the month’s fixed costs is break-even.
          All amounts excl. GST{s.is_current ? `; this month so far, ${s.days_so_far} of ${s.days} days` : ""}.
        </div>

        <div style={STEP}>
          <StepHead n="1">Sales and revenue per m³</StepHead>
          <SumTable cols={["", "₹"]} rows={[
            ["Sale of concrete (tax invoices, GST taken out)", rupee(c.concrete)],
            ["Pumping charges", rupee(c.pumping)],
            ["Part-load & waiting charges", rupee(c.part_load)],
            ["Other income", rupee(c.other_income)],
          ]} total={[rupee(s.revenue)]} totalLabel="Revenue" />
          <div>Revenue per m³ = {rupee(s.revenue)} ÷ {num(s.invoiced_m3, 1)} m³ invoiced = <b>{rupee(s.rev_m3)} per m³</b>
            {s.held_m3 > 0 ? ` (${num(s.held_m3, 1)} m³ delivered but not yet invoiced are left out here — they have no price yet)` : ""}.</div>
        </div>

        <div style={STEP}>
          <StepHead n="2">Variable costs per m³</StepHead>
          <SumTable cols={["Cost", "₹ in the month", "₹ per m³"]} rows={varLines.map((l) => [
            <>{l.label}{l.kind === "mixed" ? <span style={MUTED}> — usage part: {rupee(l.amount)} less fixed {rupee(l.fixed_part)}</span> : null}{l.estimated ? <span style={{ ...MUTED, color: "var(--amber)" }}> — estimated: {l.estimated.label}</span> : null}</>,
            rupee(l.var_part), num(l.per_m3)])} total={[rupee(s.variable), num(s.var_m3)]} totalLabel="Variable costs" />
          <div>Variable cost per m³ = {rupee(s.variable)} ÷ {num(s.qty, 1)} m³ sold = <b>{rupee(s.var_m3)} per m³</b>.</div>
        </div>

        <div style={STEP}>
          <StepHead n="3">What each m³ leaves (month average)</StepHead>
          <div>{rupee(s.rev_m3)} revenue − {rupee(s.var_m3)} variable = <b>{rupee(s.cm_m3)} left per m³</b> ({pct(s.cm_pct)} of revenue) towards the fixed costs.</div>
        </div>

        <div style={STEP}>
          <StepHead n="4">Fixed costs of the month</StepHead>
          <SumTable cols={["Cost", "₹"]} rows={fixLines.map((l) => [
            <>{l.label}{l.kind === "mixed" ? <span style={MUTED}> — fixed part, ₹{num(l.fixed_amount)} a month</span> : null}{l.estimated ? <span style={{ ...MUTED, color: "var(--amber)" }}> — estimated: {l.estimated.label}</span> : null}</>,
            rupee(l.fixed_part)])} total={[rupee(s.fixed)]} totalLabel="Fixed costs" />
          <div>That is {rupee(s.fixed / s.days)} a day, whether we sell or not.</div>
        </div>

        <div style={STEP}>
          <StepHead n="5">Quick check with the month average</StepHead>
          <div>{rupee(s.fixed)} fixed ÷ {rupee(s.cm_m3)} left per m³ = <b>{s.be_m3 == null ? "— (nothing is left per m³)" : `${num(s.be_m3)} m³`}</b> to sell before profit starts.
            {s.reached ? ` The day-by-day working below gives ${num(s.reached.m3)} m³ — not the same, because each day’s own price and material are used instead of the month’s average.` : ""}</div>
        </div>

        <div style={STEP}>
          <StepHead n="6">Day by day — what the page uses</StepHead>
          <div>For each day: <b>that day’s sales</b> (each invoiced load at its own invoice value; a load not yet invoiced at the month’s average {rupee(c.avg_inv_m3)} per m³)
            {c.other_income ? <> + other income at {rupee(c.other_income_m3)} per m³</> : null}
            {" "}− <b>that day’s raw material</b> ({c.rm_by_day ? "the plant’s batch weights that day × the month’s rates, scaled so the month adds up to the raw-material figure above" : "spread over the m³ sold, because consumption was not recorded day by day"})
            {" "}− <b>other variable costs</b> at {rupee(c.other_var_m3)} per m³ × that day’s m³ (fuel, power, repairs … are not booked per load)
            {" "}= what the day left. The running total is compared with the fixed costs, {rupee(s.fixed)}.</div>
          <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
            <table style={{ minWidth: 880 }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--surface)" }}>
                <tr><th>Day</th><th style={R}>m³</th><th style={R}>Sales ₹</th>{c.other_income ? <th style={R}>+ Other ₹</th> : null}<th style={R}>− Raw material ₹</th><th style={R}>− Other variable ₹</th>
                  <th style={R}>= Left that day ₹</th><th style={R}>Running total ₹</th><th style={R}>Still to cover ₹</th></tr>
              </thead>
              <tbody>
                {s.daily.map((x) => (
                  <tr key={x.day} style={{ background: x.reached ? "#E4F2EC" : undefined, color: x.qty ? undefined : "var(--slate)", fontWeight: x.reached ? 700 : 400 }}>
                    <td style={{ whiteSpace: "nowrap" }}>{dayShort(x.day)}{x.reached ? " ← break-even" : ""}</td>
                    <td style={R}>{x.qty ? num(x.qty, 1) : "–"}</td>
                    <td style={R}>{num(x.revenue)}</td>
                    {c.other_income ? <td style={R}>{num(x.other_income)}</td> : null}
                    <td style={R}>{num(x.material)}</td>
                    <td style={R}>{num(x.other_var)}</td>
                    <td style={{ ...R, color: x.balance < 0 ? "var(--alert-red)" : undefined }}>{num(x.balance)}</td>
                    <td style={R}>{num(x.cum_contribution)}</td>
                    <td style={R}>{x.cum_contribution >= s.fixed ? "covered" : num(s.fixed - x.cum_contribution)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td>Month</td><td style={R}>{num(s.qty, 1)}</td><td style={R}>{num(c.day_sales)}</td>{c.other_income ? <td style={R}>{num(c.day_other_income)}</td> : null}
                <td style={R}>{num(c.day_material)}</td><td style={R}>{num(c.day_other_var)}</td><td style={R}>{num(s.earned)}</td><td /><td /></tr></tfoot>
            </table>
          </div>
          {cross ? (
            <div style={{ background: "#E4F2EC", borderRadius: 8, padding: "10px 12px" }}>
              <b>The crossing, {dayShort(cross.day)}:</b> before that day the running total was {rupee(cross.before_cum)} after {num(cross.before_qty, 1)} m³.
              {" "}Still needed: {rupee(s.fixed)} − {rupee(cross.before_cum)} = {rupee(s.fixed - cross.before_cum)}.
              {" "}That day left {rupee(cross.balance)} on {num(cross.qty, 1)} m³, so the fixed costs were covered after {rupee(s.fixed - cross.before_cum)} ÷ {rupee(cross.balance)} × {num(cross.qty, 1)} = {num(cross.balance > 0 ? ((s.fixed - cross.before_cum) / cross.balance) * cross.qty : 0, 1)} m³ of it.
              {" "}Break-even = {num(cross.before_qty, 1)} + {num(cross.balance > 0 ? ((s.fixed - cross.before_cum) / cross.balance) * cross.qty : 0, 1)} ≈ <b>{num(s.reached.m3)} m³, on day {s.reached.n}</b>. Everything sold after it carries only its variable cost.
            </div>
          ) : (
            <div style={{ background: "#FFF1D6", borderRadius: 8, padding: "10px 12px" }}>
              <b>Not reached{s.is_current ? " yet" : ""}:</b> the running total {last ? `reached ${rupee(s.earned)} by ${dayShort(last.day)}` : "is ₹0"}, {rupee(s.fixed - s.earned)} short of the fixed costs.
              {s.projection ? <> At the pace so far ({rupee(s.projection.pace_amount)} left a day) that is about {num(s.projection.days_more)} more day(s){s.projection.on ? ` — around ${dayShort(s.projection.on)}` : " — not within this month"}; in m³, {rupee(s.projection.need_amount)} ÷ {rupee(s.cm_m3)} ≈ {num(s.projection.need_m3)} m³ more.</> : null}
            </div>
          )}
        </div>

        <div style={STEP}>
          <StepHead n="7">Ties back to the Profit &amp; Loss</StepHead>
          <SumTable cols={["", "₹"]} rows={[
            ["Running total at the end (what all the m³ left)", rupee(s.earned)],
            ["− Fixed costs", rupee(-s.fixed)],
            [<b key="a">= Profit after break-even (− = loss)</b>, <b key="b">{rupee(s.earned - s.fixed)}</b>],
            ["Profit before tax in the P&L for the same figures", rupee(s.pbt)],
            ...(Math.abs(diff) >= 1 ? [[`Difference — ${num(s.held_m3, 1)} m³ not yet invoiced, counted above at ${rupee(c.avg_inv_m3)} per m³ (${rupee(c.held_value)}); the P&L counts them once invoiced`, rupee(diff)]] : []),
          ]} />
          <div style={MUTED}>Sales {rupee(sales)} + other income {rupee(c.other_income)} − variable {rupee(s.variable)} − fixed {rupee(s.fixed)} = {rupee(s.pbt)}. Tax on profit is left out — it arises only after break-even.</div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
