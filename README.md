# Our Own Ready Mix — App

Real, running codebase (not a mockup). This is phase 1 of the actual build.

## What's working right now
- **Database schema** (`backend/schema.sql`) — every table for all 7 roles, including
  Pump, Fuel, Reports data, and audit trail (the gaps we flagged, already designed in,
  even though their screens aren't built yet).
- **Backend API** (`backend/`) — sign-in, Order creation, Delivery Ticket creation with
  full Trip Status Timeline logging, Driver duty toggle + GPS ping ingestion, trip
  allowance auto-payout on completed delivery only, breakdown/fuel reporting, Plant QC,
  Site QC with reject-concrete flow, invoicing based on rate master, and payments
  supporting multiple receipts per invoice.
- **Frontend** (`frontend/`) — installable Progressive Web App (PWA), works offline for
  the Driver and Site Supervisor screens (queues actions locally, syncs automatically
  once back online), sign-in page, role-based routing for all 7 roles.
- **All 7 roles fully wired end-to-end**: Driver, Manager, Site Supervisor, Plant
  Operator/QC, Accountant, and Administrator (user management + master data: customers,
  sites, trucks, rates). Each was tested against a real database with full pipeline
  tests before being handed over, including role-security checks (e.g. confirming a
  Driver account cannot reach Administrator or Accountant routes).

## What's not built yet
Pump module, Fuel module, and the 12 Reports — schema is ready (see `schema.sql`),
screens are not. These were flagged in the original requirements gap analysis and
intentionally deferred.

A few smaller items also noted during the build, worth knowing about:
- Manager "approve rejected concrete" step isn't wired (rejections currently just notify
  the Manager, without a formal approval action)
- Site temperature isn't captured at the Site Supervisor step (only slump is)
- No audit-trail UI yet, though the underlying `audit_log` table exists in the schema
- Disabling a user takes effect on their next login; a currently-logged-in session
  isn't force-ended immediately (their token remains valid until it expires, up to 30 days)

## How to run this yourself

You'll need:
1. A PostgreSQL database. Any cloud provider works — Render, Railway, Supabase, or a
   Google Cloud / AWS managed database all offer free or low-cost starter tiers.
2. Node.js installed on whatever machine you're developing from (v18 or newer).

### Backend
```
cd backend
npm install
cp .env.example .env        # then fill in your real DATABASE_URL and a random JWT_SECRET
psql "$DATABASE_URL" -f schema.sql     # creates all the tables
node src/seed.js            # creates your first Administrator login
npm start
```
The seed script prints a phone number and password you can use to sign in immediately —
change that password as soon as you're in.

### Frontend
```
cd frontend
npm install
cp .env.example .env        # point VITE_API_URL at your backend's address
npm run dev                 # for local testing
npm run build                # for deploying the real, installable app
```

### Deploying for real use
The `frontend/dist` folder (after `npm run build`) can be hosted on any static hosting
service (Netlify, Vercel, Cloudflare Pages — many have free tiers). The `backend` folder
needs a Node.js hosting service (Render, Railway, Fly.io are common, simple choices).
None of this requires an Apple/Google developer account — it's a website your team opens
in their phone browser and adds to their home screen.

## Fixes from first round of real-world testing

After the team tried this with real orders, several issues came back and were fixed:

