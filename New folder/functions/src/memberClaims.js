const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const { agencyMembersCollection } = require("./tenancy");

/**
 * SINGLE WRITE PATH FOR MEMBER RECORDS
 * ---------------------------------------------------------------------------
 * The member doc (agencies/{agencyId}/members/{uid}) and the matching
 * Firebase Auth custom claims (see auth.js) are two independent copies of
 * the same { agencyId, role, status } fact — Firestore is the source of
 * truth (it's what Team.jsx displays, what firestore.rules trusts for
 * reads, and the only thing a human ever edits), claims are a read-optimized
 * mirror of it that Cloud Functions and Firestore Rules check without a
 * network call.
 *
 * Nothing keeps those two copies in sync automatically — Firebase has no
 * built-in propagation from a Firestore write to a user's claims. Historically
 * that sync was done by hand at each call site (two lines, right next to each
 * other, easy to write correctly and just as easy to forget entirely — see
 * the incident this module was written to prevent: an account's claims never
 * having picked up a `status` field added after that account was created).
 *
 * writeMemberRecord() below is the ONLY function in this codebase that may
 * write agencies/{agencyId}/members/{uid} — every call site (creation,
 * invite-accept, and any future role-change/disable/reactivate flow) must
 * go through it, so writing the member doc and writing claims are structurally
 * one action, not a convention to remember.
 *
 * `data` must include the full member record on every call, including for
 * partial-looking updates (e.g. changing only `role`): `setCustomUserClaims`
 * REPLACES the claims payload wholesale, it does not merge, so a caller that
 * passes an incomplete `data` would silently blank out the fields it omitted
 * from claims. Firestore's `.set(..., {merge: true})` masks this by merging
 * on the Firestore side, which is exactly why this function does not accept
 * a "just patch these fields" shorthand — callers always read the current
 * record first if they're changing one field, then pass the full object back
 * through here.
 *
 * FAILURE MODE (documented, not hidden): this is two separate systems, not
 * one transaction — there is no atomic way to write Firestore and Firebase
 * Auth claims together. If the Firestore write succeeds and the claims write
 * then fails (network blip, Auth outage), the two are left inconsistent
 * until the caller retries. That's logged loudly below specifically so it's
 * operationally visible rather than silently drifting the way this bug did —
 * see functions/scripts/backfillMemberClaims.js for the sweep that repairs
 * exactly this state if it ever happens.
 *
 * NOT YET BUILT: no caller currently flips an existing member's `status`
 * to "disabled" — Team.jsx's role/status-management UI doesn't exist yet
 * (see devAccess.js#TEAM_UI_HIDDEN). When that flow is built, it should
 * call `admin.auth().revokeRefreshTokens(uid)` right after going through
 * writeMemberRecord() here, so the disabled member's already-issued token
 * is locked out immediately rather than staying valid for up to ~1hr — see
 * auth.js#requireAuthContext's REVOCATION comment for the other half of
 * this (role-gated calls already check revocation, this is what needs to
 * actually trigger one).
 */
const CLAIM_FIELDS = ["agencyId", "role", "status"];

function extractClaims(data) {
  const claims = {};
  for (const field of CLAIM_FIELDS) {
    claims[field] = data[field];
  }
  return claims;
}

async function writeMemberRecord(db, uid, data) {
  const { agencyId, role, status } = data;
  if (!agencyId || !role || !status) {
    throw new Error("writeMemberRecord: agencyId, role, and status are all required.");
  }

  await agencyMembersCollection(db, agencyId).doc(uid).set(data, { merge: true });

  try {
    await admin.auth().setCustomUserClaims(uid, extractClaims(data));
  } catch (err) {
    logger.error("writeMemberRecord: member doc was written but claims sync failed", {
      uid,
      agencyId,
      role,
      status,
      error: err.message,
    });
    throw err;
  }

  return { agencyId, role, status };
}

module.exports = { writeMemberRecord, CLAIM_FIELDS };
