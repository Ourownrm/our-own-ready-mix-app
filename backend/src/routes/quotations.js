// Round 204 — Quotations (Accounts module).
//
// Lifecycle (owner, 11 Oct 2026):
//   draft → pending_approval → approved → sent → accepted
//                                              ↘ lost / declined
// A revision is a new quotation in the same family (quote_no + R, R1, R2 …,
// the numbering the owner's Excel already uses). Only an Administrator
// approves final rates. Manager or Administrator creates. The customer / site
// price list changes ONLY on acceptance (lib/priceList.js).
//
// Every route is gated by its function in the permission catalogue
// (accounts.*), and the Accounts module switch above it — no role guard, the
// Round 192 module pattern.
import { Router } from "express";
import { pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, can } from "../lib/permissions.js";
import { istDay } from "../lib/istDate.js";
import { AGREEMENT_TYPES, DEFAULT_TERMS } from "../lib/quotationTerms.js";
import { applyQuotationToPriceList, repriceAfterAcceptance, liveRatesForSite } from "../lib/priceList.js";
import { pushToRole } from "../lib/push.js";

const router = Router();
router.use(requireAuth);

const VIEW = requirePermission("accounts.quotations", "view");
const CREATE = requirePermission("accounts.quotations", "create");
const EDIT = requirePermission("accounts.quotations", "edit");
const APPROVE = requirePermission("accounts.quotation-approve", "edit");
const FOLLOWUP = requirePermission("accounts.quotation-followup", "edit");
const ACCEPT = requirePermission("accounts.quotation-accept", "edit");

const TYPES = new Set(AGREEMENT_TYPES.map((t) => t.key));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// "2026-10-11" → "2026-27" (April–March financial year, as the Excel numbers).
function fyOf(ymd) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// The owner's Excel: first revision "R", then "R1", "R2" …
export function revisionSuffix(rev) {
  if (!rev) return "";
  return rev === 1 ? "R" : `R${rev - 1}`;
}

// A Sales Executive sees the quotations of the sites they look after, and the
// ones they raised. Everyone else with view sees all.
async function scopeFor(user) {
  if (user.role !== "sales_executive") return { sql: "TRUE", params: [] };
  return {
    sql: `(q.created_by = $SCOPE OR s.assigned_sales_representative_id IN (SELECT id FROM salespersons WHERE user_id = $SCOPE))`,
    params: [user.id],
  };
}
function withScope(sql, scope, baseParams) {
  const idx = baseParams.length + 1;
  return { sql: sql.replace("$SCOPE_FILTER", scope.sql.replaceAll("$SCOPE", `$${idx}`)), params: [...baseParams, ...scope.params] };
}

async function settings() {
  const { rows } = await query(`SELECT * FROM quotation_settings WHERE id = 1`);
  return rows[0];
}

