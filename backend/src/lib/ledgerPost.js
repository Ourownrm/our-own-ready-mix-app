// Round 235 (owner, 23 Oct 2026; mock-up "Bank & C Ledger payments to
// ledgers"). Every payment is sorted once — on its bank statement line, or in
// C Ledger for cash — and posts from there into the party's own ledger:
//   supplier     → rm_supplier_payments (+ bills it settles)   Supplier ledger
//   transporter  → rm_transporter_payments                     Transporter ledger
//   contractor   → hr_contractor_payments (+ the bill)         Contractor ledger (HR)
//   maintenance  → mnt_payments against an open mnt_bill       Maintenance → Payments
//   certificate  → a new mnt_certificates row (renewal), with its fee bill paid —
//                  the P&L spreads the fee over the period it covers.
// The posted record carries source ('bank' | 'cledger') and source_id, so the
// ledger shows where it came from and it can only be undone at its source.
// None of these is a cost on the bank line: material, freight, labour and
// repair costs reach the P&L from their own records.
import { query } from "../db.js";
import { postReceipt, applyAdvances } from "./receivables.js";
import { buildLedgers } from "./supplierLedger.js";
import { CERT_TYPES } from "./round216Schema.js";
import { istDay } from "./istDate.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const ROUND235_SQL = `
ALTER TABLE cost_bank_lines DROP CONSTRAINT IF EXISTS cost_bank_lines_treatment_check;
ALTER TABLE cost_bank_lines ADD CONSTRAINT cost_bank_lines_treatment_check
  CHECK (treatment IN ('todo','check','cost','omit','own','loan','tax','asset','capital','personal','pay','cert'));
ALTER TABLE cost_bank_lines ADD COLUMN IF NOT EXISTS post_kind VARCHAR(12);
ALTER TABLE cost_bank_lines ADD COLUMN IF NOT EXISTS post_id INTEGER;
ALTER TABLE cost_bank_lines ADD COLUMN IF NOT EXISTS party_label VARCHAR(200);
ALTER TABLE rm_supplier_payments ADD COLUMN IF NOT EXISTS source VARCHAR(8);
ALTER TABLE rm_supplier_payments ADD COLUMN IF NOT EXISTS source_id INTEGER;
ALTER TABLE rm_transporter_payments ADD COLUMN IF NOT EXISTS source VARCHAR(8);
ALTER TABLE rm_transporter_payments ADD COLUMN IF NOT EXISTS source_id INTEGER;
ALTER TABLE hr_contractor_payments ADD COLUMN IF NOT EXISTS source VARCHAR(8);
ALTER TABLE hr_contractor_payments ADD COLUMN IF NOT EXISTS source_id INTEGER;
ALTER TABLE mnt_payments ADD COLUMN IF NOT EXISTS source VARCHAR(8);
ALTER TABLE mnt_payments ADD COLUMN IF NOT EXISTS source_id INTEGER;
ALTER TABLE mnt_certificates ADD COLUMN IF NOT EXISTS source VARCHAR(8);
ALTER TABLE mnt_certificates ADD COLUMN IF NOT EXISTS source_id INTEGER;
ALTER TABLE mnt_certificates ADD COLUMN IF NOT EXISTS paid_on DATE;
ALTER TABLE cl_expenses ADD COLUMN IF NOT EXISTS party_id INTEGER;
ALTER TABLE cl_expenses ADD COLUMN IF NOT EXISTS post_kind VARCHAR(12);
ALTER TABLE cl_expenses ADD COLUMN IF NOT EXISTS post_id INTEGER;
CREATE TABLE IF NOT EXISTS ledger_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  manual_payments  BOOLEAN NOT NULL DEFAULT false,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TIMESTAMPTZ
);
INSERT INTO ledger_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

