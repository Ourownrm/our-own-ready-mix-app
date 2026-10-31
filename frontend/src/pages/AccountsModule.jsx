// Round 204 — the Accounts module: quotations (with follow-ups first), the
// customer / site price lists they set, invoices with the GST switch, the
// customer ledger, receipts from bank statements, the one-time migration of
// the Accountant's rate file, and quotation settings. Each tab is one function
// on the Access Control page; the tab is kept in the URL (?tab=...).
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { MODULE_TABS, tabAllowed } from "../lib/moduleTabs.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import QuotationsTab from "./accounts/QuotationsTab.jsx";
import PriceLists from "./accounts/PriceLists.jsx";
import Invoices from "./accounts/Invoices.jsx";
import CreditNotes from "./accounts/CreditNotes.jsx";
import CustomerLedger from "./accounts/CustomerLedger.jsx";
import BankReceipts from "./accounts/BankReceipts.jsx";
import Cheques from "./accounts/Cheques.jsx";
import PettyCash from "./accounts/PettyCash.jsx";
import SendToCa from "./accounts/SendToCa.jsx";
import QuotationSettings from "./accounts/QuotationSettings.jsx";

// Round 256 — the tab list (key, label, who may open it) lives in
// lib/moduleTabs.js, shared with the computer side menu.
const COMPONENTS = {
  "quotations": QuotationsTab,
  "price-lists": PriceLists,
  "invoices": Invoices,
  "credit-notes": CreditNotes,
  "ledger": CustomerLedger,
  "receipts": BankReceipts,
  "cheques": Cheques,
  "petty-cash": PettyCash,
  "send-to-ca": SendToCa,
  "settings": QuotationSettings,
};
const TABS = MODULE_TABS["accounts-module"].tabs.map((t) => ({ ...t, Component: COMPONENTS[t.key] }));

export default function AccountsModule() {
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
      <TopBar title="Accounts" />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 16px 32px" }}>
        {tabs.length === 0 ? (
          <div className="card" style={{ fontSize: 13.5 }}>
            Nothing in the Accounts module has been switched on for you. A Super Admin can give you access on the Access Control page.
          </div>
        ) : (
          <>
            <nav aria-label="Accounts module"
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
            <active.Component key={active.key} go={go} params={params} />
          </>
        )}
      </div>
    </>
  );
}
