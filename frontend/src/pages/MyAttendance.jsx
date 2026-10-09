// Round 198 — an employee's own attendance and correction requests. Open to
// any logged-in user whose login is linked to an HR employee record; nothing
// here needs an HR permission.
import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { RequestForm, KIND_LABEL } from "./HrStage2.jsx";

const CODE = {
  P: ["Present", "var(--signal-green-bg)", "var(--signal-green)"], HD: ["Half day", "var(--amber-bg)", "var(--amber)"],
  A: ["Absent", "var(--alert-red-bg)", "var(--alert-red)"], MIS: ["Missed punch", "var(--violet-bg)", "var(--violet)"],
  NL: ["No location", "var(--violet-bg)", "var(--violet)"], WO: ["Off", "#ECEAE4", "var(--slate)"],
  H: ["Holiday", "var(--info-bg, #E6F0FA)", "var(--info)"], IN: ["In now", "var(--info-bg, #E6F0FA)", "var(--info)"],
};
const STATUS_BADGE = { pending: "badge-info", approved: "badge-success", rejected: "badge-danger", cancelled: "badge-neutral" };
const thisMonth = () => new Date(Date.now() - 4 * 3600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
const fmtDay = (d) => new Date(d + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

export default function MyAttendance() {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [raise, setRaise] = useState(null); // date or "" for free choice
  const load = () => apiRequest(`/hr/my?month=${month}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { setData(null); load(); }, [month]);

  async function withdraw(r) {
    try { await apiRequest(`/hr/requests/${r.id}/cancel`, { method: "POST" }); load(); } catch (err) { setError(err.message); }
  }

  const att = data?.attendance;
  const days = att ? [...att.days].filter((d) => d.code).reverse() : [];
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
              <div className="field-input" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
                {raise === null && <button className="btn-primary" onClick={() => setRaise("")}>+ Request a correction</button>}
              </div>
            </div>
            {raise !== null && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700 }}>Request a correction{raise ? ` for ${fmtDay(raise)}` : ""}</div>
                <RequestForm self fixed={raise ? { work_date: raise } : {}} onDone={() => { setRaise(null); load(); }} onCancel={() => setRaise(null)} />
              </div>
            )}
            {att && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginBottom: 12 }}>
                {[["Present", att.summary.present], ["Half day", att.summary.half], ["Absent", att.summary.absent], ["Missed punch", att.summary.missed], ["Late", att.summary.late], ["Paid days so far", att.summary.paid_days]].map(([k, v]) => (
                  <div key={k} className="kpi"><div className="kpi-label">{k}</div><div className="kpi-value" style={{ fontSize: 20 }}>{v}</div></div>
                ))}
              </div>
            )}
            {data.requests.length > 0 && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>My requests</div>
                {data.requests.map((r) => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
                    <div>
                      <b>{fmtDay(r.work_date)}</b> · {KIND_LABEL[r.kind]}{r.time_in ? ` · in ${r.time_in}` : ""}{r.time_out ? ` · out ${r.time_out}` : ""}
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>{r.reason}{r.decision_note ? ` — ${r.decided_by_name || ""}: ${r.decision_note}` : ""}</div>
                    </div>
                    <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status === "pending" ? "Waiting" : r.status}</span>
                      {r.status === "pending" && <div><button style={{ padding: "2px 8px", fontSize: 11.5, marginTop: 4 }} onClick={() => withdraw(r)}>Withdraw</button></div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="card" style={{ padding: "4px 12px" }}>
              {!att ? <div style={{ fontSize: 13, padding: 8 }}>No attendance yet.</div> : !days.length ? <div style={{ fontSize: 13, padding: 8 }}>Nothing recorded this month yet.</div> : days.map((d) => {
                const c = CODE[d.code] || [d.code, "#eee", "var(--slate)"];
                const fixable = !["P", "WO", "H", "IN"].includes(d.code) && !d.pending;
                return (
                  <div key={d.date} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid var(--border)" }}>
                    <span style={{ background: c[1], color: c[2], fontWeight: 700, fontSize: 12, borderRadius: 6, padding: "3px 8px", minWidth: 34, textAlign: "center" }}>{d.code === "HD" ? "½" : d.code}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{fmtDay(d.date)} <span style={{ fontWeight: 400, color: "var(--slate)" }}>· {c[0]}</span></div>
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>
                        {d.times?.length ? d.times.join(", ") : "no punches"}
                        {d.late ? <span style={{ color: "var(--rebar)" }}> · late {d.late} min</span> : null}
                        {d.flags?.length ? ` · ${d.flags.join(" · ")}` : ""}
                      </div>
                    </div>
                    {fixable && raise === null && <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setRaise(d.date)}>Correct</button>}
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
