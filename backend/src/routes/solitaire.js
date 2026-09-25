// Solitaire — self-contained "RMC Delivery Challan" / Batching Docket
// module (see handoff package 00_START_HERE.md and the schema.sql
// "SOLITAIRE MODULE" section). Own login, own device-lock, own master data.
// Nothing here touches the main app's users/customers/sites/trucks/
// mix_designs tables or its requireAuth/requireRole — see
// middleware/solitaireAuth.js.
//
// IMPORTANT — read before touching the print flow: the real "fill the
// Excel workbook and export" pipeline (03_EXCEL_PRINT_PIPELINE.md) still
// needs a server-side spreadsheet engine (LibreOffice headless) that this
// dev session does not have. POST /dockets below accepts a PDF the FRONTEND
// already generated (via solitaireDocketPdf.js, a jsPDF placeholder matching
// this app's existing PDF-generator pattern) and just stores + indexes it.
// Every docket saved this way is flagged is_placeholder_pdf = true.
//
// ROUND 160 — the workbook itself is no longer the blocker. BPR107a.xlsm has
// arrived with sheets 1-10, and lib/mixtrackWorkbook.js now holds the complete
// cell map the fill step will use. A docket already carries every value those
// cells need, so building the fill step is a matter of the engine alone.
//
// What changed in the workbook: M32 (Recipe Name), AZ32 (Driver Name) and
// AZ34 (Order No) used to be formulas the sheet worked out for itself. The
// user removed all three, so MixTrack supplies them — see the columns added in
// schema.sql. The Batch Time block was removed at the same time; the batch's
// timing is K19/K21 on the Load sheet now, straight from the plant's clock.
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool, query } from "../db.js";
import {
  sheetNumberForLoad, batchEndWithDelay, buildLoadSheetValues, LOAD_SHEET_CELLS,
  buildMixDesignRows, mixDesignRowsToClear, MIX_DESIGN_SHEET_COLUMNS, SAVE_FOLDER_CELL,
} from "../lib/mixtrackWorkbook.js";
import {
  signSolitaireSession, generateDeviceToken, cookieOptions, requireSolitaireConfigured,
  SESSION_COOKIE, DEVICE_COOKIE, SESSION_MAX_AGE_MS, DEVICE_MAX_AGE_MS,
} from "../lib/solitaireAuth.js";
import { requireSolitaireAuth, requireSolitaireRole } from "../middleware/solitaireAuth.js";
import { requirePluginEnabled } from "../lib/plugins.js";

const router = Router();

// Round 149 — the plugin gate, mounted above EVERYTHING including /login.
//
// This is what makes a Super Admin switching the module off actually mean
// something. Hiding the Plant Operator icon is presentation; this is the gate.
// Because it sits above /login, a browser that still holds a valid Solitaire
// session cookie from before the switch cannot keep working either — every
// route in the module answers 404 while the plugin is off, and comes back
// exactly as it was when it is switched on again. Nothing is deleted by
// disabling: the accounts, devices, masters and printed dockets all stay.
// ROUND 161 — the print agent's router, exported separately.
//
// It is NOT under the guards below: the agent has no browser session, no
// device cookie and no MixTrack account. It authenticates with an API key,
// exactly as the weighbridge and plant agents do. It IS still behind the
// plugin switch, because a module the business has switched off must not keep
// printing tickets.
export const printRouter = Router();
printRouter.use(requirePluginEnabled("solitaire"));

router.use(requirePluginEnabled("solitaire"));
router.use(requireSolitaireConfigured);

const MASTERS_ROLES = ["operator", "qc", "admin"]; // Customer & Site, Truck & Driver — QC's scope was widened to include these this round (was Mix-Design-only in the original mockup guess)
const MIX_DESIGN_ROLES = ["qc", "admin"]; // exclusive, per §3/§5

// Round 152 — the mix-design columns, in ONE place, because three things now
// write them: create, update and the bulk upload. They mirror the workbook's
// own Mix Design sheet rather than inventing names, so a column there maps to
// a column here without a translation table to keep in step.
const MIX_FIELDS = [
  "code", "name",
  "msand_kgm3", "msand2_kgm3", "agg_12mm_kgm3", "agg_20mm_kgm3",
  "cem1_kgm3", "cem2_kgm3", "cem3_kgm3", "admix1_kgm3", "admix2_kgm3", "water_kgm3",
  "absorb_msand_pct", "absorb_msand2_pct", "absorb_12mm_pct", "absorb_20mm_pct",
  "moisture_msand_pct", "moisture_msand2_pct", "moisture_12mm_pct", "moisture_20mm_pct",
  "water_var_min_pct", "water_var_max_pct",
];
// Everything except the two text columns is a number defaulting to 0.
const MIX_NUMERIC = MIX_FIELDS.filter((f) => f !== "code" && f !== "name");

/* =========================================================================
 * LOGIN  (public — this endpoint IS the login, so it runs before requireSolitaireAuth)
 * ===================================================================== */
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  // Round 150 — optional; only consulted when this browser is not already
  // authorized. Normal day-to-day logins never send it.
  const pairingCode = String((req.body || {}).device_code || "").trim().toUpperCase();
  if (!username || !password) return res.status(400).json({ error: "Username and password are required." });

  const { rows } = await query(
    `SELECT * FROM solitaire_accounts WHERE username = $1 AND is_active = true`,
    [username.trim()]
  );
  const account = rows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  // ---- Device lock (§2.2) — company-wide allowlist, independent of role ----
  const existingDeviceToken = req.cookies?.[DEVICE_COOKIE];
  let device = null;
  if (existingDeviceToken) {
    const { rows: d } = await query(
      `SELECT id FROM solitaire_devices WHERE device_token = $1 AND revoked_at IS NULL`,
      [existingDeviceToken]
    );
    device = d[0] || null;
  }

  if (!device) {
    const { rows: activeCount } = await query(
      `SELECT COUNT(*)::int AS n FROM solitaire_devices WHERE revoked_at IS NULL`
    );
    const noDevicesRegisteredYet = activeCount[0].n === 0;

    // Bootstrap escape hatch: on a completely fresh install with zero
    // registered devices, the very first Admin login is let through and
    // immediately registers this browser — otherwise nobody could ever
    // reach the Device Management screen that's supposed to be how devices
    // get authorized in the first place.
    if (noDevicesRegisteredYet && account.role === "admin") {
      const newToken = generateDeviceToken();
      await query(
        `INSERT INTO solitaire_devices (device_token, label, registered_by) VALUES ($1, $2, $3)`,
        [newToken, "Bootstrap device (auto-registered on first Admin login)", account.id]
      );
      res.cookie(DEVICE_COOKIE, newToken, cookieOptions(DEVICE_MAX_AGE_MS));

    } else if (pairingCode) {
      // Round 150 — the pairing code, which is the ONLY way a brand-new
      // machine can join once a first device exists.
      //
      // Before this, it could not: POST /devices registers the browser making
      // the call and requires a signed-in session, but signing in requires an
      // already-authorized browser. The bootstrap above only fires at zero
      // devices, so raising max_devices created slots nothing could ever fill
      // and the module supported exactly one browser. That defect shipped in
      // Round 149 because the verification only ever drove one browser.
      //
      // Redeemed here, at login, rather than on a separate endpoint: this is
      // the one moment a brand-new browser is talking to us and has no session
      // to authenticate with, so it is the only place the exchange can happen.
      // The account's own username and password are still checked above, so a
      // code alone gets nobody in — it authorizes the BROWSER, not the person.
      // The limit is checked BEFORE the code is claimed. Claiming first would
      // burn somebody's one-shot code on a refusal they had no way to foresee,
      // leaving them to walk back and ask for another.
      const { rows: capRow } = await query(`SELECT value FROM solitaire_settings WHERE key = 'max_devices'`);
      const maxDevices = Number(capRow[0]?.value || 3);
      if (activeCount[0].n >= maxDevices) {
        return res.status(403).json({
          error: `All ${maxDevices} device slots are in use. An Administrator must revoke one before this browser can be authorized.`,
          code: "DEVICE_LIMIT_REACHED",
        });
      }

      // Claimed with a single conditional UPDATE rather than SELECT-then-UPDATE.
      // Two machines typing the same code at the same moment would both pass a
      // SELECT and both get authorized, spending two slots on one code — the
      // classic check-then-act race. Postgres serialises this UPDATE, so
      // exactly one of them gets a row back and the other is told the code is
      // already used, which is the truth.
      const { rows: codeRows } = await query(
        `UPDATE solitaire_pairing_codes SET used_at = now()
          WHERE code = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING id, label`,
        [pairingCode]
      );
      if (!codeRows.length) {
        return res.status(403).json({
          error: "That device code is wrong, already used, or has expired. Ask an Administrator for a new one.",
          code: "PAIRING_CODE_INVALID",
        });
      }

      const newToken = generateDeviceToken();
      const { rows: created } = await query(
        `INSERT INTO solitaire_devices (device_token, label, registered_by) VALUES ($1, $2, $3) RETURNING id`,
        [newToken, codeRows[0].label || "Authorized by device code", account.id]
      );
      // used_at was already set by the claim above; this records WHICH device
      // the code created, for the audit trail.
      await query(
        `UPDATE solitaire_pairing_codes SET used_device_id = $1 WHERE id = $2`,
        [created[0].id, codeRows[0].id]
      );
      res.cookie(DEVICE_COOKIE, newToken, cookieOptions(DEVICE_MAX_AGE_MS));

    } else {
      return res.status(403).json({
        error: "This browser/device is not authorized to open MixTrack. Enter a device code from your Administrator, or ask them to authorize this machine.",
        code: "DEVICE_NOT_AUTHORIZED",
      });
    }
  }

  const sessionToken = signSolitaireSession(account);
  res.cookie(SESSION_COOKIE, sessionToken, cookieOptions(SESSION_MAX_AGE_MS));
  res.json({ account: { username: account.username, displayName: account.display_name, role: account.role } });
});

