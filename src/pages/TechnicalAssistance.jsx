import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";
import { useCustomerLanguage, PublicLanguageSwitcher } from "../lib/customerI18n.jsx";

const TOPICS = ["Choosing a grade", "Pumping options", "Site preparation", "Something else"];

// Round 119, post-ship — public, no-login "Free Technical Assistance"
// callback form (per the business's own mockup). Lands in the same leads
// pipeline as /inquiry — see routes/publicInquiry.js's POST
// /technical-assistance.
export default function TechnicalAssistance() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [topic, setTopic] = useState(TOPICS[0]);
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/public-inquiry/technical-assistance", {
        method: "POST",
        body: { name, phone, topic, project_description: description },
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
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>Thanks — we've got it</h2>
          <p style={{ fontSize: 13, color: "var(--slate)", lineHeight: 1.6 }}>
            Our team will call you back at {phone} with a recommendation — no charge.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "flex-start", background: "var(--signal-green-bg)" }}>
            <Icon />
            <div style={{ fontSize: 12, color: "#155A3E", lineHeight: 1.55 }}>
              No charge, no obligation — describe what you're building and our team calls you back with grade, mix and pumping recommendations.
            </div>
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <form onSubmit={submit} className="card field-input" style={{ marginBottom: 20 }}>
            <Field label="Your name">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={150} />
            </Field>
            <Field label="Mobile number">
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required maxLength={20} placeholder="For our callback" />
            </Field>
            <Field label="What do you need help with?">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {TOPICS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTopic(t)}
                    style={{
                      padding: "8px 13px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                      border: "1px solid var(--border-strong)",
                      background: topic === t ? "var(--rebar)" : "var(--surface)",
                      borderColor: topic === t ? "var(--rebar)" : "var(--border-strong)",
                      color: topic === t ? "#fff" : "var(--charcoal)",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Tell us about your project">
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What are you building? Foundation, slab, columns... any detail helps." />
            </Field>
            <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
              {saving ? "Sending..." : "Request a callback"}
            </button>
          </form>
          <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "0 16px 22px" }}>
            Already know your grade and quantity? <a href="/inquiry">Request a quote instead</a>
          </div>
        </>
      )}
    </Shell>
  );
}

function Icon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#1D7A55" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}>
      <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
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

// Round 119, post-ship again, item 5 — see ServicesPublic.jsx's identical
// comment on goBack. Reached from /portal's More screen and guest links as a
// full page navigation, so PortalShell's own back button doesn't cover it.
function goBack() {
  if (window.history.length > 1) window.history.back();
  else window.location.assign("/portal");
}

function Shell({ children }) {
  const { t } = useCustomerLanguage();
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
            <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>{t("title_technical_assistance")}</div>
          </div>
          <PublicLanguageSwitcher />
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>
        <button type="button" onClick={goBack} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, background: "none", border: "none", padding: "6px 0 10px", color: "var(--rebar)", cursor: "pointer", fontWeight: 600 }}>
          ← {t("back")}
        </button>
        {children}
      </div>
    </div>
  );
}
