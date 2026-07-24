import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { ROLE_HOME } from "./roleHome.js";
import { pushSupported, pushStatus, enablePush } from "./push.js";

export function TopBar({ title }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const myHome = user ? ROLE_HOME[user.role] : null;
  const onOwnDashboard = myHome && pathname === myHome;
  const [notifStatus, setNotifStatus] = useState(null);

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

  return (
    <div className="topbar">
      <div className="topbar-title">
        Our Own Ready Mix <span>&middot; {title}{user?.name ? ` · ${user.name}` : ""}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
