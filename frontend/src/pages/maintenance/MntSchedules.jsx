// Round 215 — PM schedules. Starting schedules were researched from the
// manufacturers' guidance for the owner's fleet (18 Oct 2026); each carries
// where its interval came from. Only the Administrator edits or deletes
// (mnt.schedules edit / delete), with an Undo straight after a delete.
// Round 215c — schedules are planned per MODEL (Tata Signa, Prima …); every
// vehicle of the model gets them, and "last done" is kept per vehicle.
// Round 242 (owner, 26 Oct 2026: "PM Schedules to be grouped with vehicles")
// — opens By vehicle: each vehicle with every schedule that applies to it,
// its status (overdue / due soon …), what is left and when it was last done.
// The By model view (where schedules are planned and edited) stays.
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/AuthContext.jsx";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, Badge, BASIS, PM_STATUS, fmtDate, fmtNum, H2, MUTED, ROW, GRID, Field, SMALL_BTN } from "./mntUi.jsx";

const TRIGGERS = [
  ["day", "Every N days"], ["week", "Every N weeks"], ["month", "Every N months"],
  ["km", "Every N km"], ["hours", "Every N hours"], ["m3", "Every N m³ carried"], ["once_km", "Once at N km"],
];

function blank(modelId) {
  return { name: "", trigger_type: "km", every: "", or_months: "", or_days: "", or_hours: "", basis: "PRACTICE", note: "", checklist: [""], tasks: [{ task: "", parts: "" }], model_ids: modelId ? [modelId] : [] };
}
const lastDoneText = (sa) => `${sa?.last_done_date ? fmtDate(sa.last_done_date) : "not recorded"}${sa?.last_done_km != null ? ` · ${fmtNum(sa.last_done_km)} km` : ""}${sa?.last_done_hours != null ? ` · ${fmtNum(sa.last_done_hours)} h` : ""}`;

