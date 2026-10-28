// Round 249 — HR: PPE and employee exits (owner, 28 Oct 2026).
//   PPE: "PPE issued to an employee record is required and a request >>
//   approval process for PPE" — raise → approve / reject → issue, the issue
//   register, what each employee holds, returns, replacement due.
//   Exits: "a flow for when an employee leaves the company, an approval, block
//   from accidental creation of any payment" — raise → Admin approves →
//   complete after the last working day. Backend: routes/hrPeople.js, lib/hrExit.js.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";

const fmt = (ymd) => (ymd ? new Date(`${String(ymd).slice(0, 10)}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) : "—");
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const money = (v) => "₹" + Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const REASON = { new: "New", worn_out: "Worn out", damaged: "Damaged", lost: "Lost" };
const STATUS = {
  pending: { bg: "var(--amber-bg)", fg: "var(--amber)", label: "Waiting for approval" },
  approved: { bg: "var(--info-bg)", fg: "var(--info)", label: "Approved" },
  issued: { bg: "var(--signal-green-bg)", fg: "var(--signal-green)", label: "Issued" },
  completed: { bg: "var(--signal-green-bg)", fg: "var(--signal-green)", label: "Completed — left" },
  rejected: { bg: "var(--alert-red-bg)", fg: "var(--alert-red)", label: "Rejected" },
  cancelled: { bg: "#ECEAE4", fg: "var(--slate)", label: "Cancelled" },
};
const KIND = { resignation: "Resignation", termination: "Termination", retirement: "Retirement", contract_end: "Contract ended", absconding: "Absconding", death: "Death", other: "Other" };
const TH = { textAlign: "left", fontSize: 11.5, color: "var(--slate)", fontWeight: 600, padding: "7px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", position: "sticky", top: 0, background: "var(--surface)", zIndex: 1 };
const TD = { padding: "7px 8px", borderBottom: "1px solid var(--border)", fontSize: 13, verticalAlign: "top" };
const SMALL = { padding: "4px 9px", fontSize: 12 };
const MUTED = { fontSize: 11.5, color: "var(--slate)" };

function Chip({ s, children }) {
  const st = STATUS[s] || STATUS.cancelled;
  return <span className="badge" style={{ background: st.bg, color: st.fg, whiteSpace: "nowrap" }}>{children || st.label}</span>;
}
function Field({ label, children, span }) {
  return (
    <label className="field-input" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", fontWeight: 600, gridColumn: span ? "1 / -1" : undefined }}>
      {label}{children}
    </label>
  );
}
function Kpi({ label, value, tone, onClick, active }) {
  return (
    <button type="button" onClick={onClick} className="card" style={{ margin: 0, textAlign: "left", padding: "12px 14px", cursor: onClick ? "pointer" : "default", border: active ? "2px solid var(--charcoal)" : undefined }}>
      <div className="kpi-label">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </button>
  );
}
function EmpPick({ employees, value, onChange, required }) {
  const [q, setQ] = useState("");
  const list = employees.filter((e) => !q || `${e.name} ${e.emp_code} ${e.department || ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 110 }} aria-label="Search employees" />
      <select value={value} onChange={(e) => onChange(e.target.value)} required={required} style={{ flex: 1, minWidth: 0 }}>
        <option value="">Choose…</option>
        {list.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.emp_code}{e.department ? ` · ${e.department}` : ""}</option>)}
      </select>
    </div>
  );
}

