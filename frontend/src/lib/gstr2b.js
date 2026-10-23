// Round 236 — read the GSTR-2B Excel downloaded from the GST portal, in the
// browser. The B2B sheet has a two-row heading ("Tax Amount" over
// "Integrated Tax(₹)" …) and the invoices below it. Also reads a plain sheet
// with one heading row (GSTIN, invoice number, date, taxable, IGST, CGST, SGST).
const GSTIN = /^\d{2}[A-Z0-9]{13}$/;
const COLS = [
  ["gstin", /gstin/],
  ["trade_name", /trade|legal name|supplier name|name of supplier/],
  ["inv_no", /invoice (number|no)|inv(oice)? ?no|note number|document number/],
  ["inv_type", /invoice type|note type/],
  ["inv_date", /invoice date|note date|document date/],
  ["inv_value", /invoice value|note value/],
  ["taxable", /taxable/],
  ["igst", /integrated/],
  ["cgst", /central/],
  ["sgst", /state ?\/ ?ut|state tax|sgst/],
  ["cess", /cess/],
  ["rcm", /reverse charge/],
  ["itc", /itc availab/],
];
const low = (v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const amount = (v) => {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const x = Number(String(v).replace(/[₹,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
};
const pad = (n) => String(n).padStart(2, "0");
export function dateOf(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {   // Excel day number
    const d = new Date(Math.round((v - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})$/);
  if (m) {
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase());
    if (mon >= 0) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(mon + 1)}-${pad(m[1])}`;
  }
  return null;
}

// rows: an array of arrays (one sheet). Returns { lines, heading }.
export function readSheet(rows, kind = "inv") {
  const h = rows.findIndex((r) => (r || []).some((c) => /gstin/.test(low(c))));
  if (h < 0) return { lines: [], heading: false };
  // The heading may run over two rows (merged cells): join them per column.
  const width = Math.max(...rows.slice(h, h + 3).map((r) => (r || []).length));
  const top = [], bottom = rows[h + 1] || [];
  let last = "";
  for (let c = 0; c < width; c++) { const t = low(rows[h][c]); if (t) last = t; top.push(t || last); }
  const twoRows = bottom.some((c) => /integrated|central|state/.test(low(c))) && !bottom.some((c) => GSTIN.test(String(c || "").trim().toUpperCase()));
  const labels = top.map((t, c) => `${t} ${twoRows ? low(bottom[c]) : ""}`.trim());
  const col = {};
  for (const [k, re] of COLS) {
    // the first column whose own (lower) heading matches, else the joined one
    let i = twoRows ? bottom.findIndex((c) => re.test(low(c))) : -1;
    if (i < 0) i = labels.findIndex((l) => re.test(l));
    if (i >= 0 && !Object.values(col).includes(i)) col[k] = i;
  }
  if (col.gstin == null) return { lines: [], heading: false };
  const lines = [];
  for (const r of rows.slice(h + (twoRows ? 2 : 1))) {
    const g = String(r?.[col.gstin] ?? "").trim().toUpperCase();
    if (!GSTIN.test(g)) continue;
    const type = low(r[col.inv_type]);
    lines.push({
      gstin: g, trade_name: String(r[col.trade_name] ?? "").trim(), inv_no: String(r[col.inv_no] ?? "").trim(),
      inv_date: dateOf(r[col.inv_date]), inv_value: col.inv_value != null ? amount(r[col.inv_value]) : null,
      taxable: amount(r[col.taxable]), igst: amount(r[col.igst]), cgst: amount(r[col.cgst]), sgst: amount(r[col.sgst]), cess: amount(r[col.cess]),
      rcm: /^y/.test(low(r[col.rcm])), itc_ok: col.itc == null ? true : !/^n/.test(low(r[col.itc])),
      kind: kind === "cn" ? (/debit/.test(type) ? "dn" : "cn") : "inv",
    });
  }
  return { lines, heading: true };
}

// A whole workbook (from XLSX.read). B2B (and B2B-CDNR as notes) when there,
// else the first sheet with a GSTIN heading.
export function readGstr2b(XLSX, wb) {
  const names = wb.SheetNames;
  const sheet = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" });
  const b2b = names.find((n) => /^b2b$/i.test(n.trim()));
  const cdnr = names.find((n) => /^b2b[- ]?cdnr$/i.test(n.trim()));
  let lines = [];
  if (b2b) {
    lines = readSheet(sheet(b2b)).lines;
    if (cdnr) lines = lines.concat(readSheet(sheet(cdnr), "cn").lines);
  } else {
    for (const n of names) { const r = readSheet(sheet(n)); if (r.lines.length) { lines = r.lines; break; } }
  }
  return { lines, sheet: b2b || names[0] };
}