router.post("/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

router.get("/me", requireSolitaireAuth, (req, res) => {
  const a = req.solitaireAccount;
  res.json({ username: a.username, displayName: a.display_name, role: a.role });
});

/* =========================================================================
 * DEVICE MANAGEMENT — Admin only (§2.2)
 * ===================================================================== */
router.get("/devices", requireSolitaireAuth, requireSolitaireRole("admin"), async (req, res) => {
  const { rows } = await query(
    `SELECT d.id, d.label, d.registered_at, d.last_used_at, d.revoked_at,
            a.display_name AS registered_by_name
     FROM solitaire_devices d
     LEFT JOIN solitaire_accounts a ON a.id = d.registered_by
     ORDER BY d.registered_at DESC`
  );
  res.json(rows);
});

// Registers the CURRENT browser as authorized. Day-to-day path once
// bootstrap is done: an already-authorized Admin opens Solitaire on a new
// terminal (carrying their own session there — e.g. by logging in with
// their credentials on a device that itself isn't authorized yet won't
// work, since login itself is gated; the practical route is either (a)
// temporarily raising max_devices and having someone with API access
// register it, or (b) the more common case of an Admin who is ALREADY
// signed in on an authorized device using this to add ANOTHER browser they
// have open on that same authorized machine). This mirrors exactly what the
// functional spec describes; it does not attempt to solve "authorize a
// brand new physical machine with nobody's cookie on it yet" beyond the
// bootstrap case above.
router.post("/devices", requireSolitaireAuth, requireSolitaireRole("admin"), async (req, res) => {
  const { label } = req.body || {};
  const { rows: capRow } = await query(`SELECT value FROM solitaire_settings WHERE key = 'max_devices'`);
  const maxDevices = Number(capRow[0]?.value || 2);
  const { rows: activeCount } = await query(`SELECT COUNT(*)::int AS n FROM solitaire_devices WHERE revoked_at IS NULL`);
  if (activeCount[0].n >= maxDevices) {
    return res.status(400).json({
      error: `Already at the configured limit of ${maxDevices} authorized device(s). Revoke one first, or raise the limit in Settings.`,
    });
  }
  const existing = req.cookies?.[DEVICE_COOKIE];
  if (existing) {
    const { rows: already } = await query(
      `SELECT id FROM solitaire_devices WHERE device_token = $1 AND revoked_at IS NULL`, [existing]
    );
    if (already.length) return res.status(400).json({ error: "This browser is already authorized." });
  }
  const token = generateDeviceToken();
  const { rows } = await query(
    `INSERT INTO solitaire_devices (device_token, label, registered_by) VALUES ($1, $2, $3) RETURNING id, label, registered_at`,
    [token, label || "Unnamed device", req.solitaireAccount.id]
  );
  res.cookie(DEVICE_COOKIE, token, cookieOptions(DEVICE_MAX_AGE_MS));
  res.status(201).json(rows[0]);
});

// Round 150 — mint a one-time device code, from an already-authorized browser.
//
// Deliberately NOT tied to the browser that creates it: the whole point is to
// authorize a DIFFERENT machine. The Admin reads the code off this screen and
// types it on the new terminal.
//
// Short alphabet and short life, because it gets read aloud or written on a
// scrap of paper: no 0/O/1/I/5/S to misread, 8 characters, 15 minutes. Single
// use, enforced when it is redeemed in /login.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXY2346789";
const CODE_TTL_MINUTES = 15;

function makeCode() {
  let out = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

router.post("/devices/pairing-code", requireSolitaireAuth, requireSolitaireRole("admin"), async (req, res) => {
  const { label } = req.body || {};

  // Refuse up front when there is no slot, rather than letting somebody carry
  // a code across the plant only to be told at the far end.
  const { rows: capRow } = await query(`SELECT value FROM solitaire_settings WHERE key = 'max_devices'`);
  const maxDevices = Number(capRow[0]?.value || 3);
  const { rows: activeCount } = await query(`SELECT COUNT(*)::int AS n FROM solitaire_devices WHERE revoked_at IS NULL`);
  if (activeCount[0].n >= maxDevices) {
    return res.status(400).json({
      error: `All ${maxDevices} device slots are in use. Revoke one first, or raise the limit in Settings.`,
    });
  }

  // Any earlier unused codes are retired, so exactly one is live at a time and
  // an old scrap of paper can never authorize a machine months later.
  await query(
    `UPDATE solitaire_pairing_codes SET used_at = now() WHERE used_at IS NULL AND expires_at > now()`
  );

  const code = makeCode();
  const { rows } = await query(
    `INSERT INTO solitaire_pairing_codes (code, label, created_by, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
     RETURNING code, expires_at`,
    [code, label || null, req.solitaireAccount.id, String(CODE_TTL_MINUTES)]
  );
  res.status(201).json({ ...rows[0], expires_in_minutes: CODE_TTL_MINUTES });
});

router.delete("/devices/:id", requireSolitaireAuth, requireSolitaireRole("admin"), async (req, res) => {
  await query(
    `UPDATE solitaire_devices SET revoked_at = now(), revoked_by = $1 WHERE id = $2 AND revoked_at IS NULL`,
    [req.solitaireAccount.id, req.params.id]
  );
  res.json({ ok: true });
});

/* =========================================================================
 * SETTINGS — Admin only. §7: "this path must never be shown or editable on
 * the data entry screen" — enforced simply by there being no other route
 * that returns it, and by this route requiring the admin role.
 * ===================================================================== */
router.get("/settings", requireSolitaireAuth, requireSolitaireRole("admin"), async (req, res) => {
  const { rows } = await query(`SELECT key, value FROM solitaire_settings`);
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

router.patch("/settings", requireSolitaireAuth, requireSolitaireRole("admin"), async (req, res) => {
  const allowed = ["save_folder_path", "default_printer", "max_devices"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      await query(
        `INSERT INTO solitaire_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
        [key, String(req.body[key]), req.solitaireAccount.id]
      );
    }
  }
  res.json({ ok: true });
});

/* =========================================================================
 * MASTER DATA
 * ===================================================================== */
// Round 152 — customers and sites now come from the MAIN app's tables, not
// the module's own copies.
//
// Round 139 deliberately shared nothing, which was right for a standalone
// package. As a plugin it only meant entering every customer and site twice
// and watching the two lists drift. These are READ-ONLY here on purpose: the
// module has its own login, separate from the main app's, so a Solitaire
// account must not be able to create or rename a customer the whole business
// invoices against. That is done in the main app, by people whose permissions
// the main app checks.
//
// `code` is the Round 152 column on customers — the MCI370 screen's "Customer
// Code". It is optional, so fall back to the id so the dropdown always has
// something to show rather than a blank.
router.get("/customers", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, COALESCE(code, 'C' || id::text) AS code, name FROM customers WHERE is_active ORDER BY name`
  );
  const { rows: sites } = await query(
    `SELECT s.id, s.customer_id, s.name FROM sites s JOIN customers c ON c.id = s.customer_id
     WHERE c.is_active ORDER BY s.name`
  );
  const byCustomer = {};
  sites.forEach((s) => { (byCustomer[s.customer_id] ||= []).push(s); });
  res.json(rows.map((c) => ({ ...c, sites: byCustomer[c.id] || [] })));
});

router.get("/trucks", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, truck_number AS registration_number, truck_code, capacity_m3
       FROM trucks WHERE is_active ORDER BY truck_number`
  );
  res.json(rows);
});

// Drivers are real main-app user accounts. The workbook derives the driver
// from the truck by lookup — one fixed driver per vehicle — but drivers change
// from trip to trip, so the docket records who actually drove and the
// workbook's lookup is fed from that rather than the other way round.
router.get("/drivers", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, name FROM users WHERE role = 'driver' AND is_active ORDER BY name`
  );
  res.json(rows);
});

// Round 152 — the module's own customer / site / truck WRITE endpoints are
// gone. They wrote to solitaire_customers, solitaire_sites and
// solitaire_trucks, which nothing reads any more: the dropdowns above come
// from the main app's tables. Those three tables are left in place rather than
// dropped, so nothing is destroyed if this decision is ever revisited, but
// they are dead.
//
// Deliberately NOT replaced with endpoints that write to the MAIN tables. A
// Solitaire session is a separate trust boundary with its own login; it must
// not be able to create or rename a customer the business invoices against.
// That belongs in the main app, where the main app's permissions apply.

// ROUND 161 — one place that writes the mix-design audit trail, so create,
// update, deactivate and seed cannot record it differently. Best-effort: a
// failure to log must never lose the edit itself.
async function logMixDesign(id, action, before, after, accountId, note) {
  try {
    await query(
      `INSERT INTO mixtrack_mix_design_log (mix_design_id, action, before_json, after_json, changed_by, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, accountId || null, note || null]
    );
  } catch (err) {
    console.error("mix design log failed", err.message);
  }
}

router.get("/mix-designs", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM solitaire_mix_designs WHERE is_active ORDER BY code`);
  res.json(rows);
});

router.post("/mix-designs", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  const body = req.body || {};
  if (!body.code) return res.status(400).json({ error: "Recipe code is required." });
  const values = MIX_FIELDS.map((f) =>
    f === "code" ? String(body.code).trim()
    : f === "name" ? (body.name || String(body.code).trim())
    : Number(body[f]) || 0
  );
  const cols = MIX_FIELDS.join(", ");
  const params = MIX_FIELDS.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await query(
    `INSERT INTO solitaire_mix_designs (${cols}) VALUES (${params}) RETURNING *`, values
  );
  // ROUND 161 — logged. These numbers decide what is printed on a customer's
  // ticket and what the plant is judged against, and the row itself only ever
  // holds the current value.
  await logMixDesign(rows[0].id, "create", null, rows[0], req.solitaireAccount.id, req.body.note);
  res.status(201).json(rows[0]);
});

router.patch("/mix-designs/:id", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  const fields = [...MIX_FIELDS, "is_active"];
  const sets = []; const vals = []; let i = 1;
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f} = $${i++}`); vals.push(req.body[f]); }
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  vals.push(req.params.id);
  const { rows: before } = await query(`SELECT * FROM solitaire_mix_designs WHERE id = $1`, [req.params.id]);
  const { rows } = await query(`UPDATE solitaire_mix_designs SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals);
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  await logMixDesign(rows[0].id, "update", before[0] || null, rows[0], req.solitaireAccount.id, req.body.note);
  res.json(rows[0]);
});

