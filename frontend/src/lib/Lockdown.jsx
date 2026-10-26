// Round 242 — the emergency lock (owner, 26 Oct 2026). While the Super Admin
// has the app locked, every screen is replaced by this one, except signing in,
// Mark attendance and My attendance (and the public website pages). The
// server refuses everything else on its own (backend lib/lockdown.js) — this
// screen only says so plainly instead of showing errors everywhere.
import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { apiRequest } from "./api.js";
import { useAuth } from "./AuthContext.jsx";

const OPEN_WHILE_LOCKED = ["/login", "/mark-attendance", "/my-attendance", "/services", "/rmc-vs-sitemix", "/technical-assistance", "/inquiry"];
const fmtWhen = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export function LockdownGate({ children }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [lock, setLock] = useState({ locked: false, since: null });
  const refresh = useCallback(() => apiRequest("/lockdown").then(setLock).catch(() => {}), []);
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60000);
    const onLock = (e) => setLock({ locked: true, since: e.detail?.since || null });
    const onOut = () => logoutRef.current();
    window.addEventListener("oorm-lockdown", onLock);
    window.addEventListener("oorm-signed-out", onOut);
    return () => { clearInterval(t); window.removeEventListener("oorm-lockdown", onLock); window.removeEventListener("oorm-signed-out", onOut); };
  }, [refresh]);
  if (!lock.locked || OPEN_WHILE_LOCKED.includes(pathname)) return children;
  return <LockedScreen since={lock.since} user={user} onChange={refresh} />;
}

function LockedScreen({ since, user, onChange }) {
  const { logout } = useAuth();
  return (
    <div style={{ minHeight: "100vh", background: "var(--concrete, #F4F2EE)", padding: "40px 16px" }}>
      <div style={{ maxWidth: 460, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card" style={{ borderTop: "4px solid var(--alert-red)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" fill="var(--alert-red)" /><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="var(--alert-red)" strokeWidth="2" /></svg>
            <div style={{ fontSize: 18, fontWeight: 700 }}>The app is locked</div>
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
            The Super Admin has locked the app{since ? ` since ${fmtWhen(since)}` : ""}. Nothing can be opened until it is unlocked.
            {user ? " You can still mark your attendance." : " Sign in to mark your attendance."}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
            {user ? (
              <>
                <Link to="/mark-attendance" className="btn-primary" style={{ padding: "10px 14px", borderRadius: 8, textDecoration: "none", fontSize: 13.5, fontWeight: 600 }}>Mark attendance</Link>
                <Link to="/my-attendance" style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border-strong)", textDecoration: "none", fontSize: 13.5, color: "var(--charcoal)" }}>My attendance</Link>
                <button type="button" onClick={logout} style={{ fontSize: 13 }}>Sign out</button>
              </>
            ) : (
              <Link to="/login" className="btn-primary" style={{ padding: "10px 14px", borderRadius: 8, textDecoration: "none", fontSize: 13.5, fontWeight: 600 }}>Sign in</Link>
            )}
          </div>
        </div>
        {user?.role === "super_admin" && <UnlockPanel onDone={onChange} />}
      </div>
    </div>
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
            If you suspect a security breach, lock the app. Every function stops for everyone — Administrator, you, customers, links and the plant computers.
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
