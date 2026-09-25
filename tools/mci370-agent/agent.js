#!/usr/bin/env node
// Round 157 — the MCI370 batching plant agent.
//
// Runs on the plant control PC. Reads what the plant produced and what it
// consumed out of MCI370's own Access database, and posts it to the OORM app.
// One-way and read-only: nothing it does can change a batch record.
//
// FIVE DESIGN DECISIONS, each of which took a wrong turn first:
//
// 1. NO DATABASE DRIVER IS INSTALLED. The obvious route is Microsoft's Access
//    Database Engine redistributable plus an ODBC package. We do not: this is a
//    machine that is batching concrete, running a VB6 program from 2004, and
//    installing a database engine onto it is a real risk with no upside. The
//    `Microsoft.Jet.OLEDB.4.0` provider that reads a .mdb already ships with
//    Windows — it is just 32-bit only. So the agent shells out to the 32-bit
//    PowerShell that is on every Windows machine (see readMdb.ps1) and reads
//    JSON back. Nothing to install beyond Node.
//
// 2. THE DATABASE IS COPIED BEFORE IT IS READ. Jet takes a lock file, and
//    MCI370 holds the real database open while batching. Copying first (5.7 MB,
//    instant) means the agent cannot contend with the control software under
//    any circumstances. A copy taken mid-write may fail to parse; that costs
//    one cycle and is retried, which is the right trade against interfering
//    with a live plant. Set copyFirst:false only with a reason.
//
// 3. A LOAD IS SEVERAL MIXES. Batch_Transaction has a Batch_Index and one row
//    per MIX; Batch_Dat_Trans has one row per LOAD. A 6 m³ truck filled by a
//    1 m³ mixer is six rows against one Batch_No. The agent sends every mix and
//    lets the app roll them up — summing here would throw away the per-mix
//    weights, which are the entire point of the consumption feed.
//
// 4. THE PLANT NAMES ITS OWN SILOS. MCI370's NameSetUp table says what each
//    hopper holds — Gate1Name, Cem1Name, Wtr1Name and so on. The agent reads it
//    every cycle and sends the name alongside each weight, so renaming a hopper
//    on the panel shows up rather than silently re-pointing history. Mapping
//    those names to our materials is a human decision made in the app.
//
// 5. NO OFFLINE QUEUE, deliberately — same as the weighbridge agent. MCI370's
//    database IS the queue: every batch is still there and can be re-read. A
//    disk spool would be a second copy of the truth that can drift. On a failed
//    post the cursor simply does not advance.
//
// The app side is backend/src/routes/plant.js. The Access schema this is
// written against is recorded in claude/mci370-integration-notes.md and was
// read out of the real .mdb, not inferred.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const AGENT_VERSION = "1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.MCI_CONFIG || path.join(__dirname, "config.json");
const STATE_PATH = process.env.MCI_STATE || path.join(__dirname, "state.json");
const PS32 = "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe";

// ROUND 158 — a log file, for the same reason the weighbridge agent has one.
//
// On the plant control PC this runs as a scheduled task under SYSTEM: no
// window, no console, nobody watching. Without a file on disk, a failure is
// invisible until somebody notices the app has gone stale, and then there is
// nothing to look at. Append, rotate at a megabyte, never let logging itself
// throw.
const LOG_PATH = process.env.MCI_LOG || path.join(__dirname, "agent.log");
const LOG_MAX_BYTES = 1024 * 1024;

function writeLogLine(line) {
  try {
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
        fs.renameSync(LOG_PATH, LOG_PATH + ".1");
      }
    } catch { /* rotation is best-effort */ }
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch { /* never let logging stop the sync */ }
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

