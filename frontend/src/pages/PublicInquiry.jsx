import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";

// Public, no-login page (round 119) for a potential customer arriving from
// outside the app — a website link, social media, word of mouth — who has
// no existing account or order history. Deliberately the ONE-WAY "get in
// touch" surface: submitting here creates a lead (source = 'public_inquiry')
// that a Manager/Admin reviews and follows up with directly, by phone —
// there's no reply channel back through the app. An EXISTING customer who
// already has an access code from Our Own Ready Mix should use /portal
// instead to see their own orders and QC reports.
//
// Round 119, post-ship — expanded per the business's own mockup
// (RequestQuote screen): the contact's own name is now the required
// identity field (previously "company name" doubled as it); company/site
// name is optional; quantity, grade, mix requirement and a free-text
// "anything else" were added. Mix requirement + "anything else" are
// combined client-side into one `notes` string sent to the backend — see
// routes/publicInquiry.js and schema.sql's comment on leads.notes for why
// there's no separate column for each.
const GRADES = ["M15", "M20", "M25", "M30", "M35", "M40", "Not sure — see below"];
const emptyForm = {
  contact_name: "", contact_number: "", company_name: "", site_project: "",
  estimated_qty_m3: "", mix_grade_interest: "M25", mix_requirement: "", anything_else: "",
};

export default function PublicInquiry() {
  const [form, setForm] = useState(emptyForm);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const notesParts = [];
      if (form.mix_requirement.trim()) notesParts.push(`Mix requirement: ${form.mix_requirement.trim()}`);
      if (form.anything_else.trim()) notesParts.push(form.anything_else.trim());
      await apiRequest("/public-inquiry", {
        method: "POST",
        body: {
          contact_name: form.contact_name,
          contact_number: form.contact_number,
          company_name: form.company_name,
          site_project: form.site_project,
          estimated_qty_m3: form.estimated_qty_m3 || null,
          mix_grade_interest: form.mix_grade_interest === "Not sure — see below" ? null : form.mix_grade_interest,
          notes: notesParts.join(" · ") || null,
        },
      });
      setSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      {submitted ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>✅</div>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>Thanks — we've received your request</h2>
          <p style={{ fontSize: 13, color: "var(--slate)", lineHeight: 1.6 }}>
            A sales executive will call you back at {form.contact_number}, usually within the day.
          </p>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 16, lineHeight: 1.5 }}>
            Tell us about your project — a sales executive will call you back, usually within the day.
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <form onSubmit={submit} className="card field-input" style={{ marginBottom: 20 }}>
            <Field label="Your name">
              <input type="text" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} required maxLength={150} placeholder="Full name" />
            </Field>
            <Field label="Mobile number">
              <input type="tel" value={form.contact_number} onChange={(e) => setForm({ ...form, contact_number: e.target.value })} required maxLength={20} placeholder="For our callback" />
            </Field>
            <Field label="Company / site name">
              <input type="text" value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} maxLength={150} placeholder="Optional" />
            </Field>
            <Field label="Project location">
              <input type="text" value={form.site_project} onChange={(e) => setForm({ ...form, site_project: e.target.value })} placeholder="Area, city" />
            </Field>
            <Field label="Approx. quantity needed (m³)">
              <input type="number" min="0" step="0.5" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} placeholder="e.g. 40" />
            </Field>
            <Field label="Grade required">
              <select value={form.mix_grade_interest} onChange={(e) => setForm({ ...form, mix_grade_interest: e.target.value })}>
                {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            <Field label="Mix requirement (optional, if known)">
              <input type="text" value={form.mix_requirement} onChange={(e) => setForm({ ...form, mix_requirement: e.target.value })} placeholder="e.g. OPC + Fly Ash, specific design code" />
            </Field>
            <Field label="Anything else?">
              <textarea rows={2} value={form.anything_else} onChange={(e) => setForm({ ...form, anything_else: e.target.value })} placeholder="Timeline, pumping needs..." />
            </Field>
            <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
              {saving ? "Sending..." : "Submit request"}
            </button>
          </form>
          <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "0 16px 8px", lineHeight: 1.6 }}>
            Not sure which grade or mix you need? <a href="/technical-assistance">Get free technical assistance instead</a>
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "0 16px 22px" }}>
            Already a customer with an access code? <a href="/portal">Sign in to your portal</a> instead.
          </div>
        </>
      )}
    </Shell>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4, display: "block" }}>{label}</span>
      {children}
    </label>
  );
}

function Shell({ children }) {
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title">
          Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
          <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>
            Request a Quote
          </div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>{children}</div>
    </div>
  );
}
