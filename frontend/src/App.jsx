import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext.jsx";
import { CustomerLanguageProvider } from "./lib/customerI18n.jsx";
import { ROLE_HOME } from "./lib/roleHome.js";
import { getCustomerSession } from "./lib/customerPortalApi.js";
import ProtectedRoute from "./lib/ProtectedRoute.jsx";
import Login from "./pages/Login.jsx";
import DriverDuty from "./pages/DriverDuty.jsx";
import DriverSettings from "./pages/DriverSettings.jsx";
import ManagerDashboard from "./pages/ManagerDashboard.jsx";
import SiteSupervisor from "./pages/SiteSupervisor.jsx";
import PlantOperator from "./pages/PlantOperator.jsx";
import QcEngineer from "./pages/QcEngineer.jsx";
import RawMaterialStockEntry from "./pages/RawMaterialStockEntry.jsx";
import LabTechnician from "./pages/LabTechnician.jsx";
import LabDueToday from "./pages/LabDueToday.jsx";
import CubeTestReport from "./pages/CubeTestReport.jsx";
import Accountant from "./pages/Accountant.jsx";
import Administrator from "./pages/Administrator.jsx";
import OrdersSchedule from "./pages/OrdersSchedule.jsx";
import Reports from "./pages/Reports.jsx";
import ProductionReport from "./pages/ProductionReport.jsx";
import FuelReport from "./pages/FuelReport.jsx";
import TripAllowanceReport from "./pages/TripAllowanceReport.jsx";
import DelayJustificationReport from "./pages/DelayJustificationReport.jsx";
import Charts from "./pages/Charts.jsx";
import CycleTimeReport from "./pages/CycleTimeReport.jsx";
import TruckTimingReport from "./pages/TruckTimingReport.jsx";
import FuelAnalysis from "./pages/FuelAnalysis.jsx";
import OutstandingCollectionReport from "./pages/OutstandingCollectionReport.jsx";
import Breakdowns from "./pages/Breakdowns.jsx";
import FuelFilling from "./pages/FuelFilling.jsx";
import SupplyApprovals from "./pages/SupplyApprovals.jsx";
import StoreHome from "./pages/StoreHome.jsx";
import StoreScan from "./pages/StoreScan.jsx";
import StoreStock from "./pages/StoreStock.jsx";
import SalesExecutive from "./pages/SalesExecutive.jsx";
import SalesPerformance from "./pages/SalesPerformance.jsx";
import LeadsBrowser from "./pages/LeadsBrowser.jsx";
import CustomerFeedback from "./pages/CustomerFeedback.jsx";
import ComplianceMonitoring from "./pages/ComplianceMonitoring.jsx";
import NotificationsPage from "./pages/NotificationsPage.jsx";
import SalesForecast from "./pages/SalesForecast.jsx";
import TripTimeCrossCheckPage from "./pages/TripTimeCrossCheckPage.jsx";
import CustomerTracking from "./pages/CustomerTracking.jsx";
import Maintenance from "./pages/Maintenance.jsx";
import CustomerBooking from "./pages/CustomerBooking.jsx";
import CustomerBookingForm from "./pages/CustomerBookingForm.jsx";
import PublicInquiry from "./pages/PublicInquiry.jsx";
import CustomerPortal from "./pages/CustomerPortal.jsx";
import ServicesPublic from "./pages/ServicesPublic.jsx";
import RmcVsSitemix from "./pages/RmcVsSitemix.jsx";
import TechnicalAssistance from "./pages/TechnicalAssistance.jsx";
import SiteContentEditor from "./pages/SiteContentEditor.jsx";
import HomeScreenPhotos from "./pages/HomeScreenPhotos.jsx";

