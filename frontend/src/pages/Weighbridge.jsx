import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";

// Round 154 — the weighbridge screen.
//
// Two tabs, because there are two genuinely different jobs here:
//
//   Receipts — what the weighbridge has weighed. Store opens this to answer
//              "what came in today", and the Plant Operator and lab open it to
//              answer "what did that lorry actually weigh". Read-only for
//              those two; Store and the Manager can set a ticket aside.
//
//   Mapping  — Administrator only. Teaching the app that "KL77D423" is the
//              same lorry as "KL77D4231" and that "MSAND" is "M SAND". This is
//              the consequential tab: a mapping decides where stock is credited
//              from then on, for every past and future ticket carrying that
//              spelling, which is exactly why it is not delegated to Store.
//
// WHY THERE IS A REVIEW QUEUE AT ALL. The weighbridge records vehicle, material
// and supplier as free text an operator typed, not as foreign keys. Three years
// of live data has the same lorry as KL77D4231, "KL77D 4231", "KL 77 D 4231",
// KL77D-4231, kl77d4231, KL774231, KL77D423 and plain 4231. Normalising case
// and punctuation collapses most of that automatically. What is left — genuine
// typos, short forms, trading names — is mapped once by a human here. The app
// deliberately does NOT fuzzy-match: "20MM" and "12MM" are two characters
// apart, and a wrong automatic match credits the wrong material and nobody
// notices for a month.

function fmtKg(kg) {
  if (kg == null) return "—";
  const t = Number(kg) / 1000;
  return `${t.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`;
}

function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// "4 minutes ago" for the agent heartbeat. The question this answers at 7am is
// "is the weighbridge feed alive", so the exact timestamp matters less than the
// age, and anything over about ten minutes should look wrong.
function ago(ts) {
  if (!ts) return { text: "never", stale: true };
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return { text: "just now", stale: false };
  if (mins < 60) return { text: `${mins} min ago`, stale: mins > 10 };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { text: `${hrs} hr ago`, stale: true };
  return { text: `${Math.floor(hrs / 24)} d ago`, stale: true };
}

