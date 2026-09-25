#!/usr/bin/env node
// ROUND 160 — guards the MixTrack ticket workbook's cell map.
//
// This is the fifth checker in this project and it exists for the same reason
// as the other four: the mistake is easy, silent, and only visible on a piece
// of paper handed to a customer.
//
// Three ways the ticket goes wrong without anybody noticing:
//
//   1. A cell in LOAD_SHEET_CELLS stops being written. The workbook is reused
//      load after load, so the cell keeps the PREVIOUS load's value and the
//      ticket prints a plausible wrong name, time or quantity.
//   2. Code starts writing a cell that holds a formula (I40 picks which sheet
//      prints). Writing a value there destroys the formula permanently.
//   3. Code references one of the Batch Time cells the user deleted in this
//      round. Those cells no longer exist; a reference to them reads as blank
//      or #REF! rather than failing loudly.
//
// Like check-guards.mjs this parses the route files as TEXT. It is looking for
// what the code SAYS, not what it computes.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LOAD_SHEET_CELLS, PROTECTED_CELLS, REMOVED_CELLS } from "../src/lib/mixtrackWorkbook.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const MAP_FILE = "mixtrackWorkbook.js"; // the map itself is allowed to name every cell

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(SRC).filter((f) => !f.endsWith(MAP_FILE));
const problems = [];

// A workbook cell reference looks like "AZ32" in a string literal, near the
// workbook vocabulary. A bare AZ32 in unrelated code would be a false
// positive, so we require the file to be about the workbook at all.
const WORKBOOK_FILE = /mixtrackWorkbook|LOAD_SHEET_CELLS|buildLoadSheetValues|Load sheet/;

for (const f of files) {
  const text = readFileSync(f, "utf8");
  if (!WORKBOOK_FILE.test(text)) continue;

  for (const cell of REMOVED_CELLS) {
    const re = new RegExp(`["'\`]${cell}["'\`]`);
    if (re.test(text)) {
      problems.push(
        `${f}: references ${cell}, one of the Batch Time cells removed from the workbook in Round 160. ` +
        `The batch's timing is K19/K21 on the Load sheet now.`
      );
    }
  }

  for (const cell of PROTECTED_CELLS) {
    const re = new RegExp(`["'\`]${cell}["'\`]`);
    if (re.test(text)) {
      problems.push(
        `${f}: writes ${cell}, which holds one of the workbook's own formulas. ` +
        `Writing a value there destroys the formula permanently.`
      );
    }
  }
}

// Every mapped field must be selected somewhere, or the fill step has nothing
// to put in that cell. The docket read is where they come from.
const routeText = files
  .filter((f) => f.includes("solitaire") || f.includes("mixtrack"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

if (routeText) {
  for (const { cell, field, label } of LOAD_SHEET_CELLS) {
    if (!routeText.includes(field)) {
      problems.push(
        `no MixTrack route mentions "${field}" (${label}, cell ${cell}). ` +
        `The workbook is reused between loads, so an unwritten cell prints the previous load's value.`
      );
    }
  }
}

if (problems.length) {
  console.error("workbook cell check FAILED:\n");
  for (const p of problems) console.error("  - " + p);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}

console.log(`workbook cell check passed — ${LOAD_SHEET_CELLS.length} mapped cells, ${PROTECTED_CELLS.length} protected, ${REMOVED_CELLS.length} removed.`);