// Landing route ("/" and any unrecognized path): if we already have a valid
// saved session, go straight to that role's screen instead of forcing a
// fresh sign-in every time the app is opened.
function RootRedirect() {
  const { user } = useAuth();
  if (user) return <Navigate to={ROLE_HOME[user.role] || "/login"} replace />;
  // Round 119, post-ship again, item 7 — the customer portal's installed PWA
  // icon (CustomerPortal.jsx swaps in its own manifest, start_url "/portal")
  // is the primary fix, but this covers whoever installed before that fix
  // shipped, or whose browser doesn't honor a per-page manifest swap: with no
  // staff session but a live customer portal one, "/" should reopen the
  // portal, not demand a staff username/password.
  if (getCustomerSession()) return <Navigate to="/portal" replace />;
  return <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      {/* Round 119, post-ship again — round 6, item 3: was scoped to just
          CustomerPortal.jsx (the logged-in /portal screens); moved up here so
          the language choice (and useCustomerLanguage()/PublicLanguageSwitcher)
          are available on the public, pre-login customer pages too — Services,
          Ready-Mix vs. Site-Mix, Free Technical Assistance, a booking link, a
          shared tracking link, and the public inquiry form. Harmless for every
          staff-facing route, which never reads this context. */}
      <CustomerLanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* Public, no login — reached only via a shared per-order link. */}
          <Route path="/track/:token" element={<CustomerTracking />} />
          {/* Public, no login — reached only via a shared per-customer+site booking link. */}
          <Route path="/book/:token" element={<CustomerBookingForm />} />
          {/* Public, no login — a potential customer's "get in touch" form (round 119). */}
          <Route path="/inquiry" element={<PublicInquiry />} />
          {/* Public, no login by password — an existing customer signs in with a
              short Manager-issued access code (round 119). */}
          <Route path="/portal" element={<CustomerPortal />} />
          {/* Public, no login — marketing/browse pages reachable from the portal's
              guest links and from outside the app (round 119). */}
          <Route path="/services" element={<ServicesPublic />} />
          <Route path="/rmc-vs-sitemix" element={<RmcVsSitemix />} />
          <Route path="/technical-assistance" element={<TechnicalAssistance />} />

          <Route path="/driver" element={
            <ProtectedRoute roles={["driver"]}><DriverDuty /></ProtectedRoute>
          } />
          <Route path="/driver/settings" element={
            <ProtectedRoute roles={["driver"]}><DriverSettings /></ProtectedRoute>
          } />

          <Route path="/manager" element={
            <ProtectedRoute roles={["manager", "administrator"]}><ManagerDashboard /></ProtectedRoute>
          } />
          <Route path="/site-supervisor" element={
            <ProtectedRoute roles={["site_supervisor"]}><SiteSupervisor /></ProtectedRoute>
          } />
          <Route path="/plant-operator" element={
            <ProtectedRoute roles={["plant_operator"]}><PlantOperator /></ProtectedRoute>
          } />
          <Route path="/qc" element={
            <ProtectedRoute roles={["qc_engineer"]}><QcEngineer /></ProtectedRoute>
          } />
          {/* Round 125 — the backend has allowed administrator on nearly every
              lab-technician route all along (the router-level requireRole on
              labTechnician.js includes it, plus qc_engineer/manager), but this
              route guard only ever let the lab_technician role itself in —
              an admin hit this and got bounced straight back to /login. That
              made the admin-only delete/date-correction actions unreachable
              in practice. Opened to match what the backend already allows. */}
          <Route path="/lab-technician" element={
            <ProtectedRoute roles={["lab_technician", "administrator"]}><LabTechnician /></ProtectedRoute>
          } />
          <Route path="/lab-technician/raw-material-stock" element={
            <ProtectedRoute roles={["lab_technician"]}><RawMaterialStockEntry /></ProtectedRoute>
          } />
          <Route path="/lab-technician/cube-test-report" element={
            <ProtectedRoute roles={["lab_technician", "administrator"]}><CubeTestReport /></ProtectedRoute>
          } />
          {/* Round 135 — "Samples Due for Testing", opened from the KPI
              card on the Lab Technician dashboard. Same role guard as
              /lab-technician itself (see the Round 125 comment above). */}
          <Route path="/lab-technician/due-today" element={
            <ProtectedRoute roles={["lab_technician", "administrator"]}><LabDueToday /></ProtectedRoute>
          } />
          <Route path="/accountant" element={
            <ProtectedRoute roles={["accountant"]}><Accountant /></ProtectedRoute>
          } />
          <Route path="/administrator" element={
            <ProtectedRoute roles={["administrator"]}><Administrator /></ProtectedRoute>
          } />
          <Route path="/orders" element={
            <ProtectedRoute><OrdersSchedule /></ProtectedRoute>
          } />
          <Route path="/reports" element={
            <ProtectedRoute roles={["administrator"]}><Reports /></ProtectedRoute>
          } />
          <Route path="/production-report" element={
            <ProtectedRoute roles={["administrator", "manager"]}><ProductionReport /></ProtectedRoute>
          } />
          <Route path="/fuel-report" element={
            <ProtectedRoute roles={["administrator", "manager", "accountant", "store"]}><FuelReport /></ProtectedRoute>
          } />
          <Route path="/trip-allowance-report" element={
            <ProtectedRoute roles={["administrator", "manager", "accountant"]}><TripAllowanceReport /></ProtectedRoute>
          } />
          <Route path="/delay-justification-report" element={
            <ProtectedRoute roles={["administrator", "manager", "site_supervisor", "plant_operator"]}><DelayJustificationReport /></ProtectedRoute>
          } />
          <Route path="/charts" element={
            <ProtectedRoute roles={["administrator", "manager"]}><Charts /></ProtectedRoute>
          } />
          <Route path="/cycle-time-report" element={
            <ProtectedRoute roles={["administrator", "manager"]}><CycleTimeReport /></ProtectedRoute>
          } />
          <Route path="/truck-timing-report" element={
            <ProtectedRoute roles={["administrator", "manager"]}><TruckTimingReport /></ProtectedRoute>
          } />
          <Route path="/fuel-analysis" element={
            <ProtectedRoute roles={["administrator", "manager"]}><FuelAnalysis /></ProtectedRoute>
          } />
          <Route path="/outstanding-collection-report" element={
            <ProtectedRoute roles={["administrator", "manager", "accountant"]}><OutstandingCollectionReport /></ProtectedRoute>
          } />
          <Route path="/breakdowns" element={
            <ProtectedRoute roles={["manager", "administrator"]}><Breakdowns /></ProtectedRoute>
          } />
          <Route path="/maintenance" element={
            <ProtectedRoute roles={["manager", "administrator"]}><Maintenance /></ProtectedRoute>
          } />
          <Route path="/customer-booking" element={
            <ProtectedRoute roles={["sales_executive", "manager", "administrator"]}><CustomerBooking /></ProtectedRoute>
          } />
          <Route path="/site-content" element={
            <ProtectedRoute roles={["manager", "administrator"]}><SiteContentEditor /></ProtectedRoute>
          } />
          <Route path="/home-screen-photos" element={
            <ProtectedRoute roles={["manager", "administrator"]}><HomeScreenPhotos /></ProtectedRoute>
          } />
          <Route path="/fuel" element={
            <ProtectedRoute roles={["driver", "manager", "accountant", "administrator", "site_supervisor", "plant_operator", "loader_operator"]}><FuelFilling /></ProtectedRoute>
          } />
          <Route path="/supply-approvals" element={
            <ProtectedRoute roles={["manager", "administrator"]}><SupplyApprovals /></ProtectedRoute>
          } />
          <Route path="/store" element={
            <ProtectedRoute roles={["store", "administrator"]}><StoreHome /></ProtectedRoute>
          } />
          <Route path="/store/scan/:token" element={
            <ProtectedRoute roles={["store", "administrator"]}><StoreScan /></ProtectedRoute>
          } />
          <Route path="/store-stock" element={
            <ProtectedRoute roles={["store", "manager", "administrator"]}><StoreStock /></ProtectedRoute>
          } />
          <Route path="/sales" element={
            <ProtectedRoute roles={["sales_executive", "administrator"]}><SalesExecutive /></ProtectedRoute>
          } />
          <Route path="/sales-performance" element={
            <ProtectedRoute roles={["administrator"]}><SalesPerformance /></ProtectedRoute>
          } />
          <Route path="/leads" element={
            <ProtectedRoute roles={["manager", "administrator"]}><LeadsBrowser /></ProtectedRoute>
          } />
          <Route path="/customer-feedback" element={
            <ProtectedRoute roles={["manager", "administrator"]}><CustomerFeedback /></ProtectedRoute>
          } />
          <Route path="/compliance" element={
            <ProtectedRoute roles={["manager", "administrator"]}><ComplianceMonitoring /></ProtectedRoute>
          } />
          <Route path="/notifications" element={
            <ProtectedRoute roles={["manager", "administrator"]}><NotificationsPage /></ProtectedRoute>
          } />
          <Route path="/sales-forecast" element={
            <ProtectedRoute roles={["sales_executive", "manager", "administrator"]}><SalesForecast /></ProtectedRoute>
          } />
          <Route path="/trip-time-crosscheck" element={
            <ProtectedRoute roles={["manager", "administrator"]}><TripTimeCrossCheckPage /></ProtectedRoute>
          } />

          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
      </CustomerLanguageProvider>
    </AuthProvider>
  );
}
