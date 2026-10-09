// Round 194 — raw material lab tests: the Lab Technician's cards, the
// Administrator's approval, the filed register, and the per-material test
// plans. Mounted at /api/rm-tests. See lib/rmTestCards.js for how cards are
// issued from a GRN, and lib/rmTestDefs.js for every test's calculation.
//
// WHO DOES WHAT (user's decision, 8 Oct 2026):
//   Lab Technician   enters readings and submits        quality.rm-tests (create/edit)
//   Administrator    approves or sends back             quality.rm-test-approve (edit)
//   everyone else    reads, if a Super Admin allows it  quality.rm-test-register (view)
// The Administrator who approves is the person whose name prints as
// "Approved by" on the report — it is read from the approving account at the
// moment of approval (approved_by), never typed.
//
// THE SERVER DECIDES THE RESULT. Every save recomputes the result from the raw
// readings with the same lib/rmTestDefs.js the screen uses, and stores the
// server's answer. A submitted or approved card cannot be edited; it has to be
// sent back first, which is recorded.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, requireAnyPermission } from "../lib/permissions.js";
import { pushToRole, pushToUser } from "../lib/push.js";
import { TEST_DEFS, computeTest, rowsFor, defaultParams, testLabel, VERDICT_LABEL, STANDARD_PLANS } from "../lib/rmTestDefs.js";
import { ensureScheduledCards, loadStandardPlan, standardKindFor, companionFor } from "../lib/rmTestCards.js";

const router = Router();
const READ_KEYS = ["quality.rm-tests", "quality.rm-test-register", "quality.rm-test-plans"];
router.use(requireAuth);

const CARD_SELECT = `
  SELECT c.id, c.plan_id, c.test_code, c.params, c.form_no, c.material_id, c.supplier_id, c.receipt_id,
         c.source, c.reason, c.rate, c.vehicle_number, to_char(c.received_date, 'YYYY-MM-DD') AS received_date,
         c.hold_stock, c.due_at, c.status, c.readings, c.result, c.verdict, c.summary,
         c.sampled_by, c.sampled_at, to_char(c.tested_on, 'YYYY-MM-DD') AS tested_on, c.equipment, c.remarks,
         c.started_at, c.updated_at, c.submitted_at, c.approved_at, c.sent_back_at, c.sent_back_reason,
         c.closed_at, c.closed_reason, c.created_at,
         'RMT/' || to_char(c.created_at, 'YYMM') || '/' || lpad(c.id::text, 4, '0') AS report_no,
         (c.status IN ('pending', 'in_progress') AND c.due_at < now()) AS overdue,
         COALESCE(m.name, 'Laboratory') AS material_name, s.name AS supplier_name,
         r.challan_number, r.accepted_qty, m.purchase_unit,
         su.name AS submitted_by_name, au.name AS approved_by_name, au.role::text AS approved_by_role,
         bu.name AS sent_back_by_name, cu.name AS closed_by_name, stu.name AS started_by_name
    FROM rm_test_cards c
    LEFT JOIN rm_materials m ON m.id = c.material_id
    LEFT JOIN rm_suppliers s ON s.id = c.supplier_id
    LEFT JOIN rm_receipts r ON r.id = c.receipt_id   -- receipts-raw: the card shows its own GRN whatever its confirmation state
    LEFT JOIN users su ON su.id = c.submitted_by
    LEFT JOIN users au ON au.id = c.approved_by
    LEFT JOIN users bu ON bu.id = c.sent_back_by
    LEFT JOIN users cu ON cu.id = c.closed_by
    LEFT JOIN users stu ON stu.id = c.started_by`;

// Round 196 — the laboratory's own checks (curing tank) have no material.
// The API names that "lab"; in the database it is material_id NULL.
const LAB = "lab";
function materialRef(v) {
  if (v === LAB) return { lab: true, id: null };
  const id = positiveInt(v);
  return id ? { lab: false, id } : null;
}

// The partner result a test's limit depends on (flakiness <-> elongation).
async function ctxFor(card) {
  return { companion: await companionFor({ query }, card) };
}

function positiveInt(v) {
  const x = Number(v);
  return Number.isInteger(x) && x > 0 ? x : null;
}

