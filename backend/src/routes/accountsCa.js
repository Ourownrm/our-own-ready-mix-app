// Round 255 — Accounts → Send to CA (owner, 31 Oct 2026; mock-up "CA Tax
// Desk Mockup", agreed in its third version).
//
// The firm's CA keeps the books in their own system and files GST, income
// tax, TDS and the partners' work. What they need from the app is the month's
// transactions with their account heads — in Excel (owner), by the 5th for the
// month before (owner). Every invoice and every C Ledger entry is in it.
//
// Nine sheets: sales invoices (+ credit notes) · money received · purchase
// bills · money paid · bank statements · cash (C Ledger + petty cash) ·
// salaries · partners · GSTR-2B differences (the month before's 2B: it comes
// on the 14th, after the 5th).
//
// "Mark as sent" keeps a fingerprint of every row; a month changed after it
// was sent shows what changed, and those rows can be sent on their own.
// Each app head can carry the CA's own ledger name (set once).
import { Router } from "express";
import crypto from "node:crypto";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { istDay, istMonth } from "../lib/istDate.js";
import { MONTH_RE, monthBounds, addMonths, monthLabel } from "../lib/costDashboard.js";
import { BANK_HEADS } from "../lib/bankBook.js";
import { CL_CATEGORIES } from "../lib/cLedger.js";
import { inputItems, gstMonth } from "../lib/gstBook.js";
import { partnerInterestMonth } from "../lib/partners.js";
import { ensureRound255, clCrossCheck } from "../lib/round255Schema.js";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => { try { await ensureRound255(); next(); } catch (e) { next(e); } });

const VIEW = requirePermission("accounts.send-to-ca", "view");
const EDIT = requirePermission("accounts.send-to-ca", "edit");
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n0 = (v) => Number(v) || 0;
const GST_F = 100 / 118;
const safe = (p) => p.then((r) => r.rows).catch((e) => { console.error("send to CA:", e.message); return []; });

// ------------------------------------------------------------ heads ---
// Every head a row can carry. The CA gives each its own ledger name once.
export const CA_HEADS = [
  { key: "sales", label: "Sales — ready-mix concrete" },
  { key: "sales_cn", label: "Credit notes on sales" },
  { key: "customer_receipt", label: "Customer receipts" },
  { key: "other_income", label: "Other income (scrap, used oil …)" },
  { key: "rm", label: "Raw material" },
  { key: "freight", label: "Freight on raw material" },
  { key: "fuel", label: "Fuel" },
  { key: "repairs", label: "Repairs & maintenance" },
  { key: "contract_labour", label: "Contract labour & pump gangs" },
  { key: "hired_vehicles", label: "Hired vehicles & pumps" },
  { key: "power", label: "Plant power" },
  { key: "salaries", label: "Salaries & wages" },
  { key: "salary_advance", label: "Salary advances" },
  { key: "admin_office", label: "Admin & office" },
  { key: "selling", label: "Selling & marketing" },
  { key: "rent_rates", label: "Rent & rates" },
  { key: "interest", label: "Finance cost (interest, bank charges)" },
  { key: "supplier_payment", label: "Payment to raw-material supplier" },
  { key: "transporter_payment", label: "Payment to transporter" },
  { key: "contractor_payment", label: "Payment to labour contractor" },
  { key: "maintenance_payment", label: "Payment of maintenance bill / certificate" },
  { key: "loan_emi", label: "Loan instalment" },
  { key: "tax", label: "Taxes paid (GST, TDS, advance tax)" },
  { key: "asset", label: "Fixed asset" },
  { key: "capital", label: "Partners' capital" },
  { key: "partner_loan", label: "Unsecured loans from partners" },
  { key: "partner_interest", label: "Interest to partners" },
  { key: "personal", label: "Owner / personal" },
  { key: "own_transfer", label: "Transfer between own accounts" },
  { key: "cash_deposit", label: "Cash deposited to bank" },
  { key: "petty_topup", label: "Petty cash top-up" },
  { key: "staff_advance", label: "Staff advance (not a cost)" },
  { key: "todo", label: "Not yet given a head" },
];
const HEAD_LABEL = Object.fromEntries(CA_HEADS.map((h) => [h.key, h.label]));
const HEAD_KEYS = new Set(CA_HEADS.map((h) => h.key));
const clHead = (cat) => ({ supplier_payment: "supplier_payment", transporter_payment: "transporter_payment", contractor_payment: "contractor_payment",
  staff_advance: "staff_advance", personal: "personal", todo: "todo" }[cat] || cat);
const TREATMENT = { todo: "To categorise", check: "To check", cost: "Cost head", omit: "Already in the app", own: "Own transfer", loan: "Loan instalment",
  tax: "Tax", asset: "Fixed asset", capital: "Capital", personal: "Owner / personal", pay: "Paid to a party", cert: "Vehicle certificate" };
const bankHeadLabel = (k) => BANK_HEADS.find((h) => h.key === k)?.label || null;

async function headNames() {
  const { rows } = await query(`SELECT head_key, ledger_name FROM ca_head_names`).catch(() => ({ rows: [] }));
  return Object.fromEntries(rows.map((r) => [r.head_key, r.ledger_name]));
}

// --------------------------------------------------------- the sheets ---
// A sheet: { key, name, note, columns, rows: [{ k, head, c: [cells] }] }.
// A row's head (when it has one) is printed as two columns: the app's head
// and the CA's ledger name.
function sheet(key, name, note, columns, rows, { headed = true } = {}) {
  return { key, name, note, columns: headed ? [...columns, "Head", "CA ledger"] : columns, headed, rows };
}

