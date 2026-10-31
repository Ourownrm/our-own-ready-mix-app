// Round 253 — Accounts → Cheques (owner, 30 Oct 2026; mock-up "Cheques &
// Petty Cash", artboards 1 and 3). See lib/round253Schema.js for the life of
// a cheque. The register does not post money itself: a cheque's credit or
// debit reaches the ledgers from Cost → Bank statements as before. The
// owner's extra: a post-dated cheque the customer took back because they paid
// by bank transfer or cash instead ("Returned · paid another way"), with
// those payments recorded against it.
//
//   GET  /api/accounts/cheques                    register + tiles + this week + books
//   GET  /api/accounts/cheques/meta               pick lists
//   GET  /api/accounts/cheques/customer/:id       balance, recent bounces (for the entry form)
//   GET  /api/accounts/cheques/:id                one cheque, its history, receipts to link
//   GET  /api/accounts/cheques/:id/photo
//   POST /api/accounts/cheques                    record (received / issued / void a leaf)
//   POST /api/accounts/cheques/:id/edit           while in hand / issued
//   POST /api/accounts/cheques/:id/deposit | clear | bounce | represent | notice | return | cancel | stop
//   POST /api/accounts/cheques/:id/replacements   another payment that replaced a returned cheque
//   POST /api/accounts/cheques/:id/replacements/:rid/remove
//   GET/POST /api/accounts/cheque-books
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { istDay } from "../lib/istDate.js";
import { ensureRound253, matchCheques, chequeEvent, bareNo } from "../lib/round253Schema.js";
import { postReceipt } from "../lib/receivables.js";
import { unpostPayment, ledgerSettings } from "../lib/ledgerPost.js";
import { positions } from "../lib/receivables.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound253(); next(); } catch (e) { next(e); } });

const VIEW = requirePermission("accounts.cheques", "view");
const CREATE = requirePermission("accounts.cheques", "create");
const EDIT = requirePermission("accounts.cheques", "edit");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const txt = (v, max) => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const day = (v, { future = false } = {}) => (ISO.test(v || "") && (future || v <= istDay()) ? v : null);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }; // ist-ok: calendar arithmetic on a date string at UTC midnight

const COLS = `c.id, c.direction, c.cheque_no, c.cheque_date::text AS cheque_date, c.amount, c.status, c.customer_id, cu.name AS customer_name,
  c.drawn_on, c.deposit_account_id, c.received_on::text AS received_on, c.account_id, c.book_id, c.payee_kind, c.payee_id, c.payee_name, c.purpose,
  c.deposited_on::text AS deposited_on, c.slip_no, c.presentations, c.cleared_on::text AS cleared_on, c.bank_line_id, c.receipt_id,
  c.bounced_on::text AS bounced_on, c.bounce_reason, c.bounce_charges, c.notice_on::text AS notice_on, c.returned_on::text AS returned_on,
  c.return_note, c.cancelled_on::text AS cancelled_on, c.cancel_reason, c.remarks, (c.photo IS NOT NULL) AS has_photo, c.created_at,
  cb.name AS created_by_name,
  CASE WHEN da.id IS NULL THEN NULL ELSE da.bank || ' ••' || right(da.number, 4) END AS deposit_account,
  CASE WHEN oa.id IS NULL THEN NULL ELSE oa.bank || ' ••' || right(oa.number, 4) END AS our_account,
  COALESCE((SELECT SUM(r.amount) FROM cheque_replacements r WHERE r.cheque_id = c.id AND r.removed_at IS NULL), 0) AS replaced`;
const FROM = `FROM cheques c LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN users cb ON cb.id = c.created_by
  LEFT JOIN cost_bank_accounts da ON da.id = c.deposit_account_id LEFT JOIN cost_bank_accounts oa ON oa.id = c.account_id`;
const shape = (c) => ({ ...c, amount: c.amount == null ? null : n0(c.amount), bounce_charges: c.bounce_charges == null ? null : n0(c.bounce_charges), replaced: r2(c.replaced) });

