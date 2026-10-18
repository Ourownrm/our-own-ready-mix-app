// Round 216 — Tyres & batteries (mockup screen 10). Every tyre and battery by
// serial number: where it is fitted, how far it has run, its tread, retreads,
// warranty. Pick a vehicle to see its tyre map; tap a position to fit, rotate,
// remove (to store, retread or scrap) or record the tread. Every move records
// the odometer, so a tyre's life follows it across vehicles and retreads.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, Kpi, fmtNum, fmtRs, fmtDate, fmtWhen, todayIst, H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN } from "./mntUi.jsx";

const ACTION = {
  add: "Added to register", fit: "Fitted", remove: "Removed to store", rotate: "Moved", retread_out: "Sent to retread",
  retread_back: "Back from retread", scrap: "Scrapped", tread: "Tread reading", claim: "Warranty claim", claim_closed: "Claim closed",
};
const tone = (mm) => (mm == null ? "#9AA1A9" : mm < 4 ? "var(--alert-red)" : mm < 6 ? "var(--amber)" : "var(--signal-green)");

// Positions in rows: front axle, each rear axle, spare.
function layoutRows(layout) {
  const rows = [];
  const front = layout.filter((p) => ["FL", "FR", "F"].includes(p));
  if (front.length) rows.push({ label: "Front", items: front });
  const axles = {};
  for (const p of layout) {
    if (["FL", "FR", "F", "SPARE"].includes(p)) continue;
    const key = p.includes("-") ? p.split("-")[0] : "Rear";
    (axles[key] = axles[key] || []).push(p);
  }
  for (const [k, v] of Object.entries(axles)) rows.push({ label: k === "Rear" || k === "R" ? "Rear" : `Rear axle ${k.replace(/\D/g, "") || ""}`.trim(), items: v });
  if (layout.includes("SPARE")) rows.push({ label: "Spare", items: ["SPARE"] });
  return rows;
}

