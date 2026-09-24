// Round 155 — fail the build if the UTC-day bug comes back.
//
// Sibling of check-guards.mjs, and it exists for the same reason: this app has
// a bug class that keeps returning because every fix so far has been local.
// `new Date().toISOString().slice(0, 10)` is the UTC day; every date column it
// is compared against is the IST day (db.js pins every connection to
// Asia/Kolkata), so for five and a half hours every morning they disagree.
// Rounds 134, 153 and 154 each fixed one file. Round 155 fixed 49 sites and
// added this so the 50th cannot be introduced quietly.
//
//     node backend/scripts/check-dates.mjs
//
// It reads the files as TEXT — no imports, so it needs no database — and exits
// non-zero listing every offending line.
//
// WHAT COUNTS AS AN OFFENCE. Slicing a date out of toISOString(), and building
// one from new Date()'s local getters. Both produce a calendar day that is not
// the plant's. The fix is always lib/istDate.js, or better, doing the whole
// comparison in SQL with CURRENT_DATE.
//
// WHAT DOES NOT. A full ISO instant (`.toISOString()` with no slice) is exact
// and fine — it is a moment, not a day. So is toLocaleDateString for display.
// A line may be exempted with a trailing `// ist-ok:` comment explaining why,
// which keeps the exemption and its reason in the same place.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

const ROOTS = [
  path.join(ROOT, "backend", "src"),
  path.join(ROOT, "frontend", "src"),
];

// The files that are ALLOWED to contain the raw form, because they are the
// fix: the helpers themselves, and this checker.
const ALLOWED = new Set([
  path.join(ROOT, "backend", "src", "lib", "istDate.js"),
  path.join(ROOT, "frontend", "src", "lib", "istDate.js"),
]);

const PATTERNS = [
  {
    // .toISOString().slice(0, 10) / (0,7) / .substring / .split("T")[0]
    re: /toISOString\(\)\s*\.\s*(?:slice|substring)\(\s*0\s*,\s*(?:7|10)\s*\)|toISOString\(\)\s*\.\s*split\(\s*["']T["']\s*\)\s*\[\s*0\s*\]/,
    why: "UTC calendar day — use istDay()/istMonth() from lib/istDate.js, or decide it in SQL with CURRENT_DATE",
  },
  {
    // new Date(y, m, d) fed straight into toISOString — the worst form, wrong
    // every day of the year rather than only before 05:30.
    re: /new\s+Date\s*\([^)]*get(?:FullYear|Month)\s*\(\)[^)]*\)\s*\.\s*toISOString/,
    why: "local-fields Date printed as UTC — lands on the previous day/month. Use monthStartStr()/istDay()",
  },
];

let offences = 0;
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full);
    } else if (/\.(js|jsx|mjs)$/.test(entry.name)) {
      check(full);
    }
  }
}

function check(file) {
  if (ALLOWED.has(file)) return;
  scanned++;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/\/\/\s*ist-ok:/.test(line)) return;
    // Strip comments before matching. Without this the checker flags the
    // comments that explain the fix — which it did, on its own first run,
    // against the note above the fix in MaterialModule.jsx. Describing the old
    // wrong code is not writing it.
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    if (!code.trim() || /^\s*\*/.test(line)) return;
    for (const { re, why } of PATTERNS) {
      if (re.test(code)) {
        offences++;
        console.log(`  ${path.relative(ROOT, file)}:${i + 1}`);
        console.log(`    ${line.trim()}`);
        console.log(`    -> ${why}\n`);
        return;
      }
    }
  });
}

for (const r of ROOTS) if (fs.existsSync(r)) walk(r);

if (offences) {
  console.log(`${offences} date(s) built in UTC across ${scanned} file(s).\n`);
  console.log("Every date column in this app is the IST day — db.js pins every connection to");
  console.log("Asia/Kolkata. A date built from toISOString() is the UTC day and disagrees with");
  console.log("it between 00:00 and 05:30 IST, every morning. Use lib/istDate.js, or make the");
  console.log("comparison in SQL. If a line is genuinely safe, append `// ist-ok: <reason>`.");
  process.exit(1);
}

console.log(`Checked ${scanned} file(s). No dates built in UTC.`);
