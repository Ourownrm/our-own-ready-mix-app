import { Link, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { ROLE_HOME } from "./roleHome.js";

export function TopBar({ title }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const myHome = user ? ROLE_HOME[user.role] : null;
  const onOwnDashboard = myHome && pathname === myHome;

  return (
    <div className="topbar">
      <div className="topbar-title">
        Our Own Ready Mix <span>&middot; {title}{user?.name ? ` · ${user.name}` : ""}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
