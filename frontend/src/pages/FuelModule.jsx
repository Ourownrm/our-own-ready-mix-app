// Round 199 — the Fuel module. Diesel moved out of Store into its own module
// (lubricants stay in Store). Each tab is one function on the Access Control
// page, so a Super Admin can hand out the dashboard without the settings, the
// ledger without the 360° analysis, and so on. The tab is kept in the URL
// (?tab=...) so a link or the browser's back button lands on the same view.
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import FuelDashboard from "./fuel/FuelDashboard.jsx";
import FuelTransactions from "./fuel/FuelTransactions.jsx";
import FuelIssue from "./fuel/FuelIssue.jsx";
import FuelPurchases from "./fuel/FuelPurchases.jsx";
import FuelAnalysis360 from "./fuel/FuelAnalysis360.jsx";
import FuelReports from "./fuel/FuelReports.jsx";
import FuelSettings from "./fuel/FuelSettings.jsx";

const TABS = [
  { key: "dashboard", label: "Dashboard", perm: "fuel.dashboard", Component: FuelDashboard },
  { key: "transactions", label: "Transactions", perm: "fuel.transactions", Component: FuelTransactions },
  { key: "issue", label: "Issue fuel", perm: "fuel.issue", Component: FuelIssue },
  { key: "purchases", label: "Purchases", perm: "fuel.purchases", Component: FuelPurchases },
  { key: "analysis", label: "360° Analysis", perm: "reports.fuel-analysis", Component: FuelAnalysis360 },
  { key: "reports", label: "Reports", perm: "fuel.reports", Component: FuelReports },
  { key: "settings", label: "Settings", perm: "fuel.settings", Component: FuelSettings },
];

export default function FuelModule() {
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  if (!ready) return null;

  const tabs = TABS.filter((t) => can(t.perm, "view"));
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