const STATUS_STYLE = {
  matched:      { bg: "var(--signal-green-bg)", fg: "var(--signal-green)", label: "Matched" },
  needs_review: { bg: "var(--amber-bg)",        fg: "var(--amber)",        label: "Needs review" },
  ignored:      { bg: "#EFEDE8",                fg: "var(--slate)",        label: "Set aside" },
};

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.needs_review;
  return (
    <span style={{
      background: s.bg, color: s.fg, borderRadius: 999, padding: "2px 9px",
      fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
    }}>{s.label}</span>
  );
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function Receipts({ canEdit }) {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("");     // "" = everything
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);

  async function load() {
    setError("");
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (filter) qs.set("status", filter);
      const [s, t] = await Promise.all([
        apiRequest("/weighbridge/summary"),
        apiRequest(`/weighbridge/tickets?${qs}`),
      ]);
      setSummary(s);
      setRows(t);
    } catch (err) {
      setError(err.message || "Could not load the weighbridge.");
    } finally {
      setLoading(false);
    }
  }

  // Refreshes on its own because a lorry can be weighed while this screen is
  // open — Store leaves it up on the office machine all day.
  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, days]);

  async function setStatus(ticketNumber, match_status) {
    setBusy(ticketNumber);
    try {
      await apiRequest(`/weighbridge/tickets/${ticketNumber}`, {
        method: "PATCH",
        body: { match_status },
      });
      await load();
    } catch (err) {
      setError(err.message || "Could not update that ticket.");
    } finally {
      setBusy(null);
    }
  }

  const heartbeat = ago(summary?.last_sync_at);

  return (
    <>
      {/* The strip that answers "is this feed alive and is anything waiting on
          me" without scrolling. The agent's last check-in is here rather than
          buried in an admin screen precisely because a stopped sync is
          otherwise invisible until somebody notices stock is short. */}
      <div className="card" style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 22, alignItems: "center" }}>
        <div>
          <div className="kpi-label">Weighed today</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{summary?.today_count ?? "—"}</div>
        </div>
        <div>
          <div className="kpi-label">Today's tonnage</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtKg(summary?.today_kg)}</div>
        </div>
        <div>
          <div className="kpi-label">Needs review</div>
          <div style={{
            fontSize: 22, fontWeight: 700,
            color: summary?.needs_review ? "var(--amber)" : "inherit",
          }}>{summary?.needs_review ?? "—"}</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="kpi-label">Weighbridge agent</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: heartbeat.stale ? "var(--alert-red)" : "var(--signal-green)" }}>
            {heartbeat.stale ? "Last seen " : "Live · "}{heartbeat.text}
          </div>
          {summary?.last_sync_error && (
            <div style={{ fontSize: 11, color: "var(--alert-red)", maxWidth: 320 }}>{summary.last_sync_error}</div>
          )}
        </div>
      </div>

      {heartbeat.stale && summary && (
        <div className="card" style={{ marginBottom: 16, background: "var(--alert-red-bg)", borderColor: "var(--alert-red)", fontSize: 13 }}>
          The weighbridge PC has not sent anything recently. Tickets are not lost — they are
          still on the weighbridge and will arrive once it is back — but nothing here is
          current until then.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        {[["", "All"], ["needs_review", "Needs review"], ["matched", "Matched"], ["ignored", "Set aside"]].map(([v, label]) => (
          <button
            key={v || "all"}
            onClick={() => setFilter(v)}
            type="button"
            className={`btn-tab ${filter === v ? "active" : ""}`}
            style={{ fontSize: 13 }}
          >
            {label}
            {v === "needs_review" && summary?.needs_review ? ` (${summary.needs_review})` : ""}
          </button>
        ))}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ marginLeft: "auto", fontSize: 13 }}>
          <option value={1}>Today & yesterday</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>

      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {loading && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}

      {!loading && !rows.length && (
        <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>
          No weighbridge tickets in this period.
          {summary && !summary.last_sync_at && " The sync agent has never checked in — see tools/weighbridge-agent/README.md."}
        </div>
      )}

      {!!rows.length && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "var(--concrete)" }}>
                <th style={{ padding: "9px 12px" }}>Ticket</th>
                <th style={{ padding: "9px 12px" }}>Weighed</th>
                <th style={{ padding: "9px 12px" }}>Vehicle</th>
                <th style={{ padding: "9px 12px" }}>Material</th>
                <th style={{ padding: "9px 12px" }}>Supplier</th>
                <th style={{ padding: "9px 12px", textAlign: "right" }}>Net</th>
                <th style={{ padding: "9px 12px" }}>Status</th>
                {canEdit && <th style={{ padding: "9px 12px" }} />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const needs = (k) => (r.unresolved || []).includes(k);
                // The raw weighbridge spelling is shown next to the resolved
                // name, not instead of it. Store needs to see both: the name we
                // matched to, and what the operator actually typed, because
                // that is what they will compare against the paper slip.
                const cell = (resolved, raw, key) => {
                  // Nothing resolved AND nothing flagged means the backend
                  // recognised this as blank — the weighbridge has no concept
                  // of an empty field, so "the operator left it blank" arrives
                  // as the literal text "N/A", "NONE" or "NIL". Printing that
                  // in a supplier column reads as a supplier called N/A, so a
                  // dash is the honest rendering.
                  const blank = !resolved && !needs(key);
                  return (
                    <td style={{ padding: "9px 12px" }}>
                      <div style={{ color: needs(key) ? "var(--amber)" : "inherit", fontWeight: resolved ? 500 : 400 }}>
                        {resolved || (blank ? "—" : raw) || "—"}
                      </div>
                      {resolved && raw && resolved !== raw && (
                        <div style={{ fontSize: 11, color: "var(--slate)" }}>slip says “{raw}”</div>
                      )}
                      {blank && raw && (
                        <div style={{ fontSize: 11, color: "var(--slate)" }}>slip says “{raw}”</div>
                      )}
                    </td>
                  );
                };
                return (
                  <tr key={r.ticket_number} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "9px 12px", fontWeight: 600 }}>
                      #{r.ticket_number}
                      {r.challan_number && r.challan_number !== "001" && (
                        <div style={{ fontSize: 11, color: "var(--slate)" }}>DC {r.challan_number}</div>
                      )}
                    </td>
                    <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>{fmtWhen(r.weighed_at)}</td>
                    {cell(r.truck_number, r.raw_vehicle, "vehicle")}
                    {cell(r.material_name, r.raw_material, "material")}
                    {cell(r.supplier_name, r.raw_supplier, "supplier")}
                    <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {fmtKg(r.net_weight_kg)}
                      <div style={{ fontSize: 11, color: "var(--slate)", fontWeight: 400 }}>
                        {r.loaded_weight_kg != null && r.empty_weight_kg != null
                          ? `${Number(r.loaded_weight_kg).toLocaleString()} − ${Number(r.empty_weight_kg).toLocaleString()}`
                          : ""}
                      </div>
                    </td>
                    <td style={{ padding: "9px 12px" }}>
                      <StatusPill status={r.match_status} />
                      {r.receipt_id && (
                        <div style={{ fontSize: 11, color: "var(--signal-green)" }}>receipt #{r.receipt_id}</div>
                      )}
                    </td>
                    {canEdit && (
                      <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>
                        {r.match_status === "ignored" ? (
                          <button type="button" style={{ fontSize: 12 }}
                                  disabled={busy === r.ticket_number}
                                  onClick={() => setStatus(r.ticket_number, "needs_review")}>
                            Put back
                          </button>
                        ) : (
                          <button type="button" style={{ fontSize: 12 }}
                                  disabled={busy === r.ticket_number}
                                  onClick={() => setStatus(r.ticket_number, "ignored")}>
                            Set aside
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 14, lineHeight: 1.6 }}>
        Weights come straight from the weighbridge and are never edited here — a wrong weight is
        corrected on the weighbridge and arrives on the next sync. Moisture is not imported: the
        weighbridge stores it as free text and it has never once held a real number, so any
        moisture deduction is done in the Material Module against a figure the lab provides.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const KIND_LABEL = { material: "Material", supplier: "Supplier" };

function Mapping({ canEdit = true }) {
  const [unmapped, setUnmapped] = useState([]);
  const [aliases, setAliases] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Keyed `${kind}:${raw_sample}:${scopeId|""}` — the scope is part of the key
  // because one spelling now has a row per supplier, each with its own choice.
  const [draft, setDraft] = useState({});

  async function load() {
    setError("");
    try {
      const [u, a] = await Promise.all([
        apiRequest("/weighbridge/unmapped"),
        apiRequest("/weighbridge/aliases"),
      ]);
      setUnmapped(u);
      setAliases(a);
    } catch (err) {
      setError(err.message || "Could not load the mappings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function save(kind, rawSample, scopeId) {
    const key = `${kind}:${rawSample}:${scopeId ?? ""}`;
    const choice = draft[key];
    if (!choice) return;
    setError(""); setNotice("");
    try {
      const body = { kind, raw_sample: rawSample };
      if (scopeId != null) body.supplier_scope_id = scopeId;
      if (choice === "ignore") body.is_ignored = true;
      else body.target_id = Number(choice);
      const res = await apiRequest("/weighbridge/aliases", { method: "POST", body });
      setNotice(
        res.tickets_cleared
          ? `Mapped${res.scoped ? " for that supplier" : ""}. ${res.tickets_cleared} ticket${res.tickets_cleared === 1 ? "" : "s"} cleared the review queue.`
          : `Mapped${res.scoped ? " for that supplier" : ""}. No tickets cleared yet — something else on them is still unmapped.`
      );
      await load();
    } catch (err) {
      setError(err.message || "Could not save that mapping.");
    }
  }

  async function remove(kind, id) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/weighbridge/aliases/${kind}/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || "Could not remove that mapping.");
    }
  }

  // Round 156 — re-check on demand. Adding a material or supplier to the
  // Material Module's own masters used to reach nothing already synced,
  // because re-resolution only ran when a MAPPING changed. That left the plant
  // staring at a hundred tickets in Needs review against masters that would
  // have matched them perfectly.
  async function recheck() {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await apiRequest("/weighbridge/recheck", { method: "POST" });
      setNotice(
        r.tickets_cleared
          ? `Re-checked. ${r.tickets_cleared} ticket${r.tickets_cleared === 1 ? "" : "s"} resolved — ${r.needs_review_now} still need a human (was ${r.needs_review_before}).`
          : `Re-checked. Nothing new resolved — ${r.needs_review_now} still waiting.`
      );
      await load();
    } catch (err) {
      setError(err.message || "Could not re-check the tickets.");
    } finally {
      setBusy(false);
    }
  }

  const existing = useMemo(() => {
    if (!aliases) return [];
    return ["material", "supplier"].flatMap((kind) =>
      (aliases[kind] || []).map((a) => ({ ...a, kind }))
    );
  }, [aliases]);

  if (loading) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const materialOptions = aliases?.options?.material || [];
  const supplierOptions = aliases?.options?.supplier || [];

  // One unmapped entry renders either as a single row, or — for a material
  // that has arrived from more than one supplier — as a row per supplier plus
  // a fallback. That is the whole point of Round 156: "FLY ASH" is not one
  // answer when three suppliers send three different products under it.
  function scopeRows(u) {
    if (u.kind !== "material") return [{ scopeId: null, scopeName: null }];
    const sups = (u.suppliers || []).filter((s) => s && s.id != null);
    if (sups.length <= 1) return [{ scopeId: null, scopeName: null }];
    return [...sups.map((s) => ({ scopeId: s.id, scopeName: s.name })), { scopeId: null, scopeName: null }];
  }

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <strong>Map each weighbridge spelling once.</strong> It applies to every ticket that has ever
        carried it, not just future ones. Case and punctuation are already handled, which is why
        “20 MM” and “20MM” never appear here.
        <br />
        <strong>One name can mean several materials.</strong> When a spelling has arrived from more than
        one supplier, you get a row per supplier — so “FLY ASH” from JSW and “FLY ASH” from Thoothukudi
        can be two different materials. The last row, <em>anyone else</em>, is the fallback for suppliers
        you have not named.
      </div>

      {/* Round 158 — say why the controls are dead rather than letting somebody
          click at a dropdown that will never answer. */}
      {!canEdit && (
        <div className="card" style={{ marginBottom: 16, fontSize: 13, color: "var(--slate)" }}>
          You can see the mappings but not change them. A Super Admin can grant that on the Access
          Control page.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 10px" }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>
          Waiting to be mapped {unmapped.length ? `(${unmapped.length})` : ""}
        </h3>
        <button type="button" style={{ marginLeft: "auto", fontSize: 13 }} disabled={busy || !canEdit} onClick={recheck}>
          {busy ? "Re-checking…" : "Re-check all tickets"}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)", lineHeight: 1.55 }}>
        Use <strong>Re-check all</strong> after adding materials or suppliers in the Material Module.
        Tickets already synced do not re-examine themselves when a master record appears, so without it
        they sit in Needs review against a record that would now match them.
      </div>

      {!unmapped.length && (
        <div className="card" style={{ fontSize: 13, color: "var(--signal-green)", marginBottom: 22 }}>
          Nothing waiting. Every name the weighbridge has sent is understood.
        </div>
      )}

      {!!unmapped.length && (
        <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 26 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "var(--concrete)" }}>
                <th style={{ padding: "9px 12px" }}>Type</th>
                <th style={{ padding: "9px 12px" }}>As the weighbridge has it</th>
                <th style={{ padding: "9px 12px" }}>When it comes from</th>
                <th style={{ padding: "9px 12px", textAlign: "right" }}>Tickets</th>
                <th style={{ padding: "9px 12px" }}>Map it to</th>
                <th style={{ padding: "9px 12px" }} />
              </tr>
            </thead>
            <tbody>
              {unmapped.flatMap((u) => {
                const rows = scopeRows(u);
                const options = u.kind === "material" ? materialOptions : supplierOptions;
                return rows.map((sc, i) => {
                  const key = `${u.kind}:${u.raw_sample}:${sc.scopeId ?? ""}`;
                  return (
                    <tr key={key} style={{ borderTop: i === 0 ? "1px solid var(--border)" : "1px dotted var(--border)" }}>
                      <td style={{ padding: "9px 12px" }}>{i === 0 ? KIND_LABEL[u.kind] : ""}</td>
                      <td style={{ padding: "9px 12px", fontFamily: "ui-monospace, monospace", fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "inherit" : "var(--slate)" }}>
                        {i === 0
                          ? (u.raw_sample || <span style={{ color: "var(--slate)", fontStyle: "italic" }}>(blank)</span>)
                          : ""}
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        {sc.scopeName
                          ? <span style={{ fontWeight: 600, color: "var(--rebar)" }}>{sc.scopeName}</span>
                          : <span style={{ color: "var(--slate)" }}>{rows.length > 1 ? "anyone else" : "any supplier"}</span>}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 600 }}>{i === 0 ? u.n : ""}</td>
                      <td style={{ padding: "9px 12px" }}>
                        <select
                          aria-label={`Map ${u.raw_sample}${sc.scopeName ? ` from ${sc.scopeName}` : ""}`}
                          value={draft[key] || ""}
                          disabled={!canEdit}
                          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                          style={{ fontSize: 13, minWidth: 210 }}
                        >
                          <option value="">Choose…</option>
                          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                          <option value="ignore">— Not ours, ignore it —</option>
                        </select>
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <button type="button" className="btn-primary" style={{ fontSize: 12 }}
                                disabled={!draft[key] || !canEdit}
                                onClick={() => save(u.kind, u.raw_sample, sc.scopeId)}>
                          Save
                        </button>
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>
        Mappings already made {existing.length ? `(${existing.length})` : ""}
      </h3>

      {!existing.length && (
        <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>None yet.</div>
      )}

      {!!existing.length && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "var(--concrete)" }}>
                <th style={{ padding: "9px 12px" }}>Type</th>
                <th style={{ padding: "9px 12px" }}>Weighbridge spelling</th>
                <th style={{ padding: "9px 12px" }}>When it comes from</th>
                <th style={{ padding: "9px 12px" }}>Means</th>
                <th style={{ padding: "9px 12px" }} />
              </tr>
            </thead>
            <tbody>
              {existing.map((a) => {
                const key = `${a.kind}:${a.raw_sample}:${a.supplier_scope_id ?? ""}`;
                const options = a.kind === "material" ? materialOptions : supplierOptions;
                return (
                  <tr key={`${a.kind}-${a.id}`} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "9px 12px" }}>{KIND_LABEL[a.kind]}</td>
                    <td style={{ padding: "9px 12px", fontFamily: "ui-monospace, monospace" }}>{a.raw_sample}</td>
                    <td style={{ padding: "9px 12px" }}>
                      {a.scope_name
                        ? <span style={{ fontWeight: 600, color: "var(--rebar)" }}>{a.scope_name}</span>
                        : <span style={{ color: "var(--slate)" }}>any supplier</span>}
                    </td>
                    <td style={{ padding: "9px 12px" }}>
                      {/* Round 156 — a wrong rule is corrected in place. Saving
                          the same spelling and scope again replaces it, so
                          there is no delete-then-redo dance. */}
                      <select
                        aria-label={`Change what ${a.raw_sample} means`}
                        value={draft[key] ?? ""}
                        disabled={!canEdit}
                        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                        style={{ fontSize: 13, minWidth: 200 }}
                      >
                        <option value="">
                          {a.is_ignored ? "not ours — ignored" : (a.target || "record no longer exists")}
                        </option>
                        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        <option value="ignore">— Not ours, ignore it —</option>
                      </select>
                    </td>
                    <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn-primary" style={{ fontSize: 12, marginRight: 6 }}
                              disabled={!draft[key] || !canEdit}
                              onClick={() => save(a.kind, a.raw_sample, a.supplier_scope_id ?? null)}>
                        Change
                      </button>
                      <button type="button" style={{ fontSize: 12 }} disabled={!canEdit} onClick={() => remove(a.kind, a.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 14, lineHeight: 1.6 }}>
        Changing or removing a rule re-checks every ticket still waiting. It does not un-resolve tickets
        that already matched — stock credited against them stays credited, which is the honest behaviour
        when somebody is only tidying this list.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Vehicles — Round 156
// ---------------------------------------------------------------------------

function fmtT(kg) {
  if (kg == null) return "—";
  return `${(Number(kg) / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`;
}

function Vehicles({ canEdit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mergeFrom, setMergeFrom] = useState(null);

  async function load() {
    setError("");
    try {
      setData(await apiRequest("/weighbridge/vehicles"));
    } catch (err) {
      setError(err.message || "Could not load the vehicles.");
    }
  }

  useEffect(() => { load(); }, []);

  async function setOwner(v, value) {
    setError(""); setNotice("");
    const body = { truck_id: null, supplier_id: null, is_junk: false };
    if (value.startsWith("t:")) body.truck_id = Number(value.slice(2));
    else if (value.startsWith("s:")) body.supplier_id = Number(value.slice(2));
    else if (value === "junk") body.is_junk = true;
    try {
      await apiRequest(`/weighbridge/vehicles/${v.id}`, { method: "PATCH", body });
      await load();
    } catch (err) {
      setError(err.message || "Could not update that vehicle.");
    }
  }

  async function doMerge(intoId) {
    setError(""); setNotice("");
    try {
      const r = await apiRequest(`/weighbridge/vehicles/${mergeFrom.id}/merge`, {
        method: "POST",
        body: { into_id: intoId, first_seen_at: mergeFrom.first_seen_at, last_seen_at: mergeFrom.last_seen_at },
      });
      setNotice(`Merged. ${r.tickets_moved} ticket${r.tickets_moved === 1 ? "" : "s"} moved across.`);
      setMergeFrom(null);
      await load();
    } catch (err) {
      setError(err.message || "Could not merge those vehicles.");
    }
  }

  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const { vehicles, options } = data;
  const unattributed = vehicles.filter((v) => !v.truck_id && !v.supplier_id && !v.is_junk).length;

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <strong>Every lorry gets a record, whether or not it is yours.</strong> A supplier's vehicle
        registers itself the first time it crosses the weighbridge — nobody needs to know its number in
        advance, which matters because you don't until it arrives. The different ways an operator might
        type the same registration collapse onto one record, so trips and tonnage add up per lorry.
        <br />
        Saying who owns one is optional. It is worth doing where you want a supplier's tonnage to add up,
        and it is not worth doing for a lorry you will see once.
      </div>

      {mergeFrom && (
        <div className="card" style={{ marginBottom: 16, background: "var(--amber-bg)", borderColor: "var(--amber)" }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            Merge <strong style={{ fontFamily: "ui-monospace, monospace" }}>{mergeFrom.registration}</strong> into
            which lorry? Its {mergeFrom.trips} ticket{mergeFrom.trips === 1 ? "" : "s"} move across, and this
            spelling will resolve straight there in future.
          </div>
          <select aria-label="Merge into which vehicle" defaultValue="" style={{ fontSize: 13, minWidth: 260 }}
                  onChange={(e) => { if (e.target.value) doMerge(Number(e.target.value)); }}>
            <option value="">Choose the lorry it should have been…</option>
            {vehicles.filter((v) => v.id !== mergeFrom.id).map((v) => (
              <option key={v.id} value={v.id}>{v.registration} — {v.trips} trips</option>
            ))}
          </select>
          <button type="button" style={{ fontSize: 13, marginLeft: 8 }} onClick={() => setMergeFrom(null)}>Cancel</button>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Vehicles seen at the weighbridge ({vehicles.length})</h3>
        {unattributed > 0 && (
          <span style={{ fontSize: 12.5, color: "var(--slate)" }}>{unattributed} not yet attributed to anyone</span>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", background: "var(--concrete)" }}>
              <th style={{ padding: "9px 12px" }}>Registration</th>
              <th style={{ padding: "9px 12px" }}>Belongs to</th>
              <th style={{ padding: "9px 12px", textAlign: "right" }}>Trips</th>
              <th style={{ padding: "9px 12px", textAlign: "right" }}>Tonnage</th>
              <th style={{ padding: "9px 12px", textAlign: "right" }}>Avg load</th>
              <th style={{ padding: "9px 12px", textAlign: "right" }}>Usual tare</th>
              {canEdit && <th style={{ padding: "9px 12px" }} />}
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => {
              const owner = v.truck_id ? `t:${v.truck_id}` : v.supplier_id ? `s:${v.supplier_id}` : v.is_junk ? "junk" : "";
              return (
                <tr key={v.id} style={{ borderTop: "1px solid var(--border)", opacity: v.is_junk ? 0.55 : 1 }}>
                  <td style={{ padding: "9px 12px" }}>
                    <div style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{v.registration}</div>
                    {!!v.aliases.length && (
                      <div style={{ fontSize: 11, color: "var(--slate)", fontFamily: "ui-monospace, monospace" }}>
                        also typed as {v.aliases.join(" · ")}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "9px 12px" }}>
                    {canEdit ? (
                      <select aria-label={`Who owns ${v.registration}`} value={owner}
                              onChange={(e) => setOwner(v, e.target.value)}
                              style={{ fontSize: 13, minWidth: 190 }}>
                        <option value="">not attributed</option>
                        <optgroup label="One of ours">
                          {options.trucks.map((t) => <option key={`t${t.id}`} value={`t:${t.id}`}>{t.name}</option>)}
                        </optgroup>
                        <optgroup label="A supplier's lorry">
                          {options.suppliers.map((s) => <option key={`s${s.id}`} value={`s:${s.id}`}>{s.name}</option>)}
                        </optgroup>
                        <option value="junk">— not a real lorry —</option>
                      </select>
                    ) : (
                      <span>{v.truck_number || v.supplier_name || <span style={{ color: "var(--slate)" }}>—</span>}</span>
                    )}
                  </td>
                  <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 600 }}>{v.trips}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right" }}>{fmtT(v.total_kg)}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right" }}>{fmtT(v.avg_kg)}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--slate)" }}>
                    {v.usual_tare_kg != null ? `${Number(v.usual_tare_kg).toLocaleString()} kg` : "—"}
                  </td>
                  {canEdit && (
                    <td style={{ padding: "9px 12px" }}>
                      <button type="button" style={{ fontSize: 12 }} onClick={() => setMergeFrom(v)}>Merge…</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 14, lineHeight: 1.6 }}>
        Usual tare is the empty weight this lorry most often shows. Nothing acts on it automatically, but a
        tare that drifts is worth a look — it is the shape a weighbridge problem tends to take.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------

export default function Weighbridge() {
  const { can, ready } = usePermissions();
  const [tab, setTab] = useState("receipts");

  const canView = ready && can("material.weighbridge", "view");
  const canEdit = ready && can("material.weighbridge", "edit");
  const canMap = ready && can("material.weighbridge-mapping", "view");
  // Round 158 — the Vehicles and Mapping controls used to be shown to anyone
  // with mapping VIEW, while the endpoints behind them require EDIT. Somebody
  // granted view-only therefore saw live dropdowns that answered 403 on use.
  // Read and write are now gated by the action each one actually needs.
  const canMapEdit = ready && can("material.weighbridge-mapping", "edit");

  if (!ready) return null;

  if (!canView && !canMap) {
    return (
      <>
        <TopBar title="Weighbridge" />
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 16px 32px" }}>
          <div className="card" style={{ fontSize: 13 }}>
            You do not have access to the weighbridge. A Super Admin can grant it on the Access
            Control page.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Weighbridge" />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 16px 32px" }}>
        {canMap && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button type="button" className={`btn-tab ${tab === "receipts" ? "active" : ""}`} onClick={() => setTab("receipts")}>
              Receipts
            </button>
            <button type="button" className={`btn-tab ${tab === "mapping" ? "active" : ""}`} onClick={() => setTab("mapping")}>
              Name mapping
            </button>
            <button type="button" className={`btn-tab ${tab === "vehicles" ? "active" : ""}`} onClick={() => setTab("vehicles")}>
              Vehicles
            </button>
          </div>
        )}
        {tab === "mapping" && canMap
          ? <Mapping canEdit={canMapEdit} />
          : tab === "vehicles" && canView
            ? <Vehicles canEdit={canMapEdit} />
            : <Receipts canEdit={canEdit} />}
      </div>
    </>
  );
}
