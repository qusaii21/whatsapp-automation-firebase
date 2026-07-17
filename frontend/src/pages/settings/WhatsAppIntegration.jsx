import { useCallback, useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { authedFetch } from "../../lib/functions.js";
import { callFunction, friendlyWhatsAppError } from "../../lib/whatsappErrors.js";

import IntegrationHeader from "../../components/settings/IntegrationHeader.jsx";
import WhatsAppOverviewCard from "../../components/settings/WhatsAppOverviewCard.jsx";
import HealthStatusCard from "../../components/settings/HealthStatusCard.jsx";
import ConnectionForm from "../../components/settings/ConnectionForm.jsx";
import TemplateTable from "../../components/settings/TemplateTable.jsx";
import DangerZoneCard from "../../components/settings/DangerZoneCard.jsx";
import SettingsToast from "../../components/settings/SettingsToast.jsx";

/**
 * SETTINGS ▸ INTEGRATIONS ▸ WHATSAPP BUSINESS
 * ---------------------------------------------------------------------------
 * Everything an agency Owner needs to manage their own Meta WhatsApp
 * Business Account without ever touching Firestore, scripts, or the CLI —
 * see functions/src/whatsappIntegration.js's header for the connect-flow
 * design this page is built against.
 *
 * Every action here is a thin wrapper over an existing Cloud Function
 * (connectWhatsApp / getIntegrationStatus / disconnectWhatsApp /
 * checkWhatsAppHealth / syncTemplates / refreshTemplate) — nothing new is
 * built on the backend, and connection status is read exclusively through
 * getIntegrationStatus (never a direct Firestore read — integrations/whatsapp
 * has `allow read: if false` in firestore.rules).
 */
export default function WhatsAppIntegrationPage() {
  const { agencyId } = useAuth();

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const [templateCount, setTemplateCount] = useState(0);
  const [lastTemplateSyncAt, setLastTemplateSyncAt] = useState(null);

  const [toast, setToast] = useState(null);

  const loadStatus = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRefreshingStatus(true);
    try {
      const body = await callFunction(authedFetch, "/getIntegrationStatus", { method: "GET" });
      setStatus(body);
    } catch (err) {
      setToast({ type: "error", message: friendlyWhatsAppError(err) });
    } finally {
      setLoading(false);
      setRefreshingStatus(false);
    }
  }, []);

  useEffect(() => {
    loadStatus({ silent: true });
  }, [loadStatus]);

  // Auto-dismiss toast after 6s, matching Templates.jsx.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleConnect(form) {
    setConnecting(true);
    setConnectError(null);
    try {
      await callFunction(authedFetch, "/connectWhatsApp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      await loadStatus({ silent: true });
      setToast({ type: "success", message: "WhatsApp Business Account connected." });
      return true;
    } catch (err) {
      setConnectError(friendlyWhatsAppError(err));
      return false;
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await callFunction(authedFetch, "/disconnectWhatsApp", { method: "POST" });
      await loadStatus({ silent: true });
      setToast({ type: "success", message: "WhatsApp Business Account disconnected." });
      return true;
    } catch (err) {
      setToast({ type: "error", message: friendlyWhatsAppError(err) });
      return false;
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleTestConnection() {
    setTestingConnection(true);
    try {
      const body = await callFunction(authedFetch, "/checkWhatsAppHealth", { method: "POST" });
      await loadStatus({ silent: true });
      if (body.accountStatus === "CONNECTED") {
        setToast({ type: "success", message: "Connection healthy — Meta confirmed the token is valid." });
      } else {
        setToast({
          type: "error",
          message: "Meta reported a problem with this connection. Reconnect with a fresh Access Token below.",
        });
      }
    } catch (err) {
      setToast({ type: "error", message: friendlyWhatsAppError(err) });
    } finally {
      setTestingConnection(false);
    }
  }

  const connected = !!status?.connected;
  const needsReconnect = connected && status?.accountStatus && status.accountStatus !== "CONNECTED";

  return (
    <div>
      <IntegrationHeader
        icon={MessageCircle}
        title="WhatsApp Business"
        subtitle="Connect and manage this agency's own Meta WhatsApp Business Account."
        connected={connected}
        accountStatus={status?.accountStatus}
        onRefreshStatus={() => loadStatus()}
        refreshingStatus={refreshingStatus}
        onTestConnection={handleTestConnection}
        testingConnection={testingConnection}
      />

      <WhatsAppOverviewCard status={status} loading={loading} refreshing={refreshingStatus && !loading} />

      {connected && (
        <HealthStatusCard
          status={status}
          templateCount={templateCount}
          lastTemplateSyncAt={lastTemplateSyncAt}
          checking={testingConnection}
        />
      )}

      {needsReconnect && (
        <div className="auth-error" style={{ marginBottom: 20 }}>
          This connection needs attention — reconnect below with a fresh Access Token to restore sends and
          AI replies.
        </div>
      )}

      {!loading && (
        <ConnectionForm
          mode={connected ? "reconnect" : "connect"}
          onSubmit={handleConnect}
          submitting={connecting}
          error={connectError}
        />
      )}

      <div style={{ height: 20 }} />

      <TemplateTable
        agencyId={agencyId}
        connected={connected && status?.accountStatus === "CONNECTED"}
        onSyncComplete={(count, lastSyncedAt) => {
          setTemplateCount(count);
          setLastTemplateSyncAt(lastSyncedAt);
        }}
        onToast={setToast}
      />

      <DangerZoneCard
        connected={connected}
        title="Disconnecting this WhatsApp Business Account"
        consequences={[
          "Stop the AI agent from sending replies",
          "Pause any active or scheduled campaigns",
          "Disable manual messaging from the Chats page",
        ]}
        note="Existing leads, conversations, and templates are not deleted — you can reconnect at any time."
        confirmTitle="Disconnect WhatsApp Business Account?"
        confirmMessage="AI replies, campaigns, and manual messaging will stop immediately. Your data stays intact and you can reconnect at any time with a fresh Access Token."
        actionLabel="Disconnect WhatsApp"
        onDisconnect={handleDisconnect}
        disconnecting={disconnecting}
      />

      <SettingsToast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
