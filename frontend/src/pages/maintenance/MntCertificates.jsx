// Round 216 — Certificates & expiry (mockup screen 11), replacing Statutory
// Compliance. Insurance, fitness, permit, PUC, road tax, calibration, AMC …
// for every vehicle and piece of equipment. Renewing keeps the old
// certificate in history; the fee can go to Payments (to be paid / paid now).
// The Administrator sets which certificates each machine type must have — a
// missing one shows as "Not on file". Reminders go out 30, 15 and 7 days before.
import { useState } from "react";
import { apiRequest, BASE_URL } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, Kpi, fmtRs, fmtDate, fmtWhen, todayIst, H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN } from "./mntUi.jsx";

const VEHICLE_GROUPS = ["Transit mixer", "Boom pump", "Light truck", "Light vehicle", "Two-wheeler", "Loader"];
const MODES = ["Bank transfer", "Cheque", "UPI", "Cash"];

function statusOf(days) {
  if (days == null) return ["Not on file", "badge-neutral"];
  if (days < 0) return [`Expired ${-days} d`, "badge-danger"];
  if (days <= 30) return [`${days} days`, "badge-warning"];
  if (days <= 60) return [`${days} days`, "badge-info"];
  return ["Valid", "badge-success"];
}

async function openDocument(id) {
  const res = await fetch(`${BASE_URL}/maintenance-module/certificates/${id}/document`, {
    headers: { Authorization: `Bearer ${localStorage.getItem("oorm_token")}` },
  });
  if (!res.ok) throw new Error("Could not open the document.");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank");
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, mime: file.type, data: String(r.result) });
    r.onerror = () => reject(new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
}

