import { HeartPulse, Key, Radio, Send, Webhook, FileText } from "lucide-react";
import { formatDateTime } from "../../lib/format.js";
import LoadingOverlay from "./LoadingOverlay.jsx";

function Indicator({ tone, label }) {
  const dot =
    tone === "success" ? "status-dot-success" : tone === "danger" ? "status-dot-danger" : tone === "warm" ? "status-dot-warm" : "status-dot-muted";
  return (
    <span className="health-row-value">
      <span className={`status-dot ${dot}`} />
      {label}
    </span>
  );
}

/**
 * Health rows are built entirely from what the backend actually tracks
 * (see whatsappCredentials.js#getIntegrationStatusData and the Templates
 * live listener) — Webhook Status and Last Successful Send aren't recorded
 * anywhere in Firestore today, so those rows say so honestly instead of
 * showing a fabricated "OK".
 */
export default function HealthStatusCard({ status, templateCount, lastTemplateSyncAt, checking }) {
  const connected = !!status?.connected;
  const accountStatus = status?.accountStatus;

  const tokenTone = !connected ? "muted" : accountStatus === "CONNECTED" ? "success" : "danger";
  const tokenLabel = !connected
    ? "Not connected"
    : accountStatus === "CONNECTED"
    ? "Valid"
    : accountStatus === "TOKEN_EXPIRED"
    ? "Expired"
    : accountStatus === "TOKEN_INVALID"
    ? "Invalid"
    : accountStatus === "REVOKED"
    ? "Revoked"
    : "Unknown";

  const phoneTone = connected && accountStatus === "CONNECTED" ? "success" : "muted";

  return (
    <div className="card loading-overlay-anchor" style={{ padding: 20, marginBottom: 20, position: "relative" }}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Health</h2>
      <LoadingOverlay active={checking} label="Checking with Meta…" />

      <div className="health-grid">
        <div className="health-row">
          <span className="health-row-label"><Key size={14} /> Token status</span>
          <Indicator tone={tokenTone} label={tokenLabel} />
        </div>

        <div className="health-row">
          <span className="health-row-label"><Radio size={14} /> Phone connected</span>
          <Indicator tone={phoneTone} label={phoneTone === "success" ? "Yes" : "No"} />
        </div>

        <div className="health-row">
          <span className="health-row-label"><FileText size={14} /> Templates synced</span>
          <Indicator
            tone={templateCount > 0 ? "success" : "muted"}
            label={templateCount > 0 ? `${templateCount} template${templateCount === 1 ? "" : "s"}` : "None yet"}
          />
        </div>

        <div className="health-row">
          <span className="health-row-label"><HeartPulse size={14} /> Last health check</span>
          <Indicator
            tone={status?.lastHealthCheckAt ? "success" : "muted"}
            label={status?.lastHealthCheckAt ? formatDateTime(status.lastHealthCheckAt) : "Never"}
          />
        </div>

        <div className="health-row">
          <span className="health-row-label"><FileText size={14} /> Last template sync</span>
          <Indicator
            tone={lastTemplateSyncAt ? "success" : "muted"}
            label={lastTemplateSyncAt ? formatDateTime(lastTemplateSyncAt) : "Never"}
          />
        </div>

        <div className="health-row">
          <span className="health-row-label"><Webhook size={14} /> Webhook status</span>
          <Indicator tone="muted" label="Not monitored" />
        </div>

        <div className="health-row">
          <span className="health-row-label"><Send size={14} /> Last successful send</span>
          <Indicator tone="muted" label="Not tracked" />
        </div>
      </div>

      <p className="empty-note" style={{ marginTop: 12, marginBottom: 0 }}>
        Webhook delivery and send history aren't recorded on the integration record yet — configure your
        webhook URL directly in the Meta App dashboard, and check the Chats page for live message activity.
      </p>
    </div>
  );
}
