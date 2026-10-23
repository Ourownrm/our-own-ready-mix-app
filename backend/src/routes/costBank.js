// Round 223 — Cost → Bank statements (owner, 21 Oct 2026). Upload each
// account's statement, give every line a treatment (a cost head, left out
// because the app has it, own transfer, loan EMI …). The rules live in
// lib/bankBook.js. Administrator only by default (cost.bank).
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth, isAdminLevel } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { istMonth, istDay } from "../lib/istDate.js";
import { MONTH_RE, monthBounds, addMonths, monthLabel } from "../lib/costDashboard.js";
import {
  BANK_HEADS, HEAD_KEYS, TREATMENTS, dedupeKey, autoSort, recomputeLoans, loansSummary, keywordHit,
  GST_RATES, headGst, gstSplit, ensureBankGst,
} from "../lib/bankBook.js";
import {
  ensureRound235, ledgerSettings, partyOptions, partyBills, postPayment, unpostPayment, postCertificate,
  POST_KINDS, postWhere, bankMode, bankRef,
} from "../lib/ledgerPost.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound235(); next(); } catch (e) { next(e); } });

// Round 235 — the switch for "Record payment" in the ledgers. Anyone signed
// in reads it (the ledger pages hide the button); an Administrator sets it.
router.get("/ledger-settings", async (req, res) => {
  res.json({ ...(await ledgerSettings()), can_change: isAdminLevel(req.user.role) });
});
router.put("/ledger-settings", async (req, res) => {
  if (!isAdminLevel(req.user.role)) return res.status(403).json({ error: "Only an Administrator can change this." });
  await query(`UPDATE ledger_settings SET manual_payments = $1, updated_by = $2, updated_at = now() WHERE id = 1`, [req.body?.manual_payments === true, req.user.id]);
  res.json(await ledgerSettings());
});

