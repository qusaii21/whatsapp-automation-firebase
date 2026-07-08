const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

/**
 * CUSTOMER -> OPPORTUNITIES MODEL
 * ---------------------------------------------------------------------------
 * `leads/{phone}` is unchanged and continues to be the single doc keyed on
 * phone number that the dispatcher lock, FIFO inbox, dedup, and webhook all
 * depend on (see dispatcher.js's header comment for why phone-keyed
 * ordering matters). It is now treated as the CUSTOMER record: one WhatsApp
 * thread, one conversationHistory, one identity.
 *
 * A customer can have MULTIPLE distinct sales opportunities over time (2BHK
 * this month, a villa search six months later, etc.) — each one is a doc in
 * the new `leads/{phone}/opportunities/{opportunityId}` subcollection. This
 * is purely additive: nothing that already reads/writes `leads/{phone}`
 * directly needs to change for the chatbot or existing CRM to keep working.
 *
 * `leads/{phone}.activeOpportunityId` is the pointer to "which opportunity
 * is this customer's conversation currently about" — processPhoneQueue.js
 * reads it before calling the agent (to scope shown-property exclusions to
 * the right search) and updates it after, per turn.
 */

function opportunitiesCollection(db, phone) {
  return db.collection("leads").doc(phone).collection("opportunities");
}

