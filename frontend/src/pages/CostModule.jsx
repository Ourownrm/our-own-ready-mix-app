// Round 218 — the Cost module (owner's mock-up "Monthly Cost Dashboard"):
// Cost dashboard, Profit & Loss, Balance Sheet. Administrator only by
// default. The tab and month live in the URL so a link or the back button
// lands on the same view.
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import CostDashboardTab from "./cost/CostDashboardTab.jsx";
import CostPLTab from "./cost/CostPLTab.jsx";
import CostBSTab from "./cost/CostBSTab.jsx";
import CostBreakEvenTab from "./cost/CostBreakEvenTab.jsx";
import CostBankTab from "./cost/CostBankTab.jsx";
import CostLoansTab from "./cost/CostLoansTab.jsx";
import CostCLedgerTab from "./cost/CostCLedgerTab.jsx";
import CostGstTab from "./cost/CostGstTab.jsx";
import { currentMonth, addMonths } from "./cost/costUi.jsx";

const TABS = [
  { key: "dashboard", label: "Cost dashboard", perm: "cost.dashboard", Component: CostDashboardTab },
  { key: "pl", label: "Profit & Loss", perm: "cost.pl", Component: CostPLTab },
  { key: "balance-sheet", label: "Balance Sheet", perm: "cost.balance-sheet", Component: CostBSTab },
  // Round 221
  { key: "break-even", label: "Break-even", perm: "cost.break-even", Component: CostBreakEvenTab },
  // Round 223
  { key: "bank", label: "Bank statements", perm: "cost.bank", Component: CostBankTab },
  // Round 239 — loans on their own page.
  { key: "loans", label: "Loans", perm: "cost.bank", Component: CostLoansTab },
  // Round 236
  { key: "gst", label: "GST payable", perm: "cost.gst", Component: CostGstTab },
  // Round 224 — only for people given C Ledger rights by name (not by role).
  { key: "c-ledger", label: "C Ledger", perm: "cledger.access", Component: CostCLedgerTab },
];

export default function CostModule() {
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  if (!ready) return null;

  const tabs = TABS.filter((t) => can(t.perm, "view"));
  const active = tabs.find((t) => t.key === params.get("tab")) || tabs[0];
  const now = currentMonth();
  const wanted = params.get("month");
  // Default: the last full month — the one Accounts has closed.
  const month = /^\d{4}-\d{2}$/.test(wanted || "") && wanted <= now ? wanted : addMonths(now, -1);

  function go(key) {
    setParams({ tab: key, month });
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
