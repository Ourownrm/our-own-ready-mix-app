// Round 254 — Production → Orders (was "Correct Order"). The order list by
// day (carried forward, today, tomorrow, upcoming, past) with New order, and
// an order opened in place to correct it: quantity, grade and the
// quotation's mix design, times, pump, QC engineer; reschedule; cancel.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { formatOrderNumber } from "../../lib/orderNumber.js";
import { Modal } from "../accounts/ui.jsx";
import CreateOrder from "../CreateOrder.jsx";

const VIEWS = [
  { key: "carried", label: "Carried forward" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
];
export const ORDER_STATUS = {
  planned: ["Planned", "badge-neutral"], in_progress: ["In progress", "badge-info"], completed: ["Completed", "badge-success"],
  partially_completed: ["Part completed", "badge-warning"], cancelled: ["Cancelled", "badge-danger"], closed: ["Closed", "badge-neutral"],
};
export const PUMP_LABEL = { without_pump: "Without pump", boom_pump: "Boom pump", line_pump: "Line pump" };
const t5 = (t) => (t ? String(t).slice(0, 5) : "");
const sub = { fontSize: 12, color: "var(--slate)" };
const TH = { padding: "9px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--slate)", whiteSpace: "nowrap" };
const TD = { padding: "10px", fontSize: 13, verticalAlign: "top", borderTop: "1px solid var(--border)" };

export function OrderStatus({ o }) {
  if (o.to_confirm) return <span className="badge badge-warning">To confirm</span>;
  const [label, cls] = ORDER_STATUS[o.status] || [o.status, "badge-neutral"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function chargeLines(o) {
  const out = [];
  if (o.pump_requirement !== "without_pump") {
    out.push(o.pump_charge_applicable === false
      ? <div key="p" style={{ ...sub, color: "var(--amber)" }}>Pump: waived{o.pump_charge_waiver_reason ? ` — “${o.pump_charge_waiver_reason}”` : ""}</div>
      : <div key="p" style={sub}>Pump: {o.pump_charge_applicable ? "charged" : "not applicable"}</div>);
  }
  out.push(o.part_load_applicable === false
    ? <div key="l" style={{ ...sub, color: "var(--amber)" }}>Part load: waived{o.part_load_waiver_reason ? ` — “${o.part_load_waiver_reason}”` : ""}</div>
    : <div key="l" style={sub}>Part load: {o.part_load_applicable ? "charged" : "—"}</div>);
  return out;
}

export default function OrdersTab({ go, params }) {
  const { can } = usePermissions();
  const canEdit = can("production.correct-order", "edit");
  const [view, setView] = useState(params.get("view") || "today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [grade, setGrade] = useState("");
  const [openId, setOpenId] = useState(null);
  const [newOpen, setNewOpen] = useState(params.get("new") === "1");
  const [jumpOrder, setJumpOrder] = useState(null);
  const [customer, setCustomer] = useState(params.get("customer") || "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const qs = new URLSearchParams({ view });
      if (customer) qs.set("customer_id", customer);
      if (view === "past") { if (from) qs.set("from", from); if (to) qs.set("to", to); }
      setData(await apiRequest(`/production/orders?${qs}`));
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [view, from, to, customer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened from elsewhere (Plant overview → Edit): show that one order.
  useEffect(() => {
    const id = params.get("edit");
    if (!id) return;
    apiRequest(`/production/orders/${id}`).then((o) => { setJumpOrder(o); setOpenId(o.id); }).catch((e) => setError(e.message));
  }, [params]);

  const list = useMemo(() => {
    const rows = data?.list || [];
    const s = q.trim().toLowerCase();
    return rows.filter((o) => {
      if (status !== "all" && o.status !== status) return false;
      if (grade && String(o.mix_grade_id) !== grade) return false;
      if (s && ![formatOrderNumber(o.id), o.customer_name, o.site_name].some((v) => String(v || "").toLowerCase().includes(s))) return false;
      return true;
    });
  }, [data, q, status, grade, view]);
  const grades = useMemo(() => [...new Map((data?.list || []).map((o) => [String(o.mix_grade_id), o.mix_grade_name])).entries()], [data]);

  async function confirmCompletion(o) {
    if (!window.confirm(`Confirm ${o.customer_name} · ${o.site_name} is complete? This closes the order out.`)) return;
    try { await apiRequest(`/orders/${o.id}/confirm-completion`, { method: "POST" }); load(); } catch (e) { setError(e.message); }
  }
  async function closeOrder(o) {
    const reason = window.prompt(`Close order ${formatOrderNumber(o.id)} for ${o.customer_name}? It will not be completed.\n\nReason (optional):`);
    if (reason === null) return;
    try { await apiRequest(`/orders/${o.id}/close`, { method: "POST", body: { reason } }); load(); } catch (e) { setError(e.message); }
  }

  const counts = data?.counts || {};
  const viewLabel = VIEWS.find((v) => v.key === view)?.label;

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 10, color: "var(--alert-red)", background: "var(--alert-red-bg)", fontSize: 13 }}>{error} <button type="button" onClick={() => setError("")} style={{ marginLeft: 8, padding: "2px 8px" }}>✕</button></div>}
      {notice && <div className="card" style={{ marginBottom: 10, color: "var(--signal-green)", background: "var(--signal-green-bg)", fontSize: 13 }}>{notice}</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
        {VIEWS.map((v) => (
          <button key={v.key} type="button" className={`btn-tab ${view === v.key ? "active" : ""}`} onClick={() => { setView(v.key); setOpenId(null); }}
            style={v.key === "carried" && counts.carried ? { color: view === v.key ? undefined : "var(--alert-red)" } : undefined}>
            {v.label}{v.key !== "past" && counts[v.key] != null ? ` · ${counts[v.key]}` : ""}
          </button>
        ))}
        {canEdit && <button type="button" className="btn-primary" style={{ marginLeft: "auto" }} onClick={() => setNewOpen(true)}>+ New order</button>}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
        <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 }}>Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order no., customer, site" style={{ width: 230 }} /></label>
        <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 }}>Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="planned">Planned</option><option value="in_progress">In progress</option>
            <option value="completed">Completed</option><option value="partially_completed">Part completed</option>
            <option value="cancelled">Cancelled</option><option value="closed">Closed</option>
          </select></label>
        <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 }}>Grade
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">All grades</option>
            {grades.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
        {customer && <button type="button" onClick={() => setCustomer("")}>{data?.list?.[0]?.customer_name || "One customer"} only ✕</button>}
        {view === "past" && (
          <>
            <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 }}>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 }}>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
        {data && <span style={{ ...sub, marginLeft: "auto" }}>{viewLabel}: {data.totals.ordered} m³ ordered · {data.totals.supplied} m³ supplied</span>}
      </div>

      {jumpOrder && !list.some((o) => o.id === jumpOrder.id) && (
        <div className="card" style={{ marginBottom: 12, padding: 0 }}>
          <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", gap: 8 }}>
            <b>{formatOrderNumber(jumpOrder.id)} · {jumpOrder.order_date} · {jumpOrder.customer_name} · {jumpOrder.site_name}</b>
            <button type="button" onClick={() => { setJumpOrder(null); setOpenId(null); }}>Close</button>
          </div>
          <div style={{ padding: "0 10px 12px" }}>
            <OrderEditor order={jumpOrder} canEdit={canEdit} setError={setError} go={go}
              onSaved={(msg) => { setNotice(msg); setJumpOrder(null); setOpenId(null); load(); }} onClose={() => { setJumpOrder(null); setOpenId(null); }} />
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Order</th><th style={TH}>Customer · site</th><th style={TH}>Grade · mix</th><th style={TH}>Supplied / ordered</th>
            <th style={TH}>Pump</th><th style={TH}>Charges</th><th style={TH}>QC engineer</th><th style={TH}>Status</th><th style={TH}></th>
          </tr></thead>
          <tbody>
            {list.map((o) => {
              const pct = o.order_quantity_m3 > 0 ? Math.min(100, Math.round((o.supplied / o.order_quantity_m3) * 100)) : 0;
              const open = openId === o.id;
              const terminal = ["completed", "cancelled", "closed"].includes(o.status);
              return [
                <tr key={o.id} style={{ background: open ? "#FBF8F2" : undefined }}>
                  <td style={TD}><b>{formatOrderNumber(o.id)}</b>
                    <div style={sub}>{view !== "today" && view !== "tomorrow" ? `${o.order_date} · ` : ""}Batching {t5(o.scheduled_batching_time)}{o.required_at_site_time ? ` · at site ${t5(o.required_at_site_time)}` : ""}</div></td>
                  <td style={TD}>{o.customer_name}<div style={sub}>{o.site_name}</div></td>
                  <td style={TD}>{o.mix_grade_name}
                    {o.mix_code ? <div><span className="badge badge-neutral" style={{ fontSize: 11 }}>{o.mix_code}</span></div> : o.price_option ? <div style={sub}>{o.price_option}</div> : null}</td>
                  <td style={TD}>{o.supplied} / {o.order_quantity_m3} m³
                    <div style={{ height: 6, borderRadius: 99, background: "#ECEAE4", marginTop: 5, overflow: "hidden", width: 120 }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "var(--signal-green)" : "var(--info)" }} /></div>
                    <div style={sub}>{o.loads} load{o.loads === 1 ? "" : "s"} out{o.to_confirm ? " · confirm completion" : ""}</div></td>
                  <td style={TD}>{PUMP_LABEL[o.pump_requirement] || o.pump_requirement}{o.pump_code && <div style={sub}>{o.pump_code}</div>}</td>
                  <td style={TD}>{chargeLines(o)}</td>
                  <td style={TD}>{o.qc_engineer_name || <span style={sub}>—</span>}</td>
                  <td style={TD}><OrderStatus o={o} /></td>
                  <td style={{ ...TD, whiteSpace: "nowrap" }}>
                    <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {o.to_confirm && canEdit && <button type="button" onClick={() => confirmCompletion(o)}>Confirm complete</button>}
                      {!terminal && canEdit && view === "carried" && <button type="button" onClick={() => closeOrder(o)}>Close</button>}
                      <button type="button" onClick={() => setOpenId(open ? null : o.id)} style={open ? { background: "var(--charcoal)", color: "#fff", borderColor: "var(--charcoal)" } : undefined}>{open ? "Close" : "Open"}</button>
                    </span>
                  </td>
                </tr>,
                open && (
                  <tr key={`${o.id}-ed`} style={{ background: "#FBF8F2" }}>
                    <td colSpan={9} style={{ padding: "0 10px 14px" }}>
                      <OrderEditor order={o} canEdit={canEdit} setError={setError} go={go}
                        onSaved={(msg) => { setNotice(msg); setOpenId(null); load(); }} onClose={() => setOpenId(null)} />
                    </td>
                  </tr>
                ),
              ];
            })}
            {data && list.length === 0 && <tr><td colSpan={9} style={{ ...TD, color: "var(--slate)" }}>No orders here.</td></tr>}
          </tbody>
        </table>
      </div>

      {newOpen && (
        <Modal title="New order" width={980} onClose={() => setNewOpen(false)}>
          <CreateOrder onDone={() => { setNewOpen(false); setNotice("Order created."); load(); }} />
        </Modal>
      )}
    </>
  );
}

