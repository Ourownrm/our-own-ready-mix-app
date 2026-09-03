import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { pushToRole, pushToUser } from "../lib/push.js";

// Round 131, item 5 — the purchase/receive/balance layer on top of the
// existing give-fuel-out workflow in supplyRequests.js. That file answers
// "a driver needs fuel, who approves and issues it" — this file answers
// "the plant's fuel/lubricant stock is running low, who orders more, and
// what's actually on the shelf right now." Store requests a purchase,
// Manager approves it, Store confirms what arrived — that's what credits
// the balance. Manager can also correct the balance directly after a
// physical count. Every credit/debit is logged to store_stock_transactions
// so the running balance is always explainable, not just a number that
// changes silently.
const router = Router();
router.use(requireAuth);

// ===================== Stock items & balances =====================

// Self-healing: makes sure the singleton fuel item and one item per active
// lubricant type both exist before listing. Cheap (a couple of
// INSERT ... WHERE NOT EXISTS) and means a lubricant type added after this
// feature shipped doesn't need a separate admin step to start tracking it.
async function ensureStockItems() {
  await query(`
    INSERT INTO store_stock_items (item_type, unit)
    SELECT 'fuel', 'L' WHERE NOT EXISTS (SELECT 1 FROM store_stock_items WHERE item_type = 'fuel')
  `);
  await query(`
    INSERT INTO store_stock_items (item_type, lubricant_type_id, unit)
    SELECT 'lubricant', lt.id, 'L'
    FROM lubricant_types lt
    WHERE lt.is_active
      AND NOT EXISTS (SELECT 1 FROM store_stock_items ssi WHERE ssi.item_type = 'lubricant' AND ssi.lubricant_type_id = lt.id)
  `);
}

router.get("/items", requireRole("store", "manager", "administrator", "accountant"), async (req, res) => {
  await ensureStockItems();
  const { rows } = await query(
    `SELECT ssi.*,
            CASE WHEN ssi.item_type = 'fuel' THEN 'Diesel (Plant Store)' ELSE lt.name END AS display_name
     FROM store_stock_items ssi
     LEFT JOIN lubricant_types lt ON lt.id = ssi.lubricant_type_id
     WHERE ssi.is_active
     ORDER BY ssi.item_type DESC, display_name`
  );
  res.json(rows);
});

// Manager-only physical stock adjustment — correct the balance to match an
// actual count, with a required reason. Recorded as a transaction, same as
// every other change, so it shows up in the item's history below.
router.post("/items/:id/adjust", requireRole("manager", "administrator"), async (req, res) => {
  const { counted_qty, note } = req.body;
  if (counted_qty === undefined || counted_qty === null || counted_qty === "") {
    return res.status(400).json({ error: "Enter the counted quantity." });
  }
  if (!note) return res.status(400).json({ error: "Give a reason for this adjustment." });

  const { rows: existing } = await query("SELECT * FROM store_stock_items WHERE id = $1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Stock item not found." });

  const before = Number(existing[0].current_qty);
  const after = Number(counted_qty);
  const change = after - before;

  const { rows } = await query(
    "UPDATE store_stock_items SET current_qty = $1 WHERE id = $2 RETURNING *",
    [after, req.params.id]
  );
  await query(
    `INSERT INTO store_stock_transactions
     (stock_item_id, txn_type, qty_change, balance_after, reference_type, note, created_by)
     VALUES ($1, 'adjustment', $2, $3, 'manual_adjustment', $4, $5)`,
    [req.params.id, change, after, note, req.user.id]
  );
  res.json(rows[0]);
});