function withLabel(card) {
  return { ...card, test_label: testLabel(card.test_code, card.params), verdict_label: VERDICT_LABEL[card.verdict] || null };
}

async function loadCard(id) {
  const { rows } = await query(`${CARD_SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? withLabel(rows[0]) : null;
}

// Keep only the readings this test actually has, as short strings. The
// readings come from a browser; anything else in them is dropped rather than
// stored.
function cleanReadings(code, params, raw) {
  const def = TEST_DEFS[code];
  const out = { head: {}, grid: {} };
  const src = raw && typeof raw === "object" ? raw : {};
  const val = (v) => (v === null || v === undefined ? "" : String(v).slice(0, 60));
  for (const f of def.head || []) {
    if (src.head && src.head[f.key] !== undefined) out.head[f.key] = val(src.head[f.key]);
  }
  const inputs = (def.fields || []).filter((f) => f.input).map((f) => f.key);
  for (const r of rowsFor(code, params)) {
    const row = src.grid && src.grid[r.key];
    if (!row || typeof row !== "object") continue;
    const o = {};
    for (const k of inputs) if (row[k] !== undefined) o[k] = val(row[k]);
    if (Object.keys(o).length) out.grid[r.key] = o;
  }
  return out;
}

function cleanMeta(body) {
  const s = (v, n) => (v === undefined ? undefined : v === null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
  const meta = {
    sampled_by: s(body.sampled_by, 80),
    equipment: s(body.equipment, 500),
    remarks: s(body.remarks, 1000),
    tested_on: s(body.tested_on, 10),
    sampled_at: s(body.sampled_at, 40),
  };
  if (meta.tested_on && !/^\d{4}-\d{2}-\d{2}$/.test(meta.tested_on)) return { error: "Date of testing must be a date." };
  if (meta.sampled_at && Number.isNaN(Date.parse(meta.sampled_at))) return { error: "Sampling date/time is not valid." };
  return { meta };
}

// Writes readings + meta and the server's own calculation. Returns the result.
async function saveWork(card, body, userId) {
  const { meta, error } = cleanMeta(body);
  if (error) return { error };
  const readings = body.readings !== undefined ? cleanReadings(card.test_code, card.params, body.readings) : card.readings;
  const result = computeTest(card.test_code, readings, card.params, await ctxFor(card));
  const complete = !result.errors.length && result.verdict;
  await query(
    `UPDATE rm_test_cards SET
       readings = $2::jsonb, result = $3::jsonb, verdict = $4, summary = $5,
       sampled_by = COALESCE($6, CASE WHEN $11 THEN NULL ELSE sampled_by END),
       equipment  = COALESCE($7, CASE WHEN $12 THEN NULL ELSE equipment END),
       remarks    = COALESCE($8, CASE WHEN $13 THEN NULL ELSE remarks END),
       tested_on  = COALESCE($9::date, tested_on, CURRENT_DATE),
       sampled_at = COALESCE($10::timestamptz, sampled_at),
       status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
       started_by = COALESCE(started_by, $14), started_at = COALESCE(started_at, now()),
       updated_by = $14, updated_at = now()
     WHERE id = $1`,
    [card.id, JSON.stringify(readings), JSON.stringify(result), complete ? result.verdict : null,
      complete ? result.summary : null,
      meta.sampled_by ?? null, meta.equipment ?? null, meta.remarks ?? null, meta.tested_on ?? null, meta.sampled_at ?? null,
      meta.sampled_by === null, meta.equipment === null, meta.remarks === null, userId]
  );
  return { result };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
router.get("/summary", requireAnyPermission(READ_KEYS, "view"), async (req, res) => {
  await ensureScheduledCards();
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress'))::int AS todo,
            COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress') AND due_at < now())::int AS overdue,
            COUNT(*) FILTER (WHERE status = 'submitted')::int AS approval,
            COUNT(*) FILTER (WHERE status = 'approved' AND verdict = 'non_conforming' AND approved_at > now() - interval '30 days')::int AS nonconforming_30d,
            COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress') AND hold_stock)::int AS on_hold
       FROM rm_test_cards`
  );
  res.json(rows[0]);
});

