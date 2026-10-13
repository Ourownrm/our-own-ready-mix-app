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
      {can("accounts.quotation-costing", "view") && <CostingSettings canEdit={can("accounts.quotation-costing", "edit")} />}
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

// Round 209 — what the proposed rate on a quotation adds up (Administrator).
function CostingSettings({ canEdit }) {
  const [d, setD] = useState(null);
  const [c, setC] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => apiRequest("/quotations/costing-settings").then((r) => { setD(r.context); setC(r.settings); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (!c) return error ? <Banner>{error}</Banner> : null;
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const rs = (v) => (v == null ? "—" : `₹${Math.round(Number(v)).toLocaleString("en-IN")}`);
  async function save() {
    setError(""); setMsg("");
    try { await apiRequest("/quotations/costing-settings", { method: "PUT", body: c }); setMsg("Costing saved."); load(); }
    catch (e) { setError(e.message); }
  }
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "0 12px" };
  const radio = (name, val, label) => (
    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginBottom: 4 }}>
      <input type="radio" name={name} checked={c[name] === val} onChange={() => setC({ ...c, [name]: val })} disabled={!canEdit} style={{ width: "auto" }} /> {label}
    </label>
  );
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Proposed-rate costing</h3>
      <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>
        Proposed rate = (material from the mix design + fuel + salary + other) × (1 + margin) × (1 + GST), rounded. Shown to the Administrator only, never printed.
      </div>
      <Banner>{error}</Banner><Banner kind="ok">{msg}</Banner>
      <fieldset disabled={!canEdit} style={{ border: "none", padding: 0, margin: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          <div>
            <b style={{ fontSize: 13 }}>Fuel per m³ (when a quotation uses the average)</b>
            {radio("fuel_mode", "actual", `Actual: ${rs(d?.fuel_average?.per_m3)} (${d?.fuel_average?.label || "—"})`)}
            {radio("fuel_mode", "set", "A value set here")}
            <div style={grid}>
              <Field label="Set value ₹ / m³"><input type="number" min="0" value={c.fuel_set ?? ""} onChange={set("fuel_set")} /></Field>
              <Field label="Actual over">
                <select value={c.fuel_months} onChange={set("fuel_months")}><option value={1}>Last month</option><option value={3}>Last 3 months</option></select>
              </Field>
            </div>
          </div>
          <div>
            <b style={{ fontSize: 13 }}>Salary per m³</b>
            {radio("salary_mode", "actual", `Actual: ${rs(d?.salary?.per_m3)} (${d?.salary ? `${d.salary.month} payroll ÷ ${Math.round(d.salary.m3)} m³` : "no locked payroll yet"})`)}
            {radio("salary_mode", "set", "A value set here")}
            <Field label="Set value ₹ / m³"><input type="number" min="0" value={c.salary_set ?? ""} onChange={set("salary_set")} /></Field>
          </div>
          <div>
            <b style={{ fontSize: 13 }}>Other costs, margin and rounding</b>
            <div style={grid}>
              <Field label="Other costs ₹ / m³" hint="Rent, power, maintenance, office…"><input type="number" min="0" value={c.other_per_m3} onChange={set("other_per_m3")} /></Field>
              <Field label="Margin %"><input type="number" min="0" step="0.5" value={c.margin_pct} onChange={set("margin_pct")} /></Field>
              <Field label="GST %"><input type="number" min="0" value={c.gst_pct} onChange={set("gst_pct")} /></Field>
              <Field label="Round to ₹"><input type="number" min="1" value={c.round_to} onChange={set("round_to")} /></Field>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 13 }}>Site-specific fuel</b> <span style={{ fontSize: 12, color: "var(--slate)" }}>(from the road km typed on each quotation)</span>
          <div style={grid}>
            <Field label="Drum &amp; waiting L / trip"><input type="number" min="0" step="0.5" value={c.drum_litres_per_trip} onChange={set("drum_litres_per_trip")} /></Field>
            <Field label="Usual load per trip (m³)"><input type="number" min="1" step="0.5" value={c.default_load_m3} onChange={set("default_load_m3")} /></Field>
            <Field label="TM km per litre" hint={d?.fleet_kmpl ? `Fleet actual, 90 days: ${d.fleet_kmpl} — used instead` : "Used until fills give a fleet figure"}><input type="number" min="0.5" step="0.1" value={c.tm_kmpl} onChange={set("tm_kmpl")} /></Field>
            <Field label="Line pump L / hour"><input type="number" min="0" step="0.5" value={c.line_pump_lph} onChange={set("line_pump_lph")} /></Field>
            <Field label="Boom pump L / hour"><input type="number" min="0" step="0.5" value={c.boom_pump_lph} onChange={set("boom_pump_lph")} /></Field>
            <Field label="Pour hours per 60 m³"><input type="number" min="0" step="0.5" value={c.pour_hours_per_60} onChange={set("pour_hours_per_60")} /></Field>
          </div>
          {radio("plant_fuel_mode", "actual", `Genset & loader: last month's actual (${d?.plant_fuel?.genset_lpm3 != null ? `${Math.round(d.plant_fuel.genset_lpm3 * 100) / 100}` : "—"} · ${d?.plant_fuel?.loader_lpm3 != null ? `${Math.round(d.plant_fuel.loader_lpm3 * 100) / 100}` : "—"} L/m³)`)}
          {radio("plant_fuel_mode", "set", "Genset & loader: values set here")}
          <div style={grid}>
            <Field label="Genset L / m³"><input type="number" min="0" step="0.05" value={c.genset_lpm3 ?? ""} onChange={set("genset_lpm3")} /></Field>
            <Field label="Loader L / m³"><input type="number" min="0" step="0.05" value={c.loader_lpm3 ?? ""} onChange={set("loader_lpm3")} /></Field>
          </div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>Diesel rate: {d?.diesel_rate ? `₹${d.diesel_rate}/L (Fuel module)` : "not set in the Fuel module"}.</div>
        </div>
      </fieldset>
      {canEdit && <div style={{ marginTop: 10 }}><button type="button" className="btn-primary" onClick={save}>Save costing</button></div>}
    </div>
  );
}