// Round 137, item 1d — Manager/Administrator sets (and can change) the
// standing rupees/liter rate for an item. Deliberately separate from the
// physical /adjust action above — a rate correction isn't a quantity
// change and shouldn't write a store_stock_transactions row. Store's issue
// screens (StoreScan.jsx, FuelFilling.jsx's external-fill confirmation)
// read this to pre-fill the cost field — still freely editable there, so
// this rate is a convenience default, not an enforced price.
router.patch("/items/:id/rate", requireRole("manager", "administrator"), async (req, res) => {
  const { rate_per_liter } = req.body;
  if (rate_per_liter === undefined || rate_per_liter === null || rate_per_liter === "" || Number(rate_per_liter) < 0) {
    return res.status(400).json({ error: "Enter a valid rate (₹ per liter)." });
  }
  const { rows } = await query(
    "UPDATE store_stock_items SET rate_per_liter = $1 WHERE id = $2 RETURNING *",
    [rate_per_liter, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Stock item not found." });
  res.json(rows[0]);
});

router.get("/items/:id/transactions", requireRole("store", "manager", "administrator", "accountant"), async (req, res) => {
  const { rows } = await query(
    `SELECT sst.*, u.name AS created_by_name
     FROM store_stock_transactions sst
     LEFT JOIN users u ON u.id = sst.created_by
     WHERE sst.stock_item_id = $1
     ORDER BY sst.created_at DESC
     LIMIT 200`,
    [req.params.id]
  );
  res.json(rows);
});

// ===================== Purchases (request -> approve -> receive) =====================

const REQUESTER_ROLES = ["store", "administrator"];

router.post("/purchases", requireRole(...REQUESTER_ROLES), async (req, res) => {
  const { stock_item_id, requested_qty, supplier_name, notes } = req.body;
  if (!stock_item_id) return res.status(400).json({ error: "Select which item this purchase is for." });
  if (!requested_qty || Number(requested_qty) <= 0) return res.status(400).json({ error: "Enter the quantity to purchase." });

  const { rows } = await query(
    `INSERT INTO store_stock_purchases (stock_item_id, requested_by, requested_qty, supplier_name, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [stock_item_id, req.user.id, requested_qty, supplier_name || null, notes || null]
  );

  const { rows: item } = await query(
    `SELECT CASE WHEN item_type = 'fuel' THEN 'Diesel' ELSE lt.name END AS display_name
     FROM store_stock_items ssi LEFT JOIN lubricant_types lt ON lt.id = ssi.lubricant_type_id
     WHERE ssi.id = $1`,
    [stock_item_id]
  );
  await pushToRole("manager", {
    title: "New stock purchase request",
    body: `Store requested ${requested_qty} ${item[0]?.display_name || "stock"}`,
    url: "/supply-approvals",
  });

  res.status(201).json(rows[0]);
});

router.get("/purchases/mine", requireRole(...REQUESTER_ROLES), async (req, res) => {
  const { rows } = await query(
    `SELECT sp.*,
            CASE WHEN ssi.item_type = 'fuel' THEN 'Diesel (Plant Store)' ELSE lt.name END AS item_name,
            ssi.unit
     FROM store_stock_purchases sp
     JOIN store_stock_items ssi ON ssi.id = sp.stock_item_id
     LEFT JOIN lubricant_types lt ON lt.id = ssi.lubricant_type_id
     WHERE sp.requested_by = $1
       AND (sp.status != 'received' OR sp.received_at > now() - INTERVAL '2 days')
     ORDER BY sp.requested_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

router.get("/purchases/pending", requireRole("manager", "administrator"), async (req, res) => {
  const { rows } = await query(
    `SELECT sp.*, u.name AS requested_by_name,
            CASE WHEN ssi.item_type = 'fuel' THEN 'Diesel (Plant Store)' ELSE lt.name END AS item_name,
            ssi.unit, ssi.current_qty
     FROM store_stock_purchases sp
     JOIN users u ON u.id = sp.requested_by
     JOIN store_stock_items ssi ON ssi.id = sp.stock_item_id
     LEFT JOIN lubricant_types lt ON lt.id = ssi.lubricant_type_id
     WHERE sp.status = 'pending'
     ORDER BY sp.requested_at`
  );
  res.json(rows);
});

router.post("/purchases/:id/approve", requireRole("manager", "administrator"), async (req, res) => {
  const { approved_qty } = req.body;
  const { rows: existing } = await query("SELECT * FROM store_stock_purchases WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Request not found or already actioned." });

  const { rows } = await query(
    `UPDATE store_stock_purchases SET
       status = 'approved', approved_qty = $1, approved_by = $2, approved_at = now()
     WHERE id = $3 RETURNING *`,
    [approved_qty || existing[0].requested_qty, req.user.id, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Purchase approved", body: "Your stock purchase request has been approved", url: "/store-stock" });
  res.json(rows[0]);
});

router.post("/purchases/:id/reject", requireRole("manager", "administrator"), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "Give a reason for rejecting this." });
  const { rows: existing } = await query("SELECT * FROM store_stock_purchases WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Request not found or already actioned." });

  const { rows } = await query(
    `UPDATE store_stock_purchases SET status = 'rejected', rejected_reason = $1, approved_by = $2, approved_at = now()
     WHERE id = $3 RETURNING *`,
    [reason, req.user.id, req.params.id]
  );
  await pushToUser(existing[0].requested_by, { title: "Purchase rejected", body: reason, url: "/store-stock" });
  res.json(rows[0]);
});

router.delete("/purchases/:id", requireRole("manager", "administrator"), async (req, res) => {
  const { rowCount } = await query("DELETE FROM store_stock_purchases WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Request not found or already actioned." });
  res.json({ ok: true });
});

// Store confirms what actually arrived — this is the step that credits the
// balance. Received qty doesn't have to match approved (a supplier can
// short-deliver); whatever actually came in is what's recorded.
router.post("/purchases/:id/receive", requireRole(...REQUESTER_ROLES), async (req, res) => {
  const { received_qty, unit_cost } = req.body;
  if (!received_qty || Number(received_qty) <= 0) return res.status(400).json({ error: "Enter the quantity received." });

  const { rows: existing } = await query("SELECT * FROM store_stock_purchases WHERE id = $1 AND status = 'approved'", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Request not found or not in a receivable state." });

  const totalCost = unit_cost ? Number(unit_cost) * Number(received_qty) : null;

  const { rows } = await query(
    `UPDATE store_stock_purchases SET
       status = 'received', received_qty = $1, unit_cost = $2, total_cost = $3,
       received_by = $4, received_at = now()
     WHERE id = $5 RETURNING *`,
    [received_qty, unit_cost || null, totalCost, req.user.id, req.params.id]
  );

  const { rows: item } = await query(
    "UPDATE store_stock_items SET current_qty = current_qty + $1 WHERE id = $2 RETURNING current_qty",
    [received_qty, existing[0].stock_item_id]
  );
  await query(
    `INSERT INTO store_stock_transactions
     (stock_item_id, txn_type, qty_change, balance_after, reference_type, reference_id, created_by)
     VALUES ($1, 'purchase_receive', $2, $3, 'store_stock_purchase', $4, $5)`,
    [existing[0].stock_item_id, received_qty, item[0].current_qty, req.params.id, req.user.id]
  );

  res.json(rows[0]);
});

export default router;
