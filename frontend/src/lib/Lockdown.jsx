// Round 242 — the emergency lock (owner, 26 Oct 2026). While the Super Admin
// has the app locked, every screen is replaced by this one, except signing in,
// Mark attendance and My attendance (and the public website pages). The
// server refuses everything else on its own (backend lib/lockdown.js) — this
// screen only says so plainly instead of showing errors everywhere.
import { useEffect, useState, useCallback, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { LockContext } from "./lockContext.js";
import MarkAttendance from "../pages/MarkAttendance.jsx";
import { apiRequest } from "./api.js";
import { useAuth } from "./AuthContext.jsx";

// Round 243 (owner, 26 Oct 2026): "when the app is locked, no need to show
// the message — directly show the attendance screen, nothing else". Signed in
// → Mark attendance, whatever the address (a Super Admin also gets the unlock
// form under it). Not signed in → the sign-in page. The public website pages
// stay as they are.
const PUBLIC_WHILE_LOCKED = ["/services", "/rmc-vs-sitemix", "/technical-assistance", "/inquiry"];
const fmtWhen = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export function LockdownGate({ children }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [lock, setLock] = useState({ locked: false, since: null });
  // Round 252 — locking signs everyone out. While locked, a signed-in screen
  // asks "who am I" so a session from before the lock is ended at once (the
  // server answers "signed_out" and the listener below signs this tab out).
  const userRef = useRef(user);
  userRef.current = user;
  const refresh = useCallback(() => apiRequest("/lockdown").then((l) => {
    setLock(l);
    if (l?.locked && userRef.current) apiRequest("/auth/me").catch(() => {});
  }).catch(() => {}), []);
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    const onLock = (e) => { setLock({ locked: true, since: e.detail?.since || null }); if (userRef.current) apiRequest("/auth/me").catch(() => {}); };
    const onOut = () => logoutRef.current();
    window.addEventListener("oorm-lockdown", onLock);
    window.addEventListener("oorm-signed-out", onOut);
    return () => { clearInterval(t); window.removeEventListener("oorm-lockdown", onLock); window.removeEventListener("oorm-signed-out", onOut); };
  }, [refresh]);
  if (!lock.locked || PUBLIC_WHILE_LOCKED.includes(pathname)) return children;
  if (!user) return pathname === "/login" ? children : <Navigate to="/login" replace />;
  return (
    <LockContext.Provider value={true}>
      <MarkAttendance />
      {user.role === "super_admin" && (
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}><UnlockPanel onDone={refresh} /></div>
      )}
    </LockContext.Provider>
  );
}

function UnlockPanel({ onDone }) {
  const { logout } = useAuth();
  const [pw, setPw] = useState("");
  const [signOut, setSignOut] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function unlock(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const r = await apiRequest("/lockdown/off", { method: "POST", body: { password: pw, sign_out_all: signOut } });
      if (r.signed_out) { alert("The app is unlocked. Everyone has been signed out — sign in again."); logout(); }
      onDone();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  }
  return (
    <form className="card" onSubmit={unlock} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>Super Admin — unlock the app</div>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Your password
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required /></label>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
        <input type="checkbox" checked={signOut} onChange={(e) => setSignOut(e.target.checked)} style={{ marginTop: 3 }} />
        <span>Sign everyone out (recommended) — every phone and computer must sign in again, so a stolen sign-in stops working. Change any password you think was seen first.</span>
      </label>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <button type="submit" className="btn-primary" disabled={busy || !pw}>{busy ? "Unlocking…" : "Unlock the app"}</button>
    </form>
  );
}

// The switch on the Super Admin page.
export function EmergencyLockCard() {
  const [st, setSt] = useState(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => apiRequest("/lockdown/admin").then(setSt).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  async function lockNow() {
    setErr(""); setBusy(true);
    try {
      await apiRequest("/lockdown/on", { method: "POST", body: { reason } });
      window.dispatchEvent(new CustomEvent("oorm-lockdown", { detail: { since: new Date().toISOString() } }));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  if (!st) return err ? <div className="card" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 14 }}>{err}</div> : null;
  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: "4px solid var(--alert-red)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Emergency lock</div>
          <div style={{ fontSize: 12.5, color: "var(--slate)", maxWidth: 640, lineHeight: 1.5 }}>
            If you suspect a security breach, lock the app. Every function stops for everyone — Administrator, you, customers, links and the plant computers. Locking signs everyone out at once, you included — sign in again to reach the unlock form.
            Only each person&rsquo;s own attendance (Mark attendance, My attendance) keeps working. Unlocking needs your password.
          </div>
        </div>
        {!confirm && (
          <button type="button" onClick={() => { setConfirm(true); setTyped(""); }}
            style={{ background: "var(--alert-red)", color: "#fff", border: "none", borderRadius: 999, padding: "10px 18px", fontWeight: 700, fontSize: 13.5, minHeight: 42 }}>
            Lock the app now
          </button>
        )}
      </div>
      {confirm && (
        <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Reason (kept in the history)
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. password shared by mistake" /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Type LOCK to confirm
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={busy || typed.trim().toUpperCase() !== "LOCK"} onClick={lockNow}
              style={{ background: "var(--alert-red)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700 }}>{busy ? "Locking…" : "Lock everything"}</button>
            <button type="button" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{err}</div>}
      {st.log?.length > 0 && (
        <details style={{ marginTop: 10, fontSize: 12.5 }}>
          <summary style={{ cursor: "pointer", color: "var(--slate)" }}>History ({st.log.length})</summary>
          <table style={{ width: "100%", marginTop: 6, fontSize: 12.5 }}>
            <tbody>
              {st.log.map((g, i) => (
                <tr key={i}><td>{fmtWhen(g.at)}</td><td>{g.action === "lock" ? "Locked" : g.action === "unlock+signout" ? "Unlocked, everyone signed out" : "Unlocked"}</td><td>{g.user_name || ""}</td><td style={{ color: "var(--slate)" }}>{g.reason || ""}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
