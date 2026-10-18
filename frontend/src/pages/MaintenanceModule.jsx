// Round 215 — the Maintenance module (built to the owner's mockup v5).
// Each tab is one function on the Access Control page; the tab and any open
// record (job card, PO, asset) live in the URL so a link or the back button
// lands on the same view.
import { useSearchParams, Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import MntDashboard from "./maintenance/MntDashboard.jsx";
import MntEquipment from "./maintenance/MntEquipment.jsx";
import MntSchedules from "./maintenance/MntSchedules.jsx";
import MntInspection from "./maintenance/MntInspection.jsx";
import MntJobCards from "./maintenance/MntJobCards.jsx";
import MntOutside from "./maintenance/MntOutside.jsx";
import MntStore from "./maintenance/MntStore.jsx";
import MntPurchase from "./maintenance/MntPurchase.jsx";
import MntPayments from "./maintenance/MntPayments.jsx";

const TABS = [
  { key: "dashboard", label: "Dashboard", perm: "mnt.dashboard", Component: MntDashboard },
  { key: "equipment", label: "Equipment", perm: "mnt.equipment", Component: MntEquipment },
  { key: "schedules", label: "PM schedules", perm: "mnt.schedules", Component: MntSchedules },
  { key: "inspection", label: "PM Inspection", perm: "mnt.inspections", Component: MntInspection },
  { key: "job-cards", label: "Job cards", perm: "mnt.job-cards", Component: MntJobCards },
  { key: "outside", label: "Outside repairs", perm: "mnt.outside-repairs", Component: MntOutside },
  { key: "purchase", label: "Parts, PO & GRV", perm: "mnt.purchase-orders", Component: MntPurchase },
  { key: "store", label: "Store stock", perm: "mnt.store", Component: MntStore },
  { key: "payments", label: "Payments", perm: "mnt.payments", Component: MntPayments },
];

export default function MaintenanceModule() {
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
      <TopBar title="Maintenance" />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 16px 32px" }}>
        {tabs.length === 0 ? (
          <div className="card" style={{ fontSize: 13.5 }}>
            Nothing in the Maintenance module has been switched on for you. A Super Admin can give you access on the Access Control page.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <nav aria-label="Maintenance module"
                style={{ flex: 1, display: "flex", gap: 4, overflowX: "auto", borderBottom: "1px solid var(--border-strong)", marginBottom: 18, WebkitOverflowScrolling: "touch" }}>
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
              {can("mnt.complaints", "create") && (
                <Link to="/maintenance-complaint" style={{ marginBottom: 22, flex: "none" }}>
                  <button type="button" className="btn-primary" style={{ padding: "8px 12px", fontSize: 13 }}>+ Raise complaint</button>
                </Link>
              )}
            </div>
            <active.Component key={active.key} go={go} params={params} />
          </>
        )}
      </div>
    </>
  );
}
