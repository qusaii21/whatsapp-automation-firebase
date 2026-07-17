import { auth } from "../firebase.js";

/**
 * authedFetch
 * ---------------------------------------------------------------------------
 * Drop-in replacement for `fetch()` when calling one of this project's
 * client-facing Cloud Functions (sendManualMessage, createCampaign,
 * launchCampaign, campaignControl, duplicateCampaign, template management —
 * see functions/index.js). Attaches `Authorization: Bearer <idToken>` so the
 * function can verify the caller and derive agencyId/role from their custom
 * claims (see functions/src/auth.js) — these endpoints no longer accept or
 * trust an `agencyId` in the request body/query at all, so callers don't
 * need to (and shouldn't) send one.
 *
 * `getIdToken()` (no force-refresh) is used here on purpose: the Firebase
 * client SDK already caches and silently refreshes the token roughly hourly,
 * so this is normally a synchronous cache hit, not a network round trip.
 * Callers that just changed their own claims (signup/invite-accept) refresh
 * explicitly via AuthContext's `refreshClaims(true)` instead — this helper
 * doesn't need to force that on every single call.
 */
export async function authedFetch(url, options = {}) {
  if (!auth.currentUser) {
    throw new Error("You need to be signed in to do that.");
  }
  const idToken = await auth.currentUser.getIdToken();
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${idToken}`,
  };
  return fetch(url, { ...options, headers });
}
