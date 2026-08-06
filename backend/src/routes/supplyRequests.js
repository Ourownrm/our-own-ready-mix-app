import { Router } from "express";
import crypto from "crypto";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole, pushToUser } from "../lib/push.js";

const router = Router();
router.use(requireAuth);

const REQUESTER_ROLES = ["driver", "site_supervisor", "plant_operator", "manager", "administrator"];

// A driver or machine operator requests fuel or a lubricant. Odometer/hour
// meter reading is required — this is the field the old self-logged flow
// captured that matters most for later efficiency analysis, so it's kept
// mandatory here even though nothing else about the old flow survives.
router.post("/", requireRole(...REQUESTER_ROLES), async (req, res) => {
  const {
    request_type, equipment_type, truck_id, pump_id, equipment_id,
    odometer_reading, hour_meter_reading, requested_quantity,
    fuel_station_id, lubricant_type_id,
  } = req.body;

  if (!["fuel", "lubricant"].includes(request_type)) return res.status(400).json({ error: "Select fuel or lubricant." });
  if (!equipment_type) return res.status(400).json({ error: "Select which vehicle or machine this is for." });
  if (equipment_type === "truck" && !truck_id) return res.status(400).json({ error: "Select which truck." });
  if (equipment_type === "pump" && !pump_id) return res.status(400).json({ error: "Select which pump." });
  if (["pickup_van", "loader", "generator"].includes(equipment_type) && !equipment_id) {
    return res.status(400).json({ error: "Select which unit." });
  }
  if (!odometer_reading && !hour_meter_reading) {
    return res.status(400).json({ error: "Enter either an odometer reading or an hour meter reading — needed for later analysis." });
  }
  if (!requested_quantity) return res.status(400).json({ error: "Enter the quantity needed." });
  if (request_type === "fuel" && !fuel_station_id) return res.status(400).json({ error: "Select a filling station." });
  if (request_type === "lubricant" && !lubricant_type_id) return res.status(400).json({ error: "Select which lubricant." });

  const { rows } = await query(
    `INSERT INTO supply_requests
     (request_type, requested_by, equipment_type, truck_id, pump_id, equipment_id,
      odometer_reading, hour_meter_reading, requested_quantity, fuel_station_id, lubricant_type_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      request_type, req.user.id, equipment_type,
      equipment_type === "truck" ? truck_id : null,
      equipment_type === "pump" ? pump_id : null,
      ["pickup_van", "loader", "generator"].includes(equipment_type) ? equipment_id : null,
      odometer_reading || null, hour_meter_reading || null, requested_quantity,
      request_type === "fuel" ? fuel_station_id : null,
      request_type === "lubricant" ? lubricant_type_id : null,
    ]
  );

  const { rows: who } = await query("SELECT name FROM users WHERE id = $1", [req.user.id]);
  const label = `${who[0]?.name || "Someone"} requested ${requested_quantity} ${request_type === "fuel" ? "L fuel" : "of lubricant"}`;
  await pushToRole("manager", { title: "New supply request", body: label, url: "/manager" });

  res.status(201).json(rows[0]);
});

// The requester's own requests — active ones (not yet issued/rejected) plus
// anything issued today, so the QR/slip can disappear once used but recent
// history is still visible.
router.get("/mine", requireRole(...REQUESTER_ROLES), async (req, res) => {
  const { rows } = await query(
    `SELECT sr.*, u.name AS requested_by_name,
            fs.name AS fuel_station_name, fs.is_plant AS station_is_plant,
            afs.name AS approved_station_name, afs.is_plant AS approved_station_is_plant,
            lt.name AS lubricant_type_name,
            t.truck_number, p.pump_code, e.name AS equipment_name
     FROM supply_requests sr
     JOIN users u ON u.id = sr.requested_by
     LEFT JOIN fuel_stations fs ON fs.id = sr.fuel_station_id
     LEFT JOIN fuel_stations afs ON afs.id = sr.approved_station_id
     LEFT JOIN lubricant_types lt ON lt.id = sr.lubricant_type_id
     LEFT JOIN trucks t ON t.id = sr.truck_id
     LEFT JOIN pumps p ON p.id = sr.pump_id
     LEFT JOIN equipment e ON e.id = sr.equipment_id
     WHERE sr.requested_by = $1
       AND (sr.status != 'issued' OR sr.issued_at > now() - INTERVAL '1 day')
     ORDER BY sr.requested_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// Manager's approval queue.
router.get("/pending", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT sr.*, u.name AS requested_by_name,
            fs.name AS fuel_station_name, lt.name AS lubricant_type_name,
            t.truck_number, p.pump_code, e.name AS equipment_name
     FROM supply_requests sr
     JOIN users u ON u.id = sr.requested_by
     LEFT JOIN fuel_stations fs ON fs.id = sr.fuel_station_id
     LEFT JOIN lubricant_types lt ON lt.id = sr.lubricant_type_id
     LEFT JOIN trucks t ON t.id = sr.truck_id
     LEFT JOIN pumps p ON p.id = sr.pump_id
     LEFT JOIN equipment e ON e.id = sr.equipment_id
     WHERE sr.status = 'pending'
     ORDER BY sr.requested_at`
  );
  res.json(rows);
});

// Manager approves — can adjust quantity and (for fuel) redirect to a
// different station than what was requested. Generates the single-use QR
// token here, at approval time, not before.
router.post("/:id/approve", requireRole("manager", "administrator"), async (req, res) => {
  const { approved_quantity, approved_station_id } = req.body;
  const { rows: existing } = await query("SELECT * FROM supply_requests WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Request not found or already actioned." });

  const token = crypto.randomBytes(24).toString("hex");
  const { rows } = await query(
    `UPDATE supply_requests SET
       status = 'approved', approved_quantity = $1,
       approved_station_id = COALESCE($2, fuel_station_id),
       approved_by = $3, approved_at = now(), qr_token = $4
     WHERE id = $5 RETURNING *`,
    [approved_quantity || existing[0].requested_quantity, approved_station_id || null, req.user.id, token, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Request approved", body: "Your supply request has been approved", url: "/fuel" });
  res.json(rows[0]);
});

router.post("/:id/reject", requireRole("manager", "administrator"), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "Give a reason for rejecting this." });
  const { rows: existing } = await query("SELECT * FROM supply_requests WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Request not found or already actioned." });

  const { rows } = await query(
    `UPDATE supply_requests SET status = 'rejected', rejected_reason = $1, approved_by = $2, approved_at = now()
     WHERE id = $3 RETURNING *`,
    [reason, req.user.id, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Request rejected", body: reason, url: "/fuel" });
  res.json(rows[0]);
});

// Store scans the QR (really: their phone's own camera app opens this URL)
// — details are only ever revealed here, never visible on the driver's
// screen before this point. Already-issued or unknown tokens both come
// back as a clear, safe "not usable" response rather than leaking whether
// a token ever existed.
router.get("/scan/:token", requireRole("store", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT sr.*, u.name AS requested_by_name,
            fs.name AS approved_station_name, fs.is_plant AS approved_station_is_plant,
            lt.name AS lubricant_type_name,
            t.truck_number, p.pump_code, e.name AS equipment_name
     FROM supply_requests sr
     JOIN users u ON u.id = sr.requested_by
     LEFT JOIN fuel_stations fs ON fs.id = sr.approved_station_id
     LEFT JOIN lubricant_types lt ON lt.id = sr.lubricant_type_id
     LEFT JOIN trucks t ON t.id = sr.truck_id
     LEFT JOIN pumps p ON p.id = sr.pump_id
     LEFT JOIN equipment e ON e.id = sr.equipment_id
     WHERE sr.qr_token = $1`,
    [req.params.token]
  );
  const r = rows[0];
  if (!r) return res.status(404).json({ error: "This code isn't valid." });
  if (r.status === "issued") return res.status(409).json({ error: "This has already been issued — it can't be used again." });
  if (r.status !== "approved") return res.status(409).json({ error: "This request isn't in an issuable state." });
  res.json(r);
});

// Store confirms actual issuance. Clears the token (single-use — this is
// what removes the QR from the driver's screen and blocks re-scanning) and
// records the actual quantity, which is the figure that matters for
// analysis, not just what was requested/approved.
router.post("/:id/issue", requireRole("store", "administrator"), async (req, res) => {
  const { actual_quantity_issued, fuel_cost } = req.body;
  if (!actual_quantity_issued) return res.status(400).json({ error: "Enter the actual quantity issued." });

  const { rows: existing } = await query("SELECT * FROM supply_requests WHERE id = $1 AND status = 'approved'", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Request not found or not in an issuable state." });

  const { rows } = await query(
    `UPDATE supply_requests SET
       status = 'issued', issued_by = $1, issued_at = now(),
       actual_quantity_issued = $2, fuel_cost = $3, qr_token = NULL
     WHERE id = $4 RETURNING *`,
    [req.user.id, actual_quantity_issued, fuel_cost || null, req.params.id]
  );
  res.json(rows[0]);
});

// Manager can clear a pending request outright — distinct from reject
// (which keeps a record and notifies the requester with a reason). This is
// for duplicate or mistaken requests that don't need either.
router.delete("/:id", requireRole("manager", "administrator"), async (req, res) => {
  const { rowCount } = await query("DELETE FROM supply_requests WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Request not found or already actioned." });
  res.json({ ok: true });
});

// ===================== REPORT =====================

function buildReportFilters(q) {
  const clauses = [];
  const params = [];
  function add(clause, value) {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  }
  if (q.from_date) add("sr.requested_at >= ?::date", q.from_date);
  if (q.to_date) add("sr.requested_at < ?::date + INTERVAL '1 day'", q.to_date);
  if (q.request_type) add("sr.request_type = ?", q.request_type);
  if (q.status) add("sr.status = ?", q.status);
  if (q.equipment_type) add("sr.equipment_type = ?", q.equipment_type);
  return { where: clauses.length ? clauses.join(" AND ") : "true", params };
}

const REPORT_COLUMNS = `
  sr.id, sr.request_type, sr.status, sr.requested_at, sr.approved_at, sr.issued_at,
  sr.odometer_reading, sr.hour_meter_reading,
  sr.requested_quantity, sr.approved_quantity, sr.actual_quantity_issued, sr.fuel_cost,
  sr.rejected_reason,
  u.name AS requested_by_name, ub.name AS approved_by_name, ui.name AS issued_by_name,
  fs.name AS station_name, lt.name AS lubricant_type_name,
  t.truck_number, p.pump_code, e.name AS equipment_name
`;
const REPORT_FROM = `
  FROM supply_requests sr
  JOIN users u ON u.id = sr.requested_by
  LEFT JOIN users ub ON ub.id = sr.approved_by
  LEFT JOIN users ui ON ui.id = sr.issued_by
  LEFT JOIN fuel_stations fs ON fs.id = sr.approved_station_id
  LEFT JOIN lubricant_types lt ON lt.id = sr.lubricant_type_id
  LEFT JOIN trucks t ON t.id = sr.truck_id
  LEFT JOIN pumps p ON p.id = sr.pump_id
  LEFT JOIN equipment e ON e.id = sr.equipment_id
`;

router.get("/report", requireRole("manager", "administrator", "accountant"), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 100));
  const { where, params } = buildReportFilters(req.query);

  const [rowsResult, totalsResult] = await Promise.all([
    query(
      `SELECT ${REPORT_COLUMNS} ${REPORT_FROM}
       WHERE ${where}
       ORDER BY sr.requested_at DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    ),
    query(
      `SELECT COUNT(*) AS request_count,
              COALESCE(SUM(sr.actual_quantity_issued) FILTER (WHERE sr.request_type = 'fuel'), 0) AS total_fuel_litres,
              COALESCE(SUM(sr.actual_quantity_issued) FILTER (WHERE sr.request_type = 'lubricant'), 0) AS total_lubricant_qty,
              COALESCE(SUM(sr.fuel_cost), 0) AS total_cost
       ${REPORT_FROM}
       WHERE ${where}`,
      params
    ),
  ]);

  res.json({
    rows: rowsResult.rows,
    page, page_size: pageSize,
    totals: {
      request_count: Number(totalsResult.rows[0].request_count),
      total_fuel_litres: totalsResult.rows[0].total_fuel_litres,
      total_lubricant_qty: totalsResult.rows[0].total_lubricant_qty,
      total_cost: totalsResult.rows[0].total_cost,
    },
  });
});

router.get("/report/export", requireRole("manager", "administrator", "accountant"), async (req, res) => {
  const { where, params } = buildReportFilters(req.query);
  const { rows } = await query(
    `SELECT ${REPORT_COLUMNS} ${REPORT_FROM}
     WHERE ${where}
     ORDER BY sr.requested_at DESC
     LIMIT 5000`,
    params
  );
  res.json(rows);
});

// For a plant fill, Store confirms via the QR scan above. But an external
// station isn't part of this app at all — nobody there ever scans anything,
// so without this, an external request would sit at 'approved' forever with
// no way to ever reach 'issued'. The driver, being the one physically at the
// pump, is the only person who actually knows the real numbers, so they
// confirm their own external fill here.
router.post("/:id/confirm-external-fill", requireRole(...REQUESTER_ROLES), async (req, res) => {
  const { actual_quantity_issued, fuel_cost } = req.body;
  if (!actual_quantity_issued) return res.status(400).json({ error: "Enter the actual quantity filled." });

  const { rows: existing } = await query(
    `SELECT sr.*, fs.is_plant FROM supply_requests sr
     LEFT JOIN fuel_stations fs ON fs.id = sr.approved_station_id
     WHERE sr.id = $1 AND sr.status = 'approved' AND sr.requested_by = $2`,
    [req.params.id, req.user.id]
  );
  if (!existing.length) return res.status(404).json({ error: "Request not found or not in a confirmable state." });
  const isPlantIssue = existing[0].request_type !== "fuel" || existing[0].is_plant;
  if (isPlantIssue) {
    return res.status(400).json({ error: "This is issued by Store, not confirmed here." });
  }

  const { rows } = await query(
    `UPDATE supply_requests SET
       status = 'issued', issued_by = $1, issued_at = now(),
       actual_quantity_issued = $2, fuel_cost = $3, qr_token = NULL
     WHERE id = $4 RETURNING *`,
    [req.user.id, actual_quantity_issued, fuel_cost || null, req.params.id]
  );
  res.json(rows[0]);
});

export default router;
