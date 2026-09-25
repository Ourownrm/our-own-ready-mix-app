#!/usr/bin/env node
// Round 157 — prove the plant PC can be read, before trusting the agent on it.
//
//     npm run probe
//
// Run this FIRST on any machine the agent is going to live on. It answers, in
// order, the four questions that actually go wrong during a deployment, and it
// sends nothing anywhere — it only reads.
//
//   1. Is 32-bit PowerShell where we expect it?
//   2. Can the Jet provider open this .mdb at all?
//   3. Has the plant named its silos, and what did it call them?
//   4. Is there real batch data, and what does one mix look like?
//
// The last one matters more than it sounds. Every field map in this agent was
// derived from the installer's blank template; the first time it meets a
// plant's real data is the moment to check the numbers look like kilograms of
// concrete rather than something else entirely.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PS32 = "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe";
const PS32_ALT = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const CONFIG_PATH = process.env.MCI_CONFIG || path.join(__dirname, "config.json");

function fail(msg, hint) {
  console.log(`\n  FAILED: ${msg}`);
  if (hint) console.log(`  ${hint}`);
  process.exit(1);
}

async function q(ps, mdb, sql) {
  const { stdout } = await execFileAsync(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
     path.join(__dirname, "readMdb.ps1"), "-MdbPath", mdb, "-Sql", sql],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  const parsed = JSON.parse(stdout.trim() || "{}");
  if (parsed.error) throw new Error(parsed.error);
  const rows = parsed.rows;
  return !rows ? [] : Array.isArray(rows) ? rows : [rows];
}

const cfg = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};
const mdbPath = process.argv[2] || cfg.mdbPath;

console.log("MCI370 agent — probe\n");

if (!mdbPath) {
  fail("No database path.", "Pass one: npm run probe -- \"C:\\SSI\\MCI370\\MCI70_batch.Mdb\"");
}

// 1 — PowerShell
let ps = null;
if (fs.existsSync(PS32)) { ps = PS32; console.log(`  1. 32-bit PowerShell  OK   ${PS32}`); }
else if (fs.existsSync(PS32_ALT)) { ps = PS32_ALT; console.log(`  1. PowerShell         OK   ${PS32_ALT} (this looks like 32-bit Windows)`); }
else fail("No PowerShell found.", "Expected it at " + PS32);

// 2 — the database
if (!fs.existsSync(mdbPath)) {
  fail(`No database at ${mdbPath}.`,
       "MCI370 installs to C:\\SSI\\MCI370\\ by default. Search for it:  dir /s /b C:\\MCI70_batch.Mdb");
}
const sizeMb = (fs.statSync(mdbPath).size / 1048576).toFixed(1);
console.log(`  2. Database           OK   ${mdbPath} (${sizeMb} MB)`);

// Always probe a copy — never open the live file, for the same reason the
// agent doesn't.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mci370-probe-"));
const snap = path.join(tmpDir, "snapshot.mdb");
fs.copyFileSync(mdbPath, snap);

try {
  try {
    await q(ps, snap, "SELECT TOP 1 * FROM NameSetUp");
  } catch (err) {
    if (/not registered/i.test(err.message)) {
      fail("The Jet provider could not be loaded.",
           "This almost always means the script ran 64-bit. The agent always calls the 32-bit\n" +
           "  PowerShell explicitly, so if the agent itself works you can ignore this.");
    }
    fail(`Could not read the database: ${err.message}`);
  }
  console.log("  3. Jet provider       OK   the database opened read-only\n");

  // 3 — silo names
  const names = (await q(ps, snap, "SELECT TOP 1 * FROM NameSetUp"))[0];
  if (!names) {
    console.log("  Silos: NameSetUp is EMPTY — the plant has not named its hoppers in MCI370.");
    console.log("         Consumption will still sync, but every silo will need mapping by hand.\n");
  } else {
    const fields = [
      ["Gate1Name","Gate2Name","Gate3Name","Gate4Name","Gate5Name","Gate6Name"],
      ["Cem1Name","Cem2Name","Cem3Name","Cem4Name","FillName"],
      ["Wtr1Name","wtr2Name","SilicaName","SlurryName"],
      ["Admix1Name","Admix12Name","Admix2Name","Admix22Name","PigName"],
    ];
    console.log("  Silos, as the plant has named them in MCI370:");
    for (const group of fields) {
      const parts = group
        .map((f) => [f, names[f]])
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
        .map(([f, v]) => `${f.replace(/Name$/, "")}=${JSON.stringify(String(v).trim())}`);
      if (parts.length) console.log("    " + parts.join("  "));
    }
    if (names.CompanyName) console.log(`    (plant: ${names.CompanyName}, serial ${names.PlantSlNO || "—"})`);
    console.log("\n  Anything reading \"0\", \"-\" or a default like \"Agg6\" is an unused hopper and is skipped.\n");
  }

  // 4 — real data
  const counts = await q(ps, snap, "SELECT COUNT(*) AS n FROM Batch_Transaction");
  const n = Number(counts[0]?.n ?? 0);
  console.log(`  Batch_Transaction: ${n} mix row(s)`);
  if (!n) {
    console.log("  No batches yet. That is expected on a fresh install — run this again after the");
    console.log("  plant has batched something.\n");
  } else {
    const latest = await q(
      ps, snap,
      "SELECT TOP 3 Batch_Year, Batch_No, Batch_Index, Batch_Date, Batch_Time, Production_Qty, " +
      "Gate1_Actual, Gate2_Actual, Gate3_Actual, Gate4_Actual, Cement1_Actual, Cement2_Actual, Water1_Actual " +
      "FROM Batch_Transaction ORDER BY Batch_Year DESC, Batch_No DESC, Batch_Index DESC"
    );
    console.log("  The three most recent mixes:");
    for (const r of latest) {
      const when = String(r.Batch_Date || "").slice(0, 10);
      const wts = ["Gate1_Actual","Gate2_Actual","Gate3_Actual","Gate4_Actual","Cement1_Actual","Cement2_Actual","Water1_Actual"]
        .map((f) => (r[f] ? `${f.replace("_Actual","")}=${r[f]}` : null)).filter(Boolean).join(" ");
      console.log(`    ${when}  batch ${r.Batch_No}/${r.Batch_Index}  ${r.Production_Qty ?? "?"} m³   ${wts}`);
    }
    console.log("\n  Sanity-check those weights: they are kilograms for ONE MIX, not one load.");
    console.log("  A 1 m³ mix is roughly 2,400 kg all told — aggregates in the high hundreds,");
    console.log("  cement in the low hundreds, water around 150-200.\n");

    const dat = await q(ps, snap, "SELECT COUNT(*) AS n FROM Batch_Dat_Trans");
    console.log(`  Batch_Dat_Trans: ${Number(dat[0]?.n ?? 0)} load row(s) — customer, site, truck and order context.`);
    if (Number(dat[0]?.n ?? 0) === 0 && n > 0) {
      console.log("  WARNING: there are mixes but no load rows, so customer/site/truck will be blank.");
      console.log("  Worth checking whether this plant uses Batch_Dat_Trans1 instead.");
    }
  }

  console.log("\n  Probe finished. Nothing was written and nothing was sent.");
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
