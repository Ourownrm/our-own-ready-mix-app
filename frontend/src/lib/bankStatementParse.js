// Round 223 — reading a bank statement (Cost → Bank statements).
//
// PDF: the e-statement downloaded from net banking (not a scan). pdf.js gives
// every piece of text with its position; pieces on the same line are put
// together, a line starting with a date starts a transaction, and the lines
// under it (without a date) continue its narration. The amounts on a
// transaction's lines are the money columns; the right-most one is the
// running balance when the statement has one. Whether an amount is a debit or
// a credit comes from the column it sits under — and, where there is a
// balance, from how the balance moved, which settles it for any bank's layout.
//
// Excel / CSV: the header row is found by its words (Date, Withdrawal / Debit,
// Deposit / Credit, Balance, Narration …).
//
// Nothing is saved here; the page shows what was read, with the opening +
// credits − debits = closing check, before the user saves it.

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Indian statements put the day first.
export function parseDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {   // Excel serial day
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/))) [d, mo, y] = [m[1], m[2], m[3]];
  else if ((m = s.match(/^(\d{1,2})[\s\-/.]?([A-Za-z]{3,4})[A-Za-z]*[\s\-/.,]*(\d{2}|\d{4})$/)) && MON[m[2].toLowerCase()]) [d, mo, y] = [m[1], MON[m[2].toLowerCase()], m[3]];
  else return null;
  y = String(y).length === 2 ? `20${y}` : String(y);
  const D = Number(d), M = Number(mo);
  if (!(M >= 1 && M <= 12 && D >= 1 && D <= 31)) return null;
  return `${y}-${pad(M)}-${pad(D)}`;
}

// "1,23,456.00", "1,23,456.00 Cr", "-500.00", "(500.00)", "500.00Dr"
const AMT_RE = /^\(?-?₹?\s?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\)?\s?(?:CR|DR|Cr|Dr|cr|dr)?\.?$|^\(?-?₹?\d+\.\d{1,2}\)?\s?(?:CR|DR|Cr|Dr|cr|dr)?\.?$/;
export function parseAmount(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  let s = String(v).trim();
  if (!s) return null;
  let sign = 1;
  if (/dr\.?$/i.test(s)) { sign = -1; s = s.replace(/\s?dr\.?$/i, ""); }
  else if (/cr\.?$/i.test(s)) s = s.replace(/\s?cr\.?$/i, "");
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  s = s.replace(/[₹,\s]/g, "");
  if (s.startsWith("-")) { sign *= -1; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Number(s);
}
// An amount piece in a PDF line: must have paise (.00) — so cheque numbers,
// account numbers and dates are never taken for money.
const isMoney = (s) => /\.\d{2}\b/.test(s) && AMT_RE.test(String(s).trim());

// ------------------------------------------------------------------ PDF ---
let pdfjsP = null;
async function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const worker = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
      lib.GlobalWorkerOptions.workerSrc = worker;
      return lib;
    })();
  }
  return pdfjsP;
}

export class PdfPasswordError extends Error {
  constructor(wrong) { super(wrong ? "That password did not open the PDF." : "This PDF is locked with a password."); this.wrong = wrong; }
}

// Lines of text, each with its pieces and their x positions, page by page.
async function pdfLines(data, password) {
  const lib = await pdfjs();
  let doc;
  try {
    doc = await lib.getDocument({ data, password: password || undefined, isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === "PasswordException") throw new PdfPasswordError(e.code === 2);
    throw e;
  }
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
      str: it.str.replace(/\s+/g, " ").trim(), x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || 8,
    }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, Math.min(r.h, it.h) * 0.45));
      if (row) { row.items.push(it); row.h = Math.max(row.h, it.h); }
      else rows.push({ y: it.y, h: it.h, items: [it], page: p });
    }
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      // Pieces split inside one word or number (some PDFs place each glyph run separately).
      const merged = [];
      for (const it of r.items) {
        const last = merged[merged.length - 1];
        if (last && it.x - (last.x + last.w) < Math.max(1.2, it.h * 0.18)) { last.str += it.str; last.w = it.x + it.w - last.x; }
        else merged.push({ ...it });
      }
      r.items = merged;
      r.text = merged.map((i) => i.str).join(" ");
    }
    rows.sort((a, b) => b.y - a.y);
    out.push(...rows);
  }
  await doc.destroy();
  return out;
}

