import { Link } from "react-router-dom";
import { AlertTriangle, XCircle, PauseCircle } from "lucide-react";

const ICONS = {
  warning: AlertTriangle,
  danger: XCircle,
  paused: PauseCircle,
};

/**
 * @param {Array<{id: string, tone: 'warning'|'danger'|'paused', message: string, to?: string}>} warnings
 */
export default function DashboardWarnings({ warnings }) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <div className="dashboard-warnings">
      {warnings.map((w) => {
        const Icon = ICONS[w.tone] || AlertTriangle;
        const content = (
          <>
            <Icon size={15} />
            <span>{w.message}</span>
          </>
        );
        return w.to ? (
          <Link key={w.id} to={w.to} className={`dashboard-warning dashboard-warning-${w.tone}`}>
            {content}
          </Link>
        ) : (
          <div key={w.id} className={`dashboard-warning dashboard-warning-${w.tone}`}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
