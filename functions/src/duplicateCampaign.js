const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  getCampaign,
  createCampaign: createCampaignDoc,
  addRecipientsToCampaign,
  recipientsCollection,
  getNextRunNumber,
  CampaignError,
} = require("./campaigns");
const { requireAuthContext, AuthError } = require("./auth");

/**
 * "Reuse campaign" — duplicates an existing campaign (any status: draft,
 * queued, sending, paused, completed, failed, cancelled) into a brand-new
 * "draft" campaign with the same template/type and the same recipient list,
 * so an operator can re-run a finished/failed/cancelled campaign, or just
 * reuse a working audience for a fresh send, without hand-rebuilding it from
 * a CSV again.
 *
 * ARCHITECTURE — new independent run, not an in-place relaunch. This
 * endpoint creates a wholly new campaign document; it never resets or
 * relaunches the source. That's a deliberate choice, not an oversight:
 *   - The source's status machine (CAMPAIGN_STATUS_TRANSITIONS in
 *     campaigns.js) treats completed/failed/cancelled as TERMINAL states on
 *     purpose — no transition out of them is legal. Resetting a finished
 *     campaign back to "draft" to resend would mean bypassing that
 *     invariant, which the rest of the codebase (dispatch, the worker, pause/
 *     resume/cancel) relies on holding.
 *   - Resetting counters/timeline/recipients in place would destroy that
 *     run's own sentCount/deliveredCount/readCount/failedCount and its
 *     timeline the moment a re-send started — there would be no way to see
 *     "how did the LAST run do" once a new one began.
 *   - Delivery/read receipts can arrive from Meta hours after a send. If the
 *     same recipient docs were reset and reused, a late webhook for the
 *     OLD send could land on a recipient now mid-way through a NEW send and
 *     misattribute a delivered/read status to the wrong attempt entirely
 *     (whatsappWebhook.js resolves a status webhook to a recipient purely by
 *     messageId, so a stable per-run recipient document is what makes that
 *     lookup unambiguous).
 * The SOURCE campaign is therefore completely untouched — its status,
 * counters, and timeline stay exactly as they were, and every prior run
 * remains independently inspectable.
 *
 * LINEAGE — this run is linked back to where it came from via three fields
 * on the new campaign doc (see campaigns.js's file header for the full
 * rationale): `rootCampaignId` (constant across every run of this campaign),
 * `parentCampaignId` (the specific run just reused), and `runNumber`
 * (this run's position, unique across the whole lineage — see
 * getNextRunNumber). That lineage is also recorded directly in the new
 * campaign's own audit trail: its first "created" timeline event carries a
 * `reusedFrom` meta field naming the source, so reading just this one
 * campaign's timeline already explains where it came from, without having
 * to cross-reference `parentCampaignId` against another document. A
 * campaign is safe to reuse any number of times — every reuse just adds
 * another run to the same lineage.
 *
 * Recipients are copied as plain { phone, leadId } pairs through the
 * existing addRecipientsToCampaign — the same validation/dedup path
 * createCampaign + addCampaignRecipients already use. Every other
 * per-recipient field (status, messageId, attempts, error/lastError,
 * sent/delivered/read/failed timestamps) is deliberately NOT copied: this is
 * a new send to the same audience, not a clone of a previous send's history,
 * so every copied recipient starts fresh at "pending". That per-recipient
 * copy is necessary duplication, not accidental: each run needs to track
 * its OWN send outcome per recipient independently (a recipient who failed
 * in run 1 might succeed in run 2), which is only possible if each run owns
 * its own recipient documents. What this design avoids is the unnecessary
 * duplication — every previous version of this endpoint produced a
 * campaign with no recorded relationship to where it came from, so
 * analytics/history could only be found again by guessing from the
 * "(Copy)" suffix in its name.
 *
 * Expects: { campaignId: string, name?: string }
 * Returns: 201 { id, data } — the new draft campaign, same response shape as
 * createCampaign.js, plus the recipient-copy counts from
 * addRecipientsToCampaign, and the lineage fields folded in for convenience.
 */
const duplicateCampaign = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const { agencyId } = await requireAuthContext(req, { roles: ["owner", "admin"] });
    const { campaignId, name } = req.body || {};
    if (!campaignId || typeof campaignId !== "string") {
      res.status(400).json({ error: "Missing or invalid 'campaignId'" });
      return;
    }

    const db = admin.firestore();
    const { data: source } = await getCampaign(db, agencyId, campaignId);

    // LINEAGE: a source that already belongs to a lineage (was itself a
    // reuse, or has been reused before) carries its own rootCampaignId
    // forward unchanged. A source with no rootCampaignId is either an
    // original campaign or one created before this field existed — either
    // way it IS the root of its own lineage, so it's used as the fallback
    // rather than requiring a migration of old campaign docs.
    const rootCampaignId = source.rootCampaignId || campaignId;
    const runNumber = await getNextRunNumber(db, agencyId, rootCampaignId);

    const { id, data } = await createCampaignDoc(db, agencyId, {
      name: (typeof name === "string" && name.trim()) || `${source.name} (Copy)`,
      description: source.description,
      type: source.type,
      templateName: source.templateName,
      templateLanguage: source.templateLanguage,
      rootCampaignId,
      parentCampaignId: campaignId,
      runNumber,
      createdMeta: { reusedFrom: campaignId, rootCampaignId, runNumber },
    });

    // Pull every existing recipient's { phone, leadId } only — status/
    // history deliberately dropped, see file header.
    const recipientsSnap = await recipientsCollection(db, agencyId, campaignId).get();
    const recipients = recipientsSnap.docs.map((doc) => {
      const r = doc.data();
      return { phone: r.phone, leadId: r.leadId || null };
    });

    let recipientResult = { added: 0, skippedDuplicates: 0, skippedInvalid: 0, totalRecipients: 0 };
    if (recipients.length > 0) {
      recipientResult = await addRecipientsToCampaign(db, agencyId, id, recipients);
    }

    logger.info("duplicateCampaign: created", {
      sourceCampaignId: campaignId,
      newCampaignId: id,
      rootCampaignId,
      runNumber,
      recipientsCopied: recipientResult.added,
    });

    res.status(201).json({
      id,
      data: { ...data, ...recipientResult },
      lineage: { rootCampaignId, parentCampaignId: campaignId, runNumber },
    });
  } catch (err) {
    if (err instanceof CampaignError) {
      const statusCode = err.code === "not_found" ? 404 : 400;
      res.status(statusCode).json({ error: err.message });
      return;
    }
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error("duplicateCampaign: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Failed to duplicate campaign" });
  }
});

module.exports = { duplicateCampaign };
