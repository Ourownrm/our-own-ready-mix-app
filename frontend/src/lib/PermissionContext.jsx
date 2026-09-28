// Round 146 — the signed-in person's effective permissions, fetched once on
// load from /auth/me and refreshed on demand.
//
// This is the FRONTEND half of the system and it decides only what is worth
// showing. The backend is the real gate: every converted route carries both
// its original `requireRole` and a `requirePermission`, so hiding a tile here
// is a courtesy, never the security boundary. That split matters in this
// project specifically — frontend and backend guards disagreeing has been a
// repeated bug, which is why both halves read the same catalogue.
//
// While the fetch is in flight `ready` is false. Callers should show nothing
// permission-dependent until then rather than flashing tiles that are about to
// disappear.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiRequest } from "./api.js";
import { useAuth } from "./AuthContext.jsx";

const PermissionContext = createContext({ permissions: {}, ready: false, can: () => false, refresh: () => {} });

export function PermissionProvider({ children }) {
  const { user } = useAuth();
  const [permissions, setPermissions] = useState({});
  const [byScreen, setByScreen] = useState({});
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) { setPermissions({}); setByScreen({}); setReady(true); return; }
    try {
      const me = await apiRequest("/auth/me");
      setPermissions(me.permissions || {});
      setByScreen(me.permission_by_screen || {});
    } catch {
      // A failed fetch must not silently grant everything. An empty set plus
      // ready=true hides permission-gated things; the backend would refuse
      // them anyway, so this fails closed.
      setPermissions({});
    } finally {
      setReady(true);
    }
  }, [user]);

  useEffect(() => { setReady(false); refresh(); }, [refresh]);

  const value = useMemo(() => {
    const can = (key, action = "view") => !!(permissions[key] || []).includes(action);
    return {
      permissions,
      permissionByScreen: byScreen,
      ready,
      can,
      // A dashboard screen with no permission mapped is shown — a screen the
      // catalogue does not cover is not something to hide by accident.
      canScreen: (screenKey, action = "view") => {
        const key = byScreen[screenKey];
        return key ? can(key, action) : true;
      },
      refresh,
    };
  }, [permissions, byScreen, ready, refresh]);

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissions() {
  return useContext(PermissionContext);
}

// Round 165 — a tiny gate for permission-driven navigation. Renders its
// children only when the current user may view (or `action`) the given key.
// Used across the role home screens so a Super Admin grant or revoke shows or
// hides a link. While permissions are still loading it renders nothing, so a
// link never flashes in before being hidden.
export function IfCan({ perm, action = "view", children }) {
  const { can, ready } = usePermissions();
  if (!ready || !can(perm, action)) return null;
  return children;
}
