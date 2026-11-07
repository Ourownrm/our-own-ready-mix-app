// Round 271 — Accounts › B2C → Tally (mock-up "B2C Invoices to Tally Mockup").
//
//   GET  /api/accounts/tally/b2c?month=&state=&q=     the list, counts, next number, bridge status     accounts.tally-b2c · view
//   GET  /api/accounts/tally/b2c/:id                   one invoice to verify: lines, checks, number      accounts.tally-b2c · view
//   POST /api/accounts/tally/b2c/:id/approve           { voucher_no, date }                               accounts.tally-b2c · edit
//   POST /api/accounts/tally/b2c/:id/send-back         { note }                                           accounts.tally-b2c · edit
//   POST /api/accounts/tally/b2c/:id/reopen            approved / failed → to verify (keeps the number)   accounts.tally-b2c · edit
//   POST /api/accounts/tally/b2c/post                  { ids } — Post to Tally                            accounts.tally-b2c · edit
//   POST /api/accounts/tally/b2c/unqueue               { ids } — stop ones the bridge hasn't picked up    accounts.tally-b2c · edit
//   POST /api/accounts/tally/b2c/mark-entered          { ids } — entered in Tally by hand                 accounts.tally-b2c · edit
//   POST /api/accounts/tally/b2c/xml                   { ids } — the XML for Tally › Import               accounts.tally-b2c · edit
//   GET  /api/accounts/tally/settings                                                                     accounts.tally-settings · view
//   PUT  /api/accounts/tally/settings                                                                     accounts.tally-settings · edit
//   POST /api/accounts/tally/bridge-file               { api_base } — a new bridge file (old one stops)   accounts.tally-settings · edit
//   POST /api/accounts/tally/check                     ask Tally which ledgers exist                      accounts.tally-settings · edit
//
// Only B2C invoices (no GSTIN) dated on or after the start date in settings
// are in this list. Nothing reaches Tally except through "post".
import { Router } from "express";
import crypto from "node:crypto";
import { query, pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { istDay } from "../lib/istDate.js";
import { ensureRound251 } from "../lib/round251Schema.js";
import { ensureRound255 } from "../lib/round255Schema.js";
import { ensureRound271 } from "../lib/round271Schema.js";
import {
  tallyFigures, voucherEntries, voucherXml, vouchersXml, existsXml, ledgersXml, ledgerNames, fyOf, bridgeBat,
  DEFAULT_LEDGERS, LEDGER_LABELS,
} from "../lib/tallyXml.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => {
  try { await ensureRound251(query); await ensureRound255(); await ensureRound271(); next(); } catch (e) { next(e); }
});

