# MCI370 (Schwing Stetter batching plant) integration — notes

Status as of 2026-09-25: **built and verified in Round 157 (v9.83), not yet deployed to the
plant control PC.** The agent lives in `tools/mci370-agent/`.

**Scope changed on 2026-09-25.** The Solitaire/Excel print pipeline this doc originally
described is **dropped**. The user's decision, in their words: *"as you said you are not able
to add a search and print option inside MCI370, we will drop solitaire related works, only
proceed with collecting production and raw material consumption data from the plant."* What
remains is item 4 of the old plan — the production and consumption pull into the OORM app —
which is what Round 157 built. The print-agent sections below are kept only as a record of
why that path was abandoned.

## Two rules that are not negotiable

1. **MCI370.exe is never modified.** It is Schwing Stetter's closed, compiled VB6 control
   software running the machine that batches the concrete. There is no supported way to add a
   menu item or a feature to it, and patching the binary would be irresponsible. This was
   explicitly ruled out with the user and is the reason the print work was dropped rather than
   attempted.
2. **MCI370's database is never written to.** The agent copies the `.mdb` and reads the copy,
   so a batch in progress cannot be disturbed. Jet/Access file locking against live control
   software is exactly the risk not worth taking, and no vendor-supported write contract
   exists in any case. The integration is one-way.

## Reading the database without installing anything

The live database is a standard MS Jet 4.0 `.mdb` at `C:\SSI\MCI370\MCI70_batch.Mdb` (the
default from `SETUP.LST`; confirm on the actual machine).

**Jet 4.0 ships with Windows but only in its 32-bit form.** The agent therefore calls
`C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` explicitly and goes through ADODB
(`readMdb.ps1`, opened with `$conn.Mode = 1`, read-only). The payoff is that **no driver and no
Access Database Engine redistributable has to be installed on the plant PC at all** — nothing
is added to a machine whose job is to run the plant. On genuine 32-bit Windows the agent falls
back to the `System32` path.

`readMdb.ps1` stamps every DateTime it returns with `+05:30` rather than letting it come back
ambiguous, for the same reason the rest of this app centralises IST handling.

## The confirmed schema (verified against real rows, 2026-09-25)

Read via `mdbtools` in the session sandbox from the vendor's package copy, which carries a
small amount of the vendor's previous customer's real data. **This is where the earlier
provisional map was wrong and had to be corrected.**

### `Batch_Dat_Trans` — one row per LOAD

`Batch_No`, `Batch_Date`, `Batch_Time`, `Batch_Year`, `Batcher_Name`, `Customer_Code`,
`Recipe_Code`, `Recipe_Name`, `Mixing_Time`, `Mixer_Capacity`, `strength`, `Site`, `Truck_No`,
`Truck_Driver`, `Production_Qty`, `Ordered_Qty`, `Returned_Qty`, `WithThisLoad`, `Batch_Size`,
`Order_No`, `Plant_No`, `Weighed_Net_Weight`, `Weigh_Bridge_Stat`.

### `Batch_Transaction` — one row per MIX, keyed `Batch_Index`

`Gate1..6_Actual/Target/Moisture`, `Cement1..4_Actual/Target/Correction`, `Filler1_*`,
`Water1/2_*`, `Silica_*`, `Slurry_*`, `Adm1_Actual1/2`, `Adm2_Actual1/2`, `Pigment_*`,
`Consistancy`, `Plant_No`.

**A LOAD IS SEVERAL MIXES.** This is the single most important fact about this data and the
thing that would quietly corrupt every figure if missed. A 6 m³ load is six mixes.
Consumption sums across them; production does not. The natural key is
(`Plant_No`, `Batch_Year`, `Batch_No`, `Batch_Index`), which is what `plant_batches` is unique
on.

### `NameSetUp` — what the plant calls each hopper

`Gate1Name`..`Gate6Name`, `Cem1Name`..`Cem4Name`, `FillName`, `Wtr1Name`, `wtr2Name`,
`Admix1Name`, `Admix12Name`, `Admix2Name`, `Admix22Name`, `SilicaName`, `SlurryName`,
`PigName`, `CompanyName`, `PlantSlNO`.

