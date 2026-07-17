import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import ConfirmationDialog from "./ConfirmationDialog.jsx";

/**
 * Generic disconnect danger zone, reused by every integration's settings
 * page — pass what disconnecting stops (`consequences`) and the confirm
 * copy for this specific integration.
 */
export default function DangerZoneCard({
  connected,
  title = "Disconnect",
  consequences = [],
  note = "Existing data is not deleted — you can reconnect at any time.",
  confirmTitle = "Disconnect?",
  confirmMessage,
  actionLabel = "Disconnect",
  onDisconnect,
  disconnecting,
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!connected) return null;

  async function handleConfirm() {
    const ok = await onDisconnect();
    if (ok) setConfirmOpen(false);
  }

  return (
    <div className="card danger-zone" style={{ padding: 20, marginBottom: 20 }}>
      <h2 style={{ marginTop: 0, fontSize: 15, display: "flex", alignItems: "center", gap: 8, color: "var(--danger)" }}>
        <AlertTriangle size={16} /> Danger Zone
      </h2>
      {consequences.length > 0 && (
        <>
          <p style={{ marginTop: 0, marginBottom: 0, color: "var(--ink-muted)", fontSize: 13.5 }}>
            {title} will:
          </p>
          <ul className="danger-zone-list">
            {consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
      <p className="empty-note" style={{ marginTop: 10 }}>{note}</p>

      <button
        className="btn btn-sm btn-danger"
        style={{ marginTop: 14 }}
        onClick={() => setConfirmOpen(true)}
        disabled={disconnecting}
      >
        {disconnecting ? "Disconnecting…" : actionLabel}
      </button>

      <ConfirmationDialog
        open={confirmOpen}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel="Disconnect"
        danger
        loading={disconnecting}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
