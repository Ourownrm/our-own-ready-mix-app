# Round 202 — v10.32 — Phone attendance with face check, Today dashboard, comp-off, monthly CL, trip allowance fix

Includes Round 201 (v10.31): "batches" label, My attendance link fixes.

## After deploying
1. Visit `/setup?key=…` once. It adds:
   - tables: hr_compoff_claims, hr_work_locations, hr_employee_faces, hr_app_punches
   - leave-type columns: period, carry_max, not_on_probation, for_contract, kind
   - employee columns: app_punch, device_id
   It also sets CL to 1 a month (no carry forward, not on probation, payroll staff only) and adds the **CO** comp-off leave type.
   It switches phone attendance on for employees with an app login: "anywhere" for sales/app-source staff, "at the plant" for the others. Drivers are never switched on. From today, app-source (sales) attendance is judged on face-checked phone punches; earlier days keep the sales duty log.
2. In HR → Settings → **Work locations**, add the plant: stand at the gate with a phone and tap "Use where I am". Radius defaults to 200 m.
3. In HR → Employees → edit each phone user → **Take photo**, which enrols their face. Until a person is enrolled, they can't mark on the phone (the gate machine still works).
4. The frontend has a new package, `@vladmandic/face-api`, so `npm install` runs on deploy. The models are in `frontend/public/face-models` (≈7 MB). They are fetched only when the Mark attendance or enrolment screen opens; the app's offline cache doesn't include them.

## Owner decisions applied
- **Face check for everyone who marks attendance on the phone.**
- **Who can use the phone:** only staff who already have an app login. Drivers use the gate machine only. No attendance-only logins.
- **Comp-off:** 8 h on an off day = 1 day, 4 h = ½ day. Claim within 30 days; it expires 60 days after the day worked. All four numbers are settings. **Correction from the owner:** a person may ask for a full day even when the hours qualify for less, and the approver chooses **1 day or ½ day**.
- **CL:** settles monthly with no carry forward. People on probation and contract workers don't get it. Probation = 3 months from joining (a setting).

## What's new
- **Mark attendance** (header link and My attendance button, phone). A punch passes three checks:
  1. **Registered phone.** The first phone used is registered. HR can move it ("Move to a new phone").
  2. **Location.** "At the plant" must be inside a work location's radius, with GPS no worse than ±50 m. "Anywhere" accepts any location and saves it.
  3. **Face.** The phone reads the face (face-api) and asks for a blink. The **server** compares the face with the enrolled one (distance ≤ 0.5), so the phone's own verdict is never trusted.

  If the face fails 3 times, the punch is saved with its photo for the manager: Requests → **Phone punches to check**, with this punch's photo next to the enrolled photo. The Plant Manager approves; Admin approves the Plant Manager's own. Outside the plant → refused, with a link to ask for On duty. Photos are deleted after 90 days.
- **Phone punches in the register.** They are merged with machine punches (shown as "(phone)"); first and last punch count, whichever source they came from.
- **HR → Today:**
  - Tiles: present now / due (machine vs phone), not punched in (no punch 20 min after shift start, a setting), late, on leave, on duty outside, off, and yesterday's uncorrected missed punches.
  - A list of who hasn't punched in, with Call and Record leave; late list; department table; 7-day present %. Refreshes every 5 minutes.
- **HR → Comp-off:**
  - Claims with the day's punches as evidence; Approve 1 day / Approve ½ day / Reject.
  - Record a claim for someone.
  - Balances: earned, used, waiting, lapsed, next expiry.
  - An approved comp-off day is not also counted as overtime.
  - To **use** comp-off, record a CO leave on any absent or planned day, from the Leave tab, the register or My attendance. It's refused if there's not enough comp-off on that date; the earliest-expiring comp-off is used first.
- **My attendance:**
  - Off days worked in the last 30 days, with "Claim ½ day / 1 day" or "Ask for 1 day".
  - Comp-off claims in My requests.
  - Leave chips show "1 of 1 left for Oct 2026", comp-off available, and next expiry.
- **Leave types** (Settings):
  - Given once a year or every month.
  - Carry forward up to N days, or lapse.
  - Not during probation; contract workers get it or not.
  - Balances follow these rules everywhere, and leave beyond the period's allowance goes to Admin.
- **Trip allowance diagnostics.** Payroll now says why trip allowance is zero:
  - "Gets trip allowance" isn't ticked, though trips exist — the line shows the trips and amount.
  - No app login is linked.
  - No trips are recorded for that login.

  A banner lists driver logins with trips that **no employee is linked to**. Fix: Employees → edit → App login = the driver's login, tick Gets trip allowance, then recalculate.
- **New payroll rules:** probation months, comp-off ×4, not-punched-in minutes, GPS accuracy, face match distance, face tries, photo keep days.

## Tested
- **Leave:**
  - CL: 1 in October OK; a 2nd in October goes to Admin; November is a fresh allowance.
  - Contract worker refused; probation refused, with the end date.
- **Comp-off:**
  - Claim checked against punches; duplicate and too-old claims refused.
  - Using CO before approval is refused.
  - After approval the register shows "comp-off earned" and overtime drops to 0. Using more than the balance is refused.
  - A 1-day request on 4h14m (qualifies ½) can be approved as 1 day.
- **Phone, API:**
  - The driver is told to use the machine; not enrolled is refused, and so is a missing location.
  - GPS ±120 m refused; 2 km away refused with the distance; no blink refused.
  - Good punch counted; wrong phone refused.
  - Third failed try saved for review. Plant Manager can't approve their own; Admin approves.
  - Sales "anywhere" punch 25 km away accepted, with the location saved. Moving the phone works.
- **Phone, browser** (camera fed a sample photo):
  - Enrolment read the face (128 numbers stored).
  - On the phone, the same face matched at distance 0.000. With no blink → 3 tries → saved for review.
  - A tilted face → "No face found" ×3 → saved for review.
- **Trip allowance:** unticked → warning with ₹; unlinked → warning plus banner; linked → ₹300 paid.
- `npm run check` passes and `vite build` succeeds. Screens were checked at desktop and 390 px with no page errors.

## Files
- **backend:**
  - schema.sql
  - src/index.js
  - src/lib/hrAttendance.js
  - src/lib/hrLeave.js (new)
  - src/lib/hrPayroll.js
  - src/lib/hrRules.js
  - src/lib/hrSchema.js
  - src/routes/hr.js
  - src/routes/hrPunch.js (new)
- **frontend:**
  - package.json
  - package-lock.json
  - vite.config.js
  - public/face-models/ (6 files, new)
  - src/App.jsx
  - src/index.css
  - src/lib/TopBar.jsx
  - src/lib/api.js
  - src/lib/faceKit.js (new)
  - src/lib/version.js
  - src/pages/HrLeave.jsx
  - src/pages/HrModule.jsx
  - src/pages/HrPhone.jsx (new)
  - src/pages/HrStage2.jsx
  - src/pages/HrToday.jsx (new)
  - src/pages/MarkAttendance.jsx (new)
  - src/pages/MyAttendance.jsx
  - src/pages/PlantProduction.jsx
- **claude:** round201-v10.31.md, round202-v10.32.md
