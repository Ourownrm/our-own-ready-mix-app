// Round 194 — raw material lab tests: plans, card issuing, and the schema.
//
// A material's TEST PLAN says which tests it gets and when. When Store books a
// load in (POST /material-module/receipts), issueCardsForReceipt() walks that
// material's plan and hands the Lab Technician a CARD for every test that
// falls due — the same idea as a pour handing out cube-test cards. The lab
// types raw readings, lib/rmTestDefs.js works the result out, an
// Administrator approves it, and the report is filed against the GRN, the
// supplier and the material (routes/rmTests.js).
//
// WHEN A CARD IS DUE. IS 4926:2003 Annex B sets minimum frequencies, not
// "every truck", so most plans are `period`: one card per supplier per period
// (7 days, a month, ...), issued on the first GRN inside it. Ten lorries of
// 20 mm in a week make one weekly grading card, not ten. A supplier nobody has
// tested before gets one on its very first load, because there is no earlier
// card inside any window — that is the "new source" rule, for free.
//
// HIGH AND LOW RATE (IS 4926 B-1.1). A plan may carry a low-rate period and a
// streak length. Once that many approved results in a row for this material
// and supplier conform (or are record-only), the supplier drops to the low
// rate; one non-conforming result puts it straight back on the high rate.
// Worked out LIVE from the approved history every time — never stored — so it
// can never drift from the results it is based on.
//
// A card is never issued twice for the same test inside a window, even when
// two lorries are booked in the same second: each plan is taken under a
// transaction-scoped advisory lock before the "is there one already" check.
import { pool, query } from "../db.js";
import { TEST_DEFS, STANDARD_PLANS, testLabel, periodLabel } from "./rmTestDefs.js";
import { pushToRole } from "./push.js";

// Advisory-lock namespace for this feature (the first int of the two-int
// form), so a plan id can never collide with another feature's lock.
const LOCK_NS = 194;

// ---------------------------------------------------------------------------
// Schema. The SAME statements are in schema.sql for a fresh database; this
// runs from /setup on every visit and is additive and re-runnable.
// ---------------------------------------------------------------------------
export const RM_TEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rm_test_plans (
  id          SERIAL PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES rm_materials(id),
  test_code   VARCHAR(40) NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  form_no     VARCHAR(30),
  trigger     VARCHAR(16) NOT NULL DEFAULT 'period'
              CHECK (trigger IN ('every_grn', 'period', 'scheduled', 'off')),
  high_days   INTEGER CHECK (high_days IS NULL OR high_days > 0),
  low_days    INTEGER CHECK (low_days IS NULL OR low_days > 0),
  low_after   INTEGER CHECK (low_after IS NULL OR low_after > 0),
  hold_stock  BOOLEAN NOT NULL DEFAULT false,
  due_hours   INTEGER NOT NULL DEFAULT 24 CHECK (due_hours > 0),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rm_test_plans_material ON rm_test_plans(material_id);

CREATE TABLE IF NOT EXISTS rm_test_cards (
  id               SERIAL PRIMARY KEY,
  plan_id          INTEGER REFERENCES rm_test_plans(id) ON DELETE SET NULL,
  test_code        VARCHAR(40) NOT NULL,
  params           JSONB NOT NULL DEFAULT '{}'::jsonb,
  form_no          VARCHAR(30),
  material_id      INTEGER NOT NULL REFERENCES rm_materials(id),
  supplier_id      INTEGER REFERENCES rm_suppliers(id),
  receipt_id       INTEGER REFERENCES rm_receipts(id) ON DELETE SET NULL,
  source           VARCHAR(12) NOT NULL DEFAULT 'grn' CHECK (source IN ('grn', 'scheduled', 'manual')),
  reason           TEXT,
  rate             VARCHAR(6),
  vehicle_number   VARCHAR(20),
  received_date    DATE,
  hold_stock       BOOLEAN NOT NULL DEFAULT false,
  due_at           TIMESTAMPTZ,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'in_progress', 'submitted', 'approved', 'closed')),
  readings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  result           JSONB,
  verdict          VARCHAR(16),
  summary          TEXT,
  sampled_by       VARCHAR(80),
  sampled_at       TIMESTAMPTZ,
  tested_on        DATE,
  equipment        TEXT,
  remarks          TEXT,
  started_by       INTEGER REFERENCES users(id),
  started_at       TIMESTAMPTZ,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TIMESTAMPTZ,
  submitted_by     INTEGER REFERENCES users(id),
  submitted_at     TIMESTAMPTZ,
  approved_by      INTEGER REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  sent_back_by     INTEGER REFERENCES users(id),
  sent_back_at     TIMESTAMPTZ,
  sent_back_reason TEXT,
  closed_by        INTEGER REFERENCES users(id),
  closed_at        TIMESTAMPTZ,
  closed_reason    TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rm_test_cards_status  ON rm_test_cards(status);