router.get("/meta", requireAnyPermission(READ_KEYS, "view"), async (req, res) => {
  const [mats, sups] = await Promise.all([
    query(
      `SELECT m.id, m.name, m.mix_component, m.is_active,
              COUNT(p.id) FILTER (WHERE p.is_active AND p.trigger <> 'off')::int AS active_tests
         FROM rm_materials m LEFT JOIN rm_test_plans p ON p.material_id = m.id
        GROUP BY m.id ORDER BY m.is_active DESC, m.name`
    ),
    query(`SELECT id, name, is_active FROM rm_suppliers ORDER BY is_active DESC, name`),
  ]);
  const { rows: lab } = await query(
    `SELECT COUNT(*) FILTER (WHERE is_active AND trigger <> 'off')::int AS n FROM rm_test_plans WHERE material_id IS NULL`
  );
  res.json({
    // The laboratory's own checks first, as a pseudo-material ("lab").
    materials: [
      { id: LAB, name: "Laboratory (not a material)", is_active: true, active_tests: lab[0].n, standard_kind: "lab", lab: true },
      ...mats.rows.map((m) => ({ ...m, standard_kind: standardKindFor(m) })),
    ],
    suppliers: sups.rows,
  });
});

router.get("/cards", requireAnyPermission(READ_KEYS, "view"), async (req, res) => {
  const bucket = String(req.query.bucket || "todo");
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", "$" + params.length)); };
  let order = "c.id DESC";
  if (bucket === "todo") {
    await ensureScheduledCards();
    where.push(`c.status IN ('pending', 'in_progress')`);
    order = "c.due_at ASC NULLS LAST, c.id";
  } else if (bucket === "approval") {
    where.push(`c.status = 'submitted'`);
    order = "c.submitted_at ASC";
  } else if (bucket === "done") {
    where.push(`c.status = 'approved'`);
    order = "c.approved_at DESC";
  } else if (bucket === "closed") {
    where.push(`c.status = 'closed'`);
    order = "c.closed_at DESC";
  } else {
    return res.status(400).json({ error: "Unknown list." });
  }
  if (positiveInt(req.query.material_id)) add("c.material_id = ?", positiveInt(req.query.material_id));
  if (positiveInt(req.query.supplier_id)) add("c.supplier_id = ?", positiveInt(req.query.supplier_id));
  if (req.query.test_code && TEST_DEFS[req.query.test_code]) add("c.test_code = ?", String(req.query.test_code));
  if (["conforms", "non_conforming", "recorded"].includes(req.query.verdict)) add("c.verdict = ?", req.query.verdict);
  const dateCol = bucket === "done" ? "COALESCE(c.tested_on, c.approved_at::date)" : "c.created_at::date";
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "")) add(`${dateCol} >= ?::date`, req.query.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "")) add(`${dateCol} <= ?::date`, req.query.to);
  const limit = Math.min(positiveInt(req.query.limit) || 300, 1000);
  const { rows } = await query(
    `${CARD_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ${limit}`,
    params
  );
  res.json(rows.map(withLabel));
});

router.get("/cards/:id", requireAnyPermission(READ_KEYS, "view"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const card = id && (await loadCard(id));
  if (!card) return res.status(404).json({ error: "Test card not found." });
  // The last few approved results of the same test, material and supplier —
  // the comparison IS 4926 Annex B asks for ("last 4 results").
  const { rows: history } = await query(
    `SELECT c.id, 'RMT/' || to_char(c.created_at, 'YYMM') || '/' || lpad(c.id::text, 4, '0') AS report_no,
            to_char(COALESCE(c.tested_on, c.approved_at::date), 'YYYY-MM-DD') AS tested_on, c.verdict, c.summary
       FROM rm_test_cards c
      WHERE c.status = 'approved' AND c.id <> $1 AND c.test_code = $2 AND c.material_id IS NOT DISTINCT FROM $3
        AND c.supplier_id IS NOT DISTINCT FROM $4 AND COALESCE(c.params->>'name', '') = $5
      ORDER BY c.approved_at DESC LIMIT 4`,
    [card.id, card.test_code, card.material_id, card.supplier_id, (card.params && card.params.name) || ""]
  );
  res.json({ ...card, history, companion: await companionFor({ query }, card) });
});