const VIEW = requirePermission("accounts.tally-b2c", "view");
const EDIT = requirePermission("accounts.tally-b2c", "edit");
const S_VIEW = requirePermission("accounts.tally-settings", "view");
const S_EDIT = requirePermission("accounts.tally-settings", "edit");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-\d{2}$/;
const VNO = /^[A-Za-z0-9][A-Za-z0-9/\-_. ]{0,38}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const txt = (v, n) => String(v ?? "").trim().slice(0, n);
const ids = (b) => [...new Set((Array.isArray(b?.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

const BRIDGE_ONLINE_SECONDS = 30;
const STALE_MINUTES = 3;
// States where the invoice is with Tally or on its way — the number and the
// invoice are fixed.
const LOCKED = ["queued", "posting", "posted", "manual"];

export async function tallySettings(c = { query }) {
  const { rows } = await c.query(`SELECT *, from_date::text AS from_day FROM tally_settings WHERE id = 1`);
  return rows[0];
}

function bridgeStatus(s) {
  const seen = s.bridge_seen_at ? new Date(s.bridge_seen_at) : null;
  const online = !!seen && Date.now() - seen.getTime() < BRIDGE_ONLINE_SECONDS * 1000;
  return {
    configured: !!s.bridge_token_hash,
    online,
    tally_open: online && s.tally_alive === true,
    seen_at: s.bridge_seen_at,
    pc: s.bridge_pc,
    company: s.company,
  };
}

// The invoice with everything the voucher and the checks need.
const INVOICE_SQL = `
  SELECT i.id, i.total_amount, i.concrete_amount, i.pumping_charge, i.part_load_charge, i.waiting_charge, i.rate_per_m3, i.gst_applied,
         i.billing_name, i.billing_address, i.billing_gstin, i.rejected_quantity_m3, i.cl_cash, i.rate_id, i.return_credit_due,
         i.tally_invoice_no, i.tally_printed_at, i.tp_state, i.tp_note, i.tp_date::text AS tp_date, i.tp_total, i.tp_by_hand,
         i.tp_approved_at, au.name AS tp_approved_by, i.tp_posted_at, pu.name AS tp_posted_by,
         dt.ticket_number, dt.ticket_date::text AS ticket_date, dt.loaded_quantity_m3,
         c.id AS customer_id, c.name AS customer_name, s.name AS site_name, m.name AS grade_name, t.truck_number,
         rm.source AS rate_source, q.quote_no,
         (SELECT COUNT(*)::int FROM credit_notes cn WHERE cn.invoice_id = i.id AND cn.status IN ('pending','approved')) AS credit_notes
    FROM invoices i
    JOIN delivery_tickets dt ON dt.id = i.ticket_id
    JOIN customer_orders co ON co.id = dt.order_id
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN sites s ON s.id = co.site_id
    LEFT JOIN mix_grades m ON m.id = co.mix_grade_id
    LEFT JOIN trucks t ON t.id = dt.truck_id
    LEFT JOIN rate_master rm ON rm.id = i.rate_id
    LEFT JOIN quotations q ON q.id = rm.quotation_id
    LEFT JOIN users au ON au.id = i.tp_approved_by
    LEFT JOIN users pu ON pu.id = i.tp_posted_by`;
const B2C = `COALESCE(TRIM(i.billing_gstin), '') = ''`;

async function invoice(id, c = { query }) {
  const { rows } = await c.query(`${INVOICE_SQL} WHERE i.id = $1`, [id]);
  return rows[0] || null;
}

// Changed since it was approved (or posted)? The total, or it has a GSTIN now.
function changed(inv) {
  if (!["approved", "queued", "failed", "posting", "posted"].includes(inv.tp_state)) return false;
  if (String(inv.billing_gstin || "").trim()) return true;
  return inv.tp_total != null && Math.abs(Number(inv.tp_total) - Number(inv.total_amount)) > 0.009;
}

function rowOut(inv) {
  const f = tallyFigures(inv);
  return {
    id: inv.id,
    date: inv.ticket_date,
    ticket_number: inv.ticket_number,
    customer: inv.billing_name || inv.customer_name,
    site: inv.site_name,
    grade: inv.grade_name,
    m3: f.m3,
    total: Number(inv.total_amount),
    tally_total: f.total,
    voucher_no: inv.tally_invoice_no,
    state: inv.tp_state || "to_verify",
    note: inv.tp_note,
    voucher_date: inv.tp_date,
    approved_by: inv.tp_approved_by,
    approved_at: inv.tp_approved_at,
    posted_by: inv.tp_posted_by,
    posted_at: inv.tp_posted_at,
    by_hand: inv.tp_by_hand,
    changed: changed(inv),
    cash: inv.cl_cash,
  };
}

// The number the next approval gets: the invoice's own (typed at print, or
// given before), else the next in the series, skipping any already used in
// the app. null = ask (no series yet, or a new financial year).
function fmtNo(s, n) { return `${s.prefix || ""}${n}${s.suffix || ""}`; }
function seriesNo(s, no) {
  const p = s.prefix || "", sf = s.suffix || "";
  if (!no.startsWith(p) || !no.endsWith(sf)) return null;
  const mid = no.slice(p.length, no.length - sf.length);
  return /^\d{1,9}$/.test(mid) ? Number(mid) : null;
}
async function proposal(s, inv, c = { query }) {
  if (inv.tally_invoice_no) return { voucher_no: inv.tally_invoice_no, why: "own" };
  if (s.next_no == null) return { voucher_no: null, why: "first" };
  const date = inv.tp_date || inv.ticket_date;
  if (s.restart_april && s.series_fy && fyOf(date) !== s.series_fy) return { voucher_no: null, why: "new_fy", fy: fyOf(date) };
  let n = s.next_no;
  for (let i = 0; i < 500; i++, n++) {
    const no = fmtNo(s, n);
    const { rows } = await c.query(`SELECT 1 FROM invoices WHERE lower(tally_invoice_no) = lower($1) LIMIT 1`, [no]);
    if (!rows.length) return { voucher_no: no, why: "next" };
  }
  return { voucher_no: null, why: "first" };
}

// A job the bridge didn't answer in time: the invoice fails with what to do.
async function sweepStale(c = { query }) {
  const { rows } = await c.query(
    `UPDATE tally_jobs SET status = 'dropped', done_at = now(), error = 'no answer'
      WHERE status = 'picked' AND picked_at < now() - interval '${STALE_MINUTES} minutes'
      RETURNING id, kind, invoice_id`);
  for (const j of rows) {
    if (!j.invoice_id) continue;
    const note = j.kind === "post"
      ? "No answer from the Tally Bridge after sending. Look in Tally for this voucher number: if it is there, use “Mark as entered in Tally”; if not, Retry."
      : "No answer from the Tally Bridge — check that it is running and Tally is open, then Retry.";
    await c.query(`UPDATE invoices SET tp_state = 'failed', tp_note = $2 WHERE id = $1 AND tp_state IN ('queued','posting')`, [j.invoice_id, note]);
  }
}

// ===========================================================================
// The list
// ===========================================================================
router.get("/tally/b2c", VIEW, async (req, res) => {
  try {
    await sweepStale();
    const s = await tallySettings();
    const month = YM.test(req.query.month || "") ? req.query.month : null;
    const params = [s.from_day || "1900-01-01"];
    const where = [B2C, "dt.ticket_date >= $1"];
    if (month) { params.push(`${month}-01`); where.push(`date_trunc('month', dt.ticket_date) = $${params.length}::date`); }
    const { rows } = await query(`${INVOICE_SQL} WHERE ${where.join(" AND ")} ORDER BY dt.ticket_date DESC, i.id DESC LIMIT 2000`, params);
    let list = rows.map(rowOut);
    const counts = { all: list.length, to_verify: 0, approved: 0, queued: 0, failed: 0, posted: 0, changed: 0 };
    for (const r of list) {
      const k = r.state === "back" ? "to_verify" : r.state === "posting" ? "queued" : r.state === "manual" ? "posted" : r.state;
      if (counts[k] != null) counts[k] += 1;
      if (r.changed) counts.changed += 1;
    }
    const st = req.query.state;
    if (st && st !== "all") {
      list = list.filter((r) => (st === "to_verify" ? ["to_verify", "back"].includes(r.state)
        : st === "queued" ? ["queued", "posting"].includes(r.state)
          : st === "posted" ? ["posted", "manual"].includes(r.state)
            : st === "changed" ? r.changed : r.state === st));
    }
    const q = txt(req.query.q, 60).toLowerCase();
    if (q) list = list.filter((r) => [r.customer, r.ticket_number, r.voucher_no, r.site].some((v) => String(v || "").toLowerCase().includes(q)));
    // Waiting in other months (the month filter shouldn't hide work).
    const { rows: elsewhere } = await query(
      `SELECT COUNT(*) FILTER (WHERE i.tp_state IS NULL OR i.tp_state = 'back')::int AS to_verify,
              COUNT(*) FILTER (WHERE i.tp_state IN ('approved','failed'))::int AS to_post
         FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
        WHERE ${B2C} AND dt.ticket_date >= $1 ${month ? "AND date_trunc('month', dt.ticket_date) <> $2::date" : "AND FALSE"}`,
      month ? [s.from_day || "1900-01-01", `${month}-01`] : [s.from_day || "1900-01-01"]);
    const next = s.next_no == null ? null : fmtNo(s, s.next_no);
    res.json({
      rows: list, counts, elsewhere: elsewhere[0],
      next_voucher_no: next, series_fy: s.series_fy, from_date: s.from_day,
      voucher_type: s.voucher_type, company: s.company, bridge: bridgeStatus(s),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the B2C invoices." });
  }
});

// ===========================================================================
// One invoice — verify
// ===========================================================================
router.get("/tally/b2c/:id(\\d+)", VIEW, async (req, res) => {
  try {
    const inv = await invoice(Number(req.params.id));
    if (!inv) return res.status(404).json({ error: "Invoice not found." });
    const s = await tallySettings();
    const b2c = !String(inv.billing_gstin || "").trim();
    const { entries, figures } = voucherEntries(inv, s);
    const checks = [];
    checks.push(b2c ? { ok: true, text: "B2C — no GSTIN on the bill" } : { ok: false, text: `The bill has a GSTIN (${inv.billing_gstin}) — B2B invoices don't go to Tally from here.` });
    const loaded = Number(inv.loaded_quantity_m3 || 0), back = Number(inv.rejected_quantity_m3 || 0);
    checks.push({ ok: figures.m3 > 0, text: back ? `Quantity ${figures.m3} m³ = ${loaded} loaded − ${back} returned` : `Quantity ${figures.m3} m³ = loaded on the delivery note` });
    if (Number(inv.concrete_amount) > 0) {
      checks.push(inv.rate_id
        ? { ok: true, text: `Rate ₹${Number(inv.rate_per_m3 || 0).toLocaleString("en-IN")} from ${inv.quote_no ? `quotation ${inv.quote_no}` : "the price list"}` }
        : { ok: null, text: "Rate not from a quotation or price list — check it" });
    }
    for (const [k, label] of [["pumping_charge", "Pumping"], ["part_load_charge", "Part-load"], ["waiting_charge", "Waiting"]]) {
      if (Number(inv[k]) > 0) checks.push({ ok: true, text: `${label} charge ₹${Number(inv[k]).toLocaleString("en-IN")}` });
    }
    if (inv.credit_notes) checks.push({ ok: null, text: `${inv.credit_notes} credit note(s) raised against this invoice — the voucher is for the invoice; enter the credit note in Tally separately.` });
    else checks.push({ ok: true, text: "No credit note against this invoice" });
    if (inv.return_credit_due) checks.push({ ok: null, text: "Concrete came back — a credit note is still due" });
    if (!inv.gst_applied) checks.push({ ok: null, text: "GST is off on this invoice in the app — Tally gets CGST/SGST inside the same total, as the Tally-format print shows" });
    if (inv.cl_cash) checks.push({ ok: null, text: "Marked Cash → C Ledger" });
    if (Math.abs(figures.total - Number(inv.total_amount)) >= 0.01) checks.push({ ok: null, text: `Tally total ₹${figures.total.toLocaleString("en-IN")} (rounded; invoice ₹${Number(inv.total_amount).toLocaleString("en-IN")})` });
    if (changed(inv)) checks.push({ ok: false, text: inv.tp_state === "posted" ? "Changed after it was posted to Tally — correct it in Tally (or raise a credit note)." : "Changed after it was approved — check it and approve again." });
    if (s.party_mode === "customer" && !String(inv.billing_name || inv.customer_name || "").trim()) checks.push({ ok: false, text: "No customer name for the party ledger" });
    const prop = LOCKED.includes(inv.tp_state) ? { voucher_no: inv.tally_invoice_no, why: "fixed" } : await proposal(s, inv);
    // The next / previous one to verify (Approve & next).
    const { rows: queue } = await query(
      `SELECT i.id FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id
        WHERE ${B2C} AND dt.ticket_date >= $1 AND (i.tp_state IS NULL OR i.tp_state = 'back')
        ORDER BY dt.ticket_date ASC, i.id ASC`, [s.from_day || "1900-01-01"]);
    const pos = queue.findIndex((r) => r.id === inv.id);
    const next = queue.find((r, i) => i > pos && r.id !== inv.id) || queue.find((r) => r.id !== inv.id) || null;
    res.json({
      invoice: { ...rowOut(inv), billing_address: inv.billing_address, truck: inv.truck_number, gst_applied: inv.gst_applied, loaded, returned: back },
      figures, entries, checks, b2c,
      proposal: prop, voucher_type: s.voucher_type, party_mode: s.party_mode,
      to_verify: { count: queue.length, position: pos >= 0 ? pos + 1 : null, next_id: next ? next.id : null },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the invoice." });
  }
});

router.post("/tally/b2c/:id(\\d+)/approve", EDIT, async (req, res) => {
  const id = Number(req.params.id);
  const no = txt(req.body?.voucher_no, 40);
  if (!no) return res.status(400).json({ error: "Type the Tally voucher number." });
  if (!VNO.test(no)) return res.status(400).json({ error: "A voucher number may hold letters, digits and / - _ . only." });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT 1 FROM tally_settings WHERE id = 1 FOR UPDATE`); // one approval at a time: the series
    const s = await tallySettings(c);
    const inv = await invoice(id, c);
    if (!inv) { await c.query("ROLLBACK"); return res.status(404).json({ error: "Invoice not found." }); }
    if (String(inv.billing_gstin || "").trim()) { await c.query("ROLLBACK"); return res.status(400).json({ error: "This bill has a GSTIN — only B2C invoices go to Tally." }); }
    if (LOCKED.includes(inv.tp_state)) { await c.query("ROLLBACK"); return res.status(409).json({ error: inv.tp_state === "posted" || inv.tp_state === "manual" ? "Already in Tally." : "It is being posted — wait for Tally's answer." }); }
    const date = ISO.test(req.body?.date || "") ? req.body.date : inv.ticket_date;
    const { rows: dup } = await c.query(
      `SELECT i.id, dt.ticket_number, COALESCE(i.billing_name, cu.name) AS customer
         FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customers cu ON cu.id = i.customer_id
        WHERE lower(i.tally_invoice_no) = lower($1) AND i.id <> $2 LIMIT 1`, [no, id]);
    if (dup[0]) { await c.query("ROLLBACK"); return res.status(409).json({ error: `${no} is already used on delivery note ${dup[0].ticket_number} (${dup[0].customer}). Choose another number.` }); }
    await c.query(
      `UPDATE invoices SET tally_invoice_no = $2, tp_state = 'approved', tp_note = NULL, tp_date = $3, tp_total = total_amount,
              tp_approved_by = $4, tp_approved_at = now()
        WHERE id = $1`, [id, no, date, req.user.id]);
    // The series carries on from the highest number given.
    const n = seriesNo(s, no);
    const fy = fyOf(date);
    if (n != null) {
      const newFy = s.series_fy && fy !== s.series_fy;
      if (s.next_no == null || n >= s.next_no || (newFy && fy > s.series_fy)) {
        await c.query(`UPDATE tally_settings SET next_no = $1, series_fy = $2 WHERE id = 1`, [n + 1, fy]);
      }
    }
    await c.query("COMMIT");
    res.json({ ok: true, invoice: rowOut(await invoice(id)) });
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not approve the invoice." });
  } finally {
    c.release();
  }
});

router.post("/tally/b2c/:id(\\d+)/send-back", EDIT, async (req, res) => {
  try {
    const note = txt(req.body?.note, 500);
    if (!note) return res.status(400).json({ error: "Say what needs correcting." });
    const { rowCount } = await query(
      `UPDATE invoices SET tp_state = 'back', tp_note = $2 WHERE id = $1 AND (tp_state IS NULL OR tp_state IN ('back','approved','failed'))`,
      [Number(req.params.id), `${note} — ${req.user.name || "Accounts"}`]);
    if (!rowCount) return res.status(409).json({ error: "Only an invoice not yet posted can be sent back." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send it back." });
  }
});

router.post("/tally/b2c/:id(\\d+)/reopen", EDIT, async (req, res) => {
  try {
    const { rowCount } = await query(
      `UPDATE invoices SET tp_state = NULL, tp_note = NULL WHERE id = $1 AND tp_state IN ('approved','failed')`, [Number(req.params.id)]);
    if (!rowCount) return res.status(409).json({ error: "Only an approved or failed invoice can go back to verify." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not reopen it." });
  }
});

// ===========================================================================
// Post to Tally
// ===========================================================================
router.post("/tally/b2c/post", EDIT, async (req, res) => {
  const list = ids(req.body);
  if (!list.length) return res.status(400).json({ error: "Tick the approved invoices to post." });
  const c = await pool.connect();
  try {
    await sweepStale(c);
    const s = await tallySettings(c);
    if (!s.company) return res.status(400).json({ error: "Set the Tally company name in Tally settings first." });
    const b = bridgeStatus(s);
    if (!b.configured) return res.status(409).json({ error: "The Tally Bridge is not set up yet — Tally settings › Download the bridge file, and run it on the Tally computer.", code: "no_bridge" });
    if (!b.online) return res.status(409).json({ error: `The Tally Bridge is not running${s.bridge_pc ? ` on ${s.bridge_pc}` : ""} — start it on the Tally computer, or use “Download Tally XML” and import by hand.`, code: "bridge_off" });
    if (!b.tally_open) return res.status(409).json({ error: `Tally is not open on ${s.bridge_pc || "the Tally computer"} (or its port is off) — open Tally with company ${s.company}, then post.`, code: "tally_closed" });
    await c.query("BEGIN");
    const queued = [], refused = [];
    for (const id of list) {
      const inv = await invoice(id, c);
      if (!inv) { refused.push({ id, error: "Not found." }); continue; }
      if (!["approved", "failed"].includes(inv.tp_state)) { refused.push({ id, voucher_no: inv.tally_invoice_no, error: inv.tp_state ? `It is ${inv.tp_state}.` : "Not approved yet." }); continue; }
      if (changed(inv)) { refused.push({ id, voucher_no: inv.tally_invoice_no, error: "Changed since it was approved — verify and approve again." }); continue; }
      if (!inv.tally_invoice_no) { refused.push({ id, error: "No voucher number." }); continue; }
      await c.query(`UPDATE tally_jobs SET status = 'dropped', done_at = now() WHERE invoice_id = $1 AND status IN ('new','picked')`, [id]);
      await c.query(
        `INSERT INTO tally_jobs (kind, invoice_id, xml, created_by) VALUES ('exists', $1, $2, $3)`,
        [id, existsXml(s, inv.tally_invoice_no, inv.tp_date || inv.ticket_date), req.user.id]);
      await c.query(`UPDATE invoices SET tp_state = 'queued', tp_note = NULL, tp_posted_by = $2 WHERE id = $1`, [id, req.user.id]);
      queued.push({ id, voucher_no: inv.tally_invoice_no });
    }
    await c.query("COMMIT");
    res.json({ ok: true, queued, refused });
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not post to Tally." });
  } finally {
    c.release();
  }
});

router.post("/tally/b2c/unqueue", EDIT, async (req, res) => {
  try {
    const list = ids(req.body);
    const { rows } = await query(
      `UPDATE invoices i SET tp_state = 'approved'
        WHERE i.id = ANY($1) AND i.tp_state = 'queued'
          AND NOT EXISTS (SELECT 1 FROM tally_jobs j WHERE j.invoice_id = i.id AND j.status = 'picked')
        RETURNING i.id`, [list]);
    await query(`UPDATE tally_jobs SET status = 'dropped', done_at = now() WHERE invoice_id = ANY($1) AND status = 'new'`, [rows.map((r) => r.id)]);
    res.json({ ok: true, stopped: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not stop them." });
  }
});

router.post("/tally/b2c/mark-entered", EDIT, async (req, res) => {
  try {
    const list = ids(req.body);
    const { rows } = await query(
      `UPDATE invoices SET tp_state = 'manual', tp_by_hand = true, tp_note = NULL, tp_posted_at = now(), tp_posted_by = $2
        WHERE id = ANY($1) AND tp_state IN ('approved','failed') AND tally_invoice_no IS NOT NULL RETURNING id`, [list, req.user.id]);
    await query(`UPDATE tally_jobs SET status = 'dropped', done_at = now() WHERE invoice_id = ANY($1) AND status IN ('new','picked')`, [rows.map((r) => r.id)]);
    res.json({ ok: true, marked: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not mark them." });
  }
});

router.post("/tally/b2c/xml", EDIT, async (req, res) => {
  try {
    const list = ids(req.body);
    const s = await tallySettings();
    if (!s.company) return res.status(400).json({ error: "Set the Tally company name in Tally settings first." });
    const out = [], skipped = [];
    for (const id of list) {
      const inv = await invoice(id);
      if (!inv || !["approved", "failed"].includes(inv.tp_state) || !inv.tally_invoice_no || changed(inv)) { skipped.push(id); continue; }
      out.push({ inv, voucherNo: inv.tally_invoice_no, date: inv.tp_date || inv.ticket_date });
    }
    if (!out.length) return res.status(400).json({ error: "Only approved invoices (not changed since) can be downloaded." });
    const nos = out.map((o) => o.voucherNo);
    res.json({ filename: `Tally-B2C-${nos[0]}${nos.length > 1 ? `-to-${nos[nos.length - 1]}` : ""}.xml`, xml: vouchersXml(out, s), count: out.length, skipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not make the Tally file." });
  }
});

// ===========================================================================
// Settings, the bridge file, the ledger check
// ===========================================================================
function settingsOut(s) {
  return {
    company: s.company || "",
    voucher_type: s.voucher_type,
    prefix: s.prefix || "",
    suffix: s.suffix || "",
    next_no: s.next_no,
    series_fy: s.series_fy,
    restart_april: s.restart_april,
    party_mode: s.party_mode,
    ledgers: ledgerNames(s),
    ledger_labels: LEDGER_LABELS,
    from_date: s.from_day || null,
    bridge: { ...bridgeStatus(s), token_at: s.bridge_token_at },
    check: s.check_result, check_at: s.check_at,
  };
}

router.get("/tally/settings", S_VIEW, async (_req, res) => {
  try {
    await sweepStale();
    res.json(settingsOut(await tallySettings()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the Tally settings." });
  }
});

router.put("/tally/settings", S_EDIT, async (req, res) => {
  try {
    const b = req.body || {};
    const s = await tallySettings();
    const company = txt(b.company ?? s.company, 120);
    const vt = txt(b.voucher_type ?? s.voucher_type, 60) || "Sales B2C";
    const prefix = txt(b.prefix ?? s.prefix, 20), suffix = txt(b.suffix ?? s.suffix, 20);
    if (/["\\]/.test(prefix + suffix + vt)) return res.status(400).json({ error: "Quotes and back-slashes can't be used in the voucher type, prefix or suffix." });
    let next = b.next_no === "" || b.next_no === null ? null : b.next_no === undefined ? s.next_no : Number(b.next_no);
    if (next != null && !(Number.isInteger(next) && next >= 1 && next < 1e9)) return res.status(400).json({ error: "The next number must be a whole number." });
    const party = b.party_mode === "customer" ? "customer" : b.party_mode === "cash" ? "cash" : s.party_mode;
    const ledgers = { ...ledgerNames(s) };
    for (const k of Object.keys(DEFAULT_LEDGERS)) if (b.ledgers && b.ledgers[k] !== undefined) ledgers[k] = txt(b.ledgers[k], 120) || DEFAULT_LEDGERS[k];
    const from = ISO.test(b.from_date || "") ? b.from_date : s.from_day;
    const restart = b.restart_april === undefined ? s.restart_april : !!b.restart_april;
    // Typing the next number starts the series in the current financial year
    // (or the one of the start date, if later).
    const today = istDay();
    const seriesFy = next !== s.next_no ? fyOf(today) : s.series_fy;
    await query(
      `UPDATE tally_settings SET company = $1, voucher_type = $2, prefix = $3, suffix = $4, next_no = $5, party_mode = $6, ledgers = $7,
              from_date = $8, restart_april = $9, series_fy = $10, updated_by = $11, updated_at = now() WHERE id = 1`,
      [company || null, vt, prefix, suffix, next, party, JSON.stringify(ledgers), from, restart, next == null ? null : seriesFy, req.user.id]);
    res.json(settingsOut(await tallySettings()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the Tally settings." });
  }
});

router.post("/tally/bridge-file", S_EDIT, async (req, res) => {
  try {
    const base = txt(req.body?.api_base, 300).replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s'"]+\/api$/i.test(base)) return res.status(400).json({ error: "The app's address was not understood." });
    const token = crypto.randomBytes(24).toString("hex");
    await query(`UPDATE tally_settings SET bridge_token_hash = $1, bridge_token_at = now(), bridge_seen_at = NULL, tally_alive = NULL WHERE id = 1`, [sha(token)]);
    res.json({ filename: "OORM-Tally-Bridge.bat", content: bridgeBat({ apiBase: base, token }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not make the bridge file." });
  }
});

router.post("/tally/check", S_EDIT, async (req, res) => {
  try {
    await sweepStale();
    const s = await tallySettings();
    if (!s.company) return res.status(400).json({ error: "Type the Tally company name first." });
    const b = bridgeStatus(s);
    if (!b.online) return res.status(409).json({ error: "The Tally Bridge is not running on the Tally computer." });
    if (!b.tally_open) return res.status(409).json({ error: "Tally is not open on the Tally computer (or its port is off)." });
    await query(`UPDATE tally_jobs SET status = 'dropped', done_at = now() WHERE kind = 'check' AND status = 'new'`);
    await query(`INSERT INTO tally_jobs (kind, xml, created_by) VALUES ('check', $1, $2)`, [ledgersXml(s), req.user.id]);
    await query(`UPDATE tally_settings SET check_result = '{"pending":true}'::jsonb, check_at = now() WHERE id = 1`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not ask Tally." });
  }
});

export default router;
