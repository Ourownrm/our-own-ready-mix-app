import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

// Round 141 — Cube Strength QC dashboard, Administrator only (both the
// backend router and App.jsx's route guard are set to that single role; see
// routes/qcDashboard.js for why it isn't hung off labTechnician.js).
//
// Every figure comes from GET /qc-dashboard/summary. The per-grade
// statistics (sigma, target mean, IS 456 acceptance, the 7d->28d ratio) are
// computed here in one place from the raw result rows the backend returns,
// rather than being re-derived in several SQL aggregates that could drift
// apart from each other or from the control chart's own points.
//
// Standards applied, all named on the page itself so no threshold is a
// hidden assumption: IS 456 Cl 16.1 acceptance (individual >= f'ck - 4;
// mean of 4 consecutive >= f'ck + 0.825*sigma or f'ck + 4, whichever is
// greater), IS 456 Cl 16.3 (sigma "established" only at >= 30 results),
// IS 10262 assumed sigma, IS 516 (a cube > 15% from its batch average makes
// the test questionable; Cone / Cone & split are satisfactory), and IS 456
// Cl 15.2.2 sampling frequency by volume.

const IND_ALLOWANCE = 4;      // IS 456 Cl 16.1: individual >= f'ck - 4
const SIGMA_FACTOR = 0.825;   // ...mean of 4 >= f'ck + 0.825 sigma
const MEAN4_FLOOR = 4;        // ...or f'ck + 4, whichever is greater
const SPREAD_LIMIT = 15;      // IS 516 within-batch limit, %
const ESTABLISHED_N = 30;     // IS 456 Cl 16.3