// ---------------------------------------------------------------------------
// The Lab Technician's work
// ---------------------------------------------------------------------------
router.post("/cards", requirePermission("quality.rm-tests", "create"), async (req, res) => {
  const ref = materialRef(req.body.material_id);
  const supplierId = req.body.supplier_id ? positiveInt(req.body.supplier_id) : null;
  const code = String(req.body.test_code || "");
  if (!ref) return res.status(400).json({ error: "Choose the material." });
  if (!TEST_DEFS[code] || TEST_DEFS[code].retired) return res.status(400).json({ error: "Choose the test." });
  if (ref.lab !== TEST_DEFS[code].kinds.includes("lab") && code !== "external") {
    return res.status(400).json({ error: ref.lab ? "That test is for a material, not the laboratory." : "That test is a laboratory check, not a material test." });
  }
  if (req.body.supplier_id && !supplierId) return res.status(400).json({ error: "Invalid supplier." });
  const materialId = ref.id;
  if (!ref.lab) {
    const { rows: mat } = await query(`SELECT id FROM rm_materials WHERE id = $1`, [materialId]);
    if (!mat.length) return res.status(404).json({ error: "Material not found." });
  }
  // Use the material's own plan settings for this test where there is one.
  const { rows: plan } = await query(
    `SELECT id, params, form_no, hold_stock, due_hours FROM rm_test_plans
      WHERE material_id IS NOT DISTINCT FROM $1 AND test_code = $2 AND is_active ORDER BY sort_order, id LIMIT 1`,
    [materialId, code]
  );
  const p = plan[0];
  const params = code === "external"
    ? { ...defaultParams(code), name: String(req.body.name || "").trim().slice(0, 80) || defaultParams(code).name }
    : (p ? p.params : defaultParams(code));
  const { rows } = await query(
    `INSERT INTO rm_test_cards (plan_id, test_code, params, form_no, material_id, supplier_id, source, reason, due_at, hold_stock, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'manual', $7, now() + make_interval(hours => $8), $9, $10)
     RETURNING id`,
    [code === "external" ? null : p ? p.id : null, code, JSON.stringify(params),
      p ? p.form_no : TEST_DEFS[code].form, materialId, supplierId,
      String(req.body.reason || "").trim().slice(0, 200) || "Added by hand",
      p ? p.due_hours : 24, p ? p.hold_stock : false, req.user.id]
  );
  res.status(201).json(await loadCard(rows[0].id));
});

router.put("/cards/:id", requirePermission("quality.rm-tests", "edit"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const card = id && (await loadCard(id));
  if (!card) return res.status(404).json({ error: "Test card not found." });
  if (!["pending", "in_progress"].includes(card.status)) {
    return res.status(409).json({ error: card.status === "submitted" ? "This test is waiting for approval and can't be changed. Ask the Administrator to send it back." : "This test is closed for editing." });
  }
  const out = await saveWork(card, req.body, req.user.id);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(await loadCard(id));
});

