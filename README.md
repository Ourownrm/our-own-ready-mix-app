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

## Sixty-sixth round — two real, confirmed bugs found and fixed

### Report duplication — actual root cause found this time
Your list of duplicated DC numbers being all *recent* tickets was the key clue. Traced
it to `invoices.ticket_id` — declared `UNIQUE` in schema.sql, but that only ever gets
applied once, the very first time a database is provisioned. If this database was
first set up before that line existed, the constraint was never actually retrofitted
onto it — meaning duplicate invoice rows for the same ticket were structurally
possible all along, just rare, until last round added a second invoice-generation
trigger point and doubled the odds of it happening. The Production Report's join to
`invoices` then correctly (if confusingly) doubled that row.

Fixed with a migration that removes any duplicate invoice rows already there (keeping
the most recent one per ticket) and properly enforces the constraint going forward —
safe to run repeatedly, a no-op once clean. **Deploy and revisit `/setup?key=...`
once** — this is the fix, not optional this round.

### The "can't complete these trips" mystery — a real, confirmed bug
Found it in the Site Supervisor's own delivery list: it was filtered to
`ticket_date = CURRENT_DATE` — meaning any delivery not confirmed complete by the end
of its day **silently disappeared from the Supervisor's own dashboard** the moment the
date rolled over, even though it was still fully pending. This is the exact same
stuck-trip bug already fixed for drivers several rounds back, just never fixed on the
Supervisor's side. Neither the driver nor the Supervisor were able to complete those
trips because the Supervisor's list never showed them once the day passed — not an
operational gap, a real bug. Fixed the same way: shows every delivery still awaiting
confirmation regardless of date, with the date now shown when multiple are queued.

### Sales Executive can now create customers and sites
Two new endpoints, deliberately minimal (name only for a customer; name + optional
distance for a site) — enough to send a booking for a genuinely new lead without
waiting on Manager/Admin. Auto-assigns the Sales Executive themselves as the site's
salesperson. Carries the same duplicate-site warning built a few rounds back, since
this is a separate code path that would otherwise bypass it entirely.

### Manager Dashboard — order statuses now have distinct colors
Previously several different statuses (in_progress, partially_completed, dispatched)
shared the same badge color and were visually indistinguishable. Each of the 6 order
statuses now gets its own: planned (grey), in progress (blue), partially completed
(amber), completed (green), closed (violet), cancelled (red).

### Migration note
Revisit `/setup?key=...` once after deploying — this round's invoice dedup fix is the
important one.

## Sixty-seventh round — fixed the dedup migration that crashed on deploy

Last round's invoice-dedup migration blindly deleted every duplicate except the most
recent per ticket, without checking whether one of the *other* duplicates already had
a payment recorded against it specifically — Postgres correctly refused that delete,
which is the exact error you hit.

**No data was harmed** — since that was a single SQL statement, Postgres guaranteed
it either fully applied or not at all, and it didn't, so your duplicate invoices are
still sitting there untouched, exactly as before.

Fixed properly this time: the migration now picks a keeper per duplicate group
(preferring whichever one already has a payment against it, since that's the real
one), reassigns any payments from the others onto that keeper first, and only then
deletes the now-safe-to-remove duplicates.

### Migration note
Revisit `/setup?key=...` again — this is the actual fix for last round's crash.

## Sixty-eighth round

### Site Supervisor — real bug fixed, screen redesigned
Found the exact issue from your screenshot: the "Confirm unloading completion" button
had no click handler at all — it just looked enabled and did nothing. The real
completion action was entirely in the form below it ("Save completion"), but nothing
told the Supervisor that. Removed the dead button and rebuilt the three stages as a
proper visual tracker — done/active/locked states, same visual language as the
driver app's stage tracker — plus a cleaner card treatment for the completion form
and a bigger, clearer save button.

### Site ready — hidden where it doesn't apply
"Scheduled tomorrow" and "Upcoming orders" no longer show a Site ready column —
confirming a site is ready to receive concrete only makes sense for today's orders.

### Manager Dashboard — each board now has its own color
Running Orders Today (green), Scheduled tomorrow (blue), Upcoming orders (violet),
and the carried-forward "needs attention" board (red) — a left-border accent and
matching title color on each, so they're distinguishable without reading every
heading.

### Pie charts, built (not mocked)
Salesman-wise sales and Pump utilization on Admin's dashboard are now pie charts
instead of tables, and Manager Dashboard has its own Pump utilization pie chart at
the bottom. No new dependency added — built as plain SVG, matching this app's
existing hand-rolled chart (the daily production bar chart already worked the same
way, no charting library was ever actually installed). Every slice's legend shows
both the quantity in m³ and the percentage together, for both charts.

**Found and fixed while building this**: pump utilization still required
`status = 'completed'` to count a delivery — left over from before round 64 changed
that philosophy everywhere else (a delivery counts once it exists, reduced only by
rejection). Fixed in both the Admin and new Manager versions.

### AI-assisted scheduling
Staying pending, as requested — the five ideas from last round are noted for later,
not built.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Sixty-ninth round — the fuel module, rebuilt from scratch

### Pie chart polish
Sales and pump utilization charts now use a monochromatic palette (shades of one hue
each, not a rainbow) — sales in blue, pump in teal. Pump utilization also now includes
a genuine "Without pump" slice — the query used to `INNER JOIN` pumps, silently
excluding every delivery that didn't use one at all.

### The fuel and lubricant module — full request/approve/issue workflow
This replaces the old self-logged fuel entry entirely, as confirmed.

- **New Store role** — the custodian who issues fuel and lubricants
- **Driver/operator requests**: fuel or lubricant, vehicle or machine, odometer or
  hour-meter reading (required — this is the field that matters most for the
  efficiency/anomaly analysis discussed earlier), quantity, and station (fuel) or
  lubricant type (multiple types, seeded with five common ones, Admin can add more)
- **Manager approves**: can adjust quantity and redirect to a different station before
  approving, or reject with a reason
- **Plant fills and all lubricants**: single-use QR code. The QR encodes a URL, not an
  in-app scanner — Store's own phone camera app opens it directly. Details stay hidden
  until that link is actually opened; the QR vanishes from the driver's screen the
  moment Store confirms issuance, and the same link can never be reused after that —
  enforced server-side, not just visually
- **External station fills**: a shareable slip instead of a QR, using the device's
  native share sheet (WhatsApp, SMS, or the station just photographing the driver's
  screen) — replaces the printed paper slip entirely
- **Store confirms actual quantity issued** (and cost, for fuel) — this is deliberately
  a separate field from the approved quantity, so a mismatch between the two becomes a
  real, visible signal rather than something that has to be inferred later

### What's genuinely still missing
- **Accountant's fuel cost view is a placeholder only** — the old self-log history
  report is gone (it was tied to the old flow) and I haven't yet built real reporting
  on top of `supply_requests`. Worth a dedicated round.
- **Store's home screen is minimal** — instructions plus a manual link-paste fallback,
  no dashboard of recent activity yet.
- The efficiency/anomaly analysis discussed earlier isn't built yet — this round was
  the data-capture foundation for it, not the analysis itself.

### Migration note
Revisit `/setup?key=...` once after deploying — adds the Store role, `is_plant` on fuel
stations, `lubricant_types`, and the new `supply_requests` table.

## Sixty-ninth round — pie chart refinements, and one real gap closed

### Pie charts
Sales and Pump utilization charts now use a monochromatic color scheme (shades of one
hue per chart) instead of a rainbow of distinct colors. Pump utilization also now
includes deliveries that used no pump at all as their own "Without pump" slice —
previously excluded entirely by an inner join, so the chart only ever showed pump-
assisted deliveries and silently left out the rest.

### Found while reviewing last round's fuel module build
Checked the whole feature end to end before packaging. Everything from last round —
driver request flow, Manager approvals, Store's scan/issue screens, routing, role
setup — was already correctly built and wired. Two real gaps found and closed:
- **No way to manage lubricant types beyond the five seeded defaults** — Admin now has
  a proper add/deactivate panel under Fuel stations and equipment, matching the
  pattern already used for stations and equipment there.
- Confirmed `store` role selection, `ROLE_HOME`, and the Manager Dashboard link to the
  approval queue were all already correctly in place — no gap there after all.

### Migration note
No new schema changes this round beyond what was already noted for the fuel module —
if you haven't run `/setup?key=...` since that round, do it now.

## Seventieth round — fixed the QR scan bug, plus three requested additions

### The actual bug behind "scan works but shows not found"
Traced it precisely: scanning with the phone's own camera app opened the link in a
**fresh, logged-out browser tab** — a completely separate session from the app.
`ProtectedRoute` correctly sent that to login, but never remembered where the user was
trying to go, so after logging in they landed on the generic Store home page and the
token was silently lost. Not a flaky scan — a structural gap in how deep links and
auth redirects interacted.

**Fixed by building a real in-app scanner** — new `jsqr`-based component that reads
the camera feed directly inside the already-authenticated app. No URL, no browser
switch, no login redirect to lose anything on. The QR itself is simpler now too — it
just encodes the raw token, not a full link.

### Fuel and lubricant requests — now a real dashboard card
Pulled out of the buried "More" menu — Manager Dashboard's main view now shows a card
with the pending count, same visual weight as Active trucks and the other cards there.

### Shareable slip is now an actual image
`navigator.share({text})` only ever shared plain words, which is why WhatsApp showed
just text. Now uses `html2canvas` to capture the styled slip as a real PNG and shares
that file — falls back to downloading the image directly if the browser doesn't
support sharing files, with a clear note about why.

### Manager can now clear a pending request outright
Distinct from Reject (which keeps a record and notifies the requester with a reason) —
Clear just removes it, for duplicate or mistaken requests that don't need either.

### New dependencies
`jsqr` (QR decoding) and `html2canvas` (image capture for the slip) — both lightweight,
both loaded only when their specific feature is used (same lazy-loading pattern
already used for `jspdf`/`xlsx`), not bundled into the main app load.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Seventy-first round — iPhone scanner fix

"Camera shows, nothing happens" pointed at the scan loop never actually starting,
despite the video feed working fine (that's just `getUserMedia`, unrelated to
whether decoding runs). Two likely causes, fixed together rather than guessing at one:

- **jsQR was dynamically imported** (`await import("jsqr")`) — if that import silently
  failed or hung on a given mobile browser, the scan loop that depends on it would
  never start, with no visible error. Switched to a static import, which removes this
  failure mode entirely.
- **The frame-readiness check was too strict** — it required `video.readyState ===
  HAVE_ENOUGH_DATA` before reading a frame, but readiness reporting is inconsistent
  enough across mobile browsers that this can stall indefinitely even while the video
  is visibly playing. Now checks `video.videoWidth > 0` instead — more permissive, and
  the actual signal that matters (a real frame is available to read).

Also added a visible "still looking" hint if nothing decodes within 8 seconds, so a
genuine problem is never silent — it now suggests falling back to manual code entry
rather than leaving someone staring at a camera feed with no feedback.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Seventy-second round — slip anti-duplication, fuel report, and a real gap closed

### Approval slip — refined per feedback
Removed the validity window. Reference number is now the largest element on the
slip and on the plant/QR card — it's what filling stations will note on their
invoices for reconciliation, so it needed to be unmissable. Station name, vehicle,
and quantity are all larger too; driver name and the repeated security band stay as
they were. Also added your actual logo as a faint tiled watermark (saved as a real
static asset at `/logo.jpg`, not inlined into the source), and date/time is now
prominent near the top of the slip, not buried in a table row.

### New: fuel and lubricant report
Filterable by date range, type, and status, with PDF and Excel export — same pattern
as the Production Report. Reachable from Manager Dashboard's More menu, Accountant's
dashboard, and directly from the old fuel-cost placeholder page (which now just links
here instead of being a dead end).

### Real gap found and fixed: external fills had no way to ever complete
Traced this directly from your question about how the system records an external
fill. It didn't — Store confirms plant fills via the QR scan, but Store never sees an
external request at all, so there was genuinely no code path that could ever move an
external fuel request past "approved." It would have sat there forever. Fixed by
letting the driver — the only person actually at the pump — confirm their own
external fill with the real quantity and cost, once they have it. Plant fills and
all lubricants (always internal) still go through Store exclusively; the new
confirmation path is blocked for both, matching the same logic already used to
decide which card to show on the driver's screen.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Seventy-third round — the actual root cause of the whole rate-matching saga

### 1. Found it: order creation's site dropdown was never filtered by customer
This is what caused every "duplicate site" incident across many rounds. The site
dropdown on order creation listed **every site from every customer**, unfiltered —
nothing stopped Manager from picking a site that had nothing to do with the selected
customer, or from not noticing a customer already had a site under a slightly
different-looking entry. Confirmed from your screenshot: the dropdown showed dozens of
unrelated sites (Ananthapuram Factory, ARAMANAPADI, Chengala...) with zero connection
to whichever customer was selected. Every other site dropdown in this app (rates,
booking conversion) was already correctly filtered — this was the one gap. Fixed:
site dropdown now only shows the selected customer's own sites, disabled until a
customer is chosen.

**For your current stuck case**: use "Check for duplicate sites" (Projects and sites)
to merge the two "Chattanchal" entries for ARS JASMIN into one, then re-run
Recalculate.

### 2. Pump charge lost when a rate is added after the order already existed
Real bug, confirmed. If an order was created before any rate existed, the pump-charge
confirmation had nothing to show a real number against — Manager could still confirm
"applicable," but the amount stored was 0, since there was nothing to reference. When
a rate was added later, Recalculate deliberately left `pump_charge_amount` untouched
(correctly protecting a *meaningful* confirmed decision) — except this zero was never
a meaningful decision, just what happens when there's no rate to reference yet. Fixed:
Recalculate now checks for exactly this case — confirmed applicable, but a zero
amount — and uses the newly-added rate's real pump/part-load charge instead of
perpetuating a number that was never real.

### 3. Waiting charge added after an invoice already exists — now notifies Accountant
"Apply delay charge" already updated the invoice directly (which is what feeds the
customer's outstanding balance — no separate step needed there). What was missing was
visibility: Accountant now gets a clear notification whenever this happens, since the
customer may already have an earlier total in hand before the charge was added.

### 4. Tomorrow's orders no longer double-listed
A date-only string parsed under IST's +5:30 offset could land just inside "tomorrow"
even when compared against tomorrow's boundary — causing a tomorrow-dated order to
show in both "Scheduled tomorrow" and "Upcoming orders." Fixed with an explicit
same-day exclusion instead of relying on the raw timestamp comparison alone.

### 5. New: Driver trip allowance report
Per-trip detail (date, driver, truck, customer, site, quantity, allowance), filterable
by date range and driver, with PDF/Excel export — same pattern as the other reports.
Reachable from Manager Dashboard and Accountant's dashboard.

### 6. Compliance register — sortable, expiry date still the default
Added a sort control: Expiry date (default, unchanged) or Vehicle/asset number.

### Still pending, as requested
Mockups for the three AI-assistant ideas (site-visit follow-up questions, scheduling
assistant, fuel module analysis) — queued for next round now that these six are done.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Seventy-fourth round — sales module frontend, and the actual site-mismatch fix

### The real bug behind the whole rate-matching saga — found and fixed
Not the same-customer duplicate checker built earlier — this is different. Built a
direct diagnostic for orders whose `site_id` points to a site belonging to a
**different customer entirely**: `Check for wrong-customer orders` on the Sites
screen. Lists every broken order with enough context (date, ticket count, which
customer the site actually belongs to) and lets you reassign each one to the correct
site from that customer's own list — only touches that one order, nothing else. This
was possible before order creation's site dropdown was filtered by customer (fixed a
couple rounds back); this tool finds and repairs whatever's still broken from before
that fix existed.

### Sales visit module — fully rebuilt
The whole flow from our mockup sessions, built for real: customer/site selection,
whom you met, their role, mandatory contact number, at-site toggle with automatic GPS,
an explicit new-vs-existing-project choice (no auto-detection), the full 13/7 tap-only
question sets with multi-select where it matters (concerns, grades, issues) and the
conditional competitor-experience question, a comments field, and strict validation —
every question is required, and the warning names exactly which ones are missing with
a tap-to-jump link, not a generic "please complete the form."

Follow-ups generate automatically from the answer combinations (not any single
answer in isolation) with real due dates, and route beyond Sales Executive when the
action genuinely isn't theirs — owners' meetings and serious complaints go to
Manager, overdue payments go to Accountant. Immediate push for anything due today or
tomorrow, plus a daily digest for anything still pending, so nothing goes stale
silently. New "Follow-ups due" card — overdue, today, and upcoming — now on Sales
Executive's, Manager's, and Accountant's dashboards, each showing only what's
assigned to them.

### Migration note
Revisit `/setup?key=...` once after deploying — this round adds the visit module's
new fields and the follow-ups table.

## Seventy-fifth round

### Confirmed: the site-mismatch tool fixed the live duplication issue
Great to hear — that confirms the diagnostic found and fixed the actual root cause,
not just a related symptom.

### Sales — Follow-ups due moved to the dashboard tab, first thing shown
Moved off the Visits tab entirely. Also grouped by date + customer now, so several
follow-ups from the same visit show as one header with the individual items listed
underneath, instead of repeating the date and customer name on every line.

