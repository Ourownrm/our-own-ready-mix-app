// Round 250 — appointment letters, from HR → Employees → View → Appointment
// letter (owner, 30 Oct 2026). Each letter: a draft that can be changed, then
// issued (locked — a change means a new letter with a new Ref. No.), or
// cancelled. Print opens the browser's print dialog (lib/appointmentLetter.js);
// the photo is the one uploaded on the employee file.
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";

const day = (d) => (d ? new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) : "—");
const STATUS = { draft: ["Draft", "badge-warning"], issued: ["Issued", "badge-success"], cancelled: ["Cancelled", "badge-neutral"] };

function Field({ label, hint, children, span }) {
  return (
    <label className="field-input" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", fontWeight: 600, gridColumn: span ? "1 / -1" : undefined }}>
      {label}
      {children}
      {hint && <span style={{ fontWeight: 400, fontSize: 11 }}>{hint}</span>}
    </label>
  );
}
const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px 14px" };
const SECTION = { fontSize: 12, fontWeight: 700, color: "var(--rebar)", textTransform: "uppercase", letterSpacing: 0.4, margin: "16px 0 8px" };

function toForm(src) {
  return {
    issue_date: src.issue_date || "", joining_date: src.joining_date || "", designation: src.designation || "", department: src.department || "",
    work_location: src.work_location || "", reporting_to: src.reporting_to || "",
    probation_months: String(src.probation_months ?? 3), notice_probation_days: String(src.notice_probation_days ?? 30), notice_after_months: String(src.notice_after_months ?? 1),
    salary: (src.salary || []).map((r) => ({ label: r.label, amount: r.amount == null ? "" : String(r.amount), note: r.note || "" })),
    signatory_name: src.signatory_name || "", signatory_designation: src.signatory_designation || "", print_photo: src.print_photo !== false,
  };
}

