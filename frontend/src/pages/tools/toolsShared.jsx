// Round 264 — shared pieces of the Tools & assets screens (Maintenance → Tools
// & power tools / Cube moulds & pipes / Kits & tool list, HR → Personal
// assets, My tools & assets). Backend: routes/tools.js.
import { useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { Modal, readPhotoSmall } from "../accounts/ui.jsx";
import { Field, Msg, MUTED, ROW, GRID, SMALL_BTN, fmtDate, fmtWhen, fmtRs, todayIst, useLoad, Loading, Table, H2 } from "../maintenance/mntUi.jsx";

export const ITEM_STATUS = {
  pending: ["Waiting to confirm", "badge-warning"],
  in_store: ["In store", "badge-neutral"],
  issue_pending: ["Issue waiting for approval", "badge-warning"],
  issued: ["With employee", "badge-info"],
  in_use: ["In use", "badge-success"],
  at_site: ["At site", "badge-progress"],
  removal_pending: ["Removal pending", "badge-danger"],
  repair: ["At repair", "badge-warning"],
  removed: ["Removed", "badge-neutral"],
  lost: ["Lost", "badge-danger"],
};
export const KIND_LABEL = { tool: "Tool", power_tool: "Power tool", asset: "Personal asset", cube_mould: "Cube mould", pump_pipe: "Pump pipe / bend" };
export const GROUP_KINDS = { tools: ["tool", "power_tool"], assets: ["asset"], "in-use": ["cube_mould", "pump_pipe"] };

export function StatusBadge({ s }) {
  const [label, cls] = ITEM_STATUS[s] || [s, "badge-neutral"];
  return <span className={`badge ${cls}`}>{label}</span>;
}
export const isOverdue = (it, today) => it.status === "issued" && it.mode === "temporary" && it.return_by && it.return_by < today;
export const thisMonth = () => todayIst().slice(0, 7);
export function nextMonth() {
  const [y, m] = thisMonth().split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// ------------------------------------------------------------ issue ---
export function IssueModal({ group, meta, items, onClose, onDone }) {
  const [f, setF] = useState({ employee_id: "", mode: "permanent", return_by: "", kit_id: "", note: "" });
  const [picked, setPicked] = useState([]);
  const [q, setQ] = useState("");
  const [short, setShort] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inStore = items.filter((i) => i.status === "in_store");
  const shown = inStore.filter((i) => !q || `${i.code} ${i.type_name} ${i.make_model || ""} ${i.serial_no || ""}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  async function loadKit(id) {
    setF((x) => ({ ...x, kit_id: id }));
    if (!id) { setShort([]); return; }
    try {
      const rows = await apiRequest(`/tools/kits/${id}/pick`);
      setPicked((p) => [...new Set([...p, ...rows.flatMap((r) => r.items.map((i) => i.id))])]);
      setShort(rows.filter((r) => r.short > 0).map((r) => `${r.name}${r.short > 1 ? ` × ${r.short}` : ""}`));
    } catch (e) { setErr(e.message); }
  }
  async function save() {
    setErr(""); setBusy(true);
    try {
      const out = await apiRequest("/tools/issues", { method: "POST", body: { ...f, employee_id: Number(f.employee_id), kit_id: Number(f.kit_id) || null, item_ids: picked } });
      onDone(`Sent for approval — ${out.count} item(s) for ${out.employee}.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={group === "assets" ? "Hand over an asset" : "Issue tools"} onClose={onClose} width={620}>
      <Msg err={err} />
      <div style={GRID(180)}>
        <Field label="Employee">
          <select value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
            <option value="">Choose…</option>
            {meta.employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.designation ? ` · ${e.designation}` : ""}</option>)}
          </select>
        </Field>
        <Field label="Kind of issue">
          <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            <option value="permanent">Permanent — keeps it</option><option value="temporary">Temporary — returns it</option>
          </select>
        </Field>
        {f.mode === "temporary" && <Field label="Return by"><input type="date" min={todayIst()} value={f.return_by} onChange={(e) => setF({ ...f, return_by: e.target.value })} /></Field>}
        {group === "tools" && meta.kits.some((k) => k.is_active) && (
          <Field label="Load a standard kit">
            <select value={f.kit_id} onChange={(e) => loadKit(e.target.value)}>
              <option value="">—</option>{meta.kits.filter((k) => k.is_active).map((k) => <option key={k.id} value={k.id}>{k.name} ({k.types.length})</option>)}
            </select>
          </Field>
        )}
      </div>
      {short.length > 0 && <div style={{ fontSize: 12.5, color: "var(--amber)", margin: "4px 0 8px" }}>Not in store (raise a PO): {short.join(", ")}</div>}
      <div style={{ ...ROW, margin: "8px 0" }}>
        <b style={{ fontSize: 13 }}>Items in store · {picked.length} picked</b>
        <input style={{ marginLeft: "auto", width: 200, padding: "6px 9px", fontSize: 13 }} placeholder="Search ID, name, serial" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
        {shown.map((i) => (
          <label key={i.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 10px", borderBottom: "1px solid var(--border)", fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={picked.includes(i.id)} onChange={() => toggle(i.id)} style={{ width: "auto" }} />
            <b style={{ minWidth: 70 }}>{i.code}</b><span style={{ flex: 1 }}>{i.type_name}{i.make_model ? ` · ${i.make_model}` : ""}</span>
            {i.serial_no && <span style={MUTED}>{i.serial_no}</span>}
          </label>
        ))}
        {!shown.length && <div style={{ ...MUTED, padding: 10 }}>Nothing in store{q ? " matches" : ""}.</div>}
      </div>
      <Field label="Note" style={{ marginTop: 10 }}><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} /></Field>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
        <span style={{ ...MUTED, flex: 1 }}>Goes to the {group === "assets" ? "Administrator" : "Plant In Charge"} to approve; then the employee accepts on the phone.</span>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !f.employee_id || !picked.length} onClick={save}>{busy ? "Sending…" : "Send for approval"}</button>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------- return ---
export function ReturnModal({ item, onClose, onDone }) {
  const [cond, setCond] = useState("good");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const powerTool = item.kind === "power_tool";
  return (
    <Modal title={`Take back ${item.code}`} onClose={onClose} width={460}>
      <div style={{ fontSize: 13.5, marginBottom: 10 }}><b>{item.type_name}</b>{item.make_model ? ` · ${item.make_model}` : ""}<div style={MUTED}>From {item.employee_name} · {item.mode}{item.serial_no ? ` · serial ${item.serial_no}` : ""}</div></div>
      {powerTool && <div style={{ fontSize: 12.5, background: "var(--concrete)", borderRadius: 8, padding: 8, marginBottom: 10 }}>Check: serial number matches · cable, plug & switch · accessories · test run.</div>}
      <Msg err={err} />
      <div style={{ ...ROW, marginBottom: 10 }}>
        {[["good", "Good"], ["damaged", "Damaged"], ["lost", "Lost"]].map(([k, l]) => (
          <button key={k} type="button" className={cond === k ? "btn-primary" : ""} onClick={() => setCond(k)}>{l}</button>
        ))}
      </div>
      <Field label={cond === "good" ? "Note (optional)" : "What happened"}><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      {cond !== "good" && <div style={{ ...MUTED, marginTop: 6 }}>The Administrator decides: no charge, repair at company cost, or recover from salary.</div>}
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
          setBusy(true); setErr("");
          try { await apiRequest(`/tools/lines/${item.line_id}/return`, { method: "POST", body: { condition: cond, note } }); onDone(`${item.code} taken back — ${cond}.`); }
          catch (e) { setErr(e.message); setBusy(false); }
        }}>Save</button>
      </div>
    </Modal>
  );
}

