import { Fragment, useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { generateTruckInspectionPdf } from "../lib/truckInspectionPdf.js";

// Round 98 — items 10 (Maintenance module) & 11 (Best Driver of the Month),
// built from the round-97 mockup the business approved. Reuses that
// mockup's exact layout/classes (kanban, meter, stacked-bar, timeline —
// see index.css) now wired to real data instead of sample rows.

const STATUS_BADGE = {
  overdue: { cls: "badge-danger", label: "Overdue" },
  due_soon: { cls: "badge-warning", label: "Due this week" },
  upcoming: { cls: "badge-success", label: "Upcoming" },
  never: { cls: "badge-neutral", label: "Not yet logged" },
  in_workshop: { cls: "badge-progress", label: "In workshop" },
};

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short" });
}

export default function Maintenance() {
  const [tab, setTab] = useState("maintenance"); // 'maintenance' | 'repair_points' | 'driver' | 'site_efficiency'
  const [error, setError] = useState("");

  return (
    <>
      <TopBar title="Maintenance" />
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "0 16px 40px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: "1px solid var(--border-strong)", flexWrap: "wrap" }}>
          <button
            className={`btn-tab ${tab === "maintenance" ? "active" : ""}`}
            style={{ borderRadius: "8px 8px 0 0", borderBottom: "none" }}
            onClick={() => setTab("maintenance")}
          >
            Maintenance module
          </button>
          {/* Round 136 — Repair Action Points: scheduled repairs against a
              specific vehicle/equipment, distinct from the Maintenance
              module's preventive schedule above and from the reactive
              External Repair flow inside it. Its own tab rather than a
              section of "Maintenance module" since it has its own
              add/edit/status lifecycle. */}
          <button
            className={`btn-tab ${tab === "repair_points" ? "active" : ""}`}
            style={{ borderRadius: "8px 8px 0 0", borderBottom: "none" }}
            onClick={() => setTab("repair_points")}
          >
            Repair Action Points
          </button>
          <button
            className={`btn-tab ${tab === "driver" ? "active" : ""}`}
            style={{ borderRadius: "8px 8px 0 0", borderBottom: "none" }}
            onClick={() => setTab("driver")}
          >
            Best Driver of the Month
          </button>
          <button
            className={`btn-tab ${tab === "site_efficiency" ? "active" : ""}`}
            style={{ borderRadius: "8px 8px 0 0", borderBottom: "none" }}
            onClick={() => setTab("site_efficiency")}
          >
            Site Efficiency
          </button>
        </div>

        {tab === "maintenance" && <MaintenanceTab setError={setError} />}
        {tab === "repair_points" && <RepairActionPointsTab setError={setError} />}
        {tab === "driver" && <BestDriverTab setError={setError} />}
        {tab === "site_efficiency" && <SiteEfficiencyTab setError={setError} />}
      </div>
    </>
  );
}

// ===================== MAINTENANCE TAB =====================

