// Round 269 — the Marketing module (owner, 6 Nov 2026): directory of firms
// and contacts by level, due today, the library of posters / videos /
// technical PDFs in Google Drive (Admin approves), sending by WhatsApp API,
// WhatsApp from the phone or email, and tracking who opened what. Each tab is
// one function on the Access Control page; the tab is kept in the URL.
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { MODULE_TABS, tabAllowed } from "../lib/moduleTabs.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import Directory from "./marketing/Directory.jsx";
import DueToday from "./marketing/DueToday.jsx";
import Library from "./marketing/Library.jsx";
import Send from "./marketing/Send.jsx";
import Tracking from "./marketing/Tracking.jsx";
import MarketingSettings from "./marketing/MarketingSettings.jsx";

const COMPONENTS = { directory: Directory, due: DueToday, library: Library, send: Send, tracking: Tracking, settings: MarketingSettings };
const TABS = MODULE_TABS["marketing-module"].tabs.map((t) => ({ ...t, Component: COMPONENTS[t.key] }));

export default function MarketingModule() {
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  if (!ready) return null;
  const tabs = TABS.filter((t) => tabAllowed(t, can));
  const active = tabs.find((t) => t.key === params.get("tab")) || tabs[0];
  function go(key, extra = {}) { setParams({ tab: key, ...extra }); window.scrollTo(0, 0); }

  return (
    <>
      <TopBar title="Marketing" />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 16px 32px" }}>
        {!tabs.length ? (
          <div className="card" style={{ fontSize: 13.5 }}>Nothing in the Marketing module has been switched on for you. A Super Admin can give you access on the Access Control page.</div>
        ) : (
          <>
            <nav aria-label="Marketing module" style={{ display: "flex", gap: 6, overflowX: "auto", borderBottom: "1px solid var(--border-strong)", marginBottom: 18 }}>
              {tabs.map((t) => {
                const on = t.key === active.key;
                return (
                  <button key={t.key} type="button" onClick={() => go(t.key)} aria-current={on ? "page" : undefined}
                    style={{ flex: "none", background: "none", border: "none", borderBottom: `3px solid ${on ? "var(--rebar)" : "transparent"}`, borderRadius: 0,
                      padding: "11px 12px", minHeight: 44, fontWeight: on ? 700 : 500, color: on ? "var(--charcoal)" : "var(--slate)", fontSize: 13.5 }}>
                    {t.label}
                  </button>
                );
              })}
            </nav>
            <active.Component key={active.key + (params.get("firm") || "") + (params.get("item") || "")} go={go} params={params} />
          </>
        )}
      </div>
    </>
  );
}
