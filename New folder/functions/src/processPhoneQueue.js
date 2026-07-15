const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  GROQ_API_KEY,
  PHONE_QUEUE_TIMEOUT_SECONDS,
  TIME_BUDGET_BUFFER_MS,
  MAX_ITEM_ATTEMPTS,
  RETRY_BACKOFF_BASE_SECONDS,
  RETRY_BACKOFF_MAX_SECONDS,
} = require("./config");
const { sendWhatsAppText, sendWhatsAppImage } = require("./whatsapp");
const { runAgent } = require("./agent");
const { inboxCollection, tryReleaseLock, heartbeatLock } = require("./dispatcher");
const { createPhoneQueueTask } = require("./cloudTasks");
const {
  opportunitiesCollection,
  resolveActiveOpportunity,
  summarizeOpportunityForPrompt,
  hydratePropertiesShared,
} = require("./opportunities");
const { recordAIMessageSent, recordWhatsAppSystemSend, recordLlmUsage } = require("./metrics");

/**
 * PHASE 1/4/6/9 — this is the drain loop for one phone's message queue.
 *
 * Invoked by a Cloud Task (created either by whatsappWebhook, when it wins
 * the per-phone dispatcher lock, or by this function itself when chaining).
 * Only one execution is ever active per phone (enforced by the lock in
 * dispatcher.js), and it processes `leads/{phone}/inbox` strictly oldest-
 * first, one item fully to completion before looking at the next — this is
 * what makes "Hi" / "Need 2 BHK" / "Budget 80 lakh" / "Baner" arriving
 * within the same second behave identically to them arriving one at a time
 * with the bot replying between each.
 *
 * STATE MACHINE per inbox item (Phase 4):
 *   pending -> processing -> [deleted = completed]
 *                          -> failed (attempts++, re-chained with backoff)
 *                          -> dead_letter (moved out of the active queue,
 *                             lead flagged for human follow-up) after
 *                             MAX_ITEM_ATTEMPTS consecutive failures
 *
 * `invoker: "private"` — only Cloud Tasks (via its OIDC token) can call this.
 */
const processPhoneQueue = onRequest(
  {
    secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, GROQ_API_KEY],
    region: "us-central1",
    invoker: "private",
    timeoutSeconds: PHONE_QUEUE_TIMEOUT_SECONDS,
  },
  async (req, res) => {
    const startedAt = Date.now();
    const { phone } = req.body || {};
    if (!phone) {
      res.status(400).send("Missing phone in task payload");
      return;
    }

    const db = admin.firestore();
    const projectId = process.env.GCLOUD_PROJECT;
    let itemsProcessedThisInvocation = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // --- Time-budget check (Phase 1 continuation safety) ---
        // If we're close to this invocation's own timeout, stop picking up
        // new work and hand off to a fresh Cloud Task instead of risking a
        // hard kill mid-LLM-call or mid-WhatsApp-send, which would leave an
        // item claimed as "processing" with no clean recovery until the
        // dispatcher lock's staleness window expires. The lock is NOT
        // released here — the chained task continues holding it.
        if (Date.now() - startedAt > PHONE_QUEUE_TIMEOUT_SECONDS * 1000 - TIME_BUDGET_BUFFER_MS) {
          logger.info("processPhoneQueue: time budget exhausted, chaining", {
            phone,
            itemsProcessedThisInvocation,
          });
          await createPhoneQueueTask(phone, projectId);
          res.sendStatus(200);
          return;
        }

        const snap = await inboxCollection(db, phone).orderBy("receivedAt").limit(1).get();

        if (snap.empty) {
          const { released } = await tryReleaseLock(db, phone);
          if (released) {
            logger.info("processPhoneQueue: inbox empty, lock released, done", {
              phone,
              itemsProcessedThisInvocation,
            });
            res.sendStatus(200);
            return;
          }
          // A new item slipped in between "empty" and the release attempt —
          // loop again and pick it up instead of exiting with the lock held
          // by nobody actively draining it.
          continue;
        }

        const itemDoc = snap.docs[0];
        const messageId = itemDoc.id;
        const item = itemDoc.data();

        const outcome = await processOneMessage({ db, phone, messageId, item });
        itemsProcessedThisInvocation += 1;

        if (outcome.stopDraining) {
          // A retry was already chained (with backoff) by processOneMessage
          // itself for this specific failed item. Return 200, not 500: we
          // do NOT want Cloud Tasks' own automatic retry-on-error to ALSO
          // fire for this same task delivery — that would race our manual
          // backoff-chained task and give this phone two active processors
          // at once, which is exactly what Phase 1's lock exists to prevent.
          // The lock is deliberately left held; the chained task continues
          // holding it.
          logger.info("processPhoneQueue: stopping drain after chained retry", {
            phone,
            messageId,
            itemsProcessedThisInvocation,
          });
          res.sendStatus(200);
          return;
        }

        await heartbeatLock(db, phone);
      }
    } catch (err) {
      // This is a genuinely unexpected failure OUTSIDE processOneMessage's
      // own handling (e.g. the inbox query itself, or tryReleaseLock). This
      // path has NOT already scheduled its own retry, so returning 500 here
      // (letting Cloud Tasks retry this exact task per the queue's own
      // config) is correct and doesn't risk a double-processor race.
      // Do not release the lock — better to let the staleness window in
      // dispatcher.js recover it than to release while state is unknown.
      logger.error("processPhoneQueue: unexpected top-level error", {
        phone,
        error: err.message,
        stack: err.stack,
      });
      res.sendStatus(500);
    }
  }
);

