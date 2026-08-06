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

## Fifth round

1. **Administrator now lands on Reports & Director's Dashboard** after signing in,
   instead of the master-data screen. A "Manage users, customers, sites, fleet, rates..."
   button at the top takes them to the old Administrator screen when needed.
2. **Raw material stock — QC Engineer entry, dashboard display.** New section on the
   QC Engineer screen listing all 9 bins (3 silos, 3 admixtures, M Sand, and two
   aggregate sizes) with editable type/brand and quantity; shows who last updated it and
   when. Manager and Administrator dashboards both show a compact read-only grid (bin +
   brand + quantity, 3 per row) reflecting whatever QC last saved — it doesn't reset or
   disappear, it just sits there until QC updates it again.
3. **Daily production bar chart on the Administrator dashboard** (Reports page),
   defaulting to the last 7 days so it's readable on a phone screen without cramming;
   a "View 30 days" toggle switches to a horizontally-scrollable 30-day view, matching
   how your existing tables already handle overflow on mobile. Built as a plain SVG
   chart with no new library dependency, so there's nothing extra to `npm install`.

### Migration note
This round adds the `raw_material_stock` table, seeded with the 9 fixed bins — applied
the same way as always, by revisiting `/setup?key=...` once after deploying.

## Sixth round

1. **Director's Dashboard KPIs replaced with quantities.** "Orders today" and "Orders
   this month" (counts) are now:
   - **Order qty today** — total m³ ordered for today, regardless of how much has
     shipped
   - **Supplied qty today** — total m³ across today's delivery tickets, whether or not
     the trip has completed yet (new)
   - **Monthly production qty** — total ticket quantity this month minus whatever was
     rejected at site this month, i.e. what the plant actually produced and got
     accepted
2. **Mobile-friendly tables everywhere, not just Completed trips.** The same
   horizontal-scroll pattern used for Completed trips is now applied to every wide
   table in the app that didn't have it yet: Running today / Scheduled tomorrow (Manager
   Dashboard and the shared Today/Tomorrow screen used by all 7 roles), Active trucks,
   On-duty drivers, and every table on the Director's Dashboard (sales by customer,
   outstanding aging, running orders, upcoming orders, salesman-wise sales, pump
   utilization, rejections). None of them will force the whole page to scroll sideways
   on a phone anymore — just the table itself, same as Completed trips already did.

## Seventh round — bug fixes

1. **"Closed" order showing as "cancelled".** Root cause: Manager's "Close order" and
   Administrator's separate "Cancel order" action both wrote the exact same
   `status = 'cancelled'` value, so there was no way to distinguish them anywhere in the
   app. Fixed: `closed` is now its own status, with its own badge color. A migration
   backfills any order that was already closed (has a `closed_at` on file) to the
   correct status.
2. **Director's Dashboard bugs:**
   - **(a)** "Order qty today" now excludes cancelled/closed orders from the total —
     it previously counted every order placed today regardless of whether it was
     immediately cancelled.
   - **(b)** "Today's sales not showing anything" — **yes, a rate must exist** for that
     exact customer + concrete grade combination (Administrator → Concrete grades and
     rates) before a completed delivery generates an invoice. This isn't a bug, it's how
     invoicing is intentionally wired: the invoice amount comes from `rate_per_m3` on
     file for that customer/grade, so without a rate there's nothing to calculate from.
     What *was* a real gap: this failure was completely silent — a completed delivery
     with no matching rate just quietly generated no invoice, with no record anywhere
     that it happened. Fixed: it now writes a notification (`no_rate_on_file`) recording
     exactly which ticket was affected. **Caveat:** the app doesn't have a notification
     inbox/bell UI anywhere yet — right now this is queryable in the database
     (`SELECT * FROM notifications WHERE type = 'no_rate_on_file'`) but not
     surfaced on screen. Happy to build a simple "unbilled deliveries" list if that'd be
     useful — let me know.
   - **(c)** Running/Upcoming orders now explicitly exclude cancelled and closed orders
     in the query itself (previously relied only on an allow-list of active statuses,
     which should have already excluded them — this makes it explicit and airtight). If
     you still see a cancelled/closed order in either list after this update, that's a
     different bug than what the code review found — send me a screenshot with the order
     name and I'll dig further with that specific case.
   - **(d)** Upcoming orders' date column was rendering the raw database timestamp
     (`2026-07-25T00:00:00.000Z`) instead of a formatted date — fixed to show it properly
     (e.g. "25 Jul 2026").
3. **Director's Dashboard reordered** to: Daily production chart, KPIs, Running orders,
   Upcoming orders, Outstanding aging, Raw material stock, Sales by customer, Sales by
   salesman, Pump utilization, Concrete rejection.
4. **Raw material stock now highlights low stock** — a bin turns red (border + text)
   when at or below: cement (any Silo) 15 ton, aggregates (Agg. 12mm/20mm) 2 Load,
   admixtures (Admix. 1/2/3) 2 Barrel. A count badge ("N low") shows on the card header
   when anything's below threshold.

### Migration note
This round adds the `closed` order status and backfills existing closed orders —
applied by revisiting `/setup?key=...` once after deploying, as always.

## Eighth round — Production Report module

New standalone report at `/production-report`, linked from the Director's Dashboard.
Administrator-only, same as the rest of Reports.