// ==================================================================== PPE
export function PpeTab() {
  const { can } = usePermissions();
  const mayRaise = can("hr.ppe", "create"), mayIssue = can("hr.ppe", "edit"), mayApprove = can("hr.ppe-approve", "edit"), mayDelete = can("hr.ppe", "delete"), mayItems = can("hr.settings", "edit");
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [view, setView] = useState("requests");
  const [show, setShow] = useState("open");
  const [q, setQ] = useState("");
  const [raising, setRaising] = useState(false);
  const [direct, setDirect] = useState(false);
  const load = () => apiRequest("/hr/ppe").then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn, okMsg) => { setErr(""); try { await fn(); setMsg(okMsg); load(); return true; } catch (e) { setErr(e.message); return false; } };

  const k = useMemo(() => {
    if (!d) return {};
    const today = d.today, ym = today.slice(0, 7);
    const held = d.issues.filter((s) => !s.returned_on && s.is_active);
    return {
      pending: d.requests.filter((r) => r.status === "pending").length,
      approved: d.requests.filter((r) => r.status === "approved").length,
      month: d.issues.filter((s) => s.issued_on.slice(0, 7) === ym).reduce((t, s) => t + s.qty, 0),
      due: held.filter((s) => s.due_on && s.due_on <= today).length,
    };
  }, [d]);
  if (!d) return err ? <div className="card" style={{ color: "var(--alert-red)" }}>{err}</div> : <div className="card" style={MUTED}>Loading PPE…</div>;

  const s = q.trim().toLowerCase();
  const match = (x) => !s || `${x.employee} ${x.emp_code} ${x.item}`.toLowerCase().includes(s);
  const reqs = d.requests.filter((r) => (show === "open" ? ["pending", "approved"].includes(r.status) : true) && match(r));
  const issues = d.issues.filter((x) => match(x) && (view !== "due" || (!x.returned_on && x.is_active && x.due_on && x.due_on <= d.today)));
  const holders = Object.values(d.issues.filter((x) => !x.returned_on && x.is_active && match(x)).reduce((m, x) => {
    (m[x.employee_id] ||= { id: x.employee_id, name: x.employee, code: x.emp_code, items: [] }).items.push(x); return m;
  }, {})).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        <Kpi label="Waiting for approval" value={k.pending} tone={k.pending ? "var(--amber)" : undefined} active={view === "requests" && show === "open"} onClick={() => { setView("requests"); setShow("open"); }} />
        <Kpi label="Approved — to issue" value={k.approved} tone={k.approved ? "var(--info)" : undefined} onClick={() => { setView("requests"); setShow("open"); }} />
        <Kpi label="Issued this month (pcs)" value={k.month} active={view === "register"} onClick={() => setView("register")} />
        <Kpi label="Due for replacement" value={k.due} tone={k.due ? "var(--rebar)" : undefined} active={view === "due"} onClick={() => setView("due")} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        {[["requests", "Requests"], ["register", "Issue register"], ["holders", "Who holds what"], ...(mayItems ? [["items", "Items"]] : [])].map(([v, l]) => (
          <button key={v} type="button" className={`btn-tab${view === v || (v === "register" && view === "due") ? " active" : ""}`} onClick={() => setView(v)}>{l}</button>
        ))}
        <input placeholder="Search employee or item" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", minWidth: 200 }} />
        {mayRaise && <button type="button" className="btn-primary" onClick={() => { setRaising(true); setDirect(false); }}>+ PPE request</button>}
        {mayApprove && mayIssue && <button type="button" onClick={() => { setDirect(true); setRaising(false); }}>Issue directly</button>}
      </div>
      {msg && <div className="card" style={{ background: "var(--signal-green-bg)", fontSize: 13, margin: 0 }}>{msg}</div>}
      {err && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, margin: 0 }}>{err}</div>}
      {raising && <PpeRequestForm d={d} onCancel={() => setRaising(false)} onDone={(n) => { setRaising(false); setMsg(`${n} request line${n > 1 ? "s" : ""} raised — waiting for approval.`); load(); }} />}
      {direct && <PpeIssueForm d={d} onCancel={() => setDirect(false)} onDone={() => { setDirect(false); setMsg("PPE issued and recorded."); load(); }} />}

      {view === "requests" && (
        <div className="card" style={{ padding: 0, margin: 0 }}>
          <div style={{ display: "flex", gap: 6, padding: 10 }}>
            {[["open", "Open"], ["all", "Last 120 days"]].map(([v, l]) => <button key={v} type="button" style={{ ...SMALL, fontWeight: show === v ? 700 : 400 }} aria-pressed={show === v} onClick={() => setShow(v)}>{l}</button>)}
          </div>
          <div style={{ overflow: "auto", maxHeight: "65vh" }}>
            <table style={{ width: "100%", minWidth: 900, borderCollapse: "separate", borderSpacing: 0 }}>
              <thead><tr><th style={TH}>Raised</th><th style={TH}>Employee</th><th style={TH}>Item</th><th style={TH}>Qty / size</th><th style={TH}>Why</th><th style={TH}>Last issued</th><th style={TH}>Status</th><th style={TH} /></tr></thead>
              <tbody>
                {reqs.map((r) => <PpeRequestRow key={r.id} r={r} mayApprove={mayApprove} mayIssue={mayIssue} act={act} />)}
                {!reqs.length && <tr><td colSpan={8} style={{ ...TD, ...MUTED }}>{show === "open" ? "No open requests." : "No requests."}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(view === "register" || view === "due") && (
        <div className="card" style={{ padding: 0, margin: 0, overflow: "auto", maxHeight: "70vh" }}>
          <table style={{ width: "100%", minWidth: 880, borderCollapse: "separate", borderSpacing: 0 }}>
            <thead><tr><th style={TH}>Issued</th><th style={TH}>Employee</th><th style={TH}>Item</th><th style={TH}>Qty / size</th><th style={TH}>Replace by</th><th style={TH}>Returned</th><th style={TH}>By</th><th style={TH} /></tr></thead>
            <tbody>
              {issues.map((x) => {
                const due = !x.returned_on && x.due_on && x.due_on <= d.today;
                return (
                  <tr key={x.id} style={{ opacity: x.returned_on || !x.is_active ? 0.6 : 1 }}>
                    <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmt(x.issued_on)}{x.request_id ? <div style={MUTED}>request #{x.request_id}</div> : <div style={MUTED}>direct</div>}</td>
                    <td style={TD}><b>{x.employee}</b><div style={MUTED}>{x.emp_code}{x.is_active ? "" : " · left"}</div></td>
                    <td style={TD}>{x.item}{x.note ? <div style={MUTED}>{x.note}</div> : null}</td>
                    <td style={TD}>{x.qty}{x.size ? ` · ${x.size}` : ""}</td>
                    <td style={{ ...TD, color: due ? "var(--rebar)" : undefined, fontWeight: due ? 700 : 400, whiteSpace: "nowrap" }}>{x.due_on ? fmt(x.due_on) : "—"}{due ? " · due" : ""}</td>
                    <td style={TD}>{x.returned_on ? <>{fmt(x.returned_on)}{x.return_note ? <div style={MUTED}>{x.return_note}</div> : null}</> : "—"}</td>
                    <td style={TD}>{x.issued_by || "—"}</td>
                    <td style={{ ...TD, whiteSpace: "nowrap" }}>
                      {mayIssue && !x.returned_on && <button type="button" style={SMALL} onClick={() => { const note = window.prompt(`${x.item} returned by ${x.employee}. Note (optional):`, ""); if (note !== null) act(() => apiRequest(`/hr/ppe/issues/${x.id}/return`, { method: "POST", body: { note } }), "Return recorded."); }}>Returned</button>}
                      {mayIssue && x.returned_on && <button type="button" style={SMALL} onClick={() => act(() => apiRequest(`/hr/ppe/issues/${x.id}/return`, { method: "POST", body: { undo: true } }), "Return undone.")}>Undo return</button>}
                      {mayDelete && <> <button type="button" style={SMALL} onClick={() => window.confirm(`Remove this issue entry — ${x.item} to ${x.employee} on ${fmt(x.issued_on)}? Use only for a wrong entry.`) && act(() => apiRequest(`/hr/ppe/issues/${x.id}`, { method: "DELETE" }), "Entry removed.")}>Remove</button></>}
                    </td>
                  </tr>
                );
              })}
              {!issues.length && <tr><td colSpan={8} style={{ ...TD, ...MUTED }}>{view === "due" ? "Nothing due for replacement." : "No PPE issued yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === "holders" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
          {holders.map((h) => (
            <div key={h.id} className="card" style={{ margin: 0 }}>
              <div style={{ fontWeight: 700 }}>{h.name} <span style={MUTED}>· {h.code}</span></div>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                {h.items.map((x) => (
                  <li key={x.id}>{x.item}{x.qty > 1 ? ` × ${x.qty}` : ""}{x.size ? ` (${x.size})` : ""} <span style={MUTED}>since {fmt(x.issued_on)}</span>
                    {x.due_on && x.due_on <= d.today && <span style={{ color: "var(--rebar)", fontWeight: 600 }}> · replace</span>}</li>
                ))}
              </ul>
            </div>
          ))}
          {!holders.length && <div className="card" style={MUTED}>No PPE held.</div>}
        </div>
      )}

      {view === "items" && mayItems && <PpeItems d={d} act={act} />}
    </div>
  );
}

function PpeRequestRow({ r, mayApprove, mayIssue, act }) {
  const [issuing, setIssuing] = useState(false);
  const [f, setF] = useState({ issued_on: istToday(), size: r.size || "", note: "" });
  return (
    <>
      <tr>
        <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtTs(r.requested_at)}<div style={MUTED}>by {r.requested_by || "—"}</div></td>
        <td style={TD}><b>{r.employee}</b><div style={MUTED}>{r.emp_code}{r.department ? ` · ${r.department}` : ""}</div></td>
        <td style={TD}>{r.item}{r.note ? <div style={MUTED}>{r.note}</div> : null}</td>
        <td style={TD}>{r.qty}{r.size ? ` · ${r.size}` : ""}</td>
        <td style={TD}>{REASON[r.reason]}</td>
        <td style={TD}>{r.last_issued ? fmt(r.last_issued) : <span style={MUTED}>never</span>}</td>
        <td style={TD}><Chip s={r.status} />{r.decision_note ? <div style={MUTED}>{r.decision_note}</div> : null}{r.decided_by ? <div style={MUTED}>{r.decided_by}, {fmtTs(r.decided_at)}</div> : null}</td>
        <td style={{ ...TD, whiteSpace: "nowrap" }}>
          {r.status === "pending" && mayApprove && <>
            <button type="button" className="btn-primary" style={SMALL} onClick={() => act(() => apiRequest(`/hr/ppe/requests/${r.id}/decide`, { method: "POST", body: { action: "approve" } }), "Approved.")}>Approve</button>{" "}
            <button type="button" style={SMALL} onClick={() => { const note = window.prompt("Why is it rejected?"); if (note) act(() => apiRequest(`/hr/ppe/requests/${r.id}/decide`, { method: "POST", body: { action: "reject", note } }), "Rejected."); }}>Reject</button>{" "}
          </>}
          {r.status === "approved" && mayIssue && <button type="button" className="btn-primary" style={SMALL} onClick={() => setIssuing(!issuing)}>Issue</button>}{" "}
          {["pending", "approved"].includes(r.status) && <button type="button" style={SMALL} onClick={() => window.confirm("Cancel this request?") && act(() => apiRequest(`/hr/ppe/requests/${r.id}/cancel`, { method: "POST", body: {} }), "Request cancelled.")}>Cancel</button>}
        </td>
      </tr>
      {issuing && (
        <tr><td colSpan={8} style={{ ...TD, background: "var(--concrete)" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <b style={{ alignSelf: "center" }}>Issue {r.qty} × {r.item} to {r.employee}</b>
            <Field label="Date"><input type="date" max={istToday()} value={f.issued_on} onChange={(e) => setF({ ...f, issued_on: e.target.value })} /></Field>
            <Field label="Size"><input value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. brand, store slip no." /></Field>
            <button type="button" className="btn-primary" onClick={() => act(() => apiRequest("/hr/ppe/issues", { method: "POST", body: { request_id: r.id, ...f } }), "Issued and recorded.")}>Record issue</button>
            <button type="button" onClick={() => setIssuing(false)}>Cancel</button>
          </div>
        </td></tr>
      )}
    </>
  );
}

function PpeRequestForm({ d, onCancel, onDone }) {
  const items = d.items.filter((i) => i.is_active);
  const [emp, setEmp] = useState("");
  const [lines, setLines] = useState([{ item_id: "", qty: 1, size: "" }]);
  const [reason, setReason] = useState("new");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  async function save(e) {
    e.preventDefault(); setErr("");
    const good = lines.filter((l) => l.item_id);
    if (!emp || !good.length) return setErr("Choose the employee and at least one item.");
    setBusy(true);
    try { await apiRequest("/hr/ppe/requests", { method: "POST", body: { lines: good.map((l) => ({ ...l, employee_id: Number(emp), reason, note })) } }); onDone(good.length); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  }
  return (
    <form onSubmit={save} className="card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>PPE request</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <Field label="Employee"><EmpPick employees={d.employees} value={emp} onChange={setEmp} required /></Field>
        <Field label="Why"><select value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(REASON).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      </div>
      {lines.map((l, i) => {
        const it = items.find((x) => String(x.id) === String(l.item_id));
        return (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label={i ? "" : "Item"}><select value={l.item_id} onChange={(e) => setLine(i, "item_id", e.target.value)}><option value="">Choose…</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label={i ? "" : "Qty"}><input type="number" min={1} max={50} value={l.qty} onChange={(e) => setLine(i, "qty", e.target.value)} style={{ width: 70 }} /></Field>
            {it?.has_size && <Field label="Size"><input value={l.size} onChange={(e) => setLine(i, "size", e.target.value)} style={{ width: 80 }} placeholder="e.g. 8, XL" /></Field>}
            {lines.length > 1 && <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}
          </div>
        );
      })}
      <div><button type="button" onClick={() => setLines([...lines, { item_id: "", qty: 1, size: "" }])}>+ Another item</button></div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Raise request"}</button>
      </div>
    </form>
  );
}

function PpeIssueForm({ d, onCancel, onDone }) {
  const items = d.items.filter((i) => i.is_active);
  const [f, setF] = useState({ employee_id: "", item_id: "", qty: 1, size: "", issued_on: istToday(), note: "" });
  const [err, setErr] = useState("");
  const it = items.find((x) => String(x.id) === String(f.item_id));
  async function save(e) {
    e.preventDefault(); setErr("");
    try { await apiRequest("/hr/ppe/issues", { method: "POST", body: { ...f, employee_id: Number(f.employee_id), item_id: Number(f.item_id) } }); onDone(); }
    catch (ex) { setErr(ex.message); }
  }
  return (
    <form onSubmit={save} className="card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>Issue PPE directly <span style={{ ...MUTED, fontWeight: 400 }}>— no request; you approve it by issuing</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <Field label="Employee" span><EmpPick employees={d.employees} value={f.employee_id} onChange={(v) => setF({ ...f, employee_id: v })} required /></Field>
        <Field label="Item"><select value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} required><option value="">Choose…</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Qty"><input type="number" min={1} max={50} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        {it?.has_size && <Field label="Size"><input value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} /></Field>}
        <Field label="Date"><input type="date" max={istToday()} value={f.issued_on} onChange={(e) => setF({ ...f, issued_on: e.target.value })} /></Field>
        <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary">Record issue</button>
      </div>
    </form>
  );
}

function PpeItems({ d, act }) {
  const [n, setN] = useState({ name: "", has_size: false, life_months: "" });
  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>PPE items</div>
      <div style={MUTED}>“Replace after” sets when an issued item shows as due for replacement (blank = no fixed life).</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
        <thead><tr><th style={TH}>Item</th><th style={TH}>Has sizes</th><th style={TH}>Replace after (months)</th><th style={TH}>In use</th></tr></thead>
        <tbody>{d.items.map((i) => (
          <tr key={i.id} style={{ opacity: i.is_active ? 1 : 0.55 }}>
            <td style={TD}>{i.name}</td>
            <td style={TD}><input type="checkbox" checked={i.has_size} onChange={(e) => act(() => apiRequest(`/hr/ppe/items/${i.id}`, { method: "PATCH", body: { ...i, has_size: e.target.checked } }), "Item saved.")} /></td>
            <td style={TD}><input defaultValue={i.life_months ?? ""} style={{ width: 70 }} onBlur={(e) => String(e.target.value) !== String(i.life_months ?? "") && act(() => apiRequest(`/hr/ppe/items/${i.id}`, { method: "PATCH", body: { ...i, life_months: e.target.value } }), "Item saved.")} /></td>
            <td style={TD}><input type="checkbox" checked={i.is_active} onChange={(e) => act(() => apiRequest(`/hr/ppe/items/${i.id}`, { method: "PATCH", body: { ...i, is_active: e.target.checked } }), "Item saved.")} /></td>
          </tr>))}
        </tbody>
      </table>
      <form onSubmit={(e) => { e.preventDefault(); act(() => apiRequest("/hr/ppe/items", { method: "POST", body: n }), "Item added.").then((ok) => ok && setN({ name: "", has_size: false, life_months: "" })); }}
        style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
        <Field label="New item"><input value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} required maxLength={80} /></Field>
        <label style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={n.has_size} onChange={(e) => setN({ ...n, has_size: e.target.checked })} /> Has sizes</label>
        <Field label="Replace after (months)"><input value={n.life_months} onChange={(e) => setN({ ...n, life_months: e.target.value })} style={{ width: 80 }} /></Field>
        <button type="submit" className="btn-primary">Add</button>
      </form>
    </div>
  );
}

// ================================================================= Exits
export function ExitsTab() {
  const { can } = usePermissions();
  const mayRaise = can("hr.exit", "create"), mayApprove = can("hr.exit-approve", "edit");
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [raising, setRaising] = useState(false);
  const [show, setShow] = useState("open");
  const load = () => apiRequest("/hr/exits").then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn, okMsg) => { setErr(""); try { await fn(); setMsg(okMsg); load(); return true; } catch (e) { setErr(e.message); return false; } };
  if (!d) return err ? <div className="card" style={{ color: "var(--alert-red)" }}>{err}</div> : <div className="card" style={MUTED}>Loading exits…</div>;
  const list = d.exits.filter((x) => (show === "open" ? ["pending", "approved"].includes(x.status) : true));
  const n = (s) => d.exits.filter((x) => x.status === s).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        <Kpi label="Waiting for approval" value={n("pending")} tone={n("pending") ? "var(--amber)" : undefined} />
        <Kpi label="Approved — serving notice" value={n("approved")} tone={n("approved") ? "var(--info)" : undefined} />
        <Kpi label="Left (completed)" value={n("completed")} />
      </div>
      <div className="card" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, background: "var(--concrete)" }}>
        <b>How an exit works.</b> Raise it → the Administrator approves (attendance and payroll stop at the last working day) → after the last working day, complete it with the final settlement (the employee becomes inactive and the app login is turned off).
        From the moment it is raised, <b>no new salary advance</b> can be requested, paid or entered for that employee; once approved, <b>no salary for a month after the last working day</b> and <b>no PPE issue</b>. The date of leaving can no longer be typed on the employee form — it comes from the exit.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {[["open", "Open"], ["all", "All"]].map(([v, l]) => <button key={v} type="button" className={`btn-tab${show === v ? " active" : ""}`} onClick={() => setShow(v)}>{l}</button>)}
        {mayRaise && <button type="button" className="btn-primary" style={{ marginLeft: "auto" }} onClick={() => setRaising(true)}>+ Employee leaving</button>}
      </div>
      {msg && <div className="card" style={{ background: "var(--signal-green-bg)", fontSize: 13, margin: 0 }}>{msg}</div>}
      {err && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, margin: 0 }}>{err}</div>}
      {raising && <ExitForm d={d} onCancel={() => setRaising(false)} onDone={() => { setRaising(false); setMsg("Exit raised — waiting for the Administrator's approval. No new advance can be given to this employee now."); load(); }} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
        {list.map((x) => <ExitCard key={x.id} x={x} today={d.today} mayApprove={mayApprove} act={act} />)}
      </div>
      {!list.length && <div className="card" style={MUTED}>{show === "open" ? "No one is leaving right now." : "No exits recorded."}</div>}
    </div>
  );
}

