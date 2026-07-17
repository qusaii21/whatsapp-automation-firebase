import { RefreshCw, ShieldCheck } from "lucide-react";
import ConnectionStatusBadge from "./ConnectionStatusBadge.jsx";

/**
 * Top-of-page header: icon + title + live status pill on the left,
 * "Refresh Status" / "Test Connection" on the right. Connect/Reconnect/
 * Disconnect live with their respective cards further down the page (a
 * destructive/setup action belongs next to the thing it acts on, not in a
 * page-level toolbar). Generic across integrations — pass the icon/title/
 * subtitle for whichever one this page is (see WhatsAppIntegration.jsx and
 * FacebookIntegration.jsx).
 */
export default function IntegrationHeader({
  icon: Icon,
  title,
  subtitle,
  connected,
  accountStatus,
  onRefreshStatus,
  refreshingStatus,
  onTestConnection,
  testingConnection,
}) {
  return (
    <div className="integration-header">
      <div className="integration-header-title">
        <div className={`integration-icon-badge${connected ? "" : " muted"}`}>
          <Icon size={19} />
        </div>
        <div>
          <h1 style={{ marginBottom: 2 }}>{title}</h1>
          <div className="page-subtitle">{subtitle}</div>
        </div>
        <ConnectionStatusBadge connected={connected} accountStatus={accountStatus} />
      </div>

      <div className="integration-header-actions">
        <button className="btn btn-sm" onClick={onRefreshStatus} disabled={refreshingStatus}>
          <RefreshCw size={13} className={refreshingStatus ? "spin" : ""} />
          {refreshingStatus ? "Refreshing…" : "Refresh Status"}
        </button>
        {connected && (
          <button className="btn btn-sm" onClick={onTestConnection} disabled={testingConnection}>
            <ShieldCheck size={13} />
            {testingConnection ? "Testing…" : "Test Connection"}
          </button>
        )}
      </div>
    </div>
  );
}
