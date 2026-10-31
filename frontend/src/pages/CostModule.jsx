// Round 218 — the Cost module (owner's mock-up "Monthly Cost Dashboard"):
// Cost dashboard, Profit & Loss, Balance Sheet. Administrator only by
// default. The tab and month live in the URL so a link or the back button
// lands on the same view.
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { MODULE_TABS, tabAllowed } from "../lib/moduleTabs.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import CostDashboardTab from "./cost/CostDashboardTab.jsx";
import CostPLTab from "./cost/CostPLTab.jsx";
import CostBSTab from "./cost/CostBSTab.jsx";
import CostBreakEvenTab from "./cost/CostBreakEvenTab.jsx";
import CostBankTab from "./cost/CostBankTab.jsx";
import CostLoansTab from "./cost/CostLoansTab.jsx";
import CostPartnersTab from "./cost/CostPartnersTab.jsx";
import CostWaterTab from "./cost/CostWaterTab.jsx";
import CostCLedgerTab from "./cost/CostCLedgerTab.jsx";
import CostGstTab from "./cost/CostGstTab.jsx";
import { currentMonth, addMonths } from "./cost/costUi.jsx";

// Round 256 — the tab list (key, label, who may open it) lives in
// lib/moduleTabs.js, shared with the computer side menu.
const COMPONENTS = {
  "dashboard": CostDashboardTab,
  "pl": CostPLTab,
  "balance-sheet": CostBSTab,
  "break-even": CostBreakEvenTab,
  "water": CostWaterTab,
  "bank": CostBankTab,
  "loans": CostLoansTab,
  "partners": CostPartnersTab,
  "gst": CostGstTab,
  "c-ledger": CostCLedgerTab,
};
const TABS = MODULE_TABS["cost-module"].tabs.map((t) => ({ ...t, Component: COMPONENTS[t.key] }));

export default function CostModule() {
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  if (!ready) return null;

  const tabs = TABS.filter((t) => tabAllowed(t, can));
  const active = tabs.find((t) => t.key === params.get("tab")) || tabs[0];
  const now = currentMonth();
  const wanted = params.get("month");
  // Default: the last full month — the one Accounts has closed. Round 249 —
  // Break-even opens on the current month (owner, 28 Oct 2026).
  const dflt = (t) => (t?.current ? now : addMonths(now, -1));
  const month = /^\d{4}-\d{2}$/.test(wanted || "") && wanted <= now ? wanted : dflt(active);

  function go(key) {
    // Moving between tabs keeps a month you picked; a tab's own default otherwise.
    const target = tabs.find((t) => t.key === key);
    const picked = month !== dflt(active);
    setParams({ tab: key, month: picked ? month : dflt(target) });
    window.scrollTo(0, 0);
  }
  function setMonth(m) {
    setParams({ tab: active.key, month: m });
  }

  return (
    <>
      <div className="no-print"><TopBar title="Cost" /></div>
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "16px 16px 40px" }}>
        {tabs.length === 0 ? (
          <div className="card" style={{ fontSize: 13.5 }}>
            Nothing in the Cost module has been switched on for you. A Super Admin can give you access on the Access Control page.
          </div>
        ) : (
          <>
            <nav aria-label="Cost module" className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
              {tabs.map((t) => {
                const on = t.key === active.key;
                return (
                  <button key={t.key} type="button" onClick={() => go(t.key)} aria-current={on ? "page" : undefined}
                    style={{ padding: "9px 16px", minHeight: 40, borderRadius: 999, fontSize: 13, fontWeight: on ? 600 : 400,
                      border: `1px solid ${on ? "var(--charcoal)" : "var(--border-strong)"}`,
                      background: on ? "var(--charcoal)" : "var(--surface)", color: on ? "#fff" : "var(--charcoal)" }}>
                    {t.label}
                  </button>
                );
              })}
            </nav>
            <active.Component key={active.key} month={month} setMonth={setMonth} />
          </>
        )}
      </div>
    </>
  );
}
