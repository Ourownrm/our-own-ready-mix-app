# Round 201 — v10.31 — small fixes

No `/setup` needed.

- **Plant Production → Recent loads:** the "mixes" count is now **"batches"**, on the phone cards and in the desktop column header.
- **"My attendance" missing for some employees.** Two causes fixed:
  1. The header asked once per session whether the login is linked to an employee, and remembered a **no**. Someone HR linked after they had signed in never saw the link until they closed the app. Now only a **yes** is remembered; a **no** is asked again, at most every 10 minutes.
  2. On a phone the header links did not wrap, so with several links "My attendance" could be pushed off the edge of the screen. They now wrap onto a second line.
- **Still required:** My attendance only appears for an employee whose HR record is linked to an app login (Employees → edit → "App login"). Employees with no app login can't see it. The v2 mockup proposes an attendance-only login for them.

Files: frontend/src/pages/PlantProduction.jsx, frontend/src/lib/TopBar.jsx, frontend/src/index.css, frontend/src/lib/version.js
