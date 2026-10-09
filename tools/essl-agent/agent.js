#!/usr/bin/env node
// Round 195 — the attendance machine agent.
//
// Runs on any Windows PC on the plant network (the one that already runs the
// MCI370 or weighbridge agent is fine). Every few minutes it connects straight
// to the eSSL machine over the LAN, reads its punches and its user list, posts
// the new punches to the app, and disconnects. It does not need eTimeTrackLite
// and does not touch it.
//
// READ-ONLY, BY CONSTRUCTION. zk.js contains no command that changes the
// machine — no clear-log, no user edit, no clock set. The machine keeps every
// punch whatever this agent does, so the agent can be stopped, reinstalled or
// run twice without losing anything.
//
// NO QUEUE ON DISK. Same decision as the weighbridge agent: the machine's own
// log IS the queue. On a failed post the cursor does not move and the same
// punches are sent again next cycle; the app ignores ones it already has.
//
// TIMES. The machine's clock is plant-local wall-clock time with no timezone.
// Every punch is sent as "YYYY-MM-DDTHH:MM:SS+05:30" — fixed IST, never this
// PC's own timezone setting.
//
// The app side is backend/src/routes/attendance.js.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ZkClient } from "./zk.js";

const AGENT_VERSION = "1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.ESSL_CONFIG || path.join(__dirname, "config.json");
const STATE_PATH = process.env.ESSL_STATE || path.join(__dirname, "state.json");
const LOG_PATH = process.env.ESSL_LOG || path.join(__dirname, "agent.log");
const LOG_MAX_BYTES = 1024 * 1024;

function writeLogLine(line) {
  try {
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.renameSync(LOG_PATH, LOG_PATH + ".1");
    } catch { /* best effort */ }
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch { /* a read-only folder must not stop the sync */ }
}
function log(...a) {
  const line = [new Date().toISOString(), ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))].join(" ");
  console.log(line);
  writeLogLine(line);
}
function logError(...a) {
  const line = [new Date().toISOString(), "ERROR", ...a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === "string" ? x : JSON.stringify(x)))].join(" ");
  console.error(line);
  writeLogLine(line);
}
process.on("uncaughtException", (e) => { logError("uncaught", e); process.exit(1); });
process.on("unhandledRejection", (e) => { logError("unhandled rejection", e); process.exit(1); });

export function loadConfig(p = CONFIG_PATH) {
  if (!fs.existsSync(p)) {
    console.error(`No config file at ${p}. Copy config.example.json to config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    devicePort: 4370,
    commKey: 0,
    deviceLabel: "Main gate",
    startDate: "2026-09-01",
    trailingDays: 3,
    batchSize: 500,
    pollSeconds: 300,
    timeoutSeconds: 20,
    ...cfg,
  };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(s) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

// Everything one visit to the machine learns. Always disconnects, even on a
// failure half-way, so the machine is never left holding a session.
export async function readMachine(cfg) {
  const zk = new ZkClient({ ip: cfg.deviceIp, port: cfg.devicePort, commKey: cfg.commKey, timeoutMs: cfg.timeoutSeconds * 1000 });
  try {
    await zk.connect();
    const serial = await zk.option("~SerialNumber");
    const model = await zk.option("~DeviceName");
    const firmware = await zk.firmware();
    const deviceTime = await zk.time();
    const sizes = await zk.sizes();
    const users = sizes && sizes.users > 0 ? await zk.users(sizes.users) : await zk.users(0);
    const punches = sizes && sizes.records === 0 ? [] : await zk.attendance(sizes?.records || 0, users);
    return { serial, model, firmware, deviceTime, sizes, users, punches, warning: zk.lastWarning || null };
  } finally {
    await zk.disconnect();
  }
}

const IST = "+05:30";
const toIso = (local) => local.replace(" ", "T") + IST;

async function post(cfg, body) {
  const url = new URL("/api/attendance/sync", cfg.appUrl).toString();
  // Ride through a Render cold start: up to ~65s of retries inside one cycle.
  const waits = [0, 5000, 15000, 45000];
  let last;
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-attendance-key": cfg.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (res.status === 401) throw Object.assign(new Error("The app said Not authorised — apiKey in config.json does not match ATTENDANCE_API_KEY on the server."), { fatal: true });
      if (!res.ok) throw new Error(`app replied ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } catch (err) {
      last = err;
      if (err.fatal) throw err;
    }
  }
  throw last;
}

