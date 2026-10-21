// Round 218 — shared pieces for the Cost module (Cost dashboard, Profit &
// Loss, Balance Sheet). Colours and classes are the app's own (index.css).
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";

export const IST = "Asia/Kolkata";

export function currentMonth() {
  return new Date().toLocaleDateString("en-CA", { timeZone: IST }).slice(0, 7);
}
export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function monthName(ym, long = true) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-IN", { month: long ? "long" : "short", year: "numeric", timeZone: "UTC" });
}
// The months that can be picked: this one and the two years before it.
export function monthOptions() {
  const now = currentMonth();
  return Array.from({ length: 25 }, (_, i) => addMonths(now, -i));
}

// ₹ lakh, two decimals, Indian grouping.
export function lakh(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return (Number(v) / 100000).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function rsL(v, digits = 2) { return v == null ? "—" : `${Number(v) < 0 ? "−" : ""}₹${lakh(Math.abs(Number(v)), digits)} L`; }
export function num(v, digits = 0) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function rs(v) { return v == null ? "—" : `${Number(v) < 0 ? "−" : ""}₹${num(Math.abs(Number(v)))}`; }
export function pct(v, digits = 1) { return v == null ? "—" : `${num(v, digits)}%`; }
export function signed(v, digits = 1, suffix = "%") {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${num(Math.abs(n), digits)}${suffix}`;
}
export function fmtDay(ymd) {
  if (!ymd) return "—";
  return new Date(`${ymd}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: IST, day: "numeric", month: "short", year: "numeric" });
}

export const C = {
  rm: "#8FB3CC", fuel: "#E0A43A", mnt: "#C9A27A", man: "#A58BC4", left: "#1D7A55", soft: "#8FBFA6",
  grey: "#B5ADA0", slate2: "#7D8691", warn: "#E0A43A", bad: "#B03A2E",
};

export const H2 = { fontSize: 15, fontWeight: 700, margin: 0 };
export const SUB = { fontSize: 12, color: "var(--slate)", marginTop: 3 };
export const MUTED = { fontSize: 11.5, color: "var(--slate)" };
export const NUM = { fontVariantNumeric: "tabular-nums" };
export const R = { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
export const GRID = (min) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12 });
export const ROW = { display: "flex", flexWrap: "wrap", gap: 18 };
export const panel = (flex = "1 1 420px") => ({ flex, minWidth: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow)", padding: 16 });
const SELECT = { padding: "9px 10px", fontSize: 13, border: "1px solid var(--border-strong)", borderRadius: 7, background: "var(--surface)", color: "var(--charcoal)", minWidth: 150, minHeight: 40, fontFamily: "inherit" };
const LBL = { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 };

export function Select({ label, value, onChange, options }) {
  return (
    <label style={LBL}>{label}
      <select style={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
export function MonthSelect({ value, onChange, label = "Month" }) {
  return <Select label={label} value={value} onChange={onChange} options={monthOptions().map((m) => ({ value: m, label: monthName(m) }))} />;
}

export function Src({ src }) {
  if (!src) return null;
  const app = src === "app";
  const gap = src === "gap";
  const bank = src === "bank"; // Round 223 — from the bank statements
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, whiteSpace: "nowrap",
      background: gap ? "var(--alert-red-bg)" : app ? "var(--signal-green-bg)" : bank ? "#E2EAF6" : "#ECEAE4",
      color: gap ? "var(--alert-red)" : app ? "#1D6A4B" : bank ? "#1F4A82" : "#4A525C" }}>
      {gap ? "Check" : app ? "App" : bank ? "Bank" : "Entered"}
    </span>
  );
}
export function SrcLegend() {
  return (
    <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: "var(--slate)", flexWrap: "wrap" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Src src="app" />from what the app records</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Src src="entered" />keyed in by Accounts</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Src src="bank" />from the bank statements</span>
    </div>
  );
}

export function Tone({ value, good, children }) {
  // good = true means "this change is good"; null = neutral
  const bg = good == null ? "#ECEAE4" : good ? "var(--signal-green-bg)" : "var(--alert-red-bg)";
  const fg = good == null ? "var(--slate)" : good ? "var(--signal-green)" : "var(--alert-red)";
  return <span style={{ display: "inline-block", fontSize: 11.5, padding: "2px 9px", borderRadius: 20, fontWeight: 600, background: bg, color: fg, ...NUM }}>{children ?? value}</span>;
}

// Round 219 — a tile with onClick opens how its figure is worked out.
export function Tile({ label, value, sub, delta, good, note, dark, onClick }) {
  const clickable = typeof onClick === "function";
  return (
    <div role={clickable ? "button" : undefined} tabIndex={clickable ? 0 : undefined} onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className={clickable ? "cost-tile-click" : undefined}
      style={{ background: dark ? "var(--charcoal)" : "var(--surface)", color: dark ? "#fff" : "var(--charcoal)", border: "1px solid var(--border)",
      borderRadius: 10, boxShadow: "var(--shadow)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6, minWidth: 0, cursor: clickable ? "pointer" : undefined }}>
      <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, opacity: dark ? 0.85 : 1, color: dark ? "#fff" : "var(--slate)" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1, ...NUM }}>{value}</div>
      {sub && <div style={{ fontSize: 13, fontWeight: 600, ...NUM }}>{sub}</div>}
      {(delta || note) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {delta && <Tone good={good}>{delta}</Tone>}
          {note && <span style={{ fontSize: 11, opacity: dark ? 0.85 : 1, color: dark ? "#fff" : "var(--slate)" }}>{note}</span>}
        </div>
      )}
      {clickable && <div className="no-print" style={{ fontSize: 11.5, fontWeight: 600, color: dark ? "#fff" : "var(--rebar)", marginTop: "auto" }}>How it&rsquo;s worked out ›</div>}
    </div>
  );
}

export function Swatch({ c }) { return <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: c, display: "inline-block", flex: "none" }} />; }

export function Note({ tone = "warn", children }) {
  const s = tone === "bad" ? { bg: "var(--alert-red-bg)", bd: "#E8C4BF", fg: "var(--charcoal)" }
    : tone === "good" ? { bg: "var(--signal-green-bg)", bd: "#BFDCCB", fg: "#1D4F3A" }
      : { bg: "var(--amber-bg)", bd: "#E7D8AE", fg: "var(--charcoal)" };
  return <div style={{ background: s.bg, border: `1px solid ${s.bd}`, color: s.fg, borderRadius: 8, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5 }}>{children}</div>;
}

export function Bar({ value, max, color }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div style={{ height: 8, borderRadius: 4, background: "var(--concrete)", overflow: "hidden", flex: 1 }}>
      <div style={{ height: "100%", width: `${w}%`, background: color, borderRadius: 4 }} />
    </div>
  );
}

export function useCostData(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    apiRequest(path)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [path, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function Loading({ error }) {
  if (error) return <div className="card" role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Working out the figures…</div>;
}

// Excel: an array of sheets { name, rows: [[...], ...] }.
export async function downloadExcel(file, sheets) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name.slice(0, 31));
  XLSX.writeFile(wb, file);
}

export function Actions({ children }) {
  return <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>{children}</div>;
}
export const BTN = { padding: "10px 14px", minHeight: 40, fontSize: 13, fontWeight: 500, borderRadius: 8 };

export function Modal({ title, onClose, children, width = 640 }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(34,38,43,.45)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 12px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: width, margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <h2 style={{ ...H2, fontSize: 16 }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ padding: "6px 10px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
