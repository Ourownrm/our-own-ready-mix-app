# MixTrack print agent

Runs on the plant control PC. Claims a print job from the app, fills a copy of
`BPR107a.xlsm`, calls the workbook's own `PrintOrderandAsPDF` macro, and posts the PDF back.

It never touches MCI370 and never writes to the master workbook.

## What it needs on that PC

- **Node 18 or newer** (it uses the built-in `fetch`).
- **Excel**, already confirmed installed.
- A copy of `BPR107a.xlsm` at the path in `config.json`. Keep this as the master — the agent
  copies it per job and fills the copy, so it is never left holding the last load's values.
- A folder for the PDFs, local to this machine.

## Setup

1. Copy this folder to the plant PC, e.g. `C:\OORM\mixtrack-print-agent`.
2. Copy `config.example.json` to `config.json` and fill in `apiUrl`, `apiKey`,
   `templatePath` and `pdfFolder`.
3. Set `MIXTRACK_API_KEY` on the backend to the same value as `apiKey`.
   **Left unset, the endpoints are closed, not open** — the agent will get 401 on every call.
4. Run `npm run once` and watch it. With no job waiting it prints one line and exits.

## Excel has to be allowed to run the macro

The workbook is an `.xlsm` and the whole point is calling its VBA. Excel will block that
silently unless the file is trusted:

- Put the folder holding `BPR107a.xlsm` in **File → Options → Trust Center → Trust Center
  Settings → Trusted Locations**.
- The agent already opens the workbook with `EnableEvents = false`, so `Workbook_Open` does not
  fire and no licence check or dialog can appear.

If a job fails with a message about macros or a dialog, this is why.

## Task Scheduler — the part that cost a day on the weighbridge agent

Same setup as the other two agents, and the same two traps:

- **Browse to `node.exe`. Do not type or paste the path.** Pasting the output of `where node`
  into the Program/script box produces `0x80070002` — the task simply refuses to start with an
  error that says nothing useful. Clicking Browse and selecting the same file works.
- Run it as **SYSTEM** so there is no password prompt for "run whether user is logged on or
  not", and set the action to `agent.js --once` on a repeating trigger (every 1 minute is
  reasonable here — a truck should not wait).

**Unlike the weighbridge agent, this one has a further constraint: do not point `pdfFolder` at a
mapped drive.** The workbook shipped with `G:\BPR105\BATCH REPORT 2026` in its save-folder cell.
Mapped drives are per-user and SYSTEM has none, so the macro would fail to save and the failure
would look like the macro doing nothing at all. Use a local path, or a full UNC path
(`\\server\share\...`). The agent writes this cell itself before printing, so whatever is in the
master workbook is overridden.

## Bitness — the opposite of the MCI370 agent

The MCI370 agent needs **32-bit** PowerShell, because Jet 4.0 only exists in 32-bit.

This agent needs PowerShell matching **Excel's** bitness, because it drives Excel through COM.
Excel on a modern machine is 64-bit and the default is right. If Excel here is 32-bit, set
`powershellPath` in `config.json` to
`C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`.

Getting this wrong gives "Cannot create ActiveX component" or a COM class error.

## What it checks before printing

After filling the cells it compares the workbook's own `Load!I40` against the sheet number the
app computed. They must agree. If they do not, **nothing prints** and the job fails with both
numbers in the message — because on this ticket the sheet number decides how many batch blocks
appear, so the wrong sheet means a ticket showing eight batches for a four-batch load.

## The PDF ends up in two places

The folder on this PC keeps every one, indefinitely. The app keeps a copy for two months so the
search window works from a phone; after that it clears its copy and the search window reprints
from this folder using the workbook's own `PrintPDFFromFolderByNumber`.

So do not clear out `pdfFolder` on a schedule. It is the long-term archive.

## Logs

`agent.log` beside `agent.js`, rotating to `agent.log.1` at 1 MB. Under Task Scheduler there is
no console, so this file is the only record — check it first when something has not printed.
