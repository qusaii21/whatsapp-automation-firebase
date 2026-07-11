const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { WHATSAPP_TOKEN } = require("./config");
const { refreshSingleTemplate, TemplateError } = require("./whatsappTemplates");

/**
 * POST /refreshTemplate
 * ---------------------------------------------------------------------------
 * Re-fetches a single template from Meta's API and upserts it into Firestore.
 * Preserves CRM-only fields (variableMappings) via merge: true in
 * refreshSingleTemplate.
 *
 * Use this for the per-row "Refresh" button in the Templates UI — cheaper
 * than running a full syncTemplates when you only need to check one template's
 * current status / quality score.
 *
 * Request body:
 * {
 *   templateId: string  — Meta's template ID (also the Firestore doc ID)
 * }
 *
 * Success 200:
 *   Normalised template object (same shape as stored in Firestore).
 *
 * Error 400 — missing templateId
 * Error 502 — Meta API error
 * Error 500 — unexpected error
 */
const refreshTemplate = onRequest(
  {
    region: "us-central1",
    cors: true,
    secrets: [WHATSAPP_TOKEN],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const { templateId } = req.body || {};
    if (!templateId) {
      res.status(400).json({ error: "templateId is required." });
      return;
    }

    try {
      const db = admin.firestore();
      const result = await refreshSingleTemplate(db, {
        templateId,
        whatsappToken: WHATSAPP_TOKEN.value(),
      });

      logger.info("refreshTemplate: success", { templateId });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof TemplateError) {
        const statusCode = err.code === "upstream_error" ? 502 : 400;
        res.status(statusCode).json({ error: err.message });
        return;
      }
      logger.error("refreshTemplate: unexpected error", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Failed to refresh template." });
    }
  }
);

module.exports = { refreshTemplate };