async function loadCheque(db, id, lock = false) {
  const { rows } = await db.query(`SELECT * FROM cheques WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id]);
  if (!rows.length) throw fail("Cheque not found.", 404);
  const c = rows[0];
  for (const k of ["cheque_date", "deposited_on", "cleared_on", "bounced_on", "returned_on", "received_on"]) {
    if (c[k] instanceof Date) c[k] = c[k].toLocaleDateString("en-CA"); // ist-ok: DATE column, local midnight
  }
  return c;
}

// One transaction around a step; errors with a status come back as 4xx.
async function tx(res, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    res.json(out ?? { ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return bad(res, err.message, err.status);
    throw err;
  } finally { client.release(); }
}

// ============================================================== lists ===
async function bankAccounts() {
  const { rows } = await query(`SELECT id, bank, label, number, is_active FROM cost_bank_accounts ORDER BY is_active DESC, bank, id`).catch(() => ({ rows: [] }));
  return rows.map((a) => ({ id: a.id, is_active: a.is_active, label: `${a.label || a.bank} ••${String(a.number).slice(-4)}` }));
}

// Each active book with its leaves: used (issued / cancelled …), the next
// free one, and gaps (unused leaves below the last one used).
async function booksWithLeaves() {
  const { rows: books } = await query(
    `SELECT b.*, b.received_on::text AS received_on, a.bank, a.label, a.number FROM cheque_books b JOIN cost_bank_accounts a ON a.id = b.account_id
      ORDER BY b.is_active DESC, b.id DESC`);
  if (!books.length) return [];
  const { rows: used } = await query(
    `SELECT account_id, cheque_no, status FROM cheques WHERE direction = 'issued' AND account_id = ANY($1::int[])`, [books.map((b) => b.account_id)]);
  return books.map((b) => {
    const mine = new Map();
    for (const u of used) {
      if (u.account_id !== b.account_id) continue;
      const n = Number(bareNo(u.cheque_no));
      if (n >= b.first_no && n <= b.last_no) mine.set(n, u.status);
    }
    let next = null; const gaps = [];
    const maxUsed = mine.size ? Math.max(...mine.keys()) : null;
    for (let n = b.first_no; n <= b.last_no; n++) {
      if (mine.has(n)) continue;
      if (next == null) next = n;
      if (maxUsed != null && n < maxUsed) gaps.push(n);
    }
    const pad = (n) => (n == null ? null : String(n).padStart(b.digits, "0"));
    return {
      id: b.id, account_id: b.account_id, account: `${b.label || b.bank} ••${String(b.number).slice(-4)}`, first_no: pad(b.first_no), last_no: pad(b.last_no),
      leaves: b.last_no - b.first_no + 1, used: mine.size, left: b.last_no - b.first_no + 1 - mine.size, next: pad(next),
      gaps: gaps.slice(0, 20).map(pad), gap_count: gaps.length, is_active: b.is_active, received_on: b.received_on, note: b.note,
      cancelled: [...mine.values()].filter((s) => s === "cancelled").length,
    };
  });
}

router.get("/cheques/meta", VIEW, async (_req, res) => {
  const safe = (p) => p.then((r) => r.rows).catch(() => []);
  const [customers, suppliers, transporters, contractors, accounts, books] = await Promise.all([
    safe(query(`SELECT id, name FROM customers WHERE COALESCE(is_active, true) ORDER BY name`)),
    safe(query(`SELECT id, name FROM rm_suppliers WHERE is_active ORDER BY name`)),
    safe(query(`SELECT id, name FROM rm_transporters WHERE is_active ORDER BY name`)),
    safe(query(`SELECT id, name FROM hr_contractors WHERE is_active ORDER BY name`)),
    bankAccounts(), booksWithLeaves(),
  ]);
  res.json({ customers, suppliers, transporters, contractors, accounts, books, today: istDay() });
});

router.get("/cheques", VIEW, async (req, res) => {
  const matched = await matchCheques().catch((e) => { console.error("cheques: match", e.message); return {}; });
  const today = istDay();
  const { rows } = await query(
    `SELECT ${COLS} ${FROM}
      WHERE c.status NOT IN ('cleared','cancelled') OR c.cheque_date >= ($1::date - 120) OR c.cleared_on >= ($1::date - 120) OR c.cancelled_on >= ($1::date - 60)
      ORDER BY c.cheque_date DESC, c.id DESC LIMIT 1500`, [today]);
  const list = rows.map(shape);
  const sum = (f) => { const x = list.filter(f); return { n: x.length, amount: r2(x.reduce((s, c) => s + n0(c.amount), 0)) }; };
  const inHand = list.filter((c) => c.direction === "received" && c.status === "in_hand");
  const nextDue = inHand.map((c) => c.cheque_date).filter((d) => d >= today).sort()[0] || null;
  // The next 7 days: received cheques to deposit (in hand, dated that day or
  // overdue on day one) and our issued cheques dated that day.
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    const dep = list.filter((c) => c.direction === "received" && c.status === "in_hand" && (i === 0 ? c.cheque_date <= d : c.cheque_date === d));
    const iss = list.filter((c) => c.direction === "issued" && c.status === "issued" && (i === 0 ? c.cheque_date <= d : c.cheque_date === d));
    week.push({ date: d, deposit: { n: dep.length, amount: r2(dep.reduce((s, c) => s + n0(c.amount), 0)) },
      issued: { n: iss.length, amount: r2(iss.reduce((s, c) => s + n0(c.amount), 0)) } });
  }
  res.json({
    today, matched, list,
    tiles: {
      in_hand: { ...sum((c) => c.direction === "received" && c.status === "in_hand"), next_due: nextDue },
      deposited: sum((c) => c.direction === "received" && c.status === "deposited"),
      issued: sum((c) => c.direction === "issued" && c.status === "issued"),
      bounced: sum((c) => c.direction === "received" && c.status === "bounced"),
    },
    week, books: await booksWithLeaves(),
  });
});

router.get("/cheques/customer/:id(\\d+)", VIEW, async (req, res) => {
  const id = Number(req.params.id);
  const [pos, { rows: bounces }] = await Promise.all([
    positions({ customerId: id }).catch(() => []),
    query(`SELECT cheque_no, amount, bounced_on::text AS bounced_on, bounce_reason FROM cheques
            WHERE customer_id = $1 AND bounced_on >= (CURRENT_DATE - 183) ORDER BY bounced_on DESC`, [id]),
  ]);
  const p = pos[0];
  res.json({ balance: p ? p.balance : 0, advance: p ? p.advance : 0, bounces: bounces.map((b) => ({ ...b, amount: n0(b.amount) })) });
});

router.get("/cheques/:id(\\d+)", VIEW, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`SELECT ${COLS} ${FROM} WHERE c.id = $1`, [id]);
  if (!rows.length) return bad(res, "Cheque not found.", 404);
  const c = shape(rows[0]);
  const [{ rows: events }, { rows: repl }, { rows: line }, { rows: receipt }] = await Promise.all([
    query(`SELECT e.action, e.detail, e.done_at, u.name AS done_by FROM cheque_events e LEFT JOIN users u ON u.id = e.done_by WHERE e.cheque_id = $1 ORDER BY e.done_at, e.id`, [id]),
    query(`SELECT r.id, r.mode, r.amount, r.paid_on::text AS paid_on, r.reference, r.receipt_id, r.posting, r.created_at,
                  cr.receipt_date::text AS receipt_date, cr.cancelled_at IS NOT NULL AS receipt_cancelled
             FROM cheque_replacements r LEFT JOIN customer_receipts cr ON cr.id = r.receipt_id
            WHERE r.cheque_id = $1 AND r.removed_at IS NULL ORDER BY r.id`, [id]),
    c.bank_line_id ? query(`SELECT l.txn_date::text AS txn_date, l.narration, a.bank || ' ••' || right(a.number, 4) AS account
                                FROM cost_bank_lines l JOIN cost_bank_accounts a ON a.id = l.account_id WHERE l.id = $1`, [c.bank_line_id]) : { rows: [] },
    c.receipt_id ? query(`SELECT id, receipt_date::text AS receipt_date, amount, cancelled_at IS NOT NULL AS cancelled FROM customer_receipts WHERE id = $1`, [c.receipt_id]) : { rows: [] },
  ]);
  // The customer's receipts a returned cheque's payment can be linked to.
  let linkable = [];
  if (c.direction === "received" && c.customer_id && ["in_hand", "bounced", "returned", "deposited"].includes(c.status)) {
    ({ rows: linkable } = await query(
      `SELECT cr.id, cr.receipt_date::text AS receipt_date, cr.amount, cr.mode::text AS mode, cr.reference_number
         FROM customer_receipts cr
        WHERE cr.customer_id = $1 AND cr.cancelled_at IS NULL AND cr.receipt_date >= (CURRENT_DATE - 120)
          AND NOT EXISTS (SELECT 1 FROM cheque_replacements x WHERE x.receipt_id = cr.id AND x.removed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM cheques x WHERE x.receipt_id = cr.id AND x.status = 'cleared')
        ORDER BY cr.receipt_date DESC, cr.id DESC LIMIT 40`, [c.customer_id]));
  }
  res.json({
    ...c, events, replacements: repl.map((r) => ({ ...r, amount: n0(r.amount) })), bank_line: line[0] || null,
    receipt: receipt[0] ? { ...receipt[0], amount: n0(receipt[0].amount) } : null,
    linkable: linkable.map((r) => ({ ...r, amount: n0(r.amount) })),
    manual_payments: (await ledgerSettings()).manual_payments,
  });
});

router.get("/cheques/:id(\\d+)/photo", VIEW, async (req, res) => {
  const { rows } = await query(`SELECT photo FROM cheques WHERE id = $1`, [req.params.id]);
  res.json({ photo: rows[0]?.photo || null });
});

// ============================================================ record ===
function cleanPhoto(p) {
  if (!p) return null;
  const s = String(p);
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(s)) throw fail("The photo must be a JPEG, PNG or WebP image.");
  if (s.length > 2_500_000) throw fail("The photo is too large — take it again at a lower size.");
  return s;
}

async function payeeName(db, kind, id, name) {
  const table = { supplier: "rm_suppliers", transporter: "rm_transporters", contractor: "hr_contractors" }[kind];
  if (table) {
    const { rows } = await db.query(`SELECT name FROM ${table} WHERE id = $1`, [Number(id)]);
    if (!rows.length) throw fail("Choose who the cheque is to.");
    return rows[0].name;
  }
  const n = txt(name, 200);
  if (!n && kind !== "self") throw fail("Write whom the cheque is to.");
  return n || "Self";
}

// An issued cheque's leaf: the number as printed in the book (zeros kept).
async function leafFor(db, accountId, chequeNo) {
  const n = Number(bareNo(chequeNo));
  if (!(n > 0)) throw fail("Enter the cheque (leaf) number.");
  const { rows: books } = await db.query(
    `SELECT id, digits FROM cheque_books WHERE account_id = $1 AND $2 BETWEEN first_no AND last_no ORDER BY is_active DESC, id DESC LIMIT 1`, [accountId, n]);
  const no = books[0] ? String(n).padStart(books[0].digits, "0") : String(chequeNo).replace(/\D/g, "");
  const { rows: dup } = await db.query(
    `SELECT id, status FROM cheques WHERE direction = 'issued' AND account_id = $1 AND ltrim(cheque_no, '0') = $2`, [accountId, String(n)]);
  if (dup.length) throw fail(`Leaf ${no} of that account is already in the register (${dup[0].status}).`, 409);
  return { no, book_id: books[0]?.id || null };
}

export async function createIssuedCheque(db, b, userId) {
  const accountId = Number(b.account_id);
  const { rows: acc } = await db.query(`SELECT id FROM cost_bank_accounts WHERE id = $1`, [accountId]);
  if (!acc.length) throw fail("Choose the bank account the cheque is drawn on.");
  const leaf = await leafFor(db, accountId, b.cheque_no);
  if (b.void) {
    const reason = txt(b.cancel_reason, 300);
    if (!reason) throw fail("Say why the leaf is cancelled (spoilt, torn …).");
    const { rows } = await db.query(
      `INSERT INTO cheques (direction, cheque_no, cheque_date, status, account_id, book_id, cancelled_on, cancel_reason, created_by)
       VALUES ('issued', $1, $2, 'cancelled', $3, $4, $2, $5, $6) RETURNING id`, [leaf.no, istDay(), accountId, leaf.book_id, reason, userId]);
    await chequeEvent(db, rows[0].id, "leaf cancelled", { reason }, userId);
    return { id: rows[0].id, cheque_no: leaf.no };
  }
  const amount = r2(b.amount);
  if (!(amount > 0)) throw fail("Enter the amount.");
  const cdate = day(b.cheque_date, { future: true });
  if (!cdate) throw fail("Enter the cheque date.");
  const kind = ["supplier", "transporter", "contractor", "self", "other"].includes(b.payee_kind) ? b.payee_kind : "other";
  const name = await payeeName(db, kind, b.payee_id, b.payee_name);
  const { rows } = await db.query(
    `INSERT INTO cheques (direction, cheque_no, cheque_date, amount, status, account_id, book_id, payee_kind, payee_id, payee_name, purpose, remarks, photo, created_by)
     VALUES ('issued', $1, $2, $3, 'issued', $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [leaf.no, cdate, amount, accountId, leaf.book_id, kind, ["supplier", "transporter", "contractor"].includes(kind) ? Number(b.payee_id) : null,
      name, txt(b.purpose, 300), txt(b.remarks, 300), cleanPhoto(b.photo), userId]);
  await chequeEvent(db, rows[0].id, "issued", { amount, to: name, date: cdate }, userId);
  return { id: rows[0].id, cheque_no: leaf.no, payee_name: name };
}

router.post("/cheques", CREATE, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    if (b.direction === "issued") return createIssuedCheque(db, b, req.user.id);
    if (b.direction !== "received") throw fail("Received or issued?");
    const customerId = Number(b.customer_id);
    const { rows: cu } = await db.query(`SELECT id, name FROM customers WHERE id = $1`, [customerId]);
    if (!cu.length) throw fail("Choose the customer.");
    const no = String(b.cheque_no || "").replace(/\D/g, "");
    if (no.length < 3 || no.length > 12) throw fail("Enter the cheque number (the digits printed on the leaf).");
    const amount = r2(b.amount);
    if (!(amount > 0)) throw fail("Enter the amount.");
    const cdate = day(b.cheque_date, { future: true });
    if (!cdate) throw fail("Enter the date written on the cheque.");
    const received = day(b.received_on || istDay());
    if (!received) throw fail("The day it was received can't be in the future.");
    const drawnOn = txt(b.drawn_on, 120);
    if (!drawnOn) throw fail("Enter the customer's bank and branch.");
    const depAcc = b.deposit_account_id ? Number(b.deposit_account_id) : null;
    // The same leaf twice: same number from the same bank, or the same customer.
    const { rows: dup } = await db.query(
      `SELECT c.id, cu.name FROM cheques c LEFT JOIN customers cu ON cu.id = c.customer_id
        WHERE c.direction = 'received' AND c.status <> 'cancelled' AND ltrim(c.cheque_no, '0') = ltrim($1, '0')
          AND (c.customer_id = $2 OR lower(c.drawn_on) = lower($3))`, [no, customerId, drawnOn]);
    if (dup.length) throw fail(`Cheque ${no} is already in the register (${dup[0].name || "another customer"}).`, 409);
    const { rows } = await db.query(
      `INSERT INTO cheques (direction, cheque_no, cheque_date, amount, status, customer_id, drawn_on, deposit_account_id, received_on, purpose, remarks, photo, created_by)
       VALUES ('received', $1, $2, $3, 'in_hand', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [no, cdate, amount, customerId, drawnOn, depAcc, received, txt(b.purpose, 300), txt(b.remarks, 300), cleanPhoto(b.photo), req.user.id]);
    await chequeEvent(db, rows[0].id, "received", { amount, date: cdate }, req.user.id);
    return { id: rows[0].id, cheque_no: no };
  });
});

router.post("/cheques/:id(\\d+)/edit", EDIT, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (!["in_hand", "issued"].includes(c.status)) throw fail("Only a cheque still in hand (or issued, not yet cleared) can be changed.");
    const amount = r2(b.amount ?? c.amount);
    if (!(amount > 0)) throw fail("Enter the amount.");
    const cdate = day(b.cheque_date ?? c.cheque_date, { future: true });
    if (!cdate) throw fail("Enter the cheque date.");
    const photo = b.photo === undefined ? c.photo : b.photo === null ? null : cleanPhoto(b.photo);
    const before = { amount: n0(c.amount), cheque_date: c.cheque_date, drawn_on: c.drawn_on, payee_name: c.payee_name };
    if (c.direction === "received") {
      await db.query(`UPDATE cheques SET amount = $2, cheque_date = $3, drawn_on = COALESCE($4, drawn_on), deposit_account_id = $5, purpose = $6, remarks = $7, photo = $8,
                             updated_by = $9, updated_at = now() WHERE id = $1`,
        [c.id, amount, cdate, txt(b.drawn_on, 120), b.deposit_account_id ? Number(b.deposit_account_id) : null, txt(b.purpose, 300), txt(b.remarks, 300), photo, req.user.id]);
    } else {
      const kind = ["supplier", "transporter", "contractor", "self", "other"].includes(b.payee_kind) ? b.payee_kind : c.payee_kind;
      const name = await payeeName(db, kind, b.payee_id ?? c.payee_id, b.payee_name ?? c.payee_name);
      await db.query(`UPDATE cheques SET amount = $2, cheque_date = $3, payee_kind = $4, payee_id = $5, payee_name = $6, purpose = $7, remarks = $8, photo = $9,
                             updated_by = $10, updated_at = now() WHERE id = $1`,
        [c.id, amount, cdate, kind, ["supplier", "transporter", "contractor"].includes(kind) ? Number(b.payee_id ?? c.payee_id) : null, name,
          txt(b.purpose, 300), txt(b.remarks, 300), photo, req.user.id]);
    }
    await chequeEvent(db, c.id, "changed", { before, after: { amount, cheque_date: cdate } }, req.user.id);
  });
});

// Round 255 — the Administrator corrects a cheque entered wrongly (owner,
// 31 Oct 2026), whatever its status: number, date, amount, customer / payee,
// bank, account and the dates of its steps. A reason is required and the
// before / after goes into the cheque's history. Money already in the books
// stays safe: once a cheque is linked to a receipt or matched to a bank line,
// its amount, customer and account can't change here (undo that first).
const CORRECT = requirePermission("accounts.cheque-correct", "edit");
router.post("/cheques/:id(\\d+)/correct", CORRECT, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const reason = txt(b.reason, 300);
    if (!reason) throw fail("Say what was wrong in the entry.");
    const c = await loadCheque(db, Number(req.params.id), true);
    const linked = !!(c.receipt_id || c.bank_line_id);
    const next = {};
    const was = {};
    const set = (k, v) => { if (v !== undefined && String(v ?? "") !== String(c[k] ?? "")) { next[k] = v; was[k] = c[k]; } };
    if (b.cheque_no !== undefined) {
      const no = String(b.cheque_no || "").replace(/\D/g, "");
      if (no.length < 3 || no.length > 12) throw fail("Enter the cheque number (the digits printed on the leaf).");
      if (no.replace(/^0+/, "") !== String(c.cheque_no).replace(/^0+/, "")) {
        const { rows: dup } = await db.query(
          c.direction === "issued"
            ? `SELECT id FROM cheques WHERE direction = 'issued' AND account_id = $2 AND ltrim(cheque_no, '0') = ltrim($1, '0') AND id <> $3`
            : `SELECT id FROM cheques WHERE direction = 'received' AND status <> 'cancelled' AND ltrim(cheque_no, '0') = ltrim($1, '0')
                 AND (customer_id = $2 OR lower(drawn_on) = lower($4)) AND id <> $3`,
          c.direction === "issued" ? [no, b.account_id ? Number(b.account_id) : c.account_id, c.id] : [no, b.customer_id ? Number(b.customer_id) : c.customer_id, c.id, b.drawn_on ?? c.drawn_on]);
        if (dup.length) throw fail(`Cheque ${no} is already in the register.`, 409);
        set("cheque_no", c.direction === "issued" && c.cheque_no.length > no.length ? no.padStart(c.cheque_no.length, "0") : no);
      }
    }
    if (b.cheque_date !== undefined) {
      const d = day(b.cheque_date, { future: true });
      if (!d) throw fail("Enter the cheque date.");
      set("cheque_date", d);
    }
    if (b.amount !== undefined && c.status !== "cancelled") {
      const a = r2(b.amount);
      if (!(a > 0)) throw fail("Enter the amount.");
      if (Math.abs(a - n0(c.amount)) > 0.005) {
        if (linked) throw fail("This cheque is already matched to the bank / a receipt — its amount can't change here. Present it again or undo the receipt first.");
        const { rows: rp } = await db.query(`SELECT COALESCE(SUM(amount), 0) AS v FROM cheque_replacements WHERE cheque_id = $1 AND removed_at IS NULL`, [c.id]);
        if (a < r2(rp[0].v) - 0.005) throw fail("The amount can't be less than what was paid in its place.");
        set("amount", a);
      }
    }
    for (const k of ["received_on", "deposited_on", "cleared_on", "bounced_on", "returned_on"]) {
      if (b[k] === undefined) continue;
      if (b[k] === "" || b[k] === null) { if (c[k] && ["received_on"].includes(k)) throw fail("The day it was received is needed."); continue; }
      const d = day(b[k]);
      if (!d) throw fail("Dates of what already happened can't be in the future.");
      if (c[k]) set(k, d);
    }
    if (c.direction === "received") {
      if (b.customer_id !== undefined && Number(b.customer_id) !== c.customer_id) {
        if (linked) throw fail("This cheque is already matched to a receipt — the customer can't change here. Undo the receipt first.");
        const { rows } = await db.query(`SELECT id FROM customers WHERE id = $1`, [Number(b.customer_id)]);
        if (!rows.length) throw fail("Choose the customer.");
        set("customer_id", Number(b.customer_id));
      }
      if (b.drawn_on !== undefined) { const v = txt(b.drawn_on, 120); if (!v) throw fail("Enter the customer's bank and branch."); set("drawn_on", v); }
      if (b.deposit_account_id !== undefined) {
        const v = b.deposit_account_id ? Number(b.deposit_account_id) : null;
        if (v !== (c.deposit_account_id || null) && c.bank_line_id) throw fail("This cheque is already matched to a bank line — the account can't change here.");
        set("deposit_account_id", v);
      }
      if (b.slip_no !== undefined) set("slip_no", txt(b.slip_no, 40));
    } else {
      if (b.account_id !== undefined && Number(b.account_id) !== c.account_id) {
        if (linked) throw fail("This cheque is already matched to a bank line — the account can't change here.");
        const { rows } = await db.query(`SELECT id FROM cost_bank_accounts WHERE id = $1`, [Number(b.account_id)]);
        if (!rows.length) throw fail("Choose the bank account.");
        set("account_id", Number(b.account_id));
      }
      if (b.payee_kind !== undefined || b.payee_id !== undefined || b.payee_name !== undefined) {
        const kind = ["supplier", "transporter", "contractor", "self", "other"].includes(b.payee_kind) ? b.payee_kind : c.payee_kind || "other";
        if (c.status !== "cancelled") {
          const name = await payeeName(db, kind, b.payee_id ?? c.payee_id, b.payee_name ?? c.payee_name);
          set("payee_kind", kind);
          set("payee_id", ["supplier", "transporter", "contractor"].includes(kind) ? Number(b.payee_id ?? c.payee_id) : null);
          set("payee_name", name);
        }
      }
    }
    if (b.purpose !== undefined) set("purpose", txt(b.purpose, 300));
    if (b.remarks !== undefined) set("remarks", txt(b.remarks, 300));
    const keys = Object.keys(next);
    if (!keys.length) throw fail("Nothing was changed.");
    // A different issued leaf number may now sit in another book.
    if (c.direction === "issued" && (next.cheque_no || next.account_id)) {
      const n = Number(bareNo(next.cheque_no || c.cheque_no));
      const { rows: bk } = await db.query(
        `SELECT id FROM cheque_books WHERE account_id = $1 AND $2 BETWEEN first_no AND last_no ORDER BY is_active DESC, id DESC LIMIT 1`, [next.account_id || c.account_id, n]);
      next.book_id = bk[0]?.id || null;
    }
    const cols = Object.keys(next);
    await db.query(`UPDATE cheques SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${cols.length + 2}, updated_at = now() WHERE id = $1`,
      [c.id, ...cols.map((k) => next[k]), req.user.id]);
    const after = Object.fromEntries(keys.map((k) => [k, next[k]]));
    await chequeEvent(db, c.id, "entry corrected", { reason, before: was, after }, req.user.id);
    return { ok: true, changed: keys };
  });
});

// ============================================================== steps ===
router.post("/cheques/:id(\\d+)/deposit", EDIT, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (c.direction !== "received" || c.status !== "in_hand") throw fail("Only a received cheque in hand can be deposited.");
    const d = day(b.deposited_on || istDay());
    if (!d) throw fail("The deposit date can't be in the future.");
    if (d < c.cheque_date) throw fail(`The cheque is dated ${c.cheque_date} — it can't be deposited before that.`);
    const acc = Number(b.account_id || c.deposit_account_id);
    const { rows } = await db.query(`SELECT id FROM cost_bank_accounts WHERE id = $1`, [acc]);
    if (!rows.length) throw fail("Choose the account it was deposited into.");
    await db.query(`UPDATE cheques SET status = 'deposited', deposited_on = $2, deposit_account_id = $3, slip_no = $4, presentations = presentations + 1,
                           updated_by = $5, updated_at = now() WHERE id = $1`, [c.id, d, acc, txt(b.slip_no, 40), req.user.id]);
    await chequeEvent(db, c.id, "deposited", { date: d, slip_no: txt(b.slip_no, 40) }, req.user.id);
  });
});

