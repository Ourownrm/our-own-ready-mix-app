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
// KPIs, the production chart, etc.) needs "today" to mean the IST calendar
// day — otherwise, for the ~5.5 hours between midnight and 5:30 AM IST, the
// database still thinks it's yesterday (UTC hasn't rolled over yet), and
// today's orders/deliveries get miscategorized as "upcoming" or dropped from
// "today" entirely. Setting this once per connection fixes it everywhere.
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'Asia/Kolkata'").catch((err) => console.error("Failed to set session timezone:", err));
});

export async function query(text, params) {
  return pool.query(text, params);
}
