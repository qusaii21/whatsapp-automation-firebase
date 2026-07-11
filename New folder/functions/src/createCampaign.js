const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { createCampaign: createCampaignDoc, CampaignError } = require("./campaigns");
const { assertTemplateApprovedForCampaign } = require("./whatsappTemplates");

/**
 * Creates a new campaign in "draft" status. No recipients, no sending — this
 * only writes the campaign definition itself (name/type/template/counters).
 * Recipients are added afterward via addCampaignRecipients.
 *
 * Like sendManualMessage.js, this is a thin browser-callable endpoint: the
 * CRM has no server layer of its own and normally talks to Firestore
 * directly, but campaign creation goes through a function so validation and
 * default-counter initialization live in one place (campaigns.js) rather
 * than being re-implemented (or skipped) on the client.
 *
 * Template validation (added alongside Template Management): before a
 * campaign is ever written, templateName/templateLanguage must resolve to
 * an Approved, non-Disabled entry in `whatsappTemplates` — see
 * whatsappTemplates.js's assertTemplateApprovedForCampaign. This is checked
 * here rather than inside campaigns.js so campaigns.js's schema/validation
 * stays exactly as it was; this is an added precondition, not a redesign.
 */
const createCampaign = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    try {
      const { name, description, type, templateName, templateLanguage } = req.body || {};
      const db = admin.firestore();

      if (typeof templateName === "string" && typeof templateLanguage === "string") {
        await assertTemplateApprovedForCampaign(db, {
          templateName: templateName.trim(),
          templateLanguage: templateLanguage.trim(),
        });
      }

      const { id, data } = await createCampaignDoc(db, {
        name,
        description,
        type,
        templateName,
        templateLanguage,
      });

      logger.info("createCampaign: created", { campaignId: id });
      res.status(201).json({ id, campaign: data });
    } catch (err) {
      if (err instanceof CampaignError) {
        res.status(400).json({ error: err.message });
        return;
      }
      logger.error("createCampaign: failed", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Failed to create campaign" });
    }
  }
);

module.exports = { createCampaign };
