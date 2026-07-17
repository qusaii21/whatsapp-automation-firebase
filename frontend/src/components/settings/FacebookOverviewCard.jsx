import { Facebook } from "lucide-react";
import { formatDateTime } from "../../lib/format.js";
import LoadingOverlay from "./LoadingOverlay.jsx";

function Field({ label, children }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      <div>{children ?? <span className="empty-note">—</span>}</div>
    </div>
  );
}

/** Read-only projection of getFacebookIntegrationStatusData — never shows a raw token. */
export default function FacebookOverviewCard({ status, loading, refreshing }) {
  return (
    <div className="card loading-overlay-anchor" style={{ padding: 20, marginBottom: 20, position: "relative" }}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Overview</h2>

      <LoadingOverlay active={refreshing} label="Refreshing status…" />

      {loading ? (
        <div className="settings-grid">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton skeleton-line" style={{ width: "60%", marginBottom: 8 }} />
              <div className="skeleton skeleton-line" style={{ width: "85%" }} />
            </div>
          ))}
        </div>
      ) : status?.connected ? (
        <div className="settings-grid">
          <Field label="Page name">{status.pageName}</Field>
          <Field label="Page ID">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{status.pageId}</span>
          </Field>
          <Field label="Connected">{status.connectedAt ? formatDateTime(status.connectedAt) : null}</Field>
          <Field label="Last health check">
            {status.lastHealthCheckAt ? formatDateTime(status.lastHealthCheckAt) : null}
          </Field>
        </div>
      ) : (
        <div className="empty-state">
          <Facebook size={24} style={{ marginBottom: 6, color: "var(--ink-faint)" }} />
          <div className="empty-state-title">Not connected</div>
          <div className="empty-note">Connect your agency's own Facebook Page below to start capturing Lead Ads.</div>
        </div>
      )}
    </div>
  );
}