- **Filters**: date range (defaults to today, can be a single day), customer, site
  (narrows to that customer's sites once one is picked), truck, driver, salesperson,
  pump, site supervisor, and delivery note status — all combined with AND. Delivery
  note status is **multi-select toggle chips** (All / Signed / Pending / Refused), so
  you can pick any combination, not just one at a time.
- **Results**: table with Date, DC No., Customer, Site, Truck, Driver, Sales Person,
  Pump, Supervisor, Grade, Quantity, Rate, Amount, and Delivery Note Status, paginated
  at 100 rows/page, with a totals row (quantity, amount, delivery count) computed over
  the *entire* filtered set, not just the visible page.
  - **Rate and Amount show as "–" (blank), not ₹0**, whenever no rate was on file at
    delivery time — this is the same "no rate → no invoice" situation covered in the
    bug-fix round above, made visible here too rather than looking like free concrete.
- **Export**: PDF (`jspdf` + `jspdf-autotable`) and Excel (`xlsx`/SheetJS), both pulling
  the complete filtered dataset (not just the current page), capped at 5,000 rows. PDF
  includes a header (company name, applied filters, generated timestamp) and the same
  totals row. Filenames: `Production_Report_<fromDate>to<toDate>.pdf` / `.xlsx`.
  Export buttons are disabled until a report has been generated and has at least one row.

**Action needed:** this adds two new npm packages (`jspdf`, `jspdf-autotable`, `xlsx`)
to `frontend/package.json` — run `npm install` in `frontend/` once before your next
build, or the build will fail on the missing packages.

## Ninth round — bug fixes

1. **PDF export: ₹ symbol showing as "1", Amount column clipped.** jsPDF's built-in
   font doesn't have a glyph for ₹ — it silently renders as a stray "1" instead of
   erroring. Fixed by using "Rs." in the PDF export specifically (the on-screen table
   and the Excel export both still show the real ₹ symbol — only jsPDF's font has this
   limitation). Also widened the Rate/Amount columns so the numbers don't get clipped.
2. **Today's orders appearing in "Upcoming orders" too — root cause was bigger than
   this one screen.** The database server's default timezone is UTC, but the business
   runs on IST. Every query using `CURRENT_DATE` was affected: for the roughly 5.5 hours
   between midnight and 5:30 AM IST, the database still thought it was "yesterday"
   (UTC hadn't rolled over the date yet) — so today's orders got miscategorized as
   "upcoming," today's production/sales KPIs could be measuring the wrong day, and the
   carry-forward logic could be a day off. **Fixed at the source**: every database
   connection now explicitly sets its session to `Asia/Kolkata`, so "today" means the
   same thing to the database as it does to everyone using the app. Also made "Running
   orders" and "Upcoming orders" mutually exclusive by date (today-or-earlier vs.
   strictly future) so they can't double up even independent of the timezone issue.
3. **Closed orders stuck showing under "Needs attention — carried forward."** Real
   regression from when I split "closed" out as its own status a few rounds back — I
   updated the backend but missed two frontend filters (Manager Dashboard and the
   shared Today/Tomorrow screen) that still only excluded `completed`/`cancelled`, not
   `closed`. Fixed in both places, for the carried-forward list and the plain
   today/tomorrow lists. Also added a defensive check so the "Close order" button never
   appears at all on an order that's already closed, cancelled, or completed, even if
   one somehow ends up in a list it shouldn't be in.

## Tenth round

1. **Administrator can now view the Manager Dashboard directly** — "View Manager
   Dashboard" button on the Director's Dashboard, no sign-out/sign-in switching
   needed. (The backend already allowed this everywhere it mattered; only the frontend
   route was locked to Manager-only.)
2. **Delivered/supplied quantity formula corrected app-wide** to match exactly what you
   described: **delivered qty = delivery note quantity − rejected quantity**, counted
   from the moment the delivery ticket is created (not waiting for the trip to finish).
   Previously several places only counted tickets already marked "completed" and never
   subtracted rejections — fixed consistently in the order list, order detail view, and
   the Director's Dashboard's running-orders report.
3. **Orders now auto-complete when their ordered quantity is reached**, using that same
   formula, checked at every point that can change it: when a new delivery ticket is
   created, when unloading is confirmed complete, and when a load is rejected (which
   can drop a previously-"completed" order back to "in progress" if a rejection pulls
   its delivered total back below target — this shouldn't come up often, but it's
   handled correctly rather than leaving a wrong status on the books).
4. **QC and slump details are now viewable**, not just saved. Both plant-side data (QC
   Engineer: slump, temperature, cube samples, sample IDs) and site-side data (Site
   Supervisor/Driver: arrival slump, rejection details, delivery note status, after-pour
   care confirmation) were already being captured correctly — there was just never a
   screen to see them. Added a **"QC details" button on every row of the Production
   Report** that opens a popup with the full plant + site record for that delivery. I
   went with a per-row detail view rather than cramming 8+ more columns into an already
   14-column table, or turning it into filter fields — none of this data is naturally
   something you'd filter *by* (a slump reading, a remark), it's something you look *up*
   for a specific delivery, so a "view details" pattern (same one already used for
   orders) fit better than either of your suggested approaches. Happy to add slump-range
   or "has rejection" as an actual filter separately if that would be useful.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Eleventh round — bug fix

**Manager Dashboard's "Today's production" / "Monthly production" was wrong while
Administrator's matched.** Root cause: when I fixed the delivered/supplied quantity
formula last round (delivery note qty − rejected qty, counted from ticket creation),
I updated the order list, order detail, the Director's Dashboard KPIs, and the
production chart's data source — but missed one more place, a separate endpoint
(`/orders/dashboard`) that specifically powers the Manager Dashboard's KPI tiles. It
was still using the old logic (only tickets already marked "completed," no rejection
subtracted). Fixed to match exactly, plus double-checked the daily production chart
itself had the same gap (it did — fixed too) and ran an exhaustive search across the
whole backend to confirm no other spot was still on the old formula.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Twelfth round

1. **Raw material stock entry moved to its own screen**, reachable from a button on
   the main QC Engineer dashboard ("Raw material stock entry →") instead of sitting
   inline on the page. **PIN-protected**: set a `RAW_MATERIAL_STOCK_PIN` environment
   variable on your backend service in Render (same pattern as `SETUP_SECRET` from
   earlier) — once set, saving a stock update prompts for that PIN and the server
   rejects the save if it's wrong, so on a shared device/login, only whoever knows the
   PIN can actually change stock levels; everyone with QC access can still see current
   stock. If you don't set the env var, saving still works exactly as before (nothing
   is protected until you add it — this is deliberate, so setting it up is optional and
   doesn't break anything if skipped).
2. **QC Engineer now sees the same "over 2 hours at site" trucks Manager sees**, with a
   quality nudge and a "Flag for Manager" button. Flagging a truck shows a badge
   directly on the Manager Dashboard's Active Trucks table — "QC flagged this
   delivery" — right on the row Manager's already looking at, with a "Mark reviewed"
   button to clear it once they've followed up. **Honest scope note**: this isn't a
   push notification (that's still on hold, per your earlier call) — it's a badge that
   appears the next time Manager's dashboard refreshes (every 20 seconds while the page
   is open). If Manager isn't currently looking at their dashboard, they won't be
   alerted until they open it.

### Action needed
Optional: set `RAW_MATERIAL_STOCK_PIN` in Render's environment variables for the
`oorm-backend` service if you want the PIN protection active (Environment tab, same
place `SETUP_SECRET` lives). Any value works — a 4-digit PIN, a word, anything QC can
remember and share only with whoever should be allowed to edit stock.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Thirteenth round — Push notifications

Real phone push notifications, not just the in-app `notifications` table nothing was
ever reading from before. Wired into exactly the 7 events we agreed on, each going to
the specific person(s) who should act on it — nothing broadcasts to everyone, and
nothing fires for routine workflow steps (ticket creation, status changes, etc.) that
would just become noise:

| Event | Goes to |
|---|---|
| Breakdown reported (truck, pump, or plant) | Manager |
| Concrete rejected at site | Manager |
| Driver goes off duty mid-trip | Manager |
| QC flags a delayed truck | Manager |
| Delivery completed with no rate on file | Accountant |
| Truck crosses 2 hours at site | QC Engineer |
| Delivery note created for their site | The specific assigned Site Supervisor |

Two of these (breakdowns) turned out to have never written to the `notifications`
table at all before now — fixed as part of wiring this in.

### How it works
- Real Web Push (VAPID), not a third-party service — no Firebase account, no per-message
  cost, works the same way on Android/desktop Chrome and (with caveats — see our
  conversation about iOS reliability) iOS 16.4+.
- The "truck over 2 hours" check is the one exception that isn't triggered by a user
  action — nobody "does" something at the 2-hour mark, so it runs on a timer instead
  (checked every 5 minutes) rather than at a specific code path.
- A "🔔 Enable notifications" button now appears in the top bar for anyone who hasn't
  turned them on yet, on any screen, any role.
- The service worker switched from auto-generated to a custom one (`frontend/src/sw.js`)
  since handling push events requires custom code — the existing offline-caching
  behavior for orders is preserved exactly as it was, just written explicitly now.

### Action needed — two steps, in order
1. **Deploy this update**, then run `/setup?key=YOUR_SETUP_SECRET` once (adds the
   `push_subscriptions` table).
2. **Generate your VAPID keys** by visiting (once):
   ```
   https://oorm-backend.onrender.com/setup/generate-vapid-keys?key=YOUR_SETUP_SECRET
   ```
   Copy the two values it shows you into your `oorm-backend` service's environment
   variables on Render as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, then redeploy the
   backend. **Notifications will not work until both are set** — before that, the
   "Enable notifications" button will show an error if tapped, since there's no key for
   the frontend to subscribe against yet.

This round also adds new npm packages on both sides — `web-push` (backend) and
`workbox-precaching` / `workbox-routing` / `workbox-strategies` (frontend). Both build
commands already run `npm install` automatically (per your `render.yaml`), so no manual
step needed there — just be aware the next deploy will take a little longer than usual
while it downloads them.

## Fourteenth round — Fuel Module rebuild

Driver's duty/trip screen is untouched — fuel filling moved to its own page (`/fuel`),
reachable by Driver, Manager, Accountant, and Administrator.

- **Any equipment, not just the driver's assigned truck** — pick a truck, pump, pickup
  van, loader, or generator from the equipment-type chips, independent of any active
  delivery. "Pickup van" and "Loader" didn't exist as trackable equipment before —
  Administrator manages both (and generators) under a new **Fuel stations and
  equipment** tab.
- **Odometer or hour meter, at least one required** — trucks and vans run on odometer,
  pumps/loaders/generators run on hour meter; the form accepts either.
- **Fuel stations are now manageable** by Administrator (add, deactivate, delete) —
  previously there was no way to add one at all beyond a database insert.
- **Fuel history/report falls out of this automatically**: a "fuel by equipment" summary
  (total litres and cost per truck/pump/van/loader/generator) and a recent-entries list,
  both on the same page.
- **Not built yet, by design**: flagging high consumption or suspiciously early refills
  — you asked for this explicitly "for later." The data being recorded now (accurate
  odometer/hour-meter per fill, per specific equipment) is exactly what that would need,
  so this is a clean foundation for it whenever you're ready, not something that'll need
  rework.

### What changed under the hood
`fuel_logs` no longer requires a truck — it references whichever equipment was actually
fueled (truck, pump, or the new `equipment` table for vans/loaders/generators). The old
truck-only endpoint (`/driver/fuel`) is gone, replaced by the shared `/fuel` endpoint.

### Migration note
Revisit `/setup?key=...` once after deploying — adds the `equipment` table, extends
`fuel_logs`, and makes `fuel_stations` manageable.

## Fifteenth round — bug fixes

**Real root cause found for both reports:** an empty number input (left blank) sends an
empty string `""` to the backend, and three places passed that straight into a `NUMERIC`
database column instead of converting it to `null` first — which PostgreSQL rejects
outright. This wasn't specific to selecting "Other" as a rejection reason (verified —
there's no code anywhere that treats "Other" differently from any other option); it was
about leaving slump/quantity/temperature blank, which happened to line up with when
"Other" felt like the obviously-irrelevant-fields case. Fixed in the three places it
existed — Site Supervisor and Driver's self-service rejection (shared code, one fix
covers both), the unloading-completion form, and QC Engineer's plant QC entry. Also
added an explicit "Slump reading is required" check on the QC side (the one field that
genuinely should be mandatory), so its absence gets a clear message instead of a crash.
This also directly answers the temperature question: it was never actually marked
required in the form — it only *felt* mandatory because leaving it blank crashed the
save. It's genuinely optional now.

## Sixteenth round — Sales module (new role)

New `sales_executive` login role, plus everything discussed:

- **Own dashboard** (`/sales`): customers, orders this month (qty + value), outstanding,
  leads by stage.
- **Leads**: Manager or Administrator creates and assigns a lead to a specific Sales
  Executive (Administrator → Assign a lead, or the same on Manager Dashboard). No
  incentive language anywhere — leads carry a follow-up log and a required reason when
  marked lost. Only **Administrator** can mark a lead "won," and doing so requires
  choosing whether it counts as **that salesperson's own sale or the company's** —
  exactly the attribution decision you described.
- **Bookings**: Sales Executive submits one (customer, site if known, grade, estimated
  quantity, preferred date, notes) — it lands in a **Pending bookings** queue right on
  the Manager Dashboard, with Convert/Decline actions. Converting opens a form for the
  remaining order details (batching time, dispatch interval, pump, site contact, etc.)
  and creates a real order — nothing becomes an order without this explicit step.
- **After-sales feedback**: Sales Executive records a compliment or complaint tied to a
  customer (and optionally a specific order) after visiting a site post-delivery. A
  complaint pushes a notification to Manager.
- **Admin's combined performance dashboard** (`/sales-performance`, linked from the
  Director's Dashboard): every active salesperson side by side — this month's quantity
  and sales value, outstanding, and lead win/loss counts.
- Existing salesperson dropdown (used on orders) now links to the real login account
  when one exists — creating a Sales Executive user automatically connects them, so
  historical reports and this new module read from the same underlying identity.

### What I did not build this round
Sales targets/quota tracking wasn't part of the final confirmed scope this time — the
performance dashboard shows actuals only, no target-vs-actual. Straightforward to add
later if useful (a `sales_targets` table plus a comparison column).

### Migration note
Revisit `/setup?key=...` once after deploying — adds the `sales_executive` role and the
`leads`, `lead_followups`, `bookings`, `aftersales_feedback` tables.

## Seventeenth round — sales module expansion

1. **Sales Executives can add their own leads** ("+ New lead" on the Leads tab), not
   just receive assigned ones. Lead updates are now a full activity log, not just a
   note: **general note, quotation issued, quotation follow-up, quotation revised
   (with a required reason), meeting (with persons met), or site visit** — each shown
   to Admin in full via a new **"Browse all leads"** page (Administrator and Manager
   both, linked from Manager Dashboard and the Sales Performance page), where Admin is
   also where "mark won" and the salesperson/company attribution decision live. The
   Sales Performance dashboard now also shows quotations/meetings/site-visits counted
   this month, per salesperson.
2. **Sales Executive now sees customer-wise outstanding**, not just one combined total
   — a table on their dashboard, one row per customer.
