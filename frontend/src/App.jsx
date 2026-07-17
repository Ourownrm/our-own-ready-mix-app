import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./lib/AuthContext.jsx";
import ProtectedRoute from "./lib/ProtectedRoute.jsx";
import Login from "./pages/Login.jsx";
import DriverDuty from "./pages/DriverDuty.jsx";
import ManagerDashboard from "./pages/ManagerDashboard.jsx";
import SiteSupervisor from "./pages/SiteSupervisor.jsx";
import PlantOperator from "./pages/PlantOperator.jsx";
import Accountant from "./pages/Accountant.jsx";
import { ComingSoon } from "./pages/ComingSoon.jsx";

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
            <ProtectedRoute roles={["plant_operator", "qc_engineer"]}><PlantOperator /></ProtectedRoute>
          } />
          <Route path="/accountant" element={
            <ProtectedRoute roles={["accountant"]}><Accountant /></ProtectedRoute>
          } />
          <Route path="/administrator" element={
            <ProtectedRoute roles={["administrator"]}><ComingSoon role="Administrator" /></ProtectedRoute>
          } />

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
