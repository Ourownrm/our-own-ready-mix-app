import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";
import { usePermissions } from "./PermissionContext.jsx";
import { TopBar } from "./TopBar.jsx";

// Round 192 — `perm` instead of `roles` for the screens a Super Admin
// controls. A route guarded by a hard-coded role list ignores the Access
// Control page entirely: a granted screen still bounced the person to the
// login page, and a denied one stayed open for the role. With `perm` the
// screen opens exactly when the person holds View on that function (or on any
// of them, when given a list) — the same check the backend makes, read from
// the same catalogue.
//
// A signed-in person without access sees a short "no access" page rather
// than a redirect to /login: the login page sends a signed-in person straight
// back to their home screen, so redirecting a Lab Technician whose
// Laboratory had been switched off would loop forever.
export default function ProtectedRoute({ roles, perm, children }) {
  const { user } = useAuth();
  const { can, ready } = usePermissions();
  if (!user) return <Navigate to="/login" replace />;
  // Round 148 — a Super Admin outranks every role and passes any guard, the
  // same rule the backend's requireRole applies. Without this, promoting an
  // account to super_admin took away every screen guarded
  // roles={["administrator"]}, which is nearly all of them; the account with
  // the most access could reach the least. A guard that names super_admin
  // explicitly still works, since the normal check below allows it too.
  if (user.role === "super_admin") return children;
  if (perm) {
    if (!ready) return null;
    const keys = Array.isArray(perm) ? perm : [perm];
    if (keys.some((k) => can(k, "view"))) return children;
    return <NoAccess />;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to="/login" replace />;
  return children;
}

function NoAccess() {
  return (
    <>
      <TopBar title="No access" />
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>You don&rsquo;t have access to this screen.</div>
          A Super Admin decides who can open each module and screen. If you need it, ask them to switch it on for you.
          <div style={{ marginTop: 12 }}>
            <Link to="/modules"><button type="button">See the modules you can open</button></Link>
          </div>
        </div>
      </div>
    </>
  );
}
