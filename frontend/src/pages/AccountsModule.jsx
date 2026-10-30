// Round 204 — the Accounts module: quotations (with follow-ups first), the
// customer / site price lists they set, invoices with the GST switch, the
// customer ledger, receipts from bank statements, the one-time migration of
// the Accountant's rate file, and quotation settings. Each tab is one function
// on the Access Control page; the tab is kept in the URL (?tab=...).
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import QuotationsTab from "./accounts/QuotationsTab.jsx";
import PriceLists from "./accounts/PriceLists.jsx";
import Invoices from "./accounts/Invoices.jsx";
import CreditNotes from "./accounts/CreditNotes.jsx";
import CustomerLedger from "./accounts/CustomerLedger.jsx";
import BankReceipts from "./accounts/BankReceipts.jsx";
import QuotationSettings from "./accounts/QuotationSettings.jsx";

const TABS = [
  { key: "quotations", label: "Quotations", perm: "accounts.quotations", Component: QuotationsTab },
  { key: "price-lists", label: "Price lists", perm: "accounts.price-lists", Component: PriceLists },
  { key: "invoices", label: "Invoices", perm: "accounts.invoice-list", Component: Invoices },
  // Round 252 — credit notes with Administrator approval.
  { key: "credit-notes", label: "Credit notes", perm: "accounts.credit-notes", Component: CreditNotes },
  { key: "ledger", label: "Customer ledger", perm: "accounts.customer-ledger", Component: CustomerLedger },
  { key: "receipts", label: "Bank receipts", perm: "accounts.bank-receipts", Component: BankReceipts },
  // Round 252 — the old rate file screen is switched off (owner, 30 Oct 2026);
  // what is left of it is the "merge same rates" card on Price lists.
  // { key: "migration", label: "Rate migration", perm: "accounts.rate-migration", Component: RateMigration },
  { key: "settings", label: "Settings", perm: "accounts.quotation-settings", Component: QuotationSettings },
];

export default function AccountsModule() {
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
