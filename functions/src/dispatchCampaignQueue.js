const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { dispatchCampaignQueue: runDispatch } = require("./campaignQueue");
const { CampaignError } = require("./campaigns");
const { CAMPAIGN_DISPATCH_TIMEOUT_SECONDS } = require("./config");

/**
 * Worker/trigger endpoint for the campaign queue engine. Three callers:
 *   1. launchCampaign.js calls campaignQueue.js's dispatchCampaignQueue()
 *      directly (in-process, not via HTTP) right after a campaign flips
 *      draft -> queued — see campaignQueue.js's file header for why this
 *      codebase drives that off an explicit call rather than a Firestore
 *      trigger.
 *   2. Itself, via createCampaignDispatchTask, when one invocation runs out
 *      of time budget partway through a large recipient list (same
 *      self-chaining pattern as processPhoneQueue.js). This is the ONLY
 *      caller that actually reaches this file in normal operation.
 *   3. Manually, by an operator retrying a dispatch that partially failed
 *      (e.g. some recipients logged "failed to enqueue" and got left
 *      "pending" — see campaignQueue.js). Safe to call any number of times;
 *      see that file's idempotency notes.
 *
 * `invoker: "private"` — same convention as processPhoneQueue.js — so this
 * is only callable via Cloud Tasks' OIDC token or an authenticated project
 * caller, never the open internet.
 */
const dispatchCampaignQueue = onRequest(
  {
    region: "us-central1",
    invoker: "private",
    timeoutSeconds: CAMPAIGN_DISPATCH_TIMEOUT_SECONDS,
  },
  async (req, res) => {
    const { campaignId } = req.body || {};
    if (!campaignId || typeof campaignId !== "string") {
      res.status(400).send("Missing or invalid 'campaignId' in task payload");
      return;
    }

    const db = admin.firestore();
    const projectId = process.env.GCLOUD_PROJECT;

    try {
      const result = await runDispatch(db, campaignId, projectId);
      logger.info("dispatchCampaignQueue: run complete", { campaignId, ...result });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof CampaignError) {
        res.status(err.code === "not_found" ? 404 : 409).json({ error: err.message });
        return;
      }
      logger.error("dispatchCampaignQueue: failed", {
        campaignId,
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Failed to dispatch campaign queue" });
    }
  }
);

module.exports = { dispatchCampaignQueue };
