// Round 204 — quotation settings (Administrator edits, Manager may look):
// the next number, validity, the director's name and signature (uploaded
// here, never a public file), bank accounts printed in the terms, the default
// charges and payment terms, and the standard terms of each agreement type.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { fmtDate } from "../../lib/quotationTerms.js";
import { TermsEditor } from "./QuotationBuilder.jsx";
import { Banner, Field, Empty, readFileAsDataUrl } from "./ui.jsx";

const CHARGE_LABELS = {
  line_pump_min_qty: "Line pump: below (m³)", line_pump_charge: "Line pump ₹/day", boom_min_charge: "Boom minimum ₹",
  boom_min_qty: "Boom minimum covers (m³)", boom_rate_above: "Boom above, ₹/m³", part_load_min_qty: "Part load: below (m³)",
  part_load_rate: "Part load ₹/m³ short", waiting_free_hours: "Free unloading hours", waiting_rate: "Waiting ₹/hour", extra_cement_rate: "Extra cement ₹/kg",
};
const PAY_LABELS = { credit_days: "Credit days", credit_limit: "Credit limit ₹", interest_pct: "Interest % p.a.", dispute_hours: "Disputes within (hours)", advance_pct: "Cash: advance %", pay_within_days: "Pay after delivery: within (days)" };