// --------------------------------------------------- report damaged ---
export function DamageModal({ items, preselect = [], reasons, onClose, onDone }) {
  const eligible = items.filter((i) => ["in_store", "in_use", "at_site", "repair"].includes(i.status));
  const [picked, setPicked] = useState(preselect);
  const [q, setQ] = useState("");
  const [f, setF] = useState({ reason: "", note: "", scrap: true, photo: null });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = eligible.filter((i) => picked.includes(i.id) || (q && `${i.code} ${i.type_name}`.toLowerCase().includes(q.toLowerCase())));
  const lost = f.reason === "Lost";
  return (
    <Modal title="Report damaged / lost" onClose={onClose} width={520}>
      <Msg err={err} />
      <Field label="Item ID(s)"><input placeholder="Type an ID, e.g. PP-022" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} /></Field>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "8px 0" }}>
        {shown.slice(0, 30).map((i) => (
          <label key={i.id} style={{ display: "flex", gap: 8, alignItems: "center", border: `1px solid ${picked.includes(i.id) ? "var(--charcoal)" : "var(--border)"}`, borderRadius: 8, padding: "7px 10px", fontSize: 13 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={picked.includes(i.id)} onChange={() => setPicked((p) => (p.includes(i.id) ? p.filter((x) => x !== i.id) : [...p, i.id]))} />
            <b>{i.code}</b><span style={MUTED}>{i.type_name} · {i.location || ITEM_STATUS[i.status]?.[0]}</span>
          </label>
        ))}
      </div>
      <div style={{ ...MUTED, marginBottom: 8 }}>{picked.length} selected — each ID is removed on its own.</div>
      <div style={{ ...ROW, marginBottom: 8 }}>
        {reasons.map((r) => <button key={r} type="button" style={SMALL_BTN} className={f.reason === r ? "btn-primary" : ""} onClick={() => setF({ ...f, reason: r })}>{r}</button>)}
      </div>
      <Field label="Note"><textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} placeholder="e.g. burst at the collar during pour, order 1191" /></Field>
      <div style={{ ...ROW, marginTop: 8 }}>
        <label style={{ ...ROW, gap: 6, fontSize: 13 }}><input type="file" accept="image/*" capture="environment" style={{ width: "auto" }}
          onChange={async (e) => { const file = e.target.files?.[0]; if (file) { try { setF({ ...f, photo: await readPhotoSmall(file) }); } catch (x) { setErr(x.message); } } }} />
          Photo {lost ? "(optional)" : "(required)"}</label>
        {f.photo && <span className="badge badge-success">photo added</span>}
      </div>
      {!lost && <label style={{ ...ROW, gap: 6, fontSize: 13, marginTop: 8 }}><input type="checkbox" checked={f.scrap} onChange={(e) => setF({ ...f, scrap: e.target.checked })} style={{ width: "auto" }} /> Kept aside for scrap sale</label>}
      <div style={{ fontSize: 12.5, background: "var(--amber-bg)", borderRadius: 8, padding: 8, marginTop: 10 }}>
        Stays on the list as <b>removal pending</b> until the {lost ? "Administrator" : "Plant In Charge"} approves. The ID is never used again.
      </div>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !picked.length || !f.reason} onClick={async () => {
          setBusy(true); setErr("");
          try { const o = await apiRequest("/tools/removals", { method: "POST", body: { ...f, item_ids: picked } }); onDone(`${o.codes.join(", ")} sent for approval.`); }
          catch (e) { setErr(e.message); setBusy(false); }
        }}>Send for approval</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------- item card ---
