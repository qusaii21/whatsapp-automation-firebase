const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { FB_VERIFY_TOKEN, WHATSAPP_CRED_ENC_KEY } = require("./config");
const { createPhoneQueueTask } = require("./cloudTasks");
const { enqueueInboxItem, tryAcquireLock } = require("./dispatcher");
const { sendWhatsAppText } = require("./whatsapp");
const { applyRecipientStatusUpdate, CampaignError } = require("./campaigns");
const { recordWhatsAppSystemSend } = require("./metrics");
const { agencyCollection, resolveAgencyIdForWebhook } = require("./tenancy");
const { loadWhatsAppCredentials, WhatsAppNotConnectedError } = require("./whatsappCredentials");

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

// Maps a WhatsApp Cloud API status webhook value -> our recipient status.
// "sent" is deliberately NOT mapped: we already record "sent" ourselves the
// moment processCampaignRecipient.js's send call returns a message id, so
// Meta's own "sent" status webhook is just a confirmation of something we
// already know and needs no transition. Any other/future status value Meta
// might add falls through the map to `undefined` and is safely ignored
// rather than throwing.
const STATUS_TO_RECIPIENT_STATUS = {
  delivered: "delivered",
  read: "read",
  failed: "failed",
};

/**
 * LOOPHOLE FIX: WhatsApp Cloud API sends delivery/read/failure status
 * updates as separate webhook deliveries (`value.statuses`, no
 * `value.messages`) — completely distinct from inbound messages. This
 * handler used to `continue` past every one of these with the comment "e.g.
 * a status update, not a message", so a campaign recipient could never
 * progress past "sent": deliveredCount/readCount on every campaign always
 * stayed 0, and a message that failed AFTER being accepted by Meta (a very
 * common real-world case — e.g. the 24-hour customer-service window closing,
 * or the number being invalid) was silently lost instead of being recorded
 * as failed.
 *
 * Looks up which campaign recipient (if any) this status belongs to via a
 * collection-group query on `messageId` (see firestore.indexes.json — this
 * needs a COLLECTION_GROUP index on recipients.messageId) and applies the
 * matching transition through campaigns.js's existing
 * applyRecipientStatusUpdate, which already validates the transition and
 * increments the right campaign counter. A message with no matching
 * recipient (a manual message or an agent auto-reply, not a campaign send)
 * is a normal, expected no-op here — this handler is scoped to CAMPAIGN
 * message tracking only.
 */
async function handleMessageStatusUpdate(db, status) {
  const newRecipientStatus = STATUS_TO_RECIPIENT_STATUS[status?.status];
  if (!newRecipientStatus || !status?.id) return;

  let matches;
  try {
    matches = await db.collectionGroup("recipients").where("messageId", "==", status.id).limit(1).get();
  } catch (err) {
    logger.error("whatsappWebhook: recipient lookup by messageId failed", {
      messageId: status.id,
      error: err.message,
    });
    return;
  }
  if (matches.empty) return; // not a campaign-sent message

  const recipientDoc = matches.docs[0];
  const campaignId = recipientDoc.ref.parent.parent.id;
  const recipientId = recipientDoc.id;
  // recipients -> campaign doc -> campaigns collection -> agency doc: the
  // collectionGroup query above spans every agency, so the owning agencyId
  // has to be read back off the matched doc's own path, not assumed.
  const agencyId = recipientDoc.ref.parent.parent.parent.parent.id;

  const errorMessage =
    newRecipientStatus === "failed"
      ? status.errors?.[0]?.title || status.errors?.[0]?.message || "WhatsApp reported a delivery failure."
      : undefined;

  try {
    await applyRecipientStatusUpdate(db, agencyId, campaignId, recipientId, newRecipientStatus, {
      error: errorMessage,
      messageId: status.id,
    });
    logger.info("whatsappWebhook: recipient status updated", {
      campaignId,
      recipientId,
      status: newRecipientStatus,
    });
  } catch (err) {
    if (err instanceof CampaignError && err.code === "failed_precondition") {
      // Out-of-order or duplicate status webhook (Meta redelivers these) —
      // the transition just isn't legal from the recipient's current state
      // anymore. Expected, not an error.
      logger.info("whatsappWebhook: status transition not applicable, skipping", {
        campaignId,
        recipientId,
        attemptedStatus: newRecipientStatus,
        reason: err.message,
      });
      return;
    }
    logger.warn("whatsappWebhook: failed to apply recipient status update", {
      campaignId,
      recipientId,
      attemptedStatus: newRecipientStatus,
      error: err.message,
    });
  }
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
    secrets: [FB_VERIFY_TOKEN, WHATSAPP_CRED_ENC_KEY],
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
            const statuses = value.statuses || [];

            // MULTI-TENANCY: `value.metadata.phone_number_id` identifies
            // which agency's WhatsApp Business number this delivery is for
            // — resolved once per change via the same routing index
            // leadsWebhook.js uses for Facebook Page IDs. See tenancy.js.
            const agencyId = await resolveAgencyIdForWebhook(
              db,
              "waPhoneId",
              value.metadata?.phone_number_id
            );

            // Loaded once per change (a batch of messages/statuses for the
            // same phone_number_id, i.e. the same agency) rather than once
            // per message — loadWhatsAppCredentials is itself cached, but no
            // reason to hit even that cache repeatedly in a tight loop.
            // `null` here just means "this agency's non-text acks and status
            // updates will be skipped" — inbound TEXT messages are still
            // enqueued below regardless (see the FIFO inbox section), since
            // enqueueing never requires sending anything.
            let creds = null;
            try {
              creds = await loadWhatsAppCredentials(db, agencyId);
            } catch (err) {
              if (err instanceof WhatsAppNotConnectedError) {
                logger.warn("whatsappWebhook: agency has no connected WhatsApp account", { agencyId });
              } else {
                throw err;
              }
            }

            // Delivery/read/failed status updates for messages WE sent
            // (campaign sends in particular) — see handleMessageStatusUpdate
            // for why this used to be silently dropped.
            for (const status of statuses) {
              await handleMessageStatusUpdate(db, status);
            }

            if (messages.length === 0) continue; // pure status payload, nothing more to do

            const contactName = value.contacts && value.contacts[0]?.profile?.name;

            for (const message of messages) {
              const phone = message.from;

              // Atomic check-and-set: guarantees only one concurrent webhook
              // delivery for this exact message id does anything with it,
              // even if Meta redelivers within the same instant.
              const dedupeRef = agencyCollection(db, agencyId, "processedMessages").doc(message.id);
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
                  if (creds) {
                    await sendWhatsAppText({
                      to: phone,
                      text: ackText,
                      whatsappToken: creds.whatsappToken,
                      phoneNumberId: creds.phoneNumberId,
                    });
                    await recordWhatsAppSystemSend(db, agencyId);
                  }
                  await agencyCollection(db, agencyId, "leads")
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
              await enqueueInboxItem(db, agencyId, phone, {
                messageId: message.id,
                text,
                contactName,
              });

              const wonLock = await tryAcquireLock(db, agencyId, phone);
              if (wonLock) {
                await createPhoneQueueTask(phone, agencyId, projectId);
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
