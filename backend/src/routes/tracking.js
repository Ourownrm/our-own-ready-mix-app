import { Router } from "express";
import { query } from "../db.js";
import { getOrderTrackingPayload } from "../lib/orderTracking.js";

// Public, unauthenticated order-tracking endpoint reached via a shared link
// (e.g. WhatsApp) — deliberately NOT mounted behind requireAuth, unlike every
// other route in this app. Scoped entirely by the unguessable token itself:
// there is no account, no list, and no way to browse from one order's link to
// another — the token IS the access boundary, so this can't leak a second
// order or a second customer's data even by mistake in a query. Read-only.
const router = Router();

router.get("/:token", async (req, res) => {
  const { rows: linkRows } = await query(
    `SELECT otl.id, otl.order_id, otl.revoked_at
     FROM order_tracking_links otl WHERE otl.token = $1`,
    [req.params.token]
  );
  const link = linkRows[0];
  if (!link || link.revoked_at) {
    return res.status(404).json({ error: "expired" });
  }

  const payload = await getOrderTrackingPayload(link.order_id);
  if (!payload) return res.status(404).json({ error: "expired" });

  res.json(payload);
});

export default router;
