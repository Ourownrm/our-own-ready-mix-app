// Round 202 — HR "Today" (the day at a glance) and "Comp-off" tabs.
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { LeaveForm } from "./HrLeave.jsx";

const fmtDay = (d) => new Date(d + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const hm = (m) => (m == null ? "—" : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
const STATUS_BADGE = { pending: "badge-info", approved: "badge-success", rejected: "badge-danger", cancelled: "badge-neutral" };

function Tile({ label, value, sub, tone }) {
  const t = { dark: { background: "#23272C", color: "#fff", border: "1px solid #23272C" }, red: { background: "var(--alert-red-bg)", color: "var(--alert-red)", border: "1px solid #F1C9C3" } }[tone] || {};
  return (
    <div className="kpi" style={t}>
      <div className="kpi-label" style={tone ? { color: "inherit", opacity: 0.85 } : undefined}>{label}</div>
      <div className="kpi-value" style={{ fontSize: 26, color: tone ? "inherit" : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, opacity: tone ? 0.85 : 1, color: tone ? "inherit" : "var(--slate)" }}>{sub}</div>}
    </div>
  );
}

export function TodayTab({ meta, onOpenLeave }) {
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [leaveFor, setLeaveFor] = useState(null);
  const [dept, setDept] = useState("");
  const load = () => apiRequest("/hr/today").then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 5 * 60_000); return () => clearInterval(t); }, []);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Working out today…</div>;
  const t = data.totals;
  const notIn = data.lists.not_in.filter((x) => !dept || x.department === dept);
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{new Date(data.today + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} · {data.now}</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>"Not punched in" = no punch {data.not_punched_after_min} minutes after the person's shift start (09:00 if no shift). Refreshes every 5 minutes.</div>
        </div>
        <div className="field-input" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {meta.departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
          <button onClick={load}>Refresh</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
        <Tile tone="dark" label="Present now" value={<>{t.present} <span style={{ fontSize: 14, fontWeight: 500, opacity: 0.8 }}>of {t.due} due</span></>} sub={`${t.due ? Math.round(t.present / t.due * 100) : 0}% · ${t.machine} machine, ${t.phone} phone`} />
        <Tile tone={t.not_in ? "red" : undefined} label="Not punched in" value={t.not_in} sub="past cut-off, no leave" />
        <Tile label="Late today" value={t.late} sub="highlighted, no deduction" />
        <Tile label="On leave" value={t.leave} />
        <Tile label="On duty outside" value={t.on_duty} sub="approved" />
        <Tile label="Off today" value={t.off} sub="weekly / rostered off, holiday" />
        <Tile label="Yesterday's missed punches" value={t.missed_yesterday} sub="not corrected yet" />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <div className="card" style={{ flex: "999 1 560px", minWidth: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Not punched in yet · {notIn.length}</div>
          {!notIn.length ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Everyone due has punched in, or it isn't past their cut-off yet.</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 13 }}>
                <thead><tr><th>Employee</th><th>Shift starts</th><th>Cut-off</th><th>Last 7 days</th><th></th></tr></thead>
                <tbody>
                  {notIn.map((x) => (
                    <tr key={x.id}>
                      <td><b>{x.name}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{x.department || ""} · {x.source === "app" ? "phone" : "machine"}</div></td>
                      <td>{x.start}</td>
                      <td style={{ color: "var(--alert-red)", fontWeight: 600 }}>{x.cutoff} · {hm(x.minutes_past)} ago</td>
                      <td style={{ fontSize: 12.5 }}>{x.absent_last7 ? `${x.absent_last7} absent` : x.late_last7 ? `${x.late_last7} late` : "all present"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {x.phone && <a href={`tel:${x.phone}`} style={{ marginRight: 8 }}>Call</a>}
                        {can("hr.requests", "create") && <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setLeaveFor(x)}>Record leave</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {leaveFor && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Leave for {leaveFor.name}, {fmtDay(data.today)}</div>
              <LeaveForm types={meta.leave_types} fixed={{ employee_id: leaveFor.id, date: data.today }} canApproveNow={can("hr.requests", "edit")}
                onDone={() => { setLeaveFor(null); load(); }} onCancel={() => setLeaveFor(null)} />
            </div>
          )}
        </div>
        <div className="card" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Late today · {data.lists.late.length}</div>
          {!data.lists.late.length ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Nobody late.</div> : data.lists.late.map((x) => (
            <div key={x.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
              <span><b>{x.name}</b> <span style={{ color: "var(--slate)", fontSize: 12 }}>{x.department || ""}</span></span>
              <span style={{ color: "var(--rebar)" }}>+{x.late} min · {x.first}</span>
            </div>
          ))}
          {data.lists.missed_yesterday.length > 0 && <>
            <div style={{ fontWeight: 700, margin: "12px 0 6px" }}>Missed punch yesterday · {data.lists.missed_yesterday.length}</div>
            {data.lists.missed_yesterday.map((x) => (
              <div key={x.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                <span><b>{x.name}</b></span><span style={{ color: "var(--violet)" }}>{x.times.join(", ")}</span>
              </div>
            ))}
          </>}
          {data.lists.leave.length > 0 && <>
            <div style={{ fontWeight: 700, margin: "12px 0 6px" }}>On leave today</div>
            {data.lists.leave.map((x) => (
              <div key={x.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                <span><b>{x.name}</b></span><span style={{ color: "#28657E" }}>{x.leave.code}{x.leave.half ? " (½)" : ""}</span>
              </div>
            ))}
          </>}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 14 }}>
        <div className="card" style={{ flex: "999 1 560px", minWidth: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>By department</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>Department</th><th style={{ textAlign: "right" }}>Due</th><th style={{ textAlign: "right" }}>Present</th><th style={{ textAlign: "right" }}>Not in</th><th style={{ textAlign: "right" }}>Late</th><th style={{ textAlign: "right" }}>Leave</th><th style={{ width: "30%" }}>Present %</th></tr></thead>
              <tbody>
                {data.departments.map((d) => {
                  const pct = d.due ? Math.round(d.present / d.due * 100) : 0;
                  return (
                    <tr key={d.department}>
                      <td>{d.department}</td><td style={{ textAlign: "right" }}>{d.due}</td><td style={{ textAlign: "right" }}>{d.present}</td>
                      <td style={{ textAlign: "right", color: d.not_in ? "var(--alert-red)" : undefined, fontWeight: d.not_in ? 600 : 400 }}>{d.not_in || "—"}</td>
                      <td style={{ textAlign: "right" }}>{d.late || "—"}</td><td style={{ textAlign: "right" }}>{d.leave || "—"}</td>
                      <td><div style={{ height: 10, background: "#EEEAE3", borderRadius: 5 }}><div style={{ width: `${pct}%`, height: 10, borderRadius: 5, background: pct >= 85 ? "var(--signal-green)" : "var(--rebar)" }} /></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Present % — last 7 days</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 140, borderBottom: "1px solid var(--border-strong)" }} role="img"
            aria-label={`Present percentage, last 7 days: ${data.trend.map((x) => x.pct == null ? "no one due" : x.pct + "%").join(", ")}`}>
            {data.trend.map((x) => (
              <div key={x.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", gap: 3 }}>
                <span style={{ fontSize: 11, color: "var(--slate)" }}>{x.pct == null ? "off" : x.pct}</span>
                <div style={{ width: "100%", height: `${x.pct == null ? 3 : Math.max(3, x.pct)}%`, background: x.pct == null ? "#C9C4BA" : "var(--signal-green)", borderRadius: "4px 4px 0 0" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
            {data.trend.map((x) => <span key={x.date} style={{ flex: 1, textAlign: "center" }}>{new Date(x.date + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short" })}</span>)}
          </div>
        </div>
      </div>
      {t.untracked > 0 && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 10 }}>{t.untracked} employee{t.untracked > 1 ? "s are" : " is"} not counted — no attendance tracking, or not linked to the machine.</div>}
    </>
  );
}

// ================================================================ comp-off
export function CompOffTab({ meta }) {
  const { can } = usePermissions();
  const [status, setStatus] = useState("pending");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState({});
  const [raising, setRaising] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [f, setF] = useState({ employee_id: "", work_date: "", days: "", reason: "", approve_now: true });
  const load = () => apiRequest(`/hr/compoff${status ? `?status=${status}` : ""}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { setData(null); load(); }, [status]);
  useEffect(() => { if (can("hr.employees", "view")) apiRequest("/hr/employees").then((r) => setEmployees(r.filter((e) => e.is_active))).catch(() => {}); }, []);
  const act = async (path, body) => { setError(""); try { await apiRequest(path, { method: "POST", body }); load(); } catch (err) { setError(err.message); } };
  async function raise(e) {
    e.preventDefault(); setError("");
    try { await apiRequest("/hr/compoff", { method: "POST", body: { ...f, employee_id: Number(f.employee_id), days: f.days ? Number(f.days) : undefined } }); setRaising(false); load(); }
    catch (err) { setError(err.message); }
  }
  const r = data?.rules;
  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }} className="field-input">
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Waiting for approval</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option>
          </select>
        </label>
        {can("hr.requests", "create") && !raising && <button className="btn-primary" onClick={() => setRaising(true)}>+ Record a claim</button>}
      </div>
      {r && <div style={{ background: "#E2EEF3", color: "#1F4E61", borderRadius: 10, padding: "10px 12px", fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
        Worked on a weekly off or holiday: {Math.round(r.co_full_min / 6) / 10} h or more earns 1 day, {Math.round(r.co_half_min / 6) / 10} h or more ½ day — anyone can still ask for a full day, and the approver decides 1 day or ½ day · claim within {r.co_claim_days} days · expires {r.co_expiry_days} days after the day worked · an approved comp-off day is not also paid as overtime · to use it, record a <b>CO</b> leave on any absent or planned day (Leave tab, or from the register).
      </div>}
      {raising && (
        <form className="card field-input" onSubmit={raise} style={{ marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Employee
            <select value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })} required><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.emp_code})</option>)}</select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Off day worked<input type="date" value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} required /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Days
            <select value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })}><option value="">By the hours worked</option><option value="1">1 day</option><option value="0.5">½ day</option></select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Reason<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
          {can("hr.requests", "edit") && <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.approve_now} onChange={(e) => setF({ ...f, approve_now: e.target.checked })} /> Approve now</label>}
          <div style={{ display: "flex", gap: 6 }}><button className="btn-primary" type="submit">Save</button><button type="button" onClick={() => setRaising(false)}>Cancel</button></div>
          <div style={{ gridColumn: "1 / -1", fontSize: 11.5, color: "var(--slate)" }}>The hours are read from that day's punches; you can still give 1 day or ½ day.</div>
        </form>
      )}
      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && !data.claims.length && <div className="card" style={{ fontSize: 13, marginBottom: 12 }}>No claims here.</div>}
      {data?.claims.map((c) => (
        <div key={c.id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13 }}>
              <div style={{ fontSize: 14 }}><b>{c.employee_name}</b> <span style={{ color: "var(--slate)", fontSize: 12 }}>{c.emp_code}{c.department ? ` · ${c.department}` : ""}</span></div>
              <div>{fmtDay(c.work_date)} · {c.status === "pending" ? "asks for" : "given"} <b>{c.days === 1 ? "1 day" : "½ day"}</b> · expires {fmtDay(c.expires_on)}</div>
              {c.status === "pending" && c.qualifies != null && c.qualifies < c.days && <div style={{ fontSize: 12.5, color: "var(--amber)" }}>Hours qualify for {c.qualifies ? "½ day" : "less than ½ day"} by the rule — your call.</div>}
              {c.evidence && <div style={{ fontSize: 12.5, color: "#3E4349" }}>Punches: {c.evidence.times.join(", ") || "none"} · {hm(c.evidence.worked)}</div>}
              {c.reason && <div style={{ fontSize: 12, color: "var(--slate)" }}>Reason: {c.reason}</div>}
              {c.decided_by_name && <div style={{ fontSize: 12, color: "var(--slate)" }}>{c.status === "cancelled" ? "Cancelled" : "Decided"} by {c.decided_by_name}{c.decision_note ? ` — ${c.decision_note}` : ""}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <span className={`badge ${STATUS_BADGE[c.status]}`}>{c.status === "pending" ? "Waiting" : c.status}</span>
              {c.needs_admin && c.status === "pending" && <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 4 }}>Needs Admin: {c.admin_reason}</div>}
            </div>
          </div>
          {(c.can_decide && can("hr.requests", "edit")) || c.can_cancel ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }} className="field-input">
              <input style={{ flex: "1 1 200px" }} placeholder="Note (required to reject)" value={notes[c.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))} />
              {c.can_decide && can("hr.requests", "edit") && <>
                <button className={c.days === 1 ? "btn-primary" : ""} onClick={() => act(`/hr/compoff/${c.id}/decide`, { approve: true, days: 1, note: notes[c.id] || "" })}>Approve 1 day</button>
                <button className={c.days === 0.5 ? "btn-primary" : ""} onClick={() => act(`/hr/compoff/${c.id}/decide`, { approve: true, days: 0.5, note: notes[c.id] || "" })}>Approve ½ day</button>
                <button style={{ color: "var(--alert-red)" }} onClick={() => act(`/hr/compoff/${c.id}/decide`, { approve: false, note: notes[c.id] || "" })}>Reject</button>
              </>}
              {c.can_cancel && <button onClick={() => { if (window.confirm("Cancel this comp-off claim?")) act(`/hr/compoff/${c.id}/cancel`); }}>{c.status === "approved" ? "Cancel" : "Withdraw"}</button>}
            </div>
          ) : null}
        </div>
      ))}
      {data?.balances.length > 0 && (
        <div className="card" style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Balances</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>Employee</th><th style={{ textAlign: "right" }}>Earned</th><th style={{ textAlign: "right" }}>Used</th><th style={{ textAlign: "right" }}>Waiting</th><th style={{ textAlign: "right" }}>Lapsed</th><th style={{ textAlign: "right" }}>Balance</th><th>Next to expire</th></tr></thead>
              <tbody>
                {data.balances.map((e) => (
                  <tr key={e.id}>
                    <td><b>{e.name}</b> <span style={{ color: "var(--slate)", fontSize: 11.5 }}>{e.emp_code}</span></td>
                    <td style={{ textAlign: "right" }}>{e.co.earned}</td><td style={{ textAlign: "right" }}>{e.co.used || "—"}</td>
                    <td style={{ textAlign: "right" }}>{e.co.waiting || e.co.claims_waiting ? `${e.co.waiting || 0} use · ${e.co.claims_waiting || 0} claim` : "—"}</td>
                    <td style={{ textAlign: "right", color: e.co.lapsed ? "var(--amber)" : undefined }}>{e.co.lapsed || "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{e.co.left}</td>
                    <td>{e.co.next_expiry ? `${e.co.next_expiry.days} on ${fmtDay(e.co.next_expiry.on)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