const HEAD_WORDS = {
  date: /^(txn\.?|tran\.?|transaction|value|post(ing)?|book)?\s*date$|^date$/i,
  debit: /withdraw|debit|^dr\.?$|paid out|payments?$/i,
  credit: /deposit|credit|^cr\.?$|paid in|receipts?$/i,
  balance: /balance/i,
  narration: /narration|description|particulars|remarks|details/i,
  ref: /chq|cheque|ref/i,
};

// Column positions from the header line (the words may wrap onto 2 lines).
// Round 226 — a summary block above the table ("Opening Balance · Total
// Withdrawals · Total Deposits · Closing Balance") has the same words; the
// real header also names the narration column, so that one is preferred.
function findHeader(rows) {
  let fallback = null;
  for (let i = 0; i < rows.length; i++) {
    const near = rows.slice(i, i + 3).filter((r) => r.page === rows[i].page && rows[i].y - r.y < rows[i].h * 3.2);
    const items = near.flatMap((r) => r.items);
    const col = (re) => items.filter((it) => re.test(it.str)).sort((a, b) => a.x - b.x);
    const date = col(HEAD_WORDS.date)[0] || items.find((it) => /date/i.test(it.str));
    const bal = col(HEAD_WORDS.balance).pop();
    const dr = col(HEAD_WORDS.debit).find((it) => !HEAD_WORDS.balance.test(it.str));
    const cr = col(HEAD_WORDS.credit).find((it) => !HEAD_WORDS.balance.test(it.str));
    if (date && bal && (dr || cr)) {
      const centre = (it) => (it ? it.x + it.w / 2 : null);
      const right = (it) => (it ? it.x + it.w : null);
      const narr = col(HEAD_WORDS.narration)[0];
      const h = { index: i, lines: near.length, page: rows[i].page, y: rows[i].y, debit: dr ? { c: centre(dr), r: right(dr) } : null,
        credit: cr ? { c: centre(cr), r: right(cr) } : null, balance: { c: centre(bal), r: right(bal) },
        narr: narr ? { x: narr.x } : null, date: { x: date.x },
        ref: col(HEAD_WORDS.ref)[0] ? { x: col(HEAD_WORDS.ref)[0].x, r: right(col(HEAD_WORDS.ref)[0]) } : null };
      if (narr) return h;
      if (!fallback) fallback = h;
    }
  }
  return fallback;
}

// Round 252 — the explanation block some banks print after the last entry
// (ICICI: "Legends Used in Account Statement 1. BBPS - Bharat Bill Payment
// Service 2. BCTT …"). From such a heading on, nothing is narration until
// the next dated line (owner, 30 Oct 2026).
export const END_BLOCK = /legends?\s+used|^legends?\b|abbreviations?\s+used|this is (a|an) (computer|system)[- ]generated|end of (the )?statement|\*+\s*end\s*\*+|statement summary|account summary/i;
const SKIP_LINE = /opening balance|closing balance|balance (b\/?f|brought|carried|c\/?f)|brought forward|carried forward|page \d+ of|statement of account|^total|grand total|\*\*\*/i;

// Round 231 — a date printed over two lines in its column ("05-09-" / "2026"
// on CSB, "01-Sep-" / "2026" on ICICI): the year on the line below is joined
// back onto the day and month, so the line is recognised as a transaction.
const PART_DATE = /^\d{1,2}[-/. ](?:\d{1,2}|[A-Za-z]{3,4})[-/. ]?$/;
function joinSplitDates(rows, dateLimit) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (const it of r.items) {
      if (it.x >= dateLimit || parseDate(it.str) || !PART_DATE.test(it.str)) continue;
      for (let j = i + 1; j < Math.min(rows.length, i + 4); j++) {
        const n = rows[j];
        // An entry that starts on the last line of a page carries its year
        // on the first line of the next (CSB).
        const overPage = n.page === r.page + 1 && rows[j - 1].page === r.page;
        if (!overPage && (n.page !== r.page || r.y - n.y > Math.max(r.h, it.h) * 2.6)) break;
        const k = n.items.findIndex((x) => Math.abs(x.x - it.x) < 8 && /^\d{2,4}$/.test(x.str));
        if (k < 0) continue;
        const joined = `${it.str}${/[-/. ]$/.test(it.str) ? "" : "-"}${n.items[k].str}`;
        if (!parseDate(joined)) continue;
        it.str = joined;
        n.items.splice(k, 1);
        n.text = n.items.map((x) => x.str).join(" ");
        break;
      }
    }
    r.text = r.items.map((x) => x.str).join(" ");
  }
  return rows.filter((r) => r.items.length);
}

