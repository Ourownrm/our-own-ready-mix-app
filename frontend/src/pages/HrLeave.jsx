// Round 200 — leave: the record / request form, the HR "Leave" tab
// (approvals, records, balances) and the leave-types card in Settings.
// LeaveForm is also used by pages/MyAttendance.jsx (self = true).
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";

const STATUS_BADGE = { pending: "badge-info", approved: "badge-success", rejected: "badge-danger", cancelled: "badge-neutral" };
const istDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const istMonth = () => istDay().slice(0, 7);
export const fmtDay = (d) => new Date(d + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
export const leaveRange = (l) => l.from_date === l.to_date ? fmtDay(l.from_date) + (l.half_day ? " (half day)" : "") : `${fmtDay(l.from_date)} – ${fmtDay(l.to_date)}`;
const dayCount = (n) => `${n} day${n === 1 ? "" : "s"}`;

function Field({ label, children, hint }) {
  return (
    <label className="field-input" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", fontWeight: 600 }}>
      {label}{children}{hint && <span style={{ fontWeight: 400, fontSize: 11 }}>{hint}</span>}
    </label>
  );
}

// `fixed` pins employee and/or dates. `self` = the employee asking for their own
// leave. `canApproveNow` shows the "record as approved" choice to someone who
// may decide it (the server checks again).
// "1 of 1 left for Oct 2026", "1.5 comp-off days", "not during probation".
export function balHint(b) {
  if (!b) return undefined;
  if (b.eligible === false) return b.not_eligible_reason;
  if (b.kind === "comp_off") return `${b.left} comp-off day${b.left === 1 ? "" : "s"} available${b.next_expiry ? ` · ${b.next_expiry.days} expires ${b.next_expiry.on}` : ""}`;
  if (b.allowance == null) return b.used ? `${b.used} taken in ${b.period_label}` : undefined;
  return `${b.left} of ${b.allowance} left for ${b.period_label}${b.carried ? ` (${b.carried} carried)` : ""}${b.waiting ? `, ${b.waiting} waiting` : ""}`;
}

export function LeaveForm({ types, employees = [], fixed = {}, self = false, balances = null, canApproveNow = false, onDone, onCancel }) {
  const active = (types || []).filter((t) => t.is_active !== false);
  const [f, setF] = useState({
    employee_id: fixed.employee_id || "", leave_type_id: active[0]?.id || "", from_date: fixed.date || "", to_date: fixed.date || "",
    half_day: false, reason: "", approve_now: canApproveNow,
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const bal = balances?.find((b) => b.leave_type_id === Number(f.leave_type_id));
  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const body = { ...f, employee_id: Number(f.employee_id) || undefined, leave_type_id: Number(f.leave_type_id), to_date: f.half_day ? f.from_date : f.to_date || f.from_date };
      const r = await apiRequest(self ? "/hr/my/leaves" : "/hr/leaves", { method: "POST", body });
      onDone?.(r);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <form onSubmit={submit} style={{ marginTop: 12, padding: 12, background: "var(--concrete)", borderRadius: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        {!self && !fixed.employee_id && (
          <Field label="Employee">
            <select value={f.employee_id} onChange={(e) => set("employee_id", e.target.value)} required>
              <option value="">—</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.emp_code})</option>)}
            </select>
          </Field>
        )}
        <Field label="Type of leave" hint={balHint(bal)}>
          <select value={f.leave_type_id} onChange={(e) => set("leave_type_id", e.target.value)} required>
            {active.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code}){t.paid ? "" : " — unpaid"}</option>)}
          </select>
        </Field>
        <Field label={f.half_day ? "Date" : "From"}><input type="date" value={f.from_date} onChange={(e) => setF((x) => ({ ...x, from_date: e.target.value, to_date: !x.to_date || x.to_date < e.target.value ? e.target.value : x.to_date }))} required /></Field>
        {!f.half_day && <Field label="To"><input type="date" value={f.to_date} min={f.from_date} onChange={(e) => set("to_date", e.target.value)} required /></Field>}
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 10 }}>
        <input type="checkbox" checked={f.half_day} onChange={(e) => set("half_day", e.target.checked)} /> Half day only
      </label>
      <div style={{ marginTop: 10 }}>
        <Field label={self ? "Reason" : "Reason / note"}><textarea rows={2} value={f.reason} onChange={(e) => set("reason", e.target.value)} required={self} /></Field>
      </div>
      {canApproveNow && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 10 }}>
          <input type="checkbox" checked={f.approve_now} onChange={(e) => set("approve_now", e.target.checked)} /> Record as approved now (uncheck to send for approval)
        </label>
      )}
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>Weekly off and holidays inside the dates are not counted as leave.</div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving…" : f.approve_now && canApproveNow ? "Record leave" : "Send for approval"}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// ================================================================ HR > Leave
export function LeaveTab({ meta }) {
  const { can } = usePermissions();
  const [view, setView] = useState("list");
  const [status, setStatus] = useState("pending");
  const [month, setMonth] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [employees, setEmployees] = useState([]);
  const [recording, setRecording] = useState(false);
  const [notes, setNotes] = useState({});
  const load = () => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (month) q.set("month", month);
    apiRequest(`/hr/leaves?${q}`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { if (view === "list") { setData(null); load(); } }, [status, month, view]);
  useEffect(() => { if (can("hr.employees", "view")) apiRequest("/hr/employees").then((r) => setEmployees(r.filter((e) => e.is_active))).catch(() => {}); }, []);

  const act = async (path, body) => {
    setError("");
    try { await apiRequest(path, { method: "POST", body }); load(); } catch (err) { setError(err.message); }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <button className={`btn-tab${view === "list" ? " active" : ""}`} onClick={() => setView("list")}>Leave records</button>
        <button className={`btn-tab${view === "balances" ? " active" : ""}`} onClick={() => setView("balances")}>Balances</button>
      </div>
      {view === "balances" ? <BalancesView /> : (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
            <Field label="Show">
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="pending">Waiting for approval</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="cancelled">Cancelled</option>
                <option value="">All</option>
              </select>
            </Field>
            <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
            {can("hr.requests", "create") && !recording && <button className="btn-primary" onClick={() => setRecording(true)}>+ Record leave</button>}
          </div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
            Record leave for an absence here, or from a day in the Attendance register. Employees ask for leave from <b>My attendance</b>.
            The Plant Manager approves; Admin approves the Plant Manager&rsquo;s own leave and any leave beyond the yearly allowance. Approved leave shows on the register and counts in payroll — paid types as paid days, unpaid types as loss of pay.
          </div>
          {recording && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700 }}>Record leave</div>
              <LeaveForm types={meta.leave_types} employees={employees} canApproveNow={can("hr.requests", "edit")}
                onDone={() => { setRecording(false); load(); }} onCancel={() => setRecording(false)} />
            </div>
          )}
          {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
          {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
          {data && !data.leaves.length && <div className="card" style={{ fontSize: 13 }}>Nothing here.</div>}
          {data && data.leaves.map((l) => (
            <div key={l.id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{l.employee_name} <span style={{ fontWeight: 400, color: "var(--slate)", fontSize: 12 }}>{l.emp_code}{l.department ? ` · ${l.department}` : ""}</span></div>
                  <div style={{ fontSize: 13, marginTop: 2 }}><b>{l.type_name} ({l.type_code})</b>{!l.paid && " — unpaid"} · {leaveRange(l)} · {dayCount(l.days)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className={`badge ${STATUS_BADGE[l.status]}`}>{l.status === "pending" ? "Waiting" : l.status}</span>
                  {l.needs_admin && l.status === "pending" && <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 4 }}>Needs Admin: {l.admin_reason}</div>}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, fontSize: 12.5, marginTop: 8 }}>
                {l.balance && (l.balance.allowance != null || l.balance.kind === "comp_off") && <div><span style={{ color: "var(--slate)" }}>{l.type_code}:</span> {balHint(l.balance)}</div>}
                {l.reason && <div><span style={{ color: "var(--slate)" }}>Reason:</span> {l.reason}</div>}
                <div><span style={{ color: "var(--slate)" }}>Recorded by</span> {l.raised_by_name || "—"}, {new Date(l.raised_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}</div>
                {l.decided_by_name && <div><span style={{ color: "var(--slate)" }}>{l.status === "cancelled" ? "Cancelled" : "Decided"} by</span> {l.decided_by_name}{l.decision_note ? ` — ${l.decision_note}` : ""}</div>}
              </div>
              {(l.can_decide && can("hr.requests", "edit")) || l.can_cancel ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }} className="field-input">
                  <input style={{ flex: "1 1 220px" }} placeholder={l.can_decide ? "Note (required to reject)" : "Note"} value={notes[l.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))} />
                  {l.can_decide && can("hr.requests", "edit") && <>
                    <button className="btn-primary" onClick={() => act(`/hr/leaves/${l.id}/decide`, { approve: true, note: notes[l.id] || "" })}>Approve</button>
                    <button onClick={() => act(`/hr/leaves/${l.id}/decide`, { approve: false, note: notes[l.id] || "" })} style={{ color: "var(--alert-red)" }}>Reject</button>
                  </>}
                  {l.can_cancel && <button onClick={() => { if (window.confirm(l.status === "approved" ? "Cancel this approved leave? Those days go back to what the punches show." : "Withdraw this leave?")) act(`/hr/leaves/${l.id}/cancel`, { note: notes[l.id] || "" }); }}>{l.status === "approved" ? "Cancel leave" : "Withdraw"}</button>}
                </div>
              ) : l.status === "pending" ? <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8 }}>{l.needs_admin ? "Waiting for Admin." : "You cannot approve this one."}</div> : null}
            </div>
          ))}
        </>
      )}
    </>
  );
}

