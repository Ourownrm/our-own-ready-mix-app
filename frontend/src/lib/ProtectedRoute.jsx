import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";

export default function ProtectedRoute({ roles, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Round 148 — a Super Admin outranks every role and passes any guard, the
  // same rule the backend's requireRole applies. Without this, promoting an
  // account to super_admin took away every screen guarded
  // roles={["administrator"]}, which is nearly all of them; the account with
  // the most access could reach the least. A guard that names super_admin
  // explicitly still works, since the normal check below allows it too.
  if (user.role === "super_admin") return children;
  if (roles && !roles.includes(user.role)) return <Navigate to="/login" replace />;
  return children;
}
