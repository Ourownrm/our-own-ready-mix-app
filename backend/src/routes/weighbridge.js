// Round 154 — the weighbridge integration.
//
// Two audiences in one file, with two completely different ways in:
//
//   POST /weighbridge/sync   — the agent on the weighbridge PC. NOT a user
//                              session; authenticated by a shared API key.
//                              Defined ABOVE router.use(requireAuth) so it
//                              never sees the session middleware.
//
//   everything else          — people in the app. Normal session auth, and
//                              both guards (requireRole + requirePermission),
//                              same as every other converted route.
//
// The ordering above is load-bearing and is the one thing to be careful about
// when editing this file: Express applies router-level middleware in the order
// it is declared, so a route moved below the requireAuth line would start
// demanding a session and the agent would begin failing silently at 2am. The
// sync route is therefore first, with nothing between it and the top.
//
// DIRECTION. This is one-way, permanently. The agent connects to MySQL with a
// read-only account and nothing in this file emits anything back to the
// weighbridge. The weighbridge is the system of record for what a lorry
// weighed; we are a reader of it. That also means we never "fix" a ticket —
// a wrong weight gets corrected on the weighbridge and arrives here on the
// next poll as a new revision.
//
// IDEMPOTENCE. TicketNumber is the weighbridge's own primary key and is the
// primary key here too, so the agent can re-send any row any number of times.
// SmartWeigh has no updated_at column, so the agent re-sends a trailing window
// on every poll and we compare a hash of the row: unchanged rows cost one
// comparison and change nothing, and a late edit on the weighbridge is caught
// without the source schema having to help us.
//
// See claude/weighbridge-integration-notes.md for the analysis of the live
// dump that this is built against, and lib/weighbridgeNames.js for why name
// resolution is an alias table and not fuzzy matching.
import { Router } from "express";
import crypto from "crypto";
import { pool, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { loadResolver, resolveTicket, resolveVehicle, normalise } from "../lib/weighbridgeNames.js";

const router = Router();

// One batch is capped so a misconfigured agent cannot try to push all 2,478
// historical tickets in a single request and time out halfway. The agent
// chunks anything larger; see tools/weighbridge-agent.
const MAX_BATCH = 500;

// The columns that make up a ticket's identity for change detection. Ordered
// and joined with a separator that cannot appear in the values, then hashed.
// Deliberately excludes our own resolution columns — a ticket has not changed
// on the weighbridge just because we learned what its supplier means.
const HASH_FIELDS = [
  "ticket_number", "raw_vehicle", "raw_material", "raw_material_code", "raw_supplier",
  "purpose", "challan_number", "driver_name", "site_name", "shift", "load_status",
  "remarks", "charges", "concrete_grade",
  "empty_weight_kg", "loaded_weight_kg", "net_weight_kg",
  "ticket_date", "empty_weighed_at", "loaded_weighed_at", "weighed_at",
];

function hashRow(row) {
  const payload = HASH_FIELDS.map((f) => (row[f] === null || row[f] === undefined ? "" : String(row[f]))).join("\u0001");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ============================================================================
// THE AGENT ENDPOINT — API key, no session. Must stay above requireAuth.
// ============================================================================

function agentAuthorised(req) {
  const expected = process.env.WEIGHBRIDGE_API_KEY;
  // An unset key means the endpoint is closed, not open. Refusing to start
  // with no key at all would take the whole backend down over an integration
  // that is not in use yet, so this fails closed per-request instead.
  if (!expected) return false;
  const given = req.get("x-weighbridge-key") || "";
  // Constant-time compare, and length-guarded because timingSafeEqual throws
  // on a length mismatch rather than returning false.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const INT_OR_NULL = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

// The weighbridge writes '0001-01-01' where a weighing never happened, and a
// handful of rows carry a Date far from their own weighing timestamps. Anything
// before the weighbridge was installed is not a date, it is a sentinel.
const EARLIEST_PLAUSIBLE = Date.parse("2015-01-01T00:00:00Z");
const TS_OR_NULL = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < EARLIEST_PLAUSIBLE) return null;
  return new Date(t).toISOString();
};

const TEXT_OR_NULL = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
};

