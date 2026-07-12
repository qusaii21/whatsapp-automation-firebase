const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  pauseCampaign: pauseCampaignTx,
  resumeCampaign: resumeCampaignTx,
  cancelCampaign: cancelCampaignTx,
  completeCampaignIfFinished,
  CampaignError,
} = require("./campaigns");
const { cancelQueuedTasks, dispatchCampaignQueue: runDispatch } = require("./campaignQueue");
const { CAMPAIGN_DISPATCH_TIMEOUT_SECONDS } = require("./config");

/**
 * Pause / Resume / Cancel / Retry Dispatch — Firestore-state HTTP endpoints
 * for the campaign queue engine. Same request/response conventions as
 * launchCampaign.js: POST { campaignId, ...actorField }, 200 with the
 * resulting state on success, or an error status mapped from
 * CampaignError.code.
 *
 * Cancel is the only one of the first three that reaches outside Firestore —
 * it additionally best-effort deletes not-yet-run Cloud Tasks via
 * campaignQueue.js's cancelQueuedTasks, exactly the same "cross-cutting
 * concern lives at the endpoint layer, not in campaigns.js" boundary
 * launchCampaign.js already draws for template validation. If task cleanup
 * partially fails, the cancellation itself has already committed (it runs
 * after cancelCampaignTx succeeds) — cleanup failures are reported in the
 * response, not treated as reasons to fail the whole request, since a
 * cancelled campaign staying cancelled matters more than every last task
 * being deleted (processCampaignRecipient.js checks campaign.status before
 * acting on any task regardless).
 *
 * Retry Dispatch ("reload") is a thin public wrapper around
 * campaignQueue.js's dispatchCampaignQueue — the exact same function
 * launchCampaign.js calls in-process right after a launch, and the exact
 * scenario its own file header already documents as caller #3: "Manually, by
 * an operator retrying a dispatch that partially failed (e.g. some
 * recipients logged 'failed to enqueue' and got left 'pending')" — for
 * example a Cloud Tasks queue that didn't exist yet, or hadn't finished
 * propagating, at launch time. dispatchCampaignQueue.js (the HTTP file) only
 * exposes that same function with `invoker: "private"`, so it can't be
 * called directly from the browser; this gives operators a public,
 * CORS-enabled way to trigger the identical in-process call. Safe to call
 * any number of times — it no-ops (`{ skipped: true }`) unless the campaign
 * is still "queued" with recipients left "pending", and is lock-protected
 * against overlapping with an already-running dispatch (see
 * campaignQueue.js's tryAcquireDispatchLock).
 */

function statusCodeFor(err) {
  if (err.code === "not_found") return 404;
  if (err.code === "failed_precondition") return 409;
  return 400;
}

async function handle(res, actionName, fn) {
  try {
    const result = await fn();
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof CampaignError) {
      res.status(statusCodeFor(err)).json({ error: err.message });
      return;
    }
    logger.error(`campaignControl: ${actionName} failed unexpectedly`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: `Failed to ${actionName} campaign` });
  }
}

const pauseCampaign = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }
  const { campaignId, pausedBy } = req.body || {};
  if (!campaignId || typeof campaignId !== "string") {
    res.status(400).json({ error: "Missing or invalid 'campaignId'" });
    return;
  }

  await handle(res, "pause", async () => {
    const result = await pauseCampaignTx(admin.firestore(), campaignId, { pausedBy });
    logger.info("campaignControl: paused", { campaignId, pausedBy });
    return result;
  });
});

const resumeCampaign = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }
  const { campaignId, resumedBy } = req.body || {};
  if (!campaignId || typeof campaignId !== "string") {
    res.status(400).json({ error: "Missing or invalid 'campaignId'" });
    return;
  }

  await handle(res, "resume", async () => {
    const result = await resumeCampaignTx(admin.firestore(), campaignId, { resumedBy });
    logger.info("campaignControl: resumed", { campaignId, resumedBy, target: result.status });
    return result;
  });
});

const cancelCampaign = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }
  const { campaignId, cancelledBy } = req.body || {};
  if (!campaignId || typeof campaignId !== "string") {
    res.status(400).json({ error: "Missing or invalid 'campaignId'" });
    return;
  }

  await handle(res, "cancel", async () => {
    const db = admin.firestore();
    const result = await cancelCampaignTx(db, campaignId, { cancelledBy });

    let taskCleanup;
    try {
      taskCleanup = await cancelQueuedTasks(db, campaignId);
    } catch (err) {
      // Cancellation itself already succeeded above — a cleanup failure is
      // logged and surfaced, not allowed to turn a successful cancel into a
      // 500. See file header.
      logger.error("campaignControl: task cleanup failed after cancel", {
        campaignId,
        error: err.message,
        stack: err.stack,
      });
      taskCleanup = { error: err.message };
    }

    logger.info("campaignControl: cancelled", { campaignId, cancelledBy, taskCleanup });
    return { ...result, taskCleanup };
  });
});

const retryCampaignDispatch = onRequest(
  { region: "us-central1", cors: true, timeoutSeconds: CAMPAIGN_DISPATCH_TIMEOUT_SECONDS },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }
    const { campaignId } = req.body || {};
    if (!campaignId || typeof campaignId !== "string") {
      res.status(400).json({ error: "Missing or invalid 'campaignId'" });
      return;
    }

    await handle(res, "retry dispatch for", async () => {
      const db = admin.firestore();
      const projectId = process.env.GCLOUD_PROJECT;
      const result = await runDispatch(db, campaignId, projectId);
      logger.info("campaignControl: retry dispatch run", { campaignId, ...result });

      // Also covers a campaign that finished sending before
      // completeCampaignIfFinished existed (or whose completion check
      // otherwise never fired) and is stuck showing "Sending" with nothing
      // left to do — same no-op-unless-actually-finished guard as the
      // automatic check in processCampaignRecipient.js.
      let completion = null;
      try {
        completion = await completeCampaignIfFinished(db, campaignId);
        if (completion) {
          logger.info("campaignControl: retry dispatch also completed a stuck campaign", { campaignId });
        }
      } catch (err) {
        logger.warn("campaignControl: completion check failed during retry dispatch", {
          campaignId,
          error: err.message,
        });
      }

      return { ...result, completion };
    });
  }
);

module.exports = { pauseCampaign, resumeCampaign, cancelCampaign, retryCampaignDispatch };
