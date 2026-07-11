const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { FB_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID } = require("./config");
const { createPhoneQueueTask } = require("./cloudTasks");
const { enqueueInboxItem, tryAcquireLock } = require("./dispatcher");
const { sendWhatsAppText } = require("./whatsapp");

// PHASE 7 — non-text inputs must never be silently dropped. These are sent
// directly from the webhook (no LLM call — this is a deterministic
// acknowledgement, not a language-generation task, so there's no reason to
// pay for/wait on a Groq round trip for it) and a short synthetic entry is
// appended to conversationHistory so the CRM and future agent turns aren't
// missing a "gap" where the user clearly said something.
const NON_TEXT_ACKS = {
  audio: "I currently support text messages only — could you type that out for me?",
  voice: "I currently support text messages only — could you type that out for me?",
  image: "I can currently help only through text — happy to answer if you describe what's in the image!",
  document: "I can currently help only through text — could you summarize what's in the document?",
  sticker: "👍 Got it! Let me know if you have any questions about properties.",
  video: "I currently support text messages only — could you type that out for me?",
  location: "Thanks for sharing your location! Could you also tell me your preferred area in words?",
  contacts: "Thanks! Is there something specific I can help you find?",
  unknown: "Sorry, I didn't quite catch that — could you send it as a text message?",
};

function conversationHistoryPlaceholder(type) {
  const labels = {
    audio: "[voice message]",
    voice: "[voice message]",
    image: "[image]",
    document: "[document]",
    sticker: "[sticker]",
    video: "[video]",
    location: "[shared location]",
    contacts: "[shared contact]",
  };
  return labels[type] || `[${type} message]`;
}

/**
 * This function is deliberately THIN. Meta expects a 200 response within a
 * few seconds or it assumes delivery failed and resends the same webhook
 * event. So this handler does the minimum possible work (verify + atomically
 * dedupe + enqueue) and returns immediately.
 *
 * PHASE 1 CHANGE: this no longer creates one Cloud Task per message that
 * calls the agent pipeline directly. It appends the message to the phone's
 * FIFO inbox and, only if it wins the per-phone dispatcher lock, enqueues a
 * single drain task (processPhoneQueue). See dispatcher.js for the full
 * rationale — this is what makes "4 rapid messages from one lead" safe.
 */
const whatsappWebhook = onRequest(
  {
    secrets: [FB_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID],
    region: "us-central1",
  },
  async (req, res) => {
    // --- GET: WhatsApp's webhook verification handshake ---
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

    // --- POST: incoming WhatsApp message ---
    if (req.method === "POST") {
      try {
        const body = req.body;
        const db = admin.firestore();
        const projectId = process.env.GCLOUD_PROJECT;

        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            const value = change.value || {};
            const messages = value.messages || [];
            if (messages.length === 0) continue; // e.g. a status update, not a message

            const contactName = value.contacts && value.contacts[0]?.profile?.name;

            for (const message of messages) {
              const phone = message.from;

              // Atomic check-and-set: guarantees only one concurrent webhook
              // delivery for this exact message id does anything with it,
              // even if Meta redelivers within the same instant.
              const dedupeRef = db.collection("processedMessages").doc(message.id);
              const alreadyEnqueued = await db.runTransaction(async (tx) => {
                const snap = await tx.get(dedupeRef);
                if (snap.exists) return true;
                tx.set(dedupeRef, {
                  enqueuedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                return false;
              });

              if (alreadyEnqueued) {
                logger.info("whatsappWebhook: duplicate delivery, skipping", {
                  messageId: message.id,
                  phone,
                });
                continue;
              }

              // --- PHASE 7: non-text messages get a deterministic ack, not
              // silence, and don't enter the agent pipeline at all. ---
              if (message.type !== "text") {
                const ackText = NON_TEXT_ACKS[message.type] || NON_TEXT_ACKS.unknown;
                try {
                  await sendWhatsAppText({
                    to: phone,
                    text: ackText,
                    whatsappToken: WHATSAPP_TOKEN.value(),
                    phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
                  });
                  await db
                    .collection("leads")
                    .doc(phone)
                    .set(
                      {
                        name: contactName || "there",
                        phone,
                        conversationHistory: admin.firestore.FieldValue.arrayUnion({
                          role: "user",
                          text: conversationHistoryPlaceholder(message.type),
                          timestamp: Date.now(),
                        }),
                        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                      },
                      { merge: true }
                    );
                } catch (ackErr) {
                  logger.error("whatsappWebhook: non-text ack failed", ackErr);
                }
                logger.info("whatsappWebhook: acknowledged non-text message", {
                  phone,
                  type: message.type,
                  messageId: message.id,
                });
                continue;
              }

              // Empty-body text messages are rare (mostly malformed client
              // sends) but genuinely have nothing to act on — handle here,
              // deterministically, rather than letting an empty string reach
              // the queue and get a 400 from processPhoneQueue with no clean
              // retry semantics.
              const text = message.text?.body || "";
              if (!text.trim()) {
                logger.info("whatsappWebhook: empty text body, skipping", {
                  phone,
                  messageId: message.id,
                });
                continue;
              }

              // --- Text message: append to the phone's FIFO inbox ---
              await enqueueInboxItem(db, phone, {
                messageId: message.id,
                text,
                contactName,
              });

              const wonLock = await tryAcquireLock(db, phone);
              if (wonLock) {
                await createPhoneQueueTask(phone, projectId);
                logger.info("whatsappWebhook: acquired dispatcher lock, enqueued drain", {
                  phone,
                  messageId: message.id,
                });
              } else {
                logger.info("whatsappWebhook: dispatcher already active, appended to inbox", {
                  phone,
                  messageId: message.id,
                });
              }
            }
          }
        }

        res.sendStatus(200);
      } catch (err) {
        logger.error("whatsappWebhook: error", err);
        res.sendStatus(200); // still ack so Meta doesn't retry-storm us
      }
      return;
    }

    res.sendStatus(405);
  }
);

module.exports = { whatsappWebhook };