process.on("uncaughtException", (err) => { logError("uncaught", err); process.exit(1); });
process.on("unhandledRejection", (err) => { logError("unhandled rejection", err); process.exit(1); });

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`No config file at ${CONFIG_PATH}. Copy config.example.json to config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  for (const need of ["mdbPath", "appUrl", "apiKey"]) {
    if (!cfg[need]) { console.error(`config.json is missing "${need}".`); process.exit(1); }
  }
  return {
    pollSeconds: 60,
    // Only from here forward. MCI370 databases carry years of history and the
    // app does not need it; widen this and restart if it is ever wanted.
    startDate: "2026-09-01",
    // How far back to re-read each cycle. MCI370 has no updated_at, so this is
    // the only way a corrected batch reaches the app. The server compares a
    // hash and does nothing for unchanged mixes, so a wide window is cheap.
    trailingDays: 7,
    batchSize: 200,
    copyFirst: true,
    plantNo: "1",
    ...cfg,
  };
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { highestBatch: 0, batchYear: 0 }; } };
const saveState = (s) => { const t = STATE_PATH + ".tmp"; fs.writeFileSync(t, JSON.stringify(s, null, 2)); fs.renameSync(t, STATE_PATH); };

// ---------------------------------------------------------------------------
// Reading the Access file
// ---------------------------------------------------------------------------

async function queryMdb(mdbPath, sql) {
  if (!fs.existsSync(PS32)) {
    throw new Error(
      `32-bit PowerShell not found at ${PS32}. It ships with every 64-bit Windows; ` +
      `on a 32-bit machine use C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe instead.`
    );
  }
  const script = path.join(__dirname, "readMdb.ps1");
  const { stdout } = await execFileAsync(
    PS32,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-MdbPath", mdbPath, "-Sql", sql],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new Error(`Could not read the reply from PowerShell: ${stdout.slice(0, 300)}`);
  }
  if (parsed.error) throw new Error(parsed.error);
  // ConvertTo-Json emits a bare object rather than a one-element array when a
  // query returns exactly one row — a classic PowerShell trap that would make
  // a single-batch day look like no batches at all.
  const rows = parsed.rows;
  if (!rows) return [];
  return Array.isArray(rows) ? rows : [rows];
}

/**
 * Work from a copy so the live database is never opened by us. See note 2.
 * Returns the path to read and a cleanup function.
 */
function stageDatabase(cfg) {
  if (!cfg.copyFirst) return { readPath: cfg.mdbPath, cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mci370-"));
  const dest = path.join(dir, "snapshot.mdb");
  fs.copyFileSync(cfg.mdbPath, dest);
  return {
    readPath: dest,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// ---------------------------------------------------------------------------
// Shaping a mix
// ---------------------------------------------------------------------------

// MCI370's NameSetUp column for each of our slot keys. Kept in step with
// backend/src/lib/plantSlots.js — that file is the authority; this is the
// agent's copy of the name mapping only.
const SLOT_FIELDS = [
  ["gate1",   "Gate1Name",   "Gate1_Actual",   "Gate1_Target",   "Gate1_Moisture", null, "Gate1_Rec"],
  ["gate2",   "Gate2Name",   "Gate2_Actual",   "Gate2_Target",   "Gate2_Moisture", null, "Gate2_Rec"],
  ["gate3",   "Gate3Name",   "Gate3_Actual",   "Gate3_Target",   "Gate3_Moisture", null, "Gate3_Rec"],
  ["gate4",   "Gate4Name",   "Gate4_Actual",   "Gate4_Target",   "Gate4_Moisture", null, "Gate4_Rec"],
  ["gate5",   "Gate5Name",   "Gate5_Actual",   "Gate5_Target",   "Gate5_Moisture", null, "Gate5_Rec"],
  ["gate6",   "Gate6Name",   "Gate6_Actual",   "Gate6_Target",   "Gate6_Moisture", null, "Gate6_Rec"],
  ["cement1", "Cem1Name",    "Cement1_Actual", "Cement1_Target", null, "Cement1_Correction", "Cem1_Rec"],
  ["cement2", "Cem2Name",    "Cement2_Actual", "Cement2_Target", null, "Cement2_Correction", "Cem2_Rec"],
  ["cement3", "Cem3Name",    "Cement3_Actual", "Cement3_Target", null, "Cement3_Correction", "Cem3_Rec"],
  ["cement4", "Cem4Name",    "Cement4_Actual", "Cement4_Target", null, "Cement4_Correction", "Cem4_rec"],
  ["filler1", "FillName",    "Filler1_Actual", "Filler1_Target", null, "Filler1_Correction", null],
  ["silica",  "SilicaName",  "Silica_Actual",  "Silica_Target",  null, "Silica_Correction", "Sil_Rec"],
  ["slurry",  "SlurryName",  "Slurry_Actual",  "Slurry_Target",  null, "Slurry_Correction", null],
  ["water1",  "Wtr1Name",    "Water1_Actual",  "Water1_Target",  null, "Water1_Correction", "Wtr1_Rec"],
  ["water2",  "wtr2Name",    "Water2_Actual",  "Water2_Target",  null, "Water2_Correction", "Wtr2_Rec"],
  ["adm1a",   "Admix1Name",  "Adm1_Actual1",   "Adm1_Target1",   null, "Adm1_Correction1", "Adm1_Rec"],
  ["adm1b",   "Admix12Name", "Adm1_Actual2",   "Adm1_Target2",   null, "Adm1_Correction2", null],
  ["adm2a",   "Admix2Name",  "Adm2_Actual1",   "Adm2_Target1",   null, "Adm2_Correction1", "Adm2_Rec"],
  ["adm2b",   "Admix22Name", "Adm2_Actual2",   "Adm2_Target2",   null, "Adm2_Correction2", null],
  ["pigment", "PigName",     "Pigment_Actual", "Pigment_Target", null, null, null],
];

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/**
 * MCI370 keeps Batch_Date and Batch_Time as two separate Access DateTime
 * values — the date carries a meaningless midnight time, the time carries a
 * meaningless 1899 date. Take the day from one and the clock from the other.
 * readMdb.ps1 has already stamped both +05:30.
 */
function combineDateTime(dateVal, timeVal) {
  const d = str(dateVal);
  if (!d) return null;
  const day = d.slice(0, 10);
  const t = str(timeVal);
  const clock = t && t.length >= 19 ? t.slice(11, 19) : "00:00:00";
  return `${day}T${clock}+05:30`;
}

/**
 * ROUND 159 — the load's real start and finish.
 *
 * Batch_Start_Time and Batch_End_Time are plain text on the header, in the
 * shape "11:57:16 AM" — no 1899 date, no ambiguity. Combined with the day from
 * Batch_Date they give the only trustworthy clock in this database, and the
 * cycle time that falls out of them is a figure the plant has been recording
 * for years without anybody looking at it.
 *
 * Returns null rather than guessing if the text is not in the shape expected:
 * a wrong timestamp is worse than a missing one.
 */
function clockOn(dateVal, clockText) {
  const d = str(dateVal);
  const t = str(clockText);
  if (!d || !t) return null;
  const m = /^(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/.exec(t)
         || /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  let hh = Number(m[1]);
  const half = m[4] ? m[4].toUpperCase() : null;
  if (half === "P" && hh < 12) hh += 12;
  if (half === "A" && hh === 12) hh = 0;
  if (hh > 23) return null;
  return `${d.slice(0, 10)}T${String(hh).padStart(2, "0")}:${m[2]}:${m[3]}+05:30`;
}

function toMix(tr, dat, names, plantNo) {
  const materials = {};
  for (const [key, nameField, actualF, targetF, moistF, corrF, recF] of SLOT_FIELDS) {
    const actual = num(tr[actualF]);
    if (actual === null || actual === 0) continue;   // hopper did not fire on this mix
    materials[key] = {
      slot_name: str(names ? names[nameField] : null),
      actual_kg: actual,
      target_kg: num(tr[targetF]),
      moisture_pct: moistF ? num(tr[moistF]) : null,
      correction: corrF ? num(tr[corrF]) : null,
      // ROUND 159 — the recipe's own figure, per m3, from the LOAD header.
      // This is the "theoretical" quantity: design -> moisture-adjusted target
      // -> what was actually weighed, three numbers answering three questions.
      design_kg_per_m3: recF && dat ? num(dat[recF]) : null,
    };
  }

  return {
    plant_no: str(tr.Plant_No) || str(dat?.Plant_No) || plantNo,
    batch_year: num(tr.Batch_Year) ?? num(dat?.Batch_Year),
    batch_no: num(tr.Batch_No),
    batch_index: num(tr.Batch_Index) ?? 1,
    batched_at: combineDateTime(tr.Batch_Date, tr.Batch_Time),
    // The load-level context lives on Batch_Dat_Trans, which is why the two
    // tables are read together rather than the mix table alone.
    recipe_code:   str(dat?.Recipe_Code),
    recipe_name:   str(dat?.Recipe_Name),
    strength:      num(dat?.strength),
    consistency:   num(tr.Consistancy),
    customer_code: str(dat?.Customer_Code),
    site_name:     str(dat?.Site),
    truck_no:      str(dat?.Truck_No),
    truck_driver:  str(dat?.Truck_Driver),
    order_no:      str(dat?.Order_No),
    batcher_name:  str(dat?.Batcher_Name),
    // ROUND 159 — THE correction. Production_Qty on a batch row is a RUNNING
    // TOTAL of the load so far (1, 2, 3 … 8), not this batch's quantity.
    // Verified on 2,496 of 2,496 real loads. Round 157 sent it as the batch
    // quantity and the app summed it, reporting 73,987 m³ against a true
    // 16,010. The per-batch figure is Batch_Size; the load's own total is
    // Production_Qty on the HEADER, which reconciles exactly with the sum of
    // its batches across all 2,495 loads.
    batch_qty_m3:      num(tr.Batch_Size) ?? num(dat?.Batch_Size),
    load_qty_m3:       num(dat?.Production_Qty),
    cumulative_qty_m3: num(tr.Production_Qty),
    ordered_qty_m3:    num(tr.Ordered_Qty) ?? num(dat?.Ordered_Qty),
    returned_qty_m3:   num(tr.Returned_Qty) ?? num(dat?.Returned_Qty),
    with_this_load_m3: num(tr.WithThisLoad) ?? num(dat?.WithThisLoad),
    // ROUND 159 — the real clock. Batch_Time is stamped 12/30/99 on every
    // single row, so these two text fields are the only honest start and
    // finish, and nobody has ever used them.
    load_started_at: clockOn(dat?.Batch_Date, dat?.Batch_Start_Time),
    load_ended_at:   clockOn(dat?.Batch_Date, dat?.Batch_End_Time),
    mixer_capacity_m3: num(dat?.Mixer_Capacity),
    mixing_time_s:     num(dat?.Mixing_Time),
    weighed_net_weight_kg: num(dat?.Weighed_Net_Weight),
    weighbridge_stat:      str(dat?.Weigh_Bridge_Stat),
    materials,
  };
}

// ---------------------------------------------------------------------------

async function post(cfg, mixes) {
  const res = await fetch(new URL("/api/plant/sync", cfg.appUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-plant-key": cfg.apiKey },
    body: JSON.stringify({ agent_version: AGENT_VERSION, batches: mixes }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`app replied ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Access wants #mm/dd/yyyy# literals in a WHERE clause, and is unforgiving
