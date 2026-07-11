const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  getCampaign,
  createCampaign: createCampaignDoc,
  addRecipientsToCampaign,
  recipientsCollection,
  CampaignError,
} = require("./campaigns");

/**
 * "Reuse campaign" — duplicates an existing campaign (any status: draft,
 * queued, sending, paused, completed, failed, cancelled) into a brand-new
 * "draft" campaign with the same template/type and the same recipient list,
 * so an operator can re-run a finished/failed/cancelled campaign, or just
 * reuse a working audience for a fresh send, without hand-rebuilding it from
 * a CSV again.
 *
 * The SOURCE campaign is completely untouched — its status, counters, and
 * timeline stay exactly as they were. This endpoint only ever creates
 * something new; nothing about "duplicate" reaches back to mutate the
 * campaign being duplicated.
 *
 * Recipients are copied as plain { phone, leadId } pairs through the
 * existing addRecipientsToCampaign — the same validation/dedup path
 * createCampaign + addCampaignRecipients already use. Every other
 * per-recipient field (status, messageId, attempts, error/lastError,
 * sent/delivered/read/failed timestamps) is deliberately NOT copied: this is
 * a new send to the same audience, not a clone of a previous send's history,
 * so every copied recipient starts fresh at "pending".
 *
 * Expects: { campaignId: string, name?: string }
 * Returns: 201 { id, data } — the new draft campaign, same response shape as
 * createCampaign.js, plus the recipient-copy counts from
 * addRecipientsToCampaign folded in for convenience.
 */
const duplicateCampaign = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const { campaignId, name } = req.body || {};
    if (!campaignId || typeof campaignId !== "string") {
      res.status(400).json({ error: "Missing or invalid 'campaignId'" });
      return;
    }

    const db = admin.firestore();
    const { data: source } = await getCampaign(db, campaignId);

    const { id, data } = await createCampaignDoc(db, {
      name: (typeof name === "string" && name.trim()) || `${source.name} (Copy)`,
      description: source.description,
      type: source.type,
      templateName: source.templateName,
      templateLanguage: source.templateLanguage,
    });

    // Pull every existing recipient's { phone, leadId } only — status/
    // history deliberately dropped, see file header.
    const recipientsSnap = await recipientsCollection(db, campaignId).get();
    const recipients = recipientsSnap.docs.map((doc) => {
      const r = doc.data();
      return { phone: r.phone, leadId: r.leadId || null };
    });

    let recipientResult = { added: 0, skippedDuplicates: 0, skippedInvalid: 0, totalRecipients: 0 };
    if (recipients.length > 0) {
      recipientResult = await addRecipientsToCampaign(db, id, recipients);
    }

    logger.info("duplicateCampaign: created", {
      sourceCampaignId: campaignId,
      newCampaignId: id,
      recipientsCopied: recipientResult.added,
    });

    res.status(201).json({ id, data: { ...data, ...recipientResult } });
  } catch (err) {
    if (err instanceof CampaignError) {
      const statusCode = err.code === "not_found" ? 404 : 400;
      res.status(statusCode).json({ error: err.message });
      return;
    }
    logger.error("duplicateCampaign: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Failed to duplicate campaign" });
  }
});

module.exports = { duplicateCampaign };
