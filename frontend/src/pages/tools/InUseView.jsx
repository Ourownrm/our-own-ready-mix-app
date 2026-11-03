// Round 264 — Maintenance → Cube moulds & pipes (owner, 3 Nov 2026): every
// mould and pump pipe has its own ID; the list starts from a one-time
// "add existing list" the Plant In Charge confirms, grows only through GRVs,
// and shrinks only by an approved removal.
import { useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { Modal, PhotoModal } from "../accounts/ui.jsx";
import { Field, Msg, MUTED, ROW, GRID, SMALL_BTN, fmtDate, fmtWhen, useLoad, Loading, Table, H2 } from "../maintenance/mntUi.jsx";
import { StatusBadge, DamageModal, ItemModal, AddListModal, BatchesCard, RemovalsCard, GROUP_KINDS } from "./toolsShared.jsx";

export default function InUseView() {
  const { can } = usePermissions();
  const mayView = can("tools.in-use", "view"), mayMove = can("tools.in-use", "edit"), mayAdd = can("tools.in-use", "create");
  const mayReport = can("tools.report-damage", "create");
  const meta = useLoad("/tools/meta");
  const items = useLoad(mayView ? "/tools/items?group=in-use" : null);
  const batches = useLoad("/tools/batches");
  const removals = useLoad("/tools/removals");
  const history = useLoad(mayView ? "/tools/history?group=in-use" : null);
  const [tab, setTab] = useState("cube_mould");
  const [q, setQ] = useState("");
  const [where, setWhere] = useState("");
  const [sel, setSel] = useState([]);
  const [modal, setModal] = useState(null);
  const [msg, setMsg] = useState("");
  const reload = (m) => { if (m) setMsg(m); setModal(null); setSel([]); items.load(); batches.load(); removals.load(); history.load(); };
  const all = items.data?.items || [];
  const ofKind = all.filter((i) => i.kind === tab);
  const byType = useMemo(() => {
    const m = new Map();
    for (const i of ofKind) {
      const r = m.get(i.type_name) || { name: i.type_name, prefix: i.prefix, total: 0, places: {}, pending: 0 };
      if (i.status === "pending") continue;
      r.total += 1;
      if (i.status === "removal_pending") r.pending += 1;
      const p = i.status === "at_site" ? "At sites" : i.location || "—";
      r.places[p] = (r.places[p] || 0) + 1;
      m.set(i.type_name, r);
    }
    return [...m.values()];
  }, [ofKind]);
  const places = [...new Set(ofKind.map((i) => (i.status === "at_site" ? "At sites" : i.location)).filter(Boolean))];
  const list = ofKind.filter((i) => i.status !== "pending" && (!where || (where === "At sites" ? i.status === "at_site" : i.location === where))
    && (!q || `${i.code} ${i.type_name} ${i.location || ""} ${i.cast_ref || ""}`.toLowerCase().includes(q.toLowerCase())));
  if (!meta.data) return <Loading error={meta.error} />;
  const confirmed = (batches.data || []).some((b) => b.status === "confirmed" && (b.lines || []).some((l) => GROUP_KINDS["in-use"].includes(l.kind)));

  return (
    <>
      <div style={{ ...ROW, marginBottom: 6 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Cube moulds &amp; concrete pump pipes</h1>
        <span style={MUTED}>Always in use — not issued to a person. Every item has its own ID.</span>
      </div>
      <div style={{ ...ROW, margin: "10px 0 14px" }}>
        <button type="button" className={tab === "cube_mould" ? "btn-primary" : ""} onClick={() => { setTab("cube_mould"); setWhere(""); setSel([]); }}>Cube moulds · {all.filter((i) => i.kind === "cube_mould" && i.status !== "pending").length}</button>
        <button type="button" className={tab === "pump_pipe" ? "btn-primary" : ""} onClick={() => { setTab("pump_pipe"); setWhere(""); setSel([]); }}>Pump pipes &amp; bends · {all.filter((i) => i.kind === "pump_pipe" && i.status !== "pending").length}</button>
        <div style={{ marginLeft: "auto", ...ROW }}>
          {mayAdd && <button type="button" onClick={() => setModal({ kind: "add" })}>{confirmed ? "+ Correction (missed items)" : "+ Add existing list (one time)"}</button>}
          {mayReport && <button type="button" onClick={() => setModal({ kind: "damage" })}>Report damaged</button>}
        </div>
      </div>
      <Msg msg={msg} />
      <BatchesCard batches={batches.data} kinds={GROUP_KINDS["in-use"]} canConfirm={can("tools.removal-approve", "edit")} onChanged={reload} />
      <RemovalsCard removals={removals.data} kinds={GROUP_KINDS["in-use"]} can={can} onChanged={reload} onPhoto={(r) => setModal({ kind: "photo", r })} />

      {mayView && (<>
        <div style={{ ...GRID(200), marginBottom: 14 }}>
          {byType.map((t) => (
            <div key={t.name} className="kpi">
              <div className="kpi-label">{t.name} · {t.prefix}</div>
              <div className="kpi-value">{t.total}</div>
              <div style={{ ...MUTED, fontSize: 12 }}>{Object.entries(t.places).map(([p, n]) => `${n} ${p}`).join(" · ")}</div>
            </div>
          ))}
          {!byType.length && <div className="card" style={MUTED}>Nothing on the list yet — start with “Add existing list”.</div>}
        </div>
        <section className="card" style={{ marginBottom: 14 }}>
          <div style={{ ...ROW, marginBottom: 10 }}>
            <b style={{ fontSize: 14 }}>{tab === "cube_mould" ? "Cube moulds" : "Pump pipes & bends"} — item list</b>
            <select value={where} onChange={(e) => setWhere(e.target.value)} style={{ width: "auto", marginLeft: "auto" }}><option value="">All places</option>{places.map((p) => <option key={p}>{p}</option>)}</select>
            <input style={{ width: 200 }} placeholder={tab === "cube_mould" ? "Search ID e.g. CM-041" : "Search ID e.g. PP-022"} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {sel.length > 0 && (
            <div style={{ ...ROW, background: "var(--concrete)", borderRadius: 8, padding: 8, marginBottom: 8 }}>
              <b style={{ fontSize: 13 }}>{sel.length} selected</b>
              {mayMove && <button type="button" style={SMALL_BTN} className="btn-primary" onClick={() => setModal({ kind: "move" })}>Move</button>}
              {mayReport && <button type="button" style={SMALL_BTN} onClick={() => setModal({ kind: "damage", pre: sel })}>Report damaged</button>}
              <button type="button" style={SMALL_BTN} onClick={() => setSel([])}>Clear</button>
            </div>
          )}
          {!items.data ? <Loading error={items.error} /> : (
            <Table minWidth={760}>
              <thead><tr><th style={{ width: 30 }} /><th>ID</th><th>Type</th><th>Where now</th><th>Came from</th><th>{tab === "cube_mould" ? "Last cube cast" : "Note"}</th><th>Status</th></tr></thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id}>
                    <td>{["in_use", "at_site"].includes(i.status) && (mayMove || mayReport) && <input type="checkbox" style={{ width: "auto" }} checked={sel.includes(i.id)} onChange={() => setSel((s) => (s.includes(i.id) ? s.filter((x) => x !== i.id) : [...s, i.id]))} aria-label={`Select ${i.code}`} />}</td>
                    <td><button type="button" style={{ ...SMALL_BTN, fontWeight: 700 }} onClick={() => setModal({ kind: "item", id: i.id })}>{i.code}</button></td>
                    <td>{i.type_name}</td>
                    <td>{i.location || "—"}</td>
                    <td>{i.source === "grv" ? `GRV-${String(i.grv_id).padStart(4, "0")} · ${fmtDate(i.purchase_date)}` : "Existing list"}</td>
                    <td>{i.cast_ref || i.condition_note || <span style={MUTED}>—</span>}</td>
                    <td><StatusBadge s={i.status} /></td>
                  </tr>
                ))}
                {!list.length && <tr><td colSpan={7} style={MUTED}>Nothing here.</td></tr>}
              </tbody>
            </Table>
          )}
          <div style={{ ...MUTED, marginTop: 8 }}>
            {tab === "cube_mould" ? "The Lab Technician types the mould IDs when recording a site cube cast, so “Where now” and “Last cube cast” fill in by themselves. Bring them back with Move → Plant lab." : "ID prefixes: PP straight pipe · PB bend · PR reducer · PH hose. Moving pipes between the boom placer, line pump set and plant spare is logged in the history."}
            {" "}After the existing list is confirmed, new moulds and pipes come only from a GRV (a store item in the Cube moulds / Pump pipes category).
          </div>
        </section>
        <section className="card">
          <h2 style={H2}>History</h2>
          {(history.data || []).map((h, k) => (
            <div key={k} style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
              <span style={{ minWidth: 110, color: "var(--slate)" }}>{fmtWhen(h.created_at)}</span><b style={{ minWidth: 64 }}>{h.code}</b><span style={{ flex: 1 }}>{h.note || h.event}</span><span style={MUTED}>{h.by_name}</span>
            </div>
          ))}
          {!(history.data || []).length && <div style={MUTED}>No changes yet.</div>}
        </section>
      </>)}

      {modal?.kind === "add" && <AddListModal kinds={GROUP_KINDS["in-use"]} meta={meta.data} title={confirmed ? "Correction — items missed from the list" : "Add existing list — cube moulds & pipes"} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "damage" && <DamageModal items={all} preselect={modal.pre || []} reasons={meta.data.reasons} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "item" && <ItemModal id={modal.id} canEdit={mayMove} onClose={() => setModal(null)} onChanged={() => items.load()} />}
      {modal?.kind === "move" && <MoveModal ids={sel} places={meta.data.places.filter((p) => p !== "Tools store")} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "photo" && <PhotoModal path={`/tools/removals/${modal.r.id}/photo`} title={`${modal.r.code} · photo`} onClose={() => setModal(null)} />}
    </>
  );
}

function MoveModal({ ids, places, onClose, onDone }) {
  const [place, setPlace] = useState(places[0]);
  const [site, setSite] = useState("");
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");
  const toSite = place === "At a site…";
  return (
    <Modal title={`Move ${ids.length} item(s)`} onClose={onClose} width={440}>
      <Msg err={err} />
      <Field label="To"><select value={place} onChange={(e) => setPlace(e.target.value)}>{[...places, "At a site…"].map((p) => <option key={p}>{p}</option>)}</select></Field>
      {toSite && <>
        <Field label="Customer / site" style={{ marginTop: 8 }}><input value={site} onChange={(e) => setSite(e.target.value)} /></Field>
        <Field label="Order / cast (optional)" style={{ marginTop: 8 }}><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      </>}
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={toSite && !site} onClick={async () => {
          try { await apiRequest("/tools/items/move", { method: "POST", body: { item_ids: ids, location: toSite ? `Site · ${site}` : place, cast_ref: ref } }); onDone(`${ids.length} moved.`); }
          catch (e) { setErr(e.message); }
        }}>Move</button>
      </div>
    </Modal>
  );
}
