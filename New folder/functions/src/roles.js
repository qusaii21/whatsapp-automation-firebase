/**
 * MEMBER ROLE MODEL
 * ---------------------------------------------------------------------------
 * Three roles, deliberately simple (per this phase's scope — no per-collection
 * ACL system, no custom permission editor):
 *
 *   OWNER  — full access. Manage members, manage credits (later), delete
 *            agency. Exactly one agency per Owner-created account; the Owner
 *            is whoever ran the agency-creation (signup) flow.
 *   ADMIN  — manage CRM: campaigns, templates, properties, opportunities.
 *            Cannot manage members or delete the agency.
 *   AGENT  — chat, leads, opportunities. Can LAUNCH a campaign that an
 *            Owner/Admin already created, but cannot create/edit/duplicate/
 *            pause/cancel campaigns, and has no template or member access.
 *
 * This file is the single source of truth for "which role can call which
 * Cloud Function" — see PERMISSIONS below and auth.js's `requireRole`.
 * Firestore Rules enforce the coarser agency-isolation boundary (same
 * agencyId) directly against custom claims; fine-grained role gating for
 * mutations happens here, in the Cloud Functions layer, since every
 * mutating collection (campaigns, whatsappTemplates, metrics, ...) already
 * denies direct client writes in firestore.rules and is only ever mutated
 * through these functions (Admin SDK).
 */

const ROLES = Object.freeze({
  OWNER: "owner",
  ADMIN: "admin",
  AGENT: "agent",
});

const ALL_ROLES = Object.values(ROLES);

// Permission name -> roles allowed to exercise it. Referenced by both the
// Cloud Functions below (via requireRole in auth.js) and this module's own
// doc comments; kept as data (not scattered literals) so the role model
// stays auditable in one place.
const PERMISSIONS = Object.freeze({
  MANAGE_MEMBERS: [ROLES.OWNER], // invite/remove/change role, delete agency
  MANAGE_INTEGRATIONS: [ROLES.OWNER], // connect/reconnect/disconnect the agency's WhatsApp Business Account
  MANAGE_CAMPAIGNS: [ROLES.OWNER, ROLES.ADMIN], // create/duplicate/pause/resume/cancel/retry/addRecipients
  LAUNCH_CAMPAIGN: [ROLES.OWNER, ROLES.ADMIN, ROLES.AGENT], // launching an already-created campaign
  MANAGE_TEMPLATES: [ROLES.OWNER, ROLES.ADMIN], // create/sync/refresh/fetch WhatsApp templates
  SEND_MESSAGE: [ROLES.OWNER, ROLES.ADMIN, ROLES.AGENT], // manual chat send (human-agent mode)
});

function isValidRole(role) {
  return ALL_ROLES.includes(role);
}

module.exports = { ROLES, ALL_ROLES, PERMISSIONS, isValidRole };
