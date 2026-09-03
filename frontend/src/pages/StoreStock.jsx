// Round 131, item 5 — Store Stock: the purchase/receive/balance layer on
// top of the existing give-fuel-out flow (Fuel filling / Supply approvals).
// Store requests a purchase here, sees its own balance and history, and
// confirms what actually arrived. Manager/Administrator additionally get a
// "Adjust" action per item for a physical stock correction — Store
// deliberately does NOT get that action, per the explicit request that
// adjustment is a Manager-only option.
import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL = { pending: "Pending approval", approved: "Approved — awaiting receipt", rejected: "Rejected", received: "Received" };
const STATUS_COLOR = { pending: "var(--amber, #9C6B12)", approved: "var(--info)", rejected: "var(--alert-red)", received: "var(--signal-green)" };

export default function StoreStock() {
  const { user } = useAuth();
  const isManager = user?.role === "manager" || user?.role === "administrator";

  const [items, setItems] = useState([]);
  const [mine, setMine] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [requestFor, setRequestFor] = useState(null); // stock item being requested against
  const [qty, setQty] = useState("");
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const [receiving, setReceiving] = useState(null); // purchase row being received
  const [receiveQty, setReceiveQty] = useState("");
  const [receiveCost, setReceiveCost] = useState("");

  const [adjusting, setAdjusting] = useState(null); // stock item being adjusted (manager only)
  const [countedQty, setCountedQty] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  // Round 137, item 1d — Manager/Administrator-maintained rupees/liter rate
  // per item, separate from the physical-count "Adjust" action above.
  const [settingRate, setSettingRate] = useState(null); // stock item whose rate is being set
  const [rateValue, setRateValue] = useState("");

  const [history, setHistory] = useState(null); // { item, rows } | null

  async function load() {
    try {
      const [itemRows, myPurchases] = await Promise.all([
        apiRequest("/store-stock/items"),
        apiRequest("/store-stock/purchases/mine"),
      ]);
      setItems(itemRows);
      setMine(myPurchases);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function openRequest(item) {
    setRequestFor(item); setQty(""); setSupplier(""); setNotes(""); setError(""); setNotice("");
  }
  async function submitRequest(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/store-stock/purchases", {
        method: "POST",
        body: { stock_item_id: requestFor.id, requested_qty: qty, supplier_name: supplier || null, notes: notes || null },
      });
      setNotice("Purchase request sent to Manager for approval.");
      setRequestFor(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function openReceive(p) {
    setReceiving(p); setReceiveQty(p.approved_qty || ""); setReceiveCost(""); setError(""); setNotice("");
  }
  async function submitReceive(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/store-stock/purchases/${receiving.id}/receive`, {
        method: "POST",
        body: { received_qty: receiveQty, unit_cost: receiveCost || null },
      });
      setNotice("Receipt recorded — stock balance updated.");
      setReceiving(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function openAdjust(item) {
    setAdjusting(item); setCountedQty(item.current_qty); setAdjustNote(""); setError(""); setNotice("");
  }
  async function submitAdjust(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/store-stock/items/${adjusting.id}/adjust`, {
        method: "POST",
        body: { counted_qty: countedQty, note: adjustNote },
      });
      setNotice("Stock adjusted.");
      setAdjusting(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function openSetRate(item) {
    setSettingRate(item); setRateValue(item.rate_per_liter ?? ""); setError(""); setNotice("");
  }
  async function submitRate(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/store-stock/items/${settingRate.id}/rate`, {
        method: "PATCH",
        body: { rate_per_liter: rateValue },
      });
      setNotice("Rate updated.");
      setSettingRate(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function openHistory(item) {
    setError("");
    try {
      const rows = await apiRequest(`/store-stock/items/${item.id}/transactions`);
      setHistory({ item, rows });
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <TopBar title="Store Stock" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}

        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Balances</div>
        {items.map((it) => {
          const low = it.reorder_level != null && Number(it.current_qty) <= Number(it.reorder_level);
          return (
            <div key={it.id} className="card" style={{ marginBottom: 10, background: low ? "var(--alert-red-bg)" : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{it.display_name}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, color: low ? "var(--alert-red)" : undefined }}>
                    {Number(it.current_qty).toFixed(1)} <span style={{ fontSize: 11, fontWeight: 400, color: "var(--slate)" }}>{it.unit}</span>
                  </div>
                  {low && <div style={{ fontSize: 10.5, color: "var(--alert-red)", fontWeight: 600, marginTop: 1 }}>Below reorder level ({it.reorder_level} {it.unit})</div>}
                  <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 3 }}>
                    Rate: {it.rate_per_liter != null ? `₹${Number(it.rate_per_liter).toFixed(2)}/${it.unit}` : "not set"}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                  <button type="button" style={{ fontSize: 11.5, padding: "5px 10px" }} onClick={() => openRequest(it)}>Request purchase</button>
                  {isManager && <button type="button" style={{ fontSize: 11.5, padding: "5px 10px" }} onClick={() => openAdjust(it)}>Adjust</button>}
                  {isManager && <button type="button" style={{ fontSize: 11.5, padding: "5px 10px" }} onClick={() => openSetRate(it)}>Set rate</button>}
                </div>
              </div>
              <button type="button" onClick={() => openHistory(it)} style={{ fontSize: 10.5, padding: "3px 0", marginTop: 6, background: "none", border: "none", color: "var(--rebar)", textAlign: "left" }}>
                View history →
              </button>
            </div>
          );
        })}

        <div style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>My purchase requests</div>
        {mine.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No requests yet.</div>
        ) : (
          mine.map((p) => (
            <div key={p.id} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.item_name}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLOR[p.status] }}>{STATUS_LABEL[p.status]}</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>
                Requested {p.requested_qty} {p.unit}{p.supplier_name ? ` from ${p.supplier_name}` : ""} · {fmtDateTime(p.requested_at)}
              </div>
              {p.status === "approved" && (
                <>
                  <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>Approved for {p.approved_qty} {p.unit}</div>
                  <button type="button" style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 6 }} onClick={() => openReceive(p)}>Confirm received</button>
                </>
              )}
              {p.status === "rejected" && p.rejected_reason && (
                <div style={{ fontSize: 11.5, color: "var(--alert-red)", marginTop: 2 }}>Reason: {p.rejected_reason}</div>
              )}
              {p.status === "received" && (
                <div style={{ fontSize: 11.5, color: "var(--signal-green)", marginTop: 2 }}>
                  Received {p.received_qty} {p.unit}{p.total_cost ? ` · ₹${Number(p.total_cost).toFixed(2)}` : ""} on {fmtDateTime(p.received_at)}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {requestFor && (
        <Modal onClose={() => setRequestFor(null)} title={`Request purchase — ${requestFor.display_name}`}>
          <form onSubmit={submitRequest}>
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Quantity ({requestFor.unit})</label>
            <input type="number" required value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Supplier (optional)</label>
            <input type="text" value={supplier} onChange={(e) => setSupplier(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: "100%", marginBottom: 10, fontFamily: "inherit" }} />
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Sending..." : "Send request"}</button>
          </form>
        </Modal>
      )}

      {receiving && (
        <Modal onClose={() => setReceiving(null)} title={`Confirm received — ${receiving.item_name}`}>
          <form onSubmit={submitReceive}>
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Quantity actually received ({receiving.unit})</label>
            <input type="number" required value={receiveQty} onChange={(e) => setReceiveQty(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Unit cost (optional, ₹ per {receiving.unit})</label>
            <input type="number" value={receiveCost} onChange={(e) => setReceiveCost(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Confirm receipt"}</button>
          </form>
        </Modal>
      )}

      {adjusting && (
        <Modal onClose={() => setAdjusting(null)} title={`Adjust stock — ${adjusting.display_name}`}>
          <form onSubmit={submitAdjust}>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8 }}>System balance: {Number(adjusting.current_qty).toFixed(1)} {adjusting.unit}</div>
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Counted quantity ({adjusting.unit})</label>
            <input type="number" required value={countedQty} onChange={(e) => setCountedQty(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Reason</label>
            <textarea required value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} rows={2} placeholder="e.g. physical count, evaporation, spillage, correction" style={{ width: "100%", marginBottom: 10, fontFamily: "inherit" }} />
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save adjustment"}</button>
          </form>
        </Modal>
      )}

      {settingRate && (
        <Modal onClose={() => setSettingRate(null)} title={`Set rate — ${settingRate.display_name}`}>
          <form onSubmit={submitRate}>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8 }}>
              Store's issue screens pre-fill their cost field from this rate — still editable there, so this is a default, not a locked price.
            </div>
            <label style={{ fontSize: 11.5, color: "var(--slate)" }}>Rate (₹ per {settingRate.unit})</label>
            <input type="number" step="0.01" min="0" required value={rateValue} onChange={(e) => setRateValue(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save rate"}</button>
          </form>
        </Modal>
      )}

      {history && (
        <Modal onClose={() => setHistory(null)} title={`History — ${history.item.display_name}`}>
          {history.rows.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No transactions yet.</div>
          ) : (
            history.rows.map((t) => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 0", borderBottom: "1px solid var(--border, #DEDAD1)" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{txnLabel(t.txn_type)}</div>
                  <div style={{ color: "var(--slate)", fontSize: 10.5 }}>{fmtDateTime(t.created_at)}{t.created_by_name ? ` · ${t.created_by_name}` : ""}{t.note ? ` · ${t.note}` : ""}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 600, color: Number(t.qty_change) >= 0 ? "var(--signal-green)" : "var(--alert-red)" }}>
                    {Number(t.qty_change) >= 0 ? "+" : ""}{Number(t.qty_change).toFixed(1)}
                  </div>
                  <div style={{ color: "var(--slate)", fontSize: 10.5 }}>Balance {Number(t.balance_after).toFixed(1)}</div>
                </div>
              </div>
            ))
          )}
        </Modal>
      )}
    </>
  );
}

function txnLabel(t) {
  if (t === "purchase_receive") return "Purchase received";
  if (t === "issue_deduct") return "Issued (plant)";
  if (t === "adjustment") return "Physical adjustment";
  return t;
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: "14px 14px 0 0", padding: 18, width: "100%", maxWidth: 460, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "none", fontSize: 18, lineHeight: 1, padding: 0, color: "var(--slate)" }}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}
