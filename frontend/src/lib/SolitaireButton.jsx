// Round 149 — the Delivery Challan (Solitaire) icon.
//
// Rendered on the Plant Operator screen and nowhere else, by the user's
// explicit instruction. It renders NOTHING unless BOTH of these hold:
//
//   1. The plugin is switched on. A Super Admin can turn the whole module off
//      at any time (Super Admin screen → Plugins), and the icon has to vanish
//      when they do.
//   2. This person has been granted a Solitaire account by a Super Admin.
//
// Both facts come from ONE call — GET /api/solitaire-access/me. That endpoint
// sits behind the plugin gate on the server (routes/solitaireAccess.js), so a
// disabled plugin answers 404 and the `catch` below hides the icon. Asking a
// separate "is the plugin on?" endpoint would have meant two calls that can
// disagree with each other, and a window where the icon shows for a module
// that is already gone.
//
// The icon disappearing is presentation, not security. The gate is on the
// server: while the plugin is off every route in the module answers 404,
// including its login, so a bookmarked URL or a browser still holding a
// Solitaire session cookie gets nowhere either.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "./api.js";

export default function SolitaireButton() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    apiRequest("/solitaire-access/me")
      .then((d) => { if (alive) setShow(!!d.has_access); })
      // 404 (plugin off), 503 (enabled but unconfigured), or any network
      // failure all mean the same thing to this component: show nothing.
      .catch(() => { if (alive) setShow(false); });
    return () => { alive = false; };
  }, []);

  if (!show) return null;

  return (
    <Link
      to="/solitaire/login"
      title="Delivery Challan — opens the batching docket screen, which has its own separate login"
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 6, padding: "14px 10px", marginBottom: 12, borderRadius: 12,
        background: "#0B6E4A", color: "#fff", textDecoration: "none",
        boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
      }}
    >
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="3" width="13" height="17" rx="2" />
        <path d="M7.5 8h6M7.5 11.5h6M7.5 15h3.5" />
        <path d="M17 7l3 2v9a2 2 0 0 1-2 2h-1" />
      </svg>
      <span style={{ fontSize: 13.5, fontWeight: 700 }}>Delivery Challan</span>
      <span style={{ fontSize: 10.5, opacity: 0.85 }}>Separate login</span>
    </Link>
  );
}
