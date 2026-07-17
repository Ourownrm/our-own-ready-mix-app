import { useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext.jsx";
import { apiRequest } from "../lib/api.js";
import { queuedRequest, pendingCount } from "../lib/offlineQueue.js";

export default function SiteSupervisor() {
  const { user, logout } = useAuth();
  const [deliveries, setDeliveries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showReject, setShowReject] = useState(false);
  const [pending, setPending] = useState(pendingCount());
  const [error, setError] = useState("");

  async function load() {
    try {
      const rows = await apiRequest("/site-supervisor/my-deliveries");
      setDeliveries(rows);
      if (!selected && rows.length) setSelected(rows[0]);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function act(path, body) {
    await queuedRequest(`/site-supervisor/${selected.id}/${path}`, { method: "POST", body });
    setPending(pendingCount());
    load();
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
    <div style={{ maxWidth: 320, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: "#666" }}>{user?.name}</div>
        <button onClick={logout} style={{ fontSize: 12, color: "#999", background: "none", border: "none" }}>Sign out</button>
      </div>

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {!navigator.onLine && (
        <div style={{ textAlign: "center", fontSize: 12, background: "#fff3cd", color: "#856404", padding: 6, borderRadius: 8, marginBottom: 12 }}>
          No signal — actions are being saved and will sync automatically
        </div>
      )}
      {pending > 0 && <div style={{ textAlign: "center", fontSize: 12, color: "#999", marginBottom: 12 }}>{pending} action(s) waiting to sync</div>}

      {deliveries.length > 1 && (
        <select
          value={selected?.id || ""}
          onChange={(e) => setSelected(deliveries.find((d) => d.id === Number(e.target.value)))}
          style={{ width: "100%", marginBottom: 12, padding: 8 }}
        >
          {deliveries.map((d) => (
            <option key={d.id} value={d.id}>{d.ticket_number} — {d.site_name}</option>
          ))}
        </select>
      )}

      {!selected ? (
        <div style={{ fontSize: 13, color: "#999", textAlign: "center", marginTop: 40 }}>No deliveries assigned today.</div>
      ) : (
        <div style={{ background: "#f5f5f5", borderRadius: 24, padding: "20px 16px" }}>
          <div style={{ textAlign: "center", fontSize: 13, color: "#666" }}>{selected.site_name} &middot; {selected.ticket_number}</div>
          <div style={{ textAlign: "center", fontSize: 15, fontWeight: 500, margin: "4px 0 16px" }}>{statusLabel(selected.status)}</div>

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
            style={{ width: "100%", marginTop: 16, color: "#c0392b", borderColor: "#c0392b" }}
            onClick={() => setShowReject(true)}
          >
            Reject concrete
          </button>
        </div>
      )}
    </div>
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
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    await onAct("unloading-complete", { site_slump_mm: slump, delivery_note_status: noteStatus });
    setSaving(false);
  }

  return (
    <div style={{ marginTop: 16, fontSize: 13 }}>
      <div style={{ color: "#666", marginBottom: 4 }}>Site slump (mm)</div>
      <input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
      <div style={{ color: "#666", marginBottom: 4 }}>Delivery note status</div>
      <select value={noteStatus} onChange={(e) => setNoteStatus(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
        <option value="pending">Pending</option>
        <option value="signed">Signed</option>
        <option value="refused">Refused</option>
      </select>
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
    <div style={{ maxWidth: 320, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ fontSize: 15, fontWeight: 500 }}>Reject concrete</div>
      <div style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>{ticket.ticket_number} &middot; {ticket.site_name}</div>

      <div style={{ fontSize: 13 }}>
        <div style={{ color: "#666", marginBottom: 4 }}>Reason for rejection</div>
        <select value={reasonId} onChange={(e) => setReasonId(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
          <option value="">Select</option>
          {reasons.map((r) => <option key={r.id} value={r.id}>{r.reason}</option>)}
        </select>

        <div style={{ color: "#666", marginBottom: 4 }}>Measured site slump (mm)</div>
        <input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

        <div style={{ color: "#666", marginBottom: 4 }}>Quantity rejected (m³)</div>
        <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

        <div style={{ color: "#666", marginBottom: 4 }}>Remarks</div>
        <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />

        <button onClick={submit} disabled={saving} style={{ width: "100%", background: "#c0392b", color: "#fff", marginBottom: 8 }}>
          {saving ? "Saving..." : "Confirm rejection"}
        </button>
        <button onClick={onDone} style={{ width: "100%" }}>Cancel</button>
      </div>
    </div>
  );
}
