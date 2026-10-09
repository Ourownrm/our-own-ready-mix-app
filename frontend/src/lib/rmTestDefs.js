// Round 194 — raw material lab tests: what each test is, what the technician
// types, and how the result is worked out.
//
// THIS FILE EXISTS TWICE, BYTE FOR BYTE: backend/src/lib/rmTestDefs.js and
// frontend/src/lib/rmTestDefs.js. The screen calculates live while the
// technician types; the server recalculates on every save from the raw
// readings and stores ITS answer, so a tampered or stale browser can never
// file a result. Two copies of one calculation drift unless something stops
// them, so backend/scripts/check-rm-test-defs.mjs fails `npm run check` the
// moment they differ. Edit one, copy it over the other.
//
// No imports, no dates from the clock, no DOM — plain functions of the
// readings, so both sides get the same answer.
//
// Shape of every test:
//   layout  "trials" — the same fields measured on Trial 1..n (most forms)
//           "rows"   — one row per sieve / fraction / age, fields across
//   head    single values for the whole test (sample weight, cast date, ...)
//   fields  per-row values; `input: true` ones are typed, the rest computed
//   params  how a material's plan configures the test (size, limit basis, ...)
//   form    the plant's own OORM-QC form number where one exists; null for a
//           test the plant has no paper form for yet (a plan can set one)
//   retired true = kept only so cards already filed under it still open and
//           print; never offered for a new plan or card (Round 196 split the
//           combined flakiness/elongation and admixture tests)
//   compute(readings, params, ctx) -> {   ctx = { companion } for a test whose
//           limit spans two cards (flakiness + elongation, see below)
//     cells:    { rowKey: { fieldKey: value } }   computed values for display
//     results:  [{ label, value, unit, dp, limit, ok }]   headline results
//     verdict:  "conforms" | "non_conforming" | "recorded" | null (incomplete)
//     summary:  one line for lists and the register
//     errors:   reasons the test cannot be submitted yet
//     warnings: things worth a second look that do not block
//   }
// readings = { head: { key: value }, grid: { rowKey: { fieldKey: value } } }

function n(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}
function rnd(v, dp) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}
function avg(list) {
  const a = list.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function fmt(v, dp) {
  const r = rnd(v, dp);
  return r === null ? "—" : r.toFixed(dp);
}
function g(readings, row, key) {
  return n(readings && readings.grid && readings.grid[row] ? readings.grid[row][key] : null);
}
function h(readings, key) {
  return readings && readings.head ? readings.head[key] : undefined;
}
function trialKeys(count) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push("t" + i);
  return out;
}
function trialRows(count) {
  return trialKeys(count).map((k, i) => ({ key: k, label: "Trial " + (i + 1) }));
}
function blank() {
  return { cells: {}, results: [], verdict: null, summary: "", errors: [], warnings: [] };
}
// A date-only "YYYY-MM-DD" plus whole days, done on UTC midnight so the
// calendar day can never shift with a timezone. Returns "YYYY-MM-DD" or null.
function addDays(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000;
  const d = new Date(t);
  const p = (x) => (x < 10 ? "0" : "") + x;
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}
function decide(results) {
  const judged = results.filter((r) => r.ok === true || r.ok === false);
  if (!judged.length) return "recorded";
  return judged.every((r) => r.ok) ? "conforms" : "non_conforming";
}

// ---------------------------------------------------------------------------
// Grading limits, % passing. IS 383:2016 Table 7 (coarse) and Table 9 (fine).
// [sieve mm, lower, upper]. Check these against the licensed standard before
// relying on a size this plant has not used before — 12.5 mm single-sized is
// exactly the plant's own OORM-QC-07 form.
// ---------------------------------------------------------------------------
export const COARSE_GRADINGS = {
  "40s": { label: "40 mm single-sized", sieves: [[63, 100, 100], [40, 85, 100], [20, 0, 20], [10, 0, 5]] },
  "20s": { label: "20 mm single-sized", sieves: [[40, 100, 100], [20, 85, 100], [10, 0, 20], [4.75, 0, 5]] },
  "12.5s": { label: "12.5 mm single-sized", sieves: [[16, 100, 100], [12.5, 85, 100], [10, 0, 45], [4.75, 0, 10]] },
  "10s": { label: "10 mm single-sized", sieves: [[12.5, 100, 100], [10, 85, 100], [4.75, 0, 20], [2.36, 0, 5]] },
  "20g": { label: "20 mm graded", sieves: [[40, 100, 100], [20, 90, 100], [10, 25, 55], [4.75, 0, 10]] },
  "12.5g": { label: "12.5 mm graded", sieves: [[20, 100, 100], [12.5, 90, 100], [10, 40, 85], [4.75, 0, 10]] },
};

const FINE_SIEVES = [[10, "10 mm"], [4.75, "4.75 mm"], [2.36, "2.36 mm"], [1.18, "1.18 mm"], [0.6, "600 µm"], [0.3, "300 µm"], [0.15, "150 µm"]];
export const FINE_ZONES = {
  I: [[100, 100], [90, 100], [60, 95], [30, 70], [15, 34], [5, 20], [0, 10]],
  II: [[100, 100], [90, 100], [75, 100], [55, 90], [35, 59], [8, 30], [0, 10]],
  III: [[100, 100], [90, 100], [85, 100], [75, 100], [60, 79], [12, 40], [0, 10]],
  IV: [[100, 100], [95, 100], [95, 100], [90, 100], [80, 100], [15, 50], [0, 15]],
};

function sieveKey(mm) {
  return "s" + String(mm).replace(".", "_");
}
function sieveLabel(mm) {
  return mm < 1 ? Math.round(mm * 1000) + " µm" : mm + " mm";
}

