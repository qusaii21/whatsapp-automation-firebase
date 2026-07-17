import { useCallback, useEffect, useState } from "react";
import { Facebook } from "lucide-react";
import { authedFetch } from "../../lib/functions.js";
import { callFunction, friendlyWhatsAppError } from "../../lib/whatsappErrors.js";

import IntegrationHeader from "../../components/settings/IntegrationHeader.jsx";
import FacebookOverviewCard from "../../components/settings/FacebookOverviewCard.jsx";
import FacebookConnectionForm from "../../components/settings/FacebookConnectionForm.jsx";
import DangerZoneCard from "../../components/settings/DangerZoneCard.jsx";
import SettingsToast from "../../components/settings/SettingsToast.jsx";

/**
 * SETTINGS ▸ INTEGRATIONS ▸ FACEBOOK LEAD ADS
 * ---------------------------------------------------------------------------
 * Lets an agency Owner connect their own Facebook Page for Lead Ads —
 * previously this used one global FB_PAGE_ACCESS_TOKEN secret for every
 * agency (see leadsWebhook.js's old code), which only actually worked for
 * whichever single Page that token belonged to. Every agency now connects
 * its own Page here, exactly like WhatsApp Business — see
 * functions/src/facebookCredentials.js / facebookIntegration.js.
 */
export default function FacebookIntegrationPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const [toast, setToast] = useState(null);

  const loadStatus = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRefreshingStatus(true);
    try {
      const body = await callFunction(authedFetch, "/getFacebookIntegrationStatus", { method: "GET" });
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleConnect(form) {
    setConnecting(true);
    setConnectError(null);
    try {
      await callFunction(authedFetch, "/connectFacebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      await loadStatus({ silent: true });
      setToast({ type: "success", message: "Facebook Page connected." });
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
      await callFunction(authedFetch, "/disconnectFacebook", { method: "POST" });
      await loadStatus({ silent: true });
      setToast({ type: "success", message: "Facebook Page disconnected." });
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
      const body = await callFunction(authedFetch, "/checkFacebookHealth", { method: "POST" });
      await loadStatus({ silent: true });
      if (body.accountStatus === "CONNECTED") {
        setToast({ type: "success", message: "Connection healthy — Meta confirmed the token is valid." });
      } else {
        setToast({
          type: "error",
          message: "Meta reported a problem with this connection. Reconnect with a fresh Page Access Token below.",
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
        icon={Facebook}
        title="Facebook Lead Ads"
        subtitle="Connect this agency's own Facebook Page so its Lead Ads flow straight into the CRM."
        connected={connected}
        accountStatus={status?.accountStatus}
        onRefreshStatus={() => loadStatus()}
        refreshingStatus={refreshingStatus}
        onTestConnection={handleTestConnection}
        testingConnection={testingConnection}
      />

      <FacebookOverviewCard status={status} loading={loading} refreshing={refreshingStatus && !loading} />

      {needsReconnect && (
        <div className="auth-error" style={{ marginBottom: 20 }}>
          This connection needs attention — reconnect below with a fresh Page Access Token to keep pulling
          in new Leads.
        </div>
      )}

      {!loading && (
        <FacebookConnectionForm
          mode={connected ? "reconnect" : "connect"}
          onSubmit={handleConnect}
          submitting={connecting}
          error={connectError}
        />
      )}

      <DangerZoneCard
        connected={connected}
        title="Disconnecting this Facebook Page"
        consequences={["Stop new Lead Ads from being pulled into the CRM"]}
        note="Leads already captured are not deleted — you can reconnect at any time."
        confirmTitle="Disconnect Facebook Page?"
        confirmMessage="New Lead Ads submissions will stop reaching the CRM immediately. Already-captured leads stay intact and you can reconnect at any time with a fresh Page Access Token."
        actionLabel="Disconnect Facebook Page"
        onDisconnect={handleDisconnect}
        disconnecting={disconnecting}
      />

      <SettingsToast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
