import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";

const ROLE_HOME = {
  administrator: "/administrator",
  manager: "/manager",
  plant_operator: "/plant-operator",
  qc_engineer: "/plant-operator",
  driver: "/driver",
  site_supervisor: "/site-supervisor",
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
    <div style={{ maxWidth: 340, margin: "80px auto", padding: 24 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Our Own Ready Mix</h1>
      <p style={{ fontSize: 13, color: "#666", marginBottom: 24 }}>Sign in to continue</p>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ fontSize: 13, color: "#666" }}>Phone number</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="9999999999"
            style={{ width: "100%", padding: 10, fontSize: 15 }}
            required
          />
        </div>
        <div>
          <label style={{ fontSize: 13, color: "#666" }}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: 10, fontSize: 15 }}
            required
          />
        </div>
        {error && <div style={{ color: "#c0392b", fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={loading} style={{ padding: 12, fontSize: 15 }}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