function cleanRow(raw) {
  const ticket_number = INT_OR_NULL(raw.ticket_number);
  if (!Number.isInteger(ticket_number) || ticket_number <= 0) return null;

  const row = {
    ticket_number,
    raw_vehicle:       TEXT_OR_NULL(raw.raw_vehicle, 60),
    raw_material:      TEXT_OR_NULL(raw.raw_material, 120),
    raw_material_code: TEXT_OR_NULL(raw.raw_material_code, 120),
    raw_supplier:      TEXT_OR_NULL(raw.raw_supplier, 150),
    purpose:           TEXT_OR_NULL(raw.purpose, 60),
    challan_number:    TEXT_OR_NULL(raw.challan_number, 60),
    driver_name:       TEXT_OR_NULL(raw.driver_name, 120),
    site_name:         TEXT_OR_NULL(raw.site_name, 120),
    shift:             TEXT_OR_NULL(raw.shift, 20),
    load_status:       TEXT_OR_NULL(raw.load_status, 20),
    remarks:           TEXT_OR_NULL(raw.remarks, 2000),
    charges:           TEXT_OR_NULL(raw.charges, 120),
    concrete_grade:    TEXT_OR_NULL(raw.concrete_grade, 60),
    empty_weight_kg:   INT_OR_NULL(raw.empty_weight_kg),
    loaded_weight_kg:  INT_OR_NULL(raw.loaded_weight_kg),
    net_weight_kg:     INT_OR_NULL(raw.net_weight_kg),
    ticket_date:       TS_OR_NULL(raw.ticket_date),
    empty_weighed_at:  TS_OR_NULL(raw.empty_weighed_at),
    loaded_weighed_at: TS_OR_NULL(raw.loaded_weighed_at),
  };

  // The timestamp the app orders and reports on. The loaded weighing is the
  // moment that matters for a receipt; the empty one and then the ticket's own
  // Date are fallbacks. See schema.sql for why Date alone is not trusted.
  row.weighed_at = row.loaded_weighed_at || row.empty_weighed_at || row.ticket_date;
  // ticket_date is a DATE, and it has to be the IST calendar day.
  //
  // This is the app's recurring bug and it bit here first time round:
  // TS_OR_NULL returns a UTC ISO string, so `.slice(0, 10)` off the front of it
  // is the UTC day. A lorry weighed at 09:40 on 22 September IST is 04:10 UTC
  // on the 22nd — fine — but anything weighed before 05:30 IST is still the
  // previous day in UTC, and the ticket would file itself under yesterday.
  // Everything this column is ever compared against (CURRENT_DATE in the
  // summary query, the date filters on the receipts screen) is an IST day,
  // because db.js pins every connection to Asia/Kolkata. So this has to be too.
  // en-CA formats as yyyy-mm-dd, which is what a DATE column wants.
  row.ticket_date = row.ticket_date
    ? new Date(row.ticket_date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    : null;

  return row;
}

const UPSERT_COLS = [
  "ticket_number", "raw_vehicle", "raw_material", "raw_material_code", "raw_supplier",
  "purpose", "challan_number", "driver_name", "site_name", "shift", "load_status",
  "remarks", "charges", "concrete_grade",
  "empty_weight_kg", "loaded_weight_kg", "net_weight_kg",
  "ticket_date", "empty_weighed_at", "loaded_weighed_at", "weighed_at",
  "material_id", "supplier_id", "truck_id", "vehicle_id", "match_status", "unresolved", "source_hash",
];

router.post("/sync", async (req, res) => {
  if (!agentAuthorised(req)) {
    return res.status(401).json({ error: "Not authorised." });
  }

  const body = req.body || {};
  const incoming = Array.isArray(body.tickets) ? body.tickets : null;
  if (!incoming) {
    return res.status(400).json({ error: "Expected a `tickets` array." });
  }
  if (incoming.length > MAX_BATCH) {
    return res.status(413).json({ error: `Send at most ${MAX_BATCH} tickets per call.`, max_batch: MAX_BATCH });
  }

  const agentVersion = TEXT_OR_NULL(body.agent_version, 20);

  try {
    // No rows is a perfectly normal poll — the agent still says hello so the
    // app can tell "nothing new" apart from "the agent has stopped".
    if (!incoming.length) {
      const { rows: hw } = await query(`SELECT max(ticket_number) AS highest FROM weighbridge_tickets`);
      await query(
        `INSERT INTO weighbridge_sync_log (agent_version, rows_sent, highest_ticket) VALUES ($1, 0, $2)`,
        [agentVersion, hw[0].highest]
      );
      return res.json({ ok: true, inserted: 0, updated: 0, unchanged: 0, rejected: 0, highest_ticket: hw[0].highest });
    }

    const resolver = await loadResolver();

    const clean = [];
    let rejected = 0;
    const seen = new Set();
    for (const raw of incoming) {
      const row = cleanRow(raw);
      // A row with no usable ticket number is unusable — there is nothing to
      // key it on. A duplicate within one batch would make the upsert's
      // ON CONFLICT fire against a row inserted in the same statement, which
      // Postgres refuses, so the last one wins and the earlier is dropped.
      if (!row) { rejected++; continue; }
      if (seen.has(row.ticket_number)) {
        const at = clean.findIndex((r) => r.ticket_number === row.ticket_number);
        clean[at] = row;
        continue;
      }
      seen.add(row.ticket_number);
      clean.push(row);
    }

    for (const row of clean) {
      Object.assign(row, resolveTicket(resolver, row));
      // Round 156 — the vehicle registers itself. This is a write, so unlike
      // material and supplier it cannot come from the in-memory resolver: a
      // registration nobody has seen before has to become a row before the
      // ticket can point at it. Sequential rather than parallel on purpose —
      // two tickets in one batch often carry the same new lorry, and letting
      // them race would leave the ON CONFLICT doing the work twice.
      const veh = await resolveVehicle(row.raw_vehicle);
      row.vehicle_id = veh.vehicle_id;
      row.truck_id = veh.truck_id;
      row.source_hash = hashRow(row);
    }

    let inserted = 0;
    let updated = 0;

    if (clean.length) {
      const values = [];
      const params = [];
      clean.forEach((row, i) => {
        const base = i * UPSERT_COLS.length;
        values.push(`(${UPSERT_COLS.map((_, j) => `$${base + j + 1}`).join(", ")})`);
        UPSERT_COLS.forEach((c) => params.push(row[c]));
      });

      // `xmax = 0` is true only for a row this statement inserted, which is how
      // insert and update are told apart. A row whose hash is unchanged matches
      // neither because the DO UPDATE's WHERE skips it and it is not RETURNed —
      // that is what makes the trailing re-send window nearly free.
      //
      // match_status is CASE-guarded so a re-sync can never undo a human. Once
      // somebody marks a ticket 'ignored', it stays ignored however many times
      // the weighbridge row is re-sent or edited.
      const { rows } = await pool.query(
        `INSERT INTO weighbridge_tickets (${UPSERT_COLS.join(", ")})
         VALUES ${values.join(", ")}
         ON CONFLICT (ticket_number) DO UPDATE SET
           raw_vehicle       = EXCLUDED.raw_vehicle,
           raw_material      = EXCLUDED.raw_material,
           raw_material_code = EXCLUDED.raw_material_code,
           raw_supplier      = EXCLUDED.raw_supplier,
           purpose           = EXCLUDED.purpose,
           challan_number    = EXCLUDED.challan_number,
           driver_name       = EXCLUDED.driver_name,
           site_name         = EXCLUDED.site_name,
           shift             = EXCLUDED.shift,
           load_status       = EXCLUDED.load_status,
           remarks           = EXCLUDED.remarks,
           charges           = EXCLUDED.charges,
           concrete_grade    = EXCLUDED.concrete_grade,
           empty_weight_kg   = EXCLUDED.empty_weight_kg,
           loaded_weight_kg  = EXCLUDED.loaded_weight_kg,
           net_weight_kg     = EXCLUDED.net_weight_kg,
           ticket_date       = EXCLUDED.ticket_date,
           empty_weighed_at  = EXCLUDED.empty_weighed_at,
           loaded_weighed_at = EXCLUDED.loaded_weighed_at,
           weighed_at        = EXCLUDED.weighed_at,
           material_id       = EXCLUDED.material_id,
           supplier_id       = EXCLUDED.supplier_id,
           truck_id          = EXCLUDED.truck_id,
           vehicle_id        = EXCLUDED.vehicle_id,
           match_status      = CASE WHEN weighbridge_tickets.match_status = 'ignored'
                                    THEN 'ignored'::wb_match_status
                                    ELSE EXCLUDED.match_status END,
           unresolved        = EXCLUDED.unresolved,
           source_hash       = EXCLUDED.source_hash,
           revision          = weighbridge_tickets.revision + 1,
           last_synced_at    = now()
         WHERE weighbridge_tickets.source_hash IS DISTINCT FROM EXCLUDED.source_hash
         RETURNING (xmax = 0) AS inserted`,
        params
      );
      inserted = rows.filter((r) => r.inserted).length;
      updated = rows.length - inserted;
    }

    const { rows: hw } = await query(`SELECT max(ticket_number) AS highest FROM weighbridge_tickets`);
    const unchanged = clean.length - inserted - updated;

    await query(
      `INSERT INTO weighbridge_sync_log
         (agent_version, rows_sent, rows_inserted, rows_updated, rows_unchanged, rows_rejected, highest_ticket)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [agentVersion, incoming.length, inserted, updated, unchanged, rejected, hw[0].highest]
    );

    res.json({
      ok: true,
      inserted,
      updated,
      unchanged,
      rejected,
      // The agent resumes from here, so it never has to keep its own state file
      // in step with ours. If the app's database is restored from a backup, the
      // agent re-sends from the restored high-water mark automatically.
      highest_ticket: hw[0].highest,
    });
  } catch (err) {
    console.error("weighbridge sync failed", err);
    await query(
      `INSERT INTO weighbridge_sync_log (agent_version, rows_sent, error) VALUES ($1, $2, $3)`,
      [agentVersion, incoming.length, String(err.message).slice(0, 2000)]
    ).catch(() => {});
    res.status(500).json({ error: "Could not store the tickets." });
  }
});

// ============================================================================
// EVERYTHING BELOW IS A USER SESSION. Nothing may be added above this line
// without an API key of its own.
// ============================================================================
router.use(requireAuth);

// Who can LOOK at the weighbridge. The Plant Operator and the lab are here
// because they are the ones asked "what did that lorry actually weigh?" hours
// after the fact and currently have to go and find someone.
const WB_ROLES = ["administrator", "manager", "store", "plant_operator", "lab_technician"];

// Who can set a ticket aside. A strict subset of WB_ROLES, and it has to be:
// the two guards must agree, so a role listed here that the catalogue does not
// grant `edit` would sail past requireRole and then eat a bare 403 on a button
// it can see. backend/scripts/check-guards.mjs catches exactly that, and did
// catch it when this list was first written as WB_ROLES.
const WB_EDIT_ROLES = ["administrator", "manager", "store"];

const MAPPING_ROLES = ["administrator"];

// The receipts list. Defaults to the last 30 days rather than everything,
// because the backlog import can put a few hundred rows in here and the plant
// opens this screen to answer "what came in today".
router.get("/tickets", requireRole(...WB_ROLES), requirePermission("material.weighbridge", "view"), async (req, res) => {
  try {
    const status = ["matched", "needs_review", "ignored"].includes(req.query.status) ? req.query.status : null;
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400);
    const { rows } = await query(
      `SELECT wb.ticket_number, wb.raw_vehicle, wb.raw_material, wb.raw_supplier, wb.purpose,
              wb.challan_number, wb.driver_name, wb.remarks, wb.charges,
              wb.empty_weight_kg, wb.loaded_weight_kg, wb.net_weight_kg,
              wb.ticket_date, wb.weighed_at, wb.match_status, wb.unresolved,
              wb.review_note, wb.revision, wb.last_synced_at,
              m.name AS material_name, s.name AS supplier_name, t.truck_number,
              -- Round 156 — the registry's view of the lorry. veh_owner says
              -- who it belongs to when somebody has said; it is blank for a
              -- vehicle that is simply being counted, which is fine and is
              -- the normal state for a supplier's lorry nobody has attributed.
              v.registration AS vehicle_registration,
              COALESCE(t.truck_number, vs.name) AS veh_owner,
              r.id AS receipt_id
       FROM weighbridge_tickets wb
       LEFT JOIN rm_materials m ON m.id = wb.material_id
       LEFT JOIN rm_suppliers s ON s.id = wb.supplier_id
       LEFT JOIN trucks t       ON t.id = wb.truck_id
       LEFT JOIN weighbridge_vehicles v ON v.id = wb.vehicle_id
       LEFT JOIN rm_suppliers vs ON vs.id = v.supplier_id
       LEFT JOIN rm_receipts r  ON r.weighbridge_ticket_id = wb.ticket_number   -- receipts-raw: a pending receipt still claims its ticket, so this must see them
       WHERE ($1::text IS NULL OR wb.match_status = $1::wb_match_status)
         AND (wb.weighed_at IS NULL OR wb.weighed_at >= now() - ($2 || ' days')::interval)
       ORDER BY wb.weighed_at DESC NULLS LAST, wb.ticket_number DESC
       LIMIT 500`,
      [status, String(days)]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load weighbridge tickets." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 162 — the records report.
//
// The Receipts tab is a working queue: recent tickets, one status at a time,
// there to be actioned. This is the other thing people ask for — "find me the
// weighments for this lorry last month", "what did we take from this supplier
// in September" — a filterable, searchable view over ALL the history with the
// totals that answer those questions.
//
// Every filter is optional and they combine. `q` is a free-text search across
// the fields a person actually remembers: the raw vehicle/material/supplier
// spellings, the challan and the driver. Dates filter on weighed_at (the real
// event), falling back to ticket_date where the weighbridge left no timestamp.
// ---------------------------------------------------------------------------
router.get("/report", requireRole(...WB_ROLES), requirePermission("material.weighbridge", "view"), async (req, res) => {
  try {
    const params = [];
    const wh = [];
    const eventDate = "COALESCE(wb.weighed_at::date, wb.ticket_date)";

    if (req.query.from_date) { params.push(req.query.from_date); wh.push(`${eventDate} >= $${params.length}::date`); }
    if (req.query.to_date)   { params.push(req.query.to_date);   wh.push(`${eventDate} <= $${params.length}::date`); }
    if (req.query.material_id) { params.push(req.query.material_id); wh.push(`wb.material_id = $${params.length}`); }
    if (req.query.supplier_id) { params.push(req.query.supplier_id); wh.push(`wb.supplier_id = $${params.length}`); }
    if (["matched", "needs_review", "ignored"].includes(req.query.status)) {
      params.push(req.query.status); wh.push(`wb.match_status = $${params.length}::wb_match_status`);
    }
    if (req.query.purpose) { params.push(req.query.purpose); wh.push(`wb.purpose = $${params.length}`); }
    if (req.query.q && req.query.q.trim()) {
      params.push(`%${req.query.q.trim()}%`);
      const i = params.length;
      wh.push(`(wb.raw_vehicle ILIKE $${i} OR wb.raw_material ILIKE $${i} OR wb.raw_supplier ILIKE $${i}
                OR wb.challan_number ILIKE $${i} OR wb.driver_name ILIKE $${i}
                OR v.registration ILIKE $${i})`);
    }
    const where = wh.length ? wh.join(" AND ") : "true";

    const { rows } = await query(
      `SELECT wb.ticket_number, wb.raw_vehicle, wb.raw_material, wb.raw_supplier, wb.purpose,
              wb.challan_number, wb.driver_name, wb.net_weight_kg, wb.empty_weight_kg, wb.loaded_weight_kg,
              wb.ticket_date, wb.weighed_at, wb.match_status,
              m.name AS material_name, s.name AS supplier_name,
              v.registration AS vehicle_registration,
              r.id AS receipt_id
         FROM weighbridge_tickets wb
         LEFT JOIN rm_materials m ON m.id = wb.material_id
         LEFT JOIN rm_suppliers s ON s.id = wb.supplier_id
         LEFT JOIN weighbridge_vehicles v ON v.id = wb.vehicle_id
         LEFT JOIN rm_receipts r ON r.weighbridge_ticket_id = wb.ticket_number   -- receipts-raw: a pending receipt still claims its ticket
        WHERE ${where}
        ORDER BY wb.weighed_at DESC NULLS LAST, wb.ticket_number DESC
        LIMIT 1000`,
      params
    );

    // The totals people are really after. Net weight is only meaningful for
    // tickets that were actually loaded, and 'ignored' rows (test weighments)
    // are excluded from the tonnage so a day's total is real material.
    const { rows: totals } = await query(
      `SELECT count(*)::int AS n,
              COALESCE(sum(wb.net_weight_kg) FILTER (WHERE wb.match_status <> 'ignored'), 0)::numeric AS net_kg
         FROM weighbridge_tickets wb
         LEFT JOIN weighbridge_vehicles v ON v.id = wb.vehicle_id
        WHERE ${where}`,
      params
    );

    res.json({ rows, total_count: totals[0].n, total_net_kg: Number(totals[0].net_kg), truncated: rows.length === 1000 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not run the weighbridge report." });
  }
});

// The distinct purposes present, for the report's filter dropdown — only the
// values that actually occur, so the filter never offers an empty category.
router.get("/purposes", requireRole(...WB_ROLES), requirePermission("material.weighbridge", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT purpose FROM weighbridge_tickets WHERE purpose IS NOT NULL AND purpose <> '' ORDER BY purpose`
    );
    res.json(rows.map((r) => r.purpose));
  } catch (err) {
    res.status(500).json({ error: "Could not load purposes." });
  }
});

// The header strip: how many need a human, and — the question that actually
// matters at 7am — when did the agent last check in.
router.get("/summary", requireRole(...WB_ROLES), requirePermission("material.weighbridge", "view"), async (req, res) => {
  try {
    const [counts, last, today] = await Promise.all([
      query(`SELECT match_status::text AS status, count(*)::int AS n FROM weighbridge_tickets GROUP BY 1`),
      query(`SELECT received_at, agent_version, rows_inserted, error FROM weighbridge_sync_log ORDER BY received_at DESC LIMIT 1`),
      // CURRENT_DATE is the IST day — db.js pins every connection to
      // Asia/Kolkata. Doing this in JavaScript would give the UTC day and be
      // wrong between midnight and 05:30 every morning.
      query(`SELECT count(*)::int AS n, COALESCE(sum(net_weight_kg), 0)::int AS kg
             FROM weighbridge_tickets
             WHERE weighed_at::date = CURRENT_DATE AND match_status <> 'ignored'`),
    ]);
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
    res.json({
      matched: byStatus.matched || 0,
      needs_review: byStatus.needs_review || 0,
      ignored: byStatus.ignored || 0,
      today_count: today.rows[0].n,
      today_kg: today.rows[0].kg,
      last_sync_at: last.rows[0]?.received_at || null,
      last_sync_error: last.rows[0]?.error || null,
      agent_version: last.rows[0]?.agent_version || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the weighbridge summary." });
  }
});

// Set a ticket aside, or put it back in the queue. This is the only thing a
// person may change about a ticket — the weighbridge owns everything else.
router.patch("/tickets/:id", requireRole(...WB_EDIT_ROLES), requirePermission("material.weighbridge", "edit"), async (req, res) => {
  const ticketNumber = Number(req.params.id);
  if (!Number.isInteger(ticketNumber)) return res.status(400).json({ error: "Invalid ticket number." });

  const wanted = req.body?.match_status;
  // 'matched' is deliberately not settable by hand: a ticket is matched
  // because its names resolved, and letting someone assert it without a
  // material or supplier would put an unattributable row into stock. To clear
  // a review, map the name on the mapping screen — which re-resolves this
  // ticket and every other one carrying the same spelling.
  if (!["needs_review", "ignored"].includes(wanted)) {
    return res.status(400).json({ error: "A ticket can only be set to needs_review or ignored." });
  }
  try {
    const { rows } = await query(
      `UPDATE weighbridge_tickets
          SET match_status = $2::wb_match_status,
              review_note  = $3,
              reviewed_by  = $4,
              reviewed_at  = now()
        WHERE ticket_number = $1
        RETURNING ticket_number, match_status::text`,
      [ticketNumber, wanted, req.body?.review_note?.slice(0, 500) || null, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Ticket not found." });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the ticket." });
  }
});

// ---------------------------------------------------------------------------
// The mapping screen.
// ---------------------------------------------------------------------------

// Every weighbridge spelling that has not been resolved, with how many tickets
// carry it and when it was last seen — so the busiest, most recent unknowns
// sort to the top and get mapped first.
//
// ROUND 156 — two changes.
//
// Vehicles are gone from this list. They register themselves now (see
// lib/weighbridgeNames.js resolveVehicle), so there is nothing here for a
// human to decide; the Vehicles screen handles ownership and typo merging
// separately, and neither holds a ticket up.
//
// An unresolved MATERIAL is now reported per supplier, not once overall. The
// plant buys three fly ashes that the weighbridge calls "FLY ASH", and the
// mapping screen has to offer a row per supplier or there is no way to tell
// them apart. `suppliers` carries the ones this spelling has actually arrived
// from, so the screen only ever offers real combinations.
router.get("/unmapped", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `WITH flagged AS (
         SELECT ticket_number, weighed_at, unresolved, supplier_id,
                raw_material, raw_supplier
         FROM weighbridge_tickets
         WHERE match_status <> 'ignored' AND array_length(unresolved, 1) > 0
       ),
       mat AS (
         SELECT upper(regexp_replace(COALESCE(raw_material, ''), '[^A-Za-z0-9]', '', 'g')) AS norm,
                (array_agg(raw_material ORDER BY weighed_at DESC NULLS LAST))[1] AS raw_sample,
                count(*)::int AS n, max(weighed_at) AS last_seen,
                -- The suppliers this spelling has actually arrived from, resolved
                -- ones only: an unresolved supplier cannot scope anything yet.
                COALESCE(
                  jsonb_agg(DISTINCT jsonb_build_object('id', f.supplier_id, 'name', s.name))
                    FILTER (WHERE f.supplier_id IS NOT NULL),
                  '[]'::jsonb
                ) AS suppliers
         FROM flagged f LEFT JOIN rm_suppliers s ON s.id = f.supplier_id
         WHERE 'material' = ANY(f.unresolved) GROUP BY norm
       ),
       sup AS (
         SELECT upper(regexp_replace(COALESCE(raw_supplier, ''), '[^A-Za-z0-9]', '', 'g')) AS norm,
                (array_agg(raw_supplier ORDER BY weighed_at DESC NULLS LAST))[1] AS raw_sample,
                count(*)::int AS n, max(weighed_at) AS last_seen,
                '[]'::jsonb AS suppliers
         FROM flagged WHERE 'supplier' = ANY(unresolved) GROUP BY norm
       )
       SELECT kind, raw_sample, n, last_seen, suppliers FROM (
         SELECT 'material' AS kind, raw_sample, n, last_seen, suppliers FROM mat
         UNION ALL
         SELECT 'supplier', raw_sample, n, last_seen, suppliers FROM sup
       ) u
       ORDER BY n DESC, last_seen DESC NULLS LAST
       LIMIT 300`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the unmapped names." });
  }
});

// The mappings already made, plus the master lists to map onto, so the screen
// needs one call rather than four.
router.get("/aliases", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "view"), async (req, res) => {
  try {
    const [mat, sup, materials, suppliers] = await Promise.all([
      // Round 156 — a material rule may be scoped to one supplier. scope_name
      // is null for the fallback rule that applies to everyone else.
      query(`SELECT a.id, a.normalised, a.raw_sample, a.is_ignored, a.mapped_at,
                    m.name AS target, a.supplier_scope_id, sc.name AS scope_name
             FROM weighbridge_material_aliases a
             LEFT JOIN rm_materials m  ON m.id  = a.material_id
             LEFT JOIN rm_suppliers sc ON sc.id = a.supplier_scope_id
             ORDER BY a.raw_sample, sc.name NULLS FIRST`),
      query(`SELECT a.id, a.normalised, a.raw_sample, a.is_ignored, a.mapped_at, s.name AS target
             FROM weighbridge_supplier_aliases a LEFT JOIN rm_suppliers s ON s.id = a.supplier_id ORDER BY a.raw_sample`),
      query(`SELECT id, name FROM rm_materials WHERE is_active = true ORDER BY name`),
      query(`SELECT id, name FROM rm_suppliers WHERE is_active = true ORDER BY name`),
    ]);
    res.json({
      material: mat.rows,
      supplier: sup.rows,
      // Vehicles are no longer mapped here — they have their own screen from
      // Round 156, because they register themselves and the question is who
      // owns them, not what they are.
      options: { material: materials.rows, supplier: suppliers.rows },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the name mappings." });
  }
});

// Vehicles are absent on purpose from Round 156: they are not mapped to
// anything, they register themselves, and their ownership is set on the
// Vehicles screen further down this file.
const ALIAS_TABLES = {
  material: { table: "weighbridge_material_aliases", idCol: "material_id", master: "rm_materials" },
  supplier: { table: "weighbridge_supplier_aliases", idCol: "supplier_id", master: "rm_suppliers" },
};

// Re-run resolution over every ticket with anything still outstanding. Called
// after any mapping change, so the effect of a mapping is immediate and
// retroactive — map "KL77D423" once and every ticket that ever carried that
// typo resolves, not just the ones that arrive tomorrow.
//
// TWO categories are picked up here, and the second one is easy to miss:
//
//   * needs_review — the obvious case, a ticket waiting on a human.
//
//   * matched, but with a non-empty `unresolved` — a ticket whose vehicle
//     never resolved. An unknown vehicle does not block a match (most lorries
//     on this weighbridge are the supplier's and will never be in our trucks
//     table), so such a ticket sits in Matched with truck_id NULL. Without
//     this second clause, mapping that vehicle later would silently do
//     nothing to it and the lorry would stay unattributed forever. Found
//     exactly that way during Round 154's verification.
//
// 'ignored' tickets are left alone: a person set those aside deliberately, and
// a mapping change must not drag them back into view.
async function reresolveOutstanding() {
  const resolver = await loadResolver();
  // WHICH TICKETS ARE RE-EXAMINED, and the line this draws is the important
  // part of Round 156.
  //
  // Everything that is not yet accounted for gets re-resolved: tickets waiting
  // on a human, tickets matched but with something still unresolved, tickets
  // with no vehicle row yet — and, added in Round 156, tickets that are
  // MATCHED BUT NOT YET CLAIMED BY A RECEIPT.
  //
  // That last clause is what makes "Change" mean anything. Correcting a rule
  // used to report success and leave every already-matched ticket sitting on
  // the old material, because the sweep skipped them — so the plant would
  // change a mapping, see "saved", and watch nothing happen. Reported by the
  // yard within a day of the feed going live.
  //
  // A ticket a receipt HAS claimed is deliberately left alone. Its material is
  // already credited to stock and already priced into a weighted average;
  // silently moving it because somebody tidied a mapping would rewrite history
  // nobody asked to rewrite. Those are corrected by editing the receipt.
  const { rows } = await query(
    `SELECT wb.ticket_number, wb.raw_material, wb.raw_material_code, wb.raw_supplier, wb.raw_vehicle, wb.vehicle_id
     FROM weighbridge_tickets wb
     LEFT JOIN rm_receipts r ON r.weighbridge_ticket_id = wb.ticket_number   -- receipts-raw: a pending receipt still claims its ticket, so this must see them
     WHERE r.id IS NULL
       AND (
            wb.match_status = 'needs_review'
         OR (wb.match_status = 'matched' AND array_length(wb.unresolved, 1) > 0)
         OR (wb.match_status = 'matched')
         OR (wb.match_status <> 'ignored' AND wb.vehicle_id IS NULL AND wb.raw_vehicle IS NOT NULL)
       )`
  );
  let cleared = 0;
  for (const t of rows) {
    const r = resolveTicket(resolver, t);
    // Round 156 — the vehicle is resolved here too, which also registers any
    // lorry that arrived before the registry existed. That is why the query
    // above includes tickets with no vehicle_id even when everything else
    // about them is already settled.
    const veh = await resolveVehicle(t.raw_vehicle);
    await query(
      `UPDATE weighbridge_tickets
          SET material_id = $2, supplier_id = $3, truck_id = $4, vehicle_id = $5,
              match_status = $6::wb_match_status, unresolved = $7
        WHERE ticket_number = $1`,
      [t.ticket_number, r.material_id, r.supplier_id, veh.truck_id, veh.vehicle_id, r.match_status, r.unresolved]
    );
    if (r.match_status === "matched") cleared++;
  }
  return cleared;
}

router.post("/aliases", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "create"), async (req, res) => {
  const kind = req.body?.kind;
  const spec = ALIAS_TABLES[kind];
  if (!spec) return res.status(400).json({ error: "kind must be material or supplier." });

  const rawSample = String(req.body?.raw_sample ?? "").trim();
  const norm = normalise(rawSample);
  if (!norm) return res.status(400).json({ error: "That name is empty once punctuation is removed — there is nothing to map." });

  const isIgnored = req.body?.is_ignored === true;
  // Round 158 — > 0, not merely an integer: a null body field becomes 0 here,
  // and 0 passed Number.isInteger() happily before failing later against the
  // database with a misleading "no longer exists".
  const targetId = isIgnored ? null : Number(req.body?.target_id);
  if (!isIgnored && !(Number.isInteger(targetId) && targetId > 0)) {
    return res.status(400).json({ error: "Pick something to map it to, or mark it ignored." });
  }

  // ROUND 156 — an optional supplier scope, materials only.
  //
  // With a scope, this rule applies only to tickets from that supplier and
  // beats the unscoped one. Without, it is the fallback for everyone else.
  // That is what lets "FLY ASH" mean the JSW product on a JSW ticket and the
  // Thoothukudi product on a Thoothukudi one.
  //
  // Scoping a SUPPLIER name would be circular — the scope is the supplier —
  // so it is refused rather than quietly ignored.
  const rawScope = req.body?.supplier_scope_id;
  const scopeId = rawScope === undefined || rawScope === null || rawScope === "" ? null : Number(rawScope);
  if (scopeId !== null && !Number.isInteger(scopeId)) {
    return res.status(400).json({ error: "Invalid supplier scope." });
  }
  if (scopeId !== null && kind !== "material") {
    return res.status(400).json({ error: "Only a material rule can be scoped to a supplier." });
  }

  try {
    if (!isIgnored) {
      const { rows: exists } = await query(`SELECT 1 FROM ${spec.master} WHERE id = $1`, [targetId]);
      if (!exists.length) return res.status(400).json({ error: "That record no longer exists." });
    }
    if (scopeId !== null) {
      const { rows: sc } = await query(`SELECT 1 FROM rm_suppliers WHERE id = $1`, [scopeId]);
      if (!sc.length) return res.status(400).json({ error: "That supplier no longer exists." });
    }

    // Re-mapping an existing rule is a normal correction, so this upserts
    // rather than refusing — that is the "Change" button on the screen. The
    // two partial unique indexes mean a scoped rule and the unscoped fallback
    // for the same name coexist and are corrected independently, so the
    // conflict target has to be named explicitly rather than left to the
    // column: ON CONFLICT (normalised) alone would not match the scoped index.
    if (kind === "material") {
      if (scopeId === null) {
        await query(
          `INSERT INTO weighbridge_material_aliases (normalised, raw_sample, material_id, is_ignored, mapped_by, supplier_scope_id)
           VALUES ($1, $2, $3, $4, $5, NULL)
           ON CONFLICT (normalised) WHERE supplier_scope_id IS NULL DO UPDATE SET
             raw_sample = EXCLUDED.raw_sample, material_id = EXCLUDED.material_id,
             is_ignored = EXCLUDED.is_ignored, mapped_by = EXCLUDED.mapped_by, mapped_at = now()`,
          [norm, rawSample.slice(0, 120), targetId, isIgnored, req.user.id]
        );
      } else {
        await query(
          `INSERT INTO weighbridge_material_aliases (normalised, raw_sample, material_id, is_ignored, mapped_by, supplier_scope_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (normalised, supplier_scope_id) WHERE supplier_scope_id IS NOT NULL DO UPDATE SET
             raw_sample = EXCLUDED.raw_sample, material_id = EXCLUDED.material_id,
             is_ignored = EXCLUDED.is_ignored, mapped_by = EXCLUDED.mapped_by, mapped_at = now()`,
          [norm, rawSample.slice(0, 120), targetId, isIgnored, req.user.id, scopeId]
        );
      }
    } else {
      await query(
        `INSERT INTO weighbridge_supplier_aliases (normalised, raw_sample, supplier_id, is_ignored, mapped_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (normalised) DO UPDATE SET
           raw_sample = EXCLUDED.raw_sample, supplier_id = EXCLUDED.supplier_id,
           is_ignored = EXCLUDED.is_ignored, mapped_by = EXCLUDED.mapped_by, mapped_at = now()`,
        [norm, rawSample.slice(0, 150), targetId, isIgnored, req.user.id]
      );
    }

    const cleared = await reresolveOutstanding();
    res.json({ ok: true, normalised: norm, scoped: scopeId !== null, tickets_cleared: cleared });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the mapping." });
  }
});

router.delete("/aliases/:kind/:id", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "edit"), async (req, res) => {
  const spec = ALIAS_TABLES[req.params.kind];
  const id = Number(req.params.id);
  if (!spec) return res.status(400).json({ error: "kind must be material or supplier." });
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid mapping id." });
  try {
    const { rowCount } = await query(`DELETE FROM ${spec.table} WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Mapping not found." });
    // Removing a rule can only ever push tickets back into the queue, but
    // matched tickets are not re-checked here — they keep the ids they were
    // resolved to, which is the honest behaviour: stock that was already
    // credited does not un-credit because somebody tidied the mapping list.
    await reresolveOutstanding();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove the mapping." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 156 — re-check every outstanding ticket, on demand.
//
// The gap this closes: re-resolution used to run only when a MAPPING changed.
// So populating the Material Module's own masters — adding "20 MM" as a
// material, or Starmetals as a supplier — reached nothing that had already
// synced, and the plant was left with a hundred tickets stuck in Needs review
// against masters that would now match them perfectly. The only workaround was
// to save an unrelated mapping and let its sweep pick everything up, which is
// not a thing anybody should have to know.
// ---------------------------------------------------------------------------
router.post("/recheck", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "edit"), async (req, res) => {
  try {
    const before = await query(
      `SELECT count(*)::int AS n FROM weighbridge_tickets WHERE match_status = 'needs_review'`
    );
    const cleared = await reresolveOutstanding();
    const after = await query(
      `SELECT count(*)::int AS n FROM weighbridge_tickets WHERE match_status = 'needs_review'`
    );
    res.json({
      ok: true,
      tickets_cleared: cleared,
      needs_review_before: before.rows[0].n,
      needs_review_now: after.rows[0].n,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not re-check the tickets." });
  }
});

// ---------------------------------------------------------------------------
// ROUND 156 — the vehicle registry.
//
// Round 154 made this a binary: map the lorry to one of our trucks, or mark it
// ignored. Almost every vehicle over this weighbridge is a supplier's, so in
// practice that meant discarding the vehicle on nearly every ticket — and with
// it any way to ask which lorry arrives light or whether a tare is drifting.
//
// Now every registration has a row, created on arrival, and the only questions
// left for a human are optional enrichment: who owns it, and whether a
// misspelling should be merged into a lorry already on the list.
// ---------------------------------------------------------------------------
router.get("/vehicles", requireRole(...WB_ROLES), requirePermission("material.weighbridge", "view"), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 1000);
    const { rows } = await query(
      `SELECT v.id, v.registration, v.normalised, v.is_junk, v.notes,
              v.first_seen_at, v.last_seen_at,
              t.truck_number, v.truck_id,
              s.name AS supplier_name, v.supplier_id,
              COALESCE(st.trips, 0)      AS trips,
              COALESCE(st.total_kg, 0)   AS total_kg,
              st.avg_kg,
              -- The tare a lorry usually shows. A drift in this is the shape a
              -- weighbridge fiddle takes, so it is worth having in front of
              -- somebody even though nothing acts on it automatically.
              st.usual_tare_kg,
              (SELECT count(*)::int FROM weighbridge_vehicle_aliases a WHERE a.vehicle_id = v.id) AS alias_count
       FROM weighbridge_vehicles v
       LEFT JOIN trucks t       ON t.id = v.truck_id
       LEFT JOIN rm_suppliers s ON s.id = v.supplier_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS trips,
                sum(wt.net_weight_kg)::bigint AS total_kg,
                round(avg(wt.net_weight_kg))::int AS avg_kg,
                mode() WITHIN GROUP (ORDER BY wt.empty_weight_kg) AS usual_tare_kg
         FROM weighbridge_tickets wt
         WHERE wt.vehicle_id = v.id
           AND wt.match_status <> 'ignored'
           AND (wt.weighed_at IS NULL OR wt.weighed_at >= now() - ($1 || ' days')::interval)
       ) st ON true
       ORDER BY COALESCE(st.trips, 0) DESC, v.last_seen_at DESC
       LIMIT 500`,
      [String(days)]
    );

    // The spellings that have been merged into each lorry, so the screen can
    // show what it absorbed rather than hiding the operator's actual typing.
    const { rows: aliases } = await query(
      `SELECT vehicle_id, raw_sample FROM weighbridge_vehicle_aliases WHERE vehicle_id IS NOT NULL ORDER BY raw_sample`
    );
    const byVehicle = new Map();
    for (const a of aliases) {
      if (!byVehicle.has(a.vehicle_id)) byVehicle.set(a.vehicle_id, []);
      byVehicle.get(a.vehicle_id).push(a.raw_sample);
    }

    const [trucks, suppliers] = await Promise.all([
      query(`SELECT id, truck_number AS name FROM trucks WHERE is_active = true ORDER BY truck_number`),
      query(`SELECT id, name FROM rm_suppliers WHERE is_active = true ORDER BY name`),
    ]);

    res.json({
      vehicles: rows.map((r) => ({ ...r, aliases: byVehicle.get(r.id) || [] })),
      options: { trucks: trucks.rows, suppliers: suppliers.rows },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the vehicles." });
  }
});

// Say who a lorry belongs to, correct its registration, or mark it junk.
// Nothing here is required for the feed to work — it is all enrichment.
router.patch("/vehicles/:id", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "edit"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid vehicle id." });

  const body = req.body || {};

  // ROUND 158 — this used to test only for "" and undefined, and then called
  // Number() on whatever was left. The screen sends an explicit JSON null for
  // the owner you did NOT pick, and Number(null) is 0, not null — so every
  // assignment arrived looking like "truck 0 AND supplier 7" and was rejected
  // by the either/or check below. Truck, supplier and junk were all broken;
  // the endpoint only ever worked from curl, where the unused field really was
  // absent. Treat null as "not given", which is what the client means by it.
  const asId = (v) =>
    v === "" || v === null || v === undefined ? null : Number(v);
  const truckId = asId(body.truck_id);
  const supplierId = asId(body.supplier_id);
  if (truckId !== null && supplierId !== null) {
    return res.status(400).json({ error: "A lorry is either one of ours or a supplier's, not both." });
  }
  if ((truckId !== null && !Number.isInteger(truckId)) || (supplierId !== null && !Number.isInteger(supplierId))) {
    return res.status(400).json({ error: "Invalid owner." });
  }

  try {
    const { rows } = await query(
      `UPDATE weighbridge_vehicles
          SET truck_id     = $2,
              supplier_id  = $3,
              is_junk      = COALESCE($4, is_junk),
              registration = COALESCE($5, registration),
              notes        = COALESCE($6, notes),
              updated_by   = $7
        WHERE id = $1
        RETURNING id, registration, truck_id, supplier_id, is_junk`,
      [id, truckId, supplierId,
       typeof body.is_junk === "boolean" ? body.is_junk : null,
       body.registration ? String(body.registration).trim().slice(0, 60) : null,
       body.notes === undefined ? null : String(body.notes).slice(0, 500),
       req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Vehicle not found." });

    // Saying "this lorry is our TM-03" has to reach the tickets that already
    // carry it, or the truck link would only apply to loads weighed from now
    // on — the same retroactivity the material mappings have.
    await query(
      `UPDATE weighbridge_tickets SET truck_id = $2
        WHERE vehicle_id = $1 AND match_status <> 'ignored'`,
      [id, rows[0].is_junk ? null : rows[0].truck_id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the vehicle." });
  }
});

// Fold one registry row into another — the typo case (31KL77D4 into KL77D4231).
// The losing row's tickets are repointed and an alias is left behind, so the
// same misspelling arriving again lands on the right lorry without anybody
// doing this twice.
router.post("/vehicles/:id/merge", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "edit"), async (req, res) => {
  const fromId = Number(req.params.id);
  const intoId = Number(req.body?.into_id);
  if (!(Number.isInteger(fromId) && fromId > 0) || !(Number.isInteger(intoId) && intoId > 0)) {
    return res.status(400).json({ error: "Invalid vehicle id." });
  }
  if (fromId === intoId) return res.status(400).json({ error: "That is the same vehicle." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: both } = await client.query(
      `SELECT id, normalised, registration FROM weighbridge_vehicles WHERE id = ANY($1::int[])`,
      [[fromId, intoId]]
    );
    if (both.length !== 2) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "One of those vehicles no longer exists." });
    }
    const from = both.find((v) => v.id === fromId);

    const moved = await client.query(
      `UPDATE weighbridge_tickets SET vehicle_id = $2 WHERE vehicle_id = $1 RETURNING ticket_number`,
      [fromId, intoId]
    );
    // Leave the trail: the spelling that was merged keeps pointing at the
    // winner, so it resolves straight there next time.
    await client.query(
      `INSERT INTO weighbridge_vehicle_aliases (normalised, raw_sample, vehicle_id, is_ignored, mapped_by)
       VALUES ($1, $2, $3, false, $4)
       ON CONFLICT (normalised) DO UPDATE SET vehicle_id = EXCLUDED.vehicle_id, mapped_at = now()`,
      [from.normalised, from.registration, intoId, req.user.id]
    );
    await client.query(`DELETE FROM weighbridge_vehicles WHERE id = $1`, [fromId]);
    // The winner now covers the whole period both rows spanned.
    await client.query(
      `UPDATE weighbridge_vehicles v
          SET first_seen_at = LEAST(v.first_seen_at, $2::timestamptz),
              last_seen_at  = GREATEST(v.last_seen_at, $3::timestamptz)
        WHERE v.id = $1`,
      [intoId, req.body?.first_seen_at || new Date().toISOString(), req.body?.last_seen_at || new Date().toISOString()]
    );
    await client.query("COMMIT");
    res.json({ ok: true, tickets_moved: moved.rows.length });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not merge the vehicles." });
  } finally {
    client.release();
  }
});

export default router;
