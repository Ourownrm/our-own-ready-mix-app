// Round 269 — Marketing › Due today (mockup artboard 3): every communication
// whose date has come, and today's birthdays. Call, WhatsApp, log it.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { Banner, Chip, fmtDay, everyText, CH_LABEL } from "./common.jsx";
import { LogForm } from "./Directory.jsx";

const digits = (m) => String(m || "").replace(/\D/g, "");
const waNo = (m) => { const d = digits(m); return d.length === 10 ? `91${d}` : d; };

export default function DueToday({ go }) {
  const [mine, setMine] = useState(false);
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState(null);
  async function load() { try { setD(await apiRequest(`/marketing/due${mine ? "?mine=1" : ""}`)); } catch (e) { setErr(e.message); } }
  useEffect(() => { load(); }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps

  const pill = (on) => ({ borderRadius: 16, padding: "6px 12px", minHeight: 36, background: on ? "var(--charcoal)" : "#fff", color: on ? "#fff" : "var(--charcoal)", border: "1px solid var(--border-strong)" });
  return (
    <div style={{ maxWidth: 760 }}>
      <Banner>{err}</Banner>
      <Banner kind="ok">{msg}</Banner>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <button type="button" style={pill(!mine)} onClick={() => setMine(false)}>Everyone's</button>
        <button type="button" style={pill(mine)} onClick={() => setMine(true)}>Mine</button>
      </div>
      {!d ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : (!d.plans.length && !d.birthdays.length) ? (
        <div className="card" style={{ fontSize: 13.5 }}>Nothing due today.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {d.plans.map((p) => {
            const overdue = p.next_due < d.today;
            const days = overdue ? Math.round((new Date(d.today) - new Date(p.next_due)) / 86400000) : 0;
            const c = (p.contacts || [])[0];
            return (
              <div key={p.id} className="card" style={{ margin: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => go("directory", { firm: p.firm_id })} style={{ background: "none", border: "none", padding: 0, fontWeight: 700, fontSize: 14.5, color: "var(--charcoal)", textAlign: "left" }}>{p.firm_name}</button>
                  <Chip tone={overdue ? "red" : "amber"}>{p.category}{overdue ? ` · overdue ${days} d` : ""}</Chip>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 2 }}>
                  {c ? `${c.name}${c.designation ? ` · ${c.designation}` : ""} (L${c.level})` : "No contact at these levels yet"} · {everyText(p)} by {p.channels.map((x) => CH_LABEL[x]).join(" + ")}
                  {p.last ? ` · last ${fmtDay(p.last.at)}${p.last.note ? ` — “${p.last.note}”` : ""}` : ""}{p.owner_name ? ` · ${p.owner_name}` : ""}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 6, marginTop: 10 }}>
                  {c?.mobile && <a href={`tel:${digits(c.mobile)}`} className="btn" style={{ minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--border-strong)", borderRadius: 8, textDecoration: "none", color: "var(--charcoal)" }}>Call</a>}
                  {c?.mobile && c.on_whatsapp && <a href={`https://wa.me/${waNo(c.mobile)}`} target="_blank" rel="noreferrer" style={{ minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--border-strong)", borderRadius: 8, textDecoration: "none", color: "var(--charcoal)" }}>WhatsApp</a>}
                  <button type="button" className="btn-primary" style={{ minHeight: 44 }} onClick={() => setLog(p)}>Log it</button>
                </div>
              </div>
            );
          })}
          {d.birthdays.map((b) => (
            <div key={`b${b.id}`} className="card" style={{ margin: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><b>{b.name} — birthday</b><Chip tone="blue">Birthday</Chip></div>
              <div style={{ fontSize: 12.5, color: "var(--slate)" }}>{b.designation ? `${b.designation}, ` : ""}{b.firm_name}</div>
              {b.mobile && b.on_whatsapp && (
                <a href={`https://wa.me/${waNo(b.mobile)}?text=${encodeURIComponent(`Wishing you a very happy birthday, ${b.name.split(" ")[0]}! — Our Own Ready Mix`)}`} target="_blank" rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", minHeight: 44, marginTop: 8, padding: "0 14px", border: "1px solid var(--border-strong)", borderRadius: 8, textDecoration: "none", color: "var(--charcoal)" }}>Send wishes on WhatsApp</a>
              )}
            </div>
          ))}
        </div>
      )}
      {log && <LogForm firmId={log.firm_id} firmName={log.firm_name} plan={log} contacts={log.contacts || []}
        onClose={() => setLog(null)} onSaved={(next) => { setLog(null); setMsg(next ? `Saved — next ${fmtDay(next)}.` : "Saved."); load(); }} />}
    </div>
  );
}