This table is why silo identity never has to be guessed from weights. A real row from the
vendor's previous customer: `Gate1Name="40 MM"`, `Gate2Name="SAND"`, `Gate3Name="10 MM"`,
`Gate4Name="20 MM"`, `Gate5Name="0"`, `Gate6Name="Agg6"`, `Cem1Name="FLY"`, `Cem2Name="CEM"`,
`FillName="FLYASH"`, `Wtr1Name="WATER"`, `wtr2Name="-"`, `SlurryName="Slurry"`.

Note `Gate5Name="0"`, `wtr2Name="-"` and `Gate6Name="Agg6"` — **placeholder names the panel
leaves in unused hoppers.** `plantSlots.js` recognises these (`UNUSED_SLOT_NAMES`) and skips
them rather than presenting empty hoppers as mapping work.

### The 1899 date trap

A real `Batch_Transaction` row reads `Batch_Date: "08/11/16 00:00:00"` and
`Batch_Time: "12/30/99 11:02:20"`. **The time field carries an 1899 date.** The day must come
from `Batch_Date` and only the clock from `Batch_Time` — `combineDateTime()` in `agent.js`
does exactly that, and was verified producing `2016-08-11T11:02:20+05:30` from that row.

## CORRECTED AGAINST REAL PLANT DATA (2026-09-25)