router.delete("/mix-designs/:id", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  const { rows: before } = await query(`SELECT * FROM solitaire_mix_designs WHERE id = $1`, [req.params.id]);
  // Refused while a recipe still maps to it, rather than cascading. The
  // mapping is a human decision and deactivating out from under it would leave
  // loads silently unprintable with no trace of why.
  const { rows: inUse } = await query(
    `SELECT mci370_code FROM mixtrack_recipe_map WHERE mix_design_id = $1`, [req.params.id]
  );
  if (inUse.length) {
    return res.status(409).json({
      error: `Still mapped from MCI370 recipe ${inUse.map((r) => `"${r.mci370_code}"`).join(", ")}. Re-map those first, or their loads will stop printing.`,
    });
  }
  const { rows } = await query(
    `UPDATE solitaire_mix_designs SET is_active = false WHERE id = $1 RETURNING *`, [req.params.id]
  );
  if (rows.length) await logMixDesign(rows[0].id, "deactivate", before[0] || null, rows[0], req.solitaireAccount.id, req.body?.note);
  res.json({ ok: true });
});

// ROUND 161 — the edit history for one design, newest first.
router.get("/mix-designs/:id/history", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.action, l.before_json, l.after_json, l.note,
            a.display_name AS changed_by_name,
            to_char(l.changed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS changed_at
       FROM mixtrack_mix_design_log l
       LEFT JOIN solitaire_accounts a ON a.id = l.changed_by
      WHERE l.mix_design_id = $1
      ORDER BY l.changed_at DESC LIMIT 100`,
    [req.params.id]
  );
  res.json(rows);
});

/* -------------------------------------------------------------------------
 * ROUND 161 — seed the recipes the workbook never had.
 *
 * Seven of the plant's recipes have NO row in the Mix Design sheet in any
 * spelling, and between them they account for 937 of 2,495 real loads (38%):
 * M25A (448), M30 B (210), M35 A (136), M25 E (85), M35 ULCCS (44),
 * WATER BATCH (12), M40 SCC (2). Mapping cannot point at a row that does not
 * exist, so those loads can never print until the designs are created.
 *
 * Rather than asking QC to type them, this seeds each one from the plant's
 * OWN design values — `<slot>_Rec` on the load header, stored per batch as
 * design_kg_per_m3 since Round 159. That is what the machine is actually
 * batching to, so QC reviews real numbers and corrects them rather than
 * starting from a blank row.
 *
 * Seeded designs are logged with action 'seed' so it is always clear which
 * numbers a human chose and which came from the plant.
 * --------------------------------------------------------------------- */
router.post("/mix-designs/seed-from-plant", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  // Which plant recipes have neither a mapping nor a design that normalises to
  // their code. The slot -> design column mapping mirrors lib/plantSlots.js's
  // own naming for this plant: gate2 is the working M Sand (gate1 is a spare
  // that has fired 23 times in 18,505 batches), gate3 is 12MM, gate4 is 20MM.
  const { rows: needed } = await query(
    `SELECT p.recipe_code,
            max(p.recipe_name) AS recipe_name,
            count(DISTINCT (p.plant_no, p.batch_year, p.batch_no)) AS loads
       FROM plant_batches p
      WHERE p.recipe_code IS NOT NULL AND p.recipe_code <> ''
        AND NOT EXISTS (SELECT 1 FROM mixtrack_recipe_map m WHERE m.mci370_code = p.recipe_code)
        AND NOT EXISTS (
              SELECT 1 FROM solitaire_mix_designs d
               WHERE d.is_active
                 AND upper(regexp_replace(d.code, '[^A-Za-z0-9]', '', 'g'))
                   = upper(regexp_replace(p.recipe_code, '[^A-Za-z0-9]', '', 'g')))
      GROUP BY p.recipe_code
      ORDER BY loads DESC`
  );
  if (!needed.length) return res.json({ created: 0, mapped: 0, recipes: [] });

  const SLOT_TO_FIELD = {
    gate2: "msand_kgm3", gate1: "msand2_kgm3", gate3: "agg_12mm_kgm3", gate4: "agg_20mm_kgm3",
    cement1: "cem1_kgm3", cement2: "cem2_kgm3", cement3: "cem3_kgm3",
    adm1a: "admix1_kgm3", adm2a: "admix2_kgm3", water1: "water_kgm3",
  };

  const out = [];
  let created = 0, mapped = 0;
  for (const r of needed) {
    // The design the plant has most recently been batching this recipe to.
    const { rows: design } = await query(
      `SELECT pm.slot, avg(pm.design_kg_per_m3) AS kgm3
         FROM plant_batch_materials pm
         JOIN plant_batches p ON p.id = pm.batch_id
        WHERE p.recipe_code = $1 AND pm.design_kg_per_m3 IS NOT NULL
          AND p.batch_date >= (SELECT max(batch_date) - 180 FROM plant_batches WHERE recipe_code = $1)
        GROUP BY pm.slot`,
      [r.recipe_code]
    );
    const fields = {};
    for (const d of design) {
      const f = SLOT_TO_FIELD[d.slot];
      if (f) fields[f] = Number(Number(d.kgm3).toFixed(3));
    }
    // A recipe the plant has run but for which it reported no design values at
    // all is left for a human. Creating an all-zero design would look complete
    // and print a ticket of zeros, which is exactly the failure being avoided.
    if (!Object.keys(fields).length) {
      out.push({ recipe_code: r.recipe_code, loads: Number(r.loads), created: false, reason: "the plant reported no design values for this recipe" });
      continue;
    }
    const cols = ["code", "name", ...Object.keys(fields)];
    const vals = [String(r.recipe_code).trim(), r.recipe_name || String(r.recipe_code).trim(), ...Object.values(fields)];
    const { rows: ins } = await query(
      `INSERT INTO solitaire_mix_designs (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      vals
    );
    created++;
    await logMixDesign(ins[0].id, "seed", null, ins[0],
      req.solitaireAccount.id,
      `Seeded from the plant's own design values for ${r.recipe_code} — review before it is used.`);
    // Mapped straight away: the code IS the plant's own, so there is nothing
    // for a human to decide here. QC still has to check the numbers, which is
    // what the 'seed' log entry is for.
    await query(
      `INSERT INTO mixtrack_recipe_map (mci370_code, mix_design_id, mapped_by, note)
       VALUES ($1,$2,$3,$4) ON CONFLICT (mci370_code) DO NOTHING`,
      [String(r.recipe_code).trim(), ins[0].id, req.solitaireAccount.id, "Auto-mapped to its seeded design"]
    );
    mapped++;
    out.push({ recipe_code: r.recipe_code, loads: Number(r.loads), created: true, mix_design_id: ins[0].id, fields });
  }
  res.json({ created, mapped, recipes: out });
});

