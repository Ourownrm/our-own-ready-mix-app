# Delivery Challan print agent — design notes (Round 149→151)

Written 20 Sep 2026, after reviewing the real workbook (`BPR107a.xlsm`, 405KB,
licence-free copy supplied by the user). **The workbook itself is stored in this
project as `assets/BPR107a-unlocked.xlsm`** — that is the file the agent drives.

## The decision, and why

The docket must print **byte-identical to today's**. The workbook carries
**thirteen `printerSettings*.bin` parts** — per-sheet paper size, orientation,
margins and scaling saved from a real Windows printer driver — and **29 VBA
modules**. LibreOffice ignores the former and cannot execute the latter, so
server-side rendering would be *close* but provably not identical, and would
silently skip the `Worksheet_Change` handlers the sheet depends on.

So: **real Excel, on the plant PC, driven by a local agent.** No LibreOffice, no
Docker, no Render RAM/plan change, and no PDF storage growth in Postgres.

Rejected alternatives and why, so this is not re-litigated: server-side
LibreOffice (fidelity + VBA, above); Google Drive hosting (public-link exposure
or a service-account setup, and a network hop per print); rebuilding the docket
natively in the app (no licence or infra problem, but the user's priority is
exact format fidelity against a document that leaves with a truck).

## Architecture

App queues a print job → agent on the plant PC polls over HTTPS (outbound only,
no inbound firewall holes, works behind NAT) → agent opens the workbook through
Excel automation with the window hidden, writes the `Load` cells, lets Excel
recalculate, reads `Load!I40` for the sheet number, exports the PDF and prints →
writes the PDF to the configured folder and uploads a copy back for
Search/Reprint.

The operator never sees Excel. The job can be raised from anywhere; the plant
terminal prints it.

Plant PC confirmed by the user: **Windows 10/11, desktop Excel installed, on
24/7.**

## `Load` sheet input map (read off the sheet + Module37)

| Cell | Meaning | Label cell |
|---|---|---|
| `AN26` | Batch / report number | `AF26` |
| `M26`  | Customer | `F26` |
| `BN26` | Order quantity (m³) | `BH26` |
| `BE26` | With this load (m³) | `AT26` |
| `M29`  | Recipe code / grade | `F28` |
| `AO29` | Production quantity (m³) | `AF29` |
| `BG29` | Truck registration number | `AT29` |
| `AO31` | Mixer capacity / batch size | `AG31` |
| `AZ32` | Driver name — **FORMULA**, `VLOOKUP(BG29, 'Mix Design'!Z4:AA16, 2)`. Do not write; it follows the truck. | `AT32` |
| `M34`  | Site | `F34` |
| `AO34` | Moisture % — also written back to `Mix Design!S` per recipe by `Sheet8.cls` | `AG34` |
| `AZ34` | Order no — **FORMULA**, `=M26` | `AT34` |
| `H17`  | Date | `D17` |
| `H19`  | Time | `D19` |
| `M32`  | Recipe name — **FORMULA**, VLOOKUP into Mix Design | `F32` |
| `I40`  | **Sheet number** — `IF(AO29<=1,1,IF(AO29<=2,2,…))`, i.e. ceiling(production qty ÷ 1 m³), capped 1–9. Matches `computeSheetNumber()` already in `routes/solitaire.js`. | — |

Write only the non-formula cells. The formula cells resolve themselves.

## `Mix Design` sheet — the master data, and why the app must own it

It is an Excel Table (`Table24`) spanning `B..X`, and it holds far more than
recipes:

- `B` Raw Material (the recipe key, e.g. "M 7.5 A"), `C`–`M` per-m³ quantities
  (M Sand ×2, 12 MM, 20 MM, spare, Cem 1/2/3, Admix 1/2, Water)
- `N`–`Q` Absorption %, `R`–`U` Moisture %, `V`/`W` water variance min/max,
  `X` Mix Name (formula)
- **`Z` Vehicle list, `AA` Driver name, `AC` Customer name, `AD` Site**
- **`AF4` = the PDF save folder path** (currently `G:\BPR105\BATCH REPORT 2026`)

So the print template also contains the customer, site, truck and driver
masters. Leaving it as the source of truth would mean QC walking to the plant PC
to change a recipe, and editing Excel to add a truck — which is the opposite of
what the module is for.

**Therefore the app owns all master data** (`solitaire_customers`,
`solitaire_sites`, `solitaire_trucks`, `solitaire_mix_designs`) and the agent
syncs it INTO the Mix Design sheet before printing. The workbook becomes a
rendering engine, not a data store. Nobody opens Excel to maintain anything.

The module's save-folder setting is written into `AF4` before each print, so the
existing macro drops the PDF exactly where the user configured it.

**Known gap to close in Round 151**: `solitaire_mix_designs` is narrower than
the sheet — it has the ten quantity fields but not the four absorption
percentages, four moisture percentages, or the water variance min/max. QC would
otherwise be editing a subset while the workbook printed stale values for the
rest. Widen the table AND its screen.

## Existing macros worth knowing

- `Module37.PrintOrderandAsPDF` — the real print routine. Reads the folder from
  `Mix Design!AF4`, the sheet from `Load!I40`, shows a **Yes/No confirmation
  MsgBox**, then `PrintOut` + `ExportAsFixedFormat` to PDF. The agent needs a
  variant with the MsgBox removed — it runs unattended.
- `Module1` shells `cmd /c start "" /max "<file>" /p` to print the PDF.
- `Sheet8.cls` `Worksheet_Change` keeps `Load!AO34` and `Mix Design!S` in step
  when the recipe changes. This is why LibreOffice would get it wrong.
- `ThisWorkbook.HideExcelMenu` hides the Ribbon globally — harmless now that
  nothing calls it on open, but do not call it from the agent.

## Round plan

- **Round 150** — device pairing code (an Admin on an authorised browser
  generates a short one-time code; the new machine enters it at login).
  `max_devices` default **3** — plant, lab, office. This fixes a real defect
  found after Round 149 shipped: a brand-new machine can never authorise itself,
  because `POST /devices` registers the *calling* browser and requires a session
  that only an already-authorised browser can obtain. Today only the
  zero-devices bootstrap works, so the system supports exactly one browser.
- **Round 151** — the print agent, plus the mix-design widening and an
  agent-status indicator ("plant terminal connected, last seen 4s ago").
- **Later** — the weighbridge sync rides on the same agent, since it will
  already be installed and authenticated.
