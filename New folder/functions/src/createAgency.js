const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { requireAuthenticatedUser, AuthError } = require("./auth");
const { createAgencyForNewUser } = require("./members");

/**
 * POST /createAgency
 * ---------------------------------------------------------------------------
 * Step 2 of the agency signup flow. Step 1 is the client calling Firebase
 * Auth's createUserWithEmailAndPassword directly (see AuthContext.jsx) —
 * this endpoint never creates the Auth user itself, only provisions the
 * agency for an ALREADY-authenticated user who has no agency yet:
 *
 *   User signs up (Firebase Auth, client-side)
 *     -> Agency document created
 *     -> Member document created
 *     -> Owner role assigned
 *
 * Rejects with 409 if the caller's account already carries an agencyId
 * claim (see members.js#createAgencyForNewUser) — one Firebase Auth user
 * can belong to exactly one agency in this phase.
 *
 * The client MUST force-refresh its ID token after this call succeeds
 * (`auth.currentUser.getIdToken(true)`) before the new agencyId/role claims
 * are visible to Firestore Rules or any other Cloud Function — see
 * AuthContext.jsx's createAgency wrapper.
 *
 * Request body: { agencyName?: string, displayName?: string }
 * Success 200: { agencyId, role: "owner" }
 * Error 401 — not signed in / invalid session
 * Error 409 — this account already belongs to an agency
 */
const createAgency = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const decoded = await requireAuthenticatedUser(req);
    const { agencyName, displayName } = req.body || {};

    const result = await createAgencyForNewUser(admin.firestore(), {
      uid: decoded.uid,
      email: decoded.email,
      displayName: displayName || decoded.name,
      agencyName,
    });

    logger.info("createAgency: provisioned", { uid: decoded.uid, agencyId: result.agencyId });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error("createAgency: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Failed to create agency" });
  }
});

module.exports = { createAgency };
