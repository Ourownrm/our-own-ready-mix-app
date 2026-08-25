import { Router } from "express";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { query } from "../db.js";

// ===================== CUSTOMER PORTAL (round 119) =====================
// Public, no-login-by-password page — a customer signs in with a short
// access code Manager/Admin issued them (see routes/customerAccess.js) and
// sees their own orders + QC reports (mix design / cube test PDFs) for
// whichever site(s) that code was scoped to. Deliberately NOT mounted
// behind requireAuth/requireRole (those are for staff accounts, a
// completely different trust boundary) — every route here does its own
// customer-scoped auth via requireCustomerAuth below.
//
// Security note: customer sessions are signed with their OWN secret
// (CUSTOMER_JWT_SECRET, falling back to JWT_SECRET if that env var isn't
// set yet — see render.yaml) specifically so a customer session token can
// never be replayed against any staff-only endpoint (different secret =
// verify() throws immediately), and vice versa a stolen staff token can't
// be used here either. requireCustomerAuth also re-checks the underlying
// customer_access_tokens row on EVERY request (not just at login) so a
// Manager revoking a code takes effect immediately, even for a session
// token that hasn't expired yet — same "live check, don't just trust a
// long-lived JWT" reasoning as the staff side's requireAuth would want if
// user.is_active were ever flipped off mid-session.
const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please wait a while before trying again." },
});

function customerSecret() {
  return process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET;
}

router.post("/login", loginLimiter, async (req, res) => {
  const raw = (req.body.token || "").trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: "Enter your access code." });

  const { rows } = await query(
    `SELECT cat.id, cat.customer_id, c.name AS customer_name
     FROM customer_access_tokens cat JOIN customers c ON c.id = cat.customer_id
     WHERE cat.token = $1 AND cat.is_active`,
    [raw]
  );
  if (!rows.length) {
    return res.status(401).json({ error: "That access code isn't valid. Check it and try again, or contact us for a new one." });
  }
  const row = rows[0];
  await query("UPDATE customer_access_tokens SET last_used_at = now() WHERE id = $1", [row.id]);

  const session_token = jwt.sign(
    { type: "customer", token_id: row.id, customer_id: row.customer_id },
    customerSecret(),
    { expiresIn: "180d" } // long-lived on purpose — "save it for auto login next time"
  );
  res.json({ session_token, customer_name: row.customer_name });
});

async function requireCustomerAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in with your access code to continue." });
  }
  let payload;
  try {
    payload = jwt.verify(header.slice(7), customerSecret());
  } catch {
    return res.status(401).json({ error: "Your session expired. Sign in again with your access code." });
  }
  if (payload.type !== "customer") {
    return res.status(401).json({ error: "Sign in with your access code to continue." });
  }

  const { rows } = await query(
    `SELECT cat.customer_id, c.name AS customer_name FROM customer_access_tokens cat
     JOIN customers c ON c.id = cat.customer_id
     WHERE cat.id = $1 AND cat.is_active`,
    [payload.token_id]
  );
  if (!rows.length) {
    return res.status(401).json({ error: "This access code has been revoked. Please contact us for a new one." });
  }
  const { rows: siteRows } = await query(
    "SELECT site_id FROM customer_access_token_sites WHERE token_id = $1",
    [payload.token_id]
  );
  req.customerId = rows[0].customer_id;
  req.customerName = rows[0].customer_name;
  req.siteIds = siteRows.map((r) => r.site_id);
  next();
}

router.get("/me", requireCustomerAuth, async (req, res) => {
  const { rows } = await query(
    "SELECT id, name FROM sites WHERE id = ANY($1::int[]) ORDER BY name",
    [req.siteIds]
  );
  res.json({ customer_name: req.customerName, sites: rows });
});

router.get("/orders", requireCustomerAuth, async (req, res) => {
  if (!req.siteIds.length) return res.json([]);
  const { rows } = await query(
    `SELECT co.id, co.order_date, co.scheduled_batching_time, co.status, co.order_quantity_m3,
            co.resolved_mix_design_id, s.name AS site_name, m.name AS mix_grade_name,
            md.status AS mix_design_status,
            COALESCE((
              SELECT SUM(dt.loaded_quantity_m3) FROM delivery_tickets dt
              WHERE dt.order_id = co.id AND dt.status = 'completed'
            ), 0) AS delivered_qty_m3
     FROM customer_orders co
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = co.resolved_mix_design_id
     WHERE co.customer_id = $1 AND co.site_id = ANY($2::int[])
     ORDER BY co.order_date DESC, co.id DESC
     LIMIT 200`,
    [req.customerId, req.siteIds]
  );
  res.json(rows);
});

