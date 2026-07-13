import { Link } from "react-router-dom";
import { Megaphone, FileText, Building2, Users, GitBranch } from "lucide-react";

const ACTIONS = [
  { to: "/campaigns?new=1", label: "Create Campaign", icon: Megaphone },
  { to: "/templates?new=1", label: "Create Template", icon: FileText },
  { to: "/properties?new=1", label: "Add Property", icon: Building2 },
  { to: "/leads", label: "Smart Leads", icon: Users },
  { to: "/leads?view=pipeline", label: "Opportunities", icon: GitBranch },
];

export default function QuickActions() {
  return (
    <div className="quick-actions-grid">
      {ACTIONS.map(({ to, label, icon: Icon }) => (
        <Link key={to} to={to} className="quick-action-tile">
          <span className="quick-action-icon">
            <Icon size={17} />
          </span>
          {label}
        </Link>
      ))}
    </div>
  );
}
