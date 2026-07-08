import { Routes, Route } from "react-router-dom";
import NavRail from "./components/NavRail.jsx";
import ChatCRM from "./pages/ChatCRM.jsx";
import SmartLeads from "./pages/SmartLeads.jsx";
import Properties from "./pages/Properties.jsx";
import Insights from "./pages/Insights.jsx";

export default function App() {
  return (
    <div className="app-shell">
      <NavRail />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<ChatCRM />} />
          <Route path="/leads" element={<SmartLeads />} />
          <Route path="/properties" element={<Properties />} />
          <Route path="/insights" element={<Insights />} />
        </Routes>
      </main>
    </div>
  );
}