export default function MntTyres() {
  const { can } = usePermissions();
  const ov = useLoad("/maintenance-module/tyres/overview");
  const [vid, setVid] = useState(null);
  const [view, setView] = useState("vehicle"); // vehicle | store | batteries
  const [register, setRegister] = useState(null); // { kind: tyre|battery, ...fields }
  const act = useAction(() => { ov.load(); setRegister(null); });

  if (!ov.data) return <Loading error={ov.error} />;
  const k = ov.data.kpis;
  const vehicles = ov.data.vehicles;
  const sel = vid || vehicles.find((v) => v.positions)?.id || vehicles[0]?.id;
  const canCreate = can("mnt.tyres", "create");

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Kpi label="Tyres fitted" value={k.fitted} sub={`+ ${k.spares} spares · ${k.in_store} in store`} />
        <Kpi label="Below 4 mm tread" value={k.low_tread} tone={k.low_tread ? "bad" : undefined} onClick={() => setView("store")} />
        <Kpi label="At retreading" value={k.at_retread} onClick={() => setView("store")} />
        <Kpi label="Cost per km · tyres" value={k.cost_per_km != null ? `₹${k.cost_per_km}` : "—"} sub="fleet, tyre life so far" />
        <Kpi label="Battery warranty ≤ 60 d" value={k.battery_warranty_soon} tone={k.battery_warranty_soon ? "warn" : undefined} sub={k.battery_claims ? `${k.battery_claims} claim(s) open` : undefined} onClick={() => setView("batteries")} />
      </div>

      <div style={{ ...ROW, marginBottom: 12 }}>
        {[["vehicle", "By vehicle"], ["store", "Tyres in store & retread"], ["batteries", "Batteries"]].map(([key, l]) => (
          <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}
            style={{ padding: "7px 13px", fontSize: 12.5, borderRadius: 20, background: view === key ? "var(--charcoal)" : "#fff", color: view === key ? "#fff" : "var(--charcoal)" }}>{l}</button>
        ))}
        <div style={{ flex: 1 }} />
        {canCreate && <button type="button" style={SMALL_BTN} onClick={() => setRegister({ kind: "tyre", serial: "", brand: "", size: "", pattern: "", type: "new", cost: "", supplier: "", purchase_date: "", tread_mm: "" })}>+ Tyre to register</button>}
        {canCreate && <button type="button" style={SMALL_BTN} onClick={() => setRegister({ kind: "battery", serial: "", make: "", spec: "", cost: "", supplier: "", purchase_date: "", warranty_until: "" })}>+ Battery to register</button>}
      </div>
      <Msg msg={act.msg} err={act.err} />
      {register && <RegisterForm r={register} setR={setRegister} act={act} />}

      {view === "vehicle" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <aside className="card" style={{ flex: "1 1 240px", maxWidth: 320, padding: 10 }}>
            {vehicles.length === 0 && <div style={MUTED}>No vehicles in the register yet.</div>}
            {vehicles.map((v) => (
              <button key={v.id} type="button" onClick={() => setVid(v.id)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: 10, borderRadius: 8, marginBottom: 2,
                  border: `1px solid ${v.id === sel ? "#E7C3A6" : "transparent"}`, background: v.id === sel ? "#FBF3EC" : "none" }}>
                <b style={{ fontSize: 13 }}>{v.name.replace(/ — .*$/, "")}</b>
                <span style={{ ...MUTED, fontSize: 11.5, display: "block" }}>
                  {v.asset_group}{v.positions ? ` · ${v.fitted}/${v.positions} tyres` : ""}{v.min_tread != null ? ` · min ${v.min_tread} mm` : ""}{v.batteries ? ` · ${v.batteries} batt.` : ""}
                </span>
              </button>
            ))}
          </aside>
          {sel && <Vehicle key={sel} id={sel} onChanged={() => ov.load()} />}
        </div>
      )}
      {view === "store" && <StoreTyres data={ov.data} onChanged={() => ov.load()} />}
      {view === "batteries" && <Batteries data={ov.data} onChanged={() => ov.load()} />}
    </>
  );
}

