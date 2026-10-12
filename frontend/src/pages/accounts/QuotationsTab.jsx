// Round 204 — Quotations: follow-ups first (owner: "follow up of quotations
// sent to be made visible with top priority"), then the register. Opening one
// shows it (QuotationView); New / Edit opens the builder.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { fmtDate, inr } from "../../lib/quotationTerms.js";
import { todayStr } from "../../lib/istDate.js";
import QuotationBuilder from "./QuotationBuilder.jsx";
import QuotationView from "./QuotationView.jsx";
import QuotationImport from "./QuotationImport.jsx";
import { TH, TD, NUM, row, money, StatusBadge, Banner, Field, Modal, Empty, Table } from "./ui.jsx";

const FILTERS = [
  ["open", "Open"], ["pending_approval", "Waiting approval"], ["approved", "Approved"], ["sent", "Sent"],
  ["accepted", "Accepted"], ["closed", "Lost / declined"], ["draft", "Drafts"], ["all", "All"],
];
const OPEN = new Set(["draft", "pending_approval", "approved", "sent"]);

export default function QuotationsTab({ params, go }) {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const id = params.get("id");
  const edit = params.get("edit");
  const isNew = params.get("new") === "1";

  useEffect(() => {
    apiRequest("/quotations/meta").then(setMeta).catch((e) => setError(e.message));
  }, []);

  if (error) return <Banner>{error}</Banner>;
  if (!meta) return <Empty>Loading…</Empty>;

  const back = () => go("quotations");
  if (params.get("import") === "1" && meta.perms.import) return <QuotationImport onDone={back} />;
  if (isNew || edit) {
    return (
      <QuotationBuilder meta={meta} id={edit ? Number(edit) : null} customerId={params.get("customer_id")} siteId={params.get("site_id")}
        onCancel={() => (edit ? go("quotations", { id: edit }) : back())}
        onSaved={(qid) => go("quotations", { id: String(qid) })} />
    );
  }
  if (id) return <QuotationView meta={meta} id={Number(id)} go={go} onBack={back} />;
  return <Register meta={meta} go={go} />;
}

