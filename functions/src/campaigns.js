const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const {
  recordCampaignCreated,
  recordCampaignStatusChangeInTx,
  recordWhatsAppStatusInTx,
} = require("./metrics");

/**
 * CAMPAIGN DATA MODEL
 * ---------------------------------------------------------------------------
 * `campaigns/{campaignId}` — one broadcast/blast definition (which approved
 * WhatsApp template, to how many recipients, current lifecycle status, and
 * denormalized counters for dashboard display without a client-side scan of
 * the recipients subcollection).
 *
 * `campaigns/{campaignId}/recipients/{recipientId}` — one row per phone
 * number targeted by the campaign, doc-ID'd by the SAME normalized-phone
 * convention `leads/{phone}` already uses (see leadsWebhook.js /
 * whatsappWebhook.js), so a recipient can be cross-referenced back to
 * `leads/{phone}` (and optionally `leads/{phone}/opportunities/{leadId}` via
 * the `leadId` field) without a lookup table.
 *
 * LINEAGE (rootCampaignId / parentCampaignId / runNumber) — added for the
 * "Reuse Campaign" feature (see duplicateCampaign.js). Every campaign is
 * still a fully independent, first-class `campaigns/{id}` document with its
 * own status machine, counters, timeline, and recipients — reuse deliberately
 * does NOT reset/relaunch an existing campaign in place (see
 * duplicateCampaign.js's header for why). These three fields exist only to
 * record, non-destructively, which lineage of reuses a campaign belongs to:
 *   - `rootCampaignId`: the very first campaign in this lineage. A campaign
 *     created directly (not via reuse) is its own root. Constant across every
 *     run in a lineage — this is the field to group by for a rolled-up "all
 *     runs of this campaign" analytics view (see getCampaignLineage below).
 *   - `parentCampaignId`: the specific campaign this one was reused FROM, or
 *     null for an original (non-reused) campaign. Forms a tree, not
 *     necessarily a straight chain — reusing the same run twice produces two
 *     children with the same parent.
 *   - `runNumber`: this campaign's 1-based position in the lineage, assigned
 *     from the current max across the whole lineage (getNextRunNumber) so it
 *     stays unique/monotonic across a tree-shaped reuse history, not just a
 *     linear one.
 * A campaign created before this field existed simply has no `rootCampaignId`
 * of its own — duplicateCampaign.js treats that absence as "this campaign IS
 * a root" (falls back to its own id), so old data doesn't need a migration.
 *
 * THIS FILE IS FOUNDATION ONLY:
 *   - No WhatsApp Cloud API calls (see whatsapp.js for that layer).
 *   - No Cloud Tasks enqueueing (see cloudTasks.js for that layer).
 *   - `applyRecipientStatusUpdate` exists so a future "actually send/track
 *     delivery" feature has a single, race-safe place to flip a recipient's
 *     status and keep the campaign's counters in sync — it is not called
 *     from anywhere yet.
 */

const CAMPAIGN_TYPES = ["marketing", "utility"];