// Round 152 — bulk upload of mix designs.
//
// The rows arrive as JSON, already parsed. The workbook is read in the BROWSER
// (the frontend has SheetJS bundled for the reports it already exports), which
// keeps a 400KB .xlsm off the wire and out of this process, and means no
// multipart handling or spreadsheet dependency on the server. The upload
// screen shows what it found before anything is written, so a wrong sheet or a
// shifted column is caught by eye rather than discovered in a printed docket.
//
// Upsert on `code`, because that is what the workbook looks recipes up by:
// re-uploading the sheet after editing a recipe should update it, not create a
// second one with the same name. A code present in the database but absent
// from the upload is left alone — an upload is "here are these recipes", never
// "these are the only recipes", so a partial sheet cannot silently retire the
// rest.
router.post("/mix-designs/bulk", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: "No rows were supplied." });
  if (rows.length > 500) return res.status(400).json({ error: "That is more than 500 recipes — split the upload." });

  const cleaned = [];
  const skipped = [];
  for (const [i, r] of rows.entries()) {
    const code = String(r.code ?? "").trim();
    // A blank code is a blank sheet row, not an error worth stopping for —
    // the Mix Design sheet has plenty of empty rows below the real ones.
    if (!code) { continue; }
    if (code.length > 40) { skipped.push({ row: i + 1, code, reason: "Recipe code is longer than 40 characters." }); continue; }
    const rec = { code, name: String(r.name ?? code).trim().slice(0, 120) };
    for (const f of MIX_NUMERIC) {
      const n = Number(r[f]);
      rec[f] = Number.isFinite(n) ? n : 0;
    }
    cleaned.push(rec);
  }
  if (!cleaned.length) return res.status(400).json({ error: "No rows had a recipe code." });

  // Last one wins on a duplicated code within the same upload, rather than
  // letting ON CONFLICT fire twice in one statement (which Postgres refuses).
  const byCode = new Map();
  for (const r of cleaned) byCode.set(r.code, r);
  const unique = [...byCode.values()];
  const duplicatesInFile = cleaned.length - unique.length;

  const cols = MIX_FIELDS.join(", ");
  const updates = MIX_FIELDS.filter((f) => f !== "code").map((f) => `${f} = EXCLUDED.${f}`).join(", ");
  let created = 0, updated = 0;
  for (const r of unique) {
    const { rows: out } = await query(
      `INSERT INTO solitaire_mix_designs (${cols})
       VALUES (${MIX_FIELDS.map((_, i) => `$${i + 1}`).join(",")})
       ON CONFLICT (code) DO UPDATE SET ${updates}, is_active = true
       RETURNING (xmax = 0) AS inserted`,
      MIX_FIELDS.map((f) => r[f])
    );
    if (out[0].inserted) created++; else updated++;
  }

  res.json({ created, updated, skipped, duplicates_in_file: duplicatesInFile, total_rows_seen: rows.length });
});

/* =========================================================================
 * DATA ENTRY / PRINT FLOW — §4, §6, §7
 * ===================================================================== */