function Register({ meta, go }) {
  const [followups, setFollowups] = useState(null);
  const [list, setList] = useState(null);
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [logFor, setLogFor] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    Promise.all([apiRequest("/quotations/followups"), apiRequest("/quotations?status=all")])
      .then(([f, l]) => { setFollowups(f); setList(l); })
      .catch((e) => setError(e.message));
  }, [tick]);

  const shown = useMemo(() => {
    if (!list) return [];
    const s = search.trim().toLowerCase();
    return list.filter((q) => {
      if (filter === "open" && !OPEN.has(q.status)) return false;
      if (filter === "closed" && !["lost", "declined"].includes(q.status)) return false;
      if (!["open", "closed", "all"].includes(filter) && q.status !== filter) return false;
      if (s && !`${q.quote_no} ${q.customer_name} ${q.site_name}`.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [list, filter, search]);

  const counts = useMemo(() => {
    const c = {};
    for (const q of list || []) c[q.status] = (c[q.status] || 0) + 1;
    return c;
  }, [list]);

  const due = (followups || []).filter((f) => f.overdue || f.due_today);
  const later = (followups || []).filter((f) => !f.overdue && !f.due_today);

  return (
    <>
      <Banner>{error}</Banner>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Follow-ups</h2>
        <span style={{ fontSize: 12.5, color: "var(--slate)" }}>Quotations with the customer — call 2 and 5 days after sending, and on the last valid day.</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {meta.perms.import && <button type="button" onClick={() => go("quotations", { import: "1" })}>Import from Excel</button>}
          {meta.perms.create && <button type="button" className="btn-primary" onClick={() => go("quotations", { new: "1" })}>+ New quotation</button>}
        </span>
      </div>

      {!followups ? <Empty>Loading…</Empty> : !followups.length ? (
        <Empty>No quotation is waiting on a customer.</Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 10, marginBottom: 18 }}>
          {[...due, ...later].map((f) => (
            <div key={f.id} className="card" style={{ padding: 12, borderLeft: `4px solid ${f.overdue ? "var(--alert-red)" : f.due_today ? "var(--amber)" : "var(--border-strong)"}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <b style={{ fontSize: 13.5 }}>{f.customer_name}</b>
                <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 600, color: f.overdue ? "var(--alert-red)" : f.due_today ? "var(--amber)" : "var(--slate)" }}>
                  {f.status === "approved" ? "Approved — send it" : f.overdue ? `Overdue since ${fmtDate(f.due_on)}` : f.due_today ? "Call today" : `Next ${fmtDate(f.due_on)}`}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--slate)" }}>{f.site_name}</div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>
                <a href={`?tab=quotations&id=${f.id}`} onClick={(e) => { e.preventDefault(); go("quotations", { id: String(f.id) }); }}>{f.quote_no}</a>
                {Number(f.value_incl_gst) > 0 && <> · {money(f.value_incl_gst)}</>}
                {f.valid_until && <span style={{ color: f.expired ? "var(--alert-red)" : "var(--slate)" }}> · valid till {fmtDate(f.valid_until)}</span>}
              </div>
              {f.last_note && (
                <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4, fontStyle: "italic" }}>
                  “{f.last_note}” — {f.last_by}, {fmtDate(String(f.last_at).slice(0, 10))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {f.contact_number && <a href={`tel:${f.contact_number}`} style={{ fontSize: 12.5, alignSelf: "center" }}>📞 {f.contact_number}</a>}
                {meta.perms.followup && f.status === "sent" && (
                  <button type="button" style={{ marginLeft: "auto", fontSize: 12, padding: "5px 10px" }} onClick={() => setLogFor(f)}>Log follow-up</button>
                )}
                {f.status === "approved" && (
                  <button type="button" style={{ marginLeft: "auto", fontSize: 12, padding: "5px 10px" }} onClick={() => go("quotations", { id: String(f.id) })}>Open</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 10px", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Register</h2>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {FILTERS.map(([k, label]) => {
            const n = k === "open" ? [...OPEN].reduce((t, s) => t + (counts[s] || 0), 0)
              : k === "closed" ? (counts.lost || 0) + (counts.declined || 0) : k === "all" ? (list || []).length : counts[k] || 0;
            return (
              <button key={k} type="button" className={`btn-tab ${filter === k ? "active" : ""}`} style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setFilter(k)}>
                {label} {n ? <span style={{ opacity: 0.7 }}>({n})</span> : null}
              </button>
            );
          })}
        </div>
        <input type="search" placeholder="Search number, customer, site" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ marginLeft: "auto", minWidth: 220, padding: "7px 10px", border: "1px solid var(--border-strong)", borderRadius: 7 }} />
      </div>

      {!list ? <Empty>Loading…</Empty> : !shown.length ? <Empty>No quotations here.</Empty> : (
        <Table minWidth={820} head={<>
          <th style={TH}>Quotation</th><th style={TH}>Customer · Site</th><th style={TH}>Type</th>
          <th style={TH}>Grades (incl. GST)</th><th style={{ ...TH, textAlign: "right" }}>Value</th><th style={TH}>Status</th><th style={TH}>By</th>
        </>}>
          {shown.map((q) => (
            <tr key={q.id} style={{ ...row, cursor: "pointer" }} onClick={() => go("quotations", { id: String(q.id) })}>
              <td style={TD}><b>{q.quote_no}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{fmtDate(q.quote_date)}</div></td>
              <td style={TD}>{q.customer_name}<div style={{ fontSize: 12, color: "var(--slate)" }}>{q.site_name}</div></td>
              <td style={{ ...TD, fontSize: 12 }}>{meta.agreement_types.find((t) => t.key === q.agreement_type)?.label}</td>
              <td style={{ ...TD, fontSize: 12 }}>{(q.lines || []).map((l) => `${l.grade} ₹${inr(l.rate)}`).join(" · ")}</td>
              <td style={NUM}>{Number(q.value_incl_gst) > 0 ? money(q.value_incl_gst) : "—"}</td>
              <td style={TD}>
                <StatusBadge status={q.status} />
                {q.status === "accepted" && q.rates_from && <div style={{ fontSize: 11, color: "var(--slate)" }}>price list from {fmtDate(q.rates_from)}</div>}
                {["lost", "declined"].includes(q.status) && q.closed_reason && <div style={{ fontSize: 11, color: "var(--slate)" }}>{q.closed_reason}</div>}
              </td>
              <td style={{ ...TD, fontSize: 12, color: "var(--slate)" }}>{q.created_by_name}</td>
            </tr>
          ))}
        </Table>
      )}

      {logFor && <FollowupModal q={logFor} onClose={() => setLogFor(null)} onSaved={() => { setLogFor(null); setTick((t) => t + 1); }} />}
    </>
  );
}

export function FollowupModal({ q, onClose, onSaved }) {
  const [f, setF] = useState({ outcome: "interested", note: "", contact: q.kind_attention || "", next_followup_on: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await apiRequest(`/quotations/${q.id}/followup`, { method: "POST", body: f });
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={`Follow-up · ${q.quote_no}`} onClose={onClose}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <Field label="What happened">
          <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>
            <option value="interested">Interested — still deciding</option>
            <option value="negotiating">Negotiating the rate</option>
            <option value="order_expected">Order expected</option>
            <option value="no_response">No response</option>
            <option value="lost">Lost — went elsewhere / dropped</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Spoke to"><input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field>
        <Field label={f.outcome === "lost" ? "Why was it lost?" : "What was said"}>
          <textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} required={f.outcome === "lost" || f.outcome === "other"} />
        </Field>
        {f.outcome !== "lost" && (
          <Field label="Next follow-up on" hint="Leave blank to follow the standard 2-day / 5-day / expiry reminders.">
            <input type="date" min={todayStr()} value={f.next_followup_on} onChange={(e) => setF({ ...f, next_followup_on: e.target.value })} />
          </Field>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save follow-up"}</button>
        </div>
      </form>
    </Modal>
  );
}