The user copied the live `C:\SSI\` folder across. The real `MCI70_batch.Mdb` is **46.7 MB**
against the installer template's 5.7 MB, and it overturned two things the template could not
have shown. **Everything in this section beats anything above it.**

Live figures at the time of reading: **2,495 loads, 18,505 mixes, 16,009.5 m3**, Feb 2025 to
25 Sep 2026, 22 recipes (M25B and M25A the most used), plant `OUR OWN RMC`, serial 160.

### Production_Qty is CUMULATIVE within the load — the bug this caught

`Batch_Transaction.Production_Qty` is a **running total of the load so far**, not that mix's
quantity. Mix 1 reads 1, mix 2 reads 2, mix 8 reads 8. Verified on **2,496 of 2,496 loads**,
zero exceptions.

Round 157 as shipped SUMS that column. On this data it reports **73,987 m3 instead of
16,010 m3** — every production figure 4.6x too high and every kg/m3 correspondingly too low.
It passed verification only because the synthetic payload used 1 m3 per mix, which happens to
make summing and cumulating agree.

Correct sources, both verified exactly across all 2,495 loads:
- per MIX quantity  = `Batch_Transaction.Batch_Size`
- per LOAD quantity = `Batch_Dat_Trans.Production_Qty`  ( == sum of that load's Batch_Size )

`Batch_Size` is the mixer drop (1 m3 here); `Mixer_Capacity` agrees. Note `WithThisLoad` means
different things in the two tables: cumulative m3 within the load on the mix row, cumulative
m3 delivered against the ORDER on the header row.

### Better fields than the ones Round 157 chose

- **`Batch_Start_Time` / `Batch_End_Time`** on the header are clean text ('11:57:16 AM',
  '12:05:51 PM'). Use these for load start/finish. They sidestep `Batch_Time` entirely, which
  on real data is always stamped `12/30/99` — the 1899 date trap, confirmed live.
- **`<slot>_Rec` on the header** (`Gate2_Rec`, `Cem1_Rec`, `Wtr1_Rec`, `Adm1_Rec` …) is the
  **recipe design quantity per m3**. This is the "theoretical" figure the user asked for. Three
  levels are therefore available and should all be kept: `_Rec` (design) → `_Target`
  (moisture-adjusted, per mix) → `_Actual` (weighed).
- **`Customer_Master`** (41 rows) maps `Customer_Code` to `Customer_Name`. In practice the code
  IS a name here ('ABDULLA'), but the table should still be read.
- `Truck_No` arrives spaced — `'KL 60 U 8198'` — the same normalisation problem the weighbridge
  has. Store verbatim, normalise to match.

### Their actual hoppers — only 9 of 20 ever fire

`NameSetUp` reads: Gate1 `M SAND`, Gate2 `M SAND`, Gate3 `12MM`, Gate4 `20 MM`, Gate5 `0`,
Gate6 `Agg6`, Cem1 `CEM1`, Cem2 `CEM2`, Cem3 `CEM3`, Fill `FLYASH`, Wtr1 `WATER`, wtr2 `-`,
Admix1 `ADMIX1`, Admix12 `1`, Silica `-`, Slurry `Slurry`.

Firing counts out of 18,505 mixes: gate2 18,480 · gate3 18,482 · gate4 18,479 · cement3 18,457
· water1 18,499 · adm1a 18,456 · cement2 12,181 · cement1 6,296 · **gate1 only 23**. Everything
else never fires, `FLYASH` (filler1) included.

- **Gate1 and Gate2 are both named `M SAND`** and both really are sand; Gate1 is a rarely-used
  spare (user confirmed). Because two hoppers share one name, silo aliases must be keyed **per
  slot**, not per name, or renaming one silently re-points the other.
- `Admix12Name` is `'1'` — a placeholder not in `UNUSED_SLOT_NAMES`. The slot never fires, so
  it is harmless, but `'1'` should be added to the placeholder list.
- `Batcher_Name` is `'Stetter'` on all 2,495 loads — the vendor's login account, not a person.
  The earlier note calling it "the only per-batch operator identity" is WRONG in practice.

### CEM1/CEM2/CEM3 are refillable silos, not fixed materials (user, 2026-09-25)

The decisive correction. These are **storage silos that get filled with whatever cement or fly
ash was bought** — Ramco this month, Ultratech next. A static silo-to-material mapping is
therefore wrong: it would mislabel all history the moment a silo is refilled.

The model is a **contents timeline**. Store says which silo a cement/fly-ash receipt went into;
from that fill until the next one, the silo holds that material. A mix is attributed to whatever
the silo held at the time it was batched. This also yields a **running balance per silo**
(filled minus consumed), which is both operationally useful and a cross-check between the plant
and the Material Module.

User's decisions on the detail:
- Brands are **separate material records** ("OPC Ramco", "OPC Ultratech"), so a fill points at
  one material.
- **One receipt fills one silo** — a single "which silo?" choice on the receipt.
- **Top-up before empty**: the new material takes over from the fill onward, and the fill is
  marked as having gone in on top of a remaining balance. No extra work for Store, honest about
  the overlap rather than pretending precision.
- **History is left alone**: current contents are declared once, attribution runs from there.
  The 18,505 existing mixes keep cement-by-silo with no brand behind them.

Aggregates, water and admixture keep the simple per-slot mapping — only the powder silos are
refillable.

## How Round 157 uses it

Twenty physical slots in `backend/src/lib/plantSlots.js` (6 aggregate, 8 powder, 6 liquid). An
Administrator maps each hopper name once to one of our materials, or marks it not-stock.

**Consumption is reported by silo, not by material** — deliberately the opposite of the
weighbridge. An unmapped hopper still shows its real weights because the plant genuinely
weighed them; the numbers are true before the mapping work is done. At the weighbridge an
unresolved name means we do not know what arrived, so a total would be a lie.

`POST /plant/recheck` re-resolves already-synced rows after materials are added to the
masters — the gap Round 156 hit on the weighbridge's first live day, applied here up front.

Verified end to end: six mixes → one 6 m³ M25 load, and consumption at textbook M25
proportions (323 kg cement, 80 fly ash, 764 sand, 620 + 300 aggregate, 150 water per m³;
2,236 kg/m³ overall). That sanity check is the only real test of a field map derived from a
blank template, which is what the original map was.

## Deploying to the plant control PC

1. **`npm run probe` first.** It answers the four things that actually go wrong — is 32-bit
   PowerShell where we expect it, will Jet open this file, has the plant named its hoppers,
   and is there real data — and it reads only, sending nothing anywhere. It also prints the
   three most recent mixes so the weights can be eyeballed: they are kilograms for ONE MIX,
   so a 1 m³ mix is roughly 2,400 kg all told.
2. Set `PLANT_API_KEY` on the backend and put the same value in the agent's `config.json`.
   **Left unset the sync endpoint is closed, not open** — verified.
3. `startDate` in the config controls the backlog. The weighbridge rollout wanted only the
   current month; expect the same here.
4. Then map the real silos on the Silos tab, and run Re-check all.

Task Scheduler is the known rough edge from the weighbridge rollout — `0x80070002` means the
Program/script path is wrong, and `where node` on that machine gives the real one.

## The Crystal Reports dead end — do not revisit

`Support\batch.rpt` and its siblings are ~Crystal 8 era reports run through
`MCI370_Report.exe`, a viewer rather than a designer. Reading the embedded SQL out of
`batch.rpt` returned high-entropy binary; Schwing Stetter appears to lock or obfuscate them.
No further attempt should be made. With the print pipeline dropped this is moot in any case.

---

## MixTrack — the plant feeds the delivery ticket (decisions, 2026-09-25)

### Vocabulary — ours, not MCI370's

The user's terms, which the app should use everywhere:

- **Load** = a truckful. The set of mixes discharged into one truck.
- **Batch** = ONE mix. One drop of the mixer into that truck.

**This collides head-on with MCI370's own field names, and the collision must be
kept straight in every future conversation.** MCI370's `Batch_No` identifies a
LOAD (it keys `Batch_Dat_Trans`, one row per truck). Its `Batch_Index` identifies
a BATCH within that load. So "Batch_No" is the load number, not the batch number.
Their plant averages 7.4 batches to a load.

### Solitaire is renamed MixTrack

The user was confusing "delivery challan (Solitaire)" with the app's own delivery
challan. Solitaire becomes **MixTrack** everywhere — user-visible names first.
The internal table and route names (`solitaire_dockets`, `/api/solitaire`, the
`solitaire.*` permission keys) can be renamed behind a migration or left alone;
renaming the tables is the riskier half and is not required for the confusion to
go away.

### The print pipeline is BACK, driven by the agent

What was dropped was adding a search-and-print screen *inside* MCI370.exe. That is
still ruled out. Driving MixTrack from the plant agent was never the problem and is
now the centre of the work.

Per load, the agent passes to MixTrack: customer name (mapping), mix code and name
(mapping; the mix design itself comes from the workbook), site (mapping), the load
number, start and end time, vehicle and driver with our truck id (mapping),
moisture, order quantity and supplied-so-far. **Load quantity is typed by hand in
MixTrack, per load** — the one manual step, and nothing prints without it.

Then: print the ticket automatically, file a PDF, offer a search window modelled on
MCI370's own reports screen, and create the app's delivery challan from the same
data with a manual route kept for when the automatic one fails.

**Extra time per customer or site.** The ticket's finish time must be able to carry
an allowance for QC delays at the plant. This REPLACES the workbook's own
auto-calculated finish time — the sheet takes the value instead of computing it, and
the user will modify the workbook accordingly.

### Auto plus manual, never instead of

Both consumption and production take the plant's figure as read-only and let the
operator enter **only the part the plant did not record**. The two are ADDED.
Raw-material cost analysis divides by the combined production figure — on the
mockup's own numbers, leaving the manual 3 m3 out would overstate cost per m3 by
4.7%.

### Dropped from scope (user, 2026-09-25)

Cube test records, customer orders, and fleet/delivery as destinations for plant
data. Not wanted now.

### Outstanding

- **The MCI370 reports screenshot never arrived.** The search window is currently a
  reasonable guess; it should be matched to the screen the operator already knows.
- Whether the ticket prints at the end of the LOAD (assumed) or literally at the end
  of each batch — the latter would print seven or eight tickets per truck.
- The modified workbook, once the finish-time formula is replaced by a value.
