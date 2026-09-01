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

// Round 115 — a visit can generate several follow-up items at once (e.g.
// "call back to check decision" + "send revised quotation"). Those are now
// clubbed into one thread per visit instead of scattering across separate
// date-based rows, so the rep sees everything owed to that customer/visit
// in one place, with each item's own urgency and its own action log.
function groupByVisit(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.visit_id)) {
      groups.set(r.visit_id, { visit_id: r.visit_id, visited_name: r.visited_name, site_name: r.site_name, visit_date: r.visit_date, items: [] });
    }
    groups.get(r.visit_id).items.push(r);
  }
  return [...groups.values()];
}

function dayDiff(dueDate) {
  const due = new Date(dueDate);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

function urgency(dueDate) {
  const diff = dayDiff(dueDate);
  if (diff < 0) return { rank: 0, color: "var(--alert-red)", emoji: "🔴", label: `overdue ${-diff} day${-diff === 1 ? "" : "s"}` };
  if (diff === 0) return { rank: 1, color: "var(--amber)", emoji: "🟡", label: "due today" };
  if (diff === 1) return { rank: 1, color: "var(--amber)", emoji: "🟡", label: "due tomorrow" };
  return { rank: 2, color: "var(--slate)", emoji: "⚪", label: `due ${new Date(dueDate).toLocaleDateString([], { day: "2-digit", month: "short" })}` };
}

function LogActionForm({ followupId, onSaved, onCancel }) {
  const [note, setNote] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!note.trim()) { setError("Enter what you did."); return; }
    setSaving(true); setError("");
    try {
      await apiRequest(`/sales/followups/${followupId}/log-action`, { method: "POST", body: { note, next_due_date: nextDue || null } });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 4, marginBottom: 4, padding: 8, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
      {error && <div style={{ color: "var(--alert-red)", marginBottom: 6 }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called, asked for 2 more days" style={{ fontSize: 12, padding: "5px 7px" }} />
        <input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} style={{ fontSize: 12, padding: "5px 7px" }} title="Next due date (optional)" />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" disabled={saving} onClick={save} style={{ fontSize: 11, padding: "3px 8px" }}>{saving ? "Saving..." : "Save action"}</button>
        <button type="button" onClick={onCancel} style={{ fontSize: 11, padding: "3px 8px" }}>Cancel</button>
      </div>
    </div>
  );
}

export default function FollowupsDue({ asUser }) {
  const [rows, setRows] = useState([]);
  const [actionsByFollowup, setActionsByFollowup] = useState({});
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [logOpenId, setLogOpenId] = useState(null);

  async function load() {
    try {
      const data = await apiRequest(`/sales/followups${asUser ? `?as_user=${asUser}` : ""}`);
      setRows(data);
      if (data.length > 0) {
        const actions = await apiRequest(`/sales/followups/actions?followup_ids=${data.map((r) => r.id).join(",")}`);
        const byFollowup = {};
        for (const a of actions) {
          (byFollowup[a.followup_id] ||= []).push(a);
        }
        setActionsByFollowup(byFollowup);
      } else {
        setActionsByFollowup({});
      }
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

  const groups = groupByVisit(rows).map((g) => ({
    ...g,
    urgentRank: Math.min(...g.items.map((r) => urgency(r.due_date).rank)),
  })).sort((a, b) => a.urgentRank - b.urgentRank);

  const accentByRank = { 0: "var(--alert-red)", 1: "var(--amber)", 2: "var(--slate)" };

  function GroupBlock({ group }) {
    const accentColor = accentByRank[group.urgentRank];
    const combinedLog = group.items
      .flatMap((r) => actionsByFollowup[r.id] || [])
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return (
      <div style={{ borderLeft: `3px solid ${accentColor}`, background: "var(--concrete)", borderRadius: "0 8px 8px 0", padding: "8px 10px", marginBottom: 8, fontSize: 13 }}>
        <div style={{ fontWeight: 600 }}>
          {group.visited_name}{group.site_name ? ` — ${group.site_name}` : ""}
          {group.visit_date && (
            <span style={{ fontWeight: 400, color: "var(--slate)", fontSize: 11 }}> · from visit on {new Date(group.visit_date).toLocaleDateString([], { day: "2-digit", month: "short" })}</span>
          )}
        </div>
        <div style={{ color: "var(--slate)", fontSize: 11, marginBottom: 4 }}>
          {group.items.length} open thread{group.items.length === 1 ? "" : "s"} on this customer
        </div>
        {group.items.map((r) => {
          const u = urgency(r.due_date);
          return (
            <div key={r.id} style={{ padding: "3px 0 3px 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div>
                  <div>{u.emoji} {r.title} — <b style={{ color: u.color }}>{u.label}</b></div>
                  {r.reason && <div style={{ color: "var(--slate)", fontSize: 11 }}>{r.reason}</div>}
                </div>
                <span style={{ display: "flex", gap: 4, whiteSpace: "nowrap" }}>
                  <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setLogOpenId(logOpenId === r.id ? null : r.id)}>Log action</button>
                  <button style={{ fontSize: 11, padding: "3px 8px" }} disabled={busyId === r.id} onClick={() => markDone(r.id)}>
                    {busyId === r.id ? "..." : "Done"}
                  </button>
                </span>
              </div>
              {logOpenId === r.id && (
                <LogActionForm followupId={r.id} onCancel={() => setLogOpenId(null)} onSaved={() => { setLogOpenId(null); load(); }} />
              )}
            </div>
          );
        })}
        {combinedLog.length > 0 && (
          <div style={{ color: "var(--slate)", fontSize: 11, paddingLeft: 10, marginTop: 4 }}>
            {combinedLog.map((a, i) => (
              <span key={a.id}>
                {i > 0 && " · "}
                {new Date(a.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })} — {a.note}
              </span>
            ))}
          </div>
        )}
        <div style={{ paddingLeft: 10, marginTop: 4 }}>
          <OutcomePicker visitId={group.visit_id} onSaved={load} />
        </div>
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
        groups.map((g) => <GroupBlock key={g.visit_id} group={g} />)
      )}
    </div>
  );
}
