// Normalizes free-text filter values the LLM extracts from user messages
// into the exact canonical enum strings stored on `properties` docs.
//
// ROOT CAUSE this exists to fix: buildSearchPropertiesTool (agent.js) was
// filtering with plain `.toLowerCase() === term` equality against whatever
// string the model happened to pass through. That works when the model's
// wording exactly matches the canonical enum (e.g. "villa" === "villa"),
// but silently returns ZERO results the moment it doesn't — a plural
// ("Villas"), a synonym ("workspace" for Office), or a partial phrase
// ("furnished" instead of "Fully-Furnished") all fail equality and the user
// sees "No Villas found" even though matching properties exist. The model
// is not reliably normalizing free text into the canonical form on its own,
// so that normalization is made deterministic here instead — same
// philosophy as the other deterministic-override logic in agent.js.
//
// Every normalize* function returns a canonical enum string, or null if the
// input doesn't confidently map to one (in which case the caller should
// skip that filter rather than apply a wrong one).

const {
  PROPERTY_TYPES,
  LISTING_TYPES,
  FURNISHING_TYPES,
  POSSESSION_STATUS,
} = require("./propertyEnums");

function clean(input) {
  return (input || "").toString().trim().toLowerCase();
}

// Exact match against a canonical list, tolerant of case and a single
// trailing "s" (covers "villas" -> "villa", "offices" -> "office", etc.)
function matchCanonical(term, canonicalList) {
  const exact = canonicalList.find((c) => c.toLowerCase() === term);
  if (exact) return exact;
  const singular = term.endsWith("s") ? term.slice(0, -1) : term;
  const singularMatch = canonicalList.find((c) => c.toLowerCase() === singular);
  if (singularMatch) return singularMatch;
  return null;
}

const PROPERTY_TYPE_SYNONYMS = {
  flat: "Apartment",
  flats: "Apartment",
  apartments: "Apartment",
  "row houses": "Row House",
  rowhouse: "Row House",
  rowhouses: "Row House",
  "row-house": "Row House",
  land: "Plot",
  plots: "Plot",
  "office space": "Office",
  "office spaces": "Office",
  workspace: "Office",
  "commercial office": "Office",
  offices: "Office",
  shop: "Commercial",
  shops: "Commercial",
  showroom: "Commercial",
  showrooms: "Commercial",
  commercials: "Commercial",
  studios: "Studio",
};

function normalizePropertyType(input) {
  const term = clean(input);
  if (!term) return null;
  return matchCanonical(term, PROPERTY_TYPES) || PROPERTY_TYPE_SYNONYMS[term] || null;
}

const LISTING_TYPE_SYNONYMS = {
  buy: "Sale",
  buying: "Sale",
  purchase: "Sale",
  purchasing: "Sale",
  sell: "Sale",
  selling: "Sale",
  rental: "Rent",
  renting: "Rent",
  lease: "Rent",
  leasing: "Rent",
  rent: "Rent",
};

function normalizeListingType(input) {
  const term = clean(input);
  if (!term) return null;
  return matchCanonical(term, LISTING_TYPES) || LISTING_TYPE_SYNONYMS[term] || null;
}

function normalizeFurnishing(input) {
  const term = clean(input);
  if (!term) return null;
  const exact = matchCanonical(term, FURNISHING_TYPES);
  if (exact) return exact;
  if (term.includes("unfurnish")) return "Unfurnished";
  if (term.includes("semi")) return "Semi-Furnished";
  if (term.includes("furnish")) return "Fully-Furnished"; // "furnished"/"fully furnished"
  return null;
}

// Buckets free-text `purpose` (e.g. "own living", "for investment", "rental
// income") into one of three canonical values, or null if it doesn't
// confidently match any — same "skip rather than guess wrong" philosophy as
// the other normalize* functions here. Used by opportunities.js to compare
// the active opportunity's purpose against this turn's extracted purpose
// deterministically (own-use -> investment is a boundary; two different
// phrasings of the same bucket is not).
function normalizePurpose(input) {
  const term = clean(input);
  if (!term) return null;
  if (term.includes("rent") && term.includes("income")) return "Rental Income";
  if (term.includes("invest")) return "Investment";
  if (
    term.includes("self") ||
    term.includes("own") ||
    term.includes("living") ||
    term.includes("residence") ||
    term.includes("personal")
  ) {
    return "Self Use";
  }
  return null;
}

function normalizePossessionStatus(input) {
  const term = clean(input);
  if (!term) return null;
  const exact = matchCanonical(term, POSSESSION_STATUS);
  if (exact) return exact;
  if (term.includes("ready")) return "Ready to Move";
  if (term.includes("construction") || term.includes("upcoming") || term.includes("under-construction")) {
    return "Under Construction";
  }
  return null;
}

module.exports = {
  normalizePropertyType,
  normalizeListingType,
  normalizeFurnishing,
  normalizePossessionStatus,
  normalizePurpose,
};
