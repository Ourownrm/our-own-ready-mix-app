// Round 198 — HR stage 2 screens: attendance requests, payroll, advances and
// the payroll rules card. Used by pages/HrModule.jsx; RequestForm is also
// used by pages/MyAttendance.jsx.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";

export const KIND_LABEL = {
  missed_in: "Missed punch — IN", missed_out: "Missed punch — OUT", on_duty: "On duty / site visit", full_day: "Present for the whole day",
};
const MODES = { bank_transfer: "Bank transfer", cash: "Cash", upi: "UPI", cheque: "Cheque" };
const STATUS_BADGE = { pending: "badge-info", approved: "badge-success", rejected: "badge-danger", cancelled: "badge-neutral" };

function istMonth() {
  return new Date(Date.now() - 4 * 3600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
}
function istDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function prevMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}
const rs = (v) => (v == null || v === "" ? "—" : "₹" + Math.round(Number(v)).toLocaleString("en-IN"));
const fmtDay = (d) => new Date(d + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

function Field({ label, children, hint }) {
  return (
    <label className="field-input" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", fontWeight: 600 }}>
      {label}{children}{hint && <span style={{ fontWeight: 400, fontSize: 11 }}>{hint}</span>}
    </label>
  );
}

// ================================================================ request form
// `fixed` pins employee and/or date; `self` posts to the self-service endpoint.
export function RequestForm({ employees = [], fixed = {}, self = false, onDone, onCancel }) {
  const [f, setF] = useState({ employee_id: fixed.employee_id || "", work_date: fixed.work_date || "", kind: "missed_out", time_in: "", time_out: "", reason: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const needIn = f.kind === "missed_in" || f.kind === "on_duty";
  const needOut = f.kind === "missed_out" || f.kind === "on_duty";
  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const body = { ...f, employee_id: Number(f.employee_id) || undefined };
      const r = await apiRequest(self ? "/hr/my/requests" : "/hr/requests", { method: "POST", body });
      onDone?.(r);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <form onSubmit={submit} style={{ marginTop: 12, padding: 12, background: "var(--concrete)", borderRadius: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        {!self && !fixed.employee_id && (
          <Field label="Employee">
            <select value={f.employee_id} onChange={set("employee_id")} required>
              <option value="">—</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.emp_code})</option>)}
            </select>
          </Field>
        )}
        {!fixed.work_date && <Field label="Date"><input type="date" value={f.work_date} max={istDay()} onChange={set("work_date")} required /></Field>}
        <Field label="What happened">
          <select value={f.kind} onChange={set("kind")}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {needIn && <Field label={f.kind === "on_duty" ? "Left / started at" : "IN time"}><input type="time" value={f.time_in} onChange={set("time_in")} required /></Field>}
        {needOut && <Field label={f.kind === "on_duty" ? "Back / finished at" : "OUT time"}><input type="time" value={f.time_out} onChange={set("time_out")} required /></Field>}
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label="Reason"><textarea rows={2} value={f.reason} onChange={set("reason")} required placeholder={f.kind === "on_duty" ? "Which site, and why" : "e.g. forgot to punch out, machine queue"} /></Field>
      </div>
      {f.kind === "full_day" && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>A whole manual day always goes to Admin for approval.</div>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Sending…" : "Send for approval"}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// ================================================================ requests tab
export function RequestsTab() {
  const { can } = usePermissions();
  const [status, setStatus] = useState("pending");
  const [month, setMonth] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [employees, setEmployees] = useState([]);
  const [raising, setRaising] = useState(false);
  const [notes, setNotes] = useState({});
  const load = () => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (month) q.set("month", month);
    apiRequest(`/hr/requests?${q}`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { setData(null); load(); }, [status, month]);
  useEffect(() => { if (can("hr.employees", "view")) apiRequest("/hr/employees").then((r) => setEmployees(r.filter((e) => e.is_active))).catch(() => {}); }, []);

  async function decide(r, approve) {
    setError("");
    try {
      await apiRequest(`/hr/requests/${r.id}/decide`, { method: "POST", body: { approve, note: notes[r.id] || "" } });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <Field label="Show">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Waiting for approval</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="">All</option>
          </select>
        </Field>
        <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        {can("hr.requests", "create") && !raising && <button className="btn-primary" onClick={() => setRaising(true)}>+ Raise for an employee</button>}
      </div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
        The Plant Manager approves. Admin approves the Plant Manager&rsquo;s own requests, ones raised late, whole manual days, and missed punches over the monthly limit. Nobody approves their own. The machine punches are never changed — an approved request is shown beside them.
      </div>
      {raising && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700 }}>Raise a request for an employee</div>
          <RequestForm employees={employees} onDone={() => { setRaising(false); load(); }} onCancel={() => setRaising(false)} />
        </div>
      )}
      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && !data.requests.length && <div className="card" style={{ fontSize: 13 }}>Nothing here.</div>}
      {data && data.requests.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 700 }}>{r.employee_name} <span style={{ fontWeight: 400, color: "var(--slate)", fontSize: 12 }}>{r.emp_code}{r.department ? ` · ${r.department}` : ""}</span></div>
              <div style={{ fontSize: 13, marginTop: 2 }}>
                <b>{KIND_LABEL[r.kind]}</b> · {fmtDay(r.work_date)}
                {r.time_in && ` · in ${r.time_in}`}{r.time_out && ` · out ${r.time_out}`}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status === "pending" ? "Waiting" : r.status}</span>
              {r.needs_admin && r.status === "pending" && <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 4 }}>Needs Admin: {r.admin_reason}</div>}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, fontSize: 12.5, marginTop: 8 }}>
            <div><span style={{ color: "var(--slate)" }}>Machine shows:</span> {r.machine_shows ? (r.machine_shows.length ? r.machine_shows.join(", ") : "no punches") : "—"}</div>
            <div><span style={{ color: "var(--slate)" }}>Reason:</span> {r.reason}</div>
            <div><span style={{ color: "var(--slate)" }}>Raised by</span> {r.raised_by_name || "—"}, {new Date(r.raised_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}</div>
            {r.decided_by_name && <div><span style={{ color: "var(--slate)" }}>Decided by</span> {r.decided_by_name}{r.decision_note ? ` — ${r.decision_note}` : ""}</div>}
          </div>
          {r.can_decide && can("hr.requests", "edit") && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }} className="field-input">
              <input style={{ flex: "1 1 220px" }} placeholder="Note (required to reject)" value={notes[r.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
              <button className="btn-primary" onClick={() => decide(r, true)}>Approve</button>
              <button onClick={() => decide(r, false)} style={{ color: "var(--alert-red)" }}>Reject</button>
            </div>
          )}
          {r.status === "pending" && !r.can_decide && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8 }}>{r.needs_admin ? "Waiting for Admin." : "You cannot approve this one."}</div>}
        </div>
      ))}
    </>
  );
}

