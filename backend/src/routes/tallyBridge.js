// Round 271 — the Tally Bridge's door into the app. Not a person: it signs in
// with the token in its file (X-Bridge-Token), made in Accounts › B2C → Tally
// › Tally settings. Making a new file stops the old one.
//
//   GET  /api/tally-bridge/work?tally=yes|no&pc=NAME   "I'm here" + the requests to send to Tally
//   POST /api/tally-bridge/result   { id, response | error }  Tally's answer to one request
//
// The bridge only carries text between the app and Tally. What a request
// means, and what Tally's answer means, is decided here.
import { Router } from "express";
import crypto from "node:crypto";
import { query, pool } from "../db.js";
import { ensureRound271 } from "../lib/round271Schema.js";
import { voucherXml, readImport, readExists, readLedgers, ledgerNames } from "../lib/tallyXml.js";
import { tallySettings } from "./accountsTallyPost.js";

const router = Router();
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

router.use(async (req, res, next) => {
  try {
    await ensureRound271();
    const token = String(req.get("X-Bridge-Token") || "");
    const { rows } = await query(`SELECT bridge_token_hash FROM tally_settings WHERE id = 1`);
    const want = rows[0]?.bridge_token_hash;
    const got = sha(token);
    if (!token || !want || want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) {
      return res.status(401).json({ error: "This Tally Bridge file is no longer valid — download a new one in Tally settings." });
    }
    next();
  } catch (e) { next(e); }
});

const JOB_LABEL = { exists: "Checked a voucher number", post: "Sent a voucher", check: "Read the ledger list" };

router.get("/work", async (req, res) => {
  const alive = req.query.tally === "yes";
  const pc = String(req.query.pc || "").slice(0, 60) || null;
  const c = await pool.connect();
  try {
    await c.query(`UPDATE tally_settings SET bridge_seen_at = now(), tally_alive = $1, bridge_pc = COALESCE($2, bridge_pc) WHERE id = 1`, [alive, pc]);
    if (!alive) return res.json({ jobs: [] }); // they wait until Tally is open
    await c.query("BEGIN");
    const { rows } = await c.query(
      `SELECT j.id, j.kind, j.xml, j.invoice_id, i.tally_invoice_no
         FROM tally_jobs j LEFT JOIN invoices i ON i.id = j.invoice_id
        WHERE j.status = 'new' ORDER BY j.id LIMIT 20 FOR UPDATE OF j SKIP LOCKED`);
    for (const j of rows) {
      await c.query(`UPDATE tally_jobs SET status = 'picked', picked_at = now() WHERE id = $1`, [j.id]);
      if (j.kind === "post") await c.query(`UPDATE invoices SET tp_state = 'posting' WHERE id = $1 AND tp_state = 'queued'`, [j.invoice_id]);
    }
    await c.query("COMMIT");
    res.json({
      jobs: rows.map((j) => ({ id: j.id, xml: j.xml, label: `${JOB_LABEL[j.kind] || j.kind}${j.tally_invoice_no ? ` — ${j.tally_invoice_no}` : ""}` })),
    });
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "The app could not hand out work." });
  } finally {
    c.release();
  }
});