const CAMPAIGN_STATUSES = [
  "draft",
  "queued",
  "sending",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

// Recipient lifecycle. "pending" (not in the campaign-level counters, which
// only track totalRecipients until a recipient is queued) is the state a
// recipient sits in from the moment it's added to a draft campaign until a
// future sending feature actually queues it for delivery.
const RECIPIENT_STATUSES = [
  "pending",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
];

// Only these forward transitions are legal. Anything else (skipping a step,
// moving backward, re-entering a terminal state) is rejected rather than
// silently allowed — campaign counters are derived from these transitions,
// so an illegal one would desync totalRecipients vs. the per-status counts.
const CAMPAIGN_STATUS_TRANSITIONS = {
  draft: ["queued", "cancelled"],
  queued: ["sending", "paused", "cancelled"],
  sending: ["completed", "failed", "paused", "cancelled"],
  // Resume's target isn't fixed — a campaign can be paused mid-dispatch
  // (still "queued") or mid-send (already "sending"). resumeCampaign()
  // below reads the `pausedFrom` field stamped by pauseCampaign() to decide
  // which of these two legal targets to return to, rather than this table
  // hard-coding one.
  paused: ["queued", "sending", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const RECIPIENT_STATUS_TRANSITIONS = {
  pending: ["queued", "failed"],
  queued: ["sent", "failed"],
  // "read" is reachable directly from "sent" (not just via "delivered") —
  // WhatsApp's delivered/read status webhooks aren't strictly ordered, and a
  // "read" receipt can arrive without a preceding "delivered" one ever being
  // seen (e.g. it was missed, or the recipient's chat was already open).
  // Treating that as illegal would silently drop the read receipt forever.
  sent: ["delivered", "read", "failed"],
  delivered: ["read", "failed"],
  read: [],
  failed: [],
};

// Maps a recipient status to the campaign-level counter field it increments,
// and (where applicable) the recipient-level timestamp field it stamps.
// "pending" and "queued" intentionally have no timestamp field — the schema
// only defines sentAt/deliveredAt/readAt/failedAt.
const RECIPIENT_STATUS_META = {
  pending: { counterField: null, timestampField: null },
  queued: { counterField: "queuedCount", timestampField: null },
  sent: { counterField: "sentCount", timestampField: "sentAt" },
  delivered: { counterField: "deliveredCount", timestampField: "deliveredAt" },
  read: { counterField: "readCount", timestampField: "readAt" },
  failed: { counterField: "failedCount", timestampField: "failedAt" },
};

// Timeline event types. "created" and "recipients_added" are written by
// this file directly (createCampaign / addRecipientsToCampaign already run
// here). "queued" is written by launchCampaign, "paused"/"resumed" by
// pauseCampaign/resumeCampaign, and "cancelled" by cancelCampaign — all
// below. "sending", "completed", and "failed" are NOT written by anything
// yet — they're declared here so the schema is already correct for the
// future actual-sending feature, the same "foundation only" posture as
// applyRecipientStatusUpdate above.
const CAMPAIGN_TIMELINE_EVENT_TYPES = [
  "created",
  "recipients_added",
  "queued",
  "sending",
  "paused",
  "resumed",
  "completed",
  "failed",
  "cancelled",
];

/** Thrown for caller-fixable problems (bad input, illegal transition, missing
 * doc) so HTTP handlers can map it to a 400/404 instead of a 500. */
class CampaignError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CampaignError";
    this.code = code || "invalid_argument";
  }
}

// Firestore's FieldValue.serverTimestamp() sentinel is NOT supported inside
// array elements (only as a top-level/nested-map field value), so timeline
// entries stamp `at` with a plain client-generated millis number instead —
// the same pattern sendManualMessage.js already uses for conversation-turn
// timestamps (`timestamp: Date.now()`), for the same reason.
function buildTimelineEvent(type, meta) {
  if (!CAMPAIGN_TIMELINE_EVENT_TYPES.includes(type)) {
    throw new CampaignError(`'${type}' is not a valid timeline event type.`);
  }
  const event = { type, at: Date.now() };
  if (meta && Object.keys(meta).length > 0) {
    event.meta = meta;
  }
  return event;
}

function campaignsCollection(db) {
  return db.collection("campaigns");
}

function recipientsCollection(db, campaignId) {
  return campaignsCollection(db).doc(campaignId).collection("recipients");
}

// Same normalization WhatsApp Cloud API / leadsWebhook.js already rely on:
// digits only, no "+", no spaces/dashes. Used as the recipient doc ID so
// adding the same phone twice is a natural no-op rather than a duplicate row.
function normalizePhone(rawPhone) {
  if (typeof rawPhone !== "string") return "";
  return rawPhone.replace(/[^\d]/g, "");
}

function isValidPhone(phone) {
  return /^\d{7,15}$/.test(phone);
}

function validateCampaignInput({ name, description, type, templateName, templateLanguage }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new CampaignError("'name' is required and must be a non-empty string.");
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    throw new CampaignError("'description' must be a string if provided.");
  }
  if (!CAMPAIGN_TYPES.includes(type)) {
    throw new CampaignError(`'type' must be one of: ${CAMPAIGN_TYPES.join(", ")}.`);
  }
  if (typeof templateName !== "string" || !templateName.trim()) {
    throw new CampaignError("'templateName' is required and must be a non-empty string.");
  }
  if (typeof templateLanguage !== "string" || !templateLanguage.trim()) {
    throw new CampaignError("'templateLanguage' is required and must be a non-empty string.");
  }
}