function LetterForm({ initial, editingId, employeeId, onSaved, onCancel }) {
  const [f, setF] = useState(() => toForm(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setSal = (i, k) => (e) => setF((x) => ({ ...x, salary: x.salary.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)) }));
  const gross = f.salary.reduce((t, r) => t + (r.amount === "" ? 0 : Number(r.amount) || 0), 0);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      const body = { ...f, salary: f.salary.map((r) => ({ amount: r.amount, note: r.note })) };
      if (editingId) await apiRequest(`/hr/appointment-letters/${editingId}`, { method: "PATCH", body });
      else await apiRequest(`/hr/employees/${employeeId}/appointment-letters`, { method: "POST", body });
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={save} style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 4 }}>
      <div style={SECTION}>Letter details</div>
      <div style={GRID}>
        <Field label="Date of issue *"><input type="date" value={f.issue_date} onChange={set("issue_date")} required /></Field>
        <Field label="Effective / joining date *"><input type="date" value={f.joining_date} onChange={set("joining_date")} required /></Field>
        <Field label="Designation *"><input value={f.designation} onChange={set("designation")} maxLength={80} required /></Field>
        <Field label="Department"><input value={f.department} onChange={set("department")} maxLength={80} /></Field>
        <Field label="Work location"><input value={f.work_location} onChange={set("work_location")} maxLength={120} /></Field>
        <Field label="Reporting to"><input value={f.reporting_to} onChange={set("reporting_to")} maxLength={120} /></Field>
      </div>

      <div style={SECTION}>Probation &amp; notice</div>
      <div style={GRID}>
        <Field label="Probation" hint="0 = no probation (the clause says so).">
          <select value={f.probation_months} onChange={set("probation_months")}>
            {[0, 1, 2, 3, 4, 5, 6, 9, 12].map((n) => <option key={n} value={n}>{n === 0 ? "No probation" : `${n} month${n === 1 ? "" : "s"}`}</option>)}
          </select>
        </Field>
        <Field label="Notice during probation">
          <select value={f.notice_probation_days} onChange={set("notice_probation_days")} disabled={f.probation_months === "0"}>
            {[0, 7, 15, 30, 45, 60, 90].map((n) => <option key={n} value={n}>{n === 0 ? "None" : `${n} days`}</option>)}
          </select>
        </Field>
        <Field label={f.probation_months === "0" ? "Notice period" : "Notice after confirmation"}>
          <select value={f.notice_after_months} onChange={set("notice_after_months")}>
            {[0, 1, 2, 3, 6].map((n) => <option key={n} value={n}>{n === 0 ? "None" : `${n} month${n === 1 ? "" : "s"}`}</option>)}
          </select>
        </Field>
      </div>

      <div style={SECTION}>Monthly salary package</div>
      <div style={{ overflowX: "auto" }}>
        <table className="table" style={{ minWidth: 420, width: "100%" }}>
          <thead><tr><th style={{ width: 30 }}>#</th><th>Component</th><th style={{ textAlign: "right" }}>Amount (₹)</th><th>Or text</th></tr></thead>
          <tbody>
            {f.salary.map((r, i) => (
              <tr key={r.label}>
                <td>{i + 1}</td>
                <td>{r.label}</td>
                <td style={{ textAlign: "right" }}><input inputMode="decimal" value={r.amount} onChange={setSal(i, "amount")} aria-label={`${r.label} amount`} style={{ width: 120, textAlign: "right" }} /></td>
                <td><input value={r.note} onChange={setSal(i, "note")} maxLength={60} aria-label={`${r.label} text`} placeholder={i === 4 ? "As per policy" : ""} style={{ width: "100%" }} /></td>
              </tr>
            ))}
            <tr><td></td><td><b>Gross monthly (fixed)</b></td><td style={{ textAlign: "right" }}><b>{gross ? `₹${gross.toLocaleString("en-IN")}` : "—"}</b></td><td></td></tr>
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>Filled from the employee's pay (Basic · DA as Other Allowance · HRA · Conveyance + Special as Allowance). Change it here for this letter only.</div>

      <div style={SECTION}>Signing</div>
      <div style={GRID}>
        <Field label="Authorised signatory — name"><input value={f.signatory_name} onChange={set("signatory_name")} maxLength={120} /></Field>
        <Field label="Designation"><input value={f.signatory_designation} onChange={set("signatory_designation")} maxLength={80} /></Field>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 12 }}>
        <input type="checkbox" checked={f.print_photo} onChange={set("print_photo")} /> Print the employee's photo on the letter
      </label>

      {error && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving…" : editingId ? "Save draft" : "Create draft"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function AppointmentLetters({ employee, photo }) {
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // null | { initial, id? }
  const [busy, setBusy] = useState(0);
  const [preview, setPreview] = useState(null); // { id, html }
  const load = () => apiRequest(`/hr/employees/${employee.id}/appointment-letters`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [employee.id]);

  async function fetchPrint(id) {
    return apiRequest(`/hr/appointment-letters/${id}/print`);
  }
  async function print(id) {
    setBusy(id); setError("");
    try {
      const d = await fetchPrint(id);
      const m = await import("../lib/appointmentLetter.js");
      await m.printAppointmentLetter(d);
    } catch (err) { setError(err.message); } finally { setBusy(0); }
  }
  async function showPreview(id) {
    if (preview?.id === id) { setPreview(null); return; }
    setBusy(id); setError("");
    try {
      const d = await fetchPrint(id);
      const m = await import("../lib/appointmentLetter.js");
      setPreview({ id, html: m.letterHtml(d) });
    } catch (err) { setError(err.message); } finally { setBusy(0); }
  }
  async function act(id, what, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(id); setError("");
    try { await apiRequest(`/hr/appointment-letters/${id}/${what}`, { method: "POST" }); setPreview(null); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(0); }
  }

  if (!data) return <div className="card" style={{ marginBottom: 16, fontSize: 13 }}>{error || "Loading appointment letters…"}</div>;
  const e = data.employee;
  const missing = [!e.address && "address", !e.relation_name && "S/o · D/o · W/o", !photo && "photo"].filter(Boolean);
  const canCreate = can("hr.appointment-letter", "create");
  const canEdit = can("hr.appointment-letter", "edit");
  const canCancel = can("hr.appointment-letter", "delete");

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Appointment letter</div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>Company format with terms &amp; conditions (Ver 3), the employee's details and passport photo.</div>
        </div>
        {canCreate && !form && <button type="button" className="btn-primary" onClick={() => setForm({ initial: data.defaults })}>+ New letter</button>}
      </div>

      {missing.length > 0 && (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--amber-bg)", fontSize: 12.5 }}>
          The employee file has no {missing.join(", ")} yet — {missing.includes("photo") ? "upload the photo above, " : ""}{missing.some((m) => m !== "photo") ? "add the rest with Edit, " : ""}so the letter prints complete.
          {!e.address && " A letter can't be issued without the address."}
        </div>
      )}
      {error && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{error}</div>}

      {form && (
        <LetterForm initial={form.initial} editingId={form.id} employeeId={employee.id}
          onCancel={() => setForm(null)} onSaved={() => { setForm(null); setPreview(null); load(); }} />
      )}

      {!form && (
        data.letters.length === 0
          ? <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 12 }}>No appointment letter yet.</div>
          : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              {data.letters.map((l) => {
                const [label, cls] = STATUS[l.status] || [l.status, "badge-neutral"];
                const b = busy === l.id;
                return (
                  <div key={l.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, overflowWrap: "anywhere" }}>{l.ref_no} <span className={`badge ${cls}`} style={{ marginLeft: 6 }}>{label}</span></div>
                        <div style={{ fontSize: 12, color: "var(--slate)" }}>
                          Dated {day(l.issue_date)} · {l.designation} · joining {day(l.joining_date)} · probation {l.probation_months ? `${l.probation_months} m` : "none"}
                          {l.status === "issued" && l.issued_by ? ` · issued by ${l.issued_by}` : ""}
                          {l.status === "cancelled" && l.cancelled_by ? ` · cancelled by ${l.cancelled_by}` : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" disabled={b} onClick={() => showPreview(l.id)}>{preview?.id === l.id ? "Hide preview" : "Preview"}</button>
                        <button type="button" className="btn-primary" disabled={b} onClick={() => print(l.id)}>{b ? "Preparing…" : "Print / PDF"}</button>
                        {l.status === "draft" && canEdit && <button type="button" disabled={b} onClick={() => setForm({ initial: l, id: l.id })}>Edit</button>}
                        {l.status === "draft" && canEdit && <button type="button" disabled={b} onClick={() => act(l.id, "issue", `Issue ${l.ref_no}? It is locked after this — any change means a new letter.`)}>Mark as issued</button>}
                        {l.status === "issued" && canCreate && <button type="button" disabled={b} onClick={() => setForm({ initial: { ...l, issue_date: data.defaults.issue_date } })}>New version</button>}
                        {l.status !== "cancelled" && canCancel && <button type="button" disabled={b} onClick={() => act(l.id, "cancel", `Cancel ${l.ref_no}? It stays on record as cancelled.`)}>Cancel letter</button>}
                      </div>
                    </div>
                    {preview?.id === l.id && (
                      <iframe title={`Preview of ${l.ref_no}`} srcDoc={preview.html}
                        style={{ width: "100%", height: "70vh", border: "1px solid var(--border-strong)", borderRadius: 6, marginTop: 10, background: "#fff" }} />
                    )}
                  </div>
                );
              })}
            </div>
          )
      )}
    </div>
  );
}