3. **Location capture on every lead update and every customer visit.** Every time a
   Sales Executive logs an update, they're asked "Are you at site?" — Yes captures GPS
   (via the browser's location permission) and shows it to Admin as a map link; No
   records "not updated from site," exactly as specified. Same prompt on the new
   **customer visit** feature (separate from leads — this is for existing customers):
   date, time, customer, contact person, discussion outcome, and location, all shown
   as a report on Admin's Sales Performance page.

### Migration note
Revisit `/setup?key=...` once after deploying — adds `customer_visits`, and extends
`leads`/`lead_followups` with the new quotation and activity-type columns.

## Eighteenth round — sales module refinements

1. **"Are you at site?" now also applies to adding a new lead**, not just lead
   updates — same Yes (captures GPS, shown to Admin as a map link) / No ("not updated
   from site") pattern from the follow-up activity log, now on lead creation itself.
2. **Visits are no longer limited to existing customers.** The mandatory customer
   dropdown is gone — a Sales Executive now types who they visited freely and picks a
   category (**Customer, Client, Consultant, Site Engineer, Other**), covering site
   engineers, consultants, and anyone else who isn't in the customer list. An existing
   customer can still be optionally linked for reporting purposes, but it's no longer
   required. Admin's "Customer visits report" reflects this — shows who was visited and
   their type, with the linked customer name in parentheses when there is one.

### Migration note
Revisit `/setup?key=...` once after deploying — adds location fields to `leads` and
makes `customer_visits.customer_id` optional while adding `visited_name`/`visitor_type`
(existing visits get backfilled with their customer's name automatically, so nothing
already logged loses its "who").

## Nineteenth round

1. **Rejected trucks now correctly disappear from Active Trucks** and appear in
   Completed Trips with a visible "rejected" status — fixed the same missing-status
   pattern found before, this time in Active Trucks, Live Locations, On-Duty Drivers,
   and Completed Trips (which only showed `completed` before, never `rejected`).
2. **Lead location sharing** — Manager/Admin can attach a site's GPS coordinates when
   assigning a lead ("Use my current location" or manual entry), with a
   "Navigate to site" button for the assigned Sales Executive and a "View site
   location" link for Admin/Manager oversight.
3. **Pump dispatch & site-readiness workflow** — genuinely new coordination, not just a
   display change:
   - Site Supervisor confirms when the pump has actually left the plant (a new "Today's
     orders" section on their screen); the actual time is recorded and shown on a new
     **Pump status** table on the Manager Dashboard, alongside the scheduled time — rows
     go red if overdue.
   - **Batching is now blocked** until the assigned Site Supervisor confirms the site is
     ready to receive concrete — Plant Operator's order dropdown shows which orders are
     currently blocked, and trying to create a ticket against a not-ready order is
     rejected with a clear message. Orders with no Site Supervisor assigned (small
     sites) aren't gated, since there's no one able to confirm.
   - Two new automatic checks (same 5-minute timer as the existing "truck over 2 hours"
     alert): **pump departure overdue** and **batching not started by scheduled time**,
     both notifying Manager, Administrator, and the specific assigned Site Supervisor.
4. **"Assign a lead" moved** from Administrator's general tab list to the Sales
   Performance page, alongside "Browse all leads" — sales management lives together now.
5. **Production Report rate calculation — root cause found and fixed.** "Rate" was
   derived from the concrete-only amount, but "Amount" displayed the total including
   pumping charge — so for any pump order, Rate × Quantity didn't match Amount, which
   is exactly what looks like "the rate is wrong" on inspection. Fixed by making Amount
   consistent with Rate (concrete only) and adding a transparent **Pumping charge**
   column plus a **Total** column, in the on-screen table and both exports.

### Migration note
Revisit `/setup?key=...` once after deploying — adds lead site-location columns, pump
departure/site-readiness columns on orders, and `order_id` on notifications (for the two
new order-level alerts).

### Testing the two new scheduled checks
Same pattern as the existing delayed-trucks test trigger — these run on a 5-minute timer
so waiting isn't practical for testing. Trigger manually instead:
```
https://oorm-backend.onrender.com/setup/run-pump-departure-check?key=YOUR_SETUP_SECRET
https://oorm-backend.onrender.com/setup/run-batching-not-started-check?key=YOUR_SETUP_SECRET
```

## Twentieth round — the real rate bug, found and fixed

Your screenshot made the actual root cause obvious — two separate real bugs, both fixed:

1. **Rate differing within the same order.** The rate lookup used `CURRENT_DATE` — the
   real-world moment each individual delivery happened to complete — instead of the
   order's own date. If a rate changed between one truck finishing and the next truck
   on the *same order* finishing, they'd get priced differently even though it's
   genuinely one order. Fixed: rate is now looked up against the order's own date, so
   every delivery on one order is always priced identically, regardless of when each
   truck actually completed.
2. **Pumping charge applied per delivery instead of once per order.** This was a real
   over-charging bug — a 4-truck pump order was being billed the pump lump sum 4 times
   instead of once. Fixed: only the first delivery invoiced on a given order carries the
   pump charge; every other delivery on that same order gets ₹0 for pumping, so the
   order's total pump charge is correct. The old field label ("lump sum per delivery")
   was actively misleading about this — corrected to "one-time per order."

**Important — this fix is forward-looking only.** I did not touch any invoice already
generated (including the ones in your screenshot) — correcting historical financial
records automatically is too risky to do silently, since you may have already acted on
those numbers. Those specific deliveries (DT-2244's rate, and the extra pump charges on
DT-2243/2242/2241) will still show their original amounts until you address them
manually. If you want, I can build a proper invoice-correction tool for
Administrator/Accountant so fixing records like these doesn't require touching the
database directly — let me know.

**Rates module now has the history log you asked for.** Administrator/Accountant →
Concrete grades and rates now shows every rate ever entered — customer, grade, rate,
pump charge, effective dates, and whether it's currently active or was superseded —
instead of just a blind "add rate" form with no way to see what's already on file. Also
added an **"End this rate"** action, so replacing a rate can now properly close out the
old one (set its end date) instead of leaving it open-ended indefinitely, which is
exactly the kind of ambiguity that let this bug happen in the first place.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Twenty-first round — bug fix: pump departure confirmation never showed

**Root cause**: `pump_requirement` never actually stores a value called `"with_pump"` —
it's one of `boom_pump`, `line_pump`, or `without_pump` (matching the specific pump type
selected on the order). The new pump-departure code from last round checked for
`pump_requirement === "with_pump"`, a value that never exists — so the confirmation
button, the Manager Dashboard's pump status table, and the automatic overdue check were
all silently looking for something that could never match, regardless of whether the
order actually needed a pump.

Fixed everywhere this mistake was made (5 spots — 1 backend, 4 frontend), all changed to
check `pump_requirement !== "without_pump"` instead, consistent with how the rest of the
app already correctly identifies a pump order. Also fixed the same wrong value in the
booking-conversion form's pump dropdown (Manager converting a Sales Executive's booking)
— that one had the identical bug independently, plus wasn't filtering the pump list by
type correctly; both fixed together. And fixed a small operator-precedence bug in the
Site Supervisor's "show today's orders" condition while in there.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Twenty-second round

1. **Pump status shows "Pumping"** once a delivery note exists for the order and the
   Site Supervisor has confirmed unloading has started — cross-referenced by order,
   not just guessed from timing. Status now reads: Not yet departed → Overdue (if past
   scheduled time) → En route (pump confirmed departed) → Pumping (truck actively
   unloading at site).
2. **Site Supervisor can flag work completed** — a new "Mark work completed" action on
   each of today's orders, for when the site is satisfied before the full ordered
   quantity is reached (rather than only relying on automatic completion once delivered
   quantity hits the order total).
3. **Site Supervisor now has Fuel Filling access**, same as Driver/Manager/Accountant.
4. **"Rejected concrete" KPI fixed** — was showing today's *count* of rejected tickets;
   now correctly shows **total m³ rejected this month**, labeled "Rejected concrete —
   month" to match.
5. **Manager Dashboard reordered**: Menu → KPIs → Pending bookings → Pump status →
   Active trucks → Completed trips → Running orders today (with carried-forward items
   directly above) → Scheduled tomorrow → On-duty drivers → Raw material stock.
   Statutory Compliance Monitoring will slot in at the end once that module is built —
   not added as a placeholder yet since there's nothing behind it.
6. **Customer complaints — found the real gap.** Complaints logged via Sales
   Executive's after-sales feedback were already pushing a notification to Manager, but
   there was genuinely no page for Manager to go *look* at them — the list only existed
   on the Sales Executive's own screen. Added a **Customer Feedback** page for Manager
   (linked from the dashboard menu), filterable by Complaints/Compliments/All.

### Compliance module — noted for the build
Confirmed: certificate/document number will be optional, not required, when that
module is built.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Twenty-third round — Statutory Compliance Monitoring

Built exactly per the confirmed mockups. Manager-only, at `/compliance`, linked from
the dashboard menu and a new **Compliance alerts** card at the bottom of the Manager
Dashboard (matching the redesigned mockup — grouped Expired/Expiring sections, colored
left borders, day counts, not a flat list).

- **11 asset types**, each auto-tagged Vehicle or Equipment, which determines which
  document types apply — the "Add / renew document" form only shows the relevant six
  for whatever asset you pick.
- **Vehicle documents**: Insurance, Road Tax, Permit, PUC, Fitness Certificate,
  Registration Certificate.
- **Equipment documents**: Insurance, AMC, Calibration Certificate, Inspection
  Certificate, Load Testing Certificate, Safety Certification.
- **Certificate/document number is optional**, as confirmed — expiry date is the only
  required field beyond picking the asset and document type.
- **Renewing** a document updates the same record's expiry date (and who/when) rather
  than creating a new row each time — the register always shows the current state, not
  a growing history.
- **No file attachments** — dates and certificate numbers only, as confirmed.
- **Alerts**: 30/15/7 days before expiry, on the expiry date, and daily after until
  renewed — same recurring 5-minute-timer mechanism as the other scheduled checks, with
  a per-document-per-day dedup so it only actually sends once a day no matter how often
  the timer ticks.

### Migration note
Revisit `/setup?key=...` once after deploying — adds `compliance_assets`,
`compliance_documents`, and `compliance_document_id` on `notifications`.

### Testing the alert check
Same manual-trigger pattern as the other scheduled checks:
```
https://oorm-backend.onrender.com/setup/run-compliance-check?key=YOUR_SETUP_SECRET
```

## Twenty-fourth round

1. **Delay reasons for pump departure and site-readiness.** If Site Supervisor
   confirms either one after its scheduled time, a reason is now required (prompted
   automatically) and shown right on the Manager Dashboard's Pump Status table. Manager
   can also add or correct a reason directly from that table.
2. **QC-flagged delay alerts now require a written response, not a silent dismiss.**
   "Mark reviewed" is now "Add response & mark reviewed" — Manager must write the
   action taken or reason for letting the truck continue, and that text stays visible
   on the Active Trucks table (as "QC flag reviewed" + the note) instead of the flag
   just disappearing.
3. **"Mark work completed" reworked — it no longer touches order status at all.**
   This was causing real mistakes because it looked identical to genuine completion.
   Now it's purely a signal: Site Supervisor flags work complete, Manager sees "Site
   marked complete" on the order and must explicitly hit **Confirm completion** to
   actually close it out. Also moved the after-pour-care checkbox and completion
   comment **out of the per-delivery unloading form and into this new work-completion
   step** — checking after-pour-care is now mandatory to flag work completed (comment
   stays optional), rather than being asked on every single delivery.
4. **Administrator now has full access to Statutory Compliance Monitoring**, alongside
   Manager.
5. **Manager now has access to Correct Orders, Correct Tickets, and Concrete Grades
   and Rates** — these panels were Administrator-only before; moved into the shared
   panel library so both roles use the identical implementation.

### Migration note
Revisit `/setup?key=...` once after deploying — adds delay-reason columns, the
supervisor-completion-signal columns, `after_pour_care_confirmed`/
`work_completion_remarks` (now at the order level), and `manager_response` on
notifications.

## Twenty-fifth round — bug fix: work-completion comment had no permanent home

Real gap found from your question: the Site Supervisor's work-completion comment and
after-pour-care confirmation only showed on the Manager Dashboard's order tables, and
only *while the order was still awaiting confirmation* — the moment Manager confirmed
completion, the display condition stopped matching and the comment vanished from view
(the data was never lost, just not shown anywhere afterward). Fixed by adding it to the
existing **"View details"** modal (reachable from every order regardless of status),
alongside the pump departure and site-ready delay reasons, which had the same gap.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Twenty-sixth round — two real bugs found and fixed

1. **Site Supervisor never saw the delay-reason prompt — root cause: the same
   timezone bug pattern that's hit this app before, reintroduced in a new spot.**
   Last round's lateness check used `new Date().toISOString().slice(0,10)` — today's
   date in UTC — then parsed the scheduled time in the *server's* local timezone
   (Render defaults to UTC), not IST. That meant the "is this late?" check was
   comparing against a threshold shifted by the UTC/IST gap, so it almost never
   evaluated true within any realistic confirmation window — the reason-prompt path
   just silently never triggered. Fixed by moving the comparison into SQL instead of
   JavaScript `Date` parsing, same pattern already used reliably elsewhere in this app
   (the database session is pinned to IST, so date arithmetic done there is correct
   regardless of what timezone the server itself runs in). Manager's side worked
   because it never depended on this broken check in the first place — "Add reason" was
   always available regardless of timing.
2. **Site-readiness had no visibility at all for orders without a pump.** The overdue
   highlighting and delay-reason handling only existed in the Pump Status table, which
   only lists orders that actually need a pump — a real order with no pump requirement
   could sit indefinitely with an unconfirmed site and nothing on the dashboard would
   ever show it, regardless of how overdue it got. Fixed: the main order tables
   (Running today, Scheduled tomorrow, carried-forward) now show site-ready status for
   every order, turn the row red once it's overdue, and give Manager the same
   "Add reason" capability that pump departure already had.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Twenty-seventh round — batching delay tracking (first truck only)

Tracks the time from Site Supervisor confirming site-ready to Plant Operator creating
the **first** delivery note for that order — not every truck, just the initial gap.

- **Manager Dashboard**: once site-ready is confirmed and no ticket exists yet, the
  order's row shows a live count-up timer ("Waiting for DN — 3m 12s") right in the Site
  Ready column, turning red past 12 minutes. Stops automatically once the first ticket
  is created.
- **Plant Operator**: the same wait shows as a large, hard-to-miss timer banner at the
  top of the screen (bigger text, bold border) — exactly the version you asked to make
  "a little bit bigger" — for every order currently in this waiting state, with a clear
  "start batching now" message once past 12 minutes.
- **Automatic alert**: if 12 minutes pass with no delivery note created, Manager and
  Plant Operator both get notified (in-app + push), once per order — same recurring
  5-minute-timer mechanism as the other scheduled checks.
- Also added: Plant Operator's screen now polls for updates every 20 seconds. It
  previously only loaded data once when the page opened, which would have meant a
  newly-site-ready order wouldn't actually show up without a manual reload — defeating
  the point of a live alert.

### Migration note
No schema changes — this reads from columns (`site_ready_confirmed_at`) already added
in an earlier round; nothing new to apply via `/setup`.

### Testing the new alert
Same manual-trigger pattern as the other scheduled checks:
```
https://oorm-backend.onrender.com/setup/run-batching-delay-check?key=YOUR_SETUP_SECRET
```

## Twenty-eighth round

1. **Notifications page** for Manager and Administrator (`/notifications`) — every
   notification ever generated by the app (breakdowns, rejections, QC flags, compliance
   alerts, batching delays, everything), with filter by All/Unread, mark read, mark all
   read, and **delete**. Manager's dashboard shows a live unread-count badge on the
   Notifications button.
2. **Manager Dashboard menu decluttered** — "Create order" and "Notifications" stay
   front and center; everything else (customers & sites, correct orders/tickets, rates,
   leads, feedback, breakdowns, fuel, compliance) collapses behind a single
   "More ▾" toggle.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Twenty-ninth round — bug fix: closed orders never left Pump Status

**Root cause confirmed**: `PumpStatusTable` filtered orders only by pump requirement —
`orders.filter(o => o.pump_requirement !== "without_pump")` — with **no status check at
all**. A completed, closed, or even cancelled order stayed in that table indefinitely,
which is exactly what you saw: the order you'd already closed kept showing there
regardless of what happened to it everywhere else. Fixed by excluding
completed/closed/cancelled orders from Pump Status specifically, so once an order is
actually finished, it stops appearing there — while still correctly showing in
"Running Orders Today" (which intentionally keeps a same-day record regardless of
status, unaffected by this fix).

Also: "Running today" renamed to **"Running Orders Today"**.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Thirtieth round

1. **Order rescheduling with a required reason** — new "Reschedule" button in Correct
   Orders (Manager and Administrator), separate from the general "Edit" action. Requires
   both a new date and a reason; the original date is preserved and shown ("Rescheduled
   from...") both in the orders list and permanently in "View details." Rescheduling
   also resets the site-ready confirmation, since a new date means the readiness check
   needs to happen again for that date.
2. **Rate-availability warning at order creation** — chose the warning approach over
   blocking DN creation, since blocking could halt legitimate operations for reasons
   unrelated to billing (e.g. urgent deliveries where paperwork isn't finalized yet).
   As soon as a customer and grade are both selected on the Create Order form (or the
   booking-conversion form), it checks live whether a rate is on file and shows an amber
   warning if not — catching the gap before the order is even placed, rather than only
   discovering it after a delivery completes with no invoice.
3. **Production graph bug fixed** — the tallest bar's value label was being pushed
   completely off the visible chart area. When the highest bar's value equals the
   chart's max, its height filled the *entire* chart with literally zero room left for
   the label above it — the label's Y-coordinate came out negative, rendering above the
   visible canvas. Fixed by reserving a fixed header strip so even the tallest possible
   bar always has room for its number.
4. **Admin dashboard menu decluttered** — same pattern as Manager's — "View Manager
   Dashboard," "Production report," and "Sales performance" stay visible; "Manage
   users...," "Statutory compliance," and "Notifications" collapse behind "More ▾".

### Migration note
Revisit `/setup?key=...` once after deploying — adds the reschedule-tracking columns.

## Thirty-first round — bug fix: reschedule didn't properly handle time-only changes

Real gap: the backend required a new date on every reschedule, even when Manager only
wanted to change the batching time on the same day — and separately, the "Rescheduled
from..." history only ever displayed the date, so a time-only reschedule left no visible
trace of what actually changed. Fixed both: rescheduling now accepts a new date, a new
time, or both independently (only a reason plus at least one of the two is required),
and the history — both in Correct Orders and permanently in "View details" — now shows
the original time alongside the original date whenever either changed.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Thirty-second round — code review: real bug found and fixed, plus a broader sweep

**The reported bug — driver self-service completions silently getting stuck, root
cause found**: your description (driver confirms everything, moves to the next trip,
but the dashboard keeps showing the first truck at site, alert with no way to clear it)
pointed straight at the offline queue. Actions taken with weak/no signal at a delivery
site get queued locally and only retried in two situations: the next action while
online, or the browser's `online` *transition* event firing. But that event never fires
if the app is simply reopened when it's already connected — closed at a low-signal
site, reopened later somewhere with signal — so a queued completion could sit in local
storage indefinitely with nothing ever re-attempting it. The driver's own screen showed
them as done and moved them to the next trip; the server never actually received the
completion, so the first ticket stayed genuinely active forever on Manager's dashboard.

Fixed by adding a periodic flush (checks every 30 seconds while the app is open,
regardless of whether an online-transition event fired) plus flushing once immediately
whenever Driver's or Site Supervisor's screen loads — covering exactly the "reopened
already-connected" case that was falling through. Also added a manual **"Sync now"**
button next to the pending-actions count, so there's always a way to force a retry
without waiting.

**Broader sweep also turned up:**
- `/tickets/my-trip` (what the Driver app considers their current trip) was missing
  `rejected` from its exclusion list — every equivalent query elsewhere already had it.
  A rejected ticket could keep showing as the driver's "current trip" indefinitely,
  blocking a clean handoff to their next one.
- Two Manager Dashboard KPI queries (fleet status counts, delayed-trucks count) had the
  same gap — a rejected ticket could count toward "delayed" forever.
- Two more instances of the JS-`Date()`-on-the-server timezone bug (same family as
  several rounds back): the default payment date in Accountant's payment form, and —
  more importantly — the daily production chart's day-label generation, which could
  silently misalign which bar was labeled "today" during the UTC/IST boundary gap. Both
  fixed by moving the date logic into SQL, against the IST-pinned database session,
  instead of JavaScript running on the server's own (UTC) clock.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Thirty-third round

1. **Bug fix: batching-delay timer/alert kept running on already-closed orders.**
   Confirmed exactly from your screenshot — the "Waiting for DN" timer's only stop
   condition was "has a ticket been created," it never checked whether the order itself
   had already reached a terminal state. An order that gets marked complete (or closed)
   with zero deliveries — site cancelled the need after site-ready was confirmed, for
   example — kept counting up and flagging "delayed" forever, since no ticket was ever
   going to be created for it. Fixed in three places: the Manager Dashboard timer
   display, the "site not ready" overdue flag (same gap, same fix), and — more
   importantly — the backend scheduled check itself, so it stops even considering an
   order for this alert once it's completed, closed, or cancelled, regardless of ticket
   status.
2. **DN number now shown in Active Trucks** — was already being fetched by the
   underlying query, just never displayed.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Thirty-fourth round — Accountant module overhaul

### Bulk customer payments (the main ask)
Payments were previously invoice-by-invoice only — an accountant with a lump-sum
payment covering several days of deliveries had to hunt down and pay each delivery
individually. The Accountant dashboard is now **customer-centric**: one list showing
each customer's total invoiced, total paid, and balance (sorted by balance, biggest
first) instead of a flat list of every delivery. "Record payment" now takes one amount
against a **customer**, with a live preview of exactly which deliveries it'll cover
(oldest first), and applies it automatically — still creating one line in the payments
table per delivery touched, so nothing about the underlying data changes, it just saves
the repeated manual entry. Confirmed: a rejected delivery never generates an invoice in
the first place, so it was never going to show up as owed — no separate handling needed
for that part.

### Opening balances (pre-existing outstanding from before this app)
New: Accountant → **Opening balances**. Two ways to enter historical debt so the
dashboard is accurate from day one:
- **Manually**, one customer at a time (customer, amount, days outstanding, notes)
- **Upload from Excel** — parsed entirely in your browser (reusing the `xlsx` library
  already in this project for the Production Report export), so no new file-upload
  infrastructure was needed. Expects columns named something like Customer / Amount /
  Days Outstanding (flexible matching — "Customer Name" or "Outstanding Amount" work
  too) plus an optional Notes column. Shows a **preview with customer-name matching**
  before anything is committed — any row that couldn't be matched automatically gets a
  dropdown to fix it by hand, so nothing silently attaches to the wrong customer.

Opening balances aren't a separate, disconnected number — they're woven into
everything: the customer-outstanding list, the bulk-payment FIFO allocation (treated as
the oldest debt, paid off first), the Director's Dashboard's total outstanding KPI, and
the aging report (using the "days outstanding" you enter to place it in the right aging
bucket from the start).

### Migration note
Revisit `/setup?key=...` once after deploying — adds `customer_opening_balances`, and
extends `payments` so a payment can apply to either an invoice or an opening balance
(existing payment rows are untouched — `invoice_id` just becomes optional at the column
level, existing data keeps working exactly as before).

## Thirty-fifth round — code review: real SQL bug found before it shipped

Reviewed the newest and most complex code first (the bulk-payment/opening-balance
logic from last round), since financial code deserves the most scrutiny. Found a real
one:

**`GET /accountant/customers-outstanding`** — the query behind the entire new
Accountant dashboard's primary view — used `HAVING` with **no `GROUP BY` at all**,
filtering on plain arithmetic (`balance > 0.01`) rather than an aggregate function.
This is invalid in that form and would have thrown a database error the moment the
page loaded, breaking the main feature from last round entirely. Root cause: the query
was restructured to use `LATERAL` joins (which already produce one row per customer on
their own), and `HAVING` was left over from an earlier draft that used `GROUP BY`
instead — a leftover mismatch, not a logic error. Fixed by wrapping the calculation in
a subquery and filtering on the computed alias with `WHERE` at the outer level, where
it's valid to reference it.

Cross-checked every other `HAVING` clause and every other `LATERAL` join pattern in the
backend (Sales Performance dashboard uses a similar shape) to confirm this was an
isolated mistake, not a systemic one — all others are correctly paired with either a
proper `GROUP BY` + aggregate, or don't use `HAVING` at all. Also added explicit
`::date` casts on the opening-balance date arithmetic, which likely worked fine on
Postgres's implicit assignment casting already, but removes any doubt given this is
financial data.

### Migration note
No schema changes — nothing new to apply via `/setup`. This is a pure logic fix to a
query added last round; if you haven't deployed round 34 yet, this fix is already
folded in and you only need to deploy once.

## Thirty-sixth round

1. **Delivery quantity shown in Active Trucks** — was already being tracked, just not displayed.
2. **Booking-time GPS, carried through to the site**: Sales Executive can attach a site
   location when placing a booking (same "Use my current location" pattern as leads).
   When Manager converts that booking, if the site doesn't already have coordinates on
   file, they're filled in automatically from the booking — so a brand-new site gets a
   working "navigate to site" for drivers from its very first delivery, without anyone
   needing to go back and add it separately.
3. **Raw material stock now tracks qty on order and expected delivery date.** The
   low-stock display now distinguishes two very different situations: "+40 on order,
   due 3 Aug" (already being handled) vs. "Not on order — at risk" (genuinely needs
   attention) — instead of just a bare low-stock warning that can't tell the two apart.
4. **Lead location** — confirmed already built (a few rounds back): Admin/Manager can
   attach GPS when assigning a lead, either via "Use my current location" or typing
   coordinates manually.

### Photo attachments — a question before building, not a build
You asked about attaching a site photo to a lead. Worth flagging: I deliberately left
file/photo attachments out of the Statutory Compliance module a while back at your
request, and the same trade-off applies here — this app has no file-upload
infrastructure at all currently, and adding it means choosing between storing images
in Postgres (simple, zero new cost, fine at your current scale) or a dedicated file
storage service (more scalable, but a new external dependency and monthly cost).
Photos are also meaningfully larger than the certificate/document files we discussed
before, which matters more for the "store in Postgres" option specifically. Let me know
if you want this built, and which storage approach you'd prefer, and I'll take it from
there.

### Migration note
Revisit `/setup?key=...` once after deploying — adds `qty_on_order`/
`expected_delivery_date` on raw material stock, and `site_latitude`/`site_longitude`
on bookings.

## Thirty-seventh round — Sales Forecast (built for real)

Confirmed distinction: a **forecast** is a rolling planning estimate for an ongoing
project — never becomes an order on its own. A **booking** is a specific ask for a
specific delivery that Manager converts directly into a real order. Forecast → (as
specifics firm up) → Booking → Order.

- Sales Executive picks one of their own running projects, enters expected quantity +
  over how many days, and a confidence level (Confirmed / Likely / Tentative).
- **Editing an expired forecast refreshes it** — saving re-anchors the window to start
  from today, which is the same action whether it's a brand-new entry or a stale one
  being brought current. No separate "renew" step.
- **Manager and Administrator both see it** — the aggregate chart (expected demand this
  week vs. next, broken down by confidence) plus the full table across every sales
  person, not just Manager.
- One forecast per project (not a growing history) — keeps it a live current estimate
  rather than an accumulating log.

### Migration note
Revisit `/setup?key=...` once after deploying — adds `sales_forecasts`.

## Thirty-eighth round — Manager can ask for a forecast update

Manager/Administrator's forecast page now shows **every running project with a sales
person assigned** — not just ones that already have a forecast — clearly flagged as
"No forecast yet," "Expired," or "Current." Each row gets an **"Ask for update"**
button, with an optional note, that notifies the specific assigned Sales Executive
(in-app + push).

On the Sales Executive's side, any pending request shows as an alert right at the top
of their own forecast screen. The request **clears itself automatically** the moment
they actually save an update for that project — no separate "mark resolved" step
needed.

### Migration note
No schema changes — this reuses the existing `notifications` table. Nothing new to
apply via `/setup`.

## Thirty-ninth round — 3 bug fixes

1. **Customers: edit, disable, delete.** The customer panel was add-only before — no
   way to fix a spelling mistake or retire an old customer. Now has full editing,
   **Disable/Enable** (reversible — instantly removes them from every dropdown across
   the app, since those already correctly filter to active-only), and **Delete** for
   genuine mistakes (blocked with a clear message if the customer has any orders,
   sites, leads, or bookings on file — disable is the right move for anyone with real
   history, delete is only for a duplicate caught immediately).
2. **Bug fix: raw material "on order" info wasn't showing.** Root cause: it was only
   ever displayed when the bin was *currently* below its low-stock threshold. If you
   added a qty-on-order for a material that wasn't flagged low at the time, it saved
   correctly but never appeared anywhere on the dashboard. Fixed — it now always shows
   once entered, regardless of current stock level.
3. **Bug fix: Sales Forecast showed no running projects at all.** Root cause: the
   query required a salesperson to already be assigned to an order (`JOIN
   salespersons`), which silently excluded every order that didn't have one set —
   likely all of them, since it's an optional field at order creation. Fixed two ways:
   the list now shows every running project regardless of assignment (unassigned ones
   clearly marked), and Manager/Administrator can now **assign a salesperson directly
   from this screen** — the actual fix that lets the responsible Sales Executive start
   seeing and forecasting it.

### Migration note
No schema changes — `customers.is_active` already existed; everything else is logic
fixes to existing columns. Nothing new to apply via `/setup`.

## Fortieth round — the real fix for Sales Forecast, plus site/project editing

**You correctly diagnosed the root problem** — sales-executive assignment was
happening at the order level, which meant it reset per delivery instead of persisting
across a project's whole lifetime. Fixed properly, not just patched:

- **`sites` now has its own `assigned_sales_representative_id`** — a project/site gets
  a sales person assigned once, and that persists across every order that comes and
  goes for it. (An individual order's `sales_representative_id` still exists separately
  — that's a genuinely different concept, who sold that one specific delivery, used for
  attribution/commission reporting — untouched.)
- **Sales Forecast is now keyed on the site**, not the order — one forecast per
  project, matching how your team actually thinks about it.
- Manager/Administrator's forecast screen now shows **every active site**, with
  **"Assign salesperson"** right there per row — this is the actual fix, since
  everything else in the feature depends on that assignment existing.

**Projects and sites now have the same edit/disable/delete you got for customers** —
edit name/address/distance, disable (reversible, removes from active use everywhere),
delete (blocked with a clear message if it has any real history), plus assign or
change the responsible sales person directly from the same screen.

**Also found while I was in there**: schema.sql had three pre-existing forward
references (`leads.won_order_id`, `bookings.converted_order_id`,
`aftersales_feedback.order_id` all pointed at `customer_orders` before that table was
even defined in the file) — the exact same class of bug I introduced and caught in
myself a few rounds back. This wasn't affecting your live database (which already
exists and only ever receives incremental `ALTER TABLE` migrations), but it would have
broken a genuinely fresh install from scratch. Fixed the same way — deferred the FK
constraints to right after the referenced table is actually defined.