// about it — a plain 'yyyy-mm-dd' string silently matches nothing rather than
// erroring, which would look exactly like a quiet plant.
function accessDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `#${m}/${d}/${y}#`;
}

async function cycle(cfg, state) {
  const staged = stageDatabase(cfg);
  try {
    const floor = cfg.startDate;
    const windowStart = new Date(Date.now() - cfg.trailingDays * 86400_000).toISOString().slice(0, 10);
    const from = windowStart > floor ? windowStart : floor;

    // Everything in the trailing window, plus anything newer than the
    // high-water mark in case the plant has been quiet longer than the window.
    const sql =
      `SELECT * FROM Batch_Transaction ` +
      `WHERE Batch_Date >= ${accessDate(from)} ` +
      `   OR (Batch_Year >= ${state.batchYear || 0} AND Batch_No > ${state.highestBatch || 0}) ` +
      `ORDER BY Batch_Year, Batch_No, Batch_Index`;

    const [mixRows, names] = await Promise.all([
      queryMdb(staged.readPath, sql),
      queryMdb(staged.readPath, "SELECT TOP 1 * FROM NameSetUp").then((r) => r[0] || null),
    ]);

    if (!names) log("note: NameSetUp is empty — silo names will be blank until the plant names its hoppers in MCI370.");

    if (!mixRows.length) {
      const r = await post(cfg, []);
      log(`nothing to send. app holds up to batch ${r.highest_batch ?? "—"} of ${r.batch_year ?? "—"}.`);
      return;
    }

    // The load-level context, fetched for just the batch numbers in hand.
    const nos = [...new Set(mixRows.map((r) => num(r.Batch_No)).filter((n) => n !== null))];
    const datRows = nos.length
      ? await queryMdb(
          staged.readPath,
          `SELECT * FROM Batch_Dat_Trans WHERE Batch_No IN (${nos.join(",")})`
        )
      : [];
    const datByKey = new Map();
    for (const d of datRows) datByKey.set(`${num(d.Batch_Year)}|${num(d.Batch_No)}`, d);

    const mixes = mixRows
      .map((tr) => toMix(tr, datByKey.get(`${num(tr.Batch_Year)}|${num(tr.Batch_No)}`), names, cfg.plantNo))
      .filter((m) => Number.isInteger(m.batch_no) && Number.isInteger(m.batch_year));

    log(`${mixes.length} mix(es) to send (batch ${mixes[0]?.batch_no} … ${mixes[mixes.length - 1]?.batch_no}).`);

    let highest = state.highestBatch || 0;
    let year = state.batchYear || 0;
    for (let i = 0; i < mixes.length; i += cfg.batchSize) {
      const chunk = mixes.slice(i, i + cfg.batchSize);
      const r = await post(cfg, chunk);
      log(`  batch ${Math.floor(i / cfg.batchSize) + 1}: +${r.inserted} new, ${r.updated} changed, ${r.unchanged} unchanged` +
          (r.rejected ? `, ${r.rejected} rejected` : ""));
      // Trust the app's own high-water mark over our arithmetic, so a restored
      // backup pulls the cursor back and the missing batches re-send.
      if (Number.isInteger(r.highest_batch)) highest = r.highest_batch;
      if (Number.isInteger(r.batch_year)) year = r.batch_year;
    }
    saveState({ ...state, highestBatch: highest, batchYear: year, lastOkAt: new Date().toISOString() });
    state.highestBatch = highest;
    state.batchYear = year;
  } finally {
    staged.cleanup();
  }
}

async function main() {
  const cfg = loadConfig();
  const state = loadState();
  log(`MCI370 agent ${AGENT_VERSION} starting.`);
  log(`  reading  ${cfg.mdbPath}${cfg.copyFirst ? " (via a copy — the live file is never opened)" : " (DIRECTLY — copyFirst is off)"}`);
  log(`  sending  ${new URL("/api/plant/sync", cfg.appUrl).toString()}`);
  log(`  batches from ${cfg.startDate}, re-reading the last ${cfg.trailingDays} days, every ${cfg.pollSeconds}s`);
  log(`  resuming from batch ${state.highestBatch || 0} of ${state.batchYear || "—"}`);

  if (process.argv.includes("--once")) { await cycle(cfg, state); return; }

  for (;;) {
    try {
      await cycle(cfg, state);
    } catch (err) {
      // Never exit. The plant PC may be mid-reboot, the app mid-deploy, the
      // database mid-write. All of those resolve on their own, and an agent
      // that quits needs a human to notice.
      log(`cycle failed (will retry): ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
