import { useState } from "react";
import { Navigate, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";
import { ROLE_HOME } from "../lib/roleHome.js";
import { getCustomerSession } from "../lib/customerPortalApi.js";

export default function Login() {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { user, login } = useAuth();
  const navigate = useNavigate();

  // Already signed in (token saved from a previous session) — skip the form
  // entirely instead of making them type their password in again.
  if (user) {
    return <Navigate to={ROLE_HOME[user.role] || "/"} replace />;
  }

  // Round 120, item 1 — App.jsx's RootRedirect already forwards an anonymous
  // visit to "/" onward to "/portal" for anyone with a live customer-portal
  // session, but that check never ran for someone landing directly on
  // "/login" itself. That gap matters because of how iOS actually installs a
  // home-screen icon: Safari doesn't reliably honor the Web App Manifest's
  // start_url (a long-standing WebKit limitation) — it bookmarks whatever URL
  // was in the address bar the moment "Add to Home Screen" was tapped. A
  // customer who tapped the site's bare domain (rather than a link straight
  // to /portal) would have been client-side-redirected to /login by
  // RootRedirect before they got to the share sheet, so THAT is the URL that
  // got saved — meaning the installed icon opens directly on this staff
  // sign-in screen every time, forever, no matter what RootRedirect does.
  // Catching it here — on /login itself — recovers anyone in that situation
  // who still has a valid customer session.
  if (getCustomerSession()) {
    return <Navigate to="/portal" replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const u = await login(phone, password);
      navigate(ROLE_HOME[u.role] || "/");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "calc(100vh - 4px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ maxWidth: 340, width: "100%", margin: "0 16px" }}>
        <div style={{ fontSize: 12, color: "var(--rebar)", fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
          Our Own Ready Mix
        </div>
        <h1 style={{ fontSize: 20, margin: "4px 0 4px" }}>Sign in</h1>
        <p style={{ fontSize: 13, color: "var(--slate)", marginBottom: 20 }}>
          Enter your phone number and password. Your browser can remember these for next time —
          look for a "Save password" prompt after you sign in.
        </p>

        <form onSubmit={handleSubmit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label htmlFor="phone" style={{ fontSize: 13, color: "var(--slate)" }}>Phone number</label>
            <input
              id="phone" name="username" type="tel" inputMode="tel" autoComplete="username"
              value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9999999999" required
            />
          </div>
          <div>
            <label htmlFor="password" style={{ fontSize: 13, color: "var(--slate)" }}>Password</label>
            <input
              id="password" name="password" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required
            />
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ padding: 12, fontSize: 15 }}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        {/* Round 120, item 1 — the redirect above only recovers a customer
            who still has a live session. Someone opening a stale home-screen
            icon for the very first time (no session yet, per the same iOS
            start_url gap explained above) would otherwise have no way off
            this staff-only screen short of typing "/portal" in by hand. This
            link is the unconditional fallback: it costs staff nothing (they
            never tap it) and gives a stuck customer one tap back to where
            they need to be, regardless of what URL their icon is stuck on. */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--concrete)", textAlign: "center" }}>
          <Link to="/portal" style={{ fontSize: 13, color: "var(--rebar)" }}>
            Are you a customer? Open the Customer Portal
          </Link>
        </div>
      </div>
    </div>
  );
}