function newCampaignDoc({
  name,
  description,
  type,
  templateName,
  templateLanguage,
  rootCampaignId,
  parentCampaignId,
  runNumber,
  createdMeta,
}) {
  return {
    name: name.trim(),
    description: (description || "").trim(),
    type,
    templateName: templateName.trim(),
    templateLanguage: templateLanguage.trim(),
    status: "draft",
    // LINEAGE — see this file's header. A campaign created directly (the
    // normal createCampaign.js flow, which never passes these) is its own
    // root and run #1 with no parent; duplicateCampaign.js is the only
    // caller that ever passes non-default values here.
    rootCampaignId: rootCampaignId || null, // resolved to this doc's own id in createCampaign() below when not provided
    parentCampaignId: parentCampaignId || null,
    runNumber: runNumber || 1,
    totalRecipients: 0,
    queuedCount: 0,
    // remainingCount/taskCount are queue-engine bookkeeping (see
    // campaignQueue.js) — both stay 0 for the entire draft lifetime.
    // remainingCount is seeded to totalRecipients by launchCampaign() below
    // at the moment a campaign becomes "queued" (that's when "how many are
    // left to enqueue" first becomes a meaningful question), then counted
    // down by the dispatch engine as it creates each recipient's task.
    // taskCount is the running total of Cloud Tasks ever created for this
    // campaign (== recipients enqueued for now, since nothing retries a
    // failed send yet; would exceed totalRecipients once retry-with-new-
    // attempt is a thing).
    remainingCount: 0,
    taskCount: 0,
    sentCount: 0,
    deliveredCount: 0,
    readCount: 0,
    failedCount: 0,
    // AUDIT: the "created" event's meta carries lineage info when this run
    // came from a reuse (see createdMeta doc below) — e.g. { reusedFrom,
    // rootCampaignId, runNumber } — so the audit trail is self-explanatory
    // from the timeline array alone, not just inferable from the
    // rootCampaignId/parentCampaignId fields elsewhere on the doc.
    timeline: [buildTimelineEvent("created", createdMeta)],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * Creates a new campaign in "draft" status with all counters zeroed.
 * Recipients are added separately via addRecipientsToCampaign.
 *
 * @param {object} input
 * @param {string} [input.rootCampaignId] LINEAGE — only ever passed by
 *   duplicateCampaign.js. Left undefined for a normal new campaign, which
 *   resolves to `ref.id` below (a fresh campaign is the root of its own
 *   lineage, run #1).
 * @param {string} [input.parentCampaignId] LINEAGE — the campaign this one
 *   was reused from, if any. Only ever passed by duplicateCampaign.js.
 * @param {number} [input.runNumber] LINEAGE — this campaign's position in
 *   its lineage. Only ever passed by duplicateCampaign.js.
 * @param {object} [input.createdMeta] AUDIT — meta attached to the initial
 *   "created" timeline event. Only ever passed by duplicateCampaign.js.
 * @returns {Promise<{id: string, data: object}>}
 */
async function createCampaign(db, input) {
  validateCampaignInput(input);

  const ref = campaignsCollection(db).doc();
  const doc = newCampaignDoc({
    ...input,
    // A fresh (non-reuse) campaign is the root of its own lineage — ref.id
    // is already known here (Firestore auto-IDs are generated client-side,
    // no round trip needed), so this never leaves rootCampaignId null for a
    // campaign nothing has been reused from yet.
    rootCampaignId: input.rootCampaignId || ref.id,
  });
  await ref.set(doc);

  // METRICS: one HTTP call -> one campaign doc -> one metrics update. Not
  // wrapped in the write above's transaction because there isn't one here
  // (createCampaign is a single, non-retried write, same posture as
  // sendManualMessage.js) — best-effort, see metrics.js's FAILURE ISOLATION note.
  await recordCampaignCreated(db);

  logger.info("campaigns: created campaign", {
    campaignId: ref.id,
    type: input.type,
    rootCampaignId: doc.rootCampaignId,
    parentCampaignId: doc.parentCampaignId,
    runNumber: doc.runNumber,
  });

  // Return a client-usable copy — serverTimestamp() sentinels aren't
  // resolved until the write lands, so approximate with Date.now() for the
  // immediate HTTP response (mirrors sendManualMessage.js's response shape).
  return {
    id: ref.id,
    data: { ...doc, createdAt: Date.now(), updatedAt: Date.now() },
  };
}

async function getCampaign(db, campaignId) {
  const snap = await campaignsCollection(db).doc(campaignId).get();
  if (!snap.exists) {
    throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
  }
  return { id: snap.id, data: snap.data() };
}

/**
 * LINEAGE — returns the next run number for a given lineage: current max
 * `runNumber` among every campaign sharing this `rootCampaignId`, plus one.
 * Deliberately the max across the WHOLE lineage, not `parent.runNumber + 1`
 * — reuse can form a tree (the same run reused twice, or an older run
 * reused again after a newer one already exists), and taking the lineage-
 * wide max is what keeps runNumber unique/monotonic across that tree instead
 * of colliding whenever a reuse doesn't come from the most recent run.
 *
 * Not run inside a transaction: two reuses of the same lineage landing in
 * the same instant could in principle compute the same next number. That's
 * a cosmetic ordering-label collision, not a correctness problem — every
 * run is still its own independent `campaigns/{id}` document with a unique
 * id, its own counters, and its own recipients, so nothing about sending or
 * analytics is affected. The same best-effort posture campaignQueue.js's
 * own bookkeeping counters already use elsewhere in this codebase.
 */
async function getNextRunNumber(db, rootCampaignId) {
  const snap = await campaignsCollection(db)
    .where("rootCampaignId", "==", rootCampaignId)
    .orderBy("runNumber", "desc")
    .limit(1)
    .get();
  if (snap.empty) return 1;
  return (snap.docs[0].data().runNumber || 1) + 1;
}

/**
 * LINEAGE — every campaign (run) that shares the given `rootCampaignId`,
 * ordered oldest-run-first, plus totals rolled up across all of them. This
 * is what lets "Reuse Campaign" satisfy preserving analytics/history/
 * delivery metrics ACROSS reuses without merging or resetting any
 * individual run's own data: each run's counters/timeline/recipients stay
 * exactly as recorded, and this just sums what's already there.
 *
 * Not called by duplicateCampaign.js itself (creating a run doesn't need
 * its own lineage totals) — this is the read-side building block a future
 * "all runs of this campaign" analytics view would call.
 *
 * @returns {Promise<{runs: Array<{id: string, data: object}>, totals: object}>}
 */
async function getCampaignLineage(db, rootCampaignId) {
  const snap = await campaignsCollection(db)
    .where("rootCampaignId", "==", rootCampaignId)
    .orderBy("runNumber", "asc")
    .get();

  const runs = snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));

  const totals = runs.reduce(
    (acc, run) => {
      acc.totalRecipients += run.data.totalRecipients || 0;
      acc.sentCount += run.data.sentCount || 0;
      acc.deliveredCount += run.data.deliveredCount || 0;
      acc.readCount += run.data.readCount || 0;
      acc.failedCount += run.data.failedCount || 0;
      return acc;
    },
    { totalRecipients: 0, sentCount: 0, deliveredCount: 0, readCount: 0, failedCount: 0 }
  );

  return { runs, totals };
}

function newRecipientDoc({ phone, leadId, templateName }) {
  return {
    phone,
    leadId: leadId || null,
    status: "pending",
    error: null,
    messageId: null,
    templateName,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
  };
}

// Firestore write-batch hard cap is 500; read this many refs/writes per
// chunk to stay well clear of it (and of getAll's practical limits) while
// still handling large recipient lists in a handful of round trips.
const RECIPIENT_CHUNK_SIZE = 300;

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Adds recipients to a DRAFT campaign. Recipients are only ever added while
 * the campaign is still in draft — once queued/sending, the recipient list
 * is treated as locked so a future sending feature can rely on the totals it
 * read at queue-time never shifting under it.
 *
 * Dedupes by normalized phone number, both within the incoming batch and
 * against recipients already present in the subcollection (re-submitting the
 * same CSV, or calling this twice, is a safe no-op for repeats rather than a
 * duplicate row / double-counted totalRecipients).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} campaignId
 * @param {Array<{phone: string, leadId?: string}>} recipients
 * @returns {Promise<{added: number, skippedDuplicates: number, skippedInvalid: number, totalRecipients: number}>}
 */
