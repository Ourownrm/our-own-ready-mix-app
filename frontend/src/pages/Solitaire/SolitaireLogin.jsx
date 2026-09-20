// Locked visual design (§2.1 of 02_FUNCTIONAL_SPEC.md) — full-page Solitaire
// screenshot background, a small centered card with ONLY Username, Password,
// Sign In. No app name, no version text, no other branding. Do not add
// anything else here without the user's explicit sign-off — this design was
// iterated on and explicitly locked.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { solitaireApi } from "../../lib/solitaireApi.js";
import "./solitaire.css";

export default function SolitaireLogin() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await solitaireApi.login(username, password);
      navigate("/solitaire/app", { replace: true });
    } catch (err) {
      if (err.code === "DEVICE_NOT_AUTHORIZED") {
        setError("This browser/device is not authorized. Contact your Administrator.");
      } else {
        setError(err.message || "Invalid username or password.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="solitaire-root sol-login-screen">
      <form className="sol-login-card" onSubmit={handleSubmit}>
        <div className="sol-login-field">
          <label htmlFor="sol-user">Username</label>
          <input
            id="sol-user" placeholder="Username" autoComplete="username"
            value={username} onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="sol-login-field">
          <label htmlFor="sol-pass">Password</label>
          <input
            id="sol-pass" type="password" placeholder="Password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="sol-login-btn" disabled={submitting}>
          {submitting ? "Signing In…" : "Sign In"}
        </button>
        {error && <div className="sol-login-error">{error}</div>}
      </form>
    </div>
  );
}