CREATE INDEX IF NOT EXISTS idx_rm_test_cards_window  ON rm_test_cards(material_id, supplier_id, test_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rm_test_cards_receipt ON rm_test_cards(receipt_id);
CREATE INDEX IF NOT EXISTS idx_rm_test_cards_plan    ON rm_test_cards(plan_id, created_at DESC);

-- One row per material that has been given the standard plan once. A material
-- added later gets it on its first GRN; one the Administrator has emptied on
-- purpose is never refilled behind their back.
CREATE TABLE IF NOT EXISTS rm_test_plan_seeds (
  material_id INTEGER PRIMARY KEY REFERENCES rm_materials(id),
  seeded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Which standard plan a material gets, from its mix_component (Round 142's
// classification), else a guess from its name. null = no standard plan; the
// Administrator builds one by hand on the Test plans screen.
export function standardKindFor(material) {
  if (material.mix_component && STANDARD_PLANS[material.mix_component]) return material.mix_component;
  const name = String(material.name || "").toLowerCase();
  if (/fly\s*ash/.test(name)) return "fly_ash";
  if (/admix|plasticis|plasticiz|\bpce\b|\bsnf\b|retard/.test(name)) return "admixture";
  if (/cement|\bopc\b|\bppc\b|\bpsc\b/.test(name)) return "cement";
  if (/sand|m-?sand|fine/.test(name)) return "fine_agg";
  if (/12\.?5|12\s*mm|10\s*mm/.test(name)) return "coarse_12_5mm";
  if (/20\s*mm|40\s*mm|aggregate|metal|jelly/.test(name)) return "coarse_20mm";
  return null;
}

// Adds the standard plan's tests a material does not already have (matched
// on test + external test name). Returns how many were added.
export async function loadStandardPlan(db, material, userId) {
  const kind = standardKindFor(material);
  if (!kind) return { kind: null, added: 0 };
  const { rows: existing } = await db.query(
    `SELECT test_code, COALESCE(params->>'name', '') AS name FROM rm_test_plans WHERE material_id = $1`,
    [material.id]
  );
  const have = new Set(existing.map((r) => r.test_code + "|" + r.name));
  let added = 0;
  let order = existing.length;
  for (const p of STANDARD_PLANS[kind]) {
    const key = p.test_code + "|" + ((p.params && p.params.name) || "");
    if (have.has(key)) continue;
    await db.query(
      `INSERT INTO rm_test_plans
         (material_id, test_code, params, form_no, trigger, high_days, low_days, low_after, hold_stock, due_hours, sort_order, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [material.id, p.test_code, JSON.stringify(p.params || {}), (TEST_DEFS[p.test_code] && TEST_DEFS[p.test_code].form) || null,
        p.trigger, p.high_days || null, p.low_days || null, p.low_after || null, !!p.hold_stock, p.due_hours || 24, order++, userId || null]
    );
    added++;
  }
  return { kind, added };
}

// Called from /setup. Creates the tables, then — ONCE per installation —
// loads the standard plan onto every active material that has none, so the
// lab starts getting cards on the very next GRN without anyone configuring
// anything. Every material is then recorded in rm_test_plan_seeds, so one
// whose plan the Administrator later empties on purpose stays empty. A
// material created after this gets its standard plan on its first GRN
// (ensureSeeded, below) — by then its mix component is usually set.
export async function migrateRmLabTests(db, log) {
  await db.query(RM_TEST_SCHEMA_SQL);
  await db.query(`CREATE TABLE IF NOT EXISTS app_migration_marks (mark VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows: done } = await db.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r194_rm_test_plans'`);
  if (done.length) {
    log.push("Round 194 — raw material test tables in place; test plans left as the Administrator has them.");
    return;
  }
  const { rows: mats } = await db.query(
    `SELECT m.id, m.name, m.mix_component FROM rm_materials m
      WHERE m.is_active AND NOT EXISTS (SELECT 1 FROM rm_test_plans p WHERE p.material_id = m.id)
      ORDER BY m.name`
  );
  const seeded = [];
  for (const m of mats) {
    const r = await loadStandardPlan(db, m, null);
    if (r.added) seeded.push(`${m.name} (${r.added})`);
  }
  await db.query(`INSERT INTO rm_test_plan_seeds (material_id) SELECT id FROM rm_materials ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO app_migration_marks (mark) VALUES ('r194_rm_test_plans') ON CONFLICT DO NOTHING`);
  log.push(
    "Schema migration applied (Round 194 — raw material lab tests). " +
    (seeded.length
      ? `Standard test plans loaded for: ${seeded.join(", ")}. Review them under Quality Control → Raw Material Tests → Test plans.`
      : "No existing material matched a standard plan. Materials get theirs on their first GRN (from their mix component), or set plans up under Quality Control → Raw Material Tests → Test plans.")
  );
}

// ---------------------------------------------------------------------------
// Rate (IS 4926 B-1.1), computed live.
// ---------------------------------------------------------------------------
function sameTestSql(alias = "c") {
  // The identity of "this test for this material and supplier" — external
  // tests are told apart by their name, everything else by its code.
  return `${alias}.test_code = $1 AND ${alias}.material_id = $2 AND ${alias}.supplier_id IS NOT DISTINCT FROM $3
          AND COALESCE(${alias}.params->>'name', '') = $4`;
}

export async function rateFor(db, plan, supplierId) {
  if (!plan.low_days || !plan.low_after) return { rate: "high", streak: 0 };
  const name = (plan.params && plan.params.name) || "";
  const { rows } = await db.query(
    `SELECT c.verdict FROM rm_test_cards c
      WHERE ${sameTestSql("c")} AND c.status = 'approved'
      ORDER BY c.approved_at DESC LIMIT $5`,
    [plan.test_code, plan.material_id, supplierId, name, plan.low_after]
  );
  let streak = 0;
  for (const r of rows) {
    if (r.verdict === "non_conforming") break;
    streak++;
  }
  return { rate: streak >= plan.low_after ? "low" : "high", streak };
}

// ---------------------------------------------------------------------------
// Issuing cards for one GRN.
// ---------------------------------------------------------------------------
export async function issueCardsForReceipt(receiptId, userId) {
  const client = await pool.connect();
  const issued = [];
  let rec;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT r.id, r.vehicle_number, to_char(r.received_date, 'YYYY-MM-DD') AS received_date,
              o.material_id, o.supplier_id, m.name AS material_name, s.name AS supplier_name
         FROM rm_receipts r   -- receipts-raw: a pending (disputed-qty) load is still in the yard and still needs testing
         JOIN rm_orders o ON o.id = r.order_id
         JOIN rm_materials m ON m.id = o.material_id
         JOIN rm_suppliers s ON s.id = o.supplier_id
        WHERE r.id = $1`,
      [receiptId]
    );
    rec = rows[0];
    if (!rec) { await client.query("ROLLBACK"); return []; }

    // A material this feature has never seen gets the standard plan now.
    const { rows: fresh } = await client.query(
      `INSERT INTO rm_test_plan_seeds (material_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING material_id`,
      [rec.material_id]
    );
    if (fresh.length) {
      const { rows: mat } = await client.query(`SELECT id, name, mix_component FROM rm_materials WHERE id = $1`, [rec.material_id]);
      await loadStandardPlan(client, mat[0], null);
    }

    const { rows: plans } = await client.query(
      `SELECT * FROM rm_test_plans
        WHERE material_id = $1 AND is_active AND trigger IN ('every_grn', 'period')
        ORDER BY sort_order, id`,
      [rec.material_id]
    );
    for (const plan of plans) {
      if (!TEST_DEFS[plan.test_code]) continue;
      await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [LOCK_NS, plan.id]);
      const name = (plan.params && plan.params.name) || "";
      let reason;
      let rate = null;
      if (plan.trigger === "every_grn") {
        reason = "Every GRN";
      } else {
        const r = await rateFor(client, plan, rec.supplier_id);
        rate = r.rate;
        const days = (rate === "low" ? plan.low_days : plan.high_days) || plan.high_days || 30;
        const { rows: inWindow } = await client.query(
          `SELECT 1 FROM rm_test_cards c
            WHERE ${sameTestSql("c")} AND c.status <> 'closed'
              AND c.created_at > now() - make_interval(days => $5)
            LIMIT 1`,
          [plan.test_code, rec.material_id, rec.supplier_id, name, days]
        );
        if (inWindow.length) continue;
        const { rows: ever } = await client.query(
          `SELECT 1 FROM rm_test_cards c WHERE ${sameTestSql("c")} AND c.status <> 'closed' LIMIT 1`,
          [plan.test_code, rec.material_id, rec.supplier_id, name]
        );
        reason = !ever.length
          ? `First test on record for ${rec.supplier_name}`
          : `${periodLabel(days)} · first GRN from ${rec.supplier_name} in ${days} day${days === 1 ? "" : "s"}` +
            (rate === "low" ? ` (low rate: last ${r.streak} results in tolerance)` : plan.low_days ? " (high rate)" : "");
      }
      const { rows: card } = await client.query(
        `INSERT INTO rm_test_cards
           (plan_id, test_code, params, form_no, material_id, supplier_id, receipt_id, source, reason, rate,
            vehicle_number, received_date, hold_stock, due_at, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, 'grn', $8, $9, $10, $11::date, $12,
                 now() + make_interval(hours => $13), $14)
         RETURNING id, test_code, params`,
        [plan.id, plan.test_code, JSON.stringify(plan.params || {}), plan.form_no, rec.material_id, rec.supplier_id,
          rec.id, reason, rate, rec.vehicle_number, rec.received_date, plan.hold_stock, plan.due_hours, userId || null]
      );
      issued.push(card[0]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (issued.length) {
    const names = issued.map((c) => testLabel(c.test_code, c.params)).join(", ");
    const msg = `${rec.material_name} from ${rec.supplier_name}${rec.vehicle_number ? " (" + rec.vehicle_number + ")" : ""}: ${names}`;
    try {
      await query(`INSERT INTO notifications (recipient_role, type, message) VALUES ('lab_technician', 'rm_test_due', $1)`, [`Lab test due — ${msg}`]);
      await pushToRole("lab_technician", { title: `Lab test${issued.length > 1 ? "s" : ""} due`, body: msg, url: "/rm-tests" });
    } catch (e) {
      console.error("rm test card notification failed:", e.message);
    }
  }
  return issued;
}

// ---------------------------------------------------------------------------
// Scheduled cards (moisture every day, water every 3 months, ...). Made lazily
// when the lab's list is opened rather than by a timer — nothing to keep
// running, and a day nobody opens the screen is a day nobody was testing.
// ---------------------------------------------------------------------------
let lastEnsure = 0;
export async function ensureScheduledCards() {
  if (Date.now() - lastEnsure < 60 * 1000) return;
  lastEnsure = Date.now();
  const { rows: plans } = await query(
    `SELECT p.* FROM rm_test_plans p JOIN rm_materials m ON m.id = p.material_id
      WHERE p.is_active AND p.trigger = 'scheduled' AND m.is_active`
  );
  for (const plan of plans) {
    if (!TEST_DEFS[plan.test_code]) continue;
    const days = plan.high_days || 1;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [LOCK_NS, plan.id]);
      // The window starts at IST midnight (db.js pins every session to
      // Asia/Kolkata), so a daily card belongs to the plant's day, not UTC's.
      const { rows: have } = await client.query(
        `SELECT 1 FROM rm_test_cards
          WHERE plan_id = $1 AND source = 'scheduled'
            AND created_at >= (CURRENT_DATE - ($2::int - 1))::timestamptz
          LIMIT 1`,
        [plan.id, days]
      );
      if (!have.length) {
        await client.query(
          `INSERT INTO rm_test_cards
             (plan_id, test_code, params, form_no, material_id, supplier_id, source, reason, due_at, hold_stock)
           VALUES ($1, $2, $3::jsonb, $4, $5, NULL, 'scheduled', $6, now() + make_interval(hours => $7), false)`,
          [plan.id, plan.test_code, JSON.stringify(plan.params || {}), plan.form_no, plan.material_id,
            `Scheduled · ${periodLabel(days).toLowerCase()}`, plan.due_hours]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("scheduled rm test card failed:", err.message);
    } finally {
      client.release();
    }
  }
}

// For tests: forget the throttle.
export function resetScheduleThrottle() {
  lastEnsure = 0;
}
