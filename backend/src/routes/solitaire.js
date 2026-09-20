// Solitaire — self-contained "RMC Delivery Challan" / Batching Docket
// module (see handoff package 00_START_HERE.md and the schema.sql
// "SOLITAIRE MODULE" section). Own login, own device-lock, own master data.
// Nothing here touches the main app's users/customers/sites/trucks/
// mix_designs tables or its requireAuth/requireRole — see
// middleware/solitaireAuth.js.
//
// IMPORTANT — read before touching the print flow: the real "fill the
// Excel workbook and export" pipeline (03_EXCEL_PRINT_PIPELINE.md) is
// BLOCKED on the updated workbook (sheets "1"-"10"), which has not been
// provided yet. POST /dockets below accepts a PDF the FRONTEND already
// generated (via solitaireDocketPdf.js, a jsPDF placeholder matching this
// app's existing PDF-generator pattern) and just stores + indexes it. Every
// docket saved this way is flagged is_placeholder_pdf = true. Once the real
// workbook arrives: build the actual fill-cells → recalculate → export
// pipeline (needs a server-side spreadsheet engine, e.g. LibreOffice
// headless — not available in this dev session) and swap the frontend's
// call from solitaireDocketPdf.js to that new endpoint.
import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
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
router.use(requirePluginEnabled("solitaire"));
router.use(requireSolitaireConfigured);

const MASTERS_ROLES = ["operator", "qc", "admin"]; // Customer & Site, Truck & Driver — QC's scope was widened to include these this round (was Mix-Design-only in the original mockup guess)
const MIX_DESIGN_ROLES = ["qc", "admin"]; // exclusive, per §3/§5

