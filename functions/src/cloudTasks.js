const { CloudTasksClient } = require("@google-cloud/tasks");
const { REGION, FOLLOWUP_QUEUE_NAME, MESSAGE_QUEUE_NAME } = require("./config");

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
async function createFollowupTask(phone, projectId) {
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
      body: Buffer.from(JSON.stringify({ phone })).toString("base64"),
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
async function createPhoneQueueTask(phone, projectId, delaySeconds = 0) {
  const parent = tasksClient.queuePath(projectId, REGION, MESSAGE_QUEUE_NAME);
  const targetUrl = `https://${REGION}-${projectId}.cloudfunctions.net/processPhoneQueue`;

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: targetUrl,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ phone })).toString("base64"),
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

module.exports = { createFollowupTask, createImmediateTask, createPhoneQueueTask };
