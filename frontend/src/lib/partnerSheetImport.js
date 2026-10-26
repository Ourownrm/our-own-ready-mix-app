// Round 244 — reads the owner's own "Investment & Loan" workbook (27 Oct 2026)
// into Cost → Partners entries. Hidden sheets are ignored (owner: "do not
// consider hidden sheets").
//
// The main table (a visible sheet with Date · Narration · Amount · Type of
// Fund · Investor Name · Interest % · Interest Start Date · Loan Pay Back Date
// · Interest Amount · <interest paid columns, one per payment date> · Balance):
//   Investment       + → capital brought in, − → capital returned
//   Partner's Loan   + → loan borrowed (interest from the row's Interest Start
//                        Date when it differs), − → principal repaid;
//                        a Loan Pay Back Date before the sheet's date on a row
//                        with no matching − row → principal repaid that day
//   interest paid columns (header carries the date, e.g. "Interest Paid-15-Jun-24",
//                        "Int 31-Jul-25") → interest paid by that partner that
//                        day (may be negative: a reversal)
// TDS: a visible summary table with "Partner Name" and a "TDS Deducted on
// <Month-YY>" column → TDS on that partner's interest paid in that month (the
// interest columns are before TDS, so the amount paid = interest − TDS).
// The sheet's own totals per partner (on the sheet's "Today" date) are kept to
// compare with the app's.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, july: 7, june: 6 };
const pad = (n) => String(n).padStart(2, "0");
function serialToYmd(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const d = new Date(Math.round((v - 25569) * 86400000)); // ist-ok: Excel serial day → calendar day (UTC midnight)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function headerDate(h) {
  const m = /(\d{1,2})\s*-\s*([A-Za-z]{3,5})\s*-\s*(\d{2,4})/.exec(String(h || ""));
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${pad(mon)}-${pad(Number(m[1]))}`;
}
function headerMonth(h) {
  const m = /([A-Za-z]{3,5})\s*-\s*(\d{2,4})/.exec(String(h || "").replace(/^.*?on\s+/i, ""));
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${y}-${pad(MONTHS[m[1].toLowerCase()])}`;
}
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const r2 = (n) => Math.round(n * 100) / 100;

export function visibleSheets(XLSX, wb) {
  const meta = wb.Workbook?.Sheets || [];
  return wb.SheetNames.filter((n, i) => !(meta[i] && meta[i].Hidden)).map((n) => ({ name: n, aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) }));
}

