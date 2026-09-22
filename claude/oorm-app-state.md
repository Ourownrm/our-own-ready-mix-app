# OORM App — Current State (as of App 150, Ver. 9.75)

Reference doc for continuity across sessions. Full round-by-round changelog lives in the
zip's `oorm-app/README.md` (130+ rounds) — this is a condensed map of where things stand,
not a replacement for it. When picking up work, re-read the latest zip's README for
anything recent; this doc is a snapshot.

**Note on this doc's history**: an earlier update accidentally replaced this file's full
prior content (Stack/Roles/Core modules/Known Limitations/Recurring bug patterns #1-22)
with just a later round's section — that older content could not be recovered and was not
re-created here to avoid fabricating detail. The README.md inside the zip has the complete,
unbroken round-by-round history; this doc is condensed from round 119-post-ship-again-round-5
onward only. Worth rebuilding the fuller sections from the README in a future session if useful.

**Code-comment round numbers vs. README round numbers**: inline code comments use the bare
**App number** (e.g. "round 121"), while `README.md` section headers spell the same round out
as an ordinal word plus `(App N / Ver. X.X)`. These are the same round, two different labels
— cross-reference via the App number, not the ordinal count.

**Also see** `claude/PROJECT_INSTRUCTIONS.md` for the round workflow, migration philosophy, PDF
layout-testing technique, and recurring architecture gotchas — that doc is the operating manual;
this one is the changelog snapshot.

**Migrations require a manual step — worth restating here since it caused real confusion in
Round 132's follow-up**: `backend/src/routes/setup.js`'s migrations are additive
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`/`CREATE TABLE IF NOT EXISTS` statements, but they only
run when someone visits `<backend URL>/setup?key=<SETUP_SECRET>` in a browser — NOT automatically
on backend startup or on deploy (a plain `router.get("/setup", ...)`, gated on that key). After
delivering a round with a schema change, the user needs to visit that URL once; forgetting to
causes exactly the kind of generic "Something went wrong" error a missing column produces (the
app's error handler is deliberately plain-language, so it never surfaces the real Postgres error
to the user — see `index.js`'s final `app.use((err, req, res, next) => ...)`).

## Round 150 (Ver. 9.75): device pairing codes, and a CORS bug Round 149 hid

**Visit `/setup?key=...` once** — one new table (`solitaire_pairing_codes`), device limit 2 → 3.

**The defect fixed.** Round 149's device lock could never authorise a SECOND machine: `POST /devices`
registers the browser *making* the call and needs a session, which needs an already-authorised
browser, and the bootstrap only fires at zero devices. Raising `max_devices` made slots nothing could
fill. Round 149's verification missed it because **it only ever drove one browser**.

**The fix**: an Admin on an authorised browser mints a one-time code (8 chars, 15 min); the new
machine types it at login. Redeemed AT LOGIN deliberately — that is the only moment a brand-new
browser talks to the server with no session. Password is still checked first: a code authorises the
**browser**, not the person, and a valid code + wrong password is refused and stays unspent.

Two details not to undo: the claim is a single conditional `UPDATE … WHERE used_at IS NULL …
RETURNING` (select-then-update would let two machines share one code); and the cap is checked
**before** the claim, so hitting it doesn't burn a one-shot code.

**The bigger find — a live Round 149 bug only a browser could show.** `curl` was happy throughout.
Round 149 mounted credentialed CORS on `/api/solitaire` then `app.use(cors())` after it, assuming
first-wins. **Both run, and the second overwrote `Access-Control-Allow-Origin` with `*`** — invalid
with `Allow-Credentials: true`, so browsers refuse it. The preflight looked perfect because the
scoped handler answers OPTIONS and ends the request first. **The module's login would have failed on
the live deploy.** The app-wide policy now explicitly SKIPS the Solitaire paths rather than running
after them. `/api/solitaire-access` stays on the wildcard policy on purpose — bearer token, no
cookies, and it is what the Plant Operator icon calls.

**Lesson worth carrying**: cross-origin + cookies cannot be verified with curl. Drive a real browser.

**Verification**: two separate browser contexts. A bootstrapped; B refused (the Round 149 dead end),
then paired and worked **with A still working**. Reused code refused; wrong code refused; expired
code refused — re-run after freeing a slot, because the first attempt hit the cap check and never
reached the code path. Valid code + wrong password refused, code confirmed unspent in the database.
Cap of 3 reached, 4th code refused up front, revoke freed a slot, replacement joined. **Three
simultaneous redemptions of one code → exactly one device created.** CORS checked on the real
request, a disallowed origin, `/api/solitaire-access` and the rest of the app. Whole flow driven
through the actual UI, no console errors.

**Workbook received**: the licence-free `BPR107a.xlsm` is in the app tree at
`assets/BPR107a-unlocked.xlsm` — `Workbook_Open` (hard-drive serial + `C:\Apple\license.key`) gone,
everything else verified intact: 13 sheets, all 13 `printerSettings` parts, 3 images,
`Module37.PrintOrderandAsPDF` and the `AF4` save-folder read. See
`claude/solitaire-print-agent-notes.md` for the Round 151 design.

## Round 149 (Ver. 9.74): Delivery Challan wired in as a switchable plugin

**Visit `/setup?key=...` once** (nine new tables) **and set two new backend env vars**:
`SOLITAIRE_JWT_SECRET` and `FRONTEND_ORIGIN` (the frontend's own URL). Both are in `render.yaml`.

The Solitaire / "RMC Delivery Challan" module, built in an earlier session and never wired in, is
now live. Its twelve files existed **only as project docs** — they were pulled from there into the
app this round; `backend/schema-solitaire-additions.sql` was never delivered at all, so the eight
`solitaire_*` tables were reconstructed from the SQL in `routes/solitaire.js`.

**A plugin is NOT a permission, and this distinction is the point.** Permissions answer "what may
this PERSON do with a module that exists"; a plugin answers "does this module exist for anyone at
all". New `app_plugins` table + `backend/src/lib/plugins.js` (`requirePluginEnabled(key)`, 5s cache
cleared on toggle). **Build future optional modules against this, not against a permission key** —
otherwise switching one off means revoking from every role one at a time, and a role added later
silently gets it back.

**Off means off.** The guard mounts above EVERYTHING in both routers, including Solitaire's own
`/login`, so a browser holding a live session cookie is cut mid-shift. It answers **404, not 403**,
deliberately: 403 invites someone to ask for access to a module the business switched off. Nothing
is deleted — accounts, devices, masters and dockets all survive and return intact.

**Administrator has no route in, three independent ways**: the access API is
`requireRole("super_admin")` (was `"administrator"` in the original draft); the catalogue's new
`admin.plugins` is **locked**, the one class Administrator's computed set cannot reach; and there is
no Solitaire tile in `adminScreens.js`. The only entrance is an icon on the Plant Operator screen,
shown only when the plugin is on AND that person is granted — both from one call, so they cannot
disagree.

**Four integration bugs, none visible by reading the module's own code — worth remembering as a
class**, since any future self-contained module handed over this way will have the same shape:

- `lib/solitaireAuth.js` **threw at import time** on a missing secret, which took the WHOLE backend
  down over an optional plugin. Now scoped: 503 from the module, rest of the app fine.
- `solitaireApi.js` used a bare relative `/api/solitaire` — resolves against the STATIC SITE, not
  the backend. Now off `VITE_API_URL`.
- Session cookie was `SameSite=Lax`; frontend and backend are separate Render services, so every
  call is cross-site and a browser **will not send a Lax cookie cross-site**. Login 200s, next
  request has no session. Now `None` + Secure.
- Which removes CSRF protection, so credentialed CORS is allowed from **`FRONTEND_ORIGIN` only**,
  scoped to `/api/solitaire` and mounted ABOVE the app-wide `cors()` so it owns the preflight.
  `/api/solitaire-access` stays on the ordinary policy — bearer token, no cookies, and it is what
  the icon depends on.

**Still open**: (a) the real print pipeline — the user's decision is to write into their Excel
workbook on **Google Drive** and print its sheet so Excel's own formulas produce the output; that
needs a server-side spreadsheet engine (LibreOffice headless → Docker on Render) and is its own
round once the workbook is placed. Until then dockets print through the interim jsPDF generator and
are flagged `is_placeholder_pdf`. (b) The two panel images were never delivered — see
`frontend/public/solitaire/README.txt`; screens work without them.

**Verification**: Administrator refused 403 on all four ways in with the switch confirmed unmoved in
the database; full life cycle proven (grant → icon endpoint true → real module sign-in setting both
cookies → `/me`, `/customers`, `/devices` 200); the switch then flipped off **with that session
open** — every module route including `/login` 404, icon endpoint 404, granting 404, while the
dashboard and Plant Operator endpoints stayed 200; switched back on, the same cookies worked and
accounts plus the registered device were intact. Revoke confirmed not to disturb another session;
duplicate username refused, re-granting your own username allowed (the password-reset path). A
**second backend started with no `SOLITAIRE_JWT_SECRET`** served login, dashboard and Super Admin
API normally while only the module reported the missing variable. Headless at 390px: icon present
for Plant Operator, absent across the Administrator side, gone when switched off; Plugins tab
rendering with zero overflow and no console errors.

## Round 148 (Ver. 9.73): Super Admin made usable — and two Round 146 bugs it exposed

**Visit `/setup?key=...` once after deploying** — no schema change, but a data repair runs there.

Round 147's route worked, and the first real promotion showed Round 146 had shipped a role nobody
could live with. **`super_admin` is the TOP role — an Administrator plus the access-control screen —
not a sideways one.** That rule now lives in exactly two mirrored places: `requireRole` in
`middleware/auth.js` lets a Super Admin through any check, and `ProtectedRoute` does the same on the
frontend. `isAdminLevel()` (new `frontend/src/lib/roles.js`, plus an export from the backend
middleware) is how everything else asks "is this an Administrator?" — it replaced every bare
`role === "administrator"` compare in nine frontend files and three backend routers, and four SQL
predicates that passed the role string into the query now pass a boolean. **Do not re-introduce a
bare string compare**; that is what caused this.

Deliberately NOT done: rewriting `req.user.role` to `"administrator"` for a Super Admin. It would
have made every existing check pass for free, at the price of a future `role === "super_admin"`
silently being false.

**The People tab can now manage accounts.** Round 146 built `POST /users`, `POST /users/:id/role`
and `PATCH /users/:id/status` and never called them from the page — which meant a system with
exactly one Super Admin had no way back, since nobody can change their own role and the API refuses
to leave zero Super Admins. Add person / role selector / Disable-Enable sign-in, plus a link across
to the Administrator dashboard.

**An Administrator can no longer take over a Super Admin account** — `reset-password` and `status`
in `administrator.js` refuse when the target is a Super Admin, and the buttons say so rather than
failing after the click. This matters because the Administrator login is shared.

**The Round 146 regression this round found by accident — worth remembering.** `requirePermission`
was added to 49 Material Module routes with defaults "transcribed from that route's own
`requireRole`", and **ten were not**. Store lost every master-data read needed to raise a purchase
order (Materials, Units, Suppliers, Supplier rates, Transporters); Plant Operator lost Materials,
Units and physical-stock view. Both guards were individually correct and simply disagreed — this
project's oldest bug pattern in a new place.

A catalogue correction alone does not reach a live system: the seeding loop only runs for a role
with **no** rows (which is what stops a later `/setup` trampling tuned access). So `setup.js` carries
a named, additive **`REPAIR_148`** list inserting exactly those eight rows with `ON CONFLICT DO
NOTHING`. Use that pattern for any future default correction.

**`backend/scripts/check-guards.mjs` is the guard against a repeat** — it cross-checks every route's
`requireRole` against its `requirePermission` default and exits non-zero on a mismatch. **Run it
when converting the next group of the ~220 remaining routes.**

**Verification**: guard checker green on 49 routes, then deliberately broken to prove it fails.
Live: a promoted account confirmed 200 on seven Administrator-side APIs it would have been 403 on
before, `/api/super-admin/*` still 403 for a plain Administrator; the whole recovery path run end to
end (create, duplicate-phone and short-password refusals, sign in, own-role refusal, demote the
shared account, confirm it is an ordinary Administrator again); both takeover attempts refused with
the original password still working, while the same two actions on a Store account still succeeded;
the repair migration run on an already-seeded database restoring 8 rows, a no-op on re-run, Store
back to 200 on all four screens **and still getting no rate field and no inactive rows** where a
Super Admin got both. Page driven headless as both roles, zero horizontal overflow at 390px and
1280px, no console errors.

## Round 147 (Ver. 9.72): making the first Super Admin without a database client

**No schema change — but `/setup?key=...` must already have been run for Round 146** before this
round's route will do anything.

Round 146 left one manual step: the first `super_admin` had to be created with a hand-written
`UPDATE users SET role = 'super_admin' …` in psql, because an Administrator deliberately cannot mint
one. In practice that meant installing a Postgres client (Render's lower plans have no in-browser
shell; on Windows the dashboard's copied `PGPASSWORD=… psql …` line is bash syntax PowerShell does
not understand) purely to run one statement. The user chose to have the app do it instead.

**`GET /setup/promote-super-admin?key=<SETUP_SECRET>&phone=<phone>`** in `setup.js`. Visited without
`&phone=`, it lists every active account with id, phone, role and name — so the phone is copied from
the database rather than guessed at, which is where a stray space or country-code prefix would
otherwise become a silent "0 rows updated".

**Why it is not a back door**, in the order a request meets the guards:

- Needs `SETUP_SECRET`, like everything else in this file.
- Checks `pg_enum` for the `super_admin` label first. Without Round 146's migration the promotion
  would fail with a raw `invalid input value for enum user_role`, which reads like a bug rather than
  a missing step; the guard says "visit /setup first" instead.
- **Refuses once an active Super Admin exists**, naming who. After the first one it is permanently
  inert and every later role change goes through the Super Admin screen, which writes to
  `permission_change_log` — this route does not, which is exactly why it gets one use. **There is no
  override parameter**; do not add one.
- Promotes only an **existing, active** account. It never creates a user and never touches a
  password, so it cannot plant a login.
- Resolves the phone to one row and updates **by id**. `users.phone` is UNIQUE so the multi-match
  branch should never fire; it stays because an `UPDATE … WHERE phone = $1` that promoted two rows
  would need each account's previous role guessed at to undo.

The success page is instructions, not a receipt: sign out fully and back in, expect `/super-admin`,
use the footer Refresh if the service worker serves the old bundle, and **make a second Super Admin
immediately** — nobody can change their own role or access and the system refuses to leave zero
active Super Admins, so one account is a single point of failure that leads straight back to a
database prompt.

**Verification**: every branch exercised against a throwaway Postgres with the real server running —
wrong key 403, no-phone listing 200, unknown phone 404, promotion 200 carrying the database's own
`RETURNING` row, immediate repeat 409 naming the existing Super Admin. The pre-migration guard was
proved on a **second** database built with a `user_role` enum lacking the label: 400, no write
attempted. Then the part that matters — the promoted account signed in through the real login
endpoint and `/auth/me` returned `role: super_admin` with all 108 catalogue functions including the
three locked ones, with `/api/super-admin/catalogue` and `/users` both 200.

## Round 146 (Ver. 9.71): Super Admin — per-user access control

The approved design (`claude/super-admin-functions-list.md`) built as real code. **Visit
`/setup?key=...` once after deploying** — new role, three tables, role defaults seeded there.

**`super_admin` is the twelfth role**, the only one that can open `/super-admin`. The first one is
created outside the app's own permission system; an Administrator deliberately cannot mint one.
Round 147 added `/setup/promote-super-admin` for exactly this, so a database client is no longer
needed. After that, a Super Admin promotes others from the page.

**The catalogue is CODE, not a table** — `backend/src/lib/permissionCatalogue.js`, 108 functions /
257 permissions. A key that no longer exists in the app therefore cannot exist in the database. Each
entry: which of view/create/edit/delete apply, the role defaults transcribed from that route's own
`requireRole(...)`, and the matching `adminScreens.js` screen key where there is one. **All 42
dashboard screens map to a permission — checked, not assumed.** Never rename a key: the database
stores the strings.

**Two layers, overrides only.** Role defaults, then per-user overrides; only the overrides are
stored, so changing a role default flows through to everyone not individually overridden (the API
returns who that is).

**Safety rules live in the API, not the page**: no editing your own access or deactivating your own
account; no change that leaves zero active Super Admins; the three locked functions (access control,
password reset, `/setup`) can never be granted; **view is the gate** — create/edit/delete cannot be
granted without it and revoking view cascades the rest off. **Administrator's set is computed, not
stored**, so it cannot be trimmed by editing a table.

**Permissions are deliberately NOT in the JWT** (30-day token; a change would not bite for a month).
Resolved per request, cached 5s in memory, cache dropped on any save — measured at under six
seconds end to end.

**The property that makes gradual rollout safe**: `requirePermission` is added **alongside**
`requireRole`, never replacing it. Both must pass, so granting a permission can never get anyone
past an unconverted role guard. This can only tighten access, never loosen it.

**Converted this round: the whole Material Module (49 routes)** — the tranche where a real
non-Administrator role (Store) does real work, so revoking has visible effect. ~220 routes remain on
role guards alone and follow group by group.

**Known limitation, do not mistake it for a bug**: dashboard tile-hiding is implemented and correct
but currently inert — the icon grid is Administrator-only and Administrator has everything by
design, so nobody both sees the grid and can lose a tile. It becomes live when another role gets the
grid, or if that decision is revisited.

**Still open for the user**: the two different outstanding-collection figures (see Round 144).

**Verification**: `/setup` seeded 10 roles' defaults and left an already-populated role untouched.
Administrator and Store both 403 on every Super Admin route, unauthenticated 401. `/auth/me` gave
257 / 251 / 17 permissions for super_admin / administrator / store, each checked against the
catalogue. Every safety rule returned a clean 400 with a plain reason. View-revoke cascade confirmed
(3 actions). The zero-Super-Admins guard was checked directly against the database, since the
self-protection rules make it otherwise unreachable. Live proof: Store listing material orders
**200 → revoke → 403 → restore → 200**, an unrelated permission unaffected, and all nine Material
Module endpoints still 200 for an Administrator. Page driven headless: landing, matrix, all three
tabs, and an Administrator bounced off the URL.

## Round 145 (Ver. 9.70): Cube QC dashboard made mobile-friendly; header thinned into the footer

Two items from live use. **No schema change — `/setup` not needed.**

**1. `CubeQcDashboard.jsx` on a phone.** Every panel row was a fixed column count (`repeat(6, 1fr)`,
`1.3fr 1fr`, `1fr 1fr`, `repeat(3, 1fr)`), so at 390px each panel became a sliver instead of
stacking. All now `repeat(auto-fit, minmax(…, 1fr))` — **`auto-fit` collapses empty tracks, so a
6-tile row across 7 possible tracks still renders as 6 equal columns on desktop**; the desktop
layout was confirmed unchanged by screenshot, not by reasoning. Two tables lacked the
`overflow-x: auto` wrapper the others had ("Margin over f'ck by grade", nine columns, and the weekly
sampling table); both now scroll inside their card. The SVG charts were already responsive
(`viewBox` + `width: 100%`).

**2. `TopBar.jsx` + `index.css` — header/footer split.** The header carried nine things on one line
and wrapped to three rows on a phone. Now split by purpose:

- **Header** = where you are and where you can go: app name, page title, back-to-dashboard link,
  orders link.
- **Footer** (the fixed bar that already held the clock) = who you are and what the app is: name,
  role, version, sign out, refresh, notifications, plus the date and time.

Things worth not re-breaking: the footer's `pointer-events: none` moved from the **bar** to the
**clock only** (the clock sits between two button groups and must not swallow a tap). Below 560px
the icon buttons lose their labels and the role hides, but the buttons **grow** to a 40px minimum —
label-less buttons would otherwise be 24px, useless to a gloved hand. `#root { padding-bottom }`
went 30px → 76px because the bar now wraps to two lines on a phone; if anything is later added to
the footer, re-measure that (it was 61px on a phone, 35px on desktop).

**Verification**: both screens rendered at 390px and 1280px against the real running app with seeded
cube results. Horizontal overflow **measured** as zero at phone width rather than eyeballed; footer
height measured against the reserved padding at both widths; desktop layout diffed against the
previous screenshot; no console errors at either size.

## Round 144 (Ver. 9.69): dashboard KPIs corrected to match the Reports page

Six items from live testing of round 143. **No schema change — `/setup` not needed.**

**Items 2–5 were one root cause**: round 143's dashboard computed its own version of the four
headline figures instead of reusing the Reports page's, and all four disagreed. Fixed by creating
**`backend/src/lib/dashboardKpis.js` — the single definition** that both
`/api/reports/director-dashboard` and `/api/admin-dashboard/summary` now import. **Do not write a
third copy of these numbers anywhere.**

The four mistakes, each a reusable lesson:

- **Today's Order** used `status <> 'cancelled'`, silently undoing Round 129's rule (a cancelled or
  closed order that *had already received supply* still counts; one that never shipped does not).
- **Today's Production** read `rm_daily_production`, the Plant Operator's own entry. **That table is
  the right basis for the Material Module's cost per m³ and nowhere else** — and live it is often
  empty, which is why the tile read 0 m³. Production = delivery-challan quantity net of site-QC
  rejections.
- **Monthly Achieved** had the same wrong source.
- **Outstanding** used the Outstanding Collection *report's* per-customer arithmetic (positive
  balances only) rather than the Reports page KPI's all-invoices + opening-balances − all-payments.
  **The app has had two different outstanding figures all along**; they differ whenever a customer
  is in credit. This round did not reconcile them — the KPI matches the Reports page because that
  is what it is compared against, and the difference is documented in `dashboardKpis.js`. Worth
  settling with the user eventually.

**Item 1, landing page**: `ROLE_HOME.administrator` was already `/administrator` from round 143 and
is correct; verified end to end by a real sign-in and by visiting `/`. If the old Reports page still
appears after a deploy it is the **installed PWA serving a cached bundle**, not routing.

**Items 6, 7**: Plant Manager is first in Production, Laboratory first in Quality Control — one-line
moves in `lib/adminScreens.js`, which is what the registry is for.

**Verification**: both endpoints called against the same seeded database and compared field by
field, with site-QC rejections seeded so the "net of rejected" rule was exercised rather than
multiplying by zero (184 challan − 6.5 rejected = 177.5 on both). Tile order read out of the live
page; landing page confirmed by an actual login.
## Round 143 (Ver. 9.68): Administrator dashboard rebuilt as an icon view

The approved icon-view mockup built as real code, replacing five `GroupedMenu` dropdowns plus a
"Users and roles" tab. **Visit `/setup?key=...` once after deploying** — one new table
(`user_dashboard_pins`).

KPI strip → pinned row → eight coloured module tiles. Five modules open a sub-grid (Production 10,
Fuel & Lubricants 3, Plant & Equipment's 6, Quality Control 5, Sales and Collection 15); Directors
Dashboard, Raw Material Module and Users & Roles open directly. A module's red badge is the total
of its children's.

**Three levels live in the URL** — `/administrator`, `?module=production`, `?view=customers` — not
in local state, so refresh, bookmarks and the browser back button all work. Back returns to the
module you came from, not blindly home.

**New `frontend/src/lib/adminScreens.js` — the single screen registry.** Every label, icon, colour
and destination for all 42 screens, plus ~35 inline stroke glyphs. Nothing in the page hard-codes a
screen. **This is the list the Super Admin permission work should switch tiles on and off from** —
build permissions against it rather than inventing a second one. Reordering a module's screens is a
one-line move here (round 144 did exactly that twice).

**New `backend/src/routes/adminDashboard.js`** at `/api/admin-dashboard`, `requireRole
("administrator")` at the ROUTER level (round 141's reasoning). `GET /summary` = four KPIs + every
badge count in ONE call. **Its four KPI figures were wrong on delivery and round 144 replaced them**
— see that section; they now come from the shared `lib/dashboardKpis.js`. `GET`/`PUT /pins` persist
per-user pinned screens; validated for shape only, since this file deliberately does not hold the
registry — an unknown-but-well-formed key is skipped when the grid renders.

**`ROLE_HOME.administrator` changed `/reports` → `/administrator`.** Signing in lands on the grid;
the old landing page is now the "Directors Dashboard" tile.

**Three screens joined the dashboard that were reachable by route but never linked**: Cube Test
Report, Plant Manager (`/manager`) and Laboratory (`/lab-technician`). None needed a guard change.
`/lab-technician/due-today` and `/store-stock` are still in that position — worth generating the
registry from `App.jsx`'s route table so this becomes an error rather than an oversight.

**Pinning is a checklist, not drag-and-drop** — deliberate, for a phone used with gloves on. Pins
save in registry order, not click order.

**Verification, and what it missed.** The KPIs were seeded with hand-computed answers and all
matched — but against *this round's own definitions*, never against the Reports page that shows the
same four figures. **Agreeing with yourself is not verification**; round 144 had to correct all
four. What the verification did catch: manager 403, unauthenticated 401; pins exercised with a
duplicate, a junk key, nine keys and a non-list, each leaving the stored value untouched; a
round-142-shaped database migrated through `/setup` with rows kept, a second run a no-op, a wrong
key a 403; the page driven headless module → screen → Back → Back with the URL checked at each
step, which found the role-home page and module tiles dropping to two across on a 390px phone.

## Round 142 (Ver. 9.67): Material Module matched to the mockup + the missing Mix vs actual report

Direct response to "Material module is not matching with the mock-up UI". **Visit `/setup?key=...`
once after deploying** — one new column (`rm_materials.mix_component`).

Four screens rebuilt against the approved mockup artboards (Main/AdminStock, StockCount, Reports,
StockReport):

1. **Stock tab** — KPI strip (open orders, below-reorder-level; for Administrator also stock value,
   open-order balance, month's purchases, debit notes due), the month's Opening/Received/Consumed
   beside book stock, reorder level, stock-lasts, avg rate, value, status badge (OK / Near reorder /
   Low · reorder), a total row, and an Open orders panel with per-PO fill bars plus a red note for
   any low material with nothing on order. `GET /stock` gained `month_opening_kg`,
   `month_received_kg`, `month_consumed_kg` and an `open_orders` array. Store's valuation-hiding is
   still server-side.
2. **Monthly physical stock** — one count sheet for all materials, the figure entered **in the unit
   it was counted in** (CFT/barrel/MT) and converted to kg on save, actual consumption and the
   difference recomputing live while typing; a Stock-taking panel (who + remarks) and a Past-months
   switcher. Was a card-per-material with a modal per count.
3. **Daily consumption — mix vs actual** (NEW, Administrator only) — `GET /reports/mix-vs-actual`
   plus `rm_materials.mix_component` mapping each user-named material to a design ingredient
   (cement / fly_ash / fine_agg / coarse_20mm / coarse_12_5mm / **admixture**, the last summed from
   `mix_design_admixtures` since it has no design column). Theoretical = each grade's approved
   design per m³ × that grade's m³ from the day's challans (cancelled/rejected/returned excluded),
   design from `co.resolved_mix_design_id` falling back to the grade's standard approved design. A
   grade with no design contributes nothing and is NAMED on the page; unmapped materials are listed
   too. `/setup` guesses `mix_component` by name only for rows that are still NULL; the Materials
   master has a selector to correct it.
4. **Monthly physical stock report** — adds Avg rate and Cost—actual-consumption columns, a total
   row, and the four summary cards. Cost per m³ divides by the plant operator's month production.

**Three pre-existing bugs fixed, all caught by this round's own verification** (worth remembering as
patterns): (a) the report's "cost as per plant consumption" summed only materials that had been
counted — the rate is now resolved for every material, and `/physical-stock` returns
`cost_plant_consumption` per row; (b) **`toISOString().slice(...)` for "today"/"this month" is a UTC
bug** — in IST every time before 05:30 and the 1st of any month resolved to the previous day/month,
and the Past-months list literally skipped August. Now built from local calendar fields, with month
arithmetic done on the `YYYY-MM` string (`addMonths`); (c) `fmtMoney` printed `₹-36,580` instead of
`-₹36,580`.

The module's container is now **1180px max instead of the app's usual 620px** — at 620 the mockup's
value and status columns fell off the edge. `max-width` only caps, so phones are unchanged.

**Verification**: `node --check`, clean build, schema on a throwaway Postgres seeded with 3 grades,
4 challans (1 cancelled), 7 materials, 2 part-received orders, a day of consumption. Every
mix-vs-actual figure recomputed by hand and matched exactly; a 4th grade with no approved design
added mid-test and confirmed flagged, not silently counted; `mix_component` confirmed to null out a
blank AND an unrecognised value and to survive an unrelated PATCH; Store confirmed to get no rate or
cost key and 403 on both admin reports; all four screens rendered headless and compared to the
mockup (which is how bugs (a) and (b) surfaced); 9,141 CFT typed into the real page and confirmed
stored as 388,492.50 kg.

**Still not started**: the weighbridge sync agent.

## Round 141 (Ver. 9.66): Cube Strength QC dashboard — Administrator only

The 14 Sept mockup ("OORM Cube Strength QC" artifact + `claude/qc-dashboard-mockup-notes.md`) built
as real code. **No schema change whatsoever** — no table, column or enum — so `/setup` does NOT need
visiting for this round. Everything is derived from data the Lab Technician module already records.

New `backend/src/routes/qcDashboard.js` at `/api/qc-dashboard`, `requireRole("administrator")` at the
**router** level, and `App.jsx`'s guard set to the same single role. Deliberately NOT added to
`labTechnician.js`, whose `router.use` opens it to lab_technician/qc_engineer/manager/administrator —
an admin-only dashboard there would have needed a per-route override that a later edit could drop.
Two endpoints: `/filters` (only values that actually appear in cube results) and `/summary`
(from_date, to_date, mix_grade_id, customer_id, mix_design_id, tested_by, source). Both cube tracks
(plant `cube_test_results` + site `site_cube_test_results`) are unioned in one base CTE, same shape
`labTechnician.js`'s `/cube-test-report` uses; `source` is applied after the union since it is the
only filter that differs between halves.

New page `frontend/src/pages/CubeQcDashboard.jsx` at `/cube-qc-dashboard`, linked from the
Administrator dashboard's Reports menu ("Cube Strength QC"). Six KPI tiles; 28-day control chart per
grade (f'ck, target mean, mean-of-4 limit, ±2σ band, trailing mean-of-4, individual failures red);
7d→28d early warning scatter + at-risk table; margin by grade; mix design performance; within-batch
spread, failure mode, density; customer/site roll-up; lab workload; samples/week vs IS 456 minimum.

**Standards, all named on the page rather than hidden constants**: IS 456 Cl 16.1 (individual ≥
f'ck − 4; mean of any 4 *consecutive in cast order* ≥ f'ck + 0.825σ or f'ck + 4, whichever is
greater); Cl 16.3 (σ "established" only at ≥30 results, otherwise labelled provisional and the
assumed σ — the linked design's own, else IS 10262's 3.5/4.0/5.0 — is what acceptance uses);
IS 516's 15% within-batch limit, computed only over cubes **actually crushed** (an untested cube row
has null load/strength — the same trap Round 131 fixed in the PDF); IS 456 Cl 15.2.2 sampling, with
the required count computed **per day** and summed into the week, not once on the week's total. A
result with no mix design linked falls back to the grade number as f'ck. The 7d→28d projection uses
each grade's own paired-result ratio and shows nothing at all below 3 pairs rather than borrowing
another grade's ratio. Per-grade statistics are computed once on the frontend from the same rows the
chart plots, so tiles, acceptance summary and chart cannot disagree.

**Verification**: `node --check`, clean `npm run build`, schema loaded on a throwaway Postgres and
seeded with 45 pours across 3 grades and both tracks (rogue cubes, density outliers, untested cube
slots, missing failure types). Through the real running app: lab_technician **403**, unauthenticated
**401**, every filter confirmed to filter, and the lab-workload counters confirmed to *move* by
adding one 40-day-old untested pour (0 → 1 on overdue-7, overdue-28, never-tested — a counter that
can only return 0 proves nothing). IS 456 arithmetic recomputed independently from the API payload
matched the page exactly. The page was then rendered headless and screenshotted, which caught a
chart axis-label collision that was fixed before delivery.

**Frontend file count**: `frontend/src` is 93 files; the whole `frontend` folder is 106, still above
GitHub's 100-file single-drag cap (pre-existing, not caused by this round). Upload `frontend/src`
alone, and mind PROJECT_INSTRUCTIONS.md's warning about a split upload nesting as
`frontend/src/src/...`.

**Still not started** (unchanged by this round): the weighbridge sync agent (the Material Module's
weighbridge weight is still typed in by hand).
## Round 140 (Ver. 9.65): 8 fixes/features from live testing of the Material Module

Direct response to a punch list of 8 items the user sent after testing round 139's Material Module
live. **Visit `/setup?key=...` once after deploying** — several items need the additive migration.

1. **Fixed "SOMETHING WENT WRONG" editing a material** — `PATCH /materials/:id` crashed on a blank
   optional numeric field (empty string straight to Postgres NUMERIC). Same bug class as round 135,
   different route. Blank now normalizes to `NULL` for nullable fields; a blank *required* numeric
   field (kg/purchase unit, opening stock) returns a clean 400 instead.
2. **Supplier rates are now effective-dated** — `rm_supplier_rates` gained `valid_from`/`valid_to`;
   setting a new rate closes the current row and inserts a fresh one (never overwrites in place), so
   a real "Rate history" view has something to show. Orders still snapshot the rate at order time,
   unchanged.
3. **Fixed the modal closing mid-copy** — `Modal`'s backdrop closed on a text-selection drag that
   started inside the panel and released past its edge. Now requires both mousedown and click to
   land on the backdrop itself.
4. **Multiple purchase units per material** — new `rm_material_units` table (unit name, kg/unit, one
   default) + a Materials-tab panel. `rm_materials.purchase_unit`/`kg_per_purchase_unit` stay the
   single live conversion everything downstream reads; marking a unit default writes through to
   those two columns. Pre-existing materials get backfilled by `/setup`.
5. **Stock is now the landing tab** for Administrator and Store, matching the mockup's nav order —
   was previously the Materials master.
6. **Admin can edit/delete a wrong receipt** — `PATCH`/`DELETE /receipts/:id` (Administrator only),
   recomputing `short_qty`/`landed_rate_per_kg` while preserving the *original* receipt's kg
   conversion. Book stock/weighted-rate are computed live, so no separate repair is needed.
7. **Order close and revise** — `rm_order_status` gained `'closed'`. Administrator can close an
   approved order (terminal, abandons any outstanding qty) or revise rate/freight/tax/qty on one
   that isn't closed/rejected yet. Revising never touches receipts already recorded.
8. **Cost Dashboard** (new Administrator-only tab) — 4 KPI cards, a 6-month cost/m³ trend, a
   per-material cost/m³ breakdown, and a grouped material→supplier weighted-rate table with
   short-supply%. Reuses round 139's existing rate-computation helpers and operator-production-m³
   basis. Checking the mockup for other gaps (per the user's own instruction) also surfaced the
   admin Stock tab missing its KPI banner (**included this round** — new
   `GET /reports/stock-summary`) and the Orders screen being simpler than the mockup's multi-line PO
   form (**left for a future round** — the user chose this scope explicitly).

**Verification went beyond the usual**: a dedicated upgrade-path test built a second disposable
database to the exact round-139 shape (old constraint, no new table/columns, real seeded rows), ran
`/setup` against it, and confirmed the migration applied cleanly with existing rows preserved and the
unit-backfill populated correctly — then confirmed a second `/setup` run is a true no-op. All 8 items
were exercised end to end through the real running Express app, including negative cases (403s,
clean 400s instead of crashes, blocked double-close/revise-after-close, no duplicate rate-history row
on a no-op re-save).

## Round 139 (Ver. 9.64): new Material Module — purchase → approve → receive → consume → physical count → reports

Built from planning docs written in a separate session (`claude/raw-material-module-notes.md` +
4 related notes docs); their own text confirms the build order — Material Module now, QC dashboard
/ Super Admin / weighbridge sync are **explicit future phases, not started this round**. The
weighbridge comparison report exists but with manual weighbridge-weight entry (no hardware sync
yet).

New schema (all additive via `/setup` — **visit `/setup?key=...` once after deploying**): ten new
`rm_*`-prefixed tables (`rm_materials`, `rm_suppliers`, `rm_supplier_rates`, `rm_transporters`,
`rm_supplier_transporters`, `rm_orders`, `rm_receipts`, `rm_daily_consumption`,
`rm_daily_production`, `rm_monthly_physical_stock`) + 4 enums. New backend router
`materialModule.js` at `/api/material-module`. New single frontend file `MaterialModule.jsx`
(tab-based — Materials/Suppliers/Orders/Receipts/Consumption/Stock/Physical Stock/Reports).

**Naming deliberately avoids a real collision risk the planning notes missed**: a pre-existing,
unrelated `raw_material_stock` table (Lab Technician's simple 9-bin snapshot,
`RawMaterialStockEntry.jsx`) already existed and is left completely untouched — every new table is
`rm_*` (not `raw_material_*`), the route is `/api/material-module` (not `/api/raw-material...`),
the frontend file is `MaterialModule.jsx`. Whether the old tracker should eventually merge into the
new module is an open question for the user, not decided here.

**Role scope — no Manager access yet** (cheap one-line addition later, flagged since every other
module here is Manager-inclusive): Administrator (masters, approvals, valuation, all 9 reports),
Store (orders, receipts, stock qty only, physical count entry), Plant Operator (consumption +
production entry, stock qty only).

**Key logic** (each verified against real seeded data through the live running app, not just SQL):
weighted average rate is a calendar-month average computed live from receipts (never stored),
forward-filling across months with no receipts and falling back to a material's own opening rate
before its first receipt; landed rate is computed once at receipt time and stored (a later
rate/freight master change never rewrites a past receipt's cost) —
`(accepted_qty × rate + freight + tax-if-not-claimable) / accepted_qty_kg`, GST **excluded by
default** (tax only added to landed cost when explicitly marked `included`); accepted quantity
defaults to the weighbridge weight converted to purchase units but Store can override; short/excess
receipts are flagged against each material's own tolerance %; the two volume bases (challan-derived
grade split vs. the Plant Operator's own daily production figure for cost/m³) are kept deliberately
separate everywhere, never silently mixed, per the notes doc's own explicit decision on this.

**Frontend built as ONE file, not the ~8 pages the planning notes assumed** — the frontend folder
was already at 108 files (now 109) before this round, over this project's own ~95-file guidance
from a past round where crossing it caused a real GitHub upload-split problem. That pre-existing
108-file count is worth attention on its own, independent of this round's one-file addition, next
time a batch of new pages is planned. New route `/material-module`, linked from `StoreHome.jsx`,
`PlantOperator.jsx`, and `Reports.jsx` (direct button + a Reports-menu deep link to `?tab=reports`).

Verified with `node --check`, a clean `npm run build`, `schema.sql` loading end-to-end on a fresh
local Postgres database, and — beyond the usual SQL-level check — the module exercised through the
real running Express app with seeded data: full order→approve→receive cycles for both `delivered`
and `ex_factory` scope (freight-basis math and tax-included landed rate confirmed against
hand-computed values, exact match), a weighbridge-short receipt (auto-derived accepted qty +
tolerance flag both confirmed), the weighted-average carry-forward across three months including one
with no receipts, the physical-stock diff/cost calc, Store's server-side valuation-hiding on every
relevant endpoint, admin-only 403s, and all 9 reports.

---

Older rounds (119 post-ship through 138) and the Solitaire module Round 1 writeup are preserved in
full in `README.md` inside the delivered zip — trimmed from this snapshot doc to keep it a quick
map rather than a full duplicate of the changelog. Re-read the latest zip's README for anything
older than Round 138's follow-up 2.

## Solitaire module — Round 1 (built 2026-09-01, NOT YET wired into the live app)

New work, separate from the main app's own round numbering above — a self-contained module, not a
numbered round of the main app's own feature work, since it doesn't touch any existing file yet.
See `claude/solitaire-integration-notes.md` and `claude/solitaire-app-jsx-patch-notes.md` for the
full detail — still blocked on the user's updated Excel workbook (for the real print pipeline) and
the current app zip (to wire in the two integration points: `App.jsx` routes and an Administrator
"Solitaire Access" panel). Nothing about it touches or depends on the main app's Round 136 line —
the next session can pick up either thread independently.
