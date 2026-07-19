import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";
import { ROLE_HOME } from "../lib/roleHome.js";

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
      </div>
    </div>
  );
}