// Ownership-checked lookup used by both PDF-data routes below — an order
// only counts as "this customer's" if it's both their customer_id AND one
// of the sites their access code actually covers, so a guessed order id
// from a different site (even the same customer's own other site, if their
// code wasn't scoped to it) can't leak data.
async function ownOrder(req, orderId) {
  const { rows } = await query(
    "SELECT id, customer_id, site_id, resolved_mix_design_id FROM customer_orders WHERE id = $1",
    [orderId]
  );
  const order = rows[0];
  if (!order || order.customer_id !== req.customerId || !req.siteIds.includes(order.site_id)) return null;
  return order;
}

router.get("/orders/:id/mix-design-pdf-data", requireCustomerAuth, async (req, res) => {
  const order = await ownOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (!order.resolved_mix_design_id) {
    return res.status(404).json({ error: "No mix design is linked to this order yet." });
  }
  const { rows } = await query(
    `SELECT md.*, m.name AS mix_grade_name, cu.name AS created_by_name
     FROM mix_designs md
     JOIN mix_grades m ON m.id = md.mix_grade_id
     JOIN users cu ON cu.id = md.created_by
     WHERE md.id = $1 AND md.status = 'approved'`,
    [order.resolved_mix_design_id]
  );
  if (!rows.length) return res.status(404).json({ error: "This mix design hasn't been approved yet." });
  const { rows: admixtures } = await query(
    `SELECT type_brand, dosage_pct_of_binder, qty_kgm3, sp_gr FROM mix_design_admixtures
     WHERE mix_design_id = $1 ORDER BY sort_order`,
    [order.resolved_mix_design_id]
  );
  // Same real PDF data a staff member would see — no redaction. The
  // generator already shows a fixed "Quality Control Engineer" role label
  // for Approved by regardless of who clicked approve (see mixDesignPdf.js).
  res.json({ ...rows[0], admixtures });
});

router.get("/orders/:id/cube-tests", requireCustomerAuth, async (req, res) => {
  const order = await ownOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const { rows } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_strength_mpa, ctr.tested_at
     FROM cube_test_results ctr
     JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     WHERE dt.order_id = $1
     ORDER BY ctr.tested_at DESC`,
    [order.id]
  );
  res.json(rows);
});

router.get("/cube-tests/:resultId/pdf-data", requireCustomerAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT ctr.id, ctr.testing_age_days, ctr.average_weight_kg, ctr.average_load_kn,
            ctr.average_density_kgm3, ctr.average_strength_mpa, ctr.remarks, ctr.failure_type, ctr.tested_at,
            u.name AS tested_by_name,
            pq.id AS plant_qc_id, pq.sample_ids, pq.entered_at AS cast_at, pq.number_of_cubes,
            dt.ticket_number, dt.order_id,
            co.id AS order_id, co.casting_location, co.order_date, co.customer_id, co.site_id,
            c.name AS customer_name, s.name AS site_name, s.address AS site_address,
            m.name AS mix_grade_name,
            md.id AS mix_design_id, md.design_ref_code, md.fck_28day_mpa, md.target_mean_strength_mpa
     FROM cube_test_results ctr
     JOIN users u ON u.id = ctr.tested_by
     JOIN plant_qc pq ON pq.id = ctr.plant_qc_id
     JOIN delivery_tickets dt ON dt.id = pq.ticket_id
     JOIN customer_orders co ON co.id = dt.order_id
     JOIN customers c ON c.id = co.customer_id
     JOIN sites s ON s.id = co.site_id
     JOIN mix_grades m ON m.id = co.mix_grade_id
     LEFT JOIN mix_designs md ON md.id = ctr.mix_design_id
     WHERE ctr.id = $1`,
    [req.params.resultId]
  );
  const row = rows[0];
  if (!row || row.customer_id !== req.customerId || !req.siteIds.includes(row.site_id)) {
    return res.status(404).json({ error: "Test result not found." });
  }
  const { rows: cubes } = await query(
    `SELECT cube_label, weight_kg, testing_load_kn, density_kgm3, strength_mpa
     FROM cube_test_cubes WHERE cube_test_result_id = $1 ORDER BY sort_order`,
    [req.params.resultId]
  );
  // Same real PDF data a staff member would see — no redaction.
  res.json({ ...row, cubes });
});

export default router;
