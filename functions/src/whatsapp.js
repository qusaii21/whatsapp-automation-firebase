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
 */
async function sendWhatsAppTemplate({
  to,
  templateName,
  whatsappToken,
  phoneNumberId,
  languageCode = "en_US",
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

module.exports = { sendWhatsAppTemplate, sendWhatsAppText };
