// Round 253 — Accounts → Petty cash (owner, 30 Oct 2026; mock-up "Cheques &
// Petty Cash", artboard 2). Cash boxes with a fixed float; vouchers spend it;
// money comes in two ways, both recorded (owner: "through a top-up request or
// directly from bank transfer or C Ledger, all the ways to be recorded"):
//   request  the holder asks → the approver approves (or rejects) → whoever
//            pays it records how: bank transfer, a self cheque (it goes into
//            the cheque register), a cash withdrawal, or C Ledger cash
//   direct   the same four sources, recorded at once without a request
// C Ledger cash can only be given by that C Ledger cash holder; it leaves
// their C Ledger cash (a cl_transfers row of kind 'petty').
//
//   GET  /api/accounts/petty-cash                     boxes, balances, my rights, lists
//   GET  /api/accounts/petty-cash/:box?month=          one box's cash book for a month
//   POST /api/accounts/petty-cash/boxes[/:id]          set up a box          petty-cash-setup
//   POST /api/accounts/petty-cash/:box/vouchers        expense / advance      petty-cash create (holder)
//   POST /api/accounts/petty-cash/vouchers/:id/edit | delete | approve | reject | settle
//   GET  /api/accounts/petty-cash/vouchers/:id/photo
//   POST /api/accounts/petty-cash/:box/requests        ask for a top-up
//   POST /api/accounts/petty-cash/topups/:id/decide    approve / reject a request
//   POST /api/accounts/petty-cash/topups/:id/pay       pay an approved request
//   POST /api/accounts/petty-cash/:box/topups          a direct top-up
//   POST /api/accounts/petty-cash/topups/:id/cancel
//   POST /api/accounts/petty-cash/:box/counts          cash count by notes
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { istDay, istMonth } from "../lib/istDate.js";
import { ensureRound253, boxBalances, PC_CATEGORIES, PC_CATEGORY_KEYS, PC_COST_KEYS, chequeEvent } from "../lib/round253Schema.js";
import { clAccess, clLog, holderBalances, CL_FACTOR } from "../lib/cLedger.js";
import { createIssuedCheque } from "./accountsCheques.js";
import { pushToUser } from "../lib/push.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound253(); next(); } catch (e) { next(e); } });

