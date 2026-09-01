import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";
import { useCustomerLanguage, PublicLanguageSwitcher } from "../lib/customerI18n.jsx";

// Round 119, post-ship — public, no-login "Ready-Mix vs. Site-Mix" page (per
// the business's own mockup). Content is editable by Manager/Admin
// (pages/SiteContentEditor.jsx, routes/siteContent.js).
export default function RmcVsSitemix() {
  const [content, setContent] = useState(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/site-content/rmc_vs_sitemix").then((r) => setContent(r.content)).catch((e) => setError(e.message));
  }, []);

  return (
    <Shell>
      {error ? (
        <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>
      ) : content === undefined ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
      ) : (
        <>
          <div className="card" style={{ textAlign: "center", background: "var(--charcoal)", color: "#fff", marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: "pre-line", lineHeight: 1.35 }}>{content.hero_title}</div>
            <div style={{ fontSize: 12, color: "#C9CDD2", marginTop: 8, lineHeight: 1.5 }}>{content.hero_subtitle}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            <div style={{ background: "var(--signal-green-bg)", borderRadius: 8, padding: "10px 11px" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--signal-green)", marginBottom: 6 }}>READY-MIX</div>
              <ul style={{ margin: 0, paddingLeft: 15 }}>
                {(content.ready_mix_points || []).map((p, i) => <li key={i} style={{ fontSize: 11.5, lineHeight: 1.6 }}>{p}</li>)}
              </ul>
            </div>
            <div style={{ background: "var(--alert-red-bg)", borderRadius: 8, padding: "10px 11px" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--alert-red)", marginBottom: 6 }}>SITE-MIX</div>
              <ul style={{ margin: 0, paddingLeft: 15 }}>
                {(content.site_mix_points || []).map((p, i) => <li key={i} style={{ fontSize: 11.5, lineHeight: 1.6 }}>{p}</li>)}
              </ul>
            </div>
          </div>

          {content.cost_paragraph && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Cost, honestly compared</div>
              <div style={{ fontSize: 12.5, color: "var(--slate)", lineHeight: 1.6 }}>{content.cost_paragraph}</div>
            </div>
          )}
          {content.quality_paragraph && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Every load, tested</div>
              <div style={{ fontSize: 12.5, color: "var(--slate)", lineHeight: 1.6 }}>{content.quality_paragraph}</div>
            </div>
          )}

          <a href="/inquiry" className="btn-primary" style={{ display: "block", textAlign: "center", textDecoration: "none", padding: 13, marginBottom: 24 }}>
            Request a free quote
          </a>
        </>
      )}
    </Shell>
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
            <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>{t("title_rmc_vs_sitemix")}</div>
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
