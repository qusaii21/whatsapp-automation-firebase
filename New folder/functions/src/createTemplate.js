const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { WHATSAPP_TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID } = require("./config");
const { createTemplateOnMeta, TemplateError } = require("./whatsappTemplates");

/**
 * POST /createTemplate
 * ---------------------------------------------------------------------------
 * Creates a new WhatsApp message template on Meta and immediately upserts
 * the result into Firestore (`whatsappTemplates/{templateId}`).
 *
 * Request body:
 * {
 *   name:             string  — lowercase alphanum + underscores, max 512 chars
 *   category:         string  — "MARKETING" | "UTILITY" | "AUTHENTICATION"
 *   language:         string  — BCP-47 language code, e.g. "en_US"
 *   parameter_format: string  — "positional" (default) | "named"
 *   components:       array   — Meta components array (HEADER, BODY, FOOTER, BUTTONS)
 *   variableMappings: object  — CRM-only { "1": "Customer Name", ... } (optional)
 * }
 *
 * Success 200:
 * { templateId, name, status }
 *
 * Error 400 — caller-fixable (bad payload / Meta validation failure)
 * Error 502 — upstream Meta API error
 * Error 500 — unexpected server error
 */
const createTemplate = onRequest(
  {
    region: "us-central1",
    cors: true,
    secrets: [WHATSAPP_TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const {
      name,
      category,
      language,
      parameter_format,
      components,
      variableMappings,
    } = req.body || {};

    // Basic field validation before touching Meta
    if (!name || typeof name !== "string" || name.trim() === "") {
      res.status(400).json({ error: "Template name is required." });
      return;
    }
    if (!/^[a-z0-9_]{1,512}$/.test(name.trim())) {
      res.status(400).json({
        error:
          "Template name must be lowercase alphanumeric characters and underscores only (max 512 chars).",
      });
      return;
    }
    const validCategories = ["MARKETING", "UTILITY", "AUTHENTICATION"];
    if (!category || !validCategories.includes(String(category).toUpperCase())) {
      res.status(400).json({
        error: `Category must be one of: ${validCategories.join(", ")}.`,
      });
      return;
    }
    if (!language || typeof language !== "string") {
      res.status(400).json({ error: "Language is required (e.g. en_US)." });
      return;
    }
    if (!Array.isArray(components) || components.length === 0) {
      res.status(400).json({ error: "At least one component (BODY) is required." });
      return;
    }

    const payload = {
      name: name.trim(),
      category: String(category).toUpperCase(),
      language: language.trim(),
      components,
    };
    if (parameter_format) {
      payload.parameter_format = parameter_format;
    }

    try {
      const db = admin.firestore();
      const result = await createTemplateOnMeta(db, {
        wabaId: WHATSAPP_BUSINESS_ACCOUNT_ID.value(),
        whatsappToken: WHATSAPP_TOKEN.value(),
        payload,
        variableMappings: variableMappings || {},
      });

      logger.info("createTemplate: success", { templateId: result.templateId, name: result.name });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof TemplateError) {
        const statusCode = err.code === "upstream_error" ? 502 : 400;
        res.status(statusCode).json({ error: err.message });
        return;
      }
      logger.error("createTemplate: unexpected error", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Failed to create template. Please try again." });
    }
  }
);

module.exports = { createTemplate };
