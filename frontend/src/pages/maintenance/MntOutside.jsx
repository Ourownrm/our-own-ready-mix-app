// Round 215 — outside repairs. Raised from a job card's Outside jobs with an
// estimate; the Administrator approves (or rejects). Sent out, then back with
// the bill. A bill above the approved amount is held for the Administrator
// (the owner, 18 Oct): accept the full bill, or only the approved amount.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, Badge, OUTSIDE_STATUS, fmtRs, fmtWhen, fmtDate, todayIst, H2, MUTED, ROW, GRID, Field, SMALL_BTN } from "./mntUi.jsx";

export default function MntOutside({ go, params }) {
  const { can } = usePermissions();
  const list = useLoad("/maintenance-module/outside-repairs");
  const [filter, setFilter] = useState("live");
  const [form, setForm] = useState(null); // { id, mode: approve|reject|returned, ... }
  const act = useAction(() => { list.load(); setForm(null); });
  const focus = Number(params.get("repair")) || null;

  if (!list.data) return <Loading error={list.error} />;
  const live = ["awaiting_approval", "bill_hold", "approved", "sent_out"];
  const rows = list.data.filter((o) => (focus ? o.id === focus : filter === "live" ? live.includes(o.status) : true));
  const canApprove = can("mnt.outside-approve", "edit");
  const canEdit = can("mnt.outside-repairs", "edit");
  const post = (o, path, body, msg) => act.run(() => apiRequest(`/maintenance-module/outside-repairs/${o.id}/${path}`, { method: "POST", body }), msg);

  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}>
        {focus
          ? <button type="button" style={SMALL_BTN} onClick={() => go("outside")}>&larr; All outside repairs</button>
          : [["live", "In progress"], ["all", "All"]].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
              style={{ padding: "7px 13px", fontSize: 12.5, borderRadius: 20, background: filter === k ? "var(--charcoal)" : "#fff", color: filter === k ? "#fff" : "var(--charcoal)" }}>{l}</button>
          ))}
        <div style={{ flex: 1 }} />
        <span style={MUTED}>New requests are raised from a job card’s Outside jobs.</span>
      </div>
      <Msg msg={act.msg} err={act.err} />
      {rows.length === 0 && <section className="card" style={MUTED}>No outside repairs here.</section>}
      {rows.map((o) => {
        const f = form && form.id === o.id ? form : null;
        const set = (v) => setForm({ ...form, ...v });
        return (
          <section key={o.id} className="card" style={{ marginBottom: 12, borderColor: ["awaiting_approval", "bill_hold"].includes(o.status) ? "#E9C77B" : undefined }}>
            <div style={{ ...ROW, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={ROW}><b>{o.code}</b><span>{o.asset_name}</span><Badge map={OUTSIDE_STATUS} value={o.status} /></div>
                <div style={{ fontSize: 13, margin: "4px 0" }}>{o.work || "—"}</div>
                <div style={MUTED}>
                  {o.workshop} · requested by {o.requested_by_name || "—"} {fmtWhen(o.requested_at)}
                  {o.expected_days ? ` · ${o.expected_days} day(s)` : ""} ·{" "}
                  <button type="button" onClick={() => go("job-cards", { card: o.job_card_id })} style={{ background: "none", border: "none", padding: 0, color: "var(--charcoal)", textDecoration: "underline", fontSize: 12.5 }}>{o.job_card_code}</button>
                </div>
                {o.notes && <div style={MUTED}>Note: {o.notes}</div>}
                {o.reject_reason && <div style={{ ...MUTED, color: "var(--alert-red)" }}>Rejected: {o.reject_reason}</div>}
                {o.admin_note && <div style={MUTED}>Administrator: {o.admin_note}</div>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "2px 12px", fontSize: 13, textAlign: "right" }}>
                <span style={MUTED}>Estimate</span><b>{fmtRs(o.estimate_amount)}</b>
                {o.advance_amount != null && <><span style={MUTED}>Advance</span><span>{fmtRs(o.advance_amount)}</span></>}
                {o.approved_amount != null && <><span style={MUTED}>Approved</span><b>{fmtRs(o.approved_amount)}</b></>}
                {o.bill_amount != null && <><span style={MUTED}>Bill {o.bill_no}</span><b style={{ color: o.status === "bill_hold" ? "var(--alert-red)" : undefined }}>{fmtRs(o.bill_amount)}</b></>}
                {o.final_amount != null && <><span style={MUTED}>Cost to card</span><b>{fmtRs(o.final_amount)}</b></>}
              </div>
            </div>

            {!f && (
              <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
                {o.status === "awaiting_approval" && canApprove && (
                  <>
                    <button type="button" className="btn-danger" style={SMALL_BTN} onClick={() => setForm({ id: o.id, mode: "reject", reason: "" })}>Reject</button>
                    <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => setForm({ id: o.id, mode: "approve", approved_amount: o.estimate_amount, allow_advance: true, admin_note: "" })}>Approve…</button>
                  </>
                )}
                {o.status === "awaiting_approval" && !canApprove && <span style={MUTED}>Waiting for the Administrator.</span>}
                {["awaiting_approval", "approved"].includes(o.status) && canEdit && (
                  <button type="button" style={SMALL_BTN} disabled={act.busy} onClick={() => window.confirm("Cancel this outside repair? The jobs go back to the job card.") && post(o, "cancel", {}, "Cancelled.")}>Cancel request</button>
                )}
                {o.status === "approved" && canEdit && <button type="button" className="btn-primary" style={SMALL_BTN} disabled={act.busy} onClick={() => post(o, "sent-out", {}, "Marked as sent to the workshop.")}>Sent to workshop</button>}
                {o.status === "sent_out" && canEdit && <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => setForm({ id: o.id, mode: "returned", bill_no: "", bill_amount: "", bill_date: todayIst() })}>Back with bill…</button>}
                {o.status === "bill_hold" && canApprove && (
                  <>
                    <button type="button" style={SMALL_BTN} disabled={act.busy} onClick={() => post(o, "approve-bill", { accept: "approved_only" }, "Approved only the approved amount.")}>Pay approved {fmtRs(o.approved_amount)} only</button>
                    <button type="button" className="btn-primary" style={SMALL_BTN} disabled={act.busy} onClick={() => post(o, "approve-bill", { accept: "full" }, "Full bill approved.")}>Approve full bill {fmtRs(o.bill_amount)}</button>
                  </>
                )}
                {o.status === "bill_hold" && !canApprove && <span style={MUTED}>Bill is above the approved amount — waiting for the Administrator.</span>}
                {o.status === "billed" && <span style={MUTED}>Returned {fmtDate(o.returned_at)} — the bill is in Payments.</span>}
              </div>
            )}

            {f?.mode === "approve" && (
              <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, marginTop: 10 }}>
                <div style={GRID(180)}>
                  <Field label="Approved amount ₹"><input inputMode="decimal" value={f.approved_amount} onChange={(e) => set({ approved_amount: e.target.value })} /></Field>
                  <Field label="Note to the team"><input value={f.admin_note} onChange={(e) => set({ admin_note: e.target.value })} /></Field>
                </div>
                {o.advance_amount != null && (
                  <label style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 8 }}>
                    <input type="checkbox" checked={f.allow_advance} onChange={(e) => set({ allow_advance: e.target.checked })} /> Allow the advance of {fmtRs(o.advance_amount)}
                  </label>
                )}
                <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
                  <button type="button" onClick={() => setForm(null)}>Back</button>
                  <button type="button" className="btn-primary" disabled={act.busy} onClick={() => post(o, "approve", f, "Approved.")}>Approve</button>
                </div>
              </div>
            )}
            {f?.mode === "reject" && (
              <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, marginTop: 10 }}>
                <Field label="Reason"><input value={f.reason} onChange={(e) => set({ reason: e.target.value })} /></Field>
                <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
                  <button type="button" onClick={() => setForm(null)}>Back</button>
                  <button type="button" className="btn-danger" disabled={act.busy} onClick={() => post(o, "reject", f, "Rejected — the jobs are back on the job card.")}>Reject</button>
                </div>
              </div>
            )}
            {f?.mode === "returned" && (
              <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, marginTop: 10 }}>
                <div style={GRID(170)}>
                  <Field label="Bill no."><input value={f.bill_no} onChange={(e) => set({ bill_no: e.target.value })} /></Field>
                  <Field label="Bill date"><input type="date" value={f.bill_date} onChange={(e) => set({ bill_date: e.target.value })} /></Field>
                  <Field label="Bill amount ₹"><input inputMode="decimal" value={f.bill_amount} onChange={(e) => set({ bill_amount: e.target.value })} /></Field>
                </div>
                {Number(f.bill_amount) > Number(o.approved_amount) && (
                  <div style={{ ...MUTED, color: "var(--alert-red)", marginTop: 8 }}>
                    This is {fmtRs(Number(f.bill_amount) - Number(o.approved_amount))} above the approved {fmtRs(o.approved_amount)} — it will be held for the Administrator.
                  </div>
                )}
                <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
                  <button type="button" onClick={() => setForm(null)}>Back</button>
                  <button type="button" className="btn-primary" disabled={act.busy}
                    onClick={() => post(o, "returned", f, (r) => (r?.on_hold ? "Bill recorded — held for the Administrator (above approved)." : "Back from the workshop — the bill is in Payments."))}>Save</button>
                </div>
              </div>
            )}
          </section>
        );
      })}
      <div style={{ ...MUTED, marginTop: 4 }}><span style={{ ...H2, fontSize: 12.5 }}>Outside jobs are done</span> when the repair comes back; the job card then goes for verification as usual.</div>
    </>
  );
}