const VIEW = requirePermission("accounts.petty-cash", "view");
const SETUP = requirePermission("accounts.petty-cash-setup", "edit");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const txt = (v, max) => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const day = (v) => (ISO.test(v || "") && v <= istDay() ? v : null);
const SOURCES = { bank_transfer: "Bank transfer", cheque: "Self cheque", cash_withdrawal: "Cash withdrawn from the bank", cledger: "C Ledger cash" };
const vno = (v) => `${v.kind === "advance" ? "ADV" : v.kind === "settle" ? "SET" : "PC"}-${String(v.id).padStart(4, "0")}`;

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
async function pcLog(db, boxId, kind, refId, action, detail, by) {
  await db.query(`INSERT INTO pc_log (box_id, kind, ref_id, action, detail, done_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [boxId, kind, refId, action, detail ? JSON.stringify(detail) : null, by]);
}

// What this person may do — overall and per box.
async function rights(user) {
  const [create, edit, approve, fund, setup, cl] = await Promise.all([
    can(user, "accounts.petty-cash", "create"), can(user, "accounts.petty-cash", "edit"),
    can(user, "accounts.petty-cash-approve", "edit"), can(user, "accounts.petty-cash-fund", "create"),
    can(user, "accounts.petty-cash-setup", "edit"), clAccess(user.id),
  ]);
  return { create, edit, approve, fund, setup, cl_holder: !!cl.cash_holder };
}
const boxRights = (r, box, userId) => ({
  voucher: r.create && (box.holder_id === userId || r.edit),
  approve: r.approve || (box.approver_id != null && box.approver_id === userId),
  request: r.create && (box.holder_id === userId || r.edit),
  fund: r.fund,
  fund_cl: r.cl_holder,
  count: box.holder_id === userId || r.edit,
});
async function loadBox(db, id) {
  const { rows } = await db.query(`SELECT * FROM pc_boxes WHERE id = $1`, [id]);
  if (!rows.length) throw fail("Cash box not found.", 404);
  return { ...rows[0], float_amount: n0(rows[0].float_amount), approval_limit: n0(rows[0].approval_limit) };
}
// Within the box's limit a voucher is approved as it is saved; above it (or
// when the limit is 0) it waits for the approver.
const autoApproved = (box, amount) => box.approval_limit > 0 && amount <= box.approval_limit;

// ================================================================ lists ===
router.get("/petty-cash", VIEW, async (req, res) => {
  const me = req.user.id;
  const r = await rights(req.user);
  const safe = (p) => p.then((x) => x.rows).catch(() => []);
  const [boxes, bal, pendingV, requests, lastCounts, assets, accounts, users] = await Promise.all([
    safe(query(`SELECT b.*, h.name AS holder_name, a.name AS approver_name FROM pc_boxes b
                 LEFT JOIN users h ON h.id = b.holder_id LEFT JOIN users a ON a.id = b.approver_id ORDER BY b.is_active DESC, b.name`)),
    boxBalances(),
    safe(query(`SELECT box_id, COUNT(*)::int AS n, SUM(amount) AS amount, MIN(txn_date)::text AS oldest FROM pc_vouchers
                 WHERE deleted_at IS NULL AND status = 'pending' GROUP BY box_id`)),
    safe(query(`SELECT t.*, t.requested_at, u.name AS requested_by_name, d.name AS decided_by_name FROM pc_topups t
                 LEFT JOIN users u ON u.id = t.requested_by LEFT JOIN users d ON d.id = t.decided_by
                 WHERE t.status IN ('requested','approved') ORDER BY t.id`)),
    safe(query(`SELECT DISTINCT ON (box_id) box_id, counted_on::text AS counted_on, counted, book, diff, reason FROM pc_counts ORDER BY box_id, counted_on DESC, id DESC`)),
    safe(query(`SELECT id, name, reg_no FROM mnt_assets WHERE is_active ORDER BY asset_group, name`)),
    safe(query(`SELECT id, bank, label, number FROM cost_bank_accounts WHERE is_active ORDER BY bank, id`)),
    r.setup ? safe(query(`SELECT id, name, role FROM users WHERE is_active ORDER BY name`)) : Promise.resolve([]),
  ]);
  const pBy = new Map(pendingV.map((p) => [p.box_id, p]));
  const cBy = new Map(lastCounts.map((c) => [c.box_id, c]));
  let clBalance = null;
  if (r.cl_holder) clBalance = (await holderBalances().catch(() => [])).find((h) => h.id === me)?.balance ?? 0;
  res.json({
    me, today: istDay(), rights: r, cl_balance: clBalance,
    boxes: boxes.map((b) => {
      const box = { ...b, float_amount: n0(b.float_amount), approval_limit: n0(b.approval_limit) };
      const bb = bal.get(b.id) || { balance: 0 };
      const p = pBy.get(b.id);
      const c = cBy.get(b.id);
      return {
        ...box, ...bb, pct: box.float_amount > 0 ? Math.round((bb.balance / box.float_amount) * 100) : null,
        suggested_topup: r2(Math.max(0, box.float_amount - bb.balance)),
        pending: p ? { n: p.n, amount: r2(p.amount), oldest: p.oldest } : { n: 0, amount: 0 },
        last_count: c ? { ...c, counted: n0(c.counted), book: n0(c.book), diff: n0(c.diff) } : null,
        can: boxRights(r, box, me),
      };
    }),
    requests: requests.map((t) => ({ ...t, request_amount: n0(t.request_amount), amount: t.amount == null ? null : n0(t.amount) })),
    categories: PC_CATEGORIES.filter((c) => c.key !== "todo").map((c) => ({ key: c.key, label: c.label, cost: PC_COST_KEYS.has(c.key) })),
    sources: Object.entries(SOURCES).map(([key, label]) => ({ key, label })),
    assets, users,
    accounts: accounts.map((a) => ({ id: a.id, label: `${a.label || a.bank} ••${String(a.number).slice(-4)}` })),
  });
});

// One box's cash book for a month: opening balance, every movement with the
// running balance, the requests and top-ups, open advances and counts.
router.get("/petty-cash/:box(\\d+)", VIEW, async (req, res) => {
  const box = await loadBox({ query }, Number(req.params.box));
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : istMonth();
  const from = `${ym}-01`;
  const [y, m] = ym.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // ist-ok: last day of a given month, calendar arithmetic
  const [{ rows: tops }, { rows: vouchers }, { rows: counts }, { rows: openAdv }] = await Promise.all([
    query(`SELECT t.id, t.received_on::text AS d, t.amount, t.source, t.reference, t.direct, t.request_amount, t.status, t.cancel_reason,
                  a.bank || ' ••' || right(a.number, 4) AS account, ch.cheque_no, COALESCE(cla.short_name, clu.name) AS cl_holder, rb.name AS recorded_by_name
             FROM pc_topups t LEFT JOIN cost_bank_accounts a ON a.id = t.account_id LEFT JOIN cheques ch ON ch.id = t.cheque_id
             LEFT JOIN users clu ON clu.id = t.cl_holder_id LEFT JOIN cl_access cla ON cla.user_id = t.cl_holder_id LEFT JOIN users rb ON rb.id = t.recorded_by
            WHERE t.box_id = $1 AND t.received_on IS NOT NULL AND t.status IN ('received','cancelled') ORDER BY t.received_on, t.id`, [box.id]),
    query(`SELECT v.id, v.kind, v.txn_date::text AS d, v.amount, v.paid_to, v.purpose, v.category, v.asset_id, ma.name AS asset_name, v.bill,
                  (v.bill_photo IS NOT NULL) AS has_photo, v.flagged, v.status, v.decision_note, v.advance_id, v.settled_on::text AS settled_on,
                  v.returned_amount, v.created_by, u.name AS created_by_name, du.name AS decided_by_name
             FROM pc_vouchers v LEFT JOIN users u ON u.id = v.created_by LEFT JOIN users du ON du.id = v.decided_by LEFT JOIN mnt_assets ma ON ma.id = v.asset_id
            WHERE v.box_id = $1 AND v.deleted_at IS NULL ORDER BY v.txn_date, v.id`, [box.id]),
    query(`SELECT c.*, c.counted_on::text AS counted_on, u.name AS counted_by_name FROM pc_counts c LEFT JOIN users u ON u.id = c.counted_by
            WHERE c.box_id = $1 ORDER BY c.counted_on DESC, c.id DESC LIMIT 12`, [box.id]),
    query(`SELECT v.id FROM pc_vouchers v WHERE v.box_id = $1 AND v.deleted_at IS NULL AND v.kind = 'advance' AND v.status <> 'rejected' AND v.settled_on IS NULL`, [box.id]),
  ]);
  // Every cash movement: [date, sort id, effect, row]
  const moves = [];
  for (const t of tops) if (t.status === "received") moves.push({ d: t.d, k: `t${t.id}`, eff: n0(t.amount), row: { type: "topup", ...t, amount: n0(t.amount), source_label: SOURCES[t.source] || t.source } });
  for (const v of vouchers) {
    const row = { type: "voucher", ...v, amount: n0(v.amount), returned_amount: v.returned_amount == null ? null : n0(v.returned_amount), no: vno(v),
      cost: v.status === "approved" && v.kind !== "advance" && PC_COST_KEYS.has(v.category) ? r2(n0(v.amount) * (v.flagged ? 1 : CL_FACTOR)) : 0 };
    const cash = v.kind === "settle" || v.status === "rejected" ? 0 : -n0(v.amount);
    moves.push({ d: v.d, k: `v${String(v.id).padStart(8, "0")}`, eff: cash, row });
    if (v.kind === "advance" && v.settled_on && v.status !== "rejected" && n0(v.returned_amount) !== 0) {
      // After the day's vouchers ("x" sorts after "v"), so it never shows before the advance itself.
      moves.push({ d: v.settled_on, k: `x${String(v.id).padStart(8, "0")}`, eff: n0(v.returned_amount),
        row: { type: "return", id: v.id, d: v.settled_on, amount: n0(v.returned_amount), paid_to: v.paid_to, no: vno(v) } });
    }
  }
  moves.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.k < b.k ? -1 : 1));
  let opening = 0;
  for (const mv of moves) if (mv.d < from) opening += mv.eff;
  let run = opening;
  const rows = [];
  for (const mv of moves) {
    if (mv.d < from || mv.d > end) continue;
    run += mv.eff;
    rows.push({ ...mv.row, cash: r2(mv.eff), balance: r2(run) });
  }
  const r = await rights(req.user);
  const bal = (await boxBalances({ query }, box.id)).get(box.id) || { balance: 0 };
  const inMonth = (d) => d >= from && d <= end;
  res.json({
    box: { ...box, ...bal, can: boxRights(r, box, req.user.id) }, month: ym, opening: r2(opening), closing: r2(run), rows,
    summary: {
      topups: r2(rows.filter((x) => x.type === "topup").reduce((s, x) => s + x.amount, 0)),
      spent: r2(vouchers.filter((v) => v.kind !== "advance" && v.status !== "rejected" && inMonth(v.d)).reduce((s, v) => s + n0(v.amount), 0)),
      vouchers: vouchers.filter((v) => v.kind === "expense" && inMonth(v.d)).length,
      cost: r2(rows.filter((x) => x.type === "voucher").reduce((s, x) => s + (x.cost || 0), 0)),
      no_bill: vouchers.filter((v) => v.kind !== "advance" && v.bill === "none" && v.status !== "rejected" && inMonth(v.d)).length,
    },
    pending: vouchers.filter((v) => v.status === "pending").map((v) => ({ ...v, amount: n0(v.amount), no: vno(v) })),
    open_advances: vouchers.filter((v) => openAdv.some((o) => o.id === v.id)).map((v) => ({ ...v, amount: n0(v.amount), no: vno(v) })),
    cancelled_topups: tops.filter((t) => t.status === "cancelled" && inMonth(t.d)).map((t) => ({ ...t, amount: n0(t.amount), source_label: SOURCES[t.source] || t.source })),
    counts: counts.map((c) => ({ ...c, counted: n0(c.counted), book: n0(c.book), diff: n0(c.diff) })),
  });
});

// ================================================================ boxes ===
router.post("/petty-cash/boxes", SETUP, async (req, res) => saveBox(req, res, null));
router.post("/petty-cash/boxes/:id(\\d+)", SETUP, async (req, res) => saveBox(req, res, Number(req.params.id)));
async function saveBox(req, res, id) {
  const b = req.body || {};
  const name = txt(b.name, 80);
  if (!name) return bad(res, "Name the cash box (e.g. Plant office).");
  const holder = Number(b.holder_id) || null;
  if (!holder) return bad(res, "Choose who holds the cash.");
  const approver = Number(b.approver_id) || null;
  const float = r2(b.float_amount), limit = r2(b.approval_limit);
  if (!(float > 0)) return bad(res, "Enter the float — the cash the box is kept topped up to.");
  if (limit < 0) return bad(res, "The approval limit can't be below 0.");
  const pct = Math.min(100, Math.max(0, Math.round(n0(b.topup_below_pct ?? 25))));
  const vals = [name, holder, approver, float, limit, pct, b.is_active !== false];
  try {
    if (id) {
      const { rowCount } = await query(`UPDATE pc_boxes SET name = $2, holder_id = $3, approver_id = $4, float_amount = $5, approval_limit = $6, topup_below_pct = $7,
                                               is_active = $8, updated_at = now() WHERE id = $1`, [id, ...vals]);
      if (!rowCount) return bad(res, "Cash box not found.", 404);
      await pcLog({ query }, id, "box", id, "changed", { name, holder, approver, float, limit }, req.user.id);
      return res.json({ id });
    }
    const { rows } = await query(`INSERT INTO pc_boxes (name, holder_id, approver_id, float_amount, approval_limit, topup_below_pct, is_active, created_by)
                                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [...vals, req.user.id]);
    await pcLog({ query }, rows[0].id, "box", rows[0].id, "created", { name, holder, float }, req.user.id);
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === "23505") return bad(res, "There is already a cash box with that name.");
    throw e;
  }
}

