import { Routes, Route } from "react-router-dom";
import Sidebar from "./components/Sidebar.jsx";
import Leads from "./pages/Leads.jsx";
import Properties from "./pages/Properties.jsx";

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Leads />} />
          <Route path="/properties" element={<Properties />} />
        </Routes>
      </main>
    </div>
  );
}
