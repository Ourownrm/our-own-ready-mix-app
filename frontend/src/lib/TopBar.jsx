import { useAuth } from "./AuthContext.jsx";

export function TopBar({ title }) {
  const { user, logout } = useAuth();
  return (
    <div className="topbar">
      <div className="topbar-title">
        Our Own Ready Mix <span>&middot; {title}{user?.name ? ` · ${user.name}` : ""}</span>
      </div>
      <button className="topbar-signout" onClick={logout}>Sign out</button>
    </div>
  );
}
