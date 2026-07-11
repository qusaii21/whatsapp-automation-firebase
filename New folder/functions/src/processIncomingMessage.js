const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, GROQ_API_KEY } = require("./config");
const { sendWhatsAppText, sendWhatsAppImage } = require("./whatsapp");
const { runAgent } = require("./agent");

// Longer than this function's own timeoutSeconds (120s) plus generous
// headroom for Firestore/network jitter. Used to detect a "processing" claim
// that was abandoned by a crashed/timed-out execution, so a legitimate Cloud
// Tasks retry can still get through instead of being skipped forever.
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Does the actual work for one incoming WhatsApp message: updates the lead
 * record, runs the AI agent, sends the reply (and a property photo if one
 * was matched), and persists everything the agent extracted so the CRM can
 * show it. Invoked asynchronously via Cloud Tasks from `whatsappWebhook`,
 * which only enqueues — this keeps the webhook itself fast enough that Meta
 * never has a reason to redeliver the same event.
 *
 * `invoker: "private"` — like followupCheck, only Cloud Tasks (via its OIDC
 * token) can call this; it is not reachable from the open internet.
 *
 * IDEMPOTENCY DESIGN (this is the fix for the "bot repeats messages" bug):
 * Cloud Tasks guarantees *at-least-once* delivery — the same task can be
 * (re)executed after it already succeeded (e.g. the function ran past its
 * deadline, or the 200 ack was lost in transit even though the work
 * finished). The previous version only recorded completion at the very end,
 * *after* the WhatsApp message had already been sent, using a plain
 * get()-then-later-set() check with no atomicity. That leaves two ways to
 * send a duplicate WhatsApp message:
 *   1. Two dispatches of the same task run concurrently — both read
 *      "not completed yet" before either has written anything back.
 *   2. One dispatch times out / crashes AFTER sendWhatsAppText() succeeded
 *      but BEFORE the "completed" flag was written — Cloud Tasks retries,
 *      the flag is still missing, so the whole turn (including the send)
 *      runs again.
 * It also independently duplicated conversationHistory entries on every
 * retry, because the user/assistant turn objects were built fresh (with a
 * new Date.now() timestamp) each execution, so Firestore's arrayUnion — which
 * dedupes by exact object equality — never recognized them as the same turn.
 *
 * The fix: (a) atomically CLAIM the message id via a transaction before
 * doing any work, so only one execution can be "in flight" at a time, with a
 * staleness check so a genuinely crashed claim can still be retried; (b)
 * persist the user/assistant turn objects and the agent's result on the
 * processedMessages doc as soon as they're known, and reuse them on any
 * retry instead of regenerating (keeps arrayUnion idempotent and avoids
 * re-billing the LLM call); (c) record "textSent" / "imageSent" flags
 * immediately after each WhatsApp API call succeeds, and check them before
 * ever calling sendWhatsAppText/sendWhatsAppImage again, so a retry that
 * reaches this function after the message already went out will skip
 * sending and just finish the remaining (idempotent) bookkeeping.
 */