function deviceBlock(cfg, m) {
  return {
    ip: cfg.deviceIp,
    label: cfg.deviceLabel,
    serial: m?.serial || null,
    model: m?.model || null,
    firmware: m?.firmware || null,
    device_time: m?.deviceTime || null,
    pc_time: new Date().toISOString(),
    user_count: m?.sizes?.users ?? null,
    record_count: m?.sizes?.records ?? null,
    record_capacity: m?.sizes?.recordCapacity ?? null,
  };
}

export async function cycle(cfg, state) {
  let m;
  try {
    m = await readMachine(cfg);
  } catch (err) {
    // Tell the app the machine could not be read, so the screen shows it
    // rather than just going quiet. If even that fails, the log has it.
    log(`could not read the machine: ${err.message}`);
    await post(cfg, { agent_version: AGENT_VERSION, device: deviceBlock(cfg, null), device_error: err.message, punches: [] })
      .catch((e) => log(`  (and could not tell the app either: ${e.message})`));
    return;
  }
  if (m.warning) log(`note: ${m.warning}`);

  // Clock check — the machine's time decides whose punch is late. Warn, never fix.
  if (m.deviceTime) {
    const drift = Math.round((Date.parse(toIso(m.deviceTime)) - Date.now()) / 60000);
    if (Math.abs(drift) >= 5) log(`WARNING: the machine's clock is ${Math.abs(drift)} min ${drift > 0 ? "ahead" : "behind"}. Correct it on the machine.`);
  }

  // From the later of the configured start date and (last punch sent - trailing
  // days). The trailing window re-sends a few days each time so a punch the
  // machine stored late (it was offline, its clock was wrong) still arrives.
  let from = cfg.startDate + " 00:00:00";
  if (state.lastPunchAt) {
    const back = new Date(Date.parse(toIso(state.lastPunchAt)) - cfg.trailingDays * 86400_000);
    const s = back.toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });
    if (s > from) from = s;
  }
  const punches = m.punches
    .filter((p) => p.at >= from)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((p) => ({ user_id: p.userId, punched_at: toIso(p.at), state: p.state, verify: p.verify, work_code: p.workCode }));

  const users = m.users.map((u) => ({ user_id: u.userId, name: u.name || null, privilege: u.privilege }));
  const device = deviceBlock(cfg, m);

  log(`machine ${device.serial || "?"} holds ${m.punches.length} punch(es) and ${m.users.length} user(s); ${punches.length} to send (from ${from}).`);

  if (!punches.length) {
    const r = await post(cfg, { agent_version: AGENT_VERSION, device, users, punches: [] });
    log(`nothing new. app's latest punch: ${r.latest_punch_at || "—"}.`);
    return;
  }

  let inserted = 0, already = 0;
  for (let i = 0; i < punches.length; i += cfg.batchSize) {
    const chunk = punches.slice(i, i + cfg.batchSize);
    // Users ride along with the first batch only.
    const r = await post(cfg, { agent_version: AGENT_VERSION, device, users: i === 0 ? users : [], punches: chunk });
    inserted += r.inserted || 0;
    already += r.already || 0;
  }
  log(`sent: +${inserted} new, ${already} already in the app.`);
  // Only after every batch landed.
  const lastAt = punches[punches.length - 1].punched_at.slice(0, 19).replace("T", " ");
  state.lastPunchAt = lastAt;
  state.lastOkAt = new Date().toISOString();
  saveState(state);
}

async function main() {
  const cfg = loadConfig();
  for (const k of ["deviceIp", "appUrl", "apiKey"]) {
    if (!cfg[k]) { console.error(`config.json is missing "${k}".`); process.exit(1); }
  }
  const state = loadState();
  log(`attendance agent ${AGENT_VERSION}: machine ${cfg.deviceIp}:${cfg.devicePort} -> ${new URL("/api/attendance/sync", cfg.appUrl)}`);
  log(`  punches from ${cfg.startDate}; resuming after ${state.lastPunchAt || "nothing yet"}`);

  if (process.argv.includes("--once")) {
    try { await cycle(cfg, state); } catch (e) { logError("cycle failed", e); process.exitCode = 1; }
    return;
  }
  for (;;) {
    try { await cycle(cfg, state); } catch (e) { log(`cycle failed (will retry): ${e.message}`); }
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { logError(e); process.exit(1); });
}