router.post("/cheques/:id(\\d+)/clear", EDIT, async (req, res) => {
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (!["deposited", "issued"].includes(c.status)) throw fail("Only a deposited (or issued) cheque can be marked cleared.");
    const d = day(req.body?.cleared_on || istDay());
    if (!d) throw fail("The clearing date can't be in the future.");
    await db.query(`UPDATE cheques SET status = 'cleared', cleared_on = $2, updated_by = $3, updated_at = now() WHERE id = $1`, [c.id, d, req.user.id]);
    await chequeEvent(db, c.id, "cleared", { by: "hand", date: d }, req.user.id);
  });
});

// A bounce: the receipt its credit had posted is cancelled (the bank takes
// the money back), so the dues it paid are open again.
router.post("/cheques/:id(\\d+)/bounce", EDIT, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (c.direction !== "received" || !["deposited", "cleared"].includes(c.status)) throw fail("Only a deposited cheque can bounce.");
    const d = day(b.bounced_on || istDay());
    if (!d) throw fail("The bounce date can't be in the future.");
    const reason = txt(b.reason, 200);
    if (!reason) throw fail("Give the reason the bank returned it (funds insufficient, signature differs …).");
    const charges = b.charges === "" || b.charges == null ? null : r2(b.charges);
    if (charges != null && charges < 0) throw fail("Bank charges can't be below 0.");
    let receiptCancelled = false;
    if (c.receipt_id) {
      const { rows } = await db.query(`SELECT cancelled_at FROM customer_receipts WHERE id = $1`, [c.receipt_id]);
      if (rows[0] && !rows[0].cancelled_at) {
        await unpostPayment(db, "customer", c.receipt_id, req.user.id, `Cheque ${c.cheque_no} bounced — ${reason}`);
        receiptCancelled = true;
      }
    }
    await db.query(`UPDATE cheques SET status = 'bounced', bounced_on = $2, bounce_reason = $3, bounce_charges = $4, updated_by = $5, updated_at = now() WHERE id = $1`,
      [c.id, d, reason, charges, req.user.id]);
    await chequeEvent(db, c.id, "bounced", { date: d, reason, charges, receipt_cancelled: receiptCancelled ? c.receipt_id : null }, req.user.id);
    return { ok: true, receipt_cancelled: receiptCancelled };
  });
});

