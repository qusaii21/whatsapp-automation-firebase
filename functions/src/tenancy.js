const logger = require("firebase-functions/logger");

/**
 * MULTI-TENANCY FOUNDATION
 * ---------------------------------------------------------------------------
 * Every agency's data now lives under a single root document:
 *
 *   agencies/{agencyId}
 *     profile/main            — agency profile (company name, contact, logo, ...)
 *     settings/general        — agency-level settings (timezone, default
 *                                template names, feature flags, ...)
 *     credits/wallet          — credit balance/ledger summary
 *     subscription/current    — plan/subscription schema (no billing logic
 *                                wired up yet — a follow-up phase)
 *     members/{uid}            — agency team members, keyed by Firebase Auth
 *                                uid (see auth.js/members.js — AUTH PHASE)
 *     integrations/whatsapp    — this agency's own connected Meta WhatsApp
 *                                Business Account (encrypted access token,
 *                                phoneNumberId, businessAccountId, connection
 *                                status — see whatsappCredentials.js). Never
 *                                client-readable; see firestore.rules.
 *     invites/{inviteId}       — pending/accepted member invitations
 *                                (see members.js)
 *     leads/{phone}
 *       opportunities/{opportunityId}
 *       inbox/{messageId}                 (per-phone FIFO dispatcher queue)
 *       deadLetters/{messageId}
 *     campaigns/{campaignId}
 *       recipients/{recipientId}
 *     properties/{propertyId}
 *     whatsappTemplates/{templateId}
 *     metrics/dashboard
 *     metricsDaily/{yyyy-mm-dd}
 *     metricsWeekly/{yyyy-Www}
 *     metricsMonthly/{yyyy-mm}
 *     dispatcherLocks/{phone}
 *     campaignDispatchLocks/{campaignId}
 *     processedMessages/{whatsappMessageId}
 *     processedLeadgenEvents/{leadgenId}
 *
 * Every function in this codebase that used to call `db.collection("X")`
 * now calls `agencyCollection(db, agencyId, "X")` instead — same Firestore
 * instance, same collection name, just rooted under the agency that owns it.
 * `db` is still always `admin.firestore()`; only the PATH changed, exactly
 * per this migration's scope (Cloud Tasks queues, Cloud Functions, campaign
 * engine, agent, metrics engine, etc. all keep their existing logic).
 *
 * WHAT STAYS GLOBAL (and why these two are the only exceptions):
 *   - `agencies/{agencyId}` itself (and its profile/settings/credits/
 *     subscription/members subcollections) — this IS the tenant record, the
 *     root everything else hangs off.
 *   - `agencyRouting/{routingKey}` — a tiny lookup index (see below) that
 *     lets the two Meta webhooks (leadsWebhook, whatsappWebhook), which
 *     receive events with NO agencyId anywhere in the request, resolve
 *     "which agency does this Page/WhatsApp number belong to" with a single
 *     O(1) document read instead of scanning every agency. This is a
 *     routing table, not tenant data — it holds no lead/campaign/message
 *     content, only `{ agencyId }`, so it doesn't compromise isolation.
 *     Scales to thousands of agencies the same way any hash-keyed index
 *     does: cost is O(1) per lookup regardless of how many agencies exist.
 *
 * WHY A ROUTING INDEX (not a `where()` query against `agencies`): Meta's
 * webhook payloads carry a Facebook Page ID (`entry[].id`, leadgen) or a
 * WhatsApp phone_number_id (`value.metadata.phone_number_id`, messages).
 * Today this codebase deploys a single set of global WHATSAPP_ / FB_ secrets
 * (one Page, one WhatsApp Business number) — that operational piece (one
 * secret set per agency) is a follow-up phase, not part of this migration's
 * scope (see README/config.js). So the routing index is seeded with exactly
 * one entry today, but the resolution CODE PATH already scales to thousands
 * of agencies, each with its own Page/phone_number_id, without any further
 * changes here once each agency's own credentials exist.
 */

const AGENCIES_COLLECTION = "agencies";
const ROUTING_COLLECTION = "agencyRouting";

class TenancyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TenancyError";
    this.code = code || "invalid_argument";
  }
}

/** `agencies/{agencyId}` */
function agencyRef(db, agencyId) {
  if (!agencyId || typeof agencyId !== "string") {
    throw new TenancyError("A valid 'agencyId' is required.", "invalid_argument");
  }
  return db.collection(AGENCIES_COLLECTION).doc(agencyId);
}

/** `agencies/{agencyId}/{collectionName}` — the one place every tenant-scoped collection path is built. */
function agencyCollection(db, agencyId, collectionName) {
  return agencyRef(db, agencyId).collection(collectionName);
}

// ── Agency profile / settings / credits / subscription / members ──────────
// Single-doc subcollections (a fixed doc id) so each concern is its own
// document — cheap to read/update independently (e.g. touching `credits`
// on every WhatsApp send never rewrites `profile`), while still living
// physically under the agency they belong to.

function agencyProfileRef(db, agencyId) {
  return agencyCollection(db, agencyId, "profile").doc("main");
}

function agencySettingsRef(db, agencyId) {
  return agencyCollection(db, agencyId, "settings").doc("general");
}

function agencyCreditsRef(db, agencyId) {
  return agencyCollection(db, agencyId, "credits").doc("wallet");
}

function agencySubscriptionRef(db, agencyId) {
  return agencyCollection(db, agencyId, "subscription").doc("current");
}

