#!/usr/bin/env node
// Round 161 — the MixTrack print agent.
//
// Runs on the plant control PC, where Excel and the printer are. Claims a
// print job from the app, fills a copy of BPR107a.xlsm, calls the workbook's
// own PrintOrderandAsPDF macro, and posts the PDF back.
//
// FOUR DECISIONS WORTH KNOWING BEFORE CHANGING ANYTHING HERE:
//
// 1. THE PRINTING IS NOT OURS. BPR107a.xlsm already contains
//    PrintOrderandAsPDF, which prints the sheet and exports the PDF with a
//    name built from the cell values. We fill cells and call it. Reproducing
//    that layout in code would mean owning a document we did not design, and
//    the previous jsPDF attempt is exactly why this exists.
//
// 2. EXCEL RUNS HERE, NOT ON THE SERVER. The obvious alternative is
//    LibreOffice headless on Render. We do not: the workbook uses _xlfn.IFNA
//    and a web of VLOOKUPs, the macro is VBA, and the printer and the save
//    folder are both on this machine. Real Excel evaluates the real file.
//
// 3. THE APP HOLDS THE QUEUE, SO THE AGENT KEEPS NO STATE. A job is claimed
//    with a single UPDATE ... RETURNING on the server, so two agents cannot
//    take the same job, and a job claimed but never reported is offered again
//    after ten minutes. Nothing spools locally: if the post fails, the job is
//    still the server's and will be re-offered.
//
// 4. THE PDF IS SENT BACK *AND* LEFT HERE. The copy in the app is what makes
//    the search window work from a phone; the copy in the folder is what the
//    workbook's own PrintPDFFromFolderByNumber reprints after the app's
//    two-month retention window has cleared it.
//
// Setup is in README.md. Task Scheduler notes there are not optional reading —
// they cost a day on the weighbridge agent.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_VERSION = "1.0.0";

/* ---------------------------------------------------------------- config */

function loadConfig() {
  const p = path.join(HERE, "config.json");
  if (!fs.existsSync(p)) {
    console.error("config.json not found. Copy config.example.json to config.json and fill it in.");
    process.exit(1);
  }
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const k of ["apiUrl", "apiKey", "templatePath", "pdfFolder"]) {
    if (!c[k]) { console.error(`config.json is missing "${k}".`); process.exit(1); }
  }
  c.workDir = c.workDir || path.join(os.tmpdir(), "mixtrack-print");
  c.pollSeconds = Number(c.pollSeconds) || 20;
  return c;
}

/* ------------------------------------------------------------------ log */
//
// The agent runs as a scheduled task with no console attached, so anything it
// only prints to stdout is lost. Same rotating file both other agents use.

const LOG = path.join(HERE, "agent.log");
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1_000_000) {
      fs.renameSync(LOG, LOG + ".1");
    }
    fs.appendFileSync(LOG, line + "\n");
  } catch { /* logging must never be the thing that stops a ticket printing */ }
}

/* ------------------------------------------------------------------ http */

async function post(cfg, route, body) {
  const res = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}/api/mixtrack-print/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* fall through to the error below */ }
  if (!res.ok) {
    throw new Error(`${route} returned ${res.status}: ${(json?.error || text || "").slice(0, 300)}`);
  }
  return json;
}

/* ----------------------------------------------------------------- excel */

// 64-bit PowerShell deliberately, and note this is the OPPOSITE of the MCI370
// agent's requirement. That one needs 32-bit because Jet 4.0 is 32-bit only;
// this one needs to match the installed Excel's bitness for COM, and Excel on
// a modern machine is 64-bit. If Excel here is 32-bit, point powershellPath at
// SysWOW64 in config.json.
function powershell(cfg) {
  return cfg.powershellPath ||
    path.join(process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function fillAndPrint(cfg, job) {
  fs.mkdirSync(cfg.workDir, { recursive: true });
  const jobFile = path.join(cfg.workDir, `job-${job.id}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");

  const script = path.join(HERE, "fillAndPrint.ps1");
  const { stdout } = await execFileAsync(powershell(cfg), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-JobFile", jobFile,
    "-Template", cfg.templatePath,
    "-WorkDir", cfg.workDir,
    "-PdfFolder", cfg.pdfFolder,
  ], { maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 });

  // PowerShell writes one JSON object on the last non-empty line. Anything
  // before it is noise from the host and is ignored rather than allowed to
  // break the parse.
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  let out;
  try { out = JSON.parse(last); }
  catch { throw new Error(`could not read the PowerShell result: ${stdout.slice(-400)}`); }

  try { fs.unlinkSync(jobFile); } catch { /* a leftover job file is harmless */ }
  return out;
}

/* ------------------------------------------------------------------ main */

async function runOnce(cfg) {
  const { job } = await post(cfg, "claim", { agent_version: AGENT_VERSION });
  if (!job) return false;

  log(`job ${job.id} claimed (docket ${job.docket_id}, attempt ${job.attempts})`);

  let result;
  try {
    result = await fillAndPrint(cfg, job);
  } catch (err) {
    log(`job ${job.id} FAILED before Excel finished: ${err.message}`);
    await post(cfg, "result", { job_id: job.id, ok: false, error: err.message });
    return true;
  }

  if (!result.ok) {
    log(`job ${job.id} FAILED in Excel: ${result.error}`);
    await post(cfg, "result", { job_id: job.id, ok: false, error: result.error });
    return true;
  }

  // The PDF goes back as base64. It stays on disk here too — that copy is what
  // the workbook reprints once the app has purged its own.
  let pdf_base64 = null;
  if (result.pdf_path && fs.existsSync(result.pdf_path)) {
    const buf = fs.readFileSync(result.pdf_path);
    if (buf.length > 10 * 1024 * 1024) {
      log(`job ${job.id}: the PDF is ${(buf.length / 1048576).toFixed(1)} MB, too large to send — it stays on this PC only`);
    } else {
      pdf_base64 = buf.toString("base64");
    }
  } else {
    log(`job ${job.id}: printed, but no PDF was found in ${cfg.pdfFolder}`);
  }

  await post(cfg, "result", {
    job_id: job.id, ok: true,
    pdf_filename: result.pdf_filename || null,
    pdf_base64,
  });
  log(`job ${job.id} done — sheet ${result.sheet}, ${result.pdf_filename || "no PDF"}`);
  return true;
}

async function main() {
  const cfg = loadConfig();
  const once = process.argv.includes("--once");
  log(`MixTrack print agent ${AGENT_VERSION} starting (${once ? "one pass" : `polling every ${cfg.pollSeconds}s`})`);

  if (process.platform !== "win32") {
    log("WARNING: this agent drives Excel through COM and only runs on Windows.");
  }

  do {
    try {
      // Keep going while there is work. A truck does not wait for the next
      // poll because the one before it took a job.
      let worked = true;
      let printed = 0;
      while (worked && printed < 20) { worked = await runOnce(cfg); if (worked) printed++; }
    } catch (err) {
      log(`cycle failed: ${err.message}`);
    }
    if (!once) await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  } while (!once);
}

main().catch((err) => { log(`fatal: ${err.stack || err.message}`); process.exit(1); });
