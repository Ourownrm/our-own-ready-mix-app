# Round 195 — v10.25: eSSL attendance machine read directly over the LAN

**Deploy:** upload the zip's files → set **`ATTENDANCE_API_KEY`** on Render (backend → Environment) → Render
redeploys → **visit `/setup?key=…` once** (Round 195 migration: four new tables) → install the agent on a plant
PC (`tools/essl-agent/README.md`).

## Why
The owner wants the punching machine (eSSL K30, 192.168.1.201, comm key 0) read directly, not through
eTimeTrackLite. Findings from the eTimeTrackLite database are in `claude/essl-attendance-integration.md`.

## Agent — `tools/essl-agent` (new, Node ≥ 18, no npm dependencies)
- `zk.js` — read-only ZK protocol client over TCP 4370 (connect, comm-key auth, serial/model/firmware/clock,
  free sizes, user list 28/72-byte, attendance log 8/16/40-byte, chunked "read with buffer" incl.
  PREPARE_DATA/DATA/ACK). No write/clear command exists in the file. Wire format follows pyzk.
- `agent.js` — every run: read machine → send punches from max(startDate, last sent − 3 days) in batches of
  500 to `POST /api/attendance/sync` (`x-attendance-key`). Times sent as `YYYY-MM-DDTHH:MM:SS+05:30`.
  Machine unreachable → posts `device_error` so the screen shows it. Cursor (`state.json`) only advances after
  every batch lands. Logs to `agent.log`. Clock drift ≥ 5 min logged. Retries a Render cold start (~65 s).
- `probe.js` — reads and prints, sends nothing. Scheduled task every 5 min (same set-up as weighbridge).
- Caution in README: eTimeTrackLite must not "clear logs after download".

## App
- `lib/attendanceSchema.js` + end of `schema.sql`: `attendance_devices` (by serial; `ip:<addr>` fallback),
  `attendance_device_users` (machine's user list), `attendance_punches` (unique device + machine user + time,
  never edited), `attendance_sync_log`. Called from `/setup` after the Round 194 migration.
- `routes/attendance.js`, mounted at `/api/attendance`: `POST /sync` (API key, above requireAuth; upsert,
  ON CONFLICT DO NOTHING; report without serial is filed against the machine already known at that IP);
  `GET /status`, `GET /day?date=`, `GET /machine-users` behind permission `admin.attendance-machine`
  (Administration group, Administrator by default).
- Attendance day = IST time − 4 h (night shift stays on its start day), as agreed in the HR mockup.
- Screen `/attendance-machine` (`pages/AttendanceMachine.jsx`), tile **Attendance Machine** on the
  Administrator dashboard: Live/Stale/Can't-read badge, last read, today's count, machine fill %, clock drift;
  tabs Day (first/last punch, "only one" flag, click a row for all punches), Machine users, Sync log.
- Deliberately NOT in this round: linking machine IDs to employees, Present/Half day/Absent rules, manual
  requests — those are the HR module (mockup v1 locked 6 Oct).

## Verified
- Simulated machine built from real Sep–Oct punches (2,530): pyzk reference library reads it correctly
  (40- and 16-byte records, comm key) — confirms the simulator follows the real protocol; our client reads all
  2,530 with 0 missing / 0 extra in 40/16/8-byte formats, chunked and inline transfers, fragmented TCP,
  multi-frame DATA, comm key 123456; wrong comm key and unreachable address give plain messages.
- End to end on local Postgres: fresh `/setup` ×2; agent `--once` → +2,530; second run +0 new / 209 already;
  wrong apiKey → "Not authorised"; machine down → error shown, filed on the same machine, clears on next good
  read; Day view for 5 Oct = 33 people / 4 single-punch, matching the eTimeTrackLite data.
- `npm run check` pass; `vite build` clean; screenshots desktop + 390 px.
- NOT yet tested against the real machine — first step on site is `npm run probe -- 192.168.1.201`.
