// Round 269 — Marketing › Directory: firms with their contacts by level and
// communication plans (mockup artboards 1 and 2).
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { useMeta, Banner, Tile, Field, Chip, Sheet, TH, TD, fmtDay, fmtWhen, everyText, CH_LABEL } from "./common.jsx";

export default function Directory({ go, params }) {
  const firmId = params.get("firm");
  return firmId ? <FirmView id={Number(firmId)} go={go} /> : <FirmList go={go} />;
}

function FirmList({ go }) {
  const [meta, metaErr] = useMeta();
  const [f, setF] = useState({ q: "", type: "", status: "", category: "", area: "" });
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    try { setData(await apiRequest(`/marketing/firms?${qs}`)); setErr(""); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps

  async function importAll() {
    setMsg(""); setErr("");
    try {
      const out = await apiRequest("/marketing/firms/import", { method: "POST" });
      setMsg(`Imported ${out.customers} customer${out.customers === 1 ? "" : "s"} and ${out.contacts} Sales contact${out.contacts === 1 ? "" : "s"}.`);
      load();
    } catch (e) { setErr(e.message); }
  }

  const t = data?.tiles;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const sel = { minHeight: 38, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "0 8px" };
  return (
    <>
      <Banner>{err || metaErr}</Banner>
      <Banner kind="ok">{msg}</Banner>
      {t && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
          <Tile label="Firms" value={t.firms} />
          <Tile label="Contacts" value={t.contacts} />
          <Tile label="Due today" value={t.due_today} tone={t.due_today ? "amber" : null} />
          <Tile label="Overdue" value={t.overdue} tone={t.overdue ? "red" : null} />
          <Tile label="No contact in 90 days" value={t.quiet} />
        </div>
      )}
      <div className="card" style={{ margin: 0 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
          <Field label="Search" style={{ flex: "1 1 220px" }}><input value={f.q} onChange={set("q")} placeholder="Firm, person, phone, place" style={sel} /></Field>
          <Field label="Type"><select value={f.type} onChange={set("type")} style={sel}><option value="">All types</option>{meta?.firm_types.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Status"><select value={f.status} onChange={set("status")} style={sel}><option value="">Customers & prospects</option><option value="customer">Customer</option><option value="prospect">Prospect</option><option value="inactive">Inactive</option></select></Field>
          <Field label="Communication"><select value={f.category} onChange={set("category")} style={sel}><option value="">Any</option>{meta?.categories.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Area"><select value={f.area} onChange={set("area")} style={sel}><option value="">All areas</option>{meta?.areas.map((x) => <option key={x}>{x}</option>)}</select></Field>
          {meta?.can.create && <button type="button" className="btn-primary" onClick={() => setAdding(true)} style={{ minHeight: 38 }}>+ Add firm</button>}
          {meta?.can.create && <button type="button" onClick={importAll} style={{ minHeight: 38 }} title="Adds every customer and Sales contact not yet in the directory">Import customers & Sales contacts</button>}
        </div>
        {!data ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : !data.firms.length ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>No firms yet. Add one, or import the customer master and Sales contacts.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
              <thead><tr><th style={TH}>Firm / customer</th><th style={TH}>Type</th><th style={TH}>Contacts</th><th style={TH}>Communications set</th><th style={TH}>Last</th><th style={TH}>Next due</th><th style={TH}>Looked after by</th></tr></thead>
              <tbody>
                {data.firms.map((r) => {
                  const due = r.next_due && r.next_due <= data.today;
                  return (
                    <tr key={r.id}>
                      <td style={TD}><button type="button" onClick={() => go("directory", { firm: r.id })} style={{ background: "none", border: "none", padding: 0, fontWeight: 700, color: "var(--info)", textDecoration: "underline", textAlign: "left" }}>{r.name}</button>
                        <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{[r.area, r.status === "customer" ? "customer" : r.status].filter(Boolean).join(" · ")}</div></td>
                      <td style={TD}>{r.firm_type || "—"}</td>
                      <td style={TD}>{r.contacts ? Object.entries(r.contacts).map(([lv, n]) => `L${lv} ${n}`).join(" · ") : "—"}</td>
                      <td style={TD}>{(r.plans || []).filter((p) => !p.paused).map((p, i) => <div key={i}>{p.category} · {everyText(p)} · <span style={{ color: "var(--info)" }}>{p.channels.map((c) => CH_LABEL[c]).join(" + ")}</span></div>)}{!(r.plans || []).some((p) => !p.paused) && "—"}</td>
                      <td style={TD}>{r.last ? <>{fmtDay(r.last.at)}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.last.category || ""}</div></> : "—"}</td>
                      <td style={{ ...TD, color: due ? (r.next_due < data.today ? "var(--alert-red)" : "var(--amber)") : undefined, fontWeight: due ? 700 : 400 }}>{r.next_due ? (r.next_due === data.today ? "Today" : fmtDay(r.next_due)) : "—"}</td>
                      <td style={TD}>{r.owner_name || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && meta && <FirmForm meta={meta} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); go("directory", { firm: id }); }} />}
    </>
  );
}

function FirmForm({ meta, firm, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ name: "", firm_type: "", category: "", status: "prospect", area: "", address: "", office_phone: "", email: "", gstin: "", notes: "", owner_user_id: "", ...(firm || {}) }));
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr("");
    const body = { ...f, owner_user_id: f.owner_user_id || null };
    try {
      if (firm) { await apiRequest(`/marketing/firms/${firm.id}`, { method: "PATCH", body }); onSaved(firm.id); }
      else { const out = await apiRequest("/marketing/firms", { method: "POST", body }); onSaved(out.id); }
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <Sheet title={firm ? "Edit firm" : "Add a firm"} onClose={onClose}>
      <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <Field label="Firm / customer name" style={{ gridColumn: "1 / -1" }}><input className="field-input" value={f.name} onChange={set("name")} required /></Field>
        <Field label="Type"><select className="field-input" value={f.firm_type || ""} onChange={set("firm_type")}><option value="">—</option>{meta.firm_types.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Category"><select className="field-input" value={f.category || ""} onChange={set("category")}><option value="">—</option>{meta.firm_categories.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Status"><select className="field-input" value={f.status} onChange={set("status")}><option value="prospect">Prospect</option><option value="customer">Customer</option><option value="inactive">Inactive</option></select></Field>
        <Field label="Area"><input className="field-input" value={f.area || ""} onChange={set("area")} list="mkt-areas" /><datalist id="mkt-areas">{meta.areas.map((a) => <option key={a} value={a} />)}</datalist></Field>
        <Field label="Office phone"><input className="field-input" value={f.office_phone || ""} onChange={set("office_phone")} /></Field>
        <Field label="Email"><input className="field-input" type="email" value={f.email || ""} onChange={set("email")} /></Field>
        <Field label="GSTIN"><input className="field-input" value={f.gstin || ""} onChange={set("gstin")} /></Field>
        <Field label="Looked after by"><select className="field-input" value={f.owner_user_id || ""} onChange={set("owner_user_id")}><option value="">{firm ? "—" : "Me"}</option>{meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Address" style={{ gridColumn: "1 / -1" }}><textarea className="field-input" rows={2} value={f.address || ""} onChange={set("address")} /></Field>
        <Field label="Notes" style={{ gridColumn: "1 / -1" }}><textarea className="field-input" rows={2} value={f.notes || ""} onChange={set("notes")} /></Field>
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, gridColumn: "1 / -1" }}>{err}</div>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}><button type="submit" className="btn-primary">Save</button><button type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Sheet>
  );
}

function ContactForm({ meta, firmId, contact, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ name: "", designation: "", level: 1, mobile: "", on_whatsapp: true, email: "", prefers: "whatsapp", birthday: "", consent: false, opted_out: false, ...(contact ? { ...contact, opted_out: !!contact.opted_out_at, birthday: contact.birthday || "" } : {}) }));
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault(); setErr("");
    const body = { name: f.name, designation: f.designation, level: Number(f.level), mobile: f.mobile, on_whatsapp: f.on_whatsapp, email: f.email, prefers: f.prefers, birthday: f.birthday || null, consent: f.consent, opted_out: f.opted_out };
    try {
      if (contact) await apiRequest(`/marketing/contacts/${contact.id}`, { method: "PATCH", body });
      else await apiRequest(`/marketing/firms/${firmId}/contacts`, { method: "POST", body });
      onSaved();
    } catch (e2) { setErr(e2.message); }
  }
  async function remove() {
    if (!window.confirm(`Remove ${contact.name} from this firm?`)) return;
    try { await apiRequest(`/marketing/contacts/${contact.id}`, { method: "DELETE" }); onSaved(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <Sheet title={contact ? "Edit person" : "Add a person"} onClose={onClose}>
      <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <Field label="Name"><input className="field-input" value={f.name} onChange={set("name")} required /></Field>
        <Field label="Designation"><input className="field-input" value={f.designation || ""} onChange={set("designation")} placeholder="MD, Purchase Manager, Site Engineer…" /></Field>
        <Field label="Level"><select className="field-input" value={f.level} onChange={set("level")}>{[1, 2, 3].map((l) => <option key={l} value={l}>L{l} · {meta.levels[l]}</option>)}</select></Field>
        <Field label="Mobile"><input className="field-input" inputMode="tel" value={f.mobile || ""} onChange={set("mobile")} /></Field>
        <Field label="Email"><input className="field-input" type="email" value={f.email || ""} onChange={set("email")} /></Field>
        <Field label="Prefers"><select className="field-input" value={f.prefers} onChange={set("prefers")}><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="phone">Phone call</option></select></Field>
        <Field label="Birthday (optional)"><input className="field-input" type="date" value={f.birthday || ""} onChange={set("birthday")} /></Field>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, justifyContent: "flex-end" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={!!f.on_whatsapp} onChange={set("on_whatsapp")} /> Mobile is on WhatsApp</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={!!f.consent} onChange={set("consent")} /> Agreed to receive our marketing</label>
          {contact && <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={!!f.opted_out} onChange={set("opted_out")} /> Asked not to be sent these</label>}
        </div>
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, gridColumn: "1 / -1" }}>{err}</div>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="submit" className="btn-primary">Save</button><button type="button" onClick={onClose}>Cancel</button>
          {contact && <button type="button" onClick={remove} style={{ marginLeft: "auto", color: "var(--alert-red)" }}>Remove</button>}
        </div>
      </form>
    </Sheet>
  );
}