export function readPartnerSheet(XLSX, wb) {
  const sheets = visibleSheets(XLSX, wb);
  // ---- the main table
  let main = null;
  for (const s of sheets) {
    for (let i = 0; i < Math.min(s.aoa.length, 30); i++) {
      const h = (s.aoa[i] || []).map(norm);
      const col = (re) => h.findIndex((x) => re.test(x));
      const c = { date: col(/^date$/), narr: col(/^narration/), amount: col(/^amount$/), type: col(/type of fund/), name: col(/investor name|partner name/),
        rate: col(/^interest %/), start: col(/interest start/), payback: col(/pay ?back/), interest: col(/^interest amount/), balance: col(/^balance$/) };
      if (c.date >= 0 && c.amount >= 0 && c.type >= 0 && c.name >= 0) { main = { s, head: i, c, header: s.aoa[i] }; break; }
    }
    if (main) break;
  }
  if (!main) throw new Error("Could not find the table with Date, Amount, Type of Fund and Investor Name on a visible sheet.");
  const { s, head, c, header } = main;
  // the sheet's own date ("Today :" above the table)
  let asOn = null;
  for (let i = 0; i < head && !asOn; i++) {
    const row = s.aoa[i] || [];
    const k = row.findIndex((x) => /today/i.test(String(x ?? "")));
    if (k >= 0) asOn = serialToYmd(row.slice(k + 1).find((x) => typeof x === "number"));
  }
  // interest paid columns: between "Interest Amount" and "Balance", with a date in the header
  const payCols = [];
  for (let j = (c.interest >= 0 ? c.interest + 1 : 0); j < (c.balance >= 0 ? c.balance : header.length); j++) {
    const d = headerDate(header[j]);
    if (d) payCols.push({ j, date: d, header: String(header[j]).trim() });
  }
  const entries = [];
  const check = {};
  const rates = new Set();
  const rows = s.aoa.slice(head + 1);
  const ck = (n) => (check[n] = check[n] || { capital: 0, loan: 0, interest: 0, paid: 0, balance: 0 });
  const paid = new Map(); // partner|date → gross
  const negs = new Set();
  // One partner however the name is typed ("Pramod Kumar" / "Pramod kumar").
  const canon = new Map();
  const nameOf = (v) => {
    const raw = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    const k = raw.toLowerCase();
    if (!canon.has(k)) canon.set(k, raw);
    return canon.get(k);
  };
  for (const r of rows) {
    const type = norm(r[c.type]), name = nameOf(r[c.name]), amt = Number(r[c.amount]), date = serialToYmd(r[c.date]);
    if (!type || !name || !date || !Number.isFinite(amt) || !amt) continue;
    if (/loan/.test(type) && amt < 0) negs.add(`${name}|${date}|${Math.abs(amt)}`);
  }
  rows.forEach((r, idx) => {
    const type = norm(r[c.type]), name = nameOf(r[c.name]), amt = Number(r[c.amount]), date = serialToYmd(r[c.date]);
    if (!type || !name || !date || !Number.isFinite(amt) || !amt) return;
    const narration = c.narr >= 0 && r[c.narr] != null ? String(r[c.narr]).replace(/\s+/g, " ").trim() : null;
    if (/invest|capital/.test(type)) {
      entries.push({ partner: name, kind: amt > 0 ? "capital_in" : "capital_out", txn_date: date, amount: Math.abs(amt), narration, seq: idx });
      ck(name).capital += amt;
      return;
    }
    if (!/loan/.test(type)) return;
    ck(name).loan += amt;
    if (c.interest >= 0 && typeof r[c.interest] === "number") ck(name).interest += r[c.interest];
    if (c.balance >= 0 && typeof r[c.balance] === "number") ck(name).balance += r[c.balance];
    if (amt < 0) {
      entries.push({ partner: name, kind: "loan_out", txn_date: date, amount: Math.abs(amt), narration, seq: idx });
      return;
    }
    if (c.rate >= 0 && typeof r[c.rate] === "number") rates.add(Math.round(r[c.rate] * 10000) / 100);
    const start = c.start >= 0 ? serialToYmd(r[c.start]) : null;
    entries.push({ partner: name, kind: "loan_in", txn_date: date, amount: amt, narration, interest_from: start && start !== date ? start : null, seq: idx });
    const back = c.payback >= 0 ? serialToYmd(r[c.payback]) : null;
    if (back && asOn && back < asOn && !negs.has(`${name}|${back}|${amt}`)) {
      entries.push({ partner: name, kind: "loan_out", txn_date: back, amount: amt, narration: `Paid back (Loan Pay Back Date) — ${narration || ""}`.trim(), seq: `${idx}b` });
    }
    for (const pc of payCols) {
      const v = Number(r[pc.j]);
      if (!Number.isFinite(v) || !v) continue;
      const k = `${name}|${pc.date}`;
      paid.set(k, (paid.get(k) || 0) + v);
      ck(name).paid += v;
    }
  });
  // ---- TDS from a summary table on another visible sheet
  const tds = new Map(); // partner|YYYY-MM → amount
  for (const sh of sheets) {
    for (let i = 0; i < sh.aoa.length; i++) {
      const h = (sh.aoa[i] || []).map((x) => String(x ?? ""));
      const nameCol = h.findIndex((x) => /partner name/i.test(x));
      const tdsCols = h.map((x, j) => (/tds deducted/i.test(x) ? j : -1)).filter((j) => j >= 0);
      if (nameCol < 0 || !tdsCols.length) continue;
      for (const r of sh.aoa.slice(i + 1)) {
        const n = nameOf(r?.[nameCol]);
        if (!n || /total/i.test(n)) { if (!n) break; continue; }
        for (const j of tdsCols) {
          const ym = headerMonth(h[j]);
          const v = Number(r[j]);
          if (ym && Number.isFinite(v) && v) tds.set(`${n}|${ym}`, Math.abs(v));
        }
      }
    }
  }
  const tdsUsed = new Set();
  for (const [k, gross] of paid) {
    const [name, date] = k.split("|");
    const t = tds.get(`${name}|${date.slice(0, 7)}`);
    const takeTds = t && !tdsUsed.has(`${name}|${date.slice(0, 7)}`) && gross > 0;
    if (takeTds) tdsUsed.add(`${name}|${date.slice(0, 7)}`);
    entries.push({ partner: name, kind: "interest_paid", txn_date: date, amount: r2(gross - (takeTds ? t : 0)), tds: takeTds ? r2(t) : 0,
      narration: `Interest paid (sheet column ${payCols.find((p) => p.date === date)?.header || date})${takeTds ? " — TDS from the summary" : ""}`, seq: `p${date}` });
  }
  const tdsMissed = [...tds.keys()].filter((k) => !tdsUsed.has(k));
  for (const n of Object.keys(check)) for (const f of Object.keys(check[n])) check[n][f] = r2(check[n][f]);
  return {
    sheet: s.name, as_on: asOn, entries: entries.filter((e) => e.kind !== "interest_paid" || e.amount !== 0 || e.tds),
    pay_columns: payCols.map((p) => ({ header: p.header, date: p.date })),
    rates: [...rates], tds_missed: tdsMissed,
    check: { as_on: asOn, partners: check },
  };
}
