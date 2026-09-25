#!/usr/bin/env node
// ROUND 158 — every read of receipts must go through rm_receipts_effective.
//
// WHY THIS EXISTS. A receipt whose weighed and billed quantities disagree
// beyond tolerance is saved as 'pending' and must count for NOTHING until a
// Manager says which figure stands — not stock, not valuation, not landed
// rate, not order fulfilment, not any report. Receipts are read in more than a
// dozen places, so enforcing that by remembering to add
// "AND confirmation_status <> 'pending'" to each one is exactly how a month of
// quietly wrong stock happens.
//
// The rule instead: reads use the VIEW, which has the filter baked in. Only
// writes, the receipts screen, the confirmation queue and the double-claim
// check may touch the table directly, and each of those says so in a marker.
//
// This is the third checker in this project built on the same principle as
// check-guards.mjs and check-dates.mjs — parse the source as TEXT, fail the
// build on the shape that is known to be wrong, and give an escape hatch for
// the cases that genuinely need it. Every one of the three exists because the
// mistake it catches had already been made once.
//
//   node scripts/check-receipts.mjs
//
// To use the raw table on purpose, put a marker on the same line saying why:
//     FROM rm_receipts r   -- receipts-raw: the confirmation queue
//     // receipts-raw: the write itself
//   const { rows } = await query(`DELETE FROM rm_receipts ...`);

import fs from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "src");

// Files that are allowed to talk about the raw table freely: the migration
// runner creates and alters it, so requiring a marker per DDL line would be
// noise without value.
const EXEMPT_FILES = new Set(["routes/setup.js"]);

// A read is "FROM rm_receipts" or "JOIN rm_receipts" not followed by _effective.
// Writes are matched separately so the message can say which it found.
const READ = /\b(FROM|JOIN)\s+rm_receipts\b(?!_effective)/i;
const WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+rm_receipts\b(?!_effective)/i;
const MARKER = /receipts-raw:/;

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
let markersSeen = 0;

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (EXEMPT_FILES.has(rel)) continue;
  filesChecked++;

  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // A line that only mentions the table in prose is not a query. Requiring a
    // marker on explanatory comments is the mistake check-dates.mjs made in
    // Round 155 and had to be fixed for.
    const stripped = line.replace(/^\s*(\/\/|\*).*$/, "");
    if (!stripped) return;

    const isRead = READ.test(stripped);
    const isWrite = WRITE.test(stripped);
    if (!isRead && !isWrite) return;

    // The marker may sit on this line or on the line just above it, because a
    // long query often starts on its own line.
    const marked = MARKER.test(line) || (i > 0 && MARKER.test(lines[i - 1]));
    if (marked) { markersSeen++; return; }

    problems.push({
      file: rel,
      line: i + 1,
      kind: isWrite ? "write" : "read",
      text: line.trim().slice(0, 120),
    });
  });
}

if (problems.length) {
  console.error(`\nReceipts read straight from the table, bypassing the pending filter:\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  (${p.kind})`);
    console.error(`    ${p.text}`);
  }
  console.error(
    `\n${problems.length} place(s) to fix. A READ should use rm_receipts_effective, which excludes\n` +
    `receipts still waiting on a Manager. If this one genuinely needs the raw table — a write, the\n` +
    `confirmation queue, the double-claim check — add a marker on the line saying why:\n` +
    `    -- receipts-raw: <the reason>\n`
  );
  process.exit(1);
}

console.log(
  `Checked ${filesChecked} file(s). Every receipt read goes through rm_receipts_effective ` +
  `(${markersSeen} deliberate raw use${markersSeen === 1 ? "" : "s"}).`
);