const PHONE_FIELDS = [["mobile_no", "Mobile no."], ["provider", "Provider"], ["iccid", "SIM ICCID"], ["plan", "Plan & usage limit"],
  ["imei1", "IMEI 1"], ["imei2", "IMEI 2"], ["accessories", "Accessories"]];
export function ItemModal({ id, canEdit, onClose, onChanged }) {
  const d = useLoad(`/tools/items/${id}`, [id]);
  const [f, setF] = useState(null);
  const [err, setErr] = useState("");
  if (!d.data) return <Modal title="Item" onClose={onClose}><Loading error={d.error} /></Modal>;
  const it = d.data;
  const phoneLike = it.kind === "asset";
  const edit = f || { make_model: it.make_model || "", serial_no: it.serial_no || "", warranty_until: it.warranty_until || "", purchase_value: it.purchase_value ?? "", condition_note: it.condition_note || "", details: it.details || {} };
  return (
    <Modal title={`${it.code} · ${it.type_name}`} onClose={onClose} width={640}>
      <div style={{ ...ROW, marginBottom: 8 }}><StatusBadge s={it.status} />
        <span style={MUTED}>{it.employee_name ? `With ${it.employee_name}` : it.location || ""}{it.cast_ref ? ` · ${it.cast_ref}` : ""} · since {fmtDate(it.since)}</span></div>
      <div style={{ ...MUTED, marginBottom: 10 }}>From {it.source === "grv" ? `GRV-${String(it.grv_id).padStart(4, "0")}` : it.source === "opening" ? "the existing list" : "added by hand"}{it.purchase_value ? ` · ${fmtRs(it.purchase_value, 2)}` : ""}{it.purchase_date ? ` · ${fmtDate(it.purchase_date)}` : ""}{it.warranty_until ? ` · warranty to ${fmtDate(it.warranty_until)}` : ""}</div>
      {canEdit && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 12 }}>
          <Msg err={err} />
          <div style={GRID(170)}>
            <Field label="Make / model"><input value={edit.make_model} onChange={(e) => setF({ ...edit, make_model: e.target.value })} /></Field>
            <Field label="Serial no."><input value={edit.serial_no} onChange={(e) => setF({ ...edit, serial_no: e.target.value })} /></Field>
            <Field label="Value ₹"><input inputMode="decimal" value={edit.purchase_value} onChange={(e) => setF({ ...edit, purchase_value: e.target.value })} /></Field>
            <Field label="Warranty until"><input type="date" value={edit.warranty_until} onChange={(e) => setF({ ...edit, warranty_until: e.target.value })} /></Field>
            {phoneLike && PHONE_FIELDS.map(([k, l]) => (
              <Field key={k} label={l}><input value={edit.details?.[k] || ""} onChange={(e) => setF({ ...edit, details: { ...edit.details, [k]: e.target.value } })} /></Field>
            ))}
            <Field label="Condition note"><input value={edit.condition_note} onChange={(e) => setF({ ...edit, condition_note: e.target.value })} /></Field>
          </div>
          {f && <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" onClick={() => setF(null)}>Undo</button>
            <button type="button" className="btn-primary" onClick={async () => {
              try { await apiRequest(`/tools/items/${it.id}/edit`, { method: "POST", body: f }); setF(null); d.load(); onChanged?.(); } catch (e) { setErr(e.message); }
            }}>Save</button>
          </div>}
        </div>
      )}
      {it.issues.length > 0 && (<>
        <h3 style={H2}>Issued</h3>
        {it.issues.map((s) => (
          <div key={`${s.id}`} style={{ fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--border)" }}>
            {s.employee} · {s.mode} · {s.status}{s.returned_at ? ` · back ${fmtDate(s.returned_at)} (${s.return_condition})` : ""}{s.decision ? ` · ${s.decision.replace("_", " ")}${s.recover_amount ? ` ${fmtRs(s.recover_amount)}` : ""}` : ""}
          </div>
        ))}
      </>)}
      <h3 style={{ ...H2, marginTop: 12 }}>History</h3>
      {it.events.map((e) => (
        <div key={e.id} style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
          <span style={{ minWidth: 110, color: "var(--slate)" }}>{fmtWhen(e.created_at)}</span><span style={{ flex: 1 }}>{e.note || e.event}</span><span style={MUTED}>{e.by_name}</span>
        </div>
      ))}
    </Modal>
  );
}

