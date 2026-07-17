const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { getTemplateDetails, TemplateError } = require("./whatsappTemplates");
const { requireAuthContext, AuthError } = require("./auth");

/**
 * GET /fetchTemplateDetails?templateId=<META_TEMPLATE_ID>
 * ---------------------------------------------------------------------------
 * Returns the complete stored template document from Firestore.
 * This is a fast read — no Meta API call — so the UI can open detail panels
 * instantly. Use refreshTemplate to force a re-fetch from Meta.
 *
 * Query params:
 *   templateId  string  Meta's template ID (also the Firestore doc ID)
 *
 * Success 200:
 *   Full template document with all fields.
 *
 * Error 400 — missing templateId
 * Error 404 — template not found in Firestore
 * Error 500 — unexpected error
 */
const fetchTemplateDetails = onRequest(
  {
    region: "us-central1",
    cors: true,
  },
  async (req, res) => {
    if (req.method !== "GET") {
      res.sendStatus(405);
      return;
    }

    const templateId = req.query.templateId;
    if (!templateId) {
      res.status(400).json({ error: "templateId query parameter is required." });
      return;
    }

    try {
      const { agencyId } = await requireAuthContext(req);
      const db = admin.firestore();
      const template = await getTemplateDetails(db, agencyId, { templateId });
      res.status(200).json(template);
    } catch (err) {
      if (err instanceof TemplateError) {
        const statusCode = err.code === "not_found" ? 404 : 400;
        res.status(statusCode).json({ error: err.message });
        return;
      }
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error("fetchTemplateDetails: unexpected error", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Failed to fetch template details." });
    }
  }
);

module.exports = { fetchTemplateDetails };
