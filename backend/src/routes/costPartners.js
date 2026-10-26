// Round 242 — Cost → Partners: capital and unsecured loans from partners.
// Same permission as Bank statements and Loans (cost.bank). Rules and
// arithmetic: lib/partners.js.
//   GET    /api/cost/partners?as_of=YYYY-MM-DD   the page
//   POST   /api/cost/partners/partners           add a partner
//   PUT    /api/cost/partners/partners/:id       change a partner
//   PUT    /api/cost/partners/settings           loan rate, TDS rate, rate changes
//   POST   /api/cost/partners/upload             lines read from a bank statement
//   DELETE /api/cost/partners/uploads/:id        take an upload back
//   POST   /api/cost/partners/txns               one entry by hand
//   PUT    /api/cost/partners/txns/:id           change an entry
//   DELETE /api/cost/partners/txns/:id           remove an entry
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { ensurePartners, partnersReport, partnerSettings } from "../lib/partners.js";
import { istDay } from "../lib/istDate.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensurePartners(); next(); } catch (e) { next(e); } });
const VIEW = requirePermission("cost.bank", "view");
const EDIT = requirePermission("cost.bank", "edit");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ["capital_in", "capital_out", "loan_in", "loan_out", "interest_paid", "interest_due"];
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const money = (v) => {
  const n = Math.round(Number(String(v ?? "").replace(/[,₹\s]/g, "")) * 100) / 100;
  return Number.isFinite(n) ? n : NaN;
};
const istToday = () => istDay();

router.get("/", VIEW, async (req, res) => {
  const asOf = DAY_RE.test(req.query.as_of || "") ? req.query.as_of : istToday();
  res.json(await partnersReport(asOf));
});