function assumedSigma(fck) {
  const f = Number(fck);
  if (!Number.isFinite(f)) return null;
  if (f <= 15) return 3.5;
  if (f <= 25) return 4.0;
  return 5.0;
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function num(v, d = 1) {
  return v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(d);
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString([], { day: "2-digit", month: "short" }) : "—";
}
function daysAgoStr(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

// Per-grade statistics, computed once and reused by every panel.
function gradeStats(results) {
  const byGrade = new Map();
  for (const r of results) {
    const key = r.mix_grade_id;
    if (!byGrade.has(key)) {
      byGrade.set(key, {
        mix_grade_id: key, name: r.mix_grade_name, fck: Number(r.fck) || null,
        design_sigma: r.design_sigma == null ? null : Number(r.design_sigma),
        rows28: [], rows7: [], all: [],
      });
    }
    const g = byGrade.get(key);
    g.all.push(r);
    if (r.testing_age_days === 28) g.rows28.push(r);
    if (r.testing_age_days === 7) g.rows7.push(r);
    if (g.fck == null && r.fck != null) g.fck = Number(r.fck);
  }
  for (const g of byGrade.values()) {
    const v28 = g.rows28.map((r) => Number(r.strength)).filter(Number.isFinite);
    g.n = v28.length;
    g.mean = mean(v28);
    g.min = v28.length ? Math.min(...v28) : null;
    g.max = v28.length ? Math.max(...v28) : null;
    g.achievedSigma = stdev(v28);
    g.established = g.n >= ESTABLISHED_N;
    // The sigma the acceptance criterion actually uses: the plant's own only
    // once IS 456 calls it established, otherwise the design's (or the
    // IS 10262 assumption when no design is linked).
    g.assumed = g.design_sigma ?? assumedSigma(g.fck);
    g.sigmaUsed = g.established && g.achievedSigma != null ? g.achievedSigma : g.assumed;
    g.targetMean = g.fck != null && g.assumed != null ? g.fck + 1.65 * g.assumed : null;
    g.mean4Limit = g.fck != null && g.sigmaUsed != null
      ? Math.max(g.fck + SIGMA_FACTOR * g.sigmaUsed, g.fck + MEAN4_FLOOR) : null;
    g.indLimit = g.fck != null ? g.fck - IND_ALLOWANCE : null;
    g.cov = g.mean && g.achievedSigma != null ? (g.achievedSigma / g.mean) * 100 : null;
    g.belowFck = v28.filter((v) => g.fck != null && v < g.fck).length;
    g.belowIndLimit = v28.filter((v) => g.indLimit != null && v < g.indLimit).length;

    // The 7d/28d ratio from this grade's own paired results — the basis for
    // projecting a pour that only has its 7-day number so far. Pairs are
    // matched on the batch, so a 7-day from one pour is never divided into a
    // 28-day from another.
    const by28 = new Map(g.rows28.map((r) => [`${r.source}-${r.batch_id}`, Number(r.strength)]));
    const ratios = [];
    for (const r of g.rows7) {
      const s28 = by28.get(`${r.source}-${r.batch_id}`);
      const s7 = Number(r.strength);
      if (Number.isFinite(s28) && Number.isFinite(s7) && s28 > 0) ratios.push(s7 / s28);
    }
    g.ratioN = ratios.length;
    g.ratio = ratios.length >= 3 ? mean(ratios) : null; // below 3 pairs it is noise, not a ratio

    // Mean-of-4 (IS 456 Cl 16.1), in cast order — the sequence the standard
    // means by "consecutive", not the order results happened to be entered.
    const ordered = [...g.rows28].sort((a, b) =>
      String(a.cast_date || a.tested_at).localeCompare(String(b.cast_date || b.tested_at)));
    g.ordered = ordered;
    g.mean4 = ordered.map((r, i) => {
      if (i < 3) return null;
      return mean(ordered.slice(i - 3, i + 1).map((x) => Number(x.strength)));
    });
    g.mean4Failures = g.mean4.filter((m, i) => m != null && g.mean4Limit != null && m < g.mean4Limit).length;
  }
  return [...byGrade.values()].sort((a, b) => (a.fck || 0) - (b.fck || 0));
}

function Kpi({ label, value, unit, foot, tone }) {
  const color = tone === "danger" ? "var(--alert-red)" : tone === "warn" ? "var(--amber)" : undefined;
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={color ? { color } : undefined}>
        {value}{unit ? <span style={{ fontSize: 14, color: "var(--slate)", marginLeft: 4 }}>{unit}</span> : null}
      </div>
      {foot ? <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>{foot}</div> : null}
    </div>
  );
}

// ---- Control chart: 28-day results for one grade, with f'ck, target mean,
// the +-2 sigma band and the trailing mean-of-4 line.
function ControlChart({ g }) {
  const pts = g.ordered.filter((r) => Number.isFinite(Number(r.strength)));
  if (!pts.length) return <div style={{ color: "var(--slate)", fontSize: 13 }}>No 28-day results in this period.</div>;
  const W = 1040, H = 300, L = 46, R = 90, T = 16, B = 34;
  const pw = W - L - R, ph = H - T - B;
  const vals = pts.map((r) => Number(r.strength));
  const mu = mean(vals), sg = g.achievedSigma ?? 0;
  const lo = Math.min(g.indLimit ?? Infinity, ...vals, g.fck ?? Infinity) - 3;
  const hi = Math.max(g.targetMean ?? -Infinity, ...vals, (mu ?? 0) + 2 * sg) + 3;
  const ymin = Math.floor(lo / 5) * 5, ymax = Math.ceil(hi / 5) * 5;
  const y = (v) => T + ph - ((v - ymin) / (ymax - ymin || 1)) * ph;
  const x = (i) => L + ((i + 0.5) / pts.length) * pw;
  const labelEvery = Math.max(1, Math.ceil(pts.length / 9));
  const mean4Path = g.mean4
    .map((m, i) => (m == null ? null : `${x(i)},${y(m)}`))
    .filter(Boolean).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", overflow: "visible" }}
         role="img" aria-label={`28-day control chart for ${g.name}: ${pts.length} results, mean ${num(mu)} N/mm2`}>
      {mu != null && sg > 0 && (
        <rect x={L} y={y(mu + 2 * sg)} width={pw} height={Math.max(0, y(mu - 2 * sg) - y(mu + 2 * sg))}
              fill="var(--info-bg)" />
      )}
      {Array.from({ length: Math.floor((ymax - ymin) / 5) + 1 }, (_, k) => ymin + k * 5).map((v) => (
        <g key={v}>
          <line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--slate)">{v}</text>
        </g>
      ))}
      {g.fck != null && (
        <>
          <line x1={L} x2={L + pw} y1={y(g.fck)} y2={y(g.fck)} stroke="var(--alert-red)" strokeWidth="1.5" strokeDasharray="6 4" />
          <text x={L + pw + 6} y={y(g.fck) + 4} fontSize="11.5" fill="var(--alert-red)" fontWeight="700">{`f'ck ${num(g.fck, 0)}`}</text>
        </>
      )}
      {g.targetMean != null && (
        <>
          <line x1={L} x2={L + pw} y1={y(g.targetMean)} y2={y(g.targetMean)} stroke="var(--signal-green)" strokeWidth="1.5" strokeDasharray="6 4" />
          <text x={L + pw + 6} y={y(g.targetMean) + 4} fontSize="11.5" fill="var(--signal-green)" fontWeight="700">target {num(g.targetMean)}</text>
        </>
      )}
      {g.mean4Limit != null && (
        <>
          <line x1={L} x2={L + pw} y1={y(g.mean4Limit)} y2={y(g.mean4Limit)} stroke="var(--amber)" strokeWidth="1" strokeDasharray="3 3" />
          <text x={L + pw + 6} y={y(g.mean4Limit) + 4} fontSize="11" fill="var(--amber)">mean-of-4 {num(g.mean4Limit)}</text>
        </>
      )}
      {mean4Path && <polyline points={mean4Path} fill="none" stroke="var(--info)" strokeWidth="2" strokeLinejoin="round" />}
      {pts.map((r, i) => {
        const v = Number(r.strength);
        const fail = g.indLimit != null && v < g.indLimit;
        const below = !fail && g.fck != null && v < g.fck;
        return (
          <g key={`${r.source}-${r.result_id}`}>
            <circle cx={x(i)} cy={y(v)} r="5"
                    fill={fail ? "var(--alert-red)" : below ? "var(--amber)" : "var(--info)"}
                    stroke="var(--surface)" strokeWidth="2" />
            <title>{`${r.customer_name} · ${r.site_name}\n${r.design_ref_code || "no design linked"} · cast ${fmtDate(r.cast_date)}\n28-day ${num(v)} N/mm2 (f'ck ${g.fck != null ? (v - g.fck >= 0 ? "+" : "") + num(v - g.fck) : "—"})`}</title>
          </g>
        );
      })}
      {pts.map((r, i) => (i % labelEvery === 0 ? (
        <text key={`lbl-${i}`} x={x(i)} y={H - 10} textAnchor="middle" fontSize="10.5" fill="var(--slate)">
          {fmtDate(r.cast_date || r.tested_at)}
        </text>
      ) : null))}
      <line x1={L} x2={L + pw} y1={T + ph} y2={T + ph} stroke="var(--border-strong)" />
      <text x={2} y={10} textAnchor="start" fontSize="10.5" fill="var(--slate)">N/mm²</text>
    </svg>
  );
}

