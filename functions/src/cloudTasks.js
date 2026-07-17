const { CloudTasksClient } = require("@google-cloud/tasks");
const { REGION, FOLLOWUP_QUEUE_NAME, MESSAGE_QUEUE_NAME, CAMPAIGN_QUEUE_NAME } = require("./config");

// grpc status codes returned on CloudTasksClient errors (google-gax surfaces
// these as err.code). Referenced by name below instead of importing a
// separate constants package, since only these two are ever checked.
const GRPC_ALREADY_EXISTS = 6;
const GRPC_NOT_FOUND = 5;

const tasksClient = new CloudTasksClient();

/**
 * Enqueues a Cloud Task that calls `functionName` almost immediately (no
 * delay). Used to hand off the actual heavy lifting (Firestore + LLM +
 * WhatsApp send) from the webhook handler, which needs to return 200 to
 * Meta within a few seconds or risk duplicate-delivery retries.
 */
async function createImmediateTask(functionName, payload, projectId) {
  const parent = tasksClient.queuePath(projectId, REGION, MESSAGE_QUEUE_NAME);
  const targetUrl = `https://${REGION}-${projectId}.cloudfunctions.net/${functionName}`;

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: targetUrl,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      oidcToken: {
        serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
      },
    },
  };

  const [response] = await tasksClient.createTask({ parent, task });
  return response;
}

/**
 * Creates a single Cloud Task that will call the `followupCheck` HTTPS
 * function exactly 24 hours from now for one specific lead. This is
 * deliberately one precisely-scheduled task per lead rather than a
 * recurring cron job that scans every lead.
 *
 * @param {string} phone Lead's phone number (also the Firestore doc id).
 * @param {string} projectId GCP project id (from process.env.GCLOUD_PROJECT).
 */
async function createFollowupTask(phone, agencyId, projectId) {
  const parent = tasksClient.queuePath(projectId, REGION, FOLLOWUP_QUEUE_NAME);

  // Cloud Functions 2nd gen HTTPS endpoints are Cloud Run services under the
  // hood, addressable at this URL pattern once deployed.
  const followupUrl = `https://${REGION}-${projectId}.cloudfunctions.net/followupCheck`;

  const scheduleTimeSeconds = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: followupUrl,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ phone, agencyId })).toString("base64"),
      // OIDC token lets Cloud Tasks authenticate as this service account so
      // followupCheck can require authenticated invocations (not open to the
      // public internet) while still being callable by the queue.
      oidcToken: {
        serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
      },
    },
    scheduleTime: { seconds: scheduleTimeSeconds },
  };

  const [response] = await tasksClient.createTask({ parent, task });
  return response;
}

/**
 * Enqueues (or re-enqueues/chains) the drain task for one phone's message
 * queue. Used by whatsappWebhook (first message after the phone was idle),
 * and by processPhoneQueue itself to (a) chain into a fresh execution when
 * it's running low on its time budget but the inbox isn't empty yet, and
 * (b) back off before retrying after a transient failure.
 *
 * @param {string} phone
 * @param {string} projectId
 * @param {number} [delaySeconds] If >0, schedules the task instead of firing
 *   immediately — used for retry backoff, never for the time-budget handoff
 *   case (that one should run right away).
 */
async function createPhoneQueueTask(phone, agencyId, projectId, delaySeconds = 0) {
  const parent = tasksClient.queuePath(projectId, REGION, MESSAGE_QUEUE_NAME);
  const targetUrl = `https://${REGION}-${projectId}.cloudfunctions.net/processPhoneQueue`;

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: targetUrl,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ phone, agencyId })).toString("base64"),
      oidcToken: {
        serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
      },
    },
  };

  if (delaySeconds > 0) {
    task.scheduleTime = { seconds: Math.floor(Date.now() / 1000) + delaySeconds };
  }

  const [response] = await tasksClient.createTask({ parent, task });
  return response;
}

// ── Campaign queue engine ───────────────────────────────────────────────

