# Attendance machine agent (eSSL K30)

Reads punches **straight from the attendance machine over the plant network** and sends them to
the OORM app. It does not need eTimeTrackLite, the eSSL SDK, or any driver — only Node.js.

It is **read-only by construction**. The program contains no command that can change the
machine: it cannot clear punches, add or delete users, change the clock or restart it. Every
punch stays on the machine whatever this agent does, so it can be stopped, reinstalled or run
twice without losing anything.

Our machine: **192.168.1.201**, port **4370**, comm key **0** (from eTimeTrackLite's settings).

---

## Before you start

1. **A Windows PC on the same network as the machine, switched on all day.** The plant PC that
   runs the MCI370 or weighbridge agent is fine. From that PC, open Command Prompt and type
   `ping 192.168.1.201` — you should get replies.
2. **Node.js** on that PC (LTS from nodejs.org, default options). Check with `node -v`.
3. **eTimeTrackLite — one setting to check.** The machine talks to one program at a time, and
   eTimeTrackLite can be set to *clear* the machine after it downloads. If it clears, punches
   that this agent has not read yet would be gone. In eTimeTrackLite open the device download
   settings and make sure **"Clear logs after download" is NOT ticked**. You can keep using
   eTimeTrackLite side by side for the first month to compare — if both try to connect at the
   same moment, one simply tries again a few minutes later.

Copy this whole folder to the PC, e.g. `C:\oorm-attendance`. Check that `agent.js` is directly
inside it (`dir C:\oorm-attendance\agent.js`), not in a nested folder.

---

## Step 1 — probe first

Reads the machine, prints what it found, **sends nothing anywhere**:

```
cd C:\oorm-attendance
npm run probe -- 192.168.1.201
```

You should see the serial number, model, the machine's clock, the number of users and
punches, and the five latest punches. **Compare the latest punches with eTimeTrackLite** — same
people, same times.

If it says *could not reach the machine*: check the address and the ping above. If it says
*refused the comm key*: the machine has a comm key set — put it in `commKey` in Step 3.

---

## Step 2 — set the shared key on the app

On Render, open the backend service → **Environment** → add:

```
ATTENDANCE_API_KEY = <a long password you make up>
```

Make up a real one (e.g. `Ourownrm-Attend-7Kq2Vx9P`) — do not copy the example. Save and let
Render redeploy. Then open `/setup?key=…` once as usual so the new tables are created; its log
should say *Round 195 — attendance machine … ATTENDANCE_API_KEY is set*.

---

## Step 3 — configure

```
copy config.example.json config.json
notepad config.json
```

| Setting | What to put |
|---|---|
| `deviceIp` | `192.168.1.201` |
| `devicePort` | `4370` (leave) |
| `commKey` | `0` unless the probe said otherwise |
| `deviceLabel` | What the app should call it, e.g. `Main gate` |
| `appUrl` | Your backend address, e.g. `https://oorm-backend.onrender.com` |
| `apiKey` | **Exactly** the `ATTENDANCE_API_KEY` from Step 2 |
| `startDate` | How far back to send the first time, e.g. `2026-09-01` |

`config.json` holds the key and stays on this PC — never zip it or send it back.

There is nothing to `npm install` — the agent uses only what comes with Node.

---

## Step 4 — try it once

```
npm run once
```

It prints how many punches the machine holds and how many it sent. Run it again: this time it
should say *+0 new*, which proves it never double-counts.

In the app, open **Administrator → Attendance Machine**. The badge should say **Live**, the
Day tab should show today's punches, and Machine users should list everyone enrolled.

---

## Step 5 — leave it running (scheduled task)

Same set-up as the weighbridge PC:

- **General:** name `OORM attendance sync`. *Change User or Group…* → `SYSTEM`. Tick
  *Run with highest privileges*.
- **Triggers:** *At startup*, delay `2 minutes`, repeat every `5 minutes`, *Indefinitely*.
- **Actions:** Program — **Browse…** to `node.exe` (usually `C:\Program Files\nodejs\`; do not
  type it). Arguments: `agent.js --once`. Start in: this folder.
- **Settings:** untick *Stop the task if it runs longer than 3 days*; tick *Run task as soon as
  possible after a scheduled start is missed*.

Right-click → **Run** to test: *Last Run Result* `0x0`.

Nothing is lost while the agent or the PC is off — the punches wait on the machine and arrive
on the next run. Each run re-sends the last 3 days, and the app ignores what it already has.

---

## What it sends

Per punch: the machine user ID, date and time, which key was pressed (in/out), and how the
person was verified (finger, face, card). Once per run: the machine's serial number, model,
firmware, clock, user and punch counts, and its user list (ID and the name typed on the
machine). It never sends passwords, card numbers or fingerprints.

## The log file

Each run writes to `agent.log` in this folder (rotates past 1 MB). When the app's badge says
*Stale* or *Can't read machine*, that file says why.

## If it stops working

- **"Could not reach the machine"** — the machine is off, unplugged from the network, or its
  address changed. Check the address on the machine (Menu → Comm. → Ethernet).
- **"Not authorised"** — `apiKey` does not match `ATTENDANCE_API_KEY` on Render.
- **"The machine stopped answering"** — usually eTimeTrackLite was connected at the same
  moment. It recovers by itself on the next run.
- **Machine clock warning** — the app shows when the machine's clock is 5+ minutes out. Fix it
  on the machine (or from eTimeTrackLite → Sync Time). The agent never changes the clock.
- **Machine nearly full** — the app shows how full it is. The K30 holds about 1,00,000 punches;
  at today's rate that is years. When it does fill up, clear it from eTimeTrackLite **after**
  checking the app has everything.
