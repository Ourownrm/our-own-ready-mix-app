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
import Accountant from "./pages/Accountant.jsx";
import Administrator from "./pages/Administrator.jsx";
import OrdersSchedule from "./pages/OrdersSchedule.jsx";
import Reports from "./pages/Reports.jsx";
import Breakdowns from "./pages/Breakdowns.jsx";

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
            <ProtectedRoute roles={["manager"]}><ManagerDashboard /></ProtectedRoute>
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
            <ProtectedRoute roles={["manager", "accountant", "administrator"]}><Reports /></ProtectedRoute>
          } />
          <Route path="/breakdowns" element={
            <ProtectedRoute roles={["manager", "administrator"]}><Breakdowns /></ProtectedRoute>
          } />

          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