### Migration note
Revisit `/setup?key=...` once after deploying — this one's more involved than usual:
adds `sites.assigned_sales_representative_id`, converts `sales_forecasts` from
order-keyed to site-keyed (safely backfills any forecast that was actually saved under
the old design before switching), and adds `notifications.site_id`.

## Forty-first round — code review: 3 real bugs found

1. **Customer delete safety check was incomplete** — only checked 4 of the 9 tables
   that actually reference a customer (orders, sites, leads, bookings). Missing: rate
   history, invoices, after-sales feedback, customer visits, opening balances. In
   practice this meant a customer with, say, a rate on file but no orders yet could
   pass the safety check and then fail with a raw, ugly database error instead of the
   intended friendly message. Fixed — now checks all 9.
2. **Site delete safety check was missing `notifications`** — same class of issue,
   smaller blast radius. Fixed.
3. **The forecast migration itself had an edge case that could break it outright** — if
   two forecasts from the old order-based design happened to land on the same site
   (two different orders on one site, each separately forecasted before), converting to
   "one forecast per site" would hit a uniqueness violation and the whole migration
   would fail. Added a de-duplication step (keeps the most recently updated one) before
   the uniqueness constraint gets created.

Also re-verified: every `HAVING` clause in the backend (no new ones added this round —
all previously confirmed correctly paired with `GROUP BY` and an aggregate), no stale
references anywhere to the old order-based forecast design after last round's rename,
and the read-only `/master/customers` and `/master/sites` endpoints (used by every
dropdown across the app) are unaffected by the new admin-management endpoints.

