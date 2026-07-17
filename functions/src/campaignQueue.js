const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const {
  CAMPAIGN_DISPATCH_TIMEOUT_SECONDS,
  CAMPAIGN_DISPATCH_TIME_BUDGET_BUFFER_MS,
  CAMPAIGN_DISPATCH_CHUNK_SIZE,
  CAMPAIGN_DISPATCH_LOCK_STALE_MS,
} = require("./config");
const { campaignsCollection, recipientsCollection, CampaignError } = require("./campaigns");
const { assertTemplateApprovedForCampaign } = require("./whatsappTemplates");
const {
  createCampaignRecipientTask,
  deleteCampaignRecipientTask,
  createCampaignDispatchTask,
} = require("./cloudTasks");
const { agencyCollection } = require("./tenancy");

/**
 * CAMPAIGN QUEUE ENGINE
 * ---------------------------------------------------------------------------
 * Turns a "queued" campaign's recipient list into one Cloud Task per
 * recipient. THIS FILE IS FOUNDATION ONLY, same posture as campaigns.js:
 *   - No WhatsApp Cloud API calls anywhere in this file — that lives in
 *     processCampaignRecipient.js, the worker these tasks point at.
 *
 * TRIGGER: this codebase has no Firestore-trigger (onDocumentUpdated)
 * functions anywhere — every side effect is driven by an explicit HTTP call
 * (webhook, Cloud Task, or direct in-process function call). So "when a
 * campaign becomes queued" is implemented the same way: launchCampaign.js
 * calls dispatchCampaignQueue() directly, in-process, immediately after its
 * own transaction flips the campaign to "queued", rather than introducing a
 * Firestore trigger as a one-off exception to how the rest of the codebase
 * is wired.
 *
 * IDEMPOTENCY — "launching twice must never create duplicate tasks" is
 * actually two separate races, closed by two separate mechanisms:
 *
 *   1. Launching twice. Already impossible before this file is ever
 *      reached: launchCampaign() in campaigns.js only allows draft ->
 *      queued, so a second launch attempt on an already-queued campaign is
 *      rejected with a 409 by the transaction itself. dispatchCampaignQueue
 *      is simply never called a second time via that path.
 *
 *   2. Dispatch itself running twice for the same campaign (e.g. the
 *      automatic post-launch call racing a manual "retry dispatch" request,
 *      or a crashed run being retried). Closed here via two layers, matching
 *      dispatcher.js's own documented preference for Firestore-transactional
 *      correctness over relying on Cloud Tasks' named-task dedup as the
 *      primary mechanism (see that file's header comment):
 *
 *        a. A campaign-level dispatch lock (`campaignDispatchLocks/{id}`),
 *           acquired transactionally exactly like dispatcher.js's per-phone
 *           lock. Only one execution can be actively enqueueing a given
 *           campaign's recipients at a time.
 *        b. A per-recipient gate: only recipients still `status: "pending"`
 *           are ever considered. A recipient flips to `status: "queued"` in
 *           the same batch write that follows its Cloud Task's creation, so
 *           a retried dispatch run (lock released, re-triggered after a
 *           crash) naturally skips every recipient already queued and only
 *           picks up the remainder.
 *
 *      The one gap those two can't fully close alone: a crash between
 *      "Cloud Task created" and "Firestore write recording it" would, on
 *      retry, see the recipient still `pending` and call createTask again.
 *      cloudTasks.js's deterministic task naming is the backstop for that
 *      specific window — Cloud Tasks rejects the second create
 *      (ALREADY_EXISTS), which createCampaignRecipientTask treats as
 *      success. So (a)+(b) are the primary correctness mechanism, and named-
 *      task dedup is a secondary backstop for one narrow crash window, not
 *      the source of truth — the same division of responsibility
 *      dispatcher.js draws for its own, different problem.
 */

function dispatchLockRef(db, agencyId, campaignId) {
  return agencyCollection(db, agencyId, "campaignDispatchLocks").doc(campaignId);
}

