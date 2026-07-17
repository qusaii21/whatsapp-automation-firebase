import { useState } from "react";
import { Ban, Copy, RefreshCw, ShieldAlert } from "lucide-react";
import { authedFetch } from "../lib/functions.js";

/**
 * CAMPAIGN ACTIONS
 * ---------------------------------------------------------------------------
 * Thin client for three campaign lifecycle endpoints, same division of
 * responsibility as CampaignLaunch.jsx: all real validation lives server-side
 * (campaigns.js / campaignControl.js / duplicateCampaign.js), this component
 * just calls the right endpoint, shows what the server decided, and (for
 * Reuse) hands the caller the new campaign's id to navigate to.
 *
 *   - Cancel Campaign  -> POST /cancelCampaign. Shown for any non-terminal
 *     status (draft/queued/sending/paused — anything CAMPAIGN_STATUS_
 *     TRANSITIONS in campaigns.js still allows "cancelled" from). Destructive
 *     and irreversible, so it asks for a confirming second click rather than
 *     firing on the first.
 *   - Reuse Campaign   -> POST /duplicateCampaign. Always shown — copies this
 *     campaign's template + recipient list into a brand-new "draft" campaign
 *     (this campaign itself is left completely untouched) and jumps straight
 *     to it, ready to launch again.
 *   - Retry Dispatch   -> POST /retryCampaignDispatch. Only shown while the
 *     campaign is "queued" — manually re-runs the same dispatch loop
 *     launchCampaign.js already triggers automatically, for the case where an
 *     earlier run left recipients stuck "pending" (e.g. the Cloud Tasks queue
 *     wasn't ready yet). Safe to click any number of times; a click when
 *     there's genuinely nothing left to do just reports "skipped".
 */

const CANCELLABLE_STATUSES = ["draft", "queued", "sending", "paused"];
const RETRYABLE_STATUSES = ["queued", "sending"];

export default function CampaignActions({ campaignId, campaign, onNavigate }) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);

  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState(null);

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(null);
  const [retryResult, setRetryResult] = useState(null);

  if (!campaign) return null;

  const canCancel = CANCELLABLE_STATUSES.includes(campaign.status);
  const canRetryDispatch = RETRYABLE_STATUSES.includes(campaign.status);

  async function handleCancel() {
    if (!confirmingCancel) {
      setConfirmingCancel(true);
      setCancelError(null);
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await authedFetch("/cancelCampaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, cancelledBy: "web" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't cancel campaign (${res.status})`);
      }
      setConfirmingCancel(false);
    } catch (err) {
      console.error("CampaignActions: cancel failed", err);
      setCancelError(err.message || "Couldn't cancel that campaign. Try again.");
    } finally {
      setCancelling(false);
    }
  }

  async function handleDuplicate() {
    setDuplicating(true);
    setDuplicateError(null);
    try {
      const res = await authedFetch("/duplicateCampaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't reuse campaign (${res.status})`);
      }
      if (onNavigate && body.id) {
        onNavigate(body.id);
      }
    } catch (err) {
      console.error("CampaignActions: duplicate failed", err);
      setDuplicateError(err.message || "Couldn't reuse that campaign. Try again.");
    } finally {
      setDuplicating(false);
    }
  }

  async function handleRetryDispatch() {
    setRetrying(true);
    setRetryError(null);
    setRetryResult(null);
    try {
      const res = await authedFetch("/retryCampaignDispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't retry dispatch (${res.status})`);
      }
      setRetryResult(body);
    } catch (err) {
      console.error("CampaignActions: retry dispatch failed", err);
      setRetryError(err.message || "Couldn't retry dispatch. Try again.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="form-section" style={{ marginTop: 24 }}>
      <div className="form-section-title">Actions</div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost" disabled={duplicating} onClick={handleDuplicate}>
          <Copy size={14} /> {duplicating ? "Duplicating…" : "Reuse Campaign"}
        </button>

        {canRetryDispatch && (
          <button type="button" className="btn btn-ghost" disabled={retrying} onClick={handleRetryDispatch}>
            <RefreshCw size={14} />{" "}
            {retrying ? "Refreshing…" : campaign.status === "sending" ? "Refresh Status" : "Retry Dispatch"}
          </button>
        )}

        {canCancel && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={cancelling}
            onClick={handleCancel}
          >
            <Ban size={14} /> {cancelling ? "Cancelling…" : confirmingCancel ? "Confirm Cancel" : "Cancel Campaign"}
          </button>
        )}

        {canCancel && confirmingCancel && !cancelling && (
          <button type="button" className="btn btn-sm" onClick={() => setConfirmingCancel(false)}>
            Never mind
          </button>
        )}
      </div>

      {canCancel && confirmingCancel && !cancelError && (
        <div className="empty-note" style={{ marginTop: 8 }}>
          This cancels the campaign and removes any not-yet-sent tasks. It can't be undone — click "Confirm Cancel"
          to proceed.
        </div>
      )}

      {retryResult && !retryError && (
        <div className="empty-note" style={{ marginTop: 12 }}>
          {retryResult.completion
            ? "All recipients resolved — campaign marked Completed."
            : retryResult.skipped
            ? `Nothing to retry (${retryResult.reason || retryResult.status || "no pending recipients"}).`
            : `Retried dispatch: ${retryResult.enqueuedThisRun ?? 0} recipient(s) enqueued this run${
                retryResult.chained ? ", continuing in the background" : ""
              }.`}
        </div>
      )}

      {[duplicateError, retryError, cancelError].filter(Boolean).map((message, i) => (
        <div className="campaign-launch-errors" key={i}>
          <ul>
            <li>
              <ShieldAlert size={12} /> {message}
            </li>
          </ul>
        </div>
      ))}
    </div>
  );
}
