const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { requireAuthenticatedUser, AuthError } = require("./auth");
const { acceptInvite: resolveInvite } = require("./members");

/**
 * POST /acceptInvite
 * ---------------------------------------------------------------------------
 * User accepts invitation -> member document created. Step 2 of 2 (step 1
 * is inviteMember.js). The invitee must already have — or first create — a
 * Firebase Auth account and be signed in when calling this; it never
 * creates the Auth user itself, only the member doc + custom claims, the
 * same as createAgency.js does for a brand-new agency's owner.
 *
 * The client MUST force-refresh its ID token after this call succeeds,
 * exactly like createAgency.js — see AuthContext.jsx.
 *
 * Request body: { agencyId: string, inviteId: string, displayName?: string }
 * Success 200: { agencyId, role }
 * Error 401 — not signed in
 * Error 400 — missing agencyId/inviteId
 * Error 403 — invite was sent to a different email, or account already
 *             belongs to a different agency
 * Error 404 — invite not found
 * Error 409 — invite already used/revoked/expired
 */
const acceptInvite = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const decoded = await requireAuthenticatedUser(req);
    const { agencyId, inviteId, displayName } = req.body || {};

    if (!agencyId || typeof agencyId !== "string" || !inviteId || typeof inviteId !== "string") {
      res.status(400).json({ error: "Missing or invalid 'agencyId'/'inviteId'." });
      return;
    }

    const result = await resolveInvite(admin.firestore(), {
      agencyId,
      inviteId,
      uid: decoded.uid,
      email: decoded.email,
      displayName,
    });

    logger.info("acceptInvite: accepted", { uid: decoded.uid, agencyId });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error("acceptInvite: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

module.exports = { acceptInvite };
