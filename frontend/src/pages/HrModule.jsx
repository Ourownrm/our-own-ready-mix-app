// Round 197 — HR module, stage 1: Attendance · Employees · Roster · Settings.
//
// Attendance is worked out on the server from the machine punches and the
// sales app check-ins (backend/src/lib/hrAttendance.js) — nothing on this
// screen edits a punch. Late marks are highlighted only, by the owner's
// decision; the Administrator decides what to do about them.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { RequestForm, RequestsTab, PayrollTab, AdvancesTab, RulesCard } from "./HrStage2.jsx";
import { LeaveForm, LeaveTab, LeaveTypesCard } from "./HrLeave.jsx";
import { FacePanel, WorkLocationsCard, PhonePunchReview } from "./HrPhone.jsx";
import { TodayTab, CompOffTab } from "./HrToday.jsx";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CODE_STYLE = {
  P: { bg: "var(--signal-green-bg)", fg: "var(--signal-green)", label: "Present" },
  HD: { bg: "var(--amber-bg)", fg: "var(--amber)", label: "Half day" },
  A: { bg: "var(--alert-red-bg)", fg: "var(--alert-red)", label: "Absent" },
  MIS: { bg: "var(--violet-bg)", fg: "var(--violet)", label: "Missed punch" },
  NL: { bg: "var(--violet-bg)", fg: "var(--violet)", label: "App check-in without location" },
  WO: { bg: "#ECEAE4", fg: "var(--slate)", label: "Weekly / rostered off" },
  H: { bg: "#ECEAE4", fg: "var(--slate)", label: "Holiday" },
  IN: { bg: "var(--info-bg)", fg: "var(--info)", label: "At work now" },
  L: { bg: "#E2EEF3", fg: "#28657E", label: "On leave (type shown)" },
};

