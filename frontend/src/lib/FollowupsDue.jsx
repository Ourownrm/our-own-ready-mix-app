import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

const OUTCOME_LABEL = { won: "Won", lost: "Lost", closed: "Closed — not pursuing" };

// Compact inline control for "couldn't bag it" — resolves every open
// follow-up from the same visit at once (that's the actual unit of "did we
// get the deal or not", not any single reminder task). Leaving this alone
// entirely is exactly "still active, there's a chance" — no action needed
// to represent that, it's just what a pending follow-up already means.
function OutcomePicker({ visitId, onSaved }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [reasons, setReasons] = useState([]);
  const [reasonId, setReasonId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (outcome === "lost" || outcome === "closed") {
      apiRequest(`/sales/visit-outcome-reasons?outcome_type=${outcome}`).then(setReasons).catch(() => setReasons([]));
      setReasonId("");
    }
  }, [outcome]);

  async function save() {
    if (!outcome) return;
    if ((outcome === "lost" || outcome === "closed") && !reasonId) { setError("Pick a reason."); return; }
    setSaving(true); setError("");
    try {
      await apiRequest(`/sales/visits/${visitId}/outcome`, {
        method: "POST",
        body: { outcome, outcome_reason_id: reasonId || null, outcome_notes: notes || null },
      });
      setOpen(false);
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ fontSize: 10, padding: "2px 7px", color: "var(--slate)" }}>
        Didn't bag it? Update outcome
      </button>
    );
  }

  return (
    <div style={{ marginTop: 6, padding: 8, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
      {error && <div style={{ color: "var(--alert-red)", marginBottom: 6 }}>{error}</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        {["won", "lost", "closed"].map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => setOutcome(o)}
            style={{ fontSize: 11, padding: "3px 8px", background: outcome === o ? "var(--charcoal)" : undefined, color: outcome === o ? "#fff" : undefined, borderColor: outcome === o ? "var(--charcoal)" : undefined }}
          >
            {OUTCOME_LABEL[o]}
          </button>
        ))}
      </div>
      {(outcome === "lost" || outcome === "closed") && (
        <select value={reasonId} onChange={(e) => setReasonId(e.target.value)} style={{ width: "100%", marginBottom: 6, fontSize: 12 }}>
          <option value="">Select reason...</option>
          {reasons.map((r) => <option key={r.id} value={r.id}>{r.reason}</option>)}
        </select>
      )}
      {outcome && (
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          style={{ width: "100%", marginBottom: 6, fontSize: 12, padding: "5px 7px" }}
        />
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" disabled={!outcome || saving} onClick={save} style={{ fontSize: 11, padding: "3px 8px" }}>
          {saving ? "Saving..." : "Save outcome"}
        </button>
        <button type="button" onClick={() => setOpen(false)} style={{ fontSize: 11, padding: "3px 8px" }}>Cancel</button>
      </div>
    </div>
  );
}

// Groups by (date, customer) so several follow-ups for the same visit show
// as one header with sub-items underneath, instead of repeating the date
// and customer name on every single line.
function groupByDateCustomer(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.due_date}|${r.visited_name}|${r.site_name || ""}`;
    if (!groups.has(key)) {
      groups.set(key, { due_date: r.due_date, visited_name: r.visited_name, site_name: r.site_name, items: [] });
    }
    groups.get(key).items.push(r);
  }
  return [...groups.values()];
}

export default function FollowupsDue({ asUser }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function load() {
    try {
      setRows(await apiRequest(`/sales/followups${asUser ? `?as_user=${asUser}` : ""}`));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [asUser]);

  async function markDone(id) {
    setBusyId(id); setError("");
    try {
      await apiRequest(`/sales/followups/${id}/done`, { method: "POST" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const today = new Date().toDateString();
  const overdue = rows.filter((r) => new Date(r.due_date) < new Date(today));
  const dueToday = rows.filter((r) => new Date(r.due_date).toDateString() === today);
  const upcoming = rows.filter((r) => new Date(r.due_date) > new Date(today));

  function GroupBlock({ group, accentColor }) {
    // Items in one visual group usually all come from the same visit — the
    // outcome control operates on that visit's remaining open follow-ups, so
    // it's shown once per group rather than repeated per line item.
    const visitId = group.items[0]?.visit_id;
    return (
      <div style={{ borderLeft: `3px solid ${accentColor}`, background: "var(--concrete)", borderRadius: "0 8px 8px 0", padding: "8px 10px", marginBottom: 8, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {new Date(group.due_date).toLocaleDateString([], { day: "2-digit", month: "short" })} — {group.visited_name}{group.site_name ? ` — ${group.site_name}` : ""}
        </div>
        {group.items.map((r) => (
          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, padding: "3px 0 3px 10px" }}>
            <div>
              <div>{r.title}</div>
              {r.reason && <div style={{ color: "var(--slate)", fontSize: 11 }}>{r.reason}</div>}
            </div>
            <button style={{ fontSize: 11, padding: "3px 8px", whiteSpace: "nowrap" }} disabled={busyId === r.id} onClick={() => markDone(r.id)}>
              {busyId === r.id ? "..." : "Done"}
            </button>
          </div>
        ))}
        {visitId && (
          <div style={{ paddingLeft: 10 }}>
            <OutcomePicker visitId={visitId} onSaved={load} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Follow-ups due</div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing pending.</div>
      ) : (
        <>
          {overdue.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--alert-red)", marginBottom: 4 }}>Overdue ({overdue.length})</div>
              {groupByDateCustomer(overdue).map((g, i) => <GroupBlock key={i} group={g} accentColor="var(--alert-red)" />)}
            </>
          )}
          {dueToday.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--amber)", marginBottom: 4 }}>Today ({dueToday.length})</div>
              {groupByDateCustomer(dueToday).map((g, i) => <GroupBlock key={i} group={g} accentColor="var(--amber)" />)}
            </>
          )}
          {upcoming.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 4 }}>Upcoming ({upcoming.length})</div>
              {groupByDateCustomer(upcoming).map((g, i) => <GroupBlock key={i} group={g} accentColor="var(--slate)" />)}
            </>
          )}
        </>
      )}
    </div>
  );
}
