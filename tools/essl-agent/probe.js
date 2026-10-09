#!/usr/bin/env node
// Round 195 — the five-second check before installing anything.
//
//   npm run probe                      uses deviceIp from config.json
//   npm run probe -- 192.168.1.201     or give the address directly
//
// Connects to the machine, reads, prints what it found, disconnects.
// SENDS NOTHING to the app and changes nothing on the machine.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ZkClient } from "./zk.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch { /* optional */ }
const argIp = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
const ip = argIp || cfg.deviceIp || "192.168.1.201";
const port = cfg.devicePort || 4370;
const commKey = cfg.commKey || 0;

const step = (n, s) => console.log(`\n[${n}] ${s}`);

async function main() {
  console.log(`Probing the attendance machine at ${ip}:${port} (read-only, nothing is sent anywhere).`);
  const zk = new ZkClient({ ip, port, commKey, timeoutMs: 20000 });
  try {
    step(1, "Connecting…");
    await zk.connect();
    console.log("    connected.");

    step(2, "Machine details");
    console.log(`    serial     ${await zk.option("~SerialNumber") || "—"}`);
    console.log(`    model      ${await zk.option("~DeviceName") || "—"}`);
    console.log(`    firmware   ${await zk.firmware() || "—"}`);
    const t = await zk.time();
    console.log(`    clock      ${t || "—"}   (this PC: ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" })} IST)`);
    const sizes = await zk.sizes();
    if (sizes) {
      console.log(`    users      ${sizes.users} of ${sizes.userCapacity}`);
      console.log(`    punches    ${sizes.records} of ${sizes.recordCapacity}`);
    }

    step(3, "Users on the machine");
    const users = await zk.users(sizes?.users || 0);
    console.log(`    ${users.length} user(s). First few:`);
    for (const u of users.slice(0, 8)) console.log(`      ID ${u.userId.padEnd(6)} ${u.name || "(no name on machine)"}${u.privilege ? "  [admin]" : ""}`);

    step(4, "Punches");
    const punches = await zk.attendance(sizes?.records || 0, users);
    if (!punches.length) {
      console.log("    The machine holds no punches. (If eTimeTrackLite is set to clear the machine after");
      console.log("    downloading, it may have emptied it — see README, 'Before you start'.)");
    } else {
      const sorted = punches.map((p) => p.at).sort();
      console.log(`    ${punches.length} punch(es), from ${sorted[0]} to ${sorted[sorted.length - 1]}.`);
      console.log("    Latest five:");
      for (const p of punches.slice().sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5)) {
        console.log(`      ${p.at}   ID ${p.userId.padEnd(6)} key ${p.state === 0 ? "IN " : p.state === 1 ? "OUT" : p.state}  verify ${p.verify}`);
      }
      const byDay = {};
      for (const p of punches) byDay[p.at.slice(0, 10)] = (byDay[p.at.slice(0, 10)] || 0) + 1;
      console.log("    Punches per day, last 7 days on the machine:");
      for (const d of Object.keys(byDay).sort().slice(-7)) console.log(`      ${d}  ${byDay[d]}`);
    }
    if (zk.lastWarning) console.log(`\n    note: ${zk.lastWarning}`);
    console.log("\nAll good — this PC can read the machine. Carry on with Step 2 of the README.");
  } catch (err) {
    console.log(`\nSTOPPED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await zk.disconnect();
  }
}
main();
