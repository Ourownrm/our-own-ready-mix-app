# MCI370 plant agent

Reads what the batching plant made and what it consumed, and sends it to the OORM app.

It is **one-way and read-only**. It never changes MCI370, never writes to MCI370's database,
and never sends anything back to the plant. It copies the database file and reads the copy, so
a batch in progress cannot be disturbed by anything this agent does.

**No driver has to be installed.** Windows already has what this needs.

Run this on the plant control PC — the computer MCI370 itself runs on.

---

## Before you start

You need three things:

1. **Node.js** on the plant PC. Get the LTS version from nodejs.org and install it with all
   the default options. To check it worked, open Command Prompt and type `node -v` — it should
   print a version number.
2. **The path to MCI370's database.** Normally `C:\SSI\MCI370\MCI70_batch.Mdb`. If it is not
   there, find it by opening Command Prompt and typing:

   ```
   dir /s /b C:\MCI70_batch.Mdb
   ```

3. **The plant key** — a long password that the app and this agent both know. Step 2 below.

Copy this whole folder to the plant PC. Somewhere simple like `C:\oorm-plant` is best.

> **Watch out for a nested folder.** If you unzip and drag the folder across, you can end up
> with `C:\oorm-plant\mci370-agent\agent.js` instead of `C:\oorm-plant\agent.js`. The commands
> below are run from whichever folder `agent.js` is actually in. To check, type
> `dir /s /b C:\oorm-plant\agent.js` and use the folder it reports.

---

## Step 1 — probe first, before anything else

This is the most useful five seconds of the whole install. It reads only and **sends nothing
anywhere**, and it tells you whether this machine can do the job at all.

Open Command Prompt, go to the folder, and run:

```
cd C:\oorm-plant
npm run probe
```

It checks four things in order and stops at the first one that fails:

1. Is 32-bit PowerShell where we expect it?
2. Does the database exist, and will it open?
3. Has the plant named its hoppers in MCI370, and what did it call them?
4. Is there real batch data, and what does one mix look like?

**Look carefully at the weights it prints for the three most recent mixes.** They are
kilograms for **one mix**, not one load. A 1 m³ mix is roughly 2,400 kg all told — aggregates
in the high hundreds, cement in the low hundreds, water around 150 to 200. If the numbers are
nothing like that, stop and send the output back rather than carrying on.

If the probe cannot find the database, pass the path to it directly:

```
npm run probe -- "C:\SSI\MCI370\MCI70_batch.Mdb"
```

---

## Step 2 — set the shared key

The app will not accept anything from this agent without a key. **If the key is not set on the
app, the connection is closed, not open** — so this step is not optional.

On Render, open the backend service, go to **Environment**, and add:

```
PLANT_API_KEY = <a long random password you make up>
```

Make up a real one. Do not use the words on this page — that mistake was made during the
weighbridge install, where the example text became the actual password. Something like
`Ourownrmc-Plant-4Hn8Qr2Wz` is fine. Save it, and let Render redeploy.

Keep that value to hand; you need it again in the next step.

---

## Step 3 — install and configure

Still in the same folder:

```
npm install
```

Then make a copy of `config.example.json` called `config.json` and open it in Notepad:

```
copy config.example.json config.json
notepad config.json
```

Fill in:

| Setting | What to put |
|---|---|
| `mdbPath` | The database path the probe confirmed |
| `appUrl` | Your backend address, e.g. `https://oorm-backend.onrender.com` |
| `apiKey` | **Exactly** the `PLANT_API_KEY` value from Step 2 |
| `startDate` | How far back to go the first time, e.g. `2026-09-01` |
| `plantNo` | `1` unless you run more than one plant |

Leave the rest alone. Save and close.

`config.json` holds the key, so it is deliberately not included in the zip and never goes back
to us.

---

## Step 4 — try it once

```
npm run once
```

It reads, sends one batch of data, prints what happened, and stops. You should see counts of
inserted, updated and unchanged records.

