// Round 211 — contract labour in HR (owner, 15 Oct 2026): pump gangs and
// their members, the month register with Admin's deductions, the gang chosen
// on each pump order, contractors, and contractor bills with GST / TDS,
// payments and the ledger. Server: routes/contractLabour.js.
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { todayStr } from "../lib/istDate.js";

const money = (v) => (v == null || v === "" ? "—" : (Number(v) < 0 ? "−₹" : "₹") + Math.abs(Math.round(Number(v))).toLocaleString("en-IN"));
const thisMonth = () => todayStr().slice(0, 7);
function prevMonth(m) {
  const [y, mm] = m.split("-").map(Number);
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
}
const MODES = { bank_transfer: "Bank transfer", upi: "UPI", cheque: "Cheque", cash: "Cash" };
const TH = { padding: "7px 8px", textAlign: "left", fontWeight: 600, fontSize: 11.5, color: "var(--slate)", whiteSpace: "nowrap" };
const TD = { padding: "7px 8px", verticalAlign: "top" };

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", fontWeight: 600 }}>
      {label}
      {children}
      {hint && <span style={{ fontWeight: 400, fontSize: 11 }}>{hint}</span>}
    </label>
  );
}
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 };
function Err({ text }) { return text ? <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{text}</div> : null; }

// Day codes, as lib/gangs.js sets them.
export const GANG_CODE = {
  P: ["P", "#E5F2EA", "#2F7A4D", "present, pump order"],
  I: ["I", "#F1EEDF", "#6B5A1E", "present, no pump order — paid"],
  A: ["A", "#B3261E", "#FFFFFF", "away on a pump day"],
  "-": ["–", "#ECEAE4", "#6B7178", "no pump order, didn't come — not away"],
  "?": ["?", "#FBF1DC", "#8A5A00", "not in yet today"],
  "": ["", "transparent", "#22262B", ""],
};

// =================================================================== the tab
export function ContractLabourTab() {
  const { can } = usePermissions();
  const [view, setView] = useState("gangs");
  const views = [["gangs", "Gangs"], ["register", "Month register"], ["orders", "Gang on pump orders"], ["contractors", "Contractors"]];
  return (
    <>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {views.map(([k, l]) => <button key={k} className={`btn-tab${view === k ? " active" : ""}`} style={{ fontSize: 13 }} onClick={() => setView(k)}>{l}</button>)}
        {can("hr.gang-attendance", "edit") && <Link to="/gang-attendance" style={{ marginLeft: 8, fontSize: 13, fontWeight: 600 }}>Confirm today's crew →</Link>}
      </div>
      {view === "gangs" && <GangsView />}
      {view === "register" && <RegisterView />}
      {view === "orders" && <PumpOrdersView />}
      {view === "contractors" && <ContractorsView />}
    </>
  );
}

// ================================================================== gangs
function GangsView() {
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // gang object or "new"
  const [contractors, setContractors] = useState([]);
  const load = () => apiRequest("/contract-labour/gangs").then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); apiRequest("/contract-labour/contractors").then(setContractors).catch(() => {}); }, []);
  if (error) return <div className="card"><Err text={error} /></div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  if (editing) return <GangEditor gang={editing === "new" ? null : data.gangs.find((g) => g.id === editing)} contractors={contractors}
    onDone={() => { setEditing(null); load(); }} onChanged={load} />;
  const total = data.gangs.reduce((a, g) => a + (g.monthly_total || 0), 0);
  const men = data.gangs.reduce((a, g) => a + g.members.filter((m) => !m.to_date).length, 0);
  const punched = data.gangs.reduce((a, g) => a + (g.today?.punched || 0), 0);
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 12 }}>
        <div className="card"><div className="kpi-label">Gangs</div><div style={{ fontSize: 22, fontWeight: 700 }}>{data.gangs.length}</div><div style={{ fontSize: 12, color: "var(--slate)" }}>{men} men</div></div>
        <div className="card"><div className="kpi-label">Punched in today</div><div style={{ fontSize: 22, fontWeight: 700 }}>{punched} <span style={{ fontSize: 14, color: "var(--slate)", fontWeight: 500 }}>of {men}</span></div></div>
        <div className="card"><div className="kpi-label">Confirmed today</div><div style={{ fontSize: 22, fontWeight: 700 }}>{data.gangs.filter((g) => g.today?.confirmed).length} <span style={{ fontSize: 14, color: "var(--slate)", fontWeight: 500 }}>of {data.gangs.length} gangs</span></div></div>
        {total > 0 && <div className="card"><div className="kpi-label">Monthly total</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(total)}</div><div style={{ fontSize: 12, color: "var(--slate)" }}>before deductions and GST</div></div>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Pump gangs · today {data.date}</div>
          {can("hr.gangs", "create") && <button className="btn-primary" onClick={() => setEditing("new")} disabled={!contractors.length} title={contractors.length ? "" : "Add a contractor first"}>+ New gang</button>}
        </div>
        {!contractors.length && <div style={{ padding: "0 14px 12px", fontSize: 13, color: "var(--slate)" }}>Add the labour contractor first (Contractors), then the gang.</div>}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
            <thead><tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Gang</th><th style={TH}>Contractor</th><th style={{ ...TH, textAlign: "right" }}>Men</th>
              {data.gangs.some((g) => g.monthly_total != null) && <th style={{ ...TH, textAlign: "right" }}>Monthly</th>}
              <th style={TH}>Today</th><th style={TH}>Pump orders today</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {data.gangs.map((g) => {
                const open = g.members.filter((m) => !m.to_date);
                const leader = open.find((m) => m.is_leader);
                return (
                  <tr key={g.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={TD}><b>{g.name}</b><div style={{ fontSize: 12, color: "var(--slate)" }}>{[g.location, leader && `leader ${leader.name}`].filter(Boolean).join(" · ")}</div></td>
                    <td style={TD}>{g.contractor_name}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{open.length}{g.min_crew ? <span style={{ color: "var(--slate)" }}> (min {g.min_crew})</span> : null}</td>
                    {g.monthly_total != null && <td style={{ ...TD, textAlign: "right" }}>{money(g.monthly_total)}</td>}
                    <td style={TD}>
                      <span style={{ fontWeight: 600 }}>{g.today?.punched ?? 0} of {open.length} punched</span>
                      <div style={{ fontSize: 12, color: g.today?.confirmed ? "var(--signal-green)" : "#8A5A00" }}>{g.today?.confirmed ? `confirmed ${g.today.confirmed.confirmed_at} by ${g.today.confirmed.confirmed_by_name}` : "not confirmed"}</div>
                    </td>
                    <td style={TD}>{g.today?.orders?.length ? g.today.orders.map((o) => <div key={o.id} style={{ fontSize: 12 }}>{o.time} · {o.customer_name} · {o.pump_code || "pump"}</div>) : <span style={{ fontSize: 12, color: "var(--slate)" }}>none — no-pump day</span>}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{can("hr.gangs", "edit") && <button onClick={() => setEditing(g.id)}>Edit</button>}</td>
                  </tr>
                );
              })}
              {!data.gangs.length && <tr><td colSpan={7} style={{ ...TD, color: "var(--slate)" }}>No gangs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card" style={{ marginTop: 12, fontSize: 12.5, color: "var(--slate)", lineHeight: 1.6 }}>
        <b style={{ color: "var(--charcoal)" }}>How a gang month works.</b> Members punch the gate machine each morning; the Site Supervisor confirms each gang's crew and
        adds any substitute. The gang is chosen on each pump order — a day the gang has no order is a no-pump day: whoever punched is present and paid, whoever didn't is not counted as away.
        At month end Admin looks at each member's away days and decides any deduction, then closes the month; the contractor's bill is made from it.
      </div>
    </>
  );
}

