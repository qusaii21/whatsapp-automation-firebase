import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { LayoutDashboard, MessageCircle, Users, Building2, BarChart3, Megaphone, FileText, UserPlus, Settings, Moon, Sun, LogOut } from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { ROLE_CHECKS_DISABLED, TEAM_UI_HIDDEN } from "../lib/devAccess.js";

const LINKS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/chats", label: "Chats", icon: MessageCircle },
  { to: "/leads", label: "Smart Leads", icon: Users },
  { to: "/properties", label: "Properties", icon: Building2 },
  { to: "/campaigns", label: "Campaigns", icon: Megaphone },
  { to: "/templates", label: "Templates", icon: FileText },
  { to: "/insights", label: "Insights", icon: BarChart3 },
];

// Owner/Admin only — see pages/Team.jsx.
const TEAM_LINK = { to: "/team", label: "Team", icon: UserPlus };
// Owner only — see pages/Settings.jsx.
const SETTINGS_LINK = { to: "/settings", label: "Settings", icon: Settings };

function getInitialTheme() {
  const saved = localStorage.getItem("crm-theme");
  if (saved) return saved;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function NavRail() {
  const [theme, setTheme] = useState(getInitialTheme);
  const { role, signOutUser } = useAuth();
  const links = [
    ...LINKS,
    // Team/Members is a distinct "feature not exposed yet" decision — see
    // devAccess.js — not part of the role-checks override below.
    ...(!TEAM_UI_HIDDEN && (role === "owner" || role === "admin") ? [TEAM_LINK] : []),
    ...(ROLE_CHECKS_DISABLED || role === "owner" ? [SETTINGS_LINK] : []),
  ];

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("crm-theme", theme);
  }, [theme]);

  async function handleSignOut() {
    try {
      await signOutUser();
    } catch (err) {
      // Nothing else in NavRail surfaces toasts/errors — matches how
      // Team.jsx's copyLink() handles a similarly rare, non-actionable
      // failure: log it, don't block the UI over it.
      console.error("Sign out failed:", err);
    }
  }

  return (
    <nav className="nav-rail">
      <div className="nav-rail-logo">N</div>
      <div className="nav-rail-links">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => "nav-rail-link" + (isActive ? " active" : "")}
          >
            <Icon size={19} />
            <span className="rail-label">{label}</span>
          </NavLink>
        ))}
      </div>
      <div className="nav-rail-bottom">
        <button className="theme-toggle" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className="theme-toggle" onClick={handleSignOut} title="Sign out">
          <LogOut size={18} />
        </button>
      </div>
    </nav>
  );
}