// ============================================================= vouchers ===
function cleanPhoto(p) {
  if (!p) return null;
  const s = String(p);
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(s)) throw fail("The bill photo must be a JPEG, PNG or WebP image.");
  if (s.length > 2_500_000) throw fail("The photo is too large — take it again at a lower size.");
  return s;
}
function cleanVoucher(b, { kind }) {
  const d = day(b.txn_date || istDay());
  if (!d) throw fail("The date can't be in the future.");
  const amount = r2(b.amount);
  if (!(amount > 0)) throw fail("Enter the amount.");
  const paidTo = txt(b.paid_to, 150);
  if (!paidTo) throw fail(kind === "advance" ? "Who is the advance given to?" : "Paid to — the shop or person.");
  const purpose = txt(b.purpose, 300);
  let category = null;
  if (kind !== "advance") {
    if (!PC_CATEGORY_KEYS.has(b.category) || b.category === "todo") throw fail("Choose the expense head.");
    category = b.category;
    if (!purpose) throw fail("What was it for?");
  } else if (!purpose) throw fail("What is the advance for?");
  const bill = ["photo", "slip", "none"].includes(b.bill) ? b.bill : b.photo ? "photo" : "none";
  const photo = cleanPhoto(b.photo);
  return { d, amount, paidTo, purpose, category, asset_id: Number(b.asset_id) || null, bill: photo ? "photo" : bill === "photo" ? "none" : bill, photo, flagged: kind !== "advance" && !!b.flagged };
}

