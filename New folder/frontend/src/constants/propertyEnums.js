// Canonical enums for the `properties` collection schema.
// Mirrored (by value) in functions/src/propertyEnums.js — Functions is CJS,
// this is ESM, so it's a duplicated source of truth rather than a shared
// import. If you change one, change both.

export const PROPERTY_TYPES = ["Apartment", "Villa", "Row House", "Plot", "Office", "Commercial", "Studio"];

export const LISTING_TYPES = ["Sale", "Rent"];

export const FURNISHING_TYPES = ["Unfurnished", "Semi-Furnished", "Fully-Furnished"];

export const FACING_OPTIONS = [
  "North",
  "South",
  "East",
  "West",
  "North-East",
  "North-West",
  "South-East",
  "South-West",
];

export const POSSESSION_STATUS = ["Ready to Move", "Under Construction"];

// { field, label } pairs — used to render amenity toggle chips in the
// Properties form without repeating labels all over the JSX.
export const AMENITY_FIELDS = [
  { field: "clubHouse", label: "Clubhouse" },
  { field: "gym", label: "Gym" },
  { field: "pool", label: "Swimming Pool" },
  { field: "garden", label: "Garden" },
  { field: "childrenPlayArea", label: "Children's Play Area" },
  { field: "security", label: "24x7 Security" },
  { field: "powerBackup", label: "Power Backup" },
  { field: "lift", label: "Lift" },
  { field: "internet", label: "Internet/Wi-Fi" },
  { field: "petFriendly", label: "Pet Friendly" },
  { field: "servantRoom", label: "Servant Room" },
  { field: "studyRoom", label: "Study Room" },
  { field: "storeRoom", label: "Store Room" },
  { field: "airConditioning", label: "Air Conditioning" },
  { field: "modularKitchen", label: "Modular Kitchen" },
  { field: "gasPipeline", label: "Piped Gas" },
  { field: "waterSupply24x7", label: "24x7 Water Supply" },
];

export const PUNE_LOCALITIES = [
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

export const LEAD_STAGES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "property_shared", label: "Property Shared" },
  { key: "visit_scheduled", label: "Visit Scheduled" },
  { key: "negotiation", label: "Negotiation" },
  { key: "closed_won", label: "Closed Won" },
  { key: "closed_lost", label: "Closed Lost" },
];

// Pipeline columns for the OPPORTUNITY-based Kanban (Customer -> Opportunities
// architecture). Distinct from LEAD_STAGES above, which described a single
// customer-level pipeline before that migration.
export const OPPORTUNITY_STAGES = [
  { key: "new", label: "New" },
  { key: "qualified", label: "Qualified" },
  { key: "visit_scheduled", label: "Visit Scheduled" },
  { key: "negotiation", label: "Negotiation" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];