// ---- 7-day vs 28-day scatter. Tested pairs sit on their real 28-day value;
// a 7-day-only pour sits on its projection, so the two can be compared by
// eye against the same axis.
function RatioScatter({ results, grades, atRisk }) {
  const paired = [];
  for (const g of grades) {
    const by28 = new Map(g.rows28.map((r) => [`${r.source}-${r.batch_id}`, Number(r.strength)]));
    for (const r of g.rows7) {
      const s28 = by28.get(`${r.source}-${r.batch_id}`);
      if (Number.isFinite(s28)) paired.push({ x: Number(r.strength), y: s28, grade: g.name, done: true });
    }
  }
  const projected = atRisk.filter((r) => r.projected != null)
    .map((r) => ({ x: Number(r.strength_7), y: r.projected, grade: r.mix_grade_name, done: false }));
  const all = [...paired, ...projected].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!all.length) return <div style={{ color: "var(--slate)", fontSize: 13 }}>No 7-day results in this period.</div>;
  const W = 620, H = 300, L = 44, R = 14, T = 14, B = 34, pw = W - L - R, ph = H - T - B;
  const xmax = Math.ceil(Math.max(...all.map((p) => p.x)) / 5) * 5 + 5;
  const ymax = Math.ceil(Math.max(...all.map((p) => p.y)) / 10) * 10 + 5;
  const x = (v) => L + (v / xmax) * pw, y = (v) => T + ph - (v / ymax) * ph;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img"
         aria-label="Scatter of 7-day against 28-day strength, with projections for pours not yet tested at 28 days">
      {Array.from({ length: 6 }, (_, k) => Math.round((ymax / 5) * k)).map((v) => (
        <g key={v}>
          <line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} stroke="var(--border)" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--slate)">{v}</text>
        </g>
      ))}
      {Array.from({ length: 6 }, (_, k) => Math.round((xmax / 5) * k)).map((v) => (
        <text key={`x${v}`} x={x(v)} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--slate)">{v}</text>
      ))}
      {all.map((p, i) => (
        <circle key={i} cx={x(p.x)} cy={y(p.y)} r={p.done ? 4 : 5.5}
                fill={p.done ? "var(--info)" : "var(--rebar)"} opacity={p.done ? 0.75 : 1}
                stroke="var(--surface)" strokeWidth="1.5">
          <title>{`${p.grade} · 7-day ${num(p.x)} → ${p.done ? "28-day " : "projected "}${num(p.y)} N/mm²`}</title>
        </circle>
      ))}
      <line x1={L} x2={L + pw} y1={T + ph} y2={T + ph} stroke="var(--border-strong)" />
      <text x={L + 6} y={T + 10} fontSize="11" fill="var(--slate)">28-day N/mm²</text>
      <text x={L + pw} y={H - 24} textAnchor="end" fontSize="11" fill="var(--slate)">7-day N/mm² →</text>
    </svg>
  );
}