router.post("/petty-cash/:box(\\d+)/vouchers", VIEW, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const box = await loadBox(db, Number(req.params.box));
    if (!box.is_active) throw fail("This cash box is closed.");
    const r = boxRights(await rights(req.user), box, req.user.id);
    if (!r.voucher) throw fail("Only the box's cash holder (or Accounts) can add vouchers here.", 403);
    const kind = b.kind === "advance" ? "advance" : "expense";
    const v = cleanVoucher(b, { kind });
    const status = autoApproved(box, v.amount) ? "approved" : "pending";
    const { rows } = await db.query(
      `INSERT INTO pc_vouchers (box_id, kind, txn_date, amount, paid_to, purpose, category, asset_id, bill, bill_photo, flagged, status, decision_note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, kind`,
      [box.id, kind, v.d, v.amount, v.paidTo, v.purpose, v.category, v.asset_id, v.bill, v.photo, v.flagged, status,
        status === "approved" ? "Within the box's limit" : null, req.user.id]);
    await pcLog(db, box.id, "voucher", rows[0].id, "created", { kind, amount: v.amount, status }, req.user.id);
    if (status === "pending" && box.approver_id && box.approver_id !== req.user.id) {
      pushToUser(box.approver_id, { title: "Petty cash voucher to approve", body: `${box.name}: ₹${v.amount.toLocaleString("en-IN")} — ${v.paidTo}`, url: "/accounts?tab=petty-cash" }).catch(() => {});
    }
    return { id: rows[0].id, no: vno(rows[0]), status };
  });
});