### Migration note
Revisit `/setup?key=...` once after deploying — this is a safety improvement to last
round's migration, not a new one; if you already ran it successfully, re-running is a
no-op.

## Forty-second round — sweep of older, untouched-in-a-while areas

Reviewed Compliance, Fuel, and QC Engineer backend routes (none touched in many
rounds) against every bug pattern found earlier in this build: missing status
exclusions, server-side timezone bugs, `HAVING` without proper `GROUP BY`, delete
safety checks. All clean on those fronts.

**One real gap found and fixed**: compliance expiry alerts only ever notified
Manager — because that's who the module was originally built for. When Administrator
was later given equal access to the Compliance module (several rounds back), the
alert-generation code was never updated to match, so Administrator had full access to
manage compliance but never actually got notified about anything. Fixed — the
scheduled check now notifies both roles, and Administrator's own dashboard now shows
the Compliance Alerts card too (it already had the API access, just never had the
widget rendered).

Also confirmed, by re-running each check rather than assuming: every ticket-status
exclusion list across the whole backend still correctly includes `rejected`, zero
forward schema references, zero server-side `new Date()` used for business-date logic,
and the equipment-type lists between Fuel's frontend and backend still match.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Forty-third round — bug fix: /setup failed on a repeat run

**"column f.order_id does not exist"** — real bug in the sales-forecast migration
itself, not your data. Every other migration in this file is written to be safely
re-runnable (guarded with `IF NOT EXISTS` / `IF EXISTS`), but the order-to-site
conversion wasn't: it unconditionally tried to read `sales_forecasts.order_id` to
backfill from, without checking whether that column still existed. The first time you
ran `/setup`, it worked and successfully dropped `order_id` as intended. The second
time `/setup` got triggered, it tried the same backfill again — except `order_id` was
already gone, so it failed immediately.

