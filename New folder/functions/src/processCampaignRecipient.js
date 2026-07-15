const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  CAMPAIGN_RECIPIENT_TIMEOUT_SECONDS,
  CAMPAIGN_RECIPIENT_SEND_CLAIM_STALE_MS,
  CAMPAIGN_RECIPIENT_MAX_ATTEMPTS,
} = require("./config");
const { sendWhatsAppTemplate } = require("./whatsapp");
const {
  campaignsCollection,
  recipientsCollection,
  updateCampaignStatus,
  completeCampaignIfFinished,
  CampaignError,
} = require("./campaigns");
const { assertTemplateApprovedForCampaign, TemplateError } = require("./whatsappTemplates");
const { recordWhatsAppSentInTx, recordWhatsAppFailedInTx } = require("./metrics");

/**
 * CAMPAIGN RECIPIENT WORKER
 * ---------------------------------------------------------------------------
 * The endpoint campaignQueue.js's Cloud Tasks already point at
 * (`processCampaignRecipient`). Does the one thing campaignQueue.js
 * deliberately left undone: actually calls the WhatsApp Cloud API for a
 * single queued recipient, then records the outcome.
 *
 * INPUT: `{ campaignId, recipientId }` only (see cloudTasks.js's
 * buildTaskPayload for the full task body — this worker deliberately re-reads
 * campaign/recipient/template fresh from Firestore instead of trusting the
 * task's snapshotted fields, since a large campaign's tasks can sit in the
 * queue for a while and a template's approval status, or the campaign's
 * paused/cancelled state, can change out from under a stale snapshot).
 *
 * FLOW:
 *   1. Load the campaign; bail out (ack, no retry) if it's not "queued" or
 *      "sending" — a paused/cancelled/completed/failed campaign means this
 *      task fired after the fact (e.g. raced cancelQueuedTasks's best-effort
 *      cleanup) and there is nothing to do.
 *   2. Atomically CLAIM the recipient (see claimRecipient below) — this is
 *      the exactly-once gate. Only a recipient still `status: "queued"` and
 *      not already claimed by another in-flight execution can proceed.
 *   3. Re-validate the template is still Approved (assertTemplateApprovedForCampaign
 *      — same check dispatchCampaignQueue.js re-runs before enqueueing, for
 *      the same "don't trust the snapshot" reason).
 *   4. Load `leads/{phone}` for personalization data and the (future-
 *      compatible) opt-out flag.
 *   5. Build the Meta template payload (components) from the template's
 *      variable placeholders + recipient/lead data, and call the existing
 *      `sendWhatsAppTemplate` sender from whatsapp.js — no new send path.
 *   6. Record the outcome: `sent` (+ messageId, sentAt, sentCount) on
 *      success; `failed` (+ failedAt, error/lastError, failedCount) for a
 *      permanent Meta error or once retries are exhausted; otherwise leave
 *      the recipient `queued` with `lastError` recorded and let Cloud Tasks'
 *      own retry/backoff redeliver the task.
 *
 * RETRY STRATEGY:
 * This worker does NOT schedule its own retry tasks (unlike
 * processPhoneQueue.js's self-chaining backoff) — the campaign-dispatch
 * queue already exists with its own retry/backoff policy configured at the
 * Cloud Tasks level, per this feature's requirements. Retryability is
 * therefore communicated purely via HTTP status code back to Cloud Tasks:
 *   - 429 (Meta rate-limited us)      -> return 429, let Cloud Tasks retry.
 *   - 5xx (Meta server error)         -> return 500, let Cloud Tasks retry.
 *   - timeout / network-level error   -> return 504, let Cloud Tasks retry.
 *   - anything else (400/401/403/404/410, template rejected/disabled,
 *     recipient opted out, campaign not found, etc.)
 *                                     -> permanent: mark the recipient
 *     "failed" and return 200 so Cloud Tasks does NOT retry.
 * A per-recipient attempt ceiling (CAMPAIGN_RECIPIENT_MAX_ATTEMPTS) is
 * enforced independently of however many attempts Cloud Tasks' own queue
 * config allows, so a recipient can never be retried forever even if the
 * queue's own maxAttempts is generous — once the ceiling is hit, a
 * would-be-retryable error is instead treated as permanent.
 *
 * IDEMPOTENCY / EXACTLY-ONCE SEND:
 * Cloud Tasks is at-least-once, so this same task can be delivered again
 * after it already succeeded (ack lost in transit, function killed just
 * after the 200, etc.), or — more rarely — delivered concurrently with a
 * still-running prior execution. Two mechanisms close both gaps, mirroring
 * processIncomingMessage.js's own claim pattern:
 *   1. TERMINAL-STATE CHECK: a recipient only ever leaves `status: "queued"`
 *      by transitioning to `sent` or `failed` (both terminal — see
 *      campaigns.js's RECIPIENT_STATUS_TRANSITIONS). claimRecipient() reads
 *      the recipient inside a transaction and immediately bails if it's not
 *      still `"queued"` — so a worker run that fires after the recipient was
 *      already sent (or already permanently failed) does nothing and never
 *      calls Meta a second time.
 *   2. IN-FLIGHT LOCK: the same claim transaction also checks
 *      `sendInFlightAt` (an in-progress-send marker, staleness-checked
 *      against CAMPAIGN_RECIPIENT_SEND_CLAIM_STALE_MS exactly like
 *      processIncomingMessage.js's STALE_CLAIM_MS). A concurrent duplicate
 *      delivery arriving while a still-healthy attempt is mid-flight sees
 *      the lock held and bails without calling Meta; only once the WhatsApp
 *      API call for the current attempt has been made and its outcome
 *      recorded does `sendInFlightAt` get cleared, on the same transaction
 *      that also writes the terminal `sent`/`failed` status (or, for a
 *      transient failure, on the transaction that leaves it `queued` again).
 * Both checks are transactional reads+writes on the SAME recipient document,
 * so there is no gap between "checked" and "claimed" for a second concurrent
 * request to slip through — the exact race Firestore transactions exist to
 * close, the same tool dispatcher.js/campaignQueue.js already rely on for
 * their own locks.
 */