async function loadVoucher(db, id) {
  const { rows } = await db.query(`SELECT *, txn_date::text AS d FROM pc_vouchers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
  if (!rows.length) throw fail("Voucher not found.", 404);
  return { ...rows[0], amount: n0(rows[0].amount) };
}

router.get("/petty-cash/vouchers/:id(\\d+)/photo", VIEW, async (req, res) => {
  const { rows } = await query(`SELECT bill_photo FROM pc_vouchers WHERE id = $1`, [req.params.id]);
  res.json({ photo: rows[0]?.bill_photo || null });
});

// Changed while waiting for approval (by whoever wrote it or the approver).
router.post("/petty-cash/vouchers/:id(\\d+)/edit", VIEW, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const v0 = await loadVoucher(db, Number(req.params.id));
    const box = await loadBox(db, v0.box_id);
    const r = boxRights(await rights(req.user), box, req.user.id);
    if (v0.status !== "pending" && !r.approve) throw fail("An approved or rejected voucher can only be changed by the approver.", 403);
    if (v0.created_by !== req.user.id && !r.approve && !r.voucher) throw fail("You can't change this voucher.", 403);
    if (v0.kind === "advance" && v0.settled_on) throw fail("This advance is settled — it can't be changed.");
    const v = cleanVoucher({ ...b, photo: b.photo === undefined ? null : b.photo }, { kind: v0.kind === "settle" ? "expense" : v0.kind });
    const keepPhoto = b.photo === undefined && v0.bill_photo;
    const status = v0.status === "pending" && autoApproved(box, v.amount) ? "approved" : v0.status;
    if (v0.kind === "settle") {
      // A settlement changes what came back from its advance.
      const { rows: adv } = await db.query(`SELECT amount FROM pc_vouchers WHERE id = $1`, [v0.advance_id]);
      await db.query(`UPDATE pc_vouchers SET returned_amount = $2 WHERE id = $1`, [v0.advance_id, r2(n0(adv[0]?.amount) - v.amount)]);
    }
    await db.query(
      `UPDATE pc_vouchers SET txn_date = $2, amount = $3, paid_to = $4, purpose = $5, category = $6, asset_id = $7, bill = $8,
              bill_photo = $9, flagged = $10, status = $11, updated_by = $12, updated_at = now() WHERE id = $1`,
      [v0.id, v.d, v.amount, v.paidTo, v.purpose, v.category, v.asset_id, keepPhoto ? "photo" : v.bill, keepPhoto ? v0.bill_photo : v.photo, v.flagged, status, req.user.id]);
    await pcLog(db, box.id, "voucher", v0.id, "changed", { before: { amount: v0.amount, date: v0.d, category: v0.category }, after: { amount: v.amount, date: v.d, category: v.category } }, req.user.id);
  });
});

router.post("/petty-cash/vouchers/:id(\\d+)/delete", VIEW, async (req, res) => {
  await tx(res, async (db) => {
    const v = await loadVoucher(db, Number(req.params.id));
    const box = await loadBox(db, v.box_id);
    const r = boxRights(await rights(req.user), box, req.user.id);
    if (!(r.approve || (v.status === "pending" && v.created_by === req.user.id))) throw fail("Only a voucher still waiting for approval can be taken back by whoever wrote it; otherwise the approver deletes it.", 403);
    if (v.kind === "advance" && v.settled_on) throw fail("Delete the settlement first.");
    const reason = txt(req.body?.reason, 300);
    if (v.status !== "pending" && !reason) throw fail("Give the reason.");
    if (v.kind === "settle") await db.query(`UPDATE pc_vouchers SET settled_on = NULL, returned_amount = NULL WHERE id = $1`, [v.advance_id]);
    await db.query(`UPDATE pc_vouchers SET deleted_at = now(), deleted_by = $2, decision_note = COALESCE($3, decision_note) WHERE id = $1`, [v.id, req.user.id, reason]);
    await pcLog(db, box.id, "voucher", v.id, "deleted", { amount: v.amount, reason }, req.user.id);
  });
});

async function decideVoucher(req, res, decision) {
  await tx(res, async (db) => {
    const v = await loadVoucher(db, Number(req.params.id));
    const box = await loadBox(db, v.box_id);
    if (!boxRights(await rights(req.user), box, req.user.id).approve) throw fail("Only the box's approver can do this.", 403);
    if (v.status !== "pending") throw fail("This voucher is not waiting for approval.");
    if (decision === "rejected" && v.kind === "advance" && v.settled_on) throw fail("This advance is already settled — delete the settlement first, then reject it.");
    const note = txt(req.body?.note, 300);
    if (decision === "rejected" && !note) throw fail("Say why it is rejected (the cash goes back into the box).");
    await db.query(`UPDATE pc_vouchers SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [v.id, decision, req.user.id, note]);
    await pcLog(db, box.id, "voucher", v.id, decision, { note }, req.user.id);
  });
}
router.post("/petty-cash/vouchers/:id(\\d+)/approve", VIEW, (req, res) => decideVoucher(req, res, "approved"));
router.post("/petty-cash/vouchers/:id(\\d+)/reject", VIEW, (req, res) => decideVoucher(req, res, "rejected"));

