import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { LayoutDashboard, MessageCircle, Users, Building2, BarChart3, Megaphone, FileText, Moon, Sun } from "lucide-react";

const LINKS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/chats", label: "Chats", icon: MessageCircle },
  { to: "/leads", label: "Smart Leads", icon: Users },
  { to: "/properties", label: "Properties", icon: Building2 },
  { to: "/campaigns", label: "Campaigns", icon: Megaphone },
  { to: "/templates", label: "Templates", icon: FileText },
  { to: "/insights", label: "Insights", icon: BarChart3 },
];

function getInitialTheme() {
  const saved = localStorage.getItem("crm-theme");
  if (saved) return saved;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function NavRail() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("crm-theme", theme);
  }, [theme]);

  return (
    <nav className="nav-rail">
      <div className="nav-rail-logo">N</div>
      <div className="nav-rail-links">
        {LINKS.map(({ to, label, icon: Icon, end }) => (
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
      </div>
    </nav>
  );
}