// Sheet-selection number (§6) — shared by the read-only "Total Batch" field
// and by which pre-built workbook sheet gets printed.
//
// ROUND 160 — this now comes from lib/mixtrackWorkbook.js so it matches the
// workbook's own I40 formula, which is ceil(production quantity) clamped 1-10
// and depends on NOTHING ELSE. The version here divided by the mixer capacity.
// The two agree only because this plant's mixer is exactly 1 m3: at 0.5 m3 a
// 4 m3 load would have been recorded against sheet 8 while Excel printed
// sheet 4, and the ticket would have carried eight batch blocks for a load
// that had four.
function computeSheetNumber(prodQty) {
  return sheetNumberForLoad(prodQty);
}

// The QC allowance to add to the plant's finish time. Site wins over customer
// when both are set — the delay belongs to the pour, not to who is paying for
// it — and a row with neither is the plant-wide default.
async function qcDelayMinutes(customerId, siteId) {
  const { rows } = await query(
    `SELECT delay_minutes
       FROM mixtrack_qc_delays
      WHERE (site_id = $1)
         OR (site_id IS NULL AND customer_id = $2)
         OR (site_id IS NULL AND customer_id IS NULL)
      ORDER BY (site_id IS NOT NULL) DESC, (customer_id IS NOT NULL) DESC
      LIMIT 1`,
    [siteId || null, customerId || null]
  );
  return rows.length ? Number(rows[0].delay_minutes) || 0 : 0;
}