**Your data is fine** — the first run completed the actual migration correctly. Fixed
by checking whether `order_id` still exists before attempting anything with it, so
`/setup` is now safe to run any number of times, matching how every other migration in
this file already behaves.

### Migration note
Revisit `/setup?key=...` once more after deploying this fix — it should now complete
cleanly. If it was already fully migrated (likely, given the analysis above), this run
will just confirm that and move on.

## Forty-fourth round — 3 forecast bugs, all confirmed and fixed

1. **Sales Executive had no edit or delete option** — "Your forecasts" was a read-only
   table; the only way to change anything was to remember to re-open the add form and
   pick the same project again. Added proper **Edit** (pre-fills the form, locks the
   project selector since changing it would target a different forecast entirely) and
   **Delete** buttons directly on each row.
2. **Forecasts didn't show anywhere on the Sales Executive's own dashboard** — they
   only existed on the separate Forecast page, easy to forget was there. Added a
   forecast summary section right on the main Dashboard tab, with an expired-count
   badge and a link through to the full page.
3. **Bug confirmed exactly as reported — the weekly chart was double-counting.**
   130 m³ over 14 days showing as 130 this week *and* 130 next week was real: the query
   checked whether a forecast's window merely *overlapped* each week and then counted
   the full amount for every week it touched, rather than splitting it proportionally.
   A 14-day forecast overlaps both weeks entirely, so it got counted in full, twice.
   Fixed with a proper day-by-day proportional split — the same test case now correctly
   shows 65 m³ this week and 65 m³ next week.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Forty-fifth round

1. **Bug fix: salesperson missing wherever it was pulled only from the order, not the
   site — confirmed exactly from your screenshot.** This turned out to be a bigger gap
   than just the Production Report: the same "only checks order-level assignment"
   mistake was also in the Sales Executive's own dashboard (their orders/value/
   outstanding KPIs), the Admin Sales Performance leaderboard, the Director's Dashboard's
   sales-by-salesman report, and the single-order detail view. All fixed the same way —
   fall back to the site's assigned salesperson whenever the order doesn't have an
   explicit one of its own (an explicit order-level override, if ever set, still takes
   priority).
2. **Boom pump now gets both vehicle and equipment compliance documents.** It's
   mounted on a truck chassis and driven on public roads, so it genuinely needs PUC,
   Permit, Road Tax, Fitness Certificate, and Registration Certificate — on top of the
   equipment-side ones (Calibration, Load Testing, Safety Certification) it already had.
3. **Accountant's customer-wise outstanding report now exports to PDF and Excel** —
   the report itself already existed (built a few rounds back as the primary Accountant
   view), just missing the export buttons.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Forty-sixth round — root cause of the "Sumesh" vs "Sumesh KV" mismatch

Your explanation made the actual bug clear: orders created *before* your salesperson
cleanup ("Sumesh" deactivated, "Sumesh KV" now the correct active one) still carry the
old order-level `sales_representative_id` pointing at "Sumesh." Last round's fix added
a fallback to the site's assignment, but prioritized the order-level value *first* —
so any order with that stale leftover reference kept showing "Sumesh" regardless of
what the site was actually correctly assigned to now.

