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

const KIND_LABEL = { material: "Material", supplier: "Supplier", vehicle: "Vehicle" };

function Mapping() {
  const [unmapped, setUnmapped] = useState([]);
  const [aliases, setAliases] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({});   // `${kind}:${raw_sample}` -> target id or "ignore"

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

  async function save(kind, rawSample) {
    const choice = draft[`${kind}:${rawSample}`];
    if (!choice) return;
    setError("");
    setNotice("");
    try {
      const res = await apiRequest("/weighbridge/aliases", {
        method: "POST",
        body: choice === "ignore"
          ? { kind, raw_sample: rawSample, is_ignored: true }
          : { kind, raw_sample: rawSample, target_id: Number(choice) },
      });
      setNotice(
        res.tickets_cleared
          ? `Mapped. ${res.tickets_cleared} ticket${res.tickets_cleared === 1 ? "" : "s"} cleared the review queue.`
          : "Mapped. No tickets cleared yet — something else on them is still unmapped."
      );
      await load();
    } catch (err) {
      setError(err.message || "Could not save that mapping.");
    }
  }

  async function remove(kind, id) {
    setError("");
    setNotice("");
    try {
      await apiRequest(`/weighbridge/aliases/${kind}/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || "Could not remove that mapping.");
    }
  }

  const existing = useMemo(() => {
    if (!aliases) return [];
    return ["material", "supplier", "vehicle"].flatMap((kind) =>
      (aliases[kind] || []).map((a) => ({ ...a, kind }))
    );
  }, [aliases]);

  if (loading) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <strong>Map each weighbridge spelling once.</strong> It applies to every ticket that has
        ever carried it, not just future ones — so mapping “KL77D423” clears the whole backlog of
        that typo immediately. Case and punctuation are already handled, which is why “20 MM” and
        “20MM” never appear here. Choose <em>Not ours</em> for a lorry or material that genuinely
        is not one of yours; that resolves it cleanly instead of leaving it in the queue forever.
      </div>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>
        Waiting to be mapped {unmapped.length ? `(${unmapped.length})` : ""}
      </h3>

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
                <th style={{ padding: "9px 12px", textAlign: "right" }}>Tickets</th>
                <th style={{ padding: "9px 12px" }}>Last seen</th>
                <th style={{ padding: "9px 12px" }}>Map it to</th>
                <th style={{ padding: "9px 12px" }} />
              </tr>
            </thead>
            <tbody>
              {unmapped.map((u) => {
                const key = `${u.kind}:${u.raw_sample}`;
                const options = aliases?.options?.[u.kind] || [];
                return (
                  <tr key={key} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "9px 12px" }}>{KIND_LABEL[u.kind]}</td>
                    <td style={{ padding: "9px 12px", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                      {u.raw_sample || <span style={{ color: "var(--slate)", fontStyle: "italic" }}>(blank)</span>}
                    </td>
                    <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 600 }}>{u.n}</td>
                    <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>{fmtWhen(u.last_seen)}</td>
                    <td style={{ padding: "9px 12px" }}>
                      <select
                        value={draft[key] || ""}
                        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                        style={{ fontSize: 13, minWidth: 200 }}
                      >
                        <option value="">Choose…</option>
                        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        <option value="ignore">— Not ours, ignore it —</option>
                      </select>
                    </td>
                    <td style={{ padding: "9px 12px" }}>
                      <button type="button" className="btn-primary" style={{ fontSize: 12 }}
                              disabled={!draft[key]}
                              onClick={() => save(u.kind, u.raw_sample)}>
                        Save
                      </button>
                    </td>
                  </tr>
                );
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
                <th style={{ padding: "9px 12px" }}>Means</th>
                <th style={{ padding: "9px 12px" }} />
              </tr>
            </thead>
            <tbody>
              {existing.map((a) => (
                <tr key={`${a.kind}-${a.id}`} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "9px 12px" }}>{KIND_LABEL[a.kind]}</td>
                  <td style={{ padding: "9px 12px", fontFamily: "ui-monospace, monospace" }}>{a.raw_sample}</td>
                  <td style={{ padding: "9px 12px" }}>
                    {a.is_ignored
                      ? <span style={{ color: "var(--slate)", fontStyle: "italic" }}>not ours — ignored</span>
                      : (a.target || <span style={{ color: "var(--alert-red)" }}>record no longer exists</span>)}
                  </td>
                  <td style={{ padding: "9px 12px" }}>
                    <button type="button" style={{ fontSize: 12 }} onClick={() => remove(a.kind, a.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 14, lineHeight: 1.6 }}>
        Removing a mapping puts future tickets with that spelling back in the review queue. It does
        not un-resolve tickets that already matched — stock credited against them stays credited,
        which is the honest behaviour when somebody is only tidying this list.
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
          </div>
        )}
        {tab === "mapping" && canMap ? <Mapping /> : <Receipts canEdit={canEdit} />}
      </div>
    </>
  );
}