function newOpportunityDoc({ phone, propertyType, purpose, seedFromLead }) {
  // `seedFromLead` is only passed when this is a pre-existing lead's FIRST
  // opportunity (i.e. it was talking to the bot before this feature
  // shipped). Carrying its already-accumulated shownProperties/budget/etc.
  // forward means upgrading doesn't reset "properties already shown" for
  // conversations that predate opportunities entirely - a genuinely new
  // opportunity created later via a detected topic change is seeded empty
  // instead (see resolveActiveOpportunity), since that IS meant to be a
  // fresh search.
  const seed = seedFromLead || {};
  return {
    customerId: phone,
    status: seed.status === "qualified" ? "qualified" : "new",
    propertyType: propertyType || null,
    purpose: purpose || seed.purpose || null,
    requirements: {},
    budget: seed.extractedBudget ?? null,
    preferredLocations: seed.preferredLocation ? [seed.preferredLocation] : [],
    timeline: seed.timeline || null,
    assignedAgent: null,
    notes: [],
    aiSummary: seed.conversationSummary || "",
    interestLevel: seed.interestLevel || "Medium",
    nextSuggestedAction: seed.nextSuggestedAction || null,
    propertiesShared: (seed.shownProperties || []).map((p) => ({ ...p, shownAt: null, reaction: null })),
    visitRequests: [],
    shownPropertyIds: seed.shownPropertyIds || [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

// Local defaults to hand back to the caller immediately after creating a new
// opportunity doc, so callers don't need a second read-after-write. Mirrors
// whatever newOpportunityDoc actually wrote (including any lead-seeded
// values), rather than always assuming empty.
function freshOpportunityDefaults(seedFromLead) {
  const seed = seedFromLead || {};
  return {
    status: seed.status === "qualified" ? "qualified" : "new",
    propertyType: null,
    purpose: seed.purpose || null,
    budget: seed.extractedBudget ?? null,
    preferredLocations: seed.preferredLocation ? [seed.preferredLocation] : [],
    timeline: seed.timeline || null,
    aiSummary: seed.conversationSummary || "",
    interestLevel: seed.interestLevel || "Medium",
    nextSuggestedAction: seed.nextSuggestedAction || null,
    propertiesShared: (seed.shownProperties || []).map((p) => ({ ...p, shownAt: null, reaction: null })),
    visitRequests: [],
    shownPropertyIds: seed.shownPropertyIds || [],
  };
}

/**
 * Decides whether the current turn continues the customer's active
 * opportunity or should start a brand-new one, and returns a ref to
 * whichever opportunity applies (creating it if needed).
 *
 * Mirrors the deterministic-override pattern already used in agent.js: the
 * model's own `startsNewSignal` guess is never trusted on its own — it's
 * only honored when there's an active opportunity to compare against AND
 * either (a) the property type genuinely changed, or (b) the model
 * explicitly flagged a "starting over" style signal. With no active
 * opportunity at all, a new one is always created (this is the customer's
 * first-ever opportunity).
 *
 * @param {object} params
 * @param {FirebaseFirestore.Firestore} params.db
 * @param {string} params.phone
 * @param {string|null} params.activeOpportunityId
 * @param {FirebaseFirestore.DocumentSnapshot|null} params.activeSnap Already-fetched
 *   snapshot of leads/{phone}/opportunities/{activeOpportunityId}, or null if there
 *   is no active opportunity id / it no longer exists. Passed in so the caller
 *   (which already needed this doc for shown-property context) doesn't pay for
 *   a second Firestore read here.
 * @param {object} params.lead The lead doc's current data, used ONLY to seed a
 *   pre-existing lead's very first opportunity with its already-accumulated
 *   shownProperties/budget/etc. (see newOpportunityDoc). Ignored when an
 *   active opportunity already exists.
 * @param {string|null} params.agentPropertyType Property type extracted this turn.
 * @param {boolean} params.startsNewSignal Model's own guess at whether this is a new opportunity.
 */
async function resolveActiveOpportunity({
  db,
  phone,
  activeOpportunityId,
  activeSnap,
  lead,
  agentPropertyType,
  startsNewSignal,
}) {
  const oppCol = opportunitiesCollection(db, phone);
  const noActiveOpportunity = !activeSnap || !activeSnap.exists;

  let shouldCreateNew = noActiveOpportunity;
  if (!noActiveOpportunity && startsNewSignal) {
    const activeType = (activeSnap.data().propertyType || "").toLowerCase();
    const newType = (agentPropertyType || "").toLowerCase();
    if (newType && activeType && newType !== activeType) {
      shouldCreateNew = true;
    } else if (!newType) {
      // No clean propertyType comparison available, but the model still
      // flagged an explicit boundary (e.g. "my requirements have changed",
      // "I want to start over") — this is a genuine language-understanding
      // call, same category as referencedPropertyIds resolution in
      // agent.js, so it's trusted here rather than silently dropped.
      shouldCreateNew = true;
    }
  }

  if (shouldCreateNew) {
    // Only a genuine first-ever opportunity (no activeOpportunityId at all)
    // gets seeded from the lead's pre-migration fields. A boundary-detected
    // new opportunity for a lead that already has one is a deliberately
    // fresh search and must start with empty shownProperties/etc.
    const seedFromLead = noActiveOpportunity ? lead : null;
    const newRef = oppCol.doc();
    await newRef.set(newOpportunityDoc({ phone, propertyType: agentPropertyType, seedFromLead }));
    logger.info("opportunities: created new opportunity", {
      phone,
      opportunityId: newRef.id,
      reason: noActiveOpportunity ? "no_active_opportunity" : "boundary_detected",
      previousOpportunityId: activeOpportunityId || null,
      seeded: Boolean(seedFromLead),
    });
    return { ref: newRef, id: newRef.id, isNew: true, data: freshOpportunityDefaults(seedFromLead) };
  }

  return { ref: activeSnap.ref, id: activeSnap.id, isNew: false, data: activeSnap.data() };
}

/**
 * Short text summary of the active opportunity for the agent's system
 * prompt, so its startsNewOpportunity judgment has something concrete to
 * compare against instead of guessing blind.
 */
function summarizeOpportunityForPrompt(oppData) {
  if (!oppData) return null;
  return (
    `Property type: ${oppData.propertyType || "unspecified"}; ` +
    `Purpose: ${oppData.purpose || "unspecified"}; ` +
    `Budget: ${oppData.budget ?? "unspecified"}; ` +
    `Status: ${oppData.status || "new"}; ` +
    `Summary so far: ${oppData.aiSummary || "none yet"}`
  );
}

module.exports = {
  opportunitiesCollection,
  resolveActiveOpportunity,
  summarizeOpportunityForPrompt,
};
