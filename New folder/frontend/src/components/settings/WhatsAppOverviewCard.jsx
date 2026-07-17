import { Phone, RefreshCw } from "lucide-react";
import { formatDateTime } from "../../lib/format.js";
import LoadingOverlay from "./LoadingOverlay.jsx";

const QUALITY_TONE = {
  GREEN: "badge-success",
  YELLOW: "badge-warm",
  RED: "badge-danger",
};

function Field({ label, children }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      <div>{children ?? <span className="empty-note">—</span>}</div>
    </div>
  );
}

/**
 * Read-only projection of `getIntegrationStatusData` — never shows a raw
 * credential (the backend never returns one, see whatsappCredentials.js).
 */
export default function WhatsAppOverviewCard({ status, loading, refreshing }) {
  return (
    <div className="card loading-overlay-anchor" style={{ padding: 20, marginBottom: 20, position: "relative" }}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Overview</h2>

      <LoadingOverlay active={refreshing} label="Refreshing status…" />

      {loading ? (
        <div className="settings-grid">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton skeleton-line" style={{ width: "60%", marginBottom: 8 }} />
              <div className="skeleton skeleton-line" style={{ width: "85%" }} />
            </div>
          ))}
        </div>
      ) : status?.connected ? (
        <div className="settings-grid">
          <Field label="Business name">{status.businessName}</Field>
          <Field label="Display phone number">
            {status.displayPhoneNumber && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Phone size={12} style={{ color: "var(--ink-faint)" }} />
                {status.displayPhoneNumber}
              </span>
            )}
          </Field>
          <Field label="Phone number ID">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{status.phoneNumberId}</span>
          </Field>
          <Field label="Business account ID">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{status.businessAccountId}</span>
          </Field>
          <Field label="Quality rating">
            {status.qualityRating && status.qualityRating !== "UNKNOWN" ? (
              <span className={`badge ${QUALITY_TONE[status.qualityRating] || "badge-muted"}`}>
                {status.qualityRating}
              </span>
            ) : null}
          </Field>
          <Field label="Messaging tier">{status.messagingTier}</Field>
          <Field label="Connected">{status.connectedAt ? formatDateTime(status.connectedAt) : null}</Field>
          <Field label="Last health check">
            {status.lastHealthCheckAt ? formatDateTime(status.lastHealthCheckAt) : null}
          </Field>
          <Field label="Last template sync">
            {status.lastSyncedTemplateCountAt ? formatDateTime(status.lastSyncedTemplateCountAt) : null}
          </Field>
          <Field label="Templates">
            {status.templateCount != null ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {status.templateCount} synced
              </span>
            ) : null}
          </Field>
        </div>
      ) : (
        <div className="empty-state">
          <RefreshCw size={24} style={{ marginBottom: 6, color: "var(--ink-faint)" }} />
          <div className="empty-state-title">Not connected</div>
          <div className="empty-note">Connect your own Meta WhatsApp Business Account below to get started.</div>
        </div>
      )}
    </div>
  );
}
