const crypto = require("crypto");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const { agencyCollection, setAgencyRouting } = require("./tenancy");
const { WHATSAPP_CRED_ENC_KEY } = require("./config");

/**
 * PER-AGENCY WHATSAPP CREDENTIALS
 * ---------------------------------------------------------------------------
 * `agencies/{agencyId}/integrations/whatsapp` — each agency's own Meta
 * WhatsApp Business Account connection. Replaces the single global
 * WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_BUSINESS_ACCOUNT_ID
 * secrets that used to be read straight out of config.js — every function
 * that used to do `WHATSAPP_TOKEN.value()` now calls
 * `loadWhatsAppCredentials(db, agencyId)` instead.
 *
 * CONNECT FLOW (this phase — manual entry, see whatsappIntegration.js):
 * an owner pastes their own Access Token / Phone Number ID / WABA ID
 * (obtained from their own Meta App + WhatsApp Business Account outside
 * this product). `saveWhatsAppCredentials` is the ONE place that accepts
 * and stores them. A future Embedded-Signup OAuth flow
 * (whatsappOAuth.js — not built in this phase) would call this exact same
 * function with values it obtained via a token exchange instead of a form
 * — nothing downstream of this module needs to know or care which flow
 * produced the credentials.
 *
 * SECURITY: accessToken is NEVER stored in plaintext (see encrypt/decrypt
 * below) and this doc has `allow read: if false` / `allow write: if false`
 * in firestore.rules — the browser can never read or write it directly,
 * only through the owner-gated Cloud Functions in whatsappIntegration.js.
 *
 * CACHING: Cloud Functions instances are reused across invocations (the
 * same posture config.js's defineSecret values already rely on), so a
 * short-TTL in-memory cache here avoids a Firestore read on every single
 * WhatsApp send/webhook delivery. `saveWhatsAppCredentials` /
 * `markWhatsAppDisconnected` invalidate this agency's cache entry
 * immediately, so a reconnect/disconnect is never stuck behind the TTL —
 * only a *token refresh done by some OTHER instance* has up to
 * CACHE_TTL_MS of staleness, which sends already tolerate via retry.
 *
 * ONE ACCOUNT PER AGENCY (by design, for now): every call site — sends,
 * webhooks, template sync — reaches WhatsApp credentials exclusively
 * through the functions exported below, never by reading
 * `integrations/whatsapp` directly. That choke point is what makes this
 * "one account per agency" a storage decision rather than an API contract:
 * a future phase that needs >1 connected number per agency only has to
 * change what's inside this file (e.g. add an `accounts` subcollection and
 * a default-account pointer) — no call site would need to change, since
 * none of them know or care how the doc is shaped. (A subcollection
 * version of this file was built and reverted once already — deliberately
 * not carried forward because a single agency running >1 live WhatsApp
 * number isn't a real need yet, and the extra indirection wasn't worth
 * carrying until it is.)
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const credentialCache = new Map(); // agencyId -> { data, loadedAt }

class WhatsAppNotConnectedError extends Error {
  constructor(agencyId) {
    super(`Agency ${agencyId} has not connected a WhatsApp Business Account yet.`);
    this.name = "WhatsAppNotConnectedError";
    this.code = "not_connected";
  }
}

function integrationRef(db, agencyId) {
  return agencyCollection(db, agencyId, "integrations").doc("whatsapp");
}

// ── Encryption (AES-256-GCM, key from Secret Manager) ──────────────────────
// See the design doc's §7 for the KMS-envelope-encryption trade-off this
// deliberately does NOT take on: this is the "two hours, not two days"
// option — a single 32-byte key held in Secret Manager, same trust model as
// every other secret this codebase already has. Swapping to KMS later only
// touches the two functions below, never a call site.

function getEncryptionKey() {
  const raw = WHATSAPP_CRED_ENC_KEY.value();
  if (!raw) {
    throw new Error("WHATSAPP_CRED_ENC_KEY secret is not set.");
  }
  // Accept either a 32-byte base64 string or a 64-char hex string.
  const key = raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("WHATSAPP_CRED_ENC_KEY must decode to exactly 32 bytes (AES-256).");
  }
  return key;
}

/** Encrypts a plaintext string -> "iv:authTag:ciphertext" (all base64). Null/undefined pass through as null. */
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // GCM standard IV length
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Reverses encryptSecret. Returns null for null/undefined/malformed input rather than throwing. */
function decryptSecret(encoded) {
  if (!encoded || typeof encoded !== "string") return null;
  const parts = encoded.split(":");
  if (parts.length !== 3) return null;
  try {
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (err) {
    logger.error("whatsappCredentials: decrypt failed", { error: err.message });
    return null;
  }
}

// ── Core read/write ─────────────────────────────────────────────────────────

/**
 * Loads and decrypts an agency's WhatsApp credentials, using the in-memory
 * cache when fresh. Throws WhatsAppNotConnectedError if the agency has
 * never connected, or its connection has been disconnected/revoked — every
 * call site should let that propagate (or catch it to show a clean
 * "reconnect needed" error) rather than falling through to a Graph API call
 * with undefined values.
 *
 * Returns: { whatsappToken, phoneNumberId, wabaId, accountStatus }
 */
async function loadWhatsAppCredentials(db, agencyId) {
  const cached = credentialCache.get(agencyId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    if (cached.data === null) throw new WhatsAppNotConnectedError(agencyId);
    return cached.data;
  }

  const snap = await integrationRef(db, agencyId).get();
  if (!snap.exists || !snap.data()?.connected) {
    credentialCache.set(agencyId, { data: null, loadedAt: Date.now() });
    throw new WhatsAppNotConnectedError(agencyId);
  }

  const doc = snap.data();
  if (doc.accountStatus && doc.accountStatus !== "CONNECTED") {
    // TOKEN_EXPIRED / TOKEN_INVALID / REVOKED / DISCONNECTED — surfaced to
    // the caller the same way as "never connected": nothing downstream
    // should attempt a send with credentials known to be bad.
    credentialCache.set(agencyId, { data: null, loadedAt: Date.now() });
    throw new WhatsAppNotConnectedError(agencyId);
  }

  const whatsappToken = decryptSecret(doc.accessTokenEnc);
  if (!whatsappToken) {
    logger.error("whatsappCredentials: stored token failed to decrypt", { agencyId });
    credentialCache.set(agencyId, { data: null, loadedAt: Date.now() });
    throw new WhatsAppNotConnectedError(agencyId);
  }

  const data = {
    whatsappToken,
    phoneNumberId: doc.phoneNumberId,
    wabaId: doc.businessAccountId,
    accountStatus: doc.accountStatus,
  };
  credentialCache.set(agencyId, { data, loadedAt: Date.now() });
  return data;
}

/** Invalidates the cache entry for one agency — call after any write to integrations/whatsapp. */
function invalidateCache(agencyId) {
  credentialCache.delete(agencyId);
}

/**
 * Saves (creates or updates) an agency's WhatsApp connection. Encrypts the
 * access token before it ever touches Firestore. Registers both routing
 * index keys (see tenancy.js) so inbound webhooks route to this agency
 * immediately — no manual seeding step.
 *
 * @param {object} opts
 * @param {string} opts.accessToken        Plaintext — encrypted before storage, never logged.
 * @param {string} opts.phoneNumberId
 * @param {string} opts.businessAccountId
 * @param {string} [opts.displayPhoneNumber]
 * @param {string} [opts.businessName]
 * @param {string} [opts.connectedByUid]   uid of the owner who connected — audit trail.
 */
async function saveWhatsAppCredentials(db, agencyId, opts) {
  const {
    accessToken,
    phoneNumberId,
    businessAccountId,
    displayPhoneNumber,
    businessName,
    connectedByUid,
  } = opts;

  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("accessToken is required.");
  }
  if (!phoneNumberId || typeof phoneNumberId !== "string") {
    throw new Error("phoneNumberId is required.");
  }
  if (!businessAccountId || typeof businessAccountId !== "string") {
    throw new Error("businessAccountId is required.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await integrationRef(db, agencyId).set(
    {
      connected: true,
      phoneNumberId,
      businessAccountId,
      accessTokenEnc: encryptSecret(accessToken),
      displayPhoneNumber: displayPhoneNumber || null,
      businessName: businessName || null,
      accountStatus: "CONNECTED",
      connectedAt: now,
      connectedByUid: connectedByUid || null,
      updatedAt: now,
    },
    { merge: true }
  );

  // Routing index: lets whatsappWebhook.js (phone-number-scoped events) and
  // future WABA-level webhooks (template status changes) resolve this
  // agency in O(1) — see tenancy.js.
  await setAgencyRouting(db, "waPhoneId", phoneNumberId, agencyId);
  await setAgencyRouting(db, "waBusinessAccountId", businessAccountId, agencyId);

  invalidateCache(agencyId);
  logger.info("whatsappCredentials: connected", { agencyId, phoneNumberId });
}

/**
 * Marks an agency's connection as disconnected. Deliberately does NOT
 * delete the routing index entries or the stored (encrypted) token —
 * reconnecting with the same number should not require re-registering
 * routing, and keeping the encrypted-at-rest history is harmless. A true
 * "forget everything" delete is a separate, explicit admin action this
 * function does not perform.
 */
async function markWhatsAppDisconnected(db, agencyId) {
  await integrationRef(db, agencyId).set(
    {
      connected: false,
      accountStatus: "DISCONNECTED",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  invalidateCache(agencyId);
  logger.info("whatsappCredentials: disconnected", { agencyId });
}

/** Flags a connection as broken (bad token discovered via a failed send, or a health check) without deleting it. */
async function markWhatsAppAccountStatus(db, agencyId, accountStatus) {
  await integrationRef(db, agencyId).set(
    { accountStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  invalidateCache(agencyId);
}

/**
 * Read-only status projection safe to return to the frontend — see
 * whatsappIntegration.js#getIntegrationStatus. NEVER includes
 * accessTokenEnc or any raw credential field.
 */
async function getIntegrationStatusData(db, agencyId) {
  const snap = await integrationRef(db, agencyId).get();
  if (!snap.exists) {
    return { connected: false };
  }
  const doc = snap.data();
  return {
    connected: !!doc.connected,
    // phoneNumberId / businessAccountId are public Graph API identifiers
    // (used in request URLs, not secrets) — safe to expose so the Settings
    // UI can display them; accessTokenEnc is still never returned.
    phoneNumberId: doc.phoneNumberId || null,
    businessAccountId: doc.businessAccountId || null,
    displayPhoneNumber: doc.displayPhoneNumber || null,
    businessName: doc.businessName || null,
    qualityRating: doc.qualityRating || null,
    messagingTier: doc.messagingTier || null,
    accountStatus: doc.accountStatus || null,
    connectedAt: doc.connectedAt || null,
    lastHealthCheckAt: doc.lastHealthCheckAt || null,
    lastSyncedTemplateCountAt: doc.lastSyncedTemplateCountAt || null,
  };
}

module.exports = {
  WhatsAppNotConnectedError,
  integrationRef,
  encryptSecret,
  decryptSecret,
  loadWhatsAppCredentials,
  saveWhatsAppCredentials,
  markWhatsAppDisconnected,
  markWhatsAppAccountStatus,
  getIntegrationStatusData,
  invalidateCache,
};