### Manager Dashboard — pump status redesigned to the 5-state model
En route (pump departed) → Ready for pumping (site confirmed ready — this single
state now covers both "just became ready" and "between trucks," since the pump's
sitting ready at site either way) → Pumping (truck actively unloading) → Completed.
Overdue kept as a separate pre-departure alert, since it's a different kind of signal
(a delay warning, not a lifecycle stage) than the other four. Also fixed a related
gap while at it — completed orders were being filtered out of this table
*before* the status logic ever ran, so "Completed" could never actually display;
today's just-finished pump orders now stay visible long enough to show it, without
older completed orders cluttering the table.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Seventy-sixth round — delay justification report, and menu reorganization

### New: Delay justification report
Consolidates four different delay signals that each lived in a different place —
pump departure, site-ready confirmation timing, batching-not-started alerts, and
trucks over 2 hours at site — into one report, each with planned vs actual time,
the reason, who recorded it, and when. PDF and Excel export.

**Real gaps found and closed while building this**: the pump departure and
site-ready delay reasons had no "who entered this" tracking at all — just the
reason text, no accountability trail. The at-site-over-2-hours alert had *no*
reason mechanism whatsoever — it was purely a live computed display with nothing
persisted. Added who/when tracking to the first two, and a genuinely new "Add
reason" capability for the third, directly on Active Trucks.

