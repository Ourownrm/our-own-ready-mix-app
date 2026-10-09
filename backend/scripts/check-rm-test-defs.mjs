// Round 194 — the raw-material test calculations live in two files that must
// stay byte-identical: backend/src/lib/rmTestDefs.js (the server recomputes
// and stores every result from the raw readings) and
// frontend/src/lib/rmTestDefs.js (the screen calculates live while the
// technician types). If they drift, the screen shows one answer and the
// report files another — exactly the kind of quiet disagreement nobody spots
// until a supplier disputes a result. This fails `npm run check` the moment
// the two differ, and runs both against the plant's own sheets so a change to
// a formula that breaks a known answer is caught too.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const back = path.join(ROOT, "backend", "src", "lib", "rmTestDefs.js");
const front = path.join(ROOT, "frontend", "src", "lib", "rmTestDefs.js");

let failed = false;
if (!fs.existsSync(front)) {
  console.error(`check-rm-test-defs: ${front} is missing.`);
  failed = true;
} else if (fs.readFileSync(back, "utf8") !== fs.readFileSync(front, "utf8")) {
  console.error("check-rm-test-defs: backend and frontend rmTestDefs.js differ — copy one over the other.");
  failed = true;
}

// Known answers from the plant's own signed sheets (Sept–Oct 2026).
const { computeTest, TEST_ORDER, TEST_DEFS } = await import("../src/lib/rmTestDefs.js");
const cases = [
  ["sieve_coarse", { head: { total: 2000 }, grid: { s16: { w: 0 }, s12_5: { w: 78 }, s10: { w: 1511 }, s4_75: { w: 394 }, pan: { w: 17 } } }, { grading: "12.5s" }, "conforms", "Passing 10 mm", 20.55],
  ["flakiness", { grid: { f25: { taken: 1182, flaky: 65 }, f20: { taken: 624, flaky: 28 }, f16: { taken: 150, flaky: 19 }, f12: { taken: 44, flaky: 14 } } }, {}, "conforms", "Flakiness index", 6.3],
  ["elongation", { grid: { f25: { taken: 1182, elong: 234 }, f20: { taken: 624, elong: 158 }, f16: { taken: 150, elong: 43 }, f12: { taken: 44, elong: 11 } } }, {}, "conforms", "Elongation index", 22.3, { companion: { index: 6.3, report_no: "X" } }, "With flakiness 6.3% (X)", 28.6],
  ["impact", { grid: { t1: { w1: 359, w2: 290, w3: 69 }, t2: { w1: 358, w2: 289, w3: 69 }, t3: { w1: 359, w2: 290, w3: 69 } } }, {}, "conforms", "Average AIV", 19.2],
  ["water_abs_coarse", { grid: { t1: { a: 1000, b: 997 }, t2: { a: 1000, b: 997 } } }, {}, "recorded", "Average water absorption", 0.3],
  ["sg_fine", { grid: { t1: { b: 1853, c: 1565, a: 458, d: 443 }, t2: { b: 1853, c: 1566, a: 458, d: 443 } } }, {}, "conforms", "Specific gravity (oven-dry)", 2.6],
  ["water_abs_fine", { grid: { t1: { a: 458, b: 443 }, t2: { a: 458, b: 443 } } }, {}, "recorded", "Average water absorption", 3.39],
  // Round 196 — from the second batch of sheets (9 Oct 2026)
  ["sg_coarse", { grid: { t1: { b: 2195, c: 1565, a: 1000, d: 997 }, t2: { b: 2195, c: 1565, a: 1000, d: 997 } } }, {}, "conforms", "Specific gravity (SSD)", 2.7],
  ["fines_75", { grid: { t1: { b: 500, c: 434 }, t2: { b: 500, c: 434 } } }, {}, "conforms", "Average finer than 75 µm", 13.2],
  ["bulk_density", { grid: { t1: { w1: 6.32, w2: 21.85, w3: 22.56, v: 9.844 }, t2: { w1: 6.32, w2: 21.83, w3: 22.66, v: 9.844 }, t3: { w1: 6.32, w2: 21.85, w3: 22.56, v: 9.844 } } }, {}, "recorded", "Average rodded bulk density", 1.65],
  ["bulk_density", { grid: { t1: { w1: 6.32, w2: 20.71, w3: 21.55, v: 9.844 }, t2: { w1: 6.32, w2: 20.81, w3: 21.41, v: 9.844 }, t3: { w1: 6.32, w2: 20.71, w3: 21.55, v: 9.844 } } }, {}, "recorded", "Average rodded bulk density", 1.54],
  ["moisture", { grid: { r1: { w1: 200, w2: 186 } } }, {}, "recorded", "Latest moisture content", 7.53],
  ["cement_fineness", { grid: { t1: { w: 100, r: 6 }, t2: { w: 100, r: 6 } } }, {}, "conforms", "Residue on 90 µm (plant check)", 6],
];
for (const [code, readings, params, verdict, label, value, ctx, label2, value2] of cases) {
  const out = computeTest(code, readings, params, ctx);
  const r = out.results.find((x) => x.label === label);
  const r2 = label2 ? out.results.find((x) => x.label === label2) : null;
  if (out.verdict !== verdict || !r || r.value !== value || (label2 && (!r2 || r2.value !== value2))) {
    console.error(`check-rm-test-defs: ${code} gave ${out.verdict} / ${label}=${r ? r.value : "missing"}, expected ${verdict} / ${value}.`, out.errors);
    failed = true;
  }
}
// Every test offered for a new plan must exist and not be retired.
for (const code of TEST_ORDER) {
  if (!TEST_DEFS[code] || TEST_DEFS[code].retired) { console.error(`check-rm-test-defs: TEST_ORDER lists ${code}, which is missing or retired.`); failed = true; }
}

if (failed) process.exit(1);
console.log(`check-rm-test-defs: both copies identical; ${cases.length} known answers from the plant's sheets reproduce.`);
