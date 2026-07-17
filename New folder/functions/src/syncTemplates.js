const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { WHATSAPP_CRED_ENC_KEY } = require("./config");
const { syncTemplatesFromMeta, TemplateError } = require("./whatsappTemplates");
const { requireAuthContext, AuthError } = require("./auth");
const { loadWhatsAppCredentials, WhatsAppNotConnectedError } = require("./whatsappCredentials");

/**
 * POST /syncTemplates
 * ---------------------------------------------------------------------------
 * Manual "Sync Templates" endpoint, hit by the Templates page's Sync button.
 * Thin wrapper over syncTemplatesFromMeta (whatsappTemplates.js).
 *
 * Now syncs the full field set from Meta including:
 *   - quality_score  (GREEN / YELLOW / RED / UNKNOWN)
 *   - rejected_reason
 *   - parameter_format (positional / named)
 *   - status (full range including PAUSED, IN_APPEAL, etc.)
 *
 * CRM-only fields (variableMappings) are preserved via merge: true.
 */
const syncTemplates = onRequest(
  { region: "us-central1", cors: true, secrets: [WHATSAPP_CRED_ENC_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    try {
      const { agencyId } = await requireAuthContext(req, { roles: ["owner", "admin"] });
      const db = admin.firestore();
      const creds = await loadWhatsAppCredentials(db, agencyId);
      const result = await syncTemplatesFromMeta(db, agencyId, {
        wabaId: creds.wabaId,
        whatsappToken: creds.whatsappToken,
      });

      logger.info("syncTemplates: done", result);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof WhatsAppNotConnectedError) {
        res.status(409).json({ error: err.message, code: "not_connected" });
        return;
      }
      if (err instanceof TemplateError) {
        const statusCode = err.code === "upstream_error" ? 502 : 400;
        res.status(statusCode).json({ error: err.message });
        return;
      }
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error("syncTemplates: failed", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Failed to sync templates" });
    }
  }
);

module.exports = { syncTemplates };
