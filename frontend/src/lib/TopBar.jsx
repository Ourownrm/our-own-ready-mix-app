import { Link, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";

export function TopBar({ title }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  return (
    <div className="topbar">
      <div className="topbar-title">
        Our Own Ready Mix <span>&middot; {title}{user?.name ? ` · ${user.name}` : ""}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
