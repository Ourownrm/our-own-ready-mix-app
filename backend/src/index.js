import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.js";
import orderRoutes from "./routes/orders.js";
import ticketRoutes from "./routes/tickets.js";
import driverRoutes from "./routes/driver.js";
import masterDataRoutes from "./routes/masterData.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/master", masterDataRoutes);

// Keep error messages plain-language — this app is used by non-technical field staff
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`OORM backend running on port ${port}`));