// Presented again: back to "deposited"; it clears from a NEW bank line.
router.post("/cheques/:id(\\d+)/represent", EDIT, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (c.status !== "bounced") throw fail("Only a bounced cheque can be presented again.");
    const d = day(b.deposited_on || istDay());
    if (!d) throw fail("The date can't be in the future.");
    if (d < (c.bounced_on || c.cheque_date)) throw fail("It can't be presented again before it bounced.");
    await db.query(`UPDATE cheques SET status = 'deposited', deposited_on = $2, slip_no = $3, presentations = presentations + 1,
                           old_bank_lines = CASE WHEN bank_line_id IS NULL THEN old_bank_lines ELSE array_append(old_bank_lines, bank_line_id) END,
                           cleared_on = NULL, bank_line_id = NULL, receipt_id = NULL, updated_by = $4, updated_at = now() WHERE id = $1`,
      [c.id, d, txt(b.slip_no, 40), req.user.id]);
    await chequeEvent(db, c.id, "presented again", { date: d, previous_bank_line: c.bank_line_id, previous_receipt: c.receipt_id }, req.user.id);
  });
});

router.post("/cheques/:id(\\d+)/notice", EDIT, async (req, res) => {
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (c.status !== "bounced") throw fail("A notice is only for a bounced cheque.");
    const d = day(req.body?.notice_on);
    if (!d) throw fail("Enter the date the notice was sent.");
    await db.query(`UPDATE cheques SET notice_on = $2, updated_by = $3, updated_at = now() WHERE id = $1`, [c.id, d, req.user.id]);
    await chequeEvent(db, c.id, "notice sent", { date: d }, req.user.id);
  });
});

