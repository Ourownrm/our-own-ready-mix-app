// Round 215 — job cards. Each job is Inside or Outside (the owner, 18 Oct):
//   Inside  -> parts are requested from Store; issued from stock, or bought on
//              a PO and received on a GRV — either way the cost lands here.
//   Outside -> an estimate goes to the Administrator for approval, then the
//              outside-repair flow (sent out, returned with the bill).
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  useLoad, useAction, Loading, Msg, Badge, CARD_STATUS, OUTSIDE_STATUS, PART_STATUS, fmtRs, fmtNum, fmtWhen, fmtDate,
  H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN,
} from "./mntUi.jsx";

const ORIGIN = { not_ok: ["Not OK", "badge-danger"], other: ["Other", "badge-info"], complaint: ["Complaint", "badge-warning"], manual: ["Added", "badge-neutral"] };
const SEG = { padding: "6px 12px", fontSize: 12.5, fontWeight: 600, minHeight: 34, border: "1px solid var(--border-strong)", cursor: "pointer" };

export default function MntJobCards({ go, params }) {
  const cardId = Number(params.get("card")) || null;
  return cardId ? <CardDetail id={cardId} go={go} /> : <CardList go={go} />;
}

function CardList({ go }) {
  const { can } = usePermissions();
  const [status, setStatus] = useState("active");
  const list = useLoad(`/maintenance-module/job-cards?status=${status}`, [status]);
  const assets = useLoad(can("mnt.job-cards", "create") ? "/maintenance-module/asset-options" : null);
  const [form, setForm] = useState(null);
  const act = useAction(() => list.load());

  function create() {
    act.run(() => apiRequest("/maintenance-module/job-cards", { method: "POST", body: { asset_id: form.asset_id, jobs: [{ description: form.description, kind: form.kind }] } }))
      .then((r) => { if (r) go("job-cards", { card: r.id }); });
  }

  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}>
        {[["active", "Open & to verify"], ["closed", "Closed"], ["all", "All"]].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setStatus(k)} aria-pressed={status === k}
            style={{ padding: "7px 13px", fontSize: 12.5, borderRadius: 20, background: status === k ? "var(--charcoal)" : "#fff", color: status === k ? "#fff" : "var(--charcoal)" }}>{l}</button>
        ))}
        <div style={{ flex: 1 }} />
        {can("mnt.job-cards", "create") && <button type="button" style={SMALL_BTN} onClick={() => setForm({ asset_id: "", description: "", kind: "inside" })}>+ Job card</button>}
      </div>
      <Msg msg={act.msg} err={act.err} />
      {form && (
        <section className="card" style={{ marginBottom: 16, borderColor: "#E7C3A6" }}>
          <h2 style={H2}>New job card</h2>
          <p style={{ ...MUTED, marginTop: 0 }}>If the machine already has an open card, the job is added to it.</p>
          <div style={GRID(200)}>
            <Field label="Vehicle / machine">
              <select value={form.asset_id} onChange={(e) => setForm({ ...form, asset_id: e.target.value })}>
                <option value="">Select…</option>
                {(assets.data || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Job"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Field label="Inside / outside">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="inside">Inside</option><option value="outside">Outside</option></select>
            </Field>
          </div>
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={create}>Create</button>
          </div>
        </section>
      )}
      {!list.data ? <Loading error={list.error} /> : (
        <section className="card">
          {list.data.length === 0 ? <div style={MUTED}>No job cards here.</div> : (
            <Table minWidth={720}>
              <thead><tr><th>Card</th><th>Equipment</th><th>Opened</th><th>Jobs</th><th>Waiting</th><th style={{ textAlign: "right" }}>Cost</th><th>Status</th></tr></thead>
              <tbody>
                {list.data.map((c) => (
                  <tr key={c.id} onClick={() => go("job-cards", { card: c.id })} style={{ cursor: "pointer" }}>
                    <td><button type="button" style={{ background: "none", border: "none", padding: 0, fontWeight: 700, color: "var(--charcoal)" }}>{c.code}</button></td>
                    <td>{c.asset_name}<div style={MUTED}>{c.general_label ? `General works · ${c.general_label}` : `from ${c.source}`}</div></td>
                    <td>{fmtWhen(c.opened_at)}</td>
                    <td>{c.general_label ? `${c.charges} lubricant issue(s)` : `${c.jobs} (${c.jobs_open} open${c.outside_jobs ? `, ${c.outside_jobs} outside` : ""})`}</td>
                    <td>{c.parts_waiting ? <span className="badge badge-warning">{c.parts_waiting} part(s)</span> : "—"}</td>
                    <td style={{ textAlign: "right" }}>{fmtRs(c.cost)}</td>
                    <td><Badge map={CARD_STATUS} value={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
    </>
  );
}

function CardDetail({ id, go }) {
  const { can } = usePermissions();
  const card = useLoad(`/maintenance-module/job-cards/${id}`, [id]);
  const items = useLoad(card.data ? `/maintenance-module/store/items?asset_id=${card.data.asset_id}` : null, [card.data?.asset_id]);
  const [newJob, setNewJob] = useState(null);
  const [part, setPart] = useState(null);
  const [outside, setOutside] = useState(null);
  const act = useAction(() => card.load());

  if (!card.data) return <Loading error={card.error} />;
  const c = card.data;
  if (c.general_month) return <GeneralCard c={c} go={go} />;
  const open = c.status === "open";
  const canEdit = can("mnt.job-cards", "edit") && open;
  const insideJobs = c.jobs.filter((j) => j.kind === "inside" && j.status !== "cancelled");
  const outsideOpen = c.jobs.filter((j) => j.kind === "outside" && j.status === "open" && !j.outside_repair_id);
  const allItems = items.data?.items || [];

  const patchJob = (j, body, msg) => act.run(() => apiRequest(`/maintenance-module/jobs/${j.id}`, { method: "PATCH", body }), msg);
  const post = (path, body, msg) => act.run(() => apiRequest(`/maintenance-module${path}`, { method: "POST", body }), msg);

  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}>
        <button type="button" style={SMALL_BTN} onClick={() => go("job-cards")}>&larr; All job cards</button>
      </div>
      <section className="card" style={{ marginBottom: 16 }}>
        <div style={{ ...ROW, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ ...MUTED, textTransform: "uppercase", fontSize: 11.5 }}>Job card · {c.code}</div>
            <h1 style={{ fontSize: 21, margin: "2px 0 4px" }}>{c.asset_name}</h1>
            <div style={MUTED}>Opened {fmtWhen(c.opened_at)} by {c.opened_by_name || "—"} · from {c.source}{c.km ? ` · ${fmtNum(c.km)} km` : ""}</div>
          </div>
          <Badge map={CARD_STATUS} value={c.status} />
          <div style={{ textAlign: "right" }}><div className="kpi-label">Cost so far</div><b style={{ fontSize: 19 }}>{fmtRs(c.cost)}</b></div>
        </div>
      </section>

      <Msg msg={act.msg} err={act.err} />

      <section className="card" style={{ marginBottom: 16 }}>
        <div style={ROW}>
          <h2 style={{ ...H2, flex: 1 }}>Jobs</h2>
          {canEdit && <button type="button" style={SMALL_BTN} onClick={() => setNewJob({ description: "", kind: "inside" })}>+ Add job</button>}
        </div>
        <p style={{ ...MUTED, marginTop: 0 }}>Set each job Inside or Outside. Inside jobs use parts from Store; outside jobs go to the Administrator with an estimate.</p>
        <Table minWidth={720}>
          <thead><tr><th>Job</th><th>From</th><th>Inside / outside</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {c.jobs.map((j) => {
              const locked = j.outside_repair_id && !["rejected", "cancelled"].includes(j.outside_status);
              return (
                <tr key={j.id} style={{ opacity: j.status === "cancelled" ? 0.5 : 1 }}>
                  <td>{j.description}{j.raised_by_name && <div style={MUTED}>{j.raised_by_name}{j.urgency && j.urgency !== "normal" ? ` · ${j.urgency}` : ""}{j.machine_stopped ? " · machine stopped" : ""}</div>}</td>
                  <td><Badge map={ORIGIN} value={j.origin} /></td>
                  <td>
                    <div role="group" aria-label={`Inside or outside — ${j.description}`} style={{ display: "flex" }}>
                      {["inside", "outside"].map((k, i) => {
                        const on = j.kind === k;
                        return (
                          <button key={k} type="button" aria-pressed={on} disabled={!canEdit || locked || j.status !== "open"} onClick={() => !on && patchJob(j, { kind: k })}
                            style={{ ...SEG, borderRadius: i ? "0 8px 8px 0" : "8px 0 0 8px", borderLeft: i ? "none" : undefined,
                              background: on ? (k === "outside" ? "var(--violet)" : "var(--charcoal)") : "#fff", color: on ? "#fff" : "var(--charcoal)" }}>
                            {k === "inside" ? "Inside" : "Outside"}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td>
                    {j.status === "done" ? <span className="badge badge-success">Done</span>
                      : j.status === "cancelled" ? <span className="badge badge-neutral">Cancelled</span>
                        : j.outside_status ? <Badge map={OUTSIDE_STATUS} value={j.outside_status} />
                          : j.kind === "outside" ? <span className="badge badge-warning">Estimate to send</span>
                            : <span className="badge badge-info">Open</span>}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {canEdit && j.status === "open" && j.kind === "inside" && <button type="button" style={SMALL_BTN} onClick={() => patchJob(j, { status: "done" }, "Job marked done.")}>Done</button>}{" "}
                    {canEdit && j.status === "open" && !locked && <button type="button" style={SMALL_BTN} onClick={() => patchJob(j, { status: "cancelled" }, "Job cancelled.")}>Cancel</button>}
                    {canEdit && j.status !== "open" && !locked && <button type="button" style={SMALL_BTN} onClick={() => patchJob(j, { status: "open" })}>Reopen</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {newJob && (
          <div style={{ ...ROW, marginTop: 12, alignItems: "flex-end" }}>
            <Field label="Job" style={{ flex: 1, minWidth: 220 }}><input value={newJob.description} onChange={(e) => setNewJob({ ...newJob, description: e.target.value })} /></Field>
            <Field label="Inside / outside"><select value={newJob.kind} onChange={(e) => setNewJob({ ...newJob, kind: e.target.value })}><option value="inside">Inside</option><option value="outside">Outside</option></select></Field>
            <button type="button" onClick={() => setNewJob(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={() => post(`/job-cards/${id}/jobs`, newJob, "Job added.").then((r) => r && setNewJob(null))}>Add</button>
          </div>
        )}
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start", marginBottom: 16 }}>
        <section className="card" style={{ flex: "999 1 560px", minWidth: 0 }}>
          <div style={ROW}>
            <h2 style={{ ...H2, flex: 1 }}>Parts for inside jobs</h2>
            {canEdit && insideJobs.length > 0 && <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => setPart({ job_id: insideJobs[0].id, item_id: "", description: "", qty: "" })}>+ Request part from store</button>}
          </div>
          <p style={{ ...MUTED, marginTop: 0 }}>Store issues from stock, or — if it is not in stock — buys it on a PO (Manager / Administrator approves) and the GRV puts its cost here.</p>
          {part && (
            <div style={{ ...GRID(170), marginBottom: 12, background: "var(--concrete)", padding: 12, borderRadius: 8 }}>
              <Field label="For job">
                <select value={part.job_id} onChange={(e) => setPart({ ...part, job_id: e.target.value })}>
                  {insideJobs.map((j) => <option key={j.id} value={j.id}>{j.description.slice(0, 60)}</option>)}
                </select>
              </Field>
              <Field label="Store item">
                <select value={part.item_id} onChange={(e) => setPart({ ...part, item_id: e.target.value })}>
                  <option value="">Not in the item list — describe it</option>
                  {allItems.map((i) => (
                    <option key={i.id} value={i.id}>{i.name} · {fmtNum(i.current_qty, 2).replace(/\.00$/, "")} {i.unit}{i.fit === 4 ? ` · for ${i.used_for_label}` : ""}</option>
                  ))}
                </select>
              </Field>
              {!part.item_id && <Field label="Describe the part"><input value={part.description} onChange={(e) => setPart({ ...part, description: e.target.value })} /></Field>}
              <Field label="Qty"><input inputMode="decimal" value={part.qty} onChange={(e) => setPart({ ...part, qty: e.target.value })} /></Field>
              <div style={{ ...ROW, alignItems: "flex-end" }}>
                <button type="button" onClick={() => setPart(null)}>Cancel</button>
                <button type="button" className="btn-primary" disabled={act.busy} onClick={() => post(`/job-cards/${id}/part-requests`, part, "Part requested — Store has been notified.").then((r) => r && setPart(null))}>Request</button>
              </div>
            </div>
          )}
          {c.parts.length === 0 ? <div style={MUTED}>No parts requested.</div> : (
            <Table minWidth={560}>
              <thead><tr><th>Part</th><th style={{ textAlign: "right" }}>Qty</th><th>How it came</th><th style={{ textAlign: "right" }}>Cost to card</th><th></th></tr></thead>
              <tbody>
                {c.parts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.item_name || p.description}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(p.issued_qty || p.qty, 2).replace(/\.00$/, "")} {p.unit || ""}</td>
                    <td><Badge map={PART_STATUS} value={p.status} />{p.po_code && <div style={MUTED}>{p.po_code}</div>}</td>
                    <td style={{ textAlign: "right" }}>{p.issue_value != null ? fmtRs(p.issue_value) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      {canEdit && p.status === "requested" && <button type="button" style={SMALL_BTN} onClick={() => post(`/part-requests/${p.id}/cancel`, {}, "Request cancelled.")}>Cancel</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section className="card" style={{ flex: "1 1 300px", minWidth: 0 }}>
          <h2 style={H2}>Cost of this card</h2>
          <Table minWidth={240}>
            <tbody>
              {c.issues.map((t) => (
                <tr key={t.id}><td>{t.item_name}<div style={MUTED}>{fmtNum(t.qty, 2).replace(/\.00$/, "")} {t.unit} · {t.ref_type === "grv" ? "bought (GRV)" : "from stock"}</div></td><td style={{ textAlign: "right" }}>{fmtRs(t.value)}</td></tr>
              ))}
              {c.outside.filter((o) => o.final_amount != null).map((o) => (
                <tr key={o.id}><td>Outside · {o.workshop}<div style={MUTED}>{o.code}</div></td><td style={{ textAlign: "right" }}>{fmtRs(o.final_amount)}</td></tr>
              ))}
              <tr><td><b>Total</b></td><td style={{ textAlign: "right" }}><b>{fmtRs(c.cost)}</b></td></tr>
            </tbody>
          </Table>
        </section>
      </div>

      <section className="card" style={{ marginBottom: 16, borderColor: "#D5C6E6" }}>
        <div style={ROW}>
          <h2 style={{ ...H2, flex: 1 }}>Outside jobs</h2>
          {open && can("mnt.outside-repairs", "create") && outsideOpen.length > 0 && !outside &&
            <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => setOutside({ job_ids: outsideOpen.map((j) => j.id), workshop: "", estimate_amount: "", expected_days: "", advance_amount: "", notes: "" })}>Send estimate to Administrator</button>}
        </div>
        {outside && (
          <div style={{ background: "var(--concrete)", padding: 12, borderRadius: 8, marginBottom: 12 }}>
            <div style={{ ...MUTED, marginBottom: 8 }}>Covers:</div>
            {outsideOpen.map((j) => (
              <label key={j.id} style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0" }}>
                <input type="checkbox" checked={outside.job_ids.includes(j.id)} onChange={(e) => setOutside({ ...outside, job_ids: e.target.checked ? [...outside.job_ids, j.id] : outside.job_ids.filter((x) => x !== j.id) })} />
                {j.description}
              </label>
            ))}
            <div style={{ ...GRID(170), marginTop: 10 }}>
              <Field label="Workshop"><input value={outside.workshop} onChange={(e) => setOutside({ ...outside, workshop: e.target.value })} /></Field>
              <Field label="Estimate ₹"><input inputMode="decimal" value={outside.estimate_amount} onChange={(e) => setOutside({ ...outside, estimate_amount: e.target.value })} /></Field>
              <Field label="Expected days"><input inputMode="numeric" value={outside.expected_days} onChange={(e) => setOutside({ ...outside, expected_days: e.target.value })} /></Field>
              <Field label="Advance asked ₹"><input inputMode="decimal" value={outside.advance_amount} onChange={(e) => setOutside({ ...outside, advance_amount: e.target.value })} /></Field>
              <Field label="Note" style={{ gridColumn: "1 / -1" }}><input value={outside.notes} onChange={(e) => setOutside({ ...outside, notes: e.target.value })} /></Field>
            </div>
            <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
              <button type="button" onClick={() => setOutside(null)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={act.busy} onClick={() => post(`/job-cards/${id}/outside-request`, outside, "Sent to the Administrator for approval.").then((r) => r && setOutside(null))}>Send to Administrator</button>
            </div>
          </div>
        )}
        {c.outside.length === 0 && !outside && <div style={MUTED}>{outsideOpen.length ? `${outsideOpen.length} outside job(s) waiting for an estimate.` : "No outside jobs on this card."}</div>}
        {c.outside.map((o) => (
          <div key={o.id} style={{ ...ROW, padding: "8px 0", borderTop: "1px solid var(--border)" }}>
            <b>{o.code}</b><span>{o.workshop}</span><span style={MUTED}>estimate {fmtRs(o.estimate_amount)}{o.approved_amount ? ` · approved ${fmtRs(o.approved_amount)}` : ""}{o.bill_amount ? ` · bill ${fmtRs(o.bill_amount)}` : ""}</span>
            <div style={{ flex: 1 }} /><Badge map={OUTSIDE_STATUS} value={o.status} />
            {can("mnt.outside-repairs", "view") && <button type="button" style={SMALL_BTN} onClick={() => go("outside", { repair: o.id })}>Open</button>}
          </div>
        ))}
      </section>

      <section className="card" style={{ ...ROW, justifyContent: "flex-end" }}>
        <span style={{ ...MUTED, flex: 1, minWidth: 240 }}>
          {c.status === "open" && "When every job is done (outside jobs come back from the workshop), mark the work done for the Manager to verify."}
          {c.status === "work_done" && `Work done ${fmtWhen(c.work_done_at)} — waiting for the Manager to verify.`}
          {c.status === "closed" && `Verified by ${c.verified_by_name || "—"} on ${fmtDate(c.verified_at)}.`}
        </span>
        {canEdit && <button type="button" className="btn-primary" disabled={act.busy} onClick={() => post(`/job-cards/${id}/work-done`, {}, "Marked work done — the Manager has been notified.")}>Mark work done</button>}
        {c.status === "work_done" && can("mnt.job-verify", "edit") && (
          <>
            <button type="button" disabled={act.busy} onClick={() => post(`/job-cards/${id}/verify`, { reopen: true }, "Reopened.")}>Reopen</button>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={() => post(`/job-cards/${id}/verify`, {}, "Verified and closed.")}>Verify &amp; close</button>
          </>
        )}
        {["open", "work_done"].includes(c.status) && can("mnt.job-verify", "edit") && c.issues.length === 0 && (
          <button type="button" className="btn-danger" disabled={act.busy} onClick={() => window.confirm("Cancel this job card?") && post(`/job-cards/${id}/cancel`, {}, "Job card cancelled.")}>Cancel card</button>
        )}
      </section>
    </>
  );
}

// Round 215b — the vehicle's monthly general-works card. Lubricants issued in
// the Fuel & Store flow land here automatically; it closes itself at month end.
function GeneralCard({ c, go }) {
  const noRate = c.charges.filter((x) => x.amount == null).length;
  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}>
        <button type="button" style={SMALL_BTN} onClick={() => go("job-cards")}>&larr; All job cards</button>
      </div>
      <section className="card" style={{ marginBottom: 16 }}>
        <div style={{ ...ROW, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ ...MUTED, textTransform: "uppercase", fontSize: 11.5 }}>Job card · {c.code} · General works</div>
            <h1 style={{ fontSize: 21, margin: "2px 0 4px" }}>{c.asset_name}</h1>
            <div style={MUTED}>Lubricants and top-ups for {c.general_label}. {c.status === "closed" ? "Closed at month end." : "Fills itself as Store issues; closes itself at month end."}</div>
          </div>
          <Badge map={CARD_STATUS} value={c.status} />
          <div style={{ textAlign: "right" }}><div className="kpi-label">Cost this month</div><b style={{ fontSize: 19 }}>{fmtRs(c.cost)}</b></div>
        </div>
      </section>
      <section className="card">
        <h2 style={H2}>Lubricants issued</h2>
        {c.charges.length === 0 ? <div style={MUTED}>Nothing issued yet.</div> : (
          <Table minWidth={520}>
            <thead><tr><th>When</th><th>Item</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Cost</th></tr></thead>
            <tbody>
              {c.charges.map((x) => (
                <tr key={x.id}>
                  <td>{fmtWhen(x.charged_at)}</td>
                  <td>{x.description}</td>
                  <td style={{ textAlign: "right" }}>{x.qty == null ? "—" : `${fmtNum(x.qty, 2).replace(/\.00$/, "")} ${x.unit || ""}`}</td>
                  <td style={{ textAlign: "right" }}>{x.amount == null ? <span className="badge badge-warning">no rate</span> : fmtRs(x.amount, 2)}</td>
                </tr>
              ))}
              <tr><td colSpan={3}><b>Total</b></td><td style={{ textAlign: "right" }}><b>{fmtRs(c.cost, 2)}</b></td></tr>
            </tbody>
          </Table>
        )}
        {noRate > 0 && <p style={{ ...MUTED, marginBottom: 0 }}>{noRate} issue(s) had no amount entered and no standing rate — set the rate on Store stock, or the cost is left out.</p>}
        <p style={{ ...MUTED, marginBottom: 0 }}>Repairs go on a normal job card — this card only collects lubricant issues.</p>
      </section>
    </>
  );
}
