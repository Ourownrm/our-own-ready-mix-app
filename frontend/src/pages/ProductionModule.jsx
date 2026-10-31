// Round 254 — the Production module, one page with tabs like Accounts (owner,
// 31 Oct 2026; mock-up "Production Module Redesign"). Each tab is its own
// function on the Access Control page; the tab is kept in the URL (?tab=...).
//   Plant overview   — the Plant Manager dashboard (alerts, approvals, status)
//   Orders           — order list by day, New order, corrections
//   Delivery tickets — the day's loads by order, quantity corrections
//   Vehicle tracking — running orders' trucks: map and five-stage bar
//   Customers & sites— the customer file with its sites
//   Production target, Reports
import { useSearchParams, Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { MODULE_TABS, PRODUCTION_REPORTS, tabAllowed } from "../lib/moduleTabs.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import ManagerDashboard from "./ManagerDashboard.jsx";
import OrdersTab from "./production/OrdersTab.jsx";
import TicketsTab from "./production/TicketsTab.jsx";
import TrackingTab from "./production/TrackingTab.jsx";
import CustomersTab from "./production/CustomersTab.jsx";
import { ProductionTargetPanel } from "../lib/MasterDataPanels.jsx";
import { useState } from "react";

function TargetTab() {
  const [error, setError] = useState("");
  return (
    <>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <ProductionTargetPanel setError={setError} />
    </>
  );
}

// Round 256 — the report list lives in lib/moduleTabs.js (the Reports tab
// shows only when one of these is held, there and in the side menu).
const REPORTS = PRODUCTION_REPORTS;

function ReportsTab() {
  const { can } = usePermissions();
  const list = REPORTS.filter((r) => can(r.perm, "view"));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
      {list.map((r) => (
        <Link key={r.to} to={r.to} className="card" style={{ textDecoration: "none", color: "var(--charcoal)", fontWeight: 600, fontSize: 14, display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 56 }}>
          {r.label} <span style={{ color: "var(--rebar)" }}>→</span>
        </Link>
      ))}
    </div>
  );
}

// Round 256 — the tab list (key, label, who may open it) lives in
// lib/moduleTabs.js, shared with the computer side menu.
const COMPONENTS = {
  "overview": ({ go }) => <ManagerDashboard embedded onGo={go} />,
  "orders": OrdersTab,
  "tickets": TicketsTab,
  "tracking": TrackingTab,
  "customers": CustomersTab,
  "target": TargetTab,
  "reports": ReportsTab,
};
const TABS = MODULE_TABS["production"].tabs.map((t) => ({ ...t, Component: COMPONENTS[t.key] }));

export default function ProductionModule({ defaultTab }) {
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  if (!ready) return null;

  const tabs = TABS.filter((t) => tabAllowed(t, can));
  const wanted = params.get("tab") || defaultTab;
  const active = tabs.find((t) => t.key === wanted) || tabs[0];

  function go(key, extra = {}) {
    setParams({ tab: key, ...extra });
    window.scrollTo(0, 0);
  }

  return (
    <>
      <TopBar title="Production" />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 16px 32px" }}>
        {tabs.length === 0 ? (
          <div className="card" style={{ fontSize: 13.5 }}>
            Nothing in the Production module has been switched on for you. A Super Admin can give you access on the Access Control page.
          </div>
        ) : (
          <>
            <nav aria-label="Production module"
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
            {active.key === "overview"
              ? <active.Component key={active.key} go={go} params={params} />
              : <div className="field-input"><active.Component key={active.key} go={go} params={params} /></div>}
          </>
        )}
      </div>
    </>
  );
}