1. **Administrator can now correct or cancel orders and delivery tickets** — under
   "Correct orders" / "Correct tickets" in the Administrator screen. Nothing is ever
   hard-deleted (matches the SRS's "no permanent deletion" rule) — cancelling just
   excludes a record from active workflows while keeping it on file.
2. **All 10 mix grades added** (M7.5 through M50), and the seeding logic was fixed so
   adding grades in the future won't silently skip if some already exist.
3. **Pumping charge is now a flat lump sum per delivery**, not per m³ — this was a
   genuine schema change (`rate_master.pumping_charge_lumpsum`), applied automatically
   via migration when you next run `/setup`.
4. **Driver's "Report breakdown" and "Report fuel filling" now actually work** — they
   previously failed silently with no error shown. Both now open a proper form and
   show a clear confirmation or error message.
5. **Manager dashboard now shows delivered quantity** against each order's ordered
   quantity, not just the ordered amount.
6. **Orders now let you pick a specific pump** (e.g. "Line-2"), not just a pump type —
   Administrator can manage the list of pumps under "Pumps".
7. **Plant Operator and QC Engineer are fully separate screens now**, each with their
   own login and only their own actions available (`/plant-operator` vs `/qc`).
8. **Manager dashboard shows live GPS links** per active truck (opens the location in
   Google Maps) alongside the restored "Active trucks" table from the original mockup.
9. **Site Supervisor improvements**:
   - Added an "after-pour care" checklist item (e.g. covering with plastic sheet) and
     a comments field for notes about each supply
   - Fixed a real bug where the screen didn't refresh after tapping a button — it now
     also auto-refreshes every 15 seconds in case another role changes the ticket status

Also fixed along the way: a rate-lookup bug where having two rates on file for the same
day picked the wrong one, and the server no longer crashes entirely if one request hits
a database error (it now fails just that one request and stays up for everyone else).

## Second round — pending-work items addressed

1. **Orders now carry forward automatically.** Any order not completed by end of day
   stays visible (on the Manager dashboard and the shared Today/Tomorrow screen) every
   following day until it's completed or formally closed — it no longer just falls off
   the list once its `order_date` is in the past. Manager (not just Administrator) can
   now **close an order** that will never be completed, with an optional reason on file
   (`POST /api/orders/:id/close`); this soft-cancels it (SRS: nothing is hard-deleted).
2. **Site Supervisor's delivery list** now shows truck number and driver name alongside
   ticket number and site, both in the picker and on the delivery card.
3. **Manager's "Active trucks" table** now has a "Loaded at" column (the delivery
   ticket's creation time).
4. **GPS on sites, with a tap-to-navigate link for drivers.** Sites can now have a
   latitude/longitude (Administrator/Manager → Projects and sites → "Use my current
   location" or type coordinates). The Driver's assigned-trip card shows a "Navigate to
   site in Google Maps" button once a site has coordinates on file.
5. **Back button from "Today & tomorrow's orders."** The top bar now always shows a
   "← Back to my dashboard" link (to whichever screen matches your role) whenever you're
   away from it, not just a forward link to the orders view.
6. **Auto-login fixed.** Your sign-in was already being saved (a 30-day token in the
   browser's local storage) — but opening the app always forced you back to the sign-in
   screen regardless, because the home route didn't check for a saved session. That's
   fixed: opening the app now goes straight to your dashboard if you're already signed
   in. The sign-in form also now has proper autocomplete hints, so your phone/browser
   will offer to save the password for next time (look for that prompt right after you
   sign in) — no separate "remember me" setting needed.
7. **Reports module + Director's Dashboard built.** New `/reports` screen (Manager,
   Accountant, Administrator) covering: today's & cumulative monthly orders; today's &
   cumulative sales value (total and per-customer); today's & cumulative collections;
   total outstanding; a 0–7/8–14/15–30/30+ day outstanding-aging table by customer;
   running orders with supplied/balance quantity; upcoming orders; salesman-wise monthly
   sales; monthly pump utilization; and concrete rejection quantity/reasons. Backed by a
   single `GET /api/reports/director-dashboard` endpoint.
8. **Breakdown tracking extended to pumps and the batching plant**, not just trucks.
   Plant Operator/QC Engineer/Manager can report a pump or plant breakdown from a new
   "Report pump/plant breakdown" action; all of it (trucks, pumps, plant) lands on a new
   Manager-facing **Equipment breakdowns** screen (`/breakdowns`) until marked repaired.
9. **App icon.** The PWA manifest referenced `icon-192.png`/`icon-512.png`, but those
   files didn't actually exist in `frontend/public/` — that's why the installed icon
   looked wrong/default. Placeholder OORM-branded icons are now in place. **To use your
   real logo instead:** replace `frontend/public/icon-192.png` and `icon-512.png` with
   your own square PNGs at those exact sizes (keep the filenames), and optionally
   `frontend/public/favicon.svg` for the browser tab icon — then rebuild
   (`npm run build`) and redeploy. No other changes needed; `vite.config.js` already
   points at these filenames.

### Migration note
All schema changes above (order closing columns, expanded breakdown-reporting table)
are applied automatically the next time you visit `/setup?key=...` on your deployed
backend — same one-time-setup mechanism as before, safe to run repeatedly.

## Third round

1. **Reports & Director's Dashboard is now Administrator-only.** Removed from Manager
   and Accountant screens; the backend route rejects any other role too, not just the
   button being hidden.
2. **Salesman-wise sales report now shows quantity (m³), not just rupee value.**
3. **Sales representative is now a dropdown**, not free text — a typo can no longer
   silently split one salesman's numbers into two names in reports. Manage the list
   under Administrator → Salespersons (Manager can also add a new name inline from the
   order form via "+ Add new salesperson..."). Existing free-text names already on file
   were automatically carried over into the new list by the migration, so nothing is
   lost — but every *new* order uses the dropdown from here on.
4. **Trip allowance no longer shows the distance range** — "₹100 per trip (0-10 km)" is
   now just "₹100 per trip" everywhere it's displayed. The migration also cleans up any
   already-seeded labels with the old format.
5. **Manager Dashboard: Completed trips list**, with the full per-trip timeline —
   batch time (ticket created) | left plant (QC dispatch) | reached site | unloading
   start | unloading finish. One honest caveat: this app's workflow doesn't currently
   have a distinct "batching started/completed" step separate from the Plant Operator
   creating the ticket, so "batch time" is the ticket's creation timestamp — a true
   separate batching step would need a small workflow addition on the Plant Operator
   side if you want that later.
6. **The "truck at site over 2 hours" alert is now visible, not just a background
   count.** The Active trucks table highlights the row and shows "At site Xh Ym —
   notify site" once a truck has been sitting at a site for more than 2 hours since
   arrival, plus a badge count at the top of the table.

### Database — starting fresh
A new protected endpoint clears every transactional/operational record (orders,
delivery tickets, their full event/GPS/QC history, breakdown & fuel logs, invoices,
payments, notifications) while leaving **users, trucks, pumps, customers, sites, mix
grades, salespersons, rate master, trip allowance categories, and rejection reasons**
untouched — that's your configuration, not test data.

Visit (after deploying this update and re-running `/setup?key=...` once to apply the
new migrations):

```
https://your-backend.onrender.com/setup/reset-transactional-data?key=YOUR_SETUP_SECRET&confirm=RESET
```

Visiting without `&confirm=RESET` shows a warning and does nothing — this is a genuine
"delete everything transactional" action with no undo, so it's deliberately hard to
trigger by accident. **Do this once, right before you start using the app for real**,
not on an ongoing basis.

### Database — fixing a mistaken equipment entry (e.g. a pump typo)
Administrator → **Trucks and pumps** now has full management: add, deactivate/
reactivate, or permanently delete a truck or pump. For your pump typo: open that tab
and click **Delete** next to the mistaken entry. If it's never actually been used on
any order or ticket, it deletes cleanly; if it has, the delete is blocked with a message
telling you to **Deactivate** instead (so it disappears from dropdowns going forward
without breaking any historical record that already points to it) — then add the
correctly-spelled pump as new.

## Fourth round

1. **Small sites with no Site Supervisor.** An order's Site Supervisor field was
   already optional — but leaving it blank actually crashed order creation (an empty
   value was sent straight into an integer database column). Fixed that, and built the
   actual tracking/recording solution: when an order has no Site Supervisor assigned,
   the **Driver's own screen** now shows "Confirm truck arrival," "Confirm unloading
   start," and the same completion form (slump, delivery note status, after-pour care,
   rejection) that a Site Supervisor would normally use. It's the same underlying logic
   either way — invoice generation and trip allowance payout included — just reachable
   by the Driver directly when no supervisor exists for that site. If a supervisor *is*
   assigned, the Driver doesn't see these buttons at all; the supervisor is still the
   one who confirms it.
2. **"View details" on every order, everywhere.** All seven roles can now click "View
   details" on any order (from the shared Today/Tomorrow screen, or the Manager
   Dashboard) to see the full order — batching time, pump crew departure time, assigned
   Site Supervisor, technician required, which pump, etc. — in a read-only popup.
   Editing stays exactly where it was: Administrator → Correct orders only.
