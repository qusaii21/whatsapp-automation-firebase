const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { requireAgencyAuth, requireRole, verifyRequestAuth, AuthError, sendAuthError } = require("./auth");
const { createInvite, acceptInvite: acceptInviteForUser } = require("./members");
const { TenancyError } = require("./tenancy");
const { PERMISSIONS } = require("./roles");

/**
 * AGENCY INVITATION FLOW
 * ---------------------------------------------------------------------------
 *   Owner/Admin -> inviteMember(email, role) -> pending invite doc
 *   Invited user signs up or logs in (with that same email) -> acceptInvite
 *   (agencyId, inviteId) -> member doc created, custom claims stamped
 *
 * No email-sending integration exists in this phase (out of scope per the
 * brief) — inviteMember returns the raw inviteId; the Owner/Admin is
 * responsible for getting the resulting link to the invitee through
 * whatever channel they already use. The invite itself still fully enforces
 * email-matching and expiry server-side (see members.js's acceptInvite), so
 * how the link travels doesn't affect its security.
 */

const inviteMember = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const auth = await requireAgencyAuth(req);
    requireRole(auth, PERMISSIONS.MANAGE_MEMBERS);

    const { email, role } = req.body || {};
    const db = admin.firestore();
    const result = await createInvite(db, {
      agencyId: auth.agencyId,
      invitedByUid: auth.uid,
      email,
      role,
    });

    res.status(200).json(result);
  } catch (err) {
    if (sendAuthError(res, err)) return;
    if (err instanceof TenancyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error("inviteMember: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Couldn't create that invite. Try again." });
  }
});

const acceptInvite = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const auth = await verifyRequestAuth(req);
    if (auth.agencyId) {
      throw new AuthError("This account already belongs to an agency.", 409);
    }

    const { agencyId, inviteId } = req.body || {};
    if (!agencyId || typeof agencyId !== "string" || !inviteId || typeof inviteId !== "string") {
      res.status(400).json({ error: "Missing or invalid 'agencyId'/'inviteId'." });
      return;
    }

    const db = admin.firestore();
    const result = await acceptInviteForUser(db, {
      agencyId,
      inviteId,
      uid: auth.uid,
      email: auth.email,
      displayName: auth.decodedToken.name || "",
    });

    res.status(200).json(result);
  } catch (err) {
    if (sendAuthError(res, err)) return;
    if (err instanceof TenancyError) {
      const statusByCode = {
        not_found: 404,
        failed_precondition: 409,
        permission_denied: 403,
        invalid_argument: 400,
      };
      res.status(statusByCode[err.code] || 400).json({ error: err.message });
      return;
    }
    logger.error("acceptInvite: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Couldn't accept that invite. Try again." });
  }
});

module.exports = { inviteMember, acceptInvite };
