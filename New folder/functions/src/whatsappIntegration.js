const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");

const { WHATSAPP_CRED_ENC_KEY, GRAPH_API_VERSION } = require("./config");
const { requireAuthContext, AuthError } = require("./auth");
const {
  saveWhatsAppCredentials,
  markWhatsAppDisconnected,
  markWhatsAppAccountStatus,
  getIntegrationStatusData,
  integrationRef,
  loadWhatsAppCredentials,
  invalidateCache,
  WhatsAppNotConnectedError,
} = require("./whatsappCredentials");
const { templatesCollection } = require("./whatsappTemplates");

/**
 * WHATSAPP INTEGRATION — CONNECT / STATUS / DISCONNECT / HEALTH
 * ---------------------------------------------------------------------------
 * CONNECT FLOW — THIS PHASE (manual entry): the agency owner creates their
 * own Meta App + WhatsApp Business Account outside this product, then
 * pastes the resulting Access Token / Phone Number ID / Business Account ID
 * into the Settings page (see frontend/src/pages/settings/WhatsAppIntegration.jsx).
 * `connectWhatsApp` below verifies those values actually work (a real Graph
 * API call, not just "were they non-empty") before ever storing them, so a
 * typo'd token fails fast in the UI rather than silently breaking sends
 * later.
 *
 * FUTURE PHASE (not built here): a Meta Embedded Signup OAuth flow would
 * add a `whatsappOAuth.js` module that obtains these same three values via
 * a token exchange instead of a form, then calls the exact same
 * `saveWhatsAppCredentials` this endpoint calls — everything below this
 * connect step (status, disconnect, health check, and every send/webhook/
 * template call site) is already written to not care which flow produced
 * the credentials.
 */

const OWNER_ONLY = { roles: ["owner"] };

function sendError(res, err) {
  if (err instanceof AuthError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  logger.error("whatsappIntegration: failed", { error: err.message, stack: err.stack });
  res.status(500).json({ error: err.message || "Something went wrong." });
}

/**
 * Calls Meta's Graph API to confirm a token/phoneNumberId pair is real and
 * fetches the phone number's display info in the same round trip — this is
 * both the validation step AND how we populate displayPhoneNumber /
 * qualityRating / messagingTier without a second call.
 */
async function fetchPhoneNumberInfo({ accessToken, phoneNumberId }) {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}` +
    `?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return response.data;
}

/**
 * POST /connectWhatsApp
 * Request body: { accessToken, phoneNumberId, businessAccountId }
 * Success 200: { connected: true, displayPhoneNumber, businessName, qualityRating }
 * Error 400 — missing fields
 * Error 401/403 — auth
 * Error 422 — Meta rejected the credentials (bad token / wrong phone number id)
 */
