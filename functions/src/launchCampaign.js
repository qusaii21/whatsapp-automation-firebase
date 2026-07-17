const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { getCampaign, launchCampaign: launchCampaignTransaction, CampaignError } = require("./campaigns");
const { assertTemplateApprovedForCampaign } = require("./whatsappTemplates");
const { dispatchCampaignQueue } = require("./campaignQueue");
const { requireAuthContext, AuthError } = require("./auth");

/**
 * CAMPAIGN LAUNCH — draft -> queued -> (dispatch triggered).
 * ---------------------------------------------------------------------------
 * Validates a draft campaign end-to-end and, if every check passes, flips it
 * to "queued", then immediately triggers the queue engine
 * (campaignQueue.js's dispatchCampaignQueue) to create one Cloud Task per
 * recipient. Still does NOT call the WhatsApp Cloud API itself — that's the
 * same "foundation only" boundary createCampaign.js / addCampaignRecipients.js
 * draw for their own features. Cloud Tasks created here point at
 * `processCampaignRecipient` (processCampaignRecipient.js), the worker that
 * does the actual send and picks up from "queued" -> "sending"
 * (already a legal transition in campaigns.js's CAMPAIGN_STATUS_TRANSITIONS).
 *
 * Dispatch is triggered by a direct in-process function call, not a second
 * HTTP round trip or a Firestore trigger — see campaignQueue.js's file
 * header for why. A dispatch failure here does NOT fail the launch response:
 * the campaign is already validly "queued" by that point, and dispatch is
 * independently safe to retry (see campaignQueue.js's idempotency notes) via
 * the standalone dispatchCampaignQueue Cloud Function if this in-line
 * attempt didn't finish.
 *
 * Like createCampaign.js, this file (not campaigns.js) is where the
 * template-approval check gets wired in — campaigns.js has no dependency on
 * whatsappTemplates.js by design, so cross-cutting validation lives at the
 * endpoint layer instead of inside the data-layer module.
 *
 * Validation runs in full (not short-circuited on the first failure) so the
 * response can list every reason a launch was rejected at once — e.g. a
 * campaign with both zero recipients AND a pending template reports both,
 * rather than making the operator fix one, resubmit, and discover the next.
 */
async function validateCampaignForLaunch(db, agencyId, campaign) {
  const errors = [];

  if (campaign.status !== "draft") {
    errors.push(launchStatusError(campaign.status));
  }

  if (!campaign.totalRecipients || campaign.totalRecipients < 1) {
    errors.push("Campaign has no recipients — add at least one recipient before launching.");
  }

  let template = null;
  try {
    template = await assertTemplateApprovedForCampaign(db, agencyId, {
      templateName: campaign.templateName,
      templateLanguage: campaign.templateLanguage,
    });
  } catch (err) {
    // assertTemplateApprovedForCampaign already produces the specific
    // "missing" / "disabled" / "not approved yet" messages this feature's
    // requirements ask for — just collect it rather than re-deriving it.
    if (err instanceof CampaignError) {
      errors.push(err.message);
    } else {
      throw err;
    }
  }

  return { errors, template };
}

function launchStatusError(status) {
  switch (status) {
    case "queued":
      return "Campaign has already been launched and is queued for sending.";
    case "sending":
      return "Campaign is already sending.";
    case "completed":
      return "Campaign has already completed sending.";
    case "cancelled":
      return "Campaign was cancelled and can't be launched.";
    case "failed":
      return "Campaign previously failed and can't be relaunched from here.";
    default:
      return `Campaign must be in 'draft' status to launch (current status: '${status}').`;
  }
}

const launchCampaign = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    try {
      const context = await requireAuthContext(req, { roles: ["owner", "admin", "agent"] });
      const agencyId = context.agencyId;
      const { campaignId, launchedBy } = req.body || {};

      if (!campaignId || typeof campaignId !== "string") {
        res.status(400).json({ error: "Missing or invalid 'campaignId'" });
        return;
      }

      const db = admin.firestore();
      const { data: campaign } = await getCampaign(db, agencyId, campaignId);

      const { errors, template } = await validateCampaignForLaunch(db, agencyId, campaign);
      if (errors.length > 0) {
        logger.info("launchCampaign: validation failed", { campaignId, errors });
        res.status(422).json({ error: "Campaign failed launch validation.", errors });
        return;
      }

      const queuedBy = typeof launchedBy === "string" && launchedBy.trim() ? launchedBy.trim() : context.email;
      const validationSummary = {
        totalRecipients: campaign.totalRecipients,
        templateName: campaign.templateName,
        templateLanguage: campaign.templateLanguage,
        templateStatus: template.status,
        checkedAt: Date.now(),
      };

      const result = await launchCampaignTransaction(db, agencyId, campaignId, { queuedBy, validationSummary });
      logger.info("launchCampaign: queued", { campaignId, queuedBy });

      // Trigger the queue engine now that the campaign is actually queued.
      // Failure here is logged, not thrown — the launch itself already
      // succeeded and committed, and dispatch can be safely retried later
      // (manually, or via the standalone dispatchCampaignQueue function)
      // without risking duplicate tasks. See campaignQueue.js.
      let dispatch;
      try {
        dispatch = await dispatchCampaignQueue(db, agencyId, campaignId, process.env.GCLOUD_PROJECT);
        logger.info("launchCampaign: dispatch triggered", { campaignId, ...dispatch });
      } catch (dispatchErr) {
        logger.error("launchCampaign: post-launch dispatch trigger failed, campaign remains queued", {
          campaignId,
          error: dispatchErr.message,
          stack: dispatchErr.stack,
        });
        dispatch = { error: dispatchErr.message };
      }

      res.status(200).json({ ...result, dispatch });
    } catch (err) {
      if (err instanceof CampaignError) {
        const statusCode = err.code === "not_found" ? 404 : err.code === "failed_precondition" ? 409 : 400;
        res.status(statusCode).json({ error: err.message });
        return;
      }
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error("launchCampaign: failed", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Failed to launch campaign" });
    }
  }
);

module.exports = { launchCampaign };
