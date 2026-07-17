import { Outlet } from "react-router-dom";
import NavRail from "./NavRail.jsx";

/**
 * CRMLayout — exactly the shell App.jsx used to render directly, extracted
 * unchanged so it can sit inside the new <ProtectedRoute> route tree (see
 * App.jsx). No CRM UI changed here, just where this markup lives.
 */
export default function CRMLayout() {
  return (
    <div className="app-shell">
      <NavRail />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
