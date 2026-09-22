// Locked visual design (§2.1 of 02_FUNCTIONAL_SPEC.md) — full-page Solitaire
// screenshot background, a small centered card with ONLY Username, Password,
// Sign In. No app name, no version text, no other branding. Do not add
// anything else here without the user's explicit sign-off — this design was
// iterated on and explicitly locked.
//
// Round 150 adds ONE conditional field and nothing else: the device code, which
// appears only after this browser has been refused as unauthorized, and
// disappears again the moment it succeeds. In the normal case — an authorized
// terminal, every shift, forever — the card is exactly the locked design. A
// permanent third field would have broken that for a case that arises once per
// machine, which is why it is conditional rather than always on.
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
  const [needsCode, setNeedsCode] = useState(false);
  const [deviceCode, setDeviceCode] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await solitaireApi.login(username, password, needsCode ? deviceCode : undefined);
      navigate("/solitaire/app", { replace: true });
    } catch (err) {
      if (err.code === "DEVICE_NOT_AUTHORIZED") {
        // First refusal on this machine — reveal the code field and say what
        // to do about it, rather than the old dead end of "contact your
        // Administrator" with no way forward.
        setNeedsCode(true);
        setError("This browser isn't authorized yet. Ask an Administrator for a device code and enter it below.");
      } else if (err.code === "PAIRING_CODE_INVALID" || err.code === "DEVICE_LIMIT_REACHED") {
        setNeedsCode(true);
        setError(err.message);
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
        {needsCode && (
          <div className="sol-login-field">
            <label htmlFor="sol-code">Device code</label>
            <input
              id="sol-code" placeholder="8 characters" autoComplete="off" maxLength={8}
              value={deviceCode}
              onChange={(e) => setDeviceCode(e.target.value.toUpperCase())}
              style={{ letterSpacing: "0.18em", textTransform: "uppercase", fontFamily: "monospace" }}
            />
          </div>
        )}
        <button type="submit" className="sol-login-btn" disabled={submitting}>
          {submitting ? "Signing In…" : "Sign In"}
        </button>
        {error && <div className="sol-login-error">{error}</div>}
      </form>
    </div>
  );
}