router.post("/result", async (req, res) => {
  const id = Number(req.body?.id);
  const response = typeof req.body?.response === "string" ? req.body.response : null;
  const bridgeError = typeof req.body?.error === "string" ? req.body.error.slice(0, 500) : null;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(`SELECT * FROM tally_jobs WHERE id = $1 FOR UPDATE`, [id]);
    const job = rows[0];
    // Unknown, already answered, or given up on (and the invoice told so) — ignore.
    if (!job || job.status !== "picked") { await c.query("ROLLBACK"); return res.json({ ok: true, ignored: true }); }
    await c.query(`UPDATE tally_jobs SET status = 'done', done_at = now(), response = $2, error = $3 WHERE id = $1`,
      [id, response ? response.slice(0, 20000) : null, bridgeError]);
    const s = await tallySettings(c);
    const fail = (invoiceId, note) => c.query(`UPDATE invoices SET tp_state = 'failed', tp_note = $2 WHERE id = $1 AND tp_state IN ('queued','posting')`, [invoiceId, note]);
    const noTally = bridgeError ? `Could not reach Tally on ${s.bridge_pc || "the Tally computer"}: ${bridgeError}` : null;

    if (job.kind === "check") {
      let result;
      if (noTally) result = { ok: false, error: noTally };
      else {
        const r = readLedgers(response || "", s);
        if (r.error) result = { ok: false, error: r.error };
        else {
          const have = new Set(r.names.map((n) => n.toLowerCase()));
          const L = ledgerNames(s);
          const keys = Object.keys(L).filter((k) => !(k === "party" && s.party_mode === "customer"));
          result = {
            ok: true, company: s.company, ledger_count: r.names.length,
            found: keys.filter((k) => have.has(String(L[k]).toLowerCase())),
            missing: keys.filter((k) => !have.has(String(L[k]).toLowerCase())).map((k) => ({ key: k, name: L[k] })),
          };
        }
      }
      await c.query(`UPDATE tally_settings SET check_result = $1, check_at = now() WHERE id = 1`, [JSON.stringify(result)]);
    } else if (job.kind === "exists") {
      const { rows: invRows } = await c.query(`SELECT id, tally_invoice_no, tp_state FROM invoices WHERE id = $1`, [job.invoice_id]);
      const inv = invRows[0];
      if (inv && inv.tp_state === "queued") {
        if (noTally) await fail(inv.id, noTally);
        else {
          const r = readExists(response || "", s);
          if (r.error) await fail(inv.id, r.error);
          else if (r.exists) await fail(inv.id, `Tally already has a ${s.voucher_type} voucher no. ${inv.tally_invoice_no} (entered in Tally directly?). Nothing was changed in Tally. If it is this invoice, use “Mark as entered in Tally”; if not, change the number and post again.`);
          else {
            // The number is free — now the voucher itself.
            const full = await c.query(
              `SELECT i.*, dt.ticket_number, dt.ticket_date::text AS ticket_date, dt.loaded_quantity_m3, i.tp_date::text AS tp_date,
                      cu.name AS customer_name, si.name AS site_name, m.name AS grade_name, t.truck_number
                 FROM invoices i JOIN delivery_tickets dt ON dt.id = i.ticket_id JOIN customer_orders co ON co.id = dt.order_id
                 JOIN customers cu ON cu.id = i.customer_id LEFT JOIN sites si ON si.id = co.site_id
                 LEFT JOIN mix_grades m ON m.id = co.mix_grade_id LEFT JOIN trucks t ON t.id = dt.truck_id
                WHERE i.id = $1`, [inv.id]);
            const x = full.rows[0];
            await c.query(`INSERT INTO tally_jobs (kind, invoice_id, xml, created_by) VALUES ('post', $1, $2, $3)`,
              [inv.id, voucherXml(x, s, { voucherNo: x.tally_invoice_no, date: x.tp_date || x.ticket_date }), job.created_by]);
          }
        }
      }
    } else if (job.kind === "post") {
      const { rows: invRows } = await c.query(`SELECT id, tp_state FROM invoices WHERE id = $1`, [job.invoice_id]);
      const inv = invRows[0];
      if (inv && ["posting", "queued"].includes(inv.tp_state)) {
        if (noTally) await fail(inv.id, `${noTally}. Look in Tally whether the voucher was made before posting again.`);
        else {
          const r = readImport(response || "", s);
          if (r.ok) {
            await c.query(`UPDATE invoices SET tp_state = 'posted', tp_note = NULL, tp_posted_at = now(), tp_by_hand = false WHERE id = $1`, [inv.id]);
          } else await fail(inv.id, r.error);
        }
      }
    }
    await c.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "The app could not take Tally's answer." });
  } finally {
    c.release();
  }
});

export default router;
