// Round 230 — one customer / project entered twice (owner, 22 Oct 2026):
//
//   "Rate adding flow is having issue — when there is a mismatch between the
//    earlier entered customer name and projects and the quotation name and
//    projects, invoices show rate is not available."
//
// Why it happens: the price list is keyed on the customer and site RECORDS,
// not their names. Orders were placed under, say, "SKYLINE BUILDERS ·
// KALPETTA VILLA"; a quotation (or the Excel import) then added a new
// customer "SKYLINE BUILDERS PVT LTD" or a new site "VILLA, KALPETTA". The
// accepted quotation priced the new record, the orders still point at the old
// one, so every delivery is held "no price".
//
// The fix is to make them one record again. A merge moves every reference
// from the duplicate to the record that stays — orders, delivery notes'
// invoices, quotations, the price list, receipts, ledger lines, bookings,
// C Ledger deliveries, access links … — and switches the duplicate off. The
// references are found from the database's own foreign keys at run time, so a
// table added in a later round is never silently left behind (the old site
// merge, Round 1xx, listed five tables by hand and missed quotations).
//
// Nothing is deleted except a few per-record SETTINGS that can exist only
// once (a sales forecast per site, a QC delay setting, a mix-design choice per
// grade, a sign-in code's site list) — where the record that stays already
// has its own, the duplicate's copy is dropped and the stayer's kept.
import { query } from "../db.js";

// ---------------------------------------------------------------- name matching
// Same normalisation the Excel import uses (frontend lib/quotationImport.js):
// capitals, "&" = AND, and the words that don't make two names different
// (M/S, PVT, LTD, THE …) dropped.
const STRIP = /\b(M\/S|MS|MR|MRS|ENGR|DR|PVT|PRIVATE|LTD|LIMITED|CO|COMPANY|THE|AND)\b/g;
export const normName = (s) => String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[.,()/\\-]/g, " ")
  .replace(STRIP, " ").replace(/[^A-Z0-9]/g, "");
const words = (s) => new Set(String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[.,()/\\-]/g, " ")
  .replace(STRIP, " ").split(/[^A-Z0-9]+/).filter((w) => w.length >= 3));

// 1 = the same name once the noise is gone; 0.85 = one contains the other
// ("SKYLINE" / "SKYLINE BUILDERS"); otherwise the share of words in common
// ("KALPETTA VILLA" / "VILLA AT KALPETTA" = 1.0 by words). Below 0.6 = not
// alike.
export function nameScore(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return 0.85;
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 1 && common >= 1 ? 0.8 : common / Math.max(wa.size, wb.size);
}
export const alike = (a, b) => nameScore(a, b) >= 0.6;

// ------------------------------------------------------------------ references
// Every (table, column) with a foreign key to `table`'s id.
async function refsTo(db, table) {
  const { rows } = await db.query(
    `SELECT cl.relname AS tbl, a.attname AS col
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
       JOIN pg_class rt ON rt.oid = c.confrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND rt.relname = $1 AND array_length(c.conkey, 1) = 1
      ORDER BY 1, 2`,
    [table]
  );
  return rows;
}
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

