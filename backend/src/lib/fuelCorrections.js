// Round 220 (owner, 20 Oct 2026) — correcting the diesel tank's history.
//
// What happened at the plant: diesel deliveries were not received in the app
// when they came, so the tank's book stock went below zero while there really
// was diesel in the tank. Stock was "adjusted" to the physical count to get
// going again — several times — and the old deliveries were then all received
// on one day (11 Oct 2026). Each of those adjustments was really covering a
// delivery that was not in the app yet, so the month's figures were wrong.
//
// The tool, Administrator only (fuel.corrections):
//   1. Put each delivery on the date it really arrived.
//   2. Void an adjustment that was not a physical count at all (e.g. one made
//      to reverse earlier adjustments).
//   3. Recalculate every adjustment from its PHYSICAL COUNT: an adjustment is
//      "the tank held X litres at that moment", so its change is X minus the
//      book stock just before it, worked out again in date order once the
//      deliveries sit on their real dates. The last count still sets today's
//      stock, so the current balance does not move unless the last count is
//      voided.
// Preview first, apply after: nothing is written until the Administrator
// applies, and everything applied is logged in fuel_corrections.
import { pool, query } from "../db.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const ROUND220_SQL = `
ALTER TABLE store_stock_transactions ADD COLUMN IF NOT EXISTS counted_qty NUMERIC(10,2);
ALTER TABLE store_stock_transactions ADD COLUMN IF NOT EXISTS original_created_at TIMESTAMPTZ;
ALTER TABLE store_stock_transactions ADD COLUMN IF NOT EXISTS original_qty_change NUMERIC(10,2);
ALTER TABLE store_stock_transactions ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE store_stock_transactions ADD COLUMN IF NOT EXISTS voided_by INTEGER REFERENCES users(id);
ALTER TABLE store_stock_transactions ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE store_stock_purchases ADD COLUMN IF NOT EXISTS original_received_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS fuel_corrections (
  id          SERIAL PRIMARY KEY,
  batch_id    INTEGER,
  kind        VARCHAR(20) NOT NULL,          -- receipt_date | void | restore | recalc
  ref_id      INTEGER,                       -- purchase id or transaction id
  old_value   TEXT,
  new_value   TEXT,
  reason      TEXT,
  done_by     INTEGER REFERENCES users(id),
  done_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fuel_corrections_batch ON fuel_corrections (batch_id);
`;

export async function migrateRound220(pool_, log) {
  await pool_.query(ROUND220_SQL);
  // An adjustment always set the book to the counted figure, so balance_after
  // at the time IS the count. Kept once, before any recalculation can move it.
  const { rowCount } = await pool_.query(
    `UPDATE store_stock_transactions SET counted_qty = balance_after
      WHERE txn_type = 'adjustment' AND counted_qty IS NULL`);
  log.push(`Schema migration applied (Round 220 — fuel corrections: ${rowCount} adjustment(s) given their physical count).`);
}

async function fuelItemId(client) {
  const { rows } = await client.query(`SELECT id, current_qty FROM store_stock_items WHERE item_type = 'fuel' ORDER BY id LIMIT 1`);
  return rows[0] || null;
}

// The tank's whole history, with the staged edits applied in memory.
async function loadHistory(client, item, edits) {
  const { rows } = await client.query(
    `SELECT x.id, x.txn_type::text AS txn_type, x.qty_change, x.balance_after, x.counted_qty, x.created_at,
            x.reference_type, x.reference_id, x.note, x.voided_at, x.original_created_at, x.original_qty_change,
            u.name AS by_name, sp.supplier_name, sp.approved_at AS purchase_approved_at, sp.requested_at AS purchase_requested_at
       FROM store_stock_transactions x
       LEFT JOIN users u ON u.id = x.created_by
       LEFT JOIN store_stock_purchases sp ON x.reference_type = 'store_stock_purchase' AND sp.id = x.reference_id
      WHERE x.stock_item_id = $1
      ORDER BY x.created_at, x.id`, [item.id]);
  const dates = new Map((edits.receipt_dates || []).map((e) => [Number(e.id), e.received_at]));
  const voids = new Set((edits.voids || []).map(Number));
  const restores = new Set((edits.restores || []).map(Number));
  return rows.map((r) => {
    const t = { ...r, qty_change: Number(r.qty_change), balance_after: Number(r.balance_after),
      counted_qty: r.counted_qty == null ? null : Number(r.counted_qty), at: new Date(r.created_at), moved: false,
      voided: !!r.voided_at };
    if (r.txn_type === "purchase_receive" && dates.has(Number(r.reference_id))) {
      const nd = new Date(dates.get(Number(r.reference_id)));
      if (+nd !== +t.at) { t.at = nd; t.moved = true; }
    }
    if (r.txn_type === "adjustment") {
      if (voids.has(r.id)) t.voided = true;
      if (restores.has(r.id)) t.voided = false;
    }
    return t;
  });
}

// Walk the history in date order. Deliveries and issues keep their litres;
// each adjustment becomes (its count − the book just before it); a voided one
// becomes 0. `offset` keeps any difference that is older than the history
// (there should be none) so the walk ends where the stored entries do.
function recalc(history, currentQty) {
  const storedSum = history.reduce((t, x) => t + x.qty_change, 0);
  const offset = r2(currentQty - storedSum);
  const ordered = [...history].sort((a, b) => a.at - b.at || a.id - b.id);
  let bal = offset;
  for (const t of ordered) {
    if (t.txn_type === "adjustment") {
      if (t.voided) t.new_change = 0;
      else {
        const count = t.counted_qty != null ? t.counted_qty : t.balance_after;
        t.book_before = r2(bal);
        t.new_change = r2(count - bal);
      }
    } else {
      t.new_change = t.qty_change;
    }
    if (t.txn_type === "adjustment" && !t.voided) t.book_before = r2(bal);
    bal = r2(bal + t.new_change);
    t.new_balance = bal;
  }
  return { ordered, closing: bal, offset };
}

const ymOf = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 7); // ist-ok: shifts to IST before slicing the month
const dayOf = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10); // ist-ok: shifts to IST before slicing the day

function monthEffect(history, useNew) {
  const m = new Map();
  for (const t of history) {
    const at = useNew ? t.at : new Date(t.created_at);
    const ym = ymOf(at);
    if (!m.has(ym)) m.set(ym, { month: ym, received: 0, issued: 0, adj_net: 0 });
    const row = m.get(ym);
    const q = useNew ? t.new_change : t.qty_change;
    if (t.txn_type === "purchase_receive") row.received += q;
    else if (t.txn_type === "issue_deduct") row.issued -= q;
    else row.adj_net += q;
  }
  return m;
}

export async function correctionsState(edits = {}, client = pool) {
  const item = await fuelItemId(client);
  if (!item) return { error: "No diesel stock item." };
  const history = await loadHistory(client, item, edits);
  const { ordered, closing, offset } = recalc(history, Number(item.current_qty));
  const before = monthEffect(history, false), after = monthEffect(ordered, true);
  const months = [...new Set([...before.keys(), ...after.keys()])].sort().map((ym) => {
    const b = before.get(ym) || { received: 0, issued: 0, adj_net: 0 }, a = after.get(ym) || { received: 0, issued: 0, adj_net: 0 };
    return { month: ym, before: { received: r2(b.received), issued: r2(b.issued), adj_net: r2(b.adj_net) },
      after: { received: r2(a.received), issued: r2(a.issued), adj_net: r2(a.adj_net) } };
  });
  // Lowest point of the book after the corrections — a negative one means a
  // delivery is still missing or still on the wrong date.
  let low = null;
  for (const t of ordered) if (low == null || t.new_balance < low.balance) low = { balance: t.new_balance, at: t.at, id: t.id };

  const { rows: purchases } = await client.query(
    `SELECT sp.id, sp.supplier_name, sp.received_qty, sp.unit_cost, sp.total_cost, sp.requested_at, sp.approved_at, sp.received_at,
            sp.original_received_at, ur.name AS received_by_name
       FROM store_stock_purchases sp LEFT JOIN users ur ON ur.id = sp.received_by
      WHERE sp.stock_item_id = $1 AND sp.status = 'received' ORDER BY sp.received_at DESC LIMIT 300`, [item.id]);
  const moved = new Map(history.filter((t) => t.txn_type === "purchase_receive").map((t) => [Number(t.reference_id), t]));
  return {
    item_id: item.id,
    current_qty: Number(item.current_qty),
    closing_after: closing,
    offset,
    lowest: low ? { balance: low.balance, day: dayOf(low.at) } : null,
    receipts: purchases.map((p) => {
      const t = moved.get(p.id);
      return {
        id: p.id, ref: `FPR-${p.id}`, supplier: p.supplier_name, litres: Number(p.received_qty), rate: p.unit_cost == null ? null : Number(p.unit_cost),
        value: p.total_cost == null ? null : Number(p.total_cost), requested_at: p.requested_at, approved_at: p.approved_at,
        received_at: p.received_at, new_received_at: t ? t.at : p.received_at, staged: !!t?.moved,
        original_received_at: p.original_received_at, received_by: p.received_by_name,
      };
    }),
    adjustments: ordered.filter((t) => t.txn_type === "adjustment").map((t) => ({
      id: t.id, ref: `ADJ-${t.id}`, at: t.at, by: t.by_name, note: t.note,
      counted: t.counted_qty != null ? t.counted_qty : t.balance_after,
      entered_change: t.original_qty_change != null ? Number(t.original_qty_change) : t.qty_change,
      current_change: t.qty_change, new_change: t.new_change, book_before: t.book_before ?? null,
      voided: t.voided, voided_now: t.voided && !t.voided_at, restored_now: !t.voided && !!t.voided_at,
    })).reverse(),
    months,
    changed: ordered.filter((t) => t.moved || t.new_change !== t.qty_change || r2(t.new_balance) !== r2(t.balance_after)
      || (t.txn_type === "adjustment" && t.voided !== !!t.voided_at)).length,
  };
}

const DAY_MS = 86400000;
function checkEdits(edits, state) {
  const errors = [];
  const now = Date.now();
  const recById = new Map(state.receipts.map((r) => [r.id, r]));
  for (const e of edits.receipt_dates || []) {
    const r = recById.get(Number(e.id));
    const d = new Date(e.received_at);
    if (!r) errors.push(`Delivery ${e.id} not found.`);
    else if (Number.isNaN(+d)) errors.push(`${r.ref}: not a valid date.`);
    else if (+d > now + 5 * 60000) errors.push(`${r.ref}: the date is in the future.`);
    else if (r.requested_at && +d < +new Date(r.requested_at) - DAY_MS) errors.push(`${r.ref}: received before it was requested.`);
  }
  const adjIds = new Set(state.adjustments.map((a) => a.id));
  for (const id of [...(edits.voids || []), ...(edits.restores || [])]) if (!adjIds.has(Number(id))) errors.push(`Adjustment ${id} not found.`);
  return errors;
}

export async function previewCorrections(edits) {
  const state = await correctionsState(edits);
  if (state.error) return state;
  return { ...state, errors: checkEdits(edits, state) };
}

// Apply in one transaction: dates, voids, then every row's recalculated
// change and running balance, then the item's balance. Logged as one batch.
export async function applyCorrections(edits, userId, reason) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(220220)`);
    const state = await correctionsState(edits, client);
    if (state.error) throw Object.assign(new Error(state.error), { expose: true });
    const errors = checkEdits(edits, state);
    if (errors.length) throw Object.assign(new Error(errors.join(" ")), { expose: true });
    const item = await fuelItemId(client);
    const history = await loadHistory(client, item, edits);
    const { ordered, closing } = recalc(history, Number(item.current_qty));
    const { rows: b } = await client.query(`SELECT COALESCE(MAX(batch_id), 0) + 1 AS n FROM fuel_corrections`);
    const batch = b[0].n;
    const log = (kind, ref, oldV, newV) => client.query(
      `INSERT INTO fuel_corrections (batch_id, kind, ref_id, old_value, new_value, reason, done_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [batch, kind, ref, oldV == null ? null : String(oldV), newV == null ? null : String(newV), reason, userId]);
    let n = 0;
    for (const t of ordered) {
      const sets = [], vals = [];
      if (t.moved) {
        sets.push(`created_at = $${vals.push(t.at)}`, `original_created_at = COALESCE(original_created_at, created_at)`);
        await client.query(
          `UPDATE store_stock_purchases SET original_received_at = COALESCE(original_received_at, received_at), received_at = $1 WHERE id = $2`,
          [t.at, t.reference_id]);
        await log("receipt_date", t.reference_id, new Date(t.created_at).toISOString(), t.at.toISOString());
      }
      if (t.txn_type === "adjustment") {
        if (t.voided && !t.voided_at) {
          sets.push(`voided_at = now()`, `voided_by = $${vals.push(userId)}`, `void_reason = $${vals.push(reason)}`);
          await log("void", t.id, t.qty_change, 0);
        } else if (!t.voided && t.voided_at) {
          sets.push(`voided_at = NULL`, `voided_by = NULL`, `void_reason = NULL`);
          await log("restore", t.id, 0, t.new_change);
        }
        if (t.new_change !== t.qty_change) {
          sets.push(`original_qty_change = COALESCE(original_qty_change, qty_change)`);
          if (!(t.voided && !t.voided_at)) await log("recalc", t.id, t.qty_change, t.new_change);
        }
      }
      if (t.new_change !== t.qty_change) sets.push(`qty_change = $${vals.push(t.new_change)}`);
      if (r2(t.new_balance) !== r2(t.balance_after)) sets.push(`balance_after = $${vals.push(t.new_balance)}`);
      if (!sets.length) continue;
      vals.push(t.id);
      await client.query(`UPDATE store_stock_transactions SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
      n++;
    }
    if (r2(closing) !== r2(item.current_qty)) {
      await client.query(`UPDATE store_stock_items SET current_qty = $1 WHERE id = $2`, [closing, item.id]);
      await log("balance", item.id, item.current_qty, closing);
    }
    await client.query("COMMIT");
    return { ok: true, batch, rows_changed: n, closing };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function correctionsLog() {
  const { rows } = await query(
    `SELECT c.batch_id, c.kind, c.ref_id, c.old_value, c.new_value, c.reason, c.done_at, u.name AS by_name
       FROM fuel_corrections c LEFT JOIN users u ON u.id = c.done_by ORDER BY c.id DESC LIMIT 300`);
  return rows;
}
