// Round 195 — tables for the attendance machine (routes/attendance.js).
// Run from /setup; the same statements are at the end of schema.sql for a
// fresh database. Purely additive and safe to run any number of times.

export const ATTENDANCE_SQL = `
-- One row per attendance machine, keyed on its serial number (or "ip:<addr>"
-- for a machine that will not report one).
CREATE TABLE IF NOT EXISTS attendance_devices (
  id              SERIAL PRIMARY KEY,
  serial          VARCHAR(60) NOT NULL UNIQUE,
  label           VARCHAR(80),
  ip              VARCHAR(45),
  model           VARCHAR(60),
  firmware        VARCHAR(80),
  user_count      INTEGER,
  record_count    INTEGER,
  record_capacity INTEGER,
  device_time     TIMESTAMP,          -- the machine's own clock, IST wall time
  clock_drift_min INTEGER,            -- machine minus the agent PC, minutes
  agent_version   VARCHAR(20),
  last_seen_at    TIMESTAMPTZ,        -- the agent last checked in
  last_read_ok_at TIMESTAMPTZ,        -- the machine was last read successfully
  last_error      TEXT,
  last_error_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The machine's own user list. machine_user_id is the number a person was
-- enrolled under on the machine; linking it to an employee is the HR module's
-- job, not this table's.
CREATE TABLE IF NOT EXISTS attendance_device_users (
  device_id       INTEGER NOT NULL REFERENCES attendance_devices(id),
  machine_user_id VARCHAR(30) NOT NULL,
  name_on_machine VARCHAR(60),
  privilege       SMALLINT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, machine_user_id)
);

-- Every punch, exactly as the machine recorded it. Never edited: a manual
-- correction (HR module, later) is stored beside it, not over it.
CREATE TABLE IF NOT EXISTS attendance_punches (
  id              BIGSERIAL PRIMARY KEY,
  device_id       INTEGER NOT NULL REFERENCES attendance_devices(id),
  machine_user_id VARCHAR(30) NOT NULL,
  punched_at      TIMESTAMPTZ NOT NULL,
  key_state       SMALLINT,           -- key pressed on the machine: 0 in, 1 out, …
  verify_mode     SMALLINT,           -- 1 finger, 15 face, … as the machine reports
  work_code       INTEGER,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, machine_user_id, punched_at)
);
CREATE INDEX IF NOT EXISTS idx_att_punches_time ON attendance_punches(punched_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_punches_user ON attendance_punches(machine_user_id, punched_at);

CREATE TABLE IF NOT EXISTS attendance_sync_log (
  id               SERIAL PRIMARY KEY,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_id        INTEGER REFERENCES attendance_devices(id),
  agent_version    VARCHAR(20),
  punches_sent     INTEGER NOT NULL DEFAULT 0,
  punches_inserted INTEGER NOT NULL DEFAULT 0,
  punches_rejected INTEGER NOT NULL DEFAULT 0,
  users_sent       INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_sync_log_received ON attendance_sync_log(received_at DESC);
`;

export async function migrateAttendance(pool, log) {
  await pool.query(ATTENDANCE_SQL);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM attendance_punches`);
  log.push(
    `Schema migration applied (Round 195 — attendance machine). attendance_punches holds ${rows[0].n} punch(es). ` +
    (process.env.ATTENDANCE_API_KEY
      ? `ATTENDANCE_API_KEY is set, so the attendance agent can post to /api/attendance/sync.`
      : `ATTENDANCE_API_KEY is NOT set — /api/attendance/sync will reject every call until it is. ` +
        `Set it in the backend environment and give the same value to the agent (tools/essl-agent).`)
  );
}
