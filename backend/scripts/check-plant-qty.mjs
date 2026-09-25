#!/usr/bin/env node
// ROUND 159 — the cumulative quantity must never be summed.
//
// WHY THIS EXISTS. MCI370 stores Production_Qty on a batch row as a RUNNING
// TOTAL of the load so far: batch 1 reads 1, batch 2 reads 2, batch 8 reads 8.
// Round 157 summed it. On this plant's real data that reported 73,987 m³
// against a true 16,010 — every production figure 4.6 times too high, and
// every consumption-per-m³ figure correspondingly too low.
//
// It passed verification because the synthetic test payload used 1 m³ per
// batch, which is the one case where summing and cumulating agree. Only real
// data could expose it, and by then it had shipped.
//
// The columns are now named so the mistake is hard to make by accident:
//
//   batch_qty_m3       this batch alone. THE column to sum.
//   load_qty_m3        the whole load. Constant across its batches — summing
//                      it across them multiplies by the batch count.
//   cumulative_qty_m3  MCI370's running total, kept for audit only.
//
// This checker makes it hard to make on purpose too.
//
//   node scripts/check-plant-qty.mjs
//
// If you genuinely need one of the forbidden aggregates — a max(), say, to
// recover a load total from the batch rows — put a marker on the line:
//     max(cumulative_qty_m3)   -- plant-qty-ok: max, not sum, recovers the load total

import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not the shell's working directory: run from the
// repository root rather than backend/ and a cwd-relative path silently
// scans nothing, which a checker reports as a pass.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// sum/avg over a column that is not per-batch. Whitespace-tolerant, because
// these appear inside formatted SQL.
// Two of these apply everywhere, because cumulative_qty_m3 and load_qty_m3 are
// names unique to plant_batches. The other two apply ONLY to the plant's own
// files: solitaire_dockets has its own perfectly legitimate production_qty_m3
// (a quantity a human types on a docket), and setup.js has to name the old
// columns in order to rename them. A checker that flags those is a checker
// people learn to ignore, which is worse than not having one.
const FORBIDDEN = [
  { re: /\b(sum|avg)\s*\(\s*(DISTINCT\s+)?[\w.]*\bcumulative_qty_m3\b/i, everywhere: true,
    why: "cumulative_qty_m3 is a running total — summing it multiplies production" },
  { re: /\b(sum|avg)\s*\(\s*(DISTINCT\s+)?[\w.]*\bload_qty_m3\b/i, everywhere: true,
    why: "load_qty_m3 repeats on every batch of a load — sum batch_qty_m3 instead" },
  { re: /\bproduction_qty_m3\b/i, everywhere: false,
    why: "production_qty_m3 was renamed in Round 159 because the name was the bug" },
  { re: /\bbatch_size_m3\b/i, everywhere: false,
    why: "batch_size_m3 was renamed to batch_qty_m3 in Round 159" },
];

// The plant's own code, where the old names must not reappear.
const PLANT_FILE = /(^|\/)plant[A-Za-z]*\.js$/;

const MARKER = /plant-qty-ok:/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const problems = [];
let filesChecked = 0;

for (const file of walk(ROOT)) {
  filesChecked++;
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split("\n");

  lines.forEach((line, i) => {
    // Prose that merely mentions a column name is not a query. check-dates.mjs
    // had to learn this the hard way in Round 155.
    const code = line.replace(/^\s*(\/\/|--|\*).*$/, "");
    if (!code.trim()) return;
    if (MARKER.test(line) || (i > 0 && MARKER.test(lines[i - 1]))) return;

    for (const f of FORBIDDEN) {
      if (!f.everywhere && !PLANT_FILE.test(rel)) continue;
      if (f.re.test(code)) {
        problems.push({ file: rel, line: i + 1, why: f.why, text: line.trim().slice(0, 120) });
        break;
      }
    }
  });
}

if (problems.length) {
  console.error("\nPlant quantities used in a way that overstates production:\n");
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`    ${p.text}`);
    console.error(`    ${p.why}\n`);
  }
  console.error(
    `${problems.length} place(s) to fix. Production is sum(batch_qty_m3); a load's own total is\n` +
    `load_qty_m3, read once per load, never added up across its batches.\n`
  );
  process.exit(1);
}

console.log(`Checked ${filesChecked} file(s). Production sums the per-batch quantity only.`);
