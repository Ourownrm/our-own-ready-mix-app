import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";

// Round 119, post-ship — public, no-login "Services, Products & Equipment"
// page (per the business's own mockup) reachable from the /portal sign-in
// screen's guest links and from More, with no account needed. Content is
// editable by Manager/Admin (pages/SiteContentEditor.jsx, routes/siteContent.js)
// rather than hardcoded here, so the business can update grades/services/
// fleet copy without a code change.
export default function ServicesPublic() {
  const [content, setContent] = useState(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/site-content/services").then((r) => setContent(r.content)).catch((e) => setError(e.message));
  }, []);

  return (
    <Shell>
      {error ? (
        <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>
      ) : content === undefined ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
      ) : (
        <>
          <div className="portal-group-label">Concrete grades</div>
          <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
            {(content.grades || []).map((g, i) => (
              <span key={i} style={{ fontSize: 11.5, fontWeight: 700, background: "var(--concrete)", color: "var(--slate)", padding: "3px 10px", borderRadius: 12 }}>{g}</span>
            ))}
          </div>

          <div className="portal-group-label">Services</div>
          {(content.services || []).map((s, i) => (
            <div key={i} className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{s.title}</div>
              <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4, lineHeight: 1.5 }}>{s.description}</div>
            </div>
          ))}

          {(content.fleet || []).length > 0 && (
            <>
              <div className="portal-group-label">Fleet &amp; equipment</div>
              <div className="card" style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 20 }}>
                {content.fleet.map((f, i) => (
                  <div key={i} style={{ minWidth: 140 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{f.title}</div>
                    <div style={{ fontSize: 12, color: "var(--slate)" }}>{f.subtitle}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          <a href="/inquiry" className="btn-primary" style={{ display: "block", textAlign: "center", textDecoration: "none", padding: 13, marginBottom: 24 }}>
            Request a free quote
          </a>
        </>
      )}
    </Shell>
  );
}

// Round 119, post-ship again, item 5 — this page (and its siblings) is
// reached from the customer portal's More screen as a full page navigation,
// not a pushed portal screen, so PortalShell's own back button
// (CustomerPortal.jsx) never covers it. Falls back to /portal specifically
// (not just "back") since a customer arriving here from an external
// share/QR/link has no portal history to go back to at all.
function goBack() {
  if (window.history.length > 1) window.history.back();
  else window.location.assign("/portal");
}

function Shell({ children }) {
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title">
          Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
          <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>Services &amp; Products</div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>
        <button type="button" onClick={goBack} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, background: "none", border: "none", padding: "6px 0 10px", color: "var(--rebar)", cursor: "pointer", fontWeight: 600 }}>
          ← Back
        </button>
        {children}
      </div>
    </div>
  );
}
