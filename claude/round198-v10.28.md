# Round 198 — v10.28 — HR stage 2: requests, payroll, advances, salary paid

## After deploying
Visit `/setup?key=…` once. It adds hr_settings, hr_requests, hr_advances, hr_payroll_runs and hr_payroll_lines. It also adds `salesperson_id` and `ot_eligible` to hr_employees, and seeds the three new permissions.

## Owner decisions applied
- **Incentive "minimum production"**: for a salesperson it is their own customers' production (`own_production`, linked through Employee → Salesperson). For a manager or management it is total plant production (`plant_production`).
- **"Sales brought by him"** (`own_sales_paid`): counts only invoices the customer has fully paid. An invoice counts in the month its payments first reach the invoice total.
- **m³** = loaded quantity of non-cancelled tickets in the month, minus the quantity rejected at site QC.
- **Missed punch still open at lock**: half day by default. Change it in HR → Settings → Payroll rules.
- **Late marks**: highlighted only. No deduction.

## What's new
- **Requests tab.** Corrections can be: missed IN, missed OUT, on duty / site visit, or present for the whole day.
  - The Plant Manager approves.
  - These go to Admin instead: the Plant Manager's own requests, anything older than 3 days, whole manual days, and more than 3 missed punches per person per month.
  - Nobody can approve their own request. Rejecting needs a note.
  - Machine punches are never changed; an approved request is shown beside them (✓ in the register).
- **My attendance** (link in the top bar): any login linked to an employee sees their month and can raise or withdraw a request.
- **Payroll tab.**
  - Calculate or recalculate a draft month. Lock it once the month is over; locking freezes the figures.
  - Tap a row for the full breakdown: paid days, earnings, OT, trip allowance, incentive, PF / ESI / PT, advance, other earnings and deductions, and cost to company (employer PF and ESI, bonus, gratuity, contractor service charge).
  - On a draft you can edit OT hours, other earning, other deduction and remarks.
  - On a locked month, record **salary / wages paid** (amount, date, mode, reference) per person, or use "mark all unpaid as paid".
  - Download Excel.
  - A month can't be unlocked while payments are recorded.
- **Advances tab.** Record money given before payday: date, amount, mode, reference, and which month's salary it is recovered from. It is deducted automatically in that month's payroll. Advances are closed for a locked month.
- **Overtime** is paid only to employees with "Paid overtime" ticked; it is off by default. The punches suggest the hours, and the suggestion is shown for everyone.
- **Payroll rules card** (Settings): missed-punch rule, request limits, OT rules, PF / ESI / PT / bonus / gratuity rates. PT differs by state, so set the plant's own figure.

## Permissions
- `hr.requests`: Administrator, Plant Manager (view / create / edit), Accountant (view).
- `hr.payroll`, `hr.advances`: Administrator only by default. They are not auto-viewable; grant them on Access Control.

## Files
- **backend:**
  - schema.sql
  - src/lib/hrSchema.js
  - src/lib/hrRules.js (new)
  - src/lib/hrPayroll.js (new)
  - src/lib/hrAttendance.js
  - src/lib/permissionCatalogue.js
  - src/routes/hr.js
- **frontend:**
  - src/App.jsx
  - src/lib/TopBar.jsx
  - src/lib/version.js
  - src/pages/HrModule.jsx
  - src/pages/HrStage2.jsx (new)
  - src/pages/MyAttendance.jsx (new)

## Next (stage 3)
Manpower Cost dashboard, fed into the Cost Dashboard.