// ---------------------------------------- add existing list (batch) ---
export function AddListModal({ kinds, meta, title, onClose, onDone }) {
  const types = meta.types.filter((t) => kinds.includes(t.kind) && t.is_active);
  const inUse = kinds.some((k) => k === "cube_mould" || k === "pump_pipe");
  const blank = () => ({ type_id: types[0]?.id || "", qty: "", location: inUse ? meta.places[0] : "", site: "", codes: "", condition_note: "" });
  const [rows, setRows] = useState([blank()]);
  const [mode, setMode] = useState("count");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const total = rows.reduce((s, r) => s + (mode === "own" ? r.codes.split(/[,\s]+/).filter(Boolean).length : Number(r.qty) || 0), 0);
  const placeOptions = inUse ? [...meta.places.filter((p) => p !== "Tools store"), "At a site…"] : [];
  return (
    <Modal title={title} onClose={onClose} width={860}>
      <p style={{ ...MUTED, marginTop: 0 }}>Count what you have today and enter it here — the app gives every item an ID. The Plant In Charge confirms the list once; after that new items come from GRVs. Paint or stick the ID on each item.</p>
      <div style={{ ...ROW, marginBottom: 10 }}>
        <button type="button" className={mode === "count" ? "btn-primary" : ""} onClick={() => setMode("count")}>Enter by count</button>
        <button type="button" className={mode === "own" ? "btn-primary" : ""} onClick={() => setMode("own")}>Already numbered — enter your own IDs</button>
      </div>
      <Msg err={err} />
      <Table minWidth={680}>
        <thead><tr><th>Item type</th>{inUse && <th>Where</th>}<th>{mode === "own" ? "Your IDs (CM-001, CM-002 …)" : "How many"}</th><th>Condition</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><select value={r.type_id} onChange={(e) => set(i, "type_id", e.target.value)}>{types.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.prefix}</option>)}</select></td>
              {inUse && <td>
                <select value={r.location} onChange={(e) => set(i, "location", e.target.value)}>{placeOptions.map((p) => <option key={p}>{p}</option>)}</select>
                {r.location === "At a site…" && <input style={{ marginTop: 4 }} placeholder="Customer / site" value={r.site} onChange={(e) => set(i, "site", e.target.value)} />}
              </td>}
              <td>{mode === "own" ? <input value={r.codes} onChange={(e) => set(i, "codes", e.target.value.toUpperCase())} /> : <input inputMode="numeric" style={{ width: 80 }} value={r.qty} onChange={(e) => set(i, "qty", e.target.value)} />}</td>
              <td><input value={r.condition_note} placeholder="Good" onChange={(e) => set(i, "condition_note", e.target.value)} /></td>
              <td><button type="button" style={SMALL_BTN} onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove row">✕</button></td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div style={{ ...ROW, marginTop: 8 }}>
        <button type="button" style={SMALL_BTN} onClick={() => setRows([...rows, blank()])}>+ Add a row</button>
        <span style={MUTED}>Items to get an ID: <b>{total}</b></span>
      </div>
      <Field label="Note" style={{ marginTop: 10 }}><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. counted on 3 Nov" /></Field>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !total} onClick={async () => {
          setBusy(true); setErr("");
          try {
            const body = { note, rows: rows.map((r) => ({ type_id: Number(r.type_id), qty: Number(r.qty), codes: mode === "own" ? r.codes : "",
              location: r.location === "At a site…" ? (r.site ? `Site · ${r.site}` : "Site") : r.location, condition_note: r.condition_note })) };
            const o = await apiRequest("/tools/items/add", { method: "POST", body });
            onDone(`${o.codes.length} item(s) numbered ${o.codes[0]} … ${o.codes[o.codes.length - 1]} — sent to the Plant In Charge to confirm.`);
          } catch (e) { setErr(e.message); setBusy(false); }
        }}>Send to Plant In Charge to confirm</button>
      </div>
    </Modal>
  );
}