function HBar({ label, value, total, color, suffix }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(74px, 132px) 1fr 46px", alignItems: "center", gap: 10, fontSize: 12.5, padding: "3px 0" }}>
      <span>{label}</span>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${pct}%`, background: color }} /></div>
      <span style={{ textAlign: "right", color: "var(--slate)" }}>{value}{suffix || ""}</span>
    </div>
  );
}

export default function CubeQcDashboard() {
  const [filters, setFilters] = useState({ grades: [], customers: [], mix_designs: [], technicians: [] });
  const [q, setQ] = useState({ from_date: daysAgoStr(90), to_date: todayStr(), mix_grade_id: "", customer_id: "", mix_design_id: "", source: "", tested_by: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeGrade, setActiveGrade] = useState(null);

  useEffect(() => {
    apiRequest("/qc-dashboard/filters").then(setFilters).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    apiRequest(`/qc-dashboard/summary${qs ? `?${qs}` : ""}`)
      .then((d) => { setData(d); setError(""); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [q]);

  const grades = useMemo(() => (data ? gradeStats(data.results) : []), [data]);
  const grade = useMemo(
    () => grades.find((g) => g.mix_grade_id === activeGrade) || grades.find((g) => g.n > 0) || grades[0] || null,
    [grades, activeGrade]
  );

  // Projections for the pours that only have a 7-day result so far, using
  // each grade's own ratio. A grade with too few paired results has no
  // ratio, so its pours are listed without a projection rather than being
  // projected on a borrowed number.
  const atRisk = useMemo(() => {
    if (!data) return [];
    const ratioByGrade = new Map(grades.map((g) => [g.mix_grade_id, g]));
    return data.pending_28day.map((r) => {
      const g = ratioByGrade.get(r.mix_grade_id);
      const s7 = Number(r.strength_7);
      const projected = g && g.ratio ? s7 / g.ratio : null;
      const fck = Number(r.fck);
      const due = r.cast_date ? new Date(new Date(r.cast_date).getTime() + 28 * 86400000) : null;
      return {
        ...r, projected,
        shortfall: projected != null && Number.isFinite(fck) ? projected - (fck + 2) : null,
        due_28: due,
        ratio_n: g ? g.ratioN : 0,
      };
    }).sort((a, b) => (a.shortfall ?? 99) - (b.shortfall ?? 99));
  }, [data, grades]);

  const kpis = useMemo(() => {
    if (!data) return null;
    const r28 = data.results.filter((r) => r.testing_age_days === 28 && Number.isFinite(Number(r.strength)));
    const pass = r28.filter((r) => Number(r.strength) >= Number(r.fck)).length;
    const margins = r28.filter((r) => Number.isFinite(Number(r.fck))).map((r) => Number(r.strength) - Number(r.fck));
    const spreadBad = (data.spread_buckets.find((b) => b.bucket === "gt15") || {}).n || 0;
    const site = data.results.filter((r) => r.source === "site").length;
    return {
      n28: r28.length, pass, passPct: r28.length ? (pass / r28.length) * 100 : null,
      meanMargin: mean(margins), spreadBad, site, total: data.results.length,
      atRisk: atRisk.filter((r) => r.shortfall != null && r.shortfall < 0).length,
    };
  }, [data, atRisk]);

  const totalSpread = (data?.spread_buckets || []).reduce((s, b) => s + b.n, 0);
  const failTotal = (data?.failure_types || []).reduce((s, f) => s + f.n, 0);
  const satisfactory = (data?.failure_types || [])
    .filter((f) => ["cone", "cone & split", "cone and split"].includes(String(f.failure_type).toLowerCase()))
    .reduce((s, f) => s + f.n, 0);

  return (
    <>
      <TopBar title="Cube Strength QC" />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 16px 40px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

        <div className="card" style={{ marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field-input" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ fontSize: 12, color: "var(--slate)" }}>From<br />
              <input type="date" value={q.from_date} onChange={(e) => setQ({ ...q, from_date: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: "var(--slate)" }}>To<br />
              <input type="date" value={q.to_date} onChange={(e) => setQ({ ...q, to_date: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: "var(--slate)" }}>Grade<br />
              <select value={q.mix_grade_id} onChange={(e) => setQ({ ...q, mix_grade_id: e.target.value })}>
                <option value="">All grades</option>
                {filters.grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12, color: "var(--slate)" }}>Customer<br />
              <select value={q.customer_id} onChange={(e) => setQ({ ...q, customer_id: e.target.value })}>
                <option value="">All customers</option>
                {filters.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12, color: "var(--slate)" }}>Mix design<br />
              <select value={q.mix_design_id} onChange={(e) => setQ({ ...q, mix_design_id: e.target.value })}>
                <option value="">All designs</option>
                {filters.mix_designs.map((d) => <option key={d.id} value={d.id}>{d.design_ref_code} ({d.mix_grade_name})</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12, color: "var(--slate)" }}>Cast at<br />
              <select value={q.source} onChange={(e) => setQ({ ...q, source: e.target.value })}>
                <option value="">Plant + site</option>
                <option value="plant">Plant only</option>
                <option value="site">Site only</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: "var(--slate)" }}>Tested by<br />
              <select value={q.tested_by} onChange={(e) => setQ({ ...q, tested_by: e.target.value })}>
                <option value="">Anyone</option>
                {filters.technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>
          <button onClick={() => setQ({ from_date: daysAgoStr(90), to_date: todayStr(), mix_grade_id: "", customer_id: "", mix_design_id: "", source: "", tested_by: "" })}>
            Last 90 days
          </button>
        </div>

        {loading && <div style={{ color: "var(--slate)", fontSize: 13 }}>Loading…</div>}

        {data && kpis && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 10, marginBottom: 14 }}>
              <Kpi label="28-day meeting f'ck" value={kpis.passPct == null ? "—" : num(kpis.passPct)} unit="%"
                   tone={kpis.passPct != null && kpis.passPct < 100 ? "warn" : undefined}
                   foot={`${kpis.n28 - kpis.pass} below f'ck of ${kpis.n28} tests`} />
              <Kpi label="Mean margin over f'ck" value={kpis.meanMargin == null ? "—" : `+${num(kpis.meanMargin)}`} unit="N/mm²"
                   foot="28-day results in range" />
              <Kpi label={`σ achieved · ${grade ? grade.name : "—"}`} value={grade && grade.achievedSigma != null ? num(grade.achievedSigma, 2) : "—"} unit="N/mm²"
                   foot={grade ? `${grade.established ? "established" : "provisional"} · n=${grade.n} · assumed ${num(grade.assumed, 1)}` : ""} />
              <Kpi label="28-day due this week" value={data.lab_workload.due_this_week_28 ?? 0}
                   foot={`${data.lab_workload.overdue_28 ?? 0} overdue`}
                   tone={(data.lab_workload.overdue_28 ?? 0) > 0 ? "warn" : undefined} />
              <Kpi label="Projected at risk" value={kpis.atRisk} tone={kpis.atRisk > 0 ? "danger" : undefined}
                   foot="from 7-day results, not yet crushed" />
              <Kpi label={`Cube spread > ${SPREAD_LIMIT}%`} value={kpis.spreadBad} tone={kpis.spreadBad > 0 ? "warn" : undefined}
                   foot="IS 516 — lab practice" />
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                <div>
                  <h2 style={{ fontSize: 16 }}>28-day strength control chart</h2>
                  <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 2 }}>
                    Is the plant producing consistently above the characteristic strength, and is anything drifting before it fails?
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {grades.map((g) => (
                    <button key={g.mix_grade_id} className={`btn-tab ${grade && g.mix_grade_id === grade.mix_grade_id ? "active" : ""}`}
                            onClick={() => setActiveGrade(g.mix_grade_id)}>
                      {g.name} · n={g.n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="legend">
                <span className="legend-item"><i className="legend-swatch" style={{ background: "var(--info)" }} />28-day result</span>
                <span className="legend-item"><i className="legend-swatch" style={{ background: "var(--amber)" }} />below f'ck</span>
                <span className="legend-item"><i className="legend-swatch" style={{ background: "var(--alert-red)" }} />below f'ck − {IND_ALLOWANCE} (individual failure)</span>
                <span className="legend-item">— mean of last 4 · – – f'ck · – – target mean · – – mean-of-4 limit</span>
              </div>
              {grade ? <ControlChart g={grade} /> : null}
              {grade && (
                <div className="open-q" style={{ marginTop: 10 }}>
                  <b>{grade.name}:</b> mean {num(grade.mean)} N/mm², σ {grade.achievedSigma == null ? "—" : num(grade.achievedSigma, 2)}{" "}
                  ({grade.established ? "established, ≥30 results" : `provisional, n=${grade.n} — acceptance uses the assumed σ ${num(grade.assumed, 1)}`}),
                  target mean {num(grade.targetMean)}. IS 456 Cl 16.1: {grade.belowIndLimit} individual result(s) below f'ck − {IND_ALLOWANCE},{" "}
                  {grade.mean4Failures} four-result group(s) below {num(grade.mean4Limit)}.
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 14 }}>
              <div className="card">
                <h2 style={{ fontSize: 16 }}>Early warning from 7-day results</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>
                  Which pours are projected to miss f'ck at 28 days, three weeks before the cubes are crushed?
                </div>
                <div className="legend">
                  <span className="legend-item"><i className="legend-swatch" style={{ background: "var(--info)" }} />both ages tested</span>
                  <span className="legend-item"><i className="legend-swatch" style={{ background: "var(--rebar)" }} />7-day only, projected</span>
                </div>
                <RatioScatter results={data.results} grades={grades} atRisk={atRisk} />
              </div>
              <div className="card">
                <h2 style={{ fontSize: 16 }}>Projected at-risk pours</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>Sorted by projected shortfall against f'ck + 2</div>
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead><tr><th>Customer</th><th>Grade</th><th style={{ textAlign: "right" }}>7-day</th><th style={{ textAlign: "right" }}>Proj. 28-day</th><th>28-day due</th><th></th></tr></thead>
                    <tbody>
                      {atRisk.slice(0, 8).map((r) => {
                        const tone = r.shortfall == null ? "badge-neutral" : r.shortfall < 0 ? "badge-danger" : r.shortfall < 3 ? "badge-warning" : "badge-success";
                        const label = r.shortfall == null ? "no ratio yet" : r.shortfall < 0 ? "at risk" : r.shortfall < 3 ? "watch" : "ok";
                        return (
                          <tr key={`${r.source}-${r.result_id}`}>
                            <td>{r.customer_name}<div style={{ fontSize: 11, color: "var(--slate)" }}>{r.site_name}</div></td>
                            <td>{r.mix_grade_name}</td>
                            <td style={{ textAlign: "right" }}>{num(r.strength_7)}</td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{r.projected == null ? "—" : num(r.projected)}</td>
                            <td>{r.due_28 ? fmtDate(r.due_28) : "—"}</td>
                            <td><span className={`badge ${tone}`}>{label}</span></td>
                          </tr>
                        );
                      })}
                      {!atRisk.length && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No pours waiting on a 28-day test.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
                  Projection = 7-day result ÷ that grade's own historical 7-day/28-day ratio, from paired results in this period.
                  A grade with fewer than 3 pairs shows no projection rather than borrowing another grade's ratio.
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 14 }}>
              <div className="card">
                <h2 style={{ fontSize: 16 }}>Margin over f'ck by grade</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>
                  Are we over-designing, or running too close?
                </div>
                <div style={{ overflowX: "auto" }}>
                <table>
                  <thead><tr><th>Grade</th><th style={{ textAlign: "right" }}>n</th><th style={{ textAlign: "right" }}>Mean</th><th style={{ textAlign: "right" }}>Min–max</th><th style={{ textAlign: "right" }}>f'ck</th><th style={{ textAlign: "right" }}>Target</th><th style={{ textAlign: "right" }}>σ</th><th style={{ textAlign: "right" }}>CoV</th><th>vs target</th></tr></thead>
                  <tbody>
                    {grades.filter((g) => g.n > 0).map((g) => (
                      <tr key={g.mix_grade_id}>
                        <td><b>{g.name}</b></td>
                        <td style={{ textAlign: "right" }}>{g.n}</td>
                        <td style={{ textAlign: "right" }}>{num(g.mean)}</td>
                        <td style={{ textAlign: "right" }}>{num(g.min)}–{num(g.max)}</td>
                        <td style={{ textAlign: "right" }}>{num(g.fck, 0)}</td>
                        <td style={{ textAlign: "right" }}>{num(g.targetMean)}</td>
                        <td style={{ textAlign: "right" }}>{g.achievedSigma == null ? "—" : num(g.achievedSigma, 2)}</td>
                        <td style={{ textAlign: "right" }}>{g.cov == null ? "—" : `${num(g.cov)}%`}</td>
                        <td>
                          {g.mean != null && g.targetMean != null
                            ? <span className={`badge ${g.mean >= g.targetMean ? "badge-success" : "badge-warning"}`}>
                                {g.mean - g.targetMean >= 0 ? "+" : ""}{num(g.mean - g.targetMean)}
                              </span>
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
                  Target mean = f'ck + 1.65σ (IS 10262), using the linked design's own σ where there is one.
                  A mean well above target with a small σ means the mix can be leaned; a mean near target with a large σ means fix consistency first, not cement.
                </div>
              </div>

              <div className="card">
                <h2 style={{ fontSize: 16 }}>Mix design performance</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>
                  Is each design doing what its sheet promised? Where two serve one grade, this is the cement-content comparison.
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead><tr><th>Design</th><th>Grade</th><th style={{ textAlign: "right" }}>n</th><th style={{ textAlign: "right" }}>Mean</th><th style={{ textAlign: "right" }}>σ</th><th style={{ textAlign: "right" }}>CoV</th><th style={{ textAlign: "right" }}>vs target</th><th>σ vs design</th></tr></thead>
                    <tbody>
                      {data.mix_designs.map((d) => {
                        const m = Number(d.mean_28), sg = d.sigma_28 == null ? null : Number(d.sigma_28);
                        const tgt = d.design_target_mean == null ? null : Number(d.design_target_mean);
                        const ds = d.design_sigma == null ? null : Number(d.design_sigma);
                        return (
                          <tr key={d.mix_design_id}>
                            <td><b>{d.design_ref_code}</b></td>
                            <td>{d.mix_grade_name}</td>
                            <td style={{ textAlign: "right" }}>{d.n}</td>
                            <td style={{ textAlign: "right" }}>{num(m)}</td>
                            <td style={{ textAlign: "right" }}>{sg == null ? "—" : num(sg, 2)}</td>
                            <td style={{ textAlign: "right" }}>{sg == null || !m ? "—" : `${num((sg / m) * 100)}%`}</td>
                            <td style={{ textAlign: "right" }}>{tgt == null ? "—" : `${m - tgt >= 0 ? "+" : ""}${num(m - tgt)}`}</td>
                            <td>{sg == null || ds == null ? "—" :
                              <span className={`badge ${sg <= ds ? "badge-success" : "badge-warning"}`}>
                                {sg <= ds ? `within ${num(ds, 1)}` : `above ${num(ds, 1)}`}
                              </span>}</td>
                          </tr>
                        );
                      })}
                      {!data.mix_designs.length && <tr><td colSpan={8} style={{ color: "var(--slate)" }}>No results are linked to a mix design in this period.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(236px, 1fr))", gap: 14, marginBottom: 14 }}>
              <div className="card">
                <h2 style={{ fontSize: 16 }}>Within-batch consistency</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>
                  Cube-to-cube spread inside each test (IS 516: within ±{SPREAD_LIMIT}% of the batch average)
                </div>
                <HBar label="≤ 5%" value={(data.spread_buckets.find((b) => b.bucket === "le5") || {}).n || 0} total={totalSpread} color="var(--signal-green)" />
                <HBar label="5–10%" value={(data.spread_buckets.find((b) => b.bucket === "le10") || {}).n || 0} total={totalSpread} color="var(--info)" />
                <HBar label="10–15%" value={(data.spread_buckets.find((b) => b.bucket === "le15") || {}).n || 0} total={totalSpread} color="var(--amber)" />
                <HBar label={`> ${SPREAD_LIMIT}%`} value={(data.spread_buckets.find((b) => b.bucket === "gt15") || {}).n || 0} total={totalSpread} color="var(--alert-red)" />
                <HBar label="No cube detail" value={(data.spread_buckets.find((b) => b.bucket === "unknown") || {}).n || 0} total={totalSpread} color="var(--border-strong)" />
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
                  Wide spread with a normal average points at the lab — capping, curing tank, alignment on the machine — rather than the concrete.
                  Only cubes actually crushed are counted.
                </div>
              </div>

              <div className="card">
                <h2 style={{ fontSize: 16 }}>Failure mode</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>IS 516 satisfactory vs unsatisfactory fracture patterns</div>
                {data.failure_types.map((f) => {
                  const ok = ["cone", "cone & split", "cone and split"].includes(String(f.failure_type).toLowerCase());
                  const none = f.failure_type === "Not recorded";
                  return <HBar key={f.failure_type} label={f.failure_type} value={f.n} total={failTotal}
                               color={none ? "var(--border-strong)" : ok ? "var(--info)" : "var(--amber)"} />;
                })}
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
                  Satisfactory (cone / cone &amp; split): <b>{failTotal ? Math.round((satisfactory / failTotal) * 100) : 0}%</b>.
                  Shear or columnar failures clustering by technician or machine point at platen alignment and cube seating.
                </div>
              </div>

              <div className="card">
                <h2 style={{ fontSize: 16 }}>Density check</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>Hardened density {data.standards.density_min}–{data.standards.density_max} kg/m³ expected</div>
                <div className="stat" style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                  <span style={{ color: "var(--slate)" }}>Average density</span><b>{data.density.avg_density ? `${Number(data.density.avg_density).toLocaleString()} kg/m³` : "—"}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                  <span style={{ color: "var(--slate)" }}>Outside range</span>
                  <b style={{ color: (data.density.outside || 0) > 0 ? "var(--alert-red)" : undefined }}>
                    {data.density.outside || 0} of {data.density.with_density || 0}
                  </b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}>
                  <span style={{ color: "var(--slate)" }}>Of those, below f'ck</span><b>{data.density.outside_and_failed || 0}</b>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
                  Low density with low strength means poor compaction or high air; low density with normal strength usually means a light aggregate lot.
                  A density outlier flags the cube before strength does.
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 14 }}>
              <div className="card">
                <h2 style={{ fontSize: 16 }}>By customer &amp; site</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>Where is the exposure — thinnest margins first</div>
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead><tr><th>Customer · site</th><th>Grades</th><th style={{ textAlign: "right" }}>Tests</th><th style={{ textAlign: "right" }}>28-day pass</th><th style={{ textAlign: "right" }}>Min margin</th></tr></thead>
                    <tbody>
                      {data.customers.slice(0, 12).map((c) => {
                        const pct = c.tests_28 ? (c.pass_28 / c.tests_28) * 100 : null;
                        const margin = c.min_margin == null ? null : Number(c.min_margin);
                        return (
                          <tr key={`${c.customer_id}-${c.site_id}`}>
                            <td><b>{c.customer_name}</b><div style={{ fontSize: 11, color: "var(--slate)" }}>{c.site_name}</div></td>
                            <td>{c.grades}</td>
                            <td style={{ textAlign: "right" }}>{c.tests}</td>
                            <td style={{ textAlign: "right" }}>{pct == null ? "—" : `${Math.round(pct)}% (${c.pass_28}/${c.tests_28})`}</td>
                            <td style={{ textAlign: "right" }}>
                              {margin == null ? "—" :
                                <span className={`badge ${margin < 0 ? "badge-danger" : margin < 4 ? "badge-warning" : "badge-success"}`}>
                                  {margin >= 0 ? "+" : ""}{num(margin)}
                                </span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <h2 style={{ fontSize: 16 }}>Lab workload</h2>
                <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>Same counts the Lab Technician's Samples Due page works from</div>
                {[
                  ["7-day tests due today", data.lab_workload.due_today_7, "badge-info"],
                  ["28-day tests due today", data.lab_workload.due_today_28, "badge-info"],
                  ["28-day due within 7 days", data.lab_workload.due_this_week_28, "badge-neutral"],
                  ["Overdue 7-day", data.lab_workload.overdue_7, (data.lab_workload.overdue_7 || 0) > 0 ? "badge-warning" : "badge-success"],
                  ["Overdue 28-day", data.lab_workload.overdue_28, (data.lab_workload.overdue_28 || 0) > 0 ? "badge-danger" : "badge-success"],
                  ["Cast but never tested (past 28 days, not closed)", data.lab_workload.never_tested, (data.lab_workload.never_tested || 0) > 0 ? "badge-warning" : "badge-success"],
                ].map(([label, value, cls]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                    <span style={{ color: "var(--slate)" }}>{label}</span>
                    <span className={`badge ${cls}`}>{value ?? 0}</span>
                  </div>
                ))}
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
                  Counts cover every cast batch, not only the filtered period — an overdue test from two months ago still matters today.
                </div>
              </div>
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16 }}>Samples per week vs IS 456 minimum</h2>
              <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "2px 0 8px" }}>
                Is sampling keeping up with production? Required count is computed per day from that day's poured volume (Cl 15.2.2) and summed into the week — a good pass rate built on too few samples is not evidence of control.
              </div>
              <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Week beginning</th><th style={{ textAlign: "right" }}>Volume poured</th><th style={{ textAlign: "right" }}>Plant samples</th><th style={{ textAlign: "right" }}>Site samples</th><th style={{ textAlign: "right" }}>Required</th><th>Status</th></tr></thead>
                <tbody>
                  {data.weekly.map((w) => {
                    const taken = (w.plant_samples || 0) + (w.site_samples || 0);
                    const short = taken < w.required_samples;
                    return (
                      <tr key={w.week_start}>
                        <td>{fmtDate(w.week_start)}</td>
                        <td style={{ textAlign: "right" }}>{w.volume_m3 ? `${Number(w.volume_m3).toFixed(1)} m³` : "—"}</td>
                        <td style={{ textAlign: "right" }}>{w.plant_samples}</td>
                        <td style={{ textAlign: "right" }}>{w.site_samples}</td>
                        <td style={{ textAlign: "right" }}>{w.required_samples}</td>
                        <td><span className={`badge ${short ? "badge-warning" : "badge-success"}`}>{short ? `${w.required_samples - taken} short` : "met"}</span></td>
                      </tr>
                    );
                  })}
                  {!data.weekly.length && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No samples in this period.</td></tr>}
                </tbody>
              </table>
              </div>
            </div>

            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 12, lineHeight: 1.6 }}>
              {kpis.total} results in range ({kpis.total - kpis.site} plant-cast, {kpis.site} site-cast).
              Acceptance follows IS 456:2000 Cl 16.1; σ is called established only at {ESTABLISHED_N} results or more (Cl 16.3), and the assumed σ from the
              linked mix design (or IS 10262 where none is linked) is used until then. Where a result has no mix design linked, the grade number itself is
              used as f'ck.
            </div>
          </>
        )}
      </div>
    </>
  );
}
