// Round 199 — shared pieces for the Fuel module's screens: formatting, the
// tank drawing, tank status, the consumption status bands and small charts.
// Colours are the app's own tokens from index.css.

export const IST = "Asia/Kolkata";

export function fmtNum(v, digits = 0) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtL(v, digits = 0) {
  return v == null ? "—" : `${fmtNum(v, digits)} L`;
}
export function fmtRs(v, digits = 0) {
  return v == null ? "—" : `₹${fmtNum(v, digits)}`;
}
export function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function fmtDate(ts) {
  if (!ts) return "—";
  const d = typeof ts === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ts) ? new Date(`${ts}T00:00:00+05:30`) : new Date(ts);
  return d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short" });
}
export function fmtMonth(ym) {
  if (!ym) return "—";
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" });
}
export function pctChange(now, before) {
  if (now == null || before == null || Number(before) === 0) return null;
  return ((Number(now) - Number(before)) / Number(before)) * 100;
}

// ----- Tank status -----
// Below reorder = red. Approaching = reorder reached within the early-warning
// days at the 7-day average (or, with no recent issues, within 60% above the
// reorder level). Anything else is healthy.
export function tankStatus(tank, settings) {
  const cur = Number(tank?.current_qty ?? 0);
  const reorder = settings?.reorder_level_l;
  if (reorder == null) return { key: "unknown", label: "Reorder level not set", bg: "#ECEAE4", ink: "var(--slate)" };
  if (cur <= reorder) return { key: "critical", label: "Below reorder level", bg: "var(--alert-red-bg)", ink: "var(--alert-red)" };
  const days = tank?.days_to_reorder;
  const warn = settings?.warning_days ?? 4;
  const low = days != null ? days <= warn : cur <= reorder * 1.6;
  if (low) return { key: "low", label: "Approaching reorder", bg: "var(--amber-bg)", ink: "var(--amber)" };
  return { key: "ok", label: "Healthy", bg: "var(--signal-green-bg)", ink: "var(--signal-green)" };
}

const LIQUID = {
  critical: ["#C24A3C", "#8E2F25", "#D9776B"],
  low: ["#D9A13A", "#A8771C", "#EBC377"],
  ok: ["#3A9A72", "#1D7A55", "#7CC2A2"],
  unknown: ["#8E97A2", "#5B6470", "#B9C0C8"],
};

// The tank: a vertical cylinder filled to the current level, with the reorder
// level as a dashed red line and a litre scale at the side. With no capacity
// set (an Administrator sets it in Settings) there is nothing to draw the
// level against, so the tank is drawn empty and says so.
export function TankGraphic({ current, capacity, reorder, statusKey = "ok", width = 270, compact = false }) {
  const [liq, dark, top] = LIQUID[statusKey] || LIQUID.ok;
  const cap = capacity && capacity > 0 ? Number(capacity) : null;
  const pct = cap ? Math.max(0, Math.min(1, Number(current || 0) / cap)) : 0;
  const fillY = 290 - 260 * pct;
  const reorderY = cap && reorder != null ? 290 - 260 * Math.min(1, reorder / cap) : null;
  const ticks = cap ? [0, 0.25, 0.5, 0.75, 1] : [];
  const tickLabel = (f) => {
    const v = cap * f;
    return v >= 1000 ? `${fmtNum(v / 1000, v % 1000 ? 1 : 0)}k` : fmtNum(v);
  };
  const uid = `t${Math.round(width)}${compact ? "c" : ""}`;
  return (
    <svg width={width} height={(width * 336) / 300} viewBox="0 0 300 336" role="img"
      aria-label={cap ? `Diesel tank, ${fmtNum(current)} litres of ${fmtNum(cap)}` : `Diesel tank, ${fmtNum(current)} litres; capacity not set`}
      style={{ flex: "none", display: "block" }}>
      <defs>
        <clipPath id={`${uid}body`}><path d="M80 30 v260 a80 16 0 0 0 160 0 v-260 a80 16 0 0 0 -160 0z" /></clipPath>
        <linearGradient id={`${uid}shell`} x1="0" x2="1">
          <stop offset="0" stopColor="#D5D0C5" /><stop offset="0.35" stopColor="#F4F2ED" /><stop offset="1" stopColor="#BEB7AA" />
        </linearGradient>
        <linearGradient id={`${uid}liq`} x1="0" x2="1">
          <stop offset="0" stopColor={dark} /><stop offset="0.35" stopColor={liq} /><stop offset="1" stopColor={dark} />
        </linearGradient>
      </defs>
      <rect x="148" y="2" width="24" height="16" rx="3" fill="#8A8478" />
      <path d="M80 30 v260 a80 16 0 0 0 160 0 v-260" fill={`url(#${uid}shell)`} stroke="#8A8478" strokeWidth="2" />
      {cap && pct > 0 && (
        <g clipPath={`url(#${uid}body)`}>
          <rect x="80" y={fillY} width="160" height="330" fill={`url(#${uid}liq)`} />
          <ellipse cx="160" cy={fillY} rx="80" ry="16" fill={top} />
          <rect x="100" y="30" width="12" height="276" fill="#fff" opacity="0.18" />
        </g>
      )}
      <ellipse cx="160" cy="30" rx="80" ry="16" fill="#E9E5DC" stroke="#8A8478" strokeWidth="2" />
      {reorderY != null && (
        <>
          <line x1="78" y1={reorderY} x2="242" y2={reorderY} stroke="#B03A2E" strokeWidth="2.5" strokeDasharray="6 4" />
          {!compact && <text x="72" y={reorderY - 3} textAnchor="end" fontSize="11" fontWeight="700" fill="#B03A2E">Reorder</text>}
          {!compact && <text x="72" y={reorderY + 11} textAnchor="end" fontSize="10.5" fill="#B03A2E">{fmtL(reorder)}</text>}
        </>
      )}
      {!compact && ticks.map((f) => (
        <g key={f} fontSize="10.5" fill="#5B6470">
          <line x1="246" y1={290 - 260 * f} x2="254" y2={290 - 260 * f} stroke="#8A8478" />
          <text x="258" y={294 - 260 * f}>{tickLabel(f)}</text>
        </g>
      ))}
      {cap ? (
        <text x="160" y={Math.min(270, Math.max(70, fillY + 34))} textAnchor="middle" fontSize={compact ? 34 : 26} fontWeight="800"
          fill="#22262B" stroke="#fff" strokeWidth="4" paintOrder="stroke">{Math.round(pct * 100)}%</text>
      ) : (
        <text x="160" y="165" textAnchor="middle" fontSize="15" fontWeight="700" fill="#5B6470">Capacity not set</text>
      )}
      <rect x="60" y="318" width="200" height="8" rx="2" fill="#8A8478" />
    </svg>
  );
}