/**
 * Deterministic full resource name for one recipient's Nth send attempt.
 * Passing this as `task.name` on create (rather than letting Cloud Tasks
 * generate a random ID) means a second createTask call for the exact same
 * recipient+attempt is rejected as ALREADY_EXISTS instead of creating a
 * second, independent task.
 *
 * This is a defense-in-depth backstop for one specific crash window (task
 * created, then the process dies before Firestore records it — see
 * campaignQueue.js's file header), NOT the primary idempotency mechanism.
 * dispatcher.js's own header comment already notes GCP doesn't recommend
 * relying on named-task dedup alone for correctness-critical exactly-once
 * guarantees, and campaignQueue.js follows that same guidance: the dispatch
 * lock + "only enqueue recipients still pending" gate are what actually make
 * repeat dispatch runs safe.
 */
function campaignRecipientTaskName(projectId, agencyId, campaignId, recipientId, attempt) {
  const taskId = `camp-${agencyId}-${campaignId}-${recipientId}-a${attempt}`;
  return `projects/${projectId}/locations/${REGION}/queues/${CAMPAIGN_QUEUE_NAME}/tasks/${taskId}`;
}

/**
 * Creates the Cloud Task for one campaign recipient's send attempt. Points
 * at `processCampaignRecipient` (processCampaignRecipient.js) — the worker
 * that actually calls the WhatsApp Cloud API for this recipient.
 *
 * Treats ALREADY_EXISTS as a successful, idempotent no-op (see
 * campaignRecipientTaskName above) rather than throwing — the caller doesn't
 * need to know whether this call created the task or found it already
 * there, only that it now exists.
 */
async function createCampaignRecipientTask({ projectId, agencyId, campaignId, recipientId, attempt, payload }) {
  const parent = tasksClient.queuePath(projectId, REGION, CAMPAIGN_QUEUE_NAME);
  const targetUrl = `https://${REGION}-${projectId}.cloudfunctions.net/processCampaignRecipient`;
  const name = campaignRecipientTaskName(projectId, agencyId, campaignId, recipientId, attempt);

  const task = {
    name,
    httpRequest: {
      httpMethod: "POST",
      url: targetUrl,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      oidcToken: {
        serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
      },
    },
  };

  try {
    const [response] = await tasksClient.createTask({ parent, task });
    return { created: true, taskName: response.name };
  } catch (err) {
    if (err.code === GRPC_ALREADY_EXISTS) {
      return { created: false, alreadyExisted: true, taskName: name };
    }
    throw err;
  }
}

/**
 * Best-effort delete of one recipient's not-yet-run Cloud Task (used by
 * campaign cancellation). NOT_FOUND — the task already ran, was already
 * deleted, or aged out — is treated as a successful outcome, not an error:
 * the caller only cares that the task is no longer pending, and "already
 * gone" satisfies that just as well as "we just deleted it".
 */
async function deleteCampaignRecipientTask(taskName) {
  try {
    await tasksClient.deleteTask({ name: taskName });
    return { deleted: true };
  } catch (err) {
    if (err.code === GRPC_NOT_FOUND) {
      return { deleted: false, alreadyGone: true };
    }
    throw err;
  }
}

/**
 * Enqueues a continuation of the dispatch loop itself (dispatchCampaignQueue
 * calling back into dispatchCampaignQueue). Used only when one invocation's
 * time budget runs out partway through a large recipient list — same
 * self-chaining pattern as createPhoneQueueTask/processPhoneQueue.js. No
 * explicit task name: duplicate continuations are harmless (the dispatch
 * lock + pending-recipient gate make a second concurrent/redundant dispatch
 * run a safe no-op), so there's nothing to dedupe here.
 */
async function createCampaignDispatchTask(campaignId, agencyId, projectId, delaySeconds = 0) {
  const parent = tasksClient.queuePath(projectId, REGION, CAMPAIGN_QUEUE_NAME);
  const targetUrl = `https://${REGION}-${projectId}.cloudfunctions.net/dispatchCampaignQueue`;

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: targetUrl,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ campaignId, agencyId })).toString("base64"),
      oidcToken: {
        serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
      },
    },
  };

  if (delaySeconds > 0) {
    task.scheduleTime = { seconds: Math.floor(Date.now() / 1000) + delaySeconds };
  }

  const [response] = await tasksClient.createTask({ parent, task });
  return response;
}

module.exports = {
  createFollowupTask,
  createImmediateTask,
  createPhoneQueueTask,
  campaignRecipientTaskName,
  createCampaignRecipientTask,
  deleteCampaignRecipientTask,
  createCampaignDispatchTask,
};