export default function QuotationSettings() {
  const { can } = usePermissions();
  const canEdit = can("accounts.quotation-settings", "edit");
  const [d, setD] = useState(null);
  const [s, setS] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(null);   // { type, terms }
  const [tick, setTick] = useState(0);
  useEffect(() => {
    apiRequest("/quotations/settings").then((r) => { setD(r); setS({ ...r.settings, signature_image: undefined, _sig: r.settings.signature_image }); }).catch((e) => setError(e.message));
  }, [tick]);

  async function save() {
    setError(""); setMsg("");
    try {
      const body = { ...s };
      if (s._sigChanged) body.signature_image = s._sig; else delete body.signature_image;
      delete body._sig; delete body._sigChanged;
      await apiRequest("/quotations/settings", { method: "PUT", body });
      setMsg("Settings saved."); setTick((t) => t + 1);
    } catch (e) { setError(e.message); }
  }
  async function openTerms(type) {
    try { const r = await apiRequest(`/quotations/terms/${type}`); setEditing({ type, terms: r.terms, def: r.default_terms }); }
    catch (e) { setError(e.message); }
  }
  async function saveTerms(terms) {
    try { await apiRequest(`/quotations/terms/${editing.type}`, { method: "PUT", body: { terms } }); setEditing(null); setMsg("Standard terms saved — new quotations of that type use them. Quotations already made keep their own copy."); setTick((t) => t + 1); }
    catch (e) { setError(e.message); }
  }

  if (!s) return <><Banner>{error}</Banner><Empty>Loading…</Empty></>;
  const dis = !canEdit;
  const setDef = (grp, k, v) => setS({ ...s, defaults: { ...s.defaults, [grp]: { ...(s.defaults?.[grp] || {}), [k]: v === "" ? null : Number(v) } } });
  const setBank = (i, k, v) => setS({ ...s, bank_accounts: s.bank_accounts.map((b, j) => (j === i ? { ...b, [k]: v } : b)) });
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "0 12px" };

  return (
    <>
      <Banner>{error}</Banner><Banner kind="ok">{msg}</Banner>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Numbering and signature</h3>
        <div style={grid}>
          <Field label="Next quotation number" hint={`Prints as RMC-QTN-<year>-${String(s.next_serial).padStart(4, "0")}`}><input type="number" min="1" disabled={dis} value={s.next_serial} onChange={(e) => setS({ ...s, next_serial: e.target.value })} /></Field>
          <Field label="Valid for (days) by default"><input type="number" min="1" disabled={dis} value={s.validity_days} onChange={(e) => setS({ ...s, validity_days: e.target.value })} /></Field>
          <Field label="Signed by"><input disabled={dis} value={s.director_name} onChange={(e) => setS({ ...s, director_name: e.target.value })} /></Field>
          <Field label="Title"><input disabled={dis} value={s.director_title} onChange={(e) => setS({ ...s, director_title: e.target.value })} /></Field>
          <Field label="Phone"><input disabled={dis} value={s.director_phone} onChange={(e) => setS({ ...s, director_phone: e.target.value })} /></Field>
          <Field label="Signature image" hint="A PNG with a clear background, under 1 MB. Printed on every approved quotation.">
            {s._sig && <img src={s._sig} alt="Signature" style={{ height: 44, display: "block", marginBottom: 4, background: "#fff", border: "1px solid var(--border)" }} />}
            {canEdit && <input type="file" accept="image/png,image/jpeg" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setS({ ...s, _sig: await readFileAsDataUrl(f), _sigChanged: true }); }} />}
            {canEdit && s._sig && <button type="button" style={{ fontSize: 12, padding: "3px 8px", marginTop: 4 }} onClick={() => setS({ ...s, _sig: null, _sigChanged: true })}>Remove</button>}
          </Field>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Default charges and payment terms <span style={{ fontWeight: 400, fontSize: 12, color: "var(--slate)" }}>— a new quotation starts with these</span></h3>
        <div style={grid}>
          {Object.entries(CHARGE_LABELS).map(([k, l]) => <Field key={k} label={l}><input type="number" min="0" disabled={dis} value={s.defaults?.charges?.[k] ?? ""} onChange={(e) => setDef("charges", k, e.target.value)} /></Field>)}
          {Object.entries(PAY_LABELS).map(([k, l]) => <Field key={k} label={l}><input type="number" min="0" disabled={dis} value={s.defaults?.payment?.[k] ?? ""} onChange={(e) => setDef("payment", k, e.target.value)} /></Field>)}
        </div>
      </div>

      <div className="card field-input" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Bank accounts printed in the terms</h3>
        {(s.bank_accounts || []).map((b, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: b.upi !== undefined ? "1fr 3fr auto" : "1fr 1.4fr 1.2fr 1fr 1.6fr auto", gap: 8, marginBottom: 6 }}>
            <input disabled={dis} value={b.label || ""} placeholder="Label" onChange={(e) => setBank(i, "label", e.target.value)} />
            {b.upi !== undefined ? <input disabled={dis} value={b.upi} placeholder="UPI ID" onChange={(e) => setBank(i, "upi", e.target.value)} /> : <>
              <input disabled={dis} value={b.name || ""} placeholder="Account name" onChange={(e) => setBank(i, "name", e.target.value)} />
              <input disabled={dis} value={b.number || ""} placeholder="Account no." onChange={(e) => setBank(i, "number", e.target.value)} />
              <input disabled={dis} value={b.ifsc || ""} placeholder="IFSC" onChange={(e) => setBank(i, "ifsc", e.target.value)} />
              <input disabled={dis} value={b.bank || ""} placeholder="Bank & branch" onChange={(e) => setBank(i, "bank", e.target.value)} />
            </>}
            {canEdit && <button type="button" style={{ padding: "4px 9px" }} onClick={() => setS({ ...s, bank_accounts: s.bank_accounts.filter((_, j) => j !== i) })}>✕</button>}
          </div>
        ))}
        {canEdit && <div style={{ display: "flex", gap: 6 }}>
          <button type="button" style={{ fontSize: 12 }} onClick={() => setS({ ...s, bank_accounts: [...(s.bank_accounts || []), { label: "", name: "Our Own Ready Mix", number: "", ifsc: "", bank: "" }] })}>+ Bank account</button>
          <button type="button" style={{ fontSize: 12 }} onClick={() => setS({ ...s, bank_accounts: [...(s.bank_accounts || []), { label: "UPI", upi: "" }] })}>+ UPI</button>
        </div>}
      </div>

      {canEdit && <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}><button type="button" className="btn-primary" onClick={save}>Save settings</button></div>}

      <div className="card">
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Standard terms of each agreement</h3>
        {d.agreement_types.map((t) => {
          const lib = d.library.find((l) => l.agreement_type === t.key);
          return (
            <div key={t.key} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
              <b style={{ minWidth: 200 }}>{t.label}</b>
              <span style={{ color: "var(--slate)", fontSize: 12 }}>{lib ? `version ${lib.version}${lib.updated_by_name ? ` · ${lib.updated_by_name}, ${fmtDate(String(lib.updated_at).slice(0, 10))}` : " · from the Excel"}` : ""}</span>
              <button type="button" style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }} onClick={() => openTerms(t.key)}>{canEdit ? "Edit" : "View"}</button>
            </div>
          );
        })}
      </div>
      {editing && (
        <TermsEditor title={`Standard terms — ${d.agreement_types.find((t) => t.key === editing.type)?.label}`} terms={editing.terms}
          onClose={() => setEditing(null)} onSave={canEdit ? saveTerms : () => setEditing(null)}
          onReset={canEdit ? () => saveTerms(editing.def) : null} />
      )}
    </>
  );
}