// Left of the narration heading sit the serial no. and transaction id (short,
// one word, with digits) — but some banks also start the narration there
// (CSB, Federal), so only those short id-like pieces are left out.
const isIdPiece = (str) => !/\s/.test(str) && /\d/.test(str) && str.length <= 12;

// A clock time beside the date (Federal Bank prints "12:05:08 PM" under it).
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?$/i;

function txnsFromRows(rowsIn) {
  const head = findHeader(rowsIn);
  const txns = [];
  let opening = null;
  let cur = null;
  let inEndBlock = false;
  const dist = (a, b) => (a == null || b == null ? Infinity : Math.abs(a - b));
  // The transaction date: the left-most date in the date columns — which
  // may come after a serial no. or a transaction id (ICICI: "Sl No · Tran
  // Id · Value Date · Transaction Date …"), never one inside the narration.
  const dateLimit = head ? (head.narr && head.narr.x > (head.date?.x ?? 0) ? head.narr.x - 2 : Math.min(head.balance.c, head.debit?.c ?? Infinity, head.credit?.c ?? Infinity) * 0.5) : 200;
  const rows = joinSplitDates(rowsIn, dateLimit);
  // Round 231 — Federal Bank prints withdrawals and deposits in whole rupees
  // ("28184", "360000"): a plain number standing right under the Withdrawal
  // or Deposit heading is money too. Anywhere else a bare number is a cheque,
  // account or reference number and is never taken.
  const inMoneyCol = (it) => head && /^\d{1,3}(?:,\d{2,3})+$|^\d+$/.test(it.str)
    && [head.debit, head.credit].some((c) => c && Math.abs(it.x + it.w - c.r) <= 14);
  const isAmount = (it) => isMoney(it.str) || inMoneyCol(it);
  const isDateRow = (r) => r.items.some((it) => it.x < dateLimit && (parseDate(it.str) ?? parseDate(it.str.split(" ")[0])));
  for (let i = head ? head.index + head.lines : 0; i < rows.length; i++) {
    const r = rows[i];
    // A repeated header on later pages.
    if (head && r.page !== head.page && r.items.some((it) => HEAD_WORDS.balance.test(it.str)) && r.items.some((it) => /date/i.test(it.str))) { cur = null; continue; }
    if (/opening balance|balance b\/?f|brought forward/i.test(r.text)) {
      const m = r.items.filter((it) => isMoney(it.str)).pop();
      if (m && opening == null) opening = parseAmount(m.str);
      cur = null; continue;
    }
    if (SKIP_LINE.test(r.text)) { cur = null; continue; }
    if (END_BLOCK.test(r.text)) { cur = null; inEndBlock = true; continue; }
    const first = r.items.filter((it) => it.x < dateLimit).slice(0, 6)
      .map((it) => ({ it, d: parseDate(it.str) ?? parseDate(it.str.split(" ")[0]) })).find((x) => x.d);
    // Round 231 — CSB centres each entry on its date line: the first line of
    // the narration sits just ABOVE the date. A narration-only line that is
    // nearer the next date line than the entry before it opens that entry.
    if (!first && !r.items.some(isAmount)) {
      const next = rows[i + 1];
      const gapPrev = cur ? cur.y - r.y : Infinity;
      if (next && next.page === r.page && isDateRow(next) && r.y - next.y <= r.h * 1.6 && r.y - next.y < gapPrev * 0.8) {
        (rows[i + 1].prefix ||= []).push(...r.items.filter((it) => it.x >= dateLimit || !isIdPiece(it.str)).map((it) => it.str));
        continue;
      }
    }
    if (inEndBlock && !first) continue;           // legend / footer text — never narration
    if (first) {
      inEndBlock = false;
      cur = { date: first.d, parts: [...(r.prefix || [])], amounts: [], ref: [], page: r.page, y: r.y };
      txns.push(cur);
      // the rest of the piece holding the date may already be narration
      const rest = first.it.str.replace(/^\S+\s?/, "");
      if (rest && parseDate(first.it.str.split(" ")[0])) cur.parts.push(rest);
    } else if (!cur) continue;
    else if (r.page !== cur.page) {
      // Round 231 — an entry begun at the foot of a page whose amount is on
      // the next page (CSB): the first line of the new page continues it.
      // Otherwise a new page never continues the last entry.
      const firstOfPage = rows[i - 1]?.page !== r.page;
      if (firstOfPage && r.page === cur.page + 1 && cur.amounts.length < 2) { cur.page = r.page; cur.y = r.y; }
      else { cur = null; continue; }
    }
    else if (cur.y - r.y > r.h * 3.5) { cur = null; continue; }  // a footer, not more narration
    else cur.y = r.y;
    for (const it of r.items) {
      if (first && it === first.it) continue;
      if (isAmount(it)) { cur.amounts.push(it); continue; }
      if (parseDate(it.str)) continue;            // value date
      if (TIME_RE.test(it.str)) continue;         // time of the transaction
      if (/^[DC]$/.test(it.str) && head && it.x > (head.narr?.x ?? 0)) continue;   // Federal's "Tran Type" D / C
      if (/^(cr|dr)\.?$/i.test(it.str) && cur.amounts.length) { cur.amounts[cur.amounts.length - 1] = { ...cur.amounts[cur.amounts.length - 1], str: `${cur.amounts[cur.amounts.length - 1].str} ${it.str}` }; continue; }
      if (head?.ref && it.x >= head.ref.x - 4 && it.x + it.w <= head.ref.r + 40 && /\d/.test(it.str) && !/\s/.test(it.str)) { if (!/^0+$/.test(it.str)) cur.ref.push(it.str); continue; }
      if (/^0+$/.test(it.str)) continue;          // an empty column printed as 0
      if (head?.narr && it.x < dateLimit && isIdPiece(it.str)) continue;  // serial no., transaction id, posted date …
      cur.parts.push(it.str);
    }
  }
  // Money: the right-most is the balance (when there is a balance column).
  const out = [];
  for (const t of txns) {
    if (!t.amounts.length) continue;
    const am = [...t.amounts].sort((a, b) => a.x - b.x);
    let balance = null, rest = am;
    if (head && am.length >= 2) {
      const last = am[am.length - 1];
      balance = parseAmount(last.str); rest = am.slice(0, -1);
    } else if (head && am.length === 1 && dist(am[0].x + am[0].w, head.balance.r) < dist(am[0].x + am[0].w, (head.debit || head.credit).r) * 0.5) {
      continue; // only a balance — not a transaction
    }
    // Some banks print 0.00 in the column not used ("0.00 | 1,000.00 | balance").
    const nonZero = rest.filter((x) => Math.abs(parseAmount(x.str) || 0) > 0);
    if (!nonZero.length) continue;
    const a = nonZero[nonZero.length - 1];
    const value = Math.abs(parseAmount(a.str) || 0);
    if (!(value > 0)) continue;
    let side = null;
    if (/dr\.?$/i.test(a.str)) side = "debit";
    else if (/cr\.?$/i.test(a.str)) side = "credit";
    else if (head?.debit && head?.credit) side = dist(a.x + a.w / 2, head.debit.c) <= dist(a.x + a.w / 2, head.credit.c) ? "debit" : "credit";
    else if (head?.debit) side = "debit";
    else if (head?.credit) side = "credit";
    out.push({ date: t.date, narration: t.parts.join(" ").replace(/\s+/g, " ").trim(), reference: t.ref.join(" "),
      debit: side === "debit" ? value : 0, credit: side === "credit" ? value : 0, balance, _side: side });
  }
  if (out.length > 1 && out[0].date > out[out.length - 1].date) out.reverse();   // newest first
  return { rows: settle(out, opening), header: !!head };
}

