# Round 203 — v10.33 — Outside fuel fills closed properly, approval rules, Admin cancel

## After deploying
Visit `/setup?key=…` once. It adds columns to supply_requests (how an outside fill was closed, bill no., note, reminder times, cancel, approved rate) and to store_stock_purchases (approved rate, cancel). It also seeds three new permissions. Nothing existing changes.

## Owner decisions applied
- Stations give a few days' credit. When the bill and the driver's entry disagree, the Manager decides.
- Store **or** Manager can close an outside fill from the office. "Not filled — cancel" is Manager.
- Admin can cancel approved purchase requests and approved issue requests.
- A plant-tank issue can't be approved for more than the stock.
- An outside-pump fill and a diesel purchase are approved only after the rate per litre is written.

## Outside-station fills
Before this round, an approved outside fill became "issued" only if the person who raised it tapped *Mark as filled*. Many never did.
- **Driver's card.** "Share to station" is the main button. Once the slip is shared, the card turns into a bold **"Confirm what was filled"** step. The card remembers this on the phone. **Litres and amount are both required**, and more than the approved litres is refused (the office closes those from the bill). "Already filled? Confirm now" is there for a slip shown another way.
- **Whoever is driving the vehicle today can confirm.** That means the person who raised it, anyone with a delivery ticket on that truck today or on the approval day, or anyone who ran that pump (pump log). A supervisor-raised request now appears on the driver's screen with "Raised by …".
- **One open outside fill per vehicle.** The vehicle can't raise another fuel request until its last outside fill is confirmed or closed. The form says so before it's filled in, and the server refuses. Lubricants aren't blocked.
- **Reminders.**
  - After 2 hours: a push to whoever raised it and today's drivers of that truck.
  - After 12 hours: a push and notification to the Manager.
  - Each fires once (timestamps on the request, not the notifications table).
- **Office close** (Fuel → Issue fuel → *Approved for an outside station*). Each row shows the rate, how long it has been open, and whether the reminders went out.
  - **Enter from bill** (Store or Manager): litres, amount (suggested from litres × approved rate), bill no., filled on (defaults to the approval time, never "now"), and a note. A note is required if the bill is more than approved.
  - **Not filled — cancel** (Manager): reason required.
- **Dashboard alert** when an outside fill is open more than 24 hours, with a button to Issue fuel.
- The **transaction ledger** says how each outside fill was closed: confirmed by the driver, or entered from the station bill (with bill no. and note).
- The 360° **Approvals** view counts "not filled" cancellations separately from rejections.

## Approval rules
- **Stock check (plant tank).** Approving fuel at the plant station is refused when the quantity is more than the tank can give. That is the current balance minus plant requests already approved and not yet issued, so two approvals can't promise the same litres. The approval screen shows "Plant tank: X L can be approved" and disables Approve when over. Outside-station approvals don't draw on the tank and aren't checked.
- **Rate before approval.**
  - **Outside fills:** the Manager types the rate at that station; the screen shows an estimated amount. The rate is saved on the request, printed on the driver's slip, and used to suggest the amount when confirming or entering from the bill.
  - **Diesel purchases:** the rate per litre is required to approve (on Supply Approvals and in Fuel → Purchases). Receiving the delivery uses it unless a different rate paid is entered.
  - Lubricant purchases and plant issues are unchanged (plant issues use the standing rate).

## Admin cancel
- **Approved issue request** (plant or outside): *Cancel* in Fuel → Issue fuel. A reason is required, the requester is notified, and the plant QR stops working at once.
- **Approved diesel purchase:** *Cancel* in Fuel → Purchases, with a reason.
- Both are recorded as rejected with "Cancelled after approval — …", plus who cancelled and when.

## Permissions (new)
| Function | Default |
|---|---|
| `fuel.outside-close` — close an outside fill from the bill | Administrator, Manager, Store |
| `fuel.outside-cancel` — cancel an outside fill not filled | Administrator, Manager |
| `fuel.cancel-approved` — cancel an approved issue request or diesel purchase | Administrator |

## Build fix included
`frontend/vite.config.js`: the main bundle was 2.09 MB in v10.32, a few KB under the PWA plugin's 2 MiB precache limit, and any growth made `vite build` fail (and so the Render deploy). The limit is now 4 MiB. Splitting the bundle into lazily-loaded screens is the longer-term fix.

## Tested
- Local Postgres from this round's `/setup` with 90 days of test fuel data.
- 44 API checks pass:
  - who can confirm, and blocking and unblocking
  - litres/amount rules and the office close dated to the bill
  - cancel permissions and reminders firing once
  - the 24-hour alert, the ledger trail and approvals counts
  - outside approval needs a rate, the plant approval stock check (including litres already approved)
  - Admin cancel freeing the litres and killing the QR
  - diesel purchase rate and receipt at the approved rate; lubricant purchases unaffected
- `npm run check` passes, and the frontend builds and lints clean.
- Driver (phone), Store, Manager and Admin screens opened in a browser with no app errors.

## Files
- **backend:**
  - src/index.js
  - src/lib/fuelSchema.js
  - src/lib/permissionCatalogue.js
  - src/lib/scheduledChecks.js
  - src/routes/fuelModule.js
  - src/routes/storeStock.js
  - src/routes/supplyRequests.js
- **frontend:**
  - vite.config.js
  - src/lib/version.js
  - src/pages/FuelFilling.jsx
  - src/pages/SupplyApprovals.jsx
  - src/pages/fuel/FuelAnalysis360.jsx
  - src/pages/fuel/FuelDashboard.jsx
  - src/pages/fuel/FuelIssue.jsx
  - src/pages/fuel/FuelPurchases.jsx
- **claude:**
  - round203-v10.33.md