// An advance is settled with what it was spent on (a "settle" voucher, the
// cost) and the cash that came back into the box (spent more than the
// advance: the extra left the box now).
router.post("/petty-cash/vouchers/:id(\\d+)/settle", VIEW, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const adv = await loadVoucher(db, Number(req.params.id));
    if (adv.kind !== "advance") throw fail("Only an advance is settled.");
    if (adv.status === "rejected") throw fail("This advance was rejected.");
    if (adv.settled_on) throw fail("This advance is already settled.");
    const box = await loadBox(db, adv.box_id);
    const r = boxRights(await rights(req.user), box, req.user.id);
    if (!r.voucher && !r.approve) throw fail("Only the box's cash holder or approver can settle an advance.", 403);
    const settledOn = day(b.settled_on || istDay());
    if (!settledOn) throw fail("The date can't be in the future.");
    if (settledOn < adv.d) throw fail("It can't be settled before the advance was given.");
    const spent = r2(b.amount);
    if (spent < 0) throw fail("Spent can't be below 0.");
    let settleId = null;
    if (spent > 0) {
      const v = cleanVoucher({ ...b, txn_date: settledOn, paid_to: b.paid_to || adv.paid_to }, { kind: "expense" });
      const status = autoApproved(box, spent) ? "approved" : "pending";
      const { rows } = await db.query(
        `INSERT INTO pc_vouchers (box_id, kind, txn_date, amount, paid_to, purpose, category, asset_id, bill, bill_photo, flagged, status, decision_note, advance_id, created_by)
         VALUES ($1, 'settle', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [box.id, settledOn, spent, v.paidTo, v.purpose, v.category, v.asset_id, v.bill, v.photo, v.flagged, status,
          status === "approved" ? "Within the box's limit" : null, adv.id, req.user.id]);
      settleId = rows[0].id;
    }
    const back = r2(adv.amount - spent);
    await db.query(`UPDATE pc_vouchers SET settled_on = $2, returned_amount = $3 WHERE id = $1`, [adv.id, settledOn, back]);
    await pcLog(db, box.id, "voucher", adv.id, "settled", { spent, back, settle_id: settleId }, req.user.id);
    return { ok: true, returned: back, settle_id: settleId };
  });
});

// =============================================================== top-ups ===
router.post("/petty-cash/:box(\\d+)/requests", VIEW, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const box = await loadBox(db, Number(req.params.box));
    if (!box.is_active) throw fail("This cash box is closed.");
    if (!boxRights(await rights(req.user), box, req.user.id).request) throw fail("Only the box's cash holder (or Accounts) can ask for a top-up.", 403);
    const amount = r2(b.amount);
    if (!(amount > 0)) throw fail("Enter the amount needed.");
    const { rows: open } = await db.query(`SELECT id FROM pc_topups WHERE box_id = $1 AND status IN ('requested','approved')`, [box.id]);
    if (open.length) throw fail("There is already a top-up request open for this box.");
    const { rows } = await db.query(
      `INSERT INTO pc_topups (box_id, status, request_amount, request_note, requested_by, requested_at) VALUES ($1, 'requested', $2, $3, $4, now()) RETURNING id`,
      [box.id, amount, txt(b.note, 300), req.user.id]);
    await pcLog(db, box.id, "topup", rows[0].id, "requested", { amount }, req.user.id);
    if (box.approver_id && box.approver_id !== req.user.id) {
      pushToUser(box.approver_id, { title: "Petty cash top-up requested", body: `${box.name}: ₹${amount.toLocaleString("en-IN")}`, url: "/accounts?tab=petty-cash" }).catch(() => {});
    }
    return { id: rows[0].id };
  });
});

router.post("/petty-cash/topups/:id(\\d+)/decide", VIEW, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const { rows } = await db.query(`SELECT * FROM pc_topups WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const t = rows[0];
    if (!t || t.status !== "requested") throw fail("That request is not waiting for a decision.");
    const box = await loadBox(db, t.box_id);
    if (!boxRights(await rights(req.user), box, req.user.id).approve) throw fail("Only the box's approver can decide.", 403);
    const approve = b.decision === "approve";
    const note = txt(b.note, 300);
    if (!approve && !note) throw fail("Say why it is rejected.");
    const amount = approve ? r2(b.amount || t.request_amount) : null;
    if (approve && !(amount > 0)) throw fail("Enter the amount approved.");
    await db.query(`UPDATE pc_topups SET status = $2, amount = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE id = $1`,
      [t.id, approve ? "approved" : "rejected", amount, req.user.id, note]);
    await pcLog(db, box.id, "topup", t.id, approve ? "approved" : "rejected", { amount, note }, req.user.id);
    if (t.requested_by && t.requested_by !== req.user.id) {
      pushToUser(t.requested_by, { title: approve ? "Petty cash top-up approved" : "Petty cash top-up rejected",
        body: `${box.name}${approve ? `: ₹${amount.toLocaleString("en-IN")}` : note ? ` — ${note}` : ""}`, url: "/accounts?tab=petty-cash" }).catch(() => {});
    }
  });
});