**Flipped the priority everywhere** (Production Report, Sales Executive's dashboard,
Sales Performance, Director's Dashboard, order detail) — the site's assigned
salesperson is now checked first and wins; the order-level value is only used as a
last-resort fallback for the rare case a site somehow has no assignment at all.

**Site salesperson is now a required field** at creation — the "Add site" form won't
submit without one selected, and the backend rejects it too. This is enforced going
forward only: any site that already exists without one assigned will keep showing
"Unassigned" (in both Sites and Sales Forecast) until someone assigns it manually via
the existing "Assign" action — I didn't force a retroactive assignment, since only you
know who actually owns each existing site's relationship.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Forty-seventh round — a deeper bug: database timezone had a race condition

Your instinct about a date/timezone issue was right, and it led to something more
fundamental than the salesperson mismatch — a real bug in how every single database
connection in this app gets its timezone set.

**The bug**: `db.js` set each new connection's timezone via a `pool.on("connect", ...)`
listener. That listener is fire-and-forget — it fires off the `SET TIME ZONE` command
but doesn't block the connection pool from handing that same brand-new connection out
for an actual query. That created a race: a query landing on a freshly-created
connection could run concurrently with (or even before) the timezone command finished,
meaning that one query would execute against the database server's default UTC instead
of IST. Right at a day or month boundary — like just after midnight IST, which is
exactly when your screenshots were taken (00:15–00:17) — that's precisely the kind of
moment a query could get miscategorized into the wrong day or even the previous month.
This isn't something that happens on every query, only on ones unlucky enough to land
on a connection at the exact moment it's still being set up, which is exactly why it
would look like sporadic, hard-to-pin-down bad data rather than something consistently
broken.

**The fix**: instead of a fire-and-forget listener, every connection now has its
timezone guaranteed set *before* it's ever usable for a query — both for the app's
normal query path and for `setup.js`'s migrations, which call the database directly
and would otherwise have bypassed this fix entirely.

I want to be direct about what I can and can't confirm: I don't have access to your
live database, so I can't directly verify the Dreamflower invoice was actually a victim
of this exact race. But it's a real, genuine bug I found by reviewing the connection
code carefully, it's exactly the right shape to explain what you're seeing, and it's
now fixed regardless.

### What to do about the existing Dreamflower entry
This fix prevents it from happening again — it doesn't retroactively correct data that
might already be sitting in the wrong bucket. If that invoice already exists with a
`created_at` that's genuinely wrong, the cleanest fix is to find it directly:
Accountant → Customers — outstanding → look for Dreamflower, or Production Report
filtered specifically to that customer with a wide date range, to locate the exact
delivery/invoice in question and confirm its real date.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Forty-eighth round — a real way to see the underlying data, instead of more guessing

Since the timezone fix didn't resolve it, and I don't have access to your live
database to inspect the actual rows myself, I built the most useful next thing I
can: **the Director's Dashboard's "Sales this month, by customer" and
"Salesman-wise sales this month" rows are now clickable** — each one links straight
into Production Report, pre-filtered to that exact customer or salesperson, for this
month's date range, and runs automatically.

Click "Dreamflower" (or whichever entry looks wrong) and you'll land directly on the
specific delivery ticket(s) actually contributing to that total — the DC number, the
exact date, the site, everything. That will show us definitively whether this is a
real data problem (a delivery genuinely mis-dated or mis-attributed) or something the
Dashboard is computing incorrectly that the Production Report doesn't show — which
tells us exactly where to look next, instead of me continuing to guess at theories
from screenshots.

This works for any report/salesperson going forward too — a permanent feature, not a
one-off diagnostic.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Forty-ninth round — the actual bug, found from your arithmetic

Your math made this conclusive: Pump utilization (33 m³) + without-pump (6.5 m³) = 39.5
m³, exactly matching this month's total production (all 6 known deliveries). Dreamflower's
18 m³ doesn't correspond to any of them — meaning it isn't corrupted or phantom data,
it's a **real invoice, just scoped to the wrong month**.

**Root cause**: "Sales Today," "Sales This Month," "Sales this month by customer," and
"Salesman-wise sales this month" all filtered by **when the invoice was created**
(`invoices.created_at`), not when the concrete was actually delivered
(`delivery_tickets.ticket_date`). An invoice is only generated when someone confirms
unloading complete — if that confirmation happens later than the actual delivery (even
by a day, e.g. confirmed the next morning), the invoice's creation timestamp lands in a
different month than the delivery itself. Production Report was already correctly using
the real delivery date the whole time, which is exactly why it never showed Dreamflower
under this month — it was scoped correctly all along; the Dashboard wasn't.

**Fixed all four** to use the actual delivery date, matching Production Report and
matching what "sales this month" should intuitively mean: concrete delivered this
month, not paperwork completed this month. (Left the aging report and
Accountant's "collected" figures alone — those genuinely should reflect invoice/payment
timing, not delivery date, so they weren't part of this bug.)

The clickable Dashboard rows from last round now stay useful and accurate too, since
both sides of that link use the same date field.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Fiftieth round — the reports are correct; the real issue was unbilled deliveries

Confirmed the numbers now, and they check out: "Pump utilization" (33 m³, KMCT
Project's 4 deliveries) is production-based and counts every delivery regardless of
billing status. "Sales this month" is invoice-based and only counts what's actually
been invoiced. Those 4 deliveries showed blank rate/amount in your very first
Production Report screenshot — no rate was ever configured for that customer/grade, so
no invoice was ever generated. That's not a reporting bug; it's 33 m³ of real concrete
that went out without ever being billed.

That's a serious enough gap that it shouldn't require cross-referencing three different
tables to notice, so added a new **"Unbilled deliveries this month"** card — a red
warning box showing exactly which deliveries (DC number, customer, site, date,
quantity) were delivered this month but never invoiced, with the total called out
clearly. Whenever "Sales this month" looks lower than actual production going forward,
this card will show precisely why and exactly which deliveries need a rate added.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Fifty-first round — retroactive invoice recalculation

New action on each rate in the Rate history table: **"Recalculate deliveries"**. Shows
a preview of every completed delivery that rate's date range applies to, before
touching anything:

- **No invoice yet** → shows what it would create
- **Has an invoice, doesn't match this rate** → shows what it would correct
- **Has an invoice with a payment already recorded** → automatically excluded and
  flagged, never touched — changing what's owed on something a customer may have
  already paid against isn't something to automate silently
- Respects the "pumping charge once per order" rule from a few rounds back — won't
  double-charge a multi-truck order's pump fee when creating/correcting several of its
  deliveries at once

Nothing is selected and applied without an explicit review — every affected delivery is
listed individually (DC number, date, current amount vs. new amount) with a checkbox,
defaulting to everything actionable pre-checked, and a final confirmation dialog before
anything is written.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Fifty-second round

1. **Site Ready column now shows "–" once an order is completed/closed/cancelled** —
   was still showing a stale "Not confirmed" badge on finished orders even though
   readiness is irrelevant by that point.
2. **Plant Operator's "missing tickets" — real bug found, not misleading.** Ticket
   creation had zero offline-queue protection (Driver's and Site Supervisor's screens
   already had this fixed rounds ago; Plant Operator's never got the same treatment). A
   lost connection during submission — very plausible near a plant with patchy signal —
   could fail with the delivery note simply never created, and nothing to retry it
   automatically. Fixed properly: ticket creation now goes through the same offline
   queue, made safe against duplicates with a client-generated idempotency key (a
   retried/queued submission resolves to the same ticket instead of creating a second
   one), plus a visible pending-sync count and manual "Sync now" button so it's never
   silent.
3. **On-duty drivers with no location update in over 12 hours no longer show** — a
   dead phone or a killed app without properly clocking off was leaving drivers stuck
   showing as perpetually on duty.
4. **Pump charge with a zero rate — confirmed correct, no change needed.** Verified in
   both the invoice-generation code and the recalculation tool: a zero/unset pumping
   charge always computes to exactly ₹0, never a fallback or default value.
5. **Sales Executive duty login + location tracking** — a parallel system to Driver's
   (separate tables, no risk to the existing driver tracking). Toggle on/off duty from
   the Sales Executive's own screen; while on, location pings every 5 minutes (field
   visits, not a moving vehicle, so less frequent than a driver's 30-second interval).
   Manager Dashboard gets a new **"On-duty Sales Executives"** card, same pattern as
   On-Duty Drivers, with the same 12-hour staleness rule from item 3.

### Migration note
Revisit `/setup?key=...` once after deploying — adds the idempotency key on delivery
tickets, and the new `sales_duty_log`/`sales_gps_pings` tables.

### A note on this session
Partway through this round, my working directory was reset by the environment — I
caught it immediately (a routine `cd` failed) and recovered by re-extracting the last
package I'd delivered (`oorm-app_64.zip`) from the outputs folder, which had persisted
independently. Verified it matched exactly where round 51 left off before continuing,
so nothing from earlier rounds was lost or silently redone.

## Fifty-third round

1. **Removed the location-sharing disclosure line** from the Sales Executive's duty
   toggle.
2. **On-duty Sales Executives moved from Manager Dashboard to Administrator's
   dashboard** (`/reports`, already restricted to administrators only) — removed
   entirely from Manager's screen, not just duplicated.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Fifty-fourth round — attendance-style duty gating for Sales Executive

**Duty gate, enforced server-side (not just hidden in the UI)**: a Sales Executive
can't add a lead, log a follow-up, place a booking, log a visit, record feedback, or
save a forecast until they're actually clocked in. Manager/Administrator acting on a
lead aren't subject to this — the gate only applies when the Sales Executive is the
one doing it themselves.

**Attendance-style punch display**: below the duty toggle, shows "On duty since
HH:MM" while clocked in, and the full day's punch-in/punch-out history as a compact
list — same idea as a physical attendance register, not just a bare on/off switch.

**Clear, visible off-duty messaging** — not just a disabled-button tooltip (easy to
miss on mobile): a banner on the Dashboard and on the Forecast page explains plainly
that clocking in is needed before adding anything.

### Migration note
No schema changes — reuses the existing `sales_duty_log` table from last round.
Nothing new to apply via `/setup`.

## Fifty-fifth round — rates now key on customer + site/project + grade

Real gap: the same customer can have multiple sites/projects needing genuinely
different rates for the same grade (distance, mix specs, site conditions). Rates were
only ever keyed on customer + grade, with no way to differentiate by site at all.

**New rates now require a site/project**, in addition to customer and grade — the "Add
rate" form won't submit without one. **Existing rates keep working exactly as before**,
as a customer-wide fallback: everywhere a rate gets looked up (invoice generation, the
order-creation rate warning, the recalculation tool), a site-specific rate is now
preferred when one exists, falling back to a generic customer+grade rate only if no
site-specific one is on file. Nothing about your current invoicing breaks — this is
additive, not a replacement.

Updated everywhere a rate gets read or matched:
- Invoice generation (the actual billing logic)
- The "no rate on file" warning at order creation and booking conversion — now checks
  the specific site, not just the customer
- The Rate history table — shows which site/project each rate applies to ("All sites"
  for a generic one)
- The retroactive recalculation tool from a few rounds back — a site-specific rate only
  recalculates that site's deliveries; a generic rate still recalculates across all of
  a customer's sites

### Migration note
Revisit `/setup?key=...` once after deploying — adds `site_id` to `rate_master`
(nullable, so nothing existing breaks).

## Fifty-sixth round — a real, serious bug found from your evidence

Your two pieces of evidence together proved it conclusively: dozens of unrelated
customers all showing the identical ₹4500/₹1500/₹500 M25 rate is not a coincidence.

**Root cause**: `/setup`'s fresh-install check only ever gated the *table creation*
step. The sample/seed data underneath it — including a placeholder M25 rate — sat
completely unguarded and ran on **every single `/setup` call**, not just a genuinely
fresh install. Every time `/setup` was revisited (which has happened after nearly every
round in this build), it silently inserted a fake ₹4500/₹1500/₹500 M25 rate for any
real customer that didn't yet have an M25 rate of their own. Real deliveries for those
customers could then get invoiced at that made-up number instead of their actual
agreed rate — this is a genuine billing-accuracy bug, not a cosmetic one.

**Fixed two ways**:
1. Moved the entire seed-data block (sample customer, sample pumps, the sample rate)
   inside the fresh-install-only branch — it is now structurally impossible for this to
   run against a database that already has real data, on any future `/setup` call.
2. New **"Review sample rates"** button on the Rate history screen — finds every rate
   still matching that exact fingerprint (₹4500 / ₹1500 pump / ₹500 waiting / M25 /
   no specific site), shows a rough count of invoices that may have been priced using
   that number, and lets you review and bulk-delete the ones that were never actually
   correct for that customer. Nothing is deleted automatically.

### What to do next
1. Deploy this, then `/setup?key=...` once (safe now — the bug is what you're fixing).
2. Go to Rate history → **Review sample rates** and check the list against your actual
   knowledge of each customer's real rate. Delete the ones that are wrong.
3. For any customer where deliveries were already invoiced at the fake rate, add their
   correct rate, then use **"Recalculate deliveries"** on it (from a couple rounds back)
   to fix the affected invoices — that tool already refuses to touch anything with a
   payment already recorded against it, so it's safe to run.

### Migration note
No schema changes this round — nothing new to apply via `/setup` beyond confirming the
fix took effect.

## Fifty-seventh round — the driver stuck-trip problem, solved for real

Built out the full design from our mockup session: the driver's trip list, the
stage-based trip sheet, the Plant Operator warning, and the Manager cross-check.

### Root cause, actually fixed this time
`/tickets/my-trip` used `ORDER BY created_at DESC LIMIT 1` — a single trip, always the
most recent. The moment Plant Operator assigned a second trip before the first was
confirmed, the first one silently vanished from the driver's screen with no way to act
on it. Replaced with `/tickets/my-trips` — every trip still needing action, plus
today's completed ones. Structurally, a trip can no longer disappear just because a
newer one exists.

### Driver's new home screen
- **Punch IN / Punch OUT** (renamed from Duty ON/OFF)
- Current trip shown immediately below it — no extra tap to see it — with customer,
  site, distance, a "Site location" link, and trip allowance, all in one card
- **Horizontal 4-stage tracker: Plant Out → Site In → Site Out → Plant In**, common
  driver language instead of technical terms. Sequentially gated — a stage can't be
  tapped until the one before it is logged; the button is visibly locked until then
- Every stage tap captures GPS at that exact moment (needed for the cross-check —
  without it there'd be nothing to compare against)
- Older trips needing action get a clear red banner and their own list, each with the
  same tracker
- Completed-today list shows what was actually earned per trip, plus a running total

**Plant Out / Plant In are genuinely new tracking** (not in the app before), available
on every trip regardless of whether the site has a Site Supervisor — this is also what
gives a clean, structural signal for "this truck is actually free again," which was
completely missing before.

**Site In / Site Out** stay exactly what they were — the existing arrival/unloading
confirmation flow for sites with no Site Supervisor — just re-surfaced as two stages
in the tracker instead of a separate flow. Site Out still opens the same slump/delivery
note/after-pour-care form as before; nothing about the underlying data changed. For
supervised sites, these two stages show as read-only, filled in once the Site
Supervisor confirms — the driver isn't asked to duplicate what's already being tracked.

### Plant Operator
Selecting a driver with a still-open, unconfirmed trip now shows a clear (non-blocking)
warning naming the ticket — this is the fix for dispatching a second trip
"unknowingly," without stopping a genuinely legitimate reassignment.

### Manager cross-check
New card: compares each trip's logged Site In time (clearly attributed to whoever
logged it — driver or Site Supervisor) against the nearest GPS ping, flagging gaps over
15 minutes. Worth being upfront about a design reality here: a true 3-way comparison
(separate driver time *and* separate supervisor time) isn't something the data model
actually supports — driver and supervisor share the same confirmation step, so there's
one logged time per stage, not two. This compares that one time, clearly labeled with
who logged it, against GPS — the honest, buildable version of the idea.

### Migration note
No schema changes — built entirely on the existing `trip_events` table. Nothing new to
apply via `/setup`.

## Fifty-eighth round — bookings now carry a time, not just a date

Sales Executive's "New booking" form gets a **preferred time** field alongside the
date. Carries through the whole flow:
- Manager's booking queue shows both date and time
- Converting a booking to an order now pre-fills the scheduled batching time from what
  was requested (previously hardcoded to 08:00 regardless of what the customer asked
  for) — Manager can still adjust it before confirming, same as the date already did

### Migration note
Revisit `/setup?key=...` once after deploying — adds `preferred_time` to `bookings`.

## Pricing logic — confirmed design, not yet built
Discussed and confirmed the plan for pump mobilization charges (split by pump type,
with a minimum-qty threshold per type) and part-load charges (mandatory
applicable/not-applicable decision, same pattern as pump charge) — implementation
still pending, will build next.

## Fifty-ninth round — pump charge and part load, built for real

### Rates
Pump mobilization charge is now split by pump type — line pump and boom pump each get
their own charge and minimum-qty threshold (defaults: 20 m³ line, 50 m³ boom). Part load
charge added too: minimum load quantity plus a rate per m³ short of it. Old rates keep
working via the legacy single pump-charge field as a fallback.

### Order creation (and booking conversion — same treatment, see below)
Both are Manager's own confirmed decision, never automatic:
- **Pump charge**: whenever a pump is selected, a mandatory Applicable/Not-applicable
  choice appears, showing the rate on file for that specific pump type and its usual
  minimum-qty threshold as context
- **Part load**: whenever the order quantity is below the rate's minimum load, the same
  mandatory choice appears, showing the shortfall calculation
- A running cost summary (concrete + confirmed pump charge + confirmed part load)
  updates live
- Both are validated server-side, not just in the form

**Found and fixed while building this**: booking conversion creates an order through a
completely separate code path from the main order-creation endpoint — it would have
silently bypassed both confirmations entirely if left alone. Gave it the exact same
validation and confirmation UI.

### Threshold-crossing review
When a later delivery pushes an order's cumulative quantity past the pump type's
threshold after the charge was already confirmed applicable, the order gets flagged —
never auto-corrected — and both Accountant and Manager are notified. New **"Pump
charge review"** screen on the Accountant dashboard: **Dismiss** (charge is still
correct, leave it) or **Remove pump charge** (blocked automatically if a payment has
already been recorded against that invoice).

### Migration note
Revisit `/setup?key=...` once after deploying — this one touches three tables
(`rate_master`, `customer_orders`, `invoices`).

## Sixtieth round

**Unbilled deliveries — now shows exactly why, not just that.** A rate matches only
when all of these line up: customer, (site-specific rate OR a generic all-sites one),
grade, AND the rate's effective date is on or before the **order's** date (not today's
date, not the delivery date). The most common miss: a rate added after these orders
already existed, with an effective date later than the order — rates don't apply
retroactively. New **"Why"** column checks each of these conditions individually and
names the actual one that failed — no rate at all, a rate for a different site, a rate
that starts too late, or one that already ended — instead of a generic "check your
rates" pointer.

**Outstanding aging report — zero amounts now show blank** instead of ₹0, so a scan
down the table only shows numbers where there's actually something outstanding.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Sixtieth round

**Unbilled deliveries — explained, not a bug.** Invoice generation happens exactly
once, at the moment a delivery is confirmed complete — it isn't a live, ongoing
calculation. If a delivery was confirmed *before* a rate existed for that customer/
site/grade, no invoice gets created, and nothing retroactively fixes that later just
because a rate gets added afterward — the rate now existing doesn't reach back in time.
That's exactly what those 8 tickets are: confirmed before their rate was on file. The
fix is the **"Recalculate deliveries"** tool on that rate's row in Rate history (from a
few rounds back) — it finds exactly these gaps and lets you create the missing
invoices with a review step first.

**Outstanding aging report zeros** — checked the code directly: it already shows blank
instead of ₹0 for every bucket. Your screenshot must be from a build before that was
in place — this round's package has it, no new change needed here.

**Rate history now hides ended/superseded rates by default** — same "Show
disabled" pattern already used for Customers and Sites, a checkbox reveals them when
you actually want to see the full history.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Sixty-first round — real bug: driver permanently stuck on supervised sites

Confirmed exactly from your screenshot: on a site with a Site Supervisor, "Plant In"
was gated on "Site Out" — but Site In/Site Out are entirely the Supervisor's own
confirmation, on their own timing, not something the driver can do or influence at
all. If the Supervisor was slow, busy, or simply hadn't gotten to it yet, the driver
had no way to ever close that trip out themselves — permanently stuck in "Older trips,"
which is exactly the original stuck-trip problem this whole feature was built to fix,
just arriving through a different door.

**Fixed**: "Plant In" now only requires "Site Out" first on a site with **no**
Supervisor (where the driver is the one logging Site Out themselves, so keeping their
own sequence honest still makes sense). On a supervised site, Plant In is tappable as
soon as Plant Out is logged — the driver reporting "I'm back at the plant" is true
regardless of what the site paperwork's status is. Fixed on both backend (the actual
permission check) and frontend (the button's visual lock state), so this should
immediately un-stick the two trips in your screenshot the next time that driver loads
the app — no data fix needed, `plant_out_at` is already recorded on both.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Sixty-second round — item 1 built, items 2-4 re-verified

### Item 1 — Upcoming orders on Manager Dashboard, done
New **"Upcoming orders"** section (anything scheduled beyond tomorrow, not yet
terminal) — same table component, same styling as Running Orders Today /
Scheduled tomorrow, not a separate read-only view like Admin's. Every order table
(today, tomorrow, upcoming, and carried-forward) now has an **Edit** button that jumps
directly into "Correct orders" with that specific order pre-opened for editing —
confirmed this correctly covers booking-converted orders too, since the underlying
`/administrator/orders` endpoint that "Correct orders" runs on has no filter that
excludes them by origin; there was never a separate code path to fix here, just a way
to reach it quickly from the dashboard.

### Item 3 — re-verified clean
Checked directly: zero references to the cross-check anywhere in
`ManagerDashboard.jsx` now, fully present and working on Administrator's Reports page.

### Item 4 — re-verified, one nuance worth knowing
Re-traced the duplicate-site merge logic end to end. It's correct, with one edge case
worth flagging rather than hiding: if both the duplicate and the canonical site
happened to each have their *own* currently-active rate for the same grade, merging
leaves two active-looking rate rows behind (the lookup logic still resolves
deterministically to one of them, so nothing breaks) — the other becomes redundant
and is worth manually ending via "End this rate" afterward. Not a bug, just something
to check when merging a pair that both had rates already.

### Item 2 — re-traced thoroughly, most likely explained by item 4
Went through the entire confirmation flow line by line and could not find a direct
bug in how the amount is computed, sent, or stored — the code is correct as written.
My strongest remaining explanation is that this was the same duplicate-site issue as
item 4: if a booking's site doesn't match the site a rate is actually configured
against, the lookup can fall through to an incomplete or legacy rate. Made the display
more robust regardless — a genuinely zero/unset rate now shows "not set" instead of a
number that could read as "00," so the confirmation screen can no longer *display*
something confusing even in that edge case. Given I can't fully confirm this without
live access to your data, **please re-test this specific flow after merging the
duplicate sites from item 4** and let me know if "00" still shows up — if it does
after that, it's a real, separate bug and I'll dig further with fresh evidence.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Sixty-third round — the real explanation for the rate mystery, plus items 1 & 3

### The actual rate-matching bug — found for real this time
"No duplicates found" ruled out last round's theory. Traced it properly this time by
comparing your two screenshots line by line: the recalculate tool only ever considers
tickets with `status = 'completed'` (correct — you shouldn't invoice a delivery that
hasn't been confirmed done). But the "Unbilled deliveries" diagnostic never checked
that at all — it only ever checked reasons on the **rate** side (missing, wrong site,
not yet effective, already ended), and fell back to a vague "worth a manual check"
whenever none of those applied. If a ticket is simply still sitting at an earlier
status because nobody's confirmed unloading complete for it yet — which is exactly the
kind of stuck-trip scenario fixed a couple of rounds ago — invoicing was never going to
happen regardless of whether the rate is perfect, and the diagnostic had no way to say
so. Fixed: it now checks ticket status first, and will tell you plainly which specific
deliveries are stuck rather than pointing at the rate.

**What this means for your two customers**: I'd bet this is why TS Projects' and PM
Kelukutty's deliveries are showing "worth a manual check" — the diagnostic couldn't see
this reason before. Redeploy this fix and check "Unbilled deliveries" again — it should
now tell you directly whether those specific tickets are stuck at an earlier status
(and if so, whoever's responsible for confirming that project's deliveries — driver on
a self-service site, or the Site Supervisor — needs to go close them out; nothing about
the rate needs fixing at all in that case).

### Item 1 — Upcoming orders now show date first
Both "Upcoming orders" and "carried forward" tables (the two that span multiple
different dates, unlike the single-day today/tomorrow tables) now show a Date column
first.

### Item 3 — moved to its own standalone page, not on any dashboard
New page at **Reports → More → "Trip time cross-check"** — reachable by a direct link,
not embedded in either Manager's or Administrator's main dashboard view anymore.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Sixty-fourth round — invoicing now matches how production is already counted

Real architecture change, not a report fix. Previously, an invoice was only created
once someone explicitly confirmed "unloading complete" — a delivery note sitting at
any earlier status didn't count as sales at all, no matter how long it sat there.
That's now changed to match the exact principle already used for production quantity:
**a delivery note is treated as invoiced and due for payment the moment it's
created** — pending is assumed accepted until it's explicitly rejected, not the
other way around.

- **Ticket creation** now generates the invoice immediately (if a rate is on file) —
  not at completion. Completion still tries too, as a safety net, for the rare case
  a rate didn't exist yet at creation but does by the time it's confirmed.
- **Rejection now reverses the invoice** — deletes it outright, which automatically
  removes it from the customer's outstanding total and from "Sales Today" if it was
  today's delivery, since those figures are computed by summing whatever invoices
  currently exist. Nothing else needed to change for that part — it falls out
  naturally from invoices no longer existing.
- **Cancelling a ticket** (Correct tickets) does the same reversal.
- **Safety rule preserved everywhere**: if a payment has already been recorded against
  an invoice, it's never silently reversed — flagged for Accountant to review by hand
  instead, same rule already used for every other money-touching correction in this
  app.
- **Correcting a ticket's quantity** now also corrects its invoice (if one exists and
  has no payment yet) — this matters more now that invoicing happens this early, since
  a quantity fix is much more likely to land after the invoice already exists.
- **"Recalculate deliveries"** updated to match — it used to only consider tickets
  that had reached `completed`; now it considers anything not cancelled or rejected,
  consistent with the new rule.

### What this does *not* do
This doesn't retroactively invoice tickets that already exist in an incomplete status
from before this change — the trigger only fires on new ticket creation, rejection, or
cancellation going forward. For any of the currently-stuck deliveries from the last
couple of rounds, once you confirm the correct rate is in place, run **"Recalculate
deliveries"** on that rate — it'll now correctly pick them up since it no longer
requires `completed` status.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Sixty-fifth round

### Item 1 — duplicate tickets in report
Confirmed DT-2352 exists once in Correct Tickets, and traced the report query end to
end — every join is primary-key based (customer, site, grade, truck, driver,
salesperson, pump, supervisor, QC, invoice all match on a unique key), so it
structurally cannot produce duplicate rows for one ticket. Also confirmed the PDF
generation code is a plain one-to-one map, no duplication logic there either.

**Important reassurance**: Sales Today, Sales Month, and Monthly Production Qty are
computed by entirely separate, simple `SUM()` queries straight off `delivery_tickets` —
none of the report's extra joins. Whatever is causing the report display issue, your
actual production and sales totals are not affected by it.

Applied a best-effort fix: `rowPageBreak: "avoid"` on the PDF table, since a row
rendered right at a page-break boundary is a known jsPDF-autotable edge case that can
make a row appear to repeat. If duplicates still show up after this, it's a different,
real bug and I'll need to dig further with fresh evidence — but I could not find one
through code review alone.

### Item 2 — Production Report on Manager Dashboard
Manager now has full access (was Administrator-only) — same report, not a limited
version. Also added two columns that were genuinely missing: **Part load charge**
(never added since part-load charges were introduced) and **Waiting charge** (see
below — now that it's a real feature, it belongs in this report). New link from
Manager Dashboard's More menu.

### Item 3 — Waiting/delay charge, made simple
No automatic time-based calculation — instead, a manual **"Apply delay charge"**
button now sits directly under the existing "over 2 hrs at site" alert on Active
Trucks. One click: computes hours past that same 2-hour free allowance (rounded up),
applies the rate's configured waiting-charge-per-hour, and adds it to the invoice.
Same payment-safety rule as everywhere else — blocked automatically if a payment's
already recorded.

**Honest note on what this replaces**: `waiting_charge` previously existed as a field
on every invoice but was hardcoded to 0 everywhere — the rate form let you set a
waiting-charge rate, but nothing ever computed or applied an actual charge from it.
This is the first time it does anything real.

### Item 4 — driver "stuck" trips (fix as you wish)
On a supervised site, once the driver logs Plant In, the trip now moves out of "needs
action" regardless of whether the Site Supervisor has confirmed Site In/Out yet —
there's nothing further for the driver to do, so leaving it in a list literally titled
"needs action" was actively misleading. Renamed that section to "Completed" and added
a date to any entry that isn't from today, since it can now include older trips whose
underlying ticket status is still pending confirmation from the Supervisor's side.

### Migration note
No schema changes — nothing new to apply via `/setup`.
