// Round 269 — the Marketing module's doors that have no sign-in:
//
//   GET  /m/:token                 the tracking page's data (logs "opened")
//   GET  /m/:token/file/:itemId    the file itself, streamed from Google Drive
//                                  (logs "viewed" / "downloaded")
//   POST /m/:token/event           "played to the end"
//   POST /m/:token/opt-out         "don't send me these"
//   GET  /media/:id/:exp/:sig      signed, expiring link to an item's file —
//                                  WhatsApp downloads header media from it,
//                                  and the app uses it for previews
//   GET  /drive/callback           Google's redirect after "Connect Google Drive"
//   GET  /wa-webhook               Meta's webhook check
//   POST /wa-webhook               delivered / read / failed ticks
//
// A token is 12 random characters, one per person per send: it identifies
// who opened the material without asking them to sign in.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { ensureRound269 } from "../lib/round269Schema.js";
import {
  loadSettings, saveData, drivePipe, mediaSigOk, readState, driveExchangeCode, driveAccount, backendBase, waSignatureOk,
} from "../lib/mktServices.js";

const router = Router();
router.use(async (req, res, next) => { try { await ensureRound269(); next(); } catch (e) { next(e); } });
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

async function recipient(token) {
  if (!/^[\w-]{6,24}$/.test(String(token || ""))) return null;
  const { rows } = await query(
    `SELECT r.*, s.item_ids, s.category, c.name AS contact_name, c.opted_out_at
       FROM mkt_recipients r JOIN mkt_sends s ON s.id = r.send_id LEFT JOIN mkt_contacts c ON c.id = r.contact_id
      WHERE r.token = $1`, [token]);
  return rows[0] || null;
}
async function event(r, kind, itemId = null) {
  await query(`INSERT INTO mkt_events (recipient_id, item_id, kind) VALUES ($1, $2, $3)`, [r.id, itemId, kind]);
}

router.get("/m/:token", limiter, async (req, res) => {
  try {
    const r = await recipient(req.params.token);
    if (!r) return res.status(404).json({ error: "This link is not valid." });
    const { rows: items } = await query(
      `SELECT id, title, kind, mime, size_bytes, file_name, status FROM mkt_items WHERE id = ANY($1::int[]) AND status IN ('approved','retired')
        ORDER BY array_position($1::int[], id)`, [r.item_ids]);
    // An open by WhatsApp's own link preview is not a person; skip those.
    const bot = /facebookexternalhit|WhatsApp|bot|crawler|preview/i.test(req.get("user-agent") || "");
    if (!bot) {
      await query(`UPDATE mkt_recipients SET open_count = open_count + 1, first_open_at = COALESCE(first_open_at, now()), last_open_at = now(),
                          status = CASE WHEN status IN ('queued','sent','delivered') AND channel <> 'wa_api' THEN 'read' ELSE status END WHERE id = $1`, [r.id]);
      await event(r, "open");
    }
    res.json({ name: (r.contact_name || "").split(" ")[0], category: r.category, opted_out: !!r.opted_out_at, items });
  } catch (err) { console.error(err); res.status(500).json({ error: "Something went wrong." }); }
});

router.get("/m/:token/file/:itemId", limiter, async (req, res) => {
  try {
    const r = await recipient(req.params.token);
    const itemId = Number(req.params.itemId);
    if (!r || !r.item_ids.includes(itemId)) return res.status(404).end();
    const { rows } = await query(`SELECT * FROM mkt_items WHERE id = $1 AND status IN ('approved','retired')`, [itemId]);
    if (!rows.length || !rows[0].drive_file_id) return res.status(404).end();
    const it = rows[0];
    const download = req.query.dl === "1";
    const range = req.headers.range;
    // Count the first request of a view (a video asks for many ranges).
    if (!range || /^bytes=0-/.test(range)) {
      await event(r, download ? "download" : "view", itemId);
      if (download) await query(`UPDATE mkt_recipients SET download_count = download_count + 1 WHERE id = $1`, [r.id]);
    }
    await drivePipe(it.drive_file_id, req, res, { name: it.file_name, mime: it.mime, download });
  } catch (err) { console.error(err); if (!res.headersSent) res.status(502).end(); }
});

