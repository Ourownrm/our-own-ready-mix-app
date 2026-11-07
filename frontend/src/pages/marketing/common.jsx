// Round 269 — small pieces shared by the Marketing module's tabs.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";

export function useMeta() {
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { apiRequest("/marketing/meta").then(setMeta).catch((e) => setErr(e.message)); }, []);
  return [meta, err];
}

export const fmtDay = (v) => (v ? new Date(`${String(v).slice(0, 10)}T12:00:00+05:30`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
export const mb = (b) => (b == null ? "" : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export const KIND_LABEL = { poster: "Poster", video: "Video", pdf: "Technical PDF", brochure: "Brochure" };
export const EVERY_LABEL = { once: "once", days: "days", weeks: "weeks", months: "months", yearly: "every year", festival: "festivals", when_sent: "when sent" };
export function everyText(p) {
  if (["once", "yearly", "festival", "when_sent"].includes(p.every_kind)) return EVERY_LABEL[p.every_kind];
  return p.every_n > 1 ? `every ${p.every_n} ${EVERY_LABEL[p.every_kind]}` : `every ${EVERY_LABEL[p.every_kind].replace(/s$/, "")}`;
}
export const CH_LABEL = { whatsapp: "WhatsApp", email: "Email", phone: "Phone", visit: "Visit", wa_api: "WhatsApp API", wa_phone: "WhatsApp (phone)" };

export function Banner({ kind = "error", children }) {
  if (!children) return null;
  const ok = kind === "ok";
  return (
    <div role={ok ? "status" : "alert"} className="card" style={{ background: ok ? "var(--signal-green-bg)" : "var(--alert-red-bg)", color: ok ? "var(--signal-green)" : "var(--alert-red)", fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>
      {children}
    </div>
  );
}

export function Tile({ label, value, tone }) {
  const colour = tone === "red" ? "var(--alert-red)" : tone === "amber" ? "var(--amber)" : tone === "green" ? "var(--signal-green)" : "var(--charcoal)";
  return (
    <div className="card" style={{ margin: 0, padding: "12px 14px" }}>
      <div style={{ fontSize: 12, color: "var(--slate)" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: colour }}>{value}</div>
    </div>
  );
}

export function Field({ label, children, hint, style }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)", ...style }}>
      {label}{children}{hint && <span style={{ fontWeight: 400, fontSize: 11.5 }}>{hint}</span>}
    </label>
  );
}

export function Chip({ children, tone }) {
  const t = { green: ["var(--signal-green-bg)", "var(--signal-green)"], amber: ["var(--amber-bg)", "var(--amber)"], red: ["var(--alert-red-bg)", "var(--alert-red)"], blue: ["var(--info-bg)", "var(--info)"] }[tone] || ["#EEF1F5", "#334155"];
  return <span style={{ background: t[0], color: t[1], borderRadius: 6, padding: "2px 7px", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" }}>{children}</span>;
}

export function Sheet({ title, onClose, children, wide }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: "fixed", inset: 0, background: "rgba(34,38,43,.45)", zIndex: 60, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "4vh 10px", overflowY: "auto" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card" style={{ width: "100%", maxWidth: wide ? 820 : 560, margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <b style={{ fontSize: 16 }}>{title}</b>
          <button type="button" onClick={onClose} aria-label="Close" style={{ minWidth: 40, minHeight: 40 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const TH = { padding: "7px 8px", borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--slate)", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" };
export const TD = { padding: "9px 8px", borderBottom: "1px solid #EEEAE2", verticalAlign: "top", fontSize: 13 };