async function addRecipientsToCampaign(db, campaignId, recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new CampaignError("'recipients' must be a non-empty array.");
  }

  const campaignRef = campaignsCollection(db).doc(campaignId);
  const campaignSnap = await campaignRef.get();
  if (!campaignSnap.exists) {
    throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
  }
  const campaign = campaignSnap.data();
  if (campaign.status !== "draft") {
    throw new CampaignError(
      `Recipients can only be added while a campaign is in 'draft' status (current status: '${campaign.status}').`,
      "failed_precondition"
    );
  }

  // Normalize + dedupe within the incoming batch itself.
  const seenInBatch = new Set();
  let skippedInvalid = 0;
  const candidates = [];
  for (const r of recipients) {
    const phone = normalizePhone(r && r.phone);
    if (!isValidPhone(phone)) {
      skippedInvalid += 1;
      continue;
    }
    if (seenInBatch.has(phone)) continue;
    seenInBatch.add(phone);
    candidates.push({ phone, leadId: r.leadId || null });
  }

  const col = recipientsCollection(db, campaignId);
  let added = 0;
  let skippedDuplicates = 0;

  for (const chunk of chunkArray(candidates, RECIPIENT_CHUNK_SIZE)) {
    const refs = chunk.map((r) => col.doc(r.phone));
    const existingSnaps = await db.getAll(...refs);

    const batch = db.batch();
    let chunkAdded = 0;
    existingSnaps.forEach((snap, i) => {
      if (snap.exists) {
        skippedDuplicates += 1;
        return;
      }
      const { phone, leadId } = chunk[i];
      batch.set(
        refs[i],
        newRecipientDoc({ phone, leadId, templateName: campaign.templateName })
      );
      chunkAdded += 1;
    });

    if (chunkAdded > 0) {
      await batch.commit();
      added += chunkAdded;
    }
  }

  if (added > 0) {
    await campaignRef.update({
      totalRecipients: admin.firestore.FieldValue.increment(added),
      timeline: admin.firestore.FieldValue.arrayUnion(
        buildTimelineEvent("recipients_added", { added, skippedDuplicates, skippedInvalid })
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  logger.info("campaigns: added recipients", {
    campaignId,
    added,
    skippedDuplicates,
    skippedInvalid,
  });

  return {
    added,
    skippedDuplicates,
    skippedInvalid,
    totalRecipients: campaign.totalRecipients + added,
  };
}

/**
 * Transactionally moves a campaign from its current status to `newStatus`,
 * rejecting the write if that transition isn't in CAMPAIGN_STATUS_TRANSITIONS.
 * Not wired to any endpoint yet — this is the choke point a future
 * queue/send/complete feature will call through, so that logic never has to
 * re-derive "is this transition legal" itself.
 */
async function updateCampaignStatus(db, campaignId, newStatus) {
  if (!CAMPAIGN_STATUSES.includes(newStatus)) {
    throw new CampaignError(`'${newStatus}' is not a valid campaign status.`);
  }

  const campaignRef = campaignsCollection(db).doc(campaignId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) {
      throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
    }
    const currentStatus = snap.data().status;
    const allowed = CAMPAIGN_STATUS_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new CampaignError(
        `Cannot transition campaign from '${currentStatus}' to '${newStatus}'.`,
        "failed_precondition"
      );
    }
    tx.update(campaignRef, {
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    recordCampaignStatusChangeInTx(tx, db, currentStatus, newStatus);
    return { id: campaignId, previousStatus: currentStatus, status: newStatus };
  });
}

/**
 * Transactionally moves a DRAFT campaign to "queued" and stamps launch
 * bookkeeping (queuedAt/queuedBy/lastValidatedAt/validationSummary) plus a
 * "queued" timeline event, all in one write.
 *
 * This does NOT perform the actual launch-eligibility checks (recipient
 * count, template approval) — those require reading `whatsappTemplates`,
 * and campaigns.js deliberately has no dependency on whatsappTemplates.js
 * (see whatsappTemplates.js's own note on why the reverse dependency exists
 * instead). The caller — launchCampaign.js — is expected to have already
 * run those checks and pass in the resulting `validationSummary`. This
 * function only re-checks the two preconditions it CAN verify from the
 * campaign doc alone (status is still 'draft', recipients still present) —
 * this closes the race window transactionally so a second concurrent
 * launch request, or a request racing an in-flight recipient removal
 * feature, can never double-queue a campaign or queue an empty one, even
 * though the template's approval status is only checked pre-transaction.
 *
 * @param {string} campaignId
 * @param {object} [opts]
 * @param {string} [opts.queuedBy] Free-text actor identifier (no auth system
 *   yet — mirrors sendManualMessage.js's sentBy: "human" convention).
 * @param {object} [opts.validationSummary] Snapshot of what was validated,
 *   for display on the campaign detail page.
 */
async function launchCampaign(db, campaignId, { queuedBy, validationSummary } = {}) {
  const campaignRef = campaignsCollection(db).doc(campaignId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) {
      throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
    }
    const campaign = snap.data();

    const allowed = CAMPAIGN_STATUS_TRANSITIONS[campaign.status] || [];
    if (campaign.status !== "draft" || !allowed.includes("queued")) {
      throw new CampaignError(
        `Cannot launch — campaign is '${campaign.status}', not 'draft'.`,
        "failed_precondition"
      );
    }
    if (!campaign.totalRecipients || campaign.totalRecipients < 1) {
      throw new CampaignError(
        "Cannot launch — campaign has no recipients.",
        "failed_precondition"
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(campaignRef, {
      status: "queued",
      queuedAt: now,
      queuedBy: queuedBy || null,
      lastValidatedAt: now,
      validationSummary: validationSummary || null,
      // Seeded here (not in newCampaignDoc) because this is the moment
      // "how many recipients still need a Cloud Task" first becomes
      // meaningful — see the field's doc comment in newCampaignDoc.
      remainingCount: campaign.totalRecipients,
      timeline: admin.firestore.FieldValue.arrayUnion(
        buildTimelineEvent("queued", { queuedBy: queuedBy || null })
      ),
      updatedAt: now,
    });
    recordCampaignStatusChangeInTx(tx, db, "draft", "queued");

    return { id: campaignId, previousStatus: "draft", status: "queued" };
  });
}

/**
 * Transactionally pauses a campaign that's currently "queued" (dispatch
 * still creating tasks) or "sending" (a future feature). Stamps
 * `pausedFrom` with whichever of those it actually was, so resumeCampaign()
 * knows where to return it to.
 *
 * FIRESTORE STATE ONLY — this does not touch Cloud Tasks or the recipient
 * subcollection. It does not stop tasks already created from firing (there's
 * no worker consuming them yet in this phase anyway — see campaignQueue.js's
 * file header), nor does it stop an in-progress dispatch loop from finishing
 * its current chunk. It's the authoritative signal a future dispatch-loop
 * time-budget check and the future sending worker are both expected to
 * consult before doing more work — see campaignQueue.js's
 * dispatchCampaignQueue, which already checks `status === "queued"` before
 * each chunk and treats anything else as "nothing to do", which is what
 * makes pausing mid-dispatch actually take effect within one loop
 * iteration.
 */
async function pauseCampaign(db, campaignId, { pausedBy } = {}) {
  const campaignRef = campaignsCollection(db).doc(campaignId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) {
      throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
    }
    const campaign = snap.data();
    const allowed = CAMPAIGN_STATUS_TRANSITIONS[campaign.status] || [];
    if (!allowed.includes("paused")) {
      throw new CampaignError(
        `Cannot pause — campaign is '${campaign.status}', not 'queued' or 'sending'.`,
        "failed_precondition"
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(campaignRef, {
      status: "paused",
      pausedFrom: campaign.status,
      pausedAt: now,
      pausedBy: pausedBy || null,
      timeline: admin.firestore.FieldValue.arrayUnion(
        buildTimelineEvent("paused", { pausedFrom: campaign.status, pausedBy: pausedBy || null })
      ),
      updatedAt: now,
    });
    recordCampaignStatusChangeInTx(tx, db, campaign.status, "paused");

    return { id: campaignId, previousStatus: campaign.status, status: "paused" };
  });
}

/**
 * Transactionally resumes a "paused" campaign back to whichever status it
 * was paused from (`pausedFrom`, stamped by pauseCampaign above). Falls back
 * to "queued" if `pausedFrom` is somehow missing (defensive only — every
 * paused campaign should have it) rather than throwing, since "queued" is
 * the safer of the two possible targets to resume into.
 */
async function resumeCampaign(db, campaignId, { resumedBy } = {}) {
  const campaignRef = campaignsCollection(db).doc(campaignId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) {
      throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
    }
    const campaign = snap.data();
    if (campaign.status !== "paused") {
      throw new CampaignError(
        `Cannot resume — campaign is '${campaign.status}', not 'paused'.`,
        "failed_precondition"
      );
    }

    const target = campaign.pausedFrom === "sending" ? "sending" : "queued";
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(campaignRef, {
      status: target,
      pausedFrom: admin.firestore.FieldValue.delete(),
      resumedAt: now,
      resumedBy: resumedBy || null,
      timeline: admin.firestore.FieldValue.arrayUnion(
        buildTimelineEvent("resumed", { resumedTo: target, resumedBy: resumedBy || null })
      ),
      updatedAt: now,
    });
    recordCampaignStatusChangeInTx(tx, db, "paused", target);

    return { id: campaignId, previousStatus: "paused", status: target };
  });
}