router.get("/next-batch-number", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT COALESCE(MAX(batch_number::int), 1200) + 1 AS next FROM solitaire_dockets WHERE batch_number ~ '^[0-9]+$'`
  );
  res.json({ next_batch_number: String(rows[0].next) });
});

// Validates the mandatory fields (§4.4) and returns the sheet number, for
// the data-entry screen's live "Total Batch" field and pre-print check.
router.post("/dockets/preview", requireSolitaireAuth, async (req, res) => {
  const { customer_id, site_id, mix_design_id, truck_id, production_qty_m3, mixer_capacity_m3 } = req.body || {};
  const missing = [];
  if (!customer_id) missing.push("Customer");
  if (!site_id) missing.push("Site");
  if (!mix_design_id) missing.push("Recipe Code");
  if (!truck_id) missing.push("Truck Registration Number");
  if (!production_qty_m3) missing.push("Production Qty");
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  // mixer_capacity_m3 is still read off the body above because the screen
  // sends it and it is still stored; it no longer decides the sheet.
  res.json({
    sheet_number: computeSheetNumber(production_qty_m3),
    mixer_capacity_m3: mixer_capacity_m3 ?? null,
    qc_delay_minutes: await qcDelayMinutes(customer_id, site_id),
  });
});

// Persists a printed docket + its PDF and indexes it for Search/Reprint
// (§7 step 5, §8). See the file-header comment — pdf_base64 is generated
// CLIENT-SIDE by the temporary solitaireDocketPdf.js until the real
// Excel-fill pipeline replaces it; is_placeholder_pdf is always true here.
router.post("/dockets", requireSolitaireAuth, async (req, res) => {
  const {
    batch_number, order_date_time, order_qty_m3, with_this_load_m3,
    customer_id, site_id, mix_design_id, truck_id, driver_name, driver_user_id,
    production_qty_m3, mixer_capacity_m3, moisture_pct,
    // ROUND 160 — the three the workbook no longer works out for itself,
    // plus the plant's own clock times behind K19 and K21.
    order_no, recipe_name, batch_started_at, batch_ended_at,
    pdf_base64, pdf_filename,
  } = req.body || {};

  const missing = [];
  if (!customer_id) missing.push("Customer");
  if (!site_id) missing.push("Site");
  if (!mix_design_id) missing.push("Recipe Code");
  if (!truck_id) missing.push("Truck Registration Number");
  if (!production_qty_m3) missing.push("Production Qty");
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  if (!pdf_base64 || !pdf_filename) return res.status(400).json({ error: "No PDF was generated for this docket." });

  const sheet_number = computeSheetNumber(production_qty_m3);

  // K21 = the plant's end time PLUS this customer's or site's QC allowance.
  //
  // The allowance is resolved and STORED on the docket rather than read back
  // when the ticket is reprinted. A reprint must reproduce the paper that was
  // handed over; if the setting is changed next month, an old ticket must not
  // quietly reprint with a different finish time.
  const qc_delay_minutes = await qcDelayMinutes(customer_id, site_id);
  const endedAt = batchEndWithDelay(batch_ended_at, qc_delay_minutes);

  const { rows } = await query(
    `INSERT INTO solitaire_dockets
     (batch_number, order_date_time, order_qty_m3, with_this_load_m3, customer_id, site_id, mix_design_id,
      truck_id, driver_name, driver_user_id, production_qty_m3, mixer_capacity_m3, moisture_pct, sheet_number,
      order_no, recipe_name, batch_started_at, batch_ended_at, qc_delay_minutes,
      pdf_filename, pdf_data, is_placeholder_pdf, printed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,$22)
     RETURNING id, batch_number, sheet_number, order_no, recipe_name,
               batch_started_at, batch_ended_at, qc_delay_minutes, pdf_filename, printed_at`,
    [batch_number || null, order_date_time || null, order_qty_m3 || null, with_this_load_m3 || null,
     customer_id, site_id, mix_design_id, truck_id, driver_name || null, driver_user_id || null,
     production_qty_m3, mixer_capacity_m3 || null, moisture_pct || null, sheet_number,
     order_no || null, recipe_name || null, batch_started_at || null, endedAt, qc_delay_minutes,
     pdf_filename, Buffer.from(pdf_base64, "base64"), req.solitaireAccount.id]
  );

  // §7 step 5's "save to the folder path configured in Admin Settings" — a
  // real filesystem write belongs here once this runs on a real server;
  // this dev session has no access to that filesystem, so it's a no-op that
  // just reports the configured path back to the frontend for now.
  const { rows: folderRow } = await query(`SELECT value FROM solitaire_settings WHERE key = 'save_folder_path'`);

  res.status(201).json({ ...rows[0], save_folder_path: folderRow[0]?.value || null });
});

/* =========================================================================
 * ROUND 161 — THE RECIPE MAP
 *
 * MCI370 and the workbook's Mix Design sheet spell the same recipe
 * differently and always will: the plant writes 'M25A', the sheet has
 * 'M 25 A'. Measured over 2,495 real loads, the plant's code matches a sheet
 * row EXACTLY — which is what VLOOKUP(..., FALSE) requires — on 2 loads.
 *
 * A human maps them, once per recipe. NOT normalise-and-hope: 'M25A' is one
 * edit away from 'M35A', and a wrong auto-match prints the wrong mix on a
 * document that goes to a customer. The same decision as the weighbridge's
 * name aliases, for the same reason.
 *
 * The suggestion below is a SUGGESTION and nothing more — it is shown beside
 * the dropdown, never applied.
 * ===================================================================== */

const RECIPE_MAP_ROLES = ["qc", "admin"];

// Uppercase, strip everything that is not a letter or digit. Same shape as
// lib/weighbridgeNames.js's normaliser, deliberately.
function normaliseRecipe(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

router.get("/recipe-map", requireSolitaireAuth, async (req, res) => {
  // Every recipe the plant has actually batched, with its mapping if it has
  // one. Driven from plant_batches rather than a master list, because what
  // matters is what the machine has really run — a recipe in MCI370's
  // Recipe_Master that has never been batched needs no mapping yet.
  const { rows } = await query(
    `SELECT p.recipe_code,
            max(p.recipe_name)                             AS recipe_name,
            count(DISTINCT (p.plant_no, p.batch_year, p.batch_no)) AS loads,
            to_char(max(p.batch_date), 'YYYY-MM-DD')       AS last_batched,
            m.id            AS map_id,
            m.mix_design_id,
            d.code          AS mix_design_code,
            d.name          AS mix_design_name,
            a.display_name  AS mapped_by_name,
            to_char(m.mapped_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS mapped_at
       FROM plant_batches p
       LEFT JOIN mixtrack_recipe_map m ON m.mci370_code = p.recipe_code
       LEFT JOIN solitaire_mix_designs d ON d.id = m.mix_design_id
       LEFT JOIN solitaire_accounts a ON a.id = m.mapped_by
      WHERE p.recipe_code IS NOT NULL AND p.recipe_code <> ''
      GROUP BY p.recipe_code, m.id, m.mix_design_id, d.code, d.name, a.display_name, m.mapped_at
      ORDER BY (m.id IS NULL) DESC, loads DESC`
  );
  const { rows: designs } = await query(
    `SELECT id, code, name FROM solitaire_mix_designs WHERE is_active ORDER BY code`
  );
  const byNorm = new Map();
  for (const d of designs) {
    const k = normaliseRecipe(d.code);
    // Two designs normalising the same way is an unresolved suggestion, not a
    // coin toss — the weighbridge learned this with its two SREE MUTHAPPANs.
    byNorm.set(k, byNorm.has(k) ? null : d);
  }
  res.json({
    recipes: rows.map((r) => ({
      ...r,
      loads: Number(r.loads),
      suggestion: r.map_id ? null : (byNorm.get(normaliseRecipe(r.recipe_code)) || null),
    })),
    designs,
  });
});

router.post("/recipe-map", requireSolitaireAuth, requireSolitaireRole(...RECIPE_MAP_ROLES), async (req, res) => {
  const { mci370_code, mix_design_id, note } = req.body || {};
  if (!mci370_code) return res.status(400).json({ error: "Which MCI370 recipe code?" });
  if (!mix_design_id) return res.status(400).json({ error: "Choose the mix design it refers to." });
  const { rows } = await query(
    `INSERT INTO mixtrack_recipe_map (mci370_code, mix_design_id, mapped_by, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (mci370_code) DO UPDATE
        SET mix_design_id = EXCLUDED.mix_design_id, mapped_by = EXCLUDED.mapped_by,
            mapped_at = now(), note = EXCLUDED.note
     RETURNING *`,
    [String(mci370_code).trim(), mix_design_id, req.solitaireAccount.id, note || null]
  );
  res.json(rows[0]);
});

router.delete("/recipe-map/:id", requireSolitaireAuth, requireSolitaireRole(...RECIPE_MAP_ROLES), async (req, res) => {
  await query(`DELETE FROM mixtrack_recipe_map WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

/* =========================================================================
 * ROUND 161 — LOADS WAITING FOR A TICKET
 *
 * One row per LOAD the plant has batched (not per batch — the vocabulary
 * matters: a load is the truckful, a batch is one drop of the mixer, ~7.4 to
 * a load here). A load appears here once MCI370 has it and leaves once its
 * ticket is printed.
 *
 * `blocker` is the whole point of the screen. A load whose recipe has no
 * mapping, or whose mapped design is gone, CANNOT print a correct ticket —
 * the workbook's VLOOKUP would return #N/A and the weight columns would come
 * out blank. The user's decision is that such a load is HELD and named, not
 * printed: a ticket with empty weights goes to a customer, whereas nothing
 * printing is merely a job for QC.
 * ===================================================================== */

router.get("/pending-loads", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `WITH loads AS (
       SELECT p.plant_no, p.batch_year, p.batch_no,
              max(p.recipe_code)  AS recipe_code,
              max(p.recipe_name)  AS recipe_name,
              max(p.customer_code) AS customer_code,
              max(p.order_no)     AS order_no,
              max(p.site_name)    AS site_name,
              max(p.truck_no)     AS truck_no,
              max(p.truck_driver) AS truck_driver,
              max(p.load_qty_m3)  AS load_qty_m3,
              max(p.ordered_qty_m3) AS ordered_qty_m3,
              max(p.with_this_load_m3) AS with_this_load_m3,
              max(p.mixer_capacity_m3) AS mixer_capacity_m3,
              max(p.load_started_at) AS load_started_at,
              max(p.load_ended_at)   AS load_ended_at,
              to_char(max(p.batch_date), 'YYYY-MM-DD') AS batch_date,
              count(*) AS batches
         FROM plant_batches p
        GROUP BY p.plant_no, p.batch_year, p.batch_no
     )
     SELECT l.*,
            to_char(l.load_started_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI:SS AM') AS started_time,
            to_char(l.load_ended_at   AT TIME ZONE 'Asia/Kolkata', 'HH12:MI:SS AM') AS ended_time,
            m.mix_design_id,
            d.code AS lookup_code,
            CASE
              WHEN m.id IS NULL THEN 'no-mapping'
              WHEN d.id IS NULL OR NOT d.is_active THEN 'design-inactive'
              ELSE NULL
            END AS blocker
       FROM loads l
       LEFT JOIN mixtrack_recipe_map m ON m.mci370_code = l.recipe_code
       LEFT JOIN solitaire_mix_designs d ON d.id = m.mix_design_id
      WHERE NOT EXISTS (
              SELECT 1 FROM solitaire_dockets k
               WHERE k.plant_no = l.plant_no
                 AND k.plant_batch_year = l.batch_year
                 AND k.plant_batch_no = l.batch_no)
      ORDER BY l.load_started_at DESC NULLS LAST
      LIMIT 200`
  );
  res.json(rows.map((r) => ({ ...r, batches: Number(r.batches) })));
});

/* =========================================================================
 * ROUND 161 — PRODUCTION QTY, WHICH IS WHAT MAKES THE TICKET
 *
 * The operator types one figure. Everything else on the ticket came from
 * MCI370. Saving it creates the docket and queues the print job, in one
 * transaction — the user's decision was that printing fires as soon as the
 * quantity is saved rather than needing a second action.
 *
 * Nothing can print before this, because `Load!I40` derives which of sheets
 * 1-10 to print from `AO29`, the production quantity itself.
 * ===================================================================== */

// The snapshot the agent will write. Taken HERE, at print time, and stored on
// the job — so a retry tomorrow, or a reprint next year, reproduces the paper
// that was handed over rather than picking up a mix design QC has edited since.
async function buildPrintPayload(client, docketId) {
  const { rows } = await client.query(
    `SELECT d.batch_number, d.lookup_code, d.order_no, d.recipe_name, d.driver_name,
            d.production_qty_m3, d.mixer_capacity_m3, d.moisture_pct,
            d.order_qty_m3, d.with_this_load_m3, d.sheet_number, d.qc_delay_minutes,
            to_char(d.batch_started_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')     AS batch_date,
            to_char(d.batch_started_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI:SS AM')  AS batch_start_time,
            to_char(d.batch_ended_at   AT TIME ZONE 'Asia/Kolkata', 'HH12:MI:SS AM')  AS batch_end_time,
            c.name AS customer_name, s.name AS site_name,
            -- recipe_code is MCI370's OWN, because M29 is what the ticket
            -- PRINTS. The mix design's code is lookup_code and goes to H45.
            -- Reading the code off the design here printed the workbook's
            -- spelling on the ticket, which defeated splitting the two cells.
            d.recipe_code, t.truck_number AS truck_number
       FROM solitaire_dockets d
       JOIN customers c ON c.id = d.customer_id
       JOIN sites s ON s.id = d.site_id
       JOIN trucks t ON t.id = d.truck_id
      WHERE d.id = $1`,
    [docketId]
  );
  const d = rows[0];
  const { rows: designs } = await client.query(
    `SELECT * FROM solitaire_mix_designs WHERE is_active ORDER BY code`
  );
  return {
    docket_id: docketId,
    sheet_number: d.sheet_number,
    load_cells: buildLoadSheetValues(d),
    mix_design_rows: buildMixDesignRows(designs),
    clear_rows: mixDesignRowsToClear(designs.length),
    mix_design_columns: MIX_DESIGN_SHEET_COLUMNS,
    save_folder_cell: SAVE_FOLDER_CELL,
  };
}

router.post("/pending-loads/print", requireSolitaireAuth, async (req, res) => {
  const { plant_no, batch_year, batch_no, production_qty_m3,
          customer_id, site_id, truck_id, driver_user_id } = req.body || {};
  const qty = Number(production_qty_m3);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: "Enter the production quantity for this load." });
  }
  if (!customer_id || !site_id || !truck_id) {
    return res.status(400).json({ error: "Customer, site and truck must all be matched before printing." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: loadRows } = await client.query(
      `SELECT max(recipe_code) AS recipe_code, max(recipe_name) AS recipe_name,
              max(order_no) AS order_no, max(truck_driver) AS truck_driver,
              max(ordered_qty_m3) AS ordered_qty_m3, max(with_this_load_m3) AS with_this_load_m3,
              max(mixer_capacity_m3) AS mixer_capacity_m3,
              max(load_started_at) AS load_started_at, max(load_ended_at) AS load_ended_at,
              -- Moisture is per SLOT, not per load, and AO34 on the ticket is
              -- ONE number — so which slot's?
              --
              -- The SAND's. Averaging every gate that reported a figure was the
              -- first attempt and it is wrong: on a real load that gave sand
              -- 6.04%, 12mm 0.8% and 20mm 0.5%, the mean is 2.45%, a number
              -- describing nothing. Sand carries nearly all the free water in a
              -- mix and is the figure a batcher means by "the moisture".
              --
              -- gate2 is this plant's working sand; gate1 is a spare that has
              -- fired 23 times in 18,505 batches, so it is the fallback rather
              -- than an equal.
              (SELECT avg(NULLIF(pm.moisture_pct, 0))
                 FROM plant_batch_materials pm
                 JOIN plant_batches p2 ON p2.id = pm.batch_id
                WHERE p2.plant_no = $1 AND p2.batch_year = $2 AND p2.batch_no = $3
                  AND pm.slot = 'gate2' AND pm.moisture_pct IS NOT NULL) AS moisture_pct
         FROM plant_batches
        WHERE plant_no = $1 AND batch_year = $2 AND batch_no = $3`,
      [plant_no, batch_year, batch_no]
    );
    if (!loadRows.length || !loadRows[0].recipe_code) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "That load is not in the plant data." });
    }
    const load = loadRows[0];

    // THE HELD-LOAD RULE. No mapping, or a mapping pointing at a design that
    // has been deactivated, means the workbook's VLOOKUP returns #N/A and the
    // ticket prints with empty weight columns. That document goes to a
    // customer, so it is refused rather than printed — and the reply names the
    // recipe, because "it didn't print" is useless on its own.
    const { rows: mapRows } = await client.query(
      `SELECT m.mix_design_id, d.code, d.is_active
         FROM mixtrack_recipe_map m
         JOIN solitaire_mix_designs d ON d.id = m.mix_design_id
        WHERE m.mci370_code = $1`,
      [load.recipe_code]
    );
    if (!mapRows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Recipe "${load.recipe_code}" is not mapped to a mix design yet, so the ticket would print with no quantities. QC needs to map or add it first.`,
        code: "NO_MAPPING", recipe_code: load.recipe_code,
      });
    }
    if (!mapRows[0].is_active) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Recipe "${load.recipe_code}" is mapped to mix design "${mapRows[0].code}", which has been deactivated. QC needs to re-map it.`,
        code: "DESIGN_INACTIVE", recipe_code: load.recipe_code,
      });
    }

    const qcDelay = await (async () => {
      const { rows } = await client.query(
        `SELECT delay_minutes FROM mixtrack_qc_delays
          WHERE (site_id = $1) OR (site_id IS NULL AND customer_id = $2)
             OR (site_id IS NULL AND customer_id IS NULL)
          ORDER BY (site_id IS NOT NULL) DESC, (customer_id IS NOT NULL) DESC LIMIT 1`,
        [site_id, customer_id]
      );
      return rows.length ? Number(rows[0].delay_minutes) || 0 : 0;
    })();

    const { rows: docketRows } = await client.query(
      `INSERT INTO solitaire_dockets
        (batch_number, customer_id, site_id, mix_design_id, truck_id, driver_name, driver_user_id,
         production_qty_m3, mixer_capacity_m3, moisture_pct, order_qty_m3, with_this_load_m3,
         sheet_number, order_no, recipe_name, recipe_code, lookup_code,
         batch_started_at, batch_ended_at, qc_delay_minutes,
         plant_no, plant_batch_no, plant_batch_year,
         pdf_filename, pdf_data, is_placeholder_pdf, printed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NULL,NULL,false,$24)
       RETURNING id, batch_number, sheet_number`,
      [String(batch_no), customer_id, site_id, mapRows[0].mix_design_id, truck_id,
       load.truck_driver || null, driver_user_id || null,
       qty, load.mixer_capacity_m3 || null, load.moisture_pct || null,
       load.ordered_qty_m3 || null, load.with_this_load_m3 || null,
       sheetNumberForLoad(qty), load.order_no || null, load.recipe_name || null,
       load.recipe_code, mapRows[0].code,
       load.load_started_at || null, batchEndWithDelay(load.load_ended_at, qcDelay), qcDelay,
       plant_no, batch_no, batch_year, req.solitaireAccount.id]
    );
    const docket = docketRows[0];

    const payload = await buildPrintPayload(client, docket.id);
    const { rows: jobRows } = await client.query(
      `INSERT INTO mixtrack_print_jobs (docket_id, payload_json) VALUES ($1, $2) RETURNING id`,
      [docket.id, payload]
    );

    await client.query("COMMIT");
    res.status(201).json({ ...docket, print_job_id: jobRows[0].id, qc_delay_minutes: qcDelay });
  } catch (err) {
    await client.query("ROLLBACK");
    // The partial unique index is the guard against two operators ticketing
    // the same load from two screens.
    if (err.code === "23505") {
      return res.status(409).json({ error: "That load already has a ticket." });
    }
    throw err;
  } finally {
    client.release();
  }
});