async function logEvent(client, quotationId, event, userId, extra = {}) {
  await client.query(
    `INSERT INTO quotation_events (quotation_id, event, note, contact, outcome, next_followup_on, by_user)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [quotationId, event, extra.note || null, extra.contact || null, extra.outcome || null, extra.next_followup_on || null, userId]
  );
}

async function loadQuotation(id) {
  const { rows } = await query(
    `SELECT q.*, c.name AS customer_name, c.billing_address AS customer_address, s.name AS site_name,
            ba.name AS billing_name, ba.address AS billing_address, ba.gstin AS billing_gstin,
            cu.name AS created_by_name, au.name AS approved_by_name, acu.name AS accepted_by_name
       FROM quotations q
       JOIN customers c ON c.id = q.customer_id
       JOIN sites s ON s.id = q.site_id
       LEFT JOIN customer_billing_addresses ba ON ba.id = q.billing_address_id
       LEFT JOIN users cu ON cu.id = q.created_by
       LEFT JOIN users au ON au.id = q.approved_by
       LEFT JOIN users acu ON acu.id = q.accepted_by
      WHERE q.id = $1`,
    [id]
  );
  if (!rows.length) return null;
  const q = rows[0];
  const { rows: lines } = await query(
    `SELECT ql.*, m.name AS grade_name FROM quotation_lines ql LEFT JOIN mix_grades m ON m.id = ql.mix_grade_id
      WHERE ql.quotation_id = $1 ORDER BY ql.line_no`,
    [id]
  );
  q.lines = lines;
  return q;
}

function cleanLines(lines) {
  if (!Array.isArray(lines) || !lines.length) return { error: "Add at least one grade with its rate." };
  if (lines.length > 12) return { error: "A quotation can carry at most 12 lines." };
  const seen = new Set();
  const out = [];
  for (const [i, l] of lines.entries()) {
    const gradeId = l.mix_grade_id ? Number(l.mix_grade_id) : null;
    const label = String(l.item_label || "").trim() || null;
    const rate = Number(l.rate_total);
    if (!gradeId && !label) return { error: `Line ${i + 1}: choose a grade (or name the extra item).` };
    if (!(rate > 0)) return { error: `Line ${i + 1}: enter the total rate per m³ including GST.` };
    if (gradeId) {
      if (seen.has(gradeId)) return { error: `Line ${i + 1}: that grade is already on this quotation.` };
      seen.add(gradeId);
    }
    out.push({
      mix_grade_id: gradeId, item_label: gradeId ? null : label,
      specification: String(l.specification || "").trim().slice(0, 200) || null,
      qty_m3: l.qty_m3 === "" || l.qty_m3 == null ? null : Number(l.qty_m3),
      rate_total: r2(rate),
    });
  }
  return { lines: out };
}

async function nextNumber(client, quoteDate) {
  const { rows } = await client.query(`SELECT next_serial FROM quotation_settings WHERE id = 1 FOR UPDATE`);
  let serial = rows[0].next_serial;
  // Never hand out a number already used (a serial typed back in Settings).
  for (;;) {
    const no = `RMC-QTN-${fyOf(quoteDate)}-${String(serial).padStart(4, "0")}`;
    const { rows: used } = await client.query(`SELECT 1 FROM quotations WHERE family_no = $1 LIMIT 1`, [no]);
    if (!used.length) {
      await client.query(`UPDATE quotation_settings SET next_serial = $1 WHERE id = 1`, [serial + 1]);
      return no;
    }
    serial++;
  }
}

// ---------------------------------------------------------------------------
// Reference data for the builder.
// ---------------------------------------------------------------------------
router.get("/meta", VIEW, async (req, res) => {
  const s = await settings();
  const { rows: lib } = await query(`SELECT agreement_type, terms, version FROM quotation_term_library`);
  const library = Object.fromEntries(lib.map((r) => [r.agreement_type, { terms: r.terms, version: r.version }]));
  for (const t of AGREEMENT_TYPES) if (!library[t.key]) library[t.key] = { terms: DEFAULT_TERMS[t.key], version: 0 };
  const perms = {
    create: await can(req.user, "accounts.quotations", "create"),
    edit: await can(req.user, "accounts.quotations", "edit"),
    approve: await can(req.user, "accounts.quotation-approve", "edit"),
    followup: await can(req.user, "accounts.quotation-followup", "edit"),
    accept: await can(req.user, "accounts.quotation-accept", "edit"),
    revision_bulk: await can(req.user, "accounts.price-revision", "edit"),
  };
  res.json({
    agreement_types: AGREEMENT_TYPES,
    validity_days: s.validity_days,
    next_serial: s.next_serial,
    defaults: s.defaults,
    bank_accounts: s.bank_accounts,
    director: { name: s.director_name, title: s.director_title, phone: s.director_phone },
    library,
    perms,
  });
});

// ---------------------------------------------------------------------------
// Register and follow-ups.
// ---------------------------------------------------------------------------
router.get("/", VIEW, async (req, res) => {
  const scope = await scopeFor(req.user);
  const base = [];
  let where = "$SCOPE_FILTER";
  if (req.query.status && req.query.status !== "all") {
    base.push(req.query.status);
    where += ` AND q.status = $${base.length}`;
  }
  if (req.query.customer_id) {
    base.push(Number(req.query.customer_id));
    where += ` AND q.customer_id = $${base.length}`;
  }
  const { sql, params } = withScope(
    `SELECT q.id, q.quote_no, q.family_no, q.revision, q.status, q.agreement_type, q.quote_date::text AS quote_date,
            q.valid_until::text AS valid_until, q.sent_at, q.accepted_on::text AS accepted_on, q.rates_from::text AS rates_from,
            q.closed_reason, q.payment, q.created_at, q.approved_at, q.terms_modified,
            c.id AS customer_id, c.name AS customer_name, s.id AS site_id, s.name AS site_name,
            u.name AS created_by_name, u.role AS created_by_role,
            (SELECT json_agg(json_build_object('grade', COALESCE(m.name, ql.item_label), 'rate', ql.rate_total, 'qty', ql.qty_m3) ORDER BY ql.line_no)
               FROM quotation_lines ql LEFT JOIN mix_grades m ON m.id = ql.mix_grade_id WHERE ql.quotation_id = q.id) AS lines,
            (SELECT SUM(ql.rate_total * COALESCE(ql.qty_m3, 0)) FROM quotation_lines ql WHERE ql.quotation_id = q.id) AS value_incl_gst
       FROM quotations q
       JOIN customers c ON c.id = q.customer_id
       JOIN sites s ON s.id = q.site_id
       LEFT JOIN users u ON u.id = q.created_by
      WHERE ${where}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT 500`,
    scope, base
  );
  const { rows } = await query(sql, params);
  res.json(rows);
});

// Follow-ups due: every sent quotation, and approved ones not yet sent, with
// when the next call is due. The rule (approved mock-up): 2 days and 5 days
// after sending, and on the expiry day — unless somebody logged a follow-up
// and chose the next date themselves.
router.get("/followups", VIEW, async (req, res) => {
  const scope = await scopeFor(req.user);
  const { sql, params } = withScope(
    `SELECT q.id, q.quote_no, q.status, q.sent_at, q.valid_until::text AS valid_until, q.next_followup_on::text AS next_followup_on,
            q.quote_date::text AS quote_date, q.approved_at, q.kind_attention,
            c.id AS customer_id, c.name AS customer_name, c.contact_number, s.name AS site_name,
            u.name AS owner_name,
            (SELECT SUM(ql.rate_total * COALESCE(ql.qty_m3, 0)) FROM quotation_lines ql WHERE ql.quotation_id = q.id) AS value_incl_gst,
            last.at AS last_at, last.note AS last_note, last.outcome AS last_outcome, last.contact AS last_contact, lu.name AS last_by
       FROM quotations q
       JOIN customers c ON c.id = q.customer_id
       JOIN sites s ON s.id = q.site_id
       LEFT JOIN users u ON u.id = q.created_by
       LEFT JOIN LATERAL (
         SELECT e.* FROM quotation_events e WHERE e.quotation_id = q.id AND e.event = 'followup' ORDER BY e.at DESC LIMIT 1
       ) last ON true
       LEFT JOIN users lu ON lu.id = last.by_user
      WHERE q.status IN ('sent', 'approved') AND $SCOPE_FILTER
      ORDER BY q.sent_at NULLS FIRST`,
    scope, []
  );
  const { rows } = await query(sql, params);
  const today = istDay();
  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10); // ist-ok: pure date arithmetic on a date-only string, read back as UTC
  };
  const out = rows.map((r) => {
    let due;
    if (r.status === "approved") {
      due = today; // approved but not sent — send it
    } else if (r.next_followup_on) {
      due = r.next_followup_on;
    } else {
      const sentDay = istDay(new Date(r.sent_at).getTime());
      const candidates = [addDays(sentDay, 2), addDays(sentDay, 5), r.valid_until].filter(Boolean);
      const lastDay = r.last_at ? istDay(new Date(r.last_at).getTime()) : null;
      due = candidates.find((d) => !lastDay || d > lastDay) || r.valid_until || today;
    }
    const expired = r.valid_until && r.valid_until < today;
    return { ...r, due_on: due, overdue: due < today, due_today: due === today, expired };
  }).sort((a, b) => (a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : 0));
  res.json(out);
});

// ---------------------------------------------------------------------------
// One quotation, with its family and the site's current price list.
// ---------------------------------------------------------------------------
router.get("/:id(\\d+)", VIEW, async (req, res) => {
  const q = await loadQuotation(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (req.user.role === "sales_executive") {
    const scope = await scopeFor(req.user);
    const { sql, params } = withScope(
      `SELECT 1 FROM quotations q JOIN sites s ON s.id = q.site_id WHERE q.id = $1 AND $SCOPE_FILTER`, scope, [q.id]
    );
    const { rows } = await query(sql, params);
    if (!rows.length) return res.status(403).json({ error: "This quotation is not one of your sites." });
  }
  const [events, family, live] = await Promise.all([
    query(
      `SELECT e.*, u.name AS by_name FROM quotation_events e LEFT JOIN users u ON u.id = e.by_user
        WHERE e.quotation_id = $1 ORDER BY e.at`,
      [q.id]
    ),
    query(
      `SELECT id, quote_no, revision, status, quote_date::text AS quote_date FROM quotations WHERE family_no = $1 ORDER BY revision`,
      [q.family_no]
    ),
    liveRatesForSite(q.customer_id, q.site_id),
  ]);
  let parent = null;
  if (q.parent_id) parent = await loadQuotation(q.parent_id);
  delete q.acceptance_proof; // fetched separately — it can be a few MB
  res.json({ quotation: q, events: events.rows, family: family.rows, live_rates: live, parent });
});

router.get("/:id(\\d+)/proof", VIEW, async (req, res) => {
  const { rows } = await query(`SELECT acceptance_proof, acceptance_proof_name FROM quotations WHERE id = $1`, [req.params.id]);
  if (!rows.length || !rows[0].acceptance_proof) return res.status(404).json({ error: "No proof attached." });
  res.json({ data: rows[0].acceptance_proof, name: rows[0].acceptance_proof_name });
});

// ---------------------------------------------------------------------------
// Create / edit.
// ---------------------------------------------------------------------------
function readBody(b) {
  const type = String(b.agreement_type || "");
  if (!TYPES.has(type)) return { error: "Choose the agreement type." };
  if (!b.customer_id || !b.site_id) return { error: "Choose the customer and the project / site." };
  const quoteDate = ISO.test(b.quote_date || "") ? b.quote_date : istDay();
  const validity = Math.max(1, Math.min(90, Number(b.validity_days) || 7));
  const lines = cleanLines(b.lines);
  if (lines.error) return lines;
  return {
    data: {
      customer_id: Number(b.customer_id), site_id: Number(b.site_id),
      billing_address_id: b.billing_address_id ? Number(b.billing_address_id) : null,
      kind_attention: String(b.kind_attention || "").trim().slice(0, 150) || null,
      agreement_type: type, quote_date: quoteDate, validity_days: validity,
      charges: b.charges && typeof b.charges === "object" ? b.charges : {},
      payment: b.payment && typeof b.payment === "object" ? b.payment : {},
      rebate_per_m3: b.rebate_per_m3 === "" || b.rebate_per_m3 == null ? null : Number(b.rebate_per_m3),
      special_conditions: String(b.special_conditions || "").trim() || null,
      terms: b.terms && typeof b.terms === "object" ? b.terms : null,
      terms_modified: !!b.terms_modified,
    },
    lines: lines.lines,
  };
}

async function assertSiteOfCustomer(customerId, siteId) {
  const { rows } = await query(`SELECT 1 FROM sites WHERE id = $1 AND customer_id = $2`, [siteId, customerId]);
  return rows.length > 0;
}

async function libraryTerms(type) {
  const { rows } = await query(`SELECT terms FROM quotation_term_library WHERE agreement_type = $1`, [type]);
  return rows[0]?.terms || DEFAULT_TERMS[type];
}

async function writeLines(client, quotationId, lines) {
  await client.query(`DELETE FROM quotation_lines WHERE quotation_id = $1`, [quotationId]);
  let n = 1;
  for (const l of lines) {
    await client.query(
      `INSERT INTO quotation_lines (quotation_id, line_no, mix_grade_id, item_label, specification, qty_m3, rate_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [quotationId, n++, l.mix_grade_id, l.item_label, l.specification, l.qty_m3, l.rate_total]
    );
  }
}