const connectWhatsApp = onRequest(
  { region: "us-central1", cors: true, secrets: [WHATSAPP_CRED_ENC_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const { accessToken, phoneNumberId, businessAccountId } = req.body || {};
    if (!accessToken || typeof accessToken !== "string") {
      res.status(400).json({ error: "accessToken is required." });
      return;
    }
    if (!phoneNumberId || typeof phoneNumberId !== "string") {
      res.status(400).json({ error: "phoneNumberId is required." });
      return;
    }
    if (!businessAccountId || typeof businessAccountId !== "string") {
      res.status(400).json({ error: "businessAccountId is required." });
      return;
    }

    try {
      const { agencyId, uid } = await requireAuthContext(req, OWNER_ONLY);

      let info;
      try {
        info = await fetchPhoneNumberInfo({ accessToken, phoneNumberId });
      } catch (err) {
        const apiError = err.response?.data?.error;
        logger.warn("connectWhatsApp: Meta verification failed", {
          agencyId,
          error: apiError || err.message,
        });
        res.status(422).json({
          error:
            apiError?.message ||
            "Meta rejected these credentials. Double-check the Access Token and Phone Number ID.",
        });
        return;
      }

      const db = admin.firestore();
      await saveWhatsAppCredentials(db, agencyId, {
        accessToken,
        phoneNumberId,
        businessAccountId,
        displayPhoneNumber: info.display_phone_number,
        businessName: info.verified_name,
        connectedByUid: uid,
      });

      // Best-effort: store quality/tier now so the Settings page has
      // something to show immediately, without waiting for the next
      // scheduled health check.
      await integrationRef(db, agencyId).set(
        {
          qualityRating: info.quality_rating || "UNKNOWN",
          messagingTier: info.messaging_limit_tier || null,
          lastHealthCheckAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      logger.info("connectWhatsApp: connected", { agencyId, phoneNumberId });
      res.status(200).json({
        connected: true,
        displayPhoneNumber: info.display_phone_number,
        businessName: info.verified_name,
        qualityRating: info.quality_rating || "UNKNOWN",
      });
    } catch (err) {
      sendError(res, err);
    }
  }
);

/**
 * GET /getIntegrationStatus
 * Any active member of the agency can view connection status (not just
 * owner) — the Templates/Campaigns pages need this to show a "not
 * connected" banner regardless of who's looking.
 * Success 200: see whatsappCredentials.js#getIntegrationStatusData — NEVER
 * includes accessTokenEnc or any raw credential.
 */
const getIntegrationStatus = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "GET") {
    res.sendStatus(405);
    return;
  }

  try {
    const { agencyId } = await requireAuthContext(req);
    const db = admin.firestore();
    const status = await getIntegrationStatusData(db, agencyId);

    // Template count is a cheap aggregate the Settings page wants alongside
    // connection status — read here rather than making the frontend do a
    // second round trip.
    if (status.connected) {
      const templatesSnap = await templatesCollection(db, agencyId).count().get();
      status.templateCount = templatesSnap.data().count;
    }

    res.status(200).json(status);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /disconnectWhatsApp
 * Owner-only. Marks the connection as disconnected (does not delete the
 * routing index or stored token — see markWhatsAppDisconnected's own
 * comment). Every credential-consuming call site will start throwing
 * WhatsAppNotConnectedError for this agency immediately after this call
 * (cache is invalidated synchronously).
 */
const disconnectWhatsApp = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const { agencyId } = await requireAuthContext(req, OWNER_ONLY);
    await markWhatsAppDisconnected(admin.firestore(), agencyId);
    res.status(200).json({ connected: false });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /checkWhatsAppHealth
 * Owner-only, on-demand version of the nightly sweep (see followupCheck.js's
 * scheduler for the equivalent "scheduled function" pattern this would
 * extend in a follow-up phase). Re-verifies the stored token against Meta
 * and updates accountStatus/qualityRating/messagingTier accordingly, so the
 * Settings page's "Reconnect" banner reflects reality without waiting for a
 * send to fail first.
 */
const checkWhatsAppHealth = onRequest(
  { region: "us-central1", cors: true, secrets: [WHATSAPP_CRED_ENC_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    try {
      const { agencyId } = await requireAuthContext(req, OWNER_ONLY);
      const db = admin.firestore();

      let creds;
      try {
        creds = await loadWhatsAppCredentials(db, agencyId);
      } catch (err) {
        if (err instanceof WhatsAppNotConnectedError) {
          res.status(200).json({ connected: false, accountStatus: "DISCONNECTED" });
          return;
        }
        throw err;
      }

      try {
        const info = await fetchPhoneNumberInfo({
          accessToken: creds.whatsappToken,
          phoneNumberId: creds.phoneNumberId,
        });
        await integrationRef(db, agencyId).set(
          {
            accountStatus: "CONNECTED",
            qualityRating: info.quality_rating || "UNKNOWN",
            messagingTier: info.messaging_limit_tier || null,
            displayPhoneNumber: info.display_phone_number,
            businessName: info.verified_name,
            lastHealthCheckAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        invalidateCache(agencyId);
        res.status(200).json({ connected: true, accountStatus: "CONNECTED", qualityRating: info.quality_rating });
      } catch (err) {
        const statusCode = err.response?.status;
        const newStatus = statusCode === 401 || statusCode === 403 ? "TOKEN_INVALID" : "TOKEN_EXPIRED";
        await markWhatsAppAccountStatus(db, agencyId, newStatus);
        logger.warn("checkWhatsAppHealth: token check failed", { agencyId, newStatus });
        res.status(200).json({ connected: true, accountStatus: newStatus });
      }
    } catch (err) {
      sendError(res, err);
    }
  }
);

module.exports = { connectWhatsApp, getIntegrationStatus, disconnectWhatsApp, checkWhatsAppHealth };