Now open **Plant Production** in the app. Production and Consumption should show real numbers,
and the Plant agent indicator at the top right should say Live.

Run it a second time. Everything should come back **unchanged** — that is the agent proving it
will not double-count.

---

## Step 5 — map the silos

One-off job, done in the app, by an Administrator.

Open **Plant Production → Silos**. It lists every hopper the plant has actually used, under the
names MCI370 itself gives them. For each one, say which of your materials it holds. For mains
water or anything that is not stock, choose **Not a stock material** — its weights still show
in Consumption, they just do not come off anybody's stock.

Hoppers the panel has left with placeholder names like `0`, `-` or `Agg6` are recognised as
unused and will not appear asking to be mapped.

After you add a new material in the Material Module, come back and press **Re-check all** —
batches that have already synced do not re-examine themselves when a new material appears.

---

## Step 6 — leave it running

Exactly the same setup as the weighbridge PC, and for the same reasons. Run it
as a **scheduled task firing every five minutes**, not as a window somebody can
close. `npm start` is for testing.

**General tab.** Name it `OORM plant sync`. Click **Change User or Group…**,
type `SYSTEM`, **Check Names**, OK. "Run whether user is logged on or not"
selects itself and no password is asked — which is the whole point, since the
plant PC's account is unlikely to have one. Tick **Run with highest
privileges**.

**Triggers tab.** New → **At startup**, with **Delay task for** `2 minutes`.
Then **Repeat task every** `5 minutes`, duration **Indefinitely**.

**Actions tab.** For **Program/script** click **Browse…** and select
`node.exe`. Do not type `node` and do not paste the path — both fail at run
time with `0x80070002 — the system cannot find the file specified`. Only
browsing works. `where node` tells you the folder, usually
`C:\Program Files\nodejs\`. **Add arguments**: `agent.js --once`. **Start
in**: this folder.

**Settings tab.** Untick **Stop the task if it runs longer than 3 days**. Tick
**Run task as soon as possible after a scheduled start is missed**. Set **If the
task fails, restart every** 1 minute, 3 attempts.

Test with right-click → **Run**: **Last Run Result** `0x0`, no window. That
proves the action, not the schedule — for the schedule, reboot and check **Last
Run Time** moves within five minutes.

Nothing is lost while the agent is stopped. Every batch stays in MCI370 and
arrives whenever it next runs; it picks up where it left off rather than
keeping its own copy of anything.

### The log file

The task runs invisibly, so the agent writes everything to **`agent.log`** in
this folder — each cycle, the counts, and the full error when something fails.
Past a megabyte it rotates to `agent.log.1`, so it cannot fill the disk.

When the app says the plant agent has gone stale, that file says why. It is
also the most useful thing to send back when asking for help.

## What it actually sends

Per mix: the batch number and index, date and time, recipe, quantity produced, and the actual
and target weight for each hopper, plus aggregate moisture. Per load: customer code, site,
truck, driver, batcher and order number.

That is all. It does not send, and cannot send, anything that would let the app change the
plant.

---

## If it stops working

**"Not authorised"** — the key in `config.json` does not match `PLANT_API_KEY` on Render, or
the key was never set there. Check both, watching for stray spaces.

**"The Jet provider could not be loaded"** — something ran 64-bit. The agent always calls the
32-bit PowerShell explicitly, so if the agent itself works you can ignore this appearing in a
probe.

**The database cannot be opened, or is locked** — the agent copies before reading, so this is
usually a permissions problem rather than MCI370 holding the file. Check the account the
scheduled task runs as can read `C:\SSI\MCI370\`.

**Numbers look wrong in the app** — check the per-m³ column on the Consumption tab first. For
ordinary concrete the total should land near 2,300 to 2,450 kg/m³, with cement in the low
hundreds. If it is out by roughly a factor of the mixes per load, say so — that is a specific
and fixable mistake, and worth reporting rather than working around.

**Nothing arriving at all** — run `npm run once` by hand and read what it prints. That output
is far more useful than anything the app can show you.