function agencyMembersCollection(db, agencyId) {
  return agencyCollection(db, agencyId, "members");
}

/**
 * `agencies/{agencyId}/invites/{inviteId}` — pending/accepted invitations
 * created by members.js#inviteMember and resolved by members.js#acceptInvite.
 * Deliberately NOT a global collection (e.g. keyed by email): an invite is
 * agency-owned data, not user data, so it lives under the agency exactly
 * like every other tenant-scoped collection — see auth.js/members.js for
 * the full invite flow this backs.
 */
function agencyInvitesCollection(db, agencyId) {
  return agencyCollection(db, agencyId, "invites");
}

/**
 * Creates the agency root doc + its fixed-id subdocuments, all defaulted.
 * Called once per new agency (provisioning is a follow-up phase — this is
 * just the shape a provisioning step would write). Safe to call more than
 * once: every write below is `{ merge: true }`.
 */
async function ensureAgencyDoc(db, agencyId, { name } = {}) {
  // NOTE: this only provisions the agency root doc + its fixed-id
  // subdocuments. The owning member (role "owner") is created separately by
  // members.js#createAgencyForNewUser right after this — see that file for
  // the full "agency created -> member created -> owner role assigned" flow.
  const admin = require("firebase-admin");
  const now = admin.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.set(
    agencyRef(db, agencyId),
    {
      name: name || agencyId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );
  batch.set(agencyProfileRef(db, agencyId), { updatedAt: now }, { merge: true });
  batch.set(agencySettingsRef(db, agencyId), { updatedAt: now }, { merge: true });
  batch.set(agencyCreditsRef(db, agencyId), { balance: 0, updatedAt: now }, { merge: true });
  batch.set(agencySubscriptionRef(db, agencyId), { plan: "free", status: "active", updatedAt: now }, { merge: true });
  await batch.commit();
}

// ── Webhook routing index ──────────────────────────────────────────────────

/** `agencyRouting/{kind}:{value}` — e.g. `agencyRouting/waPhoneId:1234567890`. */
function routingRef(db, kind, value) {
  return db.collection(ROUTING_COLLECTION).doc(`${kind}:${value}`);
}

/**
 * Registers a routing key -> agencyId mapping. Called during agency
 * onboarding (a follow-up phase) whenever an agency's Facebook Page ID or
 * WhatsApp phone_number_id is set/changed.
 */
async function setAgencyRouting(db, kind, value, agencyId) {
  const admin = require("firebase-admin");
  if (!value) return;
  await routingRef(db, kind, value).set(
    { agencyId, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/**
 * Resolves an inbound webhook's routing key (Facebook Page ID for leadgen,
 * WhatsApp phone_number_id for messages) to the owning agencyId. Returns
 * null if nothing is registered for that key — callers decide how to react
 * (see leadsWebhook.js/whatsappWebhook.js: today, with a single-agency
 * deployment, this falls back to DEFAULT_AGENCY_ID so existing behavior is
 * unchanged; once real agency onboarding exists, an unresolved key should
 * be treated as an error instead of a fallback).
 */
async function resolveAgencyIdByRouting(db, kind, value) {
  if (!value) return null;
  try {
    const snap = await routingRef(db, kind, value).get();
    if (!snap.exists) return null;
    return snap.data().agencyId || null;
  } catch (err) {
    logger.error("tenancy: routing lookup failed", { kind, value, error: err.message });
    return null;
  }
}

/**
 * This codebase's ONE existing deployment (single Meta Page + single
 * WhatsApp Business number, from the global FB_ / WHATSAPP_ secrets in
 * config.js) is treated as "the first agency" so this migration is a
 * non-breaking, drop-in change for the current deployment — every existing
 * document continues to be reachable, just now nested one level deeper
 * under `agencies/{DEFAULT_AGENCY_ID}/...` instead of at the root.
 *
 * A real multi-agency deployment stops relying on this fallback entirely:
 * every agency registers its own Page ID / phone_number_id via
 * setAgencyRouting above (part of a follow-up onboarding phase), and
 * resolveAgencyIdByRouting resolves each webhook delivery to the correct
 * agency independently — nothing about that code path is single-agency
 * specific, only this fallback constant is.
 */
const DEFAULT_AGENCY_ID = process.env.DEFAULT_AGENCY_ID || "default";

/**
 * Resolves the agencyId for an inbound Meta webhook delivery, given its
 * routing key, falling back to DEFAULT_AGENCY_ID (see above) when nothing
 * is registered yet — keeps a fresh/single-tenant deployment working with
 * zero onboarding steps, while every multi-agency deployment moves off the
 * fallback simply by registering routing entries.
 */
async function resolveAgencyIdForWebhook(db, kind, value) {
  const resolved = await resolveAgencyIdByRouting(db, kind, value);
  return resolved || DEFAULT_AGENCY_ID;
}

module.exports = {
  AGENCIES_COLLECTION,
  ROUTING_COLLECTION,
  DEFAULT_AGENCY_ID,
  TenancyError,
  agencyRef,
  agencyCollection,
  agencyProfileRef,
  agencySettingsRef,
  agencyCreditsRef,
  agencySubscriptionRef,
  agencyMembersCollection,
  agencyInvitesCollection,
  ensureAgencyDoc,
  routingRef,
  setAgencyRouting,
  resolveAgencyIdByRouting,
  resolveAgencyIdForWebhook,
};
