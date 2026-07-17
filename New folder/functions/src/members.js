const admin = require("firebase-admin");

const { agencyMembersCollection, agencyInvitesCollection, ensureAgencyDoc } = require("./tenancy");
const { AuthError, ROLES } = require("./auth");
const { writeMemberRecord } = require("./memberClaims");

/**
 * MEMBER ROLE MODEL
 * ---------------------------------------------------------------------------
 * Every member document (agencies/{agencyId}/members/{uid}) — and every
 * matching Firebase Auth custom-claims payload — carries exactly one role:
 *
 *   owner  — full access. Manage members (invite/change role/remove).
 *            Manage credits (schema exists, no billing wired up yet — a
 *            follow-up phase). Delete the agency (not implemented yet — no
 *            admin dashboard in this phase). Exactly one per agency: the
 *            member created by createAgencyForNewUser below.
 *   admin  — manage the CRM: campaigns, templates, properties, opportunities.
 *            Cannot manage members or the agency itself.
 *   agent  — day-to-day CRM use: chat, leads, opportunities. Can LAUNCH an
 *            already-created, already-approved campaign, but cannot create,
 *            edit, or otherwise manage campaigns/templates/properties. No
 *            member management.
 *
 * See functions/src/auth.js's requireAuthContext for how a role restricts
 * which Cloud Functions a member can call, and firestore.rules for how the
 * same role gates direct Firestore reads/writes from the browser.
 *
 * NO USER DATA IS DUPLICATED ANYWHERE ELSE: the member doc under
 * agencies/{agencyId}/members/{uid} — plus the identical
 * { agencyId, role, status } mirrored onto the Firebase Auth user's custom
 * claims for verification purposes (see auth.js) — is the ONLY place this
 * data lives. There is no top-level `users/{uid}` collection.
 *
 * Firestore is the source of truth; claims are a synced read-optimized
 * mirror of it. Every write to a member doc in this file goes through
 * memberClaims.js#writeMemberRecord, which writes both together — see that
 * file's header for why the sync isn't left to each call site to remember.
 */

const INVITABLE_ROLES = ["admin", "agent"];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * AGENCY CREATION FLOW (step 2 of 2 — step 1 is the client calling Firebase
 * Auth's createUserWithEmailAndPassword directly, see AuthContext.jsx):
 *
 *   User signs up (Firebase Auth, client-side)
 *     -> Agency document created            (tenancy.js#ensureAgencyDoc)
 *     -> Member document created            (agencies/{agencyId}/members/{uid})
 *     -> Owner role assigned                (member doc + custom claims)
 *
 * Idempotency: rejects outright if this Firebase Auth user already carries
 * an agencyId claim (from a previous createAgency or acceptInvite call) —
 * one user can never belong to more than one agency in this phase.
 */
async function createAgencyForNewUser(db, { uid, email, displayName, agencyName }) {
  const authUser = await admin.auth().getUser(uid);
  if (authUser.customClaims && authUser.customClaims.agencyId) {
    throw new AuthError("This account is already linked to an agency.", "already_exists", 409);
  }

  const agencyId = db.collection("agencies").doc().id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const normalizedEmail = normalizeEmail(email);

  await ensureAgencyDoc(db, agencyId, {
    name: (agencyName && agencyName.trim()) || `${displayName || normalizedEmail}'s Agency`,
  });

  await writeMemberRecord(db, uid, {
    uid,
    agencyId,
    role: "owner",
    displayName: (displayName && displayName.trim()) || normalizedEmail,
    email: normalizedEmail,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  return { agencyId, role: "owner" };
}

/**
 * AGENCY INVITATION FLOW (step 1 of 2 — step 2 is acceptInvite below):
 *
 *   Owner/Admin
 *     -> Invite user by email     (this function: creates a pending invite)
 *     -> User accepts invitation  (acceptInvite: creates the member doc)
 *
 * No email is actually dispatched by this phase (that's a follow-up) — the
 * returned { agencyId, inviteId } is what the frontend turns into a
 * shareable accept-invite link for the caller to send manually.
 */
async function inviteMember(db, { agencyId, invitedByUid, invitedByRole, email, role, displayName }) {
  if (!["owner", "admin"].includes(invitedByRole)) {
    throw new AuthError("Only owners and admins can invite members.", "forbidden", 403);
  }

  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new AuthError("A valid email address is required.", "invalid_argument", 400);
  }

  if (!INVITABLE_ROLES.includes(role)) {
    throw new AuthError(`role must be one of: ${INVITABLE_ROLES.join(", ")}.`, "invalid_argument", 400);
  }

  const existingMember = await agencyMembersCollection(db, agencyId)
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();
  if (!existingMember.empty) {
    throw new AuthError("This email already belongs to a member of this agency.", "already_exists", 409);
  }

  const existingInvite = await agencyInvitesCollection(db, agencyId)
    .where("email", "==", normalizedEmail)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!existingInvite.empty) {
    throw new AuthError("This email already has a pending invite.", "already_exists", 409);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = agencyInvitesCollection(db, agencyId).doc();
  await ref.set({
    email: normalizedEmail,
    role,
    displayName: (displayName && displayName.trim()) || null,
    status: "pending",
    invitedBy: invitedByUid,
    createdAt: now,
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + INVITE_TTL_MS),
  });

  return { inviteId: ref.id, agencyId, email: normalizedEmail, role };
}

/**
 * Second half of the invitation flow — see inviteMember above. The invitee
 * must already have (or first create) a Firebase Auth account and be
 * signed in when calling this; it never creates the Auth user itself, only
 * the member doc + custom claims, exactly like createAgencyForNewUser does
 * for a brand-new agency's owner.
 */
async function acceptInvite(db, { agencyId, inviteId, uid, email, displayName }) {
  const authUser = await admin.auth().getUser(uid);
  if (
    authUser.customClaims &&
    authUser.customClaims.agencyId &&
    authUser.customClaims.agencyId !== agencyId
  ) {
    throw new AuthError("This account already belongs to a different agency.", "already_exists", 409);
  }

  const ref = agencyInvitesCollection(db, agencyId).doc(inviteId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new AuthError("Invite not found.", "not_found", 404);
  }
  const invite = snap.data();

  if (invite.status !== "pending") {
    throw new AuthError("This invite has already been used or revoked.", "failed_precondition", 409);
  }
  if (invite.expiresAt && invite.expiresAt.toMillis() < Date.now()) {
    throw new AuthError("This invite has expired.", "failed_precondition", 409);
  }
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== invite.email) {
    throw new AuthError("This invite was sent to a different email address.", "forbidden", 403);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await writeMemberRecord(db, uid, {
    uid,
    agencyId,
    role: invite.role,
    displayName: (displayName && displayName.trim()) || invite.displayName || normalizedEmail,
    email: normalizedEmail,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  await ref.set({ status: "accepted", acceptedBy: uid, acceptedAt: now }, { merge: true });

  return { agencyId, role: invite.role };
}

module.exports = {
  ROLES,
  INVITABLE_ROLES,
  createAgencyForNewUser,
  inviteMember,
  acceptInvite,
};
