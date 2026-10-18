// Round 215 — Parts, PO & GRV. Store's working screen:
//   1. Part requests from job cards: issue from stock (cost to the card), or
//      put on a purchase order when it isn't in stock.
//   2. Purchase orders: Manager / Administrator approves.
//   3. GRV against an approved PO (the owner asked for this to be easy to
//      find): stock in at the bought rate, last price updated, and lines
//      bought for a job card go straight on to it.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, Badge, PART_STATUS, PO_STATUS, fmtRs, fmtNum, fmtDate, fmtWhen, todayIst, H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN } from "./mntUi.jsx";

const qty = (v) => fmtNum(v, 2).replace(/\.00$/, "");
const lineAmt = (l) => (Number(l.qty) || 0) * (Number(l.rate) || 0) * (1 + (Number(l.gst_pct) || 0) / 100);

export default function MntPurchase({ go, params }) {
  const { can } = usePermissions();
  const poId = Number(params.get("po")) || null;
  const reqs = useLoad("/maintenance-module/part-requests");
  const pos = useLoad(can("mnt.purchase-orders", "view") ? "/maintenance-module/purchase-orders" : null);
  const items = useLoad("/maintenance-module/store/items");
  const [newPo, setNewPo] = useState(null);
  const reload = () => { reqs.load(); pos.load(); items.load(); };

  if (poId) return <PoDetail id={poId} go={go} onChanged={reload} wantGrv={!!params.get("grv")} />;
  if (!reqs.data || !items.data) return <Loading error={reqs.error || items.error} />;

  const startPo = (fromReqs = []) => setNewPo({
    supplier_name: "", credit_days: "30", notes: "",
    lines: fromReqs.length
      ? fromReqs.map((r) => ({ part_request_id: r.id, label: `${r.job_card_code} · ${r.asset_name}`, item_id: r.item_id || "", description: r.description, qty: String(r.qty), rate: r.last_price != null ? String(r.last_price) : "", gst_pct: "18" }))
      : [{ item_id: "", qty: "", rate: "", gst_pct: "18" }],
  });

  return (
    <>
      <PartRequests reqs={reqs} items={items.data.items} onPo={startPo} onChanged={reload} go={go} />
      {newPo && <NewPo po={newPo} setPo={setNewPo} items={items.data.items} onDone={(r) => { setNewPo(null); reload(); go("purchase", { po: r.id }); }} />}
      {can("mnt.purchase-orders", "view") && (
        <section className="card">
          <div style={ROW}>
            <h2 style={{ ...H2, flex: 1 }}>Purchase orders</h2>
            {can("mnt.purchase-orders", "create") && !newPo && <button type="button" style={SMALL_BTN} onClick={() => startPo()}>+ PO for stock</button>}
          </div>
          {!pos.data ? <div style={MUTED}>Loading…</div> : pos.data.length === 0 ? <div style={MUTED}>No purchase orders yet.</div> : (
            <Table minWidth={720}>
              <thead><tr><th>PO</th><th>Supplier</th><th>For</th><th style={{ textAlign: "right" }}>Total</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {pos.data.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.code}</b><div style={MUTED}>{fmtDate(p.created_at)}</div></td>
                    <td>{p.supplier_name}<div style={MUTED}>{p.credit_days} days credit</div></td>
                    <td>{p.for_cards || "Stock"}{p.grvs && <div style={MUTED}>{p.grvs}</div>}</td>
                    <td style={{ textAlign: "right" }}>{fmtRs(p.total)}</td>
                    <td><Badge map={PO_STATUS} value={p.status} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {p.status === "approved" && can("mnt.grv", "create")
                        ? <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => go("purchase", { po: p.id, grv: 1 })}>Make GRV</button>
                        : <button type="button" style={SMALL_BTN} onClick={() => go("purchase", { po: p.id })}>{p.status === "pending" && can("mnt.po-approve", "edit") ? "Review" : "Open"}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
    </>
  );
}

function PartRequests({ reqs, items, onPo, onChanged, go }) {
  const { can } = usePermissions();
  const [issue, setIssue] = useState(null);
  const [picked, setPicked] = useState([]);
  const act = useAction(() => { setIssue(null); onChanged(); });
  const open = reqs.data.filter((r) => r.status === "requested");
  const onPoList = reqs.data.filter((r) => r.status === "on_po");
  const canIssue = can("mnt.parts-issue", "edit");
  const canPo = can("mnt.purchase-orders", "create");

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div style={ROW}>
        <h2 style={{ ...H2, flex: 1 }}>Part requests from job cards</h2>
        {canPo && picked.length > 0 && <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => { onPo(open.filter((r) => picked.includes(r.id))); setPicked([]); }}>Put {picked.length} on a PO</button>}
      </div>
      <p style={{ ...MUTED, marginTop: 0 }}>In stock → Issue (the cost goes to the job card). Not in stock → tick it and put it on a PO.</p>
      <Msg msg={act.msg} err={act.err} />
      {open.length === 0 && onPoList.length === 0 ? <div style={MUTED}>No part requests waiting.</div> : (
        <Table minWidth={760}>
          <thead><tr>{canPo && <th aria-label="Pick" />}<th>Part</th><th>Job card</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>In stock</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {[...open, ...onPoList].map((r) => {
              const enough = r.item_id && r.current_qty != null && r.current_qty >= Number(r.qty);
              const isOpen = issue && issue.id === r.id;
              return [
                <tr key={r.id}>
                  {canPo && <td>{r.status === "requested" && <input type="checkbox" aria-label={`Pick ${r.description}`} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />}</td>}
                  <td>
                    <b>{r.item_name || r.description}</b>
                    {!r.item_id && <div style={MUTED}>not linked to a store item</div>}
                    {r.other_machine && <div style={{ ...MUTED, color: "var(--amber)" }}>Note: this item is meant for another machine</div>}
                  </td>
                  <td>
                    <button type="button" onClick={() => go("job-cards", { card: r.job_card_id })} style={{ background: "none", border: "none", padding: 0, fontWeight: 600, color: "var(--charcoal)", textDecoration: "underline" }}>{r.job_card_code}</button>
                    <div style={MUTED}>{r.asset_name} · {r.requested_by_name} {fmtWhen(r.requested_at)}</div>
                  </td>
                  <td style={{ textAlign: "right" }}>{qty(r.qty)} {r.unit || ""}</td>
                  <td style={{ textAlign: "right", color: r.item_id && !enough ? "var(--alert-red)" : undefined }}>{r.current_qty != null ? qty(r.current_qty) : "—"}</td>
                  <td><Badge map={PART_STATUS} value={r.status} />{r.po_code && <div style={MUTED}>{r.po_code}</div>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {r.status === "requested" && canIssue && <button type="button" className={enough ? "btn-primary" : undefined} style={SMALL_BTN} onClick={() => setIssue({ id: r.id, item_id: r.item_id || "", qty: String(r.qty) })}>Issue…</button>}{" "}
                    {r.status === "requested" && canIssue && <button type="button" style={SMALL_BTN} disabled={act.busy} onClick={() => act.run(() => apiRequest(`/maintenance-module/part-requests/${r.id}/cancel`, { method: "POST" }), "Request cancelled.")}>Cancel</button>}
                  </td>
                </tr>,
                isOpen && (
                  <tr key={`${r.id}-issue`}>
                    <td colSpan={canPo ? 7 : 6} style={{ background: "var(--concrete)" }}>
                      <div style={{ ...ROW, alignItems: "flex-end" }}>
                        <Field label="Issue item" style={{ flex: 1, minWidth: 240 }}>
                          <select value={issue.item_id} onChange={(e) => setIssue({ ...issue, item_id: e.target.value })}>
                            <option value="">Select…</option>
                            {items.map((i) => <option key={i.id} value={i.id}>{i.name} · {qty(i.current_qty)} {i.unit} · {i.used_for_label}</option>)}
                          </select>
                        </Field>
                        <Field label="Qty" style={{ width: 110 }}><input inputMode="decimal" value={issue.qty} onChange={(e) => setIssue({ ...issue, qty: e.target.value })} /></Field>
                        <button type="button" onClick={() => setIssue(null)}>Back</button>
                        <button type="button" className="btn-primary" disabled={act.busy}
                          onClick={() => act.run(() => apiRequest(`/maintenance-module/part-requests/${r.id}/issue`, { method: "POST", body: issue }), (o) => `Issued — ${fmtRs(o?.value, 2)} added to ${r.job_card_code}.`)}>Issue to job card</button>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function NewPo({ po, setPo, items, onDone }) {
  const act = useAction();
  const setLine = (i, v) => setPo({ ...po, lines: po.lines.map((l, j) => (j === i ? { ...l, ...v } : l)) });
  const total = po.lines.reduce((s, l) => s + lineAmt(l), 0);
  return (
    <section className="card" style={{ marginBottom: 16, borderColor: "#E7C3A6" }}>
      <h2 style={H2}>New purchase order</h2>
      <div style={GRID(180)}>
        <Field label="Supplier"><input value={po.supplier_name} onChange={(e) => setPo({ ...po, supplier_name: e.target.value })} /></Field>
        <Field label="Credit days"><input inputMode="numeric" value={po.credit_days} onChange={(e) => setPo({ ...po, credit_days: e.target.value })} /></Field>
        <Field label="Note"><input value={po.notes} onChange={(e) => setPo({ ...po, notes: e.target.value })} /></Field>
      </div>
      <Table minWidth={720}>
        <thead><tr><th>Item</th><th style={{ width: 90 }}>Qty</th><th style={{ width: 120 }}>Rate ₹ (excl. GST)</th><th style={{ width: 80 }}>GST %</th><th style={{ textAlign: "right" }}>Amount</th><th /></tr></thead>
        <tbody>
          {po.lines.map((l, i) => {
            const it = items.find((x) => String(x.id) === String(l.item_id));
            return (
              <tr key={i}>
                <td>
                  {l.label && <div style={MUTED}>{l.label} · asked: {l.description}</div>}
                  <div className="field-input">
                    <select aria-label="Item" value={l.item_id} onChange={(e) => { const x = items.find((y) => String(y.id) === e.target.value); setLine(i, { item_id: e.target.value, rate: l.rate || (x?.last_price != null ? String(x.last_price) : "") }); }}>
                      <option value="">Select store item…</option>
                      {items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.part_no ? ` (${x.part_no})` : ""}</option>)}
                    </select>
                  </div>
                  {it?.last_price != null && <div style={MUTED}>Last bought {fmtRs(it.last_price, 2)}{it.last_supplier ? ` from ${it.last_supplier}` : ""}{it.last_purchase_date ? ` on ${fmtDate(it.last_purchase_date)}` : ""}</div>}
                </td>
                <td><div className="field-input"><input aria-label="Qty" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></div></td>
                <td><div className="field-input"><input aria-label="Rate" inputMode="decimal" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} /></div></td>
                <td><div className="field-input"><input aria-label="GST %" inputMode="decimal" value={l.gst_pct} onChange={(e) => setLine(i, { gst_pct: e.target.value })} /></div></td>
                <td style={{ textAlign: "right" }}>{fmtRs(lineAmt(l), 2)}</td>
                <td>{po.lines.length > 1 && <button type="button" style={SMALL_BTN} aria-label="Remove line" onClick={() => setPo({ ...po, lines: po.lines.filter((_, j) => j !== i) })}>✕</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <div style={{ ...MUTED, marginTop: 4 }}>If an item isn’t listed, add it on the Store tab first.</div>
      <Msg msg={act.msg} err={act.err} />
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" style={SMALL_BTN} onClick={() => setPo({ ...po, lines: [...po.lines, { item_id: "", qty: "", rate: "", gst_pct: "18" }] })}>+ Line</button>
        <div style={{ flex: 1 }} />
        <b>Total {fmtRs(total, 2)}</b>
        <button type="button" onClick={() => setPo(null)}>Cancel</button>
        <button type="button" className="btn-primary" disabled={act.busy}
          onClick={() => act.run(() => apiRequest("/maintenance-module/purchase-orders", { method: "POST", body: po })).then((r) => r && onDone(r))}>Send for approval</button>
      </div>
    </section>
  );
}

function PoDetail({ id, go, onChanged, wantGrv }) {
  const { can } = usePermissions();
  const d = useLoad(`/maintenance-module/purchase-orders/${id}`, [id]);
  const [reject, setReject] = useState(null);
  const [grv, setGrv] = useState(null);
  const act = useAction(() => { d.load(); onChanged(); });

  if (!d.data) return <Loading error={d.error} />;
  const p = d.data;
  const canGrv = p.status === "approved" && can("mnt.grv", "create");
  if (canGrv && !grv && wantGrv) {
    setGrv({ grv_date: todayIst(), bill_no: "", bill_date: todayIst(), bill_amount: "", lines: Object.fromEntries(p.lines.map((l) => [l.id, String(Number(l.qty) - Number(l.received_qty))])) });
  }
  const post = (path, body, msg) => act.run(() => apiRequest(`/maintenance-module/purchase-orders/${id}/${path}`, { method: "POST", body }), msg);
  const grvValue = grv ? p.lines.reduce((s, l) => s + (Number(grv.lines[l.id]) || 0) * Number(l.rate) * (1 + Number(l.gst_pct) / 100), 0) : 0;

  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}><button type="button" style={SMALL_BTN} onClick={() => go("purchase")}>&larr; Parts, PO &amp; GRV</button></div>
      <section className="card" style={{ marginBottom: 16 }}>
        <div style={{ ...ROW, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ ...MUTED, textTransform: "uppercase", fontSize: 11.5 }}>Purchase order · {p.code}</div>
            <h1 style={{ fontSize: 20, margin: "2px 0 4px" }}>{p.supplier_name}</h1>
            <div style={MUTED}>Raised by {p.created_by_name} {fmtWhen(p.created_at)} · {p.credit_days} days credit{p.approved_by_name ? ` · ${p.status === "rejected" ? "rejected" : "approved"} by ${p.approved_by_name}` : ""}</div>
            {p.notes && <div style={MUTED}>Note: {p.notes}</div>}
            {p.reject_reason && <div style={{ ...MUTED, color: "var(--alert-red)" }}>Rejected: {p.reject_reason}</div>}
          </div>
          <Badge map={PO_STATUS} value={p.status} />
          <div style={{ textAlign: "right" }}><div className="kpi-label">Total incl. GST</div><b style={{ fontSize: 19 }}>{fmtRs(p.total, 2)}</b></div>
        </div>
        <Table minWidth={680}>
          <thead><tr><th>Item</th><th>For</th><th style={{ textAlign: "right" }}>Ordered</th><th style={{ textAlign: "right" }}>Received</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.item_name}{l.last_price != null && <div style={MUTED}>last price {fmtRs(l.last_price, 2)}</div>}</td>
                <td>{l.job_card_code ? `${l.job_card_code} · ${l.asset_name}` : "Stock"}</td>
                <td style={{ textAlign: "right" }}>{qty(l.qty)} {l.unit}</td>
                <td style={{ textAlign: "right" }}>{qty(l.received_qty)}</td>
                <td style={{ textAlign: "right" }}>{fmtRs(l.rate, 2)}<div style={MUTED}>+{qty(l.gst_pct)}% GST</div></td>
                <td style={{ textAlign: "right" }}>{fmtRs(l.amount, 2)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Msg msg={act.msg} err={act.err} />
        <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
          {p.status === "pending" && can("mnt.po-approve", "edit") && !reject && (
            <>
              <button type="button" className="btn-danger" onClick={() => setReject({ reason: "" })}>Reject</button>
              <button type="button" className="btn-primary" disabled={act.busy} onClick={() => post("approve", {}, "PO approved — Store can now make the GRV when the goods come.")}>Approve PO</button>
            </>
          )}
          {p.status === "pending" && !can("mnt.po-approve", "edit") && <span style={MUTED}>Waiting for the Manager / Administrator.</span>}
          {["pending", "approved"].includes(p.status) && !p.grvs.length && can("mnt.purchase-orders", "edit") && (
            <button type="button" disabled={act.busy} onClick={() => window.confirm("Cancel this PO? Its part requests go back to Store.") && post("cancel", {}, "PO cancelled.")}>Cancel PO</button>
          )}
          {canGrv && !grv && (
            <button type="button" className="btn-primary" onClick={() => setGrv({ grv_date: todayIst(), bill_no: "", bill_date: todayIst(), bill_amount: "", lines: Object.fromEntries(p.lines.map((l) => [l.id, String(Number(l.qty) - Number(l.received_qty))])) })}>Make GRV</button>
          )}
        </div>
        {reject && (
          <div style={{ ...ROW, alignItems: "flex-end", marginTop: 10 }}>
            <Field label="Reason" style={{ flex: 1, minWidth: 220 }}><input value={reject.reason} onChange={(e) => setReject({ reason: e.target.value })} /></Field>
            <button type="button" onClick={() => setReject(null)}>Back</button>
            <button type="button" className="btn-danger" disabled={act.busy} onClick={() => post("reject", reject, "PO rejected.").then((r) => r && setReject(null))}>Reject PO</button>
          </div>
        )}
      </section>

      {grv && (
        <section className="card" style={{ marginBottom: 16, borderColor: "var(--signal-green)" }}>
          <h2 style={H2}>GRV — goods received against {p.code}</h2>
          <p style={{ ...MUTED, marginTop: 0 }}>Received items go into stock at the PO rate. Lines bought for a job card are issued straight to it, so the cost lands on that vehicle. The bill goes to Payments, due in {p.credit_days} days.</p>
          <Table minWidth={520}>
            <thead><tr><th>Item</th><th>For</th><th style={{ textAlign: "right" }}>Left to receive</th><th style={{ width: 120 }}>Received now</th></tr></thead>
            <tbody>
              {p.lines.map((l) => {
                const left = Number(l.qty) - Number(l.received_qty);
                return (
                  <tr key={l.id}>
                    <td>{l.item_name}</td>
                    <td>{l.job_card_code || "Stock"}</td>
                    <td style={{ textAlign: "right" }}>{qty(left)} {l.unit}</td>
                    <td>{left > 0 ? <div className="field-input"><input aria-label={`Received ${l.item_name}`} inputMode="decimal" value={grv.lines[l.id] ?? ""} onChange={(e) => setGrv({ ...grv, lines: { ...grv.lines, [l.id]: e.target.value } })} /></div> : <span style={MUTED}>all in</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div style={{ ...GRID(160), marginTop: 12 }}>
            <Field label="GRV date"><input type="date" value={grv.grv_date} onChange={(e) => setGrv({ ...grv, grv_date: e.target.value })} /></Field>
            <Field label="Supplier bill no."><input value={grv.bill_no} onChange={(e) => setGrv({ ...grv, bill_no: e.target.value })} /></Field>
            <Field label="Bill date"><input type="date" value={grv.bill_date} onChange={(e) => setGrv({ ...grv, bill_date: e.target.value })} /></Field>
            <Field label="Bill amount ₹"><input inputMode="decimal" placeholder={grvValue.toFixed(2)} value={grv.bill_amount} onChange={(e) => setGrv({ ...grv, bill_amount: e.target.value })} /></Field>
          </div>
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
            <span style={{ ...MUTED, flex: 1 }}>Value at PO rates {fmtRs(grvValue, 2)}{grv.bill_amount && Math.abs(Number(grv.bill_amount) - grvValue) > 1 ? ` · bill differs by ${fmtRs(Number(grv.bill_amount) - grvValue, 2)}` : ""}</span>
            <button type="button" onClick={() => { setGrv(null); go("purchase", { po: id }); }}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy}
              onClick={() => act.run(() => apiRequest(`/maintenance-module/purchase-orders/${id}/grv`, {
                method: "POST",
                body: { ...grv, lines: Object.entries(grv.lines).map(([k, v]) => ({ po_line_id: Number(k), qty: v })) },
              }), (o) => `${o.code} saved — ${fmtRs(o.value, 2)} into stock.`).then((r) => { if (r) { setGrv(null); go("purchase", { po: id }); } })}>Save GRV</button>
          </div>
        </section>
      )}

      {p.grvs.length > 0 && (
        <section className="card">
          <h2 style={H2}>GRVs</h2>
          {p.grvs.map((g) => (
            <div key={g.id} style={{ ...ROW, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
              <b>{g.code}</b><span>{fmtDate(g.grv_date)}</span><span style={MUTED}>bill {g.bill_no || "—"} · {g.created_by_name}</span>
              <div style={{ flex: 1 }} />{g.bill_amount != null && <span>{fmtRs(g.bill_amount, 2)}</span>}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
