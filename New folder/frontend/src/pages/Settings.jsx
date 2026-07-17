import { NavLink, Outlet } from "react-router-dom";
import { MessageCircle, Facebook } from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { ROLE_CHECKS_DISABLED } from "../lib/devAccess.js";

/**
 * SETTINGS SHELL
 * ---------------------------------------------------------------------------
 * Normally Owner-only (see ROLE_CHECKS_DISABLED in devAccess.js — while that
 * flag is on, every active agency member can reach this page). Renders the
 * Settings > Integrations sub-navigation and hands off to whichever settings
 * sub-page is routed (see App.jsx) via <Outlet />.
 */
export default function Settings() {
  const { role } = useAuth();
  const canAccessSettings = ROLE_CHECKS_DISABLED || role === "owner";

  if (!canAccessSettings) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Settings</h1>
            <div className="page-subtitle">Only the agency Owner can manage integrations.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <div className="page-subtitle">Manage your agency's connections and integrations.</div>
        </div>
      </div>

      <div className="settings-shell">
        <nav className="settings-subnav">
          <div className="settings-subnav-group-label">Integrations</div>
          <NavLink
            to="/settings/integrations/whatsapp"
            className={({ isActive }) => "settings-subnav-link" + (isActive ? " active" : "")}
          >
            <MessageCircle size={15} />
            WhatsApp Business
          </NavLink>
          <NavLink
            to="/settings/integrations/facebook"
            className={({ isActive }) => "settings-subnav-link" + (isActive ? " active" : "")}
          >
            <Facebook size={15} />
            Facebook Lead Ads
          </NavLink>
        </nav>

        <div className="settings-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
