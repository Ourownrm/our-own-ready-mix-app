// Run once after setting up the database: node src/seed.js
// Creates the first Administrator login, plus sample master data so screens have something to show.

import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { pool, query } from "./db.js";

dotenv.config();

async function seed() {
  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);

  await query(
    `INSERT INTO users (name, phone, email, password_hash, role)
     VALUES ('Admin', '9999999999', 'admin@example.com', $1, 'administrator')
     ON CONFLICT (phone) DO NOTHING`,
    [passwordHash]
  );

  await query(
    `INSERT INTO trip_allowance_categories (label, amount, min_distance_km, max_distance_km) VALUES
     ('₹100 per trip (0-10 km)', 100, 0, 10),
     ('₹150 per trip (10-20 km)', 150, 10, 20),
     ('₹200 per trip (20+ km)', 200, 20, NULL)
     ON CONFLICT DO NOTHING`
  );

  await query(
    `INSERT INTO mix_grades (name) VALUES ('M7.5'), ('M10'), ('M15'), ('M20'), ('M25'), ('M30'), ('M35'), ('M40'), ('M45'), ('M50')
     ON CONFLICT DO NOTHING`
  );

  await query(
    `INSERT INTO customers (name) VALUES ('Skyline Builders'), ('Greenfield Infra')
     ON CONFLICT DO NOTHING`
  );

  const { rows: cats } = await query("SELECT id FROM trip_allowance_categories ORDER BY amount");
  const { rows: custs } = await query("SELECT id FROM customers ORDER BY id");
  if (cats.length && custs.length) {
    await query(
      `INSERT INTO sites (customer_id, name, distance_from_plant_km, trip_allowance_category_id)
       VALUES ($1, 'Sector 12, Site A', 14, $2)
       ON CONFLICT DO NOTHING`,
      [custs[0].id, cats[1].id]
    );
  }

  console.log("Seed complete.");
  console.log("Login with phone 9999999999 / password ChangeMe123!  — change this immediately.");
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
