// Round 204 — new / edit quotation (Manager or Administrator). The rate per
// grade is typed INCLUDING GST; base price and GST are worked out beside it.
// Charges and payment terms start from Settings → defaults, and fill the
// standard terms of the agreement type chosen. Saving as "Send for approval"
// goes to the Administrator; an Administrator's own quotation is approved as
// it is saved.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { todayStr } from "../../lib/istDate.js";
import { splitRate, inr2, filledTerms } from "../../lib/quotationTerms.js";
import { quotationPdfBlobUrl } from "../../lib/quotationPdf.js";
import { TH, TD, NUM, row, Banner, Field, Modal, Empty } from "./ui.jsx";

const blankLine = () => ({ mix_grade_id: "", item_label: "", specification: "", qty_m3: "", rate_total: "" });

const CHARGE_FIELDS = [
  ["line_pump_min_qty", "Line pump: below (m³)"], ["line_pump_charge", "Line pump charge ₹/day"],
  ["boom_min_charge", "Boom: minimum charge ₹"], ["boom_min_qty", "Boom: minimum covers (m³)"],
  ["boom_rate_above", "Boom: above that, ₹/m³"], ["part_load_min_qty", "Part load: below (m³ per truck)"],
  ["part_load_rate", "Part load ₹ per m³ short"], ["waiting_free_hours", "Free unloading time (hours)"],
  ["waiting_rate", "Waiting ₹ per hour"], ["extra_cement_rate", "Extra cement ₹ per kg"],
];

