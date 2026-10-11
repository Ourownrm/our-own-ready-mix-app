// Round 204 — filling a quotation's terms from its charges and payment terms,
// and the GST-inclusive rate arithmetic. Shared by the builder's preview, the
// quotation view and the PDF so they can never say different things.
//
// Rates are entered INCLUDING GST (owner, 11 Oct 2026). Base = total × 100 /
// 118, GST = total − base.

export const GST_PCT = 18;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function splitRate(total) {
  const t = Number(total) || 0;
  const base = r2((t * 100) / (100 + GST_PCT));
  return { base, gst: r2(t - base), total: r2(t) };
}

export const inr = (n, dp = 0) =>
  n == null || n === "" || Number.isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const inr2 = (n) => inr(n, 2);

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const word = (n) => WORDS[Number(n)] || null;
const withWord = (n) => (word(n) ? `${n} (${word(n)})` : String(n));

export const AGREEMENT_TITLES = {
  price_only: "QUOTATION FOR READY MIX CONCRETE SUPPLY",
  default: "QUOTATION CUM AGREEMENT FOR READY MIX CONCRETE SUPPLY",
};

// The values every {placeholder} in the terms library can use.
export function termValues(q, defaults = {}) {
  const c = { ...(defaults.charges || {}), ...(q.charges || {}) };
  const p = { ...(defaults.payment || {}), ...(q.payment || {}) };
  const num = (v) => (v == null || v === "" ? "—" : inr(v));
  const v = {
    line_pump_min_qty: num(c.line_pump_min_qty),
    line_pump_charge: num(c.line_pump_charge),
    boom_min_charge: num(c.boom_min_charge),
    boom_min_qty: num(c.boom_min_qty),
    boom_above_text: Number(c.boom_rate_above) > 0
      ? `, for quantities above ${num(c.boom_min_qty)} cubic meter, an additional ₹${num(c.boom_rate_above)}/- per cubic meter will be charged as pumping charges.`
      : ".",
    part_load_min_qty: num(c.part_load_min_qty),
    part_load_rate: num(c.part_load_rate),
    waterproofing_text: c.waterproofing === "included"
      ? "Waterproofing Admixture is included in the quoted price"
      : Number(c.waterproofing_rate) > 0
        ? `Waterproofing Admixture can be added to concrete at ₹${num(c.waterproofing_rate)}/- per cubic meter`
        : "Waterproofing Admixture can be added to concrete with additional charge",
    fiber_text: c.fiber === "included"
      ? "Fiber is included in the quoted price"
      : Number(c.fiber_rate) > 0
        ? `Fiber can be added to concrete at ₹${num(c.fiber_rate)}/- per cubic meter`
        : "Fiber can be added to concrete with additional charge",
    waiting_rate: num(c.waiting_rate),
    waiting_free_hours_text: withWord(c.waiting_free_hours ?? 2),
    extra_cement_rate: num(c.extra_cement_rate),
    validity_text: withWord(q.validity_days ?? 7),   // the clause says "… for a period of {validity_text} days"
    dispute_hours: num(p.dispute_hours ?? 24),
    interest_pct: num(p.interest_pct ?? 18),
    credit_days: num(p.credit_days),
    credit_limit: num(p.credit_limit),
    rebate: num(q.rebate_per_m3),
  };
  return v;
}

export function fillText(text, values) {
  return String(text || "").replace(/\{([a-z_]+)\}/g, (m, k) => (values[k] != null ? values[k] : m));
}

// The terms as they will print: placeholders filled, the special
// conditions added as a last clause of their own.
export function filledTerms(q, defaults) {
  const terms = q.terms || { parties: [], sections: [], closing: [] };
  const v = termValues(q, defaults);
  const sections = (terms.sections || []).map((s) => ({
    ...s,
    clauses: (s.clauses || []).map((c) => ({ ...c, text: fillText(c.text, v) })),
  }));
  if (q.special_conditions && q.special_conditions.trim()) {
    const n = sections.length + 1;
    sections.push({
      no: terms.sections?.[0]?.no ? String(n) : "",
      title: "Special Conditions",
      clauses: q.special_conditions.split(/\n+/).map((t, i) => ({ no: terms.sections?.[0]?.no ? `${n}.${i + 1}` : String(i + 1), text: t.trim() })).filter((c) => c.text),
    });
  }
  return {
    parties: (terms.parties || []).map((t) => fillText(t, v)),
    sections,
    closing: (terms.closing || []).map((t) => fillText(t, v)),
  };
}

export const STATUS_LABEL = {
  draft: "Draft", pending_approval: "Waiting for approval", approved: "Approved — not sent", sent: "Sent",
  accepted: "Accepted", declined: "Declined", lost: "Lost", superseded: "Superseded", cancelled: "Cancelled",
};
export const STATUS_TONE = {
  draft: "slate", pending_approval: "amber", approved: "blue", sent: "blue", accepted: "green",
  declined: "red", lost: "red", superseded: "slate", cancelled: "slate",
};

export function fmtDate(ymd) {
  if (!ymd) return "—";
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d).padStart(2, "0")}-${MON[m - 1]}-${y}`;
}