// ------------------------------------------------------------- partners ---
function partnerBody(b) {
  return {
    name: String(b.name || "").trim().slice(0, 120),
    match_words: String(b.match_words || "").trim().slice(0, 300) || null,
    pan: String(b.pan || "").trim().toUpperCase().slice(0, 12) || null,
    is_active: b.is_active !== false,
  };
}
router.post("/partners", EDIT, async (req, res) => {
  const p = partnerBody(req.body || {});
  if (!p.name) return bad(res, "Type the partner's name.");
  if (p.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(p.pan)) return bad(res, "PAN looks wrong (5 letters, 4 digits, 1 letter).");
  try {
    const { rows } = await query(`INSERT INTO cost_partners (name, match_words, pan, is_active) VALUES ($1,$2,$3,$4) RETURNING id`,
      [p.name, p.match_words, p.pan, p.is_active]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return bad(res, "A partner with that name is already there.", 409);
    throw err;
  }
});
router.put("/partners/:id(\\d+)", EDIT, async (req, res) => {
  const p = partnerBody(req.body || {});
  if (!p.name) return bad(res, "Type the partner's name.");
  if (p.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(p.pan)) return bad(res, "PAN looks wrong (5 letters, 4 digits, 1 letter).");
  const r = await query(`UPDATE cost_partners SET name=$1, match_words=$2, pan=$3, is_active=$4 WHERE id=$5`,
    [p.name, p.match_words, p.pan, p.is_active, Number(req.params.id)]).catch((err) => {
    if (err.code === "23505") return { dup: true };
    throw err;
  });
  if (r.dup) return bad(res, "A partner with that name is already there.", 409);
  if (!r.rowCount) return bad(res, "Partner not found.", 404);
  res.json({ ok: true });
});

// ------------------------------------------------------------- settings ---
router.put("/settings", EDIT, async (req, res) => {
  const b = req.body || {};
  const rate = Number(b.loan_rate), tds = Number(b.tds_rate);
  if (!(rate >= 0 && rate <= 50)) return bad(res, "Interest rate: 0 to 50 % a year.");
  if (!(tds >= 0 && tds <= 40)) return bad(res, "TDS rate: 0 to 40 %.");
  const changes = Array.isArray(b.rates) ? b.rates : [];
  for (const c of changes) {
    if (!DAY_RE.test(c.from_date || "") || !(Number(c.rate) >= 0 && Number(c.rate) <= 50)) return bad(res, "Each rate change needs a date and a rate (0–50 %).");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE cost_partner_settings SET loan_rate = $1, tds_rate = $2 WHERE id = 1`, [rate, tds]);
    await client.query(`DELETE FROM cost_partner_rates`);
    for (const c of changes) {
      await client.query(`INSERT INTO cost_partner_rates (from_date, rate) VALUES ($1, $2) ON CONFLICT (from_date) DO UPDATE SET rate = EXCLUDED.rate`, [c.from_date, Number(c.rate)]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ settings: await partnerSettings() });
});

// -------------------------------------------------------------- entries ---
function txnBody(b) {
  const t = {
    partner_id: Number(b.partner_id), kind: String(b.kind || ""), txn_date: String(b.txn_date || b.date || ""),
    amount: money(b.amount), tds: b.tds === "" || b.tds == null ? 0 : money(b.tds),
    narration: b.narration ? String(b.narration).slice(0, 1000) : null, note: b.note ? String(b.note).trim().slice(0, 200) : null,
    // Round 244 — a loan's own "interest from" date (blank = the day it came in).
    interest_from: b.kind === "loan_in" && DAY_RE.test(String(b.interest_from || "")) ? String(b.interest_from) : null,
  };
  if (!(t.partner_id > 0)) return { err: "Choose the partner." };
  if (!KINDS.includes(t.kind)) return { err: "Choose what the entry is." };
  if (!DAY_RE.test(t.txn_date)) return { err: "Date must be yyyy-mm-dd." };
  // Round 244 — interest paid may be negative: a reversal of interest paid too early.
  if (t.kind === "interest_paid" ? !(Number.isFinite(t.amount) && t.amount !== 0) : !(t.amount > 0)) {
    return { err: t.kind === "interest_paid" ? "Amount can't be 0 (negative = interest reversed)." : "Amount must be more than 0." };
  }
  if (!(t.tds >= 0)) return { err: "TDS must be 0 or more." };
  if (t.kind !== "interest_paid") t.tds = 0;
  return { t };
}

router.post("/txns", EDIT, async (req, res) => {
  const { t, err } = txnBody(req.body || {});
  if (err) return bad(res, err);
  const { rows } = await query(
    `INSERT INTO cost_partner_txns (partner_id, kind, txn_date, amount, tds, narration, note, created_by, interest_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [t.partner_id, t.kind, t.txn_date, t.amount, t.tds, t.narration, t.note, req.user.id, t.interest_from]);
  res.status(201).json({ id: rows[0].id });
});
router.put("/txns/:id(\\d+)", EDIT, async (req, res) => {
  const { t, err } = txnBody(req.body || {});
  if (err) return bad(res, err);
  const r = await query(
    `UPDATE cost_partner_txns SET partner_id=$1, kind=$2, txn_date=$3, amount=$4, tds=$5, note=$6, interest_from=$8 WHERE id=$7`,
    [t.partner_id, t.kind, t.txn_date, t.amount, t.tds, t.note, Number(req.params.id), t.interest_from]);
  if (!r.rowCount) return bad(res, "Entry not found.", 404);
  res.json({ ok: true });
});
router.delete("/txns/:id(\\d+)", EDIT, async (req, res) => {
  const r = await query(`DELETE FROM cost_partner_txns WHERE id = $1`, [Number(req.params.id)]);
  if (!r.rowCount) return bad(res, "Entry not found.", 404);
  res.json({ ok: true });
});

// --------------------------------------------------------------- upload ---
// The statement is read in the browser (the same reader as Bank statements);
// this receives the lines the person kept, each with its partner and kind.
router.post("/upload", EDIT, async (req, res) => {
  const b = req.body || {};
  const book = b.book === "loan" ? "loan" : b.book === "capital" ? "capital" : null;
  if (!book) return bad(res, "Choose Capital or Unsecured loans.");
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) return bad(res, "No lines to save.");
  if (lines.length > 3000) return bad(res, "Too many lines in one upload (3,000 at most).");
  const allowed = book === "capital" ? ["capital_in", "capital_out"] : ["loan_in", "loan_out", "interest_paid"];
  const clean = [];
  for (const [i, l] of lines.entries()) {
    const { t, err } = txnBody(l);
    if (err) return bad(res, `Line ${i + 1}: ${err}`);
    if (!allowed.includes(t.kind)) return bad(res, `Line ${i + 1}: not a ${book === "capital" ? "capital" : "loan"} entry.`);
    t.dedupe_key = [book, t.partner_id, t.kind, t.txn_date, t.amount.toFixed(2), String(t.narration || "").replace(/\s+/g, " ").slice(0, 150)].join("|");
    clean.push(t);
  }
  const client = await pool.connect();
  let added = 0, dup = 0, uploadId;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO cost_partner_uploads (book, file_name, lines, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [book, String(b.file_name || "").slice(0, 200) || null, clean.length, req.user.id]);
    uploadId = rows[0].id;
    for (const t of clean) {
      const r = await client.query(
        `INSERT INTO cost_partner_txns (partner_id, kind, txn_date, amount, tds, narration, note, upload_id, dedupe_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (dedupe_key) DO NOTHING`,
        [t.partner_id, t.kind, t.txn_date, t.amount, t.tds, t.narration, t.note, uploadId, t.dedupe_key, req.user.id]);
      if (r.rowCount) added++; else dup++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json({ upload_id: uploadId, added, duplicates: dup });
});

// Round 244 — the owner's own "Investment & Loan" workbook, read in the
// browser (lib/partnerSheetImport.js): partners by name (made when new),
// investments as capital, partner's loans with their interest start date,
// pay-backs, interest paid by date (TDS from the summary sheet), and the
// sheet's own totals kept to compare with. "Replace" takes back the previous
// sheet import first.
router.post("/import-sheet", EDIT, async (req, res) => {
  const b = req.body || {};
  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (!entries.length) return bad(res, "Nothing to import.");
  if (entries.length > 5000) return bad(res, "Too many lines (5,000 at most).");
  const names = [...new Set(entries.map((e) => String(e.partner || "").trim()).filter(Boolean))];
  const client = await pool.connect();
  let added = 0, dup = 0, removed = 0, made = 0, uploadId;
  try {
    await client.query("BEGIN");
    if (b.replace) {
      const { rows: old } = await client.query(`SELECT id FROM cost_partner_uploads WHERE book = 'sheet'`);
      for (const o of old) {
        removed += (await client.query(`DELETE FROM cost_partner_txns WHERE upload_id = $1`, [o.id])).rowCount;
        await client.query(`DELETE FROM cost_partner_uploads WHERE id = $1`, [o.id]);
      }
    }
    const ids = new Map();
    for (const n of names) {
      const { rows } = await client.query(`SELECT id FROM cost_partners WHERE lower(name) = lower($1)`, [n]);
      if (rows.length) ids.set(n, rows[0].id);
      else { ids.set(n, (await client.query(`INSERT INTO cost_partners (name, match_words) VALUES ($1, $2) RETURNING id`, [n.slice(0, 120), n.toUpperCase().slice(0, 300)])).rows[0].id); made++; }
    }
    const { rows: up } = await client.query(
      `INSERT INTO cost_partner_uploads (book, file_name, lines, uploaded_by, sheet_check) VALUES ('sheet', $1, $2, $3, $4::jsonb) RETURNING id`,
      [String(b.file_name || "").slice(0, 200) || null, entries.length, req.user.id, b.check ? JSON.stringify(b.check) : null]);
    uploadId = up[0].id;
    for (const [i, e] of entries.entries()) {
      const { t, err } = txnBody({ ...e, partner_id: ids.get(String(e.partner || "").trim()) });
      if (err) throw Object.assign(new Error(`Line ${i + 1} (${e.partner || "?"}, ${e.txn_date || "?"}): ${err}`), { expose: true });
      const key = ["sheet", t.partner_id, t.kind, t.txn_date, t.amount.toFixed(2), String(t.narration || "").replace(/\s+/g, " ").slice(0, 120), e.seq ?? i].join("|");
      const r = await client.query(
        `INSERT INTO cost_partner_txns (partner_id, kind, txn_date, amount, tds, narration, note, upload_id, dedupe_key, created_by, interest_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) DO NOTHING`,
        [t.partner_id, t.kind, t.txn_date, t.amount, t.tds, t.narration, t.note, uploadId, key, req.user.id, t.interest_from]);
      if (r.rowCount) added++; else dup++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.expose) return bad(res, err.message);
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json({ upload_id: uploadId, added, duplicates: dup, removed, partners_made: made });
});

router.delete("/uploads/:id(\\d+)", EDIT, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`DELETE FROM cost_partner_txns WHERE upload_id = $1`, [id]);
  await query(`DELETE FROM cost_partner_uploads WHERE id = $1`, [id]);
  res.json({ removed: r.rowCount });
});

export default router;