3. **Customer-wise sales report now shows quantity (m³)**, not just rupee value —
   matching the salesman-wise report from last round.
4. **Driver duty tracking on Android background/lock.** Root cause: duty ON/OFF state
   only ever lived in the browser tab's memory. Android can suspend a backgrounded PWA
   tab, and when that happens the app loses that memory — so reopening it looked like
   duty had silently gone off, even though the driver never pressed Duty OFF. Fixed:
   - Duty status is now saved server-side and re-read every time the app opens, so it
     always reflects what actually happened, not a guess.
   - Duty is tracked per-driver, not per-ticket, so a driver can be on duty and visible
     to the Manager **before any truck is assigned or ticket created** — new **On-duty
     drivers** panel on the Manager Dashboard shows every currently-on-duty driver,
     their last known location, and how long ago that GPS ping was, regardless of
     whether they currently have an active delivery. They stay listed until they
     actually press Duty OFF.
   - Reopening the app after an interruption immediately sends a fresh GPS ping and
     resumes tracking, instead of waiting or requiring the toggle to be pressed again.
   - Added a screen wake-lock while on duty, to reduce how often Android puts the tab
     to sleep in the first place.

   **Honest limitation:** none of this can fully solve *true* background tracking —
   Android and iOS both throttle or suspend JavaScript in any browser tab once it's
   minimized or the screen is off, and no website (PWA included) can override that. The
   fixes above close the gap as fast as possible and stop the app from ever lying about
   duty status, but if you need GPS pings to keep flowing every 30 seconds while the
   phone is in the driver's pocket with the screen off for an hour, that specifically
   requires a real native Android app (a "foreground service"), not a web app — e.g.
   wrapping this app with something like Capacitor and adding that native piece. Happy
   to scope that separately if it's something you want.
5. **Active trucks status colors** are now visually distinct per stage (at plant, in
   transit, at site/waiting, unloading, completed, cancelled/rejected) instead of most
   statuses sharing the same amber "warning" color — easier to read the fleet at a
   glance.
