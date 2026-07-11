// Canonical enums for the redesigned `properties` collection schema.
// Mirrored (by value, not by import — Functions is CJS, frontend is ESM) in
// frontend/src/constants/propertyEnums.js. If you change one, change both.

const PROPERTY_TYPES = ["Apartment", "Villa", "Row House", "Plot", "Office", "Commercial", "Studio"];

// Residential/Commercial split of PROPERTY_TYPES — used to deterministically
// detect a Residential <-> Commercial opportunity boundary (e.g. Apartment ->
// Office) independent of whether the specific propertyType pair also counts
// as a plain "type changed" boundary. See opportunities.js.
const RESIDENTIAL_PROPERTY_TYPES = ["Apartment", "Villa", "Row House", "Plot", "Studio"];
const COMMERCIAL_PROPERTY_TYPES = ["Office", "Commercial"];

const LISTING_TYPES = ["Sale", "Rent"];

const FURNISHING_TYPES = ["Unfurnished", "Semi-Furnished", "Fully-Furnished"];

const FACING_OPTIONS = ["North", "South", "East", "West", "North-East", "North-West", "South-East", "South-West"];

const POSSESSION_STATUS = ["Ready to Move", "Under Construction"];

// Boolean amenity/feature flags stored as flat top-level fields on the
// property doc (not nested) so Firestore `where("gym", "==", true)` style
// queries and the AI's structured tool filters both work without a nested
// field-path index for every combination.
const AMENITY_FIELDS = [
  "clubHouse",
  "gym",
  "pool",
  "garden",
  "childrenPlayArea",
  "security",
  "powerBackup",
  "lift",
  "internet",
  "petFriendly",
  "servantRoom",
  "studyRoom",
  "storeRoom",
  "airConditioning",
  "modularKitchen",
  "gasPipeline",
  "waterSupply24x7",
];

const PUNE_LOCALITIES = [
  "Baner",
  "Balewadi",
  "Wakad",
  "Hinjewadi",
  "Kharadi",
  "NIBM",
  "Kondhwa",
  "Viman Nagar",
  "Koregaon Park",
  "Hadapsar",
  "Magarpatta",
  "Kothrud",
  "Pashan",
  "Bavdhan",
  "Shivajinagar",
  "Aundh",
  "Camp",
  "Sinhagad Road",
  "Warje",
  "Undri",
];

module.exports = {
  PROPERTY_TYPES,
  RESIDENTIAL_PROPERTY_TYPES,
  COMMERCIAL_PROPERTY_TYPES,
  LISTING_TYPES,
  FURNISHING_TYPES,
  FACING_OPTIONS,
  POSSESSION_STATUS,
  AMENITY_FIELDS,
  PUNE_LOCALITIES,
};
