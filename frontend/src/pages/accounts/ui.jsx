// Round 204 — small shared pieces for the Accounts module screens.
import { useEffect, useState } from "react";
import { STATUS_LABEL } from "../../lib/quotationTerms.js";
import { apiRequest } from "../../lib/api.js";

export const TH = { padding: "8px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--slate)", whiteSpace: "nowrap" };
export const TD = { padding: "8px 10px", fontSize: 13, verticalAlign: "top" };
export const NUM = { ...TD, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

export const money = (n, dp = 0) =>
  n == null || n === "" ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const TONE_CLASS = {
  draft: "badge-neutral", pending_approval: "badge-warning", approved: "badge-info", sent: "badge-info",
  accepted: "badge-success", declined: "badge-danger", lost: "badge-danger", superseded: "badge-neutral", cancelled: "badge-neutral",
};
export function StatusBadge({ status }) {
  return <span className={`badge ${TONE_CLASS[status] || "badge-neutral"}`}>{STATUS_LABEL[status] || status}</span>;
}

export function Banner({ kind = "error", children }) {
  if (!children) return null;
  const c = kind === "error" ? ["var(--alert-red)", "var(--alert-red-bg)"] : kind === "ok" ? ["var(--signal-green)", "var(--signal-green-bg)"] : ["var(--amber)", "var(--amber-bg)"];
  return <div className="card" style={{ marginBottom: 12, color: c[0], background: c[1], borderColor: c[0], fontSize: 13 }}>{children}</div>;
}

export function Field({ label, hint, children, style }) {
  return (
    <label className="field-input" style={{ display: "block", marginBottom: 10, ...style }}>
      <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 4 }}>{label}</span>
      {children}
      {hint && <span style={{ display: "block", fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, width = 560 }) {
  return (
    <div onClick={onClose} role="dialog" aria-modal="true"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 12 }}>
      <div className="card" onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: width, maxHeight: "92vh", overflowY: "auto", padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", padding: "4px 10px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }) {
  return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>{children}</div>;
}

export function Table({ head, children, minWidth = 640 }) {
  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth }}>
        <thead><tr style={{ background: "var(--concrete)" }}>{head}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const row = { borderTop: "1px solid var(--border)" };

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Round 253 — a photo (cheque, bill) shrunk on the phone before upload: the
// longer side at most `max` px, JPEG. Keeps a camera photo well under 1 MB.
export function readPhotoSmall(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file is not a picture the browser can read.")); };
    img.src = url;
  });
}

// A photo kept on the server, shown when asked for.
export function PhotoModal({ path, title = "Photo", onClose }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { apiRequest(path).then((d) => (d.photo ? setSrc(d.photo) : setErr("No photo."))).catch((e) => setErr(e.message)); }, [path]);
  return (
    <Modal title={title} onClose={onClose} width={720}>
      {err ? <div style={{ fontSize: 13, color: "var(--slate)" }}>{err}</div>
        : src ? <img src={src} alt={title} style={{ width: "100%", borderRadius: 8 }} /> : <div style={{ fontSize: 13 }}>Loading…</div>}
    </Modal>
  );
}
