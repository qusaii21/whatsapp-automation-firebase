// Resolves the base URL for callable-over-HTTP Cloud Functions (createCampaign,
// addCampaignRecipients, sendManualMessage, ...). Pulled out of Campaigns.jsx
// into its own module so components/ can import it too without creating a
// pages/ <-> components/ circular import.
export function functionsBaseUrl() {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  return `https://us-central1-${projectId}.cloudfunctions.net`;
}