async function salesSheet(from, end) {
  const [inv, cn] = await Promise.all([
    safe(query(
      `SELECT i.id, dt.ticket_date::text AS day, dt.ticket_number, i.tally_invoice_no, COALESCE(i.billing_name, c.name) AS customer,
              i.billing_gstin, s.name AS site, g.name AS grade, dt.loaded_quantity_m3 AS loaded, COALESCE(i.rejected_quantity_m3, 0) AS rejected,
              i.rate_per_m3, i.concrete_amount, i.pumping_charge, i.part_load_charge, i.waiting_charge, i.total_amount, i.gst_applied, i.cl_cash
         FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customer_orders co ON co.id = dt.order_id
         JOIN customers c ON c.id = i.customer_id LEFT JOIN sites s ON s.id = co.site_id LEFT JOIN mix_grades g ON g.id = co.mix_grade_id
        WHERE dt.ticket_date BETWEEN $1::date AND $2::date ORDER BY dt.ticket_date, dt.ticket_number`, [from, end])),
    safe(query(
      `SELECT cn.id, cn.cn_no, cn.cn_date::text AS day, cn.reason, cn.qty_m3, cn.total_amount, cn.base_amount, cn.cgst, cn.sgst, cn.gst_applied,
              c.name AS customer, i.billing_gstin, dt.ticket_number
         FROM credit_notes cn JOIN customers c ON c.id = cn.customer_id JOIN invoices i ON i.id = cn.invoice_id
         JOIN delivery_tickets dt ON dt.id = i.ticket_id
        WHERE cn.status = 'approved' AND cn.cn_date BETWEEN $1::date AND $2::date ORDER BY cn.cn_date, cn.id`, [from, end])),
  ]);
  const rows = inv.map((r) => {
    const total = r2(r.total_amount), base = r.gst_applied ? r2(total * GST_F) : total, gst = r2(total - base), cg = r2(gst / 2);
    return { k: `inv:${r.id}`, head: "sales", c: [r.day, "Invoice", r.ticket_number, r.tally_invoice_no || "", r.customer, r.billing_gstin || "", r.site || "",
      r.grade || "", r2(n0(r.loaded) - n0(r.rejected)), r2(r.rate_per_m3), r2(r.concrete_amount), r2(r.pumping_charge), r2(r.part_load_charge),
      r2(r.waiting_charge), base, cg, r2(gst - cg), total, r.gst_applied ? "Yes" : "No", r.cl_cash ? "Cash" : ""] };
  });
  const REASON = { return: "Concrete returned / rejected", rate: "Rate correction", discount: "Discount", other: "Other" };
  for (const r of cn) {
    rows.push({ k: `cn:${r.id}`, head: "sales_cn", c: [r.day, `Credit note — ${REASON[r.reason] || r.reason}`, r.ticket_number, r.cn_no, r.customer, r.billing_gstin || "", "",
      "", r.qty_m3 == null ? "" : -r2(r.qty_m3), "", "", "", "", "", -r2(r.base_amount), -r2(r.cgst), -r2(r.sgst), -r2(r.total_amount), r.gst_applied ? "Yes" : "No", ""] });
  }
  return sheet("sales", "1 Sales invoices", "Every invoice dated in the month (by delivery note), then approved credit notes (minus). Rates include GST.",
    ["Date", "Document", "Delivery note", "Tally / CN no.", "Customer", "GSTIN", "Site", "Grade", "m³", "Rate incl. GST", "Concrete ₹",
      "Pump ₹", "Part load ₹", "Waiting ₹", "Taxable ₹", "CGST ₹", "SGST ₹", "Total ₹", "GST shown", "Collected via"], rows);
}

