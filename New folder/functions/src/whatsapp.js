const axios = require("axios");
const { GRAPH_API_VERSION } = require("./config");

/**
 * Sends an approved WhatsApp template message. Required for the very first
 * message to a lead and for any message sent outside the 24-hour customer
 * service window (the welcome + follow-up messages both qualify).
 *
 * @param {object} params
 * @param {string} params.to Destination phone number in international format, no "+".
 * @param {string} params.templateName Name of the approved WhatsApp template.
 * @param {string} params.whatsappToken WHATSAPP_TOKEN secret value.
 * @param {string} params.phoneNumberId WHATSAPP_PHONE_NUMBER_ID secret value.
 * @param {string} [params.languageCode] Template language code, defaults to "en_US".
 * @param {Array<object>} [params.components] Meta template `components` array
 *   (e.g. `[{ type: "body", parameters: [{ type: "text", text: "..." }] }]`)
 *   used to fill a template's `{{1}}`/`{{2}}` variable placeholders. Optional
 *   and omitted from the request body entirely when not provided, so every
 *   existing caller (leadsWebhook.js, followupCheck.js — variable-free
 *   templates) keeps working unchanged.
 */
async function sendWhatsAppTemplate({
  to,
  templateName,
  whatsappToken,
  phoneNumberId,
  languageCode = "en_US",
  components,
}) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };

  if (Array.isArray(components) && components.length > 0) {
    body.template.components = components;
  }

  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${whatsappToken}`,
        "Content-Type": "application/json",
      },
    });
    return response.data;
  } catch (err) {
    // Meta's actual error reason (code, message, subcode) lives in
    // err.response.data — the raw AxiosError logs as [Object] and hides it.
    console.error(
      "sendWhatsAppTemplate failed:",
      JSON.stringify(err.response?.data || err.message)
    );
    throw err;
  }
}

/**
 * Sends a plain text WhatsApp message. Only valid within an active 24-hour
 * customer service session (i.e. after the lead has messaged us), which is
 * exactly when the AI agent replies.
 *
 * @param {object} params
 * @param {string} params.to Destination phone number, international format, no "+".
 * @param {string} params.text Message body.
 * @param {string} params.whatsappToken WHATSAPP_TOKEN secret value.
 * @param {string} params.phoneNumberId WHATSAPP_PHONE_NUMBER_ID secret value.
 */
async function sendWhatsAppText({ to, text, whatsappToken, phoneNumberId }) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  };

  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${whatsappToken}`,
        "Content-Type": "application/json",
      },
    });
    return response.data;
  } catch (err) {
    console.error(
      "sendWhatsAppText failed:",
      JSON.stringify(err.response?.data || err.message)
    );
    throw err;
  }
}

/**
 * Sends an image message with an optional caption. Used to present a
 * property's photo alongside its details. `imageUrl` must be a publicly
 * reachable URL (a Firebase Storage download URL works, since storage.rules
 * allows public read on property-photos/).
 */
async function sendWhatsAppImage({ to, imageUrl, caption, whatsappToken, phoneNumberId }) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, caption: caption || "" },
  };

  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${whatsappToken}`,
        "Content-Type": "application/json",
      },
    });
    return response.data;
  } catch (err) {
    console.error(
      "sendWhatsAppImage failed:",
      JSON.stringify(err.response?.data || err.message)
    );
    throw err;
  }
}

module.exports = { sendWhatsAppTemplate, sendWhatsAppText, sendWhatsAppImage };
