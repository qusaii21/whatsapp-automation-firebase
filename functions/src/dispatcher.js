const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const { DISPATCHER_STALE_LOCK_MS } = require("./config");

/**
 * PHASE 1 — per-phone sequential processing.
 *
 * Problem being solved: previously, every inbound WhatsApp message created
 * its own independent Cloud Task calling processIncomingMessage directly.
 * Cloud Tasks does NOT guarantee ordering or non-concurrency across tasks in
 * a queue, so four rapid messages from one lead ("Hi" / "Need 2 BHK" /
 * "Budget 80 lakh" / "Baner") could dispatch to four concurrent executions,
 * each reading `leads/{phone}` before any of the others had written back —
 * producing replies built from stale/incomplete context, or history entries
 * that land out of order.
 *
 * Fix: messages are no longer processed directly by the webhook. Instead:
 *   1. The webhook appends the message to `leads/{phone}/inbox` (a real FIFO
 *      queue, ordered by server timestamp).
 *   2. The webhook then tries to atomically acquire a per-phone dispatcher
 *      lock (`dispatcherLocks/{phone}`). Only the delivery that successfully
 *      flips the lock from free -> held enqueues a Cloud Task; every other
 *      concurrent/rapid delivery just appends to the inbox and returns,
 *      trusting the already-running drain loop to pick their item up.
 *   3. The drain loop (processPhoneQueue.js) processes inbox items ONE AT A
 *      TIME, oldest first, and only releases the lock once it has verified
 *      — inside the SAME transaction that flips the lock back to free —
 *      that no new item slipped in during the gap between "queue looked
 *      empty" and "lock released".
 *
 * This guarantees exactly one active processor per phone number at any time,
 * with messages handled in arrival order, without provisioning a Cloud Tasks
 * queue per phone (operationally expensive and quota-limited) and without
 * relying on Cloud Tasks named-task dedup (explicitly not recommended by GCP
 * for correctness-critical exactly-once/ordering guarantees).
 */

function lockRef(db, phone) {
  return db.collection("dispatcherLocks").doc(phone);
}

function inboxCollection(db, phone) {
  return db.collection("leads").doc(phone).collection("inbox");
}

/**
 * Adds a message to the phone's FIFO inbox. Idempotent per messageId (the
 * caller is expected to have already deduped via processedMessages before
 * calling this — see whatsappWebhook.js).
 */
async function enqueueInboxItem(db, phone, { messageId, text, contactName }) {
  await inboxCollection(db, phone).doc(messageId).set(
    {
      text,
      contactName: contactName || null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      attempts: 0,
    },
    { merge: true }
  );
}

/**
 * Attempts to become the sole active dispatcher for this phone number.
 * Returns true if the caller won the lock (and is therefore responsible for
 * enqueueing the drain Cloud Task), false if someone else already holds it
 * (and is therefore responsible for eventually seeing this item).
 *
 * A lock held longer than DISPATCHER_STALE_LOCK_MS is treated as abandoned
 * (crashed execution that never reached the release step) and can be stolen
 * — this is what prevents a crash from permanently wedging one phone's
 * conversation.
 */
async function tryAcquireLock(db, phone) {
  const ref = lockRef(db, phone);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;

    if (data?.active) {
      const lockedAtMs = data.lockedAt?.toMillis ? data.lockedAt.toMillis() : 0;
      const isStale = Date.now() - lockedAtMs > DISPATCHER_STALE_LOCK_MS;
      if (!isStale) {
        return false; // healthy lock held by another execution — do nothing
      }
      logger.warn("dispatcher: stealing stale lock", { phone, lockedAtMs });
    }

    tx.set(ref, { active: true, lockedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
}

/**
 * Called by the drain loop when it believes the inbox is empty. Re-checks
 * emptiness INSIDE the transaction that would release the lock, so a message
 * that arrives in the split second between "loop saw empty" and "lock
 * released" can never be stranded with the lock already free and no drain
 * task coming to claim it.
 *
 * Returns { released: true } if the lock was freed, or
 * { released: false } if a new item was found (caller should keep draining).
 */
async function tryReleaseLock(db, phone) {
  const ref = lockRef(db, phone);
  const inbox = inboxCollection(db, phone);

  return db.runTransaction(async (tx) => {
    // Firestore transactions require all reads before writes, and query
    // reads inside transactions are supported for this simple case.
    const pending = await tx.get(inbox.orderBy("receivedAt").limit(1));
    if (!pending.empty) {
      return { released: false };
    }
    tx.set(ref, { active: false, lockedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { released: true };
  });
}

/**
 * Refreshes the lock's lockedAt timestamp without changing its held state.
 * Called periodically during a long drain so a legitimately-still-running
 * execution never gets mistaken for a crashed one by the staleness check.
 */
async function heartbeatLock(db, phone) {
  await lockRef(db, phone).set(
    { active: true, lockedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

module.exports = {
  inboxCollection,
  enqueueInboxItem,
  tryAcquireLock,
  tryReleaseLock,
  heartbeatLock,
};
