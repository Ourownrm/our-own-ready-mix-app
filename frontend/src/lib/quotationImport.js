// Round 205 — reading the owner's quotations Excel (sheet "Quotations List")
// and matching it to the app's customers, sites and grades. Pure functions,
// so the screen and a test can use them alike.
//
// The sheet: a title, then a header row with "Quotation Number", "Date",
// "Customer", "Address Line 1", "Address Line 2", "GSTIN" (holds the state),
// "Project", "Grade n" / "Mix Spec n" / "Rate n" / "Qtyn" for n = 1…7, charges
// (usually empty), "Credit Period", "Credit Limit" (text like "10 Lakhs"),
// "Attention : [ Name ]", "Rebate", "Remarks". Rates include GST.

const pad = (n) => String(n).padStart(2, "0");

export function toYmd(v, XLSX) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && XLSX) {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

const num = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,₹\s/-]+$/g, "").replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// "10 Lakhs" → 1000000, "5 Lakh" → 500000, "2.5 L" → 250000, 300000 → 300000
export function parseAmount(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).toUpperCase().replace(/,/g, "");
  const m = s.match(/([\d.]+)\s*(LAKHS?|LACS?|L\b|CRORES?|CR\b)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] && m[2].startsWith("C")) return n * 1e7;
  if (m[2]) return n * 1e5;
  return n;
}

// Reads the sheet into plain rows. Returns { rows, sheet } or null.
export function readQuotationSheet(wb, XLSX) {
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    const h = aoa.findIndex((r) => r.some((c) => String(c).trim().toLowerCase() === "quotation number"));
    if (h < 0) continue;
    const head = aoa[h].map((c) => String(c).trim().toLowerCase());
    const col = (label) => head.indexOf(label.toLowerCase());
    const get = (r, label) => { const i = col(label); return i < 0 ? "" : r[i]; };
    const rows = [];
    for (const r of aoa.slice(h + 1)) {
      const no = String(get(r, "Quotation Number") || "").trim();
      if (!no) continue;
      const lines = [], notes = [];
      for (let i = 1; i <= 7; i++) {
        const grade = get(r, `Grade ${i}`), rate = num(get(r, `Rate ${i}`));
        // Empty slots (and the Excel's "0" left by its formulas) are not lines.
        const blankGrade = grade === "" || grade == null || String(grade).trim() === "0";
        // A "0" grade with a ₹1 rate is how the sheet carries a note under the
        // table ("rates applicable only for ULCCS trucks") — a special condition.
        const spec = String(get(r, `Mix Spec ${i}`) || "").trim();
        if (blankGrade && !(rate > 1)) { if (spec && spec !== "0") notes.push(spec); continue; }
        lines.push({ grade: String(grade ?? "").trim(), specification: String(get(r, `Mix Spec ${i}`) || "").trim(), rate_total: rate, qty_m3: num(get(r, `Qty${i}`)) });
      }
      rows.push({
        quote_no: no.toUpperCase(), quote_date: toYmd(get(r, "Date"), XLSX),
        customer: String(get(r, "Customer") || "").trim(),
        address: [get(r, "Address Line 1"), get(r, "Address Line 2"), get(r, "GSTIN")].map((x) => String(x || "").trim()).filter(Boolean).join(", "),
        project: String(get(r, "Project") || "").trim(),
        attention: String(get(r, "Attention : [ Name ]") || "").trim(),
        credit_days: num(get(r, "Credit Period")), credit_limit: parseAmount(get(r, "Credit Limit")),
        rebate: num(get(r, "Rebate")), remarks: String(get(r, "Remarks") ?? "").trim(),
        lines, notes,
      });
    }
    return { rows, sheet: name };
  }
  return null;
}

const STRIP = /\b(M\/S|MS|MR|MRS|ENGR|DR|PVT|PRIVATE|LTD|LIMITED|CO|COMPANY|THE|AND)\b/g;
export const normName = (s) => String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[.,()/\\-]/g, " ")
  .replace(STRIP, " ").replace(/[^A-Z0-9]/g, "");
// Round 230 — how alike two names are (mirrors backend lib/recordMerge.js):
// 1 = same once M/S, PVT, LTD … are dropped; 0.85 = one contains the other;
// 0.8 = every word of the shorter is in the longer; else the share of words
// in common. 0.6 and up is shown as "already in the app?".
const nameWords = (s) => new Set(String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[.,()/\\-]/g, " ")
  .replace(STRIP, " ").split(/[^A-Z0-9]+/).filter((w) => w.length >= 3));
export function nameScore(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return 0.85;
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 1 && common >= 1 ? 0.8 : common / Math.max(wa.size, wb.size);
}
export function lookAlikes(name, list, min = 0.6) {
  return list.map((x) => ({ ...x, score: nameScore(name, x.name) })).filter((x) => x.score >= min).sort((a, b) => b.score - a.score).slice(0, 4);
}

const normGrade = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");

