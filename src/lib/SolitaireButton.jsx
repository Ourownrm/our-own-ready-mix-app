// The Delivery Challan (Solitaire) entry point.
//
// Round 151 — two changes from Round 149, both from live use:
//
//   1. It lives in the HEADER now (see TopBar.jsx), not as a tile on the Plant
//      Operator screen, so it is reachable from wherever somebody happens to
//      be rather than only from one dashboard. The `variant` prop keeps the
//      original tile available in case it is wanted somewhere again.
//   2. Plant Operator, Lab Technician and Administrator all get it. QC needs
//      it to reach the Mix Design Master from the lab, and the Administrator
//      decision was revisited. Note what did NOT change: enabling or disabling
//      the module and granting somebody access remain Super Admin only, behind
//      the locked `admin.plugins` function. Being able to OPEN a module and
//      being able to hand it out are different powers.
//
// It renders NOTHING unless BOTH hold:
//   - the plugin is switched on, and
//   - this person has been granted a Solitaire account by a Super Admin.
//
// Both come from ONE call, GET /api/solitaire-access/me, which sits behind the
// plugin gate on the server. A disabled plugin answers 404 and the catch below
// hides it. Asking a separate "is the plugin on?" endpoint would mean two
// calls that can disagree, and a window where this shows for a module that is
// already gone.
//
// Hiding it is presentation, not security. The gate is on the server: while
// the plugin is off every route in the module answers 404, including its own
// login, so a bookmarked URL gets nowhere either.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "./api.js";

// The roles that see it at all. A person outside this list who somehow held a
// Solitaire account still would not see the link — which is deliberate: this
// is the main app's opinion about who should be walking into the module.
export const SOLITAIRE_ROLES = ["plant_operator", "lab_technician", "administrator", "super_admin"];

export default function SolitaireButton({ variant = "header" }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    apiRequest("/solitaire-access/me")
      .then((d) => { if (alive) setShow(!!d.has_access); })
      // 404 (plugin off), 503 (enabled but unconfigured), or any network
      // failure all mean the same thing here: show nothing.
      .catch(() => { if (alive) setShow(false); });
    return () => { alive = false; };
  }, []);

  if (!show) return null;

  const icon = (
    <svg width={variant === "tile" ? 26 : 16} height={variant === "tile" ? 26 : 16} viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="13" height="17" rx="2" />
      <path d="M7.5 8h6M7.5 11.5h6M7.5 15h3.5" />
      <path d="M17 7l3 2v9a2 2 0 0 1-2 2h-1" />
    </svg>
  );

  if (variant === "tile") {
    return (
      <Link to="/solitaire/login" title="MixTrack — opens the batching docket screen (separate login). Prints the batching docket only: it does not raise a Delivery Note and records no QC or cube samples."
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                     gap: 6, padding: "14px 10px", marginBottom: 12, borderRadius: 12,
                     background: "#0B6E4A", color: "#fff", textDecoration: "none",
                     boxShadow: "0 1px 3px rgba(0,0,0,0.18)" }}>
        {icon}
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>MixTrack</span>
        <span style={{ fontSize: 10.5, opacity: 0.85 }}>Separate login</span>
      </Link>
    );
  }

  return (
    <Link to="/solitaire/login" className="topbar-link solitaire-link"
          title="MixTrack — opens the batching docket screen (separate login). Prints the batching docket only: it does not raise a Delivery Note and records no QC or cube samples.">
      {icon}
      <span>MixTrack</span>
    </Link>
  );
}