function MaintenanceTab({ setError }) {
  const [dashboard, setDashboard] = useState(null);
  const [loggingRow, setLoggingRow] = useState(null); // action_point_id-truck_id key
  const [logForm, setLogForm] = useState({ done_at: "", hours_at_service: "", notes: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setDashboard(await apiRequest("/maintenance/dashboard")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function rowKey(r) { return `${r.truck_id}-${r.action_point_id}`; }

  function startLog(r) {
    setLoggingRow(rowKey(r));
    setLogForm({ done_at: "", hours_at_service: r.current_hours || "", notes: "" });
  }

  async function saveLog(r) {
    setSaving(true); setError("");
    try {
      await apiRequest("/maintenance/logs", {
        method: "POST",
        body: { action_point_id: r.action_point_id, truck_id: r.truck_id, ...logForm },
      });
      setLoggingRow(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  if (!dashboard) return <div className="card">Loading…</div>;
  const { kpis, due_list, in_workshop } = dashboard;

  return (
    <div>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Due list</h2>
      <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 14px", maxWidth: 700, lineHeight: 1.5 }}>
        Every scheduled action point across the active fleet, whichever of days-elapsed or hours-of-operation trips first.
        A truck currently at an external workshop drops off this list (and off Plant Operator's ticket-creation list) automatically.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 }}>
        <div className="kpi"><div className="kpi-label">Overdue</div><div className="kpi-value danger">{kpis.overdue}</div></div>
        <div className="kpi"><div className="kpi-label">Due this week</div><div className="kpi-value" style={{ color: "var(--amber)" }}>{kpis.due_soon}</div></div>
        <div className="kpi"><div className="kpi-label">In workshop</div><div className="kpi-value" style={{ color: "var(--violet)" }}>{kpis.in_workshop}</div></div>
        <div className="kpi"><div className="kpi-label">Avg. turnaround</div><div className="kpi-value">{kpis.avg_turnaround_days != null ? `${kpis.avg_turnaround_days} days` : "—"}</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 22 }}>
        <table>
          <thead>
            <tr><th>Vehicle</th><th>Action point</th><th>Basis</th><th>Last done</th><th>Due</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {due_list.map((r) => {
              const badge = STATUS_BADGE[r.status];
              const key = rowKey(r);
              return (
                <Fragment key={key}>
                  <tr>
                    <td>{r.truck_number}</td>
                    <td>{r.action_name}</td>
                    <td>{[r.interval_days ? `${r.interval_days} days` : null, r.interval_hours ? `${r.interval_hours} hrs` : null, r.interval_qty_m3 ? `${r.interval_qty_m3} m³` : null].filter(Boolean).join(" or ")}</td>
                    <td>{fmtDate(r.last_done_at)}</td>
                    <td>
                      {r.due_date ? fmtDate(r.due_date) : "—"}
                      {r.qty_remaining_m3 != null && (
                        <div style={{ fontSize: 11, color: "var(--slate)" }}>
                          {r.qty_remaining_m3 >= 0 ? `${Number(r.qty_remaining_m3).toFixed(0)} m³ left` : `${Math.abs(Number(r.qty_remaining_m3)).toFixed(0)} m³ over`}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${badge.cls}`}>
                        {badge.label}
                        {r.status === "overdue" && r.days_remaining != null && r.days_remaining < 0 ? ` · ${Math.abs(r.days_remaining)} days` : ""}
                      </span>
                    </td>
                    <td>
                      {loggingRow === key ? null : <button style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => startLog(r)}>Log</button>}
                    </td>
                  </tr>
                  {loggingRow === key && (
                    <tr style={{ background: "var(--concrete)" }}>
                      <td colSpan={7}>
                        <div className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr auto auto", gap: 8, fontSize: 13, padding: "6px 4px", alignItems: "end" }}>
                          <div>
                            <div style={{ color: "var(--slate)" }}>Done on</div>
                            <input type="date" value={logForm.done_at} onChange={(e) => setLogForm({ ...logForm, done_at: e.target.value })} />
                          </div>
                          <div>
                            <div style={{ color: "var(--slate)" }}>Hours (odometer/hour-meter)</div>
                            <input type="number" value={logForm.hours_at_service} onChange={(e) => setLogForm({ ...logForm, hours_at_service: e.target.value })} />
                          </div>
                          <div>
                            <div style={{ color: "var(--slate)" }}>Notes</div>
                            <input value={logForm.notes} onChange={(e) => setLogForm({ ...logForm, notes: e.target.value })} />
                          </div>
                          <button onClick={() => saveLog(r)} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
                          <button type="button" onClick={() => setLoggingRow(null)}>Cancel</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {due_list.length === 0 && <tr><td colSpan={7} style={{ color: "var(--slate)" }}>No action points defined yet — add them from Administrator → Masters → Maintenance Action Points.</td></tr>}
          </tbody>
        </table>
      </div>

      <ExternalRepairKanban setError={setError} inWorkshopFallback={in_workshop} onChanged={load} />
      <VehicleHistory setError={setError} />
    </div>
  );
}

function ExternalRepairKanban({ setError, onChanged }) {
  const [repairs, setRepairs] = useState([]);
  const [busy, setBusy] = useState(null);

  async function load() {
    try { setRepairs(await apiRequest("/maintenance/external-repairs")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function approve(id) {
    const workshop_name = window.prompt("Workshop name (optional):") || undefined;
    setBusy(id); setError("");
    try { await apiRequest(`/maintenance/external-repairs/${id}/approve`, { method: "PATCH", body: { workshop_name } }); load(); onChanged?.(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function reject(id) {
    const rejection_reason = window.prompt("Reason for rejecting this request:");
    if (!rejection_reason) return;
    setBusy(id); setError("");
    try { await apiRequest(`/maintenance/external-repairs/${id}/reject`, { method: "PATCH", body: { rejection_reason } }); load(); onChanged?.(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function sentOut(id, currentWorkshop) {
    const workshop_name = window.prompt("Workshop name:", currentWorkshop || "") || undefined;
    setBusy(id); setError("");
    try { await apiRequest(`/maintenance/external-repairs/${id}/sent-out`, { method: "PATCH", body: { workshop_name } }); load(); onChanged?.(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function returned(id) {
    setBusy(id); setError("");
    try { await apiRequest(`/maintenance/external-repairs/${id}/returned`, { method: "PATCH" }); load(); onChanged?.(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const cols = {
    requested: repairs.filter((r) => r.status === "requested"),
    approved: repairs.filter((r) => r.status === "approved"),
    sent_out: repairs.filter((r) => r.status === "sent_out"),
    returned: repairs.filter((r) => r.status === "returned").slice(0, 6),
  };

  return (
    <div style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>External workshop repair flow</h2>
      <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 14px", maxWidth: 700, lineHeight: 1.5 }}>
        Driver (or, for a loader, Loader Operator) requests, Manager approves, sent-out and returned timestamps logged.
        A truck sits in "Sent out" for as long as it's away — that's exactly what excludes it from the due list and
        Plant Operator's ticket-creation truck list.
      </p>
      <div className="kanban">
        <div className="kanban-col">
          <div className="kanban-col-head">Requested <span className="kanban-count">{cols.requested.length}</span></div>
          {cols.requested.map((r) => (
            <div className="kanban-card" key={r.id}>
              <div className="veh">{r.truck_number || r.equipment_name}</div>
              <div className="meta">{r.issue_description}<br />Requested by {r.requested_by_name} · {fmtDate(r.requested_at)}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button style={{ fontSize: 11, padding: "3px 8px" }} disabled={busy === r.id} onClick={() => approve(r.id)}>Approve</button>
                <button style={{ fontSize: 11, padding: "3px 8px" }} disabled={busy === r.id} onClick={() => reject(r.id)}>Reject</button>
              </div>
            </div>
          ))}
          {cols.requested.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>Nothing waiting.</div>}
        </div>
        <div className="kanban-col">
          <div className="kanban-col-head">Approved <span className="kanban-count">{cols.approved.length}</span></div>
          {cols.approved.map((r) => (
            <div className="kanban-card" key={r.id}>
              <div className="veh">{r.truck_number || r.equipment_name}</div>
              <div className="meta">{r.workshop_name || "Workshop not set yet"}<br />Approved by {r.approved_by_name} · {fmtDate(r.approved_at)}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button style={{ fontSize: 11, padding: "3px 8px" }} disabled={busy === r.id} onClick={() => sentOut(r.id, r.workshop_name)}>Mark sent out</button>
              </div>
            </div>
          ))}
          {cols.approved.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>Nothing here.</div>}
        </div>
        <div className="kanban-col">
          <div className="kanban-col-head">Sent out <span className="kanban-count">{cols.sent_out.length}</span></div>
          {cols.sent_out.map((r) => (
            <div className="kanban-card" key={r.id}>
              <div className="veh">{r.truck_number || r.equipment_name}</div>
              <div className="meta">{r.workshop_name || "—"}<br />Sent {fmtDate(r.sent_out_at)}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button style={{ fontSize: 11, padding: "3px 8px" }} disabled={busy === r.id} onClick={() => returned(r.id)}>Mark returned</button>
              </div>
            </div>
          ))}
          {cols.sent_out.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>Nothing away right now.</div>}
        </div>
        <div className="kanban-col">
          <div className="kanban-col-head">Returned <span className="kanban-count">{cols.returned.length}</span></div>
          {cols.returned.map((r) => (
            <div className="kanban-card" key={r.id}>
              <div className="veh">{r.truck_number || r.equipment_name}</div>
              <div className="meta">Sent {fmtDate(r.sent_out_at)} → Returned {fmtDate(r.returned_at)}</div>
            </div>
          ))}
          {cols.returned.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>None recently.</div>}
        </div>
      </div>
    </div>
  );
}

function VehicleHistory({ setError }) {
  const [trucks, setTrucks] = useState([]);
  const [truckId, setTruckId] = useState("");
  const [history, setHistory] = useState(null);

  useEffect(() => { apiRequest("/master/trucks").then(setTrucks).catch((err) => setError(err.message)); }, []);

  async function pick(id) {
    setTruckId(id);
    if (!id) { setHistory(null); return; }
    try { setHistory(await apiRequest(`/maintenance/vehicle/${id}/history`)); } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Per-vehicle service history</h2>
      <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 12px", maxWidth: 700, lineHeight: 1.5 }}>
        Standard maintenance and external-workshop repairs for one truck, merged into a single timeline.
      </p>
      <div className="field-input" style={{ maxWidth: 260, marginBottom: 12 }}>
        <select value={truckId} onChange={(e) => pick(e.target.value)}>
          <option value="">Select a vehicle</option>
          {trucks.map((t) => <option key={t.id} value={t.id}>{t.truck_number}</option>)}
        </select>
      </div>
      {history && (
        <div className="card">
          {history.length === 0 ? (
            <div style={{ color: "var(--slate)", fontSize: 13 }}>No maintenance or repair history logged for this vehicle yet.</div>
          ) : (
            <div className="timeline">
              {history.map((h, i) => (
                <div className="timeline-item" key={i}>
                  <div className="timeline-dot" style={{ background: h.type === "external_repair" ? "var(--violet)" : "var(--signal-green)" }}></div>
                  <div className="timeline-date">{fmtDate(h.date)}{h.end_date ? ` – ${fmtDate(h.end_date)}` : ""}</div>
                  <div className="timeline-action">{h.title}</div>
                  {h.meta && <div className="timeline-meta">{h.meta}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===================== REPAIR ACTION POINTS TAB (Round 136) =====================
// Scheduled repairs raised against a specific vehicle/equipment as a need
// comes up (a driveshaft that needs replacing next month, a hydraulic hose
// on a loader) — distinct from the Maintenance module's own preventive
// due-list above and from the reactive External Repair kanban nested inside
// it. Backed by /maintenance/repair-action-points (see maintenance.js).

const REPAIR_STATUS_BADGE = {
  pending: { cls: "badge-neutral", label: "Pending" },
  scheduled: { cls: "badge-info", label: "Scheduled" },
  in_progress: { cls: "badge-progress", label: "In progress" },
  completed: { cls: "badge-success", label: "Completed" },
  cancelled: { cls: "badge-danger", label: "Cancelled" },
};

const REPAIR_STATUS_OPTIONS = ["pending", "scheduled", "in_progress", "completed", "cancelled"];

const EMPTY_REPAIR_FORM = { target_type: "truck", target_id: "", description: "", repair_type: "internal", scheduled_date: "", notes: "" };

function RepairActionPointsTab({ setError }) {
  const [points, setPoints] = useState([]);
  const [trucks, setTrucks] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [form, setForm] = useState(EMPTY_REPAIR_FORM);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      const [pts, tr, eq] = await Promise.all([
        apiRequest("/maintenance/repair-action-points"),
        apiRequest("/master/trucks"),
        apiRequest("/master/equipment"),
      ]);
      setPoints(pts); setTrucks(tr); setEquipment(eq);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function addPoint(e) {
    e.preventDefault();
    if (!form.target_id) { setError("Pick a vehicle or piece of equipment."); return; }
    if (!form.description.trim()) { setError("A description is required."); return; }
    setSaving(true); setError("");
    try {
      await apiRequest("/maintenance/repair-action-points", {
        method: "POST",
        body: {
          truck_id: form.target_type === "truck" ? form.target_id : null,
          equipment_id: form.target_type === "equipment" ? form.target_id : null,
          description: form.description.trim(),
          repair_type: form.repair_type,
          scheduled_date: form.scheduled_date || null,
          notes: form.notes.trim() || null,
        },
      });
      setForm(EMPTY_REPAIR_FORM);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function changeStatus(id, status) {
    setBusy(id); setError("");
    try { await apiRequest(`/maintenance/repair-action-points/${id}`, { method: "PATCH", body: { status } }); load(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function sendExternal(id) {
    setBusy(id); setError("");
    try { await apiRequest(`/maintenance/repair-action-points/${id}/send-external`, { method: "POST" }); load(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function removePoint(id) {
    if (!window.confirm("Delete this repair action point? This can't be undone.")) return;
    setBusy(id); setError("");
    try { await apiRequest(`/maintenance/repair-action-points/${id}`, { method: "DELETE" }); load(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const targetOptions = form.target_type === "truck" ? trucks : equipment;

  return (
    <div>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Repair Action Points</h2>
      <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 14px", maxWidth: 700, lineHeight: 1.5 }}>
        Repairs raised against a specific vehicle or piece of equipment as a need comes up — track it to completion here,
        or, for an External-type point, send it into the same approve → sent-out → returned workshop flow used above.
      </p>

      <form onSubmit={addPoint} className="card" style={{ marginBottom: 18 }}>
        <div className="field-input" style={{ display: "grid", gridTemplateColumns: "auto 1.4fr 2fr auto auto auto", gap: 8, alignItems: "end" }}>
          <div>
            <div style={{ color: "var(--slate)", fontSize: 12 }}>For</div>
            <select
              value={form.target_type}
              onChange={(e) => setForm({ ...form, target_type: e.target.value, target_id: "" })}
            >
              <option value="truck">Vehicle</option>
              <option value="equipment">Equipment</option>
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)", fontSize: 12 }}>{form.target_type === "truck" ? "Vehicle" : "Equipment"}</div>
            <select value={form.target_id} onChange={(e) => setForm({ ...form, target_id: e.target.value })}>
              <option value="">Select…</option>
              {targetOptions.map((o) => (
                <option key={o.id} value={o.id}>{form.target_type === "truck" ? o.truck_number : o.name}</option>
              ))}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)", fontSize: 12 }}>Description</div>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. Replace hydraulic hose, front boom"
            />
          </div>
          <div>
            <div style={{ color: "var(--slate)", fontSize: 12 }}>Type</div>
            <select value={form.repair_type} onChange={(e) => setForm({ ...form, repair_type: e.target.value })}>
              <option value="internal">Internal</option>
              <option value="external">External</option>
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)", fontSize: 12 }}>Scheduled for</div>
            <input type="date" value={form.scheduled_date} onChange={(e) => setForm({ ...form, scheduled_date: e.target.value })} />
          </div>
          <button type="submit" disabled={saving}>{saving ? "Adding…" : "Add"}</button>
        </div>
        <div className="field-input" style={{ marginTop: 8 }}>
          <input
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Notes (optional)"
          />
        </div>
      </form>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr><th>Vehicle / Equipment</th><th>Description</th><th>Type</th><th>Scheduled</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {points.map((r) => {
              const badge = REPAIR_STATUS_BADGE[r.status];
              const isBusy = busy === r.id;
              const canSendExternal = r.repair_type === "external" && !r.external_repair_id && r.status !== "completed" && r.status !== "cancelled";
              return (
                <tr key={r.id}>
                  <td>{r.truck_number || r.equipment_name || "—"}</td>
                  <td>
                    {r.description}
                    {r.notes && <div style={{ fontSize: 11, color: "var(--slate)" }}>{r.notes}</div>}
                    {r.external_repair_id && (
                      <div style={{ fontSize: 11, color: "var(--violet)" }}>
                        External workshop: {r.external_workshop_name || r.external_repair_status}
                      </div>
                    )}
                  </td>
                  <td><span className={`badge ${r.repair_type === "external" ? "badge-violet" : "badge-neutral"}`}>{r.repair_type === "external" ? "External" : "Internal"}</span></td>
                  <td>{fmtDate(r.scheduled_date)}</td>
                  <td>
                    <span className={`badge ${badge.cls}`}>{badge.label}</span>
                    {r.completed_by_name && r.status === "completed" && (
                      <div style={{ fontSize: 11, color: "var(--slate)" }}>by {r.completed_by_name} · {fmtDate(r.completed_at)}</div>
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <select
                        style={{ fontSize: 11, padding: "3px 6px" }}
                        value={r.status}
                        disabled={isBusy}
                        onChange={(e) => changeStatus(r.id, e.target.value)}
                      >
                        {REPAIR_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{REPAIR_STATUS_BADGE[s].label}</option>)}
                      </select>
                      {canSendExternal && (
                        <button style={{ fontSize: 11, padding: "3px 8px" }} disabled={isBusy} onClick={() => sendExternal(r.id)}>
                          Send to workshop
                        </button>
                      )}
                      <button style={{ fontSize: 11, padding: "3px 8px" }} disabled={isBusy} onClick={() => removePoint(r.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {points.length === 0 && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No repair action points yet — add one above.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===================== BEST DRIVER TAB =====================

const COMPONENT_COLORS = {
  checklist: "var(--rebar)",
  on_time: "var(--violet)",
  quality: "var(--signal-green)",
  volume: "var(--amber)",
  fuel: "var(--info)",
};

function BestDriverTab({ setError }) {
  const [data, setData] = useState(null);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    try { setData(await apiRequest("/maintenance/best-driver")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  if (!data) return <div className="card">Loading…</div>;
  const winner = data.ranked[0];
  const w = data.weights;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>
            {new Date(data.year, data.month - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" })} — Best Driver of the Month
          </h2>
          <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 14px", maxWidth: 640, lineHeight: 1.5 }}>
            Composite of the weekly Transit Mixer inspection checklist, transit efficiency, load-quality, completed-trip volume,
            and fuel economy. No minimum trip count — every driver is eligible regardless of volume.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ New weekly inspection</button>
      </div>

      {showForm && <InspectionForm setError={setError} onCancel={() => setShowForm(false)} onDone={() => { setShowForm(false); load(); }} />}

      {winner ? (
        <div className="spotlight" style={{ marginBottom: 18 }}>
          <div className="spotlight-badge">🏆</div>
          <div>
            <div className="spotlight-name">{winner.driver_name}</div>
            <div className="spotlight-sub">{winner.trip_count} trip{winner.trip_count === 1 ? "" : "s"} this month</div>
          </div>
          <div className="spotlight-score">
            <div className="num">{winner.composite_score}</div>
            <div className="lbl">Composite score</div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 18, color: "var(--slate)", fontSize: 13 }}>
          No driver has both a completed trip and a weekly checklist logged yet this month.
        </div>
      )}

      <div className="open-q" style={{ marginBottom: 18 }}>
        <b>Weighting (confirmed round 99, fuel added round 137):</b> Checklist {Math.round(w.checklist * 100)}% ·
        Transit efficiency {Math.round(w.on_time * 100)}% · Quality {Math.round(w.quality * 100)}% · Volume {Math.round(w.volume * 100)}% ·
        Fuel economy {Math.round(w.fuel * 100)}%.
        Transit efficiency scores only the two legs that are actually on the driver — plant-out → site-in, and site-out → plant-in —
        compared against other drivers who visited the <i>same site</i> that month. Time spent waiting/pouring at site is excluded, since
        that depends on site conditions, not the driver. See the <b>Site Efficiency</b> tab for the per-site breakdown behind this score.
        Fuel economy compares each driver's fuel use per m³ delivered (the truck(s) they drove that month, weighted by trip volume)
        against the fleet average — see the <b>360° Fuel Analysis</b> report for the underlying figures.
      </div>

      {data.ranked.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Leaderboard</h2>
          <div className="legend">
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.checklist }}></span>Checklist ({Math.round(w.checklist * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.on_time }}></span>Transit efficiency ({Math.round(w.on_time * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.quality }}></span>Quality ({Math.round(w.quality * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.volume }}></span>Volume ({Math.round(w.volume * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.fuel }}></span>Fuel economy ({Math.round(w.fuel * 100)}%)</span>
          </div>
          <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}>
            <table>
              <thead>
                <tr><th></th><th>Driver</th><th>Composite</th><th style={{ width: 200 }}>Breakdown</th><th>Checklist</th><th>Transit eff.</th><th>Quality</th><th>Volume</th><th>Fuel</th></tr>
              </thead>
              <tbody>
                {data.ranked.map((d, i) => (
                  <tr key={d.driver_id}>
                    <td style={{ fontWeight: 700, color: i === 0 ? "var(--rebar)" : "var(--slate)" }}>{i + 1}</td>
                    <td style={{ fontWeight: i === 0 ? 600 : 400 }}>{d.driver_name}</td>
                    <td style={{ fontWeight: 700, fontSize: 14 }}>{d.composite_score}</td>
                    <td>
                      <div className="stack-bar">
                        <div className="stack-seg" style={{ background: COMPONENT_COLORS.checklist, width: `${w.checklist * 100}%` }}></div>
                        {d.on_time_score != null && <div className="stack-seg" style={{ background: COMPONENT_COLORS.on_time, width: `${w.on_time * 100}%` }}></div>}
                        <div className="stack-seg" style={{ background: COMPONENT_COLORS.quality, width: `${w.quality * 100}%` }}></div>
                        <div className="stack-seg" style={{ background: COMPONENT_COLORS.volume, width: `${w.volume * 100}%` }}></div>
                        {d.fuel_score != null && <div className="stack-seg" style={{ background: COMPONENT_COLORS.fuel, width: `${w.fuel * 100}%` }}></div>}
                      </div>
                    </td>
                    <td>{d.checklist_score}</td>
                    <td>{d.on_time_score ?? "—"}</td>
                    <td>{d.quality_score}</td>
                    <td>{d.volume_score}</td>
                    <td title={d.fuel_litres_per_m3 != null ? `${d.fuel_litres_per_m3} L/m³` : undefined}>{d.fuel_score ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data.unranked.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Not yet ranked this month</div>
          {data.unranked.map((d) => (
            <div key={d.driver_id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--concrete)" }}>
              <span>{d.driver_name}</span>
              <span style={{ color: "var(--slate)" }}>{d.reason}</span>
            </div>
          ))}
        </div>
      )}

      <InspectionActionItemsPanel setError={setError} />
      <PastInspectionsPanel setError={setError} />
    </div>
  );
}

// Round 133 — the weekly checklist itself had no way to be looked back at
// or printed after saving (only the "+ New weekly inspection" form and the
// leaderboard existed) — a Plant In-Charge who fills these out on paper
// today needs a printable copy for their own records/signature, matching
// the business's own TM_Check_list_for_Plant_Incharge.pdf template. Reuses
// the existing GET /maintenance/inspections list (already returns each
// row's full ratings + observations, so no separate detail fetch is
// needed) and GET /maintenance/checklist-definition (already fetched by
// InspectionForm above, for the section/item/scale structure the PDF
// needs to make sense of a row's raw ratings object).
function PastInspectionsPanel({ setError }) {
  const [rows, setRows] = useState(null);
  const [def, setDef] = useState(null);
  const [printing, setPrinting] = useState(null);

  useEffect(() => {
    Promise.all([
      apiRequest("/maintenance/inspections"),
      apiRequest("/maintenance/checklist-definition"),
    ]).then(([r, d]) => { setRows(r); setDef(d); }).catch((err) => setError(err.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function printRow(row) {
    setPrinting(row.id);
    try {
      await generateTruckInspectionPdf(row, def);
    } catch (err) {
      setError(err.message);
    } finally {
      setPrinting(null);
    }
  }

  if (rows === null) return null;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Past weekly inspections</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No weekly inspections logged yet.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Date</th><th>Vehicle</th><th>Driver</th><th>Cleaner</th><th>Checklist score</th><th>Filled by</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.inspection_date)}</td>
                <td>{r.truck_number}</td>
                <td>{r.driver_name || "—"}</td>
                <td>{r.cleaner_name || "—"}</td>
                <td>{r.checklist_score ?? "—"}</td>
                <td>{r.filled_by_name}</td>
                <td>
                  <button type="button" style={{ fontSize: 11, padding: "3px 8px" }} disabled={!def || printing === r.id} onClick={() => printRow(r)}>
                    {printing === r.id ? "..." : "Print"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Round 101, item 2 — "Action required" remarks against individual checklist
// items on the weekly inspection, tracked here as open maintenance action
// items until Manager marks them resolved.
function InspectionActionItemsPanel({ setError }) {
  const [items, setItems] = useState([]);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function load(status) {
    try { setItems(await apiRequest(`/maintenance/action-items?status=${status}`)); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(showResolved ? "resolved" : "open"); }, [showResolved]);

  async function resolve(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/maintenance/action-items/${id}/resolve`, { method: "PATCH", body: { resolution_notes: notes || undefined } });
      setResolvingId(null); setNotes("");
      load(showResolved ? "resolved" : "open");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Action items from weekly inspections</div>
        <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setShowResolved(!showResolved)}>
          {showResolved ? "Show open" : "Show resolved"}
        </button>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>
          {showResolved ? "No resolved action items yet." : "No open action items — nothing flagged on recent checklists."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 12.5 }}>
            <thead>
              <tr><th>Vehicle</th><th>Inspection date</th><th>Item</th><th>Remark</th><th>Raised by</th>{showResolved ? <><th>Resolved by</th><th>Notes</th></> : <th></th>}</tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.truck_number}</td>
                  <td>{fmtDate(it.inspection_date)}</td>
                  <td>{it.item_label}</td>
                  <td>{it.remark}</td>
                  <td>{it.raised_by_name}</td>
                  {showResolved ? (
                    <>
                      <td>{it.resolved_by_name}</td>
                      <td>{it.resolution_notes || "–"}</td>
                    </>
                  ) : resolvingId === it.id ? (
                    <td style={{ display: "flex", gap: 4 }}>
                      <input placeholder="Resolution notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontSize: 11, width: 140 }} />
                      <button onClick={() => resolve(it.id)} disabled={saving}>Save</button>
                      <button onClick={() => { setResolvingId(null); setNotes(""); }}>Cancel</button>
                    </td>
                  ) : (
                    <td><button style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setResolvingId(it.id)}>Resolve</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ===================== SITE EFFICIENCY TAB (round 99) =====================
// Per-site breakdown behind the Best Driver "Transit efficiency" component —
// business asked to be able to see, for a given site, how each driver's
// plant-out/site-in and site-out/plant-in times compare, since travel time
// depends heavily on which site a driver was sent to.

function fmtMin(m) {
  if (m == null) return "—";
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

function SiteEfficiencyTab({ setError }) {
  const [data, setData] = useState(null);

  async function load() {
    try { setData(await apiRequest("/maintenance/site-efficiency")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  if (!data) return <div className="card">Loading…</div>;

  return (
    <div>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>
        {new Date(data.year, data.month - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" })} — Site Efficiency
      </h2>
      <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 14px", maxWidth: 680, lineHeight: 1.5 }}>
        For each site, average time each driver took on the plant-out → site-in and site-out → plant-in legs only
        (site dwell time excluded — that's site conditions, not the driver). "vs site avg" is positive when a driver
        is faster than the average of everyone who delivered to that site this month. A site needs at least two
        trips (from any drivers) this month before a comparison is shown.
      </p>

      {data.sites.length === 0 ? (
        <div className="card" style={{ color: "var(--slate)", fontSize: 13 }}>No comparable transit data yet this month.</div>
      ) : (
        data.sites.map((site) => (
          <div key={site.site_id} className="card" style={{ marginBottom: 14, padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{site.site_name}</div>
              <div style={{ fontSize: 12, color: "var(--slate)" }}>{site.trip_count} trip{site.trip_count === 1 ? "" : "s"} · site avg {fmtMin(site.site_avg_total_min)}</div>
            </div>
            <table>
              <thead>
                <tr><th></th><th>Driver</th><th>Trips</th><th>Avg out (plant→site)</th><th>Avg return (site→plant)</th><th>Avg total</th><th>vs site avg</th></tr>
              </thead>
              <tbody>
                {site.drivers.map((d, i) => (
                  <tr key={d.driver_id}>
                    <td style={{ fontWeight: 700, color: i === 0 ? "var(--signal-green)" : "var(--slate)" }}>{i + 1}</td>
                    <td style={{ fontWeight: i === 0 ? 600 : 400 }}>{d.driver_name}</td>
                    <td>{d.trip_count}</td>
                    <td>{fmtMin(d.avg_out_min)}</td>
                    <td>{fmtMin(d.avg_return_min)}</td>
                    <td style={{ fontWeight: 600 }}>{fmtMin(d.avg_total_min)}</td>
                    <td>
                      {d.vs_site_avg_pct == null ? (
                        <span style={{ color: "var(--slate)" }}>—</span>
                      ) : (
                        <span className={`badge ${d.vs_site_avg_pct >= 0 ? "badge-success" : "badge-danger"}`}>
                          {d.vs_site_avg_pct >= 0 ? "+" : ""}{d.vs_site_avg_pct}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}

function InspectionForm({ setError, onCancel, onDone }) {
  const [def, setDef] = useState(null);
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [truckId, setTruckId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [cleanerName, setCleanerName] = useState("");
  const [inspectionDate, setInspectionDate] = useState("");
  // Round 134, item 3
  const [odometerReading, setOdometerReading] = useState("");
  const [hourMeterReading, setHourMeterReading] = useState("");
  const [ratings, setRatings] = useState({});
  const [actionRequired, setActionRequired] = useState({}); // item_key -> remark text
  const [observations, setObservations] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      apiRequest("/maintenance/checklist-definition"),
      apiRequest("/master/trucks"),
      apiRequest("/master/drivers"),
    ]).then(([d, t, dr]) => { setDef(d); setTrucks(t); setDrivers(dr); }).catch((err) => setError(err.message));
  }, []);

  function setRating(itemKey, value) {
    setRatings((r) => ({ ...r, [itemKey]: value }));
  }

  function setActionRemark(itemKey, value) {
    setActionRequired((a) => ({ ...a, [itemKey]: value }));
  }

  const totalItems = def ? def.sections.reduce((s, sec) => s + sec.items.length, 0) : 0;
  const scoredItems = Object.keys(ratings).length;

  async function submit(e) {
    e.preventDefault();
    if (!truckId) return setError("Select a vehicle.");
    if (scoredItems < totalItems) return setError(`${totalItems - scoredItems} checklist item(s) still need a rating.`);
    setSaving(true); setError("");
    try {
      const itemLabels = {};
      def.sections.forEach((sec) => sec.items.forEach((item) => { itemLabels[item.key] = item.label; }));
      const action_items = Object.entries(actionRequired)
        .filter(([, remark]) => remark && remark.trim())
        .map(([item_key, remark]) => ({ item_key, item_label: itemLabels[item_key] || item_key, remark: remark.trim() }));
      await apiRequest("/maintenance/inspections", {
        method: "POST",
        body: {
          truck_id: truckId, driver_id: driverId || undefined, cleaner_name: cleanerName || undefined,
          inspection_date: inspectionDate || undefined, odometer_reading: odometerReading || undefined,
          hour_meter_reading: hourMeterReading || undefined, ratings, observations, action_items,
        },
      });
      onDone();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  if (!def) return <div className="card" style={{ marginBottom: 18 }}>Loading checklist…</div>;

  return (
    <form onSubmit={submit} className="card" style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Transit Mixer Weekly Inspection Checklist</div>
        <div style={{ fontSize: 12, color: "var(--slate)" }}>{scoredItems}/{totalItems} scored</div>
      </div>

      <div className="field-input" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 10, marginBottom: 16, fontSize: 13 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Vehicle No.</div>
          <select value={truckId} onChange={(e) => setTruckId(e.target.value)} required>
            <option value="">Select</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.truck_number}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Driver Name</div>
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">Select</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Cleaner Name</div>
          <input value={cleanerName} onChange={(e) => setCleanerName(e.target.value)} />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Date</div>
          <input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Odometer reading</div>
          <input type="number" value={odometerReading} onChange={(e) => setOdometerReading(e.target.value)} placeholder="45210" />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Hour meter reading</div>
          <input type="number" value={hourMeterReading} onChange={(e) => setHourMeterReading(e.target.value)} placeholder="1287" />
        </div>
      </div>

      {def.sections.map((sec) => {
        // Round 133 — Safety & Documentation's items each carry their own
        // scale (Available/Not Available, Working/Not Working, Yes/No —
        // see inspectionChecklist.js) instead of every item in the section
        // sharing the same Poor..Very Good columns, so the response options
        // are rendered per-row rather than as shared table-header columns
        // (a section can mix item.scale with the default def.rating_scale).
        return (
        <div key={sec.key} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, color: "var(--charcoal)" }}>{sec.title}</div>
          <table>
            <thead>
              <tr>
                <th>Inspection item</th>
                <th>Response</th>
                <th>Action required</th>
              </tr>
            </thead>
            <tbody>
              {sec.items.map((item) => {
                const scale = item.scale || def.rating_scale;
                return (
                <tr key={item.key}>
                  <td>{item.label}</td>
                  <td>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {scale.map((r) => (
                        <label key={r.value} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12.5, cursor: "pointer" }}>
                          <input
                            type="radio"
                            name={item.key}
                            checked={ratings[item.key] === r.value}
                            onChange={() => setRating(item.key, r.value)}
                          />
                          {r.label}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <input
                      type="text"
                      placeholder="Remark, if action is needed"
                      value={actionRequired[item.key] || ""}
                      onChange={(e) => setActionRemark(item.key, e.target.value)}
                      style={{ width: "100%", fontSize: 12 }}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        );
      })}

      <div className="field-input" style={{ marginBottom: 14 }}>
        <div style={{ color: "var(--slate)", fontSize: 13 }}>Observations / Corrective action required</div>
        <textarea rows={3} value={observations} onChange={(e) => setObservations(e.target.value)} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save inspection"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
