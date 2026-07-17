const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");

const { WHATSAPP_CRED_ENC_KEY, GRAPH_API_VERSION } = require("./config");
const { requireAuthContext, AuthError } = require("./auth");
const {
  saveFacebookCredentials,
  markFacebookDisconnected,
  markFacebookAccountStatus,
  getFacebookIntegrationStatusData,
  integrationRef,
  loadFacebookCredentials,
  invalidateCache,
  FacebookNotConnectedError,
} = require("./facebookCredentials");

/**
 * FACEBOOK PAGE INTEGRATION — CONNECT / STATUS / DISCONNECT / HEALTH
 * ---------------------------------------------------------------------------
 * Same shape and conventions as whatsappIntegration.js, one Page per
 * agency instead of one global `FB_PAGE_ACCESS_TOKEN`. CONNECT FLOW here is
 * also manual entry for this phase: the owner creates their own Facebook
 * Page + a Page Access Token (Meta Business Suite > Page Settings > Page
 * Access Tokens, or a long-lived token from a connected Meta App), pastes
 * it into Settings, and `connectFacebook` verifies it against Graph API
 * before storing anything. `WHATSAPP_CRED_ENC_KEY` is declared as a secret
 * dependency here too since facebookCredentials.js reuses that same
 * encryption key — not a new one to manage.
 */

const OWNER_ONLY = { roles: ["owner"] };

function sendError(res, err) {
  if (err instanceof AuthError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  logger.error("facebookIntegration: failed", { error: err.message, stack: err.stack });
  res.status(500).json({ error: err.message || "Something went wrong." });
}

/** Confirms a Page Access Token/Page ID pair is real and fetches the Page's display name in the same round trip. */
async function fetchPageInfo({ pageAccessToken, pageId }) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}?fields=name`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${pageAccessToken}` } });
  return response.data;
}

/**
 * POST /connectFacebook
 * Request body: { pageAccessToken, pageId }
 * Success 200: { connected: true, pageName }
 * Error 400 — missing fields; 401/403 — auth; 422 — Meta rejected the credentials
 */
const connectFacebook = onRequest(
  { region: "us-central1", cors: true, secrets: [WHATSAPP_CRED_ENC_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const { pageAccessToken, pageId } = req.body || {};
    if (!pageAccessToken || typeof pageAccessToken !== "string") {
      res.status(400).json({ error: "pageAccessToken is required." });
      return;
    }
    if (!pageId || typeof pageId !== "string") {
      res.status(400).json({ error: "pageId is required." });
      return;
    }

    try {
      const { agencyId, uid } = await requireAuthContext(req, OWNER_ONLY);

      let info;
      try {
        info = await fetchPageInfo({ pageAccessToken, pageId });
      } catch (err) {
        const apiError = err.response?.data?.error;
        logger.warn("connectFacebook: Meta verification failed", { agencyId, error: apiError || err.message });
        res.status(422).json({
          error: apiError?.message || "Meta rejected these credentials. Double-check the Page ID and Page Access Token.",
        });
        return;
      }

      const db = admin.firestore();
      await saveFacebookCredentials(db, agencyId, {
        pageAccessToken,
        pageId,
        pageName: info.name,
        connectedByUid: uid,
      });

      await integrationRef(db, agencyId).set(
        { lastHealthCheckAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

      logger.info("connectFacebook: connected", { agencyId, pageId });
      res.status(200).json({ connected: true, pageName: info.name });
    } catch (err) {
      sendError(res, err);
    }
  }
);

/**
 * GET /getFacebookIntegrationStatus
 * Any active member of the agency can view connection status.
 */
const getFacebookIntegrationStatus = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "GET") {
    res.sendStatus(405);
    return;
  }

  try {
    const { agencyId } = await requireAuthContext(req);
    const status = await getFacebookIntegrationStatusData(admin.firestore(), agencyId);
    res.status(200).json(status);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /disconnectFacebook
 * Owner-only. Marks the connection disconnected — leadsWebhook.js starts
 * throwing FacebookNotConnectedError for this agency immediately (cache is
 * invalidated synchronously), so new leads stop being pulled from Facebook
 * until reconnected. Routing index entry is kept, same rationale as WhatsApp.
 */
const disconnectFacebook = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const { agencyId } = await requireAuthContext(req, OWNER_ONLY);
    await markFacebookDisconnected(admin.firestore(), agencyId);
    res.status(200).json({ connected: false });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /checkFacebookHealth
 * Owner-only. Re-verifies the stored Page Access Token against Meta and
 * updates accountStatus accordingly.
 */
const checkFacebookHealth = onRequest(
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
        creds = await loadFacebookCredentials(db, agencyId);
      } catch (err) {
        if (err instanceof FacebookNotConnectedError) {
          res.status(200).json({ connected: false, accountStatus: "DISCONNECTED" });
          return;
        }
        throw err;
      }

      try {
        const info = await fetchPageInfo({ pageAccessToken: creds.pageAccessToken, pageId: creds.pageId });
        await integrationRef(db, agencyId).set(
          {
            accountStatus: "CONNECTED",
            pageName: info.name,
            lastHealthCheckAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        invalidateCache(agencyId);
        res.status(200).json({ connected: true, accountStatus: "CONNECTED" });
      } catch (err) {
        const statusCode = err.response?.status;
        const newStatus = statusCode === 401 || statusCode === 403 ? "TOKEN_INVALID" : "TOKEN_EXPIRED";
        await markFacebookAccountStatus(db, agencyId, newStatus);
        logger.warn("checkFacebookHealth: token check failed", { agencyId, newStatus });
        res.status(200).json({ connected: true, accountStatus: newStatus });
      }
    } catch (err) {
      sendError(res, err);
    }
  }
);

module.exports = { connectFacebook, getFacebookIntegrationStatus, disconnectFacebook, checkFacebookHealth };