function matchOne(name, list) {
  const n = normName(name);
  if (!n) return { exact: null, near: [] };
  const exact = list.find((x) => normName(x.name) === n) || null;
  if (exact) return { exact, near: [] };
  const near = list.filter((x) => { const m = normName(x.name); return m.length >= 4 && n.length >= 4 && (m.includes(n) || n.includes(m)); });
  return { exact: null, near };
}

// Builds the review rows. today = 'YYYY-MM-DD' (IST).
export function matchRows(raw, { customers, sites, grades, existing, today, historyDays = 60 }) {
  const existingSet = new Set((existing || []).map((x) => x.toUpperCase()));
  const gradeBy = new Map(grades.map((g) => [normGrade(g.name), g]));
  return raw.map((r, idx) => {
    const issues = [];
    const c = matchOne(r.customer, customers);
    let customerChoice;
    // Only an exact (normalised) name is taken as the same customer. A name
    // that merely contains another ("K K CONSTRUCTIONS" / "PKK Constructions")
    // stays a new customer, with the look-alikes offered first in the list —
    // merging two customers by mistake mixes their ledgers.
    if (c.exact) customerChoice = String(c.exact.id);
    else { customerChoice = "new"; if (c.near.length) issues.push(`Similar customer in the app: ${c.near.map((x) => `"${x.name}"`).join(", ")} — choose it if it is the same`); }
    const custSites = customerChoice === "new" ? [] : sites.filter((s) => String(s.customer_id) === customerChoice);
    const sm = matchOne(r.project, custSites);
    const siteChoice = sm.exact ? String(sm.exact.id) : sm.near.length === 1 ? String(sm.near[0].id) : "new";
    const lines = r.lines.map((l) => {
      const g = gradeBy.get(normGrade(l.grade));
      if (g) return { ...l, mix_grade_id: g.id, grade_name: g.name };
      const spec = l.specification.toUpperCase();
      if (/WATER\s*PROOF/.test(spec) || /WATER\s*PROOF/.test(l.grade.toUpperCase())) return { ...l, mix_grade_id: null, item_label: "Water proofing" };
      if (/FIB(ER|RE)/.test(spec) || /FIB(ER|RE)/.test(l.grade.toUpperCase())) return { ...l, mix_grade_id: null, item_label: "Fiber" };
      issues.push(`Grade "${l.grade || "(blank)"}" is not a grade in the app`);
      return { ...l, mix_grade_id: null, item_label: null, bad: true };
    });
    if (lines.some((l) => !(Number(l.rate_total) > 0))) issues.push("A line has no rate — it is left out");
    if (!lines.some((l) => l.mix_grade_id && Number(l.rate_total) > 0)) issues.push("No grade with a rate");
    const dupes = new Map();
    for (const l of lines.filter((x) => x.mix_grade_id)) dupes.set(l.mix_grade_id, (dupes.get(l.mix_grade_id) || 0) + 1);
    const twoPrices = [...dupes.values()].some((n) => n > 1);
    if (!r.quote_date) issues.push("No date");
    const age = r.quote_date ? Math.round((Date.parse(today) - Date.parse(r.quote_date)) / 86400000) : 999;
    const anyQty = lines.some((l) => Number(l.qty_m3) > 0);
    const type = r.credit_days ? (anyQty && r.rebate ? "credit_qty" : "credit") : anyQty && r.rebate ? "credit_qty" : "pay_after_delivery";
    return {
      key: `${r.quote_no}-${idx}`, ...r, lines,
      customer_choice: customerChoice, site_choice: siteChoice,
      agreement_type: type, status: age > historyDays ? "lost" : "sent", rates_from: r.quote_date,
      already: existingSet.has(r.quote_no), include: !existingSet.has(r.quote_no),
      two_prices: twoPrices, issues, near_customers: c.exact ? [] : c.near.map((x) => x.id),
    };
  });
}

// What the server receives for one reviewed row.
export function toPayload(row) {
  return {
    quote_no: row.quote_no, quote_date: row.quote_date,
    customer_id: row.customer_choice === "new" ? null : Number(row.customer_choice),
    new_customer: row.customer_choice === "new" ? { name: row.customer, address: row.address } : null,
    site_id: row.site_choice === "new" ? null : Number(row.site_choice),
    new_site: row.site_choice === "new" ? { name: row.project } : null,
    kind_attention: row.attention || null, agreement_type: row.agreement_type, status: row.status, rates_from: row.rates_from,
    payment: { ...(row.credit_days ? { credit_days: row.credit_days } : {}), ...(row.credit_limit ? { credit_limit: row.credit_limit } : {}) },
    rebate_per_m3: row.rebate || null,
    special_conditions: (row.notes || []).join("\n") || null,
    lines: row.lines.filter((l) => !l.bad && Number(l.rate_total) > 0).map((l) => ({
      mix_grade_id: l.mix_grade_id, item_label: l.item_label || null, specification: l.specification, qty_m3: l.qty_m3, rate_total: l.rate_total,
    })),
  };
}