router.get("/print-jobs", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT j.id, j.docket_id, j.status, j.attempts, j.error, j.pdf_filename,
            to_char(j.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS created_at,
            to_char(j.completed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS completed_at,
            d.batch_number, d.sheet_number
       FROM mixtrack_print_jobs j
       JOIN solitaire_dockets d ON d.id = j.docket_id
      ORDER BY j.created_at DESC LIMIT 100`
  );
  res.json(rows);
});

// Re-queue a failed job. The payload is reused verbatim, deliberately: the
// operator is retrying the SAME ticket, not making a fresh one from whatever
// the masters say today.
router.post("/print-jobs/:id/retry", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `UPDATE mixtrack_print_jobs
        SET status = 'pending', error = NULL, claimed_at = NULL
      WHERE id = $1 AND status = 'failed'
      RETURNING id`,
    [req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: "That job is not waiting to be retried." });
  res.json({ ok: true });
});

/* =========================================================================
 * ROUND 161 — THE PRINT AGENT'S OWN ENDPOINTS
 *
 * API-key auth, declared ABOVE this router's requireSolitaireAuth, exactly as
 * the weighbridge and plant agents are: the agent is a machine on the plant
 * network with no browser session and no device cookie.
 *
 * MIXTRACK_API_KEY unset means these endpoints are CLOSED, not open. Same rule
 * as PLANT_API_KEY and WEIGHBRIDGE_API_KEY — verified, not assumed.
 * ===================================================================== */

function printAgentAuthorised(req) {
  const expected = process.env.MIXTRACK_API_KEY;
  if (!expected) return false;
  const got = req.get("x-api-key") || "";
  // Length-checked before timingSafeEqual, which throws on a length mismatch.
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// Claim the oldest waiting job. The UPDATE ... RETURNING is a single statement
// on purpose: select-then-update would let two agents, or one agent restarted
// mid-run, take the same job and print the ticket twice.
//
// A job claimed more than 10 minutes ago is offered again — the agent died
// between claiming and reporting, and the alternative is a ticket that never
// prints and nobody notices.
printRouter.post("/claim", async (req, res) => {
  if (!printAgentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });
  const agentVersion = String(req.body?.agent_version || "").slice(0, 20) || null;
  const { rows } = await query(
    `UPDATE mixtrack_print_jobs SET status = 'claimed', claimed_at = now(),
            attempts = attempts + 1, agent_version = COALESCE($1, agent_version)
      WHERE id = (
        SELECT id FROM mixtrack_print_jobs
         WHERE status = 'pending'
            OR (status = 'claimed' AND claimed_at < now() - interval '10 minutes')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, docket_id, payload_json, attempts`,
    [agentVersion]
  );
  if (!rows.length) return res.json({ job: null });
  res.json({ job: rows[0] });
});

printRouter.post("/result", async (req, res) => {
  if (!printAgentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });
  const { job_id, ok, error, pdf_filename, pdf_base64 } = req.body || {};
  if (!job_id) return res.status(400).json({ error: "Which job?" });

  const { rows: jobs } = await query(`SELECT docket_id FROM mixtrack_print_jobs WHERE id = $1`, [job_id]);
  if (!jobs.length) return res.status(404).json({ error: "No such job." });

  if (!ok) {
    await query(
      `UPDATE mixtrack_print_jobs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
      [job_id, String(error || "the agent reported a failure with no reason").slice(0, 2000)]
    );
    return res.json({ ok: true, status: "failed" });
  }

  // The PDF is stored here AND left on the plant PC. The copy here is what
  // makes the search window work from a phone; the copy there is what the
  // workbook's own PrintPDFFromFolderByNumber reprints once this one has been
  // purged at the two-month mark.
  const pdf = pdf_base64 ? Buffer.from(pdf_base64, "base64") : null;
  await query(
    `UPDATE solitaire_dockets
        SET pdf_filename = $2, pdf_data = $3, is_placeholder_pdf = false
      WHERE id = $1`,
    [jobs[0].docket_id, pdf_filename || null, pdf]
  );
  await query(
    `UPDATE mixtrack_print_jobs SET status = 'done', error = NULL, pdf_filename = $2, completed_at = now() WHERE id = $1`,
    [job_id, pdf_filename || null]
  );
  res.json({ ok: true, status: "done" });
});