router.post("/cards/:id/submit", requirePermission("quality.rm-tests", "edit"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const card = id && (await loadCard(id));
  if (!card) return res.status(404).json({ error: "Test card not found." });
  if (!["pending", "in_progress"].includes(card.status)) return res.status(409).json({ error: "This test has already been submitted." });
  const out = await saveWork(card, req.body, req.user.id);
  if (out.error) return res.status(400).json({ error: out.error });
  if (out.result.errors.length || !out.result.verdict) {
    return res.status(400).json({ error: out.result.errors[0] || "The test is not complete yet.", errors: out.result.errors });
  }
  await query(
    `UPDATE rm_test_cards SET status = 'submitted', submitted_by = $2, submitted_at = now() WHERE id = $1 AND status IN ('pending', 'in_progress')`,
    [id, req.user.id]
  );
  const fresh = await loadCard(id);
  const msg = `${fresh.test_label} — ${fresh.material_name}${fresh.supplier_name ? " from " + fresh.supplier_name : ""}: ${fresh.summary}`;
  try {
    await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ('administrator', 'rm_test_submitted', $1)`, [`Lab test to approve — ${msg}`]);
    await pushToRole("administrator", { title: "Lab test to approve", body: msg, url: "/rm-tests?tab=approval" });
  } catch (e) {
    console.error("rm test submit notification failed:", e.message);
  }
  res.json(fresh);
});

router.post("/cards/:id/close", requirePermission("quality.rm-tests", "edit"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const reason = String(req.body.reason || "").trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: "Say why this test is not being done." });
  const { rowCount } = await query(
    `UPDATE rm_test_cards SET status = 'closed', closed_by = $2, closed_at = now(), closed_reason = $3
      WHERE id = $1 AND status IN ('pending', 'in_progress')`,
    [id, req.user.id, reason]
  );
  if (!rowCount) return res.status(409).json({ error: "Only a test that has not been submitted can be closed." });
  res.json(await loadCard(id));
});

// ---------------------------------------------------------------------------
// The Administrator's approval
// ---------------------------------------------------------------------------
router.post("/cards/:id/approve", requirePermission("quality.rm-test-approve", "edit"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const card = id && (await loadCard(id));
  if (!card) return res.status(404).json({ error: "Test card not found." });
  if (card.status !== "submitted") return res.status(409).json({ error: "Only a submitted test can be approved." });
  // Recompute once more from the stored readings, so what is signed is what
  // the calculation says today — not whatever was cached at submission.
  const result = computeTest(card.test_code, card.readings, card.params, await ctxFor(card));
  if (result.errors.length || !result.verdict) return res.status(400).json({ error: result.errors[0] || "The test is incomplete." });
  const remark = String(req.body.remark || "").trim().slice(0, 1000);
  const { rowCount } = await query(
    `UPDATE rm_test_cards SET status = 'approved', approved_by = $2, approved_at = now(),
            result = $3::jsonb, verdict = $4, summary = $5,
            remarks = CASE WHEN $6 = '' THEN remarks ELSE COALESCE(remarks || E'\n', '') || $6 END
      WHERE id = $1 AND status = 'submitted'`,
    [id, req.user.id, JSON.stringify(result), result.verdict, result.summary, remark]
  );
  if (!rowCount) return res.status(409).json({ error: "Someone else has just changed this test — reload it." });
  const fresh = await loadCard(id);
  if (fresh.verdict === "non_conforming") {
    const msg = `${fresh.test_label} — ${fresh.material_name}${fresh.supplier_name ? " from " + fresh.supplier_name : ""}` +
      `${fresh.vehicle_number ? " (" + fresh.vehicle_number + ")" : ""} does not conform: ${fresh.summary}. Approved by ${fresh.approved_by_name}.`;
    try {
      for (const role of ["manager", "store", "administrator"]) {
        await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ($1, 'rm_test_failed', $2)`, [role, msg]);
        await pushToRole(role, { title: "Material test failed", body: msg, url: "/rm-tests?tab=done" });
      }
    } catch (e) {
      console.error("rm test fail notification failed:", e.message);
    }
  }
  res.json(fresh);
});

router.post("/cards/:id/send-back", requirePermission("quality.rm-test-approve", "edit"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const reason = String(req.body.reason || "").trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: "Say what needs correcting." });
  const { rows } = await query(
    `UPDATE rm_test_cards SET status = 'in_progress', sent_back_by = $2, sent_back_at = now(), sent_back_reason = $3
      WHERE id = $1 AND status = 'submitted' RETURNING submitted_by`,
    [id, req.user.id, reason]
  );
  if (!rows.length) return res.status(409).json({ error: "Only a submitted test can be sent back." });
  const fresh = await loadCard(id);
  try {
    await pushToUser(rows[0].submitted_by, { title: "Lab test sent back", body: `${fresh.test_label} — ${fresh.material_name}: ${reason}`, url: `/rm-tests?card=${id}` });
  } catch (e) {
    console.error("rm test send-back notification failed:", e.message);
  }
  res.json(fresh);
});

