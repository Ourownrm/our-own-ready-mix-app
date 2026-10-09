# Round 199 — v10.29 — Fuel module

Diesel moves out of Store into its own **Fuel** module. Lubricants stay in Store.

## After deploying
Visit `/setup?key=…` once. It adds four tables: fuel_settings, fuel_settings_log, fuel_rate_history and fuel_exception_reviews. It also seeds the new permissions. Then an Administrator opens **Fuel → Settings** and enters the **tank capacity** (and checks the reorder level). The tank picture and the alerts need the capacity.

- The reorder level carries over from Store Stock.
- Today's rate per litre becomes the first entry in the rate history.
- Anyone who could open the 360° Fuel Analysis gets the Fuel module switch automatically, so nobody loses access.

## Owner decisions applied
- Lubricants stay in the Store module; only diesel moves.
- No dip readings. The closing stock is the ledger's own balance.
- Tank capacity is an Administrator-only setting. Manager and Store can see it.
- The existing 360° Fuel Analysis moves into the Fuel module with its logic unchanged, and gets new views added around it.
- The "fill bigger than the vehicle's own tank" check was left out. The masters don't store a vehicle tank size.

## Nothing underneath changed
- The diesel balance is still the fuel row in store_stock_items.
- Every change to it is still a store_stock_transactions row.
- Purchases are still store_stock_purchases.
- Issues are still supply_requests: QR scan at the plant, or the driver's own confirmation for an outside station.

The Fuel module reads these tables. Store, Supply Approvals and the Fuel module can't disagree about a litre. Approving, issuing, receiving and adjusting use the same endpoints as before.

## What's new
- **Dashboard.**
  - A drawing of the tank filled to today's level: green when healthy, amber when the reorder level is near, red below it. The reorder level is a dashed red line.
  - Litres in the tank, empty space, days of cover, days to the reorder level and the last delivery.
  - An alert naming the purchase that's waiting.
  - A 14-day tank-level chart with deliveries marked, and daily issues split by trucks, pumps and plant equipment.
  - Top consumers this month and recent transactions.
- **Transactions.** One ledger for every litre: deliveries in, plant issues out and Manager adjustments, with a running balance. Outside-station fills are shown in brackets; they never change the tank balance.
  - Filter by type, category, vehicle or machine, or search.
  - Open a row to see who requested, approved and issued it, and how its consumption was worked out (L/100km for trucks, L/hr for machines).
  - Manager can adjust the stock from here. Export to Excel.
- **Issue fuel.** Every fuel request still waiting, in three groups: waiting for approval, ready to issue at the plant, and approved for an outside station. Buttons open the existing approval screen and QR scan.
- **Purchases.** Diesel purchases: request, approve or reject, receive (rate paid), and delete. These moved here from Store Stock.
- **360° Analysis.** Your existing Trucks and Pumps & equipment views are unchanged: L/m³ is still the main figure, with the same fill-to-fill drill-downs. Added around them:
  - **Overview:** the whole plant's fuel against m³ actually produced, where the fuel went, tank received vs issued over 6 months, and why the fuel bill changed (more litres vs a higher rate).
  - **Compare with** the period just before or the same dates last year, on every headline figure.
  - **6-month trend** and status columns for every truck and machine. A truck's drill-down gains a month-by-month chart and its own exceptions.
  - **Exceptions:**
    - high consumption
    - meter reading went backwards
    - two fills close together
    - fuel issued outside working hours
    - outside fill while the plant tank was above its reorder level
    - fill with no meter reading

    Manager can mark each one reviewed with a note.
  - **Approvals:** litres cut at approval, median request → approve and approve → issue times, who issued how much, and which vehicles were cut most.
- **Reports.** Stock statement for any date range, by day, week or month: opening + deliveries − issues ± adjustments = closing. Excel export. Links to the existing Fuel and lubricant request report.
- **Settings** (Administrator edits, others view):
  - Tank name, capacity, reorder level and early-warning days.
  - The 360° status bands. They default to the 12% / 3% / 10% the analysis has always used.
  - Exception checks: the close-fills window and working hours.
  - Rate per litre with history.
  - A log of every settings change.

## Changes elsewhere
- **Store Stock** shows lubricants only, with a note pointing to the Fuel module.
- **Store home** has a new **Fuel** button.
- On the Manager dashboard, the diesel tile on the stock card opens Fuel.
- The **Fuel** tile appears on the Modules page for anyone with the module.
- The 360° Fuel Analysis menu links now open it inside Fuel. The old `/fuel-analysis` address redirects there.
- A rate set from the old Store Stock screen is also written to the Fuel rate history.

## Permissions
| Function | Default roles |
|---|---|
| `module.fuel` (the module switch) | Administrator, Manager, Store, Accountant |
| `fuel.dashboard`, `fuel.transactions`, `fuel.reports` | Administrator, Manager, Store, Accountant (view) |
| `fuel.issue` | Administrator, Manager, Store (view) |
| `fuel.purchases` | Administrator, Manager (all); Store (view / create / edit) |
| `fuel.settings` | Administrator (view / edit); Manager, Store (view) |
| `fuel.exception-review` | Administrator, Manager |
| `reports.fuel-analysis` (the 360° tab) | unchanged: Administrator, Manager |

All of these appear under **Fuel** on the Access Control page.

## Tested
- Built a local Postgres from this round's schema and `/setup`, then loaded 90 days of fuel history.
- Every new endpoint returns correct figures: the ledger reconciles (opening + received − issued ± adjusted = closing).
- Permissions refuse the wrong roles (Manager or Store editing settings, Store reviewing, Accountant on Issue or the 360° tab, a driver on any of it).
- `npm run check` passes, the frontend builds, and every Fuel tab was opened in a browser as Admin, Store and Accountant, and on a phone, with no page errors.

## Files
- **backend:**
  - src/index.js
  - src/lib/fuelSchema.js (new)
  - src/lib/permissionCatalogue.js
  - src/routes/fuelModule.js (new)
  - src/routes/setup.js
  - src/routes/storeStock.js
- **frontend:**
  - src/App.jsx
  - src/lib/version.js
  - src/lib/adminScreens.js
  - src/lib/StoreStockCard.jsx
  - src/pages/FuelModule.jsx (new)
  - src/pages/FuelAnalysis.jsx
  - src/pages/ManagerDashboard.jsx
  - src/pages/Reports.jsx
  - src/pages/StoreHome.jsx
  - src/pages/StoreStock.jsx
  - src/pages/fuel/ (new folder): fuelUi.jsx, FuelDashboard.jsx, FuelTransactions.jsx, FuelIssue.jsx, FuelPurchases.jsx, FuelAnalysis360.jsx, FuelReports.jsx, FuelSettings.jsx
- **claude:**
  - round199-v10.29.md