async function receivedSheet(from, end) {
  const [rec, old, inc] = await Promise.all([
    safe(query(
      `SELECT r.id, r.receipt_date::text AS day, c.name AS customer, r.mode::text AS mode, r.reference_number, r.bank_account, r.amount,
              (SELECT string_agg(lbl, ', ' ORDER BY first_id) FROM (
                 SELECT COALESCE(dt.ticket_number, 'Opening balance') AS lbl, MIN(p.id) AS first_id
                   FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN delivery_tickets dt ON dt.id = i.ticket_id
                  WHERE p.receipt_id = r.id GROUP BY 1) q) AS against,
              r.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.receipt_id = r.id), 0) AS advance,
              (SELECT string_agg(DISTINCT COALESCE(a.short_name, u.name, 'Paid to bank'), ', ') FROM cl_collections x
                 LEFT JOIN users u ON u.id = x.holder_id LEFT JOIN cl_access a ON a.user_id = x.holder_id WHERE x.receipt_id = r.id) AS cl,
              (r.bank_line_id IS NOT NULL) AS from_bank
         FROM customer_receipts r JOIN customers c ON c.id = r.customer_id
        WHERE r.cancelled_at IS NULL AND r.receipt_date BETWEEN $1::date AND $2::date ORDER BY r.receipt_date, r.id`, [from, end])),
    safe(query(
      `SELECT p.id, p.payment_date::text AS day, COALESCE(c1.name, c2.name) AS customer, p.mode::text AS mode, p.reference_number, p.amount,
              CASE WHEN p.opening_balance_id IS NOT NULL THEN 'Opening balance' ELSE dt.ticket_number END AS against
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN customers c1 ON c1.id = i.customer_id
         LEFT JOIN delivery_tickets dt ON dt.id = i.ticket_id LEFT JOIN customer_opening_balances b ON b.id = p.opening_balance_id
         LEFT JOIN customers c2 ON c2.id = b.customer_id
        WHERE p.receipt_id IS NULL AND p.payment_date BETWEEN $1::date AND $2::date ORDER BY p.payment_date, p.id`, [from, end])),
    safe(query(
      `SELECT i.id, i.txn_date::text AS day, i.kind, i.source, i.amount, COALESCE(a.short_name, u.name) AS who
         FROM cl_incomes i LEFT JOIN users u ON u.id = i.received_by LEFT JOIN cl_access a ON a.user_id = i.received_by
        WHERE i.deleted_at IS NULL AND i.status <> 'rejected' AND i.txn_date BETWEEN $1::date AND $2::date ORDER BY i.txn_date, i.id`, [from, end])),
  ]);
  const MODE = { cash: "Cash", bank_transfer: "Bank transfer", upi: "UPI", cheque: "Cheque" };
  const rows = rec.map((r) => ({ k: `rec:${r.id}`, head: "customer_receipt", c: [r.day, r.customer, MODE[r.mode] || r.mode, r.reference_number || "",
    r.bank_account || "", r2(r.amount), r.against || "", n0(r.advance) > 0.009 ? r2(r.advance) : "", r.cl ? `C Ledger · ${r.cl}` : r.from_bank ? "Bank statement" : "Entered in Accounts"] }));
  for (const p of old) rows.push({ k: `pay:${p.id}`, head: "customer_receipt", c: [p.day, p.customer || "", MODE[p.mode] || p.mode, p.reference_number || "", "", r2(p.amount), p.against || "", "", "Entered before receipts"] });
  const KIND = { scrap: "Scrap sale", used_oil: "Used oil sale", other: "Other income" };
  for (const i of inc) rows.push({ k: `cli:${i.id}`, head: "other_income", c: [i.day, `${KIND[i.kind] || i.kind} — ${i.source}`, i.who ? "Cash" : "Bank", "", "", r2(i.amount), "", "", `C Ledger${i.who ? ` · ${i.who}` : ""}`] });
  rows.sort((a, b) => (a.c[0] < b.c[0] ? -1 : a.c[0] > b.c[0] ? 1 : 0));
  return sheet("received", "2 Money received", "Customer receipts (with what they paid), payments entered before receipts existed, and C Ledger other income.",
    ["Date", "From", "Mode", "Reference", "Bank account", "Amount ₹", "Against", "Advance left ₹", "Recorded"], rows);
}

async function purchasesSheet(from, end) {
  const [{ items }, fuel] = await Promise.all([
    inputItems(from, end).catch((e) => { console.error("send to CA purchases:", e.message); return { items: [] }; }),
    safe(query(
      `SELECT sp.id, (sp.received_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, sp.supplier_name, sp.received_qty, sp.unit_cost, sp.total_cost,
              si.item_type
         FROM store_stock_purchases sp JOIN store_stock_items si ON si.id = sp.stock_item_id
        WHERE sp.status = 'received' AND sp.total_cost > 0 AND (sp.received_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
        ORDER BY sp.received_at`, [from, end])),
  ]);
  const HEAD = { receipt: "rm", freight: "freight", rcm: "freight", mnt_bill: "repairs", contractor_bill: "contract_labour" };
  const rows = items.filter((i) => HEAD[i.src]).map((i) => ({
    k: `${i.key}`, head: HEAD[i.src],
    c: [i.day, i.party || "", i.gstin || "", i.inv_no || "", i.group, r2(i.taxable), i.pct || 0, r2(i.gst), r2(i.taxable + i.gst),
      i.rcm ? "Reverse charge" : i.no_tax ? "Flagged — no tax" : ""],
  }));
  for (const f of fuel) rows.push({ k: `fuel:${f.id}`, head: f.item_type === "fuel" ? "fuel" : "repairs",
    c: [f.day, f.supplier_name || "", "", "", f.item_type === "fuel" ? `Diesel into the plant tank · ${n0(f.received_qty)} L × ₹${n0(f.unit_cost)}` : "Lubricant into the store",
      r2(f.total_cost), 0, 0, r2(f.total_cost), "No GST on diesel"] });
  rows.sort((a, b) => (a.c[0] < b.c[0] ? -1 : a.c[0] > b.c[0] ? 1 : 0));
  return sheet("purchases", "3 Purchase bills", "Raw material receipts, freight, maintenance GRVs and outside repairs, contractor bills, diesel and lubricants bought. Taxable + GST as the app has them.",
    ["Date", "Supplier", "GSTIN", "Bill no.", "What", "Taxable ₹", "GST %", "GST ₹", "Total ₹", "Note"], rows);
}