// Withdraw an approval (a wrong figure noticed after signing). The card goes
// back to "waiting for approval"; the approval it had is not kept, so the
// report can never show a signature for figures that later changed.
router.post("/cards/:id/withdraw-approval", requirePermission("quality.rm-test-approve", "edit"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const reason = String(req.body.reason || "").trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: "Say why the approval is being withdrawn." });
  const { rowCount } = await query(
    `UPDATE rm_test_cards SET status = 'submitted', approved_by = NULL, approved_at = NULL,
            remarks = COALESCE(remarks || E'\n', '') || $2
      WHERE id = $1 AND status = 'approved'`,
    [id, `Approval withdrawn by ${req.user.name || "Administrator"}: ${reason}`]
  );
  if (!rowCount) return res.status(409).json({ error: "Only an approved test can be withdrawn." });
  res.json(await loadCard(id));
});

// ---------------------------------------------------------------------------
// Test plans (Administrator)
// ---------------------------------------------------------------------------
const TRIGGERS = ["every_grn", "period", "scheduled", "off"];

function cleanPlan(body, existing) {
  const code = body.test_code !== undefined ? String(body.test_code) : existing && existing.test_code;
  const def = TEST_DEFS[code];
  if (!def) return { error: "Choose a test." };
  if (def.retired && !existing) return { error: "That test has been replaced — choose one of the current tests." };
  const params = { ...defaultParams(code), ...((existing && existing.params) || {}) };
  if (body.params && typeof body.params === "object") {
    for (const p of def.params || []) {
      if (body.params[p.key] === undefined) continue;
      const v = String(body.params[p.key]).trim().slice(0, 120);
      if (!p.free && !p.options.some(([o]) => String(o) === v)) return { error: `"${v}" is not an option for ${p.label}.` };
      params[p.key] = v;
    }
  }
  const out = { test_code: code, params };
  const intOrNull = (v, label) => {
    if (v === null || v === "" || v === undefined) return null;
    const x = Number(v);
    if (!Number.isInteger(x) || x <= 0) throw new Error(`${label} must be a whole number above 0.`);
    return x;
  };
  try {
    if (body.trigger !== undefined) {
      if (!TRIGGERS.includes(body.trigger)) return { error: "Choose when the card is issued." };
      out.trigger = body.trigger;
    }
    if (body.high_days !== undefined) out.high_days = intOrNull(body.high_days, "Period");
    if (body.low_days !== undefined) out.low_days = intOrNull(body.low_days, "Low-rate period");
    if (body.low_after !== undefined) out.low_after = intOrNull(body.low_after, "Results before low rate");
    if (body.due_hours !== undefined) out.due_hours = intOrNull(body.due_hours, "Due within") || 24;
  } catch (e) {
    return { error: e.message };
  }
  if (body.hold_stock !== undefined) out.hold_stock = !!body.hold_stock;
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  if (body.form_no !== undefined) out.form_no = String(body.form_no || "").trim().slice(0, 30) || null;
  const trig = out.trigger || (existing && existing.trigger) || "period";
  const high = out.high_days !== undefined ? out.high_days : existing && existing.high_days;
  if ((trig === "period" || trig === "scheduled") && !high) return { error: "Set how often the test is due." };
  const low = out.low_days !== undefined ? out.low_days : existing && existing.low_days;
  const after = out.low_after !== undefined ? out.low_after : existing && existing.low_after;
  if (!!low !== !!after) return { error: "A low rate needs both its period and how many results in tolerance switch to it." };
  return { plan: out };
}

router.get("/plans", requirePermission("quality.rm-test-plans", "view"), async (req, res) => {
  const ref = req.query.material_id ? materialRef(req.query.material_id) : null;
  const where = !ref ? "" : ref.lab ? "WHERE p.material_id IS NULL" : "WHERE p.material_id = $1";
  const { rows } = await query(
    `SELECT p.*, COALESCE(m.name, 'Laboratory (not a material)') AS material_name
       FROM rm_test_plans p LEFT JOIN rm_materials m ON m.id = p.material_id
      ${where} ORDER BY m.name NULLS FIRST, p.sort_order, p.id`,
    ref && !ref.lab ? [ref.id] : []
  );
  res.json(rows.map((p) => ({ ...p, test_label: testLabel(p.test_code, p.params) })));
});

