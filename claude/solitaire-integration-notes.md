# Solitaire module — what's built, what's still needed

Built this round, self-contained, doesn't touch any existing file:

- `backend/schema-solitaire-additions.sql` — append to the end of your real
  `schema.sql`. Purely additive: new tables only (`solitaire_*`), one FK
  reference to the existing `users(id)` column, no existing table altered.
  Includes seed data matching the approved mockup's sample values.
- `backend/lib/solitaireAuth.js`, `backend/middleware/solitaireAuth.js` —
  Solitaire's own session + device-lock auth, completely separate from the
  main app's `middleware/auth.js`.
- `backend/routes/solitaire.js` — the module itself: login, device
  management, settings, master data (Customer & Site, Truck & Driver, Mix
  Design), the data-entry/print flow, Search & Reprint.
- `backend/routes/solitaireAccess.js` — the ONE integration point: lives on
  the main app's side, protected by the main app's own
  `requireAuth`/`requireRole("administrator")`. Lets an Administrator
  list staff, grant/revoke Solitaire access, and lets any logged-in user
  check their own access (`GET /me`) — that's what drives the dashboard
  button.
- `frontend/src/pages/Solitaire/SolitaireLogin.jsx`,
  `SolitaireApp.jsx`, `solitaire.css` — the mockup translated to real React,
  wired to the routes above. Login/data-entry visuals match the locked
  design exactly (background images now live under `frontend/public/solitaire/`
  as real files instead of the mockup's inline base64).
- `frontend/src/lib/solitaireApi.js` — API client (cookie-based auth, no
  token handling needed).
- `frontend/src/lib/solitaireDocketPdf.js` — **temporary** docket PDF
  generator (jsPDF, matching this app's existing PDF-generator pattern).
  Every PDF it makes is flagged `is_placeholder_pdf = true` in the database
  and says so on the printed page itself. Replace with the real Excel-fill
  pipeline once the updated workbook (sheets "1"–"10") arrives — see the
  big comment at the top of that file and of `routes/solitaire.js`.
- `frontend/src/lib/SolitaireButton.jsx` — draft dashboard button component.

## Still needed from you

1. **The updated Excel workbook** (sheets "1" through "10") — the real print
   pipeline (`03_EXCEL_PRINT_PIPELINE.md`) can't be finished without it.
   Also needed once you have it: the exact font(s) it uses (for the PDF
   export environment) and to re-check the page-2 layout issue seen in your
   proof-of-concept PDF.
2. **A spreadsheet engine for the server** — the real pipeline needs
   something like LibreOffice headless available wherever your backend
   actually runs, to fill cells and export to PDF. Confirm your hosting
   allows installing/running that (this dev session doesn't have it).
3. **New backend dependencies**: `bcryptjs`, `jsonwebtoken`, `cookie-parser`
   (if not already used elsewhere in your app). Mount `cookie-parser` on the
   Express app before these routes, and mount both new route files:
   ```js
   app.use("/api/solitaire", solitaireRouter);          // routes/solitaire.js
   app.use("/api/solitaire-access", solitaireAccessRouter); // routes/solitaireAccess.js
   ```
4. **Two new env vars**: `SOLITAIRE_JWT_SECRET` (must differ from the main
   app's JWT secret) and optionally `SOLITAIRE_COOKIE_SECURE=false` for
   local http development only.
5. **Your current app zip**, to actually wire in:
   - `App.jsx` — see `App.jsx.patch-notes.md` (two routes, two imports —
     small and already drafted, just needs your actual file to edit).
   - `Administrator.jsx` — add a "Solitaire Access" panel calling
     `GET/POST /api/solitaire-access/...`.
   - Whichever file is your shared authenticated layout (if one exists) —
     drop `<SolitaireButton />` in once, so it shows on every dashboard for
     whoever's been granted access. If there's no shared layout, it needs
     adding to each role's dashboard page individually instead.

## Decisions made this round (for the round-log / oorm-app-state.md)

- Self-contained module, own tables/login/device-lock — no shared data with
  the main app's customers/sites/trucks/mix_designs or its login system.
- QC's master-data scope widened from the mockup's original best guess:
  QC can now edit Customer & Truck masters too, in addition to its existing
  exclusive Mix Design access.
- Named "Solitaire" in the UI (matches its own login screen's card-game
  background) rather than "RMC Delivery Challan," to avoid confusion with
  the existing Gate Pass & Delivery Note PDF already in this app.
- Access is admin-provisioned: the main app's Administrator sets a granted
  user's Solitaire username/password/role directly (not a self-serve
  first-login flow).
- The mockup's own hardcoded demo credentials
  (operator/operator123, qc/qc123, admin/admin123) were deliberately NOT
  carried into the real login screen — real accounts are created via the
  admin access panel instead.
