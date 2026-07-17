const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { requireAuthContext, AuthError } = require("./auth");
const { inviteMember: createInvite } = require("./members");

/**
 * POST /inviteMember
 * ---------------------------------------------------------------------------
 * Owner/Admin -> invite a teammate by email. Step 1 of 2 (step 2 is
 * acceptInvite.js). Creates a pending invite under
 * agencies/{agencyId}/invites/{inviteId}; agencyId comes from the caller's
 * verified token (requireAuthContext), never from the request body.
 *
 * No email is actually dispatched in this phase (that's a follow-up) — the
 * returned { agencyId, inviteId } is what the frontend turns into a
 * shareable accept-invite link (see Members invite UI) for the inviter to
 * send manually.
 *
 * Request body: { email: string, role: 'admin' | 'agent', displayName?: string }
 * Success 200: { inviteId, agencyId, email, role }
 * Error 401 — not signed in
 * Error 403 — signed in but not an owner/admin of their agency
 * Error 400 — invalid email/role
 * Error 409 — already a member, or already has a pending invite
 */
const inviteMember = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const context = await requireAuthContext(req, { roles: ["owner", "admin"] });
    const { email, role, displayName } = req.body || {};

    const result = await createInvite(admin.firestore(), {
      agencyId: context.agencyId,
      invitedByUid: context.uid,
      invitedByRole: context.role,
      email,
      role,
      displayName,
    });

    logger.info("inviteMember: created", result);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error("inviteMember: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Failed to invite member" });
  }
});

module.exports = { inviteMember };