const EMPTY_GANG = { name: "", contractor_id: "", location: "", min_crew: "", notes: "", is_active: true };
const EMPTY_MEMBER = { name: "", machine_user_id: "", mobile: "", role: "Helper", monthly_rate: "", is_leader: false, from_date: "" };
function GangEditor({ gang, contractors, onDone, onChanged }) {
  const { can } = usePermissions();
  const [f, setF] = useState(() => gang ? { name: gang.name, contractor_id: String(gang.contractor_id), location: gang.location || "", min_crew: gang.min_crew ?? "", notes: gang.notes || "", is_active: gang.is_active } : { ...EMPTY_GANG, contractor_id: contractors[0] ? String(contractors[0].id) : "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState(null);
  const [edit, setEdit] = useState(null);
  const [ending, setEnding] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  async function save() {
    setBusy(true); setError("");
    try {
      if (gang) await apiRequest(`/contract-labour/gangs/${gang.id}`, { method: "PUT", body: f });
      else await apiRequest("/contract-labour/gangs", { method: "POST", body: f });
      onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function run(fn) {
    setBusy(true); setError("");
    try { await fn(); onChanged(); setAdd(null); setEdit(null); setEnding(null); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const members = gang ? gang.members : [];
  const open = members.filter((m) => !m.to_date);
  const total = open.reduce((a, m) => a + (Number(m.monthly_rate) || 0), 0);
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{gang ? `Edit ${gang.name}` : "New gang"}</div>
        <button onClick={onDone}>← Back to gangs</button>
      </div>
      <div style={grid}>
        <Field label="Gang name"><input value={f.name} onChange={set("name")} maxLength={60} placeholder="Gang A" /></Field>
        <Field label="Contractor">
          <select value={f.contractor_id} onChange={set("contractor_id")}>
            <option value="">—</option>
            {contractors.filter((c) => c.is_active || String(c.id) === f.contractor_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Location" hint="Where the gang reports. Not a pump — the gang is chosen on each order."><input value={f.location} onChange={set("location")} maxLength={80} placeholder="Main plant" /></Field>
        <Field label="Minimum crew to run a pump" hint="Below this on a pump day, it's flagged."><input type="number" min="1" value={f.min_crew} onChange={set("min_crew")} /></Field>
        <Field label="Notes"><input value={f.notes} onChange={set("notes")} maxLength={500} /></Field>
        {gang && <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.is_active} onChange={set("is_active")} /> Active</label>}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button className="btn-primary" disabled={busy} onClick={save}>{gang ? "Save gang" : "Create gang"}</button>
      </div>
      {gang && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 20, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontWeight: 700 }}>Members · {open.length}{total ? <span style={{ fontWeight: 400, color: "var(--slate)" }}> · gang total {money(total)} / month</span> : null}</div>
            {can("hr.gangs", "create") && !add && <button onClick={() => setAdd({ ...EMPTY_MEMBER, from_date: todayStr() })}>+ Add member</button>}
          </div>
          {add && (
            <div style={{ background: "var(--concrete)", borderRadius: 10, padding: 12, marginTop: 8 }}>
              <div style={grid}>
                <Field label="Name"><input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} maxLength={120} /></Field>
                <Field label="Machine ID" hint="The number he is enrolled under on the gate machine."><input value={add.machine_user_id} onChange={(e) => setAdd({ ...add, machine_user_id: e.target.value })} maxLength={30} /></Field>
                <Field label="Role"><input value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })} maxLength={40} /></Field>
                <Field label="Monthly rate (₹)"><input type="number" min="0" value={add.monthly_rate} onChange={(e) => setAdd({ ...add, monthly_rate: e.target.value })} /></Field>
                <Field label="Mobile"><input value={add.mobile} onChange={(e) => setAdd({ ...add, mobile: e.target.value })} maxLength={20} /></Field>
                <Field label="In the gang from"><input type="date" value={add.from_date} onChange={(e) => setAdd({ ...add, from_date: e.target.value })} /></Field>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={add.is_leader} onChange={(e) => setAdd({ ...add, is_leader: e.target.checked })} /> Gang leader</label>
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                <button className="btn-primary" disabled={busy} onClick={() => run(() => apiRequest(`/contract-labour/gangs/${gang.id}/members`, { method: "POST", body: add }))}>Add</button>
                <button onClick={() => setAdd(null)}>Cancel</button>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>He is added to HR as a contract worker of this gang's contractor, so the machine counts him. He is not paid through payroll — the gang's monthly amount goes on the contractor's bill.</div>
            </div>
          )}
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 680 }}>
              <thead><tr><th style={TH}>Name</th><th style={TH}>Role</th><th style={{ ...TH, textAlign: "right" }}>Monthly rate</th><th style={TH}>Machine ID</th><th style={TH}>In gang</th><th style={TH}></th></tr></thead>
              <tbody>
                {members.map((m) => (
                  <Fragment key={m.membership_id}>
                    <tr style={{ borderTop: "1px solid var(--border)", color: m.to_date ? "var(--slate)" : undefined }}>
                      <td style={TD}><b>{m.name}</b> {m.is_leader && <span className="badge badge-warning" style={{ fontSize: 10.5 }}>Leader</span>}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{m.emp_code}</div></td>
                      <td style={TD}>{m.role || "—"}</td>
                      <td style={{ ...TD, textAlign: "right" }}>{money(m.monthly_rate)}</td>
                      <td style={TD}>{m.machine_user_id || <span style={{ color: "var(--alert-red)" }}>not set</span>}</td>
                      <td style={TD}>{m.from_date}{m.to_date ? ` → ${m.to_date}` : " →"}</td>
                      <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap" }}>
                        {!m.to_date && can("hr.gangs", "edit") && <>
                          <button style={{ fontSize: 12 }} onClick={() => setEdit({ id: m.membership_id, monthly_rate: m.monthly_rate, is_leader: m.is_leader, role: m.role || "", machine_user_id: m.machine_user_id || "" })}>Edit</button>{" "}
                          <button style={{ fontSize: 12 }} onClick={() => setEnding({ id: m.membership_id, to_date: todayStr(), left: false, name: m.name })}>End</button>
                        </>}
                      </td>
                    </tr>
                    {edit?.id === m.membership_id && (
                      <tr><td colSpan={6} style={{ padding: 10, background: "var(--concrete)" }}>
                        <div style={grid}>
                          <Field label="Monthly rate (₹)"><input type="number" min="0" value={edit.monthly_rate} onChange={(e) => setEdit({ ...edit, monthly_rate: e.target.value })} /></Field>
                          <Field label="Role"><input value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} /></Field>
                          <Field label="Machine ID"><input value={edit.machine_user_id} onChange={(e) => setEdit({ ...edit, machine_user_id: e.target.value })} /></Field>
                          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={edit.is_leader} onChange={(e) => setEdit({ ...edit, is_leader: e.target.checked })} /> Gang leader</label>
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                          <button className="btn-primary" disabled={busy} onClick={() => run(() => apiRequest(`/contract-labour/gangs/${gang.id}/members/${m.membership_id}`, { method: "PUT", body: edit }))}>Save</button>
                          <button onClick={() => setEdit(null)}>Cancel</button>
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>A new rate applies to every month not yet closed.</div>
                      </td></tr>
                    )}
                    {ending?.id === m.membership_id && (
                      <tr><td colSpan={6} style={{ padding: 10, background: "var(--concrete)" }}>
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
                          <Field label={`Last day of ${ending.name} in the gang`}><input type="date" value={ending.to_date} onChange={(e) => setEnding({ ...ending, to_date: e.target.value })} /></Field>
                          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={ending.left} onChange={(e) => setEnding({ ...ending, left: e.target.checked })} /> He has left (also ends him as an employee)</label>
                          <button className="btn-primary" disabled={busy} onClick={() => run(() => apiRequest(`/contract-labour/gangs/${gang.id}/members/${m.membership_id}/end`, { method: "POST", body: ending }))}>End</button>
                          <button onClick={() => setEnding(null)}>Cancel</button>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
                {!members.length && <tr><td colSpan={6} style={{ ...TD, color: "var(--slate)" }}>No members yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Err text={error} />
    </div>
  );
}

// ========================================================== month register
function RegisterView() {
  const { can } = usePermissions();
  const [gangs, setGangs] = useState(null);
  const [gangId, setGangId] = useState("");
  const [month, setMonth] = useState(() => (todayStr().slice(8) <= "05" ? prevMonth(thisMonth()) : thisMonth()));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [ded, setDed] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiRequest("/contract-labour/gangs?all=1").then((d) => { setGangs(d.gangs); if (d.gangs[0]) setGangId(String(d.gangs[0].id)); }).catch((e) => setError(e.message));
  }, []);
  const load = () => {
    if (!gangId || !/^\d{4}-\d{2}$/.test(month)) return;
    setData(null); setError("");
    apiRequest(`/contract-labour/gangs/${gangId}/month/${month}`).then((d) => {
      setData(d);
      setDed(Object.fromEntries(d.members.map((m) => [m.employee_id, { days: m.deduction ? String(m.deduction.days) : "", note: m.deduction?.note || "" }])));
    }).catch((e) => setError(e.message));
  };
  useEffect(load, [gangId, month]);
  async function run(fn) {
    setBusy(true); setError("");
    try { await fn(); load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const dows = ["S", "M", "T", "W", "T", "F", "S"];
  const canDecide = data?.can_decide && !data?.closed;
  const preview = useMemo(() => {
    if (!data) return 0;
    return data.members.reduce((a, m) => a + Math.round((Number(ded[m.employee_id]?.days) || 0) * m.monthly_rate / data.days_in_month), 0);
  }, [data, ded]);
  if (gangs && !gangs.length) return <div className="card" style={{ fontSize: 13 }}>No gangs yet.</div>;
  return (
    <>
      <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginBottom: 12 }}>
        <Field label="Gang">
          <select value={gangId} onChange={(e) => setGangId(e.target.value)}>
            {(gangs || []).map((g) => <option key={g.id} value={g.id}>{g.name}{g.is_active ? "" : " (closed)"}</option>)}
          </select>
        </Field>
        <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        {data?.closed && <span className="badge badge-success">Closed {data.closed.closed_on} by {data.closed.closed_by_name}</span>}
        {data && !data.closed && <span className="badge badge-warning">{data.finished ? "Ready to close" : "Month in progress"}</span>}
      </div>
      <Err text={error} />
      {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 8 }}>
              {data.gang.name} · {data.gang.contractor_name} · {data.days.filter((d) => d.pump).length} pump days · gang total {money(data.gross)}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, marginBottom: 8 }}>
              {["P", "I", "A", "-"].map((k) => <span key={k} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><span style={{ width: 18, height: 18, borderRadius: 4, background: GANG_CODE[k][1], color: GANG_CODE[k][2], fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{GANG_CODE[k][0]}</span>{GANG_CODE[k][3]}</span>)}
              <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><span style={{ width: 18, height: 18, borderRadius: 4, background: "#B3261E", color: "#fff", fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", outline: "2px solid #1D4F91" }}>A</span>away, substitute covered</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "separate", borderSpacing: 2, fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, minWidth: 120 }}>Member</th>
                    {data.dates.map((d) => { const wd = new Date(d + "T12:00:00+05:30").getDay(); return <th key={d} style={{ width: 24, textAlign: "center", fontWeight: 500, color: wd === 0 ? "var(--alert-red)" : "var(--slate)", lineHeight: 1.2 }}>{dows[wd]}<br /><b>{Number(d.slice(8))}</b></th>; })}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ fontSize: 11.5, color: "var(--slate)", paddingRight: 8 }}>Pump orders</td>
                    {data.days.map((d) => <td key={d.date} title={d.orders.map((o) => `${o.time} ${o.customer_name}`).join("\n")} style={{ textAlign: "center", color: d.pump ? "var(--charcoal)" : "var(--slate)", fontWeight: 600 }}>{d.orders.length || "·"}</td>)}
                  </tr>
                  {data.members.map((m) => (
                    <tr key={m.membership_id}>
                      <td style={{ fontSize: 12, whiteSpace: "nowrap", paddingRight: 8 }}><b>{m.name}</b>{m.is_leader ? <span style={{ color: "var(--slate)" }}> · leader</span> : null}</td>
                      {m.days.map((d) => {
                        const c = GANG_CODE[d.code] || GANG_CODE[""];
                        const tip = [d.first && `punch ${d.first}`, d.mark && `marked ${d.mark.present ? "here" : "away"}${d.mark.reason ? ` — ${d.mark.reason}` : ""} (${d.mark.by})`, d.sub && `substitute: ${d.sub}`].filter(Boolean).join("\n");
                        return <td key={d.date} title={tip} style={{ height: 22, minWidth: 22, textAlign: "center", borderRadius: 4, fontWeight: 700, background: c[1], color: c[2], outline: d.sub ? "2px solid #1D4F91" : "none", outlineOffset: -2 }}>{c[0]}{d.mark ? "*" : ""}</td>;
                      })}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ fontSize: 11.5, color: "var(--slate)", paddingRight: 8, paddingTop: 4 }}>Crew</td>
                    {data.days.map((d) => { const short = d.pump && data.gang.min_crew && d.crew_with_subs < data.gang.min_crew; return <td key={d.date} style={{ textAlign: "center", paddingTop: 4, fontWeight: 700, color: short ? "#fff" : "var(--slate)", background: short ? "var(--alert-red)" : "transparent", borderRadius: 4 }}>{d.date > data.today ? "" : d.crew_with_subs}</td>; })}
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>* marked by the Site Supervisor / HR instead of the machine. Hover a day for punch time, marks and substitutes.</div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontWeight: 700 }}>Deduction — Admin decides</div>
              <div style={{ fontSize: 12.5, color: "var(--slate)" }}>A member's day = his monthly rate ÷ {data.days_in_month}. Nothing is deducted unless Admin enters days.</div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760, marginTop: 6 }}>
                <thead><tr>
                  <th style={TH}>Member</th><th style={{ ...TH, textAlign: "right" }}>Present</th><th style={{ ...TH, textAlign: "right" }}>of which idle</th>
                  <th style={{ ...TH, textAlign: "right" }}>Away</th><th style={{ ...TH, textAlign: "right" }}>Sub covered</th><th style={{ ...TH, textAlign: "right" }}>Not covered</th>
                  <th style={{ ...TH, textAlign: "right" }}>Pay</th><th style={TH}>Deduct days</th><th style={TH}>Note</th><th style={{ ...TH, textAlign: "right" }}>Deduction</th>
                </tr></thead>
                <tbody>
                  {data.members.map((m) => {
                    const v = ded[m.employee_id] || { days: "", note: "" };
                    const amt = Math.round((Number(v.days) || 0) * m.monthly_rate / data.days_in_month);
                    return (
                      <tr key={m.membership_id} style={{ borderTop: "1px solid var(--border)", background: m.summary.uncovered >= 3 ? "var(--amber-bg)" : undefined }}>
                        <td style={TD}><b>{m.name}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{money(m.monthly_rate)}/month · {money(m.day_value)}/day{m.days_in_gang < data.days_in_month ? ` · ${m.days_in_gang} days in gang` : ""}</div></td>
                        <td style={{ ...TD, textAlign: "right" }}>{m.summary.present}</td>
                        <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{m.summary.idle}</td>
                        <td style={{ ...TD, textAlign: "right", fontWeight: m.summary.away ? 700 : 400 }}>{m.summary.away}</td>
                        <td style={{ ...TD, textAlign: "right" }}>{m.summary.covered || "—"}</td>
                        <td style={{ ...TD, textAlign: "right" }}>{m.summary.uncovered}</td>
                        <td style={{ ...TD, textAlign: "right" }}>{money(m.base)}</td>
                        <td style={TD}>{canDecide
                          ? <input type="number" min="0" step="0.5" style={{ width: 70 }} value={v.days} onChange={(e) => setDed({ ...ded, [m.employee_id]: { ...v, days: e.target.value } })} aria-label={`Days to deduct for ${m.name}`} />
                          : (m.deduction?.days || "—")}</td>
                        <td style={TD}>{canDecide
                          ? <input style={{ width: "100%", minWidth: 140 }} value={v.note} maxLength={200} onChange={(e) => setDed({ ...ded, [m.employee_id]: { ...v, note: e.target.value } })} placeholder="e.g. crew managed — ignore" />
                          : <span style={{ fontSize: 12 }}>{m.deduction?.note || ""}{m.deduction?.by ? <span style={{ color: "var(--slate)" }}> — {m.deduction.by}, {m.deduction.at}</span> : null}</span>}</td>
                        <td style={{ ...TD, textAlign: "right", color: amt ? "var(--alert-red)" : "var(--slate)" }}>{amt ? `− ${money(amt)}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 10 }}>
              <div style={{ fontSize: 14 }}>
                {data.gang.name} for {month}: {money(data.gross)} − {money(canDecide ? preview : data.deduction)} = <b style={{ fontSize: 16 }}>{money(data.gross - (canDecide ? preview : data.deduction))}</b>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {canDecide && <button disabled={busy} onClick={() => run(() => apiRequest(`/contract-labour/gangs/${gangId}/month/${month}/deductions`, { method: "PUT", body: { items: data.members.map((m) => ({ employee_id: m.employee_id, ...ded[m.employee_id] })) } }))}>Save deductions</button>}
                {canDecide && data.finished && <button className="btn-primary" disabled={busy} onClick={() => {
                  if (!window.confirm(`Close ${month} for ${data.gang.name}? Saved deductions are used; the register is frozen and the contractor's bill can be made.`)) return;
                  run(async () => {
                    await apiRequest(`/contract-labour/gangs/${gangId}/month/${month}/deductions`, { method: "PUT", body: { items: data.members.map((m) => ({ employee_id: m.employee_id, ...ded[m.employee_id] })) } });
                    await apiRequest(`/contract-labour/gangs/${gangId}/month/${month}/close`, { method: "POST" });
                  });
                }}>Close month</button>}
                {data.closed && data.can_decide && <button disabled={busy} onClick={() => run(() => apiRequest(`/contract-labour/gangs/${gangId}/month/${month}/reopen`, { method: "POST" }))}>Reopen</button>}
              </div>
            </div>
            {!data.can_decide && !data.closed && <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 6 }}>Only Admin decides deductions and closes the month.</div>}
          </div>
        </>
      )}
    </>
  );
}