### Menu reorganization — Admin and Manager
Both dashboards now use four dropdown menus — Reports, Masters, Sales, Manage —
via a new reusable `GroupedMenu` component, replacing the flat button rows. Admin
sees everything (including "Assign a Lead," which had backend access but no UI path
before now); Manager sees only what they actually have access to: all of Reports
(confirmed Manager already had route access to every item, just no link to some of
them), Masters limited to Customer/Sites/Rates (Trucks, Salespersons, and Fuel
Stations stay Admin-only, since Manager never had UI access to those and this round
didn't grant new access), all of Sales except Sales Performance (Admin-only), and
both Manage items.

### Migration note
Revisit `/setup?key=...` once after deploying — new who/when tracking columns for
the delay report.

## Seventy-seventh round — fixing last round's menu rollout, and report refinements

### Item 1 — Manager's Delay justification report access
Checked all three layers (frontend route, backend endpoint, menu link) — all three
already correctly include Manager. The screenshots were from before this round's
build had deployed; nothing to fix here, it was already right.

### Item 2 — the actual root cause of the confusing double menu
`/reports` — the real landing page for Admin (`ROLE_HOME.administrator`) — still had
its old flat "More/Less" menu, since last round I only reorganized `/administrator`'s
navigation, not this page's. That's what created the two-tier confusion: Admin lands
on `/reports` with the old menu, then has to click through "Manage users..." to reach
`/administrator`'s new menu. Fixed by giving `/reports` the exact same four grouped
menus, with Masters/Manage items deep-linking straight to the right Administrator
tab via a URL parameter (`/administrator?view=customers`) instead of dropping the
user on the generic Users and Roles tab every time.

### Item 3 — Delay type filter
Added a dropdown: All, or any one of the four delay types specifically.

### Item 4 — Ignore delays under 5 minutes
Applies to Pump departure and Site ready — the two types with a clean "how many
minutes late" figure. Defaults to 5, adjustable. Batching-not-started and the
at-site alert are unaffected by this filter, since neither has a meaningful minutes-
late number to threshold against — noted directly in the report's own description
so it's not a silent gap.

### Item 5 — verified, and fixed a real gap
Traced every place these reason fields get written. Site Supervisor has their own
endpoints for pump-departure and site-ready delay reasons — confirmed real, and
confirmed they were writing to the same columns the report reads, so the reason text
itself was always showing correctly. What wasn't: Site Supervisor's entries never
set the who/when tracking columns added two rounds ago, so their reasons appeared in
the report with no attribution. Fixed both endpoints to set them, matching the
Manager/Admin-facing ones.

### Migration note
No new schema changes this round — if you've already run `/setup?key=...` since the
delay-report round, nothing further needed.

## Seventy-eighth round — Charts (pivot-style analysis), and four fixes

### New: Charts — operations performance analysis
Genuinely pivot-style, not four fixed reports bolted together — one flexible
backend endpoint takes any metric (transit time, unloading time, turnaround) crossed
with any group-by dimension (site, truck, mix grade, driver, day of week), filtered
by specific trucks/sites/grades and any date range. Tap a bar to drill into the
individual trips behind that average. A separate scatter view plots unloading time
against quantity delivered, since quantity doesn't fit the group-by model. Added to
the Reports menu everywhere it appears.

### 1. Version number in the header
Every screen now shows "Ver. X.X" next to the app name — directly so everyone can
confirm at a glance whether their browser is actually on the latest build, since a
PWA's service worker can otherwise keep an already-open tab on a stale bundle even
after a new deploy is live on the server.

### 2. Time added after DC number in Production Report
Shown in the PDF, Excel export, and on-screen table.

### 3. Pump status — Completed now reflects the Site Supervisor's own signal
Found the real gap: Site Supervisor has their own "work completed" flag, separate
from the order's official status, which only flips to completed once Manager
explicitly confirms it separately. Pump Status previously only checked the official
status, so a site the Supervisor had already marked done could still show "Ready for
pumping" while waiting on Manager's confirmation. Fixed to treat the Supervisor's
signal as Completed too.

### 4. Fuel/lubricant approval push — reviewed, and a safety net added
Traced the push code fully — structurally correct, sends to every Manager device
with notifications enabled. Most likely explanation for a missed alert: that Manager
never granted push permission (the request wasn't actually lost — it was always
showing on the dashboard card and Supply Approvals count). Added a safety-net digest
regardless: any request still pending after 15 minutes now gets a follow-up push,
so a missed first notification doesn't mean the request goes unseen.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Seventy-ninth round (App 92 / Ver. 9.2)

### Found the exact cause of the delay-report duplication
`checkBatchingNotStarted` inserts three separate notification rows per order — one
each for Manager, Administrator, and (if assigned) Site Supervisor. The delay report
joined on all notifications of that type without filtering by recipient, so it
picked up all three per order. Matches exactly what you saw: orders with a site
supervisor assigned showed 3 duplicate rows, the one without showed 2. Fixed by
filtering the report's query to the manager-role notification only. The Pump
departure "duplicates" in the same PDF were not a bug — two genuinely separate
orders for the same customer and site that morning, a minute apart.

### Charts drill-down now shows customer name
Added to both the drill-down detail table and the scatter view's tooltip.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Eightieth round (App 93 / Ver. 9.3) — the actual cause of the false "no signal" errors

### Found it: real errors were being misdiagnosed as connectivity problems
`queuedRequest`'s catch block treated *any* failure — a genuine network outage or a
real HTTP error response (validation failure, expired session, server error) — as
"offline, queue it for later." Since the same request retried later would fail for
the exact same reason every time, this is exactly why items sat stuck "waiting to
sync" forever even with a fine connection: they were never network problems in the
first place.

Fixed at the source: `apiRequest` already distinguishes these (a real HTTP response
carries `err.status`; a request that never reached the server doesn't). Only the
latter now gets queued — a real error is thrown immediately and shown to the person,
the same turn they hit it, instead of being hidden behind a misleading "no signal"
message.

Also fixed `flushQueue` the same way — an item that fails with a real error now moves
to a separate "couldn't be saved" list (visible with a Dismiss option) instead of
being retried forever alongside genuinely queued items.

**While tracing every call site**: found two more real gaps — `toggleDuty` (both
Sales Executive and Driver) and Site Supervisor's `act()` had no error handling
around `queuedRequest` at all, meaning a real failure would previously vanish as an
unhandled promise rejection with the UI still optimistically showing success. All
three now show the actual error and correctly revert the optimistic UI state.
`RejectForm` had the same gap and could get stuck on "Saving..." forever on a real
error — fixed the same way.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Eighty-first round (App 94 / Ver. 9.4)

### Refresh button on every page
Added to the header, present everywhere `TopBar` is used — which is every page
except Login (no data to refresh there) and CreateOrder (an embedded view inside
Manager Dashboard, which already has its own header). Does more than a plain
reload: it first asks the service worker to check for a newer version before
reloading, so a tap here actually has a real chance of picking up the latest
deploy — not just re-running whatever was already cached.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Eighty-second round (App 95 / Ver. 9.5) — two real bugs, one of them pre-existing

### Refresh button caused a 404 and looked like a logout — traced to a pre-existing gap
Not a bug in the button itself. This app never had a rewrite rule telling Render's
static hosting to serve `index.html` for every route — direct navigation to any
sub-page (a bookmark, a hard refresh, or now the Refresh button) has always 404'd
at the server level, bypassing the React app entirely. A bare 404 page has no access
to the stored login token, which is why it looked like a logout on top of "not
found" — it wasn't logging anyone out, the real app just never loaded. Added the
missing `_redirects` file (`/* /index.html 200`) — this fixes the Refresh button and
also every other case of direct sub-route navigation that was silently broken before.

### The delivery note confusion — confirmed, and it's a labeling bug, not a data bug
Traced it exactly: two separate, correctly-tracked orders for the same customer,
site, and mix grade rendered as **visually identical entries** in Plant Operator's
order dropdown — no scheduled time, no distinguishing detail at all. The system was
never picking the wrong order; there was just no way to tell them apart before
picking one. Fixed by adding the scheduled batching time to each entry, and a clear
"site not confirmed ready yet" warning that appears the moment an order is selected
— not only after attempting to submit and getting an error.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Eighty-third round (App 96 / Ver. 9.6)

### Correcting last round's mistake on the Refresh button fix
I was wrong — Render doesn't read a `_redirects` file the way Netlify does; that
file did nothing. Confirmed directly from Render's own documentation: static site
rewrites are configured exclusively through the Render Dashboard, not from a file in
the repo. Removed the useless file. **This one needs your action, not mine** — see
below, I can't configure this myself.

**What you need to do**: in the Render Dashboard, open the `oorm-frontend` static
site → **Redirects/Rewrites** → add a rule:
- Source: `/*`
- Destination: `/index.html`
- Action: **Rewrite** (not Redirect)

This fixes the Refresh button, and also every other case of direct sub-route
navigation (bookmarks, browser refresh) that's been silently broken the whole time.

### Order # added everywhere orders are shown
Site Supervisor's cards, Plant Operator's dropdown (and its selected-order summary),
Manager Dashboard's main order table and Pump Status table, and the order detail
modal — all now show a clear "Order #<id>" tag. Directly closes the ambiguity from
last round: two orders for the same customer, site, and grade are now unmistakably
different at a glance, not just distinguishable by reading the scheduled time
carefully.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Eighty-fourth round (App 97 / Ver. 9.7) — clarified driver stage tracker

This was working as designed, not a bug — clarified the messaging since it wasn't
landing clearly enough. cherkala has a Site Supervisor assigned, so Site In and
Site Out are their responsibility, not the driver's — the driver only handles Plant
Out and Plant In on a supervised site. It's genuinely linked: once the Supervisor
taps their own confirmation, the same underlying timestamp populates here too and
the driver's tracker updates automatically, no separate driver action needed.

Made this explicit rather than implied: the explanation box is now more visible,
names the actual Site Supervisor assigned to the project, and says plainly that
Site In/Out will fill in on their own — nothing for the driver to do until Plant In.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Eighty-fifth round (App 98 / Ver. 9.8)

1. Admin now has direct access to the Sales Executive dashboard, with a menu entry in both Reports.jsx and Administrator.jsx's Sales group.
2. Quick-add customer/site restored in the newer visit form — present in the booking flow the whole time, just missing from the visit form rebuild.
3. My Leads now shows who sent each lead and when — the data already existed, this was a frontend display gap only.
4-6. Pump Status and Site Ready merged into one unified "Site Status" column — Pump delayed, Pump en route, Ready for pumping, Pumping, Completed — with the site-ready time shown directly, now on both the dedicated status table and Running Orders Today.
7. Store now has access to the Fuel and Lubricant report.
8. Unbilled deliveries now shown on Accountant's dashboard.
9. Collected Today replaced with Collected Yesterday — same-day collection figures were rarely meaningful; a full prior day's total is actually settled.
10. Batching-not-started now triggers 12 minutes after site-ready confirmation, matching the exact threshold already used on Plant Operator's own screen — not from scheduled time, and never before site is actually ready.
11. Plant Operator can now record their own reason for a batching delay, which the delay justification report shows instead of Manager's after-the-fact response.

**Also found while checking the booking-conversion flow**: it already correctly captures pump requirement, the specific pump unit, and site supervisor — but was missing the separate "assigned pump crew" text field that order creation has always had. Backend already supported it end-to-end; only the form itself was missing the input.

### Migration note
Revisit `/setup?key=...` once after deploying — new columns for Plant Operator's batching delay reason.

## Eighty-sixth round (App 99 / Ver. 9.9)

### New: Cycle Time Report (Gantt)
Built for real, matching the confirmed mockup — each trip as one row, DN/truck/driver/
quantity flowing directly into a colorful zoomable, scrollable timeline (QC checks,
transit to site, waiting at site, unloading), each segment labeled with its duration
in minutes. Filterable by customer, site, and date range; sortable by DN or truck.
An in-progress trip shows its current open phase as a dashed, lighter segment
extending to now. Added to the Reports menu everywhere it appears (Reports.jsx,
Administrator.jsx, ManagerDashboard.jsx).

Phase boundaries use the trip_events already recorded for every delivery — QC checks
runs from ticket creation to Plant Out (confirmed this is genuinely when the plant-
side QC check happens), transit is Plant Out to Site In, waiting is Site In to
Unloading Started (a real, separately-tracked event, distinct from Site In), and
unloading is Unloading Started to Unloading Completed.

### Compliance alerts — confirmed fixed
Verified directly: the dashboard card's own endpoint was the only place with the
overly tight 7-day cutoff (fixed last round) — the register page and the scheduled
push notifications were already correctly using a 30-day window. Also split the
dashboard card into three distinct buckets (Expired / Expiring within 7 days /
Expiring within 30 days) instead of two, since lumping everything past a week into
one label would have been confusing once the window widened.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Eighty-seventh round (App 100 / Ver. 9.10) — two Cycle Time Report fixes

### The big gap before the chart
The timeline was anchored to midnight of the "From" date, but trips typically start
hours after that — so every row's track began with hours of dead, empty space before
the first bar, and the actual bars only appeared after scrolling far to the right.
Fixed by anchoring the timeline to the earliest actual event across the whole result
set instead (rounded down to a clean 10-minute mark), so the first bar starts right
at the beginning of the visible track.

### Frozen columns
DN, Truck, Driver, and Qty now stay pinned in place while only the timeline itself
scrolls horizontally — previously the whole row scrolled together, so the labels
disappeared off-screen the moment you scrolled the chart.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Eighty-eighth round (App 101 / Ver. 9.11)

### The real root cause behind the whole Accountant/Manager reports problem
`reports.js` had a router-level `requireRole("administrator")` applied before every
individual route — silently overriding each route's own, correctly-written role list
underneath it. This meant Manager has never actually been able to reach Delay
Justification, Charts, or Cycle Time Report despite the menu and route code being
right the whole time, and Accountant's `director-dashboard` call (added for unbilled
deliveries) was 403ing — which broke their entire dashboard's `Promise.all`, so
nothing loaded at all. Fixed by removing the blanket rule and giving each route
(`director-dashboard`, `daily-production`) its own explicit, correct role list.
Item 1 (Manager access to all reports) turned out to need zero menu changes — it was
purely this backend fix.

Also fixed while in there: removed a dead-end "Fuel filling" link from Accountant's
dashboard (it led to a placeholder that just pointed back to the report they already
have a direct link to), and cleared a shared error state when entering Rates so a
stale error from elsewhere on the page can't wrongly appear there too.

**What "Follow-ups Due" is, for anyone wondering**: it's not a bug — sales visits can
generate follow-up tasks routed to whichever role actually needs to act (an overdue
payment goes to Accountant, an owners' meeting request goes to Manager). Accountant's
dashboard only ever shows follow-ups actually assigned to them.

### Site Supervisor and Plant Operator now see the Delay Justification Report
Both roles added to the report's access, with a visible link on each of their own
dashboards — the idea being that awareness of delays is what drives the improvement
in the first place.

### Multi-Sales-Executive support
Admin's Sales Executive Dashboard was showing Admin's own (always empty) data, with
no way to pick whose dashboard to actually view. Added a "Viewing as" selector, shown
only for Admin, listing every active Sales Executive — selecting one now correctly
loads that person's own stats, duty status, and follow-ups (all three previously
scoped to whoever's logged in, which was meaningless for Admin specifically).

### Order # added to Production Report
Backend query, PDF, Excel, and on-screen table.

### Migration note
No schema changes this round — nothing new to apply via `/setup`.

## Eighty-ninth round (App 102 / Ver. 9.12)

### Shareable Site Visit Report — built for real
Same pattern as the fuel approval slip (html2canvas image + native share sheet),
now colorful: an orange header band, a blue/green pill for New vs Existing project,
and each visit-summary value shown as its own color-coded pill (green for positive
signals, red for negative, amber for uncertain, blue neutral) — not just plain text.
An amber callout appears only when a technical visit or owners' meeting was actually
requested. "Share report" toggle added to each visit card on Sales Executive's own
Visits list.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Ninetieth round (App 103 / Ver. 9.13)

### Notification fixes
Manager's "shows twice" traced exactly: the "Arrange owners' meeting" follow-up task
already routes to Manager and shows on their Follow-ups Due — the notification I'd
added last round was showing the same information a second time via a different
widget. Removed the redundant persisted notification for Manager on owners_meeting
specifically (the immediate push still fires); kept both for Administrator, who has
no other visibility into this at all. Separately, Admin's "not showing" turned out to
mean not noticing — Manager's dashboard has an unread-count badge next to
Notifications, Admin's didn't. Added the same badge to Admin's dashboard.

### New: Outstanding Collection report
Extracted from the inline aging table on Admin's Director's Dashboard into its own
report — colorful (orange header, color-coded aging-bucket pills matching the visit
report's pattern), with a bolded total row at the bottom, PDF and Excel export. Kept
the "Total outstanding" KPI card on the dashboard as agreed, now linking through to
the full report. Shared with Accountant, with a direct link on their own dashboard
since they don't use the same Reports menu structure as Admin/Manager.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Ninety-first round (App 104 / Ver. 9.14)

### Geofence-based arrival/departure hints — additive, never replacing manual confirmation
Built out the design discussed and approved last round: when a Site Supervisor taps
Site Ready, their device's own location (captured 99.9% of the time actually standing
at site) is saved as a fresher geofence anchor than the site's own saved coordinate.
If that tap location is implausibly far (>500m) from the site's saved point, it's
still recorded but flagged suspect, and the geofence check quietly falls back to the
site's own coordinate instead of trusting a reading that's probably wrong. A new
admin-managed Plant Location (Administrator → Masters → Plant Location, with a
"use my current location" button) gives the same treatment to the plant end.

A scheduled check (every 5 minutes, alongside the existing delay/compliance checks)
compares each active trip's last two GPS pings against these geofence anchors and, on
a consistent in/out transition, writes a `geofence_events` row and a nudge
notification — never a `trip_events` row, never a `delivery_tickets.status` change.
Drivers see "Looks like you left/reached the plant — tap to confirm" banners on their
trip card; Site Supervisors see the equivalent for site arrival/departure. Every hint
disappears the instant the real stage is confirmed for real, and nothing here alters
the invoicing, trip-allowance, or stage-gating logic those confirmations already
drive — this is a suggestion layer sitting entirely alongside the existing
human-confirms system, exactly as scoped.

### Sales visit — customer-name linking made a real, working screen
The gap flagged last round (a new prospect's name gets typed in on the spot, and
later never gets tied back to the real customer once one is created) now has an
actual fix. The visit form's customer field is a live-filtered suggestion list as you
type, with "+ New customer" and a fallback "browse full list" toggle — but the bigger
piece is Sales Performance's new "Unlinked visit names" panel: every distinct
unmatched name across all visits, with visit count, last contact, and a one-tap
"link to customer" that retroactively updates every visit under that name at once.

### Visit follow-up outcome — Won / Lost / Closed
Follow-Ups Due now carries a Won/Lost/Closed picker per visit. Lost and Closed
require a reason, pulled from a new admin-managed list (seeded with Lost to
competitor / Lost on price / Not interested, and Project delayed / Project cancelled
/ Budget not approved) — optional notes on top. Marking an outcome closes out every
still-pending follow-up generated from that visit in one action, so a rep doesn't
have to hunt down and individually dismiss three related tasks.

### Customer tracking link — mockup, then the real thing, plus admin control
Built the mockup first (order header, live progress bar, per-truck stage cards) to
confirm the shape before coding. The real page is a public, unauthenticated
`/track/:token` route — the token itself is the entire access boundary, no login, no
listing, so one customer's link can never expose a second order or a second
customer's data. Manager/Administrator get a panel on the order detail view to
generate, share (native share sheet with clipboard/prompt fallback), or revoke the
link. Per this round's request: generating a new link automatically revokes whatever
link came before it for that order, so a link accidentally sent to the wrong person
is neutralized the moment a fresh one is issued — no separate "revoke" step required,
though a manual revoke button exists too. Links also stay valid for 3 hours after the
order is closed/completed/cancelled (a new `terminal_at` timestamp drives this), so a
customer checking shortly after delivery isn't staring at a dead link. Past that
window — or on a revoked link — the page shows a plain, contact-us message rather
than an error.

### Migration note
Run `/setup` after deploying. New tables: `plant_locations`, `geofence_events`,
`order_tracking_links`, `visit_outcome_reasons` (seeded with default Lost/Closed
reasons). New columns: `customer_orders.site_ready_latitude/longitude/location_suspect`
and `customer_orders.terminal_at`; `visit_followups.outcome/outcome_reason_id/
outcome_notes/outcome_by/outcome_at`. Also backfilled `schema.sql` itself, which had
drifted from what `/setup`'s migrations actually built on a live database — a fresh
install now correctly includes `visit_followups` and the full `customer_visits`
column set (`site_id`, `is_new_project`, `contact_number`, `answers`) without needing
`/setup` to patch it in afterward. None of this touches `trip_events`,
`delivery_tickets.status`, or any existing confirmation/invoicing logic — every new
column and table is additive.

## Ninety-second round (App 105 / Ver. 9.15) — Masters menu is duplicated three times, not one

### Fixed: "Plant Location (geofence)" missing from Masters on two of three screens
Round 91 added the new Plant Location menu entry to `Administrator.jsx` only. Turns out
the "Masters" dropdown isn't a single shared menu — it's copy-pasted separately into
`Administrator.jsx`, `Reports.jsx` (the Director's Dashboard — what most Admins actually
land on and use day to day), and `ManagerDashboard.jsx`. Missed updating the other two,
so anyone navigating from the Director's Dashboard (the common case) never saw the new
entry at all, no matter how hard the browser cache was cleared. Added it to `Reports.jsx`
too (links through to `/administrator?view=plant-locations`, same as its other Masters
entries do). Left it out of `ManagerDashboard.jsx` on purpose — that menu is already a
deliberately narrower subset (no Trucks and Pumps, no Sales Persons, no Fuel Stations
either), matching Plant Location being an Administrator-only screen on the backend.

Worth flagging for future rounds: any new Administrator-only menu item needs to be added
to all three copies (`Administrator.jsx`, `Reports.jsx`, and — only if it should be
Manager-visible — `ManagerDashboard.jsx`), not just the Administrator page itself.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Ninety-third round (App 106 / Ver. 9.16) — Delivery Challan PDF

### Added: printable Delivery Challan ("Gate Pass & Delivery Note")
Administrator → Correct Tickets now has a "Delivery Challan" button on every non-cancelled
ticket, generating an A4 PDF the driver can carry with the truck before it leaves the
plant. The layout, field set, fixed mix-design defaults, and the full Terms & Conditions
text all replicate the company's approved `OORM_DeliveryNote_V2.01.docx` template exactly
— confirmed with the business over a mock before this round's real implementation. All
data values render in blue, all labels stay black, matching the template's convention.
This is a pre-dispatch document by design: the Site Checks section (Time Arrived,
Workability, Pouring Completed At) and the customer's Received & Accepted signature are
left blank on the printed page for manual completion at site — nothing on this form is
collected electronically from the field.

Admin-only for now, per business decision (other roles may get access to this screen
later). Built with `frontend/src/lib/deliveryChallanPdf.js` using jsPDF's native vector
drawing API (not html2canvas), so the printed text stays crisp instead of rasterized. New
backend endpoint `GET /administrator/tickets/:id/challan` (`administrator` role only)
assembles every field the PDF needs in one call — nothing is stored or pre-rendered
server-side.

Two computed fields worth noting: Mix Code shows as "OR" + the mix grade name with no
space (e.g. grade "M30" → "ORM30"), and Method of Pouring reads "With Pump" whenever the
order's pump requirement isn't `without_pump`, otherwise "Direct" — both are derived at
print time, not stored. "Delivered Qty" on the form is the sum of every *other* ticket
already raised against the same order (this ticket's own load is reported separately as
"This Load"), and "Balance" is Ordered minus that Delivered figure minus This Load —
correct for a document that accompanies an outbound truck rather than a completed
delivery.

Also added a new "Specified Slump (mm)" field to Create Order (feeds the challan's
Workability field) — optional, distinct from the slump actually measured later at plant
QC or on site arrival.

### Migration note
Run `/setup` after deploying. Adds `customer_orders.specified_slump_mm` (nullable —
existing orders are unaffected; the challan just prints Workability blank for tickets
against orders that predate this column).

## Ninety-fourth round (App 107 / Ver. 9.17) — Delivery Challan polish

### Fixed: "Pump No." always blank on the printed challan
The challan's pump lookup joined `pumps` on `delivery_tickets.pump_id`, but the Plant
Operator's normal ticket-creation flow never sets that column — pump assignment lives
entirely on the order (`customer_orders.pump_id`), which is exactly where "Method of
Pouring" was already correctly reading its With Pump/Direct answer from. So every real
ticket showed "With Pump" next to a blank Pump No. Query now falls back to the order's
pump when the ticket doesn't have its own (`COALESCE(dt.pump_id, co.pump_id)`).

### Adjusted: layout and type-size feedback from the first real print
- Moved "Method of Pouring" up next to "Free Water/Cement Ratio" (both are known before
  dispatch) instead of leaving Free Water/Cement Ratio as a lone, mostly-blank full-width
  row — closes the dead space that left on the page.
- "This Load m³" now prints in bold — it's the one number a driver needs to find fastest.
- "Signed for and on behalf of Our Own Ready Mix" (and "Site Checks" alongside it) is
  noticeably larger now.
- Every blue data value across the form is larger for readability. Narrow cells (Site
  Contact, Pump No.) got a shrink-to-fit safety net so a long phone number can't silently
  truncate the way it briefly did in testing — it scales the font down just enough to fit
  instead.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Ninety-fifth round (App 108 / Ver. 9.18)

### Removed: Truck status KPI from Manager dashboard
The "At plant / Running / At site / Returning" row of tiles is gone from the Manager
dashboard, per request. The backend `fleet_status` stat this fed from is left in place
(harmless, unused) in case a future round wants to re-surface it differently.

### Added: Grade correction on an order, only before the first delivery ticket
Administrator/Manager → Manage → Correct Order can now change an order's Grade — but only
while no delivery ticket (DN) has been raised against it yet. Once the first ticket exists,
the grade shows as locked in the edit row instead of an editable dropdown, and the backend
rejects a grade change on that order outright even if attempted directly against the API.
Reasoning: once a DN exists it references the original grade — invoicing, QC records, and
the printed Delivery Challan all key off it, so changing the grade after the fact would
silently desync those records from what was actually batched and delivered.

### Added: Issued quantity control on Store's fuel/lubricant issuance, capped at approved
Store's "Actual quantity issued" field (shown when scanning a driver's approval QR at the
plant) already existed, but nothing stopped it from being set higher than what the Manager
approved. Now capped both in the form (with a note showing the ceiling) and on the backend
— Store can issue less than approved when stock is short on the day, but never more.

### Fixed: Site Ready location — capturing was invisible, and rarely reached the driver
Two separate gaps, both closed:
- The Site Supervisor's own screen never showed whether their Site Ready tap actually
  captured a device location — it silently succeeded or silently failed with zero
  feedback either way, which is exactly what "doesn't seem to be working" looks like from
  the outside. Now shows "Location captured", a flagged-as-implausible note, or "location
  wasn't available" right under the confirmation. Also raised the GPS timeout from 4s to
  10s — construction sites often have weaker signal than the plant, and 4s was cutting off
  before a fix could be acquired often enough to matter.
- The driver's "Site location" map link only ever read the site's own saved master
  coordinate (`sites.latitude/longitude`), which is unset or rough for a large share of
  sites — never falling back to the fresher GPS the Site Supervisor had just captured on
  that exact order. So the link silently never appeared for any site missing a saved
  coordinate, even moments after a good capture. Driver's trip list now prefers the Site
  Ready capture (when present and not flagged as implausibly far from the saved point),
  falling back to the site's saved coordinate — same `COALESCE`/suspect-flag pattern
  already used by the round-91 geofence-hint job, just not previously applied here too.

### Added: old notifications are cleaned up automatically
Read notifications older than 30 days, and unread ones older than 90 days, are now purged
by an hourly background job (`cleanupOldNotifications`) — the notifications tab no longer
grows into an endless scroll of long-actioned alerts.

### Migration note
No schema changes — nothing new to apply via `/setup`.

## Ninety-sixth round (App 109 / Ver. 9.19) — items 6, 7, 8, 9 of the mocked-up feature list

The business reviewed the round-95 mockup document (`OORM_Feature_Mockups_Items6to11.docx`)
and answered its open questions directly in the file, plus sent the Transit Mixer weekly
inspection checklist that had been missing. This round builds items 6 (driver language), 7
(Site Contacts directory), 8 (monthly production target KPI), and 9 (geofence popup/
notification), all confirmed with no remaining open questions. Items 10 (Maintenance
module) and 11 (driver evaluation / Best Driver of the Month, using the now-received
checklist) grew in scope from the business's answers — item 10 picked up three new
sub-requirements (equipment-specific maintenance action points, an external-workshop
repair/approval flow, and excluding in-repair vehicles from Plant Operator's ticket list)
— and are carried to the next round rather than rushed.

### Added: driver language option — Malayalam & Hindi
`users.preferred_language` (`'en' | 'ml' | 'hi'`, default `'en'`), settable from a new
Driver -> Settings screen (`frontend/src/pages/DriverSettings.jsx`, `PATCH
/driver/language`). Scope, confirmed by the business: driver-facing screens only — the
Duty screen, trip cards, stage labels, geofence hint text, and the fuel/lubricant module
when a driver uses it (Manager/Admin/Office/QC/Store screens stay English, since the fuel
screen is shared and only a driver can ever have a non-English preference). Built as a
small translation dictionary (`frontend/src/lib/i18n.js`, `useT()` hook) rather than a
full i18n library — a missing key always falls back to English instead of breaking a
screen. The business flagged that the Malayalam/Hindi phrasing is a first pass and asked
for it to be spot-checked by a native speaker on their team before wide rollout — this is
not yet done. Push notification text for the four geofence hint events (see item 9 below)
is also localized per-driver, via a parallel server-side dictionary
(`backend/src/lib/i18n.js` — kept separate from the frontend one since backend/frontend
are different bundles in this app).

### Added: Site Contacts directory
New `site_contacts` table, keyed on customer + site (confirmed match key). Create Order's
"Site contact" field is now a dropdown of contacts already on file for the selected
customer + site, with a "+ Add a new contact" option; anything newly typed is saved to the
directory automatically when the order is submitted, so the next order for the same site
already has it available — no separate data-entry step. `customer_orders.site_contact_number`
is unchanged (still the number actually used on that order); the directory is a lookup/
autofill layer, not a replacement. Administrator -> Masters -> "Site Contacts" is the
dedicated browse/correct screen (edit a typo, deactivate someone who's moved on) — per the
business's answer, day-to-day additions happen from Create Order itself, this screen is for
fixing mistakes. Backend: `GET/POST /master/site-contacts` (autofill + save, any
authenticated role that reaches Create Order), `GET/PATCH /administrator/site-contacts`
(management screen, Administrator only).

### Added: monthly production target KPI
New `monthly_production_targets` table (one row per year+month, so past months keep their
own historical target). Administrator -> Masters -> "Production Target" sets the figure for
a given month (e.g. 2000 m³ for August 2026 — nothing is pre-seeded, set it once via this
screen). Manager dashboard shows four new KPI tiles once a target exists for the current
month: Monthly Target, Achieved (% and m³), Balance to Go (m³ and days remaining), and
Required/Day. Confirmed with the business: "days remaining" counts every calendar day, not
just working days. The tiles simply don't render if no target has been set yet for the
current month, rather than showing a confusing "0 of nothing".

### Added: geofence popup/notification — now covers all four stages, both roles
Investigated before building and found the underlying detection was already more complete
than the round-95 mockup assumed: `checkGeofenceEvents` already detects and pushes for all
four stages (Plant Out, Site In, Site Out, Plant In) for the driver, and already pushes Site
In/Out hints to the assigned Site Supervisor too — this round's actual new work was the
*interruptive* treatment and the two things genuinely missing, not the detection itself:
- **Driver app**: the passive on-screen banner is now backed by an actual interruptive
  popup (a modal, not just a quiet line of text) with "Confirm {stage}" / "Not Yet"
  buttons — shown the moment a hint fires while the app is open. Site In/Site Out hints
  (`GET /tickets/my-trips` now also returns `hint_site_in_at`/`hint_site_out_at`) were
  previously detected and pushed but never actually surfaced anywhere on the driver's own
  screen — that gap is now closed, gated to self-service sites only (a supervised site's
  Site In/Out remain the Site Supervisor's to confirm, same split used everywhere else).
- **Site Supervisor app**: same interruptive-popup treatment added for their existing
  reached-site/left-site hints (previously a passive banner only).
- **Notification action buttons**: confirmed by the business — tapping a stage button
  directly on the phone's notification (app in background) logs it instantly, no
  confirm screen first. The service worker (`sw.js`) now shows a notification action
  button when the push payload includes one, and calls the relevant API endpoint directly
  using an auth token mirrored into IndexedDB at login (`frontend/src/lib/authDb.js` —
  service workers can't read `localStorage`). Falls back to opening the app if the call
  fails for any reason (no stored token, offline, stage already moved on). Wired for Plant
  Out/Site In/Site Out/Plant In (driver) and Arrival/Completion (Site Supervisor).
- **Scope confirmed by the business**: extend beyond the original Plant Out/Site Out pair
  to all four driver stages, and apply the same popup+notification-action treatment to Site
  Supervisor's own Site In/Site Out — both done above.

### Migration note
Run `/setup` after deploying — adds `users.preferred_language`, the `site_contacts` table,
and the `monthly_production_targets` table (see recurring bug pattern #10: a query against
any of these throws the generic "Something went wrong" error until `/setup` is re-visited).
No pre-seeded monthly target — set the first one via Administrator -> Masters -> Production
Target after this deploy.

## Ninety-seventh round (App 110 / Ver. 9.20) — quick fixes after round 96 usage

Five small follow-ups from the business after trying round 96 in the field.

### Fixed: breakdown report now captures GPS location
`POST /driver/breakdown` already accepted and stored `latitude`/`longitude` — that part was
built earlier but the driver's own Report Breakdown form never captured or sent them. Fixed
on the frontend only (`BreakdownForm` in `DriverDuty.jsx`): captures GPS the same
best-effort way as every other stage action in this file (`navigator.geolocation`, 8s
timeout, silently proceeds without coordinates if it fails) at the moment the report is
submitted, alongside the driver's own typed description of the location.

### Redesigned: Manager dashboard monthly-target KPIs — colorful + graphical
Per feedback, the plain four-tile round-96 version is replaced with two cards
(`MonthlyTargetPanel` in `ManagerDashboard.jsx`):
- **Achieved** — shows only the percentage (the `monthly_production_m3` figure was dropped
  from this tile since Monthly Production already has its own KPI tile above it) as a
  colored meter/progress bar. The fill color is driven by a new `pace_status` field
  (`"good" | "watch" | "behind"`) computed server-side in `GET /orders/dashboard` —
  average daily rate achieved so far vs. required-per-day-to-hit-target — using this app's
  own existing status tokens (`--signal-green` / `--amber` / `--alert-red`), not a new
  palette, so it stays visually consistent with the rest of the UI.
- **Balance to go** — Balance (m³), Days left, and Required/day are combined into one card
  instead of three separate tiles, per the business's explicit request.

### Answered: how to modify a translation
`frontend/src/lib/i18n.js` is the file — each language (`en`/`ml`/`hi`) is a flat
key -> string map, with `{placeholder}` syntax for interpolated values (e.g.
`{count}`, `{name}`, `{time}`). A correction there needs a new build + deploy to take
effect; it isn't something the business can hot-edit themselves in production.

### Answered: where's the Site Contacts admin screen
Administrator -> Masters -> "Site Contacts" (also reachable from Reports -> Masters for
anyone who lands on the Director's Dashboard instead) — added in round 96, item 7.

### Added: pump is mandatory on order creation, and stays editable after a delivery ticket exists
Two related fixes to `pump_requirement`/`pump_id` on `customer_orders`:
- **Create Order**: "Which pump" is now a required field once a pump requirement (boom/line)
  is selected — both as a native `required` select and as an explicit check before submit.
- **Correct Orders** (`Administrator -> Manage -> Correct Order`, `OrdersPanel` in
  `MasterDataPanels.jsx`): a new Pump column lets the pump requirement and specific pump be
  changed on an existing order at any time — **deliberately not locked by `has_tickets`**,
  unlike Grade. The business's reasoning: the pump actually in use can change mid-pour for
  operational reasons (breakdown, site access, etc.), so this needs to stay correctable
  after a delivery ticket/DN has already been raised, not just before. `PATCH
  /administrator/orders/:id` accepts `pump_requirement`/`pump_id` with no ticket-lock check;
  selecting "Without pump" clears `pump_id`. Scope note: this corrects the *order's* own
  pump assignment — it does not retroactively rewrite `pump_id` on delivery tickets already
  printed; if the business also wants a pump change to update an in-progress ticket's own
  record, that's a follow-up, not assumed here.

## Ninety-eighth round (App 111 / Ver. 9.21) — items 10 & 11 built: Maintenance module & Best Driver of the Month

Sent an HTML mockup of both screens for review before writing any code (following the round-95
pattern for items 6-11); the business approved it as-is ("looks very good, code it now"). This
round builds the real thing — new tables, five new backend endpoints groups, and a new
Manager/Administrator screen — reusing the mockup's exact layout and colors (kanban, meter,
stacked bar, timeline) now wired to live data instead of sample rows.

### Added: Maintenance module (item 10)
New tables: `maintenance_action_points` (Administrator-defined, days-OR-hours-of-operation
basis, applies to every active truck — no per-vehicle overrides in this first version),
`maintenance_logs` (completion history), `external_repairs` (the workshop flow below).
Administrator -> Masters -> "Maintenance Action Points" manages the checklist itself; the due
list, logging, and repair flow live at Manager/Administrator -> Reports -> "Maintenance & Best
Driver of the Month" (`GET/POST /api/maintenance/*`). Whichever of days-elapsed or
hours-of-operation trips first determines due status (overdue / due this week / upcoming /
not yet logged) — hours read off the truck's most recent `fuel_logs.hour_meter_reading`,
already captured today by the fuel module, no new data entry required. All three
business-added sub-requirements are in:
1. **Per-equipment action points on a days-OR-hours basis** — `maintenance_action_points`,
   both intervals optional but at least one required; the due list takes whichever is closer.
2. **External-workshop repair/approval flow** — driver requests (`POST
   /driver/external-repair`, a new "Request external repair" button on the Duty screen,
   distinct from Report Breakdown), Manager approves/rejects, then logs sent-out/returned as
   the truck actually goes (`PATCH /api/maintenance/external-repairs/:id/{approve,reject,
   sent-out,returned}`), tracked as a 4-column kanban (Requested / Approved / Sent out /
   Returned) matching the approved mockup.
3. **A truck away for repair drops off Plant Operator's ticket-creation list** — `GET
   /master/trucks?exclude_in_repair=true` (only Plant Operator's own truck picker passes this
   flag; every other caller of that endpoint still sees the full active fleet). A truck
   re-appears the moment its repair is marked Returned.

Per-vehicle service history (standard maintenance + external repairs, merged into one
timeline) is a drilldown on the same screen.

### Added: Best Driver of the Month (item 11)
The weekly Transit Mixer Inspection Checklist — the exact 5 sections / 36 items transcribed
from the business's own `TM_Check_list_for_Plant_Incharge.pdf` (re-read from the original
upload rather than relying on an earlier summary, to make sure nothing was mistranscribed) —
is now a real digital form (`truck_inspections`, filled by Manager per the business's
confirmed answer, Poor/Satisfactory/Good/Very Good per item) at "+ New weekly inspection" on
the Best Driver tab. Composite score per driver, computed monthly:
- **Checklist** — average of that driver's weekly inspection scores this month.
- **On-time** — reuses the exact ">2 hours at site" threshold the Manager dashboard's own
  "delayed trucks" KPI already uses (`GET /orders/dashboard`), applied retrospectively per
  completed ticket instead of as a live check. A ticket missing geofence timestamps (e.g. a
  self-service site) is excluded from this one component rather than guessed, and the
  composite reweights across the remaining three so a data gap doesn't just zero a driver out.
- **Quality** — 100 minus the rejection rate (rejected m³ / loaded m³) across the driver's
  completed tickets that month.
- **Volume** — completed trip count, normalized against the month's top performer. No minimum
  trip count, per the business's confirmed answer — every driver is eligible.
- **Open question, flagged directly on the page**: the weighting used (Checklist 30% /
  On-time 25% / Quality 25% / Volume 20%, `WEIGHTS` in `backend/src/routes/maintenance.js`)
  is a starting proposal carried over from the mockup, not a finalized decision.

A driver with no completed trips or no checklist filled that month shows in a separate "Not
yet ranked" list with the specific reason, rather than being silently scored as zero.

### Migration note
Run `/setup` after deploying — adds `maintenance_action_points`, `maintenance_logs`,
`external_repairs` (+ the `external_repair_status` enum), and `truck_inspections`. Verified
against a fresh local Postgres 16 instance this round: full `schema.sql` install, the
incremental `/setup` migration path against an already-existing database (twice, to confirm
idempotency), and every new endpoint exercised end-to-end with seeded data (due-list
overdue/due-soon classification, the full external-repair lifecycle including the
ticket-creation exclusion taking effect and clearing on return, and the best-driver composite
score) before packaging this round.

## Ninety-ninth round (App 112 / Ver. 9.22) — Best Driver rework, breakdown report rework, customer booking mockup

Business feedback on round 98's Best Driver of the Month, plus two more items: the driver
breakdown report's location capture, and a first mockup of a customer-facing booking form.

### Changed: Best Driver weighting confirmed, "on-time" redefined as transit efficiency (item 1, 2)
Two related pieces of feedback on the round-98 mockup-turned-real feature:

1. **Weighting confirmed**: Checklist 40% / On-time 15% / Quality 20% / Volume 25%
   (`WEIGHTS` in `backend/src/routes/maintenance.js`) — no longer an open question on the page.
2. **"On-time" redefined.** Business pushback: total time at site isn't on the driver — it
   depends on site conditions (queueing, pump availability, other trucks at the same site).
   What IS on the driver is the two transit legs: plant-out → site-in, and site-out →
   plant-in. Those legs also vary a lot by which site a driver was sent to, so a driver isn't
   scored against a fixed clock — they're scored against how other drivers did on trips to the
   **same site** that month (`computeTransitRows()` groups by `sites.id`, needs at least 2
   trips at a site before scoring kicks in; a ticket with nothing to compare against is
   excluded rather than guessed, same reweighting pattern as before).

   While rebuilding this, found and fixed a real round-98 bug: the old on-time calculation
   read `trip_events.event_type = 'left_site'` as the "site out" marker — but the app never
   actually writes a `left_site` row to `trip_events` (it only ever appears as a geofence
   *hint* in `geofence_events`, surfaced to Site Supervisor/Driver as a nudge, never confirmed
   into the real timeline). So on-time silently had zero data for every driver all of round 98.
   Fixed to use `unloading_completed`, which is the event the rest of the app
   (`siteSupervisor.js`, `tickets.js`) already treats as "site out".

### Added: Site Efficiency tab (item 1 follow-up)
New third tab on the Maintenance/Best Driver screen (`GET /api/maintenance/site-efficiency`):
for each site, every driver's average plant-out/site-in and site-out/plant-in time this month,
sorted fastest first, with a "vs site avg" percentage. This is the per-site detail behind the
Best Driver on-time score — lets a manager tell apart "this driver is slow" from "this driver
keeps getting sent to a far/slow site."

### Changed: Driver breakdown report — no more free-text location, added an issue picklist (item 3)
The manual "Location" text field is gone from the driver's Report Breakdown form
(`DriverDuty.jsx`) — location is now GPS-only, using the same best-effort auto-capture added
last round (`navigator.geolocation`, 8s timeout, never blocks submission). Manager's
Breakdowns screen shows a "view location" Google Maps link (same pattern already used
elsewhere in the app — SalesPanels, LeadsBrowser, etc.) instead of the old typed-in text.

Also added a fixed picklist of common Transit Mixer issues (tyre puncture, engine trouble,
overheating, drum/mixer fault, hydraulic failure, battery/electrical, brake failure, fuel
issue, clutch/gearbox, accident, other) — single source of truth in
`backend/src/lib/breakdownIssueTypes.js`, fetched by the frontend via
`GET /api/master/breakdown-issue-types` (same pattern as round 98's inspection checklist).
"Other" requires a short free-text description; every other option leaves the "additional
details" field optional. New `breakdown_reports.issue_type` column.

### Added: Customer concrete booking form — mockup only (item 4)
Sent as a standalone HTML mockup (`customer-booking-mockup.html`) for review, not built yet —
same two-step process as items 6-11 (mockup first, "code it now" before real
backend/frontend work starts). Covers the full loop the business described: Manager/Admin
generates a booking link scoped to one customer + one site (same unguessable-token pattern
the app already uses for customer delivery-tracking links); customer opens the link on their
phone and submits grade, quantity, pump requirement, casting location, site contact, and
special instructions (fields mirror what Create Order already captures); the request appears
in a new Manager Dashboard queue where Manager can adjust the scheduled date/time before
converting it into a real order, or decline with a reason; the customer re-opens the same
link afterward to see status, with the confirmed date & time front and center once accepted.

Note: the actual Order Form / Terms & Conditions PDF referenced in the request didn't sync
into this session, so the form fields are drawn from the app's own existing order-capture
fields and the Terms & Conditions text is a placeholder, clearly marked as such on the mockup
itself. Swap in the real wording once available — no other part of the mockup depends on it.

### Migration note
Run `/setup` after deploying — adds `breakdown_reports.issue_type`. Verified this round
against a fresh local Postgres 16 instance: full `schema.sql` install, the incremental
`/setup` path (twice, idempotency), and every changed/new endpoint exercised end-to-end with
seeded data — including a same-site, two-driver transit scenario to hand-check the new
site-relative on-time math (`50 + (site_avg / driver_time - 1) * 100`, clamped 0-100) and the
site-efficiency endpoint's per-site averages against the same numbers.

## Hundredth round (App 113 / Ver. 9.23) — Customer concrete booking form, built for real (item 4)

Round 99's mockup, coded up after two more rounds of feedback: the manager needs to be able
to complete the rest of the order form on conversion (not just adjust date/time), and Manager
**and** Administrator both need this reachable from their own dashboards, in its own menu —
not folded into the existing "Reports" group like round 98's Maintenance module was.

### Added: customer_booking_links — a per customer+site token, independent of tracking
New table `customer_booking_links` (`customer_id`, `site_id`, `token`, `tracking_enabled`,
`is_active`). Same unguessable-token pattern as round 91's `order_tracking_links`
(`randomBytes(24).toString("base64url")`), and the same "generating a new one revokes the old"
rule for a given customer+site. The point of a *separate* `tracking_enabled` boolean from
`is_active` is the second question this round answered: **how do you turn off just the
delivery-status view without killing the booking link?** — `PATCH /api/booking-links/:id/tracking`
flips it on its own; the link itself, and the customer's ability to see their booking status,
keep working either way. `POST /api/booking-links/:id/revoke` is the only thing that kills both,
because without the link there's nothing left to show regardless.

Backend: `backend/src/routes/bookingLinks.js` (new, mounted at `/api/booking-links`,
`requireRole("manager","administrator")` — generate/list/toggle-tracking/revoke).

### Added: bookings can now come from a customer directly, not just a Sales Executive
Rather than build a second parallel "customer booking request" table and a second conversion
flow, the existing `bookings` table (Sales Executive leads → booking → order, from the sales
module) was extended: `requested_by` is now nullable, and a new `booking_link_id` FK plus
`pump_requirement` / `casting_location` / `site_contact_name` / `site_contact_number` /
`remarks` columns were added. A customer-submitted booking has `requested_by = NULL` and
`booking_link_id` set instead. This means the **entire existing manager review/convert
flow — `GET /sales/bookings`, `POST /sales/bookings/:id/decline`,
`POST /sales/bookings/:id/convert`, and the `BookingsQueue`/`ConvertBookingForm` components
already on the Manager Dashboard — needed no new endpoints at all**, just wider field support.
`ConvertBookingForm` now pre-fills pump requirement, casting location, and site contact from
whatever the customer submitted (shown as pre-filled fields the manager can still change, not
locked), and — matching round 97's "which pump" requirement for direct order creation — now
also requires picking a specific pump before creating the order, which it didn't before.

Backend: `backend/src/routes/customerBooking.js` (new, public, mounted at
`/api/customer-booking`, no `requireAuth` — same reasoning as `routes/tracking.js`, the token
alone is the access boundary). `GET /:token` returns the link's customer/site name, the mix
grade list, the latest request's status, and (only once converted **and** tracking is enabled
on the link) a live delivery-tracking payload for that order. `POST /:token` submits a new
request, blocked with 409 while a request from the same link is still pending, so a customer
double-tapping Send doesn't queue duplicates.

### Added: live delivery tracking, bundled into the same booking link
The per-truck stage query (Left Plant → At Site → Unloading → Delivered) used to live only in
`routes/tracking.js`. Pulled out into `backend/src/lib/orderTracking.js`
(`getOrderTrackingPayload(orderId)`) so both the round-91 standalone tracking link and this
round's booking-link-with-embedded-tracking use the exact same query and stage logic — verified
no regression on the existing `/api/track/:token` endpoint after the refactor. When a booking
link has tracking enabled and its request has been converted, the customer's *same* booking link
shows live truck-by-truck status beneath the booking confirmation, instead of needing a second
link.

Frontend: `frontend/src/pages/CustomerBookingForm.jsx` (new, public, no login, `/book/:token`)
— combined form + status view + embedded tracking, following `CustomerTracking.jsx`'s existing
conventions (own `Shell`, 20s poll, no `TopBar`/`ProtectedRoute`). The Terms & Conditions
section is a single line ("governed by your existing Supply Agreement") rather than a full T&C
block, since this link only ever reaches a customer who already has one on file.

### Added: "Customer Booking" — its own top-level menu, not folded into Reports
Per this round's feedback, this is deliberately **not** added as another item inside the
existing "Reports" `GroupedMenu` (the round-98 Maintenance precedent) — it's its own menu,
`Customer Booking`, with one item ("Booking Links & Requests" → `/customer-booking`), added to
all three places that duplicate the top nav bar: `Administrator.jsx`, `ManagerDashboard.jsx`,
and `Reports.jsx` (recurring bug pattern #7 — a nav item added to only one of these silently
doesn't show up for users who reach the same role from a different page).

`frontend/src/pages/CustomerBooking.jsx` (new, `/customer-booking`,
`roles={["manager","administrator"]}`) is the link-management console: generate a link,
see/copy/toggle-tracking/revoke existing links, and — since Manager already saw the incoming
bookings queue on their dashboard (`BookingsQueue` was already rendered there, and it's now
also **visible to Administrator**, since `/manager` has always allowed both roles) — the same
`BookingsQueue` component is reused at the bottom of this page too, rather than duplicating
that list a third time.

### Migration note
Run `/setup` after deploying — adds `customer_booking_links` and the new `bookings` columns.
Verified this round against a fresh local Postgres 16 instance: full `schema.sql` install, the
incremental `/setup` path (twice, idempotency), and the complete loop exercised end-to-end over
HTTP — generate a link, submit a booking as the customer (including the duplicate-while-pending
409 check), review and convert it as Administrator (with a real pump/site-contact/casting-location
round trip), confirm the customer's own link immediately reflects "converted", toggle tracking on
and off independent of revoking, seed a dispatched truck and confirm the live tracking payload
appears on the customer's link, revoke the link and confirm it goes to `expired`, and re-verified
the existing round-91 `/api/track/:token` endpoint still returns identical data after being
refactored onto the new shared `orderTracking.js` helper.

## Hundred-and-first round (App 114 / Ver. 9.24) — Plant Out auto-record, inspection action items, maintenance ownership, breakdown/repair before loading

### Added: Plant Out auto-recorded from GPS if the driver never responds (item 1)
The customer tracking link (round 91/100) depends on the driver confirming Plant Out — if they
never tap the button and never answer the geofence popup, the customer's tracking view sits
with no Plant Out time at all. Fixed with a per-site grace period: `sites.plant_out_grace_minutes`
(nullable — `NULL` falls back to a 12-minute system default, `PLANT_OUT_DEFAULT_GRACE_MINUTES`
in `scheduledChecks.js`), editable from Administrator/Manager → Masters → Projects & Sites, since
a short-travel-time site needs a shorter grace window than a flat 12 minutes would allow.

New scheduled check `checkPlantOutAutoRecord()` (same 5-minute timer as the existing geofence
checks) finds tickets where GPS already detected `left_plant` (`geofence_events`) but no real
`trip_events` row exists yet, and the grace period — counted from `geofence_events.last_response_at`
if the driver tapped "Not yet" on the popup, else from `detected_at` — has passed. It inserts the
`trip_events` row itself, with `event_time` set to the *exact computed deadline* (detection/response
+ grace), not whenever the check happens to run — so "detected 10:10, no response by 10:22" records
10:22 even if the check itself doesn't execute until 10:25 — and `source = 'auto'` so it's
distinguishable from a real tap. New endpoint `POST /driver/tickets/:id/geofence-response`
(`{event_type}`) lets the driver's "Not yet" tap restart the clock server-side — previously
`dismissPopup()` in `DriverDuty.jsx` was pure client state with nothing recorded on the backend.

**Fairness fix, since this touches Best Driver scoring:** an auto-recorded Plant Out is the
grace-period *deadline*, not the moment the truck actually left — feeding it as-is into
`computeTransitRows` (maintenance.js) would shrink that trip's plant-out→site-in leg by up to the
grace period, unfairly inflating the driver's transit-efficiency score (and skewing the site
average every other driver at that site is compared against). Fixed by having `computeTransitRows`
prefer `geofence_events.detected_at` — the true GPS-observed departure moment — over the padded
`trip_events.event_time` whenever `source = 'auto'`. Verified with a real Postgres instance: same
ticket scored ~3 min transit using the true GPS time vs. ~2 min if the padded auto time had been
used unchanged.

An auto-recorded Plant Out is marked wherever it matters for a human reviewing it: the customer's
own tracking link shows the plain time (per the business's own spec — a customer doesn't need to
know it was GPS-inferred), but the internal Time Cross Check report
(`GET /orders/trip-time-crosscheck`, `TripTimeCrossCheckPage.jsx`) now shows a superscript **A**
next to an auto-recorded Plant Out time, with a legend explaining it.

### Added: "Action required" column on the weekly inspection checklist (item 2)
Each of the ~36 checklist items on the Transit Mixer Weekly Inspection now has its own remark
field. A non-empty remark becomes an open **maintenance action item** — a new table,
`inspection_action_items`, deliberately separate from the existing `maintenance_action_points`
(the fixed, recurring master schedule — "Oil change every 90 days") since these are one-off
findings tied to a specific inspection ("Front tyres — worn, needs replacement"), not a recurring
task. `POST /api/maintenance/inspections` now also accepts an `action_items` array (only remarks
that were actually filled in are stored — most checklist items on most inspections need no
action). New `GET /api/maintenance/action-items?status=open|resolved|all` and
`PATCH /api/maintenance/action-items/:id/resolve` (optional `resolution_notes`) round out the
follow-up flow. Surfaced as a new panel at the bottom of Maintenance → Best Driver of the Month
(`InspectionActionItemsPanel`), open by default with a toggle to see resolved ones — reachable by
both Manager and Administrator, same as the rest of that tab.

### Changed: Maintenance Action Points moved from Administrator to Manager (item 3)
Per direct business request — this master list (the recurring service schedule, round 98 item
10) moves wholesale from Administrator's Masters menu to Manager Dashboard's records/masters
view. The three routes (`GET`/`POST`/`PATCH /action-points`) moved from `administrator.js` to
`maintenance.js`, now `requireRole("manager")` only (not Administrator) — Administrator's old
routes were removed outright, not duplicated, since the ask was specifically to hand this over,
not share it. `MaintenanceActionPointsPanel` (`MasterDataPanels.jsx`) itself didn't need to
change — only which page imports it and which API path it calls (`/administrator/maintenance-
action-points` → `/maintenance/action-points`). This is the deliberate exception to recurring bug
pattern #7 (duplicate a nav item to every dashboard) — here the business explicitly asked for a
move, not a duplication, so it's now Manager-only by design.

### Fixed: driver couldn't report a breakdown or request external repair before loading (item 4)
`BreakdownForm` and `RequestRepairForm` in `DriverDuty.jsx` both gated their trigger button on
`current?.truck_id` — a truck only becomes associated with a driver once a delivery ticket exists
for them, so a driver who finds their assigned vehicle broken down *before* it's even been loaded
(no ticket yet) had no way to report it at all. Both buttons are now always available, and each
form gained a `TruckPicker` — a truck dropdown (`GET /master/trucks?exclude_in_repair=true`,
the same exclusion already used elsewhere so a truck already sent out for repair doesn't appear
twice) — that only renders when there's no active trip's truck to default to. Backend needed no
changes: `POST /driver/breakdown` and `POST /driver/external-repair` already accepted any
`truck_id` from the request body with no ownership/trip check.

### Migration note
Run `/setup` after deploying — adds `sites.plant_out_grace_minutes`,
`geofence_events.last_response_at`, and the new `inspection_action_items` table. Verified this
round against a fresh local Postgres 16 instance: full `schema.sql` install, the incremental
`/setup` path (twice, idempotency), and the full loop exercised end-to-end over HTTP — GPS-detects
Plant Out, confirmed no auto-record fires before the grace period, confirmed a driver's "Not yet"
tap restarts the clock (re-tested the deadline lands exactly on `response + grace`, not
`detection + grace`), confirmed the auto-record check is a no-op once the driver's real tap (or an
earlier auto-record) already exists, confirmed the Best Driver transit score uses the true GPS
detection time rather than the padded auto time, confirmed the Time Cross Check report flags the
auto-recorded row, filled a full weekly inspection with one flagged item and confirmed it appears
as an open action item and can be resolved, confirmed Administrator can no longer reach maintenance
action points while Manager can, and confirmed a driver can report a breakdown/external-repair with
an explicitly chosen truck and no active trip.

## Hundred-and-second round (App 115 / Ver. 9.25) — Sales module rework: simplified dashboard, follow-up threads, customer booking multi-request

Full rework of the Sales Executive experience, requested because the module had grown confusing:
too many tabs (Dashboard, Bookings, My leads, Visits, Feedback) for what a rep actually needs day
to day — track customer visits, respond to leads, and forecast running projects. Went through five
rounds of mockup review (`sales-customer-module-mockup.html`) before this round's "good, start
coding" approval. Several items below turned out to already exist in the real app (the visit
questionnaire, "sent by" on leads, achieved sales/outstanding) — the mockup's own earlier
simplification had dropped them, so "bring back X" meant restoring them in the mockup, not building
them fresh here.

### Changed: Sales Executive dashboard down to three tabs — Leads, Visits, Forecast
Booking and Feedback move to the Customer module (see below); the standalone Dashboard tab is gone,
replaced by a KPI strip pinned above the tabs so the numbers that matter are visible without a
click: open leads, visits this week, **sites overdue a visit** (new — sites this rep owns with no
`customer_visits` row in the trailing 14 days), forecast status, achieved sales this month (m³),
and outstanding payments (collapsible breakdown by customer). The whole restructure is built around
one idea from the request: force the rep to visit more sites and feed forecasts back to Operations,
so visit cadence and forecast currency are now front and center instead of buried in a report.

### Added: date-wise visit summary with no-visit days flagged
New `dailyVisitCadence(userId, days)` helper (`sales.js`) joins `generate_series` against
`sales_duty_log` and `customer_visits` — a day only counts as "missed" if the rep was actually on
duty that day and logged zero visits; a day off is a day off. Surfaced three ways from one helper:
the rep's own trailing-7-day strip on their Visits tab (`GET /sales/visits/summary`, shared
component `lib/VisitCadenceStrip.jsx`), the same strip per rep on the Sales Performance page
(`GET /sales/visits/cadence`, Manager/Administrator), and folded into the "Visits this week" KPI
tile.

### Restored: full visit questionnaire, now also mandatory on a lead's "Site visit" update
The 12/7 structured tap-answer questionnaire (new-project vs. running-project) was already built —
it just needed to render correctly and now also gates a lead update. When a Sales Executive logs a
lead activity as "Site visit", the same `QuestionBlock` UI renders inline and Save stays disabled
until every question is answered (`missingAnswerKeysClient` mirrors the backend's
`missingAnswerKeys`). Answering it now does real work, not just gate-keeping: `POST
/sales/leads/:id/followup` creates a genuine `customer_visits` row (`visited_name` from the lead's
`prospect_name`, `customer_id` from `leads.won_customer_id` if already linked) and runs it through
the same follow-up generation and notification logic as a normal visit, via a new shared
`applyVisitFollowupsAndNotifications()` helper — a lead's site visit is now a real visit, not a
disconnected checkbox. No new lead status was added: `lead_status` is a fixed Postgres ENUM with no
"site visit done" value, so that's a **derived frontend badge** (from the lead's most recent
`lead_followups.activity_type`) shown next to the lead's real status, not a stored value. "My
leads" already showed who sent each lead (`created_by_name`) — untouched this round.

### Added: follow-up threads — multiple follow-ups from one visit clubbed together, with a logged action history
A visit can generate several follow-up items at once (e.g. "call back to check decision" + "send
revised quotation") — these now display as one thread per visit (grouped by `visit_followups.
visit_id`, already the natural link) instead of scattering across separate date rows. New
`followup_actions` table (followup_id, note, next_due_date, created_by) lets a rep log what they
actually did against a follow-up — a call, an email — without closing it out, via `POST
/sales/followups/:id/log-action` (optionally reschedules the due date in the same step) and `GET
/sales/followups/actions?followup_ids=...` for batch history. `generateFollowups()` also gained a
fallback: a visit that raises no specific flags now still produces a default 14-day check-in
follow-up, so "no red flags" no longer means silently dropping the customer — every visit leaves a
thread. `FollowupsDue.jsx` (the widget pinned above the Sales Executive's tabs) and the new report
below both consume this the same way.

### Added: visit cadence & follow-up thread report on the existing Sales Performance page
Per correction from an earlier mockup round — not a new report/menu item, appended below the
existing "Salespersons — this month" and "Customer visits report" tables on
`/sales-performance`. "Visit cadence — by sales rep" shows one day-strip per active Sales
Executive (`GET /sales/visits/cadence`). "Follow-up threads & actions taken" groups
`GET /sales/followups/report` by visit client-side, showing customer/site, origin visit date, rep,
open-thread count, latest logged action, and a status badge (Overdue / Due today / Upcoming /
Closed).

### Fixed: customer booking only allowed one open request at a time
Root cause traced to `routes/customerBooking.js`: the public booking-link `POST` hard-blocked a
second submission while any request on that link was still `status = 'pending'`. Removed — a
customer can now have several open requests on the same site at once (e.g. 30 m³ of M25 and 34 m³
of M20 for the same pour). `GET /:token` now returns every request on the link (`requests`, newest
first) instead of just the latest one; live delivery tracking still only ever follows the most
recently *converted* request, since that's the one with trucks actually moving.

### Changed: customer's own booking page — name hierarchy reversed
`CustomerBookingForm.jsx` now shows the customer's name as the big, bold heading with the site name
as the smaller label underneath — reversed from before. The page now renders a list of all open
requests (each its own status card) instead of one "latest request" block, and "+ New booking
request" is always available, no longer hidden while a request is pending.

### Changed: "Place a Booking" and "Feedback" move from the Sales Executive's own dashboard into the Customer module
`CustomerBooking.jsx` (`/customer-booking`) is now reachable by Sales Executive as well as
Manager/Administrator, with role-appropriate tabs matching what each role's backend permissions
already allow: Manager/Administrator keep "Booking Links & Requests" (link generation is admin-
only); Sales Executive gets "Place a Booking" (`POST /sales/bookings` is SE-only) and both roles
get "Feedback". Feedback is now **read-only** here — compliments/complaints are recorded inline
when a rep logs a post-delivery visit (`post_delivery_feedback` on `POST /sales/visits`, feeding
the existing `aftersales_feedback` table), not through a separate manual-entry form, matching the
mockup's "feedback folds into recording a Visit" decision. A "Bookings & feedback →" link on the
Sales Executive's own dashboard points here, since that's no longer a tab on their own page.

### Migration note
Run `/setup` after deploying — adds `lead_followups.is_new_project`, `lead_followups.answers`,
`lead_followups.related_visit_id`, and the new `followup_actions` table (with its
`idx_followup_actions_followup` index). Verified this round: `node --check` on every touched
backend route file, and a full `npm run build` of the frontend (clean, no errors) after all
restructuring — including the pass that moved `BookingsList`/`NewBookingForm`/`FeedbackList`/
`NewFeedbackForm` out of `SalesExecutive.jsx` into `CustomerBooking.jsx`, and the pass that added
the "Site visit done" derived badge to the leads list (the backend already returned
`latest_activity_type`, but the first pass forgot to render it — caught and fixed before calling
this done). No live Postgres instance was available in this environment to exercise the new
endpoints end-to-end over HTTP — worth a smoke test after deploying, especially the lead
site-visit → `customer_visits` row creation and the follow-up action log.

## Hundred-and-third round (App 116 / Ver. 9.26) — three real bugs found while verifying last round's customer booking work

Business verification of round 102's customer booking changes surfaced three real gaps —
all in `routes/customerBooking.js` and `CustomerBookingForm.jsx`, no schema change needed
(everything here reads columns that already existed).

### Fixed: a booking link generated for an already-ongoing order showed nothing but the request form
Tracking used to only ever come from a request that was itself submitted through *this exact
link* and converted here (`latestConverted`, matched off `bookings.booking_link_id`). A link
generated for a customer/site that already had an order in progress — created directly by
Manager, never as a booking request through this link at all — had no matching `bookings`
row, so `tracking` was always `null` and the customer saw only the bare "Request concrete"
form, even with the link's tracking toggle turned on. Fixed by decoupling tracking from the
booking-request linkage entirely: `GET /:token` now looks up whichever `customer_orders` row
is currently live for that link's `customer_id` + `site_id` — preferring one still in
progress, falling back to the most recent otherwise — regardless of how that order
originated. `getOrderTrackingPayload()` (round 100's shared helper) still handles the
terminal-state + 3-hour grace window on its own, unchanged. Frontend: `displayForm` used to
gate purely on `requests.length === 0`; now also checks `!tracking`, so the status view (with
live tracking) shows whenever there's something to track, even with zero requests on this
particular link.

### Fixed: a converted request's status froze at "Accepted — scheduled" forever
`bookings.status` only has three values (`pending`/`converted`/`declined`) — once a request
converted, the customer's card kept showing "Accepted — scheduled" even after the order was
actually delivered, completed, or cancelled, because nothing ever looked past the booking's
own frozen status. `GET /:token`'s `requests` query now `LEFT JOIN`s `customer_orders` on
`b.converted_order_id` and returns the order's own `status` (`order_status`) alongside it.
`RequestStatusCard` now branches on that for a converted request, using the same status
vocabulary and meaning as the existing round-91 tracking link's `StatusBadge`
(`planned`/`in_progress`/`partially_completed`/`completed`/`closed`/`cancelled`) — so a
customer sees "Delivery in progress", "Completed", "Cancelled", etc. as the order actually
moves through its lifecycle, not a permanent "Accepted" banner.

### Fixed: a rescheduled date/time/grade/qty at conversion (or a later Correct Order edit) never reached the customer
`POST /bookings/:id/convert` never wrote its final values back onto the `bookings` row — if
Manager changed the date, time, grade, or quantity while converting (very possible; the
convert form pre-fills from the request but every field is editable), the customer's request
card kept showing what they originally asked for, not what was actually scheduled. Rather
than mutate the booking (which should stay the honest record of the original ask), the fix
keeps both: `GET /:token` now also returns the order's live `order_date`/
`scheduled_batching_time`/`order_quantity_m3`/mix grade name (`order_order_date`/
`order_scheduled_batching_time`/`order_order_quantity_m3`/`order_mix_grade_name`) for a
converted request, and the frontend prefers these over the original request fields once
converted. Because this reads the order's *current* values on every poll (the page already
refreshes every 20s), a later Correct Order edit to the date/grade/pump also reaches the
customer automatically, not just the original conversion.

### Known limitation, not fixed this round
A booking link is scoped to one customer + one site, and round 102 made it possible for a
site to have several simultaneously-converted orders (different grade/qty combos). The
"Your booking requests" list correctly shows each converted request's own real status
independently (the fix above is per-request), but the "Live delivery status" truck-tracking
section still only ever follows one order — the one picked as "most relevant" (in-progress
preferred, else most recent). If two requests convert to two orders that are both in
progress at once, only one gets live truck tracking on this page. Worth revisiting if this
comes up for real — would need the tracking section to key off each request individually
rather than a single link-level "current order".

### Migration note
None — no schema change. Every field this round reads was already on `customer_orders` or
`bookings`. Verified with `node --check` on the touched backend file and a full
`npm run build` of the frontend (clean, no errors). No live Postgres instance was available
in this environment — worth a real end-to-end smoke test after deploying: generate a link
for a site with an order already in progress and confirm tracking now shows; convert a
booking with a different date/grade/qty than requested and confirm the customer's card
reflects the change; walk a converted order through in_progress → completed and confirm the
badge updates on the customer's page each time it polls.

## Hundred-and-fourth round (App 117 / Ver. 9.27) — "Issued by" / "Approved by" on the Fuel and Lubricant Report

Business asked whether an earlier request to add "Issued by" to the Fuel and Lubricant
Report had actually been wired up, then asked for "Approved by" too. Checked the real
code rather than assuming: `GET /supply-requests/report` and `/report/export`
(`routes/supplyRequests.js`) already `LEFT JOIN`s both `users ub ON ub.id = sr.approved_by`
and `users ui ON ui.id = sr.issued_by` and had always returned `approved_by_name`/
`issued_by_name` — and the Excel export (`FuelReport.jsx`'s `exportExcel()`) already had
"Approved by" and "Issued by" columns. So the backend and Excel export were done. What
was actually missing: the **on-screen report table** and the **PDF export** never rendered
either name — only the request/approve/issue *quantities*, no *who*. Added an "Approved by"
and an "Issued by" column to both (on-screen table and `exportPdf()`'s `autoTable` head/body/
foot — footer `colSpan`s recomputed for the now-14-column table). No backend or schema
change needed — the data was already there, just not displayed in two of the report's three
output forms.

### Migration note
None — no schema or backend change, display-only. Verified with a full `npm run build`
(clean, no errors).

## Hundred-and-fifth round (App 118 / Ver. 9.28) — Lab Technician role, mix designs, cube test results, PDF reports

Coded up the Lab Technician mockup work from the last two design rounds for real. Scoped
this to Lab Technician + mix designs + PDFs specifically (business's own choice — CMS
screens for Services/Technical Writings/Brochure and customer-facing quick fixes are
deferred to later rounds).

New `lab_technician` role (enum value + `ROLES`/`ROLE_HOME`/`ROLE_LABEL` entries + its own
`/lab-technician` route), separate from QC Engineer — QC Engineer keeps doing plant-side
fresh-concrete QC (slump/temp, cube casting) exactly as before; a "cube batch" is just a
`plant_qc` row that already has cubes cast (`number_of_cubes > 0`), nothing new captured at
casting time. Lab Technician owns everything downstream:

- **Cube compressive-strength testing** — per-batch 7-day/28-day result entry
  (`POST /lab-technician/cube-batches/:plantQcId/results`), with per-cube weight/load
  entered and weight→density, load→strength, and the batch average always **recomputed
  server-side** from the posted cubes (never trusted from the client), so the stored
  average can never drift from what the per-cube rows say. Batch due-status
  (`overdue`/`due_today`/`upcoming`/`done`) is computed in SQL against `CURRENT_DATE`, not
  in JS — recurring bug pattern #1.
- **Mix design library** — full entry form matching the mix design file business supplied
  (repeatable admixtures — a design can carry more than one, e.g. a superplasticizer plus a
  retarder — moisture/absorption per aggregate fraction, and the full 5-material table), plus
  a second-person approval step (`POST /mix-designs/:id/approve` — a design's own creator
  can't approve it). Target mean strength, total binder, W/B ratio, and total aggregate are
  all Postgres `GENERATED ALWAYS AS (...) STORED` columns — deliberately, so these can never
  drift from their inputs the way an earlier mockup review round caught the design-density
  arithmetic not actually summing correctly.
- **Many-to-one mix design ↔ customer assignment** — round 117's mockup feedback question
  ("how does assign to customer work — one mix design can have multiple customers?") answered
  for real: `mix_design_assignments` is one row per customer+grade (`UNIQUE (customer_id,
  mix_grade_id)`), not one row per design, so several customers routinely point at the same
  shared design. New Administrator/Manager screen ("Approved Mix Assignments", added to all
  three Masters menus — Administrator, Reports, ManagerDashboard — recurring pattern #7) shows
  a "Shared · N customers" badge via a `design_shared_count` subquery, matches the mockup.
  `customer_orders.resolved_mix_design_id` is now actually resolved and stored at order
  creation (`orders.js`'s `POST /` — customer-specific assignment first, else the grade's
  `is_standard_for_grade` design) — recurring pattern #9, a written column that's never
  actually wired into the write path it's meant to snapshot.
- **Two PDF reports**, client-side jsPDF vector drawing exactly like `deliveryChallanPdf.js`
  (`frontend/src/lib/mixDesignPdf.js`, `cubeTestPdf.js`) — Mix Design Summary and Cube Test
  Report, matching the confirmed mockups' navy/red visual language. Both render only real
  columns from their `GET .../pdf-data` endpoints; fields the mockup showed but the schema
  has no column for (pouring location, compaction method, casting slump, casting technician,
  type of failure) were deliberately left out rather than invented.
- Informational note on Create Order (`GET /master/resolve-mix-design`) showing which design
  a customer+grade will resolve to — same resolution `orders.js` applies, purely informational,
  never blocks placing the order.

Spawned a review pass before calling this done (this is production code, not a mockup).
Caught and fixed two real bugs pre-ship: `GET /lab-technician/mix-designs/:id/pdf-data` wasn't
joining `users cu ON cu.id = md.created_by` even though the PDF reads `created_by_name`; and
`GET /lab-technician/cube-batches` — the query the Cube Testing tab loads by default —
referenced `r7`/`r28` result-table aliases in its `SELECT`/`CASE` without ever joining them,
which would have 500'd on every call. Both fixed.

**Post-ship fix**: business reported "That role isn't recognized" when creating a Lab
Technician user from Administrator → Users. Cause: `POST /administrator/users`
(`administrator.js`) validates the submitted role against its own hardcoded `validRoles`
array — separate from the DB `user_role` ENUM and from `Administrator.jsx`'s `ROLES` array,
both of which *had* been updated — and this one array was missed. Same category as the
existing "role-gating has a few hardcoded validation lists beyond the DB ENUM" caveat;
`lab_technician` added to `validRoles`. Worth grepping for every hardcoded role list
(`validRoles`, `ROLES`, `STAFF_ROLES`, etc.) whenever a new role is added, not just the
obvious ones.

**Post-ship fix 2**: business flagged that admixture dosage (% of binder) had to be typed in
by hand on the mix design form — should be calculated. It's not something a `mix_design_
admixtures` row can express as a Postgres `GENERATED` column itself (it would need to read
`cement_kgm3`/`fly_ash_kgm3` off a *different* table's row), so it's computed once,
server-side, at insert time (`POST /lab-technician/mix-designs` in `labTechnician.js`) from
`qty_kgm3 ÷ (cement_kgm3 + fly_ash_kgm3) × 100` — any `dosage_pct_of_binder` the client sends
is now ignored entirely, same "recompute server-side, never trust the client" rule the cube
test averages already follow. The form's "% binder" text input is gone; each admixture row
now shows a live-computed, read-only percentage instead. Also added a live "Fly ash: N% of
binder" note next to the existing Total binder/W-B ratio line, previously only computed at
PDF-generation time, not while filling out the form — same live-banner treatment as the
other derived numbers on this form. Verified with a full `npm run build` (clean).

**Post-ship fix 3**: business also flagged that approving a mix design wasn't reachable from
Administrator at all. Real gap, not a training issue — the approval flow only existed on the
Lab Technician's own `/lab-technician` dashboard, which `ProtectedRoute` gates to the
`lab_technician` role alone, even though the *backend* had allowed
`qc_engineer`/`manager`/`administrator` to approve since the route was first written. Added a
new `MixDesignsPanel` (`MasterDataPanels.jsx`) — list + Approve + View PDF, no "create new"
(drafting stays on the Lab Technician's own fuller form) — wired into Administrator, Manager,
and Reports as a "Mix Designs (approve)" item next to the existing "Approved Mix Assignments"
one, all three nav copies (pattern #7). Approve is disabled with a tooltip when the signed-in
user is the design's own creator, mirroring the backend's self-approval block; `GET
/lab-technician/mix-designs` now also returns `md.created_by` (previously only the joined
name) so the frontend can compare against the signed-in user's id, not just a string name.

**Post-ship fix 4**: business also asked for two Cube Testing workflow changes: (a) a saved
test result should show inline on that batch's own card, not just as a banner at the top of
the page — `BatchDetail` previously never refetched its own detail after a save, so the newly
entered result only appeared if the card was closed and reopened; it now refetches immediately
(`loadDetail()`, called on mount and again after a successful save) and shows an inline
"✓ N-day result saved" note on the card itself, plus auto-selects whichever age isn't tested
yet for the next entry. (b) Batches that will never be tested (damaged cubes, cancelled order)
needed a way off the active list — added a `cube_batch_status` table (new migration, see
below), `POST /lab-technician/cube-batches/:id/close` and `/reopen`, and Active/Completed/
Closed sub-tabs on the Cube Testing tab. A batch buckets into `completed` automatically (both
7-day and 28-day results present) or `closed` (explicitly marked), computed in the API on
every request rather than stored, so it can't drift from the underlying test results; "active"
is the default view so the dashboard doesn't fill up with old, fully-tested or closed batches.
Closing/reopening never touches `plant_qc` or `cube_test_results` — purely a dashboard marker,
reversible at any time. Posting a result against an already-closed batch is now rejected
server-side ("This batch is closed — reopen it first."). Spawned a review agent over all four
post-ship fixes together before calling this done; it found no further issues.

**Known gap, not addressed this round:** the mockups for a customer-facing module (sign-in,
My Orders, QC Reports) assumed an authenticated customer account system. Checked the real app
— no customer login/JWT issuance/customer-scoped routes exist anywhere; all customer-facing
access today is via public, unauthenticated per-order/per-booking token links (`/track/:token`,
`/book/:token`). Whoever picks up customer-facing PDF viewing next needs to decide: build real
customer auth, or extend the token-link pattern to cover PDF report access too.

**Post-ship fix 5 (Ver. 9.29): both PDF reports reworked after business reviewed real
generated output against their reference sample.** Root cause behind several of the reported
issues: jsPDF's standard 14 fonts (Helvetica) use WinAnsiEncoding and don't reliably render
Unicode outside that set — the superscript "³"/"²" and the Greek "σ" in unit/label text (e.g.
"kg/m³", "N/mm²", "1.65σ") were rendering as mojibake or vanishing entirely, even though the
source looks syntactically correct (a literal Unicode character in a JS string renders fine in
a browser or editor, just not through jsPDF's default font). Every unit and symbol in both
generators is now plain ASCII ("kg/m3", "N/mm2", "SD" for standard deviation).

Both generators (`mixDesignPdf.js`, `cubeTestPdf.js`) were rewritten together: the
identification block's "Created"/"Approved" fields (previously a single unfitted string) now
render as two lines (date, then name) at a smaller font so a long name can no longer bleed into
the next column; table values are now "bold figure + normal unit" instead of the whole string
bold, so a unit no longer reads with the same weight as the number it qualifies; the Materials
table's Type/Source column now wraps to as many lines as it needs (dynamic row height) instead
of truncating to `splitTextToSize(...)[0]`, the same truncation bug that was also cramping the
Mix Design Summary grid's labels — both fixed the same way; the header address block is now
normal-weight and correctly sized to match `deliveryChallanPdf.js`'s established styling
instead of bold/oversized; the hand-drawn aggregate pie chart's slices are now each a single
filled polygon (`doc.lines(...)`) instead of a fan of small triangles, which removes the visible
hairline seams the old triangle-fan approach left between segments; the mix design signatory
line now always shows the fixed "Quality Control Engineer" label instead of the actual
approving user's name; and the admixture row in the Materials table now matches the mockup's
Material="Admixture" / Type-Source=brand-name layout (it previously put the brand name in the
Material column). Layout was also generally tightened (row heights, section gaps) so the Mix
Design PDF — which previously spilled onto a second page for just its disclaimer/footer — now
fits on one page for a normal-sized design. Verified visually, not just by build success: wrote
a small headless Node harness (jsPDF runs fine in Node once the browser-only `doc.save()` path
is swapped for `doc.output("arraybuffer")`) to render both generators with realistic sample
data and inspect the actual output via `pdftoppm`, since this class of bug — encoding, layout —
is exactly the kind that compiles clean but is wrong in the rendered artifact.

Also added the three cube-test fields business asked for: casting location and curing method
are fixed reference text in the Standards Followed table (every cube batch in this app is cast
during the Plant QC step — there's no site-casting workflow — and curing always follows
standard IS 516 water curing, so unlike type of failure these don't vary and don't need a
schema column); type of failure is a new optional `cube_test_results.failure_type` column,
captured per-result via a free-text input with a suggestion list (`FAILURE_TYPES` in
`LabTechnician.jsx` — Cone, Shear, Columnar, etc. — not a hard enum, since this is an
observational note a technician fills in from what they actually saw). Also added an
administrator-only "Change date" control on each saved result (`PATCH
/lab-technician/cube-batches/:plantQcId/results/:resultId/date`) for after-the-fact date
corrections.

A review pass on this PDF/date/failure-type work caught two real bugs before ship, both fixed:
the failure-type field was built as a closed `<select>` restricted to the 7 suggested values,
contradicting its own design comment that free text should always be possible — changed to a
text `<input>` with a `<datalist>` of suggestions; and the admin date-edit box was pre-filling
from `new Date(...).toISOString()` (UTC date) while the label next to it displays the local
date — since the app's home timezone is IST (UTC+5:30), any result tested between 00:00-05:29
IST has a UTC date one day earlier, so an admin who didn't notice the mismatch could silently
save the date one day too early. Fixed to derive the pre-fill from local date parts.

**Post-ship addition 6 (Ver. 9.29): two more business requests, addressed together.**
(a) New configurable Cube Test Report (`GET /lab-technician/cube-test-report`,
`CubeTestReport.jsx`) — a cross-batch summary table filterable by date range, customer, grade,
and design ref code (any combination), with an Excel export and a per-row PDF link reusing the
existing `generateCubeTestPdf`. Deliberately gated tighter than this router's usual broad read
access (`requireRole("lab_technician", "administrator")` on this one route specifically) since
business asked for Lab Technician + Administrator only, not Manager or QC Engineer — reachable
from a new button on the Lab Technician dashboard and from the Reports page's admin-only
Reports menu. (b) Raw material stock entry moved from QC Engineer to Lab Technician per
explicit request — `PUT .../raw-material-stock` removed entirely from `qcEngineer.js` and
re-added to `labTechnician.js` gated `requireRole("lab_technician")` only (QC Engineer now has
no write access to this at all); the page moved from `QcRawMaterialStock.jsx` (deleted) to
`RawMaterialStockEntry.jsx`, route from `/qc/raw-material-stock` to
`/lab-technician/raw-material-stock`. The read-only `GET /master/raw-material-stock` (shown on
Manager/Administrator dashboards) is unchanged — still readable by any authenticated role.
Same shared-PIN write protection carried over unchanged. A review pass over both features found
no issues.

**Post-ship fix 7 (Ver. 9.29): "number of cubes" default was silently creating phantom
testable batches.** Business reported that after saving a delivery challan, it showed up in Lab
Technician's testing queue even when no sample had actually been prepared. Root cause: the
Plant QC entry form (`QcEngineer.jsx`) defaulted `number_of_cubes` to `3` (both the initial
form state and the post-submit reset), so any QC submission where the engineer didn't
deliberately overwrite the field silently recorded 3 prepared cubes — and Lab Technician's
queue is driven by `WHERE COALESCE(pq.number_of_cubes, 0) > 0`. Fixed both occurrences to
default to `0`, matching what's actually true until an engineer enters a real count. While
fixing this, also found and fixed a companion bug in the backend handler
(`qcEngineer.js`'s `POST /:ticketId/plant-qc`): it computed the stored value as
`number_of_cubes || null`, which — since `0` is falsy in JS — silently coerced an explicitly
entered `0` into `NULL` on save. Functionally harmless today (`COALESCE(number_of_cubes, 0)`
treats `NULL` and `0` identically for queue visibility) but semantically wrong and a latent trap
for any future feature that distinguishes "not entered" from "entered as zero." Replaced with
an explicit check (`number_of_cubes === "" || null || undefined ? null : Number(...)`) that
preserves an explicit `0` as `0`. Verified with `node --check` on the backend route and a clean
`npm run build` on the frontend.

**Post-ship fix 8 (Ver. 9.29): PDF header rule had no breathing room, and the Mix Design report
left too much dead space in the footer.** Business flagged, after reviewing real generated
PDFs, that the red rule under the header sat flush against the logo/address block with no gap.
Root cause: the logo (`addImage` at `y-9`, 15mm tall) bottoms out exactly at the same `y` the
rule was drawn at (`y += 6` from the same baseline), so the two visually touched with zero
clearance — same construction in both `mixDesignPdf.js` and `cubeTestPdf.js` since the cube
test header was built from the same block. Fixed in both files by pushing the rule 3mm below
the logo's bottom edge (`y += 9` instead of `y += 6`) and widening the gap to the content below
it (`y += 7` instead of `y += 5`). Separately, on the Mix Design PDF specifically, the page was
already fitting in one page but ending well short of the bottom margin — roughly 22mm of unused
white space below the footer line, most visible as a gap between the disclaimer bar and the
physical page edge. Rather than just trimming, the vertical rhythm between the major sections
(summary grid, proportions/materials tables, aggregate/pie block, note+signatory, disclaimer)
was opened up slightly (small per-section increases, ~2mm each) so the page reads more evenly
filled instead of front-loaded with a large trailing gap, and `BOTTOM_LIMIT` was raised from
283mm to 290mm to give that extra rhythm room to render without spilling to a second page —
still leaving a safe ~7mm buffer under A4's 297mm height. Re-verified with the same headless
render + `pdftoppm` visual-inspection technique as the round-118 PDF rework: both reports still
render as exactly one page (`doc.internal.getNumberOfPages() === 1`), confirmed visually. The
Cube Test report's own trailing white space was left as-is — it's inherently a shorter report
(one summary table + a 3-row cube table) and business didn't flag it; only its header gap was
fixed. Verified with a clean `npm run build`.

### Migration note
Run `/setup` after deploying — adds the `lab_technician` enum value, six new tables
(`mix_designs`, `mix_design_admixtures`, `mix_design_assignments`, `cube_test_results`,
`cube_test_cubes`, `cube_batch_status`), `customer_orders.resolved_mix_design_id`, and (as of
Ver. 9.29) `cube_test_results.failure_type`. No live Postgres instance available in this
environment to smoke-test the migration against, so treat `/setup` on deploy as the first real
run — same caveat as prior rounds without a local DB available. Frontend verified with a full
`npm run build` (clean, no errors) and every touched/new backend route file verified with
`node --check`.

## Round 119 (Ver. 9.30): the customer-facing module — public inquiries + a customer portal

Business asked for the customer-facing screens sketched in the original mockup: potential
customers reaching the business through public channels (social media, word of mouth, a
website link) with no account, and existing customers checking their own orders and QC reports
without staff involvement. The design went through several rounds of back-and-forth before
landing on the final shape, driven by two explicit business objections: a shareable link is
"anyone can access all the details" (too permissive — one link, unlimited access, no way to
tell who's actually looking at it), and an OTP/SMS-sending flow would mean standing up an SMS
or WhatsApp provider integration business didn't want to take on right now. What shipped
instead:

**Public inquiry ("get in touch"), no login (`/inquiry`, `PublicInquiry.jsx`,
`routes/publicInquiry.js`).** A potential customer with no account submits Company Name,
Site/Project, Requesting Person's Name, and Contact Number. Rather than building a parallel
inbox, this reuses the existing Sales `leads` pipeline — a new `leads.source` column
(`'staff'` default vs `'public_inquiry'`) tags where a lead came from without overloading the
nullable `created_by`/`assigned_to` columns, and `LeadsBrowser.jsx` shows a "Public inquiry"
badge plus (for a lead nobody's picked up yet) an "Assign to a salesperson" control backed by a
new `PATCH /sales/leads/:id/assign`.

**Customer portal, access-code sign-in (`/portal`, `CustomerPortal.jsx`,
`routes/customerPortal.js`).** An *existing* customer signs in with a short human-typeable code
(8 characters, from a confusable-character-free alphabet — no `0/O/1/I/L`) rather than a link.
Manager/Admin generates the code from a new "Portal Access" tab on `CustomerBooking.jsx`
(`routes/customerAccess.js`), scoping it to one customer and one or more of that customer's
sites, and copies it to send to the customer manually — by SMS, WhatsApp, or a phone call,
whatever the business already uses; the app does not send it. Signing in shows only that
customer's own orders for the site(s) the code covers, with QC reports (mix design + cube test)
rendered by calling the existing `generateMixDesignPdf`/`generateCubeTestPdf` functions
completely unchanged — the new backend pdf-data endpoints just return the identical JSON shape
the internal Lab Technician screens already use, so there's no second PDF implementation to
maintain. The browser session persists (a separate `oorm_customer_session` storage key, kept
deliberately apart from the staff `oorm_token` so a shared/kiosk browser can't cross-contaminate
the two) so "save it for auto login next time" actually holds — but every request re-checks the
code's live `is_active` flag server-side, so a Manager revoking a code takes effect immediately
rather than waiting for the (180-day) JWT to expire on its own.

One clarifying point worth recording plainly since it's a real characteristic of what shipped,
not an oversight: the access code is a pure bearer credential. It isn't bound to a phone number
or a device — anyone holding the code can sign in, from more than one device at once if they
want, until a Manager revokes it. That was a deliberate simplification for round 119 (matching
how the business already plans to hand it out — same trust model as sharing a password with one
person) rather than an attempt at OTP-style verification; locking a code to its first device or
checking it against a phone number on file would be a distinct, separate enhancement if ever
wanted.

**Security review caught two real issues before ship, both fixed:**

1. **Missing `trust proxy` would have 500'd both new public endpoints in production.**
   Both new public POST routes (`/api/public-inquiry`, `/api/customer-portal/login`) needed
   rate limiting since they're unauthenticated and reachable by anyone — added via
   `express-rate-limit` (8 inquiries / 15 min per IP; 12 login attempts / 15 min per IP).
   `express-rate-limit` v8's default key generator throws when it sees an `X-Forwarded-For`
   header — which Render's proxy always attaches — unless Express is explicitly told to trust
   it. Nothing in the app called `app.set("trust proxy", ...)`, so in production every request
   to either endpoint would have thrown, been caught by the app's catch-all handler, and
   returned a generic 500 — silently breaking both brand-new public features on day one. Fixed
   with `app.set("trust proxy", 1)` in `index.js` (one hop, matching Render's own proxy).

2. **A conditional cross-boundary gap if `CUSTOMER_JWT_SECRET` is ever left unset.** Customer
   sessions are deliberately signed with their own secret (`CUSTOMER_JWT_SECRET`, payload
   `{type: "customer", ...}`) so a customer's token can never be mistaken for a staff one — but
   the code fell back to the shared `JWT_SECRET` if that env var wasn't set, and staff
   `requireAuth` did no shape-checking on what it verified. In that one misconfiguration window,
   a customer's access-code session would pass `requireAuth` as if it were a real staff login,
   and on any staff route that checks only "is someone signed in" with no role restriction
   after it (`routes/masterData.js` in full — customers, sites, rates, trucks, drivers — has no
   `requireRole` on any of its ~20 routes), a customer with nothing but a portal access code
   could have read staff-only master data well beyond their own orders. Fixed by making
   `requireAuth` explicitly reject any payload carrying `type: "customer"`, so this now fails
   closed regardless of whether the env var happens to be set correctly.

This is the recurring pattern worth cataloguing (see pattern #19 for the header/footer one;
this is a new one, #20): **a public-facing endpoint added without exercising it behind the
platform's actual proxy setup can look correct in every local/manual test and still be fully
broken in production**, because the failure mode (`trust proxy` unset) only exists once a real
proxy sits between the client and the app — nothing in local dev or a direct `curl` to the
backend would ever surface it.

## Round 119, post-ship (Ver. 9.31): per-code access control, live tracking, customer leads on the Manager Dashboard, and a Technical Writings library

Business feedback on the round 119 ship, verbatim: "1. i asked for access control to customer,
switch on/off tracking, QC, and technical writings, it is not there. 2. customer leads should
appear in manager dashboard." Four pieces of follow-up work, all building on the round 119
customer portal above rather than changing its shape:

**Customer leads on the Manager Dashboard (`CustomerInquiriesCard`, `SalesPanels.jsx`).** The
public-inquiry leads created above were only visible by going into Browse Leads and filtering —
nothing surfaced them where a Manager actually looks first. A new card on `ManagerDashboard.jsx`
(reusing the same `leads`/`sales/executives` endpoints Browse Leads already calls, no new
backend route) shows the top 5 unassigned, not-yet-won/lost `public_inquiry` leads with an
inline "assign to" dropdown (`PATCH /sales/leads/:id/assign`) and a link through to the full
list.

**Live delivery tracking, not just a status word.** The original round 119 ship only showed an
order's status badge inside the portal — "Tracking" business asked for turned out to mean the
same live per-truck view the public `/track/:token` link and the internal booking-status screen
already show (stage progress, ETA, last-seen time), not a label. Rather than a third
implementation of that view, the truck-card UI was pulled out of `CustomerTracking.jsx` into a
shared `lib/DeliveryTrackingView.jsx` (`TruckCard`, `STAGES`, etc.) and reused as-is inside a new
"Track delivery" panel on each order in the portal, polling the existing
`lib/orderTracking.js` helper (`GET /customer-portal/orders/:id/tracking`, ownership-checked
against the signed-in code's own customer + sites) every 20 seconds while open.

**Per-access-code switches for all three: tracking, QC reports, technical writings.** "Switch
on/off" was the business's own phrasing — this is deliberately per *access code*, not per
customer, since one customer can hold more than one code (e.g. one site engineer's code with
just tracking, a head-office code with everything). `customer_access_tokens` gained three
booleans (`allow_tracking`, `allow_qc_reports`, `allow_technical_writings`, all
`NOT NULL DEFAULT true` so an existing code keeps full access unless someone turns a switch
off). Set at generation time and editable afterward from the same "Portal Access" tab
(`PATCH /customer-access/:id/permissions`, optimistic UI with rollback on failure). The customer
portal's `requireCustomerAuth` re-reads all three live on every request — same reasoning as the
existing `is_active` re-check — so flipping a switch off takes effect on the customer's very
next tap, not at the end of their 180-day session. Each gated section (tracking panel, QC
buttons, the new Technical Writings panel below) simply doesn't render when its switch is off,
and every route it depends on enforces the same switch server-side too, so this isn't just a UI
hide.

**Technical Writings — a document library, distinct from QC PDFs (`technicalWritings.js`,
new "Technical Writings" tab on `CustomerBooking.jsx`, new panel on `CustomerPortal.jsx`).**
Business's "technical writings" turned out to mean something the QC/mix-design PDFs don't cover
at all: a small admin-managed library of guide documents (e.g. "after-pour curing care",
"choosing the right grade for slabs vs. footings") — uploaded, categorized, renamed, and deleted
by Manager/Admin, downloadable by any customer whose access code allows it. This is the first
place in the app that stores a binary file in the database (`technical_documents.file_data
BYTEA`) — a deliberate scale trade-off, fine for a handful of small PDF guides, flagged in
`schema.sql`'s comment and in Known Limitations below as something that would need real object
storage (e.g. S3) if the library grows much larger or if per-order file attachments are ever
added elsewhere. Upload travels as base64 inside a JSON body rather than a real
`multipart/form-data` upload, matching every other endpoint's all-JSON convention (this app has
no multipart middleware anywhere), which meant raising Express's JSON body limit from the
default 100kb to 12mb app-wide — sized deliberately above the 8MB file cap plus its ~33% base64
inflation, after an internal review caught that 10mb would have silently rejected files near the
advertised 8MB limit with a generic error instead of the route's own friendly one. On the
customer side, opening a document decodes the base64 response into a `Blob` and opens it via an
object URL (`URL.createObjectURL`, revoked after 60s) rather than a plain download link, since
the file never lives at a stable server URL the customer's browser could hit directly; if the
browser blocks that as a popup (Safari does this when it happens after an `await`), it falls
back to a same-page navigation instead of silently doing nothing.

Both the tracking-polling panel and the Technical Writings panel are additive UI on the existing
`/portal` — the navigation and screen structure otherwise match what shipped in round 119
above; a broader visual/navigational rework (bottom tab bar, a Home-style dashboard, etc.) was
discussed against an earlier mockup but is out of scope for this round and not reflected here.

### Migration note (round 119)
Run `/setup` after deploying — adds `leads.source`, and two new tables
(`customer_access_tokens`, `customer_access_token_sites`) plus their indexes. Also requires a
new environment variable, `CUSTOMER_JWT_SECRET` (added to `render.yaml` with
`generateValue: true`, same pattern as the existing `JWT_SECRET`) — deploy will still work
without it (falls back to `JWT_SECRET`, and the `requireAuth` fix above closes the resulting
exposure), but setting it explicitly is the correct production configuration since it keeps
customer and staff sessions cryptographically independent as designed, not just logically
independent. Verified with `node --check` on every touched/new backend route and middleware
file, and a clean `npm run build` on the frontend. No live Postgres instance available in this
environment, so `/setup` on deploy remains the first real migration run, same caveat as every
prior round.

## Round 119, post-ship again (Ver. 9.32): customer portal rebuilt to the business's own mockup, self-service ordering, and public marketing pages

The business sent its own 16-screen mockup of the customer portal and asked for the app rebuilt
to match it — with one deliberate departure ("Request Concrete" → "Order Concrete") — and
confirmed sign-in stays the existing code-only flow, not the mockup's phone+OTP screens. Scope
was confirmed up front to cover everything the mockup shows: the bottom-tab portal shell, a
self-service booking form, and the public no-login marketing pages plus the Manager-side editor
for them.

**Where the toggles live, moved to match the mockup exactly.** The three portal switches
(tracking, QC reports, technical writings) added last round were per *access code*
(`customer_access_tokens`) — the mockup shows them per **customer + site**, editable from the
existing Booking Links screen rather than the code-generation form. They now live on
`customer_booking_links` as `tracking_enabled` (already existed), `allow_qc_reports` and
`allow_technical_writings` (new columns), one row per customer+site. `PortalAccessTab` on
`CustomerBooking.jsx` lost its "what this code can see" checkboxes and its Access column
entirely — that screen is now just code issuing/expiry — with a note pointing to Booking Links
for the actual switches. The three booleans on `customer_access_tokens` are left in place
(documented as superseded in `schema.sql`, never dropped) rather than migrated, since a code can
span sites with different settings and there's no single per-code value to migrate them to.

**Customer portal rebuilt from the mockup (`CustomerPortal.jsx`, fully rewritten — flat ~450
lines to a bottom-tab shell around 1000 lines).** Bottom nav (Home / Orders / Track / More)
replaces the old single-screen layout, driven by internal `tab` + drill-down `stack` state
rather than new router routes, matching how `/portal` has always been one route. Home is a
dashboard tile grid; **My Orders** is one merged list — a customer's own pending "Order
Concrete" requests sit alongside their real orders, computed server-side via a `UNION ALL`
across `customer_orders` and not-yet-converted `bookings` and run through one shared
`summarizeStatus()` so the list and the detail screen never disagree on a status label. Order
detail gained a 4-stage stepper, a rescheduled-delivery banner, and a "your team on this order"
contacts card (Sales Executive resolved per-order via `salespersons`/`created_by` fallback,
Site Supervisor per-order and highlighted, Plant Manager and QC Engineer resolved by role since
neither is assigned per-order in the schema — a known simplification, flagged in code). Sign-in
is unchanged (access-code only) beyond a visual restyle to match the mockup, per explicit
instruction not to build the phone+OTP flow shown there.

**Order Concrete — self-service booking, in-portal (`POST /customer-portal/orders`,
`OrderConcreteScreen`).** A signed-in customer can now submit a booking request for one of their
own sites directly from the portal, without a Manager-issued booking link. Recorded on
`bookings` with a new `submitted_via_portal` boolean (both `requested_by` and `booking_link_id`
are `NULL` either way, same as a portal submission's existing signature — the new column is
what lets staff screens tell "customer used their own portal" apart from "customer used a
shared booking link" when displaying provenance). `BookingsQueue` and `ConvertBookingForm` on
the Sales side now show a distinct "Order Concrete (portal)" badge/pre-fill notice for these.

**Public marketing pages, no login (`ServicesPublic.jsx`, `RmcVsSitemix.jsx`,
`TechnicalAssistance.jsx`, `PublicInquiry.jsx` expanded).** Four pages from the mockup that
don't require an account: a Services/Products/Equipment browse page and a Ready-Mix vs.
Site-Mix comparison page, both reading their copy from a new `site_content` JSONB table
(`GET /site-content/:key`, public) rather than being hardcoded, so the business can update
grades/services/fleet copy or the comparison text without a code change; a new "Free Technical
Assistance" callback form (`POST /public-inquiry/technical-assistance`) for a customer who
doesn't yet know their grade/quantity; and the existing "Request a Quote" form
(`PublicInquiry.jsx`) expanded with the mockup's fuller field set (contact name now required in
place of company name, mobile number, optional company/site name, project location, quantity,
grade, mix requirement, free text). Both the assistance form and the expanded quote form land in
the same `leads` pipeline (`source = 'public_inquiry'`) — rather than adding a new `leads.source`
value (which would have meant touching every existing `source === 'public_inquiry'` check across
`LeadsBrowser.jsx`/`SalesPanels.jsx`), the distinction is carried in a new free-text
`leads.notes` column instead, tagged with the topic for the assistance form. All four pages are
linked from the sign-in screen's guest links and from the portal's More tab.

**Manager-side content editor (`SiteContentEditor.jsx`, new "Website Content" item under the
existing Customer Booking menu on all three Masters-menu screens).** Two tabs — Services &
Products, Ready-Mix vs. Site-Mix — editing the same `site_content` rows the two public pages
read, gated Manager/Administrator (`PUT /site-content/:key`). Kept as one screen rather than two
separate Masters entries; it's occasional marketing-copy editing, not transactional data, so a
plain JSONB blob per page was preferred over normalizing services/fleet/points into their own
tables.

### Migration note (round 119, post-ship again)
Run `/setup` after deploying — adds `bookings.submitted_via_portal`, `leads.notes`, and a new
`site_content` table, seeded with two rows (`services`, `rmc_vs_sitemix`) matching the mockup's
copy so the two public pages aren't blank on first deploy. No new environment variables. Verified
with `node --check` on every touched/new backend file and a clean `npm run build` on the
frontend (including the new `/services`, `/rmc-vs-sitemix`, `/technical-assistance`, and
`/site-content` routes registered in `App.jsx`). No live Postgres instance available in this
environment, so `/setup` on deploy remains the first real migration run, same caveat as every
prior round.

## Round 119, post-ship again — round 2 (Ver. 9.33): 8 real-world bug fixes on the rebuilt customer module

After the rebuilt customer module (Ver. 9.32) went live, real testing surfaced 8 issues, all
fixed this round.

1. **Per-order QC Engineer assignment.** The customer portal's "your team on this order" card
   always resolved QC Engineer by role (picking whichever `qc_engineer` user came first) — fine
   for Manager, of which there's genuinely one, but wrong once there's more than one QC Engineer
   on staff. New `customer_orders.assigned_qc_engineer_id` (same pattern as the existing
   `assigned_site_supervisor_id`), settable from Administrator/Manager's "Correct Order" screen
   (new `GET /master/qc-engineers` + a QC Engineer column in `OrdersPanel`). `resolveOrderContacts`
   in `customerPortal.js` now prefers this per-order pick, falling back to the old role-based
   resolution when unset. Manager resolution is untouched, per the business's own clarification.
2. **Stray underlines removed** on the home screen's "Why ready-mix beats site-mix" strip and the
   sign-in screen's guest links to Services/RMC-vs-Sitemix/Technical Assistance — `.portal-strip`
   and `.portal-guest-row` never had a `text-decoration: none` reset, so the app's global `a { color:
   ... }` rule left the browser-default underline showing through.
3. **Portal Access now shows/edits the same tracking/QC/technical-writings switches Booking Links
   does**, instead of pointing Manager at a separate tab with no way back to which sites a code
   even covers. `GET /customer-access` now returns each site as `{id, name}` (was name-only); a
   new `POST /booking-links/ensure` (and its shared `ensureActiveLink` helper) guarantees a
   `customer_booking_links` row exists — with the same defaults as generating a link by hand — the
   moment a site is checked when generating a Portal Access code, and `POST /customer-access`
   itself now also calls it for every site a new code covers. This was the actual root cause of the
   bug: a site that only ever had a Portal Access code (nobody separately visited Booking Links)
   had **no** `customer_booking_links` row at all, which resolved to all three switches off. The
   Portal Access tab can now flip them right on the "Generate a customer access code" form (per
   checked site) and on each existing code via a new "Manage access" expandable row — same
   `ToggleSwitch` + `PATCH /booking-links/:id/permissions` pattern the Booking Links tab already
   used, so either tab edits the same underlying row.
4. **QC reports and technical writings now actually show on the public booking link
   (`/book/:token`)**, not just in the authenticated `/portal` sign-in — the Booking Links tab's
   own copy always promised both, but `customerBooking.js`/`CustomerBookingForm.jsx` were never
   touched in the portal rebuild and had zero QC/technical-writings support. `GET
   /customer-booking/:token` now also returns `qc_reports` (cube tests + approved mix designs,
   scoped to the link's own customer+site) and `technical_writings` (the shared document list)
   when the link's switches allow it, with three new token-scoped routes for the actual PDF/file
   bytes (`/:token/orders/:orderId/mix-design-pdf-data`, `/:token/cube-tests/:resultId/pdf-data`,
   `/:token/technical-writings/:id/file`) mirroring `customerPortal.js`'s equivalents so the
   frontend reuses the same `mixDesignPdf.js`/`cubeTestPdf.js` generators. Also fixed: live
   tracking used to render nothing at all (not even a placeholder) when tracking was switched on
   but no order was live yet — now shows an explicit "no delivery in progress right now" message,
   same as the authenticated portal side already did.
5. **Back navigation added** to the four public pages reachable from the portal's More screen and
   its sign-in guest links (`ServicesPublic.jsx`, `RmcVsSitemix.jsx`, `TechnicalAssistance.jsx`) —
   these are full page navigations (`<a href>`), not pushed portal screens, so `PortalShell`'s own
   back button never covered them. Falls back to `/portal` when there's no browser history to go
   back to. `PublicInquiry.jsx` and `CustomerBookingForm.jsx` got the same Back control, but
   browser-back-only with no forced destination (no `/portal` fallback) — both are meant to be
   opened by an outside visitor or a shared link with no portal account implied.
6. **Customer Feedback screen added to the portal** (new "Feedback" tile on More, gated on nothing
   — every signed-in customer code can leave feedback). Star rating (1–5) + comment, optionally
   tied to one of the customer's own orders. `aftersales_feedback.recorded_by` is now nullable
   (was staff-only `NOT NULL`), with new `rating SMALLINT CHECK (rating BETWEEN 1 AND 5)` and
   `submitted_by_customer BOOLEAN` columns. New `POST /customer-portal/feedback` derives
   `feedback_type` from the rating (4–5 stars = compliment, 1–3 = complaint) so every existing
   reader of the table (the Manager/Admin Feedback tab on Customer Booking, `sales.js`'s `GET
   /feedback`) keeps working unchanged — the Feedback tab now shows a star readout and a "From
   customer" badge when `submitted_by_customer` is set.
7. **"Type of enquiry" shown on customer inquiries, and a way to close one.** A public inquiry's
   type (Request for quote vs. Free Technical Assistance) is derived client-side from the
   `[Free Technical Assistance — ...]` prefix `publicInquiry.js` already tags onto
   technical-assistance leads' `notes` — no new column — and now shows as a badge on both the
   Manager Dashboard's Customer Inquiries card and the Leads page. Closing a lead (declining it)
   had no UI anywhere outside "mark won," even though `POST /sales/leads/:id/lost` already existed
   server-side and already allows Sales Executive/Manager/Administrator — both the dashboard card
   and the Leads detail page now have a "Close" action (reason required) that calls it.
8. **Assigned leads stay visible on the Manager Dashboard**, instead of disappearing from the
   Customer Inquiries card the moment they're assigned — they now stay until actually closed
   (won/lost), showing "Assigned to \<name>" with a Reassign option plus the new Close button,
   so an assigned-but-still-open lead keeps functioning as a reminder for Manager rather than
   vanishing from view. The "N new" badge now counts only genuinely unassigned inquiries.

### Migration note (round 119, post-ship again — round 2)
Run `/setup` after deploying — adds `customer_orders.assigned_qc_engineer_id`, drops the `NOT
NULL` on `aftersales_feedback.recorded_by`, and adds `aftersales_feedback.rating` +
`aftersales_feedback.submitted_by_customer`. No new environment variables. Verified with `node
--check` on every touched backend file and a clean `npm run build` on the frontend. No live
Postgres instance available in this environment, so `/setup` on deploy remains the first real
migration run, same caveat as every prior round.

## Round 119, post-ship again — round 3 (Ver. 9.34): 2 more real-world fixes, plus the Driver & Site Supervisor module rebuild from mockup

1. **Live Tracking tile now actually disappears when tracking isn't enabled**, instead of staying
   visible with a "Not enabled for your sites" subtitle. `HomeScreen` in `CustomerPortal.jsx` now
   wraps the tile in `{showTracking && (...)}`, matching the QC Reports/Technical Writings tiles'
   existing conditional-render pattern — this was the one tile on that screen that hadn't been
   brought in line with that pattern.
2. **Manager Dashboard's "Close" button now hides a public inquiry instead of closing the
   lead.** Round 2 added a Close button to the Customer Inquiries card that called `POST
   /sales/leads/:id/lost` directly — turns out that wasn't what was wanted; closing a lead (an
   actual won/lost decision) should only happen from the Leads page. New `leads.dashboard_hidden`
   column + `PATCH /sales/leads/:id/dashboard-hide` (`{ hidden: true|false }`, Manager/Admin)
   purely dismisses a card from the dashboard widget with no effect on the lead's real status —
   reversible via a new "N hidden — show" toggle at the bottom of the card, so a manager who hides
   one by mistake isn't stuck. The Leads page's own "Close lead" action (from round 2) is
   unchanged and remains the only real close/decline path.
3. **Driver and Site Supervisor modules rebuilt against a new mockup.** The business supplied ~13
   screens covering a redesigned driver trip screen, GPS auto-confirm behavior, and a Site
   Supervisor stack UI. A scoping pass found the backend/DB/geofencing/i18n foundations for nearly
   all of it already existed from earlier rounds — this was mostly a frontend rebuild layered on
   top, plus one real backend behavior change (item 3f below), confirmed with the business before
   building it:
   - **a. Punch-In gating.** Trips, the allowance card, and the quick-action buttons (Report
     breakdown / Fuel / Request repair) are now genuinely locked until the driver punches in —
     previously they rendered regardless of duty status, so "Punch In to unlock" was aspirational
     copy that didn't match the code. Off-duty, `DriverDuty.jsx`'s home screen instead shows a
     centered Punch-In button with "Start your shift to begin" copy, and — if a trip is already
     assigned — a dimmed, non-interactive preview of it with a "🔒 Unlocks after Punch In" badge.
   - **b. Trip screen: truck number, mix grade/quantity, on-duty shift timer.** `TripCard` now
     shows the truck number and `{mix grade} · {quantity} m³` under the site name (both already
     queried elsewhere, just not selected for the driver's own `GET /tickets/my-trips` — added
     `mix_grades` join + `dt.loaded_quantity_m3` there). A live "on duty {Xh Ym}" timer reads
     `driver_duty_log`'s existing `since` timestamp (already returned by `GET
     /driver/duty-status`, just never displayed) and ticks via a 60s interval.
   - **c. Trip Allowance is now its own screen**, not just an inline "Completed today" card on the
     driver's home screen (which stays, now linking through). Same data
     (`trip_allowance_payouts` via `my-trips`), no backend change — scoped to today only, matching
     the mockup itself, which is also today-only.
   - **d. "Other assigned trucks today."** The "older trips need action" banner/list (for a driver
     juggling more than one active trip) is relabeled to match the mockup's framing; the
     underlying data and per-trip `TripCard` were already correct for this, just styled/titled
     around a different mental model ("stuck trips" vs. "your other assignments").
   - **e. Site Out form fix + pill restyle.** The after-pour-care checkbox has said "required" in
     its label since it was built, but `SiteOutForm` never actually enforced it before submit —
     now it does (matching the enforcement `WorkCompleteForm` on the Site Supervisor side already
     had). Delivery Note Status switched from a `<select>` to pill buttons on both the driver's
     `SiteOutForm` and the Site Supervisor's `CompleteForm`, matching the mockup.
   - **f. GPS auto-confirm, extended to all 4 stages, with the business's explicit sign-off on the
     one real behavior change.** `checkPlantOutAutoRecord` (existing, Plant Out only) has 3 new
     siblings — `checkSiteInAutoRecord`, `checkSiteOutAutoRecord`, `checkPlantInAutoRecord` — using
     the same per-site `plant_out_grace_minutes` setting (relabeled "Auto-confirm grace" in Master
     Data → Projects & Sites, since it now covers all four) as the driver's geofence-hint popup
     already used for Plant Out: if the driver doesn't respond within the grace period, the stage
     auto-records from GPS, same as it already did for Plant Out. Site In and Plant In are plain
     timestamp inserts, no new data needed. Site Out is different — it normally also captures site
     slump, delivery note status, and the after-pour-care confirmation from the driver's own form.
     Confirmed with the business directly: when Site Out auto-confirms with no response, those
     fields are left blank (not guessed at) and a new `site_qc.auto_confirmed` flag is set, so
     Manager/QC can see the gap and follow up — trip allowance is still paid, since the concrete
     was genuinely delivered either way. The driver's geofence-hint modal now shows a live
     countdown ("auto-confirms in ~N min") computed from the same grace-period math the server
     actually uses, so the UI matches what really happens. This does **not** extend to the Site
     Supervisor's own geofence hints (arrival/completion) — those stay suggest-only, on purpose;
     see the code comment on `SiteSupervisor.jsx`'s popup for why.
   - **g. Site Supervisor delay-reason sheets.** `confirmPumpDeparture` and `confirmSiteReady`
     used `window.prompt()` to collect a required late-delay reason — replaced with a real bottom
     sheet component (`DelayReasonSheet`), reused for both triggers, with the same "required, no
     skip" enforcement the backend already had (both routes still 400 without `delay_reason` — the
     sheet doesn't change that, just how it's collected).
   - **h. Site Supervisor stack UI.** The plain `<select>` used to switch between multiple
     deliveries at one site is replaced with a stack: the "up next" delivery stays expanded above
     (full stage tracker, now with buttons ~25% larger, matching the mockup), everything else
     collapses into compact tap-to-bring-to-front cards below. Same `GET
     /site-supervisor/my-deliveries` data, no backend change.
   - **i. Reject Concrete banner copy**, on both the driver's and Site Supervisor's `RejectForm`:
     explicitly states the load won't count toward trip allowance and the manager is notified
     automatically — both were already true (rejection never inserts into
     `trip_allowance_payouts`, and `confirmRejection` already notifies the manager), just not
     stated in the UI until now.
   - **j. Language switcher tabs.** Driver-facing screens that are actually translated today (Home,
     Other Trucks, Site Out, Trip Allowance) now show English/Malayalam/Hindi tabs at the top,
     switching instantly via the existing `PATCH /driver/language`, instead of requiring a trip to
     the separate Settings screen (still there, unchanged, for anyone who prefers it). Not added
     to Reject/Breakdown/Repair or Settings itself — those were a deliberate untranslated-content
     decision from round 96/97 that this doesn't revisit. Not added to the Site Supervisor module
     at all — that module has never been localized, and doing so is a materially bigger, separate
     scope than this round covered.

### Migration note (round 119, post-ship again — round 3)
Run `/setup` after deploying — adds `leads.dashboard_hidden` and `site_qc.auto_confirmed`. No new
environment variables. Verified with `node --check` on every touched backend file and a clean
`npm run build` on the frontend. No live Postgres instance available in this environment, so
`/setup` on deploy remains the first real migration run, same caveat as every prior round.