function RegisterForm({ r, setR, act }) {
  const vehicles = useLoad("/maintenance-module/asset-options");
  const veh = useLoad(r.fit_asset ? `/maintenance-module/tyres/vehicle/${r.fit_asset}` : null, [r.fit_asset]);
  const set = (v) => setR({ ...r, ...v });
  const tyre = r.kind === "tyre";
  const slots = veh.data ? (tyre ? veh.data.layout.filter((p) => !veh.data.tyres.some((t) => t.position === p)) : veh.data.battery_slots.filter((p) => !veh.data.batteries.some((b) => b.position === p))) : [];
  const issues = (veh.data?.store_issues || []).filter((x) => x.category === (tyre ? "Tyres" : "Batteries"));
  function save() {
    const body = tyre
      ? { serial: r.serial, brand: r.brand, size: r.size, pattern: r.pattern, kind: r.type, cost: r.cost, supplier: r.supplier, purchase_date: r.purchase_date, tread_mm: r.tread_mm, store_txn_id: r.store_txn_id || null }
      : { serial: r.serial, make: r.make, spec: r.spec, cost: r.cost, supplier: r.supplier, purchase_date: r.purchase_date, warranty_until: r.warranty_until, store_txn_id: r.store_txn_id || null };
    if (r.fit_asset && r.fit_position) body.fit = { asset_id: r.fit_asset, position: r.fit_position, km: r.fit_km };
    act.run(() => apiRequest(`/maintenance-module/${tyre ? "tyres" : "batteries"}`, { method: "POST", body }), `${tyre ? "Tyre" : "Battery"} added.`);
  }
  return (
    <section className="card" style={{ marginBottom: 16, borderColor: "#E7C3A6" }}>
      <h2 style={H2}>{tyre ? "Add a tyre to the register" : "Add a battery to the register"}</h2>
      <p style={{ ...MUTED, marginTop: 0 }}>
        A new {tyre ? "tyre" : "battery"} bought for a vehicle is issued from Store against its job card — pick that issue below so its cost isn’t counted twice.
        For one already on a vehicle, just fit it with today’s reading.
      </p>
      <div style={GRID(160)}>
        <Field label="Serial no."><input value={r.serial} onChange={(e) => set({ serial: e.target.value })} /></Field>
        {tyre ? (
          <>
            <Field label="Brand"><input value={r.brand} onChange={(e) => set({ brand: e.target.value })} placeholder="MRF, Apollo…" /></Field>
            <Field label="Size"><input value={r.size} onChange={(e) => set({ size: e.target.value })} placeholder="10.00 R20" /></Field>
            <Field label="Pattern"><input value={r.pattern} onChange={(e) => set({ pattern: e.target.value })} /></Field>
            <Field label="New / retread"><select value={r.type} onChange={(e) => set({ type: e.target.value })}><option value="new">New</option><option value="retread">Retread</option></select></Field>
            <Field label="Tread (mm)"><input inputMode="decimal" value={r.tread_mm} onChange={(e) => set({ tread_mm: e.target.value })} /></Field>
          </>
        ) : (
          <>
            <Field label="Make"><input value={r.make} onChange={(e) => set({ make: e.target.value })} placeholder="Amaron, Exide…" /></Field>
            <Field label="Spec"><input value={r.spec} onChange={(e) => set({ spec: e.target.value })} placeholder="12 V 150 Ah" /></Field>
            <Field label="Warranty until"><input type="date" value={r.warranty_until} onChange={(e) => set({ warranty_until: e.target.value })} /></Field>
          </>
        )}
        <Field label="Supplier"><input value={r.supplier} onChange={(e) => set({ supplier: e.target.value })} /></Field>
        <Field label="Purchase date"><input type="date" value={r.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} /></Field>
        {!r.store_txn_id && <Field label="Cost ₹"><input inputMode="decimal" value={r.cost} onChange={(e) => set({ cost: e.target.value })} /></Field>}
      </div>
      <div style={{ ...GRID(180), marginTop: 12, background: "var(--concrete)", padding: 12, borderRadius: 8 }}>
        <Field label="Fit now on (optional)">
          <select value={r.fit_asset || ""} onChange={(e) => set({ fit_asset: e.target.value ? Number(e.target.value) : null, fit_position: "", store_txn_id: "" })}>
            <option value="">— keep in store —</option>
            {(vehicles.data || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        {r.fit_asset && (
          <>
            <Field label="Position">
              <select value={r.fit_position || ""} onChange={(e) => set({ fit_position: e.target.value })}>
                <option value="">Select…</option>{slots.map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Odometer km"><input inputMode="decimal" value={r.fit_km || ""} placeholder={veh.data?.asset.km != null ? `last ${veh.data.asset.km}` : ""} onChange={(e) => set({ fit_km: e.target.value })} /></Field>
            <Field label="Bought as (store issue)">
              <select value={r.store_txn_id || ""} onChange={(e) => set({ store_txn_id: e.target.value })}>
                <option value="">Not from a store issue</option>
                {issues.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.card} · {fmtDate(x.created_at)} · {fmtRs(x.rate)}</option>)}
              </select>
            </Field>
          </>
        )}
      </div>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={() => setR(null)}>Cancel</button>
        <button type="button" className="btn-primary" disabled={act.busy} onClick={save}>Save</button>
      </div>
    </section>
  );
}

function Vehicle({ id, onChanged }) {
  const { can } = usePermissions();
  const d = useLoad(`/maintenance-module/tyres/vehicle/${id}`, [id]);
  const [pos, setPos] = useState(null);
  const [form, setForm] = useState(null);
  const act = useAction(() => { d.load(); onChanged(); setForm(null); });
  const canEdit = can("mnt.tyres", "edit");

  if (!d.data) return <div style={{ flex: "999 1 520px" }}><Loading error={d.error} /></div>;
  const v = d.data;
  const at = (p) => v.tyres.find((t) => t.position === p);
  const t = pos ? at(pos) : null;
  const post = (path, body, msg) => act.run(() => apiRequest(`/maintenance-module/${path}`, { method: "POST", body }), msg);
  const cardSel = (
    <Field label="Job card (optional)">
      <select value={form?.job_card_id || ""} onChange={(e) => setForm({ ...form, job_card_id: e.target.value })}>
        <option value="">—</option>{v.open_cards.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
      </select>
    </Field>
  );

  return (
    <main style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
      <Msg msg={act.msg} err={act.err} />
      {v.layout.length > 0 && (
        <section className="card">
          <div style={ROW}>
            <h2 style={{ ...H2, flex: 1 }}>{v.asset.name} · tyres</h2>
            <span style={MUTED}>{v.asset.km != null ? `${fmtNum(v.asset.km)} km` : "no km reading"}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 260px", background: "var(--concrete)", borderRadius: 10, padding: 12 }}>
              {layoutRows(v.layout).map((row) => (
                <div key={row.label} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--slate)", marginBottom: 4 }}>{row.label}</div>
                  <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                    {row.items.map((p) => {
                      const ty = at(p);
                      const on = pos === p;
                      return (
                        <button key={p} type="button" onClick={() => { setPos(p); setForm(null); }} aria-pressed={on} aria-label={`${p}${ty ? ` — ${ty.serial}` : " — empty"}`}
                          style={{ width: 52, height: 64, borderRadius: 10, padding: 2, fontSize: 10.5, lineHeight: 1.2,
                            border: ty ? `3px solid ${tone(ty.last_tread_mm)}` : "2px dashed #B9B2A6",
                            background: on ? "#FBF3EC" : ty ? "#2B2F33" : "#fff", color: ty && !on ? "#fff" : "var(--charcoal)",
                            outline: on ? "2px solid var(--rebar)" : "none" }}>
                          <b style={{ display: "block" }}>{p}</b>
                          {ty ? <span>{ty.last_tread_mm != null ? `${ty.last_tread_mm} mm` : "—"}</span> : <span>empty</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div style={{ ...ROW, justifyContent: "center", fontSize: 11, color: "var(--slate)" }}>
                <span style={{ color: "var(--signal-green)" }}>■</span> ≥ 6 mm <span style={{ color: "var(--amber)" }}>■</span> 4–6 mm <span style={{ color: "var(--alert-red)" }}>■</span> &lt; 4 mm
              </div>
            </div>

            <div style={{ flex: "1 1 280px", minWidth: 0 }}>
              {!pos && <div style={MUTED}>Tap a position to see the tyre fitted there, or to fit one.</div>}
              {pos && t && (
                <>
                  <div style={{ ...MUTED, textTransform: "uppercase", fontSize: 11 }}>Position {pos}</div>
                  <h3 style={{ margin: "2px 0 6px", fontSize: 16 }}>{t.serial}</h3>
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                    {[t.brand, t.size, t.pattern].filter(Boolean).join(" · ")} · {t.kind === "retread" ? `Retread ×${t.retread_count}` : "New"}<br />
                    Fitted {fmtDate(t.fitted_at)}{t.fitted_km != null ? ` at ${fmtNum(t.fitted_km)} km` : ""}<br />
                    Run here {fmtNum(t.run_here)} km · life {fmtNum(t.total_km)} km<br />
                    Tread {t.last_tread_mm != null ? `${t.last_tread_mm} mm (${fmtDate(t.last_tread_at)})` : "not recorded"}<br />
                    Cost {fmtRs(t.cost)}{t.retread_cost ? ` + retread ${fmtRs(t.retread_cost)}` : ""}{t.cost_per_km != null ? ` · ₹${t.cost_per_km}/km` : ""}
                  </div>
                  {canEdit && !form && (
                    <div style={{ ...ROW, marginTop: 10 }}>
                      <button type="button" style={SMALL_BTN} onClick={() => setForm({ mode: "tread", tread_mm: "" })}>Tread reading</button>
                      <button type="button" style={SMALL_BTN} onClick={() => setForm({ mode: "move", position: "", km: "" })}>Rotate / swap</button>
                      <button type="button" style={SMALL_BTN} onClick={() => setForm({ mode: "remove", to: "store", km: "", tread_mm: "", retread_vendor: "", note: "" })}>Remove…</button>
                    </div>
                  )}
                </>
              )}
              {pos && !t && (
                <>
                  <div style={{ ...MUTED, textTransform: "uppercase", fontSize: 11 }}>Position {pos}</div>
                  <h3 style={{ margin: "2px 0 6px", fontSize: 16 }}>Empty</h3>
                  {canEdit && !form && <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => setForm({ mode: "fit", tyre_id: "", km: "" })}>Fit a tyre from store</button>}
                </>
              )}
              {form && (
                <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, marginTop: 10 }}>
                  {form.mode === "tread" && (
                    <Field label="Tread depth (mm)"><input inputMode="decimal" value={form.tread_mm} onChange={(e) => setForm({ ...form, tread_mm: e.target.value })} /></Field>
                  )}
                  {form.mode === "move" && (
                    <div style={GRID(130)}>
                      <Field label="Move to">
                        <select value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}>
                          <option value="">Select…</option>
                          {v.layout.filter((p) => p !== pos).map((p) => <option key={p} value={p}>{p}{at(p) ? ` (swap with ${at(p).serial})` : ""}</option>)}
                        </select>
                      </Field>
                      <Field label="Odometer km"><input inputMode="decimal" value={form.km} placeholder={v.asset.km ?? ""} onChange={(e) => setForm({ ...form, km: e.target.value })} /></Field>
                      {cardSel}
                    </div>
                  )}
                  {form.mode === "remove" && (
                    <div style={GRID(130)}>
                      <Field label="Goes to">
                        <select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
                          <option value="store">Store (re-use)</option><option value="retread">Retreading</option><option value="scrap">Scrap</option>
                        </select>
                      </Field>
                      <Field label="Odometer km"><input inputMode="decimal" value={form.km} placeholder={v.asset.km ?? ""} onChange={(e) => setForm({ ...form, km: e.target.value })} /></Field>
                      <Field label="Tread (mm)"><input inputMode="decimal" value={form.tread_mm} onChange={(e) => setForm({ ...form, tread_mm: e.target.value })} /></Field>
                      {form.to === "retread" && <Field label="Retreader"><input value={form.retread_vendor} onChange={(e) => setForm({ ...form, retread_vendor: e.target.value })} /></Field>}
                      <Field label="Reason"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="worn, cut, puncture…" /></Field>
                      {cardSel}
                    </div>
                  )}
                  {form.mode === "fit" && (
                    <div style={GRID(150)}>
                      <Field label="Tyre in store">
                        <select value={form.tyre_id} onChange={(e) => setForm({ ...form, tyre_id: e.target.value })}>
                          <option value="">Select…</option>
                          {v.store_tyres.map((x) => <option key={x.id} value={x.id}>{x.serial} · {[x.brand, x.size].filter(Boolean).join(" ")}{x.kind === "retread" ? " · retread" : ""}{x.last_tread_mm != null ? ` · ${x.last_tread_mm} mm` : ""}</option>)}
                        </select>
                      </Field>
                      <Field label="Odometer km"><input inputMode="decimal" value={form.km} placeholder={v.asset.km ?? ""} onChange={(e) => setForm({ ...form, km: e.target.value })} /></Field>
                      {cardSel}
                    </div>
                  )}
                  {form.mode === "fit" && v.store_tyres.length === 0 && <div style={{ ...MUTED, marginTop: 6 }}>No tyres in store — add one with “+ Tyre to register”.</div>}
                  <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
                    <button type="button" onClick={() => setForm(null)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={act.busy} onClick={() => {
                      if (form.mode === "tread") post(`tyres/${t.id}/tread`, form, "Tread recorded.");
                      if (form.mode === "move") post(`tyres/${t.id}/move`, form, "Moved.");
                      if (form.mode === "remove") post(`tyres/${t.id}/remove`, form, "Removed.").then((r) => r && setPos(null));
                      if (form.mode === "fit") post(`tyres/${form.tyre_id}/fit`, { asset_id: id, position: pos, km: form.km, job_card_id: form.job_card_id }, "Fitted.");
                    }}>Save</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <VehicleBatteries v={v} canEdit={canEdit} post={post} act={act} />

      <section className="card">
        <h2 style={H2}>Tyre & battery movements</h2>
        {v.moves.length === 0 ? <div style={MUTED}>Nothing recorded yet.</div> : (
          <Table minWidth={560}>
            <thead><tr><th>When</th><th>Serial</th><th>Action</th><th>Odometer</th><th>By</th></tr></thead>
            <tbody>
              {v.moves.map((m) => (
                <tr key={m.id}>
                  <td>{fmtWhen(m.created_at)}</td>
                  <td><b>{m.serial}</b><div style={MUTED}>{m.kind}{m.brand ? ` · ${m.brand}` : ""}</div></td>
                  <td>{ACTION[m.action] || m.action}{m.from_position || m.position ? ` ${[m.from_position, m.position].filter(Boolean).join(" → ")}` : ""}
                    {m.tread_mm != null && <span style={MUTED}> · {m.tread_mm} mm</span>}{m.note && <div style={MUTED}>{m.note}</div>}</td>
                  <td>{m.km != null ? `${fmtNum(m.km)} km` : "—"}</td>
                  <td>{m.by_name}{m.job_card_id ? <div style={MUTED}>JC-{String(m.job_card_id).padStart(4, "0")}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}

function VehicleBatteries({ v, canEdit, post, act }) {
  const [f, setF] = useState(null);
  return (
    <section className="card">
      <h2 style={H2}>Batteries</h2>
      <Table minWidth={520}>
        <thead><tr><th>Slot</th><th>Serial</th><th>Make</th><th>Fitted</th><th>Warranty</th><th></th></tr></thead>
        <tbody>
          {v.battery_slots.map((slot) => {
            const b = v.batteries.find((x) => x.position === slot);
            return (
              <tr key={slot}>
                <td><b>{slot}</b></td>
                {b ? (
                  <>
                    <td>{b.serial}</td>
                    <td>{[b.make, b.spec].filter(Boolean).join(" · ")}</td>
                    <td>{fmtDate(b.fitted_at)}</td>
                    <td style={{ color: b.warranty_days != null && b.warranty_days < 0 ? "var(--slate)" : b.warranty_days != null && b.warranty_days <= 60 ? "var(--amber)" : undefined }}>
                      {b.warranty_until ? `to ${fmtDate(b.warranty_until)}` : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>{canEdit && <button type="button" style={SMALL_BTN} onClick={() => setF({ mode: "remove", id: b.id, slot, to: b.warranty_days != null && b.warranty_days >= 0 ? "claim" : "scrap", note: "", km: "", in_warranty: b.warranty_days != null && b.warranty_days >= 0 })}>Replace / remove…</button>}</td>
                  </>
                ) : (
                  <>
                    <td colSpan={4} style={{ color: "var(--slate)" }}>empty</td>
                    <td style={{ textAlign: "right" }}>{canEdit && <button type="button" style={SMALL_BTN} onClick={() => setF({ mode: "fit", slot, battery_id: "", km: "" })}>Fit battery</button>}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </Table>
      {f && (
        <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, marginTop: 10 }}>
          {f.mode === "remove" && (
            <div style={GRID(150)}>
              <Field label="The old battery">
                <select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
                  {f.in_warranty && <option value="claim">Failed in warranty — claim</option>}
                  <option value="scrap">Scrap</option><option value="store">Back to store</option>
                </select>
              </Field>
              <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="not holding charge…" /></Field>
            </div>
          )}
          {f.mode === "fit" && (
            <Field label="Battery in store">
              <select value={f.battery_id} onChange={(e) => setF({ ...f, battery_id: e.target.value })}>
                <option value="">Select…</option>
                {v.store_batteries.map((x) => <option key={x.id} value={x.id}>{x.serial} · {[x.make, x.spec].filter(Boolean).join(" ")}{x.warranty_until ? ` · warranty to ${fmtDate(x.warranty_until)}` : ""}</option>)}
              </select>
            </Field>
          )}
          {f.to === "claim" && <div style={{ ...MUTED, marginTop: 6 }}>A failed battery inside warranty opens a warranty claim instead of a purchase.</div>}
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
            <button type="button" onClick={() => setF(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={() => (f.mode === "remove"
              ? post(`batteries/${f.id}/remove`, f, f.to === "claim" ? "Removed — warranty claim opened. Fit the replacement in the empty slot." : "Removed.")
              : post(`batteries/${f.battery_id}/fit`, { asset_id: v.asset.id, position: f.slot, km: f.km }, "Battery fitted.")).then((r) => r && setF(null))}>Save</button>
          </div>
        </div>
      )}
    </section>
  );
}

function StoreTyres({ data, onChanged }) {
  const { can } = usePermissions();
  const [f, setF] = useState(null);
  const act = useAction(() => { onChanged(); setF(null); });
  const rows = data.tyres.filter((t) => t.status !== "scrapped");
  return (
    <>
      <Msg msg={act.msg} err={act.err} />
      {data.low_tread.length > 0 && (
        <section className="card" style={{ marginBottom: 16, borderColor: "#E9B4AC" }}>
          <h2 style={H2}>Fitted tyres below 4 mm</h2>
          <Table minWidth={480}>
            <thead><tr><th>Vehicle</th><th>Position</th><th>Serial</th><th>Tread</th><th>Read on</th></tr></thead>
            <tbody>{data.low_tread.map((t) => <tr key={t.id}><td>{t.asset_name}</td><td>{t.position}</td><td>{t.serial}</td><td style={{ color: "var(--alert-red)" }}><b>{t.last_tread_mm} mm</b></td><td>{fmtDate(t.last_tread_at)}</td></tr>)}</tbody>
          </Table>
        </section>
      )}
      <section className="card">
        <h2 style={H2}>Tyres in store & at the retreader</h2>
        {rows.length === 0 ? <div style={MUTED}>None.</div> : (
          <Table minWidth={680}>
            <thead><tr><th>Serial</th><th>Tyre</th><th>Where</th><th>Life</th><th>Tread</th><th style={{ textAlign: "right" }}>Cost</th><th></th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.serial}</b></td>
                  <td>{[t.brand, t.size].filter(Boolean).join(" · ")}<div style={MUTED}>{t.kind === "retread" ? `Retread ×${t.retread_count}` : "New"}</div></td>
                  <td>{t.status === "at_retread" ? <span className="badge badge-progress">At retread{t.retread_vendor ? ` · ${t.retread_vendor}` : ""}</span> : <span className="badge badge-info">In store</span>}</td>
                  <td>{fmtNum(t.total_km)} km</td>
                  <td>{t.last_tread_mm != null ? `${t.last_tread_mm} mm` : "—"}</td>
                  <td style={{ textAlign: "right" }}>{fmtRs((t.cost || 0) + t.retread_cost)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {can("mnt.tyres", "edit") && t.status === "at_retread" && <button type="button" style={SMALL_BTN} onClick={() => setF({ id: t.id, mode: "back", cost: "", tread_mm: "" })}>Back from retread…</button>}{" "}
                    {can("mnt.tyres", "edit") && <button type="button" style={SMALL_BTN} onClick={() => window.confirm(`Scrap ${t.serial}?`) && act.run(() => apiRequest(`/maintenance-module/tyres/${t.id}/scrap`, { method: "POST" }), "Scrapped.")}>Scrap</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {f && (
          <div style={{ ...ROW, alignItems: "flex-end", background: "var(--concrete)", borderRadius: 8, padding: 12, marginTop: 10 }}>
            <Field label="Retread cost ₹"><input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
            <Field label="New tread (mm)"><input inputMode="decimal" value={f.tread_mm} onChange={(e) => setF({ ...f, tread_mm: e.target.value })} /></Field>
            <button type="button" onClick={() => setF(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={() => act.run(() => apiRequest(`/maintenance-module/tyres/${f.id}/retread-back`, { method: "POST", body: f }), "Back in store as a retread.")}>Save</button>
          </div>
        )}
      </section>
    </>
  );
}

function Batteries({ data, onChanged }) {
  const { can } = usePermissions();
  const act = useAction(() => onChanged());
  const list = data.batteries;
  const today = todayIst();
  return (
    <section className="card">
      <h2 style={H2}>Batteries</h2>
      <Msg msg={act.msg} err={act.err} />
      {list.length === 0 ? <div style={MUTED}>No batteries in the register yet.</div> : (
        <Table minWidth={680}>
          <thead><tr><th>Serial</th><th>Battery</th><th>Where</th><th>Warranty</th><th style={{ textAlign: "right" }}>Cost</th><th></th></tr></thead>
          <tbody>
            {[...list].sort((a, b) => (a.status === "claim" ? -1 : 0) - (b.status === "claim" ? -1 : 0) || String(a.warranty_until || "9").localeCompare(String(b.warranty_until || "9"))).map((b) => (
              <tr key={b.id}>
                <td><b>{b.serial}</b></td>
                <td>{[b.make, b.spec].filter(Boolean).join(" · ")}</td>
                <td>{b.status === "fitted" ? `${b.asset_name} · ${b.position}` : b.status === "claim" ? <span className="badge badge-warning">Warranty claim · {fmtDate(b.claim_at)}</span> : <span className="badge badge-info">In store</span>}
                  {b.claim_note && b.status === "claim" && <div style={MUTED}>{b.claim_note}</div>}</td>
                <td style={{ color: b.warranty_until && b.warranty_until < today ? "var(--slate)" : b.warranty_days != null && b.warranty_days <= 60 ? "var(--amber)" : undefined }}>
                  {b.warranty_until ? `${fmtDate(b.warranty_until)}${b.warranty_days != null && b.warranty_days >= 0 && b.warranty_days <= 60 ? ` · ${b.warranty_days} d` : ""}` : "—"}
                </td>
                <td style={{ textAlign: "right" }}>{fmtRs(b.cost)}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {can("mnt.tyres", "edit") && b.status === "claim" && (
                    <>
                      <button type="button" style={SMALL_BTN} onClick={() => act.run(() => apiRequest(`/maintenance-module/batteries/${b.id}/claim-close`, { method: "POST", body: { result: "replaced" } }), "Claim closed — add the replacement battery to the register at no cost.")}>Replaced</button>{" "}
                      <button type="button" style={SMALL_BTN} onClick={() => act.run(() => apiRequest(`/maintenance-module/batteries/${b.id}/claim-close`, { method: "POST", body: { result: "rejected" } }), "Claim closed as rejected.")}>Rejected</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