// Shared by both sieve tests: % retained, cumulative and passing from the
// retained weights, plus the "weights add up to the sample" check.
function sieveTable(readings, rows) {
  const total = n(h(readings, "total"));
  const out = { cells: {}, errors: [], warnings: [], passing: {}, cumRet: {}, complete: true, sum: 0 };
  if (!total || total <= 0) {
    out.errors.push("Enter the total weight of the sample.");
    out.complete = false;
  }
  let cum = 0;
  for (const r of rows) {
    const w = g(readings, r.key, "w");
    if (w === null) { out.complete = false; continue; }
    if (w < 0) out.errors.push("A retained weight cannot be negative (" + r.label + ").");
    out.sum += w;
    if (!total) continue;
    const pr = (w / total) * 100;
    cum += pr;
    const pass = Math.max(0, 100 - cum);
    out.cells[r.key] = { pr: rnd(pr, 2), cum: rnd(Math.min(cum, 100), 2), pass: r.pan ? null : rnd(pass, 2) };
    out.passing[r.key] = pass;
    out.cumRet[r.key] = Math.min(cum, 100);
  }
  if (!out.complete && total) out.errors.push("Enter the weight retained on every sieve and the pan (0 where nothing is retained).");
  if (out.complete && total) {
    const lossPct = (Math.abs(total - out.sum) / total) * 100;
    if (lossPct > 0.5) {
      out.errors.push(
        "The retained weights add up to " + fmt(out.sum, 1) + " g against a " + fmt(total, 1) +
        " g sample (" + fmt(lossPct, 2) + "% apart). Re-weigh before submitting."
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builders shared by more than one test (Round 196)
// ---------------------------------------------------------------------------
const FRACTIONS = [["f40", "40 – 25 mm"], ["f25", "25 – 20 mm"], ["f20", "20 – 16 mm"], ["f16", "16 – 12.5 mm"], ["f12", "12.5 – 10 mm"], ["f10", "10 – 6.3 mm"]];

// Flakiness (QC-04) and elongation (QC-03): the same sheet shape — weight of
// each fraction taken, the weight caught by the gauge, the rest — and an index
// = gauge weight / total weight × 100, exactly as the plant's forms work it.
function indexTest(o) {
  return {
    code: o.code,
    label: o.label,
    short: o.short,
    form: o.form,
    method: "IS 2386 (Part 1):1963",
    spec: "IS 383:2016 — flakiness + elongation combined ≤ 40%",
    kinds: ["coarse"],
    layout: "rows",
    companion: o.other,
    fields: [
      { key: "taken", label: "Wt. of sample taken", unit: "g", input: true },
      { key: o.field, label: o.fieldLabel, unit: "g", input: true },
      { key: "rest", label: o.rest, unit: "g", dp: 0 },
    ],
    rows() {
      return FRACTIONS.map(([key, label]) => ({ key, label }));
    },
    compute(readings, params, ctx) {
      const out = blank();
      let W = 0, G = 0, any = false;
      for (const r of this.rows()) {
        const taken = g(readings, r.key, "taken");
        const gauge = g(readings, r.key, o.field);
        if (taken === null && gauge === null) continue;
        any = true;
        if (taken === null) { out.errors.push(r.label + ": enter the weight taken (0 if none)."); continue; }
        if ((gauge || 0) > taken) out.errors.push(r.label + ": the gauge weight is more than the weight taken.");
        W += taken; G += gauge || 0;
        out.cells[r.key] = { rest: rnd(taken - (gauge || 0), 0) };
      }
      if (!any || W <= 0) { out.errors.push("Enter the fractions tested."); return out; }
      const idx = (G / W) * 100;
      out.index = rnd(idx, 1);
      out.results.push({ label: "Total weight of aggregate (W)", value: rnd(W, 0), unit: "g", dp: 0, ok: null });
      out.results.push({ label: "Total weight caught by the gauge (W1)", value: rnd(G, 0), unit: "g", dp: 0, ok: null });
      const comp = ctx && ctx.companion && ctx.companion.index !== null && ctx.companion.index !== undefined ? ctx.companion : null;
      if (comp) {
        const comb = rnd(idx, 1) + Number(comp.index);
        out.results.push({ label: o.label, value: rnd(idx, 1), unit: "%", dp: 1, ok: null });
        out.results.push({ label: "With " + o.otherLabel + " " + comp.index + "% (" + comp.report_no + ")", value: rnd(comb, 1), unit: "%", dp: 1, limit: "≤ 40% combined", ok: rnd(comb, 1) <= 40 });
        out.combined = rnd(comb, 1);
        out.summary = fmt(idx, 1) + "% · combined with " + o.otherLabel + " " + fmt(comb, 1) + "% (limit 40%)";
      } else {
        out.results.push({ label: o.label, value: rnd(idx, 1), unit: "%", dp: 1, limit: "≤ 40% (combined check when the " + o.otherLabel + " test is filed)", ok: rnd(idx, 1) <= 40 });
        out.warnings.push("No " + o.otherLabel + " result for this supply yet — the combined ≤ 40% check is made on whichever of the two is filed second.");
        out.summary = fmt(idx, 1) + "% (" + o.otherLabel + " not yet filed)";
      }
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      return out;
    },
  };
}

// Pycnometer specific gravity (OORM-QC-10), the same form for fine and coarse
// aggregate. Water absorption is its own test from Round 196.
function sgTest(o) {
  return {
    code: o.code,
    label: o.label,
    short: "Specific gravity",
    form: "OORM-QC-10",
    method: "IS 2386 (Part 3):1963",
    spec: "Plant specification — minimum 2.6",
    kinds: o.kinds,
    layout: "trials",
    trials: 2,
    params: [
      { key: "min", label: "Minimum specific gravity", default: "2.6", options: [["2.5", "2.5"], ["2.55", "2.55"], ["2.6", "2.6"], ["2.65", "2.65"]] },
      { key: "basis", label: "Limit applies to", default: "od", options: [["od", "Oven-dry basis"], ["ssd", "Saturated surface-dry basis"]] },
    ],
    fields: [
      { key: "b", label: "Pycnometer + aggregate + water (B)", unit: "g", input: true },
      { key: "c", label: "Pycnometer + water (C)", unit: "g", input: true },
      { key: "a", label: "Saturated surface-dry aggregate in air (A)", unit: "g", input: true },
      { key: "d", label: "Oven-dried sample (D)", unit: "g", input: true },
      { key: "ssd", label: "SG (SSD) = A / (A − (B − C))", dp: 2 },
      { key: "od", label: "SG (oven-dry) = D / (A − (B − C))", dp: 2 },
      { key: "app", label: "Apparent SG = D / (D − (B − C))", dp: 2 },
    ],
    compute(readings, params) {
      const out = blank();
      const min = Number((params && params.min) || 2.6);
      const basis = (params && params.basis) || "od";
      const S = { ssd: [], od: [], app: [] };
      for (const k of trialKeys(2)) {
        const B = g(readings, k, "b"), C = g(readings, k, "c"), A = g(readings, k, "a"), D = g(readings, k, "d");
        if ([A, B, C, D].some((x) => x === null)) continue;
        const vol = A - (B - C);
        const volApp = D - (B - C);
        if (vol <= 0 || volApp <= 0 || D <= 0) { out.errors.push("Trial " + k.slice(1) + ": the weights do not give a positive volume — check B and C."); continue; }
        if (D > A) { out.errors.push("Trial " + k.slice(1) + ": the oven-dry weight is more than the SSD weight."); continue; }
        const row = { ssd: A / vol, od: D / vol, app: D / volApp };
        out.cells[k] = { ssd: rnd(row.ssd, 2), od: rnd(row.od, 2), app: rnd(row.app, 2) };
        for (const key of Object.keys(S)) S[key].push(row[key]);
        if (rnd(row[basis], 2) < min) out.warnings.push("Trial " + k.slice(1) + ": " + (basis === "od" ? "oven-dry" : "SSD") + " SG is " + fmt(row[basis], 2) + ", below " + min + ".");
      }
      if (!S.ssd.length) { out.errors.push("Enter at least one complete trial."); return out; }
      const lim = "≥ " + min;
      out.results.push({ label: "Specific gravity (SSD)", value: rnd(avg(S.ssd), 2), dp: 2, limit: basis === "ssd" ? lim : null, ok: basis === "ssd" ? rnd(avg(S.ssd), 2) >= min : null });
      out.results.push({ label: "Specific gravity (oven-dry)", value: rnd(avg(S.od), 2), dp: 2, limit: basis === "od" ? lim : null, ok: basis === "od" ? rnd(avg(S.od), 2) >= min : null });
      out.results.push({ label: "Apparent specific gravity", value: rnd(avg(S.app), 2), dp: 2, ok: null });
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = "SG " + fmt(avg(S[basis]), 2) + " (" + (basis === "od" ? "oven-dry" : "SSD") + ", min " + min + ")";
      return out;
    },
  };
}

// Water absorption from an SSD weight (a) and an oven-dry weight (b).
function absorption(readings) {
  const out = blank();
  const vals = [];
  for (const k of trialKeys(2)) {
    const a = g(readings, k, "a");
    const b = g(readings, k, "b");
    if (a === null || b === null || b <= 0) continue;
    if (b > a) { out.errors.push("Trial " + k.slice(1) + ": the oven-dry weight is more than the SSD weight."); continue; }
    const wa = ((a - b) / b) * 100;
    out.cells[k] = { wa: rnd(wa, 2) };
    vals.push(wa);
  }
  if (!vals.length) { out.errors.push("Enter at least one trial."); return out; }
  const a = avg(vals);
  out.results.push({ label: "Average water absorption", value: rnd(a, 2), unit: "%", dp: 2, limit: "Not specified", ok: null });
  if (out.errors.length) return out;
  out.verdict = "recorded";
  out.summary = fmt(a, 2) + "%";
  return out;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------
export const TEST_DEFS = {
  sieve_coarse: {
    code: "sieve_coarse",
    label: "Sieve analysis of coarse aggregate",
    short: "Sieve analysis",
    form: "OORM-QC-07",
    method: "IS 2386 (Part 1):1963",
    spec: "IS 383:2016, Table 7",
    kinds: ["coarse"],
    layout: "rows",
    params: [
      { key: "grading", label: "Grading", default: "20s", options: Object.keys(COARSE_GRADINGS).map((k) => [k, COARSE_GRADINGS[k].label]) },
    ],
    head: [{ key: "total", label: "Total weight of the sample", unit: "g", type: "number" }],
    fields: [
      { key: "w", label: "Weight retained", unit: "g", input: true },
      { key: "pr", label: "% retained", dp: 2 },
      { key: "cum", label: "Cum. % retained", dp: 2 },
      { key: "pass", label: "% passing", dp: 2 },
      { key: "lim", label: "IS limit", text: true },
      { key: "chk", label: "Check", text: true },
    ],
    rows(params) {
      const gr = COARSE_GRADINGS[(params && params.grading) || "20s"] || COARSE_GRADINGS["20s"];
      return gr.sieves.map(([mm, lo, hi]) => ({ key: sieveKey(mm), label: sieveLabel(mm), lo, hi }))
        .concat([{ key: "pan", label: "Pan", pan: true }]);
    },
    compute(readings, params) {
      const out = blank();
      const gr = COARSE_GRADINGS[(params && params.grading) || "20s"] || COARSE_GRADINGS["20s"];
      const rows = this.rows(params);
      const t = sieveTable(readings, rows);
      out.errors.push(...t.errors);
      let fail = null;
      for (const r of rows) {
        const c = t.cells[r.key] || {};
        if (!r.pan) {
          c.lim = r.lo === r.hi ? String(r.lo) : r.lo + " – " + r.hi;
          if (t.passing[r.key] !== undefined) {
            const p = rnd(t.passing[r.key], 2);
            const ok = p >= r.lo && p <= r.hi;
            c.chk = ok ? "Within" : "Outside";
            if (!ok && !fail) fail = { r, p };
            out.results.push({ label: "Passing " + r.label, value: p, unit: "%", dp: 2, limit: c.lim, ok });
          }
        } else {
          c.lim = "—";
          c.chk = "—";
        }
        out.cells[r.key] = c;
      }
      if (out.errors.length || !t.complete) return out;
      out.verdict = fail ? "non_conforming" : "conforms";
      out.summary = fail
        ? "Outside IS 383 at " + fail.r.label + " (" + fail.p.toFixed(2) + "% passing, limit " + (fail.r.lo === fail.r.hi ? fail.r.lo : fail.r.lo + "–" + fail.r.hi) + ")"
        : "Within IS 383 Table 7, " + gr.label;
      return out;
    },
  },

  sieve_fine: {
    code: "sieve_fine",
    label: "Sieve analysis of fine aggregate & grading zone",
    short: "Sieve analysis & zone",
    form: null,
    method: "IS 2386 (Part 1):1963",
    spec: "IS 383:2016, Table 9",
    kinds: ["fine"],
    layout: "rows",
    params: [
      { key: "sand", label: "Sand type", default: "crushed", options: [["crushed", "Crushed (M-Sand) — 150 µm up to 20%"], ["natural", "Natural sand"]] },
    ],
    head: [{ key: "total", label: "Total weight of the sample", unit: "g", type: "number" }],
    fields: [
      { key: "w", label: "Weight retained", unit: "g", input: true },
      { key: "pr", label: "% retained", dp: 2 },
      { key: "cum", label: "Cum. % retained", dp: 2 },
      { key: "pass", label: "% passing", dp: 2 },
      { key: "lim", label: "Zone limit", text: true },
      { key: "chk", label: "Check", text: true },
    ],
    rows() {
      return FINE_SIEVES.map(([mm, label]) => ({ key: sieveKey(mm), label, mm })).concat([{ key: "pan", label: "Pan", pan: true }]);
    },
    compute(readings, params) {
      const out = blank();
      const rows = this.rows(params);
      const t = sieveTable(readings, rows);
      out.errors.push(...t.errors);
      for (const r of rows) out.cells[r.key] = t.cells[r.key] || {};
      if (out.errors.length || !t.complete) return out;
      const p600 = t.passing[sieveKey(0.6)];
      let zone = null;
      if (p600 >= 14.5) zone = p600 <= 34.5 ? "I" : p600 <= 59.5 ? "II" : p600 <= 79.5 ? "III" : "IV";
      const crushed = !params || params.sand !== "natural";
      let failAt = null;
      FINE_SIEVES.forEach(([mm, label], i) => {
        const key = sieveKey(mm);
        const c = out.cells[key];
        if (!zone) { c.lim = "—"; c.chk = "—"; return; }
        let [lo, hi] = FINE_ZONES[zone][i];
        if (mm === 0.15 && crushed) hi = Math.max(hi, 20);
        c.lim = lo === hi ? String(lo) : lo + " – " + hi;
        const p = rnd(t.passing[key], 2);
        const ok = p >= lo && p <= hi;
        c.chk = ok ? "Within" : "Outside";
        if (!ok && !failAt) failAt = { label, p, lo, hi };
      });
      out.cells.pan.lim = "—";
      out.cells.pan.chk = "—";
      // Fineness modulus: cumulative % retained on the standard sieves, / 100.
      const fm = FINE_SIEVES.reduce((s, [mm]) => s + (t.cumRet[sieveKey(mm)] || 0), 0) / 100;
      out.results.push({ label: "Passing 600 µm", value: rnd(p600, 2), unit: "%", dp: 2, limit: "decides the zone", ok: null });
      out.results.push({ label: "Grading zone", value: zone ? "Zone " + zone : "Coarser than Zone I", text: true, ok: zone ? !failAt : false, limit: "Zone I – IV" });
      out.results.push({ label: "Fineness modulus", value: rnd(fm, 2), dp: 2, ok: null });
      out.verdict = zone && !failAt ? "conforms" : "non_conforming";
      out.summary = !zone
        ? "Coarser than Zone I (600 µm passing " + fmt(p600, 1) + "%)"
        : failAt
          ? "Zone " + zone + " by 600 µm, but " + failAt.label + " is outside (" + failAt.p.toFixed(2) + "%, limit " + failAt.lo + "–" + failAt.hi + ")"
          : "Zone " + zone + " · FM " + fmt(fm, 2);
      return out;
    },
  },

  fines_75: {
    code: "fines_75",
    label: "Material finer than 75 µm (wash)",
    short: "Finer than 75 µm",
    form: "OORM-QC-21",
    method: "IS 2386 (Part 1):1963",
    spec: "IS 383:2016, Table 2",
    kinds: ["coarse", "fine"],
    layout: "trials",
    trials: 2,
    params: [
      {
        key: "kind", label: "Aggregate", default: "fine_crushed",
        options: [["fine_crushed", "Crushed sand (≤ 15%)"], ["fine_natural", "Natural sand (≤ 3%)"], ["coarse_crushed", "Crushed coarse (≤ 3%)"], ["coarse_natural", "Uncrushed coarse (≤ 1%)"]],
      },
    ],
    fields: [
      { key: "b", label: "Original dry weight of sample (B)", unit: "g", input: true },
      { key: "c", label: "Dry weight after washing (C)", unit: "g", input: true },
      { key: "pct", label: "Finer than 75 µm = (B − C) / B × 100", unit: "%", dp: 2 },
    ],
    compute(readings, params) {
      const out = blank();
      const LIM = { fine_crushed: 15, fine_natural: 3, coarse_crushed: 3, coarse_natural: 1 };
      const lim = LIM[(params && params.kind) || "fine_crushed"] || 15;
      const vals = [];
      for (const k of trialKeys(2)) {
        const b = g(readings, k, "b");
        const c = g(readings, k, "c");
        if (b === null || c === null) continue;
        if (c > b) { out.errors.push("Trial " + k.slice(1) + ": the washed weight is more than the original."); continue; }
        const pct = b > 0 ? ((b - c) / b) * 100 : null;
        out.cells[k] = { pct: rnd(pct, 2) };
        vals.push(pct);
      }
      if (!vals.length) { out.errors.push("Enter at least one trial."); return out; }
      const a = avg(vals);
      out.results.push({ label: "Average finer than 75 µm", value: rnd(a, 2), unit: "%", dp: 2, limit: "≤ " + lim + "%", ok: rnd(a, 2) <= lim });
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = fmt(a, 2) + "% (limit " + lim + "%)";
      return out;
    },
  },

  flaky_elong: {
    code: "flaky_elong",
    label: "Flakiness & elongation index (combined — old)",
    short: "Flakiness + elongation",
    retired: true,
    form: "OORM-QC-04 / QC-03",
    method: "IS 2386 (Part 1):1963",
    spec: "IS 383:2016, cl 5.3 — combined index ≤ 40%",
    kinds: ["coarse"],
    layout: "rows",
    fields: [
      { key: "taken", label: "Wt. of fraction taken", unit: "g", input: true },
      { key: "flaky", label: "Passing thickness gauge (flaky)", unit: "g", input: true },
      { key: "nonflaky", label: "Non-flaky", unit: "g", dp: 0 },
      { key: "elong", label: "Retained on length gauge (elongated)", unit: "g", input: true },
    ],
    rows() {
      return [["f40", "40 – 25 mm"], ["f25", "25 – 20 mm"], ["f20", "20 – 16 mm"], ["f16", "16 – 12.5 mm"], ["f12", "12.5 – 10 mm"], ["f10", "10 – 6.3 mm"]]
        .map(([key, label]) => ({ key, label }));
    },
    compute(readings) {
      const out = blank();
      let W = 0, F = 0, E = 0, any = false;
      for (const r of this.rows()) {
        const taken = g(readings, r.key, "taken");
        const flaky = g(readings, r.key, "flaky");
        const elong = g(readings, r.key, "elong");
        if (taken === null && flaky === null && elong === null) continue;
        any = true;
        if (taken === null) { out.errors.push(r.label + ": enter the weight taken (0 if none)."); continue; }
        if ((flaky || 0) > taken) out.errors.push(r.label + ": flaky weight is more than the weight taken.");
        if ((elong || 0) > taken - (flaky || 0)) out.errors.push(r.label + ": elongated weight is more than the non-flaky weight.");
        W += taken; F += flaky || 0; E += elong || 0;
        out.cells[r.key] = { nonflaky: rnd(taken - (flaky || 0), 0) };
      }
      if (!any || W <= 0) { out.errors.push("Enter the fractions tested."); return out; }
      const fi = (F / W) * 100;
      const ei = (E / W) * 100;
      const comb = fi + ei;
      out.results.push({ label: "Total weight of fractions (W)", value: rnd(W, 0), unit: "g", dp: 0, ok: null });
      out.results.push({ label: "Flakiness index", value: rnd(fi, 1), unit: "%", dp: 1, ok: null });
      out.results.push({ label: "Elongation index", value: rnd(ei, 1), unit: "%", dp: 1, ok: null });
      out.results.push({ label: "Combined index", value: rnd(comb, 1), unit: "%", dp: 1, limit: "≤ 40%", ok: rnd(comb, 1) <= 40 });
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = fmt(fi, 1) + " + " + fmt(ei, 1) + " = " + fmt(comb, 1) + "% (limit 40%)";
      return out;
    },
  },

  // Round 196 — the user asked for flakiness and elongation as SEPARATE tests,
  // matching their two paper forms (QC-04 and QC-03). IS 383:2016 limits the
  // two together (combined index ≤ 40%), so each card looks for its partner:
  // the server passes the partner card's index in ctx.companion (same GRN
  // first, else the same supplier's latest within 60 days). With a partner the
  // card is judged on the combined figure; without one it is judged on its own
  // index against 40% and says the combined check is still to come — whichever
  // of the two is filed second carries the combined verdict.
  flakiness: indexTest({
    code: "flakiness", label: "Flakiness index", short: "Flakiness index", form: "OORM-QC-04",
    field: "flaky", fieldLabel: "Wt. of fraction passing thickness gauge", other: "elongation", otherLabel: "elongation",
    rest: "Non-flaky (P.C passing)",
  }),
  elongation: indexTest({
    code: "elongation", label: "Elongation index", short: "Elongation index", form: "OORM-QC-03",
    field: "elong", fieldLabel: "Wt. of fraction retained on length gauge", other: "flakiness", otherLabel: "flakiness",
    rest: "Not elongated (P.C passing)",
  }),

  impact: {
    code: "impact",
    label: "Aggregate impact value",
    short: "Impact value",
    form: "OORM-QC-15",
    method: "IS 2386 (Part 4):1963",
    spec: "IS 383:2016, cl 5.4.2",
    kinds: ["coarse"],
    layout: "trials",
    trials: 3,
    params: [
      { key: "use", label: "Concrete use", default: "general", options: [["general", "Other than wearing surfaces (≤ 45%)"], ["wearing", "Wearing surfaces (≤ 30%)"]] },
    ],
    fields: [
      { key: "w1", label: "Oven-dry sample passing 12.5 mm, retained 10 mm (W1)", unit: "g", input: true },
      { key: "w2", label: "Retained on 2.36 mm after test (W2)", unit: "g", input: true },
      { key: "w3", label: "Passing 2.36 mm after test (W3)", unit: "g", input: true },
      { key: "aiv", label: "AIV = W3 / W1 × 100", unit: "%", dp: 1 },
    ],
    compute(readings, params) {
      const out = blank();
      const lim = params && params.use === "wearing" ? 30 : 45;
      const vals = [];
      for (const k of trialKeys(3)) {
        const w1 = g(readings, k, "w1");
        const w2 = g(readings, k, "w2");
        const w3 = g(readings, k, "w3");
        if (w1 === null || w3 === null) continue;
        if (w1 <= 0) continue;
        const aiv = (w3 / w1) * 100;
        out.cells[k] = { aiv: rnd(aiv, 1) };
        vals.push(aiv);
        if (w2 !== null && Math.abs(w1 - (w2 + w3)) > 1) {
          out.warnings.push("Trial " + k.slice(1) + ": W2 + W3 differs from W1 by more than 1 g — IS 2386 (Part 4) says discard that trial and repeat.");
        }
      }
      if (vals.length < 2) { out.errors.push("Enter at least two trials (IS 2386 reports the mean of two)."); return out; }
      const a = avg(vals);
      out.results.push({ label: "Average AIV", value: rnd(a, 1), unit: "%", dp: 1, limit: "≤ " + lim + "%", ok: rnd(a, 1) <= lim });
      out.verdict = decide(out.results);
      out.summary = fmt(a, 1) + "% (limit " + lim + "%)";
      return out;
    },
  },

  water_abs_coarse: {
    code: "water_abs_coarse",
    label: "Water absorption of coarse aggregate",
    short: "Water absorption",
    form: "OORM-QC-11",
    method: "IS 2386 (Part 3):1963",
    spec: "IS 383:2016 — not specified; used in mix design",
    kinds: ["coarse"],
    layout: "trials",
    trials: 2,
    fields: [
      { key: "a", label: "Saturated surface-dry sample (A)", unit: "g", input: true },
      { key: "b", label: "Oven-dried sample (B)", unit: "g", input: true },
      { key: "wa", label: "Water absorption = (A − B) / B × 100", unit: "%", dp: 2 },
    ],
    compute(readings) {
      return absorption(readings);
    },
  },

  // Round 196 — specific gravity and water absorption of fine aggregate are
  // two separate tests now (user's request); coarse aggregate gets its own
  // specific gravity test on the same pycnometer form (OORM-QC-10).
  sg_fine: sgTest({ code: "sg_fine", label: "Specific gravity of fine aggregate", kinds: ["fine"] }),
  sg_coarse: sgTest({ code: "sg_coarse", label: "Specific gravity of coarse aggregate", kinds: ["coarse"] }),

  water_abs_fine: {
    code: "water_abs_fine",
    label: "Water absorption of fine aggregate",
    short: "Water absorption",
    form: null,
    method: "IS 2386 (Part 3):1963",
    spec: "IS 383:2016 — not specified; used in mix design",
    kinds: ["fine"],
    layout: "trials",
    trials: 2,
    fields: [
      { key: "a", label: "Saturated surface-dry sample (A)", unit: "g", input: true },
      { key: "b", label: "Oven-dried sample (D)", unit: "g", input: true },
      { key: "wa", label: "Water absorption = (A − D) / D × 100", unit: "%", dp: 2 },
    ],
    compute(readings) {
      return absorption(readings);
    },
  },

  bulk_density: {
    code: "bulk_density",
    label: "Bulk density (loose & rodded)",
    short: "Bulk density",
    form: "OORM-QC-18",
    method: "IS 2386 (Part 3):1963",
    spec: "IS 383:2016 — not specified; used in mix design",
    kinds: ["coarse", "fine"],
    layout: "trials",
    trials: 3,
    fields: [
      { key: "w1", label: "Empty cylinder (W1)", unit: "kg", input: true },
      { key: "w2", label: "Cylinder + loose sample (W2)", unit: "kg", input: true },
      { key: "w3", label: "Cylinder + compacted sample (W3)", unit: "kg", input: true },
      { key: "v", label: "Volume of cylinder (V)", unit: "litre", input: true },
      { key: "loose", label: "Loose bulk density = (W2 − W1) / V", unit: "kg/l", dp: 3 },
      { key: "rodded", label: "Rodded bulk density = (W3 − W1) / V", unit: "kg/l", dp: 3 },
    ],
    compute(readings) {
      const out = blank();
      const L = [], R = [];
      for (const k of trialKeys(3)) {
        const w1 = g(readings, k, "w1"), w2 = g(readings, k, "w2"), w3 = g(readings, k, "w3"), v = g(readings, k, "v");
        if ([w1, w2, w3, v].some((x) => x === null) || v <= 0) continue;
        if (w2 < w1 || w3 < w1) { out.errors.push("Trial " + k.slice(1) + ": a filled cylinder weighs less than the empty one."); continue; }
        const lo = (w2 - w1) / v, ro = (w3 - w1) / v;
        out.cells[k] = { loose: rnd(lo, 3), rodded: rnd(ro, 3) };
        L.push(lo); R.push(ro);
        if (ro < lo) out.warnings.push("Trial " + k.slice(1) + ": rodded density is lower than loose — check W3.");
      }
      if (!L.length) { out.errors.push("Enter at least one complete trial."); return out; }
      out.results.push({ label: "Average loose bulk density", value: rnd(avg(L), 2), unit: "kg/l", dp: 2, ok: null });
      out.results.push({ label: "Average rodded bulk density", value: rnd(avg(R), 2), unit: "kg/l", dp: 2, ok: null });
      if (out.errors.length) return out;
      out.verdict = "recorded";
      out.summary = "Loose " + fmt(avg(L), 2) + " · rodded " + fmt(avg(R), 2) + " kg/l";
      return out;
    },
  },

  moisture: {
    code: "moisture",
    label: "Moisture content (batch water correction)",
    short: "Moisture content",
    form: "OORM-QC-14",
    method: "IS 2386 (Part 3):1963",
    spec: "Used for water correction at batching",
    kinds: ["fine", "coarse"],
    layout: "rows",
    fields: [
      { key: "time", label: "Time", input: true, type: "text" },
      { key: "w1", label: "Wet aggregate (W1)", unit: "g", input: true },
      { key: "w2", label: "Dry aggregate (W2)", unit: "g", input: true },
      { key: "w3", label: "Water W3 = W1 − W2", unit: "g", dp: 1 },
      { key: "mc", label: "Water content = W3 / W2 × 100", unit: "%", dp: 2 },
    ],
    rows() {
      return [1, 2, 3, 4].map((i) => ({ key: "r" + i, label: "Reading " + i }));
    },
    compute(readings) {
      const out = blank();
      const vals = [];
      let last = null;
      for (const r of this.rows()) {
        const w1 = g(readings, r.key, "w1"), w2 = g(readings, r.key, "w2");
        if (w1 === null || w2 === null || w2 <= 0) continue;
        if (w2 > w1) { out.errors.push(r.label + ": the dry weight is more than the wet weight."); continue; }
        const mc = ((w1 - w2) / w2) * 100;
        out.cells[r.key] = { w3: rnd(w1 - w2, 1), mc: rnd(mc, 2) };
        vals.push(mc);
        last = { mc, time: readings && readings.grid && readings.grid[r.key] ? readings.grid[r.key].time : "" };
      }
      if (!vals.length) { out.errors.push("Enter at least one reading."); return out; }
      out.results.push({ label: "Latest moisture content", value: rnd(last.mc, 2), unit: "%", dp: 2, ok: null, note: last.time ? "at " + last.time : "" });
      if (vals.length > 1) out.results.push({ label: "Average of the day", value: rnd(avg(vals), 2), unit: "%", dp: 2, ok: null });
      if (out.errors.length) return out;
      out.verdict = "recorded";
      out.summary = fmt(last.mc, 2) + "%" + (last.time ? " at " + last.time : "") + (vals.length > 1 ? " · " + vals.length + " readings" : "");
      return out;
    },
  },

  cement_fineness: {
    code: "cement_fineness",
    label: "Fineness of cement",
    short: "Fineness",
    form: "OORM-QC-02",
    method: "IS 4031 (Part 1):1996 sieve · IS 4031 (Part 2) Blaine",
    spec: "IS 269:2015 — Blaine ≥ 225 m²/kg; 90 µm residue ≤ 10% as a plant check",
    kinds: ["cement"],
    layout: "trials",
    trials: 2,
    head: [{ key: "blaine", label: "Specific surface by Blaine, if tested", unit: "m²/kg", type: "number" }],
    fields: [
      { key: "w", label: "Weight of sample", unit: "g", input: true },
      { key: "r", label: "Retained on 90 µm sieve", unit: "g", input: true },
      { key: "pct", label: "% retained", unit: "%", dp: 1 },
    ],
    compute(readings) {
      const out = blank();
      const vals = [];
      for (const k of trialKeys(2)) {
        const w = g(readings, k, "w"), r = g(readings, k, "r");
        if (w === null || r === null || w <= 0) continue;
        if (r > w) { out.errors.push("Trial " + k.slice(1) + ": retained weight is more than the sample."); continue; }
        const pct = (r / w) * 100;
        out.cells[k] = { pct: rnd(pct, 1) };
        vals.push(pct);
      }
      const blaine = n(h(readings, "blaine"));
      if (!vals.length && blaine === null) { out.errors.push("Enter the sieve trials, the Blaine figure, or both."); return out; }
      if (vals.length) out.results.push({ label: "Residue on 90 µm (plant check)", value: rnd(avg(vals), 1), unit: "%", dp: 1, limit: "≤ 10%", ok: rnd(avg(vals), 1) <= 10 });
      if (blaine !== null) out.results.push({ label: "Specific surface (Blaine)", value: rnd(blaine, 0), unit: "m²/kg", dp: 0, limit: "≥ 225", ok: blaine >= 225 });
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = [vals.length ? fmt(avg(vals), 1) + "% on 90 µm" : null, blaine !== null ? "Blaine " + fmt(blaine, 0) + " m²/kg" : null].filter(Boolean).join(" · ");
      return out;
    },
  },

  cement_setting: {
    code: "cement_setting",
    label: "Standard consistency & setting time of cement",
    short: "Setting time",
    form: null,
    method: "IS 4031 (Part 4) & (Part 5):1988",
    spec: "IS 269:2015 — initial ≥ 30 min, final ≤ 600 min",
    kinds: ["cement"],
    layout: "trials",
    trials: 1,
    fields: [
      { key: "cons", label: "Standard consistency (water %)", unit: "%", input: true },
      { key: "ist", label: "Initial setting time", unit: "min", input: true },
      { key: "fst", label: "Final setting time", unit: "min", input: true },
    ],
    compute(readings) {
      const out = blank();
      const cons = g(readings, "t1", "cons"), ist = g(readings, "t1", "ist"), fst = g(readings, "t1", "fst");
      if (ist === null || fst === null) { out.errors.push("Enter both setting times."); return out; }
      if (fst < ist) out.errors.push("The final setting time cannot be before the initial.");
      if (cons !== null) out.results.push({ label: "Standard consistency", value: rnd(cons, 1), unit: "%", dp: 1, ok: null });
      out.results.push({ label: "Initial setting time", value: rnd(ist, 0), unit: "min", dp: 0, limit: "≥ 30", ok: ist >= 30 });
      out.results.push({ label: "Final setting time", value: rnd(fst, 0), unit: "min", dp: 0, limit: "≤ 600", ok: fst <= 600 });
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = "Initial " + fmt(ist, 0) + " · final " + fmt(fst, 0) + " min";
      return out;
    },
  },

  cement_soundness: {
    code: "cement_soundness",
    label: "Soundness of cement (Le Chatelier)",
    short: "Soundness",
    form: null,
    method: "IS 4031 (Part 3):1988",
    spec: "IS 269:2015 — Le Chatelier ≤ 10 mm, autoclave ≤ 0.8%",
    kinds: ["cement"],
    layout: "trials",
    trials: 2,
    head: [{ key: "autoclave", label: "Autoclave expansion, if tested", unit: "%", type: "number" }],
    fields: [
      { key: "d1", label: "Distance between pointers before boiling", unit: "mm", input: true },
      { key: "d2", label: "Distance after boiling", unit: "mm", input: true },
      { key: "exp", label: "Expansion", unit: "mm", dp: 1 },
    ],
    compute(readings) {
      const out = blank();
      const vals = [];
      for (const k of trialKeys(2)) {
        const d1 = g(readings, k, "d1"), d2 = g(readings, k, "d2");
        if (d1 === null || d2 === null) continue;
        const e = d2 - d1;
        out.cells[k] = { exp: rnd(e, 1) };
        vals.push(e);
      }
      if (!vals.length) { out.errors.push("Enter at least one mould."); return out; }
      out.results.push({ label: "Le Chatelier expansion", value: rnd(avg(vals), 1), unit: "mm", dp: 1, limit: "≤ 10 mm", ok: rnd(avg(vals), 1) <= 10 });
      const ac = n(h(readings, "autoclave"));
      if (ac !== null) out.results.push({ label: "Autoclave expansion", value: rnd(ac, 2), unit: "%", dp: 2, limit: "≤ 0.8%", ok: ac <= 0.8 });
      out.verdict = decide(out.results);
      out.summary = fmt(avg(vals), 1) + " mm expansion";
      return out;
    },
  },

  cement_strength: {
    code: "cement_strength",
    label: "Compressive strength of cement (mortar cubes)",
    short: "Cement strength",
    form: null,
    method: "IS 4031 (Part 6):1988",
    spec: "IS 269:2015 — by grade at 3 / 7 / 28 days",
    kinds: ["cement"],
    layout: "rows",
    params: [{ key: "grade", label: "Cement grade", default: "53", options: [["53", "OPC 53"], ["43", "OPC 43"], ["33", "OPC 33"]] }],
    head: [
      { key: "cast_date", label: "Date the cubes were cast", type: "date" },
      { key: "area", label: "Cube face area", unit: "mm²", type: "number", placeholder: "5000" },
    ],
    fields: [
      { key: "due", label: "Due on", text: true },
      { key: "c1", label: "Cube 1 load", unit: "kN", input: true },
      { key: "c2", label: "Cube 2 load", unit: "kN", input: true },
      { key: "c3", label: "Cube 3 load", unit: "kN", input: true },
      { key: "mpa", label: "Average strength", unit: "MPa", dp: 1 },
      { key: "lim", label: "IS limit", text: true },
    ],
    rows() {
      return [3, 7, 28].map((d) => ({ key: "a" + d, label: d + " days", age: d }));
    },
    compute(readings, params) {
      const out = blank();
      const LIM = { 53: [27, 37, 53], 43: [23, 33, 43], 33: [16, 22, 33] };
      const grade = String((params && params.grade) || "53");
      const lims = LIM[grade] || LIM[53];
      const cast = h(readings, "cast_date");
      const area = n(h(readings, "area")) || 5000;
      if (!cast) out.errors.push("Enter the date the cubes were cast.");
      let missing = 0;
      this.rows().forEach((r, i) => {
        const loads = ["c1", "c2", "c3"].map((c) => g(readings, r.key, c)).filter((x) => x !== null && x > 0);
        const cell = { due: addDays(cast, r.age) || "—", lim: "≥ " + lims[i] };
        if (loads.length) {
          const mpa = avg(loads.map((kn) => (kn * 1000) / area));
          cell.mpa = rnd(mpa, 1);
          out.results.push({ label: r.label + " strength", value: rnd(mpa, 1), unit: "MPa", dp: 1, limit: "≥ " + lims[i], ok: rnd(mpa, 1) >= lims[i] });
          if (loads.length < 3) out.warnings.push(r.label + ": only " + loads.length + " of 3 cubes entered.");
        } else {
          missing++;
        }
        out.cells[r.key] = cell;
      });
      if (missing) out.errors.push(missing === 3 ? "No cubes crushed yet." : "Enter every age before submitting (" + missing + " still to test).");
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = "OPC " + grade + ": " + out.results.map((r) => fmt(r.value, 1)).join(" / ") + " MPa";
      return out;
    },
  },

  admixture: {
    code: "admixture",
    label: "Admixture uniformity check (old)",
    short: "Admixture check",
    retired: true,
    form: null,
    method: "IS 9103:1999",
    spec: "IS 9103 — against the supplier's declared values",
    kinds: ["admixture"],
    layout: "trials",
    trials: 1,
    fields: [
      { key: "rd_m", label: "Relative density — measured", input: true },
      { key: "rd_d", label: "Relative density — declared by supplier", input: true },
      { key: "ds_m", label: "Dry material content — measured", unit: "%", input: true },
      { key: "ds_d", label: "Dry material content — declared", unit: "%", input: true },
      { key: "ph", label: "pH", input: true },
    ],
    compute(readings) {
      const out = blank();
      const rm = g(readings, "t1", "rd_m"), rdd = g(readings, "t1", "rd_d");
      const dm = g(readings, "t1", "ds_m"), dd = g(readings, "t1", "ds_d"), ph = g(readings, "t1", "ph");
      if (rm !== null && rdd !== null) out.results.push({ label: "Relative density", value: rnd(rm, 3), dp: 3, limit: "declared " + rdd + " ± 0.02", ok: Math.abs(rm - rdd) <= 0.02 + 1e-9 });
      if (dm !== null && dd !== null) out.results.push({ label: "Dry material content", value: rnd(dm, 2), unit: "%", dp: 2, limit: "declared " + dd + "% ± 5%", ok: Math.abs(dm - dd) <= dd * 0.05 + 1e-9 });
      if (ph !== null) out.results.push({ label: "pH", value: rnd(ph, 1), dp: 1, limit: "≥ 6", ok: ph >= 6 });
      if (!out.results.length) { out.errors.push("Enter at least one measured value with its declared figure."); return out; }
      out.verdict = decide(out.results);
      out.summary = out.results.map((r) => r.label + " " + r.value).join(" · ");
      return out;
    },
  },

  // Round 196 — specific gravity and solid content of admixture as their own
  // tests (user's request), each against the supplier's declared value.
  admix_sg: {
    code: "admix_sg",
    label: "Specific gravity of admixture",
    short: "Admixture SG",
    form: null,
    method: "IS 9103:1999 (density bottle)",
    spec: "IS 9103 — within ± 0.02 of the value declared by the supplier",
    kinds: ["admixture"],
    layout: "trials",
    trials: 2,
    head: [{ key: "declared", label: "Specific gravity declared by the supplier", type: "number" }],
    fields: [
      { key: "w1", label: "Empty density bottle (W1)", unit: "g", input: true },
      { key: "w2", label: "Bottle + admixture (W2)", unit: "g", input: true },
      { key: "w3", label: "Bottle + water (W3)", unit: "g", input: true },
      { key: "sg", label: "Specific gravity = (W2 − W1) / (W3 − W1)", dp: 3 },
    ],
    compute(readings) {
      const out = blank();
      const vals = [];
      for (const k of trialKeys(2)) {
        const w1 = g(readings, k, "w1"), w2 = g(readings, k, "w2"), w3 = g(readings, k, "w3");
        if (w1 === null || w2 === null || w3 === null) continue;
        if (w3 <= w1 || w2 <= w1) { out.errors.push("Trial " + k.slice(1) + ": a filled bottle weighs no more than the empty one."); continue; }
        const sg = (w2 - w1) / (w3 - w1);
        out.cells[k] = { sg: rnd(sg, 3) };
        vals.push(sg);
      }
      if (!vals.length) { out.errors.push("Enter at least one trial."); return out; }
      const a = avg(vals);
      const dec = n(h(readings, "declared"));
      if (dec === null) out.errors.push("Enter the specific gravity the supplier declares.");
      out.results.push({ label: "Specific gravity", value: rnd(a, 3), dp: 3, limit: dec === null ? "declared ± 0.02" : dec + " ± 0.02", ok: dec === null ? null : Math.abs(rnd(a, 3) - dec) <= 0.02 + 1e-9 });
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = fmt(a, 3) + " (declared " + dec + ")";
      return out;
    },
  },

  admix_solids: {
    code: "admix_solids",
    label: "Solid content of admixture",
    short: "Admixture solids",
    form: null,
    method: "IS 9103:1999 (dry material content, oven at 105 °C)",
    spec: "IS 9103 — within ± 5% of the value declared by the supplier",
    kinds: ["admixture"],
    layout: "trials",
    trials: 2,
    head: [{ key: "declared", label: "Solid content declared by the supplier", unit: "%", type: "number" }],
    fields: [
      { key: "w1", label: "Empty dish (W1)", unit: "g", input: true },
      { key: "w2", label: "Dish + admixture before drying (W2)", unit: "g", input: true },
      { key: "w3", label: "Dish + residue after drying (W3)", unit: "g", input: true },
      { key: "pct", label: "Solid content = (W3 − W1) / (W2 − W1) × 100", unit: "%", dp: 2 },
    ],
    compute(readings) {
      const out = blank();
      const vals = [];
      for (const k of trialKeys(2)) {
        const w1 = g(readings, k, "w1"), w2 = g(readings, k, "w2"), w3 = g(readings, k, "w3");
        if (w1 === null || w2 === null || w3 === null) continue;
        if (w2 <= w1) { out.errors.push("Trial " + k.slice(1) + ": dish + admixture must weigh more than the empty dish."); continue; }
        if (w3 < w1 || w3 > w2) { out.errors.push("Trial " + k.slice(1) + ": the dried weight must lie between the empty dish and the wet weight."); continue; }
        const pct = ((w3 - w1) / (w2 - w1)) * 100;
        out.cells[k] = { pct: rnd(pct, 2) };
        vals.push(pct);
      }
      if (!vals.length) { out.errors.push("Enter at least one trial."); return out; }
      const a = avg(vals);
      const dec = n(h(readings, "declared"));
      if (dec === null) out.errors.push("Enter the solid content the supplier declares.");
      const lo = dec === null ? null : dec * 0.95, hi = dec === null ? null : dec * 1.05;
      out.results.push({ label: "Solid content", value: rnd(a, 2), unit: "%", dp: 2, limit: dec === null ? "declared ± 5%" : fmt(lo, 2) + " – " + fmt(hi, 2) + "% (declared " + dec + "%)", ok: dec === null ? null : rnd(a, 2) >= rnd(lo, 2) && rnd(a, 2) <= rnd(hi, 2) });
      if (out.errors.length) return out;
      out.verdict = decide(out.results);
      out.summary = fmt(a, 2) + "% (declared " + dec + "%)";
      return out;
    },
  },

  // Round 196 — the lab's daily curing tank log (IS 516: water at 27 ± 2 °C),
  // from the plant's own monitoring sheet. Not a raw material: its plan and
  // cards carry no material (material_id NULL) and it is always scheduled.
  curing_temp: {
    code: "curing_temp",
    label: "Curing tank water temperature",
    short: "Curing tank temperature",
    form: null,
    method: "IS 516 (Part 1)",
    spec: "Curing water 27 ± 2 °C",
    kinds: ["lab"],
    layout: "rows",
    fields: [
      { key: "time", label: "Time", input: true, type: "text" },
      { key: "t1", label: "Tank 1", unit: "°C", input: true },
      { key: "t2", label: "Tank 2", unit: "°C", input: true },
      { key: "t3", label: "Tank 3", unit: "°C", input: true },
      { key: "chk", label: "Check", text: true },
    ],
    rows() {
      return [1, 2, 3].map((i) => ({ key: "r" + i, label: "Reading " + i }));
    },
    compute(readings) {
      const out = blank();
      let count = 0, worst = null;
      for (const r of this.rows()) {
        const temps = ["t1", "t2", "t3"].map((t) => [t, g(readings, r.key, t)]).filter(([, v]) => v !== null);
        if (!temps.length) continue;
        let ok = true;
        for (const [t, v] of temps) {
          count++;
          if (v < 25 || v > 29) {
            ok = false;
            if (!worst || Math.abs(v - 27) > Math.abs(worst.v - 27)) worst = { v, tank: t.slice(1), row: r.label };
          }
        }
        out.cells[r.key] = { chk: ok ? "Within" : "Outside" };
      }
      if (!count) { out.errors.push("Enter at least one temperature."); return out; }
      out.results.push({ label: "Readings taken", value: count, dp: 0, ok: null });
      out.results.push({ label: "All within 27 ± 2 °C", value: worst ? "No — tank " + worst.tank + " at " + worst.v + " °C" : "Yes", text: true, limit: "25 – 29 °C", ok: !worst });
      out.verdict = worst ? "non_conforming" : "conforms";
      out.summary = worst ? "Tank " + worst.tank + " at " + worst.v + " °C (" + worst.row.toLowerCase() + ") — outside 27 ± 2 °C" : count + " readings within 27 ± 2 °C";
      return out;
    },
  },

  external: {
    code: "external",
    label: "External laboratory test",
    short: "External lab",
    form: null,
    method: "As per the external laboratory's certificate",
    spec: "See certificate",
    kinds: ["coarse", "fine", "cement", "admixture", "lab", "any"],
    layout: "none",
    params: [
      { key: "name", label: "Test", default: "Los Angeles abrasion value", free: true },
      { key: "limit", label: "Limit (as printed on reports)", default: "", free: true },
    ],
    head: [
      { key: "lab", label: "Laboratory", type: "text" },
      { key: "cert", label: "Certificate no.", type: "text" },
      { key: "result", label: "Result", type: "text" },
      { key: "verdict", label: "Verdict", type: "select", options: [["conforms", "Conforms"], ["non_conforming", "Does not conform"], ["recorded", "Recorded (no limit)"]] },
    ],
    fields: [],
    compute(readings, params) {
      const out = blank();
      const res = String(h(readings, "result") || "").trim();
      const v = h(readings, "verdict");
      if (!String(h(readings, "lab") || "").trim()) out.errors.push("Enter the laboratory.");
      if (!res) out.errors.push("Enter the result from the certificate.");
      if (!["conforms", "non_conforming", "recorded"].includes(v)) out.errors.push("Choose the verdict.");
      if (res) out.results.push({ label: (params && params.name) || "Result", value: res, text: true, limit: (params && params.limit) || null, ok: v === "conforms" ? true : v === "non_conforming" ? false : null });
      if (out.errors.length) return out;
      out.verdict = v;
      out.summary = res + (h(readings, "cert") ? " · cert " + h(readings, "cert") : "");
      return out;
    },
  },
};

// Offered for new plans and cards, in screen order. Retired tests are left out.
export const TEST_ORDER = [
  "sieve_coarse", "flakiness", "elongation", "impact", "sg_coarse", "water_abs_coarse", "bulk_density", "fines_75",
  "sieve_fine", "sg_fine", "water_abs_fine", "moisture",
  "cement_fineness", "cement_setting", "cement_soundness", "cement_strength",
  "admix_sg", "admix_solids", "curing_temp", "external",
];

// The test whose result completes this one's limit (flakiness <-> elongation).
export function companionOf(code) {
  return TEST_DEFS[code] && TEST_DEFS[code].companion ? TEST_DEFS[code].companion : null;
}

export function testLabel(code, params) {
  const d = TEST_DEFS[code];
  if (!d) return code;
  if (code === "external" && params && params.name) return params.name + " (external lab)";
  return d.label;
}

export function defaultParams(code) {
  const d = TEST_DEFS[code];
  const out = {};
  for (const p of (d && d.params) || []) out[p.key] = p.default;
  return out;
}

// Rows the screen draws for a test: trial columns for "trials", the def's own
// rows for "rows", nothing for "none".
export function rowsFor(code, params) {
  const d = TEST_DEFS[code];
  if (!d) return [];
  if (d.layout === "trials") return trialRows(d.trials || 1);
  if (d.layout === "rows") return d.rows(params || defaultParams(code));
  return [];
}

export function computeTest(code, readings, params, ctx) {
  const d = TEST_DEFS[code];
  if (!d) return { ...blank(), errors: ["Unknown test."] };
  try {
    return d.compute(readings || { head: {}, grid: {} }, { ...defaultParams(code), ...(params || {}) }, ctx || {});
  } catch (e) {
    return { ...blank(), errors: ["Could not calculate: " + (e && e.message ? e.message : e)] };
  }
}

export const VERDICT_LABEL = {
  conforms: "Conforms",
  non_conforming: "Does not conform",
  recorded: "Recorded",
};

// How a plan decides when to hand out a card.
export const TRIGGERS = [
  ["every_grn", "Every GRN (each truck)"],
  ["period", "First GRN per supplier in the period"],
  ["scheduled", "Scheduled (not tied to a purchase)"],
  ["off", "Off"],
];
export const PERIODS = [
  [1, "Daily"], [7, "Weekly"], [14, "Every 2 weeks"], [30, "Monthly"], [91, "3-monthly"],
  [182, "6-monthly"], [365, "Yearly"], [1826, "5-yearly"],
];
export function periodLabel(days) {
  const p = PERIODS.find(([d]) => Number(d) === Number(days));
  return p ? p[1] : days ? "Every " + days + " days" : "—";
}

// What a material gets when its plan is loaded from the standard, keyed by
// rm_materials.mix_component. Frequencies are the IS 4926:2003 Annex B
// minimums (high rate, then low rate once `low_after` results in a row
// conform); cement and admixture are per consignment, the usual RMC practice.
export const STANDARD_PLANS = {
  // Not a material: the lab's own daily checks (plan with no material).
  lab: [
    { test_code: "curing_temp", params: {}, trigger: "scheduled", high_days: 1, low_days: null, low_after: null, due_hours: 12 },
  ],
  coarse_20mm: [
    { test_code: "sieve_coarse", params: { grading: "20s" }, trigger: "period", high_days: 7, low_days: 30, low_after: 8, due_hours: 24 },
    { test_code: "flakiness", params: {}, trigger: "period", high_days: 14, low_days: 182, low_after: 3, due_hours: 48 },
    { test_code: "elongation", params: {}, trigger: "period", high_days: 14, low_days: 182, low_after: 3, due_hours: 48 },
    { test_code: "impact", params: { use: "general" }, trigger: "period", high_days: 30, low_days: null, low_after: null, due_hours: 48 },
    { test_code: "sg_coarse", params: { min: "2.6", basis: "od" }, trigger: "period", high_days: 7, low_days: 91, low_after: 4, due_hours: 72 },
    { test_code: "water_abs_coarse", params: {}, trigger: "period", high_days: 7, low_days: 91, low_after: 4, due_hours: 72 },
    { test_code: "bulk_density", params: {}, trigger: "period", high_days: 30, low_days: 182, low_after: 4, due_hours: 72 },
    { test_code: "fines_75", params: { kind: "coarse_crushed" }, trigger: "period", high_days: 30, low_days: 91, low_after: 4, due_hours: 72 },
    { test_code: "external", params: { name: "Los Angeles abrasion value", limit: "≤ 50% (≤ 30% wearing surfaces)" }, trigger: "period", high_days: 365, low_days: null, low_after: null, due_hours: 336, hold_stock: true },
    { test_code: "external", params: { name: "Soundness (sodium sulphate)", limit: "≤ 12% loss" }, trigger: "period", high_days: 365, low_days: null, low_after: null, due_hours: 336, hold_stock: true },
  ],
  coarse_12_5mm: [
    { test_code: "sieve_coarse", params: { grading: "12.5s" }, trigger: "period", high_days: 7, low_days: 30, low_after: 8, due_hours: 24 },
    { test_code: "flakiness", params: {}, trigger: "period", high_days: 14, low_days: 182, low_after: 3, due_hours: 48 },
    { test_code: "elongation", params: {}, trigger: "period", high_days: 14, low_days: 182, low_after: 3, due_hours: 48 },
    { test_code: "impact", params: { use: "general" }, trigger: "period", high_days: 30, low_days: null, low_after: null, due_hours: 48 },
    { test_code: "sg_coarse", params: { min: "2.6", basis: "od" }, trigger: "period", high_days: 7, low_days: 91, low_after: 4, due_hours: 72 },
    { test_code: "water_abs_coarse", params: {}, trigger: "period", high_days: 7, low_days: 91, low_after: 4, due_hours: 72 },
    { test_code: "bulk_density", params: {}, trigger: "period", high_days: 30, low_days: 182, low_after: 4, due_hours: 72 },
    { test_code: "external", params: { name: "Soundness (sodium sulphate)", limit: "≤ 12% loss" }, trigger: "period", high_days: 365, low_days: null, low_after: null, due_hours: 336, hold_stock: true },
  ],
  fine_agg: [
    { test_code: "sieve_fine", params: { sand: "crushed" }, trigger: "period", high_days: 7, low_days: 30, low_after: 8, due_hours: 24 },
    { test_code: "fines_75", params: { kind: "fine_crushed" }, trigger: "period", high_days: 30, low_days: 91, low_after: 4, due_hours: 48 },
    { test_code: "sg_fine", params: { min: "2.6", basis: "od" }, trigger: "period", high_days: 7, low_days: 91, low_after: 4, due_hours: 72 },
    { test_code: "water_abs_fine", params: {}, trigger: "period", high_days: 7, low_days: 91, low_after: 4, due_hours: 72 },
    { test_code: "bulk_density", params: {}, trigger: "period", high_days: 30, low_days: 182, low_after: 4, due_hours: 72 },
    { test_code: "moisture", params: {}, trigger: "scheduled", high_days: 1, low_days: null, low_after: null, due_hours: 8 },
    { test_code: "external", params: { name: "Soundness (sodium sulphate)", limit: "≤ 10% loss" }, trigger: "period", high_days: 365, low_days: null, low_after: null, due_hours: 336, hold_stock: true },
  ],
  cement: [
    { test_code: "cement_fineness", params: {}, trigger: "every_grn", high_days: null, low_days: null, low_after: null, due_hours: 24 },
    { test_code: "cement_setting", params: {}, trigger: "every_grn", high_days: null, low_days: null, low_after: null, due_hours: 24 },
    { test_code: "cement_soundness", params: {}, trigger: "every_grn", high_days: null, low_days: null, low_after: null, due_hours: 48 },
    { test_code: "cement_strength", params: { grade: "53" }, trigger: "every_grn", high_days: null, low_days: null, low_after: null, due_hours: 696 },
  ],
  fly_ash: [
    { test_code: "external", params: { name: "Fly ash (IS 3812) properties", limit: "IS 3812 (Part 1)" }, trigger: "period", high_days: 91, low_days: null, low_after: null, due_hours: 336 },
  ],
  admixture: [
    { test_code: "admix_sg", params: {}, trigger: "every_grn", high_days: null, low_days: null, low_after: null, due_hours: 48 },
    { test_code: "admix_solids", params: {}, trigger: "every_grn", high_days: null, low_days: null, low_after: null, due_hours: 48 },
  ],
};
