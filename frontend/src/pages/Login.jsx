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
        <h1 style={{ fontSize: 20, margin: "4px 0 18px" }}>Sign in</h1>

        {/* Round 122 — replaces the old small "Are you a customer?" text
            link below the form with a switch that gets equal visual weight
            to staff sign-in, right at the top. Tapping "I'm a Customer"
            goes straight to the (unchanged) Customer Portal access-code
            sign-in — that screen stays exactly as it is, since it's used by
            the public too, not just customers coming from here. */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <div style={{
            flex: 1, textAlign: "center", padding: "11px 6px", borderRadius: 8, fontSize: 13, fontWeight: 700,
            background: "var(--rebar)", border: "1px solid var(--rebar)", color: "#fff",
          }}>
            Staff
          </div>
          <Link
            to="/portal"
            style={{
              flex: 1, textAlign: "center", padding: "11px 6px", borderRadius: 8, fontSize: 13, fontWeight: 700,
              border: "1px solid var(--border-strong)", color: "var(--slate)", textDecoration: "none",
            }}
          >
            I'm a Customer
          </Link>
        </div>

        <form onSubmit={handleSubmit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label htmlFor="phone" style={{ fontSize: 13, color: "var(--slate)" }}>Username</label>
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

        <div style={{ marginTop: 16, textAlign: "center", fontSize: 11.5, color: "var(--slate)" }}>
          Trouble signing in? Contact your plant office.
        </div>
      </div>
    </div>
  );
}