// Lists waiting for the Plant In Charge (add existing / corrections).
export function BatchesCard({ batches, kinds, canConfirm, onChanged }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const list = (batches || []).filter((b) => b.status === "pending" && (b.lines || []).some((l) => kinds.includes(l.kind)));
  if (!list.length) return null;
  return (
    <section className="card" style={{ borderColor: "var(--amber)", marginBottom: 14 }}>
      <h2 style={H2}>Lists to confirm</h2>
      <Msg err={err} />
      {list.map((b) => (
        <div key={b.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", fontSize: 13 }}>
          <div><b>{b.is_opening ? "Existing list" : "Correction"}</b> · by {b.created_by_name} {fmtWhen(b.created_at)}{b.note ? ` — ${b.note}` : ""}</div>
          {(b.lines || []).map((l, i) => <div key={i} style={MUTED}>{l.type}: {l.n} · {l.first}{l.n > 1 ? ` … ${l.last}` : ""}{l.places ? ` · ${l.places}` : ""}</div>)}
          {canConfirm && (
            <div style={{ ...ROW, marginTop: 6 }}>
              <input style={{ width: 200 }} placeholder="Note (to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="btn-primary" style={SMALL_BTN} onClick={async () => { try { await apiRequest(`/tools/batches/${b.id}/decide`, { method: "POST", body: { action: "confirm" } }); onChanged("List confirmed — the items count now."); } catch (e) { setErr(e.message); } }}>Confirm list</button>
              <button type="button" style={SMALL_BTN} onClick={async () => { try { await apiRequest(`/tools/batches/${b.id}/decide`, { method: "POST", body: { action: "reject", note } }); onChanged("List rejected."); } catch (e) { setErr(e.message); } }}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// Removals waiting for approval.
export function RemovalsCard({ removals, kinds, can, onChanged, onPhoto }) {
  const [err, setErr] = useState("");
  const list = (removals || []).filter((r) => r.status === "pending" && kinds.includes(r.kind));
  if (!list.length) return null;
  return (
    <section className="card" style={{ borderColor: "var(--rebar)", marginBottom: 14 }}>
      <h2 style={H2}>Removals waiting for approval</h2>
      <Msg err={err} />
      {list.map((r) => {
        const mayDecide = r.is_lost ? can("tools.loss-decide", "edit") : can("tools.removal-approve", "edit");
        return (
          <div key={r.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", fontSize: 13 }}>
            <b>{r.code}</b> · {r.name} — {r.reason}{r.note ? `: ${r.note}` : ""}{r.scrap ? " · kept for scrap" : ""}
            <div style={MUTED}>Reported by {r.reported_by_name} {fmtWhen(r.reported_at)} · {r.location || ""}{r.is_lost ? " · approved by the Administrator" : ""}
              {r.has_photo && <> · <button type="button" style={{ ...SMALL_BTN, padding: "1px 7px" }} onClick={() => onPhoto(r)}>Photo</button></>}</div>
            {mayDecide && (
              <div style={{ ...ROW, marginTop: 6 }}>
                <button type="button" className="btn-primary" style={SMALL_BTN} onClick={async () => { try { await apiRequest(`/tools/removals/${r.id}/decide`, { method: "POST", body: { action: "approve" } }); onChanged(`${r.code} removed.`); } catch (e) { setErr(e.message); } }}>Approve removal</button>
                <button type="button" style={SMALL_BTN} onClick={async () => { const n = window.prompt("Reject — why?"); if (n === null) return; try { await apiRequest(`/tools/removals/${r.id}/decide`, { method: "POST", body: { action: "reject", note: n } }); onChanged(`${r.code} stays on the list.`); } catch (e) { setErr(e.message); } }}>Reject</button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function useFiltered(items, { q, status, kind }) {
  return useMemo(() => (items || []).filter((i) => (!kind || i.kind === kind) && (!status || (status === "out" ? i.status === "issued" : i.status === status))
    && (!q || `${i.code} ${i.type_name} ${i.make_model || ""} ${i.serial_no || ""} ${i.employee_name || ""} ${i.location || ""}`.toLowerCase().includes(q.toLowerCase()))), [items, q, status, kind]);
}
