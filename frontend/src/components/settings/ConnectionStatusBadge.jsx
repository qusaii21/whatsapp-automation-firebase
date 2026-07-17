/**
 * Maps `accountStatus` (see whatsappCredentials.js#getIntegrationStatusData)
 * to a label + tone. `accountStatus` is only meaningful once `connected` is
 * true — an agency that has never connected has `connected: false` and no
 * `accountStatus` at all, which this badge renders as "Not connected".
 */
const STATUS_META = {
  CONNECTED: { label: "Connected", tone: "success" },
  TOKEN_EXPIRED: { label: "Token expired", tone: "danger" },
  TOKEN_INVALID: { label: "Token invalid", tone: "danger" },
  REVOKED: { label: "Access revoked", tone: "danger" },
  DISCONNECTED: { label: "Disconnected", tone: "muted" },
};

const TONE_CLASS = {
  success: "badge-success",
  danger: "badge-danger",
  warm: "badge-warm",
  muted: "badge-muted",
};

export default function ConnectionStatusBadge({ connected, accountStatus }) {
  if (!connected) {
    return (
      <span className="badge badge-muted">
        <span className="status-dot status-dot-muted" />
        Not connected
      </span>
    );
  }

  const meta = STATUS_META[accountStatus] || { label: accountStatus || "Unknown", tone: "muted" };
  const dotClass =
    meta.tone === "success" ? "status-dot-success" : meta.tone === "danger" ? "status-dot-danger" : "status-dot-muted";

  return (
    <span className={`badge ${TONE_CLASS[meta.tone] || "badge-muted"}`}>
      <span className={`status-dot ${dotClass}`} />
      {meta.label}
    </span>
  );
}
