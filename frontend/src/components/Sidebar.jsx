import { NavLink } from "react-router-dom";

export default function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="sidebar-title">Leads CRM</div>
      <NavLink
        to="/"
        end
        className={({ isActive }) => "sidebar-link" + (isActive ? " active" : "")}
      >
        Leads
      </NavLink>
      <NavLink
        to="/properties"
        className={({ isActive }) => "sidebar-link" + (isActive ? " active" : "")}
      >
        Properties
      </NavLink>
    </nav>
  );
}