// How many rows point at each id — the preview the screen shows before a
// merge, and the audit kept after it.
export async function referenceCounts(db, table, id) {
  const out = [];
  for (const r of await refsTo(db, table)) {
    if (table === "customers" && r.tbl === "customers") continue;
    if (table === "sites" && r.tbl === "sites") continue;
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${ident(r.tbl)} WHERE ${ident(r.col)} = $1`, [id]);
    if (rows[0].n) out.push({ table: r.tbl, column: r.col, rows: rows[0].n });
  }
  return out;
}

// Settings that may exist only once per record: when the stayer already has
// one, the duplicate's is dropped first so the move can't collide.
async function dropSiteCollisions(db, fromId, toId) {
  await db.query(
    `DELETE FROM customer_access_token_sites d WHERE d.site_id = $1
       AND EXISTS (SELECT 1 FROM customer_access_token_sites k WHERE k.token_id = d.token_id AND k.site_id = $2)`, [fromId, toId]);
  await db.query(`DELETE FROM sales_forecasts WHERE site_id = $1 AND EXISTS (SELECT 1 FROM sales_forecasts WHERE site_id = $2)`, [fromId, toId]);
  await db.query(`DELETE FROM mixtrack_qc_delays WHERE site_id = $1 AND EXISTS (SELECT 1 FROM mixtrack_qc_delays WHERE site_id = $2)`, [fromId, toId]);
}
async function dropCustomerCollisions(db, fromId, toId) {
  await db.query(
    `DELETE FROM mix_design_assignments d WHERE d.customer_id = $1
       AND EXISTS (SELECT 1 FROM mix_design_assignments k WHERE k.customer_id = $2 AND k.mix_grade_id = d.mix_grade_id)`, [fromId, toId]);
  await db.query(
    `DELETE FROM mixtrack_qc_delays WHERE customer_id = $1 AND site_id IS NULL
       AND EXISTS (SELECT 1 FROM mixtrack_qc_delays WHERE customer_id = $2 AND site_id IS NULL)`, [fromId, toId]);
}

async function moveRefs(db, table, fromId, toId) {
  const moved = [];
  for (const r of await refsTo(db, table)) {
    // A customer row has no customer_id of its own; sites.customer_id IS moved
    // for a customer merge (the duplicate's projects come along).
    if (r.tbl === table) continue;
    const res = await db.query(`UPDATE ${ident(r.tbl)} SET ${ident(r.col)} = $2 WHERE ${ident(r.col)} = $1`, [fromId, toId]);
    if (res.rowCount) moved.push({ table: r.tbl, column: r.col, rows: res.rowCount });
  }
  return moved;
}

// Merge project / site `fromId` into `toId`. Both must belong to the same
// customer by the time this runs (mergeCustomers first when they don't).
export async function mergeSite(db, fromId, toId, userId, note = null) {
  if (Number(fromId) === Number(toId)) throw Object.assign(new Error("That is the same project."), { status: 400 });
  const { rows } = await db.query(`SELECT id, customer_id, name, is_active FROM sites WHERE id = ANY($1::int[]) FOR UPDATE`, [[fromId, toId]]);
  const from = rows.find((r) => r.id === Number(fromId)), to = rows.find((r) => r.id === Number(toId));
  if (!from || !to) throw Object.assign(new Error("One of the projects was not found."), { status: 404 });
  if (from.customer_id !== to.customer_id) {
    throw Object.assign(new Error("These projects belong to different customers — merge the customers first."), { status: 400 });
  }
  await dropSiteCollisions(db, from.id, to.id);
  const moved = await moveRefs(db, "sites", from.id, to.id);
  await db.query(`UPDATE sites SET is_active = false, merged_into_id = $2 WHERE id = $1`, [from.id, to.id]);
  await db.query(`UPDATE sites SET merged_into_id = $2 WHERE merged_into_id = $1`, [from.id, to.id]);
  await db.query(
    `INSERT INTO record_merges (kind, from_id, to_id, from_name, to_name, moved, note, merged_by) VALUES ('site', $1, $2, $3, $4, $5, $6, $7)`,
    [from.id, to.id, from.name, to.name, JSON.stringify(moved), note, userId]);
  return { from, to, moved };
}

// Merge customer `fromId` into `toId`: every order, invoice, receipt,
// quotation, price-list row, ledger line … and all its projects move across.
export async function mergeCustomer(db, fromId, toId, userId, note = null) {
  if (Number(fromId) === Number(toId)) throw Object.assign(new Error("That is the same customer."), { status: 400 });
  const { rows } = await db.query(`SELECT id, name, is_active FROM customers WHERE id = ANY($1::int[]) FOR UPDATE`, [[fromId, toId]]);
  const from = rows.find((r) => r.id === Number(fromId)), to = rows.find((r) => r.id === Number(toId));
  if (!from || !to) throw Object.assign(new Error("One of the customers was not found."), { status: 404 });
  await dropCustomerCollisions(db, from.id, to.id);
  const moved = await moveRefs(db, "customers", from.id, to.id);
  await db.query(`UPDATE customers SET is_active = false, merged_into_id = $2 WHERE id = $1`, [from.id, to.id]);
  await db.query(`UPDATE customers SET merged_into_id = $2 WHERE merged_into_id = $1`, [from.id, to.id]);
  await db.query(
    `INSERT INTO record_merges (kind, from_id, to_id, from_name, to_name, moved, note, merged_by) VALUES ('customer', $1, $2, $3, $4, $5, $6, $7)`,
    [from.id, to.id, from.name, to.name, JSON.stringify(moved), note, userId]);
  return { from, to, moved };
}

// ---------------------------------------------------------- look-alike finder
// For each held delivery's customer + project: price lists (or open / accepted
// quotations) sitting on a DIFFERENT record whose names look like these. That
// is the duplicate to merge in.
export async function lookAlikePriceLists(held) {
  if (!held.length) return new Map();
  const { rows: priced } = await query(
    `SELECT s.id AS site_id, s.name AS site_name, c.id AS customer_id, c.name AS customer_name,
            (SELECT array_agg(DISTINCT g.name ORDER BY g.name) FROM rate_master rm JOIN mix_grades g ON g.id = rm.mix_grade_id
              WHERE rm.site_id = s.id AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)) AS grades,
            (SELECT array_agg(DISTINCT rm.mix_grade_id) FROM rate_master rm
              WHERE rm.site_id = s.id AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE)) AS grade_ids,
            (SELECT json_build_object('id', q.id, 'quote_no', q.quote_no, 'status', q.status) FROM quotations q
              WHERE q.site_id = s.id AND q.status IN ('accepted', 'pending_approval', 'approved', 'sent')
              ORDER BY (q.status = 'accepted') DESC, q.id DESC LIMIT 1) AS quotation,
            (SELECT count(*)::int FROM customer_orders co WHERE co.site_id = s.id) AS orders
       FROM sites s JOIN customers c ON c.id = s.customer_id
      WHERE COALESCE(s.is_active, true) AND COALESCE(c.is_active, true)
        AND (EXISTS (SELECT 1 FROM rate_master rm WHERE rm.site_id = s.id AND (rm.effective_to IS NULL OR rm.effective_to >= CURRENT_DATE))
             OR EXISTS (SELECT 1 FROM quotations q WHERE q.site_id = s.id AND q.status IN ('accepted', 'pending_approval', 'approved', 'sent')))`
  );
  const out = new Map();
  for (const h of held) {
    const key = `${h.customer_id}|${h.site_id}`;
    if (out.has(key)) continue;
    const hits = [];
    for (const p of priced) {
      if (p.site_id === h.site_id) continue;
      const sameCustomer = p.customer_id === h.customer_id;
      const cScore = sameCustomer ? 1 : nameScore(p.customer_name, h.customer_name);
      const sScore = nameScore(p.site_name, h.site_name);
      // Same customer: the project names must look alike. Another customer:
      // both must, or the customer name be all but the same and the project
      // close enough.
      if (!(sameCustomer ? sScore >= 0.6 : (cScore >= 0.6 && sScore >= 0.6) || (cScore >= 0.85 && sScore >= 0.5))) continue;
      hits.push({
        customer_id: p.customer_id, customer_name: p.customer_name, site_id: p.site_id, site_name: p.site_name,
        same_customer: sameCustomer, grades: p.grades || [], grade_ids: p.grade_ids || [], quotation: p.quotation, orders: p.orders,
        score: Math.round((cScore + sScore) * 50),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    out.set(key, hits.slice(0, 3));
  }
  return out;
}

export const ROUND230_MERGE_SQL = `
ALTER TABLE customers ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES customers(id);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES sites(id);
CREATE TABLE IF NOT EXISTS record_merges (
  id         SERIAL PRIMARY KEY,
  kind       VARCHAR(10) NOT NULL CHECK (kind IN ('customer', 'site')),
  from_id    INTEGER NOT NULL,
  to_id      INTEGER NOT NULL,
  from_name  VARCHAR(200),
  to_name    VARCHAR(200),
  moved      JSONB,
  note       TEXT,
  merged_by  INTEGER REFERENCES users(id),
  merged_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