/**
 * Processes exactly one inbox item to completion: runs the agent, sends the
 * WhatsApp reply (+ property photo if matched), persists everything to the
 * lead doc, and removes the item from the inbox. On failure, applies the
 * Phase 4 retry/dead-letter state machine instead of throwing back up
 * (throwing would abort the whole drain loop for every OTHER queued message
 * from this phone too, which is exactly the "one bad message wedges the
 * conversation forever" failure mode Phase 4 exists to prevent).
 */
async function processOneMessage({ db, phone, messageId, item }) {
  const turnStartedAt = Date.now();
  const msgRef = db.collection("processedMessages").doc(messageId);
  const leadRef = db.collection("leads").doc(phone);
  const itemRef = inboxCollection(db, phone).doc(messageId);

  try {
    await itemRef.set({ status: "processing" }, { merge: true });

    const msgSnap = await msgRef.get();
    const cached = msgSnap.exists ? msgSnap.data() : null;

    if (cached?.completed) {
      // Already fully handled by a previous (crashed-after-finishing)
      // attempt — just clean up the leftover inbox item and move on.
      await itemRef.delete();
      logger.info("processPhoneQueue: item already completed previously, cleaning up", {
        phone,
        messageId,
      });
      return { stopDraining: false };
    }

    const snap = await leadRef.get();
    const lead = snap.exists
      ? snap.data()
      : {
          name: item.contactName || "there",
          phone,
          status: "pending",
          conversationHistory: [],
        };

    const incomingTurn =
      cached?.incomingTurn || { role: "user", text: item.text, timestamp: Date.now() };
    if (!cached?.incomingTurn) {
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

    // --- HUMAN AGENT MODE -------------------------------------------------
    // `lead.mode === "human"` means a human agent has taken over this
    // conversation from the CRM (see sendManualMessage.js + the AI/Human
    // toggle in CustomerPanel.jsx). The incoming message has ALREADY been
    // synced into conversationHistory and lastMessageAt via baseUpdates just
    // above, so the CRM thread stays fully live — but the AI must not run,
    // must not call the LLM, and must not send anything back. We skip
    // straight to marking this inbox item complete so the drain loop moves
    // on to any next queued message for this phone without ever touching
    // runAgent/sendWhatsAppText/opportunities below.
    //
    // Missing `mode` (every lead created before this feature shipped, or any
    // lead that has never been toggled) is treated as "ai" — the default —
    // so existing conversations keep working exactly as before.
    if (lead.mode === "human") {
      await msgRef.set(
        {
          status: "completed",
          completed: true,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          skippedForHumanMode: true,
        },
        { merge: true }
      );
      await itemRef.delete();
      logger.info("processPhoneQueue: human mode active, AI reply skipped", {
        conversationId: phone,
        phone,
        messageId,
        processingState: "completed_human_mode",
      });
      return { stopDraining: false };
    }

    const shownProperties = lead.shownProperties || [];

    // CUSTOMER -> OPPORTUNITIES: fetch once, up front, and reuse for both the
    // agent's context (below) and opportunity resolution (after the agent
    // runs) — see opportunities.js for why this doc exists and how the
    // shownProperty exclusion list is scoped to it rather than the whole
    // customer's lifetime history.
    const oppCol = opportunitiesCollection(db, phone);
    let activeOpportunitySnap = null;
    if (lead.activeOpportunityId) {
      activeOpportunitySnap = await oppCol.doc(lead.activeOpportunityId).get();
    }
    const activeOpportunityData =
      activeOpportunitySnap && activeOpportunitySnap.exists ? activeOpportunitySnap.data() : null;

    // Before this customer has any opportunity doc yet (brand new lead, or a
    // lead from before this feature shipped), fall back to the lead-level
    // fields so nothing about the chatbot's "don't re-show a property"
    // behaviour regresses.
    const opportunityShownPropertyIds = activeOpportunityData
      ? activeOpportunityData.shownPropertyIds || []
      : lead.shownPropertyIds || [];
    const opportunityShownProperties = activeOpportunityData
      ? await hydratePropertiesShared(db, activeOpportunityData.propertiesShared)
      : shownProperties;

    let agentResult = cached?.agentResult || null;
    if (!agentResult) {
      agentResult = await runAgent({
        leadName: lead.name,
        conversationHistory: updatedHistory,
        shownPropertyIds: opportunityShownPropertyIds,
        shownProperties: opportunityShownProperties,
        groqApiKey: GROQ_API_KEY.value(),
        activeOpportunitySummary: summarizeOpportunityForPrompt(activeOpportunityData),
      });
      await msgRef.set({ agentResult }, { merge: true });
      // METRICS: guarded by the same `if (!agentResult)` that makes runAgent
      // itself exactly-once for this inbox item across Cloud Tasks retries —
      // a retry after this point sees `cached.agentResult` and never
      // re-enters this block, so this turn's Groq token usage/cost is never
      // double-counted. See agent.js's `_meta.llmUsage` and metrics.js's
      // recordLlmUsage.
      await recordLlmUsage(db, agentResult._meta?.llmUsage);
    }

    if (!cached?.textSent) {
      await sendWhatsAppText({
        to: phone,
        text: agentResult.response,
        whatsappToken: WHATSAPP_TOKEN.value(),
        phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
      });
      await msgRef.set({ textSent: true }, { merge: true });
      // METRICS: gated by the same `cached?.textSent` check that already
      // makes the send itself exactly-once across retries/redeliveries of
      // this messageId — a retry after this point sees `textSent: true` and
      // never re-enters this block.
      await recordAIMessageSent(db);
    }

    const assistantTurn =
      cached?.assistantTurn || {
        role: "assistant",
        text: agentResult.response,
        timestamp: Date.now(),
        // Carried onto the turn itself (not just the lead doc) so the CRM
        // chat view can render a rich property card bubble on the exact
        // turn a listing was presented, instead of only on the latest one.
        ...(agentResult.propertyFound && agentResult.matchedPropertyId
          ? { matchedPropertyId: agentResult.matchedPropertyId }
          : {}),
      };
    if (!cached?.assistantTurn) {
      await msgRef.set({ assistantTurn }, { merge: true });
    }

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
    // PHASE 2 - deterministic routing for booking requests: this flag comes
    // from the classified intent (see agent.js), not from the model's reply
    // text, so a human/CRM view of "who asked to book a visit" is reliable
    // even if the model's phrasing is ambiguous.
    if (agentResult.visitRequested) {
      extractedUpdates.visitRequested = true;
      if (lead.status !== "qualified") {
        extractedUpdates.status = "visit_requested";
      }
    }
    if (agentResult.referencedPropertyIds && agentResult.referencedPropertyIds.length > 0) {
      extractedUpdates.lastReferencedPropertyIds = agentResult.referencedPropertyIds;
    }
    if (agentResult.conversationSummary) {
      extractedUpdates.conversationSummary = agentResult.conversationSummary;
    }
    if (agentResult.nextSuggestedAction) {
      extractedUpdates.nextSuggestedAction = agentResult.nextSuggestedAction;
    }
    if (agentResult.interestLevel) {
      extractedUpdates.interestLevel = agentResult.interestLevel;
    }
    if (agentResult.financingRequired !== null && agentResult.financingRequired !== undefined) {
      extractedUpdates.financingRequired = agentResult.financingRequired;
    }
    if (agentResult._meta?.intent) {
      extractedUpdates.lastIntent = agentResult._meta.intent;
    }

    // CUSTOMER -> OPPORTUNITIES: decide (idempotently — cached like every
    // other side effect in this function) whether this turn continues the
    // customer's active opportunity or starts a brand-new one, THEN build
    // that opportunity's own field updates below. This never touches the
    // lead-level extractedUpdates fields above, which keep working exactly
    // as before for anything still reading `leads/{phone}` directly.
    let opportunityId = cached?.opportunityId || null;
    let opportunityIsNew = false;
    let opportunityData = activeOpportunityData;
    if (!opportunityId) {
      const resolution = await resolveActiveOpportunity({
        db,
        phone,
        activeOpportunityId: lead.activeOpportunityId || null,
        activeSnap: activeOpportunitySnap,
        lead,
        agentPropertyType: agentResult.propertyType,
        agentListingType: agentResult.listingType,
        agentPurpose: agentResult.purpose,
        incomingMessageText: incomingTurn.text,
      });
      opportunityId = resolution.id;
      opportunityIsNew = resolution.isNew;
      opportunityData = resolution.data;
      await msgRef.set({ opportunityId }, { merge: true });
    }
    extractedUpdates.activeOpportunityId = opportunityId;

    const oppUpdates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (agentResult.budget !== null && agentResult.budget !== undefined) {
      oppUpdates.budget = agentResult.budget;
    }
    if (agentResult.bedrooms !== null && agentResult.bedrooms !== undefined) {
      oppUpdates["requirements.bedrooms"] = agentResult.bedrooms;
    }
    if (agentResult.preferredLocation) {
      oppUpdates.preferredLocations = admin.firestore.FieldValue.arrayUnion(agentResult.preferredLocation);
    }
    if (agentResult.propertyType) {
      oppUpdates.propertyType = agentResult.propertyType;
    }
    if (agentResult.listingType) {
      oppUpdates.listingType = agentResult.listingType;
    }
    if (agentResult.timeline) {
      oppUpdates.timeline = agentResult.timeline;
    }
    if (agentResult.purpose) {
      oppUpdates.purpose = agentResult.purpose;
    }
    if (agentResult.conversationSummary) {
      oppUpdates.aiSummary = agentResult.conversationSummary;
    }
    if (agentResult.nextSuggestedAction) {
      oppUpdates.nextSuggestedAction = agentResult.nextSuggestedAction;
    }
    if (agentResult.interestLevel) {
      oppUpdates.interestLevel = agentResult.interestLevel;
    }
    if (!opportunityIsNew && opportunityData?.status === "new") {
      oppUpdates.status = "active";
    }
    if (agentResult.visitRequested) {
      oppUpdates.visitRequests = admin.firestore.FieldValue.arrayUnion({
        requestedAt: Date.now(),
        note: agentResult.response,
      });
      if (opportunityData?.status !== "qualified") {
        oppUpdates.status = "visit_requested";
      }
    }
    if (agentResult.conversationEnded) {
      oppUpdates.status = "qualified";
    }

    if (agentResult.propertyFound && agentResult.matchedPropertyId) {
      try {
        const propSnap = await db.collection("properties").doc(agentResult.matchedPropertyId).get();
        if (propSnap.exists) {
          const property = propSnap.data();
          extractedUpdates.lastMatchedPropertyId = agentResult.matchedPropertyId;
          extractedUpdates.shownPropertyIds = admin.firestore.FieldValue.arrayUnion(
            agentResult.matchedPropertyId
          );
          const alreadyInList = shownProperties.some((p) => p.id === agentResult.matchedPropertyId);
          if (!alreadyInList) {
            extractedUpdates.shownProperties = admin.firestore.FieldValue.arrayUnion({
              id: agentResult.matchedPropertyId,
              ...property,
            });
          }
          oppUpdates.shownPropertyIds = admin.firestore.FieldValue.arrayUnion(agentResult.matchedPropertyId);
          const alreadyInOpportunity = (opportunityData?.propertiesShared || []).some(
            (p) => (p.propertyId || p.id) === agentResult.matchedPropertyId
          );
          if (!alreadyInOpportunity) {
            // Lightweight reference only — properties/{propertyId} is the
            // source of truth for everything else (project, builder,
            // amenities, images, etc.). See opportunities.js header comment.
            oppUpdates.propertiesShared = admin.firestore.FieldValue.arrayUnion({
              propertyId: agentResult.matchedPropertyId,
              shownAt: Date.now(),
              reaction: null,
              visitRequested: false,
              status: "shown",
              priceWhenShown: property.price ?? null,
            });
          }
          const primaryImage = Array.isArray(property.images) ? property.images[0] : property.imageUrl;
          if (primaryImage && !cached?.imageSent) {
            const priceLabel =
              property.listingType === "Rent"
                ? `Rs. ${property.price ?? "?"}/month`
                : `Rs. ${property.price ?? "?"}`;
            const caption =
              `${property.projectName || "Property"} — ${property.bedrooms ?? "?"} BHK, ` +
              `${priceLabel}, ${property.locality || property.location || ""}`.trim();
            await sendWhatsAppImage({
              to: phone,
              imageUrl: primaryImage,
              caption,
              whatsappToken: WHATSAPP_TOKEN.value(),
              phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
            });
            await msgRef.set({ imageSent: true }, { merge: true });
            // METRICS: a second, distinct WhatsApp Cloud API send for this
            // same turn — counted in the overall WhatsApp total but not
            // double-counted as a second "AI message" (see metrics.js).
            await recordWhatsAppSystemSend(db);
          }
        }
      } catch (imgErr) {
        // Don't fail the whole turn just because the photo send failed —
        // the text reply already went out.
        logger.error("processPhoneQueue: property image send failed", {
          phone,
          messageId,
          error: imgErr.message,
        });
      }
    }

    await leadRef.set(extractedUpdates, { merge: true });
    await oppCol.doc(opportunityId).set(oppUpdates, { merge: true });
    await msgRef.set(
      { status: "completed", completed: true, completedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    await itemRef.delete();

    // PHASE 9 - structured, single-line-per-turn observability. Every field
    // a debugger would need without reading code: which conversation, which
    // message, what the classifier decided, whether search ran, what it
    // returned, what got shown, how long it took, whether this was a retry.
    logger.info("processPhoneQueue: turn complete", {
      conversationId: phone,
      phone,
      messageId,
      opportunityId,
      opportunityIsNew,
      intent: agentResult._meta?.intent,
      searchExecuted: agentResult._meta?.toolCalled || false,
      searchResultCount: agentResult._meta?.searchResultCount ?? null,
      zeroResultShortCircuit: agentResult._meta?.zeroResultShortCircuit || false,
      matchedPropertyId: agentResult.matchedPropertyId,
      referencedPropertyIds: agentResult.referencedPropertyIds,
      propertyFound: agentResult.propertyFound,
      conversationEnded: agentResult.conversationEnded,
      visitRequested: agentResult.visitRequested,
      attempts: (item.attempts || 0) + 1,
      latencyMs: Date.now() - turnStartedAt,
      processingState: "completed",
    });
  } catch (err) {
    const { stopDraining } = await handleItemFailure({
      db,
      phone,
      messageId,
      item,
      itemRef,
      err,
      turnStartedAt,
    });
    return { stopDraining };
  }

  return { stopDraining: false };
}

/**
 * PHASE 4/6 — retry/dead-letter state machine for a single failed item.
 * Never throws back up to the drain loop: a single permanently-broken
 * message must not be able to wedge every other queued message from the
 * same phone, and must not silently vanish either.
 */
async function handleItemFailure({ db, phone, messageId, item, itemRef, err, turnStartedAt }) {
  const attempts = (item.attempts || 0) + 1;
  const projectId = process.env.GCLOUD_PROJECT;

  logger.error("processPhoneQueue: turn failed", {
    conversationId: phone,
    phone,
    messageId,
    attempts,
    latencyMs: Date.now() - turnStartedAt,
    processingState: attempts >= MAX_ITEM_ATTEMPTS ? "dead_letter" : "retrying",
    error: err.message,
    stack: err.stack,
  });

  if (attempts >= MAX_ITEM_ATTEMPTS) {
    // Move it out of the active queue so it can never block subsequent
    // messages again, but keep it (in deadLetters, not deleted) so it's
    // visible for a human to look at, and flag the lead itself.
    const batch = db.batch();
    batch.set(db.collection("leads").doc(phone).collection("deadLetters").doc(messageId), {
      ...item,
      attempts,
      lastError: err.message,
      deadLetteredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(
      db.collection("leads").doc(phone),
      { needsHumanAttention: true, lastDeadLetterAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    batch.delete(itemRef);
    await batch.commit();
    // Do NOT stop the drain loop — the calling loop will simply query the
    // inbox again, and since this item is now gone, it'll pick up whatever
    // is next for this phone.
    return { stopDraining: false };
  }

  // Not dead yet: record the failure on the item and hand off to a fresh
  // Cloud Task with exponential backoff, rather than retrying in a tight
  // loop inside this same invocation (which would hammer whichever
  // dependency just failed and burn the time budget on a problem that
  // needs time to clear, not more attempts per second).
  await itemRef.set(
    { status: "failed", attempts, lastError: err.message },
    { merge: true }
  );
  const backoffSeconds = Math.min(
    RETRY_BACKOFF_BASE_SECONDS * 2 ** (attempts - 1),
    RETRY_BACKOFF_MAX_SECONDS
  );
  await createPhoneQueueTask(phone, projectId, backoffSeconds);
  // Tell the caller to stop draining and return 200 (see the loop's
  // handling of stopDraining for why this must NOT be surfaced as a 500).
  return { stopDraining: true };
}

module.exports = { processPhoneQueue };