router.post("/plans", requirePermission("quality.rm-test-plans", "create"), async (req, res) => {
  const ref = materialRef(req.body.material_id);
  if (!ref) return res.status(400).json({ error: "Choose the material." });
  const materialId = ref.id;
  const { plan, error } = cleanPlan({ trigger: ref.lab ? "scheduled" : "period", high_days: ref.lab ? 1 : 30, due_hours: 24, ...req.body });
  if (error) return res.status(400).json({ error });
  const isLabTest = TEST_DEFS[plan.test_code].kinds.includes("lab");
  if (plan.test_code !== "external" && ref.lab !== isLabTest) {
    return res.status(400).json({ error: ref.lab ? "That test is for a material, not the laboratory." : "That test is a laboratory check, not a material test." });
  }
  if (ref.lab && (plan.trigger || "scheduled") !== "scheduled" && plan.trigger !== "off") {
    return res.status(400).json({ error: "A laboratory check has no GRN — it can only be scheduled." });
  }
  const { rows } = await query(
    `INSERT INTO rm_test_plans (material_id, test_code, params, form_no, trigger, high_days, low_days, low_after, hold_stock, due_hours, sort_order, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10,
             (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM rm_test_plans WHERE material_id IS NOT DISTINCT FROM $1::int), $11)
     RETURNING *`,
    [materialId, plan.test_code, JSON.stringify(plan.params), plan.form_no ?? TEST_DEFS[plan.test_code].form ?? null,
      plan.trigger, plan.high_days ?? null, plan.low_days ?? null, plan.low_after ?? null, !!plan.hold_stock, plan.due_hours || 24, req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.patch("/plans/:id", requirePermission("quality.rm-test-plans", "edit"), async (req, res) => {
  const id = positiveInt(req.params.id);
  const { rows: cur } = await query(`SELECT * FROM rm_test_plans WHERE id = $1`, [id]);
  if (!cur.length) return res.status(404).json({ error: "Plan not found." });
  if (req.body.test_code !== undefined && req.body.test_code !== cur[0].test_code) return res.status(400).json({ error: "A plan's test can't be changed — add a new one instead." });
  const { plan, error } = cleanPlan(req.body, cur[0]);
  if (error) return res.status(400).json({ error });
  const merged = { ...cur[0], ...plan };
  const { rows } = await query(
    `UPDATE rm_test_plans SET params = $2::jsonb, form_no = $3, trigger = $4, high_days = $5, low_days = $6, low_after = $7,
            hold_stock = $8, due_hours = $9, is_active = $10, updated_by = $11, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(merged.params), merged.form_no, merged.trigger, merged.high_days, merged.low_days, merged.low_after,
      merged.hold_stock, merged.due_hours, merged.is_active, req.user.id]
  );
  res.json(rows[0]);
});

router.delete("/plans/:id", requirePermission("quality.rm-test-plans", "delete"), async (req, res) => {
  // Cards already issued keep their own copy of the test and its settings
  // (plan_id is ON DELETE SET NULL), so removing a plan never touches a
  // result already filed.
  const { rowCount } = await query(`DELETE FROM rm_test_plans WHERE id = $1`, [positiveInt(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: "Plan not found." });
  res.json({ ok: true });
});

router.post("/plans/load-standard", requirePermission("quality.rm-test-plans", "create"), async (req, res) => {
  if (req.body.material_id === LAB) {
    let added = 0;
    for (const p of STANDARD_PLANS.lab) {
      const r = await query(
        `INSERT INTO rm_test_plans (material_id, test_code, params, trigger, high_days, due_hours, created_by)
         SELECT NULL, $1::varchar, '{}'::jsonb, $2, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM rm_test_plans WHERE material_id IS NULL AND test_code = $1::varchar)`,
        [p.test_code, p.trigger, p.high_days, p.due_hours, req.user.id]
      );
      added += r.rowCount;
    }
    return res.json({ kind: "lab", added });
  }
  const materialId = positiveInt(req.body.material_id);
  const { rows } = await query(`SELECT id, name, mix_component FROM rm_materials WHERE id = $1`, [materialId]);
  if (!rows.length) return res.status(404).json({ error: "Material not found." });
  const r = await loadStandardPlan({ query }, rows[0], req.user.id);
  if (!r.kind) return res.status(400).json({ error: "There is no standard plan for this material. Set the material's mix component in Materials, or add the tests by hand." });
  res.json(r);
});

export default router;
