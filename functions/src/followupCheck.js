const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_FOLLOWUP_TEMPLATE,
} = require("./config");
const { sendWhatsAppTemplate } = require("./whatsapp");

/**
 * Called exactly once, 24 hours after a lead was created, by the Cloud Task
 * scheduled in leadsWebhook. Not a cron job — this instance only ever looks
 * at the single lead named in its payload.
 *
 * `invoker: "private"` (see index.js) means only requests carrying a valid
 * OIDC token for the configured service account (i.e. Cloud Tasks) will
 * reach this handler at all.
 */
const followupCheck = onRequest(
  {
    secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_FOLLOWUP_TEMPLATE],
    region: "us-central1",
    invoker: "private",
  },
  async (req, res) => {
    try {
      const { phone } = req.body || {};
      if (!phone) {
        res.status(400).send("Missing phone in task payload");
        return;
      }

      const db = admin.firestore();
      const leadRef = db.collection("leads").doc(phone);
      const snap = await leadRef.get();

      if (!snap.exists) {
        logger.warn("followupCheck: lead no longer exists", { phone });
        res.sendStatus(200);
        return;
      }

      const lead = snap.data();

      if (lead.status === "pending") {
        await sendWhatsAppTemplate({
          to: phone,
          templateName: WHATSAPP_FOLLOWUP_TEMPLATE.value(),
          whatsappToken: WHATSAPP_TOKEN.value(),
          phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
        });

        await leadRef.update({ status: "followed_up" });
        logger.info("followupCheck: sent follow-up", { phone });
      } else {
        logger.info("followupCheck: lead already progressed, no-op", {
          phone,
          status: lead.status,
        });
      }

      res.sendStatus(200);
    } catch (err) {
      logger.error("followupCheck: error", err);
      res.sendStatus(500); // 500 lets Cloud Tasks retry per the queue's retry config.
    }
  }
);

module.exports = { followupCheck };
