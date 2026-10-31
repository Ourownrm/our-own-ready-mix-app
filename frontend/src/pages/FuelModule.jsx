// Round 199 — the Fuel module. Diesel moved out of Store into its own module
// (lubricants stay in Store). Each tab is one function on the Access Control
// page, so a Super Admin can hand out the dashboard without the settings, the
// ledger without the 360° analysis, and so on. The tab is kept in the URL
// (?tab=...) so a link or the browser's back button lands on the same view.
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { MODULE_TABS, tabAllowed } from "../lib/moduleTabs.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import FuelDashboard from "./fuel/FuelDashboard.jsx";
import FuelTransactions from "./fuel/FuelTransactions.jsx";
import FuelIssue from "./fuel/FuelIssue.jsx";
import FuelPurchases from "./fuel/FuelPurchases.jsx";
import FuelAnalysis360 from "./fuel/FuelAnalysis360.jsx";
import FuelReports from "./fuel/FuelReports.jsx";
import FuelSettings from "./fuel/FuelSettings.jsx";
import FuelCorrections from "./fuel/FuelCorrections.jsx";

// Round 256 — the tab list (key, label, who may open it) lives in
// lib/moduleTabs.js, shared with the computer side menu.
const COMPONENTS = {
  "dashboard": FuelDashboard,
  "transactions": FuelTransactions,
  "issue": FuelIssue,
  "purchases": FuelPurchases,
  "analysis": FuelAnalysis360,
  "reports": FuelReports,
  "settings": FuelSettings,
  "corrections": FuelCorrections,
};
const TABS = MODULE_TABS["fuel-module"].tabs.map((t) => ({ ...t, Component: COMPONENTS[t.key] }));

export default function FuelModule() {
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  if (!ready) return null;

  const tabs = TABS.filter((t) => tabAllowed(t, can));
  const wanted = params.get("tab");
  const active = tabs.find((t) => t.key === wanted) || tabs[0];

  function go(key, extra = {}) {
    setParams({ tab: key, ...extra });
    window.scrollTo(0, 0);
  }

  return (
    <>
      <TopBar title="Fuel" />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 16px 32px" }}>
        {tabs.length === 0 ? (
          <div className="card" style={{ fontSize: 13.5 }}>
            Nothing in the Fuel module has been switched on for you. A Super Admin can give you access on the Access Control page.
          </div>
        ) : (
          <>
            <nav aria-label="Fuel module" className="fuel-tabs"
              style={{ display: "flex", gap: 6, overflowX: "auto", borderBottom: "1px solid var(--border-strong)", marginBottom: 18, WebkitOverflowScrolling: "touch" }}>
              {tabs.map((t) => {
                const on = t.key === active.key;
                return (
                  <button key={t.key} type="button" onClick={() => go(t.key)} aria-current={on ? "page" : undefined}
                    style={{
                      flex: "none", background: "none", border: "none", borderBottom: `3px solid ${on ? "var(--rebar)" : "transparent"}`,
                      borderRadius: 0, padding: "11px 12px", minHeight: 44, fontWeight: on ? 700 : 500,
                      color: on ? "var(--charcoal)" : "var(--slate)", fontSize: 13.5,
                    }}>
                    {t.label}
                  </button>
                );
              })}
            </nav>
            <active.Component go={go} params={params} />
          </>
        )}
      </div>
    </>
  );
}
