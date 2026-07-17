const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { verifyRequestAuth, AuthError, sendAuthError } = require("./auth");
const { createAgencyWithOwner } = require("./members");
const { TenancyError } = require("./tenancy");

/**
 * AGENCY CREATION (SIGNUP) — SECOND STEP
 * ---------------------------------------------------------------------------
 * Signup is two steps, same split every Firebase-Auth-backed app uses:
 *   1. Client SDK: `createUserWithEmailAndPassword` — creates the Firebase
 *      Auth user directly (no server round trip needed for that part).
 *   2. This function: the client immediately calls `completeSignup` with
 *      the fresh user's ID token, to turn that bare Auth user into an
 *      Owner of a brand-new agency (agency doc + owner member doc + custom
 *      claims — see members.js's createAgencyWithOwner).
 *
 * Deliberately rejects a user who already has an `agencyId` claim — this
 * phase is "exactly one agency per user" (per the brief: "Each user should
 * belong to exactly one agency"), so completeSignup is a one-time,
 * not-repeatable step per account.
 */
const completeSignup = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.sendStatus(405);
    return;
  }

  try {
    const auth = await verifyRequestAuth(req);
    if (auth.agencyId) {
      throw new AuthError("This account already belongs to an agency.", 409);
    }

    const { agencyName, displayName } = req.body || {};
    const trimmedAgencyName = typeof agencyName === "string" ? agencyName.trim() : "";
    if (!trimmedAgencyName) {
      res.status(400).json({ error: "Missing or invalid 'agencyName'." });
      return;
    }

    const db = admin.firestore();
    const result = await createAgencyWithOwner(db, {
      uid: auth.uid,
      email: auth.email,
      displayName: typeof displayName === "string" ? displayName.trim() : "",
      agencyName: trimmedAgencyName,
    });

    res.status(200).json(result);
  } catch (err) {
    if (sendAuthError(res, err)) return;
    if (err instanceof TenancyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error("completeSignup: failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Couldn't finish setting up your agency. Try again." });
  }
});

module.exports = { completeSignup };
