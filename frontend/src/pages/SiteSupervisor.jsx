import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount } from "../lib/offlineQueue.js";
import { TopBar } from "../lib/TopBar.jsx";

export default function SiteSupervisor() {
  const [deliveries, setDeliveries] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showReject, setShowReject] = useState(false);
  const [pending, setPending] = useState(pendingCount());
  const [error, setError] = useState("");

  // Deriving `selected` from the live `deliveries` list (rather than storing a
  // separate stale copy) is what fixes the "doesn't update until I refresh" bug —
  // every reload now automatically reflects the latest status for whichever
  // ticket is selected.
  const selected = deliveries.find((d) => d.id === selectedId) || deliveries[0] || null;

  async function load() {
    try {
      const rows = await apiRequest("/site-supervisor/my-deliveries");
      setDeliveries(rows);
      if (!selectedId && rows.length) setSelectedId(rows[0].id);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // Poll for updates every 15s too, in case someone else (e.g. Plant Operator/QC)
    // changes this ticket's status while the page is open.
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  async function act(path, body) {
    await queuedRequest(`/site-supervisor/${selected.id}/${path}`, { method: "POST", body });
    setPending(pendingCount());
    await load();
  }

  if (showReject && selected) {
    return (
      <RejectForm
        ticket={selected}
        onDone={() => { setShowReject(false); load(); }}
        onAct={act}
      />
    );
  }

  return (
    <>
      <TopBar title="Site Supervisor" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {!navigator.onLine && (
          <div style={{ textAlign: "center", fontSize: 12, background: "var(--amber-bg)", color: "var(--amber)", padding: 6, borderRadius: 8, marginBottom: 12 }}>
            No signal — actions are being saved and will sync automatically
          </div>
        )}
        {pending > 0 && <div style={{ textAlign: "center", fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>{pending} action(s) waiting to sync</div>}

        {deliveries.length > 1 && (
          <select
            value={selected?.id || ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            style={{ width: "100%", marginBottom: 12, padding: 8 }}
          >
            {deliveries.map((d) => (
              <option key={d.id} value={d.id}>
                {d.ticket_number} — {d.site_name} — {d.truck_number || "no truck"} · {d.driver_name || "no driver"}
              </option>
            ))}
          </select>
        )}

        {!selected ? (
          <div style={{ fontSize: 13, color: "var(--slate)", textAlign: "center", marginTop: 40 }}>No deliveries assigned today.</div>
        ) : (
          <div className="card" style={{ borderRadius: 20, padding: "20px 16px" }}>
            <div style={{ textAlign: "center", fontSize: 13, color: "var(--slate)" }}>{selected.site_name} &middot; {selected.ticket_number}</div>
            <div style={{ textAlign: "center", fontSize: 13, color: "var(--slate)", marginTop: 2 }}>
              {selected.truck_number || "No truck"} &middot; {selected.driver_name || "No driver"}
            </div>
            <div style={{ textAlign: "center", fontSize: 15, fontWeight: 600, margin: "4px 0 16px" }}>{statusLabel(selected.status)}</div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button disabled={selected.status !== "dispatched" && selected.status !== "created"} onClick={() => act("arrival")}>
                Confirm truck arrival
              </button>
              <button disabled={selected.status !== "reached_site"} onClick={() => act("unloading-start")}>
                Confirm unloading start
              </button>
              <button disabled={selected.status !== "unloading"}>
                Confirm unloading completion
              </button>
            </div>

            {selected.status === "unloading" && <CompleteForm onAct={act} />}

            <button
              className="btn-danger"
              style={{ width: "100%", marginTop: 16 }}
              onClick={() => setShowReject(true)}
            >
              Reject concrete
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function statusLabel(status) {
  return {
    created: "Awaiting arrival", batching: "Awaiting arrival", dispatched: "Awaiting arrival",
    reached_site: "Arrived, awaiting unload", unloading: "Unloading in progress",
    completed: "Unloading completed", rejected: "Rejected",
  }[status] || status;
}

function CompleteForm({ onAct }) {
  const [slump, setSlump] = useState("");
  const [noteStatus, setNoteStatus] = useState("pending");
  const [afterPourCare, setAfterPourCare] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setSaving(true); setError("");
    try {
      await onAct("unloading-complete", {
        site_slump_mm: slump,
        delivery_note_status: noteStatus,
        after_pour_care_confirmed: afterPourCare,
        remarks,
      });
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, fontSize: 13 }}>
      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Site slump (mm)</div>
      <input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Delivery note status</div>
      <select value={noteStatus} onChange={(e) => setNoteStatus(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
        <option value="pending">Pending</option>
        <option value="signed">Signed</option>
        <option value="refused">Refused</option>
      </select>

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={afterPourCare} onChange={(e) => setAfterPourCare(e.target.checked)} />
        <span>Guided customer on after-pour care (covering with plastic sheet, curing)</span>
      </label>

      <div style={{ color: "var(--slate)", marginBottom: 4 }}>Comments about this supply</div>
      <textarea
        rows={3}
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
        placeholder="Any notes about this delivery — site conditions, issues, customer requests, etc."
        style={{ width: "100%", marginBottom: 10 }}
      />

      {error && <div style={{ color: "var(--alert-red)", marginBottom: 8 }}>{error}</div>}
      <button onClick={submit} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving..." : "Save completion"}
      </button>
    </div>
  );
}

function RejectForm({ ticket, onAct, onDone }) {
  const [reasons, setReasons] = useState([]);
  const [reasonId, setReasonId] = useState("");
  const [slump, setSlump] = useState("");
  const [qty, setQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiRequest("/master/rejection-reasons").then(setReasons).catch(() => {});
  }, []);

  async function submit() {
    setSaving(true);
    await onAct("reject", {
      rejection_reason_id: reasonId || null,
      site_slump_mm: slump,
      rejected_quantity_m3: qty,
      remarks,
    });
    setSaving(false);
    onDone();
  }

  return (
    <>
      <TopBar title="Site Supervisor · Reject concrete" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Reject concrete</div>
        <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>{ticket.ticket_number} &middot; {ticket.site_name}</div>

        <div className="field-input" style={{ fontSize: 13 }}>
          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Reason for rejection</div>
          <select value={reasonId} onChange={(e) => setReasonId(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
            <option value="">Select</option>
            {reasons.map((r) => <option key={r.id} value={r.id}>{r.reason}</option>)}
          </select>

          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Measured site slump (mm)</div>
          <input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Quantity rejected (m³)</div>
          <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

          <div style={{ color: "var(--slate)", marginBottom: 4 }}>Comments</div>
          <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />

          <button className="btn-danger" onClick={submit} disabled={saving} style={{ width: "100%", marginBottom: 8 }}>
            {saving ? "Saving..." : "Confirm rejection"}
          </button>
          <button onClick={onDone} style={{ width: "100%" }}>Cancel</button>
        </div>
      </div>
    </>
  );
}