const VIEW = requirePermission("cost.bank", "view");
const EDIT = requirePermission("cost.bank", "edit");
router.use(async (_req, _res, next) => { try { await ensureBankGst(); next(); } catch (e) { next(e); } });
// Round 232 — the GST % a line or rule gives (null = the head's usual rate).
function gstChoice(b, head) {
  const claim = b.gst_claim !== false;
  if (b.gst_pct === undefined || b.gst_pct === null || b.gst_pct === "") return { pct: headGst(head), claim };
  const p = Number(b.gst_pct);
  if (!GST_RATES.includes(p)) return { error: `GST: one of ${GST_RATES.join(", ")} %.` };
  return { pct: p, claim };
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const bad = (res, msg) => res.status(400).json({ error: msg });

const OMIT_GROUPS = {
  supplier: ["Raw material payments", "Supplier ledger"],
  transporter: ["Transporter payments", "Transporter ledger"],
  contractor: ["Contractor & pump-gang payments", "HR → contractor bills"],
  maintenance: ["Repairs, spares & certificates", "Maintenance → Payments"],
  payroll_day: ["Salaries & wages", "HR payroll"],
  advance: ["Salary advances", "HR → Advances"],
  store_purchase: ["Fuel & store purchases", "Fuel / Store"],
  fuel_fill: ["Outside fuel fills", "Fuel module"],
  receipt: ["Customer receipts", "Accounts → receipts"],
  payment: ["Customer receipts", "Accounts → receipts"],
};
const accLabel = (a) => `${a.bank} ••${String(a.number).slice(-4)}`;

// --------------------------------------------------------------- page ---
router.get("/", VIEW, async (req, res) => {
  const now = istMonth();
  const ym = req.query.month || addMonths(now, -1);
  if (!MONTH_RE.test(ym) || ym > now) return bad(res, "Pick a month (YYYY-MM).");
  const { from, end } = monthBounds(ym);
  const dayEnd = ym === now ? istDay() : end;
  const [accs, lines, rules, uploads, loans] = await Promise.all([
    query(`SELECT a.*, (SELECT MIN(period_from)::text FROM cost_bank_uploads u WHERE u.account_id = a.id) AS covered_from,
                  (SELECT MAX(period_to)::text FROM cost_bank_uploads u WHERE u.account_id = a.id) AS covered_to,
                  (SELECT balance FROM cost_bank_lines b WHERE b.account_id = a.id AND b.txn_date <= $2::date AND b.balance IS NOT NULL
                    ORDER BY b.txn_date DESC, b.seq DESC, b.id DESC LIMIT 1) AS closing,
                  (SELECT COUNT(*)::int FROM cost_bank_lines b WHERE b.account_id = a.id AND b.txn_date BETWEEN $1::date AND $2::date) AS lines_month
             FROM cost_bank_accounts a ORDER BY a.is_active DESC, a.id`, [from, end]),
    query(`SELECT l.id, l.account_id, l.txn_date::text AS txn_date, l.narration, l.reference, l.debit, l.credit, l.balance, l.treatment, l.head,
                  l.loan_id, ln.name AS loan_name, l.interest, l.principal, l.interest_fixed, l.match_kind, l.why, l.manual, l.note, u.name AS set_by_name,
                  l.gst_pct, l.gst_claim, l.post_kind, l.post_id, l.party_label
             FROM cost_bank_lines l LEFT JOIN cost_bank_loans ln ON ln.id = l.loan_id LEFT JOIN users u ON u.id = l.set_by
            WHERE l.txn_date BETWEEN $1::date AND $2::date ORDER BY l.txn_date, l.account_id, l.seq, l.id`, [from, end]),
    query(`SELECT r.*, ln.name AS loan_name, (SELECT COUNT(*)::int FROM cost_bank_lines b WHERE b.rule_id = r.id) AS used
             FROM cost_bank_rules r LEFT JOIN cost_bank_loans ln ON ln.id = r.loan_id ORDER BY r.keyword`),
    query(`SELECT u.id, u.account_id, u.file_name, u.period_from::text AS period_from, u.period_to::text AS period_to, u.opening, u.closing,
                  u.lines_read, u.lines_added, u.lines_duplicate, u.uploaded_at, us.name AS by_name
             FROM cost_bank_uploads u LEFT JOIN users us ON us.id = u.uploaded_by ORDER BY u.id DESC LIMIT 20`),
    loansSummary(dayEnd, ym),
  ]);
  const accById = new Map(accs.rows.map((a) => [a.id, a]));
  const L = lines.rows.map((l) => ({ ...l, debit: n0(l.debit), credit: n0(l.credit), balance: l.balance == null ? null : n0(l.balance),
    interest: l.interest == null ? null : n0(l.interest), principal: l.principal == null ? null : n0(l.principal),
    account: accById.has(l.account_id) ? accLabel(accById.get(l.account_id)) : "—",
    // Round 232 — the cost part and the input GST inside a cost line.
    ...(l.treatment === "cost" ? (() => {
      const amt = l.head === "other_income" ? n0(l.credit) - n0(l.debit) : n0(l.debit) - n0(l.credit);
      const g = l.head === "other_income" ? { net: r2(amt), gst: 0 } : gstSplit(amt, l.gst_pct, l.gst_claim !== false);
      return { gst_pct: l.gst_pct == null ? null : n0(l.gst_pct), net: g.net, gst: g.gst };
    })() : { gst_pct: null, net: null, gst: null }) }));

  // Summary
  const by = {};
  for (const t of TREATMENTS) by[t] = { n: 0, dr: 0, cr: 0 };
  const heads = Object.fromEntries(BANK_HEADS.map((h) => [h.key, { key: h.key, label: h.label, amount: 0, n: 0 }]));
  const omitted = new Map();
  const posted = new Map();
  let loanInt = 0, loanPrin = 0, gstIn = 0;
  for (const l of L) {
    const b = by[l.treatment]; b.n++; b.dr += l.debit; b.cr += l.credit;
    if (l.treatment === "cost" && heads[l.head]) {
      heads[l.head].amount += l.net; heads[l.head].n++;
      heads[l.head].gst = r2((heads[l.head].gst || 0) + l.gst); gstIn += l.gst;
    }
    if (l.treatment === "loan") { loanInt += n0(l.interest); loanPrin += n0(l.principal); }
    if ((l.treatment === "pay" || l.treatment === "cert") && l.post_kind) {
      const k = l.post_kind;
      if (!posted.has(k)) posted.set(k, { kind: k, where: postWhere(k), amount: 0, n: 0 });
      const o = posted.get(k); o.amount += l.debit; o.n++;
    }
    if (l.treatment === "omit") {
      const g = OMIT_GROUPS[l.match_kind] || ["Left out by hand", "already in the app"];
      const k = g[0];
      if (!omitted.has(k)) omitted.set(k, { label: g[0], where: g[1], amount: 0, n: 0 });
      const o = omitted.get(k); o.amount += l.debit + l.credit; o.n++;
    }
  }
  if (loanInt) { heads.interest.amount += loanInt; heads.interest.loan = r2(loanInt); }
  for (const t of Object.values(by)) { t.dr = r2(t.dr); t.cr = r2(t.cr); }
  const headList = Object.values(heads).map((h) => ({ ...h, amount: r2(h.amount) }));
  const toPl = r2(headList.filter((h) => h.key !== "other_income").reduce((t, h) => t + h.amount, 0));
  res.json({
    month: ym, label: monthLabel(ym, true), day_end: dayEnd, heads_meta: BANK_HEADS, treatments: TREATMENTS,
    accounts: accs.rows.map((a) => ({ id: a.id, bank: a.bank, label: a.label, number: a.number, kind: a.kind, is_active: a.is_active,
      name: accLabel(a), covered_from: a.covered_from, covered_to: a.covered_to, closing: a.closing == null ? null : n0(a.closing), lines_month: a.lines_month })),
    lines: L,
    summary: {
      lines: L.length, debits: r2(L.reduce((t, l) => t + l.debit, 0)), credits: r2(L.reduce((t, l) => t + l.credit, 0)),
      by, heads: headList, to_pl: toPl, other_income: r2(heads.other_income.amount),
      omitted: [...omitted.values()].map((o) => ({ ...o, amount: r2(o.amount) })).sort((a, b) => b.amount - a.amount),
      loan_interest: r2(loanInt), loan_principal: r2(loanPrin), gst_input: r2(gstIn),
      posted: [...posted.values()].map((o) => ({ ...o, amount: r2(o.amount) })).sort((a, b) => b.amount - a.amount),
    },
    ledger: { ...(await ledgerSettings()), can_change: isAdminLevel(req.user.role) },
    gst_rates: GST_RATES,
    loans, rules: rules.rows, uploads: uploads.rows.map((u) => ({ ...u, account: accById.has(u.account_id) ? accLabel(accById.get(u.account_id)) : "—" })),
  });
});

// ------------------------------------------------------------ accounts ---
function cleanAccount(b) {
  const number = String(b.number || "").replace(/\s/g, "");
  if (!/^\d{4,20}$/.test(number)) return { error: "Account number: digits only, as printed on the statement." };
  const bank = String(b.bank || "").trim().slice(0, 80);
  if (!bank) return { error: "Which bank?" };
  const kind = ["current", "savings", "cc", "od"].includes(b.kind) ? b.kind : "current";
  return { number, bank, kind, label: String(b.label || "").trim().slice(0, 80) || null, is_active: b.is_active !== false };
}
router.post("/accounts", EDIT, async (req, res) => {
  const a = cleanAccount(req.body);
  if (a.error) return bad(res, a.error);
  const { rows } = await query(
    `INSERT INTO cost_bank_accounts (bank, label, number, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (number) DO NOTHING RETURNING id`,
    [a.bank, a.label, a.number, a.kind]);
  if (!rows.length) return bad(res, "That account number is already in the list.");
  res.json({ id: rows[0].id });
});
router.put("/accounts/:id(\\d+)", EDIT, async (req, res) => {
  const a = cleanAccount(req.body);
  if (a.error) return bad(res, a.error);
  try {
    await query(`UPDATE cost_bank_accounts SET bank = $2, label = $3, number = $4, kind = $5, is_active = $6 WHERE id = $1`,
      [req.params.id, a.bank, a.label, a.number, a.kind, a.is_active]);
  } catch (e) { if (e.code === "23505") return bad(res, "That account number is already in the list."); throw e; }
  res.json({ ok: true });
});

// -------------------------------------------------------------- upload ---
router.post("/upload", EDIT, async (req, res) => {
  const accountId = Number(req.body.account_id);
  const { rows: acc } = await query(`SELECT id FROM cost_bank_accounts WHERE id = $1`, [accountId]);
  if (!acc.length) return bad(res, "Choose which account this statement is for.");
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return bad(res, "No transactions were found in the statement.");
  if (rows.length > 10000) return bad(res, "That statement is too long — upload at most 10,000 lines at a time.");
  const clean = [];
  for (const [i, r] of rows.entries()) {
    const debit = r2(r.debit), credit = r2(r.credit);
    if (!ISO.test(r.date || "") || debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
      return bad(res, `Line ${i + 1} (${r.date || "no date"}): needs a date and either a debit or a credit.`);
    }
    const balance = r.balance == null || r.balance === "" || !Number.isFinite(Number(r.balance)) ? null : r2(r.balance);
    const line = { date: r.date, narration: String(r.narration || "").replace(/\s+/g, " ").trim().slice(0, 1000), reference: String(r.reference || "").trim().slice(0, 120) || null, debit, credit, balance, seq: i };
    clean.push({ ...line, key: dedupeKey(accountId, line) });
  }
  const dates = clean.map((c) => c.date).sort();
  // The period printed on the statement, when it holds every line.
  if (ISO.test(req.body.period_from || "") && ISO.test(req.body.period_to || "") && req.body.period_from <= dates[0] && req.body.period_to >= dates[dates.length - 1]) {
    dates[0] = req.body.period_from; dates[dates.length - 1] = req.body.period_to;
  }
  const client = await pool.connect();
  let added = 0, dup = 0;
  const ids = [];
  try {
    await client.query("BEGIN");
    const { rows: up } = await client.query(
      `INSERT INTO cost_bank_uploads (account_id, file_name, period_from, period_to, opening, closing, lines_read, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [accountId, String(req.body.file_name || "").slice(0, 200) || null, dates[0], dates[dates.length - 1],
        Number.isFinite(Number(req.body.opening)) && req.body.opening !== null ? r2(req.body.opening) : null,
        Number.isFinite(Number(req.body.closing)) && req.body.closing !== null ? r2(req.body.closing) : null, clean.length, req.user.id]);
    const upId = up[0].id;
    const seen = new Map();
    for (const c of clean) {
      // Two identical lines on the same day (two equal UPI payments) stay two lines.
      const n = (seen.get(c.key) || 0) + 1; seen.set(c.key, n);
      const key = n > 1 ? `${c.key}|${n}`.slice(0, 300) : c.key;
      const { rows: ins } = await client.query(
        `INSERT INTO cost_bank_lines (upload_id, account_id, txn_date, narration, reference, debit, credit, balance, seq, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [upId, accountId, c.date, c.narration, c.reference, c.debit, c.credit, c.balance, c.seq, key]);
      if (ins.length) { added++; ids.push(ins[0].id); } else dup++;
    }
    await client.query(`UPDATE cost_bank_uploads SET lines_added = $2, lines_duplicate = $3 WHERE id = $1`, [upId, added, dup]);
    const sorted = ids.length ? await autoSort({ ids, client }) : { counts: {} };
    await client.query("COMMIT");
    res.json({ upload_id: upId, added, duplicates: dup, counts: sorted.counts || {}, from: dates[0], to: dates[dates.length - 1] });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Take back a whole upload (wrong account, wrong file).
router.delete("/uploads/:id(\\d+)", EDIT, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Round 235 — payments the lines posted into ledgers go with them.
    const { rows: posted } = await client.query(`SELECT post_kind, post_id FROM cost_bank_lines WHERE upload_id = $1 AND post_kind IS NOT NULL`, [req.params.id]);
    for (const x of posted) await unpostPayment(client, x.post_kind, x.post_id, req.user.id, "Bank statement upload taken back");
    const { rowCount } = await client.query(`DELETE FROM cost_bank_lines WHERE upload_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM cost_bank_uploads WHERE id = $1`, [req.params.id]);
    await recomputeLoans(client);
    await client.query("COMMIT");
    res.json({ removed: rowCount });
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
});

// --------------------------------------------------------------- lines ---
router.put("/lines/:id(\\d+)", EDIT, async (req, res) => {
  const { rows: cur } = await query(
    `SELECT l.id, l.txn_date::text AS txn_date, l.debit, l.credit, l.narration, l.reference, l.treatment, l.loan_id, l.match_kind, l.post_kind, l.post_id,
            a.bank, a.number
       FROM cost_bank_lines l JOIN cost_bank_accounts a ON a.id = l.account_id WHERE l.id = $1`, [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: "Line not found." });
  const l = cur[0];
  const t = req.body.treatment;
  if (!TREATMENTS.includes(t) || t === "check") return bad(res, "Choose what this line is.");
  let head = null, loanId = null, gst = { pct: null, claim: true };
  if (t === "cost") {
    if (!HEAD_KEYS.has(req.body.head)) return bad(res, "Choose the cost head.");
    head = req.body.head;
    gst = head === "other_income" || n0(l.credit) > 0 ? { pct: 0, claim: true } : gstChoice(req.body, head);
    if (gst.error) return bad(res, gst.error);
  }
  if (t === "loan") {
    loanId = Number(req.body.loan_id);
    const { rows } = await query(`SELECT id FROM cost_bank_loans WHERE id = $1`, [loanId]);
    if (!rows.length) return bad(res, "Choose the loan (add it under Loans first).");
  }
  let interest = null, fixed = false;
  if (t === "loan" && req.body.interest != null && req.body.interest !== "") {
    interest = r2(req.body.interest);
    if (interest < 0 || interest > n0(l.debit)) return bad(res, "Interest must be between 0 and the EMI.");
    fixed = true;
  }
  // Round 235 — a payment to a party, or a vehicle certificate: posted into
  // the ledger / compliance register when the line is saved.
  const posting = t === "pay" || t === "cert";
  if (posting && !(n0(l.debit) > 0)) return bad(res, "Only a payment out (a debit) posts into a ledger.");
  if (t === "pay" && !POST_KINDS.includes(req.body.party_kind)) return bad(res, "Choose who this payment is to.");
  if (posting && req.body.always) return bad(res, "A payment to a party is saved line by line — untick “always”.");
  const acc = `${l.bank} ••${String(l.number).slice(-4)}`;
  const common = {
    amount: n0(l.debit), paid_on: l.txn_date, mode: bankMode(l.narration), reference: bankRef(`${l.reference || ""} ${l.narration || ""}`, `BANK-${l.id}`),
    bank_account: acc, notes: `From the ${acc} statement, ${l.txn_date}${req.body.note ? ` — ${String(req.body.note).slice(0, 120)}` : ""}`,
    user_id: req.user.id, source: "bank", source_id: l.id,
  };
  // Left out keeps its app record only while it stays left out.
  const keepMatch = t === "omit" && l.match_kind;
  let applied = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Whatever this line posted before is undone first.
    if (l.post_kind) await unpostPayment(client, l.post_kind, l.post_id, req.user.id, "Bank statement line changed");
    await client.query(
      `UPDATE cost_bank_lines SET treatment = $2::varchar, head = $3, loan_id = $4, manual = true, set_by = $5, set_at = now(), note = $6,
              interest_fixed = $7::boolean, interest = CASE WHEN $7::boolean THEN $8::numeric ELSE (CASE WHEN $2::varchar = 'loan' THEN interest ELSE NULL END) END,
              principal = CASE WHEN $2::varchar = 'loan' THEN principal ELSE NULL END, rule_id = NULL,
              match_kind = CASE WHEN $9::boolean THEN match_kind ELSE NULL END, match_id = CASE WHEN $9::boolean THEN match_id ELSE NULL END,
              why = CASE WHEN $9::boolean THEN why ELSE NULL END, gst_pct = $10, gst_claim = $11,
              post_kind = NULL, post_id = NULL, party_label = NULL
        WHERE id = $1`,
      [l.id, t, head, loanId, req.user.id, String(req.body.note || "").trim().slice(0, 200) || null, fixed, interest, !!keepMatch,
       t === "cost" ? gst.pct : null, gst.claim]);
    if (req.body.always) {
      const keyword = String(req.body.keyword || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 80);
      if (keyword.length < 3) { await client.query("ROLLBACK"); return bad(res, "For “always”, give a word from the narration (3 letters or more)."); }
      if (!keywordHit(l.narration, keyword)) { await client.query("ROLLBACK"); return bad(res, `“${keyword}” is not in this line's narration.`); }
      if (["omit", "check"].includes(t)) { await client.query("ROLLBACK"); return bad(res, "“Always leave out” can't be a rule — the app leaves a line out only when it finds the payment in its records."); }
      const side = n0(l.debit) > 0 ? "debit" : "credit";
      const { rows: rule } = await client.query(
        `INSERT INTO cost_bank_rules (keyword, side, treatment, head, loan_id, created_by, gst_pct, gst_claim) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (keyword, side) DO UPDATE SET treatment = EXCLUDED.treatment, head = EXCLUDED.head, loan_id = EXCLUDED.loan_id,
                gst_pct = EXCLUDED.gst_pct, gst_claim = EXCLUDED.gst_claim
         RETURNING id`, [keyword, side, t, head, loanId, req.user.id, t === "cost" ? gst.pct : null, gst.claim]);
      await client.query(`UPDATE cost_bank_lines SET rule_id = $2 WHERE id = $1`, [l.id, rule[0].id]);
    }
    if (posting) {
      const b = req.body;
      const out = t === "cert"
        ? await postCertificate(client, { ...common, fee: n0(l.debit), asset_id: b.asset_id, cert_type: b.cert_type, valid_from: b.valid_from || null,
            valid_to: b.valid_to, number: String(b.number || "").trim().slice(0, 60) || null, authority: String(b.authority || "").trim().slice(0, 100) || null })
        : await postPayment(client, { ...common, kind: b.party_kind, party_id: b.party_id, bill_id: b.bill_id, allocations: b.allocations,
            tds: n0(b.tds), replacing: l.post_kind === b.party_kind ? l.post_id : null });
      // The line claims what it posted, so no other line is matched to it.
      const claimKind = out.kind === "certificate" ? "maintenance" : out.kind;
      const claimId = out.kind === "certificate" ? out.payment_id : out.id;
      await client.query(
        `UPDATE cost_bank_lines SET post_kind = $2, post_id = $3, party_label = $4, match_kind = $5, match_id = $6, why = $7 WHERE id = $1`,
        [l.id, out.kind, out.id, String(out.label).slice(0, 200), claimKind, claimId, `Posted → ${postWhere(out.kind)}`]);
    }
    await recomputeLoans(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return bad(res, err.message);
    throw err;
  } finally { client.release(); }
  // Round 232 — the other unsorted lines are sorted AFTER the rule is saved:
  // sorting reads the rules outside this transaction, so inside it the new
  // rule was not seen and "always" sorted nothing until the next re-sort.
  if (req.body.always) {
    const { rows: others } = await query(`SELECT id FROM cost_bank_lines WHERE NOT manual AND treatment = 'todo' AND id <> $1`, [l.id]);
    if (others.length) { const r = await autoSort({ ids: others.map((o) => o.id) }); applied = others.length - (r.counts?.todo || 0); }
  }
  res.json({ ok: true, applied });
});

// Undo a choice made by hand: the app sorts the line again.
router.post("/lines/:id(\\d+)/reset", EDIT, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT post_kind, post_id FROM cost_bank_lines WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (rows[0]?.post_kind) await unpostPayment(client, rows[0].post_kind, rows[0].post_id, req.user.id, "Bank statement line reset");
    await client.query(`UPDATE cost_bank_lines SET manual = false, note = NULL, interest_fixed = false, set_by = NULL, set_at = NULL,
                               post_kind = NULL, post_id = NULL, party_label = NULL WHERE id = $1`, [req.params.id]);
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  await autoSort({ ids: [Number(req.params.id)] });
  res.json({ ok: true });
});

// Sort again every line not set by hand (after payments were entered in the app).
router.post("/resort", EDIT, async (_req, res) => {
  res.json(await autoSort());
});

// ------------------------------------------------- parties (Round 235) ---
router.get("/parties", VIEW, async (_req, res) => { res.json(await partyOptions()); });
router.get("/party-bills", VIEW, async (req, res) => {
  const kind = String(req.query.kind || "");
  const id = Number(req.query.id);
  if (!["supplier", "contractor"].includes(kind) || !Number.isInteger(id)) return res.json([]);
  let without = null;
  if (req.query.line) {
    const { rows } = await query(`SELECT post_kind, post_id FROM cost_bank_lines WHERE id = $1`, [Number(req.query.line)]);
    if (rows[0]?.post_kind === kind) without = rows[0].post_id;
  }
  res.json(await partyBills(kind, id, without));
});

// --------------------------------------------------------------- rules ---
router.delete("/rules/:id(\\d+)", EDIT, async (req, res) => {
  await query(`UPDATE cost_bank_lines SET rule_id = NULL WHERE rule_id = $1`, [req.params.id]);
  await query(`DELETE FROM cost_bank_rules WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});
router.post("/rules", EDIT, async (req, res) => {
  const keyword = String(req.body.keyword || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 80);
  if (keyword.length < 3) return bad(res, "The word to look for: 3 letters or more.");
  const side = ["debit", "credit", "any"].includes(req.body.side) ? req.body.side : "debit";
  const t = req.body.treatment;
  if (!TREATMENTS.includes(t) || ["omit", "check", "todo", "pay", "cert"].includes(t)) return bad(res, "Choose what such lines are.");
  const head = t === "cost" ? req.body.head : null;
  if (t === "cost" && !HEAD_KEYS.has(head)) return bad(res, "Choose the cost head.");
  const loanId = t === "loan" ? Number(req.body.loan_id) || null : null;
  if (t === "loan" && !loanId) return bad(res, "Choose the loan.");
  const gst = t === "cost" && head !== "other_income" && side !== "credit" ? gstChoice(req.body, head) : { pct: t === "cost" ? 0 : null, claim: true };
  if (gst.error) return bad(res, gst.error);
  await query(
    `INSERT INTO cost_bank_rules (keyword, side, treatment, head, loan_id, created_by, gst_pct, gst_claim) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (keyword, side) DO UPDATE SET treatment = EXCLUDED.treatment, head = EXCLUDED.head, loan_id = EXCLUDED.loan_id,
            gst_pct = EXCLUDED.gst_pct, gst_claim = EXCLUDED.gst_claim`,
    [keyword, side, t, head, loanId, req.user.id, gst.pct, gst.claim]);
  const { rows: todo } = await query(`SELECT id FROM cost_bank_lines WHERE NOT manual AND treatment = 'todo'`);
  if (todo.length) await autoSort({ ids: todo.map((x) => x.id) });
  res.json({ ok: true });
});

// --------------------------------------------------------------- loans ---
function cleanLoan(b) {
  const name = String(b.name || "").trim().slice(0, 100);
  if (!name) return { error: "Give the loan a name (e.g. Term loan — plant machinery)." };
  const rate = Number(b.rate_pct);
  if (!(rate >= 0 && rate < 40)) return { error: "Interest rate: % a year, e.g. 9.25." };
  const out = Number(b.opening_outstanding);
  if (!(out >= 0)) return { error: "Balance outstanding: the amount owed on the start date." };
  if (!ISO.test(b.opening_date || "")) return { error: "The date that balance is on." };
  const emi = b.emi === "" || b.emi == null ? null : Number(b.emi);
  if (emi != null && !(emi > 0)) return { error: "EMI: the monthly amount, or leave it blank." };
  return { name, rate, out: r2(out), date: b.opening_date, emi: emi == null ? null : r2(emi),
    lender: String(b.lender || "").trim().slice(0, 80) || null, kind: ["term", "vehicle", "other"].includes(b.kind) ? b.kind : "term",
    account_id: Number(b.account_id) || null, match_text: String(b.match_text || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 80) || null,
    is_active: b.is_active !== false, notes: String(b.notes || "").trim().slice(0, 300) || null };
}
async function afterLoanChange() {
  await recomputeLoans();
  const { rows } = await query(`SELECT id FROM cost_bank_lines WHERE NOT manual AND treatment IN ('todo', 'loan')`);
  if (rows.length) await autoSort({ ids: rows.map((r) => r.id) });
}
router.post("/loans", EDIT, async (req, res) => {
  const l = cleanLoan(req.body);
  if (l.error) return bad(res, l.error);
  const { rows } = await query(
    `INSERT INTO cost_bank_loans (name, lender, kind, account_id, match_text, rate_pct, emi, opening_outstanding, opening_date, is_active, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [l.name, l.lender, l.kind, l.account_id, l.match_text, l.rate, l.emi, l.out, l.date, l.is_active, l.notes, req.user.id]);
  await afterLoanChange();
  res.json({ id: rows[0].id });
});
router.put("/loans/:id(\\d+)", EDIT, async (req, res) => {
  const l = cleanLoan(req.body);
  if (l.error) return bad(res, l.error);
  await query(
    `UPDATE cost_bank_loans SET name=$2, lender=$3, kind=$4, account_id=$5, match_text=$6, rate_pct=$7, emi=$8, opening_outstanding=$9,
            opening_date=$10, is_active=$11, notes=$12 WHERE id = $1`,
    [req.params.id, l.name, l.lender, l.kind, l.account_id, l.match_text, l.rate, l.emi, l.out, l.date, l.is_active, l.notes]);
  await afterLoanChange();
  res.json({ ok: true });
});

export default router;
