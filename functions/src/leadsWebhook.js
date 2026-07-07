const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");

const {
  FB_VERIFY_TOKEN,
  FB_PAGE_ACCESS_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_WELCOME_TEMPLATE,
  GRAPH_API_VERSION,
} = require("./config");
const { sendWhatsAppTemplate } = require("./whatsapp");
const { createFollowupTask } = require("./cloudTasks");

/**
 * Fetches the full field data for a lead from the Graph API and pulls out
 * the name + phone number. Pattern adapted from fbsamples/lead-ads-webhook-sample.
 */
async function fetchLeadDetails(leadgenId, pageAccessToken) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadgenId}`;
  const { data } = await axios.get(url, {
    params: { access_token: pageAccessToken },
  });

  // field_data looks like: [{ name: "full_name", values: ["Jane Doe"] }, ...]
  const fields = {};
  for (const field of data.field_data || []) {
    fields[field.name] = field.values && field.values[0];
  }

  const name = fields.full_name || fields.name || "there";
  // Meta lead forms typically label this "phone_number".
  let phone = fields.phone_number || fields.phone || "";
  // Normalize to digits only (WhatsApp Cloud API wants no "+", no spaces/dashes).
  phone = phone.replace(/[^\d]/g, "");

  return { name, phone };
}

const leadsWebhook = onRequest(
  {
    secrets: [
      FB_VERIFY_TOKEN,
      FB_PAGE_ACCESS_TOKEN,
      WHATSAPP_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_WELCOME_TEMPLATE,
    ],
    region: "us-central1",
  },
  async (req, res) => {
    // --- GET: Meta's webhook verification handshake ---------------------
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === FB_VERIFY_TOKEN.value()) {
        logger.info("leadsWebhook: verification succeeded");
        res.status(200).send(challenge);
      } else {
        logger.warn("leadsWebhook: verification failed", { mode });
        res.sendStatus(403);
      }
      return;
    }

    // --- POST: new leadgen event -----------------------------------------
    if (req.method === "POST") {
      try {
        const body = req.body;

        if (body.object !== "page") {
          res.sendStatus(404);
          return;
        }

        const projectId = process.env.GCLOUD_PROJECT;

        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            if (change.field !== "leadgen") continue;

            const { leadgen_id: leadgenId } = change.value || {};
            if (!leadgenId) continue;

            const { name, phone } = await fetchLeadDetails(
              leadgenId,
              FB_PAGE_ACCESS_TOKEN.value()
            );

            if (!phone) {
              logger.error("leadsWebhook: lead had no phone number", { leadgenId });
              continue;
            }

            const db = admin.firestore();
            const leadRef = db.collection("leads").doc(phone);

            await leadRef.set(
              {
                name,
                phone,
                status: "pending",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                conversationHistory: [],
              },
              { merge: true }
            );

            // 1. Send the WhatsApp welcome template.
            await sendWhatsAppTemplate({
              to: phone,
              templateName: WHATSAPP_WELCOME_TEMPLATE.value(),
              whatsappToken: WHATSAPP_TOKEN.value(),
              phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
            });

            // 2. Schedule exactly one follow-up check, 24h from now.
            await createFollowupTask(phone, projectId);

            logger.info("leadsWebhook: processed new lead", { phone });
          }
        }

        res.sendStatus(200);
      } catch (err) {
        logger.error("leadsWebhook: error processing request", err);
        // Still return 200 so Meta doesn't retry-storm us; the error is logged for debugging.
        res.sendStatus(200);
      }
      return;
    }

    res.sendStatus(405);
  }
);

module.exports = { leadsWebhook };
