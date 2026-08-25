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
import labTechnicianRoutes from "./routes/labTechnician.js";
import accountantRoutes from "./routes/accountant.js";
import administratorRoutes from "./routes/administrator.js";
import masterDataRoutes from "./routes/masterData.js";
import setupRoutes from "./routes/setup.js";
import breakdownRoutes from "./routes/breakdowns.js";
import reportsRoutes from "./routes/reports.js";
import productionReportRoutes from "./routes/productionReport.js";
import pushRoutes from "./routes/push.js";
import fuelRoutes from "./routes/fuel.js";
import supplyRequestsRoutes from "./routes/supplyRequests.js";
import salesRoutes from "./routes/sales.js";
import complianceRoutes from "./routes/compliance.js";
import notificationsRoutes from "./routes/notifications.js";
import trackingRoutes from "./routes/tracking.js";
import maintenanceRoutes from "./routes/maintenance.js";
import bookingLinksRoutes from "./routes/bookingLinks.js";
import customerBookingRoutes from "./routes/customerBooking.js";
import customerAccessRoutes from "./routes/customerAccess.js";
import customerPortalRoutes from "./routes/customerPortal.js";
import publicInquiryRoutes from "./routes/publicInquiry.js";
import {
  checkDelayedTrucks, checkPumpDepartureOverdue, checkBatchingNotStarted, checkComplianceExpiries,
  checkBatchingDelayAfterSiteReady, checkFollowupsDue, checkPendingSupplyRequests, checkGeofenceEvents,
  checkPlantOutAutoRecord, cleanupOldNotifications,
} from "./lib/scheduledChecks.js";

dotenv.config();

// Safety net: an error in one request should never take the whole server down.
// (This is what let a single bad SQL query crash the app during testing —
// now it just logs and the request fails gracefully instead.)
process.on("unhandledRejection", (err) => {
  console.error("Unhandled error (server stayed up):", err);
});

const app = express();
// Render sits the app behind a proxy, so every request arrives with an
// X-Forwarded-For header. express-rate-limit (used by publicInquiry.js and
// customerPortal.js — round 119) refuses to key on that header unless Express
// is explicitly told to trust it, and throws instead of just ignoring it —
// which was taking down both new public endpoints with a generic 500 in
// production. "1" trusts exactly one hop (Render's own proxy), matching how
// Render's edge is documented to forward traffic.
app.set("trust proxy", 1);
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
app.use("/api/lab-technician", labTechnicianRoutes);
app.use("/api/accountant", accountantRoutes);
app.use("/api/administrator", administratorRoutes);
app.use("/api/master", masterDataRoutes);
app.use("/api/breakdowns", breakdownRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/production-report", productionReportRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/fuel", fuelRoutes);
app.use("/api/supply-requests", supplyRequestsRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/maintenance", maintenanceRoutes);
app.use("/api/booking-links", bookingLinksRoutes);
// Manager/Admin-only, staff auth as usual — generates/lists/revokes the
// customer portal access codes (routes/customerAccess.js).
app.use("/api/customer-access", customerAccessRoutes);
// Deliberately NOT behind requireAuth — these are the public, token-scoped
// customer-facing links (see routes/tracking.js and routes/customerBooking.js
// for why that's safe), plus (round 119) the customer portal's own
// access-code sign-in and the public inquiry form. The portal does its own
// per-request auth via requireCustomerAuth inside customerPortal.js, using a
// separate JWT secret from staff sessions — see that file's header comment.
app.use("/api/track", trackingRoutes);
app.use("/api/customer-booking", customerBookingRoutes);
app.use("/api/customer-portal", customerPortalRoutes);
app.use("/api/public-inquiry", publicInquiryRoutes);
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
  checkPumpDepartureOverdue().catch((err) => console.error("Pump-departure-overdue check failed:", err));
  checkBatchingNotStarted().catch((err) => console.error("Batching-not-started check failed:", err));
  checkComplianceExpiries().catch((err) => console.error("Compliance-expiry check failed:", err));
  checkBatchingDelayAfterSiteReady().catch((err) => console.error("Batching-delay-after-site-ready check failed:", err));
  checkFollowupsDue().catch((err) => console.error("Follow-ups-due check failed:", err));
  checkPendingSupplyRequests().catch((err) => console.error("Pending-supply-requests check failed:", err));
  checkGeofenceEvents().catch((err) => console.error("Geofence-events check failed:", err));
  checkPlantOutAutoRecord().catch((err) => console.error("Plant-out-auto-record check failed:", err));
}, 5 * 60 * 1000);

// Purges old notifications (see cleanupOldNotifications for the retention
// rule) so the notifications tab doesn't grow into an endless scroll of
// long-actioned alerts. Doesn't need 5-minute freshness like the checks
// above — hourly is plenty for a housekeeping pass.
setInterval(() => {
  cleanupOldNotifications().catch((err) => console.error("Notification cleanup failed:", err));
}, 60 * 60 * 1000);