// The balance column decides debit or credit where it can: a fall is a
// debit, a rise a credit.
function settle(rows, opening) {
  let prev = opening;
  // Balances printed without a sign: a CC / OD statement may show the debit
  // balance as a plain number. If going the other way explains every line
  // better, the balances are taken as negative.
  for (const r of rows) {
    if (r.balance != null && prev != null) {
      const amt = r.debit || r.credit;
      const up = r2(prev + amt), down = r2(prev - amt);
      if (Math.abs(down - r.balance) < 0.02 && r.credit) { r.debit = amt; r.credit = 0; }
      else if (Math.abs(up - r.balance) < 0.02 && r.debit) { r.credit = amt; r.debit = 0; }
    }
    if (r.balance != null) prev = r.balance;
    delete r._side;
  }
  return rows;
}

export function check(rows, opening) {
  // Opening: given, else worked back from the first line's balance.
  const first = rows.find((r) => r.balance != null);
  let open = opening;
  if (open == null && first) {
    const before = rows.slice(0, rows.indexOf(first) + 1).reduce((t, r) => t + r.credit - r.debit, 0);
    open = r2(first.balance - before);
  }
  const debits = r2(rows.reduce((t, r) => t + r.debit, 0)), credits = r2(rows.reduce((t, r) => t + r.credit, 0));
  const lastBal = [...rows].reverse().find((r) => r.balance != null)?.balance ?? null;
  // Line by line: does each balance follow from the one before?
  const breaks = [];
  let run = open;
  rows.forEach((r, i) => {
    if (run == null) { run = r.balance; return; }
    run = r2(run + r.credit - r.debit);
    if (r.balance != null) {
      if (Math.abs(run - r.balance) > 0.02) breaks.push(i);
      run = r.balance;
    }
  });
  const closing = open == null ? null : r2(open + credits - debits);
  return { opening: open, debits, credits, closing, printed_closing: lastBal,
    agrees: lastBal == null ? null : closing != null && Math.abs(closing - lastBal) < 0.05, breaks };
}

