// Round 215 — Equipment register: every vehicle and plant item, its linked
// master record (where km / hours / m³ come from), meter readings, what is
// due and its history.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  useLoad, useAction, Loading, Msg, Badge, PM_STATUS, CARD_STATUS, fmtNum, fmtRs, fmtDate, H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN,
} from "./mntUi.jsx";

const EMPTY = { name: "", asset_group: "Transit mixer", make_model: "", year: "", detail: "", link: "" };

function linkValue(a) {
  if (a.truck_id) return `truck:${a.truck_id}`;
  if (a.pump_id) return `pump:${a.pump_id}`;
  if (a.equipment_id) return `equipment:${a.equipment_id}`;
  return "";
}

export default function MntEquipment({ go, params }) {
  const { can } = usePermissions();
  const list = useLoad("/maintenance-module/assets");
  const masters = useLoad("/maintenance-module/masters");
  const selId = Number(params.get("asset")) || null;
  const detail = useLoad(selId ? `/maintenance-module/assets/${selId}` : null, [selId]);
  const [form, setForm] = useState(null); // { id?, ...fields }
  const [reading, setReading] = useState(null);
  const [q, setQ] = useState("");
  const act = useAction(() => { list.load(); masters.load(); if (selId) detail.load(); });

  if (!list.data || !masters.data) return <Loading error={list.error || masters.error} />;
  const m = masters.data;
  const assets = list.data.filter((a) => !q || `${a.name} ${a.linked || ""} ${a.asset_group}`.toLowerCase().includes(q.toLowerCase()));
  const d = selId && detail.data?.id === selId ? detail.data : null;

  function openForm(a) {
    setForm(a ? { id: a.id, name: a.name, asset_group: a.asset_group, make_model: a.make_model || "", year: a.year || "", detail: a.detail || "", link: linkValue(a) } : { ...EMPTY });
  }
  function save() {
    const [kind, id] = (form.link || ":").split(":");
    const body = {
      name: form.name, asset_group: form.asset_group, make_model: form.make_model, year: form.year, detail: form.detail,
      truck_id: kind === "truck" ? id : null, pump_id: kind === "pump" ? id : null, equipment_id: kind === "equipment" ? id : null,
    };
    act.run(() => apiRequest(form.id ? `/maintenance-module/assets/${form.id}` : "/maintenance-module/assets", { method: form.id ? "PATCH" : "POST", body }),
      form.id ? "Saved." : "Equipment added.").then((r) => { if (r) setForm(null); });
  }
  function retire(a) {
    if (!window.confirm(`Remove ${a.name} from the register? Its history is kept.`)) return;
    act.run(() => apiRequest(`/maintenance-module/assets/${a.id}`, { method: "DELETE" }), "Removed.").then((r) => { if (r) go("equipment"); });
  }
  function saveReading() {
    act.run(() => apiRequest(`/maintenance-module/assets/${selId}/readings`, { method: "POST", body: reading }), "Reading saved.").then((r) => { if (r) setReading(null); });
  }

  const linkOptions = (current) => {
    const opt = (kind, r, label) => {
      const taken = r.asset && r.asset.id !== current;
      return <option key={`${kind}:${r.id}`} value={`${kind}:${r.id}`} disabled={taken}>{label}{taken ? ` — linked to ${r.asset.name}` : ""}</option>;
    };
    return (
      <>
        <option value="">Not linked</option>
        <optgroup label="Trucks">{m.trucks.map((r) => opt("truck", r, r.label))}</optgroup>
        <optgroup label="Pumps">{m.pumps.map((r) => opt("pump", r, r.label))}</optgroup>
        <optgroup label="Equipment">{m.equipment.map((r) => opt("equipment", r, `${r.label} (${r.type.replace("_", " ")})`))}</optgroup>
      </>
    );
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      <aside className="card" style={{ flex: "1 1 280px", maxWidth: 360, padding: 12 }}>
        <div style={{ ...ROW, marginBottom: 8 }}>
          <div className="field-input" style={{ flex: 1 }}><input placeholder="Find equipment" aria-label="Find equipment" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {can("mnt.equipment", "create") && <button type="button" style={SMALL_BTN} onClick={() => openForm(null)}>+ Add</button>}
        </div>
        {assets.map((a) => (
          <button key={a.id} type="button" onClick={() => go("equipment", { asset: a.id })}
            style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", textAlign: "left", padding: 10, borderRadius: 8,
              border: `1px solid ${a.id === selId ? "#E7C3A6" : "transparent"}`, background: a.id === selId ? "#FBF3EC" : "none", marginBottom: 2 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b style={{ fontSize: 13 }}>{a.name}</b>
              <span style={{ ...MUTED, fontSize: 11.5, display: "block" }}>
                {a.linked || "Not linked"}{a.km != null ? ` · ${fmtNum(a.km)} km` : ""}{a.hours != null ? ` · ${fmtNum(a.hours)} h` : ""}
              </span>
            </span>
            {a.at_workshop > 0 ? <span className="badge badge-progress">Outside</span>
              : a.open_job_cards > 0 ? <span className="badge badge-info">Job card</span>
                : a.pm_status !== "ok" ? <Badge map={PM_STATUS} value={a.pm_status} /> : null}
          </button>
        ))}
      </aside>

      <main style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        <Msg msg={act.msg} err={act.err} />
        {form && (
          <section className="card" style={{ borderColor: "#E7C3A6" }}>
            <h2 style={H2}>{form.id ? "Edit equipment" : "Add equipment"}</h2>
            <div style={GRID(200)}>
              <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Transit Mixer — Tata Signa 2825.K" /></Field>
              <Field label="Type">
                <select value={form.asset_group} onChange={(e) => setForm({ ...form, asset_group: e.target.value })}>
                  {m.groups.map((g) => <option key={g}>{g}</option>)}
                </select>
              </Field>
              <Field label="Make / model"><input value={form.make_model} onChange={(e) => setForm({ ...form, make_model: e.target.value })} /></Field>
              <Field label="Year"><input inputMode="numeric" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} /></Field>
              <Field label="Linked master record" style={{ gridColumn: "1 / -1" }}>
                <select value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })}>{linkOptions(form.id)}</select>
                <span style={{ ...MUTED, fontSize: 11.5 }}>km and hour-meter readings from fuel requests and inspections, and m³ from delivery challans, come from this record.</span>
              </Field>
              <Field label="Details" style={{ gridColumn: "1 / -1" }}><input value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></Field>
            </div>
            <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={act.busy} onClick={save}>Save</button>
            </div>
          </section>
        )}

        {!selId && !form && (
          <div className="card" style={MUTED}>
            Pick a vehicle or machine on the left. {list.data.filter((a) => !a.linked).length > 0 &&
              <><b>{list.data.filter((a) => !a.linked).length}</b> are not linked to a truck / pump / equipment record yet — link them so their km, hours and m³ are picked up automatically.</>}
          </div>
        )}

        {selId && !d && <Loading error={detail.error} />}
        {d && (
          <>
            <section className="card">
              <div style={{ ...ROW, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ ...MUTED, textTransform: "uppercase", fontSize: 11.5 }}>{d.asset_group}</div>
                  <h1 style={{ fontSize: 21, margin: "2px 0 4px" }}>{d.name}</h1>
                  <div style={MUTED}>{[d.make_model, d.year, d.detail].filter(Boolean).join(" · ") || "—"} · {d.linked ? `Linked to ${d.linked}` : "Not linked to a master record"}</div>
                </div>
                {can("mnt.equipment", "edit") && <button type="button" style={SMALL_BTN} onClick={() => openForm(d)}>Edit</button>}
                {can("mnt.equipment", "delete") && <button type="button" style={SMALL_BTN} onClick={() => retire(d)}>Remove</button>}
              </div>
              <div style={{ ...GRID(150), marginTop: 14 }}>
                {[["Odometer", d.km != null ? `${fmtNum(d.km)} km` : "—"], ["Hour meter", d.hours != null ? `${fmtNum(d.hours)} h` : "—"], ["Maintenance cost · FY", fmtRs(d.cost_fy)]].map(([l, v]) => (
                  <div key={l} style={{ background: "var(--concrete)", borderRadius: 8, padding: 12 }}>
                    <div className="kpi-label">{l}</div><div style={{ fontSize: 19, fontWeight: 600 }}>{v}</div>
                  </div>
                ))}
              </div>
              {can("mnt.equipment", "create") && (
                reading ? (
                  <div style={{ ...ROW, marginTop: 12, alignItems: "flex-end" }}>
                    <Field label="Km"><input inputMode="decimal" value={reading.km} onChange={(e) => setReading({ ...reading, km: e.target.value })} /></Field>
                    <Field label="Hours"><input inputMode="decimal" value={reading.hours} onChange={(e) => setReading({ ...reading, hours: e.target.value })} /></Field>
                    <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center", paddingBottom: 10 }}>
                      <input type="checkbox" checked={!!reading.meter_replaced} onChange={(e) => setReading({ ...reading, meter_replaced: e.target.checked })} /> meter replaced
                    </label>
                    <button type="button" onClick={() => setReading(null)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={act.busy} onClick={saveReading}>Save reading</button>
                  </div>
                ) : <button type="button" style={{ ...SMALL_BTN, marginTop: 12 }} onClick={() => setReading({ km: "", hours: "" })}>Update meter reading</button>
              )}
            </section>

            <section className="card">
              <h2 style={H2}>PM schedules on this equipment</h2>
              {d.due.length === 0 ? <div style={MUTED}>No schedules apply yet.</div> : (
                <Table minWidth={520}>
                  <thead><tr><th>Schedule</th><th>Last done</th><th>Left</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {d.due.map((x) => (
                      <tr key={x.schedule_id}>
                        <td><b>{x.schedule_name}</b><div style={MUTED}>{x.trigger}</div></td>
                        <td>{x.last_done_date ? fmtDate(x.last_done_date) : "—"}{x.last_done_km != null ? ` · ${fmtNum(x.last_done_km)} km` : ""}</td>
                        <td>{x.left}</td>
                        <td><Badge map={PM_STATUS} value={x.status} /></td>
                        <td style={{ textAlign: "right" }}>
                          {can("mnt.inspections", "create") && x.status !== "done" &&
                            <button type="button" style={SMALL_BTN} onClick={() => go("inspection", { schedule: x.schedule_id, asset: d.id })}>Start</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </section>

            <section className="card">
              <h2 style={H2}>History</h2>
              {d.history.length === 0 ? <div style={MUTED}>Nothing yet.</div> : d.history.map((h) => (
                <div key={`${h.kind}-${h.id}`} style={{ display: "flex", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", marginTop: 5, flex: "none", background: h.kind === "inspection" ? "var(--signal-green)" : "var(--rebar)" }} />
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <div style={{ ...MUTED, fontSize: 11.5 }}>{fmtDate(h.date)}</div>
                    {h.kind === "job_card"
                      ? <button type="button" onClick={() => go("job-cards", { card: h.id })} style={{ background: "none", border: "none", padding: 0, textAlign: "left", fontWeight: 600, color: "var(--charcoal)" }}>{h.title}</button>
                      : <b>{h.title}</b>}
                    {h.meta && <div style={MUTED}>{h.meta}</div>}
                  </div>
                  {h.status && <Badge map={CARD_STATUS} value={h.status} />}
                </div>
              ))}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