function ExitForm({ d, onCancel, onDone }) {
  const [f, setF] = useState({ employee_id: "", kind: "resignation", notice_date: istToday(), last_working_day: "", reason: "", disable_login: true });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const emp = d.employees.find((e) => String(e.id) === String(f.employee_id));
  async function save(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    try { await apiRequest("/hr/exits", { method: "POST", body: { ...f, employee_id: Number(f.employee_id) } }); onDone(); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  }
  return (
    <form onSubmit={save} className="card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>Employee leaving</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <Field label="Employee" span><EmpPick employees={d.employees} value={f.employee_id} onChange={(v) => setF({ ...f, employee_id: v })} required /></Field>
        <Field label="Why"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Notice / resignation date"><input type="date" value={f.notice_date} onChange={(e) => setF({ ...f, notice_date: e.target.value })} /></Field>
        <Field label="Last working day"><input type="date" value={f.last_working_day} onChange={(e) => setF({ ...f, last_working_day: e.target.value })} required /></Field>
        <Field label="Details" span><textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={500} /></Field>
      </div>
      {emp?.app_user_id && <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.disable_login} onChange={(e) => setF({ ...f, disable_login: e.target.checked })} /> Turn off {emp.name}&rsquo;s app login when the exit is completed</label>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Raise exit"}</button>
      </div>
    </form>
  );
}

function ExitCard({ x, today, mayApprove, act }) {
  const [lwd, setLwd] = useState(x.last_working_day);
  const [note, setNote] = useState("");
  const [settle, setSettle] = useState("");
  const [disable, setDisable] = useState(x.disable_login);
  const adv = (x.advances_to_recover || []).reduce((t, a) => t + a.amount, 0);
  const ppe = x.ppe_out || [];
  const lwdPassed = x.last_working_day <= today;
  const daysLeft = Math.round((new Date(`${x.last_working_day}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
  const open = ["pending", "approved"].includes(x.status);
  return (
    <article className="card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10, borderLeft: `4px solid ${STATUS[x.status]?.fg || "var(--border)"}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{x.employee}</div>
          <div style={MUTED}>{x.emp_code}{x.designation ? ` · ${x.designation}` : ""}{x.department ? ` · ${x.department}` : ""}{x.date_of_joining ? ` · joined ${fmt(x.date_of_joining)}` : ""}</div>
        </div>
        <Chip s={x.status} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 13 }}>
        <div><div className="kpi-label">Why</div><b>{KIND[x.kind]}</b></div>
        <div><div className="kpi-label">Notice</div><b>{fmt(x.notice_date)}</b></div>
        <div><div className="kpi-label">Last working day</div><b>{fmt(x.last_working_day)}</b>{open && <div style={MUTED}>{daysLeft > 0 ? `in ${daysLeft} day${daysLeft > 1 ? "s" : ""}` : daysLeft === 0 ? "today" : `${-daysLeft} day${daysLeft < -1 ? "s" : ""} ago`}</div>}</div>
      </div>
      {x.reason && <div style={{ fontSize: 12.5 }}>{x.reason}</div>}
      <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 12 }}>Clearance</div>
        <div>PPE to collect: {ppe.length ? ppe.map((p) => `${p.item}${p.qty > 1 ? ` × ${p.qty}` : ""}`).join(", ") : <span style={MUTED}>none</span>}</div>
        <div>Advances to recover in the final settlement: {adv ? <b>{money(adv)}</b> : <span style={MUTED}>none</span>}{(x.advances_to_recover || []).length ? <span style={MUTED}> ({x.advances_to_recover.length} advance{x.advances_to_recover.length > 1 ? "s" : ""})</span> : null}</div>
        {(x.advance_requests_open > 0 || x.ppe_requests_open > 0) && <div style={{ color: "var(--amber)" }}>Open requests: {x.advance_requests_open ? `${x.advance_requests_open} advance` : ""}{x.advance_requests_open && x.ppe_requests_open ? " · " : ""}{x.ppe_requests_open ? `${x.ppe_requests_open} PPE` : ""} — closed when the exit is approved</div>}
        <div>Last payroll: {x.last_payroll ? <>{x.last_payroll.month} · net {money(x.last_payroll.net)} · {x.last_payroll.paid != null ? `paid ${money(x.last_payroll.paid)}` : "not paid yet"}</> : <span style={MUTED}>none</span>}</div>
        {x.app_user_id && <div>App login: {x.disable_login ? "turned off when completed" : "kept"}</div>}
      </div>
      <div style={MUTED}>Raised by {x.requested_by || "—"} on {fmtTs(x.requested_at)}{x.decided_by ? ` · ${x.status === "rejected" ? "rejected" : "approved"} by ${x.decided_by} on ${fmtTs(x.decided_at)}` : ""}{x.completed_by ? ` · completed by ${x.completed_by} on ${fmtTs(x.completed_at)}` : ""}</div>
      {x.decision_note && <div style={{ fontSize: 12.5 }}><span style={MUTED}>Note:</span> {x.decision_note}</div>}
      {x.settlement_note && <div style={{ fontSize: 12.5 }}><span style={MUTED}>Final settlement:</span> {x.settlement_note}</div>}

      {x.status === "pending" && mayApprove && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <Field label="Last working day"><input type="date" value={lwd} onChange={(e) => setLwd(e.target.value)} /></Field>
          <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="needed to reject" /></Field>
          <button type="button" className="btn-primary" onClick={() => window.confirm(`Approve ${x.employee}'s exit with last working day ${fmt(lwd)}?\n\nAttendance and payroll stop on that day; open advance and PPE requests are closed.`) && act(() => apiRequest(`/hr/exits/${x.id}/decide`, { method: "POST", body: { action: "approve", last_working_day: lwd, note } }), "Exit approved.")}>Approve</button>
          <button type="button" onClick={() => act(() => apiRequest(`/hr/exits/${x.id}/decide`, { method: "POST", body: { action: "reject", note } }), "Exit rejected.")}>Reject</button>
        </div>
      )}
      {x.status === "approved" && mayApprove && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          {!lwdPassed && <div style={MUTED}>Complete it after the last working day.</div>}
          <Field label="Final settlement (what was paid / recovered, PPE collected)"><textarea rows={2} value={settle} onChange={(e) => setSettle(e.target.value)} disabled={!lwdPassed} maxLength={500} /></Field>
          {x.app_user_id && <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={disable} onChange={(e) => setDisable(e.target.checked)} disabled={!lwdPassed} /> Turn off the app login</label>}
          <div><button type="button" className="btn-primary" disabled={!lwdPassed} onClick={() => window.confirm(`Complete ${x.employee}'s exit? They become inactive${disable && x.app_user_id ? " and their app login is turned off" : ""}.`) && act(() => apiRequest(`/hr/exits/${x.id}/complete`, { method: "POST", body: { settlement_note: settle, disable_login: disable } }), "Exit completed.")}>Complete exit</button></div>
        </div>
      )}
      {open && (
        <div><button type="button" style={SMALL} onClick={() => { const n = window.prompt(`Cancel ${x.employee}'s exit? Reason:`); if (n !== null) act(() => apiRequest(`/hr/exits/${x.id}/cancel`, { method: "POST", body: { note: n } }), "Exit cancelled."); }}>Cancel exit</button></div>
      )}
    </article>
  );
}
