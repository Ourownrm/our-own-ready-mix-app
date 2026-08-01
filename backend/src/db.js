import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// The app runs on India business hours, but the database server's default
// timezone is UTC (Render's managed Postgres). Every query in this app that
// uses CURRENT_DATE (order carry-forward, today's/upcoming orders, daily
// KPIs, the production chart, month-boundary reports, etc.) needs "today" to
// mean the IST calendar day — otherwise, for the ~5.5 hours between midnight
// and 5:30 AM IST, the database still thinks it's yesterday (UTC hasn't
// rolled over yet), and today's data gets miscategorized.
//
// This used to be a `pool.on("connect", ...)` listener, which is
// fire-and-forget: it does NOT block the pool from handing that same brand-
// new connection out for a real query that could run concurrently with (or
// even before) the SET TIME ZONE command finishes. That race meant a query
// landing on a freshly-created connection could occasionally run against the
// server's default UTC instead of IST — a plausible cause of data
// intermittently appearing to belong to the wrong day or month right at a
// boundary (exactly the kind of thing that's hard to reproduce on demand).
//
// Overriding connect() guarantees the timezone is set before the connection
// is ever usable. Overriding query() too — rather than trusting that it
// happens to route through connect() internally — makes this correct
// regardless of pg's own implementation, and covers direct pool.query()
// calls (setup.js's migrations use these directly, bypassing the query()
// wrapper below).
const originalConnect = pool.connect.bind(pool);
pool.connect = async (...args) => {
  const client = await originalConnect(...args);
  if (!client._timezoneReady) {
    await client.query("SET TIME ZONE 'Asia/Kolkata'");
    client._timezoneReady = true;
  }
  return client;
};

pool.query = async (text, params) => {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

export async function query(text, params) {
  return pool.query(text, params);
}
