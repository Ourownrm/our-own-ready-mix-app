// Round 243 — the PM checks the Manager / Plant In Charge has given to this
// person (driver, plant operator, loader operator …). Shown on their own
// screen; each is confirmed Done (with the reading) or Not done (with why).
// Renders nothing when nothing is given to them.
import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

const TONE = {
  overdue: ["Overdue", "var(--alert-red-bg)", "var(--alert-red)"],
  due_soon: ["Due soon", "var(--amber-bg)", "var(--amber)"],
  never: ["Not done yet", "#ECEAE4", "var(--slate)"],
  unknown: ["No reading", "#ECEAE4", "var(--slate)"],
  ok: ["OK", "var(--signal-green-bg)", "var(--signal-green)"],
  done: ["Done", "var(--signal-green-bg)", "var(--signal-green)"],
};
const RANK = { overdue: 0, due_soon: 1, never: 2, unknown: 3, ok: 4, done: 5 };
const when = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export default function MyPmChecks({ showAll = false }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({ km: "", hours: "", note: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => apiRequest("/maintenance-module/my-pm").then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  if (!rows || (!rows.length && !showAll)) return null;
  const list = [...rows].sort((a, b) => RANK[a.status] - RANK[b.status] || a.asset_name.localeCompare(b.asset_name));
  const shown = showAll ? list : list.filter((r) => ["overdue", "due_soon", "never", "unknown"].includes(r.status));
  const key = (r) => `${r.schedule_id}-${r.asset_id}`;

  async function confirm(r, done) {
    setErr("");
    if (!done && !form.note.trim()) { setErr("Say why it was not done."); return; }
    setBusy(true);
    try {
      await apiRequest("/maintenance-module/my-pm/confirm", { method: "POST", body: { schedule_id: r.schedule_id, asset_id: r.asset_id, done, km: form.km, hours: form.hours, note: form.note } });
      setOpen(null); setForm({ km: "", hours: "", note: "" }); load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>My PM checks</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>
        {shown.length ? `${shown.length} to do — confirm each one Done or Not done.` : "Nothing due right now."}
        {!showAll && rows.length > shown.length ? ` ${rows.length - shown.length} more not due yet.` : ""}
      </div>
      {shown.map((r) => {
        const t = TONE[r.status] || TONE.unknown;
        const isOpen = open === key(r);
        return (
          <div key={key(r)} style={{ borderTop: "1px solid var(--border)", padding: "9px 0" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.asset_name} · {r.schedule_name}</div>
                <div style={{ fontSize: 12, color: "var(--slate)" }}>{r.trigger} · {r.left}
                  {r.last_confirmation ? ` · last: ${r.last_confirmation.done ? "done" : "not done"} ${when(r.last_confirmation.at)}` : ""}</div>
              </div>
              <span style={{ background: t[1], color: t[2], fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "3px 10px" }}>{t[0]}</span>
              <button type="button" style={{ padding: "6px 12px", fontSize: 12.5 }} aria-expanded={isOpen}
                onClick={() => { setOpen(isOpen ? null : key(r)); setErr(""); setForm({ km: "", hours: "", note: "" }); }}>{isOpen ? "Close" : "Confirm"}</button>
            </div>
            {isOpen && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                {(r.checklist.length > 0 || r.tasks.length > 0) && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    {r.checklist.map((c) => <li key={`c${c}`}>{c}</li>)}
                    {r.tasks.map((x) => <li key={`t${x.task}`}>{x.task}{x.parts ? ` (${x.parts})` : ""}</li>)}
                  </ul>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                  <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>Km now
                    <input inputMode="decimal" value={form.km} onChange={(e) => setForm({ ...form, km: e.target.value })} /></label>
                  <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>Hours now
                    <input inputMode="decimal" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>
                </div>
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>Note (needed when not done)
                  <input value={form.note} maxLength={400} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
                {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 12.5 }}>{err}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => confirm(r, true)} style={{ flex: 1 }}>Done</button>
                  <button type="button" disabled={busy} onClick={() => confirm(r, false)} style={{ flex: 1 }}>Not done</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