// Made on first use too, so nothing breaks on a database where /setup has
// not run yet.
let ready = null;
export function ensureRound235() {
  if (!ready) ready = query(ROUND235_SQL).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function migrateRound235(pool, log) {
  await pool.query(ROUND235_SQL);
  log?.push?.("Round 235: bank statement and C Ledger payments post into the ledgers; road tax / insurance into the compliance register.");
}

// ------------------------------------------------------ the switch ---
export async function ledgerSettings() {
  await ensureRound235();
  const { rows } = await query(`SELECT manual_payments FROM ledger_settings WHERE id = 1`);
  return { manual_payments: !!rows[0]?.manual_payments };
}
// Guard for the ledgers' own "Record payment".
export async function requireManualPayments(_req, res, next) {
  try {
    const s = await ledgerSettings();
    if (s.manual_payments) return next();
    res.status(403).json({ error: "Payments are entered from the bank statement (Cost → Bank statements) or, for cash, in C Ledger. An Administrator can allow an entry by hand there." });
  } catch (e) { next(e); }
}
// A payment that came from a bank line or C Ledger is changed there only.
export async function refuseIfSourced(table, id) {
  await ensureRound235();
  const { rows } = await query(`SELECT source FROM ${table} WHERE id = $1`, [id]);
  if (rows[0]?.source) {
    return rows[0].source === "bank"
      ? "This payment came from a bank statement line — change or undo it there (Cost → Bank statements)."
      : "This payment came from C Ledger — change or delete the cash expense there.";
  }
  return null;
}

export const POST_KINDS = ["supplier", "transporter", "contractor", "maintenance", "customer"];
const KIND_LABEL = { customer: "Customer ledger (Accounts)", supplier: "Supplier ledger", transporter: "Transporter ledger", contractor: "Contractor ledger (HR)", maintenance: "Maintenance → Payments", certificate: "Compliance register" };
export const postWhere = (k) => KIND_LABEL[k] || k;

// How the bank paid it, from the narration.
export function bankMode(narr) {
  const n = String(narr || "").toUpperCase();
  if (/\bRTGS\b/.test(n)) return "rtgs";
  if (/\bUPI\b/.test(n)) return "upi";
  if (/\b(CHQ|CHEQUE|CLG|CLEARING)\b/.test(n)) return "cheque";
  if (/\b(NEFT|IMPS|INFT|NFT|TRF|TRANSFER|MMT)\b/.test(n)) return "neft";
  return "other";
}
// The UTR / reference in the narration (the longest run of letters + digits).
export function bankRef(narr, fallback) {
  const parts = String(narr || "").toUpperCase().split(/[^A-Z0-9]+/).filter((p) => p.length >= 8 && /\d{6,}/.test(p));
  parts.sort((a, b) => b.length - a.length);
  return (parts[0] || fallback || "").slice(0, 60) || null;
}

// --------------------------------------------------- pick lists ---
export async function partyOptions() {
  await ensureRound235();
  const safe = (p) => p.then((r) => r.rows).catch(() => []);
  const [suppliers, transporters, contractors, bills, assets, customers] = await Promise.all([
    safe(query(`SELECT id, name, is_active FROM rm_suppliers ORDER BY is_active DESC, name`)),
    safe(query(`SELECT id, name, is_active FROM rm_transporters ORDER BY is_active DESC, name`)),
    safe(query(`SELECT id, name, is_active FROM hr_contractors ORDER BY is_active DESC, name`)),
    safe(query(`
      SELECT b.id, b.payee, b.bill_no, b.bill_date::text AS bill_date, b.amount, b.source_type,
             b.amount - COALESCE((SELECT SUM(p.amount + p.tds) FROM mnt_payments p WHERE p.bill_id = b.id), 0) AS balance,
             CASE b.source_type WHEN 'grv' THEN (SELECT 'GRV-' || LPAD(g.id::text, 4, '0') || ' / PO-' || LPAD(g.po_id::text, 4, '0') FROM mnt_grvs g WHERE g.id = b.source_id)
               WHEN 'certificate' THEN (SELECT COALESCE(c.label, initcap(replace(c.cert_type, '_', ' '))) || ' · ' || a.name FROM mnt_certificates c JOIN mnt_assets a ON a.id = c.asset_id WHERE c.id = b.source_id)
               ELSE (SELECT 'ER-' || LPAD(o.id::text, 4, '0') || ' · ' || a.name FROM mnt_outside_repairs o JOIN mnt_assets a ON a.id = o.asset_id WHERE o.id = b.source_id) END AS against
        FROM mnt_bills b WHERE NOT b.is_estimate AND NOT b.on_hold
         AND b.amount - COALESCE((SELECT SUM(p.amount + p.tds) FROM mnt_payments p WHERE p.bill_id = b.id), 0) > 0.004
       ORDER BY b.bill_date NULLS LAST, b.id`)),
    safe(query(`SELECT id, name, asset_group, reg_no FROM mnt_assets WHERE is_active ORDER BY asset_group, name`)),
    // Round 252 — money in from a customer posts to the customer ledger.
    safe(query(`SELECT id, name, COALESCE(is_active, true) AS is_active FROM customers ORDER BY COALESCE(is_active, true) DESC, name`)),
  ]);
  const { rows: certs } = await query(
    `SELECT c.asset_id, c.cert_type, c.valid_to::text AS valid_to FROM mnt_certificates c WHERE c.status = 'current'`).catch(() => ({ rows: [] }));
  return {
    suppliers, transporters, contractors, customers,
    mnt_bills: bills.map((b) => ({ ...b, amount: n0(b.amount), balance: r2(b.balance) })),
    assets, current_certs: certs,
    cert_types: Object.entries(CERT_TYPES).filter(([k]) => k !== "other").map(([key, label]) => ({ key, label })),
  };
}

// A party's bills still open — what a payment can be put against.
// `without`: the payment a bank line already posted — its bills show as open again.
export async function partyBills(kind, id, without = null) {
  if (kind === "supplier") {
    const [l] = await buildLedgers({ supplierIds: [Number(id)], asOn: istDay(), withoutPayments: without ? [without] : null });
    if (!l) return [];
    return l.open_bills.map((b) => ({ kind: b.kind, id: b.id, no: b.no, date: b.date, outstanding: r2(b.outstanding) }));
  }
  if (kind === "contractor") {
    const { rows } = await query(
      `SELECT b.id, b.month, b.net_payable,
              b.net_payable - COALESCE((SELECT SUM(p.amount) FROM hr_contractor_payments p WHERE p.bill_id = b.id AND p.id <> COALESCE($2::int, 0)), 0) AS outstanding
         FROM hr_contractor_bills b WHERE b.contractor_id = $1 AND b.status = 'approved' ORDER BY b.month DESC LIMIT 12`, [id, without]);
    return rows.map((b) => ({ kind: "bill", id: b.id, no: `Bill ${b.month}`, date: `${b.month}-01`, outstanding: r2(b.outstanding) }));
  }
  return [];
}

// -------------------------------------------------------- posting ---
// p: { kind, party_id, bill_id, allocations, amount, tds, paid_on, mode,
//      reference, notes, bank_account, user_id, source, source_id, replacing }
// `replacing` = the payment of the same kind this one takes the place of
// (already undone in this transaction) — its bills count as still open.
export async function postPayment(c, p) {
  const amount = r2(p.amount), tds = r2(p.tds || 0);
  if (!(amount > 0)) throw fail("The amount must be more than 0.");
  if (tds < 0) throw fail("TDS must be 0 or more.");
  if (!ISO.test(p.paid_on || "")) throw fail("Payment date missing.");
  const partyId = Number(p.party_id);
  const src = [p.source || null, p.source_id || null];

  if (p.kind === "supplier") {
    const { rows: s } = await c.query(`SELECT id, name FROM rm_suppliers WHERE id = $1`, [partyId]);
    if (!s.length) throw fail("Choose the supplier.");
    const allocations = [];
    const want = (Array.isArray(p.allocations) ? p.allocations : []).filter((a) => n0(a.amount) > 0);
    if (want.length) {
      const [l] = await buildLedgers({ supplierIds: [partyId], asOn: istDay(), withoutPayments: p.replacing ? [p.replacing] : null });
      let tot = 0;
      for (const a of want) {
        const key = `${a.kind}:${Number(a.id)}`;
        const bill = (l?.open_bills || []).find((x) => `${x.kind}:${Number(x.id)}` === key);
        if (!bill) throw fail("One of the bills is not open for this supplier any more — reload and try again.");
        const open = r2(bill.outstanding);
        const amt = r2(a.amount);
        if (amt > open + 0.005) throw fail(`${bill.no} only has ₹${open.toLocaleString("en-IN")} left to settle.`);
        tot += amt;
        allocations.push({ kind: a.kind, id: Number(a.id), amount: amt });
      }
      if (tot > amount + tds + 0.005) throw fail("The bills settled add up to more than the payment.");
    }
    const { rows } = await c.query(
      `INSERT INTO rm_supplier_payments (supplier_id, paid_on, amount, tds_amount, mode, reference, bank_account, notes, created_by, source, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [partyId, p.paid_on, amount, tds, p.mode, p.reference || null, p.bank_account || null, p.notes || null, p.user_id, ...src]);
    for (const a of allocations) {
      await c.query(`INSERT INTO rm_payment_allocations (payment_id, receipt_id, opening_bill_id, amount) VALUES ($1,$2,$3,$4)`,
        [rows[0].id, a.kind === "receipt" ? a.id : null, a.kind === "opening" ? a.id : null, a.amount]);
    }
    await c.query(`INSERT INTO rm_supplier_ledger_log (supplier_id, action, detail, changed_by) VALUES ($1,'payment',$2,$3)`,
      [partyId, JSON.stringify({ payment_id: rows[0].id, amount, tds, mode: p.mode, paid_on: p.paid_on, allocations, source: p.source, source_id: p.source_id }), p.user_id]);
    return { kind: "supplier", id: rows[0].id, label: s[0].name };
  }

  if (p.kind === "transporter") {
    const { rows: t } = await c.query(`SELECT id, name FROM rm_transporters WHERE id = $1`, [partyId]);
    if (!t.length) throw fail("Choose the transporter.");
    const { rows } = await c.query(
      `INSERT INTO rm_transporter_payments (transporter_id, paid_on, amount, tds_amount, mode, reference, notes, created_by, source, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [partyId, p.paid_on, amount, tds, p.mode, p.reference || null, p.notes || null, p.user_id, ...src]);
    return { kind: "transporter", id: rows[0].id, label: t[0].name };
  }

  if (p.kind === "contractor") {
    const { rows: k } = await c.query(`SELECT id, name FROM hr_contractors WHERE id = $1`, [partyId]);
    if (!k.length) throw fail("Choose the contractor / pump gang.");
    const billId = Number(p.bill_id) || null;
    let month = null;
    if (billId) {
      const { rows } = await c.query(`SELECT month FROM hr_contractor_bills WHERE id = $1 AND contractor_id = $2 AND status = 'approved'`, [billId, partyId]);
      if (!rows.length) throw fail("That bill isn't an approved bill of this contractor.");
      month = rows[0].month;
    }
    const mode = p.mode === "cash" ? "cash" : p.mode === "upi" ? "upi" : p.mode === "cheque" ? "cheque" : "bank_transfer";
    const { rows } = await c.query(
      `INSERT INTO hr_contractor_payments (contractor_id, bill_id, paid_on, amount, mode, ref, note, created_by, source, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [partyId, billId, p.paid_on, amount, mode, (p.reference || "").slice(0, 60) || null, (p.notes || "").slice(0, 200) || null, p.user_id, ...src]);
    return { kind: "contractor", id: rows[0].id, label: `${k[0].name}${month ? ` · ${month} bill` : " · on account"}` };
  }

  if (p.kind === "maintenance") {
    const billId = Number(p.bill_id);
    const { rows } = await c.query(
      `SELECT b.*, (SELECT COALESCE(SUM(amount + tds), 0) FROM mnt_payments WHERE bill_id = b.id) AS paid FROM mnt_bills b WHERE b.id = $1 FOR UPDATE`, [billId]);
    const b = rows[0];
    if (!b) throw fail("Choose the maintenance bill this pays.");
    if (b.on_hold) throw fail("That bill is on hold — the Administrator has to approve it first.");
    const balance = r2(n0(b.amount) - n0(b.paid));
    if (amount + tds > balance + 0.005) throw fail(`That is more than the bill's balance (₹${balance.toLocaleString("en-IN")}).`);
    const { rows: ins } = await c.query(
      `INSERT INTO mnt_payments (bill_id, amount, tds, paid_on, mode, reference, created_by, source, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [billId, amount, tds, p.paid_on, p.mode, (p.reference || "").slice(0, 100) || null, p.user_id, ...src]);
    return { kind: "maintenance", id: ins[0].id, label: `${b.payee || "Bill"}${b.bill_no ? ` · ${b.bill_no}` : ""}` };
  }
  // Round 252 — a customer's payment into our bank, from the bank statement
  // (owner, 30 Oct 2026: "Activate Sales income to post to ledger from Bank
  // statement same as supplier payment"). A receipt, set against the
  // customer's oldest dues like any receipt.
  if (p.kind === "customer") {
    const { rows: cu } = await c.query(`SELECT id, name FROM customers WHERE id = $1`, [partyId]);
    if (!cu.length) throw fail("Choose the customer.");
    const mode = p.mode === "upi" ? "upi" : p.mode === "cheque" ? "cheque" : "bank_transfer";
    const out = await postReceipt(c, {
      customer_id: partyId, receipt_date: p.paid_on, amount, mode, reference_number: p.reference || null,
      bank_account: (p.bank_account || "").slice(0, 60) || null, narration: p.narration || null, remarks: p.notes || null, userId: p.user_id,
    });
    return { kind: "customer", id: out.id, label: cu[0].name };
  }
  throw fail("Choose who this payment is to.");
}

// Undo a posted payment (the source line was changed, reset or removed).
export async function unpostPayment(c, kind, id, userId, reason = "Changed at its source") {
  if (!id) return;
  if (kind === "supplier") {
    const { rows } = await c.query(
      `UPDATE rm_supplier_payments SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1 AND cancelled_at IS NULL RETURNING supplier_id, amount`,
      [id, userId, reason]);
    if (rows.length) {
      await c.query(`INSERT INTO rm_supplier_ledger_log (supplier_id, action, detail, changed_by) VALUES ($1,'payment_cancelled',$2,$3)`,
        [rows[0].supplier_id, JSON.stringify({ payment_id: id, amount: rows[0].amount, reason }), userId]);
    }
  } else if (kind === "transporter") {
    await c.query(`UPDATE rm_transporter_payments SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1 AND cancelled_at IS NULL`, [id, userId, reason]);
  } else if (kind === "contractor") {
    await c.query(`UPDATE hr_gang_advances SET status = 'approved', payment_id = NULL, paid_to = NULL WHERE payment_id = $1`, [id]).catch(() => {});
    await c.query(`DELETE FROM hr_contractor_payments WHERE id = $1`, [id]);
  } else if (kind === "maintenance") {
    await c.query(`DELETE FROM mnt_payments WHERE id = $1`, [id]);
  } else if (kind === "certificate") {
    await unpostCertificate(c, id);
  } else if (kind === "customer") {
    // The receipt is cancelled (kept), its settlement of dues undone, and the
    // customer's other advances set against what this freed.
    const { rows } = await c.query(
      `UPDATE customer_receipts SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1 AND cancelled_at IS NULL RETURNING customer_id`,
      [id, userId, reason]);
    await c.query(`DELETE FROM payments WHERE receipt_id = $1`, [id]);
    if (rows[0]) await applyAdvances(c, rows[0].customer_id);
  }
}

// ------------------------------------------------- certificates ---
// A road tax / insurance / permit … paid from the bank: renews the vehicle's
// certificate in the compliance register, with its fee bill paid. A payment
// for an older period (a year's statement uploaded late) goes in as history
// and leaves the current certificate as it is.
export async function postCertificate(c, p) {
  const assetId = Number(p.asset_id);
  const { rows: a } = await c.query(`SELECT id, name FROM mnt_assets WHERE id = $1`, [assetId]);
  if (!a.length) throw fail("Choose the vehicle or machine.");
  if (!CERT_TYPES[p.cert_type] || p.cert_type === "other") throw fail("Choose the certificate (road tax, insurance …).");
  if (!ISO.test(p.valid_to || "")) throw fail("Enter the valid-to date of the new certificate.");
  if (p.valid_from && !ISO.test(p.valid_from)) throw fail("Valid from: a date.");
  if (p.valid_from && p.valid_from > p.valid_to) throw fail("Valid from is after valid to.");
  const fee = r2(p.fee);
  if (!(fee > 0)) throw fail("The fee must be more than 0.");
  const { rows: cur } = await c.query(
    `SELECT id, valid_to::text AS valid_to FROM mnt_certificates WHERE asset_id = $1 AND cert_type = $2 AND label IS NULL AND status = 'current' FOR UPDATE`,
    [assetId, p.cert_type]);
  const newer = !cur.length || p.valid_to > cur[0].valid_to;
  if (cur.length && newer) await c.query(`UPDATE mnt_certificates SET status = 'superseded' WHERE id = $1`, [cur[0].id]);
  const { rows } = await c.query(
    `INSERT INTO mnt_certificates (asset_id, cert_type, label, number, valid_from, valid_to, authority, fee, renewed_from_id, status, note,
       created_by, source, source_id, paid_on)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [assetId, p.cert_type, p.number || null, p.valid_from || null, p.valid_to, p.authority || null, fee,
      newer ? cur[0]?.id || null : null, newer ? "current" : "superseded", p.notes || null, p.user_id, p.source || null, p.source_id || null, p.paid_on]);
  const id = rows[0].id;
  const bill = await c.query(
    `INSERT INTO mnt_bills (source_type, source_id, payee, bill_no, bill_date, amount, due_date, note)
     VALUES ('certificate', $1, $2, $3, $4::date, $5, $4::date, $6) RETURNING id`,
    [id, p.authority || "Renewal fee", p.number || null, p.paid_on, fee, `${CERT_TYPES[p.cert_type]} fee`]);
  const { rows: pay } = await c.query(
    `INSERT INTO mnt_payments (bill_id, amount, tds, paid_on, mode, reference, created_by, source, source_id) VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [bill.rows[0].id, fee, p.paid_on, p.mode || null, (p.reference || "").slice(0, 100) || null, p.user_id, p.source || null, p.source_id || null]);
  return { kind: "certificate", id, payment_id: pay[0].id, label: `${a[0].name} · ${CERT_TYPES[p.cert_type]} to ${p.valid_to}${newer ? "" : " (older period — kept as history)"}` };
}

async function unpostCertificate(c, id) {
  const { rows } = await c.query(`SELECT id, status, renewed_from_id FROM mnt_certificates WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows.length || rows[0].status === "retired") return;
  await c.query(`DELETE FROM mnt_payments WHERE bill_id IN (SELECT id FROM mnt_bills WHERE source_type = 'certificate' AND source_id = $1)`, [id]);
  await c.query(`DELETE FROM mnt_bills WHERE source_type = 'certificate' AND source_id = $1`, [id]);
  await c.query(`UPDATE mnt_certificates SET status = 'retired' WHERE id = $1`, [id]);
  if (rows[0].status === "current" && rows[0].renewed_from_id) {
    await c.query(`UPDATE mnt_certificates SET status = 'current' WHERE id = $1 AND status = 'superseded'`, [rows[0].renewed_from_id]);
  }
}
