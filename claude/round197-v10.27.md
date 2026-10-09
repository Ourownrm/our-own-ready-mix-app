# Round 197 — v10.27: HR module, stage 1 (employees, attendance, roster, settings)

Built on GitHub main (v10.26, includes Round 195 attendance machine). **Deploy:** upload the zip → Render
redeploys → **visit `/setup?key=…` once** (new tables; seeds 8 departments + "Office 9 to 5" shift; seeds the
new HR permissions for existing roles).

## Owner's decisions (9 Oct 2026) built in
- Office staff 09:00–17:00 (shift "Office 9 to 5": grace 10 min, full day ≥ 7 h, half day ≥ 4 h — editable).
- Operations staff: shift as rostered by the manager per day; no roster entry = judged on hours only (7 h full,
  4 h half), no late marks.
- Late in / early out: **highlighted only** (orange dot, counts per month) — no automatic deduction.
- Reporting: Plant Manager over staff, Plant Manager → Admin (used for stage 2 approvals).
- Sales incentive per employee: none / on production above a minimum (₹ per m³ above it) / on own sales —
  fields stored now, calculated in stage 2.
- Employees entered manually in the app.
- NOT answered yet: what an unresolved missed punch becomes at payroll lock (½ day or absent). Until then it
  stays "MIS" and is not counted as paid.

## Tables (lib/hrSchema.js, end of schema.sql)
hr_departments (is_direct for the cost split), hr_shifts (end < start = overnight), hr_employees (code, dept,
designation, payroll/contract, DOJ/DOL, attendance_source machine|app|none, machine_user_id unique among active,
app_user_id unique among active, policy office|operations, default shift, weekly_off, trip_allowance; pay:
basic/DA/HRA/conveyance/special, PF/ESI flags, contract daily rate + service %, incentive basis/min m³/rate),
hr_holidays, hr_roster (employee × date → shift or off).

## Attendance engine (lib/hrAttendance.js) — computed on request, nothing stored
- Machine punches (attendance_punches) by machine number; sales staff from sales_duty_log (day counts only
  with a located Punch In; un-located = NL).
- Day window 04:00–04:00 IST; stretched to shift end + 4 h when the day's shift runs past midnight.
- Codes P / HD / A (incl. short hours) / MIS (one punch) / NL / WO / H / IN (today, still at work).
- Late = first punch − (shift start + grace); early = shift end − last punch beyond grace.
- Employees not linked to the machine/app show blank, not absent.
- Summary: present, half, absent, missed, late, early, paid days (P + ½·HD + WO + H; MIS/NL excluded).

## API (routes/hr.js, /api/hr) and permissions
GET /meta · GET/POST/PATCH /employees · POST/PATCH /departments, /shifts · POST/DELETE /holidays ·
GET/PUT /roster · GET /attendance?month=.
New HR module in access control (module.hr; hr.attendance, hr.employees, hr.salary, hr.roster, hr.settings).
Defaults: Administrator all; Plant Manager (manager) attendance, employees (add/edit), roster (edit),
settings (view); Accountant view. **hr.salary is Administrator-only** — others never receive pay fields and
cannot change them (dropped, not zeroed).

## Screen /hr (pages/HrModule.jsx), tile "HR" (replaces the Round 195 Attendance Machine tile; that screen is
a link inside HR)
- Attendance: month register, sticky names, colour codes, orange dot for late/early, click a day for punches;
  attention chips (missed punches, late arrivals, no-location, not linked); department filter, search.
- Employees: list, add/edit form (basic, attendance link with machine numbers showing name-on-machine and last
  punch, app login, timing, weekly off, trip allowance; Pay section only with hr.salary); "machine numbers
  punching but not linked" chips prefill a new employee.
- Roster: week grid of operations staff, shift/Off per day, Copy last week, Save.
- Settings: shifts, holidays, departments.

## Verified
Fresh DB /setup ×2; upgrade simulation seeds the 6 new keys (manager/accountant as above); 2,530 real Sep–Oct
punches through the agent; register checked by hand on sample days (late/early, half day, MIS, weekly off,
holiday, rostered day/night shift, worked on off day, sales app P/NL/A, unlinked blank); manager login: no
pay fields, PATCH keeps salary unchanged, settings create 403; npm run check green; vite build clean;
screenshots desktop + 390 px (no horizontal page scroll).

## Next (stage 2)
Manual attendance requests + approval (Plant Manager → Admin), missed-punch rule at lock, overtime, monthly
payroll (trip allowance from trip_allowance_payouts, incentive, PF/ESI, contractor bills), then stage 3
Manpower Cost dashboard.
