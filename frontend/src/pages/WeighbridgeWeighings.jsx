// Round 269 — Weighbridge › Weighings: weighing a lorry from the app (mockup
// "Weighbridge ticket from the app", artboards 1–3; no photos, per the owner).
//
// The live weight comes from the indicator agent on the weighbridge PC and is
// never typed. First weight opens a ticket (WB-A-…); the second weight closes
// it and the ticket then appears under Receipts like any SmartWeigh ticket,
// ready for Record receipt.
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { printSlip, PURPOSE_LABEL } from "../lib/weighSlipPrint.js";

const kg = (v) => (v == null ? "—" : `${Number(v).toLocaleString("en-IN")} kg`);
const t = (ts) => (ts ? new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
const d = (ts) => (ts ? new Date(ts).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }) : "");
const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function since(ts) {
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const PURPOSE_TONE = { raw_in: ["var(--info-bg)", "var(--info)"], rmc_out: ["var(--amber-bg)", "var(--amber)"], internal: ["#EEF1F5", "#334155"], outside: ["var(--violet-bg)", "var(--violet)"] };
function PurposeChip({ p }) {
  const [bg, fg] = PURPOSE_TONE[p] || ["#eee", "#333"];
  return <span style={{ background: bg, color: fg, borderRadius: 6, padding: "2px 7px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{PURPOSE_LABEL[p] || p}</span>;
}

// Polls the live reading once a second while the screen is visible.
function useLive() {
  const [live, setLive] = useState(null);
  useEffect(() => {
    let stop = false;
    async function tick() {
      if (stop) return;
      if (!document.hidden) {
        try { setLive(await apiRequest("/weighbridge/live")); } catch { setLive((l) => (l ? { ...l, connected: false, ready: false } : { connected: false })); }
      }
      if (!stop) setTimeout(tick, 1000);
    }
    tick();
    return () => { stop = true; };
  }, []);
  return live;
}

function LiveCard({ live, big, action }) {
  const ok = live?.connected;
  return (
    <div style={{ background: "var(--charcoal)", color: "#fff", borderRadius: 12, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontSize: 12, color: "#D8D4CB" }}>Live on the weighbridge</div>
        <div style={{ fontSize: big ? 42 : 34, fontWeight: 800, lineHeight: 1.1 }} aria-live="polite">
          {ok && live.kg != null ? Number(live.kg).toLocaleString("en-IN") : "— —"} <span style={{ fontSize: 16, fontWeight: 600 }}>kg</span>
        </div>
        <div style={{ fontSize: 12.5, color: !ok ? "#F3B7AE" : live.stable ? "#9FD9BF" : "#F5D58C", marginTop: 2 }}>
          {!live ? "Connecting…" : !ok ? "● Indicator offline — start indicator.js on the weighbridge PC" : live.stable ? "● Stable — ready to capture" : "● Moving — wait for it to settle"}
        </div>
      </div>
      {action}
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>
      {label}{children}{hint && <span style={{ fontWeight: 400 }}>{hint}</span>}
    </label>
  );
}

function FirstWeight({ live, opts, onDone, onCancel }) {
  const [f, setF] = useState({ purpose: "raw_in", vehicle: "", rm_order_id: "", material_id: "", supplier_id: "", challan_no: "", challan_qty: "", driver_name: "", delivery_ticket_id: "", party_name: "", charge_amount: "", charge_mode: "cash", remarks: "" });
  const [veh, setVeh] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (f.vehicle.replace(/\W/g, "").length < 4) { setVeh(null); return; }
    timer.current = setTimeout(async () => {
      try {
        const v = await apiRequest(`/weighbridge/vehicle-lookup?reg=${encodeURIComponent(f.vehicle)}`);
        setVeh(v);
        if (v.found && v.supplier_id && !f.supplier_id && !f.rm_order_id) setF((x) => ({ ...x, supplier_id: String(v.supplier_id) }));
      } catch { setVeh(null); }
    }, 400);
    return () => clearTimeout(timer.current);
  }, [f.vehicle]); // eslint-disable-line react-hooks/exhaustive-deps

  const order = opts.orders.find((o) => String(o.id) === String(f.rm_order_id));
  const material = opts.materials.find((m) => String(m.id) === String(order ? order.material_id : f.material_id));
  const ordersForSupplier = opts.orders.filter((o) => !f.supplier_id || String(o.supplier_id) === String(f.supplier_id));
  const heavier = veh?.last_tare_kg && live?.kg ? live.kg > veh.last_tare_kg + 500 : null;

  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const out = await apiRequest("/weighbridge/weighings", { method: "POST", body: { ...f, expect_kg: live?.kg } });
      onDone(`Ticket ${out.ticket_no} opened at ${Number(out.kg).toLocaleString("en-IN")} kg.`);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="card" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
      <div style={{ fontWeight: 700, fontSize: 16 }}>New weighing — first weight</div>
      <LiveCard live={live} big />
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Purpose</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {Object.entries(PURPOSE_LABEL).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setF({ ...f, purpose: k })} aria-pressed={f.purpose === k}
            style={{ minHeight: 44, borderRadius: 8, fontSize: 13.5, fontWeight: f.purpose === k ? 700 : 500,
              border: f.purpose === k ? "2px solid var(--rebar)" : "1px solid var(--border-strong)", background: f.purpose === k ? "#FBF0E7" : "#fff" }}>
            {label}
          </button>
        ))}
      </div>
      <Field label="Vehicle number">
        <input className="field-input" value={f.vehicle} onChange={set("vehicle")} placeholder="KL14 X 4231" required style={{ fontSize: 15, fontWeight: 700 }} />
      </Field>
      {veh?.found && (
        <div style={{ fontSize: 12, color: veh.open_ticket ? "var(--alert-red)" : "var(--signal-green)", marginTop: -6 }}>
          {veh.open_ticket ? `Already on open ticket ${veh.open_ticket.ticket_no} — take its second weight instead.`
            : <>Known vehicle{veh.truck_number ? ` · our ${veh.truck_number}` : ""}{veh.supplier_name ? ` · ${veh.supplier_name}` : ""}{veh.last_tare_kg ? ` · last tare ${Number(veh.last_tare_kg).toLocaleString("en-IN")} kg (${d(veh.last_tare_at)})` : ""}</>}
        </div>
      )}

      {f.purpose === "raw_in" && (
        <>
          <Field label="Supplier">
            <select className="field-input" value={order ? order.supplier_id : f.supplier_id} disabled={!!order} onChange={set("supplier_id")}>
              <option value="">Choose…</option>
              {opts.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Purchase order (sets material and supplier)">
            <select className="field-input" value={f.rm_order_id} onChange={set("rm_order_id")}>
              <option value="">No PO — choose the material below</option>
              {ordersForSupplier.map((o) => <option key={o.id} value={o.id}>PO-{String(o.id).padStart(4, "0")} · {o.material_name} · {o.supplier_name}</option>)}
            </select>
          </Field>
          {!order && (
            <Field label="Material">
              <select className="field-input" value={f.material_id} onChange={set("material_id")}>
                <option value="">Choose…</option>
                {opts.materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
            <Field label="Supplier challan no."><input className="field-input" value={f.challan_no} onChange={set("challan_no")} /></Field>
            <Field label={`Challan qty${material ? ` (${material.purchase_unit})` : ""}`}><input className="field-input" inputMode="decimal" value={f.challan_qty} onChange={set("challan_qty")} /></Field>
          </div>
        </>
      )}
      {f.purpose === "rmc_out" && (
        <Field label="Delivery ticket (optional)">
          <select className="field-input" value={f.delivery_ticket_id} onChange={set("delivery_ticket_id")}>
            <option value="">—</option>
            {opts.delivery_tickets.map((t2) => <option key={t2.id} value={t2.id}>{t2.ticket_number} · {t2.truck_number || ""} · {t2.customer_name || ""}</option>)}
          </select>
        </Field>
      )}
      {f.purpose === "internal" && (
        <Field label="Material (optional)">
          <select className="field-input" value={f.material_id} onChange={set("material_id")}>
            <option value="">—</option>
            {opts.materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      )}
      {f.purpose === "outside" && (
        <>
          <Field label="Party name"><input className="field-input" value={f.party_name} onChange={set("party_name")} required /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
            <Field label="Charge ₹"><input className="field-input" inputMode="decimal" value={f.charge_amount} onChange={set("charge_amount")} /></Field>
            <Field label="Paid by">
              <select className="field-input" value={f.charge_mode} onChange={set("charge_mode")}>
                <option value="cash">Cash</option><option value="upi">UPI</option><option value="credit">Credit</option>
              </select>
            </Field>
          </div>
        </>
      )}
      <Field label="Driver"><input className="field-input" value={f.driver_name} onChange={set("driver_name")} /></Field>
      <Field label="Remarks"><input className="field-input" value={f.remarks} onChange={set("remarks")} placeholder="Optional" /></Field>
      {heavier != null && (
        <div style={{ background: "var(--amber-bg)", color: "#7A520C", borderRadius: 10, padding: "10px 12px", fontSize: 12.5 }}>
          This looks like the <b>{heavier ? "loaded" : "empty"}</b> weight (against this lorry's last tare). The second weighing gives the other one and the net.
        </div>
      )}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className="btn-primary" disabled={busy || !live?.ready || veh?.open_ticket} style={{ minHeight: 50, flex: "1 1 240px", fontSize: 15.5 }}>
          {live?.ready ? `Capture ${Number(live.kg).toLocaleString("en-IN")} kg · open ticket` : "Waiting for a stable weight…"}
        </button>
        <button type="button" onClick={onCancel} style={{ minHeight: 50 }}>Back</button>
      </div>
    </form>
  );
}

function SecondWeight({ live, ticket, canEdit, onDone, onCancel }) {
  const [remarks, setRemarks] = useState(ticket.remarks || "");
  const [challanQty, setChallanQty] = useState(ticket.challan_qty ?? "");
  const [printAfter, setPrintAfter] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const now = live?.connected ? live.kg : null;
  const gross = now != null ? Math.max(now, ticket.first_kg) : null;
  const tare = now != null ? Math.min(now, ticket.first_kg) : null;
  const net = gross != null ? gross - tare : null;
  const billedKg = ticket.purpose === "raw_in" && challanQty && ticket.kg_per_unit ? Math.round(Number(challanQty) * ticket.kg_per_unit) : null;

  async function close() {
    setErr(""); setBusy(true);
    try {
      const out = await apiRequest(`/weighbridge/weighings/${ticket.id}/second`, { method: "POST", body: { expect_kg: now, remarks, challan_qty: challanQty } });
      if (printAfter) printSlip(out.ticket);
      onDone(`${ticket.ticket_no} closed — net ${Number(out.ticket.net_kg).toLocaleString("en-IN")} kg.${ticket.purpose === "raw_in" ? " It is now under Receipts, ready for Record receipt." : ""}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function cancel() {
    setErr(""); setBusy(true);
    try {
      await apiRequest(`/weighbridge/weighings/${ticket.id}/cancel`, { method: "POST", body: { reason } });
      onDone(`${ticket.ticket_no} cancelled.`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{ticket.ticket_no} — second weight</div>
        <span className="badge badge-warning">Open · {since(ticket.first_at)}</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>
        <b style={{ fontSize: 15 }}>{ticket.vehicle_text}</b> <PurposeChip p={ticket.purpose} />
        <div style={{ color: "var(--slate)" }}>
          {[ticket.material_name || ticket.material_text, ticket.supplier_name, ticket.party_name, ticket.dt_number,
            ticket.challan_no ? `challan ${ticket.challan_no}` : null, ticket.rm_order_id ? `PO-${String(ticket.rm_order_id).padStart(4, "0")}` : null,
            ticket.driver_name ? `driver ${ticket.driver_name}` : null].filter(Boolean).join(" · ")}
        </div>
      </div>
      <LiveCard live={live} big />
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <tbody>
          <tr><td style={{ padding: "5px 0", color: "var(--slate)" }}>1st weight ({t(ticket.first_at)})</td><td style={{ textAlign: "right" }}>{kg(ticket.first_kg)}</td></tr>
          <tr><td style={{ padding: "5px 0", color: "var(--slate)" }}>2nd weight (now)</td><td style={{ textAlign: "right" }}>{kg(now)}</td></tr>
          <tr><td style={{ padding: "8px 0", fontWeight: 700, borderTop: "1px solid var(--border)" }}>Net</td>
            <td style={{ textAlign: "right", fontWeight: 800, fontSize: 20, borderTop: "1px solid var(--border)" }}>{kg(net)}</td></tr>
          {billedKg != null && net != null && (
            <tr><td style={{ padding: "5px 0", color: "var(--slate)" }}>Against challan ({billedKg.toLocaleString("en-IN")} kg)</td>
              <td style={{ textAlign: "right", fontWeight: 700, color: net < billedKg ? "var(--alert-red)" : "var(--signal-green)" }}>
                {net - billedKg > 0 ? "+" : ""}{(net - billedKg).toLocaleString("en-IN")} kg</td></tr>
          )}
        </tbody>
      </table>
      {ticket.purpose === "raw_in" && (
        <Field label={`Challan qty${ticket.purchase_unit ? ` (${ticket.purchase_unit})` : ""}`}>
          <input className="field-input" inputMode="decimal" value={challanQty} onChange={(e) => setChallanQty(e.target.value)} />
        </Field>
      )}
      <Field label="Remarks"><input className="field-input" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" /></Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
        <input type="checkbox" checked={printAfter} onChange={(e) => setPrintAfter(e.target.checked)} /> Print the slip after closing
      </label>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn-primary" onClick={close} disabled={busy || !live?.ready} style={{ minHeight: 50, flex: "1 1 240px", fontSize: 15.5 }}>
          {live?.ready ? `Capture ${Number(live.kg).toLocaleString("en-IN")} kg · close ticket` : "Waiting for a stable weight…"}
        </button>
        <button type="button" onClick={onCancel} style={{ minHeight: 50 }}>Back</button>
      </div>
      {canEdit && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          {!cancelling ? (
            <button type="button" onClick={() => setCancelling(true)} style={{ fontSize: 12.5, color: "var(--alert-red)" }}>Cancel this ticket…</button>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Field label="Reason for cancelling"><input className="field-input" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} /></Field>
              <button type="button" onClick={cancel} disabled={busy || !reason.trim()} style={{ color: "var(--alert-red)" }}>Cancel ticket</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function WeighbridgeWeighings({ canCreate, canEdit }) {
  const live = useLive();
  const [data, setData] = useState(null);
  const [opts, setOpts] = useState(null);
  const [date, setDate] = useState(todayIst());
  const [mode, setMode] = useState(null); // null | "first" | ticket (second)
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    try { setData(await apiRequest(`/weighbridge/weighings?date=${date}`)); setErr(""); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (canCreate) apiRequest("/weighbridge/weighing-options").then(setOpts).catch((e) => setErr(e.message));
  }, [canCreate]);

  function done(msg) { setMode(null); setNotice(msg); load(); window.scrollTo(0, 0); }

  const s = data?.summary;
  const tiles = useMemo(() => s ? [
    ["Open — waiting 2nd weight", s.open, "var(--amber)"],
    ["Closed", s.closed, null],
    ["Raw material in (net)", `${(Number(s.net_in_kg) / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} t`, null],
    ["Short against challan", s.short, s.short ? "var(--alert-red)" : null],
  ] : [], [s]);

  if (mode === "first" && opts) return <FirstWeight live={live} opts={opts} onDone={done} onCancel={() => setMode(null)} />;
  if (mode && mode.id) return <SecondWeight live={live} ticket={mode} canEdit={canEdit} onDone={done} onCancel={() => setMode(null)} />;

  const th = { padding: "7px 8px", borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--slate)", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" };
  const td = { padding: "9px 8px", borderBottom: "1px solid #EEEAE2", verticalAlign: "top" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {notice && <div className="card" role="status" style={{ background: "var(--signal-green-bg)", color: "var(--signal-green)", fontSize: 13.5, fontWeight: 600 }}>{notice}</div>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>
        <div style={{ flex: "1 1 320px" }}>
          <LiveCard live={live} action={canCreate && (
            <button type="button" className="btn-primary" disabled={!opts} onClick={() => { setNotice(""); setMode("first"); }} style={{ minHeight: 44 }}>+ New weighing</button>
          )} />
        </div>
        {tiles.map(([label, value, colour]) => (
          <div key={label} className="card" style={{ flex: "1 1 140px", margin: 0 }}>
            <div style={{ fontSize: 12, color: "var(--slate)" }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: colour || "var(--charcoal)" }}>{value}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ margin: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Open tickets — first weight taken</div>
        {!data ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : !data.open.length ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>No lorry is waiting for its second weight.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr><th style={th}>Ticket</th><th style={th}>Vehicle</th><th style={th}>Purpose</th><th style={th}>Material · supplier / party</th><th style={{ ...th, textAlign: "right" }}>1st weight</th><th style={th}>In since</th><th style={th}></th></tr></thead>
              <tbody>
                {data.open.map((r) => {
                  const old = Date.now() - new Date(r.first_at).getTime() > 4 * 3600 * 1000;
                  return (
                    <tr key={r.id}>
                      <td style={{ ...td, fontWeight: 700 }}>{r.ticket_no}</td>
                      <td style={td}>{r.vehicle_text}{r.truck_number ? <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.truck_number}</div> : null}</td>
                      <td style={td}><PurposeChip p={r.purpose} /></td>
                      <td style={td}>{[r.material_name || r.material_text, r.supplier_name || r.party_name, r.dt_number].filter(Boolean).join(" · ") || "—"}</td>
                      <td style={{ ...td, textAlign: "right" }}>{kg(r.first_kg)}</td>
                      <td style={{ ...td, color: old ? "var(--alert-red)" : undefined, fontWeight: old ? 600 : 400 }}>{d(r.first_at)} {t(r.first_at)} · {since(r.first_at)}</td>
                      <td style={td}>{canCreate && <button type="button" onClick={() => { setNotice(""); setMode(r); }}>Take 2nd weight</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>Closed and cancelled</div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>Date
            <input type="date" className="field-input" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value || todayIst())} />
          </label>
        </div>
        {!data ? null : !data.closed.length ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing on this day.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr><th style={th}>Ticket</th><th style={th}>Vehicle</th><th style={th}>Purpose</th><th style={th}>Material · supplier / party</th>
                <th style={{ ...th, textAlign: "right" }}>Gross</th><th style={{ ...th, textAlign: "right" }}>Tare</th><th style={{ ...th, textAlign: "right" }}>Net</th>
                <th style={{ ...th, textAlign: "right" }}>vs challan</th><th style={th}></th></tr></thead>
              <tbody>
                {data.closed.map((r) => (
                  <tr key={r.id} style={r.status === "cancelled" ? { opacity: 0.6 } : undefined}>
                    <td style={{ ...td, fontWeight: 700 }}>{r.ticket_no}<div style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>{t(r.second_at || r.cancelled_at)}</div></td>
                    <td style={td}>{r.vehicle_text}</td>
                    <td style={td}><PurposeChip p={r.purpose} /></td>
                    <td style={td}>{[r.material_name || r.material_text, r.supplier_name || r.party_name, r.dt_number].filter(Boolean).join(" · ") || "—"}
                      {r.status === "cancelled" && <div style={{ fontSize: 11.5, color: "var(--alert-red)" }}>Cancelled: {r.cancel_reason}</div>}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.gross_kg != null ? Number(r.gross_kg).toLocaleString("en-IN") : "—"}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.tare_kg != null ? Number(r.tare_kg).toLocaleString("en-IN") : "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{kg(r.net_kg)}</td>
                    <td style={{ ...td, textAlign: "right", color: r.variance?.short ? "var(--alert-red)" : "var(--slate)", fontWeight: r.variance?.short ? 700 : 400 }}>
                      {r.variance ? `${r.variance.diff_kg > 0 ? "+" : ""}${r.variance.diff_kg.toLocaleString("en-IN")} kg` : "—"}</td>
                    <td style={td}><button type="button" onClick={() => printSlip(r)} style={{ fontSize: 12.5 }}>Slip</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>
          A closed raw-material ticket also appears under Receipts as {"WB-A-…"} and can be picked in Raw Material › Record receipt, like a SmartWeigh ticket.
        </div>
      </div>
    </div>
  );
}