export default function QuotationBuilder({ meta, id, customerId, siteId, onCancel, onSaved }) {
  const [customers, setCustomers] = useState(null);
  const [sites, setSites] = useState([]);
  const [grades, setGrades] = useState([]);
  const [salespersons, setSalespersons] = useState([]);
  const [billing, setBilling] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [termsOpen, setTermsOpen] = useState(false);
  const [quick, setQuick] = useState(null);     // "customer" | "site"
  const [live, setLive] = useState(null);       // the site's current price list
  const defaults = meta.defaults || {};
  const [f, setF] = useState({
    customer_id: customerId || "", site_id: siteId || "", billing_address_id: "", kind_attention: "",
    agreement_type: "pay_after_delivery", quote_date: todayStr(), validity_days: meta.validity_days || 7,
    charges: { ...(defaults.charges || {}) }, payment: { ...(defaults.payment || {}) },
    rebate_per_m3: "", special_conditions: "", terms: null, terms_modified: false,
    lines: [blankLine()],
  });
  const [status, setStatus] = useState("draft");
  const [quoteNo, setQuoteNo] = useState("");

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites"), apiRequest("/master/mix-grades"), apiRequest("/master/salespersons").catch(() => [])])
      .then(([c, s, g, sp]) => { setCustomers(c); setSites(s); setGrades(g); setSalespersons(sp); })
      .catch((e) => setError(e.message));
    if (id) {
      apiRequest(`/quotations/${id}`).then(({ quotation: q }) => {
        setStatus(q.status); setQuoteNo(q.quote_no);
        setF({
          customer_id: String(q.customer_id), site_id: String(q.site_id), billing_address_id: q.billing_address_id ? String(q.billing_address_id) : "",
          kind_attention: q.kind_attention || "", agreement_type: q.agreement_type, quote_date: String(q.quote_date).slice(0, 10),
          validity_days: q.validity_days, charges: { ...(defaults.charges || {}), ...(q.charges || {}) }, payment: { ...(defaults.payment || {}), ...(q.payment || {}) },
          rebate_per_m3: q.rebate_per_m3 ?? "", special_conditions: q.special_conditions || "", terms: q.terms, terms_modified: q.terms_modified,
          lines: q.lines.map((l) => ({ mix_grade_id: l.mix_grade_id ? String(l.mix_grade_id) : "extra", item_label: l.item_label || "", specification: l.specification || "", qty_m3: l.qty_m3 ?? "", rate_total: l.rate_total })),
        });
      }).catch((e) => setError(e.message));
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!f.customer_id) { setBilling([]); return; }
    apiRequest(`/administrator/customers/${f.customer_id}/billing-addresses`).then((b) => setBilling(b.filter((x) => x.is_active !== false))).catch(() => setBilling([]));
  }, [f.customer_id]);

  useEffect(() => {
    if (!f.customer_id || !f.site_id) { setLive(null); return; }
    apiRequest(`/quotations/price-lists/${f.customer_id}`)
      .then((d) => setLive(d.sites.find((s) => String(s.site.id) === String(f.site_id)) || null))
      .catch(() => setLive(null));
  }, [f.customer_id, f.site_id]);

  const siteOptions = useMemo(() => sites.filter((s) => String(s.customer_id) === String(f.customer_id)), [sites, f.customer_id]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setCharge = (k, v) => setF((p) => ({ ...p, charges: { ...p.charges, [k]: v } }));
  const setPay = (k, v) => setF((p) => ({ ...p, payment: { ...p.payment, [k]: v } }));
  const setLine = (i, k, v) => setF((p) => ({ ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const liveRate = (gradeId) => live?.rates?.find((r) => String(r.mix_grade_id) === String(gradeId));

  // Changing the type brings that type's standard terms, unless they were edited.
  function changeType(t) {
    setF((p) => ({ ...p, agreement_type: t, terms: p.terms_modified ? p.terms : null }));
  }
  const termsForType = f.terms || meta.library[f.agreement_type]?.terms;

  function body(submit) {
    return {
      ...f, submit,
      terms: f.terms_modified ? f.terms : termsForType,
      lines: f.lines.filter((l) => l.mix_grade_id || l.item_label || l.rate_total)
        .map((l) => ({ ...l, mix_grade_id: l.mix_grade_id === "extra" ? null : l.mix_grade_id })),
    };
  }

  async function save(submit) {
    setBusy(submit ? "submit" : "draft"); setError("");
    try {
      const res = id
        ? await apiRequest(`/quotations/${id}`, { method: "PUT", body: body(submit) })
        : await apiRequest("/quotations", { method: "POST", body: body(submit) });
      onSaved(id || res.id);
    } catch (e) { setError(e.message); window.scrollTo(0, 0); }
    setBusy("");
  }

  async function preview() {
    setBusy("preview"); setError("");
    try {
      const c = customers.find((x) => String(x.id) === String(f.customer_id));
      const s = sites.find((x) => String(x.id) === String(f.site_id));
      const b = billing.find((x) => String(x.id) === String(f.billing_address_id));
      const q = {
        ...f, quote_no: quoteNo || "RMC-QTN-(number on saving)", customer_name: c?.name, site_name: s?.name,
        billing_name: b?.name, billing_address: b?.address, billing_gstin: b?.gstin, terms: termsForType,
        lines: f.lines.filter((l) => Number(l.rate_total) > 0).map((l) => ({ ...l, grade_name: grades.find((g) => String(g.id) === String(l.mix_grade_id))?.name })),
      };
      const url = await quotationPdfBlobUrl({ quotation: q, settings: { bank_accounts: meta.bank_accounts, director_name: meta.director.name, director_title: meta.director.title, director_phone: meta.director.phone }, defaults });
      window.open(url, "_blank");
    } catch (e) { setError(e.message); }
    setBusy("");
  }

  if (!customers) return <Empty>Loading…</Empty>;
  const canApprove = meta.perms.approve;
  const isCredit = f.agreement_type === "credit" || f.agreement_type === "credit_qty";

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button type="button" onClick={onCancel}>← Back</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{id ? `Edit ${quoteNo}` : "New quotation"}</h2>
        {status === "pending_approval" && <span className="badge badge-warning">Waiting for approval — saving keeps it there</span>}
      </div>
      <Banner>{error}</Banner>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "0 14px" }}>
          <Field label="Customer">
            <div style={{ display: "flex", gap: 6 }}>
              <select value={f.customer_id} onChange={(e) => setF((p) => ({ ...p, customer_id: e.target.value, site_id: "", billing_address_id: "" }))}>
                <option value="">Choose…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" style={{ padding: "6px 10px" }} onClick={() => setQuick("customer")} title="Add a new customer">+</button>
            </div>
          </Field>
          <Field label="Project / site">
            <div style={{ display: "flex", gap: 6 }}>
              <select value={f.site_id} onChange={(e) => set("site_id", e.target.value)} disabled={!f.customer_id}>
                <option value="">Choose…</option>
                {siteOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button type="button" style={{ padding: "6px 10px" }} disabled={!f.customer_id} onClick={() => setQuick("site")} title="Add a new site">+</button>
            </div>
          </Field>
          <Field label="Billing name & GSTIN" hint={billing.length ? null : "None on file — the customer's name and address print."}>
            <select value={f.billing_address_id} onChange={(e) => set("billing_address_id", e.target.value)} disabled={!billing.length}>
              <option value="">Customer's own name and address</option>
              {billing.map((b) => <option key={b.id} value={b.id}>{b.name}{b.gstin ? ` · ${b.gstin}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Kind attention"><input value={f.kind_attention} onChange={(e) => set("kind_attention", e.target.value)} placeholder="Name of the person" /></Field>
          <Field label="Agreement type">
            <select value={f.agreement_type} onChange={(e) => changeType(e.target.value)}>
              {meta.agreement_types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Quotation date"><input type="date" value={f.quote_date} onChange={(e) => set("quote_date", e.target.value)} /></Field>
          <Field label="Valid for (days)" hint="Counted from the day it is sent."><input type="number" min="1" max="90" value={f.validity_days} onChange={(e) => set("validity_days", e.target.value)} /></Field>
        </div>
      </div>

      <div className="card field-input" style={{ marginBottom: 12, padding: 0, overflowX: "auto" }}>
        <div style={{ padding: "12px 14px 4px", display: "flex", alignItems: "baseline", gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Grades and rates</h3>
          <span style={{ fontSize: 12, color: "var(--slate)" }}>Type the total rate per m³ including GST — the base price and GST are worked out.</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Grade</th><th style={TH}>Specification (cementitious content)</th>
            <th style={{ ...TH, textAlign: "right" }}>{f.agreement_type === "credit_qty" ? "Committed m³" : "Qty m³ (optional)"}</th>
            <th style={{ ...TH, textAlign: "right" }}>Total rate ₹/m³ incl. GST</th>
            <th style={{ ...TH, textAlign: "right" }}>Base</th><th style={{ ...TH, textAlign: "right" }}>GST 18%</th>
            <th style={{ ...TH, textAlign: "right" }}>Current price list</th><th style={TH} />
          </tr></thead>
          <tbody>
            {f.lines.map((l, i) => {
              const sp = splitRate(l.rate_total);
              const lr = l.mix_grade_id ? liveRate(l.mix_grade_id) : null;
              return (
                <tr key={i} style={row}>
                  <td style={TD}>
                    <select value={l.mix_grade_id} onChange={(e) => setLine(i, "mix_grade_id", e.target.value)} style={{ minWidth: 110 }}>
                      <option value="">Grade…</option>
                      {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      <option value="extra">Extra item…</option>
                    </select>
                    {l.mix_grade_id === "extra" && <input placeholder="Item name" value={l.item_label} onChange={(e) => setLine(i, "item_label", e.target.value)} style={{ marginTop: 4, width: 120 }} />}
                  </td>
                  <td style={TD}><input value={l.specification} onChange={(e) => setLine(i, "specification", e.target.value)} placeholder="OPC (320 KG/M3)" style={{ width: "100%", minWidth: 180 }} /></td>
                  <td style={NUM}><input type="number" min="0" value={l.qty_m3} onChange={(e) => setLine(i, "qty_m3", e.target.value)} style={{ width: 90, textAlign: "right" }} /></td>
                  <td style={NUM}><input type="number" min="0" step="0.01" value={l.rate_total} onChange={(e) => setLine(i, "rate_total", e.target.value)} style={{ width: 110, textAlign: "right", fontWeight: 700 }} /></td>
                  <td style={NUM}>{l.rate_total ? inr2(sp.base) : "—"}</td>
                  <td style={NUM}>{l.rate_total ? inr2(sp.gst) : "—"}</td>
                  <td style={{ ...NUM, color: "var(--slate)" }}>
                    {lr ? <>₹{inr2(lr.rate_per_m3)}{Number(l.rate_total) > 0 && Number(l.rate_total) !== Number(lr.rate_per_m3) && (
                      <div style={{ fontSize: 11, color: Number(l.rate_total) > Number(lr.rate_per_m3) ? "var(--signal-green)" : "var(--alert-red)" }}>
                        {Number(l.rate_total) > Number(lr.rate_per_m3) ? "+" : ""}{inr2(Number(l.rate_total) - Number(lr.rate_per_m3))}
                      </div>)}</> : "—"}
                  </td>
                  <td style={TD}>
                    {f.lines.length > 1 && <button type="button" style={{ padding: "4px 9px" }} onClick={() => setF((p) => ({ ...p, lines: p.lines.filter((_, j) => j !== i) }))} aria-label="Remove line">✕</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ padding: "8px 14px 12px" }}>
          <button type="button" onClick={() => setF((p) => ({ ...p, lines: [...p.lines, blankLine()] }))} disabled={f.lines.length >= 12}>+ Add grade</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))", gap: 12, marginBottom: 12 }}>
        <div className="card">
          <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Other charges</h3>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
            General rules printed in the terms. The Manager decides on each order whether pump and part load charges apply.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 10px" }}>
            {CHARGE_FIELDS.map(([k, label]) => (
              <Field key={k} label={label}><input type="number" min="0" value={f.charges[k] ?? ""} onChange={(e) => setCharge(k, e.target.value === "" ? null : Number(e.target.value))} /></Field>
            ))}
            {[["waterproofing", "Waterproofing admixture"], ["fiber", "Fiber"]].map(([k, label]) => (
              <Field key={k} label={label}>
                <select value={f.charges[k] || "on_request"} onChange={(e) => setCharge(k, e.target.value)}>
                  <option value="on_request">On request, extra charge</option>
                  <option value="rate">At a rate per m³</option>
                  <option value="included">Included in the price</option>
                </select>
                {f.charges[k] === "rate" && <input type="number" min="0" placeholder="₹ per m³" value={f.charges[`${k}_rate`] ?? ""} onChange={(e) => setCharge(`${k}_rate`, e.target.value === "" ? null : Number(e.target.value))} style={{ marginTop: 4 }} />}
              </Field>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Payment terms</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 10px" }}>
            {isCredit && <>
              <Field label="Credit period (days)"><input type="number" min="0" value={f.payment.credit_days ?? ""} onChange={(e) => setPay("credit_days", Number(e.target.value))} /></Field>
              <Field label="Credit limit ₹"><input type="number" min="0" value={f.payment.credit_limit ?? ""} onChange={(e) => setPay("credit_limit", Number(e.target.value))} /></Field>
            </>}
            {f.agreement_type === "cash" && (
              <Field label="Advance before dispatch %"><input type="number" min="0" max="100" value={f.payment.advance_pct ?? 100} onChange={(e) => setPay("advance_pct", Number(e.target.value))} /></Field>
            )}
            {f.agreement_type === "pay_after_delivery" && (
              <Field label="Pay within (days of delivery)"><input type="number" min="0" value={f.payment.pay_within_days ?? 1} onChange={(e) => setPay("pay_within_days", Number(e.target.value))} /></Field>
            )}
            <Field label="Interest on delay % p.a."><input type="number" min="0" value={f.payment.interest_pct ?? ""} onChange={(e) => setPay("interest_pct", Number(e.target.value))} /></Field>
            <Field label="Invoice disputes within (hours)"><input type="number" min="0" value={f.payment.dispute_hours ?? ""} onChange={(e) => setPay("dispute_hours", Number(e.target.value))} /></Field>
            {f.agreement_type === "credit_qty" && (
              <Field label="Rebate ₹ per m³ on reaching the commitment"><input type="number" min="0" value={f.rebate_per_m3} onChange={(e) => set("rebate_per_m3", e.target.value)} /></Field>
            )}
          </div>
          <Field label="Special conditions (one per line — printed as their own section)">
            <textarea rows={3} value={f.special_conditions} onChange={(e) => set("special_conditions", e.target.value)} />
          </Field>
          <div style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span>Terms: <b>{f.terms_modified ? "edited for this quotation" : `standard ${meta.agreement_types.find((t) => t.key === f.agreement_type)?.label} terms`}</b></span>
            <button type="button" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setTermsOpen(true)}>View / edit terms</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", padding: "10px 0" }}>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" onClick={preview} disabled={!!busy || !f.customer_id || !f.site_id}>{busy === "preview" ? "Preparing…" : "Preview PDF"}</button>
        {status !== "pending_approval" && <button type="button" onClick={() => save(false)} disabled={!!busy}>{busy === "draft" ? "Saving…" : "Save draft"}</button>}
        <button type="button" className="btn-primary" onClick={() => save(true)} disabled={!!busy}>
          {busy === "submit" ? "Saving…" : canApprove ? "Save & approve" : status === "pending_approval" ? "Save — keep for approval" : "Send for approval"}
        </button>
      </div>

      {termsOpen && (
        <TermsEditor terms={termsForType} q={f} defaults={defaults} onClose={() => setTermsOpen(false)}
          onReset={() => { setF((p) => ({ ...p, terms: null, terms_modified: false })); setTermsOpen(false); }}
          onSave={(t) => { setF((p) => ({ ...p, terms: t, terms_modified: true })); setTermsOpen(false); }} />
      )}
      {quick && (
        <QuickAdd kind={quick} customerId={f.customer_id} salespersons={salespersons} onClose={() => setQuick(null)}
          onAdded={(rec) => {
            if (quick === "customer") { setCustomers((c) => [...c, rec].sort((a, b) => a.name.localeCompare(b.name))); setF((p) => ({ ...p, customer_id: String(rec.id), site_id: "" })); }
            else { setSites((s) => [...s, rec]); set("site_id", String(rec.id)); }
            setQuick(null);
          }} />
      )}
    </>
  );
}

// The quotation's own copy of the terms. Placeholders like {credit_days}
// stay as they are — they fill from the charges and payment terms above.
export function TermsEditor({ terms, q, defaults, onClose, onSave, onReset, title = "Terms of this quotation" }) {
  const [t, setT] = useState(() => JSON.parse(JSON.stringify(terms || { parties: [], sections: [], closing: [] })));
  const [showFilled, setShowFilled] = useState(false);
  const filled = useMemo(() => (q ? filledTerms({ ...q, terms: t }, defaults) : null), [t, q, defaults]);
  const upd = (fn) => setT((p) => { const n = JSON.parse(JSON.stringify(p)); fn(n); return n; });
  const ta = { width: "100%", fontSize: 12.5, fontFamily: "inherit" };
  return (
    <Modal title={title} onClose={onClose} width={860}>
      {q && (
        <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
          <input type="checkbox" checked={showFilled} onChange={(e) => setShowFilled(e.target.checked)} style={{ width: "auto" }} /> Show as it will print (values filled in)
        </label>
      )}
      {showFilled && filled ? (
        <div style={{ fontSize: 12.5 }}>
          {filled.parties.map((p, i) => <p key={i}>{p}</p>)}
          {filled.sections.map((s, i) => (
            <div key={i}><b>{s.no ? `${s.no}. ` : ""}{s.title}</b>
              {s.clauses.map((c, j) => <div key={j} style={{ display: "flex", gap: 8, margin: "4px 0" }}><b style={{ minWidth: 28 }}>{c.no}</b><span style={{ whiteSpace: "pre-wrap" }}>{c.kind === "bank" ? "[Bank account table]" : c.text}</span></div>)}
            </div>
          ))}
          {filled.closing.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 8 }}>
            Words in braces — e.g. {"{credit_days}"}, {"{line_pump_charge}"} — are filled from the quotation's charges and payment terms.
          </div>
          {t.parties?.length > 0 && <h4 style={{ margin: "6px 0" }}>Parties</h4>}
          {(t.parties || []).map((p, i) => (
            <textarea key={i} rows={3} style={ta} value={p} onChange={(e) => upd((n) => { n.parties[i] = e.target.value; })} />
          ))}
          {t.sections.map((s, si) => (
            <div key={si} style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b style={{ minWidth: 22 }}>{s.no}</b>
                <input value={s.title} onChange={(e) => upd((n) => { n.sections[si].title = e.target.value; })} style={{ fontWeight: 700, flex: 1 }} />
              </div>
              {s.clauses.map((c, ci) => (
                <div key={ci} style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input value={c.no} onChange={(e) => upd((n) => { n.sections[si].clauses[ci].no = e.target.value; })} style={{ width: 46 }} />
                  {c.kind === "bank"
                    ? <div style={{ fontSize: 12.5, color: "var(--slate)", flex: 1, alignSelf: "center" }}>Bank account table (from Settings)</div>
                    : <textarea rows={Math.min(8, Math.ceil((c.text || "").length / 110) + 1)} style={{ ...ta, flex: 1 }} value={c.text} onChange={(e) => upd((n) => { n.sections[si].clauses[ci].text = e.target.value; })} />}
                  <button type="button" style={{ padding: "4px 8px", alignSelf: "flex-start" }} onClick={() => upd((n) => { n.sections[si].clauses.splice(ci, 1); })} aria-label="Remove clause">✕</button>
                </div>
              ))}
              <button type="button" style={{ marginTop: 6, fontSize: 12, padding: "4px 10px" }}
                onClick={() => upd((n) => { const cl = n.sections[si].clauses; cl.push({ no: `${s.no ? `${s.no}.` : ""}${cl.length + 1}`, text: "" }); })}>+ Clause</button>
            </div>
          ))}
          <h4 style={{ margin: "14px 0 6px" }}>Closing</h4>
          {(t.closing || []).map((p, i) => (
            <textarea key={i} rows={2} style={ta} value={p} onChange={(e) => upd((n) => { n.closing[i] = e.target.value; })} />
          ))}
        </>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
        {onReset && <button type="button" onClick={onReset} style={{ marginRight: "auto" }}>Back to the standard terms</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => onSave(t)}>Use these terms</button>
      </div>
    </Modal>
  );
}

function QuickAdd({ kind, customerId, salespersons, onClose, onAdded }) {
  const [f, setF] = useState({ name: "", contact_number: "", billing_address: "", address: "", assigned_sales_representative_id: salespersons[0]?.id || "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const rec = kind === "customer"
        ? await apiRequest("/administrator/customers", { method: "POST", body: { name: f.name, contact_number: f.contact_number, billing_address: f.billing_address } })
        : await apiRequest("/administrator/sites", { method: "POST", body: { customer_id: Number(customerId), name: f.name, address: f.address, assigned_sales_representative_id: Number(f.assigned_sales_representative_id) } });
      onAdded({ ...rec, customer_id: rec.customer_id ?? Number(customerId) });
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={kind === "customer" ? "New customer" : "New project / site"} onClose={onClose} width={460}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <Field label={kind === "customer" ? "Customer name" : "Site name"}><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        {kind === "customer" ? <>
          <Field label="Contact number"><input value={f.contact_number} onChange={(e) => setF({ ...f, contact_number: e.target.value })} /></Field>
          <Field label="Billing address"><textarea rows={3} value={f.billing_address} onChange={(e) => setF({ ...f, billing_address: e.target.value })} /></Field>
        </> : <>
          <Field label="Site address / location"><textarea rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="Salesperson for this site">
            <select required value={f.assigned_sales_representative_id} onChange={(e) => setF({ ...f, assigned_sales_representative_id: e.target.value })}>
              <option value="">Choose…</option>
              {salespersons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Adding…" : "Add"}</button>
        </div>
      </form>
    </Modal>
  );
}