// ================================================================ advances tab
export function AdvancesTab() {
  const { can } = usePermissions();
  const [month, setMonth] = useState(istMonth());
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const blank = { employee_id: "", given_on: istDay(), amount: "", mode: "cash", reference: "", recover_month: "", note: "" };
  const [form, setForm] = useState(null);
  const load = () => apiRequest(`/hr/advances?month=${month}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { setData(null); load(); }, [month]);
  useEffect(() => { apiRequest("/hr/employees").then((r) => setEmployees(r.filter((e) => e.is_active))).catch(() => {}); }, []);
  const total = (data?.advances || []).filter((a) => a.recover_month === month).reduce((t, a) => t + Number(a.amount), 0);

  async function save(e) {
    e.preventDefault(); setError("");
    try {
      const body = { ...form, employee_id: Number(form.employee_id), recover_month: form.recover_month || form.given_on.slice(0, 7) };
      if (form.id) await apiRequest(`/hr/advances/${form.id}`, { method: "PATCH", body });
      else await apiRequest("/hr/advances", { method: "POST", body });
      setForm(null); load();
    } catch (err) { setError(err.message); }
  }
  async function remove(a) {
    if (!window.confirm(`Remove the ₹${a.amount} advance to ${a.employee_name}?`)) return;
    try { await apiRequest(`/hr/advances/${a.id}`, { method: "DELETE" }); load(); } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <Field label="Month"><input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        {can("hr.advances", "create") && !form && <button className="btn-primary" onClick={() => setForm(blank)}>+ Record an advance</button>}
        {data && <div style={{ fontSize: 13, paddingBottom: 8 }}>To recover from {month} salary: <b>{rs(total)}</b>{data.locked && <span className="badge badge-neutral" style={{ marginLeft: 8 }}>month locked</span>}</div>}
      </div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Money paid to an employee before the month&rsquo;s salary. It is deducted from the salary of the month chosen (normally the same month).</div>
      {form && (
        <form className="card" onSubmit={save} style={{ marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Field label="Employee">
              <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} required>
                <option value="">—</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.emp_code})</option>)}
              </select>
            </Field>
            <Field label="Given on"><input type="date" value={form.given_on} onChange={(e) => setForm({ ...form, given_on: e.target.value })} required /></Field>
            <Field label="Amount (₹)"><input type="number" min="1" step="1" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></Field>
            <Field label="Paid by">
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Reference"><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="UTR / cheque no." /></Field>
            <Field label="Recover from salary of" hint="Leave as is for the same month."><input type="month" value={form.recover_month || form.given_on.slice(0, 7)} onChange={(e) => setForm({ ...form, recover_month: e.target.value })} /></Field>
          </div>
          <div style={{ marginTop: 10 }}><Field label="Note"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field></div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="submit" className="btn-primary">Save</button>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {data && (
        <div className="card" style={{ padding: "4px 12px" }}>
          {!data.advances.length ? <div style={{ fontSize: 13, padding: 8 }}>No advances this month.</div> : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Given on</th><th>Employee</th><th style={{ textAlign: "right" }}>Amount</th><th>Paid by</th><th>Recovered from</th><th>Note</th><th></th></tr></thead>
                <tbody>
                  {data.advances.map((a) => (
                    <tr key={a.id}>
                      <td>{fmtDay(a.given_on)}</td>
                      <td><b>{a.employee_name}</b> <span style={{ color: "var(--slate)", fontSize: 12 }}>{a.emp_code}</span></td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{rs(a.amount)}</td>
                      <td style={{ fontSize: 12.5 }}>{MODES[a.mode]}{a.reference ? ` · ${a.reference}` : ""}</td>
                      <td style={{ fontSize: 12.5 }}>{a.recover_month}{a.recover_month !== month ? " (other month)" : ""}</td>
                      <td style={{ fontSize: 12.5 }}>{a.note || ""}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {can("hr.advances", "edit") && <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setForm({ ...a, employee_id: String(a.employee_id), reference: a.reference || "", note: a.note || "" })}>Edit</button>}{" "}
                        {can("hr.advances", "delete") && <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => remove(a)}>Remove</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ================================================================ payroll tab
function LineDetail({ line, locked, canEdit, month, onChanged, onClose }) {
  const c = line.calc;
  const [m, setM] = useState({ ot_hours: line.ot_hours ?? "", other_earning: line.other_earning || 0, other_deduction: line.other_deduction || 0, remarks: line.remarks || "" });
  const [pay, setPay] = useState({ paid_amount: line.paid_amount ?? line.net_pay, paid_on: line.paid_on || istDay(), paid_mode: line.paid_mode || "bank_transfer", paid_ref: line.paid_ref || "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn) => { setError(""); setBusy(true); try { await fn(); onChanged(); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const row = (label, v, opts = {}) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "3px 0", fontSize: 13, fontWeight: opts.bold ? 700 : 400, color: opts.muted ? "var(--slate)" : undefined }}>
      <span>{label}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div><div style={{ fontWeight: 700, fontSize: 15 }}>{line.name}</div><div style={{ fontSize: 12, color: "var(--slate)" }}>{line.emp_code} · {line.department || ""}{c.contract ? ` · contract${line.contractor_name ? " — " + line.contractor_name : ""}` : ""}</div></div>
        <button onClick={onClose}>Close</button>
      </div>
      {c.warnings.length > 0 && <div style={{ background: "var(--amber-bg)", color: "var(--amber)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginTop: 10 }}>{c.warnings.join(" · ")}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 20, marginTop: 12 }}>
        <div>
          <div className="kpi-label" style={{ marginBottom: 4 }}>Attendance</div>
          {row("Days in month / employed", `${c.days_in_month} / ${c.days_employed}`)}
          {row("Present · half · absent", `${c.present} · ${c.half} · ${c.absent}`)}
          {row("Missed punch · no location", `${c.missed} · ${c.no_location}`)}
          {row("Weekly off · holiday", `${c.off} · ${c.holiday}`)}
          {(c.leave_paid || c.leave_unpaid) ? row("Leave — paid · unpaid", `${c.leave_paid || 0} · ${c.leave_unpaid || 0}`) : null}
          {row("Late · early", `${c.late} · ${c.early}`, { muted: true })}
          {row("Paid days", c.paid_days, { bold: true })}
          {!c.contract && row("Loss of pay days", c.lop_days)}
        </div>
        <div>
          <div className="kpi-label" style={{ marginBottom: 4 }}>Earnings</div>
          {c.contract ? row(`Wages (${c.paid_days} × ${rs(c.daily_rate)})`, rs(c.earned.wages)) : Object.entries(c.earned).filter(([, v]) => v).map(([k, v]) => <div key={k}>{row(k[0].toUpperCase() + k.slice(1), rs(v))}</div>)}
          {row(`Overtime ${c.ot_eligible ? `(${c.ot_hours} h)` : "(not paid)"}`, rs(c.ot_amount))}
          {!c.ot_eligible && c.ot_suggested > 0 && row(`  punches show ${c.ot_suggested} h extra`, "", { muted: true })}
          {c.trip_count > 0 || c.trip_allowance ? row(`Trip allowance (${c.trip_count} trips)`, rs(c.trip_allowance)) : null}
          {c.incentive_note && row("Incentive", rs(c.incentive))}
          {c.incentive_note && <div style={{ fontSize: 11, color: "var(--slate)" }}>{c.incentive_note}</div>}
          {c.other_earning ? row("Other earning", rs(c.other_earning)) : null}
          {row("Total earnings", rs(c.total_earnings), { bold: true })}
        </div>
        <div>
          <div className="kpi-label" style={{ marginBottom: 4 }}>Deductions</div>
          {row("PF", rs(c.pf))}{row("ESI", rs(c.esi))}{row("Professional tax", rs(c.pt))}
          {row("Advance recovered", rs(c.advance))}
          {c.other_deduction ? row("Other deduction", rs(c.other_deduction)) : null}
          {row("Total deductions", rs(c.total_deductions), { bold: true })}
          <div style={{ borderTop: "1px solid var(--border-strong)", marginTop: 6, paddingTop: 6 }}>{row("Net pay", rs(line.net_pay), { bold: true })}</div>
          <div className="kpi-label" style={{ margin: "10px 0 4px" }}>Company cost</div>
          {row("Employer PF · ESI", `${rs(c.pf_employer)} · ${rs(c.esi_employer)}`, { muted: true })}
          {row("Bonus · gratuity provision", `${rs(c.bonus_provision)} · ${rs(c.gratuity_provision)}`, { muted: true })}
          {c.service_charge ? row("Contractor service charge", rs(c.service_charge), { muted: true }) : null}
          {row("Cost to company", rs(line.cost_to_company), { bold: true })}
        </div>
      </div>
      {line.remarks && <div style={{ fontSize: 12.5, marginTop: 8 }}><span style={{ color: "var(--slate)" }}>Remarks:</span> {line.remarks}</div>}

      {!locked && canEdit && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14, alignItems: "end" }}>
          {c.ot_eligible && <Field label="Overtime hours" hint={`Punches suggest ${c.ot_suggested} h`}><input type="number" min="0" step="0.5" value={m.ot_hours} placeholder={String(c.ot_suggested)} onChange={(e) => setM({ ...m, ot_hours: e.target.value })} /></Field>}
          <Field label="Other earning (₹)"><input type="number" min="0" value={m.other_earning} onChange={(e) => setM({ ...m, other_earning: e.target.value })} /></Field>
          <Field label="Other deduction (₹)"><input type="number" min="0" value={m.other_deduction} onChange={(e) => setM({ ...m, other_deduction: e.target.value })} /></Field>
          <Field label="Remarks"><input value={m.remarks} onChange={(e) => setM({ ...m, remarks: e.target.value })} /></Field>
          <button className="btn-primary" disabled={busy} onClick={() => run(() => apiRequest(`/hr/payroll/${month}/lines/${line.employee_id}`, { method: "PATCH", body: m }))}>Save &amp; recalculate</button>
        </div>
      )}
      {locked && canEdit && (
        <div style={{ marginTop: 14 }}>
          <div className="kpi-label" style={{ marginBottom: 6 }}>{c.contract ? "Wages paid" : "Salary paid"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, alignItems: "end" }}>
            <Field label="Amount (₹)"><input type="number" min="0" value={pay.paid_amount} onChange={(e) => setPay({ ...pay, paid_amount: e.target.value })} /></Field>
            <Field label="Paid on"><input type="date" value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} /></Field>
            <Field label="Mode"><select value={pay.paid_mode} onChange={(e) => setPay({ ...pay, paid_mode: e.target.value })}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Reference"><input value={pay.paid_ref} onChange={(e) => setPay({ ...pay, paid_ref: e.target.value })} placeholder="UTR / cheque no." /></Field>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn-primary" disabled={busy} onClick={() => run(() => apiRequest(`/hr/payroll/${month}/lines/${line.employee_id}/payment`, { method: "PUT", body: pay }))}>{line.paid_amount != null ? "Update" : "Mark paid"}</button>
              {line.paid_amount != null && <button disabled={busy} onClick={() => run(() => apiRequest(`/hr/payroll/${month}/lines/${line.employee_id}/payment`, { method: "PUT", body: { clear: true } }))}>Remove</button>}
            </div>
          </div>
        </div>
      )}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

export function PayrollTab() {
  const { can } = usePermissions();
  const canEdit = can("hr.payroll", "edit");
  const [month, setMonth] = useState(prevMonth(istMonth()));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null);
  const [payAll, setPayAll] = useState(null);
  const load = () => apiRequest(`/hr/payroll?month=${month}`).then((d) => { setData(d); setSel((s) => (s ? d.lines.find((l) => l.employee_id === s) ? s : null : null)); }).catch((e) => setError(e.message));
  useEffect(() => { setData(null); setSel(null); load(); }, [month]);
  const run = async (fn) => { setError(""); setBusy(true); try { await fn(); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const locked = data?.run?.status === "locked";

  const totals = useMemo(() => {
    const t = { earn: 0, ded: 0, net: 0, ctc: 0, paid: 0, ot: 0, trip: 0, inc: 0, adv: 0 };
    for (const l of data?.lines || []) {
      t.earn += l.calc.total_earnings; t.ded += l.calc.total_deductions; t.net += Number(l.net_pay); t.ctc += Number(l.cost_to_company);
      t.paid += Number(l.paid_amount || 0); t.ot += l.calc.ot_amount; t.trip += l.calc.trip_allowance; t.inc += l.calc.incentive; t.adv += l.calc.advance;
    }
    return t;
  }, [data]);

  async function exportXlsx() {
    const XLSX = await import("xlsx");
    const rows = data.lines.map((l) => {
      const c = l.calc;
      return {
        Code: l.emp_code, Name: l.name, Department: l.department || "", Type: c.contract ? "Contract" : "Payroll",
        "Paid days": c.paid_days, "LOP days": c.lop_days, "Earned (Rs.)": c.earned_gross, "OT hours": c.ot_hours, "OT (Rs.)": c.ot_amount,
        "Trip allowance": c.trip_allowance, Incentive: c.incentive, "Other earning": c.other_earning, "Total earnings": c.total_earnings,
        PF: c.pf, ESI: c.esi, PT: c.pt, Advance: c.advance, "Other deduction": c.other_deduction, "Total deductions": c.total_deductions,
        "Net pay": Number(l.net_pay), "Employer PF": c.pf_employer, "Employer ESI": c.esi_employer, Bonus: c.bonus_provision, Gratuity: c.gratuity_provision,
        "Service charge": c.service_charge, "Cost to company": Number(l.cost_to_company),
        "Paid amount": l.paid_amount != null ? Number(l.paid_amount) : "", "Paid on": l.paid_on || "", Mode: l.paid_mode ? MODES[l.paid_mode] : "", Reference: l.paid_ref || "",
        Remarks: l.remarks || "",
      };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Payroll");
    XLSX.writeFile(wb, `Payroll_${month}.xlsx`);
  }

  const selLine = data?.lines.find((l) => l.employee_id === sel);
  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <Field label="Month"><input type="month" value={month} max={istMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        {data && <span className={`badge ${locked ? "badge-success" : data.run ? "badge-warning" : "badge-neutral"}`} style={{ marginBottom: 10 }}>{locked ? "Locked" : data.run ? "Draft" : "Not calculated"}</span>}
        {canEdit && !locked && <button className="btn-primary" disabled={busy} onClick={() => run(() => apiRequest(`/hr/payroll/${month}/calculate`, { method: "POST" }))}>{data?.run ? "Recalculate" : "Calculate"}</button>}
        {canEdit && data?.run && !locked && data.month_finished && (
          <button disabled={busy} onClick={() => {
            if (!window.confirm(`Lock ${month}? Attendance corrections, advances and changes for this month close; the figures are frozen.${data.pending_requests ? `\n\n${data.pending_requests} request(s) are still waiting — they will NOT be counted.` : ""}`)) return;
            run(() => apiRequest(`/hr/payroll/${month}/lock`, { method: "POST" }));
          }}>Lock month</button>
        )}
        {locked && can("hr.payroll", "delete") && <button disabled={busy} onClick={() => run(() => apiRequest(`/hr/payroll/${month}/unlock`, { method: "POST" }))}>Unlock</button>}
        {locked && canEdit && !payAll && <button onClick={() => setPayAll({ paid_on: istDay(), paid_mode: "bank_transfer", paid_ref: "", only: "" })}>Mark all unpaid as paid…</button>}
        {data?.lines.length > 0 && <button onClick={exportXlsx}>Download Excel</button>}
      </div>
      {data && !data.month_finished && <div style={{ fontSize: 12.5, color: "var(--amber)", marginBottom: 8 }}>This month has not finished — figures so far only. It can be locked after the last day.</div>}
      {data?.pending_requests > 0 && !locked && <div style={{ fontSize: 12.5, color: "var(--info)", marginBottom: 8 }}>{data.pending_requests} attendance request(s) for this month are still waiting for approval.</div>}
      {data?.run && <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>
        Calculated {new Date(data.run.computed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{data.run.computed_by_name ? ` by ${data.run.computed_by_name}` : ""}
        {locked && ` · locked ${new Date(data.run.locked_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}${data.run.locked_by_name ? ` by ${data.run.locked_by_name}` : ""}`}
        {" · "}Missed punches counted as {data.run.rules?.missed_punch_at_lock === "absent" ? "absent" : "half day"}
      </div>}

      {payAll && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Record payment for everyone not yet marked paid (their net pay)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, alignItems: "end" }}>
            <Field label="Who"><select value={payAll.only} onChange={(e) => setPayAll({ ...payAll, only: e.target.value })}><option value="">Everyone</option><option value="payroll">Payroll staff only</option><option value="contract">Contract workers only</option></select></Field>
            <Field label="Paid on"><input type="date" value={payAll.paid_on} onChange={(e) => setPayAll({ ...payAll, paid_on: e.target.value })} /></Field>
            <Field label="Mode"><select value={payAll.paid_mode} onChange={(e) => setPayAll({ ...payAll, paid_mode: e.target.value })}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Reference"><input value={payAll.paid_ref} onChange={(e) => setPayAll({ ...payAll, paid_ref: e.target.value })} /></Field>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn-primary" disabled={busy} onClick={() => run(async () => { await apiRequest(`/hr/payroll/${month}/pay-all`, { method: "POST", body: payAll }); setPayAll(null); })}>Record</button>
              <button onClick={() => setPayAll(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && !data.run && <div className="card" style={{ fontSize: 13 }}>Payroll for {month} has not been calculated yet.</div>}

      {data?.lines.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
            {[["Total earnings", totals.earn], ["Deductions", totals.ded], ["Net pay", totals.net], ["Paid so far", totals.paid], ["Cost to company", totals.ctc]].map(([k, v]) => (
              <div key={k} className="kpi"><div className="kpi-label">{k}</div><div className="kpi-value" style={{ fontSize: 20 }}>{rs(v)}</div></div>
            ))}
          </div>
          <div className="card" style={{ padding: "4px 12px" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 12.5 }}>
                <thead><tr><th>Employee</th><th style={{ textAlign: "right" }}>Paid days</th><th style={{ textAlign: "right" }}>Earned</th><th style={{ textAlign: "right" }}>OT</th><th style={{ textAlign: "right" }}>Trip</th><th style={{ textAlign: "right" }}>Incentive</th><th style={{ textAlign: "right" }}>Deductions</th><th style={{ textAlign: "right" }}>Advance</th><th style={{ textAlign: "right" }}>Net pay</th><th>Paid</th></tr></thead>
                <tbody>
                  {data.lines.map((l) => {
                    const c = l.calc;
                    return (
                      <tr key={l.employee_id} onClick={() => setSel(sel === l.employee_id ? null : l.employee_id)} style={{ cursor: "pointer", background: sel === l.employee_id ? "#FBF3EC" : undefined }}>
                        <td><div style={{ fontWeight: 600 }}>{l.name}{c.warnings.length > 0 && <span title={c.warnings.join(" · ")} style={{ color: "var(--amber)", marginLeft: 6 }}>⚠</span>}</div><div style={{ fontSize: 11, color: "var(--slate)" }}>{l.emp_code}{c.contract ? " · contract" : ""}</div></td>
                        <td style={{ textAlign: "right" }}>{c.paid_days}</td>
                        <td style={{ textAlign: "right" }}>{rs(c.earned_gross)}</td>
                        <td style={{ textAlign: "right" }}>{c.ot_amount ? rs(c.ot_amount) : "—"}</td>
                        <td style={{ textAlign: "right" }}>{c.trip_allowance ? rs(c.trip_allowance) : "—"}</td>
                        <td style={{ textAlign: "right" }}>{c.incentive ? rs(c.incentive) : "—"}</td>
                        <td style={{ textAlign: "right" }}>{rs(c.total_deductions - c.advance)}</td>
                        <td style={{ textAlign: "right" }}>{c.advance ? rs(c.advance) : "—"}</td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>{rs(l.net_pay)}</td>
                        <td>{l.paid_amount != null ? <span className="badge badge-success">{rs(l.paid_amount)} · {fmtDay(l.paid_on)}</span> : locked ? <span className="badge badge-warning">unpaid</span> : <span style={{ color: "var(--slate)" }}>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr><td><b>Total · {data.lines.length}</b></td><td></td><td></td><td style={{ textAlign: "right" }}>{rs(totals.ot)}</td><td style={{ textAlign: "right" }}>{rs(totals.trip)}</td><td style={{ textAlign: "right" }}>{rs(totals.inc)}</td><td style={{ textAlign: "right" }}>{rs(totals.ded - totals.adv)}</td><td style={{ textAlign: "right" }}>{rs(totals.adv)}</td><td style={{ textAlign: "right" }}>{rs(totals.net)}</td><td>{rs(totals.paid)}</td></tr></tfoot>
              </table>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>Tap a row for the full breakdown{canEdit ? (locked ? " and to record what was paid" : ", overtime and other adjustments") : ""}.</div>
          {selLine && <LineDetail key={selLine.employee_id + String(selLine.net_pay) + String(selLine.paid_amount)} line={selLine} locked={locked} canEdit={canEdit} month={month} onChanged={load} onClose={() => setSel(null)} />}
        </>
      )}
    </>
  );
}

// ================================================================ rules card
export function RulesCard({ meta, canEdit, onSaved }) {
  const [vals, setVals] = useState(meta.rules);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setVals(meta.rules), [meta.rules]);
  async function save() {
    setError(""); setMsg("");
    try {
      const changed = Object.fromEntries(Object.entries(vals).filter(([k, v]) => String(v) !== String(meta.rules[k])));
      if (!Object.keys(changed).length) { setMsg("Nothing changed."); return; }
      await apiRequest("/hr/rules", { method: "PUT", body: changed });
      setMsg("Saved. Recalculate any draft payroll to use the new rules.");
      onSaved();
    } catch (err) { setError(err.message); }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 700 }}>Payroll rules</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>Missed punch at lock: <b>{meta.rules.missed_punch_at_lock === "half" ? "half day" : "absent"}</b> · overtime ×{meta.rules.ot_multiplier} · PT ₹{meta.rules.pt_amount} from ₹{Number(meta.rules.pt_threshold).toLocaleString("en-IN")}</div>
        </div>
        <button onClick={() => setOpen(!open)}>{open ? "Close" : canEdit ? "View / change" : "View"}</button>
      </div>
      {open && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 12 }}>
            {Object.entries(meta.rule_defs).map(([k, d]) => (
              <Field key={k} label={d.label}>
                {d.type === "enum" ? (
                  <select value={vals[k]} disabled={!canEdit} onChange={(e) => setVals({ ...vals, [k]: e.target.value })}>
                    {Object.entries(d.options).map(([ok, ov]) => <option key={ok} value={ok}>{ov}</option>)}
                  </select>
                ) : (
                  <input type="number" value={vals[k]} disabled={!canEdit} min={d.min} max={d.max} step={d.type === "int" ? 1 : "any"} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
                )}
              </Field>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8 }}>Professional tax slabs differ by state — set the amount and threshold that apply to the plant.</div>
          {canEdit && <button className="btn-primary" style={{ marginTop: 10 }} onClick={save}>Save rules</button>}
          {msg && <div style={{ color: "var(--signal-green)", fontSize: 13, marginTop: 6 }}>{msg}</div>}
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 6 }}>{error}</div>}
        </>
      )}
    </div>
  );
}
