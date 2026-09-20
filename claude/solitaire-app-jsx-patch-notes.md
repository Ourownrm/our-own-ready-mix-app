# App.jsx changes for Solitaire

Two lines to add near the other public routes (Solitaire manages its own
login/session/device-lock independently — see solitaireAuth.js — so these
are plain public routes, not wrapped in the main app's `<ProtectedRoute>`;
SolitaireApp.jsx checks its own session on mount and redirects to
SolitaireLogin.jsx itself if not signed in).

1. Add imports near the top, alongside the other page imports:

```jsx
import SolitaireLogin from "./pages/Solitaire/SolitaireLogin.jsx";
import SolitaireApp from "./pages/Solitaire/SolitaireApp.jsx";
```

2. Add routes near the other public, no-login routes (next to `/portal`, `/track/:token`, etc.):

```jsx
{/* Public, no login by the MAIN app — Solitaire has its own separate
    login/session/device-lock (see lib/solitaireAuth.js). Reached via the
    "Solitaire" button on a granted user's own dashboard — see
    SolitaireButton.jsx and routes/solitaireAccess.js. */}
<Route path="/solitaire/login" element={<SolitaireLogin />} />
<Route path="/solitaire/app" element={<SolitaireApp />} />
```

That's the full App.jsx diff — everything else about Solitaire (the admin
access panel, the dashboard button) lives in files this project doesn't
have yet (Administrator.jsx and each role's dashboard). See
INTEGRATION_NOTES.md for those.
