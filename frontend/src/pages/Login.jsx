import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";

const ROLE_HOME = {
  administrator: "/administrator", manager: "/manager", plant_operator: "/plant-operator",
  qc_engineer: "/qc", driver: "/driver", site_supervisor: "/site-supervisor",
  accountant: "/accountant",
};

export default function Login() {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const user = await login(phone, password);
      navigate(ROLE_HOME[user.role] || "/");
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
        <p style={{ fontSize: 13, color: "var(--slate)", marginBottom: 20 }}>Enter your phone number and password.</p>

        <form onSubmit={handleSubmit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ fontSize: 13, color: "var(--slate)" }}>Phone number</label>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9999999999" required />
          </div>
          <div>
            <label style={{ fontSize: 13, color: "var(--slate)" }}>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