/* =========================================================================
 * LOGIN  (public — this endpoint IS the login, so it runs before requireSolitaireAuth)
 * ===================================================================== */
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
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
    // get authorized in the first place. Every other case (any role, once
    // at least one device exists) is blocked exactly per spec.
    if (noDevicesRegisteredYet && account.role === "admin") {
      const newToken = generateDeviceToken();
      await query(
        `INSERT INTO solitaire_devices (device_token, label, registered_by) VALUES ($1, $2, $3)`,
        [newToken, "Bootstrap device (auto-registered on first Admin login)", account.id]
      );
      res.cookie(DEVICE_COOKIE, newToken, cookieOptions(DEVICE_MAX_AGE_MS));
    } else {
      return res.status(403).json({
        error: "This browser/device is not authorized to open Solitaire. Contact your Administrator.",
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
     JOIN solitaire_accounts a ON a.id = d.registered_by
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
router.get("/customers", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM solitaire_customers WHERE is_active ORDER BY name`);
  const { rows: sites } = await query(
    `SELECT s.* FROM solitaire_sites s JOIN solitaire_customers c ON c.id = s.customer_id
     WHERE s.is_active AND c.is_active ORDER BY s.name`
  );
  const byCustomer = {};
  sites.forEach((s) => { (byCustomer[s.customer_id] ||= []).push(s); });
  res.json(rows.map((c) => ({ ...c, sites: byCustomer[c.id] || [] })));
});

router.post("/customers", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "Code and name are required." });
  const { rows } = await query(`INSERT INTO solitaire_customers (code, name) VALUES ($1, $2) RETURNING *`, [code.trim(), name.trim()]);
  res.status(201).json(rows[0]);
});

router.patch("/customers/:id", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  const { code, name, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE solitaire_customers SET code = COALESCE($1, code), name = COALESCE($2, name), is_active = COALESCE($3, is_active)
     WHERE id = $4 RETURNING *`,
    [code, name, is_active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  res.json(rows[0]);
});

router.delete("/customers/:id", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  await query(`UPDATE solitaire_customers SET is_active = false WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.post("/customers/:id/sites", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Site name is required." });
  const { rows } = await query(`INSERT INTO solitaire_sites (customer_id, name) VALUES ($1, $2) RETURNING *`, [req.params.id, name.trim()]);
  res.status(201).json(rows[0]);
});

router.patch("/sites/:id", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  const { name, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE solitaire_sites SET name = COALESCE($1, name), is_active = COALESCE($2, is_active) WHERE id = $3 RETURNING *`,
    [name, is_active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  res.json(rows[0]);
});

router.delete("/sites/:id", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  await query(`UPDATE solitaire_sites SET is_active = false WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.get("/trucks", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM solitaire_trucks WHERE is_active ORDER BY registration_number`);
  res.json(rows);
});

router.post("/trucks", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  const { registration_number, truck_code, driver_name } = req.body || {};
  if (!registration_number || !truck_code || !driver_name) {
    return res.status(400).json({ error: "Registration number, Truck ID, and Driver name are all required." });
  }
  const { rows } = await query(
    `INSERT INTO solitaire_trucks (registration_number, truck_code, driver_name) VALUES ($1, $2, $3) RETURNING *`,
    [registration_number.trim(), truck_code.trim(), driver_name.trim()]
  );
  res.status(201).json(rows[0]);
});

router.patch("/trucks/:id", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  const { registration_number, truck_code, driver_name, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE solitaire_trucks SET registration_number = COALESCE($1, registration_number),
     truck_code = COALESCE($2, truck_code), driver_name = COALESCE($3, driver_name), is_active = COALESCE($4, is_active)
     WHERE id = $5 RETURNING *`,
    [registration_number, truck_code, driver_name, is_active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  res.json(rows[0]);
});

router.delete("/trucks/:id", requireSolitaireAuth, requireSolitaireRole(...MASTERS_ROLES), async (req, res) => {
  await query(`UPDATE solitaire_trucks SET is_active = false WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.get("/mix-designs", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM solitaire_mix_designs WHERE is_active ORDER BY code`);
  res.json(rows);
});

router.post("/mix-designs", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  const {
    code, name, msand_kgm3, agg_12mm_kgm3, agg_20mm_kgm3,
    cem1_kgm3, cem2_kgm3, cem3_kgm3, admix1_kgm3, admix2_kgm3, water_kgm3,
  } = req.body || {};
  if (!code) return res.status(400).json({ error: "Recipe code is required." });
  const { rows } = await query(
    `INSERT INTO solitaire_mix_designs
     (code, name, msand_kgm3, agg_12mm_kgm3, agg_20mm_kgm3, cem1_kgm3, cem2_kgm3, cem3_kgm3, admix1_kgm3, admix2_kgm3, water_kgm3)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [code.trim(), name || code.trim(), msand_kgm3 || 0, agg_12mm_kgm3 || 0, agg_20mm_kgm3 || 0,
     cem1_kgm3 || 0, cem2_kgm3 || 0, cem3_kgm3 || 0, admix1_kgm3 || 0, admix2_kgm3 || 0, water_kgm3 || 0]
  );
  res.status(201).json(rows[0]);
});

router.patch("/mix-designs/:id", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  const fields = ["code", "name", "msand_kgm3", "agg_12mm_kgm3", "agg_20mm_kgm3", "cem1_kgm3",
    "cem2_kgm3", "cem3_kgm3", "admix1_kgm3", "admix2_kgm3", "water_kgm3", "is_active"];
  const sets = []; const vals = []; let i = 1;
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f} = $${i++}`); vals.push(req.body[f]); }
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  vals.push(req.params.id);
  const { rows } = await query(`UPDATE solitaire_mix_designs SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals);
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  res.json(rows[0]);
});