// submit: false = draft, true = send for approval. A person who can approve
// (Administrator) approves their own quotation in the same step.
router.post("/", CREATE, async (req, res) => {
  const parsed = readBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const d = parsed.data;
  if (!(await assertSiteOfCustomer(d.customer_id, d.site_id))) {
    return res.status(400).json({ error: "That project / site belongs to a different customer." });
  }
  const terms = d.terms || (await libraryTerms(d.agreement_type));
  const submit = !!req.body.submit;
  const selfApprove = submit && (await can(req.user, "accounts.quotation-approve", "edit"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const no = await nextNumber(client, d.quote_date);
    const status = selfApprove ? "approved" : submit ? "pending_approval" : "draft";
    const { rows } = await client.query(
      `INSERT INTO quotations
         (quote_no, family_no, revision, customer_id, site_id, billing_address_id, kind_attention, agreement_type,
          quote_date, validity_days, status, charges, payment, rebate_per_m3, special_conditions, terms, terms_modified,
          created_by, submitted_at, approved_by, approved_at)
       VALUES ($1, $1, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               CASE WHEN $17 THEN now() END, CASE WHEN $18 THEN $16::int END, CASE WHEN $18 THEN now() END)
       RETURNING id`,
      [no, d.customer_id, d.site_id, d.billing_address_id, d.kind_attention, d.agreement_type,
       d.quote_date, d.validity_days, status, d.charges, d.payment, d.rebate_per_m3, d.special_conditions,
       JSON.stringify(terms), d.terms_modified, req.user.id, submit, selfApprove]
    );
    const id = rows[0].id;
    await writeLines(client, id, parsed.lines);
    await logEvent(client, id, "created", req.user.id);
    if (submit) await logEvent(client, id, selfApprove ? "approved" : "submitted", req.user.id, selfApprove ? { note: "Created and approved by an Administrator" } : {});
    await client.query("COMMIT");
    if (submit && !selfApprove) {
      await pushToRole("administrator", { title: "Quotation to approve", body: `${no} is waiting for your approval.`, url: `/accounts?tab=quotations&id=${id}` });
    }
    res.status(201).json({ id, quote_no: no, status });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Edit: a draft, or one waiting for approval (sent back to the preparer goes
// to draft). After approval, a change is a revision, never an edit.
router.put("/:id(\\d+)", EDIT, async (req, res) => {
  const q = await loadQuotation(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (!["draft", "pending_approval"].includes(q.status)) {
    return res.status(409).json({ error: "This quotation is already approved — revise it instead of editing." });
  }
  const parsed = readBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const d = parsed.data;
  if (!(await assertSiteOfCustomer(d.customer_id, d.site_id))) {
    return res.status(400).json({ error: "That project / site belongs to a different customer." });
  }
  const submit = !!req.body.submit;
  const selfApprove = submit && (await can(req.user, "accounts.quotation-approve", "edit"));
  const status = selfApprove ? "approved" : submit ? "pending_approval" : q.status;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE quotations SET customer_id=$2, site_id=$3, billing_address_id=$4, kind_attention=$5, agreement_type=$6,
              quote_date=$7, validity_days=$8, charges=$9, payment=$10, rebate_per_m3=$11, special_conditions=$12,
              terms=COALESCE($13::jsonb, terms), terms_modified=$14, status=$15, updated_at=now(),
              submitted_at = CASE WHEN $16 THEN now() ELSE submitted_at END,
              approved_by = CASE WHEN $17 THEN $18::int ELSE approved_by END,
              approved_at = CASE WHEN $17 THEN now() ELSE approved_at END
        WHERE id = $1`,
      [q.id, d.customer_id, d.site_id, d.billing_address_id, d.kind_attention, d.agreement_type, d.quote_date,
       d.validity_days, d.charges, d.payment, d.rebate_per_m3, d.special_conditions,
       d.terms ? JSON.stringify(d.terms) : null, d.terms_modified, status, submit, selfApprove, req.user.id]
    );
    await writeLines(client, q.id, parsed.lines);
    await logEvent(client, q.id, submit ? (selfApprove ? "approved" : "submitted") : "edited", req.user.id);
    await client.query("COMMIT");
    if (submit && !selfApprove) {
      await pushToRole("administrator", { title: "Quotation to approve", body: `${q.quote_no} is waiting for your approval.`, url: `/accounts?tab=quotations&id=${q.id}` });
    }
    res.json({ ok: true, status });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

router.post("/:id(\\d+)/cancel", EDIT, async (req, res) => {
  const { rows } = await query(
    `UPDATE quotations SET status = 'cancelled', closed_reason = $2, closed_by = $3, closed_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('draft', 'pending_approval') RETURNING id`,
    [req.params.id, String(req.body.reason || "").trim() || null, req.user.id]
  );
  if (!rows.length) return res.status(409).json({ error: "Only a draft or one waiting for approval can be cancelled." });
  await logEvent(pool, req.params.id, "cancelled", req.user.id, { note: req.body.reason });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Approval — Administrator only. The final rate per grade can be changed here;
// the proposal is kept so the change shows.
// ---------------------------------------------------------------------------
router.post("/:id(\\d+)/approve", APPROVE, async (req, res) => {
  const q = await loadQuotation(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (!["pending_approval", "draft"].includes(q.status)) {
    return res.status(409).json({ error: "This quotation is not waiting for approval." });
  }
  const finals = new Map((req.body.lines || []).map((l) => [Number(l.id), Number(l.rate_total)]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const changed = [];
    for (const l of q.lines) {
      const f = finals.get(l.id);
      if (f && f > 0 && Math.abs(f - Number(l.rate_total)) >= 0.005) {
        await client.query(
          `UPDATE quotation_lines SET proposed_rate = COALESCE(proposed_rate, rate_total), rate_total = $2 WHERE id = $1`,
          [l.id, r2(f)]
        );
        changed.push(`${l.grade_name || l.item_label} ₹${l.rate_total} → ₹${r2(f)}`);
      }
    }
    await client.query(
      `UPDATE quotations SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3, updated_at = now()
        WHERE id = $1`,
      [q.id, req.user.id, String(req.body.note || "").trim() || null]
    );
    await logEvent(client, q.id, "approved", req.user.id, {
      note: [String(req.body.note || "").trim(), changed.length ? `Final rate changed: ${changed.join("; ")}` : ""].filter(Boolean).join(" — ") || null,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (q.created_by && q.created_by !== req.user.id) {
    await query(
      `INSERT INTO notifications (recipient_role, recipient_id, type, message)
       SELECT role, id, 'quotation_approved', $2 FROM users WHERE id = $1`,
      [q.created_by, `${q.quote_no} (${q.customer_name} · ${q.site_name}) is approved — send it to the customer.`]
    );
  }
  res.json({ ok: true });
});

router.post("/:id(\\d+)/send-back", APPROVE, async (req, res) => {
  const note = String(req.body.note || "").trim();
  if (!note) return res.status(400).json({ error: "Say what needs changing." });
  const { rows } = await query(
    `UPDATE quotations SET status = 'draft', updated_at = now() WHERE id = $1 AND status = 'pending_approval'
     RETURNING quote_no, created_by`,
    [req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: "This quotation is not waiting for approval." });
  await logEvent(pool, req.params.id, "sent_back", req.user.id, { note });
  if (rows[0].created_by) {
    await query(
      `INSERT INTO notifications (recipient_role, recipient_id, type, message)
       SELECT role, id, 'quotation_sent_back', $2 FROM users WHERE id = $1`,
      [rows[0].created_by, `${rows[0].quote_no} was sent back for changes: ${note}`]
    );
  }
  res.json({ ok: true });
});

// Sent to the customer — validity starts now.
router.post("/:id(\\d+)/mark-sent", EDIT, async (req, res) => {
  const via = String(req.body.via || "whatsapp").slice(0, 40);
  const { rows } = await query(
    `UPDATE quotations SET status = 'sent', sent_at = now(), sent_via = $2,
            valid_until = CURRENT_DATE + validity_days, updated_at = now()
      WHERE id = $1 AND status IN ('approved', 'sent') RETURNING valid_until::text AS valid_until`,
    [req.params.id, via]
  );
  if (!rows.length) return res.status(409).json({ error: "Only an approved quotation can be sent." });
  await logEvent(pool, req.params.id, "sent", req.user.id, { note: `Sent by ${via}; valid until ${rows[0].valid_until}` });
  res.json({ ok: true, valid_until: rows[0].valid_until });
});

router.post("/:id(\\d+)/extend", EDIT, async (req, res) => {
  const days = Math.max(1, Math.min(60, Number(req.body.days) || 7));
  const { rows } = await query(
    `UPDATE quotations SET valid_until = GREATEST(COALESCE(valid_until, CURRENT_DATE), CURRENT_DATE) + $2::int, updated_at = now()
      WHERE id = $1 AND status IN ('sent', 'approved') RETURNING valid_until::text AS valid_until`,
    [req.params.id, days]
  );
  if (!rows.length) return res.status(409).json({ error: "Only a sent or approved quotation can be extended." });
  await logEvent(pool, req.params.id, "extended", req.user.id, { note: `Validity extended to ${rows[0].valid_until}` });
  res.json({ ok: true, valid_until: rows[0].valid_until });
});

// ---------------------------------------------------------------------------
// Follow-ups (top priority on the register).
// ---------------------------------------------------------------------------
const OUTCOMES = ["interested", "negotiating", "order_expected", "no_response", "lost", "other"];
router.post("/:id(\\d+)/followup", FOLLOWUP, async (req, res) => {
  const outcome = OUTCOMES.includes(req.body.outcome) ? req.body.outcome : "other";
  const next = ISO.test(req.body.next_followup_on || "") ? req.body.next_followup_on : null;
  const note = String(req.body.note || "").trim();
  if (!note && outcome === "other") return res.status(400).json({ error: "Write what was said." });
  const { rows } = await query(`SELECT status FROM quotations WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Quotation not found." });
  if (!["sent", "approved"].includes(rows[0].status)) return res.status(409).json({ error: "Follow-ups are for quotations that are with the customer." });
  await logEvent(pool, req.params.id, "followup", req.user.id, {
    note, contact: String(req.body.contact || "").trim().slice(0, 120) || null, outcome, next_followup_on: next,
  });
  if (outcome === "lost") {
    await query(
      `UPDATE quotations SET status = 'lost', closed_reason = $2, closed_by = $3, closed_at = now(), next_followup_on = NULL, updated_at = now()
        WHERE id = $1`,
      [req.params.id, note || "Lost", req.user.id]
    );
  } else {
    await query(`UPDATE quotations SET next_followup_on = $2, updated_at = now() WHERE id = $1`, [req.params.id, next]);
  }
  res.json({ ok: true });
});

// Lost (new customer) or declined (a revision — the old price list stays).
router.post("/:id(\\d+)/close", EDIT, async (req, res) => {
  const reason = String(req.body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Give the reason." });
  const { rows } = await query(`SELECT revision, status FROM quotations WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Quotation not found." });
  if (!["sent", "approved"].includes(rows[0].status)) return res.status(409).json({ error: "Only a quotation with the customer can be closed this way." });
  const status = rows[0].revision > 0 ? "declined" : "lost";
  await query(
    `UPDATE quotations SET status = $2, closed_reason = $3, closed_by = $4, closed_at = now(), next_followup_on = NULL, updated_at = now()
      WHERE id = $1`,
    [req.params.id, status, reason, req.user.id]
  );
  await logEvent(pool, req.params.id, status, req.user.id, { note: reason });
  res.json({ ok: true, status });
});

// ---------------------------------------------------------------------------
// Customer acceptance — the only thing that changes the price list.
// ---------------------------------------------------------------------------
const MODES = ["signed_copy", "email", "whatsapp"];
router.post("/:id(\\d+)/accept", ACCEPT, async (req, res) => {
  const q = await loadQuotation(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (!["approved", "sent"].includes(q.status)) {
    return res.status(409).json({ error: "Only an approved quotation can be accepted." });
  }
  if (q.agreement_type === "price_only") {
    return res.status(409).json({ error: "A price-only letter is not an agreement — make a Quotation-cum-Agreement to set the price list." });
  }
  const mode = MODES.includes(req.body.mode) ? req.body.mode : null;
  if (!mode) return res.status(400).json({ error: "Say how the customer accepted (signed copy, email or WhatsApp)." });
  const acceptedOn = ISO.test(req.body.accepted_on || "") ? req.body.accepted_on : istDay();
  const ratesFrom = ISO.test(req.body.rates_from || "") ? req.body.rates_from : acceptedOn;
  const proof = typeof req.body.proof === "string" && req.body.proof.startsWith("data:") ? req.body.proof : null;
  if (proof && proof.length > 8_000_000) return res.status(400).json({ error: "The proof file is too large (max about 6 MB)." });
  if (q.revision > 0 && !proof) {
    return res.status(400).json({ error: "Attach the proof of acceptance — a revised price list changes only with the customer's written acceptance." });
  }
  const result = await applyQuotationToPriceList(q.id, ratesFrom, req.user.id);
  await query(
    `UPDATE quotations SET status = 'accepted', accepted_at = now(), accepted_on = $2, acceptance_mode = $3,
            acceptance_proof = $4, acceptance_proof_name = $5, rates_from = $6, accepted_by = $7,
            next_followup_on = NULL, updated_at = now()
      WHERE id = $1`,
    [q.id, acceptedOn, mode, proof, String(req.body.proof_name || "").slice(0, 200) || null, ratesFrom, req.user.id]
  );
  await logEvent(pool, q.id, "accepted", req.user.id, { note: `Accepted by ${mode.replace("_", " ")} on ${acceptedOn}; price list from ${ratesFrom}.` });
  const repriced = await repriceAfterAcceptance(result, ratesFrom);
  res.json({ ok: true, repriced });
});

// ---------------------------------------------------------------------------
// Revise — the next revision of the family, as an editable draft. The current
// price list is untouched until the customer accepts the revision.
// ---------------------------------------------------------------------------
router.post("/:id(\\d+)/revise", CREATE, async (req, res) => {
  const reason = String(req.body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Give the reason for the revision." });
  const q = await loadQuotation(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  if (["draft", "pending_approval", "cancelled"].includes(q.status)) {
    return res.status(409).json({ error: "Edit this quotation instead — it is not approved yet." });
  }
  const { rows: open } = await query(
    `SELECT quote_no FROM quotations WHERE family_no = $1 AND status IN ('draft', 'pending_approval') LIMIT 1`,
    [q.family_no]
  );
  if (open.length) return res.status(409).json({ error: `${open[0].quote_no} is already being prepared for this quotation.` });
  const { rows: mx } = await query(`SELECT MAX(revision) AS r FROM quotations WHERE family_no = $1`, [q.family_no]);
  const rev = Number(mx[0].r) + 1;
  const no = `${q.family_no}${revisionSuffix(rev)}`;
  const id = await createRevision(q, rev, no, reason, req.user.id, null);
  res.status(201).json({ id, quote_no: no });
});

async function createRevision(q, rev, no, reason, userId, rateAdjust) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO quotations
         (quote_no, family_no, revision, parent_id, customer_id, site_id, billing_address_id, kind_attention, agreement_type,
          quote_date, validity_days, status, charges, payment, rebate_per_m3, special_conditions, terms, terms_modified,
          revision_reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id`,
      [no, q.family_no, rev, q.id, q.customer_id, q.site_id, q.billing_address_id, q.kind_attention, q.agreement_type,
       q.validity_days, rateAdjust ? "pending_approval" : "draft", q.charges, q.payment, q.rebate_per_m3, q.special_conditions,
       JSON.stringify(q.terms), q.terms_modified, reason, userId]
    );
    const id = rows[0].id;
    let n = 1;
    for (const l of q.lines) {
      const rate = rateAdjust && l.mix_grade_id && (!rateAdjust.grades || rateAdjust.grades.includes(l.mix_grade_id))
        ? r2(Number(l.rate_total) + rateAdjust.amount) : Number(l.rate_total);
      await client.query(
        `INSERT INTO quotation_lines (quotation_id, line_no, mix_grade_id, item_label, specification, qty_m3, rate_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, n++, l.mix_grade_id, l.item_label, l.specification, l.qty_m3, rate]
      );
    }
    await logEvent(client, id, "revised", userId, { note: `Revision of ${q.quote_no}: ${reason}` });
    if (rateAdjust) await client.query(`UPDATE quotations SET submitted_at = now() WHERE id = $1`, [id]);
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Price revision across many customers (cement / diesel price change). Each
// site whose live price list came from an accepted quotation gets its own
// revision, waiting for approval; the price list changes only when each
// customer accepts. Sites still on the old rate file are listed, not changed.
router.post("/price-revision", requirePermission("accounts.price-revision", "edit"), async (req, res) => {
  const amount = Number(req.body.increase);
  if (!amount) return res.status(400).json({ error: "Enter the change per m³ (incl. GST), e.g. 150 or -100." });
  const reason = String(req.body.reason || "").trim() || "Raw material / diesel price change";
  const grades = Array.isArray(req.body.grade_ids) && req.body.grade_ids.length ? req.body.grade_ids.map(Number) : null;
  const customerIds = Array.isArray(req.body.customer_ids) && req.body.customer_ids.length ? req.body.customer_ids.map(Number) : null;
  const preview = !!req.body.preview;
  const { rows: live } = await query(
    `SELECT DISTINCT ON (q.customer_id, q.site_id) q.id, q.quote_no, q.family_no, c.name AS customer_name, s.name AS site_name
       FROM quotations q JOIN customers c ON c.id = q.customer_id JOIN sites s ON s.id = q.site_id
      WHERE q.status = 'accepted' AND ($1::int[] IS NULL OR q.customer_id = ANY($1::int[]))
      ORDER BY q.customer_id, q.site_id, q.accepted_at DESC`,
    [customerIds]
  );
  const { rows: fileOnly } = await query(
    `SELECT DISTINCT c.name AS customer_name, COALESCE(s.name, 'all sites') AS site_name
       FROM rate_master rm JOIN customers c ON c.id = rm.customer_id LEFT JOIN sites s ON s.id = rm.site_id
      WHERE rm.source = 'rate_file' AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)
        AND ($1::int[] IS NULL OR rm.customer_id = ANY($1::int[]))
      ORDER BY 1, 2`,
    [customerIds]
  );
  const candidates = [];
  for (const l of live) {
    const { rows: open } = await query(
      `SELECT 1 FROM quotations WHERE family_no = $1 AND status IN ('draft', 'pending_approval', 'approved', 'sent') LIMIT 1`,
      [l.family_no]
    );
    candidates.push({ ...l, skipped: open.length ? "a revision is already open" : null });
  }
  if (preview) return res.json({ candidates, rate_file_only: fileOnly });
  const made = [];
  for (const cnd of candidates.filter((c) => !c.skipped)) {
    const q = await loadQuotation(cnd.id);
    const { rows: mx } = await query(`SELECT MAX(revision) AS r FROM quotations WHERE family_no = $1`, [q.family_no]);
    const rev = Number(mx[0].r) + 1;
    const no = `${q.family_no}${revisionSuffix(rev)}`;
    await createRevision(q, rev, no, reason, req.user.id, { amount, grades });
    made.push(no);
  }
  res.json({ made, rate_file_only: fileOnly });
});

// ---------------------------------------------------------------------------
// Print data: everything the PDF needs in one call.
// ---------------------------------------------------------------------------
router.get("/:id(\\d+)/print", VIEW, async (req, res) => {
  const q = await loadQuotation(req.params.id);
  if (!q) return res.status(404).json({ error: "Quotation not found." });
  const s = await settings();
  delete q.acceptance_proof;
  res.json({
    quotation: q,
    settings: {
      director_name: s.director_name, director_title: s.director_title, director_phone: s.director_phone,
      signature_image: s.signature_image, bank_accounts: s.bank_accounts,
    },
  });
});

// ---------------------------------------------------------------------------
// Customer / site price lists.
// ---------------------------------------------------------------------------
const PRICE_VIEW = requirePermission("accounts.price-lists", "view");

router.get("/price-lists", PRICE_VIEW, async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.name,
            COUNT(DISTINCT rm.site_id) FILTER (WHERE rm.site_id IS NOT NULL) AS sites_priced,
            COUNT(DISTINCT rm.mix_grade_id) AS grades_priced,
            BOOL_OR(rm.site_id IS NULL) AS has_all_sites_rate,
            (SELECT COUNT(*) FROM quotations q WHERE q.customer_id = c.id AND q.status IN ('pending_approval','approved','sent')) AS open_quotations
       FROM customers c
       JOIN rate_master rm ON rm.customer_id = c.id
        AND rm.effective_from <= CURRENT_DATE AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)
      GROUP BY c.id, c.name
     UNION
     SELECT c.id, c.name, 0, 0, false, COUNT(q.id)
       FROM customers c JOIN quotations q ON q.customer_id = c.id AND q.status IN ('pending_approval','approved','sent')
      WHERE NOT EXISTS (SELECT 1 FROM rate_master rm WHERE rm.customer_id = c.id
                          AND rm.effective_from <= CURRENT_DATE AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE))
      GROUP BY c.id, c.name
      ORDER BY 2`
  );
  res.json(rows);
});

router.get("/price-lists/:customerId(\\d+)", PRICE_VIEW, async (req, res) => {
  const customerId = Number(req.params.customerId);
  const [cust, sites, grades, credit, outstanding] = await Promise.all([
    query(`SELECT id, name FROM customers WHERE id = $1`, [customerId]),
    query(`SELECT id, name FROM sites WHERE customer_id = $1 AND COALESCE(is_active, true) ORDER BY name`, [customerId]),
    query(`SELECT id, name FROM mix_grades ORDER BY name`),
    query(
      `SELECT payment, agreement_type, quote_no FROM quotations WHERE customer_id = $1 AND status = 'accepted'
        AND agreement_type IN ('credit', 'credit_qty') ORDER BY accepted_at DESC LIMIT 1`,
      [customerId]
    ),
    query(
      `SELECT COALESCE((SELECT SUM(total_amount) FROM invoices WHERE customer_id = $1), 0)
            + COALESCE((SELECT SUM(amount) FROM customer_opening_balances WHERE customer_id = $1), 0)
            - COALESCE((SELECT SUM(p.amount) FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
                         LEFT JOIN customer_opening_balances ob ON ob.id = p.opening_balance_id
                        WHERE COALESCE(i.customer_id, ob.customer_id) = $1), 0) AS balance`,
      [customerId]
    ),
  ]);
  if (!cust.rows.length) return res.status(404).json({ error: "Customer not found." });
  const out = [];
  const siteList = [...sites.rows];
  const { rows: wide } = await query(
    `SELECT 1 FROM rate_master WHERE customer_id = $1 AND site_id IS NULL
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) LIMIT 1`,
    [customerId]
  );
  for (const s of siteList) {
    const live = await liveRatesForSite(customerId, s.id);
    const { rows: delivered } = await query(
      `SELECT co.mix_grade_id, SUM(dt.loaded_quantity_m3) AS m3
         FROM delivery_tickets dt JOIN customer_orders co ON co.id = dt.order_id
        WHERE co.customer_id = $1 AND co.site_id = $2 AND dt.status NOT IN ('cancelled','rejected')
        GROUP BY co.mix_grade_id`,
      [customerId, s.id]
    );
    const suppliedBy = Object.fromEntries(delivered.map((d) => [d.mix_grade_id, Number(d.m3)]));
    const { rows: pending } = await query(
      `SELECT q.id, q.quote_no, q.status,
              (SELECT json_agg(json_build_object('mix_grade_id', ql.mix_grade_id, 'rate', ql.rate_total)) FROM quotation_lines ql
                WHERE ql.quotation_id = q.id AND ql.mix_grade_id IS NOT NULL) AS lines
         FROM quotations q WHERE q.customer_id = $1 AND q.site_id = $2 AND q.status IN ('pending_approval','approved','sent')
        ORDER BY q.id DESC LIMIT 1`,
      [customerId, s.id]
    );
    const { rows: history } = await query(
      `SELECT rm.id, m.name AS grade_name, rm.rate_per_m3, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to,
              rm.source, q.quote_no
         FROM rate_master rm JOIN mix_grades m ON m.id = rm.mix_grade_id LEFT JOIN quotations q ON q.id = rm.quotation_id
        WHERE rm.customer_id = $1 AND (rm.site_id = $2 OR rm.site_id IS NULL)
          AND rm.effective_to IS NOT NULL AND rm.effective_to < CURRENT_DATE AND rm.effective_to >= rm.effective_from
        ORDER BY rm.effective_to DESC LIMIT 30`,
      [customerId, s.id]
    );
    out.push({
      site: s,
      rates: live.map((r) => ({
        id: r.id, mix_grade_id: r.mix_grade_id, grade_name: r.grade_name, rate_per_m3: r.rate_per_m3,
        site_specific: r.site_id != null, source: r.source, quote_no: r.quote_no,
        effective_from: r.effective_from, committed_qty_m3: r.committed_qty_m3, rebate_per_m3: r.rebate_per_m3,
        supplied_m3: suppliedBy[r.mix_grade_id] || 0,
        charges: {
          line_pump_charge: r.line_pump_charge ?? r.pumping_charge_lumpsum, line_pump_min_qty_m3: r.line_pump_min_qty_m3,
          boom_pump_charge: r.boom_pump_charge, boom_pump_min_qty_m3: r.boom_pump_min_qty_m3, boom_rate_above_per_m3: r.boom_rate_above_per_m3,
          part_load_min_qty_m3: r.part_load_min_qty_m3, part_load_charge_per_m3: r.part_load_charge_per_m3,
          waiting_charge_per_hour: r.waiting_charge_per_hour,
        },
      })),
      pending: pending[0] || null,
      history,
    });
  }
  res.json({
    customer: cust.rows[0], grades: grades.rows, sites: out, has_customer_wide_rates: wide.length > 0,
    credit: credit.rows[0] || null, outstanding: Number(outstanding.rows[0].balance) || 0,
  });
});

// ---------------------------------------------------------------------------
// Settings and the terms library — Administrator edits, Manager may look.
// ---------------------------------------------------------------------------
const SET_VIEW = requirePermission("accounts.quotation-settings", "view");
const SET_EDIT = requirePermission("accounts.quotation-settings", "edit");

router.get("/settings", SET_VIEW, async (req, res) => {
  const s = await settings();
  const { rows: lib } = await query(
    `SELECT l.agreement_type, l.version, l.updated_at, u.name AS updated_by_name FROM quotation_term_library l
       LEFT JOIN users u ON u.id = l.updated_by ORDER BY l.agreement_type`
  );
  res.json({ settings: s, library: lib, agreement_types: AGREEMENT_TYPES });
});

router.put("/settings", SET_EDIT, async (req, res) => {
  const b = req.body || {};
  const serial = Number(b.next_serial);
  if (!(serial > 0)) return res.status(400).json({ error: "The next quotation number must be a positive number." });
  const sig = b.signature_image === null ? null : (typeof b.signature_image === "string" && b.signature_image.startsWith("data:image/") ? b.signature_image : undefined);
  if (sig && sig.length > 1_500_000) return res.status(400).json({ error: "The signature image is too large — use one under 1 MB." });
  await query(
    `UPDATE quotation_settings SET next_serial = $1, validity_days = $2, director_name = $3, director_title = $4, director_phone = $5,
            defaults = $6, bank_accounts = $7,
            signature_image = CASE WHEN $8 THEN $9 ELSE signature_image END,
            updated_by = $10, updated_at = now()
      WHERE id = 1`,
    [serial, Math.max(1, Number(b.validity_days) || 7), String(b.director_name || "").slice(0, 100),
     String(b.director_title || "Director").slice(0, 60), String(b.director_phone || "").slice(0, 40),
     JSON.stringify(b.defaults || {}), JSON.stringify(Array.isArray(b.bank_accounts) ? b.bank_accounts : []),
     sig !== undefined, sig ?? null, req.user.id]
  );
  res.json({ ok: true });
});

router.get("/terms/:type", SET_VIEW, async (req, res) => {
  if (!TYPES.has(req.params.type)) return res.status(404).json({ error: "Unknown agreement type." });
  const terms = await libraryTerms(req.params.type);
  res.json({ terms, default_terms: DEFAULT_TERMS[req.params.type] });
});

router.put("/terms/:type", SET_EDIT, async (req, res) => {
  if (!TYPES.has(req.params.type)) return res.status(404).json({ error: "Unknown agreement type." });
  const t = req.body.terms;
  if (!t || !Array.isArray(t.sections)) return res.status(400).json({ error: "The terms are not in the expected shape." });
  await query(
    `INSERT INTO quotation_term_library (agreement_type, terms, version, updated_by, updated_at)
     VALUES ($1, $2, 1, $3, now())
     ON CONFLICT (agreement_type) DO UPDATE SET terms = $2, version = quotation_term_library.version + 1, updated_by = $3, updated_at = now()`,
    [req.params.type, JSON.stringify(t), req.user.id]
  );
  res.json({ ok: true });
});

export default router;
