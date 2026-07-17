const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { addRecipientsToCampaign, CampaignError } = require("./campaigns");
const { requireAuthContext, AuthError } = require("./auth");

/**
 * Adds recipients to a campaign that is still in "draft" status. Purely a
 * data-layer operation — no WhatsApp Cloud API calls, no Cloud Tasks. See
 * campaigns.js's addRecipientsToCampaign for validation/dedup/counter logic.
 *
 * Expects: { campaignId: string, recipients: [{ phone: string, leadId?: string }] }
 */
const addCampaignRecipients = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    try {
      const { agencyId } = await requireAuthContext(req, { roles: ["owner", "admin"] });
      const { campaignId, recipients } = req.body || {};

      if (!campaignId || typeof campaignId !== "string") {
        res.status(400).json({ error: "Missing or invalid 'campaignId'" });
        return;
      }

      const db = admin.firestore();
      const result = await addRecipientsToCampaign(db, agencyId, campaignId, recipients);

      logger.info("addCampaignRecipients: done", { campaignId, ...result });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof CampaignError) {
        const statusCode = err.code === "not_found" ? 404 : 400;
        res.status(statusCode).json({ error: err.message });
        return;
      }
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error("addCampaignRecipients: failed", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Failed to add recipients" });
    }
  }
);

module.exports = { addCampaignRecipients };