router.delete("/mix-designs/:id", requireSolitaireAuth, requireSolitaireRole(...MIX_DESIGN_ROLES), async (req, res) => {
  await query(`UPDATE solitaire_mix_designs SET is_active = false WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

/* =========================================================================
 * DATA ENTRY / PRINT FLOW — §4, §6, §7
 * ===================================================================== */

// Sheet-selection number (§6) — shared by the read-only "Total Batch" field
// and by which pre-built workbook sheet gets printed. Ceiling, clamped
// 1-10. ratio exactly 2.0 -> sheet 2, not 3 (standard ceiling behavior).
function computeSheetNumber(prodQty, mixerCap) {
  const qty = Number(prodQty) || 0;
  const cap = Number(mixerCap) || 0;
  if (cap <= 0) return 1;
  return Math.min(10, Math.max(1, Math.ceil(qty / cap)));
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
  res.json({ sheet_number: computeSheetNumber(production_qty_m3, mixer_capacity_m3) });
});

// Persists a printed docket + its PDF and indexes it for Search/Reprint
// (§7 step 5, §8). See the file-header comment — pdf_base64 is generated
// CLIENT-SIDE by the temporary solitaireDocketPdf.js until the real
// Excel-fill pipeline replaces it; is_placeholder_pdf is always true here.
router.post("/dockets", requireSolitaireAuth, async (req, res) => {
  const {
    batch_number, order_date_time, order_qty_m3, with_this_load_m3,
    customer_id, site_id, mix_design_id, truck_id, driver_name,
    production_qty_m3, mixer_capacity_m3, moisture_pct,
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

  const sheet_number = computeSheetNumber(production_qty_m3, mixer_capacity_m3);

  const { rows } = await query(
    `INSERT INTO solitaire_dockets
     (batch_number, order_date_time, order_qty_m3, with_this_load_m3, customer_id, site_id, mix_design_id,
      truck_id, driver_name, production_qty_m3, mixer_capacity_m3, moisture_pct, sheet_number,
      pdf_filename, pdf_data, is_placeholder_pdf, printed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16)
     RETURNING id, batch_number, sheet_number, pdf_filename, printed_at`,
    [batch_number || null, order_date_time || null, order_qty_m3 || null, with_this_load_m3 || null,
     customer_id, site_id, mix_design_id, truck_id, driver_name || null,
     production_qty_m3, mixer_capacity_m3 || null, moisture_pct || null, sheet_number,
     pdf_filename, Buffer.from(pdf_base64, "base64"), req.solitaireAccount.id]
  );

  // §7 step 5's "save to the folder path configured in Admin Settings" — a
  // real filesystem write belongs here once this runs on a real server;
  // this dev session has no access to that filesystem, so it's a no-op that
  // just reports the configured path back to the frontend for now.
  const { rows: folderRow } = await query(`SELECT value FROM solitaire_settings WHERE key = 'save_folder_path'`);

  res.status(201).json({ ...rows[0], save_folder_path: folderRow[0]?.value || null });
});

router.get("/dockets", requireSolitaireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  const { rows } = await query(
    `SELECT d.id, d.batch_number, d.printed_at, d.production_qty_m3, d.sheet_number, d.is_placeholder_pdf,
            c.name AS customer_name, s.name AS site_name, m.code AS recipe_code, t.registration_number AS truck_number
     FROM solitaire_dockets d
     JOIN solitaire_customers c ON c.id = d.customer_id
     JOIN solitaire_sites s ON s.id = d.site_id
     JOIN solitaire_mix_designs m ON m.id = d.mix_design_id
     JOIN solitaire_trucks t ON t.id = d.truck_id
     WHERE $1 = '' OR d.batch_number ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%'
        OR t.registration_number ILIKE '%'||$1||'%' OR s.name ILIKE '%'||$1||'%'
     ORDER BY d.printed_at DESC LIMIT 200`,
    [q]
  );
  res.json(rows);
});

router.get("/dockets/:id/pdf", requireSolitaireAuth, async (req, res) => {
  const { rows } = await query(`SELECT pdf_filename, pdf_data FROM solitaire_dockets WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${rows[0].pdf_filename}"`);
  res.send(rows[0].pdf_data);
});

export default router;
