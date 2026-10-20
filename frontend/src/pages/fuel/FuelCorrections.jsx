// Round 220 (owner, 20 Oct 2026) — correcting the tank's history, Admin only.
// Deliveries were received in the app late (old ones all on one day), so the
// book went below zero and was "adjusted" to the physical count again and
// again. Here: put each delivery on its real date, void an adjustment that
// was not a physical count, and see every adjustment recalculated from its
// count before applying. Nothing is written until "Apply corrections".
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { fmtL, fmtNum, fmtWhen, fmtMonth } from "./fuelUi.jsx";

// ISO time → "YYYY-MM-DDTHH:mm" in IST for a datetime-local input, and back.
const toLocal = (iso) => (iso ? new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 16) : ""); // ist-ok: shifted to IST before slicing
const fromLocal = (v) => `${v}:00+05:30`;
const signedL = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNum(Math.abs(v))} L`);

export default function FuelCorrections() {
  const [dates, setDates] = useState({});      // purchase id → local datetime
  const [voids, setVoids] = useState(new Set());
  const [restores, setRestores] = useState(new Set());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const [log, setLog] = useState(null);
  const [showLog, setShowLog] = useState(false);

  const edits = useMemo(() => ({
    receipt_dates: Object.entries(dates).filter(([, v]) => v).map(([id, v]) => ({ id: Number(id), received_at: fromLocal(v) })),
    voids: [...voids], restores: [...restores],
  }), [dates, voids, restores]);
  const staged = edits.receipt_dates.length + edits.voids.length + edits.restores.length;

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      apiRequest("/fuel-module/corrections/preview", { method: "POST", body: edits })
        .then((d) => { if (alive) { setData(d); setError(""); } })
        .catch((e) => alive && setError(e.message));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [edits]);

  async function apply() {
    setBusy(true); setError(""); setNotice("");
    try {
      const out = await apiRequest("/fuel-module/corrections/apply", { method: "POST", body: { ...edits, reason } });
      setNotice(`Corrections applied — ${out.rows_changed} entr${out.rows_changed === 1 ? "y" : "ies"} updated. Tank book stock now ${fmtL(out.closing, 1)}.`);
      setDates({}); setVoids(new Set()); setRestores(new Set()); setReason(""); setLog(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  function toggleVoid(a) {
    if (a.voided && !a.voided_now) { // voided before: restore
      setRestores((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; });
    } else if (a.restored_now) {
      setRestores((s) => { const n = new Set(s); n.delete(a.id); return n; });
    } else {
      setVoids((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; });
    }
  }

  useEffect(() => { if (showLog && !log) apiRequest("/fuel-module/corrections/log").then(setLog).catch((e) => setError(e.message)); }, [showLog, log]);

  if (!data) return <div className="card" style={{ fontSize: 13, color: error ? "var(--alert-red)" : "var(--slate)" }}>{error || "Loading…"}</div>;

  const pending = data.changed > 0;
  const big = data.adjustments.filter((a) => !a.voided && Math.abs(a.new_change) >= 1000);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h1 style={{ fontSize: 21, margin: 0 }}>Fuel corrections</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4, lineHeight: 1.55, maxWidth: 920 }}>
          For deliveries received in the app later than they came. <b>1.</b> Put each delivery on the date it really arrived.
          <b> 2.</b> Void an adjustment that was not a physical count (for example one made to reverse earlier adjustments).
          <b> 3.</b> Every other adjustment is a physical count — its change is worked out again as <i>counted − book stock just before it</i>.
          Check the preview below, then apply. Today&rsquo;s stock follows the last physical count.
        </div>
      </div>

      {notice && <div style={{ background: "var(--signal-green-bg)", color: "var(--signal-green)", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>{notice}</div>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}

      {/* Result strip */}
      <section className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          {[
            ["Changes staged", staged ? `${staged}` : "None", staged ? "not saved yet" : "edit dates or void below", staged ? "var(--rebar)" : "var(--slate)"],
            ["Entries that would change", fmtNum(data.changed), pending ? "dates, adjustments or running balances" : "book is in step with the counts", pending ? "var(--amber)" : "var(--signal-green)"],
            ["Tank book stock now → after", `${fmtL(data.current_qty, 1)} → ${fmtL(data.closing_after, 1)}`, "follows the last physical count", "var(--charcoal)"],
            ["Lowest book stock after", data.lowest ? fmtL(data.lowest.balance, 1) : "—", data.lowest ? (data.lowest.balance < 0 ? `on ${data.lowest.day} — a delivery is still missing or late` : `on ${data.lowest.day}`) : "", data.lowest?.balance < 0 ? "var(--alert-red)" : "var(--charcoal)"],
          ].map(([l, v, sub, c]) => (
            <div key={l} style={{ padding: "13px 16px", borderRight: "1px solid var(--border)" }}>
              <div className="kpi-label">{l}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 3, color: c }}>{v}</div>
              <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{sub}</div>
            </div>
          ))}
        </div>
      </section>
      {data.errors?.length > 0 && <div style={{ background: "var(--alert-red-bg)", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>{data.errors.join(" ")}</div>}

      {/* 1. Deliveries */}
      <section className="card">
        <div style={{ fontSize: 15, fontWeight: 700 }}>1 · Delivery dates</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2, marginBottom: 8 }}>
          Set the date and time the diesel really came. Request and approval dates are shown to help; several deliveries received in the app on the same day are highlighted.
        </div>
        <BunchedButton receipts={data.receipts} dates={dates} setDates={setDates} />
        <ReceiptTable receipts={data.receipts} dates={dates} setDates={setDates} />
      </section>

      {/* 2 + 3. Adjustments */}
      <section className="card">
        <div style={{ fontSize: 15, fontWeight: 700 }}>2 · Adjustments — void, and the recalculated change</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2, marginBottom: 8 }}>
          Newest first. <b>Counted</b> is what the tank held when the adjustment was made; <b>book before</b> is the stock the app would show just before it, with the dates above.
        </div>
        {big.length > 0 && <div style={{ background: "var(--amber-bg)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 8 }}>
          {big.length} adjustment{big.length === 1 ? " is" : "s are"} still 1,000 L or more after recalculation — usually a delivery that is still on the wrong date, or an adjustment that was not a physical count.
        </div>}
        <div style={{ overflowX: "auto" }}>
          <table style={{ minWidth: 900, fontSize: 12.5 }}>
            <thead><tr><th>Ref</th><th>When</th><th>Reason · by</th><th style={{ textAlign: "right" }}>Counted</th><th style={{ textAlign: "right" }}>Book before</th>
              <th style={{ textAlign: "right" }}>Entered as</th><th style={{ textAlign: "right" }}>Now</th><th style={{ textAlign: "right" }}>After correction</th><th /></tr></thead>
            <tbody>
              {data.adjustments.map((a) => {
                const changes = a.voided !== (a.voided_now ? false : a.voided) || a.new_change !== a.current_change;
                return (
                  <tr key={a.id} style={{ opacity: a.voided ? 0.6 : 1, background: a.voided_now || a.restored_now ? "#FFF1E6" : a.new_change !== a.current_change ? "#FFF8F2" : undefined }}>
                    <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{a.ref}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(a.at)}</td>
                    <td style={{ fontSize: 11.5, color: "var(--slate)", maxWidth: 240 }}>{a.note || "—"}{a.by ? ` · ${a.by}` : ""}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(a.counted)}</td>
                    <td style={{ textAlign: "right", color: "var(--slate)" }}>{a.voided ? "—" : fmtNum(a.book_before)}</td>
                    <td style={{ textAlign: "right", color: "var(--slate)" }}>{signedL(a.entered_change)}</td>
                    <td style={{ textAlign: "right" }}>{signedL(a.current_change)}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: a.voided ? "var(--slate)" : a.new_change < 0 ? "var(--alert-red)" : "var(--signal-green)" }}>
                      {a.voided ? "voided" : signedL(a.new_change)}{changes && !a.voided ? " •" : ""}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => toggleVoid(a)}>
                        {a.voided_now ? "Undo void" : a.restored_now ? "Undo restore" : a.voided ? "Restore" : "Void"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {data.adjustments.length === 0 && <tr><td colSpan={9} style={{ color: "var(--slate)" }}>No adjustments.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {/* Month effect */}
      <section className="card">
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>3 · What changes by month</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ minWidth: 640, fontSize: 12.5 }}>
            <thead><tr><th>Month</th><th style={{ textAlign: "right" }}>Delivered now → after</th><th style={{ textAlign: "right" }}>Issued from tank</th><th style={{ textAlign: "right" }}>Adjustments net now → after</th></tr></thead>
            <tbody>
              {data.months.filter((m) => m.before.received || m.after.received || m.before.adj_net || m.after.adj_net || m.before.issued).slice(-8).map((m) => {
                const dr = m.before.received !== m.after.received, da = m.before.adj_net !== m.after.adj_net;
                return (
                  <tr key={m.month}>
                    <td style={{ fontWeight: 600 }}>{fmtMonth(m.month)}</td>
                    <td style={{ textAlign: "right", fontWeight: dr ? 700 : 400 }}>{fmtNum(m.before.received)}{dr ? ` → ${fmtNum(m.after.received)}` : ""} L</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(m.after.issued)} L</td>
                    <td style={{ textAlign: "right", fontWeight: da ? 700 : 400 }}>{signedL(m.before.adj_net)}{da ? ` → ${signedL(m.after.adj_net)}` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>A net fall from adjustments is reported as fuel issued, a net rise as stock added (Cost dashboard and stock statement).</div>
      </section>

      {/* Apply */}
      <section className="card field-input" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", position: "sticky", bottom: 52, zIndex: 2, boxShadow: "0 -2px 12px rgba(34,38,43,.08)" }}>
        <label style={{ fontSize: 12, color: "var(--slate)", flex: "1 1 320px" }}>Reason (kept in the corrections log)
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sept–Oct deliveries received late; put on their real dates" style={{ display: "block", marginTop: 4, width: "100%" }} />
        </label>
        <button type="button" onClick={() => { setDates({}); setVoids(new Set()); setRestores(new Set()); }} disabled={!staged}>Clear staged changes</button>
        <button type="button" className="btn-primary" disabled={busy || !pending || !reason.trim() || data.errors?.length > 0} onClick={apply}>
          {busy ? "Applying…" : `Apply corrections (${fmtNum(data.changed)} entries)`}
        </button>
      </section>

      <div>
        <button type="button" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide" : "Show"} corrections log</button>
        {showLog && (
          <div className="card" style={{ marginTop: 8, overflowX: "auto" }}>
            {!log ? "Loading…" : log.length === 0 ? <span style={{ fontSize: 13, color: "var(--slate)" }}>Nothing corrected yet.</span> : (
              <table style={{ minWidth: 700, fontSize: 12 }}>
                <thead><tr><th>Batch</th><th>When · by</th><th>What</th><th>Old → new</th><th>Reason</th></tr></thead>
                <tbody>{log.map((l, i) => (
                  <tr key={i}><td>#{l.batch_id}</td><td>{fmtWhen(l.done_at)} · {l.by_name || "—"}</td>
                    <td>{{ receipt_date: `Date of FPR-${l.ref_id}`, void: `Voided ADJ-${l.ref_id}`, restore: `Restored ADJ-${l.ref_id}`, recalc: `Recalculated ADJ-${l.ref_id}`, balance: "Tank balance" }[l.kind] || l.kind}</td>
                    <td>{l.kind === "receipt_date" ? `${fmtWhen(l.old_value)} → ${fmtWhen(l.new_value)}` : `${l.old_value} → ${l.new_value}`}</td>
                    <td style={{ color: "var(--slate)" }}>{l.reason}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReceiptTable({ receipts, dates, setDates }) {
  // Deliveries received in the app on the same day as two or more others.
  const sameDay = useMemo(() => {
    const c = new Map();
    for (const r of receipts) { const k = toLocal(r.received_at).slice(0, 10); c.set(k, (c.get(k) || 0) + 1); }
    return c;
  }, [receipts]);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ minWidth: 900, fontSize: 12.5 }}>
        <thead><tr><th>Ref</th><th>Supplier</th><th style={{ textAlign: "right" }}>Litres</th><th>Requested</th><th>Approved</th><th>Received in the app</th><th>Real date &amp; time</th><th /></tr></thead>
        <tbody>
          {receipts.map((r) => {
            const bunched = sameDay.get(toLocal(r.received_at).slice(0, 10)) >= 3;
            const v = dates[r.id] ?? "";
            return (
              <tr key={r.id} style={{ background: v ? "#FFF1E6" : bunched ? "var(--amber-bg)" : undefined }}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{r.ref}</td>
                <td>{r.supplier || "—"}</td>
                <td style={{ textAlign: "right" }}>{fmtNum(r.litres)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.requested_at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.approved_at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.received_at)}{r.original_received_at && <div style={{ fontSize: 11, color: "var(--slate)" }}>corrected · first entered {fmtWhen(r.original_received_at)}</div>}</td>
                <td className="field-input" style={{ minWidth: 200 }}>
                  <input type="datetime-local" value={v} max={toLocal(new Date().toISOString())} onChange={(e) => setDates((d) => ({ ...d, [r.id]: e.target.value }))} />
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {!v && r.approved_at && <button type="button" style={{ fontSize: 11.5, padding: "4px 8px" }} title="Use the approval date and time"
                    onClick={() => setDates((d) => ({ ...d, [r.id]: toLocal(r.approved_at) }))}>Use approval date</button>}
                  {v && <button type="button" style={{ fontSize: 11.5, padding: "4px 8px" }} onClick={() => setDates((d) => { const n = { ...d }; delete n[r.id]; return n; })}>Undo</button>}
                </td>
              </tr>
            );
          })}
          {receipts.length === 0 && <tr><td colSpan={8} style={{ color: "var(--slate)" }}>No deliveries received yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// Deliveries received in the app on a day with two others or more, received
// at least a day after they were approved: offer their approval dates at once.
function BunchedButton({ receipts, dates, setDates }) {
  const counts = new Map();
  for (const r of receipts) { const k = toLocal(r.received_at).slice(0, 10); counts.set(k, (counts.get(k) || 0) + 1); }
  const list = receipts.filter((r) => r.approved_at && !dates[r.id]
    && (counts.get(toLocal(r.received_at).slice(0, 10)) >= 3 || new Date(r.received_at) - new Date(r.approved_at) > 3 * 86400000)
    && new Date(r.received_at) - new Date(r.approved_at) > 86400000);
  if (!list.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", background: "var(--amber-bg)", borderRadius: 8, padding: "8px 10px", marginBottom: 8, fontSize: 12.5 }}>
      <span>{list.length} deliver{list.length === 1 ? "y was" : "ies were"} received in the app a day or more after approval ({list.map((r) => r.ref).join(", ")}).</span>
      <button type="button" style={{ fontSize: 12, padding: "5px 10px" }}
        onClick={() => setDates((d) => ({ ...d, ...Object.fromEntries(list.map((r) => [r.id, toLocal(r.approved_at)])) }))}>
        Use their approval dates
      </button>
      <span style={{ color: "var(--slate)" }}>then change any you know more exactly.</span>
    </div>
  );
}
