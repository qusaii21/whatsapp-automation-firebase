const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const { normalizePropertyType, normalizeListingType, normalizePurpose } = require("./searchNormalization");
const { RESIDENTIAL_PROPERTY_TYPES, COMMERCIAL_PROPERTY_TYPES } = require("./propertyEnums");

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
 *
 * PROPERTIESSHARED SCHEMA (see hydratePropertiesShared below)
 * ---------------------------------------------------------------------------
 * Going forward, `propertiesShared` entries are lightweight references —
 * `{ propertyId, shownAt, reaction, visitRequested, status, priceWhenShown }`
 * — NOT full copies of the property document. `properties/{propertyId}` is
 * the single source of truth for everything else (project, builder,
 * amenities, images, etc.). Older entries written before this change still
 * carry the full property object inline under `id` instead of `propertyId`;
 * those are left as-is (never rewritten in place) and are still readable —
 * see hydratePropertiesShared, which handles both shapes transparently.
 */

function opportunitiesCollection(db, phone) {
  return db.collection("leads").doc(phone).collection("opportunities");
}

// Converts one legacy full-object shownProperties/propertiesShared entry (or
// an already-lightweight one) into the new lightweight ref shape. Used only
// when SEEDING a brand-new opportunity from a pre-existing lead's
// accumulated history (see newOpportunityDoc) — the new opportunity doc
// should always be written in the new lightweight format, even when the data
// it's seeded from predates this change.
function toLightweightPropertyRef(p) {
  return {
    propertyId: p.propertyId || p.id,
    shownAt: p.shownAt ?? null,
    reaction: p.reaction ?? null,
    visitRequested: p.visitRequested ?? false,
    status: p.status || "shown",
    priceWhenShown: p.priceWhenShown ?? p.price ?? null,
  };
}

/**
 * Resolves a mix of legacy full-object entries and new lightweight
 * `{propertyId, ...}` refs into full property records — fetching whatever's
 * missing from `properties/{propertyId}` (the source of truth) — for
 * anything that needs the complete property data, e.g. the agent's
 * "properties already shown" prompt context, which answers follow-up
 * questions like "does it have a gym?" from this data directly.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object[]} propertiesShared Raw propertiesShared array (either shape, or mixed).
 * @returns {Promise<object[]>} Full records, each with an `id` field. Entries whose
 *   referenced property no longer exists are dropped.
 */
async function hydratePropertiesShared(db, propertiesShared) {
  const entries = propertiesShared || [];
  // Legacy entries already carry the full property object inline (under
  // `id`) — nothing to fetch.
  const legacy = entries.filter((p) => !p.propertyId && p.id);
  // New lightweight entries only carry a reference — look up the real data.
  const lightweight = entries.filter((p) => p.propertyId);

  if (lightweight.length === 0) {
    return legacy;
  }

  const refs = lightweight.map((p) => db.collection("properties").doc(p.propertyId));
  const snaps = await db.getAll(...refs);
  const hydrated = snaps
    .map((snap, i) => {
      if (!snap.exists) return null; // property since deleted — drop it rather than show stale/empty data
      const meta = lightweight[i];
      return {
        id: meta.propertyId,
        ...snap.data(),
        shownAt: meta.shownAt ?? null,
        reaction: meta.reaction ?? null,
        visitRequested: meta.visitRequested ?? false,
        status: meta.status || "shown",
        priceWhenShown: meta.priceWhenShown ?? null,
      };
    })
    .filter(Boolean);

  return [...legacy, ...hydrated];
}

function newOpportunityDoc({ phone, propertyType, listingType, purpose, seedFromLead }) {
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
    listingType: listingType || null,
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
    // Always written in the new lightweight shape, even when seeded from a
    // legacy lead.shownProperties array of full objects — see
    // toLightweightPropertyRef.
    propertiesShared: (seed.shownProperties || []).map(toLightweightPropertyRef),
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
    listingType: null,
    purpose: seed.purpose || null,
    budget: seed.extractedBudget ?? null,
    preferredLocations: seed.preferredLocation ? [seed.preferredLocation] : [],
    timeline: seed.timeline || null,
    aiSummary: seed.conversationSummary || "",
    interestLevel: seed.interestLevel || "Medium",
    nextSuggestedAction: seed.nextSuggestedAction || null,
    propertiesShared: (seed.shownProperties || []).map(toLightweightPropertyRef),
    visitRequests: [],
    shownPropertyIds: seed.shownPropertyIds || [],
  };
}

// Explicit restart phrases — checked against the raw incoming WhatsApp text
// for THIS turn (not the LLM's paraphrase of it). Kept as a plain regex list
// so this stays deterministic and easy to extend: no similarity scoring, no
// embeddings, no second AI decision layer.
const RESTART_PHRASE_PATTERNS = [
  /\bstart(ing)?\s+(over|fresh|again|from\s+scratch|a\s+new\s+search)\b/i,
  /\bfresh\s+start\b/i,
  /\brestart(ing)?\b/i,
  /\bnew\s+(requirement|search)\b/i,
  /\bmy\s+requirement(s)?\s+(has|have)?\s*changed\b/i,
  /\brequirement(s)?\s+(has|have)\s+changed\b/i,
  /\bforget\s+(the\s+|my\s+)?previous\b/i,
  /\bactually,?\s+now\s+i'?m\s+looking\s+for\b/i,
  /\binstead\s+i\s+want\b/i,
  /\bnow\s+i\s+need\b/i,
  /\bchanged\s+my\s+mind\b/i,
];

function matchesRestartPhrase(text) {
  if (!text) return false;
  return RESTART_PHRASE_PATTERNS.some((pattern) => pattern.test(text));
}