// One order opened for correction. Grade / mix can change only before the
// first ticket (the server says so); pump and times can change any time.
function OrderEditor({ order: o, canEdit, setError, go, onSaved, onClose }) {
  const [form, setForm] = useState({
    order_quantity_m3: o.order_quantity_m3, mix_grade_id: String(o.mix_grade_id), scheduled_batching_time: t5(o.scheduled_batching_time),
    required_at_site_time: t5(o.required_at_site_time), pump_requirement: o.pump_requirement || "without_pump", pump_id: o.pump_id || "",
    assigned_qc_engineer_id: o.assigned_qc_engineer_id || "", remarks: "",
  });
  const [mixKey, setMixKey] = useState(o.quoted_mix_design_id ? `${o.quoted_mix_design_id}|${o.price_option || ""}` : "");
  const [grades, setGrades] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [qcs, setQcs] = useState([]);
  const [siteMixes, setSiteMixes] = useState(null);
  const [resched, setResched] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const terminal = ["completed", "cancelled", "closed"].includes(o.status);
  const locked = o.loads > 0;

  useEffect(() => {
    apiRequest("/master/mix-grades").then(setGrades).catch(() => {});
    apiRequest("/master/pumps").then(setPumps).catch(() => {});
    apiRequest("/master/qc-engineers").then(setQcs).catch(() => {});
    apiRequest(`/master/site-mixes?customer_id=${o.customer_id}&site_id=${o.site_id}&date=${o.order_date}`).then(setSiteMixes).catch(() => {});
  }, [o.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const usePriceList = siteMixes && siteMixes.source !== "none" && siteMixes.mixes.length > 0;
  const gradeChoices = usePriceList
    ? [...new Map(siteMixes.mixes.map((m) => [String(m.mix_grade_id), { id: String(m.mix_grade_id), name: m.grade_name }])).values()]
    : grades.map((g) => ({ id: String(g.id), name: g.name }));
  const designs = usePriceList ? siteMixes.mixes.filter((m) => String(m.mix_grade_id) === form.mix_grade_id && m.mix_design_id) : [];

  async function save() {
    if (form.pump_requirement !== "without_pump" && !form.pump_id) return setError("Select which pump is assigned to this order.");
    if (designs.length && !mixKey) return setError("Choose the mix design for this grade — the quotation names one.");
    setSaving(true); setError("");
    try {
      const m = designs.find((d) => `${d.mix_design_id}|${d.price_option || ""}` === mixKey);
      const body = { ...form };
      if (!locked) {
        body.mix_design_id = m ? m.mix_design_id : null;
        if (m?.price_option) body.price_option = m.price_option;
      } else {
        delete body.mix_grade_id;
      }
      await apiRequest(`/administrator/orders/${o.id}`, { method: "PATCH", body });
      onSaved(`${formatOrderNumber(o.id)} saved.`);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  async function cancelOrder() {
    if (!window.confirm(`Cancel ${formatOrderNumber(o.id)}? It will no longer show as active, but stays on record.`)) return;
    try { await apiRequest(`/administrator/orders/${o.id}/cancel`, { method: "POST" }); onSaved(`${formatOrderNumber(o.id)} cancelled.`); } catch (e) { setError(e.message); }
  }
  async function reschedule() {
    if (!resched.reason.trim()) return setError("A reason is required to reschedule.");
    try {
      await apiRequest(`/administrator/orders/${o.id}/reschedule`, { method: "POST", body: resched });
      onSaved(`${formatOrderNumber(o.id)} moved to ${resched.new_order_date}.`);
    } catch (e) { setError(e.message); }
  }

  const L = { ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 };
  const dis = !canEdit || terminal;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "#fff", padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
      <label style={L}>Quantity m³<input type="number" step="0.5" value={form.order_quantity_m3} disabled={dis} onChange={(e) => set("order_quantity_m3", e.target.value)} /></label>
      <label style={L}>Grade{locked && <span style={{ fontWeight: 400 }}>locked — loads are out</span>}
        <select value={form.mix_grade_id} disabled={dis || locked} onChange={(e) => { set("mix_grade_id", e.target.value); setMixKey(""); }}>
          {gradeChoices.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select></label>
      {designs.length > 0 && (
        <label style={L}>Mix design (from quotation)
          <select value={mixKey} disabled={dis || locked} onChange={(e) => setMixKey(e.target.value)}>
            <option value="">Choose…</option>
            {designs.map((d) => <option key={`${d.mix_design_id}|${d.price_option || ""}`} value={`${d.mix_design_id}|${d.price_option || ""}`}>{d.design_ref}</option>)}
          </select></label>
      )}
      <label style={L}>Batching time<input type="time" value={form.scheduled_batching_time} disabled={dis} onChange={(e) => set("scheduled_batching_time", e.target.value)} /></label>
      <label style={L}>Required at site<input type="time" value={form.required_at_site_time} disabled={dis} onChange={(e) => set("required_at_site_time", e.target.value)} /></label>
      <label style={L}>Pump
        <select value={form.pump_requirement} disabled={dis} onChange={(e) => { set("pump_requirement", e.target.value); set("pump_id", ""); }}>
          {Object.entries(PUMP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
      {form.pump_requirement !== "without_pump" && (
        <label style={L}>Which pump
          <select value={form.pump_id} disabled={dis} onChange={(e) => set("pump_id", e.target.value)}>
            <option value="">Select</option>
            {pumps.filter((p) => p.pump_type === form.pump_requirement).map((p) => <option key={p.id} value={p.id}>{p.pump_code}</option>)}
          </select></label>
      )}
      <label style={L}>QC engineer
        <select value={form.assigned_qc_engineer_id} disabled={dis} onChange={(e) => set("assigned_qc_engineer_id", e.target.value)}>
          <option value="">None</option>
          {qcs.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </select></label>
      <label style={{ ...L, gridColumn: "1 / -1" }}>Remarks<input value={form.remarks} disabled={dis} placeholder={o.remarks || "Optional"} onChange={(e) => set("remarks", e.target.value)} /></label>

      {resched && (
        <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, background: "var(--concrete)", borderRadius: 8, padding: 10 }}>
          <label style={L}>New date<input type="date" value={resched.new_order_date} onChange={(e) => setResched({ ...resched, new_order_date: e.target.value })} /></label>
          <label style={L}>Batching time<input type="time" value={resched.new_scheduled_batching_time} onChange={(e) => setResched({ ...resched, new_scheduled_batching_time: e.target.value })} /></label>
          <label style={{ ...L, gridColumn: "span 2" }}>Reason<input value={resched.reason} onChange={(e) => setResched({ ...resched, reason: e.target.value })} placeholder="Customer asked for another day, site not ready…" /></label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}><button type="button" onClick={() => setResched(null)}>Back</button><button type="button" className="btn-primary" onClick={reschedule}>Move order</button></div>
        </div>
      )}

      <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canEdit && !terminal && !resched && <button type="button" onClick={() => setResched({ new_order_date: o.order_date, new_scheduled_batching_time: t5(o.scheduled_batching_time), reason: "" })}>Reschedule to another day</button>}
          <button type="button" onClick={() => go("tickets", { date: o.order_date, order: String(o.id) })}>Deliveries of this order</button>
          {canEdit && !terminal && <button type="button" style={{ color: "var(--alert-red)", borderColor: "var(--alert-red)" }} onClick={cancelOrder}>Cancel order</button>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onClose}>Close</button>
          {canEdit && !terminal && <button type="button" className="btn-primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>}
        </div>
      </div>
    </div>
  );
}
