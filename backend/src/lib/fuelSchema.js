// Round 199 — the Fuel module.
//
// Fuel stock itself is NOT moved anywhere: the diesel balance stays the one
// `store_stock_items` row with item_type = 'fuel', every change to it stays a
// `store_stock_transactions` row, purchases stay `store_stock_purchases`, and
// issues stay `supply_requests`. The Fuel module is a new place to SEE and run
// all of that, so Store and Fuel can never disagree about the balance.
//
// What is new here is only what had nowhere to live before:
//   fuel_settings          the tank (capacity, reorder level, early warning) and
//                          the analysis rules — Administrator-only to change
//   fuel_settings_log      who changed which setting, from what, to what
//   fuel_rate_history      every rate-per-litre the plant has used, with dates
//   fuel_exception_reviews a Manager's "I have looked at this" on an exception
//
// Run from /setup; purely additive and safe to run any number of times. A
// fresh database gets the same tables the same way (setup runs after
// schema.sql), so schema.sql does not need its own copy.

export const FUEL_SQL = `
CREATE TABLE IF NOT EXISTS fuel_settings (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tank_name           VARCHAR(80) NOT NULL DEFAULT 'Plant diesel tank',
  capacity_l          NUMERIC(10,2) CHECK (capacity_l IS NULL OR capacity_l > 0),
  reorder_level_l     NUMERIC(10,2) CHECK (reorder_level_l IS NULL OR reorder_level_l >= 0),
  warning_days        NUMERIC(5,1) NOT NULL DEFAULT 4 CHECK (warning_days >= 0),
  band_high_pct       NUMERIC(5,1) NOT NULL DEFAULT 12 CHECK (band_high_pct > 0),
  band_above_pct      NUMERIC(5,1) NOT NULL DEFAULT 3 CHECK (band_above_pct >= 0),
  band_efficient_pct  NUMERIC(5,1) NOT NULL DEFAULT 10 CHECK (band_efficient_pct > 0),
  close_fill_hours    NUMERIC(5,1) NOT NULL DEFAULT 6 CHECK (close_fill_hours >= 0),
  work_start          TIME NOT NULL DEFAULT '06:00',
  work_end            TIME NOT NULL DEFAULT '22:00',
  updated_by          INTEGER REFERENCES users(id),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fuel_settings_log (
  id          SERIAL PRIMARY KEY,
  field       VARCHAR(40) NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  INTEGER REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fuel_rate_history (
  id              SERIAL PRIMARY KEY,
  rate_per_liter  NUMERIC(10,2) NOT NULL CHECK (rate_per_liter >= 0),
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  set_by          INTEGER REFERENCES users(id),
  note            TEXT
);

CREATE TABLE IF NOT EXISTS fuel_exception_reviews (
  id             SERIAL PRIMARY KEY,
  check_key      VARCHAR(40) NOT NULL,
  reference_id   INTEGER NOT NULL,          -- supply_requests.id the exception was raised on
  note           TEXT NOT NULL,
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (check_key, reference_id)
);
`;

// Functions that sit inside the Fuel module and existed before it (only the
// 360° analysis). Whoever could open them keeps them: their role, or their own
// personal grant, gets the module switch too — same rule Round 192 applied when
// the first modules were introduced.
const EXISTING_INSIDE = ["reports.fuel-analysis"];

export async function migrateFuel(pool, log) {
  await pool.query(FUEL_SQL);

  // The one settings row. Reorder level starts from what Store Stock already
  // had for the fuel item, so nothing set there is lost.
  await pool.query(
    `INSERT INTO fuel_settings (id, reorder_level_l)
     SELECT 1, (SELECT reorder_level FROM store_stock_items WHERE item_type = 'fuel' LIMIT 1)
     ON CONFLICT (id) DO NOTHING`
  );

  // Rate history starts with today's rate, if one was ever set.
  await pool.query(
    `INSERT INTO fuel_rate_history (rate_per_liter, note)
     SELECT rate_per_liter, 'Rate in use when the Fuel module was introduced'
       FROM store_stock_items
      WHERE item_type = 'fuel' AND rate_per_liter IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fuel_rate_history)
      LIMIT 1`
  );

  // Access carried over, once.
  const { rows: mark } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r199_fuel_module'`);
  if (!mark.length) {
    const r1 = await pool.query(
      `INSERT INTO role_default_permissions (role, permission_key, action)
       SELECT DISTINCT role, 'module.fuel', 'view' FROM role_default_permissions
        WHERE permission_key = ANY($1::text[]) AND action = 'view'
          AND role::text NOT IN ('administrator', 'super_admin')
       ON CONFLICT DO NOTHING`,
      [EXISTING_INSIDE]
    );
    const r2 = await pool.query(
      `INSERT INTO user_permission_overrides (user_id, permission_key, action, granted, set_by, set_at)
       SELECT o.user_id, 'module.fuel', 'view', true, MIN(o.set_by), now()
         FROM user_permission_overrides o
         JOIN users u ON u.id = o.user_id
        WHERE o.granted AND o.permission_key = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM role_default_permissions d
                           WHERE d.role = u.role AND d.permission_key = 'module.fuel' AND d.action = 'view')
        GROUP BY o.user_id
       ON CONFLICT DO NOTHING`,
      [EXISTING_INSIDE]
    );
    await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r199_fuel_module') ON CONFLICT DO NOTHING`);
    log.push(`Schema migration applied (Round 199 — Fuel module: settings, rate history, exception reviews; ` +
      `${r1.rowCount} role(s) and ${r2.rowCount} person(s) kept their 360° Fuel Analysis by getting the Fuel module).`);
  } else {
    log.push("Round 199 — Fuel module tables already in place.");
  }
}