const ACTIVE_CAMPAIGN_STATUSES = ["queued", "sending"];

function recipientRef(db, campaignId, recipientId) {
  return recipientsCollection(db, campaignId).doc(recipientId);
}

/**
 * Atomically claims one recipient for a send attempt. Returns:
 *   { proceed: false, reason }              — nothing to do, ack and stop
 *   { proceed: true, recipient, attempts }  — caller now owns this attempt
 */
async function claimRecipient(db, campaignId, recipientId) {
  const ref = recipientRef(db, campaignId, recipientId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { proceed: false, reason: "recipient_not_found" };
    }
    const recipient = snap.data();

    // Terminal-state check — the primary "never send twice" guard. Covers
    // both "already sent by an earlier delivery of this same task" and
    // "already permanently failed" (e.g. a give-up from a prior attempt).
    if (recipient.status !== "queued") {
      return { proceed: false, reason: `recipient_status_${recipient.status}`, recipient };
    }

    // In-flight lock — guards against a concurrent duplicate delivery of the
    // same task racing a still-running attempt. A stale lock (owner crashed
    // without recording an outcome) is allowed to be re-claimed.
    const inFlightAtMs = recipient.sendInFlightAt?.toMillis ? recipient.sendInFlightAt.toMillis() : 0;
    const isStale = Date.now() - inFlightAtMs > CAMPAIGN_RECIPIENT_SEND_CLAIM_STALE_MS;
    if (recipient.sendInFlightAt && !isStale) {
      return { proceed: false, reason: "in_flight", recipient };
    }

    const attempts = (recipient.attempts || 0) + 1;
    tx.set(
      ref,
      {
        attempts,
        sendInFlightAt: admin.firestore.FieldValue.serverTimestamp(),
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { proceed: true, recipient, attempts };
  });
}

/**
 * Transactionally finalizes a successful send: queued -> sent, stamps
 * sentAt/messageId, clears lastError, releases the in-flight lock, and
 * increments the campaign's sentCount. No-ops (just clears a lingering lock)
 * if the recipient somehow isn't `queued` anymore by the time this runs —
 * defensive only, since claimRecipient already made this attempt exclusive.
 */
