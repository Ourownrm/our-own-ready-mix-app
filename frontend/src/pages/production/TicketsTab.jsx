// Round 254 — Production → Delivery tickets (was "Correct Tickets"). The
// day's loads, grouped by order: trip times, quantity, the invoice (with
// part load), returned concrete. A quantity correction needs a reason; the
// invoice is worked out again.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { formatOrderNumber } from "../../lib/orderNumber.js";
import { PUMP_LABEL } from "./OrdersTab.jsx";

const sub = { fontSize: 12, color: "var(--slate)" };
const TH = { padding: "9px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--slate)", whiteSpace: "nowrap" };
const TD = { padding: "10px", fontSize: 13, verticalAlign: "top", borderTop: "1px solid var(--border)" };
const R = { ...TD, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const money = (n) => (n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
const hm = (t) => (t ? new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : "");
const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function ticketState(t) {
  if (t.status === "cancelled") return ["Cancelled", "badge-neutral", "cancelled"];
  if (t.status === "rejected") return ["Rejected", "badge-danger", "returned"];
  if (t.returned_m3 > 0) return [t.returned_m3 >= t.loaded_quantity_m3 ? "Returned" : "Part returned", "badge-danger", "returned"];
  if (t.returned_at) return ["Back at plant", "badge-success", "unloaded"];
  if (t.unloading_completed_at || t.status === "completed") return ["Unloaded", "badge-success", "unloaded"];
  if (t.unloading_started_at || t.status === "unloading") return ["Unloading", "badge-progress", "road"];
  if (t.reached_site_at || t.status === "reached_site") return ["At site", "badge-info", "road"];
  if (t.left_plant_at || t.status === "dispatched") return ["To site", "badge-info", "road"];
  return ["Loading", "badge-neutral", "road"];
}
function trip(t) {
  if (t.status === "cancelled") return "—";
  const parts = [];
  if (t.left_plant_at) parts.push(`Plant out ${hm(t.left_plant_at)}`);
  if (t.reached_site_at) parts.push(t.unloading_completed_at ? `Site ${hm(t.reached_site_at)}` : `at site since ${hm(t.reached_site_at)}`);
  if (t.unloading_completed_at) parts.push(`Unloaded ${hm(t.unloading_completed_at)}`);
  if (t.returned_at) parts.push(`Back ${hm(t.returned_at)}`);
  return parts.length ? parts.join(" → ") : "not left the plant";
}

const FILTERS = [["all", "All"], ["road", "On the road"], ["unloaded", "Unloaded"], ["returned", "Returned"], ["cancelled", "Cancelled"]];

export default function TicketsTab({ go, params }) {
  const { can } = usePermissions();
  const canEdit = can("production.correct-tickets", "edit");
  const canChallan = can("orders.challan-print", "view");
  const [date, setDate] = useState(params.get("date") || istToday());
  const onlyOrder = params.get("order");
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try { setData(await apiRequest(`/production/tickets?date=${date}`)); } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const byOrder = new Map();
    for (const t of data?.list || []) {
      if (onlyOrder && String(t.order_id) !== onlyOrder) continue;
      const st = ticketState(t)[2];
      if (filter !== "all" && st !== filter) continue;
      if (s && ![t.ticket_number, t.truck_number, t.driver_name, t.customer_name, t.site_name, formatOrderNumber(t.order_id)].some((v) => String(v || "").toLowerCase().includes(s))) continue;
      if (!byOrder.has(t.order_id)) byOrder.set(t.order_id, []);
      byOrder.get(t.order_id).push(t);
    }
    return [...byOrder.values()];
  }, [data, filter, q, onlyOrder]);

  async function printChallan(id) {
    setError("");
    try {
      const { generateDeliveryChallanPdf } = await import("../../lib/deliveryChallanPdf.js");
      await generateDeliveryChallanPdf(id);
    } catch (e) { setError(e.message); }
  }

  const tl = data?.tiles;
  const allCount = (data?.list || []).filter((t) => !onlyOrder || String(t.order_id) === onlyOrder).length;
  return (
    <>
      {error && <div className="card" style={{ marginBottom: 10, color: "var(--alert-red)", background: "var(--alert-red-bg)", fontSize: 13 }}>{error} <button type="button" onClick={() => setError("")} style={{ marginLeft: 8, padding: "2px 8px" }}>✕</button></div>}
      {notice && <div className="card" style={{ marginBottom: 10, color: "var(--signal-green)", background: "var(--signal-green-bg)", fontSize: 13 }}>{notice}</div>}

      {tl && (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
          <Tile label={date === istToday() ? "Loads today" : "Loads"} value={tl.loads} note={`${tl.loaded_m3} m³ loaded`} />
          <Tile label="On the road / at site" value={tl.on_road} note={`${tl.on_road_m3} m³`} />
          <Tile label="Unloaded" value={tl.unloaded} note={`${tl.unloaded_m3} m³`} />
          <Tile label="Part loads" value={tl.part_loads} note={`${money(tl.part_load_amount)} charged`} />
          <Tile label="Returned / rejected" value={tl.returned} note={`${tl.returned_m3} m³ back`} red={tl.returned > 0} />
        </section>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
        <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 }}>Day
          <input type="date" value={date} onChange={(e) => setDate(e.target.value || istToday())} /></label>
        {FILTERS.map(([k, l]) => (
          <button key={k} type="button" className={`btn-tab ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>{l}{k === "all" ? ` · ${allCount}` : ""}</button>
        ))}
        {onlyOrder && <button type="button" onClick={() => go("tickets", { date })}>Showing {formatOrderNumber(onlyOrder)} only ✕</button>}
        <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4, marginLeft: "auto" }}>Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticket no., truck, driver, customer" style={{ width: 240 }} /></label>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {groups.map((g) => {
          const o = g[0];
          const live = g.filter((t) => t.status !== "cancelled");
          const qty = Math.round(live.reduce((s, t) => s + t.loaded_quantity_m3, 0) * 100) / 100;
          return (
            <section key={o.order_id} className="card" style={{ padding: 0, overflowX: "auto" }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, padding: "12px 14px", background: "#FBF8F2", borderBottom: "1px solid var(--border)" }}>
                <div><b>{formatOrderNumber(o.order_id)}</b> · {o.customer_name} · {o.site_name} · {o.mix_grade_name}{o.mix_code ? ` (${o.mix_code})` : ""} · {PUMP_LABEL[o.pump_requirement] || o.pump_requirement}</div>
                <div style={sub}>{qty} of {o.order_quantity_m3} m³ · {live.length} load{live.length === 1 ? "" : "s"} · <a href="#" onClick={(e) => { e.preventDefault(); go("orders", { edit: String(o.order_id) }); }}>Open order</a></div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 940 }}>
                <thead><tr><th style={TH}>Ticket</th><th style={TH}>Truck · driver</th><th style={{ ...TH, textAlign: "right" }}>Qty</th><th style={TH}>Trip</th><th style={{ ...TH, textAlign: "right" }}>Invoice</th><th style={TH}>Status</th><th style={TH}></th></tr></thead>
                <tbody>
                  {g.map((t) => {
                    const [label, cls] = ticketState(t);
                    const open = openId === t.id;
                    const cancelled = t.status === "cancelled";
                    return [
                      <tr key={t.id} style={{ opacity: cancelled ? 0.6 : 1 }}>
                        <td style={TD}><b>{t.ticket_number}</b><div style={sub}>loaded {hm(t.created_at)}{t.corrections ? ` · corrected ${t.corrections}×` : ""}</div></td>
                        <td style={TD}>{t.truck_number || "—"}<div style={sub}>{t.driver_name}</div></td>
                        <td style={R}>{t.loaded_quantity_m3} m³
                          {t.part_load_charge > 0 && <div><span className="badge badge-warning" style={{ fontSize: 11 }}>part load</span></div>}
                          {t.returned_m3 > 0 && <div style={sub}>{t.returned_m3} m³ returned</div>}</td>
                        <td style={{ ...TD, fontSize: 12.5 }}>{trip(t)}</td>
                        <td style={R}>{cancelled ? "void" : money(t.invoice_total)}
                          {!cancelled && t.part_load_charge > 0 && <div style={sub}>incl. part load {money(t.part_load_charge)}</div>}</td>
                        <td style={TD}><span className={`badge ${cls}`}>{label}</span></td>
                        <td style={{ ...TD, whiteSpace: "nowrap" }}>
                          {!cancelled && (
                            <span style={{ display: "flex", gap: 6 }}>
                              {canChallan && <button type="button" onClick={() => printChallan(t.id)}>Challan</button>}
                              {canEdit && <button type="button" onClick={() => setOpenId(open ? null : t.id)} style={open ? { background: "var(--charcoal)", color: "#fff", borderColor: "var(--charcoal)" } : undefined}>{open ? "Close" : "Correct"}</button>}
                            </span>
                          )}
                        </td>
                      </tr>,
                      open && (
                        <tr key={`${t.id}-c`}>
                          <td colSpan={7} style={{ padding: "0 10px 14px" }}>
                            <TicketCorrection t={t} setError={setError} onDone={(msg) => { setNotice(msg); setOpenId(null); load(); }} />
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </section>
          );
        })}
        {data && groups.length === 0 && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No delivery tickets {filter === "all" ? "on this day" : "here"}.</div>}
      </div>
    </>
  );
}

function Tile({ label, value, note, red }) {
  return (
    <div className="card" style={{ padding: "12px 14px", ...(red ? { background: "var(--alert-red-bg)", borderColor: "var(--alert-red)" } : {}) }}>
      <div style={{ ...sub, color: red ? "var(--alert-red)" : sub.color }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: red ? "var(--alert-red)" : undefined }}>{value}</div>
      <div style={{ ...sub, color: red ? "var(--alert-red)" : sub.color }}>{note}</div>
    </div>
  );
}

function TicketCorrection({ t, setError, onDone }) {
  const [qty, setQty] = useState(String(t.loaded_quantity_m3));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  useEffect(() => { apiRequest(`/production/tickets/${t.id}/corrections`).then(setHistory).catch(() => {}); }, [t.id]);

  async function save() {
    if (Number(qty) === Number(t.loaded_quantity_m3)) return setError("The quantity is unchanged.");
    if (!reason.trim()) return setError("Give the reason for the correction.");
    setSaving(true); setError("");
    try {
      await apiRequest(`/administrator/tickets/${t.id}`, { method: "PATCH", body: { loaded_quantity_m3: qty, reason: reason.trim() } });
      onDone(`${t.ticket_number} corrected to ${qty} m³.`);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  async function cancelTicket() {
    if (!window.confirm(`Cancel ${t.ticket_number}? It stays on record but won't count as a load.`)) return;
    try { await apiRequest(`/administrator/tickets/${t.id}/cancel`, { method: "POST" }); onDone(`${t.ticket_number} cancelled.`); } catch (e) { setError(e.message); }
  }
  const L = { ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", background: "#fff" }}>
      <label style={L}>Loaded quantity m³<input type="number" step="0.5" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 120 }} /></label>
      <label style={{ ...L, flex: "1 1 260px" }}>Reason for the correction<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. batch sheet shows 3.5 m³" /></label>
      <div style={{ ...sub, flex: "1 1 220px" }}>The invoice is worked out again — concrete, and the part load for the m³ short.</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ color: "var(--alert-red)", borderColor: "var(--alert-red)" }} onClick={cancelTicket}>Cancel ticket</button>
        <button type="button" className="btn-primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
      </div>
      {history.length > 0 && (
        <div style={{ flex: "1 1 100%", ...sub }}>
          Earlier corrections: {history.map((h, i) => <span key={i}>{i ? " · " : ""}{Number(h.old_qty)} → {Number(h.new_qty)} m³ by {h.done_by || "—"} ({h.reason})</span>)}
        </div>
      )}
    </div>
  );
}
