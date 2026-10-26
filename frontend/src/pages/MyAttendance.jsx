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
  // Round 202 — attendance on the phone, and comp-off claims.
  const [canPunch, setCanPunch] = useState(false);
  useEffect(() => { apiRequest("/hr/punch/allowed").then((r) => setCanPunch(!!r.allowed)).catch(() => {}); }, []);
  async function claim(d, days) {
    setError("");
    try { await apiRequest("/hr/my/compoff", { method: "POST", body: { work_date: d.date, days } }); load(); } catch (err) { setError(err.message); }
  }
  // Round 205 — comp-off request: the worked off day + the day to take off
  // (a coming working day, or a past day marked Absent).
  const [co, setCo] = useState(null);
  async function sendCo(e) {
    e.preventDefault(); setError("");
    try { await apiRequest("/hr/my/compoff-request", { method: "POST", body: { ...co, days: Number(co.days) } }); setCo(null); load(); }
    catch (err) { setError(err.message); }
  }
  const absentDays = (data?.attendance?.days || []).filter((d) => d.code === "A" || d.code === "HD").map((d) => d.date);

  async function withdraw(path) {
    setError("");
    try { await apiRequest(path, { method: "POST" }); load(); } catch (err) { setError(err.message); }
  }

  const att = data?.attendance;
  const days = att ? [...att.days].filter((d) => d.code).reverse() : [];
  const busy = raise !== null || asking !== null || co !== null;
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
                {/* Round 209 — always offered (owner): the employee names the off day
                    or holiday worked; the server checks its punches. */}
                {!busy && <button onClick={() => setCo({ work_date: data.compoff_claimable?.[0]?.date || "", off_date: "", days: "1", reason: "" })}>+ Comp-off request</button>}
              </div>
            </div>
            {asking !== null && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700 }}>Ask for leave</div>
                <LeaveForm self types={data.leave_types} balances={data.leave_balances} fixed={asking ? { date: asking } : {}}
                  onDone={() => { setAsking(null); load(); }} onCancel={() => setAsking(null)} />
              </div>
            )}
            {co && (
              <form className="card field-input" onSubmit={sendCo} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Comp-off request</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Off day / holiday I worked
                    {data.compoff_claimable?.length > 0 ? (
                      <select value={co.work_date} onChange={(e) => setCo({ ...co, work_date: e.target.value })} required>
                        {data.compoff_claimable.map((d) => <option key={d.date} value={d.date}>{fmtDay(d.date)}{d.worked != null ? ` · ${hm(d.worked)}` : ""}</option>)}
                      </select>
                    ) : (
                      <>
                        <input type="date" value={co.work_date} onChange={(e) => setCo({ ...co, work_date: e.target.value })} required />
                        <span style={{ fontWeight: 400, fontSize: 11 }}>No worked off day found in your punches yet — give the date; HR checks it.</span>
                      </>
                    )}
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Day I take off
                    <input type="date" value={co.off_date} onChange={(e) => setCo({ ...co, off_date: e.target.value })} required />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>How much
                    <select value={co.days} onChange={(e) => setCo({ ...co, days: e.target.value })}><option value="1">1 day</option><option value="0.5">½ day</option></select>
                  </label>
                </div>
                {absentDays.length > 0 && (
                  <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>Absent this month — tap to make good with comp-off: {absentDays.map((d) => (
                    <button key={d} type="button" style={{ padding: "2px 8px", fontSize: 12, margin: "2px 4px 0 0" }} onClick={() => setCo({ ...co, off_date: d })}>{fmtDay(d)}</button>
                  ))}</div>
                )}
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)", marginTop: 8 }}>Reason
                  <input value={co.reason} onChange={(e) => setCo({ ...co, reason: e.target.value })} placeholder="Needed if the day off was an absence" />
                </label>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}><button className="btn-primary" type="submit">Send request</button><button type="button" onClick={() => setCo(null)}>Cancel</button></div>
              </form>
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

            {(data.compoff_claimable?.length > 0) && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Worked on an off day? Claim comp-off</div>
                {data.compoff_claimable.map((d) => (
                  <div key={d.date} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border)" }}>
                    <span style={{ background: "#ECEAE4", color: "var(--slate)", fontWeight: 700, fontSize: 12, borderRadius: 6, padding: "3px 8px" }}>{d.holiday === "H" ? "H" : "WO"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{fmtDay(d.date)}</div>
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>{d.times.join(", ")}{d.worked != null ? ` · ${hm(d.worked)} worked` : ""}</div>
                    </div>
                    {/* Owner's rule: short hours can still ask for a full day; the manager decides. */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                      {d.days === 1
                        ? <button className="btn-primary" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => claim(d, 1)}>Claim 1 day</button>
                        : <>
                            {d.days === 0.5 && <button className="btn-primary" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => claim(d, 0.5)}>Claim ½ day</button>}
                            <button style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => claim(d, 1)}>Ask for 1 day</button>
                            <span style={{ fontSize: 11, color: "var(--slate)" }}>{d.days ? "hours qualify for ½ day" : "hours short of ½ day"} — manager decides</span>
                          </>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(data.leaves?.length > 0 || data.requests.length > 0 || data.compoff_claims?.length > 0) && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>My requests</div>
                {(data.compoff_claims || []).filter((c) => c.status !== "cancelled").map((c) => (
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
      </div>
    </>
  );
}