async function finalizeSuccess(db, campaignId, recipientId, messageId, templateCategory) {
  const rRef = recipientRef(db, campaignId, recipientId);
  const cRef = campaignsCollection(db).doc(campaignId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(rRef);
    if (!snap.exists) return;
    const current = snap.data();

    if (current.status !== "queued") {
      if (current.sendInFlightAt) {
        tx.set(rRef, { sendInFlightAt: admin.firestore.FieldValue.delete() }, { merge: true });
      }
      return;
    }

    tx.set(
      rRef,
      {
        status: "sent",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        messageId: messageId || null,
        lastError: null,
        sendInFlightAt: admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );
    tx.update(cRef, {
      sentCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // METRICS: reached only when this recipient was still `queued` (the
    // terminal-state check above), so exactly one send is ever counted per
    // recipient — claimRecipient's in-flight lock already rules out a
    // concurrent duplicate reaching here twice. templateCategory (Meta's
    // Marketing/Utility/Authentication for this campaign's template) is
    // passed through so the cost is booked at the rate that template
    // actually bills under — see metrics.js's recordWhatsAppSentInTx.
    recordWhatsAppSentInTx(tx, db, templateCategory);
  });
}

/**
 * Transactionally finalizes a failed attempt. `permanent: true` moves the
 * recipient to the terminal `failed` state (stamping failedAt/error and
 * incrementing failedCount) so it is never retried again. `permanent: false`
 * leaves the recipient `queued` with `lastError` recorded and releases the
 * in-flight lock so a subsequent Cloud Tasks redelivery can re-claim it.
 */
async function finalizeFailure(db, campaignId, recipientId, errorMessage, { permanent }) {
  const rRef = recipientRef(db, campaignId, recipientId);
  const cRef = campaignsCollection(db).doc(campaignId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(rRef);
    if (!snap.exists) return;
    const current = snap.data();

    if (current.status !== "queued") {
      if (current.sendInFlightAt) {
        tx.set(rRef, { sendInFlightAt: admin.firestore.FieldValue.delete() }, { merge: true });
      }
      return;
    }

    if (permanent) {
      tx.set(
        rRef,
        {
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: errorMessage,
          lastError: errorMessage,
          sendInFlightAt: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
      tx.update(cRef, {
        failedCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // METRICS: only the `permanent: true` (terminal) branch counts — a
      // transient failure below leaves the recipient `queued` for Cloud
      // Tasks to retry and must not be counted as a failure yet.
      recordWhatsAppFailedInTx(tx, db);
    } else {
      tx.set(
        rRef,
        {
          lastError: errorMessage,
          sendInFlightAt: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
    }
  });
}

// Matches `{{1}}` (positional) and `{{customer_name}}` (named) placeholders —
// same pattern whatsappTemplates.js's extractVariablesFromText uses, kept
// local here since we need per-component (not whole-template) ordering to
// build each component's own `parameters` array correctly.
const VARIABLE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

function extractOrderedVariables(text) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  let match;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(text)) !== null) {
    found.push(match[1].trim());
  }
  return found;
}

/**
 * Resolves one template variable's value from the recipient's linked lead.
 *
 * FOUNDATION CONVENTION: campaigns.js's recipient schema (newRecipientDoc)
 * doesn't carry richer per-recipient personalization fields yet — only
 * `phone` and an optional `leadId`. Until a future feature adds a proper
 * per-recipient variable-values map, the first placeholder is filled from
 * the linked `leads/{phone}` document's `name` (falling back to the phone
 * number if the lead record or its name is missing — never leaving a
 * placeholder unfilled, since Meta rejects a template send with a missing
 * parameter), the second from the recipient's phone number, and any further
 * placeholders fall back to the lead's name again.
 */
function resolveVariableValue(position, lead, recipient) {
  const name = (lead && lead.name) || null;
  if (position === 0) return name || recipient.phone;
  if (position === 1) return recipient.phone;
  return name || recipient.phone;
}

function buildComponentParameters(component, lead, recipient) {
  const varNames = extractOrderedVariables(component.text);
  if (varNames.length === 0) return null;
  return varNames.map((_varName, idx) => ({
    type: "text",
    text: String(resolveVariableValue(idx, lead, recipient)),
  }));
}

/**
 * Builds the Meta `template.components` array for this send.
 *
 * Rules:
 *  - TEXT headers/BODY: include only when there are {{...}} placeholders;
 *    emit a `parameters` array with one text entry per placeholder.
 *  - IMAGE/VIDEO/DOCUMENT headers: Meta requires a header component with a
 *    media parameter at send time even for static templates. We use the
 *    campaign-level `headerImageUrl` if provided, otherwise fall back to a
 *    stub URL so the component is present (Meta will reject a missing header
 *    component outright; a bad URL produces a softer send-time error that is
 *    still surfaced to the user via the recipient's error field).
 *  - LOCATION headers: include with location parameters when present in
 *    the campaign; skip if no coordinates are stored.
 *  - FOOTER / BUTTONS: never included — Meta does not accept parameters for
 *    these component types in a send payload.
 */
function buildTemplateComponents(template, lead, recipient) {
  const components = Array.isArray(template.components) ? template.components : [];
  const result = [];

  // campaign-level media URL (future: could be per-recipient)
  const headerImageUrl = template.headerImageUrl || null;

  for (const component of components) {
    const type = String(component?.type || "").toUpperCase();
    const format = String(component?.format || "").toUpperCase();

    if (type === "HEADER") {
      if (format === "TEXT") {
        // Text header: only include when it has variables
        if (typeof component.text !== "string") continue;
        const parameters = buildComponentParameters(component, lead, recipient);
        if (!parameters) continue;
        result.push({ type: "header", parameters });

      } else if (format === "IMAGE") {
        // IMAGE header: Meta requires this component at send time with an
        // image link parameter. Use the stored campaign URL, or a clear
        // placeholder that surfaces as a send error rather than a silent skip.
        const imageLink = headerImageUrl || "";
        if (!imageLink) {
          // No URL available — skip so Meta returns a clear API error rather
          // than a silent wrong-format mismatch. Log for visibility.
          logger.warn("buildTemplateComponents: IMAGE header skipped — no headerImageUrl on template/campaign", {
            templateName: template.name,
          });
          continue;
        }
        result.push({
          type: "header",
          parameters: [{ type: "image", image: { link: imageLink } }],
        });

      } else if (format === "VIDEO") {
        const videoLink = headerImageUrl || "";
        if (!videoLink) continue;
        result.push({
          type: "header",
          parameters: [{ type: "video", video: { link: videoLink } }],
        });

      } else if (format === "DOCUMENT") {
        const docLink = headerImageUrl || "";
        if (!docLink) continue;
        result.push({
          type: "header",
          parameters: [{ type: "document", document: { link: docLink } }],
        });

      } else if (format === "LOCATION") {
        // Location header: coordinates must come from the campaign
        const loc = template.headerLocation;
        if (!loc?.latitude || !loc?.longitude) continue;
        result.push({
          type: "header",
          parameters: [{
            type: "location",
            location: {
              latitude: loc.latitude,
              longitude: loc.longitude,
              name: loc.name || "",
              address: loc.address || "",
            },
          }],
        });
      }
      continue;
    }

    if (type === "BODY") {
      if (typeof component.text !== "string") continue;
      const parameters = buildComponentParameters(component, lead, recipient);
      if (!parameters) continue;
      result.push({ type: "body", parameters });
      continue;
    }

    // FOOTER / BUTTONS — never included in send payload
  }

  return result;
}

/**
 * Classifies a WhatsApp Cloud API send failure as retryable or permanent.
 *   - 429                       -> retryable, respond 429
 *   - 5xx                       -> retryable, respond 500
 *   - no HTTP response at all (network-level: timeout, connection reset/
 *     refused, DNS) -> retryable, respond 504
 *   - everything else (400 invalid parameter, 401/403 auth, 404, 410, or any
 *     other 4xx Meta validation error) -> permanent, respond 200 (do not
 *     retry — retrying a rejected template payload will only be rejected
 *     again).
 */
function classifySendError(err) {
  const status = err.response?.status;
  const metaError = err.response?.data?.error;
  const metaMessage = metaError?.message || metaError?.error_user_msg || err.message || "Unknown error";

  if (status === 429) {
    return { retryable: true, httpStatus: 429, message: `Rate limited by WhatsApp Cloud API: ${metaMessage}` };
  }
  if (typeof status === "number" && status >= 500 && status < 600) {
    return { retryable: true, httpStatus: 500, message: `WhatsApp Cloud API server error (${status}): ${metaMessage}` };
  }

  const code = err.code;
  const looksLikeTimeout =
    !status &&
    (code === "ECONNABORTED" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      /timeout/i.test(err.message || ""));
  if (looksLikeTimeout) {
    return { retryable: true, httpStatus: 504, message: `Timed out calling WhatsApp Cloud API: ${err.message}` };
  }

  return {
    retryable: false,
    httpStatus: 200,
    message: `WhatsApp Cloud API rejected the message${status ? ` (${status})` : ""}: ${metaMessage}`,
  };
}

/**
 * Best-effort wrapper around campaigns.js's completeCampaignIfFinished —
 * called after every recipient outcome that could be the LAST one
 * outstanding (a terminal `sent` or a permanent `failed`; never after a
 * transient failure, since the recipient is still `queued` and the campaign
 * is by definition not finished). Never allowed to affect the HTTP response
 * for this recipient — a failure here just means the campaign's status
 * lags reality slightly, not that this recipient's own outcome was lost.
 */
async function checkCampaignCompletion(db, campaignId) {
  try {
    const result = await completeCampaignIfFinished(db, campaignId);
    if (result) {
      logger.info("processCampaignRecipient: campaign completed", { campaignId });
    }
  } catch (err) {
    logger.warn("processCampaignRecipient: completion check failed", {
      campaignId,
      error: err.message,
    });
  }
}

const processCampaignRecipient = onRequest(
  {
    secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID],
    region: "us-central1",
    invoker: "private",
    timeoutSeconds: CAMPAIGN_RECIPIENT_TIMEOUT_SECONDS,
  },
  async (req, res) => {
    const { campaignId, recipientId } = req.body || {};
    if (!campaignId || typeof campaignId !== "string" || !recipientId || typeof recipientId !== "string") {
      // Malformed task payload — retrying won't fix it, ack so Cloud Tasks
      // doesn't keep redelivering a request that can never succeed.
      logger.error("processCampaignRecipient: missing campaignId/recipientId in task payload");
      res.status(200).send("Missing or invalid 'campaignId'/'recipientId'");
      return;
    }

    const db = admin.firestore();

    try {
      // 1. Load campaign, validate it's still active.
      const campaignSnap = await campaignsCollection(db).doc(campaignId).get();
      if (!campaignSnap.exists) {
        logger.error("processCampaignRecipient: campaign not found", { campaignId, recipientId });
        res.sendStatus(200);
        return;
      }
      const campaign = campaignSnap.data();

      if (!ACTIVE_CAMPAIGN_STATUSES.includes(campaign.status)) {
        // Paused/cancelled/completed/failed since this task was created —
        // not an error, nothing left to do for this recipient.
        logger.info("processCampaignRecipient: campaign not active, skipping", {
          campaignId,
          recipientId,
          status: campaign.status,
        });
        res.status(200).json({ skipped: true, reason: `campaign_${campaign.status}` });
        return;
      }

      // 2. Atomically claim the recipient — the exactly-once gate.
      const claim = await claimRecipient(db, campaignId, recipientId);
      if (!claim.proceed) {
        logger.info("processCampaignRecipient: skipping, nothing to do", {
          campaignId,
          recipientId,
          reason: claim.reason,
        });
        res.status(200).json({ skipped: true, reason: claim.reason });
        return;
      }
      const { recipient, attempts } = claim;

      // 3. Re-validate the template is still approved (don't trust the
      // task's snapshot — see file header).
      let template;
      try {
        template = await assertTemplateApprovedForCampaign(db, {
          templateName: campaign.templateName,
          templateLanguage: campaign.templateLanguage,
        });
      } catch (err) {
        const message = err instanceof CampaignError || err instanceof TemplateError ? err.message : err.message;
        await finalizeFailure(db, campaignId, recipientId, message, { permanent: true });
        await checkCampaignCompletion(db, campaignId);
        logger.warn("processCampaignRecipient: template no longer approved, recipient failed permanently", {
          campaignId,
          recipientId,
          error: message,
        });
        res.sendStatus(200);
        return;
      }

      // 4. Load the linked lead for personalization + opt-in status.
      const leadSnap = await db.collection("leads").doc(recipient.phone).get();
      const lead = leadSnap.exists ? leadSnap.data() : null;

      // 5. Opt-in check (future compatibility — no feature sets this flag
      // yet, so its absence is treated as "opted in").
      if (lead?.optedOut === true) {
        await finalizeFailure(db, campaignId, recipientId, "Recipient has opted out of WhatsApp messages.", {
          permanent: true,
        });
        await checkCampaignCompletion(db, campaignId);
        logger.info("processCampaignRecipient: recipient opted out, skipping permanently", {
          campaignId,
          recipientId,
        });
        res.sendStatus(200);
        return;
      }

      // 6. Build the Meta payload and send via the existing sender.
      const components = buildTemplateComponents(template, lead, recipient);

      let metaResponse;
      try {
        metaResponse = await sendWhatsAppTemplate({
          to: recipient.phone,
          templateName: template.name,
          languageCode: template.language,
          components,
          whatsappToken: WHATSAPP_TOKEN.value(),
          phoneNumberId: WHATSAPP_PHONE_NUMBER_ID.value(),
        });
      } catch (err) {
        const classification = classifySendError(err);
        const outOfAttempts = attempts >= CAMPAIGN_RECIPIENT_MAX_ATTEMPTS;
        const permanent = !classification.retryable || outOfAttempts;

        await finalizeFailure(db, campaignId, recipientId, classification.message, { permanent });
        if (permanent) {
          await checkCampaignCompletion(db, campaignId);
        }

        logger.warn("processCampaignRecipient: send failed", {
          campaignId,
          recipientId,
          attempts,
          permanent,
          error: classification.message,
        });

        // permanent === true always acks with 200 (don't retry, whether
        // because the error was non-retryable or because attempts are
        // exhausted). permanent === false replies with the classified
        // retryable status so Cloud Tasks redelivers per the queue's own
        // backoff policy.
        res.status(permanent ? 200 : classification.httpStatus).json({
          ok: false,
          retried: !permanent,
          error: classification.message,
        });
        return;
      }

      const messageId = metaResponse?.messages?.[0]?.id || null;

      // Best-effort campaign status flip to "sending" on the first send —
      // purely cosmetic bookkeeping (campaign.status), never blocks the
      // recipient outcome below. A race where another concurrent recipient
      // already made this transition just throws failed_precondition here,
      // which is expected and safely ignored.
      try {
        await updateCampaignStatus(db, campaignId, "sending");
      } catch (err) {
        if (!(err instanceof CampaignError) || err.code !== "failed_precondition") {
          logger.warn("processCampaignRecipient: unexpected error flipping campaign to sending", {
            campaignId,
            error: err.message,
          });
        }
      }

      await finalizeSuccess(db, campaignId, recipientId, messageId, template.category);
      await checkCampaignCompletion(db, campaignId);

      logger.info("processCampaignRecipient: sent", { campaignId, recipientId, messageId, attempts });
      res.status(200).json({ ok: true, recipientId, messageId });
    } catch (err) {
      // Unexpected (Firestore outage, programming error, etc.) — let Cloud
      // Tasks retry; nothing has been claimed/finalized inconsistently since
      // every state change above is transactional.
      logger.error("processCampaignRecipient: unexpected failure", {
        campaignId,
        recipientId,
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Failed to process campaign recipient" });
    }
  }
);

module.exports = {
  processCampaignRecipient,
  buildTemplateComponents,
  classifySendError,
};
