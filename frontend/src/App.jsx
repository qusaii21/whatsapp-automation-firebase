import { Routes, Route, Navigate } from "react-router-dom";
import NavRail from "./components/NavRail.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import Login from "./pages/auth/Login.jsx";
import Signup from "./pages/auth/Signup.jsx";
import AcceptInvite from "./pages/auth/AcceptInvite.jsx";
import ForgotPassword from "./pages/auth/ForgotPassword.jsx";
import Unauthorized from "./pages/auth/Unauthorized.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import ChatCRM from "./pages/ChatCRM.jsx";
import SmartLeads from "./pages/SmartLeads.jsx";
import Properties from "./pages/Properties.jsx";
import Insights from "./pages/Insights.jsx";
import Campaigns from "./pages/Campaigns.jsx";
import Templates from "./pages/Templates.jsx";
import Team from "./pages/Team.jsx";
import Settings from "./pages/Settings.jsx";
import WhatsAppIntegrationPage from "./pages/settings/WhatsAppIntegration.jsx";
import FacebookIntegrationPage from "./pages/settings/FacebookIntegration.jsx";

function CrmShell() {
  return (
    <div className="app-shell">
      <NavRail />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/chats" element={<ChatCRM />} />
          <Route path="/leads" element={<SmartLeads />} />
          <Route path="/properties" element={<Properties />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/team" element={<Team />} />
          <Route path="/settings" element={<Settings />}>
            <Route index element={<Navigate to="integrations/whatsapp" replace />} />
            <Route path="integrations/whatsapp" element={<WhatsAppIntegrationPage />} />
            <Route path="integrations/facebook" element={<FacebookIntegrationPage />} />
          </Route>
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Public — no signed-in user (or an incompletely-onboarded one)
          required. See pages/auth/* for the onboarding flow itself. */}
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      {/* Signed in but no agencyId claim yet — see ProtectedRoute.jsx. */}
      <Route path="/unauthorized" element={<Unauthorized />} />

      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <CrmShell />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