// HR → Settings: the defaults every new appointment letter starts with.
export function LetterSettingsCard({ canEdit }) {
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => { apiRequest("/hr/letter-settings").then(setF).catch((e) => setMsg(e.message)); }, []);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save(e) {
    e.preventDefault();
    setSaving(true); setMsg("");
    try { await apiRequest("/hr/letter-settings", { method: "PUT", body: f }); setMsg("Saved."); }
    catch (err) { setMsg(err.message); } finally { setSaving(false); }
  }
  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={save}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Appointment letter</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Filled in on every new letter; each letter can still be changed before it is issued.</div>
      {!f ? <div style={{ fontSize: 13 }}>{msg || "Loading…"}</div> : (
        <fieldset disabled={!canEdit} style={{ border: "none", padding: 0, margin: 0 }}>
          <div style={GRID}>
            <Field label="Authorised signatory — name"><input value={f.signatory_name || ""} onChange={set("signatory_name")} maxLength={120} /></Field>
            <Field label="Signatory designation"><input value={f.signatory_designation || ""} onChange={set("signatory_designation")} maxLength={80} /></Field>
            <Field label="Work location"><input value={f.work_location || ""} onChange={set("work_location")} maxLength={120} /></Field>
          </div>
          {canEdit && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
              <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
              {msg && <span role="status" style={{ fontSize: 12.5, color: msg === "Saved." ? "var(--signal-green)" : "var(--alert-red)" }}>{msg}</span>}
            </div>
          )}
        </fieldset>
      )}
    </form>
  );
}
