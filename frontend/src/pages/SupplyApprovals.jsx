import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function SupplyApprovals() {
  const [rows, setRows] = useState([]);
  const [stations, setStations] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [edits, setEdits] = useState({}); // id -> { quantity, station_id }

  // Round 131, item 5 — Store's own purchase requests (restocking the plant
  // store) wait on the same Manager as the issue-requests above, so they're
  // shown on this one screen rather than sending Manager to a second page.
  const [purchases, setPurchases] = useState([]);
  const [purchaseEdits, setPurchaseEdits] = useState({}); // id -> qty

  async function load() {
    try {
      const [pending, stationList, pendingPurchases] = await Promise.all([
        apiRequest("/supply-requests/pending"),
        apiRequest("/master/fuel-stations"),
        apiRequest("/store-stock/purchases/pending"),
      ]);
      setRows(pending);
      setStations(stationList);
      setPurchases(pendingPurchases);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  async function approvePurchase(p) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/store-stock/purchases/${p.id}/approve`, {
        method: "POST",
        body: { approved_qty: purchaseEdits[p.id] || p.requested_qty },
      });
      setNotice("Purchase approved.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function rejectPurchase(p) {
    const reason = window.prompt("Reason for rejecting this purchase request:");
    if (!reason) return;
    setError(""); setNotice("");
    try {
      await apiRequest(`/store-stock/purchases/${p.id}/reject`, { method: "POST", body: { reason } });
      setNotice("Rejected.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearPurchase(p) {
    if (!window.confirm(`Clear this purchase request from ${p.requested_by_name}? This removes it entirely — no reason recorded, no notification sent.`)) return;
    setError(""); setNotice("");
    try {
      await apiRequest(`/store-stock/purchases/${p.id}`, { method: "DELETE" });
      setNotice("Cleared.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function setEdit(id, field, value) {
    setEdits((e) => ({ ...e, [id]: { ...e[id], [field]: value } }));
  }

  async function approve(r) {
    setError(""); setNotice("");
    const edit = edits[r.id] || {};
    try {
      await apiRequest(`/supply-requests/${r.id}/approve`, {
        method: "POST",
        body: {
          approved_quantity: edit.quantity || r.requested_quantity,
          approved_station_id: edit.station_id || r.fuel_station_id,
        },
      });
      setNotice("Approved.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reject(r) {
    const reason = window.prompt("Reason for rejecting this request:");
    if (!reason) return;
    setError(""); setNotice("");
    try {
      await apiRequest(`/supply-requests/${r.id}/reject`, { method: "POST", body: { reason } });
      setNotice("Rejected.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearRequest(r) {
    if (!window.confirm(`Clear this request from ${r.requested_by_name}? This removes it entirely — no reason recorded, no notification sent. Use Reject instead if the requester should know why.`)) return;
    setError(""); setNotice("");
    try {
      await apiRequest(`/supply-requests/${r.id}`, { method: "DELETE" });
      setNotice("Cleared.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <TopBar title="Fuel and lubricant requests" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>{rows.length} pending</div>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}

        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing waiting on you right now.</div>
        ) : (
          rows.map((r) => {
            const isFuel = r.request_type === "fuel";
            const accent = isFuel ? "var(--info)" : "#0F6E56";
            const bg = isFuel ? "var(--info-bg, #E6F1FB)" : "var(--signal-green-bg, #E1F5EE)";
            return (
              <div key={r.id} style={{ background: bg, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: accent }}>{unitLabel(r)} &middot; {r.requested_by_name}</span>
                  <span style={{ fontSize: 10, color: "var(--slate)" }}>{new Date(r.requested_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
                  {r.odometer_reading ? `Odometer ${r.odometer_reading} km` : `Hour meter ${r.hour_meter_reading} hrs`}
                  {!isFuel && ` · ${r.lubricant_type_name}`}
                </div>
                {/* Round 153, item 3 — what this unit has run since its last
                    fill, so the quantity can be judged instead of guessed at.
                    Only for fuel, and only when there is a previous fill with
                    a usable reading; a first-ever fill legitimately has
                    nothing to compare against and says so rather than
                    showing a misleading zero. */}
                {isFuel && <SinceLastFill r={r} />}

                <div style={{ display: "grid", gridTemplateColumns: isFuel ? "1fr 1fr" : "1fr", gap: 8, marginBottom: 10 }}>
                  {isFuel && (
                    <select
                      style={{ fontSize: 12 }}
                      value={edits[r.id]?.station_id || r.fuel_station_id || ""}
                      onChange={(e) => setEdit(r.id, "station_id", e.target.value)}
                    >
                      {stations.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_plant ? " (plant)" : ""}</option>)}
                    </select>
                  )}
                  <input
                    type="number"
                    style={{ fontSize: 12 }}
                    value={edits[r.id]?.quantity ?? r.requested_quantity}
                    onChange={(e) => setEdit(r.id, "quantity", e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ flex: 1, padding: 8, fontSize: 13, background: "var(--signal-green)", color: "#fff", border: "none" }} onClick={() => approve(r)}>Approve</button>
                  <button style={{ flex: 1, padding: 8, fontSize: 13 }} onClick={() => reject(r)}>Reject</button>
                  <button style={{ padding: 8, fontSize: 13 }} onClick={() => clearRequest(r)} title="Remove without a reason or notification">Clear</button>
                </div>
              </div>
            );
          })
        )}

        <div style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 10px" }}>Store stock purchase requests</div>
        {purchases.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing waiting on you right now.</div>
        ) : (
          purchases.map((p) => (
            <div key={p.id} style={{ background: "var(--concrete, #F3F1EC)", borderRadius: 12, padding: 14, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.item_name} &middot; {p.requested_by_name}</span>
                <span style={{ fontSize: 10, color: "var(--slate)" }}>{new Date(p.requested_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
                Requested {p.requested_qty} {p.unit}{p.supplier_name ? ` from ${p.supplier_name}` : ""} · current balance {Number(p.current_qty).toFixed(1)} {p.unit}
                {p.notes ? ` · ${p.notes}` : ""}
              </div>
              <div style={{ marginBottom: 10 }}>
                <input
                  type="number"
                  style={{ fontSize: 12, width: 120 }}
                  value={purchaseEdits[p.id] ?? p.requested_qty}
                  onChange={(e) => setPurchaseEdits((ed) => ({ ...ed, [p.id]: e.target.value }))}
                />
                <span style={{ fontSize: 11, color: "var(--slate)", marginLeft: 6 }}>{p.unit} to approve</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ flex: 1, padding: 8, fontSize: 13, background: "var(--signal-green)", color: "#fff", border: "none" }} onClick={() => approvePurchase(p)}>Approve</button>
                <button style={{ flex: 1, padding: 8, fontSize: 13 }} onClick={() => rejectPurchase(p)}>Reject</button>
                <button style={{ padding: 8, fontSize: 13 }} onClick={() => clearPurchase(p)} title="Remove without a reason or notification">Clear</button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function unitLabel(r) {
  return r.truck_number || r.pump_code || r.equipment_name || "—";
}

// Round 153, item 3 — the one line that turns "approve 60 litres?" into a
// question with an answer. The server (supplyRequests.js GET /pending) works
// out the interval and the implied rate; this only decides how to say it.
//
// Units follow whichever meter the request carries, exactly as the reading
// line above it does: km and L/100km for anything on an odometer, hours and
// L/hr for anything on an hour meter.
function SinceLastFill({ r }) {
  const onOdometer = r.odometer_reading != null;
  const distance = r.distance_since_last == null ? null : Number(r.distance_since_last);
  const rate = r.implied_rate == null ? null : Number(r.implied_rate);

  // No prior fill at all — say so plainly. This is the normal state for a new
  // truck or the first fill after the app went live, and dressing it up as a
  // zero would read as "hasn't moved", which is a very different claim.
  if (!r.last_fill_at) {
    return (
      <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8, fontStyle: "italic" }}>
        No earlier fill on record for this unit — nothing to compare against yet.
      </div>
    );
  }

  const when = new Date(r.last_fill_at).toLocaleDateString([], { day: "2-digit", month: "short" });
  const lastQty = r.last_fill_quantity == null ? null : Number(r.last_fill_quantity);

  return (
    <div style={{ fontSize: 11, marginBottom: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(0,0,0,0.04)" }}>
      <div style={{ fontWeight: 600 }}>
        {distance == null
          ? "Meter reading hasn't advanced since the last fill"
          : `${distance.toLocaleString()} ${onOdometer ? "km" : "hrs"} since last fill`}
        {rate != null && (
          <span style={{ fontWeight: 400 }}>
            {" "}&middot; asking {onOdometer ? `${rate} L/100km` : `${rate} L/hr`}
          </span>
        )}
      </div>
      <div style={{ color: "var(--slate)" }}>
        Last filled {when}
        {lastQty != null ? ` — ${lastQty} L` : ""}
        {r.last_fill_reading != null ? ` at ${Number(r.last_fill_reading).toLocaleString()} ${onOdometer ? "km" : "hrs"}` : ""}
      </div>
      {distance == null && (
        <div style={{ color: "var(--alert-red)" }}>
          Worth checking the reading before approving.
        </div>
      )}
    </div>
  );
}