function istMonth() {
  return new Date(Date.now() - 4 * 3600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
}
function istDay() {
  return new Date(Date.now() - 4 * 3600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function addDays(d, n) {
  const t = new Date(d + "T12:00:00+05:30");
  t.setDate(t.getDate() + n);
  return t.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function mondayOf(d) {
  const day = new Date(d + "T12:00:00+05:30").getDay();
  return addDays(d, -((day + 6) % 7));
}
function hm(min) {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}
const money = (v) => (v == null || v === "" ? "—" : "₹" + Number(v).toLocaleString("en-IN"));

function Field({ label, children, hint, span }) {
  return (
    <label className="field-input" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", fontWeight: 600, gridColumn: span ? "1 / -1" : undefined }}>
      {label}
      {children}
      {hint && <span style={{ fontWeight: 400, fontSize: 11 }}>{hint}</span>}
    </label>
  );
}

// ================================================================ Attendance
function AttendanceTab({ meta }) {
  const [month, setMonth] = useState(istMonth());
  const [dept, setDept] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(null);
  const [raising, setRaising] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { can } = usePermissions();
  const canRaise = can("hr.requests", "create");
  const reload = () => apiRequest(`/hr/attendance?month=${month}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    setData(null); setError(""); setSel(null); setRaising(false); setLeaving(false);
    reload();
  }, [month]);

  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.employees.filter((e) => (!dept || e.department === dept) &&
      (!s || e.name.toLowerCase().includes(s) || e.emp_code.toLowerCase().includes(s)));
  }, [data, dept, q]);

  const attention = useMemo(() => {
    const a = { missed: 0, late: 0, unlinked: 0, nl: 0 };
    for (const e of rows) {
      a.missed += e.summary.missed; a.late += e.summary.late; a.nl += e.summary.no_location;
      if (!e.linked) a.unlinked++;
    }
    return a;
  }, [rows]);

  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <Field label="Month"><input type="month" value={month} max={istMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        <Field label="Department">
          <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All departments</option>
            {meta.departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or code" /></Field>
      </div>

      {data && rows.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {attention.missed > 0 && <span className="badge" style={{ background: "var(--violet-bg)", color: "var(--violet)" }}>{attention.missed} missed punch{attention.missed > 1 ? "es" : ""}</span>}
          {attention.late > 0 && <span className="badge badge-warning">{attention.late} late arrival{attention.late > 1 ? "s" : ""} — for Admin to review</span>}
          {attention.nl > 0 && <span className="badge" style={{ background: "var(--violet-bg)", color: "var(--violet)" }}>{attention.nl} app check-in{attention.nl > 1 ? "s" : ""} without location</span>}
          {attention.unlinked > 0 && <span className="badge badge-danger">{attention.unlinked} employee{attention.unlinked > 1 ? "s" : ""} not linked to the machine / app</span>}
        </div>
      )}

      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Working out attendance…</div>}
      {data && !data.employees.length && (
        <div className="card" style={{ fontSize: 13 }}>No employees yet. Add them on the <b>Employees</b> tab and give each one their machine number.</div>
      )}

      {data && rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 12, borderCollapse: "separate", borderSpacing: 0 }}>
              <thead>
                <tr>
                  <th style={{ position: "sticky", left: 0, background: "var(--surface)", zIndex: 2, minWidth: 170, padding: "8px 10px" }}>Employee</th>
                  {data.dates.map((d) => (
                    <th key={d.date} title={d.holiday || ""} style={{ textAlign: "center", padding: "6px 2px", minWidth: 34, background: d.dow === 0 || d.holiday ? "#F3F1EC" : undefined, textTransform: "none", letterSpacing: 0 }}>
                      <div style={{ fontWeight: 700, color: "var(--charcoal)" }}>{Number(d.date.slice(8))}</div>
                      <div style={{ fontSize: 10 }}>{DOW[d.dow][0]}</div>
                    </th>
                  ))}
                  {["P", "½", "A", "MIS", "Leave", "Late", "Paid*"].map((h) => <th key={h} style={{ textAlign: "right", padding: "6px 8px" }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td style={{ position: "sticky", left: 0, background: "var(--surface)", zIndex: 1, padding: "6px 10px", borderRight: "1px solid var(--border)" }}>
                      <div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{e.name}</div>
                      <div style={{ fontSize: 10.5, color: "var(--slate)", whiteSpace: "nowrap" }}>
                        {e.emp_code} · {e.attendance_source === "app" ? "app" : e.machine_user_id ? `#${e.machine_user_id}` : e.attendance_source === "none" ? "no tracking" : <span style={{ color: "var(--alert-red)" }}>not linked</span>}
                        {e.policy === "operations" ? " · ops" : ""}
                      </div>
                    </td>
                    {e.days.map((d) => {
                      const st = CODE_STYLE[d.code];
                      const active = sel && sel.emp.id === e.id && sel.day.date === d.date;
                      return (
                        <td key={d.date} style={{ padding: 2, textAlign: "center" }}>
                          {d.code ? (
                            <button
                              onClick={() => { setSel(active ? null : { emp: e, day: d }); setRaising(false); setLeaving(false); }}
                              title={`${d.code === "L" ? `${d.leave?.name}${d.leave?.half ? " (half day)" : ""}${d.leave?.paid ? "" : " — unpaid"}` : st?.label || d.code}${d.late ? ` · late ${d.late} min` : ""}${d.early ? ` · left ${d.early} min early` : ""}`}
                              style={{
                                width: 32, height: 30, padding: 0, fontSize: 10.5, fontWeight: 700, borderRadius: 6, position: "relative",
                                border: active ? "2px solid var(--charcoal)" : "1px solid transparent",
                                background: st?.bg, color: st?.fg,
                              }}>
                              {d.code === "HD" ? "½" : d.code === "L" ? (d.leave?.half ? "½" : "") + (d.leave?.code || "L") : d.code}
                              {(d.late || d.early) && <span aria-hidden style={{ position: "absolute", top: 2, right: 2, width: 6, height: 6, borderRadius: 3, background: "var(--rebar)" }} />}
                              {d.pending > 0 && <span aria-hidden style={{ position: "absolute", bottom: 2, left: 2, width: 6, height: 6, borderRadius: 3, background: "var(--info)" }} />}
                              {d.flags?.some((x) => x.includes("approved request")) && <span aria-hidden style={{ position: "absolute", bottom: 1, right: 3, fontSize: 8, lineHeight: 1 }}>✓</span>}
                            </button>
                          ) : <span style={{ color: "var(--border-strong)" }}>·</span>}
                        </td>
                      );
                    })}
                    {[e.summary.present, e.summary.half, e.summary.absent, e.summary.missed, e.summary.leave, e.summary.late, e.summary.paid_days].map((v, i) => (
                      <td key={i} style={{ textAlign: "right", padding: "6px 8px", fontVariantNumeric: "tabular-nums", fontWeight: i === 6 ? 700 : 400,
                        color: i === 3 && v ? "var(--violet)" : i === 4 && v ? "#28657E" : i === 5 && v ? "var(--rebar)" : undefined }}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sel && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 700 }}>{sel.emp.name} · {new Date(sel.day.date + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</div>
              <div style={{ fontSize: 12, color: "var(--slate)" }}>{sel.day.leave ? `${sel.day.leave.name}${sel.day.leave.half ? " — half day" : ""}${sel.day.leave.paid ? "" : " (unpaid)"}${sel.day.code === "HD" ? " · Half day" : ""}` : CODE_STYLE[sel.day.code]?.label}{sel.day.shift ? ` · shift ${sel.day.shift}` : sel.emp.policy === "operations" ? " · no shift on the roster — judged on hours" : ""}</div>
            </div>
            <button onClick={() => setSel(null)}>Close</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 12, fontSize: 13 }}>
            <div><div className="kpi-label">First</div><b>{sel.day.first || "—"}</b></div>
            <div><div className="kpi-label">Last</div><b>{sel.day.last || "—"}</b></div>
            <div><div className="kpi-label">Between</div><b>{hm(sel.day.worked)}</b></div>
            <div><div className="kpi-label">Late in</div><b style={{ color: sel.day.late ? "var(--rebar)" : undefined }}>{sel.day.late ? `${sel.day.late} min` : "—"}</b></div>
            <div><div className="kpi-label">Early out</div><b style={{ color: sel.day.early ? "var(--rebar)" : undefined }}>{sel.day.early ? `${sel.day.early} min` : "—"}</b></div>
          </div>
          <div style={{ fontSize: 12.5, marginTop: 10 }}><span style={{ color: "var(--slate)" }}>All punches:</span> {sel.day.times.length ? sel.day.times.join(", ") : "none"}</div>
          {sel.day.flags.length > 0 && <div style={{ fontSize: 12.5, marginTop: 4, color: "var(--amber)" }}>{sel.day.flags.join(" · ")}</div>}
          {canRaise && sel.day.code && sel.day.code !== "P" && sel.day.code !== "WO" && sel.day.code !== "H" && !raising && (
            <button style={{ marginTop: 10 }} onClick={() => setRaising(true)}>Raise a correction for this day</button>
          )}
          {canRaise && ["A", "MIS", "NL", "HD"].includes(sel.day.code) && !sel.day.leave && !raising && !leaving && (
            <button style={{ marginTop: 10, marginLeft: 8 }} onClick={() => setLeaving(true)}>Record leave for this day</button>
          )}
          {leaving && (
            <LeaveForm types={meta.leave_types} fixed={{ employee_id: sel.emp.id, date: sel.day.date }} canApproveNow={can("hr.requests", "edit")}
              onDone={() => { setLeaving(false); setSel(null); reload(); }} onCancel={() => setLeaving(false)} />
          )}
          {raising && (
            <RequestForm employees={[{ id: sel.emp.id, name: sel.emp.name, emp_code: sel.emp.emp_code }]} fixed={{ employee_id: sel.emp.id, work_date: sel.day.date }}
              onDone={() => { setRaising(false); setSel(null); reload(); }} onCancel={() => setRaising(false)} />
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, color: "var(--slate)", marginTop: 12, alignItems: "center" }}>
        {Object.entries(CODE_STYLE).map(([k, v]) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ background: v.bg, color: v.fg, fontWeight: 700, borderRadius: 4, padding: "1px 5px" }}>{k === "HD" ? "½" : k}</span>{v.label}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: "var(--rebar)", display: "inline-block" }} />late in / early out</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: "var(--info)", display: "inline-block" }} />request waiting</span>
        <span>✓ corrected by an approved request</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>
        * Paid days so far = present + half days ÷ 2 + weekly offs + holidays + paid leave. Missed punches count as {meta.rules.missed_punch_at_lock === "half" ? "half days" : "absent"} when payroll is locked unless corrected; check-ins without location are not paid. A day runs 04:00 to 04:00.
      </div>
    </>
  );
}

// ================================================================ Employees
const EMPTY = {
  emp_code: "", name: "", mobile: "", department_id: "", designation: "", employment_type: "payroll", contractor_name: "",
  date_of_joining: "", date_of_leaving: "", attendance_source: "machine", machine_user_id: "", app_user_id: "",
  policy: "office", default_shift_id: "", weekly_off: "0", trip_allowance: false, notes: "",
  salary_basic: "", salary_da: "", salary_hra: "", salary_conveyance: "", salary_special: "", pf_applicable: true, esi_applicable: true,
  daily_rate: "", service_charge_pct: "", incentive_basis: "none", incentive_min_m3: "", incentive_rate: "",
  salesperson_id: "", ot_eligible: false, app_punch: "off",
};

function EmployeeForm({ meta, initial, onSaved, onCancel }) {
  const { can } = usePermissions();
  const [f, setF] = useState(() => {
    const base = { ...EMPTY };
    if (initial) for (const k of Object.keys(EMPTY)) if (initial[k] !== undefined && initial[k] !== null) base[k] = typeof EMPTY[k] === "boolean" ? !!initial[k] : String(initial[k]);
    if (!initial?.id && !base.default_shift_id && meta.shifts.length) {
      const office = meta.shifts.find((s) => s.is_active && /office/i.test(s.name)) || meta.shifts.find((s) => s.is_active);
      if (office) base.default_shift_id = String(office.id);
    }
    return base;
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const editing = !!initial?.id;

  const machineOptions = meta.machine_users.filter((u) => !u.employee_id || u.employee_id === initial?.id);
  const appOptions = meta.app_users.filter((u) => !u.employee_id || u.employee_id === initial?.id);
  const gross = ["salary_basic", "salary_da", "salary_hra", "salary_conveyance", "salary_special"].reduce((a, k) => a + Number(f[k] || 0), 0);

  async function save(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const body = { ...f };
      for (const k of ["department_id", "default_shift_id", "app_user_id", "salesperson_id"]) body[k] = body[k] === "" ? null : Number(body[k]);
      body.weekly_off = body.weekly_off === "" ? null : Number(body.weekly_off);
      if (body.attendance_source !== "machine") body.machine_user_id = null;
      if (editing) await apiRequest(`/hr/employees/${initial.id}`, { method: "PATCH", body });
      else await apiRequest(`/hr/employees`, { method: "POST", body });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 };
  const section = { fontSize: 11.5, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.5, margin: "18px 0 8px" };
  return (
    <form className="card" onSubmit={save} style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{editing ? `Edit ${initial.name}` : "Add employee"}</div>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>

      <div style={section}>Basic details</div>
      <div style={grid}>
        <Field label="Employee code *"><input value={f.emp_code} onChange={set("emp_code")} required maxLength={20} /></Field>
        <Field label="Name *"><input value={f.name} onChange={set("name")} required maxLength={120} /></Field>
        <Field label="Mobile"><input value={f.mobile} onChange={set("mobile")} inputMode="tel" maxLength={20} /></Field>
        <Field label="Department">
          <select value={f.department_id} onChange={set("department_id")}>
            <option value="">—</option>
            {meta.departments.filter((d) => d.is_active || String(d.id) === f.department_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Designation"><input value={f.designation} onChange={set("designation")} maxLength={80} /></Field>
        <Field label="Employment">
          <select value={f.employment_type} onChange={set("employment_type")}>
            <option value="payroll">On our payroll</option>
            <option value="contract">Contract (through a contractor)</option>
          </select>
        </Field>
        {f.employment_type === "contract" && <Field label="Contractor"><input value={f.contractor_name} onChange={set("contractor_name")} maxLength={120} /></Field>}
        <Field label="Date of joining"><input type="date" value={f.date_of_joining} onChange={set("date_of_joining")} /></Field>
        {editing && <Field label="Date of leaving" hint="Fill in when someone leaves — frees their machine number."><input type="date" value={f.date_of_leaving} onChange={set("date_of_leaving")} /></Field>}
      </div>

      <div style={section}>Attendance</div>
      <div style={grid}>
        <Field label="Attendance from">
          <select value={f.attendance_source} onChange={set("attendance_source")}>
            <option value="machine">Punching machine</option>
            <option value="app">Sales app check-in (with location)</option>
            <option value="none">Not tracked</option>
          </select>
        </Field>
        {f.attendance_source === "machine" && (
          <Field label="Machine number" hint="The number this person is enrolled under on the eSSL machine.">
            <select value={f.machine_user_id} onChange={set("machine_user_id")}>
              <option value="">— not linked yet —</option>
              {machineOptions.map((u) => (
                <option key={u.machine_user_id} value={u.machine_user_id}>
                  #{u.machine_user_id}{u.name_on_machine ? ` · ${u.name_on_machine}` : ""}{u.last_punch ? ` · last ${u.last_punch}` : " · never punched"}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={f.attendance_source === "app" ? "App login *" : "App login"} hint="Sales staff: their check-ins. Drivers: their trips, for trip allowance.">
          <select value={f.app_user_id} onChange={set("app_user_id")} required={f.attendance_source === "app"}>
            <option value="">— none —</option>
            {appOptions.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role.replace("_", " ")}</option>)}
          </select>
        </Field>
        {/* Round 202 — attendance on the phone: only with an app login, never drivers. */}
        <Field label="Attendance on the phone" hint={!f.app_user_id ? "Needs an app login." : appOptions.find((u) => String(u.id) === f.app_user_id)?.role === "driver" ? "Drivers use the gate machine." : "Face check + registered phone."}>
          <select value={f.app_user_id ? f.app_punch : "off"} onChange={set("app_punch")} disabled={!f.app_user_id || appOptions.find((u) => String(u.id) === f.app_user_id)?.role === "driver"}>
            <option value="off">Off — gate machine only</option>
            <option value="plant">At the plant (inside a work location)</option>
            <option value="anywhere">Anywhere — field / sales (location saved)</option>
          </select>
        </Field>
        <Field label="Timing">
          <select value={f.policy} onChange={set("policy")}>
            <option value="office">Office — fixed shift</option>
            <option value="operations">Operations — as rostered by the manager</option>
          </select>
        </Field>
        <Field label={f.policy === "office" ? "Shift" : "Usual shift (optional)"} hint={f.policy === "operations" ? "Used when the roster has nothing for a day. Leave empty to judge on hours only." : undefined}>
          <select value={f.default_shift_id} onChange={set("default_shift_id")}>
            <option value="">{f.policy === "office" ? "—" : "None — hours only"}</option>
            {meta.shifts.filter((s) => s.is_active || String(s.id) === f.default_shift_id).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time}–{s.end_time})</option>)}
          </select>
        </Field>
        <Field label="Weekly off">
          <select value={f.weekly_off} onChange={set("weekly_off")}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
            <option value="">No fixed weekly off</option>
          </select>
        </Field>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 18 }}>
          <input type="checkbox" checked={f.trip_allowance} onChange={set("trip_allowance")} /> Gets trip allowance in salary
        </label>
      </div>

      {meta.can_salary && (
        <>
          <div style={section}>Pay {!meta.can_salary_edit && <span style={{ textTransform: "none", fontWeight: 400 }}>(view only)</span>}</div>
          <fieldset disabled={!meta.can_salary_edit} style={{ border: "none", padding: 0, margin: 0 }}>
            {f.employment_type === "payroll" ? (
              <div style={grid}>
                <Field label="Basic (₹/month)"><input type="number" min="0" step="1" value={f.salary_basic} onChange={set("salary_basic")} /></Field>
                <Field label="DA"><input type="number" min="0" step="1" value={f.salary_da} onChange={set("salary_da")} /></Field>
                <Field label="HRA"><input type="number" min="0" step="1" value={f.salary_hra} onChange={set("salary_hra")} /></Field>
                <Field label="Conveyance"><input type="number" min="0" step="1" value={f.salary_conveyance} onChange={set("salary_conveyance")} /></Field>
                <Field label="Special allowance"><input type="number" min="0" step="1" value={f.salary_special} onChange={set("salary_special")} /></Field>
                <div style={{ fontSize: 13, alignSelf: "end", paddingBottom: 8 }}>Gross <b>{money(gross || null)}</b> / month</div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.pf_applicable} onChange={set("pf_applicable")} /> PF applies</label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.esi_applicable} onChange={set("esi_applicable")} /> ESI applies</label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.ot_eligible} onChange={set("ot_eligible")} /> Paid overtime</label>
              </div>
            ) : (
              <div style={grid}>
                <Field label="Daily rate (₹)"><input type="number" min="0" step="1" value={f.daily_rate} onChange={set("daily_rate")} /></Field>
                <Field label="Contractor's service charge (%)"><input type="number" min="0" step="0.5" value={f.service_charge_pct} onChange={set("service_charge_pct")} /></Field>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.ot_eligible} onChange={set("ot_eligible")} /> Paid overtime</label>
              </div>
            )}
            <div style={{ ...grid, marginTop: 12 }}>
              <Field label="Sales incentive">
                <select value={f.incentive_basis} onChange={set("incentive_basis")}>
                  <option value="none">None</option>
                  <option value="own_production">Salesperson — own customers' production above a minimum</option>
                  <option value="plant_production">Manager / management — whole plant production above a minimum</option>
                  <option value="own_sales_paid">Per m³ of sales he/she brought, once the customer has paid</option>
                </select>
              </Field>
              {f.incentive_basis !== "none" && (
                <>
                  {f.incentive_basis !== "plant_production" && (
                    <Field label="Salesperson (as on orders) *" hint="Orders booked under this salesperson count as his/hers.">
                      <select value={f.salesperson_id} onChange={set("salesperson_id")}>
                        <option value="">—</option>
                        {meta.salespersons.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                      </select>
                    </Field>
                  )}
                  <Field label={f.incentive_basis === "own_sales_paid" ? "Minimum m³ (optional)" : "Minimum m³ in the month"} hint="No incentive until this is reached.">
                    <input type="number" min="0" step="1" value={f.incentive_min_m3} onChange={set("incentive_min_m3")} />
                  </Field>
                  <Field label={f.incentive_basis === "own_sales_paid" ? "₹ per m³ paid for" : "₹ per m³ above the minimum"}>
                    <input type="number" min="0" step="0.5" value={f.incentive_rate} onChange={set("incentive_rate")} />
                  </Field>
                </>
              )}
            </div>
          </fieldset>
        </>
      )}

      <div style={{ ...grid, marginTop: 12 }}>
        <Field label="Notes" span><textarea rows={2} value={f.notes} onChange={set("notes")} /></Field>
      </div>
      {initial?.id && f.app_user_id && f.app_punch !== "off" && <FacePanel employee={initial} canEdit={can("hr.employees", "edit")} />}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add employee"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function EmployeesTab({ meta, reloadMeta }) {
  const { can } = usePermissions();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | {} (new) | row
  const [showLeft, setShowLeft] = useState(false);
  const load = () => apiRequest("/hr/employees").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const unlinked = meta.machine_users.filter((u) => !u.employee_id && u.last_punch);
  const list = (rows || []).filter((r) => showLeft || r.is_active);

  return (
    <>
      {editing ? (
        <EmployeeForm meta={meta} initial={editing.id ? editing : editing.prefill ? { ...EMPTY, ...editing.prefill } : null}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); reloadMeta(); }} />
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          {can("hr.employees", "create") && <button className="btn-primary" onClick={() => setEditing({})}>+ Add employee</button>}
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} /> Show people who have left</label>
        </div>
      )}

      {!editing && unlinked.length > 0 && can("hr.employees", "create") && (
        <div className="card" style={{ marginBottom: 16, background: "var(--amber-bg)", borderColor: "#E7D8AE" }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{unlinked.length} machine number{unlinked.length > 1 ? "s" : ""} punching but not linked to an employee</div>
          <div style={{ fontSize: 12, color: "var(--slate)", margin: "4px 0 8px" }}>Tap one to add that person — the machine number is filled in for you.</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {unlinked.map((u) => (
              <button key={u.machine_user_id} style={{ padding: "6px 10px", fontSize: 12 }}
                onClick={() => setEditing({ prefill: { machine_user_id: u.machine_user_id, name: u.name_on_machine || "", emp_code: "" } })}>
                #{u.machine_user_id}{u.name_on_machine ? ` ${u.name_on_machine}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {rows && !list.length && !editing && <div className="card" style={{ fontSize: 13 }}>No employees yet.</div>}
      {rows && list.length > 0 && (
        <div className="card" style={{ padding: "4px 12px" }}>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Attendance</th><th>Timing</th>{meta.can_salary && <th style={{ textAlign: "right" }}>Pay</th>}<th></th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} style={{ opacity: r.is_active ? 1 : 0.55 }}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.emp_code}</td>
                    <td><div style={{ fontWeight: 600 }}>{r.name}</div><div style={{ fontSize: 11, color: "var(--slate)" }}>{r.designation || ""}{r.employment_type === "contract" ? ` · contract${r.contractor_name ? " — " + r.contractor_name : ""}` : ""}{!r.is_active ? " · left" : ""}</div></td>
                    <td style={{ fontSize: 12.5 }}>{r.department || "—"}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {r.attendance_source === "machine" ? (r.machine_user_id ? <>Machine #{r.machine_user_id}{r.name_on_machine ? <span style={{ color: "var(--slate)" }}> · {r.name_on_machine}</span> : null}</> : <span className="badge badge-danger">not linked</span>)
                        : r.attendance_source === "app" ? <>App{r.app_user_name ? ` · ${r.app_user_name}` : ""}</> : "Not tracked"}
                      {r.trip_allowance && <span className="chip" style={{ marginLeft: 6 }}>trip allowance</span>}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{r.policy === "office" ? (r.default_shift_name || "Office") : `Operations${r.default_shift_name ? " · " + r.default_shift_name : ""}`}</td>
                    {meta.can_salary && (
                      <td style={{ textAlign: "right", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
                        {r.employment_type === "contract" ? (r.daily_rate ? `${money(r.daily_rate)}/day` : "—") : money(r.gross_monthly)}
                        {r.incentive_basis && r.incentive_basis !== "none" && <div style={{ fontSize: 11, color: "var(--slate)" }}>+ incentive</div>}
                      </td>
                    )}
                    <td>{can("hr.employees", "edit") && <button style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => { setEditing(r); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button>}</td>
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

// ================================================================ Roster
function RosterTab({ meta }) {
  const { can } = usePermissions();
  const canEdit = can("hr.roster", "edit");
  const [from, setFrom] = useState(mondayOf(istDay()));
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({}); // "emp|date" -> "" (clear) | "off" | shiftId
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const to = addDays(from, 6);

  function load(start = from) {
    setData(null); setDraft({}); setError("");
    apiRequest(`/hr/roster?from=${start}&to=${addDays(start, 6)}`).then(setData).catch((e) => setError(e.message));
  }
  useEffect(() => { load(from); }, [from]);

  const saved = useMemo(() => {
    const m = {};
    for (const e of data?.entries || []) m[e.employee_id + "|" + e.work_date] = e.is_off ? "off" : String(e.shift_id);
    return m;
  }, [data]);
  const value = (k) => (k in draft ? draft[k] : saved[k] || "");
  const dirty = Object.keys(draft).filter((k) => (draft[k] || "") !== (saved[k] || ""));

  async function copyLastWeek() {
    try {
      const prev = await apiRequest(`/hr/roster?from=${addDays(from, -7)}&to=${addDays(from, -1)}`);
      const next = { ...draft };
      for (const e of prev.entries) next[e.employee_id + "|" + addDays(e.work_date, 7)] = e.is_off ? "off" : String(e.shift_id);
      setDraft(next);
      setNotice(prev.entries.length ? "Last week copied — check it, then Save." : "Last week has nothing on the roster.");
    } catch (err) { setError(err.message); }
  }
  async function save() {
    setSaving(true); setError(""); setNotice("");
    try {
      const entries = dirty.map((k) => {
        const [employee_id, work_date] = k.split("|");
        const v = draft[k];
        return v === "" ? { employee_id: Number(employee_id), work_date, clear: true }
          : v === "off" ? { employee_id: Number(employee_id), work_date, is_off: true }
          : { employee_id: Number(employee_id), work_date, shift_id: Number(v) };
      });
      const r = await apiRequest("/hr/roster", { method: "PUT", body: { entries } });
      setNotice(`Saved ${r.saved} change${r.saved === 1 ? "" : "s"}.`);
      load(from);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  const shifts = meta.shifts.filter((s) => s.is_active);
  const dates = data?.dates || [];
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <button onClick={() => setFrom(addDays(from, -7))} aria-label="Previous week">&larr;</button>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
          {new Date(from + "T12:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – {new Date(to + "T12:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
        </div>
        <button onClick={() => setFrom(addDays(from, 7))} aria-label="Next week">&rarr;</button>
        {canEdit && <button onClick={copyLastWeek}>Copy last week</button>}
        {canEdit && <button className="btn-primary" disabled={!dirty.length || saving} onClick={save}>{saving ? "Saving…" : `Save${dirty.length ? ` (${dirty.length})` : ""}`}</button>}
      </div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
        Operations staff only. Pick each person's shift for the day, or Off. A blank day is judged on hours worked (7 h full, 4 h half) with no late marks.
        {shifts.length < 2 && " Add your operations shifts (e.g. Day 8 to 8, Night) under Settings first."}
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}
      {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && !data.employees.length && <div className="card" style={{ fontSize: 13 }}>No employees are set to <b>Operations</b> timing yet. Set it on their employee record.</div>}
      {data && data.employees.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ padding: "8px 10px", minWidth: 150 }}>Employee</th>
                  {dates.map((d) => {
                    const hol = meta.holidays.find((h) => h.holiday_date === d);
                    return <th key={d} title={hol?.name || ""} style={{ textAlign: "center", minWidth: 110, textTransform: "none", background: hol ? "#F3F1EC" : undefined }}>{DOW[new Date(d + "T12:00:00+05:30").getDay()]} {Number(d.slice(8))}{hol ? " · H" : ""}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {data.employees.map((e) => (
                  <tr key={e.id}>
                    <td style={{ padding: "6px 10px" }}><div style={{ fontWeight: 600 }}>{e.name}</div><div style={{ fontSize: 11, color: "var(--slate)" }}>{e.department || ""}</div></td>
                    {dates.map((d) => {
                      const k = e.id + "|" + d;
                      const v = value(k);
                      const changed = k in draft && (draft[k] || "") !== (saved[k] || "");
                      return (
                        <td key={d} style={{ padding: 3 }} className="field-input">
                          <select value={v} disabled={!canEdit} onChange={(ev) => setDraft((x) => ({ ...x, [k]: ev.target.value }))}
                            style={{ padding: "6px 4px", fontSize: 12, background: v === "off" ? "#ECEAE4" : v ? "var(--info-bg)" : undefined, outline: changed ? "2px solid var(--rebar)" : undefined }}>
                            <option value="">—</option>
                            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            <option value="off">Off</option>
                          </select>
                        </td>
                      );
                    })}
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

// ================================================================ Settings
function SettingsTab({ meta, reloadMeta }) {
  const { can } = usePermissions();
  const canCreate = can("hr.settings", "create"), canEdit = can("hr.settings", "edit"), canDelete = can("hr.settings", "delete");
  const [error, setError] = useState("");
  const [dep, setDep] = useState({ name: "", is_direct: true });
  const [shift, setShift] = useState(null);
  const [hol, setHol] = useState({ holiday_date: "", name: "" });

  const run = async (fn) => { setError(""); try { await fn(); reloadMeta(); } catch (err) { setError(err.message); } };
  const blankShift = { name: "", start_time: "08:00", end_time: "20:00", grace_min: 10, full_day_hours: 7, half_day_hours: 4, is_active: true };

  return (
    <>
      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <RulesCard meta={meta} canEdit={canEdit} onSaved={reloadMeta} />
      <LeaveTypesCard meta={meta} canEdit={canEdit} canCreate={canCreate} onSaved={reloadMeta} />
      <WorkLocationsCard canEdit={canEdit} canCreate={canCreate} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Shifts</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Late in / early out beyond the grace minutes is highlighted for the Administrator — nothing is deducted automatically.</div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Shift</th><th>Time</th><th>Grace</th><th>Full day</th><th>Half day</th><th></th></tr></thead>
            <tbody>
              {meta.shifts.map((s) => (
                <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 600 }}>{s.name}{!s.is_active && " (off)"}</td>
                  <td>{s.start_time}–{s.end_time}{s.end_time <= s.start_time ? " (next day)" : ""}</td>
                  <td>{s.grace_min} min</td>
                  <td>{hm(s.full_day_min)}</td>
                  <td>{hm(s.half_day_min)}</td>
                  <td>{canEdit && <button style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setShift({ ...s, full_day_hours: s.full_day_min / 60, half_day_hours: s.half_day_min / 60 })}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shift ? (
          <form onSubmit={(e) => { e.preventDefault(); run(async () => {
              if (shift.id) await apiRequest(`/hr/shifts/${shift.id}`, { method: "PATCH", body: shift });
              else await apiRequest(`/hr/shifts`, { method: "POST", body: shift });
              setShift(null);
            }); }}
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 12, alignItems: "end" }}>
            <Field label="Name"><input value={shift.name} onChange={(e) => setShift({ ...shift, name: e.target.value })} required /></Field>
            <Field label="Start"><input type="time" value={shift.start_time} onChange={(e) => setShift({ ...shift, start_time: e.target.value })} required /></Field>
            <Field label="End"><input type="time" value={shift.end_time} onChange={(e) => setShift({ ...shift, end_time: e.target.value })} required /></Field>
            <Field label="Grace (min)"><input type="number" min="0" max="180" value={shift.grace_min} onChange={(e) => setShift({ ...shift, grace_min: Number(e.target.value) })} /></Field>
            <Field label="Full day (hours)"><input type="number" min="1" max="24" step="0.5" value={shift.full_day_hours} onChange={(e) => setShift({ ...shift, full_day_hours: e.target.value })} /></Field>
            <Field label="Half day (hours)"><input type="number" min="0.5" max="24" step="0.5" value={shift.half_day_hours} onChange={(e) => setShift({ ...shift, half_day_hours: e.target.value })} /></Field>
            {shift.id && <label style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center" }}><input type="checkbox" checked={shift.is_active} onChange={(e) => setShift({ ...shift, is_active: e.target.checked })} /> In use</label>}
            <div style={{ display: "flex", gap: 6 }}><button type="submit" className="btn-primary">Save</button><button type="button" onClick={() => setShift(null)}>Cancel</button></div>
          </form>
        ) : canCreate && <button style={{ marginTop: 10 }} onClick={() => setShift(blankShift)}>+ Add shift</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Holidays</div>
        {meta.holidays.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>None added.</div>}
        {meta.holidays.map((h) => (
          <div key={h.holiday_date} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
            <span><b>{new Date(h.holiday_date + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</b> · {h.name}</span>
            {canDelete && <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => run(() => apiRequest(`/hr/holidays/${h.holiday_date}`, { method: "DELETE" }))}>Remove</button>}
          </div>
        ))}
        {canCreate && (
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { await apiRequest("/hr/holidays", { method: "POST", body: hol }); setHol({ holiday_date: "", name: "" }); }); }}
            style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
            <Field label="Date"><input type="date" value={hol.holiday_date} onChange={(e) => setHol({ ...hol, holiday_date: e.target.value })} required /></Field>
            <Field label="Name"><input value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} placeholder="e.g. Diwali" required /></Field>
            <button type="submit">Add holiday</button>
          </form>
        )}
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Departments</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>"Direct" departments make or deliver concrete — used later to split manpower cost.</div>
        {meta.departments.map((d) => (
          <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13, opacity: d.is_active ? 1 : 0.5 }}>
            <span><b>{d.name}</b> · {d.is_direct ? "Direct" : "Indirect"}{!d.is_active && " · not in use"}</span>
            {canEdit && (
              <span style={{ display: "flex", gap: 6 }}>
                <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => run(() => apiRequest(`/hr/departments/${d.id}`, { method: "PATCH", body: { ...d, is_direct: !d.is_direct } }))}>Make {d.is_direct ? "indirect" : "direct"}</button>
                <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => {
                  const name = window.prompt("Rename department", d.name);
                  if (name && name.trim() !== d.name) run(() => apiRequest(`/hr/departments/${d.id}`, { method: "PATCH", body: { ...d, name } }));
                }}>Rename</button>
                <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => run(() => apiRequest(`/hr/departments/${d.id}`, { method: "PATCH", body: { ...d, is_active: !d.is_active } }))}>{d.is_active ? "Stop using" : "Use again"}</button>
              </span>
            )}
          </div>
        ))}
        {canCreate && (
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { await apiRequest("/hr/departments", { method: "POST", body: dep }); setDep({ name: "", is_direct: true }); }); }}
            style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
            <Field label="New department"><input value={dep.name} onChange={(e) => setDep({ ...dep, name: e.target.value })} required /></Field>
            <label style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center", paddingBottom: 8 }}><input type="checkbox" checked={dep.is_direct} onChange={(e) => setDep({ ...dep, is_direct: e.target.checked })} /> Direct</label>
            <button type="submit">Add</button>
          </form>
        )}
      </div>
    </>
  );
}

// ================================================================ page
export default function HrModule() {
  const { can, ready } = usePermissions();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("");
  const loadMeta = () => apiRequest("/hr/meta").then(setMeta).catch((e) => setError(e.message));
  useEffect(() => { loadMeta(); }, []);

  const tabs = [
    ["today", "Today", can("hr.attendance", "view")],
    ["attendance", "Attendance", can("hr.attendance", "view")],
    ["employees", "Employees", can("hr.employees", "view")],
    ["requests", "Requests", can("hr.requests", "view")],
    ["leave", "Leave", can("hr.requests", "view")],
    ["compoff", "Comp-off", can("hr.requests", "view")],
    ["roster", "Roster", can("hr.roster", "view")],
    ["payroll", "Payroll", can("hr.payroll", "view")],
    ["advances", "Advances", can("hr.advances", "view")],
    ["settings", "Settings", can("hr.settings", "view")],
  ].filter((t) => t[2]);
  const current = tab || tabs[0]?.[0];

  if (!ready) return null;
  return (
    <>
      <TopBar title="HR" />
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {tabs.map(([k, l]) => <button key={k} className={`btn-tab${current === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
          {can("admin.attendance-machine", "view") && <button className="btn-tab" onClick={() => navigate("/attendance-machine")}>Attendance machine &rarr;</button>}
        </div>
        {!tabs.length && <div className="card" style={{ fontSize: 13 }}>You don&rsquo;t have access to any part of HR. A Super Admin can grant it on the Access Control page.</div>}
        {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
        {meta && current === "today" && <TodayTab meta={meta} />}
        {meta && current === "attendance" && <AttendanceTab meta={meta} />}
        {meta && current === "employees" && <EmployeesTab meta={meta} reloadMeta={loadMeta} />}
        {meta && current === "roster" && <RosterTab meta={meta} />}
        {meta && current === "requests" && <><PhonePunchReview /><RequestsTab meta={meta} /></>}
        {meta && current === "compoff" && <CompOffTab meta={meta} />}
        {meta && current === "leave" && <LeaveTab meta={meta} />}
        {meta && current === "payroll" && <PayrollTab meta={meta} />}
        {meta && current === "advances" && <AdvancesTab />}
        {meta && current === "settings" && <SettingsTab meta={meta} reloadMeta={loadMeta} />}
      </div>
    </>
  );
}
