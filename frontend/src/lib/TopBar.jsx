import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { ROLE_HOME } from "./roleHome.js";
import { pushSupported, pushStatus, enablePush } from "./push.js";
import { APP_VERSION } from "./version.js";

// Round 138, item 2 — a live clock in the header so anyone using the app
// can see the current date/time at a glance, without switching away to
// check their phone. Ticks every second; formatted with the browser's own
// locale/timezone (same approach already used elsewhere in the app, e.g.
// FuelFilling.jsx's "Issued today" timestamps), so it always matches
// whatever time the device itself is showing.
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

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
    <div className="topbar">
      <div className="topbar-title">
        Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span> <span>&middot; {title}{user?.name ? ` · ${user.name}` : ""}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          title="Current date and time on this device"
          style={{ color: "#D7DBDF", fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
        >
          {now.toLocaleString([], { day: "2-digit", month: "short", year: "numeric" })}
          {" · "}
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh this page and check for the latest version"
          style={{ background: "transparent", border: "1px solid #D7DBDF", color: "#D7DBDF", fontSize: 12, padding: "4px 10px", borderRadius: 999 }}
        >
          {refreshing ? "Refreshing..." : "↻ Refresh"}
        </button>
        {notifStatus === "default" && (
          <button
            onClick={handleEnableNotifications}
            style={{ background: "transparent", border: "1px solid #D7DBDF", color: "#D7DBDF", fontSize: 12, padding: "4px 10px", borderRadius: 999 }}
          >
            🔔 Enable notifications
          </button>
        )}
        {!onOwnDashboard && myHome && (
          <Link to={myHome} style={{ color: "#D7DBDF", fontSize: 12, textDecoration: "none" }}>
            &larr; Back to my dashboard
          </Link>
        )}
        {pathname !== "/orders" && (
          <Link to="/orders" style={{ color: "#D7DBDF", fontSize: 12, textDecoration: "none" }}>
            Today &amp; tomorrow's orders
          </Link>
        )}
        <button className="topbar-signout" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}