export default function MntSchedules() {
  const { can } = usePermissions();
  const sched = useLoad("/maintenance-module/schedules");
  const models = useLoad("/maintenance-module/models");
  const due = useLoad("/maintenance-module/due");
  const [view, setView] = useState("vehicle");
  const [assetId, setAssetId] = useState(null);
  const [vq, setVq] = useState("");
  const [modelId, setModelId] = useState(null);
  const [open, setOpen] = useState(null); // schedule id showing its vehicles
  const [edit, setEdit] = useState(null);       // form object
  const [baseline, setBaseline] = useState(null); // { schedule_id, asset_id, ... }
  const [deleted, setDeleted] = useState(null);
  const act = useAction(() => { sched.load(); due.load(); });
  const canEdit = can("mnt.schedules", "edit");
  const canCreate = can("mnt.schedules", "create");
  const canDelete = can("mnt.schedules", "delete");

  const byModel = useMemo(() => {
    const m = {};
    for (const s of sched.data || []) for (const x of s.models) (m[x.model_id] = m[x.model_id] || []).push(s);
    return m;
  }, [sched.data]);

  // Round 242 — every vehicle with its schedules (from the due list).
  const vehicles = useMemo(() => {
    const byId = new Map();
    const modelOf = new Map();
    for (const s of sched.data || []) for (const a of s.assets) modelOf.set(a.asset_id, a.model_id);
    for (const r of due.data || []) {
      if (!byId.has(r.asset_id)) byId.set(r.asset_id, { asset_id: r.asset_id, name: r.asset_name, group: r.asset_group, model_id: modelOf.get(r.asset_id), km: r.km, hours: r.hours, rows: [] });
      byId.get(r.asset_id).rows.push(r);
    }
    const list = [...byId.values()];
    for (const v of list) {
      v.overdue = v.rows.filter((r) => r.status === "overdue").length;
      v.soon = v.rows.filter((r) => r.status === "due_soon").length;
      v.never = v.rows.filter((r) => r.status === "never").length;
    }
    return list.sort((a, b) => (b.overdue - a.overdue) || (b.soon - a.soon) || a.name.localeCompare(b.name, "en", { numeric: true }));
  }, [due.data, sched.data]);

  if (!sched.data || !models.data) return <Loading error={sched.error || models.error} />;
  const allModels = models.data.models;
  const mId = modelId || allModels[0]?.id;
  const model = allModels.find((x) => x.id === mId);
  const list = byModel[mId] || [];

  function openEdit(s) {
    setBaseline(null);
    setEdit(s ? {
      id: s.id, name: s.name, trigger_type: s.trigger_type, every: s.every, or_months: s.or_months || "", or_days: s.or_days || "", or_hours: s.or_hours || "",
      basis: s.basis, note: s.note || "", checklist: s.checklist.length ? s.checklist : [""], tasks: s.tasks.length ? s.tasks : [{ task: "", parts: "" }],
      model_ids: s.models.map((x) => x.model_id), sources: s.sources,
    } : blank(mId));
  }
  function save() {
    const body = { ...edit, checklist: edit.checklist.filter((x) => x.trim()), tasks: edit.tasks.filter((t) => t.task.trim()) };
    act.run(() => apiRequest(edit.id ? `/maintenance-module/schedules/${edit.id}` : "/maintenance-module/schedules", { method: edit.id ? "PATCH" : "POST", body }),
      "Schedule saved.").then((r) => { if (r) setEdit(null); });
  }
  function del(s) {
    if (!window.confirm(`Delete "${s.name}"? It applies to ${s.models.length} model(s), ${s.assets.length} vehicle(s).`)) return;
    act.run(() => apiRequest(`/maintenance-module/schedules/${s.id}`, { method: "DELETE" }), `Deleted "${s.name}".`).then((r) => { if (r) { setDeleted(s); setEdit(null); } });
  }
  function undo() {
    act.run(() => apiRequest(`/maintenance-module/schedules/${deleted.id}/restore`, { method: "POST" }), "Restored.").then(() => setDeleted(null));
  }
  function saveBaseline() {
    act.run(() => apiRequest(`/maintenance-module/schedules/${baseline.schedule_id}/assets/${baseline.asset_id}`, { method: "PATCH", body: baseline }),
      "Starting point saved.").then((r) => { if (r) setBaseline(null); });
  }
  const setList = (key, i, v) => setEdit({ ...edit, [key]: edit[key].map((x, j) => (j === i ? v : x)) });

  return (
    <>
      <div style={{ ...ROW, marginBottom: 12, fontSize: 12 }}>
        <span style={MUTED}>Where each interval comes from:</span>
        {Object.keys(BASIS).map((k) => <Badge key={k} map={BASIS} value={k} />)}
        <span style={MUTED}>— “Industry practice” intervals should be checked against the vehicle’s own service book.</span>
      </div>
      <Msg msg={act.msg} err={act.err} />
      {deleted && (
        <div style={{ ...ROW, background: "var(--alert-red-bg)", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>
          <span style={{ flex: 1 }}>Deleted “{deleted.name}”.</span>
          <button type="button" style={SMALL_BTN} onClick={undo}>Undo</button>
        </div>
      )}
      <div role="tablist" aria-label="Group PM schedules" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["vehicle", "By vehicle"], ["model", "By model"]].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => { setView(k); setEdit(null); setBaseline(null); }}
            style={{ padding: "7px 14px", fontSize: 12.5, borderRadius: 999, fontWeight: view === k ? 600 : 400,
              background: view === k ? "var(--charcoal)" : "#fff", color: view === k ? "#fff" : "var(--charcoal)", border: "1px solid var(--border-strong)" }}>{l}</button>
        ))}
      </div>
      {view === "vehicle" ? (
        <VehicleView vehicles={vehicles} due={due} sched={sched.data} allModels={allModels} assetId={assetId} setAssetId={setAssetId} vq={vq} setVq={setVq}
          canEdit={canEdit} baseline={baseline} setBaseline={setBaseline} saveBaseline={saveBaseline} act={act}
          onEditSchedule={(s) => { setView("model"); const m = s.models[0]?.model_id; if (m) setModelId(m); openEdit(s); }} />
      ) : (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <aside className="card" style={{ flex: "1 1 250px", maxWidth: 320, padding: 10 }}>
          {allModels.map((a) => (
            <button key={a.id} type="button" onClick={() => { setModelId(a.id); setEdit(null); setBaseline(null); setOpen(null); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: 10, borderRadius: 8, marginBottom: 2,
                border: `1px solid ${a.id === mId ? "#E7C3A6" : "transparent"}`, background: a.id === mId ? "#FBF3EC" : "none" }}>
              <b style={{ fontSize: 13 }}>{a.name}</b>
              <span style={{ ...MUTED, fontSize: 11.5, display: "block" }}>{a.asset_group} · {(byModel[a.id] || []).length} schedules · {a.vehicles} vehicle{a.vehicles === 1 ? "" : "s"}</span>
            </button>
          ))}
        </aside>

        <section className="card" style={{ flex: "1 1 380px", minWidth: 0 }}>
          <div style={{ ...ROW, marginBottom: 6 }}>
            <h2 style={{ ...H2, flex: 1, margin: 0 }}>{model?.name}</h2>
            {canCreate && <button type="button" style={SMALL_BTN} onClick={() => openEdit(null)}>+ New schedule</button>}
          </div>
          <div style={{ ...MUTED, marginBottom: 6 }}>
            {model?.vehicles ? `Applies to its ${model.vehicles} vehicle(s).` : "No vehicles of this model yet — add them on the Equipment tab."}
          </div>
          {list.length === 0 && <div style={MUTED}>No schedules for this model.</div>}
          {list.map((s) => {
            const vehicles = s.assets.filter((x) => x.model_id === mId);
            const shown = open === s.id;
            return (
              <div key={s.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ ...ROW }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <b style={{ fontSize: 13.5 }}>{s.name}</b>
                    <div style={MUTED}>{s.trigger}</div>
                    {s.models.length > 1 && <div style={{ ...MUTED, fontSize: 11.5 }}>Also for {s.models.filter((x) => x.model_id !== mId).map((x) => x.name).join(", ")}</div>}
                  </div>
                  <Badge map={BASIS} value={s.basis} />
                  {canEdit && <button type="button" style={SMALL_BTN} onClick={() => openEdit(s)}>Edit</button>}
                  {vehicles.length > 0 && <button type="button" style={SMALL_BTN} aria-expanded={shown} onClick={() => setOpen(shown ? null : s.id)}>Last done ({vehicles.length})</button>}
                  {canDelete && <button type="button" className="btn-danger" style={SMALL_BTN} onClick={() => del(s)}>Delete</button>}
                </div>
                {shown && (
                  <div style={{ margin: "8px 0 0 12px", borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
                    {vehicles.map((sa) => (
                      <div key={sa.asset_id} style={{ ...ROW, padding: "4px 0", fontSize: 12.5 }}>
                        <span style={{ flex: 1, minWidth: 160 }}><b>{sa.name.replace(/ — .*$/, "")}</b> <span style={MUTED}>· last done {lastDoneText(sa)}</span></span>
                        {canEdit && <button type="button" style={SMALL_BTN} onClick={() => { setEdit(null); setBaseline({ schedule_id: s.id, asset_id: sa.asset_id, vehicle: sa.name, name: s.name, last_done_date: sa.last_done_date ? String(sa.last_done_date).slice(0, 10) : "", last_done_km: sa.last_done_km ?? "", last_done_hours: sa.last_done_hours ?? "" }); }}>Set</button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {(edit || baseline) && (
          <section className="card" style={{ flex: "1 1 420px", minWidth: 0, borderColor: "#E7C3A6" }}>
            {baseline && (
              <>
                <h2 style={H2}>Last done — {baseline.name}</h2>
                <p style={{ ...MUTED, marginTop: 0 }}>The starting point for {baseline.vehicle}. After this, each PM inspection updates it automatically.</p>
                <div style={GRID(150)}>
                  <Field label="Date"><input type="date" value={baseline.last_done_date} onChange={(e) => setBaseline({ ...baseline, last_done_date: e.target.value })} /></Field>
                  <Field label="At km"><input inputMode="decimal" value={baseline.last_done_km} onChange={(e) => setBaseline({ ...baseline, last_done_km: e.target.value })} /></Field>
                  <Field label="At hours"><input inputMode="decimal" value={baseline.last_done_hours} onChange={(e) => setBaseline({ ...baseline, last_done_hours: e.target.value })} /></Field>
                </div>
                <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
                  <button type="button" onClick={() => setBaseline(null)}>Cancel</button>
                  <button type="button" className="btn-primary" disabled={act.busy} onClick={saveBaseline}>Save</button>
                </div>
              </>
            )}
            {edit && (
              <>
                <h2 style={H2}>{edit.id ? "Edit schedule" : "New schedule"}</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
                  <div style={GRID(150)}>
                    <Field label="Due">
                      <select value={edit.trigger_type} onChange={(e) => setEdit({ ...edit, trigger_type: e.target.value })}>
                        {TRIGGERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </Field>
                    <Field label="N"><input inputMode="decimal" value={edit.every} onChange={(e) => setEdit({ ...edit, every: e.target.value })} /></Field>
                    <Field label="…or months"><input inputMode="numeric" value={edit.or_months} onChange={(e) => setEdit({ ...edit, or_months: e.target.value })} /></Field>
                    <Field label="…or hours"><input inputMode="numeric" value={edit.or_hours} onChange={(e) => setEdit({ ...edit, or_hours: e.target.value })} /></Field>
                  </div>
                  <Field label="Applies to models">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {allModels.map((a) => {
                        const on = edit.model_ids.includes(a.id);
                        return (
                          <button key={a.id} type="button" aria-pressed={on} onClick={() => setEdit({ ...edit, model_ids: on ? edit.model_ids.filter((x) => x !== a.id) : [...edit.model_ids, a.id] })}
                            style={{ padding: "5px 10px", fontSize: 12, borderRadius: 20, background: on ? "var(--charcoal)" : "#fff", color: on ? "#fff" : "var(--charcoal)" }}>
                            {a.name}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                  <div>
                    <span style={{ fontSize: 11.5, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 }}>Checklist — answered OK / Not OK at each inspection</span>
                    {edit.checklist.map((c, i) => (
                      <div key={i} className="field-input" style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <input aria-label={`Check ${i + 1}`} value={c} onChange={(e) => setList("checklist", i, e.target.value)} />
                        <button type="button" aria-label="Remove check" onClick={() => setEdit({ ...edit, checklist: edit.checklist.filter((_, j) => j !== i) })}>✕</button>
                      </div>
                    ))}
                    <button type="button" style={{ ...SMALL_BTN, marginTop: 6 }} onClick={() => setEdit({ ...edit, checklist: [...edit.checklist, ""] })}>+ Add check</button>
                  </div>
                  <div>
                    <span style={{ fontSize: 11.5, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 }}>Tasks &amp; parts</span>
                    {edit.tasks.map((t, i) => (
                      <div key={i} className="field-input" style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <input aria-label={`Task ${i + 1}`} placeholder="Task" value={t.task} onChange={(e) => setList("tasks", i, { ...t, task: e.target.value })} style={{ flex: 2 }} />
                        <input aria-label={`Parts for task ${i + 1}`} placeholder="Parts" value={t.parts} onChange={(e) => setList("tasks", i, { ...t, parts: e.target.value })} style={{ flex: 1 }} />
                        <button type="button" aria-label="Remove task" onClick={() => setEdit({ ...edit, tasks: edit.tasks.filter((_, j) => j !== i) })}>✕</button>
                      </div>
                    ))}
                    <button type="button" style={{ ...SMALL_BTN, marginTop: 6 }} onClick={() => setEdit({ ...edit, tasks: [...edit.tasks, { task: "", parts: "" }] })}>+ Add task</button>
                  </div>
                  <div style={GRID(150)}>
                    <Field label="Basis">
                      <select value={edit.basis} onChange={(e) => setEdit({ ...edit, basis: e.target.value })}>
                        <option value="OEM">Manufacturer</option><option value="ENGINE">Engine maker</option><option value="PRACTICE">Industry practice</option>
                      </select>
                    </Field>
                    <Field label="Note"><input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field>
                  </div>
                  <div style={{ ...ROW, justifyContent: "flex-end" }}>
                    <button type="button" onClick={() => setEdit(null)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={act.busy} onClick={save}>Save</button>
                  </div>
                </div>
              </>
            )}
          </section>
        )}
      </div>
      )}
    </>
  );
}

function VehicleView({ vehicles, due, sched, allModels, assetId, setAssetId, vq, setVq, canEdit, baseline, setBaseline, saveBaseline, act, onEditSchedule }) {
  // Round 243 — Manager / Plant In Charge give a vehicle's PM checks to a person.
  const { user } = useAuth();
  const canAssign = ["manager", "plant_in_charge", "administrator", "super_admin"].includes(user?.role);
  const [people, setPeople] = useState([]);
  useEffect(() => { if (canAssign) apiRequest("/maintenance-module/pm-assign/people").then(setPeople).catch(() => {}); }, [canAssign]);
  const assign = (body) => act.run(() => apiRequest("/maintenance-module/pm-assign", { method: "PUT", body }), body.user_id ? "Given — it shows in their login." : "Taken off.");
  const roleTag = (r) => (r ? r.replace(/_/g, " ") : "");
  if (!due.data) return <Loading error={due.error} />;
  const q = vq.trim().toLowerCase();
  const shown = q ? vehicles.filter((v) => `${v.name} ${v.group || ""}`.toLowerCase().includes(q)) : vehicles;
  const v = vehicles.find((x) => x.asset_id === assetId) || shown[0] || null;
  const modelName = (id) => allModels.find((m) => m.id === id)?.name || "";
  const schedById = new Map((sched || []).map((s) => [s.id, s]));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      <aside className="card" style={{ flex: "1 1 250px", maxWidth: 320, padding: 10 }}>
        <input aria-label="Find a vehicle" placeholder="Find a vehicle…" value={vq} onChange={(e) => setVq(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        {!vehicles.length && <div style={MUTED}>No vehicles have schedules yet. Give each vehicle its model on the Equipment tab.</div>}
        {shown.map((x) => (
          <button key={x.asset_id} type="button" onClick={() => { setAssetId(x.asset_id); setBaseline(null); }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: 10, borderRadius: 8, marginBottom: 2,
              border: `1px solid ${x.asset_id === v?.asset_id ? "#E7C3A6" : "transparent"}`, background: x.asset_id === v?.asset_id ? "#FBF3EC" : "none" }}>
            <b style={{ fontSize: 13 }}>{x.name.replace(/ — .*$/, "")}</b>
            <span style={{ ...MUTED, fontSize: 11.5, display: "block" }}>
              {modelName(x.model_id) || x.group} · {x.rows.length} schedule{x.rows.length === 1 ? "" : "s"}
              {x.overdue ? <b style={{ color: "var(--alert-red)" }}> · {x.overdue} overdue</b> : null}
              {x.soon ? <b style={{ color: "var(--amber)" }}> · {x.soon} due soon</b> : null}
            </span>
          </button>
        ))}
      </aside>
      {v && (
        <section className="card" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <h2 style={{ ...H2, marginBottom: 2 }}>{v.name}</h2>
          <div style={{ ...MUTED, marginBottom: 8 }}>
            {modelName(v.model_id) || v.group}
            {v.km != null ? ` · ${fmtNum(v.km)} km now` : ""}{v.hours != null ? ` · ${fmtNum(v.hours)} h now` : ""}
            {" · schedules are planned per model — editing one changes it for every vehicle of that model"}
          </div>
          {canAssign && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, margin: "4px 0 8px" }}>
              Give every PM check of this vehicle to
              <select value="" onChange={(e) => e.target.value !== "" && assign({ asset_id: v.asset_id, user_id: e.target.value === "none" ? null : Number(e.target.value) })} aria-label="Give all PM checks of this vehicle to">
                <option value="">Choose…</option>
                <option value="none">— nobody —</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {roleTag(p.role)}</option>)}
              </select>
            </label>
          )}
          {v.rows.map((r) => {
            const s = schedById.get(r.schedule_id);
            return (
              <div key={r.schedule_id} style={{ ...ROW, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ flex: 1, minWidth: 190 }}>
                  <b style={{ fontSize: 13.5 }}>{r.schedule_name}</b>
                  <div style={MUTED}>{r.trigger}</div>
                  <div style={{ ...MUTED, fontSize: 11.5 }}>Last done {lastDoneText(r)}{r.next && r.next !== "—" ? ` · next at ${r.next}` : ""}</div>
                  {r.last_confirmation && (
                    <div style={{ fontSize: 11.5, color: r.last_confirmation.done ? "var(--signal-green)" : "var(--alert-red)" }}>
                      {r.last_confirmation.done ? "Confirmed done" : "Not done"} by {r.last_confirmation.by} · {fmtDate(r.last_confirmation.at)}{r.last_confirmation.note ? ` — ${r.last_confirmation.note}` : ""}
                    </div>
                  )}
                  {canAssign ? (
                    <select value={r.assignee_id || ""} onChange={(e) => assign({ asset_id: v.asset_id, schedule_id: r.schedule_id, user_id: e.target.value ? Number(e.target.value) : null })}
                      aria-label={`Given to, ${r.schedule_name}`} style={{ marginTop: 4, fontSize: 12, maxWidth: 260 }}>
                      <option value="">Not given to anyone</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {roleTag(p.role)}</option>)}
                    </select>
                  ) : r.assignee_name ? <div style={{ ...MUTED, fontSize: 11.5 }}>Given to {r.assignee_name}</div> : null}
                </div>
                <div style={{ textAlign: "right", minWidth: 110 }}>
                  <Badge map={PM_STATUS} value={r.status} />
                  <div style={{ ...MUTED, fontSize: 11.5, marginTop: 2 }}>{r.left}</div>
                </div>
                {canEdit && <button type="button" style={SMALL_BTN} onClick={() => setBaseline({ schedule_id: r.schedule_id, asset_id: v.asset_id, vehicle: v.name, name: r.schedule_name, last_done_date: r.last_done_date ? String(r.last_done_date).slice(0, 10) : "", last_done_km: r.last_done_km ?? "", last_done_hours: r.last_done_hours ?? "" })}>Set last done</button>}
                {canEdit && s && <button type="button" style={SMALL_BTN} onClick={() => onEditSchedule(s)}>Edit schedule</button>}
              </div>
            );
          })}
        </section>
      )}
      {baseline && (
        <section className="card" style={{ flex: "1 1 320px", minWidth: 0, borderColor: "#E7C3A6" }}>
          <h2 style={H2}>Last done — {baseline.name}</h2>
          <p style={{ ...MUTED, marginTop: 0 }}>The starting point for {baseline.vehicle}. After this, each PM inspection updates it automatically.</p>
          <div style={GRID(130)}>
            <Field label="Date"><input type="date" value={baseline.last_done_date} onChange={(e) => setBaseline({ ...baseline, last_done_date: e.target.value })} /></Field>
            <Field label="At km"><input inputMode="decimal" value={baseline.last_done_km} onChange={(e) => setBaseline({ ...baseline, last_done_km: e.target.value })} /></Field>
            <Field label="At hours"><input inputMode="decimal" value={baseline.last_done_hours} onChange={(e) => setBaseline({ ...baseline, last_done_hours: e.target.value })} /></Field>
          </div>
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" onClick={() => setBaseline(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={saveBaseline}>Save</button>
          </div>
        </section>
      )}
    </div>
  );
}
