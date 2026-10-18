// Round 134, items 1-2 — Loader Operator's own routes. Kept as a separate
// small router (not folded into driver.js) since driver.js is locked
// router-wide to requireRole("driver") and is built entirely around a
// truck + delivery-ticket "trip" concept a loader operator doesn't have.
// Reuses the same breakdown_reports/external_repairs tables the truck
// driver flow writes into (see routes/driver.js and routes/breakdowns.js),
// via the new 'equipment' bucket / equipment_id column added this round —
// so Manager's existing Breakdowns and External Repairs screens show these
// alongside truck ones with no separate review flow to build.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole } from "../lib/push.js";
import { BREAKDOWN_ISSUE_LABELS } from "../lib/breakdownIssueTypes.js";
import { raiseJobSafe } from "../lib/maintenanceJobs.js";
import { OUTSIDE_REQUESTS_SQL } from "./driver.js";

const router = Router();
router.use(requireAuth, requireRole("loader_operator"));

router.post("/breakdown", async (req, res) => {
  const { equipment_id, issue_type, remarks } = req.body;
  if (!equipment_id) return res.status(400).json({ error: "Select which loader this is." });
  if (!issue_type) return res.status(400).json({ error: "Select what happened." });
  if (issue_type === "other" && !remarks) return res.status(400).json({ error: "Add a short description." });
  const { rows: br } = await query(
    `INSERT INTO breakdown_reports (equipment_type, equipment_id, driver_id, reported_by, issue_type, remarks)
     VALUES ('equipment', $1,$2,$2,$3,$4) RETURNING id`,
    [equipment_id, req.user.id, issue_type, remarks || null]
  );
  const { rows } = await query("SELECT name FROM equipment WHERE id = $1", [equipment_id]);
  const label = rows[0]?.name || "A loader";
  const issueLabel = BREAKDOWN_ISSUE_LABELS[issue_type] || issue_type;
  // Round 216 — also onto the loader's job card in the Maintenance module.
  const job = await raiseJobSafe({ equipment_id }, {
    description: `Breakdown — ${issueLabel}${remarks ? `: ${remarks}` : ""}`, origin: "complaint", kind: "inside",
    urgency: "breakdown", machine_stopped: true, source_type: "breakdown", source_id: br[0].id,
  }, req.user, { source: "breakdown" });
  if (job) await query(`UPDATE breakdown_reports SET moved_to_card = $1 WHERE id = $2`, [job.job_card_id, br[0].id]);
  await query(
    `INSERT INTO notifications (recipient_role, type, message)
     VALUES ('manager', 'breakdown_reported', $1)`,
    [`Breakdown reported: ${label} — ${issueLabel}`]
  );
  await pushToRole("manager", {
    title: "Loader breakdown reported",
    body: `${label} — ${issueLabel}`,
    url: "/manager",
  });
  res.json({ ok: true });
});

// Mirrors /driver/external-repair (driver.js) — Manager approves/rejects,
// then logs sent-out/returned on the same Maintenance screen, unchanged.
router.post("/external-repair", async (req, res) => {
  const { equipment_id, issue_description } = req.body;
  if (!equipment_id || !issue_description) {
    return res.status(400).json({ error: "Loader and a description of the issue are required." });
  }
  // Round 216 — an Outside job on the loader's job card in the Maintenance module.
  const job = await raiseJobSafe({ equipment_id }, {
    description: issue_description, origin: "complaint", kind: "outside", source_type: "driver_request",
  }, req.user, { notifyManager: true });
  if (job) return res.status(201).json({ id: job.job_id, status: "requested", job_card: job.code });
  const { rows } = await query(
    `INSERT INTO external_repairs (equipment_id, requested_by, issue_description)
     VALUES ($1,$2,$3) RETURNING *`,
    [equipment_id, req.user.id, issue_description]
  );
  const { rows: eqRows } = await query("SELECT name FROM equipment WHERE id = $1", [equipment_id]);
  const label = eqRows[0]?.name || "A loader";
  await query(
    `INSERT INTO notifications (recipient_role, type, message)
     VALUES ('manager', 'external_repair_requested', $1)`,
    [`External repair requested: ${label} — ${issue_description}`]
  );
  await pushToRole("manager", {
    title: "External repair requested",
    body: `${label} — ${issue_description}`,
    url: "/manager",
  });
  res.status(201).json(rows[0]);
});

// Loader Operator's own request history, same shape/purpose as
// /driver/external-repair GET.
router.get("/external-repair", async (req, res) => {
  const { rows } = await query(
    `SELECT er.id, er.status, er.issue_description, er.requested_at, er.workshop_name,
            er.sent_out_at, er.returned_at, er.rejection_reason, eq.name AS equipment_name
     FROM external_repairs er
     JOIN equipment eq ON eq.id = er.equipment_id
     WHERE er.requested_by = $1 AND er.moved_to_card IS NULL
     ORDER BY er.requested_at DESC LIMIT 20`,
    [req.user.id]
  );
  const mnt = await query(OUTSIDE_REQUESTS_SQL, [req.user.id]);
  res.json([...rows, ...mnt.rows].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at)).slice(0, 20));
});

export default router;