/* =========================================================================
 * ROUND 161 — THE PDF PURGE
 *
 * The user's decision: keep two months of PDFs in the app, remove the rest.
 *
 * The docket ROW is never purged. It is about 1 KB, so the complete searchable
 * history costs roughly 1.5 MB a year at this plant's ~1,500 loads — search,
 * reports and the audit trail keep working for ever. Only pdf_data goes, and
 * at ~200 KB a ticket that is what would otherwise reach ~290 MB a year and
 * fill a 1 GB database in three.
 *
 * pdf_purged_at records that the file WAS here and was removed on purpose, so
 * the search window can say "reprint from the plant PC" rather than looking
 * like a ticket that never printed.
 * ===================================================================== */

export async function purgeOldDocketPdfs() {
  const { rows: setting } = await query(
    `SELECT value FROM solitaire_settings WHERE key = 'pdf_retention_months'`
  );
  const months = Math.max(1, Math.min(120, Number(setting[0]?.value) || 2));
  const { rows } = await query(
    `UPDATE solitaire_dockets
        SET pdf_data = NULL, pdf_purged_at = now()
      WHERE pdf_data IS NOT NULL
        AND printed_at < now() - ($1 || ' months')::interval
      RETURNING id, octet_length(pdf_filename) AS n`,
    [String(months)]
  );
  return { purged: rows.length, retention_months: months };
}

printRouter.post("/purge", async (req, res) => {
  if (!printAgentAuthorised(req)) return res.status(401).json({ error: "Not authorised." });
  res.json(await purgeOldDocketPdfs());
});

router.get("/dockets", requireSolitaireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  const { rows } = await query(
    `SELECT d.id, d.batch_number, d.printed_at, d.production_qty_m3, d.sheet_number, d.is_placeholder_pdf,
            c.name AS customer_name, s.name AS site_name, m.code AS recipe_code, t.truck_number AS truck_number
     FROM solitaire_dockets d
     JOIN customers c ON c.id = d.customer_id
     JOIN sites s ON s.id = d.site_id
     JOIN solitaire_mix_designs m ON m.id = d.mix_design_id
     JOIN trucks t ON t.id = d.truck_id
     WHERE $1 = '' OR d.batch_number ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%'
        OR t.truck_number ILIKE '%'||$1||'%' OR s.name ILIKE '%'||$1||'%'
     ORDER BY d.printed_at DESC LIMIT 200`,
    [q]
  );
  res.json(rows);
});

// ROUND 160 — the exact cell map for one docket.
//
// This is the input the Excel fill step consumes, and until that step exists
// it is also how the mapping is CHECKED: it says, per cell, what would be
// written and where the value came from. A ticket that prints a wrong name is
// nearly impossible to debug from the paper alone; this endpoint makes it
// readable before anything is printed.
//
// Every mapped cell appears in the result, blanks included. The workbook is
// reused load after load, so a cell left unwritten keeps the PREVIOUS load's
// value — a blank string is what clears it, and omitting the key is the bug.
router.get("/dockets/:id/cells", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT d.batch_number,
            to_char(d.batch_started_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS batch_date,
            to_char(d.batch_started_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI:SS AM') AS batch_start_time,
            to_char(d.batch_ended_at   AT TIME ZONE 'Asia/Kolkata', 'HH12:MI:SS AM') AS batch_end_time,
            d.qc_delay_minutes,
            d.order_no, d.recipe_name, d.recipe_code, d.driver_name,
            d.production_qty_m3, d.mixer_capacity_m3, d.moisture_pct,
            d.order_qty_m3, d.with_this_load_m3, d.sheet_number,
            c.name AS customer_name, s.name AS site_name,
            COALESCE(d.lookup_code, m.code) AS lookup_code, t.truck_number AS truck_number
       FROM solitaire_dockets d
       JOIN customers c ON c.id = d.customer_id
       JOIN sites s ON s.id = d.site_id
       JOIN solitaire_mix_designs m ON m.id = d.mix_design_id
       JOIN trucks t ON t.id = d.truck_id
      WHERE d.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  const d = rows[0];

  // Dates and times are read as plain STRINGS, already in IST. The same trap
  // this app has hit repeatedly: node-postgres renders a timestamp at the
  // session timezone and the browser converts it again, so a 12:03 batch
  // prints as 06:33 on the ticket. to_char above ends the argument.
  res.json({
    sheet_number: d.sheet_number,
    qc_delay_minutes: d.qc_delay_minutes,
    cells: buildLoadSheetValues(d),
    map: LOAD_SHEET_CELLS,
  });
});

router.get("/dockets/:id/pdf", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(`SELECT pdf_filename, pdf_data FROM solitaire_dockets WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${rows[0].pdf_filename}"`);
  res.send(rows[0].pdf_data);
});

export default router;
