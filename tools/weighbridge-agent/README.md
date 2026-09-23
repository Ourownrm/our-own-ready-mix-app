# Weighbridge sync agent

Runs on the weighbridge PC. Reads finished tickets out of the SchwingSmartWeigh
MySQL database and posts them to the OORM app. It is **one-way and read-only** —
nothing it does can change a weighbridge ticket.

## Before you start

Two things have to be true, and neither is this agent's job:

1. **The weighbridge PC stays on and has internet.** It does — confirmed with
   the plant, Sep 2026.
2. **The MySQL root password gets changed.** Right now it is literally `root`,
   stored in plain text in `SchwingSmartWeighV2.0.1\driver.xml`, and the
   SmartWeigh login is `admin` / `essae`. Anyone who reaches that PC can rewrite
   every weighbridge ticket. That is worth fixing on its own merits; this agent
   just makes it more obvious. **This agent does not use root** — give it the
   read-only account below.

## Step 1 — make a read-only MySQL account

On the weighbridge PC, open a command prompt and run (one line):

    "C:\Program Files\MySQL\MySQL Server 5.6\bin\mysql.exe" -u root -p

Then, at the `mysql>` prompt, with a password of your own choosing:

    CREATE USER 'oorm_sync'@'localhost' IDENTIFIED BY 'choose-a-long-password';
    GRANT SELECT ON weighsoftdb.* TO 'oorm_sync'@'localhost';
    FLUSH PRIVILEGES;
    EXIT;

`SELECT` and nothing else. If this account is ever compromised, the worst that
can happen is somebody reads weighbridge tickets — they cannot alter or delete
one, and they cannot reach any other database on that server.

## Step 2 — set the shared key

Pick a long random string. Put it in **two** places, identical:

* In the app's backend environment (Render → the backend service → Environment)
  as `WEIGHBRIDGE_API_KEY`.
* In this agent's `config.json` as `apiKey`.

Until `WEIGHBRIDGE_API_KEY` is set, the app rejects every sync call. That is
deliberate — an unset key closes the endpoint rather than opening it.

## Step 3 — install and configure

Install Node 18 or newer on the weighbridge PC, then in this folder:

    npm install
    copy config.example.json config.json

Edit `config.json`: the MySQL password from step 1, the `appUrl` of the backend,
and the `apiKey` from step 2. Leave `startDate` at `2026-09-01` unless the older
backlog is wanted — the weighbridge holds 2,478 tickets going back to December
2023 and the plant decided only this month is needed.

## Step 4 — try it once

    npm run once

It prints what it found and what the app did with it. Expect something like:

    weighbridge agent 1.0 starting.
      reading  weighsoftdb.transaction on localhost as oorm_sync
      sending  https://.../api/weighbridge/sync
      tickets from 2026-09-01 onwards, re-checking the last 30 days, every 60s
      resuming from ticket 0
    97 ticket(s) to send (2382 … 2478).
      batch 1: +97 new, 0 changed, 0 unchanged

Then open the Weighbridge screen in the app. Most tickets will be sitting in
**Needs review** on the first run, because no names have been mapped yet. That
is expected and is the next step, not a fault — go to the mapping screen and map
each spelling once.

## Step 5 — leave it running

The simplest reliable option on Windows is Task Scheduler:

* Create a task, **Run whether user is logged on or not**.
* Trigger: **At startup**, and tick **Repeat every 5 minutes** as a safety net
  in case it ever exits.
* Action: start `node` with argument `agent.js`, "Start in" set to this folder.

The agent polls every 60 seconds on its own, so the 5-minute repeat only matters
if the process dies.

## What it actually sends

Only rows where `State = 'Second Transaction'` — a lorry that has been weighed
both times. A ticket still open on the weighbridge is skipped and picked up
automatically once it completes.

It does **not** send `moisturepercentage`, `actualweight` or `ConcreteVolume`.
Those three are free-text columns the operators type into — three years of data
contains `N/A`, `NONE`, `0.0`, `35610+91` and driver names in them. `NetWeight`
is the only weight figure imported, and moisture deduction happens in the app
against a real number.

## If it stops working

The app's Weighbridge screen shows when the agent last checked in, so a stopped
agent is visible there rather than being discovered a week later.

* **"app replied 401"** — `apiKey` and `WEIGHBRIDGE_API_KEY` do not match, or
  the backend's is unset.
* **"ER_ACCESS_DENIED_ERROR"** — the MySQL user or password in `config.json` is
  wrong, or the GRANT in step 1 did not run.
* **"Could not find a TicketNumber column"** — SmartWeigh was upgraded and
  renamed something. The agent prints the columns it did find; add the new name
  to `WANTED` in `agent.js`.
* **Nothing at all in the app** — check `startDate` is not in the future.

The agent never exits on an error; it logs it and retries next cycle. Losing the
network for a week loses nothing, because the weighbridge's own database is the
queue — the agent simply re-reads it when the network is back.
