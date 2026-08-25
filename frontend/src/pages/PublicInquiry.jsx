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
const emptyForm = { company_name: "", site_project: "", contact_name: "", contact_number: "" };

export default function PublicInquiry() {
  const [form, setForm] = useState(emptyForm);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/public-inquiry", { method: "POST", body: form });
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
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>Thanks — we've received your inquiry</h2>
          <p style={{ fontSize: 13, color: "var(--slate)", lineHeight: 1.6 }}>
            Someone from Our Own Ready Mix will reach out to the contact number you provided shortly.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Request a quote</div>
            <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4, lineHeight: 1.5 }}>
              Tell us a bit about your project and we'll get in touch.
            </div>
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <form onSubmit={submit} className="card" style={{ marginBottom: 20 }}>
            <Field label="Company / your name">
              <input type="text" value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} required maxLength={150} />
            </Field>
            <Field label="Site / project">
              <input type="text" value={form.site_project} onChange={(e) => setForm({ ...form, site_project: e.target.value })} placeholder="e.g. Villa project, Kasaragod" />
            </Field>
            <Field label="Requesting person's name">
              <input type="text" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
            </Field>
            <Field label="Contact number">
              <input type="tel" value={form.contact_number} onChange={(e) => setForm({ ...form, contact_number: e.target.value })} required maxLength={20} />
            </Field>
            <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
              {saving ? "Sending..." : "Submit inquiry"}
            </button>
          </form>
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
            Get in touch
          </div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>{children}</div>
    </div>
  );
}
