const { CloudTasksClient } = require("@google-cloud/tasks");
const { onInit } = require("firebase-functions/v2/core");
const { REGION, FOLLOWUP_QUEUE_NAME } = require("./config");

let tasksClient;

onInit(() => {
  tasksClient = new CloudTasksClient();
});

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

module.exports = { createFollowupTask };
