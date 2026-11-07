#!/usr/bin/env node
// Round 269 — the live weight for "weigh from the app".
//
// Runs on the weighbridge PC beside agent.js (same folder, same config.json).
// Reads the weighbridge indicator's continuous serial output, works out
// whether the reading is stable, and posts it to the app about once a second
// (POST /api/weighbridge/live). The app never accepts a typed weight: a
// capture takes this reading.
//
// The indicator on this plant: COM1, 9600 baud, 8N1, each frame starts with
// ':' and ends with '\r' (SmartWeigh's commport_settings). The digits inside a
// frame are the weight in kg. Anything different is set in config.json
// "indicator" without touching this file.
//
// THE PORT CAN ONLY BE OPEN IN ONE PROGRAM. If SmartWeigh is running and has
// COM1 open, this script cannot open it. Either close SmartWeigh while
// weighing from the app, or give this script the indicator's second serial
// output (most indicators have two) or a serial splitter — see README.md.
//
//   node indicator.js            run
//   node indicator.js --listen   print the frames and the parsed weight, post nothing
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const VERSION = "ind-1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.WB_CONFIG || path.join(__dirname, "config.json");
const LOG_PATH = process.env.WB_IND_LOG || path.join(__dirname, "indicator.log");
const LISTEN = process.argv.includes("--listen");

function log(...a) {
  const line = [new Date().toISOString(), ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))].join(" ");
  console.log(line);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + ".1");
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch { /* logging never stops the reader */ }
}

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const ind = {
  port: "COM1", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1,
  frameStart: ":", frameEnd: "\r",
  // The first signed number in the frame is the weight.
  pattern: "(-?\\d+(?:\\.\\d+)?)",
  multiplier: 1,             // e.g. 1000 if the indicator sends tonnes
  stableMs: 2000,            // the same weight (within stableBandKg) for this long = stable
  stableBandKg: 20,
  postEveryMs: 1000,
  ...(cfg.indicator || {}),
};
const re = new RegExp(ind.pattern);

let SerialPort;
try {
  ({ SerialPort } = await import("serialport"));
} catch {
  log("The 'serialport' package is missing. In this folder run:  npm install");
  process.exit(1);
}

let buf = "";
let last = null;           // { kg, at }
let steadySince = 0, steadyKg = null;

function onWeight(kg, raw) {
  const now = Date.now();
  if (steadyKg == null || Math.abs(kg - steadyKg) > ind.stableBandKg) { steadyKg = kg; steadySince = now; }
  last = { kg, at: now, raw, stable: now - steadySince >= ind.stableMs };
  if (LISTEN) log(`frame ${JSON.stringify(raw)} -> ${kg} kg ${last.stable ? "STABLE" : "moving"}`);
}

function onData(chunk) {
  buf += chunk.toString("latin1");
  if (buf.length > 4096) buf = buf.slice(-512);
  let end;
  while ((end = buf.indexOf(ind.frameEnd)) !== -1) {
    let frame = buf.slice(0, end);
    buf = buf.slice(end + ind.frameEnd.length);
    const s = ind.frameStart ? frame.lastIndexOf(ind.frameStart) : -1;
    if (s !== -1) frame = frame.slice(s + ind.frameStart.length);
    const m = frame.match(re);
    if (!m) continue;
    const kg = Math.round(Number(m[1]) * ind.multiplier);
    if (Number.isFinite(kg)) onWeight(kg, frame.trim());
  }
}

let port;
function open() {
  port = new SerialPort({ path: ind.port, baudRate: ind.baudRate, dataBits: ind.dataBits, parity: ind.parity, stopBits: ind.stopBits, autoOpen: false });
  port.on("data", onData);
  port.on("error", (e) => log("serial error:", e.message));
  port.on("close", () => { log("serial port closed — reopening in 5 s"); setTimeout(open, 5000); });
  port.open((err) => {
    if (err) {
      log(`Could not open ${ind.port}: ${err.message}. If SmartWeigh is running it may be holding the port. Retrying in 10 s.`);
      setTimeout(open, 10000);
    } else log(`Reading ${ind.port} at ${ind.baudRate} baud${LISTEN ? " (listen only)" : ""}.`);
  });
}
open();

if (!LISTEN) {
  const url = new URL("/api/weighbridge/live", cfg.appUrl).toString();
  let failing = false;
  setInterval(async () => {
    // Nothing heard for 3 s: say nothing, so the app shows "indicator offline"
    // instead of an old weight.
    if (!last || Date.now() - last.at > 3000) return;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-weighbridge-key": cfg.apiKey },
        body: JSON.stringify({ kg: last.kg, stable: last.stable, raw: last.raw, agent_version: VERSION }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failing) { log("posting again"); failing = false; }
    } catch (e) {
      if (!failing) log("could not post the live weight:", e.message);
      failing = true;
    }
  }, ind.postEveryMs);
}