// Account numbers printed on the statement (for picking the account).
function accountNumbers(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:a\/?c|account)\s*(?:no\.?|number|#)?\s*[:.-]?\s*([X*x\d][X*x\d\s-]{5,24}\d)/gi)) out.add(m[1].replace(/[\s-]/g, ""));
  for (const m of text.matchAll(/\b\d{9,18}\b/g)) out.add(m[0]);
  return [...out];
}

// The period printed at the top ("for the period 01/09/2026 to 30/09/2026",
// "From 01-SEP-2026 To 30-SEP-2026") — so a month whose last days had no
// transactions still counts as uploaded to its end.
const DATE_TXT = "\\d{1,2}[/\\-. ]?(?:\\d{1,2}|[A-Za-z]{3,9})[/\\-. ,]*\\d{2,4}";
function statementPeriod(text) {
  const m = text.match(new RegExp(`(?:period|from|between|for)\\D{0,40}?(${DATE_TXT})\\s*(?:to|till|until|-|–)\\s*(${DATE_TXT})`, "i"));
  if (!m) return null;
  const a = parseDate(m[1].trim()), b = parseDate(m[2].trim());
  return a && b && a <= b ? { from: a, to: b } : null;
}

export async function readPdf(file, password) {
  const rows = await pdfLines(new Uint8Array(await file.arrayBuffer()), password);
  if (!rows.length) throw new Error("No text in this PDF — it looks like a scanned picture. Download the e-statement from net banking instead.");
  const text = rows.slice(0, 80).map((r) => r.text).join("\n");
  const { rows: txns, header } = txnsFromRows(rows);
  if (!txns.length) throw new Error(header ? "Found the columns but no transactions under them." : "Could not find the statement's columns (Date … Withdrawal / Deposit … Balance) in this PDF.");
  return finish(txns, null, accountNumbers(text), statementPeriod(text));
}

