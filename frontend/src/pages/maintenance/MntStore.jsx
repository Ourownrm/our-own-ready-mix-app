// Round 215 — maintenance store (spares). Every item says what it is used for
// (the owner, 17 Oct): one or more specific machines, a machine type (all
// transit mixers), or general. Stock moves only by GRV (in), issue to a job
// card (out), or an adjustment (opening stock / physical count). The last
// purchase price is kept per item.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, fmtRs, fmtNum, fmtDate, fmtWhen, H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN } from "./mntUi.jsx";

const qty = (v) => fmtNum(v, 2).replace(/\.00$/, "");
const TXN = { receive: ["In (GRV)", "badge-success"], issue: ["Issued", "badge-info"], adjust: ["Adjusted", "badge-neutral"] };
const BLANK = { name: "", part_no: "", category: "Vehicle spares", unit: "Nos", used_for_type: "general", used_for_group: "", asset_ids: [], reorder_level: "" };

export default function MntStore() {
  const { can } = usePermissions();
  const list = useLoad("/maintenance-module/store/items");
  const assets = useLoad("/maintenance-module/asset-options");
  const [q, setQ] = useState("");
  const [usedFor, setUsedFor] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [form, setForm] = useState(null);
  const [sel, setSel] = useState(null);
  const act = useAction(() => list.load());

  if (!list.data) return <Loading error={list.error} />;
  const { items, categories, groups } = list.data;
  const shown = items.filter((i) =>
    (!q || `${i.name} ${i.part_no || ""} ${i.used_for_label}`.toLowerCase().includes(q.toLowerCase())) &&
    (!usedFor || (usedFor === "general" ? i.used_for_type === "general" : usedFor.startsWith("g:") ? i.used_for_type === "group" && i.used_for_group === usedFor.slice(2) : i.used_for_type === "asset" && i.assets.some((a) => `a:${a.id}` === usedFor))) &&
    (!lowOnly || (i.reorder_level != null && i.current_qty <= i.reorder_level)));
  const value = items.reduce((s, i) => s + Math.max(0, i.current_qty) * i.avg_rate, 0);

  function save() {
    const body = { ...form };
    const req = form.id ? apiRequest(`/maintenance-module/store/items/${form.id}`, { method: "PATCH", body }) : apiRequest("/maintenance-module/store/items", { method: "POST", body });
    act.run(() => req, form.id ? "Item saved." : "Item added.").then((r) => r && setForm(null));
  }

  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}>
        <div className="field-input" style={{ flex: "1 1 220px" }}><input aria-label="Search spares" placeholder="Search name, part no…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="field-input">
          <select aria-label="Used for" value={usedFor} onChange={(e) => setUsedFor(e.target.value)}>
            <option value="">Used for: any</option>
            <option value="general">General</option>
            <optgroup label="Machine type">{groups.map((g) => <option key={g} value={`g:${g}`}>All {g.toLowerCase()}s</option>)}</optgroup>
            <optgroup label="Specific machine">{(assets.data || []).map((a) => <option key={a.id} value={`a:${a.id}`}>{a.name}</option>)}</optgroup>
          </select>
        </div>
        <label style={{ display: "flex", gap: 6, fontSize: 13 }}><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Below re-order</label>
        <div style={{ flex: 1 }} />
        <span style={MUTED}>{items.length} items · stock value {fmtRs(value)}</span>
        {can("mnt.store", "create") && <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => { setForm({ ...BLANK }); setSel(null); }}>+ New item</button>}
      </div>
      <Msg msg={act.msg} err={act.err} />

      {form && (
        <section className="card" style={{ marginBottom: 16, borderColor: "#E7C3A6" }}>
          <h2 style={H2}>{form.id ? "Edit item" : "New store item"}</h2>
          <div style={GRID(180)}>
            <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Part no."><input value={form.part_no || ""} onChange={(e) => setForm({ ...form, part_no: e.target.value })} /></Field>
            <Field label="Category"><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{categories.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Unit"><input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></Field>
            <Field label="Re-order level"><input inputMode="decimal" value={form.reorder_level ?? ""} onChange={(e) => setForm({ ...form, reorder_level: e.target.value })} /></Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <span style={{ ...MUTED, display: "block", marginBottom: 6 }}>Used for</span>
            <div style={ROW}>
              {[["asset", "Specific machine(s)"], ["group", "A machine type"], ["general", "General"]].map(([k, l]) => (
                <label key={k} style={{ display: "flex", gap: 6, fontSize: 13 }}>
                  <input type="radio" name="used_for" checked={form.used_for_type === k} onChange={() => setForm({ ...form, used_for_type: k })} /> {l}
                </label>
              ))}
            </div>
            {form.used_for_type === "group" && (
              <Field label="Machine type" style={{ maxWidth: 280, marginTop: 8 }}>
                <select value={form.used_for_group || ""} onChange={(e) => setForm({ ...form, used_for_group: e.target.value })}>
                  <option value="">Select…</option>{groups.map((g) => <option key={g}>{g}</option>)}
                </select>
              </Field>
            )}
            {form.used_for_type === "asset" && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {(assets.data || []).map((a) => {
                  const on = form.asset_ids.includes(a.id);
                  return (
                    <button key={a.id} type="button" aria-pressed={on} onClick={() => setForm({ ...form, asset_ids: on ? form.asset_ids.filter((x) => x !== a.id) : [...form.asset_ids, a.id] })}
                      style={{ padding: "5px 11px", fontSize: 12.5, borderRadius: 16, background: on ? "var(--charcoal)" : "#fff", color: on ? "#fff" : "var(--charcoal)" }}>{a.name}</button>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={save}>Save</button>
          </div>
        </section>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "999 1 600px", minWidth: 0 }}>
          {shown.length === 0 ? <div style={MUTED}>{items.length ? "Nothing matches." : "No spares yet — add items, then enter opening stock with Adjust."}</div> : (
            <Table minWidth={760}>
              <thead><tr><th>Item</th><th>Used for</th><th style={{ textAlign: "right" }}>In stock</th><th style={{ textAlign: "right" }}>Avg rate</th><th style={{ textAlign: "right" }}>Last price</th><th>Last bought</th></tr></thead>
              <tbody>
                {shown.map((i) => {
                  const low = i.reorder_level != null && i.current_qty <= i.reorder_level;
                  return (
                    <tr key={i.id} onClick={() => setSel(i.id)} style={{ cursor: "pointer", background: sel === i.id ? "var(--concrete)" : undefined }}>
                      <td><b>{i.name}</b><div style={MUTED}>{i.part_no || i.category}</div></td>
                      <td>{i.used_for_label}</td>
                      <td style={{ textAlign: "right" }}>
                        <b style={{ color: low ? "var(--alert-red)" : undefined }}>{qty(i.current_qty)}</b> {i.unit}
                        {i.reorder_level != null && <div style={MUTED}>re-order at {qty(i.reorder_level)}</div>}
                      </td>
                      <td style={{ textAlign: "right" }}>{fmtRs(i.avg_rate, 2)}</td>
                      <td style={{ textAlign: "right" }}>
                        {fmtRs(i.last_price, 2)}
                        {i.prev_price != null && i.last_price != null && i.prev_price !== i.last_price && (
                          <div style={{ ...MUTED, color: i.last_price > i.prev_price ? "var(--alert-red)" : "var(--signal-green)" }}>
                            {i.last_price > i.prev_price ? "▲" : "▼"} from {fmtRs(i.prev_price, 2)}
                          </div>
                        )}
                      </td>
                      <td>{i.last_purchase_date ? fmtDate(i.last_purchase_date) : "—"}<div style={MUTED}>{i.last_supplier || ""}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>
        {sel && items.find((i) => i.id === sel) && (
          <ItemPanel key={sel} item={items.find((i) => i.id === sel)} onEdit={(it) => setForm({ ...it, asset_ids: it.assets.map((a) => a.id), reorder_level: it.reorder_level ?? "" })}
            onClose={() => setSel(null)} onChanged={() => list.load()} />
        )}
      </div>
    </>
  );
}

function ItemPanel({ item, onEdit, onClose, onChanged }) {
  const { can } = usePermissions();
  const d = useLoad(`/maintenance-module/store/items/${item.id}`, [item.id, item.current_qty]);
  const [adj, setAdj] = useState(null);
  const act = useAction(() => { d.load(); onChanged(); setAdj(null); });

  return (
    <section className="card" style={{ flex: "1 1 340px", minWidth: 0 }}>
      <div style={ROW}>
        <h2 style={{ ...H2, flex: 1 }}>{item.name}</h2>
        <button type="button" style={SMALL_BTN} onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div style={MUTED}>{item.used_for_label} · {qty(item.current_qty)} {item.unit} in stock</div>
      <div style={{ ...ROW, margin: "10px 0" }}>
        {can("mnt.store", "edit") && <button type="button" style={SMALL_BTN} onClick={() => onEdit(item)}>Edit</button>}
        {can("mnt.store-adjust", "edit") && <button type="button" style={SMALL_BTN} onClick={() => setAdj({ counted_qty: String(item.current_qty), rate: "", note: "" })}>Adjust stock</button>}
      </div>
      <Msg msg={act.msg} err={act.err} />
      {adj && (
        <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={GRID(130)}>
            <Field label="Counted qty"><input inputMode="decimal" value={adj.counted_qty} onChange={(e) => setAdj({ ...adj, counted_qty: e.target.value })} /></Field>
            <Field label="Rate ₹ (opening)"><input inputMode="decimal" value={adj.rate} onChange={(e) => setAdj({ ...adj, rate: e.target.value })} /></Field>
          </div>
          <Field label="Why" style={{ marginTop: 8 }}><input placeholder="Opening stock / physical count…" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></Field>
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
            <button type="button" onClick={() => setAdj(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={() => act.run(() => apiRequest(`/maintenance-module/store/items/${item.id}/adjust`, { method: "POST", body: adj }), "Stock adjusted.")}>Save</button>
          </div>
        </div>
      )}
      {!d.data ? <Loading error={d.error} /> : (
        <>
          <h3 style={{ fontSize: 13, margin: "8px 0 4px" }}>Purchase price history</h3>
          {d.data.prices.length === 0 ? <div style={MUTED}>Not bought yet.</div> : (
            <Table minWidth={300}>
              <tbody>
                {d.data.prices.map((p) => (
                  <tr key={p.grv_id}><td>{fmtDate(p.grv_date)}<div style={MUTED}>{p.supplier_name} · {p.po_code}</div></td><td style={{ textAlign: "right" }}>{fmtRs(p.rate, 2)}<div style={MUTED}>incl. GST</div></td></tr>
                ))}
              </tbody>
            </Table>
          )}
          <h3 style={{ fontSize: 13, margin: "14px 0 4px" }}>Ledger</h3>
          {d.data.ledger.length === 0 ? <div style={MUTED}>No movements.</div> : (
            <Table minWidth={320}>
              <tbody>
                {d.data.ledger.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className={`badge ${TXN[t.txn_type][1]}`}>{TXN[t.txn_type][0]}</span>
                      <div style={MUTED}>{fmtWhen(t.created_at)} · {t.job_card_code ? `${t.job_card_code} ${t.asset_name || ""}` : t.note || ""}</div>
                    </td>
                    <td style={{ textAlign: "right" }}>{Number(t.qty_change) > 0 ? "+" : ""}{qty(t.qty_change)}<div style={MUTED}>bal {qty(t.balance_after)}</div></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}