/**
 * Transactionally cancels a campaign from any non-terminal state (draft,
 * queued, sending, or paused). FIRESTORE STATE ONLY, same posture as
 * pauseCampaign above — deleting the underlying Cloud Tasks for
 * not-yet-sent recipients is a separate, best-effort step the endpoint layer
 * (campaignControl.js) performs after this succeeds, exactly like
 * launchCampaign.js keeps the template-approval check outside campaigns.js.
 */
async function cancelCampaign(db, campaignId, { cancelledBy } = {}) {
  const campaignRef = campaignsCollection(db).doc(campaignId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) {
      throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
    }
    const campaign = snap.data();
    const allowed = CAMPAIGN_STATUS_TRANSITIONS[campaign.status] || [];
    if (!allowed.includes("cancelled")) {
      throw new CampaignError(
        `Cannot cancel — campaign is '${campaign.status}' and cancellation isn't allowed from that state.`,
        "failed_precondition"
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(campaignRef, {
      status: "cancelled",
      cancelledAt: now,
      cancelledBy: cancelledBy || null,
      cancelledFrom: campaign.status,
      timeline: admin.firestore.FieldValue.arrayUnion(
        buildTimelineEvent("cancelled", { cancelledFrom: campaign.status, cancelledBy: cancelledBy || null })
      ),
      updatedAt: now,
    });
    recordCampaignStatusChangeInTx(tx, db, campaign.status, "cancelled");

    return { id: campaignId, previousStatus: campaign.status, status: "cancelled" };
  });
}