// Records the money reaching the box: from a request that was approved, or
// direct. Bank transfer / cash withdrawal name the account; a self cheque is
// entered in the cheque register; C Ledger cash leaves the giver's C Ledger.
async function receiveTopup(db, req, box, t) {
  const b = req.body || {};
  const r = await rights(req.user);
  const source = SOURCES[b.source] ? b.source : null;
  if (!source) throw fail("Where did the money come from?");
  if (source === "cledger" && !r.cl_holder) throw fail("Only a C Ledger cash holder can give C Ledger cash — they record it themselves.", 403);
  if (source !== "cledger" && !r.fund) throw fail("You can't record a top-up from the bank.", 403);
  const amount = r2(b.amount || t?.amount);
  if (!(amount > 0)) throw fail("Enter the amount.");
  const d = day(b.received_on || istDay());
  if (!d) throw fail("The date can't be in the future.");
  let accountId = null, chequeId = null, clTransferId = null, chequeNo = null;
  if (source !== "cledger") {
    accountId = Number(b.account_id);
    const { rows } = await db.query(`SELECT id FROM cost_bank_accounts WHERE id = $1`, [accountId]);
    if (!rows.length) throw fail("Choose the bank account the money came from.");
  }
  if (source === "cheque") {
    const out = await createIssuedCheque(db, { account_id: accountId, cheque_no: b.cheque_no, cheque_date: d, amount, payee_kind: "self",
      payee_name: `Self — petty cash (${box.name})`, purpose: "Petty cash top-up" }, req.user.id);
    chequeId = out.id; chequeNo = out.cheque_no;
  }
  if (source === "cledger") {
    const { rows } = await db.query(
      `INSERT INTO cl_transfers (txn_date, kind, from_id, to_id, amount, note, status, responded_at) VALUES ($1, 'petty', $2, NULL, $3, $4, 'accepted', now()) RETURNING id`,
      [d, req.user.id, amount, `To petty cash — ${box.name}`]);
    clTransferId = rows[0].id;
    await clLog(db, "transfer", clTransferId, "to petty cash", { amount, box: box.name }, req.user.id);
  }
  const ref = txt(b.reference, 80) || (chequeNo ? `Cheque ${chequeNo}` : null);
  const cols = [amount, source, accountId, ref, chequeId, source === "cledger" ? req.user.id : null, clTransferId, d, req.user.id];
  let id;
  if (t) {
    await db.query(`UPDATE pc_topups SET status = 'received', amount = $2, source = $3, account_id = $4, reference = $5, cheque_id = $6, cl_holder_id = $7,
                           cl_transfer_id = $8, received_on = $9, recorded_by = $10, recorded_at = now() WHERE id = $1`, [t.id, ...cols]);
    id = t.id;
  } else {
    const { rows } = await db.query(
      `INSERT INTO pc_topups (box_id, status, direct, amount, source, account_id, reference, cheque_id, cl_holder_id, cl_transfer_id, received_on, recorded_by, recorded_at, request_note)
       VALUES ($1, 'received', true, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11) RETURNING id`, [box.id, ...cols, txt(b.note, 300)]);
    id = rows[0].id;
  }
  if (chequeId) await chequeEvent(db, chequeId, "petty cash top-up", { box: box.name, topup_id: id }, req.user.id);
  await pcLog(db, box.id, "topup", id, "received", { amount, source, direct: !t }, req.user.id);
  return { id, cheque_no: chequeNo };
}

