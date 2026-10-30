// Round 204 — one quotation: its rates beside the site's current price list,
// what can be done with it now, and its history.
//
//   Admin approval sets the final rate. It changes nothing on the price list.
//   The price list changes only when the customer accepts (owner's rule) —
//   a revision needs the signed copy / email / WhatsApp attached.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { todayStr } from "../../lib/istDate.js";
import { splitRate, inr2, fmtDate, STATUS_LABEL } from "../../lib/quotationTerms.js";
import { downloadQuotationPdf, buildQuotationPdf } from "../../lib/quotationPdf.js";
import { FollowupModal } from "./QuotationsTab.jsx";
import { CostBreakup } from "./QuotationBuilder.jsx";
import { TH, TD, NUM, row, StatusBadge, Banner, Field, Modal, Empty, readFileAsDataUrl } from "./ui.jsx";

const EVENT_LABEL = {
  created: "Created", edited: "Edited", submitted: "Sent for approval", approved: "Approved", sent_back: "Sent back for changes",
  sent: "Sent to the customer", followup: "Follow-up", revised: "Revision made", accepted: "Accepted by the customer",
  declined: "Declined", lost: "Lost", cancelled: "Cancelled", extended: "Validity extended", reminder: "Reminder",
};

export default function QuotationView({ meta, id, go, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setError("");
    apiRequest(`/quotations/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id, tick]);

  if (error && !data) return <><button type="button" onClick={onBack}>← Back</button><Banner>{error}</Banner></>;
  if (!data) return <Empty>Loading…</Empty>;
  const q = data.quotation;
  const p = meta.perms;
  const reload = (msg) => { setModal(null); setNotice(msg || ""); setTick((t) => t + 1); };
  const typeLabel = meta.agreement_types.find((t) => t.key === q.agreement_type)?.label;
  const liveBy = Object.fromEntries((data.live_rates || []).map((r) => [r.mix_grade_id, r]));
  const parentBy = Object.fromEntries((data.parent?.lines || []).map((l) => [l.mix_grade_id, l]));

  async function act(path, body, msg) {
    setBusy(path); setError("");
    try { await apiRequest(`/quotations/${q.id}/${path}`, { method: "POST", body: body || {} }); reload(msg); }
    catch (e) { setError(e.message); }
    setBusy("");
  }
  async function pdfData() {
    const d = await apiRequest(`/quotations/${q.id}/print`);
    return { ...d, defaults: meta.defaults };
  }
  async function download() {
    setBusy("pdf"); setError("");
    try { await downloadQuotationPdf(await pdfData()); } catch (e) { setError(e.message); }
    setBusy("");
  }
  async function share() {
    setBusy("share"); setError("");
    try {
      const doc = await buildQuotationPdf(await pdfData());
      const file = new File([doc.output("blob")], `${q.quote_no}.pdf`, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: q.quote_no, text: `Quotation ${q.quote_no} from Our Own Ready Mix` });
      } else {
        doc.save(`${q.quote_no}.pdf`);
        setNotice("This device cannot share a file directly — the PDF was downloaded; attach it in WhatsApp or email.");
      }
    } catch (e) { if (e.name !== "AbortError") setError(e.message); }
    setBusy("");
  }

  const editable = ["draft", "pending_approval"].includes(q.status);
  const withCustomer = ["approved", "sent"].includes(q.status);
  const lines = q.lines || [];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={onBack}>← Register</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{q.quote_no}</h2>
        <StatusBadge status={q.status} />
        {data.family.length > 1 && (
          <span style={{ fontSize: 12, color: "var(--slate)" }}>
            Revisions:{" "}
            {data.family.map((f) => (
              <a key={f.id} href="#" onClick={(e) => { e.preventDefault(); go("quotations", { id: String(f.id) }); }}
                style={{ marginRight: 6, fontWeight: f.id === q.id ? 700 : 400 }}>{f.quote_no.replace(q.family_no, "") || "Original"} ({STATUS_LABEL[f.status]})</a>
            ))}
          </span>
        )}
      </div>
      <Banner>{error}</Banner>
      <Banner kind="ok">{notice}</Banner>

      <div className="card" style={{ marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, fontSize: 13 }}>
        <div><div className="kpi-label">Customer</div><b>{q.billing_name || q.customer_name}</b>{(q.billing_name ? q.billing_address : q.customer_address) && <div style={{ fontSize: 12, whiteSpace: "pre-line" }}>{q.billing_name ? q.billing_address : q.customer_address}</div>}{q.billing_gstin && <div style={{ fontSize: 12 }}>GSTIN {q.billing_gstin}</div>}{q.kind_attention && <div style={{ fontSize: 12, color: "var(--slate)" }}>Attn: {q.kind_attention}</div>}</div>
        <div><div className="kpi-label">Project / site</div>{q.site_name}</div>
        <div><div className="kpi-label">Agreement</div>{typeLabel}{q.terms_modified && <div style={{ fontSize: 11.5, color: "var(--amber)" }}>terms edited for this quotation</div>}</div>
        <div><div className="kpi-label">Dated · valid</div>{fmtDate(q.quote_date)} · {q.valid_until ? `till ${fmtDate(q.valid_until)}` : `${q.validity_days} days from sending`}</div>
        <div><div className="kpi-label">Prepared · approved</div>{q.created_by_name}{q.approved_by_name ? ` · ${q.approved_by_name}` : ""}</div>
        <div><div className="kpi-label">Salesperson</div>{q.salesperson_name || <span style={{ color: "var(--slate)" }}>not set</span>}<div style={{ fontSize: 11, color: "var(--slate)" }}>app only — not printed</div></div>
        {q.status === "accepted" && <div><div className="kpi-label">Accepted</div>{fmtDate(q.accepted_on)} by {String(q.acceptance_mode || "").replace("_", " ")}<div style={{ fontSize: 12 }}>Price list from <b>{fmtDate(q.rates_from)}</b></div></div>}
        {q.revision_reason && <div><div className="kpi-label">Why revised</div>{q.revision_reason}</div>}
      </div>

      <div className="card" style={{ marginBottom: 12, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Grade</th><th style={TH}>Mix design</th><th style={TH}>Description</th><th style={{ ...TH, textAlign: "right" }}>Qty m³</th>
            <th style={{ ...TH, textAlign: "right" }}>Base</th><th style={{ ...TH, textAlign: "right" }}>GST</th>
            <th style={{ ...TH, textAlign: "right" }}>Total ₹/m³</th>
            <th style={{ ...TH, textAlign: "right" }}>{data.parent ? `Was (${data.parent.quote_no.replace(q.family_no, "") || "original"})` : "Current price list"}</th>
            {data.costing && <th style={{ ...TH, textAlign: "right" }}>Proposed rate</th>}
            {lines.some((l) => l.approved != null) && <th style={TH}>Customer</th>}
          </tr></thead>
          <tbody>
            {lines.map((l) => {
              const sp = splitRate(l.rate_total);
              const was = data.parent ? parentBy[l.mix_grade_id]?.rate_total : liveBy[l.mix_grade_id]?.rate_per_m3;
              const diff = was != null ? Number(l.rate_total) - Number(was) : null;
              return (
                <tr key={l.id} style={row}>
                  <td style={{ ...TD, fontWeight: 700 }}>{l.grade_name || l.item_label}</td>
                  <td style={{ ...TD, fontSize: 12.5, whiteSpace: "nowrap" }}>{l.design_ref_code ? `${l.design_ref_code} · rev ${l.design_revision}` : "—"}</td>
                  <td style={TD}>{l.specification || "—"}</td>
                  <td style={NUM}>{l.qty_m3 ?? "—"}</td>
                  <td style={NUM}>{inr2(sp.base)}</td>
                  <td style={NUM}>{inr2(sp.gst)}</td>
                  <td style={{ ...NUM, fontWeight: 700 }}>
                    {inr2(l.rate_total)}
                    {l.proposed_rate != null && Number(l.proposed_rate) !== Number(l.rate_total) && (
                      <div style={{ fontSize: 11, color: "var(--amber)", fontWeight: 400 }}>proposed {inr2(l.proposed_rate)}</div>
                    )}
                  </td>
                  <td style={{ ...NUM, color: "var(--slate)" }}>
                    {was != null ? inr2(was) : "—"}
                    {diff ? <div style={{ fontSize: 11, color: diff > 0 ? "var(--signal-green)" : "var(--alert-red)" }}>{diff > 0 ? "+" : ""}{inr2(diff)}</div> : null}
                  </td>
                  {data.costing && (() => {
                    const c = data.costing.lines[l.id];
                    const below = c ? c.proposed - Number(l.rate_total) : 0;
                    return (
                      <td style={NUM}>
                        {c ? <button type="button" style={{ padding: "3px 8px", fontWeight: 700, background: "none" }} onClick={() => setModal({ cost: c })}>₹{Math.round(c.proposed).toLocaleString("en-IN")}</button> : "—"}
                        {c && below > 0 && <div style={{ fontSize: 11, fontWeight: 600, color: below > c.proposed * 0.01 ? "var(--alert-red)" : "var(--amber)" }}>₹{Math.round(below).toLocaleString("en-IN")} below</div>}
                        {l.cost_rate != null && <div style={{ fontSize: 10.5, color: "var(--slate)" }}>at approval ₹{Math.round(l.cost_rate).toLocaleString("en-IN")}</div>}
                      </td>
                    );
                  })()}
                  {lines.some((x) => x.approved != null) && (
                    <td style={TD}>{l.approved == null ? "—" : l.approved
                      ? <span className="badge badge-success">approved</span>
                      : <span className="badge badge-neutral">not approved</span>}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---------------- what can be done now ---------------- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {q.status === "pending_approval" && p.approve && <button type="button" className="btn-primary" onClick={() => setModal("approve")}>Approve final rates</button>}
          {q.status === "pending_approval" && p.approve && <button type="button" onClick={() => setModal("sendback")}>Send back</button>}
          {q.status === "draft" && p.approve && <button type="button" className="btn-primary" onClick={() => setModal("approve")}>Approve</button>}
          {editable && (p.create || p.edit) && <button type="button" onClick={() => go("quotations", { edit: String(q.id) })}>{q.status === "draft" ? "Edit / send for approval" : "Edit"}</button>}
          {withCustomer && p.edit && <button type="button" className={q.status === "approved" ? "btn-primary" : ""} onClick={() => setModal("sent")}>{q.status === "approved" ? "Mark as sent" : "Sent again"}</button>}
          {q.status === "sent" && p.followup && <button type="button" onClick={() => setModal("followup")}>Log follow-up</button>}
          {withCustomer && p.accept && q.agreement_type !== "price_only" && <button type="button" className="btn-primary" onClick={() => setModal("accept")}>Customer accepted</button>}
          {withCustomer && p.edit && <button type="button" onClick={() => setModal("extend")}>Extend validity</button>}
          {withCustomer && p.edit && <button type="button" onClick={() => setModal("close")}>{q.revision > 0 ? "Customer declined" : "Lost"}</button>}
          {["approved", "sent", "accepted", "lost", "declined"].includes(q.status) && p.create && <button type="button" onClick={() => setModal("revise")}>Revise</button>}
          {editable && p.edit && <button type="button" onClick={() => setModal("cancel")} style={{ color: "var(--alert-red)" }}>Cancel</button>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {q.status !== "cancelled" && <button type="button" onClick={download} disabled={busy === "pdf"}>{busy === "pdf" ? "Preparing…" : "Download PDF"}</button>}
            {["approved", "sent", "accepted"].includes(q.status) && <button type="button" onClick={share} disabled={busy === "share"}>Share</button>}
          </span>
        </div>
        {q.status === "pending_approval" && !p.approve && <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 8 }}>Waiting for the Administrator to approve the final rates.</div>}
        {q.status === "approved" && <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 8 }}>Approved. Send it to the customer — validity starts when it is marked as sent. The site's price list does not change until the customer accepts.</div>}
        {withCustomer && q.revision === 0 && !data.live_rates?.length && <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 6 }}>A new site: the first order placed for it accepts this quotation (clause 9.1) and sets its price list from the order date.</div>}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>History</h3>
        {data.events.map((e) => (
          <div key={e.id} style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
            <span style={{ minWidth: 128, color: "var(--slate)" }}>{new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            <span><b>{EVENT_LABEL[e.event] || e.event}</b>{e.by_name ? ` · ${e.by_name}` : ""}
              {e.outcome && <span style={{ color: "var(--slate)" }}> · {e.outcome.replace("_", " ")}</span>}
              {e.contact && <span style={{ color: "var(--slate)" }}> · spoke to {e.contact}</span>}
              {e.note && <div style={{ color: "var(--slate)" }}>{e.note}</div>}
              {e.next_followup_on && <div style={{ color: "var(--slate)" }}>Next follow-up {fmtDate(String(e.next_followup_on).slice(0, 10))}</div>}
            </span>
          </div>
        ))}
        {q.acceptance_comment && q.status === "accepted" && <div style={{ fontSize: 12.5 }}><span className="kpi-label">Acceptance comment</span><div>{q.acceptance_comment}</div></div>}
        {q.acceptance_proof_name && q.status === "accepted" && (
          <button type="button" style={{ marginTop: 8, fontSize: 12 }} onClick={async () => {
            try { const d = await apiRequest(`/quotations/${q.id}/proof`); const a = document.createElement("a"); a.href = d.data; a.download = d.name || "acceptance"; a.click(); }
            catch (e) { setError(e.message); }
          }}>Open the acceptance proof</button>
        )}
      </div>

      {modal === "approve" && <ApproveModal q={q} onClose={() => setModal(null)} onDone={() => reload("Approved. Send it to the customer.")} />}
      {modal === "sendback" && <ReasonModal title="Send back for changes" label="What needs changing" busy={busy} onClose={() => setModal(null)} onSave={(note) => act("send-back", { note }, "Sent back to the preparer.")} />}
      {modal === "sent" && <SentModal busy={busy} onClose={() => setModal(null)} onSave={(via) => act("mark-sent", { via }, "Marked as sent — follow-up reminders start now.")} />}
      {modal === "followup" && <FollowupModal q={q} onClose={() => setModal(null)} onSaved={() => reload("Follow-up saved.")} />}
      {modal === "extend" && <ExtendModal busy={busy} onClose={() => setModal(null)} onSave={(days) => act("extend", { days }, "Validity extended.")} />}
      {modal === "close" && <ReasonModal title={q.revision > 0 ? "Customer declined the revision" : "Quotation lost"} label={q.revision > 0 ? "Why — the current price list stays" : "Why was it lost"} busy={busy} onClose={() => setModal(null)} onSave={(reason) => act("close", { reason }, "Closed.")} />}
      {modal === "cancel" && <ReasonModal title="Cancel this quotation" label="Reason" busy={busy} onClose={() => setModal(null)} onSave={(reason) => act("cancel", { reason }, "Cancelled.")} />}
      {modal === "revise" && <ReasonModal title="Make a revision" label="Why — e.g. cement price up, customer asked for a better rate" busy={busy} onClose={() => setModal(null)}
        onSave={async (reason) => {
          setBusy("revise"); setError("");
          try { const r = await apiRequest(`/quotations/${q.id}/revise`, { method: "POST", body: { reason } }); go("quotations", { edit: String(r.id) }); }
          catch (e) { setError(e.message); setModal(null); }
          setBusy("");
        }} />}
      {modal?.cost && <CostBreakup c={modal.cost} onClose={() => setModal(null)} />}
      {modal === "accept" && <AcceptModal q={q} onClose={() => setModal(null)} onDone={(r) => reload(`Accepted. The price list now uses these rates from the date given${r.repriced?.updated || r.repriced?.created ? ` — ${r.repriced.created} held invoice(s) raised, ${r.repriced.updated} unpaid invoice(s) re-priced` : ""}${r.repriced?.flagged ? `; ${r.repriced.flagged} paid invoice(s) sent to the Accountant to review` : ""}.`)} />}
    </>
  );
}

function ReasonModal({ title, label, busy, onClose, onSave }) {
  const [v, setV] = useState("");
  return (
    <Modal title={title} onClose={onClose} width={480}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
        <Field label={label}><textarea rows={3} required value={v} onChange={(e) => setV(e.target.value)} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!!busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function SentModal({ busy, onClose, onSave }) {
  const [via, setVia] = useState("whatsapp");
  return (
    <Modal title="Sent to the customer" onClose={onClose} width={420}>
      <Field label="How was it sent">
        <select value={via} onChange={(e) => setVia(e.target.value)}>
          <option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="by_hand">By hand</option>
        </select>
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!!busy} onClick={() => onSave(via)}>Mark as sent</button>
      </div>
    </Modal>
  );
}

function ExtendModal({ busy, onClose, onSave }) {
  const [days, setDays] = useState(7);
  return (
    <Modal title="Extend validity" onClose={onClose} width={400}>
      <Field label="Extend by (days, from today or the current expiry, whichever is later)"><input type="number" min="1" max="60" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!!busy} onClick={() => onSave(Number(days))}>Extend</button>
      </div>
    </Modal>
  );
}

function ApproveModal({ q, onClose, onDone }) {
  const [rates, setRates] = useState(() => Object.fromEntries(q.lines.map((l) => [l.id, l.rate_total])));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError("");
    try {
      await apiRequest(`/quotations/${q.id}/approve`, { method: "POST", body: { note, lines: q.lines.map((l) => ({ id: l.id, rate_total: Number(rates[l.id]) })) } });
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title={`Approve final rates · ${q.quote_no}`} onClose={onClose} width={620}>
      <Banner>{error}</Banner>
      <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 8 }}>Change any rate before approving — the proposed rate is kept on record. Rates include GST.</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
        <thead><tr><th style={TH}>Grade</th><th style={{ ...TH, textAlign: "right" }}>Proposed</th><th style={{ ...TH, textAlign: "right" }}>Final ₹/m³</th><th style={{ ...TH, textAlign: "right" }}>Base · GST</th></tr></thead>
        <tbody>
          {q.lines.map((l) => {
            const sp = splitRate(rates[l.id]);
            return (
              <tr key={l.id} style={row}>
                <td style={{ ...TD, fontWeight: 700 }}>{l.grade_name || l.item_label}</td>
                <td style={NUM}>{inr2(l.rate_total)}</td>
                <td style={NUM}><input type="number" step="0.01" value={rates[l.id]} onChange={(e) => setRates({ ...rates, [l.id]: e.target.value })} style={{ width: 110, textAlign: "right", fontWeight: 700 }} /></td>
                <td style={{ ...NUM, fontSize: 12, color: "var(--slate)" }}>{inr2(sp.base)} · {inr2(sp.gst)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Approving…" : "Approve"}</button>
      </div>
    </Modal>
  );
}

function AcceptModal({ q, onClose, onDone }) {
  const [f, setF] = useState({ mode: "signed_copy", accepted_on: todayStr(), rates_from: todayStr(), proof: null, proof_name: "", comment: "" });
  // Round 209 — the customer may approve only some of the grades proposed.
  const gradeLines = q.lines.filter((l) => l.mix_grade_id);
  const [ok, setOk] = useState(() => Object.fromEntries(gradeLines.map((l) => [l.id, true])));
  const approvedCount = gradeLines.filter((l) => ok[l.id]).length;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function pick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) { setError("That file is over 6 MB — use a smaller photo or PDF."); return; }
    setF({ ...f, proof: await readFileAsDataUrl(file), proof_name: file.name });
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    if (!approvedCount) { setError("Tick at least one grade the customer approved."); setBusy(false); return; }
    if (!f.proof && !f.comment.trim()) { setError("Attach the proof, or write a comment on how the customer accepted."); setBusy(false); return; }
    try { onDone(await apiRequest(`/quotations/${q.id}/accept`, { method: "POST", body: { ...f, approved_line_ids: gradeLines.filter((l) => ok[l.id]).map((l) => l.id) } })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={`Customer accepted · ${q.quote_no}`} onClose={onClose} width={640}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 6 }}>Tick the grades / mixes the customer approved. Only these go into the price list and can be ordered; the rest are kept as not approved — the Administrator can enable one later.</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10, fontSize: 13 }}>
          <thead><tr><th style={TH}>Approved</th><th style={TH}>Grade</th><th style={TH}>Mix design</th><th style={TH}>Description</th><th style={{ ...TH, textAlign: "right" }}>₹/m³</th></tr></thead>
          <tbody>
            {gradeLines.map((l) => (
              <tr key={l.id} style={{ ...row, color: ok[l.id] ? undefined : "var(--slate)" }}>
                <td style={TD}><label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!ok[l.id]} onChange={(e) => setOk({ ...ok, [l.id]: e.target.checked })} style={{ width: "auto" }} /> {ok[l.id] ? "Yes" : "No"}</label></td>
                <td style={{ ...TD, fontWeight: 700 }}>{l.grade_name}</td>
                <td style={{ ...TD, fontSize: 12, whiteSpace: "nowrap" }}>{l.design_ref_code ? `${l.design_ref_code} · rev ${l.design_revision}` : "—"}</td>
                <td style={{ ...TD, fontSize: 12.5 }}>{l.specification || "—"}</td>
                <td style={NUM}>{inr2(l.rate_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Field label="How did the customer accept">
          <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            <option value="signed_copy">Signed copy</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option>
          </select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Accepted on"><input type="date" value={f.accepted_on} max={todayStr()} onChange={(e) => setF({ ...f, accepted_on: e.target.value })} /></Field>
          <Field label="New rates apply from" hint="Orders dated from this day use the new rates."><input type="date" value={f.rates_from} onChange={(e) => setF({ ...f, rates_from: e.target.value })} /></Field>
        </div>
        {/* Round 252 — a file OR a comment. */}
        <Field label="Proof of acceptance (optional)" hint="Photo of the signed copy, or a screenshot of the email / WhatsApp. Up to 6 MB.">
          <input type="file" accept="image/*,application/pdf" onChange={pick} />
        </Field>
        <Field label={f.proof ? "Comment (optional)" : "Comment — needed when no file is attached"} hint="e.g. “Confirmed by phone with the site engineer, 30 Oct”.">
          <textarea rows={2} maxLength={500} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </Field>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>
          The site's price list changes now. Unpaid invoices for orders dated from that day are re-priced; any already paid are sent to the Accountant to review.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : `Accept — ${approvedCount} of ${gradeLines.length} approved`}</button>
        </div>
      </form>
    </Modal>
  );
}