function BalancesView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest("/hr/leave-balances").then(setData).catch((e) => setError(e.message)); }, []);
  return (
    <>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Left today for each type: monthly types for this month, yearly types for this year, comp-off as available now. Waiting requests in brackets.</div>
      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {data && (
        <div className="card" style={{ padding: "4px 12px" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 12.5 }}>
              <thead><tr><th>Employee</th>{data.types.map((t) => <th key={t.id} style={{ textAlign: "right" }}>{t.code}<div style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{t.kind === "comp_off" ? "available" : t.yearly_days == null ? "taken" : `left of ${t.yearly_days}/${t.period === "month" ? "month" : "year"}`}</div></th>)}</tr></thead>
              <tbody>
                {data.employees.map((e) => (
                  <tr key={e.id}>
                    <td><b>{e.name}</b> <span style={{ color: "var(--slate)", fontSize: 11.5 }}>{e.emp_code}</span></td>
                    {e.balances.map((b) => (
                      <td key={b.leave_type_id} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: b.eligible === false ? "var(--slate)" : b.left != null && b.left < 0 ? "var(--alert-red)" : undefined }} title={b.not_eligible_reason || ""}>
                        {b.eligible === false ? "n/a" : b.allowance == null && b.kind !== "comp_off" ? (b.used || "—") : b.left}{b.waiting ? <span style={{ color: "var(--info)" }}> ({b.waiting})</span> : ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", padding: "6px 0" }}>n/a — the type isn't given to that person (contract worker, or on probation).</div>
        </div>
      )}
    </>
  );
}

// ================================================================ Settings > Leave types
export function LeaveTypesCard({ meta, canEdit, canCreate, onSaved }) {
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState("");
  async function save(e) {
    e.preventDefault(); setError("");
    try {
      if (edit.id) await apiRequest(`/hr/leave-types/${edit.id}`, { method: "PATCH", body: edit });
      else await apiRequest("/hr/leave-types", { method: "POST", body: edit });
      setEdit(null); onSaved();
    } catch (err) { setError(err.message); }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Leave types</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>A paid type counts as a paid day in payroll; an unpaid type is loss of pay. Each type is given once a year (Jan–Dec) or every month; unused days lapse at the period end unless a carry-forward is set. Leave beyond the allowance goes to Admin. Probation length is in Payroll rules.</div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Paid</th><th>Given</th><th>Unused days</th><th>Who</th><th></th></tr></thead>
          <tbody>
            {meta.leave_types.map((t) => (
              <tr key={t.id} style={{ opacity: t.is_active ? 1 : 0.5 }}>
                <td style={{ fontWeight: 700 }}>{t.code}</td>
                <td>{t.name}{!t.is_active && " (off)"}</td>
                <td>{t.paid ? "Paid" : "Unpaid"}</td>
                <td>{t.kind === "comp_off" ? "earned by working an off day" : t.yearly_days == null ? "no limit" : `${t.yearly_days} a ${t.period === "month" ? "month" : "year"}`}</td>
                <td>{t.kind === "comp_off" ? "expires (Payroll rules)" : t.yearly_days == null ? "—" : t.carry_max ? `carry forward, up to ${t.carry_max}` : `lapse at ${t.period === "month" ? "month" : "year"} end`}</td>
                <td style={{ fontSize: 12.5 }}>{[t.not_on_probation ? "not in probation" : null, t.for_contract === false ? "payroll staff only" : null].filter(Boolean).join(" · ") || "everyone"}</td>
                <td>{canEdit && <button style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setEdit({ ...t, yearly_days: t.yearly_days ?? "", carry_max: t.carry_max ?? "" })}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit ? (
        <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 12, alignItems: "end" }}>
          <Field label="Code"><input value={edit.code} maxLength={8} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} required /></Field>
          <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></Field>
          {edit.kind !== "comp_off" && <>
            <Field label="Given"><select value={edit.period || "year"} onChange={(e) => setEdit({ ...edit, period: e.target.value })}><option value="year">Once a year</option><option value="month">Every month</option></select></Field>
            <Field label={edit.period === "month" ? "Days each month" : "Days a year"}><input type="number" min="0" max={edit.period === "month" ? 31 : 366} step="0.5" value={edit.yearly_days} onChange={(e) => setEdit({ ...edit, yearly_days: e.target.value })} placeholder="no limit" /></Field>
            <Field label="Carry forward up to (days)" hint="Blank = unused days lapse"><input type="number" min="0" max="366" step="0.5" value={edit.carry_max} onChange={(e) => setEdit({ ...edit, carry_max: e.target.value })} placeholder="lapse" /></Field>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={!!edit.not_on_probation} onChange={(e) => setEdit({ ...edit, not_on_probation: e.target.checked })} /> Not during probation</label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={edit.for_contract !== false} onChange={(e) => setEdit({ ...edit, for_contract: e.target.checked })} /> Contract workers get it</label>
          </>}
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={edit.paid} onChange={(e) => setEdit({ ...edit, paid: e.target.checked })} /> Paid</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> In use</label>
          <div style={{ display: "flex", gap: 6 }}><button className="btn-primary" type="submit">Save</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
        </form>
      ) : canCreate && <button style={{ marginTop: 10 }} onClick={() => setEdit({ code: "", name: "", paid: true, yearly_days: "", period: "year", carry_max: "", not_on_probation: false, for_contract: true, is_active: true, sort_order: meta.leave_types.length + 1 })}>+ Add leave type</button>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
