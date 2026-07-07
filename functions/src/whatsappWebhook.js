const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  FB_VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  GROQ_API_KEY,
} = require("./config");
const { sendWhatsAppText } = require("./whatsapp");
const { runAgent } = require("./agent");

const whatsappWebhook = onRequest(
  {
    secrets: [FB_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, GROQ_API_KEY],
    region: "us-central1",
  },
  async (req, res) => {
    // --- GET: WhatsApp's webhook verification handshake (same pattern as Meta's) ---
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === FB_VERIFY_TOKEN.value()) {
        logger.info("whatsappWebhook: verification succeeded");
        res.status(200).send(challenge);
      } else {
        logger.warn("whatsappWebhook: verification failed", { mode });
        res.sendStatus(403);
      }
      return;
    }

    // --- POST: incoming WhatsApp message -----------------------------------
    if (req.method === "POST") {
      try {
        const body = req.body;
        const db = admin.firestore();

        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            const value = change.value || {};
            const messages = value.messages || [];
            if (messages.length === 0) continue; // e.g. a status update, not a message

            for (const message of messages) {
              if (message.type !== "text") continue; // keep scope to text messages

              const from = message.from; // sender phone, no "+"
              const text = message.text?.body || "";

              const contactName =
                value.contacts && value.contacts[0]?.profile?.name;

              const leadRef = db.collection("leads").doc(from);
              const snap = await leadRef.get();

              // Defensive fallback: if a message arrives from a number we don't
              // have on file yet (e.g. someone messaged in before the ad flow
              // created them), create a minimal lead record.
              const lead = snap.exists
                ? snap.data()
                : {
                    name: contactName || "there",
                    phone: from,
                    status: "pending",
                    conversationHistory: [],
                  };

              const incomingTurn = { role: "user", text, timestamp: Date.now() };
              const updatedHistory = [...(lead.conversationHistory || []), incomingTurn];

              const updates = {
                conversationHistory: admin.firestore.FieldValue.arrayUnion(incomingTurn),
              };
              if (lead.status !== "replied") {
                updates.status = "replied";
              }
              if (!snap.exists) {
                updates.name = lead.name;
                updates.phone = from;
                updates.createdAt = admin.firestore.FieldValue.serverTimestamp();
              }

              await leadRef.set(updates, { merge: true });

              // Run the AI agent with the full conversation history as context.
              const agentResult = await runAgent({
                leadName: lead.name,
                conversationHistory: updatedHistory,
                groqApiKey: GROQ_API_KEY.value(),
              });

              await sendWhatsAppText({
                to: from,
                text: agentResult.response,
                whatsappToken: WHATSAPP_TOKEN.value(),
                phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
              });

              const assistantTurn = {
                role: "assistant",
                text: agentResult.response,
                timestamp: Date.now(),
              };

              await leadRef.update({
                conversationHistory: admin.firestore.FieldValue.arrayUnion(assistantTurn),
              });

              logger.info("whatsappWebhook: agent replied", {
                phone: from,
                propertyFound: agentResult.propertyFound,
              });
            }
          }
        }

        res.sendStatus(200);
      } catch (err) {
        logger.error("whatsappWebhook: error", err);
        // Return 200 so WhatsApp doesn't retry-storm; error is logged for debugging.
        res.sendStatus(200);
      }
      return;
    }

    res.sendStatus(405);
  }
);

module.exports = { whatsappWebhook };
