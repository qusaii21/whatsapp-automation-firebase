import { auth } from "../firebase.js";

// Resolves the base URL for callable-over-HTTP Cloud Functions (createCampaign,
// addCampaignRecipients, sendManualMessage, ...). Pulled out of Campaigns.jsx
// into its own module so components/ can import it too without creating a
// pages/ <-> components/ circular import.
export function functionsBaseUrl() {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  return `https://us-central1-${projectId}.cloudfunctions.net`;
}

/**
 * Every client-facing Cloud Function except the two Meta webhooks now
 * requires a `requireAuthContext(req)` call on the backend (see
 * functions/src/auth.js) — i.e. a valid `Authorization: Bearer <idToken>`
 * header, with agencyId/role read from that token's custom claims, never
 * trusted from the request body. This is the ONE place that header gets
 * attached, so every call site below just calls `authedFetch(path, options)`
 * exactly like they'd call `fetch()`, and gets the header for free.
 *
 * `getIdToken()` (no force-refresh) is intentional here — it reuses the
 * current token if it's still valid and only refreshes when Firebase's own
 * SDK considers it expired, so this doesn't add a network round-trip to
 * every single request. The one place a FORCED refresh matters — right
 * after createAgency/acceptInvite mint brand new claims — is handled by
 * AuthContext's own `refreshClaims()`, not here.
 */
export async function authedFetch(path, options = {}) {
  const user = auth.currentUser;
  const idToken = user ? await user.getIdToken() : null;

  const headers = { ...(options.headers || {}) };
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  return fetch(`${functionsBaseUrl()}${path}`, { ...options, headers });
}
