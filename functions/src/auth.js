const admin = require("firebase-admin");

/**
 * AUTHENTICATION & AUTHORIZATION
 * ---------------------------------------------------------------------------
 * Every member's tenancy identity — agencyId, role, status — is carried on
 * their Firebase ID token as CUSTOM CLAIMS, set exactly twice in this
 * codebase: once by createAgency.js (signup: owner) and once by
 * acceptInvite.js (invite acceptance: admin/agent). See members.js.
 *
 * WHY CUSTOM CLAIMS AND NOT A FIRESTORE READ: verifying an ID token is a
 * pure crypto check (no network call), so `agencyId`/`role`/`status` are
 * available to every Cloud Function AND to Firestore Rules (as
 * `request.auth.token.agencyId` etc — see firestore.rules) with zero extra
 * reads, at any scale, and identically in both places. A Firestore-lookup
 * approach (member doc keyed by uid) would mean every single Firestore rule
 * evaluation making an extra `get()` call, and every Cloud Function needing
 * its own separate lookup — two implementations of the same trust decision
 * that could drift apart. One claims-verification codepath, trusted
 * everywhere, is what makes this scale to thousands of agencies without a
 * lookup fan-out.
 *
 * WHY THIS REPLACES tenancy.js's (now-removed) requireAgencyId: that helper
 * read `agencyId` straight out of the request body/query — i.e. it trusted
 * whatever the browser sent. That was fine as a placeholder before
 * authentication existed (previous phase), but it means any caller could
 * simply put a DIFFERENT agency's id in the request and read/write that
 * agency's data through any client-facing Cloud Function. requireAuthContext
 * below is what every one of those endpoints now calls instead — agencyId
 * always comes from the verified token, never from anything the client sent.
 *
 * TRADE-OFF (documented, not hidden): custom claims only refresh into a
 * client's ID token on the NEXT token refresh (forced or ~hourly). A role
 * change or a member being disabled therefore doesn't take effect for an
 * already-open session until it refreshes — acceptable for this phase's
 * "keep permissions simple" scope; enforcing it instantly would require a
 * Firestore read on every request, undoing the point above. The frontend
 * force-refreshes the token immediately after createAgency/acceptInvite
 * (see AuthContext.jsx) so a BRAND NEW member context is never stale.
 */

class AuthError extends Error {
  constructor(message, code = "unauthenticated", statusCode = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * TEMPORARY DEV-MODE OVERRIDE
 * ---------------------------------------------------------------------------
 * While true, every `requireAuthContext(req, { roles: [...] })` call site in
 * this codebase (see auth.js and grep for "roles:" across functions/src) grants
 * access to ANY active member of the agency, regardless of their role — i.e.
 * every authenticated user gets full Owner/Admin-equivalent access to every
 * Cloud Function for this MVP phase. Authentication and agency isolation are
 * completely unaffected: a caller still needs a valid ID token with an
 * agencyId claim, and still only ever touches THEIR OWN agency's data — only
 * the additional "and your role must be X" narrowing is skipped.
 *
 * Nothing about the role model itself changed: ROLES/PERMISSIONS (roles.js),
 * the `role` field on member docs and custom claims, and every individual
 * `roles: [...]` call site are all untouched. To restore normal role-based
 * authorization later, flip this back to `false` — no other file needs to
 * change. The matching frontend flag is
 * frontend/src/lib/devAccess.js#ROLE_CHECKS_DISABLED — keep both in sync.
 */
const ROLE_CHECKS_DISABLED = true;

const ROLES = ["owner", "admin", "agent"];

function extractBearerToken(req) {
  const header = (req.get && (req.get("Authorization") || req.get("authorization"))) || req.headers?.authorization;
  if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Verifies the caller is a real, signed-in Firebase user — nothing more.
 * Used ONLY by createAgency.js and acceptInvite.js, the two endpoints that
 * legitimately run BEFORE a user has an agencyId claim yet (they're what
 * grants it). Every other client-facing endpoint uses requireAuthContext
 * below instead, which additionally requires that claim to already exist.
 *
 * `checkRevoked` defaults to false: verifying that flag costs a real
 * network round trip to the Firebase Auth backend on every call, which is
 * exactly the "no extra reads, at any scale" cost this file's header
 * explains claims-based auth was built to avoid. It's opt-in, passed by
 * requireAuthContext below only for role-gated calls — see that function's
 * comment for why that's the right place to draw the line rather than
 * checking it on every request.
 */
async function requireAuthenticatedUser(req, { checkRevoked = false } = {}) {
  const idToken = extractBearerToken(req);
  if (!idToken) {
    throw new AuthError("Missing Authorization: Bearer <idToken> header.", "unauthenticated", 401);
  }
  try {
    return await admin.auth().verifyIdToken(idToken, checkRevoked);
  } catch (err) {
    throw new AuthError("Invalid or expired session. Please sign in again.", "unauthenticated", 401);
  }
}

/**
 * Verifies the caller's Firebase ID token AND that it carries a complete,
 * active tenancy context, returning `{ uid, email, agencyId, role, status }`
 * read entirely from the token's custom claims. This is the ONLY source of
 * `agencyId` every client-facing Cloud Function in this codebase trusts —
 * see each endpoint's use of this in place of the old requireAgencyId.
 *
 * Pass `{ roles: [...] }` to additionally require the caller's role be one
 * of the given roles (see the ROLE MODEL in members.js) — throws a 403
 * AuthError otherwise. Omit `roles` for "any active member of their agency".
 *
 * REVOCATION: without this, a member's already-issued ID token keeps
 * working as normal until it naturally expires (up to ~1hr) even after
 * their claims change — `verifyIdToken` alone only checks the token's
 * signature, not whether it's since been revoked. Role-gated calls
 * (`roles` passed) check revocation here so that IF a future write also
 * calls `admin.auth().revokeRefreshTokens(uid)` (e.g. a member-disable
 * flow — not built yet, see memberClaims.js), that member is locked out
 * of anything sensitive immediately rather than up to an hour later. The
 * open "any active member" calls (`roles` omitted — e.g.
 * getIntegrationStatus) deliberately skip it, to keep the zero-extra-
 * network-call property this file's header describes for the common case.
 */
async function requireAuthContext(req, { roles } = {}) {
  const decoded = await requireAuthenticatedUser(req, { checkRevoked: Boolean(roles && roles.length > 0) });
  const { uid, email, agencyId, role, status } = decoded;

  if (!agencyId || !role) {
    throw new AuthError(
      "This account is not yet linked to an agency. Create an agency or accept an invite first.",
      "no_agency",
      403
    );
  }

  if (status !== "active") {
    throw new AuthError("This member account has been disabled.", "member_disabled", 403);
  }

  if (!ROLE_CHECKS_DISABLED && roles && roles.length > 0 && !roles.includes(role)) {
    throw new AuthError(`This action requires one of these roles: ${roles.join(", ")}.`, "forbidden", 403);
  }

  return { uid, email, agencyId, role, status };
}

module.exports = {
  AuthError,
  ROLES,
  ROLE_CHECKS_DISABLED,
  extractBearerToken,
  requireAuthenticatedUser,
  requireAuthContext,
};
