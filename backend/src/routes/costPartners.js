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
//   POST   /api/cost/partners/sheet-close        sheet confirmed: hide the check and the import ({open:true} undoes)
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
  // Round 247 — or 0 with TDS: TDS deducted on interest with nothing paid out that day.
  if (t.kind === "interest_paid" ? !(Number.isFinite(t.amount) && (t.amount !== 0 || t.tds > 0)) : !(t.amount > 0)) {
    return { err: t.kind === "interest_paid" ? "Enter the amount paid, the TDS deducted, or both." : "Amount must be more than 0." };
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
  const { rows: closed } = await query(`SELECT sheet_closed_at FROM cost_partner_settings WHERE id = 1`);
  if (closed[0]?.sheet_closed_at) return bad(res, "The sheet import is closed — the sheet was confirmed and entries are made in the app now. Partners & rates can open it again.", 409);
  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (!entries.length) return bad(res, "Nothing to import.");
  if (entries.length > 5000) return bad(res, "Too many lines (5,000 at most).");
  // Round 245 — which parts to take (capital already entered from the bank
  // statement is left out), and which existing partner each sheet name is.
  const parts = { capital: b.parts?.capital !== false, loans: b.parts?.loans !== false };
  const map = b.map && typeof b.map === "object" ? b.map : {};
  const wanted = entries.filter((e) => (["capital_in", "capital_out"].includes(e.kind) ? parts.capital : parts.loans));
  if (!wanted.length) return bad(res, "Nothing chosen to import.");
  const names = [...new Set(wanted.map((e) => String(e.partner || "").trim()).filter(Boolean))];
  const client = await pool.connect();
  let added = 0, dup = 0, removed = 0, made = 0, uploadId;
  try {
    await client.query("BEGIN");
    if (b.replace) {
      const { rows: old } = await client.query(`SELECT id FROM cost_partner_uploads WHERE book = 'sheet'`);
      for (const o of old) {
        removed += (await client.query(`DELETE FROM cost_partner_txns WHERE upload_id = $1`, [o.id])).rowCount;
        await client.query(`DELETE FROM cost_partner_uploads WHERE id = $1`, [o.id]);
        await dropEmptyMadeBy(client, o.id);
      }
    }
    const { rows: up } = await client.query(
      `INSERT INTO cost_partner_uploads (book, file_name, lines, uploaded_by) VALUES ('sheet', $1, $2, $3) RETURNING id`,
      [String(b.file_name || "").slice(0, 200) || null, wanted.length, req.user.id]);
    uploadId = up[0].id;
    const ids = new Map();
    for (const n of names) {
      const pick = map[n];
      if (pick && pick !== "new") {
        const { rows } = await client.query(`SELECT id FROM cost_partners WHERE id = $1`, [Number(pick)]);
        if (!rows.length) throw Object.assign(new Error(`The partner chosen for "${n}" is not there any more — read the sheet again.`), { expose: true });
        ids.set(n, rows[0].id);
        continue;
      }
      const { rows } = pick === "new" ? { rows: [] } : await client.query(`SELECT id FROM cost_partners WHERE lower(name) = lower($1)`, [n]);
      if (rows.length) ids.set(n, rows[0].id);
      else {
        ids.set(n, (await client.query(`INSERT INTO cost_partners (name, match_words, made_by_upload) VALUES ($1, $2, $3) RETURNING id`,
          [n.slice(0, 120), n.toUpperCase().slice(0, 300), uploadId])).rows[0].id);
        made++;
      }
    }
    // The sheet's own totals, with which partner each sheet name became, to compare with.
    if (b.check) {
      // Names whose rows were all left out (e.g. capital only) still point at
      // their partner for the comparison — never a new partner for them.
      const allIds = new Map(ids);
      for (const n of Object.keys(b.check.partners || {})) {
        if (allIds.has(n)) continue;
        const pick = map[n];
        const { rows } = pick && pick !== "new"
          ? await client.query(`SELECT id FROM cost_partners WHERE id = $1`, [Number(pick)])
          : await client.query(`SELECT id FROM cost_partners WHERE lower(name) = lower($1)`, [n]);
        if (rows.length) allIds.set(n, rows[0].id);
      }
      const check = { ...b.check, ids: Object.fromEntries([...allIds.entries()]) };
      await client.query(`UPDATE cost_partner_uploads SET sheet_check = $1::jsonb WHERE id = $2`, [JSON.stringify(check), uploadId]);
    }
    for (const [i, e] of wanted.entries()) {
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

// Round 247 — the owner confirms the imported sheet is right: the comparison
// and the sheet import go away (open = true brings them back).
router.post("/sheet-close", EDIT, async (req, res) => {
  const open = req.body?.open === true;
  await query(`UPDATE cost_partner_settings SET sheet_closed_at = ${open ? "NULL" : "now()"}, sheet_closed_by = $1 WHERE id = 1`, [open ? null : req.user.id]);
  res.json({ closed: !open });
});

router.delete("/uploads/:id(\\d+)", EDIT, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`DELETE FROM cost_partner_txns WHERE upload_id = $1`, [id]);
  await query(`DELETE FROM cost_partner_uploads WHERE id = $1`, [id]);
  const gone = await dropEmptyMadeBy({ query }, id);
  res.json({ removed: r.rowCount, partners_removed: gone });
});

// Round 245 — partners the upload made, left with no entries, go with it.
async function dropEmptyMadeBy(db, uploadId) {
  const r = await db.query(
    `DELETE FROM cost_partners p WHERE p.made_by_upload = $1
        AND NOT EXISTS (SELECT 1 FROM cost_partner_txns t WHERE t.partner_id = p.id)`, [uploadId]);
  return r.rowCount;
}

// Round 245 — the same partner entered twice (two spellings): move every
// entry of one onto the other, keep the PAN and the bank-line words of both,
// and remove the one merged away.
router.post("/partners/:id(\\d+)/merge", EDIT, async (req, res) => {
  const from = Number(req.params.id), into = Number(req.body?.into);
  if (!(into > 0) || into === from) return bad(res, "Choose the partner to merge into.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT id, name, match_words, pan FROM cost_partners WHERE id = ANY($1::int[]) FOR UPDATE`, [[from, into]]);
    const a = rows.find((x) => x.id === from), b = rows.find((x) => x.id === into);
    if (!a || !b) { await client.query("ROLLBACK"); return bad(res, "Partner not found.", 404); }
    const moved = (await client.query(`UPDATE cost_partner_txns SET partner_id = $1 WHERE partner_id = $2`, [into, from])).rowCount;
    const words = [...new Set([b.match_words, a.match_words, a.name.toUpperCase()].filter(Boolean).flatMap((w) => w.split(/\s*[,;]\s*/)).filter(Boolean))].join(", ").slice(0, 300);
    await client.query(`UPDATE cost_partners SET match_words = $1, pan = COALESCE(pan, $2) WHERE id = $3`, [words, a.pan, into]);
    await client.query(`DELETE FROM cost_partners WHERE id = $1`, [from]);
    // A sheet check that pointed at the merged partner now points at the one kept.
    await client.query(
      `UPDATE cost_partner_uploads SET sheet_check = jsonb_set(sheet_check, '{ids}',
          (SELECT COALESCE(jsonb_object_agg(k, CASE WHEN v::text = $1::text THEN to_jsonb($2::int) ELSE v END), '{}'::jsonb)
             FROM jsonb_each(sheet_check->'ids') AS e(k, v)))
        WHERE sheet_check ? 'ids'`, [String(from), into]);
    await client.query("COMMIT");
    res.json({ moved, kept: b.name, removed: a.name });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// A partner with no entries can be removed.
router.delete("/partners/:id(\\d+)", EDIT, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM cost_partner_txns WHERE partner_id = $1`, [id]);
  if (rows[0].n) return bad(res, `This partner has ${rows[0].n} entr${rows[0].n === 1 ? "y" : "ies"} — merge it into the right partner instead, or remove the entries first.`, 409);
  const r = await query(`DELETE FROM cost_partners WHERE id = $1`, [id]);
  if (!r.rowCount) return bad(res, "Partner not found.", 404);
  res.json({ ok: true });
});

// Every partner with no entries at all.
router.post("/partners/remove-empty", EDIT, async (_req, res) => {
  const r = await query(`DELETE FROM cost_partners p WHERE NOT EXISTS (SELECT 1 FROM cost_partner_txns t WHERE t.partner_id = p.id) RETURNING name`);
  res.json({ removed: r.rowCount, names: r.rows.map((x) => x.name) });
});

export default router;