const KINDS = [["once", "Once"], ["days", "Days"], ["weeks", "Weeks"], ["months", "Months"], ["yearly", "Every year (on the date)"], ["festival", "Festivals (list in Settings)"], ["when_sent", "When we send it (e.g. price revision)"]];
function PlanForm({ meta, firmId, plan, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ category: meta.categories[0] || "", levels: [1, 2], every_kind: "months", every_n: 1, channels: ["whatsapp"], next_due: "", paused: false, ...(plan || {}), next_due: plan?.next_due || "" }));
  const [err, setErr] = useState("");
  const toggle = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  async function save(e) {
    e.preventDefault(); setErr("");
    const body = { category: f.category, levels: f.levels, every_kind: f.every_kind, every_n: Number(f.every_n), channels: f.channels, next_due: f.next_due || null, paused: f.paused };
    try {
      if (plan) await apiRequest(`/marketing/plans/${plan.id}`, { method: "PATCH", body });
      else await apiRequest(`/marketing/firms/${firmId}/plans`, { method: "POST", body });
      onSaved();
    } catch (e2) { setErr(e2.message); }
  }
  async function remove() {
    if (!window.confirm("Remove this plan?")) return;
    try { await apiRequest(`/marketing/plans/${plan.id}`, { method: "DELETE" }); onSaved(); } catch (e2) { setErr(e2.message); }
  }
  const box = { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 };
  return (
    <Sheet title={plan ? "Edit communication" : "Add a communication"} onClose={onClose}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Field label="Category"><select className="field-input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{meta.categories.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <div><div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 4 }}>To</div>
          <div style={box}>{[1, 2, 3].map((l) => <label key={l} style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.levels.includes(l)} onChange={() => toggle("levels", l)} /> L{l} · {meta.levels[l]}</label>)}</div></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Field label="Every" style={{ flex: "1 1 220px" }}><select className="field-input" value={f.every_kind} onChange={(e) => setF({ ...f, every_kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {["days", "weeks", "months"].includes(f.every_kind) && <Field label="How many"><input className="field-input" type="number" min={1} max={365} value={f.every_n} onChange={(e) => setF({ ...f, every_n: e.target.value })} style={{ width: 90 }} /></Field>}
          <Field label={plan ? "Next due" : "First due (blank = today)"}><input className="field-input" type="date" value={f.next_due} onChange={(e) => setF({ ...f, next_due: e.target.value })} /></Field>
        </div>
        <div><div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 4 }}>By</div>
          <div style={box}>{["whatsapp", "email", "phone", "visit"].map((c) => <label key={c} style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.channels.includes(c)} onChange={() => toggle("channels", c)} /> {CH_LABEL[c]}</label>)}</div></div>
        {plan && <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={!!f.paused} onChange={(e) => setF({ ...f, paused: e.target.checked })} /> Paused</label>}
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className="btn-primary">Save</button><button type="button" onClick={onClose}>Cancel</button>
          {plan && <button type="button" onClick={remove} style={{ marginLeft: "auto", color: "var(--alert-red)" }}>Remove</button>}
        </div>
      </form>
    </Sheet>
  );
}