export default function MntCertificates() {
  const { can } = usePermissions();
  const list = useLoad("/maintenance-module/certificates");
  const [filter, setFilter] = useState("attention");
  const [q, setQ] = useState("");
  const [form, setForm] = useState(null);
  const [sel, setSel] = useState(null);
  const [rules, setRules] = useState(false);
  const act = useAction(() => { list.load(); setForm(null); });

  if (!list.data) return <Loading error={list.error} />;
  const { kpis, certificates, missing, types, assets } = list.data;
  const all = [
    ...certificates,
    ...missing.map((m) => ({ ...m, id: `m-${m.asset_id}-${m.cert_type}`, missing: true, days_left: null })),
  ];
  const shown = all.filter((c) => {
    const d = c.days_left;
    const okF = filter === "all" ? true : filter === "attention" ? c.missing || d <= 60 : filter === "expired" ? !c.missing && d < 0
      : filter === "30" ? !c.missing && d >= 0 && d <= 30 : filter === "60" ? !c.missing && d > 30 && d <= 60 : c.missing;
    return okF && (!q || `${c.asset_name} ${c.type_label} ${c.number || ""}`.toLowerCase().includes(q.toLowerCase()));
  }).sort((a, b) => (a.missing ? 1e6 : a.days_left) - (b.missing ? 1e6 : b.days_left));
  const groups = [
    ["Vehicles", shown.filter((c) => VEHICLE_GROUPS.includes(c.asset_group))],
    ["Plant & equipment", shown.filter((c) => !VEHICLE_GROUPS.includes(c.asset_group))],
  ];
  const canCreate = can("mnt.certificates", "create");

  function openForm(c) {
    setSel(null);
    setForm({
      asset_id: c?.asset_id || "", cert_type: c?.cert_type || "insurance", label: c?.label || "", number: "", authority: c?.authority || "",
      valid_from: c?.valid_to && !c.missing ? c.valid_to : todayIst(), valid_to: "", fee: "", payment: "to_pay", payment_mode: "Bank transfer", payment_ref: "",
      renew: c && !c.missing ? c : null, file: null,
    });
  }

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Kpi label="Expired" value={kpis.expired} tone={kpis.expired ? "bad" : "good"} onClick={() => setFilter("expired")} />
        <Kpi label="≤ 30 days" value={kpis.due_30} tone={kpis.due_30 ? "warn" : undefined} onClick={() => setFilter("30")} />
        <Kpi label="31–60 days" value={kpis.due_60} onClick={() => setFilter("60")} />
        <Kpi label="Valid" value={kpis.valid} onClick={() => setFilter("all")} />
        <Kpi label="Not on file" value={kpis.missing} tone={kpis.missing ? "warn" : undefined} onClick={() => setFilter("missing")} />
        <Kpi label="Renewal spend · FY" value={fmtRs(kpis.spend_fy)} />
      </div>

      <div style={{ ...ROW, marginBottom: 12 }}>
        {[["attention", "Needs attention"], ["expired", "Expired"], ["30", "≤ 30 days"], ["60", "31–60 days"], ["missing", "Not on file"], ["all", "All"]].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
            style={{ padding: "7px 13px", fontSize: 12.5, borderRadius: 20, background: filter === k ? "var(--charcoal)" : "#fff", color: filter === k ? "#fff" : "var(--charcoal)" }}>{l}</button>
        ))}
        <div className="field-input" style={{ flex: "1 1 180px" }}><input aria-label="Search certificates" placeholder="Search vehicle, type, number" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {can("mnt.cert-rules", "edit") && <button type="button" style={SMALL_BTN} onClick={() => setRules(!rules)}>Required per type</button>}
        {canCreate && <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => openForm(null)}>+ Add certificate</button>}
      </div>
      <Msg msg={act.msg} err={act.err} />
      {rules && <Rules onClose={() => setRules(false)} onSaved={() => list.load()} />}
      {form && <CertForm form={form} setForm={setForm} act={act} types={types} assets={assets} />}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "999 1 600px", minWidth: 0 }}>
          {shown.length === 0 ? <div style={MUTED}>Nothing here.</div> : groups.filter(([, rows]) => rows.length).map(([label, rows]) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--slate)", margin: "4px 0 6px" }}>{label}</h3>
              <Table minWidth={640}>
                <thead><tr><th>Vehicle / equipment</th><th>Certificate</th><th>Number</th><th>Expires</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {rows.map((c) => {
                    const [st, cls] = statusOf(c.days_left);
                    return (
                      <tr key={c.id} onClick={() => !c.missing && setSel(c.id)} style={{ cursor: c.missing ? "default" : "pointer", background: sel === c.id ? "var(--concrete)" : undefined }}>
                        <td><b>{c.asset_name.replace(/ — .*$/, "")}</b><div style={MUTED}>{c.asset_group}</div></td>
                        <td>{c.type_label}</td>
                        <td>{c.number || (c.missing ? "" : "—")}</td>
                        <td>{c.missing ? "—" : fmtDate(c.valid_to)}</td>
                        <td><span className={`badge ${cls}`}>{st}</span></td>
                        <td style={{ textAlign: "right" }}>
                          {canCreate && (c.missing || c.days_left <= 60) && (
                            <button type="button" style={SMALL_BTN} onClick={(e) => { e.stopPropagation(); openForm(c); }}>{c.missing ? "Add" : "Renew"}</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          ))}
        </section>
        {sel && typeof sel === "number" && <CertPanel key={sel} id={sel} onClose={() => setSel(null)} onRenew={(c) => openForm(c)} onChanged={() => { list.load(); setSel(null); }} />}
      </div>
    </>
  );
}

function CertForm({ form, setForm, act, types, assets }) {
  const set = (v) => setForm({ ...form, ...v });
  async function save() {
    let document = null;
    if (form.file) document = await readFile(form.file);
    const body = { ...form, document, renew: undefined, file: undefined };
    act.run(() => apiRequest("/maintenance-module/certificates", { method: "POST", body }), (r) => (r.renewed ? "Renewed — the old certificate is kept in history." : "Certificate added."));
  }
  return (
    <section className="card" style={{ marginBottom: 16, borderColor: "#E7C3A6" }}>
      <h2 style={H2}>{form.renew ? `Renew — ${form.renew.asset_name.replace(/ — .*$/, "")} · ${form.renew.type_label}` : "Add certificate"}</h2>
      {form.renew && <p style={{ ...MUTED, marginTop: 0 }}>Current one expires {fmtDate(form.renew.valid_to)}{form.renew.number ? ` (no. ${form.renew.number})` : ""}. It stays in the history, not overwritten.</p>}
      <div style={GRID(170)}>
        {!form.renew && (
          <>
            <Field label="Vehicle / equipment">
              <select value={form.asset_id} onChange={(e) => set({ asset_id: e.target.value })}>
                <option value="">Select…</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Certificate">
              <select value={form.cert_type} onChange={(e) => set({ cert_type: e.target.value })}>
                {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </Field>
            {form.cert_type === "other" && <Field label="Name it"><input value={form.label} onChange={(e) => set({ label: e.target.value })} /></Field>}
          </>
        )}
        <Field label="Policy / certificate no."><input value={form.number} onChange={(e) => set({ number: e.target.value })} /></Field>
        <Field label="Valid from"><input type="date" value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} /></Field>
        <Field label="Valid to"><input type="date" value={form.valid_to} onChange={(e) => set({ valid_to: e.target.value })} /></Field>
        <Field label="Insurer / agent / authority"><input value={form.authority} onChange={(e) => set({ authority: e.target.value })} /></Field>
        <Field label="Premium / fee ₹"><input inputMode="decimal" value={form.fee} onChange={(e) => set({ fee: e.target.value })} /></Field>
        {Number(form.fee) > 0 && (
          <Field label="Payment">
            <select value={form.payment} onChange={(e) => set({ payment: e.target.value })}>
              <option value="to_pay">To be paid (goes to Payments)</option><option value="paid">Paid now</option><option value="none">Not tracked here</option>
            </select>
          </Field>
        )}
        {Number(form.fee) > 0 && form.payment === "paid" && (
          <>
            <Field label="Mode"><select value={form.payment_mode} onChange={(e) => set({ payment_mode: e.target.value })}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="Reference"><input value={form.payment_ref} onChange={(e) => set({ payment_ref: e.target.value })} /></Field>
          </>
        )}
        <Field label="Document (PDF / photo, ≤ 5 MB)">
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => set({ file: e.target.files?.[0] || null })} />
        </Field>
      </div>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={() => setForm(null)}>Cancel</button>
        <button type="button" className="btn-primary" disabled={act.busy} onClick={() => save().catch((e) => alert(e.message))}>{form.renew ? "Save renewal" : "Save"}</button>
      </div>
    </section>
  );
}

function CertPanel({ id, onClose, onRenew, onChanged }) {
  const { can } = usePermissions();
  const d = useLoad(`/maintenance-module/certificates/${id}`, [id]);
  const [err, setErr] = useState("");
  const act = useAction(() => onChanged());
  if (!d.data) return <section className="card" style={{ flex: "1 1 320px" }}><Loading error={d.error} /></section>;
  const c = d.data;
  return (
    <section className="card" style={{ flex: "1 1 320px", minWidth: 0 }}>
      <div style={ROW}>
        <h2 style={{ ...H2, flex: 1 }}>{c.type_label}</h2>
        <button type="button" style={SMALL_BTN} onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div style={MUTED}>{c.asset_name}</div>
      <div style={{ fontSize: 13, lineHeight: 1.8, margin: "8px 0" }}>
        No. {c.number || "—"}<br />
        Valid {c.valid_from ? `${fmtDate(c.valid_from)} – ` : "to "}{fmtDate(c.valid_to)}<br />
        {c.authority && <>{c.authority}<br /></>}
        {c.fee != null && <>Fee {fmtRs(c.fee)}{c.bill_id ? ` · ${Number(c.bill_paid) >= Number(c.bill_amount) ? "paid" : "in Payments"}` : ""}<br /></>}
        <span style={MUTED}>Entered by {c.created_by_name || "—"} {fmtWhen(c.created_at)}</span>
      </div>
      {err && <div style={{ ...MUTED, color: "var(--alert-red)" }}>{err}</div>}
      <Msg msg={act.msg} err={act.err} />
      <div style={ROW}>
        {c.has_document && <button type="button" style={SMALL_BTN} onClick={() => openDocument(c.id).catch((e) => setErr(e.message))}>View document</button>}
        {can("mnt.certificates", "create") && <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => onRenew(c)}>Renew</button>}
        {can("mnt.certificates", "delete") && c.status === "current" && (
          <button type="button" className="btn-danger" style={SMALL_BTN} onClick={() => window.confirm("Remove this certificate entry? (If it was a renewal, the previous one becomes current again.)")
            && act.run(() => apiRequest(`/maintenance-module/certificates/${c.id}`, { method: "DELETE" }), "Removed.")}>Remove</button>
        )}
      </div>
      <h3 style={{ fontSize: 13, margin: "16px 0 4px" }}>History</h3>
      <Table minWidth={280}>
        <tbody>
          {c.history.map((h) => (
            <tr key={h.id}>
              <td>{h.number || "—"}<div style={MUTED}>{h.valid_from ? `${fmtDate(h.valid_from)} – ` : "to "}{fmtDate(h.valid_to)}</div></td>
              <td>{h.status === "current" ? <span className="badge badge-success">Current</span> : h.status === "retired" ? <span className="badge badge-neutral">Removed</span> : <span className="badge badge-neutral">Earlier</span>}</td>
              <td style={{ textAlign: "right" }}>{h.has_document && <button type="button" style={SMALL_BTN} onClick={() => openDocument(h.id).catch((e) => setErr(e.message))}>Doc</button>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function Rules({ onClose, onSaved }) {
  const r = useLoad("/maintenance-module/cert-rules");
  const g = useLoad("/maintenance-module/models");
  const [edit, setEdit] = useState({});
  const act = useAction(() => { r.load(); onSaved(); });
  if (!r.data || !g.data) return <Loading error={r.error || g.error} />;
  const groups = g.data.groups;
  const cur = (grp) => edit[grp] ?? r.data.rules[grp] ?? [];
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div style={ROW}>
        <h2 style={{ ...H2, flex: 1 }}>Certificates every machine type must have</h2>
        <button type="button" style={SMALL_BTN} onClick={onClose}>Close</button>
      </div>
      <p style={{ ...MUTED, marginTop: 0 }}>A machine of that type without one shows as “Not on file”.</p>
      <Msg msg={act.msg} err={act.err} />
      <Table minWidth={640}>
        <thead><tr><th>Machine type</th><th>Required</th><th></th></tr></thead>
        <tbody>
          {groups.map((grp) => (
            <tr key={grp}>
              <td><b>{grp}</b></td>
              <td>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {r.data.types.map((t) => {
                    const on = cur(grp).includes(t.key);
                    return (
                      <button key={t.key} type="button" aria-pressed={on} onClick={() => setEdit({ ...edit, [grp]: on ? cur(grp).filter((x) => x !== t.key) : [...cur(grp), t.key] })}
                        style={{ padding: "3px 9px", fontSize: 11.5, borderRadius: 14, background: on ? "var(--charcoal)" : "#fff", color: on ? "#fff" : "var(--charcoal)" }}>{t.label}</button>
                    );
                  })}
                </div>
              </td>
              <td style={{ textAlign: "right" }}>
                {edit[grp] && <button type="button" className="btn-primary" style={SMALL_BTN} disabled={act.busy}
                  onClick={() => act.run(() => apiRequest("/maintenance-module/cert-rules", { method: "PUT", body: { asset_group: grp, cert_types: edit[grp] } }), `Saved for ${grp}.`)
                    .then((x) => { if (x) { const n = { ...edit }; delete n[grp]; setEdit(n); } })}>Save</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