const processIncomingMessage = onRequest(
  {
    secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, GROQ_API_KEY],
    region: "us-central1",
    invoker: "private",
    timeoutSeconds: 120,
  },
  async (req, res) => {
    try {
      const { phone, text, contactName, messageId } = req.body || {};
      if (!phone || !text) {
        res.status(400).send("Missing phone or text in task payload");
        return;
      }

      const db = admin.firestore();
      const msgRef = messageId ? db.collection("processedMessages").doc(messageId) : null;

      // --- Atomic claim -----------------------------------------------------
      let cached = null;
      if (msgRef) {
        const claim = await db.runTransaction(async (tx) => {
          const snap = await tx.get(msgRef);
          const data = snap.exists ? snap.data() : null;

          if (data?.completed) {
            return { proceed: false, reason: "completed" };
          }

          const claimedAtMs = data?.claimedAt?.toMillis ? data.claimedAt.toMillis() : 0;
          const isStale = Date.now() - claimedAtMs > STALE_CLAIM_MS;
          if (data?.status === "processing" && !isStale) {
            // Another execution (concurrent dispatch) is actively handling
            // this exact message right now — let it finish, don't duplicate.
            return { proceed: false, reason: "in_flight" };
          }

          tx.set(
            msgRef,
            {
              status: "processing",
              claimedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return { proceed: true, data };
        });

        if (!claim.proceed) {
          logger.info("processIncomingMessage: skipping duplicate/concurrent delivery", {
            messageId,
            reason: claim.reason,
          });
          res.sendStatus(200);
          return;
        }
        cached = claim.data;
      }

      const db2 = db; // (same instance; kept for readability below)
      const leadRef = db2.collection("leads").doc(phone);
      const snap = await leadRef.get();

      const lead = snap.exists
        ? snap.data()
        : {
            name: contactName || "there",
            phone,
            status: "pending",
            conversationHistory: [],
          };

      // Reuse the exact same turn object across retries (instead of
      // generating a fresh Date.now() each time) so Firestore's arrayUnion
      // correctly treats a retry as a no-op rather than appending a
      // near-duplicate history entry.
      const incomingTurn =
        cached?.incomingTurn || { role: "user", text, timestamp: Date.now() };

      if (!cached?.incomingTurn && msgRef) {
        await msgRef.set({ incomingTurn }, { merge: true });
      }

      const updatedHistory = [...(lead.conversationHistory || []), incomingTurn];

      const baseUpdates = {
        conversationHistory: admin.firestore.FieldValue.arrayUnion(incomingTurn),
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (lead.status !== "replied" && lead.status !== "qualified") {
        baseUpdates.status = "replied";
      }
      if (!snap.exists) {
        baseUpdates.name = lead.name;
        baseUpdates.phone = phone;
        baseUpdates.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }
      await leadRef.set(baseUpdates, { merge: true });

      // Run the AI agent with the full conversation history as context, and
      // tell it which properties this lead has already been shown so it
      // never repeats one. On a retry where the agent already ran, reuse its
      // stored result instead of calling the LLM (and paying for it) again.
      let agentResult = cached?.agentResult || null;
      if (!agentResult) {
        agentResult = await runAgent({
          leadName: lead.name,
          conversationHistory: updatedHistory,
          shownPropertyIds: lead.shownPropertyIds || [],
          groqApiKey: GROQ_API_KEY.value(),
        });
        if (msgRef) {
          await msgRef.set({ agentResult }, { merge: true });
        }
      }

      // --- Send the text reply, but only if this exact message hasn't
      // already had its reply sent by a prior (crashed/timed-out) attempt.
      if (!cached?.textSent) {
        await sendWhatsAppText({
          to: phone,
          text: agentResult.response,
          whatsappToken: WHATSAPP_TOKEN.value(),
          phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
        });
        if (msgRef) {
          await msgRef.set({ textSent: true }, { merge: true });
        }
      } else {
        logger.info("processIncomingMessage: text already sent on a prior attempt, skipping resend", {
          messageId,
        });
      }

      const assistantTurn =
        cached?.assistantTurn || {
          role: "assistant",
          text: agentResult.response,
          timestamp: Date.now(),
        };
      if (!cached?.assistantTurn && msgRef) {
        await msgRef.set({ assistantTurn }, { merge: true });
      }

      // Persist everything the agent extracted so the CRM can show it,
      // without ever overwriting a known value with a new null.
      const extractedUpdates = {
        conversationHistory: admin.firestore.FieldValue.arrayUnion(assistantTurn),
      };
      if (agentResult.budget !== null && agentResult.budget !== undefined) {
        extractedUpdates.extractedBudget = agentResult.budget;
      }
      if (agentResult.bedrooms !== null && agentResult.bedrooms !== undefined) {
        extractedUpdates.extractedBedrooms = agentResult.bedrooms;
      }
      if (agentResult.preferredLocation) {
        extractedUpdates.preferredLocation = agentResult.preferredLocation;
      }
      if (agentResult.timeline) {
        extractedUpdates.timeline = agentResult.timeline;
      }
      if (agentResult.purpose) {
        extractedUpdates.purpose = agentResult.purpose;
      }
      extractedUpdates.propertyFound = agentResult.propertyFound;
      extractedUpdates.conversationEnded = agentResult.conversationEnded;
      if (agentResult.conversationEnded) {
        extractedUpdates.status = "qualified";
      }

      // If a specific property was presented, send its photo too (again,
      // guarded so a retry never sends it twice) and record which one was
      // last shown to this lead.
      if (agentResult.propertyFound && agentResult.matchedPropertyId) {
        try {
          const propSnap = await db2
            .collection("properties")
            .doc(agentResult.matchedPropertyId)
            .get();
          if (propSnap.exists) {
            const property = propSnap.data();
            extractedUpdates.lastMatchedPropertyId = agentResult.matchedPropertyId;
            extractedUpdates.shownPropertyIds = admin.firestore.FieldValue.arrayUnion(
              agentResult.matchedPropertyId
            );
            if (property.imageUrl && !cached?.imageSent) {
              const caption =
                `${property.title || "Property"} — ${property.bedrooms ?? "?"} BHK, ` +
                `budget ${property.budget ?? "?"}, ${property.location || ""}`.trim();
              await sendWhatsAppImage({
                to: phone,
                imageUrl: property.imageUrl,
                caption,
                whatsappToken: WHATSAPP_TOKEN.value(),
                phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
              });
              if (msgRef) {
                await msgRef.set({ imageSent: true }, { merge: true });
              }
            }
          }
        } catch (imgErr) {
          // Don't fail the whole turn just because the photo send failed —
          // the text reply already went out.
          logger.error("processIncomingMessage: property image send failed", imgErr);
        }
      }

      await leadRef.set(extractedUpdates, { merge: true });

      if (msgRef) {
        await msgRef.set(
          { status: "completed", completed: true, completedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      }

      logger.info("processIncomingMessage: agent replied", {
        phone,
        propertyFound: agentResult.propertyFound,
        conversationEnded: agentResult.conversationEnded,
      });

      res.sendStatus(200);
    } catch (err) {
      logger.error("processIncomingMessage: error", err);
      res.sendStatus(500); // lets Cloud Tasks retry per the queue's retry config
    }
  }
);

module.exports = { processIncomingMessage };