export function LogForm({ firmId, firmName, plan, contacts, onClose, onSaved }) {
  const [f, setF] = useState({ outcome: "spoke", contact_id: contacts?.[0]?.id || "", note: "", next_due: "", channel: plan?.channels?.includes("phone") ? "phone" : plan?.channels?.[0] || "phone" });
  const [err, setErr] = useState("");
  async function save(e) {
    e.preventDefault(); setErr("");
    try {
      const out = await apiRequest(`/marketing/firms/${firmId}/log`, { method: "POST", body: { ...f, plan_id: plan?.id, contact_id: f.contact_id || null, next_due: f.next_due || null } });
      onSaved(out.next_due);
    } catch (e2) { setErr(e2.message); }
  }
  const OUT = [["spoke", "Spoke"], ["no_answer", "No answer"], ["call_back", "Call back on…"], ["not_interested", "Not interested"], ["visited", "Visited"], ["note", "Just a note"]];
  return (
    <Sheet title={`Log it — ${firmName}`} onClose={onClose}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {plan && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>{plan.category} · {everyText(plan)}</div>}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {OUT.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={f.outcome === k} onClick={() => setF({ ...f, outcome: k })}
              style={{ borderRadius: 16, padding: "6px 12px", minHeight: 36, background: f.outcome === k ? "var(--charcoal)" : "#fff", color: f.outcome === k ? "#fff" : "var(--charcoal)", border: "1px solid var(--border-strong)" }}>{l}</button>
          ))}
        </div>
        {contacts?.length > 0 && <Field label="With"><select className="field-input" value={f.contact_id} onChange={(e) => setF({ ...f, contact_id: e.target.value })}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.designation ? ` · ${c.designation}` : ""} (L{c.level})</option>)}</select></Field>}
        <Field label="How"><select className="field-input" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{["phone", "whatsapp", "email", "visit"].map((c) => <option key={c} value={c}>{CH_LABEL[c]}</option>)}</select></Field>
        <Field label="What was said"><textarea className="field-input" rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        {plan && f.outcome !== "not_interested" && <Field label="Next follow-up" hint={f.outcome === "no_answer" ? "Blank = tomorrow" : "Blank = by the plan's interval"}><input className="field-input" type="date" value={f.next_due} onChange={(e) => setF({ ...f, next_due: e.target.value })} required={f.outcome === "call_back"} /></Field>}
        {f.outcome === "not_interested" && plan && <div style={{ fontSize: 12.5, color: "var(--amber)" }}>This plan will be paused.</div>}
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8 }}><button type="submit" className="btn-primary" style={{ minHeight: 46 }}>Save</button><button type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Sheet>
  );
}