/**
 * Transactionally moves ONE recipient to `newStatus`, stamping the
 * corresponding timestamp field and incrementing the matching campaign
 * counter in the same transaction (so counters can never drift out of sync
 * with the recipient docs they're derived from).
 *
 * NOT CALLED ANYWHERE YET — this is the integration point a future sending
 * feature (actual WhatsApp send + delivery-status webhook handling) will use.
 * Exposed now so that feature doesn't need to touch the campaign-counter
 * logic at all, only decide *when* a recipient's status should change.
 *
 * @param {string} [error] Required when newStatus === "failed".
 */
async function applyRecipientStatusUpdate(db, campaignId, recipientId, newStatus, { error, messageId } = {}) {
  if (!RECIPIENT_STATUSES.includes(newStatus)) {
    throw new CampaignError(`'${newStatus}' is not a valid recipient status.`);
  }

  const recipientRef = recipientsCollection(db, campaignId).doc(recipientId);
  const campaignRef = campaignsCollection(db).doc(campaignId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(recipientRef);
    if (!snap.exists) {
      throw new CampaignError(`Recipient '${recipientId}' not found in campaign '${campaignId}'.`, "not_found");
    }
    const currentStatus = snap.data().status;
    const allowed = RECIPIENT_STATUS_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new CampaignError(
        `Cannot transition recipient from '${currentStatus}' to '${newStatus}'.`,
        "failed_precondition"
      );
    }

    const meta = RECIPIENT_STATUS_META[newStatus];
    const updates = { status: newStatus };
    if (meta.timestampField) {
      updates[meta.timestampField] = admin.firestore.FieldValue.serverTimestamp();
    }
    if (newStatus === "failed") {
      updates.error = error || "Unknown error";
    }
    if (messageId) {
      updates.messageId = messageId;
    }
    tx.update(recipientRef, updates);

    if (meta.counterField) {
      tx.update(campaignRef, {
        [meta.counterField]: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    // METRICS: only ever reached for a LEGAL transition (the allowed-list
    // check above already threw otherwise), so this fires exactly once per
    // real delivered/read/failed status webhook — "sent" is intentionally
    // not tracked here, see metrics.js's TRACKED_WHATSAPP_STATUSES comment.
    recordWhatsAppStatusInTx(tx, db, newStatus);

    return { id: recipientId, previousStatus: currentStatus, status: newStatus };
  });
}

/**
 * Best-effort completion check. If a "sending" campaign has no recipients
 * left outstanding — every recipient has at least had one send attempt
 * resolved, i.e. `sentCount + failedCount` has caught up to
 * `totalRecipients` — transitions it to "completed" and appends a timeline
 * event. No-ops (returns null) if the campaign isn't "sending" yet, or still
 * has recipients left pending/queued.
 *
 * Not triggered by a poll/cron — processCampaignRecipient.js calls this
 * after every recipient outcome is recorded, so a campaign's status reflects
 * reality (the same "call it right after the state that could make it true
 * changes" posture as its own best-effort queued->sending flip) without a
 * separate completion-detection job. "completed" here means every send was
 * *attempted*, not that every message was delivered/read — sent/delivered/
 * read recipients all count as resolved, since delivery/read status can
 * still update later via webhook without the campaign itself needing to
 * stay "sending".
 */
async function completeCampaignIfFinished(db, campaignId) {
  const campaignRef = campaignsCollection(db).doc(campaignId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) return null;
    const campaign = snap.data();

    if (campaign.status !== "sending") return null;

    const resolved = (campaign.sentCount || 0) + (campaign.failedCount || 0);
    if (resolved < (campaign.totalRecipients || 0)) return null;

    const allowed = CAMPAIGN_STATUS_TRANSITIONS[campaign.status] || [];
    if (!allowed.includes("completed")) return null;

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(campaignRef, {
      status: "completed",
      completedAt: now,
      timeline: admin.firestore.FieldValue.arrayUnion(buildTimelineEvent("completed")),
      updatedAt: now,
    });
    recordCampaignStatusChangeInTx(tx, db, "sending", "completed");

    return { id: campaignId, previousStatus: "sending", status: "completed" };
  });
}

module.exports = {
  CAMPAIGN_TYPES,
  CAMPAIGN_STATUSES,
  RECIPIENT_STATUSES,
  CAMPAIGN_STATUS_TRANSITIONS,
  RECIPIENT_STATUS_TRANSITIONS,
  CAMPAIGN_TIMELINE_EVENT_TYPES,
  CampaignError,
  campaignsCollection,
  recipientsCollection,
  normalizePhone,
  isValidPhone,
  validateCampaignInput,
  buildTimelineEvent,
  newCampaignDoc,
  newRecipientDoc,
  createCampaign,
  getCampaign,
  getNextRunNumber,
  getCampaignLineage,
  addRecipientsToCampaign,
  updateCampaignStatus,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  applyRecipientStatusUpdate,
  completeCampaignIfFinished,
};
