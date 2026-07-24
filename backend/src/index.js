import express from "express";
import "express-async-errors";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.js";
import orderRoutes from "./routes/orders.js";
import ticketRoutes from "./routes/tickets.js";
import driverRoutes from "./routes/driver.js";
import siteSupervisorRoutes from "./routes/siteSupervisor.js";
import plantOperatorRoutes from "./routes/plantOperator.js";
import qcEngineerRoutes from "./routes/qcEngineer.js";
import accountantRoutes from "./routes/accountant.js";
import administratorRoutes from "./routes/administrator.js";
import masterDataRoutes from "./routes/masterData.js";
import setupRoutes from "./routes/setup.js";
import breakdownRoutes from "./routes/breakdowns.js";
import reportsRoutes from "./routes/reports.js";
import productionReportRoutes from "./routes/productionReport.js";
import pushRoutes from "./routes/push.js";
import fuelRoutes from "./routes/fuel.js";
import { checkDelayedTrucks } from "./lib/scheduledChecks.js";

dotenv.config();

// Safety net: an error in one request should never take the whole server down.
// (This is what let a single bad SQL query crash the app during testing —
// now it just logs and the request fails gracefully instead.)
process.on("unhandledRejection", (err) => {
  console.error("Unhandled error (server stayed up):", err);
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/site-supervisor", siteSupervisorRoutes);
app.use("/api/plant-operator", plantOperatorRoutes);
app.use("/api/qc-engineer", qcEngineerRoutes);
app.use("/api/accountant", accountantRoutes);
app.use("/api/administrator", administratorRoutes);
app.use("/api/master", masterDataRoutes);
app.use("/api/breakdowns", breakdownRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/production-report", productionReportRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/fuel", fuelRoutes);
app.use("/", setupRoutes);

// Keep error messages plain-language — this app is used by non-technical field staff
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`OORM backend running on port ${port}`));

// The "truck over 2 hours at site" push is the one notification not tied to
// a specific user action, so it runs on a timer instead — checked every 5
// minutes. (This only works while the server process stays running, which
// is how Render's web service tier behaves — not applicable if this were
// ever moved to a serverless/cold-start hosting model.)
setInterval(() => {
  checkDelayedTrucks().catch((err) => console.error("Delayed-trucks check failed:", err));
}, 5 * 60 * 1000);
