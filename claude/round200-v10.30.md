# Round 200 — v10.30 — Leave, simpler My attendance, receipts without a weighbridge ticket, transporter ledger

## After deploying
Visit `/setup?key=…` once. It adds:
- **Tables:** hr_leave_types (seeded CL 12, SL 12, EL 15, LOP), hr_leaves, rm_transporter_openings, rm_transporter_payments.
- **Columns:**
  - rm_receipts.wb_approval and its reason/decision columns.
  - rm_materials.wb_exempt.
  - rm_transporters.gstin, pan, credit_days and gst_pct.
- **View:** rm_receipts_effective is redefined.
- **Permissions:** the new ones are seeded.

## 1. HR
- **Attendance machine:** a "← Back to HR" button.
- **My attendance (employee login):**
  - A day that meets the duty hours shows just **P**. Duty hours are the shift's length (9–5 = 8 h), or 8 h for staff with no shift (operators).
  - A day short of the duty hours shows the punches and "worked X of Y", with a **Correct** button.
  - Absent, half and missed-punch days also offer **Leave**.
  - Leave balances for the year; "+ Ask for leave"; requests can be withdrawn while waiting.
- **Leave:**
  - Leave types are set in Settings → Leave types: code, name, paid/unpaid, and days a year (blank = no limit).
  - The **Leave tab** has records, approve/reject, "+ Record leave" for an employee, and **Balances** per employee per year.
  - From the Attendance register: click an absent / half / missed day → **Record leave for this day**.
  - Someone who may decide can record it as approved in one step.
  - **Approval:**
    - The Plant Manager approves.
    - Admin approves the Plant Manager's own leave and any leave beyond the yearly allowance.
    - Nobody approves their own.
    - Rejecting needs a note. Only Admin can cancel an approved leave.
    - Leave touching a locked payroll month is refused.
  - **Days counted:** weekly off and holidays inside the range are not leave. A half-day leave is 0.5.
  - **Register:** an approved leave shows its type code (CL, SL, LOP…) instead of A, MIS or NL. A day the person actually worked stays P (flagged). A half-day leave on a half day makes it a full paid day.
  - **Payroll:** paid leave counts as paid days; unpaid leave is loss of pay. The line detail shows "Leave — paid · unpaid".
  - The allowance runs per calendar year (Jan–Dec).

## 2. Receipts without a weighbridge ticket need Admin approval
- When Store saves a receipt with no ticket linked, they must say why. The receipt saves as **waiting for Admin**.
  - Until approved it is not in stock, the silo level or the supplier ledger. The supplier ledger shows it under "received, not billed".
- **Receipts tab, top:** Admin sees the queue. For each receipt it offers the unclaimed weighbridge loads for the same supplier and material within ±3 days.
  - **Link #ticket** links that load to the receipt; no approval is then needed.
  - Otherwise: **Approve without ticket**, or **Reject** with a note. A rejected receipt never counts; edit or delete it.
- In Edit, an admin can type a ticket number to link a ticket.
- Removing a ticket from a receipt sends it back to Admin.
- **Exemption:** on Materials, tick "Not weighed on the weighbridge" (e.g. admixture drums). Its receipts need no ticket and no approval.
- Receipts saved before this round are unaffected.
- **Permission:** `material.receipt-wb-approve` (Administrator).

## 3. Transporter ledger (new tab in the Material Module)
- **What a freight bill is:** every counted receipt on an **ex-factory** order with a transporter.
  - Amount = the receipt's freight rate and basis (per unit / per kg / per trip) on the accepted quantity, plus the transporter's GST % (default 0).
  - On delivered orders the supplier carries freight, so no transporter bill.
  - Loads with no freight rate are listed for fixing.
- **Overview:** what we owe, overdue, freight booked, paid this month, and freight waiting for approval; then one row per transporter.
- **Statement:** period filter with brought-forward, running balance, unpaid freight with due dates (credit days) and Excel download.
- **Record payment:** amount, TDS, mode, UTR, note. Payments plus TDS settle the oldest freight first.
- **Opening balance:** one figure — owed, or advance paid.
- **Edit terms:** phone, PAN, GSTIN, credit days and GST %.
- Payments are cancelled with a reason, never deleted.
- **Permissions:**
  - `material.transporter-ledger` (view): Administrator, Accountant, Manager.
  - `material.transporter-payments`: Administrator create/delete; Accountant create.

## Tested
- **Leave:**
  - Admin record + approve-now.
  - LOP shows as unpaid; a half SL on a half day.
  - Overlap refused.
  - Sat–Mon range counts 2 days.
  - A 14-day CL goes to Admin (over 12).
  - Driver's self request → PM approves.
  - PM's own leave → PM refused, Admin approves.
  - Reject needs a note.
  - Payroll: E1 paid days 24 → 25.5 (1 CL + ½ SL), LOP counted unpaid.
  - Locked month refuses new leave and cancelling.
  - Balances are correct.
  - My attendance: 19 days met = P only; 4 days "P but short" show punches (e.g. 7 h 18 m of 8 h).
- **Receipts:**
  - With a ticket, the receipt counts.
  - No ticket and no reason is refused; with a reason it waits for Admin.
  - An exempt material counts directly.
  - The queue shows the candidate ticket. Linking clears it. Reject needs a note.
  - Approving puts it in stock. Unlinking sends it back.
  - The supplier ledger shows it as not billed.
- **Transporter ledger:**
  - 69 MT × ₹300 + 5% GST = ₹21,735.
  - With an opening of ₹5,000 and a payment of ₹9,800 + ₹200 TDS, the opening is cleared first, then 5,000 of R-0001, leaving 2,875.
  - Due dates are +15 days.
  - Future dates are refused; NEFT without a UTR is refused.
  - Cancelling restores the balance.
- `npm run check` passes and `vite build` succeeds. Every screen was opened in a browser at desktop width and at 390 px with no page errors and no sideways scroll.

## Files
- **backend:**
  - schema.sql
  - src/lib/hrSchema.js
  - src/lib/hrAttendance.js
  - src/lib/hrPayroll.js
  - src/lib/permissionCatalogue.js
  - src/lib/supplierLedger.js
  - src/lib/receiptApprovalSchema.js (new)
  - src/lib/transporterLedger.js (new)
  - src/routes/hr.js
  - src/routes/materialModule.js
  - src/routes/plant.js
  - src/routes/setup.js
- **frontend:**
  - src/lib/version.js
  - src/pages/AttendanceMachine.jsx
  - src/pages/HrModule.jsx
  - src/pages/HrStage2.jsx
  - src/pages/HrLeave.jsx (new)
  - src/pages/MyAttendance.jsx
  - src/pages/MaterialModule.jsx
  - src/pages/TransporterLedger.jsx (new)