// Residential vs Commercial bucket for a canonical propertyType, or null if
// the type isn't recognized (in which case it can't be used to prove a
// Residential<->Commercial boundary either way).
function propertyCategory(canonicalType) {
  if (!canonicalType) return null;
  if (RESIDENTIAL_PROPERTY_TYPES.includes(canonicalType)) return "Residential";
  if (COMMERCIAL_PROPERTY_TYPES.includes(canonicalType)) return "Commercial";
  return null;
}

/**
 * Decides whether the current turn continues the customer's active
 * opportunity or should start a brand-new one, and returns a ref to
 * whichever opportunity applies (creating it if needed).
 *
 * DETERMINISTIC BUSINESS RULES ONLY — no LLM judgment call is trusted here.
 * The LLM's only job (in agent.js) is to extract structured fields
 * (propertyType, listingType, purpose) from the conversation; this function
 * is the sole place that decides what those fields mean for opportunity
 * boundaries. A new opportunity is created when, compared against the
 * active one:
 *   1. Property Type changed (Apartment -> Villa, Office -> Shop, etc.)
 *   2. Listing Type changed (Rent -> Sale or Sale -> Rent)
 *   3. Residential <-> Commercial changed (Apartment -> Office, Villa -> Shop)
 *   4. Purpose changed (Self Use -> Investment -> Rental Income)
 *   5. The raw incoming message matches an explicit restart phrase
 *      ("start over", "my requirement changed", "instead I want...", etc.)
 * Everything else — budget, bedrooms, locality, furnishing, parking,
 * amenities, possession, asking for more details, comparing properties,
 * requesting a visit, asking to see another property — continues the same
 * opportunity, because none of those fields are compared here at all.
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
 * @param {string|null} params.agentListingType Listing type ('Sale'/'Rent') extracted this turn.
 * @param {string|null} params.agentPurpose Purpose (own-use/investment/rental income) extracted this turn.
 * @param {string|null} params.incomingMessageText Raw text of the customer's incoming message
 *   this turn, checked against RESTART_PHRASE_PATTERNS.
 */
async function resolveActiveOpportunity({
  db,
  phone,
  activeOpportunityId,
  activeSnap,
  lead,
  agentPropertyType,
  agentListingType,
  agentPurpose,
  incomingMessageText,
}) {
  const oppCol = opportunitiesCollection(db, phone);
  const noActiveOpportunity = !activeSnap || !activeSnap.exists;

  let shouldCreateNew = noActiveOpportunity;
  let reason = noActiveOpportunity ? "no_active_opportunity" : null;

  if (!noActiveOpportunity) {
    const activeData = activeSnap.data();

    const activeType = normalizePropertyType(activeData.propertyType);
    const newType = normalizePropertyType(agentPropertyType);
    const activeListing = normalizeListingType(activeData.listingType);
    const newListing = normalizeListingType(agentListingType);
    const activePurpose = normalizePurpose(activeData.purpose);
    const newPurpose = normalizePurpose(agentPurpose);

    const typeChanged = Boolean(newType && activeType && newType !== activeType);
    const categoryChanged = Boolean(
      propertyCategory(newType) &&
        propertyCategory(activeType) &&
        propertyCategory(newType) !== propertyCategory(activeType)
    );
    const listingChanged = Boolean(newListing && activeListing && newListing !== activeListing);
    const purposeChanged = Boolean(newPurpose && activePurpose && newPurpose !== activePurpose);
    const restartPhraseDetected = matchesRestartPhrase(incomingMessageText);

    if (typeChanged) reason = "property_type_changed";
    else if (categoryChanged) reason = "residential_commercial_changed";
    else if (listingChanged) reason = "listing_type_changed";
    else if (purposeChanged) reason = "purpose_changed";
    else if (restartPhraseDetected) reason = "explicit_restart_phrase";

    shouldCreateNew = typeChanged || categoryChanged || listingChanged || purposeChanged || restartPhraseDetected;
  }

  if (shouldCreateNew) {
    // Only a genuine first-ever opportunity (no activeOpportunityId at all)
    // gets seeded from the lead's pre-migration fields. A boundary-detected
    // new opportunity for a lead that already has one is a deliberately
    // fresh search and must start with empty shownProperties/etc.
    const seedFromLead = noActiveOpportunity ? lead : null;
    const newRef = oppCol.doc();
    await newRef.set(
      newOpportunityDoc({
        phone,
        propertyType: agentPropertyType,
        listingType: agentListingType,
        purpose: agentPurpose,
        seedFromLead,
      })
    );
    logger.info("opportunities: created new opportunity", {
      phone,
      opportunityId: newRef.id,
      reason,
      previousOpportunityId: activeOpportunityId || null,
      seeded: Boolean(seedFromLead),
    });
    return {
      ref: newRef,
      id: newRef.id,
      isNew: true,
      data: {
        ...freshOpportunityDefaults(seedFromLead),
        propertyType: agentPropertyType || null,
        listingType: agentListingType || null,
        purpose: agentPurpose || null,
      },
    };
  }

  return { ref: activeSnap.ref, id: activeSnap.id, isNew: false, data: activeSnap.data() };
}

/**
 * Short text summary of the active opportunity for the agent's system
 * prompt, so its (non-authoritative) startsNewOpportunity guess has
 * something concrete to compare against instead of guessing blind.
 */
function summarizeOpportunityForPrompt(oppData) {
  if (!oppData) return null;
  return (
    `Property type: ${oppData.propertyType || "unspecified"}; ` +
    `Listing type: ${oppData.listingType || "unspecified"}; ` +
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
  hydratePropertiesShared,
};
