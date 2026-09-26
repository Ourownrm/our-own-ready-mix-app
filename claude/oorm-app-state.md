# OORM App — Current State (as of Round 163, Ver. 9.89)

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

## Round 153 (Ver. 9.79): delivery notes for the plant, fuel since last fill, equipment analysis

**Visit `/setup?key=...` once** — no schema change; REPAIR_153 grants four roles the existing
`orders.challan-print` permission. Skipping it leaves a seeded installation refusing the new list
to everyone but Administrator, because the seeding loop only runs for a role with no rows.

Closes the last three open items from the punch list.

**Item 1 — today's delivery notes.** New `backend/src/routes/deliveryNotes.js`: `GET /today`
(today's non-cancelled tickets, IST via `CURRENT_DATE`, newest first) and `GET /:id/challan`.
Both carry `requireRole` AND `requirePermission("orders.challan-print", "view")` — the second is
the Super Admin's switch, so the list can be taken away from any one role with no deploy. The
challan SQL moved out of `administrator.js` into `lib/challanData.js`, shared by both routes so
the printed document cannot drift between them; `administrator.js` keeps its original URL.
Frontend: `frontend/src/lib/TodaysDeliveryNotes.jsx`, one component mounted on PlantOperator,
LabTechnician and QcEngineer — it renders nothing at all without the permission.
`deliveryChallanPdf.js` takes a `source` argument ("administrator" | "delivery-notes") picking
which endpoint to read from; the PDF itself is identical either way, deliberately.

**Item 3 — distance since last fill.** `supplyRequests.js` `GET /pending` now carries
`last_fill_at`, `last_fill_quantity`, `last_fill_reading`, `distance_since_last` and
`implied_rate`, from a LATERAL join onto the previous issued fuel request for the same unit
(matched with `IS NOT DISTINCT FROM` across truck/pump/equipment ids, so families never cross).
Units follow the meter — km + L/100km, or hours + L/hr. Three cases return NULL rather than a
misleading zero: no prior fill, a reading that went backwards, and lubricant requests. The card
(`SinceLastFill` in SupplyApprovals.jsx) says which, and flags a backwards reading in red.

**Item 4 — pumps and other equipment.** `fuelAnalysis.js` gained `GET /equipment` and
`GET /equipment/:kind/:id` (kind is 'pump' or 'equipment' — id 3 is a different machine in each
table, so both are always carried). Litres per running hour, plus litres per m³ pumped for pumps
from `pump_logs`. Averages are per equipment TYPE, not one average across everything. Frontend:
a "Pumps & equipment" tab on FuelAnalysis.jsx sharing the Trucks tab's date range.

**Two UTC date bugs fixed**: `fuelAnalysis.js`'s `dateRange()` and `FuelAnalysis.jsx`'s
`todayStr`/`daysAgoStr` both built the UTC day with `toISOString().slice(0,10)`, which names
yesterday between midnight and 05:30 IST. Both now build the IST day, matching `db.js`'s
Asia/Kolkata session. Worth grepping for this pattern elsewhere — it is the app's recurring bug.

## Round 163 — order numbers + group by material (v9.89)

**No schema change** (frontend only, MaterialModule.jsx). Two live-use asks.

**ORDER NUMBERS.** `PO-` + id padded (like R- receipt numbers from R162), shown on the Orders page,
the Receipts "awaiting receipt" list, and as an **Order** column in the receipt register. The id is
the number — stable, unique, no separate sequence/migration.

**GROUP BY MATERIAL.** Orders page main list, Receipts "awaiting receipt" list, and the register all
group by material: a heading per material (count + total), items beneath, materials alphabetical.
Helpers `orderNo(id)`, `groupByMaterial(items)`, `<MaterialHeading>`. In the register the Material
column moved into the group heading and the Order column took its slot. Data already present
(orders: id+material_name; receipts: order_id+material_name) so no backend change.

## Round 162 — receipts as a register, weighbridge report (v9.88)

**Visit `/setup?key=...` once.** Five Material-Module/Weighbridge asks from live use.

**BACK-DATED RECEIPTS.** New `rm_receipts.received_date` (DATE) is the ECONOMIC date — a load
entered late counts in the month it ARRIVED, not the month it was typed. Everything economic
(weighted-avg rate, stock-as-of, month rollups, physical-stock reports) repointed from received_at
to received_date; received_at stays as the audit "entered on" timestamp. Existing rows back-filled
from the IST day of received_at. Future date refused. Shared `validateReceivedDate()` on POST+PATCH.

**DATE BUG caught in verification:** node-pg serialises a DATE shifted (12 Aug -> 2026-08-11T18:30Z).
Every read returning received_date to the screen now uses `to_char(...,'YYYY-MM-DD')` — the app's
standard rule. The main list uses `SELECT r.*, to_char(...) AS received_date` (later alias wins).

**REGISTER.** ReceiptsTab history is now a TABLE (receipt no, arrival date, material, supplier/
vehicle, supplier vs accepted qty, variance, weighbridge link, landed rate) with a filter row
(date range, material, supplier) and pending flagged in place. Receipt number = `R-` + id padded.

**WEIGHBRIDGE LINK on the receipt.** The list joins weighbridge_tickets for the linked ticket's
net weight; shows `#ticket + net kg`, or `(manual)` for a hand-typed weight, or `—`.

**ADMIN EDIT gains arrival date + UNLINK.** PATCH takes received_date and weighbridge_ticket_id;
"" unlinks (frees the ticket for the right receipt), a number relinks but only to a matched,
unclaimed ticket (same double-claim guard as create).

**WEIGHBRIDGE RECORDS REPORT.** New `GET /weighbridge/report` (+ `/purposes`) with filters
from_date/to_date (on COALESCE(weighed_at::date, ticket_date)), material_id, supplier_id, purpose,
status, and free-text `q` across raw vehicle/material/supplier/challan/driver. Returns rows + totals
(count, net kg EXCLUDING 'ignored'), 1000-row cap with a truncated flag. New "Records" tab on
Weighbridge.jsx, shown to anyone with view (tab bar no longer gated on canMap).

Verified: 12-Aug receipt lands in Aug's weighted avg; dates display correctly; link shows net wt,
claimed ticket leaves the offer list, unlink frees it, relink guards fire; every report filter +
search works, net excludes set-aside; Store refused receipt edit (admin only), Store/Operator/Admin
all read the report; fresh DB + upgrade from R160 both clean. 84 routes both guards, all 5 checkers
green.

## Round 161 — MixTrack makes the ticket (v9.87)

**Visit `/setup?key=...` once** AND set **`MIXTRACK_API_KEY`**. Unset = the print endpoints are
CLOSED, not open (verified). New: `mixtrack_recipe_map`, `mixtrack_mix_design_log`,
`mixtrack_print_jobs`, docket columns (plant link, recipe_code, lookup_code, pdf_purged_at),
`pdf_retention_months` = 2.

**THE WORKBOOK ALREADY PRINTS.** Decompiling the VBA found `PrintOrderandAsPDF` (prints, names the
PDF from cell values, exports) and `PrintPDFFromFolderByNumber` (finds a saved PDF by number and
reprints). MixTrack fills cells and CALLS them — it does not reimplement printing. This settles the
architecture: **Excel on the plant PC** via `tools/mixtrack-print-agent/`, NOT LibreOffice on
Render as Round 160 assumed.

**H45 vs M29 — two cells, two jobs.** M29 is what the ticket PRINTS (`J14 = Load!M29` on every
numbered sheet). H45 (was `=M29`) is the LOOKUP KEY for
`VLOOKUP($H$45,'Mix Design'!B3:W65,n,FALSE)` across thirteen ingredients. Plant writes `M25A`,
sheet has `M 25 A`; one cell cannot do both. **Shipped wrong first** — the payload read the code
off the mix design, printing the workbook's spelling where the plant's belonged, defeating the
whole split. Caught by reading the first real payload.

**The map, and what mapping cannot fix.** Exact match over 2,495 loads: **2**. Ignoring spacing:
1,558 (62%). The other **937 (38%)** use a recipe with NO Mix Design row in any spelling — M25A
(448), M30 B (210), M35 A (136), M25 E (85), M35 ULCCS (44), WATER BATCH (12), M40 SCC (2). So QC
gets **seed-from-plant**: creates each missing design from `<slot>_Rec` (stored since Round 159),
logged with action `seed`. A recipe the plant reported no design values for is LEFT ALONE — an
all-zero design looks complete and prints zeros. Mapping is human; the suggestion is shown, never
applied, and two designs normalising alike produce none.

**HELD LOADS DO NOT PRINT** (user's decision). No mapping, or a deactivated design → refused with
the recipe NAMED. Deactivating a design a recipe still maps to is refused too.

**Production Qty is the trigger.** Nothing can print before it — `I40` derives the sheet from
`AO29`. Saving it creates docket + job in one transaction. Plant's own figure shown as a check,
never a default. Partial unique index on (plant, year, batch_no) stops double-ticketing.

**The job carries a SNAPSHOT** of every cell and every Mix Design row, so a retry or a reprint
reproduces the paper handed over rather than picking up a later QC edit. Agent claims with
`UPDATE ... RETURNING ... FOR UPDATE SKIP LOCKED`; a job claimed but unreported is re-offered after
10 min. **The agent refuses to print if the workbook's own `I40` disagrees with the app's sheet
number** — wrong sheet = wrong NUMBER OF BATCH BLOCKS on a customer's ticket.

**PDFs: 2 months** (user's decision). ~1,500 loads/yr × ~200 KB = ~290 MB/yr, fills 1 GB in 3
years. The docket ROW is NEVER purged (~1 KB, ~1.5 MB/yr) — only `pdf_data`, with `pdf_purged_at`
so the search window says "reprint from the plant PC" rather than looking like it never printed.

**Moisture — the average was wrong.** AO34 takes one number; averaging every gate gave 2.45% from
sand 6.04 / 12mm 0.8 / 20mm 0.5, describing nothing. It is the SAND's (gate2). Note AO34 feeds NO
formula: the moisture that drives the calculation is the Mix Design sheet's columns R-U, a stored
per-recipe figure, NOT the plant's live reading. Worth revisiting with the user.

**Save folder**: `'Mix Design'!AF4` shipped as `G:\BPR105\BATCH REPORT 2026` — a MAPPED DRIVE,
invisible to the SYSTEM account a scheduled agent runs under, with the year baked in. The agent
writes the cell itself from a local path.

**Next**: deploy both agents to the plant PC (MCI370 agent still never deployed — `npm run probe`
first), map the real silos, and settle whether the ticket should use the plant's live moisture.

## Round 160 — the ticket workbook stops guessing (v9.86)

**Visit `/setup?key=...` once** — adds `order_no`, `recipe_name`, `batch_started_at`,
`batch_ended_at`, `qc_delay_minutes` to `solitaire_dockets`, the new `mixtrack_qc_delays` table, an
index on `plant_batches.order_no`, and REPAIR_160.

**BPR107a.xlsm arrived**, then twice more with the user's own revisions. Three formulas are gone —
**M32** (Recipe Name), **AZ32** (Driver Name), **AZ34** (Order No) — and MixTrack writes all three.
Not a transfer of work: both lookups were already FAILING on real data.

- `AZ32` looked the driver up against an 11-row table. The plant has run **17 trucks, 28 drivers**;
  11 of those trucks are not in the table, and the listed registrations do not match MCI370's
  spacing (`KL14AF2789` vs `KL14 AF 2789`, two with trailing spaces). Where it did hit, the names
  disagreed — sheet RAGHAV/DAMUDAR vs plant RAGHAVENDRA/DAMU.
- `M32` looked the recipe NAME up from the CODE. They are different strings on **210 of 2,495
  loads** (`M30 B` vs `M30B`).

**CUSTOMER KEY CORRECTED — Order_No, not Customer_Code.** `Order_No` resolves into `Order_Master`
on **2,492 of 2,492** loads; `Customer_Code` resolves into `Customer_Master` on only **574 of
2,485**. `Customer_Master` is a stale 41-row list; the real list is `Order_Master`'s 97 rows. The
two fields also disagree on 184 loads (`PM KELUKUTTY`/`PM KELKUTTY`, 123). The Round 157 note saying
to read `Customer_Master` was WRONG — see `claude/mci370-customer-key-correction.md`. MCI370 has no
numeric order reference at all (`jobno`/`accno` are `'0'` everywhere), so AZ34 prints a name.

**`lib/mixtrackWorkbook.js` is the single source of truth** for the 16-cell Load-sheet map, the
protected cells (`I40`), and the removed Batch Time cells. Cell map, docket schema and checker
cannot drift apart.

**SHEET-SELECTION BUG.** `computeSheetNumber` divided quantity by mixer capacity; the workbook's own
`I40` is `ceil(AO29)` clamped 1-10, depending on NOTHING else. They agree only because this mixer is
1 m³ — at 0.5 m³ a 4 m³ load would print sheet 8 for a four-batch load. Verified equal to `I40`
across ten quantities with capacity deliberately 0.5.

**BATCH TIME REMOVAL BROKE THE QUANTITY CHECK.** The user deleted `W8:AA10` on sheets 1-10; `W12`
sat inside it and was something else — the `"OK"`/`"WRONG QTY"` guard `Load!H41`-`AR41` read, which
became `#REF!`. Those seven cells were CLEARED, not restored: with the agent writing AO29 and `I40`
deriving the sheet, the mismatch cannot occur. (It only ever covered sheets 1-7 anyway.)

**QC DELAY ALLOWANCE.** `K21 = plant Batch_End_Time + allowance`, per site or per customer, **site
wins** (the delay belongs to the pour). New key `production.mixtrack-qc-delay` — Administrator
edits, Manager views, deliberately NOT Plant Operator: it moves a time printed on a customer's
document. The resolved figure is **stored on the docket**, so a reprint reproduces the paper handed
over; verified by changing 12 → 45 min and confirming the old docket still reprints 12:28:24.

**RAND() KEPT.** Row 28 on the numbered sheets ("Actual") is `=$B$27+($B$27*n*(0.5-RAND()))/100` —
±0.5% aggregates, ±1% powders, 102 cells on sheet 10. The user decided to KEEP this. Consequence to
remember: the printed ticket and its archived PDF will NOT match the measured per-batch weights the
app holds, and re-randomise on every recalculation. Do not "fix" it without asking.

**FIFTH CHECKER** — `check-workbook-cells.mjs`: an unwritten cell keeps the PREVIOUS load's value
(the workbook is reused), writing `I40` destroys a formula, and a reference to a removed cell reads
blank rather than failing. Also fixed while nearby: `check-receipts.mjs` and `check-plant-qty.mjs`
resolved their scan root from `process.cwd()`, so running them from the repo root scanned NOTHING
and reported a pass. Both now resolve from their own location. `npm run check` in `backend/` runs
all five.

Verified: fresh DB and an upgrade from Round 159 both migrating cleanly (REPAIR_160 fired only on
the upgrade, as intended); all 16 cells written with none blank; times 12:03:21 PM / 12:16:24 PM in
IST; site allowance beating customer allowance to the minute; both-at-once and out-of-range refused;
Administrator read+write, Manager read only, Plant Operator neither. 82 routes carry both guards.

**Next**: the Excel fill-and-export step itself, which needs LibreOffice headless on the server —
the workbook is no longer the blocker, the engine is. Then auto-print, the PDF copy, and the search
window. Agent still not deployed to the plant PC (`npm run probe` first).

## Round 159 — the plant corrected against real data, silo timeline, MixTrack (v9.85)

**Visit `/setup?key=...` once** — renames plant quantity columns, adds design values, load
start/end, plant_silo_fills, plant_manual_entries, rm_receipts.silo_slot, REPAIR_159, and updates
the plugin label to MixTrack.

**VOCABULARY.** A **load** is the truckful; a **batch** is one drop of the mixer into it (~7.4 per
load). MCI370's own naming is the REVERSE: its `Batch_No` identifies a LOAD (its reprint dialog says
"Batch No / Docket No"), `Batch_Index` identifies a batch. Keep this straight.

**THE BUG.** `Batch_Transaction.Production_Qty` is a RUNNING TOTAL of the load so far (1,2,3…8) —
2,496/2,496 loads. Round 157 summed it: 73,987 m³ against a true 16,010, i.e. 4.6x. Passed
verification only because the synthetic payload used 1 m³/batch. Columns renamed so the mistake is
hard to make: `batch_qty_m3` (sum THIS), `load_qty_m3` (constant per load, never summed),
`cumulative_qty_m3` (audit only). **`scripts/check-plant-qty.mjs`** enforces it — 4th checker.
Verified over all 18,505 real batches: 16,010.5 vs independent per-load 16,009.5 (1 m³ = orphan 2016
vendor row).

**Three figures per material**: `design_kg_per_m3` (`<slot>_Rec` on the header) → `target_kg`
(moisture-adjusted) → `actual_kg`. Real data: M SAND design 777, target 794, actual 793; WATER design
145, target 107 — 38 kg less because the sand carries it.

**Real clock**: `Batch_Start_Time`/`Batch_End_Time` (clean text) → `load_started_at`/`load_ended_at`.
`Batch_Time` is stamped 12/30/99 on every row. Median cycle 11:29.

**Silos are refillable storage.** `plant_silo_fills` is a timeline; a batch is costed against whatever
the silo held at its own moment. `is_refillable` on the alias; `siloMaterialAt()` resolves by time;
`reresolveSilos()` uses a CTE (a LATERAL cannot reference its own UPDATE target). MCI370's
`Batch_Stock` is all zeros since Dec 2013 — the fill record is the ONLY source. Aliases now keyed on
**slot**, not name (Gate1 and Gate2 are both "M SAND"). `"1"` added to placeholder names.

**Auto + manual**: `plant_manual_entries` (material_id NULL = a production row). Plant figure is
read-only; operator enters ONLY what the plant missed; the two are ADDED. Cost divides by the
combined figure — 54 vs 51 m³ on the test day, 5.9%. New key `production.plant-manual`
(administrator + plant_operator). Store reads, cannot enter.

**Solitaire → MixTrack** in every user-visible string. Internal names (tables, routes,
`solitaire.*` permission keys) deliberately unchanged. "Delivery Challan" in MaterialModule and
TodaysDeliveryNotes means the APP's own challan — left alone.

Five bugs caught in verification, all by real data: `SLOT_BY_KEY.has()` on a plain object;
`reresolveSilos` dropped when rebuilding the route file from pieces; LATERAL vs UPDATE target;
migration referencing `normalised` which a fresh install never had; `design_kg_per_m3` dropped by the
payload sanitiser (sanitisers need every new field added in TWO places).

**Next**: MixTrack itself — ticket, auto-print, PDF, search window. Blocked on the workbook with its
finish-time formula replaced by a value.

## Round 158 — a receipt always saves, and a lorry can be assigned again (v9.84)

**Visit `/setup?key=...` once** — new columns on rm_receipts, the
`rm_receipts_effective` view, a variance back-fill and REPAIR_158.

**The vehicle dropdown never worked.** `Number(null)` is 0, not null — so the screen's
`{truck_id: null, supplier_id: 7}` looked like "both" and every assignment (truck, supplier AND
junk) was refused. Survived Round 156 because I tested with curl, sending only the field I set.
Same trap fixed in three more places; all id parses now require a POSITIVE integer.
Also: Vehicles/Mapping controls were gated on mapping VIEW while the endpoints need EDIT.

**Receipts always save now.** Round 156's tolerance block is gone — the lorry has arrived, refusing
to record it only invites fudged numbers. Within tolerance: posts immediately at the weighed
figure, as before. Beyond tolerance: saves as `confirmation_status='pending'` and counts for
NOTHING until a Manager or Admin picks which quantity stands. Approval is deliberately scoped to
only the disputed loads — an approval on every delivery gets clicked through unread.

**`rm_receipts_effective`** — a view with the pending filter built in. Receipts are read in 15
places for stock/valuation/reports; filtering each by hand is how one gets missed. All reads go
through the view; only writes, the receipts screen, the queue and the double-claim check touch the
table, each carrying a `-- receipts-raw:` marker. **`scripts/check-receipts.mjs`** enforces it —
third checker after check-guards and check-dates, and it found two weighbridge sites I'd missed
within a minute of existing.

**variance_qty/variance_pct are SIGNED** (positive = supplier billed more). Round 156 stored the
absolute value and called every case "short", which read as "-5.00 short" on an excess. The
back-fill and the POST must agree on sign or the report mixes conventions in one column.

**New**: `material.receipt-confirm` (VE; administrator + manager, screen `receipt-differences`),
`GET /material-module/receipts/pending`, `POST /receipts/:id/confirm` (basis weighed|supplier|
entered — recomputes qty, kg AND landed rate together), `GET /reports/variance` (rollup by supplier
and material: net, mean-absolute, short/over counts, value), and `frontend/src/pages/
ReceiptVariance.jsx` at `/receipt-differences`.

**Both agents now write `agent.log`** (rotating at 1 MB to `.log.1`), because running under SYSTEM
means no console. READMEs now carry the setup that works: SYSTEM account (no password prompt),
`agent.js --once` on a 5-minute repeat, and **browse to node.exe — never type or paste the path**
(that is the `0x80070002` fix, and it cost a day).

Verified: 0.5% out posts itself, 7.5% out waits; stock 19,900 kg pending → 38,400 kg confirmed;
supplier basis recomputed landed rate; Store refused (403) on both queue and confirm; double-confirm
refused. **The migration failed first time** — the back-fill ran before its own DDL; moved and
re-tested against a stripped database with 5 existing receipts, none dragged into the queue. Three
checkers green: 74 routes both guards, 167 files no UTC dates, every receipt read via the view.

**Next**: Round 159 — the plant production bug found in the live MCI370 data, the silo contents
timeline, design-vs-actual.

## Round 157 — the batching plant reports itself (v9.83)

**Visit `/setup?key=...` once** — new tables plus REPAIR_157. Set `PLANT_API_KEY` on the backend
before the agent can post; left unset the sync endpoint is CLOSED, not open.

Solitaire is dropped for good. A search-and-print screen inside MCI370 would have meant modifying
vendor control software, which is not acceptable on the machine that batches the concrete. The
effort moved to production and raw-material consumption, which is what was actually worth having.

**The agent** — `tools/mci370-agent/`. Reads MCI370's Jet 4.0 Access database through 32-bit
PowerShell + ADODB, so NO driver is installed on the plant PC. It copies the file and reads the
copy: MCI370.exe is never modified and its database is never written to. Source database is the
queue — on a failed post the cursor does not advance, nothing spools locally. `npm run probe` first
on any new machine; it reads only and sends nothing.

**The data shape, which is the thing to get right.** `Batch_Dat_Trans` = one row per LOAD.
`Batch_Transaction` = one row per MIX, keyed `Batch_Index`. A 6 m³ load is six mixes; consumption
sums across them, production does not. `Batch_Time` carries an 1899 date, so the day comes from
`Batch_Date` and only the clock from `Batch_Time`. `NameSetUp` holds the plant's own hopper names —
Gate1-6, Cem1-4, filler, water, admixtures — which is why silo identity never has to be guessed.

**Twenty slots, mapped once** by an Administrator. Placeholder names (`0`, `-`, `Agg6`) are skipped
rather than presented as work. Consumption is reported BY SILO, not by material — deliberately the
opposite of the weighbridge: an unmapped hopper still shows real weights because the plant genuinely
weighed them, whereas an unresolved weighbridge name means we do not know what arrived. A hopper
marked "not a stock material" reads as a settled decision everywhere. `POST /plant/recheck`
re-resolves already-synced rows after masters change — Round 156's lesson, applied up front.

**Screen** — `/plant-production`, three tabs: Production (m³ by day/recipe, recent loads),
Consumption (kg per silo, design-vs-actual, moisture, kg/m³), Silos (Administrator-only mapping).
Gated by `production.plant-data` (view) and `production.plant-mapping` (Administrator only).

Verified from real MCI370 rows: six mixes → one 6 m³ M25 load, consumption at textbook proportions
(323 cement, 80 fly ash, 764 sand, 620+300 aggregate, 150 water per m³; 2,236 kg/m³). Re-send left
6 unchanged; a corrected mix updated exactly 1 row to revision 2. Manager reads but cannot map, a
Driver is refused everything, unset `PLANT_API_KEY` closes the endpoint. Both checkers green — 71
routes with both guards, 166 files with no UTC dates.

Three runtime-only bugs caught: `prod.rows[0]` after destructuring had already unwrapped it; a `//`
comment inside a SQL template literal (a Postgres syntax error, not a comment); and a correlated
subquery on a column that IS in the GROUP BY — Postgres will not match a grouping expression through
a subquery boundary, so it had to sit inside `bool_or(EXISTS (...))`.

`GET /plant/production` returns the day as a plain `YYYY-MM-DD` string, not a DATE: node-postgres
turns a DATE into a JS Date at the session timezone and the browser converts it back, which is the
exact round trip behind this app's UTC/IST bug every time it has appeared.

**Not yet done**: `npm run probe` on the plant control PC, and mapping its real silos.

## Round 156 — what the first week of live weighbridge data taught us (v9.82)

Three corrections to Round 154, all reported by the plant within days of the agent going live.

**ONE WEIGHBRIDGE NAME != ONE MATERIAL.** Round 154 keyed mappings on the normalised name alone. The
plant buys fly ash from JSW, Thoothukudi and Adani and the weighbridge calls all three `FLY ASH` — the
SUPPLIER is the only discriminator. Material mappings now carry an optional `supplier_scope_id`; most
specific wins, unscoped is the fallback. Two PARTIAL unique indexes, not one constraint, because NULLs
never collide in a Postgres UNIQUE index. The unmapped queue reports a material per supplier.

**CHANGING A MAPPING HAD TO ACTUALLY CHANGE SOMETHING.** The Change button reported success and moved
nothing, because reresolveOutstanding only swept `needs_review`. It now also sweeps MATCHED tickets
that NO RECEIPT HAS CLAIMED. A claimed ticket is left alone on purpose — its material is already
credited to stock and priced into a weighted average; correct those by editing the receipt.

**VEHICLE REGISTRY, replacing map-it-or-ignore-it.** Nearly every lorry here is a supplier's, so the
Round 154 binary meant discarding the vehicle on almost every ticket. `weighbridge_vehicles` now holds
one row per lorry, AUTO-CREATED on first sight — critical, because the plant does not know a
supplier's registration until the lorry is on the weighbridge, so anything needing pre-registration
would never be done. Vehicles no longer appear in the review queue at all and never block a ticket. A
registration exactly matching one of our active trucks self-links (our own fleet list, not a guess).
Screen shows trips/tonnage/avg load/usual tare, owner assignment, and typo merging that leaves an
alias behind. `is_junk` is what "not ours" means now: test weighments only.

**RE-CHECK ALL** (`POST /weighbridge/recheck`). The gap the plant hit day one: re-resolution ran only
on a MAPPING change, so populating the Material Module masters reached nothing already synced — 129
tickets stuck against records that would have matched.

**RECEIPTS PICK UP THE WEIGHBRIDGE.** `GET /material-module/orders/:id/weighbridge-tickets` offers
matched, unclaimed tickets matching the order's material AND supplier. Fills weighed net, vehicle, real
DC number — deliberately NOT the billed quantity (the weighbridge has a DC number field but no DC
quantity; that missing figure is what makes short-load checking possible). Accepted qty DOES default
from the weighed figure — unlike Round 155's cube count, the machine knows this answer. Short load
FLAGS, never blocks, but beyond tolerance requires `short_reason`: blocking would push Store into not
recording the load or fudging the quantity. Guards: no double-claiming a ticket, claimed tickets drop
off the list, needs_review tickets refused.

**BUG CAUGHT IN VERIFICATION:** the vehicle auto-link reused `$1` as both a varchar column value and a
text comparison; Postgres refuses with "text versus character varying" (42P08). Cast both uses.

## Round 155 — security, a permission leak, the lost cube batches, and the end of the date bug (v9.81)

Cleared everything outstanding from the Round 145-154 review (`claude/code-review-rounds-145-154.md`).

**AUTH — the token proves WHO, never WHAT.** `requireAuth` used to trust the JWT payload whole, and
the token lives 30 days. So deactivating somebody revoked nothing (`is_active` was read only in
`GET /auth/me`, which just logs the frontend out) and changing a role did nothing (`requireRole` read
the role from the token). A demoted lab technician could still WRITE lab records. Both reproduced
live. Now `requireAuth` reads `id, role, is_active` from `users` per request behind a 5-second TTL,
401s on inactive, and takes role/name from the row. `clearUserCache()` fires on every role change and
every activate/deactivate — including `administrator.js`'s own status toggle, which used to clear
nothing. Also: the old bare `catch` turned a DB hiccup into "your session expired"; only real JWT
errors say that now.

**PERMISSION LEAK.** `materialModule.js` gated stock rates and valuation with
`if (req.user.role !== "store")` — a string compare that excluded one role, so the PLANT OPERATOR
(in STOCK_READ_ROLES) received rate_per_kg, stock_value and cost_plant_consumption. Those belong to
`material.stock-valuation`, Administrator-only, and the Access Control page could not revoke them.
Now asks `can(req.user, "material.stock-valuation", "view")`. check-guards.mjs structurally cannot
catch this class — the route's declared key/action was legitimate; the leak was inside the handler.

**THE LOST CUBE BATCHES** (lab technician's report, from 21 Sept, reproduced exactly). QC's cube-count
box defaulted to 0; the lab's queue is `COALESCE(number_of_cubes,0) > 0`. QC filling slump + sample
IDs but not that box saved a good record the lab could not see. NOTE THE HISTORY BEFORE "FIXING" IT
AGAIN: it defaulted to 3 until Ver. 9.29, which created phantom batches; that was changed to 0, which
created this. Both defaults answer a question nobody asked. There is now NO default — blank, required,
0 is valid but must be stated; the order's `cube_samples_required` is shown beside the box ("order
asks for 3"), which the API always sent and the form never displayed; sample IDs alongside a zero
count is refused. REPAIR_155 back-fills existing rows from the number of sample IDs listed,
deliberately only where sample_ids is non-empty.

**DELIVERY CHALLAN MODULE — decided: stays separate, print-only.** A docket writes only to
`solitaire_dockets`; it raises no Delivery Note, records no QC, never reaches the lab. Round 151 moved
it into the header where everyone can reach it, which is when the plant started using it. The print
confirmation and the header tooltip now say plainly what it does and does not do.

**RECURRING BUG PATTERN #1 — ENDED MECHANICALLY.** All 49 remaining UTC-day sites converted across 25
files to new `backend/src/lib/istDate.js` and `frontend/src/lib/istDate.js`, plus
`backend/scripts/check-dates.mjs` (sibling of check-guards.mjs) so it cannot come back; `// ist-ok:`
is the escape hatch. Worst three fixed: stock cover inflated ~30x on the 1st of the month
(`new Date().getDate()` is the UTC day-of-month — and it also divided a PAST month's consumption by
today's day number); CubeTestReport's month filter wrong EVERY day (local-fields constructor printed
via toISOString lands on the previous month's last day); and dates written a day early into stored
records (follow-up due dates, mix-design effective dates, supplier rate valid_from, order_date, site
cast dates, payment dates).

**LESSON WORTH KEEPING:** a clean build did NOT catch the migration — four files called a helper they
had not imported, a runtime ReferenceError Vite compiles happily. A static "does every helper call
have a matching import" pass caught all four. Repeat that after any bulk sweep.

**STILL OPEN:** guard conversion is at 58 of 499 routes, and 94 of 111 catalogue keys gate nothing
server-side (they hide a tile but do not stop a direct API call). Weighbridge agent not yet installed
on the plant PC.

## Round 154 — Weighbridge integration (v9.80)

The SchwingSmartWeigh weighbridge feeds the app one-way. Built against the real 2,478-ticket
dump (Dec 2023 → Sep 2026) taken off the plant's MySQL 5.6 server, not the vendor's blank template.

**What the live data settled.** `transactiondet` (the 10-slot multi-material child table) has never
been used, so every ticket is single-material and we need no child table. `firstTransactionMaterial`
is misnamed — it holds the transaction PURPOSE ('Production Usage' / 'Ready Mix Invoicing' /
'Internal' / 'Scrap / Stock Transfer'), which is what separates an inbound receipt from an outbound
load; imported as `purpose`. `moisturepercentage`, `actualweight` and `ConcreteVolume` are free text
the operators type into ('N/A', 'NONE', '35610+91', driver names) and are NOT imported — `NetWeight`
is the only weight we trust. Every row is username='admin', systemid='Rajesh-PC', so no weighment
can ever be attributed to a person.

**Name resolution.** Vehicle/material/supplier are free text, not FKs — the same lorry appears nine
different ways. Two stages: normalise (uppercase, strip non-alphanumeric), then an alias table a
human maintains. NO fuzzy matching, deliberately — '20MM' and '12MM' are two edits apart and a wrong
auto-match misroutes stock for a month. Two masters normalising identically (the dump's two SREE
MUTHAPPANs) = unresolved, not a coin toss. Material blocks a match; supplier blocks unless blank;
vehicle never blocks (most lorries are suppliers' and will never be in `trucks`).

**Tables.** `weighbridge_tickets` (PK = the weighbridge's own TicketNumber, raw values stored
verbatim as the audit trail alongside our resolved ids), three alias tables, `weighbridge_sync_log`,
and `rm_receipts.weighbridge_ticket_id` (shipped unused — Round 155 wires it up).

**Sync.** `POST /api/weighbridge/sync`, API-key auth via `WEIGHBRIDGE_API_KEY`, declared above that
router's own `requireAuth`. Unset key = endpoint closed, not open. Idempotent upsert on
ticket_number; SmartWeigh has no `updated_at`, so the agent re-sends a trailing 30-day window and
the server compares a SHA-256 — unchanged rows cost nothing. `match_status` is CASE-guarded so a
human's 'ignored' survives any re-sync.

**Agent.** `tools/weighbridge-agent/`, Node + mysql2, read-only MySQL account (NOT root). No offline
queue on purpose: the weighbridge's own database IS the queue, so a failed post just leaves the
cursor unadvanced. Columns discovered at runtime via SHOW COLUMNS. `startDate` = 2026-09-01 per the
plant's decision — this month only, not the 2023-25 backlog.

**Screens.** `/weighbridge`, two tabs (Receipts / Name mapping). Resolved name and raw spelling shown
together. Header strip carries the agent's last check-in, because a stopped sync is otherwise
invisible until stock comes up short. Keys: `material.weighbridge` (admin/manager/store view+edit,
plant_operator/lab_technician view) and `material.weighbridge-mapping` (Administrator ALONE — a
mapping decides where stock is credited for every past and future ticket with that spelling).
REPAIR_154 in setup.js, same pattern as REPAIR_148/153.

**SECURITY, outstanding at the plant.** The weighbridge MySQL root password is literally `root`, in
plain text in `driver.xml`; the SmartWeigh app login is `admin`/`essae`. Anyone reaching that PC can
rewrite every weighbridge ticket. Flagged to the user; the agent uses its own read-only account.

**Recurring bug pattern #23 — caught again, in new code.** `ticket_date` was built by slicing a UTC
ISO string, i.e. the UTC day; anything weighed before 05:30 IST filed under yesterday. Found live on
ticket 2471. This is the same UTC-vs-IST class as rounds 153 and earlier. Also fixed: re-resolution
after a mapping only swept `needs_review`, so a vehicle mapped after the fact never reached an
already-matched ticket and the lorry stayed unattributed forever.

## Round 152 (Ver. 9.78): real MCI370 panel image, shared masters, bulk mix upload

**Visit `/setup?key=...` once** — new `customers.code` and `trucks.truck_code`, wider mix designs,
docket FKs re-pointed.

**The screen overlays the REAL panel photograph**, which now ships at
`frontend/public/solitaire/screen-reference.png` (1366x721, supplied by the user 22 Sep). A CSS
reconstruction was built this round and then reverted at the user's request — a photo of the real
thing beats a rebuild.

**`COORDS` is verified, not guessed.** Every box was detected in the image programmatically and
converted to percentages; the values matched the pre-existing ones to ~1%, proving the original
overlay had been calibrated against this exact screenshot. Round 149's failure was ONLY the missing
image. **If the image is ever replaced, re-measure — do not nudge by eye**, and keep 1366x721
(`.sol-entry-bg` sets that aspect ratio).

**All eight menu words are hotspots**, with tooltips and hover highlight. Master/Options open menus;
the six plant-control words explain they belong to the plant's MCI370.

**The safety net that must stay**: `imgFailed` → a visible `.sol-toolbar`. If the image fails to
load the module degrades to usable, not to a white page with invisible menus. Never remove this.

**Known and deliberate**: the weigher panels, mixing timers and alarm grid in the photo are PLC
telemetry. There is no PLC feed — they are backdrop only. Do not overlay fake numbers on them.

**Masters come from the MAIN app** — `customers`, `sites`, `trucks`, and drivers from `users`. The
module's own write endpoints for those are **removed and must not be re-added**: a Solitaire session
is a separate trust boundary and must not rename a customer the business invoices against.
`solitaire_customers` / `_sites` / `_trucks` still exist but are dead.

**Driver is no longer derived from the truck.** The workbook looks one up from the other; the app
records who actually drove (`solitaire_dockets.driver_user_id`).

**Docket FK re-point was guarded on the table being EMPTY.** It was free because nothing had ever
printed. If dockets ever exist the block no-ops and `/setup` says so — a real data migration would
be needed then.

**Mix designs widened to 24 columns** (absorption ×4, moisture ×4, water variance min/max) and
bulk-uploadable from the workbook itself, **parsed in the browser** (SheetJS already bundled) so no
server-side spreadsheet dependency. Upsert on `code`; a code absent from the upload is left alone.

**The mapping trap, worth keeping**: mapped by COLUMN LETTER, not header text. The sheet's `R3`
header reads "20MM%" but the column is the first M Sand's **moisture** — confirmed against the
`Load` sheet's VLOOKUP column indexes (`W47`→col 13=N, `W48`→col 17=R). Header-driven mapping would
have loaded moisture into the wrong ingredient silently. Also found: `M 25 (KSEB)` appears **twice**
in the user's sheet.

**Verification**: FKs confirmed pointing at `customers`/`sites`/`trucks`/`users`; second `/setup` a
no-op. The **real workbook** uploaded live — 44 created from 45 rows, the duplicate collapsed,
re-upload 0 created / 44 updated with 44 still in the table; one recipe compared field by field
against the sheet, exact match. Module confirmed reading the main app's masters. Screen rendered
headless at 1366px and 390px **with no image on disk**: 6 group boxes, 5 green selects, 44 recipes
and 4 customers in the dropdowns, zero overflow, no console errors. First render had the Consignment
fields in the wrong rows vs the reference; corrected to three explicit columns and re-checked.

**Still open → Round 153**: punch-list items 1 (today's delivery notes on the Plant Operator screen,
MAIN APP notes, new permission), 3 (distance since last fill on the Manager fuel card), 4 (fuel
analysis for pumps and other equipment). Then the print agent (`claude/solitaire-print-agent-notes.md`).

## Round 151 (Ver. 9.76): Delivery Challan made usable, plus four fixes

**No schema change** (one new endpoint, so redeploy the backend). `/setup` not needed.

**The blocker — my miss from Round 149.** The module's Master and Options menus were **transparent
hotspots positioned over the MCI370 panel photograph**, and that artwork was never delivered with
the code. I called the missing images cosmetic. They were not: on the live install the menus were
invisible rectangles in white space, and behind them sat **Device Management, Settings and every
master-data screen**. Fixed with a **real toolbar in normal document flow** (px-sized, not vw). The
hotspots are deleted. **Rule to keep: navigation must never depend on an image loading.** The two
images still belong in `frontend/public/solitaire/` but nothing breaks without them now.

**Items 7 + 9**: the Delivery Challan entry moved from a Plant Operator tile into the **header**
(`TopBar.jsx`, gated by `SOLITAIRE_ROLES`), and Plant Operator / Lab Technician / **Administrator**
all see it — the Round 149 "Administrator has no access" instruction was revisited by the user.
**Unchanged and important**: enabling/disabling the plugin and granting access stay Super Admin
only behind the locked `admin.plugins`. Opening a module ≠ handing it out.

**Item 2**: quote request grades now M10–M55 (was M15–M40). Sales Executive lead-capture list
extended to match so the two cannot drift.

**Item 5 — worth remembering as a pattern.** The cube-test "7-day / 28-day overlap" was NOT that
screen's layout: the shared `.field-input input` rule sets `width:100%` + padding + border, which
stretched every RADIO across its label as a big box with the text on top. Fixed at the shared rule
(`input[type=radio]`/`[type=checkbox]` → `width:auto`, no padding/border), because it affected every
such form in the app.

**Item 6**: site-cast results can have their test date changed — twin of the plant-pour endpoint
from Round 124. New `PATCH /lab-technician/site-cube-tests/:resultId/date`. The date draft is built
from **local calendar fields, not `toISOString()`** — the recurring IST/UTC trap.

**Verification**: driven headless **with the panel image genuinely absent from disk** (the
real-world state) — all toolbar buttons visible, Options → Settings → Device Management reachable
with both "Authorize this browser" and "Get a code for another machine", Master menu listing all
three master screens. Header link present in `.topbar` for Super Admin and Lab Technician at 390px,
zero overflow. Radio fix **measured**: 13px radio, no padding/border, while a text input in the same
form stays 271px.

**Still open from the same punch list → Round 152**: (1) today's delivery notes on the Plant
Operator screen with open/print, gated by a new permission — the user confirmed these are the MAIN
APP's delivery notes, not Solitaire dockets; (3) distance travelled since last fill on the Manager's
fuel approval card; (4) fuel consumption analysis for pumps and other equipment.

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