router.post("/m/:token/event", limiter, async (req, res) => {
  try {
    const r = await recipient(req.params.token);
    if (!r) return res.status(404).json({});
    if (req.body?.kind === "play_end") {
      await event(r, "play_end", Number(req.body.item_id) || null);
      await query(`UPDATE mkt_recipients SET play_end_count = play_end_count + 1 WHERE id = $1`, [r.id]);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({}); }
});

router.post("/m/:token/opt-out", limiter, async (req, res) => {
  try {
    const r = await recipient(req.params.token);
    if (!r) return res.status(404).json({ error: "This link is not valid." });
    if (r.contact_id) await query(`UPDATE mkt_contacts SET opted_out_at = COALESCE(opted_out_at, now()) WHERE id = $1`, [r.contact_id]);
    await event(r, "opt_out");
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Something went wrong." }); }
});

router.get("/media/:id/:exp/:sig", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!mediaSigOk(id, req.params.exp, req.params.sig)) return res.status(403).end();
    const { rows } = await query(`SELECT * FROM mkt_items WHERE id = $1`, [id]);
    if (!rows.length || !rows[0].drive_file_id) return res.status(404).end();
    await drivePipe(rows[0].drive_file_id, req, res, { name: rows[0].file_name, mime: rows[0].mime });
  } catch (err) { console.error(err); if (!res.headersSent) res.status(502).end(); }
});

// ---------------- Google Drive connection ----------------
router.get("/drive/callback", async (req, res) => {
  const st = readState(req.query.state);
  const back = st?.back && /^https?:\/\//.test(st.back) ? st.back : null;
  const go = (ok, msg) => (back ? res.redirect(`${back}/marketing?tab=settings&drive=${ok ? "ok" : encodeURIComponent(msg || "failed")}`)
    : res.send(ok ? "Google Drive is connected. You can close this tab." : `Google Drive was not connected: ${msg}`));
  if (!st) return go(false, "the link expired — try again");
  if (req.query.error) return go(false, String(req.query.error));
  try {
    await driveExchangeCode(String(req.query.code || ""), `${backendBase(req)}/api/marketing-public/drive/callback`);
    const { data } = await loadSettings();
    const account = await driveAccount().catch(() => null);
    await saveData({ drive: { ...data.drive, account } }, st.u);
    go(true);
  } catch (err) { console.error(err); go(false, err.message); }
});

// ---------------- WhatsApp webhook ----------------
router.get("/wa-webhook", async (req, res) => {
  const { secrets } = await loadSettings();
  if (req.query["hub.mode"] === "subscribe" && secrets.wa_verify_token && req.query["hub.verify_token"] === secrets.wa_verify_token) {
    return res.status(200).send(String(req.query["hub.challenge"] || ""));
  }
  res.status(403).end();
});

router.post("/wa-webhook", async (req, res) => {
  try {
    const { secrets } = await loadSettings();
    if (!waSignatureOk(req.rawBody, req.get("x-hub-signature-256"), secrets.wa_app_secret)) return res.status(401).end();
    const rank = { sent: 1, delivered: 2, read: 3 };
    for (const entry of req.body?.entry || []) {
      for (const ch of entry.changes || []) {
        for (const s of ch.value?.statuses || []) {
          const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
          if (s.status === "failed") {
            const e = s.errors?.[0];
            await query(`UPDATE mkt_recipients SET status = 'failed', error = $2 WHERE wa_message_id = $1`, [s.id, e ? `${e.title || ""} ${e.error_data?.details || ""}`.trim().slice(0, 500) : "failed"]);
          } else if (rank[s.status]) {
            await query(
              `UPDATE mkt_recipients SET
                 status = CASE WHEN (CASE status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END) < $2 THEN $3 ELSE status END,
                 delivered_at = CASE WHEN $2 >= 2 THEN COALESCE(delivered_at, $4) ELSE delivered_at END,
                 read_at = CASE WHEN $2 = 3 THEN COALESCE(read_at, $4) ELSE read_at END
               WHERE wa_message_id = $1`, [s.id, rank[s.status], s.status, at]);
          }
        }
      }
    }
    res.status(200).end();
  } catch (err) { console.error("wa webhook:", err); res.status(200).end(); }
});

export default router;
