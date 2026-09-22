import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { ROLE_HOME } from "./roleHome.js";
import { pushSupported, pushStatus, enablePush } from "./push.js";
import { APP_VERSION } from "./version.js";
import SolitaireButton, { SOLITAIRE_ROLES } from "./SolitaireButton.jsx";

// Round 138, item 2 — a live clock so anyone using the app can see the current
// date/time at a glance without switching away to check their phone. Ticks
// every second; formatted with the browser's own locale/timezone, so it always
// matches whatever time the device itself is showing.
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const ROLE_LABELS = {
  super_admin: "Super Admin", administrator: "Administrator", manager: "Manager", plant_operator: "Plant Operator",
  qc_engineer: "QC Engineer", driver: "Driver", site_supervisor: "Site Supervisor",
  accountant: "Accountant", sales_executive: "Sales Executive", store: "Store",
  lab_technician: "Lab Technician", loader_operator: "Loader Operator",
};

// Round 145 — the header had six things competing for one line (app name,
// version, page title, user name, refresh, notifications, back link, orders
// link, sign out) and on a phone it wrapped into three cramped rows before any
// page content appeared.
//
// Split by what each thing is FOR:
//   Header  — where you are and where you can go: app name, page title, and
//             the two navigation links. Nothing else.
//   Footer  — who you are and what the app is: version, name · role, sign out,
//             refresh, notifications, and the clock that was already there.
//
// The footer was previously `pointer-events: none` (a read-only clock strip).
// It now holds real controls, so that is gone — see index.css, where the
// height reserved by #root's padding-bottom grew to match.
export function TopBar({ title }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const myHome = user ? ROLE_HOME[user.role] : null;
  const onOwnDashboard = myHome && pathname === myHome;
  const [notifStatus, setNotifStatus] = useState(null);
  const now = useClock();

  useEffect(() => {
    if (pushSupported()) pushStatus().then(setNotifStatus);
  }, []);

  async function handleEnableNotifications() {
    try {
      await enablePush();
      setNotifStatus("subscribed");
    } catch (err) {
      window.alert(err.message || "Couldn't enable notifications.");
      setNotifStatus(await pushStatus());
    }
  }

  const [refreshing, setRefreshing] = useState(false);
  async function handleRefresh() {
    setRefreshing(true);
    try {
      // A plain reload can still be served by an already-active service
      // worker running an old cached bundle — this asks it to check for a
      // newer version first, so a refresh here actually has a chance of
      // picking up the latest deploy, not just re-running stale code.
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {
      // no service worker, or the check itself failed — a plain reload below still helps
    }
    window.location.reload();
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">
          Our Own Ready Mix <span className="topbar-page">&middot; {title}</span>
        </div>
        <div className="topbar-nav">
          {!onOwnDashboard && myHome && (
            <Link to={myHome} className="topbar-link">&larr; Dashboard</Link>
          )}
          {pathname !== "/orders" && (
            <Link to="/orders" className="topbar-link">Today &amp; tomorrow's orders</Link>
          )}
          {/* Round 151, item 7 — the Delivery Challan entry moved from a tile on
              the Plant Operator screen into the header, so it is reachable from
              wherever somebody is. It renders nothing unless the plugin is on
              AND this person has been granted an account, so listing the roles
              here only decides who it is OFFERED to. */}
          {user?.role && SOLITAIRE_ROLES.includes(user.role) && <SolitaireButton />}
        </div>
      </div>

      <div className="app-footer">
        <div className="app-footer-who">
          {user?.name && <span className="app-footer-name">{user.name}</span>}
          {user?.role && <span className="app-footer-role">{ROLE_LABELS[user.role] || user.role}</span>}
          <span className="app-footer-ver">v{APP_VERSION}</span>
        </div>

        <div className="app-footer-clock" title="Current date and time on this device">
          {now.toLocaleString([], { day: "2-digit", month: "short", year: "numeric" })}
          {" · "}
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </div>

        <div className="app-footer-actions">
          {notifStatus === "default" && (
            <button type="button" className="app-footer-btn" onClick={handleEnableNotifications} title="Enable notifications">
              🔔<span className="app-footer-btn-label"> Notifications</span>
            </button>
          )}
          <button
            type="button"
            className="app-footer-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh this page and check for the latest version"
          >
            ↻<span className="app-footer-btn-label"> {refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
          <button type="button" className="app-footer-btn" onClick={logout}>Sign out</button>
        </div>
      </div>
    </>
  );
}