function FirmView({ id, go }) {
  const [meta, metaErr] = useMeta();
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [modal, setModal] = useState(null);
  async function load() { try { setD(await apiRequest(`/marketing/firms/${id}`)); } catch (e) { setErr(e.message); } }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (m) => { setModal(null); if (m) setMsg(m); load(); };
  if (!d || !meta) return <><Banner>{err || metaErr}</Banner>{!err && <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}</>;
  const f = d.firm;
  const canEdit = meta.can.edit, canCreate = meta.can.create;
  const row = (k, v) => v ? <tr><td style={{ padding: "5px 0", color: "var(--slate)", width: "38%", fontSize: 13 }}>{k}</td><td style={{ fontSize: 13 }}>{v}</td></tr> : null;
  const history = [
    ...d.log.map((l) => ({ at: l.at, text: <><b>{l.category || (l.outcome === "sent" ? "Sent" : "Note")}</b>{l.channel ? ` · ${CH_LABEL[l.channel]}` : ""}{l.contact_name ? ` · ${l.contact_name}` : ""}{l.outcome && !["sent", "note"].includes(l.outcome) ? ` · ${l.outcome.replace("_", " ")}` : ""}{l.note ? <span style={{ color: "var(--slate)" }}> — “{l.note}”</span> : null}{l.by_name ? <span style={{ color: "var(--slate)" }}> · {l.by_name}</span> : null}</> })),
    ...d.received.map((r) => ({ at: r.sent_at || r.read_at, text: <>Received <b>{r.titles || "a message"}</b> · {CH_LABEL[r.channel] || r.channel} to {r.contact_name || "—"} · {r.status}{r.open_count ? <span style={{ color: "var(--signal-green)", fontWeight: 600 }}> · opened {r.open_count}×</span> : null}</> })),
  ].filter((h) => h.at).sort((a, b) => new Date(b.at) - new Date(a.at));

  return (
    <>
      <button type="button" onClick={() => go("directory")} style={{ marginBottom: 12 }}>← Directory</button>
      <Banner>{err}</Banner>
      <Banner kind="ok">{msg}</Banner>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 14, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ margin: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{f.name}</div>
              <Chip tone={f.status === "customer" ? "green" : f.status === "inactive" ? null : "blue"}>{f.status}</Chip>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}><tbody>
              {row("Type", f.firm_type)}{row("Category", f.category)}{row("Address · area", [f.address, f.area].filter(Boolean).join(" · "))}
              {row("Office phone · email", [f.office_phone, f.email].filter(Boolean).join(" · "))}{row("GSTIN", f.gstin)}{row("Looked after by", f.owner_name)}
              {row("Customer master", f.customer_name)}{row("Notes", f.notes)}
            </tbody></table>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              {canEdit && <button type="button" onClick={() => setModal({ kind: "firm" })}>Edit</button>}
              {canCreate && <button type="button" onClick={() => setModal({ kind: "log" })}>Log a call / visit</button>}
              {(meta.can.send_group || meta.can.send_own) && <button type="button" className="btn-primary" onClick={() => go("send", { firm: f.id })}>Send material</button>}
            </div>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>Contacts by level</b>{canCreate && <button type="button" onClick={() => setModal({ kind: "contact" })} style={{ fontSize: 12.5 }}>+ Add person</button>}</div>
            {[1, 2, 3].map((lv) => {
              const list = d.contacts.filter((c) => c.level === lv);
              return (
                <div key={lv}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--rebar)", margin: "12px 0 4px", textTransform: "uppercase" }}>Level {lv} · {meta.levels[lv]}</div>
                  {!list.length && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>—</div>}
                  {list.map((c) => (
                    <div key={c.id} style={{ border: "1px solid #EEEAE2", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 6, display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div><b>{c.name}</b>{c.designation ? ` · ${c.designation}` : ""}
                        <div style={{ color: "var(--slate)", fontSize: 12 }}>{[c.mobile, c.mobile && c.on_whatsapp ? "WhatsApp ✓" : null, c.email, `prefers ${c.prefers}`, c.birthday ? `birthday ${fmtDay(c.birthday).slice(0, 6)}` : null].filter(Boolean).join(" · ")}</div>
                        <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {c.opted_out_at ? <Chip tone="red">asked not to be sent</Chip> : c.consent ? <Chip tone="green">agreed to marketing</Chip> : <Chip tone="amber">no consent yet</Chip>}
                        </div>
                      </div>
                      {canEdit && <button type="button" onClick={() => setModal({ kind: "contact", contact: c })} style={{ alignSelf: "flex-start", fontSize: 12.5 }}>Edit</button>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ margin: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>Communication plan</b>{canCreate && <button type="button" onClick={() => setModal({ kind: "plan" })} style={{ fontSize: 12.5 }}>+ Add</button>}</div>
            {!d.plans.length ? <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 8 }}>No communication set yet.</div> : (
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={TH}>Category</th><th style={TH}>To</th><th style={TH}>Every</th><th style={TH}>By</th><th style={TH}>Next</th><th style={TH}></th></tr></thead>
                  <tbody>{d.plans.map((p) => (
                    <tr key={p.id} style={p.paused ? { opacity: 0.55 } : undefined}>
                      <td style={TD}>{p.category}{p.paused && <div style={{ fontSize: 11.5 }}>paused</div>}</td>
                      <td style={TD}>{p.levels.map((l) => `L${l}`).join(", ")}</td>
                      <td style={TD}>{everyText(p)}</td>
                      <td style={TD}>{p.channels.map((c) => CH_LABEL[c]).join(" + ")}</td>
                      <td style={{ ...TD, fontWeight: 600, color: p.next_due && p.next_due <= meta.today ? "var(--amber)" : undefined }}>{p.next_due ? (p.next_due === meta.today ? "Today" : fmtDay(p.next_due)) : "—"}</td>
                      <td style={TD}>
                        {canCreate && !p.paused && <button type="button" onClick={() => setModal({ kind: "log", plan: p })} style={{ fontSize: 12 }}>Done</button>}{" "}
                        {canEdit && <button type="button" onClick={() => setModal({ kind: "plan", plan: p })} style={{ fontSize: 12 }}>Edit</button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card" style={{ margin: 0 }}>
            <b>History</b>
            {!history.length ? <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 8 }}>Nothing yet.</div> : history.slice(0, 60).map((h, i) => (
              <div key={i} style={{ padding: "8px 0", borderTop: "1px solid #EEEAE2", fontSize: 13 }}><b>{fmtWhen(h.at)}</b> · {h.text}</div>
            ))}
          </div>
        </div>
      </div>
      {modal?.kind === "firm" && <FirmForm meta={meta} firm={f} onClose={() => setModal(null)} onSaved={() => done("Saved.")} />}
      {modal?.kind === "contact" && <ContactForm meta={meta} firmId={f.id} contact={modal.contact} onClose={() => setModal(null)} onSaved={() => done("Saved.")} />}
      {modal?.kind === "plan" && <PlanForm meta={meta} firmId={f.id} plan={modal.plan} onClose={() => setModal(null)} onSaved={() => done("Saved.")} />}
      {modal?.kind === "log" && <LogForm firmId={f.id} firmName={f.name} plan={modal.plan} contacts={d.contacts.filter((c) => !modal.plan || modal.plan.levels.includes(c.level))}
        onClose={() => setModal(null)} onSaved={(next) => done(next ? `Saved — next ${fmtDay(next)}.` : "Saved.")} />}
    </>
  );
}