// ------------------------------------------- returned · paid another way ---
// p: { mode: cash | bank_transfer, amount, paid_on, reference,
//      posting: new (cash: record the receipt now) | link (an existing
//      receipt) | later (bank: linked when the bank statement posts it)
//      | none (cash taken in C Ledger, no receipt here), receipt_id }
async function addReplacement(db, c, p, userId) {
  const mode = p.mode === "cash" ? "cash" : p.mode === "bank_transfer" ? "bank_transfer" : null;
  if (!mode) throw fail("Paid how — cash or bank transfer?");
  const amount = r2(p.amount);
  if (!(amount > 0)) throw fail("Enter the amount paid instead.");
  const paidOn = p.paid_on ? day(p.paid_on) : null;
  if (p.paid_on && !paidOn) throw fail("The payment date can't be in the future.");
  const posting = ["new", "link", "later", "none"].includes(p.posting) ? p.posting : mode === "cash" ? "new" : "later";
  if (mode === "bank_transfer" && posting === "none") throw fail("A bank transfer is either linked to its receipt now or when the bank statement posts it.");
  let receiptId = null;
  if (posting === "new") {
    if (mode === "bank_transfer" && !(await ledgerSettings()).manual_payments) {
      throw fail("Money into the bank is posted from the bank statement — choose “link when the bank statement is posted” or link the receipt already posted.");
    }
    if (!paidOn) throw fail("Enter the day it was paid.");
    const out = await postReceipt(db, {
      customer_id: c.customer_id, receipt_date: paidOn, amount, mode: mode === "cash" ? "cash" : "bank_transfer",
      reference_number: txt(p.reference, 80) || `In place of cheque ${c.cheque_no}`,
      remarks: `Paid in place of returned cheque ${c.cheque_no} dated ${c.cheque_date}`, userId,
    });
    receiptId = out.id;
  } else if (posting === "link") {
    const { rows } = await db.query(
      `SELECT cr.id, cr.receipt_date::text AS d FROM customer_receipts cr WHERE cr.id = $1 AND cr.customer_id = $2 AND cr.cancelled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM cheque_replacements x WHERE x.receipt_id = cr.id AND x.removed_at IS NULL)`, [Number(p.receipt_id), c.customer_id]);
    if (!rows.length) throw fail("Choose one of this customer's receipts that isn't linked yet.");
    receiptId = rows[0].id;
  }
  const { rows } = await db.query(
    `INSERT INTO cheque_replacements (cheque_id, mode, amount, paid_on, reference, receipt_id, posting, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [c.id, mode, amount, paidOn, txt(p.reference, 80), receiptId, posting, userId]);
  await chequeEvent(db, c.id, "paid another way", { mode, amount, paid_on: paidOn, posting, receipt_id: receiptId }, userId);
  return rows[0].id;
}

router.post("/cheques/:id(\\d+)/return", EDIT, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (c.direction !== "received" || !["in_hand", "bounced"].includes(c.status)) throw fail("Only a cheque in hand (or a bounced one) can be returned to the customer.");
    const d = day(b.returned_on || istDay());
    if (!d) throw fail("The return date can't be in the future.");
    const payments = Array.isArray(b.payments) ? b.payments : [];
    if (payments.length > 6) throw fail("At most 6 payments at a time.");
    const total = r2(payments.reduce((s, p) => s + n0(p.amount), 0));
    if (total > n0(c.amount) * 1.5) throw fail("The payments are far more than the cheque — check the amounts.");
    await db.query(`UPDATE cheques SET status = 'returned', returned_on = $2, return_note = $3, updated_by = $4, updated_at = now() WHERE id = $1`,
      [c.id, d, txt(b.note, 300), req.user.id]);
    await chequeEvent(db, c.id, "returned to customer", { date: d, note: txt(b.note, 300) }, req.user.id);
    for (const p of payments) await addReplacement(db, c, p, req.user.id);
    return { ok: true, replaced: total };
  });
});

router.post("/cheques/:id(\\d+)/replacements", EDIT, async (req, res) => {
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (c.status !== "returned") throw fail("Payments in place of a cheque are added to a returned cheque.");
    return { id: await addReplacement(db, c, req.body || {}, req.user.id) };
  });
});

router.post("/cheques/:id(\\d+)/replacements/:rid(\\d+)/remove", EDIT, async (req, res) => {
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    const { rows } = await db.query(`SELECT * FROM cheque_replacements WHERE id = $1 AND cheque_id = $2 AND removed_at IS NULL FOR UPDATE`, [req.params.rid, c.id]);
    const r = rows[0];
    if (!r) throw fail("That payment is not on this cheque.", 404);
    // A cash receipt made here goes with it; a linked one only loses the link.
    if (r.posting === "new" && r.receipt_id) await unpostPayment(db, "customer", r.receipt_id, req.user.id, `Removed from returned cheque ${c.cheque_no}`);
    await db.query(`UPDATE cheque_replacements SET removed_at = now() WHERE id = $1`, [r.id]);
    await chequeEvent(db, c.id, "payment removed", { mode: r.mode, amount: n0(r.amount), receipt_cancelled: r.posting === "new" ? r.receipt_id : null }, req.user.id);
  });
});

router.post("/cheques/:id(\\d+)/cancel", EDIT, async (req, res) => {
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (!["in_hand", "issued"].includes(c.status)) throw fail("Only a cheque in hand, or an issued one not yet cleared, can be cancelled.");
    const reason = txt(req.body?.reason, 300);
    if (!reason) throw fail("Give the reason.");
    const { rows: pc } = await db.query(`SELECT id FROM pc_topups WHERE cheque_id = $1 AND status = 'received'`, [c.id]);
    if (pc.length) throw fail("This self cheque topped up petty cash — cancel that top-up in Petty cash; the cheque goes with it.");
    await db.query(`UPDATE cheques SET status = 'cancelled', cancelled_on = $2, cancel_reason = $3, updated_by = $4, updated_at = now() WHERE id = $1`,
      [c.id, istDay(), reason, req.user.id]);
    await chequeEvent(db, c.id, "cancelled", { reason }, req.user.id);
  });
});

router.post("/cheques/:id(\\d+)/stop", EDIT, async (req, res) => {
  await tx(res, async (db) => {
    const c = await loadCheque(db, Number(req.params.id), true);
    if (c.direction !== "issued" || c.status !== "issued") throw fail("Only an issued cheque not yet cleared can be stopped.");
    const reason = txt(req.body?.reason, 300);
    if (!reason) throw fail("Give the reason for stopping payment.");
    await db.query(`UPDATE cheques SET status = 'stopped', cancelled_on = $2, cancel_reason = $3, updated_by = $4, updated_at = now() WHERE id = $1`,
      [c.id, istDay(), reason, req.user.id]);
    await chequeEvent(db, c.id, "payment stopped", { reason }, req.user.id);
  });
});

// ======================================================== cheque books ===
router.get("/cheque-books", VIEW, async (_req, res) => { res.json(await booksWithLeaves()); });

router.post("/cheque-books", EDIT, async (req, res) => {
  const b = req.body || {};
  const accountId = Number(b.account_id);
  const { rows: acc } = await query(`SELECT id FROM cost_bank_accounts WHERE id = $1`, [accountId]);
  if (!acc.length) return bad(res, "Choose the bank account.");
  const firstTxt = String(b.first_no || "").replace(/\D/g, ""), lastTxt = String(b.last_no || "").replace(/\D/g, "");
  const first = Number(firstTxt), last = Number(lastTxt);
  if (!(first > 0) || !(last >= first)) return bad(res, "Enter the first and last leaf numbers.");
  if (last - first >= 1000) return bad(res, "A book has at most 1,000 leaves.");
  const { rows: overlap } = await query(
    `SELECT id FROM cheque_books WHERE account_id = $1 AND first_no <= $3 AND last_no >= $2`, [accountId, first, last]);
  if (overlap.length) return bad(res, "Those leaves overlap a book already entered for this account.");
  const { rows } = await query(
    `INSERT INTO cheque_books (account_id, first_no, last_no, digits, received_on, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [accountId, first, last, Math.min(12, Math.max(firstTxt.length, String(last).length, 6)), day(b.received_on) || null, txt(b.note, 200), req.user.id]);
  res.status(201).json({ id: rows[0].id });
});

router.post("/cheque-books/:id(\\d+)/active", EDIT, async (req, res) => {
  await query(`UPDATE cheque_books SET is_active = $2 WHERE id = $1`, [req.params.id, !!req.body?.active]);
  res.json({ ok: true });
});

export default router;
