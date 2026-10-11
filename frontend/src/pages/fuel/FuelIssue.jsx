import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../lib/api.js";
import { useAuth } from "../../lib/AuthContext.jsx";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { fmtL, fmtNum, fmtWhen } from "./fuelUi.jsx";

// Round 199 — every fuel request still waiting on someone, in one list.
// The actions themselves are unchanged and stay where they were: a Manager
// approves on "Fuel and lubricant requests", Store issues by scanning the
// driver's QR code, and a driver confirms their own outside-station fill.
//
// Round 203 — an outside fill the driver never confirmed can be closed here
// from the station bill (Store or Manager, "fuel.outside-close") or cancelled
// as not filled (Manager, "fuel.outside-cancel"). Each shows how long it has
// been open and whether the reminders have gone out.

// yyyy-mm-ddThh:mm in IST, for a datetime-local input.
function istLocalInput(ts) {
  const d = new Date(ts);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function OpenFor({ hours }) {
  if (hours == null) return "—";
  const h = Number(hours);
  const text = h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} hrs` : `${Math.round(h / 24)} days`;
  const cls = h >= 24 ? "badge-danger" : h >= 12 ? "badge-warning" : "badge-neutral";
  return <span className={`badge ${cls}`}>{text}</span>;
}

function CloseForm({ r, mode, onDone, onCancel }) {
  const [qty, setQty] = useState("");
  const [amount, setAmount] = useState("");
  const [bill, setBill] = useState("");
  const [filledAt, setFilledAt] = useState(r.approved_at ? istLocalInput(r.approved_at) : "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const over = mode === "close" && Number(qty) > Number(r.approved_quantity);

  async function save() {
    setSaving(true); setErr("");
    try {
      if (mode === "close") {
        await apiRequest(`/supply-requests/${r.id}/close-outside`, {
          method: "POST",
          body: { actual_quantity_issued: qty, fuel_cost: amount, bill_ref: bill, note, filled_at: filledAt ? `${filledAt}:00+05:30` : null },
        });
      } else {
        // "cancel" = outside fill not filled (Manager); "cancel-approved" = any
        // approved request, Administrator only (Round 203).
        await apiRequest(`/supply-requests/${r.id}/${mode === "cancel" ? "cancel-outside" : "cancel-approved"}`, { method: "POST", body: { note } });
      }
      onDone(mode === "close" ? `FR-${r.id} closed from the bill.` : mode === "cancel" ? `FR-${r.id} cancelled — not filled.` : `FR-${r.id} cancelled.`);
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  }

  const ready = mode === "close" ? Number(qty) > 0 && Number(amount) > 0 && (!over || note.trim()) : note.trim();
  return (
    <div className="field-input" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", padding: "4px 0" }}>
      {mode === "close" ? (
        <>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>Litres on the bill
            <input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={`${fmtNum(r.approved_quantity)} approved`} style={{ display: "block", marginTop: 4, width: 150 }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>Amount (₹){r.approved_rate != null ? ` · rate ₹${r.approved_rate}/L` : ""}
            <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder={r.approved_rate != null && Number(qty) > 0 ? `≈ ${Math.round(Number(qty) * r.approved_rate)}` : ""} style={{ display: "block", marginTop: 4, width: 140 }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>Bill no. (optional)
            <input type="text" value={bill} onChange={(e) => setBill(e.target.value)} style={{ display: "block", marginTop: 4, width: 140 }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--slate)" }}>Filled on
            <input type="datetime-local" value={filledAt} onChange={(e) => setFilledAt(e.target.value)} style={{ display: "block", marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: over ? "var(--alert-red)" : "var(--slate)", flex: "1 1 220px" }}>
            {over ? `Note — required: the bill is more than the ${fmtNum(r.approved_quantity)} L approved` : "Note (optional)"}
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={{ display: "block", marginTop: 4 }} />
          </label>
        </>
      ) : (
        <label style={{ fontSize: 12, color: "var(--slate)", flex: "1 1 280px" }}>{mode === "cancel" ? "Why wasn't it filled?" : "Why is this approved request cancelled?"}
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Truck went back to the plant" style={{ display: "block", marginTop: 4 }} />
        </label>
      )}
      <button type="button" onClick={onCancel}>Back</button>
      <button type="button" className={mode === "close" ? "btn-primary" : "btn-danger"} disabled={saving || !ready} onClick={save}>
        {saving ? "Saving…" : mode === "close" ? "Close from bill" : mode === "cancel" ? "Cancel — not filled" : "Cancel request"}
      </button>
      {err && <div style={{ flex: "1 1 100%", color: "var(--alert-red)", fontSize: 12.5 }}>{err}</div>}
    </div>
  );
}

const STAGES = [
  { key: "approval", title: "Waiting for approval", sub: "A Manager approves or reduces the quantity" },
  { key: "issue", title: "Approved — ready to issue at the plant", sub: "Store scans the driver's QR code to issue" },
  { key: "outside", title: "Approved for an outside station", sub: "The driver confirms the litres and amount after filling — if not, Store or the Manager closes it from the station bill" },
];

export default function FuelIssue() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const canApprove = can("store.supply-approve", "edit") && ["manager", "administrator", "super_admin"].includes(user?.role);
  const canScan = can("store.supply-issue", "edit") && ["store", "administrator", "super_admin"].includes(user?.role);
  const canClose = can("fuel.outside-close", "edit");
  const canCancel = can("fuel.outside-cancel", "edit");
  const canCancelApproved = can("fuel.cancel-approved", "edit");
  const [acting, setActing] = useState(null); // { id, mode: "close" | "cancel" }
  const [notice, setNotice] = useState("");

  function load() {
    setError("");
    apiRequest("/fuel-module/issue-queue").then(setRows).catch((e) => setError(e.message));
  }
  useEffect(load, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Issue fuel</h1>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>Fuel requests waiting to be approved, issued or confirmed</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canScan && <Link to="/store"><button type="button" className="btn-primary">Scan QR &amp; issue</button></Link>}
          {canApprove && <Link to="/supply-approvals"><button type="button">Approve requests</button></Link>}
          <button type="button" onClick={load}>Refresh</button>
        </div>
      </div>
      {notice && <div style={{ background: "var(--signal-green-bg)", color: "var(--signal-green)", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>{notice}</div>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {!rows && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {rows && STAGES.map((st) => {
        const list = rows.filter((r) => r.stage === st.key);
        return (
          <section key={st.key} className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{st.title} <span className="chip" style={{ marginLeft: 6 }}>{list.length}</span></div>
                <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{st.sub}</div>
              </div>
              {st.key === "approval" && canApprove && list.length > 0 && <Link to="/supply-approvals"><button type="button" style={{ fontSize: 12.5 }}>Open approvals</button></Link>}
              {st.key === "issue" && canScan && list.length > 0 && <Link to="/store"><button type="button" style={{ fontSize: 12.5 }}>Scan QR</button></Link>}
            </div>
            {list.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 10 }}>Nothing waiting.</div>
            ) : (
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table style={{ minWidth: st.key === "outside" ? 1000 : 760 }}>
                  <thead><tr><th>Ref</th><th>Vehicle / machine</th><th style={{ textAlign: "right" }}>Asked</th><th style={{ textAlign: "right" }}>Approved</th><th>Reading</th><th>Requested</th><th>Last fill</th>{st.key !== "approval" && <th>Station</th>}
                    {st.key === "outside" && <><th>Rate</th><th>Open for</th><th /></>}
                    {st.key === "issue" && canCancelApproved && <th />}</tr></thead>
                  <tbody>
                    {list.map((r) => (
                      <Fragment key={r.id}>
                      <tr>
                        <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>FR-{r.id}</td>
                        <td><b>{r.unit_label || "—"}</b><div style={{ fontSize: 11, color: "var(--slate)" }}>{r.unit_sub}</div></td>
                        <td style={{ textAlign: "right" }}>{fmtL(r.requested_quantity)}</td>
                        <td style={{ textAlign: "right" }}>{r.approved_quantity != null ? fmtL(r.approved_quantity) : "—"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.odometer_reading != null ? `${fmtNum(r.odometer_reading)} km` : r.hour_meter_reading != null ? `${fmtNum(r.hour_meter_reading, 1)} hrs` : "—"}</td>
                        <td style={{ fontSize: 12 }}>{fmtWhen(r.requested_at)}<div style={{ color: "var(--slate)" }}>{r.requested_by_name}</div></td>
                        <td style={{ fontSize: 12 }}>{r.last_fill_at ? <>{fmtWhen(r.last_fill_at)}<div style={{ color: "var(--slate)" }}>{fmtL(r.last_fill_qty)}</div></> : "—"}</td>
                        {st.key !== "approval" && <td style={{ fontSize: 12 }}>{r.station_name || "—"}</td>}
                        {st.key === "issue" && canCancelApproved && (
                          <td style={{ whiteSpace: "nowrap" }}>
                            {acting?.id !== r.id && <button type="button" style={{ fontSize: 12, padding: "6px 10px" }} onClick={() => { setNotice(""); setActing({ id: r.id, mode: "cancel-approved" }); }}>Cancel</button>}
                          </td>
                        )}
                        {st.key === "outside" && (
                          <>
                            <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{r.approved_rate != null ? `₹${r.approved_rate}/L` : "—"}</td>
                            <td style={{ fontSize: 11.5 }}><OpenFor hours={r.hours_open} />
                              <div style={{ color: "var(--slate)", marginTop: 3 }}>
                                {r.outside_escalated_at ? "Driver reminded · Manager told" : r.outside_reminded_at ? "Driver reminded" : "Waiting for the driver"}
                              </div>
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              {canClose && acting?.id !== r.id && <button type="button" className="btn-primary" style={{ fontSize: 12, padding: "6px 10px", marginRight: 6 }} onClick={() => { setNotice(""); setActing({ id: r.id, mode: "close" }); }}>Enter from bill</button>}
                              {(canCancel || canCancelApproved) && acting?.id !== r.id && <button type="button" style={{ fontSize: 12, padding: "6px 10px" }} onClick={() => { setNotice(""); setActing({ id: r.id, mode: canCancel ? "cancel" : "cancel-approved" }); }}>Not filled — cancel</button>}
                            </td>
                          </>
                        )}
                      </tr>
                      {acting?.id === r.id && (
                        <tr><td colSpan={10} style={{ background: "#FAF9F6" }}>
                          <CloseForm r={r} mode={acting.mode} onCancel={() => setActing(null)}
                            onDone={(msg) => { setActing(null); setNotice(msg); load(); }} />
                        </td></tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
