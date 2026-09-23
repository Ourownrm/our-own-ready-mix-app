import express from "express";
import "express-async-errors";
import cors from "cors";
import cookieParser from "cookie-parser";
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
import storeStockRoutes from "./routes/storeStock.js";
import salesRoutes from "./routes/sales.js";
import complianceRoutes from "./routes/compliance.js";
import notificationsRoutes from "./routes/notifications.js";
import trackingRoutes from "./routes/tracking.js";
import maintenanceRoutes from "./routes/maintenance.js";
import fuelAnalysisRoutes from "./routes/fuelAnalysis.js";
import deliveryNotesRoutes from "./routes/deliveryNotes.js";
import weighbridgeRoutes from "./routes/weighbridge.js";
import bookingLinksRoutes from "./routes/bookingLinks.js";
import customerBookingRoutes from "./routes/customerBooking.js";
import customerAccessRoutes from "./routes/customerAccess.js";
import customerPortalRoutes from "./routes/customerPortal.js";
import publicInquiryRoutes from "./routes/publicInquiry.js";
import siteContentRoutes from "./routes/siteContent.js";
import technicalWritingsRoutes from "./routes/technicalWritings.js";
import homeScreenPhotosRoutes from "./routes/homeScreenPhotos.js";
import loaderOperatorRoutes from "./routes/loaderOperator.js";
import materialModuleRoutes from "./routes/materialModule.js";
import qcDashboardRoutes from "./routes/qcDashboard.js";
// Round 143 — the Administrator dashboard's icon view (KPIs, badges, pins).
import adminDashboardRoutes from "./routes/adminDashboard.js";
// Round 146 — Super Admin per-user access control.
import superAdminRoutes from "./routes/superAdmin.js";
import solitaireRoutes from "./routes/solitaire.js";
import solitaireAccessRoutes from "./routes/solitaireAccess.js";
import {
  checkDelayedTrucks, checkPumpDepartureOverdue, checkBatchingNotStarted, checkComplianceExpiries,
  checkBatchingDelayAfterSiteReady, checkFollowupsDue, checkPendingSupplyRequests, checkGeofenceEvents,
  checkPlantOutAutoRecord, checkSiteInAutoRecord, checkSiteOutAutoRecord, checkPlantInAutoRecord,
  cleanupOldNotifications,
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
// Round 149 — credentialed CORS for the Solitaire plugin ONLY, mounted above
// the app-wide cors() so it also owns the preflight for these paths (the
// default cors() answers OPTIONS and ends the request, so a later, more
// specific handler would never see it).
//
// Why this module needs its own policy: Solitaire authenticates with cookies,
// and a browser only sends cookies cross-site when the server both sets
// SameSite=None (see lib/solitaireAuth.js) and answers with
// Access-Control-Allow-Credentials. That combination cannot be used with
// Access-Control-Allow-Origin: *, which is what the app-wide cors() sends.
//
// And it must NOT be a wildcard reflection, because dropping SameSite is
// dropping this app's only CSRF protection for that module: with any origin
// reflected, any website a signed-in operator visited could make requests to
// Solitaire with their cookies attached. FRONTEND_ORIGIN is therefore an
// allowlist — set it to the frontend's own URL (comma-separate more than one).
// Unset, no origin is allowed credentials, which is correct for a
// single-origin deployment and fails closed for any other.
//
// /api/solitaire-access is deliberately NOT here: it authenticates with the
// main app's bearer token like every other route, uses no cookies, and so
// stays on the ordinary app-wide policy. That matters — it is the endpoint
// the Plant Operator icon depends on.
const SOLITAIRE_ORIGINS = (process.env.FRONTEND_ORIGIN || "")
  .split(",").map((o) => o.trim()).filter(Boolean);
const solitaireCors = cors({
  origin(origin, cb) {
    // No Origin header = a same-origin or non-browser request; nothing to allow.
    if (!origin) return cb(null, true);
    cb(null, SOLITAIRE_ORIGINS.includes(origin));
  },
  credentials: true,
});
app.use("/api/solitaire", solitaireCors);

// Round 150 — the app-wide policy must SKIP the Solitaire paths, not merely run
// after them.
//
// Round 149 mounted the scoped handler above and then `app.use(cors())` below,
// assuming first-wins. It isn't: both run on a real request, and the second
// overwrites Access-Control-Allow-Origin with `*`. Paired with
// Allow-Credentials: true that is an invalid combination which every browser
// refuses, so the module's login failed from the browser — while the preflight
// looked perfect, because the scoped handler answers OPTIONS and ends the
// request before the app-wide one is reached. curl saw nothing wrong; only a
// real cross-origin browser did.
//
// `/api/solitaire-access` is deliberately NOT skipped: it uses the main app's
// bearer token, no cookies, and belongs on the ordinary wildcard policy — it is
// what the Plant Operator icon calls.
const globalCors = cors();
app.use((req, res, next) => {
  if (req.path === "/api/solitaire" || req.path.startsWith("/api/solitaire/")) return next();
  return globalCors(req, res, next);
});
// Round 119, post-ship — Technical Writings uploads a PDF as base64 inside a
// JSON body (see routes/technicalWritings.js's header comment for why: no
// multipart middleware exists anywhere in this app, and base64-over-JSON
// keeps every endpoint on the same all-JSON convention). Base64 inflates a
// file by roughly a third, so the default 100kb body limit would reject
// even a small real PDF guide — raised modestly, app-wide, rather than
// standing up a second body-parser instance scoped to one route. Set to
// 12mb, not 10mb: technicalWritings.js caps the actual file at 8MB, and
// 8MB of base64 alone is ~10.7MB before the surrounding JSON (title,
// filename, etc.) is even added — 10mb would silently 413 files the
// route's own size check was written to accept.
app.use(express.json({ limit: "12mb" }));
// Round 149 — Solitaire keeps its session and device lock in cookies rather
// than a bearer token, deliberately: it is a separate trust boundary from the
// main app and must never be reachable with a main-app JWT. Nothing else in
// this app reads cookies, so this is here purely for that module.
app.use(cookieParser());

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
app.use("/api/store-stock", storeStockRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/maintenance", maintenanceRoutes);
app.use("/api/fuel-analysis", fuelAnalysisRoutes);
// Round 153, item 1 — today's delivery notes, for the Plant Operator, the lab
// and QC. Gated by the orders.challan-print permission, not by role alone.
app.use("/api/delivery-notes", deliveryNotesRoutes);
// Round 154 — the weighbridge sync. NOTE: this router deliberately exposes ONE
// route (POST /sync) that is authenticated by an API key rather than a session,
// declared above its own requireAuth. See routes/weighbridge.js.
app.use("/api/weighbridge", weighbridgeRoutes);
app.use("/api/loader-operator", loaderOperatorRoutes);
// Round 139 — Raw Material Module (purchase -> approve -> receive -> consume
// -> physical count -> reports). Deliberately named /api/material-module
// (not /api/raw-material...) and the schema uses rm_* table prefixes, both
// specifically to avoid any confusion with the pre-existing, unrelated
// raw_material_stock table/feature (Lab Technician's simple 9-bin manual
// snapshot — masterData.js GET /raw-material-stock, labTechnician.js PUT
// /raw-material-stock, frontend RawMaterialStockEntry.jsx), which this
// module leaves completely untouched. See routes/materialModule.js header.
app.use("/api/material-module", materialModuleRoutes);
// Round 141 — Cube Strength QC dashboard. Administrator-only at the router
// level (see routes/qcDashboard.js); read-only, adds no tables.
app.use("/api/qc-dashboard", qcDashboardRoutes);
app.use("/api/admin-dashboard", adminDashboardRoutes);
app.use("/api/super-admin", superAdminRoutes);
// The delivery-challan plugin. Both routers gate themselves on the plugin
// being enabled (lib/plugins.js), so mounting them here does not by itself
// expose anything — a Super Admin switching the plugin off makes every route
// below answer 404 without a redeploy.
app.use("/api/solitaire", solitaireRoutes);
app.use("/api/solitaire-access", solitaireAccessRoutes);
app.use("/api/booking-links", bookingLinksRoutes);
// Manager/Admin-only, staff auth as usual — generates/lists/revokes the
// customer portal access codes (routes/customerAccess.js).
app.use("/api/customer-access", customerAccessRoutes);
// Manager/Admin-only — upload/rename/delete the Technical Writings PDF
// library (routes/technicalWritings.js). The customer-facing list/download
// side lives inside customerPortalRoutes below, gated per access code.
app.use("/api/technical-writings", technicalWritingsRoutes);
// Manager/Admin-only — upload/reorder/hide/delete the Home Screen Photos
// gallery (routes/homeScreenPhotos.js). The customer-facing read side
// (list + image) lives inside customerPortalRoutes below, same split as
// technical-writings above.
app.use("/api/home-screen-photos", homeScreenPhotosRoutes);
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
// GET is public (the marketing pages have no login); PUT is gated inside
// the router itself (Manager/Admin only) — see routes/siteContent.js.
app.use("/api/site-content", siteContentRoutes);
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
  checkSiteInAutoRecord().catch((err) => console.error("Site-in-auto-record check failed:", err));
  checkSiteOutAutoRecord().catch((err) => console.error("Site-out-auto-record check failed:", err));
  checkPlantInAutoRecord().catch((err) => console.error("Plant-in-auto-record check failed:", err));
}, 5 * 60 * 1000);

// Purges old notifications (see cleanupOldNotifications for the retention
// rule) so the notifications tab doesn't grow into an endless scroll of
// long-actioned alerts. Doesn't need 5-minute freshness like the checks
// above — hourly is plenty for a housekeeping pass.
setInterval(() => {
  cleanupOldNotifications().catch((err) => console.error("Notification cleanup failed:", err));
}, 60 * 60 * 1000);