// ================================================== gang on each pump order
function PumpOrdersView() {
  const [day, setDay] = useState(todayStr());
  const [data, setData] = useState(null);
  const [gangs, setGangs] = useState([]);
  const [error, setError] = useState("");
  const load = () => { setError(""); apiRequest(`/contract-labour/pump-orders?date=${day}`).then(setData).catch((e) => setError(e.message)); };
  useEffect(() => { apiRequest("/contract-labour/gang-options").then(setGangs).catch(() => {}); }, []);
  useEffect(load, [day]);
  async function pick(o, gangId) {
    setError("");
    try { await apiRequest(`/contract-labour/orders/${o.id}/pump-gang`, { method: "PUT", body: { gang_id: gangId || null } }); load(); }
    catch (e) { setError(e.message); }
  }
  return (
    <div className="card">
      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap", marginBottom: 10 }}>
        <Field label="Day"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <div style={{ fontSize: 12.5, color: "var(--slate)", maxWidth: 560 }}>The gang is not fixed to a pump — choose it on each order. A gang with no order on a day has a no-pump day.</div>
      </div>
      <Err text={error} />
      {!data ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
            <thead><tr style={{ background: "var(--concrete)" }}><th style={TH}>Time</th><th style={TH}>Customer · site</th><th style={TH}>Grade · m³</th><th style={TH}>Pump</th><th style={TH}>Gang</th></tr></thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>{o.time}</td>
                  <td style={TD}><b>{o.customer_name}</b><div style={{ fontSize: 12, color: "var(--slate)" }}>{o.site_name}</div></td>
                  <td style={TD}>{o.mix_grade_name} · {o.m3}</td>
                  <td style={TD}>{o.pump_code || o.pump_requirement.replace("_", " ")}</td>
                  <td style={TD}>{data.can_edit ? (
                    <select value={o.pump_gang_id || ""} onChange={(e) => pick(o, e.target.value)} aria-label="Pump gang">
                      <option value="">— choose —</option>
                      {gangs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  ) : (o.gang_name || <span style={{ color: "var(--slate)" }}>not chosen</span>)}</td>
                </tr>
              ))}
              {!data.orders.length && <tr><td colSpan={5} style={{ ...TD, color: "var(--slate)" }}>No pump orders that day.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================== contractors
const EMPTY_C = { name: "", kind: "individual", pan: "", gst_registered: false, gstin: "", gst_rate: "18", phone: "", address: "", notes: "", is_active: true };
export function ContractorsView() {
  const { can } = usePermissions();
  const [list, setList] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => apiRequest("/contract-labour/contractors").then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const set = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  async function save() {
    setBusy(true); setError("");
    try {
      if (form.id) await apiRequest(`/contract-labour/contractors/${form.id}`, { method: "PUT", body: form });
      else await apiRequest("/contract-labour/contractors", { method: "POST", body: form });
      setForm(null); load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const canAdd = can("hr.gangs", "create") || can("hr.contractor-bills", "create");
  const canEdit = can("hr.gangs", "edit") || can("hr.contractor-bills", "create");
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Labour contractors</div>
        {canAdd && !form && <button className="btn-primary" onClick={() => setForm({ ...EMPTY_C })}>+ Add contractor</button>}
      </div>
      {form && (
        <div style={{ background: "var(--concrete)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={grid}>
            <Field label="Name"><input value={form.name} onChange={set("name")} maxLength={120} /></Field>
            <Field label="Contractor is" hint="Decides the TDS rate: 1% individual, 2% firm.">
              <select value={form.kind} onChange={set("kind")}><option value="individual">Individual / HUF (e.g. a gang leader)</option><option value="firm">Firm / company</option></select>
            </Field>
            <Field label="PAN" hint="Without a PAN, TDS is 20%."><input value={form.pan} onChange={set("pan")} maxLength={10} style={{ textTransform: "uppercase" }} /></Field>
            <Field label="Phone"><input value={form.phone} onChange={set("phone")} maxLength={20} /></Field>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={form.gst_registered} onChange={set("gst_registered")} /> GST registered — charges GST on the bill</label>
            {form.gst_registered && <>
              <Field label="GSTIN"><input value={form.gstin} onChange={set("gstin")} maxLength={15} style={{ textTransform: "uppercase" }} /></Field>
              <Field label="GST rate (%)"><input type="number" min="0" max="28" step="0.5" value={form.gst_rate} onChange={set("gst_rate")} /></Field>
            </>}
            <Field label="Address"><input value={form.address} onChange={set("address")} maxLength={500} /></Field>
            <Field label="Notes"><input value={form.notes} onChange={set("notes")} maxLength={500} /></Field>
            {form.id && <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={form.is_active} onChange={set("is_active")} /> Active</label>}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button className="btn-primary" disabled={busy} onClick={save}>Save</button>
            <button onClick={() => { setForm(null); setError(""); }}>Cancel</button>
          </div>
        </div>
      )}
      <Err text={error} />
      {!list ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 700 }}>
            <thead><tr style={{ background: "var(--concrete)" }}><th style={TH}>Contractor</th><th style={TH}>PAN · TDS</th><th style={TH}>GST</th><th style={{ ...TH, textAlign: "right" }}>Gangs</th><th style={{ ...TH, textAlign: "right" }}>Individual workers</th><th style={TH}></th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid var(--border)", color: c.is_active ? undefined : "var(--slate)" }}>
                  <td style={TD}><b>{c.name}</b>{!c.is_active && " (inactive)"}<div style={{ fontSize: 12, color: "var(--slate)" }}>{c.kind === "firm" ? "Firm" : "Individual"}{c.phone ? ` · ${c.phone}` : ""}</div></td>
                  <td style={TD}>{c.pan || <span style={{ color: "var(--alert-red)" }}>no PAN — 20%</span>}{c.pan && <span style={{ color: "var(--slate)" }}> · {c.kind === "firm" ? "2%" : "1%"}</span>}</td>
                  <td style={TD}>{c.gst_registered ? `${c.gstin} · ${Number(c.gst_rate)}%` : <span style={{ color: "var(--slate)" }}>not registered</span>}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{c.gangs}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{c.workers}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{canEdit && <button onClick={() => setForm({ ...EMPTY_C, ...c, pan: c.pan || "", gstin: c.gstin || "", gst_rate: String(Number(c.gst_rate)), phone: c.phone || "", address: c.address || "", notes: c.notes || "" })}>Edit</button>}</td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={6} style={{ ...TD, color: "var(--slate)" }}>No contractors yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 10, lineHeight: 1.55 }}>
        TDS on labour contracts (Income-tax Act 2025 s.393, formerly s.194C): 1% individual / HUF, 2% firm, 20% without PAN — deducted once a bill is over ₹30,000 or the year's bills pass ₹1,00,000, on the labour amount only (not GST). A written contract or GST registration is not needed for it to apply. Check with your accountant.
      </div>
    </div>
  );
}

// ========================================================= contractor bills
export function ContractorBillsTab() {
  const { can } = usePermissions();
  const [month, setMonth] = useState(() => prevMonth(thisMonth()));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [openBill, setOpenBill] = useState(null);
  const [ledger, setLedger] = useState(null);
  const load = () => { if (!/^\d{4}-\d{2}$/.test(month)) return; setData(null); setError(""); apiRequest(`/contract-labour/bills?month=${month}`).then(setData).catch((e) => setError(e.message)); };
  useEffect(load, [month]);
  async function run(fn) {
    setBusy(true); setError("");
    try { await fn(); load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (ledger) return <LedgerView contractorId={ledger} onBack={() => { setLedger(null); load(); }} />;
  return (
    <>
      <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginBottom: 12 }}>
        <Field label="Bill month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <div style={{ fontSize: 12.5, color: "var(--slate)", maxWidth: 620 }}>
          One bill per contractor per month: their gangs (each gang's month must be closed) and their individual contract workers (from the locked payroll). GST only if the contractor is registered; TDS on the labour amount.
        </div>
      </div>
      <Err text={error} />
      {!data ? <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 900 }}>
            <thead><tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Contractor</th><th style={TH}>Gangs this month</th><th style={{ ...TH, textAlign: "right" }}>Labour</th><th style={{ ...TH, textAlign: "right" }}>GST</th>
              <th style={{ ...TH, textAlign: "right" }}>TDS</th><th style={{ ...TH, textAlign: "right" }}>Payable</th><th style={TH}>Bill</th><th style={{ ...TH, textAlign: "right" }}>Balance owed</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {data.contractors.map((c) => {
                const b = c.bill;
                const allClosed = c.gangs.every((g) => g.closed);
                return (
                  <Fragment key={c.id}>
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={TD}><b>{c.name}</b><div style={{ fontSize: 12, color: "var(--slate)" }}>{c.gst_registered ? `GST ${Number(c.gst_rate)}%` : "no GST"} · {c.pan ? (c.kind === "firm" ? "TDS 2%" : "TDS 1%") : "no PAN"}</div></td>
                      <td style={TD}>{c.gangs.length ? c.gangs.map((g) => <div key={g.id} style={{ fontSize: 12 }}>{g.name} · <span style={{ color: g.closed ? "var(--signal-green)" : "#8A5A00" }}>{g.closed ? "closed" : "not closed"}</span></div>) : <span style={{ fontSize: 12, color: "var(--slate)" }}>—</span>}{c.workers ? <div style={{ fontSize: 12, color: "var(--slate)" }}>{c.workers} individual worker{c.workers > 1 ? "s" : ""}</div> : null}{c.gang_advances_total > 0 ? <div style={{ fontSize: 12, color: "var(--info)" }}>advances paid {money(c.gang_advances_total)}</div> : null}</td>
                      <td style={{ ...TD, textAlign: "right" }}>{b ? money(b.taxable) : "—"}</td>
                      <td style={{ ...TD, textAlign: "right" }}>{b ? (Number(b.gst_amount) ? money(b.gst_amount) : "—") : "—"}</td>
                      <td style={{ ...TD, textAlign: "right" }}>{b ? (Number(b.tds_amount) ? `− ${money(b.tds_amount)}` : "—") : "—"}</td>
                      <td style={{ ...TD, textAlign: "right", fontWeight: 700 }}>{b ? money(b.net_payable) : "—"}</td>
                      <td style={TD}>{b ? <span className={`badge ${b.status === "approved" ? "badge-success" : "badge-warning"}`}>{b.status === "approved" ? `approved ${b.approved_on}` : "draft"}</span>
                        : (c.gangs.length || c.workers) && can("hr.contractor-bills", "create")
                          ? <button disabled={busy || !allClosed} title={allClosed ? "" : "Close each gang's month first (Contract labour → Month register)"} onClick={() => run(() => apiRequest("/contract-labour/bills", { method: "POST", body: { contractor_id: c.id, month } }))}>Make bill</button>
                          : <span style={{ fontSize: 12, color: "var(--slate)" }}>nothing to bill</span>}</td>
                      <td style={{ ...TD, textAlign: "right" }}>{money(c.balance)}</td>
                      <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap" }}>
                        {b && <button style={{ fontSize: 12 }} onClick={() => setOpenBill(openBill === b.id ? null : b.id)}>{openBill === b.id ? "Hide" : "Open"}</button>}{" "}
                        <button style={{ fontSize: 12 }} onClick={() => setLedger(c.id)}>Ledger</button>
                      </td>
                    </tr>
                    {b && openBill === b.id && <tr><td colSpan={9} style={{ padding: 0 }}><BillDetail bill={b} contractor={c} busy={busy} run={run} /></td></tr>}
                  </Fragment>
                );
              })}
              {!data.contractors.length && <tr><td colSpan={9} style={{ ...TD, color: "var(--slate)" }}>No contractors yet — add them under Contract labour → Contractors.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function BillDetail({ bill, contractor, busy, run }) {
  const { can } = usePermissions();
  const [inv, setInv] = useState({ their_invoice_no: bill.their_invoice_no || "", their_invoice_date: bill.their_invoice_date || "" });
  const d = bill.detail || {};
  const draft = bill.status === "draft";
  const row = (label, value, opts = {}) => (
    <tr><td style={{ padding: "7px 0", borderBottom: "1px solid var(--border)", fontWeight: opts.bold ? 700 : 400 }}>{label}{opts.sub && <div style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>{opts.sub}</div>}</td>
      <td style={{ padding: "7px 0", borderBottom: "1px solid var(--border)", textAlign: "right", fontWeight: opts.bold ? 700 : 400, color: opts.red ? "var(--alert-red)" : undefined }}>{value}</td></tr>
  );
  return (
    <div style={{ background: "#FAF8F4", padding: "12px 16px 16px", display: "flex", gap: 20, flexWrap: "wrap" }}>
      <div style={{ flex: "999 1 480px", minWidth: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {(d.gangs || []).map((g) => row(<><b>{g.name}</b></>, <>{money(g.gross)}{g.deduction ? <div style={{ fontSize: 12, color: "var(--alert-red)" }}>− {money(g.deduction)}</div> : null}</>,
              { sub: g.members.filter((m) => m.deduction?.days).map((m) => `${m.name}: ${m.deduction.days} day${m.deduction.days === 1 ? "" : "s"} deducted${m.deduction.note ? ` (${m.deduction.note})` : ""}`).join(" · ") || "no deduction" }))}
            {(d.individuals || []).length > 0 && row(<b>Individual contract workers · {d.individuals.length}</b>, money(bill.individual_amount),
              { sub: d.individuals.map((x) => `${x.name} ${money(x.amount)}${x.marked_paid_in_payroll ? " (also marked paid in payroll!)" : ""}`).join(" · ") })}
            {row("Labour charges (taxable value)", money(bill.taxable), { bold: true })}
            {Number(bill.gst_amount) > 0 && row(`GST @ ${Number(bill.gst_rate)}%`, `+ ${money(bill.gst_amount)}`)}
            {Number(bill.gst_amount) > 0 && row("Invoice total", money(Number(bill.taxable) + Number(bill.gst_amount)), { bold: true })}
            {row(`TDS${Number(bill.tds_rate) ? ` @ ${Number(bill.tds_rate)}%` : ""}`, Number(bill.tds_amount) ? `− ${money(bill.tds_amount)}` : "—", { sub: bill.tds_note, red: Number(bill.tds_amount) > 0 })}
            {row("Payable for the month", money(bill.net_payable), { bold: true })}
            {bill.paid_against > 0 && row("Paid against this bill", `− ${money(bill.paid_against)}`)}
            {/* Round 230 — gang advances paid against this month (already in the ledger as advances). */}
            {contractor.gang_advances_total > 0 && row("Gang advances already paid", `− ${money(contractor.gang_advances_total)}`,
              { sub: contractor.gang_advances.map((a) => `${a.gang_name} ${money(a.amount)} on ${a.paid_on}`).join(" · ") })}
            {(bill.paid_against > 0 || contractor.gang_advances_total > 0) && row("Still to pay on this bill",
              money(Math.max(0, Number(bill.net_payable) - Number(bill.paid_against || 0) - Number(contractor.gang_advances_total || 0))), { bold: true })}
          </tbody>
        </table>
        <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>Financial year {d.fy}: this contractor's bills with this one {money(d.fy_total_with_this)}.</div>
      </div>
      <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 10 }}>
        {contractor.gst_registered && <>
          <Field label="Their tax invoice no."><input value={inv.their_invoice_no} disabled={!draft} onChange={(e) => setInv({ ...inv, their_invoice_no: e.target.value })} maxLength={40} /></Field>
          <Field label="Invoice date"><input type="date" value={inv.their_invoice_date} disabled={!draft} onChange={(e) => setInv({ ...inv, their_invoice_date: e.target.value })} /></Field>
        </>}
        {draft && can("hr.contractor-bills", "create") && <button disabled={busy} onClick={() => run(() => apiRequest(`/contract-labour/bills/${bill.id}`, { method: "PUT", body: { ...inv, recalculate: true } }))}>Save &amp; recalculate</button>}
        {draft && can("hr.contractor-bills", "edit") && <button className="btn-primary" disabled={busy} onClick={() => run(async () => {
          await apiRequest(`/contract-labour/bills/${bill.id}`, { method: "PUT", body: inv });
          await apiRequest(`/contract-labour/bills/${bill.id}/approve`, { method: "POST" });
        })}>Approve bill</button>}
        {can("hr.contractor-bills", "delete") && <button disabled={busy} style={{ color: "var(--alert-red)" }} onClick={() => { if (window.confirm("Delete this bill?")) run(() => apiRequest(`/contract-labour/bills/${bill.id}`, { method: "DELETE" })); }}>Delete bill</button>}
        {!draft && <div style={{ fontSize: 12, color: "var(--slate)" }}>Approved {bill.approved_on} by {bill.approved_by_name}. Record payments from the Ledger.</div>}
      </div>
    </div>
  );
}

function LedgerView({ contractorId, onBack }) {
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => apiRequest(`/contract-labour/contractors/${contractorId}/ledger`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [contractorId]);
  async function run(fn) {
    setBusy(true); setError("");
    try { await fn(); setPay(null); load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!data) return <div className="card">{error ? <Err text={error} /> : <span style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</span>}</div>;
  const c = data.contractor;
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{c.name}</div>
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>{c.kind === "firm" ? "Firm" : "Individual"} · {c.pan || "no PAN"} · {c.gst_registered ? `GST ${c.gstin}` : "not GST registered"}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ textAlign: "right", marginRight: 8 }}><div className="kpi-label">Balance owed</div><div style={{ fontSize: 20, fontWeight: 700, color: data.balance < 0 ? "var(--signal-green)" : undefined }}>{money(data.balance)}</div>{data.balance < 0 && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>advance with them</div>}</div>
          {can("hr.contractor-bills", "create") && !pay && <button className="btn-primary" onClick={() => setPay({ amount: data.balance > 0 ? String(data.balance) : "", paid_on: todayStr(), mode: "bank_transfer", ref: "", note: "", bill_id: data.bills[0] ? String(data.bills[0].id) : "" })}>Record payment</button>}
          <button onClick={onBack}>← Bills</button>
        </div>
      </div>
      {pay && (
        <div style={{ background: "var(--concrete)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={grid}>
            <Field label="Amount (₹)"><input type="number" min="0" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
            <Field label="Paid on"><input type="date" value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} /></Field>
            <Field label="Mode"><select value={pay.mode} onChange={(e) => setPay({ ...pay, mode: e.target.value })}>{Object.entries(MODES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Against">
              <select value={pay.bill_id} onChange={(e) => setPay({ ...pay, bill_id: e.target.value })}>
                <option value="">Advance / on account</option>
                {data.bills.map((b) => <option key={b.id} value={b.id}>{b.month} bill · {money(b.net_payable)}</option>)}
              </select>
            </Field>
            <Field label="Reference / UTR"><input value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} maxLength={60} /></Field>
            <Field label="Note"><input value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} maxLength={200} /></Field>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button className="btn-primary" disabled={busy} onClick={() => run(() => apiRequest(`/contract-labour/contractors/${contractorId}/payments`, { method: "POST", body: pay }))}>Save payment</button>
            <button onClick={() => setPay(null)}>Cancel</button>
          </div>
        </div>
      )}
      <Err text={error} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
          <thead><tr style={{ background: "var(--concrete)" }}><th style={TH}>Date</th><th style={TH}>Entry</th><th style={{ ...TH, textAlign: "right" }}>Bill</th><th style={{ ...TH, textAlign: "right" }}>Paid</th><th style={{ ...TH, textAlign: "right" }}>Balance</th><th style={TH}></th></tr></thead>
          <tbody>
            {data.entries.map((e) => (
              <tr key={`${e.kind}${e.id}`} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={TD}>{e.date}</td>
                <td style={TD}>{e.label}<div style={{ fontSize: 12, color: "var(--slate)" }}>{e.detail}{e.by ? ` · ${e.by}` : ""}</div></td>
                <td style={{ ...TD, textAlign: "right" }}>{e.credit ? money(e.credit) : ""}</td>
                <td style={{ ...TD, textAlign: "right" }}>{e.debit ? money(e.debit) : ""}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: e.balance < 0 ? "var(--signal-green)" : undefined }}>{money(e.balance)}</td>
                <td style={{ ...TD, textAlign: "right" }}>{e.kind === "payment" && can("hr.contractor-bills", "delete") && <button style={{ fontSize: 12 }} disabled={busy} onClick={() => { if (window.confirm("Remove this payment?")) run(() => apiRequest(`/contract-labour/payments/${e.id}`, { method: "DELETE" })); }}>Remove</button>}</td>
              </tr>
            ))}
            {!data.entries.length && <tr><td colSpan={6} style={{ ...TD, color: "var(--slate)" }}>No approved bills or payments yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
