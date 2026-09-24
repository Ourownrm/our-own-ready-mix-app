// Round 153, punch-list item 1 — today's delivery notes, where the people who
// actually load the trucks can reach them.
//
// Until now the only way to open or reprint a Delivery Challan was the
// Administrator's ticket table. The Plant Operator creates every one of these
// notes and could not look at a single one afterwards; the lab and QC, who are
// asked about a specific load hours later, had to go and find an Administrator.
//
// Two routes, deliberately narrow:
//   GET /delivery-notes/today        — the notes raised TODAY, newest first
//   GET /delivery-notes/:id/challan  — the payload the client-side PDF needs
//
// "Today" is the IST calendar day. CURRENT_DATE is correct here and needs no
// arithmetic, because db.js pins every connection to Asia/Kolkata before it is
// ever handed out — which is exactly why this route does NOT compute a date in
// JavaScript and pass it in. A `istDay()` would be
// the UTC day, and between midnight and 05:30 IST that is yesterday.
//
// ACCESS. Both guards, as every converted route does (see
// backend/scripts/check-guards.mjs on why they must agree):
//   - requireRole keeps the list of roles that could ever have this, and
//   - requirePermission("orders.challan-print", "view") is what the Super
//     Admin's Access Control page actually turns on and off per role.
// That second one is the user's requirement that this be "subject to access
// control on super admin page". Revoking View from, say, Lab Technician makes
// this 403 for every lab technician and hides the list on their screen, with
// no deploy.
//
// Note that `orders.challan-print` already existed (Round 146) — printing the
// challan has always been the thing being granted. Round 153 widens its role
// DEFAULTS rather than inventing a second key, because two keys for one
// document would mean a Super Admin could revoke one and not the other and
// wonder why the button is still there. Widening a default does not reach a
// database that has already been seeded, so setup.js carries REPAIR_153.
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requirePermission } from "../lib/permissions.js";
import { fetchChallanData } from "../lib/challanData.js";
import { istDay, istMonth, istDaysAgo, daysElapsedIn } from "../lib/istDate.js";

const router = Router();
router.use(requireAuth);

// Everyone who has a legitimate reason to look at the paperwork for a load
// leaving the plant today. Manager and Administrator are here because they
// already had it by other routes; taking it away would be a regression.
const CHALLAN_ROLES = ["plant_operator", "lab_technician", "qc_engineer", "manager", "administrator"];

// Cancelled tickets are excluded: a cancelled note must never be reprinted and
// handed to a driver. Everything else raised today is listed, including loads
// already delivered — reprinting the paperwork for a truck that has come back
// is a normal thing to need.
router.get("/today", requireRole(...CHALLAN_ROLES), requirePermission("orders.challan-print", "view"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT dt.id, dt.ticket_number, dt.ticket_date, dt.loaded_quantity_m3, dt.status, dt.created_at,
              t.truck_number,
              drv.name AS driver_name,
              c.name AS customer_name,
              s.name AS site_name,
              m.name AS mix_grade_name
       FROM delivery_tickets dt
       JOIN trucks t ON t.id = dt.truck_id
       JOIN users drv ON drv.id = dt.driver_id
       JOIN customer_orders co ON co.id = dt.order_id
       JOIN customers c ON c.id = co.customer_id
       JOIN sites s ON s.id = co.site_id
       JOIN mix_grades m ON m.id = co.mix_grade_id
       WHERE dt.ticket_date = CURRENT_DATE AND dt.status != 'cancelled'
       ORDER BY dt.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /delivery-notes/today failed:", err);
    res.status(500).json({ error: "Failed to load today's delivery notes." });
  }
});

// The same payload administrator.js serves, from the same lib, so the printed
// document is byte-for-byte the one the Administrator gets. A Plant Operator
// holding a ticket id from yesterday can fetch it: the list is scoped to today
// but the document itself is not, because reprinting an older note is a
// reasonable request and hiding it here would only send people back to asking
// an Administrator, which is the problem this round is fixing.
router.get("/:id/challan", requireRole(...CHALLAN_ROLES), requirePermission("orders.challan-print", "view"), async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: "Invalid ticket id." });
  try {
    const data = await fetchChallanData(ticketId);
    if (!data) return res.status(404).json({ error: "Ticket not found." });
    res.json(data);
  } catch (err) {
    console.error("GET /delivery-notes/:id/challan failed:", err);
    res.status(500).json({ error: "Failed to load the delivery note." });
  }
});

export default router;