router.post("/petty-cash/topups/:id(\\d+)/pay", VIEW, async (req, res) => {
  await tx(res, async (db) => {
    const { rows } = await db.query(`SELECT *, amount FROM pc_topups WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const t = rows[0];
    if (!t || t.status !== "approved") throw fail("Only an approved request can be paid.");
    const box = await loadBox(db, t.box_id);
    return receiveTopup(db, req, box, { ...t, amount: n0(t.amount) });
  });
});

router.post("/petty-cash/:box(\\d+)/topups", VIEW, async (req, res) => {
  await tx(res, async (db) => {
    const box = await loadBox(db, Number(req.params.box));
    if (!box.is_active) throw fail("This cash box is closed.");
    return receiveTopup(db, req, box, null);
  });
});

// A request taken back (by who asked or the approver); a top-up recorded by
// mistake (by who recorded it or the approver): its C Ledger cash goes back,
// its self cheque is cancelled (unless the bank has already paid it).
router.post("/petty-cash/topups/:id(\\d+)/cancel", VIEW, async (req, res) => {
  await tx(res, async (db) => {
    const { rows } = await db.query(`SELECT * FROM pc_topups WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const t = rows[0];
    if (!t || !["requested", "approved", "received"].includes(t.status)) throw fail("Nothing to cancel.");
    const box = await loadBox(db, t.box_id);
    const r = boxRights(await rights(req.user), box, req.user.id);
    const mine = t.status === "received" ? t.recorded_by === req.user.id : t.requested_by === req.user.id;
    if (!mine && !r.approve) throw fail("Only whoever entered it, or the box's approver, can cancel this.", 403);
    const reason = txt(req.body?.reason, 300);
    if (t.status === "received" && !reason) throw fail("Give the reason.");
    if (t.cheque_id) {
      const { rows: ch } = await db.query(`SELECT status, cheque_no FROM cheques WHERE id = $1 FOR UPDATE`, [t.cheque_id]);
      if (ch[0]?.status === "cleared") throw fail(`Self cheque ${ch[0].cheque_no} has already been paid by the bank — the money did leave the bank, so this top-up stands.`);
      await db.query(`UPDATE cheques SET status = 'cancelled', cancelled_on = $2, cancel_reason = $3, updated_by = $4, updated_at = now() WHERE id = $1 AND status = 'issued'`,
        [t.cheque_id, istDay(), `Petty cash top-up cancelled — ${reason || ""}`.slice(0, 300), req.user.id]);
      await chequeEvent(db, t.cheque_id, "cancelled", { reason: "petty cash top-up cancelled" }, req.user.id);
    }
    if (t.cl_transfer_id) {
      await db.query(`UPDATE cl_transfers SET deleted_at = now() WHERE id = $1`, [t.cl_transfer_id]);
      await clLog(db, "transfer", t.cl_transfer_id, "petty cash top-up cancelled", { reason }, req.user.id);
    }
    await db.query(`UPDATE pc_topups SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [t.id, reason]);
    await pcLog(db, box.id, "topup", t.id, "cancelled", { reason, was: t.status }, req.user.id);
  });
});

// ================================================================ counts ===
const NOTES = [500, 200, 100, 50, 20, 10];
router.post("/petty-cash/:box(\\d+)/counts", VIEW, async (req, res) => {
  const b = req.body || {};
  await tx(res, async (db) => {
    const box = await loadBox(db, Number(req.params.box));
    if (!boxRights(await rights(req.user), box, req.user.id).count) throw fail("Only the box's cash holder (or Accounts) records a count.", 403);
    const notes = {};
    let counted = 0;
    for (const n of NOTES) {
      const k = Math.round(n0(b.notes?.[n]));
      if (k < 0) throw fail("A note count can't be below 0.");
      if (k) { notes[n] = k; counted += n * k; }
    }
    const coins = r2(b.notes?.coins);
    if (coins < 0) throw fail("Coins can't be below 0.");
    if (coins) { notes.coins = coins; counted += coins; }
    counted = r2(counted);
    const book = (await boxBalances(db, box.id)).get(box.id)?.balance ?? 0;
    const diff = r2(counted - book);
    const reason = txt(b.reason, 300);
    if (Math.abs(diff) >= 1 && !reason) throw fail(`The count is ${diff > 0 ? "over" : "short"} by ₹${Math.abs(diff).toLocaleString("en-IN")} — give the reason.`);
    const { rows } = await db.query(
      `INSERT INTO pc_counts (box_id, counted_on, notes, counted, book, diff, reason, counted_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [box.id, istDay(), JSON.stringify(notes), counted, book, diff, reason, req.user.id]);
    await pcLog(db, box.id, "count", rows[0].id, "counted", { counted, book, diff }, req.user.id);
    return { id: rows[0].id, counted, book, diff };
  });
});

export default router;