// --------------------------------------------------------- Excel / CSV ---
export function readSheet(aoa) {
  const find = (cells, re, not) => cells.findIndex((c) => re.test(String(c || "").trim()) && !(not && not.test(String(c || ""))));
  for (let i = 0; i < Math.min(aoa.length, 60); i++) {
    const cells = (aoa[i] || []).map((c) => String(c ?? "").replace(/\s+/g, " ").trim());
    const date = cells.findIndex((c) => /date/i.test(c));
    const bal = find(cells, /balance/i);
    const dr = find(cells, HEAD_WORDS.debit, /balance/i);
    const cr = find(cells, HEAD_WORDS.credit, /balance/i);
    const amt = find(cells, /^amount|amount \(inr\)|txn amount/i);
    const drcr = find(cells, /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|txn type)$/i);
    if (date < 0 || (dr < 0 && cr < 0 && amt < 0)) continue;
    const narr = find(cells, HEAD_WORDS.narration);
    const ref = find(cells, HEAD_WORDS.ref, /date/i);
    const rows = [];
    let opening = null;
    for (const r of aoa.slice(i + 1)) {
      const d = parseDate(r[date]);
      const text = r.map((c) => String(c ?? "")).join(" ");
      if (!d) { if (/opening balance/i.test(text) && bal >= 0) opening = parseAmount(r[bal]); continue; }
      let debit = 0, credit = 0;
      if (dr >= 0 || cr >= 0) {
        debit = Math.abs(parseAmount(dr >= 0 ? r[dr] : null) || 0);
        credit = Math.abs(parseAmount(cr >= 0 ? r[cr] : null) || 0);
        if (dr >= 0 && dr === cr) { const v = parseAmount(r[dr]) || 0; debit = v < 0 ? -v : 0; credit = v > 0 ? v : 0; }
      } else {
        const v = parseAmount(r[amt]) || 0;
        const t = drcr >= 0 ? String(r[drcr] || "").toUpperCase() : "";
        if (t.startsWith("D")) debit = Math.abs(v); else if (t.startsWith("C")) credit = Math.abs(v);
        else if (v < 0) debit = -v; else credit = v;
      }
      if (!(debit > 0) && !(credit > 0)) continue;
      if (debit > 0 && credit > 0) continue;
      rows.push({ date: d, narration: narr >= 0 ? String(r[narr] ?? "").replace(/\s+/g, " ").trim() : "", reference: ref >= 0 ? String(r[ref] ?? "").trim() : "",
        debit: r2(debit), credit: r2(credit), balance: bal >= 0 ? parseAmount(r[bal]) : null });
    }
    if (!rows.length) continue;
    if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) rows.reverse();
    const top = aoa.slice(0, i).map((r) => (r || []).join(" ")).join("\n");
    return finish(settle(rows, opening), opening, accountNumbers(top), statementPeriod(top));
  }
  throw new Error("Could not find the Date and Withdrawal / Deposit (or Debit / Credit) columns in this file.");
}

export async function readFile(file, password) {
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") return readPdf(file, password);
  const XLSX = await import("xlsx");
  // Round 238 — raw: CSV files and the ".xls" that banks send as a web page
  // are text; without it the library reads "10/09/2026" the American way
  // (9 October) before our day-first reading sees it.
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, raw: true });
  let lastErr = null;
  for (const name of wb.SheetNames) {
    try { return readSheet(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" })); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Empty file.");
}

function finish(rows, opening, numbers, period = null) {
  // Oldest first (some banks list newest first).
  if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) rows.reverse();
  rows.forEach((r) => { r.debit = r2(r.debit); r.credit = r2(r.credit); if (r.balance != null) r.balance = r2(r.balance); });
  const c = check(rows, opening);
  const dates = rows.map((r) => r.date).sort();
  // The printed period, when it holds every line.
  const ok = period && period.from <= dates[0] && period.to >= dates[dates.length - 1];
  return { rows, ...c, from: ok ? period.from : dates[0], to: ok ? period.to : dates[dates.length - 1], account_numbers: numbers };
}