// ----- Consumption status bands -----
// Same rule FuelAnalysis.jsx has always used (12% / 3% / 10%), now read from
// the Fuel settings so an Administrator can tune it.
export const DEFAULT_BANDS = { high: 0.12, above: 0.03, efficient: 0.1 };
export function bandsFromSettings(s) {
  if (!s) return DEFAULT_BANDS;
  return {
    high: Number(s.band_high_pct ?? 12) / 100,
    above: Number(s.band_above_pct ?? 3) / 100,
    efficient: Number(s.band_efficient_pct ?? 10) / 100,
  };
}

export function Sparkline({ values, width = 90, height = 24, color = "var(--slate)", avg = null }) {
  const pts = (values || []).map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return <span style={{ fontSize: 11, color: "var(--slate)" }}>—</span>;
  const all = pts.map(([, v]) => Number(v)).concat(avg != null ? [Number(avg)] : []);
  const lo = Math.min(...all) * 0.95, hi = Math.max(...all) * 1.05 || 1;
  const n = values.length;
  const x = (i) => 3 + (i * (width - 6)) / Math.max(1, n - 1);
  const y = (v) => height - 3 - ((Number(v) - lo) / (hi - lo || 1)) * (height - 6);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {avg != null && <line x1="0" x2={width} y1={y(avg)} y2={y(avg)} stroke="var(--border-strong)" strokeDasharray="3 3" />}
      <polyline points={pts.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function Kpi({ label, value, sub, accent, children, valueStyle }) {
  return (
    <div className="kpi" style={accent ? { borderColor: "var(--rebar)" } : undefined}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ fontSize: 22, ...valueStyle }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>{sub}</div>}
      {children}
    </div>
  );
}

export const KIND = {
  issue: { label: "Plant issue", cls: "badge-info" },
  external: { label: "Outside fill", cls: "badge-neutral" },
  receipt: { label: "Delivery received", cls: "badge-success" },
  adjustment: { label: "Adjustment", cls: "badge-progress" },
};

export const CATEGORY_COLOURS = { truck: "#2A6F97", pump: "#C75B12", equipment: "#D9B26B" };
export const CATEGORY_LABELS = { truck: "Trucks", pump: "Pumps", equipment: "Plant equipment & DG" };

export async function exportXlsx(rows, sheet, file) {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  XLSX.writeFile(wb, file);
}