async function tryAcquireDispatchLock(db, agencyId, campaignId) {
  const ref = dispatchLockRef(db, agencyId, campaignId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;

    if (data?.active) {
      const lockedAtMs = data.lockedAt?.toMillis ? data.lockedAt.toMillis() : 0;
      const isStale = Date.now() - lockedAtMs > CAMPAIGN_DISPATCH_LOCK_STALE_MS;
      if (!isStale) {
        return false; // healthy lock held by another execution
      }
      logger.warn("campaignQueue: stealing stale dispatch lock", { campaignId, lockedAtMs });
    }

    tx.set(ref, { active: true, lockedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
}

async function releaseDispatchLock(db, agencyId, campaignId) {
  await dispatchLockRef(db, agencyId, campaignId).set(
    { active: false, lockedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function heartbeatDispatchLock(db, agencyId, campaignId) {
  await dispatchLockRef(db, agencyId, campaignId).set(
    { active: true, lockedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/**
 * Payload stored on the Cloud Task body. Snapshotted from the template at
 * enqueue time (not re-read at send time) for the same reason
 * launchCampaign.js snapshots `validationSummary` — the future worker
 * shouldn't need a template lookup mid-send just to know what to send, and
 * shouldn't be affected by the template changing after this recipient was
 * already queued.
 */
function buildTaskPayload({ campaignId, agencyId, recipientId, phone, template, attempt }) {
  return {
    campaignId,
    agencyId,
    recipientId,
    phone,
    templateId: template.templateId || null,
    templateName: template.name,
    language: template.language,
    variables: template.variables || [],
    attempt,
    createdAt: Date.now(),
  };
}

/**
 * Creates tasks + writes recipient/campaign state for one chunk of
 * still-pending recipients. A single recipient's Cloud Tasks failure (not
 * ALREADY_EXISTS, which createCampaignRecipientTask already absorbs) is
 * logged and skipped rather than thrown — that recipient simply stays
 * "pending" and gets picked up by the next dispatch run, instead of one bad
 * recipient aborting the whole chunk.
 */
async function enqueueChunk(db, agencyId, campaignId, projectId, recipientDocs, template) {
  const campaignRef = campaignsCollection(db, agencyId).doc(campaignId);
  const attempt = 1; // this phase only ever does the first attempt
  const batch = db.batch();
  let enqueuedInChunk = 0;
  let failedInChunk = 0;

  for (const doc of recipientDocs) {
    const recipientId = doc.id;
    const recipient = doc.data();

    let taskResult;
    try {
      taskResult = await createCampaignRecipientTask({
        projectId,
        agencyId,
        campaignId,
        recipientId,
        attempt,
        payload: buildTaskPayload({ campaignId, agencyId, recipientId, phone: recipient.phone, template, attempt }),
      });
    } catch (err) {
      logger.error("campaignQueue: failed to create task for recipient", {
        campaignId,
        recipientId,
        error: err.message,
      });
      failedInChunk += 1;
      continue;
    }

    batch.update(doc.ref, {
      status: "queued",
      queuedAt: admin.firestore.FieldValue.serverTimestamp(),
      taskName: taskResult.taskName,
    });
    enqueuedInChunk += 1;
  }

  if (enqueuedInChunk > 0) {
    await batch.commit();
    await campaignRef.update({
      queuedCount: admin.firestore.FieldValue.increment(enqueuedInChunk),
      remainingCount: admin.firestore.FieldValue.increment(-enqueuedInChunk),
      taskCount: admin.firestore.FieldValue.increment(enqueuedInChunk),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  if (failedInChunk > 0) {
    logger.warn("campaignQueue: some recipients failed to enqueue this chunk, will retry on next dispatch", {
      campaignId,
      failedInChunk,
    });
  }

  return enqueuedInChunk;
}

/**
 * Enqueues one Cloud Task per still-pending recipient of a "queued"
 * campaign. Safe to call more than once for the same campaign (see file
 * header) — repeated calls just pick up wherever the previous run left off.
 *
 * Processes recipients in a time-boxed loop and chains a continuation Cloud
 * Task (same pattern as processPhoneQueue.js) if a very large recipient list
 * can't finish inside one invocation, so this never risks a hard timeout
 * mid-chunk with the lock left dangling.
 *
 * @returns {Promise<object>} one of:
 *   { skipped: true, status }        campaign isn't "queued" (nothing to do)
 *   { skipped: true, reason: "lock_held" }  another run is already dispatching
 *   { chained: true, enqueuedThisRun }      ran out of time budget, handed off
 *   { done: true, enqueuedThisRun }         every pending recipient enqueued
 */
async function dispatchCampaignQueue(db, agencyId, campaignId, projectId, { startedAt = Date.now() } = {}) {
  const campaignRef = campaignsCollection(db, agencyId).doc(campaignId);
  const campaignSnap = await campaignRef.get();
  if (!campaignSnap.exists) {
    throw new CampaignError(`Campaign '${campaignId}' not found.`, "not_found");
  }
  const campaign = campaignSnap.data();

  if (campaign.status !== "queued") {
    // Not an error — covers a campaign paused/cancelled/moved on since this
    // dispatch was triggered, and a stray duplicate trigger firing after a
    // previous run already finished. Nothing left to do here either way.
    logger.info("campaignQueue: skipping dispatch, campaign not queued", {
      campaignId,
      status: campaign.status,
    });
    return { skipped: true, status: campaign.status };
  }

  // Re-validated here (not just trusted from launch time) in case the
  // template's approval status changed between launch and dispatch — same
  // check launchCampaign.js already ran, reused rather than re-derived.
  const template = await assertTemplateApprovedForCampaign(db, {
    templateName: campaign.templateName,
    templateLanguage: campaign.templateLanguage,
  });

  const gotLock = await tryAcquireDispatchLock(db, agencyId, campaignId);
  if (!gotLock) {
    logger.info("campaignQueue: dispatch already in progress for this campaign, skipping", { campaignId });
    return { skipped: true, reason: "lock_held" };
  }

  let enqueuedThisRun = 0;

  // Deliberately NOT a try/finally that unconditionally releases the lock —
  // `finally` runs on every exit path including the chained-handoff return
  // below, and that path must leave the lock HELD (the chained task
  // continues holding it, same convention as processPhoneQueue.js's own
  // time-budget handoff). So release is explicit on exactly the two paths
  // that should actually free it: falling out of the loop normally, and an
  // unexpected error (nothing else will ever pick this campaign back up
  // otherwise, since no continuation was scheduled).
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startedAt > CAMPAIGN_DISPATCH_TIMEOUT_SECONDS * 1000 - CAMPAIGN_DISPATCH_TIME_BUDGET_BUFFER_MS) {
        logger.info("campaignQueue: time budget exhausted, chaining", { campaignId, enqueuedThisRun });
        await createCampaignDispatchTask(campaignId, agencyId, projectId);
        return { chained: true, enqueuedThisRun };
      }

      const pendingSnap = await recipientsCollection(db, agencyId, campaignId)
        .where("status", "==", "pending")
        .limit(CAMPAIGN_DISPATCH_CHUNK_SIZE)
        .get();

      if (pendingSnap.empty) {
        break;
      }

      enqueuedThisRun += await enqueueChunk(db, agencyId, campaignId, projectId, pendingSnap.docs, template);
      await heartbeatDispatchLock(db, agencyId, campaignId);
    }

    await releaseDispatchLock(db, agencyId, campaignId);
    logger.info("campaignQueue: dispatch complete", { campaignId, enqueuedThisRun });
    return { done: true, enqueuedThisRun };
  } catch (err) {
    await releaseDispatchLock(db, agencyId, campaignId);
    throw err;
  }
}

/**
 * Best-effort cancellation cleanup: deletes the not-yet-run Cloud Task for
 * every recipient still `status: "queued"` on a campaign that's just been
 * cancelled. Never throws — a task that already fired, already ran, or
 * already aged out of the queue is deleted anyway (NOT_FOUND from Cloud
 * Tasks, absorbed by deleteCampaignRecipientTask as a non-error), and a
 * genuine per-task failure is logged and counted, not allowed to abort
 * cleanup for the remaining recipients. Recipient docs are left as
 * `status: "queued"` — a historical record that they WERE queued before
 * cancellation — since campaign.status === "cancelled" is the authoritative
 * signal the future sending worker checks before ever acting on a task, not
 * the recipient's own status.
 */
async function cancelQueuedTasks(db, agencyId, campaignId) {
  const snap = await recipientsCollection(db, agencyId, campaignId).where("status", "==", "queued").get();

  let attempted = 0;
  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const { taskName } = doc.data();
    if (!taskName) continue;
    attempted += 1;
    try {
      const result = await deleteCampaignRecipientTask(taskName);
      if (result.deleted) deleted += 1;
      else if (result.alreadyGone) alreadyGone += 1;
    } catch (err) {
      failed += 1;
      logger.warn("campaignQueue: failed to delete task during cancel cleanup", {
        campaignId,
        recipientId: doc.id,
        taskName,
        error: err.message,
      });
    }
  }

  logger.info("campaignQueue: cancel task cleanup done", { campaignId, attempted, deleted, alreadyGone, failed });
  return { attempted, deleted, alreadyGone, failed };
}

module.exports = {
  dispatchCampaignQueue,
  cancelQueuedTasks,
  buildTaskPayload,
};
