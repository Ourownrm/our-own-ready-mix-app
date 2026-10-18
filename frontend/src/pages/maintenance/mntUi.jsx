// Round 215 — shared pieces for the Maintenance module's screens.
// Colours and classes are the app's own (index.css): .card, .badge-*,
// .field-input, .btn-primary.
import { useEffect, useState, useCallback } from "react";
import { apiRequest } from "../../lib/api.js";

export const IST = "Asia/Kolkata";

export function fmtNum(v, digits = 0) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtRs(v, digits = 0) {
  return v == null ? "—" : `₹${fmtNum(v, digits)}`;
}
export function fmtDate(ts) {
  if (!ts) return "—";
  const s = String(ts);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+05:30`) : new Date(ts);
  return d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" });
}
export function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function todayIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: IST });
}
export function code(prefix, id) {
  return id ? `${prefix}-${String(id).padStart(4, "0")}` : "—";
}

export const PM_STATUS = {
  overdue: ["Overdue", "badge-danger"],
  due_soon: ["Due soon", "badge-warning"],
  never: ["Not done yet", "badge-neutral"],
  ok: ["OK", "badge-success"],
  done: ["Done", "badge-success"],
  unknown: ["No reading", "badge-neutral"],
};
export const BASIS = {
  OEM: ["Manufacturer", "badge-success"],
  ENGINE: ["Engine maker", "badge-info"],
  PRACTICE: ["Industry practice", "badge-warning"],
};
export const CARD_STATUS = {
  open: ["Open", "badge-warning"],
  work_done: ["Work done — to verify", "badge-info"],
  closed: ["Closed", "badge-success"],
  cancelled: ["Cancelled", "badge-neutral"],
};
export const OUTSIDE_STATUS = {
  awaiting_approval: ["Awaiting Administrator", "badge-warning"],
  approved: ["Approved", "badge-info"],
  rejected: ["Rejected", "badge-danger"],
  sent_out: ["At workshop", "badge-progress"],
  bill_hold: ["Bill above approved — Administrator", "badge-danger"],
  billed: ["Returned · billed", "badge-success"],
  cancelled: ["Cancelled", "badge-neutral"],
};
export const PART_STATUS = {
  requested: ["At store", "badge-info"],
  on_po: ["On PO", "badge-warning"],
  issued: ["Issued", "badge-success"],
  cancelled: ["Cancelled", "badge-neutral"],
};
export const PO_STATUS = {
  pending: ["Waiting for approval", "badge-warning"],
  approved: ["Approved — make GRV", "badge-info"],
  received: ["Received", "badge-success"],
  rejected: ["Rejected", "badge-danger"],
  cancelled: ["Cancelled", "badge-neutral"],
};

export function Badge({ map, value }) {
  const [label, cls] = (map && map[value]) || [value || "—", "badge-neutral"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// One fetch with loading / error state and a reload function.
export function useLoad(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!path) return;
    apiRequest(path).then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message));
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, load, setData };
}

// Run an action, show its result, reload. Returns [run, busy, msg, err, clear].
export function useAction(onDone) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  async function run(fn, doneText) {
    setBusy(true); setErr(""); setMsg("");
    try {
      const out = await fn();
      if (doneText) setMsg(typeof doneText === "function" ? doneText(out) : doneText);
      if (onDone) onDone(out);
      return out;
    } catch (e) {
      setErr(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, msg, err, clear: () => { setMsg(""); setErr(""); } };
}

export function Msg({ msg, err }) {
  if (!msg && !err) return null;
  return (
    <div role={err ? "alert" : "status"} style={{
      fontSize: 13, padding: "9px 12px", borderRadius: 8, marginBottom: 12,
      background: err ? "var(--alert-red-bg)" : "var(--signal-green-bg)", color: err ? "var(--alert-red)" : "var(--signal-green)",
    }}>{err || msg}</div>
  );
}

export function Loading({ error }) {
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
}

export const H2 = { fontSize: 15, fontWeight: 600, margin: "0 0 8px" };
export const MUTED = { color: "var(--slate)", fontSize: 12.5 };
export const LABEL = { display: "block", fontSize: 11.5, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 };
export const ROW = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
export const GRID = (min = 200) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12 });
export const SMALL_BTN = { padding: "6px 11px", fontSize: 12.5 };

export function Field({ label, children, style }) {
  return (
    <label className="field-input" style={{ display: "block", ...style }}>
      <span style={LABEL}>{label}</span>
      {children}
    </label>
  );
}

export function Kpi({ label, value, tone, sub, onClick }) {
  const colour = tone === "bad" ? "var(--alert-red)" : tone === "warn" ? "var(--amber)" : tone === "good" ? "var(--signal-green)" : "var(--charcoal)";
  const inner = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ color: colour }}>{value}</div>
      {sub && <div style={{ ...MUTED, fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </>
  );
  return onClick
    ? <button type="button" className="kpi" onClick={onClick} style={{ textAlign: "left", width: "100%", cursor: "pointer" }}>{inner}</button>
    : <div className="kpi">{inner}</div>;
}

export function Table({ children, minWidth = 560 }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ minWidth }}>{children}</table>
    </div>
  );
}
