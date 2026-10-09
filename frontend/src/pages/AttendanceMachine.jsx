// Round 195 — the attendance machine (eSSL K30), as the app receives it.
//
// Three tabs:
//   Day      who punched on one attendance day, first and last punch
//   Users    everyone enrolled on the machine and when they last punched
//   Sync     is the agent reading the machine, and what did it last say
//
// Raw data only. Present / Half day / Absent and the link from a machine ID to
// an employee come with the HR module; this screen exists so the plant can see
// the machine's punches arriving and check them against eTimeTrackLite.
import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

function istToday() {
  // The attendance day changes at 04:00 IST, the same rule the server uses.
  const d = new Date(Date.now() - 4 * 3600_000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function shiftDay(date, by) {
  const d = new Date(date + "T12:00:00+05:30");
  d.setDate(d.getDate() + by);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function ago(ts) {
  if (!ts) return "never";
  const min = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function fmtTs(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function span(min) {
  if (min == null) return "—";
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} m`;
}

function MachineHeader({ status }) {
  if (!status) return null;
  const dev = status.devices[0];
  const staleMin = dev?.last_read_ok_at ? (Date.now() - new Date(dev.last_read_ok_at).getTime()) / 60000 : Infinity;
  const live = staleMin < 20;
  const badge = !dev ? ["badge-neutral", "Not connected yet"]
    : live ? ["badge-success", "Live"]
    : dev.last_error ? ["badge-danger", "Can't read machine"]
    : ["badge-warning", "Stale"];
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{dev ? (dev.label || "Attendance machine") : "Attendance machine"}</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>
            {dev ? `${dev.model || "eSSL"} · ${dev.ip || "—"} · serial ${dev.serial}` : "No reading received from the agent yet."}
          </div>
        </div>
        <span className={`badge ${badge[0]}`}>{badge[1]}</span>
      </div>
      {!status.key_configured && (
        <div style={{ marginTop: 10, fontSize: 12.5, background: "var(--alert-red-bg)", color: "var(--alert-red)", padding: "8px 10px", borderRadius: 8 }}>
          ATTENDANCE_API_KEY is not set on the server, so the agent's readings are refused. Set it in the backend environment.
        </div>
      )}
      {dev && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 14 }}>
          <div><div className="kpi-label">Last read</div><div style={{ fontWeight: 700 }}>{ago(dev.last_read_ok_at)}</div></div>
          <div><div className="kpi-label">Today</div><div style={{ fontWeight: 700 }}>{status.today.punches} punches · {status.today.people} people</div></div>
          <div><div className="kpi-label">In the app</div><div style={{ fontWeight: 700 }}>{status.totals.punches.toLocaleString("en-IN")} punches</div><div style={{ fontSize: 11, color: "var(--slate)" }}>since {status.totals.first_day || "—"}</div></div>
          <div><div className="kpi-label">On the machine</div><div style={{ fontWeight: 700 }}>{dev.record_count ?? "—"} punches · {dev.user_count ?? "—"} users</div>{dev.record_capacity ? <div style={{ fontSize: 11, color: "var(--slate)" }}>{Math.round((dev.record_count / dev.record_capacity) * 100)}% of {dev.record_capacity.toLocaleString("en-IN")} capacity</div> : null}</div>
          <div><div className="kpi-label">Machine clock</div><div style={{ fontWeight: 700, color: Math.abs(dev.clock_drift_min || 0) >= 5 ? "var(--alert-red)" : undefined }}>{dev.clock_drift_min == null ? "—" : Math.abs(dev.clock_drift_min) < 1 ? "Correct" : `${Math.abs(dev.clock_drift_min)} min ${dev.clock_drift_min > 0 ? "fast" : "slow"}`}</div></div>
        </div>
      )}
      {dev?.last_error && !live && (
        <div style={{ marginTop: 10, fontSize: 12.5, background: "var(--amber-bg)", color: "var(--amber)", padding: "8px 10px", borderRadius: 8 }}>
          Last problem ({fmtTs(dev.last_error_at)}): {dev.last_error}
        </div>
      )}
    </div>
  );
}

function DayTab() {
  const [date, setDate] = useState(istToday());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  useEffect(() => {
    setData(null); setError("");
    apiRequest(`/attendance/day?date=${date}`).then(setData).catch((e) => setError(e.message));
  }, [date]);
  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <button onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">&larr;</button>
        <div className="field-input"><input type="date" value={date} max={istToday()} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
        <button onClick={() => setDate(shiftDay(date, 1))} disabled={date >= istToday()} aria-label="Next day">&rarr;</button>
        {data && (
          <span style={{ fontSize: 12.5, color: "var(--slate)", marginLeft: 6 }}>
            {data.people.length} people punched{data.single_punch ? ` · ${data.single_punch} with only one punch` : ""}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8 }}>
        A day runs 04:00 to 04:00, so a night shift stays on the day it started. Raw punches — attendance rules are applied in the HR module.
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {!data && !error && <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && !data.people.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>No punches on this day.</div>}
      {data && data.people.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Machine ID</th><th>Name on machine</th><th>First</th><th>Last</th><th>Between</th><th style={{ textAlign: "right" }}>Punches</th></tr></thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.machine_user_id} onClick={() => setOpen(open === p.machine_user_id ? null : p.machine_user_id)} style={{ cursor: "pointer" }}>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{p.machine_user_id}</td>
                  <td>{p.name_on_machine || <span style={{ color: "var(--slate)" }}>—</span>}
                    {open === p.machine_user_id && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>{p.all_punches}</div>}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{p.first_punch}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{p.punches > 1 ? p.last_punch + (p.last_date !== p.first_date ? " (+1)" : "") : <span className="badge badge-warning">only one</span>}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{span(p.span_min)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.punches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UsersTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest("/attendance/machine-users").then(setRows).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!rows) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  return (
    <div className="card">
      <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>
        Everyone enrolled on the machine, under the number they were enrolled with. Linking these numbers to employees is part of the HR module.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Machine ID</th><th>Name on machine</th><th>Last punch</th><th style={{ textAlign: "right" }}>Days punched (30 days)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.machine_user_id}>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.machine_user_id}{r.privilege ? <span className="chip" style={{ marginLeft: 6 }}>machine admin</span> : null}</td>
                <td>{r.name_on_machine || <span style={{ color: "var(--slate)" }}>—</span>}</td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.last_punch || <span style={{ color: "var(--slate)" }}>never</span>}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.days_30d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SyncTab({ status }) {
  if (!status) return null;
  return (
    <div className="card">
      <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>
        The agent on the plant PC reads the machine every 5 minutes and reports here, even when there is nothing new.
      </div>
      {!status.sync_log.length ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing received yet. Install the agent (tools/essl-agent) and run <code>npm run once</code>.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Received</th><th>Agent</th><th style={{ textAlign: "right" }}>Sent</th><th style={{ textAlign: "right" }}>New</th><th>Problem</th></tr></thead>
            <tbody>
              {status.sync_log.map((l, i) => (
                <tr key={i}>
                  <td>{fmtTs(l.received_at)}</td>
                  <td>{l.agent_version || "—"}</td>
                  <td style={{ textAlign: "right" }}>{l.punches_sent}</td>
                  <td style={{ textAlign: "right" }}>{l.punches_inserted}</td>
                  <td style={{ fontSize: 12, color: l.error ? "var(--alert-red)" : "var(--slate)" }}>{l.error || (l.punches_rejected ? `${l.punches_rejected} rejected` : "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AttendanceMachine() {
  const [tab, setTab] = useState("day");
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => apiRequest("/attendance/status").then(setStatus).catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <TopBar title="Attendance Machine" />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <MachineHeader status={status} />
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {[["day", "Day"], ["users", "Machine users"], ["sync", "Sync log"]].map(([k, l]) => (
            <button key={k} className={`btn-tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === "day" && <DayTab />}
        {tab === "users" && <UsersTab />}
        {tab === "sync" && <SyncTab status={status} />}
      </div>
    </>
  );
}
