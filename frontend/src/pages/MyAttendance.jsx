// Round 198 — an employee's own attendance and correction requests. Open to
// any logged-in user whose login is linked to an HR employee record; nothing
// here needs an HR permission.
//
// Round 200 — a day that met the duty hours (the shift's length, or 8 hours
// for someone with no shift) shows only "P". Anything short shows the punches
// and can be corrected. Leave: balances, asking for leave, and withdrawing.
import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { RequestForm, KIND_LABEL } from "./HrStage2.jsx";
import { LeaveForm, leaveRange, balHint } from "./HrLeave.jsx";
import { Link } from "react-router-dom";

const CODE = {
  P: ["Present", "var(--signal-green-bg)", "var(--signal-green)"], HD: ["Half day", "var(--amber-bg)", "var(--amber)"],
  A: ["Absent", "var(--alert-red-bg)", "var(--alert-red)"], MIS: ["Missed punch", "var(--violet-bg)", "var(--violet)"],
  NL: ["No location", "var(--violet-bg)", "var(--violet)"], WO: ["Off", "#ECEAE4", "var(--slate)"],
  H: ["Holiday", "var(--info-bg, #E6F0FA)", "var(--info)"], IN: ["In now", "var(--info-bg, #E6F0FA)", "var(--info)"],
  L: ["Leave", "#E2EEF3", "#28657E"],
};
const STATUS_BADGE = { pending: "badge-info", approved: "badge-success", rejected: "badge-danger", cancelled: "badge-neutral" };
const thisMonth = () => new Date(Date.now() - 4 * 3600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
const fmtDay = (d) => new Date(d + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const hm = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;

export default function MyAttendance() {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [raise, setRaise] = useState(null); // date or "" for free choice
  const [asking, setAsking] = useState(null); // leave: date or "" for free choice
  const load = () => apiRequest(`/hr/my?month=${month}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { setData(null); load(); }, [month]);
  // Round 202 — attendance on the phone.
  const [canPunch, setCanPunch] = useState(false);
  useEffect(() => { apiRequest("/hr/punch/allowed").then((r) => setCanPunch(!!r.allowed)).catch(() => {}); }, []);
  // Round 267 — comp-off is credited automatically for an off day / holiday
  // worked; it is taken as Comp-off leave from the balance.
  const coType = (data?.leave_types || []).find((t) => t.kind === "comp_off");
  const coBal = (data?.leave_balances || []).find((b) => b.kind === "comp_off");
  const coCredits = (data?.compoff_claims || []).filter((c) => c.status === "approved");

  async function withdraw(path) {
    setError("");
    try { await apiRequest(path, { method: "POST" }); load(); } catch (err) { setError(err.message); }
  }

  const att = data?.attendance;
  const days = att ? [...att.days].filter((d) => d.code).reverse() : [];
  const busy = raise !== null || asking !== null;
  return (
    <>
      <TopBar title="My attendance" />
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {data && !data.linked && <div className="card" style={{ fontSize: 13 }}>Your login is not linked to an employee record yet. Ask HR to link it.</div>}
        {data?.linked && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <div><div style={{ fontWeight: 700, fontSize: 16 }}>{data.employee.name}</div><div style={{ fontSize: 12, color: "var(--slate)" }}>{data.employee.emp_code}</div></div>
              <div className="field-input" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
                {canPunch && <Link to="/mark-attendance" className="btn-primary" style={{ padding: "10px 14px", borderRadius: 8, textDecoration: "none", fontSize: 13, fontWeight: 600 }}>Mark attendance</Link>}
                {!busy && <button className={canPunch ? "" : "btn-primary"} onClick={() => setAsking("")}>+ Ask for leave</button>}
                {!busy && <button onClick={() => setRaise("")}>+ Correct a day</button>}
                {!busy && coType && coBal?.left > 0 && <button onClick={() => setAsking({ type: coType.id })}>Take comp-off ({coBal.left})</button>}
              </div>
            </div>
            {asking !== null && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700 }}>Ask for leave</div>
                <LeaveForm self types={data.leave_types} balances={data.leave_balances}
                  fixed={asking?.type ? { leave_type_id: asking.type } : asking ? { date: asking } : {}}
                  onDone={() => { setAsking(null); load(); }} onCancel={() => setAsking(null)} />
              </div>
            )}
            {raise !== null && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700 }}>Correct {raise ? fmtDay(raise) : "a day"}</div>
                <RequestForm self fixed={raise ? { work_date: raise } : {}} onDone={() => { setRaise(null); load(); }} onCancel={() => setRaise(null)} />
              </div>
            )}
            {att && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginBottom: 12 }}>
                {[["Present", att.summary.present], ["Half day", att.summary.half], ["Absent", att.summary.absent], ["Missed punch", att.summary.missed], ["Leave", att.summary.leave], ["Paid days so far", att.summary.paid_days]].map(([k, v]) => (
                  <div key={k} className="kpi"><div className="kpi-label">{k}</div><div className="kpi-value" style={{ fontSize: 20 }}>{v}</div></div>
                ))}
              </div>
            )}

            {data.leave_balances?.some((b) => b.eligible !== false && (b.allowance != null || b.used || b.waiting || b.earned)) && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>My leave this year</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {data.leave_balances.filter((b) => b.eligible !== false && (b.allowance != null || b.used || b.waiting || b.earned)).map((b) => (
                    <div key={b.leave_type_id} style={{ border: `1px solid ${b.kind === "comp_off" ? "#28657E" : "var(--border)"}`, borderRadius: 8, padding: "6px 10px", fontSize: 12.5, maxWidth: 220 }}>
                      <b>{b.code}</b> <span style={{ color: "var(--slate)" }}>{b.name}</span>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{b.left ?? b.used}</div>
                      <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{balHint(b)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(coCredits.length > 0 || coBal?.lapsed > 0) && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700 }}>My comp-off</div>
                  <div style={{ fontSize: 12, color: "var(--slate)" }}>
                    Balance <b style={{ color: "#28657E", fontSize: 15 }}>{coBal?.left ?? 0}</b>{coBal?.waiting ? ` · ${coBal.waiting} asked` : ""}{coBal?.lapsed ? ` · ${coBal.lapsed} lapsed` : ""}
                    {data.employee.compoff_accumulate && <span className="badge badge-info" style={{ marginLeft: 6 }}>accumulating</span>}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--slate)", margin: "4px 0 6px" }}>Added automatically for a weekly off or holiday you worked. Take it with “Take comp-off” — the one expiring first is used first.</div>
                {coCredits.map((c) => (
                  <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
                    <span style={{ background: "#E2EEF3", color: "#28657E", fontWeight: 700, fontSize: 12, borderRadius: 6, padding: "3px 8px" }}>{c.days === 1 ? "1 day" : "½ day"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>Worked {fmtDay(c.work_date)}</b>{c.worked_min != null ? <span style={{ color: "var(--slate)" }}> · {hm(c.worked_min)}</span> : null}
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>{c.off_date ? `taken on ${fmtDay(c.off_date)}` : `expires ${fmtDay(c.expires_on)}`}{c.source === "auto" ? "" : " · claimed earlier"}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(data.leaves?.length > 0 || data.requests.length > 0 || data.compoff_claims?.some((c) => c.status === "pending" || c.status === "rejected")) && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>My requests</div>
                {(data.compoff_claims || []).filter((c) => c.status === "pending" || c.status === "rejected").map((c) => (
                  <div key={"c" + c.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
                    <div>
                      <b>{fmtDay(c.work_date)}</b> · Comp-off {c.off_date ? "request" : "claim"} ({c.days === 1 ? "1 day" : "½ day"}){c.off_date ? <> — off on <b>{fmtDay(c.off_date)}</b>{c.for_absence ? " (was absent)" : ""}</> : null}
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>{c.off_date ? "worked day and day off decided together" : `expires ${fmtDay(c.expires_on)}`}{c.decision_note ? ` — ${c.decided_by_name || ""}: ${c.decision_note}` : ""}</div>
                    </div>
                    <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span className={`badge ${STATUS_BADGE[c.status]}`}>{c.status === "pending" ? "Waiting" : c.status}</span>
                      {c.status === "pending" && <div><button style={{ padding: "2px 8px", fontSize: 11.5, marginTop: 4 }} onClick={() => withdraw(`/hr/compoff/${c.id}/cancel`)}>Withdraw</button></div>}
                    </div>
                  </div>
                ))}
                {data.leaves.filter((l) => l.status !== "cancelled" && !l.compoff_claim_id).map((l) => (
                  <div key={"l" + l.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
                    <div>
                      <b>{leaveRange(l)}</b> · {l.type_name} ({l.days} day{l.days === 1 ? "" : "s"})
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>{l.reason || ""}{l.decision_note ? ` — ${l.decided_by_name || ""}: ${l.decision_note}` : ""}</div>
                    </div>
                    <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span className={`badge ${STATUS_BADGE[l.status]}`}>{l.status === "pending" ? "Waiting" : l.status}</span>
                      {l.status === "pending" && <div><button style={{ padding: "2px 8px", fontSize: 11.5, marginTop: 4 }} onClick={() => withdraw(`/hr/leaves/${l.id}/cancel`)}>Withdraw</button></div>}
                    </div>
                  </div>
                ))}
                {data.requests.map((r) => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
                    <div>
                      <b>{fmtDay(r.work_date)}</b> · {KIND_LABEL[r.kind]}{r.time_in ? ` · in ${r.time_in}` : ""}{r.time_out ? ` · out ${r.time_out}` : ""}
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>{r.reason}{r.decision_note ? ` — ${r.decided_by_name || ""}: ${r.decision_note}` : ""}</div>
                    </div>
                    <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status === "pending" ? "Waiting" : r.status}</span>
                      {r.status === "pending" && <div><button style={{ padding: "2px 8px", fontSize: 11.5, marginTop: 4 }} onClick={() => withdraw(`/hr/requests/${r.id}/cancel`)}>Withdraw</button></div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="card" style={{ padding: "4px 12px" }}>
              {!att ? <div style={{ fontSize: 13, padding: 8 }}>No attendance yet.</div> : !days.length ? <div style={{ fontSize: 13, padding: 8 }}>Nothing recorded this month yet.</div> : days.map((d) => {
                const c = CODE[d.code] || [d.code, "#eee", "var(--slate)"];
                // A full day: just "Present". Short of the duty hours, or not a
                // clean day: the punches, so the employee can see and correct it.
                const clean = d.code === "P" && d.met;
                const showTimes = ["P", "HD", "A", "MIS", "NL", "IN"].includes(d.code) && !clean;
                const fixable = !clean && ["P", "HD", "A", "MIS", "NL"].includes(d.code) && !d.pending;
                const canLeave = ["A", "MIS", "NL", "HD"].includes(d.code) && !d.pending && !d.leave;
                const label = d.code === "L" ? `${d.leave?.name || "Leave"}${d.leave?.half ? " (half day)" : ""}` : d.code === "P" && !clean ? "Present — short of duty hours" : c[0];
                return (
                  <div key={d.date} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid var(--border)" }}>
                    <span style={{ background: c[1], color: c[2], fontWeight: 700, fontSize: 12, borderRadius: 6, padding: "3px 8px", minWidth: 34, textAlign: "center",
                      boxShadow: d.co || d.co_for ? "0 0 0 2px #0E7C7B" : undefined }}>
                      {d.code === "HD" ? "½" : d.code === "L" ? d.leave?.code || "L" : d.code}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{fmtDay(d.date)} <span style={{ fontWeight: 400, color: "var(--slate)" }}>· {label}</span></div>
                      {showTimes && (
                        <div style={{ fontSize: 12, color: "var(--slate)" }}>
                          {d.times?.length ? d.times.join(", ") : "no punches"}
                          {d.worked != null && d.req ? <> · {hm(d.worked)} of {hm(d.req)}</> : null}
                          {d.late ? <span style={{ color: "var(--rebar)" }}> · late {d.late} min</span> : null}
                        </div>
                      )}
                      {d.pending > 0 && <div style={{ fontSize: 12, color: "var(--info)" }}>request waiting for approval</div>}
                      {/* Round 242 — comp-off: which day it was taken on / which worked day it was for. */}
                      {(d.co || d.co_for) && (
                        <div style={{ fontSize: 12, color: "#0E7C7B", fontWeight: 600 }}>
                          {(d.flags || []).filter((x) => x.startsWith("comp-off") || x.includes("comp-off not taken")).join(" · ")}
                        </div>
                      )}
                    </div>
                    {!busy && (fixable || canLeave) && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {fixable && <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setRaise(d.date)}>Correct</button>}
                        {canLeave && <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setAsking(d.date)}>Leave</button>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        <MyPpe />
      </div>
    </>
  );
}

// Round 249 — the employee's own PPE: what they hold, their requests, and
// asking for an item (approved by the Plant Manager / Admin, then issued).
const PPE_REASON = { new: "New", worn_out: "Worn out", damaged: "Damaged", lost: "Lost" };
function MyPpe() {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const load = () => apiRequest("/hr/my/ppe").then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, []);
  if (!d?.linked) return null;
  const held = d.issues.filter((x) => !x.returned_on);
  const item = d.items.find((i) => String(i.id) === String(f?.item_id));
  async function send(e) {
    e.preventDefault(); setErr("");
    try { await apiRequest("/hr/my/ppe-request", { method: "POST", body: { items: [{ item_id: Number(f.item_id), qty: Number(f.qty) || 1, size: f.size, reason: f.reason, note: f.note }] } }); setF(null); setMsg("Request sent — waiting for approval."); load(); }
    catch (ex) { setErr(ex.message); }
  }
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>My PPE</div>
        {!f && <button style={{ padding: "5px 12px", fontSize: 12.5 }} onClick={() => { setF({ item_id: "", qty: 1, size: "", reason: "new", note: "" }); setMsg(""); }}>Ask for PPE</button>}
      </div>
      {msg && <div style={{ fontSize: 12.5, color: "var(--signal-green)", marginTop: 6 }}>{msg}</div>}
      {f && (
        <form onSubmit={send} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>Item<select value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} required><option value="">Choose…</option>{d.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>Qty<input type="number" min={1} max={10} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} style={{ width: 60 }} /></label>
          {item?.has_size && <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>Size<input value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} style={{ width: 70 }} /></label>}
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>Why<select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{Object.entries(PPE_REASON).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <button type="submit" className="btn-primary">Send</button>
          <button type="button" onClick={() => setF(null)}>Cancel</button>
          {err && <div style={{ color: "var(--alert-red)", fontSize: 12.5, width: "100%" }}>{err}</div>}
        </form>
      )}
      <div style={{ fontSize: 13, marginTop: 10 }}>
        <span style={{ color: "var(--slate)" }}>With me:</span> {held.length ? held.map((x) => `${x.item}${x.qty > 1 ? ` × ${x.qty}` : ""}${x.size ? ` (${x.size})` : ""} — ${fmtDay(x.issued_on)}`).join(" · ") : "nothing recorded"}
      </div>
      {d.requests.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {d.requests.slice(0, 6).map((r) => (
            <div key={r.id} style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "center" }}>
              <span className={`badge ${r.status === "issued" ? "badge-success" : STATUS_BADGE[r.status] || "badge-neutral"}`}>{r.status}</span>
              {r.item}{r.qty > 1 ? ` × ${r.qty}` : ""} · {PPE_REASON[r.reason]}{r.decision_note ? <span style={{ color: "var(--slate)" }}> — {r.decision_note}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
