import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext.jsx";
import { ROLE_HOME } from "./lib/roleHome.js";
import ProtectedRoute from "./lib/ProtectedRoute.jsx";
import Login from "./pages/Login.jsx";
import DriverDuty from "./pages/DriverDuty.jsx";
import ManagerDashboard from "./pages/ManagerDashboard.jsx";
import SiteSupervisor from "./pages/SiteSupervisor.jsx";
import PlantOperator from "./pages/PlantOperator.jsx";
import QcEngineer from "./pages/QcEngineer.jsx";
import QcRawMaterialStock from "./pages/QcRawMaterialStock.jsx";
import Accountant from "./pages/Accountant.jsx";
import Administrator from "./pages/Administrator.jsx";
import OrdersSchedule from "./pages/OrdersSchedule.jsx";
import Reports from "./pages/Reports.jsx";
import ProductionReport from "./pages/ProductionReport.jsx";
import FuelReport from "./pages/FuelReport.jsx";
import TripAllowanceReport from "./pages/TripAllowanceReport.jsx";
import DelayJustificationReport from "./pages/DelayJustificationReport.jsx";
import Charts from "./pages/Charts.jsx";
import Breakdowns from "./pages/Breakdowns.jsx";
import FuelFilling from "./pages/FuelFilling.jsx";
import SupplyApprovals from "./pages/SupplyApprovals.jsx";
import StoreHome from "./pages/StoreHome.jsx";
import StoreScan from "./pages/StoreScan.jsx";
import SalesExecutive from "./pages/SalesExecutive.jsx";
import SalesPerformance from "./pages/SalesPerformance.jsx";
import LeadsBrowser from "./pages/LeadsBrowser.jsx";
import CustomerFeedback from "./pages/CustomerFeedback.jsx";
import ComplianceMonitoring from "./pages/ComplianceMonitoring.jsx";
import NotificationsPage from "./pages/NotificationsPage.jsx";
import SalesForecast from "./pages/SalesForecast.jsx";
import TripTimeCrossCheckPage from "./pages/TripTimeCrossCheckPage.jsx";

// Landing route ("/" and any unrecognized path): if we already have a valid
// saved session, go straight to that role's screen instead of forcing a
// fresh sign-in every time the app is opened.
function RootRedirect() {
  const { user } = useAuth();
  if (user) return <Navigate to={ROLE_HOME[user.role] || "/login"} replace />;
  return <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route path="/driver" element={
            <ProtectedRoute roles={["driver"]}><DriverDuty /></ProtectedRoute>
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
          <Route path="/qc/raw-material-stock" element={
            <ProtectedRoute roles={["qc_engineer"]}><QcRawMaterialStock /></ProtectedRoute>
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
            <ProtectedRoute roles={["administrator", "manager", "accountant"]}><FuelReport /></ProtectedRoute>
          } />
          <Route path="/trip-allowance-report" element={
            <ProtectedRoute roles={["administrator", "manager", "accountant"]}><TripAllowanceReport /></ProtectedRoute>
          } />
          <Route path="/delay-justification-report" element={
            <ProtectedRoute roles={["administrator", "manager"]}><DelayJustificationReport /></ProtectedRoute>
          } />
          <Route path="/charts" element={
            <ProtectedRoute roles={["administrator", "manager"]}><Charts /></ProtectedRoute>
          } />
          <Route path="/breakdowns" element={
            <ProtectedRoute roles={["manager", "administrator"]}><Breakdowns /></ProtectedRoute>
          } />
          <Route path="/fuel" element={
            <ProtectedRoute roles={["driver", "manager", "accountant", "administrator", "site_supervisor", "plant_operator"]}><FuelFilling /></ProtectedRoute>
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
          <Route path="/sales" element={
            <ProtectedRoute roles={["sales_executive"]}><SalesExecutive /></ProtectedRoute>
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
    </AuthProvider>
  );
}
