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
import { loadResolver, resolveTicket, normalise } from "../lib/weighbridgeNames.js";

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
  "material_id", "supplier_id", "truck_id", "match_status", "unresolved", "source_hash",
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
              r.id AS receipt_id
       FROM weighbridge_tickets wb
       LEFT JOIN rm_materials m ON m.id = wb.material_id
       LEFT JOIN rm_suppliers s ON s.id = wb.supplier_id
       LEFT JOIN trucks t       ON t.id = wb.truck_id
       LEFT JOIN rm_receipts r  ON r.weighbridge_ticket_id = wb.ticket_number
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
router.get("/unmapped", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `WITH flagged AS (
         SELECT ticket_number, weighed_at, unresolved,
                raw_material, raw_supplier, raw_vehicle
         FROM weighbridge_tickets
         WHERE match_status <> 'ignored' AND array_length(unresolved, 1) > 0
       )
       SELECT kind, raw_sample, n, last_seen FROM (
         SELECT 'material' AS kind,
                (array_agg(raw_material ORDER BY weighed_at DESC NULLS LAST))[1] AS raw_sample,
                count(*)::int AS n, max(weighed_at) AS last_seen,
                upper(regexp_replace(COALESCE(raw_material, ''), '[^A-Za-z0-9]', '', 'g')) AS norm
         FROM flagged WHERE 'material' = ANY(unresolved) GROUP BY norm
         UNION ALL
         SELECT 'supplier',
                (array_agg(raw_supplier ORDER BY weighed_at DESC NULLS LAST))[1],
                count(*)::int, max(weighed_at),
                upper(regexp_replace(COALESCE(raw_supplier, ''), '[^A-Za-z0-9]', '', 'g'))
         FROM flagged WHERE 'supplier' = ANY(unresolved) GROUP BY 5
         UNION ALL
         SELECT 'vehicle',
                (array_agg(raw_vehicle ORDER BY weighed_at DESC NULLS LAST))[1],
                count(*)::int, max(weighed_at),
                upper(regexp_replace(COALESCE(raw_vehicle, ''), '[^A-Za-z0-9]', '', 'g'))
         FROM flagged WHERE 'vehicle' = ANY(unresolved) GROUP BY 5
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
    const [mat, sup, veh, materials, suppliers, trucks] = await Promise.all([
      query(`SELECT a.id, a.normalised, a.raw_sample, a.is_ignored, a.mapped_at, m.name AS target
             FROM weighbridge_material_aliases a LEFT JOIN rm_materials m ON m.id = a.material_id ORDER BY a.raw_sample`),
      query(`SELECT a.id, a.normalised, a.raw_sample, a.is_ignored, a.mapped_at, s.name AS target
             FROM weighbridge_supplier_aliases a LEFT JOIN rm_suppliers s ON s.id = a.supplier_id ORDER BY a.raw_sample`),
      query(`SELECT a.id, a.normalised, a.raw_sample, a.is_ignored, a.mapped_at, t.truck_number AS target
             FROM weighbridge_vehicle_aliases a LEFT JOIN trucks t ON t.id = a.truck_id ORDER BY a.raw_sample`),
      query(`SELECT id, name FROM rm_materials WHERE is_active = true ORDER BY name`),
      query(`SELECT id, name FROM rm_suppliers WHERE is_active = true ORDER BY name`),
      query(`SELECT id, truck_number AS name FROM trucks WHERE is_active = true ORDER BY truck_number`),
    ]);
    res.json({
      material: mat.rows, supplier: sup.rows, vehicle: veh.rows,
      options: { material: materials.rows, supplier: suppliers.rows, vehicle: trucks.rows },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the name mappings." });
  }
});

const ALIAS_TABLES = {
  material: { table: "weighbridge_material_aliases", idCol: "material_id", master: "rm_materials" },
  supplier: { table: "weighbridge_supplier_aliases", idCol: "supplier_id", master: "rm_suppliers" },
  vehicle:  { table: "weighbridge_vehicle_aliases",  idCol: "truck_id",    master: "trucks" },
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
  const { rows } = await query(
    `SELECT ticket_number, raw_material, raw_material_code, raw_supplier, raw_vehicle
     FROM weighbridge_tickets
     WHERE match_status = 'needs_review'
        OR (match_status = 'matched' AND array_length(unresolved, 1) > 0)`
  );
  let cleared = 0;
  for (const t of rows) {
    const r = resolveTicket(resolver, t);
    await query(
      `UPDATE weighbridge_tickets
          SET material_id = $2, supplier_id = $3, truck_id = $4,
              match_status = $5::wb_match_status, unresolved = $6
        WHERE ticket_number = $1`,
      [t.ticket_number, r.material_id, r.supplier_id, r.truck_id, r.match_status, r.unresolved]
    );
    if (r.match_status === "matched") cleared++;
  }
  return cleared;
}

router.post("/aliases", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "create"), async (req, res) => {
  const kind = req.body?.kind;
  const spec = ALIAS_TABLES[kind];
  if (!spec) return res.status(400).json({ error: "kind must be material, supplier or vehicle." });

  const rawSample = String(req.body?.raw_sample ?? "").trim();
  const norm = normalise(rawSample);
  if (!norm) return res.status(400).json({ error: "That name is empty once punctuation is removed — there is nothing to map." });

  const isIgnored = req.body?.is_ignored === true;
  const targetId = isIgnored ? null : Number(req.body?.target_id);
  if (!isIgnored && !Number.isInteger(targetId)) {
    return res.status(400).json({ error: "Pick something to map it to, or mark it ignored." });
  }

  try {
    if (!isIgnored) {
      const { rows: exists } = await query(`SELECT 1 FROM ${spec.master} WHERE id = $1`, [targetId]);
      if (!exists.length) return res.status(400).json({ error: "That record no longer exists." });
    }
    // Re-mapping an existing alias is a normal correction, so this upserts
    // rather than refusing. The old mapping is replaced and the affected
    // tickets are re-resolved below.
    await query(
      `INSERT INTO ${spec.table} (normalised, raw_sample, ${spec.idCol}, is_ignored, mapped_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (normalised) DO UPDATE SET
         raw_sample = EXCLUDED.raw_sample,
         ${spec.idCol} = EXCLUDED.${spec.idCol},
         is_ignored = EXCLUDED.is_ignored,
         mapped_by = EXCLUDED.mapped_by,
         mapped_at = now()`,
      [norm, rawSample.slice(0, 150), targetId, isIgnored, req.user.id]
    );
    const cleared = await reresolveOutstanding();
    res.json({ ok: true, normalised: norm, tickets_cleared: cleared });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the mapping." });
  }
});

router.delete("/aliases/:kind/:id", requireRole(...MAPPING_ROLES), requirePermission("material.weighbridge-mapping", "edit"), async (req, res) => {
  const spec = ALIAS_TABLES[req.params.kind];
  const id = Number(req.params.id);
  if (!spec) return res.status(400).json({ error: "kind must be material, supplier or vehicle." });
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid mapping id." });
  try {
    const { rowCount } = await query(`DELETE FROM ${spec.table} WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Mapping not found." });
    // Removing a mapping can only ever push tickets back into the queue, but
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

export default router;
