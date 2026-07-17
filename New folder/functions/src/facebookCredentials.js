const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const { agencyCollection, setAgencyRouting } = require("./tenancy");
const { encryptSecret, decryptSecret } = require("./whatsappCredentials");

/**
 * PER-AGENCY FACEBOOK PAGE CREDENTIALS
 * ---------------------------------------------------------------------------
 * `agencies/{agencyId}/integrations/facebook` — each agency's own Facebook
 * Page (for Lead Ads). Replaces the single global `FB_PAGE_ACCESS_TOKEN`
 * secret that `leadsWebhook.js` used to read for every agency — every
 * agency can now bring their own Facebook Page, exactly like WhatsApp.
 *
 * `FB_VERIFY_TOKEN` (config.js) stays a global secret — it's the one-time
 * handshake token for the single `leadsWebhook` URL's Meta subscription,
 * not tied to any Page. Only the Page Access Token needed per-Page moves
 * here. See tenancy.js's "WHAT STAYS GLOBAL" note, which already flagged
 * this per-agency credential move as the intended follow-up.
 *
 * Deliberately reuses whatsappCredentials.js's `encryptSecret`/
 * `decryptSecret` (same `WHATSAPP_CRED_ENC_KEY`, same AES-256-GCM scheme) —
 * one encryption-at-rest story for every credential this product stores,
 * not a second key to manage.
 *
 * SECURITY: same posture as WhatsApp — this doc has
 * `allow read: if false` / `allow write: if false` in firestore.rules
 * (covered by the existing generic `integrations/{docId}` rule), reachable
 * only through the owner-gated Cloud Functions in facebookIntegration.js.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const credentialCache = new Map(); // agencyId -> { data, loadedAt }

class FacebookNotConnectedError extends Error {
  constructor(agencyId) {
    super(`Agency ${agencyId} has not connected a Facebook Page yet.`);
    this.name = "FacebookNotConnectedError";
    this.code = "not_connected";
  }
}

function integrationRef(db, agencyId) {
  return agencyCollection(db, agencyId, "integrations").doc("facebook");
}

/**
 * Loads and decrypts an agency's Facebook Page credentials, using the
 * in-memory cache when fresh. Throws FacebookNotConnectedError if the
 * agency has never connected, or its connection is known broken.
 *
 * Returns: { pageAccessToken, pageId, accountStatus }
 */
async function loadFacebookCredentials(db, agencyId) {
  const cached = credentialCache.get(agencyId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    if (cached.data === null) throw new FacebookNotConnectedError(agencyId);
    return cached.data;
  }

  const snap = await integrationRef(db, agencyId).get();
  if (!snap.exists || !snap.data()?.connected) {
    credentialCache.set(agencyId, { data: null, loadedAt: Date.now() });
    throw new FacebookNotConnectedError(agencyId);
  }

  const doc = snap.data();
  if (doc.accountStatus && doc.accountStatus !== "CONNECTED") {
    credentialCache.set(agencyId, { data: null, loadedAt: Date.now() });
    throw new FacebookNotConnectedError(agencyId);
  }

  const pageAccessToken = decryptSecret(doc.pageAccessTokenEnc);
  if (!pageAccessToken) {
    logger.error("facebookCredentials: stored token failed to decrypt", { agencyId });
    credentialCache.set(agencyId, { data: null, loadedAt: Date.now() });
    throw new FacebookNotConnectedError(agencyId);
  }

  const data = { pageAccessToken, pageId: doc.pageId, accountStatus: doc.accountStatus };
  credentialCache.set(agencyId, { data, loadedAt: Date.now() });
  return data;
}

function invalidateCache(agencyId) {
  credentialCache.delete(agencyId);
}

/**
 * Saves (creates or updates) an agency's Facebook Page connection. Encrypts
 * the Page Access Token before it ever touches Firestore. Registers the
 * `fbPageId` routing index entry so leadsWebhook.js resolves inbound
 * leadgen events for this Page to this agency immediately.
 */
async function saveFacebookCredentials(db, agencyId, { pageAccessToken, pageId, pageName, connectedByUid }) {
  if (!pageAccessToken || typeof pageAccessToken !== "string") {
    throw new Error("pageAccessToken is required.");
  }
  if (!pageId || typeof pageId !== "string") {
    throw new Error("pageId is required.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await integrationRef(db, agencyId).set(
    {
      connected: true,
      pageId,
      pageAccessTokenEnc: encryptSecret(pageAccessToken),
      pageName: pageName || null,
      accountStatus: "CONNECTED",
      connectedAt: now,
      connectedByUid: connectedByUid || null,
      updatedAt: now,
    },
    { merge: true }
  );

  await setAgencyRouting(db, "fbPageId", pageId, agencyId);

  invalidateCache(agencyId);
  logger.info("facebookCredentials: connected", { agencyId, pageId });
}

/** Marks an agency's Facebook connection as disconnected — same "keep history, don't delete" posture as WhatsApp. */
async function markFacebookDisconnected(db, agencyId) {
  await integrationRef(db, agencyId).set(
    { connected: false, accountStatus: "DISCONNECTED", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  invalidateCache(agencyId);
  logger.info("facebookCredentials: disconnected", { agencyId });
}

/** Flags a connection as broken (discovered via a failed lead fetch, or a health check) without deleting it. */
async function markFacebookAccountStatus(db, agencyId, accountStatus) {
  await integrationRef(db, agencyId).set(
    { accountStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  invalidateCache(agencyId);
}

/**
 * Read-only status projection safe to return to the frontend. NEVER
 * includes pageAccessTokenEnc or any raw credential field.
 */
async function getFacebookIntegrationStatusData(db, agencyId) {
  const snap = await integrationRef(db, agencyId).get();
  if (!snap.exists) {
    return { connected: false };
  }
  const doc = snap.data();
  return {
    connected: !!doc.connected,
    pageId: doc.pageId || null,
    pageName: doc.pageName || null,
    accountStatus: doc.accountStatus || null,
    connectedAt: doc.connectedAt || null,
    lastHealthCheckAt: doc.lastHealthCheckAt || null,
  };
}

module.exports = {
  FacebookNotConnectedError,
  integrationRef,
  loadFacebookCredentials,
  saveFacebookCredentials,
  markFacebookDisconnected,
  markFacebookAccountStatus,
  getFacebookIntegrationStatusData,
  invalidateCache,
};
