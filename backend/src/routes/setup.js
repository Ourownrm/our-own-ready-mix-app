import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { pool, query } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// One-time setup, triggered by visiting this URL with the correct key in a browser.
// Safe to run more than once — it skips anything already created.
router.get("/setup", async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(403).send("Not authorized.");
  }

  const log = [];
  try {
    const { rows } = await query(
      `SELECT to_regclass('public.users') AS exists`
    );
    if (!rows[0].exists) {
      const schemaPath = path.join(__dirname, "..", "..", "schema.sql");
      const schemaSql = fs.readFileSync(schemaPath, "utf8");
      await pool.query(schemaSql);
      log.push("Database tables created.");
    } else {
      log.push("Database tables already exist — skipped.");
    }

    const { rows: existingAdmin } = await query(
      "SELECT id FROM users WHERE phone = '9999999999'"
    );
    if (existingAdmin.length === 0) {
      const passwordHash = await bcrypt.hash("ChangeMe123!", 10);
      await query(
        `INSERT INTO users (name, phone, email, password_hash, role)
         VALUES ('Admin', '9999999999', 'admin@example.com', $1, 'administrator')`,
        [passwordHash]
      );
      log.push("First Administrator login created: phone 9999999999, password ChangeMe123!");
    } else {
      log.push("Administrator login already exists — skipped.");
    }

    await query(
      `INSERT INTO trip_allowance_categories (label, amount, min_distance_km, max_distance_km)
       SELECT * FROM (VALUES
         ('₹100 per trip (0-10 km)', 100::numeric, 0::numeric, 10::numeric),
         ('₹150 per trip (10-20 km)', 150::numeric, 10::numeric, 20::numeric),
         ('₹200 per trip (20+ km)', 200::numeric, 20::numeric, NULL::numeric)
       ) AS v(label, amount, min_distance_km, max_distance_km)
       WHERE NOT EXISTS (SELECT 1 FROM trip_allowance_categories)`
    );
    await query(
      `INSERT INTO mix_grades (name)
       SELECT * FROM (VALUES ('M20'), ('M25'), ('M30'), ('M35')) AS v(name)
       WHERE NOT EXISTS (SELECT 1 FROM mix_grades)`
    );
    await query(
      `INSERT INTO rejection_reasons (reason)
       SELECT * FROM (VALUES
         ('Slump out of range'), ('Segregation'),
         ('Delayed delivery / setting started'), ('Wrong grade supplied'), ('Other')
       ) AS v(reason)
       WHERE NOT EXISTS (SELECT 1 FROM rejection_reasons)`
    );
    log.push("Sample trip allowance categories and mix grades added.");

    await query(
      `INSERT INTO customers (name)
       SELECT * FROM (VALUES ('Skyline Builders'), ('Greenfield Infra')) AS v(name)
       WHERE NOT EXISTS (SELECT 1 FROM customers)`
    );
    const { rows: custForSite } = await query("SELECT id FROM customers ORDER BY id LIMIT 1");
    const { rows: catForSite } = await query(
      "SELECT id FROM trip_allowance_categories WHERE amount = 150 LIMIT 1"
    );
    if (custForSite.length && catForSite.length) {
      await query(
        `INSERT INTO sites (customer_id, name, distance_from_plant_km, trip_allowance_category_id)
         SELECT $1, 'Sector 12, Site A', 14, $2
         WHERE NOT EXISTS (SELECT 1 FROM sites)`,
        [custForSite[0].id, catForSite[0].id]
      );
    }
    log.push("Sample customer and site added.");

    const { rows: allCustomers } = await query("SELECT id FROM customers");
    const { rows: gradeRows } = await query("SELECT id FROM mix_grades WHERE name = 'M25' LIMIT 1");
    if (allCustomers.length && gradeRows.length) {
      for (const c of allCustomers) {
        await query(
          `INSERT INTO rate_master (customer_id, mix_grade_id, rate_per_m3, pumping_charge_per_m3, waiting_charge_per_hour, effective_from)
           SELECT $1, $2, 4500, 200, 500, CURRENT_DATE
           WHERE NOT EXISTS (SELECT 1 FROM rate_master WHERE customer_id = $1 AND mix_grade_id = $2)`,
          [c.id, gradeRows[0].id]
        );
      }
      log.push("Sample M25 rate added for all existing customers.");
    }

    res.send(
      `<pre style="font-family: sans-serif; font-size: 15px; padding: 20px;">` +
      `Setup complete.\n\n${log.join("\n")}\n\n` +
      `You can now sign in to the app with:\nPhone: 9999999999\nPassword: ChangeMe123!\n\n` +
      `Please change this password once you're able to (an Administrator screen for this is coming soon).` +
      `</pre>`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(
      `<pre style="font-family: sans-serif; padding: 20px; color: #c0392b;">Something went wrong:\n${err.message}</pre>`
    );
  }
});

export default router;
