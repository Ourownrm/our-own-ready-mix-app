// Round 236 — Cost → GST payable. The rules are in lib/gstBook.js.
// Administrator by default (cost.gst); a Super Admin can give it to the Accountant.
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { istMonth, istDay } from "../lib/istDate.js";
import { ensureRound236, gstMonth, invKey, MONTH_RE } from "../lib/gstBook.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound236(); next(); } catch (e) { next(e); } });
const VIEW = requirePermission("cost.gst", "view");
const EDIT = requirePermission("cost.gst", "edit");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const money = (v) => { const x = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) ? r2(x) : 0; };

router.get("/", VIEW, async (req, res) => {
  const now = istMonth();
  const ym = req.query.month || now;
  if (!MONTH_RE.test(ym) || ym > now) return bad(res, "Pick a month (YYYY-MM).");
  res.json(await gstMonth(ym));
});

// The quiet flag: this bill came WITHOUT tax (no credit). Accountant only.
const FLAG_TABLE = { receipt: "rm_receipts", mnt_bill: "mnt_bills", contractor_bill: "hr_contractor_bills" };
router.post("/flag", EDIT, async (req, res) => {
  const t = FLAG_TABLE[req.body?.src];
  const id = Number(req.body?.id);
  if (!t || !Number.isInteger(id)) return bad(res, "Which purchase?");
  const on = req.body.no_tax === true;
  const { rowCount } = await query(
    `UPDATE ${t} SET no_tax = $2, no_tax_by = $3, no_tax_at = now() WHERE id = $1`, [id, on, req.user.id]);
  if (!rowCount) return bad(res, "That purchase is not there any more.", 404);
  res.json({ ok: true, no_tax: on });
});

// GSTR-2B: the lines read from the portal's Excel (read in the browser).
router.post("/2b", EDIT, async (req, res) => {
  const period = String(req.body?.period || "");
  if (!MONTH_RE.test(period) || period > istMonth()) return bad(res, "Which month's GSTR-2B is this?");
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (!lines.length) return bad(res, "No invoice lines were found in the file.");
  if (lines.length > 20000) return bad(res, "That is more lines than a GSTR-2B should have.");
  const clean = [];
  for (const l of lines) {
    const gstin = String(l.gstin || "").toUpperCase().replace(/\s/g, "");
    if (!/^\d{2}[A-Z0-9]{13}$/.test(gstin)) continue;
    const day = ISO.test(l.inv_date || "") ? l.inv_date : null;
    clean.push([gstin, String(l.trade_name || "").slice(0, 200) || null, String(l.inv_no || "").trim().slice(0, 60) || null, day,
      l.inv_value == null || l.inv_value === "" ? null : money(l.inv_value), money(l.taxable), money(l.igst), money(l.cgst), money(l.sgst), money(l.cess),
      !!l.rcm, l.itc_ok !== false, ["inv", "cn", "dn"].includes(l.kind) ? l.kind : "inv"]);
  }
  if (!clean.length) return bad(res, "No line had a supplier GSTIN — is this the GSTR-2B Excel (B2B sheet)?");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Kept: which lines were set aside ("ignore"), by GSTIN + invoice.
    const { rows: ig } = await client.query(
      `SELECT l.gstin, l.inv_no FROM gst_2b_lines l JOIN gst_2b_uploads u ON u.id = l.upload_id WHERE u.period = $1 AND l.ignored`, [period]);
    const ignored = new Set(ig.map((x) => `${x.gstin}|${invKey(x.inv_no)}`));
    await client.query(`DELETE FROM gst_2b_uploads WHERE period = $1`, [period]);
    const { rows: up } = await client.query(
      `INSERT INTO gst_2b_uploads (period, file_name, lines, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [period, String(req.body.file_name || "").slice(0, 200) || null, clean.length, req.user.id]);
    for (let i = 0; i < clean.length; i += 500) {
      const chunk = clean.slice(i, i + 500);
      const vals = [], params = [];
      chunk.forEach((c, j) => {
        const b = j * 16;
        vals.push(`(${Array.from({ length: 16 }, (_, k) => `$${b + k + 1}`).join(",")})`);
        params.push(up[0].id, period, ...c, ignored.has(`${c[0]}|${invKey(c[2])}`));
      });
      await client.query(
        `INSERT INTO gst_2b_lines (upload_id, period, gstin, trade_name, inv_no, inv_date, inv_value, taxable, igst, cgst, sgst, cess, rcm, itc_ok, kind, ignored)
         VALUES ${vals.join(",")}`, params);
    }
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  res.json({ ok: true, lines: clean.length, skipped: lines.length - clean.length });
});
router.delete("/2b/:period", EDIT, async (req, res) => {
  const { rowCount } = await query(`DELETE FROM gst_2b_uploads WHERE period = $1`, [req.params.period]);
  res.json({ removed: rowCount });
});
router.post("/2b-lines/:id(\\d+)/ignore", EDIT, async (req, res) => {
  await query(`UPDATE gst_2b_lines SET ignored = $2, ignored_by = $3 WHERE id = $1`, [req.params.id, req.body?.ignored !== false, req.user.id]);
  res.json({ ok: true });
});

// Challans paid (CPIN).
router.post("/challans", EDIT, async (req, res) => {
  const b = req.body || {};
  if (!MONTH_RE.test(b.month || "")) return bad(res, "Which month's tax is this for?");
  if (!ISO.test(b.paid_on || "") || b.paid_on > istDay()) return bad(res, "The date paid (not in the future).");
  const v = { igst: money(b.igst), cgst: money(b.cgst), sgst: money(b.sgst), interest: money(b.interest), late_fee: money(b.late_fee) };
  if (Object.values(v).some((x) => x < 0)) return bad(res, "Amounts can't be negative.");
  if (!Object.values(v).some((x) => x > 0)) return bad(res, "Enter what was paid.");
  const { rows } = await query(
    `INSERT INTO gst_challans (month, cpin, paid_on, igst, cgst, sgst, interest, late_fee, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [b.month, String(b.cpin || "").trim().slice(0, 30) || null, b.paid_on, v.igst, v.cgst, v.sgst, v.interest, v.late_fee,
      String(b.note || "").trim().slice(0, 200) || null, req.user.id]);
  res.json({ ok: true, id: rows[0].id });
});
router.delete("/challans/:id(\\d+)", EDIT, async (req, res) => {
  await query(`UPDATE gst_challans SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// Where the working starts, and the credit already in the ledger then.
router.put("/settings", EDIT, async (req, res) => {
  const b = req.body || {};
  if (!MONTH_RE.test(b.from_month || "") || b.from_month > istMonth()) return bad(res, "Start month: YYYY-MM.");
  const st = String(b.our_state || "32").padStart(2, "0").slice(0, 2);
  if (!/^\d{2}$/.test(st)) return bad(res, "State code: two digits (Kerala is 32).");
  const o = { igst: money(b.open_igst), cgst: money(b.open_cgst), sgst: money(b.open_sgst) };
  if (Object.values(o).some((x) => x < 0)) return bad(res, "Opening credit can't be negative.");
  await query(
    `UPDATE gst_settings SET from_month = $1, our_state = $2, open_igst = $3, open_cgst = $4, open_sgst = $5, updated_by = $6, updated_at = now() WHERE id = 1`,
    [b.from_month, st, o.igst, o.cgst, o.sgst, req.user.id]);
  res.json({ ok: true });
});

export default router;
