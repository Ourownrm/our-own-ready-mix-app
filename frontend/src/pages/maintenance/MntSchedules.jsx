// Round 215 — PM schedules. Starting schedules were researched from the
// manufacturers' guidance for the owner's fleet (18 Oct 2026); each carries
// where its interval came from. Only the Administrator edits or deletes
// (mnt.schedules edit / delete), with an Undo straight after a delete.
import { useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, Badge, BASIS, fmtDate, fmtNum, H2, MUTED, ROW, GRID, Field, SMALL_BTN } from "./mntUi.jsx";

const TRIGGERS = [
  ["day", "Every N days"], ["week", "Every N weeks"], ["month", "Every N months"],
  ["km", "Every N km"], ["hours", "Every N hours"], ["m3", "Every N m³ carried"], ["once_km", "Once at N km"],
];

function blank(assetId) {
  return { name: "", trigger_type: "km", every: "", or_months: "", or_days: "", or_hours: "", basis: "PRACTICE", note: "", checklist: [""], tasks: [{ task: "", parts: "" }], asset_ids: assetId ? [assetId] : [] };
}

export default function MntSchedules() {
  const { can } = usePermissions();
  const sched = useLoad("/maintenance-module/schedules");
  const assets = useLoad("/maintenance-module/asset-options");
  const [assetId, setAssetId] = useState(null);
  const [edit, setEdit] = useState(null);       // form object
  const [baseline, setBaseline] = useState(null); // { schedule_id, asset_id, ... }
  const [deleted, setDeleted] = useState(null);
  const act = useAction(() => sched.load());
  const canEdit = can("mnt.schedules", "edit");
  const canCreate = can("mnt.schedules", "create");
  const canDelete = can("mnt.schedules", "delete");

  const byAsset = useMemo(() => {
    const m = {};
    for (const s of sched.data || []) for (const a of s.assets) (m[a.asset_id] = m[a.asset_id] || []).push(s);
    return m;
  }, [sched.data]);

  if (!sched.data || !assets.data) return <Loading error={sched.error || assets.error} />;
  const aId = assetId || assets.data[0]?.id;
  const asset = assets.data.find((a) => a.id === aId);
  const list = byAsset[aId] || [];

  function openEdit(s) {
    setBaseline(null);
    setEdit(s ? {
      id: s.id, name: s.name, trigger_type: s.trigger_type, every: s.every, or_months: s.or_months || "", or_days: s.or_days || "", or_hours: s.or_hours || "",
      basis: s.basis, note: s.note || "", checklist: s.checklist.length ? s.checklist : [""], tasks: s.tasks.length ? s.tasks : [{ task: "", parts: "" }],
      asset_ids: s.assets.map((a) => a.asset_id), sources: s.sources,
    } : blank(aId));
  }
  function save() {
    const body = { ...edit, checklist: edit.checklist.filter((x) => x.trim()), tasks: edit.tasks.filter((t) => t.task.trim()) };
    act.run(() => apiRequest(edit.id ? `/maintenance-module/schedules/${edit.id}` : "/maintenance-module/schedules", { method: edit.id ? "PATCH" : "POST", body }),
      "Schedule saved.").then((r) => { if (r) setEdit(null); });
  }
  function del(s) {
    if (!window.confirm(`Delete "${s.name}"? It applies to ${s.assets.length} machine(s).`)) return;
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <aside className="card" style={{ flex: "1 1 250px", maxWidth: 320, padding: 10 }}>
          {assets.data.map((a) => (
            <button key={a.id} type="button" onClick={() => { setAssetId(a.id); setEdit(null); setBaseline(null); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: 10, borderRadius: 8, marginBottom: 2,
                border: `1px solid ${a.id === aId ? "#E7C3A6" : "transparent"}`, background: a.id === aId ? "#FBF3EC" : "none" }}>
              <b style={{ fontSize: 13 }}>{a.name}</b>
              <span style={{ ...MUTED, fontSize: 11.5, display: "block" }}>{(byAsset[a.id] || []).length} schedules</span>
            </button>
          ))}
        </aside>

        <section className="card" style={{ flex: "1 1 380px", minWidth: 0 }}>
          <div style={{ ...ROW, marginBottom: 6 }}>
            <h2 style={{ ...H2, flex: 1, margin: 0 }}>{asset?.name}</h2>
            {canCreate && <button type="button" style={SMALL_BTN} onClick={() => openEdit(null)}>+ New schedule</button>}
          </div>
          {list.length === 0 && <div style={MUTED}>No schedules for this equipment.</div>}
          {list.map((s) => {
            const sa = s.assets.find((x) => x.asset_id === aId);
            return (
              <div key={s.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ ...ROW }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <b style={{ fontSize: 13.5 }}>{s.name}</b>
                    <div style={MUTED}>{s.trigger}</div>
                    <div style={{ ...MUTED, fontSize: 11.5 }}>
                      Last done: {sa?.last_done_date ? fmtDate(sa.last_done_date) : "not recorded"}{sa?.last_done_km != null ? ` · ${fmtNum(sa.last_done_km)} km` : ""}{sa?.last_done_hours != null ? ` · ${fmtNum(sa.last_done_hours)} h` : ""}
                      {s.assets.length > 1 && ` · applies to ${s.assets.length} machines`}
                    </div>
                  </div>
                  <Badge map={BASIS} value={s.basis} />
                  {canEdit && <button type="button" style={SMALL_BTN} onClick={() => openEdit(s)}>Edit</button>}
                  {canEdit && <button type="button" style={SMALL_BTN} onClick={() => { setEdit(null); setBaseline({ schedule_id: s.id, asset_id: aId, name: s.name, last_done_date: sa?.last_done_date ? String(sa.last_done_date).slice(0, 10) : "", last_done_km: sa?.last_done_km ?? "", last_done_hours: sa?.last_done_hours ?? "" }); }}>Last done</button>}
                  {canDelete && <button type="button" className="btn-danger" style={SMALL_BTN} onClick={() => del(s)}>Delete</button>}
                </div>
              </div>
            );
          })}
        </section>

        {(edit || baseline) && (
          <section className="card" style={{ flex: "1 1 420px", minWidth: 0, borderColor: "#E7C3A6" }}>
            {baseline && (
              <>
                <h2 style={H2}>Last done — {baseline.name}</h2>
                <p style={{ ...MUTED, marginTop: 0 }}>The starting point for {asset?.name}. After this, each PM inspection updates it automatically.</p>
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
                  <Field label="Applies to">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {assets.data.map((a) => {
                        const on = edit.asset_ids.includes(a.id);
                        return (
                          <button key={a.id} type="button" aria-pressed={on} onClick={() => setEdit({ ...edit, asset_ids: on ? edit.asset_ids.filter((x) => x !== a.id) : [...edit.asset_ids, a.id] })}
                            style={{ padding: "5px 10px", fontSize: 12, borderRadius: 20, background: on ? "var(--charcoal)" : "#fff", color: on ? "#fff" : "var(--charcoal)" }}>
                            {a.name.replace(/^.*—\s*/, "")}
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
    </>
  );
}