async function paidSheet(from, end) {
  const [sup, tr, con, mnt, sal, adv, bank] = await Promise.all([
    safe(query(`SELECT p.id, p.paid_on::text AS day, s.name, p.mode, p.reference, p.amount, p.tds_amount, p.source FROM rm_supplier_payments p
                JOIN rm_suppliers s ON s.id = p.supplier_id WHERE p.cancelled_at IS NULL AND p.paid_on BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(`SELECT p.id, p.paid_on::text AS day, t.name, p.mode, p.reference, p.amount, p.tds_amount, p.source FROM rm_transporter_payments p
                JOIN rm_transporters t ON t.id = p.transporter_id WHERE p.cancelled_at IS NULL AND p.paid_on BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(`SELECT p.id, p.paid_on::text AS day, c.name, p.mode, p.ref AS reference, p.amount, 0 AS tds_amount, p.source FROM hr_contractor_payments p
                JOIN hr_contractors c ON c.id = p.contractor_id WHERE p.paid_on BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(`SELECT p.id, p.paid_on::text AS day, CONCAT_WS(' · ', b.payee, b.bill_no) AS name, p.mode, p.reference, p.amount, p.tds AS tds_amount, p.source
                  FROM mnt_payments p JOIN mnt_bills b ON b.id = p.bill_id WHERE p.paid_on BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(`SELECT l.month, l.employee_id, e.name, e.emp_code, l.paid_on::text AS day, l.paid_mode AS mode, l.paid_ref AS reference, l.paid_amount AS amount
                  FROM hr_payroll_lines l JOIN hr_employees e ON e.id = l.employee_id WHERE l.paid_amount > 0 AND l.paid_on BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(`SELECT a.id, a.given_on::text AS day, e.name, a.mode, a.reference, a.amount FROM hr_advances a JOIN hr_employees e ON e.id = a.employee_id
                 WHERE a.given_on BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(`SELECT l.id, l.txn_date::text AS day, l.narration, l.reference, l.debit, l.treatment, l.head, l.interest, l.principal, a.bank
                  FROM cost_bank_lines l JOIN cost_bank_accounts a ON a.id = l.account_id
                 WHERE l.debit > 0 AND l.treatment IN ('cost','loan','tax','asset','capital','personal','todo','check')
                   AND l.txn_date BETWEEN $1::date AND $2::date`, [from, end])),
  ]);
  const via = (src) => (src === "bank" ? "Bank statement" : src === "cledger" ? "C Ledger (cash)" : src === "petty" ? "Petty cash" : "Entered in the app");
  const rows = [];
  const party = (list, kind, head) => {
    for (const p of list) {
      // Paid in cash from C Ledger: on the Cash sheet already (with its head).
      if (p.source === "cledger") continue;
      rows.push({ k: `${kind}:${p.id}`, head, c: [p.day, p.name || "", p.mode || "", p.reference || "", r2(p.amount), r2(p.tds_amount), "", "", via(p.source)] });
    }
  };
  party(sup, "sup", "supplier_payment");
  party(tr, "trp", "transporter_payment");
  party(con, "con", "contractor_payment");
  party(mnt, "mnt", "maintenance_payment");
  for (const s of sal) rows.push({ k: `sal:${s.month}:${s.employee_id}`, head: "salaries", c: [s.day, `${s.name} (${s.emp_code}) · salary ${s.month}`, s.mode || "", s.reference || "", r2(s.amount), "", "", "", "HR → Payroll"] });
  for (const a of adv) rows.push({ k: `adv:${a.id}`, head: "salary_advance", c: [a.day, `${a.name} · advance`, a.mode || "", a.reference || "", r2(a.amount), "", "", "", "HR → Advances"] });
  const T = { loan: "loan_emi", tax: "tax", asset: "asset", capital: "capital", personal: "personal", todo: "todo", check: "todo" };
  for (const b of bank) {
    const head = b.treatment === "cost" ? (b.head || "todo") : T[b.treatment] || "todo";
    rows.push({ k: `bank:${b.id}`, head, c: [b.day, String(b.narration || "").slice(0, 120), b.bank || "", b.reference || "", r2(b.debit), "",
      b.treatment === "loan" ? r2(b.interest) : "", b.treatment === "loan" ? r2(b.principal) : "", "Bank statement"] });
  }
  rows.sort((a, b) => (a.c[0] < b.c[0] ? -1 : a.c[0] > b.c[0] ? 1 : 0));
  return sheet("paid", "4 Money paid", "Every payment with its head and who was paid: party ledgers, salaries and advances, and bank debits given a head. Cash paid from C Ledger / petty cash is on the Cash sheet.",
    ["Date", "Paid to", "Mode / bank", "Reference", "Amount ₹", "TDS ₹", "Interest ₹", "Principal ₹", "Recorded"], rows);
}

async function bankSheet(from, end) {
  const lines = await safe(query(
    `SELECT l.id, l.txn_date::text AS day, a.bank, a.number, l.narration, l.reference, l.debit, l.credit, l.balance, l.treatment, l.head, l.party_label, l.seq
       FROM cost_bank_lines l JOIN cost_bank_accounts a ON a.id = l.account_id
      WHERE l.txn_date BETWEEN $1::date AND $2::date ORDER BY a.bank, a.number, l.txn_date, l.seq, l.id`, [from, end]));
  const T = { cost: null, loan: "loan_emi", tax: "tax", asset: "asset", capital: "capital", personal: "personal", own: "own_transfer", todo: "todo", check: "todo" };
  const rows = lines.map((l) => {
    let head = l.treatment === "cost" ? l.head : T[l.treatment] ?? null;
    if (l.treatment === "omit" || l.treatment === "pay" || l.treatment === "cert") head = null;
    return { k: `bl:${l.id}`, head, c: [`${l.bank} ${l.number}`, l.day, String(l.narration || ""), l.reference || "", n0(l.debit) ? r2(l.debit) : "", n0(l.credit) ? r2(l.credit) : "",
      l.balance == null ? "" : r2(l.balance), TREATMENT[l.treatment] || l.treatment, l.party_label || (l.treatment === "cost" ? bankHeadLabel(l.head) || "" : "")] };
  });
  return sheet("bank", "5 Bank statements", "Every line of every account as the bank shows it, with how the app treated it.",
    ["Account", "Date", "Narration", "Reference", "Debit ₹", "Credit ₹", "Balance ₹", "Treated as", "Party / detail"], rows);
}

async function cashSheet(from, end) {
  const [coll, inc, exp, dep, pv, pt] = await Promise.all([
    safe(query(
      `SELECT c.id, COALESCE(c.paid_on, d.entry_date)::text AS day, d.customer_name, c.amount, c.mode, c.status, COALESCE(a.short_name, u.name) AS who,
              (SELECT string_agg(t.ticket_number, ', ') FROM cl_delivery_tickets l JOIN delivery_tickets t ON t.id = l.ticket_id WHERE l.delivery_id = d.id) AS notes,
              c.receipt_id
         FROM cl_collections c JOIN cl_deliveries d ON d.id = c.delivery_id AND d.deleted_at IS NULL
         LEFT JOIN users u ON u.id = c.holder_id LEFT JOIN cl_access a ON a.user_id = c.holder_id
        WHERE c.status <> 'rejected' AND COALESCE(c.paid_on, d.entry_date) BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT i.id, i.txn_date::text AS day, i.kind, i.source, i.amount, COALESCE(a.short_name, u.name) AS who
         FROM cl_incomes i LEFT JOIN users u ON u.id = i.received_by LEFT JOIN cl_access a ON a.user_id = i.received_by
        WHERE i.deleted_at IS NULL AND i.status <> 'rejected' AND i.received_by IS NOT NULL AND i.txn_date BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT x.id, x.txn_date::text AS day, x.where_spent, x.category, x.amount, x.flagged, COALESCE(a.short_name, u.name) AS who,
              CASE x.post_kind WHEN 'supplier' THEN (SELECT name FROM rm_suppliers WHERE id = x.party_id)
                WHEN 'transporter' THEN (SELECT name FROM rm_transporters WHERE id = x.party_id)
                WHEN 'contractor' THEN (SELECT name FROM hr_contractors WHERE id = x.party_id) END AS party
         FROM cl_expenses x JOIN users u ON u.id = x.holder_id LEFT JOIN cl_access a ON a.user_id = x.holder_id
        WHERE x.deleted_at IS NULL AND x.txn_date BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT t.id, t.txn_date::text AS day, t.kind, t.amount, t.note, COALESCE(a.short_name, u.name) AS who
         FROM cl_transfers t JOIN users u ON u.id = t.from_id LEFT JOIN cl_access a ON a.user_id = t.from_id
        WHERE t.deleted_at IS NULL AND t.kind IN ('bank','petty') AND t.txn_date BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT v.id, v.txn_date::text AS day, v.kind, v.paid_to, v.purpose, v.category, v.amount, v.flagged, v.returned_amount, b.name AS box
         FROM pc_vouchers v JOIN pc_boxes b ON b.id = v.box_id
        WHERE v.deleted_at IS NULL AND v.status = 'approved' AND v.txn_date BETWEEN $1::date AND $2::date`, [from, end])),
    safe(query(
      `SELECT t.id, t.received_on::text AS day, t.amount, t.source, t.reference, b.name AS box
         FROM pc_topups t JOIN pc_boxes b ON b.id = t.box_id
        WHERE t.status = 'received' AND t.received_on BETWEEN $1::date AND $2::date`, [from, end])),
  ]);
  const CAT = Object.fromEntries(CL_CATEGORIES.map((c) => [c.key, c.label]));
  const rows = [];
  for (const c of coll) rows.push({ k: `clc:${c.id}`, head: "customer_receipt", c: [c.day, "C Ledger", c.mode === "bank" ? "Paid to bank" : c.who || "",
    `Collection · ${c.customer_name}${c.notes ? ` · ${c.notes}` : ""}`, r2(c.amount), "", "", c.status === "pending" ? "Waiting to be accepted" : c.receipt_id ? `Receipt #${c.receipt_id} in Accounts` : "Typed in C Ledger"] });
  for (const i of inc) rows.push({ k: `cli:${i.id}`, head: "other_income", c: [i.day, "C Ledger", i.who || "", `${i.source}`, r2(i.amount), "", "", ""] });
  for (const x of exp) rows.push({ k: `clx:${x.id}`, head: clHead(x.category), c: [x.day, "C Ledger", x.who || "", `${x.where_spent}${x.party ? ` → ${x.party}` : ""}`,
    "", r2(x.amount), x.flagged ? "No" : "Yes", CAT[x.category] || x.category] });
  for (const t of dep) rows.push({ k: `clt:${t.id}`, head: t.kind === "bank" ? "cash_deposit" : "petty_topup", c: [t.day, "C Ledger", t.who || "",
    t.kind === "bank" ? `Deposited to bank${t.note ? ` · ${t.note}` : ""}` : "Given to petty cash", "", r2(t.amount), "", ""] });
  for (const v of pv) {
    if (v.kind === "advance") { rows.push({ k: `pcv:${v.id}`, head: "staff_advance", c: [v.day, `Petty cash · ${v.box}`, "", `Advance to ${v.paid_to}${v.purpose ? ` · ${v.purpose}` : ""}`, "", r2(v.amount), "", "Advance — settled later"] }); continue; }
    if (v.kind === "settle") {
      rows.push({ k: `pcv:${v.id}`, head: clHead(v.category || "todo"), c: [v.day, `Petty cash · ${v.box}`, "", `Advance settled — ${v.paid_to}${v.purpose ? ` · ${v.purpose}` : ""}${n0(v.returned_amount) ? ` (₹${r2(v.returned_amount)} back)` : ""}`,
        "", "", v.flagged ? "No" : "Yes", CAT[v.category] || v.category || ""] });
      continue;
    }
    rows.push({ k: `pcv:${v.id}`, head: clHead(v.category || "todo"), c: [v.day, `Petty cash · ${v.box}`, "", `${v.paid_to}${v.purpose ? ` · ${v.purpose}` : ""}`, "", r2(v.amount), v.flagged ? "No" : "Yes", CAT[v.category] || v.category || ""] });
  }
  const SRC = { bank_transfer: "Bank transfer", cheque: "Self cheque", cash_withdrawal: "Cash withdrawal", cledger: "C Ledger cash" };
  for (const t of pt) rows.push({ k: `pct:${t.id}`, head: "petty_topup", c: [t.day, `Petty cash · ${t.box}`, "", `Top-up · ${SRC[t.source] || t.source || ""}${t.reference ? ` · ${t.reference}` : ""}`, r2(t.amount), "", "", ""] });
  rows.sort((a, b) => (a.c[0] < b.c[0] ? -1 : a.c[0] > b.c[0] ? 1 : 0));
  return sheet("cash", "6 Cash", "C Ledger (collections, other income, expenses, deposits) and petty cash, each expense with its category.",
    ["Date", "Book", "Cash holder", "What", "In ₹", "Out ₹", "Bill had GST", "Category"], rows);
}

async function salariesSheet(ym) {
  const lines = await safe(query(
    `SELECT l.employee_id, e.name, e.emp_code, e.employment_type, l.calc, l.net_pay, l.cost_to_company, l.paid_amount, l.paid_on::text AS paid_on, l.paid_mode, r.status
       FROM hr_payroll_lines l JOIN hr_employees e ON e.id = l.employee_id JOIN hr_payroll_runs r ON r.month = l.month
      WHERE l.month = $1 ORDER BY e.emp_code`, [ym]));
  const rows = lines.map((l) => {
    const c = l.calc || {};
    return { k: `pr:${ym}:${l.employee_id}`, head: c.contract || l.employment_type === "contract" ? "contract_labour" : "salaries",
      c: [l.emp_code, l.name, c.contract || l.employment_type === "contract" ? "Contract" : "Staff", r2(c.earned_gross ?? c.gross ?? 0), r2(c.pf), r2(c.esi), r2(c.pt),
        r2(c.advance), r2(c.other_deduction), r2(l.net_pay), r2(n0(c.pf_employer) + n0(c.esi_employer)), r2(l.cost_to_company),
        l.paid_amount == null ? "" : r2(l.paid_amount), l.paid_on || "", l.paid_mode || "", l.status === "locked" ? "Locked" : "Draft"] };
  });
  return sheet("salaries", "7 Salaries", `Payroll for ${monthLabel(ym, true)} (pump gangs are paid through contractor bills — Purchase bills).`,
    ["Code", "Employee", "Type", "Gross earned ₹", "PF ₹", "ESI ₹", "PT ₹", "Advance recovered ₹", "Other deductions ₹", "Net pay ₹", "Employer PF + ESI ₹",
      "Cost to company ₹", "Paid ₹", "Paid on", "Mode", "Payroll"], rows);
}

async function partnersSheet(ym, from, end) {
  const [txns, interest] = await Promise.all([
    safe(query(
      `SELECT t.id, t.txn_date::text AS day, p.name, t.kind, t.amount, t.tds, t.note, t.narration
         FROM cost_partner_txns t JOIN cost_partners p ON p.id = t.partner_id
        WHERE t.txn_date BETWEEN $1::date AND $2::date ORDER BY t.txn_date, t.id`, [from, end])),
    partnerInterestMonth(ym).catch(() => 0),
  ]);
  const KIND = { capital_in: ["Capital brought in", "capital"], capital_out: ["Capital returned", "capital"], loan_in: ["Loan received", "partner_loan"],
    loan_out: ["Loan repaid", "partner_loan"], interest_paid: ["Interest paid", "partner_interest"], interest_due: ["Interest owed at start", "partner_interest"] };
  const rows = txns.map((t) => ({ k: `pt:${t.id}`, head: KIND[t.kind]?.[1] || "capital",
    c: [t.day, t.name, KIND[t.kind]?.[0] || t.kind, r2(t.amount), n0(t.tds) ? r2(t.tds) : "", t.kind === "interest_paid" ? r2(n0(t.amount) + n0(t.tds)) : "", t.note || String(t.narration || "").slice(0, 80)] }));
  if (n0(interest)) rows.push({ k: `pti:${ym}`, head: "partner_interest", c: [end, "All partners", "Interest for the month (accrued, as in the P&L)", r2(interest), "", "", "Cost → Partners"] });
  return sheet("partners", "8 Partners", "Capital, unsecured loans, interest paid and TDS deducted in the month, and the month's interest as it accrues.",
    ["Date", "Partner", "Entry", "Amount ₹", "TDS ₹", "Interest before TDS ₹", "Note"], rows);
}

async function twoBSheet(ym2b) {
  const has = await safe(query(`SELECT 1 FROM gst_2b_uploads WHERE period = $1`, [ym2b]));
  const cols = ["Difference", "Supplier", "GSTIN", "Bill no.", "Bill date", "Our tax ₹", "2B tax ₹", "Difference ₹"];
  if (!has.length) return { ...sheet("twob", "9 GSTR-2B differences", `GSTR-2B for ${monthLabel(ym2b, true)} is not uploaded yet (Cost → GST payable).`, cols, [], { headed: false }), missing: true, period: ym2b };
  const g = await gstMonth(ym2b).catch((e) => { console.error("send to CA 2B:", e.message); return null; });
  const rows = [];
  if (g) {
    for (const i of g.held) rows.push({ k: `held:${i.key}`, c: ["In our books, not in 2B", i.party || "", i.gstin || "", i.inv_no || "", i.day, r2(i.gst), 0, r2(i.gst)] });
    for (const l of g.not_in_app) {
      if (l.ignored) continue;
      rows.push({ k: `n2b:${l.id}`, c: ["In 2B, not in our books", l.name || "", l.gstin || "", l.inv_no || "", l.inv_date || "", 0, r2(l.tax), -r2(l.tax)] });
    }
    for (const i of g.purchases.filter((x) => n0(x.short) > 0)) {
      rows.push({ k: `short:${i.key}`, c: ["Tax differs", i.party || "", i.gstin || "", i.inv_no || "", i.day, r2(i.gst), r2(i.match?.tax), r2(i.short)] });
    }
  }
  return { ...sheet("twob", "9 GSTR-2B differences", `${monthLabel(ym2b, true)}'s GSTR-2B against our purchase bills. Flagged (no tax) bills are left out.`, cols, rows, { headed: false }), period: ym2b };
}

// ---------------------------------------------------------- the pack ---
const fp = (cells) => crypto.createHash("sha1").update(JSON.stringify(cells)).digest("base64").slice(0, 12);

async function buildPack(ym) {
  const { from, end } = monthBounds(ym);
  const sheets = await Promise.all([
    salesSheet(from, end), receivedSheet(from, end), purchasesSheet(from, end), paidSheet(from, end),
    bankSheet(from, end), cashSheet(from, end), salariesSheet(ym), partnersSheet(ym, from, end), twoBSheet(addMonths(ym, -1)),
  ]);
  const names = await headNames();
  for (const s of sheets) {
    for (const r of s.rows) {
      if (s.headed) r.c = [...r.c, r.head ? HEAD_LABEL[r.head] || bankHeadLabel(r.head) || r.head : "", r.head ? names[r.head] || "" : ""];
      r.f = fp(r.c);
    }
  }
  return sheets;
}

async function checklist(ym, sheets) {
  const { from, end } = monthBounds(ym);
  const one = (sql, p) => query(sql, p).then((r) => r.rows[0] || {}).catch(() => ({}));
  const [accounts, todo, held, clTodo, pcPending, payroll, cross] = await Promise.all([
    safe(query(`SELECT a.bank, a.number, (SELECT MAX(period_to)::text FROM cost_bank_uploads u WHERE u.account_id = a.id) AS covered_to
                  FROM cost_bank_accounts a WHERE a.is_active ORDER BY a.bank`)),
    one(`SELECT COUNT(*)::int AS n FROM cost_bank_lines WHERE treatment IN ('todo','check') AND txn_date BETWEEN $1::date AND $2::date`, [from, end]),
    one(`SELECT COUNT(*)::int AS n FROM delivery_tickets dt WHERE dt.ticket_date BETWEEN $1::date AND $2::date AND dt.status NOT IN ('cancelled','rejected')
          AND dt.loaded_quantity_m3 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ticket_id = dt.id)`, [from, end]),
    one(`SELECT COUNT(*)::int AS n FROM cl_expenses WHERE deleted_at IS NULL AND category = 'todo' AND txn_date BETWEEN $1::date AND $2::date`, [from, end]),
    one(`SELECT COUNT(*)::int AS n FROM pc_vouchers WHERE deleted_at IS NULL AND status = 'pending' AND txn_date BETWEEN $1::date AND $2::date`, [from, end]),
    one(`SELECT status FROM hr_payroll_runs WHERE month = $1`, [ym]),
    clCrossCheck(from, end).catch(() => null),
  ]);
  const short = accounts.filter((a) => !a.covered_to || a.covered_to < end);
  const twob = sheets.find((s) => s.key === "twob");
  const items = [
    { key: "bank", ok: accounts.length > 0 && !short.length, label: accounts.length ? (short.length
      ? `Bank statements not uploaded up to ${end} for ${short.map((a) => `${a.bank} ${String(a.number).slice(-4)}`).join(", ")}` : `Bank statements uploaded up to ${end} for every account`)
      : "No bank accounts set up (Cost → Bank statements)", go: "/cost?tab=bank" },
    { key: "bank_todo", ok: !n0(todo.n), label: n0(todo.n) ? `${todo.n} bank line${todo.n > 1 ? "s" : ""} without a head` : "Every bank line has a head", go: "/cost?tab=bank" },
    { key: "held", ok: !n0(held.n), label: n0(held.n) ? `${held.n} load${held.n > 1 ? "s" : ""} delivered but not invoiced (no price)` : "Every delivered load is invoiced", go: "/accounts?tab=invoices&view=held" },
    { key: "cl_todo", ok: !n0(clTodo.n), label: n0(clTodo.n) ? `${clTodo.n} C Ledger expense${clTodo.n > 1 ? "s" : ""} not yet given a category` : "C Ledger expenses all have a category", go: "/cost?tab=c-ledger" },
    { key: "pc_pending", ok: !n0(pcPending.n), label: n0(pcPending.n) ? `${pcPending.n} petty cash voucher${pcPending.n > 1 ? "s" : ""} waiting for approval` : "No petty cash voucher waiting", go: "/accounts?tab=petty-cash" },
    { key: "payroll", ok: payroll.status === "locked", label: payroll.status === "locked" ? "Payroll locked" : payroll.status ? "Payroll not locked yet — salaries may change" : "Payroll not made yet", go: "/hr?tab=payroll" },
    { key: "twob", ok: !twob.missing, label: twob.missing ? `GSTR-2B for ${monthLabel(twob.period, true)} not uploaded (it comes on the 14th)` : `GSTR-2B for ${monthLabel(twob.period, true)} uploaded`, go: "/cost?tab=gst" },
    { key: "cross", ok: !!cross?.ok, label: cross ? (cross.ok ? "C Ledger cross-check matches" : `C Ledger cross-check: ${cross.checks.filter((c) => !c.ok).map((c) => c.label).join("; ")}`) : "C Ledger cross-check could not run", go: "/cost?tab=c-ledger" },
  ];
  return items;
}

// What is different from the last time the month was sent.
function compare(sheets, sent) {
  if (!sent) return null;
  const old = sent.fingerprints || {};
  const now = new Set();
  let changed = 0, added = 0;
  for (const s of sheets) {
    for (const r of s.rows) {
      const key = `${s.key}|${r.k}`;
      now.add(key);
      if (!(key in old)) { r.change = "new"; added += 1; } else if (old[key] !== r.f) { r.change = "changed"; changed += 1; }
    }
  }
  const removed = Object.keys(old).filter((k) => !now.has(k)).map((k) => { const [sheetKey, rowKey] = k.split("|"); return { sheet: sheetKey, key: rowKey }; });
  return { changed, added, removed };
}

function dueOn(ym) { return `${addMonths(ym, 1)}-05`; }

async function lastSend(ym) {
  const { rows } = await query(
    `SELECT s.id, s.month, s.sent_at, s.note, s.fingerprints, u.name AS sent_by FROM ca_sends s LEFT JOIN users u ON u.id = s.sent_by
      WHERE s.month = $1 ORDER BY s.sent_at DESC LIMIT 1`, [ym]).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

function pickMonth(req, res) {
  const now = istMonth();
  const ym = req.query.month || req.body?.month || addMonths(now, -1);
  if (!MONTH_RE.test(ym) || ym > now) { res.status(400).json({ error: "Pick a month (YYYY-MM), not in the future." }); return null; }
  return ym;
}

router.get("/ca/pack", VIEW, async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const sheets = await buildPack(ym);
  const [items, sent, names] = await Promise.all([checklist(ym, sheets), lastSend(ym), headNames()]);
  const diff = compare(sheets, sent);
  const due = dueOn(ym);
  res.json({
    month: ym, label: monthLabel(ym, true), due_on: due, today: istDay(),
    status: sent ? (diff.changed || diff.added || diff.removed.length ? "changed" : "sent") : istDay() > due ? "overdue" : "not_sent",
    sent: sent ? { at: sent.sent_at, by: sent.sent_by, note: sent.note } : null,
    diff,
    checklist: items,
    sheets: sheets.map((s) => ({ key: s.key, name: s.name, note: s.note, columns: s.columns, rows: s.rows.map((r) => ({ k: r.k, c: r.c, change: r.change || null })) })),
    heads: CA_HEADS.map((h) => ({ ...h, ledger_name: names[h.key] || "" })),
  });
});

router.post("/ca/sent", EDIT, async (req, res) => {
  const ym = pickMonth(req, res);
  if (!ym) return;
  const sheets = await buildPack(ym);
  const fps = {};
  for (const s of sheets) for (const r of s.rows) fps[`${s.key}|${r.k}`] = r.f;
  const note = String(req.body?.note || "").trim().slice(0, 300) || null;
  await query(`INSERT INTO ca_sends (month, sent_by, note, fingerprints) VALUES ($1, $2, $3, $4)`, [ym, req.user.id, note, JSON.stringify(fps)]);
  res.json({ ok: true });
});

router.put("/ca/heads", EDIT, async (req, res) => {
  const names = req.body?.names || {};
  const entries = Object.entries(names).filter(([k]) => HEAD_KEYS.has(k));
  if (!entries.length) return res.status(400).json({ error: "Nothing to save." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [k, v] of entries) {
      const name = String(v || "").trim().slice(0, 120);
      if (!name) await client.query(`DELETE FROM ca_head_names WHERE head_key = $1`, [k]);
      else await client.query(
        `INSERT INTO ca_head_names (head_key, ledger_name, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (head_key) DO UPDATE SET ledger_name = EXCLUDED.ledger_name, updated_by = EXCLUDED.updated_by, updated_at = now()`, [k, name, req.user.id]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  res.json({ ok: true });
});

// Last months: sent, changed after sending, or not sent.
router.get("/ca/history", VIEW, async (_req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (s.month) s.month, s.sent_at, u.name AS sent_by FROM ca_sends s LEFT JOIN users u ON u.id = s.sent_by
      ORDER BY s.month DESC, s.sent_at DESC LIMIT 12`).catch(() => ({ rows: [] }));
  res.json(rows.map((r) => ({ ...r, label: monthLabel(r.month.trim(), true) })));
});

// For the Accountant home: is last month's data with the CA yet? (from the 1st)
router.get("/ca/due", VIEW, async (_req, res) => {
  const ym = addMonths(istMonth(), -1);
  const sent = await lastSend(ym);
  const due = dueOn(ym);
  res.json({ month: ym, label: monthLabel(ym, true), due_on: due, sent: !!sent, overdue: !sent && istDay() > due });
});

export default router;
