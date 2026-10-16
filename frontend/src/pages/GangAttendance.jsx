// Round 211 — the Site Supervisor confirms each pump gang's crew for the day
// (owner, 15 Oct 2026). The crews punch the gate machine every morning, so
// each list arrives ticked; the supervisor confirms it and fixes exceptions —
// a man who went straight to a site (Here, with a reason) or a substitute the
// contractor sent. No photos. Server: routes/contractLabour.js.
import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { todayStr } from "../lib/istDate.js";
import { PumpGangChanger } from "../lib/PumpGangPicker.jsx";

function GangCard({ g, day, canEdit, onSaved }) {
  // here[empId] = true/false; reasons[empId] = text
  const [here, setHere] = useState(() => Object.fromEntries(g.members.map((m) => [m.employee_id, m.code === "P" || m.code === "I"])));
  const [reasons, setReasons] = useState(() => Object.fromEntries(g.members.map((m) => [m.employee_id, m.mark?.reason || ""])));
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const present = g.members.filter((m) => here[m.employee_id]).length + g.subs.length;
  const short = g.pump && g.min_crew && present < g.min_crew;
  async function confirm() {
    setBusy(true); setError(""); setSaved("");
    try {
      let pos = null;
      if (g.members.some((m) => here[m.employee_id] && !m.punched) && navigator.geolocation) {
        pos = await new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { timeout: 8000 }));
      }
      await apiRequest(`/contract-labour/gangs/${g.id}/day/${day}`, { method: "PUT", body: {
        confirm: true, ...(pos || {}),
        marks: g.members.map((m) => ({ employee_id: m.employee_id, present: !!here[m.employee_id], reason: reasons[m.employee_id] })),
      } });
      setSaved("Confirmed.");
      onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function addSub() {
    setBusy(true); setError("");
    try {
      await apiRequest(`/contract-labour/gangs/${g.id}/day/${day}/subs`, { method: "POST", body: sub });
      setSub(null); onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function removeSub(id) {
    setBusy(true); setError("");
    try { await apiRequest(`/contract-labour/subs/${id}`, { method: "DELETE" }); onSaved(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{g.name}</div>
        <span style={{ fontSize: 12, fontWeight: 600, borderRadius: 999, padding: "3px 9px", background: g.confirmed ? "var(--signal-green-bg)" : "var(--amber-bg)", color: g.confirmed ? "var(--signal-green)" : "var(--amber)" }}>
          {g.confirmed ? `confirmed ${g.confirmed.confirmed_at}` : "to confirm"}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--slate)" }}>
        {g.contractor_name} · {g.orders.length ? `${g.orders.length} pump order${g.orders.length > 1 ? "s" : ""}: ${g.orders.map((o) => `${o.time} ${o.customer_name}${o.pump_code ? ` (${o.pump_code})` : ""}`).join(", ")}` : "no pump order — men who punched are present and paid"}
      </div>
      <div>
        {g.members.map((m) => {
          const h = !!here[m.employee_id];
          const needReason = h && !m.punched;
          return (
            <div key={m.employee_id} style={{ borderTop: "1px solid var(--border)", padding: "7px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}{m.is_leader ? <span style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}> · leader</span> : null}</div>
                  <div style={{ fontSize: 11.5, color: m.punched ? "var(--slate)" : "#8A5A00" }}>{m.punched ? `Machine ${m.first || "punch"}` : "No machine punch"}</div>
                </div>
                <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", flex: "0 0 auto" }}>
                  <button type="button" disabled={!canEdit} onClick={() => setHere({ ...here, [m.employee_id]: true })}
                    style={{ height: 40, width: 56, border: 0, borderRadius: 0, fontWeight: 600, background: h ? "var(--signal-green)" : "#fff", color: h ? "#fff" : "var(--charcoal)" }}>Here</button>
                  <button type="button" disabled={!canEdit} onClick={() => setHere({ ...here, [m.employee_id]: false })}
                    style={{ height: 40, width: 60, border: 0, borderRadius: 0, borderLeft: "1px solid var(--border)", fontWeight: 600, background: !h ? "var(--alert-red)" : "#fff", color: !h ? "#fff" : "var(--charcoal)" }}>Away</button>
                </div>
              </div>
              {needReason && <input style={{ marginTop: 6, width: "100%" }} placeholder="Why — e.g. went straight to the site" value={reasons[m.employee_id]} maxLength={200}
                onChange={(e) => setReasons({ ...reasons, [m.employee_id]: e.target.value })} disabled={!canEdit} />}
              {!h && m.punched && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>Punched in but marked away</div>}
            </div>
          );
        })}
        {!g.members.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>No members in this gang.</div>}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Substitutes the contractor sent</div>
        {g.subs.map((s) => (
          <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "4px 0" }}>
            <span>{s.name}{s.for_employee_id ? <span style={{ color: "var(--slate)" }}> · for {g.members.find((m) => m.employee_id === s.for_employee_id)?.name || "—"}</span> : null}</span>
            {canEdit && <button style={{ fontSize: 12 }} disabled={busy} onClick={() => removeSub(s.id)}>Remove</button>}
          </div>
        ))}
        {canEdit && !sub && <button style={{ marginTop: 6 }} onClick={() => setSub({ name: "", for_employee_id: g.members.find((m) => !here[m.employee_id])?.employee_id || "" })}>+ Add substitute</button>}
        {sub && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <input placeholder="Substitute's name" value={sub.name} onChange={(e) => setSub({ ...sub, name: e.target.value })} maxLength={80} style={{ flex: "1 1 140px" }} />
            <select value={sub.for_employee_id} onChange={(e) => setSub({ ...sub, for_employee_id: e.target.value })} style={{ flex: "1 1 140px" }} aria-label="In place of">
              <option value="">in place of —</option>
              {g.members.map((m) => <option key={m.employee_id} value={m.employee_id}>{m.name}</option>)}
            </select>
            <button className="btn-primary" disabled={busy} onClick={addSub}>Add</button>
            <button onClick={() => setSub(null)}>Cancel</button>
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span>Present <b>{present}</b>{g.min_crew ? <span style={{ color: "var(--slate)" }}> · min {g.min_crew}</span> : null}</span>
        {short ? <span style={{ color: "var(--alert-red)", fontWeight: 600 }}>Short crew</span> : null}
      </div>
      {canEdit && <button className="btn-primary" style={{ height: 48, fontSize: 15, fontWeight: 700 }} disabled={busy} onClick={confirm}>{g.confirmed ? "Confirm again" : "Confirm crew"}</button>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {saved && <div style={{ color: "var(--signal-green)", fontSize: 13 }}>{saved}</div>}
    </div>
  );
}

// Today's pump orders, with the gang on each (the gang is chosen per order).
function PumpOrders({ day, onChanged }) {
  const [data, setData] = useState(null);
  const load = () => apiRequest(`/contract-labour/pump-orders?date=${day}`).then(setData).catch(() => setData({ orders: [] }));
  useEffect(() => { load(); }, [day]);
  if (!data || !data.orders.length) return null;
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontWeight: 700 }}>Pump orders · gang on each</div>
      {data.orders.map((o) => (
        <div key={o.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
          <div style={{ minWidth: 0, fontSize: 13 }}><b>{o.time}</b> · {o.customer_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{o.site_name} · {o.pump_code || o.pump_requirement.replace("_", " ")} · {o.m3} m³</div></div>
          {data.can_edit ? <PumpGangChanger order={o} onChanged={() => { load(); onChanged(); }} /> : <span style={{ fontSize: 13 }}>{o.gang_name || "—"}</span>}
        </div>
      ))}
    </div>
  );
}

export default function GangAttendance() {
  const { can } = usePermissions();
  const [day, setDay] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [ver, setVer] = useState(0);
  const load = () => apiRequest(`/contract-labour/day?date=${day}`).then((d) => { setData(d); setVer((v) => v + 1); }).catch((e) => setError(e.message));
  useEffect(() => { setData(null); setError(""); load(); }, [day]);
  const canEdit = can("hr.gang-attendance", "edit");
  return (
    <>
      <TopBar title="Pump gangs · today" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 16px 32px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 13, color: "var(--slate)" }}>Crews punch the gate machine; their lists arrive ticked. Confirm each gang and fix anyone who went straight to a site.</div>
          <input type="date" value={day} max={todayStr()} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
        </div>
        {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
        {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
        {data && !data.gangs.length && <div className="card" style={{ fontSize: 13 }}>No pump gangs are set up yet.</div>}
        <PumpOrders day={day} onChanged={load} />
        {data && data.gangs.map((g) => <GangCard key={`${g.id}-${ver}`} g={g} day={day} canEdit={canEdit} onSaved={load} />)}
      </div>
    </>
  );
}
