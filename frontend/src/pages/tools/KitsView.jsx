// Round 264 — Maintenance → Kits & tool list: the standard Mechanic /
// Electrician (and any other) kits, and the list of item types with their ID
// prefix — tools, power tools, cube moulds, pump pipes (personal asset types
// too, for the Administrator). Store and Plant In Charge can add new ones.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { Field, Msg, MUTED, ROW, GRID, SMALL_BTN, useLoad, Loading, Table, H2, fmtRs } from "../maintenance/mntUi.jsx";
import { KIND_LABEL } from "./toolsShared.jsx";

export default function KitsView() {
  const { can } = usePermissions();
  const meta = useLoad("/tools/meta");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [kind, setKind] = useState("tool");
  const [nt, setNt] = useState({ name: "", prefix: "", value: "" });
  const [editKit, setEditKit] = useState(null);
  const [newKit, setNewKit] = useState("");
  if (!meta.data) return <Loading error={meta.error} />;
  const { types, kits } = meta.data;
  const kindsShown = ["tool", "power_tool", "cube_mould", "pump_pipe", ...(can("hr.assets", "view") ? ["asset"] : [])];
  const keyFor = (k) => (k === "asset" ? "hr.assets" : k === "cube_mould" || k === "pump_pipe" ? "tools.in-use" : "tools.kits");
  const act = async (fn, ok) => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); meta.load(); return true; } catch (e) { setErr(e.message); return false; } };
  const shown = types.filter((t) => t.kind === kind);
  const toolTypes = types.filter((t) => t.kind === "tool" || t.kind === "power_tool");

  return (
    <>
      <h1 style={{ fontSize: 19, margin: "0 0 12px" }}>Standard kits &amp; tool list</h1>
      <Msg msg={msg} err={err} />
      <div style={{ ...GRID(320), alignItems: "start" }}>
        <section className="card">
          <h2 style={H2}>Standard kits</h2>
          {kits.map((k) => (
            <div key={k.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
              <div style={ROW}>
                <b>{k.name}</b><span style={MUTED}>{k.types.length} tools{!k.is_active ? " · switched off" : ""}</span>
                {can("tools.kits", "edit") && editKit?.id !== k.id && <button type="button" style={{ ...SMALL_BTN, marginLeft: "auto" }} onClick={() => setEditKit({ id: k.id, name: k.name, is_active: k.is_active, types: k.types.map((t) => ({ type_id: t.type_id, qty: t.qty })) })}>Edit</button>}
              </div>
              {editKit?.id === k.id ? (
                <div style={{ marginTop: 6 }}>
                  <Field label="Kit name"><input value={editKit.name} onChange={(e) => setEditKit({ ...editKit, name: e.target.value })} /></Field>
                  <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, marginTop: 8 }}>
                    {toolTypes.filter((t) => t.is_active).map((t) => {
                      const line = editKit.types.find((x) => x.type_id === t.id);
                      return (
                        <label key={t.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 8px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                          <input type="checkbox" style={{ width: "auto" }} checked={!!line} onChange={() => setEditKit({ ...editKit, types: line ? editKit.types.filter((x) => x.type_id !== t.id) : [...editKit.types, { type_id: t.id, qty: 1 }] })} />
                          <span style={{ flex: 1 }}>{t.name}</span>
                          {line && <input inputMode="numeric" style={{ width: 50 }} value={line.qty} onChange={(e) => setEditKit({ ...editKit, types: editKit.types.map((x) => (x.type_id === t.id ? { ...x, qty: e.target.value } : x)) })} aria-label={`Quantity of ${t.name}`} />}
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ ...ROW, marginTop: 8 }}>
                    <label style={{ ...ROW, gap: 6, fontSize: 13 }}><input type="checkbox" style={{ width: "auto" }} checked={editKit.is_active} onChange={(e) => setEditKit({ ...editKit, is_active: e.target.checked })} /> In use</label>
                    <button type="button" style={{ marginLeft: "auto" }} onClick={() => setEditKit(null)}>Cancel</button>
                    <button type="button" className="btn-primary" onClick={() => act(() => apiRequest(`/tools/kits/${k.id}`, { method: "PUT", body: { ...editKit, types: editKit.types.map((x) => ({ ...x, qty: Number(x.qty) || 1 })) } }), "Kit saved.").then((ok) => ok && setEditKit(null))}>Save kit</button>
                  </div>
                </div>
              ) : <div style={{ ...MUTED, marginTop: 4 }}>{k.types.map((t) => `${t.name}${t.qty > 1 ? ` × ${t.qty}` : ""}`).join(" · ") || "No tools yet."}</div>}
            </div>
          ))}
          {can("tools.kits", "create") && (
            <div style={{ ...ROW, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <input style={{ flex: 1 }} placeholder="New kit, e.g. Pump operator kit" value={newKit} onChange={(e) => setNewKit(e.target.value)} />
              <button type="button" disabled={!newKit.trim()} onClick={() => act(() => apiRequest("/tools/kits", { method: "POST", body: { name: newKit } }), "Kit added — now Edit it to pick its tools.").then((ok) => ok && setNewKit(""))}>+ New kit</button>
            </div>
          )}
          <div style={{ ...MUTED, marginTop: 8 }}>Shared instruments (insulation / earth tester) are issued temporarily, not in a kit.</div>
        </section>

        <section className="card">
          <h2 style={H2}>Item list &amp; ID prefixes</h2>
          <div style={{ ...ROW, marginBottom: 8 }}>
            {kindsShown.map((k) => <button key={k} type="button" style={SMALL_BTN} className={kind === k ? "btn-primary" : ""} onClick={() => setKind(k)}>{KIND_LABEL[k]}s</button>)}
          </div>
          <Table minWidth={420}>
            <thead><tr><th>Item</th><th>ID prefix</th><th style={{ textAlign: "right" }}>On list</th><th>Value</th><th /></tr></thead>
            <tbody>
              {shown.map((t) => <TypeRow key={t.id} t={t} mayEdit={can(keyFor(t.kind), "edit")} act={act} />)}
            </tbody>
          </Table>
          {can(keyFor(kind), "create") && (
            <div style={{ ...ROW, marginTop: 10, alignItems: "flex-end" }}>
              <Field label={`New ${KIND_LABEL[kind].toLowerCase()}`} style={{ flex: 2, minWidth: 180 }}><input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} /></Field>
              <Field label="Prefix" style={{ width: 80 }}><input value={nt.prefix} placeholder={{ tool: "T", power_tool: "PT", asset: "IT", cube_mould: "CM", pump_pipe: "PP" }[kind]} onChange={(e) => setNt({ ...nt, prefix: e.target.value.toUpperCase() })} /></Field>
              <Field label="Value ₹" style={{ width: 100 }}><input inputMode="decimal" value={nt.value} onChange={(e) => setNt({ ...nt, value: e.target.value })} /></Field>
              <button type="button" disabled={!nt.name.trim()} onClick={() => act(() => apiRequest("/tools/types", { method: "POST", body: { kind, ...nt } }), `${nt.name} added.`).then((ok) => ok && setNt({ name: "", prefix: "", value: "" }))}>+ Add</button>
            </div>
          )}
          <div style={{ ...MUTED, marginTop: 8 }}>A store item bought on a GRV in a register category becomes an item here by itself (same name).</div>
        </section>
      </div>
    </>
  );
}

function TypeRow({ t, mayEdit, act }) {
  const [e, setE] = useState(null);
  if (e) return (
    <tr>
      <td><input value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} /></td>
      <td><input style={{ width: 60 }} value={e.prefix} onChange={(x) => setE({ ...e, prefix: x.target.value.toUpperCase() })} /></td>
      <td style={{ textAlign: "right" }}>{t.on_list}</td>
      <td><input style={{ width: 80 }} value={e.value} onChange={(x) => setE({ ...e, value: x.target.value })} /></td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button type="button" style={SMALL_BTN} onClick={() => act(() => apiRequest(`/tools/types/${t.id}`, { method: "PATCH", body: e }), "Saved.").then((ok) => ok && setE(null))}>Save</button>
        <button type="button" style={SMALL_BTN} onClick={() => setE(null)}>✕</button>
      </td>
    </tr>
  );
  return (
    <tr style={!t.is_active ? { opacity: 0.55 } : undefined}>
      <td>{t.name}</td><td><b>{t.prefix}</b></td><td style={{ textAlign: "right" }}>{t.on_list}</td><td>{t.value ? fmtRs(t.value) : "—"}</td>
      <td style={{ whiteSpace: "nowrap" }}>{mayEdit && <>
        <button type="button" style={SMALL_BTN} onClick={() => setE({ name: t.name, prefix: t.prefix, value: t.value ?? "" })}>Edit</button>
        <button type="button" style={SMALL_BTN} onClick={() => act(() => apiRequest(`/tools/types/${t.id}`, { method: "PATCH", body: { is_active: !t.is_active } }), t.is_active ? "Switched off." : "Switched on.")}>{t.is_active ? "Off" : "On"}</button>
      </>}</td>
    </tr>
  );
}
